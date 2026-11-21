'use strict';

// Dependencies between rows: the only file that knows how they are found.
// Row B depends on row A when B can't be built or tested without A's code.
// A row keeps two lists: depends_on_rows (board row IDs, written for a split
// or set by the user) and predecessors (work item numbers of its Predecessor
// links in Azure DevOps). Everything else asks dependenciesOf. whereRowStarts
// says which branch implement starts a row from.

const config = require('./config');
const gitLib = require('./git');
const { rowBaseBranch } = require('./base-branch');

const listOf = (value) => (Array.isArray(value) ? value : []);

// The rows of a list by ID and by work item number. Built once per list,
// because the graph and the loop check ask for every row. So don't change a
// list after passing it here: pass a fresh one.
const indexes = new WeakMap();
function indexOf(rows) {
  if (!indexes.has(rows)) {
    const byId = new Map();
    const byWorkItem = new Map();
    for (const other of rows) {
      byId.set(other.id, other);
      if (other.work_item && other.work_item.id) byWorkItem.set(Number(other.work_item.id), other);
    }
    indexes.set(rows, { byId, byWorkItem });
  }
  return indexes.get(rows);
}

// The rows a row depends on. rows: the board's rows (full rows or summaries).
// Returns { items, notes }: one item per dependency, with `from` saying which
// list it came from ("row", "ado" or "both"), and a note for each entry that
// is not a row on the board. A row in both lists counts once.
function dependenciesOf(row, rows) {
  const { byId, byWorkItem } = indexOf(listOf(rows));
  const from = new Map();
  const notes = [];
  for (const id of listOf(row.depends_on_rows)) {
    if (id === row.id || from.has(id)) continue;
    if (byId.has(id)) from.set(id, 'row');
    else notes.push(`${id} is not a row on this board any more.`);
  }
  for (const value of listOf(row.predecessors)) {
    const other = byWorkItem.get(Number(value));
    if (!other) notes.push(`#${value} is a Predecessor in Azure DevOps but not a row on this board.`);
    else if (other.id !== row.id) from.set(other.id, from.get(other.id) === 'ado' || !from.has(other.id) ? 'ado' : 'both');
  }
  const items = [...from].map(([id, list]) => {
    const other = byId.get(id);
    return {
      row_id: other.id,
      title: other.title || '',
      work_item: other.work_item && other.work_item.id ? Number(other.work_item.id) : null,
      status: other.status || '',
      repo: other.repo || '',
      branch: other.branch || null,
      merged_into: other.merged_into || null,
      before_merge_head: other.before_merge_head || null,
      from: list,
    };
  });
  return { items, notes };
}

// The items of a loop, in order (each depends on the next, and the last on
// the first), or null. links: a Map from an item to the items it depends on
// (positions in a split, row IDs on the board). With start, only a loop that
// goes through that item.
function findLoop(links, start) {
  const through = (from) => {
    // The shortest way from the item back to itself.
    const cameFrom = new Map();
    const queue = [from];
    while (queue.length) {
      const item = queue.shift();
      for (const dependency of listOf(links.get(item))) {
        if (dependency === from) {
          const loop = [item];
          while (loop[0] !== from) loop.unshift(cameFrom.get(loop[0]));
          return loop;
        }
        if (!cameFrom.has(dependency)) {
          cameFrom.set(dependency, item);
          queue.push(dependency);
        }
      }
    }
    return null;
  };
  if (start !== undefined) return through(start);
  for (const item of links.keys()) {
    const loop = through(item);
    if (loop) return loop;
  }
  return null;
}

// "A", "A and B", "A, B and C".
const listed = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : String(names[0] ?? ''));

// What the user reads when rows depend on each other in a loop.
function loopMessage(ids) {
  const sorted = [...ids].sort((first, second) => String(first).localeCompare(String(second), 'en', { numeric: true }));
  return `${listed(sorted)} depend on each other. Remove one of these links on the board, then run again.`;
}

// True when the status is the board's Implemented, Merged or Done status.
const isBuilt = (status, roles) => [roles.implemented_status, roles.merged_status, roles.done_status].some((name) => config.sameName(name, status));

// The local branch that has a row's code: its own branch when it is here.
// Otherwise, for a Merged row, the integration branch it was merged into,
// when that is here. Otherwise null. item: a row, or a dependenciesOf item.
function branchOf(item, repoPath, roles) {
  const here = (name) => config.isBranchName(name) && gitLib.localBranchExists(repoPath, name);
  if (here(item.branch)) return item.branch;
  if (config.sameName(item.status, roles.merged_status) && here(item.merged_into)) return item.merged_into;
  return null;
}

// Whether branch x holds branch y: y's last commit is one of x's commits.
// Returns { ok: true, holds } or { ok: false, error } when git can't tell
// (a name that doesn't exist).
function holds(repoPath, x, y) {
  const result = gitLib.git(repoPath, ['merge-base', '--is-ancestor', y, x]);
  if (result.status === 0) return { ok: true, holds: true };
  if (result.status === 1) return { ok: true, holds: false };
  return { ok: false, error: result.error };
}

// Whether the branch's work is already in mainRef. Yes when mainRef holds the
// branch. Otherwise a test merge of the branch into mainRef: when it is clean
// and changes nothing, main already has the same changes, which is how a
// squash merge is recognised. A conflict means not in main.
// Returns { ok: true, inMain }, or { ok: false, error } (old_git: true when
// the test merge is needed and the installed Git can't do it).
function isInMain(repoPath, branch, mainRef) {
  const held = holds(repoPath, mainRef, branch);
  if (!held.ok) return held;
  if (held.holds) return { ok: true, inMain: true };
  if (!gitLib.hasMergeTree(gitLib.version())) return { ok: false, old_git: true, error: `Git is older than ${gitLib.MERGE_TREE_GIT}` };
  const merged = gitLib.mergeTree(repoPath, mainRef, branch);
  if (!merged.ok) return { ok: false, error: merged.error };
  if (!merged.clean) return { ok: true, inMain: false };
  const tree = gitLib.git(repoPath, ['rev-parse', `${mainRef}^{tree}`]);
  if (!tree.ok) return { ok: false, error: tree.error };
  return { ok: true, inMain: merged.tree === tree.stdout };
}

// The other rows of the same repo whose branch is the row's Base branch: their
// own branch, or the branch they were merged into. Those branches are local.
const baseBranchRows = (row, rows) => {
  const base = rowBaseBranch(row);
  return base ? rows.filter((other) => other.id !== row.id && config.sameName(other.repo, row.repo) && (other.branch === base || other.merged_into === base)) : [];
};

// Where a row's own work is, and only its own: its branch when it is still
// here, or else the last commit of that branch, kept when a merge set the row
// to Merged (before_merge_head). Not the integration branch, which also holds
// other rows. null when neither is here. item: a row, or a dependenciesOf item.
function ownWork(item, repoPath) {
  if (config.isBranchName(item.branch) && gitLib.localBranchExists(repoPath, item.branch)) return item.branch;
  const commit = gitLib.isCommit(item.before_merge_head) ? item.before_merge_head : null;
  return commit && gitLib.git(repoPath, ['cat-file', '-e', `${commit}^{commit}`]).ok ? commit : null;
}

// A row built on another row's branch waits for that row like for a
// dependency: the first such row that is not built, or null.
const unbuiltBase = (row, rows, roles) => baseBranchRows(row, rows).find((other) => !isBuilt(other.status, roles)) || null;

// The dependencies between the rows that pass `wanted`, as row IDs, for
// findLoop. wanted is asked of rows and of dependenciesOf items (row_id).
const rowLinks = (rows, wanted) => new Map(rows.filter(wanted)
  .map((row) => [row.id, dependenciesOf(row, rows).items.filter(wanted).map((item) => item.row_id)]));

// Where implement starts a row: { start: { ref, local, reason }, notes }, or
// { stop: message, notes }. start.ref is origin/<main>, origin/<base> or a
// local branch name, and start.local says which kind. When the start is a
// dependency's branch, start.row_id is that dependency. dependencies lists
// the row's dependencies with where their code is: "main", "branch" (the
// branch the row starts from), or null when that wasn't looked at.
// row: the row to start. rows: the rows of its project. repo: its configured
// repo. cfg: the loaded config. It writes nothing. The checks run in order,
// and the first one that applies decides.
function whereRowStarts(row, rows, repo, cfg) {
  const roles = cfg.board.items;
  const mainRef = `origin/${repo.main_branch}`;
  const inThisRepo = (other) => config.sameName(other.repo, row.repo);
  const found = dependenciesOf(row, rows);
  const notes = [...found.notes];
  const dependencies = found.items.map((item) => ({ ...item, in: null }));
  const start = (ref, local, reason, extra = {}) => ({ start: { ref, local, reason, row_id: null, ...extra }, notes, dependencies });
  const stop = (message) => ({ stop: message, notes, dependencies });

  // 1. A Base branch decides, whatever the dependencies are. When it is
  // another row's branch, or the branch a row was merged into, in this repo,
  // it was never pushed: the local branch. That row must be built first.
  const base = rowBaseBranch(row);
  if (base) {
    const waitsFor = unbuiltBase(row, rows, roles);
    if (waitsFor) return stop(`${row.id} is built on ${waitsFor.id}'s branch, and ${waitsFor.id} is ${waitsFor.status}. Finish ${waitsFor.id} first, then run again.`);
    const ofARow = baseBranchRows(row, rows).length > 0;
    const local = ofARow && gitLib.localBranchExists(repo.path, base);
    return start(local ? base : `origin/${base}`, local, 'It is the row\'s Base branch.');
  }

  // 2. No dependencies: main, as always.
  if (!dependencies.length) return start(mainRef, false, 'It depends on no other row.');

  // 3. A loop through this row, among the rows of its repo: a dependency in
  // another repo never stops the row.
  const loop = findLoop(rowLinks(rows, inThisRepo), row.id);
  if (loop) return stop(loopMessage(loop));

  // A dependency in another repo never changes where the row starts.
  const mine = [];
  for (const dependency of dependencies) {
    if (inThisRepo(dependency)) mine.push(dependency);
    else notes.push(`${dependency.row_id} ${dependency.repo ? `is in repo ${dependency.repo}` : 'has no repo'}, so it does not change where this row starts.`);
  }

  // 4. Every dependency must be built first.
  for (const dependency of mine) {
    if (isBuilt(dependency.status, roles)) continue;
    return stop(dependency.branch
      ? `${row.id} depends on ${dependency.row_id}, which is ${dependency.status}. Finish ${dependency.row_id} first, then run again.`
      : `${row.id} depends on ${dependency.row_id}, which is not implemented and has no branch. Implement ${dependency.row_id} first.`);
  }

  // 5. Done means the code is in main: the branch is not looked up.
  const waiting = [];
  for (const dependency of mine) {
    if (config.sameName(dependency.status, roles.done_status)) dependency.in = 'main';
    else waiting.push(dependency);
  }

  // 6. An Implemented or Merged dependency's code must be here, on a local
  // branch (branchOf): its own branch, or the one a Merged row went into.
  // `at` is that branch, which checks 7 to 10 look at.
  for (const dependency of waiting) {
    dependency.at = branchOf(dependency, repo.path, roles);
    if (!dependency.at) {
      const named = dependency.branch ? `${dependency.row_id}'s branch ${dependency.branch} was not found in ${repo.name}` : `${dependency.row_id} has no branch`;
      return stop(`${named}. Correct the branch on ${dependency.row_id}, or implement ${dependency.row_id} first.`);
    }
  }

  // 7. Which of them are already in main.
  const notInMain = [];
  for (const dependency of waiting) {
    const checked = isInMain(repo.path, dependency.at, mainRef);
    if (!checked.ok) {
      return stop(checked.old_git
        ? `Spadework needs Git ${gitLib.MERGE_TREE_GIT} or newer to check whether ${dependency.row_id}'s branch is in main. Update Git, or set ${row.id}'s Base branch.`
        : `Couldn't check whether ${dependency.row_id}'s branch ${dependency.at} is in main: ${checked.error}. Fix that, or set ${row.id}'s Base branch.`);
    }
    dependency.in = checked.inMain ? 'main' : 'branch';
    // Two rows on one branch are one branch to start from.
    if (!checked.inMain && !notInMain.some((other) => other.at === dependency.at)) notInMain.push(dependency);
  }
  if (!notInMain.length) return start(mainRef, false, mine.length ? 'Every row it depends on is already in main.' : 'No row it depends on is in this repo.');

  // A dependency's branch must also have the code of the dependencies that
  // are in main: it may have left main before they got there. Asked of the
  // dependency's own work (ownWork). Without it there is nothing to compare.
  const lacks = (branch) => mine.find((dependency) => {
    const work = dependency.in === 'main' ? ownWork(dependency, repo.path) : null;
    if (!work) return false;
    const checked = isInMain(repo.path, work, branch);
    return checked.ok && !checked.inMain;
  });
  const startFrom = (chosen, reason, extra = {}) => {
    const missing = lacks(chosen.at);
    // The branch a Merged row went into is not that row's own branch: say so.
    const mergedInto = chosen.at !== chosen.branch;
    const whose = mergedInto ? `the branch ${chosen.row_id} was merged into` : `${chosen.row_id}'s branch`;
    return missing
      ? stop(`${row.id} starts from ${whose}, which does not have ${missing.row_id}'s code. Update ${chosen.at} from main, or set ${row.id}'s Base branch, then run again.`)
      : start(chosen.at, true, reason, { row_id: chosen.row_id, ...(mergedInto ? { merged_into: true } : {}), ...extra });
  };

  // 8. One branch is not in main: start from it.
  if (notInMain.length === 1) return startFrom(notInMain[0], `${notInMain[0].row_id} is not in main yet.`);

  // 9. Several: one of them may already hold all the others.
  for (const candidate of notInMain) {
    const others = notInMain.filter((other) => other !== candidate);
    const answers = others.map((other) => holds(repo.path, candidate.at, other.at));
    if (answers.every((answer) => answer.ok && answer.holds)) {
      const names = others.map((other) => `${other.row_id}'s`);
      return startFrom(candidate, `It already holds ${listed(names)} ${others.length === 1 ? 'branch' : 'branches'}.`, { holds: others.map((other) => other.row_id) });
    }
  }

  // 10. No branch holds the others: the user picks.
  return stop(`${row.id} depends on ${listed(notInMain.map((dependency) => `${dependency.row_id} (branch ${dependency.at})`))}. Set ${row.id}'s Base branch to the branch it should start from, then run again.`);
}

module.exports = { dependenciesOf, findLoop, loopMessage, listed, rowLinks, baseBranchRows, unbuiltBase, ownWork, isBuilt, branchOf, holds, isInMain, whereRowStarts };
