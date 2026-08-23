import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionDispatchOrigin, SessionRunSource } from '@prisma/client';
import { TasksService } from './tasks.service';
import { fakeReceiptStore } from './task-run-receipt-fake';
import { taskRunDesiredSessionId, taskRunRequestKey } from './task-run-identity';

test('a fresh task run creates an Active-list session', async () => {
  const createCalls: unknown[][] = [];
  const prisma = {
    // Every run door opens its receipt (0137) before anything else.
    ...fakeReceiptStore(),
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
    // A paused run's delivery is read by its own turn key before it is written (H2F).
    conversationTurn: { findUnique: async () => null },
    session: {
      // The door reads THIS request's own Session by id before it writes (H2F).
      findUnique: async () => null, findFirst: async () => null },
  } as never;
  const sessions = {
    create: async (...args: unknown[]) => {
      createCalls.push(args);
      return { id: 'session-1' };
    },
  } as never;
  const service = new TasksService(prisma, sessions, {} as never);

  const result = await service.execute('owner-1', 'task-1', undefined, 'press-1');

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
    // H2F: the run is created UNDER A NAME derived from the press this call carries, so a client
    // that repeats a request it never got an answer to finds this row instead of searching for it.
    // Asserted as the value the token derives, not merely as "some id", which a random one passes.
    id: taskRunDesiredSessionId(taskRunRequestKey({
      taskId: 'task-1', requestToken: 'press-1',
    })),
    // The right to make this write, presented AT the write: the insert happens inside a
    // transaction that first takes the receipt row and proves it is still BOUND to this holder and
    // attempt, so a lease taken over mid-flight cannot still commit a Session.
    fence: {
      ownerId: 'owner-1', actionKind: 'TASK_EXECUTE', requestToken: 'press-1',
      leaseHolder: (createCalls[0][2] as { fence: { leaseHolder: string } }).fence.leaseHolder, attempt: 1,
    },
  });
});

test('an automatic Task List run carries distinct auditable provenance', async () => {
  const createCalls: unknown[][] = [];
  const prisma = {
    // Every run door opens its receipt (0137) before anything else.
    ...fakeReceiptStore(),
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
    session: {
      // The door reads THIS request's own Session by id before it writes (H2F).
      findUnique: async () => null, findFirst: async () => null },
  } as never;
  const sessions = {
    create: async (...args: unknown[]) => {
      createCalls.push(args);
      return { id: 'session-1' };
    },
  } as never;
  const service = new TasksService(prisma, sessions, {} as never);

  await service.execute('owner-1', 'task-1', { observedEpoch: 0n }, 'sweep-tick-1');

  assert.deepEqual(createCalls[0][2], {
    source: 'user',
    batch: undefined,
    dispatchOrigin: SessionDispatchOrigin.LEGACY_SWEEP,
    runSource: SessionRunSource.TASK_LIST_AUTO,
    startsTaskWork: true,
    // The sweep names its request exactly as the button does: one rule, both doors. Its token is
    // the moment it acted on — the `task_dispatch_epoch` its candidate scan read.
    id: taskRunDesiredSessionId(taskRunRequestKey({
      taskId: 'task-1', requestToken: 'sweep-tick-1',
    })),
    fence: {
      ownerId: 'owner-1', actionKind: 'TASK_EXECUTE', requestToken: 'sweep-tick-1',
      leaseHolder: (createCalls[0][2] as { fence: { leaseHolder: string } }).fence.leaseHolder, attempt: 1,
    },
  });
});

test('legacy automatic dispatch stands down after Coordinator authority takes over', async () => {
  let creates = 0;
  const service = new TasksService({
    // Every run door opens its receipt (0137) before anything else, and a stand-down RELEASES it
    // rather than freezing — the same durable fact arriving later must be able to evaluate again.
    ...fakeReceiptStore(),
    // §13.1 AG6 is judged before the authority stand-down — the role invariant holds the same
    // position at all three gates — so even this deliberately minimal row carries its two facts.
    task: {
      findFirst: async () => ({
        id: 'task-1', dispatchAuthority: 'COORDINATOR', completionPolicy: 'MANUAL', children: [],
      }),
    },
  } as never, { create: async () => { creates += 1; } } as never, {} as never);

  const result = await service.execute('owner-1', 'task-1', { observedEpoch: 0n });

  assert.deepEqual(result, { ok: false, skipped: 'coordinator-authority' });
  assert.equal(creates, 0);
});
