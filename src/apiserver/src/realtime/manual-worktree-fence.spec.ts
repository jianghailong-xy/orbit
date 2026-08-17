import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@orbit/shared';
import { OPEN_SESSION_STATUSES } from '../common/session-scheduling';
import { WORKTREE_OPERATION_STALE_MS } from '../common/session-inbox-fence';
import { RealtimeService } from './realtime.service';

const RUNNER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const OLD_OWNER = '33333333-3333-4333-8333-333333333333';
const NEW_OWNER = '44444444-4444-4444-8444-444444444444';
const OPERATION_ID = '55555555-5555-4555-8555-555555555555';

function service(prisma: unknown) {
  return new RealtimeService(prisma as never, {} as never);
}

test('a terminal merge is claimed by the heartbeat owner with an operation CAS', async () => {
  const reads: unknown[] = [];
  const writes: unknown[] = [];
  const prisma = {
    session: {
      findMany: async (args: unknown) => {
        reads.push(args);
        return [
          {
            id: SESSION_ID,
            branch: 'orbit/session',
            baseSha: 'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0',
            mergeTarget: 'main',
            mergeOperationId: OPERATION_ID,
            mergeOperationOwner: null,
            status: RunStatus.SUCCEEDED,
            workspace: { workDir: '/repo' },
          },
        ];
      },
      updateMany: async (args: unknown) => {
        writes.push(args);
        return { count: 1 };
      },
    },
  };

  const commands = await service(prisma).drainMergeRequests(RUNNER_ID, NEW_OWNER);

  assert.deepEqual(commands, [
    {
      sessionId: SESSION_ID,
      operationId: OPERATION_ID,
      leaseOwner: NEW_OWNER,
      branch: 'orbit/session',
      workDir: '/repo',
      targetBranch: 'main',
      // The fork point travels with the command: the runner's own base ref is gone once the
      // checkout is torn down, and it anchors the replay to this session's commits.
      baseSha: 'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0',
    },
  ]);
  assert.deepEqual(reads, [
    {
      where: {
        assignedRunnerId: RUNNER_ID,
        mergeStatus: 'pending',
        mergeOperationId: { not: null },
        branch: { not: null },
        AND: [
          {
            OR: [{ mergeOperationOwner: null }, { mergeOperationOwner: NEW_OWNER }],
          },
          {
            OR: [
              { status: { notIn: OPEN_SESSION_STATUSES } },
              {
                status: { in: OPEN_SESSION_STATUSES },
                inboxLeaseOwner: NEW_OWNER,
              },
            ],
          },
        ],
      },
      select: {
        id: true,
        branch: true,
        baseSha: true,
        mergeTarget: true,
        mergeOperationId: true,
        mergeOperationOwner: true,
        status: true,
        workspace: { select: { workDir: true } },
      },
    },
  ]);
  const restampedAt = (writes[0] as { data: { mergeRequestedAt: Date } }).data.mergeRequestedAt;
  assert.ok(restampedAt instanceof Date, 'claim must restamp the staleness clock');
  assert.deepEqual(writes, [
    {
      where: {
        id: SESSION_ID,
        assignedRunnerId: RUNNER_ID,
        mergeStatus: 'pending',
        mergeOperationId: OPERATION_ID,
        OR: [{ mergeOperationOwner: null }, { mergeOperationOwner: NEW_OWNER }],
        status: { notIn: OPEN_SESSION_STATUSES },
      },
      data: { mergeOperationOwner: NEW_OWNER, mergeRequestedAt: restampedAt },
    },
  ]);
});

test('merge claim redelivers only to the same owner and loses cleanly to another owner', async (t) => {
  await t.test('same owner redelivery', async () => {
    const writes: unknown[] = [];
    const prisma = {
      session: {
        findMany: async () => [
          {
            id: SESSION_ID,
            branch: 'orbit/session',
            mergeTarget: null,
            mergeOperationId: OPERATION_ID,
            mergeOperationOwner: OLD_OWNER,
            status: RunStatus.AWAITING_INPUT,
            workspace: { workDir: '/repo' },
          },
        ],
        updateMany: async (args: unknown) => {
          writes.push(args);
          return { count: 1 };
        },
      },
    };

    const commands = await service(prisma).drainMergeRequests(RUNNER_ID, OLD_OWNER);

    assert.equal(commands.length, 1);
    assert.equal(commands[0]?.leaseOwner, OLD_OWNER);
    const restampedAt = (writes[0] as { data: { mergeRequestedAt: Date } }).data.mergeRequestedAt;
    assert.ok(restampedAt instanceof Date, 'redelivery must keep restamping the staleness clock');
    assert.deepEqual(writes, [
      {
        where: {
          id: SESSION_ID,
          assignedRunnerId: RUNNER_ID,
          mergeStatus: 'pending',
          mergeOperationId: OPERATION_ID,
          OR: [{ mergeOperationOwner: null }, { mergeOperationOwner: OLD_OWNER }],
          status: { in: OPEN_SESSION_STATUSES },
          inboxLeaseOwner: OLD_OWNER,
        },
        data: { mergeOperationOwner: OLD_OWNER, mergeRequestedAt: restampedAt },
      },
    ]);
  });

  await t.test('new owner cannot dispatch a row won by the old owner after selection', async () => {
    const prisma = {
      session: {
        findMany: async () => [
          {
            id: SESSION_ID,
            branch: 'orbit/session',
            mergeTarget: null,
            mergeOperationId: OPERATION_ID,
            mergeOperationOwner: null,
            status: RunStatus.SUCCEEDED,
            workspace: { workDir: '/repo' },
          },
        ],
        // Simulates OLD_OWNER winning between findMany and updateMany.
        updateMany: async () => ({ count: 0 }),
      },
    };

    assert.deepEqual(await service(prisma).drainMergeRequests(RUNNER_ID, NEW_OWNER), []);
  });
});

test('commit claim repeats every idle and process-owner guard in its CAS', async () => {
  const reads: unknown[] = [];
  const writes: unknown[] = [];
  const prisma = {
    session: {
      findMany: async (args: unknown) => {
        reads.push(args);
        return [
          {
            id: SESSION_ID,
            branch: 'orbit/session',
            commitOperationId: OPERATION_ID,
            status: RunStatus.AWAITING_INPUT,
          },
        ];
      },
      updateMany: async (args: unknown) => {
        writes.push(args);
        return { count: 1 };
      },
    },
  };

  const commands = await service(prisma).drainCommitRequests(RUNNER_ID, NEW_OWNER);

  assert.deepEqual(commands, [
    {
      sessionId: SESSION_ID,
      operationId: OPERATION_ID,
      leaseOwner: NEW_OWNER,
      branch: 'orbit/session',
    },
  ]);
  // No runningBgShells guard: it mirrors the queueing gate, where a left-up dev server would
  // otherwise keep the checkout "busy" for the rest of the session's life.
  const idleBranch = {
    inboxLeaseOwner: NEW_OWNER,
    status: RunStatus.AWAITING_INPUT,
    cancelRequestedAt: null,
    runningSubagents: { isEmpty: true },
    OR: [{ commitOperationOwner: null }, { commitOperationOwner: NEW_OWNER }],
  };
  const commonWhere = {
    assignedRunnerId: RUNNER_ID,
    commitStatus: 'pending',
    commitOperationId: { not: null },
    branch: { not: null },
  };
  assert.deepEqual(reads, [
    {
      where: {
        ...commonWhere,
        OR: [
          idleBranch,
          {
            status: { notIn: OPEN_SESSION_STATUSES },
            commitOperationOwner: NEW_OWNER,
          },
        ],
      },
      select: { id: true, branch: true, commitOperationId: true, status: true },
    },
  ]);
  const restampedAt = (writes[0] as { data: { commitRequestedAt: Date } }).data.commitRequestedAt;
  assert.ok(restampedAt instanceof Date, 'claim must restamp the staleness clock');
  assert.deepEqual(writes, [
    {
      where: {
        id: SESSION_ID,
        assignedRunnerId: RUNNER_ID,
        commitStatus: 'pending',
        commitOperationId: OPERATION_ID,
        ...idleBranch,
      },
      data: { commitOperationOwner: NEW_OWNER, commitRequestedAt: restampedAt },
    },
  ]);
});

test('commit is not dispatched when the idle-state CAS loses', async () => {
  const prisma = {
    session: {
      findMany: async () => [
        {
          id: SESSION_ID,
          branch: 'orbit/session',
          commitOperationId: OPERATION_ID,
          status: RunStatus.AWAITING_INPUT,
        },
      ],
      updateMany: async () => ({ count: 0 }),
    },
  };

  assert.deepEqual(await service(prisma).drainCommitRequests(RUNNER_ID, NEW_OWNER), []);
});

test('terminal commit is redelivered only to its exact operation owner', async (t) => {
  await t.test('same owner receives a cached receipt retry', async () => {
    const writes: unknown[] = [];
    const prisma = {
      session: {
        findMany: async () => [
          {
            id: SESSION_ID,
            branch: 'orbit/session',
            commitOperationId: OPERATION_ID,
            status: RunStatus.SUCCEEDED,
          },
        ],
        updateMany: async (args: unknown) => {
          writes.push(args);
          return { count: 1 };
        },
      },
    };

    assert.deepEqual(await service(prisma).drainCommitRequests(RUNNER_ID, NEW_OWNER), [
      {
        sessionId: SESSION_ID,
        operationId: OPERATION_ID,
        leaseOwner: NEW_OWNER,
        branch: 'orbit/session',
      },
    ]);
    const restampedAt = (writes[0] as { data: { commitRequestedAt: Date } }).data.commitRequestedAt;
    assert.ok(restampedAt instanceof Date, 'receipt retry must keep restamping the staleness clock');
    assert.deepEqual(writes, [
      {
        where: {
          id: SESSION_ID,
          assignedRunnerId: RUNNER_ID,
          commitStatus: 'pending',
          commitOperationId: OPERATION_ID,
          status: { notIn: OPEN_SESSION_STATUSES },
          commitOperationOwner: NEW_OWNER,
        },
        data: { commitOperationOwner: NEW_OWNER, commitRequestedAt: restampedAt },
      },
    ]);
  });

  await t.test('unowned terminal receipt cannot be claimed', async () => {
    const writes: unknown[] = [];
    const prisma = {
      session: {
        // Simulates a row changing to unowned after selection; the terminal CAS
        // must still require self instead of accepting NULL.
        findMany: async () => [
          {
            id: SESSION_ID,
            branch: 'orbit/session',
            commitOperationId: OPERATION_ID,
            status: RunStatus.FAILED,
          },
        ],
        updateMany: async (args: unknown) => {
          writes.push(args);
          return { count: 0 };
        },
      },
    };

    assert.deepEqual(await service(prisma).drainCommitRequests(RUNNER_ID, NEW_OWNER), []);
    assert.deepEqual(
      (writes[0] as { where: Record<string, unknown> }).where.commitOperationOwner,
      NEW_OWNER,
    );
    assert.equal((writes[0] as { where: Record<string, unknown> }).where.OR, undefined);
  });
});

test('abandoned foreign-owner operations are failed over; live and unclaimed ones are spared', async () => {
  const writes: unknown[] = [];
  const prisma = {
    session: {
      updateMany: async (args: unknown) => {
        writes.push(args);
        return { count: 1 };
      },
    },
  };

  const before = Date.now() - WORKTREE_OPERATION_STALE_MS;
  await service(prisma).failAbandonedWorktreeOperations(RUNNER_ID, NEW_OWNER);
  const after = Date.now() - WORKTREE_OPERATION_STALE_MS;

  assert.equal(writes.length, 2);
  const [merge, commit] = writes as Array<{
    where: Record<string, unknown> & { mergeRequestedAt?: { lt: Date }; commitRequestedAt?: { lt: Date } };
    data: Record<string, unknown>;
  }>;
  // Only a *claimed* (owner-bearing) request can be abandoned — an unclaimed one is
  // still deliverable — and only a *foreign* owner is provably a dead process: this
  // heartbeat's leaseOwner is the runner's one live process and redelivery keeps
  // restamping its own claims fresh.
  for (const [write, kind] of [
    [merge, 'merge'],
    [commit, 'commit'],
  ] as const) {
    assert.equal(write.where.assignedRunnerId, RUNNER_ID);
    assert.equal(write.where[`${kind}Status`], 'pending');
    assert.deepEqual(write.where[`${kind}OperationOwner`], { not: null });
    assert.deepEqual(write.where.NOT, { [`${kind}OperationOwner`]: NEW_OWNER });
    const cutoff = (write.where[`${kind}RequestedAt`] as { lt: Date }).lt.getTime();
    assert.ok(cutoff >= before && cutoff <= after, 'staleness cutoff must be the stale window');
    assert.equal(write.data[`${kind}Status`], 'error');
    assert.ok(String(write.data[`${kind}Error`]).includes('stopped before reporting a result'));
  }
});
