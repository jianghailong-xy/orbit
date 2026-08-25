import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TasksService, type ListTasksPageQuery } from './tasks.service';

const OWNER_ID = '00000000-0000-7000-8000-000000000001';
const OTHER_OWNER_ID = '00000000-0000-7000-8000-000000000002';
const TASK_ID = '550e8400-e29b-41d4-a716-446655440000';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function serviceWith(prisma: unknown): TasksService {
  return new TasksService(prisma as never, {} as never, {} as never);
}

test('concurrent identical task pages execute one underlying query group', async () => {
  const rows = deferred<never[]>();
  const calls = { findMany: 0, count: 0, groupBy: 0, raw: 0 };
  const service = serviceWith({
    task: {
      findMany: async () => {
        calls.findMany += 1;
        return rows.promise;
      },
      count: async () => {
        calls.count += 1;
        return 0;
      },
      groupBy: async () => {
        calls.groupBy += 1;
        return [];
      },
    },
    $queryRaw: async () => {
      calls.raw += 1;
      return [{ count: 0 }];
    },
  });
  // Same explicit fields, deliberately inserted in a different object order.
  const firstQuery: ListTasksPageQuery = { status: 'OPEN', q: 'needle' };
  const secondQuery: ListTasksPageQuery = { q: 'needle', status: 'OPEN' };

  const first = service.listPage(OWNER_ID, firstQuery);
  const second = service.listPage(OWNER_ID, secondQuery);

  assert.equal(first, second, 'both callers share the exact in-flight promise');
  assert.deepEqual(calls, { findMany: 1, count: 3, groupBy: 1, raw: 1 });
  rows.resolve([]);
  assert.deepEqual(await first, await second);
});

test('different task page queries for one owner wait behind the first query group', async () => {
  const firstRows = deferred<never[]>();
  const secondRows = deferred<never[]>();
  let reads = 0;
  const service = serviceWith({
    task: {
      findMany: async () => {
        reads += 1;
        return reads === 1 ? firstRows.promise : secondRows.promise;
      },
    },
  });

  const alpha = service.listPage(OWNER_ID, { counts: 'none', q: 'alpha' });
  const beta = service.listPage(OWNER_ID, { counts: 'none', q: 'beta' });

  assert.notEqual(alpha, beta);
  assert.equal(reads, 1, 'the second query group has not started');
  firstRows.resolve([]);
  await alpha;
  await Promise.resolve();
  assert.equal(reads, 2, 'the next query starts only after the first settles');
  secondRows.resolve([]);
  await beta;
});

test('task page query groups for different owners can run in parallel', async () => {
  const rows = deferred<never[]>();
  let reads = 0;
  const service = serviceWith({
    task: {
      findMany: async () => {
        reads += 1;
        return rows.promise;
      },
    },
  });

  const first = service.listPage(OWNER_ID, { counts: 'none', q: 'alpha' });
  const second = service.listPage(OTHER_OWNER_ID, { counts: 'none', q: 'beta' });

  assert.equal(reads, 2);
  rows.resolve([]);
  await Promise.all([first, second]);
});

test('a failed owner query advances its serialized page tail', async () => {
  const secondRows = deferred<never[]>();
  let reads = 0;
  const service = serviceWith({
    task: {
      findMany: async () => {
        reads += 1;
        if (reads === 1) throw new Error('first page failed');
        return secondRows.promise;
      },
    },
  });

  const first = service.listPage(OWNER_ID, { counts: 'none', q: 'first' });
  const second = service.listPage(OWNER_ID, { counts: 'none', q: 'second' });

  assert.equal(reads, 1);
  await assert.rejects(first, /first page failed/);
  await Promise.resolve();
  assert.equal(reads, 2, 'failure releases the owner tail for the queued query');
  secondRows.resolve([]);
  await second;
});

test('a failed task page is removed from single-flight and can be retried', async () => {
  let reads = 0;
  const service = serviceWith({
    task: {
      findMany: async () => {
        reads += 1;
        if (reads === 1) throw new Error('page read failed');
        return [];
      },
    },
  });

  await assert.rejects(
    service.listPage(OWNER_ID, { counts: 'none' }),
    /page read failed/,
  );
  assert.deepEqual(await service.listPage(OWNER_ID, { counts: 'none' }), {
    items: [],
    nextCursor: null,
  });
  assert.equal(reads, 2);
});

test('concurrent identical task-count reads execute one aggregate group', async () => {
  const groups = deferred<never[]>();
  const calls = { count: 0, groupBy: 0, raw: 0 };
  const service = serviceWith({
    task: {
      groupBy: async () => {
        calls.groupBy += 1;
        return groups.promise;
      },
      count: async () => {
        calls.count += 1;
        return 0;
      },
    },
    $queryRaw: async () => {
      calls.raw += 1;
      return [{ count: 0 }];
    },
  });

  const first = service.taskCounts(OWNER_ID, { listId: 'none' });
  const second = service.taskCounts(OWNER_ID, { listId: 'none' });

  assert.equal(first, second);
  assert.deepEqual(calls, { count: 2, groupBy: 1, raw: 1 });
  groups.resolve([]);
  assert.deepEqual(await first, await second);
});

test('task counts wait behind a page read for the same owner', async () => {
  const rows = deferred<never[]>();
  let groupReads = 0;
  const service = serviceWith({
    task: {
      findMany: async () => rows.promise,
      groupBy: async () => {
        groupReads += 1;
        return [];
      },
      count: async () => 0,
    },
    $queryRaw: async () => [{ count: 0 }],
  });

  const page = service.listPage(OWNER_ID, { counts: 'none' });
  const counts = service.taskCounts(OWNER_ID);

  assert.equal(groupReads, 0, 'the count group has not competed with the active page');
  rows.resolve([]);
  await page;
  await Promise.resolve();
  assert.equal(groupReads, 1);
  await counts;
});

function detailRow() {
  return {
    id: TASK_ID,
    status: 'OPEN',
    terminalReason: null,
    supersededByTaskId: null,
    verifiesTaskId: null,
    dependsOn: [],
    supersedes: [],
    sessions: [],
    creatorSession: null,
    comments: [],
  };
}

test('concurrent reads of the same task detail hydrate it once', async () => {
  const row = deferred<ReturnType<typeof detailRow>>();
  let reads = 0;
  const service = serviceWith({
    task: {
      findFirst: async () => {
        reads += 1;
        return row.promise;
      },
    },
  });

  const first = service.get(OWNER_ID, TASK_ID);
  const second = service.get(OWNER_ID, TASK_ID);

  assert.equal(first, second);
  assert.equal(reads, 1);
  row.resolve(detailRow());
  assert.equal((await first).id, TASK_ID);
  await second;
});

test('task detail single-flight isolates owners even for the same task id', async () => {
  const row = deferred<ReturnType<typeof detailRow>>();
  let reads = 0;
  const service = serviceWith({
    task: {
      findFirst: async () => {
        reads += 1;
        return row.promise;
      },
    },
  });

  const first = service.get(OWNER_ID, TASK_ID);
  const second = service.get(OTHER_OWNER_ID, TASK_ID);

  assert.notEqual(first, second);
  assert.equal(reads, 2);
  row.resolve(detailRow());
  await Promise.all([first, second]);
});

test('a failed task detail read is removed from single-flight and can be retried', async () => {
  let reads = 0;
  const service = serviceWith({
    task: {
      findFirst: async () => {
        reads += 1;
        if (reads === 1) throw new Error('detail read failed');
        return detailRow();
      },
    },
  });

  await assert.rejects(service.get(OWNER_ID, TASK_ID), /detail read failed/);
  assert.equal((await service.get(OWNER_ID, TASK_ID)).id, TASK_ID);
  assert.equal(reads, 2);
});
