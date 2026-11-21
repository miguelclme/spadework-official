# Triage: rows set to re-triage

Read from `SKILL.md` (step 1 and step 2) and from `/spadework:re-triage`. The user set these rows to `statuses.retriage`, usually after writing feedback or answering their questions. The Rules of `SKILL.md` apply, and so does its step 3 for planning an item.

- **A re-triage run** (`mode` is `retriage`): the rows are the plan's `retriage_rows`. Print each entry of `left_alone` word for word. Without `retriage_rows`, print "No rows are set to <statuses.retriage>." and stop.
- **A backlog run**: the rows are the `retriage` list `triage repo` returned, planned before any new work item.

Stop when the run has planned `limit` rows.

1. **Fetch and check**: for each row with a `work_item_id`, in one message: `wit_work_item` with `action: "get"`, that ID, the row's `project` and `expand: "Relations"`, and each of the row's `scope` queries (`wit_query`, `action: "wiql"`, the row's project, the `wiql` as given, `top: 1`). The row is in the backlog when any query returns its ID. A row without a work item is a split Requirement: it has nothing to fetch, and `start` below refuses it.
2. **Each row**, in order: get its parent, related items and comments (step 3.3 of `SKILL.md`, in the same message as `start`), and run `spadework.js triage start --session <session>` with `{"row": "<row id>", "fields": {…}, "relations": […], "in_backlog": <from step 1>}` as step 3.4 says (in a backlog run also `--project "<project>" --repo "<name>"`). It checks the backlog, that the row is still set to `statuses.retriage`, which repo it belongs to, the stop request and the claim. Then:
   - `plan`: launch the agent and finish as steps 3.5 to 3.7 say. The brief already holds the earlier plan as the user may have edited it, their feedback and their answers. The row's Predecessors and its parent's type, title and own parent are written again from the `relations` sent to `start` and the `parent` sent to `finish`.
   - `lookup_pull_requests`: as step 3.4 says, then run `start` again.
   - `needs_info`: the repo is unclear, or the Bug's branch isn't settled. Finish with `--result needs_info` and the `page` and `parent` of step 3.4. The row goes back to needs info with the question.
   - `skip`: in a re-triage run print "<row id>: skipped, <reason>"; in a backlog run print nothing. A row out of the backlog is left as it is.
   - `refuse`: print `refusal` (for example that the row is already split) and leave the row as it is.
   - `stop`: as step 3.4 says.
3. **Summary**: a re-triage run ends with step 4 of `SKILL.md`, counting only these rows, and one line per row left alone, refused or out of the backlog.
