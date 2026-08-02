import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
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
    updateWrites,
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

for (const tc of [
  {
    name: 'merge',
    sessionOverrides: {
      mergeStatus: 'pending',
      mergeOperationId: '66666666-6666-4666-8666-666666666666',
      mergeOperationOwner: '55555555-5555-4555-8555-555555555555',
    },
  },
  {
    name: 'commit',
    sessionOverrides: {
      commitStatus: 'pending',
      commitOperationId: '66666666-6666-4666-8666-666666666666',
      commitOperationOwner: '55555555-5555-4555-8555-555555555555',
    },
  },
] as const) {
  test(`a new turn cannot overlap a runner-claimed ${tc.name}`, async () => {
    const h = makeService(RunStatus.AWAITING_INPUT, {
      sessionOverrides: tc.sessionOverrides,
    });

    await assert.rejects(
      () =>
        h.service.createTurn(h.session.ownerId, h.session.id, {
          clientTurnId: 'client-1',
          content: 'follow up',
        }),
      (error: unknown) =>
        error instanceof ConflictException &&
        error.message === 'wait for the pending worktree operation to finish',
    );

    assert.deepEqual(h.statusWrites, []);
    assert.equal(h.attachmentValidations(), 0);
    assert.deepEqual(h.wakes(), { queue: 0, inbox: 0 });
  });
}

for (const tc of [
  {
    name: 'merge',
    sessionOverrides: {
      mergeStatus: 'pending',
      mergeOperationId: null,
      mergeOperationOwner: null,
    },
  },
  {
    name: 'commit',
    sessionOverrides: {
      commitStatus: 'pending',
      commitOperationId: null,
      commitOperationOwner: null,
    },
  },
] as const) {
  test(`a new turn treats a legacy NULL/NULL pending ${tc.name} as already claimed`, async () => {
    const h = makeService(RunStatus.AWAITING_INPUT, {
      sessionOverrides: tc.sessionOverrides,
    });

    await assert.rejects(
      () =>
        h.service.createTurn(h.session.ownerId, h.session.id, {
          clientTurnId: 'client-1',
          content: 'follow up',
        }),
      (error: unknown) =>
        error instanceof ConflictException &&
        error.message === 'wait for the pending worktree operation to finish',
    );

    assert.deepEqual(h.updateWrites, []);
    assert.deepEqual(h.wakes(), { queue: 0, inbox: 0 });
  });
}

for (const tc of [
  {
    name: 'merge',
    sessionOverrides: {
      mergeStatus: 'pending',
      mergeOperationId: '66666666-6666-4666-8666-666666666666',
      mergeOperationOwner: null,
    },
    fields: ['mergeStatus', 'mergeOperationId', 'mergeOperationOwner'],
  },
  {
    name: 'commit',
    sessionOverrides: {
      commitStatus: 'pending',
      commitOperationId: '66666666-6666-4666-8666-666666666666',
      commitOperationOwner: null,
    },
    fields: ['commitStatus', 'commitOperationId', 'commitOperationOwner'],
  },
] as const) {
  test(`a new turn may supersede a modern unclaimed ${tc.name}`, async () => {
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
