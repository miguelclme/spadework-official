---
name: code-review
description: Code-quality review only, with Spadework's code reviewer, on a diff, a branch, paths or the whole project. Use /spadework:review for code and security together.
argument-hint: "[blank = uncommitted changes | PR <n> | branch <name> | path(s) | whole project] | -help"
disable-model-invocation: true
---

# Spadework: code review

If the arguments are `-help` (or start with it), print exactly this and stop:

> **/spadework:code-review**: code-quality review only
> Usage: `/spadework:code-review [scope]`
> Scope (optional): blank = uncommitted changes · `PR <n>` · `branch <name>` · path(s) · `whole project`
> Examples: `/spadework:code-review`, `/spadework:code-review src/orders`
> Runs `code-reviewer` only. Use `/spadework:security-review` for security, or `/spadework:review` for both.

Arguments: $ARGUMENTS

1. **Scope**:
   - Nothing given: the uncommitted changes (`git diff` plus `git diff --staged`). If both are empty, ask what to review instead of guessing.
   - `PR <n>`, a branch or paths: exactly that. For a branch, the change is `git diff origin/<main branch>...<branch>`.
   - "whole project", "all" or "entire codebase": the whole codebase. The agent finds the source files itself.
2. **Stack notes**: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/spadework.js" stack` in the current folder.
3. Launch `spadework:code-reviewer` with the Agent tool, giving it the scope and the Stack notes.
4. Show its findings as they are. Don't add your own review, and don't run the security reviewer here.
