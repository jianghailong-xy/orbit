import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { deriveSessionRunState, deriveSessionState } from '@orbit/shared';

import { legacySessionStatus, statusWordFilter } from './session-legacy-words';
import { WORD_SHAPES } from './session-legacy-words.fixture';

/**
 * The projector of the legacy status words (docs/session-status-retirement-plan.md §3.1, task T4), over every row
 * shape. session-legacy-words.golden.json holds, per shape, the word its writer stored and what is derived: the word
 * and the `runState` and `sessionState` of an unfiled row. A shape whose word differs from the stored one names the
 * kind of the plan's §3.4 it is (C1-C7); any other difference is a changed wire value and a failure here.
 */

const GOLDEN = path.resolve(__dirname, '../../../../src/apiserver/src/sessions/session-legacy-words.golden.json');
const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as {
  rows: Array<{ shape: string; stored: string; word: string; runState: string; sessionState: string; kind?: string }>;
};

test('every row shape derives the golden words, and differs from the stored word only as a §3.4 kind', () => {
  const rows = WORD_SHAPES.map(({ name, stored, facts, landing }) => {
    const word = legacySessionStatus(facts, landing);
    const source = { status: word, endReason: facts.endReason };
    return { shape: name, stored, word, runState: deriveSessionRunState(source), sessionState: deriveSessionState(source) };
  });
  assert.deepEqual(rows, golden.rows.map(({ kind: _kind, stored, word, runState, sessionState, shape }) =>
    ({ shape, stored, word, runState, sessionState })));
  const unexplained = golden.rows.filter((row) => (row.stored === row.word) !== (row.kind === undefined));
  assert.deepEqual(unexplained, []);
  assert.deepEqual([...new Set(golden.rows.flatMap((row) => row.kind ?? []))].sort(),
    ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7']);
});

test('a word the protocol does not have is no filter', () => {
  assert.equal(statusWordFilter('PARKED'), undefined);
  assert.equal(statusWordFilter('pending'), undefined);
});
