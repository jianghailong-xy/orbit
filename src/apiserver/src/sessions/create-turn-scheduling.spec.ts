import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { SessionsService } from './sessions.service';

function makeService(
  initialStatus: RunStatus,
  opts: { existing?: boolean; sessionOverrides?: Record<string, unknown> } = {},
) {
  const session = {
    id: '11111111-1111-4111-8111-111111111111',
    ownerId: '22222222-2222-4222-8222-222222222222',
    status: initialStatus,
    cancelRequestedAt: null,
    prompt: 'opening prompt',
    numTurns: 1,
    mergeStatus: null,
    mergeOperationId: null,
    mergeOperationOwner: null,
    commitStatus: null,
    commitOperationId: null,
    commitOperationOwner: null,
    ...opts.sessionOverrides,
  };
  const statusWrites: RunStatus[] = [];
  const updateWrites: Array<{ data: Record<string, unknown> }> = [];
  let queueWakes = 0;
  let inboxWakes = 0;
  let queueChanges = 0;
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
      update: async (write: { data: Record<string, unknown> }) => {
        updateWrites.push(write);
        statusWrites.push(write.data.status as RunStatus);
        session.status = write.data.status as RunStatus;
        return { ...session };
      },
    },
    conversationTurn: {
      findUnique: async () => (opts.existing ? turn : null),
      findFirst: async () => ({ seq: 1 }),
      create: async () => turn,
      count: async () => 0,
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
  const realtime = {
    notifyInbox: () => inboxWakes++,
    publishQueuedTurnsChanged: () => queueChanges++,
  } as never;
  return {
    service: new SessionsService(prisma, queue, realtime),
    session,
    statusWrites,
    updateWrites,
    wakes: () => ({ queue: queueWakes, inbox: inboxWakes }),
    queueChanges: () => queueChanges,
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
  assert.equal(h.queueChanges(), 1, 'focused clients are nudged to refresh the durable queue');
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

for (const tc of [
  {
    name: 'merge',
    sessionOverrides: {
      mergeStatus: 'pending',
      mergeOperationId: '66666666-6666-4666-8666-666666666666',
      mergeOperationOwner: '55555555-5555-4555-8555-555555555555',
    },
    opFields: ['mergeStatus', 'mergeOperationId', 'mergeOperationOwner'],
  },
  {
    name: 'commit',
    sessionOverrides: {
      commitStatus: 'pending',
      commitOperationId: '66666666-6666-4666-8666-666666666666',
      commitOperationOwner: '55555555-5555-4555-8555-555555555555',
    },
    opFields: ['commitStatus', 'commitOperationId', 'commitOperationOwner'],
  },
] as const) {
  test(`a new turn queues behind a runner-claimed ${tc.name} instead of being rejected`, async () => {
    const h = makeService(RunStatus.AWAITING_INPUT, {
      sessionOverrides: tc.sessionOverrides,
    });

    const result = await h.service.createTurn(h.session.ownerId, h.session.id, {
      clientTurnId: 'client-1',
      content: 'follow up',
    });

    // Accepted and parked for a slot — the claim fence holds it until the op settles.
    assert.deepEqual(result, { turnId: '33333333-3333-4333-8333-333333333333', seq: 2 });
    assert.deepEqual(h.statusWrites, [RunStatus.PENDING]);
    assert.deepEqual(h.wakes(), { queue: 1, inbox: 0 });
    // The executing operation is left pending (not superseded), so it still completes.
    assert.equal(h.updateWrites.length, 1);
    for (const field of tc.opFields) {
      assert.equal(
        h.updateWrites[0]?.data[field],
        undefined,
        `${field} must not be cleared while the operation is still executing`,
      );
    }
  });
}

for (const tc of [
  {
    name: 'a modern unclaimed merge',
    sessionOverrides: {
      mergeStatus: 'pending',
      mergeOperationId: '66666666-6666-4666-8666-666666666666',
      mergeOperationOwner: null,
    },
    fields: ['mergeStatus', 'mergeOperationId', 'mergeOperationOwner'],
  },
  {
    name: 'a modern unclaimed commit',
    sessionOverrides: {
      commitStatus: 'pending',
      commitOperationId: '66666666-6666-4666-8666-666666666666',
      commitOperationOwner: null,
    },
    fields: ['commitStatus', 'commitOperationId', 'commitOperationOwner'],
  },
  // An orphaned NULL/NULL row has no runner process behind it; blocking on one
  // wedges the session's next turn behind an operation nobody is running.
  {
    name: 'an orphaned NULL/NULL merge',
    sessionOverrides: {
      mergeStatus: 'pending',
      mergeOperationId: null,
      mergeOperationOwner: null,
    },
    fields: ['mergeStatus', 'mergeOperationId', 'mergeOperationOwner'],
  },
  {
    name: 'an orphaned NULL/NULL commit',
    sessionOverrides: {
      commitStatus: 'pending',
      commitOperationId: null,
      commitOperationOwner: null,
    },
    fields: ['commitStatus', 'commitOperationId', 'commitOperationOwner'],
  },
] as const) {
  test(`a new turn may supersede ${tc.name}`, async () => {
    const h = makeService(RunStatus.AWAITING_INPUT, {
      sessionOverrides: tc.sessionOverrides,
    });

    await h.service.createTurn(h.session.ownerId, h.session.id, {
      clientTurnId: 'client-1',
      content: 'follow up',
    });

    assert.equal(h.updateWrites.length, 1);
    for (const field of tc.fields) {
      assert.equal(h.updateWrites[0]?.data[field], null, `${field} was not cleared`);
    }
    assert.deepEqual(h.wakes(), { queue: 1, inbox: 0 });
  });
}
