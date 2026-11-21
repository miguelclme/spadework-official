---
name: review
description: Code and security review in one go. Runs Spadework's code reviewer and security reviewer side by side on a diff, a branch, paths or the whole project.
argument-hint: "[blank = uncommitted changes | PR <n> | branch <name> | path(s) | whole project] | -help"
disable-model-invocation: true
---

# Spadework: review

If the arguments are `-help` (or start with it), print exactly this and stop:

> **/spadework:review**: code and security review, run together
> Usage: `/spadework:review [scope]`
> Scope (optional): blank = uncommitted changes · `PR <n>` · `branch <name>` · path(s) · `whole project`
> Examples: `/spadework:review`, `/spadework:review branch spadework/SHOP-35`, `/spadework:review whole project`
> Runs `code-reviewer` and `security-reviewer` side by side and shows both. Use `/spadework:code-review` or `/spadework:security-review` to run just one.

Arguments: $ARGUMENTS

## 1. Work out the scope

- Nothing given: the uncommitted changes (`git diff` plus `git diff --staged`). If both are empty, ask what to review instead of guessing.
- `PR <n>`, a branch or paths: exactly that. For a branch, the change is `git diff origin/<main branch>...<branch>`.
- "whole project", "all" or "entire codebase", in any wording: the whole codebase, not just recent changes. The agents find the source files themselves.

## 2. Get the stack notes

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/spadework.js" stack` in the current folder. Its output is the Stack notes both agents need.

## 3. Run both reviewers at the same time

In one message, launch two agents with the Agent tool, and wait for both:
- `spadework:code-reviewer` with the scope and the Stack notes
- `spadework:security-reviewer` with the same scope and the Stack notes

## 4. Show the results

Show both sets of findings under **Code review** and **Security review**. Don't merge them or drop duplicates: they check different things, and a finding both flag is worth knowing. If the security review has anything Critical or High, show it first. Don't add your own review on top.
