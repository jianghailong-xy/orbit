import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { deriveSessionRunState, deriveSessionState } from '@orbit/shared';

import {
  heldSessionWord, legacySessionStatus, sessionTurnState, statusWordFilter, turnStateOfWord, turnStateWhere,
} from './session-legacy-words';
import { factsOfWord, WORD_SHAPES } from './session-legacy-words.fixture';

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

test('a held row with no turn state keeps its stored word; one with a turn state, or released, does not read it', () => {
  for (const status of ['PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED']) {
    assert.equal(legacySessionStatus(factsOfWord(status, { turnState: null })), status);
  }
  assert.equal(legacySessionStatus(factsOfWord('RUNNING', { status: 'PENDING' })), 'RUNNING');
  assert.equal(legacySessionStatus(factsOfWord('CANCELLED', { status: 'RUNNING' })), 'CANCELLED');
});

test('a word the protocol does not have is no filter', () => {
  assert.equal(statusWordFilter('PARKED'), undefined);
  assert.equal(statusWordFilter('pending'), undefined);
});

// The turn state the runner-facing readers ask instead of the word (task T8): one for one with the held words, and the
// stored word's for a held row not yet backfilled, so each reader decides what it decided on the word.
const TURN_OF: Record<string, string | null> = { PENDING: 'QUEUED', RUNNING: 'IN_FLIGHT', INTERRUPTED: 'ABANDONED', AWAITING_INPUT: null };

test('a held row reads the turn state and held word of its stored word, backfilled or not', () => {
  for (const [status, turn] of Object.entries(TURN_OF)) {
    for (const turnState of [turn, null]) {
      const facts = factsOfWord(status, { turnState });
      assert.equal(sessionTurnState(facts), turn, `${status}, turn_state ${turnState}`);
      assert.equal(heldSessionWord(facts), status, `${status}, turn_state ${turnState}`);
      assert.equal(heldSessionWord(facts), legacySessionStatus(facts), `${status}: the projector's word`);
    }
    assert.equal(turnStateOfWord(status), turn, status);
  }
  // A stored turn state decides over the word, as the projector reads it.
  assert.equal(sessionTurnState(factsOfWord('RUNNING', { status: 'PENDING' })), 'IN_FLIGHT');
});

test('a released row has no turn state and no held word', () => {
  for (const shape of WORD_SHAPES.filter((shape) => shape.facts.finishedAt != null)) {
    assert.equal(sessionTurnState(shape.facts), null, shape.name);
    assert.equal(heldSessionWord(shape.facts), null, shape.name);
    assert.equal(turnStateOfWord(shape.stored), null, shape.name);
  }
});

test('turnStateWhere is held, and reads the stored word only where turn_state is null', () => {
  assert.deepEqual(turnStateWhere('QUEUED'), {
    finishedAt: null,
    OR: [{ turnState: { in: ['QUEUED'] } }, { turnState: null, status: { in: ['PENDING'] } }],
  });
  assert.deepEqual(turnStateWhere(null), {
    finishedAt: null,
    OR: [{ turnState: null, status: { notIn: ['PENDING', 'RUNNING', 'INTERRUPTED'] } }],
  });
  assert.deepEqual(turnStateWhere('IN_FLIGHT', 'ABANDONED', null), {
    finishedAt: null,
    OR: [{ turnState: { in: ['IN_FLIGHT', 'ABANDONED'] } }, { turnState: null, status: { notIn: ['PENDING'] } }],
  });
});
