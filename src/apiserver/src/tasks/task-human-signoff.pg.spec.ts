/**
 * N2's HUMAN_SIGNOFF boundary against real PostgreSQL.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable database accepted by the
 * coordinator PG safety guard, with migration 0180 applied.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { PrismaClient, TaskStatus } from '@prisma/client';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;
const ATOMIC_TRIGGER = 'n2_human_signoff_atomic_assert';
const ATOMIC_FUNCTION = 'n2_human_signoff_atomic_assert_fn';

function tasksService(db: PrismaClient): TasksService {
  return new TasksService(
    db as unknown as PrismaService,
    { create: () => { throw new Error('this fixture never dispatches'); } } as never,
    {
      publishForUser: () => undefined,
      publishTaskChanged: () => undefined,
    } as unknown as RealtimeService,
  );
}

test('migration pins every signoff event to an open evidence-bound request', () => {
  const n2 = readFileSync(join(
    process.cwd(), 'prisma', 'migrations', '0180_task_human_signoff', 'migration.sql',
  ), 'utf8');
  const n11 = readFileSync(join(
    process.cwd(), 'prisma', 'migrations', '0181_task_judgment_request', 'migration.sql',
  ), 'utf8');
  assert.match(n2, /"signed_by_id" uuid NOT NULL/);
  assert.match(n2, /"signed_at" TIMESTAMP\(3\) NOT NULL/);
  assert.match(n2, /"evidence" text NOT NULL/);
  assert.match(n2, /CHECK \(length\(btrim\("evidence"\)\) > 0\)/);
  assert.match(n11, /ADD COLUMN "request_id" uuid/);
  assert.match(n11, /ALTER COLUMN "request_id" SET NOT NULL/);
  assert.match(n11, /ADD COLUMN "evidence_digest" char\(64\)/);
  assert.match(n11, /ALTER COLUMN "evidence_digest" SET NOT NULL/);
  assert.match(n11, /task_human_signoff_current_request_guard/);
  assert.match(n11, /task_judgment_request_transition_guard/);
  assert.match(n11, /CREATE VIEW "task_judgment_signal"/);
  assert.match(n11, /CREATE VIEW "project_judgment_blocker"/);
});

suite('human signoff atomically derives DONE and removes the open human-decision view',
  { timeout: 180_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const sql = new Client({ connectionString: URL });
    await sql.connect();
    const db = prismaClientFor(URL!);
    t.after(async () => {
      await sql.query(`DROP TRIGGER IF EXISTS "${ATOMIC_TRIGGER}" ON "task"`);
      await sql.query(`DROP FUNCTION IF EXISTS "${ATOMIC_FUNCTION}"()`);
      await db.$disconnect();
      await sql.end();
    });
    await verifyCoordinatorPgIdentity(sql);
    await sql.query(`
      DROP TRIGGER IF EXISTS "${ATOMIC_TRIGGER}" ON "task";
      DROP FUNCTION IF EXISTS "${ATOMIC_FUNCTION}"();
      TRUNCATE "task", "project_runtime", "project", "user" RESTART IDENTITY CASCADE
    `);

    const ownerId = randomUUID();
    const projectId = randomUUID();
    const taskId = randomUUID();
    const dependentId = randomUUID();
    const oldEvidenceId = randomUUID();
    const oldRequestId = randomUUID();
    const evidenceId = randomUUID();
    const requestId = randomUUID();
    const sourceSessionId = randomUUID();
    const criterionRevision = 'b'.repeat(64);
    const oldEvidenceDigest = 'c'.repeat(64);
    const evidenceDigest = 'd'.repeat(64);
    const now = new Date();
    await db.user.create({
      data: { id: ownerId, email: `${ownerId}@n2.invalid`, name: 'N2 signer', passwordHash: 'x' },
    });
    await db.project.create({ data: { id: projectId, ownerId, title: 'N2 atomic signoff' } });
    await db.projectRuntime.upsert({
      where: { projectId },
      create: { projectId },
      update: {},
    });
    await db.task.create({
      data: {
        id: taskId,
        ownerId,
        projectId,
        title: 'Needs a human judgment',
        creatorType: 'USER',
        creatorId: ownerId,
        completionCriterion: 'HUMAN_SIGNOFF',
        status: TaskStatus.OPEN,
      },
    });
    await db.task.create({
      data: {
        id: dependentId,
        ownerId,
        projectId,
        title: 'Released only by the derived completion',
        creatorType: 'USER',
        creatorId: ownerId,
        status: TaskStatus.OPEN,
      },
    });
    await db.taskDependency.create({ data: { taskId: dependentId, dependsOnTaskId: taskId } });
    const oldCreatedAt = new Date(now.getTime() - 1_000);
    await db.taskCompletionEvidence.create({
      data: {
        id: oldEvidenceId,
        taskId,
        ownerId,
        actorType: 'USER',
        actorId: ownerId,
        sourceSessionId,
        criterionRevision,
        criterion: { completionCriterion: 'HUMAN_SIGNOFF' },
        evidence: { revision: 'old' },
        evidenceDigest: oldEvidenceDigest,
        revision: 1n,
        submittedAt: oldCreatedAt,
      },
    });
    await db.taskJudgmentRequest.create({
      data: {
        id: oldRequestId,
        taskId,
        ownerId,
        evidenceId: oldEvidenceId,
        criterionRevision,
        evidenceDigest: oldEvidenceDigest,
        kind: 'HUMAN_SIGNOFF',
        recipientType: 'ACCOUNT_OWNER',
        recipientId: ownerId,
        createdAt: oldCreatedAt,
      },
    });
    await db.taskCompletionEvidence.create({
      data: {
        id: evidenceId,
        taskId,
        ownerId,
        actorType: 'USER',
        actorId: ownerId,
        sourceSessionId,
        criterionRevision,
        criterion: { completionCriterion: 'HUMAN_SIGNOFF' },
        evidence: { revision: 'current', command: 'npm test', exitCode: 0 },
        evidenceDigest,
        revision: 2n,
        submittedAt: now,
      },
    });
    await db.taskJudgmentRequest.create({
      data: {
        id: requestId,
        taskId,
        ownerId,
        evidenceId,
        criterionRevision,
        evidenceDigest,
        kind: 'HUMAN_SIGNOFF',
        recipientType: 'ACCOUNT_OWNER',
        recipientId: ownerId,
        createdAt: now,
      },
    });
    await db.taskJudgmentRequest.update({
      where: { id: oldRequestId },
      data: {
        status: 'SUPERSEDED',
        supersededAt: now,
        supersededById: requestId,
      },
    });
    const blocker = await db.projectBlocker.create({
      data: {
        projectId,
        kind: 'HUMAN_DECISION_REQUIRED',
        owner: 'USER',
        recovery: 'HUMAN',
        severity: 'CRITICAL',
        requiredAction: 'A person must inspect the evidence and sign off this task.',
        nextCheckAt: now,
        subjectType: 'TASK',
        subjectId: taskId,
        detail: { source: 'ATTEMPT_ENDED_UNSETTLED' },
        dedupeKey: `HUMAN_DECISION_REQUIRED:TASK_NO_JUDGMENT:${taskId}`,
        lifecycleGeneration: 1n,
        conditionVersion: 'a'.repeat(64),
        firstSeenAt: now,
        lastSeenAt: now,
      },
    });
    await db.taskComment.create({
      data: {
        taskId,
        authorType: 'USER',
        authorId: ownerId,
        body: '<!-- orbit:ATTEMPT_ENDED_WITHOUT_JUDGMENT_PATH -->\nNeeds human decision',
      },
    });

    // Negative control: before the signature the criterion is unsatisfied and its signal is open.
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status, TaskStatus.OPEN);
    assert.equal(await db.taskHumanSignoff.count({ where: { taskId } }), 0);
    assert.equal(await db.projectBlocker.count({
      where: { id: blocker.id, resolvedAt: null },
    }), 1);
    assert.equal(await db.taskJudgmentRequest.count({ where: { taskId, status: 'OPEN' } }), 1);
    assert.equal((await sql.query(
      `SELECT count(*)::int AS n FROM "task_judgment_signal" WHERE "task_id" = $1::uuid`,
      [taskId],
    )).rows[0].n, 1);
    assert.equal((await sql.query(
      `SELECT count(*)::int AS n FROM "project_judgment_blocker" WHERE "task_id" = $1::uuid`,
      [taskId],
    )).rows[0].n, 1);

    const service = tasksService(db);
    const signoff = {
      requestId,
      evidenceDigest,
      evidence: 'Reviewed commit 0123456789abcdef and `npm test`; exit 0, 2670 tests.',
    };
    await assert.rejects(
      service.signoff(ownerId, taskId, signoff, randomUUID()),
      (error: unknown) => {
        assert.ok(error instanceof ForbiddenException);
        const body = error.getResponse() as Record<string, unknown>;
        assert.equal(body.code, 'HUMAN_SIGNOFF_REQUIRES_USER');
        assert.equal(body.criterion, 'HUMAN_SIGNOFF');
        return true;
      },
    );
    assert.equal(await db.taskHumanSignoff.count({ where: { taskId } }), 0);
    assert.equal(await db.projectBlocker.count({ where: { id: blocker.id, resolvedAt: null } }), 1);
    assert.equal(await db.taskJudgmentRequest.count({ where: { id: requestId, status: 'OPEN' } }), 1,
      'authorization refusal does not consume the request fact');

    await assert.rejects(
      service.signoff(ownerId, taskId, {
        requestId: oldRequestId,
        evidenceDigest: oldEvidenceDigest,
        evidence: 'trying to sign stale evidence',
      }),
      (error: unknown) => {
        assert.ok(error instanceof ConflictException);
        assert.equal((error.getResponse() as Record<string, unknown>).code,
          'HUMAN_SIGNOFF_REQUEST_SUPERSEDED');
        return true;
      },
    );
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status, TaskStatus.OPEN);

    // This BEFORE UPDATE trigger runs at the exact status transition, inside the production
    // transaction. It makes the spec fail if either the event INSERT or blocker resolution is
    // moved to an after-commit cleanup while a later read still happens to see the final state.
    await sql.query(`
      CREATE FUNCTION "${ATOMIC_FUNCTION}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."id" = '${taskId}'::uuid
           AND OLD."status" IS DISTINCT FROM 'DONE'::task_status
           AND NEW."status" = 'DONE'::task_status THEN
          IF NOT EXISTS (
            SELECT 1 FROM "task_human_signoff" s
             WHERE s."task_id" = NEW."id"
               AND s."request_id" = '${requestId}'::uuid
               AND s."evidence_digest" = '${evidenceDigest}'
               AND s."signed_by_id" IS NOT NULL
               AND s."signed_at" IS NOT NULL
               AND length(btrim(s."evidence")) > 0
          ) THEN
            RAISE EXCEPTION 'N2_ATOMIC_ASSERT: signoff evidence absent at DONE transition';
          END IF;
          IF EXISTS (
            SELECT 1 FROM "task_judgment_request" r
             WHERE r."id" = '${requestId}'::uuid
               AND (r."status" <> 'DECIDED' OR r."decision" <> 'PASS'
                 OR r."decided_at" IS NULL OR r."decided_by_type" <> 'USER'
                 OR r."decided_by_id" <> '${ownerId}')
          ) OR NOT EXISTS (
            SELECT 1 FROM "task_judgment_request" r WHERE r."id" = '${requestId}'::uuid
          ) THEN
            RAISE EXCEPTION 'N11_ATOMIC_ASSERT: request decision absent at DONE transition';
          END IF;
          IF EXISTS (
            SELECT 1 FROM "task_judgment_signal" signal WHERE signal."task_id" = NEW."id"
          ) OR EXISTS (
            SELECT 1 FROM "project_judgment_blocker" blocker WHERE blocker."task_id" = NEW."id"
          ) THEN
            RAISE EXCEPTION 'N11_ATOMIC_ASSERT: derived request view still open at DONE transition';
          END IF;
          IF EXISTS (
            SELECT 1 FROM "project_blocker" b
             WHERE b."project_id" = NEW."project_id"
               AND b."kind" = 'HUMAN_DECISION_REQUIRED'
               AND b."subject_type" = 'TASK'
               AND b."subject_id" = NEW."id"::text
               AND b."resolved_at" IS NULL
          ) THEN
            RAISE EXCEPTION 'N2_ATOMIC_ASSERT: blocker still open at DONE transition';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER "${ATOMIC_TRIGGER}"
        BEFORE UPDATE OF "status" ON "task"
        FOR EACH ROW EXECUTE FUNCTION "${ATOMIC_FUNCTION}"()
    `);

    // Two authorised handlers race on the same fact. The owner/task/request locks make the loser
    // observe the committed event and replay it instead of creating another open request/event.
    const [first, second] = await Promise.all([
      service.signoff(ownerId, taskId, signoff),
      service.signoff(ownerId, taskId, { ...signoff, evidence: 'concurrent duplicate review' }),
    ]);
    const results = [first, second];
    const result = results.find((candidate) => candidate.transitioned)!;

    assert.equal(result.status, TaskStatus.DONE);
    assert.equal(result.transitioned, true);
    assert.equal(results.filter((candidate) => candidate.transitioned).length, 1);
    assert.equal(result.blockersResolved, 1);
    assert.equal(result.signoff.taskId, taskId);
    assert.equal(result.signoff.signedById, ownerId, 'who signed is durable and non-empty');
    assert.ok(result.signoff.signedAt instanceof Date, 'when they signed is durable and non-empty');
    assert.equal(second.signoff.id, result.signoff.id);
    assert.ok([signoff.evidence, 'concurrent duplicate review'].includes(result.signoff.evidence));
    assert.equal(result.signoff.requestId, requestId);
    assert.equal(result.signoff.evidenceDigest, evidenceDigest);

    const [storedTask, storedSignoff, storedBlocker, storedRequest] = await Promise.all([
      db.task.findUniqueOrThrow({ where: { id: taskId } }),
      db.taskHumanSignoff.findUniqueOrThrow({ where: { taskId } }),
      db.projectBlocker.findUniqueOrThrow({ where: { id: blocker.id } }),
      db.taskJudgmentRequest.findUniqueOrThrow({ where: { id: requestId } }),
    ]);
    assert.equal(storedTask.status, TaskStatus.DONE);
    assert.equal(storedSignoff.signedById, ownerId);
    assert.ok(storedSignoff.signedAt);
    assert.ok(storedSignoff.evidence.trim().length > 0);
    assert.equal(storedSignoff.requestId, requestId);
    assert.equal(storedSignoff.evidenceDigest, evidenceDigest);
    assert.equal(storedRequest.status, 'DECIDED');
    assert.equal(storedRequest.decision, 'PASS');
    assert.equal(storedRequest.decidedByType, 'USER');
    assert.equal(storedRequest.decidedById, ownerId);
    assert.ok(storedRequest.decidedAt);
    assert.ok(storedBlocker.resolvedAt);
    assert.equal(storedBlocker.resolvedBy, 'AUTO');
    assert.equal(await db.projectBlocker.count({
      where: {
        projectId,
        kind: 'HUMAN_DECISION_REQUIRED',
        subjectType: 'TASK',
        subjectId: taskId,
        resolvedAt: null,
      },
    }), 0, 'the unsatisfied-criterion view no longer exists as an open blocker');
    assert.equal((await sql.query(
      `SELECT count(*)::int AS n FROM "task_judgment_signal" WHERE "task_id" = $1::uuid`,
      [taskId],
    )).rows[0].n, 0);
    assert.equal((await sql.query(
      `SELECT count(*)::int AS n FROM "project_judgment_blocker" WHERE "task_id" = $1::uuid`,
      [taskId],
    )).rows[0].n, 0);
    assert.equal((await service.get(ownerId, dependentId) as { dependencyState: string }).dependencyState,
      'READY', 'the derived DONE releases the dependent');

    // A transport retry returns the original event; it does not rewrite who/when/evidence.
    const replay = await service.signoff(ownerId, taskId, {
      ...signoff,
      evidence: 'different retry payload',
    });
    assert.equal(replay.signoff.id, storedSignoff.id);
    assert.equal(replay.signoff.evidence, storedSignoff.evidence);
    assert.equal(await db.taskHumanSignoff.count({ where: { taskId } }), 1);
  });
