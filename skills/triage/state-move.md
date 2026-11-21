# Triage: the state move (optional)

Read from `SKILL.md` step 3.6. Only when `on_triage.set_state_enabled` is true, the result is `planned`, and the work item's state is in `on_triage.only_from` (ignoring case). Then run `spadework.js triage outcome --session <session> --item <id>` first: move the state only if its `result` is `planned`. A planned answer with an open question, or a decision that asks the user to confirm something, ends as needs info, and its work item isn't moved.

Do it **before** `triage finish`, so `finish` records it on the row in the same call:

1. `wit_work_item_write` with `action: "update"`, the `id`, the `project` and `updates`: `[{"op": "test", "path": "/rev", "value": <System.Rev>}, {"op": "add", "path": "/fields/System.State", "value": "<on_triage.set_state>"}, {"op": "add", "path": "/fields/System.Tags", "value": "<triage_tag>"}]`. An `add` on the tags keeps the item's own: a tag called urgent becomes urgent plus the triage tag. `triage_tag` is in the plan.
2. It worked: send `finish` the input `{"state_move": {"from": "<the state it had>", "to": "<on_triage.set_state>", "rev": <the new rev it returns>}}`.
3. It failed: send `{"state_move": {"error": "<short reason>"}}`. Don't retry.

**If `finish` answers `ok: false` with a `line` after a move that worked**, the item would be left in the new state with no plan. Move it back with one `wit_work_item_write` (`action: "update"`, the `id`, the `project`, `updates`: the `test` on `/rev` with the rev the move returned, and an `add` of `/fields/System.State` with the state it had). The guard allows exactly that. Then run `triage finish --result failed` once more (it only tidies up: the item is already logged as failed) and print its `line`. The triage tag stays on the item.
