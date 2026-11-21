---
name: re-triage
description: Plan again the board rows you set to Re-triage, following the feedback and answers you wrote on them. Give row IDs (SHOP-12,SHOP-15) or nothing for every Re-triage row.
argument-hint: "[<row id>[,<row id>]] [--limit N]"
disable-model-invocation: true
---

<!-- spadework-run: triage -->

# Spadework: re-triage

Plan again only rows the user set to Re-triage, right away, instead of waiting for the next triage. Normal triage runs do this too, before new work items.

Arguments: $ARGUMENTS

1. Run exactly `node "${CLAUDE_PLUGIN_ROOT}/scripts/spadework.js" run start triage ${CLAUDE_SESSION_ID}`. If it fails, print its message and stop: without the run, nothing here is guarded.
2. Read `${CLAUDE_PLUGIN_ROOT}/skills/triage/SKILL.md` for its Rules and steps 3 and 4, then in one message load the Azure DevOps tools and run `spadework.js triage plan --retriage --session ${CLAUDE_SESSION_ID}`, adding `--rows <ids>` with the row IDs given (comma-separated) and `--limit N` if given. Follow `${CLAUDE_PLUGIN_ROOT}/skills/triage/retriage.md` with its `retriage_rows`.
