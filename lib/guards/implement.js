'use strict';

// implement-guard: in implement runs, changes stay in the repo being worked
// on and nothing is published:
// - files (file tools, > redirects, and commands that copy, move, link,
//   create, delete, download or extract files): only inside the repo, its
//   <repo>--<ID> worktree folders, ~/.spadework (not its settings, run files,
//   logs or tmp) and the temp folder; never inside .git (hooks and git
//   settings there run code), nor the repo's .claude/ or .mcp.json (Claude
//   Code runs them in that folder)
// - reading (Read, Grep, Glob, < and reading commands): the repo and its
//   worktrees, the configured repos, Spadework's folders, the temp folder
//   and package caches; never stored credentials
// - cd is followed, so paths are checked from the folder they run in
// - commands must be readable: none whose program is only known when it
//   runs ($G, $(...)), no shell reading its commands from a pipe or heredoc
// - git: never push, in any form; no aliases, no settings changes, no
//   options that run another program (--exec, --upload-pack), no worktrees
//   or repos of its own; changes only in the repo it works in.
//   Spadework also points the repo's push address at nothing while a row is
//   worked on (lib/implement.js), in case a push gets past this guard
// - no GitHub or Azure DevOps CLI (they create branches and pull requests)
// - web: Claude's web tools aren't used, and curl and the like only reach
//   localhost (tests against a local server). Builds still reach package feeds
// - MCP: only reading Azure DevOps. The rows are on the board, which only
//   Spadework's helper writes
// - Spadework's helper: it can't end or change its own run
// Code that builds and tests run (npm scripts, node -e, the repo's own
// tests) isn't parsed: these rules are best-effort for it.

const os = require('os');
const path = require('path');

const { program, envSets, gitSubcommand, baseName } = require('./shell');
const { readsCodeFromStdin, downloadedFiles, DOWNLOADERS } = require('./command');
const { checkCommandReads, checkReadTool } = require('./reads');
const { GIT_READ, runsProgram, gitChange } = require('./triage');
const {
  FILE_TOOLS, READ_TOOLS, SHELL_TOOLS, writtenFiles, expandPath, isInside, isProtected, isBoardFile, isConfigFile, isClaudeCodeConfig, mcpTool, APP_TOOLS, ADO_READS,
  checkAdoRead, norm, spadeworkCli, checkCli, pluginRoot, isOwnSessionFile, isNetworkPath, hasStream, checkEachCommand, writesNoFile, lazy,
} = require('./common');

const CLI_ALLOWED = new Set(['implement', 'recover', 'stack', 'config', 'paths', 'run']);
// The Azure DevOps reads implement may make: work items and queries, not pull requests.
const READS = { wit_work_item: ADO_READS.wit_work_item, wit_query: ADO_READS.wit_query };

// git commands the developer and tester use. Anything else (an alias, a
// command git doesn't have) is blocked: an alias can hide a push.
const GIT_WORK = new Set(['add', 'commit', 'checkout', 'switch', 'branch', 'fetch', 'merge', 'rebase', 'reset', 'restore', 'stash',
  'rm', 'mv', 'tag', 'cherry-pick', 'revert', 'clean', 'apply', 'am', 'format-patch', 'notes', 'bisect', 'mergetool', 'difftool',
  'pull', 'symbolic-ref', 'sparse-checkout', 'gc', 'prune', 'fsck', 'reflog', 'submodule', 'archive', 'remote', 'config', 'worktree', 'clone']);
// git commands that send commits to another repository.
const GIT_PUSHES = new Set(['push', 'send-pack', 'http-push']);
// Settings git -c may set for one command: none of them run programs.
const GIT_SAFE_SETTINGS = /^(color\.[\w.-]+|advice\.[\w.-]+|core\.quotepath|i18n\.[\w.-]+|user\.(name|email))=/i;

// The repo folder, or one of its worktrees: <repo>--<anything>.
function inWorkspace(file, repo) {
  if (isInside(file, repo)) return true;
  const prefix = `${norm(repo)}--`;
  const target = norm(file);
  return target.startsWith(prefix) && !target.slice(prefix.length).startsWith('-');
}

// Where a file may be written. Returns a reason to block, or null.
function checkWrite(target, { repo, home, cwd }) {
  if (isNetworkPath(target)) return `network paths aren't written to (${target})`;
  const file = expandPath(target, cwd);
  if (file === null) return `"${target}" holds a variable, so where it writes can't be checked`;
  if (hasStream(file)) return `${file} names a hidden part of a file (a data stream), which can't be checked`;
  if (isProtected(file, home)) return `it can't change Spadework's settings, run files or logs (${file})`;
  // tmp/ holds the plan files of every run (triage's and implement's own): implement's tools never need to write there.
  if (isInside(file, path.join(home, 'tmp'))) return `it never writes Spadework's tmp folder (${file}): the plan files there belong to the helper`;
  // .git holds hooks and settings that run code on the next commit, outside these checks.
  if (/(^|[\\/])\.git([\\/]|$)/i.test(path.relative(path.parse(file).root, file))) return `it never changes git's own files (${file}): git does that itself`;
  if (inWorkspace(file, repo)) {
    // The next Claude session in this folder would run them, before anyone reviews the branch.
    return isClaudeCodeConfig(file, repo) ? `it never writes Claude Code settings, hooks or MCP servers (${file}). Change those by hand` : null;
  }
  // Outside the repo, never Claude Code settings: a session started in
  // ~/.spadework (a scheduled triage) would load them.
  for (const folder of [home, os.tmpdir()]) {
    if (!isInside(file, folder)) continue;
    return isConfigFile(file, folder) ? `it never writes Claude Code or git settings outside the repo (${file})` : null;
  }
  return `it only writes files in ${repo} (and its worktrees), not ${file}`;
}

// Folders implement may read besides the repo: the configured repos,
// Spadework's own, the temp folder and package caches.
const PACKAGE_CACHES = ['.nuget/packages', '.m2/repository', '.gradle/caches', 'go/pkg/mod', '.cargo/registry', '.npm/_cacache'];
function readable(file, ctx) {
  if (inWorkspace(file, ctx.repo)) return true;
  if (isBoardFile(file, ctx.home)) return false;
  const roots = [ctx.home, pluginRoot(), os.tmpdir(), ...(ctx.repos || []),
    ...PACKAGE_CACHES.map((folder) => path.join(os.homedir(), folder))];
  return roots.some((root) => isInside(file, root)) || isOwnSessionFile(file, ctx.sessionId);
}
const WHERE = 'implement reads the repo, the configured repos, Spadework\'s folders and package caches';

// Commands that create, copy, move, link or delete files, and how to find
// the paths they write: 'all' arguments, or only the 'last' (the destination).
const FILE_WRITERS = {
  cp: 'last', install: 'last', ln: 'all', mv: 'all', rm: 'all', rmdir: 'all', mkdir: 'all', touch: 'all', tee: 'all',
  truncate: 'all', unlink: 'all', 'copy-item': 'last', cpi: 'last', copy: 'last', 'move-item': 'all', mi: 'all', move: 'all',
  'new-item': 'all', ni: 'all', 'set-content': 'first', sc: 'first', 'add-content': 'first', ac: 'first', 'out-file': 'first',
  'remove-item': 'all', ri: 'all', del: 'all', erase: 'all', rd: 'all', 'rename-item': 'all', ren: 'all', 'clear-content': 'all',
  mklink: 'all',
};
// PowerShell parameters that name a path, and ones that take a non-path value.
const PS_PATH_PARAMS = /^-(path|literalpath|destination|filepath|target)$/i;
const PS_VALUE_PARAMS = /^-(value|encoding|itemtype|name|newname|filter|include|exclude|width|inputobject|stream|credential)$/i;
// -t DIR / --target-directory DIR name the destination of cp, mv, install, ln.
const TARGET_OPTIONS = /^(-t|--target-directory)$/;

// The values of an option: -C DIR, -d DIR.
const valuesOf = (args, option) => args.flatMap((arg, i) => (option.test(arg) && args[i + 1] ? [args[i + 1]] : []));

// Programs that write where they're told, and the current folder (".") when
// they aren't: downloads (curl -o, wget -O, Invoke-WebRequest -OutFile),
// extractions (tar -C, unzip -d, 7z -o, Expand-Archive -DestinationPath),
// dd of= and the Windows copiers. Returns the paths written, as written.
function outputPaths(name, args) {
  if (DOWNLOADERS.has(name)) return downloadedFiles([{ name, args }]);
  // /s is a switch on Windows only: elsewhere a leading slash is a path.
  const isSwitch = process.platform === 'win32' ? /^[-/]/ : /^-/;
  const positional = args.filter((arg) => !isSwitch.test(arg));
  const orHere = (dirs) => (dirs.length ? dirs : ['.']);
  switch (name) {
    case 'tar':
      return args.some((arg) => /^(--extract|--get|-?[a-zA-Z]*x[a-zA-Z]*)$/.test(arg)) ? orHere(valuesOf(args, /^(-C|--directory)$/)) : [];
    case 'unzip':
      return args.some((arg) => /^-[a-zA-Z]*[ltzp]/.test(arg)) ? [] : orHere(valuesOf(args, /^-d$/));
    case '7z': case '7za': case '7zr':
      return /^[xe]$/.test(positional[0] || '') ? orHere(args.filter((arg) => /^-o./.test(arg)).map((arg) => arg.slice(2))) : [];
    case 'dd':
      return args.filter((arg) => /^of=/i.test(arg)).map((arg) => arg.slice(3));
    case 'expand-archive':
      return orHere([...valuesOf(args, /^-destinationpath$/i), ...positional.slice(1, 2)]);
    case 'robocopy': case 'xcopy':
      return positional.slice(1, 2);
    default:
      return [];
  }
}

function writtenPaths(name, args, powershell) {
  if (name === 'sed') {
    if (!args.some((arg) => /^(-i|--in-place)/.test(arg) || /^-[a-zA-Z]*i/.test(arg))) return [];
    const files = args.filter((arg) => !arg.startsWith('-'));
    return args.some((arg) => /^(-e|--expression|-f|--file)/.test(arg)) ? files : files.slice(1);
  }
  // fsutil hardlink create <new> <existing>: both ends of the link.
  if (name === 'fsutil') return /^hardlink$/i.test(args[0] || '') ? args.slice(2) : [];
  const mode = FILE_WRITERS[name];
  if (!mode) return [];
  // A link's target is written through the link: New-Item -ItemType SymbolicLink -Value <target>.
  const link = (name === 'new-item' || name === 'ni') && args.some((arg, i) => /^-itemtype$/i.test(args[i - 1] || '') && /link|junction/i.test(arg));
  const paths = [];
  const plain = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (powershell && (PS_PATH_PARAMS.test(arg) || (link && /^-value$/i.test(arg)))) {
      if (args[i + 1]) paths.push(...args[++i].split(','));
    } else if (powershell && PS_VALUE_PARAMS.test(arg)) {
      i++;
    } else if (TARGET_OPTIONS.test(arg)) {
      if (args[i + 1]) paths.push(args[++i]);
    } else if (name === 'mklink' && /^\/[dhj]$/i.test(arg)) {
      // mklink's /D /H /J options
    } else if (!arg.startsWith('-')) {
      plain.push(arg);
    }
  }
  if (paths.length) return [...paths, ...(link ? plain : [])];
  if (mode === 'last') return plain.slice(-1);
  if (mode === 'first') return plain.slice(0, 1);
  return plain;
}

// PowerShell calling .NET to change files ([IO.File]::WriteAllText(...)): the
// guard can't see where those write, so they aren't used.
const DOTNET_FILE_CALLS = /\[(system\.)?io\.\w+\]::\s*(write|append|create|delete|move|copy|replace|open(?!read)|set|encrypt|decrypt)|new-object\s+(-typename\s+)?(system\.)?io\.(streamwriter|filestream|fileinfo|directoryinfo)|\[(system\.)?io\.(streamwriter|filestream)\]::new/i;

// --- network ------------------------------------------------------------------------

const LOCAL_HOST = /^(localhost|127(\.\d+){3}|\[?::1\]?|0\.0\.0\.0|[\w-]+\.localhost)$/i;
function hostOf(url) {
  const value = String(url).replace(/^["']|["']$/g, '');
  const withScheme = /^[a-z][\w+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  try {
    return new URL(withScheme).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

// Web commands in implement go to localhost only (tests against a local
// server), reads included: a GET to any other site could carry the repo's
// code in its address. Builds still download packages (npm, dotnet, pip):
// they aren't web commands to this guard.
const WEB_CLIENTS = new Set(['curl', 'wget', 'iwr', 'invoke-webrequest', 'irm', 'invoke-restmethod', 'http', 'https', 'xh', 'aria2c']);
// Tools that connect anywhere and can't be checked by address: not used in implement.
const NETWORK_TOOLS = new Set(['nc', 'ncat', 'netcat', 'socat', 'telnet', 'scp', 'sftp', 'ftp', 'tftp', 'rsync', 'ssh',
  'start-bitstransfer', 'bitsadmin', 'send-mailmessage']);

// Returns a reason to block a web or network command, or null.
function checkNetwork(name, args) {
  if (NETWORK_TOOLS.has(name)) return `${name} connects to other machines, which implement never does`;
  if (name === 'certutil' && args.some((arg) => /^[-/]urlcache$/i.test(arg))) return 'certutil -urlcache downloads files, which implement never does';
  if (!WEB_CLIENTS.has(name)) return null;
  const targets = args.filter((arg, i) => /^["']?(https?:\/\/|[\w.-]+:\d+(\/|$)|localhost\b|\[?::1\]?)/i.test(arg)
    || (/^-uri$/i.test(args[i - 1] || '') && !arg.startsWith('-')));
  if (!targets.length) return `${name}: where it connects can't be checked (only localhost addresses are allowed)`;
  const remote = targets.find((url) => {
    const host = hostOf(url);
    return !host || !LOCAL_HOST.test(host);
  });
  return remote ? `it only calls localhost (tests against a local server), not ${remote}` : null;
}

// --- git ------------------------------------------------------------------------------

function checkGit(args, ctx) {
  const { sub, rest, globals } = gitSubcommand(args);
  const push = 'it never pushes. The user reviews the branch and pushes it';
  if (GIT_PUSHES.has(sub) || (sub === 'subtree' && rest[0] === 'push')) return push;

  // Global options: -c only for harmless settings; -C, --git-dir and
  // --work-tree only into the repo and its worktrees.
  let dir = ctx.cwd;
  for (let i = 0; i < globals.length; i++) {
    const option = globals[i];
    if (option === '-c') {
      if (!GIT_SAFE_SETTINGS.test(globals[i + 1] || '')) return `git -c ${globals[i + 1] || ''} isn't allowed: settings given that way can run programs or push`;
      i++;
    } else if (/^--(config-env|exec-path)/.test(option)) {
      return `git ${option} isn't allowed: it can run other programs`;
    } else if (option === '-C' || /^--(git-dir|work-tree)/.test(option)) {
      const value = option.includes('=') ? option.slice(option.indexOf('=') + 1) : globals[++i];
      const target = expandPath(value || '', dir);
      if (target === null || !inWorkspace(target, ctx.repo)) return `git ${option.split('=')[0]} only points at ${ctx.repo} and its worktrees`;
      if (option === '-C') dir = target;
    }
  }
  if (!sub) return null;
  if (!GIT_READ.has(sub) && !GIT_WORK.has(sub)) return `git ${sub} isn't a git command implement uses (aliases aren't used: they can hide a push)`;
  if (!GIT_READ.has(sub) && !inWorkspace(dir, ctx.repo)) return `git ${sub} only changes ${ctx.repo} and its worktrees, not ${dir}`;
  // The program or command these run is never checked.
  if (rest.some((arg) => runsProgram(sub, arg))) return `git ${sub} with that option can run another program`;
  if ((sub === 'bisect' && rest[0] === 'run') || (sub === 'submodule' && rest.includes('foreach'))) {
    return `git ${sub} ${sub === 'bisect' ? 'run' : 'foreach'} runs other commands, which can't be checked`;
  }

  switch (sub) {
    case 'config':
    case 'remote':
    case 'worktree': {
      const change = gitChange(sub, rest);
      if (change === 'other-settings') return 'git config only reads the repo\'s own settings in implement';
      if (!change) return null;
      return {
        config: 'git config can only be read in implement: git settings can run programs or push',
        remote: 'git remote can only be read in implement',
        worktree: 'worktrees are made by Spadework, not during the work',
      }[sub];
    }
    case 'clone': {
      const positional = rest.filter((arg) => !arg.startsWith('-'));
      return positional.length >= 2 ? checkWrite(positional[positional.length - 1], { ...ctx, cwd: dir }) : null;
    }
    case 'submodule':
      return rest.includes('add') ? 'git submodule add isn\'t used in implement' : null;
    default:
      break;
  }
  // Options that write a file somewhere.
  for (let i = 0; i < rest.length; i++) {
    const glued = rest[i].match(/^(--output|--output-directory)=(.+)$/);
    const target = glued ? glued[2] : (/^(--output|--output-directory|-o)$/.test(rest[i]) && sub !== 'commit' ? rest[i + 1] : null);
    if (target) {
      const reason = checkWrite(target, { ...ctx, cwd: dir });
      if (reason) return reason;
    }
  }
  return null;
}

// --- the check --------------------------------------------------------------------

// Environment variables that make a program run another one, load code or
// read other settings. Test commands may set others (NODE_ENV=test).
const RISKY_ENV = /^(GIT_\w*|NODE_OPTIONS|NODE_PATH|PATH|PATHEXT|LD_\w+|DYLD_\w+|RIPGREP_CONFIG_PATH|BASH_ENV|ENV|PROMPT_COMMAND|SHELLOPTS|PS4|PYTHONSTARTUP|PYTHONPATH|PERL5OPT|PERL5LIB|RUBYOPT|COMSPEC|PSMODULEPATH|HOME|USERPROFILE|XDG_CONFIG_HOME|EDITOR|VISUAL|PAGER|LESSOPEN|SSH_ASKPASS|DOTNET_STARTUP_HOOKS|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|NPM_CONFIG_\w+|CLAUDE_\w+|SPADEWORK_\w+)$/;

function checkCommand(command, ctx) {
  // Output written with >: same rules as other file writes.
  for (const redirect of command.redirects) {
    if (writesNoFile(redirect)) continue;
    const reason = checkWrite(redirect.target.trim(), ctx);
    if (reason) return reason;
  }

  const risky = envSets(command).filter((variable) => RISKY_ENV.test(variable));
  if (risky.length) return `setting ${risky.join(', ')} isn't allowed in implement: it can make a program run another one or load other settings`;

  const { name, args } = program(command.words, command);
  // What these run is only known when they run, so it can't be checked.
  // (In PowerShell a $x on its own prints the value: only & $x runs it.)
  if (name.startsWith('$') && (!command.powershell || name === '$call')) return 'a command whose name is only known when it runs ($G, $(...)) can\'t be checked. Write the command out';
  if (readsCodeFromStdin({ name, args })) return `${name} reading commands from a pipe, a heredoc or <<< can't be checked. Run the commands directly`;
  if (command.powershell && DOTNET_FILE_CALLS.test(command.words.join(' '))) {
    return '.NET file calls from PowerShell can\'t be checked. Use the Write or Edit tools, or Set-Content';
  }
  if (name === 'git') return checkGit(args, ctx);
  if (name === 'gh') return 'the GitHub CLI isn\'t used in implement: it can push branches, open pull requests and post comments';
  if (name === 'az' && /^(repos|devops|boards|pipelines|artifacts)$/i.test(args[0] || '')) {
    return 'the Azure DevOps CLI isn\'t used in implement: it can create branches, pull requests and work item changes';
  }
  if (name === 'node') {
    const cli = spadeworkCli(name, args, ctx.cwd);
    if (cli) return checkCli(cli, { mode: 'implement', sessionId: ctx.sessionId, allowed: CLI_ALLOWED });
    // Spadework's helper, written any other way, could end the run and its checks with it.
    if (args.some((arg) => /spadework\.js/i.test(arg))) {
      return 'Spadework\'s helper runs only as node "<plugin folder>/scripts/spadework.js" ..., with nothing in between';
    }
  }

  const network = checkNetwork(name, args);
  if (network) return network;

  for (const target of [...writtenPaths(name, args, command.powershell), ...outputPaths(name, args)]) {
    const reason = checkWrite(target, ctx);
    if (reason) return `${baseName(name)}: ${reason}`;
  }
  return checkCommandReads(command, name, args, { cwd: ctx.cwd, inside: (file) => readable(file, ctx), where: WHERE });
}

// Returns a reason to block, or null.
// ctx: { home, run, sessionId, repos (configured repo paths), projects
// (configured project names) }. repos and projects may be functions, read
// only when needed. The run's repo_path is the repo implement works in.
function check(input, { home, run, sessionId, repos, projects } = {}) {
  const tool = input.tool_name || '';
  const toolInput = input.tool_input || {};
  const cwd = input.cwd || process.cwd();
  const repo = (run && (run.repo_path || run.cwd)) || cwd;
  const deny = (reason) => `Spadework implement: ${reason}.`;
  const ctx = { home, repo, cwd, sessionId, repos: lazy(repos) || [] };

  if (FILE_TOOLS.has(tool)) {
    for (const file of writtenFiles(toolInput, cwd)) {
      const reason = checkWrite(file, ctx);
      if (reason) return deny(reason);
    }
    return null;
  }

  if (READ_TOOLS.has(tool)) {
    const reason = checkReadTool(toolInput, cwd, { inside: (file) => readable(file, ctx), where: WHERE });
    return reason ? deny(reason) : null;
  }

  const mcp = mcpTool(tool);
  if (mcp !== null) {
    if (APP_TOOLS.has(tool)) return null;
    const reason = checkAdoRead(mcp, toolInput, READS, lazy(projects));
    return reason ? deny(`${reason}. Implement only reads Azure DevOps`) : null;
  }

  if (SHELL_TOOLS.has(tool)) {
    const reason = checkEachCommand(tool, toolInput, cwd, (command, commandCwd) => checkCommand(command, { ...ctx, cwd: commandCwd }));
    return reason ? deny(reason) : null;
  }
  return null;
}

module.exports = { check };
