import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { TasksService } from './tasks.service';

const TASK_ID = '550e8400-e29b-41d4-a716-446655440000';
const LIST_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/**
 * A task whose list carries dispatch policy. `execute` is the path both the manual Run button
 * and the auto-run sweep take, so what the list says has to be honoured here — these tests
 * assert the two things it can say: don't dispatch at all, and don't dispatch more than N at a
 * time.
 *
 * "Don't dispatch at all" is read off the task's own `dispatchHold`, not off `list.paused`:
 * pausing a list projects the hold onto its tasks precisely so that permission never depends on
 * a list row that can be deleted.
 */
function runFixture(
  list: { maxConcurrent?: number | null } | null,
  task: { dispatchHold?: boolean } = {},
) {
  const createCalls: any[][] = [];
  const prisma = {
    task: {
      findFirst: async () => ({
        id: TASK_ID,
        title: 'Download the WARCs',
        description: null,
        provider: null,
        model: null,
        status: 'OPEN',
        listId: list ? LIST_ID : null,
        dispatchHold: task.dispatchHold ?? false,
        list: list ? { maxConcurrent: null, ...list } : null,
        // §13.1 AG6's two facts. Every task in this fixture is an ordinary leaf; the
        // aggregate-parent gate has its own coverage in `task-aggregate-parent-execute.spec.ts`.
        completionPolicy: 'MANUAL',
        children: [],
        assignee: { id: 'workspace-1', runnerId: 'runner-1' },
      }),
    },
    taskDependency: { findMany: async () => [] },
    session: { findFirst: async () => null },
  } as never;
  const sessions = {
    create: async (...args: any[]) => {
      createCalls.push(args);
      return { id: 'session-new' };
    },
  } as never;
  const service = new TasksService(prisma, sessions, {} as never);
  return { service, createCalls };
}

/** The `{ source, batch }` options object sessions.create() was called with. */
const optsOf = (calls: any[][]) => calls[0][2];

test('a held task is refused, so the stop cannot be clicked around', async () => {
  const f = runFixture({}, { dispatchHold: true });

  await assert.rejects(
    () => f.service.execute('owner-1', TASK_ID),
    (e: unknown) => e instanceof BadRequestException,
  );
  assert.equal(f.createCalls.length, 0);
});

test('a capped list dispatches its runs as a batch keyed by the list itself', async () => {
  // The list id *is* the batch id: that makes the cap durable across sweeps, where a batch id
  // minted per dispatch would cap nothing (every run its own batch of one).
  const f = runFixture({ maxConcurrent: 3 });

  await f.service.execute('owner-1', TASK_ID);

  assert.deepEqual(optsOf(f.createCalls).batch, { id: LIST_ID, maxConcurrent: 3 });
});

test('an uncapped list sends no batch at all', async () => {
  // Not `{ id: LIST_ID, maxConcurrent: null }`: the claim gate reads `count(*) < max_concurrent`,
  // and comparing against NULL yields NULL, so such a session would never be claimed by anyone.
  const f = runFixture({ maxConcurrent: null });

  await f.service.execute('owner-1', TASK_ID);

  assert.equal(optsOf(f.createCalls).batch, undefined);
});

test('a task belonging to no list is unaffected', async () => {
  const f = runFixture(null);

  await f.service.execute('owner-1', TASK_ID);

  assert.equal(optsOf(f.createCalls).batch, undefined);
});
