import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  CreatorType,
  PrismaClient,
  ProjectAutomationPolicy,
  RunnerStatus,
  TaskCompletionPolicy,
  TaskStatus,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { establishProjectContractForPgTest } from '../projects/project-contract-test-helper';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from './tasks.service';

/**
 * 0224 removed the automatic-dispatch OBLIGATION. It must not have removed automatic dispatch.
 *
 * 0205 installed five relations and two functions whose product was a typed REASON a ready task
 * had not started: `AUTO_DISPATCH_BLOCKED`, with an owner, a next action, an observation count and
 * a persistent wake instant. The reason that framework was built to carry —
 * `OWNER_RATIFICATION_REQUIRED` — went with 0218, and 0224 takes the framework itself.
 *
 * Deleting the explanation is only correct if the thing it explained still happens. That is not a
 * claim about TypeScript: the candidate predicate is SQL, the epoch it is fenced on is written by
 * a trigger, and the damping clause 0224 removed from `AUTO_RUN_READY_SQL` read two of the dropped
 * relations. So this runs the real sweep against the real migrated schema and asks for the four
 * behaviours the removal is not allowed to change, positive and negative in one pass:
 *
 *   (c) a task with `auto_run_when_ready` and every prerequisite DONE starts by itself;
 *   (d) the manual door — what `task_start` reaches — still starts one;
 *   (e) `dispatch_hold` still holds a task that is ready in every other respect;
 *   (f) an unsatisfied prerequisite still holds one.
 *
 * (e) and (f) are what make (c) mean anything: a sweep that started everything would pass (c).
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
      id: ids.ownerId, email: `${label}-${RUN}-${ids.ownerId}@0224.invalid`, name: label,
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: ids.runnerId, ownerId: ids.ownerId, name: `${label}-runner`,
      tokenHash: `hash-${ids.runnerId}`, status: RunnerStatus.ONLINE, capabilities: [],
      capabilitiesReportedAt: new Date(),
      // Room for every task one sweep is meant to start: on the default of 1 the materialisation
      // budget starts the first candidate and leaves the rest, which would read as a regression.
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

/** One task with one prerequisite — the shape the auto-run sweep exists for. */
async function dependentTask(
  db: PrismaClient,
  ids: World,
  label: string,
  opts: {
    prerequisiteStatus?: TaskStatus;
    autoRunWhenReady?: boolean;
    dispatchHold?: boolean;
  } = {},
): Promise<{ taskId: string; prerequisiteId: string; projectId: string }> {
  const projectId = randomUUID();
  const prerequisiteId = randomUUID();
  const taskId = randomUUID();
  await db.project.create({
    data: {
      id: projectId, ownerId: ids.ownerId, title: label,
      automationPolicy: ProjectAutomationPolicy.AUTO,
    },
  });
  await establishProjectContractForPgTest(db, ids.ownerId, projectId, label);
  const task = (id: string, title: string, extra: Record<string, unknown>) => ({
    id, ownerId: ids.ownerId, projectId, assigneeId: ids.agentId, title,
    creatorType: CreatorType.USER, creatorId: ids.ownerId, provider: 'claude',
    completionCriterion: 'EVIDENCE_JUDGMENT' as const, ...extra,
  });
  await db.task.create({
    data: task(prerequisiteId, `${label} prerequisite`, {
      status: opts.prerequisiteStatus ?? TaskStatus.DONE,
    }),
  });
  await db.task.create({
    data: task(taskId, `${label} task`, {
      status: TaskStatus.OPEN,
      autoRunWhenReady: opts.autoRunWhenReady ?? true,
      dispatchHold: opts.dispatchHold ?? false,
    }),
  });
  await db.taskDependency.create({ data: { taskId, dependsOnTaskId: prerequisiteId } });
  return { taskId, prerequisiteId, projectId };
}

const sessionCount = (db: PrismaClient, taskId: string) =>
  db.session.count({ where: { taskId } });

const sweep = (s: Services) =>
  (s.tasks as unknown as { reconcileReadyTasks(): Promise<void> }).reconcileReadyTasks();

/** Every relation and routine 0205 installed, by name, straight out of the catalogue. */
async function survivingAutoDispatchObjects(db: PrismaClient): Promise<string[]> {
  const relations = await db.$queryRaw<Array<{ name: string }>>`
    SELECT c.relname AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname LIKE 'task_auto_dispatch%'`;
  const routines = await db.$queryRaw<Array<{ name: string }>>`
    SELECT p.proname AS name
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE 'task_auto_dispatch%'`;
  return [...relations, ...routines].map((row) => row.name).sort();
}

test('(a) the migrated database carries no 0205 relation, index or routine',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    try {
      // `pg_class` covers tables, indexes and sequences alike, so this also settles the six
      // indexes and the identity sequence that went with the event relation.
      assert.deepEqual(await survivingAutoDispatchObjects(s.db), []);

      // A dropped table does not take a plpgsql body that reads it: PostgreSQL does not track that
      // dependency, so a surviving function would fail only when something called it. The two
      // functions that did read these relations were dropped by 0218 and 0223; this is the check
      // that no third one is left holding a reference into the void.
      const bodies = await s.db.$queryRaw<Array<{ name: string }>>`
        SELECT p.proname AS name
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prosrc LIKE '%task_auto_dispatch%'`;
      assert.deepEqual(bodies.map((row) => row.name), []);

      // Not collateral: `task_dispatch_epoch` is the fence automatic dispatch still runs on, and
      // `dispatch_attempt` is the count 0205 incremented. Both predate it and both stay.
      const kept = await s.db.$queryRaw<Array<{ name: string }>>`
        SELECT c.relname AS name
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'
           AND c.relname IN ('task_dispatch_epoch', 'task_dependency', 'task_run_request')
         ORDER BY c.relname`;
      assert.deepEqual(kept.map((row) => row.name),
        ['task_dependency', 'task_dispatch_epoch', 'task_run_request']);
    } finally {
      await s.db.$disconnect();
    }
  });

test('(c)(e)(f) the sweep still starts a released task, and still holds the two that are not',
  { skip, timeout: 180_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    try {
      const ids = await world(s.db, '0224-sweep');
      // (c) The one this removal is not allowed to break.
      const released = await dependentTask(s.db, ids, '0224-released');
      // (e) Ready in every other respect, and explicitly held.
      const held = await dependentTask(s.db, ids, '0224-held', { dispatchHold: true });
      // (f) Its prerequisite has not finished.
      const blocked = await dependentTask(s.db, ids, '0224-blocked', {
        prerequisiteStatus: TaskStatus.OPEN,
      });
      // The task's own opt-out, which is a third way to not be started.
      const optedOut = await dependentTask(s.db, ids, '0224-opted-out', {
        autoRunWhenReady: false,
      });

      await sweep(s);

      assert.equal(await sessionCount(s.db, released.taskId), 1,
        'a task whose prerequisites are DONE was not started — 0224 removed the reason, not the '
          + 'dispatch, and nothing else would have started it');
      assert.equal(await sessionCount(s.db, held.taskId), 0,
        'dispatch_hold no longer holds a ready task');
      assert.equal(await sessionCount(s.db, blocked.taskId), 0,
        'a task with an unfinished prerequisite was started');
      assert.equal(await sessionCount(s.db, optedOut.taskId), 0,
        'auto_run_when_ready is the task\'s own opt-in and still decides');

      // The attempt counter 0205 wrote through its recorder is still moved by the dispatch itself:
      // `dispatch_attempt` is a column on `task` from 0122 and is not part of what was removed.
      const [row] = await s.db.$queryRaw<Array<{ attempt: bigint }>>`
        SELECT "dispatch_attempt" AS attempt FROM "task" WHERE "id" = ${released.taskId}::uuid`;
      assert.ok(row.attempt >= 0n, 'dispatch_attempt must still be readable off the task');
    } finally {
      await s.db.$disconnect();
    }
  });

test('(d) the manual door still starts a task the sweep would never have offered',
  { skip, timeout: 180_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    try {
      const ids = await world(s.db, '0224-manual');
      // Deliberately opted OUT of auto-run, so only the manual door can start it. This is the path
      // `task_start` reaches: no observed epoch, a caller-minted trigger id.
      const { taskId } = await dependentTask(s.db, ids, '0224-manual', {
        autoRunWhenReady: false,
      });
      await sweep(s);
      assert.equal(await sessionCount(s.db, taskId), 0, 'the sweep must not have started it');

      const answer = await s.tasks.execute(ids.ownerId, taskId, undefined, `manual-${RUN}`);
      assert.equal(answer.ok, true, `manual start refused: ${JSON.stringify(answer)}`);
      assert.ok(answer.sessionId, 'a manual start must return its session receipt');
      assert.equal(await sessionCount(s.db, taskId), 1);
    } finally {
      await s.db.$disconnect();
    }
  });

test('(g) the dependency mechanism itself is untouched: satisfying an edge releases the task',
  { skip, timeout: 180_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    try {
      const ids = await world(s.db, '0224-edge');
      const { taskId, prerequisiteId, projectId } = await dependentTask(s.db, ids, '0224-edge', {
        prerequisiteStatus: TaskStatus.OPEN,
      });
      await sweep(s);
      assert.equal(await sessionCount(s.db, taskId), 0, 'an unsatisfied edge must hold the task');

      // `task_dependency` predates this project and is not this task's to touch. The proof is
      // behavioural: the row that held the task is still the row that releases it.
      const edges = await s.db.taskDependency.count({ where: { taskId } });
      assert.equal(edges, 1, 'the dependency edge must still be stored');

      // Finish the prerequisite the way the product finishes one. `status = DONE` is not a writer
      // input — 0193/0200's fence refuses it without a canonical completion fact — so the
      // prerequisite is completed by the aggregation policy it declares: one DONE child and no
      // outstanding one. Faking the status with raw SQL would prove the sweep reads a column, not
      // that a completed prerequisite releases its dependents.
      await s.db.task.update({
        where: { id: prerequisiteId },
        data: { completionPolicy: TaskCompletionPolicy.ALL_CHILDREN_DONE },
      });
      await s.db.task.create({
        data: {
          id: randomUUID(), ownerId: ids.ownerId, projectId, parentTaskId: prerequisiteId,
          assigneeId: ids.agentId, title: '0224-edge child', creatorType: CreatorType.USER,
          creatorId: ids.ownerId, provider: 'claude', status: TaskStatus.DONE,
          completionCriterion: 'EVIDENCE_JUDGMENT', autoRunWhenReady: false,
        },
      });
      await s.db.task.update({
        where: { id: prerequisiteId },
        data: { status: TaskStatus.DONE },
      });
      assert.equal(
        (await s.db.task.findUniqueOrThrow({ where: { id: prerequisiteId } })).status,
        TaskStatus.DONE, 'the prerequisite did not actually finish');
      await sweep(s);
      assert.equal(await sessionCount(s.db, taskId), 1,
        'finishing the prerequisite no longer releases the task');
    } finally {
      await s.db.$disconnect();
    }
  });
