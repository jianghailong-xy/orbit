import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrismaService } from '../prisma/prisma.service';
import { RunnersService } from './runners.service';

const OWNER = 'owner-1';
const RUNNER_ID = '11111111-1111-4111-8111-111111111111';

function harness(runner: Record<string, unknown> | null) {
  const updates: Array<Record<string, unknown>> = [];
  const prisma = {
    runner: {
      findFirst: async () => runner,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return { ...runner, ...data };
      },
    },
  } as unknown as PrismaService;
  return { service: new RunnersService(prisma), updates };
}

test('asking for a model-catalog refresh stamps the request on the runner', async () => {
  const h = harness({ id: RUNNER_ID, ownerId: OWNER, status: 'ONLINE' });
  const before = Date.now();
  const { requestedAt } = await h.service.requestModelCatalogRefresh(OWNER, RUNNER_ID);

  assert.equal(h.updates.length, 1);
  const stamped = h.updates[0].modelCatalogRefreshAt;
  assert.ok(stamped instanceof Date, 'the request is stored as a date, not a flag');
  // The returned timestamp is the stored one — it is what a caller has to identify its request.
  assert.equal(stamped.toISOString(), requestedAt);
  assert.ok(stamped.getTime() >= before);
});

test('an offline runner is refused rather than left holding a request it cannot see', async () => {
  const h = harness({ id: RUNNER_ID, ownerId: OWNER, status: 'OFFLINE' });
  await assert.rejects(
    () => h.service.requestModelCatalogRefresh(OWNER, RUNNER_ID),
    /offline/i,
  );
  assert.equal(h.updates.length, 0);
});

test('a runner that is not this owner’s is not found', async () => {
  const h = harness(null);
  await assert.rejects(
    () => h.service.requestModelCatalogRefresh(OWNER, RUNNER_ID),
    /runner not found/,
  );
  assert.equal(h.updates.length, 0);
});
