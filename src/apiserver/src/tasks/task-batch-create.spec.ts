import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TasksService } from './tasks.service';
import { TASK_BATCH_CREATE_MAX, type CreateTaskBatchItemDto } from './dto';

const OWNER = '11111111-1111-4111-8111-111111111111';
const EXISTING_TASK = '22222222-2222-4222-8222-222222222222';
const PROJECT = '33333333-3333-4333-8333-333333333333';
const OTHER_PROJECT = '44444444-4444-4444-8444-444444444444';

type Written = { id: string; data: Record<string, unknown> };

function makeService(options: { ownedTasks?: string[]; pausedLists?: string[] } = {}) {
  const paused = new Set(options.pausedLists ?? []);
  const created: Written[] = [];
  const edges: Array<{ taskId: string; dependsOnTaskId: string }> = [];
  const owned = new Set(options.ownedTasks ?? [EXISTING_TASK]);
  const locks: string[] = [];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      // The owner lock is the only raw statement this path issues; recorded so a test can assert
      // whether a batch took it at all.
      if (/FOR UPDATE/i.test(strings.join(''))) locks.push('lock');
      return [];
    },
    task: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `task-${created.length}`, ...data };
        created.push({ id: row.id, data });
        return row;
      },
    },
    taskDependency: {
      createMany: async ({ data }: { data: Array<{ taskId: string; dependsOnTaskId: string }> }) => {
        edges.push(...data);
        return { count: data.length };
      },
    },
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    workspace: { findFirst: async () => ({ id: 'workspace-1' }), findMany: async () => [] },
    taskList: {
      findFirst: async () => ({ id: 'list-1' }),
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => paused.has(id)).map((id) => ({ id })),
    },
    modelProvider: { findFirst: async () => ({ slug: 'custom' }), findMany: async () => [] },
    project: {
      findFirst: async ({ where }: { where: { id: string } }) => ({ id: where.id }),
      findMany: async () => [],
    },
    projectHandoffApproval: { findFirst: async () => null },
    session: { findFirst: async () => null },
    task: {
      count: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => owned.has(id)).length,
    },
  } as never;
  const service = new TasksService(prisma, {} as never, {
    publishTaskChanged: () => {},
  } as never);
  return { service, created, edges, locks };
}

const item = (over: Partial<CreateTaskBatchItemDto>): CreateTaskBatchItemDto =>
  ({ title: 'T', ...over }) as CreateTaskBatchItemDto;

test('createMany writes every task in input order and echoes each ref', async () => {
  const { service, created } = makeService();
  const tasks = await service.createMany(OWNER, {
    tasks: [item({ title: 'first', ref: 's0' }), item({ title: 'second' })],
  });

  assert.deepEqual(
    created.map((row) => row.data.title),
    ['first', 'second'],
  );
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].ref, 's0');
  assert.equal(tasks[1].ref, undefined);
  assert.equal(created[0].data.ownerId, OWNER);
});

test('a ref resolves to the id of the earlier task created in the same batch', async () => {
  const { service, edges } = makeService();
  const tasks = await service.createMany(OWNER, {
    tasks: [
      item({ ref: 's0' }),
      item({ ref: 's1', dependsOnRefs: ['s0'] }),
      item({ dependsOnRefs: ['s0', 's1'] }),
    ],
  });

  assert.deepEqual(edges, [
    { taskId: tasks[1].id, dependsOnTaskId: tasks[0].id },
    { taskId: tasks[2].id, dependsOnTaskId: tasks[0].id },
    { taskId: tasks[2].id, dependsOnTaskId: tasks[1].id },
  ]);
});

test('refs combine with dependsOnTaskIds on tasks that already exist', async () => {
  const { service, edges } = makeService();
  const tasks = await service.createMany(OWNER, {
    tasks: [item({ ref: 's0' }), item({ dependsOnRefs: ['s0'], dependsOnTaskIds: [EXISTING_TASK] })],
  });

  assert.deepEqual(edges, [
    { taskId: tasks[1].id, dependsOnTaskId: EXISTING_TASK },
    { taskId: tasks[1].id, dependsOnTaskId: tasks[0].id },
  ]);
});

test('a forward ref is rejected before anything is written', async () => {
  const { service, created } = makeService();
  await assert.rejects(
    service.createMany(OWNER, {
      tasks: [item({ ref: 's0', dependsOnRefs: ['s1'] }), item({ ref: 's1' })],
    }),
    /must name an earlier task in this batch/,
  );
  assert.deepEqual(created, []);
});

test('an unknown ref is rejected', async () => {
  const { service, created } = makeService();
  await assert.rejects(
    service.createMany(OWNER, { tasks: [item({ dependsOnRefs: ['nope'] })] }),
    /must name an earlier task in this batch/,
  );
  assert.deepEqual(created, []);
});

test('duplicate refs are rejected', async () => {
  const { service, created } = makeService();
  await assert.rejects(
    service.createMany(OWNER, { tasks: [item({ ref: 's0' }), item({ ref: 's0' })] }),
    /duplicate ref/,
  );
  assert.deepEqual(created, []);
});

test('a prerequisite the caller does not own fails the whole batch', async () => {
  const { service, created } = makeService({ ownedTasks: [] });
  await assert.rejects(
    service.createMany(OWNER, {
      tasks: [item({}), item({ dependsOnTaskIds: [EXISTING_TASK] })],
    }),
    /task not found/,
  );
  assert.deepEqual(created, []);
});

test('an empty or oversized batch is rejected', async () => {
  const { service } = makeService();
  await assert.rejects(service.createMany(OWNER, { tasks: [] }), /tasks is required/);
  await assert.rejects(
    service.createMany(OWNER, {
      tasks: Array.from({ length: TASK_BATCH_CREATE_MAX + 1 }, () => item({})),
    }),
    new RegExp(`at most ${TASK_BATCH_CREATE_MAX} tasks`),
  );
});

test('a task filed into a paused list is born held', async () => {
  const { service, created } = makeService({ pausedLists: ['list-paused'] });

  await service.createMany(OWNER, {
    tasks: [
      item({ title: 'into the paused list', listId: 'list-paused' }),
      item({ title: 'into a running list', listId: 'list-open' }),
      item({ title: 'no list at all' }),
    ],
  });

  // Otherwise "pause the list" means "pause the tasks that happened to exist when I clicked",
  // and a campaign still being written keeps dispatching around its own stop — which is exactly
  // what a batch create into a paused list is.
  assert.deepEqual(
    created.map((row) => row.data.dispatchHold),
    [true, false, false],
  );
});

// A parent named inside the batch. `ref` already lets a batch express ordering between items it
// creates; `parentRef` is the other axis — what a decomposition needs, since a plan's steps are
// parts of the thing being planned and their parent's id does not exist until this same call
// writes it. Ordering (dependsOnRefs) and membership (parentRef) stay separate: one says when a
// task may run, the other says what it is a part of.

test('parentRef hangs an item under an earlier item of the same batch', async () => {
  const { service, created } = makeService();
  const tasks = await service.createMany(OWNER, {
    tasks: [
      item({ title: 'epic', ref: 'epic' }),
      item({ title: 'step', parentRef: 'epic' }),
      item({ title: 'substep', ref: 'step', parentRef: 'epic' }),
    ],
  });

  // Three levels in one call is the shape this exists for: the tree is written top-down, so every
  // parent id is known by the time the row naming it is created.
  assert.deepEqual(
    created.map((row) => row.data.parentTaskId),
    [undefined, tasks[0].id, tasks[0].id],
  );
});

test('parentRef and dependsOnRefs are separate axes on the same batch', async () => {
  const { service, created, edges } = makeService();
  const tasks = await service.createMany(OWNER, {
    tasks: [
      item({ title: 'epic', ref: 'epic' }),
      item({ title: 'first', ref: 's0', parentRef: 'epic' }),
      item({ title: 'second', parentRef: 'epic', dependsOnRefs: ['s0'] }),
    ],
  });

  // Being part of something is not waiting for it: the parent link writes no dependency edge, and
  // the one edge here is the one the caller actually asked for.
  assert.deepEqual(edges, [{ taskId: tasks[2].id, dependsOnTaskId: tasks[1].id }]);
  assert.deepEqual(
    created.map((row) => row.data.parentTaskId),
    [undefined, tasks[0].id, tasks[0].id],
  );
});

test('a forward or unknown parentRef is rejected before anything is written', async () => {
  const { service, created } = makeService();
  await assert.rejects(
    service.createMany(OWNER, {
      tasks: [item({ title: 'step', parentRef: 'epic' }), item({ title: 'epic', ref: 'epic' })],
    }),
    /parentRef "epic" must name an earlier task in this batch/,
  );
  await assert.rejects(
    service.createMany(OWNER, { tasks: [item({ parentRef: 'nope' })] }),
    /parentRef "nope" must name an earlier task in this batch/,
  );
  assert.deepEqual(created, []);
});

test('naming both parentRef and parentTaskId is naming two parents', async () => {
  const { service, created } = makeService();
  await assert.rejects(
    service.createMany(OWNER, {
      tasks: [item({ ref: 'epic' }), item({ parentRef: 'epic', parentTaskId: EXISTING_TASK })],
    }),
    /parentRef and parentTaskId name two different parents/,
  );
  assert.deepEqual(created, []);
});

test('an item cannot be filed under a parent in another project', async () => {
  const { service, created } = makeService();
  await assert.rejects(
    service.createMany(OWNER, {
      tasks: [
        item({ title: 'epic', ref: 'epic', projectId: PROJECT }),
        item({ title: 'step', parentRef: 'epic', projectId: OTHER_PROJECT }),
      ],
    }),
    /must be in the same project as its parent task/,
  );
  // The same rule read the other way: a subtask that names no project at all is not in its
  // parent's project either, and inheriting one silently is how a project's task tree comes to
  // contain work the project never claimed.
  await assert.rejects(
    service.createMany(OWNER, {
      tasks: [
        item({ title: 'epic', ref: 'epic', projectId: PROJECT }),
        item({ title: 'step', parentRef: 'epic' }),
      ],
    }),
    /must be in the same project as its parent task/,
  );
  assert.deepEqual(created, []);
});

test('a batch whose parents are all internal refs still takes the owner lock', async () => {
  const { service, locks } = makeService();
  await service.createMany(OWNER, {
    tasks: [item({ ref: 'epic' }), item({ parentRef: 'epic' })],
  });

  // The lock used to be conditional, because the race it was reasoned about — a parent read here
  // being moved into another project before the child referencing it is written — cannot happen
  // when the parent is a row this transaction is itself creating.
  //
  // It is unconditional now for a different reason: a batch writes several `task` rows in item
  // order, which is not an order any other writer shares, and rank 10 of the canonical lock order
  // (common/lock-order.ts, I1) is what keeps two multi-row Task writes from taking the same rows
  // in opposite orders. The hierarchy CHECK is still skipped — that is what refs make unnecessary.
  assert.deepEqual(locks, ['lock']);
});
