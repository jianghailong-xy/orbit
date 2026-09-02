/**
 * N10's first-class evidence fact against real PostgreSQL.
 *
 * The judgment request each revision used to raise — and the signal, blocker, decision and repair
 * door built on it — were removed on 2026-09-02. What is asserted here is what survived and had
 * to: the ledger is append-only, versioned, idempotent, immutable and its own thing, and it
 * derives no Task status for anybody.
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
  assert.equal(await db.taskCompletionEvidence.count({ where: { taskId: f.taskId } }), 1);
  assert.equal(await db.taskCompletionEvidenceIdempotency.count({ where: { taskId: f.taskId } }), 1);

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
  const audit = await service.list(f.ownerId, f.taskId);
  assert.deepEqual(audit.map((row) => row.revision), ['1', '2']);
  assert.equal(audit[0].id, replay.id);

  // Neither lifecycle moved, and no request/signal/blocker was raised in their place: since
  // 2026-09-02 the ledger's whole job is to record what a run produced.
  const session = await db.session.findUniqueOrThrow({ where: { id: f.sessionId } });
  const task = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
  assert.equal(session.status, RunStatus.AWAITING_INPUT);
  assert.equal(task.status, TaskStatus.IN_PROGRESS);
  assert.equal(
    await db.projectBlocker.count({ where: { projectId: f.projectId, resolvedAt: null } }),
    0,
  );

  // A revision after the task is already DONE is still retained. It has nothing to supersede.
  await db.task.update({ where: { id: f.taskId }, data: { status: TaskStatus.CANCELLED } });
  const afterTerminal = await service.submit(f.ownerId, f.taskId, actor, {
    sourceSessionId: f.sessionId,
    idempotencyKey: 'turn-3-after-terminal',
    evidence: { ...firstPayload, artifactSha256: 'b'.repeat(64), note: 'useful afterwards' },
  });
  assert.equal(afterTerminal.revision, '3');
  assert.equal(await db.taskCompletionEvidence.count({ where: { taskId: f.taskId } }), 3);
  const terminalAudit = await service.list(f.ownerId, f.taskId);
  assert.deepEqual(terminalAudit.map((row) => row.revision), ['1', '2', '3']);
  assert.deepEqual(terminalAudit[2].evidence, afterTerminal.evidence);

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

suite('verifier evidence is recorded for its own verdict and files no second check',
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
    assert.equal(submitted.taskId, verifierId);
    assert.equal(await db.task.count({ where: { verifiesTaskId: verifierId } }), 0,
      'submitting evidence for a verifier must not create a verifier-of-verifier carrier');

    const submitReplay = await service.submit(
      f.ownerId, verifierId, verifierActor, verifierEvidence,
    );
    assert.equal(submitReplay.id, submitted.id);

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
    assert.equal(imported.legacyImport?.sourceCommentId, comment.id);

    const importReplay = await service.importLegacyComment(
      f.ownerId,
      verifierId,
      { type: CreatorType.USER, id: f.ownerId },
      legacyInput,
    );
    assert.equal(importReplay.id, imported.id);

    const audit = await service.list(f.ownerId, verifierId);
    assert.equal(audit.length, 2);
    assert.deepEqual(audit.map((row) => row.taskId), [verifierId, verifierId]);
    assert.equal(await db.task.count({ where: { verifiesTaskId: verifierId } }), 0);
  });
