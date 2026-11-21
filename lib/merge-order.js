'use strict';

// The order to merge a repo's built rows, with one reason per step. No git
// and no files: lib/merge-candidates.js gathers the facts and calls this.
//
// steps: [{ id, lines, depends, in_branch, in_main }]: one per row that gets
//   its own merge. lines: added plus deleted lines against main. depends:
//   whether the row depends on any row. in_branch and in_main: the rows it
//   depends on that are not in this merge, by where their code already is
//   (the step's own branch, or main).
// inside: { row ID: [step IDs] }: rows that get no step, because their
//   branch is inside these steps' branches. Each is shown with the first of
//   them in the order: it comes in with that one.
// rules: [{ step, after, on, why }]: step goes after one of the steps in
//   `after` (a row that comes in with several steps is inside each of them).
//   on: the row the rule is about. why: 'depends' (step depends on it) or
//   'base' (step's Base branch is its branch).
// conflicts: [{ steps: [a, b], files }]: two steps that are likely to conflict.
// shared: [{ steps: [a, b], files }]: two steps that change a common file.

const path = require('path');
const { parseId } = require('./board');
const { listed } = require('./dependencies');

const numberOf = (id) => (parseId(id) || { number: Number.MAX_SAFE_INTEGER }).number;
// Lower row number first, compared as a number: PHIS-9 before PHIS-17.
const byNumber = (first, second) => numberOf(first.id) - numberOf(second.id) || String(first.id).localeCompare(String(second.id));
// Fewest changed lines first, then the lower row number.
const bySize = (first, second) => (first.lines || 0) - (second.lines || 0) || byNumber(first, second);

const fileNames = (files) => listed([...new Set(files.map((file) => path.posix.basename(String(file).replace(/\\/g, '/'))))]);

// The other step of each pair a step is in: Map(step → Map(other → files)).
function pairsOf(pairs) {
  const found = new Map();
  for (const pair of pairs) {
    const [first, second] = pair.steps;
    for (const [one, other] of [[first, second], [second, first]]) {
      if (!found.has(one)) found.set(one, new Map());
      found.get(one).set(other, [...(found.get(one).get(other) || []), ...(pair.files || [])]);
    }
  }
  return found;
}

// The steps in merge order, each with its reason: { ok: true, steps }. When
// the rules leave no step ready (a loop), { ok: false, stuck: [row IDs] }.
function orderSteps({ steps, inside = {}, rules = [], conflicts = [], shared = [] }) {
  const conflictsOf = pairsOf(conflicts);
  const sharedOf = pairsOf(shared);
  const rulesOf = (id) => rules.filter((rule) => rule.step === id);
  const placed = [];
  const done = new Map(); // step → its place
  let left = [...steps];

  while (left.length) {
    // 1. Ready: every hard rule of the step is placed.
    const ready = left.filter((step) => rulesOf(step.id).every((rule) => rule.after.some((id) => done.has(id))));
    if (!ready.length) return { ok: false, stuck: left.map((step) => step.id) };
    let next;
    // 2. A step that conflicts with no other: the lowest row number.
    const free = ready.filter((step) => !conflictsOf.has(step.id));
    if (free.length) next = [...free].sort(byNumber)[0];
    else {
      // 3. One that conflicts with the step just placed keeps them together.
      // 4. Otherwise the smallest.
      const last = placed[placed.length - 1];
      const near = last ? ready.filter((step) => conflictsOf.has(last.id) && conflictsOf.get(last.id).has(step.id)) : [];
      next = [...(near.length ? near : ready)].sort(bySize)[0];
    }
    done.set(next.id, placed.length);
    placed.push(next);
    left = left.filter((step) => step !== next);
  }

  // A row inside several steps comes in with the first of them.
  const comesWith = new Map(placed.map((step) => [step.id, []]));
  for (const [id, holders] of Object.entries(inside)) {
    const first = holders.filter((holder) => done.has(holder)).sort((one, other) => done.get(one) - done.get(other))[0];
    if (first) comesWith.get(first).push(id);
  }
  return {
    ok: true,
    steps: placed.map((step) => {
      const withIt = comesWith.get(step.id).sort((first, second) => byNumber({ id: first }, { id: second }));
      return { ...step, comes_with: withIt, reason: reasonOf({ ...step, comes_with: withIt }, { rulesOf, done, conflictsOf, sharedOf }) };
    }),
  };
}

// Why the step is where it is: its hard rules, the steps placed before it
// that it is likely to conflict with, and the rows that come in with it.
function reasonOf(step, { rulesOf, done, conflictsOf, sharedOf }) {
  const parts = [];
  const isBefore = (id) => done.has(id) && done.get(id) < done.get(step.id);
  for (const rule of rulesOf(step.id)) {
    // The step the rule was met by: the first one placed of those it points at.
    const target = [...rule.after].filter(isBefore).sort((first, second) => done.get(first) - done.get(second))[0];
    if (!target) continue;
    const inside = rule.on !== target ? `, which comes in with it` : '';
    if (rule.why === 'base') parts.push(`after ${target}: built on ${rule.on === target ? 'its' : `${rule.on}'s`} branch${inside}`);
    else parts.push(`after ${target}: depends on ${rule.on === target ? 'it' : rule.on}${inside}`);
  }
  const conflicting = conflictsOf.get(step.id) || new Map();
  for (const [other, files] of [...conflicting].filter(([id]) => isBefore(id)).sort(([first], [second]) => done.get(first) - done.get(second))) {
    parts.push(`after ${other}: both change ${fileNames(files)}, a conflict is likely`);
  }
  // The rows it depends on that are not in this merge, and where their code is.
  const settled = [];
  if ((step.in_branch || []).length) settled.push(`depends on ${listed(step.in_branch)}, already in its branch`);
  if ((step.in_main || []).length) settled.push(`depends on ${listed(step.in_main)}, already in main`);
  const comesWith = step.comes_with || [];
  if (!parts.length && !comesWith.length) {
    parts.push(...(settled.length ? settled : [step.depends ? 'depends on no row of this merge' : 'depends on no row']));
    // The first of two steps that conflict: the second one says so too.
    const later = [...conflicting].filter(([id]) => !isBefore(id)).sort(([first], [second]) => done.get(first) - done.get(second));
    const sharing = [...(sharedOf.get(step.id) || new Map())].filter(([id]) => !conflicting.has(id));
    if (later.length) parts.push(`before ${listed(later.map(([id]) => id))}: both change ${fileNames(later.flatMap(([, files]) => files))}, a conflict is likely`);
    else if (sharing.length) parts.push(`shares ${fileNames(sharing.flatMap(([, files]) => files))} with ${listed(sharing.map(([id]) => id))}, no conflict is likely`);
    // With one step there is no other step to share a file with.
    else if (done.size > 1) parts.push('no shared files');
  } else {
    parts.push(...settled);
  }
  if (comesWith.length) parts.push(`${listed(comesWith)} ${comesWith.length === 1 ? 'comes' : 'come'} in with it`);
  return parts.join('; ');
}

module.exports = { orderSteps };
