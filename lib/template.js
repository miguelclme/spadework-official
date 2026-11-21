'use strict';

// Builds a triage row's plan text from templates/plan.md and the fields the
// agent returned as JSON. The template's top comment has its rules. Plain
// string work: a value is never read again, so a "{{" inside one stays as it is.

const fs = require('fs');
const path = require('path');

const TEMPLATE_FILE = path.join(__dirname, '..', 'templates', 'plan.md');
const PLACEHOLDER = /\{\{(\w+)\}\}/g;
// "- {{name}}" or "1. {{name}}": a line that repeats once per item of a list.
const LIST_LINE = /^(\s*)(-|\d+\.)\s+\{\{(\w+)\}\}\s*$/;

// A question is { id, text }: it shows as "Q3: text".
const text = (value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return [value.id, value.text].map((part) => String(part ?? '').trim()).filter(Boolean).join(': ');
  return (value === null || value === undefined ? '' : String(value)).trim();
};
// A field as a list of non-empty texts: a list as it is, a text as one item.
const items = (value) => (Array.isArray(value) ? value : [value]).map(text).filter(Boolean);

const readTemplate = () => fs.readFileSync(TEMPLATE_FILE, 'utf8');

const withoutComments = (template) => template.replace(/<!--[\s\S]*?-->/g, '');

// The {{names}} a template uses, outside its comment.
const fieldNames = (template) => [...new Set([...withoutComments(template).matchAll(PLACEHOLDER)].map((match) => match[1]))];

// The page's lines: { text, level }. level is the heading level, and only a line
// of the template itself can be a heading: a "# " at the start of an agent's
// value is plain text.
function renderLines(template, fields) {
  const lines = [];
  for (const line of withoutComments(template).split(/\r?\n/)) {
    const list = line.match(LIST_LINE);
    if (list) {
      // One item is one line: a line break inside it would end the list item.
      items(fields[list[3]]).forEach((item, index) => lines.push({
        text: `${list[1]}${list[2] === '-' ? '-' : `${index + 1}.`} ${item.replace(/\s*\n\s*/g, ' ')}`,
        level: 0,
      }));
      continue;
    }
    const names = [...line.matchAll(PLACEHOLDER)].map((match) => match[1]);
    if (names.length && names.every((name) => !items(fields[name]).length)) continue;
    lines.push({ text: line.replace(PLACEHOLDER, (all, name) => items(fields[name]).join('; ')), level: names.length ? 0 : (line.match(/^(#{1,6}) /) || [])[1]?.length || 0 });
  }
  return lines;
}

// Drops the headings with nothing under them, subheadings included.
function withoutEmptyHeadings(lines) {
  return lines.filter((line, index) => {
    if (!line.level) return true;
    for (let next = index + 1; next < lines.length; next++) {
      const after = lines[next];
      if (after.level && after.level <= line.level) return false;
      if (!after.level && after.text.trim()) return true;
    }
    return false;
  });
}

// template: the template's text; fields: { name: text | [text] }.
function renderPage(template, fields) {
  const lines = withoutEmptyHeadings(renderLines(template, fields || {}));
  return `${lines.map((line) => line.text).join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

// The agent's JSON, with or without the ```json fence around it. An agent
// sometimes writes text before or after the block: then the block alone is
// read. Each closing fence is tried in turn, so a fence inside a JSON string
// can't end the block early. Returns the fields (an object), or null when it
// can't be read.
function parsePage(page) {
  const text = String(page ?? '').trim();
  const asObject = (body) => {
    try {
      const fields = JSON.parse(body);
      return fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : null;
    } catch {
      return null;
    }
  };
  const whole = asObject(text.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, ''));
  if (whole) return whole;
  const open = /```[a-z]*[ \t]*\r?\n/i.exec(text);
  if (!open) return null;
  const start = open.index + open[0].length;
  for (let end = text.indexOf('```', start); end !== -1; end = text.indexOf('```', end + 3)) {
    const fields = asObject(text.slice(start, end));
    if (fields) return fields;
  }
  return null;
}

// A row's plan and spec as Markdown, for an agent to read: the template for
// its plan, the spec sections for a split Requirement.
function rowPlanText(row) {
  const parts = [];
  if (row.plan) parts.push(renderPage(readTemplate(), row.plan));
  if (row.spec) parts.push(require('./split').specText(row.spec));
  return parts.join('\n\n');
}

// The answered questions of a row as list items: "- question" and the answer under it.
const answersLines = (answers) => answers.map((entry) => `- ${entry.question}\n  ${entry.answer}`);

module.exports = { answersLines, renderPage, parsePage, readTemplate, fieldNames, rowPlanText, TEMPLATE_FILE };
