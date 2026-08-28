import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { after } from 'node:test';

const require = createRequire(import.meta.url);
const repo = path.resolve(import.meta.dirname, '..');
const apiDist = path.join(repo, 'src/apiserver/dist');
const deadmanPath = path.join(repo, 'scripts/executable-acceptance-dead-man.mjs');
const url = process.env.EXECUTABLE_ACCEPTANCE_PG_URL;
const evidencePath = process.env.EXECUTABLE_ACCEPTANCE_EVIDENCE_PATH;
const rollingEvidencePath = process.env.EXECUTABLE_ACCEPTANCE_ROLLING_EVIDENCE_PATH;
const sourceSha = process.env.EXECUTABLE_ACCEPTANCE_SOURCE_SHA;
assert.ok(url, 'EXECUTABLE_ACCEPTANCE_PG_URL is required');
assert.ok(evidencePath, 'EXECUTABLE_ACCEPTANCE_EVIDENCE_PATH is required');
assert.match(sourceSha ?? '', /^[0-9a-f]{40}$/);

const { Pool } = require('pg');
const { prismaClientFor } = require(path.join(apiDist, 'prisma/prisma-client.js'));
const { TasksService } = require(path.join(apiDist, 'tasks/tasks.service.js'));
const { TaskCompletionEvidenceService, normalizeCompletionEvidence } = require(path.join(
  apiDist, 'tasks/task-completion-evidence.service.js',
));
const { ProjectsService } = require(path.join(apiDist, 'projects/projects.service.js'));
const { SessionsService } = require(path.join(apiDist, 'sessions/sessions.service.js'));
const { RunnerApiController } = require(path.join(apiDist, 'runner-api/runner-api.controller.js'));
const { HTTP_CODE_METADATA } = require('@nestjs/common/constants');
const { OutcomeWatchdogService } = require(path.join(
  apiDist, 'outcome-watchdog/outcome-watchdog.service.js',
));
const runtime = require(path.join(apiDist, 'tasks/executable-acceptance-runtime.js'));
const { RunStatus, RunnerStatus, SessionDispatchOrigin, TaskStatus } = require(path.join(
  repo, 'src/apiserver/node_modules/@prisma/client',
));

const db = prismaClientFor(url);
const pool = new Pool({ connectionString: url, max: 8 });
const evidence = {
  schemaVersion: 1,
  suite: 'executable-acceptance-runtime-v2',
  sourceSha,
  negotiation: {},
  typedTerminations: [],
  persistedTypedAttempts: [],
  supersessionSurfaces: {},
  watchdog: {},
  completionAck: {},
  legacy: {},
  compatibility: {},
};

after(async () => {
  await db.$disconnect();
  await pool.end();
  if (rollingEvidencePath) {
    const rollingEvidence = JSON.parse(readFileSync(rollingEvidencePath, 'utf8'));
    Object.assign(evidence.compatibility, rollingEvidence.compatibility ?? {});
  }
  mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
});

function sha(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

const watchdogModuleGraphDigest = sha([
  'outcome-watchdog/main',
  'outcome-watchdog/worker-module',
  'outcome-watchdog/runner',
  'outcome-watchdog/service',
  'prisma',
].sort().join('\n'));

const coordinatorModuleGraphDigest = sha([
  'outcome-coordinator/main',
  'outcome-coordinator/worker-module',
  'outcome-coordinator/runner',
  'outcome-coordinator/completion-ack-resolver',
  'outcome-reconciler/persistent-coordinator',
  'projects/coordinator-judgment',
  'prisma',
].sort().join('\n'));

test('turn-complete success is an explicit HTTP 200 contract', () => {
  assert.equal(
    Reflect.getMetadata(HTTP_CODE_METADATA, RunnerApiController.prototype.turnComplete),
    200,
  );
  evidence.completionAck.httpSuccessStatus = 200;
});

function runDeadman(args) {
  const child = spawnSync(process.execPath, [
    deadmanPath,
    '--database-url', url,
    '--source-sha', sourceSha,
    ...args,
  ], { cwd: repo, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  return JSON.parse(child.stdout);
}

function registerRuntimeExpectation({
  component,
  instanceId,
  generation,
  moduleGraphDigest = watchdogModuleGraphDigest,
  startupGraceSeconds = 5,
}) {
  return runDeadman([
    '--register-expectation',
    '--component', component,
    '--instance-id', instanceId,
    '--generation', generation,
    '--expected-source-sha', sourceSha,
    '--module-graph-digest', moduleGraphDigest,
    '--startup-grace-seconds', String(startupGraceSeconds),
  ]);
}

async function waitPast(timestamp, marginMs = 100) {
  const delay = new Date(timestamp).getTime() + marginMs - Date.now();
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

async function empty() {
  await pool.query(`
    TRUNCATE executable_runtime_expectation_event, executable_runtime_expectation,
             completion_ack_obligation_event, completion_ack_fact,
             completion_ack_obligation_revision,
             executable_dead_man_event, executable_runtime_heartbeat, task, session, workspace,
             runner, project, "user" RESTART IDENTITY CASCADE
  `);
}

function realtime() {
  return {
    publishSessionUpdated() {}, publishTaskChanged() {}, publishQueuedTurnsChanged() {},
    publishSessionCreated() {}, publishWorkspaceChanged() {},
    publish() {}, publishForUser() {}, notifyInbox() {}, waitForInbox: async () => undefined,
  };
}

function tasks(sessions = {}) {
  return new TasksService(db, sessions, realtime());
}

function controller(completionAckMonitor) {
  return new RunnerApiController(
    db,
    { notifySessionQueued() {} },
    realtime(),
    {}, {}, {},
    { appendFor: async (_tx, _sessionId, content) => content },
    undefined, undefined, undefined, completionAckMonitor,
  );
}

async function foundation(label, withProject = false) {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@acceptance.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: { id: runnerId, ownerId, name: `${label}-runner`, tokenHash: 'x', status: RunnerStatus.ONLINE },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true },
  });
  let projectId = null;
  if (withProject) {
    projectId = randomUUID();
    await db.project.create({ data: { id: projectId, ownerId, title: `${label}-project` } });
    await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  }
  return { ownerId, runnerId, workspaceId, projectId };
}

async function executableFixture(label, options = {}) {
  const base = await foundation(label, options.withProject === true);
  const task = await tasks().create(base.ownerId, {
    title: label,
    assigneeId: base.workspaceId,
    completionCriterion: 'EXECUTABLE',
    acceptanceCriteria: 'The declared shell command exits with the expected code.',
    acceptanceCommand: options.command ?? 'true',
    acceptanceExpectedExitCode: options.expectedExitCode ?? 0,
    ...(base.projectId ? { projectId: base.projectId } : {}),
    ...(options.legacy ? {} : {
      acceptanceTimeoutSeconds: options.timeoutSeconds ?? 1200,
      acceptanceOwnerTimeoutCeilingSeconds: options.ownerCeilingSeconds
        ?? options.timeoutSeconds ?? 1200,
    }),
  });
  const sessionId = randomUUID();
  const messageTurnId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId, ownerId: base.ownerId, creatorId: base.ownerId, taskId: task.id,
      workspaceId: base.workspaceId, assignedRunnerId: base.runnerId, title: label, prompt: label,
      provider: 'claude', status: RunStatus.RUNNING,
      engineTurnActive: true,
      dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
    },
  });
  await db.conversationTurn.create({
    data: {
      id: messageTurnId, sessionId, seq: 1, clientTurnId: `message:${messageTurnId}`,
      kind: 'message', content: 'finish work', status: 'IN_FLIGHT',
    },
  });
  return { ...base, taskId: task.id, sessionId, messageTurnId };
}

async function queueAcceptance(api, fixture) {
  await api.turnComplete({ id: fixture.runnerId }, fixture.sessionId, {
    turnId: fixture.messageTurnId, status: RunStatus.SUCCEEDED,
  });
}

async function dequeue(
  api,
  fixture,
  hardMaxSeconds,
  capabilityRevision = 2,
  leaseGeneration = null,
) {
  return api.dequeueTurn(
    fixture.sessionId, fixture.runnerId, leaseGeneration, false, [], hardMaxSeconds == null ? null : {
      schemaRevision: 2, capabilityRevision, hardMaxSeconds, runnerSha: sourceSha,
    },
  );
}

async function admitAndStart(label, options = {}) {
  const fixture = await executableFixture(label, options);
  const api = controller();
  await queueAcceptance(api, fixture);
  const delivery = await dequeue(api, fixture, options.hardMaxSeconds ?? 3600);
  assert.ok(delivery?.acceptancePlan, `${label} was not admitted`);
  const started = await api.startExecutableAcceptanceAttempt(
    { id: fixture.runnerId }, fixture.sessionId, delivery.acceptancePlan.admissionId,
  );
  return { fixture, api, delivery, started };
}

async function forceStatus(taskId, status) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query('UPDATE task SET status = $2::task_status WHERE id = $1', [taskId, status]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function backdateRunEventIngestion(eventId, seconds) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Test-only clock fixture: production ingestion time is DB-owned and immutable. The disposable
    // acceptance database disables user triggers only long enough to place an event beyond Δ.
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query(
      `UPDATE run_event
          SET ingested_at = clock_timestamp() - ($2::integer * interval '1 second')
        WHERE id = $1::uuid`,
      [eventId, seconds],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function completionAckFixture(label, options = {}) {
  const fixture = await executableFixture(label, {
    legacy: true,
    withProject: true,
    command: options.command ?? 'true',
    expectedExitCode: options.expectedExitCode ?? 0,
  });
  await db.project.update({
    where: { id: fixture.projectId },
    data: {
      coordinatorEnabled: true,
      coordinatorWorkspaceId: fixture.workspaceId,
      automationPolicy: 'GUARDED_AUTO',
    },
  });
  const api = controller();
  const leaseGeneration = options.exactLease ? randomUUID() : null;
  const leaseOwner = options.exactLease ? randomUUID() : null;
  await queueAcceptance(api, fixture);
  if (leaseGeneration && leaseOwner) {
    await api.takeoverLeases(
      { id: fixture.runnerId },
      fixture.sessionId,
      { leaseOwner, expectedLeaseOwner: null },
    );
    await api.activateLeases(
      { id: fixture.runnerId },
      fixture.sessionId,
      { leaseGeneration, leaseOwner },
    );
  }
  const delivery = await dequeue(api, fixture, null, 2, leaseGeneration);
  const turn = await db.conversationTurn.findUniqueOrThrow({ where: { id: delivery.turnId } });
  const rawOutput = options.rawOutput ?? '16 tests\n16 pass\n0 fail\n';
  const actualExitCode = options.actualExitCode ?? 0;
  const event = await db.runEvent.create({
    data: {
      sessionId: fixture.sessionId,
      turnId: delivery.turnId,
      seq: 1,
      type: 'tool_result',
      payload: {
        toolUseId: options.toolUseId ?? `shell-${delivery.turnId}`,
        content: rawOutput,
        isError: options.isError ?? actualExitCode !== 0,
      },
      ingestedByRunnerId: fixture.runnerId,
      // A legacy runner may have no lease-generation handshake. Exact runner provenance and
      // inferred lease provenance are intentionally independent.
      ingestedUnderLeaseGeneration: turn.leaseGeneration,
    },
  });
  if (options.ingestionAgeSeconds != null) {
    await backdateRunEventIngestion(event.id, options.ingestionAgeSeconds);
  }
  return {
    fixture,
    delivery,
    turn,
    event,
    rawOutput,
    actualExitCode,
    leaseGeneration,
    leaseOwner,
  };
}

async function seedExistingExecutableRequest(
  fixture,
  delivery,
  {
    command = 'true',
    expectedExitCode = 0,
    actualExitCode = expectedExitCode,
    rawOutput,
    recordedById = fixture.runnerId,
    decide = false,
    evidenceOverride,
    label = randomUUID(),
  },
) {
  const evidenceService = new TaskCompletionEvidenceService(db);
  await evidenceService.submit(
    fixture.ownerId,
    fixture.taskId,
    { type: 'AGENT', id: fixture.workspaceId },
    {
      sourceSessionId: fixture.sessionId,
      idempotencyKey: `existing-open:${label}:${delivery.turnId}`,
      // Deliberately not the bridge evidence shape. Recovery authority is the exact decided
      // request/result plus its persisted v1 turn and runner event, never a magic source label.
      evidence: evidenceOverride ?? {
        source: 'ROLLING_UPGRADE_PREEXISTING_REQUEST',
        turnId: delivery.turnId,
        rawOutputDigest: sha(rawOutput),
      },
    },
  );
  let request = await db.taskJudgmentRequest.findFirstOrThrow({
    where: { taskId: fixture.taskId, status: 'OPEN' },
  });
  await db.taskExecutableJudgmentResult.create({ data: {
    id: randomUUID(), requestId: request.id, command, expectedExitCode,
    actualExitCode, rawOutput, recordedById,
  } });
  if (decide) {
    request = await db.taskJudgmentRequest.update({
      where: { id: request.id },
      data: {
        status: 'DECIDED',
        decidedAt: new Date(),
        decidedByType: 'SYSTEM',
        decidedById: recordedById,
        decision: actualExitCode === expectedExitCode ? 'PASS' : 'FAIL',
      },
    });
  }
  return request;
}

function exactLegacyV1Evidence(state, rawOutput, actualExitCode = 0) {
  const { fixture, delivery, turn } = state;
  return normalizeCompletionEvidence({
    schemaVersion: 1,
    source: 'LEGACY_V1_TURN_COMPLETE',
    protocol: {
      name: 'legacy-executable-acceptance',
      version: 1,
      typedAttempt: false,
    },
    binding: {
      tenantId: fixture.ownerId,
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      sessionId: fixture.sessionId,
      turnId: delivery.turnId,
      turnClientId: turn.clientTurnId,
      turnLeaseGeneration: turn.leaseGeneration,
      runnerId: fixture.runnerId,
      assignedRunnerId: fixture.runnerId,
      workspaceId: fixture.workspaceId,
    },
    observation: {
      command: 'true',
      commandDigest: sha('true'),
      expectedExitCode: 0,
      actualExitCode,
      rawOutputDigest: sha(rawOutput),
      rawOutputBytes: Buffer.byteLength(rawOutput, 'utf8'),
      evidenceSource: 'RUNNER_TURN_COMPLETE_CALLBACK',
    },
  });
}

async function markTurnAnswered(sessionId, turnId) {
  await db.conversationTurn.update({
    where: { id: turnId },
    data: { status: 'ANSWERED', answeredAt: new Date() },
  });
  const turn = await db.conversationTurn.findUniqueOrThrow({ where: { id: turnId } });
  assert.equal(turn.sessionId, sessionId);
}

async function assertSqlRejected(sql, params, expected) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assert.rejects(client.query(sql, params), expected);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

test('virtual negotiation rejects hardMax=120 before spawn and admits hardMax=1200 exactly', () => {
  const plan = runtime.executableEvaluationPlan({
    command: 'npm run test:outcome-reconciler:watchdog', expectedExitCode: 0,
    requestedTimeoutSeconds: 1200, ownerTimeoutCeilingSeconds: 1200,
    policyTimeoutCeilingSeconds: 3600,
  });
  const clock = new Date('2026-08-28T12:00:00.000Z');
  const rejected = runtime.negotiateExecutableAcceptance(plan, {
    schemaRevision: 2, capabilityRevision: 2, hardMaxSeconds: 120, runnerSha: sourceSha,
  }, clock);
  assert.deepEqual(
    [rejected.decision, rejected.rejectionCode, rejected.spawnCount, rejected.effectiveTimeoutSeconds],
    ['REJECTED', 'RUNNER_HARD_MAX_INSUFFICIENT', 0, null],
  );
  const admitted = runtime.negotiateExecutableAcceptance(plan, {
    schemaRevision: 2, capabilityRevision: 2, hardMaxSeconds: 1200, runnerSha: sourceSha,
  }, clock);
  assert.equal(admitted.decision, 'ADMITTED');
  assert.equal(admitted.effectiveTimeoutSeconds, 1200);
  assert.equal(admitted.effectiveDeadline.toISOString(), '2026-08-28T12:20:00.000Z');
  evidence.negotiation = { rejected, admitted, planDigest: plan.evaluationPlanDigest };
});

test('owner and policy ceilings reject before admission and every plan field is digest-bound', () => {
  const clock = new Date('2026-08-28T12:00:00.000Z');
  const runner = {
    schemaRevision: 2, capabilityRevision: 2, hardMaxSeconds: 3600, runnerSha: sourceSha,
  };
  const ownerLimited = runtime.executableEvaluationPlan({
    command: 'true', expectedExitCode: 0, requestedTimeoutSeconds: 1200,
    ownerTimeoutCeilingSeconds: 1199, policyTimeoutCeilingSeconds: 3600,
  });
  const policyLimited = runtime.executableEvaluationPlan({
    command: 'true', expectedExitCode: 0, requestedTimeoutSeconds: 1200,
    ownerTimeoutCeilingSeconds: 1200, policyTimeoutCeilingSeconds: 1199,
  });
  for (const [plan, code] of [
    [ownerLimited, 'OWNER_CEILING_INSUFFICIENT'],
    [policyLimited, 'POLICY_CEILING_INSUFFICIENT'],
  ]) {
    const decision = runtime.negotiateExecutableAcceptance(plan, runner, clock);
    assert.deepEqual(
      [decision.decision, decision.rejectionCode, decision.spawnCount,
        decision.effectiveTimeoutSeconds, decision.effectiveDeadline],
      ['REJECTED', code, 0, null, null],
    );
  }
  const changedCommand = { ...ownerLimited, command: 'false' };
  assert.match(runtime.executableAcceptancePlanError(changedCommand), /commandDigest/);
  const changedExpectedExit = { ...ownerLimited, expectedExitCode: 9 };
  assert.match(runtime.executableAcceptancePlanError(changedExpectedExit), /evaluationPlanDigest/);
  Object.assign(evidence.negotiation, {
    ownerCeilingRejected: true, policyCeilingRejected: true, commandAndPlanDigestBound: true,
  });
});

test('only EXITED has a criterion result; all five non-exit kinds remain actionable', () => {
  for (const kind of runtime.ATTEMPT_TERMINATION_KINDS) {
    const result = runtime.evaluateExecutableAttempt({
      terminationKind: kind, expectedExitCode: 0, actualExitCode: kind === 'EXITED' ? 9 : null,
    });
    assert.equal(result.state, kind === 'EXITED' ? 'UNSATISFIED' : 'ACTIONABLE');
    assert.equal(result.goalActionable, true);
    evidence.typedTerminations.push({ kind, state: result.state });
  }
  assert.deepEqual(runtime.evaluateExecutableAttempt({
    terminationKind: 'EXITED', expectedExitCode: 0, actualExitCode: 0,
  }), { state: 'SATISFIED', goalActionable: false });
});

test('real API rejects an insufficient current poller without an attempt or budget spend', async () => {
  await empty();
  const fixture = await executableFixture('api-rejected');
  const api = controller();
  await queueAcceptance(api, fixture);
  assert.equal(await dequeue(api, fixture, 120), null);
  const admission = await db.taskExecutableAdmission.findFirstOrThrow({ where: { taskId: fixture.taskId } });
  const task = await db.task.findUniqueOrThrow({ where: { id: fixture.taskId } });
  assert.equal(admission.decision, 'REJECTED');
  assert.equal(admission.rejectionCode, 'RUNNER_HARD_MAX_INSUFFICIENT');
  assert.equal(admission.spawnCount, 0);
  assert.equal(task.executionAttemptCount, 0);
  assert.equal(await db.taskExecutableAttempt.count(), 0);
  await assert.rejects(
    api.startExecutableAcceptanceAttempt({ id: fixture.runnerId }, fixture.sessionId, admission.id),
    /rejected executable acceptance decision cannot start/i,
  );
});

test('real API admission is exact and the idempotent start boundary spends one attempt', async () => {
  await empty();
  const { fixture, api, delivery, started } = await admitAndStart('api-admitted');
  const repeated = await api.startExecutableAcceptanceAttempt(
    { id: fixture.runnerId }, fixture.sessionId, delivery.acceptancePlan.admissionId,
  );
  assert.equal(repeated.attemptId, started.attemptId);
  const [admission, task, detail] = await Promise.all([
    db.taskExecutableAdmission.findUniqueOrThrow({ where: { id: delivery.acceptancePlan.admissionId } }),
    db.task.findUniqueOrThrow({ where: { id: fixture.taskId } }),
    tasks().get(fixture.ownerId, fixture.taskId),
  ]);
  assert.equal(admission.decision, 'ADMITTED');
  assert.equal(admission.effectiveTimeoutSeconds, admission.requestedTimeoutSeconds);
  assert.equal(admission.spawnCount, 1);
  assert.equal(task.executionAttemptCount, 1);
  assert.equal(await db.taskExecutableAttempt.count(), 1);
  const readback = detail.executableAcceptanceAdmissions[0];
  assert.deepEqual({
    requestedTimeoutSeconds: readback.requestedTimeoutSeconds,
    effectiveTimeoutSeconds: readback.effectiveTimeoutSeconds,
    runnerSchemaRevision: readback.runnerSchemaRevision,
    runnerCapabilityRevision: readback.runnerCapabilityRevision,
    runnerHardMaxSeconds: readback.runnerHardMaxSeconds,
    runnerSha: readback.runnerSha,
    spawnCount: readback.spawnCount,
  }, {
    requestedTimeoutSeconds: 1200,
    effectiveTimeoutSeconds: 1200,
    runnerSchemaRevision: 2,
    runnerCapabilityRevision: 2,
    runnerHardMaxSeconds: 3600,
    runnerSha: sourceSha,
    spawnCount: 1,
  });
  evidence.negotiation.liveReadback = {
    requestedTimeoutSeconds: readback.requestedTimeoutSeconds,
    effectiveTimeoutSeconds: readback.effectiveTimeoutSeconds,
    runnerSchemaRevision: readback.runnerSchemaRevision,
    runnerCapabilityRevision: readback.runnerCapabilityRevision,
    runnerHardMaxSeconds: readback.runnerHardMaxSeconds,
    runnerSha: readback.runnerSha,
    spawnCount: readback.spawnCount,
  };
});

test('typed timeout/cancel/signal/start-failure/infrastructure-loss keep real tasks actionable', async () => {
  await empty();
  for (const kind of ['TIMED_OUT', 'CANCELLED', 'SIGNALED', 'START_FAILED', 'INFRASTRUCTURE_LOST']) {
    const { fixture, api, delivery, started } = await admitAndStart(`typed-${kind.toLowerCase()}`);
    await api.turnComplete({ id: fixture.runnerId }, fixture.sessionId, {
      turnId: delivery.turnId, status: RunStatus.SUCCEEDED, subtype: 'shell', shellOutput: kind,
      acceptanceAdmissionId: delivery.acceptancePlan.admissionId,
      acceptanceAttemptId: started.attemptId, acceptanceTerminationKind: kind,
      ...(kind === 'SIGNALED' ? { acceptanceSignal: 'SIGTERM' } : {}),
    });
    const [task, attempt, continuation] = await Promise.all([
      db.task.findUniqueOrThrow({ where: { id: fixture.taskId } }),
      db.taskExecutableAttempt.findUniqueOrThrow({ where: { id: started.attemptId } }),
      db.taskExecutableContinuation.findUniqueOrThrow({ where: { attemptId: started.attemptId } }),
    ]);
    assert.equal(task.status, TaskStatus.OPEN, `${kind} concluded the goal`);
    assert.equal(attempt.terminationKind, kind);
    assert.equal(attempt.actualExitCode, null);
    assert.equal(continuation.goalActionable, true);
    assert.ok(['RETRY', 'DIAGNOSIS', 'SUCCESSOR'].includes(continuation.kind));
    evidence.persistedTypedAttempts.push({
      kind,
      factPersisted: true,
      actualExitCode: attempt.actualExitCode,
      goalActionable: continuation.goalActionable,
      continuation: continuation.kind,
    });
  }
});

test('typed EXITED alone derives DONE or FAILED from the expected code', async () => {
  await empty();
  for (const [actualExitCode, expectedStatus] of [[0, TaskStatus.DONE], [9, TaskStatus.FAILED]]) {
    const { fixture, api, delivery, started } = await admitAndStart(`exited-${actualExitCode}`);
    await api.turnComplete({ id: fixture.runnerId }, fixture.sessionId, {
      turnId: delivery.turnId, status: RunStatus.SUCCEEDED, subtype: 'shell', shellOutput: 'output',
      acceptanceAdmissionId: delivery.acceptancePlan.admissionId,
      acceptanceAttemptId: started.attemptId, acceptanceTerminationKind: 'EXITED',
      acceptanceActualExitCode: actualExitCode,
    });
    assert.equal(
      (await db.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).status,
      expectedStatus,
    );
    assert.equal(await db.taskCompletionEvidence.count({ where: { taskId: fixture.taskId } }), 0);
    assert.equal(await db.taskJudgmentRequest.count({ where: { taskId: fixture.taskId } }), 0);
    assert.equal(await db.taskExecutableAdmission.count({ where: { taskId: fixture.taskId } }), 1);
    assert.equal(await db.taskExecutableAttempt.count({ where: { taskId: fixture.taskId } }), 1);
  }
});

test('v2 ACK success closes liveness for criterion FAIL and non-EXITED outcomes', async () => {
  for (const [kind, actualExitCode, expectedTaskStatus] of [
    ['EXITED', 9, TaskStatus.FAILED],
    ['TIMED_OUT', null, TaskStatus.OPEN],
  ]) {
    await empty();
    const monitor = new OutcomeWatchdogService(db);
    const { fixture, api, delivery, started } = await admitAndStart(
      `v2-ack-close-${kind.toLowerCase()}`,
      { withProject: true },
    );
    const turn = await db.conversationTurn.findUniqueOrThrow({ where: { id: delivery.turnId } });
    const event = await db.runEvent.create({ data: {
      sessionId: fixture.sessionId,
      turnId: delivery.turnId,
      seq: 1,
      type: 'tool_result',
      payload: {
        toolUseId: `shell-${delivery.turnId}`,
        content: `${kind} durable output`,
        isError: true,
      },
      ingestedByRunnerId: fixture.runnerId,
      ingestedUnderLeaseGeneration: turn.leaseGeneration,
    } });
    await backdateRunEventIngestion(event.id, 60);
    assert.equal(
      (await monitor.reconcileStaleCompletionAcks(new Date(), 30, 64)).newFactCount,
      1,
    );
    const [standing] = (await pool.query(`
      SELECT obligation_revision FROM completion_ack_active_obligation
       WHERE task_id = $1::uuid
    `, [fixture.taskId])).rows;
    assert.ok(standing);

    await api.turnComplete({ id: fixture.runnerId }, fixture.sessionId, {
      turnId: delivery.turnId,
      status: RunStatus.SUCCEEDED,
      subtype: 'shell',
      shellOutput: `${kind} durable output`,
      acceptanceAdmissionId: delivery.acceptancePlan.admissionId,
      acceptanceAttemptId: started.attemptId,
      acceptanceTerminationKind: kind,
      ...(actualExitCode == null ? {} : { acceptanceActualExitCode: actualExitCode }),
    });
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).status,
      expectedTaskStatus);
    assert.equal((await pool.query(`
      SELECT count(*)::integer AS count FROM completion_ack_active_obligation
       WHERE obligation_revision = $1
    `, [standing.obligation_revision])).rows[0].count, 0);
    assert.equal((await pool.query(`
      SELECT count(*)::integer AS count FROM completion_ack_fact
       WHERE obligation_revision = $1 AND fact_kind = 'COMPLETION_ACK_RECOVERED'
    `, [standing.obligation_revision])).rows[0].count, 1);
    assert.equal((await pool.query(`
      SELECT count(*)::integer AS count FROM completion_ack_obligation_event
       WHERE obligation_revision = $1 AND state = 'CLOSED'
    `, [standing.obligation_revision])).rows[0].count, 1);
  }
  evidence.completionAck.v2FailAckClosesLiveness = true;
  evidence.completionAck.v2NonExitedAckClosesLiveness = true;
});

test('rolling v1/no-request callback atomically creates one canonical judgment and replays no side effects', async () => {
  await empty();
  const fixture = await executableFixture('rolling-v1-pass', { legacy: true });
  const api = controller();
  await queueAcceptance(api, fixture);
  const delivery = await dequeue(api, fixture, null);
  assert.equal(delivery.taskAcceptance, true);
  assert.equal(delivery.acceptancePlan, undefined);
  assert.equal(await db.taskCompletionEvidence.count({ where: { taskId: fixture.taskId } }), 0);
  assert.equal(await db.taskJudgmentRequest.count({ where: { taskId: fixture.taskId } }), 0);

  // Fail after ACK, fact, result, verdict, Task projection and comment have all been written. A
  // PostgreSQL sequence is intentionally non-transactional, so withTransactionRetry's second pass
  // is allowed through while every row from the first pass must have rolled back.
  await pool.query('CREATE SEQUENCE rolling_v1_retry_once');
  await pool.query(`
    CREATE FUNCTION rolling_v1_fail_first_park() RETURNS trigger AS $$
    BEGIN
      IF nextval('rolling_v1_retry_once') = 1 THEN
        RAISE EXCEPTION 'ROLLING_V1_RETRY_INJECTION' USING ERRCODE = '40001';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    CREATE TRIGGER rolling_v1_fail_first_park
    AFTER UPDATE OF status ON session
    FOR EACH ROW WHEN (OLD.id = '${fixture.sessionId}'::uuid AND NEW.status <> OLD.status)
    EXECUTE FUNCTION rolling_v1_fail_first_park()
  `);

  const rawOutput = '16 tests\n16 pass\n0 fail\n';
  const callback = {
    turnId: delivery.turnId,
    status: RunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: 0,
    shellOutput: rawOutput,
    costUsd: 1.25,
    usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3 },
    modelUsage: {
      'legacy-evaluator': {
        inputTokens: 11, outputTokens: 7, cacheCreationInputTokens: 0,
        cacheReadInputTokens: 3, costUSD: 1.25,
      },
    },
  };
  const first = await api.turnComplete({ id: fixture.runnerId }, fixture.sessionId, callback);
  assert.deepEqual(first, { ok: true, status: RunStatus.AWAITING_INPUT });
  await pool.query('DROP TRIGGER rolling_v1_fail_first_park ON session');
  await pool.query('DROP FUNCTION rolling_v1_fail_first_park()');
  await pool.query('DROP SEQUENCE rolling_v1_retry_once');

  const [task, session, turn, evidenceRow, request] = await Promise.all([
    db.task.findUniqueOrThrow({ where: { id: fixture.taskId } }),
    db.session.findUniqueOrThrow({ where: { id: fixture.sessionId } }),
    db.conversationTurn.findUniqueOrThrow({ where: { id: delivery.turnId } }),
    db.taskCompletionEvidence.findFirstOrThrow({ where: { taskId: fixture.taskId } }),
    db.taskJudgmentRequest.findFirstOrThrow({
      where: { taskId: fixture.taskId }, include: { executableResult: true },
    }),
  ]);
  assert.equal(task.status, TaskStatus.DONE);
  assert.equal(turn.status, 'ANSWERED');
  assert.equal(session.status, RunStatus.AWAITING_INPUT);
  assert.equal(session.engineTurnActive, false);
  assert.equal(session.costUsd, 1.25);
  assert.deepEqual(
    [session.sumInputTokens, session.sumOutputTokens, session.sumCacheRead],
    [11, 7, 3],
  );
  assert.equal(request.status, 'DECIDED');
  assert.equal(request.decision, 'PASS');
  assert.equal(request.recipientId, fixture.sessionId);
  assert.equal(request.executableResult.actualExitCode, 0);
  assert.equal(request.executableResult.rawOutput, rawOutput);
  assert.equal(request.executableResult.recordedById, fixture.runnerId);
  assert.equal(evidenceRow.sourceSessionId, fixture.sessionId);
  assert.equal(evidenceRow.evidence.source, 'LEGACY_V1_TURN_COMPLETE');
  assert.equal(evidenceRow.evidence.protocol.typedAttempt, false);
  assert.equal(evidenceRow.evidence.observation.rawOutputDigest, sha(rawOutput));
  assert.equal(await db.taskCompletionEvidenceIdempotency.count({ where: { taskId: fixture.taskId } }), 1);
  assert.equal(await db.taskExecutableAdmission.count({ where: { taskId: fixture.taskId } }), 0);
  assert.equal(await db.taskExecutableAttempt.count({ where: { taskId: fixture.taskId } }), 0);
  assert.equal(await db.taskComment.count({ where: { taskId: fixture.taskId } }), 1);
  assert.equal(await db.llmUsage.count({ where: { sessionId: fixture.sessionId } }), 1);

  const repeated = await api.turnComplete({ id: fixture.runnerId }, fixture.sessionId, callback);
  assert.deepEqual(repeated, { ok: true, status: RunStatus.AWAITING_INPUT });
  assert.deepEqual({
    evidence: await db.taskCompletionEvidence.count({ where: { taskId: fixture.taskId } }),
    idempotency: await db.taskCompletionEvidenceIdempotency.count({ where: { taskId: fixture.taskId } }),
    requests: await db.taskJudgmentRequest.count({ where: { taskId: fixture.taskId } }),
    results: await db.taskExecutableJudgmentResult.count({ where: { requestId: request.id } }),
    comments: await db.taskComment.count({ where: { taskId: fixture.taskId } }),
    usage: await db.llmUsage.count({ where: { sessionId: fixture.sessionId } }),
  }, { evidence: 1, idempotency: 1, requests: 1, results: 1, comments: 1, usage: 1 });
  const replayedSession = await db.session.findUniqueOrThrow({ where: { id: fixture.sessionId } });
  assert.equal(replayedSession.costUsd, 1.25);
  assert.deepEqual(
    [replayedSession.sumInputTokens, replayedSession.sumOutputTokens, replayedSession.sumCacheRead],
    [11, 7, 3],
  );
  evidence.compatibility.rollingV1CanonicalBridge = {
    retryRollback: true, duplicateNoop: true, canonicalFacts: 1, typedAttempts: 0,
  };
});

test('rolling v1/no-request nonzero exit records FAIL without a typed attempt', async () => {
  await empty();
  const fixture = await executableFixture('rolling-v1-fail', {
    legacy: true, command: 'exit 9', expectedExitCode: 0,
  });
  const api = controller();
  await queueAcceptance(api, fixture);
  const delivery = await dequeue(api, fixture, null);
  const result = await api.turnComplete({ id: fixture.runnerId }, fixture.sessionId, {
    turnId: delivery.turnId, status: RunStatus.SUCCEEDED, subtype: 'shell',
    shellExitCode: 9, shellOutput: 'assertion failed\n',
  });
  assert.deepEqual(result, { ok: true, status: RunStatus.FAILED });
  const request = await db.taskJudgmentRequest.findFirstOrThrow({
    where: { taskId: fixture.taskId }, include: { executableResult: true },
  });
  assert.equal(request.status, 'DECIDED');
  assert.equal(request.decision, 'FAIL');
  assert.equal(request.executableResult.actualExitCode, 9);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).status, TaskStatus.FAILED);
  assert.equal((await db.session.findUniqueOrThrow({ where: { id: fixture.sessionId } })).status, RunStatus.FAILED);
  assert.equal(await db.taskExecutableAdmission.count({ where: { taskId: fixture.taskId } }), 0);
  assert.equal(await db.taskExecutableAttempt.count({ where: { taskId: fixture.taskId } }), 0);
});

test('v1 ACK recovery fact commits atomically with projection, turn, session and judgment', async () => {
  await empty();
  const monitor = new OutcomeWatchdogService(db);
  const state = await completionAckFixture('rolling-v1-atomic-recovery', {
    ingestionAgeSeconds: 60,
    rawOutput: 'atomic recovery output\n',
    exactLease: true,
  });
  const { fixture, delivery, rawOutput, leaseOwner } = state;
  assert.equal(
    (await monitor.reconcileStaleCompletionAcks(new Date(), 30, 64)).newFactCount,
    1,
  );
  const [standing] = (await pool.query(`
    SELECT obligation_revision FROM completion_ack_active_obligation
     WHERE task_id = $1::uuid
  `, [fixture.taskId])).rows;
  assert.ok(standing);
  const sessionBeforeRejectedCallback = await db.session.findUniqueOrThrow({
    where: { id: fixture.sessionId },
  });

  await pool.query(`
    CREATE FUNCTION completion_ack_test_reject_closed_event() RETURNS trigger AS $$
    BEGIN
      IF NEW.obligation_revision = '${standing.obligation_revision}'::char(64)
         AND NEW.state = 'CLOSED' THEN
        RAISE EXCEPTION 'ACK_RECOVERY_COMMIT_INJECTION' USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    CREATE TRIGGER zz_completion_ack_test_reject_closed_event
    AFTER INSERT ON completion_ack_obligation_event
    FOR EACH ROW EXECUTE FUNCTION completion_ack_test_reject_closed_event()
  `);
  const callback = {
    turnId: delivery.turnId,
    status: RunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: 0,
    shellOutput: rawOutput,
    leaseOwner,
  };
  try {
    await assert.rejects(
      controller(monitor).turnComplete({ id: fixture.runnerId }, fixture.sessionId, callback),
      /ACK_RECOVERY_COMMIT_INJECTION/,
    );
  } finally {
    await pool.query(
      'DROP TRIGGER zz_completion_ack_test_reject_closed_event ON completion_ack_obligation_event',
    );
    await pool.query('DROP FUNCTION completion_ack_test_reject_closed_event()');
  }
  const [rolledBackTask, rolledBackTurn, rolledBackSession] = await Promise.all([
    db.task.findUniqueOrThrow({ where: { id: fixture.taskId } }),
    db.conversationTurn.findUniqueOrThrow({ where: { id: delivery.turnId } }),
    db.session.findUniqueOrThrow({ where: { id: fixture.sessionId } }),
  ]);
  assert.equal(rolledBackTask.status, TaskStatus.OPEN);
  assert.equal(rolledBackTurn.status, 'IN_FLIGHT');
  assert.equal(rolledBackSession.status, sessionBeforeRejectedCallback.status);
  assert.equal(
    rolledBackSession.engineTurnActive,
    sessionBeforeRejectedCallback.engineTurnActive,
  );
  assert.equal(await db.taskJudgmentRequest.count({ where: { taskId: fixture.taskId } }), 0);
  assert.equal(await db.taskExecutableJudgmentResult.count(), 0);
  assert.equal((await pool.query(`
    SELECT count(*)::integer AS count FROM completion_ack_fact
     WHERE obligation_revision = $1 AND fact_kind = 'COMPLETION_ACK_RECOVERED'
  `, [standing.obligation_revision])).rows[0].count, 0);
  assert.equal((await pool.query(`
    SELECT count(*)::integer AS count FROM completion_ack_active_obligation
     WHERE obligation_revision = $1
  `, [standing.obligation_revision])).rows[0].count, 1);
  const rejectedCommitFact = (await pool.query(`
    SELECT lease_generation::text, runner_provenance, lease_provenance,
           evidence_source
      FROM completion_ack_fact
     WHERE obligation_revision = $1
       AND fact_kind = 'CONTROL_PLANE_COMMIT_REJECTED'
  `, [standing.obligation_revision])).rows[0];
  assert.deepEqual({
    leaseGeneration: rejectedCommitFact.lease_generation,
    runnerProvenance: rejectedCommitFact.runner_provenance,
    leaseProvenance: rejectedCommitFact.lease_provenance,
    runnerId: rejectedCommitFact.evidence_source.runnerId,
  }, {
    leaseGeneration: state.leaseGeneration,
    runnerProvenance: 'INGESTED_EXACT',
    leaseProvenance: 'INGESTED_EXACT',
    runnerId: fixture.runnerId,
  });

  const recovered = await controller(monitor).turnComplete(
    { id: fixture.runnerId }, fixture.sessionId, callback,
  );
  assert.deepEqual(recovered, { ok: true, status: RunStatus.AWAITING_INPUT });
  const replay = await controller(monitor).turnComplete(
    { id: fixture.runnerId }, fixture.sessionId, callback,
  );
  assert.deepEqual(replay, { ok: true, status: RunStatus.AWAITING_INPUT });
  assert.equal((await pool.query(`
    SELECT count(*)::integer AS count FROM completion_ack_fact
     WHERE obligation_revision = $1 AND fact_kind = 'COMPLETION_ACK_RECOVERED'
  `, [standing.obligation_revision])).rows[0].count, 1);
  const recoveryProvenance = (await pool.query(`
    SELECT runner_provenance, lease_provenance
      FROM completion_ack_fact
     WHERE obligation_revision = $1 AND fact_kind = 'COMPLETION_ACK_RECOVERED'
  `, [standing.obligation_revision])).rows[0];
  assert.deepEqual(recoveryProvenance, {
    runner_provenance: 'INGESTED_EXACT',
    lease_provenance: 'INGESTED_EXACT',
  });
  assert.equal((await pool.query(`
    SELECT count(*)::integer AS count FROM completion_ack_obligation_event
     WHERE obligation_revision = $1 AND state = 'CLOSED'
  `, [standing.obligation_revision])).rows[0].count, 1);
  assert.equal(await db.taskJudgmentRequest.count({ where: { taskId: fixture.taskId } }), 1);
  assert.equal(await db.taskExecutableJudgmentResult.count(), 1);
  assert.equal(await db.taskComment.count({ where: { taskId: fixture.taskId } }), 1);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).status,
    TaskStatus.DONE);
  assert.equal((await db.conversationTurn.findUniqueOrThrow({
    where: { id: delivery.turnId },
  })).status, 'ANSWERED');
  evidence.completionAck.atomicAckRecoveryCommit = true;
  evidence.completionAck.atomicAckRecoveryRetryExactlyOnce = true;
  evidence.completionAck.receiptProvenanceExact = true;
});

test('rolling v1 closes an active ACK obligation through an exact pre-existing OPEN request/result', async () => {
  await empty();
  const monitor = new OutcomeWatchdogService(db);
  const state = await completionAckFixture(
    'rolling-v1-existing-open',
    { ingestionAgeSeconds: 60, rawOutput: 'pre-recorded durable result\n' },
  );
  const { fixture, delivery, rawOutput } = state;
  const detected = await monitor.reconcileStaleCompletionAcks(new Date(), 30, 64);
  assert.equal(detected.newFactCount, 1);
  const [activeBefore] = (await pool.query(`
    SELECT obligation_id, obligation_revision
      FROM completion_ack_active_obligation
     WHERE task_id = $1::uuid
  `, [fixture.taskId])).rows;
  assert.ok(activeBefore);

  const request = await seedExistingExecutableRequest(fixture, delivery, {
    rawOutput,
    evidenceOverride: exactLegacyV1Evidence(state, rawOutput),
    label: 'exact-existing-open',
  });

  const result = await controller(monitor).turnComplete(
    { id: fixture.runnerId }, fixture.sessionId, {
    turnId: delivery.turnId, status: RunStatus.SUCCEEDED, subtype: 'shell',
    shellExitCode: 0, shellOutput: rawOutput,
    },
  );
  assert.deepEqual(result, { ok: true, status: RunStatus.AWAITING_INPUT });
  const decided = await db.taskJudgmentRequest.findUniqueOrThrow({
    where: { id: request.id }, include: { executableResult: true },
  });
  assert.equal(decided.status, 'DECIDED');
  assert.equal(decided.decision, 'PASS');
  assert.equal(decided.executableResult.rawOutput, rawOutput);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).status, TaskStatus.DONE);
  assert.equal(await db.taskCompletionEvidence.count({ where: { taskId: fixture.taskId } }), 1);
  assert.equal(await db.taskJudgmentRequest.count({ where: { taskId: fixture.taskId } }), 1);
  assert.equal(await db.taskExecutableJudgmentResult.count({ where: { requestId: request.id } }), 1);
  assert.equal(await db.taskExecutableAdmission.count({ where: { taskId: fixture.taskId } }), 0);
  assert.equal(await db.taskExecutableAttempt.count({ where: { taskId: fixture.taskId } }), 0);
  assert.equal((await pool.query(`
    SELECT count(*)::int AS n FROM completion_ack_active_obligation
     WHERE obligation_revision = $1
  `, [activeBefore.obligation_revision])).rows[0].n, 0);
  assert.equal((await pool.query(`
    SELECT count(*)::int AS n FROM completion_ack_obligation_event
     WHERE obligation_revision = $1 AND state = 'CLOSED'
  `, [activeBefore.obligation_revision])).rows[0].n, 1);
  Object.assign(evidence.compatibility, {
    rollingV1ExistingOpenRequest: true,
    rollingV1ExistingResult: true,
    existingOpenClosesCanonicalObligation: true,
  });
});

test('rolling v1 callback never consumes a stale OPEN executable request', async () => {
  await empty();
  const fixture = await executableFixture('rolling-v1-stale-open', { legacy: true });
  const api = controller();
  await queueAcceptance(api, fixture);
  const delivery = await dequeue(api, fixture, null);
  const rawOutput = 'exact callback output\n';
  const stale = await seedExistingExecutableRequest(fixture, delivery, {
    rawOutput: 'stale request output\n',
    label: 'different-evidence-digest',
  });
  const staleBefore = await db.taskJudgmentRequest.findUniqueOrThrow({
    where: { id: stale.id }, include: { executableResult: true, evidence: true },
  });
  assert.equal(staleBefore.status, 'OPEN');
  assert.equal(staleBefore.decision, null);
  assert.notEqual(staleBefore.executableResult.rawOutput, rawOutput);

  const reply = await api.turnComplete({ id: fixture.runnerId }, fixture.sessionId, {
    turnId: delivery.turnId,
    status: RunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: 0,
    shellOutput: rawOutput,
  });
  assert.deepEqual(reply, { ok: true, status: RunStatus.AWAITING_INPUT });
  const requests = await db.taskJudgmentRequest.findMany({
    where: { taskId: fixture.taskId },
    include: { executableResult: true, evidence: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  assert.equal(requests.length, 2);
  const staleAfter = requests.find((request) => request.id === stale.id);
  const exact = requests.find((request) => request.id !== stale.id);
  assert.ok(staleAfter);
  assert.ok(exact);
  assert.equal(staleAfter.status, 'OPEN');
  assert.equal(staleAfter.decision, null);
  assert.equal(staleAfter.decidedAt, null);
  assert.equal(staleAfter.executableResult.rawOutput, 'stale request output\n');
  assert.equal(staleAfter.evidenceDigest, staleBefore.evidenceDigest);
  assert.equal(exact.status, 'DECIDED');
  assert.equal(exact.decision, 'PASS');
  assert.equal(exact.recipientId, fixture.sessionId);
  assert.equal(exact.executableResult.rawOutput, rawOutput);
  assert.equal(exact.executableResult.recordedById, fixture.runnerId);
  assert.equal(exact.evidence.evidence.source, 'LEGACY_V1_TURN_COMPLETE');
  assert.notEqual(exact.evidenceDigest, staleAfter.evidenceDigest);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).status,
    TaskStatus.DONE);
  assert.equal(await db.taskExecutableAdmission.count({ where: { taskId: fixture.taskId } }), 0);
  assert.equal(await db.taskExecutableAttempt.count({ where: { taskId: fixture.taskId } }), 0);
  evidence.compatibility.rollingV1StaleOpenIsolation = true;
});

test('ANSWERED without an exact callback receipt stays ACTIVE as ACK_COMMIT_FACT_MISSING', async () => {
  await empty();
  const monitor = new OutcomeWatchdogService(db);
  const { fixture, delivery } = await completionAckFixture(
    'ack-answered-without-canonical-fact',
    { ingestionAgeSeconds: 60 },
  );
  assert.equal(
    (await monitor.reconcileStaleCompletionAcks(new Date(), 30, 64)).newFactCount,
    1,
  );
  const [standing] = (await pool.query(`
    SELECT obligation_id, obligation_revision
      FROM completion_ack_active_obligation
     WHERE task_id = $1::uuid
  `, [fixture.taskId])).rows;
  assert.ok(standing);

  // Reapers, drains and cancellation paths can acknowledge a turn without having committed the
  // executable judgment. ANSWERED alone must never be mistaken for completion authority.
  await markTurnAnswered(fixture.sessionId, delivery.turnId);
  const recovery = await monitor.recordCompletionAckRecovery({
    sessionId: fixture.sessionId,
    turnId: delivery.turnId,
    observedAt: new Date(),
    evidenceSource: { source: 'ACCEPTANCE_ANSWERED_WITHOUT_CANONICAL_FACT' },
  });
  assert.equal(recovery.state, 'ACTIVE');
  assert.equal(recovery.reason, 'ACK_COMMIT_RECEIPT_MISSING');
  assert.equal(recovery.closedObligationCount, 0);
  assert.equal(recovery.recoveryFactCount, 0);

  const [active] = (await pool.query(`
    SELECT obligation FROM completion_ack_active_obligation
     WHERE obligation_revision = $1
  `, [standing.obligation_revision])).rows;
  assert.ok(active);
  assert.equal(active.obligation.reasonCode, 'ACK_COMMIT_FACT_MISSING');
  assert.equal(active.obligation.requiredAction, 'RECORD_ACK_COMMIT_RECEIPT');
  assert.equal((await pool.query(`
    SELECT count(*)::int AS n FROM completion_ack_fact
     WHERE obligation_revision = $1 AND fact_kind = 'COMPLETION_ACK_RECOVERED'
  `, [standing.obligation_revision])).rows[0].n, 0);
  assert.equal((await pool.query(`
    SELECT count(*)::int AS n FROM completion_ack_obligation_event
     WHERE obligation_revision = $1 AND state = 'CLOSED'
  `, [standing.obligation_revision])).rows[0].n, 0);

  const blocker = await db.projectBlocker.findFirstOrThrow({
    where: { projectId: fixture.projectId, kind: 'COMPLETION_ACK_STALE', resolvedAt: null },
  });
  assert.equal(blocker.requiredAction, 'RECORD_ACK_COMMIT_RECEIPT');
  assert.equal(blocker.detail.reasonCode, 'ACK_COMMIT_FACT_MISSING');
  assert.deepEqual(
    [blocker.detail.obligationId, blocker.detail.obligationRevision],
    [standing.obligation_id, standing.obligation_revision],
  );

  for (const surface of [
    'DONE_GATE', 'AGENT_QUEUE', 'OWNER_DECISION_INBOX',
    'PROJECT_ATTENTION', 'MUTATION_RESPONSE', 'WEB',
  ]) {
    const payload = (await pool.query(`
      SELECT outcome_projection.read_surface(
        $1::uuid, $2::uuid, 'TASK', $3::text, $4::text
      ) AS payload
    `, [fixture.ownerId, fixture.projectId, fixture.taskId, surface])).rows[0].payload;
    const obligation = payload.completionAckObligations[0];
    assert.deepEqual(
      [obligation.obligationId, obligation.obligationRevision],
      [standing.obligation_id, standing.obligation_revision],
    );
    assert.equal(obligation.reasonCode, 'ACK_COMMIT_FACT_MISSING');
    assert.equal(obligation.requiredAction, 'RECORD_ACK_COMMIT_RECEIPT');
  }
  Object.assign(evidence.completionAck, {
    answeredAloneCannotClose: true,
    ackCommitReceiptReasonUnifiedAcrossSurfaces: true,
  });
});

test('missing projection stream fallback is exact-active and tenant scoped', async () => {
  await empty();
  const monitor = new OutcomeWatchdogService(db);
  const state = await completionAckFixture('ack-projection-fallback-scope', {
    ingestionAgeSeconds: 60,
  });
  assert.equal(
    (await monitor.reconcileStaleCompletionAcks(new Date(), 30, 64)).newFactCount,
    1,
  );
  const [standing] = (await pool.query(`
    SELECT obligation_id, obligation_revision
      FROM completion_ack_active_obligation
     WHERE task_id = $1::uuid
  `, [state.fixture.taskId])).rows;
  assert.ok(standing);
  assert.equal((await pool.query(`
    SELECT count(*)::integer AS count FROM outcome_fact_stream
     WHERE tenant_id = $1::uuid AND project_id = $2::uuid
  `, [state.fixture.ownerId, state.fixture.projectId])).rows[0].count, 0);
  const ownerPayload = (await pool.query(`
    SELECT outcome_projection.read_surface(
      $1::uuid, $2::uuid, 'TASK', $3::text, 'WEB'
    ) AS payload
  `, [state.fixture.ownerId, state.fixture.projectId, state.fixture.taskId])).rows[0].payload;
  assert.equal(ownerPayload.canonicalProjectionAvailable, false);
  assert.equal(ownerPayload.canonicalProjectionErrorCode, 'OUTCOME_PROJECTION_STREAM_NOT_FOUND');
  assert.equal(ownerPayload.doneGate.allowed, false);
  assert.deepEqual([
    ownerPayload.completionAckObligations[0].obligationId,
    ownerPayload.completionAckObligations[0].obligationRevision,
  ], [standing.obligation_id, standing.obligation_revision]);

  await assertSqlRejected(`
    SELECT outcome_projection.read_surface(
      $1::uuid, $2::uuid, 'TASK', $3::text, 'WEB'
    )
  `, [randomUUID(), state.fixture.projectId, state.fixture.taskId],
  /OUTCOME_PROJECTION_STREAM_NOT_FOUND/);

  const noActive = await foundation('ack-projection-fallback-negative', true);
  await assertSqlRejected(`
    SELECT outcome_projection.read_surface(
      $1::uuid, $2::uuid, 'PROJECT', $2::text, 'WEB'
    )
  `, [noActive.ownerId, noActive.projectId], /OUTCOME_PROJECTION_STREAM_NOT_FOUND/);
  evidence.completionAck.projectionFallbackOwnerExact = true;
  evidence.completionAck.projectionFallbackForeignTenantDenied = true;
  evidence.completionAck.projectionFallbackRequiresActiveAck = true;
});

test('authorized ACK receipt is harmless without an obligation and fail-closed without its event', async () => {
  await empty();
  const monitor = new OutcomeWatchdogService(db);
  const noObligation = await executableFixture('ack-receipt-no-obligation', {
    legacy: true, withProject: true,
  });
  const noObligationApi = controller();
  await queueAcceptance(noObligationApi, noObligation);
  const noObligationDelivery = await dequeue(noObligationApi, noObligation, null);
  await markTurnAnswered(noObligation.sessionId, noObligationDelivery.turnId);
  const harmless = await monitor.recordCompletionAckRecovery({
    sessionId: noObligation.sessionId,
    turnId: noObligationDelivery.turnId,
    observedAt: new Date(),
    evidenceSource: {
      source: 'RUNNER_API_TURN_COMPLETE_COMMITTED',
      runnerId: noObligation.runnerId,
    },
  });
  assert.equal(harmless.state, 'NO_OBLIGATION');
  assert.equal(harmless.closedObligationCount, 0);

  await empty();
  const missingEvent = await executableFixture('ack-receipt-missing-event', {
    legacy: true, withProject: true,
  });
  const missingEventApi = controller();
  await queueAcceptance(missingEventApi, missingEvent);
  const missingEventDelivery = await dequeue(missingEventApi, missingEvent, null);
  const turn = await db.conversationTurn.findUniqueOrThrow({
    where: { id: missingEventDelivery.turnId },
  });
  const recorded = await monitor.recordCompletionAckFailure({
    sessionId: missingEvent.sessionId,
    turnId: missingEventDelivery.turnId,
    leaseGeneration: turn.leaseGeneration,
    errorFingerprint: sha('P0001:missing-terminal-event'),
    observedAt: new Date(),
    evidenceSource: {
      source: 'RUNNER_API_TURN_COMPLETE_REJECTED',
      sqlstate: 'P0001',
      invariant: 'TASK_DONE_CANONICAL_FACT_REQUIRED',
    },
  });
  assert.equal(recorded.state, 'ACTIVE');
  await markTurnAnswered(missingEvent.sessionId, missingEventDelivery.turnId);
  await assert.rejects(
    monitor.recordCompletionAckRecovery({
      sessionId: missingEvent.sessionId,
      turnId: missingEventDelivery.turnId,
      observedAt: new Date(),
      evidenceSource: {
        source: 'RUNNER_API_TURN_COMPLETE_COMMITTED',
        runnerId: missingEvent.runnerId,
      },
    }),
    /COMMIT_TERMINAL_EVENT_MISMATCH/,
  );
  assert.equal((await pool.query(`
    SELECT count(*)::integer AS count FROM completion_ack_active_obligation
     WHERE task_id = $1::uuid
  `, [missingEvent.taskId])).rows[0].count, 1);
  assert.equal((await pool.query(`
    SELECT count(*)::integer AS count FROM completion_ack_fact
     WHERE task_id = $1::uuid AND fact_kind = 'COMPLETION_ACK_RECOVERED'
  `, [missingEvent.taskId])).rows[0].count, 0);
  evidence.completionAck.noObligationReceiptHarmless = true;
  evidence.completionAck.missingTerminalEventReceiptDenied = true;
});

test('authorized ACK receipt rejects exact-event runner and lease mismatches', async () => {
  const variants = [
    { name: 'runner', wrongRunner: true },
    { name: 'lease', wrongLease: true },
  ];

  for (const variant of variants) {
    await empty();
    const monitor = new OutcomeWatchdogService(db);
    const fixture = await executableFixture(`ack-receipt-${variant.name}-mismatch`, {
      legacy: true,
      withProject: true,
    });
    const api = controller();
    await queueAcceptance(api, fixture);
    const delivery = await dequeue(api, fixture, null);
    const turn = await db.conversationTurn.findUniqueOrThrow({
      where: { id: delivery.turnId },
    });
    const recorded = await monitor.recordCompletionAckFailure({
      sessionId: fixture.sessionId,
      turnId: delivery.turnId,
      leaseGeneration: turn.leaseGeneration,
      errorFingerprint: sha(`P0001:receipt-${variant.name}-mismatch`),
      observedAt: new Date(),
      evidenceSource: {
        source: 'RUNNER_API_TURN_COMPLETE_REJECTED',
        sqlstate: 'P0001',
        invariant: 'TASK_DONE_CANONICAL_FACT_REQUIRED',
      },
    });
    assert.equal(recorded.state, 'ACTIVE', variant.name);
    let ingestedByRunnerId = fixture.runnerId;
    if (variant.wrongRunner) {
      const otherRunner = await db.runner.create({ data: {
        id: randomUUID(),
        ownerId: fixture.ownerId,
        name: `ack-receipt-${variant.name}-other-runner`,
        tokenHash: 'x',
        status: RunnerStatus.ONLINE,
      } });
      ingestedByRunnerId = otherRunner.id;
    }
    await db.runEvent.create({ data: {
      sessionId: fixture.sessionId,
      turnId: delivery.turnId,
      seq: 1,
      type: 'tool_result',
      payload: {
        toolUseId: `shell-${delivery.turnId}`,
        content: `durable ${variant.name} output\n`,
        isError: false,
      },
      ingestedByRunnerId,
      ingestedUnderLeaseGeneration: variant.wrongLease ? randomUUID() : turn.leaseGeneration,
    } });
    await markTurnAnswered(fixture.sessionId, delivery.turnId);
    await assert.rejects(monitor.recordCompletionAckRecovery({
      sessionId: fixture.sessionId,
      turnId: delivery.turnId,
      observedAt: new Date(),
      evidenceSource: {
        source: 'RUNNER_API_TURN_COMPLETE_COMMITTED',
        runnerId: fixture.runnerId,
      },
    }), /COMMIT_TERMINAL_EVENT_MISMATCH/, variant.name);
    assert.equal((await pool.query(`
      SELECT count(*)::int AS n FROM completion_ack_active_obligation
       WHERE task_id = $1::uuid AND turn_id = $2::uuid
    `, [fixture.taskId, delivery.turnId])).rows[0].n, 1, variant.name);
    assert.equal((await pool.query(`
      SELECT count(*)::int AS n FROM completion_ack_fact
       WHERE task_id = $1::uuid AND turn_id = $2::uuid
         AND fact_kind = 'COMPLETION_ACK_RECOVERED'
    `, [fixture.taskId, delivery.turnId])).rows[0].n, 0, variant.name);
  }
  evidence.completionAck.receiptProvenanceMismatchFailClosed = variants.map(({ name }) => name);
});

test('completion ACK detector is protocol-neutral and finds v2 without reading typed attempts', async () => {
  await empty();
  const monitor = new OutcomeWatchdogService(db);

  const noEvent = await executableFixture('ack-no-terminal-event', {
    legacy: true, withProject: true,
  });
  const noEventApi = controller();
  await queueAcceptance(noEventApi, noEvent);
  await dequeue(noEventApi, noEvent, null);

  await completionAckFixture('ack-fresh-terminal', { ingestionAgeSeconds: 0 });
  await completionAckFixture('ack-unrelated-tool-result', {
    ingestionAgeSeconds: 60,
    toolUseId: `shell-${randomUUID()}`,
  });

  const v2 = await executableFixture('ack-v2-no-attempt', { withProject: true });
  const v2Api = controller();
  await queueAcceptance(v2Api, v2);
  const v2Delivery = await dequeue(v2Api, v2, 3600);
  const v2Event = await db.runEvent.create({ data: {
    sessionId: v2.sessionId, turnId: v2Delivery.turnId, seq: 1, type: 'tool_result',
    payload: {
      toolUseId: `shell-${v2Delivery.turnId}`,
      content: 'typed result',
      isError: false,
    },
    ingestedByRunnerId: v2.runnerId,
  } });
  await backdateRunEventIngestion(v2Event.id, 60);

  const nonzero = await completionAckFixture('ack-nonzero-terminal', {
    command: 'exit 9',
    actualExitCode: 9,
    rawOutput: `${'failure detail\n'.repeat(256)}exit 9\n`,
    isError: true,
    ingestionAgeSeconds: 60,
  });
  const scan = await monitor.reconcileStaleCompletionAcks(new Date(), 30, 64);
  assert.equal(scan.candidateCount, 2);
  assert.equal(scan.newFactCount, 2);
  const active = (await pool.query(`
    SELECT * FROM completion_ack_active_obligation ORDER BY obligation_revision
  `)).rows;
  assert.equal(active.length, 2);
  const activeByTask = new Map(active.map((row) => [row.task_id, row]));
  const legacyActive = activeByTask.get(nonzero.fixture.taskId);
  const v2Active = activeByTask.get(v2.taskId);
  assert.ok(legacyActive);
  assert.ok(v2Active);
  assert.deepEqual(
    [legacyActive.session_id, legacyActive.turn_id],
    [nonzero.fixture.sessionId, nonzero.delivery.turnId],
  );
  assert.deepEqual([v2Active.session_id, v2Active.turn_id], [v2.sessionId, v2Delivery.turnId]);
  const facts = (await pool.query(`
    SELECT revision.task_id, fact.fact_kind, fact.runner_provenance,
           fact.lease_provenance, fact.evidence_source
      FROM completion_ack_fact fact
      JOIN completion_ack_obligation_revision revision
        ON revision.obligation_revision = fact.obligation_revision
     WHERE revision.task_id = ANY($1::uuid[])
  `, [[nonzero.fixture.taskId, v2.taskId]])).rows;
  assert.equal(facts.length, 2);
  const factsByTask = new Map(facts.map((row) => [row.task_id, row]));
  const legacyFact = factsByTask.get(nonzero.fixture.taskId);
  const v2Fact = factsByTask.get(v2.taskId);
  assert.equal(legacyFact.fact_kind, 'COMPLETION_ACK_STALE');
  assert.equal(legacyFact.runner_provenance, 'INGESTED_EXACT');
  assert.equal(legacyFact.lease_provenance, 'LEGACY_INFERRED');
  assert.equal(legacyFact.evidence_source.executionProtocol, 'LEGACY_V1');
  assert.equal(legacyFact.evidence_source.terminalEvent.id, nonzero.event.id);
  assert.equal(v2Fact.fact_kind, 'COMPLETION_ACK_STALE');
  assert.equal(v2Fact.runner_provenance, 'INGESTED_EXACT');
  assert.equal(v2Fact.lease_provenance, 'LEGACY_INFERRED');
  assert.equal(v2Fact.evidence_source.executionProtocol, 'TYPED_V2');
  assert.equal(v2Fact.evidence_source.terminalEvent.id, v2Event.id);
  const terminalDigest = (await pool.query(`
    SELECT completion_ack_json_digest(payload) AS digest
      FROM run_event WHERE id = $1::uuid
  `, [nonzero.event.id])).rows[0].digest;
  assert.equal(legacyFact.evidence_source.terminalEvent.payloadDigest, terminalDigest);
  assert.equal(await db.taskExecutableAdmission.count({ where: { taskId: nonzero.fixture.taskId } }), 0);
  assert.equal(await db.taskExecutableAttempt.count({ where: { taskId: nonzero.fixture.taskId } }), 0);
  assert.equal(await db.taskExecutableAdmission.count({ where: { taskId: v2.taskId } }), 1);
  assert.equal(await db.taskExecutableAttempt.count({ where: { taskId: v2.taskId } }), 0);
  Object.assign(evidence.completionAck, {
    outcomeNeutral: true,
    freshEventExcluded: true,
    unrelatedToolResultExcluded: true,
    noTerminalEventExcluded: true,
    typedV2DetectedWithoutAttempt: true,
    detectorIndependentOfTypedAttempt: true,
  });
});

test('HTTP catch and independent detector converge concurrently on one scope identity', async () => {
  await empty();
  const monitor = new OutcomeWatchdogService(db);
  const state = await completionAckFixture('ack-concurrent-catch-detector', {
    ingestionAgeSeconds: 60,
  });
  const catchInput = {
    sessionId: state.fixture.sessionId,
    turnId: state.delivery.turnId,
    leaseGeneration: state.turn.leaseGeneration,
    errorFingerprint: sha('P0001:TASK_DONE_CANONICAL_FACT_REQUIRED'),
    observedAt: new Date(),
    evidenceSource: {
      source: 'RUNNER_API_TURN_COMPLETE_REJECTED',
      sqlstate: 'P0001',
      invariant: 'TASK_DONE_CANONICAL_FACT_REQUIRED',
    },
  };
  await Promise.all([
    monitor.recordCompletionAckFailure(catchInput),
    monitor.reconcileStaleCompletionAcks(new Date(), 30, 64),
  ]);
  assert.equal((await pool.query(`
    SELECT count(*)::integer AS count FROM completion_ack_obligation_revision
     WHERE task_id = $1::uuid AND session_id = $2::uuid AND turn_id = $3::uuid
  `, [state.fixture.taskId, state.fixture.sessionId, state.delivery.turnId])).rows[0].count, 1);
  assert.equal((await pool.query(`
    SELECT count(*)::integer AS count FROM completion_ack_active_obligation
     WHERE task_id = $1::uuid AND session_id = $2::uuid AND turn_id = $3::uuid
  `, [state.fixture.taskId, state.fixture.sessionId, state.delivery.turnId])).rows[0].count, 1);
  const factsBeforeReplay = (await pool.query(`
    SELECT fact_kind, error_fingerprint, evidence_source, count(*)::integer AS count
      FROM completion_ack_fact
     WHERE task_id = $1::uuid AND session_id = $2::uuid AND turn_id = $3::uuid
     GROUP BY fact_kind, error_fingerprint, evidence_source ORDER BY fact_kind
  `, [state.fixture.taskId, state.fixture.sessionId, state.delivery.turnId])).rows;
  assert.ok(factsBeforeReplay.length >= 1 && factsBeforeReplay.length <= 2);
  assert.equal(new Set(factsBeforeReplay.map((row) => row.fact_kind)).size,
    factsBeforeReplay.length);
  assert.ok(factsBeforeReplay.every((row) => row.count === 1));
  assert.ok(factsBeforeReplay.every((row) =>
    ['COMPLETION_ACK_STALE', 'CONTROL_PLANE_COMMIT_REJECTED'].includes(row.fact_kind)));
  assert.ok(factsBeforeReplay.every((row) => /^[0-9a-f]{64}$/.test(row.error_fingerprint)));
  assert.ok(factsBeforeReplay.every((row) =>
    typeof row.evidence_source?.source === 'string'
      || typeof row.evidence_source?.executionProtocol === 'string'));
  const registerBefore = (await pool.query(`
    SELECT observation_count, meaningful_observation_count
      FROM completion_ack_observation_register
     WHERE task_id = $1::uuid AND session_id = $2::uuid AND turn_id = $3::uuid
  `, [state.fixture.taskId, state.fixture.sessionId, state.delivery.turnId])).rows[0];
  await Promise.all([
    monitor.recordCompletionAckFailure({ ...catchInput, observedAt: new Date() }),
    monitor.reconcileStaleCompletionAcks(new Date(), 30, 64),
  ]);
  const factsAfterReplay = (await pool.query(`
    SELECT fact_kind, error_fingerprint, evidence_source, count(*)::integer AS count
      FROM completion_ack_fact
     WHERE task_id = $1::uuid AND session_id = $2::uuid AND turn_id = $3::uuid
     GROUP BY fact_kind, error_fingerprint, evidence_source ORDER BY fact_kind
  `, [state.fixture.taskId, state.fixture.sessionId, state.delivery.turnId])).rows;
  assert.deepEqual(factsAfterReplay, factsBeforeReplay);
  const registerAfter = (await pool.query(`
    SELECT observation_count, meaningful_observation_count
      FROM completion_ack_observation_register
     WHERE task_id = $1::uuid AND session_id = $2::uuid AND turn_id = $3::uuid
  `, [state.fixture.taskId, state.fixture.sessionId, state.delivery.turnId])).rows[0];
  assert.ok(BigInt(registerAfter.observation_count) > BigInt(registerBefore.observation_count));
  assert.ok(
    BigInt(registerAfter.meaningful_observation_count)
      >= BigInt(registerBefore.meaningful_observation_count),
  );
  evidence.completionAck.concurrentCatchDetectorConverges = true;
  evidence.completionAck.concurrentReplayFactsExactlyOnce = true;
});

test('a nonzero legacy result closes its ACK obligation through a canonical FAIL without a typed attempt', async () => {
  await empty();
  const monitor = new OutcomeWatchdogService(db);
  const { fixture, delivery, rawOutput } = await completionAckFixture(
    'ack-nonzero-canonical-fail',
    {
      command: 'exit 9',
      expectedExitCode: 0,
      actualExitCode: 9,
      rawOutput: 'assertion failed with exit 9\n',
      isError: true,
      ingestionAgeSeconds: 60,
    },
  );
  assert.equal(
    (await monitor.reconcileStaleCompletionAcks(new Date(), 30, 64)).newFactCount,
    1,
  );
  const [standing] = (await pool.query(`
    SELECT obligation_revision FROM completion_ack_active_obligation
     WHERE task_id = $1::uuid
  `, [fixture.taskId])).rows;
  assert.ok(standing);

  const reply = await controller(monitor).turnComplete(
    { id: fixture.runnerId },
    fixture.sessionId,
    {
      turnId: delivery.turnId,
      status: RunStatus.SUCCEEDED,
      subtype: 'shell',
      shellExitCode: 9,
      shellOutput: rawOutput,
    },
  );
  assert.deepEqual(reply, { ok: true, status: RunStatus.FAILED });
  const [task, session, turn, request] = await Promise.all([
    db.task.findUniqueOrThrow({ where: { id: fixture.taskId } }),
    db.session.findUniqueOrThrow({ where: { id: fixture.sessionId } }),
    db.conversationTurn.findUniqueOrThrow({ where: { id: delivery.turnId } }),
    db.taskJudgmentRequest.findFirstOrThrow({
      where: { taskId: fixture.taskId }, include: { executableResult: true },
    }),
  ]);
  assert.equal(task.status, TaskStatus.FAILED);
  assert.equal(session.status, RunStatus.FAILED);
  assert.equal(session.engineTurnActive, false);
  assert.equal(turn.status, 'ANSWERED');
  assert.equal(request.status, 'DECIDED');
  assert.equal(request.decision, 'FAIL');
  assert.equal(request.executableResult.actualExitCode, 9);
  assert.equal(request.executableResult.rawOutput, rawOutput);
  assert.equal(await db.taskExecutableAdmission.count({ where: { taskId: fixture.taskId } }), 0);
  assert.equal(await db.taskExecutableAttempt.count({ where: { taskId: fixture.taskId } }), 0);
  assert.equal((await pool.query(`
    SELECT count(*)::int AS n FROM completion_ack_active_obligation
     WHERE obligation_revision = $1
  `, [standing.obligation_revision])).rows[0].n, 0);
  assert.equal((await pool.query(`
    SELECT count(*)::int AS n FROM completion_ack_obligation_event
     WHERE obligation_revision = $1 AND state = 'CLOSED'
  `, [standing.obligation_revision])).rows[0].n, 1);
  evidence.completionAck.nonzeroCanonicalFailCloses = true;
});

test('permanent turn-complete rejection auto-routes one canonical obligation and original retry closes it', async (t) => {
  await empty();
  let coordinatorWorker = null;
  t.after(async () => {
    if (!coordinatorWorker
        || coordinatorWorker.exitCode != null
        || coordinatorWorker.signalCode != null) return;
    const exited = new Promise((resolve) => coordinatorWorker.once('exit', resolve));
    coordinatorWorker.kill('SIGTERM');
    await exited;
  });
  const monitor = new OutcomeWatchdogService(db);
  const { fixture, delivery, rawOutput } = await completionAckFixture(
    'ack-permanent-commit-rejection',
    { ingestionAgeSeconds: 60 },
  );
  const successor = await tasks().create(fixture.ownerId, {
    title: 'must wait for original receipt',
    projectId: fixture.projectId,
    assigneeId: fixture.workspaceId,
    completionCriterion: 'EXECUTABLE',
    acceptanceCriteria: 'true exits zero',
    acceptanceCommand: 'true',
    acceptanceExpectedExitCode: 0,
  });
  await db.taskDependency.create({ data: {
    taskId: successor.id,
    dependsOnTaskId: fixture.taskId,
  } });

  await pool.query(`
    CREATE FUNCTION completion_ack_test_reject_projection() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'TASK_DONE_CANONICAL_FACT_REQUIRED'
        USING ERRCODE = 'P0001';
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    CREATE TRIGGER zz_completion_ack_test_reject_projection
    BEFORE UPDATE OF status ON task
    FOR EACH ROW WHEN (
      OLD.id = '${fixture.taskId}'::uuid
      AND NEW.status IN ('DONE'::task_status, 'FAILED'::task_status)
    ) EXECUTE FUNCTION completion_ack_test_reject_projection()
  `);
  const callback = {
    turnId: delivery.turnId,
    status: RunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: 0,
    shellOutput: rawOutput,
    costUsd: 0.75,
    usage: { input_tokens: 5, output_tokens: 3 },
  };
  const rejectingApi = controller(monitor);
  try {
    await assert.rejects(
      rejectingApi.turnComplete({ id: fixture.runnerId }, fixture.sessionId, callback),
      /TASK_DONE_CANONICAL_FACT_REQUIRED/,
    );
    await assert.rejects(
      rejectingApi.turnComplete({ id: fixture.runnerId }, fixture.sessionId, callback),
      /TASK_DONE_CANONICAL_FACT_REQUIRED/,
    );
  } finally {
    await pool.query('DROP TRIGGER zz_completion_ack_test_reject_projection ON task');
    await pool.query('DROP FUNCTION completion_ack_test_reject_projection()');
  }

  assert.equal((await db.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).status, TaskStatus.OPEN);
  assert.equal((await db.conversationTurn.findUniqueOrThrow({ where: { id: delivery.turnId } })).status, 'IN_FLIGHT');
  assert.equal((await db.session.findUniqueOrThrow({ where: { id: fixture.sessionId } })).status, RunStatus.RUNNING);
  assert.equal(await db.taskJudgmentRequest.count({ where: { taskId: fixture.taskId } }), 0);
  assert.equal(await db.taskExecutableJudgmentResult.count(), 0);

  // The independent event detector observes the same turn and reuses the edge-created identity.
  await monitor.reconcileStaleCompletionAcks(new Date(), 30, 64);
  await monitor.reconcileStaleCompletionAcks(new Date(), 30, 64);
  const [canonical] = (await pool.query(`
    SELECT * FROM completion_ack_active_obligation
     WHERE task_id = $1::uuid
  `, [fixture.taskId])).rows;
  assert.ok(canonical);
  assert.equal((await pool.query(`
    SELECT count(*)::int AS n FROM completion_ack_active_obligation
     WHERE task_id = $1::uuid AND session_id = $2::uuid AND turn_id = $3::uuid
       AND error_fingerprint = $4
  `, [fixture.taskId, fixture.sessionId, delivery.turnId, canonical.error_fingerprint])).rows[0].n, 1);
  const obligation = canonical.obligation;
  const identity = [canonical.obligation_id, canonical.obligation_revision];
  assert.deepEqual([obligation.obligationId, obligation.obligationRevision], identity);
  assert.equal(obligation.owner, 'PROJECT_COORDINATOR');
  assert.equal(obligation.requiredAction, 'RETRY_CANONICAL_COMPLETION_COMMIT');
  assert.ok(Array.isArray(obligation.attemptedActions));
  assert.ok(obligation.actionProtocol);

  const taskService = tasks();
  const sessionService = new SessionsService(
    db,
    { notifySessionQueued() {} },
    realtime(),
  );
  const projectService = new ProjectsService(db);
  const [taskList, taskRow, taskDetail, projectList, projectDetail, projectTaskPage,
    sessionList, sessionDetail, orchestrationSessionList, orchestrationSessionDetail] =
    await Promise.all([
      taskService.list(fixture.ownerId),
      taskService.listRow(fixture.ownerId, fixture.taskId),
      taskService.get(fixture.ownerId, fixture.taskId),
      projectService.list(fixture.ownerId),
      projectService.get(fixture.ownerId, fixture.projectId),
      projectService.taskPage(fixture.ownerId, fixture.projectId),
      sessionService.list(fixture.ownerId, { view: 'open' }),
      sessionService.get(fixture.ownerId, fixture.sessionId),
      sessionService.listForOrchestration(fixture.ownerId, {}),
      sessionService.getForOrchestration(fixture.ownerId, fixture.sessionId),
    ]);
  const taskListRow = taskList.find((row) => row.id === fixture.taskId);
  const projectListRow = projectList.find((row) => row.id === fixture.projectId);
  const projectTaskRow = projectTaskPage.items.find((row) => row.id === fixture.taskId);
  const sessionListRow = sessionList.find((row) => row.id === fixture.sessionId);
  const orchestrationSessionRow = orchestrationSessionList.find(
    (row) => row.id === fixture.sessionId,
  );
  const readModels = [
    taskListRow, taskRow, taskDetail, projectListRow, projectDetail, projectTaskRow,
    sessionListRow, sessionDetail, orchestrationSessionRow, orchestrationSessionDetail,
  ];
  for (const model of readModels) {
    assert.ok(model, 'read surface omitted the affected row');
    assert.equal(model.controlPlaneObligations.length, 1);
    assert.deepEqual([
      model.controlPlaneObligations[0].obligationId,
      model.controlPlaneObligations[0].obligationRevision,
    ], identity);
    assert.equal(model.controlPlaneObligations[0].reason, obligation.reason);
    assert.equal(model.controlPlaneObligations[0].owner, 'PROJECT_COORDINATOR');
    assert.equal(
      model.controlPlaneObligations[0].requiredAction,
      obligation.requiredAction,
    );
  }
  assert.equal(taskListRow.blocked, true);
  assert.equal(taskRow.blocked, true);
  assert.equal(taskRow.runnable, false);
  assert.equal(taskDetail.blocked, true);
  assert.equal(projectTaskRow.blocked, true);
  assert.equal(projectListRow.attention.coordinatorBlockers, 1);
  assert.equal(projectListRow.buckets.ready, 0);
  const projectBlockedBucketBeforeRouting = projectListRow.buckets.blocked;

  await assert.rejects(
    taskService.execute(fixture.ownerId, fixture.taskId, undefined, randomUUID()),
    (error) => error?.response?.code === 'COMPLETION_ACK_RECONCILIATION_REQUIRED'
      && error.response.obligationId === identity[0]
      && error.response.obligationRevision === identity[1],
  );
  const batch = await taskService.batchExecute(
    fixture.ownerId,
    [fixture.taskId],
    undefined,
    randomUUID(),
  );
  assert.equal(batch.dispatched, 0);
  assert.match(batch.skipped[0].reason, new RegExp(identity[0]));
  await assert.rejects(
    db.conversationTurn.create({ data: {
      sessionId: fixture.sessionId,
      seq: 99,
      clientTurnId: `completion-ack-reexecution:${randomUUID()}`,
      kind: 'message',
      content: 'run it again',
      status: 'PENDING',
    } }),
    /COMPLETION_ACK_RECONCILIATION_REQUIRED/,
  );

  const surfaces = [
    'DONE_GATE', 'AGENT_QUEUE', 'OWNER_DECISION_INBOX',
    'PROJECT_ATTENTION', 'MUTATION_RESPONSE', 'WEB',
  ];
  for (const surface of surfaces) {
    const payload = (await pool.query(`
      SELECT outcome_projection.read_surface(
        $1::uuid, $2::uuid, 'TASK', $3::text, $4::text
      ) AS payload
    `, [fixture.ownerId, fixture.projectId, fixture.taskId, surface])).rows[0].payload;
    assert.equal(payload.surface, surface);
    assert.equal(payload.doneGate.allowed, false);
    assert.equal(payload.doneGate.operationalState, 'COMPLETION_ACK_STALE');
    assert.equal(payload.completionAckObligations.length, 1);
    assert.deepEqual([
      payload.completionAckObligations[0].obligationId,
      payload.completionAckObligations[0].obligationRevision,
    ], identity);
  }

  const blocker = await db.projectBlocker.findFirstOrThrow({
    where: { projectId: fixture.projectId, kind: 'COMPLETION_ACK_STALE', resolvedAt: null },
  });
  assert.deepEqual([
    blocker.detail.obligationId,
    blocker.detail.obligationRevision,
  ], identity);
  assert.equal(blocker.owner, 'COORDINATOR');
  assert.equal(blocker.requiredAction, obligation.requiredAction);

  const coordinatorInstanceId = 'acceptance-completion-coordinator';
  const coordinatorGeneration = randomUUID();
  registerRuntimeExpectation({
    component: 'outcome-coordinator',
    instanceId: coordinatorInstanceId,
    generation: coordinatorGeneration,
    moduleGraphDigest: coordinatorModuleGraphDigest,
  });
  const coordinatorEnv = {
    ...process.env,
    DATABASE_URL: url,
    OUTCOME_COORDINATOR_SOURCE_SHA: sourceSha,
    OUTCOME_COORDINATOR_TARGET_SHA: sourceSha,
    OUTCOME_COORDINATOR_INSTANCE_ID: coordinatorInstanceId,
    OUTCOME_COORDINATOR_EXPECTATION_GENERATION: coordinatorGeneration,
  };
  coordinatorWorker = spawn(
    process.execPath,
    [path.join(apiDist, 'outcome-coordinator/main.js')],
    { cwd: repo, env: coordinatorEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await waitForOutput(coordinatorWorker, /OUTCOME_COORDINATOR_HEARTBEAT/, 20_000);
  const firstDelivery = await waitForCondition(async () => {
    const result = await pool.query(`
      SELECT receipt.delivery_receipt_id, receipt.session_id_snapshot,
             receipt.obligation_id, receipt.obligation_revision,
             wake.id AS wake_id, wake.subject_version, session.status AS session_status
        FROM completion_ack_coordinator_delivery_receipt receipt
        JOIN project_coordinator_wake wake ON wake.id = receipt.wake_id_snapshot
        JOIN session ON session.id = receipt.session_id_snapshot
       WHERE receipt.obligation_id = $1 AND receipt.obligation_revision = $2
       ORDER BY receipt.recorded_at, receipt.delivery_receipt_id
    `, identity);
    return result.rows;
  }, (rows) => rows.length === 1, 'first durable coordinator delivery');
  const firstWake = await db.projectCoordinatorWake.findUniqueOrThrow({
    where: { id: firstDelivery[0].wake_id }, include: { session: true },
  });
  assert.equal(firstWake.status, 'SESSION_OPENED');
  assert.deepEqual([firstWake.detail.obligationId, firstWake.detail.obligationRevision], identity);
  assert.match(firstWake.session.prompt, new RegExp(identity[0]));
  assert.match(firstWake.session.prompt, new RegExp(identity[1]));
  assert.match(firstWake.session.prompt, /NEW_AUTHORIZATION/);

  // Delivery is not resolution. A hard-failed one-shot coordinator Session leaves the canonical
  // obligation ACTIVE and must yield one deterministic retry delivery, not weld the key forever.
  await db.session.update({
    where: { id: firstWake.sessionId },
    data: {
      status: RunStatus.FAILED,
      engineTurnActive: false,
      finishedAt: new Date(),
      error: 'delivery fixture failure',
    },
  });
  const secondDelivery = await waitForCondition(async () => {
    const result = await pool.query(`
      SELECT receipt.delivery_receipt_id, receipt.session_id_snapshot,
             receipt.obligation_id, receipt.obligation_revision,
             wake.id AS wake_id, wake.subject_version, session.status AS session_status
        FROM completion_ack_coordinator_delivery_receipt receipt
        JOIN project_coordinator_wake wake ON wake.id = receipt.wake_id_snapshot
        JOIN session ON session.id = receipt.session_id_snapshot
       WHERE receipt.obligation_id = $1 AND receipt.obligation_revision = $2
       ORDER BY receipt.recorded_at, receipt.delivery_receipt_id
    `, identity);
    return result.rows;
  }, (rows) => rows.length === 2, 'replacement durable coordinator delivery', 25_000);
  const coordinatorExited = new Promise((resolve) => coordinatorWorker.once('exit', resolve));
  coordinatorWorker.kill('SIGTERM');
  await coordinatorExited;
  const coordinatorHeartbeat = await db.executableRuntimeHeartbeat.findFirstOrThrow({
    where: { expectationGeneration: coordinatorGeneration },
    orderBy: { sequence: 'desc' },
  });
  assert.deepEqual(
    [coordinatorHeartbeat.component, coordinatorHeartbeat.instanceId,
      coordinatorHeartbeat.sourceSha, coordinatorHeartbeat.moduleGraphDigest],
    ['outcome-coordinator', coordinatorInstanceId, sourceSha, coordinatorModuleGraphDigest],
  );
  const routedWakes = await db.projectCoordinatorWake.findMany({
    where: { projectId: fixture.projectId, event: 'COMPLETION_ACK_STALE' },
    include: { session: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  assert.equal(routedWakes.length, 2);
  const retryWake = routedWakes.find((row) => row.id !== firstWake.id);
  assert.ok(retryWake);
  assert.notEqual(retryWake.subjectVersion, firstWake.subjectVersion);
  assert.deepEqual([retryWake.detail.obligationId, retryWake.detail.obligationRevision], identity);
  assert.equal(retryWake.status, 'SESSION_OPENED');
  assert.notEqual(secondDelivery[0].session_id_snapshot, secondDelivery[1].session_id_snapshot);
  assert.equal(await db.projectCoordinatorWake.count({
    where: { projectId: fixture.projectId, event: 'COMPLETION_ACK_STALE' },
  }), 2);
  const standingBeforeAck = (await pool.query(`
    SELECT status, terminal_reason
      FROM outcome_coordinator_obligation
     WHERE source_type = 'COMPLETION_ACK'
       AND obligation_id = $1 AND obligation_revision = $2
  `, identity)).rows[0];
  assert.notEqual(standingBeforeAck.status, 'RESOLVED',
    'delivery receipts must not decide the canonical obligation');
  assert.equal(standingBeforeAck.terminal_reason, null);
  for (const table of [
    'completion_ack_coordinator_delivery_plan',
    'completion_ack_coordinator_delivery_receipt',
  ]) {
    await assertSqlRejected(`
      UPDATE ${table} SET recorded_at = recorded_at
       WHERE obligation_id = $1 AND obligation_revision = $2
    `, identity, /OUTCOME_APPEND_ONLY/);
    await assertSqlRejected(`
      DELETE FROM ${table}
       WHERE obligation_id = $1 AND obligation_revision = $2
    `, identity, /OUTCOME_APPEND_ONLY/);
  }
  evidence.completionAck.coordinatorDeliveryLedgerAppendOnly = true;
  for (const terminalStatus of ['RESOLVED', 'ESCALATED', 'TERMINAL']) {
    await assertSqlRejected(`
      UPDATE outcome_coordinator_obligation
         SET status = $3
       WHERE source_type = 'COMPLETION_ACK'
         AND obligation_id = $1 AND obligation_revision = $2
    `, [...identity, terminalStatus],
    /COMPLETION_ACK_(CANONICAL_CLOSED_REQUIRED|NONCANONICAL_TERMINAL_FORBIDDEN)/);
  }
  evidence.completionAck.nonCanonicalCoordinatorTerminalRejected = true;

  const sanitized = (await pool.query(`
    SELECT completion_ack_sanitize_evidence(
      'CONTROL_PLANE_COMMIT_REJECTED',
      '{"message":"password=do-not-persist","sqlstate":"P0001",
        "invariant":"TASK_DONE_CANONICAL_FACT_REQUIRED"}'::jsonb
    ) AS evidence
  `)).rows[0].evidence;
  assert.doesNotMatch(JSON.stringify(sanitized), /do-not-persist|password=/);
  assert.match(String(sanitized.errorDigest ?? sanitized.messageDigest), /^[0-9a-f]{64}$/);

  const recovered = await controller(monitor).turnComplete(
    { id: fixture.runnerId }, fixture.sessionId, callback,
  );
  assert.deepEqual(recovered, { ok: true, status: RunStatus.AWAITING_INPUT });
  const repeated = await controller(monitor).turnComplete(
    { id: fixture.runnerId }, fixture.sessionId, callback,
  );
  assert.deepEqual(repeated, { ok: true, status: RunStatus.AWAITING_INPUT });
  coordinatorWorker = spawn(
    process.execPath,
    [path.join(apiDist, 'outcome-coordinator/main.js')],
    { cwd: repo, env: coordinatorEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await waitForOutput(coordinatorWorker, /OUTCOME_COORDINATOR_HEARTBEAT/, 20_000);
  const resolvedCoordination = await waitForCondition(async () => {
    const result = await pool.query(`
      SELECT status, terminal_reason
        FROM outcome_coordinator_obligation
       WHERE source_type = 'COMPLETION_ACK'
         AND obligation_id = $1 AND obligation_revision = $2
    `, identity);
    return result.rows[0];
  }, (row) => row?.status === 'RESOLVED', 'source-CLOSED coordinator resolution');
  const restartedCoordinatorExited = new Promise(
    (resolve) => coordinatorWorker.once('exit', resolve),
  );
  coordinatorWorker.kill('SIGTERM');
  await restartedCoordinatorExited;
  assert.equal(resolvedCoordination.terminal_reason, 'COMPLETION_ACK_CANONICAL_SOURCE_CLOSED');
  const [taskAfter, turnAfter, sessionAfter, request] = await Promise.all([
    db.task.findUniqueOrThrow({ where: { id: fixture.taskId } }),
    db.conversationTurn.findUniqueOrThrow({ where: { id: delivery.turnId } }),
    db.session.findUniqueOrThrow({ where: { id: fixture.sessionId } }),
    db.taskJudgmentRequest.findFirstOrThrow({
      where: { taskId: fixture.taskId }, include: { executableResult: true },
    }),
  ]);
  assert.equal(taskAfter.status, TaskStatus.DONE);
  assert.equal(turnAfter.status, 'ANSWERED');
  assert.equal(sessionAfter.status, RunStatus.AWAITING_INPUT);
  assert.equal(sessionAfter.engineTurnActive, false);
  assert.equal(sessionAfter.costUsd, 0.75);
  assert.deepEqual(
    [sessionAfter.sumInputTokens, sessionAfter.sumOutputTokens],
    [5, 3],
  );
  assert.equal(request.status, 'DECIDED');
  assert.equal(request.decision, 'PASS');
  assert.equal(request.executableResult.rawOutput, rawOutput);
  assert.equal(await db.taskJudgmentRequest.count({ where: { taskId: fixture.taskId } }), 1);
  assert.equal(await db.taskExecutableJudgmentResult.count({ where: { requestId: request.id } }), 1);
  assert.equal(await db.taskExecutableAdmission.count({ where: { taskId: fixture.taskId } }), 0);
  assert.equal(await db.taskExecutableAttempt.count({ where: { taskId: fixture.taskId } }), 0);
  assert.equal(await db.taskComment.count({ where: { taskId: fixture.taskId } }), 1);
  assert.equal(await db.llmUsage.count({ where: { sessionId: fixture.sessionId } }), 0);
  assert.equal((await pool.query(`
    SELECT count(*)::int AS n FROM completion_ack_active_obligation
     WHERE obligation_revision = $1
  `, [identity[1]])).rows[0].n, 0);
  assert.equal((await pool.query(`
    SELECT count(*)::int AS n FROM completion_ack_obligation_revision
     WHERE obligation_revision = $1
  `, [identity[1]])).rows[0].n, 1);
  assert.ok((await pool.query(`
    SELECT count(*)::int AS n FROM completion_ack_fact
     WHERE obligation_revision = $1
  `, [identity[1]])).rows[0].n >= 2);
  assert.equal((await pool.query(`
    SELECT count(*)::int AS n FROM completion_ack_obligation_event
     WHERE obligation_revision = $1 AND state = 'CLOSED'
  `, [identity[1]])).rows[0].n, 1);
  assert.equal((await db.projectBlocker.findUniqueOrThrow({ where: { id: blocker.id } })).resolvedBy, 'AUTO');
  const successorAfter = await taskService.listRow(fixture.ownerId, successor.id);
  assert.equal(successorAfter.runnable, true);
  assert.equal(successorAfter.blocked, false);
  assert.equal(projectBlockedBucketBeforeRouting, 2,
    'the command task is operationally blocked and its successor still waits on that task');

  Object.assign(evidence.completionAck, {
    permanent500Detected: true,
    p0001Fingerprint: canonical.error_fingerprint,
    obligationId: identity[0],
    obligationRevision: identity[1],
    deduplicatedActiveObligation: true,
    allSixSurfacesShareIdentity: true,
    taskProjectSessionReadsShareIdentity: true,
    coordinatorOwnedAndRouted: true,
    persistentCoordinatorWorker: true,
    coordinatorGenerationBound: true,
    failedCoordinatorDeliveryRetried: true,
    sourceClosedOnlyResolution: true,
    manualAndAutomaticRedispatchBlocked: true,
    originalCallbackRecovered: true,
    appendOnlyHistoryRetained: true,
    duplicateCallbackNoop: true,
    billingAppliedExactlyOnce: true,
  });
});

test('completion ACK database boundary blocks redispatch, provenance rewrites and forged ledger bindings', async () => {
  await empty();
  const monitor = new OutcomeWatchdogService(db);
  const state = await completionAckFixture('ack-database-boundary', {
    ingestionAgeSeconds: 60,
  });
  assert.equal(
    (await monitor.reconcileStaleCompletionAcks(new Date(), 30, 64)).newFactCount,
    1,
  );
  const [standing] = (await pool.query(`
    SELECT active.*, fact.id AS fact_id, lifecycle.id AS event_id
      FROM completion_ack_active_obligation active
      JOIN completion_ack_fact fact
        ON fact.obligation_revision = active.obligation_revision
       AND fact.fact_kind <> 'COMPLETION_ACK_RECOVERED'
      JOIN completion_ack_obligation_event lifecycle
        ON lifecycle.obligation_revision = active.obligation_revision
       AND lifecycle.state = 'ACTIVE'
     WHERE active.task_id = $1::uuid
     ORDER BY fact.recorded_at, lifecycle.recorded_at
     LIMIT 1
  `, [state.fixture.taskId])).rows;
  assert.ok(standing);

  await assert.rejects(
    db.session.create({ data: {
      id: randomUUID(),
      ownerId: state.fixture.ownerId,
      creatorId: state.fixture.ownerId,
      taskId: state.fixture.taskId,
      workspaceId: state.fixture.workspaceId,
      assignedRunnerId: state.fixture.runnerId,
      title: 'forbidden duplicate task session',
      prompt: 'do not rerun completed work',
      provider: 'claude',
      status: RunStatus.PENDING,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
    } }),
    /COMPLETION_ACK_RECONCILIATION_REQUIRED/,
  );
  await db.session.update({
    where: { id: state.fixture.sessionId },
    data: { status: RunStatus.AWAITING_INPUT },
  });
  await assert.rejects(
    db.session.update({
      where: { id: state.fixture.sessionId },
      data: { status: RunStatus.PENDING },
    }),
    /COMPLETION_ACK_RECONCILIATION_REQUIRED/,
  );
  await assert.rejects(
    db.conversationTurn.update({
      where: { id: state.delivery.turnId },
      data: { leaseGeneration: randomUUID() },
    }),
    /COMPLETION_ACK_RECONCILIATION_REQUIRED/,
  );

  await assert.rejects(
    db.runEvent.update({
      where: { id: state.event.id },
      data: { ingestedByRunnerId: randomUUID() },
    }),
    /RUN_EVENT_INGESTION_PROVENANCE_(?:DB_OWNED|IMMUTABLE)|RUN_EVENT_INGESTED_AT_DB_OWNED/,
  );
  await assert.rejects(
    db.runEvent.update({
      where: { id: state.event.id },
      data: { ingestedUnderLeaseGeneration: randomUUID() },
    }),
    /RUN_EVENT_INGESTION_PROVENANCE_(?:DB_OWNED|IMMUTABLE)|RUN_EVENT_INGESTED_AT_DB_OWNED/,
  );

  for (const [table, idColumn, id] of [
    ['completion_ack_obligation_revision', 'obligation_revision', standing.obligation_revision],
    ['completion_ack_fact', 'id', standing.fact_id],
    ['completion_ack_obligation_event', 'id', standing.event_id],
  ]) {
    await assertSqlRejected(
      `UPDATE ${table} SET recorded_at = recorded_at WHERE ${idColumn} = $1`,
      [id],
      /COMPLETION_ACK_APPEND_ONLY/,
    );
    await assertSqlRejected(
      `DELETE FROM ${table} WHERE ${idColumn} = $1`,
      [id],
      /COMPLETION_ACK_APPEND_ONLY/,
    );
  }

  const observationBefore = (await pool.query(`
    SELECT observation_count, latest_failure_at
      FROM completion_ack_observation_register
     WHERE obligation_revision = $1
  `, [standing.obligation_revision])).rows[0];
  assert.ok(observationBefore);
  await assertSqlRejected(`
    DELETE FROM completion_ack_observation_register WHERE obligation_revision = $1
  `, [standing.obligation_revision], /COMPLETION_ACK_OBSERVATION_REGISTER_DELETE_FORBIDDEN/);
  await assertSqlRejected(`
    UPDATE completion_ack_observation_register
       SET task_id = $2::uuid
     WHERE obligation_revision = $1
  `, [standing.obligation_revision, randomUUID()],
  /COMPLETION_ACK_OBSERVATION_REGISTER_SCOPE_IMMUTABLE/);
  await assertSqlRejected(`
    UPDATE completion_ack_observation_register
       SET observation_count = observation_count
     WHERE obligation_revision = $1
  `, [standing.obligation_revision], /COMPLETION_ACK_OBSERVATION_REGISTER_MONOTONE/);
  await assertSqlRejected(`
    UPDATE completion_ack_observation_register
       SET latest_failure_at = latest_failure_at - interval '1 second',
           observation_count = observation_count + 1
     WHERE obligation_revision = $1
  `, [standing.obligation_revision], /COMPLETION_ACK_OBSERVATION_REGISTER_MONOTONE/);
  const observationAfter = (await pool.query(`
    SELECT observation_count, latest_failure_at
      FROM completion_ack_observation_register
     WHERE obligation_revision = $1
  `, [standing.obligation_revision])).rows[0];
  assert.deepEqual(observationAfter, observationBefore);
  assert.equal((await pool.query(`
    SELECT count(*)::integer AS count
      FROM completion_ack_active_obligation
     WHERE obligation_revision = $1
  `, [standing.obligation_revision])).rows[0].count, 1);

  const foreign = await foundation('ack-cross-tenant-forgery', true);
  const forgedFingerprint = 'ACCEPTANCE_CROSS_TENANT_FORGERY';
  await assertSqlRejected(`
    INSERT INTO completion_ack_obligation_revision (
      obligation_id, obligation_revision, tenant_id, project_id, task_id,
      session_id, turn_id, error_fingerprint
    ) VALUES (
      completion_ack_obligation_id($1::uuid, $2::uuid, $3::uuid, $4::text),
      completion_ack_obligation_revision($1::uuid, $2::uuid, $3::uuid, $4::text),
      $5::uuid, $6::uuid, $1::uuid, $2::uuid, $3::uuid, $4::text
    )
  `, [
    state.fixture.taskId,
    state.fixture.sessionId,
    state.delivery.turnId,
    forgedFingerprint,
    foreign.ownerId,
    foreign.projectId,
  ], /COMPLETION_ACK_(?:REVISION_)?SCOPE_MISMATCH|foreign key|tenant/i);

  await assertSqlRejected(`
    INSERT INTO completion_ack_fact (
      id, obligation_id, obligation_revision, tenant_id, project_id, task_id,
      session_id, turn_id, lease_generation, lease_provenance, runner_provenance,
      fact_kind, error_fingerprint, first_failure_at, latest_failure_at,
      source_observed_at, observed_at, recorded_at, ingested_at, observation_bucket,
      evidence_source, evidence_source_digest, idempotency_key, fact_digest
    )
    SELECT gen_random_uuid(), revision.obligation_id, revision.obligation_revision,
           $2::uuid, revision.project_id, revision.task_id, revision.session_id,
           revision.turn_id, NULL, 'LEGACY_INFERRED', 'LEGACY_INFERRED',
           'CONTROL_PLANE_COMMIT_REJECTED', revision.error_fingerprint,
           statement_timestamp(), statement_timestamp(), NULL,
           statement_timestamp(), statement_timestamp(), statement_timestamp(),
           completion_ack_observation_bucket(statement_timestamp()),
           '{"source":"RAW_CROSS_TENANT"}'::jsonb,
           repeat('0',64)::char(64), repeat('0',64)::char(64), repeat('0',64)::char(64)
      FROM completion_ack_obligation_revision revision
     WHERE revision.obligation_revision = $1
  `, [standing.obligation_revision, foreign.ownerId], /foreign key|scope mismatch/i);

  const evidenceClient = await pool.connect();
  try {
    await evidenceClient.query('BEGIN');
    const suppliedDigest = 'b'.repeat(64);
    const inserted = await evidenceClient.query(`
      INSERT INTO completion_ack_fact (
        id, obligation_id, obligation_revision, tenant_id, project_id, task_id,
        session_id, turn_id, lease_generation, lease_provenance, runner_provenance,
        fact_kind, error_fingerprint, first_failure_at, latest_failure_at,
        source_observed_at, observed_at, recorded_at, ingested_at, observation_bucket,
        evidence_source, evidence_source_digest, idempotency_key, fact_digest
      )
      SELECT gen_random_uuid(), revision.obligation_id, revision.obligation_revision,
             revision.tenant_id, revision.project_id, revision.task_id, revision.session_id,
             revision.turn_id, NULL, 'LEGACY_INFERRED', 'LEGACY_INFERRED',
             'CONTROL_PLANE_COMMIT_REJECTED', revision.error_fingerprint,
             statement_timestamp(), statement_timestamp(), NULL,
             statement_timestamp(), statement_timestamp(), statement_timestamp(),
             completion_ack_observation_bucket(statement_timestamp()),
             jsonb_build_object(
               'source', 'RAW_SECURITY_FIXTURE',
               'message', 'password=SECRET_MUST_NOT_PERSIST',
               'messageDigest', $2::text,
               'sqlstate', 'P0001'
             ),
             repeat('0',64)::char(64), repeat('0',64)::char(64), repeat('0',64)::char(64)
        FROM completion_ack_obligation_revision revision
       WHERE revision.obligation_revision = $1
      RETURNING id, obligation_id, obligation_revision, fact_kind, evidence_source
    `, [standing.obligation_revision, suppliedDigest]);
    const rawFact = inserted.rows[0];
    assert.ok(rawFact);
    assert.doesNotMatch(JSON.stringify(rawFact.evidence_source), /SECRET_MUST_NOT_PERSIST|password=/);
    assert.equal(rawFact.evidence_source.messageDigest, suppliedDigest);

    await assert.rejects(evidenceClient.query(`
      INSERT INTO completion_ack_obligation_event (
        id, obligation_id, obligation_revision, state, source_fact_id,
        source_fact_kind, reason_code, evidence_source, evidence_source_digest,
        recorded_at, ingested_at, event_digest
      ) VALUES (
        gen_random_uuid(), $1, $2, 'ACTIVE', $3::uuid,
        $4, $4, '{"source":"DIFFERENT_FROM_SOURCE_FACT"}'::jsonb,
        repeat('0',64)::char(64), statement_timestamp(), statement_timestamp(),
        repeat('0',64)::char(64)
      )
    `, [
      rawFact.obligation_id,
      rawFact.obligation_revision,
      rawFact.id,
      rawFact.fact_kind,
    ]), /evidence|completion_ack_event_fact/i);
  } finally {
    await evidenceClient.query('ROLLBACK').catch(() => undefined);
    evidenceClient.release();
  }

  Object.assign(evidence.completionAck, {
    databaseRedispatchGuard: true,
    runEventProvenanceImmutable: true,
    appendOnlyUpdateDeleteRejected: true,
    observationRegisterMonotone: true,
    crossTenantLedgerForgeryRejected: true,
    eventEvidenceBoundToSourceFact: true,
    rawLedgerEvidenceSanitized: true,
  });
});

test('bounded reconciliation advances beyond its limit, does not resample ACTIVE identities and cannot starve a recoverable ACK', async () => {
  await empty();
  const monitor = new OutcomeWatchdogService(db);
  const states = [];
  for (let index = 0; index < 3; index += 1) {
    states.push(await completionAckFixture(`ack-bounded-fairness-${index}`, {
      ingestionAgeSeconds: 60,
      rawOutput: `bounded result ${index}\n`,
    }));
  }

  const first = await monitor.reconcileStaleCompletionAcks(new Date(), 30, 2);
  const second = await monitor.reconcileStaleCompletionAcks(new Date(), 30, 2);
  const third = await monitor.reconcileStaleCompletionAcks(new Date(), 30, 2);
  assert.deepEqual(
    [first.newFactCount, second.newFactCount, third.newFactCount],
    [2, 1, 0],
    'standing ACTIVE identities consumed the bounded detector forever',
  );
  assert.equal((await pool.query(`
    SELECT count(*)::int AS n FROM completion_ack_active_obligation
  `)).rows[0].n, 3);
  assert.equal((await pool.query(`
    SELECT count(*)::int AS n FROM completion_ack_fact
     WHERE fact_kind = 'COMPLETION_ACK_STALE'
  `)).rows[0].n, 3);

  for (let replay = 0; replay < 8; replay += 1) {
    const scan = await monitor.reconcileStaleCompletionAcks(new Date(), 30, 2);
    assert.equal(scan.newFactCount, 0, `replay ${replay} appended another standing fact`);
  }
  const bounded = (await pool.query(`
    SELECT task_id, count(*)::int AS facts,
           sum(pg_column_size(fact))::int AS bytes
      FROM completion_ack_fact fact
     GROUP BY task_id
     ORDER BY task_id
  `)).rows;
  assert.equal(bounded.length, 3);
  for (const row of bounded) {
    assert.equal(row.facts, 1);
    assert.ok(row.bytes <= 8192, `completion ACK facts used ${row.bytes} bytes for ${row.task_id}`);
  }

  // Make the lexicographically first two active turns look ACKed without a judgment, while the
  // last one commits the exact callback receipt atomically. The two incomplete rows remain
  // visible, while a later limit=1 scan must not recreate or re-close the already closed identity.
  const ordered = [...states].sort((left, right) =>
    left.fixture.sessionId.localeCompare(right.fixture.sessionId));
  const recoverable = ordered[ordered.length - 1];
  for (const missing of ordered.slice(0, -1)) {
    await markTurnAnswered(missing.fixture.sessionId, missing.delivery.turnId);
  }
  const committed = await controller().turnComplete(
    { id: recoverable.fixture.runnerId },
    recoverable.fixture.sessionId,
    {
      turnId: recoverable.delivery.turnId,
      status: RunStatus.SUCCEEDED,
      subtype: 'shell',
      shellExitCode: 0,
      shellOutput: recoverable.rawOutput,
    },
  );
  assert.deepEqual(committed, { ok: true, status: RunStatus.AWAITING_INPUT });
  assert.equal((await pool.query(`
    SELECT count(*)::int AS n FROM completion_ack_active_obligation
     WHERE task_id = $1::uuid
  `, [recoverable.fixture.taskId])).rows[0].n, 0);
  const recovered = await monitor.reconcileStaleCompletionAcks(new Date(), 30, 1);
  assert.equal(recovered.recoveredObligationCount, 0);
  assert.equal((await pool.query(`
    SELECT count(*)::int AS n FROM completion_ack_active_obligation
     WHERE task_id = $1::uuid
  `, [recoverable.fixture.taskId])).rows[0].n, 0);
  for (const missing of ordered.slice(0, -1)) {
    const [active] = (await pool.query(`
      SELECT obligation FROM completion_ack_active_obligation
       WHERE task_id = $1::uuid
    `, [missing.fixture.taskId])).rows;
    assert.equal(active.obligation.reasonCode, 'ACK_COMMIT_FACT_MISSING');
  }
  Object.assign(evidence.completionAck, {
    boundedDetectorFairness: true,
    standingIdentityNotResampled: true,
    perTaskStorageBound: 8192,
    missingFactCannotStarveRecovery: true,
  });
});

test('N-1 omission stays on v1 and legacy -1 cannot conclude the task', async () => {
  await empty();
  const fixture = await executableFixture('n-minus-one', { legacy: true });
  const api = controller();
  await queueAcceptance(api, fixture);
  const delivery = await dequeue(api, fixture, null);
  assert.equal(delivery.taskAcceptance, true);
  assert.equal(delivery.acceptancePlan, undefined);
  await api.turnComplete({ id: fixture.runnerId }, fixture.sessionId, {
    turnId: delivery.turnId, status: RunStatus.SUCCEEDED, subtype: 'shell',
    shellExitCode: -1, shellOutput: 'legacy outer deadline',
  });
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).status, TaskStatus.OPEN);
  Object.assign(evidence.compatibility, {
    nMinusOnePlan: 'v1', legacyMinusOneActionable: true,
  });
});

test('legacy bootstrap import preserves UNTYPED/-1 and appends only an evidence diagnosis', async () => {
  await empty();
  const base = await foundation('legacy-bootstrap');
  const taskId = '01a04672-4b57-7267-9f0c-24ac4e0ab282';
  const sessionId = '01d2bdbf-f122-5b50-8f2c-02112709dcba';
  const turnId = '01a047fe-d899-711f-a3b7-53a3269f0c12';
  await db.task.create({ data: {
    id: taskId, ownerId: base.ownerId, creatorType: 'USER', creatorId: base.ownerId,
    title: 'legacy watchdog', assigneeId: base.workspaceId, status: TaskStatus.FAILED,
    completionCriterion: 'EXECUTABLE', acceptanceCommand: 'npm run test:outcome-reconciler:watchdog',
    acceptanceExpectedExitCode: 0,
  } });
  await db.session.create({ data: {
    id: sessionId, ownerId: base.ownerId, creatorId: base.ownerId, taskId,
    workspaceId: base.workspaceId, assignedRunnerId: base.runnerId, title: 'legacy', prompt: 'legacy',
    provider: 'claude', status: RunStatus.FAILED, dispatchOrigin: SessionDispatchOrigin.USER,
    startsTaskWork: true,
  } });
  const createdAt = new Date('2026-08-28T10:51:19.065Z');
  await db.conversationTurn.create({ data: {
    id: turnId, sessionId, seq: 2, clientTurnId: `system:task-acceptance:v1:${randomUUID()}:0`,
    kind: 'shell', content: 'npm run test:outcome-reconciler:watchdog', status: 'ANSWERED',
    createdAt, answeredAt: new Date(createdAt.getTime() + 120_731),
  } });
  await db.taskComment.create({ data: {
    id: '01a04800-b056-74bd-8ff6-7dabe9b8566e', taskId, authorId: base.ownerId,
    authorType: 'USER', body: '实际退出码：-1\nok 12 - samples are append-only\n(output ended)',
  } });
  assert.equal((await pool.query(
    'SELECT executable_acceptance_import_bootstrap_legacy_timeout() AS imported',
  )).rows[0].imported, true);
  const [attempt, diagnosis, session, task] = await Promise.all([
    db.taskExecutableAttempt.findFirstOrThrow({ where: { sessionId } }),
    db.taskExecutableDiagnosis.findFirstOrThrow({ where: { sessionId } }),
    db.session.findUniqueOrThrow({ where: { id: sessionId } }),
    db.task.findUniqueOrThrow({ where: { id: taskId } }),
  ]);
  assert.equal(attempt.legacyTermination, 'UNTYPED');
  assert.equal(attempt.legacyExitCode, -1);
  assert.equal(attempt.terminationKind, null);
  assert.equal(diagnosis.kind, 'TIMEOUT');
  assert.equal(diagnosis.evidence.typedTerminationClaimed, false);
  assert.equal(session.status, RunStatus.FAILED);
  assert.equal(task.executionAttemptCount, 0);
  evidence.legacy = {
    sessionId: '3RIgJAt2GsNCTVoKKfOvK', legacyTermination: attempt.legacyTermination,
    legacyExitCode: attempt.legacyExitCode, diagnosis: diagnosis.kind, evidence: diagnosis.evidence,
  };
});

async function dependencyChain(label, withProject) {
  const base = await foundation(label, withProject);
  const service = tasks();
  const common = { completionCriterion: 'HUMAN_SIGNOFF', ...(withProject ? { projectId: base.projectId } : {}) };
  const old = await service.create(base.ownerId, { title: `${label}-W`, ...common });
  const successor = await service.create(base.ownerId, { title: `${label}-S`, ...common });
  await db.task.update({ where: { id: old.id }, data: { status: TaskStatus.FAILED } });
  await service.update(base.ownerId, old.id, { supersededByTaskId: successor.id });
  await forceStatus(successor.id, TaskStatus.DONE);
  const dependent = await service.create(base.ownerId, {
    title: `${label}-D`, ...common, assigneeId: base.workspaceId,
    dependsOnTaskIds: [old.id], autoRunWhenReady: true,
  });
  return { ...base, oldId: old.id, successorId: successor.id, dependentId: dependent.id };
}

test('W=FAILED -> S=DONE makes task_get/list/Ready/project agree on READY without editing the edge', async () => {
  await empty();
  const chain = await dependencyChain('surface', true);
  const service = tasks();
  const [detail, list, readyPage, projectPage, storedEdge] = await Promise.all([
    service.get(chain.ownerId, chain.dependentId),
    service.list(chain.ownerId),
    service.listPage(chain.ownerId, { status: 'RUNNABLE', projectId: chain.projectId, counts: 'none' }),
    new ProjectsService(db).taskPage(chain.ownerId, chain.projectId, { limit: 20 }),
    db.taskDependency.findUniqueOrThrow({
      where: { taskId_dependsOnTaskId: { taskId: chain.dependentId, dependsOnTaskId: chain.oldId } },
    }),
  ]);
  assert.equal(storedEdge.dependsOnTaskId, chain.oldId, 'the acceptance rewired the historical edge');
  assert.equal(detail.dependencyState, 'READY');
  assert.equal(list.find((row) => row.id === chain.dependentId).dependencyState, 'READY');
  assert.ok(readyPage.items.some((row) => row.id === chain.dependentId));
  assert.equal(projectPage.items.find((row) => row.id === chain.dependentId).dependencyState, 'READY');
  evidence.supersessionSurfaces = {
    taskGet: 'READY', taskList: 'READY', readySelector: true, project: 'READY', edgeStillPointsToW: true,
  };
});

test('Run Now, instant trigger, periodic sweep and execute commit gate use the same chain tail', async () => {
  await empty();
  const chain = await dependencyChain('dispatch', false);
  let dispatched = 0;
  const sentinel = new Error('ACCEPTANCE_DISPATCH_REACHED');
  const service = tasks({
    create: async () => { dispatched += 1; throw sentinel; },
    resume: async () => { dispatched += 1; throw sentinel; },
  });
  await assert.rejects(
    service.execute(chain.ownerId, chain.dependentId, undefined, `acceptance:${randomUUID()}`),
    /ACCEPTANCE_DISPATCH_REACHED/,
  );
  assert.equal(dispatched, 1, 'Run Now did not cross the READY gate');
  await service.triggerDependents(chain.ownerId, chain.successorId);
  assert.ok(dispatched >= 2, 'instant successor completion did not find the stored W edge');
  await service.reconcileReadyTasks();
  assert.ok(dispatched >= 3, 'periodic selector did not dispatch the chain-tail-ready task');

  const committed = await db.session.create({ data: {
    id: randomUUID(), ownerId: chain.ownerId, creatorId: chain.ownerId, taskId: chain.dependentId,
    workspaceId: chain.workspaceId, assignedRunnerId: chain.runnerId, title: 'commit gate',
    prompt: 'commit gate', provider: 'claude', status: RunStatus.PENDING,
    dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
  } });
  assert.equal(committed.taskId, chain.dependentId);
  await db.session.delete({ where: { id: committed.id } });
  Object.assign(evidence.supersessionSurfaces, {
    runNow: true, instantTrigger: true, periodicSweep: true, executeCommitGate: true,
  });
});

test('broken and cyclic supersession chains fail closed', async () => {
  await empty();
  const chain = await dependencyChain('broken', false);
  await db.task.delete({ where: { id: chain.successorId } });
  assert.equal((await pool.query(
    'SELECT task_dependency_tail_satisfied($1::uuid) AS satisfied', [chain.oldId],
  )).rows[0].satisfied, false);

  const base = await foundation('cycle');
  const service = tasks();
  const left = await service.create(base.ownerId, { title: 'cycle-left', completionCriterion: 'HUMAN_SIGNOFF' });
  const right = await service.create(base.ownerId, { title: 'cycle-right', completionCriterion: 'HUMAN_SIGNOFF' });
  await db.task.updateMany({ where: { id: { in: [left.id, right.id] } }, data: { status: TaskStatus.FAILED } });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query(`UPDATE task SET terminal_reason='SUPERSEDED', superseded_at=now(), superseded_by_task_id=$2 WHERE id=$1`, [left.id, right.id]);
    await client.query(`UPDATE task SET terminal_reason='SUPERSEDED', superseded_at=now(), superseded_by_task_id=$2 WHERE id=$1`, [right.id, left.id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  assert.equal((await pool.query(
    'SELECT task_dependency_tail_id($1::uuid) AS tail', [left.id],
  )).rows[0].tail, null);
  Object.assign(evidence.supersessionSurfaces, { brokenFailClosed: true, cycleFailClosed: true });
});

function waitForOutput(child, pattern, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`worker output timeout: ${output}`)), timeoutMs);
    const read = (chunk) => {
      output += chunk.toString();
      if (pattern.test(output)) {
        clearTimeout(timer);
        resolve(output);
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`worker exited ${code}: ${output}`));
    });
  });
}

async function waitForCondition(read, predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let current;
  while (Date.now() < deadline) {
    current = await read();
    if (predicate(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} timeout: ${JSON.stringify(current)}`);
}

test('external dead-man marks a registered generation missing when it never heartbeats', async () => {
  await empty();
  const component = 'outcome-watchdog';
  const instanceId = 'acceptance-never-started';
  const generation = randomUUID();
  const registered = registerRuntimeExpectation({
    component, instanceId, generation, startupGraceSeconds: 1,
  });
  assert.deepEqual(
    [registered.component, registered.instanceId, registered.generation, registered.replayed],
    [component, instanceId, generation, false],
  );
  let expected = (await pool.query(`
    SELECT state, condition_code, startup_deadline_at, expected_source_sha,
           module_graph_digest, heartbeat_digest
      FROM executable_runtime_expected_liveness
     WHERE generation = $1::uuid
  `, [generation])).rows[0];
  assert.deepEqual(
    [expected.state, expected.condition_code, expected.expected_source_sha,
      expected.module_graph_digest, expected.heartbeat_digest],
    ['STARTING', 'STARTING', sourceSha, watchdogModuleGraphDigest, null],
  );
  const duringGrace = runDeadman([
    '--component', component, '--instance-id', instanceId, '--generation', generation,
  ]);
  assert.deepEqual(
    [duringGrace.starting, duringGrace.missing, duringGrace.events.length],
    [1, 0, 0],
  );

  await waitPast(expected.startup_deadline_at);
  const missing = runDeadman([
    '--component', component, '--instance-id', instanceId, '--generation', generation,
  ]);
  assert.equal(missing.events.length, 1);
  assert.deepEqual(
    [missing.missing, missing.events[0].kind, missing.events[0].generation],
    [1, 'WATCHDOG_MISSING', generation],
  );
  const replay = runDeadman([
    '--component', component, '--instance-id', instanceId, '--generation', generation,
  ]);
  assert.deepEqual([replay.missing, replay.events.length], [1, 0]);
  expected = (await pool.query(`
    SELECT state, condition_code, last_event_kind
      FROM executable_runtime_expected_liveness
     WHERE generation = $1::uuid
  `, [generation])).rows[0];
  assert.deepEqual(
    [expected.state, expected.condition_code, expected.last_event_kind],
    ['WATCHDOG_STALE', 'WATCHDOG_MISSING', 'WATCHDOG_MISSING'],
  );
  assert.equal((await pool.query(`
    SELECT count(*)::integer AS count
      FROM executable_dead_man_event
     WHERE expectation_generation = $1::uuid AND kind = 'WATCHDOG_MISSING'
  `, [generation])).rows[0].count, 1);
  const live = (await pool.query(`
    SELECT state, active_obligation_count
      FROM executable_runtime_liveness
     WHERE component = $1 AND instance_id = $2
  `, [component, instanceId])).rows[0];
  assert.deepEqual([live.state, live.active_obligation_count], ['WATCHDOG_STALE', 1]);
  Object.assign(evidence.watchdog, {
    neverHeartbeatedGenerationDetected: true,
    startupGraceSeconds: 1,
    missingEventExactlyOnce: true,
  });
});

test('external dead-man detects a terminated generation-bound worker and exact recovery', async () => {
  await empty();
  const instanceId = 'acceptance-worker';
  const watchdogGeneration = randomUUID();
  const completionAckGeneration = randomUUID();
  for (const [component, generation] of [
    ['outcome-watchdog', watchdogGeneration],
    ['completion-ack-watchdog', completionAckGeneration],
  ]) {
    const registered = registerRuntimeExpectation({ component, instanceId, generation });
    assert.deepEqual(
      [registered.component, registered.instanceId, registered.generation, registered.replayed],
      [component, instanceId, generation, false],
    );
  }
  const worker = spawn(process.execPath, [path.join(apiDist, 'outcome-watchdog/main.js')], {
    cwd: repo,
    env: {
      ...process.env, DATABASE_URL: url,
      OUTCOME_WATCHDOG_POLICY_PATH: path.join(repo, 'contracts/outcome-reconciler-v2-watchdog-slo.json'),
      OUTCOME_WATCHDOG_COLLECTOR_SHA: sourceSha, OUTCOME_WATCHDOG_TARGET_SHA: sourceSha,
      OUTCOME_WATCHDOG_INSTANCE_ID: instanceId,
      OUTCOME_WATCHDOG_EXPECTATION_GENERATION: watchdogGeneration,
      COMPLETION_ACK_WATCHDOG_EXPECTATION_GENERATION: completionAckGeneration,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForOutput(worker, /OUTCOME_WATCHDOG_HEARTBEAT/);
  const boundHeartbeats = await db.executableRuntimeHeartbeat.findMany({
    where: { instanceId },
    orderBy: [{ component: 'asc' }, { sequence: 'desc' }],
  });
  assert.equal(boundHeartbeats.length, 2);
  assert.deepEqual(
    boundHeartbeats.map((row) => [
      row.component, row.expectationGeneration, row.sourceSha, row.moduleGraphDigest,
    ]),
    [
      ['completion-ack-watchdog', completionAckGeneration, sourceSha, watchdogModuleGraphDigest],
      ['outcome-watchdog', watchdogGeneration, sourceSha, watchdogModuleGraphDigest],
    ],
  );
  const heartbeatService = new OutcomeWatchdogService(db);
  await assert.rejects(
    heartbeatService.appendRuntimeHeartbeat({
      component: 'outcome-watchdog', instanceId, sourceSha,
      moduleGraphDigest: sha('wrong-module-graph'),
      expectationGeneration: watchdogGeneration,
      observedAt: new Date(), deadlineAt: new Date(Date.now() + 30_000),
      payload: { schemaVersion: 1, invalidBindingFixture: true },
    }),
    /EXECUTABLE_RUNTIME_HEARTBEAT_EXPECTATION_MISMATCH/,
  );
  const workerExited = new Promise((resolve) => worker.once('exit', resolve));
  worker.kill('SIGTERM');
  await workerExited;
  // Append a production-valid, exact-generation observation whose deadline has elapsed. This
  // keeps the acceptance suite bounded while exercising the same DB-clock dead-man predicate as
  // a worker that stopped for the full 30 second SLO; no mutable clock or projection is patched.
  const staleObservedAt = new Date(Date.now() - 31_000);
  const staleDeadlineAt = new Date(Date.now() - 1_000);
  for (const [component, generation] of [
    ['outcome-watchdog', watchdogGeneration],
    ['completion-ack-watchdog', completionAckGeneration],
  ]) {
    await heartbeatService.appendRuntimeHeartbeat({
      component, instanceId, sourceSha,
      moduleGraphDigest: watchdogModuleGraphDigest,
      expectationGeneration: generation,
      observedAt: staleObservedAt,
      deadlineAt: staleDeadlineAt,
      payload: { schemaVersion: 1, terminatedWorkerStaleFixture: true },
    });
    const stale = runDeadman([
      '--component', component, '--instance-id', instanceId, '--generation', generation,
    ]);
    assert.equal(stale.events.length, 1);
    assert.deepEqual(
      [stale.events[0].kind, stale.events[0].generation],
      ['WATCHDOG_STALE', generation],
    );
  }
  let views = (await pool.query(`
    SELECT component, state, active_obligation_count
      FROM executable_runtime_liveness
     WHERE instance_id = $1
     ORDER BY component
  `, [instanceId])).rows;
  assert.deepEqual(views, [
    { component: 'completion-ack-watchdog', state: 'WATCHDOG_STALE', active_obligation_count: 1 },
    { component: 'outcome-watchdog', state: 'WATCHDOG_STALE', active_obligation_count: 1 },
  ]);
  const surfaces = [
    'DONE_GATE', 'AGENT_QUEUE', 'OWNER_DECISION_INBOX',
    'PROJECT_ATTENTION', 'MUTATION_RESPONSE', 'WEB',
  ];
  for (const surface of surfaces) {
    const payload = (await pool.query(
      `SELECT executable_runtime_overlay_read_surface(
         '{"schemaVersion":2,"staleness":"CURRENT","obligations":[],
           "doneGate":{"allowed":true}}'::jsonb, $1::text
       ) AS payload`,
      [surface],
    )).rows[0].payload;
    assert.equal(payload.surface, surface);
    assert.equal(payload.staleness, 'WATCHDOG_STALE');
    assert.equal(payload.doneGate.allowed, false);
    assert.equal(payload.obligations.length, 2, `${surface} lost one worker capability`);
    assert.deepEqual(
      payload.obligations.map((obligation) => obligation.kind),
      ['WATCHDOG_STALE', 'WATCHDOG_STALE'],
    );
  }

  const recoveredAt = new Date();
  for (const [component, generation] of [
    ['outcome-watchdog', watchdogGeneration],
    ['completion-ack-watchdog', completionAckGeneration],
  ]) {
    await heartbeatService.appendRuntimeHeartbeat({
      component, instanceId, sourceSha,
      moduleGraphDigest: watchdogModuleGraphDigest,
      expectationGeneration: generation,
      observedAt: recoveredAt,
      deadlineAt: new Date(recoveredAt.getTime() + 30_000),
      payload: { schemaVersion: 1, recovery: true },
    });
    const recovered = runDeadman([
      '--component', component, '--instance-id', instanceId, '--generation', generation,
    ]);
    assert.equal(recovered.events.length, 1);
    assert.deepEqual(
      [recovered.events[0].kind, recovered.events[0].generation],
      ['WATCHDOG_RECOVERED', generation],
    );
  }
  views = (await pool.query(`
    SELECT component, state, active_obligation_count
      FROM executable_runtime_liveness
     WHERE instance_id = $1
     ORDER BY component
  `, [instanceId])).rows;
  assert.deepEqual(views, [
    { component: 'completion-ack-watchdog', state: 'HEALTHY', active_obligation_count: 0 },
    { component: 'outcome-watchdog', state: 'HEALTHY', active_obligation_count: 0 },
  ]);
  for (const surface of surfaces) {
    const payload = (await pool.query(
      `SELECT executable_runtime_overlay_read_surface(
         '{"schemaVersion":2,"staleness":"CURRENT","obligations":[],
           "doneGate":{"allowed":true}}'::jsonb, $1::text
       ) AS payload`,
      [surface],
    )).rows[0].payload;
    assert.deepEqual(payload.obligations, [], `${surface} retained a recovered obligation`);
    assert.equal(payload.doneGate.allowed, true);
  }
  await assert.rejects(
    db.executableRuntimeHeartbeat.update({
      where: { id: boundHeartbeats[0].id }, data: { sequence: 99n },
    }),
    /append.only/i,
  );
  const deadmanSource = readFileSync(deadmanPath, 'utf8');
  assert.doesNotMatch(deadmanSource, /from ['"].*(outcome-watchdog|outcome-reconciler|projection|acceptance.executor)/);
  Object.assign(evidence.watchdog, {
    workerTerminated: true, detectedAt: new Date().toISOString(), maximumDeltaSeconds: 30,
    generationsRegisteredBeforeStart: 2,
    heartbeatGenerationAndModuleBound: true,
    staleEvent: true, staleSurfaceObligations: 2, recoveryEvent: true, recoveryCleared: true,
    allSixSurfacesStale: true, allSixSurfacesRecovered: true,
    deadmanReadsWorkerProjection: false,
  });
});

test('independent watchdog marks only a started ADMITTED attempt as INFRASTRUCTURE_LOST', async () => {
  await empty();
  const { fixture, delivery, started } = await admitAndStart('stale-attempt');
  const attempt = await db.taskExecutableAttempt.findUniqueOrThrow({ where: { id: started.attemptId } });
  const marked = await new OutcomeWatchdogService(db).markStaleExecutableAttempts(
    new Date(attempt.deadlineAt.getTime() + 1_000),
  );
  assert.equal(marked, 1);
  const [terminated, continuation, task] = await Promise.all([
    db.taskExecutableAttempt.findUniqueOrThrow({ where: { id: started.attemptId } }),
    db.taskExecutableContinuation.findUniqueOrThrow({ where: { attemptId: started.attemptId } }),
    db.task.findUniqueOrThrow({ where: { id: fixture.taskId } }),
  ]);
  assert.equal(terminated.terminationKind, 'INFRASTRUCTURE_LOST');
  assert.equal(continuation.goalActionable, true);
  assert.equal(task.status, TaskStatus.OPEN);
  assert.equal(delivery.acceptancePlan.effectiveTimeoutSeconds, 1200);
});

test('REST/CLI/MCP/shared wire sources expose v2 fields while retaining an explicit N-1 lane', () => {
  const sources = {
    dto: readFileSync(path.join(repo, 'src/apiserver/src/tasks/dto.ts'), 'utf8'),
    controller: readFileSync(path.join(repo, 'src/apiserver/src/runner-api/runner-api.controller.ts'), 'utf8'),
    mcp: readFileSync(path.join(repo, 'src/runner-go/mcp.go'), 'utf8'),
    cli: readFileSync(path.join(repo, 'src/runner-go/task_cli.go'), 'utf8'),
    shared: readFileSync(path.join(repo, 'src/shared/src/dto.ts'), 'utf8'),
  };
  for (const field of ['acceptanceTimeoutSeconds', 'acceptanceOwnerTimeoutCeilingSeconds']) {
    assert.match(sources.dto, new RegExp(field));
    assert.match(sources.mcp, new RegExp(field));
  }
  assert.match(sources.shared, /requestedTimeoutSeconds/);
  assert.match(sources.shared, /effectiveTimeoutSeconds/);
  assert.match(sources.cli, /acceptance-timeout-seconds/);
  assert.match(sources.controller, /TASK_ACCEPTANCE_CLIENT_TURN_V2_PREFIX/);
  assert.match(sources.controller, /version: 1/);
  assert.match(sources.shared, /INFRASTRUCTURE_LOST/);
  Object.assign(evidence.compatibility, { rest: true, cli: true, mcp: true, sharedWire: true });
});

test('successor watchdog task is atomically bound to 1200/current revision by migration source', async () => {
  const migration = readFileSync(path.join(
    repo, 'src/apiserver/prisma/migrations/0200_executable_acceptance_runtime_contract/migration.sql',
  ), 'utf8');
  assert.match(migration, /01a0480d-7aba-7281-9b84-aefcba1e75b0/);
  assert.match(migration, /"acceptance_timeout_seconds" = 1200/);
  assert.match(migration, /"acceptance_capability_revision" = 2/);
  assert.match(migration, /task_executable_plan_bind/);
  const contract = JSON.parse(readFileSync(path.join(
    repo, 'contracts/outcome-reconciler-v2-watchdog-slo.json',
  ), 'utf8'));
  const rows = await pool.query(`
    SELECT indexname FROM pg_indexes
     WHERE schemaname IN ('public', 'outcome_projection', 'outcome_watchdog')
       AND indexname = ANY($1::text[])
     ORDER BY indexname
  `, [contract.capacity.runtimeSchemaIndexes]);
  assert.deepEqual(
    rows.rows.map((row) => row.indexname),
    [...contract.capacity.runtimeSchemaIndexes].sort(),
  );
  evidence.compatibility.runtimeSchemaIndexesPresent = true;
});
