import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { SESSION_CURRENT_WORK_ROUTING_V1 } from '@orbit/shared';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { SessionNotSendable, SessionsService } from './sessions.service';

/**
 * POST /sessions/:id/turns/:turnId/steer — the tray's Steer (SessionsService.steerQueuedTurn): a
 * message queued for the next turn is sent into the one running now, by becoming the CURRENT_WORK
 * steer createTurn would have filed, or it stays queued and the refusal says why.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const TURN_ID = '33333333-3333-4333-8333-333333333333';
const RUNNER_ID = '44444444-4444-4444-8444-444444444444';
const LIVE_ID = '55555555-5555-4555-8555-555555555555';

const queuedTyped = {
  id: TURN_ID,
  seq: 5,
  kind: 'message',
  status: 'PENDING',
  sendIntent: 'NEXT_TURN',
  targetTurnId: null,
  clientTurnId: 'typed',
  senderSessionId: null,
};

/** A session running one engine turn (LIVE_ID) with one row this request asks about. */
function makeService(opts: {
  turn?: Record<string, unknown> | null;
  live?: boolean;
  stopped?: boolean;
  engine?: string;
  capabilities?: readonly string[];
  status?: RunStatus;
}) {
  const session = {
    id: SESSION_ID,
    ownerId: OWNER_ID,
    provider: opts.engine ?? 'claude',
    providerBuiltin: true,
    engine: opts.engine ?? 'claude',
    assignedRunnerId: RUNNER_ID,
    status: opts.status ?? RunStatus.RUNNING,
    cancelRequestedAt: null,
    deletedAt: null,
    prompt: 'p',
    numTurns: 1,
  };
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const tx = {
    // The Session lock, and liveEngineTurn's read of the running turn. The two calling conventions
    // Prisma accepts are the shared helper's business (test-support/prisma-transaction-double), not
    // this double's: a spec that reads them itself is the drift the conventions sweep forbids.
    $queryRaw: async (...args: unknown[]) => {
      const text = renderRawQuery(args).text;
      if (!text.includes('"conversation_turn"')) return [{ id: SESSION_ID }];
      return opts.live === false ? [] : [{ id: LIVE_ID, seq: 3 }];
    },
    session: { findUniqueOrThrow: async () => ({ ...session }) },
    runner: { findUnique: async () => ({ capabilities: opts.capabilities ?? [SESSION_CURRENT_WORK_ROUTING_V1] }) },
    conversationTurn: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        // stopOvertookTarget: an interrupt filed after the live turn.
        if (where.kind === 'interrupt') return opts.stopped ? { id: 'stop' } : null;
        return opts.turn === null ? null : { ...queuedTyped, ...opts.turn };
      },
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updates.push(args);
        return { count: 1 };
      },
    },
    modelProvider: { findFirst: async () => null },
  };
  const prisma = { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } as never;
  const notified: string[] = [];
  const published: string[] = [];
  const service = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as never,
    {
      notifyInbox: (id: string) => notified.push(id),
      publishQueuedTurnsChanged: (id: string) => published.push(id),
    } as never,
  );
  return { service, updates, notified, published };
}

async function refusal(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  assert.fail('expected a refusal');
}

const reasonOf = (err: unknown) =>
  ((err as ConflictException).getResponse() as { code?: string; reason?: string });

test('a queued message the reader typed becomes the steer aimed at the running turn', async () => {
  const h = makeService({});

  assert.deepEqual(await h.service.steerQueuedTurn(OWNER_ID, SESSION_ID, TURN_ID), {
    turnId: TURN_ID,
    seq: 5,
    kind: 'steer',
    placement: 'steer',
    targetTurnId: LIVE_ID,
  });
  // One compare-and-set, on the row while it is still a queued message, all three columns at once.
  assert.deepEqual(h.updates, [{
    where: { id: TURN_ID, sessionId: SESSION_ID, kind: 'message', status: 'PENDING' },
    data: { kind: 'steer', sendIntent: 'CURRENT_WORK', targetTurnId: LIVE_ID },
  }]);
  // The runner is woken to take it now, and every focused client re-reads the queue.
  assert.deepEqual(h.notified, [SESSION_ID]);
  assert.deepEqual(h.published, [SESSION_ID]);
});

test('a legacy queued message (no intent recorded) is steered the same way', async () => {
  const h = makeService({ turn: { sendIntent: null } });
  await h.service.steerQueuedTurn(OWNER_ID, SESSION_ID, TURN_ID);
  assert.equal(h.updates.length, 1);
});

test('a second press answers with the steer the first one made, and changes nothing', async () => {
  const h = makeService({ turn: { kind: 'steer', sendIntent: 'CURRENT_WORK', targetTurnId: LIVE_ID, status: 'IN_FLIGHT' } });

  assert.deepEqual(await h.service.steerQueuedTurn(OWNER_ID, SESSION_ID, TURN_ID), {
    turnId: TURN_ID,
    seq: 5,
    kind: 'steer',
    placement: 'steer',
    targetTurnId: LIVE_ID,
  });
  assert.deepEqual(h.updates, []);
});

test('with no turn to join, the message stays queued and the refusal is CURRENT_WORK_UNAVAILABLE', async () => {
  for (const [opts, reason] of [
    [{ live: false }, 'NO_CURRENT_WORK'],
    // Somebody pressed Stop: what is sent now is the next instruction, not part of the stopped work.
    [{ stopped: true }, 'NO_CURRENT_WORK'],
    // An engine with no mid-turn delivery, and a runner that never declared exact-target routing.
    [{ engine: 'kimi' }, 'STEER_UNSUPPORTED'],
    [{ capabilities: [] }, 'STEER_UNSUPPORTED'],
  ] as const) {
    const h = makeService(opts);
    const err = await refusal(() => h.service.steerQueuedTurn(OWNER_ID, SESSION_ID, TURN_ID));
    assert.ok(err instanceof ConflictException, JSON.stringify(opts));
    assert.deepEqual(
      { code: reasonOf(err).code, reason: reasonOf(err).reason },
      { code: 'CURRENT_WORK_UNAVAILABLE', reason },
      JSON.stringify(opts),
    );
    assert.deepEqual(h.updates, [], `${JSON.stringify(opts)} wrote the row`);
    assert.deepEqual(h.notified, []);
  }
});

test('only a message the reader typed can be sent into the turn', async () => {
  for (const turn of [
    { senderSessionId: '66666666-6666-4666-8666-666666666666' },
    { clientTurnId: 'bg-wake:job-1' },
  ]) {
    const h = makeService({ turn });
    const err = await refusal(() => h.service.steerQueuedTurn(OWNER_ID, SESSION_ID, TURN_ID));
    assert.ok(err instanceof ConflictException, JSON.stringify(turn));
    assert.match((err as Error).message, /Only a message you typed/);
    assert.deepEqual(h.updates, []);
  }
});

test('a row that is not a queued message is already started or gone', async () => {
  for (const turn of [
    null,
    { kind: 'shell' },
    { status: 'IN_FLIGHT' },
    { status: 'ANSWERED' },
    { clientTurnId: SessionsService.initialTurnClientId(SESSION_ID) },
  ]) {
    const h = makeService({ turn });
    const err = await refusal(() => h.service.steerQueuedTurn(OWNER_ID, SESSION_ID, TURN_ID));
    assert.ok(err instanceof ConflictException, JSON.stringify(turn));
    assert.match((err as Error).message, /already started or not found/, JSON.stringify(turn));
    assert.deepEqual(h.updates, []);
  }
});

test('an ended session refuses it as it refuses a send', async () => {
  const h = makeService({ status: RunStatus.SUCCEEDED });
  const err = await refusal(() => h.service.steerQueuedTurn(OWNER_ID, SESSION_ID, TURN_ID));
  assert.ok(err instanceof SessionNotSendable);
  assert.deepEqual(h.updates, []);
});
