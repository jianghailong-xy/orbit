import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { OPEN_SESSION_STATUSES } from '../common/session-scheduling';
import { RunnerApiController } from './runner-api.controller';

const LEASE_OWNER = '44444444-4444-4444-8444-444444444444';

test('runner restart reclaims every open session so cold checkouts remain protected', async () => {
  let where: unknown;
  const prisma = {
    session: {
      findMany: async (args: { where: unknown }) => {
        where = args.where;
        return [];
      },
    },
  } as never;
  const controller = new RunnerApiController(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  assert.deepEqual(
    await controller.reclaim({
      id: '11111111-1111-4111-8111-111111111111',
      ownerId: '22222222-2222-4222-8222-222222222222',
    }),
    { sessions: [] },
  );
  assert.deepEqual(where, {
    assignedRunnerId: '11111111-1111-4111-8111-111111111111',
    ownerId: '22222222-2222-4222-8222-222222222222',
    status: { in: OPEN_SESSION_STATUSES },
  });
});

test('reclaim is a read-only snapshot with lifecycle status and the expected lease owner', async () => {
  const sessionId = '11111111-1111-4111-8111-111111111111';
  let transactionCalls = 0;
  const prisma = {
    session: {
      findMany: async () => [
        {
          id: sessionId,
          ownerId: '22222222-2222-4222-8222-222222222222',
          status: RunStatus.AWAITING_INPUT,
          provider: 'codex',
          providerBuiltin: true,
          model: null,
          permissionMode: null,
          effort: null,
          title: 'idle session',
          runtimeSessionId: null,
          claudeSessionId: null,
          inboxLeaseOwner: LEASE_OWNER,
          branch: null,
          mergeTarget: null,
          agentId: null,
          taskId: null,
          agent: null,
        },
      ],
    },
    user: { findUnique: async () => null },
    runEvent: { aggregate: async () => ({ _max: { seq: null } }) },
    $transaction: async () => {
      transactionCalls += 1;
      throw new Error('reclaim must not mutate lease state');
    },
  } as never;
  const controller = new RunnerApiController(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const first = await controller.reclaim({
    id: '33333333-3333-4333-8333-333333333333',
    ownerId: '22222222-2222-4222-8222-222222222222',
  });
  const delayedRetry = await controller.reclaim({
    id: '33333333-3333-4333-8333-333333333333',
    ownerId: '22222222-2222-4222-8222-222222222222',
  });

  assert.equal(first.sessions[0]?.sessionId, sessionId);
  assert.equal(first.sessions[0]?.status, RunStatus.AWAITING_INPUT);
  assert.equal(first.sessions[0]?.leaseOwner, LEASE_OWNER);
  assert.deepEqual(delayedRetry, first);
  assert.equal(transactionCalls, 0);
});
