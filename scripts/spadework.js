#!/usr/bin/env node
'use strict';

// Helper CLI the Spadework skills call through Bash, e.g.
//   node "${CLAUDE_PLUGIN_ROOT}/scripts/spadework.js" config --json
// Commands people read (config, paths, validate, stack, graph, board, stop,
// run, stats) print text, or one JSON object with --json. The ones only
// skills read (init, triage, implement, handoff, merge, recover, adr, design,
// design-push, schedule) always print JSON. Commands marked (stdin) read JSON
// on standard input.

const fs = require('fs');
const path = require('path');

const outOfScope = require('../lib/out-of-scope');
const config = require('../lib/config');
const paths = require('../lib/paths');
const runs = require('../lib/runs');
const validate = require('../lib/validate');
const init = require('../lib/init');
const stack = require('../lib/stack');
const graphify = require('../lib/graphify');
const triage = require('../lib/triage');
const handoff = require('../lib/handoff');
const log = require('../lib/log');
const triageRows = require('../lib/triage-rows');
const board = require('../lib/board');
const implement = require('../lib/implement');
const merge = require('../lib/merge');
const { parseLooseJson } = require('../lib/json-file');
const { wholeNumber, workItemId } = require('../lib/numbers');
const { pause } = require('../lib/fs-atomic');
const { sameName } = config;

// triage wait: how long the skill waits, between two looks, for an MCP server that is still connecting.
const WAIT_SECONDS = { default: 10, max: 30 };

const USAGE = `Usage: spadework.js <command> [options] [--json]

Setup:
  config                                  Load and validate ~/.spadework/config.json
  paths                                   Print the Spadework data folder paths
  validate [--no-fetch]                   Local setup checks (the skill adds Azure DevOps)
  init state                              Current config, stack.md, defaults and graphify status
  init detect-repo <path> [--organization O --project P --repo R]
                                          A clone's remote and main branch, checked against O/P/R
  init panel                              Start the board's helper if needed and open init's config panel
                                          (no config.json: write one with the board on a free port first)
  init save                               Validate config.draft.json and make it the config
  init detect-stack <path>                What a repo's files say about its stack
  init save-stack                         Check stack.draft.md and make it stack.md
  stack [--project P --repo R]            Stack notes for agents (default: the repo of this folder)
  graph                                   The code graph of this folder's repo, as told to an agent, or why there is none

Triage (a repo is always --project P --repo R: two projects can have a repo with the same name).
Commands that read JSON take it on standard input, or from a file in the tmp folder with --in <name>; they print compact JSON:
  triage plan --session S [--project P [--repo a,b]] [--limit N] [--since YYYY-MM-DD] | --item <id> [--deep] | --retriage [--rows SHOP-1,SHOP-2] [--limit N]
                                          The run check, then what the run covers: repos, queries, limits, re-triage rows, cut-off implement runs
  triage repo --project P --repo R --session S
                                          Take the repo's lock, fetch its main branch, list its re-triage rows
  triage decide [--project P --repo R] [--force|--retriage] [--session S]
                                          (stdin) {items: [{id, project, area_path, rev, state, parent_id, comments, type?, assigned_to?, fields?}]}
                                          → items to plan, items to check, skip counts; writes the updates that need no planning
  triage start --session S [--project P --repo R]
                                          (stdin) {id | row, fields, relations?, deep?} → which repo, lock, claim; writes the planner's brief
  triage finish --session S --item N --result planned|needs_info|out_of_scope|failed [--error msg] [--end]
                                          (stdin, optional) {related?, parent?, page?, state_move?, quote?} → writes the row from the planner's answer
  triage outcome --session S --item N     What finish would make of a planned answer (planned or needs_info), writing nothing
  triage end --session S                  Unlock the repos of this session, count what it did
  triage kind --type T                    The depth (split, how, full), the type a split creates and the agent for a work item type
  triage match [--project P --repo R]     (stdin) [{id, project, area_path, links, row_repo, past_rows}]
                                          → each item's repo, or the question to ask
  triage prepare --project P --repo R     git fetch the repo's main branch
  triage lock|unlock --project P --repo R --session S
                                          Take or give back the repo's triage lock
  triage should-stop --project P --repo R --session S
                                          Whether a stop was asked for
  triage wait [--seconds N]               Wait N seconds (default 10, at most 30), for an MCP server that is still connecting
  triage claim|release --item N --session S [--project P --repo R]
                                          Claim a work item before analyzing it
  triage log --result <r> [--project P --repo R] [--item N] [--rev N] [--row ID] [--session S] [--duration ms] [--error msg]
                                          (with --session, the duration runs from the item's claim)
  stop --project P [--repo R] [--force]   Ask the running triages of a project (or one repo) to stop
                                          (--force: clear a crashed one)
  stop --row ID --force                   End the implement run of a row now (a killed chat): the row is set to Blocked
  stop --merge R [--project P] --force    End the merge run of a repo now (a killed chat): its folder is put back, the branch kept

Implement:
  implement plan <ids>                    The rows (SHOP-35,SHOP-36), this folder's repo, settings; sets cut-off rows to Blocked
  implement check|begin --row ID --session S
                                          Whether the row can go; begin also claims it, creates the branch,
                                          sets the row In progress and writes tmp/implement-<ID>.md for the agents
  implement report --row ID --session S [--reviewed <commit>]
                                          What the branch holds (and what came after the review)
  implement finish --row ID --session S --result implemented|blocked
                                          (stdin) {progress, log, reason?, feedback_used?} → the row's result; stops tracking it
  implement owner|reclaim --row ID --session S
                                          Who holds the row now: mine, free or other / take back a free row
  implement log --result <r> --row ID --session S [--error msg]
  recover                                 Set rows whose implement was cut off to Blocked

Merge (one repo: --project is needed only when two projects have a repo with that name):
  merge plan --session S --repo R [--project P] [--rows A,B] [--advise]
                                          The order to merge the repo's Implemented rows (or the rows given), with a reason
                                          per step, and the mode: advisory or one_branch (print it) or integrate (also saves the run)
  merge begin --session S                 Take the repo, create spadework/merge-<date>-<time> from the saved commit of main,
                                          turn pushing off
  merge next --session S [--resolution resolved|cannot_decide --reason "..."] [--review pass|blocking]
                                          Do the next thing: merged, conflict, review, retry, left_out, tested or done
  merge finish --session S                Write the results to the rows, turn pushing back on, close the run

Board (your own commands; runs don't use them):
  board                                   Start the board's page if it isn't running and open it
  board stop                              Stop the board's page
  board serve                             The page's own process (board starts it; run it to see why it doesn't start)
  board list [--prefix SHOP] [--status S] One line per row
  board show <id>                         The full row as JSON
  board set <id> <status>                 Change a row's status
  board feedback <id> [text]              Replace a row's feedback (no text: read standard input)
  board delete <id>                       Delete a row

Schedule:
  schedule target [--project P [--repo R]]
                                          A scheduled triage's task_id, title and prompt (no flags: all projects),
                                          and prompt_start, how Spadework's tasks are recognised

Handoff (creates the Requirements of a split as work items):
  handoff plan SHOP-41[,SHOP-42]          The rows to hand off (and the ones not on the board)
  handoff check --session S               (stdin) {rows: ["SHOP-41"]} → the work items to create per Feature, and the rows
                                          skipped. Reads the rows as edited on the board. Saves what this run may create.
  handoff filter --session S              (stdin) {parent_id, children: [{id, title, tags}]} (the Feature's children) → rows to create, adopted and skipped
  handoff created --session S             The work items this run created or adopted, with their rows and tags, and the rows still
                                          missing. Writes each work item into its row
  handoff links --session S               (stdin, optional) {relations: {"<work item id>": [its relations]}} → the Predecessor links to
                                          write between this run's work items, and the work items whose relations it still needs

Design (a design run: the main chat and its coordinator agent; tmp files have fixed names):
  design start --session S --file <spec> [--repo R [--project P]]
                                          Check the spec, the repo and the process, write the coordinator's brief; returns
                                          whether a placement is wanted (and why not) and the backlog query
  design backlog --session S              (stdin) {items: [{id, type, title, parent, area_path}]} → the backlog file
  design questions --session S            The architect's questions (tmp file) wait for the user's answer
  design answers --session S              Save the answer (tmp file) with its questions, write the brief again
  design adr save --session S             Save the ADRs of the coordinator's draft (tmp file)
  design placement --session S            Check the coordinator's placement draft (tmp file), write ~/.spadework/designs/<name>.md
  design finish --session S --result review|failed|stopped [--reason "..."]
                                          Mark the run as done, delete its tmp files; the lines to print

Design push (creates the Epic and Features of a reviewed placement file):
  design-push check <name> --project P --repo R --area A --session S
                                          Read ~/.spadework/designs/<name>.md, check the flags, save what this run may create
  design-push filter --session S          (stdin) {epics: [{id, title, tags}]} → adopt, stop or create the new Epic;
                                          or {parent_id, children: [{id, title, tags}]} → Features to create, adopted and skipped
  design-push created --session S         What this run created or adopted, the items to tag, what is missing, the summary

ADRs:
  adr save --in <file>                    Save each ADR of the architect's answer (a file in the tmp folder) in this folder's
                                          repo: the next number, NNNN-<title>.md and its line in INDEX.md

Stats:
  stats [--days N]                        Triage and implement runs of the last N days (default 7, at most 30):
                                          items, time and tokens per agent

Runs:
  run list                               Runs, triage locks and claims
  run start <mode> <session>              Start a run (init, triage, implement, handoff, merge, design or design-push) in this folder
  run check <mode> <session>              Fails unless the session has a run of that mode
  run end <session>                       End the session's run

Skills pass their session as \${CLAUDE_SESSION_ID}.`;

const VALUE_FLAGS = new Set(['seconds', 'days', 'repo', 'item', 'session', 'result', 'duration', 'error', 'row', 'rows', 'project', 'organization', 'limit', 'since', 'reviewed', 'type', 'rev', 'prefix', 'status', 'in', 'resolution', 'review', 'reason', 'merge', 'area', 'file']);

// Splits arguments into positional words and --flags. Flags in VALUE_FLAGS
// take the next word as their value. A missing value is an error: taking
// the next flag as the value would quietly drop that flag.
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (VALUE_FLAGS.has(name)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
      flags[name] = value;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { positional, flags };
}

const printJson = (value, { compact = false } = {}) => process.stdout.write(JSON.stringify(value, null, compact ? undefined : 2) + '\n');

// Prints a result as JSON. The exit code is 1 when it says ok: false.
function done(result, options) {
  printJson(result, options);
  return result.ok === false ? 1 : 0;
}

// The same for commands people read: text, or JSON with --json.
function show(result, text, json) {
  process.stdout.write((json ? JSON.stringify(result, null, 2) : text) + '\n');
  return result.ok === false ? 1 : 0;
}

function readStdin() {
  return parseLooseJson(fs.readFileSync(0, 'utf8'));
}

// The file --in names: always a file in the tmp folder.
function tmpInputFile(flags) {
  const tmp = paths.all().tmp;
  const relative = path.relative(tmp, path.resolve(tmp, String(flags.in)));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`--in takes a file in ${tmp}`);
  return path.join(tmp, relative);
}

// The JSON a skill sends: on standard input, or in a file under tmp (--in).
// A lone backslash (Shop\Api) is accepted.
function readInput(flags) {
  if (flags.in === undefined) return readStdin();
  return parseLooseJson(fs.readFileSync(tmpInputFile(flags), 'utf8'));
}

// The same for input that may be left out.
function readInputOrEmpty(flags) {
  if (flags.in !== undefined) return readInput(flags);
  if (process.stdin.isTTY) return {};
  const text = fs.readFileSync(0, 'utf8');
  return text.trim() === '' ? {} : parseLooseJson(text);
}

function readStdinObject() {
  const value = readStdin();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a JSON object on standard input');
  return value;
}

function main(argv) {
  const { positional, flags } = parseArgs(argv.slice(2));
  const [command, ...rest] = positional;
  const json = Boolean(flags.json);

  switch (command) {
    case 'config': {
      const result = config.load();
      return show(result, config.format(result), json);
    }
    case 'paths': {
      const dataPaths = paths.all();
      const text = json
        ? JSON.stringify(dataPaths, null, 2)
        : Object.entries(dataPaths).map(([name, location]) => `${name}: ${location}`).join('\n');
      process.stdout.write(text + '\n');
      return 0;
    }
    case 'validate': {
      const result = validate.run({ fetch: !flags['no-fetch'] });
      return show(result, validate.format(result), json);
    }
    case 'init':
      return initCommand(rest, flags);
    case 'stack': {
      const repo = flags.repo ? resolveRepo(flags) : null;
      if (repo && repo.error) return show({ ok: false, error: repo.error }, repo.error, json);
      const result = repo ? stack.forRepo(repo.label) : stack.forFolder(process.cwd());
      process.stdout.write(json ? JSON.stringify(result, null, 2) + '\n' : result.text);
      return 0;
    }
    case 'graph': {
      const result = graphify.forFolder(process.cwd());
      return show(result, result.text || result.graph_hint || 'No code graph for this folder.', json);
    }
    case 'triage':
      return triageCommand(rest, flags);
    case 'board':
      return boardCommand(rest, flags, json);
    case 'stop':
      return stopCommand(flags, json);
    case 'implement':
      return implementCommand(rest, flags);
    case 'handoff':
      return handoffCommand(rest, flags);
    case 'merge':
      return mergeCommand(rest, flags);
    case 'recover':
      return recoverCommand(rest, flags);
    case 'run':
      return runCommand(rest, json);
    case 'stats':
      return statsCommand(flags, json);
    case 'adr':
      return adrCommand(rest, flags);
    case 'design':
      return designCommand(rest, flags);
    case 'design-push':
      return designPushCommand(rest, flags);
    case 'schedule': {
      if (rest[0] !== 'target') {
        process.stderr.write(USAGE + '\n');
        return 2;
      }
      const { config: cfg, error } = config.loadForRun();
      const result = error
        ? { ok: false, error }
        : require('../lib/schedule').target(cfg, { project: flags.project || null, repo: flags.repo || null });
      return done(result);
    }
    default:
      process.stderr.write(USAGE + '\n');
      return 2;
  }
}

function initCommand([action, ...rest], flags) {
  if (action === 'state') return done(init.state());
  if (action === 'panel') {
    // A first run writes config.json with the board's port first.
    return require('../lib/board-server').firstRun().then((first) => (first && first.error ? done({ ok: false, error: first.error }) : openPage({ page: 'config.html', json: true })));
  }
  if (action === 'detect-repo' && rest.length) {
    return done(init.detectRepo(rest.join(' '), { organization: flags.organization, project: flags.project, repo: flags.repo }));
  }
  if (action === 'save') return done(init.save());
  if (action === 'detect-stack' && rest.length) return done(stack.detect(rest.join(' ')));
  if (action === 'save-stack') {
    const loaded = config.load({ checkPaths: false });
    return done(stack.save({ repoNames: loaded.ok ? loaded.config.repos.map(config.repoLabel) : [] }));
  }
  process.stderr.write(USAGE + '\n');
  return 2;
}

const invalidSession = (sessionId) => ({
  ok: false,
  error: `invalid session id ${JSON.stringify(sessionId ?? '')}. Skills pass it as \${CLAUDE_SESSION_ID}`,
});

// --project P --repo R → the configured repo: { project, repo, label } or { error }.
function resolveRepo(flags) {
  if (typeof flags.project !== 'string' || !flags.project.trim()) {
    return { error: '--repo needs --project: two projects can have a repo with the same name' };
  }
  const { config: cfg, error } = config.loadForRun();
  if (error) return { error };
  const repo = config.findRepo(cfg.repos, flags.project, flags.repo);
  if (!repo) return { error: `Unknown repo: ${flags.project}/${flags.repo}` };
  return { project: repo.project, repo: repo.name, label: config.repoLabel(repo) };
}

function triageCommand([action], flags) {
  // The commands the skills read print compact JSON.
  const out = (result) => done(result, { compact: true });
  const needsSession = ['plan', 'repo', 'start', 'finish', 'end', 'lock', 'unlock', 'should-stop', 'claim', 'release'].includes(action) && !(action === 'plan' && flags.session === undefined);
  if (needsSession && !runs.isValidSessionId(flags.session)) return out(invalidSession(flags.session));
  const needsRepo = ['prepare', 'lock', 'unlock', 'should-stop', 'repo'].includes(action);
  if (needsRepo && !flags.repo) return out({ ok: false, error: '--project and --repo are required' });
  // A repo is named by its project and name. Locks, claims and logs use its label, "Shop/api".
  const repoArg = flags.repo && action !== 'plan' ? resolveRepo(flags) : null;
  if (repoArg && repoArg.error) return out({ ok: false, error: repoArg.error });
  const label = repoArg ? repoArg.label : null;
  const current = repoArg ? { project: repoArg.project, repo: repoArg.repo } : null;

  switch (action) {
    case 'plan': {
      const repoNames = typeof flags.repo === 'string' ? flags.repo.split(',').map((name) => name.trim()).filter(Boolean) : null;
      return out(triage.plan({
        project: typeof flags.project === 'string' ? flags.project : null,
        repoNames,
        item: flags.item ?? null,
        deep: Boolean(flags.deep),
        limit: flags.limit ?? null,
        since: flags.since ?? null,
        retriage: Boolean(flags.retriage),
        rowIds: typeof flags.rows === 'string' && flags.rows.trim() ? flags.rows : null,
        sessionId: flags.session ?? null,
      }));
    }
    case 'repo':
      return out(triageRows.repo({ project: repoArg.project, repo: repoArg.repo, sessionId: flags.session }));
    case 'decide':
      return out(triageRows.decide(readInput(flags), {
        project: typeof flags.project === 'string' ? flags.project : null,
        current,
        force: Boolean(flags.force),
        retriage: Boolean(flags.retriage),
        sessionId: runs.isValidSessionId(flags.session) ? flags.session : null,
      }));
    case 'start':
      return out(triageRows.start(readInput(flags), { sessionId: flags.session, current, force: Boolean(flags.force) }));
    case 'finish':
      return out(triageRows.finish(readInputOrEmpty(flags), { sessionId: flags.session, workItem: flags.item, result: flags.result, error: flags.error ?? null, end: Boolean(flags.end) }));
    case 'outcome':
      return out(triageRows.outcome({ sessionId: flags.session, workItem: flags.item }));
    case 'end':
      return out(triageRows.end(flags.session, readInputOrEmpty(flags)));
    case 'wait': {
      // Claude Code may block a plain sleep, so the skill waits here for a server that is still connecting.
      const seconds = flags.seconds === undefined ? WAIT_SECONDS.default : wholeNumber(flags.seconds, { min: 1 });
      if (seconds === null || seconds > WAIT_SECONDS.max) return out({ ok: false, error: `--seconds must be a whole number from 1 to ${WAIT_SECONDS.max}` });
      pause(seconds * 1000);
      return out({ ok: true, waited_seconds: seconds });
    }
    case 'kind': {
      const { config: cfg, error } = config.loadForRun();
      if (error) return out({ ok: false, error });
      if (!config.isNonEmptyString(flags.type)) return out({ ok: false, error: '--type is required' });
      return out(config.kindOf(cfg, String(flags.type).trim()));
    }
    case 'match':
      return out(triage.match(readInput(flags), current));
    case 'prepare':
      return out(triage.prepare(current.project, current.repo));
    case 'lock':
      runs.touch(flags.session);
      return out(runs.lockRepo(flags.session, label));
    case 'unlock':
      runs.unlockRepo(flags.session, label);
      return out({ ok: true });
    case 'should-stop': {
      runs.touch(flags.session);
      const reason = runs.stopReason(flags.session, label);
      return out({ ok: true, stop: reason !== null, reason });
    }
    case 'claim':
      return out(runs.claim(flags.session, flags.item, label));
    case 'release':
      runs.releaseClaim(flags.session, flags.item);
      return out({ ok: true });
    case 'log': {
      // A bad value is refused: the log feeds /spadework:stats.
      const item = flags.item === undefined ? null : workItemId(flags.item);
      if (flags.item !== undefined && item === null) return out({ ok: false, error: '--item must be a work item ID' });
      let duration = flags.duration === undefined ? null : wholeNumber(flags.duration);
      if (flags.duration !== undefined && duration === null) return out({ ok: false, error: '--duration must be a whole number of milliseconds' });
      // Without --duration, time it from when this session claimed the item.
      if (duration === null && item !== null && runs.isValidSessionId(flags.session)) {
        const claimed = runs.readClaim(flags.session, item);
        if (claimed && claimed.claimed_at) duration = Date.now() - Date.parse(claimed.claimed_at);
      }
      const rev = flags.rev === undefined ? null : wholeNumber(flags.rev);
      if (flags.rev !== undefined && rev === null) return out({ ok: false, error: '--rev must be a whole number' });
      if (flags.result === 'out_of_scope' && (item === null || rev === null || !current)) {
        return out({ ok: false, error: 'out_of_scope needs --item, --rev and --project and --repo' });
      }
      const logged = log.append({
        command: 'triage',
        session_id: runs.isValidSessionId(flags.session) ? flags.session : null,
        work_item_id: item,
        row_id: flags.row ?? null,
        repo: label,
        result: flags.result,
        duration_ms: Number.isFinite(duration) ? duration : null,
        error: flags.error ?? null,
      });
      // Remembered only once the log line is written.
      if (logged.ok && flags.result === 'out_of_scope') outOfScope.record(current, item, rev);
      return out(logged);
    }
    default:
      process.stderr.write(USAGE + '\n');
      return 2;
  }
}

function handoffCommand([action, ...rest], flags) {
  if (action === 'plan') return done(handoff.plan(rest.join(',')));
  if (!['check', 'filter', 'created', 'links'].includes(action)) {
    process.stderr.write(USAGE + '\n');
    return 2;
  }
  if (!runs.isValidSessionId(flags.session)) return done(invalidSession(flags.session));
  runs.touch(flags.session);
  if (action === 'check') return done(handoff.check(readStdinObject(), flags.session));
  if (action === 'filter') return done(handoff.filter(readStdinObject(), flags.session));
  if (action === 'links') return done(handoff.links(readInputOrEmpty(flags), flags.session));
  return done(handoff.created(flags.session));
}

function implementCommand([action, ...rest], flags) {
  if (action === 'plan') return done(implement.plan(rest.join(','), { cwd: process.cwd() }));
  if (!['check', 'begin', 'reclaim', 'owner', 'report', 'finish', 'log'].includes(action)) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  if (!runs.isValidSessionId(flags.session)) return done(invalidSession(flags.session));
  runs.touch(flags.session);
  const options = { cwd: process.cwd(), sessionId: flags.session };
  const rowId = String(flags.row || '').toUpperCase();
  if (!implement.ROW_ID.test(rowId)) return done({ ok: false, error: '--row takes a row ID like SHOP-35' });
  if (action === 'check') return done(implement.check(rowId, options));
  if (action === 'begin') return done(implement.begin(rowId, options));
  if (action === 'reclaim') return done(implement.reclaim(rowId, options));
  if (action === 'owner') return done(implement.owner(rowId, options));
  if (action === 'report') return done(implement.report(rowId, { ...options, reviewed: flags.reviewed }));
  if (action === 'finish') return done(implement.finish(rowId, flags.result, readStdinObject(), options));
  return done(implement.logResult({ result: flags.result, rowId, repo: flags.repo, sessionId: flags.session, error: flags.error ?? null }));
}

// /spadework:merge. Every command prints JSON for the skill.
function mergeCommand([action], flags) {
  if (!runs.isValidSessionId(flags.session)) return done(invalidSession(flags.session));
  if (action === 'plan') {
    return done(merge.plan({
      sessionId: flags.session, repoName: flags.repo, project: typeof flags.project === 'string' ? flags.project : null, rows: flags.rows || null, advise: Boolean(flags.advise),
    }));
  }
  if (action === 'begin') return done(merge.begin({ sessionId: flags.session }));
  if (action === 'next') {
    const choice = (name, allowed) => (flags[name] === undefined || allowed.includes(flags[name]) ? null : `--${name} is ${allowed.join(' or ')}`);
    const wrong = choice('resolution', ['resolved', 'cannot_decide']) || choice('review', ['pass', 'blocking']);
    if (wrong) return done({ ok: false, error: wrong });
    return merge.next({ sessionId: flags.session, resolution: flags.resolution || null, reason: flags.reason || null, review: flags.review || null }).then((result) => done(result));
  }
  if (action === 'finish') return done(merge.finish({ sessionId: flags.session }));
  process.stderr.write(USAGE + '\n');
  return 2;
}

// /spadework:design. Every command prints compact JSON for the skill and the coordinator.
function designCommand([action, more], flags) {
  const design = require('../lib/design');
  const out = (result) => done(result, { compact: true });
  if (!runs.isValidSessionId(flags.session)) return out(invalidSession(flags.session));
  runs.touch(flags.session);
  switch (action) {
    case 'start':
      return out(design.start({
        sessionId: flags.session, file: flags.file, repoName: typeof flags.repo === 'string' ? flags.repo : null, project: typeof flags.project === 'string' ? flags.project : null, cwd: process.cwd(),
      }));
    case 'backlog':
      return out(design.backlog(readInput(flags), flags.session));
    case 'questions':
      return out(design.questions(flags.session));
    case 'answers':
      return out(design.answers(flags.session));
    case 'adr':
      if (more !== 'save') break;
      return out(design.saveAdrs(flags.session));
    case 'placement':
      return out(design.placement(flags.session));
    case 'finish':
      return out(design.finish(flags.session, { result: flags.result, reason: typeof flags.reason === 'string' ? flags.reason : null }));
    default:
      break;
  }
  process.stderr.write(USAGE + '\n');
  return 2;
}

// /spadework:design-push. Every command prints JSON for the skill.
function designPushCommand([action, name], flags) {
  if (!['check', 'filter', 'created'].includes(action)) {
    process.stderr.write(USAGE + '\n');
    return 2;
  }
  if (!runs.isValidSessionId(flags.session)) return done(invalidSession(flags.session));
  runs.touch(flags.session);
  const push = require('../lib/design-push');
  if (action === 'check') {
    return done(push.check({
      sessionId: flags.session, name, project: typeof flags.project === 'string' ? flags.project : null, repo: typeof flags.repo === 'string' ? flags.repo : null, area: typeof flags.area === 'string' ? flags.area : null,
    }));
  }
  if (action === 'filter') return done(push.filter(readStdinObject(), flags.session));
  return done(push.created(flags.session));
}

// /spadework:architect saves the agent's ADRs: adr save --in <file in tmp>.
function adrCommand([action], flags) {
  if (action !== 'save' || flags.in === undefined) {
    process.stderr.write(USAGE + '\n');
    return 2;
  }
  const text = fs.readFileSync(tmpInputFile(flags), 'utf8');
  const where = require('../lib/adr').target({ cwd: process.cwd() });
  if (where.error) return done({ ok: false, error: where.error });
  const result = require('../lib/adr').save({ repoPath: where.repo_path, folder: where.folder, text, mainRef: where.main_ref });
  if (!result.ok) return done(result);
  return done({ ...result, next: 'Tell the user the path of each ADR and its decision in a few lines.' });
}

// /spadework:stats. Logs are kept 30 days, so that's as far back as it goes.
function statsCommand(flags, json) {
  const days = flags.days === undefined ? 7 : wholeNumber(flags.days, { min: 1 });
  if (days === null || days > 30) {
    const error = '--days must be a whole number from 1 to 30';
    return show({ ok: false, error }, error, json);
  }
  const stats = require('../lib/stats');
  const result = stats.collect({ days });
  return show(result, stats.format(result), json);
}

// Rows whose implement run was cut off. Implement and triage set them to Blocked themselves.
function recoverCommand([action]) {
  if (action !== undefined) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  return done(implement.recover());
}

// The board's page (or init's panel, page config.html): starts the helper if
// it isn't running and opens the page in the browser through a file that
// holds the keyed link. The key is never printed: it would end up in the
// chat's transcript. With no config.json the helper still starts (a first
// run); a config that is wrong opens only the panel, which is there to fix it.
async function openPage({ page = '', json }) {
  const boardServer = require('../lib/board-server');
  if (!page && fs.existsSync(paths.all().config)) {
    const loaded = config.loadForRun();
    if (loaded.error) return show({ ok: false, error: loaded.error }, loaded.error, json);
  }
  const started = await boardServer.launch({ port: boardServer.configuredPort() });
  if (started.error) return show({ ok: false, error: started.error }, started.error, json);
  const file = boardServer.writeOpenPage(started.port, started.key, { page });
  boardServer.openLink(file);
  const url = `http://127.0.0.1:${started.port}`;
  const text = `${started.started ? 'The board is running.' : 'The board was already running.'} Opening ${url} in your browser.\nIf it didn't open, open this file in your browser: ${file} (it holds the board's key, so don't share it).`;
  return show({ ok: true, port: started.port, url, file, started: started.started }, text, json);
}

// The local board's rows, and its page. These are the user's own commands: runs don't use them.
function boardCommand([action, ...rest], flags, json) {
  const print = (result, text) => show(result, text, json);
  const fail = (error) => print({ ok: false, error }, error);
  if (action === undefined) return openPage({ json });
  if (action === 'stop') {
    return require('../lib/board-server').stop().then((was) => print({ ok: true, was_running: was }, was ? 'The board is stopped.' : 'The board was not running.'));
  }
  if (action === 'serve') {
    const boardServer = require('../lib/board-server');
    return boardServer.serve({ port: boardServer.configuredPort() }).then(() => 0, (err) => fail(err.message));
  }
  const needsId = ['show', 'set', 'feedback', 'delete'].includes(action);
  const id = needsId ? String(rest[0] || '').toUpperCase() : null;
  if (needsId && !board.parseId(id)) return fail(`"${rest[0] || ''}" isn't a row ID like SHOP-35`);
  const missing = () => fail(`${id} not found`);

  switch (action) {
    case 'list': {
      const { rows, errors } = board.listRows({ prefix: typeof flags.prefix === 'string' ? flags.prefix.toUpperCase() : undefined });
      const shown = rows.filter((row) => typeof flags.status !== 'string' || sameName(row.status, flags.status)).map(board.summary);
      const lines = shown.map((row) => {
        const event = row.last_event ? `  (${row.last_event.at.slice(0, 10)} · ${row.last_event.text})` : '';
        return `${row.id}  ${row.status}  ${row.type}  ${row.title}${event}`;
      });
      lines.push(...errors.map(({ file, error }) => `Can't read ${file}: ${error}`));
      return print({ ok: true, rows: shown, errors }, lines.join('\n') || 'No rows.');
    }
    case 'show': {
      const row = board.readRow(id);
      return row ? print({ ok: true, row }, JSON.stringify(row, null, 2)) : missing();
    }
    case 'set': {
      if (!config.isNonEmptyString(rest[1])) return fail('board set needs a status, e.g. board set SHOP-35 Approved');
      const status = rest.slice(1).join(' ').trim();
      const changed = board.setStatus(id, status, { by: 'user' });
      if (!changed) return missing();
      return print({ ok: true, id, from: changed.from, status }, `${id}: ${changed.from} → ${status}`);
    }
    case 'feedback': {
      // No text on the command line: read it from standard input.
      const text = rest.length > 1 ? rest.slice(1).join(' ') : fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
      const row = board.setFeedback(id, text);
      return row ? print({ ok: true, id }, `${id}: feedback saved`) : missing();
    }
    case 'delete':
      return board.deleteRow(id) ? print({ ok: true, id }, `${id} deleted`) : missing();
    default:
      process.stderr.write(USAGE + '\n');
      return 2;
  }
}

// /spadework:stop --project P [--repo R]: one repo, or every repo of the
// project that a triage is running on.
function stopCommand(flags, json) {
  const print = (result, text) => show(result, text, json);
  if (flags.merge !== undefined) {
    // Like --row: the merge ends now, so only with --force.
    if (!flags.force) return print({ ok: false, error: '--merge needs --force' }, `Ending a merge run stops it mid-way, for a chat that was killed or closed. Run it again with --force: /spadework:stop --merge ${flags.merge} --force`);
    const result = merge.forceStop({ repoName: flags.merge, project: typeof flags.project === 'string' ? flags.project : null });
    return print(result, result.ok ? result.lines.join('\n') || 'Nothing to recover.' : result.error);
  }
  if (flags.row !== undefined) {
    // Implement has no stop that waits: the run ends now, so only with --force.
    if (!flags.force) return print({ ok: false, error: '--row needs --force' }, `Ending an implement run stops it mid-way, for a chat that was killed or closed. Run it again with --force: /spadework:stop --row ${String(flags.row).toUpperCase()} --force`);
    const result = implement.forceStop(flags.row);
    return print(result, result.ok ? result.lines.join('\n') || 'Nothing to recover.' : result.error);
  }
  if (typeof flags.project !== 'string' || !flags.project.trim()) {
    return print({ ok: false, error: '--project is required' }, 'Say which project to stop, e.g. /spadework:stop --project Shop, or one repo: /spadework:stop --project Shop --repo api');
  }
  let labels;
  if (flags.repo) {
    const repo = resolveRepo(flags);
    // A repo removed from config.json while its triage ran: its lock still
    // has its name, so stop that lock and nothing else.
    const label = `${flags.project.trim()}/${String(flags.repo).trim()}`;
    const orphan = repo.error && runs.listLocks().find((lock) => config.sameName(lock.repo, label));
    if (repo.error && !orphan) return print({ ok: false, error: repo.error }, repo.error);
    labels = [orphan ? orphan.repo : repo.label];
  } else {
    const prefix = `${flags.project.trim().toLowerCase()}/`;
    // Locked repos, and repos whose triage lost its lock but still has a run file (a killed chat).
    labels = [...new Set([...runs.listLocks().map((lock) => lock.repo), ...runs.unlockedRepos()])].filter((repo) => String(repo).toLowerCase().startsWith(prefix));
    if (!labels.length) return print({ ok: false, error: `No triage is running for project ${flags.project}.` }, `No triage is running for project ${flags.project}.`);
  }
  const results = labels.map((label) => ({ repo: label, ...runs.requestStop(label, { force: Boolean(flags.force) }) }));
  const lines = results.map((result) => {
    if (!result.ok) return result.error;
    if (result.forced && !result.holder) return `No triage held the lock for ${result.repo} any more; the run file its chat left was removed. A new triage can start now.`;
    if (result.forced) return `The triage lock for ${result.repo} was removed${result.was_stale ? ' (its run had already ended)' : ''}. A new triage can start now.`;
    return `Asked the triage of ${result.repo} to stop. It finishes the work item it's on, then stops.`;
  });
  return print({ ok: results.every((result) => result.ok), results }, lines.join('\n'));
}

// Skills call start and end themselves, so a run is tracked even when the
// prompt hooks don't fire, and init can end its run when it finishes.
function runCommand([action, ...rest], json) {
  const print = (result, text) => show(result, text, json);

  if (action === 'list') {
    const result = { runs: runs.list(), locks: runs.listLocks(), claims: runs.listClaims() };
    return print(result, formatRuns(result));
  }

  const sessionId = action === 'start' || action === 'check' ? rest[1] : rest[0];
  if ((action === 'start' || action === 'end' || action === 'check') && !runs.isValidSessionId(sessionId)) {
    const result = invalidSession(sessionId);
    return print(result, `❌ ${result.error}`);
  }

  if (action === 'start') {
    const mode = rest[0];
    runs.pruneStale();
    const result = runs.start(sessionId, mode, { cwd: process.cwd() });
    return print(result, result.ok ? `✅ ${mode} run started` : `❌ ${result.error}`);
  }

  // A skill's first step: is its guarded run on? (It was started by the
  // typed command or by Claude loading the skill.)
  if (action === 'check') {
    const mode = rest[0];
    const run = runs.get(sessionId, { includeStale: true });
    const ok = Boolean(run && run.mode === mode);
    const result = ok ? { ok, mode } : { ok, error: `No ${mode} run in this session, so its safety checks are off. Start it again with /spadework:${mode}.` };
    return print(result, ok ? `✅ ${mode} run on` : `❌ ${result.error}`);
  }

  if (action === 'end') {
    const ended = runs.end(sessionId);
    return print({ ok: true, ended }, ended ? '✅ run ended' : 'No run to end.');
  }

  process.stderr.write(USAGE + '\n');
  return 2;
}

function formatRuns({ runs: list, locks, claims }) {
  const lines = [];
  if (list.length === 0) lines.push('No Spadework runs.');
  for (const run of list) {
    const state = run.stale ? `stale (no activity for ${runs.CUT_OFF_TEXT})` : 'active';
    lines.push(`${run.mode} in session ${run.session_id}: ${state}, started ${run.started_at}, last activity ${run.last_activity}`);
  }
  for (const lock of locks) {
    lines.push(`Triage of ${lock.repo}: session ${lock.session_id || 'unknown'}${lock.stale ? ' (stale)' : ''}${lock.stop_requested ? ', stop requested' : ''}`);
  }
  if (claims.length) lines.push(`Work items being analyzed: ${claims.map((claim) => claim.work_item_id).join(', ')}`);
  return lines.join('\n');
}

// A command may return a promise (the board's page and helper).
const failed = (err) => {
  // Bad input from a skill (e.g. invalid JSON on stdin): say what, no stack trace.
  printJson({ ok: false, error: err.message });
  process.exitCode = 1;
};
try {
  Promise.resolve(main(process.argv)).then((code) => { process.exitCode = code; }, failed);
} catch (err) {
  failed(err);
}
