import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TURN_REASON_ORDER,
  TurnReasonCode,
  TurnReasonFacts,
  chooseTurnReason,
  openCoordinatorTurnIdempotencyKey,
  turnReasonDigest,
} from './project-turn-reason';

/**
 * §7.2 TU4 / TU5 and §7.6 TR1, as a pure unit.
 *
 * The reason this is exhaustive rather than exemplary is `PC-CX-23`'s finding: the reasons really
 * do hold at the same time, and a hand-written mutual exclusion is only ever correct for the
 * combinations somebody thought of. Six predicates is 64 combinations, which is small enough to
 * simply enumerate — so the order is checked on all of them, not on the interesting ones.
 */

/** Every subset of the six reasons, each with a distinguishable fact projection. */
function combinations(): TurnReasonFacts[] {
  const out: TurnReasonFacts[] = [];
  for (let mask = 0; mask < 1 << TURN_REASON_ORDER.length; mask += 1) {
    const facts: TurnReasonFacts = {};
    TURN_REASON_ORDER.forEach((code, bit) => {
      if (mask & (1 << bit)) facts[code] = [`fact-of-${code}`];
    });
    out.push(facts);
  }
  return out;
}

test('§7.2 TU4: the six turn reasons are one frozen total order', () => {
  assert.deepEqual([...TURN_REASON_ORDER], [
    'MANUAL', 'VERDICT', 'TASK_FAILURE', 'BLOCKER_DECISION', 'ACCEPTANCE', 'REPLAN',
  ]);
  assert.equal(new Set(TURN_REASON_ORDER).size, TURN_REASON_ORDER.length, 'a code appears twice');
});

test('§7.2 TU4 / TU5: every one of the 64 fact combinations selects exactly one reason', () => {
  for (const facts of combinations()) {
    const chosen = chooseTurnReason(facts);
    const trueCodes = TURN_REASON_ORDER.filter((code) => code in facts);
    if (trueCodes.length === 0) {
      assert.equal(chosen, null, 'a snapshot with no true reason opened a turn');
      continue;
    }
    assert.ok(chosen);
    // I15: one reason, and it is the first true one in the frozen order.
    assert.equal(chosen.reasonCode, trueCodes[0]);
    // TU5: the rest are recorded, not dropped — and in the same order, so the audit row for one
    // snapshot is byte-identical however the caller built the record.
    assert.deepEqual(chosen.suppressed, trueCodes.slice(1));
    assert.deepEqual(chosen.turnFacts, facts[trueCodes[0]]);
  }
});

test('§7.2 TU4: the selection does not depend on the order the facts were inserted in', () => {
  for (const facts of combinations()) {
    const reversed = Object.fromEntries(Object.entries(facts).reverse()) as TurnReasonFacts;
    assert.deepEqual(chooseTurnReason(reversed), chooseTurnReason(facts));
  }
});

test('§7.2 TU4: TASK_FAILURE outranks the blocker its own failure would open', () => {
  // Cause before consequence, the same cell that puts VERDICT above VERIFICATION_FAILED. Choosing
  // the consequence would throw away `(taskId, dispatchAttempt)`, which is the fact the coordinator
  // is being woken FOR.
  const both = chooseTurnReason({ TASK_FAILURE: ['t#1'], BLOCKER_DECISION: ['MERGE_CONFLICT:b#1:v'] });
  assert.equal(both?.reasonCode, 'TASK_FAILURE');
  assert.deepEqual(both?.suppressed, ['BLOCKER_DECISION']);

  // And a person still outranks it, as does the conclusion of a check that ran.
  assert.equal(chooseTurnReason({ MANUAL: ['m'], TASK_FAILURE: ['t#1'] })?.reasonCode, 'MANUAL');
  assert.equal(chooseTurnReason({ VERDICT: ['v#1'], TASK_FAILURE: ['t#1'] })?.reasonCode, 'VERDICT');
});

test('§7.6 TR1: the digest is a function of the facts, and of nothing else', () => {
  const facts = ['task-a#3', 'task-b#1'];
  const first = turnReasonDigest('TASK_FAILURE', facts);

  // Repeated delivery of the same world: byte-identical.
  assert.equal(turnReasonDigest('TASK_FAILURE', ['task-a#3', 'task-b#1']), first);
  // A different reason on the same facts is a different digest — the code is inside the hash.
  assert.notEqual(turnReasonDigest('BLOCKER_DECISION', facts), first);
  // A new episode of the same task is a new digest (GE2's A → B → A test, in one line).
  assert.notEqual(turnReasonDigest('TASK_FAILURE', ['task-a#4', 'task-b#1']), first);
});

test('§8.2: one turn key is the generation and the digest, and nothing else', () => {
  const uuid = '00000000-0000-7000-8000-0000000000aa';
  const digest = turnReasonDigest('TASK_FAILURE', ['t#1']);
  assert.equal(
    openCoordinatorTurnIdempotencyKey(uuid, '4', digest),
    `pc:v1:${uuid}:turn:4:${digest}`,
  );
  // GE1: the epoch moves with the coordination run, so a new run never reuses a settled key.
  assert.notEqual(
    openCoordinatorTurnIdempotencyKey(uuid, '5', digest),
    openCoordinatorTurnIdempotencyKey(uuid, '4', digest),
  );
});

test('§7.2 TU5: a suppressed reason is still true on the next pass and wins once the winner is gone', () => {
  const before: TurnReasonFacts = { VERDICT: ['v#1'], TASK_FAILURE: ['t#1'] };
  assert.equal(chooseTurnReason(before)?.reasonCode, 'VERDICT');
  const { VERDICT: _settled, ...after } = before as Record<TurnReasonCode, unknown>;
  assert.equal(chooseTurnReason(after as TurnReasonFacts)?.reasonCode, 'TASK_FAILURE');
});
