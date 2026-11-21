'use strict';

// git for Spadework's own steps: run without prompts (a check must fail,
// not wait for a password), its output as lines, and paths compared the
// way the file system sees them.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const NETWORK_TIMEOUT_MS = 60 * 1000;

// Returns { ok, status, stdout } or { ok: false, status, stdout, error, missing }
// (missing = git not installed). status is git's exit code, or null when git
// didn't run to the end: a caller can tell "no" (exit 1) from a real failure.
// trim: false keeps leading spaces, which git status --porcelain needs (" M a.txt").
function git(cwd, args, { timeout = 15 * 1000, trim = true } = {}) {
  const clean = (text) => (trim ? text.trim() : text.replace(/\s+$/, ''));
  try {
    const stdout = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      windowsHide: true,
    });
    return { ok: true, status: 0, stdout: clean(stdout) };
  } catch (err) {
    const stderr = (err.stderr || '').toString().trim();
    const message = err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM'
      ? 'timed out'
      : (stderr.split('\n').filter(Boolean).pop() || err.message);
    return {
      ok: false,
      status: typeof err.status === 'number' ? err.status : null,
      stdout: clean((err.stdout || '').toString()),
      error: message,
      missing: err.code === 'ENOENT',
    };
  }
}

// Brings origin/<branch> up to date. Never pulls or merges. The branch name is
// checked by the caller (config.isBranchName): after "--" git still reads "a:b" as a refspec.
const fetchBranch = (cwd, branch) => git(cwd, ['fetch', '--quiet', 'origin', '--', branch], { timeout: NETWORK_TIMEOUT_MS });

// Whether the value looks like a commit hash, short or full.
const isCommit = (value) => /^[0-9a-f]{7,40}$/i.test(String(value || ''));

// Whether the repo has a local branch with this name.
const localBranchExists = (cwd, name) => git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]).ok;

// A test merge of theirs into ours, in memory: no file and no branch changes.
// Returns { ok: true, clean, tree, files }: the merged tree, and the files in
// conflict when it isn't clean. { ok: false, error } when git couldn't merge
// at all. Needs Git 2.38.
function mergeTree(cwd, ours, theirs) {
  const result = git(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', ours, theirs]);
  const [tree = '', ...files] = String(result.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
  // Exit 1 is a conflict only when git still printed the tree: a name it can't
  // merge (a branch that doesn't exist) exits 1 too, with nothing printed.
  if ((result.status !== 0 && result.status !== 1) || !/^[0-9a-f]{40,64}$/.test(tree)) return { ok: false, error: result.error || 'git merge-tree printed no tree' };
  return { ok: true, clean: result.status === 0, tree, files: result.status === 0 ? [] : files };
}

// The first Git that has merge-tree --write-tree, which mergeTree needs.
const MERGE_TREE_GIT = '2.38';
// Whether a Git version ({ major, minor }, from version()) can do the test merge.
function hasMergeTree(found) {
  const [major, minor] = MERGE_TREE_GIT.split('.').map(Number);
  return Boolean(found) && (found.major > major || (found.major === major && found.minor >= minor));
}

// The installed Git version as { major, minor }, or null when it can't be read.
function version() {
  const result = git(process.cwd(), ['--version']);
  const match = result.ok ? result.stdout.match(/(\d+)\.(\d+)/) : null;
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
}

// A git result's output as lines: none when the command failed or printed
// nothing. trim: false keeps leading spaces, which git status --porcelain needs.
function outputLines(result, { trim = true } = {}) {
  if (!result.ok || !result.stdout) return [];
  const lines = result.stdout.split('\n');
  return (trim ? lines.map((line) => line.trim()) : lines).filter(Boolean);
}

// Real paths, so Windows short names (PROGRA~1) and symlinks compare equal.
function samePath(first, second) {
  const normalize = (value) => {
    let resolved = path.resolve(value);
    try {
      resolved = fs.realpathSync.native(resolved);
    } catch { /* keep the resolved path */ }
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(first) === normalize(second);
}

// The top folder of the git checkout a folder is in, or null outside one.
function topLevel(folder) {
  const top = git(folder, ['rev-parse', '--show-toplevel']);
  return top.ok && top.stdout ? path.resolve(top.stdout) : null;
}

// The configured origin URL. Not `git remote get-url`, which applies insteadOf rules.
function originUrl(cwd) {
  const result = git(cwd, ['config', '--get', 'remote.origin.url']);
  return result.ok && result.stdout ? result.stdout : null;
}

module.exports = { git, topLevel, fetchBranch, isCommit, localBranchExists, mergeTree, version, hasMergeTree, MERGE_TREE_GIT, outputLines, samePath, originUrl, NETWORK_TIMEOUT_MS };
