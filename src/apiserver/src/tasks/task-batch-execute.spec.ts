import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BATCH_EXECUTE_DISPATCH_CONCURRENCY,
  TasksService,
} from './tasks.service';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(message);
}

function makeService(count: number, sessions: { taskId: string; status: string }[] = []) {
  const tasks = Array.from({ length: count }, (_, index) => ({
    id: `task-${index}`,
    title: `Task ${index}`,
    description: null,
    assignee: { id: `workspace-${index}`, runnerId: 'runner-1' },
  }));
  const prisma = {
    task: { findMany: async () => tasks },
    taskDependency: { findMany: async () => [] },
    // Honour the status filter the caller asks for, so a test can assert *which* session
    // states batchExecute counts as "already running" rather than trusting a fixed stub.
    session: {
      findMany: async (args: { where: { status: { in: string[] } } }) =>
        sessions
          .filter((s) => args.where.status.in.includes(s.status))
          .map((s) => ({ taskId: s.taskId })),
    },
  } as never;
  return new TasksService(prisma, {} as never, {} as never);
}

test('batchExecute bounds session initialization independently of runtime maxConcurrent', async () => {
  const total = BATCH_EXECUTE_DISPATCH_CONCURRENCY * 2 + 1;
  const service = makeService(total);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0;
  let maxActive = 0;
  let started = 0;
  const batches: Array<{ id: string; maxConcurrent: number } | undefined> = [];
  (service as any).runWorkspaceOnTask = async (...args: unknown[]) => {
    const task = args[1] as { id: string };
    batches.push(args[5] as { id: string; maxConcurrent: number } | undefined);
    started += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await gate;
    active -= 1;
    return `session-${task.id}`;
  };

  const resultPromise = service.batchExecute(
    'owner-1',
    Array.from({ length: total }, (_, index) => `task-${index}`),
    2,
  );
  await waitUntil(
    () => started === BATCH_EXECUTE_DISPATCH_CONCURRENCY,
    'dispatch workers did not reach their limit',
  );

  assert.equal(maxActive, BATCH_EXECUTE_DISPATCH_CONCURRENCY);
  assert.notEqual(maxActive, 2);
  release();

  const result = await resultPromise;
  assert.equal(result.dispatched, total);
  assert.deepEqual(result.failed, []);
  assert.equal(maxActive, BATCH_EXECUTE_DISPATCH_CONCURRENCY);
  assert.ok(result.batchId);
  assert.equal(result.maxConcurrent, 2);
  assert.equal(batches.length, total);
  assert.ok(batches.every((batch) => batch?.id === result.batchId && batch.maxConcurrent === 2));
});

/**
 * Bulk Run and the single-task Run must mean the same thing. Only PENDING/RUNNING
 * (SINGLE_RUN_DEDUP) counts as already-running: a session parked at AWAITING_INPUT /
 * INTERRUPTED is idle, and the row's Run button, the Ready filter (runnableTaskWhere) and
 * the detail panel all offer such a task as runnable, so the batch has to dispatch it too.
 * Skipping it here made bulk Run silently no-op on exactly the tasks the list showed as ready.
 */
test('batchExecute dispatches parked sessions and skips only in-flight ones', async () => {
  const service = makeService(5, [
    { taskId: 'task-0', status: 'AWAITING_INPUT' },
    { taskId: 'task-1', status: 'INTERRUPTED' },
    { taskId: 'task-2', status: 'PENDING' },
    { taskId: 'task-3', status: 'RUNNING' },
    // task-4 has no session at all.
  ]);
  const dispatched: string[] = [];
  (service as any).runWorkspaceOnTask = async (...args: unknown[]) => {
    const task = args[1] as { id: string };
    dispatched.push(task.id);
    return `session-${task.id}`;
  };

  const result = await service.batchExecute(
    'owner-1',
    Array.from({ length: 5 }, (_, index) => `task-${index}`),
  );

  assert.deepEqual(dispatched, ['task-0', 'task-1', 'task-4']);
  assert.equal(result.dispatched, 3);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.skipped, [
    { id: 'task-2', title: 'Task 2', reason: 'Already running or queued' },
    { id: 'task-3', title: 'Task 3', reason: 'Already running or queued' },
  ]);
});

test('batchExecute preserves runnable order when collecting out-of-order failures', async () => {
  const service = makeService(4);
  const deferred = new Map<
    string,
    { promise: Promise<string>; resolve: (value: string) => void; reject: (reason: Error) => void }
  >();
  for (let index = 0; index < 4; index++) {
    let resolve!: (value: string) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    deferred.set(`task-${index}`, { promise, resolve, reject });
  }
  (service as any).runWorkspaceOnTask = async (...args: unknown[]) => {
    const task = args[1] as { id: string };
    return deferred.get(task.id)!.promise;
  };

  const resultPromise = service.batchExecute(
    'owner-1',
    Array.from({ length: 4 }, (_, index) => `task-${index}`),
  );
  await flush();
  deferred.get('task-3')!.reject(new Error('failure 3'));
  deferred.get('task-2')!.resolve('session-2');
  deferred.get('task-1')!.reject(new Error('failure 1'));
  deferred.get('task-0')!.resolve('session-0');

  const result = await resultPromise;
  assert.equal(result.dispatched, 2);
  assert.deepEqual(result.failed, [
    { id: 'task-1', ok: false, error: 'failure 1' },
    { id: 'task-3', ok: false, error: 'failure 3' },
  ]);
});
