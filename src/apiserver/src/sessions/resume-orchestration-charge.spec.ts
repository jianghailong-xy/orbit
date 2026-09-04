import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { SessionsService } from './sessions.service';

/**
 * The orchestration door offers `resume` as the opt-in fallback for `send`, so the budget that
 * governs one has to govern the other: a steer the attempt budget refuses must not become
 * affordable by reviving the session it was aimed at instead. These tests hold the charge to the
 * same contract `createTurn` gives it — invoked for a new turn, before the row it pays for, on
 * whichever branch the resume takes.
 */

const now = new Date();

function makeService(overrides: Record<string, unknown> = {}) {
  const session = {
    id: 'session-1',
    status: RunStatus.FAILED,
    startedAt: now,
    numTurns: 0,
    runtimeSessionId: null,
    assignedRunnerId: 'runner-1',
    cancelRequestedAt: null,
    archivedAt: null,
    deletedAt: null,
    assignedRunner: { id: 'runner-1', status: 'ONLINE', lastHeartbeatAt: now },
    provider: 'codex',
    mergeStatus: null,
    mergeOperationId: null,
    mergeOperationOwner: null,
    commitStatus: null,
    commitOperationId: null,
    commitOperationOwner: null,
    ...overrides,
  };
  // One log for both effects, because the only thing worth asserting is their ORDER: a charge
  // taken after the turn is written is a charge the turn's rollback no longer takes with it.
  const effects: string[] = [];
  let notified = 0;
  const sessionDelegate = {
    findFirst: async () => session,
    findUniqueOrThrow: async () => session,
    update: async () => session,
  };
  const conversationTurnDelegate = {
    findUnique: async () => null,
    findFirst: async () => ({ seq: 1 }),
    create: async ({ data }: { data: { seq: number } & Record<string, unknown> }) => {
      effects.push('turn');
      return { id: 'revived-turn', ...data };
    },
  };
  const prisma = {
    session: sessionDelegate,
    conversationTurn: conversationTurnDelegate,
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        $queryRaw: async () => [{ id: session.id }],
        $executeRaw: async () => 1,
        session: sessionDelegate,
        conversationTurn: conversationTurnDelegate,
      }),
  } as never;
  const queue = {
    notifySessionQueued: () => {
      notified++;
    },
  } as never;
  const realtime = {
    publishSessionCreated: () => undefined,
    publishSessionUpdated: () => undefined,
  } as never;
  return {
    service: new SessionsService(prisma, queue, realtime),
    effects,
    notified: () => notified,
  };
}

const turn = { clientTurnId: 'send-1', content: 'keep going' };

test('reviving a terminal session charges the orchestration verb before writing its turn', async () => {
  const { service, effects } = makeService();

  const accepted = await service.resume('owner-1', 'session-1', turn, {
    participateSendTransaction: async () => {
      effects.push('charge');
    },
  });

  assert.deepEqual(effects, ['charge', 'turn']);
  assert.equal(accepted.turnId, 'revived-turn');
});

test('a refused charge stops the revive instead of buying the turn anyway', async () => {
  const { service, effects, notified } = makeService();

  await assert.rejects(
    () =>
      service.resume('owner-1', 'session-1', turn, {
        participateSendTransaction: async () => {
          throw new ConflictException('this session has spent its coordinator steers');
        },
      }),
    (error: unknown) =>
      error instanceof ConflictException &&
      error.message === 'this session has spent its coordinator steers',
  );

  // The whole point of charging inside the transaction: the refusal takes the turn with it, and
  // nothing downstream is told a session came back.
  assert.deepEqual(effects, []);
  assert.equal(notified(), 0);
});

test('a terminal revive says so, so the caller knows it restarted an engine', async () => {
  const { service } = makeService();

  const accepted = await service.resume('owner-1', 'session-1', turn);

  assert.equal(accepted.revived, true);
  assert.equal(accepted.placement, 'accepted');
});

test('resume on a still-live session forwards the charge to createTurn and revives nothing', async () => {
  const { service } = makeService({ status: RunStatus.AWAITING_INPUT });
  const forwarded: Array<(tx: unknown) => Promise<void>> = [];
  const charge = async () => undefined;
  // Stubbed at the seam this test is about. The live branch's job is to hand `createTurn` the
  // request unchanged — including the charge, which is the half that used to be dropped.
  service.createTurn = (async (_owner: string, _id: string, _dto: unknown, opts?: {
    participateSendTransaction?: (tx: unknown) => Promise<void>;
  }) => {
    if (opts?.participateSendTransaction) forwarded.push(opts.participateSendTransaction);
    return { turnId: 'live-turn', seq: 4, kind: 'steer', placement: 'accepted' };
  }) as never;

  const accepted = await service.resume('owner-1', 'session-1', turn, {
    participateSendTransaction: charge,
  });

  assert.deepEqual(forwarded, [charge]);
  assert.equal(accepted.revived, false);
  assert.equal(accepted.turnId, 'live-turn');
});
