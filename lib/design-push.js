'use strict';

// /spadework:design-push: creates the Epic and Features of one reviewed
// placement file in Azure DevOps, in the backlog the user names, and
// nothing else. It follows handoff's steps:
// - check: reads the placement file, checks --project, --repo and --area,
//   builds each description and saves the push list in the run file. The
//   guard allows only what that list names (guards/design-push.js).
// - filter: finds what an earlier push of the same design already made,
//   by its tags and title, so only what is missing is created
// - recordCreated: the hook saves the numbers create and add_child return
// - created: what this run created or adopted, the items still to tag, and
//   the summary
// Every item gets two tags: spadework and spadework-design-pushed.

const ado = require('./ado');
const config = require('./config');
const log = require('./log');
const placementLib = require('./placement');
const runs = require('./runs');
const { NAME, placementFile } = require('./design');
const { readTextOrNull } = require('./json-file');

// The two tags of a pushed item. hasBothTags: the item has both; with exact,
// it has no other tag.
const TAGS = [config.DESIGN_TAG, config.DESIGN_PUSHED_TAG];
const TAG_TEXT = TAGS.join('; ');
const { hasTag } = config;
const hasBothTags = (value, { exact = false } = {}) => TAGS.every((tag) => hasTag(value, tag)) && (!exact || config.tagList(value).length === 2);

// This chat's push run: { run, push } or { error }.
function pushRun(sessionId, { checked = true } = {}) {
  const run = runs.get(sessionId, { includeStale: true });
  if (!run || run.mode !== 'design-push') return { error: 'There is no design-push run in this chat.' };
  if (checked && !run.design_push) return { error: 'Run design-push check first.' };
  return { run, push: run.design_push };
}
const savePush = (sessionId, push) => runs.setField(sessionId, 'design_push', push);

// A work item's description: the placement's text, then the ADRs it rests on.
function descriptionOf(text, placement) {
  const adrs = placement.adrs.map((item) => `- ${item.path}: ${item.sentence}`);
  return adrs.length ? `${text}\n\nArchitecture decisions (repo ${placement.repo}):\n${adrs.join('\n')}` : text;
}

// The Features under the Epic, as the guard checks add_child against them.
const parentOf = (push) => ({
  project: push.project,
  creates: 'Feature',
  items: Object.fromEntries(push.features.filter((feature) => !feature.done).map((feature) => [feature.title, { key: feature.key, area_path: push.area_path }])),
});

// design-push check <name> --project P --repo R --area A.
function check({ sessionId, name, project, repo: repoName, area }) {
  const found = pushRun(sessionId, { checked: false });
  if (found.error) return { ok: false, error: found.error };
  const { config: cfg, error } = config.loadForRun();
  if (error) return { ok: false, error };
  if (!NAME.test(String(name || ''))) return { ok: false, error: 'Give the design\'s name: /spadework:design-push <name> --project <project> --repo <repo> --area <area path>.' };
  const file = placementFile(name);
  const text = readTextOrNull(file);
  if (text === null) return { ok: false, error: `There is no placement file for ${name} (${file}). Run /spadework:design first.` };
  const parsed = placementLib.parse(text, { name, process: cfg.tracker.process });
  if (!parsed.ok) return { ok: false, error: `The placement file ${file} has lines the push can't follow. Nothing was created.`, errors: parsed.errors };
  const placement = parsed.placement;

  const projectName = config.findProject(cfg.tracker.projects, project);
  if (!projectName) return { ok: false, error: config.unknownProject(cfg.tracker.projects, project || '(none)') };
  if (!config.sameName(projectName, placement.project)) return { ok: false, error: `The placement file is for project ${placement.project}, not ${projectName}.` };
  const repo = config.findRepo(cfg.repos, projectName, repoName);
  if (!repo) return { ok: false, error: `${repoName || '(no repo)'} isn't a repo of project ${projectName} in config.json.` };
  if (!area || !ado.inBacklog(area, repo.area_paths)) {
    return { ok: false, error: `${area || '(no area)'} isn't one of the area paths of ${repo.name} (${repo.area_paths.map((each) => each.value).join(', ')}), or a path under one that includes its children.` };
  }
  if (placement.shape === 'adr-only') {
    return { ok: true, nothing: `The placement for ${name} is "ADR only": there is nothing to create.${placement.work_item ? ` To plan work item #${placement.work_item.id}: /spadework:triage ${placement.work_item.id}` : ''}` };
  }

  const areaPath = String(area).replace(/\//g, '\\');
  const existing = Boolean(placement.epic.id);
  const push = {
    name, project: projectName, repo: repo.name, area_path: areaPath, tags: TAG_TEXT,
    epic: existing ? { id: placement.epic.id, title: placement.epic.title, existing: true } : { id: null, title: placement.epic.title, description: descriptionOf(placement.epic.description, placement) },
    features: placement.features.map((feature, index) => ({ key: `feature-${index + 1}`, title: feature.title, description: descriptionOf(feature.description, placement) })),
    parents: {},
    created: [],
  };
  savePush(sessionId, push);
  return {
    ok: true,
    shape: placement.shape,
    project: projectName,
    area_path: areaPath,
    epic: { id: push.epic.id, title: push.epic.title, ...(existing ? {} : { description: push.epic.description }) },
    features: push.features.map((feature) => ({ title: feature.title, description: feature.description, areaPath })),
    epic_query: existing ? null : [
      'SELECT [System.Id] FROM WorkItems',
      `WHERE [System.TeamProject] = ${ado.quote(projectName)}`,
      '  AND [System.WorkItemType] = \'Epic\'',
      `  AND [System.Title] = ${ado.quote(push.epic.title)}`,
    ].join('\n'),
    next: existing
      ? `Read Epic #${push.epic.id} with its relations and its children, then design-push filter with {"parent_id": ${push.epic.id}, "type": "<its System.WorkItemType>", "children": [...]}.`
      : 'Read the Epics with this title (epic_query), then design-push filter with {"epics": [...]}.',
  };
}

// The create call for the new Epic, exactly as the guard allows it.
const createCall = (push) => ({
  action: 'create',
  project: push.project,
  workItemType: 'Epic',
  fields: [
    { name: 'System.Title', value: push.epic.title },
    { name: 'System.Description', value: push.epic.description, format: 'Markdown' },
    { name: 'System.AreaPath', value: push.area_path },
    { name: 'System.Tags', value: push.tags },
  ],
});

// design-push filter. input: { epics: [{ id, title, tags }] } (the Epics with
// the new Epic's title), or { parent_id, type, children: [{ id, title, tags }] }
// (the Epic's type and children). An existing Epic that the placement file
// names must be an Epic: a hand edit could name a Requirement or a Bug.
function filter(input, sessionId) {
  const found = pushRun(sessionId);
  if (found.error) return { ok: false, error: found.error };
  const push = found.push;
  if (input && Array.isArray(input.epics)) {
    if (push.epic.id) return { ok: false, error: `The Epic is already known: #${push.epic.id}.` };
    const same = input.epics.filter((epic) => epic && config.sameName(epic.title, push.epic.title));
    const own = same.find((epic) => hasTag(epic.tags, config.DESIGN_PUSHED_TAG));
    if (own) {
      push.epic = { ...push.epic, id: Number(own.id), adopted: true, tags: own.tags || '' };
      if (push.features.length) push.parents[push.epic.id] = parentOf(push);
      savePush(sessionId, push);
      return { ok: true, epic: 'adopted', id: push.epic.id, next: `Epic #${push.epic.id} is from an earlier push. Read its children, then design-push filter with {"parent_id": ${push.epic.id}, "children": [...]}.` };
    }
    if (same.length) {
      return { ok: false, stop: true, error: `Epic #${same[0].id} "${push.epic.title}" already exists without the tag ${config.DESIGN_PUSHED_TAG}. If an earlier push made it, add that tag in Azure DevOps and run again. If not, rename the Epic in the placement file.` };
    }
    return { ok: true, epic: 'create', create: createCall(push), next: 'Create the Epic: one wit_work_item_write call with exactly these values.' };
  }

  const parentId = Number(input && input.parent_id);
  if (!push.epic.id || parentId !== push.epic.id) return { ok: false, error: `#${input && input.parent_id} isn't this push's Epic${push.epic.id ? ` (#${push.epic.id})` : ''}.` };
  if (push.epic.existing && !push.epic.checked) {
    const type = String((input && input.type) || '').trim();
    if (!type) return { ok: false, stop: true, error: `The type of work item #${parentId} wasn't given, so the push can't tell that it is an Epic. Nothing was created.` };
    if (!config.sameName(type, 'Epic')) return { ok: false, stop: true, error: `Work item #${parentId} is a ${type}, not an Epic. Correct the Epic's number in the placement file, then run the push again. Nothing was created.` };
    push.epic.checked = true;
  }
  const children = Array.isArray(input.children) ? input.children : [];
  const create = [];
  const adopted = [];
  const skipped = [];
  for (const feature of push.features.filter((each) => !each.done)) {
    const same = children.filter((child) => child && config.sameName(child.title, feature.title));
    const own = same.find((child) => hasBothTags(child.tags));
    if (own) {
      if (!push.created.some((item) => item.id === Number(own.id))) push.created.push({ id: Number(own.id), title: feature.title, parent: parentId, key: feature.key, adopted: true, tags: own.tags || '' });
      adopted.push({ title: feature.title, id: Number(own.id) });
      feature.done = true;
    } else if (same.length) {
      skipped.push({ title: feature.title, reason: `#${same[0].id} under #${parentId} has the title "${feature.title}" but not the tags "${push.tags}", so it isn't known to be Spadework's. Left alone.` });
      feature.done = true;
    } else {
      create.push({ title: feature.title, description: feature.description, areaPath: push.area_path });
    }
  }
  if (push.features.length) push.parents[parentId] = parentOf(push);
  savePush(sessionId, push);
  return { ok: true, parent_id: parentId, project: push.project, create, adopted, skipped };
}

// Saves the numbers that create (the new Epic) and add_child (its Features)
// returned, read from the tool's own answer. Only what the push list names.
function recordCreated(sessionId, toolInput, response) {
  const found = pushRun(sessionId);
  if (found.error) return 0;
  const push = found.push;
  const action = String((toolInput && toolInput.action) || '');
  let saved = 0;
  for (const item of ado.createdItems(response)) {
    const id = Number(item.id);
    const fields = item.fields || {};
    const title = String(fields['System.Title'] || '');
    if (!Number.isInteger(id)) continue;
    if (action === 'create') {
      if (push.epic.id || !config.sameName(title, push.epic.title)) continue;
      push.epic = { ...push.epic, id, created: true, tags: String(fields['System.Tags'] || '') };
      if (push.features.length) push.parents[id] = parentOf(push);
      saved++;
    } else if (action === 'add_child') {
      const parent = Number(fields['System.Parent']);
      const planned = parent === push.epic.id ? push.features.find((feature) => !feature.done && config.sameName(feature.title, title)) : null;
      if (!planned || push.created.some((other) => other.id === id)) continue;
      push.created.push({ id, title: planned.title, parent, key: planned.key, tags: String(fields['System.Tags'] || '') });
      planned.done = true;
      saved++;
    }
  }
  if (saved) {
    if (push.epic.id && push.features.length) push.parents[push.epic.id] = parentOf(push);
    savePush(sessionId, push);
  }
  return saved;
}

// What the push made: the items created or adopted (each logged once), the
// new items with no tags yet, what is still missing, and the summary.
function created(sessionId) {
  const found = pushRun(sessionId);
  if (found.error) return { ok: false, error: found.error };
  const { config: cfg, error } = config.loadForRun();
  if (error) return { ok: false, error };
  const push = found.push;
  const url = (id) => ado.workItemUrl(cfg.tracker.organization, push.project, id);
  const items = [
    ...(push.epic.id && !push.epic.existing ? [{ ...push.epic, type: 'Epic' }] : []),
    ...push.created.map((item) => ({ ...item, type: 'Feature' })),
  ];
  for (const item of items.filter((each) => !each.logged)) {
    log.append({ command: 'design-push', session_id: sessionId, work_item_id: item.id, repo: config.repoLabel({ project: push.project, name: push.repo }), result: item.adopted ? 'adopted' : 'created' });
  }
  if (push.epic.id && !push.epic.existing) push.epic.logged = true;
  for (const item of push.created) item.logged = true;
  savePush(sessionId, push);

  const toTag = items.filter((item) => !item.adopted && !hasBothTags(item.tags)).map((item) => item.id);
  const missing = [
    ...(!push.epic.id ? [{ type: 'Epic', title: push.epic.title }] : []),
    ...push.features.filter((feature) => !feature.done).map((feature) => ({ type: 'Feature', title: feature.title })),
  ];
  const lines = [];
  if (push.epic.existing) lines.push(`Epic #${push.epic.id} ${push.epic.title}: ${url(push.epic.id)} (it already existed)`);
  for (const item of items) lines.push(`${item.type} #${item.id} ${item.title}: ${url(item.id)}${item.adopted ? ' (from an earlier push)' : ''}`);
  for (const item of missing) lines.push(`${item.type} "${item.title}": not created. Run the push again to create what is missing.`);
  // The items triage splits next: the Features, or the Epic in Basic.
  const nextType = push.features.length ? 'Feature' : 'Epic';
  const nextIds = nextType === 'Feature' ? push.created.map((item) => item.id) : (push.epic.id ? [push.epic.id] : []);
  const kind = config.kindOf(cfg, nextType);
  if (nextIds.length && !kind.ok) lines.push(kind.error);
  else if (nextIds.length) {
    for (const id of nextIds) lines.push(`Run /spadework:triage ${id} to ${kind.plan === 'split' ? 'split' : 'plan'} it.`);
    lines.push(`Triage plans only items assigned to you, in the configured states. If Azure DevOps didn't assign the new items to you, assign the ${nextType} first.`);
    if (kind.plan !== 'split') lines.push(`Triage plans ${nextType} at depth ${kind.plan}, not split.`);
  }
  return { ok: true, epic: push.epic.id ? { id: push.epic.id, title: push.epic.title } : null, created: items.map(({ id, title, type, adopted }) => ({ id, title, type, adopted: Boolean(adopted) })), to_tag: toTag, tags: push.tags, missing, lines };
}

module.exports = { check, filter, recordCreated, created, descriptionOf, TAGS, hasBothTags };
