import assert from 'node:assert/strict';
import test from 'node:test';
import { questionAnswers, questionApprovalId } from './run-question';
import { assertClientTurnIdNotReserved } from './watch-turn-key';
import { confirmationReviewRetryTurnId, isConfirmationReviewContentTurn } from '../tasks/owner-confirmation-review-turn';
import { isOrbitAuthoredTurn } from './orbit-authored-turn';

const input = { questions: [
  { question: 'Port?', options: [{ label: '3000' }, { label: '4000' }] },
  { question: 'Platforms?', multiSelect: true, options: [{ label: 'web' }, { label: 'iOS' }, { label: 'Android' }] },
  { question: 'Reason?' },
] };

test('coordinator answers preserve engine labels, multi-select arrays and free text', () => {
  assert.deepEqual(questionAnswers(input, { answers: [
    { question: 2, text: 'Use the configured endpoint' }, { question: 0, option: 1 }, { question: 1, options: [0, 2] },
  ] }).answers, { 'Reason?': ['Use the configured endpoint'], 'Port?': ['4000'], 'Platforms?': ['web', 'Android'] });
  assert.deepEqual(questionAnswers({ questions: [input.questions[0]] }, { option: 0 }).answers, { 'Port?': ['3000'] });
  assert.deepEqual(questionAnswers({ questions: [input.questions[0]] }, { message: '5000' }).answers, { 'Port?': ['5000'] });
});

test('incomplete, duplicate, out-of-range and ambiguous answers cannot unblock a run', () => {
  for (const answers of [
    [], [{ question: 0, option: 0 }],
    [{ question: 0, option: 3 }, { question: 1, options: [0] }, { question: 2, text: 'why' }],
    [{ question: 0, option: 0 }, { question: 0, text: 'duplicate' }, { question: 2, text: 'why' }],
    [{ question: 0, option: 0, text: 'both' }, { question: 1, options: [0] }, { question: 2, text: 'why' }],
    [{ question: 0, options: [0, 1] }, { question: 1, options: [0] }, { question: 2, text: 'why' }],
    [{ question: 0, option: 0 }, { question: 1, options: [0, 0] }, { question: 2, text: 'why' }],
  ]) assert.throws(() => questionAnswers(input, { answers }), /answer each question/);
});

test('run question keys are reserved platform content and retry as themselves', () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  const key = `run-question:v1:${id}`;
  assert.equal(questionApprovalId(key), id);
  assert.equal(isConfirmationReviewContentTurn(key), true);
  assert.equal(isOrbitAuthoredTurn(key), true);
  assert.equal(confirmationReviewRetryTurnId(key, 'nonce'), `${key}:retry:nonce`);
  assert.throws(() => assertClientTurnIdNotReserved(key), /reserved/);
});
