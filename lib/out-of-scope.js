'use strict';

// Work items an agent found to be all outside the user's parts. No row is
// written for them, so without this the next run would send them to the
// agent again. One file per repo, in the Spadework data folder:
//   ~/.spadework/run/out-of-scope/<project>/<repo>.json
//   { "<work item id>": { "rev": 7, "date": "2026-10-21" } }
// An entry holds while the item keeps the same rev (the version number Azure
// DevOps raises on every edit). It is written by `triage log --result
// out_of_scope`, and removed by tidy(): when a run sees the item with another
// rev, or when it is older than KEEP_DAYS (an item never seen again would
// stay forever). Deleting the file is safe: those items are judged once more.

const path = require('path');
const paths = require('./paths');
const { writeJsonAtomic } = require('./fs-atomic');
const { readJsonOrNull } = require('./json-file');
const { localDate } = require('./dates');

const KEEP_DAYS = 30;

// Folder names: characters Windows doesn't allow in a name become "_".
const folderName = (name) => String(name).replace(/[<>:"/\\|?*]/g, '_').replace(/^\.+$/, '_');

// repo: { project, repo }
const fileOf = (repo) => path.join(paths.all().run, 'out-of-scope', folderName(repo.project), `${folderName(repo.repo)}.json`);

// The repo's entries, { "<id>": { rev, date } }. Empty when there is none.
function read(repo) {
  const entries = readJsonOrNull(fileOf(repo));
  return entries && typeof entries === 'object' && !Array.isArray(entries) ? entries : {};
}

function record(repo, item, rev, { now = new Date() } = {}) {
  writeJsonAtomic(fileOf(repo), { ...read(repo), [item]: { rev, date: localDate(now) } });
}

// Drops the entries whose item has another rev now (it's decided again) and
// the ones older than KEEP_DAYS. items: [{ id, rev }], the ones the run just read.
function tidy(repo, items, { now = new Date() } = {}) {
  const entries = read(repo);
  const cutoff = localDate(new Date(now.getTime() - KEEP_DAYS * 24 * 60 * 60 * 1000));
  const drop = Object.keys(entries).filter((id) => String(entries[id].date || '') < cutoff
    || items.some((item) => String(item.id) === id && Number(item.rev) !== Number(entries[id].rev)));
  if (!drop.length) return;
  for (const id of drop) delete entries[id];
  writeJsonAtomic(fileOf(repo), entries);
}

module.exports = { read, record, tidy };
