import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { SessionsService } from './sessions.service';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const OPERATION_ID = '33333333-3333-4333-8333-333333333333';
const OPERATION_OWNER = '44444444-4444-4444-8444-444444444444';

function makeService(
  fastOverrides: Record<string, unknown>,
  lockedOverrides: Record<string, unknown> = {},
) {
  const now = new Date();
  const fast = {
    id: SESSION_ID,
    ownerId: OWNER_ID,
    status: RunStatus.AWAITING_INPUT,
    cancelRequestedAt: null,
    deletedAt: null,
    archivedAt: null,
    completedAt: null,
    startedAt: now,
    numTurns: 1,
    prompt: 'opening prompt',
    runtimeSessionId: 'runtime-1',
    assignedRunnerId: 'runner-1',
    assignedRunner: { id: 'runner-1', status: 'ONLINE', lastHeartbeatAt: now },
    provider: 'codex',
    mergeStatus: null,
    mergeOperationId: null,
    mergeOperationOwner: null,
    commitStatus: null,
    commitOperationId: null,
    commitOperationOwner: null,
    ...fastOverrides,
  };
  const locked = { ...fast, ...lockedOverrides };
  const outerUpdates: unknown[] = [];
  const lockedUpdates: unknown[] = [];
  const lockCalls: unknown[][] = [];
  let turnCreates = 0;
  let queueWakes = 0;
  let inboxWakes = 0;
  const tx = {
    $queryRaw: async (...args: unknown[]) => {
      lockCalls.push(args);
      return [{ id: SESSION_ID }];
    },
    session: {
      findUniqueOrThrow: async () => locked,
      update: async (args: unknown) => {
        lockedUpdates.push(args);
        return locked;
      },
    },
    conversationTurn: {
      findUnique: async () => null,
      findFirst: async () => ({ seq: 1 }),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        turnCreates++;
        return { id: 'turn-2', ...data };
      },
      count: async () => 0,
    },
  };
  const prisma = {
    session: {
      findFirst: async () => fast,
      // Any call here is outside createTurn's row-locked transaction.
      update: async (args: unknown) => {
        outerUpdates.push(args);
        return fast;
      },
    },
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
  } as never;
  const service = new SessionsService(
    prisma,
    { notifySessionQueued: () => queueWakes++ } as never,
    { notifyInbox: () => inboxWakes++, publishQueuedTurnsChanged: () => undefined } as never,
  );
  return {
    service,
    outerUpdates,
    lockedUpdates,
    lockCalls,
    turnCreates: () => turnCreates,
    wakes: () => ({ queue: queueWakes, inbox: inboxWakes }),
  };
}

function sql(call: unknown[] | undefined): string {
  return ((call?.[0] as readonly string[] | undefined) ?? []).join('?');
}

for (const tc of [
  {
    name: 'merge receipt',
    fast: {
      mergeStatus: 'conflict',
      mergeOperationId: OPERATION_ID,
      mergeOperationOwner: OPERATION_OWNER,
    },
    expected: {
      mergeStatus: null,
      mergeOperationId: null,
      mergeOperationOwner: null,
      mergeError: null,
      mergedAt: null,
      mergedSourceSha: null,
      branchMerged: null,
    },
  },
  {
    name: 'commit receipt',
    fast: {
      commitStatus: 'error',
      commitOperationId: OPERATION_ID,
      commitOperationOwner: OPERATION_OWNER,
    },
    expected: {
      commitStatus: null,
      commitOperationId: null,
      commitOperationOwner: null,
      commitError: null,
    },
  },
] as const) {
  test(`live resume clears a settled ${tc.name} only in createTurn's row-locked update`, async () => {
    const h = makeService(tc.fast);

    assert.deepEqual(
      await h.service.resume(OWNER_ID, SESSION_ID, {
        clientTurnId: 'client-2',
        content: 'resolve this in the session',
      }),
      { turnId: 'turn-2', seq: 2 },
    );

    assert.equal(h.lockCalls.length, 1);
    assert.match(sql(h.lockCalls[0]), /FOR UPDATE/);
    assert.deepEqual(h.outerUpdates, []);
    assert.equal(h.lockedUpdates.length, 1);
    const data = (h.lockedUpdates[0] as { data: Record<string, unknown> }).data;
    assert.equal(data.status, RunStatus.PENDING);
    for (const [field, value] of Object.entries(tc.expected)) {
      assert.equal(data[field], value, `${field} was not cleared under the row lock`);
    }
    assert.equal(h.turnCreates(), 1);
    assert.deepEqual(h.wakes(), { queue: 1, inbox: 0 });
  });
}

for (const tc of [
  {
    name: 'merge',
    fast: { mergeStatus: 'conflict' },
    locked: {
      mergeStatus: 'pending',
      mergeOperationId: OPERATION_ID,
      mergeOperationOwner: OPERATION_OWNER,
    },
    opFields: ['mergeStatus', 'mergeOperationId', 'mergeOperationOwner'],
  },
  {
    name: 'commit',
    fast: { commitStatus: 'error' },
    locked: {
      commitStatus: 'pending',
      commitOperationId: OPERATION_ID,
      commitOperationOwner: OPERATION_OWNER,
    },
    opFields: ['commitStatus', 'commitOperationId', 'commitOperationOwner'],
  },
] as const) {
  test(`live resume queues behind — and cannot clear — a ${tc.name} epoch claimed after its fast snapshot`, async () => {
    const h = makeService(tc.fast, tc.locked);

    // The fast read showed a settled receipt, so "Resolve in session" was offered; under the
    // row lock createTurn sees a freshly-claimed operation instead. It must neither erase that
    // epoch nor reject the message — the turn enqueues PENDING behind the running operation.
    const result = await h.service.resume(OWNER_ID, SESSION_ID, {
      clientTurnId: 'client-2',
      content: 'resolve this in the session',
    });

    assert.deepEqual(result, { turnId: 'turn-2', seq: 2 });
    assert.equal(h.lockCalls.length, 1);
    assert.deepEqual(h.outerUpdates, []);
    assert.equal(h.turnCreates(), 1);
    assert.deepEqual(h.wakes(), { queue: 1, inbox: 0 });
    // Queued for a slot, and the claimed epoch is left untouched so it still completes.
    assert.equal(h.lockedUpdates.length, 1);
    const data = (h.lockedUpdates[0] as { data: Record<string, unknown> }).data;
    assert.equal(data.status, RunStatus.PENDING);
    for (const field of tc.opFields) {
      assert.equal(data[field], undefined, `${field} must not be cleared`);
    }
  });
}
