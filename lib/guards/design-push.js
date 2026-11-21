'use strict';

// design-push-guard: a design-push run creates the Epic and Features of one
// reviewed placement file, nothing else. design-push is one turn long, so
// the strict checks of hooks/guard.js run first. Then:
// - files: none. Read only this chat's saved tool results
// - shell: only Spadework's helper (run start, run check, design-push check,
//   filter and created)
// - agents: none
// - Azure DevOps: reads (wit_work_item get and get_batch, wit_query wiql) in
//   a configured project. The writes are checked against the push list the
//   helper saved in the run file (run.design_push):
//   - create: once, the new Epic of the list, while it has no number yet:
//     its project, type, title, text and area path, and the two tags or none
//   - add_child: handoff's check, on the list's Features under its Epic
//   - update: only the two tags, on an item this run created or adopted

const { SHELL_TOOLS, FILE_TOOLS, READ_TOOLS, readPaths, mcpTool, APP_TOOLS, checkAdoRead, checkCli, checkHelperOnly, checkTagOps, isOwnSessionFile, lazy } = require('./common');
const { checkAddChild, OTHER_TOOLS } = require('./handoff');
const { sameName } = require('../config');
const { TAGS, hasBothTags } = require('../design-push');

const CLI_ALLOWED = new Set(['design-push', 'run']);
const ACTIONS = ['check', 'filter', 'created'];
const READS = { wit_work_item: ['get', 'get_batch'], wit_query: ['wiql'] };
// The fields create may set on the new Epic.
const EPIC_FIELDS = ['System.Title', 'System.Description', 'System.AreaPath', 'System.Tags'];

const deny = (reason) => `Spadework design-push: ${reason}.`;

// create: the new Epic of the push list, once.
function checkCreate(toolInput, push) {
  const epic = push && push.epic;
  if (!epic || epic.id) return 'it creates an Epic only when the placement file has a new Epic, and only once';
  if (!sameName(toolInput.workItemType, 'Epic')) return `it creates only the Epic, not ${toolInput.workItemType || 'a work item with no type'}`;
  if (!sameName(toolInput.project, push.project)) return `the Epic goes in project ${push.project}`;
  const fields = Array.isArray(toolInput.fields) ? toolInput.fields : [];
  const value = (name) => fields.find((field) => field && sameName(field.name, name));
  for (const field of fields) {
    if (!field || typeof field !== 'object') return 'each field is { name, value }';
    const extra = Object.keys(field).find((key) => !['name', 'value', 'format'].includes(key));
    if (extra) return `a field may not set ${extra}`;
    if (!EPIC_FIELDS.some((name) => sameName(name, field.name))) return `the new Epic may not set ${field.name}`;
  }
  const names = fields.map((field) => String(field.name).toLowerCase());
  if (new Set(names).size !== names.length) return 'a field is given twice';
  if (!value('System.Title') || String(value('System.Title').value) !== epic.title) return `the Epic's title is "${epic.title}"`;
  if (!value('System.AreaPath') || !sameName(value('System.AreaPath').value, push.area_path)) return `the Epic's area path is ${push.area_path}`;
  if (value('System.Description') && String(value('System.Description').value) !== epic.description) return 'the Epic\'s description is the one design-push check gave';
  if (value('System.Tags') && !hasBothTags(value('System.Tags').value, { exact: true })) return `the Epic's tags are exactly "${TAGS.join('; ')}"`;
  return null;
}

// update: the two tags, on an item this run created.
function checkTagUpdate(toolInput, push) {
  const id = Number(toolInput.id);
  const known = push && ((push.epic && push.epic.id === id && push.epic.created) || push.created.some((item) => item.id === id && !item.adopted));
  if (!known) return `#${toolInput.id} wasn't created by this run`;
  return checkTagOps(toolInput, TAGS, TAGS);
}

// Returns a reason to block, or null.
// ctx: { sessionId, run (with run.design_push), projects (names, or a function giving them) }
function check(input, ctx = {}) {
  const tool = input.tool_name || '';
  const toolInput = input.tool_input || {};
  const cwd = input.cwd || process.cwd();
  const push = (ctx.run && ctx.run.design_push) || null;

  if (FILE_TOOLS.has(tool)) return deny('it writes no files');
  if (READ_TOOLS.has(tool)) {
    const files = [...readPaths(toolInput, cwd)];
    return files.length && files.every((file) => isOwnSessionFile(file, ctx.sessionId)) ? null : deny('it reads no files except the saved results of this chat');
  }
  if (tool === 'Agent' || tool === 'Task') return deny('it launches no agents');

  const mcp = mcpTool(tool);
  if (mcp !== null) {
    if (APP_TOOLS.has(tool)) return null;
    if (mcp === 'wit_work_item_write') {
      const action = String(toolInput.action || '');
      const reason = action === 'create' ? checkCreate(toolInput, push)
        : action === 'add_child' ? (push ? checkAddChild(toolInput, push, (entry) => entry.key) : 'there is no push list in this run yet: run design-push check first')
          : action === 'update' ? checkTagUpdate(toolInput, push)
            : `wit_work_item_write ${action} isn't used by design-push`;
      return reason ? deny(reason) : null;
    }
    const reason = checkAdoRead(mcp, toolInput, READS, lazy(ctx.projects));
    return reason ? deny(reason) : null;
  }

  if (SHELL_TOOLS.has(tool)) {
    const reason = checkHelperOnly(tool, toolInput, cwd, 'design-push', (cli) => {
      const [sub, action] = cli.map((arg) => String(arg).toLowerCase());
      if (sub === 'design-push' && !ACTIONS.includes(action)) return `spadework.js design-push ${action || ''} isn't used (only ${ACTIONS.join(', ')})`;
      return checkCli(cli, { mode: 'design-push', sessionId: ctx.sessionId, allowed: CLI_ALLOWED });
    });
    return reason ? deny(reason) : null;
  }
  return OTHER_TOOLS.has(tool) ? null : deny(`it doesn't use ${tool}`);
}

module.exports = { check, checkCreate, CLI_ALLOWED };
