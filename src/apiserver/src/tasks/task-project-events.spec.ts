import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Sql } from '@prisma/client/runtime/library';
import { TasksService } from './tasks.service';

const OWNER = '00000000-0000-7000-8000-000000000801';
const PROJECT_A = '00000000-0000-7000-8000-000000000802';
const PROJECT_B = '00000000-0000-7000-8000-000000000803';

function runnableTask(id: string, projectId: string) {
  return {
    id,
    title: `Task ${id}`,
    description: null,
    projectId,
    provider: null,
    model: null,
    status: 'OPEN',
    listId: null,
    list: null,
    isForeman: false,
    verifiesTaskId: null,
    dispatchHold: false,
    runAt: null,
    assignee: { id: `workspace-${id}`, runnerId: 'runner-1' },
  };
}

function eventFixture(tasks: ReturnType<typeof runnableTask>[]) {
  const eventWrites: Sql[] = [];
  let transactions = 0;
  const tx = {
    $executeRaw: async (query: Sql) => {
      eventWrites.push(query);
      return 1;
    },
  };
  const prisma = {
    task: {
      findFirst: async () => tasks[0] ?? null,
      findMany: async () => tasks,
    },
    taskDependency: { findMany: async () => [] },
    session: {
      findFirst: async () => null,
      findMany: async () => [],
    },
    $transaction: async (run: (transaction: typeof tx) => Promise<unknown>) => {
      transactions += 1;
      return run(tx);
    },
  } as never;
  const sessions = { create: async () => ({ id: 'session-1' }) } as never;
  const service = new TasksService(prisma, sessions, {} as never);
  return { service, eventWrites, transactions: () => transactions };
}

test('manual Project task starts persist a request before dispatch; automatic starts do not', async () => {
  const manual = eventFixture([runnableTask('task-1', PROJECT_A)]);
  await manual.service.execute(OWNER, 'task-1');

  assert.equal(manual.transactions(), 1);
  assert.equal(manual.eventWrites.length, 1);
  assert.deepEqual(manual.eventWrites[0].values.slice(0, 2), [PROJECT_A, OWNER]);

  const automatic = eventFixture([runnableTask('task-1', PROJECT_A)]);
  await automatic.service.execute(OWNER, 'task-1', { observedRunAt: null });

  assert.equal(automatic.transactions(), 0);
  assert.equal(automatic.eventWrites.length, 0);
});

test('one bulk Run writes one manual request per distinct affected Project in one transaction', async () => {
  const fixture = eventFixture([
    runnableTask('task-1', PROJECT_A),
    runnableTask('task-2', PROJECT_A),
    runnableTask('task-3', PROJECT_B),
  ]);
  (fixture.service as unknown as { runWorkspaceOnTask: () => Promise<string> }).runWorkspaceOnTask =
    async () => 'session-1';

  const result = await fixture.service.batchExecute(OWNER, ['task-1', 'task-2', 'task-3']);

  assert.equal(result.dispatched, 3);
  assert.equal(fixture.transactions(), 1);
  assert.deepEqual(
    fixture.eventWrites.map((query) => query.values.slice(0, 2)),
    [
      [PROJECT_A, OWNER],
      [PROJECT_B, OWNER],
    ],
  );
  assert.equal(fixture.eventWrites[0].values[2], fixture.eventWrites[1].values[2]);
});
