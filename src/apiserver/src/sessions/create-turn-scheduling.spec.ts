import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { SessionsService } from './sessions.service';

function makeService(initialStatus: RunStatus, opts: { existing?: boolean } = {}) {
  const session = {
    id: '11111111-1111-4111-8111-111111111111',
    ownerId: '22222222-2222-4222-8222-222222222222',
    status: initialStatus,
    cancelRequestedAt: null,
    prompt: 'opening prompt',
    numTurns: 1,
  };
  const statusWrites: RunStatus[] = [];
  let queueWakes = 0;
  let inboxWakes = 0;
  let attachmentValidations = 0;
  const turn = {
    id: '33333333-3333-4333-8333-333333333333',
    sessionId: session.id,
    seq: 2,
    clientTurnId: 'client-1',
    kind: 'message',
    content: 'follow up',
    status: 'PENDING',
  };
  const tx = {
    $queryRaw: async () => [{ id: session.id }],
    session: {
      findUniqueOrThrow: async () => ({ ...session }),
      update: async ({ data }: { data: { status: RunStatus } }) => {
        statusWrites.push(data.status);
        session.status = data.status;
        return { ...session };
      },
    },
    conversationTurn: {
      findUnique: async () => (opts.existing ? turn : null),
      findFirst: async () => ({ seq: 1 }),
      create: async () => turn,
    },
    attachment: {
      findMany: async () => {
        attachmentValidations++;
        return [];
      },
      updateMany: async () => ({ count: 0 }),
    },
  };
  const prisma = {
    session: { findFirst: async () => ({ ...session }) },
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
  } as never;
  const queue = { notifySessionQueued: () => queueWakes++ } as never;
  const realtime = { notifyInbox: () => inboxWakes++ } as never;
  return {
    service: new SessionsService(prisma, queue, realtime),
    session,
    statusWrites,
    wakes: () => ({ queue: queueWakes, inbox: inboxWakes }),
    attachmentValidations: () => attachmentValidations,
  };
}

test('a turn sent to AWAITING_INPUT is atomically queued for a new slot', async () => {
  const h = makeService(RunStatus.AWAITING_INPUT);

  const result = await h.service.createTurn(h.session.ownerId, h.session.id, {
    clientTurnId: 'client-1',
    content: 'follow up',
  });

  assert.deepEqual(result, { turnId: '33333333-3333-4333-8333-333333333333', seq: 2 });
  assert.deepEqual(h.statusWrites, [RunStatus.PENDING]);
  assert.deepEqual(h.wakes(), { queue: 1, inbox: 0 });
});

test('a turn sent while RUNNING stays behind the slot already being used', async () => {
  const h = makeService(RunStatus.RUNNING);

  await h.service.createTurn(h.session.ownerId, h.session.id, {
    clientTurnId: 'client-1',
    content: 'follow up',
  });

  assert.deepEqual(h.statusWrites, [RunStatus.RUNNING]);
  assert.deepEqual(h.wakes(), { queue: 0, inbox: 1 });
});

test('an idempotent retry returns its linked turn before revalidating attachments', async () => {
  const h = makeService(RunStatus.PENDING, { existing: true });

  const result = await h.service.createTurn(h.session.ownerId, h.session.id, {
    clientTurnId: 'client-1',
    content: 'follow up',
    attachmentIds: ['44444444-4444-4444-8444-444444444444'],
  });

  assert.deepEqual(result, { turnId: '33333333-3333-4333-8333-333333333333', seq: 2 });
  assert.equal(h.attachmentValidations(), 0);
  assert.deepEqual(h.statusWrites, []);
  assert.deepEqual(h.wakes(), { queue: 1, inbox: 0 });
});
