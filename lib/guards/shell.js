'use strict';

// Splits a shell command line into the simple commands it runs, so the
// guards can check each one. Handles what Claude writes in practice:
// quotes, escapes, pipes, && || ; &, newlines, redirections, heredocs,
// $( ) and backtick substitutions, ( ) subshells, and PowerShell's
// here-strings, backtick escapes, { } script blocks and & call operator.
//
// It errs on the side of seeing more commands, never fewer:
// - a command hidden in a substitution, a subshell or a script block is listed
// - the code given to another shell is parsed too: bash -c "...",
//   pwsh -Command "...", cmd /c ..., eval, su -c, env -S, find -exec,
//   Start-Process, and PowerShell -EncodedCommand (decoded)
// Code for other languages (node -e, python -c) is not parsed: the guards
// treat those as best-effort.
//
// parse(text, { powershell }) → [{ words, redirects, pipe, powershell, call, nested, literal?, hidden? }]
//   words: the command and its arguments, quotes removed
//   literal: (bash only) words whose * ? [ were all quoted or escaped, so
//     bash doesn't expand them as wildcards. PowerShell expands quoted ones too.
//   pipe: true when the command's output goes into the next command
//   call: PowerShell's & or . call operator was used (& $x runs a variable)
//   nested: found inside another shell's code (bash -c, pwsh -Command, ...)
//   hidden: hands code to another shell too deep down to be read (MAX_DEPTH)

const MAX_DEPTH = 4;

// Heredoc bodies and here-strings are data, not commands: drop them.
// Only a << outside quotes and comments starts a heredoc: echo "<<EOF" is
// plain text, and the lines after it still run, so they must be checked.
function stripHeredocs(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  const pending = [];
  let quote = null; // a quote left open at the end of a line continues on the next
  for (const line of lines) {
    if (pending.length) {
      const { word, dash } = pending[0];
      if ((dash ? line.replace(/^\t+/, '') : line) === word) pending.shift();
      continue;
    }
    out.push(line);
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (quote === '"' && ch === '\\') i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        continue;
      }
      if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
      if (ch === '<' && line[i + 1] === '<' && line[i + 2] !== '<' && line[i - 1] !== '<') {
        const match = line.slice(i).match(/^<<(-?)\s*(['"]?)([A-Za-z_][\w.-]*)\2/);
        if (match) {
          pending.push({ word: match[3], dash: match[1] === '-' });
          i += match[0].length - 1;
        }
      }
    }
  }
  return out.join('\n');
}

const stripHereStrings = (text) => String(text).replace(/@(['"])\r?\n[\s\S]*?\r?\n\1@/g, "''");

// bash's $'...' strings, decoded: $'\x67it' is git.
const ANSI_C = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v' };
function ansiC(body) {
  return body.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c[\s\S]|[\s\S])/g, (all, code) => {
    if (code[0] === 'x') return String.fromCharCode(parseInt(code.slice(1), 16));
    if (code[0] === 'u' || code[0] === 'U') {
      const point = parseInt(code.slice(1), 16);
      return point <= 0x10ffff ? String.fromCodePoint(point) : '';
    }
    if (/^[0-7]/.test(code)) return String.fromCharCode(parseInt(code, 8) & 0xff);
    if (code[0] === 'c' && code.length === 2) return String.fromCharCode(code.charCodeAt(1) & 31);
    return ANSI_C[code] ?? code;
  });
}

// What opens a nested part whose commands are parsed too, and what closes
// it: $( ), bash's backticks, and PowerShell's { } script blocks and @{ }
// hashtables (what's inside them runs: Where-Object { Remove-Item $_ }).
const NESTED = {
  bash: new Map([['$(', ')'], ['`', '`']]),
  powershell: new Map([['$(', ')'], ['{', '}'], ['@{', '}']]),
};

// One level of parsing: the commands written directly in `text`.
function parseLevel(text, { powershell = false } = {}) {
  const source = powershell ? stripHereStrings(text) : stripHeredocs(text);
  const commands = [];
  const escape = powershell ? '`' : '\\';
  const nested = powershell ? NESTED.powershell : NESTED.bash;
  let pos = 0;

  // Parses until `close` (')', '`' or '}') or the end. Commands go into `commands`.
  function block(close) {
    let words = [];
    let redirects = [];
    let globbing = [];
    let word = null;
    let wordGlobs = false;
    let pendingRedirect = null;
    let call = false;

    const endWord = () => {
      if (word === null) return;
      if (pendingRedirect) {
        redirects.push({ op: pendingRedirect, target: word });
        pendingRedirect = null;
      } else {
        words.push(word);
        globbing.push(wordGlobs);
      }
      word = null;
      wordGlobs = false;
    };
    // The same text written both ways isn't literal: the unquoted one expands.
    const literalWords = () => new Set(words.filter((text, i) => !globbing[i] && /[*?[]/.test(text)
      && !words.some((other, j) => globbing[j] && other === text)));
    const endCommand = (pipe = false) => {
      endWord();
      if (pendingRedirect) {
        redirects.push({ op: pendingRedirect, target: '' });
        pendingRedirect = null;
      }
      if (words.length || redirects.length) commands.push({ words, redirects, pipe, powershell, call, nested: false, ...(powershell ? {} : { literal: literalWords() }) });
      words = [];
      globbing = [];
      redirects = [];
      call = false;
    };
    // quoted: the characters came from quotes or an escape, so they don't expand.
    const add = (chars, quoted = false) => {
      word = (word ?? '') + chars;
      if (!quoted && /[*?[]/.test(chars)) wordGlobs = true;
    };
    const substitution = (closer) => {
      block(closer);
      add('$SUB');
    };

    // "...", with $( ) and bash's `...` substitutions inside.
    const readDoubleQuoted = () => {
      pos++;
      let chunk = '';
      while (pos < source.length && source[pos] !== '"') {
        const char = source[pos];
        // In bash double quotes, \ only escapes $ ` " \ and a newline: C:\Users stays as it is.
        if (char === escape && pos + 1 < source.length && (powershell || '$`"\\\n'.includes(source[pos + 1]))) {
          chunk += source[pos + 1];
          pos += 2;
        } else if (char === '$' && source[pos + 1] === '(') {
          pos += 2;
          add(chunk, true);
          chunk = '';
          substitution(')');
        } else if (char === '`' && !powershell) {
          pos++;
          add(chunk, true);
          chunk = '';
          substitution('`');
        } else {
          chunk += char;
          pos++;
        }
      }
      add(chunk, true);
      pos++;
    };

    // && ends a command, &> and &>> redirect both outputs, a leading & in
    // PowerShell is the call operator, and a lone & ends the command too
    // (it runs in the background).
    const readAmpersand = (next) => {
      if (next === '&') {
        pos += 2;
        endCommand();
      } else if (next === '>') {
        endWord();
        const op = source[pos + 2] === '>' ? '&>>' : '&>';
        pos += op.length;
        pendingRedirect = op;
      } else if (powershell && word === null && words.length === 0) {
        // & "C:\path\tool.exe" args, or & $variable
        call = true;
        pos++;
      } else {
        pos++;
        endCommand();
      }
    };

    // > >> < << <<< and <<-: the target is the next word. A file descriptor
    // right before belongs to it (2>), and 2>&1 names another descriptor.
    const readRedirect = (ch) => {
      let op = ch;
      if (word !== null && /^\d$/.test(word)) {
        op = word + op;
        word = null;
      } else {
        endWord();
      }
      pos++;
      if (source[pos] === ch) {
        op += ch;
        pos++;
        if (ch === '<' && (source[pos] === '<' || source[pos] === '-')) pos++;
      }
      if (source[pos] === '&') {
        let target = '&';
        pos++;
        while (pos < source.length && /[\d-]/.test(source[pos])) target += source[pos++];
        redirects.push({ op, target });
        return;
      }
      pendingRedirect = op;
    };

    while (pos < source.length) {
      const ch = source[pos];
      const next = source[pos + 1];

      if (close !== null && ch === close) {
        pos++;
        endCommand();
        return;
      }
      if (ch === escape) {
        // An escaped newline joins two lines; any other escaped character is kept as it is.
        if (next !== '\n') add(next ?? '', true);
        pos += 2;
        continue;
      }
      // bash's $'...': escapes decoded, $'\x67it' is git.
      if (!powershell && ch === '$' && next === "'") {
        let end = pos + 2;
        while (end < source.length && source[end] !== "'") end += source[end] === '\\' ? 2 : 1;
        add(ansiC(source.slice(pos + 2, Math.min(end, source.length))), true);
        pos = end + 1;
        continue;
      }
      if (ch === "'") {
        const end = source.indexOf("'", pos + 1);
        add(end === -1 ? source.slice(pos + 1) : source.slice(pos + 1, end), true);
        pos = end === -1 ? source.length : end + 1;
        continue;
      }
      if (ch === '"') {
        readDoubleQuoted();
        continue;
      }
      const opener = nested.has(ch + next) ? ch + next : nested.has(ch) ? ch : null;
      if (opener) {
        pos += opener.length;
        substitution(nested.get(opener));
        continue;
      }
      // Process substitution: <(...) and >(...).
      if ((ch === '<' || ch === '>') && next === '(') {
        pos += 2;
        endWord();
        block(')');
        add('$SUB');
        continue;
      }
      // A subshell: ( ... ).
      if (ch === '(' && word === null) {
        pos++;
        endCommand();
        block(')');
        continue;
      }
      if (ch === '#' && word === null) {
        while (pos < source.length && source[pos] !== '\n') pos++;
        continue;
      }
      if (ch === '\n' || ch === ';') {
        pos++;
        endCommand();
        continue;
      }
      // | pipes into the next command; || only chains it.
      if (ch === '|') {
        pos += next === '|' ? 2 : 1;
        endCommand(next !== '|');
        continue;
      }
      if (ch === '&') {
        readAmpersand(next);
        continue;
      }
      if (ch === '>' || ch === '<') {
        readRedirect(ch);
        continue;
      }
      if (/\s/.test(ch)) {
        pos++;
        endWord();
        continue;
      }
      add(ch);
      pos++;
    }
    endCommand();
  }

  block(null);
  return commands;
}

// --- programs -------------------------------------------------------------------

// Commands that run another command, and which of their options take a value.
// positional: how many plain arguments come before the command (timeout 5 cmd).
const WRAPPERS = {
  env: { values: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'] },
  command: { values: [] },
  builtin: { values: [] },
  exec: { values: ['-a'] },
  nice: { values: ['-n', '--adjustment'] },
  nohup: { values: [] },
  time: { values: ['-f', '-o', '--format', '--output'] },
  sudo: {
    values: ['-u', '-g', '-C', '-h', '-p', '-U', '-r', '-t', '-D', '-R', '--user', '--group', '--host', '--prompt', '--role',
      '--type', '--chdir', '--chroot', '--close-from', '--other-user'],
  },
  doas: { values: ['-u', '-C'] },
  timeout: { values: ['-s', '-k', '--signal', '--kill-after'], positional: 1 },
  xargs: {
    values: ['-I', '-L', '-n', '-P', '-s', '-d', '-E', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file',
      '--replace', '--max-lines', '--eof', '--max-chars'],
  },
  stdbuf: { values: ['-i', '-o', '-e'] },
  watch: { values: ['-n', '--interval', '-d'] },
};
// Shell keywords and grouping that come before a command: if rm ...; then rm ...; { rm ...; }
const KEYWORDS = new Set(['{', '}', '!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'fi', 'done']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// The program a command runs, without its folder or .exe, in lower case,
// after VAR=value assignments, shell keywords and wrappers like sudo, env,
// timeout and xargs (with their options). Pass the parsed command as the
// second argument so PowerShell expressions and & $x are recognised.
// pathed is true when the program, or a wrapper before it, is named by a
// path or with an extension (C:\x\cat.cmd, ./tool, cat.exe), not a bare name.
function program(words, { powershell = false, call = false } = {}) {
  let index = 0;
  let wrapper = null;
  const named = [];
  // VAR=value words before the program or among a wrapper's options (env VAR=x).
  const assigned = [];
  const assign = (word) => assigned.push(word.slice(0, word.indexOf('=')).toUpperCase());
  const done = (result) => ({ ...result, assigned, pathed: named.some((word) => /[\\/]/.test(word) || /\.[a-z0-9]+$/i.test(word)) });
  for (;;) {
    while (index < words.length && (ASSIGNMENT.test(words[index]) || KEYWORDS.has(words[index]))) {
      if (ASSIGNMENT.test(words[index])) assign(words[index]);
      index++;
    }
    const spec = index < words.length ? WRAPPERS[baseName(words[index])] : null;
    if (!spec) break;
    wrapper = index;
    named.push(words[index]);
    index++;
    let positional = spec.positional || 0;
    while (index < words.length) {
      const word = words[index];
      if (spec.values.includes(word)) index += 2;
      else if (/^-/.test(word) || ASSIGNMENT.test(word)) {
        if (ASSIGNMENT.test(word)) assign(word);
        index++;
      }
      else if (positional > 0) {
        positional--;
        index++;
      } else break;
    }
  }
  // A wrapper with nothing after it is the command itself: `env` alone prints the environment.
  if (index >= words.length && wrapper !== null) return done({ name: baseName(words[wrapper]), args: words.slice(wrapper + 1) });
  if (index >= words.length) return done({ name: '', args: [] });

  const first = words[index];
  if (powershell) {
    // & $x runs whatever $x holds: the guards treat it as unknown.
    if (call && first.startsWith('$')) return done({ name: '$call', args: words.slice(index + 1) });
    // $x = Remove-Item ...: the command after the assignment runs.
    // $env:PATH = ... sets an environment variable.
    if (/^\$[\w:]+$/.test(first) && /^[+\-*/]?=$/.test(words[index + 1] || '')) {
      const env = first.match(/^\$env:(\w+)$/i);
      if (env) assigned.push(env[1].toUpperCase());
      const rest = program(words.slice(index + 2), { powershell });
      return { ...rest, assigned: [...assigned, ...rest.assigned], pathed: rest.pathed || done({}).pathed };
    }
    // An expression, not a command: $_.Name -like '*.cs', (1+1), [int]"2", 'text'
    if (/^[$([@'"0-9-]/.test(first)) return done({ name: '', args: words.slice(index + 1) });
  }
  named.push(first);
  const args = words.slice(index + 1);
  // PowerShell takes -Path:value as well as -Path value: split it, so the
  // guards see the parameter and its value.
  return done({ name: baseName(first), args: powershell ? args.flatMap((arg) => /^-[a-z]\w*:./i.test(arg) ? [arg.slice(0, arg.indexOf(':')), arg.slice(arg.indexOf(':') + 1)] : [arg]) : args });
}

// The environment variables a command sets, in upper case: VAR=x cmd,
// env VAR=x cmd, a bare VAR=x, export/declare/set VAR=x, setx VAR x,
// $env:VAR = x and Set-Item env:VAR. Programs read some of them to run
// other programs (GIT_EXTERNAL_DIFF, NODE_OPTIONS, PATH).
const ENV_SETTERS = new Set(['export', 'declare', 'typeset', 'local', 'readonly', 'set']);
const PS_ITEM_WRITERS = new Set(['set-item', 'si', 'new-item', 'ni', 'set-content', 'sc', 'add-content', 'ac', 'new-variable', 'nv']);
function envSets(command) {
  const { name, args, assigned } = program(command.words, command);
  const names = [...assigned];
  if (ENV_SETTERS.has(name)) {
    for (const arg of args) if (ASSIGNMENT.test(arg)) names.push(arg.slice(0, arg.indexOf('=')).toUpperCase());
  }
  if (name === 'setx' && args[0]) names.push(String(args[0]).toUpperCase());
  if (PS_ITEM_WRITERS.has(name)) {
    for (const arg of args) {
      const env = String(arg).match(/^env:\\?(\w+)/i);
      if (env) names.push(env[1].toUpperCase());
    }
  }
  return names;
}

function baseName(word) {
  const last = String(word).split(/[\\/]/).pop() || '';
  return last.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

// git's subcommand, skipping its global options. Also returns the global
// options, since some of them run other programs (-c core.sshCommand=...).
function gitSubcommand(args) {
  const globals = [];
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) {
    const option = args[index];
    globals.push(option);
    index++;
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'].includes(option) && index < args.length) {
      globals.push(args[index]);
      index++;
    }
  }
  return { sub: (args[index] || '').toLowerCase(), rest: args.slice(index + 1), globals };
}

// --- code given to another shell --------------------------------------------------

const UNIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'ash', 'mksh']);
const POWERSHELLS = new Set(['pwsh', 'powershell', 'powershell_ise']);
// PowerShell accepts any unambiguous start of a parameter name: -c, -com, -Command.
const isPsParam = (word, name, min) => {
  const value = String(word).replace(/^[-/]+/, '').toLowerCase();
  return /^[-/]/.test(word) && value.length >= min && name.startsWith(value);
};

function decodePowerShell(base64) {
  try {
    return Buffer.from(base64, 'base64').toString('utf16le');
  } catch {
    return '';
  }
}

// The code a command hands to another shell, if any: [{ text, powershell }].
function innerCode(command) {
  const { name, args } = program(command.words, command);
  const out = [];
  if (UNIX_SHELLS.has(name)) {
    // -c, or -c inside a group of short options: bash -lc "...", sh -ec "..."
    const index = args.findIndex((arg) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg) && !arg.startsWith('--'));
    if (index !== -1) {
      const script = args.slice(index + 1).find((arg) => !arg.startsWith('-'));
      if (script !== undefined) out.push({ text: script, powershell: false });
    }
  } else if (POWERSHELLS.has(name)) {
    const encoded = args.findIndex((arg) => isPsParam(arg, 'encodedcommand', 1) && /^[-/]e/i.test(arg));
    if (encoded !== -1 && args[encoded + 1]) out.push({ text: decodePowerShell(args[encoded + 1]), powershell: true });
    const commandIndex = args.findIndex((arg) => isPsParam(arg, 'command', 1));
    if (commandIndex !== -1) out.push({ text: args.slice(commandIndex + 1).join(' '), powershell: true });
    // Windows PowerShell runs a plain argument as a command (pwsh runs it as a file).
    if (encoded === -1 && commandIndex === -1 && name !== 'pwsh') {
      const options = new Set(['-noprofile', '-nologo', '-noninteractive', '-noexit', '-sta', '-mta']);
      let i = 0;
      while (i < args.length && args[i].startsWith('-')) i += options.has(args[i].toLowerCase()) ? 1 : 2;
      if (i < args.length) out.push({ text: args.slice(i).join(' '), powershell: true });
    }
  } else if (name === 'cmd') {
    const index = args.findIndex((arg) => /^\/[ck]$/i.test(arg));
    if (index !== -1) out.push({ text: args.slice(index + 1).join(' '), powershell: true });
  } else if (name === 'eval') {
    out.push({ text: args.join(' '), powershell: false });
  } else if (name === 'su') {
    const index = args.findIndex((arg) => arg === '-c' || arg === '--command');
    if (index !== -1 && args[index + 1]) out.push({ text: args[index + 1], powershell: false });
  } else if (name === 'iex' || name === 'invoke-expression') {
    out.push({ text: args.filter((arg) => !/^-command$/i.test(arg)).join(' '), powershell: true });
  } else if (['start-process', 'saps', 'start'].includes(name)) {
    // Start-Process -FilePath git -ArgumentList 'push' → git push
    let file = null;
    const rest = [];
    for (let i = 0; i < args.length; i++) {
      if (isPsParam(args[i], 'filepath', 1) && args[i + 1]) file = args[++i];
      else if (isPsParam(args[i], 'argumentlist', 1) && args[i + 1]) rest.push(...args[++i].split(/[\s,]+/));
      else if (/^-/.test(args[i])) i++;
      else if (file === null) file = args[i];
      else rest.push(...args[i].split(/[\s,]+/));
    }
    if (file) out.push({ words: [file, ...rest.filter(Boolean)] });
  } else if (name === 'find') {
    // find ... -exec cmd {} ; and -execdir, -ok, -okdir
    for (let i = 0; i < args.length; i++) {
      if (!/^-(exec|execdir|ok|okdir)$/.test(args[i])) continue;
      const end = args.findIndex((arg, j) => j > i && (arg === ';' || arg === '+'));
      const inner = args.slice(i + 1, end === -1 ? args.length : end);
      if (inner.length) out.push({ words: inner });
      i = end === -1 ? args.length : end;
    }
  }
  // env -S "rm -rf ~" splits the string into a command.
  const words = command.words;
  const split = words.findIndex((word, i) => (word === '-S' || word === '--split-string') && baseName(words.slice(0, i).find((before) => !ASSIGNMENT.test(before)) || '') === 'env');
  if (split !== -1 && words[split + 1]) out.push({ text: words[split + 1], powershell: false });
  return out;
}

// Every command a line runs, including the code it hands to other shells.
function parse(text, { powershell = false } = {}, depth = 0) {
  const commands = parseLevel(text, { powershell });
  // Deeper than this, the code a command hands on isn't read: it's marked, and the guards block it.
  if (depth >= MAX_DEPTH) return commands.map((command) => (innerCode(command).length ? { ...command, hidden: true } : command));
  const all = [];
  for (const command of commands) {
    all.push(command);
    for (const inner of innerCode(command)) {
      if (inner.words) {
        all.push({ words: inner.words, redirects: [], pipe: false, powershell: command.powershell, call: false, nested: true });
        all.push(...parse(inner.words.join(' '), { powershell: command.powershell }, depth + 1).slice(1).map((found) => ({ ...found, nested: true })));
      } else {
        all.push(...parse(inner.text, { powershell: inner.powershell }, depth + 1).map((found) => ({ ...found, nested: true })));
      }
    }
  }
  return all;
}

// The commands a line runs, as plain text, without heredoc bodies and
// here-strings: what pattern checks should look at.
const visibleText = (text, options) => parse(text, options).map((cmd) => [...cmd.words, ...cmd.redirects.map((redirect) => `${redirect.op}${redirect.target}`)].join(' ')).join('\n');

module.exports = { parse, program, envSets, gitSubcommand, baseName, visibleText };
