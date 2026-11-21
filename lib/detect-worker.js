'use strict';

// Runs one of init's detections in a worker thread, so the board's helper
// (lib/board-server.js) keeps answering other requests. The detections run
// git or walk the repo synchronously, and asking the server for the main
// branch can take up to a minute. They are the same functions the CLI uses,
// with the same timeouts.

const { parentPort, workerData } = require('worker_threads');

const init = require('./init');
const stack = require('./stack');

const JOBS = {
  'detect-repo': ({ path, expected }) => init.detectRepo(path, expected),
  'detect-stack': ({ path }) => stack.detect(path),
};

try {
  parentPort.postMessage({ ok: true, value: JOBS[workerData.job](workerData.args) });
} catch (err) {
  parentPort.postMessage({ ok: false, error: String((err && err.stack) || err) });
}
