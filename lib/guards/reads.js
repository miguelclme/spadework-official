'use strict';

// What a tool call reads, for the guards that limit reading (triage, and
// implement outside the repo): Read, Grep and Glob, and in shell commands
// the file arguments of programs that read files and < redirects. Paths are
// checked against the folders the run may read; stored credentials are never read.

const { expandPath, isNetworkPath, readPaths } = require('./common');
const { touchesCredentials } = require('./command');

// Programs whose arguments name files, and their options that take a value.
const PATH_READERS = {
  cat: [], head: ['-n', '-c'], tail: ['-n', '-c'], wc: [], nl: [], column: [], cut: ['-d', '-f', '-c', '-b'], sort: ['-k', '-t'],
  file: [], stat: ['-c', '--format'], du: ['-d'], diff: [], cmp: [], jq: ['--arg', '--argjson'], ls: [], dir: [], find: [],
  grep: ['-e', '-f', '-m', '-A', '-B', '-C', '-d', '-D'], egrep: ['-e', '-f', '-m', '-A', '-B', '-C'], fgrep: ['-e', '-f', '-m', '-A', '-B', '-C'],
  rg: ['-e', '-f', '-g', '--glob', '-t', '--type', '-T', '-m', '-A', '-B', '-C', '--max-depth', '-M'], findstr: [],
  'get-content': ['-totalcount', '-tail', '-head', '-encoding', '-delimiter'], gc: ['-totalcount', '-tail', '-head'],
  'select-string': ['-pattern', '-encoding', '-context'], sls: ['-pattern', '-context'],
  'get-childitem': ['-filter', '-include', '-exclude', '-depth'], gci: ['-filter', '-include', '-exclude', '-depth'],
  'get-item': [], gi: [], 'test-path': [], 'resolve-path': [], type: [], more: [], less: [], strings: [], xxd: [], od: [], base64: [],
};
const PATTERN_FIRST = new Set(['grep', 'egrep', 'fgrep', 'rg', 'findstr', 'select-string', 'sls']);

// The arguments of a reading program that name files, as written.
function fileArguments(name, args) {
  const valueOptions = (PATH_READERS[name] || []).map((option) => option.toLowerCase());
  if (name === 'find') {
    const firstOption = args.findIndex((arg) => /^[-(!]/.test(arg));
    return firstOption === -1 ? args : args.slice(0, firstOption);
  }
  const files = [];
  let patternGiven = args.some((arg) => /^(-e|-f|--regexp|--file|-pattern)$/i.test(arg));
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (/^-/.test(arg)) {
      if (valueOptions.includes(arg.toLowerCase())) i++;
      continue;
    }
    if (PATTERN_FIRST.has(name) && !patternGiven) {
      patternGiven = true;
      continue;
    }
    files.push(arg);
  }
  return files;
}

// For a wildcard, the folder before the first * or ?: src/*.cs → src/,
// /etc/* → /, C:\* → C:\, *.cs → the current folder.
function wildcardFolder(arg) {
  const wildcard = arg.search(/[*?]/);
  if (wildcard === -1) return arg;
  const before = arg.slice(0, wildcard);
  const separator = Math.max(before.lastIndexOf('/'), before.lastIndexOf('\\'));
  return separator === -1 ? '.' : before.slice(0, separator + 1);
}

// One path a command reads. inside(file): whether the run may read it.
// Returns a reason to block, or null.
function checkReadPath(label, arg, { cwd, inside, where }) {
  if (/^env:/i.test(arg)) return `${label} on ${arg}: environment variables aren't read in a Spadework run`;
  if (isNetworkPath(arg)) return `${label} on ${arg}: network paths aren't read in a Spadework run`;
  if (touchesCredentials(arg, cwd)) return `${label} on ${arg}: stored credentials are never read`;
  const file = expandPath(wildcardFolder(arg), cwd);
  if (file === null) return `${label} on "${arg}": a path with a variable in it can't be checked`;
  if (!inside(file)) return `${label} on ${file}: ${where}`;
  return null;
}

// The files one parsed command reads: < redirects, and the file arguments of
// reading programs. A plain name (no folder) is fine when the current folder
// may be read. Returns a reason to block, or null.
function checkCommandReads(command, name, args, ctx) {
  for (const redirect of command.redirects) {
    if (!/^\d?<$/.test(redirect.op)) continue;
    const reason = checkReadPath('<', redirect.target.trim(), ctx);
    if (reason) return reason;
  }
  if (!PATH_READERS[name]) return null;
  const cwdInside = ctx.inside(ctx.cwd);
  const files = fileArguments(name, args);
  // No file given: it reads the current folder (ls, find, grep -r) or what's piped in.
  if (!files.length && !cwdInside) return `${name} in ${ctx.cwd}: ${ctx.where}`;
  for (const arg of files) {
    const looksLikePath = /[\\/]/.test(arg) || /^[~.$%]/.test(arg) || /^[a-z]:/i.test(arg) || /^env:/i.test(arg);
    if (!looksLikePath && cwdInside && !touchesCredentials(arg, ctx.cwd)) continue;
    const reason = checkReadPath(name, arg, ctx);
    if (reason) return reason;
  }
  return null;
}

// Read, Grep and Glob: never stored credentials, and only where the run
// may read. inside(file) says whether it may, where is what to say when it
// may not. Returns a reason to block, or null.
function checkReadTool(toolInput, cwd, { inside, where }) {
  for (const file of readPaths(toolInput, cwd)) {
    if (touchesCredentials(file, cwd)) return `stored credentials are never read (${file})`;
    if (!inside(file)) return `${where}, not ${file}`;
  }
  return null;
}

module.exports = { checkReadPath, checkCommandReads, checkReadTool };
