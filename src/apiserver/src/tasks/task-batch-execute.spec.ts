import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BATCH_EXECUTE_DISPATCH_CONCURRENCY,
  TasksService,
} from './tasks.service';
import { fakeReceiptStore } from './task-run-receipt-fake';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(message);
}

function makeService(
  count: number,
  sessions: { taskId: string; status: string }[] = [],
  /** Ids the fixture answers `task.findFirst` for with null — a task that has been deleted. */
  gone: ReadonlySet<string> = new Set(),
) {
  const tasks = Array.from({ length: count }, (_, index) => ({
    id: `task-${index}`,
    title: `Task ${index}`,
    description: null,
    // §13.1 AG6's two facts. Every task in this fixture is an ordinary leaf, which is what these
    // tests are about; the aggregate-parent skip has its own coverage in
    // `task-aggregate-parent-execute.spec.ts` and against real PostgreSQL.
    completionPolicy: 'MANUAL' as const,
    children: [] as Array<{ id: string }>,
    assignee: { id: `workspace-${index}`, runnerId: 'runner-1' },
  }));
  const prisma = {
    // Every run door opens its receipt (0137) before anything else.
    ...fakeReceiptStore(),
    task: {
      findMany: async () => tasks,
      // A failed item is classified against its own artifact before it is called failed (H2F), and
      // that read asks whether the task is still there.
      findFirst: async ({ where }: { where: { id: string } }) =>
        (gone.has(where.id) ? null : tasks.find((t: { id: string }) => t.id === where.id) ?? null),
    },
    taskDependency: { findMany: async () => [] },
    // Honour the status filter the caller asks for, so a test can assert *which* session
    // states batchExecute counts as "already running" rather than trusting a fixed stub.
    // A paused run's delivery is read by its own turn key before it is written (H2F).
    conversationTurn: { findUnique: async () => null },
    session: {
      // The door reads THIS request's own Session by id before it writes (H2F).
      findUnique: async () => null,
      // The id travels with the taskId now: "already running" is not the answer when the run that
      // is already running is THIS PRESS'S OWN, and only the id can tell the two apart (H2F).
      findMany: async (args: { where: { status: { in: string[] } } }) =>
        sessions
          .filter((s) => args.where.status.in.includes(s.status))
          .map((s, index) => ({
            taskId: s.taskId,
            id: `00000000-0000-4000-8000-00000000000${index}`,
          })),
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
  (service as unknown as Record<string, unknown>).planWorkspaceRun =
    async (_o: string, task: { id: string }) =>
      ({ kind: 'CREATE', sessionId: `00000000-0000-4000-8000-${task.id}` });
  (service as any).applyWorkspaceRun = async (...args: unknown[]) => {
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
  (service as unknown as Record<string, unknown>).planWorkspaceRun =
    async (_o: string, task: { id: string }) =>
      ({ kind: 'CREATE', sessionId: `00000000-0000-4000-8000-${task.id}` });
  (service as any).applyWorkspaceRun = async (...args: unknown[]) => {
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
    // The reason NAMES the row in the way now. "Already running" is only the answer when the run
    // is somebody else's, so the answer says whose (H2F).
    { id: 'task-2', title: 'Task 2', reason: 'Already running or queued (session 1VgEh72lXvTXkG)' },
    { id: 'task-3', title: 'Task 3', reason: 'Already running or queued (session 1VgEh72lXvTXkH)' },
  ]);
});

test('batchExecute preserves runnable order when collecting out-of-order failures', async () => {
  /** Tasks the fixture reports as DELETED, which is the monotone artifact a failed item needs. */
  const gone = new Set<string>();
  const service = makeService(4, [], gone);
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
  (service as unknown as Record<string, unknown>).planWorkspaceRun =
    async (_o: string, task: { id: string }) =>
      ({ kind: 'CREATE', sessionId: `00000000-0000-4000-8000-${task.id}` });
  (service as any).applyWorkspaceRun = async (...args: unknown[]) => {
    const task = args[1] as { id: string };
    return deferred.get(task.id)!.promise;
  };

  const resultPromise = service.batchExecute(
    'owner-1',
    Array.from({ length: 4 }, (_, index) => `task-${index}`),
  );
  await flush();
  // The failures are ones whose ARTIFACT is monotone: the tasks they name are gone, so the items
  // can never run under this plan. Nothing else may enter a tally — a tally is frozen as this
  // press's answer for ever, and an uncertain failure makes the whole press retryable instead (see
  // the test below).
  gone.add('task-3');
  gone.add('task-1');
  deferred.get('task-3')!.reject(new Error('the task went away'));
  deferred.get('task-2')!.resolve('session-2');
  deferred.get('task-1')!.reject(new Error('the task went away'));
  deferred.get('task-0')!.resolve('session-0');

  const result = await resultPromise;
  assert.equal(result.dispatched, 2);
  assert.deepEqual(result.failed, [
    { id: 'task-1', ok: false, error: 'the task has been deleted' },
    { id: 'task-3', ok: false, error: 'the task has been deleted' },
  ]);
});

test('an item that failed UNCERTAINLY makes the whole press retryable rather than failed', async () => {
  // The rule the tally lives by. An engine signed out, a workspace disabled, an unclassified
  // failure — none of them says whether the Session committed, and freezing one as `{ ok: false }`
  // hands the caller an answer the next delivery will contradict, with no reason to ask again.
  //
  // Real uuids here rather than the `task-N` labels the ordering tests use: the refusal names the
  // tasks it could not settle as PUBLIC ids, which is what a caller can act on.
  const ids = ['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b'];
  const tasks = ids.map((id, index) => ({
    id,
    title: `Task ${index}`,
    description: null,
    completionPolicy: 'MANUAL',
    children: [],
    status: 'OPEN',
    runAt: null,
    projectId: null,
    provider: null,
    model: null,
    listId: null,
    isForeman: false,
    verifiesTaskId: null,
    supersededByTaskId: null,
    terminalReason: null,
    verifies: null,
    list: null,
    assignee: { id: 'workspace-1', runnerId: 'runner-1' },
  }));
  const prisma = {
    // Every run door opens its receipt (0137) before anything else.
    ...fakeReceiptStore(),
    task: {
      findMany: async () => tasks,
      findFirst: async ({ where }: { where: { id: string } }) =>
        tasks.find((t) => t.id === where.id) ?? null,
    },
    taskDependency: { findMany: async () => [] },
    conversationTurn: { findUnique: async () => null },
    session: {
      findUnique: async () => null,
      findFirst: async () => null,
      findMany: async () => [],
    },
  } as never;
  const service = new TasksService(prisma, {} as never, {} as never);
  (service as unknown as Record<string, unknown>).planWorkspaceRun =
    async (_o: string, task: { id: string }) => ({ kind: 'CREATE', sessionId: task.id });
  (service as unknown as Record<string, unknown>).applyWorkspaceRun =
    async (...args: unknown[]) => {
      const task = args[1] as { id: string };
      if (task.id === ids[1]) throw new Error('the engine is signed out');
      return 'session-0';
    };

  await assert.rejects(
    () => service.batchExecute('00000000-0000-4000-8000-0000000000ff', ids),
    (error: Error) => {
      const body = (error as unknown as { getResponse?: () => Record<string, unknown> })
        .getResponse?.() ?? {};
      assert.equal(body.code, 'TASK_RUN_REQUEST_UNSETTLED', `got: ${error.message}`);
      assert.equal(body.retryable, true);
      assert.equal((body.pendingTaskIds as string[]).length, 1);
      return true;
    },
  );
});

test('a bulk run carries the list instructions the single-task Run would have', async () => {
  // The two Run buttons must assemble the same prompt for the same task. They reach
  // buildExecutePrompt through different queries, so the batch query having its own `select` is
  // exactly where the two can drift apart without anything failing loudly.
  const instructions = '须去重、断点续传，并按 Content-Length 校验。';
  const prisma = {
    // Every run door opens its receipt (0137) before anything else.
    ...fakeReceiptStore(),
    task: {
      // Honours the caller's `select`, like the groupBy stub in auto-run-backoff.spec: a stub
      // that hands back fields nobody asked for cannot fail when the query stops asking, which
      // is precisely the drift this test exists to catch.
      findMany: async (args: { select?: Record<string, unknown> }) => [
        {
          id: 'task-0',
          title: 'Task 0',
          description: '下载 000_00008.parquet',
          ...(args?.select?.list ? { list: { instructions } } : {}),
          // §13.1 AG6's two facts; an ordinary leaf, like every task in this file.
          completionPolicy: 'MANUAL' as const,
          children: [] as Array<{ id: string }>,
          assignee: { id: 'workspace-0', runnerId: 'runner-1' },
        },
      ],
    },
    taskDependency: { findMany: async () => [] },
    session: {
      // The door reads THIS request's own Session by id before it writes (H2F).
      findUnique: async () => null, findMany: async () => [] },
  } as never;
  const service = new TasksService(prisma, {} as never, {} as never);
  const prompts: string[] = [];
  (service as unknown as Record<string, unknown>).planWorkspaceRun =
    async (_o: string, task: { id: string }) =>
      ({ kind: 'CREATE', sessionId: `00000000-0000-4000-8000-${task.id}` });
  (service as any).applyWorkspaceRun = async (...args: unknown[]) => {
    prompts.push(args[3] as string);
    return 'session-1';
  };

  await service.batchExecute('owner-1', ['task-0']);

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /作业指导（本任务列表通用）：\n须去重、断点续传，并按 Content-Length 校验。/);
});
