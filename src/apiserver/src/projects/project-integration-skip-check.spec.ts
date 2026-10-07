import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  INTEGRATION_SKIP_CHECK_APPROVAL_MISMATCHED,
  INTEGRATION_SKIP_CHECK_APPROVAL_REQUIRED,
  INTEGRATION_SKIP_CHECK_NOT_A_CHECK_FAILURE,
  INTEGRATION_SKIP_CHECK_TOOL_NAME,
  IntegrationSkipCheckFacts,
  SkipCheckApprovalFacts,
  decideIntegrationSkipCheck,
  isApprovalId,
  notAnApprovalId,
} from './project-integration-skip-check';
import {
  INTEGRATION_RETRY_IN_FLIGHT,
  INTEGRATION_RETRY_NOT_APPLICABLE,
  INTEGRATION_RETRY_OWNER_ITEM,
} from './project-integration-retry';
import { IntegrationJobRow, integrationJobView, skippedMergeCheck } from './project-integration-job';
import { checksFor } from '../runner-api/integration-job-relay';

/**
 * `integration_skip_merge_check` (contract §2.4 J-S5): the one generation of a landing that runs
 * WITHOUT its merge check, and the account owner's card that is the only thing that may open it.
 *
 * Without a database: the decision is taken here case by case over the facts the door reads under the
 * task row, the command a claimed generation is handed is built here, and the record a skipped
 * landing leaves behind is read here. `integration-skip-merge-check.pg.spec.ts` drives the same rules
 * through the product's own doors.
 */

const RED = { name: 'MERGE_CHECK', command: 'npm test', expectedExitCode: 0, exitCode: 1, timedOut: false };
const SLOW = { name: 'MERGE_CHECK', command: 'npm test', expectedExitCode: 0, exitCode: null, timedOut: true };

/** The card the runner filed and the owner answered, as the service reads it back. */
function card(over: Partial<SkipCheckApprovalFacts> = {}): SkipCheckApprovalFacts {
  return {
    id: 'card-1',
    toolName: INTEGRATION_SKIP_CHECK_TOOL_NAME,
    status: 'ALLOWED',
    sessionId: 'coordinator-1',
    input: { projectId: 'project-1', taskId: 'task-1' },
    decidedById: 'owner-1',
    ...over,
  };
}

function facts(over: Partial<IntegrationSkipCheckFacts> = {}): IntegrationSkipCheckFacts {
  return {
    requester: 'COORDINATOR',
    coordinatorEnabled: true,
    taskStatus: 'DONE',
    newestLanding: { id: 'job-1', generation: 1, state: 'CHECK_FAILED', checks: [RED] },
    openItems: [{ id: 'item-1', kind: 'INTEGRATION_CHECK_FAILED', assignee: 'COORDINATOR', assigneeReason: 'DEFAULT' }],
    ownerBlockers: [],
    projectId: 'project-1',
    taskId: 'task-1',
    actingSessionId: 'coordinator-1',
    approval: card(),
    ...over,
  };
}

function refusalOf(input: IntegrationSkipCheckFacts): { status: number; code: string; message: string } {
  const decision = decideIntegrationSkipCheck(input);
  assert.equal(decision.ok, false, 'the door would have queued a skipped landing');
  if (decision.ok) throw new Error('unreachable');
  return { status: decision.status, code: decision.body.code, message: decision.body.message };
}

test('the owner\'s card is what opens the door, and the generation it queues is the next rerun', () => {
  const decision = decideIntegrationSkipCheck(facts());
  assert.equal(decision.ok, true, 'an answered card on a red check was refused');
  if (!decision.ok) throw new Error('unreachable');
  assert.equal(decision.retryOfJobId, 'job-1');
  assert.equal(decision.failureClass, 'CHECK_FAILED');
  // The coordinator's own item is the rerun's to handle (§4.7 H1), exactly as it is for a rerun.
  assert.deepEqual(decision.handle, ['item-1']);
});

test('a check that ran out of its budget is a check nobody accepts, and may be skipped too', () => {
  const decision = decideIntegrationSkipCheck(facts({
    newestLanding: { id: 'job-7', generation: 7, state: 'CHECK_FAILED', checks: [SLOW] },
  }));
  assert.equal(decision.ok, true);
  if (!decision.ok) throw new Error('unreachable');
  assert.equal(decision.failureClass, 'CHECK_TIMED_OUT');
});

test('no card, an unanswered card and a declined card all refuse, and nothing is queued', () => {
  const missing = refusalOf(facts({ approval: null }));
  assert.equal(missing.status, 403);
  assert.equal(missing.code, INTEGRATION_SKIP_CHECK_APPROVAL_REQUIRED);
  assert.match(missing.message, /account owner's yes on a confirmation card/);

  const pending = refusalOf(facts({ approval: card({ status: 'PENDING' }) }));
  assert.equal(pending.code, INTEGRATION_SKIP_CHECK_APPROVAL_REQUIRED);
  assert.match(pending.message, /still waiting for the account owner/);

  const denied = refusalOf(facts({ approval: card({ status: 'DENIED' }) }));
  assert.equal(denied.code, INTEGRATION_SKIP_CHECK_APPROVAL_REQUIRED);
  assert.match(denied.message, /no is an answer/);
  // The landing stands as it failed: a decline takes nothing off the branch and queues nothing.
  assert.match(denied.message, /stands as it failed/);
});

test('a card about another landing, or filed by another conversation, is not this landing\'s yes', () => {
  const otherTask = refusalOf(facts({ approval: card({ input: { projectId: 'project-1', taskId: 'task-9' } }) }));
  assert.equal(otherTask.code, INTEGRATION_SKIP_CHECK_APPROVAL_MISMATCHED);

  const otherProject = refusalOf(facts({ approval: card({ input: { projectId: 'project-9', taskId: 'task-1' } }) }));
  assert.equal(otherProject.code, INTEGRATION_SKIP_CHECK_APPROVAL_MISMATCHED);

  const otherSession = refusalOf(facts({ approval: card({ sessionId: 'coordinator-9' }) }));
  assert.equal(otherSession.code, INTEGRATION_SKIP_CHECK_APPROVAL_MISMATCHED);

  // A card filed under some other question — an integration retry's, say — is not this door's.
  const wrongTool = refusalOf(facts({ approval: card({ toolName: 'orbit_blocker_resolve' }) }));
  assert.equal(wrongTool.code, INTEGRATION_SKIP_CHECK_APPROVAL_MISMATCHED);
});

test('a standing rule is not the account owner\'s yes', () => {
  // An ALLOWED row with no decider was answered by a rule (a workspace's standing grant, or the
  // start card reviewing a create). This question is asked afresh each time — whether THIS landing
  // may go on without the check the owner is looking at — so no rule may stand in for their answer.
  const auto = refusalOf(facts({ approval: card({ decidedById: null }) }));
  assert.equal(auto.status, 403);
  assert.equal(auto.code, INTEGRATION_SKIP_CHECK_APPROVAL_REQUIRED);
  assert.match(auto.message, /standing rule/);
});

test('a card id that is not an id is refused before anything is looked up', () => {
  // The row is a uuid: a word here would reach a uuid column and come back as a 500 from the
  // database rather than as the refusal it is, so the shape is checked first and the read is not
  // even attempted.
  assert.equal(isApprovalId('9f1d5c2e-3a44-4a9b-8f2e-0b1c2d3e4f50'), true);
  assert.equal(isApprovalId('ap-skip-1'), false);
  assert.equal(isApprovalId(''), false);
  const refusal = notAnApprovalId('ap-skip-1');
  assert.equal(refusal.status, 403);
  assert.equal(refusal.body.code, INTEGRATION_SKIP_CHECK_APPROVAL_MISMATCHED);
  assert.match(refusal.body.message, /not the id of a confirmation card/);
});

test('the account owner asks for a skip themselves, and their press is the approval', () => {
  const decision = decideIntegrationSkipCheck(facts({
    requester: 'OWNER',
    actingSessionId: null,
    approval: null,
    openItems: [{ id: 'item-1', kind: 'INTEGRATION_CHECK_FAILED', assignee: 'OWNER', assigneeReason: 'ESCALATED' }],
  }));
  assert.equal(decision.ok, true, 'the owner may skip without a card of their own');
});

test('a failure whose item is the account owner\'s is theirs, exactly as it is for a rerun', () => {
  const owned = refusalOf(facts({
    openItems: [{ id: 'item-1', kind: 'INTEGRATION_CHECK_FAILED', assignee: 'OWNER', assigneeReason: 'ESCALATED' }],
  }));
  assert.equal(owned.code, INTEGRATION_RETRY_OWNER_ITEM);
  assert.match(owned.message, /the account owner's/);
});

test('a conflict, an error and a landing already in flight are each refused where they are', () => {
  // A conflict is the branch's: only a branch that changed answers one, and a skip would not.
  const conflicted = refusalOf(facts({
    newestLanding: { id: 'job-1', generation: 1, state: 'CONFLICT', checks: [], phase: 'REBASE' },
  }));
  assert.equal(conflicted.code, INTEGRATION_RETRY_NOT_APPLICABLE);
  assert.match(conflicted.message, /conflicts the same way/);

  // The machinery stopping is not a check disagreeing — and `integration_retry` does answer it.
  const errored = refusalOf(facts({
    newestLanding: { id: 'job-1', generation: 1, state: 'ERROR', checks: [] },
  }));
  assert.equal(errored.status, 409);
  assert.equal(errored.code, INTEGRATION_SKIP_CHECK_NOT_A_CHECK_FAILURE);
  assert.match(errored.message, /integration_retry/);

  // Nothing is skipped while a generation is still out there: wait for its result.
  const inFlight = refusalOf(facts({
    newestLanding: { id: 'job-1', generation: 1, state: 'RUNNING', checks: [] },
  }));
  assert.equal(inFlight.code, INTEGRATION_RETRY_IN_FLIGHT);

  // A landing that ran its check and was accepted has nothing to skip.
  const landed = refusalOf(facts({
    newestLanding: { id: 'job-1', generation: 1, state: 'LANDED', checks: [] },
  }));
  assert.equal(landed.code, INTEGRATION_RETRY_NOT_APPLICABLE);
});

/** What `checksFor` reads off a claimed row. Only the fields the two checks are built from. */
function claimed(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'LAND_TASK',
    promotionSourceKind: null,
    acceptanceCommand: 'exit 0',
    acceptanceExpectedExitCode: 0,
    acceptanceTimeoutSeconds: 60,
    mergeCheckCommand: 'npm test && go test ./...',
    mergeCheckTimeoutSeconds: 3_600,
    skipMergeCheck: false,
    ...over,
  };
}

const named = (checks: { name: string }[]): string[] => checks.map((check) => check.name);

test('the generation the owner approved is handed no merge check at all — and the next one is', () => {
  // The one that was approved: the project's check is what was skipped, so no MERGE_CHECK spec is
  // built and the runner's CHECK phase never happens for it.
  assert.deepEqual(named(checksFor(claimed({ skipMergeCheck: true }) as never)), ['TASK_ACCEPTANCE']);
  // The task's own acceptance command is NOT skipped with it: a task that cannot pass its own
  // criterion on the combined tree is a statement about that task, which no approval here waived.
  const skipped = checksFor(claimed({ skipMergeCheck: true, acceptanceCommand: null }) as never);
  assert.deepEqual(skipped, [], 'nothing but the task acceptance was left to run');

  // ONE generation: the next landing of the same task is queued with the flag false — which is every
  // other row ever written — and is handed the check exactly as before.
  assert.deepEqual(named(checksFor(claimed() as never)), ['TASK_ACCEPTANCE', 'MERGE_CHECK']);
  const mergeCheck = checksFor(claimed() as never)[1]!;
  assert.equal(mergeCheck.command, 'npm test && go test ./...');
  assert.equal(mergeCheck.timeoutSeconds, 3_600);

  // A project with no check command of its own is the other way an empty list arises, and it is not
  // a skip: the flag is what tells them apart on the row.
  assert.deepEqual(named(checksFor(claimed({ mergeCheckCommand: null }) as never)), ['TASK_ACCEPTANCE']);
});

test('a promotion\'s check is never skipped — this door is a landing\'s', () => {
  // 0393's CHECK refuses the flag on anything but a LAND_TASK. A row that arrived saying otherwise
  // still gets the check it was queued for: what the owner approved was one landing's check, and a
  // promotion is the merge into main that they decide separately.
  const promotion = checksFor(claimed({ kind: 'CHECK_PROMOTION', skipMergeCheck: true }) as never);
  assert.deepEqual(named(promotion), ['MERGE_CHECK']);
});

test('a skipped landing says so on its own row, with who approved it and why', () => {
  const record = skippedMergeCheck({
    skipMergeCheck: true,
    skipReason: 'the check command needs GNU timeout and bash 4, and this runner has neither',
    skipApprovedByUserId: 'owner-1',
    skipApprovalId: 'card-1',
  });
  assert.deepEqual(record, {
    reason: 'the check command needs GNU timeout and bash 4, and this runner has neither',
    approvedByUserId: 'owner-1',
    approvalId: 'card-1',
  });

  // The owner's own skip has no card, and the record says who gave it anyway.
  assert.deepEqual(skippedMergeCheck({
    skipMergeCheck: true,
    skipReason: 'the check is red on this machine and the work is not',
    skipApprovedByUserId: 'owner-1',
    skipApprovalId: null,
  }), { reason: 'the check is red on this machine and the work is not', approvedByUserId: 'owner-1', approvalId: null });

  // Every other landing in the tree: the check ran, and there is nothing to report about it.
  assert.equal(skippedMergeCheck({
    skipMergeCheck: false,
    skipReason: null,
    skipApprovedByUserId: null,
    skipApprovalId: null,
  }), null);
});

test('a landing reads back as skipped-with-a-reason rather than as a green one', () => {
  const row = {
    id: 'job-2',
    kind: 'LAND_TASK',
    generation: 2,
    taskId: 'task-1',
    state: 'LANDED',
    phase: 'PUSH',
    targetRef: 'refs/heads/project/x',
    sourceRef: 'refs/heads/orbit/x',
    sourceSha: 'a'.repeat(40),
    testedSha: null,
    testedTreeSha: null,
    landedSha: null,
    landedTreeSha: null,
    aheadOfUpstream: null,
    // Nothing ran, so there is no check result to read — which without the skip below would be
    // indistinguishable from a project that has no merge check command at all.
    checks: [],
    conflicts: [],
    errorCode: null,
    createdAt: new Date(0),
    startedAt: null,
    finishedAt: null,
    skipMergeCheck: true,
    skipReason: 'bash 3.2 has no mapfile and there is no GNU timeout on this runner',
    skipApprovedByUserId: 'owner-1',
    skipApprovalId: 'card-1',
  } as unknown as IntegrationJobRow;
  const view = integrationJobView(row);
  assert.deepEqual(view.checks, []);
  assert.equal(view.skippedCheck?.reason, 'bash 3.2 has no mapfile and there is no GNU timeout on this runner');
  assert.equal(view.skippedCheck?.approvedByUserId, 'owner-1');
  assert.equal(view.skippedCheck?.approvalId, 'card-1');

  // A row that ran its check carries no skip, so nothing about it reads as one.
  const ran = integrationJobView({ ...row, skipMergeCheck: false, skipReason: null, skipApprovedByUserId: null, skipApprovalId: null } as unknown as IntegrationJobRow);
  assert.equal(ran.skippedCheck, null);
});
