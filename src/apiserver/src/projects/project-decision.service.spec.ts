import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base62ToUuid, uuidToBase62 } from '@orbit/shared';
import {
  ProjectDecisionInput,
  canonicalJson,
  hashDecisionInput,
  planProjectDecision,
} from './project-decision.service';
import { createProjectAuthorizationAudit } from './project-authorization.service';

const PROJECT = '00000000-0000-7000-8000-000000001101';
const OWNER = '00000000-0000-7000-8000-000000001102';
const TASK = '00000000-0000-7000-8000-000000001103';
const DECISION = '00000000-0000-7000-8000-000000001104';

function input(overrides: Partial<ProjectDecisionInput['world']> = {}): ProjectDecisionInput {
  const world: ProjectDecisionInput['world'] = {
    project: {
      id: uuidToBase62(PROJECT), ownerId: uuidToBase62(OWNER), title: 'ship', goal: null,
      acceptanceCriteria: null, status: 'OPEN', coordinatorEnabled: true,
      automationPolicy: 'GUARDED_AUTO', maxConcurrentTasks: 3, sessionBudgetPerDay: null,
      configRevision: '7', coordinatorAgentId: null, coordinatorSessionId: null,
      coordinatorWorkspaceId: null,
    },
    runtime: {
      runState: 'PLANNING', fencingToken: '4', coordinatorGeneration: '1',
      nextWakeAt: null, acceptanceAttempt: '0',
    },
    team: [],
    tasks: [{
      id: uuidToBase62(TASK), title: 'work', contentHash: 'a'.repeat(64), status: 'OPEN',
      parentTaskId: null, assigneeAgentId: null, provider: null, model: null,
      autoRunWhenReady: true, dispatchHold: false, runAt: null, verifiesTaskId: null,
      dispatchAuthority: 'COORDINATOR', dispatchAttempt: '0', requiredCapabilities: [],
      dependsOnTaskIds: [], liveSessionIds: [], updatedAt: '2026-08-20T00:00:00.000Z',
      failureCount: 0, lastFailureAt: null, failureAttributable: true, retryBackoffUntil: null,
    }],
    sessions: [], coordinatorSession: null, workspaces: [], runners: [], providers: [],
    actions: [], evidence: { branches: [], tests: [] },
    ...overrides,
  };
  const evaluation = {
    epoch: Date.parse('2026-04-25T00:00:00.000Z') / 1_000,
    dueTasks: { [uuidToBase62(TASK)]: { runAtDue: true, retryBackoffExpired: true } },
  };
  const signals: ProjectDecisionInput['signals'] = [];
  return {
    v: 1,
    readAt: '2026-04-25T00:00:00.000Z',
    decisionInputHash: hashDecisionInput({ world, evaluation, signals }),
    world,
    evaluation,
    signals,
  };
}

test('canonical decision hashing is independent of object insertion order and covers all inputs', () => {
  const a = input();
  const reordered = JSON.parse(JSON.stringify(a)) as ProjectDecisionInput;
  reordered.world.project = Object.fromEntries(
    Object.entries(reordered.world.project).reverse(),
  ) as unknown as ProjectDecisionInput['world']['project'];
  assert.equal(hashDecisionInput(reordered), a.decisionInputHash);
  assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');

  const changed = input({
    project: { ...a.world.project, configRevision: '8' },
  });
  assert.notEqual(changed.decisionInputHash, a.decisionInputHash);

  const signalled = input();
  signalled.signals.push({
    eventId: uuidToBase62('00000000-0000-7000-8000-000000001105'),
    kind: 'user.manual_trigger', dedupeKey: 'manual:one',
  });
  assert.notEqual(hashDecisionInput(signalled), a.decisionInputHash);
});

test('the same frozen input replays to a byte-identical deterministic outcome', () => {
  const frozen = input();
  const options = {
    decisionId: DECISION,
    consumedEventIds: [uuidToBase62('00000000-0000-7000-8000-000000001106')],
  };
  const first = planProjectDecision(frozen, options);
  const replay = planProjectDecision(JSON.parse(JSON.stringify(frozen)), options);
  assert.equal(canonicalJson(replay), canonicalJson(first));
  assert.deepEqual(first, {
    v: 1,
    reconcileId: uuidToBase62(DECISION),
    fencingToken: '4',
    decisionInputHash: frozen.decisionInputHash,
    configRevision: '7',
    runStateBefore: 'PLANNING',
    runStateAfter: 'PLANNING',
    decidedBy: 'ORCHESTRATOR',
    reason: 'planning requires coordinator decision',
    actions: [], authorizations: [], blockersOpened: [], blockersCleared: [],
    nextWakeAt: '2026-04-25T00:01:00.000Z',
    nextWakeReason: 'planning requires coordinator decision',
    consumedEventIds: options.consumedEventIds,
  });
  assert.equal(base62ToUuid(first.reconcileId), DECISION);
});

test('tampered or stale input cannot be planned under its old hash', () => {
  const stale = input();
  stale.world.tasks[0].status = 'DONE';
  assert.throws(() => planProjectDecision(stale, { decisionId: DECISION }), /input hash mismatch/);
});

test('authorization input and output are replayable parts of the durable Decision outcome', () => {
  const frozen = input();
  const authorization = createProjectAuthorizationAudit({
    v: 1,
    sourceDecisionInputHash: frozen.decisionInputHash,
    idempotencyKey: 'pc:v1:project:acceptance:1',
    evaluatedAt: frozen.readAt,
    action: 'RUN_PROJECT_ACCEPTANCE',
    requiredPermission: 'COORDINATE',
    project: {
      id: frozen.world.project.id,
      status: 'OPEN',
      coordinatorEnabled: true,
      automationPolicy: 'GUARDED_AUTO',
      configRevision: frozen.world.project.configRevision,
      inFlightTasks: 0,
      maxConcurrentTasks: 3,
      coordinatorSessionsStartedLast24h: 0,
      sessionBudgetPerDay: null,
    },
    principal: {
      agentId: 'coordinator', coordinatorAgentId: 'coordinator', memberRole: 'COORDINATOR',
      agentEnabled: true, agentDeleted: false, canCoordinate: true,
      canCreateTasks: true, canDelegate: true,
    },
    approval: { state: 'NONE', targetIdempotencyKey: null },
  });
  const planned = planProjectDecision(frozen, { decisionId: DECISION, authorizations: [authorization] });
  assert.equal(planned.authorizations[0].result.decision, 'REQUIRE_APPROVAL');
  assert.equal(planned.authorizations[0].result.reasonCode, 'POLICY_REQUIRES_APPROVAL');

  const tampered = structuredClone(authorization);
  tampered.result.decision = 'ALLOW';
  assert.throws(
    () => planProjectDecision(frozen, { decisionId: DECISION, authorizations: [tampered] }),
    /does not replay/,
  );
});

test('run state is a pure function of the frozen session and verification facts', () => {
  const planning = input();
  const executing = input({
    sessions: [{
      id: uuidToBase62('00000000-0000-7000-8000-000000001107'),
      taskId: uuidToBase62(TASK), workspaceId: null, assignedRunnerId: null,
      runStatus: 'RUNNING', provider: 'codex', model: null, permissionMode: null, effort: null,
      createdAt: '2026-04-25T00:00:00.000Z',
      startedAt: null, finishedAt: null, completedAt: null, deletedAt: null,
    }],
  });
  const verifying = input({
    tasks: [{ ...planning.world.tasks[0], verifiesTaskId: uuidToBase62(TASK) }],
  });
  const settled = input({ project: { ...planning.world.project, status: 'DONE' } });
  assert.equal(planProjectDecision(planning, { decisionId: DECISION }).runStateAfter, 'PLANNING');
  assert.equal(planProjectDecision(executing, { decisionId: DECISION }).runStateAfter, 'EXECUTING');
  assert.equal(planProjectDecision(verifying, { decisionId: DECISION }).runStateAfter, 'AWAITING_VERIFICATION');
  assert.equal(planProjectDecision(settled, { decisionId: DECISION }).runStateAfter, 'SETTLED');
});
