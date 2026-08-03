import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUTO_RUN_RETRY_BACKOFF_MS,
  MAX_AUTO_RUN_FAILURES,
  TasksService,
} from './tasks.service';

interface FailureHistory {
  taskId: string;
  failed: number;
  lastFailedAt: Date;
}

/**
 * One OPEN, auto-run, runner-bound task per entry in `history` plus `readyTaskIds` with no
 * failures at all, each with a single DONE prerequisite so dependencyStatesFor reports READY.
 * Everything the reconcile sweep reads is stubbed; execute() records what it dispatched.
 */
function makeService(readyTaskIds: string[], history: FailureHistory[]) {
  const taskIds = [...readyTaskIds, ...history.map((h) => h.taskId)];
  const executed: string[] = [];
  const prisma = {
    task: {
      findMany: async () => taskIds.map((id) => ({ id, ownerId: 'owner-1' })),
    },
    taskDependency: {
      findMany: async ({ where }: { where: { taskId: { in: string[] } } }) =>
        where.taskId.in.map((taskId) => ({ taskId, dependsOnTask: { status: 'DONE' } })),
    },
    session: {
      groupBy: async ({ where }: { where: { taskId: { in: string[] } } }) =>
        history
          .filter((h) => where.taskId.in.includes(h.taskId))
          .map((h) => ({
            taskId: h.taskId,
            _count: { _all: h.failed },
            _max: { createdAt: h.lastFailedAt },
          })),
    },
  } as never;
  const service = new TasksService(prisma, {} as never, {} as never);
  (service as unknown as { execute: unknown }).execute = async (
    _ownerId: string,
    id: string,
  ) => {
    executed.push(id);
  };
  return { service, executed };
}

const sweep = (service: TasksService): Promise<void> =>
  (service as unknown as { reconcileReadyTasks(): Promise<void> }).reconcileReadyTasks();

const agoMs = (ms: number): Date => new Date(Date.now() - ms);

test('a ready task with no failed run is dispatched immediately', async () => {
  const { service, executed } = makeService(['task-fresh'], []);
  await sweep(service);
  assert.deepEqual(executed, ['task-fresh']);
});

test('a task is held off while inside the backoff window for its failure count', async () => {
  // One failed run 30s ago; the first backoff step is minutes, so this sweep must skip it.
  const { service, executed } = makeService(
    [],
    [{ taskId: 'task-just-failed', failed: 1, lastFailedAt: agoMs(30_000) }],
  );
  await sweep(service);
  assert.deepEqual(executed, []);
});

test('a task is retried once its backoff window has elapsed', async () => {
  const { service, executed } = makeService(
    [],
    [
      {
        taskId: 'task-cooled-down',
        failed: 1,
        lastFailedAt: agoMs(AUTO_RUN_RETRY_BACKOFF_MS[0] + 1_000),
      },
    ],
  );
  await sweep(service);
  assert.deepEqual(executed, ['task-cooled-down']);
});

test('backoff lengthens with each successive failure', async () => {
  // Three failures: still inside step [2], which the one-failure window would already clear.
  const { service, executed } = makeService(
    [],
    [
      {
        taskId: 'task-failing',
        failed: 3,
        lastFailedAt: agoMs(AUTO_RUN_RETRY_BACKOFF_MS[0] + 1_000),
      },
    ],
  );
  await sweep(service);
  assert.deepEqual(executed, []);
});

test('a task that burned through MAX_AUTO_RUN_FAILURES is never auto-run again', async () => {
  // Long past every backoff step — the cap, not the window, is what keeps it held.
  const { service, executed } = makeService(
    [],
    [
      {
        taskId: 'task-exhausted',
        failed: MAX_AUTO_RUN_FAILURES,
        lastFailedAt: agoMs(24 * 60 * 60_000),
      },
    ],
  );
  await sweep(service);
  assert.deepEqual(executed, []);
});

test('one failing task does not hold back its healthy neighbours', async () => {
  const { service, executed } = makeService(
    ['task-ok'],
    [{ taskId: 'task-blocked', failed: MAX_AUTO_RUN_FAILURES, lastFailedAt: agoMs(60_000) }],
  );
  await sweep(service);
  assert.deepEqual(executed, ['task-ok']);
});
