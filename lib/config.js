'use strict';

// Loads and validates ~/.spadework/config.json.
// Every command calls this first and stops on errors. Messages name the
// field and say what to fix, because users also edit the file by hand.
// It also finds projects and repos by name, ignoring case, the same way
// for every command (findProject, findRepo, reposOf, sameRepo).

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { parseJson } = require('./json-file');

const PROCESSES = ['CMMI', 'Agile', 'Scrum', 'Basic', 'Custom'];

const DEFAULT_STATES = {
  CMMI: ['Proposed', 'Active', 'Resolved'],
  Agile: ['New', 'Active', 'Resolved'],
  Scrum: ['New', 'Approved', 'Committed'],
  Basic: ['To Do', 'Doing'],
  Custom: [],
};

// Status roles in board.items. Commands always look statuses up by role.
const STATUS_ROLES = [
  'default_status',
  'needs_info_status',
  'retriage_status',
  'approved_status',
  'in_progress_status',
  'blocked_status',
  'resume_status',
  'implemented_status',
  'merged_status',
  'done_status',
  'rejected_status',
];

// The tags Spadework puts on work items in Azure DevOps, so people can see
// what was done to them. Triage tags the item it moved; handoff tags the items
// it created. These are the only places the names are written: code reads them
// from here, and the skills get them from the helper's answers.
const TRIAGE_TAG = 'spadework-triage';
const HANDOFF_TAG = 'spadework-handoff';
// The tag that ties a work item to the board row it came from: Spadework-SHOP-41.
const rowTag = (rowId) => `Spadework-${rowId}`;
// /spadework:design-push puts both of these on each Epic and Feature it
// creates. The second lets a later push find what an earlier one made.
const DESIGN_TAG = 'spadework';
const DESIGN_PUSHED_TAG = 'spadework-design-pushed';
// A work item's tags ("a; b") as a list, and whether it has one of them.
const tagList = (value) => String(value || '').split(';').map((tag) => tag.trim()).filter(Boolean);
const hasTag = (value, name) => tagList(value).some((tag) => sameName(tag, name));

const WORKSPACES = ['branch', 'worktree'];

// How deep triage plans a work item type: split it into Requirements, keep
// the spec and add the code side, or decide everything.
const PLANS = ['split', 'how', 'full'];
// Bugs go to the bug triager, and splitting a bug into Requirements makes no sense.
const BUG_TYPE = 'Bug';

const KNOWN_KEYS = {
  '': ['version', 'tracker', 'repos', 'board', 'graphify', 'triage', 'implement', 'merge'],
  tracker: ['provider', 'organization', 'projects', 'user_email', 'process', 'states',
    'include_parents', 'include_related', 'on_triage', 'content_fields', 'work_items'],
  'tracker.on_triage': ['set_state_enabled', 'set_state', 'only_from'],
  work_item: ['type', 'plan', 'creates'],
  repo: ['path', 'main_branch', 'project', 'repo', 'repo_id', 'team', 'area_paths', 'parts', 'test_commands'],
  area: ['value', 'include_children'],
  board: ['language', 'projects', 'items', 'port'],
  'board.project': ['prefix'],
  'board.items': ['statuses', ...STATUS_ROLES],
  graphify: ['enabled'],
  triage: ['reanalyze_when_card_changes', 'max_cards_per_run', 'max_backlog_items', 'web_research'],
  implement: ['branch_prefix', 'max_review_rounds', 'workspace'],
  merge: ['integrate'],
};

class Report {
  constructor() {
    this.errors = [];
    this.warnings = [];
  }
  error(field, message) { this.errors.push({ field, message }); }
  warn(field, message) { this.warnings.push({ field, message }); }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';
// Names are matched ignoring case: work items, flags and board rows may spell them differently.
const sameName = (first, second) => String(first || '').trim().toLowerCase() === String(second || '').trim().toLowerCase();

function checkUnknownKeys(section, knownKey, field, report) {
  if (!isObject(section)) return;
  for (const key of Object.keys(section)) {
    if (!KNOWN_KEYS[knownKey].includes(key)) {
      report.warn(field ? `${field}.${key}` : key, 'unknown field, it is ignored');
    }
  }
}

function requireObject(parent, key, field, report) {
  const value = parent[key];
  if (value === undefined) {
    report.error(field, 'missing');
    return null;
  }
  if (!isObject(value)) {
    report.error(field, 'must be an object');
    return null;
  }
  return value;
}

function requireString(section, key, field, report) {
  const value = section[key];
  if (value === undefined) report.error(field, 'missing');
  else if (!isNonEmptyString(value)) report.error(field, 'must be a non-empty string');
  else return value.trim();
  return null;
}

function optionalBool(section, key, field, fallback, report) {
  const value = section[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    report.error(field, 'must be true or false');
    return fallback;
  }
  return value;
}

function optionalInt(section, key, field, fallback, min, report) {
  const value = section[key];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min) {
    report.error(field, `must be a whole number of ${min} or more`);
    return fallback;
  }
  return value;
}

function stringList(section, key, field, report) {
  const value = section[key];
  if (value === undefined) {
    report.error(field, 'missing');
    return null;
  }
  if (!Array.isArray(value) || value.length === 0) {
    report.error(field, 'must be a non-empty list');
    return null;
  }
  const items = [];
  value.forEach((item, index) => {
    if (!isNonEmptyString(item)) report.error(`${field}[${index}]`, 'must be a non-empty string');
    else items.push(item.trim());
  });
  const seen = new Set();
  for (const item of items) {
    const lowerCased = item.toLowerCase();
    if (seen.has(lowerCased)) report.error(field, `"${item}" is listed more than once`);
    seen.add(lowerCased);
  }
  return items;
}

// --- sections ---------------------------------------------------------------

function validateTracker(raw, report) {
  const tracker = requireObject(raw, 'tracker', 'tracker', report);
  if (!tracker) return null;
  checkUnknownKeys(tracker, 'tracker', 'tracker', report);

  if (tracker.provider !== 'azure_devops') {
    report.error('tracker.provider', 'must be "azure_devops" (the only tracker in this version)');
  }
  const organization = requireString(tracker, 'organization', 'tracker.organization', report);
  if (organization && /[/:\s]/.test(organization)) {
    report.error('tracker.organization', 'use only the organization name (e.g. "contoso"), not a URL');
  }
  const projects = stringList(tracker, 'projects', 'tracker.projects', report);

  const userEmail = requireString(tracker, 'user_email', 'tracker.user_email', report);
  if (userEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(userEmail)) {
    report.error('tracker.user_email', 'is not a valid email address');
  }

  let processName = tracker.process;
  if (processName === undefined) {
    report.error('tracker.process', `missing. Use one of: ${PROCESSES.join(', ')}`);
    processName = null;
  } else if (!PROCESSES.includes(processName)) {
    report.error('tracker.process', `unknown process "${processName}". Use one of: ${PROCESSES.join(', ')}`);
    processName = null;
  }

  const states = stringList(tracker, 'states', 'tracker.states', report);

  return {
    provider: 'azure_devops',
    organization,
    projects,
    user_email: userEmail,
    process: processName,
    states,
    include_parents: optionalBool(tracker, 'include_parents', 'tracker.include_parents', true, report),
    include_related: optionalBool(tracker, 'include_related', 'tracker.include_related', true, report),
    on_triage: validateOnTriage(tracker, report),
    content_fields: validateContentFields(tracker, report),
    work_items: validateWorkItems(tracker, report),
  };
}

// The work item types triage reads, each with its depth. Missing means every
// type at `full`, as before this list existed, and is kept as null.
function validateWorkItems(tracker, report) {
  const value = tracker.work_items;
  const listField = 'tracker.work_items';
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) {
    report.error(listField, 'must be a non-empty list of { "type", "plan" }');
    return null;
  }
  const items = [];
  value.forEach((item, index) => {
    const field = `${listField}[${index}]`;
    if (!isObject(item)) {
      report.error(field, 'must be an object with "type", "plan" and, for split, "creates"');
      return;
    }
    checkUnknownKeys(item, 'work_item', field, report);
    const type = requireString(item, 'type', `${field}.type`, report);
    if (type && items.some((other) => sameName(other.type, type))) {
      report.error(`${field}.type`, `"${type}" is listed more than once`);
    }

    let plan = null;
    if (item.plan === undefined) report.error(`${field}.plan`, 'missing');
    else if (!PLANS.includes(item.plan)) report.error(`${field}.plan`, `must be one of: ${PLANS.join(', ')}`);
    else plan = item.plan;

    let creates = null;
    if (plan === 'split') {
      creates = requireString(item, 'creates', `${field}.creates`, report);
      if (type && sameName(type, BUG_TYPE)) {
        report.error(`${field}.plan`, `"split" can't be used on ${BUG_TYPE}: splitting a bug into Requirements makes no sense`);
      }
    } else if (item.creates !== undefined) {
      report.error(`${field}.creates`, 'is only for "split"');
    }
    if (type && plan) items.push({ type, plan, creates });
  });
  // A type a split creates can't be split itself: Feature into Requirement into Feature would never end.
  items.forEach((item) => {
    if (item.plan === 'split' && items.some((other) => other.plan === 'split' && sameName(other.type, item.creates))) {
      report.error(listField, `${item.type} is split into ${item.creates}, which is also split. A type a split creates can't be split`);
    }
  });
  if (items.some((item) => item.plan === 'split')) {
    report.warn(listField, 'split is in use: handoff creates work items, so your Azure DevOps access needs Work Items: Read & Write');
  }
  return items;
}

// The text fields that say what a work item asks for, in all four
// processes. A field a type doesn't have just comes back empty. Triage
// plans an item again only when these (or its title or type) change.
const DEFAULT_CONTENT_FIELDS = [
  'System.Description',
  'Microsoft.VSTS.Common.AcceptanceCriteria',
  'Microsoft.VSTS.TCM.ReproSteps',
  'Microsoft.VSTS.TCM.SystemInfo',
  'Microsoft.VSTS.CMMI.Symptom',
  'Microsoft.VSTS.CMMI.ProposedFix',
  'Microsoft.VSTS.CMMI.Analysis',
  'Microsoft.VSTS.CMMI.CorrectiveActionPlan',
  'Microsoft.VSTS.CMMI.MitigationPlan',
  'Microsoft.VSTS.CMMI.ContingencyPlan',
  'Microsoft.VSTS.CMMI.MitigationTriggers',
  'Microsoft.VSTS.CMMI.Justification',
  'Microsoft.VSTS.CMMI.ImpactOnArchitecture',
  'Microsoft.VSTS.CMMI.ImpactOnUserExperience',
  'Microsoft.VSTS.CMMI.ImpactOnTest',
  'Microsoft.VSTS.CMMI.ImpactOnDevelopment',
  'Microsoft.VSTS.CMMI.ImpactOnTechnicalPublications',
];

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
// Fields that change without the work changing. Counting them would plan
// items again for nothing.
const NOT_CONTENT = ['System.History', 'System.State', 'System.Reason', 'System.Rev', 'System.ChangedDate',
  'System.AssignedTo', 'System.IterationPath', 'System.Tags', 'System.BoardColumn', 'System.CommentCount'];

function validateContentFields(tracker, report) {
  const value = tracker.content_fields;
  if (value === undefined) return [...DEFAULT_CONTENT_FIELDS];
  if (!Array.isArray(value)) {
    report.error('tracker.content_fields', 'must be a list of field reference names, e.g. "System.Description"');
    return [...DEFAULT_CONTENT_FIELDS];
  }
  const fields = [];
  value.forEach((item, index) => {
    const field = `tracker.content_fields[${index}]`;
    if (!isNonEmptyString(item) || !FIELD_NAME.test(item.trim())) {
      report.error(field, 'must be a field reference name, e.g. "System.Description" or "Custom.TechnicalNotes"');
      return;
    }
    const name = item.trim();
    const blocked = NOT_CONTENT.find((other) => sameName(other, name));
    if (blocked) {
      report.error(field, `${name} changes without the work changing (comments, state, sprint...). Remove it`);
      return;
    }
    if (fields.some((other) => sameName(other, name))) report.error(field, `"${name}" is listed more than once`);
    else fields.push(name);
  });
  return fields;
}

function validateOnTriage(tracker, report) {
  const disabled = { set_state_enabled: false, set_state: null, only_from: [] };
  const onTriage = tracker.on_triage;
  if (onTriage === undefined) return disabled;
  if (!isObject(onTriage)) {
    report.error('tracker.on_triage', 'must be an object');
    return disabled;
  }
  checkUnknownKeys(onTriage, 'tracker.on_triage', 'tracker.on_triage', report);

  const enabled = optionalBool(onTriage, 'set_state_enabled', 'tracker.on_triage.set_state_enabled', false, report);
  if (!enabled) {
    // Keep what the user typed so init can show it, but don't check it.
    return {
      set_state_enabled: false,
      set_state: isNonEmptyString(onTriage.set_state) ? onTriage.set_state.trim() : null,
      only_from: Array.isArray(onTriage.only_from)
        ? onTriage.only_from.filter(isNonEmptyString).map((state) => state.trim())
        : [],
    };
  }

  const setState = requireString(onTriage, 'set_state', 'tracker.on_triage.set_state', report);
  const onlyFrom = stringList(onTriage, 'only_from', 'tracker.on_triage.only_from', report) || [];
  if (setState && onlyFrom.some((state) => sameName(state, setState))) {
    report.warn('tracker.on_triage.only_from', `contains the target state "${setState}", so moving does nothing for those items`);
  }
  report.warn('tracker.on_triage', 'state move is on: your Azure DevOps access needs Work Items: Read & Write');
  return { set_state_enabled: true, set_state: setState, only_from: onlyFrom };
}

// Each repo is one Azure DevOps Git repository with a local clone and a
// backlog: the team whose area paths hold its work items. Several repos may
// share a team. A repo is known by its project and its Azure DevOps name:
// two projects may each have a repo called "api". Its label, "Shop/api",
// names it where the project isn't clear (--project with --repo, stack.md
// sections, locks, logs).
function validateRepos(raw, report, { checkPaths, projects }) {
  const repos = raw.repos;
  if (repos === undefined) {
    report.error('repos', 'missing');
    return null;
  }
  if (!Array.isArray(repos) || repos.length === 0) {
    report.error('repos', 'must be a non-empty list');
    return null;
  }
  const projectNames = new Map((projects || []).map((project) => [project.toLowerCase(), project]));
  const validRepos = [];
  const seenPaths = new Set();
  const seenNames = new Map();
  repos.forEach((repo, index) => {
    const field = `repos[${index}]`;
    if (!isObject(repo)) {
      report.error(field, 'must be an object with "path", "main_branch", "project", "repo", "team" and "area_paths"');
      return;
    }
    checkUnknownKeys(repo, 'repo', field, report);
    const rawPath = requireString(repo, 'path', `${field}.path`, report);
    const mainBranch = requireString(repo, 'main_branch', `${field}.main_branch`, report);
    // It goes to git fetch: a name starting with "-" would be read as an option.
    if (mainBranch && !isBranchName(mainBranch)) {
      report.error(`${field}.main_branch`, `"${mainBranch}" isn't a valid branch name`);
    }
    let project = requireString(repo, 'project', `${field}.project`, report);
    const name = requireString(repo, 'repo', `${field}.repo`, report);
    const team = requireString(repo, 'team', `${field}.team`, report);
    let repoId = null;
    if (repo.repo_id !== undefined && repo.repo_id !== null) {
      if (!isNonEmptyString(repo.repo_id)) report.error(`${field}.repo_id`, 'must be a non-empty string or null');
      else repoId = repo.repo_id.trim();
    }
    const areaPaths = validateAreaPaths(repo, field, report);
    const parts = validateParts(repo, field, report);
    const testCommands = validateTestCommands(repo, field, report);

    if (project && projects) {
      if (!projectNames.has(project.toLowerCase())) {
        report.error(`${field}.project`, `"${project}" isn't in tracker.projects`);
      } else {
        project = projectNames.get(project.toLowerCase());
      }
    }
    if (name) {
      const key = `${project || ''}/${name}`.toLowerCase();
      if (seenNames.has(key)) {
        report.error(`${field}.repo`, `"${name}" is also ${seenNames.get(key)}. Repo names must be unique within a project`);
      } else {
        seenNames.set(key, field);
      }
    }

    if (!rawPath) return;
    const resolvedPath = path.resolve(paths.expandTilde(rawPath));
    const pathKey = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
    if (seenPaths.has(pathKey)) report.error(`${field}.path`, `"${rawPath}" is listed more than once`);
    seenPaths.add(pathKey);

    if (checkPaths) {
      let stats = null;
      try { stats = fs.statSync(resolvedPath); } catch { /* reported below */ }
      if (!stats) report.error(`${field}.path`, `repo path not found: ${rawPath}`);
      else if (!stats.isDirectory()) report.error(`${field}.path`, `is not a folder: ${rawPath}`);
    }

    validRepos.push({
      name,
      path: resolvedPath,
      main_branch: mainBranch,
      project,
      repo_id: repoId,
      team,
      area_paths: areaPaths,
      parts,
      test_commands: testCommands,
    });
  });
  return validRepos;
}

// The parts of the repo this person works on ("backend", "frontend"...), as
// free text. Missing means the whole repo, kept as null.
function validateParts(repo, field, report) {
  if (repo.parts === undefined) return null;
  const parts = stringList(repo, 'parts', `${field}.parts`, report);
  return parts && parts.length > 0 ? parts : null;
}

// The commands that test the repo after a merge, each run on its own.
// Missing or empty: the merge skips the tests and says so.
function validateTestCommands(repo, field, report) {
  const value = repo.test_commands;
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    report.error(`${field}.test_commands`, 'must be a list of commands');
    return [];
  }
  const commands = [];
  value.forEach((command, index) => {
    if (!isNonEmptyString(command)) report.error(`${field}.test_commands[${index}]`, 'must be a non-empty string');
    else commands.push(command.trim());
  });
  return commands;
}

function validateAreaPaths(repo, field, report) {
  const value = repo.area_paths;
  const areaField = `${field}.area_paths`;
  if (value === undefined) {
    report.error(areaField, 'missing. Run /spadework:init to pick the team (backlog) for this repo');
    return [];
  }
  if (!Array.isArray(value) || value.length === 0) {
    report.error(areaField, 'must be a non-empty list');
    return [];
  }
  const areas = [];
  value.forEach((area, index) => {
    const itemField = `${areaField}[${index}]`;
    if (!isObject(area)) {
      report.error(itemField, 'must be an object with "value" and "include_children"');
      return;
    }
    checkUnknownKeys(area, 'area', itemField, report);
    const areaValue = requireString(area, 'value', `${itemField}.value`, report);
    const includeChildren = optionalBool(area, 'include_children', `${itemField}.include_children`, true, report);
    if (areaValue) areas.push({ value: areaValue.replace(/\//g, '\\'), include_children: includeChildren });
  });
  return areas;
}

// The ID prefix of a project's rows: 2 to 10 capital letters or digits, starting with a letter.
const ID_PREFIX = /^[A-Z][A-Z0-9]{1,9}$/;
const DEFAULT_BOARD_PORT = 41730;

// projects: the tracker's project names, each of which needs a prefix.
function validateBoard(raw, report, projects) {
  const board = requireObject(raw, 'board', 'board', report);
  if (!board) return null;
  checkUnknownKeys(board, 'board', 'board', report);

  let language = 'en-US';
  if (board.language !== undefined) {
    if (board.language === 'same_as_card') {
      language = 'same_as_card';
    } else if (typeof board.language === 'string' && /^[a-z]{2,3}-[A-Z]{2}$/.test(board.language)) {
      language = board.language;
    } else {
      report.error('board.language', 'must be a locale with its region, like "en-US" or "pt-PT", or "same_as_card"');
    }
  }

  let port = DEFAULT_BOARD_PORT;
  if (board.port !== undefined) {
    if (Number.isInteger(board.port) && board.port >= 1024 && board.port <= 65535) port = board.port;
    else report.error('board.port', 'must be a whole number from 1024 to 65535');
  }

  const validProjects = {};
  const given = requireObject(board, 'projects', 'board.projects', report);
  if (given) {
    const used = new Map();
    for (const project of projects || []) {
      const key = Object.keys(given).find((name) => sameName(name, project));
      const field = `board.projects.${project}`;
      if (!key) {
        report.error(field, 'missing: every project needs an ID prefix for its rows, like { "prefix": "SHOP" }');
        continue;
      }
      if (!isObject(given[key])) {
        report.error(field, 'must be an object like { "prefix": "SHOP" }');
        continue;
      }
      checkUnknownKeys(given[key], 'board.project', field, report);
      const prefix = requireString(given[key], 'prefix', `${field}.prefix`, report);
      if (!prefix) continue;
      if (!ID_PREFIX.test(prefix)) report.error(`${field}.prefix`, 'must be 2 to 10 capital letters or digits, starting with a letter (e.g. SHOP)');
      else if (used.has(prefix)) report.error(`${field}.prefix`, `"${prefix}" is already used by ${used.get(prefix)}`);
      else {
        used.set(prefix, project);
        validProjects[project] = { prefix };
      }
    }
    for (const key of Object.keys(given)) {
      if (!(projects || []).some((project) => sameName(project, key))) report.warn(`board.projects.${key}`, 'not one of tracker.projects, it is ignored');
    }
  }

  return { language, projects: validProjects, port, items: validateStatuses(board, report) };
}

function validateStatuses(board, report) {
  const items = requireObject(board, 'items', 'board.items', report);
  if (!items) return null;
  checkUnknownKeys(items, 'board.items', 'board.items', report);

  const statuses = stringList(items, 'statuses', 'board.items.statuses', report);
  const validItems = { statuses };
  const roleByStatus = new Map();
  for (const role of STATUS_ROLES) {
    const field = `board.items.${role}`;
    const statusName = requireString(items, role, field, report);
    validItems[role] = statusName;
    if (!statusName || !statuses) continue;

    if (!statuses.includes(statusName)) {
      const sameExceptCase = statuses.find((status) => sameName(status, statusName));
      report.error(field, sameExceptCase
        ? `"${statusName}" doesn't match the status "${sameExceptCase}" (check the capital letters)`
        : `unknown status name "${statusName}". It must be one of: ${statuses.join(', ')}`);
      continue;
    }
    if (roleByStatus.has(statusName)) {
      report.error(field, `"${statusName}" is already used by ${roleByStatus.get(statusName)}. Each role needs its own status`);
    } else {
      roleByStatus.set(statusName, role);
    }
  }
  return validItems;
}

function validateOptionalSections(raw, report) {
  const readSection = (key) => {
    if (raw[key] === undefined) return {};
    if (!isObject(raw[key])) {
      report.error(key, 'must be an object');
      return {};
    }
    checkUnknownKeys(raw[key], key, key, report);
    return raw[key];
  };

  const graphifySection = readSection('graphify');
  const graphify = {
    enabled: optionalBool(graphifySection, 'enabled', 'graphify.enabled', false, report),
  };

  const triageSection = readSection('triage');
  const triage = {
    reanalyze_when_card_changes: optionalBool(triageSection, 'reanalyze_when_card_changes', 'triage.reanalyze_when_card_changes', true, report),
    max_cards_per_run: optionalInt(triageSection, 'max_cards_per_run', 'triage.max_cards_per_run', 10, 1, report),
    max_backlog_items: optionalInt(triageSection, 'max_backlog_items', 'triage.max_backlog_items', 1000, 1, report),
    web_research: optionalBool(triageSection, 'web_research', 'triage.web_research', false, report),
  };
  // Azure DevOps returns at most 20000 results for one query.
  if (triage.max_backlog_items > 20000) {
    report.error('triage.max_backlog_items', 'must be 20000 or less (the most Azure DevOps returns for one query)');
    triage.max_backlog_items = 20000;
  }
  if (triage.web_research) {
    report.warn('triage.web_research', 'is on: triage searches the web when it needs to while creating a plan, which costs more tokens');
  }

  const implementSection = readSection('implement');
  let branchPrefix = '';
  if (implementSection.branch_prefix !== undefined) {
    if (typeof implementSection.branch_prefix !== 'string' || !isValidBranchPrefix(implementSection.branch_prefix)) {
      report.error('implement.branch_prefix', 'must be text that is valid in a git branch name (no spaces, "..", "~", "^", ":", "?", "*", "[" or "\\")');
    } else {
      branchPrefix = implementSection.branch_prefix;
    }
  }
  let workspace = 'branch';
  if (implementSection.workspace !== undefined) {
    if (!WORKSPACES.includes(implementSection.workspace)) {
      report.error('implement.workspace', `must be one of: ${WORKSPACES.join(', ')}`);
    } else {
      workspace = implementSection.workspace;
    }
  }
  const implement = {
    branch_prefix: branchPrefix,
    max_review_rounds: optionalInt(implementSection, 'max_review_rounds', 'implement.max_review_rounds', 2, 0, report),
    workspace,
  };

  const mergeSection = readSection('merge');
  const merge = {
    integrate: optionalBool(mergeSection, 'integrate', 'merge.integrate', false, report),
  };

  return { graphify, triage, implement, merge };
}

const isBugType = (type) => sameName(type, BUG_TYPE);

// How a work item type is planned, from tracker.work_items: its depth (split,
// how or full), the type a split creates, and the agent that plans it. A
// missing list means every type at full, as before the list existed.
// Returns { ok, plan, creates, agent } or { ok: false, error }.
function kindOf(cfg, type) {
  const items = cfg.tracker.work_items;
  const entry = items ? items.find((item) => sameName(item.type, type)) : { plan: 'full', creates: null };
  if (!entry) return { ok: false, error: `${type} isn't in tracker.work_items, so triage doesn't plan it.` };
  const agent = isBugType(type) ? 'spadework:bug-triager' : 'spadework:feature-planner';
  return { ok: true, plan: entry.plan, creates: entry.creates, agent };
}

// Whether a split creates this type: one of the `creates` in work_items.
const isCreatedType = (cfg, type) => (cfg.tracker.work_items || []).some((item) => item.plan === 'split' && sameName(item.creates, type));

// Rules from `git check-ref-format`, for the part we put before the ID.
function isValidBranchPrefix(prefix) {
  if (prefix === '') return true;
  if (/[\s~^:?*[\\]|\.\.|@\{|\/\/|^\/|^-|\.lock\/?$/.test(prefix)) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\x00-\x1f\x7f]/.test(prefix);
}

// A whole branch name that is safe to give git fetch: a name starting with "-"
// would be read as an option, a leading "+" would force the fetch, and ":" would make it a refspec.
const isBranchName = (name) => typeof name === 'string' && name !== '' && !/^[-+]/.test(name) && !name.endsWith('/') && isValidBranchPrefix(name);

// --- public API ---------------------------------------------------------------

// Validates a parsed config object. checkPaths=false skips filesystem checks.
function validate(raw, { checkPaths = true } = {}) {
  const report = new Report();
  if (!isObject(raw)) {
    report.error('', 'config must be a JSON object');
    return { ok: false, errors: report.errors, warnings: report.warnings, config: null };
  }
  checkUnknownKeys(raw, '', '', report);

  if (raw.version === undefined) report.error('version', 'missing (use 2)');
  else if (raw.version !== 2) report.error('version', `unsupported version ${JSON.stringify(raw.version)} (this plugin reads version 2)`);

  const tracker = validateTracker(raw, report);
  const repos = validateRepos(raw, report, { checkPaths, projects: tracker && tracker.projects });
  if (tracker && tracker.projects && repos) {
    for (const project of tracker.projects) {
      if (!repos.some((repo) => repo.project === project)) {
        report.warn('tracker.projects', `"${project}" has no repos, so its work items are never triaged`);
      }
    }
  }
  const board = validateBoard(raw, report, tracker && tracker.projects);
  const optionalSections = validateOptionalSections(raw, report);

  const ok = report.errors.length === 0;
  const config = ok ? { version: 2, tracker, repos, board, ...optionalSections } : null;
  // What was read even when something is wrong: a wrong field is null, a
  // section that isn't an object is null. /spadework:validate checks the
  // rest with it, instead of hiding everything behind the first error.
  const parts = { tracker, repos, board, ...optionalSections };
  return { ok, errors: report.errors, warnings: report.warnings, config, parts };
}

// Reads and validates the config file. Never throws.
function load({ file = paths.all().config, checkPaths = true } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const message = err.code === 'ENOENT'
      ? `config not found at ${file}. Run /spadework:init first`
      : `can't read ${file}: ${err.message}`;
    return { ok: false, file, missing: err.code === 'ENOENT', errors: [{ field: '', message }], warnings: [], config: null };
  }
  let raw;
  try {
    raw = parseJson(text);
  } catch (err) {
    return { ok: false, file, errors: [{ field: '', message: `config.json is not valid JSON: ${err.message}` }], warnings: [], config: null };
  }
  return { file, ...validate(raw, { checkPaths }) };
}

// The config for a command that needs it: { config } or { error }, the same
// message everywhere, naming what to fix. Repo folders aren't checked: one
// missing clone skips only its own repo.
function loadForRun({ file } = {}) {
  const loaded = load({ file, checkPaths: false });
  if (loaded.ok) return { config: loaded.config };
  if (loaded.missing) return { error: loaded.errors[0].message };
  return { error: `config.json isn't valid (${loaded.errors.map(problemText).join('; ')}). Run /spadework:validate to see what to fix` };
}

// An error or warning as one line: "field: message", or the message alone
// for a problem with the whole file.
const problemText = (problem) => (problem.field ? `${problem.field}: ${problem.message}` : problem.message);

function format(result) {
  const lines = [];
  const fileSuffix = result.file ? ` (${result.file})` : '';
  if (result.ok) lines.push(`✅ config.json is valid${fileSuffix}`);
  else lines.push(`❌ config.json has ${result.errors.length} error(s)${fileSuffix}`);
  for (const error of result.errors) lines.push(`  ❌ ${problemText(error)}`);
  for (const warning of result.warnings) lines.push(`  ⚠️ ${problemText(warning)}`);
  return lines.join('\n');
}

// "Shop/api": a repo's name with its project.
const repoLabel = (repo) => `${repo.project}/${repo.name}`;

// What the chat prints for a repo: just its name when that is the project's name
// too ("Shop", not "Shop/Shop"). Only for printing: locks, claims, logs and
// stack.md sections are keyed by repoLabel.
const repoDisplay = (repo) => (sameName(repo.project, repo.name) ? repo.name : repoLabel(repo));

// The configured repo with this project and name, or undefined.
function findRepo(repos, project, name) {
  return (repos || []).find((repo) => sameName(repo.project, project) && sameName(repo.name, name));
}

// The configured repo a command names with --repo, and --project when two
// projects have a repo with that name. Returns { repo } or { error }.
function repoByName(repos, name, project) {
  if (project) {
    const repo = findRepo(repos, project, name);
    return repo ? { repo } : { error: `Unknown repo: ${name}` };
  }
  const found = (repos || []).filter((repo) => sameName(repo.name, name));
  if (!found.length) return { error: `Unknown repo: ${name}` };
  if (found.length > 1) return { error: `${name} is a repo in more than one project (${found.map((repo) => repo.project).join(', ')}). Add --project <name>.` };
  return { repo: found[0] };
}

// The configured project with this name, spelled as in config.json, or undefined.
const findProject = (projects, name) => (projects || []).find((project) => sameName(project, name));
const unknownProject = (projects, name) => `Unknown project: ${name}. Configured projects: ${projects.join(', ')}`;

// The configured repos of a project.
const reposOf = (repos, project) => (repos || []).filter((repo) => sameName(repo.project, project));

// Whether two { project, repo } name the same repo. False when either is missing.
const sameRepo = (first, second) => Boolean(first && second && first.repo && second.repo)
  && sameName(first.project, second.project) && sameName(first.repo, second.repo);

module.exports = {
  repoLabel, repoDisplay, sameName, kindOf, isCreatedType, isBugType, isBranchName, TRIAGE_TAG, HANDOFF_TAG, DESIGN_TAG, DESIGN_PUSHED_TAG, tagList, hasTag, ID_PREFIX, DEFAULT_BOARD_PORT, rowTag, isObject, isNonEmptyString, problemText, findRepo, repoByName, findProject, unknownProject, reposOf, sameRepo,
  load, loadForRun, validate, format, PROCESSES, PLANS, DEFAULT_STATES, STATUS_ROLES, DEFAULT_CONTENT_FIELDS,
};
