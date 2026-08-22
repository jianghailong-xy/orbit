import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TasksService } from './tasks.service';
import type { DependencyEdge } from './task-dependencies';

const TASK_A = '550e8400-e29b-41d4-a716-446655440000';
const TASK_B = '550e8400-e29b-41d4-a716-446655440001';
const TASK_C = '550e8400-e29b-41d4-a716-446655440002';

function taskServiceFixture(
  edges: DependencyEdge[] = [],
  ownedIds = new Set([TASK_A, TASK_B, TASK_C]),
) {
  const calls: string[] = [];
  let createdEdges: DependencyEdge[] = [];
  let dependencyReads = 0;
  const published: unknown[][] = [];

  const task = {
    count: async ({ where }: any) =>
      where.id.in.filter((id: string) => ownedIds.has(id)).length,
    update: async ({ where, data }: any) => {
      calls.push('update');
      return { id: where.id, title: data.title ?? 'Task A', status: data.status ?? 'OPEN' };
    },
    create: async ({ data }: any) => {
      calls.push('task-create');
      return { id: TASK_A, ...data };
    },
  };
  const taskDependency = {
    findMany: async () => {
      dependencyReads += 1;
      return edges;
    },
    deleteMany: async () => {
      calls.push('delete');
      return { count: edges.length };
    },
    createMany: async ({ data }: { data: DependencyEdge[] }) => {
      calls.push('create');
      createdEdges = data;
      return { count: data.length };
    },
    create: async ({ data }: { data: DependencyEdge }) => {
      calls.push('create');
      createdEdges = [data];
      return data;
    },
  };
  const prisma = {
    task,
    taskDependency,
    $transaction: async (fn: (tx: any) => Promise<unknown>) => {
      calls.push('transaction');
      return fn({
        task,
        taskDependency,
        // Labelled by what the statement is for, so the recorded sequence reads as the canonical
        // lock order (common/lock-order.ts): the owner graph mutex, then the creator Sessions
        // this task write will foreign-key check, then the writes.
        $queryRaw: async (strings: TemplateStringsArray) => {
          const sql = strings.join('?');
          calls.push(/creator_session_id/.test(sql) ? 'creator-sessions' : 'lock');
          return [{ id: 'owner' }];
        },
      });
    },
  };
  const service = new TasksService(
    prisma as never,
    {} as never,
    { publishForUser: (...args: unknown[]) => published.push(args) } as never,
  );
  (service as any).get = async () => ({
    id: TASK_A,
    title: 'Task A',
    status: 'OPEN',
    creatorSessionId: null,
  });

  return {
    service,
    calls,
    createdEdges: () => createdEdges,
    dependencyReads: () => dependencyReads,
    published,
  };
}

test('create publishes a task and its initial DAG edges in one owner-locked transaction', async () => {
  const fixture = taskServiceFixture();

  await fixture.service.create('owner', {
    title: 'Task A',
    dependsOnTaskIds: [TASK_B, TASK_C],
  });

  assert.deepEqual(fixture.calls, ['transaction', 'lock', 'task-create', 'create']);
  assert.deepEqual(fixture.createdEdges(), [
    { taskId: TASK_A, dependsOnTaskId: TASK_B },
    { taskId: TASK_A, dependsOnTaskId: TASK_C },
  ]);
});

test('update atomically replaces and deduplicates an existing task dependency set', async () => {
  const fixture = taskServiceFixture([{ taskId: TASK_A, dependsOnTaskId: TASK_B }]);

  await fixture.service.update('owner', TASK_A, {
    dependsOnTaskIds: [TASK_B, TASK_B, TASK_C],
  });

  assert.deepEqual(fixture.calls, [
    'transaction',
    'lock',
    'creator-sessions',
    'update',
    'delete',
    'create',
  ]);
  assert.deepEqual(fixture.createdEdges(), [
    { taskId: TASK_A, dependsOnTaskId: TASK_B },
    { taskId: TASK_A, dependsOnTaskId: TASK_C },
  ]);
  assert.deepEqual(fixture.published, [['owner', 'task_changed', TASK_A]]);
});

test('an empty dependency replacement clears all prerequisites', async () => {
  const fixture = taskServiceFixture([{ taskId: TASK_A, dependsOnTaskId: TASK_B }]);

  await fixture.service.update('owner', TASK_A, { dependsOnTaskIds: [] });

  assert.deepEqual(fixture.calls, ['transaction', 'lock', 'creator-sessions', 'update', 'delete']);
  assert.deepEqual(fixture.createdEdges(), []);
  assert.equal(fixture.dependencyReads(), 0);
  assert.deepEqual(fixture.published, [['owner', 'task_changed', TASK_A]]);
});

test('omitting dependsOnTaskIds leaves dependency rows untouched', async () => {
  const fixture = taskServiceFixture([{ taskId: TASK_A, dependsOnTaskId: TASK_B }]);

  await fixture.service.update('owner', TASK_A, { title: 'Renamed' });

  assert.deepEqual(fixture.calls, ['update']);
  assert.equal(fixture.dependencyReads(), 0);
  assert.deepEqual(fixture.published, []);
});

test('dependency replacement rejects self-dependencies and cycles before writing', async () => {
  const self = taskServiceFixture();
  await assert.rejects(
    self.service.update('owner', TASK_A, { dependsOnTaskIds: [TASK_A] }),
    /cannot depend on itself/,
  );
  assert.deepEqual(self.calls, []);

  const cycle = taskServiceFixture([{ taskId: TASK_B, dependsOnTaskId: TASK_A }]);
  await assert.rejects(
    cycle.service.update('owner', TASK_A, { dependsOnTaskIds: [TASK_B] }),
    /would create a cycle/,
  );
  assert.deepEqual(cycle.calls, ['transaction', 'lock', 'creator-sessions']);
});

test('dependency replacement rejects a task outside the owner scope', async () => {
  const fixture = taskServiceFixture([], new Set([TASK_A, TASK_B]));
  await assert.rejects(
    fixture.service.update('owner', TASK_A, { dependsOnTaskIds: [TASK_C] }),
    /task not found/,
  );
  assert.deepEqual(fixture.calls, []);
});

// Both sides fire `task_dependency_dispatch_touch`, which re-writes the dependent Task and
// therefore re-checks `task_creator_session_id_fkey` — so both take the same rank-30 pre-lock
// ahead of the edge write, not just the same rank-10 mutex (common/lock-order.ts, I2).
test('single-edge add and remove use the same owner-scoped graph lock', async () => {
  const add = taskServiceFixture();
  await add.service.addDependency('owner', TASK_A, TASK_B);
  assert.deepEqual(add.calls, ['transaction', 'lock', 'creator-sessions', 'create']);
  assert.deepEqual(add.published, [['owner', 'task_changed', TASK_A]]);

  const remove = taskServiceFixture([{ taskId: TASK_A, dependsOnTaskId: TASK_B }]);
  await remove.service.removeDependency('owner', TASK_A, TASK_B);
  assert.deepEqual(remove.calls, ['transaction', 'lock', 'creator-sessions', 'delete']);
  assert.deepEqual(remove.published, [['owner', 'task_changed', TASK_A]]);
});
