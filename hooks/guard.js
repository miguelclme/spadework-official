#!/usr/bin/env node
'use strict';

// PreToolUse hook: Spadework's guards in one process, so a tool call starts
// one Node process instead of several.
//   every run        no stored credentials read (any tool); command-guard
//                    (no download-and-run, drive wipes, sending secrets);
//                    no web, except in triage when web research is on
//   triage-guard     triage runs: read-only (the board is written by the helper)
//   implement-guard  implement runs: changes stay in the repo, never push
//   handoff-guard    handoff runs: creates only the Requirements it checked
//   merge-guard      merge runs: only the helper's git work, and edits to
//                    the files in conflict while they are being resolved
//   design-guard     design runs: the main chat, the coordinator and the
//                    architect each get their own tools (by agent_type)
//   design-push-guard design-push runs: creates only the reviewed Epic and Features
//   init-guard       init runs: only the tools init uses. Writes only
//                    init-options.json, runs only the helper, reads Azure
//                    DevOps only
// Outside a Spadework run it allows everything and exits at once: it only
// checks whether this session has a run file. Two things happen before
// that: Claude loading spadework:triage starts a triage run, and a skill's
// exact `run check` step is approved without asking.

const fs = require('fs');
const path = require('path');

const { runHook, decision } = require('../lib/hook-io');
const paths = require('../lib/paths');
const { READ_TOOLS, FILE_TOOLS, RUN_TOOLS, readPaths, writtenFiles, isNetworkPath, mcpTool, spadeworkCli } = require('../lib/guards/common');

// Reads config.json at most once per tool call, and only when a check needs it.
function lazyFiles() {
  let cfg;
  const config = () => {
    if (cfg === undefined) {
      const loaded = require('../lib/config').load({ checkPaths: false });
      cfg = loaded.ok ? loaded.config : null;
    }
    return cfg;
  };
  return {
    repos: () => (config() ? config().repos.map((repo) => repo.path) : []),
    projects: () => (config() ? config().tracker.projects : []),
    onTriage: () => (config() ? config().tracker.on_triage : null),
    webResearch: () => Boolean(config() && config().triage.web_research),
  };
}

// Tools the triage guard checks in full (MCP tools too: it blocks every
// one triage doesn't use). Not questions to the user or to-do lists.
const TRIAGE_APPROVED = new Set(['Bash', 'PowerShell', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
  'WebFetch', 'WebSearch', 'Agent', 'Task', 'Skill']);

// The only skills a strict run may load: its own.
const RUN_SKILLS = {
  triage: /^\/?spadework:(re-)?triage$/i,
  implement: /^\/?spadework:implement$/i,
  handoff: /^\/?spadework:handoff$/i,
  merge: /^\/?spadework:merge$/i,
  'design-push': /^\/?spadework:design-push$/i,
};

const NETWORK_PATH = 'Spadework: network paths (\\\\server\\share) aren\'t used in a Spadework run.';

// What the guards say about one tool call: a reason to block, or null.
// run: the session's run ({ mode, cwd, repo_path, ... }). Exposed for tests
// and validate's self-test; `files` replaces config.json.
function evaluate(input, run, options = {}) {
  const reason = evaluateRun(input, run, options);
  if (!reason || run.mode !== 'design') return reason;
  const { LEAVE } = require('../lib/guards/design');
  return reason.endsWith(LEAVE) ? reason : `${reason} ${LEAVE}`;
}

function evaluateRun(input, run, { home = paths.home(), files = lazyFiles() } = {}) {
  const tool = input.tool_name || '';
  const toolInput = input.tool_input || {};
  const sessionId = input.session_id;
  const cwd = input.cwd || process.cwd();
  const command = require('../lib/guards/command');
  const strict = require('../lib/runs').isOneTurn(run.mode);

  // One-turn runs use a known set of tools. Any other tool (one that runs
  // commands, schedules work or reaches other services) isn't checked by
  // these guards, so it's blocked.
  if (strict && mcpTool(tool) === null && !RUN_TOOLS.has(tool)) {
    return `Spadework ${run.mode}: ${tool} isn't used in a Spadework run.`;
  }
  // No other skill mid-run: one could bring its own pre-approved commands.
  if (strict && tool === 'Skill' && !RUN_SKILLS[run.mode].test(String(toolInput.skill || '').trim())) {
    return `Spadework ${run.mode}: other skills aren't used in a Spadework run.`;
  }
  // Agents' calls carry this session's id, so these guards check them too
  // (run-cleanup keeps the run on until they finish). A remote agent
  // (isolation "remote") isn't checked: no hook runs there.
  if (strict && (tool === 'Agent' || tool === 'Task') && toolInput.isolation !== undefined && toolInput.isolation !== 'worktree') {
    return `Spadework ${run.mode}: agents run in this session or a worktree, where these checks run, not with isolation "${toolInput.isolation}".`;
  }

  // Network paths are never touched: looking one up sends the user's login to that server.
  const named = [...(READ_TOOLS.has(tool) ? [toolInput.file_path, toolInput.path] : []), ...(FILE_TOOLS.has(tool) ? writtenFiles(toolInput, cwd) : [])];
  if (named.some(isNetworkPath)) return NETWORK_PATH;

  // Stored credentials are never read, whatever the tool.
  if (READ_TOOLS.has(tool)) {
    const targets = [...readPaths(toolInput, cwd)];
    // Glob's pattern and Grep's glob name files (Grep's pattern is the text it looks for).
    const pattern = tool === 'Grep' ? toolInput.glob : toolInput.pattern;
    if (typeof pattern === 'string') targets.push(pattern, path.join(targets[0], pattern));
    const file = targets.find((target) => command.touchesCredentials(target, cwd));
    if (file) return `Spadework: stored credentials are never read in a Spadework run (${file}).`;
  }

  if (tool === 'Bash' || tool === 'PowerShell') {
    const parsed = require('../lib/guards/shell').parse(toolInput.command, { powershell: tool === 'PowerShell' });
    if (parsed.some((cmd) => [...cmd.words, ...cmd.redirects.map((redirect) => redirect.target)].some(isNetworkPath))) {
      return NETWORK_PATH;
    }
    if (parsed.some((cmd) => cmd.hidden)) return 'Spadework: shells inside shells this deep can\'t be checked. Run the command directly.';
    const reason = command.check(toolInput.command, { powershell: tool === 'PowerShell', cwd });
    if (reason) return `Spadework: ${reason}`;
  }

  if (run.mode === 'triage') {
    const reason = require('../lib/guards/triage').check(input, {
      home, sessionId, repos: files.repos, projects: files.projects, onTriage: files.onTriage, webResearch: files.webResearch,
    });
    if (reason) return reason;
  } else if (run.mode === 'implement') {
    const reason = require('../lib/guards/implement').check(input, { home, run, sessionId, repos: files.repos, projects: files.projects });
    if (reason) return reason;
  } else if (run.mode === 'handoff') {
    const reason = require('../lib/guards/handoff').check(input, { sessionId, run, projects: files.projects });
    if (reason) return reason;
  } else if (run.mode === 'merge') {
    const reason = require('../lib/guards/merge').check(input, { sessionId });
    if (reason) return reason;
  } else if (run.mode === 'design') {
    const reason = require('../lib/guards/design').check(input, { home, sessionId, run, projects: files.projects });
    if (reason) return reason;
  } else if (run.mode === 'design-push') {
    const reason = require('../lib/guards/design-push').check(input, { sessionId, run, projects: files.projects });
    if (reason) return reason;
  } else if (run.mode === 'init') {
    const reason = require('../lib/guards/init').check(input, { home, sessionId });
    if (reason) return reason;
  }

  // Only triage may use the web, when the user turned it on. The other runs
  // never need it, and a request could carry the repo's code out.
  if (run.mode !== 'triage' && (tool === 'WebFetch' || tool === 'WebSearch'
    || require('../lib/guards/triage').isResearcher(tool, toolInput))) {
    return `Spadework ${run.mode} doesn't use the web: a web request could carry your code or data out of the machine.`;
  }

  return null;
}

// Claude loading the triage skill itself, as a scheduled task asks it to
// (its prompt is plain text, never a slash command).
const TRIAGE_SKILL = /^\/?spadework:triage$/i;

// Starts the triage run before the skill loads, so none of its steps runs
// unguarded. An init run is replaced, as a typed /spadework:triage does. A
// design run isn't: Claude loading the triage skill mid-design wasn't typed.
// Returns a decision to block, or null.
function startTriage(input) {
  const runs = require('../lib/runs');
  const existing = runs.get(input.session_id, { includeStale: true });
  if (existing && existing.mode !== 'triage' && (runs.isOneTurn(existing.mode) || existing.mode === 'design')) {
    const leave = existing.mode === 'design' ? ` ${require('../lib/guards/design').LEAVE}` : '';
    return decision('deny', `Spadework: this chat is in ${existing.mode === 'implement' ? 'an' : 'a'} ${existing.mode} run. Finish it before a triage.${leave}`);
  }
  if (existing && existing.mode === 'triage') return null;
  runs.pruneStale();
  const result = runs.start(input.session_id, 'triage', { cwd: input.cwd ?? null });
  return result.ok ? null : decision('deny', `Spadework: ${result.error}`);
}

// A run skill's first step, exactly: node "<this plugin>/scripts/spadework.js"
// run check <mode> <this session>. It only reads, so it's approved without
// asking: a scheduled triage never stops to wait for it.
function isRunCheck(input) {
  if (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') return false;
  const text = String((input.tool_input || {}).command || '');
  if (!text.includes('run check')) return false;
  const { parse } = require('../lib/guards/shell');
  const commands = parse(text, { powershell: input.tool_name === 'PowerShell' });
  if (commands.length !== 1 || commands[0].redirects.length) return false;
  const { words } = commands[0];
  if (words.length !== 6 || words[0] !== 'node') return false;
  const cli = spadeworkCli('node', words.slice(1), input.cwd || process.cwd());
  return Array.isArray(cli) && cli[0] === 'run' && cli[1] === 'check' && require('../lib/runs').MODES.includes(cli[2]) && cli[3] === input.session_id;
}

function handle(input) {
  const sessionId = input.session_id;
  if (!paths.isValidSessionId(sessionId)) return null;
  if (input.tool_name === 'Skill' && TRIAGE_SKILL.test(String((input.tool_input || {}).skill || '').trim())) {
    // An error would let the skill load with no run, so with no guards: refuse it instead.
    let blocked;
    try {
      blocked = startTriage(input);
    } catch (err) {
      blocked = decision('deny', `Spadework couldn't start the triage run (${err && err.message ? err.message : err}). Try again.`);
    }
    if (blocked) return blocked;
  }
  if (isRunCheck(input)) return decision('allow', 'Spadework: checks that this chat\'s run is on (read-only).');
  // Fast exit: no run file, no Spadework run.
  if (!fs.existsSync(paths.runFile(sessionId))) return null;

  const runs = require('../lib/runs');
  // A run that went quiet for hours (a prompt waiting overnight) is still
  // guarded: only its own Stop hook or run end ends it.
  const run = runs.get(sessionId, { includeStale: true });
  if (!run) return null;
  runs.touch(sessionId);

  // Inside a run, a guard that fails blocks the call instead of letting it through.
  let reason;
  try {
    reason = evaluate(input, run);
  } catch (err) {
    reason = `Spadework's safety check failed (${err && err.message ? err.message : err}), so this call was blocked. Try it another way.`;
  }
  if (reason) return decision('deny', reason);
  // In triage the guard checks every call of these tools itself, so a call
  // it lets through is approved too: a scheduled triage never stops to ask,
  // and nobody has to leave "always allow" rules behind.
  if (run.mode === 'triage' && (TRIAGE_APPROVED.has(input.tool_name) || mcpTool(input.tool_name) !== null)) {
    return decision('allow', 'Spadework triage: checked by its guard.');
  }
  return null;
}

if (require.main === module) runHook('guard', handle);

module.exports = { handle, evaluate };
