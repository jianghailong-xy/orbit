import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { SessionsService } from './sessions.service';

/**
 * What a refused send / stop / withdraw SAYS, and that it says the same thing whichever door it
 * came through — the service is the only place any of them is decided.
 *
 * A refusal is the whole answer here. A mid-turn message produces no reply of its own (the running
 * turn's is the answer), so "nothing happened, and here is why" is all the sender ever gets. Two
 * different situations behind one sentence sends people looking for a race that never happened,
 * which is what "message already started or not found" did to a steer: it is not gone, it is
 * already on its way into the engine.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const TURN_ID = '33333333-3333-4333-8333-333333333333';

function makeService(opts: {
  session?: Record<string, unknown> | null;
  /** What the withdraw's delete matched, and what kind the row turns out to be. */
  deleted?: number;
  steerRow?: boolean;
  executable?: number;
}) {
  const session =
    opts.session === undefined
      ? {
          id: SESSION_ID,
          ownerId: OWNER_ID,
          provider: 'claude',
          providerBuiltin: true,
          status: RunStatus.RUNNING,
          cancelRequestedAt: null,
          deletedAt: null,
          prompt: 'p',
          numTurns: 1,
        }
      : opts.session;
  const tx = {
    $queryRaw: async () => (session ? [{ id: SESSION_ID }] : []),
    session: {
      findUniqueOrThrow: async () => ({ ...session }),
      update: async () => ({ ...session }),
    },
    conversationTurn: {
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => null,
      findFirst: async () => (opts.steerRow ? { id: TURN_ID } : null),
      deleteMany: async () => ({ count: opts.deleted ?? 0 }),
      count: async () => opts.executable ?? 1,
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new', seq: 2, ...data }),
    },
    conversationTurnStartupFragment: {
      findUnique: async () => null,
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
    attachment: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    modelProvider: { findFirst: async () => null },
  };
  const prisma = {
    session: { findFirst: async () => session, findUnique: async () => session },
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
  } as never;
  return new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as never,
    { notifyInbox: () => undefined, publishQueuedTurnsChanged: () => undefined } as never,
  );
}

async function refusal(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    return e as Error & { getStatus?: () => number };
  }
  assert.fail('expected a refusal');
}

test('withdrawing a steer says it is already on its way, not that it is missing', async () => {
  const service = makeService({ deleted: 0, steerRow: true });

  const err = await refusal(() => service.cancelQueuedTurn(OWNER_ID, SESSION_ID, TURN_ID));

  assert.ok(err instanceof ConflictException);
  // The delete matched nothing because a steer is not withdrawable — the engine may be reading
  // it as we ask — and NOT because the turn moved or never existed.
  assert.match(err.message, /written into the running turn/);
  assert.doesNotMatch(err.message, /not found/);
});

test('withdrawing something genuinely gone keeps the answer it always had', async () => {
  const service = makeService({ deleted: 0, steerRow: false });

  const err = await refusal(() => service.cancelQueuedTurn(OWNER_ID, SESSION_ID, TURN_ID));

  assert.ok(err instanceof ConflictException);
  assert.match(err.message, /already started or not found/);
});

test('a session nobody owns is 404 from every verb, never a 409 about its state', async () => {
  // The same sentence and the same status whether the id is wrong, the session belongs to
  // somebody else, or it was purged — a caller cannot tell those apart, and neither should the
  // answer let it.
  const missing = () => makeService({ session: null });

  for (const [name, call] of [
    ['send', () => missing().createTurn(OWNER_ID, SESSION_ID, { clientTurnId: 'k', content: 'x' })],
    ['interrupt', () => missing().interrupt(OWNER_ID, SESSION_ID)],
    ['withdraw', () => missing().cancelQueuedTurn(OWNER_ID, SESSION_ID, TURN_ID)],
  ] as const) {
    const err = await refusal(call);
    assert.ok(err instanceof NotFoundException, `${name} should be 404`);
    assert.equal(err.message, 'session not found', `${name} message`);
  }
});

test('an ended session refuses a send, a stop and a withdraw with one sentence', async () => {
  const ended = () =>
    makeService({
      session: {
        id: SESSION_ID,
        ownerId: OWNER_ID,
        provider: 'claude',
        providerBuiltin: true,
        status: RunStatus.SUCCEEDED,
        cancelRequestedAt: null,
        deletedAt: null,
        prompt: 'p',
        numTurns: 1,
      },
    });

  for (const [name, call] of [
    ['send', () => ended().createTurn(OWNER_ID, SESSION_ID, { clientTurnId: 'k', content: 'x' })],
    ['interrupt', () => ended().interrupt(OWNER_ID, SESSION_ID)],
    ['withdraw', () => ended().cancelQueuedTurn(OWNER_ID, SESSION_ID, TURN_ID)],
  ] as const) {
    const err = await refusal(call);
    assert.ok(err instanceof ConflictException, `${name} should be 409`);
    assert.equal(err.message, 'the session has ended', `${name} message`);
  }
});

test('an interrupt carrying a follow-up with no idempotency key is refused before anything is dropped', async () => {
  const service = makeService({});

  const err = await refusal(() => service.interrupt(OWNER_ID, SESSION_ID, { content: 'do this' }));

  // 400, not 409: the request is malformed, and retrying it unchanged cannot help. Refused up
  // front, so the queue this would have dropped is still there.
  assert.equal(err.constructor.name, 'BadRequestException');
  assert.match(err.message, /clientTurnId is required/);
});
