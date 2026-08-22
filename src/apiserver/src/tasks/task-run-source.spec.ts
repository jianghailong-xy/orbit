import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionDispatchOrigin, SessionRunSource } from '@prisma/client';
import { TasksService } from './tasks.service';

test('a fresh task run creates an Active-list session', async () => {
  const createCalls: unknown[][] = [];
  const prisma = {
    task: {
      findFirst: async () => ({
        id: 'task-1',
        title: 'Ship it',
        description: null,
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
    create: async (...args: unknown[]) => {
      createCalls.push(args);
      return { id: 'session-1' };
    },
  } as never;
  const service = new TasksService(prisma, sessions, {} as never);

  const result = await service.execute('owner-1', 'task-1');

  assert.deepEqual(result, { ok: true, sessionId: 'session-1' });
  assert.equal(createCalls.length, 1);
  assert.equal((createCalls[0][1] as { taskId?: string }).taskId, 'task-1');
  assert.deepEqual(createCalls[0][2], {
    source: 'user',
    batch: undefined,
    dispatchOrigin: SessionDispatchOrigin.USER,
    runSource: SessionRunSource.MANUAL,
    // §13.6 SU6: Run Now says on the row that it is starting the task's WORK, which is what lets
    // migration 0130's guard tell it apart from a session opened against the task to read it.
    startsTaskWork: true,
  });
});

test('an automatic Task List run carries distinct auditable provenance', async () => {
  const createCalls: unknown[][] = [];
  const prisma = {
    task: {
      findFirst: async () => ({
        id: 'task-1', title: 'Auto', description: null, status: 'OPEN', runAt: null,
        dispatchAuthority: 'LEGACY', dispatchHold: false,
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
    create: async (...args: unknown[]) => {
      createCalls.push(args);
      return { id: 'session-1' };
    },
  } as never;
  const service = new TasksService(prisma, sessions, {} as never);

  await service.execute('owner-1', 'task-1', { observedRunAt: null });

  assert.deepEqual(createCalls[0][2], {
    source: 'user',
    batch: undefined,
    dispatchOrigin: SessionDispatchOrigin.LEGACY_SWEEP,
    runSource: SessionRunSource.TASK_LIST_AUTO,
    startsTaskWork: true,
  });
});

test('legacy automatic dispatch stands down after Coordinator authority takes over', async () => {
  let creates = 0;
  const service = new TasksService({
    // §13.1 AG6 is judged before the authority stand-down — the role invariant holds the same
    // position at all three gates — so even this deliberately minimal row carries its two facts.
    task: {
      findFirst: async () => ({
        id: 'task-1', dispatchAuthority: 'COORDINATOR', completionPolicy: 'MANUAL', children: [],
      }),
    },
  } as never, { create: async () => { creates += 1; } } as never, {} as never);

  const result = await service.execute('owner-1', 'task-1', { observedRunAt: null });

  assert.deepEqual(result, { ok: false, skipped: 'coordinator-authority' });
  assert.equal(creates, 0);
});
