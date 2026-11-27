import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { test } from 'node:test';

import {
  Prisma,
  PrismaClient,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { PushService } from '../push/push.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { applyIntegrationJobResult, dispatchIntegrationJobs } from '../runner-api/integration-job-relay';
import { SessionsService } from '../sessions/sessions.service';
import { TaskOwnerConfirmationService } from '../tasks/task-owner-confirmation.service';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { runLandingObservationBackfill } from './landing-observation-backfill';
import { runLandingRegressionRepair } from './landing-regression-repair';
import { ProjectOpenItemEscalationService } from './open-item-escalation.service';
import { canonicalRepoUrl } from './project-integration-line';
import { ProjectOpenItemService } from './project-open-item.service';

/**
 * Nothing settled before the deploy changes hands (revision 42 part one, the project's rule for the
 * migration task): an OPEN integration item, a DONE task with a frozen delivered identity and its work
 * session ended `task_done` — all three as a database holds them before migration 1501 — are untouched
 * by applying 1501 and by the first boot after it.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/landing-fix-boot-untouched.pg.spec.ts
 *
 * THE SHAPE. The rows are made by the product (the owner's Confirm writes DONE and freezes the identity,
 * the runner claims the landing, its CONFLICT opens the item for the coordinator, delivered). The item is
 * opened while the work session counts as ended by a person, so the hand-off of W4 does not apply; the
 * session is then marked `task_done`, the end that WOULD qualify it, which is the case a backfill would
 * be tempted to pick up. The database is then put back to its pre-1501 shape — the four columns dropped,
 * 0513's retry-class check restored — and the rows are read. Then 1501's own migration.sql is applied, as
 * `prisma migrate deploy` applies it, and the boot passes that read open items or delivered identity
 * run: the landing-observation backfill and the landing-regression repair
 * (`LandingObservationBackfillAtBoot`), the escalation tick's backstop and sweep
 * (`ProjectOpenItemEscalationService`), and the coordinator delivery backstop (`deliverOwed`). The three
 * rows must read the same, field for field, the item's four new columns NULL; the item is still delivered
 * to the coordinator once and still carries its escalation time.
 *
 * A file of its own because it drops and re-adds columns: no other case may share its database.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const CAPABILITIES = ['integration-job/v1', 'integration-observe/v1'];
const sha = (nibble: string) => nibble.repeat(40);
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const MIGRATION = path.resolve(__dirname, '../../prisma/migrations/1501_open_item_work_session/migration.sql');
const WORK_SESSION_COLUMNS = [
  'work_session_id', 'work_session_offered_at', 'work_session_returned_at', 'work_session_return_reason',
];

/** The database as it stood before 1501: the four columns gone, the retry-class check as 0513 left it. */
const PRE_1501 = `
  ALTER TABLE "project_open_item"
    DROP CONSTRAINT "project_open_item_work_session_chk",
    DROP CONSTRAINT "project_open_item_work_session_return_chk",
    DROP CONSTRAINT "project_open_item_work_session_return_reason_chk",
    DROP COLUMN "work_session_id",
    DROP COLUMN "work_session_offered_at",
    DROP COLUMN "work_session_returned_at",
    DROP COLUMN "work_session_return_reason";
  ALTER TABLE "project_integration_job"
    DROP CONSTRAINT "project_integration_job_retry_failure_class_chk",
    ADD CONSTRAINT "project_integration_job_retry_failure_class_chk" CHECK (
      "retry_failure_class" IS NULL
      OR "retry_failure_class" IN ('CHECK_FAILED', 'CHECK_TIMED_OUT', 'ERROR', 'BASELINE_RED'));`;

test('a pre-existing OPEN integration item, DONE task and task_done session are untouched by 1501 and the first boot after it',
  { skip, timeout: 180_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
    await sql.connect();
    await verifyCoordinatorPgIdentity(sql);
    const db: PrismaClient = prismaClientFor(URL!);
    const prisma = db as unknown as PrismaService;
    try {
      const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
      const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
      const sessions = new SessionsService(prisma, queue, realtime);
      const push = new Proxy({}, { get: () => () => Promise.resolve() }) as unknown as PushService;
      const openItems = new ProjectOpenItemService(prisma, sessions, push);
      const tasks = new TasksService(prisma, sessions, realtime, undefined, undefined, undefined, openItems);
      const confirmations = new TaskOwnerConfirmationService(prisma, sessions, tasks, realtime);
      const escalation = new ProjectOpenItemEscalationService(prisma, push);

      // ── The world, made by the product ──────────────────────────────────────────────────────────
      const ownerId = randomUUID();
      const runnerId = randomUUID();
      const workspaceId = randomUUID();
      const projectId = randomUUID();
      const coordinatorSessionId = randomUUID();
      const repoUrl = `https://git.invalid/orbit/boot-${projectId.slice(0, 8)}.git`;
      await db.user.create({ data: { id: ownerId, email: `boot-${ownerId}@landing-fix.invalid`, name: 'boot', passwordHash: 'x' } });
      await db.runner.create({
        data: {
          id: runnerId, ownerId, name: 'boot-runner', tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
          capabilities: CAPABILITIES, maxConcurrent: 4, capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
          heartbeatLeaseOwner: randomUUID(),
        },
      });
      await db.workspace.create({
        data: { id: workspaceId, ownerId, runnerId, name: 'boot-workspace', enabled: true, repoUrl, workDir: '/srv/boot' },
      });
      await db.session.create({
        data: {
          id: coordinatorSessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId,
          title: 'coordinator: boot', prompt: 'coordinator: boot', provider: 'claude', turnState: null,
          dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: false, titleManagedByProject: true, numTurns: 1,
          startedAt: new Date(), runtimeSessionId: `runtime-${coordinatorSessionId}`,
        },
      });
      await db.project.create({
        data: {
          id: projectId, ownerId, title: 'boot project', goal: 'nothing settled before the deploy changes hands',
          coordinatorEnabled: true, coordinatorWorkspaceId: workspaceId, coordinatorSessionId,
        },
      });
      await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
      await db.projectCodebase.create({
        data: {
          ownerId, projectId, canonicalRepoUrl: canonicalRepoUrl(repoUrl)!, upstreamRef: 'refs/heads/main',
          integrationRef: `refs/heads/project/${projectId}`, refAuthority: 'REMOTE', remoteName: 'origin',
          integrationRefSource: 'EXPLICIT', deliveryMode: 'PLATFORM', integrationStartedAt: new Date(),
        },
      });
      const { id: taskId } = await db.task.create({
        data: {
          ownerId, creatorType: 'USER', creatorId: ownerId, title: 'boot task', projectId, assigneeId: workspaceId,
          status: TaskStatus.IN_PROGRESS, completionCriterion: 'OWNER_CONFIRMED',
        },
        select: { id: true },
      });
      const sessionId = randomUUID();
      await db.session.create({
        data: {
          id: sessionId, ownerId, creatorId: ownerId, taskId, workspaceId, assignedRunnerId: runnerId,
          title: 'work boot', prompt: 'work', provider: 'claude', turnState: null,
          dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true, isolationStatus: 'worktree',
          branch: 'orbit/boot', branchSha: sha('a'), baseSha: sha('b'), numTurns: 1, startedAt: minutesAgo(30),
          createdAt: minutesAgo(30), runtimeSessionId: randomUUID(),
          changedFiles: [{ path: 'src/a.ts', status: 'M', additions: 1, deletions: 0 }] as Prisma.InputJsonValue,
          // Ended by a person when the result comes in, so W4 does not hand the failure off.
          finishedAt: minutesAgo(2), endReason: 'ended',
        },
      });
      const receipt = await confirmations.decide(ownerId, taskId, { door: 'USER', userId: ownerId }, { decision: 'CONFIRM' } as never);
      assert.equal(receipt.completed, true, 'CONTROL: the confirmation wrote DONE');
      const handed = await dispatchIntegrationJobs(prisma, { runnerId, leaseOwner: randomUUID(), draining: false, capabilities: CAPABILITIES });
      const command = handed.find((candidate) => candidate.kind === 'LAND_TASK');
      assert.ok(command, 'CONTROL: the runner was handed the landing');
      const applied = await applyIntegrationJobResult(prisma, {
        jobId: command.jobId, runnerId, ownerId,
        body: {
          claimGeneration: command.claimGeneration, leaseOwner: command.leaseOwner,
          state: 'CONFLICT', phase: 'MERGE', sourceSha: sha('a'), targetShaBefore: sha('c'), upstreamSha: sha('9'),
          conflicts: ['src/a.ts'],
        } as never,
      });
      if (applied.after) await openItems.deliverForItems(applied.after.openItemIds);
      // The session's end as a DONE writes it: the end W4 would revive.
      await db.session.update({ where: { id: sessionId }, data: { endReason: 'task_done' } });

      // ── Back to the database before 1501, and read it ─────────────────────────────────────────────
      await sql.query(PRE_1501);
      const rows = async () => {
        const item = await sql.query(
          `SELECT to_jsonb(i) AS row FROM "project_open_item" i WHERE i."integration_job_id" = $1::uuid`, [command.jobId]);
        assert.equal(item.rowCount, 1, 'CONTROL: the conflict opened one item');
        const task = await sql.query(`SELECT to_jsonb(t) AS row FROM "task" t WHERE t."id" = $1::uuid`, [taskId]);
        const session = await sql.query(`SELECT to_jsonb(s) AS row FROM "session" s WHERE s."id" = $1::uuid`, [sessionId]);
        const deliveries = await sql.query(
          `SELECT count(*)::int AS n FROM "project_open_item_delivery" d
            WHERE d."item_id" = ($1::jsonb->>'id')::uuid AND d."purpose" = 'ITEM' AND d."returned_at" IS NULL
              AND d."session_id" = $2::uuid`, [JSON.stringify(item.rows[0].row), coordinatorSessionId]);
        return {
          item: item.rows[0].row as Record<string, unknown>,
          task: task.rows[0].row as Record<string, unknown>,
          session: session.rows[0].row as Record<string, unknown>,
          deliveries: deliveries.rows[0].n as number,
        };
      };
      const before = await rows();
      assert.equal(before.item.state, 'OPEN', 'CONTROL: the item is open');
      assert.equal(before.item.assignee, 'COORDINATOR', 'CONTROL: the item is the coordinator\'s');
      assert.ok(before.item.escalate_at, 'CONTROL: the item escalates');
      assert.equal(before.deliveries, 1, 'CONTROL: the item was delivered to the coordinator');
      assert.equal(before.task.status, 'DONE', 'CONTROL: the task is DONE');
      assert.ok(before.task.delivered_sha && before.task.delivered_at, 'CONTROL: the task\'s identity is frozen');
      assert.equal(before.session.end_reason, 'task_done', 'CONTROL: the work session ended task_done');
      for (const column of WORK_SESSION_COLUMNS) {
        assert.equal(column in before.item, false, `CONTROL: ${column} does not exist before 1501`);
      }

      // ── 1501, then the first boot ────────────────────────────────────────────────────────────────
      await sql.query(readFileSync(MIGRATION, 'utf8'));
      const backfill = await runLandingObservationBackfill(prisma, { databaseUrl: URL!, log: console });
      const unknown = backfill.projects.flatMap((project) => project.left
        .filter((left) => left.settlement === 'IDENTITY_UNKNOWN').map((left) => left.taskId));
      if (unknown.length > 0) await openItems.deliverForTasks(unknown);
      await runLandingRegressionRepair(prisma, { log: console });
      await escalation.reconcile();
      await escalation.sweep();
      await openItems.deliverOwed(projectId);

      const after = await rows();
      for (const column of WORK_SESSION_COLUMNS) {
        assert.ok(column in after.item, `${column} exists after 1501`);
        assert.equal(after.item[column], null, `${column} was written on an item that was open at deploy`);
      }
      const withoutNew = Object.fromEntries(Object.entries(after.item).filter(([key]) => !WORK_SESSION_COLUMNS.includes(key)));
      assert.deepEqual(withoutNew, before.item, 'the item open at deploy changed');
      assert.deepEqual(after.task, before.task, 'the DONE task changed');
      assert.deepEqual(after.session, before.session, 'the task_done session changed');
      assert.equal(after.deliveries, 1, 'the item is no longer delivered to the coordinator once');
      assert.equal(after.item.escalate_at, before.item.escalate_at, 'the item no longer escalates as it did');
    } finally {
      await db.$disconnect().catch(() => undefined);
      await sql.end().catch(() => undefined);
    }
  });

test('the boot-untouched PostgreSQL target is explicitly disposable', { skip }, () => {
  assert.doesNotThrow(() => assertCoordinatorPgUrlIsIsolated(URL));
});
