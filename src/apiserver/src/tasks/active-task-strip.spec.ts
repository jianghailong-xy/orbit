import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus, TaskStatus } from '@prisma/client';
import { ACTIVE_TASK_STRIP_MAX, TasksService } from './tasks.service';

const OWNER_ID = '00000000-0000-7000-8000-000000000001';
const LIST_ID = '00000000-0000-7000-8000-0000000000aa';

function serviceWith(prisma: unknown): TasksService {
  return new TasksService(prisma as never, {} as never, {} as never);
}

function harness(rows: Array<{ id: string; status?: TaskStatus }>, total = rows.length) {
  const calls: { where?: any; take?: number } = {};
  const prisma = {
    task: {
      findMany: async (args: any) => {
        calls.where = args.where;
        calls.take = args.take;
        return rows;
      },
      count: async () => total,
    },
    session: { groupBy: async () => [] },
    taskDependency: { findMany: async () => [] },
    // The strip annotates its bounded rows through the shared runnable predicate. These fixtures
    // exercise strip membership/counting, so answer that independent overlay conservatively.
    $queryRaw: async () => [],
  };
  return { service: serviceWith(prisma), calls };
}

test('the strip asks for live runs and stuck statuses, not for a page of the list', async () => {
  const { service, calls } = harness([]);

  await service.activeTasks(OWNER_ID);

  // Running/queued live on the session rows, so they cannot be a column predicate; IN_PROGRESS
  // and FAILED are task statuses. A task qualifying on either side belongs in the strip.
  assert.deepEqual(calls.where.OR, [
    { sessions: { some: { status: { in: [RunStatus.RUNNING, RunStatus.PENDING] } } } },
    { status: { in: [TaskStatus.IN_PROGRESS, TaskStatus.FAILED] } },
  ]);
  assert.equal(calls.where.ownerId, OWNER_ID);
  assert.equal(calls.take, ACTIVE_TASK_STRIP_MAX);
});

test('the strip is scoped to the open list, like the rest of the page', async () => {
  const { service, calls } = harness([]);

  await service.activeTasks(OWNER_ID, { listId: LIST_ID });

  assert.equal(calls.where.listId, LIST_ID);
});

test('the unlisted bucket is a scope, not a list id', async () => {
  const { service, calls } = harness([]);

  await service.activeTasks(OWNER_ID, { listId: 'none' });

  assert.equal(calls.where.listId, null);
});

test('a list id that is not one is rejected rather than silently ignored', async () => {
  const { service } = harness([]);
  await assert.rejects(() => service.activeTasks(OWNER_ID, { listId: 'not-a-uuid' }));
});

// A strip that quietly shows the first 50 of 900 failures reads as "50 failures".
test('a truncated strip reports the true total', async () => {
  const rows = Array.from({ length: ACTIVE_TASK_STRIP_MAX }, (_, i) => ({
    id: `00000000-0000-7000-8000-0000000000${String(i).padStart(2, '0')}`,
    status: TaskStatus.FAILED,
  }));
  const { service } = harness(rows, 900);

  const result = await service.activeTasks(OWNER_ID);

  assert.equal(result.items.length, ACTIVE_TASK_STRIP_MAX);
  assert.equal(result.total, 900);
  assert.equal(result.truncated, true);
});

test('a strip that fits reports itself complete', async () => {
  const { service } = harness([{ id: '00000000-0000-7000-8000-0000000000b1' }], 1);

  const result = await service.activeTasks(OWNER_ID);

  assert.equal(result.total, 1);
  assert.equal(result.truncated, false);
});
