#!/usr/bin/env node
'use strict';

// PostToolUse hook for wit_work_item_write: in a design-push run, saves the
// Epic that create made and the Features that add_child made, read from the
// tool's own answer. The guard lets the run tag those items, and the next
// push of the same design finds them. Outside a design-push run, and for
// any other action, it does nothing.

const fs = require('fs');

const { runHook } = require('../lib/hook-io');
const paths = require('../lib/paths');
const { mcpTool } = require('../lib/guards/common');

function handle(input) {
  const sessionId = input.session_id;
  if (mcpTool(input.tool_name) !== 'wit_work_item_write' || !paths.isValidSessionId(sessionId)) return null;
  if (!fs.existsSync(paths.runFile(sessionId))) return null;
  const action = (input.tool_input || {}).action;
  if (action !== 'create' && action !== 'add_child') return null;
  require('../lib/design-push').recordCreated(sessionId, input.tool_input, input.tool_response);
  return null;
}

if (require.main === module) runHook('design-push-created', handle);

module.exports = { handle };
