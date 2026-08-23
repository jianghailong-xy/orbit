/**
 * Unit L6, the repair's rules: what may be refiled automatically, and what may only be frozen.
 *
 * The three refusals are the point of the module. A repair that quietly abandoned a task somebody
 * had already run would be rewriting a real outcome to make an audit come out clean, which is worse
 * than the mis-filing it is repairing.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decideTaskOwnership } from './project-ownership-gate';
import { planOwnershipRefile, type RefileFacts } from './project-ownership-refile';

const A = 'project-a';
const B = 'project-b';

const misfiled = decideTaskOwnership({
  taskId: 'task-1',
  projectId: B,
  creatorCoordinatorProjectId: A,
  creatorCoordinatorGeneration: '3',
  approvedCrossing: false,
});

const facts = (over: Partial<RefileFacts> = {}): RefileFacts => ({
  ownership: misfiled,
  taskStatus: 'OPEN',
  liveSessionCount: 0,
  sessionCount: 0,
  targetProjectStatus: 'OPEN',
  existingReplacementTaskId: null,
  ...over,
});

test('L6 §refile: a mis-filed task that never started is repaired into the filing scope', () => {
  const plan = planOwnershipRefile(facts());
  assert.equal(plan.action, 'REFILE');
  assert.equal(plan.action === 'REFILE' && plan.replacementProjectId, A);
  assert.equal(plan.action === 'REFILE' && plan.abandonedProjectId, B);
});

test('L6 §refile: the target is the scope that filed it, never a project the caller names', () => {
  // There is no caller-supplied target in `RefileFacts` at all, and that is the assertion: the
  // shape of the input is what makes "decide for yourself which goal your work counts towards"
  // unrepresentable rather than merely refused.
  assert.equal('targetProjectId' in facts(), false);
});

test('L6 §refile: a live run freezes the repair instead of ending somebody\'s session', () => {
  for (const over of [{ liveSessionCount: 1 }, { taskStatus: 'IN_PROGRESS' }]) {
    const plan = planOwnershipRefile(facts(over));
    assert.equal(plan.action, 'REFUSE');
    assert.equal(plan.action === 'REFUSE' && plan.reason, 'TASK_RUNNING');
  }
});

test('L6 §refile: work that already ran keeps its real result — abandoning it would be a lie', () => {
  // A finished session, and separately a task that reached an end of its own. Both mean the same
  // thing to the repair: something happened here, and recording "dropped on purpose" over it would
  // rewrite an outcome somebody read.
  for (const over of [
    { sessionCount: 1 },
    { taskStatus: 'FAILED' },
    { taskStatus: 'DONE' },
    { taskStatus: 'CANCELLED' },
  ]) {
    const plan = planOwnershipRefile(facts(over));
    assert.equal(plan.action, 'REFUSE');
    assert.equal(plan.action === 'REFUSE' && plan.reason, 'TASK_HAS_RUN_RESULT');
  }
});

test('L6 §refile: a live run is reported as running even when it also has finished ones', () => {
  const plan = planOwnershipRefile(facts({ liveSessionCount: 1, sessionCount: 4 }));
  assert.equal(plan.action === 'REFUSE' && plan.reason, 'TASK_RUNNING');
});

test('L6 §refile: a settled owning project takes no new work until it is reopened', () => {
  for (const status of ['DONE', 'CANCELLED'] as const) {
    const plan = planOwnershipRefile(facts({ targetProjectStatus: status }));
    assert.equal(plan.action === 'REFUSE' && plan.reason, 'TARGET_NOT_OPEN');
  }
  const gone = planOwnershipRefile(facts({ targetProjectStatus: null }));
  assert.equal(gone.action === 'REFUSE' && gone.reason, 'TARGET_NOT_OPEN');
});

test('L6 §refile: a task the gate does not refuse has nothing to repair', () => {
  const owned = decideTaskOwnership({
    taskId: 'task-1',
    projectId: B,
    creatorCoordinatorProjectId: B,
    creatorCoordinatorGeneration: '3',
    approvedCrossing: false,
  });
  const plan = planOwnershipRefile(facts({ ownership: owned }));
  assert.equal(plan.action === 'REFUSE' && plan.reason, 'NOT_MISFILED');
});

test('L6 §refile: a second call answers with the first call\'s replacement, not a second one', () => {
  // AC4, and the reason this rule is FIRST: the successful repair abandons the original, which
  // takes it out of the gate's scope — so a rule order that asked the gate first would answer the
  // second call `NOT_MISFILED`, which reads as "you were wrong" rather than "already done".
  const plan = planOwnershipRefile(facts({
    existingReplacementTaskId: 'task-2',
    ownership: decideTaskOwnership({
      taskId: 'task-1',
      projectId: B,
      creatorCoordinatorProjectId: A,
      creatorCoordinatorGeneration: '3',
      approvedCrossing: false,
    }),
    taskStatus: 'CANCELLED',
  }));
  assert.equal(plan.action, 'ALREADY_REFILED');
  assert.equal(plan.action === 'ALREADY_REFILED' && plan.replacementTaskId, 'task-2');
  assert.equal(plan.action === 'ALREADY_REFILED' && plan.replacementProjectId, A);
});

test('L6 §refile: nothing recorded which project filed it — there is nowhere to refile to', () => {
  const unattributed = decideTaskOwnership({
    taskId: 'task-1',
    projectId: B,
    creatorCoordinatorProjectId: null,
    creatorCoordinatorGeneration: null,
    approvedCrossing: false,
  });
  // `UNATTRIBUTED` does not refuse a run, so the repair reports the more accurate of the two
  // reasons: there is nothing to repair, rather than nowhere to put it.
  const plan = planOwnershipRefile(facts({ ownership: unattributed }));
  assert.equal(plan.action === 'REFUSE' && plan.reason, 'NOT_MISFILED');
});
