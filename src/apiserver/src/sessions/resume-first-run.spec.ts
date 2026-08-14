import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { SessionsService } from './sessions.service';

const now = new Date();

function makeService(
  overrides: Record<string, unknown> = {},
  existingTurn: { id: string; seq: number } | null = null,
) {
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
  const updates: unknown[] = [];
  const announced: string[] = [];
  let notified = 0;
  let retired = 0;
  const sessionDelegate = {
    findFirst: async () => session,
    findUniqueOrThrow: async () => session,
    update: async (args: unknown) => {
      updates.push(args);
      return session;
    },
  };
  const conversationTurnDelegate = {
    findUnique: async () => existingTurn,
    findFirst: async () => ({ seq: 1 }),
    create: async ({ data }: { data: { seq: number } }) => ({ id: 'retry-turn', ...data }),
  };
  const prisma = {
    session: sessionDelegate,
    conversationTurn: conversationTurnDelegate,
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        $queryRaw: async () => [{ id: session.id }],
        $executeRaw: async () => {
          retired++;
          return 1;
        },
        session: sessionDelegate,
        conversationTurn: conversationTurnDelegate,
      }),
  } as never;
  const queue = {
    notifySessionQueued: () => {
      notified++;
    },
  } as never;
  // The control plane is the only thing that tells other clients a terminal session came back:
  // no STATUS event accompanies the revive, and the claim behind it publishes nothing either.
  const realtime = {
    publishSessionCreated: (sessionId: string) => announced.push(`created:${sessionId}`),
    publishSessionUpdated: (sessionId: string) => announced.push(`updated:${sessionId}`),
  } as never;
  const service = new SessionsService(prisma, queue, realtime);
  return { service, updates, announced, notified: () => notified, retired: () => retired };
}

const retry = { clientTurnId: 'retry-1', content: 'send after signing in' };

test('a claimed zero-turn Codex session can restart after sign-in without a runtime id', async () => {
  const { service, updates, notified, retired } = makeService();

  const accepted = await service.resume('owner-1', 'session-1', retry);

  assert.equal(accepted.turnId, 'retry-turn');
  assert.equal(accepted.seq, 2);
  assert.equal(notified(), 1);
  assert.equal(retired(), 1);
  const reviveData = (updates[0] as {
    data: { status: RunStatus; inboxLeaseOwner: string };
  }).data;
  assert.equal(reviveData.status, RunStatus.PENDING);
  assert.match(
    reviveData.inboxLeaseOwner,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test('reviving a terminal session tells the control plane it is no longer ended', async () => {
  const { service, announced } = makeService();

  await service.resume('owner-1', 'session-1', retry);

  // Nothing else does: PENDING is written inside the transaction with no STATUS event, and the
  // claim that turns it into RUNNING publishes nothing either — so without this the next word
  // any other client hears about this session is its turn_end, a whole turn later. That is what
  // left an auto-retried session drawn as "Retrying automatically." while it was already running.
  assert.deepEqual(announced, ['updated:session-1']);
});

test('a session that was never claimed still cannot restart', async () => {
  const { service } = makeService({ startedAt: null });

  await assert.rejects(
    () => service.resume('owner-1', 'session-1', retry),
    (error: unknown) =>
      error instanceof ConflictException && error.message === 'this session never ran and cannot be resumed',
  );
});

test('completed context without a runtime id still cannot restart', async () => {
  const { service } = makeService({ numTurns: 1 });

  await assert.rejects(
    () => service.resume('owner-1', 'session-1', retry),
    (error: unknown) =>
      error instanceof ConflictException && error.message === 'this session never ran and cannot be resumed',
  );
});

test('resume rejects Trash before taking the live-session path', async () => {
  const { service, updates, notified } = makeService({
    status: RunStatus.AWAITING_INPUT,
    deletedAt: now,
  });

  await assert.rejects(
    () => service.resume('owner-1', 'session-1', retry),
    (error: unknown) =>
      error instanceof ConflictException &&
      error.message === 'the session is in Trash; restore it before sending a message',
  );
  assert.equal(updates.length, 0);
  assert.equal(notified(), 0);
});

test('a graceful terminal cancel remains resumable despite historical cancelRequestedAt', async () => {
  const { service } = makeService({ cancelRequestedAt: now });

  const accepted = await service.resume('owner-1', 'session-1', retry);

  assert.equal(accepted.turnId, 'retry-turn');
});

test('a lost resume response can retry its clientTurnId after the session became PENDING', async () => {
  const existingTurn = { id: 'already-queued-turn', seq: 7 };
  const { service, updates, announced, notified, retired } = makeService(
    { status: RunStatus.PENDING },
    existingTurn,
  );

  const accepted = await service.resume('owner-1', 'session-1', retry);

  assert.deepEqual(accepted, { turnId: existingTurn.id, seq: existingTurn.seq });
  assert.equal(updates.length, 0);
  assert.equal(retired(), 0);
  assert.equal(notified(), 1);
  // Nothing was revived — the row was already PENDING — so there is no news to announce.
  assert.deepEqual(announced, []);
});

for (const tc of [
  {
    name: 'merge',
    overrides: {
      mergeStatus: 'pending',
      mergeOperationId: '11111111-1111-4111-8111-111111111111',
      mergeOperationOwner: '22222222-2222-4222-8222-222222222222',
    },
  },
  {
    name: 'commit',
    overrides: {
      commitStatus: 'pending',
      commitOperationId: '11111111-1111-4111-8111-111111111111',
      commitOperationOwner: '22222222-2222-4222-8222-222222222222',
    },
  },
] as const) {
  test(`terminal resume cannot supersede a runner-claimed ${tc.name}`, async () => {
    const { service, updates, notified, retired } = makeService(tc.overrides);

    await assert.rejects(
      () => service.resume('owner-1', 'session-1', retry),
      (error: unknown) =>
        error instanceof ConflictException &&
        error.message === 'wait for the pending worktree operation to finish',
    );

    assert.deepEqual(updates, []);
    assert.equal(retired(), 0);
    assert.equal(notified(), 0);
  });
}

for (const tc of [
  {
    name: 'a modern unclaimed merge',
    overrides: {
      mergeStatus: 'pending',
      mergeOperationId: '11111111-1111-4111-8111-111111111111',
      mergeOperationOwner: null,
    },
    fields: ['mergeStatus', 'mergeOperationId', 'mergeOperationOwner'],
  },
  {
    name: 'a modern unclaimed commit',
    overrides: {
      commitStatus: 'pending',
      commitOperationId: '11111111-1111-4111-8111-111111111111',
      commitOperationOwner: null,
    },
    fields: ['commitStatus', 'commitOperationId', 'commitOperationOwner'],
  },
  // An orphaned NULL/NULL row has no runner process behind it; blocking on one
  // leaves the terminal session unresumable forever.
  {
    name: 'an orphaned NULL/NULL merge',
    overrides: {
      mergeStatus: 'pending',
      mergeOperationId: null,
      mergeOperationOwner: null,
    },
    fields: ['mergeStatus', 'mergeOperationId', 'mergeOperationOwner'],
  },
  {
    name: 'an orphaned NULL/NULL commit',
    overrides: {
      commitStatus: 'pending',
      commitOperationId: null,
      commitOperationOwner: null,
    },
    fields: ['commitStatus', 'commitOperationId', 'commitOperationOwner'],
  },
] as const) {
  test(`terminal resume may supersede ${tc.name}`, async () => {
    const { service, updates, notified, retired } = makeService(tc.overrides);

    await service.resume('owner-1', 'session-1', retry);

    assert.equal(updates.length, 1);
    const data = (updates[0] as { data: Record<string, unknown> }).data;
    for (const field of tc.fields) {
      assert.equal(data[field], null, `${field} was not cleared`);
    }
    assert.equal(retired(), 1);
    assert.equal(notified(), 1);
  });
}
