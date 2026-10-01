import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  INTEGRATION_JOB_STATES,
  RETRYABLE_LANDING_FAILURE_CLASSES,
  landingFailureClass,
  openItemKindForJobState,
} from './project-integration-job';
import { openItemMessage } from './project-open-item';
import {
  INTEGRATION_RETRY_IN_FLIGHT,
  INTEGRATION_RETRY_NOT_APPLICABLE,
  INTEGRATION_RETRY_NOT_AUTOMATIC,
  INTEGRATION_RETRY_OWNER_BLOCKER,
  INTEGRATION_RETRY_OWNER_ITEM,
  IntegrationRetryFacts,
  decideIntegrationRetry,
} from './project-integration-retry';

/**
 * `integration_retry`'s decision and the words its items are delivered in (contract §2.3 J-T1b),
 * without a database: the same facts the door reads under the task row, answered here case by case.
 * `integration-retry.pg.spec.ts` drives the same rules through the product's own doors.
 */

const RED = { name: 'MERGE_CHECK', command: 'npm test', expectedExitCode: 0, exitCode: 1, timedOut: false };
const SLOW = { name: 'TASK_ACCEPTANCE', command: 'go test ./...', expectedExitCode: 0, exitCode: null, timedOut: true };

function facts(over: Partial<IntegrationRetryFacts> = {}): IntegrationRetryFacts {
  return {
    coordinatorEnabled: true,
    taskStatus: 'DONE',
    newestLanding: { id: 'job-1', generation: 1, state: 'CHECK_FAILED', checks: [RED] },
    openItems: [{ id: 'item-1', kind: 'INTEGRATION_CHECK_FAILED', assignee: 'COORDINATOR', assigneeReason: 'DEFAULT' }],
    ownerBlockers: [],
    ...over,
  };
}

function refusalOf(input: IntegrationRetryFacts): { status: number; code: string; message: string } {
  const decision = decideIntegrationRetry(input);
  assert.equal(decision.ok, false, 'the door would have queued a rerun');
  if (decision.ok) throw new Error('unreachable');
  return { status: decision.status, code: decision.body.code, message: decision.body.message };
}

test('a failed landing is classified off its structured result, never off its output', () => {
  assert.equal(landingFailureClass({ state: 'CHECK_FAILED', checks: [RED] }), 'CHECK_FAILED');
  assert.equal(landingFailureClass({ state: 'CHECK_FAILED', checks: [RED, SLOW] }), 'CHECK_TIMED_OUT');
  // Go's own test timeout panics with exit 1 and the runner's budget never ran out: that is a red
  // check, whatever the output says about timing out.
  assert.equal(landingFailureClass({
    state: 'CHECK_FAILED',
    checks: [{ ...RED, outputTail: 'panic: test timed out after 10m0s' }],
  }), 'CHECK_FAILED');
  assert.equal(landingFailureClass({ state: 'ERROR', checks: [] }), 'ERROR');
  assert.equal(landingFailureClass({ state: 'CONFLICT', checks: [] }), 'CONFLICT');
  assert.equal(landingFailureClass({ state: 'CHECK_FAILED', checks: 'not an array' }), 'CHECK_FAILED');
  // Every state that opens an item has a class, and no other state does.
  for (const state of INTEGRATION_JOB_STATES) {
    assert.equal(
      landingFailureClass({ state, checks: [] }) !== null,
      openItemKindForJobState(state) !== null,
      `${state}: a class exactly where an item is opened`,
    );
  }
  assert.deepEqual([...RETRYABLE_LANDING_FAILURE_CLASSES], ['CHECK_FAILED', 'CHECK_TIMED_OUT', 'ERROR']);
});

test('Automatic: a red, a timed-out or an errored landing of a DONE task is rerun, superseding the coordinator\'s items', () => {
  for (const [state, checks, expected] of [
    ['CHECK_FAILED', [RED], 'CHECK_FAILED'],
    ['CHECK_FAILED', [SLOW], 'CHECK_TIMED_OUT'],
    ['ERROR', [], 'ERROR'],
  ] as const) {
    const decision = decideIntegrationRetry(facts({
      newestLanding: { id: 'job-7', generation: 3, state, checks },
    }));
    assert.deepEqual(decision, {
      ok: true,
      retryOfJobId: 'job-7',
      failureClass: expected,
      supersede: ['item-1'],
    });
  }
  // The coordinator closed its item by hand (the state task ③ of 34Y7My8sqhKLWtmCQYv1l was left in):
  // with the switch on, the landing is still the coordinator's to rerun.
  assert.deepEqual(decideIntegrationRetry(facts({ openItems: [] })), {
    ok: true,
    retryOfJobId: 'job-1',
    failureClass: 'CHECK_FAILED',
    supersede: [],
  });
});

test('not Automatic: a failure nobody handed over is the owner\'s; one the owner handed back is the coordinator\'s', () => {
  const ownersFromBirth = refusalOf(facts({
    coordinatorEnabled: false,
    openItems: [{ id: 'item-1', kind: 'INTEGRATION_CHECK_FAILED', assignee: 'OWNER', assigneeReason: 'NO_COORDINATOR' }],
  }));
  assert.equal(ownersFromBirth.status, 409);
  assert.equal(ownersFromBirth.code, INTEGRATION_RETRY_OWNER_ITEM);
  assert.match(ownersFromBirth.message, /not Automatic/);

  const closed = refusalOf(facts({ coordinatorEnabled: false, openItems: [] }));
  assert.equal(closed.status, 403);
  assert.equal(closed.code, INTEGRATION_RETRY_NOT_AUTOMATIC);

  // "Ask the coordinator again" put the item back in front of the coordinator: the decision came with it.
  assert.equal(decideIntegrationRetry(facts({ coordinatorEnabled: false })).ok, true);
});

test('escalated to the owner, or an owner blocker open on the task: refused', () => {
  const escalated = refusalOf(facts({
    openItems: [
      { id: 'item-1', kind: 'INTEGRATION_CHECK_FAILED', assignee: 'OWNER', assigneeReason: 'ESCALATED' },
    ],
  }));
  assert.equal(escalated.status, 409);
  assert.equal(escalated.code, INTEGRATION_RETRY_OWNER_ITEM);
  assert.match(escalated.message, /ESCALATED/);
  assert.match(escalated.message, /Ask the coordinator again/);

  const blocked = refusalOf(facts({ ownerBlockers: [{ id: 'b-1', kind: 'AWAITING_USER_APPROVAL' }] }));
  assert.equal(blocked.status, 409);
  assert.equal(blocked.code, INTEGRATION_RETRY_OWNER_BLOCKER);
});

test('in flight, not DONE, never landed, landed or conflicted: refused, each saying why', () => {
  for (const state of ['QUEUED', 'RUNNING']) {
    const inFlight = refusalOf(facts({ newestLanding: { id: 'job-2', generation: 2, state, checks: [] } }));
    assert.equal(inFlight.status, 409);
    assert.equal(inFlight.code, INTEGRATION_RETRY_IN_FLIGHT);
    assert.match(inFlight.message, new RegExp(`generation 2 of this task's landing is already ${state}`));
  }
  for (const [over, pattern] of [
    [{ taskStatus: 'IN_PROGRESS' }, /not DONE/],
    [{ newestLanding: null }, /never had a landing/],
    [{ newestLanding: { id: 'j', generation: 1, state: 'LANDED', checks: [] } }, /on the line already/],
    [{ newestLanding: { id: 'j', generation: 1, state: 'ALREADY_LANDED', checks: [] } }, /on the line already/],
    [{ newestLanding: { id: 'j', generation: 1, state: 'NOTHING_TO_LAND', checks: [] } }, /NOTHING_TO_LAND/],
    [{ newestLanding: { id: 'j', generation: 1, state: 'CONFLICT', checks: [] } }, /task_reopen/],
    [{ newestLanding: { id: 'j', generation: 1, state: 'CANCELLED', checks: [] } }, /not a failure a rerun answers/],
  ] as const) {
    const refused = refusalOf(facts(over as Partial<IntegrationRetryFacts>));
    assert.equal(refused.status, 409, JSON.stringify(over));
    assert.equal(refused.code, INTEGRATION_RETRY_NOT_APPLICABLE, JSON.stringify(over));
    assert.match(refused.message, pattern);
  }
});

const PROJECT = '01a0f53a-99c8-7488-82b1-b4b2d95ecbe1';
const TASK = '01a0f53f-5fa0-70e8-80c5-c9582a60ec33';

test('a failed landing\'s item tells the coordinator its class, and that task_start does not land it again', () => {
  const told = openItemMessage({
    id: '01a0f5c9-0000-7000-8000-000000000001',
    kind: 'INTEGRATION_CHECK_FAILED',
    title: 'Checks failed on the combined tree: ③ 实现所有者收尾门与 Done 优先语义',
    projectId: PROJECT,
    taskId: TASK,
    payload: { jobKind: 'LAND_TASK', check: RED, branchUnchanged: true, failureClass: 'CHECK_FAILED', generation: 1 },
  });
  assert.match(told, /检查 MERGE_CHECK 的退出码是 1/);
  assert.match(told, /失败分类：CHECK_FAILED（检查跑完了，退出码与声明不一致）/);
  assert.match(told, /task_start 只会再跑一遍任务、开一条新分支，不会重新排这次落地/);
  assert.match(told, /integration_retry（projectId 传 34Y7My8sqhKLWtmCQYv1l，taskId 传 34Y7Utvsd47A14DjMzIzD/);
  assert.match(told, /这类落地去留由你判，不拿去问账号所有者/);
  assert.doesNotMatch(told, /再决定是重新跑（task_start）/, 'the old advice sent DONE tasks to task_start');
  assert.doesNotMatch(told, /这是这项任务的第/, 'a first generation is not a rerun');
});

test('a rerun that failed again says what it reran and why, and not to rerun it as it stands', () => {
  const told = openItemMessage({
    id: '01a0f5c9-0000-7000-8000-000000000002',
    kind: 'INTEGRATION_CHECK_FAILED',
    title: 'Checks failed on the combined tree: ③',
    projectId: PROJECT,
    taskId: TASK,
    payload: {
      jobKind: 'LAND_TASK',
      check: SLOW,
      branchUnchanged: true,
      failureClass: 'CHECK_TIMED_OUT',
      generation: 2,
      retry: {
        retryOfJobId: '01a0f5c8-0000-7000-8000-000000000003',
        failureClass: 'CHECK_FAILED',
        reason: 'the runner-go baseline was repaired',
        requestedBySessionId: '01a0f53a-9b6f-702a-8c59-7d43a5932339',
      },
    },
  });
  assert.match(told, /失败分类：CHECK_TIMED_OUT/);
  assert.match(told, /这是这项任务的第 2 代落地，由协调会话要求重跑/);
  assert.match(told, /失败分类是 CHECK_FAILED，重跑的理由是「the runner-go baseline was repaired」/);
  assert.match(told, /不要再原样重跑/);
});

test('a conflict\'s item sends the task back rather than to integration_retry', () => {
  const told = openItemMessage({
    id: '01a0f5c9-0000-7000-8000-000000000004',
    kind: 'INTEGRATION_CONFLICT',
    title: 'Merge conflict: ③',
    projectId: PROJECT,
    taskId: TASK,
    payload: {
      jobKind: 'LAND_TASK',
      phase: 'REBASE',
      targetRef: 'refs/heads/project/34Y7My8sqhKLWtmCQYv1l',
      files: ['src/apiserver/src/tasks/task-judgment-data-preserved.spec.ts'],
      nothingLanded: true,
      failureClass: 'CONFLICT',
      generation: 1,
    },
  });
  assert.match(told, /integration_retry 也不接受冲突/);
  assert.match(told, /task_reopen 把任务退回返工/);
  assert.doesNotMatch(told, /reason 写明这次为什么会不同/);
});
