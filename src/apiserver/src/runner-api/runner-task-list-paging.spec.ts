import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Runner } from '@prisma/client';
import { TasksService } from '../tasks/tasks.service';
import { TaskListsService } from '../task-lists/task-lists.service';
import { RunnerTasksController } from './runner-tasks.controller';

// `orbit task list` used to filter client-side, so every call downloaded the owner's entire task
// history — descriptions included. On a heavy account that is tens of megabytes per call: slow
// enough to be truncated mid-body ("unexpected end of JSON input") and large enough to flood the
// calling agent's context. The filters have to run in the database.

const OWNER = '22222222-2222-4222-8222-222222222222';
const runner = { id: 'r1', ownerId: OWNER } as Runner;

function harness() {
  const calls: { list: number; page: Record<string, unknown>[] } = { list: 0, page: [] };
  const tasks = {
    list: async () => {
      calls.list += 1;
      return [{ id: 'everything' }];
    },
    listPage: async (_ownerId: string, query: Record<string, unknown>) => {
      calls.page.push(query);
      return { items: [{ id: 'page' }], nextCursor: null };
    },
  } as unknown as TasksService;
  const controller = new RunnerTasksController(tasks, {} as TaskListsService);
  return { controller, calls };
}

test('a filtered list is answered by the page query, not by loading every task', async () => {
  const { controller, calls } = harness();

  const filtered = await controller.listTasks(runner, 'OPEN', 'list-1', '50');

  assert.deepEqual(filtered, [{ id: 'page' }]);
  assert.equal(calls.list, 0);
  assert.deepEqual(calls.page, [
    { status: 'OPEN', listId: 'list-1', limit: '50', counts: 'none' },
  ]);
});

test('a limit alone is enough to take the page query', async () => {
  const { controller, calls } = harness();

  await controller.listTasks(runner, undefined, undefined, '100');

  assert.equal(calls.list, 0);
  assert.equal(calls.page.length, 1);
});

// Runners older than these filters filter client-side, so they must keep receiving the whole list
// rather than a page they would silently treat as complete.
test('a caller that asks for nothing still gets the full list', async () => {
  const { controller, calls } = harness();

  const all = await controller.listTasks(runner);

  assert.deepEqual(all, [{ id: 'everything' }]);
  assert.equal(calls.list, 1);
  assert.equal(calls.page.length, 0);
});
