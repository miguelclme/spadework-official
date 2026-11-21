'use strict';

// Azure DevOps helpers that don't need the MCP: reading a clone's remote URL,
// building the WIQL query triage and validate run, finding which repos'
// backlogs hold a work item, and the queries that check one item against them.

const { reposOf } = require('./config');
const { workItemId } = require('./numbers');
const { parseJsonOrNull } = require('./json-file');

// Returns { organization, project, repo } for an Azure DevOps remote URL,
// or null if it isn't one. Handles:
//   https://dev.azure.com/org/project/_git/repo  (optionally user@ before the host)
//   https://org.visualstudio.com/project/_git/repo  (optionally DefaultCollection/)
//   git@ssh.dev.azure.com:v3/org/project/repo
//   org@vs-ssh.visualstudio.com:v3/org/project/repo
// When the repo has the project's name, the project can be left out:
//   https://dev.azure.com/org/_git/repo
function parseRemote(url) {
  if (typeof url !== 'string') return null;
  const text = url.trim();

  const ssh = text.match(/^(?:ssh:\/\/)?[^@\s]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)(?::22)?[:/]v3\/([^/]+)\/([^/]+)\/([^/]+?)\/?$/i);
  if (ssh) return result(ssh[1], ssh[2], ssh[3]);

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  const host = parsed.hostname.toLowerCase();

  let organization;
  if (host === 'dev.azure.com') {
    organization = parts.shift();
  } else if (host.endsWith('.visualstudio.com')) {
    organization = host.slice(0, -'.visualstudio.com'.length);
    if (parts[0] && parts[0].toLowerCase() === 'defaultcollection') parts.shift();
  } else {
    return null;
  }

  const gitIndex = parts.indexOf('_git');
  if (!organization || gitIndex === -1 || gitIndex > 1 || parts.length !== gitIndex + 2) return null;
  const repo = parts[gitIndex + 1];
  const project = gitIndex === 1 ? parts[0] : repo;
  return result(organization, project, repo);
}

function result(organization, project, repo) {
  const decode = (value) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  return {
    organization: decode(organization),
    project: decode(project),
    repo: decode(repo).replace(/\.git$/i, ''),
  };
}

// WIQL string literal: single quotes are doubled.
const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

// The area condition for a repo's backlog: its team's area paths, each one
// alone or with its children.
function areaCondition(areaPaths) {
  const parts = areaPaths.map((area) => `[System.AreaPath] ${area.include_children ? 'UNDER' : '='} ${quote(area.value)}`);
  return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
}

// One repo's backlog: the user's work items in the configured states, in
// the repo's project, under its team's area paths, and of the types in
// tracker.work_items (every type when the list is missing). WIQL returns only IDs.
// since: a YYYY-MM-DD date, to keep only items created on or after it.
// id: a work item ID, to ask whether that one item is in the backlog.
function buildWiql(tracker, repo, { since = null, id = null } = {}) {
  return [
    'SELECT [System.Id] FROM WorkItems',
    `WHERE [System.TeamProject] = ${quote(repo.project)}`,
    ...(id ? [`  AND [System.Id] = ${Number(id)}`] : []),
    `  AND ${areaCondition(repo.area_paths)}`,
    `  AND [System.AssignedTo] = ${quote(tracker.user_email)}`,
    ...(tracker.work_items ? [`  AND [System.WorkItemType] IN (${tracker.work_items.map((item) => quote(item.type)).join(', ')})`] : []),
    `  AND [System.State] IN (${tracker.states.map(quote).join(', ')})`,
    ...(since ? [`  AND [System.CreatedDate] >= ${quote(since)}`] : []),
    'ORDER BY [Microsoft.VSTS.Common.Priority] ASC, [System.ChangedDate] DESC',
  ].join('\n');
}

// A YYYY-MM-DD date that exists (2026-02-30 doesn't), or null.
function parseDate(text) {
  const match = String(text || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return match[0];
}

// Whether a work item's area path is in a repo's backlog.
function inBacklog(itemArea, areaPaths) {
  const item = String(itemArea || '').replace(/\//g, '\\').toLowerCase();
  return areaPaths.some((area) => {
    const value = area.value.toLowerCase();
    return item === value || (area.include_children && item.startsWith(`${value}\\`));
  });
}

// The area path a new work item gets: the given one (its parent's) when it
// is in the repo's backlog, else the repo's first area path.
const areaPathFor = (itemArea, areaPaths) => (inBacklog(itemArea, areaPaths) ? itemArea : areaPaths[0].value);

// The queries that tell whether one work item is in the user's backlog: each
// of the project's repos' backlog query (buildWiql) with the item's ID added.
// The item is in scope when any of them returns it. A project with no
// configured repos has none, so nothing is in scope.
function scopeQueries(cfg, project, id) {
  return reposOf(cfg.repos, project).map((repo) => ({ repo: repo.name, wiql: buildWiql(cfg.tracker, repo, { id }) }));
}

// The one line printed for an item the queries didn't return, from the
// item's own values (no guessing which rule failed).
// item: { id, type, state, assigned_to, area_path }; assigned_to is what
// Azure DevOps gives: an object ({ uniqueName }), text, or nothing.
function notInBacklog(item) {
  const who = item.assigned_to && typeof item.assigned_to === 'object'
    ? item.assigned_to.uniqueName || item.assigned_to.displayName
    : item.assigned_to;
  return `#${item.id} isn't in your backlog. It is ${item.type || 'of no type'}, state ${item.state || 'unknown'}, assigned to ${who || 'nobody'}, area ${item.area_path || 'none'}.`;
}

// The configured repos whose backlog holds a work item: the same project,
// and the item's area path under one of the repo's area paths.
function backlogsOf(repos, item) {
  return reposOf(repos, item.project)
    .filter((repo) => inBacklog(item.area_path, repo.area_paths))
    .map((repo) => repo.name);
}

// A work item's link in Azure DevOps.
const workItemUrl = (organization, project, id) =>
  `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/_workitems/edit/${Number(id)}`;

// The relation Azure DevOps keeps on a work item for each end of a Predecessor
// link: "predecessor" on the item that depends on the other one, "successor"
// on the item the other one depends on.
const LINK_RELATIONS = { predecessor: 'System.LinkTypes.Dependency-Reverse', successor: 'System.LinkTypes.Dependency-Forward' };

// The work item number a relation points to (the end of its url), or null.
function relationTarget(relation) {
  const match = String((relation && relation.url) || '').match(/workItems\/(\d+)\/?$/i);
  return match ? workItemId(match[1]) : null;
}

// The Azure DevOps MCP server wraps each answer's text between markers:
// <<id>> [UNTRUSTED ... CONTENT ...] <<id>>, the JSON, then <</id>>.
const UNTRUSTED_WRAP = /^\s*<<([0-9a-f]+)>>[^\n]*<<\1>>\s*\n([\s\S]*)\n\s*<<\/\1>>\s*$/;
const unwrap = (text) => {
  const match = UNTRUSTED_WRAP.exec(text);
  return match ? match[2] : text;
};

// The work items in what a wit_work_item_write call returned (create or
// add_child): every object with an id and fields, wherever the answer holds
// it. The tool answers with JSON text, or with a batch whose items each
// hold their JSON text in "body".
function createdItems(response) {
  const found = [];
  const visit = (value, depth) => {
    if (depth > 12 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      const parsed = parseJsonOrNull(unwrap(value));
      if (parsed && typeof parsed === 'object') visit(parsed, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const inner of value) visit(inner, depth + 1); return; }
    if (value.fields && value.id) { found.push(value); return; }
    for (const [key, inner] of Object.entries(value)) if (key === 'body' || key === 'value' || key === 'text' || key === 'content') visit(inner, depth + 1);
  };
  visit(response, 0);
  return found;
}

module.exports = {
  workItemUrl, parseRemote, buildWiql, parseDate, inBacklog, areaPathFor, backlogsOf, scopeQueries, notInBacklog, relationTarget, LINK_RELATIONS, quote, areaCondition, createdItems,
};
