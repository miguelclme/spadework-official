'use strict';

// Writes a file so readers never see half of it: the text goes to a temp
// file first, then a rename swaps it in. On Windows the rename fails while
// another process (a hook, an antivirus) has the file open, so it's retried
// for about a second. If it still fails, the temp file is removed and the
// error is thrown: the old file is left as it was.

const fs = require('fs');
const path = require('path');

const RETRY_CODES = ['EPERM', 'EBUSY', 'EACCES'];
const MAX_RETRIES = 10;

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function writeFileAtomic(file, text, { rename = fs.renameSync } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, text);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      rename(temp, file);
      return;
    } catch (err) {
      if (!RETRY_CODES.includes(err.code) || attempt >= MAX_RETRIES) {
        fs.rmSync(temp, { force: true });
        throw err;
      }
      pause(25 * (attempt + 1));
    }
  }
}

const writeJsonAtomic = (file, data, options) => writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n', options);

module.exports = { writeFileAtomic, writeJsonAtomic, MAX_RETRIES, pause };
