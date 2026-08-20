import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { SessionsService } from './sessions.service';

/**
 * Which kind a sent message is filed as, decided by the server at enqueue.
 *
 * No client asks to steer. A message sent while the engine is mid-turn IS a steer, and one
 * sent to an idle session is an ordinary turn — so every entry point (web, native, MCP, CLI)
 * gets mid-turn delivery without any of them knowing the word. The decision is made under
 * the same Session row lock the inbox dequeues under, which is what keeps it from racing the
 * turn it is about.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';

function makeService(inFlight: number, status: RunStatus = RunStatus.RUNNING) {
  const created: Record<string, unknown>[] = [];
  const countFilters: Record<string, unknown>[] = [];
  const session = {
    id: SESSION_ID,
    ownerId: OWNER_ID,
    status,
    cancelRequestedAt: null,
    prompt: 'opening prompt',
    numTurns: 1,
    mergeStatus: null,
    mergeOperationId: null,
    mergeOperationOwner: null,
    commitStatus: null,
    commitOperationId: null,
    commitOperationOwner: null,
  };
  const tx = {
    $queryRaw: async () => [{ id: SESSION_ID }],
    session: {
      findUniqueOrThrow: async () => ({ ...session }),
      update: async () => ({ ...session }),
    },
    conversationTurn: {
      findUnique: async () => null,
      findFirst: async () => ({ seq: 1 }),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: 'turn-new', seq: 2, ...data };
      },
      count: async ({ where }: { where: Record<string, unknown> }) => {
        countFilters.push(where);
        return inFlight;
      },
    },
    attachment: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
  };
  const prisma = {
    session: { findFirst: async () => ({ ...session }), findUnique: async () => ({ ...session }) },
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
  } as never;
  const service = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as never,
    { notifyInbox: () => undefined, publishQueuedTurnsChanged: () => undefined } as never,
  );
  return { service, created, countFilters };
}

const send = (h: ReturnType<typeof makeService>, kind?: 'shell') =>
  h.service.createTurn(OWNER_ID, SESSION_ID, {
    clientTurnId: '44444444-4444-4444-8444-444444444444',
    content: 'actually, call it gadget',
    ...(kind ? { kind } : {}),
  });

test('a message sent while the engine is mid-turn is filed as a steer', async () => {
  const h = makeService(1);

  await send(h);

  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].kind, 'steer');
  assert.equal(h.created[0].content, 'actually, call it gadget');
  // Same row as any other turn: its own seq, and the caller's idempotency key. The kind is
  // the only thing that was ever about timing.
  assert.equal(h.created[0].clientTurnId, '44444444-4444-4444-8444-444444444444');
  assert.equal(h.created[0].status, 'PENDING');
});

test('the running turn is looked for by a live lease, and only among engine turns', async () => {
  const h = makeService(1);

  await send(h);

  const probe = h.countFilters.at(-1) as { kind: unknown; status: unknown; leaseDeadlineAt: unknown };
  // Messages only: a `!cmd` shell turn holds the same slot with the engine idle beside it.
  assert.equal(probe.kind, 'message');
  assert.equal(probe.status, 'IN_FLIGHT');
  // An expired lease belongs to an engine that stopped answering — nothing to steer.
  assert.ok((probe.leaseDeadlineAt as { gt?: Date })?.gt instanceof Date);
});

test('a message sent to an idle session is an ordinary turn, and queues as one', async () => {
  const h = makeService(0, RunStatus.AWAITING_INPUT);

  await send(h);

  assert.equal(h.created[0].kind, 'message');
});

test('a `!cmd` shell turn never becomes a steer, however busy the engine is', async () => {
  const h = makeService(1);

  await send(h, 'shell');

  assert.equal(h.created[0].kind, 'shell');
});
