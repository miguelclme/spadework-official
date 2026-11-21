'use strict';

// The board's page. It talks to the helper (lib/board-server.js) and draws
// everything with createElement and textContent: nothing from a row is ever
// parsed as markup. Links are made only for http(s) and vscode addresses.
// page.js (loaded first) sets the theme and gives the shared helpers.
(function () {
  const { h, clear, readKey, themeButton } = window.SpadeworkPage;

  const ROW_H = 50;
  const BUFFER = 8;
  const ROLES = ['default_status', 'needs_info_status', 'retriage_status', 'approved_status', 'in_progress_status', 'blocked_status', 'resume_status', 'implemented_status', 'merged_status'];
  const TONES = {
    default_status: 't-ready', needs_info_status: 't-needs', retriage_status: 't-needs', approved_status: 't-approved',
    in_progress_status: 't-progress', blocked_status: 't-blocked', resume_status: 't-progress', implemented_status: 't-approved',
    merged_status: 't-merged',
  };
  const HINTS = {
    default_status: 'plan to review', needs_info_status: 'waiting for you', retriage_status: 'waiting for re-triage', approved_status: 'waiting for a run',
    in_progress_status: 'running now', blocked_status: 'needs a look', resume_status: 'waiting to resume', implemented_status: 'code is ready',
    merged_status: 'in an integration branch',
  };
  // Sections of a plan, as the planners write them (templates/plan.md names them the same).
  const PLAN_SECTIONS = [
    { key: 'context', title: 'Context', kind: 'text' },
    { key: 'findings', title: 'Code findings', kind: 'list', links: true },
    { key: 'root_cause', title: 'Root cause', kind: 'text' },
    { key: 'steps', title: 'Proposed solution', kind: 'olist' },
    { key: 'commits', title: 'Commit breakdown', kind: 'olist' },
    { key: 'decisions', title: 'Risks and open decisions', kind: 'list' },
  ];
  const SPEC_SECTIONS = [
    { key: 'what_to_build', title: 'What to build', kind: 'text' },
    { key: 'contract', title: 'Contract', kind: 'text' },
    { key: 'acceptance', title: 'Acceptance criteria', kind: 'text' },
    { key: 'depends_on', title: 'Depends on', kind: 'text' },
  ];
  const HEADS = [
    { key: 'id', text: 'ID' }, { key: 'title', text: 'Title' }, { key: 'feature', text: 'Parent' }, { key: 'type', text: 'Type' },
    { key: 'status', text: 'Status' }, { key: 'wi', text: 'Work item' }, { key: 'repo', text: 'Repo' }, { key: 'last', text: 'Last event' }, { key: null, text: '' },
  ];

  const state = {
    items: null, projects: [], prefix: null, rows: [],
    status: '', repo: '', type: '', q: '', closed: false, sortKey: 'id', dir: 1,
    view: 'table', viewToken: 0, days: 14, hidden: new Set(), by: '', dayPick: undefined, tlMode: 'lanes', laneOrder: 'latest', tl: null, group: 'feature', nested: false, spacing: 'normal', groupFilter: { for: '', hidden: new Set() }, groupsOpen: false, groupSearch: '', groupScroll: 0, layouts: new Map(), saveLayout: null, statDays: 7, edges: { parent: true, related: true, depends: true, file: true }, mergeRepo: '', mergeLit: new Set(),
    shown: [], curId: null, showCur: false, review: false, open: null, openToken: 0, timelineFor: null, leaveView: null, busy: false, locked: false,
  };
  let key = null;
  let lastLoad = 0;

  const $ = (id) => document.getElementById(id);
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  const toast = (text, bad) => window.SpadeworkPage.toast($('toast'), text, bad);

  // --- the key and the server --------------------------------------------------------

  function initKey() {
    key = readKey();
  }

  function showMessage(title, lines, copy) {
    $('top').hidden = true;
    $('app').hidden = true;
    $('other').hidden = true;
    const box = clear($('message'));
    box.hidden = false;
    box.appendChild(h('h1', '', title));
    for (const line of lines) box.appendChild(h('p', '', line));
    if (copy) {
      const button = h('button', 'btn primary', 'Copy the command');
      button.type = 'button';
      button.addEventListener('click', () => {
        const done = () => { button.textContent = 'Copied'; };
        if (navigator.clipboard) navigator.clipboard.writeText(copy).then(done, () => {});
      });
      box.appendChild(h('p')).appendChild(h('code', '', copy));
      box.appendChild(button);
    }
  }

  function locked() {
    state.locked = true;
    showMessage('This page needs its link', ['The board opens with a key in its link. Start it again with /spadework:board and use the link it opens.']);
  }

  async function api(method, path, body) {
    const headers = { 'X-Spadework-Key': key || '' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(path, { method, headers, cache: 'no-store', body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new Error("Can't reach the board. If it stopped, start it again with /spadework:board");
    }
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (res.status === 403) {
      locked();
      throw new Error('The board needs its link');
    }
    if (!res.ok || !data || data.ok === false) throw new Error((data && data.error) || `The request failed (${res.status})`);
    return data;
  }

  // --- statuses ----------------------------------------------------------------------

  const roleOf = (status) => ROLES.find((role) => same(state.items[role], status)) || '';
  const tone = (status) => TONES[roleOf(status)] || 't-new';
  const isClosed = (status) => ['done_status', 'rejected_status'].some((role) => same(state.items[role], status));
  const defaultStatus = () => state.items.default_status;
  const canApprove = (status) => !['approved_status', 'in_progress_status', 'implemented_status', 'merged_status'].includes(roleOf(status)) && !isClosed(status);

  function statusPill(status) {
    const pill = h('span', `st ${tone(status)}`);
    pill.appendChild(h('span', '', status));
    return pill;
  }

  // --- links and text ----------------------------------------------------------------

  // Row text comes from work items: its links are web links only. The vscode://file/
  // links are built by the page (vscodeHref) and pass with `editor`.
  function safeHref(url, editor) {
    try {
      const parsed = new URL(url);
      if (editor) return parsed.protocol === 'vscode:' && parsed.hostname === 'file' ? parsed.href : null;
      return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null;
    } catch {
      return null;
    }
  }

  function anchor(text, href, code, editor) {
    const safe = safeHref(href, editor);
    if (!safe) return h(code ? 'code' : 'span', '', text);
    const link = h('a');
    link.href = safe;
    if (safe.startsWith('http')) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    if (code) link.appendChild(h('code', '', text)); else link.textContent = text;
    return link;
  }

  const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\/)/;
  function vscodeHref(repoPath, file, line) {
    const joined = ABSOLUTE.test(file) ? file : `${repoPath}/${file}`;
    return `vscode://file/${encodeURI(joined.replace(/\\/g, '/'))}:${line}`;
  }

  const FILE_REF = /^((?:[\w.-]+[\\/])*[\w.-]+\.\w{1,8}):(\d+)$/;
  const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|((?:[\w.-]+[\\/])*[\w.-]+\.\w{1,8}:\d+)/g;

  // Text with `code`, **bold**, [links](http...) and file:line references.
  // ctx.repoPath turns a file:line into a link that opens VS Code there.
  function inline(parent, text, ctx) {
    const source = String(text);
    let last = 0;
    INLINE.lastIndex = 0;
    for (let m = INLINE.exec(source); m; m = INLINE.exec(source)) {
      if (m.index > last) parent.appendChild(document.createTextNode(source.slice(last, m.index)));
      const ref = (m[1] || m[5] || '').match(FILE_REF);
      if (m[1] !== undefined || m[5] !== undefined) {
        const shown = m[1] !== undefined ? m[1] : m[5];
        if (ref && ctx && ctx.repoPath) parent.appendChild(anchor(shown, vscodeHref(ctx.repoPath, ref[1], ref[2]), m[1] !== undefined, true));
        else parent.appendChild(m[1] !== undefined ? h('code', '', shown) : document.createTextNode(shown));
      } else if (m[2] !== undefined) {
        parent.appendChild(h('strong', '', m[2]));
      } else {
        parent.appendChild(anchor(m[3], m[4]));
      }
      last = INLINE.lastIndex;
    }
    if (last < source.length) parent.appendChild(document.createTextNode(source.slice(last)));
    return parent;
  }

  // Paragraphs, lists, headings and code blocks.
  function blocks(parent, text, ctx) {
    const lines = String(text).split(/\r?\n/);
    let paragraph = [];
    let list = null;
    const flush = () => {
      if (paragraph.length) inline(parent.appendChild(h('p')), paragraph.join(' '), ctx);
      paragraph = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        flush(); list = null;
        const code = [];
        for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
        parent.appendChild(h('pre')).appendChild(h('code', '', code.join('\n')));
        continue;
      }
      const item = line.match(/^\s*(?:([-*])|(\d+)\.)\s+(.*)$/);
      if (item) {
        flush();
        const tag = item[1] ? 'ul' : 'ol';
        if (!list || list.tagName.toLowerCase() !== tag) list = parent.appendChild(h(tag));
        inline(list.appendChild(h('li')), item[3], ctx);
        continue;
      }
      list = null;
      const heading = line.match(/^#{1,6}\s+(.*)$/);
      if (heading) { flush(); inline(parent.appendChild(h('h4')), heading[1], ctx); continue; }
      if (line.trim() === '') { flush(); continue; }
      paragraph.push(line.trim());
    }
    flush();
    return parent;
  }

  const fmtDay = (iso) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const fmtTime = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  // --- the table ---------------------------------------------------------------------

  const numberOf = (row) => Number(row.id.slice(row.id.lastIndexOf('-') + 1));
  const lastAt = (row) => (row.last_event ? row.last_event.at : '');
  const SORTS = {
    id: numberOf,
    title: (row) => row.title.toLowerCase(),
    feature: (row) => row.parent_id || 0,
    type: (row) => row.type,
    status: (row) => state.items.statuses.findIndex((name) => same(name, row.status)),
    wi: (row) => (row.work_item ? row.work_item.id : 0),
    repo: (row) => row.repo || '',
    last: lastAt,
  };

  function visibleRows() {
    const q = state.q.trim().toLowerCase();
    const list = state.rows.filter((row) => {
      if (!state.closed && isClosed(row.status)) return false;
      if (state.status && !same(row.status, state.status)) return false;
      if (state.repo && row.repo !== state.repo) return false;
      if (state.type && row.type !== state.type) return false;
      if (!q) return true;
      const text = [row.id, row.title, row.repo, row.type, row.status, row.work_item ? row.work_item.id : '', row.parent_id || ''].join(' ').toLowerCase();
      return text.includes(q);
    });
    const get = SORTS[state.sortKey];
    return list.sort((a, b) => {
      const x = get(a);
      const y = get(b);
      const order = typeof x === 'string' ? x.localeCompare(y) : x - y;
      return state.dir * (order || numberOf(a) - numberOf(b));
    });
  }

  // The review queue: planned rows waiting for the user, oldest first.
  const queue = () => state.rows.filter((row) => same(row.status, defaultStatus())).sort((a, b) => numberOf(a) - numberOf(b));

  function drawHeads() {
    const head = clear($('heads'));
    for (const col of HEADS) {
      const th = h('th', col.key === state.sortKey ? 'sorted' : '', col.text + (col.key === state.sortKey ? (state.dir > 0 ? ' ▲' : ' ▼') : ''));
      if (col.key) {
        th.addEventListener('click', () => {
          state.dir = state.sortKey === col.key ? -state.dir : 1;
          state.sortKey = col.key;
          drawHeads();
          drawRows();
        });
      }
      head.appendChild(th);
    }
  }

  function drawCards() {
    const box = clear($('cards'));
    for (const status of state.items.statuses) {
      if (!state.closed && isClosed(status)) continue;
      const count = state.rows.filter((row) => same(row.status, status)).length;
      if (!count) continue;
      const card = h('button', `stat${same(state.status, status) ? ' on' : ''}`);
      card.type = 'button';
      card.appendChild(h('span', 'n', String(count)));
      const label = h('span', `l ${tone(status)}`);
      label.appendChild(h('span', '', status));
      card.appendChild(label);
      card.appendChild(h('span', 'h', HINTS[roleOf(status)] || ''));
      card.addEventListener('click', () => {
        state.status = same(state.status, status) ? '' : status;
        drawCards();
        drawRows();
      });
      box.appendChild(card);
    }
  }

  function fillSelect(select, label, values, current) {
    clear(select);
    const first = h('option', '', label);
    first.value = '';
    select.appendChild(first);
    for (const value of values) {
      const option = h('option', '', value);
      option.value = value;
      select.appendChild(option);
    }
    select.value = values.includes(current) ? current : '';
  }

  function drawFilters() {
    const repos = [...new Set(state.rows.map((row) => row.repo).filter(Boolean))].sort();
    const types = [...new Set(state.rows.map((row) => row.type))].sort();
    if (!repos.includes(state.repo)) state.repo = '';
    if (!types.includes(state.type)) state.type = '';
    fillSelect($('repo'), 'All repos', repos, state.repo);
    fillSelect($('type'), 'All types', types, state.type);
  }

  function drawReview() {
    const n = queue().length;
    const button = $('review');
    button.disabled = n === 0;
    button.textContent = n ? `Review ${plural(n, `${defaultStatus()} plan`)} →` : `No ${defaultStatus()} plans to review`;
  }

  function rowElement(row) {
    const tr = h('tr', `row${state.showCur && row.id === state.curId ? ' cur' : ''}`);
    tr.dataset.id = row.id;
    tr.appendChild(h('td', 'id', row.id));
    tr.appendChild(h('td', '', row.title));
    tr.appendChild(h('td', row.parent_id ? 'id' : 'dim', row.parent_id ? `#${row.parent_id}` : '–'));
    tr.appendChild(h('td', 'dim', row.type));
    tr.appendChild(h('td')).appendChild(statusPill(row.status));
    tr.appendChild(h('td', row.work_item ? 'id' : 'dim', row.work_item ? `#${row.work_item.id}` : 'not created yet'));
    tr.appendChild(h('td', 'dim', row.repo || '–'));
    tr.appendChild(h('td', 'dim', row.last_event ? `${fmtDay(row.last_event.at)} · ${row.last_event.text}` : ''));
    const action = h('td', 'act');
    if (same(row.status, defaultStatus())) {
      const quick = h('button', 'qa', 'Approve');
      quick.type = 'button';
      quick.addEventListener('click', (event) => { event.stopPropagation(); approve(row.id, false); });
      action.appendChild(quick);
    }
    tr.appendChild(action);
    tr.addEventListener('click', () => openRow(row.id, { review: false }));
    return tr;
  }

  // A long list drawn a window at a time: only the items on screen (and BUFFER more each side) are
  // in the page, and a spacer stands for the rest. The table and the timeline's lanes use it.
  // list: { scroller(), body(), itemH, offset(), count(), item(i), spacer(px), range }.
  // Returns whether it drew.
  function drawWindow(list, force) {
    const scroller = list.scroller();
    const count = list.count();
    const top = Math.max(0, scroller.scrollTop - list.offset());
    const first = Math.max(0, Math.floor(top / list.itemH) - BUFFER);
    const last = Math.min(count, Math.ceil((top + scroller.clientHeight) / list.itemH) + BUFFER);
    if (!force && list.range && first === list.range[0] && last === list.range[1]) return false;
    list.range = [first, last];
    const body = clear(list.body());
    if (first > 0) body.appendChild(list.spacer(first * list.itemH));
    for (let i = first; i < last; i++) body.appendChild(list.item(i));
    if (last < count) body.appendChild(list.spacer((count - last) * list.itemH));
    return true;
  }

  function spacer(height) {
    const tr = h('tr', 'spacer-row');
    tr.appendChild(h('td')).colSpan = 9;
    tr.firstChild.style.height = `${height}px`;
    return tr;
  }

  const tableWindow = {
    scroller: () => $('tablewrap'), body: () => $('rows'), itemH: ROW_H, offset: () => $('heads').offsetHeight,
    count: () => state.shown.length, item: (i) => rowElement(state.shown[i]), spacer, range: null,
  };
  const drawTable = (force) => drawWindow(tableWindow, force);

  function drawRows() {
    state.shown = visibleRows();
    drawTable(true);
    $('empty').hidden = state.shown.length > 0;
    $('empty').textContent = state.rows.length ? 'No rows match.' : 'No rows yet. Run /spadework:triage to plan work items.';
    const open = state.rows.filter((row) => !isClosed(row.status)).length;
    $('count').textContent = `${state.shown.length} shown of ${state.rows.length}${state.closed ? '' : ` (${open} open)`}`;
    drawReview();
  }

  function markCurrent() {
    for (const tr of $('rows').children) tr.classList.toggle('cur', state.showCur && tr.dataset.id === state.curId);
  }

  function scrollTo(index) {
    const wrap = $('tablewrap');
    const head = $('heads').offsetHeight;
    const y = index * ROW_H;
    if (y < wrap.scrollTop) wrap.scrollTop = y;
    else if (y + ROW_H + head > wrap.scrollTop + wrap.clientHeight) wrap.scrollTop = y + ROW_H + head - wrap.clientHeight;
    drawTable(false);
  }

  function move(step) {
    if (!state.shown.length) return;
    const at = state.shown.findIndex((row) => row.id === state.curId);
    const next = Math.max(0, Math.min(state.shown.length - 1, at < 0 ? 0 : at + step));
    state.curId = state.shown[next].id;
    state.showCur = true;
    scrollTo(next);
    markCurrent();
  }

  async function loadRows() {
    lastLoad = Date.now();
    const data = await api('GET', `/api/rows?project=${encodeURIComponent(state.prefix)}`);
    state.rows = data.rows;
    if (data.errors.length) toast(`These row files can't be read: ${data.errors.join(', ')}`, true);
    drawFilters();
    drawCards();
    drawRows();
    if (state.open && !state.rows.some((row) => row.id === state.open.id)) closeRow();
    else if ($('drawer').classList.contains('on')) paintHead();
    if (state.view !== 'table') renderOther();
  }

  // --- the drawer --------------------------------------------------------------------

  const rowSummary = (id) => state.rows.find((row) => row.id === id);
  // The open row as the helper answered it: the row, and the rows it depends on.
  const opened = (data) => ({ ...data.row, dependencies: data.dependencies || { items: [], notes: [] } });
  const repoPathOf = (row) => {
    const project = state.projects.find((entry) => entry.prefix === state.prefix);
    const repo = project && project.repos.find((entry) => same(entry.name, row.repo));
    return repo ? repo.path : '';
  };

  function paintHead() {
    const summary = rowSummary(state.curId);
    if (!summary) return;
    const row = state.open && state.open.id === summary.id ? { ...summary, ...state.open } : summary;
    $('rid').textContent = row.id;
    const pill = $('rst');
    pill.className = `st ${tone(row.status)}`;
    pill.firstChild.textContent = row.status;
    $('rmeta').textContent = `${row.type} · ${row.repo || 'no repo'}`;
    paintBranch(row);
    paintTitle(row);

    const wi = clear($('rwi'));
    wi.appendChild(document.createTextNode('Azure DevOps: '));
    if (row.work_item) wi.appendChild(anchor(`work item #${row.work_item.id} ↗`, row.work_item.url));
    else wi.appendChild(h('span', '', row.parent_id ? 'not created yet. Handoff creates it under its Feature.' : 'no work item'));

    paintFeature(row);
    const rv = $('rv');
    const left = queue().length;
    rv.hidden = !state.review;
    rv.textContent = `Review mode · ${plural(left, `${defaultStatus()} plan`)} left, oldest first`;
    const approveButton = clear($('approve'));
    approveButton.appendChild(document.createTextNode('Approve & next '));
    approveButton.appendChild(h('kbd', '', 'a'));
    approveButton.disabled = !canApprove(row.status);
    buildMenu(row);
  }

  // Swaps `box` for an input: Enter saves a changed value (an empty one only with allowEmpty),
  // Escape or leaving the input puts the text back. restore draws the box's part of the row again.
  function inlineEdit(box, current, { allowEmpty = false, maxLength = 0, placeholder = '' }, save, restore = paintHead) {
    const input = h('input');
    input.value = current;
    input.placeholder = placeholder;
    if (maxLength) input.maxLength = maxLength;
    clear(box).appendChild(input);
    input.focus();
    const commit = async () => {
      const value = input.value.trim();
      if ((value || allowEmpty) && value !== current) await save(value);
      restore();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); commit(); }
      if (event.key === 'Escape') { event.stopPropagation(); restore(); }
    });
    input.addEventListener('blur', () => restore());
  }

  const isBug = (row) => String(row.type).toLowerCase() === 'bug';

  // A Bug is planned and implemented from its Base branch. Triage asks the user to
  // confirm it; changing it here and setting Re-triage is the answer. Any other row
  // has its Base branch in a section of the Plan tab (baseBranchSection).
  function paintBranch(row) {
    if (!isBug(row)) return;
    const meta = $('rmeta');
    meta.appendChild(document.createTextNode(` · ${row.base_branch ? `planned from branch ${row.base_branch}` : 'no base branch yet'} `));
    const edit = h('button', 'link-btn', 'Edit branch');
    edit.type = 'button';
    edit.addEventListener('click', () => inlineEdit(meta, row.base_branch || '', { allowEmpty: true, placeholder: 'branch name' }, (value) => patch(row.id, { base_branch: value })));
    meta.appendChild(edit);
  }

  function paintTitle(row) {
    const title = clear($('rtitle'));
    title.appendChild(document.createTextNode(row.title));
    if (!row.work_item) {
      title.appendChild(document.createTextNode(' '));
      const edit = h('button', 'link-btn', 'Edit title');
      edit.type = 'button';
      edit.addEventListener('click', () => inlineEdit(title, row.title, { maxLength: state.titleMax }, (value) => patch(row.id, { title: value })));
      title.appendChild(edit);
    }
  }

  function paintFeature(row) {
    const box = clear($('rfeat'));
    if (!row.parent_id) return;
    const siblings = state.rows.filter((other) => other.parent_id === row.parent_id).sort((a, b) => numberOf(a) - numberOf(b));
    const part = state.open && state.open.id === row.id && state.open.spec && state.open.spec.part;
    if (siblings.length < 2 && !part) return;
    const card = box.appendChild(h('div', 'feat'));
    const line = card.appendChild(h('div', 't'));
    line.appendChild(document.createTextNode(part ? `Part ${part} of parent ` : 'Parent '));
    line.appendChild(h('b', '', `#${row.parent_id}`));
    const list = card.appendChild(h('div', 'sib'));
    for (const other of siblings.slice(0, 12)) {
      const button = h('button', other.id === row.id ? 'me' : '', `${other.id} · ${other.title} · ${other.status}`);
      button.type = 'button';
      button.addEventListener('click', () => openRow(other.id, { review: state.review }));
      list.appendChild(button);
    }
    if (siblings.length > 12) list.appendChild(h('span', 'count', `and ${siblings.length - 12} more`));
  }

  function buildMenu(row) {
    const menu = clear($('menu'));
    const add = (text, cls, action) => {
      const button = h('button', cls, text);
      button.type = 'button';
      button.addEventListener('click', () => { closeMenu(); action(); });
      menu.appendChild(button);
    };
    menu.appendChild(h('div', 'lbl', 'Move to'));
    for (const status of state.items.statuses) if (!same(status, row.status)) add(status, '', () => patch(row.id, { status }));
    const project = state.projects.find((entry) => entry.prefix === state.prefix);
    if (project && project.repos.length) {
      menu.appendChild(h('div', 'sep'));
      menu.appendChild(h('div', 'lbl', 'Repo'));
      for (const repo of project.repos) if (repo.name !== row.repo) add(repo.name, '', () => patch(row.id, { repo: repo.name }));
      if (row.repo) add('No repo', '', () => patch(row.id, { repo: '' }));
    }
    menu.appendChild(h('div', 'sep'));
    add('Delete row…', 'danger', () => removeRow(row));
  }

  const closeMenu = () => $('menu').classList.remove('on');

  function showTab(name) {
    for (const button of $('dtabs').children) button.classList.toggle('on', button.dataset.p === name);
    for (const pane of document.querySelectorAll('.pane')) pane.classList.toggle('on', pane.id === name);
    if (name === 'rtl') loadRowTimeline();
  }

  async function openRow(id, { review }) {
    state.review = review;
    state.curId = id;
    state.showCur = true;
    state.open = null;
    markCurrent();
    const token = ++state.openToken;
    $('drawer').classList.add('on');
    $('scrim').classList.add('on');
    $('drawer').setAttribute('aria-hidden', 'false');
    $('drawer').focus();
    paintHead();
    for (const pane of ['plan', 'qa', 'log', 'rtl']) clear($(pane)).appendChild(h('p', 'muted-line', 'Loading…'));
    state.timelineFor = null;
    try {
      const data = await api('GET', `/api/rows/${encodeURIComponent(id)}`);
      if (token !== state.openToken) return;
      state.open = opened(data);
      renderOpen();
    } catch (err) {
      if (token === state.openToken) toast(err.message, true);
    }
  }

  function closeRow() {
    const hadFocus = $('drawer').contains(document.activeElement);
    state.openToken++;
    state.open = null;
    state.review = false;
    closeMenu();
    $('drawer').classList.remove('on');
    $('scrim').classList.remove('on');
    $('drawer').setAttribute('aria-hidden', 'true');
    // Back to the table, where the row that was open is still marked, so the keys go on from it.
    if (hadFocus && state.view === 'table') $('tablewrap').focus({ preventScroll: true });
  }

  function renderOpen() {
    paintHead();
    renderPlan();
    renderQuestions();
    renderLog();
    state.timelineFor = null;
    clear($('rtl'));
    if ($('rtl').classList.contains('on')) loadRowTimeline();
  }

  // --- plan and spec -----------------------------------------------------------------

  function section(row, group, def, ctx) {
    const value = row[group][def.key];
    const empty = def.kind === 'text' ? !String(value || '').trim() : !Array.isArray(value) || value.length === 0;
    if (empty) return null;
    const box = h('div', 'sec');
    const heading = box.appendChild(h('h3', '', def.title));
    const editable = group === 'plan' || !row.work_item;
    const body = box.appendChild(h('div'));
    const show = () => {
      clear(body);
      if (def.kind === 'text') {
        blocks(body, value, ctx);
      } else {
        const list = body.appendChild(h(def.kind === 'olist' ? 'ol' : 'ul'));
        for (const item of value) inline(list.appendChild(h('li')), item, def.links ? ctx : null);
      }
    };
    show();
    if (editable) {
      const edit = h('button', 'link-btn', 'Edit');
      edit.type = 'button';
      edit.addEventListener('click', () => {
        const area = h('textarea');
        area.value = def.kind === 'text' ? value : value.join('\n');
        area.rows = Math.min(14, Math.max(4, area.value.split('\n').length + 1));
        const error = h('div', 'err');
        const save = h('button', 'btn primary', 'Save');
        const cancel = h('button', 'btn', 'Cancel');
        save.type = cancel.type = 'button';
        const send = async () => {
          const next = def.kind === 'text' ? area.value : area.value.split('\n').map((line) => line.trim()).filter(Boolean);
          error.textContent = '';
          await patch(row.id, { [group]: { [def.key]: next } }, error);
        };
        save.addEventListener('click', send);
        cancel.addEventListener('click', () => { heading.appendChild(edit); show(); });
        area.addEventListener('keydown', (event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); send(); }
        });
        clear(body).appendChild(area);
        const actions = body.appendChild(h('div', 'edit-row'));
        actions.append(save, cancel);
        body.appendChild(error);
        edit.remove();
        area.focus();
      });
      heading.appendChild(edit);
    }
    return box;
  }

  function feedbackSection(row) {
    const box = h('div', 'sec');
    const heading = box.appendChild(h('h3', '', 'Feedback'));
    const hint = heading.appendChild(h('span', 'count'));
    hint.append(h('kbd', '', 'f'), document.createTextNode(' · '), h('kbd', '', 'Ctrl'), document.createTextNode('+'), h('kbd', '', 'Enter'), document.createTextNode(' saves'));
    const area = box.appendChild(h('textarea'));
    area.id = 'feedback';
    area.value = row.feedback || '';
    area.placeholder = 'What should change in this plan?';
    const error = h('div', 'err');
    const save = h('button', 'btn', 'Save feedback');
    save.type = 'button';
    const send = async () => {
      error.textContent = '';
      if (await patch(row.id, { feedback: area.value }, error)) toast('Feedback saved');
    };
    save.addEventListener('click', send);
    area.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); send(); }
    });
    box.appendChild(h('div', 'edit-row')).appendChild(save);
    box.appendChild(error);
    return box;
  }

  // The plan's open questions, then the ones answered earlier, each with its
  // ID (Q1, Q2…). The server gives every question and answer an ID.
  function questionsOf(row) {
    const current = row.plan && Array.isArray(row.plan.questions) ? row.plan.questions : [];
    const earlier = (row.answers || []).filter((entry) => !current.some((asked) => asked.id === entry.id)).map((entry) => ({ id: entry.id, text: entry.question }));
    return { current, earlier };
  }

  // The Questions tab: every question with its answer. They can be answered
  // only while the row waits for them (Needs info); otherwise they are read-only.
  function renderQuestions() {
    const row = state.open;
    const pane = clear($('qa'));
    const { current, earlier } = questionsOf(row);
    $('tab-qa').textContent = current.length + earlier.length ? `Questions (${current.length + earlier.length})` : 'Questions';
    if (!current.length && !earlier.length) {
      pane.appendChild(h('div', 'sec')).appendChild(h('p', 'muted-line', 'No questions on this row.'));
      return;
    }
    const open = roleOf(row.status) === 'needs_info_status';
    const known = (id) => (row.answers || []).find((entry) => entry.id === id);
    const box = pane.appendChild(h('div', 'sec'));
    box.appendChild(h('p', 'muted-line', open
      ? 'Answer what you can, save, then set the row to Re-triage.'
      : `Read-only: questions can be answered while the row is ${state.items.needs_info_status}.`));
    const areas = [];
    const item = (question) => {
      const entry = box.appendChild(h('div', 'qa-item'));
      inline(entry.appendChild(h('p')), `${question.id}. ${question.text}`, null);
      const area = entry.appendChild(h('textarea'));
      area.placeholder = open ? 'Your answer' : 'No answer';
      area.value = known(question.id) ? known(question.id).answer : '';
      area.disabled = !open;
      areas.push([question, area]);
    };
    current.forEach(item);
    if (earlier.length) {
      box.appendChild(h('h3', '', 'Answered'));
      earlier.forEach(item);
    }
    if (!open) return;
    const error = h('div', 'err');
    const save = h('button', 'btn', 'Save answers');
    save.type = 'button';
    const send = async () => {
      error.textContent = '';
      // Every answer is sent, the earlier ones too: the row keeps only what it gets.
      const answers = areas.filter(([, area]) => area.value.trim()).map(([question, area]) => ({ id: question.id, question: question.text, answer: area.value }));
      if (await patch(row.id, { answers }, error)) toast('Answers saved');
    };
    save.addEventListener('click', send);
    for (const [, area] of areas) {
      area.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); send(); }
      });
    }
    box.appendChild(h('div', 'edit-row')).appendChild(save);
    box.appendChild(error);
  }

  function renderPlan() {
    const row = state.open;
    const pane = clear($('plan'));
    const ctx = { repoPath: repoPathOf(row) };
    const asked = questionsOf(row).current.length;
    if (asked) {
      const note = pane.appendChild(h('div', 'sec qa-note'));
      const link = note.appendChild(h('button', 'link-btn', `${plural(asked, 'question')} for you in the Questions tab`));
      link.type = 'button';
      link.addEventListener('click', () => showTab('qa'));
    }
    pane.appendChild(feedbackSection(row));
    const parts = [];
    if (row.plan) for (const def of PLAN_SECTIONS) parts.push(section(row, 'plan', def, ctx));
    const textOf = SPEC_SECTIONS.find((def) => def.key === 'depends_on');
    if (row.spec) {
      for (const def of SPEC_SECTIONS) if (def !== textOf) parts.push(section(row, 'spec', def, ctx));
    }
    for (const part of parts) if (part) pane.appendChild(part);
    if (!row.plan && !row.spec) pane.appendChild(h('div', 'sec')).appendChild(h('p', 'muted-line', 'This row has no plan yet.'));
    // Depends on, then the Base branch, last. The rows are chips. The planner's own text is not
    // shown: the chips say which rows, and the text still goes to the work item and the developer.
    const depends = h('div', 'sec');
    depends.appendChild(h('h3', '', textOf.title));
    dependsOn(row, depends);
    pane.appendChild(depends);
    const base = baseBranchSection(row);
    if (base) pane.appendChild(base);
  }

  // --- the rows this row depends on --------------------------------------------------

  // The statuses a row has before its work starts. Only then do its Base branch and the rows it
  // depends on still decide where implement starts it, so only then can they be changed here.
  const BEFORE_WORK = ['default_status', 'needs_info_status', 'retriage_status', 'approved_status'];
  const notStarted = (row) => BEFORE_WORK.includes(roleOf(row.status));

  // The dependencies of the open row: a picker to add a row of the same project by its ID, then a
  // chip for each row it depends on (click to open it, × to remove it), and what could not be
  // matched to a row. Once the row's work has started the chips only open their row: nothing is
  // added or removed. `box` is the section they go in, under its heading.
  function dependsOn(row, box) {
    const found = row.dependencies || { items: [], notes: [] };
    const editable = notStarted(row);
    const wrap = h('div', 'deps');
    const error = h('div', 'err');
    const chips = wrap.appendChild(h('div', 'chips'));
    for (const item of found.items) {
      const chip = chips.appendChild(h('span', 'chip still dep'));
      const open = chip.appendChild(h('button', 'link-btn', `${item.row_id} · ${item.title}`));
      open.type = 'button';
      open.title = `${item.status}${item.work_item ? ` · work item #${item.work_item}` : ''}${item.from === 'row' ? '' : ' · Predecessor in Azure DevOps'}`;
      open.addEventListener('click', () => openRow(item.row_id, { review: false }));
      if (!editable) continue;
      const remove = chip.appendChild(h('button', 'link-btn', '×'));
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${item.row_id}`);
      remove.title = 'Remove this dependency from the board. A link in Azure DevOps stays until you remove it there.';
      remove.addEventListener('click', () => {
        // The chip came from the row list, from the Predecessor links, or from both: take it out of each.
        const body = {};
        if (item.from !== 'ado') body.depends_on_rows = (row.depends_on_rows || []).filter((id) => id !== item.row_id);
        if (item.from !== 'row') body.predecessors = (row.predecessors || []).filter((number) => Number(number) !== item.work_item);
        error.textContent = '';
        patch(row.id, body, error);
      });
    }
    if (!found.items.length) chips.appendChild(h('span', 'count', 'No row.'));
    for (const note of found.notes) wrap.appendChild(h('p', 'muted-line', note));
    if (!editable) {
      wrap.appendChild(h('p', 'muted-line', "It can't be changed now: the row's work has started."));
      box.insertBefore(wrap, box.children[1] || null);
      return;
    }

    // The picker: type a row ID, then pick one of the rows it finds.
    const picker = h('div', 'dep-pick');
    const input = picker.appendChild(h('input'));
    input.type = 'search';
    input.placeholder = 'Add a row: its ID';
    input.setAttribute('aria-label', 'Add a row this one depends on, by its ID');
    const results = picker.appendChild(h('div', 'sib'));
    const taken = new Set([row.id, ...found.items.map((item) => item.row_id)]);
    input.addEventListener('input', () => {
      clear(results);
      const q = input.value.trim().toLowerCase();
      if (!q) return;
      const hits = state.rows.filter((other) => !taken.has(other.id) && other.id.toLowerCase().includes(q));
      for (const other of hits.slice(0, 8)) {
        const button = results.appendChild(h('button', '', `${other.id} · ${other.title} · ${other.status}`));
        button.type = 'button';
        button.addEventListener('click', () => {
          error.textContent = '';
          patch(row.id, { depends_on_rows: [...(row.depends_on_rows || []), other.id] }, error);
        });
      }
      if (!hits.length) results.appendChild(h('span', 'count', 'No row matches.'));
      else if (hits.length > 8) results.appendChild(h('span', 'count', `and ${hits.length - 8} more: type more to narrow it`));
    });
    wrap.insertBefore(picker, chips);
    wrap.appendChild(error);
    box.insertBefore(wrap, box.children[1] || null);
  }

  // The Base branch of a row that is not a Bug, in its own section: the branch implement starts
  // the row from, when the user sets one. It wins over the rows the row depends on, and it is how
  // the user picks when those rows are on several branches.
  function baseBranchSection(row) {
    if (isBug(row)) return null;
    const box = h('div', 'sec');
    box.appendChild(h('h3', '', 'Base branch'));
    const line = box.appendChild(h('p', 'base-line'));
    const open = notStarted(row);
    line.appendChild(row.base_branch ? h('code', '', row.base_branch) : document.createTextNode('Not set'));
    if (open) {
      line.appendChild(document.createTextNode(' '));
      const edit = line.appendChild(h('button', 'link-btn', row.base_branch ? 'Edit branch' : 'Set a branch'));
      edit.type = 'button';
      edit.title = 'The branch this row is built on. Clear it to let the rows it depends on decide.';
      edit.addEventListener('click', () => inlineEdit(line, row.base_branch || '', { allowEmpty: true, placeholder: 'branch name' }, (value) => patch(row.id, { base_branch: value }), renderPlan));
    }
    const note = open
      ? (row.base_branch ? 'Implement starts this row from it, whatever the row depends on.' : 'Implement starts this row from the main branch, or from the branch of a row it depends on.')
      : `${row.base_branch ? "This row's branch started from it. " : ''}It can't be changed now: the row's work has started.`;
    box.appendChild(h('p', 'muted-line', note));
    return box;
  }

  function renderLog() {
    const row = state.open;
    const pane = clear($('log'));
    const box = pane.appendChild(h('div', 'sec'));
    // A merge running now has this row: how far it is.
    if (row.merge_progress) box.appendChild(h('p', 'muted-line', `${row.merge_progress}.`));
    // The facts of the row's code, first: its branch, and the integration branch of a Merged row.
    const facts = h('dl', 'facts');
    const fact = (name) => {
      facts.appendChild(h('dt', '', name));
      return facts.appendChild(h('dd'));
    };
    // The branch implement made. Rows that depend on this one start from it, so a wrong name can be corrected.
    if (row.branch || ['implemented_status', 'merged_status'].includes(roleOf(row.status))) {
      const line = fact('Branch');
      line.appendChild(row.branch ? h('code', '', row.branch) : document.createTextNode('none'));
      line.appendChild(document.createTextNode(' '));
      const edit = h('button', 'link-btn', 'Correct branch');
      edit.type = 'button';
      edit.title = 'Change this only when the name is wrong. Rows that depend on this one start from this branch.';
      edit.addEventListener('click', () => inlineEdit(line, row.branch || '', { allowEmpty: true, placeholder: 'branch name' }, (value) => patch(row.id, { branch: value }), renderLog));
      line.appendChild(edit);
    }
    // A Merged row is also in an integration branch. Its own branch may be deleted.
    if (row.merged_into && roleOf(row.status) === 'merged_status') fact('Merged into').appendChild(h('code', '', row.merged_into));
    if (facts.children.length) box.appendChild(facts);
    // The log, with where the work stands ("Done: …") right under its heading.
    if (row.implement_log) {
      const log = blocks(box.appendChild(h('div', 'implement-log')), row.implement_log, { repoPath: repoPathOf(row) });
      if (row.progress) {
        const heading = log.querySelector('h4');
        const where = h('p', 'progress-line', row.progress);
        if (heading) heading.after(where);
        else log.prepend(where);
      }
    } else {
      if (row.progress) box.appendChild(h('p', 'progress-line', row.progress));
      box.appendChild(h('p', 'muted-line', 'No implementation run yet. After a run, its report shows here.'));
    }
  }

  // The row's timeline: its history as pins on a line, newest at the top, a heading per day, and a
  // chip where more than a day passed between two events. Fetched on first open.
  async function loadRowTimeline() {
    const id = state.curId;
    if (!id || state.timelineFor === id) return;
    state.timelineFor = id;
    const pane = clear($('rtl'));
    pane.appendChild(h('p', 'muted-line', 'Loading…'));
    let history;
    try {
      history = (await api('GET', `/api/rows/${encodeURIComponent(id)}/history`)).history;
    } catch (err) {
      if (state.curId !== id) return;
      state.timelineFor = null;
      clear(pane).appendChild(h('p', 'err', err.message));
      return;
    }
    if (state.curId !== id) return;
    clear(pane);
    if (!history.length) {
      pane.appendChild(h('p', 'muted-line', 'No events yet.'));
      return;
    }
    const head = pane.appendChild(h('div', 'rtl-head'));
    const facts = head.appendChild(h('div', 'rtl-facts'));
    facts.append(h('span', '', 'First'), dateChip(history[0].at), h('span', '', 'Last'), dateChip(history[history.length - 1].at), h('b', '', plural(history.length, 'event')));
    const counts = new Map();
    for (const item of history) counts.set(item.kind, (counts.get(item.kind) || 0) + 1);
    const chips = head.appendChild(h('div', 'chips'));
    for (const [kind, count] of counts) {
      const chip = chips.appendChild(h('span', `chip still kc-${kind}`));
      chip.appendChild(h('i'));
      chip.appendChild(document.createTextNode(`${KIND_LABELS[kind] || kind} `));
      chip.appendChild(h('small', '', String(count)));
    }

    const path = pane.appendChild(h('ol', 'path'));
    let day = '';
    let newer = null;
    for (const item of history.slice().reverse()) {
      const gap = newer ? Date.parse(newer.at) - Date.parse(item.at) : 0;
      if (gap > DAY_MS) path.appendChild(h('li', 'path-gap')).appendChild(h('span', 'gap', `↑ ${plural(Math.floor(gap / DAY_MS), 'day')} later`));
      const key = dayKey(new Date(item.at));
      if (key !== day) {
        day = key;
        path.appendChild(h('li', 'path-day', dayTitle(key)));
      }
      const entry = path.appendChild(h('li', `path-ev kc-${item.kind}`));
      entry.appendChild(h('span', 'pin')).appendChild(kindIcon(item.kind));
      entry.appendChild(eventCard({ ...item, id }, { showRow: false }));
      newer = item;
    }
  }

  // --- actions -----------------------------------------------------------------------

  // Saves an edit. On failure it says why (in `where` when given, else a toast) and keeps what was typed.
  async function patch(id, body, where) {
    if (state.busy) return false;
    state.busy = true;
    try {
      const data = await api('PATCH', `/api/rows/${encodeURIComponent(id)}`, body);
      if (state.curId === id && state.open) state.open = opened(data);
      await loadRows();
      if (state.curId === id && state.open) {
        renderOpen();
      }
      return true;
    } catch (err) {
      if (where) where.textContent = err.message; else toast(err.message, true);
      return false;
    } finally {
      state.busy = false;
    }
  }

  async function approve(id, advance) {
    const row = rowSummary(id);
    if (!row || !canApprove(row.status)) return toast('This row can not be approved from its status', true);
    const next = advance ? queue().find((other) => other.id !== id) : null;
    if (!await patch(id, { status: state.items.approved_status })) return undefined;
    if (!advance) return toast(`Approved ${id}`);
    if (next) {
      toast(`Approved ${id}. Next: ${next.id}`);
      return openRow(next.id, { review: true });
    }
    closeRow();
    return toast(`Approved ${id}. Nothing left to review.`);
  }

  async function retriage(id) {
    const row = rowSummary(id);
    if (!row) return;
    const body = { status: state.items.retriage_status };
    const area = $('feedback');
    if (area && state.open && state.open.id === id && area.value !== (state.open.feedback || '')) body.feedback = area.value;
    if (await patch(id, body)) toast('Marked for re-triage. Run /spadework:re-triage to plan it again.');
  }

  async function removeRow(row) {
    if (!window.confirm(`Delete ${row.id}? Its plan and history are removed. The work item in Azure DevOps stays.`)) return;
    try {
      await api('DELETE', `/api/rows/${encodeURIComponent(row.id)}`);
      closeRow();
      await loadRows();
      toast(`${row.id} deleted`);
    } catch (err) {
      toast(err.message, true);
    }
  }

  // --- the other views ---------------------------------------------------------------

  const KIND_LABELS = {
    plan: 'Planned', status: 'Status', implement: 'Implement', work_item_changed: 'Changed in Azure DevOps',
    state_move: 'State move', handoff: 'Handoff', edit: 'Edited', merge: 'Merge',
  };

  function showView(name) {
    if (state.saveLayout) { state.saveLayout(); state.saveLayout = null; }
    if (state.leaveView) { state.leaveView(); state.leaveView = null; }
    state.view = name;
    // Nested parents are off each time the graph opens.
    if (name === 'graph') state.nested = false;
    for (const button of $('views').children) button.classList.toggle('on', button.dataset.view === name);
    $('app').hidden = name !== 'table';
    $('other').hidden = name === 'table';
    if (name !== 'table') renderOther();
    else {
      // A refresh while the table was hidden drew it with no height: only a few rows. Draw it again.
      drawTable(true);
      markCurrent();
    }
  }

  function renderOther() {
    if (state.saveLayout) { state.saveLayout(); state.saveLayout = null; }
    if (state.leaveView) { state.leaveView(); state.leaveView = null; }
    const box = clear($('other'));
    const token = ++state.viewToken;
    if (state.view === 'timeline') renderTimeline(box, token);
    else if (state.view === 'graph') renderGraph(box, token);
    else if (state.view === 'merge') renderMerge(box, token);
    else renderStats(box, token);
  }

  function pick(bar, label, options, current, onChange) {
    const select = bar.appendChild(h('select', 'sel-small'));
    select.setAttribute('aria-label', label);
    for (const [value, text] of options) {
      const option = h('option', '', text);
      option.value = String(value);
      select.appendChild(option);
    }
    select.value = String(current);
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  const SVG = 'http://www.w3.org/2000/svg';
  const DAY_MS = 86400000;
  // One small path per kind, drawn in currentColor (Unicode glyphs turn into colour emoji on some systems).
  const KIND_ICONS = {
    plan: 'M8 1.8l1.5 4.7 4.7 1.5-4.7 1.5L8 14.2l-1.5-4.7L1.8 8l4.7-1.5z',
    status: 'M2.5 8h10.5M9 4l4 4-4 4',
    implement: 'M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5',
    work_item_changed: 'M13.2 6.5A5.2 5.2 0 0 0 3.4 5.2M2.8 9.5a5.2 5.2 0 0 0 9.8 1.3M13.5 2.5v4h-4M2.5 13.5v-4h4',
    state_move: 'M2.5 5h10M10 2.5L12.5 5 10 7.5M13.5 11h-10M6 8.5L3.5 11 6 13.5',
    handoff: 'M8 10.5V2.5M4.5 6L8 2.5 11.5 6M2.5 10.5v3h11v-3',
    edit: 'M10.5 2.5l3 3L6 13H3v-3z',
    merge: 'M4.5 2v12M11.5 14V10C11.5 7 4.5 7.5 4.5 4.5',
    other: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5z',
  };

  function kindIcon(kind) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('class', 'kic');
    svg.setAttribute('aria-hidden', 'true');
    svg.appendChild(document.createElementNS(SVG, 'path')).setAttribute('d', KIND_ICONS[kind] || KIND_ICONS.other);
    return svg;
  }

  const fmtChip = (iso) => {
    const date = new Date(iso);
    return `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} · ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  };

  // A date chip (26 Oct · 14:02), with the full time and how long ago in its title.
  function dateChip(iso) {
    const chip = h('time', 'dchip', fmtChip(iso));
    chip.dateTime = iso;
    chip.title = `${new Date(iso).toLocaleString()} (${ago(iso)})`;
    return chip;
  }

  // A number with a label and a hint, as the Stats and Timeline views show them.
  function statTile(parent, n, label, hint) {
    const card = parent.appendChild(h('div', 'stat'));
    card.appendChild(h('span', 'n', n));
    card.appendChild(h('span', 'l', label)).className = 'l plain-label';
    card.appendChild(h('span', 'h', hint));
  }

  const dayKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

  function dayTitle(key) {
    const [y, m, d] = key.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (key === dayKey(today)) return 'Today';
    if (key === dayKey(yesterday)) return 'Yesterday';
    return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }

  function ago(iso) {
    const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
  }

  // One event as a card: what happened, to which row (unless showRow is false), when, and who did it.
  function eventCard(item, { showRow = true } = {}) {
    const card = h('div', `evc kc-${item.kind}`);
    card.appendChild(h('span', 'evc-ic')).appendChild(kindIcon(item.kind));
    const main = card.appendChild(h('div', 'evc-main'));
    const top = main.appendChild(h('div', 'evc-top'));
    top.appendChild(dateChip(item.at));
    top.appendChild(h('span', 'evc-kind', KIND_LABELS[item.kind] || item.kind));
    top.appendChild(h('span', `evc-by ${item.by === 'user' ? 'you' : 'bot'}`, item.by === 'user' ? 'You' : 'Spadework'));
    const body = main.appendChild(h('div', 'evc-body'));
    const move = item.kind === 'status' ? item.text.split(' → ') : null;
    if (move && move.length === 2) {
      body.appendChild(statusPill(move[0]));
      body.appendChild(h('span', 'evc-arrow', '→'));
      body.appendChild(statusPill(move[1]));
    } else {
      body.textContent = item.text;
    }
    if (!showRow) return card;
    const row = main.appendChild(h('div', 'evc-row'));
    const link = row.appendChild(h('button', 'link-btn id', item.id));
    link.type = 'button';
    link.addEventListener('click', () => openRow(item.id, { review: false }));
    row.appendChild(h('span', 'dim evtitle', item.title));
    return card;
  }

  const ALL_KINDS = Object.keys(KIND_LABELS);
  const LANE_H = 44;
  const AXIS_H = 30;
  const CLUSTER_PX = 10;
  const isoOf = (t) => new Date(t).toISOString();
  const sumOf = (counts) => Object.values(counts).reduce((sum, n) => sum + n, 0);
  const dayStart = (key, plus = 0) => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d + plus).getTime();
  };

  // A timeline request's query: the project, the kinds shown and who did it, plus `extra`.
  function timelineParams(extra) {
    const params = new URLSearchParams({ project: state.prefix, ...extra });
    if (state.hidden.size) params.set('kinds', ALL_KINDS.filter((kind) => !state.hidden.has(kind)).join(','));
    if (state.by) params.set('by', state.by);
    return params;
  }

  // The project's timeline. The filters, tiles and the overview strip come from the summary, which
  // counts every event; the events of the picked days come as Lanes (one per row) or as a List.
  async function renderTimeline(box, token) {
    const bar = box.appendChild(h('div', 'filters'));
    const chips = bar.appendChild(h('div', 'chips'));
    bar.appendChild(h('span', 'spacer'));
    const modes = bar.appendChild(h('div', 'seg'));
    for (const [value, text] of [['lanes', 'Lanes'], ['list', 'List']]) {
      const button = modes.appendChild(h('button', state.tlMode === value ? 'on' : '', text));
      button.type = 'button';
      button.addEventListener('click', () => { state.tlMode = value; renderOther(); });
    }
    if (state.tlMode === 'lanes') pick(bar, 'Order', [['latest', 'Latest activity'], ['feature', 'Group by parent']], state.laneOrder, (value) => { state.laneOrder = value; renderOther(); });
    const body = box.appendChild(h('div', 'viewbody'));
    body.appendChild(h('p', 'muted-line', 'Loading…'));
    // Days picked on the strip narrow the lanes to the rows with an event on them.
    const days = state.dayPick;
    const picked = days ? { from: dayStart(days.from), to: dayStart(days.to, 1) - 1 } : null;
    let data;
    try {
      data = await api('GET', `/api/timeline?${timelineParams({ days: state.days, ...(picked ? { from: isoOf(picked.from), to: isoOf(picked.to) } : {}) })}`);
    } catch (err) {
      if (token === state.viewToken) clear(body).appendChild(h('p', 'err', err.message));
      return;
    }
    if (token !== state.viewToken) return;
    const keys = data.days.map((day) => day.day);
    if (days && !(keys.includes(days.from) && keys.includes(days.to))) {
      // The picked days left the period (a new day began): ask again without them.
      state.dayPick = days.auto ? undefined : null;
      renderOther();
      return;
    }
    // Nothing picked yet, or the page picked it: open on the latest day with events (today, on
    // an active board), and move there when a newer day gets one. A day the user clicked stays,
    // and so does "Show all days" (null).
    if (days === undefined || days?.auto) {
      const latest = data.days.filter((day) => sumOf(day.counts)).pop();
      const next = latest ? { anchor: latest.day, from: latest.day, to: latest.day, auto: true } : null;
      if (days === undefined || (next && next.from !== days.from)) {
        state.dayPick = next;
        renderOther();
        return;
      }
    }
    clear(body);

    // Filters: one chip per kind that happened (a hidden one stays, to bring it back), and who did it.
    for (const kind of ALL_KINDS) {
      const count = data.kinds[kind] || 0;
      if (!count && !state.hidden.has(kind)) continue;
      const chip = chips.appendChild(h('button', `chip kc-${kind}${state.hidden.has(kind) ? ' off' : ''}`));
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(!state.hidden.has(kind)));
      chip.appendChild(h('i'));
      chip.appendChild(document.createTextNode(`${KIND_LABELS[kind]} `));
      chip.appendChild(h('small', '', String(count)));
      chip.addEventListener('click', () => { if (state.hidden.has(kind)) state.hidden.delete(kind); else state.hidden.add(kind); renderOther(); });
    }
    const who = chips.appendChild(h('div', 'seg who'));
    for (const [value, text] of [['', 'Everyone'], ['user', 'You'], ['spadework', 'Spadework']]) {
      const button = who.appendChild(h('button', state.by === value ? 'on' : '', text));
      button.type = 'button';
      button.addEventListener('click', () => { state.by = value; renderOther(); });
    }

    const tiles = body.appendChild(h('div', 'cards tight'));
    statTile(tiles, String(data.totals.events), 'Events', `last ${state.days} days`);
    statTile(tiles, String(data.totals.rows), 'Rows touched', 'with at least one event');
    statTile(tiles, String(data.totals.plans), 'Plans written', 'by triage');
    statTile(tiles, String(data.totals.by_user), 'Done by you', 'moves and edits');

    // The period sits right above the strip it sets, with the hint on how to pick days.
    const stripBar = body.appendChild(h('div', 'strip-bar'));
    stripBar.appendChild(h('span', 'strip-hint', 'Click a day to see it, Shift+click another for the days between'));
    stripBar.appendChild(h('span', 'spacer'));
    pick(stripBar, 'Days', [[7, 'Last 7 days'], [14, 'Last 14 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [365, 'Last 365 days']], state.days, (value) => { state.days = Number(value); state.dayPick = undefined; renderOther(); });
    drawStrip(body, data.days);
    if (!data.totals.events) {
      body.appendChild(h('p', 'muted-line', sumOf(data.kinds) || state.by ? 'No events match these filters.' : 'No events in this period yet. Plans, approvals and implement runs show up here as they happen.'));
      return;
    }
    const range = {
      from: picked ? picked.from : Date.parse(data.from),
      to: picked ? Math.min(Date.parse(data.to), picked.to) : Date.parse(data.to),
    };

    // The events of the lanes already fetched, kept for these filters. A refresh or refocus keeps
    // them, but drops each lane whose count or newest event changed.
    const key = [state.prefix, state.days, [...state.hidden].sort().join(','), state.by, days ? `${days.from}~${days.to}` : ''].join('|');
    const seen = new Map(data.lanes.map((lane) => [lane.id, `${lane.count}|${lane.last_at}`]));
    if (!state.tl || state.tl.key !== key) {
      state.tl = { key, lanes: new Map(), seen, gen: 0, scroll: 0 };
    } else {
      for (const [id, mark] of seen) if (state.tl.seen.get(id) !== mark) state.tl.lanes.delete(id);
      state.tl.seen = seen;
      state.tl.gen += 1;
    }

    if (state.tlMode === 'list') {
      drawList(body, token, range, new Map(data.days.map((day) => [day.day, sumOf(day.counts)])));
      return;
    }
    if (!data.lanes.length) body.appendChild(h('p', 'muted-line', 'No events on these days.'));
    else drawLanes(body, data.lanes, range);
  }

  // The overview strip: a column a day, stacked by kind. A click narrows the view to that day,
  // Shift+click to the days between it and the first, and a click on the picked day clears it.
  function drawStrip(body, days) {
    const peak = Math.max(1, ...days.map((day) => sumOf(day.counts)));
    const river = body.appendChild(h('div', `river${days.length > 120 ? ' dense' : ''}`));
    const step = Math.ceil(days.length / 14);
    const picked = state.dayPick;
    days.forEach(({ day: key, counts }, index) => {
      const on = Boolean(picked) && key >= picked.from && key <= picked.to;
      const column = river.appendChild(h('button', `rv-day${on ? ' on' : ''}`));
      column.type = 'button';
      column.setAttribute('aria-pressed', String(on));
      column.title = `${dayTitle(key)}: ${plural(sumOf(counts), 'event')}`;
      const stack = column.appendChild(h('span', 'rv-stack'));
      for (const [kind, count] of Object.entries(counts)) stack.appendChild(h('span', `rv-seg kc-${kind}`)).style.height = `${(count / peak) * 100}%`;
      column.appendChild(h('span', 'rv-label', index % step === 0 ? (days.length > 31 ? fmtDay(isoOf(dayStart(key))) : key.slice(8)) : ''));
      column.addEventListener('click', (event) => {
        if (event.shiftKey && picked) {
          const [from, to] = [picked.anchor, key].sort();
          state.dayPick = { anchor: picked.anchor, from, to };
        } else {
          state.dayPick = picked && picked.from === key && picked.to === key ? null : { anchor: key, from: key, to: key };
        }
        renderOther();
      });
    });
    const note = body.appendChild(h('div', 'strip-note'));
    if (!picked) {
      note.textContent = 'Showing every day of the period.';
      return;
    }
    note.appendChild(document.createTextNode(`Showing ${picked.from === picked.to ? dayTitle(picked.from) : `${dayTitle(picked.from)} to ${dayTitle(picked.to)}`} · `));
    const all = note.appendChild(h('button', 'link-btn', 'Show all days'));
    all.type = 'button';
    all.addEventListener('click', () => { state.dayPick = null; renderOther(); });
  }

  // List: the events a day at a time, newest first, 200 a page. "Load older", or scrolling to it,
  // asks for the next page. A refresh, a refocus or a filter change starts again from the newest.
  function drawList(body, token, range, perDay) {
    const list = body.appendChild(h('div', 'tl-list'));
    const more = body.appendChild(h('button', 'btn more', 'Load older'));
    more.type = 'button';
    let next = '';
    let loading = false;
    let day = '';
    let feed = null;
    async function load() {
      if (loading || next === null) return;
      loading = true;
      more.disabled = true;
      more.textContent = 'Loading…';
      let ok = false;
      try {
        const params = timelineParams({ from: isoOf(range.from), to: isoOf(range.to), limit: 200 });
        if (next) params.set('before', next);
        const data = await api('GET', `/api/timeline/events?${params}`);
        if (token !== state.viewToken) return;
        for (const item of data.events) {
          const key = dayKey(new Date(item.at));
          if (key !== day) {
            day = key;
            const head = list.appendChild(h('h3', 'day dayhead', dayTitle(key)));
            head.appendChild(h('small', '', plural(perDay.get(key) || 0, 'event')));
            feed = list.appendChild(h('div', 'feed'));
          }
          feed.appendChild(eventCard(item));
        }
        next = data.next;
        ok = true;
      } catch (err) {
        toast(err.message, true);
      } finally {
        loading = false;
        more.disabled = false;
        more.textContent = 'Load older';
        more.hidden = next === null;
      }
      // A short page leaves the button on screen, where the observer won't see it come in.
      if (ok && next !== null && more.getBoundingClientRect().top < window.innerHeight + 400) load();
    }
    more.addEventListener('click', load);
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) load();
    }, { rootMargin: '400px' });
    observer.observe(more);
    state.leaveView = () => observer.disconnect();
    load();
  }

  // The lanes in the chosen order. Grouped by Feature, each Feature has a heading, named as the graph names it.
  function laneEntries(lanes) {
    if (state.laneOrder !== 'feature') return lanes.map((lane) => ({ lane }));
    const groups = new Map();
    for (const lane of lanes) {
      const key = Number(lane.parent_id) || 0;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(lane);
    }
    const byItem = new Map(state.rows.filter((row) => row.work_item).map((row) => [row.work_item.id, row]));
    const entries = [];
    for (const key of [...groups.keys()].sort((a, b) => (a === 0) - (b === 0) || a - b)) {
      const feature = byItem.get(key);
      entries.push({ head: !key ? 'No parent' : feature ? `${key} · ${feature.id}` : `Parent #${key}`, title: feature ? feature.title : '', count: groups.get(key).length });
      for (const lane of groups.get(key)) entries.push({ lane });
    }
    return entries;
  }

  // A lane's events as pin groups, oldest first: events closer than CLUSTER_PX on the track merge.
  function clusters(events, xOf) {
    const points = events.map((item) => ({ item, x: xOf(Date.parse(item.at)) })).sort((a, b) => a.x - b.x);
    const groups = [];
    for (const { item, x } of points) {
      const last = groups[groups.length - 1];
      if (last && x - last.x0 < CLUSTER_PX) {
        last.items.push(item);
        last.x1 = x;
      } else {
        groups.push({ x0: x, x1: x, items: [item] });
      }
    }
    return groups;
  }

  // Lanes: one per row with events in the range, its pins placed by time on a shared axis. Only the
  // lanes on screen are in the page, and the events of those not fetched yet are asked for in one
  // request when the scrolling stops.
  function drawLanes(body, lanes, range) {
    const cache = state.tl;
    const gen = cache.gen;
    const entries = laneEntries(lanes);
    const box = body.appendChild(h('div', 'lanes'));
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', 'Lanes: a line per row, its events placed by time');
    const axis = box.appendChild(h('div', 'lanes-axis'));
    axis.appendChild(h('span', 'lanes-corner', plural(lanes.length, 'row')));
    const track = axis.appendChild(h('div', 'axis-track'));
    const span = Math.max(1, range.to - range.from);
    for (let i = 0; i <= 5; i++) {
      const t = range.from + (span * i) / 5;
      track.appendChild(h('span', 'axis-tick', span < 2 * DAY_MS ? fmtTime(isoOf(t)) : fmtDay(isoOf(t)))).style.left = `${i * 20}%`;
    }
    const rows = box.appendChild(h('div', 'lanes-body'));
    const pop = box.appendChild(h('div', 'lane-pop'));
    pop.hidden = true;
    const pending = new Set();
    let trackW = 1;
    const xOf = (t) => ((t - range.from) / span) * trackW;

    function hidePop() { pop.hidden = true; }
    function showPop(lane, index, items) {
      clear(pop);
      const top = pop.appendChild(h('div', 'pop-top'));
      top.append(h('span', 'id', lane.id), h('span', 'dim evtitle', lane.title), h('span', 'spacer'));
      const close = top.appendChild(h('button', 'link-btn', 'Close'));
      close.type = 'button';
      close.addEventListener('click', hidePop);
      for (const item of items.slice().reverse()) pop.appendChild(eventCard(item, { showRow: false }));
      pop.style.top = `${AXIS_H + (index + 1) * LANE_H}px`;
      pop.hidden = false;
    }
    box.addEventListener('click', (event) => { if (!pop.hidden && !pop.contains(event.target)) hidePop(); });
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !pop.hidden) { event.stopPropagation(); hidePop(); }
    });

    function pinFor(lane, index, group) {
      const items = group.items;
      const kind = items.every((item) => item.kind === items[0].kind) ? items[0].kind : '';
      const pin = h('button', `pin${items.length > 1 ? ' cluster' : ''}${kind ? ` kc-${kind}` : ''}`);
      pin.type = 'button';
      pin.style.left = `${((group.x0 + group.x1) / 2 / trackW) * 100}%`;
      const label = items.length > 1
        ? `${items.length} events, ${fmtChip(items[0].at)} to ${fmtChip(items[items.length - 1].at)}`
        : `${KIND_LABELS[kind] || kind}: ${items[0].text}, ${fmtChip(items[0].at)}`;
      pin.setAttribute('aria-label', label);
      pin.title = label;
      if (items.length > 1) pin.textContent = items.length > 99 ? '99+' : String(items.length);
      else pin.appendChild(kindIcon(kind));
      pin.addEventListener('click', (event) => { event.stopPropagation(); showPop(lane, index, items); });
      return pin;
    }

    function laneElement(entry, index) {
      if (entry.head) {
        const head = h('div', 'lane-head', entry.head);
        if (entry.title) head.title = entry.title;
        head.appendChild(h('small', '', plural(entry.count, 'row')));
        return head;
      }
      const { lane } = entry;
      const element = h('div', 'lane');
      const name = element.appendChild(h('button', 'lane-name'));
      name.type = 'button';
      name.title = `${lane.id} · ${lane.title} · ${lane.status}`;
      name.append(h('span', 'id', lane.id), h('span', 'lane-title', lane.title));
      name.addEventListener('click', () => openRow(lane.id, { review: false }));
      const events = cache.lanes.get(lane.id);
      const line = element.appendChild(h('div', `lane-track${events ? '' : ' wait'}`));
      if (events) for (const group of clusters(events, xOf)) line.appendChild(pinFor(lane, index, group));
      return element;
    }

    const win = {
      scroller: () => box, body: () => rows, itemH: LANE_H, offset: () => AXIS_H, count: () => entries.length, range: null,
      item: (i) => laneElement(entries[i], i),
      spacer: (px) => {
        const gap = h('div', 'lane-spacer');
        gap.style.height = `${px}px`;
        return gap;
      },
    };
    const redraw = (force) => {
      trackW = Math.max(1, track.clientWidth);
      return drawWindow(win, force);
    };

    async function fetchVisible() {
      if (!box.isConnected || !win.range) return;
      const ids = entries.slice(win.range[0], win.range[1]).filter((entry) => entry.lane && !cache.lanes.has(entry.lane.id) && !pending.has(entry.lane.id)).map((entry) => entry.lane.id);
      for (let at = 0; at < ids.length; at += 200) {
        const chunk = ids.slice(at, at + 200);
        const got = new Map(chunk.map((id) => [id, []]));
        for (const id of chunk) pending.add(id);
        try {
          let next = '';
          do {
            const params = timelineParams({ from: isoOf(range.from), to: isoOf(range.to), ids: chunk.join(','), limit: 500 });
            if (next) params.set('before', next);
            const data = await api('GET', `/api/timeline/events?${params}`);
            for (const item of data.events) if (got.has(item.id)) got.get(item.id).push(item);
            next = data.next;
          } while (next);
        } catch (err) {
          if (box.isConnected) toast(err.message, true);
          return;
        } finally {
          for (const id of chunk) pending.delete(id);
        }
        // A refresh meanwhile may have dropped some of these lanes: then the answer is stale.
        if (state.tl !== cache || cache.gen !== gen) return;
        for (const [id, list] of got) cache.lanes.set(id, list);
        if (box.isConnected) redraw(true);
      }
    }

    let waiting = false;
    let timer = 0;
    const fetchSoon = () => {
      clearTimeout(timer);
      timer = setTimeout(fetchVisible, 100);
    };
    box.addEventListener('scroll', () => {
      cache.scroll = box.scrollTop;
      if (!waiting) {
        waiting = true;
        requestAnimationFrame(() => { waiting = false; redraw(false); });
      }
      fetchSoon();
    });
    const observer = new ResizeObserver(() => { if (redraw(true)) fetchSoon(); });
    observer.observe(box);
    state.leaveView = () => { observer.disconnect(); clearTimeout(timer); };
    redraw(true);
    box.scrollTop = cache.scroll;
    redraw(false);
    fetchVisible();
  }

  // --- the graph ---

  const EDGE_KINDS = [['parent', 'Parent'], ['related', 'Related'], ['depends', 'Depends on'], ['file', 'Same file']];


  // The graph is built only when the user asks, then kept on disk: this view
  // shows the saved one, and the button builds it again.
  async function renderGraph(box, token) {
    const bar = box.appendChild(h('div', 'filters'));
    pick(bar, 'Group by', [['feature', 'Group by parent'], ['repo', 'Group by repo']], state.group, (value) => { state.group = value; renderOther(); });
    pick(bar, 'Spacing', [['compact', 'Compact'], ['normal', 'Normal spacing'], ['wide', 'Wide spacing']], state.spacing, (value) => { state.spacing = value; renderOther(); });
    for (const [kind, label] of EDGE_KINDS) {
      const wrap = bar.appendChild(h('label', 'count'));
      const input = wrap.appendChild(h('input'));
      input.type = 'checkbox';
      input.checked = state.edges[kind];
      if (kind === 'parent' && state.group !== 'feature') input.disabled = true;
      wrap.appendChild(document.createTextNode(` ${label}`));
      input.addEventListener('change', () => { state.edges[kind] = input.checked; renderOther(); });
    }
    // Parents drawn inside their own parents: only when the rows are grouped by parent.
    const nestWrap = bar.appendChild(h('label', 'count'));
    const nest = nestWrap.appendChild(h('input'));
    nest.type = 'checkbox';
    nest.checked = state.nested && state.group === 'feature';
    nest.disabled = state.group !== 'feature';
    nestWrap.appendChild(document.createTextNode(' Nested parents'));
    nest.addEventListener('change', () => { state.nested = nest.checked; renderOther(); });
    bar.appendChild(h('span', 'spacer'));
    const note = bar.appendChild(h('span', 'count', 'Loading…'));
    const body = box.appendChild(h('div', 'viewbody'));
    let data;
    try {
      data = await api('GET', `/api/graph?project=${encodeURIComponent(state.prefix)}`);
    } catch (err) {
      if (token === state.viewToken) { note.textContent = ''; body.appendChild(h('p', 'err', err.message)); }
      return;
    }
    if (token !== state.viewToken) return;

    const button = bar.appendChild(h('button', 'iconbtn', data.built ? '↻ Rebuild' : 'Build graph'));
    button.type = 'button';
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = 'Building…';
      try {
        await api('POST', `/api/graph/build?project=${encodeURIComponent(state.prefix)}`);
      } catch (err) {
        toast(err.message, true);
      }
      if (token === state.viewToken) renderOther();
    });
    if (!data.built) {
      note.textContent = 'Not built yet';
      const text = body.appendChild(h('div', 'graphintro'));
      text.appendChild(h('p', '', 'The graph shows how this project\'s rows connect: parent work items and their rows, linked work items, rows that depend on each other, and plans that touch the same file.'));
      text.appendChild(h('p', 'muted-line', 'It is built from the rows only, with no model calls, and saved. Build it again when the rows change.'));
      return;
    }
    const graph = data.graph;
    note.textContent = `Built ${fmtTime(graph.built_at)}, ${plural(graph.row_count, 'row')}${data.changed ? `, ${data.changed} changed since` : ''}`;

    // Every row in the project, Done and Rejected too: the graph is its whole history.
    const known = new Map(graph.nodes.map((node) => [node.id, node]));
    const rows = graph.nodes.filter((node) => node.kind === 'row');
    if (!rows.length) { body.appendChild(h('p', 'muted-line', 'The project has no rows.')); return; }
    body.remove();
    state.mergeLit = await mergingRows();
    if (token !== state.viewToken) return;
    drawCluster(box, graph, known);
  }

  // The rows as clusters: each Feature (or repo) is a hub its rows gather around, a file two plans
  // name is a node the rows point to, and the other links are lines between them. The layout is a
  // small force simulation drawn on a canvas, so a project of thousands of rows stays smooth.
  const LIT_MAX = 60;
  const MAX_LABELS = 250;
  const TONE_COLORS = { 't-ready': '--accent', 't-approved': '--ok', 't-needs': '--warn', 't-blocked': '--bad', 't-progress': '--info', 't-merged': '--merged', 't-new': '--muted' };

  // How far apart the nodes are: a multiplier on the lengths of the layout.
  const SPACING = { compact: 1, normal: 1.5, wide: 2.4 };

  // The graph is drawn into a holder, so the Groups pane can draw it again without asking the helper.
  function drawCluster(box, graph, known) {
    const holder = box.appendChild(h('div', 'gholder'));
    const again = () => {
      if (state.saveLayout) { state.saveLayout(); state.saveLayout = null; }
      clear(holder);
      buildCluster(holder, graph, known, again);
    };
    buildCluster(holder, graph, known, again);
  }

  function buildCluster(box, graph, known, again) {
    const byFeature = state.group === 'feature';
    const nested = byFeature && Boolean(state.nested);
    const spread = SPACING[state.spacing] || SPACING.normal;

    // The groups, hidden or not: the Groups pane lists them all, and a hidden one has no nodes.
    const groupOf = (row) => {
      if (!byFeature) return { key: row.repo || 'none', label: row.repo || 'No repo' };
      const feature = row.feature && known.get(row.feature);
      return { key: row.feature || 'none', label: !feature ? 'No parent' : feature.kind === 'row' ? feature.label : `Parent ${feature.label}`, url: feature && feature.url };
    };
    const allGroups = new Map();
    for (const row of graph.nodes) {
      if (row.kind !== 'row') continue;
      const group = groupOf(row);
      if (!allGroups.has(group.key)) allGroups.set(group.key, { ...group, count: 0 });
      allGroups.get(group.key).count += 1;
    }
    const filterKey = `${state.prefix}|${state.group}`;
    if (state.groupFilter.for !== filterKey) state.groupFilter = { for: filterKey, hidden: new Set() };
    const hidden = state.groupFilter.hidden;

    const nodes = [];
    const links = [];
    const hubs = new Map();
    const add = (node) => { node.i = nodes.length; node.x = 0; node.y = 0; node.vx = 0; node.vy = 0; nodes.push(node); return node; };
    const byId = new Map();
    const hubFor = (key, label, url) => {
      if (!hubs.has(key)) hubs.set(key, add({ kind: 'hub', id: `hub:${key}`, key, label, size: 0, members: [], url }));
      return hubs.get(key);
    };
    const link = (a, b, kind, len) => links.push({ a, b, kind, len });

    // The rows, each tied to its hub.
    for (const row of graph.nodes) {
      if (row.kind !== 'row') continue;
      const group = groupOf(row);
      if (hidden.has(group.key)) continue;
      const hub = hubFor(group.key, group.label, group.url);
      hub.size += 1;
      const node = add({ kind: 'row', id: row.id, label: row.label, title: row.title, status: row.status, tone: tone(row.status), hub });
      hub.members.push(node);
      byId.set(row.id, node);
      link(hub, node, 'group', 0);
    }
    // A big group's rows do not sit on one ring around the hub, they fill a disc: the rest length stops growing at 60 rows.
    for (const l of links) l.len = (30 + 8 * Math.sqrt(Math.min(l.a.size, 60))) * spread;

    // Nested parents: a circle for every parent that has other parents in it. It holds their groups, and
    // its own group when it has rows of its own. A parent's own parent is its `up`: the chain is followed
    // by that alone, whatever the work item types are called, and a chain that loops is cut.
    const circles = new Map();
    if (nested) {
      const upOf = new Map();
      const reaches = (from, target) => {
        for (let at = from, n = 0; at && n < 50; at = upOf.get(at), n++) if (at === target) return true;
        return false;
      };
      for (const key of hubs.keys()) {
        for (let at = key, n = 0; n < 50; n++) {
          const up = (known.get(at) || {}).up;
          if (!up || upOf.has(at) || reaches(up, at)) break;
          upOf.set(at, up);
          at = up;
        }
      }
      for (const id of upOf.values()) {
        if (circles.has(id)) continue;
        const info = known.get(id) || { label: id };
        const name = info.kind === 'row' ? info.label : `${info.type || 'Parent'} ${info.label}`;
        circles.set(id, { id, label: info.title ? `${name} · ${info.title}` : name, leaves: [], level: 0, x: 0, y: 0, r: 0 });
      }
      // A group goes in the circle of its own parent when that parent has one, else in the one above
      // it, and in every circle around that one. `nest` keeps the groups of one circle side by side.
      for (const [key, hub] of hubs) {
        const path = [];
        for (let at = circles.has(key) ? key : upOf.get(key); at; at = upOf.get(at)) {
          const circle = circles.get(at);
          circle.leaves.push(hub);
          circle.level = Math.max(circle.level, path.length);
          path.unshift(at);
        }
        hub.nest = path.join('>');
      }
    }
    const circleList = [...circles.values()].sort((a, b) => a.level - b.level);
    // The pairs of circles with no group in common: neither is inside the other.
    const apart = [];
    for (let a = 0; a < circleList.length; a++) {
      for (let b = a + 1; b < circleList.length; b++) {
        if (!circleList[a].leaves.some((hub) => circleList[b].leaves.includes(hub))) apart.push([circleList[a], circleList[b]]);
      }
    }

    // Linked work items and shared files, and the lines between rows.
    const other = (id, kind) => {
      if (byId.has(id)) return byId.get(id);
      const info = known.get(id);
      if (!info || info.kind !== kind) return null;
      const node = add({ kind, id, label: info.label, title: info.title, url: info.url });
      byId.set(id, node);
      return node;
    };
    for (const edge of graph.edges) {
      if (!state.edges[edge.kind] || edge.kind === 'parent') continue;
      const from = byId.get(edge.from);
      if (!from) continue;
      const to = edge.kind === 'file' ? other(edge.to, 'file') : edge.kind === 'related' ? byId.get(edge.to) || other(edge.to, 'item') : byId.get(edge.to);
      if (to) link(from, to, edge.kind, (edge.kind === 'file' ? 50 : edge.kind === 'depends' ? 50 : 70) * spread);
    }

    // A file many rows name gets room for all of them, like a group does.
    const fileRows = new Map();
    for (const l of links) if (l.kind === 'file') fileRows.set(l.b.i, (fileRows.get(l.b.i) || 0) + 1);
    for (const l of links) if (l.kind === 'file') { l.len = (40 + 8 * Math.sqrt(fileRows.get(l.b.i))) * spread; l.b.size = fileRows.get(l.b.i); }

    for (const node of nodes) node.deg = 0;
    for (const l of links) { l.a.deg += 1; l.b.deg += 1; }

    const near = new Map(nodes.map((node) => [node.i, new Set([node.i])]));
    for (const l of links) { near.get(l.a.i).add(l.b.i); near.get(l.b.i).add(l.a.i); }

    // Start: each node where this graph's last layout left it (so ticking a box or hiding a group
    // moves nothing). Otherwise groups go on a spiral with their rows around them, and the rest
    // next to the first row they touch. Layouts are kept for Nested parents on and off. The first
    // time the box is ticked, nodes start from the other layout, so groups move only as far as the circles need.
    const baseKey = `${state.prefix}|${state.group}|${graph.built_at}|${state.spacing}`;
    const layoutKey = `${baseKey}${nested ? '|nested' : ''}`;
    const reuse = state.layouts.get(layoutKey) || null;
    const seed = reuse || state.layouts.get(`${baseKey}${nested ? '' : '|nested'}`) || null;
    let fresh = 0;
    for (const node of nodes) {
      const at = seed && seed.pos.get(node.id);
      if (at) { node.x = at[0]; node.y = at[1]; node.kept = true; } else fresh += 1;
    }
    const fresher = [...hubs.values()].filter((hub) => !hub.kept);
    if (circles.size) {
      // Nested parents: the groups of one outer circle start together, each outer circle on its own
      // place on the spiral, so the circles are apart from the first picture on.
      const tops = new Map();
      for (const hub of fresher) {
        const top = hub.nest.split('>')[0] || hub.id;
        if (!tops.has(top)) tops.set(top, []);
        tops.get(top).push(hub);
      }
      let n = 0;
      for (const group of tops.values()) {
        const reach = 150 * Math.sqrt(n + 1) * 2.4 * spread;
        group.forEach((hub, i) => {
          hub.x = Math.cos(n * 2.4) * reach + Math.cos(i * 2.39996) * 110 * spread * Math.sqrt(i);
          hub.y = Math.sin(n * 2.4) * reach + Math.sin(i * 2.39996) * 110 * spread * Math.sqrt(i);
        });
        n += group.length;
      }
    } else {
      fresher.forEach((hub, n) => {
        const reach = 60 * Math.sqrt(n + 1) * 2.4 * spread;
        hub.x = Math.cos(n * 2.4) * reach;
        hub.y = Math.sin(n * 2.4) * reach;
      });
    }
    // The lines between rows: "depends on" and "related". The rows each row of a group has a line to.
    const lines = links.filter((l) => l.kind === 'depends' || l.kind === 'related');
    const beside = new Map();
    for (const l of lines) {
      if (l.a.kind !== 'row' || l.b.kind !== 'row' || l.a.hub !== l.b.hub) continue;
      for (const [a, b] of [[l.a, l.b], [l.b, l.a]]) {
        if (!beside.has(a)) beside.set(a, []);
        beside.get(a).push(b);
      }
    }
    // A group's rows in an order that puts rows with a line between them next to each other, as far as
    // that goes: each chain is walked from one of its ends. The rows with no line come last.
    const lineOrder = (members) => {
      const degree = (node) => (beside.get(node) || []).length;
      const seen = new Set();
      const order = [];
      const walk = (node) => {
        seen.add(node);
        order.push(node);
        for (const next of [...(beside.get(node) || [])].sort((a, b) => degree(a) - degree(b) || a.i - b.i)) if (!seen.has(next)) walk(next);
      };
      const starts = [...members].sort((a, b) => (degree(a) ? 0 : 1) - (degree(b) ? 0 : 1) || degree(a) - degree(b) || a.i - b.i);
      for (const node of starts) if (!seen.has(node)) walk(node);
      return order;
    };
    // A small shift, the same each time for the same node: the same graph always gives the same picture.
    const offset = (i, salt) => ((((i + 1) * 9301 + salt * 49297) % 233280) / 233280 - 0.5) * 12;
    // A group's rows start on rings around their hub, in that order, never piled up (repulsion
    // only checks neighbours, and a pile would make every pair neighbours). A line between two
    // side-by-side rows runs along the ring, not through the hub.
    for (const hub of hubs.values()) {
      const rows = lineOrder(hub.members).filter((node) => !node.kept);
      let done = 0;
      for (let ring = 1; done < rows.length; ring++) {
        const count = Math.min(6 * ring, rows.length - done);
        // Two rows alone are not put opposite each other: a line between them would cross the hub.
        const turn = count === 2 ? Math.PI / 2 : (Math.PI * 2) / count;
        for (let n = 0; n < count; n++) {
          const node = rows[done + n];
          const angle = n * turn + ring * 0.5;
          node.x = hub.x + Math.cos(angle) * ring * 22 * spread + offset(node.i, 1);
          node.y = hub.y + Math.sin(angle) * ring * 22 * spread + offset(node.i, 2);
        }
        done += count;
      }
    }
    for (const l of links) {
      for (const [a, b] of [[l.a, l.b], [l.b, l.a]]) {
        if (b.kept || b.kind === 'row' || b.kind === 'hub' || b.x !== 0 || b.y !== 0 || a.kind !== 'row') continue;
        // outside the row's group: from the hub through the row, and on
        const dx = a.x - a.hub.x; const dy = a.y - a.hub.y;
        const d = Math.hypot(dx, dy) || 1;
        b.x = a.x + (dx / d) * 60 * spread + offset(b.i, 3);
        b.y = a.y + (dy / d) * 60 * spread + offset(b.i, 4);
      }
    }

    const hubList = [...hubs.values()];
    // For each file or linked item: the groups its rows are in, which it keeps out of.
    const ownersOf = new Map();
    for (const l of links) {
      if ((l.b.kind !== 'file' && l.b.kind !== 'item') || !l.a.hub) continue;
      if (!ownersOf.has(l.b)) ownersOf.set(l.b, new Set());
      ownersOf.get(l.b).add(l.a.hub);
    }
    const followers = [...ownersOf].map(([node, owners]) => ({ node, owners: [...owners] }));
    // A group moves as one: a push on its hub is a push on its rows too, so the rows do not trail behind it.
    const shove = (hub, ax, ay) => {
      hub.vx += ax; hub.vy += ay;
      for (const member of hub.members) { member.vx += ax; member.vy += ay; }
    };
    // How far each group reaches, and where each circle of nested parents is: around all its groups.
    function measure() {
      for (const hub of hubList) {
        // The radius of the disc the rows fill. For an even disc the mean squared distance is r²/2, so r = sqrt(2 × mean).
        let sum = 0;
        for (const member of hub.members) sum += (member.x - hub.x) ** 2 + (member.y - hub.y) ** 2;
        hub.reach = Math.max(hub.members.length ? Math.sqrt((2 * sum) / hub.members.length) : 0, 40 * spread);
      }
      for (const circle of circleList) {
        let x = 0; let y = 0;
        for (const hub of circle.leaves) { x += hub.x; y += hub.y; }
        circle.x = x / circle.leaves.length;
        circle.y = y / circle.leaves.length;
        circle.r = 0;
        for (const hub of circle.leaves) circle.r = Math.max(circle.r, Math.hypot(hub.x - circle.x, hub.y - circle.y) + hub.reach);
        circle.r += (20 + 16 * circle.level) * spread;
      }
    }
    // The nodes that keep off the lines: the hubs and the rows, each with the room it wants around it.
    // In a very big graph only the hubs do, so a tick stays fast.
    const hubRoom = (hub) => Math.min(26, 9 + 2.2 * Math.sqrt(hub.size)) + 14;
    const offLines = nodes.filter((node) => node.kind === 'hub' || (node.kind === 'row' && lines.length * nodes.length <= 300000));
    for (const node of offLines) node.room = node.kind === 'hub' ? hubRoom(node) : 14;
    let alpha = reuse && fresh === 0 ? 0 : seed ? 0.4 : 1;
    function tick() {
      const cell = 34 * spread;
      const grid = new Map();
      for (const node of nodes) {
        const key = `${Math.floor(node.x / cell)},${Math.floor(node.y / cell)}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(node);
      }
      for (const node of nodes) {
        const cx = Math.floor(node.x / cell);
        const cy = Math.floor(node.y / cell);
        for (let gx = cx - 1; gx <= cx + 1; gx++) {
          for (let gy = cy - 1; gy <= cy + 1; gy++) {
            for (const peer of grid.get(`${gx},${gy}`) || []) {
              if (peer.i <= node.i) continue;
              let dx = peer.x - node.x;
              let dy = peer.y - node.y;
              let d2 = dx * dx + dy * dy;
              if (d2 > cell * cell) continue;
              // Two nodes on the same spot part in a direction their numbers give, the same each time.
              if (d2 < 0.01) { dx = Math.cos(node.i + peer.i * 2.39996); dy = Math.sin(node.i + peer.i * 2.39996); d2 = 1; }
              const d = Math.sqrt(d2);
              const push = ((cell - d) / cell) * 3 * alpha;
              node.vx -= (dx / d) * push; node.vy -= (dy / d) * push;
              peer.vx += (dx / d) * push; peer.vy += (dy / d) * push;
            }
          }
        }
      }
      // The groups keep apart from each other.
      for (let a = 0; a < hubList.length; a++) {
        for (let b = a + 1; b < hubList.length; b++) {
          const p = hubList[a]; const q = hubList[b];
          const dx = q.x - p.x; const dy = q.y - p.y;
          const d = Math.sqrt(dx * dx + dy * dy) || 1;
          const want = (80 + 16 * Math.sqrt(p.size) + 16 * Math.sqrt(q.size)) * spread;
          if (d >= want) continue;
          const push = ((want - d) / want) * 16 * alpha;
          shove(p, -(dx / d) * push, -(dy / d) * push);
          shove(q, (dx / d) * push, (dy / d) * push);
        }
      }
      for (const l of links) {
        const dx = l.b.x - l.a.x; const dy = l.b.y - l.a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        if (l.b.kind === 'file' || l.b.kind === 'item') {
          // A file or a linked work item goes to the middle of its rows (each row pulls it, scaled by how
          // many there are). It never pulls a row back: the rows stay where their group puts them, so
          // every group takes the same shape.
          const follow = ((d - l.len) / d) * 0.06 * alpha / l.b.deg;
          l.b.vx -= dx * follow; l.b.vy -= dy * follow;
          continue;
        }
        // A node with many links is pulled by each of them, so each pull is scaled down by how
        // many there are, and the busier end moves less: a hub does not fly off with its rows.
        // A big group's rows are held more loosely, so they spread out to a disc instead of a dense ball.
        const loose = l.kind === 'group' ? Math.max(1, Math.pow(l.a.size / 60, 0.25)) : 1;
        const pull = ((d - l.len) / d) * (l.kind === 'group' ? 0.3 : l.kind === 'file' ? 0.01 : 0.06) * alpha / Math.min(l.a.deg, l.b.deg) / loose;
        const share = l.a.deg / (l.a.deg + l.b.deg);
        l.b.vx -= dx * pull * share; l.b.vy -= dy * pull * share;
        l.a.vx += dx * pull * (1 - share); l.a.vy += dy * pull * (1 - share);
      }
      // A hub or a row keeps off a line that isn't its own: it moves sideways, away from the line, and
      // the line's two ends move the other way. A hub takes its group with it, unless the line is
      // between rows of that group: then the hub moves alone and the two rows slide around it.
      for (const l of lines) {
        const dx = l.b.x - l.a.x; const dy = l.b.y - l.a.y;
        const len2 = dx * dx + dy * dy;
        if (len2 < 1) continue;
        const len = Math.sqrt(len2);
        const nx = dy / len; const ny = -dx / len;
        for (const node of offLines) {
          if (node === l.a || node === l.b) continue;
          const px = node.x - l.a.x; const py = node.y - l.a.y;
          // Where the node is along the line (0 at one end, 1 at the other), and how far to its side.
          const along = (px * dx + py * dy) / len2;
          if (along <= 0.08 || along >= 0.92) continue;
          let side = px * nx + py * ny;
          if (Math.abs(side) >= node.room) continue;
          if (Math.abs(side) < 0.01) side = (node.i + l.a.i) % 2 ? 0.01 : -0.01;
          const push = ((node.room - Math.abs(side)) / node.room) * 3 * alpha * Math.sign(side);
          if (node.kind === 'hub' && node !== l.a.hub && node !== l.b.hub) shove(node, nx * push, ny * push);
          else { node.vx += nx * push; node.vy += ny * push; }
          l.a.vx -= nx * push * 0.5; l.a.vy -= ny * push * 0.5;
          l.b.vx -= nx * push * 0.5; l.b.vy -= ny * push * 0.5;
        }
      }
      // Files and linked items stay outside the circle of the groups their rows are in, never inside it.
      measure();
      for (const { node, owners } of followers) {
        for (const hub of owners) {
          const dx = node.x - hub.x; const dy = node.y - hub.y;
          const d = Math.sqrt(dx * dx + dy * dy) || 1;
          const room = hub.reach + 50 * spread;
          if (d >= room) continue;
          const out = (room - d) * 1.5 * alpha;
          node.vx += (dx / d) * out; node.vy += (dy / d) * out;
        }
      }
      // Nested parents: two circles that are not one inside the other keep apart, each moving as one.
      for (const [p, q] of apart) {
        const dx = q.x - p.x; const dy = q.y - p.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const over = p.r + q.r + 24 * spread - d;
        if (over <= 0) continue;
        const push = Math.min(over, 60 * spread) * 0.15 * alpha;
        for (const hub of p.leaves) shove(hub, -(dx / d) * push, -(dy / d) * push);
        for (const hub of q.leaves) shove(hub, (dx / d) * push, (dy / d) * push);
      }
      // The groups of one circle gather, and every other group keeps out of it.
      for (const circle of circleList) {
        for (const hub of hubList) {
          const dx = hub.x - circle.x; const dy = hub.y - circle.y;
          if (circle.leaves.includes(hub)) { shove(hub, -dx * 0.02 * alpha, -dy * 0.02 * alpha); continue; }
          const d = Math.sqrt(dx * dx + dy * dy) || 1;
          const room = circle.r + hub.reach;
          if (d >= room) continue;
          // A capped push: an uncapped one would throw a far group across the picture.
          const out = Math.min(room - d, 60 * spread) * 0.3 * alpha;
          shove(hub, (dx / d) * out, (dy / d) * out);
        }
      }
      for (const node of nodes) {
        if (node.kind === 'hub') shove(node, -node.x * 0.004 * alpha, -node.y * 0.004 * alpha);
        if (node.pinned) { node.vx = 0; node.vy = 0; continue; }
        node.vx = Math.max(-30, Math.min(30, node.vx * 0.8)); node.vy = Math.max(-30, Math.min(30, node.vy * 0.8));
        node.x += node.vx; node.y += node.vy;
      }
    }

    // The stage: the canvas, a legend, a hint, and a box for what the pointer is on.
    const stage = box.appendChild(h('div', 'stage'));
    const canvas = stage.appendChild(h('canvas'));
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'The rows of the project as clusters. The lists under the graph hold the same information as text.');
    const tip = stage.appendChild(h('div', 'gtip'));
    tip.hidden = true;
    const legend = stage.appendChild(h('div', 'glegend'));
    // The rows of a merge that is running now: a ring, and their "Depends on" arrows lit.
    const merging = new Set(nodes.filter((node) => node.kind === 'row' && state.mergeLit.has(node.id)).map((node) => node.i));
    for (const [cls, text] of [['hub', byFeature ? 'Parent' : 'Repo'], ['row', 'Row, colored by status'], ['item', 'Linked work item'], ['file', 'File several plans name'], ['arrow', 'Arrow: depends on']]) {
      const item = legend.appendChild(h('span', 'lg'));
      item.appendChild(h('i', `lg-${cls}`, cls === 'arrow' ? '→' : ''));
      item.appendChild(document.createTextNode(text));
    }
    if (nested) {
      const item = legend.appendChild(h('span', 'lg'));
      item.appendChild(h('i', 'lg-hub'));
      item.appendChild(document.createTextNode('Big circle: a parent of parents'));
    }
    if (merging.size) {
      const item = legend.appendChild(h('span', 'lg'));
      item.appendChild(h('i', 'lg-merge'));
      item.appendChild(document.createTextNode('Ring: merging now'));
    }
    stage.appendChild(h('div', 'ghint', 'Drag to move, scroll or use + and − to zoom, click a row to open it'));
    const controls = stage.appendChild(h('div', 'gctl'));
    const control = (text, label, onClick) => {
      const button = controls.appendChild(h('button', 'iconbtn', text));
      button.type = 'button';
      button.setAttribute('aria-label', label);
      button.addEventListener('click', onClick);
    };
    control('+', 'Zoom in', () => zoomBy(1.4));
    control('−', 'Zoom out', () => zoomBy(1 / 1.4));
    control('Fit', 'Fit the graph to the window', () => { fitView(); redraw(); });
    control(byFeature ? 'Parents' : 'Repos', 'Choose which groups to show', () => { state.groupsOpen = !state.groupsOpen; pane.hidden = !state.groupsOpen; });

    // The Groups pane: tick the Features (or repos) to show. A hidden one has no nodes, and the rest stay where they are.
    const pane = stage.appendChild(h('div', 'gpanel'));
    pane.hidden = !state.groupsOpen;
    const paneTop = pane.appendChild(h('div', 'gp-top'));
    const search = paneTop.appendChild(h('input'));
    search.type = 'search';
    search.placeholder = byFeature ? 'Find a parent' : 'Find a repo';
    search.value = state.groupSearch;
    for (const [text, hide] of [['All', false], ['None', true]]) {
      const button = paneTop.appendChild(h('button', 'link-btn', text));
      button.type = 'button';
      button.addEventListener('click', () => {
        if (hide) for (const group of allGroups.values()) hidden.add(group.key); else hidden.clear();
        again();
      });
    }
    const list = pane.appendChild(h('div', 'gp-list'));
    const byCount = [...allGroups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, undefined, { numeric: true }));
    const fillList = () => {
      clear(list);
      const q = search.value.trim().toLowerCase();
      let listed = 0;
      for (const group of byCount) {
        if (q && !group.label.toLowerCase().includes(q)) continue;
        if (listed++ >= 200) { list.appendChild(h('p', 'muted-line', 'Type to find more')); break; }
        const item = list.appendChild(h('label', 'gp-item'));
        const tick1 = item.appendChild(h('input'));
        tick1.type = 'checkbox';
        tick1.checked = !hidden.has(group.key);
        item.appendChild(h('span', 'gp-name', group.label));
        item.appendChild(h('small', '', String(group.count)));
        tick1.addEventListener('change', () => { if (tick1.checked) hidden.delete(group.key); else hidden.add(group.key); again(); });
      }
    };
    search.addEventListener('input', () => { state.groupSearch = search.value; fillList(); });
    list.addEventListener('scroll', () => { state.groupScroll = list.scrollTop; });
    fillList();
    list.scrollTop = state.groupScroll;

    const ctx = canvas.getContext('2d');
    const view = { x: 0, y: 0, k: 1 };
    const keepView = Boolean(reuse && reuse.view);
    if (keepView) Object.assign(view, reuse.view);
    // Leaving the graph (a box ticked, another view) keeps where everything is for the next time.
    state.saveLayout = () => {
      // The nodes of a hidden group are not drawn now: they keep the place they had.
      const pos = new Map(seed ? seed.pos : []);
      for (const node of nodes) pos.set(node.id, [node.x, node.y]);
      state.layouts.delete(layoutKey);
      state.layouts.set(layoutKey, { pos, view: { x: view.x, y: view.y, k: view.k } });
      // Only the newest few layouts are kept.
      while (state.layouts.size > 8) state.layouts.delete(state.layouts.keys().next().value);
    };
    let width = 1; let height = 1; let dpr = 1;
    let hover = null;
    let raf = 0;
    let dirty = true;

    function zoomBy(factor) {
      const k = Math.max(0.05, Math.min(8, view.k * factor));
      view.x = width / 2 - (width / 2 - view.x) * (k / view.k);
      view.y = height / 2 - (height / 2 - view.y) * (k / view.k);
      view.k = k;
      redraw();
    }
    const radius = (node) => (node.kind === 'hub' ? Math.min(26, 9 + 2.2 * Math.sqrt(node.size)) : node.kind === 'row' ? 5 : 4);
    function fitView() {
      if (!nodes.length) return;
      let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
      for (const node of nodes) { minX = Math.min(minX, node.x); maxX = Math.max(maxX, node.x); minY = Math.min(minY, node.y); maxY = Math.max(maxY, node.y); }
      const pad = 50;
      view.k = Math.max(0.05, Math.min(1.6, (width - pad * 2) / Math.max(1, maxX - minX), (height - pad * 2) / Math.max(1, maxY - minY)));
      view.x = width / 2 - ((minX + maxX) / 2) * view.k;
      view.y = height / 2 - ((minY + maxY) / 2) * view.k;
    }

    // Two layers. Lines and dots are drawn once into `scene`, a bitmap, when the layout and view
    // settle. A frame is that bitmap plus the little that changes (hover, names). Drawing thousands
    // of long lines every frame took hundreds of ms, and every pan, zoom and hover makes a frame.
    // A small graph skips the wait: its scene is redrawn at once.
    const cheap = links.length < 1500;
    const colorsOf = () => {
      const css = getComputedStyle(document.documentElement);
      const cache = new Map();
      return (name) => {
        if (!cache.has(name)) cache.set(name, css.getPropertyValue(name).trim() || '#888');
        return cache.get(name);
      };
    };
    const seen = (v, node) => {
      const x = node.x * v.k + v.x; const y = node.y * v.k + v.y;
      return x >= -30 && x <= width + 30 && y >= -30 && y <= height + 30;
    };

    // The links (all, or the ones `only` says yes to) in one path for each kind. strong: the lit ones.
    function drawLinks(g, v, color, only, strong) {
      const batches = new Map();
      for (const l of links) {
        if (only && !only(l)) continue;
        if (!seen(v, l.a) && !seen(v, l.b)) continue;
        if (!batches.has(l.kind)) batches.set(l.kind, []);
        batches.get(l.kind).push(l);
      }
      g.lineCap = 'round';
      for (const [kind, list] of batches) {
        // Thousands of file lines would hide everything else, so the more there are the fainter each one is.
        g.globalAlpha = strong ? 0.95 : kind === 'group' ? 0.2 : kind === 'file' ? (list.length > 2000 ? 0.03 : list.length > 500 ? 0.07 : list.length > 100 ? 0.25 : 0.5) : 0.7;
        g.lineWidth = (strong ? 2 : 1.1) / Math.sqrt(v.k);
        // A dash costs far more than a plain line, so only a few lines get one.
        g.setLineDash(list.length <= 150 && kind === 'related' ? [6, 5] : list.length <= 150 && kind === 'file' ? [2, 5] : []);
        g.strokeStyle = kind === 'file' ? color('--warn') : kind === 'related' ? color('--muted') : kind === 'depends' ? color('--accent') : color('--accent2');
        g.beginPath();
        for (const l of list) { g.moveTo(l.a.x, l.a.y); g.lineTo(l.b.x, l.b.y); }
        g.stroke();
        if (kind === 'depends') {
          g.setLineDash([]);
          g.fillStyle = color('--accent');
          g.beginPath();
          for (const l of list) {
            const angle = Math.atan2(l.b.y - l.a.y, l.b.x - l.a.x);
            const tipX = l.b.x - Math.cos(angle) * 7; const tipY = l.b.y - Math.sin(angle) * 7;
            g.moveTo(tipX, tipY);
            g.lineTo(tipX - Math.cos(angle - 0.45) * 8, tipY - Math.sin(angle - 0.45) * 8);
            g.lineTo(tipX - Math.cos(angle + 0.45) * 8, tipY - Math.sin(angle + 0.45) * 8);
            g.closePath();
          }
          g.fill();
        }
      }
      g.setLineDash([]);
      g.globalAlpha = 1;
    }

    // The circles of nested parents, under everything else: the outer ones first.
    function drawCircles(g, v, color) {
      if (!circleList.length) return;
      measure();
      g.setLineDash([]);
      g.lineWidth = 1.4 / Math.sqrt(v.k);
      g.strokeStyle = color('--accent2');
      g.fillStyle = color('--accent2');
      for (const circle of circleList.slice().reverse()) {
        g.beginPath();
        g.arc(circle.x, circle.y, circle.r, 0, Math.PI * 2);
        g.globalAlpha = 0.05;
        g.fill();
        g.globalAlpha = 0.55;
        g.stroke();
      }
      g.globalAlpha = 1;
    }

    // The nodes (all, or the ones in the set `only`): rows in one path for each color, the rest one by one.
    function drawNodes(g, v, color, only) {
      const glow = only !== null || nodes.length < 1500;
      const dots = new Map();
      const others = [];
      for (const node of nodes) {
        if (only && !only.has(node.i)) continue;
        if (!seen(v, node)) continue;
        if (node.kind !== 'row') { others.push(node); continue; }
        const name = TONE_COLORS[node.tone] || '--muted';
        if (!dots.has(name)) dots.set(name, []);
        dots.get(name).push(node);
      }
      for (const [name, list] of dots) {
        g.shadowColor = color(name);
        g.shadowBlur = glow ? 9 : 0;
        g.fillStyle = color(name);
        g.beginPath();
        for (const node of list) { g.moveTo(node.x + 5, node.y); g.arc(node.x, node.y, 5, 0, Math.PI * 2); }
        g.fill();
      }
      for (const node of others) {
        const r = radius(node);
        const fill = node.kind === 'hub' ? color('--accent2') : node.kind === 'file' ? color('--warn') : color('--muted');
        g.shadowColor = fill;
        g.shadowBlur = glow && node.kind !== 'hub' ? 9 : 0;
        g.fillStyle = fill;
        g.beginPath();
        if (node.kind === 'file') g.rect(node.x - r, node.y - r, r * 2, r * 2);
        else if (node.kind === 'item') { g.moveTo(node.x, node.y - r - 1); g.lineTo(node.x + r + 1, node.y); g.lineTo(node.x, node.y + r + 1); g.lineTo(node.x - r - 1, node.y); g.closePath(); } else g.arc(node.x, node.y, r, 0, Math.PI * 2);
        if (node.kind === 'hub') {
          g.globalAlpha = 0.22;
          g.fill();
          g.globalAlpha = 1;
          g.shadowBlur = 0;
          g.lineWidth = 1.8 / Math.sqrt(v.k);
          g.strokeStyle = fill;
          g.stroke();
        } else {
          g.fill();
        }
      }
      g.shadowBlur = 0;
    }

    // Zoomed out, only the biggest groups are named: the names of dozens of small ones would pile up.
    const bigHubs = new Set([...hubs.values()].sort((a, b) => b.size - a.size).slice(0, 12));
    const scene = document.createElement('canvas');
    const sceneCtx = scene.getContext('2d');
    let sceneView = null;
    let sceneDirty = true;
    let sceneTimer = 0;
    function renderScene() {
      const v = { x: view.x, y: view.y, k: view.k };
      const color = colorsOf();
      sceneCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sceneCtx.clearRect(0, 0, width, height);
      sceneCtx.translate(v.x, v.y);
      sceneCtx.scale(v.k, v.k);
      drawCircles(sceneCtx, v, color);
      drawLinks(sceneCtx, v, color, null, false);
      drawNodes(sceneCtx, v, color, null);
      sceneView = v;
      sceneDirty = false;
    }

    function paint() {
      const color = colorsOf();
      const moving = alpha > 0.03;
      const lit = !moving && hover && near.get(hover.i).size <= LIT_MAX ? near.get(hover.i) : null;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      if (moving && !cheap) {
        // The layout is still moving: dots only, the lines come when it has settled.
        ctx.translate(view.x, view.y);
        ctx.scale(view.k, view.k);
        drawNodes(ctx, view, color, null);
        return;
      }
      const stale = sceneDirty || !sceneView || sceneView.x !== view.x || sceneView.y !== view.y || sceneView.k !== view.k;
      if (stale) {
        if (cheap) renderScene();
        else {
          clearTimeout(sceneTimer);
          sceneTimer = setTimeout(() => { if (canvas.isConnected) { renderScene(); redraw(); } }, 140);
        }
      }
      if (sceneView) {
        // The bitmap, moved and scaled to the view it is shown in until a new one is ready.
        const r = view.k / sceneView.k;
        ctx.save();
        ctx.globalAlpha = lit ? 0.18 : 1;
        ctx.translate(view.x - sceneView.x * r, view.y - sceneView.y * r);
        ctx.scale(r, r);
        ctx.drawImage(scene, 0, 0, width, height);
        ctx.restore();
      }
      ctx.translate(view.x, view.y);
      ctx.scale(view.k, view.k);
      if (lit) {
        drawLinks(ctx, view, color, (l) => l.a === hover || l.b === hover, true);
        drawNodes(ctx, view, color, lit);
      } else if (merging.size) {
        drawLinks(ctx, view, color, (l) => l.kind === 'depends' && merging.has(l.a.i) && merging.has(l.b.i), true);
        ctx.lineWidth = 2 / view.k;
        ctx.strokeStyle = color('--merged');
        ctx.beginPath();
        for (const node of nodes) {
          if (!merging.has(node.i) || !seen(view, node)) continue;
          const r = radius(node) + 3 / view.k;
          ctx.moveTo(node.x + r, node.y);
          ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
        }
        ctx.stroke();
      }
      if (hover && seen(view, hover)) {
        ctx.lineWidth = 2 / view.k;
        ctx.strokeStyle = color('--text');
        ctx.beginPath();
        ctx.arc(hover.x, hover.y, radius(hover) + 2 / view.k, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Names: the groups, what the pointer is on and what it lights, and every row once zoomed in (at most MAX_LABELS).
      const labels = [];
      for (const node of nodes) {
        if (labels.length >= MAX_LABELS) break;
        if (!seen(view, node)) continue;
        if (node.kind === 'hub' ? view.k > 0.2 && (view.k > 0.7 || bigHubs.has(node)) : node === hover || (lit && lit.has(node.i) && view.k > 0.5) || (node.kind === 'row' && view.k > 2.2)) labels.push(node);
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      for (const node of labels) {
        const size = (node.kind === 'hub' ? 13 : 11.5) / view.k;
        ctx.font = `${node.kind === 'hub' ? 600 : 400} ${size}px system-ui, "Segoe UI", sans-serif`;
        const text = node.kind === 'hub' || node.kind === 'file' ? `${node.label}${node.kind === 'hub' ? ` (${node.size})` : ''}` : node.label;
        const y = node.y - radius(node) - 4 / view.k;
        ctx.lineWidth = 4 / view.k;
        ctx.strokeStyle = color('--bg');
        ctx.strokeText(text, node.x, y);
        ctx.fillStyle = color('--text');
        ctx.fillText(text, node.x, y);
      }
      // The name of each circle of nested parents, on top of it.
      if (view.k > 0.2) {
        for (const circle of circleList) {
          ctx.font = `600 ${13 / view.k}px system-ui, "Segoe UI", sans-serif`;
          const y = circle.y - circle.r - 4 / view.k;
          ctx.lineWidth = 4 / view.k;
          ctx.strokeStyle = color('--bg');
          ctx.strokeText(circle.label, circle.x, y);
          ctx.fillStyle = color('--muted');
          ctx.fillText(circle.label, circle.x, y);
        }
      }
    }

    function loop() {
      raf = 0;
      if (!canvas.isConnected) return;
      if (alpha > 0.03) { tick(); alpha *= 0.985; sceneDirty = true; dirty = true; }
      if (dirty) { paint(); dirty = false; }
      if (alpha > 0.03) raf = requestAnimationFrame(loop);
    }
    const wake = () => { if (!raf) raf = requestAnimationFrame(loop); };
    const redraw = () => { dirty = true; wake(); };

    function resize() {
      if (!canvas.isConnected) { observer.disconnect(); return; }
      const first = canvas.width === 300 && canvas.height === 150;
      width = Math.max(1, stage.clientWidth);
      height = Math.max(1, stage.clientHeight);
      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      scene.width = canvas.width;
      scene.height = canvas.height;
      sceneView = null;
      if (first && !keepView) fitView();
      redraw();
    }
    const observer = new ResizeObserver(resize);
    observer.observe(stage);

    // Settle the layout before the first picture, within a short time budget.
    resize();
    const until = performance.now() + 450;
    for (let n = 0; n < 260 && performance.now() < until && alpha > 0.03; n++) { tick(); alpha *= 0.985; }
    if (!keepView) fitView();
    redraw();

    // The pointer.
    const world = (event) => {
      const rect = canvas.getBoundingClientRect();
      const sx = event.clientX - rect.left; const sy = event.clientY - rect.top;
      return { sx, sy, x: (sx - view.x) / view.k, y: (sy - view.y) / view.k };
    };
    function nodeAt(point) {
      let found = null; let best = Infinity;
      for (const node of nodes) {
        const d = Math.hypot(node.x - point.x, node.y - point.y);
        const reach = radius(node) + 4 / view.k;
        if (d <= reach && d < best) { best = d; found = node; }
      }
      return found;
    }
    function showTip(node, point) {
      if (!node) { tip.hidden = true; return; }
      clear(tip);
      tip.appendChild(h('b', '', node.kind === 'hub' || node.kind === 'file' ? `${node.label} (${plural(node.size, 'row')})` : node.label));
      if (node.title) tip.appendChild(h('span', '', node.title));
      if (node.status) tip.appendChild(h('em', '', node.status));
      if (node.url) tip.appendChild(h('em', '', node.kind === 'item' ? 'Not on the board. Click to open it in Azure DevOps.' : 'Click to open it in Azure DevOps.'));
      tip.hidden = false;
      const flip = point.sx > width - 340;
      tip.style.left = `${flip ? point.sx - tip.offsetWidth - 14 : point.sx + 16}px`;
      tip.style.top = `${Math.max(8, Math.min(height - tip.offsetHeight - 8, point.sy + 12))}px`;
    }

    let drag = null;
    canvas.addEventListener('pointerdown', (event) => {
      const point = world(event);
      const node = nodeAt(point);
      drag = { node, startX: event.clientX, startY: event.clientY, moved: false, viewX: view.x, viewY: view.y };
      canvas.setPointerCapture(event.pointerId);
      canvas.classList.add('grab');
    });
    canvas.addEventListener('pointermove', (event) => {
      const point = world(event);
      if (drag) {
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) drag.moved = true;
        if (drag.moved && drag.node) {
          drag.node.pinned = true;
          drag.node.x = point.x; drag.node.y = point.y;
          alpha = Math.max(alpha, 0.25);
          redraw();
        } else if (drag.moved) {
          view.x = drag.viewX + (event.clientX - drag.startX);
          view.y = drag.viewY + (event.clientY - drag.startY);
          redraw();
        }
        return;
      }
      const node = nodeAt(point);
      if (node !== hover) { hover = node; canvas.classList.toggle('over', Boolean(node && (node.kind === 'row' || node.url))); redraw(); }
      showTip(node, point);
    });
    const release = (event) => {
      if (!drag) return;
      const { node, moved } = drag;
      if (node) node.pinned = false;
      drag = null;
      canvas.classList.remove('grab');
      if (event.type === 'pointerup' && !moved && node && node.kind === 'row') openRow(node.id, { review: false });
      else if (event.type === 'pointerup' && !moved && node && /^https:\/\/dev\.azure\.com\//.test(node.url || '')) window.open(node.url, '_blank', 'noopener,noreferrer');
      redraw();
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('pointerleave', () => { if (!drag) { hover = null; tip.hidden = true; redraw(); } });
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      const point = world(event);
      const k = Math.max(0.05, Math.min(8, view.k * Math.exp(-event.deltaY * 0.0015)));
      view.x = point.sx - point.x * k;
      view.y = point.sy - point.y * k;
      view.k = k;
      redraw();
    }, { passive: false });
  }

  // --- stats ---

  function amount(tokens) {
    if (tokens < 1000) return String(tokens);
    if (tokens < 1e6) return `${(tokens / 1e3).toFixed(1)}k`;
    return `${(tokens / 1e6).toFixed(1)}M`;
  }

  function lasted(ms) {
    if (!Number.isFinite(ms)) return '?';
    const minutes = Math.round(ms / 60000);
    if (minutes < 1) return `${Math.round(ms / 1000)}s`;
    return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  }

  const tokenSum = (t) => t.input + t.cache_write + t.cache_read + t.output;

  function statTable(parent, heads, rows) {
    const table = parent.appendChild(h('table', 'plain'));
    const head = table.appendChild(h('thead')).appendChild(h('tr'));
    for (const text of heads) head.appendChild(h('th', '', text));
    const body = table.appendChild(h('tbody'));
    for (const cells of rows) {
      const tr = body.appendChild(h('tr'));
      cells.forEach((cell, index) => tr.appendChild(h('td', index === 0 ? '' : 'num', cell)));
    }
  }

  async function renderStats(box, token) {
    const bar = box.appendChild(h('div', 'filters'));
    pick(bar, 'Days', [[1, 'Today'], [7, 'Last 7 days'], [14, 'Last 14 days'], [30, 'Last 30 days']], state.statDays, (value) => { state.statDays = Number(value); renderOther(); });
    bar.appendChild(h('span', 'spacer'));
    bar.appendChild(h('span', 'count', 'All projects: the triage and implement runs in Spadework\'s log'));
    const body = box.appendChild(h('div', 'viewbody'));
    body.appendChild(h('p', 'muted-line', 'Loading…'));
    let data;
    try {
      data = await api('GET', `/api/stats?days=${state.statDays}`);
    } catch (err) {
      if (token === state.viewToken) clear(body).appendChild(h('p', 'err', err.message));
      return;
    }
    if (token !== state.viewToken) return;
    clear(body);
    const { runs, totals } = data;
    const tiles = body.appendChild(h('div', 'cards tight'));
    const tile = (n, label, hint) => statTile(tiles, n, label, hint);
    tile(String(totals.runs), 'Runs', plural(totals.items, 'item'));
    tile(amount(tokenSum(totals.tokens.total)), 'Tokens', 'all agents');
    tile(amount(totals.tokens.total.cache_read), 'Cache read', 'of the tokens above');
    if (totals.runs_without_tokens) tile(String(totals.runs_without_tokens), 'Without tokens', "the chat's transcript is gone");
    if (!runs.length) {
      body.appendChild(h('p', 'muted-line', 'No triage or implement runs in this period.'));
      return;
    }
    body.appendChild(h('h3', 'day', 'By agent'));
    statTable(body, ['Agent', 'Input', 'Cache write', 'Cache read', 'Output', 'Total'],
      Object.entries(totals.tokens.by_agent).map(([name, t]) => [name, amount(t.input), amount(t.cache_write), amount(t.cache_read), amount(t.output), amount(tokenSum(t))]));
    body.appendChild(h('h3', 'day', 'Runs'));
    statTable(body, ['Started', 'Mode', 'Took', 'Repos', 'Items', 'Results', 'Tokens'],
      runs.slice().reverse().map((run) => [
        fmtTime(run.started_at), run.mode, lasted(run.duration_ms), run.repos.join(', ') || '–', String(run.items),
        Object.entries(run.results).map(([name, n]) => `${n} ${name}`).join(', ') || '–', run.tokens ? amount(tokenSum(run.tokens.total)) : '–',
      ]));
  }

  // --- the Merge view ---------------------------------------------------------------

  const MERGE_ACTIVE = ['running', 'testing'];
  const STEP_STATES = {
    waiting: 'waiting', merging: 'merging', resolving: 'resolving a conflict', reviewing: 'reviewing the resolution', merged: 'merged', left_out: 'left out',
  };
  const mergeProject = () => state.projects.find((entry) => entry.prefix === state.prefix) || null;
  // The order takes git a while, so it is worked out only when the user asks for it with the button.
  // The last answer of each repo is kept, with its time: { state: 'pending' | 'done' | 'error', text, at }.
  const plans = new Map();
  const mergeQuery = (project, repo) => `repo=${encodeURIComponent(repo)}&project=${encodeURIComponent(project.name)}`;

  // The rows of the merges running now in this project's repos, for the graph.
  async function mergingRows() {
    const project = mergeProject();
    const ids = new Set();
    for (const repo of project ? project.repos : []) {
      try {
        const { run } = await api('GET', `/api/merge/runs?${mergeQuery(project, repo.name)}`);
        if (!run || !MERGE_ACTIVE.includes(run.state)) continue;
        for (const step of run.steps) {
          ids.add(step.id);
          for (const inner of step.comes_with || []) ids.add(inner.id);
        }
      } catch { /* no highlight */ }
    }
    return ids;
  }

  const codeLine = (parent, text) => {
    const line = parent.appendChild(h('div', 'cf-row'));
    line.append(h('code', 'cf-cmd', text), copyButton(text));
    return line;
  };
  function copyButton(text, label = 'Copy') {
    const button = h('button', 'iconbtn', label);
    button.type = 'button';
    button.addEventListener('click', () => {
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Could not copy', true));
    });
    return button;
  }

  const TEST_WARNING = 'This is only what your test command returned. Always test the merged branch yourself, and review which tests it has: a command that passes does not show that the change works.';
  const RUN_RESULTS = {
    planned: 'Planned, not started', running: 'Merging', testing: 'Running the tests', passed: 'Test command passed',
    failed: 'Test command failed', cut_off: 'Cut off before it finished',
  };
  const runResult = (run) => (run.state === 'passed' && run.tests_skipped ? 'Done, no tests ran' : RUN_RESULTS[run.state] || run.state);
  // Every row of a run: its steps, and after each step the rows that come in with it.
  const runRowIds = (run) => run.steps.flatMap((step) => [step.id, ...(step.comes_with || []).map((inner) => inner.id)]);
  const cells = (parent, tag, texts) => {
    const line = parent.appendChild(h('tr'));
    for (const text of texts) line.appendChild(h(tag, '', text));
    return line;
  };

  // One run, opened: a line per row with its state and the reason, the tests, and when the run ended
  // the commands to review and push its branch.
  function runDetail(box, run) {
    const table = box.appendChild(h('table', 'plain merge-rows'));
    cells(table.appendChild(h('thead')), 'th', ['Step', 'Row', 'State', 'Note']);
    const body = table.appendChild(h('tbody'));
    const line = (stepText, entry, stateName, note) => {
      const tr = body.appendChild(h('tr', `ms-${stateName}`));
      tr.appendChild(h('td', 'num', stepText));
      const cell = tr.appendChild(h('td'));
      const open = cell.appendChild(h('button', 'link-btn id', entry.id));
      open.type = 'button';
      open.addEventListener('click', () => openRow(entry.id, { review: false }));
      cell.appendChild(document.createTextNode(` ${entry.title || ''}`));
      tr.appendChild(h('td')).appendChild(h('span', 'ms-state', STEP_STATES[stateName] || stateName));
      tr.appendChild(h('td', 'muted-line', note || ''));
    };
    run.steps.forEach((step, index) => {
      line(String(index + 1), step, step.state, step.state === 'left_out' ? step.left_out : step.reason);
      // A row whose code is in this step's branch has no step of its own: it goes where the step goes.
      for (const inner of step.comes_with || []) line('', inner, step.state, `Its code is in ${step.id}'s branch, so it comes in with ${step.id}.`);
    });
    for (const text of run.lines || []) box.appendChild(h('p', 'muted-line', text));
    if (run.state === 'passed' && run.tests_skipped) box.appendChild(h('p', 'cf-warn', 'No test commands are set for this repo, so no tests ran. Test the merged branch yourself before you push it.'));
    // The tests: whether each of the user's test commands passed or failed, and nothing more is claimed.
    const results = run.tests || [];
    results.forEach((result, index) => {
      const which = results.length > 1 ? `Test command ${index + 1} of ${results.length}` : 'Your test command';
      box.appendChild(h('p', result.passed ? 'cf-ok' : 'err', `${which} ${result.passed ? 'passed' : 'failed'}`));
      const more = box.appendChild(h('details', 'merge-cmd'));
      more.appendChild(h('summary', '', 'The command'));
      more.appendChild(h('pre', 'merge-out', result.command));
      if (result.output) box.appendChild(h('pre', 'merge-out', result.output));
    });
    // A command that passed says little by itself: which tests it ran, and what they cover, is the user's to check.
    if (run.state === 'passed' && results.length) box.appendChild(h('p', 'cf-warn', TEST_WARNING));
    if (run.moved) box.appendChild(h('p', 'cf-warn', run.moved));
    if (['passed', 'failed'].includes(run.state)) {
      box.appendChild(h('h4', '', 'Review and push'));
      box.appendChild(h('p', 'muted-line', run.state === 'failed' ? 'The tests failed: fix them on the branch first. Nothing was pushed.' : 'Nothing was pushed. Review the branch, push it and open one pull request.'));
      codeLine(box, `git log ${run.main_ref}..${run.branch}`);
      codeLine(box, `git diff ${run.main_ref}...${run.branch}`);
      codeLine(box, `git push -u origin ${run.branch}`);
    }
  }

  // The runs of the repo as a table, newest first. A click on a run opens it. The newest starts open.
  const shownRuns = new Map();
  function drawRuns(box, runs, query) {
    clear(box);
    box.appendChild(h('h3', 'day', 'Merge runs'));
    if (!runs.length) {
      box.appendChild(h('p', 'muted-line', 'No merge has run in this repo yet. In advisory mode, or for one row that needs no new branch, the command only prints the order, so no run is kept.'));
      return;
    }
    box.appendChild(h('p', 'muted-line', 'Each time /spadework:merge merged rows of this repo into a new branch, newest first. Click a run to see its rows.'));
    if (!shownRuns.has(query)) shownRuns.set(query, new Set([runs[0].run_id]));
    const shown = shownRuns.get(query);
    const table = box.appendChild(h('table', 'plain merge-runs'));
    cells(table.appendChild(h('thead')), 'th', ['Branch', 'When', 'Result', 'Rows']);
    const body = table.appendChild(h('tbody'));
    for (const run of runs) {
      const open = shown.has(run.run_id);
      const tr = body.appendChild(h('tr', `mr-run mr-${run.state}`));
      const toggle = tr.appendChild(h('td')).appendChild(h('button', 'link-btn', `${open ? '▾' : '▸'} `));
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', String(open));
      toggle.appendChild(h('code', '', run.branch));
      tr.appendChild(h('td', '', fmtTime(run.updated_at || run.created_at)));
      tr.appendChild(h('td', 'mr-result', runResult(run)));
      tr.appendChild(h('td', 'num', runRowIds(run).join(', ')));
      tr.addEventListener('click', () => {
        if (open) shown.delete(run.run_id); else shown.add(run.run_id);
        drawRuns(box, runs, query);
      });
      if (!open) continue;
      const detail = body.appendChild(h('tr', 'mr-detail')).appendChild(h('td'));
      detail.colSpan = 4;
      runDetail(detail, run);
    }
  }

  async function renderMerge(box, token) {
    const project = mergeProject();
    const repos = project ? project.repos : [];
    const bar = box.appendChild(h('div', 'filters'));
    const body = box.appendChild(h('div', 'viewbody'));
    if (!repos.length) {
      body.appendChild(h('p', 'muted-line', 'This project has no repos.'));
      return;
    }
    if (!repos.some((repo) => same(repo.name, state.mergeRepo))) state.mergeRepo = repos[0].name;
    pick(bar, 'Repo', repos.map((repo) => [repo.name, repo.name]), state.mergeRepo, (value) => { state.mergeRepo = value; renderOther(); });
    bar.appendChild(h('span', 'spacer'));
    const work = bar.appendChild(h('button', 'iconbtn', '↻ Work out the order'));
    work.type = 'button';
    let copy = bar.appendChild(copyButton('', 'Copy command'));
    copy.disabled = true;
    const query = mergeQuery(project, state.mergeRepo);

    // The next merge: worked out only with the button, because git compares every branch.
    const order = body.appendChild(h('div', 'sec'));
    order.appendChild(h('h3', 'day', 'Next merge'));
    order.appendChild(h('p', 'muted-line', 'The rows the next /spadework:merge would merge in this repo, in order, with the reason for each. Working it out merges nothing. Git compares every branch, so it can take a minute.'));
    const out = order.appendChild(h('div'));
    const showPlan = () => {
      const plan = plans.get(query);
      clear(out);
      work.disabled = Boolean(plan && plan.state === 'pending');
      if (!plan) out.appendChild(h('p', 'muted-line', 'Not worked out yet. Click "Work out the order".'));
      else if (plan.state === 'pending') out.appendChild(h('p', 'muted-line', 'Working out the order…'));
      else if (plan.state === 'error') out.appendChild(h('p', 'err', plan.text));
      else {
        out.appendChild(h('p', 'muted-line', `Worked out ${fmtTime(plan.at)}.`));
        out.appendChild(h('pre', 'merge-out', plan.text));
      }
    };
    work.addEventListener('click', async () => {
      plans.set(query, { state: 'pending' });
      showPlan();
      let plan;
      try {
        const data = await api('GET', `/api/merge/plan?${query}`);
        plan = { state: 'done', text: data.text, at: new Date().toISOString() };
      } catch (err) {
        plan = { state: 'error', text: err.message };
      }
      plans.set(query, plan);
      if (token === state.viewToken) showPlan();
    });
    showPlan();

    const runBox = body.appendChild(h('div', 'sec'));
    runBox.appendChild(h('p', 'muted-line', 'Loading…'));
    // While a run is going, the runs are read again every 3 seconds.
    let timer = null;
    const loadRuns = async () => {
      let data;
      try {
        data = await api('GET', `/api/merge/runs?${query}`);
      } catch (err) {
        if (token === state.viewToken) clear(runBox).appendChild(h('p', 'err', err.message));
        return;
      }
      if (token !== state.viewToken) return;
      if (copy.disabled && data.command) {
        const ready = copyButton(data.command, 'Copy command');
        ready.title = data.command;
        copy.replaceWith(ready);
        copy = ready;
      }
      drawRuns(runBox, data.runs || [], query);
      if (data.run && MERGE_ACTIVE.includes(data.run.state)) timer = setTimeout(loadRuns, 3000);
    };
    state.leaveView = () => clearTimeout(timer);
    loadRuns();
  }

  // --- the page ----------------------------------------------------------------------

  function drawProjects() {
    const box = clear($('projects'));
    for (const project of state.projects) {
      const button = h('button', project.prefix === state.prefix ? 'on' : '', project.name);
      button.type = 'button';
      button.appendChild(h('small', '', project.prefix));
      button.addEventListener('click', async () => {
        if (project.prefix === state.prefix) return;
        state.prefix = project.prefix;
        state.status = state.repo = state.type = '';
        state.curId = null;
        closeRow();
        try { localStorage.setItem('spadework-project', project.prefix); } catch { /* not saved */ }
        drawProjects();
        try { await loadRows(); } catch (err) { toast(err.message, true); }
      });
      box.appendChild(button);
    }
  }

  const KEYS = [['j  k', 'move through the rows (↑ ↓ too, once the table has the focus)'], ['Enter', 'open the row'], ['a', 'approve (row open)'], ['r', 're-triage (row open)'], ['f', 'write feedback (row open)'], ['/', 'search'], ['Esc', 'close'], ['Ctrl+Enter', 'save what you are typing'], ['?', 'this help']];

  function toggleHelp(show) {
    const box = $('helpbox');
    const open = show === undefined ? box.hidden : show;
    box.hidden = !open;
    if (!open) return;
    clear(box).appendChild(h('h2', '', 'Keys'));
    const list = box.appendChild(h('dl'));
    for (const [keys, what] of KEYS) {
      list.appendChild(h('dt')).appendChild(h('kbd', '', keys));
      list.appendChild(h('dd', '', what));
    }
  }

  function bind() {
    $('views').addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (button) showView(button.dataset.view);
    });
    $('close').addEventListener('click', closeRow);
    $('scrim').addEventListener('click', closeRow);
    $('more').addEventListener('click', () => $('menu').classList.toggle('on'));
    $('approve').addEventListener('click', () => approve(state.curId, true));
    $('retriage').addEventListener('click', () => retriage(state.curId));
    $('dtabs').addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (button) showTab(button.dataset.p);
    });
    $('review').addEventListener('click', () => {
      const first = queue()[0];
      if (first) openRow(first.id, { review: true });
    });
    $('refresh').addEventListener('click', async () => {
      try { await loadRows(); toast('Refreshed'); } catch (err) { toast(err.message, true); }
    });
    $('help').addEventListener('click', (event) => { event.stopPropagation(); toggleHelp(); });
    // The graph and the timeline draw with the theme's colors.
    themeButton($('theme'), () => { if (state.view !== 'table') renderOther(); });
    document.addEventListener('click', (event) => {
      if (!$('helpbox').hidden && !$('helpbox').contains(event.target)) toggleHelp(false);
      if (!event.target.closest('#menu') && event.target.id !== 'more') closeMenu();
    });
    // The row that was open keeps its mark after the drawer closes, until the mouse moves over the table.
    $('rows').addEventListener('mousemove', () => {
      if (!state.showCur || $('drawer').classList.contains('on')) return;
      state.showCur = false;
      markCurrent();
    });
    $('repo').addEventListener('change', (event) => { state.repo = event.target.value; drawRows(); });
    $('type').addEventListener('change', (event) => { state.type = event.target.value; drawRows(); });
    $('closed').addEventListener('change', (event) => { state.closed = event.target.checked; drawCards(); drawRows(); });
    $('q').addEventListener('input', (event) => { state.q = event.target.value; drawRows(); });
    let waiting = false;
    $('tablewrap').addEventListener('scroll', () => {
      if (waiting) return;
      waiting = true;
      requestAnimationFrame(() => { waiting = false; drawTable(false); });
    });
    window.addEventListener('resize', () => drawTable(true));
    document.addEventListener('keydown', onKey);
    // Coming back to the page (from the terminal, say): show what a triage wrote meanwhile.
    const comeBack = () => {
      if (document.visibilityState === 'hidden' || state.locked || !state.prefix || Date.now() - lastLoad < 2000) return;
      loadRows().catch(() => {});
    };
    document.addEventListener('visibilitychange', comeBack);
    window.addEventListener('focus', comeBack);
  }

  function onKey(event) {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    const drawerOpen = $('drawer').classList.contains('on');
    if (event.key === 'Escape') {
      if (!$('helpbox').hidden) toggleHelp(false);
      else if ($('menu').classList.contains('on')) closeMenu();
      else if (typing) document.activeElement.blur();
      else closeRow();
      return;
    }
    if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === '/') { event.preventDefault(); showView('table'); $('q').focus(); return; }
    if (event.key === '?') { toggleHelp(); return; }
    if (drawerOpen) {
      if (event.key === 'a') approve(state.curId, true);
      else if (event.key === 'r') retriage(state.curId);
      else if (event.key === 'f') {
        const area = $('feedback');
        if (area) { event.preventDefault(); showTab('plan'); area.focus(); }
      }
      return;
    }
    if (state.view !== 'table') return;
    const inTable = document.activeElement === $('tablewrap');
    const step = event.key === 'j' || (inTable && event.key === 'ArrowDown') ? 1 : event.key === 'k' || (inTable && event.key === 'ArrowUp') ? -1 : 0;
    if (step) {
      event.preventDefault();
      // Moving through the rows takes the focus to the table, so Enter then opens the row,
      // not the button that had the focus.
      if (!inTable) $('tablewrap').focus({ preventScroll: true });
      move(step);
    } else if (event.key === 'Enter' && state.curId && document.activeElement.tagName !== 'BUTTON') {
      openRow(state.curId, { review: false });
    }
  }

  async function start() {
    if (location.protocol === 'file:') {
      showMessage("The board isn't running", ['Start it with /spadework:board, or from a terminal:'], 'node "<plugin folder>/scripts/spadework.js" board');
      return;
    }
    initKey();
    if (!key) return locked();
    try {
      const data = await api('GET', '/api/projects');
      state.items = data.items;
      state.titleMax = data.limits.title;
      state.projects = data.projects;
    } catch (err) {
      if (!state.locked) showMessage("The board can't start", [err.message]);
      return;
    }
    if (!state.projects.length) {
      showMessage('No project yet', ['Run /spadework:init to add a project to the board.']);
      return;
    }
    let saved = null;
    try { saved = localStorage.getItem('spadework-project'); } catch { /* none */ }
    state.prefix = (state.projects.find((project) => project.prefix === saved) || state.projects[0]).prefix;
    $('message').hidden = true;
    $('top').hidden = false;
    $('app').hidden = false;
    drawProjects();
    drawHeads();
    bind();
    try { await loadRows(); } catch (err) { toast(err.message, true); }
  }

  start();
})();
