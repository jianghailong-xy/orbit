import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { after, before } from 'node:test';

const require = createRequire(import.meta.url);
const repo = path.resolve(import.meta.dirname, '..');
const apiDist = path.join(repo, 'src/apiserver/dist');
const url = process.env.AUTO_DISPATCH_PG_URL;
const expectedDatabase = process.env.AUTO_DISPATCH_PG_EXPECTED_DATABASE;
const expectedUser = process.env.AUTO_DISPATCH_PG_EXPECTED_USER;
const expectedSystemIdentifier = process.env.AUTO_DISPATCH_PG_EXPECTED_SYSTEM_IDENTIFIER;
const evidencePath = process.env.AUTO_DISPATCH_EVIDENCE_PATH;
const targetSha = process.env.AUTO_DISPATCH_TARGET_SHA;
const fixtureDisposable = process.env.AUTO_DISPATCH_FIXTURE_DISPOSABLE;

assert.ok(url, 'AUTO_DISPATCH_PG_URL is required; PostgreSQL may not be skipped');
assert.ok(expectedDatabase, 'AUTO_DISPATCH_PG_EXPECTED_DATABASE is required');
assert.ok(expectedUser, 'AUTO_DISPATCH_PG_EXPECTED_USER is required');
assert.match(expectedSystemIdentifier ?? '', /^[0-9]+$/);
assert.ok(evidencePath, 'AUTO_DISPATCH_EVIDENCE_PATH is required');
assert.match(targetSha ?? '', /^[0-9a-f]{40}$/);
assert.equal(fixtureDisposable, 'true', 'the PostgreSQL fixture must be explicitly disposable');
assert.match(expectedDatabase, /^orbit_auto_dispatch_[a-z0-9_]+$/);

const { Pool } = require('pg');
const { prismaClientFor } = require(path.join(apiDist, 'prisma/prisma-client.js'));
const { SessionsService } = require(path.join(apiDist, 'sessions/sessions.service.js'));
const { TasksService } = require(path.join(apiDist, 'tasks/tasks.service.js'));
const { RunnerApiController } = require(path.join(apiDist, 'runner-api/runner-api.controller.js'));
const {
  CreatorType,
  ProjectAutomationPolicy,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} = require(path.join(repo, 'src/apiserver/node_modules/@prisma/client'));

const db = prismaClientFor(url);
const pool = new Pool({ connectionString: url, max: 12 });
const IMMEDIATE_WINDOW_MS = 5_000;
const SWEEP_WINDOW_MS = 8_000;
const ACTIVE_STATUSES = [
  RunStatus.PENDING,
  RunStatus.RUNNING,
  RunStatus.AWAITING_INPUT,
  RunStatus.INTERRUPTED,
];
const evidence = {
  schemaVersion: 1,
  suite: 'outcome-reconciler-auto-dispatch',
  targetSha,
  postgres: {
    required: true,
    connected: false,
    version: null,
    systemIdentifier: null,
    database: null,
    user: null,
    migrations: Number(process.env.AUTO_DISPATCH_MIGRATION_COUNT ?? 0),
    lastMigration: process.env.AUTO_DISPATCH_LAST_MIGRATION ?? null,
    requiredMigrationApplied:
      process.env.AUTO_DISPATCH_REQUIRED_MIGRATION_APPLIED === '1',
  },
  observationWindow: {
    startedAt: process.env.AUTO_DISPATCH_STARTED_AT ?? new Date().toISOString(),
    finishedAt: null,
    immediate: { declaredMaximumMilliseconds: IMMEDIATE_WINDOW_MS, measuredMilliseconds: null },
    periodicSweep: {
      productionCadenceMilliseconds: 60_000,
      declaredTestDeliveryMaximumMilliseconds: SWEEP_WINDOW_MS,
      measuredMilliseconds: null,
    },
  },
  samples: {
    immediate: 0,
    sweepRecovery: 0,
    rollingV1Replay: 0,
    concurrentDeliveries: 0,
    policyRefusal: 0,
    admissionRefusal: 0,
    readyInvariant: 0,
  },
  coverage: {
    immediateExactlyOne: false,
    sweepRecoversLostTrigger: false,
    rollingV1ReplayIdempotent: false,
    concurrentTriggerSweepExactlyOne: false,
    typedPolicyObligation: false,
    persistentPolicyWakeup: false,
    typedAdmissionObligation: false,
    dispatchAttemptObservable: false,
    availableReadyNeverSilent: false,
    noManualProductionStart: true,
    productionWrites: false,
  },
  results: {
    immediate: null,
    sweepRecovery: null,
    rollingV1Replay: null,
    concurrentDelivery: null,
    policyRefusal: null,
    capacityRefusal: null,
  },
};

function realtime() {
  return new Proxy({}, {
    get: (_target, property) => property === 'waitForInbox'
      ? async () => undefined
      : () => undefined,
  });
}

const live = realtime();
const queue = { notifySessionQueued() {} };
const sessions = new SessionsService(db, queue, live);
const tasks = new TasksService(db, sessions, live);

function runnerApi() {
  return new RunnerApiController(
    db,
    queue,
    live,
    {},
    {},
    {},
    { appendFor: async (_tx, _sessionId, content) => content },
    undefined,
    undefined,
    undefined,
    tasks,
  );
}

before(async () => {
  const identity = (await pool.query(`
    SELECT current_database() AS database, current_user AS "user",
           current_setting('server_version') AS version,
           (SELECT system_identifier::text FROM pg_control_system()) AS "systemIdentifier"
  `)).rows[0];
  assert.equal(identity.database, expectedDatabase);
  assert.equal(identity.user, expectedUser);
  assert.equal(identity.systemIdentifier, expectedSystemIdentifier);
  assert.match(identity.version, /^1[6-9]\./, 'PostgreSQL 16+ is required');
  assert.ok(evidence.postgres.migrations > 0, 'zero applied migrations is forbidden');
  assert.equal(evidence.postgres.requiredMigrationApplied, true,
    'the automatic-dispatch migration was not applied exactly once');
  assert.match(evidence.postgres.lastMigration, /^\d{4}_[a-z0-9_]+$/,
    'the full migration frontier was not recorded');
  Object.assign(evidence.postgres, {
    connected: true,
    version: identity.version,
    systemIdentifier: identity.systemIdentifier,
    database: identity.database,
    user: identity.user,
  });
});

after(async () => {
  evidence.observationWindow.finishedAt = new Date().toISOString();
  await db.$disconnect();
  await pool.end();
  mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
});

async function makeWorld(label, { runnerMax = 4 } = {}) {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@auto-dispatch.invalid`,
      name: label,
      passwordHash: 'fixture-only',
    },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: `${label}-runner`,
      tokenHash: `fixture-${runnerId}`,
      status: RunnerStatus.ONLINE,
      maxConcurrent: runnerMax,
      lastHeartbeatAt: new Date(),
      capabilities: [],
      capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({
    data: {
      id: workspaceId,
      ownerId,
      runnerId,
      name: `${label}-workspace`,
      enabled: true,
    },
  });
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `${label}-project`,
      status: 'OPEN',
      coordinatorEnabled: true,
      automationPolicy: ProjectAutomationPolicy.GUARDED_AUTO,
      maxConcurrentTasks: 3,
      sessionBudgetPerDay: null,
    },
  });
  return { ownerId, runnerId, workspaceId, projectId };
}

function taskData(world, id, title, extra = {}) {
  return {
    id,
    ownerId: world.ownerId,
    projectId: world.projectId,
    assigneeId: world.workspaceId,
    title,
    creatorType: CreatorType.USER,
    creatorId: world.ownerId,
    provider: 'claude',
    status: TaskStatus.OPEN,
    ...extra,
  };
}

async function releasedFixture(label, options = {}) {
  const world = await makeWorld(label, options);
  const predecessorId = randomUUID();
  const taskId = randomUUID();
  await db.task.create({ data: taskData(world, predecessorId, `${label}-predecessor`) });
  await db.task.create({
    data: taskData(world, taskId, `${label}-successor`, { autoRunWhenReady: true }),
  });
  await db.taskDependency.create({ data: { taskId, dependsOnTaskId: predecessorId } });
  if (options.aggregateParent) {
    await db.task.create({
      data: taskData(world, randomUUID(), `${label}-child`, { parentTaskId: taskId }),
    });
    await db.task.update({
      where: { id: taskId },
      data: { completionPolicy: 'ALL_CHILDREN_DONE' },
    });
  }
  const authority = await db.task.findUniqueOrThrow({
    where: { id: taskId },
    select: { dispatchAuthority: true },
  });
  assert.equal(authority.dispatchAuthority, 'COORDINATOR');
  return { ...world, predecessorId, taskId };
}

/**
 * Fault-injection boundary used only on the disposable database. It models the committed status
 * and epoch writes while intentionally dropping the in-process completion callback.
 */
async function completeDependency(fixture) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query(
      `UPDATE task SET status = 'DONE'::task_status WHERE id = $1::uuid`,
      [fixture.predecessorId],
    );
    await client.query(
      `UPDATE task_dispatch_epoch SET epoch = epoch + 1 WHERE task_id = $1::uuid`,
      [fixture.taskId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const epoch = await db.taskDispatchEpoch.findUniqueOrThrow({ where: { taskId: fixture.taskId } });
  return epoch.epoch;
}

async function sweep() {
  return tasks.reconcileReadyTasks();
}

async function counts(taskId) {
  const [total, active, task, state] = await Promise.all([
    db.session.count({ where: { taskId } }),
    db.session.count({ where: { taskId, status: { in: ACTIVE_STATUSES } } }),
    db.task.findUniqueOrThrow({
      where: { id: taskId },
      select: { dispatchAttempt: true, autoRunWhenReady: true, status: true },
    }),
    db.taskAutoDispatchState.findFirst({ where: { taskId }, orderBy: { watermark: 'desc' } }),
  ]);
  return { total, active, task, state };
}

function assertExactlyOneDispatch(snapshot) {
  assert.equal(snapshot.total, 1, 'one dependency transition must create exactly one Session');
  assert.equal(snapshot.active, 1, 'the one Session must own the active task-work claim');
  assert.equal(snapshot.task.dispatchAttempt, 1n, 'one watermark spends one dispatchAttempt');
  assert.equal(snapshot.state?.state, 'RESOLVED');
  assert.equal(snapshot.state?.outcome, 'DISPATCHED');
  assert.ok(snapshot.state?.sessionId);
}

test('requires an isolated PostgreSQL frontier with the auto-dispatch migration', async () => {
  assert.equal(evidence.postgres.connected, true);
  const row = (await pool.query(`
    SELECT to_regclass('task_auto_dispatch_state') IS NOT NULL AS state,
           to_regprocedure('task_auto_dispatch_record(uuid,uuid,bigint,text,text,text,jsonb,text,text,uuid,timestamp with time zone)') IS NOT NULL AS recorder,
           to_regprocedure('task_auto_dispatch_reconcile_sessions()') IS NOT NULL AS reconciler
  `)).rows[0];
  assert.deepEqual(row, { state: true, recorder: true, reconciler: true });
});

test('dependency completion immediate trigger commits exactly one Session inside the declared window', async () => {
  const fixture = await releasedFixture('immediate');
  await completeDependency(fixture);
  const started = Date.now();
  await tasks.dispatchDependentsAfterCompletion(fixture.ownerId, fixture.predecessorId);
  const measured = Date.now() - started;
  assert.ok(measured <= IMMEDIATE_WINDOW_MS, `immediate dispatch took ${measured}ms`);
  const snapshot = await counts(fixture.taskId);
  assertExactlyOneDispatch(snapshot);
  evidence.results.immediate = {
    activeSessions: snapshot.active,
    totalSessions: snapshot.total,
    dispatchAttempt: Number(snapshot.task.dispatchAttempt),
  };
  evidence.observationWindow.immediate.measuredMilliseconds = measured;
  evidence.samples.immediate += 1;
  evidence.coverage.immediateExactlyOne = true;
  evidence.coverage.dispatchAttemptObservable = true;
});

test('the periodic READY sweep recovers a deliberately lost completion trigger', async () => {
  const fixture = await releasedFixture('lost-trigger');
  await completeDependency(fixture);
  const before = await counts(fixture.taskId);
  assert.deepEqual(
    { sessions: before.total, attempts: before.task.dispatchAttempt },
    { sessions: 0, attempts: 0n },
    'fault fixture did not actually drop the immediate delivery',
  );
  const started = Date.now();
  await sweep();
  const measured = Date.now() - started;
  assert.ok(measured <= SWEEP_WINDOW_MS, `one delivered periodic sweep took ${measured}ms`);
  const snapshot = await counts(fixture.taskId);
  assertExactlyOneDispatch(snapshot);
  evidence.results.sweepRecovery = {
    activeSessions: snapshot.active,
    totalSessions: snapshot.total,
    dispatchAttempt: Number(snapshot.task.dispatchAttempt),
  };
  evidence.observationWindow.periodicSweep.measuredMilliseconds = measured;
  evidence.samples.sweepRecovery += 1;
  evidence.coverage.sweepRecoversLostTrigger = true;
});

async function rollingV1Fixture(label) {
  const world = await makeWorld(label);
  const predecessor = await tasks.create(world.ownerId, {
    projectId: world.projectId,
    title: `${label}-executable-predecessor`,
    assigneeId: world.workspaceId,
    completionCriterion: 'EXECUTABLE',
    acceptanceCriteria: 'The declared command exits zero.',
    acceptanceCommand: 'true',
    acceptanceExpectedExitCode: 0,
  });
  const taskId = randomUUID();
  await db.task.create({
    data: taskData(world, taskId, `${label}-successor`, { autoRunWhenReady: true }),
  });
  await db.taskDependency.create({ data: { taskId, dependsOnTaskId: predecessor.id } });
  const sessionId = randomUUID();
  const messageTurnId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId,
      ownerId: world.ownerId,
      creatorId: world.ownerId,
      taskId: predecessor.id,
      workspaceId: world.workspaceId,
      assignedRunnerId: world.runnerId,
      title: `${label}-work`,
      prompt: 'finish and run acceptance',
      provider: 'claude',
      status: RunStatus.RUNNING,
      engineTurnActive: true,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
    },
  });
  await db.conversationTurn.create({
    data: {
      id: messageTurnId,
      sessionId,
      seq: 1,
      clientTurnId: `message:${messageTurnId}`,
      kind: 'message',
      content: 'finish',
      status: 'IN_FLIGHT',
    },
  });
  return {
    ...world,
    predecessorId: predecessor.id,
    taskId,
    sessionId,
    messageTurnId,
  };
}

test('rolling-upgrade v1 shell replay releases one successor and stays idempotent', async () => {
  const fixture = await rollingV1Fixture('rolling-v1');
  const api = runnerApi();
  await api.turnComplete({ id: fixture.runnerId }, fixture.sessionId, {
    turnId: fixture.messageTurnId,
    status: RunStatus.SUCCEEDED,
  });
  const delivery = await api.dequeueTurn(
    fixture.sessionId,
    fixture.runnerId,
    null,
    false,
    [],
    null,
  );
  assert.equal(delivery.taskAcceptance, true);
  assert.equal(delivery.acceptancePlan, undefined, 'fixture must exercise the rolling v1 lane');
  const callback = {
    turnId: delivery.turnId,
    status: RunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: 0,
    shellOutput: '8 tests\n8 pass\n0 fail\n0 skipped\n',
  };
  const first = await api.turnComplete(
    { id: fixture.runnerId },
    fixture.sessionId,
    callback,
  );
  assert.equal(first.ok, true);
  const firstSnapshot = await counts(fixture.taskId);
  assertExactlyOneDispatch(firstSnapshot);
  const replay = await api.turnComplete(
    { id: fixture.runnerId },
    fixture.sessionId,
    callback,
  );
  assert.equal(replay.ok, true);
  const replaySnapshot = await counts(fixture.taskId);
  assertExactlyOneDispatch(replaySnapshot);
  assert.equal(
    await db.taskJudgmentRequest.count({ where: { taskId: fixture.predecessorId } }),
    1,
  );
  evidence.samples.rollingV1Replay += 1;
  evidence.coverage.rollingV1ReplayIdempotent = true;
  evidence.results.rollingV1Replay = {
    firstActiveSessions: firstSnapshot.active,
    replayActiveSessions: replaySnapshot.active,
    firstDispatchAttempt: Number(firstSnapshot.task.dispatchAttempt),
    replayDispatchAttempt: Number(replaySnapshot.task.dispatchAttempt),
    judgmentRequests: 1,
  };
});

test('concurrent immediate trigger and periodic sweep cannot create two active Sessions', async () => {
  const fixture = await releasedFixture('concurrent');
  await completeDependency(fixture);
  await Promise.all([
    tasks.dispatchDependentsAfterCompletion(fixture.ownerId, fixture.predecessorId),
    sweep(),
  ]);
  const snapshot = await counts(fixture.taskId);
  assertExactlyOneDispatch(snapshot);
  assert.equal(
    await db.taskRunRequest.count({ where: { ownerId: fixture.ownerId } }),
    1,
    'both deliveries must share one idempotent run request',
  );
  evidence.samples.concurrentDeliveries += 2;
  evidence.coverage.concurrentTriggerSweepExactlyOne = true;
  evidence.results.concurrentDelivery = {
    deliveredSignals: 2,
    activeSessions: snapshot.active,
    totalSessions: snapshot.total,
    runRequests: 1,
  };
});

test('policy refusal exposes a revision/watermark-bound obligation and persistent wakeup', async () => {
  // The refusal used to be "this project has no Owner Ratification". That gate is gone: automatic
  // dispatch no longer waits for an approval. What this test is actually about survives it — a
  // typed refusal is a durable, watermark-bound obligation with a persistent wake, never a silent
  // READY — so it is now taken against a refusal that still exists: a task whose completion is
  // owned by aggregating its subtasks has no work of its own to start.
  const fixture = await releasedFixture('policy-refusal', { aggregateParent: true });
  const watermark = await completeDependency(fixture);
  await tasks.dispatchDependentsAfterCompletion(fixture.ownerId, fixture.predecessorId);
  const blocked = await tasks.get(fixture.ownerId, fixture.taskId);
  assert.equal(blocked.dependencyState, 'READY');
  assert.equal(blocked.blocked, true);
  assert.equal(await db.session.count({ where: { taskId: fixture.taskId } }), 0);
  assert.equal(blocked.dispatchAttempt, 1n);
  assert.equal(blocked.controlPlaneObligations.length, 1);
  const [obligation] = blocked.controlPlaneObligations;
  assert.equal(obligation.factKind, 'AUTO_DISPATCH_BLOCKED');
  assert.equal(obligation.reasonCode, 'AGGREGATE_PARENT_HAS_NO_DIRECT_WORK');
  assert.equal(obligation.owner, 'AGENT');
  assert.equal(obligation.nextAction, 'RUN_OR_REPAIR_CHILD_TASKS');
  assert.equal(obligation.evaluatedThroughWatermark, watermark.toString());
  assert.match(obligation.taskRevision, /^[1-9][0-9]*$/);
  assert.match(obligation.obligationId, /^[0-9a-f]{64}$/);
  assert.match(obligation.obligationRevision, /^[0-9a-f]{64}$/);
  assert.match(obligation.bindingDigest, /^[0-9a-f]{64}$/);
  assert.equal(obligation.wakeup?.state, 'PENDING');
  assert.match(obligation.wakeup?.wakeupId ?? '', /^[0-9a-f-]{36}$/);

  // The only mutation here is the condition that caused the refusal, plus a disposable-clock
  // advance. No manual task start is used: the persistent wake is delivered to the ordinary
  // periodic sweep.
  await db.task.update({
    where: { id: fixture.taskId },
    data: { completionPolicy: 'MANUAL' },
  });
  await pool.query(
    `UPDATE task_auto_dispatch_wakeup
        SET due_at = clock_timestamp() - interval '1 second'
      WHERE task_id = $1::uuid AND state = 'PENDING'`,
    [fixture.taskId],
  );
  await sweep();
  assertExactlyOneDispatch(await counts(fixture.taskId));
  assert.equal(
    await db.taskAutoDispatchWakeup.count({
      where: { taskId: fixture.taskId, state: 'PENDING' },
    }),
    0,
  );
  evidence.samples.policyRefusal += 1;
  evidence.coverage.typedPolicyObligation = true;
  evidence.coverage.persistentPolicyWakeup = true;
  evidence.results.policyRefusal = {
    reasonCode: obligation.reasonCode,
    dispatchAttempt: Number(blocked.dispatchAttempt),
    canonicalObligations: blocked.controlPlaneObligations.length,
    wakeupStateBeforeRecovery: obligation.wakeup?.state,
    activeSessionsAfterWakeup: (await counts(fixture.taskId)).active,
  };
});

test('capacity admission refusal records a typed reason, attempt and durable next delivery', async () => {
  const fixture = await releasedFixture('capacity-refusal', { runnerMax: 1 });
  const occupyingTaskId = randomUUID();
  await db.task.create({
    data: taskData(fixture, occupyingTaskId, 'capacity-refusal-occupier'),
  });
  await db.session.create({
    data: {
      id: randomUUID(),
      ownerId: fixture.ownerId,
      creatorId: fixture.ownerId,
      taskId: occupyingTaskId,
      workspaceId: fixture.workspaceId,
      assignedRunnerId: fixture.runnerId,
      title: 'capacity fixture',
      prompt: 'occupy the only materialisation slot',
      provider: 'claude',
      status: RunStatus.PENDING,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
    },
  });
  const watermark = await completeDependency(fixture);
  await sweep();
  const snapshot = await counts(fixture.taskId);
  assert.equal(snapshot.total, 0);
  assert.equal(snapshot.task.dispatchAttempt, 1n);
  const blocked = await tasks.get(fixture.ownerId, fixture.taskId);
  assert.equal(blocked.dependencyState, 'READY');
  const [obligation] = blocked.controlPlaneObligations;
  assert.equal(obligation.reasonCode, 'RUNNER_OR_LIST_CAPACITY_EXHAUSTED');
  assert.equal(obligation.owner, 'SYSTEM');
  assert.equal(obligation.nextAction, 'RETRY_AFTER_A_TASK_WORK_SLOT_IS_RELEASED');
  assert.equal(obligation.evaluatedThroughWatermark, watermark.toString());
  assert.equal(obligation.wakeup?.state, 'PENDING');
  evidence.samples.admissionRefusal += 1;
  evidence.coverage.typedAdmissionObligation = true;
  evidence.results.capacityRefusal = {
    reasonCode: obligation.reasonCode,
    dispatchAttempt: Number(snapshot.task.dispatchAttempt),
    canonicalObligations: blocked.controlPlaneObligations.length,
    wakeupState: obligation.wakeup?.state,
    activeSessions: snapshot.active,
  };
});

test('READY automatic work with available assignee, runner, budget and capacity is never silent', async () => {
  const fixture = await releasedFixture('ready-invariant', { runnerMax: 3 });
  await completeDependency(fixture);
  const eligibleBefore = (await pool.query(`
    SELECT count(*)::integer AS count
      FROM task t
      JOIN workspace w ON w.id = t.assignee_id AND w.enabled = true
      JOIN runner r ON r.id = w.runner_id AND r.status = 'ONLINE'::runner_status
      JOIN project p ON p.id = t.project_id
      JOIN project_completion_contract c ON c.project_id = p.id
     WHERE t.id = $1::uuid
       AND t.status = 'OPEN'::task_status
       AND t.auto_run_when_ready = true
       AND t.dispatch_hold = false
       AND p.status = 'OPEN'::project_status
       AND p.coordinator_enabled = true
       AND p.session_budget_per_day IS NULL
       AND c.contract_digest IS NOT NULL
       AND EXISTS (SELECT 1 FROM task_dependency d WHERE d.task_id = t.id)
       AND NOT EXISTS (
         SELECT 1 FROM task_dependency d JOIN task prerequisite ON prerequisite.id = d.depends_on_task_id
          WHERE d.task_id = t.id AND prerequisite.status <> 'DONE'::task_status
       )
       AND (SELECT count(*) FROM session s
             WHERE s.assigned_runner_id = r.id AND s.status IN ('PENDING','RUNNING'))
           < r.max_concurrent
       AND (SELECT count(*) FROM session s JOIN task pt ON pt.id = s.task_id
             WHERE pt.project_id = p.id AND s.status IN ('PENDING','RUNNING'))
           < p.max_concurrent_tasks
       AND NOT EXISTS (SELECT 1 FROM session s WHERE s.task_id = t.id)
       AND t.dispatch_attempt = 0
       AND NOT EXISTS (
         SELECT 1 FROM task_auto_dispatch_state state
          WHERE state.task_id = t.id AND state.state = 'ACTIVE'
       )
  `, [fixture.taskId])).rows[0].count;
  assert.equal(eligibleBefore, 1, 'the invariant fixture did not establish the forbidden state');
  await sweep();
  assertExactlyOneDispatch(await counts(fixture.taskId));

  const forbiddenAfter = (await pool.query(`
    SELECT count(*)::integer AS count
      FROM task t
      JOIN workspace w ON w.id = t.assignee_id AND w.enabled = true
      JOIN runner r ON r.id = w.runner_id AND r.status = 'ONLINE'::runner_status
      JOIN project p ON p.id = t.project_id
      JOIN project_completion_contract c ON c.project_id = p.id
     WHERE t.status = 'OPEN'::task_status AND t.auto_run_when_ready = true
       AND t.dispatch_hold = false AND p.status = 'OPEN'::project_status
       AND p.session_budget_per_day IS NULL
       AND c.contract_digest IS NOT NULL
       AND EXISTS (SELECT 1 FROM task_dependency d WHERE d.task_id = t.id)
       AND NOT EXISTS (
         SELECT 1 FROM task_dependency d JOIN task prerequisite ON prerequisite.id = d.depends_on_task_id
          WHERE d.task_id = t.id AND prerequisite.status <> 'DONE'::task_status
       )
       AND (SELECT count(*) FROM session s
             WHERE s.assigned_runner_id = r.id AND s.status IN ('PENDING','RUNNING'))
           < r.max_concurrent
       AND (SELECT count(*) FROM session s JOIN task pt ON pt.id = s.task_id
             WHERE pt.project_id = p.id AND s.status IN ('PENDING','RUNNING'))
           < p.max_concurrent_tasks
       AND NOT EXISTS (SELECT 1 FROM session s WHERE s.task_id = t.id)
       AND t.dispatch_attempt = 0
       AND NOT EXISTS (
         SELECT 1 FROM task_auto_dispatch_state state
          WHERE state.task_id = t.id AND state.state = 'ACTIVE'
       )
  `)).rows[0].count;
  assert.equal(forbiddenAfter, 0, 'an eligible READY task remained session/attempt/reason silent');
  evidence.samples.readyInvariant += eligibleBefore;
  evidence.coverage.availableReadyNeverSilent = true;
});
