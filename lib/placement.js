'use strict';

// The placement file of a design, ~/.spadework/designs/<name>.md: where the
// work goes in Azure DevOps, for the user to review and edit before
// /spadework:design-push creates it. render writes it and parse reads it
// back. parse refuses the whole file at the first sign of a line it doesn't
// know, naming each line, so an edit the push can't follow never creates
// anything.
//
//   # Placement for order-processing
//
//   Project: Shop
//   Repo: api
//   Process: CMMI
//
//   ## ADRs
//   - <ADR folder>/<NNNN>-<name>.md: <its index sentence>
//
//   ## Epic #12094: Checkout          (an existing Epic: no text under it)
//   ## Epic: <title>                  (a new Epic, then its description)
//   ## Work item #123: <title>        (ADR only: no Epic, no Features)
//
//   ### Feature: <title>
//   <its description>

const { sameName } = require('./config');

// The work item types the push creates, per process, above the rows
// (Requirement, User Story, Product Backlog Item, Issue, Bug).
const PUSH_LEVELS = { Basic: ['Epic'], Agile: ['Epic', 'Feature'], Scrum: ['Epic', 'Feature'], CMMI: ['Epic', 'Feature'], Custom: [] };
// The shapes a placement may have, per process.
const SHAPES = {
  Basic: ['adr-only', 'new-epic'],
  Agile: ['adr-only', 'new-features', 'new-epic'],
  Scrum: ['adr-only', 'new-features', 'new-epic'],
  CMMI: ['adr-only', 'new-features', 'new-epic'],
  Custom: [],
};
const MAX_TITLE = 255;
const HEADERS = ['Project', 'Repo', 'Process'];

const hasFeatures = (process) => (PUSH_LEVELS[process] || []).includes('Feature');

// The file's text. placement: { name, project, repo, process, adrs: [{ path, sentence }],
// shape, work_item: { id, title? } | null, epic: { id, title } | { title, description } | null,
// features: [{ title, description }] }.
function render(placement) {
  const lines = [`# Placement for ${placement.name}`, '', `Project: ${placement.project}`, `Repo: ${placement.repo}`, `Process: ${placement.process}`, ''];
  lines.push('## ADRs', ...(placement.adrs || []).map((adr) => `- ${adr.path}: ${adr.sentence}`), '');
  const epic = placement.epic;
  if (placement.shape === 'adr-only') {
    const item = placement.work_item;
    if (item) lines.push(`## Work item #${item.id}${item.title ? `: ${item.title}` : ''}`, '');
  } else if (epic && epic.id) {
    lines.push(`## Epic #${epic.id}: ${epic.title}`, '');
  } else if (epic) {
    lines.push(`## Epic: ${epic.title}`, ...textLines(epic.description), '');
  }
  for (const feature of placement.shape === 'adr-only' ? [] : placement.features || []) {
    lines.push(`### Feature: ${feature.title}`, ...textLines(feature.description), '');
  }
  return lines.join('\n').replace(/\n+$/, '') + '\n';
}

const textLines = (text) => {
  const trimmed = String(text || '').replace(/\r\n/g, '\n').trim();
  return trimmed ? trimmed.split('\n') : [];
};

// The text of a section: its lines without the blank ones around them.
const sectionText = (lines) => lines.join('\n').trim();

// Reads the file. expect: { name, process } (the process in config.json).
// Returns { ok, placement } or { ok: false, errors: ["line N: ..."] }.
function parse(text, { name = null, process = null } = {}) {
  const lines = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  const errors = [];
  const at = (index, message) => errors.push(`line ${index + 1}: ${message}`);
  const placement = { name: null, project: null, repo: null, process: null, adrs: [], shape: 'adr-only', work_item: null, epic: null, features: [] };

  const first = lines[0].match(/^#\s+Placement for\s+(\S+)\s*$/);
  if (!first) at(0, 'the first line must be "# Placement for <name>"');
  else if (name && first[1] !== name) at(0, `this is the placement for ${first[1]}, not ${name}`);
  else placement.name = first[1];

  // Where the line being read belongs: header, adrs, epic (existing or new), work item, feature.
  let section = 'header';
  let current = null; // the new Epic or the Feature whose description is being read
  let epicLine = null;
  const headerLines = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const blank = line.trim() === '';
    const heading = line.match(/^(#+)\s*(.*?)\s*$/);
    if (heading && heading[1].length >= 4) {
      at(i, 'headings of level 4 (####) or deeper aren\'t used in a placement file. Write that text as plain lines');
      continue;
    }
    if (heading && heading[1].length === 1) {
      at(i, 'only the first line is a "# " heading');
      continue;
    }
    if (heading && heading[1].length === 2) {
      current = null;
      const title = heading[2];
      const existing = title.match(/^Epic\s+#(\d+):\s*(.*)$/);
      const created = title.match(/^Epic:\s*(.*)$/);
      const item = title.match(/^Work item\s+#(\d+)(?::\s*(.*))?$/);
      if (title === 'ADRs') {
        section = 'adrs';
      } else if (existing || created) {
        if (placement.epic) at(i, 'a placement has one Epic only');
        else if (placement.work_item) at(i, 'a placement has an Epic or a Work item, not both');
        else if (existing) {
          placement.epic = { id: Number(existing[1]), title: existing[2] };
          placement.shape = 'new-features';
        } else {
          placement.epic = { title: created[1], description: '' };
          placement.shape = 'new-epic';
          current = { target: placement.epic, lines: [] };
        }
        epicLine = i;
        section = existing ? 'existing-epic' : 'epic';
        checkTitle((existing || created)[existing ? 2 : 1], i, 'the Epic', at);
      } else if (item) {
        if (placement.epic) at(i, 'a placement has an Epic or a Work item, not both');
        else if (placement.work_item) at(i, 'a placement names one Work item only');
        else placement.work_item = { id: Number(item[1]), title: item[2] || null };
        section = 'work-item';
      } else {
        at(i, `"## ${title}" isn't a heading of a placement file (## ADRs, ## Epic #<number>: <title>, ## Epic: <title> or ## Work item #<number>: <title>)`);
        section = 'unknown';
      }
      continue;
    }
    if (heading && heading[1].length === 3) {
      const feature = heading[2].match(/^Feature:\s*(.*)$/);
      if (!feature) {
        at(i, `"### ${heading[2]}" isn't a heading of a placement file (### Feature: <title>)`);
        current = null;
        section = 'unknown';
        continue;
      }
      const entry = { title: feature[1], description: '', line: i };
      if (process && !hasFeatures(process)) at(i, `the ${process} process has no Features: the push creates only the Epic`);
      else if (placement.work_item) at(i, 'a Feature can\'t go under a Work item: the push creates nothing for "ADR only"');
      else if (!placement.epic) at(i, 'a Feature must come after its Epic');
      checkTitle(entry.title, i, 'the Feature', at);
      if (placement.features.some((other) => sameName(other.title, entry.title))) at(i, `two Features have the title "${entry.title}"`);
      placement.features.push(entry);
      current = { target: entry, lines: [] };
      section = 'feature';
      continue;
    }

    // A plain line.
    if (section === 'header') {
      if (blank) continue;
      const header = line.match(/^([A-Za-z ]+):\s*(.*?)\s*$/);
      if (!header) at(i, 'text before the first "## " heading. Only the Project, Repo and Process lines go there');
      else if (!HEADERS.includes(header[1])) at(i, `"${header[1]}" isn't a header of a placement file. Use Project, Repo and Process`);
      else if (headerLines[header[1]] !== undefined) at(i, `${header[1]} is given twice`);
      else headerLines[header[1]] = { value: header[2], line: i };
    } else if (section === 'adrs') {
      if (blank) continue;
      const adr = line.match(/^-\s+(\S[^:]*?):\s+(\S.*?)\s*$/);
      if (!adr) at(i, 'each line under "## ADRs" is "- <path>: <sentence>"');
      else placement.adrs.push({ path: adr[1], sentence: adr[2] });
    } else if (section === 'existing-epic') {
      if (!blank) at(i, 'the push doesn\'t change an existing Epic\'s text. Remove these lines');
    } else if (section === 'work-item') {
      if (!blank) at(i, 'the push doesn\'t change a work item\'s text. Remove these lines');
    } else if (current) {
      current.lines.push(line);
      current.target.description = sectionText(current.lines);
    }
  }

  for (const key of HEADERS) {
    const header = headerLines[key];
    if (!header) errors.push(`the header "${key}: <value>" is missing, before the first "## " heading`);
    else if (!header.value) at(header.line, `${key} has no value`);
    else placement[key.toLowerCase()] = header.value;
  }
  if (process && placement.process && placement.process !== process) {
    at(headerLines.Process.line, `the process is ${placement.process}, but tracker.process in config.json is ${process}`);
  }
  const shapes = SHAPES[process || placement.process] || [];
  if ((process || placement.process) && !shapes.includes(placement.shape)) {
    at(epicLine ?? 0, `the ${process || placement.process} process doesn't take this placement (it takes: ${shapes.join(', ') || 'none'})`);
  }
  for (const feature of placement.features) {
    if (!feature.description) at(feature.line, `the Feature "${feature.title}" has no description`);
  }
  if (placement.epic && !placement.features.length && hasFeatures(process || placement.process)) {
    at(epicLine, placement.epic.id ? 'the Epic has no Features under it, so the push would create nothing' : 'a new Epic needs its Features under it');
  }
  if (errors.length) return { ok: false, errors };
  placement.features = placement.features.map(({ title, description }) => ({ title, description }));
  return { ok: true, placement };
}

function checkTitle(title, index, what, at) {
  if (!String(title || '').trim()) at(index, `${what} has no title`);
  else if (title.length > MAX_TITLE) at(index, `the title of ${what} is longer than ${MAX_TITLE} characters`);
}

module.exports = { render, parse, PUSH_LEVELS, SHAPES, MAX_TITLE, hasFeatures };
