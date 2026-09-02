import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { RunStatus as SharedRunStatus } from '@orbit/shared';
import { buildCoordinatorDeliveryContextKey } from '../projects/coordinator-opening';
import { currentWorkTerminalizationDouble } from '../test-support/prisma-transaction-double';
import { RunnerApiController } from './runner-api.controller';

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const LEASE_GENERATION = '44444444-4444-4444-8444-444444444444';

function makeController(
  pendingExecutable: number,
  taskId: string | null = null,
  coordinatorContextKey: string | null = null,
  turnLeaseGeneration = LEASE_GENERATION,
  coordinatorContextEpoch = 0,
) {
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
  const sessionWrites: Record<string, unknown>[] = [];
  let inboxWakes = 0;
  let queueWakes = 0;
  let retireCalls = 0;
  const taskChanges: string[] = [];
  const sessionUpdates: string[] = [];
  const currentWork = currentWorkTerminalizationDouble({
    onConversationTurnUpdateMany: async () => ({ count: 1 }),
  });
  const tx = {
    $queryRaw: async () => [{ id: sessionId, leaseOwnerMatches: true }],
    $executeRaw: async () => {
      retireCalls++;
      return 1;
    },
    conversationTurn: {
      ...currentWork.conversationTurn,
      findUnique: async () => ({ kind: 'message' }),
      count: async () => pendingExecutable,
      findFirst: async (args: { where: { kind?: string } }) =>
        args.where.kind
          ? null
          : {
              id: 'turn-1',
              kind: 'message',
              clientTurnId: 'client-turn-1',
              content: 'hello',
              leaseGeneration: turnLeaseGeneration,
              coordinatorContextKey,
          },
    },
    session: {
      findUniqueOrThrow: async () => ({
        status: session.status,
        taskId: session.taskId,
        inboxLeaseGeneration: LEASE_GENERATION,
        coordinatorContextEpoch,
        coordinatorForProject: coordinatorContextKey ? { id: PROJECT_ID } : null,
      }),
      findUnique: async () => ({ status: session.status }),
      updateMany: async ({ data }: { data: { status: RunStatus } }) => {
        statusWrites.push(data.status);
        sessionWrites.push(data);
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
    publishSessionUpdated: (changedSessionId: string) =>
      void sessionUpdates.push(changedSessionId),
    publishTaskChanged: (_sessionId: string, changedTaskId: string) =>
      void taskChanges.push(changedTaskId),
  } as never;
  const queue = { notifySessionQueued: () => queueWakes++ } as never;
  return {
    controller: new RunnerApiController(prisma, queue, realtime, {} as never, {} as never, {} as never, { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never),
    runnerId,
    sessionId,
    statusWrites,
    sessionWrites,
    inboxWakes: () => inboxWakes,
    queueWakes: () => queueWakes,
    retireCalls: () => retireCalls,
    taskChanges,
    sessionUpdates,
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
  assert.deepEqual(h.sessionUpdates, [h.sessionId]);
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
  assert.deepEqual(h.sessionUpdates, [h.sessionId]);
});

test('turn completion persists a healed base with the clean snapshot omitted by legacy encoding', async () => {
  const h = makeController(0);
  const baseSha = 'a'.repeat(40);

  await h.controller.turnComplete({ id: h.runnerId }, h.sessionId, {
    turnId: 'turn-1',
    status: SharedRunStatus.SUCCEEDED,
    baseSha,
  });

  assert.equal(h.sessionWrites.length, 1);
  assert.equal(h.sessionWrites[0].baseSha, baseSha);
  assert.deepEqual(h.sessionWrites[0].changedFiles, []);
});

test('a successful stamped turn acknowledges coordinator context in the existing park write', async () => {
  const contextKey = buildCoordinatorDeliveryContextKey(PROJECT_ID, LEASE_GENERATION, 0);
  const h = makeController(0, null, contextKey);

  await h.controller.turnComplete({ id: h.runnerId }, h.sessionId, {
    turnId: 'turn-1',
    status: SharedRunStatus.SUCCEEDED,
  });

  assert.equal(h.sessionWrites.length, 1);
  assert.equal(h.sessionWrites[0].coordinatorContextAckKey, contextKey);
});

test('a stale generation cannot acknowledge coordinator context', async () => {
  const currentKey = buildCoordinatorDeliveryContextKey(PROJECT_ID, LEASE_GENERATION, 0);
  const staleGeneration = '55555555-5555-4555-8555-555555555555';
  const h = makeController(0, null, currentKey, staleGeneration);

  await h.controller.turnComplete({ id: h.runnerId }, h.sessionId, {
    turnId: 'turn-1',
    status: SharedRunStatus.SUCCEEDED,
  });

  assert.equal('coordinatorContextAckKey' in h.sessionWrites[0], false);
});

test('a pre-compaction turn cannot acknowledge the current coordinator context epoch', async () => {
  const staleEpoch = 17;
  const currentEpoch = 29;
  const staleKey = buildCoordinatorDeliveryContextKey(
    PROJECT_ID,
    LEASE_GENERATION,
    staleEpoch,
  );
  const h = makeController(0, null, staleKey, LEASE_GENERATION, currentEpoch);

  await h.controller.turnComplete({ id: h.runnerId }, h.sessionId, {
    turnId: 'turn-1',
    status: SharedRunStatus.SUCCEEDED,
  });

  assert.equal('coordinatorContextAckKey' in h.sessionWrites[0], false);
});

for (const status of [SharedRunStatus.FAILED, SharedRunStatus.INTERRUPTED] as const) {
  test(`${status} does not acknowledge coordinator context`, async () => {
    const contextKey = buildCoordinatorDeliveryContextKey(PROJECT_ID, LEASE_GENERATION, 0);
    const h = makeController(0, null, contextKey);

    await h.controller.turnComplete({ id: h.runnerId }, h.sessionId, {
      turnId: 'turn-1',
      status,
      result: status === SharedRunStatus.FAILED ? 'provider failed' : 'interrupted by user',
    });

    assert.ok(h.sessionWrites.length > 0);
    assert.equal(
      h.sessionWrites.some((write) => 'coordinatorContextAckKey' in write),
      false,
    );
  });
}

test('a failed chat turn finalizes the session FAILED instead of parking it as idle', async () => {
  const h = makeController(0);

  const result = await h.controller.turnComplete({ id: h.runnerId }, h.sessionId, {
    turnId: 'turn-1',
    status: SharedRunStatus.FAILED,
    result: 'API Error: Connection closed mid-response.',
  });

  // AWAITING_INPUT would show as "Waiting for your reply" in the session list, hiding the
  // failure behind a row that reads exactly like an idle session waiting on the user.
  assert.deepEqual(result, { ok: true, status: RunStatus.FAILED });
  assert.deepEqual(h.statusWrites, [RunStatus.FAILED]);
  assert.equal(h.sessionWrites[0].error, 'API Error: Connection closed mid-response.');
  // The engine is still alive after a failed turn; the cancel-drain reclaims its slot.
  assert.ok(h.sessionWrites[0].cancelRequestedAt instanceof Date);
  assert.equal(h.retireCalls(), 1);
  assert.equal(h.inboxWakes(), 0);
  assert.deepEqual(h.sessionUpdates, [h.sessionId]);
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
  assert.deepEqual(h.sessionUpdates, [h.sessionId]);
  assert.deepEqual(h.taskChanges, ['33333333-3333-4333-8333-333333333333']);
});
