---
name: architect
description: System design or an architecture decision with Spadework's architect, from a question or a spec file. Saves the resulting ADR in the repo's ADR folder.
argument-hint: "<question> | -file <path> [extra instructions] | -help"
disable-model-invocation: true
---

# Spadework: architect

If the arguments are `-help` (or start with it), print exactly this and stop:

> **/spadework:architect**: system design and architecture decisions
> Usage: `/spadework:architect <question>` or `/spadework:architect -file <path> [extra instructions]`
> Examples:
>   `/spadework:architect should order processing be its own service or stay in the monolith?`
>   `/spadework:architect -file docs/design/order-processing.md`
>   `/spadework:architect -file docs/design/order-processing.md focus the deep dive on retries`
> Run `/spadework:new-spec <name>` first to create a spec file to fill in.
> Checks the existing ADRs and code first, so it doesn't contradict decisions already made.

Arguments: $ARGUMENTS

## 1. Input

- Starts with `-file`: the next word is the file path, and everything after it is extra instructions. If the file doesn't exist, say so and stop. Don't guess another file.
- Otherwise: all the arguments are the design question. If there are none, ask what's being designed or decided (or which file to read) before launching anything. The architect works through requirements first.

## 2. Stack notes

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/spadework.js" stack` in the current folder. The notes say where ADRs live. If they don't, use `docs/adr/`.

## 3. Run the architect

Launch `spadework:architect` with the Agent tool. Give it the question (or tell it to read the spec file first and work from it, plus the extra instructions) and the Stack notes.

If it comes back with questions instead of an ADR, put them to the user, then launch it again with the answers and everything from before.

## 4. Save the ADR

When it returns an ADR (or several):
1. Write the agent's whole answer, exactly as it gave it, to `adr-draft.md` in Spadework's tmp folder: the `tmp` path that `node "${CLAUDE_PLUGIN_ROOT}/scripts/spadework.js" paths --json` prints.
2. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/spadework.js" adr save --in adr-draft.md` in the current folder. The helper picks each ADR's number and file name, saves it in the ADR folder and adds its line to `INDEX.md`, which planners read first. If `ok` is false, print `error` and stop.
3. Tell the user the path of each saved ADR (`saved`) and show the decision in a few lines.
