'use strict';

// The links web search returned in a triage run. WebFetch may open only
// these: an address a search returned was indexed before the run, so it
// can't carry anything Claude read during the run (a connection string in
// "?ref=..."). One file per run, run/web/<session_id>.jsonl, one line per
// search; run/web/<session_id>.fetches counts the pages opened.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { readJsonLines } = require('./json-file');

// Pages one triage run may open, to keep the token cost down.
const MAX_FETCHES = 20;

const webDir = (home) => path.join(home || paths.home(), 'run', 'web');
const linksFile = (sessionId, home) => path.join(webDir(home), `${sessionId}.jsonl`);
const fetchesFile = (sessionId, home) => path.join(webDir(home), `${sessionId}.fetches`);

// The address without its #section, and without a trailing slash, so
// "https://x.dev/a/#b" and "https://x.dev/a" match. Null if it isn't a web address.
function normalize(url) {
  try {
    const parsed = new URL(String(url).trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    parsed.hash = '';
    if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString();
  } catch {
    return null;
  }
}

// Every web address in a tool result, wherever it sits in the JSON.
function linksIn(value, found = new Set()) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/https?:\/\/[^\s"'<>`\\\])}]+/gi)) {
      const url = normalize(match[0].replace(/[.,;:!?]+$/, ''));
      if (url) found.add(url);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) linksIn(item, found);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) linksIn(item, found);
  }
  return found;
}

// Saves the links one search returned. Appending keeps parallel searches
// from overwriting each other.
function recordSearch(sessionId, toolResponse, { home } = {}) {
  const links = [...linksIn(toolResponse)];
  if (!links.length) return 0;
  fs.mkdirSync(webDir(home), { recursive: true });
  fs.appendFileSync(linksFile(sessionId, home), JSON.stringify(links) + '\n');
  return links.length;
}

// Every link this run's searches returned.
function searchLinks(sessionId, { home } = {}) {
  const searches = readJsonLines(linksFile(sessionId, home)) || [];
  return new Set(searches.filter(Array.isArray).flat());
}

// Pages opened so far: one character per page in the .fetches file.
function fetchCount(sessionId, { home } = {}) {
  try {
    return fs.readFileSync(fetchesFile(sessionId, home), 'utf8').length;
  } catch {
    return 0;
  }
}

function countFetch(sessionId, { home } = {}) {
  fs.mkdirSync(webDir(home), { recursive: true });
  fs.appendFileSync(fetchesFile(sessionId, home), '.');
}

function clear(sessionId, { home } = {}) {
  fs.rmSync(linksFile(sessionId, home), { force: true });
  fs.rmSync(fetchesFile(sessionId, home), { force: true });
}

module.exports = { MAX_FETCHES, normalize, recordSearch, searchLinks, fetchCount, countFetch, clear };
