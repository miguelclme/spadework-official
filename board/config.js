'use strict';

// Init's config panel. /spadework:init fetches what Azure DevOps has (repos,
// teams) and opens this page; the user fills in the rest and saves. It talks
// to the helper (lib/board-server.js), which checks and writes config.json
// and stack.md. Like the board's page it draws everything with createElement
// and textContent: nothing read from Azure DevOps or a file is ever parsed
// as markup. page.js (loaded first) sets the theme and gives the shared helpers.
(function () {
  const { h, clear, readKey, themeButton } = window.SpadeworkPage;
  const $ = (id) => document.getElementById(id);
  const toast = (text, bad) => window.SpadeworkPage.toast($('toast'), text, bad);
  const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  const isBug = (type) => same(type, 'Bug');

  // What each status role means, as the old setup questions said it.
  const ROLES = [
    ['default_status', 'New plans', 'set by triage'],
    ['needs_info_status', 'Questions to answer', 'set by triage'],
    ['retriage_status', 'Plan again', 'set by you, after writing feedback or answering questions'],
    ['approved_status', 'Approved', 'set by you'],
    ['rejected_status', 'Rejected', 'set by you'],
    ['in_progress_status', 'Being built', 'set by implement'],
    ['blocked_status', 'Blocked', 'set by implement'],
    ['implemented_status', 'Built', 'set by implement'],
    ['merged_status', 'Merged', 'set by merge'],
    ['resume_status', 'Resume', 'set by you, so implement goes on from a blocked row\'s branch'],
    ['done_status', 'Finished', 'set by you'],
  ];
  const LANGUAGES = ['en-US', 'en-GB', 'pt-PT', 'pt-BR', 'es-ES', 'fr-FR', 'de-DE', 'same_as_card'];
  const PLANS = [
    ['full', 'full: Spadework decides what to build and how (best for a developer working alone)'],
    ['how', 'how: the work item already says what to build; Spadework adds the code side (files, steps, commits, tests)'],
    ['split', 'split: Spadework breaks it into smaller work items, written as rows on the board for a tech lead to edit and approve. /spadework:handoff then creates the approved ones in Azure DevOps, as children of the split work item.'],
  ];
  // The 12 points of a repo's stack notes. Detect fills in what the repo's files say.
  const STACK_POINTS = [
    'Languages and versions', 'Frameworks and main libraries', 'Project type (web API, web app, library, mobile...)',
    'Architecture and folders (where business logic lives, where ADRs are)', 'Data (databases, ORM, migrations tool)',
    'Commands: build, test, lint, format', 'Testing: frameworks, test types, where tests live, coverage rule',
    'Dependencies: package manager and the vulnerability scan command', 'Code style: formatter, linter, naming',
    'Git conventions: commit message format', 'Security notes: auth, secrets, sensitive data',
    'Off-limits: what agents must never do',
  ];

  let key = null;
  let data = null; // what GET /api/init gave
  let cfg = null; // the config being edited
  let common = ''; // the stack notes' Common section
  const extras = new Map(); // repo → { notes, detect, graph, busy, ui, open }: what the page keeps beside each repo
  const closedProjects = new Set(); // projects folded in Repos and backlogs
  let teamsByProject = new Map(); // project (lower case) → Map(team lower case → { name, area_paths })
  const fields = new Map(); // a config field (or "stack:<section>") → the element that shows its errors
  let problems = { config: [], stack: [] };
  let saving = false;
  let detects = 0; // Detects running: Save waits for them
  let uid = 0;

  // --- talking to the helper ---------------------------------------------------------

  function showMessage(title, lines) {
    $('main').hidden = true;
    $('bar').hidden = true;
    const box = clear($('message'));
    box.hidden = false;
    box.appendChild(h('h1', '', title));
    for (const line of lines) box.appendChild(h('p', '', line));
  }

  async function api(method, path, body) {
    const headers = { 'X-Spadework-Key': key || '' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(path, { method, headers, cache: 'no-store', body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new Error("Can't reach Spadework's helper. Run /spadework:init again in Claude Code.");
    }
    let answer = null;
    try { answer = await res.json(); } catch { /* not JSON */ }
    if (res.status === 403) {
      showMessage('This page needs its link', ['The settings page opens with a key in its link. Run /spadework:init again in Claude Code and use the page it opens.']);
      throw new Error('The page needs its link');
    }
    return { status: res.status, answer: answer || { ok: false, error: `The request failed (${res.status})` } };
  }

  // --- building the form -------------------------------------------------------------

  const nextId = () => `cf-${++uid}`;

  // A labelled field: errors for `name` (a config field like "repos[0].path") show under it.
  function field(name, label, control, help) {
    const box = h('div', 'cf-field');
    const target = control.matches('input, select, textarea') ? control : control.querySelector('input');
    const id = target.id || nextId();
    target.id = id;
    const tag = h('label', 'cf-label', label);
    tag.htmlFor = id;
    box.append(tag, control);
    if (help) box.appendChild(h('p', 'cf-note', help));
    if (name) fields.set(name, box);
    return box;
  }

  function input(value, onInput, { placeholder = '', options = null, type = 'text' } = {}) {
    const node = h('input', 'cf-input');
    node.type = type;
    node.value = value === undefined || value === null ? '' : String(value);
    node.placeholder = placeholder;
    node.spellcheck = false;
    node.addEventListener('input', () => onInput(node.value));
    return options && options.length ? combo(node, options, onInput) : node;
  }

  // A text field with a list to pick from that still takes a typed value. The
  // list is drawn here: a <datalist>'s popup is drawn by the browser, in its own style.
  function combo(node, options, onInput) {
    const box = h('div', 'cf-combo');
    const list = h('ul', 'cf-menu');
    list.id = nextId();
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    node.autocomplete = 'off';
    node.setAttribute('role', 'combobox');
    node.setAttribute('aria-autocomplete', 'list');
    node.setAttribute('aria-expanded', 'false');
    node.setAttribute('aria-controls', list.id);
    let shown = [];
    let active = -1;
    const paint = () => {
      [...list.children].forEach((item, index) => { item.classList.toggle('on', index === active); item.setAttribute('aria-selected', String(index === active)); });
      if (active >= 0) { list.children[active].scrollIntoView({ block: 'nearest' }); node.setAttribute('aria-activedescendant', list.children[active].id); }
      else node.removeAttribute('aria-activedescendant');
    };
    const close = () => { list.hidden = true; active = -1; node.setAttribute('aria-expanded', 'false'); node.removeAttribute('aria-activedescendant'); };
    const pick = (option) => { node.value = option; close(); onInput(option); };
    // all: the whole list (on focus); otherwise the options holding what is typed.
    const open = (all) => {
      const text = node.value.trim().toLowerCase();
      shown = all || !text ? options : options.filter((option) => option.toLowerCase().includes(text));
      clear(list);
      shown.forEach((option, index) => {
        const item = h('li', 'cf-option', option);
        item.id = `${list.id}-${index}`;
        item.setAttribute('role', 'option');
        // mousedown, not click: the field keeps its focus, so its blur doesn't close the list first.
        item.addEventListener('mousedown', (event) => { event.preventDefault(); pick(option); });
        list.appendChild(item);
      });
      active = -1;
      list.hidden = !shown.length;
      node.setAttribute('aria-expanded', String(!list.hidden));
    };
    node.addEventListener('focus', () => open(true));
    node.addEventListener('click', () => { if (list.hidden) open(true); });
    node.addEventListener('input', () => open(false));
    node.addEventListener('blur', close);
    node.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (list.hidden) open(true);
        if (!shown.length) return;
        active = event.key === 'ArrowDown' ? (active + 1) % shown.length : (active <= 0 ? shown.length - 1 : active - 1);
        paint();
      } else if (event.key === 'Enter' && !list.hidden && active >= 0) {
        event.preventDefault();
        pick(shown[active]);
      } else if (event.key === 'Escape' && !list.hidden) {
        event.preventDefault();
        close();
      }
    });
    box.append(node, list);
    return box;
  }

  // A list typed as text, separated by commas.
  const listInput = (list, onInput, placeholder) => input((list || []).join(', '), (text) => onInput(text.split(',').map((item) => item.trim()).filter(Boolean)), { placeholder });
  // A list with one entry per line, for values that may hold commas (commands).
  function linesInput(list, onInput, placeholder) {
    const node = h('textarea', 'cf-input cf-lines');
    node.value = (list || []).join('\n');
    node.placeholder = placeholder;
    node.spellcheck = false;
    node.addEventListener('input', () => onInput(node.value.split('\n').map((line) => line.trim()).filter(Boolean)));
    return node;
  }

  function select(value, choices, onChange) {
    const node = h('select', 'cf-input');
    for (const [choice, text] of choices) {
      const option = h('option', '', text);
      option.value = choice;
      node.appendChild(option);
    }
    node.value = value;
    node.addEventListener('change', () => onChange(node.value));
    return node;
  }

  function check(label, value, onChange) {
    const box = h('label', 'cf-check');
    const node = h('input');
    node.type = 'checkbox';
    node.checked = Boolean(value);
    node.addEventListener('change', () => onChange(node.checked));
    box.append(node, h('span', '', label));
    return box;
  }

  function button(text, onClick, cls = 'btn') {
    const node = h('button', cls, text);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  function section(title, intro) {
    const box = h('section', 'card cf-sec');
    box.appendChild(h('h2', '', title));
    for (const line of [].concat(intro || [])) box.appendChild(h('p', 'cf-help', line));
    $('form').appendChild(box);
    return box;
  }

  // A number field: a whole number is kept as a number, anything else as typed (the check names it).
  const numberValue = (text) => (text.trim() === '' ? undefined : (Number.isInteger(Number(text)) ? Number(text) : text));
  const setOrDrop = (target, name, value) => { if (value === undefined) delete target[name]; else target[name] = value; };

  // --- the values --------------------------------------------------------------------

  const projects = () => cfg.tracker.projects;
  const repoLabel = (repo) => `${repo.project}/${repo.repo}`;
  const extra = (repo) => {
    if (!extras.has(repo)) extras.set(repo, { notes: '', detect: null, graph: null, busy: {}, ui: {} });
    return extras.get(repo);
  };
  const teamsOf = (project) => teamsByProject.get(String(project).toLowerCase()) || new Map();
  const optionsOf = (project) => ((data.options && data.options.projects) || []).find((entry) => same(entry.name, project)) || null;
  const areaText = (areas) => (areas || []).map((area) => `${area.value}${area.include_children === false ? ' (not its sub-areas)' : ' and its sub-areas'}`).join('; ');

  // The config to edit: what the panel starts from, with the projects the
  // skill fetched, an ID prefix for each and the sections filled with defaults.
  function prepare() {
    const { defaults } = data;
    cfg = structuredClone(data.start.config);
    cfg.version = 2;
    const blank = { provider: 'azure_devops', organization: '', projects: [], user_email: '', process: '', states: [] };
    cfg.tracker = { ...blank, ...structuredClone(defaults.tracker), ...(cfg.tracker && typeof cfg.tracker === 'object' ? cfg.tracker : {}) };
    for (const name of ['organization', 'user_email']) if (typeof cfg.tracker[name] !== 'string') cfg.tracker[name] = '';
    if (data.options && data.options.organization && !cfg.tracker.organization) cfg.tracker.organization = data.options.organization;
    if (!data.processes.includes(cfg.tracker.process)) cfg.tracker.process = '';
    if (!Array.isArray(cfg.tracker.states)) cfg.tracker.states = [];
    if (cfg.tracker.work_items !== undefined && !Array.isArray(cfg.tracker.work_items)) delete cfg.tracker.work_items;
    cfg.tracker.on_triage = { set_state_enabled: false, set_state: null, only_from: [], ...(cfg.tracker.on_triage || {}) };
    cfg.tracker.projects = [...data.projects];

    const dropped = [];
    cfg.repos = (Array.isArray(cfg.repos) ? cfg.repos : []).filter((repo) => {
      if (!repo || typeof repo !== 'object') return false;
      const project = projects().find((name) => same(name, repo.project));
      if (project) repo.project = project;
      else dropped.push(repoLabel(repo));
      return Boolean(project);
    });

    const board = cfg.board && typeof cfg.board === 'object' ? cfg.board : {};
    const items = { ...defaults.board.items, ...(board.items || {}) };
    const prefixes = {};
    for (const project of projects()) {
      const known = Object.keys(board.projects || {}).find((name) => same(name, project));
      prefixes[project] = { prefix: known && board.projects[known] && board.projects[known].prefix ? board.projects[known].prefix : (data.suggested_prefixes[project] || '') };
    }
    cfg.board = { ...board, language: board.language || 'en-US', items, projects: prefixes };
    for (const name of ['graphify', 'triage', 'implement', 'merge']) cfg[name] = { ...defaults[name], ...(cfg[name] && typeof cfg[name] === 'object' ? cfg[name] : {}) };

    // Teams: the ones the skill fetched, and the ones the config already uses.
    teamsByProject = new Map();
    const addTeam = (project, name, areas) => {
      if (!name) return;
      const lower = String(project).toLowerCase();
      if (!teamsByProject.has(lower)) teamsByProject.set(lower, new Map());
      const teams = teamsByProject.get(lower);
      if (!teams.has(name.toLowerCase()) || (areas && areas.length && !teams.get(name.toLowerCase()).area_paths.length)) {
        teams.set(name.toLowerCase(), { name, area_paths: structuredClone(areas || []) });
      }
    };
    for (const project of (data.options && data.options.projects) || []) for (const team of project.teams) addTeam(project.name, team.name, team.area_paths);
    for (const repo of cfg.repos) addTeam(repo.project, repo.team, repo.area_paths);

    // The stack notes: Common and one section per repo, by its Azure DevOps name.
    const sections = data.stack_sections || {};
    const sectionOf = (name) => { const found = Object.keys(sections).find((section) => same(section, name)); return found === undefined ? '' : sections[found]; };
    common = sectionOf('Common');
    for (const repo of cfg.repos) {
      const kept = extra(repo);
      kept.notes = sectionOf(repoLabel(repo));
      kept.graph = data.graphs[repo.path] || null;
    }
    return dropped;
  }

  // The config as it is sent: lists cleaned up, optional fields left out when empty.
  function built() {
    const out = structuredClone(cfg);
    out.repos = cfg.repos.map((repo) => {
      const copy = structuredClone(repo);
      copy.path = String(copy.path || '').replace(/\\/g, '/');
      if (!copy.repo_id) copy.repo_id = null;
      if (!Array.isArray(copy.parts) || !copy.parts.length) delete copy.parts;
      if (!Array.isArray(copy.test_commands) || !copy.test_commands.length) delete copy.test_commands;
      return copy;
    });
    if (Array.isArray(out.tracker.work_items)) {
      out.tracker.work_items = out.tracker.work_items.filter((item) => item.type || item.creates).map((item) => (item.plan === 'split' ? { type: item.type, plan: item.plan, creates: item.creates || '' } : { type: item.type, plan: item.plan }));
      if (!out.tracker.work_items.length) delete out.tracker.work_items;
    }
    if (!out.tracker.on_triage.set_state) out.tracker.on_triage.set_state = null;
    if (!out.tracker.process) delete out.tracker.process;
    return out;
  }

  function stackText() {
    const part = (name, text) => (text.trim() ? `## ${name}\n${text.trim()}` : `## ${name}`);
    return `${[part('Common', common), ...cfg.repos.map((repo) => part(repoLabel(repo), extra(repo).notes))].join('\n\n')}\n`;
  }

  // --- the sections ------------------------------------------------------------------

  function drawAzure() {
    const box = section('Azure DevOps', 'The organization and the projects Spadework reads work items from. Spadework only reads from Azure DevOps, unless you turn on a state move or split below.');
    const organization = input(cfg.tracker.organization, (value) => { cfg.tracker.organization = value.trim(); }, { placeholder: 'contoso' });
    box.appendChild(field('tracker.organization', 'Organization', organization,
      'The part after dev.azure.com/ (or before .visualstudio.com). A pasted URL works: the name is taken from it.'));
    organization.addEventListener('change', () => {
      const match = organization.value.match(/dev\.azure\.com\/([^/\s]+)/i) || organization.value.match(/^https?:\/\/([^./\s]+)\.visualstudio\.com/i);
      if (match) { organization.value = match[1]; cfg.tracker.organization = match[1]; }
    });
    box.appendChild(field('tracker.user_email', 'Your email', input(cfg.tracker.user_email, (value) => { cfg.tracker.user_email = value.trim(); }, { placeholder: 'you@contoso.com', type: 'email' }),
      'The one Azure DevOps work items are assigned to.'));
    const list = h('div', 'chips');
    for (const project of projects()) list.appendChild(h('span', 'chip still', project));
    if (!projects().length) list.appendChild(h('span', 'cf-note', 'No projects yet.'));
    const wrap = h('div', 'cf-field');
    wrap.append(h('span', 'cf-label', 'Projects'), list, h('p', 'cf-note', 'To add or remove a project, run /spadework:init again and pick the projects there.'));
    fields.set('tracker.projects', wrap);
    box.appendChild(wrap);
  }

  function drawProcess() {
    const box = section('Process and states', 'Triage plans only work items in these states, so list the states where work is still to be done. Finished states (such as Closed, Done or Removed) are usually left out, or triage writes plans for finished work.');
    const choices = [['', 'Pick a process'], ...data.processes.map((name) => [name, name])];
    box.appendChild(field('tracker.process', 'Process', select(cfg.tracker.process, choices, (value) => {
      const before = data.states_by_process[cfg.tracker.process] || [];
      const unchanged = !cfg.tracker.states.length || (cfg.tracker.states.length === before.length && before.every((state, index) => same(state, cfg.tracker.states[index])));
      cfg.tracker.process = value;
      if (unchanged) cfg.tracker.states = [...(data.states_by_process[value] || [])];
      render();
    }), 'Custom is any other process: type its states yourself.'));
    box.appendChild(field('tracker.states', 'States to plan', listInput(cfg.tracker.states, (list) => { cfg.tracker.states = list; }, 'New, Active'),
      'Separate with commas. Add your own, such as a custom Review state.'));
  }

  function drawStateMove() {
    const move = cfg.tracker.on_triage;
    const box = section('State move after triage', 'When on, triage moves a work item to another state once its plan is on the board. It needs Work Items: Read & Write in your Azure DevOps access.');
    box.appendChild(check('Move work items after triage', move.set_state_enabled, (on) => { move.set_state_enabled = on; render(); }));
    fields.set('tracker.on_triage', box);
    if (!move.set_state_enabled) return;
    const grid = h('div', 'cf-grid');
    grid.appendChild(field('tracker.on_triage.set_state', 'Move to', input(move.set_state, (value) => { move.set_state = value.trim(); }, { placeholder: 'Active', options: data.states_by_process[cfg.tracker.process] || [] })));
    grid.appendChild(field('tracker.on_triage.only_from', 'Only from these states', listInput(move.only_from, (list) => { move.only_from = list; }, 'New, Proposed'), 'Separate with commas.'));
    box.appendChild(grid);
  }

  function drawWorkItems() {
    const examples = (data.work_items.examples_by_process[cfg.tracker.process] || []);
    const box = section('Work item types and depth', [
      'Which types Spadework plans, and how deep. With no types listed, every type is planned in full.',
      `Spell each type as Azure DevOps names it in your project: a misspelled type is never found, so copy it from a work item.${examples.length ? ` Usual types for ${cfg.tracker.process}: ${examples.join(', ')}.` : ''}`,
    ]);
    const plans = h('ul', 'cf-help cf-list');
    for (const [, text] of PLANS) plans.appendChild(h('li', '', text));
    box.appendChild(plans);
    fields.set('tracker.work_items', box);
    const items = cfg.tracker.work_items || [];
    items.forEach((item, index) => {
      const row = h('div', 'cf-item cf-grid');
      row.appendChild(field(`tracker.work_items[${index}].type`, 'Type', input(item.type, (value) => {
        item.type = value.trim();
        if (isBug(item.type) && item.plan === 'split') { item.plan = 'full'; render(); }
      }, { placeholder: examples[0] || 'Feature', options: examples })));
      if (!PLANS.some(([plan]) => plan === item.plan)) item.plan = 'full';
      const choices = PLANS.map(([plan]) => [plan, plan]).filter(([plan]) => plan !== 'split' || !isBug(item.type));
      row.appendChild(field(`tracker.work_items[${index}].plan`, 'Depth', select(item.plan, choices, (value) => { item.plan = value; render(); })));
      if (item.plan === 'split') {
        row.appendChild(field(`tracker.work_items[${index}].creates`, 'Splits into', input(item.creates, (value) => { item.creates = value.trim(); }, { placeholder: 'Requirement', options: examples }),
          'The type /spadework:handoff creates in Azure DevOps under the split work item, e.g. Requirement.'));
      }
      const remove = h('div', 'cf-field cf-end');
      remove.appendChild(button('Remove', () => { items.splice(index, 1); if (!items.length) delete cfg.tracker.work_items; render(); }));
      row.appendChild(remove);
      box.appendChild(row);
    });
    box.appendChild(button('Add a type', () => {
      cfg.tracker.work_items = [...items, { type: '', plan: 'full' }];
      render();
    }));
    if (items.some((item) => item.plan === 'split')) box.appendChild(h('p', 'cf-note cf-warn', 'Split needs Work Items: Read & Write in your Azure DevOps access, because handoff creates work items.'));
  }

  // A repo's card folds to one line. Its first state: open while the repo
  // still lacks its name, team or folder; after that, as the user left it.
  const repoSummary = (repo) => [repo.team, repo.main_branch, repo.path].filter(Boolean).join(' · ') || 'Not filled in yet';

  function drawRepo(project, repo, index) {
    const kept = extra(repo);
    const row = h('details', 'cf-item cf-fold');
    row.open = kept.open === undefined ? !(repo.repo && repo.team && repo.path) : kept.open;
    const head = row.appendChild(h('summary', 'cf-fold-head'));
    const paintHead = () => { clear(head).append(h('span', 'cf-fold-title', repo.repo || 'New repo'), h('span', 'cf-note', repoSummary(repo))); };
    paintHead();
    row.addEventListener('toggle', () => { kept.open = row.open; paintHead(); });
    const fetched = optionsOf(project);
    const repoNames = fetched ? fetched.repos.map((entry) => entry.name) : [];
    const grid = h('div', 'cf-grid');
    grid.appendChild(field(`repos[${index}].repo`, 'Repo', input(repo.repo, (value) => {
      // The id comes with a repo from the list; a name typed by hand has none.
      const found = fetched && fetched.repos.find((entry) => same(entry.name, value));
      if (found) repo.repo_id = found.id;
      else if (!same(value, repo.repo)) repo.repo_id = null;
      repo.repo = found ? found.name : value.trim();
    },{ placeholder: repoNames[0] || 'shop-api', options: repoNames }), 'Its name in Azure DevOps.'));
    const teams = [...teamsOf(project).values()];
    const teamInput = input(repo.team, (value) => {
      const team = teamsOf(project).get(value.trim().toLowerCase());
      repo.team = team ? team.name : value.trim();
      if (team && team.area_paths.length) repo.area_paths = structuredClone(team.area_paths);
      areas.textContent = repo.area_paths && repo.area_paths.length ? `Its backlog: work items under ${areaText(repo.area_paths)}.` : 'No area paths for this team yet: run /spadework:init again to fetch its settings.';
    }, { placeholder: teams.length ? teams[0].name : 'Shop Team', options: teams.map((team) => team.name) });
    const teamField = field(`repos[${index}].team`, 'Team (backlog)', teamInput);
    const areas = h('p', 'cf-note', repo.area_paths && repo.area_paths.length ? `Its backlog: work items under ${areaText(repo.area_paths)}.` : 'Pick the team whose backlog holds this repo\'s work.');
    teamField.appendChild(areas);
    fields.set(`repos[${index}].area_paths`, teamField);
    grid.appendChild(teamField);
    row.appendChild(grid);

    const folder = field(`repos[${index}].path`, 'Local folder', input(repo.path, (value) => { repo.path = value.trim().replace(/\\/g, '/'); }, { placeholder: 'C:/repos/shop-api' }), 'Where it is cloned on this machine.');
    detectButton(kept, 'repo', folder, () => detectRepo(project, repo));
    const found = kept.detect;
    if (found) {
      const notes = h('div', 'cf-detect');
      if (found.error) notes.appendChild(h('p', 'err', found.error));
      for (const problem of found.problems || []) notes.appendChild(h('p', 'err', problem));
      if (found.top_level && found.problems && found.problems.length && !same(found.top_level.replace(/\\/g, '/'), repo.path)) {
        notes.appendChild(button(`Use ${found.top_level.replace(/\\/g, '/')}`, () => { repo.path = found.top_level.replace(/\\/g, '/'); detectRepo(project, repo); }));
      }
      if (!found.error && !(found.problems || []).length) notes.appendChild(h('p', 'cf-note cf-ok', `Found the clone of ${repo.repo || found.name}.`));
      if (found.main_branch && repo.main_branch && found.main_branch !== repo.main_branch) {
        notes.appendChild(h('p', 'cf-note', `Its default branch looks like ${found.main_branch}.`));
        notes.appendChild(button(`Use ${found.main_branch}`, () => { repo.main_branch = found.main_branch; render(); }));
      }
      folder.appendChild(notes);
    }
    row.appendChild(folder);

    const more = h('div', 'cf-grid');
    more.appendChild(field(`repos[${index}].main_branch`, 'Main branch', input(repo.main_branch, (value) => { repo.main_branch = value.trim(); }, { placeholder: 'main' }), 'Detect fills it in from the clone.'));
    more.appendChild(field(`repos[${index}].parts`, 'Parts you work on (optional)', listInput(repo.parts, (list) => { repo.parts = list; }, 'backend, frontend'),
      'If the repo holds a backend and a frontend and you own only one: triage then plans only those parts. Any short names, e.g. backend, frontend, AI, mobile, data. Leave it empty for the whole repo.'));
    row.appendChild(more);
    row.appendChild(field(`repos[${index}].test_commands`, 'Test commands (optional)', linesInput(repo.test_commands, (list) => { repo.test_commands = list; }, 'npm test'),
      'One command per line. /spadework:merge runs them in the merged branch, one after the other, and stops at the first that fails. Each one must finish in 9 minutes: split a long suite into several commands. Leave it empty to skip the tests.'));
    row.appendChild(button('Remove this repo', () => { cfg.repos.splice(cfg.repos.indexOf(repo), 1); extras.delete(repo); render(); }));
    return row;
  }

  // --- Detect ------------------------------------------------------------------------

  const SLOW_MS = 5000;
  const SLOW_HINTS = {
    repo: 'Still checking: asking Azure DevOps for the main branch can take up to a minute.',
    stack: 'Still reading the repo\'s files.',
  };

  // A repo's Detect button (kind: 'repo' or 'stack') in the field box it fills in.
  // Its state is kept with the repo, so a render while it runs draws it busy again.
  function detectButton(kept, kind, box, onClick) {
    const row = box.appendChild(h('div', 'cf-row'));
    kept.ui[kind] = { box, button: row.appendChild(button('Detect', onClick)), hint: row.appendChild(h('span', 'cf-note', SLOW_HINTS[kind])) };
    paintDetect(kept, kind);
  }

  function paintDetect(kept, kind) {
    const ui = kept.ui[kind];
    if (!ui) return;
    const busy = Boolean(kept.busy[kind]);
    ui.button.disabled = busy;
    ui.button.textContent = busy ? 'Detecting…' : 'Detect';
    ui.button.classList.toggle('cf-busy', busy);
    if (busy) ui.box.setAttribute('aria-busy', 'true');
    else ui.box.removeAttribute('aria-busy');
    ui.hint.hidden = kept.busy[kind] !== 'slow';
  }

  // Save waits while a Detect runs: what it finds may change the values.
  function paintSave() {
    $('save').disabled = saving || detects > 0;
    $('save').title = detects > 0 && !saving ? 'Wait for Detect to finish' : '';
  }

  // Runs one Detect of a repo; a click while it runs does nothing.
  async function detecting(kept, kind, run) {
    if (kept.busy[kind]) return;
    kept.busy[kind] = 'busy';
    detects += 1;
    paintDetect(kept, kind);
    paintSave();
    const slow = setTimeout(() => { kept.busy[kind] = 'slow'; paintDetect(kept, kind); }, SLOW_MS);
    try {
      await run();
    } finally {
      clearTimeout(slow);
      kept.busy[kind] = null;
      detects -= 1;
      paintDetect(kept, kind);
      paintSave();
    }
  }

  const detectRepo = (project, repo) => detecting(extra(repo), 'repo', async () => {
    const kept = extra(repo);
    if (!repo.path) { kept.detect = { error: 'Type the folder first.' }; render(); return; }
    try {
      const { answer } = await api('POST', '/api/init/detect-repo', { path: repo.path, organization: cfg.tracker.organization || undefined, project, repo: repo.repo || undefined });
      if (!answer.ok) { kept.detect = { error: answer.error }; render(); return; }
      kept.detect = answer;
      kept.graph = { graph: answer.graph, build_command: answer.build_command };
      if (!repo.main_branch && answer.main_branch) repo.main_branch = answer.main_branch;
      if (!repo.repo && answer.ado) repo.repo = answer.ado.repo;
    } catch (err) {
      kept.detect = { error: err.message };
    }
    render();
  });

  function drawRepos() {
    const box = section('Repos and backlogs', [
      'A repo is one Azure DevOps Git repository: its local clone, its main branch and its backlog.',
      'In Azure DevOps a project is split into backlogs by teams: a team\'s backlog is the work items under its area paths. Every repo needs a team, and several repos may share one.',
    ]);
    fields.set('repos', box);
    for (const project of projects()) {
      // Each project folds too; open unless the user closed it.
      const group = box.appendChild(h('details', 'cf-fold cf-group'));
      group.open = !closedProjects.has(project);
      group.addEventListener('toggle', () => { if (group.open) closedProjects.delete(project); else closedProjects.add(project); });
      const count = cfg.repos.filter((repo) => same(repo.project, project)).length;
      const head = group.appendChild(h('summary', 'cf-fold-head'));
      head.append(h('span', 'cf-project', project), h('span', 'cf-note', `${count} repo${count === 1 ? '' : 's'}`));
      cfg.repos.forEach((repo, index) => { if (same(repo.project, project)) group.appendChild(drawRepo(project, repo, index)); });
      const add = group.appendChild(h('div', 'cf-actions'));
      add.appendChild(button('Add a repo', () => { cfg.repos.push({ path: '', main_branch: '', project, repo: '', repo_id: null, team: '', area_paths: [] }); render(); }));
    }
  }

  function drawBoard() {
    const items = cfg.board.items;
    const box = section('Board', [
      'Spadework keeps its plans on a local board, one row per plan. You read, edit and approve them on the board page (/spadework:board).',
      'One board holds the rows of all your projects: each project has its own ID prefix, and the statuses are shared by all of them.',
    ]);
    box.appendChild(h('h3', 'cf-sub', 'Row ID prefix, one per project'));
    const prefixes = h('div', 'cf-grid');
    for (const project of projects()) {
      prefixes.appendChild(field(`board.projects.${project}`, project, input(cfg.board.projects[project].prefix, (value) => { cfg.board.projects[project].prefix = value.trim().toUpperCase(); }, { placeholder: 'SHOP' })));
    }
    box.appendChild(prefixes);
    box.appendChild(h('p', 'cf-note', 'A row\'s ID starts with its project\'s prefix: with SHOP and BILL, rows are SHOP-1, SHOP-2... and BILL-1, BILL-2... You pass these IDs to /spadework:implement and /spadework:handoff, and implement names its branches after them (spadework/SHOP-1). 2 to 10 capital letters or digits, starting with a letter, different for each project. Changing a prefix later starts a new numbering: old rows keep their IDs.'));
    box.appendChild(h('h3', 'cf-sub', 'Statuses, shared by all projects'));
    box.appendChild(field('board.items.statuses', 'Statuses', listInput(items.statuses, (list) => { items.statuses = list; }, 'New, Needs info, Approved...'), 'Separate with commas. Rename or add any; every role below must point to one of them.'));
    box.lastChild.querySelector('input').addEventListener('change', render);
    const roles = h('div', 'cf-grid');
    const choices = (items.statuses || []).map((status) => [status, status]);
    for (const [role, label, who] of ROLES) {
      const value = (items.statuses || []).includes(items[role]) ? items[role] : '';
      roles.appendChild(field(`board.items.${role}`, label, select(value, [['', 'Pick a status'], ...choices], (status) => { items[role] = status; }), who));
    }
    box.appendChild(roles);
    box.appendChild(field('board.language', 'Language', input(cfg.board.language, (value) => { cfg.board.language = value.trim(); }, { placeholder: 'en-US', options: LANGUAGES }),
      'The language Spadework writes on the board: a locale with its region (en-US, pt-PT, pt-BR, es-ES...), or same_as_card to follow each work item\'s language.'));
  }

  function drawStack() {
    const box = section('Stack', [
      'Spadework\'s agents know nothing about any language or framework: what they know comes from these notes (~/.spadework/stack.md). Keep them short: lists, not prose.',
      'Common is for what all repos share (often git conventions, secrets handling and off-limits rules); each repo\'s box is for what differs. Detect fills in what the repo\'s files say. A point nobody fills in is left out.',
    ]);
    const hint = `What to cover:\n${STACK_POINTS.map((point, index) => `${index + 1}. ${point}`).join('\n')}`;
    const area = (value, onInput) => {
      const node = h('textarea', 'cf-input');
      node.value = value;
      node.placeholder = hint;
      node.spellcheck = false;
      node.addEventListener('input', () => onInput(node.value));
      return node;
    };
    box.appendChild(field('stack:Common', 'Common', area(common, (value) => { common = value; }), 'e.g. - Git: Conventional Commits   - Secrets: environment variables, never in config files'));
    for (const repo of cfg.repos) {
      const label = repoLabel(repo);
      const kept = extra(repo);
      const text = area(kept.notes, (value) => { kept.notes = value; });
      const box2 = field(`stack:${label}`, label, text);
      detectButton(kept, 'stack', box2, () => detecting(kept, 'stack', async () => {
        if (!repo.path) return toast('Type the repo\'s folder first.', true);
        try {
          const { answer } = await api('POST', '/api/init/detect-stack', { path: repo.path });
          if (!answer.ok) return toast(answer.error, true);
          const have = new Set(kept.notes.split('\n').map((line) => line.trim()));
          const added = answer.lines.filter((line) => !have.has(line));
          kept.notes = [kept.notes.trimEnd(), ...added].filter(Boolean).join('\n');
          // The box drawn now: the page may have been drawn again while Detect ran.
          kept.ui.stack.box.querySelector('textarea').value = kept.notes;
          toast(added.length ? `Added ${added.length} line${added.length === 1 ? '' : 's'}: check them` : 'Nothing new found');
        } catch (err) { toast(err.message, true); }
      }));
      box.appendChild(box2);
    }
  }

  function drawGraphify() {
    const box = section('Graphify', 'Optional: it builds a code graph on this machine, so triage reads fewer files. Triage uses a graph when the repo has one, and searches with git grep when it doesn\'t. Spadework never builds or updates a graph.');
    box.appendChild(check('Use graphify', cfg.graphify.enabled, (on) => { cfg.graphify.enabled = on; render(); }));
    box.appendChild(h('p', 'cf-note', 'It needs graphify installed on this machine. If it isn\'t, triage searches with git grep, and /spadework:validate says so.'));
    if (!cfg.graphify.enabled) return;
    const missing = cfg.repos.filter((repo) => extra(repo).graph && extra(repo).graph.build_command);
    if (!missing.length) return;
    box.appendChild(h('p', 'cf-help', 'These repos have no graph yet. To build one, run this in a terminal (it reads only code, on this machine, and can take a few minutes):'));
    for (const repo of missing) {
      const line = h('div', 'cf-row');
      const command = extra(repo).graph.build_command;
      line.append(h('code', 'cf-cmd', command), button('Copy', () => { if (navigator.clipboard) navigator.clipboard.writeText(command).then(() => toast('Copied'), () => {}); }));
      box.appendChild(line);
    }
    box.appendChild(h('p', 'cf-note', 'After big changes on the main branch, run graphify update . in the repo. Graphify writes a graphify-out/ folder there: whether to commit it or add it to .gitignore is your call.'));
  }

  function drawLimits() {
    const box = section('Triage, implement and merge');
    const grid = h('div', 'cf-grid');
    const number = (part, name, label, help) => grid.appendChild(field(`${part}.${name}`, label, input(cfg[part][name], (value) => setOrDrop(cfg[part], name, numberValue(value)), { type: 'number' }), help));
    number('triage', 'max_cards_per_run', 'Most work items per triage run', 'A single run can ask for more with --limit.');
    number('triage', 'max_backlog_items', 'Most work items per backlog query', 'Triage reads them 100 at a time and stops once it has planned its limit.');
    number('implement', 'max_review_rounds', 'Review rounds', 'How many times review problems go back to the developer before implement stops.');
    grid.appendChild(field('implement.branch_prefix', 'Branch prefix (optional)', input(cfg.implement.branch_prefix, (value) => { cfg.implement.branch_prefix = value.trim(); }, { placeholder: 'feature-' }),
      'Implement makes one branch per row: spadework/<branch prefix><row ID>. Empty, a branch is spadework/SHOP-35; with feature- it is spadework/feature-SHOP-35. The row ID already names the project, so leave it empty unless your team has a naming rule. It applies to every repo.'));
    grid.appendChild(field('implement.workspace', 'Where implement works', select(cfg.implement.workspace, [['branch', 'branch: in the repo folder (needs a clean working tree)'], ['worktree', 'worktree: a separate folder next to the repo']], (value) => { cfg.implement.workspace = value; })));
    box.appendChild(grid);
    box.appendChild(check('Plan again when a New or Needs info work item\'s text changes (state, sprint, assignee, tags and comments never count)', cfg.triage.reanalyze_when_card_changes, (on) => { cfg.triage.reanalyze_when_card_changes = on; }));
    box.appendChild(check('Web research: triage searches the web when a plan needs it (how a library or API behaves). It costs more tokens; a cheaper model searches and never sees the code or the work item.', cfg.triage.web_research, (on) => { cfg.triage.web_research = on; }));
    box.appendChild(h('h3', 'cf-sub', 'Merge'));
    box.appendChild(check('Integrate: /spadework:merge creates a new branch from main, merges the built rows into it, resolves conflicts and runs the tests. Off, it only prints the order and the commands, and you merge.', cfg.merge.integrate, (on) => { cfg.merge.integrate = on; }));
    box.appendChild(h('p', 'cf-note', 'It never pushes and never changes main. You review the new branch, push it and open one pull request.'));
    fields.set('triage', box);
    fields.set('implement', box);
    fields.set('merge', box);
  }

  // --- errors ------------------------------------------------------------------------

  // The registered field a problem belongs to: the longest name it starts with.
  function placeOf(name) {
    let best = null;
    for (const known of fields.keys()) {
      if ((name === known || name.startsWith(`${known}.`) || name.startsWith(`${known}[`)) && (!best || known.length > best.length)) best = known;
    }
    return best;
  }

  // The check's messages are written for config.json (validate shows them
  // there): under a field on this page they say it in the form's words.
  function pageMessage(name, message) {
    if (/^missing\.? Use one of/.test(message)) return 'Pick a process';
    if (/\.area_paths$/.test(name) && /^(missing|must be a non-empty list)/.test(message)) return 'No backlog: pick a team from the list. A team typed by hand has no area paths; run /spadework:init again to fetch its settings';
    if (name === 'repos' && message === 'must be a non-empty list') return 'Add at least one repo';
    if (/^(missing|must be a non-empty (string|list))$/.test(message)) return 'Required';
    let text = message.replace(/ is also repos\[\d+\]\./, ' is already listed.');
    for (const [role, label] of ROLES) text = text.split(` ${role}.`).join(` "${label}".`);
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function showProblems() {
    const loose = [];
    const add = (name, message) => {
      const place = name ? placeOf(name) : null;
      if (!place) return loose.push(name ? `${name}: ${message}` : message);
      const box = fields.get(place);
      box.classList.add('bad');
      // The field is marked red, so its config name isn't repeated.
      box.appendChild(h('p', 'err', pageMessage(name, message)));
      // A folded card or project opens, so the error shows.
      for (let fold = box.closest('details'); fold; fold = fold.parentElement.closest('details')) fold.open = true;
    };
    for (const problem of problems.config) add(problem.field, problem.message);
    for (const problem of problems.stack) add(problem.section ? `stack:${problem.section}` : '', problem.message);
    const summary = clear($('summary'));
    const count = problems.config.length + problems.stack.length;
    if (problems.failure) summary.appendChild(h('span', 'err', problems.failure));
    if (count) summary.appendChild(h('span', 'err', `${count} value${count === 1 ? ' needs' : 's need'} fixing: see the fields marked in red.`));
    for (const text of loose) summary.appendChild(h('div', 'err', text));
  }

  function render() {
    const scroll = $('main').scrollTop;
    clear($('form'));
    fields.clear();
    uid = 0;
    const intro = h('div', 'cf-intro');
    intro.appendChild(h('h1', '', 'Spadework settings'));
    intro.appendChild(h('p', 'cf-help', 'Fill in or change the settings, then press Save at the bottom. After it saves, go back to the chat in Claude Code to finish.'));
    for (const note of notes) intro.appendChild(h('p', 'cf-note cf-warn', note));
    $('form').appendChild(intro);
    drawAzure();
    drawProcess();
    drawStateMove();
    drawWorkItems();
    drawRepos();
    drawBoard();
    drawStack();
    drawGraphify();
    drawLimits();
    showProblems();
    $('main').scrollTop = scroll;
  }

  // --- saving ------------------------------------------------------------------------

  async function save() {
    if (saving || detects) return;
    saving = true;
    $('save').disabled = true;
    $('save').textContent = 'Saving…';
    try {
      const { status, answer } = await api('POST', '/api/init/save', { config: built(), stack: stackText() });
      if (answer.ok) return saved();
      // 422: values to fix, by field. Anything else (no setup running...) is one message.
      problems = status === 422 ? { config: (answer.config && answer.config.errors) || [], stack: (answer.stack && answer.stack.errors) || [] } : { config: [], stack: [], failure: answer.error };
      render();
      toast(answer.error || 'Not saved', true);
    } catch (err) {
      toast(err.message, true);
    } finally {
      saving = false;
      paintSave();
      $('save').textContent = 'Save';
    }
  }

  // Saved: close this tab (the open page replaced itself, so the tab has only
  // this page in its history and the browser lets it close). If it stays, say so.
  function saved() {
    showMessage('Saved', ['Go back to the chat in Claude Code to finish the setup.']);
    window.close();
    setTimeout(() => showMessage('Saved. Close this tab and go back to the chat.', ['Claude Code checks the setup there and finishes.']), 300);
  }

  // --- start -------------------------------------------------------------------------

  const notes = [];

  async function start() {
    if (location.protocol === 'file:') {
      showMessage('The settings page isn\'t running', ['Run /spadework:init in Claude Code: it opens this page.']);
      return;
    }
    key = readKey();
    if (!key) {
      showMessage('This page needs its link', ['The settings page opens with a key in its link. Run /spadework:init in Claude Code and use the page it opens.']);
      return;
    }
    themeButton($('theme'));
    let answer;
    let status;
    try {
      ({ status, answer } = await api('GET', '/api/init'));
    } catch (err) {
      if (!$('message').hidden) return;
      showMessage("The settings page can't start", [err.message]);
      return;
    }
    if (status === 404) {
      showMessage('Spadework\'s helper is out of date', ['It was started by an older version of the plugin. Run /spadework:board stop, then /spadework:init again.']);
      return;
    }
    if (!answer.ok) {
      showMessage("The settings page can't start", [answer.error]);
      return;
    }
    data = answer;
    const dropped = prepare();
    if (data.parse_error) notes.push(`config.json isn't valid JSON (${data.parse_error}), so these are the defaults. Saving keeps the old file as config.json.bak.`);
    if (dropped.length) notes.push(`These repos belong to projects you didn't pick, so they are left out: ${dropped.join(', ')}.`);
    if (!data.options) notes.push('No repo or team lists from Azure DevOps this time: you can still type the names.');
    // The current config's problems, where they are: fix them before saving.
    if (data.start.from === 'current' && data.validation && !data.validation.ok) problems = { config: data.validation.errors, stack: [] };
    $('top').hidden = false;
    $('main').hidden = false;
    $('bar').hidden = false;
    $('message').hidden = true;
    $('save').addEventListener('click', save);
    render();
  }

  start();
})();
