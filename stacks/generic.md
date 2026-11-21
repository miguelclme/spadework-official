## Generic defaults

Used when the user's `stack.md` doesn't cover something. The user's notes and the repo's existing patterns always win over these.

- **Follow the repo**: match the existing structure, naming, error handling and style. A change should look like it was written by the same team.
- **Small, focused changes**: one concern per commit, roughly 200-400 changed lines at most. No drive-by refactors.
- **Readable over clever**: clear names, no magic values, short functions with one job.
- **No duplicated logic**: reuse what the repo already has before writing something new.
- **Validate at the boundaries**: check input where it enters the system (API, UI, message, file).
- **Fail visibly**: handle errors explicitly. Never swallow an exception without logging or rethrowing it.
- **Log for production**: enough context to diagnose a problem (what, which resource, which request), never secrets or personal data.
- **No secrets in code**: no keys, tokens, passwords or connection strings in code, config files or test data. Use the repo's secret mechanism (environment variables, a vault).
- **Least privilege**: check authorization on every entry point. Give code only the access it needs.
- **Tests next to the change**: new logic comes with tests in the repo's test framework, placed where the repo keeps its tests. Test behavior, not implementation.
- **Dependencies**: don't add a new library when the repo or the standard library already covers it. Prefer well-maintained packages.
- **Public contracts**: don't change an API, schema or message format other code depends on without saying so.
- **Commits**: short imperative messages ("Add order export endpoint"), unless the repo uses another format.
