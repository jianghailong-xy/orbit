/**
 * The Tasks page's scope — the tasks filed under no project (`projectId=none`) — asserted against
 * real PostgreSQL.
 *
 * The unit spec pins the SQL each read sends; this one pins what PostgreSQL answers, because the
 * scope is spelled three ways and any of them can be wrong in a way only a database shows: a
 * Prisma `projectId: null` (which must mean IS NULL, not "no filter"), the hand-written
 * `t.project_id IS NULL` of the Ready tab and the label table, and a `groupBy` over the lists.
 *
 * Destructive: it seeds rows, so it runs only against a disposable server.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { CreatorType, PrismaClient, RunnerStatus, TaskStatus } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { TaskListsService } from '../task-lists/task-lists.service';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

test('the Tasks page scope: tasks filed under no project, on every read', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const prisma = db as unknown as PrismaService;
  const publishes = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    publishes,
  );
  const tasks = new TasksService(prisma, sessions, publishes);
  const lists = new TaskListsService(prisma, publishes, {} as never);

  // ── the world: one owner, two projects, a project's list, a list of the owner's own ─────────
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `outside-${RUN}-${ownerId}@outside-projects.invalid`, name: 'owner', passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'runner', tokenHash: `outside-projects-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'orbit', enabled: true } });
  const fineweb = (await db.project.create({ data: { ownerId, title: 'FineWeb corpus' } })).id;
  const wiki = (await db.project.create({ data: { ownerId, title: 'Wiki', status: 'CANCELLED' } })).id;
  await db.project.create({ data: { ownerId, title: 'An empty project' } });
  const shards = (await db.taskList.create({ data: { ownerId, title: 'FineWeb shards' } })).id;
  const mine = (await db.taskList.create({ data: { ownerId, title: 'NCE3' } })).id;
  const empty = (await db.taskList.create({ data: { ownerId, title: 'Planned' } })).id;

  async function task(
    title: string,
    extra: { status?: TaskStatus; projectId?: string; listId?: string; labels?: string[] } = {},
  ): Promise<string> {
    const id = randomUUID();
    await db.task.create({
      data: {
        id, ownerId, title,
        creatorType: CreatorType.USER, creatorId: ownerId,
        completionCriterion: 'EVIDENCE_JUDGMENT',
        status: extra.status ?? TaskStatus.OPEN,
        projectId: extra.projectId, listId: extra.listId, labels: extra.labels ?? [],
        assigneeId: workspaceId,
      },
    });
    return id;
  }
  // The owner's own work: in no list, in their own list, failed, done, labelled.
  const own = [
    await task('mine: open'),
    await task('mine: failed', { status: TaskStatus.FAILED, labels: ['release'] }),
    await task('mine: done', { status: TaskStatus.DONE, labels: ['release'] }),
    await task('mine: in NCE3', { listId: mine }),
  ];
  // Some project's: shards in the project's list, one loose, one failed, one in a cancelled project.
  const theirs = [
    await task('shard 000', { projectId: fineweb, listId: shards, labels: ['release'] }),
    await task('shard 001', { projectId: fineweb, listId: shards }),
    await task('shard 002', { projectId: fineweb, status: TaskStatus.FAILED }),
    await task('wiki T11', { projectId: wiki }),
  ];

  const ids = (items: Array<{ id: string }>) => new Set(items.map((item) => item.id));

  // ── the page, every tab that can hold a project's task ─────────────────────────────────────
  for (const status of [undefined, 'ONGOING', 'RUNNABLE', 'FAILED']) {
    const page = await tasks.listPage(ownerId, { projectId: 'none', status, limit: 200 });
    for (const id of theirs) assert.ok(!ids(page.items).has(id), `${status ?? 'ALL'} lists a project's task`);
  }
  const all = await tasks.listPage(ownerId, { projectId: 'none', limit: 200 });
  assert.deepEqual(ids(all.items), new Set(own));
  assert.equal(all.counts?.total, own.length);
  assert.equal(all.counts?.failed, 1);
  // The Ready tab is hand-written SQL; its rows and its badge must both be the owner's.
  const ready = await tasks.listPage(ownerId, { projectId: 'none', status: 'RUNNABLE', limit: 200 });
  assert.equal(ready.total, ready.items.length);
  assert.ok(ready.items.every((item) => own.includes(item.id)));
  // NEGATIVE CONTROL: without the scope, the same owner's page holds the project's tasks.
  const unscoped = await tasks.listPage(ownerId, { limit: 200 });
  assert.equal(unscoped.items.length, own.length + theirs.length);

  // ── the tallies, with the sentence about the rest ──────────────────────────────────────────
  const counts = await tasks.taskCounts(ownerId, { projectId: 'none' });
  assert.equal(counts.total, own.length);
  assert.deepEqual(counts.inProjects, { tasks: theirs.length, projects: 2 }, 'the empty project has no tasks to point at');
  // No list, outside projects: `mine: open` and the two labelled ones, not the loose shard.
  const unlisted = await tasks.listPage(ownerId, { projectId: 'none', listId: 'none', limit: 200 });
  assert.equal(unlisted.counts?.total, 3);

  // ── the pinned strip and the label table ───────────────────────────────────────────────────
  const active = await tasks.activeTasks(ownerId, { projectId: 'none' });
  assert.deepEqual(ids(active.items), new Set([own[1]]), 'only the owner’s failed task is pinned');
  const labels = await tasks.labelSummary(ownerId, { projectId: 'none' });
  assert.deepEqual(labels.items.map((l) => [l.label, l.total, l.failed, l.done]), [['release', 2, 1, 1]]);

  // ── the lists index: how many of each list's tasks are outside projects ────────────────────
  const index = await lists.list(ownerId);
  const outside = Object.fromEntries(index.map((l) => [l.id, [l._count.tasks, l.tasksOutsideProjects]]));
  assert.deepEqual(outside[shards], [2, 0], 'the project’s list: every task is the project’s');
  assert.deepEqual(outside[mine], [1, 1]);
  assert.deepEqual(outside[empty], [0, 0]);

  // ── a task opened from a link names its project, and says when it was cancelled ────────────
  const shard = await tasks.get(ownerId, theirs[0]);
  assert.deepEqual(
    { id: shard.project?.id, title: shard.project?.title, status: shard.project?.status },
    { id: fineweb, title: 'FineWeb corpus', status: 'OPEN' },
  );
  assert.equal((await tasks.get(ownerId, theirs[3])).project?.status, 'CANCELLED');
  assert.equal((await tasks.get(ownerId, own[0])).project, null);
});
