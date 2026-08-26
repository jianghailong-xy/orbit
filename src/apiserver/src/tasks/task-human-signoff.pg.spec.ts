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
import { ForbiddenException } from '@nestjs/common';
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

test('migration requires signer, timestamp and non-blank evidence on every signoff event', () => {
  const sql = readFileSync(join(
    process.cwd(), 'prisma', 'migrations', '0180_task_human_signoff', 'migration.sql',
  ), 'utf8');
  assert.match(sql, /"signed_by_id" uuid NOT NULL/);
  assert.match(sql, /"signed_at" TIMESTAMP\(3\) NOT NULL/);
  assert.match(sql, /"evidence" text NOT NULL/);
  assert.match(sql, /CHECK \(length\(btrim\("evidence"\)\) > 0\)/);
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

    const service = tasksService(db);
    await assert.rejects(
      service.signoff(ownerId, taskId, 'an agent cannot sign', randomUUID()),
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
               AND s."signed_by_id" IS NOT NULL
               AND s."signed_at" IS NOT NULL
               AND length(btrim(s."evidence")) > 0
          ) THEN
            RAISE EXCEPTION 'N2_ATOMIC_ASSERT: signoff evidence absent at DONE transition';
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

    const evidence = 'Reviewed commit 0123456789abcdef and `npm test`; exit 0, 2670 tests.';
    const result = await service.signoff(ownerId, taskId, evidence);

    assert.equal(result.status, TaskStatus.DONE);
    assert.equal(result.transitioned, true);
    assert.equal(result.blockersResolved, 1);
    assert.equal(result.signoff.taskId, taskId);
    assert.equal(result.signoff.signedById, ownerId, 'who signed is durable and non-empty');
    assert.ok(result.signoff.signedAt instanceof Date, 'when they signed is durable and non-empty');
    assert.equal(result.signoff.evidence, evidence, 'what evidence they used is durable and non-empty');

    const [storedTask, storedSignoff, storedBlocker] = await Promise.all([
      db.task.findUniqueOrThrow({ where: { id: taskId } }),
      db.taskHumanSignoff.findUniqueOrThrow({ where: { taskId } }),
      db.projectBlocker.findUniqueOrThrow({ where: { id: blocker.id } }),
    ]);
    assert.equal(storedTask.status, TaskStatus.DONE);
    assert.equal(storedSignoff.signedById, ownerId);
    assert.ok(storedSignoff.signedAt);
    assert.ok(storedSignoff.evidence.trim().length > 0);
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

    // A transport retry returns the original event; it does not rewrite who/when/evidence.
    const replay = await service.signoff(ownerId, taskId, 'different retry payload');
    assert.equal(replay.signoff.id, storedSignoff.id);
    assert.equal(replay.signoff.evidence, evidence);
    assert.equal(await db.taskHumanSignoff.count({ where: { taskId } }), 1);
  });
