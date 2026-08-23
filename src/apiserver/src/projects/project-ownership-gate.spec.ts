/**
 * Unit L6, the rules: what the run-time ownership gate refuses, and — more of these — what it does
 * not.
 *
 * The failure mode a gate like this has is not being too weak. It is being too strong: every task
 * an agent ever filed carries the new column, so a rule that is one clause too wide stops the
 * product rather than the incident. Most of what is asserted here is therefore a run that must
 * still happen.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PROJECT_BLOCKER_POLICY,
  planProjectBlockers,
  projectBlockerDedupeKey,
} from './project-blocker';
import {
  decideTaskOwnership,
  ownershipMismatchCondition,
  ownershipMismatchConditionVersion,
  ownershipMismatchDedupeKey,
  ownershipMismatchMessage,
  OWNERSHIP_MISMATCH_BLOCKER,
} from './project-ownership-gate';

const A = 'project-a';
const B = 'project-b';

const facts = (over: Partial<Parameters<typeof decideTaskOwnership>[0]> = {}) => ({
  taskId: 'task-1',
  projectId: B,
  creatorCoordinatorProjectId: A,
  creatorCoordinatorGeneration: '3',
  approvedCrossing: false,
  ...over,
});

test('L6 §gate: the incident — A\'s coordinator filed into B, and nobody said yes', () => {
  const answer = decideTaskOwnership(facts());
  assert.equal(answer.verdict, 'MISMATCH');
  assert.equal(answer.refuses, true);
  // Both ends are on the answer, so every caller reports the same two projects without going back
  // to the row for them.
  assert.equal(answer.fromProjectId, A);
  assert.equal(answer.toProjectId, B);
  assert.match(ownershipMismatchMessage(answer), /project-a/);
  assert.match(ownershipMismatchMessage(answer), /project-b/);
});

test('L6 §gate: the ordinary case — filed under the scope that owns it', () => {
  const answer = decideTaskOwnership(facts({ creatorCoordinatorProjectId: B }));
  assert.equal(answer.verdict, 'OWNED');
  assert.equal(answer.refuses, false);
});

test('L6 §gate: an unrecorded scope is not a claim, and must not refuse', () => {
  // Every user-filed task, every task written outside a session, and every pre-0156 row the
  // backfill could not attribute unambiguously. This is the clause that decides whether the unit
  // ships or takes the product down with it.
  const answer = decideTaskOwnership(facts({ creatorCoordinatorProjectId: null }));
  assert.equal(answer.verdict, 'UNATTRIBUTED');
  assert.equal(answer.refuses, false);
});

test('L6 §gate: a task under no project is not counting towards the wrong goal', () => {
  const answer = decideTaskOwnership(facts({ projectId: null }));
  assert.equal(answer.verdict, 'UNATTRIBUTED');
  assert.equal(answer.refuses, false);
});

test('L6 §gate: an APPLIED handoff is what makes a crossing lawful, at run time too', () => {
  const answer = decideTaskOwnership(facts({ approvedCrossing: true }));
  assert.equal(answer.verdict, 'CROSSING_APPROVED');
  assert.equal(answer.refuses, false);
  // And the two ends are still reported: an approved crossing is a fact worth showing, not an
  // absence of one.
  assert.equal(answer.fromProjectId, A);
  assert.equal(answer.toProjectId, B);
});

test('L6 §gate: a rotation moves no work, so the generation alone never refuses', () => {
  for (const generation of ['0', '1', '999', null]) {
    const answer = decideTaskOwnership(
      facts({ creatorCoordinatorProjectId: B, creatorCoordinatorGeneration: generation }),
    );
    assert.equal(answer.refuses, false, `generation ${generation} must not refuse on its own`);
    assert.equal(answer.creatorCoordinatorGeneration, generation);
  }
});

test('L6 §blocker: the row answers BL0 — responsible, required action, source, target', () => {
  const condition = ownershipMismatchCondition({
    taskPublicId: 'task-1',
    taskTitle: 'unrelated work',
    fromProjectPublicId: A,
    toProjectPublicId: B,
    generation: '3',
  });
  assert.equal(condition.kind, OWNERSHIP_MISMATCH_BLOCKER);
  assert.equal(condition.subjectType, 'TASK');
  assert.equal(condition.subjectId, 'task-1');
  assert.equal(condition.detail.fromProjectId, A);
  assert.equal(condition.detail.toProjectId, B);
  assert.equal(condition.detail.creatorCoordinatorGeneration, '3');
  assert.equal(condition.detail.owner, 'USER');
  assert.equal(
    condition.detail.requiredAction,
    PROJECT_BLOCKER_POLICY[OWNERSHIP_MISMATCH_BLOCKER].requiredAction,
  );
});

test('L6 §blocker: the kind is a USER/HUMAN row that does not wake the coordinator', () => {
  const policy = PROJECT_BLOCKER_POLICY[OWNERSHIP_MISMATCH_BLOCKER];
  // Which project owns a piece of work is not a question the loop is allowed to answer, so the row
  // must not open a turn — BL4 also ties `opensTurn` to a COORDINATOR default owner in both
  // directions, and this is the USER side of it.
  assert.equal(policy.owner, 'USER');
  assert.equal(policy.recovery, 'HUMAN');
  assert.equal(policy.opensTurn, false);
  assert.equal(policy.severity, 'CRITICAL');
  // `recovery = HUMAN` has no recovery poll: BL5 makes its clock an escalation alarm.
  assert.equal(policy.pollMs, null);
});

test('L6 §blocker: one row per task, and a repeat observation is a touch with a next check', () => {
  const epoch = Math.floor(Date.UTC(2026, 7, 23, 12) / 1000);
  const condition = ownershipMismatchCondition({
    taskPublicId: 'task-1',
    taskTitle: 'unrelated work',
    fromProjectPublicId: A,
    toProjectPublicId: B,
    generation: '3',
  });
  const dedupeKey = ownershipMismatchDedupeKey('task-1');
  assert.equal(
    dedupeKey, projectBlockerDedupeKey(OWNERSHIP_MISMATCH_BLOCKER, 'TASK', 'task-1'),
  );

  const first = planProjectBlockers({ epoch, open: [], observed: [condition] });
  assert.equal(first.raises.length, 1);
  const raise = first.raises[0];
  assert.equal(raise.dedupeKey, dedupeKey);
  assert.equal(raise.owner, 'USER');
  assert.equal(
    raise.requiredAction, PROJECT_BLOCKER_POLICY[OWNERSHIP_MISMATCH_BLOCKER].requiredAction,
  );
  // BL5: a HUMAN row's `next_check_at` is its escalation instant, and it is always present.
  assert.equal(
    raise.nextCheckAt,
    new Date(epoch * 1000 + PROJECT_BLOCKER_POLICY[OWNERSHIP_MISMATCH_BLOCKER].escalateMs)
      .toISOString(),
  );

  // Seeing it again is one row seen twice, not two rows.
  const second = planProjectBlockers({
    epoch: epoch + 60,
    open: [{
      id: 'blocker-1',
      kind: OWNERSHIP_MISMATCH_BLOCKER,
      owner: 'USER',
      recovery: 'HUMAN',
      severity: 'CRITICAL',
      requiredAction: PROJECT_BLOCKER_POLICY[OWNERSHIP_MISMATCH_BLOCKER].requiredAction,
      subjectType: 'TASK',
      subjectId: 'task-1',
      dedupeKey,
      lifecycleGeneration: '0',
      conditionVersion: raise.conditionVersion,
      firstSeenAt: raise.firstSeenAt,
      lastSeenAt: raise.firstSeenAt,
      occurrences: 1,
      nextCheckAt: raise.nextCheckAt,
      escalatedAt: null,
    }],
    observed: [condition],
  });
  assert.equal(second.raises.length, 0);
  assert.equal(second.touches.length, 1);
  assert.equal(second.touches[0].blockerId, 'blocker-1');
});

test('L6 §blocker: the condition version carries the PAIR, so a refile is a changed condition', () => {
  const version = (from: string, to: string) =>
    ownershipMismatchConditionVersion('task-1', { from, to, generation: '3' });
  assert.notEqual(version(A, B), version(A, 'project-c'));
  assert.equal(version(A, B), version(A, B));
});

test('L6 §blocker: the condition disappearing is what clears the row (BL3)', () => {
  const epoch = Math.floor(Date.UTC(2026, 7, 23, 12) / 1000);
  const dedupeKey = ownershipMismatchDedupeKey('task-1');
  const plan = planProjectBlockers({
    epoch,
    open: [{
      id: 'blocker-1',
      kind: OWNERSHIP_MISMATCH_BLOCKER,
      owner: 'USER',
      recovery: 'HUMAN',
      severity: 'CRITICAL',
      requiredAction: PROJECT_BLOCKER_POLICY[OWNERSHIP_MISMATCH_BLOCKER].requiredAction,
      subjectType: 'TASK',
      subjectId: 'task-1',
      dedupeKey,
      lifecycleGeneration: '0',
      conditionVersion: 'whatever',
      firstSeenAt: new Date(epoch * 1000).toISOString(),
      lastSeenAt: new Date(epoch * 1000).toISOString(),
      occurrences: 1,
      nextCheckAt: new Date(epoch * 1000).toISOString(),
      escalatedAt: null,
    }],
    // The repair landed: the original is CANCELLED/ABANDONED, so the detector no longer observes it.
    observed: [],
  });
  assert.equal(plan.clears.length, 1);
  assert.equal(plan.clears[0].dedupeKey, dedupeKey);
});
