import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorizeProjectAction,
  ProjectActionAuthorizationInput,
  ProjectVerificationBlock,
} from './project-authorization.service';
import { MAX_AUTO_RUN_FAILURES } from '../tasks/task-retry-policy';

/**
 * §13.2 V3 / §7.4 precondition 3, at the guard.
 *
 * The property under test is deliberately narrow: an unresolved verification failure makes a task
 * undispatchable, and it does so HERE — by being read as a precondition — rather than by anybody
 * having rewritten the blocked task's status. Everything the failure holds up is therefore still
 * OPEN, still assigned, still owned by whoever owned it, and reads as work that is waiting rather
 * than as work somebody quietly moved.
 */

const EVALUATED_AT = '2026-08-20T12:00:00.000Z';

function block(overrides: Partial<ProjectVerificationBlock> = {}): ProjectVerificationBlock {
  return {
    reason: 'UPSTREAM',
    failureId: 'f',
    verifierTaskId: 'v',
    subjectTaskId: 's',
    verdict: 'FAIL',
    verdictRevision: '2',
    defectTaskId: 'd',
    ...overrides,
  };
}

function input(
  task: Partial<NonNullable<ProjectActionAuthorizationInput['task']>> = {},
): ProjectActionAuthorizationInput {
  return {
    v: 1,
    sourceDecisionInputHash: 'a'.repeat(64),
    idempotencyKey: 'pc:v1:p:dispatch:t:1',
    evaluatedAt: EVALUATED_AT,
    action: 'DISPATCH_TASK',
    requiredPermission: 'COORDINATE',
    project: {
      id: 'p',
      status: 'OPEN',
      coordinatorEnabled: true,
      automationPolicy: 'AUTO',
      configRevision: '1',
      inFlightTasks: 0,
      maxConcurrentTasks: 3,
      coordinatorSessionsStartedLast24h: 0,
      sessionBudgetPerDay: null,
    },
    principal: {
      agentId: 'agent',
      coordinatorAgentId: 'agent',
      memberRole: 'COORDINATOR',
      agentEnabled: true,
      agentDeleted: false,
      canCoordinate: true,
      canCreateTasks: true,
      canDelegate: true,
    },
    task: {
      id: 't',
      status: 'OPEN',
      dispatchHold: false,
      runAtDue: true,
      dependenciesReady: true,
      verificationBlock: null,
      hasLiveSession: false,
      assigneeAgentId: 'agent',
      assigneeIsProjectMember: true,
      assigneeEnabled: true,
      agentInFlightTasks: 0,
      agentMaxConcurrentTasks: null,
      failureCount: 0,
      maxAutoRunFailures: MAX_AUTO_RUN_FAILURES,
      failureAttributable: true,
      retryBackoffUntil: null,
      ...task,
    },
    approval: { state: 'NONE', targetIdempotencyKey: null },
  };
}

test('an otherwise dispatchable task with no verification failure is allowed', () => {
  assert.equal(authorizeProjectAction(input()).decision, 'ALLOW');
});

test('V3: a task downstream of a failed check is deferred, not denied and not rewritten', () => {
  const result = authorizeProjectAction(input({ verificationBlock: block() }));
  assert.equal(result.decision, 'DEFER');
  assert.equal(result.reasonCode, 'VERIFICATION_FAILED_UPSTREAM');
});

test('V4: the subject itself is deferred while its defect subtask is outstanding', () => {
  const result = authorizeProjectAction(
    input({ verificationBlock: block({ reason: 'SUBJECT_DEFECT_OPEN', subjectTaskId: 't' }) }),
  );
  assert.equal(result.decision, 'DEFER');
  assert.equal(result.reasonCode, 'VERIFICATION_DEFECT_OPEN');
});

test('V4: prerequisites all DONE is not enough while the failure is unresolved', () => {
  // The case the whole condition row exists for. The subject was reverted, somebody put it back
  // to DONE without re-running the check, and the dependency count is therefore satisfied — if
  // this were left to `dependenciesReady` alone the old FAIL would just have become a PASS.
  const result = authorizeProjectAction(
    input({ dependenciesReady: true, verificationBlock: block() }),
  );
  assert.equal(result.decision, 'DEFER');
  assert.equal(result.reasonCode, 'VERIFICATION_FAILED_UPSTREAM');
});

test('an incomplete dependency with no failed check reports the dependency', () => {
  const result = authorizeProjectAction(input({ dependenciesReady: false }));
  assert.equal(result.reasonCode, 'TASK_DEPENDENCIES_INCOMPLETE');
});

test('when both halves of precondition 3 are true, the verdict is the answer given', () => {
  // A reverted subject is BOTH an outstanding prerequisite and a failed check, and it is that way
  // for every FAIL. "Waiting on a prerequisite" is true and says nothing; "its check failed, here
  // is the defect" is what somebody can act on.
  const result = authorizeProjectAction(
    input({ dependenciesReady: false, verificationBlock: block() }),
  );
  assert.equal(result.reasonCode, 'VERIFICATION_FAILED_UPSTREAM');
});

test('the earlier preconditions still win: a held task reports the hold, not the verdict', () => {
  const result = authorizeProjectAction(
    input({ dispatchHold: true, verificationBlock: block() }),
  );
  assert.equal(result.reasonCode, 'TASK_DISPATCH_HELD');
});

test('a resolved failure is not a block: the guard only ever sees unresolved ones', () => {
  // The service resolves by writing `resolvedAt`, and the guard's read filters on it — so at this
  // layer "resolved" is spelled as the absence of a block, and this asserts nothing else creeps in.
  assert.equal(authorizeProjectAction(input({ verificationBlock: null })).decision, 'ALLOW');
});

test('an audit captured before §13.2 has no block field and is unaffected', () => {
  const legacy = input();
  delete (legacy.task as { verificationBlock?: unknown }).verificationBlock;
  assert.equal(authorizeProjectAction(legacy).decision, 'ALLOW');
});
