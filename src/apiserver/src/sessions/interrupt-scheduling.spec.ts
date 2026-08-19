import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { SessionsService } from './sessions.service';

function makeService(executableAfterDelete: number) {
  const session = {
    id: '11111111-1111-4111-8111-111111111111',
    ownerId: '22222222-2222-4222-8222-222222222222',
    status: RunStatus.RUNNING,
    cancelRequestedAt: null,
  };
  let controlTurns = 0;
  let inboxWakes = 0;
  const tx = {
    $queryRaw: async () => [{ id: session.id }],
    session: { findUniqueOrThrow: async () => ({ ...session }) },
    conversationTurn: {
      deleteMany: async () => ({ count: 1 }),
      count: async () => executableAfterDelete,
      findUnique: async () => null,
      findFirst: async () => ({ seq: 3 }),
      create: async () => {
        controlTurns++;
        return { id: '44444444-4444-4444-8444-444444444444', seq: 4 };
      },
    },
  };
  const prisma = {
    session: { findFirst: async () => ({ ...session }) },
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
  } as never;
  const realtime = {
    notifyInbox: () => inboxWakes++,
    publishQueuedTurnsChanged: () => undefined,
  } as never;
  return {
    service: new SessionsService(prisma, {} as never, realtime),
    session,
    controlTurns: () => controlTurns,
    inboxWakes: () => inboxWakes,
  };
}

test('interrupt rejects the completion-to-next-turn handoff instead of leaking its permit', async () => {
  const h = makeService(0);

  await assert.rejects(h.service.interrupt(h.session.ownerId, h.session.id), /already starting/);
  assert.equal(h.controlTurns(), 0);
  assert.equal(h.inboxWakes(), 0);
});

test('interrupt remains deliverable while an executable turn is actually in flight', async () => {
  const h = makeService(1);

  assert.deepEqual(await h.service.interrupt(h.session.ownerId, h.session.id), { ok: true });
  assert.equal(h.controlTurns(), 1);
  assert.equal(h.inboxWakes(), 1);
});
