'use strict';

// init-guard: the init chat reads text it can't trust (names from Azure
// DevOps, a repo's files), so none of it can make init change anything.
// It allows only the tools init uses, and denies every other one, including
// tools Claude Code adds later:
// - files: it writes only init-options.json, with Write. The hand-edit
//   drafts are the user's: init save runs from a terminal. The settings page
//   saves config.json and stack.md through the helper, which runs as a
//   program, so these rules don't apply to it
// - shell: only Spadework's own helper (init state, init panel and this chat's run)
// - never the board's key, or the page that opens the board with it
// - Azure DevOps: only the reads init makes. The project can't
//   be checked (a first run has none configured): only the actions are.
// Anything the user says during setup goes in the config or the stack
// notes, not in Claude's memory, settings, the repos or Spadework's own files.

const path = require('path');
const paths = require('../paths');
const {
  READ_TOOLS, SHELL_TOOLS, writtenFiles, readPaths, isOwnSessionFile, isInside, hasStream, norm, mcpTool, APP_TOOLS,
  expandPath, checkAdoAction, checkEachCommand, checkHelperOnly,
} = require('./common');

// The tools besides files, shell and Azure DevOps that init may use. None acts:
// - AskUserQuestion: its questions (which projects, which teams)
// - ToolSearch: loads the Azure DevOps tools' schemas when the client defers them
// - the to-do list (TodoWrite, Task*) and the desktop app's task list and
//   next-step box (APP_TOOLS): they only draw
const TOOLS = new Set(['AskUserQuestion', 'ToolSearch', 'TodoWrite', 'TodoRead', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);
// What init asks the helper besides its run.
const CLI_ALLOWED = new Set(['init state', 'init panel']);
// The Azure DevOps MCP's tools, by family (mcp__<server>__wit_work_item...).
const ADO_TOOL = /^(core|wit|repo|work|wiki|search|pipelines|testplan|advsec)(_|$)/;
// The reads init makes (projects, repos, teams, a team's area paths). null: a tool with no actions.
const READS = {
  core_list_projects: null,
  core_list_project_teams: null,
  repo_repository: ['list', 'get'],
  work: ['get_team_settings'],
};

const deny = (reason) => `Spadework init: ${reason}.`;
// How a chat that left init open gets its tools back.
const endFirst = (sessionId) => ` If setup is over or the user asked for something else, end init first: spadework.js run end ${sessionId}.`;
const KEY = 'it never reads the board\'s key or the page that holds it';

// The run commands of this chat's own init run, and init's own commands.
function checkCli(cliArgs, sessionId) {
  const [sub = '', action = ''] = cliArgs.map((arg) => String(arg).toLowerCase());
  if (sub === 'run') {
    if (action === 'start' && cliArgs[2] === 'init' && cliArgs[3] === sessionId) return null;
    if (action === 'end' && cliArgs[2] === sessionId) return null;
    return `spadework.js run ${action} works only to start or end this chat's init run`;
  }
  return CLI_ALLOWED.has(`${sub} ${action}`) ? null : `spadework.js ${`${sub} ${action}`.trim() || '(no command)'} isn't used by init`;
}

// Whether target is the board's key or the page that holds it (key::$DATA
// is the key under another name). folder: a folder holding them counts too.
function namesKey(target, home, folder) {
  const all = paths.all();
  const board = path.join(home, path.relative(all.root, all.board));
  const secrets = [all.boardKey, all.boardOpenPage].map((file) => path.join(home, path.relative(all.root, file)));
  return (hasStream(target) && isInside(path.dirname(target), board))
    || secrets.some((secret) => (folder ? isInside(secret, target) : norm(target) === norm(secret)));
}

// Whether a Read, Grep or Glob call reaches the key. Grep reads every file
// in a folder it's given; Glob only names files.
function readsKey(tool, toolInput, cwd, home) {
  const targets = readPaths(toolInput, cwd);
  if (tool === 'Glob' && typeof toolInput.pattern === 'string') targets.push(path.resolve(targets[0], toolInput.pattern));
  return targets.some((target) => namesKey(target, home, tool === 'Grep'));
}

// Whether a shell call names the key (cat, type, Get-Content...), so it gets
// that reason rather than "only the helper". The helper check blocks it anyway.
function shellNamesKey(tool, toolInput, cwd, home) {
  // Its other reasons (a cd that can't be followed) are the helper check's to give.
  return checkEachCommand(tool, toolInput, cwd, (command, commandCwd) => {
    const targets = [...command.words, ...command.redirects.map((redirect) => redirect.target)].map((word) => expandPath(word, commandCwd));
    return targets.some((target) => target !== null && namesKey(target, home, false)) ? KEY : null;
  }) === KEY;
}

// Returns a reason to block, or null. ctx: { home, sessionId }
function check(input, { home = paths.home(), sessionId } = {}) {
  const tool = input.tool_name || '';
  const toolInput = input.tool_input || {};
  const cwd = input.cwd || process.cwd();

  if (TOOLS.has(tool) || APP_TOOLS.has(tool)) return null;
  if (tool === 'Write') {
    const options = norm(path.join(home, path.basename(paths.all().initOptions)));
    const other = writtenFiles(toolInput, cwd).find((file) => norm(file) !== options && !isOwnSessionFile(file, sessionId));
    return other ? `Spadework init writes only init-options.json in ${home}. The settings page saves config.json and stack.md.${endFirst(sessionId)}` : null;
  }
  // The key is never read, in init or after it: no way out to point to.
  if (READ_TOOLS.has(tool)) return readsKey(tool, toolInput, cwd, home) ? deny(KEY) : null;
  if (SHELL_TOOLS.has(tool)) {
    if (shellNamesKey(tool, toolInput, cwd, home)) return deny(KEY);
    const reason = checkHelperOnly(tool, toolInput, cwd, 'init', (cli) => checkCli(cli, sessionId));
    return reason ? deny(reason) + endFirst(sessionId) : null;
  }
  const mcp = mcpTool(tool);
  if (mcp !== null && ADO_TOOL.test(mcp)) {
    const reason = checkAdoAction(mcp, toolInput, READS);
    return reason ? deny(reason) + endFirst(sessionId) : null;
  }
  return deny(`it doesn't use ${tool || 'a tool with no name'}`) + endFirst(sessionId);
}

module.exports = { check, CLI_ALLOWED };
