/**
 * A list that has spent its own ceiling says so ON THE LIST, and says it once.
 *
 * `materialisationBudget` spends a list's `max_concurrent` as a materialisation budget, and the
 * auto-run sweep refuses a candidate when that ceiling is gone. That refusal has always been
 * reported in one aggregate line about the fleet ("N ready task(s) left for a later sweep — no free
 * slot to claim them"), which answers "is the machine busy" and not "is MY campaign stuck".
 *
 * The state it hides is the worst-shaped one: a list can go PAST its ceiling (a run materialised
 * by a door that did not spend the budget — the dependency edge before ab4d8c170, the project
 * sibling release before its fix), and then `free` is negative and this sweep materialises nothing
 * for that list at all, however READY the work is. Every other list keeps moving, so the fleet
 * looks healthy while one campaign is wedged. On 2026-09-21 that is exactly how the WARC list sat
 * for ten hours, and how the queue came to be read — by a downstream operator, from outside — as a
 * runner that would not pick work up.
 *
 * So the sweep records a `task_list_event` for it, through the same `recordListEvent` the two other
 * list-level holds use (`quota_hold`, `disk_hold`): one row per (list, kind), bumped in place, which
 * is what keeps a condition observed every minute from becoming 1,440 rows. The detail is assembled
 * server-side and rendered as-is, so a new kind needs no client change.
 *
 * Three cases, each with the control that makes it measurable:
 *   (1) the ceiling is spent and a genuinely READY task is refused → one `cap_hold` row, carrying
 *       the count and the number it is up against;
 *   (2) the SAME fixture one column over — the ceiling raised by one — records nothing, and the
 *       task is started instead, so (1) is measuring the ceiling and not a task that was never
 *       going to start;
 *   (3) a second sweep over a standing condition is still ONE row, with `occurrences` moved.
 *
 * Destructive: it seeds rows, so it runs only against a disposable server.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { CreatorType, PrismaClient, RunnerStatus, TaskStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
/** Emails are unique and this database can outlive one run. */
const RUN = randomUUID().slice(0, 8);

interface World {
  ownerId: string;
  runnerId: string;
  agentId: string;
}

function connect(): { db: PrismaClient; tasks: TasksService } {
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

/** An owner with one online runner (room for several runs) and one workspace bound to it. */
async function world(db: PrismaClient, label: string): Promise<World> {
  const ids = { ownerId: randomUUID(), runnerId: randomUUID(), agentId: randomUUID() };
  await db.user.create({
    data: {
      id: ids.ownerId, email: `${label}-${RUN}-${ids.ownerId}@caph.invalid`, name: label,
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: ids.runnerId, ownerId: ids.ownerId, name: `${label}-runner`,
      tokenHash: `hash-${ids.runnerId}`, status: RunnerStatus.ONLINE, capabilities: [],
      capabilitiesReportedAt: new Date(),
      // Room, so what refuses below is the LIST's ceiling and not the machine's.
      maxConcurrent: 8,
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

const seedList = (db: PrismaClient, ids: World, cap: number) =>
  db.taskList.create({
    data: {
      id: randomUUID(), ownerId: ids.ownerId,
      title: `cap-hold-${RUN}-${randomUUID().slice(0, 6)}`, maxConcurrent: cap,
    },
    select: { id: true },
  });

/** One task the auto-run sweep is looking for: OPEN, opted in, assigned, unheld, waiting on one DONE prerequisite. */
async function seedCandidate(
  db: PrismaClient,
  ids: World,
  listId: string,
  title: string,
): Promise<string> {
  const done = randomUUID();
  await db.task.create({
    data: {
      id: done, ownerId: ids.ownerId, listId, title: `${title}-prereq-${RUN}`,
      creatorType: CreatorType.USER, creatorId: ids.ownerId, provider: 'claude',
      completionCriterion: 'EVIDENCE_JUDGMENT', status: TaskStatus.DONE,
      autoRunWhenReady: false, dispatchHold: false,
    },
  });
  const id = randomUUID();
  await db.task.create({
    data: {
      id, ownerId: ids.ownerId, listId, assigneeId: ids.agentId, title: `${title}-${RUN}`,
      creatorType: CreatorType.USER, creatorId: ids.ownerId, provider: 'claude',
      completionCriterion: 'EVIDENCE_JUDGMENT', status: TaskStatus.OPEN,
      autoRunWhenReady: true, dispatchHold: false,
    },
  });
  await db.taskDependency.create({ data: { taskId: id, dependsOnTaskId: done } });
  return id;
}

/** A run already holding a slot of that list — PENDING, which is what the budget counts. */
async function occupyListSlot(
  db: PrismaClient,
  ids: World,
  listId: string,
  cap: number,
): Promise<void> {
  await db.session.create({
    data: {
      id: randomUUID(), title: `occupant-${RUN}`, prompt: 'x',
      ownerId: ids.ownerId, creatorId: ids.ownerId, workspaceId: ids.agentId,
      assignedRunnerId: ids.runnerId,
      batchId: listId, batchMaxConcurrent: cap, status: 'PENDING',
    },
  });
}

/** The real auto-run sweep, as the timer runs it. */
const sweep = (s: { tasks: TasksService }) =>
  (s.tasks as unknown as { reconcileReadyTasks(): Promise<void> }).reconcileReadyTasks();

const capHolds = (db: PrismaClient, listId: string) =>
  db.taskListEvent.findMany({
    where: { listId, kind: 'cap_hold' },
    select: { detail: true, occurrences: true },
  });

const sessionsOfTask = (db: PrismaClient, taskId: string) =>
  db.session.count({ where: { taskId } });

test('a list at its ceiling records cap_hold, once, and keeps counting',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    try {
      const ids = await world(s.db, 'cap-hold-full');
      const full = await seedList(s.db, ids, 1);
      await occupyListSlot(s.db, ids, full.id, 1);
      const refused = await seedCandidate(s.db, ids, full.id, 'refused');

      await sweep(s);

      // The refusal itself, so the event below is not recording a sweep that simply found nothing.
      assert.equal(await sessionsOfTask(s.db, refused), 0,
        'the sweep materialised into a list that is already at its ceiling');
      const holds = await capHolds(s.db, full.id);
      assert.equal(holds.length, 1, 'the list at its ceiling did not say so');
      assert.match(holds[0].detail, /1 个就绪任务/, 'the detail does not carry the count');
      assert.match(holds[0].detail, /并发上限/, 'the detail does not name the ceiling');
      assert.equal(holds[0].occurrences, 1);

      // (3) The condition stands, so the next sweep sees it again — and the row it already has is
      // bumped rather than joined by a second one. A condition observed every minute must not read
      // as 1,440 rows.
      await sweep(s);
      const again = await capHolds(s.db, full.id);
      assert.equal(again.length, 1, 'a standing condition was recorded as a second row');
      assert.equal(again[0].occurrences, 2, 'the second sighting did not move the counter');
    } finally {
      await s.db.$disconnect();
    }
  });

test('the control: one column over — a ceiling with room records nothing and starts the task',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    try {
      const ids = await world(s.db, 'cap-hold-room');
      // The same fixture as above with the ceiling one higher: the occupant now leaves a slot.
      const room = await seedList(s.db, ids, 2);
      await occupyListSlot(s.db, ids, room.id, 2);
      const released = await seedCandidate(s.db, ids, room.id, 'released');

      await sweep(s);

      assert.equal(await sessionsOfTask(s.db, released), 1,
        'the sweep started nothing in a list with room, so the refusal above is not the ceiling');
      assert.equal((await capHolds(s.db, room.id)).length, 0,
        'a list with room reported a ceiling it never ran into');
    } finally {
      await s.db.$disconnect();
    }
  });
