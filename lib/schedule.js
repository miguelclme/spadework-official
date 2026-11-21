'use strict';

// Scheduled triages in the Claude desktop app. A task's prompt is plain
// text (the app never expands a slash command), so it asks Claude to run
// the triage skill. /spadework:schedule creates tasks from target(), and
// /spadework:validate knows Spadework's tasks by PROMPT_START: both come
// from here, so they can't drift apart.

const config = require('./config');

const PROMPT_START = 'Run the spadework:triage skill';

// Lowercase, anything but letters and digits as "-": Shop API → shop-api.
const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]/g, '-');

// The task for a target: every project, one project, or one repo of it.
// project and repo are matched ignoring case, and spelled as config.json
// spells them. Returns { ok, task_id, title, prompt, prompt_start } or { ok: false, error }.
function target(cfg, { project = null, repo = null } = {}) {
  const fail = (error) => ({ ok: false, error });
  if (repo && !project) return fail('--repo needs --project: two projects can have a repo with the same name');
  const done = (taskId, title, prompt) => ({ ok: true, task_id: taskId, title, prompt, prompt_start: PROMPT_START });
  if (!project) return done('spadework-triage-all', 'Spadework triage: all projects', `${PROMPT_START}.`);

  const name = config.findProject(cfg.tracker.projects, project);
  if (!name) return fail(config.unknownProject(cfg.tracker.projects, project));
  if (!repo) return done(`spadework-triage-${slug(name)}`, `Spadework triage: ${name}`, `${PROMPT_START} with: --project "${name}"`);

  const found = config.findRepo(cfg.repos, name, repo);
  if (!found) {
    const names = config.reposOf(cfg.repos, name).map((projectRepo) => projectRepo.name);
    return fail(`Unknown repo in ${name}: ${repo}. Its repos: ${names.join(', ') || 'none'}`);
  }
  return done(
    `spadework-triage-${slug(name)}-${slug(found.name)}`,
    `Spadework triage: ${config.repoLabel(found)}`,
    `${PROMPT_START} with: --project "${name}" --repo "${found.name}"`,
  );
}

module.exports = { PROMPT_START, target };
