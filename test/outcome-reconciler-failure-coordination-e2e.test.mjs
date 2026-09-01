import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { after } from 'node:test';

const require = createRequire(import.meta.url);
const repo = path.resolve(import.meta.dirname, '..');
const apiDist = path.join(repo, 'src/apiserver/dist');
const url = process.env.FAILURE_COORDINATION_PG_URL;
const evidencePath = process.env.FAILURE_COORDINATION_EVIDENCE_PATH;
const targetSha = process.env.FAILURE_COORDINATION_TARGET_SHA;
const expectedDatabase = process.env.FAILURE_COORDINATION_PG_EXPECTED_DATABASE;
const expectedUser = process.env.FAILURE_COORDINATION_PG_EXPECTED_USER;
const expectedSystemIdentifier = process.env.FAILURE_COORDINATION_PG_EXPECTED_SYSTEM_IDENTIFIER;
const startedAt = process.env.FAILURE_COORDINATION_STARTED_AT;

assert.ok(url, 'FAILURE_COORDINATION_PG_URL is required');
assert.ok(evidencePath, 'FAILURE_COORDINATION_EVIDENCE_PATH is required');
assert.match(targetSha ?? '', /^[0-9a-f]{40}$/);
assert.ok(expectedDatabase);
assert.ok(expectedUser);
assert.match(expectedSystemIdentifier ?? '', /^\d+$/);
assert.ok(Number.isFinite(Date.parse(startedAt ?? '')));

const { Pool } = require('pg');
const { prismaClientFor } = require(path.join(apiDist, 'prisma/prisma-client.js'));
const { TasksService } = require(path.join(apiDist, 'tasks/tasks.service.js'));
const { SessionsService } = require(path.join(apiDist, 'sessions/sessions.service.js'));
const { RunnerApiController } = require(path.join(apiDist, 'runner-api/runner-api.controller.js'));
const { ProjectsService } = require(path.join(apiDist, 'projects/projects.service.js'));
const { ProjectAcceptanceService } = require(path.join(
  apiDist,
  'projects/project-acceptance.service.js',
));
const { OutcomeSurfaceService } = require(path.join(
  apiDist,
  'outcome-reconciler/outcome-surface.service.js',
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
  FAILURE_COORDINATOR_CLAIM_SLA_SECONDS,
  failureCoordinationSemanticTuple,
  readFailureCoordination,
} = require(path.join(apiDist, 'common/failure-coordination-read.js'));
const {
  CreatorType,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  SessionRunSource,
} = require(path.join(apiDist, 'node_modules/@prisma/client'));

const db = prismaClientFor(url);
const pool = new Pool({ connectionString: url, max: 20 });
const controller = new FailureContinuationControllerService(db);
const courier = new FailureContinuationService(db, {});
const queue = { notifySessionQueued() {} };
const realtime = new Proxy({}, {
  get: (_target, property) => property === 'waitForInbox'
    ? async () => undefined
    : () => undefined,
});
const sessions = new SessionsService(db, queue, realtime);
const tasks = new TasksService(db, sessions, realtime);
const projects = new ProjectsService(db);
const acceptance = new ProjectAcceptanceService(db);
const surfaces = new OutcomeSurfaceService(db, {}, acceptance);
const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'orbit-prepare-postgres-'));
const prepareScript = path.join(fixtureRoot, 'prepare-postgres.cjs');

const evidence = {
  schemaVersion: 1,
  suite: 'failure-coordination-e2e-v1',
  outcome: 'INCOMPLETE',
  targetSha,
  postgres: {
    required: true,
    connected: false,
    database: null,
    user: null,
    systemIdentifier: null,
    migrations: Number(process.env.FAILURE_COORDINATION_MIGRATION_COUNT ?? 0),
    lastMigration: process.env.FAILURE_COORDINATION_LAST_MIGRATION ?? null,
  },
  observationWindow: {
    startedAt,
    finishedAt: null,
    durationMilliseconds: null,
  },
  samples: {
    webTests: Number(process.env.FAILURE_COORDINATION_WEB_TESTS ?? 0),
    apiTests: Number(process.env.FAILURE_COORDINATION_API_TESTS ?? 0),
    e2eTests: 0,
    failedAttempts: 0,
    coordinatorWakes: 0,
    uniqueSuccessors: 0,
    semanticSurfaces: 0,
    staleCoordinators: 0,
    convergenceGenerations: 0,
    ownerOnlyInboxItems: 0,
    duplicateCtaExecutions: 0,
    expiredCtas: 0,
  },
  coverage: {
    isolatedProjectAndDatabase: false,
    preparePostgresPrismaConfigFailure: false,
    failedAttemptPreserved: false,
    coordinatorWokenWithinSla: false,
    uniqueAutomaticSuccessor: false,
    dependencyRebound: false,
    repairedFixtureResumed: false,
    mixedClientSemanticParity: false,
    ordinaryFailureOutsideNeedsYou: false,
    staleCoordinatorInAttention: false,
    threeGenerationConvergenceInAttention: false,
    ownerOnlyInDecisionInbox: false,
    duplicateCtaIdempotent: false,
    expiredCtaSafe: false,
    productionWrites: false,
  },
  results: {},
};

let primary;

after(async () => {
  await db.$disconnect();
  await pool.end();
  rmSync(fixtureRoot, { recursive: true, force: true });
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

async function projectFixture(label) {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@failure-coordination.invalid`,
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
      maxConcurrent: 12,
      capabilities: [],
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
      goal: `${label} disposable goal`,
      acceptanceCriteria: 'The isolated prepare-postgres fixture completes.',
      coordinatorEnabled: true,
      coordinatorWorkspaceId: workspaceId,
      sessionBudgetPerDay: null,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  const definition = await db.projectAcceptanceCriterionDefinition.findFirstOrThrow({
    where: { projectId },
    orderBy: { ordinal: 'asc' },
    select: { contentHash: true },
  });
  return {
    label,
    ownerId,
    runnerId,
    workspaceId,
    projectId,
    criterionKey: definition.contentHash.slice(0, 32),
  };
}

function executableTask(project, title, options = {}) {
  return tasks.create(project.ownerId, {
    title,
    description: `${title} in the disposable failure-coordination fixture`,
    projectId: project.projectId,
    assigneeId: project.workspaceId,
    completionCriterion: 'EXECUTABLE',
    acceptanceCriteria: 'The isolated command exits with code zero.',
    acceptanceCommand: options.command ?? 'node -e "process.exit(1)"',
    acceptanceExpectedExitCode: 0,
    acceptanceTimeoutSeconds: 120,
    acceptanceOwnerTimeoutCeilingSeconds: 120,
    dependsOnTaskIds: options.dependsOnTaskIds,
    autoRunWhenReady: options.autoRunWhenReady,
  });
}

async function recordFailure(project, task, label, rawOutput, { claim = true } = {}) {
  const sessionId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId,
      ownerId: project.ownerId,
      creatorId: project.ownerId,
      taskId: task.id,
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
  const messageTurnId = randomUUID();
  await db.conversationTurn.create({
    data: {
      id: messageTurnId,
      sessionId,
      seq: 1,
      clientTurnId: `message:${messageTurnId}`,
      kind: 'message',
      content: 'run the isolated prepare-postgres fixture',
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
  const completed = await api.turnComplete({ id: project.runnerId }, sessionId, {
    turnId: delivery.turnId,
    status: RunStatus.SUCCEEDED,
    subtype: 'shell',
    shellOutput: rawOutput,
    acceptanceAdmissionId: delivery.acceptancePlan.admissionId,
    acceptanceAttemptId: started.attemptId,
    acceptanceTerminationKind: 'EXITED',
    acceptanceActualExitCode: 1,
    acceptanceSignal: null,
  });
  assert.equal(completed.status, RunStatus.FAILED);
  const receipt = await db.failureContinuationAttemptReceipt.findUniqueOrThrow({
    where: { attemptId: started.attemptId },
  });
  evidence.samples.failedAttempts += 1;
  if (!claim) return { project, task, sessionId, attemptId: started.attemptId, receipt };
  const observedAt = new Date();
  const claims = await courier.claimDue(
    `failure-coordination:${label}:${randomUUID()}`,
    observedAt,
    120,
    64,
  );
  const continuationClaim = claims.find((candidate) => candidate.taskId === task.id);
  assert.ok(continuationClaim, `canonical continuation was not claimed for ${label}`);
  return {
    project,
    task,
    sessionId,
    attemptId: started.attemptId,
    receipt,
    claim: continuationClaim,
    observedAt,
  };
}

async function routeFailure(failure, observation) {
  const route = await controller.routeClaim(failure.claim, failure.observedAt, observation);
  return { ...failure, route };
}

async function deliverFailure(failure) {
  const sessionId = failure.claim.plannedSessionId;
  const wakeId = randomUUID();
  const fact = failureContinuationWakeFact(failure.claim, failure.route);
  await db.session.create({
    data: {
      id: sessionId,
      ownerId: failure.project.ownerId,
      creatorId: failure.project.ownerId,
      workspaceId: failure.project.workspaceId,
      assignedRunnerId: failure.project.runnerId,
      title: `failure-coordinator-${failure.project.label}`,
      prompt: `diagnose ${failure.claim.obligationId}`,
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
      projectId: failure.project.projectId,
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
  const deliveredAt = new Date();
  const ack = (await pool.query(
    `SELECT failure_continuation_ack_wakeup(
       $1::uuid,$2::uuid,$3::bigint,$4::uuid,$5::uuid,$6::timestamptz
     ) AS applied`,
    [
      failure.claim.outboxId,
      failure.claim.leaseToken,
      String(failure.claim.leaseGeneration),
      wakeId,
      sessionId,
      deliveredAt,
    ],
  )).rows[0].applied;
  assert.equal(ack, true);
  return { ...failure, coordinatorSessionId: sessionId, wakeId, deliveredAt };
}

function successorDto(failure, title) {
  return {
    title,
    description: `Repair successor for ${failure.task.id}`,
    projectId: failure.project.projectId,
    assigneeId: failure.project.workspaceId,
    criterionKey: failure.project.criterionKey,
    completionCriterion: 'EXECUTABLE',
    acceptanceCriteria: 'The repaired prepare-postgres command exits with code zero.',
    acceptanceCommand: `${process.execPath} ${prepareScript}`,
    acceptanceExpectedExitCode: 0,
    acceptanceTimeoutSeconds: 120,
    acceptanceOwnerTimeoutCeilingSeconds: 120,
    supersedesTaskId: failure.task.id,
    failureSuccessorHandoff: {
      obligationId: failure.claim.obligationId,
      obligationRevision: failure.claim.idempotencyKey,
      routeDecisionId: failure.route.decisionId,
      routeDecisionDigest: failure.route.decisionDigest,
    },
  };
}

function semanticFromIndex(container, obligationId) {
  return container.semanticIndex.find((entry) => entry.obligationId === obligationId);
}

test('suite is bound to one disposable PostgreSQL identity and missing prisma/config is real', async () => {
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
  evidence.postgres.connected = true;
  evidence.postgres.database = identity.database;
  evidence.postgres.user = identity.user;
  evidence.postgres.systemIdentifier = identity.systemIdentifier;
  writeFileSync(
    prepareScript,
    "const { defineConfig } = require('prisma/config');\n" +
      "const value = defineConfig({ datasource: { url: 'postgresql://fixture' } });\n" +
      "if (!value) process.exit(2);\n",
  );
  const failed = spawnSync(process.execPath, [prepareScript], {
    cwd: fixtureRoot,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: '' },
  });
  assert.notEqual(failed.status, 0);
  assert.match(`${failed.stdout}\n${failed.stderr}`, /prisma\/config/);
  evidence.coverage.isolatedProjectAndDatabase = true;
  evidence.coverage.preparePostgresPrismaConfigFailure = true;
  evidence.results.fixtureFailure = {
    status: failed.status,
    outputDigest: sha256(`${failed.stdout}\n${failed.stderr}`),
  };
  evidence.samples.e2eTests += 1;
});

test('prepare-postgres failure wakes, diagnoses, rebinds once and resumes without owner action',
  { timeout: 120_000 }, async () => {
    const initial = spawnSync(process.execPath, [prepareScript], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: '' },
    });
    const rawOutput = `${initial.stdout}\n${initial.stderr}`;
    const project = await projectFixture('prepare-postgres');
    const source = await executableTask(project, 'prepare-postgres', {
      command: `${process.execPath} ${prepareScript}`,
    });
    const downstream = await executableTask(project, 'continue-after-postgres', {
      command: 'node -e "process.exit(0)"',
      dependsOnTaskIds: [source.id],
      autoRunWhenReady: true,
    });
    const failure = await recordFailure(project, source, 'prepare-postgres', rawOutput);
    const wakeLatencyMs = failure.observedAt.getTime() - failure.receipt.terminatedAt.getTime();
    assert.ok(wakeLatencyMs >= 0);
    assert.ok(wakeLatencyMs <= FAILURE_COORDINATOR_CLAIM_SLA_SECONDS * 1_000);
    const routed = await routeFailure(failure, {});
    assert.equal(routed.route.failureNode, 'FIXTURE_SETUP');
    assert.equal(routed.route.failureDomain, 'EVALUATION_HARNESS');
    const delivered = await deliverFailure(routed);
    const ackLatencyMs = delivered.deliveredAt.getTime() - failure.receipt.terminatedAt.getTime();
    assert.ok(ackLatencyMs <= FAILURE_COORDINATOR_CLAIM_SLA_SECONDS * 1_000);

    const prismaPackage = path.join(fixtureRoot, 'node_modules/prisma');
    mkdirSync(prismaPackage, { recursive: true });
    writeFileSync(
      path.join(prismaPackage, 'package.json'),
      JSON.stringify({ name: 'prisma', version: '0.0.0-fixture', exports: { './config': './config.js' } }),
    );
    writeFileSync(path.join(prismaPackage, 'config.js'), 'exports.defineConfig = value => value;\n');
    const repaired = spawnSync(process.execPath, [prepareScript], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: '' },
    });
    assert.equal(repaired.status, 0, repaired.stderr);

    const dto = successorDto(delivered, 'repair prisma/config fixture');
    const first = await tasks.create(
      project.ownerId,
      dto,
      { type: CreatorType.AGENT, id: project.workspaceId },
      delivered.coordinatorSessionId,
    );
    const replay = await tasks.create(
      project.ownerId,
      dto,
      { type: CreatorType.AGENT, id: project.workspaceId },
      delivered.coordinatorSessionId,
    );
    assert.equal(replay.id, first.id);
    const [sourceRow, attemptRow, handoffs, binding, dependency, successorRuns] = await Promise.all([
      db.task.findUniqueOrThrow({ where: { id: source.id } }),
      db.taskExecutableAttempt.findUniqueOrThrow({ where: { id: failure.attemptId } }),
      db.failureSuccessorHandoff.findMany({
        where: { obligationId: failure.claim.obligationId },
      }),
      db.failureSuccessorCurrentBinding.findUniqueOrThrow({
        where: { lineageRootTaskId: source.id },
      }),
      db.taskDependency.findFirstOrThrow({ where: { taskId: downstream.id } }),
      db.session.findMany({ where: { taskId: first.id, startsTaskWork: true } }),
    ]);
    assert.equal(sourceRow.status, 'FAILED');
    assert.equal(sourceRow.supersededByTaskId, first.id);
    assert.equal(attemptRow.rawOutput, rawOutput);
    assert.equal(attemptRow.terminationKind, 'EXITED');
    assert.equal(handoffs.length, 1);
    assert.equal(binding.currentSuccessorTaskId, first.id);
    assert.equal(dependency.dependsOnTaskId, first.id);
    assert.equal(successorRuns.length, 1);
    assert.equal(handoffs[0].requiresOwner, false);
    assert.equal(handoffs[0].autoDispatchRequested, true);

    primary = { project, source, downstream, failure: delivered, successor: first, handoff: handoffs[0] };
    evidence.samples.coordinatorWakes += 1;
    evidence.samples.uniqueSuccessors += handoffs.length;
    evidence.samples.duplicateCtaExecutions += 2;
    evidence.coverage.failedAttemptPreserved = true;
    evidence.coverage.coordinatorWokenWithinSla = true;
    evidence.coverage.uniqueAutomaticSuccessor = true;
    evidence.coverage.dependencyRebound = true;
    evidence.coverage.repairedFixtureResumed = true;
    evidence.coverage.duplicateCtaIdempotent = true;
    evidence.results.primary = {
      obligationId: failure.claim.obligationId,
      sourceTaskId: source.id,
      successorTaskId: first.id,
      bindingDigest: handoffs[0].bindingDigest,
      wakeLatencyMs,
      ackLatencyMs,
      repairedExitCode: repaired.status,
      duplicateReturnedTaskId: replay.id,
    };
    evidence.samples.e2eTests += 1;
  });

test('task, project, attention, agent queue and decision inbox share one semantic tuple',
  { timeout: 120_000 }, async () => {
    const obligationId = primary.failure.claim.obligationId;
    const [taskDetail, workOverview, projectAttention, agentQueue, decisionInbox] = await Promise.all([
      tasks.get(primary.project.ownerId, primary.source.id),
      projects.panorama(primary.project.ownerId, primary.project.projectId),
      surfaces.readFailureProjectSurface(
        primary.project.ownerId,
        primary.project.projectId,
        'PROJECT_ATTENTION',
      ),
      surfaces.readFailureProjectSurface(
        primary.project.ownerId,
        primary.project.projectId,
        'AGENT_QUEUE',
      ),
      surfaces.humanInbox(primary.project.ownerId, 100),
    ]);
    const tuple = semanticFromIndex(taskDetail.failureCoordination, obligationId);
    const compared = [
      semanticFromIndex(workOverview.failureCoordination, obligationId),
      semanticFromIndex(projectAttention, obligationId),
      semanticFromIndex(agentQueue, obligationId),
      decisionInbox.failureContinuationIndex.find((entry) => entry.obligationId === obligationId),
    ];
    assert.ok(tuple);
    for (const candidate of compared) assert.deepEqual(candidate, tuple);
    const card = taskDetail.failureCoordination.items.find((item) => item.obligationId === obligationId);
    assert.equal(card.stage, 'AUTOMATIC_REVALIDATION');
    assert.equal(card.successor.taskId, primary.successor.id);
    assert.equal(card.failedAttempt.preserved, true);
    assert.equal(agentQueue.items.length, 1);
    assert.equal(projectAttention.items.length, 0);
    assert.equal(
      decisionInbox.items.filter((item) => item.itemType === 'FAILURE_CONTINUATION_OWNER_DECISION').length,
      0,
    );
    evidence.samples.semanticSurfaces = 5;
    evidence.coverage.mixedClientSemanticParity = true;
    evidence.coverage.ordinaryFailureOutsideNeedsYou = true;
    evidence.results.semanticTuple = failureCoordinationSemanticTuple(card);
    evidence.samples.e2eTests += 1;
  });

test('coordinator SLA stale and third unchanged generation alone enter Project Attention',
  { timeout: 120_000 }, async () => {
    const staleProject = await projectFixture('stale-coordinator');
    const staleTask = await executableTask(staleProject, 'stale-source');
    const staleFailure = await recordFailure(
      staleProject,
      staleTask,
      'stale-source',
      'isolated coordinator stale failure\n',
      { claim: false },
    );
    await pool.query(
      `UPDATE failure_continuation_wakeup_outbox
          SET created_at = statement_timestamp() - ($2::integer * interval '1 second'),
              available_at = statement_timestamp() - ($2::integer * interval '1 second')
        WHERE obligation_id = (
          SELECT obligation_id FROM failure_continuation_obligation WHERE receipt_id=$1::uuid
        )`,
      [staleFailure.receipt.receiptId, FAILURE_COORDINATOR_CLAIM_SLA_SECONDS + 1],
    );
    const staleAttention = await surfaces.readFailureProjectSurface(
      staleProject.ownerId,
      staleProject.projectId,
      'PROJECT_ATTENTION',
    );
    assert.equal(staleAttention.items.length, 1);
    assert.equal(staleAttention.items[0].attention.reasonCode, 'COORDINATOR_SLA_UNCLAIMED');

    const convergenceProject = await projectFixture('three-generation');
    const routes = [];
    for (let generation = 1; generation <= 3; generation += 1) {
      const task = await executableTask(convergenceProject, `convergence-${generation}`, {
        command: 'node -e "process.exit(9)"',
      });
      const failed = await recordFailure(
        convergenceProject,
        task,
        `convergence-${generation}`,
        '503 service unavailable\n',
      );
      routes.push(await controller.routeClaim(failed.claim, failed.observedAt, {
        failureNode: 'EXTERNAL_SERVICE',
      }));
    }
    assert.deepEqual(routes.map((route) => route.unchangedEvidenceGenerations), [1, 2, 3]);
    assert.equal(routes[2].projectAttention, true);
    const convergenceAttention = await surfaces.readFailureProjectSurface(
      convergenceProject.ownerId,
      convergenceProject.projectId,
      'PROJECT_ATTENTION',
    );
    assert.equal(convergenceAttention.items.length, 1);
    assert.equal(convergenceAttention.items[0].attention.reasonCode, 'CONVERGENCE_FAILED');
    const convergenceInbox = await surfaces.readFailureProjectSurface(
      convergenceProject.ownerId,
      convergenceProject.projectId,
      'OWNER_DECISION_INBOX',
    );
    assert.equal(convergenceInbox.items.length, 0);
    evidence.samples.staleCoordinators = staleAttention.items.length;
    evidence.samples.convergenceGenerations = routes.length;
    evidence.coverage.staleCoordinatorInAttention = true;
    evidence.coverage.threeGenerationConvergenceInAttention = true;
    evidence.results.attention = {
      stale: staleAttention.items[0].attention.reasonCode,
      convergence: convergenceAttention.items[0].attention.reasonCode,
      convergenceGeneration: routes[2].unchangedEvidenceGenerations,
    };
    evidence.samples.e2eTests += 1;
  });

test('owner-only enters both attention and decision inbox; its expired CTA is inert',
  { timeout: 120_000 }, async () => {
    const project = await projectFixture('owner-only');
    const task = await executableTask(project, 'owner-boundary');
    const failed = await recordFailure(project, task, 'owner-boundary', 'goal boundary\n');
    const routed = await routeFailure(failed, {
      failureNode: 'GOAL_BOUNDARY',
      ownerReason: 'GOAL_DECISION',
    });
    const [attention, inbox, combined] = await Promise.all([
      surfaces.readFailureProjectSurface(project.ownerId, project.projectId, 'PROJECT_ATTENTION'),
      surfaces.readFailureProjectSurface(project.ownerId, project.projectId, 'OWNER_DECISION_INBOX'),
      surfaces.humanInbox(project.ownerId, 100),
    ]);
    assert.equal(attention.items.length, 1);
    assert.equal(inbox.items.length, 1);
    assert.equal(inbox.items[0].attention.reasonCode, 'OWNER_ONLY_DECISION');
    const combinedFailures = combined.items.filter(
      (item) => item.itemType === 'FAILURE_CONTINUATION_OWNER_DECISION',
    );
    assert.equal(combinedFailures.length, 1);
    assert.deepEqual(
      failureCoordinationSemanticTuple(attention.items[0]),
      failureCoordinationSemanticTuple(inbox.items[0]),
    );
    const expired = await readFailureCoordination(db, {
      tenantId: project.ownerId,
      projectIds: [project.projectId],
      surface: 'TASK_DETAIL',
      observedAt: new Date(Date.parse(routed.route.deadlineAt) + 1),
    });
    assert.equal(expired.items[0].cta, null);
    assert.equal(expired.items[0].ctaUnavailableReason, 'CTA_EXPIRED');
    assert.equal(expired.items[0].obligationRevision, routed.claim.idempotencyKey);
    evidence.samples.ownerOnlyInboxItems = combinedFailures.length;
    evidence.samples.expiredCtas += 1;
    evidence.coverage.ownerOnlyInDecisionInbox = true;
    evidence.coverage.expiredCtaSafe = true;
    evidence.results.ownerOnly = {
      obligationId: routed.claim.obligationId,
      attentionReason: attention.items[0].attention.reasonCode,
      inboxReason: inbox.items[0].canonicalReason.code,
      expiredCtaUnavailableReason: expired.items[0].ctaUnavailableReason,
    };
    evidence.samples.e2eTests += 1;

    assert.ok(Object.values(evidence.samples).every((count) => count > 0));
    assert.ok(Object.entries(evidence.coverage).every(([name, proven]) => (
      name === 'productionWrites' ? proven === false : proven === true
    )));
    evidence.outcome = 'PASS';
  });
