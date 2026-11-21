'use strict';

// The push block. While Spadework works on a branch (implement on a row, a
// merge on its integration branch), the repo's push address points at
// nothing, so a push that gets past the guard (a git hook, a script) fails:
//   fatal: Unable to find remote helper for 'spadework-run-in-progress'
// In worktree mode only the worktree is blocked (git's per-worktree
// settings), so the user can still push from the main folder. The address
// goes back when the work finishes, when the session stops, and when a
// cut-off run is recovered.
//
// Each run that turns pushing off saves its block in its own record:
// run/implementing/<row ID>.json for implement, run/merging/<repo key>.json
// for a merge. records() reads both, so one run never turns pushing back on
// while another still needs it off.

const fs = require('fs');
const path = require('path');

const paths = require('./paths');
const { readJsonOrNull, listJsonFiles } = require('./json-file');
const { writeJsonAtomic } = require('./fs-atomic');
const runs = require('./runs');
const { git, outputLines, samePath } = require('./git');

const PUSH_BLOCK = 'spadework-run-in-progress://push-is-off-while-spadework-works-on-this-branch';

// Every record in a folder: { name, file, ...its record }. name is the file
// name without .json: a row ID for implement, a repo key for a merge.
function listRecords(dir) {
  return listJsonFiles(dir).map((file) => ({ name: path.basename(file, '.json'), file, ...(readJsonOrNull(file) || {}) }));
}

// Every record that may hold a push block: implement's rows and the merges,
// each with the run mode that owns it.
const records = () => [
  ...listRecords(paths.all().implementing).map((entry) => ({ ...entry, mode: 'implement' })),
  ...listRecords(paths.all().merging).map((entry) => ({ ...entry, mode: 'merge' })),
];

const sameFile = (first, second) => Boolean(first && second) && path.resolve(first) === path.resolve(second);

// Where pushing goes off, and the push address to put back after. Only reads git.
function planPushBlock(repoPath, workspace) {
  const local = outputLines(git(repoPath, ['config', '--local', '--get-all', 'remote.origin.pushurl']));
  // A push address set for the whole repo would still apply in the worktree: block the whole repo then.
  const worktree = !samePath(repoPath, workspace) && local.length === 0;
  const dir = worktree ? workspace : repoPath;
  const scope = worktree ? '--worktree' : '--local';
  // Per-worktree settings that aren't on yet hold nothing.
  const current = worktree ? outputLines(git(dir, ['config', scope, '--get-all', 'remote.origin.pushurl'])) : local;
  // Whether Spadework turns per-worktree settings off again after this run:
  // when they're off now, or another run's worktree turned them on (the run
  // that finishes last turns them off).
  const turnedOnByARun = () => records().some((entry) => entry.push_block && entry.push_block.worktree_config
    && entry.push_block.scope === '--worktree' && samePath(entry.push_block.repo_path, repoPath));
  const block = {
    dir,
    scope,
    previous: current,
    repo_path: repoPath,
    worktree_config: worktree && (outputLines(git(repoPath, ['config', '--local', '--get', 'extensions.worktreeConfig']))[0] !== 'true' || turnedOnByARun()),
  };
  if (!current.includes(PUSH_BLOCK)) return block;
  // Pushing is still off here (the work begun again, or a cut-off run not
  // recovered yet): what to put back is what was saved when it went off.
  const earlier = records().find((entry) => entry.push_block
    && entry.push_block.scope === scope && samePath(entry.push_block.dir, dir));
  if (earlier) return { ...block, previous: earlier.push_block.previous || [], worktree_config: earlier.push_block.worktree_config };
  return { ...block, previous: current.filter((value) => value !== PUSH_BLOCK) };
}

// Saves the block with the record first, then turns pushing off. A crash in
// between leaves a record of it: recovery finds git unchanged and leaves
// it alone. The other way round, a crash would leave pushing off with no
// record, and the next run would save the dead address as the one to put back.
function blockPush(file, record, repoPath, workspace) {
  const block = planPushBlock(repoPath, workspace);
  writeJsonAtomic(file, { ...record, push_block: block });
  if (block.worktree_config) {
    const enabled = git(repoPath, ['config', '--local', 'extensions.worktreeConfig', 'true']);
    if (!enabled.ok) return { ok: false, error: enabled.error };
  }
  const set = git(block.dir, ['config', block.scope, '--replace-all', 'remote.origin.pushurl', PUSH_BLOCK]);
  return set.ok ? { ok: true } : { ok: false, error: set.error };
}

// Puts the push address back. Leaves it alone if someone changed it since.
// file: the record this block was saved in, so it doesn't count as another run.
function unblockPush(block, { file = null } = {}) {
  if (!block || !block.dir || !fs.existsSync(block.dir)) return false;
  const current = outputLines(git(block.dir, ['config', block.scope, '--get-all', 'remote.origin.pushurl']));
  if (current.length !== 1 || current[0] !== PUSH_BLOCK) return false;
  // Another run that still works has pushing off in the same place: it stays off,
  // and that run puts the address back when it finishes.
  const shared = records().some((entry) => !sameFile(entry.file, file) && entry.push_block && entry.push_block.scope === block.scope
    && entry.push_block.dir && samePath(entry.push_block.dir, block.dir) && runs.isWorking(entry.session_id, entry.mode));
  if (shared) return false;
  git(block.dir, ['config', block.scope, '--unset-all', 'remote.origin.pushurl']);
  for (const value of block.previous || []) git(block.dir, ['config', block.scope, '--add', 'remote.origin.pushurl', value]);
  // Per-worktree settings were turned on for this run: off again, unless another run's worktree uses them.
  if (block.worktree_config && block.repo_path) {
    const others = records().some((entry) => !sameFile(entry.file, file) && entry.push_block
      && entry.push_block.scope === '--worktree' && samePath(entry.push_block.repo_path, block.repo_path));
    if (!others) git(block.repo_path, ['config', '--local', '--unset', 'extensions.worktreeConfig']);
  }
  return true;
}

// When a session stops: put back the push address of its runs, implement
// and merge. Their records stay, so the next run still recovers them.
function releasePushBlocks(sessionId) {
  let released = 0;
  for (const entry of records()) {
    if (entry.session_id === sessionId && unblockPush(entry.push_block, { file: entry.file })) released++;
  }
  return released;
}

module.exports = { PUSH_BLOCK, listRecords, records, planPushBlock, blockPush, unblockPush, releasePushBlocks };
