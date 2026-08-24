import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunnerStatus } from '@orbit/shared';
import { RunnerApiController } from './runner-api.controller';

const RUNNER_ID = '11111111-1111-4111-8111-111111111111';

/** The heartbeat's runner row, so what the beat wrote to it can be read back. */
function harness(row: Record<string, unknown> = {}) {
  const writes: Array<Record<string, unknown>> = [];
  const prisma = {
    runner: {
      update: async ({ data }: { data: Record<string, unknown> }) => {
        writes.push(data);
        // `undefined` is Prisma's "don't touch this column", which is the whole mechanism under
        // test here — so the stored row has to model it, not overwrite the value with undefined.
        for (const [column, value] of Object.entries(data)) {
          if (value !== undefined) row[column] = value;
        }
        return { maxConcurrent: 2, ...row };
      },
      findUnique: async () => row,
    },
    workspace: { findMany: async () => [] },
  } as never;
  const realtime = {
    drainCancellations: async () => [],
    drainMergeRequests: async () => [],
    drainCommitRequests: async () => [],
    drainArtifactRequests: async () => [],
  } as never;
  return {
    api: new RunnerApiController(prisma, {} as never, realtime, {} as never, {} as never, {} as never, { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never),
    writes,
    row,
  };
}

const beat = (extra: Record<string, unknown> = {}) => ({
  status: RunnerStatus.ONLINE,
  idleCapacity: 1,
  ...extra,
});

// The root is what makes a machine a possible clone target: a workspace created from a git URL
// gets its checkout at <reposRoot>/<owner>-<repo>, and only the machine can say where that is.
test('a heartbeat records the root this machine clones into', async () => {
  const h = harness();
  await h.api.heartbeat({ id: RUNNER_ID, version: null }, beat({ reposRoot: '/home/u/orbit-repos' }));
  assert.equal(h.writes[0].reposRoot, '/home/u/orbit-repos');
  assert.equal(h.row.reposRoot, '/home/u/orbit-repos');
});

// NULL means "this machine never told us where it clones", and the answer to that is to leave it
// off the clone targets — not to keep guessing from a value it no longer reports, and not to store
// an empty root that reads like an answer.
test('a runner that reports no root leaves the stored value alone', async () => {
  const h = harness({ reposRoot: '/home/u/orbit-repos' });
  await h.api.heartbeat({ id: RUNNER_ID, version: null }, beat()); // an older binary: field absent
  assert.equal(h.writes[0].reposRoot, undefined);
  assert.equal(h.row.reposRoot, '/home/u/orbit-repos');

  await h.api.heartbeat({ id: RUNNER_ID, version: null }, beat({ reposRoot: '' }));
  assert.equal(h.writes[1].reposRoot, undefined);
  assert.equal(h.row.reposRoot, '/home/u/orbit-repos');
});
