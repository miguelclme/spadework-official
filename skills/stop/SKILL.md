---
name: stop
description: Stop a running Spadework triage for a project or one of its repos. It finishes the work item it's on, then stops. --force clears a triage that crashed. --row <id> --force ends an implement run whose chat was killed. --merge <repo> --force ends a merge run whose chat was killed.
argument-hint: "--project <name> [--repo <name>] [--force] | --row <id> --force | --merge <repo> [--project <name>] --force | -help"
disable-model-invocation: true
---

# Spadework: stop

If the arguments are `-help` (or start with it), print exactly this and stop:

> **/spadework:stop**: stop a running triage
> Usage: `/spadework:stop --project <name>` (every repo of the project) or `/spadework:stop --project <name> --repo <name>` (one repo). Add `--force` for a triage that crashed.
> The triage finishes the work item it's on (so no half-written plan), then stops and frees the repo.
> `--force` frees the repo right away. Use it only for a triage that crashed or was closed, or that the user interrupted: a running one only notices at its next item, so the item it's on may still be written.
> `/spadework:stop --row <id> --force`: for an implement run whose chat was killed or closed. It ends that run now and sets the row to Blocked, puts pushing back on, frees the row, and switches the repo back to its main branch (unless it has uncommitted changes). Set the row to Resume to go on from its branch.
> `/spadework:stop --merge <repo> --force`: for a merge run whose chat was killed or closed. Add `--project <name>` when two projects have a repo with that name. It ends that run now, puts the merge's folder back at the last finished step, puts pushing back on, and switches the repo back to its main branch (unless it has changes). Rows are not changed, and the integration branch is kept.
> To pause scheduled triage for good, pause its task in the Claude desktop app (Code tab → Routines).

Arguments: $ARGUMENTS

The helper CLI is `node "${CLAUDE_PLUGIN_ROOT}/scripts/spadework.js"`.

1. If `--row` was given, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/spadework.js" stop --row "<id>"`, adding `--force` if it was given. Show its message word for word, and stop.
   If `--merge` was given, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/spadework.js" stop --merge "<repo>"`, adding `--project "<project>"` and `--force` if they were given. Show its message word for word, and stop.
2. If no `--project` was given, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/spadework.js" run list`, show which repos have a triage running (they're shown as "Project/repo"), and ask which project or repo to stop.
3. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/spadework.js" stop --project "<project>"`, adding `--repo "<repo>"` and `--force` if they were given.
4. Show its message word for word.
