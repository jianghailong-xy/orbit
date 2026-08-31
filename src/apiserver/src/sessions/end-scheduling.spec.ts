import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { SessionEndReason } from '@orbit/shared';
import { currentWorkTerminalizationDouble } from '../test-support/prisma-transaction-double';
import { SessionsService } from './sessions.service';

test('end linearizes after a concurrent send and finalizes the now-PENDING session', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const ownerId = '22222222-2222-4222-8222-222222222222';
  const runnerId = '33333333-3333-4333-8333-333333333333';
  const fastRead = {
    id,
    ownerId,
    status: RunStatus.AWAITING_INPUT,
    cancelRequestedAt: null,
    assignedRunnerId: runnerId,
  };
  const lockedRead = { ...fastRead, status: RunStatus.PENDING };
  let statusWrite: Record<string, unknown> | undefined;
  let drained = 0;
  let cancelRequests = 0;
  let inboxWakes = 0;
  let retired = 0;
  const sessionUpdates: string[] = [];
  const queuedTurnUpdates: string[] = [];
  const currentWork = currentWorkTerminalizationDouble({
    onConversationTurnUpdateMany: async () => {
      drained++;
      return { count: 1 };
    },
  });
  const tx = {
    $queryRaw: async () => [{ id }],
    $executeRaw: async () => {
      retired++;
      return 1;
    },
    session: {
      findUniqueOrThrow: async () => lockedRead,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        statusWrite = data;
        return { ...lockedRead, ...data };
      },
    },
    conversationTurn: {
      ...currentWork.conversationTurn,
      findFirst: async () => null,
    },
    conversationTurnStartupFragment: currentWork.conversationTurnStartupFragment,
  };
  const prisma = {
    session: { findFirst: async () => fastRead },
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
  } as never;
  const realtime = {
    publishSessionUpdated: (sessionId: string) => sessionUpdates.push(sessionId),
    publishQueuedTurnsChanged: (sessionId: string) => queuedTurnUpdates.push(sessionId),
    requestCancel: () => cancelRequests++,
    notifyInbox: () => inboxWakes++,
  } as never;
  const service = new SessionsService(prisma, {} as never, realtime);

  assert.deepEqual(await service.end(ownerId, id), { ok: true });
  assert.equal(statusWrite?.status, RunStatus.CANCELLED);
  assert.equal(statusWrite?.endReason, SessionEndReason.ENDED);
  assert.equal(drained, 1);
  assert.equal(retired, 1);
  assert.equal(cancelRequests, 1);
  assert.equal(inboxWakes, 1);
  assert.deepEqual(sessionUpdates, [id]);
  assert.deepEqual(queuedTurnUpdates, [id]);
});
