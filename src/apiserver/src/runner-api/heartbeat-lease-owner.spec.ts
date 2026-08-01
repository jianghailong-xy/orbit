import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { RunnerStatus } from '@orbit/shared';
import { RunnerApiController } from './runner-api.controller';

const RUNNER_ID = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const SESSION_A = '33333333-3333-4333-8333-333333333333';
const SESSION_B = '44444444-4444-4444-8444-444444444444';

function harness(matchingIds: string[] = []) {
  const findManyWhere: unknown[] = [];
  const updateManyWhere: unknown[] = [];
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
      updateMany: async ({ where }: { where: unknown }) => {
        updateManyWhere.push(where);
        return { count: 1 };
      },
    },
  } as never;
  const realtime = {
    drainCancellations: async () => [SESSION_A],
    drainMergeRequests: async () => [],
    drainCommitRequests: async () => [],
    drainArtifactRequests: async () => [],
  } as never;
  return {
    controller: new RunnerApiController(prisma, {} as never, realtime, {} as never, {} as never),
    findManyWhere,
    updateManyWhere,
  };
}

test('heartbeat cancels supervised sessions not owned by this process', async () => {
  const h = harness([SESSION_A]);
  const response = await h.controller.heartbeat(
    { id: RUNNER_ID, version: null },
    {
      status: RunnerStatus.ONLINE,
      idleCapacity: 1,
      leaseOwner: OWNER,
      supervisedSessionIds: [SESSION_B, SESSION_A, SESSION_B],
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

  assert.equal(h.updateManyWhere.length, 1);
  assert.equal((h.updateManyWhere[0] as { inboxLeaseOwner?: string }).inboxLeaseOwner, OWNER);
});

test('legacy heartbeat omits the owner fence and malformed modern identities fail closed', async () => {
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
});
