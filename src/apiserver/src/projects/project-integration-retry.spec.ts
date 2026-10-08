import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  INTEGRATION_JOB_STATES,
  RETRYABLE_LANDING_FAILURE_CLASSES,
  landingFailureClass,
  openItemKindForJobState,
} from './project-integration-job';
import { openItemActions, openItemMessage } from './project-open-item';
import { COORDINATOR_AUTHORITY, refuseHumanOnlyAction } from './coordinator-authority';
import { promotionPrincipalRefusal } from './project-promotion';
import { ownerConfirmationPrincipalRefusal } from '../tasks/task-owner-confirmation';
import {
  INTEGRATION_RETRY_IN_FLIGHT,
  INTEGRATION_RETRY_NOT_APPLICABLE,
  INTEGRATION_RETRY_NOT_AUTOMATIC,
  INTEGRATION_RETRY_OWNER_ONLY,
  INTEGRATION_RETRY_OWNER_BLOCKER,
  INTEGRATION_RETRY_OWNER_ITEM,
  IntegrationRetryFacts,
  PromotionRetryFacts,
  decideIntegrationRetry,
  decidePromotionRetry,
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

test('Automatic: a red, a timed-out or an errored landing of a DONE task is rerun, handling the coordinator\'s items', () => {
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
      handle: ['item-1'],
    });
  }
  // The coordinator closed its item by hand (the state task ③ of 34Y7My8sqhKLWtmCQYv1l was left in):
  // with the switch on, the landing is still the coordinator's to rerun.
  assert.deepEqual(decideIntegrationRetry(facts({ openItems: [] })), {
    ok: true,
    retryOfJobId: 'job-1',
    failureClass: 'CHECK_FAILED',
    handle: [],
  });
});

test('the owner door reruns only the owner\'s item and attributes the decision to the user', () => {
  const decision = decideIntegrationRetry(facts({
    requester: 'OWNER',
    openItems: [{ id: 'owner-item', kind: 'INTEGRATION_CHECK_FAILED', assignee: 'OWNER', assigneeReason: 'ESCALATED' }],
  }));
  assert.deepEqual(decision, {
    ok: true,
    retryOfJobId: 'job-1',
    failureClass: 'CHECK_FAILED',
    handle: ['owner-item'],
  });

  const coordinatorItem = decideIntegrationRetry(facts({
    requester: 'OWNER',
    openItems: [{ id: 'coordinator-item', kind: 'INTEGRATION_CHECK_FAILED', assignee: 'COORDINATOR', assigneeReason: 'DEFAULT' }],
  }));
  assert.equal(coordinatorItem.ok, false);
  if (!coordinatorItem.ok) {
    assert.equal(coordinatorItem.status, 403);
    assert.equal(coordinatorItem.body.code, INTEGRATION_RETRY_OWNER_ONLY);
  }
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

test('a RUNNING landing whose runner stopped reporting is retried as the ERROR it is (J-T9)', () => {
  const silent = { id: 'job-2', generation: 2, state: 'RUNNING', checks: [], phase: 'FETCH', timedOut: true };
  // The coordinator: the same rules as any failed landing, with no item about it yet.
  assert.deepEqual(decideIntegrationRetry(facts({ newestLanding: silent, openItems: [] })), {
    ok: true, retryOfJobId: 'job-2', failureClass: 'ERROR', handle: [], endsTimedOutJob: true,
  });
  assert.equal(refusalOf(facts({ newestLanding: silent, openItems: [], coordinatorEnabled: false })).code,
    INTEGRATION_RETRY_NOT_AUTOMATIC);
  // The account owner: no item of theirs is needed — nothing has opened one, and the press decides.
  assert.deepEqual(decideIntegrationRetry(facts({ requester: 'OWNER', newestLanding: silent, openItems: [] })), {
    ok: true, retryOfJobId: 'job-2', failureClass: 'ERROR', handle: [], endsTimedOutJob: true,
  });
  assert.equal(refusalOf(facts({
    requester: 'OWNER', newestLanding: silent, openItems: [],
    ownerBlockers: [{ id: 'b-1', kind: 'AWAITING_USER_APPROVAL' }],
  })).code, INTEGRATION_RETRY_OWNER_BLOCKER);
  // Still inside its limit, or queued, it is in flight: nothing is queued beside it.
  for (const landing of [{ ...silent, timedOut: false }, { ...silent, state: 'QUEUED' }]) {
    const refused = refusalOf(facts({ requester: 'OWNER', newestLanding: landing, openItems: [] }));
    assert.equal(refused.code, INTEGRATION_RETRY_IN_FLIGHT, landing.state);
    assert.match(refused.message, /stops reporting past its limit/);
  }
  // A failed landing's decision does not change shape: it carries no timeout to end.
  assert.equal('endsTimedOutJob' in decideIntegrationRetry(facts()), false);
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

test('a MAIN_SYNC conflict\'s item says to absorb the upstream on the project line first, then land by MERGE', () => {
  // §3.1 M3. The line conflicted absorbing the upstream before it looked at the task's branch, so
  // reworking the task's own work resolves nothing: the general advice above sent 34ZNP0XRLAnAreGEOvKuw
  // back on 2026-10-03, and its next landing stopped in the same place.
  const told = openItemMessage({
    id: '01a0f5c9-0000-7000-8000-00000000000b',
    kind: 'INTEGRATION_CONFLICT',
    title: 'Merge conflict: 补齐异常与项目晋升卡的 Chat about this 和可操作入口',
    projectId: PROJECT,
    taskId: TASK,
    payload: {
      jobKind: 'LAND_TASK',
      phase: 'MAIN_SYNC',
      targetRef: 'refs/heads/project/34Y7My8sqhKLWtmCQYv1l',
      files: ['src/apiserver/src/tasks/task-judgment-data-preserved.spec.ts'],
      nothingLanded: true,
      failureClass: 'CONFLICT',
      generation: 1,
    },
  });
  assert.match(told, /合并冲突（MAIN_SYNC）/);
  assert.match(told, /冲突在项目线和 upstream 之间，不在这项任务的工作里/);
  assert.match(told, /只让任务重做自己的工作也解不开/);
  assert.match(told, /integration_retry 也不接受冲突/);
  assert.match(told, /先在项目线上吸收 upstream、解决冲突，再落地/);
  assert.match(told,
    /在这项任务的源分支上，把项目分支 refs\/heads\/project\/34Y7My8sqhKLWtmCQYv1l 的 tip 和 upstream 的 tip 合进来/);
  assert.match(told, /提交这个合并提交。任务原来的工作留着，不用重做/);
  assert.match(told, /按 J-S4 的 MERGE 模式落地，进项目分支的树就是源分支的树/);
  assert.match(told, /照旧停在 MAIN_SYNC，那就再合一次/);
  assert.match(told, /先用 task_comment 在任务上写明这一轮只做第 1 步，再用 task_reopen 把它退回/);
  assert.match(told, /只有这项任务自己的下一次落地不用等/);
  assert.doesNotMatch(told, /task_reopen 把任务退回返工/, 'a MAIN_SYNC conflict is not the task\'s work to redo');
  assert.doesNotMatch(told, /reason 写明这次为什么会不同/);
});

test('integration_retry still refuses a MAIN_SYNC conflict, and says to absorb the upstream on the project line', () => {
  const refused = refusalOf(facts({
    newestLanding: { id: 'j', generation: 1, state: 'CONFLICT', checks: [], phase: 'MAIN_SYNC' },
    openItems: [{ id: 'item-1', kind: 'INTEGRATION_CONFLICT', assignee: 'COORDINATOR', assigneeReason: 'DEFAULT' }],
  }));
  assert.equal(refused.status, 409);
  assert.equal(refused.code, INTEGRATION_RETRY_NOT_APPLICABLE);
  assert.match(refused.message, /stopped at MAIN_SYNC/);
  assert.match(refused.message, /so does sending the task back to redo its work/);
  assert.match(refused.message, /Absorb the upstream on the project line first/);
  assert.match(refused.message, /merge commit of the project branch tip and the upstream tip/);
  assert.match(refused.message, /lands by J-S4 MERGE/);
  assert.doesNotMatch(refused.message, /reworked against the line as it is now/);
  // A conflict anywhere else is still the task branch's to change.
  for (const phase of ['REBASE', 'MERGE', null]) {
    const other = refusalOf(facts({
      newestLanding: { id: 'j', generation: 1, state: 'CONFLICT', checks: [], phase },
    }));
    assert.match(other.message, /reworked against the line as it is now/, String(phase));
  }
});

// ── a blocked candidate's check (§4.7 H1): the item about a merge into main, which names no task ──

const CANDIDATE = '01a0f5d0-0000-7000-8000-00000000000a';

function candidate(over: Partial<PromotionRetryFacts> = {}): PromotionRetryFacts {
  return {
    coordinatorEnabled: true,
    promotionState: 'BLOCKED',
    newestJob: { id: 'check-1', kind: 'CHECK_PROMOTION', generation: 1, state: 'CHECK_FAILED', checks: [RED] },
    openItems: [{ id: 'item-9', kind: 'INTEGRATION_CHECK_FAILED', assignee: 'COORDINATOR', assigneeReason: 'DEFAULT' }],
    ...over,
  };
}

function candidateRefusal(input: PromotionRetryFacts): { status: number; code: string; message: string } {
  const decision = decidePromotionRetry(input);
  assert.equal(decision.ok, false, 'the door would have queued a check');
  if (decision.ok) throw new Error('unreachable');
  return { status: decision.status, code: decision.body.code, message: decision.body.message };
}

test('a blocked candidate whose check was red, timed out or errored is checked again, handling the coordinator\'s items', () => {
  for (const [kind, state, checks, expected] of [
    ['CHECK_PROMOTION', 'CHECK_FAILED', [RED], 'CHECK_FAILED'],
    ['CHECK_PROMOTION', 'CHECK_FAILED', [SLOW], 'CHECK_TIMED_OUT'],
    ['CHECK_PROMOTION', 'ERROR', [], 'ERROR'],
    // A landing into main that stopped is answered the same way: by checking the candidate again.
    ['LAND_PROMOTION', 'CHECK_FAILED', [RED], 'CHECK_FAILED'],
  ] as const) {
    assert.deepEqual(decidePromotionRetry(candidate({
      newestJob: { id: 'job-4', kind, generation: 2, state, checks },
    })), { ok: true, retryOfJobId: 'job-4', failureClass: expected, handle: ['item-9'] }, `${kind} ${state}`);
  }
  // Closed by hand already, with Automatic on: the coordinator may still check it again.
  assert.deepEqual(decidePromotionRetry(candidate({ openItems: [] })),
    { ok: true, retryOfJobId: 'check-1', failureClass: 'CHECK_FAILED', handle: [] });
});

test('a candidate that is the owner\'s — escalated, or theirs from birth without Automatic — is refused; one handed back is not', () => {
  const escalated = candidateRefusal(candidate({
    openItems: [{ id: 'item-9', kind: 'INTEGRATION_CHECK_FAILED', assignee: 'OWNER', assigneeReason: 'ESCALATED' }],
  }));
  assert.equal(escalated.status, 409);
  assert.equal(escalated.code, INTEGRATION_RETRY_OWNER_ITEM);
  assert.match(escalated.message, /blocked merge into main is the account owner's/);
  assert.match(escalated.message, /Ask the coordinator again/);

  const ownersFromBirth = candidateRefusal(candidate({
    coordinatorEnabled: false,
    openItems: [{ id: 'item-9', kind: 'INTEGRATION_CHECK_FAILED', assignee: 'OWNER', assigneeReason: 'NO_COORDINATOR' }],
  }));
  assert.equal(ownersFromBirth.code, INTEGRATION_RETRY_OWNER_ITEM);

  const nobodyHandedIt = candidateRefusal(candidate({ coordinatorEnabled: false, openItems: [] }));
  assert.equal(nobodyHandedIt.status, 403);
  assert.equal(nobodyHandedIt.code, INTEGRATION_RETRY_NOT_AUTOMATIC);

  // "Ask the coordinator again" put the item in front of the coordinator, and the decision with it.
  assert.equal(decidePromotionRetry(candidate({ coordinatorEnabled: false })).ok, true);
});

test('the owner\'s item about a blocked merge offers "Ask the coordinator again" while there is a conversation to ask; the merge card never does', () => {
  const about = { taskId: null, promotionId: CANDIDATE, fuseEpisodeId: null };
  for (const kind of ['INTEGRATION_CONFLICT', 'INTEGRATION_CHECK_FAILED', 'INTEGRATION_ERROR']) {
    assert.deepEqual(openItemActions({ ...about, kind, assignee: 'OWNER', askable: true }),
      ['ASK_COORDINATOR_AGAIN', 'RETRY', 'REVIEW'], kind);
    assert.deepEqual(openItemActions({ ...about, kind, assignee: 'OWNER', askable: false }),
      ['RETRY', 'REVIEW'], `${kind}, with no conversation to ask`);
    assert.deepEqual(openItemActions({ ...about, kind, assignee: 'COORDINATOR', askable: true }),
      ['RETRY', 'REVIEW'], `${kind}, already the coordinator's`);
  }
  // Deciding the merge is the owner's, on its own card: there is nothing to hand back.
  assert.deepEqual(openItemActions({ ...about, kind: 'PROMOTION_APPROVAL', assignee: 'OWNER', askable: true }),
    ['REVIEW']);
  // A task's escalated item is what it was.
  assert.deepEqual(openItemActions({
    kind: 'TASK_FAILED', assignee: 'OWNER', taskId: TASK, promotionId: null, fuseEpisodeId: null, askable: true,
  }), ['ASK_COORDINATOR_AGAIN', 'OPEN_TASK_SESSION', 'RETRY', 'CANCEL_TASK']);
});

test('a candidate in flight, waiting on the owner\'s merge, ended, never checked or conflicted is refused, each saying why', () => {
  for (const state of ['QUEUED', 'RUNNING']) {
    const inFlight = candidateRefusal(candidate({
      promotionState: 'CHECKING',
      newestJob: { id: 'check-2', kind: 'CHECK_PROMOTION', generation: 2, state, checks: [] },
    }));
    assert.equal(inFlight.status, 409);
    assert.equal(inFlight.code, INTEGRATION_RETRY_IN_FLIGHT);
    assert.match(inFlight.message, new RegExp(`CHECK_PROMOTION \\(generation 2\\) is already ${state}`));
  }
  const waiting = candidateRefusal(candidate({
    promotionState: 'READY',
    newestJob: { id: 'check-2', kind: 'CHECK_PROMOTION', generation: 2, state: 'READY', checks: [] },
  }));
  assert.equal(waiting.code, INTEGRATION_RETRY_NOT_APPLICABLE);
  assert.match(waiting.message, /Merge to main/, 'a candidate that passed is the owner\'s to merge, not this door\'s');
  for (const state of ['MERGED', 'DECLINED', 'CANCELLED', 'SUPERSEDED']) {
    const ended = candidateRefusal(candidate({ promotionState: state }));
    assert.equal(ended.code, INTEGRATION_RETRY_NOT_APPLICABLE, state);
    assert.match(ended.message, /next landing on the project branch makes a new candidate/);
  }
  assert.equal(candidateRefusal(candidate({ newestJob: null })).code, INTEGRATION_RETRY_NOT_APPLICABLE);
  const conflicted = candidateRefusal(candidate({
    newestJob: { id: 'check-1', kind: 'CHECK_PROMOTION', generation: 1, state: 'CONFLICT', checks: [] },
  }));
  assert.equal(conflicted.code, INTEGRATION_RETRY_NOT_APPLICABLE);
  assert.match(conflicted.message, /only a project branch that changed answers one/);
});

test('a blocked candidate\'s item names the door that checks it again, and that the merge stays the owner\'s or Automatic\'s', () => {
  const told = openItemMessage({
    id: '01a0f5c9-0000-7000-8000-000000000005',
    kind: 'INTEGRATION_CHECK_FAILED',
    title: 'Checks failed on the combined tree: merging the project branch into main',
    projectId: PROJECT,
    taskId: null,
    promotionId: CANDIDATE,
    payload: { jobKind: 'CHECK_PROMOTION', check: RED, branchUnchanged: true, failureClass: 'CHECK_FAILED', generation: 1 },
  });
  assert.match(told, /这条待办身后没有任务/);
  assert.match(told, /integration_retry（projectId 传 34Y7My8sqhKLWtmCQYv1l，promotionId 传 /);
  assert.match(told, /合并照旧由账号所有者在卡上确认，或由 Automatic 设置按原来的规则自动合并/);
  assert.match(told, /这条待办显示为处理中、仍然开着/);
  assert.match(told, /检查通过了，它自动标为已处理（HANDLED）/);
  assert.match(told, /它标为已取代（RETRIED），新的失败另开一条待办/);
  assert.doesNotMatch(told, /今天也没有一条属于协调会话的重试门/, 'the old text sent the coordinator to the owner');

  const again = openItemMessage({
    id: '01a0f5c9-0000-7000-8000-000000000006',
    kind: 'INTEGRATION_CHECK_FAILED',
    title: 'Checks failed on the combined tree: merging the project branch into main',
    projectId: PROJECT,
    taskId: null,
    promotionId: CANDIDATE,
    payload: {
      jobKind: 'CHECK_PROMOTION',
      check: RED,
      failureClass: 'CHECK_FAILED',
      generation: 2,
      retry: { retryOfJobId: '01a0f5c8-0000-7000-8000-000000000007', failureClass: 'CHECK_FAILED', reason: 'main\'s baseline was repaired' },
    },
  });
  assert.match(again, /这是这个合入 main 的候选的第 2 次检查，由协调会话要求重跑/);
  assert.match(again, /重跑的理由是「main's baseline was repaired」/);

  const conflicted = openItemMessage({
    id: '01a0f5c9-0000-7000-8000-000000000008',
    kind: 'INTEGRATION_CONFLICT',
    title: 'Merge conflict: merging the project branch into main',
    projectId: PROJECT,
    taskId: null,
    promotionId: CANDIDATE,
    payload: { jobKind: 'CHECK_PROMOTION', phase: 'MERGE', files: ['src/web/src/pages/ProjectsPage.tsx'], failureClass: 'CONFLICT', generation: 1 },
  });
  assert.match(conflicted, /integration_retry 也不接受冲突/);
  assert.match(conflicted, /用 task_create 新建一条同步任务，从项目分支 tip 出发把 upstream tip 合进它的源分支/);
  assert.match(conflicted, /解掉冲突并提交/);
  assert.doesNotMatch(conflicted, /promotionId 传/);
});

test('a task landing\'s item says the rerun leaves it open and handled, and how it ends either way', () => {
  const told = openItemMessage({
    id: '01a0f5c9-0000-7000-8000-000000000009',
    kind: 'INTEGRATION_CHECK_FAILED',
    title: 'Checks failed on the combined tree: ③',
    projectId: PROJECT,
    taskId: TASK,
    payload: { jobKind: 'LAND_TASK', check: RED, branchUnchanged: true, failureClass: 'CHECK_FAILED', generation: 1 },
  });
  assert.match(told, /用 integration_retry 重排后，这条待办显示为处理中、仍然开着/);
  assert.match(told, /落地了，它自动标为已处理（HANDLED），记下你的会话和理由/);
  assert.doesNotMatch(told, /它会带着你的理由被标成已取代/, 'the old text closed the item at the moment of the rerun');
});

/**
 * What the handling door does NOT reach (§4.7 H1–H4). It reruns a check or a landing and ends the
 * items about it, and every act that stays the account owner's stays exactly where it was: merging
 * into main (the candidate it re-checks is merged by the owner's card or the Automatic setting's own
 * rule, never by this door — and a candidate waiting on that card is refused here), confirming an
 * OWNER_CONFIRMED task, and changing or confirming the acceptance criteria. Pinned beside the door so a
 * later change to it has to read them.
 */
test('around the handling door, the owner-only acts stay the owner\'s', () => {
  const owner = 'owner-1';
  const coordinator = '34Y7Myo7G89Vk0fVpelbt';
  // A merge into main is the owner's press: an agent session holding the owner's key is refused.
  assert.match(promotionPrincipalRefusal(owner, { userId: owner, actingSessionId: coordinator }) ?? '',
    /confirmed only by the account owner/);
  assert.equal(promotionPrincipalRefusal(owner, { userId: owner }), null, 'the owner in the app is not');
  // …and the re-check never stands in for it: a candidate that passed is refused, with the owner named.
  const waiting = candidateRefusal(candidate({
    promotionState: 'READY',
    newestJob: { id: 'check-2', kind: 'CHECK_PROMOTION', generation: 2, state: 'READY', checks: [] },
  }));
  assert.equal(waiting.code, INTEGRATION_RETRY_NOT_APPLICABLE);
  assert.match(waiting.message, /confirming the merge is theirs/);
  // An OWNER_CONFIRMED task is confirmed by the owner in the app — never over the runner, coordinator
  // included.
  assert.ok(ownerConfirmationPrincipalRefusal(owner, { door: 'RUNNER', userId: owner, actingSessionId: coordinator }));
  assert.ok(ownerConfirmationPrincipalRefusal(owner, { door: 'USER', userId: owner, actingSessionId: coordinator }));
  assert.equal(ownerConfirmationPrincipalRefusal(owner, { door: 'USER', userId: owner }), null);
  // The acceptance criteria — the exam — are edited and confirmed by a person, not by a judgment.
  assert.equal(COORDINATOR_AUTHORITY.EDIT_ACCEPTANCE_CRITERIA, 'HUMAN_ONLY');
  assert.equal(COORDINATOR_AUTHORITY.CONFIRM_ACCEPTANCE_CRITERIA, 'HUMAN_ONLY');
  assert.equal(refuseHumanOnlyAction('JUDGMENT', 'EDIT_ACCEPTANCE_CRITERIA')?.code, 'ACCEPTANCE_CRITERIA_HUMAN_ONLY');
  // And the items the door hands the coordinator are only ever its own: one the owner holds refuses it.
  for (const decide of [
    () => decideIntegrationRetry(facts({
      openItems: [{ id: 'item-1', kind: 'INTEGRATION_CHECK_FAILED', assignee: 'OWNER', assigneeReason: 'ESCALATED' }],
    })),
    () => decidePromotionRetry(candidate({
      openItems: [{ id: 'item-9', kind: 'INTEGRATION_CHECK_FAILED', assignee: 'OWNER', assigneeReason: 'ESCALATED' }],
    })),
  ]) {
    const decision = decide();
    assert.equal(decision.ok, false);
    if (!decision.ok) assert.equal(decision.body.code, INTEGRATION_RETRY_OWNER_ITEM);
  }
});
