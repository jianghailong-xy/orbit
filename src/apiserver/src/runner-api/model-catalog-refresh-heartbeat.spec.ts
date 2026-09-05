import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunnerStatus } from '@orbit/shared';
import { RunnerApiController } from './runner-api.controller';

const RUNNER_ID = '11111111-1111-4111-8111-111111111111';

/**
 * The heartbeat, with a runner row that may or may not be carrying a refresh request.
 *
 * `updateMany` stands in for the conditional UPDATE the drain runs: it reports one row matched
 * while a request is pending, and none once it has been handed over — which is exactly what
 * PostgreSQL does to a second beat racing the first.
 */
function harness(pending: boolean) {
  // The stored column, so `updateMany` answers from the row's state rather than from a call
  // count: a drain that stopped predicating on "still pending" would then keep matching, which
  // is the failure this harness has to be able to see.
  let storedRequestAt: Date | null = pending ? new Date('2026-09-05T00:00:00.000Z') : null;
  const claims: Array<Record<string, unknown>> = [];
  const prisma = {
    runner: {
      update: async () => ({ maxConcurrent: 2 }),
      findUnique: async () => null,
      updateMany: async (args: {
        where: { id?: string; modelCatalogRefreshAt?: unknown };
        data: { modelCatalogRefreshAt?: Date | null };
      }) => {
        claims.push(args);
        if (args.where.id !== RUNNER_ID) return { count: 0 };
        const wantsPending =
          JSON.stringify(args.where.modelCatalogRefreshAt) === JSON.stringify({ not: null });
        if (wantsPending && storedRequestAt === null) return { count: 0 };
        storedRequestAt = args.data.modelCatalogRefreshAt ?? null;
        return { count: 1 };
      },
    },
    workspace: { findMany: async () => [] },
  } as never;
  const realtime = {
    drainCancellations: async () => [],
    drainMergeRequests: async () => [],
    drainCommitRequests: async () => [],
    drainArtifactRequests: async () => [],
  } as never;
  const api = new RunnerApiController(
    prisma,
    {} as never,
    realtime,
    {} as never,
    {} as never,
    {} as never,
    { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never,
  );
  const beat = () =>
    api.heartbeat({ id: RUNNER_ID, version: null }, { status: RunnerStatus.ONLINE, idleCapacity: 1 });
  return { beat, claims };
}

test('a pending refresh is handed to the next heartbeat and cleared as it goes', async () => {
  const h = harness(true);
  const resp = await h.beat();

  assert.equal(resp.refreshModelCatalog, true);
  assert.equal(h.claims.length, 1);
  // The clear IS the claim: one statement that only matches a row still holding a request.
  assert.deepEqual(h.claims[0], {
    where: { id: RUNNER_ID, modelCatalogRefreshAt: { not: null } },
    data: { modelCatalogRefreshAt: null },
  });
});

test('the request is delivered once, not on every beat until an outcome arrives', async () => {
  const h = harness(true);
  assert.equal((await h.beat()).refreshModelCatalog, true);
  // Nothing reports back — the refreshed catalog is the outcome — so a redelivered request would
  // respawn the runtime CLIs on every beat for ever.
  assert.equal((await h.beat()).refreshModelCatalog, undefined);
});

test('a runner nobody asked anything of is told nothing', async () => {
  const h = harness(false);
  assert.equal((await h.beat()).refreshModelCatalog, undefined);
});
