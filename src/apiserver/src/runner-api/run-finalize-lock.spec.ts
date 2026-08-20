import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { RunStatus as SharedRunStatus, SessionEndReason } from '@orbit/shared';
import { RunnerApiController } from './runner-api.controller';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';

type LockedSnapshot = {
  id: string;
  assignedRunnerId: string;
  status: RunStatus;
  taskId: string | null;
  cancelRequestedAt: Date | null;
  endReason: SessionEndReason | null;
  completedAt: Date | null;
  archivedAt: Date | null;
  deletedAt: Date | null;
};

function makeController(current: LockedSnapshot) {
  // Simulate the stale ownership fast-read happening before archive/remove/reaper wins.
  const stale = {
    ...current,
    taskId: 'stale-task',
    cancelRequestedAt: null,
    endReason: null,
    completedAt: null,
    archivedAt: null,
    deletedAt: null,
  };
  const order: string[] = [];
  const statusWrites: RunStatus[] = [];
  const taskCountIds: string[] = [];
  const taskUpdateIds: string[] = [];
  const publishedStatuses: RunStatus[] = [];
  let retireCalls = 0;
  const tx = {
    $queryRaw: async () => {
      order.push('lock');
      return [{ id: SESSION_ID, leaseOwnerMatches: true }];
    },
    $executeRaw: async () => {
      retireCalls++;
      return 1;
    },
    session: {
      findUniqueOrThrow: async () => {
        order.push('read');
        return current;
      },
      updateMany: async ({ data }: { data: { status: RunStatus } }) => {
        order.push('update');
        statusWrites.push(data.status);
        return { count: 1 };
      },
      count: async ({ where }: { where: { taskId: string } }) => {
        taskCountIds.push(where.taskId);
        return 0;
      },
    },
    conversationTurn: {
      updateMany: async () => ({ count: 1 }),
      findFirst: async () => null,
    },
    task: {
      updateMany: async ({ where }: { where: { id: string } }) => {
        taskUpdateIds.push(where.id);
        return { count: 1 };
      },
    },
  };
  const prisma = {
    session: { findUnique: async () => stale },
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
  } as never;
  const realtime = {
    publish: (_id: string, event: { payload: { status: RunStatus } }) => {
      publishedStatuses.push(event.payload.status);
    },
  } as never;
  return {
    controller: new RunnerApiController(prisma, {} as never, realtime, {} as never, {} as never, {} as never, { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never),
    order,
    statusWrites,
    taskCountIds,
    taskUpdateIds,
    publishedStatuses,
    retireCalls: () => retireCalls,
  };
}

for (const lifecycleChange of [
  {
    name: 'complete',
    reason: SessionEndReason.COMPLETED,
    completedAt: new Date('2026-08-01T10:00:00.000Z'),
    archivedAt: null,
    deletedAt: null,
  },
  {
    name: 'remove',
    reason: SessionEndReason.DELETED,
    completedAt: null,
    archivedAt: null,
    deletedAt: new Date('2026-08-01T10:00:00.000Z'),
  },
] as const) {
  test(`finalize honors a concurrent ${lifecycleChange.name} from the locked snapshot`, async () => {
    const h = makeController({
      id: SESSION_ID,
      assignedRunnerId: RUNNER_ID,
      status: RunStatus.AWAITING_INPUT,
      taskId: null,
      cancelRequestedAt: new Date('2026-08-01T10:00:00.000Z'),
      endReason: lifecycleChange.reason,
      completedAt: lifecycleChange.completedAt,
      archivedAt: lifecycleChange.archivedAt,
      deletedAt: lifecycleChange.deletedAt,
    });

    const response = await h.controller.finalize({ id: RUNNER_ID }, SESSION_ID, { status: SharedRunStatus.SUCCEEDED });

    assert.deepEqual(response, { ok: true, keepCheckout: false });
    assert.deepEqual(h.order.slice(0, 3), ['lock', 'read', 'update']);
    assert.deepEqual(h.statusWrites, [RunStatus.CANCELLED]);
    assert.equal(h.retireCalls(), 1);
    assert.deepEqual(h.publishedStatuses, [RunStatus.CANCELLED]);
  });
}

test('finalize honors task_cancelled and reclaims the task from the locked snapshot', async () => {
  const h = makeController({
    id: SESSION_ID,
    assignedRunnerId: RUNNER_ID,
    status: RunStatus.AWAITING_INPUT,
    taskId: 'current-task',
    cancelRequestedAt: new Date('2026-08-01T10:00:00.000Z'),
    endReason: SessionEndReason.TASK_CANCELLED,
    completedAt: null,
    archivedAt: null,
    deletedAt: null,
  });

  const response = await h.controller.finalize({ id: RUNNER_ID }, SESSION_ID, {
    status: SharedRunStatus.SUCCEEDED,
  });

  assert.deepEqual(response, { ok: true, keepCheckout: true });
  assert.deepEqual(h.statusWrites, [RunStatus.CANCELLED]);
  assert.equal(h.retireCalls(), 1);
  assert.deepEqual(h.taskCountIds, ['current-task']);
  assert.deepEqual(h.taskUpdateIds, ['current-task']);
  assert.deepEqual(h.publishedStatuses, [RunStatus.CANCELLED]);
});

test('finalize preserves a completed task run and releases its checkout', async () => {
  const h = makeController({
    id: SESSION_ID,
    assignedRunnerId: RUNNER_ID,
    status: RunStatus.AWAITING_INPUT,
    taskId: 'current-task',
    cancelRequestedAt: new Date('2026-08-01T10:00:00.000Z'),
    endReason: SessionEndReason.TASK_DONE,
    completedAt: new Date('2026-08-01T10:00:00.000Z'),
    archivedAt: new Date('2026-08-01T10:00:00.000Z'),
    deletedAt: null,
  });

  const response = await h.controller.finalize(
    { id: RUNNER_ID },
    SESSION_ID,
    { status: SharedRunStatus.SUCCEEDED },
  );

  assert.deepEqual(response, { ok: true, keepCheckout: false });
  assert.deepEqual(h.statusWrites, [RunStatus.SUCCEEDED]);
  assert.equal(h.retireCalls(), 1);
  assert.deepEqual(h.taskCountIds, []);
  assert.deepEqual(h.taskUpdateIds, []);
  assert.deepEqual(h.publishedStatuses, [RunStatus.SUCCEEDED]);
});
