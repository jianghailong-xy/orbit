import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpException } from '@nestjs/common';
import { AgentProvider } from '@orbit/shared';
import { RunnerApiController } from './runner-api.controller';
import { OPENCODE_RUNNER_UPGRADE_ERROR } from './runner-provider-support';

const RUNNER = {
  id: '11111111-1111-4111-8111-111111111111',
  ownerId: '22222222-2222-4222-8222-222222222222',
};

test('legacy claim refuses pending OpenCode before the queue can transition it to RUNNING', async () => {
  let queueCalled = false;
  let storedError: string | undefined;
  const published: string[] = [];
  const prisma = {
    session: {
      findMany: async () => [{ id: 'session-1', error: null }],
      updateMany: async ({ data }: { data: { error: string } }) => {
        storedError = data.error;
        return { count: 1 };
      },
    },
  } as never;
  const queue = {
    claimSessionForRunner: async () => {
      queueCalled = true;
      return null;
    },
  } as never;
  const realtime = { publishSessionCreated: (id: string) => published.push(id) } as never;
  const controller = new RunnerApiController(prisma, queue, realtime, {} as never, {} as never);

  await assert.rejects(
    controller.claim(RUNNER, undefined, 'claude,codex'),
    (error: unknown) =>
      error instanceof HttpException &&
      error.getStatus() === 426 &&
      error.message === OPENCODE_RUNNER_UPGRADE_ERROR,
  );
  assert.equal(queueCalled, false);
  assert.equal(storedError, OPENCODE_RUNNER_UPGRADE_ERROR);
  assert.deepEqual(published, ['session-1']);
});

test('current claim advertises OpenCode directly to the atomic queue gate', async () => {
  let advertised: readonly AgentProvider[] | undefined;
  const queue = {
    claimSessionForRunner: async (runner: { supportedProviders?: readonly AgentProvider[] }) => {
      advertised = runner.supportedProviders;
      return null;
    },
  } as never;
  const controller = new RunnerApiController(
    { session: { findMany: async () => assert.fail('capable runner should not need a preflight') } } as never,
    queue,
    {} as never,
    {} as never,
    {} as never,
  );

  assert.equal(await controller.claim(RUNNER, undefined, 'claude,codex,opencode'), null);
  assert.deepEqual(advertised, [AgentProvider.CLAUDE, AgentProvider.CODEX, AgentProvider.OPENCODE]);
});

test('legacy reclaim rejects one full OpenCode snapshot before releasing leases', async () => {
  let leasesTouched = false;
  let upgradeMarked = false;
  const published: string[] = [];
  const prisma = {
    session: {
      findMany: async () => [
        {
          id: 'session-1',
          provider: AgentProvider.OPENCODE,
          status: 'PENDING',
          cancelRequestedAt: null,
          error: null,
          agent: null,
        },
      ],
      updateMany: async () => {
        upgradeMarked = true;
        return { count: 1 };
      },
    },
    conversationTurn: {
      updateMany: async () => {
        leasesTouched = true;
      },
    },
  } as never;
  const realtime = { publishSessionCreated: (id: string) => published.push(id) } as never;
  const controller = new RunnerApiController(prisma, {} as never, realtime, {} as never, {} as never);

  await assert.rejects(
    controller.reclaim(RUNNER, undefined, 'claude,codex'),
    (error: unknown) => error instanceof HttpException && error.getStatus() === 426,
  );
  assert.equal(leasesTouched, false);
  assert.equal(upgradeMarked, true);
  assert.deepEqual(published, ['session-1']);
});
