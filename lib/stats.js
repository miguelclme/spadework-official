'use strict';

// /spadework:stats: what each triage, implement and handoff run of the last days did,
// how long it took and the tokens it used.
// - runs: the log's "run" lines (written when run-cleanup ends a run)
// - items: the log lines of the same session, between the run's start and end
// - tokens: the chat's transcript and its agents' transcripts
//   (<transcript>/subagents/agent-*.jsonl), only replies between the run's
//   start and end, split by agent type
// The transcript format isn't documented. If it changes, only the token
// columns go missing: the rest comes from Spadework's own log.
// Only transcripts inside Claude Code's projects folder are read: the log
// is a plain file, and a path edited into it could point anywhere (a
// network share would make Windows connect and send its login).

const fs = require('fs');
const path = require('path');
const log = require('./log');
const { localDateTime } = require('./dates');
const { readJsonLines, readJsonOrNull } = require('./json-file');
const { claudeProjects, isInside } = require('./guards/common');

const MODES = ['triage', 'implement', 'handoff', 'merge', 'design', 'design-push'];
const KINDS = ['input', 'cache_write', 'cache_read', 'output'];
const noTokens = () => ({ input: 0, cache_write: 0, cache_read: 0, output: 0 });
const sum = (tokens) => KINDS.reduce((total, kind) => total + tokens[kind], 0);
const count = (value) => (Number.isFinite(value) && value > 0 ? value : 0);

function addTokens(into, tokens) {
  for (const kind of KINDS) into[kind] += tokens[kind];
}

// The tokens of one transcript's replies between from and to (ms), or null
// when the file can't be read. One reply is written over several lines with
// the same message id; the last one holds its final usage.
function transcriptTokens(file, from, to) {
  const lines = readJsonLines(file);
  if (!lines) return null;
  const replies = new Map();
  for (const line of lines) {
    const message = line && line.type === 'assistant' ? line.message : null;
    if (!message || !message.usage) continue;
    const time = Date.parse(line.timestamp);
    if (!(time >= from && time <= to)) continue;
    replies.set(message.id || line.uuid || replies.size, message.usage);
  }
  const tokens = noTokens();
  for (const usage of replies.values()) {
    tokens.input += count(usage.input_tokens);
    tokens.cache_write += count(usage.cache_creation_input_tokens);
    tokens.cache_read += count(usage.cache_read_input_tokens);
    tokens.output += count(usage.output_tokens);
  }
  return tokens;
}

// The agents' transcripts of a chat: [{ file, type }]. The type comes from
// the agent's .meta.json next to it ("code-reviewer").
function agentTranscripts(transcriptPath) {
  const folder = path.join(path.dirname(transcriptPath), path.basename(transcriptPath, '.jsonl'), 'subagents');
  let names = [];
  try {
    names = fs.readdirSync(folder).filter((name) => /^agent-.+\.jsonl$/.test(name));
  } catch {
    return [];
  }
  return names.map((name) => {
    const meta = readJsonOrNull(path.join(folder, name.replace(/\.jsonl$/, '.meta.json')));
    const type = meta && meta.agentType;
    return { file: path.join(folder, name), type: typeof type === 'string' && type ? type : 'agent' };
  });
}

// A run's tokens: { by_agent: { main, <agent type>... }, total }, or null
// when its transcript is gone.
function runTokens(run) {
  const from = Date.parse(run.started_at);
  const to = Date.parse(run.ended_at);
  const file = run.transcript_path;
  if (!file || !path.isAbsolute(file) || !isInside(file, claudeProjects()) || !Number.isFinite(from) || !Number.isFinite(to)) return null;
  const main = transcriptTokens(file, from, to);
  if (!main) return null;
  const byAgent = { main };
  for (const agent of agentTranscripts(file)) {
    const tokens = transcriptTokens(agent.file, from, to);
    if (!tokens || !sum(tokens)) continue;
    if (!byAgent[agent.type]) byAgent[agent.type] = noTokens();
    addTokens(byAgent[agent.type], tokens);
  }
  const total = noTokens();
  for (const tokens of Object.values(byAgent)) addTokens(total, tokens);
  return { by_agent: byAgent, total };
}

// The runs of the last `days` days, oldest first, and their totals.
function collect({ days = 7, now = new Date() } = {}) {
  const lines = log.read({ days, now });
  const items = lines.filter((line) => line.kind !== 'run' && line.session_id);
  const runs = lines.filter((line) => line.kind === 'run' && MODES.includes(line.command)).map((line) => {
    const from = Date.parse(line.started_at);
    const to = Date.parse(line.ended_at);
    const own = items.filter((item) => {
      const time = Date.parse(item.time);
      return item.session_id === line.session_id && item.command === line.command && time >= from && time <= to;
    });
    // A line with a count stands for that many items (a repo's skipped ones).
    const size = (item) => (Number.isInteger(item.count) && item.count >= 0 ? item.count : 1);
    const results = {};
    for (const item of own) if (size(item)) results[item.result] = (results[item.result] || 0) + size(item);
    return {
      mode: line.command,
      session_id: line.session_id,
      started_at: line.started_at,
      ended_at: line.ended_at,
      duration_ms: Number.isFinite(from) && Number.isFinite(to) ? to - from : null,
      repos: [...new Set(own.map((item) => item.repo).filter(Boolean))],
      items: own.reduce((total, item) => total + size(item), 0),
      results,
      tokens: runTokens(line),
    };
  });

  const byAgent = {};
  for (const run of runs) {
    for (const [agent, tokens] of Object.entries(run.tokens ? run.tokens.by_agent : {})) {
      if (!byAgent[agent]) byAgent[agent] = noTokens();
      addTokens(byAgent[agent], tokens);
    }
  }
  const total = noTokens();
  for (const tokens of Object.values(byAgent)) addTokens(total, tokens);
  return {
    ok: true,
    days,
    runs,
    totals: {
      runs: runs.length,
      items: runs.reduce((total, run) => total + run.items, 0),
      tokens: { by_agent: byAgent, total },
      runs_without_tokens: runs.filter((run) => !run.tokens).length,
    },
  };
}

// --- text ---------------------------------------------------------------------

const when = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '?' : localDateTime(date);
};

function duration(ms) {
  if (!Number.isFinite(ms)) return '?';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return `${Math.round(ms / 1000)}s`;
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

// 950, 12.4k, 1.3M
function amount(tokens) {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1e6) return `${(tokens / 1e3).toFixed(1)}k`;
  return `${(tokens / 1e6).toFixed(1)}M`;
}

// A token table: one line per agent, and a total when there are several.
function tokenTable(tokens, indent) {
  const rows = Object.entries(tokens.by_agent);
  if (rows.length > 1) rows.push(['total', tokens.total]);
  const width = Math.max(...rows.map(([name]) => name.length), 'tokens'.length);
  const header = ['input', 'cache write', 'cache read', 'output', 'total'];
  const cells = (values) => values.map((value, i) => value.padStart(header[i].length + 2)).join('');
  return [
    indent + 'tokens'.padEnd(width) + cells(header),
    ...rows.map(([name, t]) => indent + name.padEnd(width) + cells([...KINDS.map((kind) => amount(t[kind])), amount(sum(t))])),
  ];
}

function format(result) {
  const { runs, totals } = result;
  const span = result.days === 1 ? 'today' : `in the last ${result.days} days`;
  if (!runs.length) return `No triage, implement, handoff, merge, design or design-push runs ${span}.`;
  const out = [`Spadework runs ${span}: ${totals.runs} run${totals.runs === 1 ? '' : 's'}, ${totals.items} item${totals.items === 1 ? '' : 's'}`, ''];
  for (const run of runs) {
    out.push(`${when(run.started_at)}  ${run.mode.padEnd(11)} ${duration(run.duration_ms).padEnd(12)} ${run.repos.join(', ') || '(no repo)'}`);
    const results = Object.entries(run.results).map(([name, n]) => `${n} ${name}`).join(', ');
    out.push(`  ${run.items} item${run.items === 1 ? '' : 's'}${results ? `: ${results}` : ''}`);
    if (run.tokens) out.push(...tokenTable(run.tokens, '  '));
    else out.push('  tokens: the chat\'s transcript isn\'t there any more');
    out.push('');
  }
  if (runs.length > 1 && totals.runs > totals.runs_without_tokens) {
    out.push('All runs');
    out.push(...tokenTable(totals.tokens, '  '));
  }
  return out.join('\n').trimEnd();
}

module.exports = { collect, format };
