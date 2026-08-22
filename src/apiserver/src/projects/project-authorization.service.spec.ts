import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PROJECT_POLICY_MATRIX,
  ProjectActionAuthorizationInput,
  ProjectAutomationPolicyValue,
  ProjectPolicyRowId,
  authorizeProjectAction,
  createProjectAuthorizationAudit,
  projectPolicyCell,
  replayProjectAuthorizationAudit,
} from './project-authorization.service';

const POLICIES: ProjectAutomationPolicyValue[] = ['MANUAL', 'GUARDED_AUTO', 'AUTO'];

function request(
  policy: ProjectAutomationPolicyValue = 'GUARDED_AUTO',
  overrides: Partial<ProjectActionAuthorizationInput> = {},
): ProjectActionAuthorizationInput {
  return {
    v: 1,
    sourceDecisionInputHash: 'a'.repeat(64),
    idempotencyKey: 'pc:v1:project:dispatch:task:1',
    evaluatedAt: '2026-08-20T08:00:00.000Z',
    action: 'DISPATCH_TASK',
    requiredPermission: 'COORDINATE',
    project: {
      id: 'project', status: 'OPEN', coordinatorEnabled: true, automationPolicy: policy,
      configRevision: '7', inFlightTasks: 0, maxConcurrentTasks: 3,
      coordinatorSessionsStartedLast24h: 0, sessionBudgetPerDay: 20,
    },
    principal: {
      agentId: 'coordinator', coordinatorAgentId: 'coordinator', memberRole: 'COORDINATOR',
      agentEnabled: true, agentDeleted: false, canCoordinate: true,
      canCreateTasks: true, canDelegate: true,
    },
    task: {
      id: 'task', status: 'OPEN', dispatchHold: false, runAtDue: true,
      dependenciesReady: true, hasLiveSession: false, assigneeAgentId: 'member',
      assigneeIsProjectMember: true, assigneeEnabled: true, agentInFlightTasks: 0,
      agentMaxConcurrentTasks: 2, failureCount: 0, maxAutoRunFailures: 5,
      failureAttributable: true, retryBackoffUntil: null,
    },
    approval: { state: 'NONE', targetIdempotencyKey: null },
    provider: {
      requestedProvider: 'kimi', requestedModel: 'k2', explicitFallbacks: [],
      availability: [{ provider: 'kimi', available: true, models: ['k2'] }],
    },
    runner: {
      available: true, capabilitiesReported: true,
      capabilities: ['linux', 'docker'], requiredCapabilities: ['linux'],
    },
    ...overrides,
  };
}

test('the policy matrix is closed and every policy cell is table-driven', () => {
  const expected = new Map<ProjectPolicyRowId, string>([
    ['ALWAYS_SAFE', 'ALLOW/ALLOW/ALLOW'],
    ['DISPATCH_INITIAL', 'REQUIRE_APPROVAL/ALLOW/ALLOW'],
    ['DISPATCH_RETRY', 'REQUIRE_APPROVAL/ALLOW/ALLOW'],
    ['DISPATCH_MAX_ATTEMPTS', 'REQUIRE_APPROVAL/REQUIRE_APPROVAL/REQUIRE_APPROVAL'],
    ['DISPATCH_OVER_LIMIT', 'DENY/DENY/DENY'],
    ['DISPATCH_PROVIDER_FALLBACK', 'REQUIRE_APPROVAL/REQUIRE_APPROVAL/ALLOW'],
    ['COORDINATOR_ROUTINE', 'REQUIRE_APPROVAL/ALLOW/ALLOW'],
    ['PROJECT_ACCEPTANCE', 'REQUIRE_APPROVAL/REQUIRE_APPROVAL/ALLOW'],
    ['USER_CONTROL_ONLY', 'DENY/DENY/DENY'],
  ]);
  assert.equal(PROJECT_POLICY_MATRIX.length, expected.size);
  for (const row of PROJECT_POLICY_MATRIX) {
    assert.equal(POLICIES.map((policy) => projectPolicyCell(policy, row.id)).join('/'), expected.get(row.id));
  }
});

test('policy, permission, state, concurrency, budget, retry and approval gates are exhaustive tables', () => {
  const cases: Array<{
    name: string;
    input: ProjectActionAuthorizationInput;
    decision: string;
    reason: string;
  }> = [
    ...POLICIES.map((policy) => ({
      name: `${policy} safe audit`,
      input: request(policy, { action: 'RAISE_BLOCKER', task: undefined, provider: undefined, runner: undefined }),
      decision: 'ALLOW', reason: 'POLICY_ALLOWED',
    })),
    { name: 'manual initial dispatch', input: request('MANUAL'), decision: 'REQUIRE_APPROVAL', reason: 'POLICY_REQUIRES_APPROVAL' },
    { name: 'guarded initial dispatch', input: request(), decision: 'ALLOW', reason: 'POLICY_ALLOWED' },
    { name: 'auto initial dispatch', input: request('AUTO'), decision: 'ALLOW', reason: 'POLICY_ALLOWED' },
    { name: 'project closed', input: request('AUTO', { project: { ...request().project, status: 'DONE', automationPolicy: 'AUTO' } }), decision: 'DENY', reason: 'PROJECT_NOT_OPEN' },
    { name: 'coordinator disabled', input: request('AUTO', { project: { ...request().project, coordinatorEnabled: false, automationPolicy: 'AUTO' } }), decision: 'DENY', reason: 'COORDINATOR_DISABLED' },
    { name: 'wrong coordinator', input: request('AUTO', { principal: { ...request().principal, agentId: 'other' } }), decision: 'DENY', reason: 'COORDINATOR_NOT_ASSIGNED' },
    { name: 'not a member', input: request('AUTO', { principal: { ...request().principal, memberRole: null } }), decision: 'DENY', reason: 'COORDINATOR_NOT_PROJECT_MEMBER' },
    { name: 'disabled agent', input: request('AUTO', { principal: { ...request().principal, agentEnabled: false } }), decision: 'DENY', reason: 'COORDINATOR_AGENT_DISABLED' },
    { name: 'create denied', input: request('AUTO', { action: 'APPLY_VERIFICATION_VERDICT', task: undefined, provider: undefined, runner: undefined, requiredPermission: 'CREATE_TASK', principal: { ...request().principal, canCreateTasks: false } }), decision: 'DENY', reason: 'CREATE_TASK_PERMISSION_DENIED' },
    { name: 'delegate denied', input: request('AUTO', { requiredPermission: 'DELEGATE', principal: { ...request().principal, canDelegate: false } }), decision: 'DENY', reason: 'DELEGATE_PERMISSION_DENIED' },
    { name: 'task held', input: request('AUTO', { task: { ...request().task!, dispatchHold: true } }), decision: 'DEFER', reason: 'TASK_DISPATCH_HELD' },
    { name: 'dependencies', input: request('AUTO', { task: { ...request().task!, dependenciesReady: false } }), decision: 'DEFER', reason: 'TASK_DEPENDENCIES_INCOMPLETE' },
    { name: 'already running', input: request('AUTO', { task: { ...request().task!, hasLiveSession: true } }), decision: 'DEFER', reason: 'TASK_ALREADY_RUNNING' },
    { name: 'no assignee', input: request('AUTO', { task: { ...request().task!, assigneeAgentId: null } }), decision: 'DENY', reason: 'WHO_UNRESOLVED' },
    { name: 'assignee outside team', input: request('AUTO', { task: { ...request().task!, assigneeIsProjectMember: false } }), decision: 'DENY', reason: 'WHO_NOT_IN_TEAM' },
    { name: 'assignee disabled', input: request('AUTO', { task: { ...request().task!, assigneeEnabled: false } }), decision: 'DENY', reason: 'WHO_DISABLED' },
    { name: 'retry waiting', input: request('AUTO', { task: { ...request().task!, failureCount: 1, retryBackoffUntil: '2026-08-20T08:01:00.000Z' } }), decision: 'DEFER', reason: 'RETRY_BACKOFF_ACTIVE' },
    { name: 'retry due', input: request('AUTO', { task: { ...request().task!, failureCount: 1, retryBackoffUntil: '2026-08-20T07:59:00.000Z' } }), decision: 'ALLOW', reason: 'POLICY_ALLOWED' },
    { name: 'max attempts', input: request('AUTO', { task: { ...request().task!, failureCount: 5 } }), decision: 'REQUIRE_APPROVAL', reason: 'MAX_ATTEMPTS_REACHED' },
    { name: 'unknown failure', input: request('AUTO', { task: { ...request().task!, failureCount: 1, failureAttributable: false } }), decision: 'REQUIRE_APPROVAL', reason: 'UNKNOWN_FAILURE' },
    { name: 'project concurrency', input: request('AUTO', { project: { ...request().project, automationPolicy: 'AUTO', inFlightTasks: 3 } }), decision: 'DEFER', reason: 'PROJECT_CONCURRENCY_LIMIT' },
    { name: 'agent concurrency', input: request('AUTO', { task: { ...request().task!, agentInFlightTasks: 2 } }), decision: 'DEFER', reason: 'AGENT_CONCURRENCY_LIMIT' },
    { name: 'daily budget', input: request('AUTO', { project: { ...request().project, automationPolicy: 'AUTO', coordinatorSessionsStartedLast24h: 20 } }), decision: 'DEFER', reason: 'SESSION_BUDGET_EXHAUSTED' },
    { name: 'runner offline', input: request('AUTO', { runner: { ...request().runner!, available: false } }), decision: 'DEFER', reason: 'RUNNER_UNAVAILABLE' },
    { name: 'runner lacks capability', input: request('AUTO', { runner: { ...request().runner!, requiredCapabilities: ['macos'] } }), decision: 'DENY', reason: 'RUNTIME_REQUIREMENT_UNMET' },
    { name: 'provider no fallback', input: request('AUTO', { provider: { ...request().provider!, availability: [{ provider: 'kimi', available: false }] } }), decision: 'DENY', reason: 'PROVIDER_UNAVAILABLE' },
    { name: 'acceptance guarded', input: request('GUARDED_AUTO', { action: 'RUN_PROJECT_ACCEPTANCE', task: undefined, provider: undefined, runner: undefined }), decision: 'REQUIRE_APPROVAL', reason: 'POLICY_REQUIRES_APPROVAL' },
    { name: 'acceptance auto', input: request('AUTO', { action: 'RUN_PROJECT_ACCEPTANCE', task: undefined, provider: undefined, runner: undefined }), decision: 'ALLOW', reason: 'POLICY_ALLOWED' },
    { name: 'done is user controlled', input: request('AUTO', { action: 'SET_PROJECT_DONE', task: undefined, provider: undefined, runner: undefined }), decision: 'DENY', reason: 'USER_CONTROL_REQUIRED' },
  ];
  for (const item of cases) {
    const got = authorizeProjectAction(item.input);
    assert.equal(got.decision, item.decision, item.name);
    assert.equal(got.reasonCode, item.reason, item.name);
  }
});

test('fallback is selected only from the Agent order, gated by policy, approval-bound and replayable', () => {
  const fallback = {
    requestedProvider: 'kimi', requestedModel: 'k2',
    explicitFallbacks: [{ provider: 'missing' }, { provider: 'codex', model: 'gpt-5.6-sol' }],
    availability: [
      { provider: 'kimi', available: false },
      { provider: 'missing', available: false },
      { provider: 'codex', available: true, models: ['gpt-5.6-sol'] },
      { provider: 'claude', available: true },
    ],
  };
  for (const [policy, expected] of [
    ['MANUAL', 'REQUIRE_APPROVAL'],
    ['GUARDED_AUTO', 'REQUIRE_APPROVAL'],
    ['AUTO', 'ALLOW'],
  ] as const) {
    const got = authorizeProjectAction(request(policy, { provider: fallback }));
    assert.equal(got.decision, expected, policy);
    assert.equal(got.policyRow, 'DISPATCH_PROVIDER_FALLBACK');
    assert.deepEqual(got.providerResolution?.candidatesConsidered, ['kimi', 'missing', 'codex']);
    assert.equal(got.providerResolution?.selectedProvider, 'codex');
    assert.equal(got.providerResolution?.selectedModel, 'gpt-5.6-sol');
    assert.deepEqual(got.providerResolution?.fallbackHops, [
      { from: 'kimi', to: 'codex', reason: 'PROVIDER_UNAVAILABLE' },
    ]);
    assert.equal(got.providerResolution?.candidatesConsidered.includes('claude'), false,
      'fleet availability is not an implicit fallback list');
  }

  const pending = request('GUARDED_AUTO', {
    provider: fallback,
    approval: { state: 'PENDING', targetIdempotencyKey: 'pc:v1:project:dispatch:task:1' },
  });
  assert.equal(authorizeProjectAction(pending).reasonCode, 'APPROVAL_PENDING');
  const approved = {
    ...pending,
    approval: { state: 'APPROVED' as const, targetIdempotencyKey: pending.idempotencyKey },
  };
  assert.equal(authorizeProjectAction(approved).decision, 'ALLOW');
  assert.equal(authorizeProjectAction(approved).reasonCode, 'APPROVAL_GRANTED');
  const wrongTarget = {
    ...approved,
    approval: { state: 'APPROVED' as const, targetIdempotencyKey: 'another-action' },
  };
  assert.equal(authorizeProjectAction(wrongTarget).reasonCode, 'APPROVAL_TARGET_MISMATCH');
  const unbound = {
    ...approved,
    approval: { state: 'APPROVED' as const, targetIdempotencyKey: null },
  };
  assert.equal(authorizeProjectAction(unbound).reasonCode, 'APPROVAL_TARGET_MISMATCH');
  const denied = {
    ...pending,
    approval: { state: 'DENIED' as const, targetIdempotencyKey: pending.idempotencyKey },
  };
  assert.equal(authorizeProjectAction(denied).reasonCode, 'APPROVAL_DENIED');
  const expired = {
    ...pending,
    approval: { state: 'EXPIRED' as const, targetIdempotencyKey: pending.idempotencyKey },
  };
  assert.equal(authorizeProjectAction(expired).reasonCode, 'APPROVAL_EXPIRED');

  const cappedDespiteApproval = {
    ...approved,
    project: { ...approved.project, inFlightTasks: approved.project.maxConcurrentTasks },
  };
  assert.equal(authorizeProjectAction(cappedDespiteApproval).reasonCode,
    'PROJECT_CONCURRENCY_LIMIT');
  const unavailableDespiteApproval = {
    ...approved,
    provider: { ...fallback, explicitFallbacks: [], availability: [] },
  };
  assert.equal(authorizeProjectAction(unavailableDespiteApproval).reasonCode,
    'PROVIDER_UNAVAILABLE');

  const audit = createProjectAuthorizationAudit(approved);
  assert.equal(replayProjectAuthorizationAudit(audit), true);
  const tampered = structuredClone(audit);
  tampered.result.decision = 'DENY';
  assert.equal(replayProjectAuthorizationAudit(tampered), false);
});

// ---------------------------------------------------------------------------------------------
// §13.1 AG6 — the commit-point half, and the wire code it is carried on.
// ---------------------------------------------------------------------------------------------

test('§13.1 AG6: the commit gate DENIES a plan whose task became an aggregate parent', () => {
  for (const policy of ['ALL_CHILDREN_DONE', 'VERIFICATION_PASSED'] as const) {
    // The race this exists for: §7.8's pass chose this task from a snapshot in which it had no
    // children (or a MANUAL policy), and by the time the transaction runs it has both.
    const stale = request('GUARDED_AUTO', {
      task: {
        ...request().task!,
        aggregateParent: { completionPolicy: policy, hasDirectChildren: true },
      },
    });
    const result = authorizeProjectAction(stale);
    assert.equal(result.decision, 'DENY', `${policy}: a role is not a condition that lifts`);
    assert.equal(result.reasonCode, 'TASK_AGGREGATE_PARENT');
  }
});

test('§13.1 AG6: the commit gate answers the role BEFORE the failure ladder', () => {
  // A FAILED aggregate parent must not be classified as a retry — `DISPATCH_MAX_ATTEMPTS` would
  // answer `MAX_ATTEMPTS_REACHED` (a TEST_FAILED blocker) about a task that was never work.
  const failed = request('GUARDED_AUTO', {
    task: {
      ...request().task!,
      status: 'FAILED',
      failureCount: 9,
      failureAttributable: false,
      aggregateParent: { completionPolicy: 'ALL_CHILDREN_DONE', hasDirectChildren: true },
    },
  });
  const result = authorizeProjectAction(failed);
  assert.equal(result.reasonCode, 'TASK_AGGREGATE_PARENT');
  assert.notEqual(result.reasonCode, 'UNKNOWN_FAILURE');
});

test('§13.1 AG6: the three compatibility boundaries still reach ALLOW at the commit point', () => {
  const boundaries: Array<[string, { completionPolicy: 'MANUAL' | 'ALL_CHILDREN_DONE'; hasDirectChildren: boolean }]> = [
    ['childless non-MANUAL', { completionPolicy: 'ALL_CHILDREN_DONE', hasDirectChildren: false }],
    ['MANUAL parent with children', { completionPolicy: 'MANUAL', hasDirectChildren: true }],
    ['MANUAL, no children', { completionPolicy: 'MANUAL', hasDirectChildren: false }],
  ];
  for (const [name, aggregateParent] of boundaries) {
    const result = authorizeProjectAction(request('GUARDED_AUTO', {
      task: { ...request().task!, aggregateParent },
    }));
    assert.equal(result.decision, 'ALLOW', `${name} must still be admitted`);
  }
});

test('§13.1 AG6: an audit captured before the facts existed reads as "not an aggregate parent"', () => {
  // Absent means the caller did not supply them, which is what an audit from before AG6 meant —
  // and it must replay to what it originally produced rather than to today's rules.
  const old = request('GUARDED_AUTO', { task: { ...request().task!, aggregateParent: undefined } });
  assert.equal(authorizeProjectAction(old).decision, 'ALLOW');
  assert.equal(replayProjectAuthorizationAudit(createProjectAuthorizationAudit(old)), true);
});
