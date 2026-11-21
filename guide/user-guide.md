# Using Spadework

This guide is for day-to-day use: planning work items, reviewing plans on the board, building the approved ones, and doing it all without wasting tokens. To install and set up Spadework, see the [README](../README.md).

Examples use a made-up project, Shop, with the repo `shop-api` and rows `SHOP-1`, `SHOP-2` and so on.

## A normal day

1. **Before you start**, a scheduled triage has planned your new work items. Or you run `/spadework:triage` yourself.
2. **Open the board** with `/spadework:board`. Read the new plans, answer the questions, and approve, send back or reject each row.
3. **Re-plan the rows you sent back** with `/spadework:re-triage`, or let the next triage do it.
4. **Build** the approved rows with `/spadework:implement SHOP-12,SHOP-14`, from the repo's folder.
5. **Review each branch and push it yourself.**

Start a new chat for each of these. See [Using it cheaply](#using-it-cheaply) for why.

## Triage

Triage reads your work items, finds the code each one touches, and writes a plan as a row on the board. It never changes code, and it never asks you anything in the chat. A question goes on the row instead.

### Backlog or single item

| | Backlog run | Single item |
|---|---|---|
| **Command** | `/spadework:triage` | `/spadework:triage 4521` |
| **What it reads** | Your backlog: work items assigned to you, in the configured states and types, under each repo's team area paths. Highest priority first. | That one work item, if it's in your backlog. |
| **What it plans** | New items, and items whose content changed. It leaves unchanged items alone. | That item, even when nothing changed, as long as its row is New, Needs info or Re-triage. |
| **How many** | Up to 10 per run by default (`max_cards_per_run`). The rest waits for the next run. | One. |
| **Use it** | Every day, or on a schedule. | When one item is urgent, or you want a fresh plan for it now. |

**A backlog run is the cheaper way to plan many items.** It does the setup once and plans each item in turn. Planning items one by one repeats that setup every time.

**A single item checks every repo of its project**, because it doesn't know yet which repo the item belongs to. If you know, a backlog run narrowed with `--project` and `--repo` reads less.

### Options

| Option | What it does |
|---|---|
| `--project <project_name>` | All the project's repos. |
| `--project <project_name> --repo <repo_name>` | Only one project's repo. Several: `--repo shop-api,shop-web`. |
| `--limit 3` | Plan at most 3 items in this run. Skipped items don't count. |
| `--since 2026-11-01` | Only items created on or after that date. |
| `4521 --deep` | One item, with a wider code search. It costs a little more. |

### What counts as a change

Triage plans an item again only when what it asks for changes: its title, type or text fields. A new state, sprint, assignee, tag or comment doesn't count, so moving an item on your Azure DevOps board never plans it again.

One exception: a new comment on a work item whose row is **Needs info** plans it again, because the comment is often the answer to the row's questions.

When an item changes after you approved its row, triage doesn't touch the plan. The row's history gets a note, like "Changed after Approved, rev 4 → 5; plan kept". The rev is the work item's revision number in Azure DevOps, which goes up by one every time the item is saved. Set the row to Re-triage if you want a new plan.

### Bugs

A Bug often lives in a branch that isn't merged yet. So the first triage of a Bug doesn't plan it. It finds the branch or pull request linked to the work item, writes the row as **Needs info** with that branch as its Base branch, and asks: "I would plan this from X, because Y. Is that the right branch?"

- If the branch is right, set the row to **Re-triage**.
- If it's wrong, change the Base branch on the board (**Edit branch**), then set the row to Re-triage.
- To make triage look for the branch again, clear the Base branch and set the row to Re-triage.

### Depth: split, how and full

Each work item type has a depth, set in `/spadework:init`:

- **full**: triage decides what to build and how. The usual choice for Bugs, and for small teams.
- **how**: the work item already says what to build (a tech lead wrote it, for example). Triage keeps that and adds the code side: files, steps, commits and tests. If the code makes the spec impossible, the row asks you.
- **split**: triage breaks a Feature into Requirements, one row per part. See [Tech lead: split and handoff](#tech-lead-split-and-handoff).

### Out of scope

If a repo is set to only part of the work in config.json (for example `"parts": ["backend"]`), triage plans only that part. An item that's all outside your part gets no row, only a line in the chat.

## The board

`/spadework:board` opens the board in your browser. It's a local page, served from your machine on `127.0.0.1`. If the browser doesn't launch, open the file the command names.

`/spadework:board stop` stops it.

### Views

- **Table**: every row. Filter by status, repo and type, or search by ID, title or work item number.
- **Graph**: rows and their dependencies. An arrow means "depends on". With **Group by parent**, tick **Nested parents** to draw each parent inside its own parent.
- **Timeline**: what happened to each row and when, from triage to implement.
- **Stats**: the recent runs, how long they took and their tokens.
- **Merge**: for one repo, two parts and a button to copy the `/spadework:merge` command.
  - **Next merge**: the rows the next `/spadework:merge` would merge, in order, with the reason for each. It is worked out only when you click **Work out the order**, because git compares every branch and that can take a minute. It merges nothing. The order compares each branch with `origin/<main>` as of the last fetch: the board never fetches. Its last line says what the command does with the order.
  - **Merge runs**: a table of the merges that ran, newest first. Click a run to see each row with its state, the tests, and the commands to review and push the branch. For the tests it says only whether your test command passed or failed. Always test the merged branch yourself and review which tests it has: a command that passes does not show that the change works. A row whose code is in another row's branch has its own line: it comes in with that row.

While a merge runs, the graph puts a ring around its rows.

### A row

Click a row to open it. It has four tabs:

- **Plan**. For most items: Context, Code findings, Proposed solution, Commit breakdown, and Risks and open decisions. A Bug also has a Root cause. A Requirement from a split has What to build, Contract, Acceptance criteria and Depends on. Every part can be edited.
- **Questions**: what triage needs you to answer. Each question gives options and a recommendation.
- **Implementation log**: the report of the last implement run on the row.
- **Timeline**: the row's history, newest first: when it was planned, re-planned, approved, built, and every status change in between.

### Statuses

| Status | Who sets it | What it means |
|---|---|---|
| **New** | triage | Planned. Waiting for your review. |
| **Needs info** | triage | It has questions for you. |
| **Re-triage** | you | Plan it again, with your answers and feedback. |
| **Approved** | you | Ready to build. |
| **In progress** | implement | A build is running on it. |
| **Blocked** | implement | The build stopped. Its log says why. |
| **Resume** | you | Go on with a Blocked build, from its branch. |
| **Implemented** | implement | Built, reviewed and tested, on a local branch. |
| **Merged** | merge | In an integration branch, and the tests passed or there were none. |
| **Done** | you | The code is in the main branch. |
| **Rejected** | you | Not doing it. Triage leaves it alone. |

You can rename the statuses in `/spadework:init`.

### What you do on a row

- **Approve it** when the plan is right. Edit it first if it's nearly right: what you save is what implement builds.
- **Answer the questions**, save, then set the row to **Re-triage**.
- **Write Feedback** and set the row to **Re-triage**. The next plan follows it.
- **Reject it** if you won't do it.

Row numbers are never reused.

### Rows that depend on each other

A row can depend on other rows: it can't be built or tested without their code. Triage sets this for the Requirements of a split, and keeps the Predecessor links of a work item. On the Plan tab, under **Depends on**, each row it depends on is a chip. Click a chip to open that row, remove it with ×, or add a row of the same project by its ID in the box above the chips.

The next section is the row's **Base branch**. It's empty unless you set one.

You can change both while the row is New, Needs info, Re-triage or Approved. After that, the row's work has started: the chips only open their row, and the Base branch section shows the branch the row started from. Implement saves that branch when it starts the row: the branch of a row it depends on, or the main branch.

A dependency is about code, not about the order a user does things. "Remove a user" doesn't depend on "Add a user" because users are added first: it depends on a row only when it needs code that row writes.

Implement uses this. A row that depends on an Implemented row whose code is not in the main branch yet starts from that row's branch. A row that depends on a row that isn't built yet is skipped, and the run says which row to build first. The other rows of the run go on.

- **A row set to Resume goes on from its own branch.** The rows it depends on are not looked at again.
- **The branch a row starts from must have the code of every row it depends on.** When one of them is already in the main branch and that branch left the main branch before it got there, the row is skipped. Update that branch from the main branch, or set the row's Base branch.
- **A Base branch wins over the rows it depends on.** Set it in the **Base branch** section of the Plan tab (**Set a branch**), and implement starts the row from that branch. Use it when implement says the rows it depends on are on several branches and asks you to pick one. Clear it to let those rows decide again. When you set none, implement fills it in when it starts the row, with the branch it started from. A Bug has its Base branch at the top of the row instead.
- **A row whose Base branch is another row's branch waits for that row**, like for a row it depends on: that row must be Implemented, Merged or Done. Otherwise the row is skipped, and the run says which row to finish first.
- **Done means the code is in the main branch.** Set a row to Done only then: implement trusts it, and doesn't look at the row's branch.
- **Implement starts from local branches only.** It never pushes, so a row's branch is on the machine that built it. On another machine, build that row there first, or set the Base branch of the row that depends on it. If you renamed a branch, use **Correct branch** on the row's Implementation log tab.
- **A chain of branches is merged as one branch.** When SHOP-42 started from SHOP-41's branch, its branch holds both rows' commits: merge the last branch of the chain. A team that squash-merges should also merge the last branch of the chain, not each branch on its own.
- **Removing a chip only changes the board.** After a handoff, the link stays in Azure DevOps. Remove it there too, if developers should stop seeing it.
- **`/spadework:handoff` on a row that was already handed off adds the links it misses.** Nothing is created again.

## Re-triage

`/spadework:re-triage` plans again every row set to Re-triage, right away. To plan only some, name them: `/spadework:re-triage SHOP-12,SHOP-15`.

You don't have to run it. Every backlog triage plans the Re-triage rows first, before new items.

## Implement

`/spadework:implement SHOP-12` builds an approved row. Several: `/spadework:implement SHOP-12,SHOP-14`. They're built one after another.

### Before you run it

- **Run it from the repo's folder.** Implement works in the repo of the folder the chat is in, and refuses a row from another repo.
- **The row must be Approved**, or Resume to go on with a Blocked build.
- **The repo must have no uncommitted changes** (in branch mode). Implement stops before doing anything if it does.

### What happens

1. A branch `spadework/SHOP-12` is made from the main branch, from the row's Base branch for a Bug planned from another branch, or from the branch of a row it depends on (see [Rows that depend on each other](#rows-that-depend-on-each-other)). The branch it starts from never gets a commit.
2. The **developer** builds the plan and commits.
3. The **code reviewer** and the **security reviewer** check the change side by side. What they find goes back to the developer, for up to `max_review_rounds` rounds.
4. The **tester** writes tests for the plan's acceptance criteria and runs them.
5. The row ends **Implemented**, or **Blocked** with what's left for you to decide.

While it runs, pushing is switched off for the repo, and the guards keep every agent inside the repo.

**Spadework never pushes.** The final review, the push and the merge are yours.

### Branch or worktree

Set in `/spadework:init` (`implement.workspace`):

- **branch** (the default): the build happens in your repo folder. One build per folder at a time. When it finishes, the repo goes back to the main branch, if nothing is left uncommitted.
- **worktree**: each row gets its own folder next to the repo, like `shop-api--SHOP-12`. Your folder isn't touched, and two chats can build two rows in parallel.

### Blocked and Resume

A Blocked row says what stopped it, on its Implementation log tab. Fix it or decide it, write any instructions in its Feedback, set it to **Resume**, and run `/spadework:implement SHOP-12` again. It goes on from its branch and keeps the commits it already made.

### After it finishes

The summary gives the commands to review each branch, compared with the branch it started from: the main branch, the row's Base branch for a Bug planned from another branch, or the branch of a row it depends on.

```bash
git log origin/main..spadework/SHOP-12
```

```bash
git diff origin/main...spadework/SHOP-12
```

If some commits came after the last review round, the summary says how many the reviewers didn't see.

It also gives the command to push it when you're happy:

```bash
git push -u origin spadework/SHOP-12
```

In worktree mode, push from the row's worktree folder.

### Keep the chat for the build

Implement's agents run while its turn is open, so keep that chat for the build and use another chat for other work. Spadework's own `/spadework:board`, `stats`, `validate`, `stop` and `schedule` are safe to run in it, but any other command ends the run.

## Merge

`/spadework:merge --repo shop-api` works out the order to merge a repo's Implemented rows, with a reason for each step. Add `--project Shop` only when two projects have a repo with that name. Name rows to merge only those: `/spadework:merge --repo shop-api SHOP-12 SHOP-14`. A row they depend on that is Implemented and not in the main branch is added.

- Rows with nothing in common go first, by row number. A row goes after the rows it depends on, and after the row whose branch it was built on.
- Rows that are likely to conflict go one after the other, the smallest first. "Likely" is an estimate from pairs of branches.
- A row whose branch is inside another row's branch has no step of its own: it comes in with that one.
- The reason names the rows a step depends on that are not in this merge, and where their code is: `depends on SHOP-9, already in its branch` or `already in main`.
- When a step's branch was built on an older merge branch that is not in the main branch yet, the order says so, with the rows in it: `SHOP-14's branch also holds spadework/merge-20261110-0930 (SHOP-9 and SHOP-12), which is not in main.` Merging that step brings those rows too.
- A row is held back, with the reason, when a row it depends on isn't built, when its Base branch is another row's branch and that row isn't built, when its Base branch is not a row's branch and not in the main branch, or when its branch is not on this machine. Every row that needs it is held back too.

### Advisory and integrate

**Advisory** is the default. It prints the order and the commands, and you merge. Nothing changes.

**Integrate** is on with `"merge": { "integrate": true }` in config.json, or the Merge switch in `/spadework:init`. Then the command also:

1. Creates `spadework/merge-<date>-<time>` from the main branch, in the repo folder (branch mode) or in `<repo>--merge` next to it (worktree mode). Pushing is off while it works.
2. Merges the rows' branches into it, in the order. When git can't merge some lines alone, an agent resolves them and a reviewer checks the result. When the agent can't decide, or the reviewer rejects the result twice, the row is left out, with every row that depends on it.
3. Runs the repo's test commands.
4. Sets the rows that went in to **Merged**, and turns pushing back on.

Add `--advise` to see the order without merging, even with integrate on.

**One row needs no new branch.** When the order is one row and its branch merges into the main branch with no conflict, no `spadework/merge-...` branch is made, in either mode. The command prints the commands to review and push the row's own branch. The row stays Implemented and no test command runs, so test the branch yourself. With a conflict, the new branch is made as for any other order, so the agent can resolve it.

It never pushes and never changes the main branch. You review the branch, push it and open one pull request. The summary gives the commands:

```bash
git log origin/main..spadework/merge-20261110-0930
```

```bash
git diff origin/main...spadework/merge-20261110-0930
```

```bash
git push -u origin spadework/merge-20261110-0930
```

If the main branch moved while it worked, the summary says so: merge the main branch into the new branch before you open the pull request.

### Test commands

Each repo can have test commands, set in `/spadework:init` (Test commands) or as `test_commands` in config.json, one per line. They run in the new branch, one after the other, and stop at the first that fails.

- **Each command must finish in 9 minutes.** A longer one is stopped and counts as failed: split a long suite into several commands. Claude Code stops a shell call after 10 minutes.
- **The tests run code from the merged branches**, such as their `package.json` scripts, with your rights. The guards don't check it. Pushing is off at the git level, so a push from a test script fails.
- **When a test fails**, no row is set to Merged, and the branch is kept for you to fix. With no test commands, the tests are skipped and the summary says so.
- **A test command that passes says only that.** The summary and the board remind you: always test the merged branch yourself, and review which tests it has.

### Merged rows

- **Merged means the row's branch is in an integration branch**, and the tests passed or there were none. Only the merge sets it. Done is still yours to set, once the code is in the main branch.
- **The merge leaves Merged rows alone.** To merge a row again, set it back to Implemented on the board.
- **A Merged row keeps its own branch.** The board shows it, and the integration branch next to it. You can delete the row's own branch: implement then starts a row that depends on it from the integration branch.
- **Integration branches and `<repo>--merge` folders are never deleted by Spadework**, also when a run is cut off. Delete the old ones yourself.

### Keep the chat for the merge

Like implement, keep the chat until the summary. If the chat is closed or crashes mid-run, the next `/spadework:merge` in that repo puts the folder back first. To do it now: `/spadework:stop --merge shop-api --force`.

## Tech lead: split and handoff

For a team where a tech lead writes Requirements and developers build them:

**The tech lead** sets Feature to `split` in config.json.
1. `/spadework:triage` splits each Feature into Requirement rows: what to build, the contract, acceptance criteria and dependencies.
2. Review the new Requirement rows on the board and approve them.
3. `/spadework:handoff SHOP-41,SHOP-42` creates them in Azure DevOps under the Feature. Each row gets its new work item number. Rows that depend on each other get a Predecessor link between their work items, so developers see the order on their own boards. This needs **Work Items: Read & Write** permission in your Azure DevOps PAT.
4. Finally, assign them to developers in Azure DevOps.

**Each developer** sets Requirement to `how`. Triage keeps the tech lead's spec and plans only the code side.

A tech lead can also build a Requirement row directly: `/spadework:implement SHOP-41` works without a handoff.

## Design: from a spec to an Epic and Features

Some changes need an architecture decision before anyone can plan them. `/spadework:design` turns a spec file into ADRs and a placement: which Epic the work goes under, and which Features. `/spadework:design-push` then creates those in Azure DevOps.

1. `/spadework:new-spec order-processing` creates `docs/design/order-processing.md`. Fill in its six sections.
2. `/spadework:design -file docs/design/order-processing.md` starts a design run. A coordinator agent runs Spadework's architect on the spec. Add `--repo api` (and `--project Shop` when two projects have a repo with that name) to choose the repo. Without it, the repo is the one of the folder you are in.
3. The architect may ask questions. The chat shows them: answer in your next message. The architect then runs again with your answers. This repeats until it has its decisions.
4. The ADRs are saved in the repo's ADR folder (`docs/adr/` unless your stack notes say `- ADRs: <folder>`), each with its line in `INDEX.md`. Spadework picks the number and the file name.
5. The placement is written to `~/.spadework/designs/order-processing.md`. **Nothing is in Azure DevOps yet.** Read the file and edit it if you want: change a title or a description, remove a Feature, or move the Features under another Epic.
6. `/spadework:design-push order-processing --project Shop --repo api --area "Shop\Checkout"` creates exactly what the file says. The design run prints this command with the values filled in. `--area` must be one of the repo's area paths, or a path under one that includes its children.
7. `/spadework:triage <Feature number>` splits each new Feature into Requirements, as for any Feature.

**The placement file** has one of three shapes:

- New Features under an existing Epic: `## Epic #12094: Checkout`, then a `### Feature: <title>` with its description for each Feature. The push never changes the Epic's own text, so leave no text under that line.
- A new Epic with its Features: `## Epic: <title>`, its description, then the Features.
- ADR only: the decision needs no new work item. There may be a `## Work item #123` line for the work item it belongs to. The push creates nothing, and the run tells you to triage that work item.

When the file has a line the push doesn't know, the push names the line and creates nothing. A new placement for the same spec replaces the file.

**What the push creates.** It never creates Requirements, User Stories or tasks: those come from triage's split and from handoff. Each item gets two tags: `spadework` and `spadework-design-pushed`. Running the push again is safe: it finds what an earlier push made by its tags and title, and creates only what is missing. An Epic with the same title but without the `spadework-design-pushed` tag stops the push: add the tag in Azure DevOps if an earlier push made it, or rename the Epic in the file. A Feature with the same title but without the tags is left alone. Triage plans only items assigned to you: assign the new Feature to yourself first if Azure DevOps didn't.

**Good to know:**

- **Keep the chat open until the design finishes.** A design run ends when its chat is closed. If you close it while the architect's questions are open, run the command again: the architect starts again from the spec.
- **The ADRs are not committed.** Commit and merge them, so other developers and their planners see them. Until then, triage's planners in your own repo read them from disk.
- **Planners find ADRs through `INDEX.md`.** Spadework adds a line there for each ADR it saves. An ADR you wrote by hand needs its own line, `<file name>: <one sentence>`, or the planners won't see it.
- **ADR numbers can clash** when two branches each add the next number. You see it at merge. Rename one file to the next free number, change the number in its first line, and fix its line in `INDEX.md`.
- **No placement** is written when the folder isn't a configured repo (the ADRs are saved in that folder), or when `tracker.process` is `Custom`: Spadework can't tell which work item types sit above the rows, so create the Epic and Features by hand. With the `Basic` process the push creates only an Epic.
- **Agents must be able to launch agents.** The coordinator launches the architect. If `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` is set to 1, the design run stops and says so.
- **Other Spadework commands are refused while a design run is on:** the chat can't run them for you mid-design. To use one, end the design run first: type another command (for example `/clear`), or open a new chat. The run also ends when the design finishes, or after 24 hours with no activity.


## Scheduled triage

Scheduled triage runs in the Claude desktop app, on your computer, while the app is open.

| Command | What it does |
|---|---|
| `/spadework:schedule` | List the scheduled triages |
| `/spadework:schedule <project_name> weekdays 9:00` | Triage project Shop on weekdays at 9:00 |
| `/spadework:schedule <project_name> --repo <repo_name> daily 09:30` | One repo of a project |
| `/spadework:schedule all weekdays 8:45` | Every project in one run |
| `/spadework:schedule <project_name> pause` | Pause it. |
| `/spadework:schedule <project_name> delete` | Delete it. |

- A run is skipped while another scheduled task is still running, so leave time between them.
- After the computer wakes, the app may do one catch-up run. That's safe: triage never plans the same item twice.
- **Try it once** with **Run now** on the task in the app (Code → Routines). It shouldn't ask you anything while it runs.

## Using it cheaply

Spadework runs on your own Claude plan, so tokens are what you spend. Most of them go to the main chat, not the agents. Every response re-reads the chat's whole context, so a short chat is a cheap chat.

- **Start a new chat for each manual run.**
- **Don't go back to a chat that's been idle for more than an hour.** The Claude Code cache may have expired, so the entire context will be re-sent.
- **Prefer a backlog run to many single items.** The setup is paid once.
- **Narrow backlog runs** with `--project` and `--repo`.
- **Use `--deep` only when a plan missed something.** In testing it found a little more and cost about 15% more.
- **Build a code graph** with graphify if you use it. Triage then finds the code with fewer reads. Keep the graph up to date after big changes on the main branch.
- **Answer questions in one go.** Each Re-triage is a new plan, so answer every question on a row before you send it back.
- **Check what runs cost** with `/spadework:stats` (`--days 7` for a week). It lists each run, how long it took, and the tokens per agent.

## Other tools

These work on their own, outside the triage and implement flow:

| Command | What it does |
|---|---|
| `/spadework:review` | Code and security review together, of uncommitted changes, a branch, a pull request, paths or the whole project |
| `/spadework:code-review` | Code-quality review only |
| `/spadework:security-review` | Security review only, plus the dependency scan command from your stack notes |
| `/spadework:test` | Write tests, or `audit` the existing ones |
| `/spadework:debug` | Find a bug's root cause from an error or a description, and propose a fix without applying it |
| `/spadework:new-spec` | Create a design spec file to fill in |
| `/spadework:architect` | A design or architecture decision from a question or a spec file, saved as an ADR |

Each one takes `-help`.

## When something goes wrong

**Start with `/spadework:validate`.** It checks the config, Azure DevOps, the board, the repos and the hooks.

| Problem | Fix |
|---|---|
| A triage chat was closed or crashed, and the next triage says one is running | `/spadework:stop --project Shop --force`. The item it was on may still be written. |
| A running triage should stop | `/spadework:stop --project Shop`. It finishes the item it's on, then stops. |
| An implement chat was closed or crashed, and the row is stuck In progress | `/spadework:stop --row SHOP-12 --force`. The row goes to Blocked, pushing is switched back on, and the repo goes back to its main branch. Set it to Resume to go on. |
| A merge chat was closed or crashed | `/spadework:stop --merge shop-api --force` (add `--project Shop` when two projects have that repo). The merge's folder goes back to the last finished step, pushing is switched back on, and the integration branch is kept. Rows are not changed. |
| A push fails with `spadework-run-in-progress` | Same as above. If no run is left, run `git config --unset remote.origin.pushurl` (add `--worktree` inside a worktree). |
| A Bug's Base branch can't be fetched | The row goes to Needs info with git's error, and keeps its plan. Fix the branch name with **Edit branch**. |
| Triage says "Azure DevOps didn't connect" | Spadework's link to Azure DevOps took too long to start, so nothing was planned. Run triage again. If it keeps happening, follow "If it's slow to start" in the README. |
| "isn't in your backlog" | The item isn't assigned to you, or its type, state or area path isn't one you configured. |
| Tool calls fail with "auto mode classifier gave no verdict" | Switch the chat to manual permission mode. |
| The board says "This page needs its link" | Open it with `/spadework:board`, not from an old tab or bookmark. |

## Good to know

- **Implement isn't a sandbox.** The repo's own build and test scripts run with your rights, and the guards don't check them. Run it on code you trust, or in a dev container.
- **Work item text is data.** No agent is supposed to follow instructions written in a work item, a row or a repo file.
- **Your data stays in `~/.spadework/`**: config, board rows, logs. Uninstalling the plugin leaves it there.
