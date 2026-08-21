import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorizeProjectAction,
  createProjectAuthorizationAudit,
  PROJECT_POLICY_MATRIX,
  projectPolicyCell,
  replayProjectAuthorizationAudit,
  ProjectActionAuthorizationInput,
  ProjectApprovalState,
  ProjectAuthorizationAction,
  ProjectAutomationPolicyValue,
  ProjectPolicyRowId,
} from './project-authorization.service';
import {
  normalizedCapabilities,
  ProjectRunnerRequirement,
  scheduleProjectRunner,
} from './project-runner-scheduler';
import { MAX_AUTO_RUN_FAILURES } from '../tasks/task-retry-policy';

/**
 * Independent verification of unit 14. Nothing here reuses the fixtures written by units 12 and
 * 13: every input is rebuilt from the exported types so that a change of behaviour in the product
 * shows up as a failing assertion rather than as a fixture that quietly moved with it.
 */

const POLICIES: ProjectAutomationPolicyValue[] = ['MANUAL', 'GUARDED_AUTO', 'AUTO'];
const EVALUATED_AT = '2026-08-20T12:00:00.000Z';

function baseInput(
  overrides: Partial<ProjectActionAuthorizationInput> = {},
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
      ...overrides.project,
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
      ...overrides.principal,
    },
    task: !('task' in overrides) ? {
      id: 't',
      status: 'OPEN',
      dispatchHold: false,
      runAtDue: true,
      dependenciesReady: true,
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
    } : overrides.task,
    approval: { state: 'NONE', targetIdempotencyKey: null, ...overrides.approval },
    ...(overrides.provider ? { provider: overrides.provider } : {}),
    ...(overrides.runner ? { runner: overrides.runner } : {}),
    ...('action' in overrides ? { action: overrides.action as ProjectAuthorizationAction } : {}),
    ...('requiredPermission' in overrides
      ? { requiredPermission: overrides.requiredPermission! }
      : {}),
    ...('idempotencyKey' in overrides ? { idempotencyKey: overrides.idempotencyKey! } : {}),
  };
}

test('every policy row resolves through the frozen matrix for all three strategies', () => {
  const rowIds = PROJECT_POLICY_MATRIX.map((row) => row.id);
  assert.equal(new Set(rowIds).size, rowIds.length, 'policy row ids must be unique');
  for (const row of PROJECT_POLICY_MATRIX) {
    for (const policy of POLICIES) {
      const cell = projectPolicyCell(policy, row.id);
      assert.ok(['ALLOW', 'DENY', 'REQUIRE_APPROVAL'].includes(cell),
        `${row.id}/${policy} must be a closed policy cell`);
      assert.equal(cell, row.cells[policy], 'the lookup must be the table, not a second opinion');
    }
  }
  assert.throws(() => projectPolicyCell('AUTO', 'NOT_A_ROW' as ProjectPolicyRowId),
    /unknown Project policy row/);
});

test('the strategy matrix decides dispatch, routine, acceptance and user-control actions', () => {
  const expected: Array<{
    label: string;
    input: () => ProjectActionAuthorizationInput;
    row: ProjectPolicyRowId;
    // decision + reason per policy, in MANUAL / GUARDED_AUTO / AUTO order
    outcomes: Array<[string, string]>;
  }> = [
    {
      label: 'initial dispatch',
      input: () => baseInput(),
      row: 'DISPATCH_INITIAL',
      outcomes: [
        ['REQUIRE_APPROVAL', 'POLICY_REQUIRES_APPROVAL'],
        ['ALLOW', 'POLICY_ALLOWED'],
        ['ALLOW', 'POLICY_ALLOWED'],
      ],
    },
    {
      label: 'retry after one attributable failure',
      input: () => baseInput({
        task: { ...baseInput().task!, failureCount: 1, retryBackoffUntil: null },
      }),
      row: 'DISPATCH_RETRY',
      outcomes: [
        ['REQUIRE_APPROVAL', 'POLICY_REQUIRES_APPROVAL'],
        ['ALLOW', 'POLICY_ALLOWED'],
        ['ALLOW', 'POLICY_ALLOWED'],
      ],
    },
    {
      label: 'max attempts reached',
      input: () => baseInput({
        task: { ...baseInput().task!, failureCount: MAX_AUTO_RUN_FAILURES },
      }),
      row: 'DISPATCH_MAX_ATTEMPTS',
      outcomes: [
        ['REQUIRE_APPROVAL', 'MAX_ATTEMPTS_REACHED'],
        ['REQUIRE_APPROVAL', 'MAX_ATTEMPTS_REACHED'],
        ['REQUIRE_APPROVAL', 'MAX_ATTEMPTS_REACHED'],
      ],
    },
    {
      label: 'unattributable failure',
      input: () => baseInput({
        task: { ...baseInput().task!, failureCount: 1, failureAttributable: false },
      }),
      row: 'DISPATCH_MAX_ATTEMPTS',
      outcomes: [
        ['REQUIRE_APPROVAL', 'UNKNOWN_FAILURE'],
        ['REQUIRE_APPROVAL', 'UNKNOWN_FAILURE'],
        ['REQUIRE_APPROVAL', 'UNKNOWN_FAILURE'],
      ],
    },
    {
      label: 'project concurrency exhausted',
      input: () => baseInput({
        project: { ...baseInput().project, inFlightTasks: 3, maxConcurrentTasks: 3 },
      }),
      row: 'DISPATCH_OVER_LIMIT',
      outcomes: [
        ['DEFER', 'PROJECT_CONCURRENCY_LIMIT'],
        ['DEFER', 'PROJECT_CONCURRENCY_LIMIT'],
        ['DEFER', 'PROJECT_CONCURRENCY_LIMIT'],
      ],
    },
    {
      label: 'agent concurrency exhausted',
      input: () => baseInput({
        task: { ...baseInput().task!, agentInFlightTasks: 1, agentMaxConcurrentTasks: 1 },
      }),
      row: 'DISPATCH_OVER_LIMIT',
      outcomes: [
        ['DEFER', 'AGENT_CONCURRENCY_LIMIT'],
        ['DEFER', 'AGENT_CONCURRENCY_LIMIT'],
        ['DEFER', 'AGENT_CONCURRENCY_LIMIT'],
      ],
    },
    {
      label: '24h session budget exhausted',
      input: () => baseInput({
        project: {
          ...baseInput().project,
          sessionBudgetPerDay: 2,
          coordinatorSessionsStartedLast24h: 2,
        },
      }),
      row: 'DISPATCH_OVER_LIMIT',
      outcomes: [
        ['DEFER', 'SESSION_BUDGET_EXHAUSTED'],
        ['DEFER', 'SESSION_BUDGET_EXHAUSTED'],
        ['DEFER', 'SESSION_BUDGET_EXHAUSTED'],
      ],
    },
    {
      label: 'coordinator routine turn',
      input: () => baseInput({ action: 'OPEN_COORDINATOR_TURN', task: undefined }),
      row: 'COORDINATOR_ROUTINE',
      outcomes: [
        ['REQUIRE_APPROVAL', 'POLICY_REQUIRES_APPROVAL'],
        ['ALLOW', 'POLICY_ALLOWED'],
        ['ALLOW', 'POLICY_ALLOWED'],
      ],
    },
    {
      label: 'project acceptance',
      input: () => baseInput({ action: 'RUN_PROJECT_ACCEPTANCE', task: undefined }),
      row: 'PROJECT_ACCEPTANCE',
      outcomes: [
        ['REQUIRE_APPROVAL', 'POLICY_REQUIRES_APPROVAL'],
        ['REQUIRE_APPROVAL', 'POLICY_REQUIRES_APPROVAL'],
        ['ALLOW', 'POLICY_ALLOWED'],
      ],
    },
    {
      label: 'always-safe blocker bookkeeping',
      input: () => baseInput({ action: 'RAISE_BLOCKER', task: undefined }),
      row: 'ALWAYS_SAFE',
      outcomes: [
        ['ALLOW', 'POLICY_ALLOWED'],
        ['ALLOW', 'POLICY_ALLOWED'],
        ['ALLOW', 'POLICY_ALLOWED'],
      ],
    },
  ];

  for (const scenario of expected) {
    POLICIES.forEach((policy, index) => {
      const input = scenario.input();
      const result = authorizeProjectAction({
        ...input,
        project: { ...input.project, automationPolicy: policy },
      });
      const [decision, reasonCode] = scenario.outcomes[index];
      assert.equal(result.decision, decision, `${scenario.label}/${policy} decision`);
      assert.equal(result.reasonCode, reasonCode, `${scenario.label}/${policy} reason`);
      assert.equal(result.policyRow, scenario.row, `${scenario.label}/${policy} row`);
    });
  }
});

test('user-control actions are refused under every strategy and never reach the matrix cell', () => {
  const userControl: ProjectAuthorizationAction[] = [
    'SET_PROJECT_DONE', 'DELETE_TASK', 'DELETE_PROJECT', 'CHANGE_ACCEPTANCE_CRITERIA',
    'REASSIGN_TASK',
  ];
  for (const action of userControl) {
    for (const policy of POLICIES) {
      const input = baseInput({ action, task: undefined });
      const result = authorizeProjectAction({
        ...input,
        project: { ...input.project, automationPolicy: policy },
      });
      assert.equal(result.decision, 'DENY', `${action}/${policy}`);
      assert.equal(result.reasonCode, 'USER_CONTROL_REQUIRED');
      assert.equal(result.policyRow, 'USER_CONTROL_ONLY');
      assert.equal(result.risk, 'PROHIBITED');
    }
  }
});

test('principal, ownership and permission gates deny before any policy cell is consulted', () => {
  const cases: Array<[string, Partial<ProjectActionAuthorizationInput>, string]> = [
    ['closed project', { project: { ...baseInput().project, status: 'DONE' } }, 'PROJECT_NOT_OPEN'],
    ['cancelled project',
      { project: { ...baseInput().project, status: 'CANCELLED' } }, 'PROJECT_NOT_OPEN'],
    ['coordinator switched off',
      { project: { ...baseInput().project, coordinatorEnabled: false } }, 'COORDINATOR_DISABLED'],
    ['no coordinator assigned',
      { principal: { ...baseInput().principal, coordinatorAgentId: null } },
      'COORDINATOR_NOT_ASSIGNED'],
    ['principal is not the assigned coordinator',
      { principal: { ...baseInput().principal, agentId: 'other' } }, 'COORDINATOR_NOT_ASSIGNED'],
    ['principal resolved to no agent row',
      { principal: { ...baseInput().principal, agentId: null } }, 'COORDINATOR_NOT_ASSIGNED'],
    ['principal is not a project member',
      { principal: { ...baseInput().principal, memberRole: null } },
      'COORDINATOR_NOT_PROJECT_MEMBER'],
    ['principal is only a plain member',
      { principal: { ...baseInput().principal, memberRole: 'MEMBER' } },
      'COORDINATOR_NOT_PROJECT_MEMBER'],
    ['agent disabled',
      { principal: { ...baseInput().principal, agentEnabled: false } },
      'COORDINATOR_AGENT_DISABLED'],
    ['agent soft-deleted',
      { principal: { ...baseInput().principal, agentDeleted: true } },
      'COORDINATOR_AGENT_DISABLED'],
  ];
  for (const [label, overrides, reasonCode] of cases) {
    for (const policy of POLICIES) {
      const input = { ...baseInput(), ...overrides };
      const result = authorizeProjectAction({
        ...input,
        project: { ...input.project, automationPolicy: policy },
      });
      assert.equal(result.decision, 'DENY', `${label}/${policy}`);
      assert.equal(result.reasonCode, reasonCode, `${label}/${policy}`);
    }
  }

  const createTask = authorizeProjectAction(baseInput({
    action: 'DISPATCH_TASK',
    requiredPermission: 'CREATE_TASK',
    principal: { ...baseInput().principal, canCreateTasks: false },
  }));
  assert.equal(createTask.reasonCode, 'CREATE_TASK_PERMISSION_DENIED');
  const delegate = authorizeProjectAction(baseInput({
    action: 'DISPATCH_TASK',
    requiredPermission: 'DELEGATE',
    principal: { ...baseInput().principal, canDelegate: false },
  }));
  assert.equal(delegate.reasonCode, 'DELEGATE_PERMISSION_DENIED');
  // A permission the action does not require cannot be used to widen it either.
  const unrelated = authorizeProjectAction(baseInput({
    principal: { ...baseInput().principal, canCreateTasks: false, canDelegate: false },
  }));
  assert.equal(unrelated.decision, 'ALLOW');
});

test('task-state gates defer or deny with their own reason before policy and capacity', () => {
  const cases: Array<[string, Partial<NonNullable<ProjectActionAuthorizationInput['task']>>,
    string, string]> = [
    ['missing task status', { status: 'MISSING' }, 'DEFER', 'TASK_NOT_OPEN'],
    ['task already done', { status: 'DONE' }, 'DEFER', 'TASK_NOT_OPEN'],
    ['dispatch held', { dispatchHold: true }, 'DEFER', 'TASK_DISPATCH_HELD'],
    ['scheduled for later', { runAtDue: false }, 'DEFER', 'TASK_NOT_DUE'],
    ['dependencies incomplete', { dependenciesReady: false }, 'DEFER',
      'TASK_DEPENDENCIES_INCOMPLETE'],
    ['already running', { hasLiveSession: true }, 'DEFER', 'TASK_ALREADY_RUNNING'],
    ['no assignee', { assigneeAgentId: null }, 'DENY', 'WHO_UNRESOLVED'],
    ['assignee outside the team', { assigneeIsProjectMember: false }, 'DENY', 'WHO_NOT_IN_TEAM'],
    ['assignee disabled', { assigneeEnabled: false }, 'DENY', 'WHO_DISABLED'],
  ];
  for (const [label, taskOverrides, decision, reasonCode] of cases) {
    for (const policy of POLICIES) {
      const input = baseInput({ task: { ...baseInput().task!, ...taskOverrides } });
      const result = authorizeProjectAction({
        ...input,
        project: { ...input.project, automationPolicy: policy },
      });
      assert.equal(result.decision, decision, `${label}/${policy}`);
      assert.equal(result.reasonCode, reasonCode, `${label}/${policy}`);
    }
  }
  const missing = authorizeProjectAction(baseInput({ task: undefined }));
  assert.equal(missing.decision, 'DENY');
  assert.equal(missing.reasonCode, 'TASK_NOT_OPEN');
});

test('retry backoff defers while it is live and stops deferring once it expires', () => {
  const backoffActive = authorizeProjectAction(baseInput({
    task: {
      ...baseInput().task!,
      failureCount: 1,
      retryBackoffUntil: '2026-08-20T12:05:00.000Z',
    },
  }));
  assert.equal(backoffActive.decision, 'DEFER');
  assert.equal(backoffActive.reasonCode, 'RETRY_BACKOFF_ACTIVE');
  assert.equal(backoffActive.policyRow, 'DISPATCH_RETRY');
  assert.equal(backoffActive.retryAt, '2026-08-20T12:05:00.000Z');

  const expired = authorizeProjectAction(baseInput({
    task: {
      ...baseInput().task!,
      failureCount: 1,
      retryBackoffUntil: '2026-08-20T11:59:59.000Z',
    },
  }));
  assert.equal(expired.decision, 'ALLOW');
  assert.equal(expired.policyRow, 'DISPATCH_RETRY');

  // Backoff never outranks the terminal attempt ceiling: at the cap the high-risk row wins.
  const capped = authorizeProjectAction(baseInput({
    task: {
      ...baseInput().task!,
      failureCount: MAX_AUTO_RUN_FAILURES,
      retryBackoffUntil: '2026-08-20T12:05:00.000Z',
    },
  }));
  assert.equal(capped.decision, 'REQUIRE_APPROVAL');
  assert.equal(capped.reasonCode, 'MAX_ATTEMPTS_REACHED');
  assert.equal(capped.policyRow, 'DISPATCH_MAX_ATTEMPTS');

  // An over-limit project stays over-limit even mid-backoff — capacity is checked after the
  // task gate, so the deferral that surfaces is the one the operator can act on.
  const overLimit = authorizeProjectAction(baseInput({
    project: { ...baseInput().project, inFlightTasks: 5, maxConcurrentTasks: 1 },
    task: { ...baseInput().task!, failureCount: 1, retryBackoffUntil: null },
  }));
  assert.equal(overLimit.reasonCode, 'PROJECT_CONCURRENCY_LIMIT');
});

test('an approval is authority for exactly one action key and expires closed', () => {
  const manual = (approval: {
    state: ProjectApprovalState;
    targetIdempotencyKey: string | null;
  }) => authorizeProjectAction(baseInput({
    project: { ...baseInput().project, automationPolicy: 'MANUAL' },
    approval,
  }));

  const granted = manual({ state: 'APPROVED', targetIdempotencyKey: 'pc:v1:p:dispatch:t:1' });
  assert.equal(granted.decision, 'ALLOW');
  assert.equal(granted.reasonCode, 'APPROVAL_GRANTED');

  for (const target of [null, 'pc:v1:p:dispatch:t:2', 'pc:v1:p:dispatch:other:1', '']) {
    const mismatched = manual({ state: 'APPROVED', targetIdempotencyKey: target });
    assert.equal(mismatched.decision, 'DENY', `approval bound to ${String(target)}`);
    assert.equal(mismatched.reasonCode, 'APPROVAL_TARGET_MISMATCH');
  }

  assert.equal(manual({ state: 'DENIED', targetIdempotencyKey: null }).decision, 'DENY');
  assert.equal(manual({ state: 'DENIED', targetIdempotencyKey: null }).reasonCode,
    'APPROVAL_DENIED');
  // A denial is a denial even when it names this exact action.
  assert.equal(manual({ state: 'DENIED', targetIdempotencyKey: 'pc:v1:p:dispatch:t:1' }).decision,
    'DENY');

  const pending = manual({ state: 'PENDING', targetIdempotencyKey: 'pc:v1:p:dispatch:t:1' });
  assert.equal(pending.decision, 'REQUIRE_APPROVAL');
  assert.equal(pending.reasonCode, 'APPROVAL_PENDING');

  const expired = manual({ state: 'EXPIRED', targetIdempotencyKey: 'pc:v1:p:dispatch:t:1' });
  assert.equal(expired.decision, 'REQUIRE_APPROVAL');
  assert.equal(expired.reasonCode, 'APPROVAL_EXPIRED');

  // An approval cannot buy back a denial or a capacity refusal from an earlier gate.
  const denied = authorizeProjectAction(baseInput({
    project: {
      ...baseInput().project, automationPolicy: 'MANUAL', inFlightTasks: 1, maxConcurrentTasks: 1,
    },
    approval: { state: 'APPROVED', targetIdempotencyKey: 'pc:v1:p:dispatch:t:1' },
  }));
  assert.equal(denied.decision, 'DEFER');
  assert.equal(denied.reasonCode, 'PROJECT_CONCURRENCY_LIMIT');
  const disabledAgent = authorizeProjectAction(baseInput({
    project: { ...baseInput().project, automationPolicy: 'MANUAL' },
    principal: { ...baseInput().principal, agentEnabled: false },
    approval: { state: 'APPROVED', targetIdempotencyKey: 'pc:v1:p:dispatch:t:1' },
  }));
  assert.equal(disabledAgent.reasonCode, 'COORDINATOR_AGENT_DISABLED');
});

test('provider fallback comes only from the Agent order and never from fleet availability', () => {
  const availability = [
    { provider: 'claude', available: true, models: null },
    { provider: 'codex', available: false, models: null },
    { provider: 'kimi', available: true, models: null },
    { provider: 'house-llm', available: true, models: ['house-1'], defaultModel: 'house-1' },
  ];

  // Empty fallback list: an unavailable pin is reported, never silently rerouted to claude/kimi.
  const empty = authorizeProjectAction(baseInput({
    provider: {
      requestedProvider: 'codex',
      requestedModel: null,
      explicitFallbacks: [],
      availability,
    },
  }));
  assert.equal(empty.decision, 'DENY');
  assert.equal(empty.reasonCode, 'PROVIDER_UNAVAILABLE');
  assert.equal(empty.providerResolution?.selectedProvider, null);
  assert.equal(empty.providerResolution?.usedFallback, false);
  assert.deepEqual(empty.providerResolution?.candidatesConsidered, ['codex']);
  assert.deepEqual(empty.providerResolution?.fallbackHops, []);

  // A fallback list of only unavailable providers is still a refusal, not a fleet search.
  const exhausted = authorizeProjectAction(baseInput({
    provider: {
      requestedProvider: 'codex',
      requestedModel: null,
      explicitFallbacks: [{ provider: 'gone' }, { provider: 'also-gone' }],
      availability,
    },
  }));
  assert.equal(exhausted.reasonCode, 'PROVIDER_UNAVAILABLE');
  assert.equal(exhausted.providerResolution?.selectedProvider, null);
  assert.deepEqual(exhausted.providerResolution?.candidatesConsidered,
    ['codex', 'gone', 'also-gone']);

  // The declared order decides, and the first available entry wins — not the healthiest one.
  const ordered = authorizeProjectAction(baseInput({
    provider: {
      requestedProvider: 'codex',
      requestedModel: null,
      explicitFallbacks: [{ provider: 'gone' }, { provider: 'kimi' }, { provider: 'claude' }],
      availability,
    },
  }));
  assert.equal(ordered.decision, 'ALLOW');
  assert.equal(ordered.providerResolution?.selectedProvider, 'kimi');
  assert.equal(ordered.providerResolution?.usedFallback, true);
  assert.deepEqual(ordered.providerResolution?.fallbackHops, [
    { from: 'codex', to: 'kimi', reason: 'PROVIDER_UNAVAILABLE' },
  ]);
  assert.deepEqual(ordered.providerResolution?.candidatesConsidered, ['codex', 'gone', 'kimi']);
  assert.equal(ordered.policyRow, 'DISPATCH_PROVIDER_FALLBACK');

  // A model the fallback provider does not publish is not a match either.
  const modelMismatch = authorizeProjectAction(baseInput({
    provider: {
      requestedProvider: 'codex',
      requestedModel: null,
      explicitFallbacks: [{ provider: 'house-llm', model: 'not-published' }],
      availability,
    },
  }));
  assert.equal(modelMismatch.reasonCode, 'PROVIDER_UNAVAILABLE');
  assert.equal(modelMismatch.providerResolution?.selectedProvider, null);

  // A pin that is available is used as-is and never counts as a fallback hop.
  const pinned = authorizeProjectAction(baseInput({
    provider: {
      requestedProvider: 'house-llm',
      requestedModel: 'house-1',
      explicitFallbacks: [{ provider: 'claude' }],
      availability,
    },
  }));
  assert.equal(pinned.providerResolution?.selectedProvider, 'house-llm');
  assert.equal(pinned.providerResolution?.selectedModel, 'house-1');
  assert.equal(pinned.providerResolution?.usedFallback, false);
  assert.equal(pinned.policyRow, 'DISPATCH_INITIAL');
});

test('a fallback hop is a high-risk row that only AUTO may take without an approval', () => {
  const withFallback = (policy: ProjectAutomationPolicyValue) => authorizeProjectAction(baseInput({
    project: { ...baseInput().project, automationPolicy: policy },
    provider: {
      requestedProvider: 'codex',
      requestedModel: null,
      explicitFallbacks: [{ provider: 'claude' }],
      availability: [
        { provider: 'codex', available: false, models: null },
        { provider: 'claude', available: true, models: null },
      ],
    },
  }));
  const manual = withFallback('MANUAL');
  assert.equal(manual.decision, 'REQUIRE_APPROVAL');
  assert.equal(manual.policyRow, 'DISPATCH_PROVIDER_FALLBACK');
  assert.equal(manual.risk, 'HIGH');
  const guarded = withFallback('GUARDED_AUTO');
  assert.equal(guarded.decision, 'REQUIRE_APPROVAL');
  assert.equal(guarded.policyRow, 'DISPATCH_PROVIDER_FALLBACK');
  const auto = withFallback('AUTO');
  assert.equal(auto.decision, 'ALLOW');
  assert.equal(auto.reasonCode, 'POLICY_ALLOWED');
  assert.equal(auto.providerResolution?.selectedProvider, 'claude');
});

test('runner capability facts defer or deny and never become a provider substitution', () => {
  const offline = authorizeProjectAction(baseInput({
    runner: {
      available: false, capabilitiesReported: true, capabilities: ['runtime:claude'],
      requiredCapabilities: [],
    },
  }));
  assert.equal(offline.decision, 'DEFER');
  assert.equal(offline.reasonCode, 'RUNNER_UNAVAILABLE');

  const unreported = authorizeProjectAction(baseInput({
    runner: {
      available: true, capabilitiesReported: false, capabilities: [],
      requiredCapabilities: ['runtime:codex'],
    },
  }));
  assert.equal(unreported.decision, 'DENY');
  assert.equal(unreported.reasonCode, 'RUNTIME_REQUIREMENT_UNMET');
  assert.deepEqual(unreported.missingCapabilities, ['runtime:codex']);

  const missing = authorizeProjectAction(baseInput({
    runner: {
      available: true, capabilitiesReported: true, capabilities: ['runtime:claude'],
      requiredCapabilities: ['runtime:codex', 'gpu'],
    },
  }));
  assert.equal(missing.reasonCode, 'RUNTIME_REQUIREMENT_UNMET');
  assert.deepEqual(missing.missingCapabilities, ['gpu', 'runtime:codex']);

  // An old runner that reports nothing still satisfies an empty requirement set.
  const legacyRunner = authorizeProjectAction(baseInput({
    runner: {
      available: true, capabilitiesReported: false, capabilities: [], requiredCapabilities: [],
    },
  }));
  assert.equal(legacyRunner.decision, 'ALLOW');
});

test('the runner scheduler is declarative matching with no policy input of any kind', () => {
  const source = scheduleProjectRunner.toString();
  for (const forbidden of [
    'approval', 'budget', 'policy', 'fallback', 'provider', 'concurren', 'coordinator',
    'retryat', 'backoff', 'attempt',
  ]) {
    assert.ok(!source.toLowerCase().includes(forbidden),
      `the scheduler must not reference ${forbidden}`);
  }

  const requirement: ProjectRunnerRequirement = {
    capabilities: ['Runtime:Claude', ' gpu ', 'gpu', ''],
    candidates: [
      {
        workspaceId: 'w-late', runnerId: 'r-late', available: true, capabilitiesReported: true,
        capabilities: ['runtime:claude', 'gpu'], position: 9,
      },
      {
        workspaceId: 'w-early', runnerId: 'r-early', available: true, capabilitiesReported: true,
        capabilities: ['runtime:claude', 'gpu'], position: 1,
      },
    ],
  };
  const resolved = scheduleProjectRunner(requirement);
  assert.equal(resolved.selectedRunnerId, 'r-early', 'position orders the candidate list');
  assert.deepEqual(resolved.requiredCapabilities, ['gpu', 'runtime:claude']);
  assert.equal(resolved.failure, null);
  assert.deepEqual(Object.keys(resolved).sort(),
    ['candidatesConsidered', 'failure', 'requiredCapabilities', 'selectedRunnerId',
      'selectedWorkspaceId', 'v']);

  // Smuggling policy fields into the requirement changes nothing: they are not read.
  const smuggled = scheduleProjectRunner({
    ...requirement,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...({
      automationPolicy: 'AUTO', approval: { state: 'APPROVED' }, sessionBudgetPerDay: 999,
      allow: true, forceRunnerId: 'r-late',
    } as any),
  } as ProjectRunnerRequirement);
  assert.deepEqual(smuggled, resolved);

  const noneAvailable = scheduleProjectRunner({
    capabilities: ['runtime:codex'],
    candidates: [{
      workspaceId: 'w', runnerId: 'r', available: false, capabilitiesReported: true,
      capabilities: ['runtime:codex'],
    }],
  });
  assert.equal(noneAvailable.selectedRunnerId, null);
  assert.deepEqual(noneAvailable.failure, { code: 'NO_MATCHING_RUNNER', retryable: true });

  const empty = scheduleProjectRunner({ capabilities: ['runtime:codex'], candidates: [] });
  assert.equal(empty.selectedRunnerId, null);
  assert.deepEqual(empty.candidatesConsidered, []);
  assert.deepEqual(normalizedCapabilities([' A ', 'a', 'B', '']), ['a', 'b']);
});

test('the audit is replayable and any tampering with request or result fails closed', () => {
  const audit = createProjectAuthorizationAudit(baseInput());
  assert.equal(replayProjectAuthorizationAudit(audit), true);
  assert.equal(audit.result.decision, 'ALLOW');

  const tamperedRequest = JSON.parse(JSON.stringify(audit)) as typeof audit;
  tamperedRequest.request.project.automationPolicy = 'MANUAL';
  assert.equal(replayProjectAuthorizationAudit(tamperedRequest), false);

  const tamperedResult = JSON.parse(JSON.stringify(audit)) as typeof audit;
  tamperedResult.result.decision = 'DENY';
  assert.equal(replayProjectAuthorizationAudit(tamperedResult), false);

  const tamperedHash = JSON.parse(JSON.stringify(audit)) as typeof audit;
  tamperedHash.requestHash = 'f'.repeat(64);
  assert.equal(replayProjectAuthorizationAudit(tamperedHash), false);

  const forgedAllow = JSON.parse(JSON.stringify(
    createProjectAuthorizationAudit(baseInput({
      project: { ...baseInput().project, automationPolicy: 'MANUAL' },
    })),
  )) as typeof audit;
  assert.equal(forgedAllow.result.decision, 'REQUIRE_APPROVAL');
  forgedAllow.result.decision = 'ALLOW';
  forgedAllow.result.reasonCode = 'POLICY_ALLOWED';
  assert.equal(replayProjectAuthorizationAudit(forgedAllow), false,
    'a forged ALLOW must not replay');

  // Key order is not part of the identity; content is.
  const reordered = createProjectAuthorizationAudit(Object.fromEntries(
    Object.entries(audit.request).reverse(),
  ) as ProjectActionAuthorizationInput);
  assert.equal(reordered.requestHash, audit.requestHash);
  assert.deepEqual(reordered.result, audit.result);
});
