'use strict';

// Saving the architect's ADRs, for /spadework:architect and the design run.
// The helper picks each ADR's number, file name and index line, not the
// model:
// - split: finds each ADR in the architect's answer
// - nextNumber: the next free number, from the files on disk and on the
//   main branch (another branch may have taken a number already merged)
// - save: writes NNNN-<kebab title>.md and adds its line to INDEX.md
// - indexLines: the index lines a planner reads, marking the ones that
//   are on disk only (an ADR saved here and not merged yet)
// - target: which repo, ADR folder and main branch a command saves to

const fs = require('fs');
const path = require('path');

const config = require('./config');
const stack = require('./stack');
const { git, outputLines, topLevel } = require('./git');
const { writeFileAtomic } = require('./fs-atomic');

// "# NNNN. Title" or "# 0004. Title": the first line of an ADR.
const HEADING = /^#\s+(?:NNNN|\d{1,4})\.\s+(.+?)\s*$/;
// The line after an ADR that sums it up for the index.
const INDEX_LINE = /^Index:\s*(.*?)\s*$/;
const FENCE = /^\s*(```|~~~)/;
const ADR_FILE = /^(\d{4})-.+\.md$/i;
const MAX_NAME = 60;

// The ADRs in the architect's answer: [{ title, body, index }]. An ADR
// starts at a "# NNNN. <title>" line and ends at its "Index: <sentence>"
// line. Lines inside code blocks don't count, so an ADR that shows a
// heading in an example isn't cut there. A code block around a whole ADR
// only wraps it: the ADR inside is read, and the wrapping lines are left
// out. Its closing line is the first one outside the ADR's own code blocks
// that comes after the Index line, right before it or at the end.
// Returns { ok, adrs } or { ok: false, error }.
function split(text) {
  const adrs = [];
  let current = null;
  let fenced = false;
  let wrapped = false;
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!fenced && FENCE.test(line)) {
      const next = lines.slice(i + 1).find((later) => later.trim()) ?? null;
      if (!wrapped && !current && next !== null && HEADING.test(next)) {
        wrapped = true;
        continue;
      }
      if (wrapped && (!current || next === null || INDEX_LINE.test(next))) {
        wrapped = false;
        continue;
      }
    }
    if (FENCE.test(line)) fenced = !fenced;
    const heading = !fenced && line.match(HEADING);
    const index = !fenced && current && line.match(INDEX_LINE);
    if (heading) {
      if (current) return { ok: false, error: `The ADR "${current.title}" has no "Index:" line after it.` };
      current = { title: heading[1], lines: [] };
    } else if (index) {
      if (!index[1]) return { ok: false, error: `The "Index:" line of the ADR "${current.title}" is empty.` };
      adrs.push({ title: current.title, body: current.lines.join('\n').replace(/\s+$/, ''), index: index[1] });
      current = null;
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) return { ok: false, error: `The ADR "${current.title}" has no "Index:" line after it.` };
  if (!adrs.length) return { ok: false, error: 'The text holds no ADR: an ADR starts with a line "# NNNN. <title>" and ends with a line "Index: <one sentence>".' };
  return { ok: true, adrs };
}

// The title as a file name: ASCII, lowercase, words joined by "-", at most 60 characters.
function kebab(title) {
  const ascii = String(title).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  let name = ascii.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (name.length > MAX_NAME) name = name.slice(0, MAX_NAME).replace(/-[^-]*$/, '') || name.slice(0, MAX_NAME);
  return name || 'decision';
}

// The ADR files in the folder on disk, by name.
function diskFiles(repoPath, folder) {
  try {
    return fs.readdirSync(path.join(repoPath, folder));
  } catch {
    return [];
  }
}

// The ADR files in the folder on mainRef ("origin/main"), by name. None when
// the ref or the folder isn't there.
function mainFiles(repoPath, folder, mainRef) {
  if (!mainRef) return [];
  return outputLines(git(repoPath, ['ls-tree', '--name-only', mainRef, '--', `${folder}/`])).map((file) => path.posix.basename(file));
}

const numberOf = (name) => {
  const match = String(name).match(ADR_FILE);
  return match ? Number(match[1]) : 0;
};
const pad = (number) => String(number).padStart(4, '0');

// The next ADR number, four digits: the highest NNNN-*.md on disk and on
// mainRef, plus one. "0001" for an empty folder. Without mainRef, disk only.
function nextNumber(repoPath, folder, mainRef) {
  const highest = Math.max(0, ...[...diskFiles(repoPath, folder), ...mainFiles(repoPath, folder, mainRef)].map(numberOf));
  return pad(highest + 1);
}

// The folder as a path inside the repo, or null when it would leave it.
function folderPath(repoPath, folder) {
  const full = path.resolve(repoPath, folder);
  const relative = path.relative(path.resolve(repoPath), full);
  return relative.startsWith('..') || path.isAbsolute(relative) ? null : full;
}

// Saves each ADR of the text in the repo's ADR folder: the next number, the
// file NNNN-<kebab title>.md with the number in its heading, and one line
// "NNNN-<kebab title>.md: <sentence>" in INDEX.md. Creates the folder and the
// index when needed. Refuses everything when a file would be replaced.
// Returns { ok, saved: [{ number, title, file, path, absolute, index }] } or { ok: false, error }.
function save({ repoPath, folder, text, mainRef = null }) {
  const found = split(text);
  if (!found.ok) return found;
  const dir = folderPath(repoPath, folder);
  if (!dir) return { ok: false, error: `The ADR folder ${folder} is outside the repo.` };
  const first = Number(nextNumber(repoPath, folder, mainRef));
  const planned = found.adrs.map((adr, i) => {
    const number = pad(first + i);
    const file = `${number}-${kebab(adr.title)}.md`;
    return { ...adr, number, file, absolute: path.join(dir, file), path: path.posix.join(folder.replace(/\\/g, '/'), file) };
  });
  const taken = planned.find((adr) => fs.existsSync(adr.absolute));
  if (taken) return { ok: false, error: `${taken.path} already exists. Nothing was saved.` };

  fs.mkdirSync(dir, { recursive: true });
  for (const adr of planned) writeFileAtomic(adr.absolute, `# ${adr.number}. ${adr.title}\n${adr.body ? `${adr.body}\n` : ''}`);
  const indexFile = path.join(dir, 'INDEX.md');
  let index = '';
  try {
    index = fs.readFileSync(indexFile, 'utf8');
  } catch { /* a new index */ }
  if (index && !index.endsWith('\n')) index += '\n';
  writeFileAtomic(indexFile, index + planned.map((adr) => `${adr.file}: ${adr.index}\n`).join(''));
  return { ok: true, saved: planned.map(({ number, title, file, path: relative, absolute, index: sentence }) => ({ number, title, file, path: relative, absolute, index: sentence })) };
}

// The lines of an index text, without blank lines and headings.
const linesOf = (text) => String(text || '').replace(/\r\n/g, '\n').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
// A line is known by its file name, so a sentence edited later still matches.
const keyOf = (line) => line.split(':')[0].trim().toLowerCase();

// The lines of INDEX.md on mainRef, then the ones only on disk:
// [{ text, file, on_main, absolute }]. on_main is null without mainRef.
function indexLines(repoPath, folder, mainRef = null) {
  const dir = folderPath(repoPath, folder);
  if (!dir) return [];
  let disk = '';
  try {
    disk = fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf8');
  } catch { /* no index on disk */ }
  const shown = mainRef ? git(repoPath, ['show', `${mainRef}:${path.posix.join(folder.replace(/\\/g, '/'), 'INDEX.md')}`], { trim: false }) : null;
  const main = shown && shown.ok ? linesOf(shown.stdout) : [];
  const entry = (text, onMain) => ({ text, file: text.split(':')[0].trim(), on_main: onMain, absolute: path.join(dir, text.split(':')[0].trim()) });
  const keys = new Set(main.map(keyOf));
  return [
    ...main.map((text) => entry(text, true)),
    ...linesOf(disk).filter((text) => !keys.has(keyOf(text))).map((text) => entry(text, mainRef ? false : null)),
  ];
}

// Where a command saves ADRs: the configured repo given, else the
// configured repo of the folder, else the folder's own checkout (no main
// branch then: numbers come from the disk alone).
// Returns { repo, repo_path, label, folder, main_ref } or { error }.
function target({ repo = null, cwd = process.cwd(), repos = null } = {}) {
  let found = repo ? { repo, top: repo.path } : null;
  if (!found) {
    let list = repos;
    if (!list) {
      const loaded = config.load({ checkPaths: false });
      list = loaded.ok ? loaded.config.repos : [];
    }
    found = stack.repoInFolder(cwd, list);
  }
  const label = found ? config.repoLabel(found.repo) : null;
  const where = stack.adrFolder(label);
  if (where.error) return { error: where.error };
  return {
    repo: found ? found.repo : null,
    repo_path: found ? found.top : topLevel(cwd) || path.resolve(cwd),
    label,
    folder: where.folder,
    main_ref: found ? `origin/${found.repo.main_branch}` : null,
  };
}

module.exports = { split, kebab, nextNumber, save, indexLines, target };
