'use strict';

// The duplicate check: what triage does with each work item, given the row
// the board already has for it. A fingerprint of what the work item asks for
// tells a real change from a change of state, sprint or comments.
// decide() is pure. applyDecision() (lib/triage-rows.js) writes its updates.

const crypto = require('crypto');

const ado = require('./ado');
const board = require('./board');
const config = require('./config');
const { wholeNumber } = require('./numbers');

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

// Plain text from an HTML field: tags, entities and spacing don't count,
// so reformatting a description isn't a change.
// lines: keep the line breaks of paragraphs, list items and <br>, for text
// a planner reads; spacing inside a line is still collapsed.
function plainText(value, { lines = false } = {}) {
  let text = String(value ?? '');
  if (lines) {
    text = text.replace(/<br\s*\/?>|<\/(p|div|ul|ol|h[1-6]|tr)>/gi, '\n').replace(/<li\b[^>]*>/gi, '\n- ').replace(/<img\b[^>]*>/gi, '[image]');
  }
  text = text
    .replace(/<[^>]*>/g, lines ? '' : ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, name) => {
      if (name[0] === '#') {
        const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        // &#1114112; and bigger aren't characters: fromCodePoint would throw.
        return Number.isInteger(code) && code >= 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[name.toLowerCase()] ?? all;
    });
  if (!lines) return text.replace(/\s+/g, ' ').trim();
  return text.split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// What the work item asks for, as a short hash: its title, type and content
// fields. State, sprint, assignee, tags and comments are left out, so
// changing them never plans an item again. Only fields with text count, each
// with its name. A field the type lacks, or an empty one, adds nothing: so
// adding a field to content_fields changes only items that have text in it,
// and filling an empty field is a change.
// fields: the work item's fields as Azure DevOps returns them.
function fingerprint(fields, contentFields) {
  const byName = new Map(Object.entries(fields || {}).map(([name, value]) => [name.toLowerCase(), value]));
  const parts = ['System.Title', 'System.WorkItemType', ...contentFields]
    .map((name) => [name.toLowerCase(), plainText(byName.get(name.toLowerCase()))])
    .filter(([, text]) => text);
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

// Why triage must leave a row alone, or null. A Feature that was split has
// Requirement rows under it: those are edited, never the Feature. A
// Requirement row made by a split has no work item until handoff, so there
// is nothing to plan again.
// row: { row_id?, work_item_id, type, children? }
//   children: how many rows a split of this one made (only read for split types)
function splitRefusal(row, cfg) {
  const label = row.row_id || (row.work_item_id ? `#${row.work_item_id}` : 'This row');
  const kind = config.kindOf(cfg, row.type || '');
  if (kind.ok && kind.plan === 'split' && Number(row.children) > 0) {
    return `${label} is already split. Edit its ${kind.creates} rows instead.`;
  }
  // Only a split makes rows with no work item, so this holds whatever the
  // config says now (a tech-lead split, then a switch back to the dev config).
  const noWorkItem = row.work_item_id === null || row.work_item_id === undefined || row.work_item_id === '';
  if (noWorkItem) return `${label} has no work item yet. Hand it off first; until then, edit its text in the board.`;
  return null;
}

// What to say about a split type that already has children in Azure DevOps
// (its System.LinkTypes.Hierarchy-Forward relations), or null. A backlog run
// leaves it alone (refuse); a single item or a re-triage row is the user's
// choice, so it is split anyway, with the same names (warning).
function adoChildrenNote(id, kind, relations, { backlog = false } = {}) {
  if (!kind.ok || kind.plan !== 'split') return null;
  const ids = (relations || [])
    .filter((relation) => relation && relation.rel === 'System.LinkTypes.Hierarchy-Forward')
    .map(ado.relationTarget)
    .filter((number) => number !== null)
    .map((number) => `#${number}`);
  if (!ids.length) return null;
  const has = `#${id} already has ${ids.length === 1 ? 'a work item' : 'work items'} under it in Azure DevOps (${ids.join(', ')}).`;
  return backlog
    ? { refusal: `${has} A backlog run doesn't split it again: run /spadework:triage ${id} to split it anyway.` }
    : { warning: `${has} It is split anyway: delete the old ones in Azure DevOps if the new ${kind.creates} rows replace them.` };
}

// A board row in the flat shape the checks below read. children counts the
// rows a split of this row's work item made (board.splitParent). A row whose
// Parent ID is the work item for another reason (an Azure DevOps child with
// a row of its own) doesn't make it "already split".
function flatRow(row, rows = []) {
  const workItem = row.work_item || null;
  const children = workItem ? rows.filter((other) => board.splitParent(other) === Number(workItem.id)).length : 0;
  return {
    row_id: row.id,
    work_item_id: workItem ? workItem.id : null,
    card_rev: workItem ? workItem.rev : null,
    card_hash: workItem ? workItem.hash : null,
    card_comments: workItem ? workItem.comments : null,
    status: row.status,
    repo: row.repo,
    parent_id: row.parent_id,
    area_path: row.area_path,
    type: row.type,
    children,
  };
}

// Repos named by past rows: rows with the same parent first, then rows with
// the same area path. Only one repo counts, and only one of `allowed`.
function fromPastRows(item, rows, allowed) {
  const others = (rows || []).filter((row) => Number(row.work_item_id) !== Number(item.id) && row.repo);
  const pick = (list) => {
    const names = new Set(list.map((row) => String(row.repo).trim().toLowerCase()).filter((name) => allowed.has(name)));
    return names.size === 1 ? allowed.get([...names][0]) : null;
  };
  if (item.parent_id) {
    const repo = pick(others.filter((row) => Number(row.parent_id) === Number(item.parent_id)));
    if (repo) return { repo, reason: 'past rows with the same parent' };
  }
  if (item.area_path) {
    const repo = pick(others.filter((row) => config.sameName(row.area_path, item.area_path)));
    if (repo) return { repo, reason: 'past rows with the same area path' };
  }
  return null;
}

// The repo past rows point to for an item whose row (if any) names no repo, or null.
function pastRowsFor(item, flatRows, cfg, row = null) {
  const owner = row ? config.findRepo(cfg.repos, item.project, row.repo) : null;
  if (owner) return null;
  const candidates = ado.backlogsOf(cfg.repos, item);
  return fromPastRows(item, flatRows, new Map(candidates.map((name) => [name.toLowerCase(), name])));
}

// The duplicate check, for one page of a repo's backlog: which items get a
// new row, which rows are planned again, and which are left alone.
// items: [{ id, project, area_path, rev, state, parent_id, comments, fields? }]
//   comments: the work item's comment count
//   fields: the title, type and content fields, sent only on the second
//   call, for the items the first call answered with "check"
// rows:  flat rows (flatRow): [{ row_id, work_item_id, card_rev, card_hash, card_comments, status, repo, parent_id, area_path, type, children }]
// repo:  the repo this run is on ({ project, repo }), or null. force: a
//        single-item run, which plans it again even when nothing changed.
// outOfScope: { "<id>": { rev } } of the repo's items an agent found to be outside
//        the user's parts (lib/out-of-scope.js): skipped while the rev is the same.
// A row's repo is a name within the item's project.
// Actions:
//   analyze  plan it (mode create or update)
//   check    the rev changed: send its fields again, to see if the work changed
//   refresh  only state, sprint, comments... changed: update `card` (rev, state, comments)
//   note     the work changed on a row past triage: add `note` to its history, update `card`
//   handoff  the work changed on another repo's row: set it to Re-triage, add `note`
//   skip     nothing to do, see `reason`
function decide({ items, rows, repo = null, force = false, outOfScope = {} }, cfg) {
  // Without a rev, "unchanged" never matches and the row is checked again
  // on every run: refuse the call, so the skill builds the items again.
  const noRev = (items || []).filter((item) => !item || wholeNumber(item.rev) === null).map((item) => (item && item.id) ?? '?');
  if (noRev.length) {
    return { ok: false, error: `${noRev.length === 1 ? 'item' : 'items'} ${noRev.join(', ')} ${noRev.length === 1 ? 'has' : 'have'} no rev (System.Rev). Build the items again with every field and run decide once more` };
  }
  const byId = new Map();
  const duplicates = [];
  for (const row of rows || []) {
    const id = Number(row.work_item_id);
    if (!Number.isInteger(id)) continue;
    if (byId.has(id)) duplicates.push(id);
    else byId.set(id, row);
  }

  const context = { cfg, rows: rows || [], current: repo && repo.repo ? repo : null, force, outOfScope: outOfScope || {} };
  const results = (items || []).map((item) => decideItem(item, byId.get(Number(item.id)), context));
  return { ok: true, items: results, duplicate_rows: [...new Set(duplicates)] };
}

// decide()'s answer for one item and its row (undefined when it has none).
function decideItem(item, row, { cfg, rows, current, force, outOfScope }) {
  const roles = cfg.board.items;
  const id = Number(item.id);
  const candidates = ado.backlogsOf(cfg.repos, item);
  // The row's Repo as config.json spells it, when it's a repo of the item's project.
  const ownerRepo = row ? config.findRepo(cfg.repos, item.project, row.repo) : null;
  const owner = ownerRepo ? ownerRepo.name : null;
  const isCurrent = (name) => config.sameRepo({ project: item.project, repo: name }, current);
  const otherRepo = Boolean(current && owner && !isCurrent(owner));
  // Only asked for when the row names no repo: which repo past rows point to.
  const pastRows = () => (owner ? null : fromPastRows(item, rows, new Map(candidates.map((name) => [name.toLowerCase(), name]))));

  // In another repo's backlog, and no row names a repo: that repo's own run handles it.
  if (!force && current && !owner && !candidates.some(isCurrent)) {
    return { id, action: 'skip', reason: candidates.length ? `in ${candidates.join(', ')}'s backlog` : 'not in a configured backlog' };
  }
  // An agent found all of it outside the user's parts and the rev is the same.
  // It has no row, so this check must come before the missing-row check. A
  // single-item run (force) or a new rev skips it: the item is judged again.
  const known = !force && outOfScope[id];
  if (known && Number(known.rev) === Number(item.rev)) return { id, action: 'skip', reason: `out of your scope at rev ${item.rev}` };

  if (!row) return { id, action: 'analyze', mode: 'create', shared: candidates.length > 1, past_rows: pastRows() };

  const base = { id, row: row.row_id || null };
  const refusal = splitRefusal(row, cfg);
  if (refusal) return { ...base, action: 'skip', reason: refusal };
  const reanalyze = (extra = {}) => ({ ...base, action: 'analyze', mode: 'update', ...extra, row_repo: owner, past_rows: pastRows() });
  const isOpen = config.sameName(row.status, roles.default_status) || config.sameName(row.status, roles.needs_info_status);
  const waitingRetriage = config.sameName(row.status, roles.retriage_status);

  if (force) {
    const closed = statusRefusal(row.status, cfg);
    return closed ? { ...base, action: 'skip', reason: closed } : reanalyze();
  }
  if (waitingRetriage) return { ...base, action: 'skip', reason: 'waiting for a re-triage' };

  const oldRev = row.card_rev === null || row.card_rev === undefined || row.card_rev === '' ? null : Number(row.card_rev);
  const newRev = Number(item.rev);
  if (oldRev !== null && oldRev === newRev) return { ...base, action: 'skip', reason: 'unchanged' };

  // Comments aren't in the hash, but on a Needs info row a new comment is
  // often the answer, so the row is planned again.
  const newComments = wholeNumber(item.comments);
  const oldComments = wholeNumber(row.card_comments);
  if (config.sameName(row.status, roles.needs_info_status) && !otherRepo && oldComments !== null && newComments !== null && newComments > oldComments) {
    return reanalyze({ reason: `new comments on a ${roles.needs_info_status} row` });
  }
  // What the row keeps about the work item, updated on every change.
  const card = { rev: newRev, state: item.state || null, ...(newComments === null ? {} : { comments: newComments }) };

  // The rev changed. Rows written before the fingerprint existed have no
  // hash: for those, any change counts.
  let hash = null;
  if (row.card_hash) {
    if (!item.fields) return { ...base, action: 'check' };
    hash = fingerprint(item.fields, cfg.tracker.content_fields);
    if (hash === row.card_hash) return { ...base, action: 'refresh', reason: 'only state, sprint, comments or similar changed', card };
  }
  const revText = `rev ${oldRev ?? '?'} → ${newRev}`;

  if (!isOpen) {
    return { ...base, action: 'note', note: `Changed after ${row.status}, ${revText}; plan kept`, card: { ...card, ...(hash ? { hash } : {}) } };
  }
  if (!cfg.triage.reanalyze_when_card_changes) return { ...base, action: 'refresh', reason: 'changed, but re-analysis is off', card };
  if (otherRepo) {
    return { ...base, action: 'handoff', repo: owner, note: `Changed, ${revText}. Waiting for a re-triage in ${owner}`, status: roles.retriage_status };
  }
  return reanalyze({ hash, shared: candidates.length > 1 });
}

// Why a single-item run won't plan a row again, or null: triage only changes
// rows that are still open or waiting for a re-triage.
function statusRefusal(status, cfg) {
  const roles = cfg.board.items;
  const open = [roles.default_status, roles.needs_info_status, roles.retriage_status];
  return open.some((name) => config.sameName(status, name))
    ? null
    : `the row is ${status}. Triage only changes ${roles.default_status}, ${roles.needs_info_status} and ${roles.retriage_status} rows`;
}

module.exports = { decide, flatRow, pastRowsFor, fingerprint, plainText, splitRefusal, statusRefusal, adoChildrenNote };
