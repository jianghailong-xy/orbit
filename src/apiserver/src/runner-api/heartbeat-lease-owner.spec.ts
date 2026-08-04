import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { RunnerStatus } from '@orbit/shared';
import { RunnerApiController, SESSION_WORKTREE_OPS_V1 } from './runner-api.controller';

const RUNNER_ID = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const SESSION_A = '019fc086-c7c7-7c92-8215-778ad8a6280a';
const SESSION_B = '44444444-4444-4444-8444-444444444444';

function harness(
  matchingIds: string[] = [],
  worktreeResponses: { merge?: unknown[]; commit?: unknown[] } = {},
) {
  const findManyWhere: unknown[] = [];
  const updateManyWhere: unknown[] = [];
  const updateManyCalls: Array<{ where: any; data: any }> = [];
  const mergeDrainCalls: unknown[][] = [];
  const commitDrainCalls: unknown[][] = [];
  const prisma = {
    runner: {
      update: async () => ({ maxConcurrent: 4 }),
      findUnique: async () => null,
    },
    session: {
      findMany: async ({ where }: { where: unknown }) => {
        findManyWhere.push(where);
        return matchingIds.map((id) => ({ id }));
      },
      updateMany: async ({ where, data }: { where: any; data: any }) => {
        updateManyWhere.push(where);
        updateManyCalls.push({ where, data });
        return { count: 1 };
      },
    },
  } as never;
  const realtime = {
    drainCancellations: async () => [SESSION_A],
    drainMergeRequests: async (...args: unknown[]) => {
      mergeDrainCalls.push(args);
      return worktreeResponses.merge ?? [];
    },
    drainCommitRequests: async (...args: unknown[]) => {
      commitDrainCalls.push(args);
      return worktreeResponses.commit ?? [];
    },
    drainArtifactRequests: async () => [],
  } as never;
  return {
    controller: new RunnerApiController(prisma, {} as never, realtime, {} as never, {} as never),
    findManyWhere,
    updateManyWhere,
    updateManyCalls,
    mergeDrainCalls,
    commitDrainCalls,
  };
}

/** The background-work sweep is the only heartbeat write that resets both running sets. */
const sweepOf = (calls: Array<{ where: any; data: any }>) =>
  calls.filter((c) => 'runningBgShells' in c.data);

test('heartbeat cancels supervised sessions not owned by this process', async () => {
  const h = harness([SESSION_A]);
  const response = await h.controller.heartbeat(
    { id: RUNNER_ID, version: null },
    {
      status: RunnerStatus.ONLINE,
      idleCapacity: 1,
      leaseOwner: OWNER,
      supervisedSessionIds: [SESSION_B, SESSION_A.toUpperCase(), SESSION_A, SESSION_B],
    },
  );

  assert.deepEqual(response.cancelSessionIds, [SESSION_A]);
  assert.deepEqual(response.leaseLostSessionIds, [SESSION_B]);
  assert.equal(h.findManyWhere.length, 1);
  assert.deepEqual(h.findManyWhere[0], {
    id: { in: [SESSION_B, SESSION_A] },
    assignedRunnerId: RUNNER_ID,
    status: { in: ['PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED'] },
    inboxLeaseOwner: OWNER,
  });
});

test('modern heartbeat live-diff writes are fenced by the process owner', async () => {
  const h = harness([SESSION_A]);
  await h.controller.heartbeat(
    { id: RUNNER_ID, version: null },
    {
      status: RunnerStatus.ONLINE,
      idleCapacity: 0,
      leaseOwner: OWNER,
      supervisedSessionIds: [SESSION_A],
      sessions: [
        {
          sessionId: SESSION_A,
          isolationStatus: 'worktree',
          changedFiles: [],
          branchMerged: true,
        },
      ],
    },
  );

  // The heartbeat also sweeps stale background work; the live-diff write is the fenced one.
  const liveDiff = h.updateManyCalls.filter((c) => c.where.inboxLeaseOwner !== undefined);
  assert.equal(liveDiff.length, 1);
  assert.equal(liveDiff[0].where.inboxLeaseOwner, OWNER);
});

test('heartbeat clears background work for sessions this process no longer supervises', async () => {
  const h = harness([SESSION_A]);
  await h.controller.heartbeat(
    { id: RUNNER_ID, version: null },
    {
      status: RunnerStatus.ONLINE,
      idleCapacity: 1,
      leaseOwner: OWNER,
      supervisedSessionIds: [SESSION_A],
    },
  );

  const sweep = sweepOf(h.updateManyCalls);
  assert.equal(sweep.length, 1);
  assert.deepEqual(sweep[0].data, { runningBgShells: [], runningSubagents: [] });
  assert.deepEqual(sweep[0].where, {
    assignedRunnerId: RUNNER_ID,
    status: { in: ['PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED'] },
    id: { notIn: [SESSION_A] },
    OR: [{ runningBgShells: { isEmpty: false } }, { runningSubagents: { isEmpty: false } }],
  });
});

test('a runner supervising nothing still sweeps its parked sessions', async () => {
  // The leak this heals: the runner was killed outright while a dev server was up and the
  // session then parked, so no `init`/`resumed` handshake will ever follow to reset the set.
  // `notIn: []` matches every row, so an empty supervisor list sweeps all of them.
  const h = harness();
  await h.controller.heartbeat(
    { id: RUNNER_ID, version: null },
    { status: RunnerStatus.ONLINE, idleCapacity: 1, leaseOwner: OWNER },
  );

  const sweep = sweepOf(h.updateManyCalls);
  assert.equal(sweep.length, 1);
  assert.deepEqual(sweep[0].where.id, { notIn: [] });
});

test('a legacy heartbeat never sweeps background work', async () => {
  // No leaseOwner means no supervisor list either, so a sweep would clear sessions whose
  // shells are genuinely running.
  const legacy = harness();
  await legacy.controller.heartbeat(
    { id: RUNNER_ID, version: null },
    {
      status: RunnerStatus.ONLINE,
      idleCapacity: 1,
      supervisedSessionIds: [SESSION_A],
    },
  );

  assert.deepEqual(sweepOf(legacy.updateManyCalls), []);
});

test('legacy heartbeat omits the owner fence', async () => {
  const legacy = harness();
  await legacy.controller.heartbeat(
    { id: RUNNER_ID, version: null },
    {
      status: RunnerStatus.ONLINE,
      idleCapacity: 1,
      supervisedSessionIds: [SESSION_A],
    },
  );
  assert.equal(legacy.findManyWhere.length, 0);
});

test('heartbeat rejects malformed or unsupported lease owner identities', async () => {
  const malformed = harness();
  await assert.rejects(
    malformed.controller.heartbeat(
      { id: RUNNER_ID, version: null },
      {
        status: RunnerStatus.ONLINE,
        idleCapacity: 1,
        leaseOwner: 'bad',
        supervisedSessionIds: [SESSION_A],
      },
    ),
    BadRequestException,
  );

  await assert.rejects(
    malformed.controller.heartbeat(
      { id: RUNNER_ID, version: null },
      {
        status: RunnerStatus.ONLINE,
        idleCapacity: 1,
        leaseOwner: SESSION_A,
        supervisedSessionIds: [SESSION_A],
      },
    ),
    BadRequestException,
  );
});

test('heartbeat rejects malformed supervised session IDs', async () => {
  const malformed = harness();
  await assert.rejects(
    malformed.controller.heartbeat(
      { id: RUNNER_ID, version: null },
      {
        status: RunnerStatus.ONLINE,
        idleCapacity: 1,
        leaseOwner: OWNER,
        supervisedSessionIds: ['not-a-session-uuid'],
      },
    ),
    /supervised session IDs must be UUIDs/,
  );
});

test('heartbeat drains manual worktree operations only with capability and process owner', async (t) => {
  await t.test('capable owner receives both fenced command streams', async () => {
    const merge = { sessionId: SESSION_A, operationId: 'merge-op' };
    const commit = { sessionId: SESSION_B, operationId: 'commit-op' };
    const h = harness([], { merge: [merge], commit: [commit] });

    const response = await h.controller.heartbeat(
      { id: RUNNER_ID, version: null },
      {
        status: RunnerStatus.ONLINE,
        idleCapacity: 1,
        leaseOwner: OWNER,
      },
      SESSION_WORKTREE_OPS_V1,
    );

    assert.deepEqual(h.mergeDrainCalls, [[RUNNER_ID, OWNER]]);
    assert.deepEqual(h.commitDrainCalls, [[RUNNER_ID, OWNER]]);
    assert.deepEqual(response.mergeRequests, [merge]);
    assert.deepEqual(response.commitRequests, [commit]);
  });

  for (const tc of [
    {
      name: 'legacy runner with a process owner',
      leaseOwner: OWNER,
      capabilities: undefined,
    },
    {
      name: 'capable runner without a process owner',
      leaseOwner: undefined,
      capabilities: SESSION_WORKTREE_OPS_V1,
    },
    {
      name: 'partial capability name',
      leaseOwner: OWNER,
      capabilities: `${SESSION_WORKTREE_OPS_V1}-extra`,
    },
  ]) {
    await t.test(tc.name, async () => {
      const h = harness([], {
        merge: [{ sessionId: SESSION_A }],
        commit: [{ sessionId: SESSION_B }],
      });

      const response = await h.controller.heartbeat(
        { id: RUNNER_ID, version: null },
        {
          status: RunnerStatus.ONLINE,
          idleCapacity: 1,
          ...(tc.leaseOwner ? { leaseOwner: tc.leaseOwner } : {}),
        },
        tc.capabilities,
      );

      assert.deepEqual(h.mergeDrainCalls, []);
      assert.deepEqual(h.commitDrainCalls, []);
      assert.deepEqual(response.mergeRequests, []);
      assert.deepEqual(response.commitRequests, []);
    });
  }
});
