#!/usr/bin/env node
'use strict';

// Stop and SessionEnd hook.
// Triage, implement, handoff, merge and design-push are one turn each, so
// their run ends on Stop, or on a later Stop if their agents still work
// (stillWorking).
// A triage that still held a repo lock was cut off: it's marked, and the
// next prompt in the chat starts its run again (run-tracker).
// Init goes back and forth with the user, so Stop only records activity.
// Design does the same until the helper marks its run as done; the Stop
// at the end of that turn then ends it.
// Init ends its own run as its last step (`spadework.js run end`), or when
// another skill starts, or after runs.CUT_OFF_AFTER_MS with no activity.
// SessionEnd ends any run, but Desktop chats are rarely closed, so nothing
// depends on it. Every run mode that ends is logged, except init.
// Never blocks: Stop must not keep Claude going, and SessionEnd can't block.

const { runHook } = require('../lib/hook-io');
const runs = require('../lib/runs');

// Agents run in the background: a turn can end while one is still working,
// and its report starts the next turn. Claude Code lists them on Stop, but
// that list can miss one, so the run's own state counts too: a triage item
// claimed and not finished yet, or an implement row still In progress. The
// run (and its guards) stays on until a turn ends with none of these left:
// the turn that calls finish.
const agentsRunning = (input) => (Array.isArray(input.background_tasks) ? input.background_tasks : [])
  .some((task) => task && task.type === 'subagent' && task.status === 'running');

function stillWorking(run, input) {
  if (agentsRunning(input)) return true;
  if (run.mode === 'triage') return runs.holdsClaim(run.session_id);
  if (run.mode === 'implement') return require('../lib/implement').holdsRow(run.session_id);
  // A merge waits for the resolver or the reviewer while its record says so.
  if (run.mode === 'merge') {
    const record = require('../lib/guards/merge').recordOf(run.session_id);
    return Boolean(record && ['resolving', 'reviewing'].includes(record.state));
  }
  return false;
}

function handle(input) {
  const sessionId = input.session_id;
  if (!runs.isValidSessionId(sessionId)) return null;
  const run = runs.get(sessionId, { includeStale: true });
  if (!run) return null;

  // A design run goes on across turns until the helper marks it as done,
  // and while its agents still work.
  const ends = input.hook_event_name === 'SessionEnd'
    || (input.hook_event_name === 'Stop' && (runs.isOneTurn(run.mode) || (run.mode === 'design' && require('../lib/design').isOver(run))) && !stillWorking(run, input));
  // Implement and merge turned pushing off in the repos they worked in: back
  // on now. A row or merge left unfinished keeps its file, for recovery.
  if (ends && (run.mode === 'implement' || run.mode === 'merge')) require('../lib/push-block').releasePushBlocks(sessionId);
  // For /spadework:stats: when the run was, and where its tokens are.
  if (ends && runs.isLogged(run.mode)) require('../lib/log').appendRun(run, { transcriptPath: input.transcript_path });

  if (input.hook_event_name === 'SessionEnd') runs.end(sessionId);
  else if (input.hook_event_name === 'Stop') {
    if (ends) {
      // A triage cut off mid-way: the next prompt in this chat restarts its guards.
      const unfinished = run.mode === 'triage' && runs.holdsLock(sessionId);
      runs.end(sessionId);
      if (unfinished) runs.markUnfinished(sessionId);
    } else if (!run.stale) runs.touch(sessionId);
  }
  return null;
}

if (require.main === module) runHook('run-cleanup', handle);

module.exports = { handle };
