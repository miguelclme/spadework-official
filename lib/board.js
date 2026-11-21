'use strict';

// The local board: one JSON file per row, ~/.spadework/board/rows/<PREFIX>/<ID>.json.
// Only Spadework writes them, through this file (the CLI and the helper).
// Every write is a read-change-write of one file, and the last write wins.
// newRow() lists a row's fields and their empty values.

const fs = require('fs');
const path = require('path');

const paths = require('./paths');
const { sameName, ID_PREFIX: PREFIX } = require('./config');
const { readJsonOrNull, readTextOrNull, parseJson } = require('./json-file');
const { writeFileAtomic, writeJsonAtomic } = require('./fs-atomic');

const ROW_ID = /^[A-Z][A-Z0-9]{1,9}-\d+$/;
const HISTORY_KINDS = ['plan', 'status', 'implement', 'work_item_changed', 'state_move', 'handoff', 'edit', 'merge'];
const HISTORY_BY = ['spadework', 'user'];
const MAX_HISTORY_TEXT = 200;
// The longest title, and the longest text field, a row may hold.
const MAX_TITLE = 300;
const MAX_TEXT = 20000;
// Fields the table doesn't need, so they stay out of a summary. The page
// reads them from the row it opens (GET /api/rows/<id>), never from the table.
const HEAVY = ['plan', 'spec', 'implement_log', 'history', 'related', 'split_draft', 'answers', 'feedback', 'progress'];

// The ID becomes a file path, so anything else is refused.
function parseId(id) {
  const text = String(id ?? '');
  if (!ROW_ID.test(text)) return null;
  const at = text.lastIndexOf('-');
  const number = Number(text.slice(at + 1));
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return { prefix: text.slice(0, at), number };
}

function checkedId(id) {
  const parsed = parseId(id);
  if (!parsed) throw new Error(`"${id}" isn't a row ID like SHOP-35`);
  return parsed;
}

const prefixDir = (prefix) => path.join(paths.all().boardRows, prefix);

function rowFile(id) {
  const { prefix } = checkedId(id);
  return path.join(prefixDir(prefix), `${id}.json`);
}

// The project's ID prefix, or null.
function prefixOf(cfg, project) {
  const projects = (cfg && cfg.board && cfg.board.projects) || {};
  const name = Object.keys(projects).find((key) => sameName(key, project));
  return name ? projects[name].prefix || null : null;
}

// A prefix from the project name: its first 4 letters or digits, in
// capitals (Shop → SHOP, Billing → BILL). Longer, then numbered, if taken.
function suggestPrefix(name, taken = []) {
  const used = new Set(taken.map((prefix) => prefix.toUpperCase()));
  let letters = String(name).normalize('NFD').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  letters = letters.replace(/^[0-9]+/, '');
  if (letters.length < 2) letters = `P${letters}X`.slice(0, 3);
  for (const length of [4, 5, 6]) {
    const candidate = letters.slice(0, length);
    if (candidate.length >= 2 && !used.has(candidate)) return candidate;
  }
  const base = letters.slice(0, 4);
  for (let n = 2; n < 100; n++) if (!used.has(`${base}${n}`)) return `${base}${n}`;
  return null;
}

const isoTime = (now) => now.toISOString().replace(/\.\d{3}Z$/, 'Z');

function newRow(fields, { now = new Date() } = {}) {
  for (const key of ['id', 'project', 'title', 'type', 'status']) {
    if (typeof fields[key] !== 'string' || fields[key].trim() === '') throw new Error(`a row needs a ${key}`);
  }
  const stamp = isoTime(now);
  return {
    version: 1,
    repo: '',
    base_branch: '',
    area_path: '',
    parent_id: null,
    parent_type: '',
    parent_title: '',
    grandparent_id: null,
    depends_on_rows: [],
    predecessors: [],
    work_item: null,
    plan: null,
    spec: null,
    feedback: '',
    answers: [],
    progress: '',
    branch: null,
    start_commit: null,
    // The integration branch a merge put the row's branch in, while the row is Merged.
    merged_into: null,
    // The last commit of the row's own branch when a merge set it to Merged,
    // so its own work can still be found after that branch is deleted.
    before_merge_head: null,
    implement_log: null,
    history: [],
    last_triaged: null,
    created_at: stamp,
    updated_at: stamp,
    ...fields,
  };
}

// The numbers already used in a prefix's folder, from the file names. A
// claimed file that isn't written yet counts too.
function usedNumbers(prefix) {
  let names;
  try {
    names = fs.readdirSync(prefixDir(prefix));
  } catch {
    return [];
  }
  return names.map((name) => name.match(/^(.+)-(\d+)\.json$/)).filter((match) => match && match[1] === prefix).map((match) => Number(match[2]));
}

// The highest number a prefix ever handed out, in <PREFIX>/.last: a deleted
// row's number is never given again, since handoff and implement key work
// item tags and branches by it. With no .last file, 0 (the caller also
// counts the numbers in use).
const lastFile = (prefix) => path.join(prefixDir(prefix), '.last');
function lastNumber(prefix) {
  const number = Number(readTextOrNull(lastFile(prefix)));
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

// A new row takes the next number by creating its file with the exclusive
// flag. If another run took that number first, it tries the next one.
function createRow(prefix, fields, { now = new Date() } = {}) {
  if (!PREFIX.test(String(prefix))) throw new Error(`"${prefix}" isn't an ID prefix like SHOP`);
  fs.mkdirSync(prefixDir(prefix), { recursive: true });
  for (let number = Math.max(lastNumber(prefix), ...usedNumbers(prefix)) + 1; ; number++) {
    const id = `${prefix}-${number}`;
    const file = path.join(prefixDir(prefix), `${id}.json`);
    try {
      fs.closeSync(fs.openSync(file, 'wx'));
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      throw err;
    }
    const row = newRow({ ...fields, id }, { now });
    try {
      writeJsonAtomic(file, row);
    } catch (err) {
      fs.rmSync(file, { force: true });
      throw err;
    }
    if (number > lastNumber(prefix)) writeFileAtomic(lastFile(prefix), String(number));
    return row;
  }
}

// The row, or null when its file is missing, empty (claimed, not written
// yet) or can't be parsed.
const readRow = (id) => readJsonOrNull(rowFile(id));

const byNumber = (first, second) => first.prefix.localeCompare(second.prefix) || first.number - second.number;

// One prefix, or all of them. A file that doesn't parse goes in errors, and
// the others still come back.
function listRows({ prefix } = {}) {
  const root = paths.all().boardRows;
  let prefixes = [];
  if (prefix) {
    prefixes = [prefix];
  } else {
    try {
      prefixes = fs.readdirSync(root).filter((name) => PREFIX.test(name));
    } catch { /* no board yet */ }
  }
  const found = [];
  const errors = [];
  for (const name of prefixes) {
    let files = [];
    try {
      files = fs.readdirSync(prefixDir(name));
    } catch { /* no rows yet */ }
    for (const fileName of files) {
      const parsed = parseId(fileName.replace(/\.json$/, ''));
      if (!parsed || !fileName.endsWith('.json') || parsed.prefix !== name) continue;
      const file = path.join(prefixDir(name), fileName);
      try {
        const text = fs.readFileSync(file, 'utf8');
        if (text.trim() === '') continue;
        found.push({ ...parsed, row: parseJson(text) });
      } catch (err) {
        errors.push({ file, error: err.message });
      }
    }
  }
  return { rows: found.sort(byNumber).map((entry) => entry.row), errors };
}

// change: row => row. Returns the new row, or null when there's no such row.
function updateRow(id, change, { now = new Date() } = {}) {
  const row = readRow(id);
  if (!row) return null;
  const changed = change(row);
  changed.updated_at = isoTime(now);
  writeJsonAtomic(rowFile(id), changed);
  return changed;
}

function historyEntry(kind, by, text, { now = new Date() } = {}) {
  if (!HISTORY_KINDS.includes(kind)) throw new Error(`unknown history kind "${kind}"`);
  if (!HISTORY_BY.includes(by)) throw new Error(`history "by" must be spadework or user, not "${by}"`);
  return { at: isoTime(now), kind, by, text: String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_HISTORY_TEXT) };
}

const addHistory = (row, entry) => ({ ...row, history: [...(row.history || []), entry] });

// A row a split made starts with this history entry: it is how the row is
// told from an ordinary row under the same parent, before and after handoff
// gives it a work item. splitParent reads the work item it was split from.
const SPLIT_FROM = 'Split from #';
const splitEntry = (parentId, rev, options) => historyEntry('plan', 'spadework', `${SPLIT_FROM}${parentId} at rev ${rev}`, options);
function splitParent(row) {
  const entry = (Array.isArray(row.history) ? row.history : []).find((item) => item && item.kind === 'plan' && item.by === 'spadework' && String(item.text || '').startsWith(SPLIT_FROM));
  const match = entry ? entry.text.slice(SPLIT_FROM.length).match(/^(\d+)(?:\s|$)/) : null;
  return match ? Number(match[1]) : null;
}

// The row with a new status and a status history entry. The same status as
// before changes nothing. The one place a status change is written.
function withStatus(row, status, by, { now = new Date() } = {}) {
  if (typeof status !== 'string' || status.trim() === '') throw new Error('a status is needed');
  if (row.status === status) return row;
  return addHistory({ ...row, status }, historyEntry('status', by, `${row.status} → ${status}`, { now }));
}

// Returns { row, from }, or null when there's no such row.
function setStatus(id, status, { by = 'user', now = new Date() } = {}) {
  let from = null;
  const row = updateRow(id, (current) => {
    from = current.status;
    return withStatus(current, status, by, { now });
  }, { now });
  return row ? { row, from } : null;
}

const setFeedback = (id, text, { now = new Date() } = {}) => updateRow(id, (row) => ({ ...row, feedback: String(text ?? '') }), { now });

function deleteRow(id) {
  const file = rowFile(id);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

// The row IDs in a list like "SHOP-35,SHOP-36": { ids } without duplicates, or
// { error } for the first one that isn't a row ID.
function parseIdList(text) {
  const ids = [];
  for (const part of String(text ?? '').split(',').map((item) => item.trim().toUpperCase()).filter(Boolean)) {
    if (!parseId(part)) return { error: `"${part}" isn't a row ID like SHOP-35` };
    if (!ids.includes(part)) ids.push(part);
  }
  return { ids };
}

// What the table needs: the row without its heavy fields, plus its newest
// history entry.
function summary(row) {
  const light = Object.fromEntries(Object.entries(row).filter(([key]) => !HEAVY.includes(key)));
  const history = Array.isArray(row.history) ? row.history : [];
  return { ...light, last_event: history.length ? history[history.length - 1] : null };
}

module.exports = {
  ROW_ID, PREFIX, HISTORY_KINDS, HISTORY_BY, MAX_TITLE, MAX_TEXT, isoTime, parseId, parseIdList, withStatus, rowFile, prefixOf, suggestPrefix, newRow, createRow, readRow, listRows, updateRow,
  historyEntry, addHistory, splitEntry, splitParent, setStatus, setFeedback, deleteRow, summary,
};
