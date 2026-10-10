import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readLastUsed } from './provider-last-used';

const OWNER = 'owner-1';
const KEYS = [{ id: 'k1', slug: 'deepseek' }, { id: 'k2', slug: 'glm' }];
const at = (day: number) => new Date(`2026-09-${String(day).padStart(2, '0')}T12:00:00Z`);

interface Row {
  provider?: string;
  poolMemberProviderId?: string | null;
  model?: string | null;
  _max: { lastTurnAt: Date | null };
}

/** A db answering the three grouped reads by rule, recording the where each was asked with. */
function fakeDb(answers: { provider?: Row[]; poolMemberProviderId?: Row[]; model?: Row[]; pools?: Array<{ slug: string }> }) {
  const calls: Array<{ by: unknown; where: Record<string, unknown> }> = [];
  const store = {
    session: {
      groupBy: async ({ by, where }: { by: string[]; where: Record<string, unknown> }) => {
        calls.push({ by: by[0], where });
        return (answers as Record<string, Row[] | undefined>)[by[0]] ?? [];
      },
    },
    providerPool: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        calls.push({ by: 'pools', where });
        return answers.pools ?? [];
      },
    },
  };
  return { calls, db: store };
}

const whereOf = (calls: Array<{ by: unknown; where: Record<string, unknown> }>, by: string) =>
  calls.find((call) => call.by === by)?.where;

test('the newest turn on a key wins, over the owner’s own non-builtin rows only', async () => {
  const { calls, db } = fakeDb({
    provider: [
      { provider: 'deepseek', _max: { lastTurnAt: at(10) } },
      { provider: 'glm', _max: { lastTurnAt: at(3) } },
      // A slug that is not one of the caller's keys is not an answer about anything.
      { provider: 'someone-else', _max: { lastTurnAt: at(1) } },
      { provider: 'glm', _max: { lastTurnAt: null } },
    ],
  });
  const used = await readLastUsed(db as never, OWNER, KEYS);
  assert.deepEqual([...used.entries()], [['k1', at(10)], ['k2', at(3)]]);
  const where = whereOf(calls, 'provider');
  assert.equal(where?.ownerId, OWNER);
  assert.equal(where?.providerBuiltin, false);
  assert.deepEqual(where?.provider, { in: ['deepseek', 'glm'] });
  assert.deepEqual(where?.lastTurnAt, { not: null });
});

test('a pool claim counts while the session is still on one of the owner’s pools', async () => {
  const { calls, db } = fakeDb({
    pools: [{ slug: 'claude-accounts' }],
    poolMemberProviderId: [{ poolMemberProviderId: 'k1', _max: { lastTurnAt: at(20) } }],
  });
  const used = await readLastUsed(db as never, OWNER, KEYS);
  assert.deepEqual([...used.entries()], [['k1', at(20)]]);
  assert.deepEqual(whereOf(calls, 'pools'), { ownerId: OWNER, shared: false });
  const where = whereOf(calls, 'poolMemberProviderId');
  // The fence that keeps a session switched OFF the pool from crediting the member it left:
  // its `provider` must still be one of the owner's pool slugs.
  assert.deepEqual(where?.provider, { in: ['claude-accounts'] });
  assert.deepEqual(where?.poolMemberProviderId, { in: ['k1', 'k2'] });
});

test('no pool owns the caller, so the member read is not made at all', async () => {
  const { calls, db } = fakeDb({ pools: [] });
  await readLastUsed(db as never, OWNER, KEYS);
  assert.equal(whereOf(calls, 'poolMemberProviderId'), undefined);
});

test('the retired OpenCode encoding is read through the model, and only for the caller’s keys', async () => {
  const { calls, db } = fakeDb({
    model: [
      { model: 'orbit-glm/glm-5.2', _max: { lastTurnAt: at(21) } },
      { model: 'orbit-other/x', _max: { lastTurnAt: at(22) } },
      { model: null, _max: { lastTurnAt: at(23) } },
    ],
  });
  const used = await readLastUsed(db as never, OWNER, KEYS);
  assert.deepEqual([...used.entries()], [['k2', at(21)]]);
  const where = whereOf(calls, 'model');
  assert.equal(where?.provider, 'opencode');
  assert.deepEqual(where?.model, { startsWith: 'orbit-' });
});

test('the later of two rules for one key is the one reported', async () => {
  const { db } = fakeDb({
    provider: [{ provider: 'deepseek', _max: { lastTurnAt: at(5) } }],
    pools: [{ slug: 'claude-accounts' }],
    poolMemberProviderId: [{ poolMemberProviderId: 'k1', _max: { lastTurnAt: at(9) } }],
  });
  const used = await readLastUsed(db as never, OWNER, KEYS);
  assert.deepEqual([...used.entries()], [['k1', at(9)]]);
});

test('an owner with no keys reads nothing', async () => {
  const { calls, db } = fakeDb({});
  const used = await readLastUsed(db as never, OWNER, []);
  assert.equal(used.size, 0);
  assert.deepEqual(calls, []);
});
