'use strict';

// Where Spadework keeps everything the user owns. Never inside the plugin
// folder, because plugin files are replaced on every update.
// SPADEWORK_HOME overrides the location (used by tests).

const fs = require('fs');
const os = require('os');
const path = require('path');

function home() {
  const override = process.env.SPADEWORK_HOME;
  if (override && override.trim() !== '') return path.resolve(expandTilde(override.trim()));
  return path.join(os.homedir(), '.spadework');
}

function expandTilde(filePath) {
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

function all() {
  const root = home();
  const run = path.join(root, 'run');
  return {
    root,
    config: path.join(root, 'config.json'),
    configDraft: path.join(root, 'config.draft.json'),
    stack: path.join(root, 'stack.md'),
    stackDraft: path.join(root, 'stack.draft.md'),
    // What init fetched from Azure DevOps for its panel: repos and teams.
    initOptions: path.join(root, 'init-options.json'),
    run,
    sessions: path.join(run, 'sessions'),
    implementing: path.join(run, 'implementing'),
    // One file per repo while a merge runs in it: the lock and the merge's state.
    merging: path.join(run, 'merging'),
    logs: path.join(root, 'logs'),
    board: path.join(root, 'board'),
    // The key of the board's web server, and the page that opens it (it holds the key).
    boardKey: path.join(root, 'board', 'key'),
    boardOpenPage: path.join(root, 'board', 'open.html'),
    // One folder per ID prefix, one JSON file per row.
    boardRows: path.join(root, 'board', 'rows'),
    // One built graph per ID prefix: <PREFIX>.json.
    boardGraph: path.join(root, 'board', 'graph'),
    // One file per merge run, which the board reads.
    boardMerges: path.join(root, 'board', 'merges'),
    // One placement file per design (<name>.md), for the user to review before the push.
    designs: path.join(root, 'designs'),
    // The only folder triage may write files to.
    tmp: path.join(root, 'tmp'),
  };
}

// Session IDs end up in file names, so only safe characters.
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const isValidSessionId = (sessionId) => typeof sessionId === 'string' && SESSION_ID.test(sessionId);
// The session's run file. Hooks check it's there before loading anything
// else: no file, no Spadework run.
const runFile = (sessionId) => path.join(all().sessions, `${sessionId}.json`);

// Whether a folder is there, e.g. a repo's clone.
function isFolder(folder) {
  try {
    return fs.statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

module.exports = { home, all, expandTilde, isFolder, isValidSessionId, runFile };
