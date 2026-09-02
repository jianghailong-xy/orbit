/**
 * N10's first-class evidence fact against real PostgreSQL.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable guarded database with
 * current migrations applied.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  CreatorType,
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { TaskCompletionEvidenceService } from './task-completion-evidence.service';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

async function empty(client: Client): Promise<void> {
  await verifyCoordinatorPgIdentity(client);
  await client.query(`
    TRUNCATE "task", "session", "project", "workspace", "runner", "user"
    RESTART IDENTITY CASCADE
  `);
}

async function fixture(db: PrismaClient) {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const sessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `n10-${ownerId}@invalid.test`, name: 'N10', passwordHash: 'x' },
  });
  await db.runner.create({
    data: { id: runnerId, ownerId, name: 'n10-runner', tokenHash: 'x', status: RunnerStatus.ONLINE },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: 'n10-workspace', enabled: true },
  });
  await db.project.create({
    data: { id: projectId, ownerId, title: 'N24 terminal evidence request' },
  });
  await db.task.create({
    data: {
      id: taskId,
      ownerId,
      projectId,
      title: 'explicit evidence',
      creatorType: CreatorType.USER,
      creatorId: ownerId,
      assigneeId: workspaceId,
      status: TaskStatus.IN_PROGRESS,
      acceptanceCriteria: 'command exits zero and output names the artifact',
    },
  });
  await db.session.create({
    data: {
      id: sessionId,
      ownerId,
      creatorId: ownerId,
      taskId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: 'awaiting but resumable',
      prompt: 'run the task',
      provider: 'codex',
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
    },
  });
  return { ownerId, workspaceId, projectId, taskId, sessionId };
}

suite('AWAITING_INPUT submits versioned evidence without changing either lifecycle', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  const db = prismaClientFor(URL!);
  t.after(async () => {
    await db.$disconnect();
    await sql.end();
  });
  await empty(sql);
  const f = await fixture(db);
  const service = new TaskCompletionEvidenceService(db as unknown as PrismaService);
  const actor = { type: CreatorType.AGENT, id: f.workspaceId };
  const firstPayload = {
    commands: [{ command: 'npm test', rawOutput: 'caf\u00e9\r\n', exitCode: 0 }],
    criteria: { second: true, first: true },
  };

  const concurrent = await Promise.all(Array.from({ length: 6 }, () => service.submit(
    f.ownerId,
    f.taskId,
    actor,
    { sourceSessionId: f.sessionId, evidence: firstPayload, idempotencyKey: 'turn-1-complete' },
  )));
  assert.equal(new Set(concurrent.map((row) => row.id)).size, 1);
  assert.equal(new Set(concurrent.map((row) => row.revision)).size, 1);
  assert.equal(new Set(concurrent.map((row) => row.judgmentRequest!.id)).size, 1);
  assert.equal(concurrent[0].judgmentRequest!.status, 'OPEN');
  assert.equal(concurrent[0].judgmentRequest!.kind, 'EVIDENCE_JUDGMENT');
  assert.equal(concurrent[0].judgmentRequest!.recipientType, 'ACCOUNT_OWNER');
  assert.equal(concurrent[0].judgmentRequest!.recipientId, f.ownerId);
  assert.deepEqual(concurrent[0].consumption, {
    kind: 'JUDGMENT_REQUEST',
    judgmentRequestId: concurrent[0].judgmentRequest!.id,
    requestKind: 'EVIDENCE_JUDGMENT',
  });
  assert.equal(await db.taskCompletionEvidence.count({ where: { taskId: f.taskId } }), 1);
  assert.equal(await db.taskCompletionEvidenceIdempotency.count({ where: { taskId: f.taskId } }), 1);
  assert.equal(await db.taskJudgmentRequest.count({
    where: { taskId: f.taskId, status: 'OPEN' },
  }), 1, 'concurrent/replayed evidence has one open request');

  const replay = await service.submit(f.ownerId, f.taskId, actor, {
    sourceSessionId: f.sessionId,
    idempotencyKey: 'turn-1-equivalent',
    evidence: {
      criteria: { first: true, second: true },
      commands: [{ exitCode: 0, rawOutput: 'cafe\u0301\n', command: 'npm test' }],
    },
  });
  assert.equal(replay.id, concurrent[0].id);
  assert.equal(replay.revision, '1');
  assert.match(replay.criterionRevision, /^[0-9a-f]{64}$/);
  assert.match(replay.evidenceDigest, /^[0-9a-f]{64}$/);
  assert.equal(replay.taskId, f.taskId);
  assert.equal(replay.actorId, f.workspaceId);
  assert.equal(replay.sourceSessionId, f.sessionId);
  assert.equal(replay.sourceAttemptId, null);
  assert.ok(replay.submittedAt instanceof Date);
  assert.deepEqual(replay.idempotencyKeys, ['turn-1-complete', 'turn-1-equivalent']);
  assert.equal(replay.judgmentRequest!.id, concurrent[0].judgmentRequest!.id);

  await assert.rejects(
    service.submit(f.ownerId, f.taskId, actor, {
      sourceSessionId: f.sessionId,
      idempotencyKey: 'turn-1-complete',
      evidence: { result: 'a different fact' },
    }),
    /idempotencyKey is already bound to different completion evidence/,
  );
  assert.equal(await db.taskCompletionEvidence.count({ where: { taskId: f.taskId } }), 1);

  const beforeComment = await db.taskCompletionEvidence.count({ where: { taskId: f.taskId } });
  await db.taskComment.create({
    data: {
      taskId: f.taskId,
      authorType: CreatorType.AGENT,
      authorId: f.workspaceId,
      body: 'DONE. Commands passed. This prose is not the completion protocol.',
    },
  });
  assert.equal(await db.taskCompletionEvidence.count({ where: { taskId: f.taskId } }), beforeComment);

  const changed = await service.submit(f.ownerId, f.taskId, actor, {
    sourceSessionId: f.sessionId,
    idempotencyKey: 'turn-2-complete',
    evidence: { ...firstPayload, artifactSha256: 'a'.repeat(64) },
  });
  assert.equal(changed.revision, '2');
  assert.notEqual(changed.id, replay.id);
  assert.notEqual(changed.evidenceDigest, replay.evidenceDigest);
  assert.notEqual(changed.judgmentRequest!.id, replay.judgmentRequest!.id);
  const audit = await service.list(f.ownerId, f.taskId);
  assert.deepEqual(audit.map((row) => row.revision), ['1', '2']);
  assert.equal(audit[0].id, replay.id);
  assert.equal(audit[0].judgmentRequest!.status, 'SUPERSEDED');
  assert.equal(audit[0].judgmentRequest!.supersededById, changed.judgmentRequest!.id);
  assert.equal(audit[0].judgmentRequest!.supersessionRule, 'EVIDENCE_REVISED');
  assert.equal(audit[0].judgmentRequest!.supersededActorType, CreatorType.AGENT);
  assert.equal(audit[0].judgmentRequest!.supersededActorId, f.workspaceId);
  assert.equal(audit[0].judgmentRequest!.supersededSourceSessionId, f.sessionId);
  assert.equal(audit[1].judgmentRequest!.status, 'OPEN');
  assert.equal(await db.taskJudgmentRequest.count({
    where: { taskId: f.taskId, status: 'OPEN' },
  }), 1);
  const openSignals = await sql.query<{ id: string; evidence_digest: string }>(`
    SELECT "id", "evidence_digest" FROM "task_judgment_signal"
     WHERE "task_id" = '${f.taskId}'::uuid
  `);
  assert.deepEqual(openSignals.rows, [{
    id: changed.judgmentRequest!.id,
    evidence_digest: changed.evidenceDigest,
  }]);
  assert.equal((await sql.query<{ n: number }>(`
    SELECT count(*)::int AS n FROM "project_judgment_blocker"
     WHERE "project_id" = '${f.projectId}'::uuid AND "task_id" = '${f.taskId}'::uuid
  `)).rows[0].n, 1);

  const session = await db.session.findUniqueOrThrow({ where: { id: f.sessionId } });
  const task = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
  assert.equal(session.status, RunStatus.AWAITING_INPUT);
  assert.equal(task.status, TaskStatus.IN_PROGRESS);

  // N24: once the task's declared criterion is already satisfied, a later evidence revision is
  // still retained but neither the old nor the new request remains actionable.
  await new TasksService(
    db as unknown as PrismaService,
    {} as never,
    { publishForUser() {} } as never,
  ).judge(f.ownerId, f.taskId, {
    requestId: changed.judgmentRequest!.id,
    evidenceDigest: changed.evidenceDigest,
    evidence: 'Owner reviewed the current N24 evidence revision.',
  });
  const terminalEvidence = await service.submit(f.ownerId, f.taskId, actor, {
    sourceSessionId: f.sessionId,
    idempotencyKey: 'turn-3-after-done',
    evidence: { ...firstPayload, artifactSha256: 'b'.repeat(64), note: 'useful after DONE' },
  });
  assert.equal(terminalEvidence.revision, '3');
  assert.equal(terminalEvidence.judgmentRequest!.status, 'SUPERSEDED');
  assert.equal(terminalEvidence.judgmentRequest!.supersededById, null);
  assert.equal(terminalEvidence.judgmentRequest!.supersessionRule, 'TASK_ALREADY_DONE');
  assert.equal(terminalEvidence.judgmentRequest!.supersededActorType, CreatorType.AGENT);
  assert.equal(terminalEvidence.judgmentRequest!.supersededActorId, f.workspaceId);
  assert.equal(terminalEvidence.judgmentRequest!.supersededSourceSessionId, f.sessionId);
  assert.equal(await db.taskCompletionEvidence.count({ where: { taskId: f.taskId } }), 3);
  const terminalAudit = await service.list(f.ownerId, f.taskId);
  assert.deepEqual(terminalAudit.map((row) => row.revision), ['1', '2', '3']);
  assert.deepEqual(terminalAudit[2].evidence, terminalEvidence.evidence);
  assert.equal(terminalAudit[1].judgmentRequest!.status, 'DECIDED');
  assert.equal(terminalAudit[1].judgmentRequest!.decision, 'PASS');
  assert.equal(terminalAudit[2].judgmentRequest!.status, 'SUPERSEDED');
  assert.equal(await db.taskJudgmentRequest.count({
    where: { taskId: f.taskId, status: 'OPEN' },
  }), 0);
  assert.equal((await sql.query<{ n: number }>(`
    SELECT count(*)::int AS n FROM "task_judgment_signal" WHERE "task_id" = '${f.taskId}'::uuid
  `)).rows[0].n, 0);
  assert.equal((await sql.query<{ n: number }>(`
    SELECT count(*)::int AS n FROM "project_judgment_blocker"
     WHERE "project_id" = '${f.projectId}'::uuid AND "task_id" = '${f.taskId}'::uuid
  `)).rows[0].n, 0);

  // The explicit production-repair door is the same terminal-rule helper with a narrower target.
  // It refuses an unfinished task and records the current Session/agent when the DONE predicate
  // later makes the exact request eligible.
  await db.task.update({ where: { id: f.taskId }, data: { status: TaskStatus.IN_PROGRESS } });
  const repairCandidate = await service.submit(f.ownerId, f.taskId, actor, {
    sourceSessionId: f.sessionId,
    idempotencyKey: 'turn-4-repair-candidate',
    evidence: { ...firstPayload, artifactSha256: 'c'.repeat(64) },
  });
  assert.equal(repairCandidate.judgmentRequest!.status, 'OPEN');
  await assert.rejects(
    service.reconcileSatisfiedJudgmentRequest(f.ownerId, f.taskId, {
      requestId: repairCandidate.judgmentRequest!.id,
      sourceSessionId: f.sessionId,
    }),
    /Only a Task whose completion criterion is already satisfied at DONE may use this repair/,
  );
  assert.equal((await db.taskJudgmentRequest.findUniqueOrThrow({
    where: { id: repairCandidate.judgmentRequest!.id },
  })).status, 'OPEN');
  await db.task.update({ where: { id: f.taskId }, data: { status: TaskStatus.DONE } });
  const repaired = await service.reconcileSatisfiedJudgmentRequest(f.ownerId, f.taskId, {
    requestId: repairCandidate.judgmentRequest!.id,
    sourceSessionId: f.sessionId,
  });
  assert.equal(repaired.status, 'SUPERSEDED');
  assert.equal(repaired.supersededById, null);
  assert.equal(repaired.supersessionRule, 'TASK_ALREADY_DONE');
  assert.equal(repaired.supersededActorType, CreatorType.AGENT);
  assert.equal(repaired.supersededActorId, f.workspaceId);
  assert.equal(repaired.supersededSourceSessionId, f.sessionId);
  assert.equal(await db.taskJudgmentRequest.count({
    where: { taskId: f.taskId, status: 'OPEN' },
  }), 0);
  const repairReplay = await service.reconcileSatisfiedJudgmentRequest(f.ownerId, f.taskId, {
    requestId: repairCandidate.judgmentRequest!.id,
    sourceSessionId: f.sessionId,
  });
  assert.deepEqual(repairReplay, repaired);

  const requiredColumns = await sql.query<{ column_name: string; is_nullable: string }>(`
    SELECT column_name, is_nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'task_completion_evidence'
       AND column_name IN (
         'task_id', 'owner_id', 'actor_type', 'actor_id', 'submitted_at',
         'source_session_id', 'criterion_revision', 'criterion', 'evidence',
         'evidence_digest', 'revision'
       )
  `);
  assert.equal(requiredColumns.rows.length, 11);
  assert.ok(requiredColumns.rows.every((column) => column.is_nullable === 'NO'));
});

suite('verifier evidence is recorded for its own verdict without a check-of-check request',
  async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const sql = new Client({ connectionString: URL });
    await sql.connect();
    const db = prismaClientFor(URL!);
    t.after(async () => {
      await db.$disconnect();
      await sql.end();
    });
    await empty(sql);
    const f = await fixture(db);
    const verifierId = randomUUID();
    const verifierSessionId = randomUUID();
    await db.task.create({
      data: {
        id: verifierId,
        ownerId: f.ownerId,
        projectId: f.projectId,
        title: 'verify explicit evidence',
        creatorType: CreatorType.USER,
        creatorId: f.ownerId,
        assigneeId: f.workspaceId,
        verifiesTaskId: f.taskId,
        completionCriterion: 'VERIFICATION',
        completionPolicy: 'MANUAL',
        status: TaskStatus.IN_PROGRESS,
      },
    });
    await db.session.create({
      data: {
        id: verifierSessionId,
        ownerId: f.ownerId,
        creatorId: f.ownerId,
        taskId: verifierId,
        workspaceId: f.workspaceId,
        assignedRunnerId: (await db.runner.findFirstOrThrow({
          where: { ownerId: f.ownerId }, select: { id: true },
        })).id,
        title: 'verifier evidence source',
        prompt: 'check the subject',
        provider: 'codex',
        status: RunStatus.AWAITING_INPUT,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startsTaskWork: true,
      },
    });

    const service = new TaskCompletionEvidenceService(db as unknown as PrismaService);
    const verifierActor = { type: CreatorType.AGENT, id: f.workspaceId };
    const verifierEvidence = {
      sourceSessionId: verifierSessionId,
      idempotencyKey: 'verifier-observation',
      evidence: { checked: f.taskId, command: 'npm test', exitCode: 0 },
    };
    const submitted = await service.submit(f.ownerId, verifierId, verifierActor, verifierEvidence);
    assert.equal(submitted.judgmentRequest, null);
    assert.deepEqual(submitted.consumption, {
      kind: 'VERIFIER_VERDICT',
      verifierTaskId: verifierId,
      subjectTaskId: f.taskId,
    });
    assert.equal(await db.taskJudgmentRequest.count({ where: { taskId: verifierId } }), 0);
    assert.equal(await db.task.count({ where: { verifiesTaskId: verifierId } }), 0,
      'submitting evidence for a verifier must not create a verifier-of-verifier carrier');

    const submitReplay = await service.submit(
      f.ownerId, verifierId, verifierActor, verifierEvidence,
    );
    assert.equal(submitReplay.id, submitted.id);
    assert.equal(submitReplay.judgmentRequest, null);
    assert.deepEqual(submitReplay.consumption, submitted.consumption);

    const comment = await db.taskComment.create({
      data: {
        taskId: verifierId,
        authorType: CreatorType.AGENT,
        authorId: f.workspaceId,
        body: 'Historical verifier observation reviewed by the owner.',
      },
    });
    const legacyInput = {
      sourceCommentId: comment.id,
      sourceSessionId: verifierSessionId,
      evidence: { reviewedObservation: 'the subject tests passed' },
      idempotencyKey: 'verifier-legacy-observation',
      reviewNote: 'I reviewed and transcribed this exact verifier comment.',
      devicePush: false,
    };
    const imported = await service.importLegacyComment(
      f.ownerId,
      verifierId,
      { type: CreatorType.USER, id: f.ownerId },
      legacyInput,
    );
    assert.equal(imported.judgmentRequest, null);
    assert.deepEqual(imported.consumption, submitted.consumption);
    assert.equal(imported.legacyImport?.sourceCommentId, comment.id);

    const importReplay = await service.importLegacyComment(
      f.ownerId,
      verifierId,
      { type: CreatorType.USER, id: f.ownerId },
      legacyInput,
    );
    assert.equal(importReplay.id, imported.id);
    assert.equal(importReplay.judgmentRequest, null);
    assert.deepEqual(importReplay.consumption, submitted.consumption);
    assert.equal(await db.taskJudgmentRequest.count({ where: { taskId: verifierId } }), 0,
      'legacy verifier evidence must not create a EVIDENCE_JUDGMENT or verifier-of-verifier request');

    // Simulate a pre-0192 check-of-check request that the migration retained as terminal audit
    // history. It must be visible through listRequests, but it must never change the immutable
    // fact-time consumer returned by submit replay or evidence listing.
    const historicalRequestId = randomUUID();
    await sql.query(`ALTER TABLE "task_judgment_request"
                       DISABLE TRIGGER "task_judgment_request_verifier_role_guard"`);
    try {
      await sql.query(`
        INSERT INTO "task_judgment_request"
          ("id", "task_id", "owner_id", "evidence_id", "criterion_revision",
           "evidence_digest", "kind", "recipient_type", "recipient_id", "status",
           "superseded_at", "supersession_rule")
        VALUES ($1, $2, $3::uuid, $4, $5, $6, 'EVIDENCE_JUDGMENT', 'ACCOUNT_OWNER', $3::text,
                'SUPERSEDED', clock_timestamp(), 'VERIFIER_ROLE')
      `, [historicalRequestId, verifierId, f.ownerId, submitted.id,
        submitted.criterionRevision, submitted.evidenceDigest]);
    } finally {
      await sql.query(`ALTER TABLE "task_judgment_request"
                         ENABLE TRIGGER "task_judgment_request_verifier_role_guard"`);
    }

    const replayWithHistoricalRequest = await service.submit(
      f.ownerId, verifierId, verifierActor, verifierEvidence,
    );
    assert.equal(replayWithHistoricalRequest.judgmentRequest, null);
    assert.deepEqual(replayWithHistoricalRequest.consumption, submitted.consumption);

    const audit = await service.list(f.ownerId, verifierId);
    assert.equal(audit.length, 2);
    assert.ok(audit.every((row) => row.judgmentRequest === null));
    assert.ok(audit.every((row) => (
      row.consumption.kind === 'VERIFIER_VERDICT'
      && row.consumption.verifierTaskId === verifierId
      && row.consumption.subjectTaskId === f.taskId
    )));
    const requestAudit = await service.listRequests(f.ownerId, verifierId);
    assert.equal(requestAudit.length, 1);
    assert.equal(requestAudit[0].id, historicalRequestId);
    assert.equal(requestAudit[0].status, 'SUPERSEDED');
  });
