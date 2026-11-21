'use strict';

// The exact parts of /spadework:handoff, which creates the Requirements of a
// split as work items under their Feature in Azure DevOps. The skill talks to
// Azure DevOps; this file reads and writes the rows on the board and decides:
// - which rows a run may hand off (plan, check)
// - what the work items are: title, text, area path, the Feature above them
// - which work items already exist under a Feature (filter)
// - what the run may create: it saves the Features, work item type and titles
//   in the run file, and the guard allows nothing else (guards/handoff.js)
// - which work items it created (recordCreated, from the tool's own answer),
//   and writing each one into its row (created)
// - which Predecessor links it writes between the work items of rows that
//   depend on each other (links). A row that was already handed off comes
//   back only for its links.

const ado = require('./ado');
const board = require('./board');
const config = require('./config');
const { dependenciesOf } = require('./dependencies');
const log = require('./log');
const runs = require('./runs');
const split = require('./split');

// The rows to hand off, from "SHOP-41,SHOP-42".
function plan(rowIdsText) {
  const { config: cfg, error } = config.loadForRun();
  if (error) return { ok: false, error };
  if (!(cfg.tracker.work_items || []).some((item) => item.plan === 'split')) {
    return { ok: false, error: 'No work item type is set to split in tracker.work_items, so there is nothing to hand off.' };
  }
  const parsed = board.parseIdList(rowIdsText);
  if (parsed.error) return { ok: false, error: parsed.error };
  const wanted = parsed.ids;
  if (!wanted.length) return { ok: false, error: 'No row IDs given. Use /spadework:handoff SHOP-41,SHOP-42' };
  const found = wanted.map((id) => board.readRow(id));
  return {
    ok: true,
    organization: cfg.tracker.organization,
    approved_status: cfg.board.items.approved_status,
    rows: found.filter(Boolean).map((row) => ({ id: row.id, title: row.title, status: row.status })),
    missing: wanted.filter((id, index) => !found[index]),
  };
}

// Looks at each row and says which become work items. input: { rows: ["SHOP-41"] }.
// Reads the rows as the tech lead edited them on the board: the current title
// and spec count. A row is handed off when it is Approved, came from a split
// (it has a parent_id and the creates type), has no work item yet, has a
// title and a complete spec, and its repo is configured. The work item's area
// path is the row's (its Feature's) when that is one of the repo's area paths
// or under one, else the repo's first. A split row that already has its work
// item goes in links_only: nothing is created for it, whatever its status,
// and the links step adds the links it misses.
// Saves in the run file what the run may create, and returns the work items
// grouped by Feature, the links-only rows and the rows skipped.
function check(input, sessionId) {
  const { config: cfg, error } = config.loadForRun();
  if (error) return { ok: false, error };
  const run = runs.get(sessionId, { includeStale: true });
  if (!run || run.mode !== 'handoff') return { ok: false, error: 'There is no handoff run in this chat.' };
  // What earlier checks of this run saved: another row with the same title
  // under the same Feature, checked in a call before this one, counts too.
  const saved = run.handoff || {};
  const handoff = { ...saved, parents: { ...(saved.parents || {}) }, created: [...(saved.created || [])], links_only: [...(saved.links_only || [])] };
  const skipped = [];
  const linksOnly = [];
  const rowsOf = new Map();
  // The rows of a row's project, read once: its dependencies are found among them.
  const projectRows = (rowId) => {
    const { prefix } = board.parseId(rowId);
    if (!rowsOf.has(prefix)) rowsOf.set(prefix, board.listRows({ prefix }).rows);
    return rowsOf.get(prefix);
  };
  const groups = new Map();
  const skip = (rowId, reason) => skipped.push({ row_id: rowId, reason });

  for (const rowId of ((input && input.rows) || []).map((id) => String(id || '').trim().toUpperCase())) {
    if (!board.parseId(rowId)) { skip(rowId, `"${rowId}" isn't a row ID like SHOP-41.`); continue; }
    const row = board.readRow(rowId);
    if (!row) { skip(rowId, `${rowId}: not found on the board.`); continue; }
    const title = String(row.title || '').trim();
    const parentId = Number(row.parent_id);

    const fromSplit = Number.isInteger(parentId) && parentId >= 1 && Boolean(row.spec) && config.isCreatedType(cfg, row.type);
    if (row.work_item && fromSplit) {
      // Already handed off: nothing to create. It is here for the links it may miss.
      const entry = { row_id: rowId, id: Number(row.work_item.id) };
      handoff.links_only = [...handoff.links_only.filter((other) => other.row_id !== rowId), entry];
      linksOnly.push(entry);
      continue;
    }
    if (row.work_item) { skip(rowId, `${rowId} was already handed off as #${row.work_item.id}.`); continue; }
    if (!fromSplit) {
      skip(rowId, `${rowId} isn't a Requirement row from a split, so there is nothing to hand off.`);
      continue;
    }
    if (!config.sameName(row.status, cfg.board.items.approved_status)) { skip(rowId, `${rowId} is ${row.status || 'without a status'}, not ${cfg.board.items.approved_status}. Approve it first.`); continue; }
    if (!title) { skip(rowId, `${rowId} has no title.`); continue; }
    const problems = split.specErrors(rowId, row.spec);
    if (problems.length) { skip(rowId, `${problems.join('; ')}. Complete the spec on the board.`); continue; }

    const repo = config.findRepo(cfg.repos, row.project, row.repo);
    if (!repo) { skip(rowId, `${rowId} has no repo, or it isn't a configured repo of ${row.project}. Set the repo on the row.`); continue; }
    // The Feature's area path (the row's), when it is in the repo's backlog; else the repo's first.
    const areaPath = ado.areaPathFor(row.area_path, repo.area_paths);

    const known = handoff.parents[parentId] || { project: repo.project, creates: row.type, items: {} };
    const sameTitle = Object.entries(known.items).find(([other, entry]) => config.sameName(other, title) && entry.row_id !== rowId);
    if (sameTitle) { skip(rowId, `${rowId} has the same title as ${sameTitle[1].row_id} under #${parentId}.`); continue; }
    // The same row checked again replaces its own entry.
    for (const [other, entry] of Object.entries(known.items)) if (entry.row_id === rowId) delete known.items[other];
    known.items[title] = { row_id: rowId, area_path: areaPath };
    handoff.parents[parentId] = known;

    const group = groups.get(parentId) || { parent_id: parentId, project: repo.project, creates: row.type, items: [] };
    group.items.push({ row_id: rowId, title, description: descriptionOf(row, projectRows(rowId)), area_path: areaPath });
    groups.set(parentId, group);
  }

  if (!runs.setField(sessionId, 'handoff', handoff)) return { ok: false, error: 'There is no handoff run in this chat.' };
  return { ok: true, groups: [...groups.values()], links_only: linksOnly, skipped };
}

// Spadework's own earlier work items. A run cut off after creating a work
// item but before writing its number leaves one under the Feature. Such a
// child has the handoff tag and its row's tag (Spadework-SHOP-41), so it
// matches that row whatever its title is now. It isn't created again: the
// run adopts it and writes its number on the row. A child with the row's
// title but no such tags is someone else's work (or was cut off before it
// was tagged): the row is skipped and nothing is touched.
// children: the Feature's children in Azure DevOps: [{ id, title, tags }]
// Returns the rows to create, the ones adopted and the ones skipped.
function filter({ parent_id: parentId, children }, sessionId) {
  const run = runs.get(sessionId, { includeStale: true });
  const parent = run && run.handoff && run.handoff.parents[parentId];
  if (!parent) return { ok: false, error: `#${parentId} wasn't checked in this run` };
  const create = [];
  const adopted = [];
  const skipped = [];
  for (const [title, entry] of Object.entries(parent.items)) {
    const own = (children || []).find((child) => config.hasTag(child.tags, config.HANDOFF_TAG) && config.hasTag(child.tags, config.rowTag(entry.row_id)));
    const sameTitle = (children || []).find((child) => config.sameName(child.title, title));
    if (own) {
      run.handoff.created.push({ id: Number(own.id), title, parent: Number(parentId), row_id: entry.row_id, adopted: true });
      adopted.push({ row_id: entry.row_id, id: Number(own.id) });
    } else if (sameTitle) {
      skipped.push({ row_id: entry.row_id, reason: `${entry.row_id}: #${sameTitle.id} under #${parentId} has this title but not the tags "${config.HANDOFF_TAG}" and "${config.rowTag(entry.row_id)}", so it isn't known to be Spadework's. Left alone.` });
    } else {
      create.push(entry.row_id);
      continue;
    }
    delete parent.items[title];
  }
  runs.setField(sessionId, 'handoff', run.handoff);
  return { ok: true, create, adopted, skipped };
}

// Writes each work item this run created or adopted into its row: number,
// link, and the state and revision creation returned (an adopted item has
// none), plus a handoff entry in the row's history. A row that already holds
// that work item is left as it is. Each row written gets a log line for
// /spadework:stats: "created", or "updated" for an adopted work item.
function writeRows(created, organization, sessionId) {
  const written = [];
  const unwritten = [];
  for (const item of created) {
    let changed = false;
    const row = board.updateRow(item.row_id, (current) => {
      if (current.work_item && Number(current.work_item.id) === item.id) return current;
      changed = true;
      const project = current.project;
      return board.addHistory({
        ...current,
        work_item: { id: item.id, url: ado.workItemUrl(organization, project, item.id), state: item.state ?? null, rev: item.rev ?? null, hash: null, comments: 0 },
      }, board.historyEntry('handoff', 'spadework', `Created as ${item.id}`));
    });
    (row ? written : unwritten).push(item.row_id);
    if (row && changed) {
      log.append({ command: 'handoff', session_id: sessionId, work_item_id: item.id, row_id: item.row_id, repo: row.repo || null, result: item.adopted ? 'updated' : 'created' });
    }
  }
  return { written, unwritten };
}

// The work items this run created or adopted so far, with the row each one
// came from, and the rows that were meant to be created and weren't. Each
// work item is written into its row here.
function created(sessionId) {
  const run = runs.get(sessionId, { includeStale: true });
  if (!run || !run.handoff) return { ok: true, created: [], missing: [], written: [], unwritten: [] };
  const { config: cfg, error } = config.loadForRun();
  if (error) return { ok: false, error };
  const done = new Set(run.handoff.created.map((item) => item.row_id));
  const missing = Object.values(run.handoff.parents)
    .flatMap((parent) => Object.entries(parent.items).map(([title, entry]) => ({ row_id: entry.row_id, title })))
    .filter((entry) => !done.has(entry.row_id));
  const { written, unwritten } = writeRows(run.handoff.created, cfg.tracker.organization, sessionId);
  // The tags each new work item gets: handoff's and its row's.
  const withTags = run.handoff.created.map((item) => ({ ...item, tag: `${config.HANDOFF_TAG}; ${config.rowTag(item.row_id)}` }));
  return { ok: true, created: withTags, missing, written, unwritten };
}

// --- the links between the work items -------------------------------------------------

// The work item's description: the spec as Markdown. When the row depends on
// other rows, its "## Depends on" part names them, each with its work item
// when it has one, and the planner's text follows as notes.
function descriptionOf(row, rows) {
  const { items } = dependenciesOf(row, rows);
  if (!items.length) return split.specText(row.spec);
  const lines = [split.specText({ ...row.spec, depends_on: '' }), '## Depends on',
    ...items.map((item) => `- ${item.row_id} ${item.title} (${item.work_item ? `#${item.work_item}` : 'no work item yet'})`)];
  const notes = split.dependsOnNotes(row.spec);
  if (notes) lines.push('', 'Notes from the plan:', notes);
  return lines.join('\n');
}

// Whether the work item's relations already hold the link: a relation of
// that kind that points to the other work item.
function hasLink(relations, link) {
  return (Array.isArray(relations) ? relations : [])
    .some((relation) => relation && relation.rel === ado.LINK_RELATIONS[link.type] && ado.relationTarget(relation) === link.linkToId);
}

// The Predecessor links this run writes. When one row depends on another,
// their work items get a link. It is always written on a work item of this
// run: as "predecessor" on the dependent row's item when that is of this run,
// otherwise as "successor" on the dependency's item (the same link in Azure
// DevOps). Dependencies in another repo count too, and the links of a loop
// are written as they are.
// input: {} at first, then { relations: { "<work item id>": [its relations] } }
// for the work items `read` asked for: the ones that existed before this run,
// which may already hold a link. A work item created in this run has none.
// Returns { read, links, notes }. While `read` isn't empty the relations are
// still needed, and `links` is empty. Otherwise `links` is what to write,
// each { id, linkToId, type, project }: project is the one of the work item
// it is written on. The same list is saved in the run file: the guard
// allows no other link. It never changes a row.
function links(input, sessionId) {
  const { error } = config.loadForRun();
  if (error) return { ok: false, error };
  const run = runs.get(sessionId, { includeStale: true });
  if (!run || run.mode !== 'handoff' || !run.handoff) return { ok: false, error: 'There is no handoff run in this chat.' };
  const handoff = run.handoff;

  // The work items of this run, by row: created or adopted, and the links-only rows.
  const created = handoff.created || [];
  const linksOnly = handoff.links_only || [];
  const mine = new Map([...linksOnly, ...created].map((item) => [item.row_id, Number(item.id)]));
  // The ones that existed before this run.
  const older = new Set([...linksOnly, ...created.filter((item) => item.adopted)].map((item) => Number(item.id)));

  const rows = [];
  for (const prefix of new Set([...mine.keys()].map((rowId) => board.parseId(rowId).prefix))) rows.push(...board.listRows({ prefix }).rows);
  const workItemOf = (rowId, known) => mine.get(rowId) ?? (known ? Number(known) : null);
  const projectOfRow = new Map(rows.map((row) => [row.id, row.project]));

  const candidates = [];
  const notes = [];
  for (const row of rows) {
    const dependent = workItemOf(row.id, row.work_item && row.work_item.id);
    for (const item of dependenciesOf(row, rows).items) {
      // A link has one end in this run.
      if (!mine.has(row.id) && !mine.has(item.row_id)) continue;
      const dependency = workItemOf(item.row_id, item.work_item);
      if (dependency === null) {
        notes.push(`${row.id} depends on ${item.row_id}, which has no work item yet. The handoff that creates it adds the link.`);
        continue;
      }
      // A dependent row with no work item yet gets the link when it is handed off.
      if (dependent === null) continue;
      const link = mine.has(row.id)
        ? { id: dependent, linkToId: dependency, type: 'predecessor', project: row.project }
        : { id: dependency, linkToId: dependent, type: 'successor', project: projectOfRow.get(item.row_id) };
      if (!candidates.some((other) => other.id === link.id && other.linkToId === link.linkToId && other.type === link.type)) candidates.push(link);
    }
  }

  const given = config.isObject(input && input.relations) ? input.relations : {};
  const toRead = [...new Set(candidates.filter((link) => older.has(link.id)).map((link) => link.id))].filter((id) => !Array.isArray(given[id]));
  const wanted = toRead.length ? [] : candidates.filter((link) => !older.has(link.id) || !hasLink(given[link.id], link));
  if (!runs.setField(sessionId, 'handoff', { ...handoff, links: wanted })) return { ok: false, error: 'There is no handoff run in this chat.' };
  const read = toRead.map((id) => ({ id, project: candidates.find((link) => link.id === id).project }));
  return { ok: true, read, links: wanted, notes };
}

// Reads the numbers out of what add_child returned and saves those that
// match what this run may create (the title ignoring case, under the right
// Feature). Returns how many were saved.
function recordCreated(sessionId, response) {
  const run = runs.get(sessionId, { includeStale: true });
  if (!run || run.mode !== 'handoff' || !run.handoff) return 0;
  const found = ado.createdItems(response);

  let saved = 0;
  const handoff = run.handoff;
  for (const item of found) {
    const id = Number(item.id);
    const title = String((item.fields || {})['System.Title'] || '');
    const parentId = Number((item.fields || {})['System.Parent']);
    const parent = handoff.parents[parentId];
    const planned = parent && Object.entries(parent.items).find(([other]) => config.sameName(other, title));
    if (!Number.isInteger(id) || !planned || handoff.created.some((other) => other.id === id)) continue;
    const state = (item.fields || {})['System.State'];
    const rev = Number(item.rev ?? (item.fields || {})['System.Rev']);
    handoff.created.push({
      id, title: planned[0], parent: parentId, row_id: planned[1].row_id,
      ...(state ? { state: String(state) } : {}),
      ...(Number.isInteger(rev) ? { rev } : {}),
    });
    saved++;
  }
  if (saved) runs.setField(sessionId, 'handoff', handoff);
  return saved;
}

module.exports = { plan, check, filter, created, links, recordCreated };
