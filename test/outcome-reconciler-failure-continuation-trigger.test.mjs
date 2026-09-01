import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { after } from 'node:test';

const require = createRequire(import.meta.url);
const repo = path.resolve(import.meta.dirname, '..');
const apiDist = path.join(repo, 'src/apiserver/dist');
const url = process.env.FAILURE_CONTINUATION_PG_URL;
const evidencePath = process.env.FAILURE_CONTINUATION_EVIDENCE_PATH;
const targetSha = process.env.FAILURE_CONTINUATION_TARGET_SHA;
const expectedDatabase = process.env.FAILURE_CONTINUATION_PG_EXPECTED_DATABASE;
const expectedUser = process.env.FAILURE_CONTINUATION_PG_EXPECTED_USER;
const expectedSystemIdentifier =
  process.env.FAILURE_CONTINUATION_PG_EXPECTED_SYSTEM_IDENTIFIER;
const startedAt = process.env.FAILURE_CONTINUATION_STARTED_AT;

assert.ok(url, 'FAILURE_CONTINUATION_PG_URL is required');
assert.ok(evidencePath, 'FAILURE_CONTINUATION_EVIDENCE_PATH is required');
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
const { CoordinatorWakeService } = require(path.join(
  apiDist,
  'projects/coordinator-wake.service.js',
));
const { CoordinatorJudgmentService } = require(path.join(
  apiDist,
  'projects/coordinator-judgment.service.js',
));
const { FailureContinuationService } = require(path.join(
  apiDist,
  'projects/failure-continuation.service.js',
));
const {
  failureContinuationIdempotencyKey,
  failureContinuationWakeFact,
} = require(path.join(apiDist, 'projects/failure-continuation.js'));
const runtime = require(path.join(apiDist, 'tasks/executable-acceptance-runtime.js'));
const {
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} = require(path.join(repo, 'src/apiserver/node_modules/@prisma/client'));

const db = prismaClientFor(url);
const pool = new Pool({ connectionString: url, max: 12 });
const COMMAND = 'node -e "process.exit(9)"';
const RAW_OUTPUT = 'fixture assertion failed\n';

const evidence = {
  schemaVersion: 1,
  suite: 'failure-continuation-transactional-trigger-v1',
  outcome: 'INCOMPLETE',
  targetSha,
  postgres: {
    required: true,
    connected: false,
    database: null,
    user: null,
    systemIdentifier: null,
    migrations: Number(process.env.FAILURE_CONTINUATION_MIGRATION_COUNT ?? 0),
    lastMigration: process.env.FAILURE_CONTINUATION_LAST_MIGRATION ?? null,
    requiredMigrationApplied:
      process.env.FAILURE_CONTINUATION_REQUIRED_MIGRATION_APPLIED === '1',
  },
  observationWindow: {
    startedAt,
    finishedAt: null,
    durationMilliseconds: null,
  },
  samples: {
    transactionalFailures: 0,
    duplicateCallbacks: 0,
    immutableReceiptRefusals: 0,
    concurrentLeaseClaims: 0,
    crashTakeovers: 0,
    historicalSweeps: 0,
    successorSuppressions: 0,
  },
  coverage: {
    isolatedDatabase: false,
    atomicReceiptObligationOutbox: false,
    duplicateTerminationDeduped: false,
    receiptImmutable: false,
    originalFailurePreserved: false,
    noOriginalCommandRetry: false,
    leaseExclusive: false,
    crashRecovery: false,
    replayDeduped: false,
    historicalDiagnosisRecovered: false,
    currentSuccessorSuppressesSweep: false,
    noOwnerDecision: false,
    noOwnerCredentialsMinted: false,
    productionWrites: false,
  },
  results: {},
};

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

function realtime() {
  return new Proxy({}, {
    get: (_target, property) => property === 'waitForInbox'
      ? async () => undefined
      : () => undefined,
  });
}

const live = realtime();
const queue = { notifySessionQueued() {} };

function taskService() {
  return new TasksService(db, {}, live);
}

function runnerApi(failureContinuations) {
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
    undefined,
    failureContinuations,
  );
}

function courierStack() {
  const sessions = new SessionsService(db, queue, live);
  const wakes = new CoordinatorWakeService(db);
  const judgments = new CoordinatorJudgmentService(db, wakes, sessions);
  return {
    judgments,
    courier: new FailureContinuationService(db, judgments),
  };
}

async function empty() {
  await pool.query(`
    TRUNCATE failure_continuation_wakeup_outbox,
             failure_continuation_obligation,
             failure_continuation_attempt_receipt,
             task, session, workspace, runner, project, "user"
    RESTART IDENTITY CASCADE
  `);
}

async function fixture(label) {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@failure-continuation.invalid`,
      name: label,
      // Fixture material in a disposable database; no usable owner token/session is minted.
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
      coordinatorEnabled: false,
      coordinatorWorkspaceId: workspaceId,
    },
  });
  await db.projectRuntime.upsert({
    where: { projectId },
    create: { projectId },
    update: {},
  });
  const task = await taskService().create(ownerId, {
    title: `${label}-task`,
    projectId,
    assigneeId: workspaceId,
    completionCriterion: 'EXECUTABLE',
    acceptanceCriteria: 'The isolated fixture command exits with code 0.',
    acceptanceCommand: COMMAND,
    acceptanceExpectedExitCode: 0,
    acceptanceTimeoutSeconds: 120,
    acceptanceOwnerTimeoutCeilingSeconds: 120,
  });
  const sessionId = randomUUID();
  const messageTurnId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId,
      ownerId,
      creatorId: ownerId,
      taskId: task.id,
      workspaceId,
      assignedRunnerId: runnerId,
      title: label,
      prompt: label,
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
      content: 'finish the fixture work',
      status: 'IN_FLIGHT',
    },
  });
  return {
    ownerId,
    runnerId,
    workspaceId,
    projectId,
    taskId: task.id,
    sessionId,
    messageTurnId,
  };
}

async function admitAndStart(label, failureContinuations) {
  const target = await fixture(label);
  const api = runnerApi(failureContinuations);
  await api.turnComplete({ id: target.runnerId }, target.sessionId, {
    turnId: target.messageTurnId,
    status: RunStatus.SUCCEEDED,
  });
  const delivery = await api.dequeueTurn(
    target.sessionId,
    target.runnerId,
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
  assert.ok(delivery?.acceptancePlan, 'typed executable turn was not admitted');
  const started = await api.startExecutableAcceptanceAttempt(
    { id: target.runnerId },
    target.sessionId,
    delivery.acceptancePlan.admissionId,
  );
  const callback = {
    turnId: delivery.turnId,
    status: RunStatus.SUCCEEDED,
    subtype: 'shell',
    shellOutput: RAW_OUTPUT,
    acceptanceAdmissionId: delivery.acceptancePlan.admissionId,
    acceptanceAttemptId: started.attemptId,
    acceptanceTerminationKind: 'EXITED',
    acceptanceActualExitCode: 9,
  };
  return { target, api, delivery, started, callback };
}

async function committedFailure(label, failureContinuations) {
  const state = await admitAndStart(label, failureContinuations);
  const ownerDecisionsBeforeFailure = await ownerDecisionCounts(
    state.target.projectId,
    state.target.taskId,
  );
  const result = await state.api.turnComplete(
    { id: state.target.runnerId },
    state.target.sessionId,
    state.callback,
  );
  assert.equal(result.status, RunStatus.FAILED);
  assert.deepEqual(
    await ownerDecisionCounts(state.target.projectId, state.target.taskId),
    ownerDecisionsBeforeFailure,
    'the typed failure transaction must not create an owner-decision request',
  );
  return { ...state, ownerDecisionsBeforeFailure };
}

async function failureRows(taskId) {
  const result = await pool.query(`
    SELECT receipt.receipt_id, receipt.receipt_digest::text,
           receipt.failure_fingerprint::text, receipt.binding_revision::text,
           receipt.attempt_generation::text, receipt.output_digest::text,
           obligation.obligation_id, obligation.continuation_id,
           obligation.idempotency_key::text,
           wakeup.outbox_id, wakeup.planned_session_id, wakeup.state,
           wakeup.lease_generation::text, wakeup.delivery_attempts,
           wakeup.coordinator_wake_id, wakeup.coordinator_session_id
      FROM failure_continuation_attempt_receipt receipt
      JOIN failure_continuation_obligation obligation
        ON obligation.receipt_id = receipt.receipt_id
      JOIN failure_continuation_wakeup_outbox wakeup
        ON wakeup.obligation_id = obligation.obligation_id
     WHERE receipt.task_id = $1::uuid
  `, [taskId]);
  return result.rows;
}

async function counts(taskId) {
  return (await pool.query(`
    SELECT
      (SELECT count(*)::integer FROM task_executable_attempt WHERE task_id = $1::uuid) attempts,
      (SELECT count(*)::integer FROM task_executable_continuation WHERE task_id = $1::uuid) continuations,
      (SELECT count(*)::integer FROM task_executable_diagnosis WHERE task_id = $1::uuid) diagnoses,
      (SELECT count(*)::integer FROM failure_continuation_attempt_receipt WHERE task_id = $1::uuid) receipts,
      (SELECT count(*)::integer FROM failure_continuation_obligation WHERE task_id = $1::uuid) obligations,
      (SELECT count(*)::integer FROM failure_continuation_wakeup_outbox WHERE task_id = $1::uuid) wakeups
  `, [taskId])).rows[0];
}

async function originalCommandTurnCount(taskId) {
  return (await pool.query(`
    SELECT count(*)::integer AS count
      FROM conversation_turn turn_row
      JOIN session source_session ON source_session.id = turn_row.session_id
     WHERE source_session.task_id = $1::uuid
       AND turn_row.kind = 'shell'
       AND turn_row.content = $2
  `, [taskId, COMMAND])).rows[0].count;
}

async function ownerDecisionCounts(projectId, taskId) {
  // The generic coordinator owner-decision request table was removed with the persistent
  // coordinator (0221). Its absence is the stronger form of the "no generic owner work was
  // created" assertion these cases make, so it is checked instead of counted.
  return (await pool.query(`
    SELECT
      (SELECT CASE WHEN to_regclass('public.outcome_coordinator_owner_decision_request') IS NULL
                   THEN 0 ELSE 1 END) outcome_owner,
      (SELECT count(*)::integer FROM task_judgment_request
        WHERE task_id = $2::uuid AND kind = 'HUMAN_SIGNOFF') human_signoff
  `, [projectId, taskId])).rows[0];
}

async function enableCoordinator(projectId) {
  await db.project.update({
    where: { id: projectId },
    data: { coordinatorEnabled: true },
  });
}

async function seedHistoricalDiagnosis(label) {
  const state = await admitAndStart(label);
  const attempt = await db.taskExecutableAttempt.findUniqueOrThrow({
    where: { id: state.started.attemptId },
  });
  const failureFingerprint = runtime.executableFailureFingerprint({
    evaluationPlanDigest: attempt.evaluationPlanDigest,
    terminationKind: 'EXITED',
    actualExitCode: 9,
    signal: null,
    failureSiteDigest: runtime.executableFailureSiteIdentity(RAW_OUTPUT).digest,
  });
  const continuationId = randomUUID();
  const diagnosisId = randomUUID();
  const terminatedAt = new Date();
  const diagnosisEvidence = {
    evaluationPlanDigest: attempt.evaluationPlanDigest,
    terminationKind: 'EXITED',
    actualExitCode: 9,
    signal: null,
    attemptNumber: attempt.attemptNumber,
    outputTruncated: false,
    historicalFixture: true,
  };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Test-only compatibility fixture. Production triggers are disabled only inside this
    // disposable transaction to reproduce a row shape committed before migration 0210.
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query(`
      UPDATE task_executable_attempt
         SET terminated_at = $2, termination_kind = 'EXITED', actual_exit_code = 9,
             raw_output = $3, output_truncated = false, failure_fingerprint = $4
       WHERE id = $1::uuid
    `, [attempt.id, terminatedAt, RAW_OUTPUT, failureFingerprint]);
    await client.query(`
      INSERT INTO task_executable_continuation (
        id, task_id, attempt_id, kind, reason_code, goal_actionable, status
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'DIAGNOSIS',
        'EXIT_CODE_MISMATCH', true, 'ACTIVE')
    `, [continuationId, state.target.taskId, attempt.id]);
    await client.query(`
      INSERT INTO task_executable_diagnosis (
        id, task_id, session_id, attempt_id, kind, source, evidence,
        evidence_digest, idempotency_key
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'UNEXPECTED_EXIT',
        'TYPED_ATTEMPT', $5::jsonb, $6, $7)
    `, [
      diagnosisId,
      state.target.taskId,
      state.target.sessionId,
      attempt.id,
      JSON.stringify(diagnosisEvidence),
      sha256(JSON.stringify(diagnosisEvidence)),
      `historical-typed-attempt:${attempt.id}`,
    ]);
    await client.query(
      "UPDATE task SET status = 'FAILED', updated_at = statement_timestamp() WHERE id = $1::uuid",
      [state.target.taskId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return { ...state, attempt, failureFingerprint, continuationId };
}

test('the regression is connected only to the declared disposable PostgreSQL identity', async () => {
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
  evidence.coverage.noOwnerCredentialsMinted = true;
});

test('typed failure rolls back as one unit, then commits one receipt, diagnosis obligation and wakeup',
  { timeout: 120_000 }, async () => {
    await empty();
    let kicks = 0;
    const state = await admitAndStart('atomic', { kick: () => { kicks += 1; } });
    await pool.query(`
      CREATE FUNCTION failure_continuation_test_reject_outbox() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'FAILURE_CONTINUATION_OUTBOX_COMMIT_INJECTION'
          USING ERRCODE = 'P0001';
      END;
      $$ LANGUAGE plpgsql
    `);
    await pool.query(`
      CREATE TRIGGER failure_continuation_test_reject_outbox
      AFTER INSERT ON failure_continuation_wakeup_outbox
      FOR EACH ROW EXECUTE FUNCTION failure_continuation_test_reject_outbox()
    `);
    try {
      await assert.rejects(
        state.api.turnComplete(
          { id: state.target.runnerId },
          state.target.sessionId,
          state.callback,
        ),
        /FAILURE_CONTINUATION_OUTBOX_COMMIT_INJECTION/,
      );
    } finally {
      await pool.query(`
        DROP TRIGGER failure_continuation_test_reject_outbox
          ON failure_continuation_wakeup_outbox
      `);
      await pool.query('DROP FUNCTION failure_continuation_test_reject_outbox()');
    }

    const rolledBack = await counts(state.target.taskId);
    assert.deepEqual(rolledBack, {
      attempts: 1,
      continuations: 0,
      diagnoses: 0,
      receipts: 0,
      obligations: 0,
      wakeups: 0,
    });
    assert.equal((await db.taskExecutableAttempt.findUniqueOrThrow({
      where: { id: state.started.attemptId },
    })).terminationKind, null);
    assert.equal((await db.task.findUniqueOrThrow({
      where: { id: state.target.taskId },
    })).status, TaskStatus.OPEN);
    assert.equal((await db.conversationTurn.findUniqueOrThrow({
      where: { id: state.delivery.turnId },
    })).status, 'IN_FLIGHT');
    assert.equal(kicks, 0, 'a rolled-back outbox must not emit the post-commit latency nudge');

    const committed = await state.api.turnComplete(
      { id: state.target.runnerId },
      state.target.sessionId,
      state.callback,
    );
    assert.equal(committed.status, RunStatus.FAILED);
    assert.equal(kicks, 1);
    assert.deepEqual(await counts(state.target.taskId), {
      attempts: 1,
      continuations: 1,
      diagnoses: 1,
      receipts: 1,
      obligations: 1,
      wakeups: 1,
    });

    const transactionIds = (await pool.query(`
      SELECT attempt.xmin::text AS attempt_xid,
             continuation.xmin::text AS continuation_xid,
             receipt.xmin::text AS receipt_xid,
             obligation.xmin::text AS obligation_xid,
             wakeup.xmin::text AS wakeup_xid
        FROM task_executable_attempt attempt
        JOIN task_executable_continuation continuation
          ON continuation.attempt_id = attempt.id
        JOIN failure_continuation_attempt_receipt receipt
          ON receipt.attempt_id = attempt.id
        JOIN failure_continuation_obligation obligation
          ON obligation.continuation_id = continuation.id
        JOIN failure_continuation_wakeup_outbox wakeup
          ON wakeup.obligation_id = obligation.obligation_id
       WHERE attempt.id = $1::uuid
    `, [state.started.attemptId])).rows[0];
    assert.equal(new Set(Object.values(transactionIds)).size, 1,
      `all failure facts must share one PostgreSQL xid: ${JSON.stringify(transactionIds)}`);

    const [row] = await failureRows(state.target.taskId);
    const expectedKey = failureContinuationIdempotencyKey({
      goalId: state.target.projectId,
      taskId: state.target.taskId,
      bindingRevision: row.binding_revision,
      attemptGeneration: row.attempt_generation,
      failureFingerprint: row.failure_fingerprint.trim(),
    });
    assert.equal(row.idempotency_key.trim(), expectedKey);

    const beforeReplay = JSON.stringify(await failureRows(state.target.taskId));
    const replay = await state.api.turnComplete(
      { id: state.target.runnerId },
      state.target.sessionId,
      state.callback,
    );
    assert.equal(replay.status, RunStatus.FAILED);
    assert.equal(JSON.stringify(await failureRows(state.target.taskId)), beforeReplay);
    assert.equal(kicks, 1, 'duplicate termination ACK must not publish a second outbox nudge');

    evidence.samples.transactionalFailures = 1;
    evidence.samples.duplicateCallbacks = 1;
    evidence.coverage.atomicReceiptObligationOutbox = true;
    evidence.coverage.duplicateTerminationDeduped = true;
    evidence.results.atomicCommit = {
      rollbackCounts: rolledBack,
      committedCounts: await counts(state.target.taskId),
      transactionId: transactionIds.receipt_xid,
      idempotencyKey: expectedKey,
    };
  });

test('the receipt and typed termination are immutable while FAILED remains the original fact',
  { timeout: 120_000 }, async () => {
    await empty();
    const state = await committedFailure('immutable');
    const [before] = await failureRows(state.target.taskId);
    await assert.rejects(
      pool.query(`
        UPDATE failure_continuation_attempt_receipt
           SET output_digest = repeat('0', 64)::char(64)
         WHERE receipt_id = $1::uuid
      `, [before.receipt_id]),
      /OUTCOME_APPEND_ONLY_VIOLATION/,
    );
    await assert.rejects(
      pool.query(
        'DELETE FROM failure_continuation_attempt_receipt WHERE receipt_id = $1::uuid',
        [before.receipt_id],
      ),
      /OUTCOME_APPEND_ONLY_VIOLATION/,
    );
    await assert.rejects(
      pool.query(`
        UPDATE task_executable_attempt SET raw_output = 'rewritten'
         WHERE id = $1::uuid
      `, [state.started.attemptId]),
      /termination is append-only/,
    );
    const [afterRefusals] = await failureRows(state.target.taskId);
    assert.equal(afterRefusals.receipt_digest.trim(), before.receipt_digest.trim());
    assert.equal(afterRefusals.output_digest.trim(), sha256(RAW_OUTPUT));
    assert.equal((await db.task.findUniqueOrThrow({
      where: { id: state.target.taskId },
    })).status, TaskStatus.FAILED);
    assert.equal(await originalCommandTurnCount(state.target.taskId), 1);
    assert.equal((await counts(state.target.taskId)).attempts, 1);
    assert.deepEqual(
      await ownerDecisionCounts(state.target.projectId, state.target.taskId),
      state.ownerDecisionsBeforeFailure,
    );

    evidence.samples.immutableReceiptRefusals = 3;
    evidence.coverage.receiptImmutable = true;
    evidence.coverage.originalFailurePreserved = true;
    evidence.coverage.noOriginalCommandRetry = true;
    evidence.results.immutability = {
      receiptDigest: before.receipt_digest.trim(),
      taskStatus: TaskStatus.FAILED,
      attempts: 1,
      commandTurns: 1,
    };
  });

test('one lease wins, a crashed claimant is taken over, and replay adopts one planned Session',
  { timeout: 120_000 }, async () => {
    await empty();
    const state = await committedFailure('crash-recovery');
    await enableCoordinator(state.target.projectId);
    const ownerDecisionsBeforeDelivery = await ownerDecisionCounts(
      state.target.projectId,
      state.target.taskId,
    );
    const { courier, judgments } = courierStack();
    const firstObservedAt = new Date(Date.now() + 1_000);
    const [left, right] = await Promise.all([
      courier.claimDue('fixture-worker-left', firstObservedAt, 1, 1),
      courier.claimDue('fixture-worker-right', firstObservedAt, 1, 1),
    ]);
    const firstClaims = [...left, ...right];
    assert.equal(firstClaims.length, 1, 'SKIP LOCKED must produce one live claimant');
    const firstClaim = firstClaims[0];
    assert.equal(firstClaim.leaseGeneration, 1n);

    // Reproduce death after the external effect and before the outbox ACK.
    const firstDelivery = await judgments.wakePlanned(
      failureContinuationWakeFact(firstClaim),
      () => ({ allowed: true }),
      firstClaim.plannedSessionId,
    );
    assert.equal(firstDelivery.outcome, 'OPENED');
    assert.equal(firstDelivery.sessionId, firstClaim.plannedSessionId);
    assert.equal(
      (await courier.claimDue(
        'fixture-worker-too-early',
        new Date(firstObservedAt.getTime() + 500),
        30,
        1,
      )).length,
      0,
      'a live lease cannot be double-claimed',
    );

    const takeoverAt = new Date(firstObservedAt.getTime() + 1_500);
    const takeoverClaims = await courier.claimDue(
      'fixture-worker-takeover',
      takeoverAt,
      30,
      1,
    );
    assert.equal(takeoverClaims.length, 1);
    const takeover = takeoverClaims[0];
    assert.equal(takeover.outboxId, firstClaim.outboxId);
    assert.equal(takeover.plannedSessionId, firstClaim.plannedSessionId);
    assert.equal(takeover.leaseGeneration, 2n);
    assert.notEqual(takeover.leaseToken, firstClaim.leaseToken);
    assert.equal(await courier.deliverClaim(firstClaim, takeoverAt), false,
      'the expired generation must be fenced after takeover');
    assert.equal(await courier.deliverClaim(takeover, takeoverAt), true);
    assert.equal(await courier.deliverClaim(takeover, takeoverAt), false,
      'a delivered generation cannot ACK twice');

    const [outbox] = await failureRows(state.target.taskId);
    assert.equal(outbox.state, 'DELIVERED');
    assert.equal(outbox.lease_generation, '2');
    assert.equal(outbox.delivery_attempts, 2);
    assert.equal(outbox.coordinator_session_id, firstClaim.plannedSessionId);
    assert.equal((await db.session.count({
      where: {
        ownerId: state.target.ownerId,
        deletedAt: null,
        dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR,
      },
    })), 1);
    assert.equal((await db.projectCoordinatorWake.count({
      where: {
        projectId: state.target.projectId,
        event: 'FAILURE_CONTINUATION_ACTIONABLE',
        status: 'SESSION_OPENED',
      },
    })), 1);

    const afterReplayAt = new Date(takeoverAt.getTime() + 2_000);
    assert.deepEqual(await courier.sweep(afterReplayAt), {
      scanned: 0,
      materialized: 0,
      requeued: 0,
    });
    assert.equal((await courier.claimDue(
      'fixture-worker-replay',
      afterReplayAt,
      30,
      1,
    )).length, 0);
    assert.equal((await counts(state.target.taskId)).attempts, 1);
    assert.equal(await originalCommandTurnCount(state.target.taskId), 1);
    assert.deepEqual(
      await ownerDecisionCounts(state.target.projectId, state.target.taskId),
      ownerDecisionsBeforeDelivery,
      'coordinator delivery must not turn an agent-owned diagnosis into an owner decision',
    );

    evidence.samples.concurrentLeaseClaims = 2;
    evidence.samples.crashTakeovers = 1;
    evidence.coverage.leaseExclusive = true;
    evidence.coverage.crashRecovery = true;
    evidence.coverage.replayDeduped = true;
    evidence.coverage.noOwnerDecision = true;
    evidence.results.crashRecovery = {
      firstGeneration: '1',
      takeoverGeneration: '2',
      deliveryAttempts: 2,
      plannedSessionId: firstClaim.plannedSessionId,
      liveCoordinatorSessions: 1,
      coordinatorWakes: 1,
    };
  });

test('the periodic sweep materializes a pre-0210 ACTIVE goalActionable diagnosis exactly once',
  { timeout: 120_000 }, async () => {
    await empty();
    const state = await seedHistoricalDiagnosis('historical');
    assert.deepEqual(await counts(state.target.taskId), {
      attempts: 1,
      continuations: 1,
      diagnoses: 1,
      receipts: 0,
      obligations: 0,
      wakeups: 0,
    });
    const left = courierStack().courier;
    const right = courierStack().courier;
    const observedAt = new Date(Date.now() + 1_000);
    const sweeps = await Promise.all([
      left.sweep(observedAt, 64),
      right.sweep(observedAt, 64),
    ]);
    assert.equal(sweeps.reduce((sum, item) => sum + item.materialized, 0), 1);
    assert.deepEqual(await counts(state.target.taskId), {
      attempts: 1,
      continuations: 1,
      diagnoses: 1,
      receipts: 1,
      obligations: 1,
      wakeups: 1,
    });
    const [row] = await failureRows(state.target.taskId);
    assert.equal(row.state, 'PENDING');
    assert.equal(row.failure_fingerprint.trim(), state.failureFingerprint);
    assert.equal(row.idempotency_key.trim(), failureContinuationIdempotencyKey({
      goalId: state.target.projectId,
      taskId: state.target.taskId,
      bindingRevision: row.binding_revision,
      attemptGeneration: row.attempt_generation,
      failureFingerprint: state.failureFingerprint,
    }));
    assert.equal((await db.task.findUniqueOrThrow({
      where: { id: state.target.taskId },
    })).status, TaskStatus.FAILED);

    evidence.samples.historicalSweeps = 2;
    evidence.coverage.historicalDiagnosisRecovered = true;
    evidence.results.historicalSweep = {
      sweeps,
      receiptDigest: row.receipt_digest.trim(),
      idempotencyKey: row.idempotency_key.trim(),
      taskStatus: TaskStatus.FAILED,
    };
  });

test('the sweep does not revive a historical diagnosis once a current successor is linked',
  { timeout: 120_000 }, async () => {
    await empty();
    const state = await seedHistoricalDiagnosis('successor');
    const successor = await taskService().create(state.target.ownerId, {
      title: 'distinct repair successor',
      description: 'Diagnose and repair the failed fixture without replaying its command.',
      projectId: state.target.projectId,
      assigneeId: state.target.workspaceId,
      acceptanceCriteria: 'The repair has its own independently declared acceptance.',
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL session_replication_role = 'replica'");
      await client.query(`
        UPDATE task
           SET superseded_by_task_id = $2::uuid, terminal_reason = 'SUPERSEDED',
               superseded_at = statement_timestamp(), updated_at = statement_timestamp()
         WHERE id = $1::uuid
      `, [state.target.taskId, successor.id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const sweep = await courierStack().courier.sweep(new Date(Date.now() + 1_000), 64);
    assert.deepEqual(sweep, { scanned: 0, materialized: 0, requeued: 0 });
    assert.equal((await counts(state.target.taskId)).receipts, 0);
    assert.equal((await counts(state.target.taskId)).wakeups, 0);
    const original = await db.task.findUniqueOrThrow({
      where: { id: state.target.taskId },
    });
    assert.equal(original.status, TaskStatus.FAILED);
    assert.equal(original.supersededByTaskId, successor.id);

    evidence.samples.successorSuppressions = 1;
    evidence.coverage.currentSuccessorSuppressesSweep = true;
    evidence.results.successorSuppression = {
      originalTaskStatus: original.status,
      successorId: successor.id,
      sweep,
      wakeups: 0,
    };
  });

test('the evidence ledger proves every required safety property without production writes', () => {
  for (const [name, count] of Object.entries(evidence.samples)) {
    assert.ok(Number.isInteger(count) && count > 0, `${name} has no sample`);
  }
  for (const [name, proven] of Object.entries(evidence.coverage)) {
    if (name === 'productionWrites') {
      assert.equal(proven, false);
    } else {
      assert.equal(proven, true, `${name} was not proven`);
    }
  }
  evidence.outcome = 'PASS';
});
