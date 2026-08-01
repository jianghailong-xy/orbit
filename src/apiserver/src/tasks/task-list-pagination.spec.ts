import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { TaskStatus } from '@orbit/shared';
import { TasksService } from './tasks.service';

const OWNER_ID = '00000000-0000-7000-8000-000000000001';

function serviceWith(prisma: unknown): TasksService {
  return new TasksService(prisma as never, {} as never, {} as never);
}

test('legacy list handles more than PostgreSQL bind limit without a giant task-id query', async () => {
  const tasks = Array.from({ length: 40_001 }, (_, i) => ({ id: `task-${i}` }));
  const dependencyChunks: string[][] = [];
  let busyWhere: any;
  const service = serviceWith({
    task: { findMany: async () => tasks },
    session: {
      groupBy: async (args: any) => {
        busyWhere = args.where;
        return [];
      },
    },
    taskDependency: {
      findMany: async (args: any) => {
        dependencyChunks.push(args.where.taskId.in);
        return [];
      },
    },
  });

  const result = await service.list(OWNER_ID);

  assert.equal(result.length, 40_001);
  assert.equal(busyWhere.ownerId, OWNER_ID);
  assert.deepEqual(busyWhere.taskId, { not: null });
  assert.equal(dependencyChunks.length, 9);
  assert.equal(dependencyChunks.flat().length, 40_001);
  assert.ok(dependencyChunks.every((chunk) => chunk.length <= 5_000));
});

test('paged list applies database filters, caps rows, and returns aggregate counts', async () => {
  const createdAt = new Date('2026-08-01T12:00:00.000Z');
  const rows = [
    { id: '00000000-0000-7000-8000-000000000010', createdAt, status: TaskStatus.OPEN },
    { id: '00000000-0000-7000-8000-000000000009', createdAt, status: TaskStatus.OPEN },
    { id: '00000000-0000-7000-8000-000000000008', createdAt, status: TaskStatus.OPEN },
  ];
  let findManyArgs: any;
  const countWheres: any[] = [];
  const service = serviceWith({
    task: {
      findMany: async (args: any) => {
        findManyArgs = args;
        return rows;
      },
      count: async (args: any) => {
        countWheres.push(args.where);
        if (args.where.sessions?.some?.status === RunStatus.RUNNING) return 1;
        if (args.where.sessions?.some?.status === RunStatus.PENDING) return 2;
        return 17;
      },
      groupBy: async () => [
        { status: TaskStatus.OPEN, _count: { _all: 12 } },
        { status: TaskStatus.DONE, _count: { _all: 5 } },
      ],
    },
    session: {
      groupBy: async () => [
        { taskId: rows[0].id, status: RunStatus.RUNNING, _count: { _all: 1 } },
        { taskId: rows[1].id, status: RunStatus.PENDING, _count: { _all: 1 } },
      ],
    },
    taskDependency: { findMany: async () => [] },
  });

  const result = await service.listPage(OWNER_ID, {
    limit: 2,
    status: 'ONGOING',
    listId: 'none',
    q: 'FineWeb',
  });

  assert.equal(findManyArgs.take, 3);
  assert.equal(findManyArgs.where.ownerId, OWNER_ID);
  assert.equal(findManyArgs.where.listId, null);
  assert.deepEqual(findManyArgs.where.status.in, [TaskStatus.OPEN, TaskStatus.IN_PROGRESS]);
  assert.equal(findManyArgs.where.title.contains, 'FineWeb');
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].running, true);
  assert.equal(result.items[1].queued, true);
  assert.ok(result.nextCursor);
  assert.equal(result.total, 17);
  assert.deepEqual(result.counts, {
    total: 17,
    open: 12,
    inProgress: 0,
    done: 5,
    failed: 0,
    cancelled: 0,
    running: 1,
    queued: 2,
  });
  assert.equal(countWheres.length, 3);
});

test('paged list rejects invalid bounds and filters before querying Prisma', async () => {
  const service = serviceWith({});
  await assert.rejects(() => service.listPage(OWNER_ID, { limit: 201 }), /limit must be/);
  await assert.rejects(() => service.listPage(OWNER_ID, { status: 'UNKNOWN' }), /invalid task status/);
  await assert.rejects(() => service.listPage(OWNER_ID, { cursor: 'not-a-cursor' }), /invalid task cursor/);
});
