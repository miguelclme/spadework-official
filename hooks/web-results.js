#!/usr/bin/env node
'use strict';

// PostToolUse hook for WebSearch: in a triage run, saves the links the
// search returned, so the guard lets WebFetch open those and nothing else.
// Outside a Spadework run it does nothing.

const fs = require('fs');

const { runHook } = require('../lib/hook-io');
const paths = require('../lib/paths');

function handle(input) {
  const sessionId = input.session_id;
  if (input.tool_name !== 'WebSearch' || !paths.isValidSessionId(sessionId)) return null;
  if (!fs.existsSync(paths.runFile(sessionId))) return null;
  const run = require('../lib/runs').get(sessionId, { includeStale: true });
  if (!run || run.mode !== 'triage') return null;
  require('../lib/web').recordSearch(sessionId, input.tool_response);
  return null;
}

if (require.main === module) runHook('web-results', handle);

module.exports = { handle };
