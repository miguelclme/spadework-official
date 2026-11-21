# Triage: a Bug's linked pull requests

Read from `SKILL.md` (step 3.4) when `triage start` answers `lookup_pull_requests`. A Bug is planned from the branch its work item links to, and a pull request link only holds the pull request's number. The Rules of `SKILL.md` apply: this only reads.

1. For each entry of `pull_requests` (`id`, `project`, `repo`, in that order), call `repo_pull_request` with `action: "get"`, `pullRequestId: <id>`, `repositoryId: <repo>` and `project: <project>`.
2. Keep only what `start` needs, never the whole answer:
   - `{"id": <id>, "status": <status>, "source": <sourceRefName>, "target": <targetRefName>, "merge_commit": <lastMergeCommit.commitId>}`
   - `{"id": <id>, "error": "<short reason>"}` when the call fails (not found, no access).
3. Run `spadework.js triage start` again with exactly the input of the first call plus `"pull_requests": [<the kept entries>]`, and go on with its `action`.

The Bug then goes to needs info with the branch it would be planned from. The user confirms it, or sets another Base branch on the row, and sets Re-triage.
