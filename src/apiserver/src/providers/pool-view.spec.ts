import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AgentProvider, type PlanUsageSnapshot } from '@orbit/shared';
import { encryptSecret } from './provider-crypto';
import { ProvidersService } from './providers.service';

// Each member's key is encrypted here and read by the pool's admission test; both only need the same secret.
process.env.PROVIDER_SECRET_KEY ??= 'pool-view-spec';

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

const member = (id: string, over: { enabled?: boolean; key?: string; baseUrl?: string } = {}) => ({
  provider: {
    id,
    slug: `slug-${id}`,
    label: id,
    presetSlug: 'anthropic',
    enabled: over.enabled ?? true,
    ownerId: 'user-1',
    runtime: 'claude',
    baseUrl: over.baseUrl ?? 'https://api.anthropic.com',
    apiKeyEnc: encryptSecret(over.key ?? `sk-ant-oat01-${id}`),
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
  const a = member('a');
  const pools = await listPools([a], { a: fiveHour(10) });
  const text = JSON.stringify(pools);
  for (const leak of ['apiKeyEnc', a.provider.apiKeyEnc, 'sk-ant', 'baseUrl', 'api.anthropic.com', 'ownerId']) {
    assert.equal(text.includes(leak), false, `${leak} must not reach the browser`);
  }
});

test('a member the pool would turn away is never next: not taken for an idle account because it reports nothing', async () => {
  // Pointed at another endpoint before edits were held to the pool's admission. The usage probe never
  // asks it, so it reports nothing — which, for a member the claim may choose, means last in line.
  const resets = at(HOUR);
  const [pool] = await listPools([member('elsewhere', { baseUrl: 'https://gateway.example.com' }), member('spent')], {
    spent: fiveHour(100, resets),
  });
  assert.deepEqual(next(pool), []);
  // What the pool waits for is the spent account's reset, not the account that can never be chosen.
  assert.equal(pool.resetsAt, resets);
  assert.equal(pool.unavailable, null, 'a spent account frees up; the pool is waiting, not unavailable');
});

test('a pool none of whose members can run says so, in the words a picker has room for; a spent one does not', async () => {
  const [none] = await listPools(
    [member('refused'), member('off', { enabled: false }), member('metered', { key: 'sk-ant-api03-metered' })],
    { refused: fiveHour(0), off: fiveHour(0) },
    { refused: ['refused'] },
  );
  assert.equal(none.unavailable, 'No account can run');
  assert.deepEqual(next(none), []);

  const [empty] = await listPools([], {});
  assert.equal(empty.unavailable, 'No accounts');

  const [spent] = await listPools([member('spent')], { spent: fiveHour(100) });
  assert.equal(spent.unavailable, null);
  const [open] = await listPools([member('open')], { open: fiveHour(10) });
  assert.equal(open.unavailable, null);
});
