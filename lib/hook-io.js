'use strict';

// Shared plumbing for Spadework hooks. Plugin hooks run in every session,
// so a hook must never break or slow down the user's normal work: any error
// is written to stderr and the hook exits 0, which allows everything.

const fs = require('fs');

function readInput() {
  const text = fs.readFileSync(0, 'utf8');
  return text.trim() === '' ? {} : JSON.parse(text);
}

// Runs handler(input). The handler returns an object to print as the hook's
// JSON output, or nothing to stay silent.
function runHook(name, handler) {
  try {
    const output = handler(readInput());
    if (output) process.stdout.write(JSON.stringify(output) + '\n');
  } catch (err) {
    process.stderr.write(`spadework ${name}: ${err && err.message ? err.message : err}\n`);
  }
  process.exitCode = 0;
}

// A PreToolUse hook's answer: 'allow' or 'deny' the call, with the reason shown.
const decision = (permissionDecision, reason) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: reason },
});

module.exports = { runHook, decision };
