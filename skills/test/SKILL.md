---
name: test
description: Write new tests, or audit existing test coverage and quality, with Spadework's tester and the test frameworks from your stack.md.
argument-hint: "[what to test + type | audit [scope]] | -help"
disable-model-invocation: true
---

# Spadework: test

If the arguments are `-help` (or start with it), print exactly this and stop:

> **/spadework:test**: write tests, or audit existing ones
> Usage: `/spadework:test <target + type>` or `/spadework:test audit [scope]`
> Examples: `/spadework:test OrderService unit`, `/spadework:test audit whole project`
> Runs the `tester` agent with your stack's test frameworks. Asks for the test type if you don't give one.

Arguments: $ARGUMENTS

1. If no argument was given, ask what to test or audit.
2. **Writing tests**: if the arguments don't say which type, ask with AskUserQuestion before launching anything: Unit (Recommended), Integration, Contract and security, Performance. The tester can't ask questions itself.
3. **Auditing**: "audit" plus a scope (a path, or "whole project") means review the existing tests' coverage and quality, not write new ones.
4. **Stack notes**: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/spadework.js" stack` in the current folder.
5. Launch `spadework:tester` with the Agent tool, giving it the target or audit scope, the test types and the Stack notes. Tell it this isn't an implement run, and never to commit.
   - Writing tests: it writes the tests and runs them.
   - Auditing: it only reports. It writes, edits and creates no files, tests included, and may run the existing tests to see what passes.
6. Show its report as it is.
