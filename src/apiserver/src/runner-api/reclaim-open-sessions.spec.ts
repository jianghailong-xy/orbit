import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { OPEN_SESSION_STATUSES } from '../common/session-scheduling';
import { RunnerApiController } from './runner-api.controller';

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

test('reclaim returns lifecycle status so only RUNNING is registered active', async () => {
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const prisma = {
    session: {
      findMany: async () => [
        {
          id: sessionId,
          ownerId: '22222222-2222-4222-8222-222222222222',
          status: RunStatus.AWAITING_INPUT,
          provider: 'codex',
          model: null,
          permissionMode: null,
          effort: null,
          title: 'idle session',
          runtimeSessionId: null,
          claudeSessionId: null,
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
    conversationTurn: { updateMany: async () => ({ count: 0 }) },
  } as never;
  const controller = new RunnerApiController(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const result = await controller.reclaim({
    id: '33333333-3333-4333-8333-333333333333',
    ownerId: '22222222-2222-4222-8222-222222222222',
  });

  assert.equal(result.sessions[0]?.sessionId, sessionId);
  assert.equal(result.sessions[0]?.status, RunStatus.AWAITING_INPUT);
});
