# Triage: a Feature that is split

Read from `SKILL.md` step 3.5 when `start` answered with `depth: "split"` (the work item's type is a `split` type in `work_items`).

The agent splits the work item into Requirements. It writes its answer to the plan file as sections: the Feature's own risks and open decisions or questions, then one `# Requirement: <title>` block for each Requirement, then the `Result:` line.

- You do nothing different: finish as step 3.7 says. `triage finish` reads the plan file, writes the Feature's row (only what the agent gave for the whole Feature: no context and no code findings) and one row per Requirement (type from `work_items`, `spec` filled, no work item yet, and the rows it depends on, from its `## Depends on` section). Print its `line` as usual; the Requirement rows are in `requirements`, not printed.
- If the plan doesn't parse (a Requirement misses a section, or its `## Depends on` names something that isn't another Requirement of the answer), `finish` answers `ok: false` with the first problem in its `line` and writes no row: the item is logged as failed. Do what step 3.7 says with that `line`.
- A split that ends with needs info writes only the Feature's row, with its questions, and keeps the Requirements it drafted for the next plan. A planned split waits the same way when a question is still open or a decision asks the user to confirm something.
- After a split the Feature is left alone: the Requirement rows are edited, then handed off with `/spadework:handoff`.
