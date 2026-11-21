'use strict';

// Dates in the user's own time zone, as people write them: log file names,
// Notes lines and /spadework:stats.

const pad = (number) => String(number).padStart(2, '0');

// 2026-10-14
const localDate = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

// 2026-10-14 09:30
const localDateTime = (date) => `${localDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;

module.exports = { localDate, localDateTime };
