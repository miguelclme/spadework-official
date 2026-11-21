# Triage: an item outside your parts

Read from `SKILL.md` step 3.7 when the agent ended with `Result: out_of_scope`. It didn't plan: it returned a line `Out of scope: "<quote>"` and the result.

- Don't write a plan and don't move the state (skip `state-move.md`).
- Finish with `--result out_of_scope` and `{"quote": "<the quote from its Out of scope line>"}`. `triage finish` does the rest:
  - no row yet: nothing is written;
  - an existing row (re-triage, needs info, or a changed row): it goes to needs info, with a history line saying it isn't the user's parts of the work. Its open questions are replaced with one: reject the row, or say which part is the user's. Without this a re-triage row would go back to the agent on every run;
  - it remembers the item at this rev, so the next run skips it until the work item changes;
  - it releases the claim and logs the result.
- Print its `line` and go on.
