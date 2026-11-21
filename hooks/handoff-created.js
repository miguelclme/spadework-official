#!/usr/bin/env node
'use strict';

// PostToolUse hook for wit_work_item_write: in a handoff run, saves the work
// items add_child created, read from the tool's own answer. The guard lets
// the run tag those items and write their numbers on the rows, and no other.
// Outside a handoff run it does nothing.

const fs = require('fs');

const { runHook } = require('../lib/hook-io');
const paths = require('../lib/paths');
const { mcpTool } = require('../lib/guards/common');

function handle(input) {
  const sessionId = input.session_id;
  if (mcpTool(input.tool_name) !== 'wit_work_item_write' || !paths.isValidSessionId(sessionId)) return null;
  if (!fs.existsSync(paths.runFile(sessionId))) return null;
  if ((input.tool_input || {}).action !== 'add_child') return null;
  require('../lib/handoff').recordCreated(sessionId, input.tool_response);
  return null;
}

if (require.main === module) runHook('handoff-created', handle);

module.exports = { handle };
