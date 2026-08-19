import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { SessionsService } from './sessions.service';

function makeService(status: RunStatus, executableAfterDelete: number) {
  const session = {
    id: '11111111-1111-4111-8111-111111111111',
    ownerId: '22222222-2222-4222-8222-222222222222',
    status,
    cancelRequestedAt: null,
  };
  const statusWrites: RunStatus[] = [];
  let inboxWakes = 0;
  let queueChanges = 0;
  const tx = {
    $queryRaw: async () => [{ id: session.id }],
    session: {
      findUniqueOrThrow: async () => ({ ...session }),
      update: async ({ data }: { data: { status: RunStatus } }) => {
        statusWrites.push(data.status);
        return { ...session, ...data };
      },
    },
    conversationTurn: {
      deleteMany: async () => ({ count: 1 }),
      count: async () => executableAfterDelete,
    },
  };
  const prisma = {
    session: { findFirst: async () => ({ ...session }) },
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
  } as never;
  const realtime = {
    notifyInbox: () => inboxWakes++,
    publishQueuedTurnsChanged: () => queueChanges++,
  } as never;
  return {
    service: new SessionsService(prisma, {} as never, realtime),
    session,
    statusWrites,
    inboxWakes: () => inboxWakes,
    queueChanges: () => queueChanges,
  };
}

test('withdrawing the last pre-claim turn restores PENDING to AWAITING_INPUT', async () => {
  const h = makeService(RunStatus.PENDING, 0);

  await h.service.cancelQueuedTurn(
    h.session.ownerId,
    h.session.id,
    '33333333-3333-4333-8333-333333333333',
  );

  assert.deepEqual(h.statusWrites, [RunStatus.AWAITING_INPUT]);
  assert.equal(h.inboxWakes(), 1);
  assert.equal(h.queueChanges(), 1, 'other clients are nudged to remove the withdrawn turn');
});

test('withdrawing the claim-handoff turn is rejected so the runner permit cannot leak', async () => {
  const h = makeService(RunStatus.RUNNING, 0);

  await assert.rejects(
    h.service.cancelQueuedTurn(
      h.session.ownerId,
      h.session.id,
      '33333333-3333-4333-8333-333333333333',
    ),
    /message already started/,
  );

  assert.deepEqual(h.statusWrites, []);
  assert.equal(h.inboxWakes(), 0);
});

test('a queued follow-up remains withdrawable while another turn is in flight', async () => {
  const h = makeService(RunStatus.RUNNING, 1);

  await h.service.cancelQueuedTurn(
    h.session.ownerId,
    h.session.id,
    '33333333-3333-4333-8333-333333333333',
  );

  assert.deepEqual(h.statusWrites, []);
  assert.equal(h.inboxWakes(), 1);
});
