import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_PROMPT_CHARS, uuidToBase62 } from '@orbit/shared';
import { buildCoordinatorTurnMessage } from './coordinator-opening';
import {
  coordinatorTurnGeneration,
  openCoordinatorTurnClientTurnId,
  openCoordinatorTurnIdempotencyKey,
} from './project-turn-reason';

/** Unit 27's pure half: the identity a delivered turn is filed under, and what it says. */

const PROJECT = '00000000-0000-7000-8000-0000000027a1';
const DIGEST = 'a'.repeat(64);

test('the turn key is the client turn id, so one string joins the ledger to the transcript', () => {
  const key = openCoordinatorTurnIdempotencyKey(PROJECT, 0n, DIGEST);
  assert.equal(openCoordinatorTurnClientTurnId(key), key);
  assert.equal(key, `pc:v1:${PROJECT}:turn:0:${DIGEST}`);
});

test('the generation is readable back out of either spelling of the key', () => {
  assert.equal(coordinatorTurnGeneration(
    openCoordinatorTurnIdempotencyKey(PROJECT, 7n, DIGEST)), '7');
  assert.equal(coordinatorTurnGeneration(
    openCoordinatorTurnIdempotencyKey(uuidToBase62(PROJECT), 7n, DIGEST)), '7');
});

test('a key that is not a turn key yields no generation, so it cannot claim one by default', () => {
  // The executor refuses `COORDINATOR_GENERATION_MOVED` on null rather than defaulting to 0 — a
  // default would let a malformed key be claimed under the epoch of a run it has nothing to do
  // with, which §8.2 GE1 exists to prevent.
  assert.equal(coordinatorTurnGeneration(`pc:v1:${PROJECT}:rotate:1`), null);
  assert.equal(coordinatorTurnGeneration(`pc:v1:${PROJECT}:dispatch:t:1`), null);
  assert.equal(coordinatorTurnGeneration(''), null);
});

test('the message carries the whole chain a reader needs: reason, digest, decision, action', () => {
  const message = buildCoordinatorTurnMessage({
    reasonCode: 'TASK_FAILURE',
    reasonDigest: DIGEST,
    turnFacts: ['5YYbCn2fA0WIIVF3gKZa5D#0'],
    suppressed: ['BLOCKER_DECISION'],
    decisionId: 'dEcIsIoN',
    actionId: 'aCtIoN',
  });
  assert.ok(message.includes('TASK_FAILURE'));
  assert.ok(message.includes(DIGEST));
  assert.ok(message.includes('dEcIsIoN'));
  assert.ok(message.includes('aCtIoN'));
  assert.ok(message.includes('5YYbCn2fA0WIIVF3gKZa5D#0'));
  // TU5: a reason that lost the total order is recorded rather than dropped, here too.
  assert.ok(message.includes('BLOCKER_DECISION'));
});

test('a turn opened on a very large world still fits what a session will accept', () => {
  // `SessionsService.createTurn` rejects anything past `MAX_PROMPT_CHARS`, and §7.6 writes its turn
  // straight into `conversation_turn` — so a project with a thousand failed tasks must not produce
  // a message the composer would have refused. The facts are capped; the action row keeps them all.
  const facts = Array.from({ length: 5_000 }, (_, i) => `task-${i}#${i}`);
  const message = buildCoordinatorTurnMessage({
    reasonCode: 'TASK_FAILURE',
    reasonDigest: DIGEST,
    turnFacts: facts,
    suppressed: [],
    decisionId: 'd',
    actionId: 'a',
  });
  assert.ok(message.length < MAX_PROMPT_CHARS, `${message.length} characters`);
  assert.ok(message.includes('（已截断）'));
  assert.ok(message.includes(DIGEST), 'the digest survives the cap; it is what TR1 is about');
});

test('an unknown reasonCode degrades to its own name rather than to silence', () => {
  const message = buildCoordinatorTurnMessage({
    reasonCode: 'SOMETHING_LATER',
    reasonDigest: DIGEST,
    turnFacts: null,
    suppressed: [],
    decisionId: 'd',
    actionId: 'a',
  });
  assert.ok(message.includes('SOMETHING_LATER'));
});
