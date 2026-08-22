import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { uuidToBase62 } from '@orbit/shared';
import {
  ProjectDecisionInput,
  canonicalJson,
  hashDecisionInput,
  planProjectDecision,
  publicIdempotencyKey,
} from './project-decision.service';
import { detectProjectBlockerConditions } from './project-blocker-conditions';
import { bare, section, tableRows } from './contract-doc';
import {
  COORDINATOR_ROTATION_REASON_CODE,
  PROJECT_LIVE_SESSION_STATUSES,
  isLiveSessionStatus,
  planCoordinatorSessionRotation,
  rotateCoordinatorSessionIdempotencyKey,
  rotationReasonCode,
  rotationReasonDigest,
} from './project-coordinator-session';

// §7.5 as a pure function of a frozen snapshot. Everything the rotation does downstream is keyed on
// what this decides, so what is asserted here is not "it looks right" but the three properties the
// ledger depends on: the same world always names the same key, a world that has moved names a
// different one, and a snapshot from before this existed decides nothing at all.

const PROJECT = '00000000-0000-7000-8000-000000001901';
const OWNER = '00000000-0000-7000-8000-000000001902';
const AGENT = '00000000-0000-7000-8000-000000001903';
const SESSION = '00000000-0000-7000-8000-000000001904';
const OTHER_WORKSPACE = '00000000-0000-7000-8000-000000001905';
const DECISION = '00000000-0000-7000-8000-000000001906';

type World = ProjectDecisionInput['world'];

/** A project whose coordination run has ENDED, in a landing that can host the next one. */
function input(overrides: Partial<World> = {}): ProjectDecisionInput {
  const base: World = {
    project: {
      id: uuidToBase62(PROJECT), ownerId: uuidToBase62(OWNER), title: 'ship', goal: null,
      acceptanceCriteria: null, status: 'OPEN', coordinatorEnabled: true,
      automationPolicy: 'GUARDED_AUTO', maxConcurrentTasks: 3, sessionBudgetPerDay: null,
      configRevision: '1', coordinatorAgentId: uuidToBase62(AGENT),
      coordinatorSessionId: uuidToBase62(SESSION),
      coordinatorWorkspaceId: uuidToBase62(AGENT),
    },
    runtime: {
      runState: 'PLANNING', fencingToken: '2', coordinatorGeneration: '3',
      coordinatorSessionId: uuidToBase62(SESSION),
      nextWakeAt: null, acceptanceAttempt: '0',
    },
    team: [{
      projectMemberId: uuidToBase62('00000000-0000-7000-8000-000000001907'),
      agentId: uuidToBase62(AGENT), role: 'COORDINATOR', enabled: true, deletedAt: null,
      runnerId: uuidToBase62('00000000-0000-7000-8000-000000001908'), model: null, effort: null,
      providerFallbacks: [], canCreateTasks: true, canDelegate: true, maxConcurrentTasks: null,
    }],
    tasks: [],
    sessions: [],
    coordinatorSession: {
      id: uuidToBase62(SESSION), runStatus: 'SUCCEEDED', workspaceId: uuidToBase62(AGENT),
      assignedRunnerId: uuidToBase62('00000000-0000-7000-8000-000000001908'),
      startedAt: null, finishedAt: null, completedAt: null, deletedAt: null,
    },
    workspaces: [{
      workspaceId: uuidToBase62(AGENT),
      runnerId: uuidToBase62('00000000-0000-7000-8000-000000001908'),
      enabled: true, deletedAt: null, model: null, effort: null, defaultMergeTarget: null,
      workDirExists: true, workDirIsGit: true, workDirProbedAt: null,
    }],
    runners: [], providers: [], actions: [], blockers: [],
    evidence: { branches: [], tests: [] },
    ...overrides,
  };
  const evaluation = { epoch: Date.parse('2026-08-20T00:00:00.000Z') / 1_000, dueTasks: {} };
  const signals: ProjectDecisionInput['signals'] = [];
  return {
    v: 1,
    readAt: '2026-08-20T00:00:00.000Z',
    decisionInputHash: hashDecisionInput({ world: base, evaluation, signals }),
    world: base,
    evaluation,
    signals,
  };
}

test('a run that ended is rotated, in the landing the project already records', () => {
  const frozen = input();
  const plan = planCoordinatorSessionRotation(frozen);
  assert.deepEqual(plan, {
    status: 'ROTATE',
    trigger: 'COORDINATOR_SESSION_ENDED',
    generation: '4',
    fromSessionId: uuidToBase62(SESSION),
    landingWorkspaceId: uuidToBase62(AGENT),
    coordinatorAgentId: uuidToBase62(AGENT),
    reasonDigest: rotationReasonDigest(frozen),
  });
  // §8.2: the epoch is the generation the NEW run will be, and the key names the project by its
  // raw uuid — a permanent key is an internal identity, not a public one.
  assert.equal(
    rotateCoordinatorSessionIdempotencyKey(PROJECT, plan.status === 'ROTATE' ? plan.generation : ''),
    `pc:v1:${PROJECT}:rotate:4`,
  );
});

test('the contract names this rotation key the way the ledger spells it', () => {
  // F-22-04 / BLK-23-01's sibling: §7.3 said `coord-session` while every key ever written said
  // `rotate`, and nothing was wrong enough to fail — the key is permanent and unique either way, so
  // the only cost was that somebody reading the contract to find a historical action would not find
  // it. That is exactly the kind of drift a document nobody executes accumulates, so the document
  // and the builder are compared here instead of trusted to agree.
  //
  // The template is compared with the generation substituted, not by eyeballing the words: it is
  // the WHOLE key that has to match, and the epoch §8.2 GE1 gives this action is `generation + 1`
  // — the generation the run being opened will be, which is what the builder is handed.
  const row = tableRows(section(
    readFileSync(path.resolve(__dirname, '../../../../docs/project-coordinator-contract.md'), 'utf8'),
    '7.3',
  )).find((cells) => bare(cells[0]) === 'ROTATE_COORDINATOR_SESSION');
  assert.ok(row, '§7.3 no longer has a row for ROTATE_COORDINATOR_SESSION');
  assert.equal(
    bare(row[2]).replace('<projectId>', PROJECT).replace('<generation+1>', '4'),
    rotateCoordinatorSessionIdempotencyKey(PROJECT, '4'),
    'the contract states a key template no writer produces',
  );
});

test('every way a run stops naming a usable conversation is its own trigger', () => {
  const cases: Array<[Partial<World>, string]> = [
    [{}, 'COORDINATOR_SESSION_ENDED'],
    [{
      coordinatorSession: { ...input().world.coordinatorSession!, runStatus: 'CANCELLED' },
    }, 'COORDINATOR_SESSION_ENDED'],
    [{
      coordinatorSession: { ...input().world.coordinatorSession!, runStatus: 'FAILED' },
    }, 'COORDINATOR_SESSION_FAILED'],
    [{
      coordinatorSession: {
        ...input().world.coordinatorSession!,
        runStatus: 'RUNNING',
        deletedAt: '2026-08-20T00:00:00.000Z',
      },
    }, 'COORDINATOR_SESSION_DELETED'],
    [{ coordinatorSession: null }, 'COORDINATOR_SESSION_MISSING'],
  ];
  for (const [world, trigger] of cases) {
    const plan = planCoordinatorSessionRotation(input(world));
    assert.equal(plan.status, 'ROTATE', trigger);
    assert.equal(plan.status === 'ROTATE' && plan.trigger, trigger);
  }

  const cleared = input({
    project: { ...input().world.project, coordinatorSessionId: null },
    coordinatorSession: null,
  });
  const plan = planCoordinatorSessionRotation(cleared);
  assert.equal(plan.status === 'ROTATE' && plan.trigger, 'NO_COORDINATOR_SESSION');
});

test('a run that is still going — including one somebody paused — is never rotated away', () => {
  for (const runStatus of PROJECT_LIVE_SESSION_STATUSES) {
    const plan = planCoordinatorSessionRotation(input({
      coordinatorSession: { ...input().world.coordinatorSession!, runStatus },
    }));
    assert.deepEqual(plan, { status: 'HEALTHY', sessionId: uuidToBase62(SESSION) }, runStatus);
    assert.ok(isLiveSessionStatus(runStatus));
  }
  assert.equal(isLiveSessionStatus('SUCCEEDED'), false);
});

test('§7.5 does not move a coordinator: an unusable landing is a blocker, not another workspace', () => {
  const disabled = input({
    workspaces: [{ ...input().world.workspaces[0], enabled: false }],
  });
  assert.deepEqual(planCoordinatorSessionRotation(disabled), {
    status: 'UNAVAILABLE',
    trigger: 'COORDINATOR_SESSION_ENDED',
    reason: 'COORDINATION_WORKSPACE_UNAVAILABLE',
    fromSessionId: uuidToBase62(SESSION),
    landingWorkspaceId: uuidToBase62(AGENT),
  });

  // The landing was hard-deleted out from under the project (the FK's SET NULL). There is another
  // workspace on the team, and it is NOT an answer — picking it would be the silent migration §7.5
  // exists to forbid.
  const homeless = input({
    project: { ...input().world.project, coordinatorWorkspaceId: null },
    workspaces: [{ ...input().world.workspaces[0], workspaceId: uuidToBase62(OTHER_WORKSPACE) }],
  });
  assert.deepEqual(planCoordinatorSessionRotation(homeless), {
    status: 'UNAVAILABLE',
    trigger: 'COORDINATOR_SESSION_ENDED',
    reason: 'COORDINATION_WORKSPACE_MISSING',
    fromSessionId: uuidToBase62(SESSION),
    landingWorkspaceId: null,
  });
});

test('an unusable coordinator identity refuses the rotation rather than opening a run it may not use', () => {
  const notSeated = planCoordinatorSessionRotation(input({ team: [] }));
  assert.equal(notSeated.status === 'UNAVAILABLE' && notSeated.reason, 'COORDINATOR_NOT_IN_TEAM');

  const disabled = planCoordinatorSessionRotation(input({
    team: [{ ...input().world.team[0], enabled: false }],
  }));
  assert.equal(disabled.status === 'UNAVAILABLE' && disabled.reason, 'COORDINATOR_AGENT_DISABLED');

  const unassigned = planCoordinatorSessionRotation(input({
    project: { ...input().world.project, coordinatorAgentId: null },
  }));
  assert.equal(unassigned.status === 'UNAVAILABLE' && unassigned.reason, 'COORDINATOR_NOT_ASSIGNED');
});

test('a project nobody is running, and one nobody has set up, are both left alone', () => {
  for (const world of [
    { project: { ...input().world.project, status: 'DONE' as const } },
    { project: { ...input().world.project, coordinatorEnabled: false } },
  ]) {
    assert.deepEqual(planCoordinatorSessionRotation(input(world)), { status: 'OUT_OF_LOOP' });
  }

  // Never bound, never counted, no landing and no seat: a project that has not been set up is not
  // a broken one, and §7.4 answers it where it bites — by refusing the first dispatch.
  const fresh = input({
    project: {
      ...input().world.project,
      coordinatorAgentId: null, coordinatorSessionId: null, coordinatorWorkspaceId: null,
    },
    runtime: { ...input().world.runtime, coordinatorGeneration: '0', coordinatorSessionId: null },
    team: [],
    coordinatorSession: null,
  });
  assert.deepEqual(planCoordinatorSessionRotation(fresh), { status: 'UNBOUND' });
});

test('a snapshot captured before migration 0126 decides nothing, and replays to what it decided', () => {
  const legacy = input();
  delete (legacy.world.runtime as { coordinatorSessionId?: string | null }).coordinatorSessionId;
  legacy.decisionInputHash = hashDecisionInput(legacy);
  assert.deepEqual(planCoordinatorSessionRotation(legacy), { status: 'UNSUPPORTED' });

  const outcome = planProjectDecision(legacy, { decisionId: DECISION });
  assert.equal('coordinator' in outcome, false);
  assert.deepEqual(outcome.actions, []);
  // Nothing about §7.5 reached the blocker face either: the same world with the baseline present
  // is the one that raises the row.
  assert.deepEqual(
    detectProjectBlockerConditions(legacy, {
      aggregationCycleTaskIds: [], aggregationCompletionGaps: [],
      verificationVerdicts: [],
      coordinatorSession: planCoordinatorSessionRotation(legacy),
    }).filter((condition) => condition.kind === 'COORDINATOR_UNAVAILABLE'),
    [],
  );
});

test('the rotation a snapshot plans is the action its decision proposes, byte for byte on replay', () => {
  const frozen = input();
  const outcome = planProjectDecision(frozen, { decisionId: DECISION });
  // The audit spells every id in Base62 (§6.2); the ledger keeps the same key with the raw uuid
  // (§8.2). `publicIdempotencyKey` is the one translation, and it is what the applier compares on.
  assert.deepEqual(outcome.actions, [{
    type: 'ROTATE_COORDINATOR_SESSION',
    idempotencyKey: `pc:v1:${uuidToBase62(PROJECT)}:rotate:4`,
    subject: { type: 'PROJECT', id: uuidToBase62(PROJECT) },
  }]);
  assert.equal(
    publicIdempotencyKey(rotateCoordinatorSessionIdempotencyKey(PROJECT, '4')),
    outcome.actions[0].idempotencyKey,
  );
  assert.equal(outcome.coordinator?.status, 'ROTATE');
  const replay = planProjectDecision(JSON.parse(JSON.stringify(frozen)), {
    decisionId: DECISION,
    actions: outcome.actions,
  });
  assert.equal(canonicalJson(replay), canonicalJson(outcome));

  // §8.2 GE2's test, written as the contract writes it: move the world from A to B and back, and
  // the key must not return to the one it had. A rotation's epoch is a generation, and a generation
  // only goes up — so the second time this project's run ends, its key is a different key.
  const rotated = input({
    project: { ...frozen.world.project, coordinatorSessionId: uuidToBase62(OTHER_WORKSPACE) },
    runtime: {
      ...frozen.world.runtime,
      coordinatorGeneration: '4',
      coordinatorSessionId: uuidToBase62(OTHER_WORKSPACE),
    },
    coordinatorSession: {
      ...frozen.world.coordinatorSession!,
      id: uuidToBase62(OTHER_WORKSPACE),
      runStatus: 'SUCCEEDED',
    },
  });
  const next = planProjectDecision(rotated, { decisionId: DECISION });
  assert.deepEqual(next.actions[0].idempotencyKey, `pc:v1:${uuidToBase62(PROJECT)}:rotate:5`);
});

test('a rotation that cannot happen is a COORDINATOR_UNAVAILABLE the owner can act on', () => {
  const homeless = input({
    project: { ...input().world.project, coordinatorWorkspaceId: null },
    workspaces: [],
  });
  const conditions = detectProjectBlockerConditions(homeless, {
    aggregationCycleTaskIds: [], aggregationCompletionGaps: [],
    verificationVerdicts: [],
    coordinatorSession: planCoordinatorSessionRotation(homeless),
  }).filter((condition) => condition.kind === 'COORDINATOR_UNAVAILABLE');
  assert.equal(conditions.length, 1);
  assert.deepEqual(conditions[0].facts, { reason: 'COORDINATION_WORKSPACE_MISSING' });
  assert.equal(
    (conditions[0].detail as { rotationTrigger?: string }).rotationTrigger,
    'COORDINATOR_SESSION_ENDED',
  );

  // A seat that is broken keeps naming the seat. Both refusals share a kind and a subject, so the
  // dedupe key would otherwise depend on which question was asked first.
  const both = input({
    project: { ...input().world.project, coordinatorWorkspaceId: null },
    team: [{ ...input().world.team[0], enabled: false }],
    workspaces: [],
  });
  const seat = detectProjectBlockerConditions(both, {
    aggregationCycleTaskIds: [], aggregationCompletionGaps: [],
    verificationVerdicts: [],
    coordinatorSession: planCoordinatorSessionRotation(both),
  }).filter((condition) => condition.kind === 'COORDINATOR_UNAVAILABLE');
  assert.deepEqual(seat[0].facts, { reason: 'COORDINATOR_AGENT_DISABLED' });
});

test('F22: an unacknowledged dead letter is a condition the recomputation keeps observing', () => {
  // The wiring assertion for §5.4 F22: the delivery path opens the row, and THIS is what stops the
  // very next healthy pass from clearing it. A detector that was written but never added to the
  // list would leave the blocker to be resolved by §11.4 on the project's behalf, and automatic
  // dispatch would resume as though the lost signal had been handled.
  const lost = input({
    deadLetters: [{
      eventId: uuidToBase62('00000000-0000-7000-8000-0000000019f1'),
      kind: 'task.updated',
      dedupeKey: 'task.updated:pcc24',
      attempts: 10,
    }],
  });
  const conditions = detectProjectBlockerConditions(lost, {
    aggregationCycleTaskIds: [], aggregationCompletionGaps: [],
    verificationVerdicts: [],
    coordinatorSession: planCoordinatorSessionRotation(lost),
  }).filter((condition) => condition.kind === 'UNKNOWN_FAILURE');
  assert.equal(conditions.length, 1);
  assert.equal(conditions[0].subjectType, 'PROJECT');
  assert.equal(conditions[0].subjectId, uuidToBase62(PROJECT));

  // …and a project that has lost nothing says nothing, so the row cannot be raised by the mere
  // existence of the detector.
  assert.deepEqual(
    detectProjectBlockerConditions(input(), {
      aggregationCycleTaskIds: [], aggregationCompletionGaps: [],
      verificationVerdicts: [],
      coordinatorSession: planCoordinatorSessionRotation(input()),
    }).filter((condition) => condition.kind === 'UNKNOWN_FAILURE'),
    [],
  );
});

test('a healthy coordinator raises nothing and proposes nothing', () => {
  const healthy = input({
    coordinatorSession: { ...input().world.coordinatorSession!, runStatus: 'RUNNING' },
  });
  const outcome = planProjectDecision(healthy, { decisionId: DECISION });
  assert.deepEqual(outcome.actions, []);
  assert.deepEqual(outcome.coordinator, { status: 'HEALTHY', sessionId: uuidToBase62(SESSION) });
  assert.deepEqual(outcome.blockersOpened, []);
});

// ── §7.6 TR3 · a second look at the same world is not another run ──────────────────────────────

/** A world where the previous rotation was applied on `digest`, and its run has since ended. */
function afterRotation(digest: string, overrides: Partial<World> = {}): ProjectDecisionInput {
  const base = input(overrides).world;
  return input({
    ...overrides,
    runtime: { ...base.runtime, coordinatorGeneration: '4' },
    actions: [{
      actionId: uuidToBase62('00000000-0000-7000-8000-000000001909'),
      type: 'ROTATE_COORDINATOR_SESSION',
      status: 'APPLIED',
      subjectType: 'PROJECT',
      subjectId: uuidToBase62(PROJECT),
      decisionId: uuidToBase62(DECISION),
      resultSessionId: uuidToBase62(SESSION),
      refusalCode: null,
      reasonCode: rotationReasonCode(digest),
      idempotencyKeyHash: 'b'.repeat(64),
      detailHash: 'c'.repeat(64),
      createdAt: '2026-08-19T00:00:00.000Z',
    }],
  });
}

test('a run opened on these very facts, now ended without changing them, opens no second run', () => {
  const digest = rotationReasonDigest(input());
  const world = afterRotation(digest);
  assert.equal(rotationReasonDigest(world), digest, 'the ledger row is not itself a fact');
  const plan = planCoordinatorSessionRotation(world);
  assert.deepEqual(plan, {
    status: 'NO_PROGRESS',
    trigger: 'COORDINATOR_SESSION_ENDED',
    reasonDigest: digest,
    lastRunSessionId: uuidToBase62(SESSION),
    fromSessionId: uuidToBase62(SESSION),
  });

  // And it is a row with a name on it, not silence.
  const outcome = planProjectDecision(world, { decisionId: DECISION });
  assert.deepEqual(outcome.actions, [], 'a project that made no progress starts no run');
  const conditions = detectProjectBlockerConditions(world, {
    aggregationCycleTaskIds: [], aggregationCompletionGaps: [],
    verificationVerdicts: [],
    coordinatorSession: plan,
  }).filter((condition) => condition.kind === 'COORDINATOR_NO_PROGRESS');
  assert.equal(conditions.length, 1);
  assert.deepEqual(conditions[0].facts, { reasonDigest: digest });
  assert.equal(conditions[0].subjectType, 'PROJECT');
});

test('a world that moved earns a new run; how the last one died does not', () => {
  const digest = rotationReasonDigest(input());

  // Same facts, a different way of dying. TR3 still holds — otherwise a crash loop could alternate
  // ENDED/FAILED forever and never be anybody's problem.
  const crashed = afterRotation(digest, {
    coordinatorSession: { ...input().world.coordinatorSession!, runStatus: 'FAILED' },
  });
  assert.equal(planCoordinatorSessionRotation(crashed).status, 'NO_PROGRESS');

  // A task finished while the last run was going. That IS progress, and the next run is allowed.
  const moved = afterRotation(digest, {
    tasks: [{
      id: uuidToBase62('00000000-0000-7000-8000-00000000190a'), title: 'work',
      contentHash: 'a'.repeat(64), status: 'DONE', parentTaskId: null, assigneeAgentId: null,
      provider: null, model: null, autoRunWhenReady: true, dispatchHold: false,
      dispatchAuthority: 'COORDINATOR', dispatchAttempt: '0', requiredCapabilities: [],
      runAt: null, verifiesTaskId: null, dependsOnTaskIds: [], liveSessionIds: [],
      failureCount: 0, lastFailureAt: null, failureAttributable: true, retryBackoffUntil: null,
      updatedAt: '2026-08-20T00:00:00.000Z',
    }],
  });
  assert.notEqual(rotationReasonDigest(moved), digest);
  const plan = planCoordinatorSessionRotation(moved);
  assert.equal(plan.status, 'ROTATE');
  assert.equal(plan.status === 'ROTATE' && plan.generation, '5', 'the epoch follows the generation');
});

test('the no-progress row is not an input to the rule that raises it', () => {
  const digest = rotationReasonDigest(input());
  // The blocker this decision opens would otherwise change the world it was decided from: next pass
  // computes a different digest, the condition goes false, the row clears, and the loop rotates
  // again — a two-pass cycle that never converges. Its kind is excluded from the digest for that
  // reason, so the answer is stable across the pass that raises it.
  const withRow = afterRotation(digest, {
    blockers: [{
      id: uuidToBase62('00000000-0000-7000-8000-00000000190b'),
      kind: 'COORDINATOR_NO_PROGRESS', owner: 'USER', recovery: 'HUMAN', severity: 'CRITICAL',
      requiredAction: 'take it from here', subjectType: 'PROJECT', subjectId: uuidToBase62(PROJECT),
      dedupeKey: `COORDINATOR_NO_PROGRESS:PROJECT:${uuidToBase62(PROJECT)}`,
      lifecycleGeneration: '1', conditionVersion: 'd'.repeat(64),
      firstSeenAt: '2026-08-20T00:00:00.000Z', lastSeenAt: '2026-08-20T00:00:00.000Z',
      nextCheckAt: '2026-08-20T00:05:00.000Z', occurrences: 1, escalatedAt: null,
    }],
  });
  assert.equal(rotationReasonDigest(withRow), digest);
  assert.equal(planCoordinatorSessionRotation(withRow).status, 'NO_PROGRESS');

  // Any OTHER blocker is a fact about the world, and a new episode of one is new information.
  const other = afterRotation(digest, {
    blockers: [{
      id: uuidToBase62('00000000-0000-7000-8000-00000000190c'),
      kind: 'MERGE_CONFLICT', owner: 'COORDINATOR', recovery: 'EVENT', severity: 'WARNING',
      requiredAction: 'resolve', subjectType: 'SESSION', subjectId: uuidToBase62(SESSION),
      dedupeKey: `MERGE_CONFLICT:SESSION:${uuidToBase62(SESSION)}`,
      lifecycleGeneration: '2', conditionVersion: 'e'.repeat(64),
      firstSeenAt: '2026-08-20T00:00:00.000Z', lastSeenAt: '2026-08-20T00:00:00.000Z',
      nextCheckAt: '2026-08-20T00:05:00.000Z', occurrences: 1, escalatedAt: null,
    }],
  });
  assert.notEqual(rotationReasonDigest(other), digest);
  assert.equal(planCoordinatorSessionRotation(other).status, 'ROTATE');
});

test('the rotation reason code carries its digest, and reads back through the prefix', () => {
  const digest = rotationReasonDigest(input());
  assert.equal(rotationReasonCode(digest), `${COORDINATOR_ROTATION_REASON_CODE}:${digest}`);
  assert.match(digest, /^[0-9a-f]{64}$/);
  // A ledger row from a binary that wrote no digest is read as "no comparable previous run" rather
  // than as a match, so an old row can never manufacture a COORDINATOR_NO_PROGRESS.
  const legacy = afterRotation(digest);
  legacy.world.actions[0].reasonCode = 'POLICY_ALLOWED';
  legacy.decisionInputHash = hashDecisionInput(legacy);
  assert.equal(planCoordinatorSessionRotation(legacy).status, 'ROTATE');
});
