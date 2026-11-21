---
name: schedule
description: List, add, change, pause or delete scheduled Spadework triages in the Claude desktop app, one per project, one repo or all projects.
argument-hint: "[<project>|all [--repo <name>] <when> | <project>|all [--repo <name>] pause|resume|delete] | -help"
disable-model-invocation: true
---

# Spadework: schedule

If the arguments are `-help` (or start with it), print exactly this and stop:

> **/spadework:schedule**: scheduled triage in the Claude desktop app
> `/spadework:schedule`: list them
> `/spadework:schedule Shop weekdays 9:00`: triage project Shop on weekdays at 9:00 (adds it, or changes the time of the one there)
> `/spadework:schedule Shop --repo api daily 13:30`: one repo of a project
> `/spadework:schedule all weekdays 8:45`: every project in one run
> `/spadework:schedule Shop pause` (or `resume`, `delete`)
> Tasks run only while the desktop app is open. A run is skipped while another scheduled task is still running, so leave time between them.

Arguments: $ARGUMENTS

## Rules

- The only changes are Spadework's scheduled tasks, made with the tools ending in `list_scheduled_tasks`, `create_scheduled_task`, `update_scheduled_task` and `delete_scheduled_task`. Never touch other tasks, and never write files.
- A task is Spadework's if its prompt (the body of the SKILL.md at its `path`) starts with `prompt_start` from step 1.
- A task's ID, title and prompt always come from `spadework.js schedule target`, exactly as it returns them. Never write or change them yourself.
- Keep messages short. For a choice, use the AskUserQuestion tool.
- **Helper lines word for word.** Print each line the helper gives exactly as it is, alone or in the step's own line. Add nothing of yours around it: no rewording, summary or advice, no code block unless the step asks, and don't say it again later.

The helper CLI is `node "${CLAUDE_PLUGIN_ROOT}/scripts/spadework.js"`.

## 1. Check

1. Run `spadework.js schedule target --json`. If `ok` is false, say "Run /spadework:validate first" and stop. Keep `prompt_start`.
2. If the scheduled task tools don't exist (for example in the terminal), say: "Scheduled tasks live in the Claude desktop app. There: Code tab → Routines → New routine → Local. Folder: <root>. Worktree: off. Instructions: <prompt>". `<root>` is from `spadework.js paths --json`, and `<prompt>` from `spadework.js schedule target` with the target the user gave (step 3), or with no target the one from step 1. Then stop.
3. Call `list_scheduled_tasks` and keep Spadework's tasks, with their `taskId`, `title`, `schedule`, `enabled` and `nextRunAt`.

## 2. List (no arguments)

Show one line per Spadework task: its title, schedule, next run, and "paused" if it's not enabled. With none, say "No scheduled triage yet. Example: /spadework:schedule <first project> weekdays 9:00". Then stop.

## 3. Read the arguments

- **Target**: `all` (every project), or a project name, plus an optional `--repo` with one of its repos. `--project <name>` also names a project; use it for a project that is itself called "All".
- **Action**: `pause`, `resume` or `delete`, or else a time, like `weekdays 9:00`, `daily 13:30`, `mondays 8:00`. Turn the time into a 5-field cron in local time (`0 9 * * 1-5`, `30 13 * * *`, `0 8 * * 1`). If it's unclear, ask.

Run `spadework.js schedule target --json`: with no flags for `all`, else `--project "<project>"`, plus `--repo "<repo>"` for one repo. If `ok` is false, print `error` (it names the projects or repos there are) and stop. Keep `task_id`, `title` and `prompt`.

Two targets can end up with the same `task_id` (project `Shop` with repo `api`, and project `Shop-api`), so a task belongs to a target by its **prompt**: the target's task is the Spadework task whose prompt is exactly `prompt`. Never change or delete a task whose prompt is different, even if its taskId matches.

## 4. Pause, resume, delete

Find the Spadework task whose prompt is `prompt`. If there's none, say so and list the ones there are. Otherwise call `update_scheduled_task` with `enabled` false (pause) or true (resume), or `delete_scheduled_task` (delete). Say what changed.

## 5. Add or change

1. **Already there**: if a Spadework task's prompt is `prompt`, call `update_scheduled_task` with the new `cronExpression` (and `enabled` true). Say the new schedule in words, and stop.
2. **Folder**: a new task starts in this session's folder, and that can't be changed from here. Get `root` from `spadework.js paths --json`. If this session's working folder isn't `root`, ask: "This task will start in <folder>, so every run loads that folder's CLAUDE.md and project settings. Better: open a new session in <root> and run this there, or create it now and change the folder later in Code tab → Routines → the task → Edit." Options: "Create it anyway", "Cancel".
3. **Create**: the taskId is `task_id`; if another task already uses it, add `-2` (or `-3`, and so on) until it's free. Call `create_scheduled_task` with that taskId, `title` and `prompt`, `description` "Plans new Azure DevOps work items onto the local board", the `cronExpression` and `notifyOnCompletion` false.
4. **Tell the user**, in short:
   - when it runs, in words
   - it runs only while the desktop app is open; a missed run happens once when the app opens again
   - a run is skipped while another scheduled task is still running. If another Spadework task starts less than 30 minutes before or after this one, say so and suggest more time between them. Skipped runs show in the task's history in Routines
   - try it once: Code tab → Routines → the task → **Run now**. It shouldn't ask for anything: Spadework's guard checks and approves each step of a triage. If it does ask, choose **Deny** (never "always allow") and run /spadework:validate
