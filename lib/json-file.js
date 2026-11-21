'use strict';

// Reading JSON files: single files, JSON-lines files (logs, transcripts)
// and folders of .json files (run files).
// Some Windows editors add an invisible mark (a BOM, U+FEFF) to a file saved
// by hand, and JSON.parse refuses it, so it's removed first. parseJson and
// readJsonFile throw on bad JSON.

const fs = require('fs');
const path = require('path');

const BOM = /^\uFEFF/;

const parseJson = (text) => JSON.parse(String(text).replace(BOM, ''));
// JSON from a model: a lone backslash (Shop\Api) is not valid JSON, and the
// model forgets. Text that doesn't parse is tried again with every
// backslash that starts no valid escape doubled.
function parseLooseJson(text) {
  try {
    return parseJson(text);
  } catch (err) {
    // Escapes are read in pairs, left to right, so a valid \\ is not touched.
    const fixed = String(text).replace(/\\([\s\S]?)/g, (all, next) => (next && '"\\/bfnrtu'.includes(next) ? all : `\\\\${next}`));
    if (fixed === String(text)) throw err;
    return parseJson(fixed);
  }
}

const readJsonFile = (file) => parseJson(fs.readFileSync(file, 'utf8'));

// The same, but null instead of an error: for text or files that may be
// missing, half written or removed meanwhile.
function parseJsonOrNull(text) {
  try {
    return parseJson(text);
  } catch {
    return null;
  }
}

// A text file's content, or null when it can't be read.
function readTextOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJsonOrNull(file) {
  try {
    return readJsonFile(file);
  } catch {
    return null;
  }
}

// A JSON-lines file (one JSON value per line): its values, or null when the
// file can't be read. Blank and half-written lines are skipped.
function readJsonLines(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const values = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const value = parseJsonOrNull(line);
    if (value !== null) values.push(value);
  }
  return values;
}

// The .json files in a folder, as full paths. A missing folder has none.
function listJsonFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

module.exports = { parseJson, parseLooseJson, readJsonFile, parseJsonOrNull, readJsonOrNull, readTextOrNull, readJsonLines, listJsonFiles, BOM };
