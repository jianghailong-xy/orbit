import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TasksService } from './tasks.service';
import { TASK_BATCH_CREATE_MAX, type CreateTaskBatchItemDto } from './dto';

const OWNER = '11111111-1111-4111-8111-111111111111';
const EXISTING_TASK = '22222222-2222-4222-8222-222222222222';

type Written = { id: string; data: Record<string, unknown> };

function makeService(options: { ownedTasks?: string[] } = {}) {
  const created: Written[] = [];
  const edges: Array<{ taskId: string; dependsOnTaskId: string }> = [];
  const owned = new Set(options.ownedTasks ?? [EXISTING_TASK]);
  const tx = {
    $queryRaw: async () => [],
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
    agent: { findFirst: async () => ({ id: 'agent-1' }) },
    taskList: { findFirst: async () => ({ id: 'list-1' }) },
    modelProvider: { findFirst: async () => ({ slug: 'custom' }) },
    session: { findFirst: async () => null },
    task: {
      count: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => owned.has(id)).length,
    },
  } as never;
  const service = new TasksService(prisma, {} as never, {
    publishTaskChanged: () => {},
  } as never);
  return { service, created, edges };
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
