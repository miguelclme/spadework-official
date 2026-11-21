'use strict';

// The board's helper: a small web server on 127.0.0.1 that serves the board's
// page (the plugin's board/ folder) and reads and edits the rows through
// lib/board.js, the same code the CLI uses. It also serves init's config panel
// (board/config.html), which saves through lib/init.js. It starts with no
// config.json: on a first run, init opens the panel to write it.
//
// Every request needs Host 127.0.0.1:<port>, so a page that reaches the
// server under another name (DNS rebinding) gets nothing. Every /api/ request
// but /api/ping also needs the board's key in X-Spadework-Key. The key is in
// the link `board` prints, so other websites open in the same browser can't
// read or change rows.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { Worker } = require('worker_threads');

const ado = require('./ado');
const board = require('./board');
const graphLib = require('./board-graph');
const init = require('./init');
const log = require('./log');
const config = require('./config');
const paths = require('./paths');
const questions = require('./questions');
const runs = require('./runs');
const stack = require('./stack');
const { localDate } = require('./dates');
const { dependenciesOf } = require('./dependencies');
const { localBranchExists } = require('./git');
const { writeJsonAtomic } = require('./fs-atomic');
const { parseJson, readJsonOrNull } = require('./json-file');

const KEY_HEADER = 'x-spadework-key';
const MAX_BODY = 1024 * 1024;
const PLAN_TEXT = ['context', 'root_cause'];
// Questions aren't edited here: triage gives them their IDs.
const PLAN_LISTS = ['findings', 'steps', 'commits', 'decisions'];
const SPEC_TEXT = ['part', 'what_to_build', 'contract', 'acceptance', 'depends_on'];
const { MAX_TEXT, MAX_TITLE } = board;
const MAX_ITEM = 5000;
const MAX_ITEMS = 100;
const MAX_ANSWERS = 50;
const KEY_PATTERN = /^[0-9a-f]{64}$/;
// How many ports a first run tries, from the default up.
const PORT_TRIES = 20;

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

const files = () => {
  const all = paths.all();
  return { key: all.boardKey, open: all.boardOpenPage, helper: path.join(all.board, 'helper.json') };
};

// The request was wrong: the message goes back with this status.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The board's key, made once. Two runs making it at the same time end up
// with the same one: the second finds the file and reads it.
function ensureKey() {
  const { key: file } = files();
  const read = () => {
    try {
      const text = fs.readFileSync(file, 'utf8').trim();
      return KEY_PATTERN.test(text) ? text : null;
    } catch {
      return null;
    }
  };
  const existing = read();
  if (existing) return existing;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const key = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(file, key, { flag: 'wx', mode: 0o600 });
    return key;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const other = read();
    if (other) return other;
    // A file that isn't a key (cut off, edited): replace it.
    fs.writeFileSync(file, key, { mode: 0o600 });
    return key;
  }
}

// The keyed link to the board, or to another of its pages (config.html, init's panel).
const link = (port, key, page = '') => `http://127.0.0.1:${port}/${page}?key=${key}`;

// The page that opens the board (or init's panel, with page): a file in board/
// (next to the key, same mode) that sends the browser to the keyed link. So
// the key is on no command line and in no chat output: only the file's path
// is. location.replace leaves only the page in the tab's history, so the
// panel may close its own tab. Returns the path.
function writeOpenPage(port, key, { page = '' } = {}) {
  const { open: file } = files();
  const title = page ? 'Spadework settings' : 'Spadework board';
  const html = `<!doctype html>\n<meta charset="utf-8">\n<title>${title}</title>\n<script>location.replace(${JSON.stringify(link(port, key, page))});</script>\n<p>Opening…</p>\n`;
  fs.writeFileSync(file, html, { mode: 0o600 });
  return file;
}

// The board's port: board.port of config.json, even when the rest of the
// file is wrong (init's panel opens to fix it), or the default. config.js
// checks the same range.
function configuredPort() {
  const raw = readJsonOrNull(paths.all().config);
  const port = config.isObject(raw) && config.isObject(raw.board) ? raw.board.port : undefined;
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : config.DEFAULT_BOARD_PORT;
}

function sameKey(given, key) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- the answers -------------------------------------------------------------------

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = Buffer.from(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': data.length });
  res.end(data);
}

const sendError = (res, status, message) => send(res, status, { ok: false, error: message });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'the request is too big'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// The request's JSON body.
async function readJsonBody(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'send JSON');
  try {
    return parseJson(await readBody(req));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'the request is not valid JSON');
  }
}

// --- editing a row -----------------------------------------------------------------

const isText = (value, max = MAX_TEXT) => typeof value === 'string' && value.length <= max;

function textFields(value, allowed, label) {
  if (!config.isObject(value)) throw new HttpError(400, `${label} must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new HttpError(400, `${label} has no field ${unknown.join(', ')}`);
  return value;
}

function checkedPlan(value) {
  textFields(value, [...PLAN_TEXT, ...PLAN_LISTS], 'plan');
  for (const [key, field] of Object.entries(value)) {
    if (PLAN_TEXT.includes(key)) {
      if (!isText(field)) throw new HttpError(400, `plan.${key} must be text`);
    } else if (!Array.isArray(field) || field.length > MAX_ITEMS || !field.every((item) => isText(item, MAX_ITEM))) {
      throw new HttpError(400, `plan.${key} must be a list of text`);
    }
  }
  return value;
}

function checkedSpec(value) {
  textFields(value, SPEC_TEXT, 'spec');
  for (const [key, field] of Object.entries(value)) {
    if (!isText(field)) throw new HttpError(400, `spec.${key} must be text`);
  }
  return value;
}

function checkedAnswers(value) {
  if (!Array.isArray(value) || value.length > MAX_ANSWERS) throw new HttpError(400, 'answers must be a list');
  return value.map((entry) => {
    if (!config.isObject(entry) || !isText(entry.question, MAX_ITEM) || !isText(entry.answer)) {
      throw new HttpError(400, 'each answer needs a "question" and an "answer", both text');
    }
    if (entry.id !== undefined && !questions.isId(entry.id)) throw new HttpError(400, 'an answer\'s id must be a question ID like Q3');
    return { ...(entry.id === undefined ? {} : { id: entry.id }), question: entry.question, answer: entry.answer };
  });
}

// The rows a row depends on, as the user sets them: other rows of the same
// project that are on the board. Each one once.
function checkedDependsOn(value, row) {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new HttpError(400, 'depends_on_rows must be a list of row IDs');
  const { prefix } = board.parseId(row.id);
  const ids = [];
  for (const entry of value) {
    const id = typeof entry === 'string' ? entry.trim().toUpperCase() : '';
    const parsed = board.parseId(id);
    if (!parsed) throw new HttpError(400, `"${entry}" isn't a row ID like SHOP-35`);
    if (id === row.id) throw new HttpError(400, `${row.id} can't depend on itself`);
    if (parsed.prefix !== prefix) throw new HttpError(400, `${id} isn't a row of ${row.project}`);
    if (!board.readRow(id)) throw new HttpError(400, `${id} isn't on the board`);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

// The Predecessor links come from Azure DevOps: here the user only takes numbers out.
function checkedPredecessors(value, row) {
  if (!Array.isArray(value)) throw new HttpError(400, 'predecessors must be a list of work item numbers');
  const current = Array.isArray(row.predecessors) ? row.predecessors : [];
  if (!value.every((number) => current.includes(number))) throw new HttpError(409, 'predecessors come from Azure DevOps: the board can only take numbers out of the list');
  return current.filter((number) => value.includes(number));
}

// The row's branch, corrected by the user: empty clears it, else a local
// branch of the row's repo. Git is only asked whether the branch exists.
function checkedBranch(value, row, cfg) {
  if (!isText(value, MAX_TITLE)) throw new HttpError(400, 'branch must be text');
  const name = value.trim();
  if (!name) return null;
  if (!config.isBranchName(name)) throw new HttpError(400, `"${name}" isn't a valid branch name`);
  const repo = row.repo ? config.findRepo(cfg.repos || [], row.project, row.repo) : null;
  if (!repo) throw new HttpError(409, `${row.id} has no repo, so the branch can't be checked. Set the repo first.`);
  if (!localBranchExists(repo.path, name)) throw new HttpError(409, `${repo.name} has no branch "${name}"`);
  return name;
}

const EDITABLE = ['status', 'feedback', 'answers', 'repo', 'base_branch', 'plan', 'title', 'spec', 'depends_on_rows', 'predecessors', 'branch'];

// The row with the edits applied, and a history entry for the ones that get
// one. Throws HttpError for anything the page may not change. cfg is the
// loaded config.
function applyPatch(row, patch, cfg, { now = new Date() } = {}) {
  textFields(patch, EDITABLE, 'the request');
  let next = { ...row };
  const entries = [];
  const note = (kind, text) => entries.push(board.historyEntry(kind, 'user', text, { now }));

  if (patch.feedback !== undefined) {
    if (!isText(patch.feedback)) throw new HttpError(400, 'feedback must be text');
    next.feedback = patch.feedback;
  }
  if (patch.answers !== undefined) next.answers = checkedAnswers(patch.answers);
  if (patch.repo !== undefined) {
    if (!isText(patch.repo, MAX_TITLE)) throw new HttpError(400, 'repo must be text');
    const found = patch.repo === '' ? null : (cfg.repos || []).find((repo) => config.sameName(repo.project, row.project) && config.sameName(repo.name, patch.repo));
    if (patch.repo !== '' && !found) throw new HttpError(400, `"${patch.repo}" isn't a repo of ${row.project}`);
    next.repo = found ? found.name : '';
  }
  // The branch a row is built on: where a Bug is planned and implemented from, or where the user
  // has any other row start. Triage and implement check the name before they use it.
  if (patch.base_branch !== undefined) {
    if (!isText(patch.base_branch, MAX_TITLE)) throw new HttpError(400, 'base_branch must be text');
    next.base_branch = patch.base_branch.trim();
  }
  // The user's own choices, written as they are: no loop check and no history entry.
  if (patch.depends_on_rows !== undefined) next.depends_on_rows = checkedDependsOn(patch.depends_on_rows, row);
  if (patch.predecessors !== undefined) next.predecessors = checkedPredecessors(patch.predecessors, row);
  // The repo a branch is looked up in is the one this same request sets, when it sets one.
  if (patch.branch !== undefined) next.branch = checkedBranch(patch.branch, next, cfg);
  if (patch.title !== undefined) {
    if (typeof patch.title !== 'string' || patch.title.trim() === '' || patch.title.length > MAX_TITLE) throw new HttpError(400, 'title must be text, not empty');
    if (row.work_item) throw new HttpError(409, `${row.id} is already in Azure DevOps: change the title there`);
    next.title = patch.title.trim();
    note('edit', 'Title edited');
  }
  if (patch.plan !== undefined) {
    if (!row.plan) throw new HttpError(409, `${row.id} has no plan to edit`);
    next.plan = { ...row.plan, ...checkedPlan(patch.plan) };
    note('edit', 'Plan edited');
  }
  if (patch.spec !== undefined) {
    if (!row.spec) throw new HttpError(409, `${row.id} has no spec to edit`);
    if (row.work_item) throw new HttpError(409, `${row.id} is already in Azure DevOps: change the spec there`);
    next.spec = { ...row.spec, ...checkedSpec(patch.spec) };
    note('edit', 'Spec edited');
  }
  if (patch.status !== undefined) {
    const statuses = cfg.board.items.statuses;
    const status = typeof patch.status === 'string' ? statuses.find((name) => config.sameName(name, patch.status)) : undefined;
    if (!status) throw new HttpError(400, `status must be one of: ${statuses.join(', ')}`);
    for (const entry of entries) next = board.addHistory(next, entry);
    return board.withStatus(next, status, 'user', { now });
  }
  for (const entry of entries) next = board.addHistory(next, entry);
  return next;
}

// --- the rows of a project, kept in memory -----------------------------------------

// Reading thousands of row files takes seconds (every file costs a system
// call), so the helper reads a project once and then keeps its summaries up to
// date one file at a time: the folder's change events name the file, and the
// helper's own writes say so too. A request first applies what is waiting.
const index = new Map();
const folderOf = (prefix) => path.dirname(board.rowFile(`${prefix}-1`));

function closeIndex() {
  for (const entry of index.values()) if (entry.watcher) entry.watcher.close();
  index.clear();
}

// What the helper keeps of a row: its summary, and the events of its history
// (t is the time as a number, for the timeline's ranges and order).
const keep = (row) => ({ summary: board.summary(row), events: (Array.isArray(row.history) ? row.history : []).map(({ at, kind, by, text }) => ({ at, kind, by, text, t: Date.parse(at) })) });

function reloadOne(entry, id) {
  const file = board.rowFile(id);
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (text.trim() === '') return; // claimed, not written yet: the write will say so
    const kept = keep(parseJson(text));
    entry.rows.set(id, kept.summary);
    entry.events.set(id, kept.events);
    entry.bad.delete(id);
  } catch (err) {
    entry.rows.delete(id);
    entry.events.delete(id);
    if (err.code === 'ENOENT') entry.bad.delete(id); else entry.bad.set(id, `${id}.json`);
  }
}

function watchProject(prefix, entry) {
  const forget = () => {
    if (index.get(folderOf(prefix)) === entry) index.delete(folderOf(prefix));
    if (entry.watcher) entry.watcher.close();
  };
  try {
    entry.watcher = fs.watch(folderOf(prefix), { persistent: false }, (type, name) => {
      const id = String(name || '').replace(/\.json$/, '');
      if (name && String(name).endsWith('.json') && board.parseId(id) && id.startsWith(`${prefix}-`)) entry.pending.add(id);
      else if (!name) forget(); // no name: start over with a full read
    });
    entry.watcher.on('error', forget);
  } catch {
    entry.watcher = null; // no folder yet: nothing to cache
  }
}

// The project's entry in the index, up to date.
function projectEntry(prefix) {
  let entry = index.get(folderOf(prefix));
  if (!entry) {
    const { rows, errors } = board.listRows({ prefix });
    entry = {
      rows: new Map(rows.map((row) => [row.id, board.summary(row)])),
      events: new Map(rows.map((row) => [row.id, keep(row).events])),
      bad: new Map(errors.map((error) => [path.basename(error.file, '.json'), path.basename(error.file)])),
      pending: new Set(),
      watcher: null,
    };
    watchProject(prefix, entry);
    if (entry.watcher) index.set(folderOf(prefix), entry);
  }
  for (const id of entry.pending) reloadOne(entry, id);
  entry.pending.clear();
  return entry;
}

const numberOf = (row) => Number(row.id.slice(row.id.lastIndexOf('-') + 1));

// The project's summaries (sorted by number) and the names of unreadable files.
function projectRows(prefix) {
  const entry = projectEntry(prefix);
  return { rows: [...entry.rows.values()].sort((a, b) => numberOf(a) - numberOf(b)), errors: [...entry.bad.values()] };
}

// --- the timeline ------------------------------------------------------------------

// Both timeline requests scan the project's events in memory: no file is read
// and nothing is cached.
const MAX_RANGE_DAYS = 366;
const MAX_PAGE = 500;
const MAX_LANE_IDS = 200;

// A local calendar day, as 2026-10-20. The helper only serves 127.0.0.1, so its zone is the browser's.
const localDay = (t) => localDate(new Date(t));
const inRange = (event, from, to) => event.t >= from && event.t <= to;
const matches = (event, { kinds, by }) => (!kinds || kinds.has(event.kind)) && (!by || event.by === by);

// The overview of the last `days` local days (today included): counts by kind
// (for the chips: `by` applied, `kinds` not), counts per day, totals, and the
// rows with a matching event (lanes), newest activity first. Nothing is capped.
// `range` ({ from, to }, optional) narrows the lanes, and only them, to the rows
// with a matching event in it: the days picked on the page's strip.
function timelineSummary(prefix, { days, kinds, by, range }, now = new Date()) {
  const entry = projectEntry(prefix);
  const starts = [];
  for (let n = days - 1; n >= 0; n--) starts.push(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n).getTime());
  const from = starts[0];
  const to = now.getTime();
  const dayOf = (t) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= t) low = mid; else high = mid - 1;
    }
    return low;
  };
  const kindCounts = {};
  const perDay = starts.map(() => ({}));
  const totals = { events: 0, rows: 0, plans: 0, by_user: 0 };
  const lanes = [];
  for (const [id, list] of entry.events) {
    let matched = 0;
    let count = 0;
    let last = null;
    for (const event of list) {
      if (!inRange(event, from, to) || !matches(event, { by })) continue;
      kindCounts[event.kind] = (kindCounts[event.kind] || 0) + 1;
      if (!matches(event, { kinds })) continue;
      const day = perDay[dayOf(event.t)];
      day[event.kind] = (day[event.kind] || 0) + 1;
      matched += 1;
      if (event.kind === 'plan') totals.plans += 1;
      if (event.by === 'user') totals.by_user += 1;
      if (range && !inRange(event, range.from, range.to)) continue;
      count += 1;
      if (!last || event.t >= last.t) last = event;
    }
    if (!matched) continue;
    totals.events += matched;
    totals.rows += 1;
    if (!count) continue;
    const row = entry.rows.get(id) || {};
    lanes.push({ id, title: row.title || '', parent_id: row.parent_id ?? null, status: row.status || '', count, last_at: last.at, t: last.t });
  }
  lanes.sort((a, b) => b.t - a.t || numberOf(b) - numberOf(a));
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    kinds: kindCounts,
    days: starts.map((start, index) => ({ day: localDay(start), counts: perDay[index] })),
    totals,
    lanes: lanes.map(({ t, ...lane }) => lane),
  };
}

// The order of the event pages: newest first. With ids it is a lane at a time
// (highest row number first), so that a page can end where a lane ends.
const eventOrder = (byLane) => (a, b) => (byLane ? b.n - a.n : 0) || b.t - a.t || b.n - a.n || b.pos - a.pos;
const CURSOR = /^(\d{1,15})\.(\d{1,15})\.(\d{1,9})$/;
const cursorOf = (item) => `${item.t}.${item.n}.${item.pos}`;

// One page of events in [from, to], newest first, after the cursor `before`.
// With ids, a page holds whole lanes only: it stops at a lane's end before
// `limit`, and a lane bigger than `limit` comes whole.
function timelineEvents(prefix, { from, to, kinds, by, ids, before, limit }) {
  const entry = projectEntry(prefix);
  const order = eventOrder(Boolean(ids));
  const sources = ids ? ids.filter((id) => entry.events.has(id)).map((id) => [id, entry.events.get(id)]) : entry.events;
  const found = [];
  for (const [id, list] of sources) {
    const n = numberOf({ id });
    list.forEach((event, pos) => {
      if (!inRange(event, from, to) || !matches(event, { kinds, by })) return;
      const item = { n, t: event.t, pos, id, event };
      if (!before || order(before, item) < 0) found.push(item);
    });
  }
  found.sort(order);
  let end = Math.min(limit, found.length);
  if (ids && end < found.length && end > 0 && found[end].n === found[end - 1].n) {
    const lane = found[end].n;
    while (end > 0 && found[end - 1].n === lane) end -= 1;
    if (end === 0) while (end < found.length && found[end].n === lane) end += 1;
  }
  const page = found.slice(0, end);
  return {
    events: page.map(({ id, event }) => ({ id, title: entry.rows.has(id) ? entry.rows.get(id).title : '', at: event.at, kind: event.kind, by: event.by, text: event.text })),
    next: end < found.length ? cursorOf(page[page.length - 1]) : null,
  };
}

// The helper changed a row itself: have the next listing read it again.
function touched(id) {
  const parsed = board.parseId(id);
  const entry = parsed && index.get(folderOf(parsed.prefix));
  if (entry) entry.pending.add(id);
}

// --- the built graph ---------------------------------------------------------------

const graphFile = (prefix) => path.join(paths.all().boardGraph, `${prefix}.json`);

// Builds the project's graph from all its rows and saves it. Only a request builds it.
function buildGraph(prefix, cfg) {
  const { rows } = board.listRows({ prefix });
  const saved = {
    version: 1,
    project: prefix,
    built_at: board.isoTime(new Date()),
    row_count: rows.length,
    ...graphLib.build(rows, { urlOf: (project, id) => ado.workItemUrl(cfg.tracker.organization, project, id) }),
  };
  writeJsonAtomic(graphFile(prefix), saved);
  return { ok: true, built: true, graph: saved, changed: 0 };
}

// The saved graph and how many rows changed since it was built, or built: false.
function savedGraph(prefix) {
  const saved = readJsonOrNull(graphFile(prefix));
  if (!saved || !Array.isArray(saved.nodes)) return { ok: true, built: false };
  const changed = projectRows(prefix).rows.filter((row) => row.updated_at > saved.built_at).length;
  return { ok: true, built: true, graph: saved, changed };
}

// --- the API -----------------------------------------------------------------------

// cfg is null before the first init: no projects yet, the default statuses.
function projectsAnswer(cfg) {
  if (!cfg) return { ok: true, projects: [], items: init.DEFAULTS.board.items, language: init.DEFAULTS.board.language, limits: { title: MAX_TITLE } };
  const projects = Object.entries(cfg.board.projects).map(([name, entry]) => ({
    name,
    prefix: entry.prefix,
    repos: (cfg.repos || []).filter((repo) => config.sameName(repo.project, name)).map((repo) => ({ name: repo.name, path: repo.path })),
  }));
  return { ok: true, projects, items: cfg.board.items, language: cfg.board.language, limits: { title: MAX_TITLE } };
}

// A row as the page gets it: no history, and its questions and answers with their IDs.
function pageRow(row) {
  const out = Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'history'));
  const { questions: asked, answers } = questions.ofRow(row);
  if (out.plan) out.plan = { ...out.plan, questions: asked };
  out.answers = answers;
  return out;
}

// project, and the optional kinds and by, of a timeline request. kinds present
// but empty matches no event.
function timelineQuery(url) {
  const prefix = String(url.searchParams.get('project') || '').toUpperCase();
  if (!config.ID_PREFIX.test(prefix)) throw new HttpError(400, 'project must be an ID prefix like SHOP');
  let kinds = null;
  if (url.searchParams.has('kinds')) {
    kinds = new Set(url.searchParams.get('kinds').split(',').map((kind) => kind.trim()).filter(Boolean));
    for (const kind of kinds) if (!board.HISTORY_KINDS.includes(kind)) throw new HttpError(400, `kinds must be among: ${board.HISTORY_KINDS.join(', ')}`);
  }
  const by = url.searchParams.get('by') || '';
  if (by && !board.HISTORY_BY.includes(by)) throw new HttpError(400, `by must be one of: ${board.HISTORY_BY.join(', ')}`);
  return { prefix, kinds, by };
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

// The from and to of a timeline request, as numbers: both ISO times, in order, at most MAX_RANGE_DAYS apart.
function rangeQuery(url) {
  const time = (name) => {
    const text = url.searchParams.get(name) || '';
    const t = ISO_TIME.test(text) ? Date.parse(text) : NaN;
    if (!Number.isFinite(t)) throw new HttpError(400, `${name} must be an ISO time like 2026-10-20T00:00:00Z`);
    return t;
  };
  const from = time('from');
  const to = time('to');
  if (from > to) throw new HttpError(400, 'from must not be after to');
  if (to - from > MAX_RANGE_DAYS * 86400000) throw new HttpError(400, `from and to must be at most ${MAX_RANGE_DAYS} days apart`);
  return { from, to };
}

// The rest of a /api/timeline/events request: the range, the rows, the cursor and the page size.
function eventsQuery(url, query) {
  const { from, to } = rangeQuery(url);
  const limitText = url.searchParams.get('limit');
  const limit = limitText === null ? 200 : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new HttpError(400, `limit must be a whole number from 1 to ${MAX_PAGE}`);
  let ids = null;
  if (url.searchParams.has('ids')) {
    const parsed = board.parseIdList(url.searchParams.get('ids'));
    if (parsed.error) throw new HttpError(400, parsed.error);
    if (parsed.ids.length > MAX_LANE_IDS) throw new HttpError(400, `ids takes at most ${MAX_LANE_IDS} rows`);
    const other = parsed.ids.find((id) => board.parseId(id).prefix !== query.prefix);
    if (other) throw new HttpError(400, `${other} isn't a row of ${query.prefix}`);
    ids = parsed.ids;
  }
  let before = null;
  if (url.searchParams.has('before')) {
    const match = String(url.searchParams.get('before')).match(CURSOR);
    if (!match) throw new HttpError(400, 'before must be the next value of an earlier page');
    before = { t: Number(match[1]), n: Number(match[2]), pos: Number(match[3]) };
  }
  return { ...query, from, to, ids, before, limit };
}

// --- init's panel ------------------------------------------------------------------

const MAX_PATH = 1000;

// A text field of a request body. Optional ones may be left out or empty.
function bodyText(body, key, { max = MAX_PATH, optional = false } = {}) {
  const value = body[key];
  if (optional && (value === undefined || value === null || value === '')) return undefined;
  if (!isText(value, max) || value.trim() === '') throw new HttpError(400, `${key} must be text`);
  return value.trim();
}

// One of init's detections, in a worker (lib/detect-worker.js) so the helper
// keeps answering while git asks the server. The same detection asked again
// while it runs (a second click, another tab) waits for that one.
const detecting = new Map();
function detectOffThread(job, args) {
  const id = JSON.stringify([job, args]);
  if (detecting.has(id)) return detecting.get(id);
  const done = new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'detect-worker.js'), { workerData: { job, args } });
    let answer = null;
    worker.once('message', (message) => { answer = message; });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (answer && answer.ok) resolve(answer.value);
      else reject(new Error(answer ? answer.error : `the detection stopped (exit code ${code})`));
    });
  }).finally(() => detecting.delete(id));
  detecting.set(id, done);
  return done;
}

// /api/init: what the panel shows, the two detections, and its Save. Save
// writes config.json and stack.md, so it works only while init runs in a
// chat: a panel left open can't change the setup later.
async function initApi(req, res, parts) {
  const need = (method) => {
    if (req.method !== method) throw new HttpError(405, `${req.method} isn't allowed here`);
  };
  if (parts.length === 1) {
    need('GET');
    return send(res, 200, { ok: true, ...init.panelState() });
  }
  if (parts.length !== 2 || !['detect-repo', 'detect-stack', 'save'].includes(parts[1])) throw new HttpError(404, 'not found');
  need('POST');
  const body = await readJsonBody(req);
  if (!config.isObject(body)) throw new HttpError(400, 'the request must be a JSON object');
  if (parts[1] === 'detect-repo') {
    const expected = Object.fromEntries(['organization', 'project', 'repo'].map((key) => [key, bodyText(body, key, { max: MAX_TITLE, optional: true })]));
    const found = await detectOffThread('detect-repo', { path: bodyText(body, 'path'), expected });
    return send(res, 200, { ok: true, ...found, ...init.graphOf(found.path) });
  }
  if (parts[1] === 'detect-stack') {
    const folder = path.resolve(paths.expandTilde(bodyText(body, 'path')));
    if (!paths.isFolder(folder)) throw new HttpError(400, `folder not found: ${folder}`);
    const found = await detectOffThread('detect-stack', { path: folder });
    return send(res, 200, { ok: true, found, lines: stack.detectedLines(found) });
  }
  const run = runs.anyRun('init');
  if (run === null) throw new HttpError(409, 'No setup is running. Run /spadework:init in Claude Code, then save again.');
  if (run === 'stale') throw new HttpError(409, `The setup in Claude Code had no activity for ${runs.CUT_OFF_TEXT}. Run /spadework:init again, then save.`);
  const result = init.savePanel(body);
  return send(res, result.ok ? 200 : 422, result.ok ? result : { ...result, error: 'Some values need fixing: see the fields marked in red.' });
}

// Handles one request to /api/. method and the path parts are already checked.
async function api(req, res, url, key) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1);
  const loadConfig = () => {
    const loaded = config.loadForRun();
    if (loaded.error) throw new HttpError(500, loaded.error);
    return loaded.config;
  };
  const rowId = (text) => {
    const id = String(text).toUpperCase();
    if (!board.parseId(id)) throw new HttpError(400, `"${text}" isn't a row ID like SHOP-35`);
    return id;
  };
  const need = (methods) => {
    if (!methods.includes(req.method)) throw new HttpError(405, `${req.method} isn't allowed here`);
  };

  if (parts[0] === 'ping' && parts.length === 1) {
    need(['GET']);
    return send(res, 200, { ok: true, app: 'spadework-board' });
  }
  if (!sameKey(req.headers[KEY_HEADER], key)) throw new HttpError(403, 'wrong or missing key: open the board with /spadework:board');

  if (parts[0] === 'projects' && parts.length === 1) {
    need(['GET']);
    return send(res, 200, projectsAnswer(fs.existsSync(paths.all().config) ? loadConfig() : null));
  }
  if (parts[0] === 'init') return initApi(req, res, parts);
  if (parts[0] === 'timeline' && (parts.length === 1 || (parts.length === 2 && parts[1] === 'events'))) {
    need(['GET']);
    const query = timelineQuery(url);
    if (parts.length === 1) {
      const days = Number(url.searchParams.get('days') || 30);
      if (!Number.isInteger(days) || days < 1 || days > 365) throw new HttpError(400, 'days must be a whole number from 1 to 365');
      const range = url.searchParams.has('from') || url.searchParams.has('to') ? rangeQuery(url) : null;
      return send(res, 200, { ok: true, ...timelineSummary(query.prefix, { ...query, days, range }) });
    }
    return send(res, 200, { ok: true, ...timelineEvents(query.prefix, eventsQuery(url, query)) });
  }
  if (parts[0] === 'stats' && parts.length === 1) {
    need(['GET']);
    const days = Number(url.searchParams.get('days') || 7);
    if (!Number.isInteger(days) || days < 1 || days > 30) throw new HttpError(400, 'days must be a whole number from 1 to 30');
    return send(res, 200, require('./stats').collect({ days }));
  }
  if (parts[0] === 'graph' && (parts.length === 1 || (parts.length === 2 && parts[1] === 'build'))) {
    const building = parts.length === 2;
    need([building ? 'POST' : 'GET']);
    const prefix = String(url.searchParams.get('project') || '').toUpperCase();
    if (!config.ID_PREFIX.test(prefix)) throw new HttpError(400, 'project must be an ID prefix like SHOP');
    const cfg = loadConfig();
    if (!Object.values(cfg.board.projects).some((entry) => entry.prefix === prefix)) throw new HttpError(404, `no project has the prefix ${prefix}`);
    return send(res, 200, building ? buildGraph(prefix, cfg) : savedGraph(prefix));
  }
  if (parts[0] === 'merge' && parts.length === 2 && ['runs', 'plan'].includes(parts[1])) {
    need(['GET']);
    return send(res, 200, mergeAnswer(parts[1], url, loadConfig()));
  }
  if (parts[0] !== 'rows') throw new HttpError(404, 'not found');

  if (parts.length === 1) {
    need(['GET']);
    const prefix = String(url.searchParams.get('project') || '').toUpperCase();
    if (!config.ID_PREFIX.test(prefix)) throw new HttpError(400, 'project must be an ID prefix like SHOP');
    return send(res, 200, { ok: true, ...projectRows(prefix) });
  }

  const id = rowId(parts[1]);
  const row = board.readRow(id);
  if (!row) throw new HttpError(404, `${id} not found`);
  if (parts.length === 3 && parts[2] === 'history') {
    need(['GET']);
    return send(res, 200, { ok: true, history: Array.isArray(row.history) ? row.history : [] });
  }
  if (parts.length !== 2) throw new HttpError(404, 'not found');

  // The rows this one depends on, found among the rows of its project.
  const dependencies = (current) => dependenciesOf(current, projectRows(board.parseId(id).prefix).rows);
  if (req.method === 'GET') return send(res, 200, { ok: true, row: { ...pageRow(row), merge_progress: require('./merge').rowProgress(id) }, dependencies: dependencies(row) });
  if (req.method === 'DELETE') {
    board.deleteRow(id);
    touched(id);
    return send(res, 200, { ok: true, id });
  }
  need(['PATCH']);
  const patch = await readJsonBody(req);
  const cfg = loadConfig();
  // A refused request writes nothing, not even the file's update time.
  applyPatch(row, patch, cfg);
  let failure = null;
  const changed = board.updateRow(id, (current) => {
    try {
      return applyPatch(current, patch, cfg);
    } catch (err) {
      failure = err;
      return current;
    }
  });
  if (failure) throw failure;
  if (!changed) throw new HttpError(404, `${id} not found`);
  touched(id);
  return send(res, 200, { ok: true, row: pageRow(changed), dependencies: dependencies(changed) });
}

// The Merge view. runs: the repo's run files, newest first (run is the newest),
// and the command to merge. plan: the order from what git has now: it never
// fetches, never recovers a run and writes no file.
function mergeAnswer(what, url, cfg) {
  const name = String(url.searchParams.get('repo') || '').trim();
  const project = String(url.searchParams.get('project') || '').trim() || null;
  const found = config.repoByName(cfg.repos, name, project);
  if (found.error) throw new HttpError(404, found.error);
  const { repo } = found;
  // --project only when another project has a repo with this name.
  const shared = cfg.repos.filter((other) => config.sameName(other.name, repo.name)).length > 1;
  const quote = (text) => (/\s/.test(text) ? `"${text}"` : text);
  const command = `/spadework:merge --repo ${quote(repo.name)}${shared ? ` --project ${quote(repo.project)}` : ''}`;
  if (what === 'runs') {
    const runs = require('./merge').runsOf(config.repoLabel(repo));
    return { ok: true, run: runs[0] || null, runs, command };
  }
  const planned = require('./merge-candidates').planOrder(cfg, repo, { fetch: false });
  if (!planned.ok) throw new HttpError(409, planned.error);
  // What /spadework:merge does with this order. Nothing to say when there is
  // nothing to merge, or when the text already says the row's branch is pushed.
  const { plan } = planned;
  const then = !plan.steps.length || plan.one_branch ? ''
    : cfg.merge && cfg.merge.integrate ? ` /spadework:merge makes a new branch from it and never changes ${repo.main_branch}.`
      : ' /spadework:merge only prints this order: you merge.';
  return {
    ok: true,
    plan,
    text: `${planned.text}\n\nCompared with origin/${repo.main_branch} as of the last fetch.${then}`,
    command,
  };
}

// --- the page ----------------------------------------------------------------------

function serveStatic(req, res, url, dir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, `${req.method} isn't allowed here`);
  let name;
  try {
    name = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, 'bad path');
  }
  if (name === '/') name = '/index.html';
  const parts = name.split('/').filter(Boolean);
  const type = STATIC_TYPES[path.extname(name).toLowerCase()];
  if (name.includes('\0') || parts.some((part) => part.startsWith('.')) || !type) throw new HttpError(404, 'not found');
  const root = path.resolve(dir);
  const file = path.resolve(root, ...parts);
  if (!file.startsWith(root + path.sep)) throw new HttpError(404, 'not found');
  let data;
  try {
    if (!fs.statSync(file).isFile()) throw new Error('not a file');
    data = fs.readFileSync(file);
  } catch {
    throw new HttpError(404, 'not found');
  }
  return send(res, 200, req.method === 'HEAD' ? '' : data, type);
}

// The request handler. port is a function, because a server started on
// port 0 (tests) only knows its port once it listens.
function handler({ port, key, staticDir }) {
  return async (req, res) => {
    try {
      if (req.headers.host !== `127.0.0.1:${port()}`) throw new HttpError(403, 'wrong Host');
      if (typeof req.url !== 'string' || !req.url.startsWith('/')) throw new HttpError(400, 'bad request');
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) await api(req, res, url, key);
      else serveStatic(req, res, url, staticDir);
    } catch (err) {
      if (res.headersSent) return res.destroy();
      if (err instanceof HttpError) return sendError(res, err.status, err.message);
      // Not one the helper expects: keep the stack where the user can find it. The helper
      // usually runs with no terminal, so it goes in the run log too (no query: it holds the key).
      const stack = String((err && err.stack) || err).split('\n').slice(0, 6).join('\n');
      process.stderr.write(`${stack}\n`);
      log.append({ command: 'board', result: 'failed', error: `${req.method} ${String(req.url).split('?')[0]}: ${stack}` });
      sendError(res, 500, 'something went wrong: see the log in the Spadework logs folder');
    }
  };
}

// Listens on 127.0.0.1 only. Resolves with the server, or rejects with the
// listen error (EADDRINUSE when the port is taken).
function start({ port, key = ensureKey(), staticDir = path.join(__dirname, '..', 'board') }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler({ port: () => server.address().port, key, staticDir }));
    server.once('error', reject);
    server.on('close', closeIndex);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

// --- the process -------------------------------------------------------------------

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

// helper.json, or null when it isn't there or doesn't parse.
function readHelper() {
  try {
    const info = JSON.parse(fs.readFileSync(files().helper, 'utf8'));
    return Number.isInteger(info.pid) && Number.isInteger(info.port) ? info : null;
  } catch {
    return null;
  }
}

function ping(port, { timeout = 1000 } = {}) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', headers: { Host: `127.0.0.1:${port}` }, timeout }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(text).app === 'spadework-board');
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// The helper that is running now: helper.json whose process is alive and
// answers on its port. Otherwise null.
async function running() {
  const info = readHelper();
  return info && pidAlive(info.pid) && await ping(info.port) ? info : null;
}

// `board serve`: the helper's own process. Resolves when the server closes.
async function serve({ port }) {
  const live = await running();
  if (live) throw new Error(`The board is already running on port ${live.port}`);
  let server;
  try {
    server = await start({ port });
  } catch (err) {
    if (err.code === 'EADDRINUSE') throw new Error(`Port ${port} is taken. Change board.port in config.json (by hand)`);
    throw err;
  }
  const { helper } = files();
  writeJsonAtomic(helper, { pid: process.pid, port, started_at: new Date().toISOString() });
  const leave = () => {
    const info = readHelper();
    if (info && info.pid === process.pid) fs.rmSync(helper, { force: true });
    server.close();
  };
  process.once('SIGTERM', () => { leave(); process.exit(0); });
  process.once('SIGINT', () => { leave(); process.exit(0); });
  return new Promise((resolve) => server.once('close', resolve));
}

// Starts the helper as a detached process (unless one is running) and waits
// until it answers. Returns { port, key, started } or { error }.
async function launch({ port, wait = 5000 }) {
  const live = await running();
  if (live) return { port: live.port, key: ensureKey(), started: false };
  const script = path.join(__dirname, '..', 'scripts', 'spadework.js');
  const helper = spawn(process.execPath, [script, 'board', 'serve'], { detached: true, stdio: 'ignore', windowsHide: true });
  helper.on('error', () => {}); // it didn't start: the wait below ends with the message
  helper.unref();
  const until = Date.now() + wait;
  while (Date.now() < until) {
    await pause(100);
    const info = await running();
    if (info) return { port: info.port, key: ensureKey(), started: true };
  }
  return { error: `The board didn't start on port ${port}. If something else holds the port, change board.port in config.json (by hand); to see why, run: node "${script}" board serve` };
}

// Whether nothing listens on 127.0.0.1:port right now.
function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

// The first free port from `from` up, of `tries` ports, or null.
async function freePort(from, tries = PORT_TRIES) {
  for (let port = from; port < from + tries && port <= 65535; port++) {
    if (await portFree(port)) return port;
  }
  return null;
}

// `init panel` on a first run (no config.json): Spadework writes a
// config.json with only the board section, on the default port or the next
// free one, so the helper and the page use that port. A helper already
// running keeps its port. Returns { port } or { error }, or null when
// config.json is there: its board.port is used as it is.
async function firstRun({ from = config.DEFAULT_BOARD_PORT, tries = PORT_TRIES } = {}) {
  if (fs.existsSync(paths.all().config)) return null;
  const live = await running();
  const port = live ? live.port : await freePort(from, tries);
  if (port === null) return { error: `Ports ${from} to ${from + tries - 1} are all taken. Free one of them, then run init again.` };
  init.writeStarter(port);
  return { port };
}

// Opens a link or a file in the default browser.
function openLink(target) {
  const [command, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', target]]
    : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

// `board stop`. Returns whether a helper was running. It waits until the
// helper's process is gone (up to `wait` ms), so the port is free when this
// returns: outside Windows the process ends a moment after the signal.
async function stop({ wait = 2000 } = {}) {
  const info = await running();
  if (!info) {
    fs.rmSync(files().helper, { force: true });
    return false;
  }
  process.kill(info.pid);
  fs.rmSync(files().helper, { force: true });
  const until = Date.now() + wait;
  while (pidAlive(info.pid) && Date.now() < until) await pause(25);
  return true;
}

module.exports = {
  start, serve, stop, launch, firstRun, freePort, openLink, writeOpenPage, configuredPort, running, ping, readHelper, pidAlive, ensureKey, link, applyPatch, handler, HttpError, EDITABLE, KEY_HEADER,
};
