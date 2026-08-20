import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunnerStatus } from '@orbit/shared';
import { RunnerApiController } from './runner-api.controller';

const RUNNER_ID = '11111111-1111-4111-8111-111111111111';

function harness() {
  const writes: Array<Record<string, unknown>> = [];
  const prisma = {
    runner: {
      update: async ({ data }: { data: Record<string, unknown> }) => {
        writes.push(data);
        return { maxConcurrent: 2 };
      },
      findUnique: async () => null,
    },
  } as never;
  const realtime = {
    drainCancellations: async () => [],
    drainMergeRequests: async () => [],
    drainCommitRequests: async () => [],
    drainArtifactRequests: async () => [],
  } as never;
  return {
    api: new RunnerApiController(prisma, {} as never, realtime, {} as never, {} as never, {} as never, {} as never),
    writes,
  };
}

test('heartbeat stores a sanitized runtime default snapshot', async () => {
  const h = harness();
  await h.api.heartbeat(
    { id: RUNNER_ID, version: null },
    {
      status: RunnerStatus.ONLINE,
      idleCapacity: 1,
      runtimeDefaultModels: {
        claude: '  claude-opus-5  ',
        codex: 'gpt-5.6-sol',
        kimi: 'kimi-code/kimi-for-coding',
        ignored: 'not-a-runtime',
      } as never,
    },
  );

  assert.deepEqual(h.writes[0].runtimeDefaultModels, {
    claude: 'claude-opus-5',
    codex: 'gpt-5.6-sol',
    kimi: 'kimi-code/kimi-for-coding',
  });
});

test('legacy heartbeat omission preserves the previous runtime default snapshot', async () => {
  const h = harness();
  await h.api.heartbeat({ id: RUNNER_ID, version: null }, { status: RunnerStatus.ONLINE, idleCapacity: 1 });
  assert.equal(h.writes[0].runtimeDefaultModels, undefined);
});

test('pre-probe null from a new runner also preserves the previous snapshot', async () => {
  const h = harness();
  await h.api.heartbeat(
    { id: RUNNER_ID, version: null },
    {
      status: RunnerStatus.ONLINE,
      idleCapacity: 1,
      runtimeDefaultModels: null,
    } as never,
  );
  assert.equal(h.writes[0].runtimeDefaultModels, undefined);
});

test('explicit empty runtime defaults clear the cached snapshot', async () => {
  const h = harness();
  await h.api.heartbeat(
    { id: RUNNER_ID, version: null },
    {
      status: RunnerStatus.ONLINE,
      idleCapacity: 1,
      runtimeDefaultModels: {},
    },
  );
  assert.deepEqual(h.writes[0].runtimeDefaultModels, {});
});
