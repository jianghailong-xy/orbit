import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { currentWorkTerminalizationDouble } from '../test-support/prisma-transaction-double';
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
  const created: Array<{ kind: string; content?: string; clientTurnId: string }> = [];
  const currentWork = currentWorkTerminalizationDouble();
  const tx = {
    $queryRaw: async () => [{ id: session.id }],
    session: {
      findUniqueOrThrow: async () => ({ ...session }),
      update: async () => ({ ...session }),
    },
    conversationTurn: {
      ...currentWork.conversationTurn,
      deleteMany: async () => ({ count: 1 }),
      count: async () => executableAfterDelete,
      findUnique: async () => null,
      findFirst: async () => ({ seq: 3 }),
      create: async (args: { data: { kind: string; content?: string; clientTurnId: string } }) => {
        controlTurns++;
        created.push(args.data);
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
    created: () => created,
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

// The runner reads the interrupt's payload off the turn, and what it may NOT read is permission to
// kill. A plain interrupt carries no payload at all: the runner's `stopBackgroundWorkRequested`
// reads absent as false, so the default interrupt stays the interrupt that ends nothing — that is
// the difference between `interrupt` and `end`, and it must not be eroded by this field.
test('a plain interrupt writes no payload onto its turn', async () => {
  const h = makeService(1);

  await h.service.interrupt(h.session.ownerId, h.session.id);

  assert.equal(h.created()[0].kind, 'interrupt');
  assert.equal(h.created()[0].content, undefined);
});

// The composer's Stop, and the whole of what makes it more than an interrupt: the explicit flag
// travels on the turn the runner reads, so one request carries one decision.
test("Stop's explicit flag rides the interrupt turn", async () => {
  const h = makeService(1);

  await h.service.interrupt(h.session.ownerId, h.session.id, { stopBackgroundWork: true });

  assert.equal(h.created()[0].kind, 'interrupt');
  assert.deepEqual(JSON.parse(h.created()[0].content!), {
    stopBackgroundWork: true,
  });
});

// The follow-up payload keeps its own shape and gains the flag: whatever reads `content`/
// `attachmentIds` today reads them unchanged, and the runner reads the flag beside them.
test('a follow-up and the stop flag travel on the same interrupt turn', async () => {
  const h = makeService(1);

  await h.service.interrupt(h.session.ownerId, h.session.id, {
    clientTurnId: '33333333-3333-4333-8333-333333333333',
    content: 'stop — do this instead',
    stopBackgroundWork: true,
  });

  const interrupt = h.created()[0];
  assert.equal(interrupt.kind, 'interrupt');
  assert.deepEqual(JSON.parse(interrupt.content!), {
    content: 'stop — do this instead',
    attachmentIds: [],
    stopBackgroundWork: true,
  });
  // And the follow-up itself is still filed as the ordinary message it has always been.
  assert.equal(h.created()[1].kind, 'message');
  assert.equal(h.created()[1].content, 'stop — do this instead');
});
