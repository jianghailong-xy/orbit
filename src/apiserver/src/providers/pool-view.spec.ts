import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AgentProvider, type PlanUsageSnapshot } from '@orbit/shared';
import { ProvidersService } from './providers.service';

/**
 * What GET /providers/pools says about a pool: each member's own quota and where it stands, the member a
 * session starting now would run on, and when a fully spent pool frees up. The database half — the
 * query, the HTTP payload, the keys it must never carry — is provider-pool-usage.pg.spec.ts.
 */

const HOUR = 60 * 60 * 1000;
const at = (offset: number) => new Date(Date.now() + offset).toISOString();
const fiveHour = (utilization: number, resetsAt = at(2 * HOUR)): PlanUsageSnapshot => ({
  provider: AgentProvider.CLAUDE,
  fiveHour: { utilization, resetsAt },
});

const member = (id: string, over: { enabled?: boolean } = {}) => ({
  provider: {
    id,
    slug: `slug-${id}`,
    label: id,
    presetSlug: 'anthropic',
    enabled: over.enabled ?? true,
    ownerId: 'user-1',
    runtime: 'claude',
    baseUrl: 'https://api.anthropic.com',
    apiKeyEnc: `ciphertext-of-${id}`,
  },
});

const POOL = 'pool-slug';

function listPools(
  members: ReturnType<typeof member>[],
  usage: Record<string, PlanUsageSnapshot>,
  { refused = [] as string[], running = [] as { provider: string; poolMemberProviderId: string | null }[] } = {},
) {
  const pools = [{ id: 'pool-1', slug: POOL, label: 'Claude accounts', createdAt: new Date(0), updatedAt: new Date(0), members }];
  return new ProvidersService(
    {
      providerPool: { findMany: async () => pools },
      session: { findMany: async () => running },
    } as never,
    {} as never,
    {
      snapshot: (row: { id: string }) => usage[row.id] ?? null,
      refused: (row: { id: string }) => refused.includes(row.id),
    } as never,
  ).listPools('user-1');
}

const states = (pool: { members: { label: string; state: string }[] }) =>
  Object.fromEntries(pool.members.map((m) => [m.label, m.state]));
const next = (pool: { members: { label: string; next: boolean }[] }) =>
  pool.members.filter((m) => m.next).map((m) => m.label);

test("the pool's next member is the one with the most 5-hour room, not an average of them", async () => {
  // One account spent and one untouched average to 50% — and no account is at 50%.
  const [pool] = await listPools([member('spent'), member('fresh')], {
    spent: fiveHour(100, at(HOUR)),
    fresh: fiveHour(0),
  });
  assert.deepEqual(next(pool), ['fresh']);
  assert.deepEqual(states(pool), { spent: 'SPENT', fresh: 'AVAILABLE' });
  // Each member carries its own snapshot, so the page draws the chosen member's own gauge.
  assert.deepEqual(pool.members.map((m) => m.planUsage?.fiveHour?.utilization), [100, 0]);
  assert.equal(pool.resetsAt, null, 'a pool with room waits on no reset');
});

test('a fully spent pool frees up at the EARLIEST member reset; each member keeps its own', async () => {
  const late = at(4 * HOUR);
  const early = at(HOUR);
  const [pool] = await listPools([member('late'), member('early')], {
    late: fiveHour(100, late),
    early: fiveHour(100, early),
  });
  assert.equal(pool.resetsAt, early);
  assert.deepEqual(next(pool), []);
  assert.deepEqual(
    pool.members.map((m) => [m.label, m.state, m.resetsAt]),
    [
      ['late', 'SPENT', late],
      ['early', 'SPENT', early],
    ],
  );
});

test('a member that reports no quota is last in line, not idle at 0%', async () => {
  const [pool] = await listPools([member('silent'), member('busy')], { busy: fiveHour(85) });
  assert.deepEqual(next(pool), ['busy']);
  assert.deepEqual(states(pool), { silent: 'NO_QUOTA', busy: 'AVAILABLE' });
  assert.equal(pool.members[0].planUsage, null);

  // …and still the pool's next member once nothing else can run.
  const [alone] = await listPools([member('silent'), member('spent')], { spent: fiveHour(100) });
  assert.deepEqual(next(alone), ['silent']);
});

test('a refused key or a disabled row never reads as available, whatever it last reported', async () => {
  const [pool] = await listPools(
    [member('refused'), member('off', { enabled: false }), member('open')],
    { refused: fiveHour(0), off: fiveHour(0), open: fiveHour(90) },
    { refused: ['refused'] },
  );
  assert.deepEqual(states(pool), { refused: 'REFUSED', off: 'DISABLED', open: 'AVAILABLE' });
  assert.deepEqual(next(pool), ['open']);
});

test('a member some session is generating on right now is Running now', async () => {
  const [pool] = await listPools([member('a'), member('b'), member('c')], { a: fiveHour(10), b: fiveHour(20), c: fiveHour(30) }, {
    running: [
      // Through the pool: the member its last claim chose.
      { provider: POOL, poolMemberProviderId: 'b' },
      // Pinned to a member's own slug.
      { provider: 'slug-c', poolMemberProviderId: null },
    ],
  });
  assert.deepEqual(states(pool), { a: 'AVAILABLE', b: 'RUNNING', c: 'RUNNING' });
  // Busy is not full: the member with the most room is still the next one.
  assert.deepEqual(next(pool), ['a']);
});

test('a member view carries neither the key nor the endpoint', async () => {
  const pools = await listPools([member('a')], { a: fiveHour(10) });
  const text = JSON.stringify(pools);
  for (const leak of ['apiKeyEnc', 'ciphertext-of-a', 'baseUrl', 'api.anthropic.com', 'ownerId']) {
    assert.equal(text.includes(leak), false, `${leak} must not reach the browser`);
  }
});
