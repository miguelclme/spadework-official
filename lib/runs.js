'use strict';

// Run tracking: which sessions are Spadework runs right now.
// Each run is one file, run/sessions/<session_id>.json, holding the mode,
// the working folder and the start time. The file's modified time is the
// last activity: hooks touch it as the run goes on. After CUT_OFF_AFTER_MS
// with no activity a run is "stale": its chat counts as ended, and an init or
// design run file is removed. Other run files stay, so their guards stay on
// if the chat comes back: only their own Stop hook (or the run's end)
// removes them.
//
// Triage also takes:
// - a lock per repo, run/locks/<repo label>.json ("Shop/api"): one triage
//   per repo at a time, different repos at the same time. The lock also
//   carries a stop request from /spadework:stop.
// - a claim per work item, run/claims/<id>.json: repos can share a
//   backlog, so two runs may fetch the same item. The first to claim it
//   analyzes it; the other skips it.
// Locks and claims belong to a session and go when its run ends, or when
// its run goes stale.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const web = require('./web');
const { topLevel } = require('./git');
const { writeJsonAtomic } = require('./fs-atomic');
const numbers = require('./numbers');
const { readJsonOrNull, readTextOrNull, parseJsonOrNull, listJsonFiles } = require('./json-file');

const MODES = ['init', 'triage', 'implement', 'handoff', 'merge', 'design', 'design-push'];
// Runs that are one turn long: they end when Claude's turn ends (Stop), and
// their guards allow only a known set of tools. Init and design go back and
// forth with the user, so they aren't.
const ONE_TURN_MODES = ['triage', 'implement', 'handoff', 'merge', 'design-push'];
const isOneTurn = (mode) => ONE_TURN_MODES.includes(mode);
// Runs written to the log when they end, for /spadework:stats.
const isLogged = (mode) => isOneTurn(mode) || mode === 'design';
// Runs whose run file goes after CUT_OFF_AFTER_MS with no activity.
const PRUNED_WHEN_IDLE = ['init', 'design'];
// A chat with no activity for this long counts as ended: its implement row
// as cut off, its triage's locks and claims as free. Long, because a chat
// may wait overnight on a permission question.
const CUT_OFF_AFTER_MS = 24 * 60 * 60 * 1000;
const CUT_OFF_TEXT = `${CUT_OFF_AFTER_MS / (60 * 60 * 1000)} hours`;
// A lock or claim that can't be read yet may be one another process is writing.
const UNREADABLE_GRACE_MS = 10 * 1000;
const { isValidSessionId } = paths;
const isStale = (lastActivityMs, now = Date.now()) => now - lastActivityMs > CUT_OFF_AFTER_MS;
const sessionFile = paths.runFile;
const locksDir = () => path.join(paths.all().run, 'locks');
const claimsDir = () => path.join(paths.all().run, 'claims');
// Repo labels ("Shop/api") hold characters file names can't. A short hash
// of the label keeps "Shop/api" and "Shop_api" apart (labels are unique ignoring case).
const repoKey = (repo) => {
  const name = String(repo).toLowerCase();
  return `${name.replace(/[^a-z0-9_.-]/g, '_')}-${crypto.createHash('sha1').update(name).digest('hex').slice(0, 8)}`;
};
const lockFile = (repo) => path.join(locksDir(), `${repoKey(repo)}.json`);
const claimFile = (workItemId) => path.join(claimsDir(), `${Number(workItemId)}.json`);

function removeFile(file) {
  fs.rmSync(file, { force: true });
}

// Removes a lock or claim that was judged stale, but only if it is still
// the same file: between reading it and removing it, another run may have
// taken it over and written its own. That one is put back.
function removeIfUnchanged(file, seen) {
  const moved = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.old`;
  try {
    fs.renameSync(file, moved);
  } catch {
    return; // already gone: someone else removed it
  }
  let content = null;
  try {
    content = fs.readFileSync(moved, 'utf8');
  } catch { /* unreadable: treat as changed */ }
  if (content !== seen) {
    try {
      fs.linkSync(moved, file); // put it back, unless a new one is already there
    } catch { /* a newer one won */ }
  }
  removeFile(moved);
}

// --- sessions -----------------------------------------------------------------

// The session's run, or null if it has none. Stale runs count as none,
// unless includeStale is set (the hooks, cleanup and validate).
function get(sessionId, { now = Date.now(), includeStale = false } = {}) {
  if (!isValidSessionId(sessionId)) return null;
  const file = sessionFile(sessionId);
  let stats;
  try {
    stats = fs.statSync(file);
  } catch {
    return null;
  }
  const run = readJsonOrNull(file);
  if (!run || !MODES.includes(run.mode)) return null;
  const stale = isStale(stats.mtimeMs, now);
  if (stale && !includeStale) return null;
  return {
    session_id: sessionId,
    mode: run.mode,
    cwd: run.cwd ?? null,
    repo_path: run.repo_path ?? null,
    started_at: run.started_at ?? null,
    handoff: run.handoff ?? null,
    design: run.design ?? null,
    design_push: run.design_push ?? null,
    last_activity: new Date(stats.mtimeMs).toISOString(),
    stale,
  };
}

// Whether the session is a run of this mode that isn't stale.
function isWorking(sessionId, mode, now = Date.now()) {
  const run = get(sessionId, { now });
  return Boolean(run && run.mode === mode);
}

// Records activity on the session's run, if it has one.
function touch(sessionId, now = Date.now()) {
  if (!isValidSessionId(sessionId)) return false;
  try {
    const time = new Date(now);
    fs.utimesSync(sessionFile(sessionId), time, time);
    return true;
  } catch {
    return false;
  }
}

// Starts a run in this session. Starting the mode the session already runs
// is fine (both prompt hooks fire for the same command). A different mode,
// or a stale run, is ended first: the new run starts with nothing of it.
function start(sessionId, mode, { cwd = null, now = Date.now() } = {}) {
  if (!isValidSessionId(sessionId)) return { ok: false, error: 'invalid session id' };
  if (!MODES.includes(mode)) return { ok: false, error: `unknown mode "${mode}"` };

  const existing = get(sessionId, { now });
  if (existing && existing.mode === mode) {
    touch(sessionId, now);
    return { ok: true, run: get(sessionId, { now }) };
  }
  end(sessionId);
  const run = { mode, cwd, started_at: new Date(now).toISOString() };
  // Implement works in one repo: its top folder, even when Claude was
  // started in a subfolder of it. The implement guard keeps writes there.
  if (mode === 'implement' && cwd) {
    run.repo_path = topLevel(cwd) || cwd;
  }
  writeJsonAtomic(sessionFile(sessionId), run);
  touch(sessionId, now);
  return { ok: true, run: get(sessionId, { now }) };
}

// Saves a field of the session's run file (handoff keeps the parents, titles
// and work items it may create there). Returns false when there is no run.
function setField(sessionId, key, value) {
  if (!isValidSessionId(sessionId)) return false;
  const run = readJsonOrNull(sessionFile(sessionId));
  if (!run) return false;
  writeJsonAtomic(sessionFile(sessionId), { ...run, [key]: value });
  return true;
}

// Ends this session's run and gives back its locks and claims.
function end(sessionId) {
  if (!isValidSessionId(sessionId)) return false;
  const had = get(sessionId, { includeStale: true }) !== null;
  // Locks first: while the run file is there, no other chat takes them as
  // abandoned, so none can write its own before this one deletes them.
  releaseAll(sessionId);
  removeFile(sessionFile(sessionId));
  removeFile(unfinishedFile(sessionId));
  web.clear(sessionId);
  return had;
}

// A triage whose turn ended before it finished: it still held a repo lock.
// A triage that finished unlocks every repo before its summary. Its run ends
// at Stop like any other, so the next prompt in that chat ("continue") starts
// it again with its guards on.
const unfinishedFile = (sessionId) => path.join(paths.all().sessions, `${sessionId}.unfinished`);

const holdsAny = (dir, sessionId) => listJsonFiles(dir).some((file) => {
  const owner = readJsonOrNull(file);
  return Boolean(owner && owner.session_id === sessionId);
});
const holdsLock = (sessionId) => holdsAny(locksDir(), sessionId);
// A claim is held from `triage start` to `triage finish`: an agent is still
// planning that item, even when the main chat's turn has ended.
const holdsClaim = (sessionId) => holdsAny(claimsDir(), sessionId);

function markUnfinished(sessionId) {
  if (!isValidSessionId(sessionId)) return;
  fs.mkdirSync(paths.all().sessions, { recursive: true });
  fs.writeFileSync(unfinishedFile(sessionId), new Date().toISOString() + '\n');
}

// True once, when the session's triage was cut off; removes the mark.
function takeUnfinished(sessionId) {
  if (!isValidSessionId(sessionId) || !fs.existsSync(unfinishedFile(sessionId))) return false;
  removeFile(unfinishedFile(sessionId));
  return true;
}

// Every run file, stale ones included.
function list({ now = Date.now() } = {}) {
  return listJsonFiles(paths.all().sessions)
    .map((file) => get(path.basename(file, '.json'), { now, includeStale: true }))
    .filter(Boolean);
}

// Whether any chat has a run of this mode: 'active', 'stale' (only ones
// quiet for longer than the cut-off) or null. Init's panel saves only while
// an init run is active.
function anyRun(mode, { now = Date.now() } = {}) {
  const found = list({ now }).filter((run) => run.mode === mode);
  if (found.some((run) => !run.stale)) return 'active';
  return found.length ? 'stale' : null;
}

// Removes the run files of idle init and design runs, and locks and claims
// nobody holds. Other run files stay: their chat may only be waiting (a
// permission question left overnight), and its guards must stay on. Their
// Stop hook removes them at the end of that chat's turn.
function pruneStale({ now = Date.now() } = {}) {
  const removed = [];
  for (const run of list({ now })) {
    if (!run.stale || !PRUNED_WHEN_IDLE.includes(run.mode)) continue;
    end(run.session_id);
    removed.push(run.session_id);
  }
  for (const lock of listLocks({ now })) if (lock.stale) removeFile(lock.file);
  for (const claim of listClaims({ now })) if (claim.stale) removeFile(claim.file);
  removeLeftFiles(now);
  return removed;
}

// Files a crash can leave behind: half-done writes (.tmp, .old), which live
// for milliseconds, and the mark of a cut-off triage nobody continued.
const LEFT_FILE_AFTER_MS = 60 * 60 * 1000;
const UNFINISHED_AFTER_MS = 24 * 60 * 60 * 1000;

function removeLeftFiles(now) {
  for (const dir of [paths.all().sessions, locksDir(), claimsDir(), paths.all().implementing, paths.all().merging]) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const after = /\.(tmp|old)$/.test(name) ? LEFT_FILE_AFTER_MS : name.endsWith('.unfinished') ? UNFINISHED_AFTER_MS : null;
      if (after === null) continue;
      const file = path.join(dir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > after) removeFile(file);
      } catch { /* gone */ }
    }
  }
}

// A lock or claim is stale when its owner isn't a triage run that is still
// working (mode: an implement row file's owner is an implement run).
function ownerGone(owner, file, now, mode = 'triage') {
  if (!owner || !isValidSessionId(owner.session_id)) {
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch { /* gone */ }
    return now - mtime > UNREADABLE_GRACE_MS;
  }
  return !isWorking(owner.session_id, mode, now);
}

// Removes a lock or claim, if this session holds it.
function removeIfOwnedBy(file, sessionId) {
  const owner = readJsonOrNull(file);
  if (owner && owner.session_id === sessionId) removeFile(file);
}

function releaseAll(sessionId) {
  for (const file of [...listJsonFiles(locksDir()), ...listJsonFiles(claimsDir())]) removeIfOwnedBy(file, sessionId);
}

// Takes a lock, claim or row file for this session: writes the file only if
// nobody holds it. One whose owner stopped working (ownerGone) is replaced.
// content: the text, or a function of the owner it replaces (null if none).
// When this session already holds it, nothing is written: { ok, mine }.
// busy(owner) is the answer when another run holds it; raced, when another
// run took it at the same moment three times running.
function take(file, content, sessionId, { now, mode, busy, raced }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let replaced = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, typeof content === 'function' ? content(replaced) : content, { flag: 'wx' });
      return { ok: true };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const seen = readTextOrNull(file);
    const owner = seen === null ? null : parseJsonOrNull(seen);
    if (owner && owner.session_id === sessionId) return { ok: true, mine: owner };
    if (!ownerGone(owner, file, now, mode)) return busy(owner);
    replaced = owner;
    if (seen !== null) removeIfUnchanged(file, seen);
  }
  return { ok: false, error: raced };
}

// --- repo locks ---------------------------------------------------------------

// file: when the caller already has it. A lock that can't be read has no
// repo inside, so its file can't be found again from a name.
function readLock(repo, { now = Date.now(), file = lockFile(repo) } = {}) {
  if (!fs.existsSync(file)) return null;
  const lock = readJsonOrNull(file);
  return {
    repo: lock && lock.repo ? lock.repo : repo,
    session_id: lock ? lock.session_id ?? null : null,
    started_at: lock ? lock.started_at ?? null : null,
    stop_requested: Boolean(lock && lock.stop_requested),
    stale: ownerGone(lock, file, now),
    file,
  };
}

function listLocks({ now = Date.now() } = {}) {
  return listJsonFiles(locksDir()).map((file) => {
    const lock = readJsonOrNull(file);
    return readLock(lock && lock.repo ? lock.repo : path.basename(file, '.json'), { now, file });
  }).filter(Boolean);
}

// Takes the repo's lock for this session. Fails when another triage that is
// still working holds it. The run file keeps the repos it locked (tookLock).
function lockRepo(sessionId, repo, { now = Date.now() } = {}) {
  if (!isValidSessionId(sessionId)) return { ok: false, error: 'invalid session id' };
  const content = JSON.stringify({ repo, session_id: sessionId, started_at: new Date(now).toISOString(), stop_requested: false }, null, 2) + '\n';
  const locked = take(lockFile(repo), content, sessionId, {
    now,
    busy: () => {
      const holder = readLock(repo, { now });
      return { ok: false, holder, error: `A triage for ${repo} is already running (started at ${formatTime(holder && holder.started_at, now)}).` };
    },
    raced: `Another triage for ${repo} took the lock at the same moment.`,
  });
  if (locked.ok && !tookLock(sessionId, repo)) {
    const run = readJsonOrNull(sessionFile(sessionId));
    if (run) setField(sessionId, 'locked_repos', [...(run.locked_repos || []), repo]);
  }
  return locked;
}

// Whether this session's run locked the repo before, even if the lock is gone
// now: a lock that is gone then means a forced stop, not one never taken.
function tookLock(sessionId, repo) {
  const run = isValidSessionId(sessionId) ? readJsonOrNull(sessionFile(sessionId)) : null;
  const name = String(repo).toLowerCase();
  return Boolean(run && Array.isArray(run.locked_repos) && run.locked_repos.some((taken) => String(taken).toLowerCase() === name));
}

const unlockRepo = (sessionId, repo) => removeIfOwnedBy(lockFile(repo), sessionId);

// How /spadework:stop (requestStop, below) works. It asks the triage holding
// the repo's lock to stop after the item it's on. With force, it removes the
// lock and its owner's claims now (for a run that crashed), and the triage run
// file too when the owner holds no other repo's lock. A chat still working
// then sees its lock is gone and stops; a killed one leaves nothing behind.
// Without force, a run whose lock is already gone (an earlier --force, or the
// cut-off) is ended only once quiet for QUIET_AFTER_MS: a chat ending on its
// own keeps its run (and its guards) until its turn ends.
const QUIET_AFTER_MS = 5 * 60 * 1000;

// Ends the triage run of a session whose lock on a repo is gone, when it
// holds no other lock: at once with force, otherwise once quiet.
function endUnlockedRun(sessionId, { force, now }) {
  const run = get(sessionId, { now, includeStale: true });
  if (!run || run.mode !== 'triage' || holdsLock(sessionId)) return false;
  if (!force && now - Date.parse(run.last_activity) <= QUIET_AFTER_MS) return false;
  return end(sessionId);
}

// Triage runs that took the repo's lock before and hold no lock now: the
// lock was removed (--force, the cut-off), but a killed chat never ended
// its own run file.
const leftRunsOf = (repo, now) => list({ now }).filter((run) => run.mode === 'triage' && tookLock(run.session_id, repo) && !holdsLock(run.session_id));

// The repos those runs took, for a stop by project: each is stopped like a
// locked one, so the run file goes.
function unlockedRepos({ now = Date.now() } = {}) {
  const labels = new Set();
  for (const run of list({ now })) {
    if (run.mode !== 'triage' || holdsLock(run.session_id)) continue;
    const saved = readJsonOrNull(sessionFile(run.session_id));
    for (const repo of (saved && Array.isArray(saved.locked_repos) ? saved.locked_repos : [])) if (!fs.existsSync(lockFile(repo))) labels.add(repo);
  }
  return [...labels];
}

function requestStop(repo, { force = false, now = Date.now() } = {}) {
  const lock = readLock(repo, { now });
  if (!lock) {
    const left = leftRunsOf(repo, now);
    const ended = left.filter((run) => endUnlockedRun(run.session_id, { force, now }));
    if (ended.length) return { ok: true, forced: true, was_stale: true, run_ended: true, holder: null };
    if (left.length) return { ok: false, error: `No triage holds the lock for ${repo} any more, but its chat (session ${left[0].session_id}) is still ending. Its run file goes when that chat's turn ends; to remove it now, add --force.` };
    return { ok: false, error: `No triage is running for ${repo}.` };
  }
  if (force || lock.stale) {
    removeFile(lock.file);
    let runEnded = false;
    if (lock.session_id) {
      releaseClaimsOf(lock.session_id);
      runEnded = endUnlockedRun(lock.session_id, { force, now });
    }
    return { ok: true, forced: true, was_stale: lock.stale, run_ended: runEnded, holder: lock };
  }
  const saved = readJsonOrNull(lock.file) || {};
  writeJsonAtomic(lock.file, { ...saved, repo, stop_requested: true });
  return { ok: true, forced: false, holder: lock };
}

// Why this session's triage of the repo should stop now, or null: a stop was
// requested, or its lock was removed (forced stop) or taken by another chat.
function stopReason(sessionId, repo) {
  const lock = readJsonOrNull(lockFile(repo));
  if (!lock) return `its lock on ${repo} was removed (by /spadework:stop --force, or after ${CUT_OFF_TEXT} with no activity)`;
  if (lock.session_id !== sessionId) return `another chat now holds the lock on ${repo}`;
  if (lock.stop_requested) return '/spadework:stop asked it to';
  return null;
}

const shouldStop = (sessionId, repo) => stopReason(sessionId, repo) !== null;

// --- work item claims ---------------------------------------------------------

function listClaims({ now = Date.now() } = {}) {
  return listJsonFiles(claimsDir()).map((file) => {
    const claim = readJsonOrNull(file);
    return {
      work_item_id: Number(path.basename(file, '.json')),
      session_id: claim ? claim.session_id ?? null : null,
      repo: claim ? claim.repo ?? null : null,
      stale: ownerGone(claim, file, now),
      file,
    };
  });
}

// Claims a work item for this session. Returns { ok: false, error } when
// another run that is still working already has it.
function claim(sessionId, workItemId, repo, { now = Date.now() } = {}) {
  if (!isValidSessionId(sessionId) || numbers.workItemId(workItemId) === null) {
    return { ok: false, error: 'invalid session or work item id' };
  }
  const content = JSON.stringify({ session_id: sessionId, repo, claimed_at: new Date(now).toISOString() }) + '\n';
  return take(claimFile(workItemId), content, sessionId, {
    now,
    busy: (owner) => ({ ok: false, error: `work item ${workItemId} is being analyzed by another run${owner && owner.repo ? ` (${owner.repo})` : ''}` }),
    raced: `work item ${workItemId} was claimed by another run at the same moment`,
  });
}

// The claim on a work item, if this session holds it.
function readClaim(sessionId, workItemId) {
  const owner = readJsonOrNull(claimFile(workItemId));
  return owner && owner.session_id === sessionId ? owner : null;
}

const releaseClaim = (sessionId, workItemId) => removeIfOwnedBy(claimFile(workItemId), sessionId);

function releaseClaimsOf(sessionId) {
  for (const file of listJsonFiles(claimsDir())) removeIfOwnedBy(file, sessionId);
}

function formatTime(iso, now) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'an unknown time';
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const sameDay = date.toDateString() === new Date(now).toDateString();
  return sameDay ? time : `${date.toLocaleDateString()} ${time}`;
}

module.exports = {
  MODES, ONE_TURN_MODES, isOneTurn, isLogged, repoKey, lockFile, CUT_OFF_AFTER_MS, CUT_OFF_TEXT, isWorking, isValidSessionId, get, touch, setField, start, end, holdsLock, holdsClaim, markUnfinished,
  takeUnfinished, list, anyRun, pruneStale, readLock, listLocks, lockRepo, tookLock, unlockRepo, unlockedRepos, requestStop, stopReason, shouldStop, listClaims,
  claim, readClaim, releaseClaim, take,
};
