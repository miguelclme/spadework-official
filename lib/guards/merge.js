'use strict';

// merge-guard: in a merge run, the helper does every git command, and the
// only files changed with tools are the files in conflict, while the
// resolver works on them:
// - Edit and MultiEdit: only while the merge record says `resolving`, and
//   only the files in its conflict_files, inside the merge's folder. Never a
//   Claude Code or git settings file.
// - Write and NotebookEdit: never.
// - Read, Grep, Glob: the merge's folder, this run's own context files
//   (tmp/merge-<run id>-*) and the saved tool results of this chat.
// - Bash and PowerShell: only Spadework's helper (merge, run, stack). No git
//   and no other program.
// - Agents: only the merge resolver and the code reviewer.
// - MCP: only the desktop app's own tools. No web.
// The chat's merge record (run/merging/<repo key>.json) is found by its session.

const path = require('path');
const paths = require('../paths');
const { listRecords } = require('../push-block');
const {
  SHELL_TOOLS, FILE_TOOLS, READ_TOOLS, writtenFiles, mcpTool, APP_TOOLS, checkCli, checkHelperOnly, isOwnSessionFile, isInside, isClaudeCodeConfig, isConfigFile, norm,
} = require('./common');
const { checkReadTool } = require('./reads');
const { OTHER_TOOLS } = require('./handoff');

const CLI_ALLOWED = new Set(['merge', 'run', 'stack']);
const AGENTS = new Set(['spadework:merge-resolver', 'spadework:code-reviewer']);
// SubagentHandback is how an agent sends its report back to the run.
const MERGE_OTHER_TOOLS = new Set([...OTHER_TOOLS, 'SubagentHandback']);

const deny = (reason) => `Spadework merge: ${reason}.`;

// This chat's merge record, or null.
const recordOf = (sessionId) => listRecords(paths.all().merging).find((entry) => entry.session_id === sessionId) || null;

// Whether the run may read the file: its folder, its own context files, this chat's saved results.
function readable(file, record, sessionId) {
  if (isOwnSessionFile(file, sessionId)) return true;
  if (!record) return false;
  if (record.workspace && isInside(file, record.workspace)) return true;
  const own = record.run_id ? `merge-${record.run_id}-` : null;
  return Boolean(own) && isInside(file, paths.all().tmp) && path.basename(file).startsWith(own) && path.dirname(norm(file)) === norm(paths.all().tmp);
}
const WHERE = 'merge reads only its folder, its own context files and this chat\'s saved results';

// Edit and MultiEdit: the files in conflict, while they are being resolved.
function checkEdit(toolInput, cwd, record) {
  if (!record || record.state !== 'resolving') return 'it edits files only while a conflict is being resolved';
  const conflicts = (Array.isArray(record.conflict_files) ? record.conflict_files : []).map((file) => norm(path.resolve(record.workspace, file)));
  const files = writtenFiles(toolInput, cwd);
  if (!files.length) return 'an edit needs the file it changes';
  for (const file of files) {
    if (!isInside(file, record.workspace) || isClaudeCodeConfig(file, record.workspace) || isConfigFile(file, record.workspace) || !conflicts.includes(norm(file))) {
      return `it edits only the files in conflict, not ${file}`;
    }
  }
  return null;
}

// Returns a reason to block, or null. ctx: { sessionId }
function check(input, ctx = {}) {
  const tool = input.tool_name || '';
  const toolInput = input.tool_input || {};
  const cwd = input.cwd || process.cwd();
  const record = recordOf(ctx.sessionId);

  if (tool === 'Edit' || tool === 'MultiEdit') {
    const reason = checkEdit(toolInput, cwd, record);
    return reason ? deny(reason) : null;
  }
  if (FILE_TOOLS.has(tool)) return deny(`it doesn't use ${tool}: only the files in conflict are edited`);
  if (READ_TOOLS.has(tool)) {
    const reason = checkReadTool(toolInput, cwd, { inside: (file) => readable(file, record, ctx.sessionId), where: WHERE });
    return reason ? deny(reason) : null;
  }
  if (tool === 'Agent' || tool === 'Task') {
    const type = String(toolInput.subagent_type || '').trim();
    return AGENTS.has(type) ? null : deny(`it launches only spadework:merge-resolver and spadework:code-reviewer, not ${type || 'a general-purpose agent'}`);
  }
  if (mcpTool(tool) !== null) return APP_TOOLS.has(tool) ? null : deny(`it can't use ${mcpTool(tool)}`);
  if (SHELL_TOOLS.has(tool)) {
    const reason = checkHelperOnly(tool, toolInput, cwd, 'merge', (cli) => checkCli(cli, { mode: 'merge', sessionId: ctx.sessionId, allowed: CLI_ALLOWED }));
    return reason ? deny(reason) : null;
  }
  return MERGE_OTHER_TOOLS.has(tool) ? null : deny(`it doesn't use ${tool}`);
}

module.exports = { check, recordOf, CLI_ALLOWED };
