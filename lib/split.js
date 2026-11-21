'use strict';

// What a planner returns when it splits a Feature: the Feature's own
// sections, then one "# Requirement: <title>" block per Requirement. This
// file reads that text and checks every Requirement has what handoff needs.

const config = require('./config');
const { findLoop } = require('./dependencies');

const REQUIREMENT_SECTIONS = ['What to build', 'Contract', 'Acceptance criteria', 'Depends on'];
const REQUIREMENT_HEADING = /^# Requirement: *(.*)$/;

// Which lines are inside a fenced code block (``` or ~~~), fences included.
// A "## " line inside one is code, not a section of the page.
function fencedLines(lines) {
  let fence = null;
  return lines.map((line) => {
    const trimmed = line.trim();
    const mark = trimmed.match(/^(`{3,}|~{3,})/);
    if (fence) {
      if (mark && trimmed === mark[1] && mark[1][0] === fence[0] && mark[1].length >= fence.length) fence = null;
      return true;
    }
    if (mark) {
      fence = mark[1];
      return true;
    }
    return false;
  });
}

// The text under a "## <name>" heading, up to the next "## ", or null.
// Headings inside code blocks don't count.
function sectionText(text, name) {
  const lines = String(text || '').split(/\r?\n/);
  const inside = fencedLines(lines);
  const start = lines.findIndex((line, i) => !inside[i] && line.trim().toLowerCase() === `## ${name}`.toLowerCase());
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line, i) => !inside[start + 1 + i] && /^## /.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}

// What is wrong with one Requirement's text: a section missing or empty.
// "Depends on" may say nothing. Used when a split is parsed.
function requirementErrors(label, body) {
  const errors = [];
  for (const name of REQUIREMENT_SECTIONS) {
    const content = sectionText(body, name);
    if (content === null) errors.push(`${label} has no "## ${name}" section`);
    else if (!content && name !== 'Depends on') errors.push(`${label}: "## ${name}" is empty`);
  }
  return errors;
}

// What is wrong with one Requirement's spec (the fields of a row): an empty
// field. "Depends on" may say nothing. Handoff uses it on the spec as the tech
// lead may have edited it on the board.
const SPEC_FIELDS = { what_to_build: 'What to build', contract: 'Contract', acceptance: 'Acceptance criteria', depends_on: 'Depends on' };
function specErrors(label, spec) {
  const value = spec || {};
  return Object.entries(SPEC_FIELDS)
    .filter(([key]) => key !== 'depends_on' && !String(value[key] ?? '').trim())
    .map(([, name]) => `${label}: "## ${name}" is empty`);
}

// A spec as Markdown, with the same sections a planner writes: the Part line,
// then the sections that have something in them.
function specText(spec) {
  const value = spec || {};
  const part = String(value.part ?? '').trim();
  const lines = part ? [`Part: ${part}`] : [];
  for (const [key, name] of Object.entries(SPEC_FIELDS)) {
    const text = String(value[key] ?? '').trim();
    if (text) lines.push(`## ${name}`, text);
  }
  return lines.join('\n');
}

// What a "## Depends on" section says when the Requirement depends on nothing.
const NOTHING = 'Nothing.';

// The planner's "Depends on" text as notes under a list of the rows a row
// depends on: nothing when it is empty, or only says there is nothing.
function dependsOnNotes(spec) {
  const text = String((spec && spec.depends_on) ?? '').trim();
  return text === NOTHING ? '' : text;
}

// A curly quote is read as a straight one.
const straightQuotes = (text) => String(text ?? '').replace(/[“”]/g, '"');

// What one "## Depends on" section names: [] for the single word Nothing.,
// the quoted name of each `- "<title>": <why>` line, or null when the section
// is neither. titles: the Requirements' titles, so that a title with a quote
// or a colon in it is still read whole.
function dependsOnNames(text, titles) {
  const lines = straightQuotes(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 1 && lines[0] === NOTHING) return [];
  const names = [];
  for (const line of lines) {
    const known = titles
      .filter((title) => line.startsWith(`- "${title}":`) && line.slice(`- "${title}":`.length).trim())
      .sort((first, second) => second.length - first.length)[0];
    const match = known === undefined ? line.match(/^- "(.+?)":\s*\S/) : null;
    if (known === undefined && !match) return null;
    names.push(known === undefined ? match[1] : known);
  }
  return names.length ? names : null;
}

// Checks every "## Depends on" section against the titles of the answer.
// Titles are compared whole. Returns { errors, positions }: for each block,
// the places in the answer (0 for the first) of the Requirements it depends on.
function dependsOnCheck(blocks) {
  const errors = [];
  const titles = blocks.map((block) => straightQuotes(block.title));
  for (const title of new Set(titles.filter((title, index) => title && titles.indexOf(title) !== index))) {
    errors.push(`two Requirements have the title "${blocks[titles.indexOf(title)].title}"`);
  }
  const positions = blocks.map(() => []);
  blocks.forEach((block, index) => {
    const section = sectionText(block.body, 'Depends on');
    if (section === null) return;
    const label = block.title || `Requirement ${index + 1}`;
    const names = dependsOnNames(section, titles.filter(Boolean));
    if (!names) {
      errors.push(`${label}: "## Depends on" must be the word Nothing. or lines like - "<title>": <why>`);
      return;
    }
    for (const name of names) {
      const at = titles.indexOf(name);
      if (at === -1) errors.push(`${label}: "## Depends on" names "${name}", which is not a Requirement of this split`);
      else if (at === index) errors.push(`${label}: "## Depends on" names itself`);
      else if (!positions[index].includes(at)) positions[index].push(at);
    }
  });
  if (!errors.length) {
    const loop = findLoop(new Map(positions.map((list, index) => [index, list])));
    if (loop) errors.push(`these Requirements depend on each other in a loop: ${loop.map((at) => `"${blocks[at].title}"`).join(', ')}`);
  }
  return { errors, positions };
}

// Splits an agent's text into the Feature part and its Requirements, and
// checks each Requirement has every section with something in it, and that
// its "## Depends on" names only other Requirements of the answer. A
// "# Requirement:" line inside a code block doesn't start a Requirement.
// Each Requirement gets depends_on: the places in the answer of the ones it
// depends on.
function parseSplit(text) {
  const lines = String(text || '').split(/\r?\n/);
  const inside = fencedLines(lines);
  const featureLines = [];
  const blocks = [];
  lines.forEach((line, i) => {
    const heading = inside[i] ? null : line.match(REQUIREMENT_HEADING);
    if (heading) blocks.push({ title: heading[1].trim(), lines: [] });
    else (blocks.length ? blocks[blocks.length - 1].lines : featureLines).push(line);
  });

  const requirements = [];
  const errors = [];
  blocks.forEach((block, index) => {
    block.body = block.lines.join('\n').trim();
    const label = block.title || `Requirement ${index + 1}`;
    if (!block.title) errors.push(`${label} has no title`);
    errors.push(...requirementErrors(label, block.body));
  });
  const dependsOn = dependsOnCheck(blocks);
  errors.push(...dependsOn.errors);
  blocks.forEach((block, index) => {
    if (block.title) requirements.push({ title: block.title, content: block.body, depends_on: dependsOn.positions[index] });
  });
  if (!blocks.length) errors.push('the split has no Requirements');
  return { ok: errors.length === 0, feature: featureLines.join('\n').trim(), requirements, errors };
}

// A section's items: one per "- " or "1. " line, with the lines under it
// joined on. Text with no list markers is one item.
function listItems(text) {
  const items = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const marker = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
    if (marker) items.push(marker[1].trim());
    else if (line.trim() && items.length) items[items.length - 1] += ` ${line.trim()}`;
    else if (line.trim()) items.push(line.trim());
  }
  return items;
}

// The Feature's own plan from the planner's sections: its risks and open
// decisions, its new questions, and the status it gave each earlier question
// ("- Q1: answered" lines). Nothing else goes on the Feature's row.
function featurePlan(text) {
  const statuses = {};
  for (const line of listItems(sectionText(text, 'Question status'))) {
    const match = line.match(/^(\S+?)\s*:\s*(\S+)/);
    if (match) statuses[match[1]] = match[2].replace(/[.,;]+$/, '');
  }
  return {
    decisions: listItems(sectionText(text, 'Risks and open decisions')),
    questions: listItems(sectionText(text, 'Questions')),
    question_status: statuses,
  };
}

// The Requirements a split drafted, as the planner wrote them: kept on the
// Feature's row while it waits for answers, so the next plan starts from them.
const draftText = (text) => parseSplit(text).requirements.map((requirement) => `# Requirement: ${requirement.title}\n${requirement.content}`).join('\n\n');

// One Requirement's spec from its block: the "Part:" line and its four sections.
function specFrom(content) {
  const part = String(content || '').match(/^Part:[ \t]*(.*)$/m);
  return {
    part: part ? part[1].trim() : '',
    what_to_build: sectionText(content, 'What to build') || '',
    contract: sectionText(content, 'Contract') || '',
    acceptance: sectionText(content, 'Acceptance criteria') || '',
    depends_on: sectionText(content, 'Depends on') || '',
  };
}

// What a split writes: the Feature's plan and one { title, spec, depends_on }
// per Requirement (depends_on: places in this list). input.type is the
// Feature's work item type; text is the planner's answer without its Result
// line.
function splitParts({ type, text }, cfg) {
  const kind = config.kindOf(cfg, type);
  if (!kind.ok || kind.plan !== 'split') return { ok: false, errors: [`${type} isn't split in tracker.work_items`] };
  const parsed = parseSplit(text);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  return {
    ok: true,
    creates: kind.creates,
    feature_plan: featurePlan(parsed.feature),
    requirements: parsed.requirements.map((requirement) => ({ title: requirement.title, spec: specFrom(requirement.content), depends_on: requirement.depends_on })),
    errors: [],
  };
}

module.exports = { draftText, dependsOnNotes, parseSplit, requirementErrors, specErrors, specText, sectionText, featurePlan, specFrom, splitParts, listItems, REQUIREMENT_SECTIONS };
