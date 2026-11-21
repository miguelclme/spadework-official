'use strict';

// The facts the merge order needs, read with git, and the order itself:
// planOrder. It works on one repo: its Implemented rows, or the rows given.
// The rules, in the order they apply:
//   1. candidates: Implemented rows of the repo, or the IDs given (with the
//      Implemented dependencies they need, added)
//   2. a candidate whose branch is already in main is not merged again
//   3. a loop among the candidates' dependencies stops the plan
//   4. a row that can't go in yet is held back, with every row that needs it
//   5. a row whose branch is inside another candidate's branch gets no merge
//      of its own: it comes in with that one
//   6. hard rules: after its dependencies, and after the row whose branch it
//      was built on
//   7. which steps are likely to conflict (a test merge of each pair that
//      changes a common file)
//   8, 9. the order and its reasons (lib/merge-order.js)
//   10. one step that merges into main with no conflict needs no integration
//      branch: the row's own branch is the one to push
// planOrder writes nothing. With fetch, it brings origin/<main> up to date first.

const board = require('./board');
const config = require('./config');
const gitLib = require('./git');
const { rowBaseBranch } = require('./base-branch');
const { dependenciesOf, findLoop, loopMessage, listed, isBuilt, ownWork, holds, isInMain, rowLinks, baseBranchRows, unbuiltBase } = require('./dependencies');
const { orderSteps } = require('./merge-order');

const MAX_TITLE = 50;

// "Merge order for <repo>: ..." and the lines after it.
function planText(plan, { into = null } = {}) {
  const count = plan.steps.reduce((sum, step) => sum + 1 + step.comes_with.length, 0);
  const lines = [];
  if (!plan.steps.length) lines.push(`Nothing to merge in ${plan.repo.display}.`);
  else {
    lines.push(`Merge order for ${plan.repo.display}: ${count} ${count === 1 ? 'row' : 'rows'}${into ? ` into ${into}` : ''}`, '');
    const cut = (text) => (text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE - 1)}…` : text);
    const numberWidth = String(plan.steps.length).length + 1;
    const idWidth = Math.max(...plan.steps.map((step) => step.id.length)) + 2;
    const titleWidth = Math.max(...plan.steps.map((step) => cut(step.title).length)) + 2;
    plan.steps.forEach((step, index) => {
      lines.push(`${String(index + 1).padStart(numberWidth)}. ${step.id.padEnd(idWidth)}${cut(step.title).padEnd(titleWidth)}${step.reason}`);
    });
  }
  if (plan.lines.length) lines.push('', ...plan.lines);
  if (plan.one_branch) lines.push('', ...oneBranchLines(plan));
  return lines.join('\n');
}

// What is printed when the order is one step that merges into main with no
// conflict: no integration branch, the row's own branch is pushed.
function oneBranchLines(plan) {
  const { branch, rows, status } = plan.one_branch;
  return [
    `Only one branch to merge, and it merges into ${plan.main_ref} with no conflict. So no new branch is made: push ${branch}.`,
    `  git log ${plan.main_ref}..${branch}`,
    `  git diff ${plan.main_ref}...${branch}`,
    `  git push -u origin ${branch}`,
    `Then open one pull request. ${listed(rows)} ${rows.length === 1 ? 'stays' : 'stay'} ${status}, and no test command runs: test the branch yourself.`,
  ];
}

// The plan for a repo: { ok: true, plan, text } or { ok: false, error }.
// rowIds: the rows to merge, or none for every Implemented row of the repo.
function planOrder(cfg, repo, { rowIds = null, fetch = true } = {}) {
  if (!gitLib.hasMergeTree(gitLib.version())) return { ok: false, error: `Spadework needs Git ${gitLib.MERGE_TREE_GIT} or newer to work out the merge order. Update Git.` };
  const mainRef = `origin/${repo.main_branch}`;
  if (fetch) {
    const fetched = gitLib.fetchBranch(repo.path, repo.main_branch);
    if (!fetched.ok) return { ok: false, error: `git fetch failed in ${repo.path}: ${fetched.error}` };
  }
  const mainOid = gitLib.git(repo.path, ['rev-parse', '--verify', '--quiet', `${mainRef}^{commit}`]);
  if (!mainOid.ok || !mainOid.stdout) return { ok: false, error: `${mainRef} was not found in ${repo.path}. Fetch it, then run again.` };

  const roles = cfg.board.items;
  const prefix = board.prefixOf(cfg, repo.project);
  const rows = prefix ? board.listRows({ prefix }).rows : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const inRepo = (row) => config.sameName(row.repo, repo.name);
  const isImplemented = (row) => config.sameName(row.status, roles.implemented_status);
  const branchHere = (name) => config.isBranchName(name) && gitLib.localBranchExists(repo.path, name);
  const inMainNow = (row) => {
    if (!branchHere(row.branch)) return false;
    const checked = isInMain(repo.path, row.branch, mainRef);
    return checked.ok && checked.inMain;
  };
  const dependenciesHere = (row) => dependenciesOf(row, rows).items.filter((item) => inRepo(item)).map((item) => byId.get(item.row_id));
  // Where the code of a row that `row` depends on already is: 'main',
  // 'branch' (row's own branch), 'neither', or null when git can't tell. Done
  // means in main. Otherwise its own work is asked, not the whole integration
  // branch, which also holds other rows.
  const codeOf = (item, row) => {
    if (config.sameName(item.status, roles.done_status)) return 'main';
    const work = ownWork(item, repo.path);
    if (!work) return null;
    const inMain = isInMain(repo.path, work, mainRef);
    if (inMain.ok && inMain.inMain) return 'main';
    const inBranch = isInMain(repo.path, work, row.branch);
    if (!inMain.ok || !inBranch.ok) return null;
    return inBranch.inMain ? 'branch' : 'neither';
  };

  const added = [];
  const alreadyInMain = [];
  const heldBack = [];
  const notImplemented = [];
  const notes = [];
  const note = (text) => { if (!notes.includes(text)) notes.push(text); };

  // 1. The candidates.
  let candidates;
  if (rowIds && rowIds.length) {
    candidates = [];
    for (const id of rowIds) {
      const row = byId.get(id);
      if (!row) note(`${id} is not a row on this board.`);
      else if (!inRepo(row)) note(`${id} is in repo ${row.repo || '(none)'}, not in ${repo.name}.`);
      else if (!isImplemented(row)) notImplemented.push(`Not Implemented: ${id} (${row.status}).`);
      else if (!candidates.includes(row)) candidates.push(row);
    }
    // A dependency the rows can't go in without, that is Implemented and not in main yet.
    for (let index = 0; index < candidates.length; index++) {
      const row = candidates[index];
      for (const dependency of dependenciesHere(row)) {
        if (candidates.includes(dependency) || !isImplemented(dependency) || inMainNow(dependency)) continue;
        candidates.push(dependency);
        added.push(`${dependency.id} added: ${row.id} depends on it.`);
      }
    }
  } else {
    candidates = rows.filter((row) => inRepo(row) && isImplemented(row));
  }

  // 2. Already in main.
  candidates = candidates.filter((row) => {
    if (!inMainNow(row)) return true;
    alreadyInMain.push(`Already in main: ${row.id}.`);
    return false;
  });

  // 3. A loop among the candidates' dependencies.
  const isCandidate = (row) => candidates.includes(row);
  const loop = findLoop(rowLinks(rows, (row) => candidates.some((candidate) => candidate.id === (row.id || row.row_id))));
  if (loop) return { ok: false, error: loopMessage(loop) };

  // 4. Held back. A Base branch is a row's branch when it is another row's
  // branch, or the branch another row was merged into, in this repo. That
  // row must be built, as a dependency must.
  const held = new Map(); // row → reason
  for (const row of candidates) {
    const notBuilt = dependenciesHere(row).find((dependency) => !isBuilt(dependency.status, roles));
    const base = rowBaseBranch(row);
    const unbuilt = unbuiltBase(row, rows, roles);
    if (notBuilt) held.set(row, `it depends on ${notBuilt.id}, which is ${notBuilt.status}`);
    else if (unbuilt) held.set(row, `it is built on ${unbuilt.id}'s branch, and ${unbuilt.id} is ${unbuilt.status}`);
    else if (base && !baseBranchRows(row, rows).length && !(isInMain(repo.path, `origin/${base}`, mainRef).inMain)) {
      held.set(row, `it is built on ${base}, which is not a row's branch and is not in main`);
    } else if (!branchHere(row.branch)) {
      held.set(row, row.branch ? `${row.id}'s branch ${row.branch} was not found in ${repo.name}` : `${row.id} has no branch`);
    }
  }
  // Every row that needs a held-back row is held back too.
  for (let changed = true; changed;) {
    changed = false;
    for (const row of candidates) {
      if (held.has(row)) continue;
      const needed = dependenciesHere(row).find((dependency) => held.has(dependency));
      const base = rowBaseBranch(row);
      const builtOn = base ? candidates.find((other) => other !== row && held.has(other) && other.branch === base) : null;
      if (needed) held.set(row, `it depends on ${needed.id}, which is held back`);
      else if (builtOn) held.set(row, `it is built on ${builtOn.id}'s branch, which is held back`);
      else continue;
      changed = true;
    }
  }
  for (const [row, reason] of held) heldBack.push(`Held back: ${row.id}, because ${reason}.`);
  candidates = candidates.filter((row) => !held.has(row));

  // 5. Comes in with: a branch inside another candidate's branch. Two rows on
  // the same commit: the lower row number gets the step.
  const tip = new Map(candidates.map((row) => [row, gitLib.git(repo.path, ['rev-parse', `${row.branch}^{commit}`]).stdout]));
  const holdsRow = (outer, inner) => outer !== inner && holds(repo.path, outer.branch, inner.branch).holds === true;
  const firstOf = (first, second) => (board.parseId(first.id) || {}).number < (board.parseId(second.id) || {}).number;
  const isInside = (inner, outer) => holdsRow(outer, inner) && (tip.get(outer) !== tip.get(inner) || firstOf(outer, inner));
  const steps = candidates.filter((row) => !candidates.some((outer) => isInside(row, outer)));
  const inside = {};
  for (const row of candidates) {
    if (!steps.includes(row)) inside[row.id] = steps.filter((step) => holdsRow(step, row)).map((step) => step.id);
  }

  // 6. Hard rules. One to a row that comes in with steps points at those steps.
  const stepsOf = (row) => (steps.includes(row) ? [row.id] : inside[row.id] || []);
  const rules = [];
  for (const row of steps) {
    const add = (other, why) => {
      if (!isCandidate(other) || other === row) return;
      const after = stepsOf(other);
      // A row inside this step's branch comes in with it: no rule.
      if (after.includes(row.id)) return;
      rules.push({ step: row.id, after, on: other.id, why });
    };
    for (const dependency of dependenciesHere(row)) add(dependency, 'depends');
    const base = rowBaseBranch(row);
    const builtOn = base ? candidates.find((other) => other !== row && other.branch === base) : null;
    // Implement saves a dependency's branch as the Base branch: one rule says it, not two.
    if (builtOn && !dependenciesHere(row).includes(builtOn)) add(builtOn, 'base');
  }

  // 7. Likely conflicts, from the files each step changes.
  const changes = new Map(steps.map((row) => {
    const files = new Map();
    for (const line of gitLib.outputLines(gitLib.git(repo.path, ['-c', 'core.quotePath=false', 'diff', '--numstat', `${mainRef}...${row.branch}`]))) {
      const [added_, deleted, ...name] = line.split('\t');
      files.set(name.join('\t'), (Number(added_) || 0) + (Number(deleted) || 0));
    }
    return [row.id, files];
  }));
  const conflicts = [];
  const shared = [];
  for (let first = 0; first < steps.length; first++) {
    for (let second = first + 1; second < steps.length; second++) {
      const [one, other] = [steps[first], steps[second]];
      const common = [...changes.get(one.id).keys()].filter((file) => changes.get(other.id).has(file));
      if (!common.length) continue;
      const merged = gitLib.mergeTree(repo.path, one.branch, other.branch);
      if (merged.ok && !merged.clean) conflicts.push({ steps: [one.id, other.id], files: merged.files.length ? merged.files : common });
      else shared.push({ steps: [one.id, other.id], files: common });
    }
  }

  // The rows a step depends on that are not in this merge, by where their code is.
  const settledOf = (row) => {
    const found = { branch: [], main: [] };
    for (const dependency of dependenciesHere(row)) {
      const where = isCandidate(dependency) ? null : codeOf(dependency, row);
      if (found[where]) found[where].push(dependency.id);
    }
    // By row number, whatever order the row lists them in.
    const number = (id) => (board.parseId(id) || { number: 0 }).number;
    for (const list of Object.values(found)) list.sort((first, second) => number(first) - number(second));
    return found;
  };

  // 8, 9. The order and the reasons.
  const ordered = orderSteps({
    steps: steps.map((row) => {
      const settled = settledOf(row);
      return {
        id: row.id,
        lines: [...changes.get(row.id).values()].reduce((sum, count) => sum + count, 0),
        depends: dependenciesOf(row, rows).items.length > 0,
        in_branch: settled.branch,
        in_main: settled.main,
      };
    }),
    inside,
    rules,
    conflicts,
    shared,
  });
  if (!ordered.ok) return { ok: false, error: loopMessage(ordered.stuck) };

  // Notes, which never hold a row back.
  for (const row of [...steps, ...candidates.filter((other) => !steps.includes(other))]) {
    const found = dependenciesOf(row, rows);
    for (const text of found.notes) note(`${row.id}: ${text}`);
    for (const item of found.items) {
      if (!inRepo(item)) {
        note(`${item.row_id} ${item.repo ? `is in repo ${item.repo}` : 'has no repo'}, so it does not hold this row back.`);
        continue;
      }
      // A Merged dependency's work is in an integration branch: is it in main,
      // or in this row's branch?
      if (config.sameName(item.status, roles.merged_status) && codeOf(item, row) === 'neither') {
        note(item.merged_into
          ? `${row.id} depends on ${item.row_id}, which is in ${item.merged_into} but not in main. Merge ${item.merged_into} into ${row.id}'s branch, then run again.`
          : `${row.id} depends on ${item.row_id}, which is Merged but not in main: this branch will not have its code.`);
      }
    }
  }

  // An integration branch that is not in main and is inside a step's branch:
  // the rows merged into it come along with that step.
  const isMerged = (row) => inRepo(row) && config.sameName(row.status, roles.merged_status);
  const mergeBranches = [...new Set(rows.filter((row) => isMerged(row) && branchHere(row.merged_into)).map((row) => row.merged_into))]
    .filter((name) => isInMain(repo.path, name, mainRef).inMain === false);
  const carries = {};
  for (const row of steps) {
    carries[row.id] = mergeBranches.filter((name) => holds(repo.path, row.branch, name).holds === true)
      .map((name) => ({ branch: name, rows: rows.filter((other) => isMerged(other) && other.merged_into === name).map((other) => other.id) }));
    for (const held of carries[row.id]) note(`${row.id}'s branch also holds ${held.branch} (${listed(held.rows)}), which is not in main.`);
  }

  // 10. One step that merges into main with no conflict.
  let oneBranch = null;
  if (ordered.steps.length === 1) {
    const only = ordered.steps[0];
    const tested = gitLib.mergeTree(repo.path, mainRef, byId.get(only.id).branch);
    if (tested.ok && tested.clean) oneBranch = { branch: byId.get(only.id).branch, rows: [only.id, ...only.comes_with], status: roles.implemented_status };
  }

  const rowOf = (id) => byId.get(id);
  const plan = {
    repo: { name: repo.name, project: repo.project, label: config.repoLabel(repo), display: config.repoDisplay(repo), path: repo.path, main_branch: repo.main_branch },
    main_ref: mainRef,
    main_oid: mainOid.stdout,
    steps: ordered.steps.map((step) => ({
      id: step.id,
      title: rowOf(step.id).title || '',
      branch: rowOf(step.id).branch,
      reason: step.reason,
      lines: step.lines,
      // Each hard rule: the steps of which one must be merged first.
      after: rules.filter((rule) => rule.step === step.id).map((rule) => rule.after),
      comes_with: step.comes_with.map((id) => ({ id, title: rowOf(id).title || '', branch: rowOf(id).branch })),
      // The integration branches inside its branch that are not in main, with their rows.
      carries: carries[step.id] || [],
    })),
    // Set when the order is one step that merges into main with no conflict:
    // { branch, rows, status }. No integration branch is made for it.
    one_branch: oneBranch,
    lines: [...added, ...alreadyInMain, ...heldBack, ...notImplemented, ...notes],
    // The rows with no step of their own, and the steps whose branch holds them.
    inside,
  };
  return { ok: true, plan, text: planText(plan) };
}

module.exports = { planOrder, planText };
