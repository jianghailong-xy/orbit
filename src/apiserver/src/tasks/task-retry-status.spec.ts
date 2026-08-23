import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TasksService } from './tasks.service';
import { fakeReceiptStore } from './task-run-receipt-fake';

const TASK_ID = '550e8400-e29b-41d4-a716-446655440000';

/**
 * Running a task that previously failed: the dispatch itself is stubbed out, so what these
 * assert is the status write that follows it — a retried task must leave the Failed bucket
 * instead of sitting there with a live "Running" pill.
 */
function retryFixture(status: string, updated = 1) {
  const statusWrites: any[] = [];
  const published: any[][] = [];
  const prisma = {
    // Every run door opens its receipt (0137) before anything else.
    ...fakeReceiptStore(),
    task: {
      findFirst: async () => ({
        id: TASK_ID,
        title: 'Ship it',
        description: null,
        provider: null,
        model: null,
        status,
        // §13.1 AG6's two facts. Every task in this fixture is an ordinary leaf; the
        // aggregate-parent gate has its own coverage in `task-aggregate-parent-execute.spec.ts`.
        completionPolicy: 'MANUAL',
        children: [],
        assignee: { id: 'workspace-1', runnerId: 'runner-1' },
      }),
      updateMany: async (args: any) => {
        statusWrites.push(args);
        return { count: updated };
      },
    },
    taskDependency: { findMany: async () => [] },
    // A paused run's delivery is read by its own turn key before it is written (H2F).
    conversationTurn: { findUnique: async () => null },
    session: {
      // The door reads THIS request's own Session by id before it writes (H2F).
      findUnique: async () => null, findFirst: async () => null },
  } as never;
  const sessions = { create: async () => ({ id: 'session-1' }) } as never;
  const realtime = { publishForUser: (...args: any[]) => published.push(args) } as never;
  return { service: new TasksService(prisma, sessions, realtime), statusWrites, published };
}

test('retrying a FAILED task moves it back to IN_PROGRESS', async () => {
  const f = retryFixture('FAILED');

  const result = await f.service.execute('owner-1', TASK_ID);

  assert.equal(result.sessionId, 'session-1');
  assert.equal(f.statusWrites.length, 1);
  // IN_PROGRESS, not OPEN: it is the state reclaimStalledTask rewrites, so a retry that
  // fails again lands back at FAILED instead of silently staying actionable.
  assert.equal(f.statusWrites[0].data.status, 'IN_PROGRESS');
  // Conditional on the task still being FAILED, so a run that already reported its own
  // outcome is never dragged backwards.
  assert.equal(f.statusWrites[0].where.status, 'FAILED');
  assert.equal(f.statusWrites[0].where.id, TASK_ID);
  assert.equal(f.statusWrites[0].where.ownerId, 'owner-1');
  assert.equal(f.published.length, 1);
  assert.deepEqual(f.published[0].slice(1), ['task_changed', TASK_ID]);
});

test('running a task that is not FAILED leaves its status alone', async () => {
  for (const status of ['OPEN', 'IN_PROGRESS', 'CANCELLED']) {
    const f = retryFixture(status);

    await f.service.execute('owner-1', TASK_ID);

    assert.equal(f.statusWrites.length, 0, status);
    assert.equal(f.published.length, 0, status);
  }
});

test('a status write the task raced past publishes nothing', async () => {
  const f = retryFixture('FAILED', 0);

  await f.service.execute('owner-1', TASK_ID);

  assert.equal(f.statusWrites.length, 1);
  assert.equal(f.published.length, 0);
});

test('batch-running a FAILED task clears it the same way', async () => {
  const statusWrites: any[] = [];
  const prisma = {
    // Every run door opens its receipt (0137) before anything else.
    ...fakeReceiptStore(),
    task: {
      findMany: async () => [
        {
          id: TASK_ID,
          title: 'Ship it',
          description: null,
          provider: null,
          model: null,
          status: 'FAILED',
          // §13.1 AG6's two facts. Every task in this fixture is an ordinary leaf; the
          // aggregate-parent gate has its own coverage in `task-aggregate-parent-execute.spec.ts`.
          completionPolicy: 'MANUAL',
          children: [],
          assignee: { id: 'workspace-1', runnerId: 'runner-1' },
        },
        {
          id: 'task-open',
          title: 'Also ship it',
          description: null,
          provider: null,
          model: null,
          status: 'OPEN',
          // §13.1 AG6's two facts. Every task in this fixture is an ordinary leaf; the
          // aggregate-parent gate has its own coverage in `task-aggregate-parent-execute.spec.ts`.
          completionPolicy: 'MANUAL',
          children: [],
          assignee: { id: 'workspace-1', runnerId: 'runner-1' },
        },
      ],
      updateMany: async (args: any) => {
        statusWrites.push(args);
        return { count: 1 };
      },
    },
    taskDependency: { findMany: async () => [] },
    session: {
      // The door reads THIS request's own Session by id before it writes (H2F).
      findUnique: async () => null, findMany: async () => [] },
  } as never;
  const realtime = { publishForUser: () => {} } as never;
  const service = new TasksService(prisma, {} as never, realtime);
  (service as unknown as Record<string, unknown>).planWorkspaceRun =
    async (_o: string, task: { id: string }) =>
      ({ kind: 'CREATE', sessionId: `00000000-0000-4000-8000-${task.id}` });
  (service as any).applyWorkspaceRun = async () => 'session-1';

  const result = await service.batchExecute('owner-1', [TASK_ID, 'task-open']);

  assert.equal(result.dispatched, 2);
  assert.equal(statusWrites.length, 1);
  assert.equal(statusWrites[0].where.id, TASK_ID);
  assert.equal(statusWrites[0].data.status, 'IN_PROGRESS');
});
