/**
 * N8's explicit legacy import and bounded request backfill against real PostgreSQL.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable guarded database with
 * migration 0184 applied.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import {
  completionDigest,
  normalizeCompletionEvidence,
  TaskCompletionEvidenceService,
} from './task-completion-evidence.service';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

test('N8 schema migration cannot scan comments, synthesize evidence/requests, or update task status', () => {
  const sql = readFileSync(join(
    process.cwd(), 'prisma', 'migrations', '0184_task_signoff_backfill', 'migration.sql',
  ), 'utf8');
  const statements = sql.replace(/^--.*$/gm, '').replace(/COMMENT ON[\s\S]*?;/g, '');
  assert.doesNotMatch(statements, /\bUPDATE\s+"task"\b/i);
  assert.doesNotMatch(statements, /\bFROM\s+"task_comment"\b/i);
  assert.doesNotMatch(statements, /\bINSERT\s+INTO\s+"task_completion_evidence"\b/i);
  assert.doesNotMatch(statements, /\bINSERT\s+INTO\s+"task_judgment_request"\b/i);
  assert.match(sql, /IN_APP_ONLY[\s\S]*POLICY_IN_APP_ONLY/);
  assert.match(sql, /task_legacy_evidence_import_immutable/);
});

async function empty(sql: Client): Promise<void> {
  await verifyCoordinatorPgIdentity(sql);
  await sql.query(`
    TRUNCATE "task", "project_runtime", "project", "session", "workspace", "runner", "user"
    RESTART IDENTITY CASCADE
  `);
}

async function account(db: PrismaClient, label: string) {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `n8-${label}-${ownerId}@invalid.test`, name: 'N8', passwordHash: 'x' },
  });
  await db.runner.create({
    data: { id: runnerId, ownerId, name: `n8-${label}`, tokenHash: 'x', status: RunnerStatus.ONLINE },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `n8-${label}`, enabled: true },
  });
  return { ownerId, runnerId, workspaceId };
}

async function task(db: PrismaClient, ownerId: string, title: string, status: TaskStatus) {
  return db.task.create({
    data: {
      id: randomUUID(),
      ownerId,
      title,
      creatorType: CreatorType.USER,
      creatorId: ownerId,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      status,
    },
  });
}

async function seedEvidence(
  db: PrismaClient,
  ownerId: string,
  taskId: string,
  revision = 1n,
) {
  const fact = normalizeCompletionEvidence({ revision: revision.toString(), exitCode: 0 });
  const evidenceDigest = completionDigest(fact);
  return db.taskCompletionEvidence.create({
    data: {
      id: randomUUID(),
      taskId,
      ownerId,
      actorType: CreatorType.USER,
      actorId: ownerId,
      sourceSessionId: randomUUID(),
      criterionRevision: 'a'.repeat(64),
      criterion: { schemaVersion: 1, completionCriterion: 'EVIDENCE_JUDGMENT' },
      evidence: fact as object,
      evidenceDigest,
      revision,
    },
  });
}

suite('N8 import and backfill are explicit, idempotent and notification-bounded',
  { timeout: 180_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const sql = new Client({ connectionString: URL });
    await sql.connect();
    const db = prismaClientFor(URL!);
    t.after(async () => {
      await db.$disconnect();
      await sql.end();
    });

    await t.test('one reviewed comment produces one audited revision and no implicit parser exists', async () => {
      await empty(sql);
      const f = await account(db, 'legacy');
      const subject = await task(db, f.ownerId, 'legacy completion report', TaskStatus.OPEN);
      const sessionId = randomUUID();
      await db.session.create({
        data: {
          id: sessionId,
          ownerId: f.ownerId,
          creatorId: f.ownerId,
          taskId: subject.id,
          workspaceId: f.workspaceId,
          assignedRunnerId: f.runnerId,
          title: 'historical run',
          prompt: 'do the old work',
          provider: 'codex',
          status: RunStatus.AWAITING_INPUT,
          dispatchOrigin: SessionDispatchOrigin.USER,
          startsTaskWork: true,
        },
      });
      const body = 'DONE was written in prose.\nRaw command: npm test\nExit code: 0\n';
      const comment = await db.taskComment.create({
        data: {
          taskId: subject.id,
          authorType: CreatorType.AGENT,
          authorId: f.workspaceId,
          body,
        },
      });
      await db.taskComment.create({
        data: {
          taskId: subject.id,
          authorType: CreatorType.AGENT,
          authorId: f.workspaceId,
          body: 'This second ordinary comment must remain ordinary prose.',
        },
      });
      assert.equal(await db.taskCompletionEvidence.count(), 0);
      assert.equal(await db.taskJudgmentRequest.count(), 0);

      const service = new TaskCompletionEvidenceService(db as unknown as PrismaService);
      const reviewed = { commands: [{ command: 'npm test', exitCode: 0 }], reviewerFound: 'raw-output' };
      const input = {
        sourceCommentId: comment.id,
        sourceSessionId: sessionId,
        evidence: reviewed,
        idempotencyKey: 'legacy-comment-reviewed-v1',
        reviewNote: 'I read this exact comment and transcribed only its explicit command result.',
        devicePush: false,
      };
      const imported = await service.importLegacyComment(
        f.ownerId,
        subject.id,
        { type: CreatorType.USER, id: f.ownerId },
        input,
      );
      assert.equal(imported.actorType, CreatorType.USER);
      assert.equal(imported.actorId, f.ownerId);
      assert.equal(imported.sourceSessionId, sessionId);
      assert.equal(imported.legacyImport?.sourceCommentId, comment.id);
      assert.equal(imported.legacyImport?.sourceAuthorType, CreatorType.AGENT);
      assert.equal(imported.legacyImport?.sourceAuthorId, f.workspaceId);
      assert.equal(imported.legacyImport?.sourceDigest,
        createHash('sha256').update(body, 'utf8').digest('hex'));
      assert.equal(imported.legacyImport?.structuredEvidenceDigest,
        completionDigest(normalizeCompletionEvidence(reviewed)));
      assert.equal(imported.legacyImport?.importedById, f.ownerId);
      assert.ok(imported.legacyImport?.importedAt instanceof Date);
      assert.equal(imported.legacyImport?.devicePolicy, 'IN_APP_ONLY');
      assert.equal(imported.judgmentRequest!.origin, 'LEGACY_IMPORT');
      assert.equal(imported.judgmentRequest!.devicePolicy, 'IN_APP_ONLY');
      assert.equal(imported.judgmentRequest!.recipientId, f.ownerId);
      const delivery = await db.taskJudgmentPushDelivery.findFirstOrThrow({
        where: { requestId: imported.judgmentRequest!.id },
      });
      assert.equal(delivery.status, 'CANCELLED');
      assert.equal(delivery.attempts, 0);
      assert.equal(delivery.errorCode, 'POLICY_IN_APP_ONLY');
      assert.equal(await db.taskJudgmentInboxItem.count({
        where: { requestId: imported.judgmentRequest!.id, recipientId: f.ownerId },
      }), 1);
      assert.equal((await db.task.findUniqueOrThrow({ where: { id: subject.id } })).status,
        TaskStatus.OPEN, 'import and request filing never derive completion');

      const replay = await service.importLegacyComment(
        f.ownerId,
        subject.id,
        { type: CreatorType.USER, id: f.ownerId },
        input,
      );
      assert.equal(replay.id, imported.id);
      assert.equal(replay.judgmentRequest!.id, imported.judgmentRequest!.id);
      assert.equal(await db.taskCompletionEvidence.count({ where: { taskId: subject.id } }), 1);
      assert.equal(await db.taskLegacyEvidenceImport.count({ where: { taskId: subject.id } }), 1);
      assert.equal(await db.taskJudgmentRequest.count({ where: { taskId: subject.id } }), 1);
      await assert.rejects(service.importLegacyComment(
        f.ownerId,
        subject.id,
        { type: CreatorType.USER, id: f.ownerId },
        { ...input, evidence: { invented: true } },
      ), /already bound to a different import/);
      await assert.rejects(db.taskLegacyEvidenceImport.update({
        where: { id: imported.legacyImport!.id },
        data: { reviewNote: 'rewrite history' },
      }), /TASK_LEGACY_EVIDENCE_IMPORT_IMMUTABLE/);
    });

    await t.test('bounded backfill selects only unfinished latest evidence and suppresses bulk push', async () => {
      await empty(sql);
      const f = await account(db, 'backfill');
      const open = await task(db, f.ownerId, 'open with current evidence', TaskStatus.OPEN);
      const running = await task(db, f.ownerId, 'running with current evidence', TaskStatus.IN_PROGRESS);
      const failed = await task(db, f.ownerId, 'failed but explicitly recoverable', TaskStatus.FAILED);
      const noEvidence = await task(db, f.ownerId, 'ordinary open task', TaskStatus.OPEN);
      const done = await task(db, f.ownerId, 'already done', TaskStatus.DONE);
      const cancelled = await task(db, f.ownerId, 'already cancelled', TaskStatus.CANCELLED);
      const alreadyRequested = await task(db, f.ownerId, 'already has its request', TaskStatus.OPEN);

      await seedEvidence(db, f.ownerId, open.id, 1n);
      const currentOpenEvidence = await seedEvidence(db, f.ownerId, open.id, 2n);
      await seedEvidence(db, f.ownerId, running.id);
      await seedEvidence(db, f.ownerId, failed.id);
      await seedEvidence(db, f.ownerId, done.id);
      await seedEvidence(db, f.ownerId, cancelled.id);
      const existingEvidence = await seedEvidence(db, f.ownerId, alreadyRequested.id);
      await db.taskJudgmentRequest.create({
        data: {
          id: randomUUID(),
          taskId: alreadyRequested.id,
          ownerId: f.ownerId,
          evidenceId: existingEvidence.id,
          criterionRevision: existingEvidence.criterionRevision,
          evidenceDigest: existingEvidence.evidenceDigest,
          kind: 'EVIDENCE_JUDGMENT',
          recipientType: 'ACCOUNT_OWNER',
          recipientId: f.ownerId,
        },
      });

      const before = await db.task.findMany({
        where: { ownerId: f.ownerId },
        orderBy: { id: 'asc' },
        select: { id: true, status: true },
      });
      const doneBefore = before.filter((row) => row.status === TaskStatus.DONE).length;
      const service = new TaskCompletionEvidenceService(db as unknown as PrismaService);
      const result = await service.backfill(
        f.ownerId,
        { type: CreatorType.USER, id: f.ownerId },
        {
          idempotencyKey: 'n8-backfill-batch-0001',
          batchSize: 10,
          pushTaskIds: [open.id],
        },
      );
      assert.equal(result.batchSize, 10);
      assert.equal(result.scannedCount, 3);
      assert.equal(result.requestCount, 3);
      assert.equal(result.inboxCount, 3);
      assert.equal(result.pushSelectedCount, 1);
      assert.equal(result.pushSuppressedCount, 2);
      assert.ok(BigInt(result.durationMs) >= 0n);
      assert.deepEqual(result.pushTaskIds, [open.id]);

      const requests = await db.taskJudgmentRequest.findMany({
        where: { backfillBatchId: result.id },
        orderBy: { taskId: 'asc' },
      });
      assert.deepEqual(new Set(requests.map((row) => row.taskId)),
        new Set([open.id, running.id, failed.id]));
      assert.ok(requests.every((row) => row.origin === 'BACKFILL' && row.status === 'OPEN'));
      assert.equal(requests.find((row) => row.taskId === open.id)?.evidenceId,
        currentOpenEvidence.id, 'only the latest evidence revision is current');
      assert.equal(requests.find((row) => row.taskId === open.id)?.devicePolicy, 'IMMEDIATE');
      assert.ok(requests.filter((row) => row.taskId !== open.id)
        .every((row) => row.devicePolicy === 'IN_APP_ONLY'));
      assert.equal(await db.taskJudgmentRequest.count({ where: { taskId: noEvidence.id } }), 0);
      assert.equal(await db.taskJudgmentRequest.count({ where: { taskId: done.id } }), 0);
      assert.equal(await db.taskJudgmentRequest.count({ where: { taskId: cancelled.id } }), 0);
      assert.equal(await db.taskJudgmentRequest.count({ where: { taskId: alreadyRequested.id } }), 1);

      const selected = await db.taskJudgmentPushDelivery.findMany({
        where: { requestId: { in: requests.map((row) => row.id) } },
        orderBy: { requestId: 'asc' },
      });
      assert.equal(selected.length, 3);
      assert.equal(selected.filter((row) => row.status === 'PENDING').length, 1);
      assert.equal(selected.filter((row) => row.status === 'CANCELLED'
        && row.errorCode === 'POLICY_IN_APP_ONLY' && row.attempts === 0).length, 2);

      const replay = await service.backfill(
        f.ownerId,
        { type: CreatorType.USER, id: f.ownerId },
        {
          idempotencyKey: 'n8-backfill-batch-0001',
          batchSize: 10,
          pushTaskIds: [open.id],
        },
      );
      assert.equal(replay.id, result.id);
      assert.equal(await db.taskJudgmentRequest.count({ where: { backfillBatchId: result.id } }), 3);

      const cleanRerun = await service.backfill(
        f.ownerId,
        { type: CreatorType.USER, id: f.ownerId },
        { idempotencyKey: 'n8-backfill-batch-0002', batchSize: 10 },
      );
      assert.equal(cleanRerun.scannedCount, 0);
      assert.equal(cleanRerun.requestCount, 0);
      assert.equal(cleanRerun.inboxCount, 0);
      assert.equal(cleanRerun.pushSelectedCount, 0);
      assert.equal(cleanRerun.pushSuppressedCount, 0);

      const after = await db.task.findMany({
        where: { ownerId: f.ownerId },
        orderBy: { id: 'asc' },
        select: { id: true, status: true },
      });
      assert.deepEqual(after, before, 'request backfill writes no task lifecycle field');
      assert.equal(after.filter((row) => row.status === TaskStatus.DONE).length, doneBefore);
    });
  });
