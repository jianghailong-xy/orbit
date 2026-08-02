import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { AgentProvider } from '@orbit/shared';
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

test('reclaim preserves lease state and snapshots an inherited runtime model once', async () => {
  const sessionId = '11111111-1111-4111-8111-111111111111';
  let transactionCalls = 0;
  let storedModel: string | null = null;
  const modelWrites: string[] = [];
  const prisma = {
    session: {
      findMany: async () => [
        {
          id: sessionId,
          ownerId: '22222222-2222-4222-8222-222222222222',
          status: RunStatus.AWAITING_INPUT,
          provider: 'codex',
          providerBuiltin: true,
          model: storedModel,
          permissionMode: null,
          effort: null,
          title: 'idle session',
          runtimeSessionId: null,
          inboxLeaseOwner: LEASE_OWNER,
          branch: null,
          mergeTarget: null,
          agentId: null,
          taskId: null,
          agent: null,
          assignedRunner: {
            runtimeDefaultModels: { codex: 'gpt-runtime-default' },
            modelCatalog: { codex: [{ value: 'gpt-catalog', label: 'Catalog' }] },
          },
        },
      ],
      findUniqueOrThrow: async () => ({ model: storedModel }),
    },
    user: { findUnique: async () => null },
    runEvent: { aggregate: async () => ({ _max: { seq: null } }) },
    $transaction: async () => {
      transactionCalls += 1;
      throw new Error('reclaim must not mutate lease state');
    },
    $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      if (storedModel !== null) return 0;
      storedModel = values[0] as string;
      modelWrites.push(storedModel);
      return 1;
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
  assert.equal(first.sessions[0]?.agent.model, 'gpt-runtime-default');
  assert.deepEqual(delayedRetry, first);
  assert.equal(transactionCalls, 0);
  assert.deepEqual(modelWrites, ['gpt-runtime-default']);
});

test('a concurrent Session model edit wins reclaim materialization', async () => {
  const sessionId = '11111111-1111-4111-8111-111111111111';
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
          title: 'edited session',
          runtimeSessionId: null,
          inboxLeaseOwner: LEASE_OWNER,
          branch: null,
          mergeTarget: null,
          agentId: null,
          taskId: null,
          agent: null,
          assignedRunner: {
            runtimeDefaultModels: { codex: 'gpt-runtime-default' },
            modelCatalog: null,
          },
        },
      ],
      findUniqueOrThrow: async () => ({ model: 'gpt-user-choice' }),
    },
    user: { findUnique: async () => null },
    runEvent: { aggregate: async () => ({ _max: { seq: null } }) },
    $executeRaw: async () => 0,
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

  assert.equal(result.sessions[0]?.agent.model, 'gpt-user-choice');
});

test('session meta preserves the OpenCode runtime provider', async () => {
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const runnerId = '22222222-2222-4222-8222-222222222222';
  const prisma = {
    session: {
      findUnique: async () => ({
        id: sessionId,
        assignedRunnerId: runnerId,
        provider: AgentProvider.OPENCODE,
        runtimeSessionId: 'opencode-runtime-1',
        claudeSessionId: null,
        agentId: null,
        title: 'OpenCode session',
      }),
    },
  } as never;
  const controller = new RunnerApiController(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  assert.deepEqual(await controller.getSessionMeta({ id: runnerId }, sessionId), {
    provider: AgentProvider.OPENCODE,
    sessionUuid: 'opencode-runtime-1',
    runtimeSessionId: 'opencode-runtime-1',
    workDir: null,
    title: 'OpenCode session',
  });
});
