#!/usr/bin/env node
'use strict';

// UserPromptSubmit and UserPromptExpansion hook.
// Starts a Spadework run when the user types /spadework:init,
// /spadework:triage, /spadework:re-triage (a triage run),
// /spadework:implement, /spadework:handoff, /spadework:merge, /spadework:design or
// /spadework:design-push, short forms included. Any other skill or command
// ends the session's run, except Spadework's own read-only skills (board,
// stats, validate, stop, schedule), which count as activity like a plain
// prompt. A plain prompt also restarts a triage run that was cut off (see run-cleanup).
//
// How a Spadework command is recognised:
// - UserPromptSubmit fires first, with the text the user typed. Only the
//   namespaced form counts here: a bare "/triage" could be the user's own skill.
// - UserPromptExpansion fires next, for skills only. Its command_name is
//   "plugin:spadework:<skill>" for ours, whichever form was typed.
// - As a backup, each run skill carries a hidden marker on its own line:
//   <!-- spadework-run: triage -->
//   It counts only on UserPromptExpansion, where the text comes from the skill.
// A scheduled task's prompt is plain text ("Run the spadework:triage skill
// with: --project Shop"), never a slash command, so Claude loads the skill
// itself and no prompt starts the run: the guard hook starts it then, and
// `triage plan` checks that a run is on.

const { runHook } = require('../lib/hook-io');
const runs = require('../lib/runs');

// Skills that start a run, and the run's mode.
const SKILL_MODES = { init: 'init', triage: 'triage', 're-triage': 'triage', implement: 'implement', handoff: 'handoff', merge: 'merge', design: 'design', 'design-push': 'design-push' };
const SKILL_NAMES = Object.keys(SKILL_MODES).join('|');
const MODE_NAMES = runs.MODES.join('|');
const TYPED = new RegExp(`^\\s*/spadework:(${SKILL_NAMES})(?=\\s|$)`);
const COMMAND_NAME = new RegExp(`^(?:plugin:)?spadework:(${SKILL_NAMES})$`);
// Spadework's own skills that only read: looking at the board or the stats
// while agents work doesn't end the run.
const READ_ONLY_SKILL = /^(?:plugin:)?spadework:(board|stats|validate|stop|schedule)$/;
const DESIGN_ANSWER_LINE = 'Spadework design run: this message answers the questions. Save it with "design answers", then launch the coordinator again, as the design skill says. The design guard is on.';
const MARKER = new RegExp(`^[ \\t]*<!--\\s*spadework-run:\\s*(${MODE_NAMES})\\s*-->[ \\t]*$`, 'm');

// What the prompt means for run tracking:
// { start: mode }, { end: true } or { activity: true }.
function classify(input) {
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';

  if (input.hook_event_name === 'UserPromptExpansion') {
    const name = typeof input.command_name === 'string' ? input.command_name : '';
    const named = name.match(COMMAND_NAME);
    if (named) return { start: SKILL_MODES[named[1]] };
    if (READ_ONLY_SKILL.test(name)) return { activity: true };
    const marked = prompt.match(MARKER);
    return marked ? { start: marked[1] } : { end: true };
  }

  if (input.hook_event_name === 'UserPromptSubmit') {
    // Only the typed command counts here. The marker is checked on
    // UserPromptExpansion, where it comes from the skill itself: text the
    // user pastes that happens to contain it doesn't start a run.
    const typed = prompt.match(TYPED);
    return typed ? { start: SKILL_MODES[typed[1]] } : { activity: true };
  }

  return null;
}

function handle(input) {
  const sessionId = input.session_id;
  if (!runs.isValidSessionId(sessionId)) return null;
  const action = classify(input);
  if (!action) return null;

  if (action.activity) {
    // The triage in this chat was cut off: a "continue" goes on with its guards on.
    if (runs.takeUnfinished(sessionId) && !runs.get(sessionId) && runs.start(sessionId, 'triage', { cwd: input.cwd ?? null }).ok) {
      return {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: 'Spadework: the triage in this chat stopped before it finished, so its safety checks are on again for this turn.',
        },
      };
    }
    runs.touch(sessionId);
    // A design run waiting for answers: this message is them. The line holds
    // the flow even after the chat's context is compacted.
    const run = input.hook_event_name === 'UserPromptSubmit' ? runs.get(sessionId) : null;
    if (run && run.mode === 'design' && run.design && run.design.state === 'questions') {
      return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: DESIGN_ANSWER_LINE } };
    }
    return null;
  }
  if (action.end) {
    // A run of a logged mode ended this way still goes to the log, for /spadework:stats.
    const run = runs.get(sessionId, { includeStale: true });
    if (run && runs.isLogged(run.mode)) require('../lib/log').appendRun(run);
    runs.end(sessionId);
    return null;
  }

  runs.pruneStale();
  const result = runs.start(sessionId, action.start, { cwd: input.cwd ?? null });
  if (result.ok) return null;
  return { decision: 'block', reason: `Spadework: ${result.error}` };
}

if (require.main === module) runHook('run-tracker', handle);

module.exports = { classify, handle, DESIGN_ANSWER_LINE };
