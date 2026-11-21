'use strict';

// Helpers the guards share: the tools a run may use, which files a tool call
// touches, whether a path is inside a folder, protected Spadework files,
// following cd through a command line, and Spadework's helper CLI.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isValidSessionId } = require('../paths');
const { sameName, tagList } = require('../config');
const { parse, program } = require('./shell');

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

// The tools triage and implement use (MCP tools are checked by each guard).
// SubagentHandback is how an agent sends its report back to the run: it
// only returns text, and without it the planners' reports never arrive.
const RUN_TOOLS = new Set(['Bash', 'PowerShell', 'Read', 'Grep', 'Glob', 'LS', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'NotebookRead',
  'WebFetch', 'WebSearch', 'Agent', 'Task', 'Skill', 'ToolSearch', 'AskUserQuestion', 'TodoWrite', 'TodoRead',
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'BashOutput', 'KillShell', 'TaskOutput', 'TaskStop', 'SubagentHandback']);

// The plugin's own folder (the hook runs from it).
const pluginRoot = () => process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..', '..');
// Where Claude Code saves big tool results (they're read back with Read).
const claudeProjects = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');

// A file Claude Code saved for this chat: projects/<project>/<session>/...
// (big tool results are read back from there). Never another chat's
// transcript or files: they can hold anything.
function isOwnSessionFile(file, sessionId) {
  if (!isValidSessionId(sessionId)) return false;
  const root = claudeProjects();
  if (!isInside(file, root)) return false;
  const parts = path.relative(norm(root), norm(file)).split(/[\\/]/);
  return parts.length >= 3 && parts[1].toLowerCase() === sessionId.toLowerCase();
}

// The files a file tool call writes, as absolute paths.
function writtenFiles(toolInput, cwd) {
  const input = toolInput || {};
  const found = [input.file_path, input.notebook_path, input.path];
  for (const edit of Array.isArray(input.file_edits) ? input.file_edits : []) found.push(edit && edit.file_path);
  for (const edit of Array.isArray(input.edits) ? input.edits : []) found.push(edit && edit.file_path);
  return found.filter((value) => typeof value === 'string' && value.trim() !== '').map((value) => path.resolve(cwd || process.cwd(), value));
}

// The paths a Read, Grep or Glob call looks at (the current folder when none is given).
function readPaths(toolInput, cwd) {
  const input = toolInput || {};
  const found = [input.file_path, input.path].filter((value) => typeof value === 'string' && value.trim() !== '');
  return (found.length ? found : ['.']).map((value) => path.resolve(cwd || process.cwd(), value));
}

// A path written in a command, with ~ and the home folder variables
// expanded. null when it still holds a variable: nobody can tell where
// "$TARGET/x" points before it runs.
function expandPath(target, cwd) {
  let value = String(target || '').trim();
  value = value.replace(/^~(?=$|[\\/])/, os.homedir());
  value = value.replace(/^(\$HOME|\$\{HOME\}|\$env:USERPROFILE|\$env:HOME|%USERPROFILE%)(?=$|[\\/])/i, os.homedir());
  if (/[$%`]/.test(value)) return null;
  return path.resolve(cwd || process.cwd(), value);
}

// A network path (\\server\share, //server/share) or a device path
// (\\?\..., \\.\...). The guards never touch these: looking one up makes
// Windows contact that server, which can leak the user's login hash.
// Slashes followed by nothing or a space name no server: grep -v "///", "// TODO".
const isNetworkPath = (value) => /^["']?(\\\\|\/\/)(?![\\/]*["']?(\s|$))/.test(String(value || '').trim());

// A Windows alternate data stream (config.json::$DATA, a.txt:hidden): the
// same file under another name. A colon after the drive letter is one.
const hasStream = (value) => String(value || '').replace(/^["']?[a-z]:/i, '').includes(':');

// The real path when it exists (or its nearest existing parent's, plus the
// rest), so symlinks and 8.3 short names compare correctly. Windows drops
// trailing dots and spaces from names (config.json. is config.json).
function realish(target) {
  if (isNetworkPath(target)) return String(target);
  let current = path.resolve(target);
  if (process.platform === 'win32') {
    const { root: drive } = path.parse(current);
    current = drive + current.slice(drive.length).split(path.sep).map((part) => part.replace(/[. ]+$/, '') || part).join(path.sep);
  }
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

// A path in the one form used to compare paths: its real path, no trailing
// slash, lowercase where the file system ignores case.
const caseless = process.platform === 'win32' || process.platform === 'darwin';
const norm = (value) => {
  const resolved = realish(value).replace(/[\\/]+$/, '');
  return caseless ? resolved.toLowerCase() : resolved;
};

// Whether target is folder or inside it.
function isInside(target, folder) {
  if (!folder) return false;
  const child = norm(target);
  const parent = norm(folder);
  return child === parent || child.startsWith(parent + path.sep) || child.startsWith(`${parent}/`);
}

// Files in ~/.spadework that a triage or implement run must never change
// with its tools: a work item's text could otherwise talk Claude into it.
// - the settings (config, stack): could switch a guard off
// - run/ (run files, locks, claims): rewriting its own run file ends or
//   weakens the guards
// - logs/
// - board/: the rows. Only Spadework's helper writes them
// - designs/: the placement files the user reviews before a push
// Spadework's helper still writes them: it runs as a program, not a tool.
const SETTINGS = /^config(\.draft)?\.json(\.bak)?$|^stack(\.draft)?\.md$/i;
function isProtected(file, home) {
  if (!isInside(file, home)) return false;
  if (hasStream(file)) return true;
  if (['run', 'logs', 'board', 'designs'].some((folder) => isInside(file, path.join(home, folder)))) return true;
  // The real long name: CONFIG~1.JSO is config.json.
  const real = realish(file);
  return norm(path.dirname(real)) === norm(home) && SETTINGS.test(path.basename(real));
}

// board/ holds the key of the board's web server: with it a run could edit
// any row. No run reads that folder; the helper reads the rows itself.
const isBoardFile = (file, home) => isInside(file, path.join(home, 'board'));

// Files that make Claude Code or git run commands or load instructions:
// project settings and hooks (.claude/), CLAUDE.md, MCP servers, git config
// and hooks. A Claude session started in that folder (a scheduled triage in
// ~/.spadework) or a git command there would obey them, with no guard.
const CONFIG_NAMES = /^(\.claude|\.git|\.mcp\.json|claude(\.local)?\.md|\.gitconfig|\.gitattributes|\.gitmodules)$/i;
// Of those, the ones that run code as soon as Claude Code opens the folder:
// project settings and hooks, and MCP servers.
const CLAUDE_CODE_NAMES = /^(\.claude|\.mcp\.json)$/i;
function hasNamedPart(file, root, names) {
  return [path.resolve(file), realish(file)].some((full) => path.relative(path.resolve(root), full)
    .split(/[\\/]/)
    .some((part) => names.test(part.replace(/[. ]+$/, '') || part)));
}
const isConfigFile = (file, root) => hasNamedPart(file, root, CONFIG_NAMES);
const isClaudeCodeConfig = (file, root) => hasNamedPart(file, root, CLAUDE_CODE_NAMES);

// --- the current folder -------------------------------------------------------

// Commands that change the folder the rest of the line runs in.
const CD = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location']);
const CD_UNKNOWN = new Set(['popd', 'pop-location']);

// The folder after a cd: { cwd } (unchanged when it isn't a cd), or
// { unknown: true } when it can't be told (a variable, cd -, popd).
function nextCwd(name, args, cwd) {
  if (CD_UNKNOWN.has(name)) return { unknown: true };
  if (!CD.has(name)) return { cwd };
  const targets = [];
  for (let i = 0; i < args.length; i++) {
    if (/^-(path|literalpath)$/i.test(args[i])) {
      if (args[i + 1] !== undefined) targets.push(args[++i]);
    } else if (!/^-/.test(args[i])) targets.push(args[i]);
  }
  if (args.includes('-')) return { unknown: true };
  if (!targets.length) return { cwd: os.homedir() };
  if (isNetworkPath(targets[0])) return { unknown: true };
  const next = expandPath(targets[0], cwd);
  return next === null ? { unknown: true } : { cwd: next };
}

// Checks each command of a Bash or PowerShell call, from the folder it runs
// in (cd is followed). check(command, cwd) returns a reason to block, or null.
// Returns the first reason, or null.
function checkEachCommand(tool, toolInput, cwd, check) {
  let current = cwd;
  for (const command of parse(toolInput.command, { powershell: tool === 'PowerShell' })) {
    const reason = check(command, current);
    if (reason) return reason;
    const { name, args } = program(command.words, command);
    const next = nextCwd(name, args, current);
    if (next.unknown) return `${name} to a folder that can't be checked`;
    current = next.cwd;
  }
  return null;
}

// A redirect that writes no file: input (<), into another stream (2>&1),
// or to the null device.
function writesNoFile(redirect) {
  const target = redirect.target.trim();
  return !redirect.op.includes('>') || /^&\d*-?$/.test(target) || /^(\/dev\/null|nul|\$null)$/i.test(target);
}

// A check setting that may be a function, read only when a check needs it.
const lazy = (value) => (typeof value === 'function' ? value() : value);

// mcp__<server>__<tool> → <tool>. Server names may hold underscores.
function mcpTool(toolName) {
  const name = String(toolName || '');
  if (!name.startsWith('mcp__')) return null;
  const index = name.lastIndexOf('__');
  return index > 3 ? name.slice(index + 2) : null;
}

// The desktop app's own tools: they only draw its task list and next-step box.
const APP_TOOLS = new Set(['mcp__ccd_turn__update_plan', 'mcp__ccd_turn__wrap_up']);

// The Azure DevOps reads the run skills make, per tool. Each guard allows
// its own subset, and only in a configured project: `project` is required,
// since without it a get reads at organization scope. A get by ID can still
// return an item of another project: the helper's scope queries (the
// in_backlog answer of triage start) stay the gate for that.
const ADO_READS = { wit_work_item: ['get', 'get_batch', 'list_comments'], wit_query: ['wiql'], repo_pull_request: ['get'] };

// Returns a reason to block an Azure DevOps tool's action, or null.
// reads: { <tool>: [actions], or null for a tool with no actions }.
function checkAdoAction(mcp, toolInput, reads) {
  const actions = reads[mcp];
  if (actions === null) return null;
  if (!actions) return `it can't use ${mcp}`;
  const action = String(toolInput.action || '');
  if (!actions.includes(action)) return `${mcp} ${action || 'without an action'} isn't used in this run (only ${actions.join(', ')})`;
  return null;
}

// Returns a reason to block an Azure DevOps read, or null.
// reads: { <tool>: [actions] }; projects: the configured project names.
function checkAdoRead(mcp, toolInput, reads, projects) {
  const wrong = checkAdoAction(mcp, toolInput, reads);
  if (wrong) return wrong;
  const project = String(toolInput.project || '');
  if (!(projects || []).some((name) => sameName(name, project))) {
    return `${mcp} reads only the configured projects (${(projects || []).join(', ') || 'none'}), with project set, not ${project || 'nothing'}`;
  }
  return null;
}

// A wit_work_item_write update that only adds tags: every tag one of
// allowed, every one of required there, and nothing else changed but a
// /rev test. Returns a reason to block, or null.
function checkTagOps(toolInput, allowed, required) {
  const tagsOk = (value) => {
    const tags = tagList(value);
    return tags.length > 0 && tags.every((tag) => allowed.some((name) => sameName(name, tag))) && required.every((name) => tags.some((tag) => sameName(tag, name)));
  };
  const updates = Array.isArray(toolInput.updates) ? toolInput.updates : [];
  const ok = updates.length > 0 && updates.every((update) => {
    const field = String(update.path || '').toLowerCase();
    if (field === '/rev') return String(update.op || '').toLowerCase() === 'test';
    return field === '/fields/system.tags' && String(update.op || '').toLowerCase() === 'add' && tagsOk(update.value);
  }) && updates.some((update) => String(update.path || '').toLowerCase() === '/fields/system.tags');
  return ok ? null : `the only change allowed on a work item it created is the tags "${allowed.join('; ')}"`;
}

// --- Spadework's helper CLI -----------------------------------------------------

// For `node <script> ...`: the helper's arguments when the script is this
// plugin's own scripts/spadework.js, false for any other script (a repo
// could ship its own scripts/spadework.js), null when it isn't node.
// cwd: the folder the command runs in (a relative script path is relative to it).
function spadeworkCli(name, args, cwd) {
  if (name !== 'node') return null;
  const script = args[0] || '';
  if (!/(^|[\\/])spadework\.js$/i.test(script)) return false;
  const resolved = expandPath(script, cwd);
  return resolved !== null && norm(resolved) === norm(path.join(pluginRoot(), 'scripts', 'spadework.js')) ? args.slice(1) : false;
}

// What PowerShell needs to chain helper calls: if ($?) { ... }, if ($LASTEXITCODE -eq 0).
// $SUB stands for the { } block, whose commands are checked on their own.
const CHAIN_WORDS = /^(if|\$\?|\$LASTEXITCODE|-eq|0|\$SUB)$/i;

// A Bash or PowerShell call that runs nothing but Spadework's own helper
// (handoff, init). checkArgs(cliArgs) checks what the call asks the helper.
// Returns the first reason to block, or null.
function checkHelperOnly(tool, toolInput, cwd, mode, checkArgs) {
  return checkEachCommand(tool, toolInput, cwd, (command, commandCwd) => {
    // The helper's input comes in a heredoc (<<'EOF'); any other redirect could touch a file.
    if (command.redirects.some((redirect) => redirect.op !== '<<')) return 'it can\'t write to or read from a file';
    const { name, args, pathed } = program(command.words, command);
    // run start; if ($?) { handoff plan }: the if and its test only chain helper calls.
    if (!name && command.words.every((word) => CHAIN_WORDS.test(word))) return null;
    if (pathed || name !== 'node') return 'the only command it runs is Spadework\'s own helper';
    const cli = spadeworkCli(name, args, commandCwd);
    if (!cli) return `only Spadework's own helper runs with node during ${mode}`;
    return checkArgs(cli);
  });
}

// What a triage or implement run may ask the helper. It may not end its own
// run, start another kind of run, or touch another session's run: that
// would switch the guards off. Setup (init) belongs to init.
// Returns a reason to block, or null.
function checkCli(cliArgs, { mode, sessionId, allowed }) {
  const [sub = '', action = ''] = cliArgs.map((arg) => String(arg).toLowerCase());
  // Locks, claims and logs only for this chat's own session.
  for (let i = 0; i < cliArgs.length; i++) {
    const match = String(cliArgs[i]).match(/^--session(?:=(.*))?$/);
    if (!match) continue;
    const value = match[1] !== undefined ? match[1] : cliArgs[i + 1];
    if (value !== sessionId) return `spadework.js --session ${value || ''} isn't this chat's session: a run only works with its own locks, claims and logs`;
  }
  if (sub === 'run') {
    if (action === 'list') return null;
    if ((action === 'start' || action === 'check') && cliArgs[2] === mode && cliArgs[3] === sessionId) return null;
    return `spadework.js run ${action} would end or change this ${mode} run, which would switch its safety checks off`;
  }
  if (sub === 'init') return `spadework.js ${sub} changes Spadework's settings, which only /spadework:init does`;
  if (!allowed.has(sub)) return `spadework.js ${sub || '(no command)'} isn't used by ${mode} runs`;
  return null;
}

module.exports = {
  isNetworkPath, hasStream, FILE_TOOLS, READ_TOOLS, SHELL_TOOLS, RUN_TOOLS, pluginRoot, claudeProjects, isOwnSessionFile, writtenFiles, readPaths,
  expandPath, isInside, isProtected, isBoardFile, isConfigFile, isClaudeCodeConfig, mcpTool, APP_TOOLS, ADO_READS, checkAdoAction, checkAdoRead, norm, realish, spadeworkCli, checkCli,
  checkHelperOnly, checkEachCommand, writesNoFile, lazy, checkTagOps,
};
