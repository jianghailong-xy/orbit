import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { RunnerStatus, RunStatus as SharedRunStatus } from '@orbit/shared';
import { RunnerApiController } from './runner-api.controller';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const LEASE_OWNER = '33333333-3333-4333-8333-333333333333';
const OPERATION_ID = '44444444-4444-4444-8444-444444444444';
const NEW_LEASE_OWNER = '55555555-5555-4555-8555-555555555555';
const NEW_OPERATION_ID = '66666666-6666-4666-8666-666666666666';
const SOURCE_SHA = 'a'.repeat(40);
const TARGET_SHA = 'b'.repeat(40);
const NEW_SOURCE_SHA = 'c'.repeat(40);

function controller(prisma: unknown) {
  return new RunnerApiController(
    prisma as never,
    { notifySessionQueued: () => undefined } as never,
    { notifyInbox: () => undefined, publish: () => undefined } as never,
    {} as never,
    {} as never,
    {} as never,
    { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never,
  );
}

test('merge result persists the exact source tip and marks the branch merged', async () => {
  const writes: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  const tx = {
    $queryRaw: async () => [
      {
        status: RunStatus.SUCCEEDED,
        inboxLeaseOwner: null,
        mergeStatus: 'pending',
        mergeOperationId: OPERATION_ID,
        mergeOperationOwner: LEASE_OWNER,
      },
    ],
    session: {
      update: async (write: (typeof writes)[number]) => {
        writes.push(write);
      },
    },
  };
  const prisma = { $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx) };

  await controller(prisma).mergeResult({ id: RUNNER_ID }, SESSION_ID, {
    operationId: OPERATION_ID,
    leaseOwner: LEASE_OWNER,
    status: 'merged',
    mergedSha: TARGET_SHA,
    sourceSha: SOURCE_SHA,
  });

  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].where, { id: SESSION_ID });
  assert.equal(writes[0].data.mergeStatus, 'merged');
  assert.equal(writes[0].data.baseSha, TARGET_SHA);
  assert.equal(writes[0].data.mergedSourceSha, SOURCE_SHA);
  assert.equal(writes[0].data.branchMerged, true);
});

test('heartbeat preserves an exact source marker behind the process-owner fence', async (t) => {
  for (const tc of [
    { name: 'matching reported tip', branchSha: SOURCE_SHA },
    { name: 'missing reported tip', branchSha: undefined },
  ]) {
    await t.test(tc.name, async () => {
      const reads: Array<Record<string, unknown>> = [];
      const writes: Array<{
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }> = [];
      const prisma = {
        runner: {
          update: async () => ({ maxConcurrent: 1 }),
        },
        session: {
          findFirst: async (args: Record<string, unknown>) => {
            reads.push(args);
            return {
              mergedSourceSha: SOURCE_SHA,
              mergeOperationId: OPERATION_ID,
              mergeOperationOwner: LEASE_OWNER,
            };
          },
          updateMany: async (write: (typeof writes)[number]) => {
            writes.push(write);
            return { count: 1 };
          },
        },
      };

      await controller(prisma).heartbeat(
        { id: RUNNER_ID, version: null },
        {
          status: RunnerStatus.ONLINE,
          idleCapacity: 0,
          leaseOwner: LEASE_OWNER,
          sessions: [
            {
              sessionId: SESSION_ID,
              isolationStatus: 'worktree',
              changedFiles: [],
              branchMerged: false,
              branchSha: tc.branchSha,
            },
          ],
        },
      );

      assert.deepEqual(reads, [
        {
          where: {
            id: SESSION_ID,
            assignedRunnerId: RUNNER_ID,
            status: { in: ['PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED'] },
            mergeStatus: 'merged',
            inboxLeaseOwner: LEASE_OWNER,
          },
          select: {
            mergedSourceSha: true,
            mergeOperationId: true,
            mergeOperationOwner: true,
          },
        },
      ]);
      assert.equal(writes.length, 1);
      assert.deepEqual(writes[0].where, {
        id: SESSION_ID,
        assignedRunnerId: RUNNER_ID,
        status: { in: ['PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED'] },
        inboxLeaseOwner: LEASE_OWNER,
      });
      assert.equal(writes[0].data.branchMerged, true);
      assert.equal(writes[0].data.mergeStatus, undefined);
      assert.equal(writes[0].data.mergedSourceSha, undefined);
    });
  }
});

function diffHarness(
  mergedSourceSha: string | null,
  mergeOperationId: string | null = mergedSourceSha ? OPERATION_ID : null,
  mergeOperationOwner: string | null = mergedSourceSha ? LEASE_OWNER : null,
) {
  const writes: Array<{
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }> = [];
  const prisma = {
    session: {
      findUnique: async () => ({ assignedRunnerId: RUNNER_ID }),
      findFirst: async () => ({
        mergedSourceSha,
        mergeOperationId,
        mergeOperationOwner,
      }),
      updateMany: async (write: (typeof writes)[number]) => {
        writes.push(write);
        return { count: 1 };
      },
    },
    sessionDiff: { upsert: async () => undefined },
  };
  return { api: controller(prisma), writes };
}

test('a conservative false report keeps merged state when the source tip is unchanged', async () => {
  const h = diffHarness(SOURCE_SHA);

  await h.api.diffResult({ id: RUNNER_ID }, SESSION_ID, {
    branchMerged: false,
    branchSha: SOURCE_SHA,
  });

  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].data.branchMerged, true);
  assert.equal(h.writes[0].data.mergeStatus, undefined);
});

test('a missing reported tip cannot erase an exact merged source marker', async () => {
  const h = diffHarness(SOURCE_SHA);

  await h.api.diffResult({ id: RUNNER_ID }, SESSION_ID, {
    branchMerged: false,
  });

  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].data.branchMerged, true);
  assert.equal(h.writes[0].data.mergeStatus, undefined);
});

test('a legacy merge without an exact source marker retains false-clear behavior', async () => {
  const h = diffHarness(null);

  await h.api.diffResult({ id: RUNNER_ID }, SESSION_ID, {
    branchMerged: false,
  });

  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[0].data.mergeStatus, null);
  assert.equal(h.writes[0].data.mergedSourceSha, null);
  assert.equal(h.writes[1].data.branchMerged, false);
});

test('a changed source tip retires the previous merged state', async () => {
  const h = diffHarness(SOURCE_SHA);

  await h.api.diffResult({ id: RUNNER_ID }, SESSION_ID, {
    branchMerged: false,
    branchSha: NEW_SOURCE_SHA,
  });

  assert.equal(h.writes.length, 2);
  assert.deepEqual(h.writes[0].where, {
    id: SESSION_ID,
    assignedRunnerId: RUNNER_ID,
    status: { in: ['PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED'] },
    mergeStatus: 'merged',
    mergedSourceSha: SOURCE_SHA,
    mergeOperationId: OPERATION_ID,
    mergeOperationOwner: LEASE_OWNER,
  });
  assert.deepEqual(h.writes[0].data, {
    mergeStatus: null,
    mergeOperationId: null,
    mergeOperationOwner: null,
    mergeError: null,
    mergedSourceSha: null,
  });
  assert.equal(h.writes[1].data.branchMerged, false);
});

test('a stale reconcile cannot clear a newer merge attempt with the same source SHA', async () => {
  const current: {
    mergeStatus: string | null;
    mergedSourceSha: string | null;
    mergeOperationId: string | null;
    mergeOperationOwner: string | null;
  } = {
    mergeStatus: 'merged',
    mergedSourceSha: SOURCE_SHA,
    mergeOperationId: NEW_OPERATION_ID,
    mergeOperationOwner: NEW_LEASE_OWNER,
  };
  const writes: Array<{
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }> = [];
  const prisma = {
    session: {
      findUnique: async () => ({ assignedRunnerId: RUNNER_ID }),
      // The reconcile read happened before a newer attempt settled to the same source tip.
      findFirst: async () => ({
        mergedSourceSha: SOURCE_SHA,
        mergeOperationId: OPERATION_ID,
        mergeOperationOwner: LEASE_OWNER,
      }),
      updateMany: async (write: (typeof writes)[number]) => {
        writes.push(write);
        if (write.data.mergeStatus !== null) return { count: 1 };
        const matchesCurrentEpoch =
          write.where.mergeStatus === current.mergeStatus &&
          write.where.mergedSourceSha === current.mergedSourceSha &&
          write.where.mergeOperationId === current.mergeOperationId &&
          write.where.mergeOperationOwner === current.mergeOperationOwner;
        if (matchesCurrentEpoch) {
          current.mergeStatus = null;
          current.mergedSourceSha = null;
          current.mergeOperationId = null;
          current.mergeOperationOwner = null;
        }
        return { count: matchesCurrentEpoch ? 1 : 0 };
      },
    },
    sessionDiff: { upsert: async () => undefined },
  };

  await controller(prisma).diffResult({ id: RUNNER_ID }, SESSION_ID, {
    branchMerged: false,
    branchSha: NEW_SOURCE_SHA,
  });

  assert.deepEqual(writes[0].where, {
    id: SESSION_ID,
    assignedRunnerId: RUNNER_ID,
    status: { in: ['PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED'] },
    mergeStatus: 'merged',
    mergedSourceSha: SOURCE_SHA,
    mergeOperationId: OPERATION_ID,
    mergeOperationOwner: LEASE_OWNER,
  });
  assert.deepEqual(current, {
    mergeStatus: 'merged',
    mergedSourceSha: SOURCE_SHA,
    mergeOperationId: NEW_OPERATION_ID,
    mergeOperationOwner: NEW_LEASE_OWNER,
  });
  assert.equal(writes[1].data.branchMerged, false);
});

function turnHarness(branchSha?: string) {
  const writes: Array<{
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }> = [];
  const tx = {
    $queryRaw: async () => [{ id: SESSION_ID, leaseOwnerMatches: true }],
    conversationTurn: {
      updateMany: async () => ({ count: 1 }),
      findUnique: async () => ({ kind: 'message' }),
      count: async () => 0,
      findFirst: async () => null,
    },
    session: {
      findUniqueOrThrow: async () => ({
        status: RunStatus.RUNNING,
        taskId: null,
        mergeStatus: 'merged',
        mergedSourceSha: SOURCE_SHA,
      }),
      findUnique: async () => ({ status: RunStatus.RUNNING }),
      updateMany: async (write: (typeof writes)[number]) => {
        writes.push(write);
        return { count: 1 };
      },
    },
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
  };
  return {
    api: controller(prisma),
    writes,
    request: {
      turnId: 'turn-1',
      status: SharedRunStatus.SUCCEEDED,
      branchMerged: false,
      branchSha,
    },
  };
}

test('turn completion uses the same source-tip reconciliation as live reports', async () => {
  const unchanged = turnHarness(SOURCE_SHA);
  await unchanged.api.turnComplete({ id: RUNNER_ID }, SESSION_ID, unchanged.request);
  assert.equal(unchanged.writes.length, 1);
  assert.equal(unchanged.writes[0].data.branchMerged, true);

  const changed = turnHarness(NEW_SOURCE_SHA);
  await changed.api.turnComplete({ id: RUNNER_ID }, SESSION_ID, changed.request);
  assert.equal(changed.writes.length, 2);
  assert.equal(changed.writes[0].data.mergeStatus, null);
  assert.equal(changed.writes[0].data.mergedSourceSha, null);
  assert.equal(changed.writes[1].data.branchMerged, false);

  const missing = turnHarness();
  await missing.api.turnComplete({ id: RUNNER_ID }, SESSION_ID, missing.request);
  assert.equal(missing.writes.length, 1);
  assert.equal(missing.writes[0].data.branchMerged, true);
});
