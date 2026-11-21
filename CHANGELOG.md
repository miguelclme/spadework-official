# Changelog

What changed in each Spadework release. Versions follow [Semantic Versioning](https://semver.org).

## [0.1.0] - 2026-11-21

First public release, in beta.

### Added

- **Triage** reads your Azure DevOps work items, finds the repo each one belongs to and plans each item against your code as a row on a local board. It never changes code. Each work item type gets a depth: `split`, `how` or `full`.
- **Questions instead of guesses.** When an item is too vague to plan, its row asks questions with options and a recommendation, and waits in Needs info until you answer.
- **Bugs are planned from their branch.** A Bug is planned from the branch or pull request linked to it in Azure DevOps, after you confirm it.
- **The board** is a local web page where you read and edit the plans, answer questions, and approve, re-triage or reject each row. It has Table, Lanes, Graph and Timeline views.
- **`/spadework:re-triage`** plans again the rows you sent back, following your feedback and answers.
- **`/spadework:implement`** builds the approved rows with a developer, code reviewer, security reviewer and tester chain, on a local branch. Spadework never pushes.
- **Rows that depend on rows.** Implement builds a row from the branch that has the code it depends on, and skips it until that code is built.
- **`/spadework:merge`** works out the order to merge a repo's built rows, with a reason for each step. With integrate on, it merges them into one local branch and runs your tests.
- **`/spadework:handoff`** creates a split's approved Requirement rows as work items in Azure DevOps, so developers can triage them without planning again.
- **`/spadework:design`** turns a spec file into ADRs and a placement file (which Epic, which Features), and **`/spadework:design-push`** creates exactly those in Azure DevOps.
- **`/spadework:schedule`** runs triage on a schedule in the Claude desktop app, and **`/spadework:stop`** stops a running triage.
- **`/spadework:stats`** shows each run, how long it took and the tokens each agent used.
- **`/spadework:init`** opens a settings page for projects, repos, work item types and stack notes. Its Detect button suggests a repo's stack from its files.
- Standalone commands: `/spadework:review`, `/spadework:code-review`, `/spadework:security-review`, `/spadework:test`, `/spadework:debug`, `/spadework:architect` and `/spadework:new-spec`.
- Guards check every tool call during a run: no reads outside its scope, no credentials, no projects you didn't configure, no push. `/spadework:validate` checks the setup and says how to fix each problem.
