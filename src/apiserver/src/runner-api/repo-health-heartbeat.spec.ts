import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunnerStatus } from '@orbit/shared';
import { RunnerApiController } from './runner-api.controller';

const RUNNER_ID = '11111111-1111-4111-8111-111111111111';

/** A heartbeat harness whose runner row can be seeded, so the cleanup relay can be driven. */
function harness(row: Record<string, unknown> = {}) {
  const writes: Array<Record<string, unknown>> = [];
  const prisma = {
    runner: {
      update: async ({ data }: { data: Record<string, unknown> }) => {
        writes.push(data);
        Object.assign(row, data);
        return { maxConcurrent: 2, ...row };
      },
      findUnique: async () => row,
    },
    // The heartbeat also lists this runner's agents (the workDir probe targets). It shares one
    // try/catch with the relays, so a missing stub here would swallow them instead of failing.
    agent: { findMany: async () => [] },
  } as never;
  const realtime = {
    drainCancellations: async () => [],
    drainMergeRequests: async () => [],
    drainCommitRequests: async () => [],
    drainArtifactRequests: async () => [],
  } as never;
  return {
    api: new RunnerApiController(prisma, {} as never, realtime, {} as never, {} as never),
    writes,
    row,
  };
}

const beat = (extra: Record<string, unknown> = {}) => ({
  status: RunnerStatus.ONLINE,
  idleCapacity: 1,
  ...extra,
});

test('heartbeat stores the reported checkout health, dropping unusable entries', async () => {
  const h = harness();
  await h.api.heartbeat(
    { id: RUNNER_ID, version: null },
    beat({
      repos: [
        {
          root: '/root/orbit',
          branch: 'main',
          state: 'unmerged',
          paths: ['src/a.swift'],
          agentIds: ['agent-1', 'agent-2'],
        },
        { root: '/root/other', state: 'not-a-state' }, // unknown state → dropped, not repaired
        { state: 'clean' }, // no root → dropped
      ] as never,
    }),
  );

  assert.deepEqual(h.writes[0].repoHealth, [
    {
      root: '/root/orbit',
      state: 'unmerged',
      branch: 'main',
      paths: ['src/a.swift'],
      agentIds: ['agent-1', 'agent-2'],
    },
  ]);
});

test('an older runner omitting the report leaves the stored snapshot alone', async () => {
  const h = harness();
  await h.api.heartbeat({ id: RUNNER_ID, version: null }, beat());
  assert.equal(h.writes[0].repoHealth, undefined);
});

test('a pending cleanup is delivered to the runner and echoes the root it named', async () => {
  const h = harness({
    repoCleanupStatus: 'pending',
    repoCleanupRoot: '/root/orbit',
    repoCleanupAt: new Date(),
  });
  const res = await h.api.heartbeat({ id: RUNNER_ID, version: null }, beat());
  assert.equal(res.repoCleanupRequest?.root, '/root/orbit');
});

test('no cleanup is delivered once the relay has reported', async () => {
  const h = harness({ repoCleanupStatus: 'done', repoCleanupRoot: '/root/orbit' });
  const res = await h.api.heartbeat({ id: RUNNER_ID, version: null }, beat());
  assert.equal(res.repoCleanupRequest, undefined);
});

test('an abandoned cleanup is swept instead of blocking the next attempt', async () => {
  const h = harness({
    repoCleanupStatus: 'pending',
    repoCleanupRoot: '/root/orbit',
    repoCleanupAt: new Date(Date.now() - 10 * 60_000),
  });
  const res = await h.api.heartbeat({ id: RUNNER_ID, version: null }, beat());
  assert.equal(res.repoCleanupRequest, undefined);
  assert.equal(h.row.repoCleanupStatus, 'failed');
});

// The warning has to clear the moment the repair lands: waiting for the runner's next scan would
// leave a banner insisting merges are blocked for a minute after they aren't.
test('a cleanup result corrects the stored health for that checkout', async () => {
  const h = harness({
    repoHealth: [
      { root: '/root/orbit', state: 'unmerged', paths: ['src/a.swift'], agentIds: ['agent-1'] },
      { root: '/root/other', state: 'dirty', paths: ['x.txt'] },
    ],
  });
  await h.api.repoCleanupResult(
    { id: RUNNER_ID },
    {
      root: '/root/orbit',
      status: 'done',
      state: 'clean',
      rescueBranch: 'orbit/rescue-abc1234',
      message: 'checkout restored',
    },
  );
  assert.deepEqual(h.row.repoHealth, [
    { root: '/root/orbit', state: 'clean', paths: [], agentIds: ['agent-1'] },
    { root: '/root/other', state: 'dirty', paths: ['x.txt'] },
  ]);
  assert.equal(h.row.repoCleanupBranch, 'orbit/rescue-abc1234');
  assert.equal(h.row.repoCleanupStatus, 'done');
});
