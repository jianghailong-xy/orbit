/**
 * A cancelled project's tasks do not start — asserted against real PostgreSQL.
 *
 * The rule is one clause (`projectNotCancelledSql`) spliced into every automatic candidate scan and
 * into the manual-runnable predicate, plus the run door's own check. A unit test can see the clause
 * in the SQL; only PostgreSQL can say the scans still select what they selected before and nothing
 * of a cancelled project, so this runs the REAL sweeps and the REAL doors over one world holding two
 * projects that differ in one column — `status` — and holds each assertion against its twin.
 *
 * The run door opens a receipt before any of its own gates, so a task a sweep offered leaves a
 * receipt whether or not it started: "never offered" is asserted on receipts, not on sessions.
 *
 * Destructive: it seeds rows, so it runs only against a disposable server.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { ConflictException } from '@nestjs/common';
import {
  CreatorType,
  PrismaClient,
  ProjectStatus,
  RunnerStatus,
  TaskStatus,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { establishProjectContractForPgTest } from '../projects/project-contract-test-helper';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { completeHumanTaskForPgTest } from './task-completion-test-helper';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
/** Emails are unique and this database can outlive one run. */
const RUN = randomUUID().slice(0, 8);

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
}

/** The tasks one project holds: one of each shape a door exists for. */
interface ProjectTasks {
  projectId: string;
  /** AUTO_RUN_READY_SQL's: opted in, one satisfied prerequisite. */
  edge: string;
  /** PROJECT_INDEPENDENT_READY_SQL's: opted in, no edges, in a coordinated project. */
  independent: string;
  /** SCHEDULED_DUE_SQL's: not opted in, due by the clock. */
  scheduled: string;
  /** A person's Run: not opted in, nothing due. */
  manual: string;
  /** Bulk Run's. */
  bulk: string;
}

function connect() {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const publishes = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    publishes,
  );
  return { db, tasks: new TasksService(prisma, sessions, publishes) };
}

async function world(db: PrismaClient): Promise<World> {
  const ids = { ownerId: randomUUID(), runnerId: randomUUID(), workspaceId: randomUUID() };
  await db.user.create({
    data: {
      id: ids.ownerId,
      email: `cancelled-${RUN}-${ids.ownerId}@project-cancelled.invalid`,
      name: 'owner',
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: ids.runnerId,
      ownerId: ids.ownerId,
      name: 'runner',
      tokenHash: `hash-${ids.runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
      // Room for every start this world makes, so "not started" can only mean the gate.
      maxConcurrent: 32,
    },
  });
  await db.workspace.create({
    data: {
      id: ids.workspaceId,
      ownerId: ids.ownerId,
      runnerId: ids.runnerId,
      name: 'agent',
      enabled: true,
    },
  });
  return ids;
}

async function seedTask(
  db: PrismaClient,
  ids: World,
  projectId: string,
  title: string,
  opts: { autoRun?: boolean; runAt?: Date } = {},
): Promise<string> {
  const id = randomUUID();
  await db.task.create({
    data: {
      id,
      ownerId: ids.ownerId,
      projectId,
      assigneeId: ids.workspaceId,
      title: `${title}-${RUN}`,
      creatorType: CreatorType.USER,
      creatorId: ids.ownerId,
      provider: 'claude',
      completionCriterion: 'EVIDENCE_JUDGMENT',
      status: TaskStatus.OPEN,
      autoRunWhenReady: opts.autoRun ?? false,
      runAt: opts.runAt ?? null,
    },
    select: { id: true },
  });
  return id;
}

/** A coordinated project, OPEN, holding one task of every shape. */
async function seedProject(db: PrismaClient, ids: World, label: string): Promise<ProjectTasks> {
  const projectId = randomUUID();
  await db.project.create({
    data: {
      id: projectId,
      ownerId: ids.ownerId,
      title: `${label}-${RUN}`,
      coordinatorEnabled: true,
      maxConcurrentTasks: 8,
    },
  });
  await establishProjectContractForPgTest(db, ids.ownerId, projectId, `${label}-${RUN}`);

  const prerequisite = await seedTask(db, ids, projectId, `${label}-prerequisite`);
  await completeHumanTaskForPgTest(db, ids.ownerId, prerequisite, `${label}-prerequisite`);
  const edge = await seedTask(db, ids, projectId, `${label}-edge`, { autoRun: true });
  await db.taskDependency.create({ data: { taskId: edge, dependsOnTaskId: prerequisite } });

  return {
    projectId,
    edge,
    independent: await seedTask(db, ids, projectId, `${label}-independent`, { autoRun: true }),
    scheduled: await seedTask(db, ids, projectId, `${label}-scheduled`, {
      runAt: new Date(Date.now() - 60_000),
    }),
    manual: await seedTask(db, ids, projectId, `${label}-manual`),
    bulk: await seedTask(db, ids, projectId, `${label}-bulk`),
  };
}

/** Whether a door was OFFERED the task — a receipt exists even for a refusal. */
const offered = (db: PrismaClient, ownerId: string, taskId: string) =>
  db.taskRunRequest.count({ where: { ownerId, fingerprint: `task:${taskId}` } });
const runs = (db: PrismaClient, taskId: string) => db.session.count({ where: { taskId } });

/** The three automatic passes, called exactly as the timer calls them. */
async function sweep(tasks: TasksService): Promise<void> {
  const timer = tasks as unknown as {
    reconcileReadyTasks(): Promise<void>;
    dispatchDueScheduledTasks(): Promise<void>;
  };
  await timer.reconcileReadyTasks();
  await timer.dispatchDueScheduledTasks();
}

test('a cancelled project starts nothing, by any door, and reopening it lifts that', { skip, timeout: 300_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const s = connect();
  try {
    const ids = await world(s.db);
    const cancelled = await seedProject(s.db, ids, 'cancelled');
    const open = await seedProject(s.db, ids, 'open');
    // The one column the two worlds differ in, written the way `PATCH /projects/:id` writes it.
    await s.db.project.update({
      where: { id: cancelled.projectId },
      data: { status: ProjectStatus.CANCELLED },
    });

    // ── Ready: what the page offers is what the door accepts ────────────────────────────────
    const ready = async (projectId: string) =>
      (await s.tasks.listPage(ids.ownerId, { projectId, status: 'RUNNABLE', limit: 50 }))
        .items.map((item) => item.id);
    assert.ok(!(await ready(cancelled.projectId)).includes(cancelled.manual),
      'the Ready tab offers a task of a cancelled project');
    assert.ok((await ready(open.projectId)).includes(open.manual),
      'CONTROL: the open project\'s identical task is not Ready, so the fixture shows nothing');

    // ── The automatic doors ─────────────────────────────────────────────────────────────────
    await sweep(s.tasks);
    for (const [label, taskId] of [
      ['a task with a satisfied prerequisite', cancelled.edge],
      ['an independent task of a coordinated project', cancelled.independent],
      ['a task whose schedule came due', cancelled.scheduled],
    ] as const) {
      assert.equal(await offered(s.db, ids.ownerId, taskId), 0,
        `a sweep offered ${label} of a cancelled project to the run door`);
      assert.equal(await runs(s.db, taskId), 0, `${label} of a cancelled project started`);
    }
    assert.ok(
      (await s.db.task.findUniqueOrThrow({ where: { id: cancelled.scheduled } })).runAt,
      'the schedule was spent on a start that did not happen',
    );
    for (const [label, taskId] of [
      ['a task with a satisfied prerequisite', open.edge],
      ['an independent task of a coordinated project', open.independent],
      ['a task whose schedule came due', open.scheduled],
    ] as const) {
      assert.equal(await runs(s.db, taskId), 1,
        `CONTROL: ${label} of the open project did not start, so the fixture cannot show the gate`);
    }

    // ── A person's Run ──────────────────────────────────────────────────────────────────────
    await assert.rejects(
      () => s.tasks.execute(ids.ownerId, cancelled.manual, undefined, `press-${RUN}`),
      (error: unknown) => {
        assert.ok(error instanceof ConflictException);
        assert.equal((error.getResponse() as { code: string }).code, 'PROJECT_CANCELLED');
        return true;
      },
    );
    assert.equal(await runs(s.db, cancelled.manual), 0);
    await s.tasks.execute(ids.ownerId, open.manual, undefined, `press-open-${RUN}`);
    assert.equal(await runs(s.db, open.manual), 1, 'CONTROL: the open project\'s Run did not start');

    // ── Bulk Run ────────────────────────────────────────────────────────────────────────────
    const bulk = await s.tasks.batchExecute(ids.ownerId, [cancelled.bulk, open.bulk], 2);
    assert.deepEqual(
      bulk.skipped.map((item) => [item.id, item.reason]),
      [[cancelled.bulk, 'Project cancelled']],
    );
    assert.equal(await runs(s.db, cancelled.bulk), 0);
    assert.equal(await runs(s.db, open.bulk), 1, 'CONTROL: bulk Run started nothing at all');

    // ── Reopened: every door starts it again ────────────────────────────────────────────────
    await s.db.project.update({
      where: { id: cancelled.projectId },
      data: { status: ProjectStatus.OPEN },
    });
    await sweep(s.tasks);
    for (const taskId of [cancelled.edge, cancelled.independent, cancelled.scheduled]) {
      assert.equal(await runs(s.db, taskId), 1, 'a reopened project\'s task was not started by its sweep');
    }
    // The same press, asked again: a refusal is not frozen.
    await s.tasks.execute(ids.ownerId, cancelled.manual, undefined, `press-${RUN}`);
    assert.equal(await runs(s.db, cancelled.manual), 1);
  } finally {
    await s.db.$disconnect();
  }
});
