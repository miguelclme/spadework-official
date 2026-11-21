---
name: stats
description: Show what Spadework's triage, implement and handoff runs of the last days did, how long they took and the tokens they used, per agent.
argument-hint: "[--days N] | -help"
disable-model-invocation: true
---

# Spadework: stats

If the arguments are `-help` (or start with it), print exactly this and stop:

> **/spadework:stats**: what the last triage, implement and handoff runs cost
> Usage: `/spadework:stats` (the last 7 days) or `/spadework:stats --days N` (1 to 30).
> One block per run: when it started, how long it took, its repos, the results of its items, and its tokens per agent (input, cache write, cache read, output).
> Tokens come from the chat's transcript. A run whose chat was deleted shows no tokens. For everyday commands, use `/cost`.

Arguments: $ARGUMENTS

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/spadework.js" stats`, adding `--days <N>` if it was given.
2. Print its output as it is, inside a code block. Add nothing else.
