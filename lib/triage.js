'use strict';

// The exact parts of /spadework:triage and /spadework:re-triage. The skills
// do the talking to Azure DevOps and the agents; this file decides:
// - what a run covers: repos, backlog queries, limits, re-triage rows (plan)
// - which repo a work item belongs to (match)
// - getting each repo's main branch up to date (prepare)
// The duplicate check lives in decide.js; the commands the skill calls
// (repo, decide, start, finish, end) are in triage-rows.js.

const fs = require('fs');
const path = require('path');

const ado = require('./ado');
const baseBranch = require('./base-branch');
const board = require('./board');
const config = require('./config');
const graphify = require('./graphify');
const log = require('./log');
const paths = require('./paths');
const runs = require('./runs');
const { git, fetchBranch } = require('./git');
const { wholeNumber, workItemId } = require('./numbers');

// Items read from Azure DevOps and looked up on the board at a time. The run
// stops reading pages once it has planned its limit.
const PAGE_SIZE = 100;
// The most a run may plan, even with --limit.
const MAX_LIMIT = 100;
// What the duplicate check needs for each backlog item. Title, type and the
// text fields are read only for the items that need them.
const PAGE_FIELDS = ['System.Id', 'System.TeamProject', 'System.AreaPath', 'System.State', 'System.Rev', 'System.Parent', 'System.CommentCount'];

const { findRepo, findProject, unknownProject, reposOf, sameRepo, repoLabel, repoDisplay, loadForRun } = config;

const { isFolder } = paths;
// A flag that was given and isn't blank (--project "" counts as not given).
const hasText = (value) => Boolean(value && String(value).trim());
const missingFolder = (repo) => `its folder ${repo.path} doesn't exist. Clone it there or fix its path in config.json`;

// The repo's code graph for this run: `graph` is its folder when the agents
// may query it, `graph_hint` says why not and how to fix it.
// A repo with no graph gets no hint: validate prints the command to build
// one, so triage doesn't repeat it every run.
const graphFor = (repo, enabled, installed) => graphify.forRepo({ path: repo.path, label: repoLabel(repo) }, enabled, installed, 'triage searched with git grep', { missingHint: false });

// The run's flags, checked: which go together, and their values parsed.
// Returns { error } or { target, limit, since }.
function checkArgs({ project, repoNames, item, deep, limit, since, retriage, rowIds }, cfg) {
  const hasProject = hasText(project);
  const hasItem = item !== null && item !== undefined;
  const fail = (error) => ({ error });
  if (repoNames && repoNames.length && !hasProject) return fail('--repo needs --project, since two projects can have a repo with the same name, e.g. /spadework:triage --project Shop --repo api');
  if (retriage && (hasProject || hasItem || deep || since)) {
    return fail(`Re-triage takes only row IDs, e.g. /spadework:re-triage SHOP-12,SHOP-15, or nothing for every row set to ${cfg.board.items.retriage_status}. For one work item, use /spadework:triage <number>`);
  }
  if (!retriage && rowIds) return fail('Row IDs are for /spadework:re-triage. Triage takes the Azure DevOps work item number, e.g. /spadework:triage 1234');
  if (deep && !hasItem) return fail('--deep only works with a single work item, e.g. /spadework:triage 1234 --deep');
  if (hasItem && (hasProject || since || limit !== null)) return fail('A single work item can\'t be combined with --project, --repo, --since or --limit');

  let target = null;
  if (hasItem) {
    // Only Azure DevOps work item numbers: board rows are re-triage's and implement's input.
    const id = workItemId(item);
    const text = String(item).trim();
    if (id === null) return fail(`"${text}" isn't a work item number. Triage takes the Azure DevOps work item number, e.g. /spadework:triage 1234. To plan a row again, use /spadework:re-triage ${text}`);
    target = { kind: 'work_item', id };
  }
  const given = (value) => value !== null && value !== undefined;
  const limitValue = given(limit) ? wholeNumber(limit, { min: 1 }) : null;
  if (given(limit) && (limitValue === null || limitValue > MAX_LIMIT)) return fail(`--limit must be a whole number from 1 to ${MAX_LIMIT}`);
  const sinceDate = given(since) ? ado.parseDate(since) : null;
  if (given(since) && !sinceDate) return fail(`--since takes a date like 2026-09-01, not "${since}"`);
  return { target, limit: given(limit) ? limitValue : cfg.triage.max_cards_per_run, since: sinceDate };
}

// The repos the run covers: all of them, a project's, or the --repo ones.
// A repo whose clone isn't there is skipped, and the others go on.
// Returns { error } or { repos, skipped }.
function chooseRepos(cfg, project, repoNames) {
  let repos = cfg.repos;
  if (hasText(project)) {
    const projectName = findProject(cfg.tracker.projects, project);
    if (!projectName) return { error: unknownProject(cfg.tracker.projects, project) };
    repos = reposOf(cfg.repos, projectName);
    if (repoNames && repoNames.length) {
      const unknown = repoNames.filter((name) => !findRepo(repos, projectName, name));
      if (unknown.length) return { error: `Unknown repo in ${projectName}: ${unknown.join(', ')}. Its repos: ${repos.map((projectRepo) => projectRepo.name).join(', ') || 'none'}` };
      // Once each: --repo api,API names one repo, triaged once.
      repos = [...new Set(repoNames.map((name) => findRepo(repos, projectName, name)))];
    }
    if (!repos.length) return { error: `Project ${projectName} has no configured repos. Add one with /spadework:init` };
  }
  const skipped = repos.filter((repo) => !isFolder(repo.path)).map((repo) => ({
    project: repo.project,
    name: repo.name,
    label: repoLabel(repo),
    display: repoDisplay(repo),
    reason: missingFolder(repo),
  }));
  return { repos: repos.filter((repo) => isFolder(repo.path)), skipped };
}

// What this run covers.
//   project: null for every project, or one project (--project)
//   repoNames: null for all of the project's repos, or a list (--repo, needs --project)
//   item: one work item number, for a single-item run
//   deep: allow a wider code search (single item only)
//   limit: plan at most this many items in this run (--limit)
//   since: only items created on or after this YYYY-MM-DD date (--since)
//   retriage: a /spadework:re-triage run; rowIds: its row IDs, or null for all
//   sessionId: when given, the run check comes first, and the cut-off implement runs are listed
function plan({ project = null, repoNames = null, item = null, deep = false, limit = null, since = null, retriage = false, rowIds = null, sessionId = null } = {}) {
  const { config: cfg, error } = loadForRun();
  if (error) return { ok: false, error };
  const fail = (message) => ({ ok: false, error: message });
  if (sessionId !== null) {
    const run = runs.get(sessionId, { includeStale: true });
    if (!run || run.mode !== 'triage') return fail('No triage run in this session, so its safety checks are off. Start it again with /spadework:triage.');
  }

  const args = checkArgs({ project, repoNames, item, deep, limit, since, retriage, rowIds }, cfg);
  if (args.error) return fail(args.error);
  const { target } = args;
  const chosen = chooseRepos(cfg, project, repoNames);
  if (chosen.error) return fail(chosen.error);
  const { repos, skipped: skippedRepos } = chosen;
  if (!repos.length && skippedRepos.length && !retriage && !target) {
    return fail(`No repo folder to triage: ${skippedRepos.map((repo) => `${repo.label}: ${repo.reason}`).join('; ')}`);
  }

  const prefixes = {};
  for (const name of cfg.tracker.projects) {
    prefixes[name] = board.prefixOf(cfg, name);
    if (!prefixes[name]) return fail(`Project ${name} has no ID prefix. Run /spadework:init`);
  }

  let retriageRows = null;
  let leftAlone = [];
  if (retriage) {
    const picked = pickRetriageRows(cfg, rowIds);
    if (picked.error) return fail(picked.error);
    ({ rows: retriageRows, left_alone: leftAlone } = picked);
  }

  log.prune();
  runs.pruneStale();
  pruneTmp();

  // Triage only reads a graph the user built. It never builds or updates one.
  const graphOn = cfg.graphify.enabled && Boolean(graphify.version());

  const allRepos = !retriage && !hasText(project) && !target;
  return {
    ok: true,
    mode: retriage ? 'retriage' : target ? 'item' : 'backlog',
    all_repos: allRepos,
    warning: allRepos && cfg.repos.length > 1
      ? `This triage goes through all ${cfg.repos.length} repos one by one, so it takes longer and uses more tokens than a single repo. To triage one project, run /spadework:triage --project <name>.`
      : null,
    item: target,
    // A single item: each project's queries that tell whether it is in the
    // user's backlog, so the skill runs them alongside the item's `get`.
    scope: target ? scopeByProject(cfg, target.id) : null,
    deep,
    limit: args.limit,
    since: args.since,
    page_size: PAGE_SIZE,
    wiql_top: cfg.triage.max_backlog_items,
    page_fields: PAGE_FIELDS,
    work_items: cfg.tracker.work_items,
    check_fields: ['System.Title', 'System.WorkItemType', ...cfg.tracker.content_fields],
    include_parents: cfg.tracker.include_parents,
    include_related: cfg.tracker.include_related,
    organization: cfg.tracker.organization,
    on_triage: cfg.tracker.on_triage,
    triage_tag: config.TRIAGE_TAG,
    language: cfg.board.language,
    web_research: cfg.triage.web_research,
    statuses: {
      default: cfg.board.items.default_status,
      needs_info: cfg.board.items.needs_info_status,
      retriage: cfg.board.items.retriage_status,
    },
    prefixes,
    tmp: paths.all().tmp,
    retriage_rows: retriageRows,
    left_alone: leftAlone,
    recovery: recoveryRows(),
    skipped_repos: skippedRepos,
    repos: repos.map((repo) => ({
      name: repo.name,
      label: repoLabel(repo),
      display: repoDisplay(repo),
      project: repo.project,
      team: repo.team,
      path: repo.path,
      main_branch: repo.main_branch,
      area_paths: repo.area_paths,
      parts: repo.parts,
      wiql: ado.buildWiql(cfg.tracker, repo, { since: args.since }),
      ...graphFor(repo, cfg.graphify.enabled, graphOn),
    })),
  };
}

// The scope queries of one work item, by project: { "<project>": [{ repo, wiql }] }.
const scopeByProject = (cfg, id) => Object.fromEntries(cfg.tracker.projects.map((name) => [name, ado.scopeQueries(cfg, name, id)]));

// A planner's answer, brief and item stay in tmp when `triage finish` fails,
// so it can run again. Files older than a week are removed.
const KEEP_TMP_DAYS = 7;
function pruneTmp({ now = Date.now() } = {}) {
  let names;
  try {
    names = fs.readdirSync(paths.all().tmp);
  } catch {
    return;
  }
  for (const name of names.filter((entry) => /^((brief|plan|item)-\d+|implement-[A-Z][A-Z0-9]*-\d+)\./.test(entry))) {
    const file = path.join(paths.all().tmp, name);
    try {
      if (now - fs.statSync(file).mtimeMs > KEEP_TMP_DAYS * 24 * 60 * 60 * 1000) fs.rmSync(file, { force: true });
    } catch { /* gone already */ }
  }
}

// The rows a /spadework:re-triage run covers: the ones named, or every row
// set to Re-triage. A named row that isn't set to Re-triage is left alone.
function pickRetriageRows(cfg, rowIds) {
  const status = cfg.board.items.retriage_status;
  let rows;
  const leftAlone = [];
  if (rowIds) {
    const parsed = board.parseIdList(rowIds);
    if (parsed.error) return { error: parsed.error };
    rows = [];
    for (const text of parsed.ids) {
      const row = board.readRow(text);
      if (!row) return { error: `${text} not found` };
      if (config.sameName(row.status, status)) rows.push(row);
      else leftAlone.push(`${text} isn't set to ${status}, left alone`);
    }
    if (!rows.length && !leftAlone.length) return { error: 'No row IDs given' };
  } else {
    rows = board.listRows().rows.filter((row) => config.sameName(row.status, status));
  }
  return {
    rows: rows.map((row) => {
      const workItemIdOf = row.work_item ? row.work_item.id : null;
      return {
        id: row.id,
        project: row.project,
        status: row.status,
        repo: row.repo,
        work_item_id: workItemIdOf,
        type: row.type,
        // The queries that tell whether its work item is still in the user's backlog.
        scope: workItemIdOf ? ado.scopeQueries(cfg, row.project, workItemIdOf) : null,
      };
    }),
    left_alone: leftAlone,
  };
}

// Implement runs that were cut off: their rows are set to Blocked here, and the
// lines say what was done. Null when there are none.
function recoveryRows() {
  const recovered = require('./implement').recover();
  return recovered.ok && recovered.lines.length ? recovered.lines : null;
}

// Repository IDs in a work item's development links (branch, commit, pull request).
const linkedRepoIds = (urls) => [...new Set((urls || []).map(baseBranch.parseLink).filter(Boolean).map((link) => link.repo))];

// Picks the repo for each item. Steps, in order, stopping at the first
// clear answer: the Repo set on the item's row, only one candidate,
// linked branch/commit/PR, past rows, else unclear.
// Unclear items get a Needs info row asking which repo. It never guesses from
// keywords: planning in the wrong repo wastes a whole plan.
// items: [{ id, project, area_path, links: [urls], row_repo, past_rows }]
//   past_rows: the hint the duplicate check gave ({ repo, reason } or null)
// current: the repo this run is on ({ project, repo }), or null.
// Repo names in the result are names within the item's project.
function match(items, current = null) {
  const { config: cfg, error } = loadForRun();
  if (error) return { ok: false, error };
  const results = items.map((item) => {
    const list = ado.backlogsOf(cfg.repos, item);
    const projectRepos = reposOf(cfg.repos, item.project).map((projectRepo) => projectRepo.name);
    let repo = null;
    let reason = null;
    let problem = null;

    const rowRepo = String(item.row_repo || '').trim();
    if (rowRepo) {
      const chosen = findRepo(cfg.repos, item.project, rowRepo);
      if (chosen) {
        repo = chosen.name;
        reason = 'set on the row';
      } else {
        problem = `The Repo on the row, "${rowRepo}", isn't a configured repo of project ${item.project}`;
      }
    }
    if (!repo && !problem && list.length === 1) {
      [repo] = list;
      reason = 'only repo with this backlog';
    }
    if (!repo && !problem && list.length > 1) {
      const linked = linkedRepoIds(item.links);
      const byLink = list.filter((name) => {
        const id = findRepo(cfg.repos, item.project, name).repo_id;
        return id && linked.includes(id.toLowerCase());
      });
      if (byLink.length === 1) {
        [repo] = byLink;
        reason = 'linked branch, commit or pull request';
      }
    }
    if (!repo && !problem && item.past_rows && item.past_rows.repo) {
      // The hint only counts for a repo that can hold the item.
      const hinted = findRepo(cfg.repos, item.project, item.past_rows.repo);
      const pool = list.length ? list : projectRepos;
      if (hinted && pool.includes(hinted.name)) {
        repo = hinted.name;
        reason = item.past_rows.reason || 'past rows';
      }
    }
    let status = 'unclear';
    if (repo) status = !current || !current.repo || sameRepo({ project: item.project, repo }, current) ? 'mine' : 'other';
    const options = list.length ? list : projectRepos;
    const question = status === 'unclear'
      ? (options.length
        ? `Which repo does this belong to: ${options.join(', ')}? Set the repo on the row, then set the status to ${cfg.board.items.retriage_status}.`
        : `No configured repo is in project ${item.project}. Add its repo with /spadework:init.`)
      : null;
    return { id: item.id, status, repo, reason, candidates: list, problem, question };
  });
  return { ok: true, items: results };
}

// Brings the repo's main branch up to date, or another branch of it (a Bug's
// base branch). Never pulls: that would merge into whatever branch the user
// has checked out.
function prepare(project, repoName, branch = null) {
  const { config: cfg, error } = loadForRun();
  if (error) return { ok: false, error };
  const repo = findRepo(cfg.repos, project, repoName);
  if (!repo) return { ok: false, error: `Unknown repo: ${project}/${repoName}` };
  if (!isFolder(repo.path)) return { ok: false, error: `${repoLabel(repo)}: ${missingFolder(repo)}` };
  const target = branch || repo.main_branch;
  if (!config.isBranchName(target)) return { ok: false, error: `"${target}" isn't a valid branch name` };
  const fetched = fetchBranch(repo.path, target);
  if (!fetched.ok) return { ok: false, error: `git fetch failed in ${repo.path}: ${fetched.error}` };
  const head = git(repo.path, ['rev-parse', '--short', `origin/${target}`]);
  return { ok: true, repo: repo.name, project: repo.project, path: repo.path, main_branch: repo.main_branch, branch: target, commit: head.ok ? head.stdout : null };
}

module.exports = { plan, match, prepare, linkedRepoIds, graphFor };
