import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
const { ProjectsService } = require(path.join(apiDist, 'projects/projects.service.js'));
const { SessionsService } = require(path.join(apiDist, 'sessions/sessions.service.js'));
const { RunnerApiController } = require(path.join(apiDist, 'runner-api/runner-api.controller.js'));
const { HTTP_CODE_METADATA } = require('@nestjs/common/constants');
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

const runtimeModuleGraphDigest = sha([
  'tasks/executable-acceptance-runtime',
  'prisma',
].sort().join('\n'));

/**
 * The heartbeat writer used to live on the watchdog worker's Nest service. 0221 removed that
 * process and its data layer; the heartbeat/dead-man ledger it wrote into belongs to the 0200
 * EXECUTABLE runtime contract and stays, so this suite appends to it directly. The statement is
 * the same generic (non-binding) append the deleted service used for every component.
 */
async function appendRuntimeHeartbeat({
  component, instanceId, sourceSha: heartbeatSourceSha, moduleGraphDigest,
  expectationGeneration, observedAt, deadlineAt, payload,
}) {
  const { rows } = await pool.query(`
    WITH previous AS (
      SELECT h."sequence", h."heartbeat_digest"
        FROM "executable_runtime_heartbeat" h
       WHERE h."component" = $1::text AND h."instance_id" = $2::text
       ORDER BY h."sequence" DESC LIMIT 1
    ), material AS (
      SELECT coalesce((SELECT "sequence" FROM previous), 0) + 1 AS sequence,
             (SELECT "heartbeat_digest" FROM previous) AS previous_digest,
             $8::jsonb AS payload
    ), bound AS (
      SELECT material.*, encode(digest(material.payload::text, 'sha256'), 'hex') AS payload_digest
        FROM material
    ), final AS (
      SELECT bound.*, encode(digest(jsonb_build_object(
               'component', $1::text, 'instanceId', $2::text, 'sequence', bound.sequence,
               'sourceSha', $3::text, 'moduleGraphDigest', $4::text,
               'expectationGeneration', $5::uuid, 'observedAt', $6::timestamptz,
               'deadlineAt', $7::timestamptz, 'payloadDigest', bound.payload_digest,
               'previousDigest', bound.previous_digest
             )::text, 'sha256'), 'hex') AS heartbeat_digest
        FROM bound
    )
    INSERT INTO "executable_runtime_heartbeat"
      ("id", "component", "instance_id", "sequence", "source_sha", "module_graph_digest",
       "observed_at", "deadline_at", "payload", "payload_digest", "previous_digest",
       "heartbeat_digest", "expectation_generation")
    SELECT gen_random_uuid(), $1::text, $2::text, final.sequence, $3::text, $4::text,
           $6::timestamptz, $7::timestamptz, final.payload, final.payload_digest,
           final.previous_digest, final.heartbeat_digest, $5::uuid
      FROM final
    RETURNING "id", "heartbeat_digest" AS "heartbeatDigest", "sequence"
  `, [component, instanceId, heartbeatSourceSha, moduleGraphDigest, expectationGeneration,
      observedAt, deadlineAt, JSON.stringify(payload)]);
  return rows[0];
}

test('turn-complete success is an explicit HTTP 200 contract', () => {
  assert.equal(
    Reflect.getMetadata(HTTP_CODE_METADATA, RunnerApiController.prototype.turnComplete),
    200,
  );
  evidence.negotiation.httpSuccessStatus = 200;
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
  moduleGraphDigest = runtimeModuleGraphDigest,
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

function controller(projectAcceptance) {
  return new RunnerApiController(
    db,
    { notifySessionQueued() {} },
    realtime(),
    {}, {}, {},
    { appendFor: async (_tx, _sessionId, content) => content },
    undefined, projectAcceptance,
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
  const api = controller(options.projectAcceptance);
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
    command: 'npm run test:outcome-reconciler:replay', expectedExitCode: 0,
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
  // Merge rather than replace: the HTTP 200 contract test writes `httpSuccessStatus` into this
  // same block, and ba1f1972 moved that test above this one, so a wholesale assignment silently
  // dropped the key the manifest asserts. Every other writer of `evidence.negotiation` already
  // merges.
  Object.assign(evidence.negotiation, {
    rejected, admitted, planDigest: plan.evaluationPlanDigest,
  });
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

// Until 2026-09-02 a typed EXITED termination derived DONE or FAILED from the declared code. The
// account owner had that evaluator removed with the judgment machinery, to be rebuilt, so what the
// typed lane still does is record the attempt exactly and hand it to project acceptance — and what
// it no longer does is move the task.
test('typed EXITED records the attempt exactly and no longer derives a task status', async () => {
  await empty();
  for (const actualExitCode of [0, 9]) {
    const reconciledTaskIds = [];
    const { fixture, api, delivery, started } = await admitAndStart(`exited-${actualExitCode}`, {
      projectAcceptance: {
        reconcileForEvidenceTask: async (taskId) => reconciledTaskIds.push(taskId),
      },
    });
    await api.turnComplete({ id: fixture.runnerId }, fixture.sessionId, {
      turnId: delivery.turnId, status: RunStatus.SUCCEEDED, subtype: 'shell', shellOutput: 'output',
      acceptanceAdmissionId: delivery.acceptancePlan.admissionId,
      acceptanceAttemptId: started.attemptId, acceptanceTerminationKind: 'EXITED',
      acceptanceActualExitCode: actualExitCode,
    });
    const settled = await db.task.findUniqueOrThrow({ where: { id: fixture.taskId } });
    assert.equal(settled.status, TaskStatus.OPEN,
      `exit ${actualExitCode} must derive nothing: EXECUTABLE has no implementation`);
    assert.equal(settled.completionCriterion, 'EXECUTABLE');
    assert.ok(settled.acceptanceCommand, 'and the declaration it was run from is untouched');
    const attempt = await db.taskExecutableAttempt.findFirstOrThrow({
      where: { taskId: fixture.taskId },
    });
    assert.equal(attempt.terminationKind, 'EXITED');
    assert.equal(attempt.actualExitCode, actualExitCode);
    assert.equal(await db.taskCompletionEvidence.count({ where: { taskId: fixture.taskId } }), 0);
    assert.equal(await db.taskExecutableAdmission.count({ where: { taskId: fixture.taskId } }), 1);
    assert.equal(await db.taskExecutableAttempt.count({ where: { taskId: fixture.taskId } }), 1);
    assert.deepEqual(
      reconciledTaskIds,
      [fixture.taskId],
      'the committed typed attempt is still delivered to project acceptance',
    );
  }
});

/**
 * What a pre-0193 v1 callback does now.
 *
 * Three tests stood here: one proved the callback created a canonical judgment atomically and
 * replayed as a no-op, one proved a nonzero exit recorded FAIL, and one proved it never consumed a
 * stale OPEN request. All three were about the evidence/request/result bridge the account owner
 * had removed on 2026-09-02. What has to remain true — and is the reason this replaces rather than
 * merely deletes them — is that an old runner still on the v1 wire cannot wedge or corrupt
 * anything: the ACK commits, the turn is answered, the session ends with an explicit signal rather
 * than silently, and the task keeps both its status and its declaration.
 */
test('a rolling v1 callback settles nothing and leaves the declaration intact', async () => {
  await empty();
  const fixture = await executableFixture('rolling-v1-inert', { legacy: true });
  const api = controller();
  await queueAcceptance(api, fixture);
  const delivery = await dequeue(api, fixture, null);
  assert.equal(delivery.taskAcceptance, true);
  assert.equal(delivery.acceptancePlan, undefined, 'a legacy fixture stays on the v1 wire');

  const rawOutput = '16 tests\n16 pass\n0 fail\n';
  const callback = {
    turnId: delivery.turnId,
    status: RunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: 0,
    shellOutput: rawOutput,
    costUsd: 1.25,
    usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3 },
  };
  const first = await api.turnComplete({ id: fixture.runnerId }, fixture.sessionId, callback);
  assert.deepEqual(first, { ok: true, status: RunStatus.FAILED },
    'a reserved turn with nothing left to compare it ends the session explicitly');

  const [task, session, turn] = await Promise.all([
    db.task.findUniqueOrThrow({ where: { id: fixture.taskId } }),
    db.session.findUniqueOrThrow({ where: { id: fixture.sessionId } }),
    db.conversationTurn.findUniqueOrThrow({ where: { id: delivery.turnId } }),
  ]);
  assert.equal(turn.status, 'ANSWERED', 'the ACK still commits: an old runner is not wedged');
  assert.equal(session.engineTurnActive, false);
  assert.equal(session.costUsd, 1.25, 'and its usage is still booked');
  assert.equal(task.status, TaskStatus.OPEN);
  assert.equal(task.completionCriterion, 'EXECUTABLE');
  assert.ok(task.acceptanceCommand);
  assert.equal(task.acceptanceExpectedExitCode, 0);
  assert.equal(await db.taskCompletionEvidence.count({ where: { taskId: fixture.taskId } }), 0,
    'the v1 bridge that used to mint evidence from a shell result is gone');
  assert.equal(await db.taskExecutableAdmission.count({ where: { taskId: fixture.taskId } }), 0);
  assert.equal(await db.taskExecutableAttempt.count({ where: { taskId: fixture.taskId } }), 0);
  assert.equal(await db.taskComment.count({ where: { taskId: fixture.taskId } }), 1,
    'exactly one human-facing signal, and it is the needs-human one');

  const repeated = await api.turnComplete({ id: fixture.runnerId }, fixture.sessionId, callback);
  assert.deepEqual(repeated, { ok: true, status: RunStatus.FAILED });
  assert.equal(await db.taskComment.count({ where: { taskId: fixture.taskId } }), 1,
    'a retried callback duplicates nothing');
  evidence.compatibility.rollingV1CallbackIsInert = {
    ackCommitted: true, duplicateNoop: true, taskStatusDerived: false, declarationIntact: true,
  };
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
    title: 'legacy acceptance suite', assigneeId: base.workspaceId, status: TaskStatus.FAILED,
    completionCriterion: 'EXECUTABLE', acceptanceCommand: 'npm run test:outcome-reconciler:replay',
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
    kind: 'shell', content: 'npm run test:outcome-reconciler:replay', status: 'ANSWERED',
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
  const common = { completionCriterion: 'EVIDENCE_JUDGMENT', ...(withProject ? { projectId: base.projectId } : {}) };
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
  // 0205 deliberately dampens a refused automatic dispatch at one epoch. Move the task to its
  // next dispatch moment before exercising the periodic door; the dependency edge still names W
  // and its DONE chain tail is still S, while the durable wake correctly remains scoped to the
  // failed prior moment.
  await db.task.update({
    where: { id: chain.dependentId },
    data: { runAt: new Date(Date.now() - 1_000) },
  });
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
  const left = await service.create(base.ownerId, { title: 'cycle-left', completionCriterion: 'EVIDENCE_JUDGMENT' });
  const right = await service.create(base.ownerId, { title: 'cycle-right', completionCriterion: 'EVIDENCE_JUDGMENT' });
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
    ['STARTING', 'STARTING', sourceSha, runtimeModuleGraphDigest, null],
  );
  const duringGraceAt = new Date(
    new Date(expected.startup_deadline_at).getTime() - 1,
  ).toISOString();
  // Force the database wall clock past the deadline before the scan connects. The scan must be
  // classified at its captured start time, not at an arbitrary later point in connection setup.
  await waitPast(expected.startup_deadline_at);
  const duringGrace = runDeadman([
    '--component', component, '--instance-id', instanceId, '--generation', generation,
    '--now', duringGraceAt,
  ]);
  assert.deepEqual(
    [duringGrace.starting, duringGrace.missing, duringGrace.events.length],
    [1, 0, 0],
  );
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
    scanStartBound: true,
    startupGraceSeconds: 1,
    missingEventExactlyOnce: true,
  });
});

test('external dead-man detects an expired generation-bound heartbeat and exact recovery', async () => {
  await empty();
  const instanceId = 'acceptance-worker';
  const watchdogGeneration = randomUUID();
  // Two independently registered components, because the overlay aggregation below has to show
  // one obligation per expected component rather than one per instance.
  const coordinatorGeneration = randomUUID();
  {
    const registered = registerRuntimeExpectation({
      component: 'outcome-watchdog', instanceId, generation: watchdogGeneration,
    });
    assert.deepEqual(
      [registered.component, registered.instanceId, registered.generation, registered.replayed],
      ['outcome-watchdog', instanceId, watchdogGeneration, false],
    );
  }
  // 0221 removed the watchdog process, so nothing runs to emit this heartbeat any more. The
  // ledger, its expectation guard and the dead-man that reads them are the 0200 runtime contract
  // and stay: one live append is what proves the generation binding is still enforced.
  await appendRuntimeHeartbeat({
    component: 'outcome-watchdog', instanceId, sourceSha,
    moduleGraphDigest: runtimeModuleGraphDigest,
    expectationGeneration: watchdogGeneration,
    observedAt: new Date(), deadlineAt: new Date(Date.now() + 30_000),
    payload: { schemaVersion: 1, liveGenerationFixture: true },
  });
  const boundHeartbeats = await db.executableRuntimeHeartbeat.findMany({
    where: { instanceId },
    orderBy: [{ component: 'asc' }, { sequence: 'desc' }],
  });
  assert.equal(boundHeartbeats.length, 1);
  assert.deepEqual(
    boundHeartbeats.map((row) => [
      row.component, row.expectationGeneration, row.sourceSha, row.moduleGraphDigest,
    ]),
    [['outcome-watchdog', watchdogGeneration, sourceSha, runtimeModuleGraphDigest]],
  );
  await assert.rejects(
    appendRuntimeHeartbeat({
      component: 'outcome-watchdog', instanceId, sourceSha,
      moduleGraphDigest: sha('wrong-module-graph'),
      expectationGeneration: watchdogGeneration,
      observedAt: new Date(), deadlineAt: new Date(Date.now() + 30_000),
      payload: { schemaVersion: 1, invalidBindingFixture: true },
    }),
    /EXECUTABLE_RUNTIME_HEARTBEAT_EXPECTATION_MISMATCH/,
  );
  // Append a production-valid, exact-generation observation whose deadline has elapsed. This
  // keeps the acceptance suite bounded while exercising the same DB-clock dead-man predicate as
  // a worker that stopped for the full 30 second SLO; no mutable clock or projection is patched.
  const staleObservedAt = new Date(Date.now() - 31_000);
  const staleDeadlineAt = new Date(Date.now() - 1_000);
  registerRuntimeExpectation({
    component: 'outcome-coordinator', instanceId, generation: coordinatorGeneration,
  });
  for (const [component, generation] of [
    ['outcome-coordinator', coordinatorGeneration],
    ['outcome-watchdog', watchdogGeneration],
  ]) {
    await appendRuntimeHeartbeat({
      component, instanceId, sourceSha,
      moduleGraphDigest: runtimeModuleGraphDigest,
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
    { component: 'outcome-coordinator', state: 'WATCHDOG_STALE', active_obligation_count: 1 },
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
    ['outcome-coordinator', coordinatorGeneration],
    ['outcome-watchdog', watchdogGeneration],
  ]) {
    await appendRuntimeHeartbeat({
      component, instanceId, sourceSha,
      moduleGraphDigest: runtimeModuleGraphDigest,
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
    { component: 'outcome-coordinator', state: 'HEALTHY', active_obligation_count: 0 },
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
    detectedAt: new Date().toISOString(), maximumDeltaSeconds: 30,
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
  const marked = (await pool.query(
    'SELECT executable_acceptance_mark_stale_attempts($1::timestamptz, 64) AS count',
    [new Date(attempt.deadlineAt.getTime() + 1_000)],
  )).rows[0].count;
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
  // The index census used to be read from the watchdog SLO contract, which 0221 deleted along
  // with the collector that consumed it. The indexes it required are the EXECUTABLE runtime
  // ledger's own, so the requirement is stated here rather than dropped.
  //
  // Two of the four names were transcribed from schema.prisma rather than from the migration that
  // actually creates them, so this census named objects that have never existed and the assertion
  // could not pass -- it went unnoticed because the node was only ever reached behind a red
  // dependency. Both objects are present under the names 0200 gives them: the dead-man index is
  // `executable_dead_man_latest_idx` (schema.prisma:3835, on the table mapped to
  // `executable_dead_man_event`), and the heartbeat uniqueness is the inline, unnamed
  // `UNIQUE ("component", "instance_id", "sequence")` at 0200:475, which PostgreSQL names
  // `executable_runtime_heartbeat_component_instance_id_sequence_key`. schema.prisma:3813 still
  // declares `map: "executable_runtime_heartbeat_sequence_key"` for that same constraint; the
  // names disagree, and renaming the live index to match would take a migration. The census
  // asserts what the database actually has.
  const runtimeSchemaIndexes = [
    'executable_dead_man_latest_idx',
    'executable_runtime_expectation_slot_idx',
    'executable_runtime_heartbeat_component_instance_id_sequence_key',
    'executable_runtime_heartbeat_latest_idx',
  ];
  const rows = await pool.query(`
    SELECT indexname FROM pg_indexes
     WHERE schemaname IN ('public', 'outcome_projection')
       AND indexname = ANY($1::text[])
     ORDER BY indexname
  `, [runtimeSchemaIndexes]);
  assert.deepEqual(rows.rows.map((row) => row.indexname), [...runtimeSchemaIndexes].sort());
  evidence.compatibility.runtimeSchemaIndexesPresent = true;
});
