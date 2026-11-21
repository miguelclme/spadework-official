'use strict';

// design-guard: in a design run three callers share the chat's session,
// told apart by the agent_type of each call: none is the main chat,
// design-coordinator is the coordinator, architect is the architect. Any
// other agent may do nothing.
//
//             main chat                  coordinator               architect
// Read        the run's tmp files and    the same, plus the spec   the run's repo, the spec and
//             this chat's saved results  and the ADR folder        the files next to it, never board/
// Grep, Glob  no                         no                        the run's repo
// Write       the questions and answers  the two draft files       no
// Edit...     no                         no                        no
// shell       the helper: run start,     the helper: design adr    read-only programs and git reads
//             run check, design start,   save, design placement    (triage's checkProgram), never
//             backlog, questions,                                  node, no redirect that writes
//             answers, finish
// agents      spadework:design-coordinator  spadework:architect    no
// MCP         wit_query wiql,            no                        no
//             wit_work_item get_batch,
//             app tools
// others      AskUserQuestion,           SubagentHandback          SubagentHandback
//             ToolSearch, to-do lists
//
// design is not a one-turn mode, so the strict checks of hooks/guard.js
// don't run first: this guard refuses SendMessage, Skill and any tool it
// doesn't know itself.

const path = require('path');

const { fileOf, FILES } = require('../design');
const { checkReadTool } = require('./reads');
const { checkProgram } = require('./triage');
const {
  FILE_TOOLS, READ_TOOLS, SHELL_TOOLS, writtenFiles, isInside, isBoardFile, isOwnSessionFile, mcpTool, APP_TOOLS, checkAdoRead, checkCli,
  checkHelperOnly, checkEachCommand, writesNoFile, norm, lazy,
} = require('./common');
const { program } = require('./shell');

const LEAVE = 'This chat is in a design run. To leave it, type another command (for example /clear) or open a new chat.';
const deny = (reason) => `Spadework design: ${reason}. ${LEAVE}`;

const COORDINATOR = /^(spadework:)?design-coordinator$/;
const ARCHITECT = /^(spadework:)?architect$/;
const MAIN_READS = { wit_query: ['wiql'], wit_work_item: ['get_batch'] };
const MAIN_OTHER_TOOLS = new Set(['AskUserQuestion', 'ToolSearch', 'TodoWrite', 'TodoRead', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);
const AGENT_OTHER_TOOLS = new Set(['SubagentHandback']);
// What each caller may ask the helper, besides its own run's start and check.
const MAIN_ACTIONS = ['start', 'backlog', 'questions', 'answers', 'finish'];

// Who made the call: 'main', 'coordinator', 'architect', or null for any other agent.
function callerOf(input) {
  const type = String(input.agent_type || '').trim();
  if (!type) return 'main';
  if (COORDINATOR.test(type)) return 'coordinator';
  if (ARCHITECT.test(type)) return 'architect';
  return null;
}

const sameFile = (first, second) => norm(first) === norm(second);
const runFiles = (sessionId, home) => Object.keys(FILES).map((kind) => fileOf(sessionId, kind, home));

// The helper calls of the main chat and the coordinator.
function checkHelper(tool, toolInput, cwd, ctx, caller) {
  return checkHelperOnly(tool, toolInput, cwd, 'design', (cli) => {
    const [sub, action, more] = cli.map((arg) => String(arg).toLowerCase());
    if (caller === 'coordinator') {
      const ok = sub === 'design' && ((action === 'adr' && more === 'save') || action === 'placement');
      if (!ok) return `the coordinator runs only spadework.js design adr save and design placement, not spadework.js ${cli.slice(0, 2).join(' ')}`;
    } else if (sub === 'design' && !MAIN_ACTIONS.includes(action)) {
      return `spadework.js design ${action || ''} isn't one of the commands the main chat runs (${MAIN_ACTIONS.join(', ')})`;
    }
    return checkCli(cli, { mode: 'design', sessionId: ctx.sessionId, allowed: new Set(['design', 'run']) });
  });
}

// The architect's shell: no node (so never the helper), no redirect that
// writes a file, then triage's read-only programs, with the run's repo as
// the only repo.
function checkArchitectShell(tool, toolInput, cwd, ctx, repoPath) {
  return checkEachCommand(tool, toolInput, cwd, (command, commandCwd) => {
    if (program(command.words, command).name === 'node') return 'the architect doesn\'t run node';
    const redirect = command.redirects.find((each) => !writesNoFile(each));
    if (redirect) return `the architect writes no files (${redirect.target || 'a redirect'})`;
    const reason = checkProgram(command, { home: ctx.home, sessionId: ctx.sessionId, repos: repoPath ? [repoPath] : [], cwd: commandCwd });
    // checkProgram is triage's: its reasons say "triage".
    return reason ? reason.replace(/during triage/g, 'in a design run').replace(/\btriage\b/g, 'the architect') : null;
  });
}

// Returns a reason to block, or null.
// ctx: { home, sessionId, run (with run.design), projects (names, or a function giving them) }
function check(input, ctx = {}) {
  const tool = input.tool_name || '';
  const toolInput = input.tool_input || {};
  const cwd = input.cwd || process.cwd();
  const caller = callerOf(input);
  if (!caller) return deny(`the agent ${input.agent_type} isn't part of the design run, so it may do nothing`);
  const design = (ctx.run && ctx.run.design) || {};
  const own = runFiles(ctx.sessionId, ctx.home);
  const isRunFile = (file) => own.some((each) => sameFile(each, file));
  const spec = design.spec || null;
  const repoPath = design.repo_path || null;

  if (READ_TOOLS.has(tool)) {
    if (caller === 'architect') {
      const nextToSpec = (file) => tool === 'Read' && spec && sameFile(path.dirname(path.resolve(cwd, file)), path.dirname(spec));
      const inside = (file) => !isBoardFile(file, ctx.home) && ((repoPath && isInside(file, repoPath)) || nextToSpec(file));
      const reason = checkReadTool(toolInput, cwd, { inside, where: 'the architect reads only the run\'s repo and the spec\'s folder' });
      return reason ? deny(reason) : null;
    }
    if (tool !== 'Read') return deny(`the ${caller === 'main' ? 'main chat' : 'coordinator'} doesn't search files`);
    const adrFolder = repoPath && design.folder ? path.join(repoPath, design.folder) : null;
    const inside = (file) => isOwnSessionFile(file, ctx.sessionId) || isRunFile(file)
      || (caller === 'coordinator' && ((spec && sameFile(file, spec)) || (adrFolder && isInside(file, adrFolder))));
    const where = caller === 'main' ? 'the main chat reads only this run\'s files and this chat\'s saved results' : 'the coordinator reads only this run\'s files, the spec and the ADR folder';
    const reason = checkReadTool(toolInput, cwd, { inside, where });
    return reason ? deny(reason) : null;
  }

  if (FILE_TOOLS.has(tool)) {
    if (tool !== 'Write' || caller === 'architect') return deny(`${caller === 'architect' ? 'the architect' : 'it'} doesn't use ${tool}`);
    const allowed = caller === 'main' ? [fileOf(ctx.sessionId, 'questions', ctx.home), fileOf(ctx.sessionId, 'answers', ctx.home)]
      : [fileOf(ctx.sessionId, 'adr', ctx.home), fileOf(ctx.sessionId, 'placement', ctx.home)];
    const files = writtenFiles(toolInput, cwd);
    const bad = files.find((file) => !allowed.some((each) => sameFile(each, file)));
    return !files.length || bad ? deny(`the ${caller === 'main' ? 'main chat' : 'coordinator'} writes only ${allowed.join(' and ')}, not ${bad || 'that'}`) : null;
  }

  if (SHELL_TOOLS.has(tool)) {
    const reason = caller === 'architect' ? checkArchitectShell(tool, toolInput, cwd, ctx, repoPath) : checkHelper(tool, toolInput, cwd, ctx, caller);
    return reason ? deny(reason) : null;
  }

  if (tool === 'Agent' || tool === 'Task') {
    const wanted = { main: 'spadework:design-coordinator', coordinator: 'spadework:architect' }[caller];
    const type = String(toolInput.subagent_type || '').trim();
    if (!wanted) return deny('the architect launches no agents');
    if (type !== wanted) return deny(`the ${caller === 'main' ? 'main chat' : 'coordinator'} launches only ${wanted}, not ${type || 'a general-purpose agent'}`);
    if (toolInput.isolation !== undefined) return deny(`agents run in this session, where these checks run, not with isolation "${toolInput.isolation}"`);
    return null;
  }

  const mcp = mcpTool(tool);
  if (mcp !== null) {
    if (caller !== 'main') return deny(`the ${caller} can't use ${mcp}`);
    if (APP_TOOLS.has(tool)) return null;
    const reason = checkAdoRead(mcp, toolInput, MAIN_READS, lazy(ctx.projects));
    return reason ? deny(reason) : null;
  }

  const others = caller === 'main' ? MAIN_OTHER_TOOLS : AGENT_OTHER_TOOLS;
  return others.has(tool) ? null : deny(`it doesn't use ${tool}`);
}

module.exports = { check, callerOf, LEAVE };
