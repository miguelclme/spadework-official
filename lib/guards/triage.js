'use strict';

// triage-guard: in triage runs (including /spadework:re-triage), Spadework
// may read code and work items, nothing else. The board's rows are written
// only by Spadework's helper, which runs as a program, not as a tool:
// - files: written only inside ~/.spadework/tmp, never anything that could
//   be run as a program, nor Claude Code or git settings (.claude, CLAUDE.md, .git),
//   nor the files the helper owns there. The planner agents write one file
//   only: tmp/plan-<id>.md, for an item this run claimed; nobody else writes one
// - reading (Read, Grep, Glob and shell commands, < included): only the
//   configured repos, ~/.spadework (never its board/, which holds the board's
//   key), the plugin, Claude Code's saved tool results and the temp folder;
//   never stored credentials or environment variables
// - shell: only read-only commands (an allow-list), run by name; git only
//   in the configured repos; cd is followed; Spadework's helper only for
//   what triage uses (it can't end or change its own run)
// - MCP: only the Azure DevOps reads triage uses (work items, and a Bug's
//   linked pull request), the one state move when it's on (and its move
//   back), and the desktop app's task list tools
// - web: only when triage.web_research is on, and only the web researcher
//   searches or opens pages (it never sees the work item). No secrets or
//   personal data in a search or in its questions; pages opened only if
//   a search in the run returned their exact address

const os = require('os');
const path = require('path');

const { readJsonOrNull } = require('../json-file');
const runs = require('../runs');
const { program, envSets, gitSubcommand } = require('./shell');
const { checkCommandReads, checkReadPath, checkReadTool } = require('./reads');
const { QUERIES } = require('../graphify');
const { TRIAGE_TAG } = require('../config');
const {
  FILE_TOOLS, READ_TOOLS, SHELL_TOOLS, writtenFiles, expandPath, isInside, isProtected, isBoardFile, isConfigFile, mcpTool, APP_TOOLS, ADO_READS, checkAdoRead,
  spadeworkCli, checkCli, pluginRoot, isOwnSessionFile, isNetworkPath, norm, realish, checkEachCommand, writesNoFile, lazy,
} = require('./common');

// Helper subcommands the triage skills use.
const CLI_ALLOWED = new Set(['triage', 'recover', 'stack', 'config', 'paths', 'run']);
// The agents that write their answer to a file.
const PLANNER_AGENTS = /(^|:)(feature-planner|bug-triager)$/;
const RESEARCHER_AGENT = /(^|:)web-researcher$/;
const PLAN_FILE = /^plan-(\d+)\.md$/;

// Programs that only read. Not here, because they can write or run other
// programs: sed (w and e commands), uniq (writes its 2nd argument), tree
// (-o), less and more (shell escapes), awk, xargs, tee.
const READ_ONLY = new Set([
  'cd', 'pwd', 'ls', 'dir', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'findstr', 'sort', 'cut', 'tr',
  'echo', 'printf', 'true', 'false', 'test', '[', 'basename', 'dirname', 'realpath', 'readlink', 'which', 'where', 'file', 'stat',
  'du', 'diff', 'cmp', 'jq', 'column', 'nl', 'find', 'date', 'type',
  // PowerShell
  'get-content', 'gc', 'select-string', 'sls', 'get-childitem', 'gci', 'test-path', 'resolve-path', 'measure-object', 'measure',
  'select-object', 'select', 'where-object', 'where', 'sort-object', 'format-list', 'fl', 'format-table', 'ft', 'out-string',
  'convertfrom-json', 'convertto-json', 'write-output', 'write-host', 'get-location', 'gl', 'set-location', 'sl', 'get-item', 'gi',
  'split-path', 'join-path', 'get-command',
]);
// Options that make an otherwise read-only program write files, run others
// or read files it isn't given as arguments (date -f prints a file's lines).
const BAD_OPTIONS = {
  rg: /^(--pre|--pre-glob|--hostname-bin|-z|--search-zip)(=|$)/,
  sort: /^(-o|--output|--compress-program)(=|$)|^-o./,
  date: /^(-s|--set|-f|--file|-r|--reference)(=|$)|^-[sfr]./,
  find: /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/,
  diff: /^--to-file/,
  jq: /^(--rawfile|--slurpfile|-L|--library-path|-f|--from-file)(=|$)/,
};
// jq programs that read the environment or other files (a program in a
// file, -f, isn't seen here, so that option is refused above).
const JQ_READS = /\benv\b|\$ENV|input_filename|\$__loc__|\bimport\b|\binclude\b/;
// .NET types a PowerShell expression may call during triage: none of them
// read files, the environment or the network.
const SAFE_TYPES = /^\[(system\.)?(math|string|int|int32|int64|long|double|decimal|bool|char|regex|datetime|timespan|guid|convert|text\.regularexpressions\.regex)\]::/i;

const GIT_READ = new Set([
  'grep', 'show', 'log', 'diff', 'status', 'rev-parse', 'ls-tree', 'ls-files', 'ls-remote', 'blame', 'annotate', 'cat-file',
  'describe', 'shortlog', 'rev-list', 'merge-base', 'name-rev', 'for-each-ref', 'show-ref', 'whatchanged', 'version', 'help',
  'diff-tree', 'diff-files', 'diff-index', 'check-ignore', 'check-attr', 'range-diff', 'cherry', 'count-objects', 'var',
]);
// Options that make git run another program (or set up one to run, like
// clone's hook templates). Implement refuses them too.
const GIT_RUNS_PROGRAM = ['--upload-pack', '--receive-pack', '--exec', '--ext-diff', '--extcmd', '--open-files-in-pager', '--template', '--config'];
// Their one-letter forms, per command: the same letter means something else
// in other commands (git add -u).
const GIT_RUNS_PROGRAM_SHORT = { grep: 'O', rebase: 'x', difftool: 'x', clone: 'uc', 'ls-remote': 'u' };
// Options that write a file or read outside the repo, even on read commands
// (-O<file> reads an order file).
const GIT_WRITES_OR_READS_OUT = ['--output', '--to-file', '--no-index', '--run'];

// Whether a git argument is one of these options. git takes any unambiguous
// start of a long option (--upload-p), so a start counts too.
function isGitOption(sub, arg, long, short = {}) {
  const name = arg.split('=')[0];
  if (name.startsWith('--')) return name.length > 2 && long.some((option) => option.startsWith(name));
  return /^-[A-Za-z]/.test(arg) && [...(short[sub] || '')].some((letter) => arg.slice(1).includes(letter));
}
const runsProgram = (sub, arg) => isGitOption(sub, arg, GIT_RUNS_PROGRAM, GIT_RUNS_PROGRAM_SHORT);
const writesOrReadsOut = (sub, arg) => /^-O/.test(arg) || isGitOption(sub, arg, GIT_WRITES_OR_READS_OUT);
const BRANCH_LIST_OPTIONS = /^(-a|-r|-v|-vv|-l|--list|--all|--remotes|--show-current|--contains|--no-contains|--merged|--no-merged|--points-at|--sort=.*|--format=.*|--color.*|--no-color|--column.*|--abbrev.*)$/;
const TAG_LIST_OPTIONS = /^(-l|--list|-n\d*|--sort=.*|--contains|--no-contains|--merged|--no-merged|--points-at)$/;
// Options git documents as "implies --list": git branch and git tag create nothing.
const LIST_MODE = /^(-l|--list|--contains|--no-contains|--merged|--no-merged|--points-at)$/;
// git config, remote and worktree in their read-only forms, for both
// guards. Returns null when the command only reads, 'other-settings' when
// git config would read a settings file other than the repo's own (--file,
// --global, an include), or 'change' for any form that changes something.
const CONFIG_OTHER_FILE = /^(--file|-f|--blob|--global|--system|--includes)(=|$)/;
const CONFIG_READ = /^(--get|--get-all|--get-regexp|--list|-l)$/;
const CONFIG_WRITE = /^(--add|--unset|--unset-all|--replace-all|--rename-section|--remove-section|-e|--edit)$/;
function gitChange(sub, rest) {
  const positional = rest.filter((arg) => !arg.startsWith('-'));
  if (sub === 'config') {
    if (rest.some((arg) => CONFIG_OTHER_FILE.test(arg))) return 'other-settings';
    return rest.some((arg) => CONFIG_READ.test(arg)) && !rest.some((arg) => CONFIG_WRITE.test(arg)) ? null : 'change';
  }
  if (sub === 'remote') return positional.length === 0 || ['get-url', 'show'].includes(positional[0]) ? null : 'change';
  if (sub === 'worktree') return positional[0] === 'list' ? null : 'change';
  return null;
}

// A remote given as an address or a folder instead of a name: git would contact or read it.
const NOT_A_REMOTE_NAME = /:\/\/|^[\w.-]+@|^[a-z]:|^[\\/.~]|^\w+::/i;

// Folders triage may read: the configured repos, ~/.spadework (not its
// board/), the plugin, Claude Code's saved tool results and the temp folder.
const readRoots = ({ home, repos = [] }) => [home, pluginRoot(), os.tmpdir(), ...repos];
const insideRoots = (file, ctx) => !isBoardFile(file, ctx.home)
  && (readRoots(ctx).some((root) => isInside(file, root)) || isOwnSessionFile(file, ctx.sessionId));
const WHERE = 'triage only reads the configured repos and Spadework\'s own folders';

// graphify: only questions to a graph the user built, in a configured repo.
// Building or updating the graph is the user's call, never triage's.
function checkGraphify(args, ctx) {
  if (args.length === 1 && /^(--version|-V|--help|-h)$/.test(args[0])) return null;
  if (!QUERIES.has(args[0])) return 'triage only asks a code graph questions (graphify query, path or explain). Building or updating the graph is up to you';
  const inRepo = (file) => (ctx.repos || []).some((repo) => isInside(file, repo));
  const where = 'triage only reads the graphs of the configured repos';
  let graphArg = false;
  for (let i = 1; i < args.length; i++) {
    const match = args[i].match(/^--graph(?:=(.*))?$/);
    if (!match) continue;
    graphArg = true;
    const value = match[1] !== undefined ? match[1] : args[i + 1] || '';
    const reason = checkReadPath('graphify --graph', value, { cwd: ctx.cwd, inside: inRepo, where });
    if (reason) return reason;
  }
  if (!graphArg && !(ctx.cwd && inRepo(ctx.cwd))) return `graphify reads the graph in the current folder: run it inside a configured repo (cd "<repo>" && graphify ${args[0]} ...)`;
  return null;
}

function checkGit(args, ctx = null) {
  const { sub, rest, globals } = gitSubcommand(args);
  if (globals.some((option) => /^(-c|--exec-path|--git-dir|--work-tree|--config-env)/.test(option))) {
    return 'git options that change its configuration aren\'t allowed during triage';
  }
  if (!sub && globals.some((option) => /^(--version|--help|--html-path|--man-path|--info-path)$/.test(option))) return null;
  // git only in the configured repos: a git folder anywhere else could
  // carry settings that run a program (core.fsmonitor).
  if (ctx && sub !== 'version' && sub !== 'help') {
    const inRepo = (file) => (ctx.repos || []).some((repo) => isInside(file, repo));
    const where = 'triage only runs git in the configured repos';
    const dirs = globals.filter((option, i) => globals[i - 1] === '-C');
    if (dirs.length > 1) return 'git with more than one -C isn\'t allowed during triage';
    if (dirs.length) {
      const reason = checkReadPath('git -C', dirs[0], { cwd: ctx.cwd, inside: inRepo, where });
      if (reason) return reason;
    } else if (!(ctx.cwd && inRepo(ctx.cwd))) {
      return `${where}: use git -C "<repo>"`;
    }
  }
  if (rest.some((arg) => runsProgram(sub, arg) || writesOrReadsOut(sub, arg))) return `git ${sub} with that option can write files, run programs or read outside the repo`;
  const positional = rest.filter((arg) => !arg.startsWith('-'));
  if (sub === 'ls-remote' || sub === 'fetch') {
    if (positional[0] && NOT_A_REMOTE_NAME.test(positional[0])) return `git ${sub} only talks to the repo's own remotes, by name (origin), not ${positional[0]}`;
  }
  if (GIT_READ.has(sub)) return null;
  switch (sub) {
    case 'fetch':
      // A refspec with ":" would update local branches.
      return positional.some((arg) => arg.includes(':')) ? 'git fetch into a local branch isn\'t allowed during triage' : null;
    case 'config':
    case 'remote':
    case 'worktree': {
      const change = gitChange(sub, rest);
      if (change === 'other-settings') return 'git config only reads the repo\'s own settings during triage';
      return change ? `git ${sub} can only be ${sub === 'worktree' ? 'listed' : 'read'} during triage` : null;
    }
    case 'symbolic-ref':
      return positional.length <= 1 && !rest.some((arg) => /^(-d|--delete)$/.test(arg)) ? null : 'git symbolic-ref can only be read during triage';
    // With no name, or in list mode, git branch and git tag only list. Then
    // any other word is a commit (--contains abc) or a pattern ("v1.*").
    case 'branch': {
      const optionsOk = rest.filter((arg) => arg.startsWith('-')).every((arg) => BRANCH_LIST_OPTIONS.test(arg));
      const listing = rest.some((arg) => LIST_MODE.test(arg));
      return optionsOk && (listing || positional.length === 0) ? null : 'git branch can only list branches during triage';
    }
    case 'tag': {
      const optionsOk = rest.filter((arg) => arg.startsWith('-')).every((arg) => TAG_LIST_OPTIONS.test(arg));
      const listing = rest.some((arg) => LIST_MODE.test(arg) || /^-n\d*$/.test(arg));
      return optionsOk && (listing || positional.length === 0) ? null : 'git tag can only list tags during triage';
    }
    case 'stash':
      return ['list', 'show'].includes(positional[0]) ? null : 'git stash can only be read during triage';
    default:
      return `git ${sub || '(no command)'} changes the repo, and triage is read-only`;
  }
}

// A file that could be run as a program: triage never writes one.
const RUNNABLE = /\.(exe|com|cmd|bat|ps1|psm1|psd1|vbs|vbe|js|mjs|cjs|wsf|hta|msi|scr|sh|bash|py|lnk)[\s.]*$/i;

// Triage writes files only in ~/.spadework/tmp, and never a runnable file
// or Claude Code or git settings there. Files there with an owner:
// item-<id>.json, brief-<id>.md and implement-<row>.md are written by the
// CLI only (the state move reads the item's original state from
// item-<id>.json; implement's agents read their plan from implement-<row>.md),
// and plan-<id>.md by the planner agents only (isPlanFile).
const OWNED_TMP_FILE = /^(item-\d+\.json|brief-\d+\.md|implement-[a-z][a-z0-9]{1,9}-\d+\.md|plan-\d+\.md)$/i;

function writable(file, home) {
  const tmp = path.join(home, 'tmp');
  return !isNetworkPath(file) && isInside(file, tmp) && !isProtected(file, home) && !RUNNABLE.test(file) && !isConfigFile(file, tmp)
    && !OWNED_TMP_FILE.test(path.basename(realish(file)));
}

// Whether a redirect target is harmless: another stream, the null device,
// or a file in ~/.spadework that isn't protected.
function redirectOk(redirect, home, cwd) {
  if (writesNoFile(redirect)) return true;
  const target = redirect.target.trim();
  if (isNetworkPath(target)) return false;
  const file = expandPath(target, cwd);
  return target !== '' && file !== null && writable(file, home);
}

function checkProgram(command, ctx) {
  // Triage never needs one, and some make a read-only program run another (GIT_EXTERNAL_DIFF).
  const env = envSets(command);
  if (env.length) return `setting environment variables (${env.join(', ')}) isn't allowed during triage`;
  const { name, args, pathed } = program(command.words, command);
  if (pathed) return 'triage runs programs by name only, never by path (a file there could pose as a read-only command)';
  if (!name) {
    // A PowerShell expression: no environment variables, no .NET calls that read or connect.
    const text = command.words.join(' ');
    if (/\$env:/i.test(text)) return 'reading environment variables isn\'t allowed during triage';
    const call = text.match(/\[[\w.]+\]::/g);
    if (call && call.some((type) => !SAFE_TYPES.test(type))) return `the .NET call ${call[0]} isn't allowed during triage`;
    return null;
  }
  if (name === 'git') return checkGit(args, ctx);
  if (name === 'node') {
    if (/^(-v|--version)$/.test(args[0] || '')) return null;
    const cli = spadeworkCli(name, args, ctx.cwd);
    if (!cli) return 'only Spadework\'s own helper runs with node during triage';
    return checkCli(cli, { mode: 'triage', sessionId: ctx.sessionId, allowed: CLI_ALLOWED });
  }
  if (name === 'graphify') return checkGraphify(args, ctx);
  if (!READ_ONLY.has(name)) return `${name} isn't one of the read-only commands triage may run`;
  if (BAD_OPTIONS[name] && args.some((arg) => BAD_OPTIONS[name].test(arg))) return `${name} with that option can write files, run programs or read other files`;
  if (name === 'jq' && args.some((arg) => JQ_READS.test(arg))) return 'jq programs that read the environment or other files aren\'t allowed during triage';
  if (args.some((arg) => /\$env:/i.test(arg))) return 'reading environment variables isn\'t allowed during triage';
  return checkCommandReads(command, name, args, { cwd: ctx.cwd, inside: (file) => insideRoots(file, ctx), where: WHERE });
}

// The only Azure DevOps write triage may do: one state move, when the user
// turned it on, to the configured state, and the triage tag on that item.
// Returns a reason to block, or null.
function checkStateMove(toolInput, onTriage, home) {
  if (!onTriage || !onTriage.set_state_enabled) return 'Azure DevOps is read-only (the state move is off in config.json)';
  if (toolInput.action !== 'update' || !Array.isArray(toolInput.updates)) return 'the only Azure DevOps change allowed is the state move';
  const target = String(onTriage.set_state || '').toLowerCase();
  // The state the item had when this run fetched it (tmp/item-<id>.json): the move
  // back, when the row couldn't be written after the item was moved.
  const item = readJsonOrNull(path.join(home, 'tmp', `item-${Number(toolInput.id)}.json`));
  const original = item && item.fields && typeof item.fields['System.State'] === 'string' ? item.fields['System.State'].toLowerCase() : null;
  const ok = toolInput.updates.every((update) => {
    const field = String(update.path || '').toLowerCase();
    if (field === '/rev') return String(update.op || '').toLowerCase() === 'test';
    // Tags: the move marks the item as touched by triage. An add of exactly that tag.
    if (field === '/fields/system.tags') return String(update.op || '').toLowerCase() === 'add' && String(update.value || '').trim().toLowerCase() === TRIAGE_TAG;
    const value = String(update.value || '').toLowerCase();
    return field === '/fields/system.state' && (value === target || (original !== null && value === original));
  });
  return ok && toolInput.updates.some((update) => String(update.path || '').toLowerCase() === '/fields/system.state')
    ? null
    : `the only Azure DevOps change allowed is moving the state to ${onTriage.set_state}`;
}

// Launching spadework:web-researcher: its questions go to the web.
function isResearcher(tool, toolInput) {
  return (tool === 'Agent' || tool === 'Task') && RESEARCHER_AGENT.test(String(toolInput.subagent_type || ''));
}

// Whether a file is the plan file of a work item this run claimed:
// ~/.spadework/tmp/plan-<id>.md, with the claim in this session's name.
function isPlanFile(file, ctx) {
  const match = path.basename(realish(file)).match(PLAN_FILE);
  if (!match || isNetworkPath(file) || norm(path.dirname(file)) !== norm(path.join(ctx.home, 'tmp'))) return false;
  return Boolean(runs.readClaim(ctx.sessionId, Number(match[1])));
}

// Returns a reason to block, or null.
// ctx: { home, sessionId, repos (paths), projects (names), onTriage, webResearch }.
// repos, projects, onTriage and webResearch may be functions, read only when needed.
function check(input, ctx = {}) {
  const tool = input.tool_name || '';
  const toolInput = input.tool_input || {};
  const cwd = input.cwd || process.cwd();
  const deny = (reason) => `Spadework triage is read-only: ${reason}.`;

  if (FILE_TOOLS.has(tool)) {
    const files = writtenFiles(toolInput, cwd);
    // A planner agent writes its answer to one file, for an item this run claimed.
    if (PLANNER_AGENTS.test(String(input.agent_type || ''))) {
      const bad = files.find((file) => !isPlanFile(file, ctx));
      return bad || !files.length ? deny(`a planner agent writes only its answer, ${path.join(ctx.home, 'tmp', 'plan-<work item id>.md')}, for a work item this run claimed. It can't change ${bad || 'that'}`) : null;
    }
    // The main chat (and any other agent) never writes a plan file: only a planner does.
    const bad = files.find((file) => !writable(file, ctx.home));
    return bad ? deny(`it only writes files in ${path.join(ctx.home, 'tmp')}, never programs, plan files or Claude Code or git settings, so it can't change ${bad}`) : null;
  }

  if (READ_TOOLS.has(tool)) {
    const roots = { home: ctx.home, sessionId: ctx.sessionId, repos: lazy(ctx.repos) || [] };
    const reason = checkReadTool(toolInput, cwd, { inside: (file) => insideRoots(file, roots), where: 'it only reads the configured repos and Spadework\'s own folders' });
    return reason ? deny(reason) : null;
  }

  // Only Spadework's own agents: any other one brings tools these checks don't know.
  if ((tool === 'Agent' || tool === 'Task') && !/^spadework:[\w-]+$/.test(String(toolInput.subagent_type || '').trim())) {
    return deny(`it only launches Spadework's own agents, not ${toolInput.subagent_type || 'a general-purpose one'}`);
  }

  // The web, only when the user turned web research on, and only from the
  // web researcher: the main chat and the planners hold the work item. A
  // search never carries secrets or personal data. A page is opened only if
  // a search in this run returned its exact address: a link from a work
  // item, or an address with something added ("?ref=<connection string>"), never is.
  if (tool === 'WebSearch' || tool === 'WebFetch' || isResearcher(tool, toolInput)) {
    if (!lazy(ctx.webResearch)) return deny('web research is off (triage.web_research in config.json)');
    if (tool !== 'Agent' && tool !== 'Task' && !RESEARCHER_AGENT.test(String(input.agent_type || ''))) {
      return deny('only the spadework:web-researcher agent uses the web. Launch it with the general technical questions');
    }
    const text = tool === 'WebSearch' ? [toolInput.query, ...(toolInput.allowed_domains || [])]
      : tool === 'WebFetch' ? [toolInput.url] : [toolInput.description, toolInput.prompt];
    const found = require('./secrets').scanText(text.filter(Boolean).join('\n'));
    if (found.length) return deny(`it would send ${found[0].kind} (${found[0].sample}) to the web. Ask the general technical question instead`);
    if (tool === 'WebFetch') {
      const web = require('../web');
      const url = web.normalize(toolInput.url);
      if (!url || !web.searchLinks(ctx.sessionId, { home: ctx.home }).has(url)) {
        return deny(`it only opens pages a web search returned in this run, exactly as returned, not ${toolInput.url}`);
      }
      if (web.fetchCount(ctx.sessionId, { home: ctx.home }) >= web.MAX_FETCHES) return deny(`it already opened ${web.MAX_FETCHES} pages in this run`);
      web.countFetch(ctx.sessionId, { home: ctx.home });
    }
    return null;
  }

  const mcp = mcpTool(tool);
  if (mcp !== null) {
    if (APP_TOOLS.has(tool)) return null;
    if (mcp === 'wit_work_item_write') {
      const reason = checkStateMove(toolInput, lazy(ctx.onTriage), ctx.home);
      return reason ? deny(reason) : null;
    }
    // Work items, their comments, the backlog queries and a Bug's linked pull request.
    const reason = checkAdoRead(mcp, toolInput, ADO_READS, lazy(ctx.projects));
    return reason ? deny(reason) : null;
  }

  if (SHELL_TOOLS.has(tool)) {
    const shellCtx = { home: ctx.home, sessionId: ctx.sessionId, repos: lazy(ctx.repos) || [] };
    const reason = checkEachCommand(tool, toolInput, cwd, (command, commandCwd) => {
      const badRedirect = command.redirects.find((redirect) => !redirectOk(redirect, ctx.home, commandCwd));
      if (badRedirect) return `it can't write to ${badRedirect.target || 'a file'}`;
      return checkProgram(command, { ...shellCtx, cwd: commandCwd });
    });
    return reason ? deny(reason) : null;
  }
  return null;
}

module.exports = { check, checkGit, checkProgram, isResearcher, runsProgram, gitChange, GIT_READ };
