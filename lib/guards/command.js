'use strict';

// command-guard: in every Spadework run, blocks shell commands that are
// never part of planning or implementing a work item:
// - downloading something and running it
// - wiping a drive or a home folder
// - reading stored credentials, or sending secrets over the network
//
// Only what actually runs is checked: heredoc bodies and here-strings are
// data (a work item's text sent to Spadework's helper, for example).

const fs = require('fs');
const os = require('os');
const path = require('path');

const { parse, program, baseName, visibleText } = require('./shell');
const { expandPath, isNetworkPath } = require('./common');

const DOWNLOADERS = new Set(['curl', 'wget', 'iwr', 'invoke-webrequest', 'irm', 'invoke-restmethod', 'start-bitstransfer', 'bitsadmin', 'certutil']);
const NETWORK = new Set([...DOWNLOADERS, 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'scp', 'sftp', 'ftp', 'rsync', 'ssh', 'send-mailmessage', 'tftp']);
// Programs that run code they're given: shells always, others with -c / -e.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd']);
const SCRIPTING = new Set(['python', 'python3', 'py', 'node', 'perl', 'ruby', 'php']);
const ALWAYS_RUNS = new Set(['iex', 'invoke-expression', 'source', '.']);
const RUNNERS = new Set([...SHELLS, ...SCRIPTING, ...ALWAYS_RUNS, 'start-process', 'msiexec', 'mshta', 'rundll32', 'regsvr32', 'wscript', 'cscript']);
const OPAQUE_RUNNERS = new Set(['start-process', 'saps', 'invoke-command', 'icm', 'start-job', 'sajb']);
const DELETERS = new Set(['rm', 'del', 'erase', 'rd', 'rmdir', 'remove-item', 'ri', 'rimraf']);
const DISK_TOOLS = new Set(['mkfs', 'wipefs', 'diskpart', 'format', 'format-volume', 'clear-disk', 'initialize-disk', 'remove-partition', 'fdisk', 'sfdisk', 'parted']);
const FILE_READERS = new Set(['cat', 'type', 'get-content', 'gc', 'more', 'head', 'tail', 'base64', 'xxd', 'od']);

// Files and folders that hold credentials. Reading them has no place in a
// Spadework run. A folder counts as a whole: .ssh, .aws, .azure, .gnupg, gcloud.
const END = '(?=[\\\\/"\'\\s]|$)';
const CREDENTIAL_FILES = new RegExp(`(^|[\\s\\\\/~"'=@])(${[
  `\\.ssh${END}`, `\\.aws${END}`, `\\.azure${END}`, `\\.gnupg${END}`, `\\.kube[\\\\/]config`, `\\.docker[\\\\/]config\\.json`,
  `\\.config[\\\\/]gcloud${END}`, '\\.config[\\\\/]gh[\\\\/]hosts\\.yml', '\\.config[\\\\/]git[\\\\/]credentials', '\\.git-credentials',
  '[._]netrc\\b', '\\.pgpass', 'nuget[\\\\/]nuget\\.config', '\\.claude[\\\\/]\\.credentials\\.json',
].join('|')})`, 'i');
// Files in the home folder itself that hold registry tokens: ~/.npmrc, ~/.pypirc.
const HOME_TOKEN_FILES = ['.npmrc', '.pypirc', '.yarnrc.yml'];
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HOME_PREFIX = `(~|\\$home|\\$\\{home\\}|\\$env:userprofile|%userprofile%|${escapeRe(os.homedir()).replace(/\\\\|\//g, '[\\\\/]')})`;
const HOME_TOKENS = new RegExp(`${HOME_PREFIX}[\\\\/](${HOME_TOKEN_FILES.map(escapeRe).join('|')})${END}`, 'i');
// Files that often hold secrets: sending them anywhere is blocked.
const SECRET_FILE = /(^|[\\/@])(\.env(\.[\w-]+)?|appsettings(\.[\w-]+)?\.json|secrets?\.(json|ya?ml)|credentials?\.(json|ya?ml|xml)|[\w-]+\.(pfx|p12|pem|key)|web\.config|local\.settings\.json|\.npmrc|\.pypirc)$/i;
// Variables that usually hold a secret: $GITHUB_TOKEN, ${API_KEY}, $env:AZURE_PAT
const SECRET_VARIABLE = /\$(env:)?\{?[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PAT|CREDENTIALS?|CONNECTION_?STRING)\b/i;
// Commands that print stored tokens or passwords.
const TOKEN_COMMANDS = [
  /\bgh\s+auth\s+token\b/i,
  /\baz\s+account\s+get-access-token\b/i,
  /\bgit\s+credential(-\w+)?\s+(fill|get)\b/i,
  /\baws\s+(configure\s+export-credentials|sts\s+get-session-token)\b/i,
  /\bsecurity\s+find-(generic|internet)-password\b/i,
  /\bcmdkey\s+\/list\b/i,
  /\bGet-StoredCredential\b/i,
  /\bConvertFrom-SecureString\b/i,
];

// Places whose recursive delete would wipe a drive or a home folder.
const ROOTS = /^(\/\*?|~[\\/]?\*?|\$home[\\/]?\*?|\$\{home\}[\\/]?\*?|\$env:(userprofile|homepath|systemdrive)[\\/]?\*?|\/(home|users|root|etc|usr|var|bin|boot)\/?\*?|[a-z]:[\\/]?\*?|[a-z]:[\\/](users|windows|program files[^\\/]*)[\\/]?\*?|\.\.?[\\/]?\*?|\*)$/i;

// rm -r / -R / -rf, --recursive, PowerShell -Recurse (or a short form of
// it), cmd's /s, rimraf. Not -Force.
function isRecursive(name, args) {
  if (name === 'rimraf') return true;
  return args.some((arg) => /^--recursive$/i.test(arg)
    || /^\/s$/i.test(arg)
    || /^-r(e(c(u(r(se?)?)?)?)?)?$/i.test(arg)
    || (name === 'rm' && /^-[rRfivdIP]+$/.test(arg) && /[rR]/.test(arg)));
}

// Where downloaders save their files, as written: -o FILE, -O FILE,
// --output FILE, --output-dir DIR, -OutFile FILE. curl's -O (--remote-name)
// saves in the current folder, given as ".".
function downloadedFiles(programs) {
  const files = [];
  for (const prog of programs) {
    if (!DOWNLOADERS.has(prog.name)) continue;
    prog.args.forEach((arg, index) => {
      if (prog.name === 'curl' && /^(-O|--remote-name(-all)?)$/.test(arg)) files.push('.');
      else if (/^(-o|-O|--output|--output-document|--output-dir|-OutFile)$/i.test(arg) && prog.args[index + 1]) files.push(prog.args[index + 1]);
      const glued = arg.match(/^(--output|--output-document|--output-dir|-OutFile)[=:](.+)$/i);
      if (glued) files.push(glued[2]);
    });
  }
  return files.filter(Boolean);
}

// Whether a program runs the text piped into it as code: `bash`, `sh -s`,
// `python -`, `iex`. Not `python -m json.tool` or `node script.js`.
function runsStdin(prog) {
  if (ALWAYS_RUNS.has(prog.name)) return true;
  const positional = prog.args.filter((arg) => !arg.startsWith('-'));
  if (SHELLS.has(prog.name)) return positional.length === 0 && !prog.args.some((arg) => /^-(c|Command|File|EncodedCommand)$/i.test(arg));
  if (SCRIPTING.has(prog.name)) return prog.args.length === 0 || prog.args[0] === '-';
  return false;
}

// A shell or interpreter reading its code from a pipe, a heredoc or <<<:
// that code is never parsed. (iex's code is parsed, and source runs a file.)
const readsCodeFromStdin = (prog) => (SHELLS.has(prog.name) || SCRIPTING.has(prog.name)) && runsStdin(prog);

// Whether a program runs code given in its arguments: bash -c "...", node -e "...".
const runsArgument = (prog) => ALWAYS_RUNS.has(prog.name)
  || ((SHELLS.has(prog.name) || SCRIPTING.has(prog.name)) && prog.args.some((arg) => /^-(c|e|-eval|Command|EncodedCommand)$/i.test(arg)));

// The pipelines in a command line: runs of commands joined by |.
function pipelines(programs) {
  const groups = [];
  let current = [];
  for (const prog of programs) {
    current.push(prog);
    if (!prog.pipe) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

// Returns a reason to block, or null.
function check(command, { powershell = false, cwd = process.cwd() } = {}) {
  const text = String(command || '');
  const programs = parse(text, { powershell }).map((cmd) => ({ ...program(cmd.words, cmd), pipe: cmd.pipe, raw: cmd.words.join(' '), literal: cmd.literal || new Set() }));
  const visible = visibleText(text, { powershell });
  const names = new Set(programs.map((prog) => prog.name));

  // 0. PowerShell code passed encoded, so nobody can read it before it runs.
  // PowerShell accepts any start of the name: -e, -ec, -enc, -EncodedCommand.
  const isEncoded = (arg) => /^[-/]e/i.test(arg) && 'encodedcommand'.startsWith(arg.replace(/^[-/]+/, '').toLowerCase());
  if (programs.some((prog) => ['pwsh', 'powershell', 'powershell_ise'].includes(prog.name) && prog.args.some(isEncoded))) {
    return 'Blocked: PowerShell -EncodedCommand hides what it runs. Write the command out instead.';
  }

  // 1. Download and run: piped into something that runs it, passed to one
  // through a substitution, saved and then run, or PowerShell's iex.
  const downloads = programs.some((prog) => DOWNLOADERS.has(prog.name)) || /DownloadString|DownloadFile|DownloadData|Net\.WebClient/i.test(visible);
  if (downloads) {
    const piped = pipelines(programs).some((group) => group.some((prog, i) => i > 0 && runsStdin(prog) && group.slice(0, i).some((earlier) => DOWNLOADERS.has(earlier.name))));
    const viaSubstitution = programs.some((prog) => runsArgument(prog) && prog.args.some((arg) => arg.includes('$SUB')));
    const iex = names.has('iex') || names.has('invoke-expression') || /ScriptBlock\]::Create/i.test(visible);
    // A file saved under its remote name (curl -O) isn't known by name here.
    const saved = downloadedFiles(programs).filter((file) => file !== '.').map(baseName);
    const runsSaved = saved.length > 0 && (/\bchmod\s+[+0-7]*x/i.test(visible)
      || programs.some((prog) => saved.includes(prog.name) || (RUNNERS.has(prog.name) && prog.args.some((arg) => saved.includes(baseName(arg))))));
    // Something that runs code we can't see: & $x, $CMD, Start-Process, Invoke-Command.
    const opaque = programs.some((prog) => prog.name.startsWith('$') || OPAQUE_RUNNERS.has(prog.name));
    if (piped || viaSubstitution || iex || runsSaved || opaque) {
      return 'Blocked: this command downloads something and runs it. Spadework runs never do that.';
    }
  }

  // 2. Wiping a drive or a home folder.
  for (const prog of programs) {
    if (DISK_TOOLS.has(prog.name) || /^mkfs(\.|$)/.test(prog.name)) {
      if (prog.name === 'format' && !prog.args.some((arg) => /^[a-z]:$/i.test(arg))) continue;
      return `Blocked: ${prog.name} formats or repartitions disks.`;
    }
    if (prog.name === 'dd' && prog.args.some((arg) => /^of=\/dev\//i.test(arg))) return 'Blocked: dd writing to a device would wipe it.';
    // find / -delete, find ~ -exec rm ...: the starting folders are the arguments before the first option.
    if (prog.name === 'find' && prog.args.some((arg) => /^-(delete|exec|execdir|ok|okdir)$/.test(arg))) {
      const firstOption = prog.args.findIndex((arg) => /^[-(!]/.test(arg));
      const starts = firstOption === -1 ? prog.args : prog.args.slice(0, firstOption);
      // find . -name '*.tmp' -delete in the current folder is ordinary cleanup.
      if (starts.some((start) => ROOTS.test(start.trim()) && !/^\.[\\/]?$/.test(start.trim()))) {
        return `Blocked: "${prog.raw}" would delete or change files across a drive or a home folder.`;
      }
    }
    if (prog.name === 'shred' || (prog.name === 'cipher' && prog.args.some((arg) => /^\/w/i.test(arg)))) return `Blocked: ${prog.name} destroys data.`;
    if (DELETERS.has(prog.name)) {
      if (prog.args.includes('--no-preserve-root')) return 'Blocked: deleting the whole drive.';
      const targets = prog.args.filter((arg) => !/^-/.test(arg) && !/^\/[a-z]$/i.test(arg));
      if (isRecursive(prog.name, prog.args) && targets.some((target) => ROOTS.test(target.trim()))) {
        return `Blocked: "${prog.raw}" would delete a drive, a home folder or a whole folder tree. Delete specific folders instead.`;
      }
    }
  }

  // 3. Credentials and secrets.
  // bash doesn't expand a quoted wildcard: grep "^[Authorize" names no files.
  const viaWildcard = programs.some((prog) => prog.args.some((arg) => /[*?[]/.test(arg) && !prog.literal.has(arg) && touchesCredentials(arg, cwd)));
  if (CREDENTIAL_FILES.test(visible) || HOME_TOKENS.test(visible) || viaWildcard) return 'Blocked: this command touches stored credentials (SSH keys, cloud or git credentials). Spadework runs never need them.';
  if (TOKEN_COMMANDS.some((pattern) => pattern.test(visible))) return 'Blocked: this command prints a stored token or password.';
  if ([...names].some((name) => NETWORK.has(name)) && sendsSecrets(programs)) {
    return 'Blocked: this command would send secrets (a secrets file, environment variables or a token) over the network.';
  }
  return null;
}

// A network program that gets a secrets file, the environment or a token
// variable, as an argument, through a substitution, or through a pipe.
function sendsSecrets(programs) {
  const secretArg = (arg) => SECRET_FILE.test(arg.replace(/^.*?=@?|^@/, '')) || SECRET_VARIABLE.test(arg);
  const dumpsEnv = (prog) => ['env', 'printenv'].includes(prog.name) && prog.args.length === 0
    || (['set', 'export'].includes(prog.name) && (prog.args.length === 0 || prog.args.join(' ') === '-p'))
    || (['get-childitem', 'gci', 'dir', 'ls'].includes(prog.name) && prog.args.some((arg) => /^env:/i.test(arg)));
  const feedsSecrets = (prog) => dumpsEnv(prog) || (FILE_READERS.has(prog.name) && prog.args.some((arg) => SECRET_FILE.test(arg)));

  for (const prog of programs) {
    if (!NETWORK.has(prog.name)) continue;
    if (prog.args.some(secretArg)) return true;
    // curl -d "$(cat .env)": the substitution's command is listed separately.
    if (prog.args.some((arg) => arg.includes('$SUB')) && programs.some(feedsSecrets)) return true;
  }
  return pipelines(programs).some((group) => group.some((prog, i) => NETWORK.has(prog.name) && group.slice(0, i).some(feedsSecrets)));
}

// Whether a path is a stored-credentials file or folder.
const isCredentialPath = (file) => {
  const text = String(file || '');
  return CREDENTIAL_FILES.test(text.replace(/\\/g, '/')) || HOME_TOKENS.test(text);
};

// The files a wildcard path matches right now (~/.ss?/id_* → ~/.ssh/id_rsa),
// at most `limit`. Hidden names match too, unlike in bash: the check errs on
// the side of seeing more.
function expandGlob(word, cwd, limit = 200) {
  const raw = String(word || '').replace(/^["']|["']$/g, '');
  if (!/[*?[]/.test(raw) || isNetworkPath(raw)) return [];
  const pattern = expandPath(raw, cwd);
  if (!pattern) return [];
  const { root } = path.parse(pattern);
  // An invalid pattern (a [ never closed) is a plain name, as in bash.
  const toRe = (part) => {
    try {
      return new RegExp(`^${part.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
    } catch {
      return { test: (name) => name.toLowerCase() === part.toLowerCase() };
    }
  };
  let current = [root];
  for (const part of pattern.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    const next = [];
    const re = /[*?[]/.test(part) ? toRe(part) : null;
    for (const dir of current) {
      if (!re) {
        next.push(path.join(dir, part));
        continue;
      }
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        // not a folder, or not readable
      }
      for (const name of names) if (re.test(name)) next.push(path.join(dir, name));
      if (next.length >= limit) break;
    }
    current = next.slice(0, limit);
    if (!current.length) break;
  }
  return current;
}

// Whether a path, as written in a command or a tool call, reaches stored
// credentials: by name, once ~ and the folder are filled in, or through a wildcard.
function touchesCredentials(word, cwd) {
  if (isCredentialPath(word)) return true;
  const full = expandPath(String(word || '').replace(/^["']|["']$/g, ''), cwd);
  if (full && isCredentialPath(full)) return true;
  return expandGlob(word, cwd).some(isCredentialPath);
}

module.exports = { check, isCredentialPath, touchesCredentials, readsCodeFromStdin, downloadedFiles, DOWNLOADERS };
