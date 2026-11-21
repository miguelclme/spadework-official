'use strict';

// Graphify is optional. Spadework never builds or updates a graph during a run:
// it only reads one the user built, and tells them how to build or refresh it.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('./config');
const stack = require('./stack');

// Graphify writes its output here, inside the folder it was run in.
const OUTPUT_DIR = 'graphify-out';

// The read-only commands an agent may run on a graph.
const QUERIES = new Set(['query', 'path', 'explain']);

// The installed version, or null if the command isn't available.
// On Windows it runs through the shell, which finds graphify.cmd launchers
// too. The command is fixed text: passed as one string, Node doesn't warn
// about unescaped arguments.
function version() {
  const options = { encoding: 'utf8', timeout: 15 * 1000, windowsHide: true };
  const result = process.platform === 'win32'
    ? spawnSync('graphify --version', { ...options, shell: true })
    : spawnSync('graphify', ['--version'], options);
  if (result.error || result.status !== 0) return null;
  return ((result.stdout || result.stderr || '').trim().split('\n')[0]) || 'unknown version';
}

// The repo's graph file, or null if it has none.
function graphFile(repoPath) {
  const file = path.join(repoPath, OUTPUT_DIR, 'graph.json');
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

// The command that builds the first graph or brings it up to date (code only,
// no model calls). It is only printed for the user: Spadework never runs it.
function buildCommand(repoPath) {
  return `cd "${repoPath}" && graphify extract . --code-only`;
}

// The repo's graph when agents may query it (`graph` is the repo folder), or
// `graph_hint`: why not, and how to fix it. `installed` comes from the caller,
// since checking it runs a command. `fallback` says what searched instead.
// missingHint: false leaves out the hint for a repo with no graph yet.
function forRepo({ path: repoPath, label }, enabled, installed, fallback, { missingHint = true } = {}) {
  if (!enabled) return { graph: null, graph_hint: null };
  if (!installed) return { graph: null, graph_hint: `graphify is turned on but not installed, so ${fallback}. Run /spadework:validate.` };
  if (!graphFile(repoPath)) {
    return { graph: null, graph_hint: missingHint ? `${label} has no code graph, so ${fallback}. Build one (it can take a few minutes): ${buildCommand(repoPath)}` : null };
  }
  return { graph: repoPath, graph_hint: null };
}

// What an agent is told about the graph. `search` is the text search it
// falls back to, `confirm` where it reads what the graph points to.
function promptText(graphPath, { search, confirm }) {
  return `A code graph of this repo is at \`${graphPath}\`. You must start every search with it, never with ${search}, to find the files and functions, with \`cd "${graphPath}" && graphify query "<question>"\`, \`graphify explain "<name>"\` or \`graphify path "<a>" "<b>"\`. Use ${search} only after a graph query that didn't find what you need. It was built from the folder on disk and may be out of date, so read what it points to ${confirm}. Never build or update it.`;
}

// The graph of the configured repo a folder belongs to, for /spadework:debug:
// { repo, graph, graph_hint, text }, with `text` what the agent is told, or ''.
// The graph is the repo folder's, also for a worktree: its paths are relative,
// so the agent reads them in the checkout it runs in, where the error is.
function forFolder(folder = process.cwd(), { installed = () => Boolean(version()) } = {}) {
  const loaded = config.load({ checkPaths: false });
  const found = loaded.ok ? stack.repoInFolder(folder, loaded.config.repos) : null;
  if (!found) return { repo: null, graph: null, graph_hint: null, text: '' };
  const label = config.repoLabel(found.repo);
  const { enabled } = loaded.config.graphify;
  const graph = forRepo({ path: found.repo.path, label }, enabled, enabled && installed(), 'debug searched the files directly');
  const confirm = `in the files under \`${found.top}\`: its paths are relative to the repo`;
  return { repo: label, ...graph, text: graph.graph ? promptText(graph.graph, { search: 'a text search', confirm }) : '' };
}

// A `git status --porcelain` line about graphify's output folder.
function isOutputLine(line) {
  const file = line.slice(3).replace(/^"/, '');
  return file === `${OUTPUT_DIR}/` || file.startsWith(`${OUTPUT_DIR}/`);
}

module.exports = { version, graphFile, buildCommand, forRepo, forFolder, promptText, isOutputLine, QUERIES };
