'use strict';

// A row's questions have IDs (Q1, Q2…) that never change. A row's plan holds
// its open questions as { id, text }; its answers are { id, question, answer }.
// On a re-plan the planner says, per ID, whether the question is answered,
// still open or dropped, and writes only its new questions: an open question
// keeps its text word for word, and a dropped one is removed with its answer.
// Rows from before IDs hold plain texts: they are numbered in order when read.

const ID = /^Q[1-9]\d{0,3}$/;
const STATUSES = ['answered', 'open', 'dropped'];

const textOf = (value) => String(value ?? '').trim();
const isId = (value) => ID.test(String(value ?? ''));
const numberOf = (id) => Number(String(id).slice(1));

// The row's open questions and its answers, all with IDs, and the next ID's number.
function ofRow(row) {
  const value = row || {};
  const isEntry = (entry) => entry !== null && typeof entry === 'object';
  const listed = (value.plan && Array.isArray(value.plan.questions) ? value.plan.questions : [])
    .map((entry) => (isEntry(entry) ? { id: entry.id, text: textOf(entry.text) } : { id: null, text: textOf(entry) }))
    .filter((entry) => entry.text);
  const given = (value.answers || []).filter(isEntry);
  // A plain text never takes an ID already given.
  const ids = [...listed, ...given].map((entry) => entry.id).filter(isId);
  let next = Math.max(Number.isSafeInteger(value.next_question) ? value.next_question : 1, 1, ...ids.map((id) => numberOf(id) + 1));
  const fresh = () => `Q${next++}`;
  const questions = listed.map((entry) => ({ id: isId(entry.id) ? entry.id : fresh(), text: entry.text }));
  const answers = given.map((entry) => {
    const question = textOf(entry.question);
    const same = questions.find((asked) => asked.text === question);
    return { id: isId(entry.id) ? entry.id : same ? same.id : fresh(), question, answer: String(entry.answer ?? '') };
  });
  return { questions, answers, next };
}

// The questions answered so far, by ID.
const answerOf = (answers, id) => answers.find((entry) => entry.id === id && textOf(entry.answer));

// The planner's statuses: { "Q1": "answered" }, with unknown IDs and values left out.
function statusesFrom(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [id, status] of Object.entries(value)) {
    const name = textOf(status).toLowerCase();
    if (isId(id.trim().toUpperCase()) && STATUSES.includes(name)) out[id.trim().toUpperCase()] = name;
  }
  return out;
}

// The row's questions after a plan: { questions, answers, next_question }.
// statuses: what the planner said per earlier ID. A question it said nothing
// about is answered when it has an answer, and `unsaid` when it hasn't.
// asked: the new questions' texts. A new question with the text of an
// earlier one is that question again, with its ID.
function merge(row, { statuses = {}, asked = [], unsaid = 'open' } = {}) {
  const earlier = ofRow(row);
  let { next } = earlier;
  const statusOf = (id) => statuses[id] || (answerOf(earlier.answers, id) ? 'answered' : unsaid);
  const dropped = new Set(earlier.questions.map((entry) => entry.id).filter((id) => statusOf(id) === 'dropped'));
  for (const [id, status] of Object.entries(statuses)) if (status === 'dropped') dropped.add(id);
  const questions = earlier.questions.filter((entry) => statusOf(entry.id) === 'open');
  for (const raw of asked) {
    const text = textOf(raw);
    if (!text || questions.some((entry) => entry.text === text)) continue;
    const again = [...earlier.questions, ...earlier.answers.map((entry) => ({ id: entry.id, text: entry.question }))].find((entry) => entry.text === text);
    if (again) {
      dropped.delete(again.id);
      questions.push({ id: again.id, text });
    } else {
      questions.push({ id: `Q${next}`, text });
      next += 1;
    }
  }
  const answers = earlier.answers.filter((entry) => !dropped.has(entry.id));
  return { questions, answers, next_question: next };
}

// The earlier questions as the brief lists them: each with its ID and its answer, if any.
function briefLines(row) {
  const { questions, answers } = ofRow(row);
  const lines = [];
  for (const entry of questions) {
    const answered = answerOf(answers, entry.id);
    lines.push(`- ${entry.id}: ${entry.text}`, answered ? `  Answer: ${answered.answer.trim()}` : '  No answer yet.');
  }
  for (const entry of answers.filter((one) => textOf(one.answer) && !questions.some((asked) => asked.id === one.id))) {
    lines.push(`- ${entry.id}: ${entry.question}`, `  Answer: ${entry.answer.trim()}`);
  }
  return lines;
}

module.exports = { ofRow, merge, statusesFrom, briefLines, isId, STATUSES };
