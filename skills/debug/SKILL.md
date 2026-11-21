---
name: debug
description: Diagnose a bug with Spadework's bug triager. Finds the root cause and proposes a fix, without applying it.
argument-hint: "[error message, stack trace, or \"this broke after X\"] | -help"
disable-model-invocation: true
---

# Spadework: debug

If the arguments are `-help` (or start with it), print exactly this and stop:

> **/spadework:debug**: diagnose a bug (doesn't fix it)
> Usage: `/spadework:debug <error, stack trace or description>`
> Example: `/spadework:debug "500 on POST /api/orders after the last deploy"`
> Runs `bug-triager`: confirms the failure, isolates the cause, and proposes a fix for you to review. Never applies it.

Arguments: $ARGUMENTS

1. If no argument was given, ask what's broken (the error, a stack trace, the steps to reproduce) before launching anything. The triager doesn't guess a cause from nothing.
2. **Stack notes**: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/spadework.js" stack` in the current folder.
3. **Code graph**: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/spadework.js" graph --json` in the current folder. Keep `text` and `graph_hint`.
4. Launch `spadework:bug-triager` with the Agent tool. Give it the issue, the Stack notes, `text` under `## Code graph` when it isn't empty, and say this is `/spadework:debug` in the user's repo, so it follows its "In /spadework:debug" part.
5. Show its diagnosis as it is. If the cause turned out to be obvious, say so plainly. Don't apply the fix. If `graph_hint` is set, print it after the diagnosis.
