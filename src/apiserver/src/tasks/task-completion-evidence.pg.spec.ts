/**
 * N10's first-class evidence fact against real PostgreSQL.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable guarded database with
 * migration 0178 applied.
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
    TRUNCATE "task", "session", "workspace", "runner", "user"
    RESTART IDENTITY CASCADE
  `);
}

async function fixture(db: PrismaClient) {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
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
  await db.task.create({
    data: {
      id: taskId,
      ownerId,
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
  return { ownerId, workspaceId, taskId, sessionId };
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

  const session = await db.session.findUniqueOrThrow({ where: { id: f.sessionId } });
  const task = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
  assert.equal(session.status, RunStatus.AWAITING_INPUT);
  assert.equal(task.status, TaskStatus.IN_PROGRESS);

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
