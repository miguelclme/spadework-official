'use strict';

// Helpers for /spadework:init. The skill fetches what Azure DevOps has
// (projects, repos, teams); the user fills in the rest in the config panel
// (board/config.html, served by lib/board-server.js). This file does the parts
// that must be exact: reading what's there, the values the panel starts
// from, detecting a repo's remote and main branch, and saving.

const fs = require('fs');
const path = require('path');

const config = require('./config');
const ado = require('./ado');
const board = require('./board');
const graphify = require('./graphify');
const stack = require('./stack');
const paths = require('./paths');
const { git, samePath, originUrl, NETWORK_TIMEOUT_MS } = require('./git');
const { writeJsonAtomic } = require('./fs-atomic');
const { parseJson, parseLooseJson, readJsonFile } = require('./json-file');

const DEFAULT_STATUSES = ['New', 'Needs info', 'Re-triage', 'Approved', 'In progress', 'Blocked', 'Resume', 'Implemented', 'Merged', 'Done', 'Rejected'];

// Everything init asks about, with the values it suggests.
const DEFAULTS = {
  tracker: {
    include_parents: true,
    include_related: true,
    on_triage: { set_state_enabled: false, set_state: null, only_from: [] },
    content_fields: config.DEFAULT_CONTENT_FIELDS,
  },
  board: {
    language: 'en-US',
    port: config.DEFAULT_BOARD_PORT,
    items: {
      statuses: DEFAULT_STATUSES,
      default_status: 'New',
      needs_info_status: 'Needs info',
      retriage_status: 'Re-triage',
      approved_status: 'Approved',
      in_progress_status: 'In progress',
      blocked_status: 'Blocked',
      resume_status: 'Resume',
      implemented_status: 'Implemented',
      merged_status: 'Merged',
      done_status: 'Done',
      rejected_status: 'Rejected',
    },
  },
  graphify: { enabled: false },
  triage: { reanalyze_when_card_changes: true, max_cards_per_run: 10, max_backlog_items: 1000, web_research: false },
  implement: { branch_prefix: '', max_review_rounds: 2, workspace: 'branch' },
  merge: { integrate: false },
};

// The whole config.json shape: the defaults, with "<...>" where the user's
// answers go. Init fills it in, so it never has to guess a field's name.
// One repo and one work item type are shown: add as many as were chosen.
const TEMPLATE = {
  version: 2,
  tracker: {
    provider: 'azure_devops',
    organization: '<organization>',
    projects: ['<project>'],
    user_email: '<email>',
    process: `<${config.PROCESSES.join('|')}>`,
    states: ['<state>'],
    ...DEFAULTS.tracker,
    work_items: [{ type: '<type>', plan: `<${config.PLANS.join('|')}>`, creates: '<type it splits into: only with plan "split">' }],
  },
  repos: [{
    path: '<local folder>',
    main_branch: '<main branch>',
    project: '<project>',
    repo: '<repo name>',
    repo_id: '<repo id, or null>',
    team: '<team>',
    area_paths: [{ value: '<area path>', include_children: '<true|false, as the team has it>' }],
    parts: ['<part: leave the field out for the whole repo>'],
    test_commands: ['<command that runs the tests, e.g. npm test: leave the list empty to skip tests after a merge>'],
  }],
  board: { ...DEFAULTS.board, projects: { '<project>': { prefix: '<ID prefix, like SHOP>' } } },
  graphify: DEFAULTS.graphify,
  triage: DEFAULTS.triage,
  implement: DEFAULTS.implement,
  merge: DEFAULTS.merge,
};

// The usual work item type names of each process, shown as examples when init
// asks which types Spadework plans. Init doesn't check them against Azure
// DevOps: the user types them as the project spells them.
const WORK_ITEM_EXAMPLES = {
  CMMI: ['Feature', 'Requirement', 'Change Request', 'Bug'],
  Agile: ['Feature', 'User Story', 'Bug'],
  Scrum: ['Feature', 'Product Backlog Item', 'Bug'],
  Basic: ['Epic', 'Issue'],
  Custom: [],
};

// What init needs to start: the current file (even if it's invalid, so the
// user sees their values) and the defaults. Whether graphify is installed is
// checked by triage and validate, not here: `graphify --version` takes seconds
// on Windows and would hold up the board's helper.
function state() {
  const dataPaths = paths.all();
  // Init owns this folder; create it so the skill can write init-options.json there.
  fs.mkdirSync(dataPaths.root, { recursive: true });
  let raw = null;
  let parseError = null;
  let exists = false;
  try {
    const text = fs.readFileSync(dataPaths.config, 'utf8');
    exists = true;
    raw = parseJson(text);
  } catch (err) {
    if (err.code !== 'ENOENT') parseError = err.message;
  }
  const checked = raw ? config.validate(raw) : null;
  let stackText = null;
  try {
    stackText = fs.readFileSync(dataPaths.stack, 'utf8');
  } catch { /* none yet */ }
  return {
    // options_exists: the skill Reads the file before it writes it again (Write needs that).
    paths: {
      root: dataPaths.root, config: dataPaths.config, options: dataPaths.initOptions, options_exists: fs.existsSync(dataPaths.initOptions),
      draft: dataPaths.configDraft, stack_draft: dataPaths.stackDraft,
    },
    stack: stackText,
    exists,
    parse_error: parseError,
    current: raw,
    validation: checked && { ok: checked.ok, errors: checked.errors, warnings: checked.warnings },
    template: TEMPLATE,
    defaults: DEFAULTS,
    suggested_prefixes: suggestedPrefixes(raw),
    processes: config.PROCESSES,
    states_by_process: config.DEFAULT_STATES,
    work_items: { plans: config.PLANS, examples_by_process: WORK_ITEM_EXAMPLES },
    start: startValues(raw),
  };
}

// A config with nothing filled in: the defaults, and empty where the user's
// answers go. The board's port is left out, so the default is used.
function blankConfig() {
  const { port, ...boardDefaults } = DEFAULTS.board;
  return structuredClone({
    version: 2,
    tracker: { provider: 'azure_devops', organization: '', projects: [], user_email: '', process: '', states: [], ...DEFAULTS.tracker },
    repos: [],
    board: { ...boardDefaults, projects: {} },
    graphify: DEFAULTS.graphify,
    triage: DEFAULTS.triage,
    implement: DEFAULTS.implement,
    merge: DEFAULTS.merge,
  });
}

// The config the panel starts from, and why: the current one ("current"),
// or a blank one ("blank": no file, or one that isn't JSON or an object;
// saving keeps that file as config.json.bak). A config with no tracker and no
// repos (the one a first run writes, with only the board) is blank too,
// keeping its board.
function startValues(raw) {
  if (!config.isObject(raw)) return { from: 'blank', config: blankConfig() };
  if (raw.tracker === undefined && raw.repos === undefined) {
    const blank = blankConfig();
    if (config.isObject(raw.board)) blank.board = { ...blank.board, ...structuredClone(raw.board) };
    return { from: 'blank', config: blank };
  }
  return { from: 'current', config: raw };
}

const MAX_NAME = 300;
const textValue = (value) => (typeof value === 'string' && value.trim() !== '' && value.length <= MAX_NAME ? value.trim() : null);
const listOf = (value) => (Array.isArray(value) ? value.slice(0, 1000) : []);

// What the skill fetched from Azure DevOps for the panel (init-options.json),
// cut down to the fields the panel uses, or null when there is none. Teams'
// area paths are taken as Azure DevOps names them too (areaPaths, includeChildren).
function options() {
  let raw;
  try {
    raw = parseLooseJson(fs.readFileSync(paths.all().initOptions, 'utf8'));
  } catch {
    return null;
  }
  if (!config.isObject(raw)) return null;
  const areas = (team) => listOf(team.area_paths || team.areaPaths).filter(config.isObject).map((area) => ({
    value: textValue(area.value), include_children: (area.include_children ?? area.includeChildren) !== false,
  })).filter((area) => area.value);
  return {
    organization: textValue(raw.organization),
    projects: listOf(raw.projects).filter((project) => config.isObject(project) && textValue(project.name)).map((project) => ({
      name: textValue(project.name),
      repos: listOf(project.repos).filter((repo) => config.isObject(repo) && textValue(repo.name)).map((repo) => ({ id: textValue(repo.id), name: textValue(repo.name) })),
      teams: listOf(project.teams).filter((team) => config.isObject(team) && textValue(team.name)).map((team) => ({ name: textValue(team.name), area_paths: areas(team) })),
    })),
  };
}

// Whether a repo folder has a code graph, and the command that builds one when it hasn't.
function graphOf(repoPath) {
  const folder = path.resolve(paths.expandTilde(repoPath));
  const has = Boolean(graphify.graphFile(folder));
  return { graph: has, build_command: has ? null : graphify.buildCommand(folder) };
}

// Everything the panel needs: the state, the options, the current stack
// notes by section, and the graph of each repo it starts with (by path).
// The projects are the ones the skill fetched (or the config's), and so are
// the suggested ID prefixes. A blank start sends no validation: its missing
// sections are the user's to fill in, not problems.
function panelState() {
  const current = state();
  const fetched = options();
  const start = current.start.config;
  const repos = Array.isArray(start.repos) ? start.repos : [];
  const graphs = Object.fromEntries(repos.filter((repo) => config.isObject(repo) && config.isNonEmptyString(repo.path)).map((repo) => [repo.path, graphOf(repo.path)]));
  const projects = fetched && fetched.projects.length ? fetched.projects.map((project) => project.name)
    : (config.isObject(start.tracker) && Array.isArray(start.tracker.projects) ? start.tracker.projects.filter(config.isNonEmptyString) : []);
  return {
    ...current,
    validation: current.start.from === 'blank' ? null : current.validation,
    options: fetched,
    projects,
    suggested_prefixes: suggestedPrefixes({ tracker: { projects } }),
    stack_sections: current.stack ? stack.parse(current.stack) : {},
    graphs,
  };
}

// The ID prefix suggested for each project of a config (or of the one being written).
function suggestedPrefixes(raw) {
  const taken = [];
  const out = {};
  for (const name of (raw && raw.tracker && Array.isArray(raw.tracker.projects) ? raw.tracker.projects : [])) {
    out[name] = board.suggestPrefix(name, taken);
    taken.push(out[name]);
  }
  return out;
}

// What init can tell about a folder the user gave for a repo. With
// expected = { organization, project, repo }, it also checks the clone is
// that repo. Names are compared, so HTTPS and SSH clones both work.
function detectRepo(input, expected = {}) {
  const resolved = path.resolve(paths.expandTilde(String(input || '').trim()));
  const result = {
    input,
    path: resolved,
    name: path.basename(resolved),
    exists: false,
    is_repo: false,
    top_level: null,
    origin_url: null,
    ado: null,
    main_branch: null,
    main_branch_source: null,
    problems: [],
  };

  let stats = null;
  try {
    stats = fs.statSync(resolved);
  } catch { /* reported below */ }
  if (!stats || !stats.isDirectory()) {
    result.problems.push(stats ? 'not a folder' : 'folder not found');
    return result;
  }
  result.exists = true;

  const top = git(resolved, ['rev-parse', '--show-toplevel']);
  if (top.missing) {
    result.problems.push('git is not installed or not on PATH');
    return result;
  }
  if (!top.ok) {
    result.problems.push('not a git repo');
    return result;
  }
  result.is_repo = true;
  result.top_level = path.resolve(top.stdout);
  if (!samePath(result.top_level, resolved)) {
    result.problems.push(`this folder is inside the repo at ${result.top_level}. Use that folder instead`);
  }

  result.origin_url = originUrl(resolved);
  if (!result.origin_url) {
    result.problems.push('no "origin" remote');
  } else {
    result.ado = ado.parseRemote(result.origin_url);
    if (!result.ado) {
      result.problems.push(`origin is not an Azure DevOps URL (${result.origin_url})`);
    } else {
      if (expected.organization && !config.sameName(result.ado.organization, expected.organization)) {
        result.problems.push(`this folder is a clone from organization "${result.ado.organization}", not "${expected.organization}"`);
      }
      if (expected.project && expected.repo && !config.sameRepo(result.ado, expected)) {
        result.problems.push(`this folder is a clone of ${result.ado.project}/${result.ado.repo}, not ${expected.project}/${expected.repo}`);
      }
    }
  }
  if (expected.repo) result.name = expected.repo;
  else if (result.ado) result.name = result.ado.repo;

  Object.assign(result, detectMainBranch(resolved, Boolean(result.origin_url)));
  return result;
}

// origin/HEAD first (set by clone), then the usual names, then ask the server.
function detectMainBranch(repoPath, hasOrigin) {
  const head = git(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head.ok && head.stdout.startsWith('origin/')) {
    return { main_branch: head.stdout.slice('origin/'.length), main_branch_source: 'origin/HEAD' };
  }
  for (const candidate of ['main', 'master', 'develop']) {
    if (git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${candidate}`]).ok) {
      return { main_branch: candidate, main_branch_source: `origin/${candidate} exists` };
    }
  }
  if (hasOrigin) {
    const remote = git(repoPath, ['ls-remote', '--symref', 'origin', 'HEAD'], { timeout: NETWORK_TIMEOUT_MS });
    const match = remote.ok && remote.stdout.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m);
    if (match) return { main_branch: match[1], main_branch_source: 'origin default branch' };
  }
  return { main_branch: null, main_branch_source: null };
}

// Makes a checked config the config. The previous one is kept as config.json.bak.
function writeConfig(raw) {
  const dataPaths = paths.all();
  for (const folder of [dataPaths.root, dataPaths.sessions, dataPaths.implementing, dataPaths.logs]) {
    fs.mkdirSync(folder, { recursive: true });
  }
  if (fs.existsSync(dataPaths.config)) fs.copyFileSync(dataPaths.config, `${dataPaths.config}.bak`);
  writeJsonAtomic(dataPaths.config, raw);
  return dataPaths.config;
}

// The config.json of a first run, before anything is saved: only the
// board's defaults, on the port the helper will use.
function writeStarter(port) {
  return writeConfig({ board: { ...structuredClone(DEFAULTS.board), port } });
}

// Validates a draft written by hand and, if it's valid, makes it the config.
function save({ draft = paths.all().configDraft } = {}) {
  let raw;
  try {
    raw = readJsonFile(draft);
  } catch (err) {
    const message = err.code === 'ENOENT' ? `no draft at ${draft}` : `the draft is not valid JSON: ${err.message}`;
    return { ok: false, errors: [{ field: '', message }], warnings: [] };
  }

  const checked = config.validate(raw);
  if (!checked.ok) return { ok: false, errors: checked.errors, warnings: checked.warnings };
  const file = writeConfig(raw);
  fs.rmSync(draft, { force: true });
  return { ok: true, file, errors: [], warnings: checked.warnings };
}

// The current config.json as it is, or null.
function currentRaw() {
  try {
    return parseJson(fs.readFileSync(paths.all().config, 'utf8'));
  } catch {
    return null;
  }
}

// What the panel doesn't show stays as config.json has it: the board's port
// and tracker.content_fields. The user changes those by hand.
function keepHandEdited(raw, current) {
  const next = structuredClone(raw);
  const kept = (section, key) => (config.isObject(current) && config.isObject(current[section]) ? current[section][key] : undefined);
  if (config.isObject(next.board)) {
    if (kept('board', 'port') === undefined) delete next.board.port;
    else next.board.port = kept('board', 'port');
  }
  if (config.isObject(next.tracker) && kept('tracker', 'content_fields') !== undefined) next.tracker.content_fields = kept('tracker', 'content_fields');
  return next;
}

// The panel's Save: checks the config and the stack notes, and writes both
// only when both are fine. Each problem keeps its field (config) or its
// section (stack notes), so the panel shows it there.
function savePanel({ config: raw, stack: text } = {}) {
  if (!config.isObject(raw)) return { ok: false, config: { errors: [{ field: '', message: 'config must be a JSON object' }], warnings: [] }, stack: { errors: [], warnings: [] } };
  if (typeof text !== 'string') return { ok: false, config: { errors: [], warnings: [] }, stack: { errors: [{ section: '', message: 'the stack notes must be text' }], warnings: [] } };
  const next = keepHandEdited(raw, currentRaw());
  const checked = config.validate(next);
  // The repos the notes need a section for: the checked ones, or the ones the config names.
  const labels = checked.ok ? checked.config.repos.map(config.repoLabel)
    : (Array.isArray(next.repos) ? next.repos : []).filter((repo) => config.isObject(repo) && config.isNonEmptyString(repo.project) && config.isNonEmptyString(repo.repo)).map((repo) => `${repo.project}/${repo.repo}`);
  const notes = stack.check(text, labels);
  const answer = { config: { errors: checked.errors, warnings: checked.warnings }, stack: notes };
  if (!checked.ok || notes.errors.length) return { ok: false, ...answer };
  const files = { config: writeConfig(next), stack: stack.write(text) };
  return { ok: true, ...answer, files };
}

module.exports = { state, panelState, startValues, options, graphOf, detectRepo, save, savePanel, writeStarter, suggestedPrefixes, DEFAULTS, TEMPLATE, WORK_ITEM_EXAMPLES };
