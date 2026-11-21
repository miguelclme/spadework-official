'use strict';

// The run log: logs/YYYY-MM-DD.jsonl. It holds one line per work item
// processed, so the user can see what a scheduled run did while they were
// away, and one line per triage, implement or handoff run when it ends
// (kind: "run"), which /spadework:stats reads. Files older than 30 days are
// deleted at the start of each triage and implement run.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { localDate } = require('./dates');
const { readJsonLines } = require('./json-file');

const RESULTS = ['planned', 'created', 'adopted', 'saved', 'updated', 'skipped', 'needs_info', 'blocked', 'implemented', 'failed', 'stopped', 'out_of_scope'];
const KEEP_DAYS = 30;
const LOG_NAME = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

// Never throws: a log problem must not stop a run.
function writeLine(line, now) {
  try {
    const dir = paths.all().logs;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${localDate(now)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(line) + '\n');
    return { ok: true, file };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// One work item (or row) processed. count: several items with one result
// (the items a backlog run skipped in a repo), counted as that many by stats.
function append(entry, { now = new Date() } = {}) {
  if (!RESULTS.includes(entry.result)) return { ok: false, error: `unknown result "${entry.result}". Use one of: ${RESULTS.join(', ')}` };
  return writeLine({
    time: now.toISOString(),
    command: entry.command || null,
    session_id: entry.session_id ?? null,
    work_item_id: entry.work_item_id ?? null,
    row_id: entry.row_id ?? null,
    repo: entry.repo ?? null,
    result: entry.result,
    duration_ms: entry.duration_ms ?? null,
    error: entry.error ?? null,
    ...(Number.isInteger(entry.count) && entry.count >= 0 ? { count: entry.count } : {}),
  }, now);
}

// A triage, implement or handoff run that ended. transcript_path: the chat's
// transcript, where /spadework:stats reads the tokens it used.
function appendRun(run, { transcriptPath = null, now = new Date() } = {}) {
  return writeLine({
    time: now.toISOString(),
    kind: 'run',
    command: run.mode,
    session_id: run.session_id,
    started_at: run.started_at ?? null,
    ended_at: now.toISOString(),
    transcript_path: typeof transcriptPath === 'string' && transcriptPath ? transcriptPath : null,
  }, now);
}

// The daily log files, oldest first: [{ name, file, day }]. Other files in
// the folder are left out.
function logFiles() {
  let names = [];
  try {
    names = fs.readdirSync(paths.all().logs).sort();
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const match = name.match(LOG_NAME);
    if (!match) return [];
    const [, year, month, day] = match.map(Number);
    return [{ name, file: path.join(paths.all().logs, name), day: new Date(year, month - 1, day) }];
  });
}

// Midnight `days` days before now's date.
const daysBefore = (now, days) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);

// Every line of the daily logs from the last `days` days (today included),
// oldest first.
function read({ days = 7, now = new Date() } = {}) {
  const from = daysBefore(now, days - 1);
  return logFiles().filter((log) => log.day >= from).flatMap((log) => readJsonLines(log.file) || []);
}

// Deletes daily logs older than KEEP_DAYS. Other files are left alone.
function prune({ now = new Date() } = {}) {
  const cutoff = daysBefore(now, KEEP_DAYS);
  const old = logFiles().filter((log) => log.day < cutoff);
  for (const log of old) fs.rmSync(log.file, { force: true });
  return old.map((log) => log.name);
}

module.exports = { append, appendRun, read, prune };
