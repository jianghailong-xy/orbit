import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { RunStatus as SharedRunStatus } from '@orbit/shared';
import { RunnerApiController } from './runner-api.controller';

function makeController(pendingExecutable: number, taskId: string | null = null) {
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const runnerId = '22222222-2222-4222-8222-222222222222';
  const session: {
    id: string;
    assignedRunnerId: string;
    status: RunStatus;
    taskId: string | null;
    cancelRequestedAt: null;
  } = {
    id: sessionId,
    assignedRunnerId: runnerId,
    status: RunStatus.RUNNING,
    taskId,
    cancelRequestedAt: null,
  };
  const statusWrites: RunStatus[] = [];
  let inboxWakes = 0;
  let queueWakes = 0;
  let retireCalls = 0;
  const tx = {
    $queryRaw: async () => [{ id: sessionId, leaseOwnerMatches: true }],
    $executeRaw: async () => {
      retireCalls++;
      return 1;
    },
    conversationTurn: {
      updateMany: async () => ({ count: 1 }),
      findUnique: async () => ({ kind: 'message' }),
      count: async () => pendingExecutable,
    },
    session: {
      findUniqueOrThrow: async () => ({
        status: session.status,
        taskId: session.taskId,
      }),
      findUnique: async () => ({ status: session.status }),
      updateMany: async ({ data }: { data: { status: RunStatus } }) => {
        statusWrites.push(data.status);
        session.status = data.status;
        return { count: 1 };
      },
      count: async () => 0,
    },
    task: {
      updateMany: async () => ({ count: 1 }),
      findUnique: async () => null,
    },
  };
  const prisma = {
    session: { findUnique: async () => ({ ...session }) },
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
  } as never;
  const realtime = {
    notifyInbox: () => inboxWakes++,
    publish: () => undefined,
  } as never;
  const queue = { notifySessionQueued: () => queueWakes++ } as never;
  return {
    controller: new RunnerApiController(prisma, queue, realtime, {} as never, {} as never),
    runnerId,
    sessionId,
    statusWrites,
    inboxWakes: () => inboxWakes,
    queueWakes: () => queueWakes,
    retireCalls: () => retireCalls,
  };
}

test('turn completion releases the slot when no executable follow-up is pending', async () => {
  const h = makeController(0);

  const result = await h.controller.turnComplete({ id: h.runnerId }, h.sessionId, {
    turnId: 'turn-1',
    status: SharedRunStatus.SUCCEEDED,
  });

  assert.deepEqual(result, { ok: true, status: RunStatus.AWAITING_INPUT });
  assert.deepEqual(h.statusWrites, [RunStatus.AWAITING_INPUT]);
  assert.equal(h.inboxWakes(), 1);
  assert.equal(h.queueWakes(), 1);
});

test('turn completion retains RUNNING while a follow-up can reuse the held slot', async () => {
  const h = makeController(1);

  const result = await h.controller.turnComplete({ id: h.runnerId }, h.sessionId, {
    turnId: 'turn-1',
    status: SharedRunStatus.SUCCEEDED,
  });

  assert.deepEqual(result, { ok: true, status: RunStatus.RUNNING });
  assert.deepEqual(h.statusWrites, [RunStatus.RUNNING]);
  assert.equal(h.inboxWakes(), 1);
  assert.equal(h.queueWakes(), 0);
});

test('a failed task turn retires its inbox generation in the terminal transaction', async () => {
  const h = makeController(0, '33333333-3333-4333-8333-333333333333');

  const result = await h.controller.turnComplete({ id: h.runnerId }, h.sessionId, {
    turnId: 'turn-1',
    status: SharedRunStatus.FAILED,
    result: 'provider failed',
  });

  assert.deepEqual(result, { ok: true, status: RunStatus.FAILED });
  assert.deepEqual(h.statusWrites, [RunStatus.FAILED]);
  assert.equal(h.retireCalls(), 1);
  assert.equal(h.inboxWakes(), 0);
});
