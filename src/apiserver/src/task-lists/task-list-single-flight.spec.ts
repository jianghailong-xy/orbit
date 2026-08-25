import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskListsService } from './task-lists.service';

const OWNER_ID = '00000000-0000-7000-8000-000000000001';
const OTHER_OWNER_ID = '00000000-0000-7000-8000-000000000002';
const LIST_ID = '00000000-0000-7000-8000-000000000003';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function serviceWith(prisma: unknown): TaskListsService {
  return new TaskListsService(prisma as never, {} as never, {} as never);
}

test('concurrent task-list indexes for one owner execute one query group', async () => {
  const lists = deferred<never[]>();
  const calls = { lists: 0, aggregates: 0 };
  const service = serviceWith({
    taskList: {
      findMany: async () => {
        calls.lists += 1;
        return lists.promise;
      },
    },
    task: {
      groupBy: async () => {
        calls.aggregates += 1;
        return [];
      },
    },
  });

  const first = service.list(OWNER_ID);
  const second = service.list(OWNER_ID);

  assert.equal(first, second);
  assert.deepEqual(calls, { lists: 1, aggregates: 0 });
  lists.resolve([]);
  assert.deepEqual(await first, []);
  assert.deepEqual(await second, []);
  assert.deepEqual(calls, { lists: 1, aggregates: 2 });
});

test('task-list index single-flight isolates owners', async () => {
  const lists = deferred<never[]>();
  let reads = 0;
  const service = serviceWith({
    taskList: {
      findMany: async () => {
        reads += 1;
        return lists.promise;
      },
    },
    task: { groupBy: async () => [] },
  });

  const first = service.list(OWNER_ID);
  const second = service.list(OTHER_OWNER_ID);

  assert.notEqual(first, second);
  assert.equal(reads, 2);
  lists.resolve([]);
  await Promise.all([first, second]);
});

test('a failed task-list index is removed from single-flight and can be retried', async () => {
  let reads = 0;
  const service = serviceWith({
    taskList: {
      findMany: async () => {
        reads += 1;
        if (reads === 1) throw new Error('task-list read failed');
        return [];
      },
    },
    task: { groupBy: async () => [] },
  });

  await assert.rejects(service.list(OWNER_ID), /task-list read failed/);
  assert.deepEqual(await service.list(OWNER_ID), []);
  assert.equal(reads, 2);
});

function listDetail() {
  return { id: LIST_ID, title: 'Selected list', tasks: [] };
}

test('concurrent reads of the same selected task-list detail hydrate it once', async () => {
  const row = deferred<ReturnType<typeof listDetail>>();
  let reads = 0;
  const service = serviceWith({
    taskList: {
      findFirst: async () => {
        reads += 1;
        return row.promise;
      },
    },
  });

  const first = service.get(OWNER_ID, LIST_ID);
  const second = service.get(OWNER_ID, LIST_ID);

  assert.equal(first, second);
  assert.equal(reads, 1);
  row.resolve(listDetail());
  assert.equal((await first).id, LIST_ID);
  await second;
});

test('selected task-list detail single-flight isolates owners', async () => {
  const row = deferred<ReturnType<typeof listDetail>>();
  let reads = 0;
  const service = serviceWith({
    taskList: {
      findFirst: async () => {
        reads += 1;
        return row.promise;
      },
    },
  });

  const first = service.get(OWNER_ID, LIST_ID);
  const second = service.get(OTHER_OWNER_ID, LIST_ID);

  assert.notEqual(first, second);
  assert.equal(reads, 2);
  row.resolve(listDetail());
  await Promise.all([first, second]);
});

test('a failed selected task-list detail read can be retried', async () => {
  let reads = 0;
  const service = serviceWith({
    taskList: {
      findFirst: async () => {
        reads += 1;
        if (reads === 1) throw new Error('task-list detail failed');
        return listDetail();
      },
    },
  });

  await assert.rejects(service.get(OWNER_ID, LIST_ID), /task-list detail failed/);
  assert.equal((await service.get(OWNER_ID, LIST_ID)).id, LIST_ID);
  assert.equal(reads, 2);
});
