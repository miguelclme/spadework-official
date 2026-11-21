'use strict';

// Whole numbers that come from JSON or the command line, as 7 or "7".

// The number, or null when the value isn't a whole number of at least min
// (missing, empty, "abc", "5s", 2.5, true).
function wholeNumber(value, { min = 0 } = {}) {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^-?\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number >= min ? number : null;
}

// A work item ID: a whole number from 1.
const workItemId = (value) => wholeNumber(value, { min: 1 });

module.exports = { wholeNumber, workItemId };
