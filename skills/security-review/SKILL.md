---
name: security-review
description: Security review of source code only, with Spadework's security reviewer, including a dependency vulnerability scan. Use /spadework:review for code and security together.
argument-hint: "[blank = uncommitted changes | PR <n> | branch <name> | path(s) | whole project] | -help"
disable-model-invocation: true
---

# Spadework: security review

If the arguments are `-help` (or start with it), print exactly this and stop:

> **/spadework:security-review**: security review only
> Usage: `/spadework:security-review [scope]`
> Scope (optional): blank = uncommitted changes · `PR <n>` · `branch <name>` · path(s) · `whole project`
> Examples: `/spadework:security-review`, `/spadework:security-review whole project`
> Runs `security-reviewer` only, on source code (not a live server). Use `/spadework:code-review` for quality, or `/spadework:review` for both.

Arguments: $ARGUMENTS

1. **Scope**:
   - Nothing given: the uncommitted changes (`git diff` plus `git diff --staged`). If both are empty, ask what to review instead of guessing.
   - `PR <n>`, a branch or paths: exactly that. For a branch, the change is `git diff origin/<main branch>...<branch>`.
   - "whole project", "all" or "entire codebase": the whole codebase. The agent finds the source files itself. This is the right choice before a release.
2. **Stack notes**: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/spadework.js" stack` in the current folder.
3. Launch `spadework:security-reviewer` with the Agent tool, giving it the scope and the Stack notes.
4. Show its findings as they are, already ranked by severity. Don't add your own review.
