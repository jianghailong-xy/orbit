import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  CreatorType,
  PrismaClient,
  ProjectAutomationPolicy,
  RunnerStatus,
  TaskStatus,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from './tasks.service';

/**
 * T1 — whether a task runs by itself does not depend on whether a Coordinator exists.
 *
 * Migration 0122's `task_dispatch_authority_derive` stamps every task in a `coordinator_enabled`
 * Project with `dispatch_authority = 'COORDINATOR'` at birth, and the auto-run sweep used to
 * require LEGACY. That was a handover while the Coordinator had a dispatch pass of its own; once
 * that pass was removed with the control loop it became a handover to nobody, and every task in
 * every coordinated Project sat OPEN for ever — `auto_run_when_ready`, an assignee on a live
 * runner, prerequisites all DONE, and no starter that would look at it.
 *
 * Asserted against a real PostgreSQL because the fact that wedges these tasks is written by a
 * TRIGGER: a fake would have to be told the authority, which is exactly the thing under test. So
 * the Project is created coordinated, the derived column is read back off the row to prove the
 * trigger fired, and then the sweep is asked to do its job.
 *
 * Destructive: it seeds rows, so it runs only against a disposable server.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
/** Emails are unique and this database can outlive one run. */
const RUN = randomUUID().slice(0, 8);

interface Services {
  db: PrismaClient;
  tasks: TasksService;
}

interface World {
  ownerId: string;
  runnerId: string;
  agentId: string;
}

function connect(): Services {
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

/** An owner with one online runner and one workspace bound to it. */
async function world(db: PrismaClient, label: string): Promise<World> {
  const ids = { ownerId: randomUUID(), runnerId: randomUUID(), agentId: randomUUID() };
  await db.user.create({
    data: {
      id: ids.ownerId, email: `${label}-${RUN}-${ids.ownerId}@t1.invalid`, name: label,
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: ids.runnerId, ownerId: ids.ownerId, name: `${label}-runner`,
      tokenHash: `hash-${ids.runnerId}`, status: RunnerStatus.ONLINE, capabilities: [],
      capabilitiesReportedAt: new Date(),
      // Room for every task one sweep is meant to start. `max_concurrent` defaults to 1, and the
      // materialisation budget spends it: on the default the sweep starts the first candidate and
      // leaves the rest for a later pass, which would make a control group look like a regression.
      maxConcurrent: 4,
    },
  });
  await db.workspace.create({
    data: {
      id: ids.agentId, ownerId: ids.ownerId, runnerId: ids.runnerId, name: `${label}-agent`,
      enabled: true,
    },
  });
  return ids;
}

/**
 * A Project, a DONE prerequisite and one OPEN task that depends on it — the shape the auto-run
 * sweep exists for: it HAS a prerequisite, and that prerequisite is finished.
 */
async function releasedTask(
  db: PrismaClient,
  ids: World,
  label: string,
  opts: { coordinatorEnabled: boolean; autoRunWhenReady?: boolean },
): Promise<string> {
  const projectId = randomUUID();
  const doneId = randomUUID();
  const taskId = randomUUID();
  await db.project.create({
    data: {
      id: projectId, ownerId: ids.ownerId, title: label,
      coordinatorEnabled: opts.coordinatorEnabled,
      automationPolicy: ProjectAutomationPolicy.AUTO,
    },
  });
  const task = (id: string, title: string, extra: Record<string, unknown>) => ({
    id, ownerId: ids.ownerId, projectId, assigneeId: ids.agentId, title,
    creatorType: CreatorType.USER, creatorId: ids.ownerId, provider: 'claude', ...extra,
  });
  await db.task.create({ data: task(doneId, `${label} prerequisite`, { status: TaskStatus.DONE }) });
  await db.task.create({
    data: task(taskId, `${label} task`, {
      status: TaskStatus.OPEN, autoRunWhenReady: opts.autoRunWhenReady ?? true,
    }),
  });
  await db.taskDependency.create({ data: { taskId, dependsOnTaskId: doneId } });
  return taskId;
}

/** The derived column, straight off the row — what 0122's trigger actually wrote. */
async function authorityOf(db: PrismaClient, taskId: string): Promise<string> {
  const [row] = await db.$queryRaw<Array<{ authority: string }>>`
    SELECT "dispatch_authority"::text AS "authority" FROM "task" WHERE "id" = ${taskId}::uuid`;
  assert.ok(row, `task ${taskId} is missing`);
  return row.authority;
}

const sessionCount = (db: PrismaClient, taskId: string) =>
  db.session.count({ where: { taskId } });

const sweep = (s: Services) =>
  (s.tasks as unknown as { reconcileReadyTasks(): Promise<void> }).reconcileReadyTasks();

test('the auto-run sweep dispatches a coordinated Project\'s released task',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    try {
      const ids = await world(s.db, 't1-coordinated');
      const coordinated = await releasedTask(s.db, ids, 't1-coordinated', {
        coordinatorEnabled: true,
      });
      // The control group this sweep has always served, in the same pass: a Project with no
      // coordinator. Both must start, because the difference between them is no longer a
      // difference the dispatcher can see.
      const legacy = await releasedTask(s.db, ids, 't1-legacy', { coordinatorEnabled: false });
      // ...and the opt-out, which is the task's OWN column and still decides. Without this the
      // test above would also pass for a sweep that simply started everything.
      const optedOut = await releasedTask(s.db, ids, 't1-opted-out', {
        coordinatorEnabled: true, autoRunWhenReady: false,
      });

      // THE FACT THAT USED TO WEDGE IT, read rather than assumed: if the trigger ever stops
      // stamping this the test below would pass without covering anything.
      assert.equal(await authorityOf(s.db, coordinated), 'COORDINATOR');
      assert.equal(await authorityOf(s.db, legacy), 'LEGACY');

      await sweep(s);

      assert.equal(await sessionCount(s.db, coordinated), 1,
        'a coordinated Project\'s task was never started — nothing else would have started it');
      assert.equal(await sessionCount(s.db, legacy), 1,
        'the legacy group this sweep already served must be unaffected');
      assert.equal(await sessionCount(s.db, optedOut), 0,
        'auto_run_when_ready is the task\'s own opt-in and still decides');
    } finally {
      await s.db.$disconnect();
    }
  });

test('the scheduled sweep dispatches a coordinated Project\'s due task',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    try {
      const ids = await world(s.db, 't1-due');
      // A schedule is a different trigger with rules of its own (SCHEDULED_DUE_SQL): it does not
      // require prerequisites, only that none is outstanding. It carried the same authority
      // filter, so it wedged the same way.
      const projectId = randomUUID();
      const taskId = randomUUID();
      await s.db.project.create({
        data: {
          id: projectId, ownerId: ids.ownerId, title: 't1-due', coordinatorEnabled: true,
          automationPolicy: ProjectAutomationPolicy.AUTO,
        },
      });
      await s.db.task.create({
        data: {
          id: taskId, ownerId: ids.ownerId, projectId, assigneeId: ids.agentId, title: 't1-due task',
          creatorType: CreatorType.USER, creatorId: ids.ownerId, provider: 'claude',
          status: TaskStatus.OPEN, runAt: new Date(Date.now() - 60 * 60_000),
        },
      });
      assert.equal(await authorityOf(s.db, taskId), 'COORDINATOR');

      await (s.tasks as unknown as { dispatchDueScheduledTasks(): Promise<void> })
        .dispatchDueScheduledTasks();

      assert.equal(await sessionCount(s.db, taskId), 1,
        'a due appointment in a coordinated Project never came round');
    } finally {
      await s.db.$disconnect();
    }
  });
