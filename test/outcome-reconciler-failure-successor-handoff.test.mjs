import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { after } from 'node:test';

const require = createRequire(import.meta.url);
const repo = path.resolve(import.meta.dirname, '..');
const apiDist = path.join(repo, 'src/apiserver/dist');
const url = process.env.FAILURE_SUCCESSOR_PG_URL;
const evidencePath = process.env.FAILURE_SUCCESSOR_EVIDENCE_PATH;
const targetSha = process.env.FAILURE_SUCCESSOR_TARGET_SHA;
const expectedDatabase = process.env.FAILURE_SUCCESSOR_PG_EXPECTED_DATABASE;
const expectedUser = process.env.FAILURE_SUCCESSOR_PG_EXPECTED_USER;
const expectedSystemIdentifier = process.env.FAILURE_SUCCESSOR_PG_EXPECTED_SYSTEM_IDENTIFIER;
const startedAt = process.env.FAILURE_SUCCESSOR_STARTED_AT;

assert.ok(url, 'FAILURE_SUCCESSOR_PG_URL is required');
assert.ok(evidencePath, 'FAILURE_SUCCESSOR_EVIDENCE_PATH is required');
assert.match(targetSha ?? '', /^[0-9a-f]{40}$/);
assert.ok(expectedDatabase);
assert.ok(expectedUser);
assert.match(expectedSystemIdentifier ?? '', /^\d+$/);
assert.ok(Number.isFinite(Date.parse(startedAt ?? '')));

const { Pool } = require('pg');
const { prismaClientFor } = require(path.join(apiDist, 'prisma/prisma-client.js'));
const { TasksService } = require(path.join(apiDist, 'tasks/tasks.service.js'));
const { SessionsService } = require(path.join(apiDist, 'sessions/sessions.service.js'));
const { RunnerApiController } = require(path.join(
  apiDist,
  'runner-api/runner-api.controller.js',
));
const { FailureContinuationService } = require(path.join(
  apiDist,
  'projects/failure-continuation.service.js',
));
const { FailureContinuationControllerService } = require(path.join(
  apiDist,
  'projects/failure-continuation-controller.service.js',
));
const { failureContinuationWakeFact } = require(path.join(
  apiDist,
  'projects/failure-continuation.js',
));
const { wakeIdempotencyKey } = require(path.join(
  apiDist,
  'projects/coordinator-wake.js',
));
const {
  CreatorType,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  SessionRunSource,
} = require(path.join(apiDist, 'node_modules/@prisma/client'));

const db = prismaClientFor(url);
const pool = new Pool({ connectionString: url, max: 24 });
const controller = new FailureContinuationControllerService(db);
const courier = new FailureContinuationService(db, {});
const queue = { notifySessionQueued() {} };
const realtime = new Proxy({}, {
  get: (_target, property) => property === 'waitForInbox'
    ? async () => undefined
    : () => undefined,
});
const sessions = new SessionsService(db, queue, realtime);
const liveTasks = new TasksService(db, sessions, realtime);
const crashTasks = new TasksService(db, {
  create: async () => {
    throw new Error('FIXTURE_PROCESS_DIED_AFTER_HANDOFF_COMMIT');
  },
}, realtime);
const sourceTasks = new TasksService(db, {}, realtime);
const DEFAULT_COMMAND = 'node -e "process.exit(9)"';
const DEFAULT_OUTPUT = 'isolated successor source failed\n';
const SUCCESSOR_CAPABILITY = 'failure-successor.execute';
const CRITERION_TEXT = 'Every failed executable attempt is continued by exactly one durable successor.';

const evidence = {
  schemaVersion: 1,
  suite: 'failure-successor-atomic-handoff-v1',
  outcome: 'INCOMPLETE',
  targetSha,
  bindingRevision: 1,
  postgres: {
    required: true,
    connected: false,
    database: null,
    user: null,
    systemIdentifier: null,
    migrations: Number(process.env.FAILURE_SUCCESSOR_MIGRATION_COUNT ?? 0),
    lastMigration: process.env.FAILURE_SUCCESSOR_LAST_MIGRATION ?? null,
    requiredMigrationApplied:
      process.env.FAILURE_SUCCESSOR_REQUIRED_MIGRATION_APPLIED === '1',
  },
  observationWindow: {
    startedAt,
    finishedAt: null,
    durationMilliseconds: null,
  },
  samples: {
    handoffs: 0,
    concurrentSubmissions: 0,
    replayReads: 0,
    leaseGenerations: 0,
    activeRunFences: 0,
    reboundEdges: 0,
    dispatchDoors: 0,
    queuedSuccessors: 0,
    ownerHeldSuccessors: 0,
    lineageGenerations: 0,
    lineageFingerprintRepeats: 0,
    lineageBudgetEscalations: 0,
  },
  coverage: {
    isolatedDatabase: false,
    oneCurrentSuccessor: false,
    concurrentReplayIdempotent: false,
    leaseExpiryFenced: false,
    activeSourceRunFenced: false,
    crashRecoveryDurable: false,
    failedEvidencePreserved: false,
    continuationResolved: false,
    dependencyReboundAtomically: false,
    readyRunTriggerSweepCommitAgree: false,
    capableOwnerlessAutoQueued: false,
    ownerRequiredHeld: false,
    monotoneGeneration: false,
    noOrphanDoubleActiveOrStaleEdge: false,
    appendOnlyEvidence: false,
    fingerprintRepeatsAcrossLineage: false,
    exhaustedBudgetChangesDiagnosticPath: false,
    distinctFingerprintsDoNotAccumulate: false,
    brokenLineageDoesNotLeak: false,
    predecessorEvidenceUnrewritten: false,
    productionWrites: false,
  },
  results: {},
};

let primary;
let concurrent;
let ownerRequired;

after(async () => {
  await db.$disconnect();
  await pool.end();
  const finishedAt = new Date().toISOString();
  evidence.observationWindow.finishedAt = finishedAt;
  evidence.observationWindow.durationMilliseconds =
    Date.parse(finishedAt) - Date.parse(evidence.observationWindow.startedAt);
  mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
});

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function runnerApi() {
  return new RunnerApiController(
    db,
    queue,
    realtime,
    {},
    {},
    {},
    { appendFor: async (_tx, _sessionId, content) => content },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { kick: async () => undefined },
  );
}

async function empty() {
  await pool.query(`
    TRUNCATE failure_successor_dependency_rebind,
             failure_successor_current_binding,
             failure_successor_handoff,
             failure_continuation_route_decision,
             failure_continuation_wakeup_outbox,
             failure_continuation_obligation,
             failure_continuation_attempt_receipt,
             task, session, workspace, runner, project, "user"
    RESTART IDENTITY CASCADE
  `);
}

async function projectFixture(label, capabilities = []) {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@failure-successor.invalid`,
      name: label,
      passwordHash: 'fixture-only-not-a-credential',
    },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: `${label}-runner`,
      tokenHash: `fixture-${runnerId}`,
      status: RunnerStatus.ONLINE,
      // Keep a real free slot after the coordinator session is materialized. The crash-recovery
      // assertion is about a durable handoff appointment, not the orthogonal capacity brake.
      maxConcurrent: 8,
      capabilities,
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
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
      goal: `${label} fixture goal`,
      acceptanceCriteria: CRITERION_TEXT,
      coordinatorEnabled: true,
      coordinatorWorkspaceId: workspaceId,
      sessionBudgetPerDay: null,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  // The production compatibility trigger turns legacy text into a structured definition whose
  // content hash includes the trust shape. Use that authoritative identity just as a coordinator
  // would after reading the project, rather than guessing from the display text alone.
  const definition = await db.projectAcceptanceCriterionDefinition.findFirstOrThrow({
    where: { projectId },
    orderBy: { ordinal: 'asc' },
    select: { contentHash: true },
  });
  return {
    ownerId,
    runnerId,
    workspaceId,
    projectId,
    label,
    criterionKey: definition.contentHash.slice(0, 32),
  };
}

function executableTask(project, title, extra = {}) {
  return sourceTasks.create(project.ownerId, {
    title,
    description: `${title} in the disposable successor fixture`,
    projectId: project.projectId,
    assigneeId: project.workspaceId,
    completionCriterion: 'EXECUTABLE',
    acceptanceCriteria: 'The isolated command exits with code zero.',
    acceptanceCommand: extra.acceptanceCommand ?? DEFAULT_COMMAND,
    acceptanceExpectedExitCode: 0,
    acceptanceTimeoutSeconds: 120,
    acceptanceOwnerTimeoutCeilingSeconds: 120,
    dependsOnTaskIds: extra.dependsOnTaskIds,
    autoRunWhenReady: extra.autoRunWhenReady,
  });
}

async function failTaskInSession(project, taskId, label, existingSessionId = null) {
  const sessionId = existingSessionId ?? randomUUID();
  if (existingSessionId) {
    await db.session.update({
      where: { id: sessionId },
      data: { status: RunStatus.RUNNING, engineTurnActive: true },
    });
  } else {
    await db.session.create({
      data: {
        id: sessionId,
        ownerId: project.ownerId,
        creatorId: project.ownerId,
        taskId,
        workspaceId: project.workspaceId,
        assignedRunnerId: project.runnerId,
        title: label,
        prompt: label,
        provider: 'claude',
        status: RunStatus.RUNNING,
        engineTurnActive: true,
        dispatchOrigin: SessionDispatchOrigin.USER,
        runSource: SessionRunSource.MANUAL,
        startsTaskWork: true,
      },
    });
  }
  const messageTurnId = randomUUID();
  await db.conversationTurn.create({
    data: {
      id: messageTurnId,
      sessionId,
      seq: 1,
      clientTurnId: `message:${messageTurnId}`,
      kind: 'message',
      content: 'finish the isolated fixture work',
      status: 'IN_FLIGHT',
    },
  });
  const api = runnerApi();
  await api.turnComplete({ id: project.runnerId }, sessionId, {
    turnId: messageTurnId,
    status: RunStatus.SUCCEEDED,
  });
  const delivery = await api.dequeueTurn(
    sessionId,
    project.runnerId,
    null,
    false,
    [],
    {
      schemaRevision: 2,
      capabilityRevision: 2,
      hardMaxSeconds: 3600,
      runnerSha: targetSha,
    },
  );
  assert.ok(delivery?.acceptancePlan, `typed acceptance was not admitted for ${label}`);
  const started = await api.startExecutableAcceptanceAttempt(
    { id: project.runnerId },
    sessionId,
    delivery.acceptancePlan.admissionId,
  );
  const result = await api.turnComplete({ id: project.runnerId }, sessionId, {
    turnId: delivery.turnId,
    status: RunStatus.SUCCEEDED,
    subtype: 'shell',
    shellOutput: DEFAULT_OUTPUT,
    acceptanceAdmissionId: delivery.acceptancePlan.admissionId,
    acceptanceAttemptId: started.attemptId,
    acceptanceTerminationKind: 'EXITED',
    acceptanceActualExitCode: 9,
    acceptanceSignal: null,
  });
  assert.equal(result.status, RunStatus.FAILED);
  const observedAt = new Date();
  const claims = await courier.claimDue(
    `failure-successor:${label}:${randomUUID()}`,
    observedAt,
    120,
    64,
  );
  const claim = claims.find((candidate) => candidate.taskId === taskId);
  assert.ok(claim, `canonical failure continuation for ${label} was not claimed`);
  return { taskId, sessionId, claim, observedAt, attemptId: started.attemptId };
}

async function routedFailure(project, label, observation, taskId = null, existingSessionId = null) {
  const task = taskId ? await db.task.findUnique({ where: { id: taskId } })
    : await executableTask(project, `${label}-failed-source`);
  assert.ok(task);
  const failure = await failTaskInSession(project, task.id, label, existingSessionId);
  const route = await controller.routeClaim(failure.claim, failure.observedAt, observation);
  return { ...project, ...failure, route, observation };
}

async function ackClaim(claim, wakeId, sessionId, deliveredAt = new Date()) {
  return (await pool.query(
    `SELECT failure_continuation_ack_wakeup(
       $1::uuid,$2::uuid,$3::bigint,$4::uuid,$5::uuid,$6::timestamptz
     ) AS applied`,
    [
      claim.outboxId,
      claim.leaseToken,
      String(claim.leaseGeneration),
      wakeId,
      sessionId,
      deliveredAt,
    ],
  )).rows[0].applied;
}

async function deliverFailure(failure, { expireAndTakeOver = false } = {}) {
  let activeClaim = failure.claim;
  let staleAckApplied = null;
  let routeReplay = null;
  if (expireAndTakeOver) {
    const takeoverAt = new Date(new Date(failure.claim.leasedUntil).getTime() + 1);
    const claims = await courier.claimDue(
      `failure-successor-takeover:${randomUUID()}`,
      takeoverAt,
      120,
      64,
    );
    activeClaim = claims.find((candidate) => candidate.outboxId === failure.claim.outboxId);
    assert.ok(activeClaim, 'expired continuation lease was not reclaimed');
    assert.equal(BigInt(activeClaim.leaseGeneration), BigInt(failure.claim.leaseGeneration) + 1n);
    routeReplay = await controller.routeClaim(activeClaim, takeoverAt, failure.observation);
    assert.equal(routeReplay.decisionId, failure.route.decisionId);
    assert.equal(routeReplay.decisionDigest, failure.route.decisionDigest);
    assert.equal(routeReplay.replayed, true);
  }

  const sessionId = activeClaim.plannedSessionId;
  const wakeId = randomUUID();
  const fact = failureContinuationWakeFact(activeClaim, failure.route);
  await db.session.create({
    data: {
      id: sessionId,
      ownerId: failure.ownerId,
      creatorId: failure.ownerId,
      workspaceId: failure.workspaceId,
      assignedRunnerId: failure.runnerId,
      title: `judgment-${failure.label}`,
      prompt: `failure successor judgment ${failure.claim.obligationId}`,
      provider: 'claude',
      status: RunStatus.PENDING,
      dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR,
      runSource: SessionRunSource.PROJECT_COORDINATOR,
      startsTaskWork: false,
    },
  });
  await db.projectCoordinatorWake.create({
    data: {
      id: wakeId,
      projectId: failure.projectId,
      event: fact.event,
      subjectType: fact.subjectType,
      subjectId: fact.subjectId,
      subjectVersion: fact.subjectVersion,
      idempotencyKey: wakeIdempotencyKey(fact),
      status: 'SESSION_OPENED',
      sessionId,
      detail: fact.detail ?? {},
    },
  });
  if (expireAndTakeOver) {
    staleAckApplied = await ackClaim(failure.claim, wakeId, sessionId);
    assert.equal(staleAckApplied, false, 'expired lease generation acknowledged delivery');
  }
  assert.equal(await ackClaim(activeClaim, wakeId, sessionId), true);
  return { ...failure, claim: activeClaim, coordinatorSessionId: sessionId, wakeId,
    staleAckApplied, routeReplay };
}

function handoffInput(failure) {
  return {
    obligationId: failure.claim.obligationId,
    obligationRevision: failure.claim.idempotencyKey,
    routeDecisionId: failure.route.decisionId,
    routeDecisionDigest: failure.route.decisionDigest,
  };
}

function successorDto(failure, title) {
  return {
    title,
    description: `Durable successor for failed task ${failure.taskId}`,
    projectId: failure.projectId,
    assigneeId: failure.workspaceId,
    criterionKey: failure.criterionKey,
    completionCriterion: 'EXECUTABLE',
    acceptanceCriteria: 'The successor command exits with code zero.',
    acceptanceCommand: 'node -e "process.exit(0)"',
    acceptanceExpectedExitCode: 0,
    acceptanceTimeoutSeconds: 120,
    acceptanceOwnerTimeoutCeilingSeconds: 120,
    supersedesTaskId: failure.taskId,
    failureSuccessorHandoff: handoffInput(failure),
  };
}

async function createSuccessor(service, failure, title) {
  return service.create(
    failure.ownerId,
    successorDto(failure, title),
    { type: CreatorType.AGENT, id: failure.workspaceId },
    failure.coordinatorSessionId,
  );
}

async function sessionCount(taskId) {
  return db.session.count({ where: { taskId, startsTaskWork: true, deletedAt: null } });
}

async function workSession(project, taskId, label) {
  const sessionId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId,
      ownerId: project.ownerId,
      creatorId: project.ownerId,
      taskId,
      workspaceId: project.workspaceId,
      assignedRunnerId: project.runnerId,
      title: label,
      prompt: label,
      provider: 'claude',
      status: RunStatus.RUNNING,
      engineTurnActive: true,
      dispatchOrigin: SessionDispatchOrigin.USER,
      runSource: SessionRunSource.MANUAL,
      startsTaskWork: true,
    },
  });
  return sessionId;
}

/**
 * One whole typed acceptance attempt against a live work session: model turn, the shell turn the
 * completion queues, the admitted start boundary and the runner's typed termination. Repeating it
 * on the same session is how a Task carrying more than one attempt is built.
 */
async function acceptanceAttempt(project, sessionId, termination) {
  await db.session.update({
    where: { id: sessionId },
    data: { status: RunStatus.RUNNING, engineTurnActive: true },
  });
  const messageTurnId = randomUUID();
  const last = await db.conversationTurn.aggregate({ where: { sessionId }, _max: { seq: true } });
  await db.conversationTurn.create({
    data: {
      id: messageTurnId,
      sessionId,
      seq: (last._max.seq ?? 0) + 1,
      clientTurnId: `message:${messageTurnId}`,
      kind: 'message',
      content: 'finish the isolated fixture work',
      status: 'IN_FLIGHT',
    },
  });
  const api = runnerApi();
  await api.turnComplete({ id: project.runnerId }, sessionId, {
    turnId: messageTurnId,
    status: RunStatus.SUCCEEDED,
  });
  const delivery = await api.dequeueTurn(
    sessionId,
    project.runnerId,
    null,
    false,
    [],
    { schemaRevision: 2, capabilityRevision: 2, hardMaxSeconds: 3600, runnerSha: targetSha },
  );
  assert.ok(delivery?.acceptancePlan, 'typed acceptance was not admitted for the repeat attempt');
  const started = await api.startExecutableAcceptanceAttempt(
    { id: project.runnerId },
    sessionId,
    delivery.acceptancePlan.admissionId,
  );
  const exited = termination.terminationKind === 'EXITED';
  await api.turnComplete({ id: project.runnerId }, sessionId, {
    turnId: delivery.turnId,
    status: RunStatus.SUCCEEDED,
    subtype: 'shell',
    shellOutput: termination.output ?? DEFAULT_OUTPUT,
    acceptanceAdmissionId: delivery.acceptancePlan.admissionId,
    acceptanceAttemptId: started.attemptId,
    acceptanceTerminationKind: termination.terminationKind,
    acceptanceActualExitCode: exited ? termination.actualExitCode : null,
    acceptanceSignal: null,
  });
  return started.attemptId;
}

/** The ordinary coordinator supersession: no handoff receipt, only the replacement relation. */
async function supersedingTask(project, predecessorTaskId, title) {
  return sourceTasks.create(project.ownerId, {
    title,
    description: `${title} in the disposable successor fixture`,
    projectId: project.projectId,
    assigneeId: project.workspaceId,
    criterionKey: project.criterionKey,
    completionCriterion: 'EXECUTABLE',
    acceptanceCriteria: 'The isolated command exits with code zero.',
    acceptanceCommand: DEFAULT_COMMAND,
    acceptanceExpectedExitCode: 0,
    acceptanceTimeoutSeconds: 120,
    acceptanceOwnerTimeoutCeilingSeconds: 120,
    supersedesTaskId: predecessorTaskId,
  });
}

/** What the failed attempt was actually charged, read back from the durable diagnosis. */
async function repeatBudgetSpent(attemptId) {
  const diagnosis = await db.taskExecutableDiagnosis.findFirst({ where: { attemptId } });
  assert.ok(diagnosis, `attempt ${attemptId} produced no diagnosis to read the budget from`);
  return {
    sameFingerprintCount: diagnosis.evidence.sameFingerprintCount,
    continuationReasonCode: diagnosis.evidence.continuationReasonCode,
  };
}

/** Every column of the predecessors, so a rewrite anywhere in them is a difference here. */
async function lineageEvidenceSnapshot(taskIds) {
  return (await pool.query(`
    SELECT jsonb_build_object(
      'tasks', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id)
                  FROM task t WHERE t.id = ANY($1::uuid[])),
      'attempts', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id)
                     FROM task_executable_attempt a WHERE a.task_id = ANY($1::uuid[])),
      'receipts', (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.receipt_id)
                     FROM failure_continuation_attempt_receipt r
                    WHERE r.task_id = ANY($1::uuid[]))
    ) AS snapshot
  `, [taskIds])).rows[0].snapshot;
}

test('the suite is bound to the declared disposable PostgreSQL identity', async () => {
  await empty();
  const identity = (await pool.query(`
    SELECT current_database() AS database, current_user AS "user",
           (SELECT system_identifier::text FROM pg_control_system()) AS "systemIdentifier"
  `)).rows[0];
  assert.deepEqual(identity, {
    database: expectedDatabase,
    user: expectedUser,
    systemIdentifier: expectedSystemIdentifier,
  });
  assert.ok(evidence.postgres.migrations > 0);
  assert.equal(evidence.postgres.requiredMigrationApplied, true);
  evidence.postgres.connected = true;
  evidence.postgres.database = identity.database;
  evidence.postgres.user = identity.user;
  evidence.postgres.systemIdentifier = identity.systemIdentifier;
  evidence.coverage.isolatedDatabase = true;
});

test('one routed failed continuation atomically becomes one current successor with rebound edges',
  { timeout: 120_000 }, async () => {
    const project = await projectFixture('primary', [SUCCESSOR_CAPABILITY]);
    const failure = await routedFailure(project, 'primary', {
      failureNode: 'RUNTIME_CAPABILITY',
      requiredCapability: SUCCESSOR_CAPABILITY,
    });
    assert.equal(failure.route.failureDomain, 'CAPABILITY/ENVIRONMENT');
    assert.equal(failure.route.canonicalReason.capabilityAvailable, true);
    const delivered = await deliverFailure(failure);
    const downstream = await Promise.all([
      executableTask(project, 'primary-downstream-one', {
        dependsOnTaskIds: [failure.taskId], autoRunWhenReady: true,
      }),
      executableTask(project, 'primary-downstream-two', {
        dependsOnTaskIds: [failure.taskId], autoRunWhenReady: true,
      }),
    ]);
    const successor = await createSuccessor(liveTasks, delivered, 'primary-current-successor');
    const [source, continuation, handoff, current, rebinds, edges] = await Promise.all([
      db.task.findUnique({ where: { id: failure.taskId } }),
      db.taskExecutableContinuation.findUnique({ where: { id: failure.claim.continuationId } }),
      db.failureSuccessorHandoff.findUnique({
        where: { obligationId: failure.claim.obligationId },
      }),
      db.failureSuccessorCurrentBinding.findUnique({
        where: { lineageRootTaskId: failure.taskId },
      }),
      db.failureSuccessorDependencyRebind.findMany({
        where: { sourceTaskId: failure.taskId }, orderBy: { dependentTaskId: 'asc' },
      }),
      db.taskDependency.findMany({
        where: { taskId: { in: downstream.map((task) => task.id) } },
        orderBy: { taskId: 'asc' },
      }),
    ]);
    assert.equal(source.status, 'FAILED');
    assert.equal(source.supersededByTaskId, successor.id);
    assert.equal(source.terminalReason, 'SUPERSEDED');
    assert.equal(continuation.status, 'RESOLVED');
    assert.ok(continuation.resolvedAt);
    assert.equal(handoff.sourceAttemptId, failure.attemptId);
    assert.equal(handoff.sourceContinuationId, failure.claim.continuationId);
    assert.equal(handoff.failureFingerprint, failure.claim.failureFingerprint);
    assert.equal(handoff.sourceBindingRevision, BigInt(failure.claim.bindingRevision));
    assert.equal(handoff.sourceAttemptGeneration, BigInt(failure.claim.attemptGeneration));
    assert.equal(handoff.bindingGeneration, 1n);
    assert.equal(handoff.requiresOwner, false);
    assert.equal(handoff.autoDispatchRequested, true);
    assert.deepEqual(handoff.requiredCapabilities, [SUCCESSOR_CAPABILITY]);
    assert.equal(current.currentSuccessorTaskId, successor.id);
    assert.equal(current.bindingGeneration, 1n);
    assert.equal(rebinds.length, downstream.length);
    assert.ok(rebinds.every((row) => row.successorTaskId === successor.id
      && row.bindingGeneration === 1n && row.action === 'MOVED'));
    assert.deepEqual(new Set(edges.map((edge) => edge.dependsOnTaskId)), new Set([successor.id]));
    assert.equal(await sessionCount(successor.id), 1);
    const successorRow = await db.task.findUnique({ where: { id: successor.id } });
    assert.deepEqual(successorRow.requiredCapabilities, [SUCCESSOR_CAPABILITY]);
    assert.equal(successorRow.runAt, null, 'accepted immediate dispatch did not consume run_at');
    assert.equal(successorRow.dispatchHold, false);
    const attemptStillExists = await db.taskExecutableAttempt.findUnique({
      where: { id: failure.attemptId },
    });
    assert.equal(attemptStillExists.terminationKind, 'EXITED');
    assert.equal(attemptStillExists.actualExitCode, 9);
    primary = { project, failure: delivered, successor, downstream, handoff };
    evidence.samples.handoffs += 1;
    evidence.samples.reboundEdges += rebinds.length;
    evidence.samples.queuedSuccessors += 1;
    evidence.coverage.oneCurrentSuccessor = true;
    evidence.coverage.failedEvidencePreserved = true;
    evidence.coverage.continuationResolved = true;
    evidence.coverage.dependencyReboundAtomically = true;
    evidence.coverage.capableOwnerlessAutoQueued = true;
    evidence.results.primary = {
      sourceTaskId: failure.taskId,
      successorTaskId: successor.id,
      sourceAttemptId: failure.attemptId,
      sourceContinuationId: failure.claim.continuationId,
      bindingGeneration: String(handoff.bindingGeneration),
      bindingDigest: handoff.bindingDigest,
      reboundTaskIds: downstream.map((task) => task.id).sort(),
    };
  });

test('Ready, Run Now, immediate trigger, periodic sweep and commit gate resolve the current successor',
  { timeout: 120_000 }, async () => {
    const { project, failure, successor, downstream } = primary;
    const first = downstream[0];
    const row = await liveTasks.listRow(project.ownerId, first.id);
    assert.equal(row.dependencyState, 'BLOCKED');
    assert.equal(row.runnable, false);
    await assert.rejects(
      liveTasks.execute(project.ownerId, first.id),
      /Prerequisites are not all complete yet/,
    );
    await liveTasks.dispatchDependentsAfterCompletion(project.ownerId, failure.taskId);
    await liveTasks.dispatchDependentsAfterCompletion(project.ownerId, successor.id);
    await liveTasks.reconcileReadyTasks();
    assert.equal(await sessionCount(first.id), 0);
    const commitGateSession = randomUUID();
    await assert.rejects(
      pool.query(`
        INSERT INTO session (
          id,title,prompt,owner_id,creator_id,assigned_runner_id,workspace_id,task_id,
          dispatch_origin,run_source,starts_task_work,provider,status,source,created_at,updated_at
        ) VALUES (
          $1::uuid,'commit gate probe','probe',$2::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,
          'USER'::session_dispatch_origin,'MANUAL'::session_run_source,true,'claude',
          'PENDING'::run_status,'user',now(),now()
        )
      `, [commitGateSession, project.ownerId, project.runnerId, project.workspaceId, first.id]),
      /DISPATCH_DEPENDENCY_CHANGED.*unresolved prerequisite tail/,
    );
    const tails = (await pool.query(`
      SELECT task_dependency_tail_id($1::uuid) AS source_tail,
             task_dependency_tail_id($2::uuid) AS successor_tail
    `, [failure.taskId, successor.id])).rows[0];
    assert.equal(tails.source_tail, successor.id);
    assert.equal(tails.successor_tail, successor.id);
    assert.equal(await sessionCount(first.id), 0);
    evidence.samples.dispatchDoors += 5;
    evidence.coverage.readyRunTriggerSweepCommitAgree = true;
    evidence.results.blockedConsensus = {
      dependentTaskId: first.id,
      currentSuccessorTaskId: successor.id,
      dependencyState: row.dependencyState,
      readySelector: row.runnable,
      queuedSessions: 0,
      doors: ['READY', 'RUN_NOW', 'IMMEDIATE_TRIGGER', 'PERIODIC_SWEEP', 'COMMIT_GATE'],
    };
  });

test('a live source run fences takeover before a successor candidate can exist',
  { timeout: 120_000 }, async () => {
    const project = await projectFixture('active-source', [SUCCESSOR_CAPABILITY]);
    const failure = await routedFailure(project, 'active-source', {
      failureNode: 'PRODUCT_SOURCE',
    });
    const delivered = await deliverFailure(failure);
    const liveSessionId = randomUUID();
    await db.session.create({
      data: {
        id: liveSessionId,
        ownerId: project.ownerId,
        creatorId: project.ownerId,
        taskId: failure.taskId,
        workspaceId: project.workspaceId,
        assignedRunnerId: project.runnerId,
        title: 'source retry racing failure handoff',
        prompt: 'hold the source execution claim',
        provider: 'claude',
        status: RunStatus.PENDING,
        dispatchOrigin: SessionDispatchOrigin.USER,
        runSource: SessionRunSource.MANUAL,
        startsTaskWork: true,
      },
    });
    await assert.rejects(
      createSuccessor(crashTasks, delivered, 'must-not-exist-live-source-successor'),
      /still has a live session/,
    );
    const [source, continuation, candidates, handoffs, currents] = await Promise.all([
      db.task.findUnique({ where: { id: failure.taskId } }),
      db.taskExecutableContinuation.findUnique({ where: { id: failure.claim.continuationId } }),
      db.task.count({ where: { title: 'must-not-exist-live-source-successor' } }),
      db.failureSuccessorHandoff.count({
        where: { obligationId: failure.claim.obligationId },
      }),
      db.failureSuccessorCurrentBinding.count({
        where: { lineageRootTaskId: failure.taskId },
      }),
    ]);
    assert.equal(source.status, 'FAILED');
    assert.equal(source.supersededByTaskId, null);
    assert.equal(source.terminalReason, null);
    assert.equal(continuation.status, 'ACTIVE');
    assert.equal(candidates, 0);
    assert.equal(handoffs, 0);
    assert.equal(currents, 0);
    await db.session.update({
      where: { id: liveSessionId },
      data: {
        status: RunStatus.CANCELLED,
        engineTurnActive: false,
        finishedAt: new Date(),
        completedAt: new Date(),
      },
    });
    evidence.samples.activeRunFences += 1;
    evidence.coverage.activeSourceRunFenced = true;
    evidence.results.activeSourceFence = {
      sourceTaskId: failure.taskId,
      liveSessionId,
      successorCandidates: candidates,
      handoffRows: handoffs,
      currentBindings: currents,
    };
  });

test('expired lease takeover, concurrent coordinators and duplicate replay converge on one task',
  { timeout: 120_000 }, async () => {
    const project = await projectFixture('concurrent', [SUCCESSOR_CAPABILITY]);
    const failure = await routedFailure(project, 'concurrent', {
      failureNode: 'PRODUCT_SOURCE',
    });
    const delivered = await deliverFailure(failure, { expireAndTakeOver: true });
    const dependent = await executableTask(project, 'concurrent-dependent', {
      dependsOnTaskIds: [failure.taskId], autoRunWhenReady: true,
    });
    const [left, right] = await Promise.all([
      createSuccessor(crashTasks, delivered, 'concurrent-successor-left'),
      createSuccessor(crashTasks, delivered, 'concurrent-successor-right'),
    ]);
    assert.equal(left.id, right.id);
    const replay = await createSuccessor(crashTasks, delivered, 'replayed-with-new-prose');
    assert.equal(replay.id, left.id);
    const [handoffs, current, candidates, sessionsForWinner, winner] = await Promise.all([
      db.failureSuccessorHandoff.findMany({
        where: { obligationId: failure.claim.obligationId },
      }),
      db.failureSuccessorCurrentBinding.findUnique({
        where: { lineageRootTaskId: failure.taskId },
      }),
      db.task.findMany({
        where: {
          ownerId: project.ownerId,
          title: { in: ['concurrent-successor-left', 'concurrent-successor-right'] },
        },
      }),
      sessionCount(left.id),
      db.task.findUnique({ where: { id: left.id } }),
    ]);
    assert.equal(handoffs.length, 1);
    assert.equal(current.currentSuccessorTaskId, left.id);
    assert.equal(candidates.length, 1, 'losing transaction left an orphan Task candidate');
    assert.equal(sessionsForWinner, 0, 'simulated post-commit process crash unexpectedly queued');
    assert.ok(winner.runAt && winner.runAt <= new Date());
    assert.equal(delivered.staleAckApplied, false);
    assert.equal(delivered.routeReplay.decisionId, failure.route.decisionId);
    concurrent = { project, failure: delivered, successor: left, dependent, handoff: handoffs[0] };
    evidence.samples.concurrentSubmissions += 2;
    evidence.samples.replayReads += 2;
    evidence.samples.leaseGenerations += 2;
    evidence.samples.handoffs += 1;
    evidence.samples.reboundEdges += 1;
    evidence.coverage.concurrentReplayIdempotent = true;
    evidence.coverage.leaseExpiryFenced = true;
    evidence.results.concurrent = {
      obligationId: failure.claim.obligationId,
      winnerTaskId: left.id,
      persistedCandidates: candidates.length,
      leaseGeneration: String(failure.claim.leaseGeneration),
      takeoverGeneration: String(delivered.claim.leaseGeneration),
      staleAckApplied: delivered.staleAckApplied,
    };
  });

test('a process crash after handoff commit is recovered by the durable scheduled sweep exactly once',
  { timeout: 120_000 }, async () => {
    const { project, successor } = concurrent;
    await Promise.all([
      liveTasks.dispatchDueScheduledTasks(),
      liveTasks.dispatchDueScheduledTasks(),
      liveTasks.dispatchDueScheduledTasks(),
    ]);
    const [sessionsForWinner, task, receiptCount] = await Promise.all([
      db.session.findMany({
        where: { taskId: successor.id, startsTaskWork: true, deletedAt: null },
      }),
      db.task.findUnique({ where: { id: successor.id } }),
      db.taskRunRequest.count({ where: { ownerId: project.ownerId } }),
    ]);
    assert.equal(sessionsForWinner.length, 1);
    assert.equal(sessionsForWinner[0].status, RunStatus.PENDING);
    assert.equal(task.runAt, null);
    assert.ok(receiptCount >= 1);
    evidence.samples.queuedSuccessors += 1;
    evidence.coverage.crashRecoveryDurable = true;
    evidence.results.crashRecovery = {
      successorTaskId: successor.id,
      sessionId: sessionsForWinner[0].id,
      queuedSessions: sessionsForWinner.length,
      runAtAfterDispatch: task.runAt,
    };
  });

test('a failed current successor advances exactly one monotone generation and moves every edge again',
  { timeout: 120_000 }, async () => {
    const { project, failure: firstFailure, successor: firstSuccessor, dependent } = concurrent;
    const [run] = await db.session.findMany({
      where: { taskId: firstSuccessor.id, startsTaskWork: true, deletedAt: null },
    });
    assert.ok(run);
    const secondFailure = await routedFailure(
      project,
      'generation-two',
      { failureNode: 'PRODUCT_SOURCE' },
      firstSuccessor.id,
      run.id,
    );
    const delivered = await deliverFailure(secondFailure);
    const secondSuccessor = await createSuccessor(
      crashTasks,
      delivered,
      'generation-two-current-successor',
    );
    const [current, handoffs, sources, edges, rebinds, tails] = await Promise.all([
      db.failureSuccessorCurrentBinding.findUnique({
        where: { lineageRootTaskId: firstFailure.taskId },
      }),
      db.failureSuccessorHandoff.findMany({
        where: { lineageRootTaskId: firstFailure.taskId },
        orderBy: { bindingGeneration: 'asc' },
      }),
      db.task.findMany({
        where: { id: { in: [firstFailure.taskId, firstSuccessor.id, secondSuccessor.id] } },
        orderBy: { createdAt: 'asc' },
      }),
      db.taskDependency.findMany({ where: { taskId: dependent.id } }),
      db.failureSuccessorDependencyRebind.findMany({
        where: { dependentTaskId: dependent.id }, orderBy: { bindingGeneration: 'asc' },
      }),
      pool.query(`
        SELECT task_dependency_tail_id($1::uuid) AS root,
               task_dependency_tail_id($2::uuid) AS middle,
               task_dependency_tail_id($3::uuid) AS current
      `, [firstFailure.taskId, firstSuccessor.id, secondSuccessor.id]),
    ]);
    assert.equal(current.currentSuccessorTaskId, secondSuccessor.id);
    assert.equal(current.bindingGeneration, 2n);
    assert.deepEqual(handoffs.map((row) => row.bindingGeneration), [1n, 2n]);
    const byId = new Map(sources.map((task) => [task.id, task]));
    assert.equal(byId.get(firstFailure.taskId).status, 'FAILED');
    assert.equal(byId.get(firstFailure.taskId).supersededByTaskId, firstSuccessor.id);
    assert.equal(byId.get(firstSuccessor.id).status, 'FAILED');
    assert.equal(byId.get(firstSuccessor.id).supersededByTaskId, secondSuccessor.id);
    assert.equal(byId.get(secondSuccessor.id).status, 'OPEN');
    assert.equal(edges.length, 1);
    assert.equal(edges[0].dependsOnTaskId, secondSuccessor.id);
    assert.deepEqual(rebinds.map((row) => row.bindingGeneration), [1n, 2n]);
    assert.deepEqual(tails.rows[0], {
      root: secondSuccessor.id,
      middle: secondSuccessor.id,
      current: secondSuccessor.id,
    });
    const attemptIds = handoffs.map((row) => row.sourceAttemptId);
    assert.equal(new Set(attemptIds).size, 2);
    assert.equal(await db.taskExecutableAttempt.count({ where: { id: { in: attemptIds } } }), 2);
    concurrent = { ...concurrent, secondFailure: delivered, secondSuccessor };
    evidence.samples.handoffs += 1;
    evidence.samples.reboundEdges += 1;
    evidence.samples.lineageGenerations += 2;
    evidence.coverage.monotoneGeneration = true;
    evidence.results.generation = {
      lineageRootTaskId: firstFailure.taskId,
      currentSuccessorTaskId: secondSuccessor.id,
      generations: handoffs.map((row) => ({
        generation: String(row.bindingGeneration),
        sourceTaskId: row.sourceTaskId,
        successorTaskId: row.successorTaskId,
        sourceAttemptId: row.sourceAttemptId,
      })),
    };
  });

test('an owner-required route creates a held current successor and no execution path can run it',
  { timeout: 120_000 }, async () => {
    const project = await projectFixture('owner-required');
    const failure = await routedFailure(project, 'owner-required', {
      failureNode: 'GOAL_BOUNDARY',
      ownerReason: 'GOAL_DECISION',
    });
    assert.equal(failure.route.failureDomain, 'OWNER_REQUIRED');
    const delivered = await deliverFailure(failure);
    const successor = await createSuccessor(liveTasks, delivered, 'owner-required-successor');
    const [handoff, task, listRow] = await Promise.all([
      db.failureSuccessorHandoff.findUnique({
        where: { obligationId: failure.claim.obligationId },
      }),
      db.task.findUnique({ where: { id: successor.id } }),
      liveTasks.listRow(project.ownerId, successor.id),
    ]);
    assert.equal(handoff.requiresOwner, true);
    assert.equal(handoff.autoDispatchRequested, false);
    assert.equal(task.dispatchHold, true);
    assert.equal(task.runAt, null);
    assert.equal(task.autoRunWhenReady, false);
    assert.equal(listRow.runnable, false);
    assert.equal(await sessionCount(successor.id), 0);
    await assert.rejects(
      liveTasks.execute(project.ownerId, successor.id),
      /paused.*resume/i,
    );
    await liveTasks.dispatchDependentsAfterCompletion(project.ownerId, failure.taskId);
    await liveTasks.reconcileReadyTasks();
    await liveTasks.dispatchDueScheduledTasks();
    assert.equal(await sessionCount(successor.id), 0);
    ownerRequired = { project, failure: delivered, successor, handoff };
    evidence.samples.handoffs += 1;
    evidence.samples.ownerHeldSuccessors += 1;
    evidence.coverage.ownerRequiredHeld = true;
    evidence.results.ownerRequired = {
      successorTaskId: successor.id,
      requiresOwner: handoff.requiresOwner,
      autoDispatchRequested: handoff.autoDispatchRequested,
      dispatchHold: task.dispatchHold,
      queuedSessions: 0,
    };
  });

test('handoff evidence is append-only and replay comparison values cannot be mixed', async () => {
  const { project, failure, successor, handoff } = ownerRequired;
  await assert.rejects(
    pool.query(`UPDATE failure_successor_handoff
                   SET binding_digest=$2
                 WHERE handoff_id=$1::uuid`, [handoff.handoffId, sha256('rewrite')]),
    /OUTCOME_APPEND_ONLY_VIOLATION/,
  );
  await assert.rejects(
    pool.query(`UPDATE task
                   SET superseded_by_task_id=NULL, superseded_at=NULL, terminal_reason=NULL
                 WHERE id=$1::uuid`, [failure.taskId]),
    /FAILURE_SUCCESSOR_SOURCE_BINDING_IMMUTABLE/,
  );
  await assert.rejects(
    pool.query(`DELETE FROM failure_successor_current_binding
                 WHERE lineage_root_task_id=$1::uuid`, [failure.taskId]),
    /FAILURE_SUCCESSOR_CURRENT_BINDING_DELETE_FORBIDDEN/,
  );
  const mixed = successorDto(failure, 'mixed-replay');
  mixed.failureSuccessorHandoff = {
    ...mixed.failureSuccessorHandoff,
    routeDecisionDigest: sha256('different-route'),
  };
  await assert.rejects(
    liveTasks.create(
      project.ownerId,
      mixed,
      { type: CreatorType.AGENT, id: project.workspaceId },
      failure.coordinatorSessionId,
    ),
    /FAILURE_SUCCESSOR_HANDOFF_REPLAY_MISMATCH/,
  );
  assert.equal(await db.failureSuccessorHandoff.count({
    where: { obligationId: failure.claim.obligationId },
  }), 1);
  assert.equal((await db.task.findMany({ where: { title: 'mixed-replay' } })).length, 0);
  evidence.samples.replayReads += 1;
  evidence.coverage.appendOnlyEvidence = true;
});

test('one failure fingerprint accumulates along the supersession lineage and nowhere else',
  { timeout: 240_000 }, async () => {
    const project = await projectFixture('lineage-budget');
    // The production shape this exists for: every failure retires its Task and files a fresh
    // successor, so each Task carries exactly one attempt and a per-Task count is the constant 1.
    const first = await executableTask(project, 'lineage-generation-one');
    const firstAttempt = await acceptanceAttempt(
      project,
      await workSession(project, first.id, 'lineage-generation-one'),
      { terminationKind: 'EXITED', actualExitCode: 9 },
    );
    const second = await supersedingTask(project, first.id, 'lineage-generation-two');
    const secondAttempt = await acceptanceAttempt(
      project,
      await workSession(project, second.id, 'lineage-generation-two'),
      { terminationKind: 'EXITED', actualExitCode: 9 },
    );
    // An independent Task that fails exactly alike, failed BEFORE the tail: were the count scoped
    // to the goal instead of the lineage, the tail below would read four rather than three.
    const unrelated = await executableTask(project, 'lineage-unrelated');
    const unrelatedAttempt = await acceptanceAttempt(
      project,
      await workSession(project, unrelated.id, 'lineage-unrelated'),
      { terminationKind: 'EXITED', actualExitCode: 9 },
    );
    const third = await supersedingTask(project, second.id, 'lineage-generation-three');

    const before = await lineageEvidenceSnapshot([first.id, second.id, unrelated.id]);
    const thirdAttempt = await acceptanceAttempt(
      project,
      await workSession(project, third.id, 'lineage-generation-three'),
      { terminationKind: 'EXITED', actualExitCode: 9 },
    );
    const after = await lineageEvidenceSnapshot([first.id, second.id, unrelated.id]);

    const attempts = await db.taskExecutableAttempt.findMany({
      where: { id: { in: [firstAttempt, secondAttempt, thirdAttempt, unrelatedAttempt] } },
    });
    const fingerprints = new Set(attempts.map((row) => row.failureFingerprint));
    assert.equal(fingerprints.size, 1, 'the fixture chain must share one failure fingerprint');
    assert.equal(attempts.every((row) => row.attemptNumber === 1), true);

    // (a) N=3 lineage: the third attempt is charged three, not one.
    assert.deepEqual(await repeatBudgetSpent(firstAttempt), {
      sameFingerprintCount: 1, continuationReasonCode: 'UNEXPECTED_EXIT_OBSERVED',
    });
    assert.deepEqual(await repeatBudgetSpent(secondAttempt), {
      sameFingerprintCount: 2, continuationReasonCode: 'UNEXPECTED_EXIT_OBSERVED',
    });
    assert.deepEqual(await repeatBudgetSpent(thirdAttempt), {
      sameFingerprintCount: 3, continuationReasonCode: 'UNEXPECTED_EXIT_OBSERVED',
    });
    // (d) the identical failure on a Task that supersedes nothing stays at one, in both
    // directions: it neither reads the lineage's history nor leaks into it.
    assert.equal((await repeatBudgetSpent(unrelatedAttempt)).sameFingerprintCount, 1);

    // (c) negative control: a different fingerprint on the very next link of the same lineage
    // starts its own budget instead of inheriting this one.
    const fourth = await supersedingTask(project, third.id, 'lineage-generation-four');
    const fourthAttempt = await acceptanceAttempt(
      project,
      await workSession(project, fourth.id, 'lineage-generation-four'),
      { terminationKind: 'EXITED', actualExitCode: 7 },
    );
    const fourthRow = await db.taskExecutableAttempt.findUniqueOrThrow({
      where: { id: fourthAttempt },
    });
    assert.notEqual(fourthRow.failureFingerprint, [...fingerprints][0]);
    assert.equal((await repeatBudgetSpent(fourthAttempt)).sameFingerprintCount, 1);

    // (e) nothing about the predecessors was reclassified, re-fingerprinted or re-receipted by
    // the tail attempt that read them.
    assert.deepEqual(after, before);
    assert.equal(after.tasks.every((task) => task.status === 'FAILED'), true);
    assert.deepEqual(
      after.tasks.filter((task) => task.id !== unrelated.id).map((task) => task.terminal_reason),
      ['SUPERSEDED', 'SUPERSEDED'],
    );

    evidence.samples.lineageFingerprintRepeats += 3;
    evidence.coverage.fingerprintRepeatsAcrossLineage = true;
    evidence.coverage.distinctFingerprintsDoNotAccumulate = true;
    evidence.coverage.brokenLineageDoesNotLeak = true;
    evidence.coverage.predecessorEvidenceUnrewritten = true;
    evidence.results.lineageBudget = {
      chainTaskIds: [first.id, second.id, third.id],
      unrelatedTaskId: unrelated.id,
      sharedFingerprint: [...fingerprints][0],
      spent: [
        (await repeatBudgetSpent(firstAttempt)).sameFingerprintCount,
        (await repeatBudgetSpent(secondAttempt)).sameFingerprintCount,
        (await repeatBudgetSpent(thirdAttempt)).sameFingerprintCount,
      ],
      unrelatedSpent: (await repeatBudgetSpent(unrelatedAttempt)).sameFingerprintCount,
      distinctFingerprintSpent: (await repeatBudgetSpent(fourthAttempt)).sameFingerprintCount,
      predecessorEvidenceUnchanged: true,
    };
  });

test('an exhausted lineage budget changes the diagnostic path instead of filing another successor',
  { timeout: 240_000 }, async () => {
    const project = await projectFixture('lineage-escalation');
    // A termination that keeps the goal actionable is where the repeat budget actually decides the
    // next action, so this is the branch a per-Task count silently disabled: every generation read
    // one and every generation answered RETRY, forever, without ever opening an obligation.
    const timedOut = { terminationKind: 'TIMED_OUT' };
    const links = [];
    // (b) the routed decision itself, not merely the existence of a new Task. The claim has to be
    // taken before the replacement is filed: 0210's sweep will not wake a superseded task, which
    // is also the order the coordinator works in -- route the failure, then file what it decided.
    const routes = [];
    let predecessor = null;
    for (const generation of ['one', 'two', 'three']) {
      const task = predecessor == null
        ? await executableTask(project, `escalation-generation-${generation}`)
        : await supersedingTask(project, predecessor, `escalation-generation-${generation}`);
      const sessionId = await workSession(project, task.id, `escalation-${generation}`);
      const attemptId = await acceptanceAttempt(project, sessionId, timedOut);
      const continuation = await db.taskExecutableContinuation.findUniqueOrThrow({
        where: { attemptId },
      });
      if (continuation.kind === 'DIAGNOSIS') {
        const observedAt = new Date();
        const claims = await courier.claimDue(
          `lineage-escalation:${randomUUID()}`, observedAt, 120, 64,
        );
        const claim = claims.find((candidate) => candidate.taskId === task.id);
        assert.ok(claim, `no continuation obligation was opened for ${task.id}`);
        routes.push(
          await controller.routeClaim(claim, observedAt, { failureNode: 'PRODUCT_SOURCE' }),
        );
      }
      // TIMED_OUT keeps the Task OPEN by construction, so the coordinator's reclaim is what
      // retires it before the replacement is filed. Only that recorded outcome is fixture state.
      await db.session.update({ where: { id: sessionId }, data: { status: RunStatus.FAILED } });
      await db.task.update({ where: { id: task.id }, data: { status: 'FAILED' } });
      links.push({ task, sessionId, attemptId, continuation });
      predecessor = task.id;
    }
    const byAttempt = new Map(links.map((link) => [link.attemptId, link.continuation]));
    assert.equal(byAttempt.get(links[0].attemptId).kind, 'RETRY');
    assert.equal(byAttempt.get(links[0].attemptId).reasonCode,
      'ATTEMPT_TIMED_OUT_RETRY_BUDGET_AVAILABLE');
    // The repeat is seen across the supersession, so the budget is spent and the next action stops
    // being an unchanged retry.
    for (const link of links.slice(1)) {
      assert.equal(byAttempt.get(link.attemptId).kind, 'DIAGNOSIS');
      assert.equal(byAttempt.get(link.attemptId).reasonCode,
        'ATTEMPT_TIMED_OUT_FINGERPRINT_REPEATED');
    }
    assert.equal(await db.taskExecutableContinuation.count({
      where: { taskId: { in: links.map((link) => link.task.id) }, kind: 'SUCCESSOR' },
    }), 0, 'an exhausted budget produced another same-shaped successor');

    // The second routed occurrence of this fingerprint leaves PRIMARY_RECOVERY for the alternate
    // diagnosis: the repeat is only visible because the count spans the supersession.
    assert.deepEqual(routes.map((route) => route.fingerprintOccurrence), [1, 2]);
    assert.deepEqual(routes.map((route) => route.diagnosticPath),
      ['PRIMARY_RECOVERY', 'ALTERNATE_DIAGNOSIS']);
    assert.equal(new Set(routes.map((route) => route.failureFingerprint)).size, 1);

    // Past a whole attempt budget of occurrences the runtime stops offering a successor at all —
    // the escalation only a lineage-wide count can reach, since one Task cannot exceed its own.
    const tail = links.at(-1);
    await db.task.update({ where: { id: tail.task.id }, data: { status: 'OPEN' } });
    const tailAttempts = [];
    for (let round = 0; round < 3; round += 1) {
      tailAttempts.push(await acceptanceAttempt(project, tail.sessionId, timedOut));
    }
    const tailRows = await db.taskExecutableAttempt.findMany({
      where: { id: { in: tailAttempts } },
      orderBy: { attemptNumber: 'asc' },
    });
    assert.deepEqual(tailRows.map((row) => row.attemptNumber), [2, 3, 4]);
    const tailContinuations = await db.taskExecutableContinuation.findMany({
      where: { attemptId: { in: tailAttempts } },
    });
    assert.equal(tailContinuations.length, 3);
    assert.equal(tailContinuations.every((row) => row.kind === 'DIAGNOSIS'), true);
    const exhausted = tailContinuations.filter((row) => (
      row.reasonCode === 'ATTEMPT_TIMED_OUT_LINEAGE_BUDGET_EXHAUSTED'
    ));
    assert.ok(exhausted.length > 0, 'the exhausted lineage budget never escalated');
    assert.equal(await db.taskExecutableContinuation.count({
      where: { taskId: tail.task.id, kind: 'SUCCESSOR' },
    }), 0);

    evidence.samples.lineageBudgetEscalations += exhausted.length;
    evidence.coverage.exhaustedBudgetChangesDiagnosticPath = true;
    evidence.results.lineageEscalation = {
      chainTaskIds: links.map((link) => link.task.id),
      continuationKinds: links.map((link) => byAttempt.get(link.attemptId).kind),
      continuationReasonCodes: links.map((link) => byAttempt.get(link.attemptId).reasonCode),
      diagnosticPaths: routes.map((route) => route.diagnosticPath),
      fingerprintOccurrences: routes.map((route) => route.fingerprintOccurrence),
      exhaustedReasonCodes: exhausted.map((row) => row.reasonCode),
      successorContinuations: 0,
    };
  });

test('the durable DAG contains no orphan, double-current, double-run or stale source edge', async () => {
  const audit = (await pool.query(`
    SELECT
      (SELECT count(*)::int FROM failure_successor_handoff h
        LEFT JOIN task source ON source.id=h.source_task_id
        LEFT JOIN task successor ON successor.id=h.successor_task_id
       WHERE source.id IS NULL OR successor.id IS NULL) AS orphan_handoffs,
      (SELECT count(*)::int FROM (
        SELECT lineage_root_task_id FROM failure_successor_current_binding
         GROUP BY lineage_root_task_id HAVING count(*) > 1
      ) duplicate) AS double_current,
      (SELECT count(*)::int FROM task_dependency edge
        JOIN failure_successor_handoff handoff
          ON handoff.source_task_id=edge.depends_on_task_id) AS stale_edges,
      (SELECT count(*)::int FROM (
        SELECT s.task_id FROM session s
         JOIN failure_successor_handoff h ON h.successor_task_id=s.task_id
        WHERE s.starts_task_work AND s.deleted_at IS NULL
          AND s.status IN ('PENDING','RUNNING','AWAITING_INPUT','INTERRUPTED')
        GROUP BY s.task_id HAVING count(*) > 1
      ) duplicate) AS double_active_runs,
      (SELECT count(*)::int FROM failure_successor_current_binding current_binding
        LEFT JOIN failure_successor_handoff handoff
          ON handoff.handoff_id=current_binding.handoff_id
         AND handoff.successor_task_id=current_binding.current_successor_task_id
         AND handoff.binding_generation=current_binding.binding_generation
       WHERE handoff.handoff_id IS NULL) AS orphan_current,
      (SELECT count(*)::int FROM failure_successor_dependency_rebind rebind
        LEFT JOIN failure_successor_handoff handoff ON handoff.handoff_id=rebind.handoff_id
       WHERE handoff.handoff_id IS NULL) AS orphan_rebinds
  `)).rows[0];
  assert.deepEqual(audit, {
    orphan_handoffs: 0,
    double_current: 0,
    stale_edges: 0,
    double_active_runs: 0,
    orphan_current: 0,
    orphan_rebinds: 0,
  });
  const currentRows = await db.failureSuccessorCurrentBinding.findMany();
  assert.equal(currentRows.length, 3);
  assert.equal(new Set(currentRows.map((row) => row.currentSuccessorTaskId)).size, 3);
  evidence.coverage.noOrphanDoubleActiveOrStaleEdge = true;
  evidence.coverage.productionWrites = false;
  evidence.results.integrityAudit = audit;
  evidence.results.currentBindings = currentRows.map((row) => ({
    lineageRootTaskId: row.lineageRootTaskId,
    currentSuccessorTaskId: row.currentSuccessorTaskId,
    bindingGeneration: String(row.bindingGeneration),
    bindingDigest: row.bindingDigest,
  }));
  assert.ok(Object.values(evidence.samples).every((count) => count > 0));
  assert.ok(Object.entries(evidence.coverage).every(([name, proven]) => (
    name === 'productionWrites' ? proven === false : proven === true
  )), JSON.stringify(evidence.coverage));
  evidence.outcome = 'PASS';
});
