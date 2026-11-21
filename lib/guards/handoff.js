'use strict';

// handoff-guard: in a handoff run, Spadework may read work items and create
// the Requirements of a split in Azure DevOps, nothing else (the rows are on
// the board, which only Spadework's helper writes):
// - files and shell: nothing, except Spadework's helper (handoff and the
//   run's own check). Reading only the saved tool results of this chat.
// - Azure DevOps: reads. The only writes are:
//   - add_child, for a Feature this run checked, the type its row has and a
//     title the helper returned
//   - the handoff tag and its row's tag, on a work item this run created
//   - the Predecessor links between the work items the helper saved for this run
//   The helper saved all of these in the run file and this guard checks
//   against it, so text in a work item or a row can't make handoff create or
//   change anything else.

const { SHELL_TOOLS, FILE_TOOLS, READ_TOOLS, readPaths, mcpTool, APP_TOOLS, checkAdoRead, checkCli, checkHelperOnly, checkTagOps, isOwnSessionFile, lazy } = require('./common');
const { HANDOFF_TAG: TAG, rowTag, sameName } = require('../config');

const CLI_ALLOWED = new Set(['handoff', 'run']);
// The Azure DevOps reads handoff makes: a Feature and its children.
const READS = { wit_work_item: ['get', 'get_batch'] };
// The only fields add_child may set on a child (iterationPath and the
// assignee are the tech lead's to set in Azure DevOps).
const CHILD_FIELDS = new Set(['title', 'description', 'format', 'areaPath']);

// Tools besides files, shell and MCP that a handoff run may use.
const OTHER_TOOLS = new Set(['ToolSearch', 'Skill', 'TodoWrite', 'TodoRead', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);

const deny = (reason) => `Spadework handoff: ${reason}.`;

// add_child: this Feature, this type, these titles with their area paths.
// keyOf: what tells two planned items apart (a row for handoff).
function checkAddChild(toolInput, handoff, keyOf = (entry) => entry.row_id) {
  const parent = handoff && handoff.parents[Number(toolInput.parentId)];
  if (!parent) return `it can only create work items under a Feature whose rows it checked, not #${toolInput.parentId}`;
  if (!sameName(toolInput.workItemType, parent.creates)) return `the work items it creates are ${parent.creates}, not ${toolInput.workItemType}`;
  if (toolInput.project && !sameName(toolInput.project, parent.project)) return `#${toolInput.parentId} is in project ${parent.project}`;
  if (!Array.isArray(toolInput.items) || !toolInput.items.length) return 'add_child needs the items to create';
  const seen = new Set();
  for (const item of toolInput.items) {
    const extra = Object.keys(item || {}).find((key) => !CHILD_FIELDS.has(key));
    if (extra) return `a new work item may not set ${extra}`;
    const allowed = Object.entries(parent.items).find(([title]) => sameName(title, item.title));
    if (!allowed) return `"${item.title}" isn't a title the helper returned for #${toolInput.parentId}`;
    // Each row is created once: not twice in this call, and not again after it was created.
    const key = keyOf(allowed[1]);
    if (seen.has(key) || handoff.created.some((done) => keyOf(done) === key)) return `"${item.title}" is already created`;
    seen.add(key);
    if (item.areaPath !== undefined && !sameName(item.areaPath, allowed[1].area_path)) return `the area path of "${item.title}" is ${allowed[1].area_path}`;
  }
  return null;
}

// update: only the handoff tag and the tag of the row this work item
// came from (Spadework-SHOP-41), only on a work item this run created or adopted.
function checkTag(toolInput, handoff) {
  const target = handoff && handoff.created.find((item) => item.id === Number(toolInput.id));
  if (!target) return `#${toolInput.id} wasn't created by this run`;
  const allowed = [TAG, rowTag(target.row_id)];
  return checkTagOps(toolInput, allowed, [TAG]);
}

// wit_work_item_link_write: only action "link", and every entry of updates
// is one of the links the helper saved for this run: the same id, linkToId
// and type, and nothing else in it. A project, when given, is that link's.
function checkLink(toolInput, handoff) {
  if (String(toolInput.action || '') !== 'link') return `wit_work_item_link_write ${toolInput.action || ''} isn't used by handoff`;
  const saved = (handoff && Array.isArray(handoff.links)) ? handoff.links : [];
  const updates = Array.isArray(toolInput.updates) ? toolInput.updates : [];
  if (!updates.length) return 'a link write needs the links to add';
  for (const update of updates) {
    const entry = update && typeof update === 'object' ? update : {};
    const extra = Object.keys(entry).find((key) => !['id', 'linkToId', 'type'].includes(key));
    if (extra) return `a link may not set ${extra}`;
    const known = saved.find((link) => link.id === entry.id && link.linkToId === entry.linkToId && link.type === entry.type);
    if (!known) return `the link from #${entry.id} to #${entry.linkToId} (${entry.type}) isn't one the helper returned for this run`;
    if (toolInput.project && known.project && !sameName(toolInput.project, known.project)) return `#${entry.id} is in project ${known.project}`;
  }
  return null;
}

// Returns a reason to block, or null.
// ctx: { sessionId, run (the session's run, with its handoff data), projects
// (the configured project names, or a function giving them) }
function check(input, ctx = {}) {
  const tool = input.tool_name || '';
  const toolInput = input.tool_input || {};
  const cwd = input.cwd || process.cwd();
  const handoff = (ctx.run && ctx.run.handoff) || null;

  if (FILE_TOOLS.has(tool)) return deny('it writes no files');
  if (READ_TOOLS.has(tool)) {
    // A big tool answer is saved by Claude Code in a file of this chat: the only file read.
    const files = [...readPaths(toolInput, cwd)];
    return files.length && files.every((file) => isOwnSessionFile(file, ctx.sessionId)) ? null : deny('it reads no files except the saved results of this chat');
  }
  if (tool === 'Agent' || tool === 'Task') return deny('it launches no agents');

  const mcp = mcpTool(tool);
  if (mcp !== null) {
    if (APP_TOOLS.has(tool)) return null;
    if (mcp === 'wit_work_item') {
      const reason = checkAdoRead(mcp, toolInput, READS, lazy(ctx.projects));
      return reason ? deny(reason) : null;
    }
    if (mcp === 'wit_work_item_write') {
      const action = String(toolInput.action || '');
      const reason = action === 'add_child' ? checkAddChild(toolInput, handoff)
        : action === 'update' ? checkTag(toolInput, handoff)
          : `wit_work_item_write ${action} isn't used by handoff`;
      return reason ? deny(reason) : null;
    }
    if (mcp === 'wit_work_item_link_write') {
      const reason = checkLink(toolInput, handoff);
      return reason ? deny(reason) : null;
    }
    return deny(`it can't use ${mcp}`);
  }

  if (SHELL_TOOLS.has(tool)) {
    const reason = checkHelperOnly(tool, toolInput, cwd, 'handoff', (cli) => checkCli(cli, { mode: 'handoff', sessionId: ctx.sessionId, allowed: CLI_ALLOWED }));
    return reason ? deny(reason) : null;
  }
  // Only the tools the skill uses: whatever isn't named here is refused.
  return OTHER_TOOLS.has(tool) ? null : deny(`it doesn't use ${tool}`);
}

module.exports = { check, checkAddChild, checkTag, checkLink, CLI_ALLOWED, OTHER_TOOLS };
