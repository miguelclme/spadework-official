'use strict';

// The board's graph for one project: its rows, their parents, the work items
// they are related to, and the lines between them. It reads only the rows (no
// model calls, no code scan). The helper builds it when the user asks and
// saves it under ~/.spadework/board/graph. The format is { nodes, edges }: a
// node is a row, a parent work item, a related work item or a file that two
// or more plans name, and an edge is one of parent, related, depends or file.
// A parent carries its type, its title and `up`, the node of its own parent:
// the chain is followed by work item numbers, never by type names.

const { dependenciesOf } = require('./dependencies');

// The file a plan finding names: "`src/a.ts:12-30`: why" gives "src/a.ts".
function fileOf(finding) {
  const text = String(finding || '');
  const quoted = text.match(/^\s*`([^`]+)`/);
  const first = quoted ? quoted[1] : text.split(/\s+/)[0];
  const file = first.replace(/\\/g, '/').replace(/:\d+(?:[-,:]\d+)*$/, '').trim();
  return /[./]/.test(file) && !/\s/.test(file) ? file : null;
}

const filesOf = (row) => {
  const findings = row.plan && Array.isArray(row.plan.findings) ? row.plan.findings : [];
  return [...new Set(findings.map(fileOf).filter(Boolean))];
};

// A file named by more plans than this is not a link between them: it is the core of the
// project, and thousands of lines to one node say nothing a person can read.
const MAX_FILE_ROWS = 25;

// rows: the project's full rows. urlOf(project, workItemId): the link of a work item that is not a row.
function build(rows, { urlOf = null } = {}) {
  const byWorkItem = new Map();
  for (const row of rows) if (row.work_item && row.work_item.id) byWorkItem.set(Number(row.work_item.id), row.id);
  const nodes = new Map();
  const edges = [];
  const edgeKeys = new Set();
  const addEdge = (from, to, kind, extra = {}) => {
    const key = `${kind}|${from}|${to}`;
    if (from === to || edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to, kind, ...extra });
  };
  // A work item number is a row when the board has it, else a node of its own.
  const itemNode = (number, kind, title, project) => {
    if (byWorkItem.has(number)) return byWorkItem.get(number);
    const id = `wi-${number}`;
    if (!nodes.has(id)) {
      nodes.set(id, {
        id, kind, work_item: number, label: `#${number}`, title: title || '',
        ...(kind === 'feature' ? { type: '', up: null } : {}),
        ...(urlOf ? { url: urlOf(project, number) } : {}),
      });
    }
    return id;
  };

  for (const row of rows) {
    const workItem = row.work_item && row.work_item.id ? Number(row.work_item.id) : null;
    nodes.set(row.id, { id: row.id, kind: 'row', label: workItem ? `${workItem} · ${row.id}` : row.id, work_item: workItem, title: row.title, status: row.status, repo: row.repo || '', type: row.type || '', feature: null });
  }
  for (const row of rows) {
    const node = nodes.get(row.id);
    if (row.parent_id) {
      node.feature = itemNode(Number(row.parent_id), 'feature', '', row.project);
      addEdge(node.feature, row.id, 'parent');
    }
    for (const item of Array.isArray(row.related) ? row.related : []) {
      addEdge(row.id, itemNode(Number(item.id), 'item', item.title, row.project), 'related');
    }
  }

  // The parent chain: each parent gets its type, its title and the node of its
  // own parent, from what its rows kept. A parent that is a row on the board
  // has its own type and title, and its own parent is the level above it.
  for (const row of rows) {
    if (!row.parent_id) continue;
    const parent = nodes.get(nodes.get(row.id).feature);
    if (parent.kind === 'row') {
      if (parent.up === undefined) parent.up = parent.feature;
    } else {
      if (!parent.type && row.parent_type) parent.type = row.parent_type;
      if (!parent.title && row.parent_title) parent.title = row.parent_title;
    }
    if (!parent.up && row.grandparent_id) parent.up = itemNode(Number(row.grandparent_id), 'feature', '', row.project);
  }

  // Depends on: from a row to each row it depends on.
  for (const row of rows) {
    for (const item of dependenciesOf(row, rows).items) addEdge(row.id, item.row_id, 'depends');
  }

  // Same file: plans that name the same file, in the same repo only.
  const sharing = new Map();
  for (const row of rows) {
    for (const file of filesOf(row)) {
      const key = `${row.repo || ''}\n${file}`;
      if (!sharing.has(key)) sharing.set(key, []);
      sharing.get(key).push(row.id);
    }
  }
  // A file two or more plans name is a node of its own, and each of those rows points to it.
  let files = 0;
  for (const [key, ids] of sharing) {
    if (ids.length < 2 || ids.length > MAX_FILE_ROWS) continue;
    const at = key.indexOf('\n');
    const file = key.slice(at + 1);
    const repo = key.slice(0, at);
    const id = `file-${++files}`;
    nodes.set(id, { id, kind: 'file', label: file.split('/').pop(), title: file, repo });
    for (const rowId of ids) addEdge(rowId, id, 'file');
  }

  return { nodes: [...nodes.values()], edges };
}

module.exports = { build, fileOf };
