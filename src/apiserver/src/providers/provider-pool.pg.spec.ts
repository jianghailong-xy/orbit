import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { probesSubscriptionUsage } from './plan-usage';
import { decryptSecret, encryptSecret } from './provider-crypto';
import { ProvidersService } from './providers.service';

/**
 * Account pools (migration 0265) against a real PostgreSQL.
 *
 * Most of what makes a pool safe to dispatch under is held by the database, so only a database can
 * show it: the member row's two composite foreign keys are what tie a member to its pool's owner and
 * keep a shared provider out, and the dispatch-slug guard triggers are what keep one name from
 * meaning a pool and a provider at once. The service half — the free slug it picks, and the reason it
 * gives for refusing a provider — is asserted beside it, and each refusal is paired with the same
 * write going through, so a write that fails for some other reason cannot pass for a refusal.
 *
 * Needs COORDINATOR_PG_URL (scripts/run-pg-spec.sh provides a disposable one); without it every case
 * reports as skipped, and that script counts a skip as red.
 */

const PG_URL = process.env.COORDINATOR_PG_URL;
const skip = !PG_URL;

const ANTHROPIC = 'https://api.anthropic.com';
/** A Claude subscription token's shape. Nothing here sends it anywhere. */
const subscriptionToken = () => `sk-ant-oat01-${randomUUID()}`;

interface PoolRefusal {
  code: string;
  reason: string;
  providerId: string;
  message: string;
}

/** The body a refused pool write came back with; fails if the write was accepted instead. */
async function refusalOf(write: Promise<unknown>): Promise<PoolRefusal> {
  try {
    await write;
  } catch (e) {
    assert.ok(e instanceof BadRequestException, `expected a 400 refusal, got ${String(e)}`);
    return e.getResponse() as PoolRefusal;
  }
  assert.fail('the write was accepted');
}

/** A driver error carrying this SQLSTATE, and this constraint when one is named. */
const pgError = (code: string, constraint?: string) => (e: unknown) => {
  const error = e as { code?: string; constraint?: string };
  assert.equal(error.code, code, String(e));
  if (constraint) assert.equal(error.constraint, constraint, String(e));
  return true;
};

test('account pools against PostgreSQL', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
  const url = PG_URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma = new PrismaClient({ adapter: new PrismaPg(url) });
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  // What every stored credential is encrypted under; any value does in a throwaway database.
  process.env.PROVIDER_SECRET_KEY ??= 'provider-pool-pg-spec';
  const realtime = { publishForUser: () => undefined, publishForAllUsers: () => undefined };
  // The pool list reads each member's quota; nothing here is about quota, so every member has none.
  const planUsage = { snapshot: () => null, refused: () => false };
  const service = new ProvidersService(prisma as unknown as PrismaService, realtime as never, planUsage as never);

  const newUser = async (name: string) =>
    (await prisma.user.create({
      data: { email: `pool-${name}-${randomUUID()}@example.invalid`, name, passwordHash: 'not-a-login' },
    })).id;
  const alice = await newUser('alice');
  const bob = await newUser('bob');

  /** A provider connected the way the /providers form connects one: the Anthropic preset for
   *  Anthropic's own endpoint, a custom Claude-dialect endpoint for anything else. */
  const connect = (ownerId: string | null, label: string, apiKey: string, baseUrl = ANTHROPIC) =>
    service.create(
      ownerId,
      baseUrl === ANTHROPIC
        ? { label, baseUrl, apiKey, presetSlug: 'anthropic' }
        : { label, baseUrl, apiKey, runtime: 'claude' },
    );
  const sorted = (ids: string[]) => [...ids].sort();
  const memberIds = (pool: { members: { id: string }[] }) => sorted(pool.members.map((member) => member.id));
  /** The membership as the table holds it, read over the second connection. */
  const memberRows = async (poolId: string) =>
    (await sql.query<{ provider_id: string; owner_id: string }>(
      'SELECT provider_id, owner_id FROM provider_pool_member WHERE pool_id = $1 ORDER BY provider_id',
      [poolId],
    )).rows;
  const rawMember = (poolId: string, providerId: string, ownerId: string) =>
    sql.query('INSERT INTO provider_pool_member (pool_id, provider_id, owner_id) VALUES ($1, $2, $3)', [
      poolId,
      providerId,
      ownerId,
    ]);
  const poolsLabelled = async (label: string) =>
    (await sql.query('SELECT 1 FROM provider_pool WHERE label = $1', [label])).rowCount;

  await t.test('0265 replayed onto this server, with both halves of the slug guard installed', async () => {
    const applied = await sql.query(
      `SELECT finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
         FROM _prisma_migrations WHERE migration_name = '0265_provider_pool'`,
    );
    assert.deepEqual(applied.rows, [{ finished: true, rolled_back: false }]);
    const guards = await sql.query(
      `SELECT c.relname AS relation, t.tgname AS trigger
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND t.tgname LIKE '%dispatch_slug_guard'
        ORDER BY 1`,
    );
    assert.deepEqual(guards.rows, [
      { relation: 'model_provider', trigger: 'model_provider_dispatch_slug_guard' },
      { relation: 'provider_pool', trigger: 'provider_pool_dispatch_slug_guard' },
    ]);
  });

  await t.test('(1) two subscription providers join a pool, and the membership reads back as written', async () => {
    const work = await connect(alice, 'Work', subscriptionToken());
    const home = await connect(alice, 'Home', subscriptionToken());
    const pool = await service.createPool(alice, { label: 'Claude accounts', providerIds: [work.id, home.id] });
    assert.deepEqual(memberIds(pool), sorted([work.id, home.id]));
    // The list says more than the write — where each member stands (provider-pool-usage.pg.spec.ts) — and
    // everything the write returned it says the same.
    const listed = (await service.listPools(alice)).map(({ resetsAt: _resetsAt, unavailable: _unavailable, members, ...rest }) => ({
      ...rest,
      members: members.map(({ id, slug, label }) => ({ id, slug, label })),
    }));
    assert.deepEqual(listed, [pool], 'the list reads back exactly what the write returned');
    assert.deepEqual(await service.listPools(bob), [], 'and to its owner only');
    assert.deepEqual(
      await memberRows(pool.id),
      sorted([work.id, home.id]).map((id) => ({ provider_id: id, owner_id: alice })),
    );

    // An identity added, none taken away: both members keep their own slug and their own row, so
    // either one can still be pinned by itself.
    assert.ok(![work.slug, home.slug].includes(pool.slug));
    const mine = await service.listMine(alice);
    for (const member of [work, home]) {
      assert.equal(mine.find((row) => row.id === member.id)?.slug, member.slug);
    }

    // Out, back in, and in again — the second add changes nothing.
    assert.deepEqual(memberIds(await service.removePoolMember(alice, pool.id, home.id)), [work.id]);
    assert.deepEqual(await memberRows(pool.id), [{ provider_id: work.id, owner_id: alice }]);
    assert.deepEqual(memberIds(await service.addPoolMember(alice, pool.id, home.id)), sorted([work.id, home.id]));
    assert.deepEqual(memberIds(await service.addPoolMember(alice, pool.id, home.id)), sorted([work.id, home.id]));
    assert.equal((await memberRows(pool.id)).length, 2);

    // Deleting a provider takes it out of its pool; deleting the pool leaves its members standing.
    await service.remove(alice, home.id);
    assert.deepEqual((await service.listPools(alice)).map(memberIds), [[work.id]]);
    await service.removePool(alice, pool.id);
    assert.deepEqual(await service.listPools(alice), []);
    assert.equal((await service.listMine(alice)).some((row) => row.id === work.id), true);
  });

  await t.test("(2) a pool's slug and its members' slugs come out of one unique namespace", async () => {
    const probe = (ownerId: string) =>
      service.create(ownerId, { label: 'Namespace probe', baseUrl: ANTHROPIC, apiKey: subscriptionToken(), runtime: 'claude' });
    const first = await probe(alice);
    const second = await probe(bob);
    assert.deepEqual([first.slug, second.slug], ['namespace-probe', 'namespace-probe-2']);
    const pool = await service.createPool(alice, { label: 'Namespace probe', providerIds: [first.id] });
    assert.equal(pool.slug, 'namespace-probe-3', "suffixed past both providers, whoever's they are");
    const third = await probe(alice);
    assert.equal(third.slug, 'namespace-probe-4', 'and the next provider is suffixed past the pool');
    // The runtime keywords are reserved for a pool exactly as they are for a provider.
    assert.equal((await service.createPool(alice, { label: 'Claude' })).slug, 'claude-2');

    // Picking a free slug is the service's half. The database refuses the collision however a row
    // arrives — in either direction, on UPDATE as on INSERT — and the same statement with a free
    // slug goes through.
    const rawPool = (slug: string) =>
      sql.query(`INSERT INTO provider_pool (id, slug, label, owner_id, updated_at) VALUES ($1, $2, 'raw', $3, now())`, [
        randomUUID(),
        slug,
        alice,
      ]);
    await rawPool('namespace-probe-raw');
    await assert.rejects(rawPool(first.slug), pgError('23505', 'provider_dispatch_slug_key'));
    await assert.rejects(
      sql.query('UPDATE provider_pool SET slug = $1 WHERE id = $2', [third.slug, pool.id]),
      pgError('23505', 'provider_dispatch_slug_key'),
    );
    await assert.rejects(
      sql.query('UPDATE model_provider SET slug = $1 WHERE id = $2', [pool.slug, second.id]),
      pgError('23505', 'provider_dispatch_slug_key'),
    );
    // Through Prisma it surfaces as the unique violation ProvidersService already re-picks on, so a
    // pool and a provider racing for one name end the way two providers racing for it always have.
    await assert.rejects(
      prisma.modelProvider.create({
        data: {
          slug: pool.slug,
          label: 'raw',
          baseUrl: ANTHROPIC,
          apiKeyEnc: encryptSecret(subscriptionToken()),
          ownerId: bob,
        },
      }),
      (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002',
    );
  });

  await t.test("(3) another owner's provider is refused", async () => {
    const own = await connect(alice, 'Alice subscription', subscriptionToken());
    const ownToo = await connect(alice, 'Alice second subscription', subscriptionToken());
    const theirs = await connect(bob, 'Bob subscription', subscriptionToken());

    // Not found, as every other owner-scoped write here answers: alice learns nothing about bob's
    // row. The same call without it goes through.
    await assert.rejects(
      service.createPool(alice, { label: 'Borrowed', providerIds: [own.id, theirs.id] }),
      NotFoundException,
    );
    assert.equal(await poolsLabelled('Borrowed'), 0, 'a refused create writes no pool');
    const pool = await service.createPool(alice, { label: 'Borrowed', providerIds: [own.id] });
    await assert.rejects(service.addPoolMember(alice, pool.id, theirs.id), NotFoundException);
    await assert.rejects(service.addPoolMember(bob, pool.id, theirs.id), NotFoundException, "nor into alice's pool by bob");
    assert.deepEqual(await memberRows(pool.id), [{ provider_id: own.id, owner_id: alice }]);

    // The database refuses the row whichever owner it claims, because a member names its pool's
    // owner and its provider's owner in the same column.
    await assert.rejects(
      rawMember(pool.id, theirs.id, alice),
      pgError('23503', 'provider_pool_member_provider_id_owner_id_fkey'),
    );
    await assert.rejects(rawMember(pool.id, theirs.id, bob), pgError('23503', 'provider_pool_member_pool_id_owner_id_fkey'));
    await rawMember(pool.id, ownToo.id, alice);
    assert.deepEqual(memberIds((await service.listPools(alice)).find((row) => row.id === pool.id)!), sorted([own.id, ownToo.id]));
  });

  await t.test('(4) a shared provider (ownerId null) is refused', async () => {
    const shared = await connect(null, 'Team subscription', subscriptionToken());
    const own = await connect(alice, 'Alice own subscription', subscriptionToken());
    const loose = await connect(alice, 'Alice loose subscription', subscriptionToken());

    const refused = await refusalOf(service.createPool(alice, { label: 'With shared', providerIds: [own.id, shared.id] }));
    assert.equal(refused.reason, 'SHARED_PROVIDER');
    assert.equal(refused.providerId, shared.id);
    assert.match(refused.message, /shared/i);
    assert.equal(await poolsLabelled('With shared'), 0);
    const pool = await service.createPool(alice, { label: 'With shared', providerIds: [own.id] });
    assert.equal((await refusalOf(service.addPoolMember(alice, pool.id, shared.id))).reason, 'SHARED_PROVIDER');
    assert.deepEqual(await memberRows(pool.id), [{ provider_id: own.id, owner_id: alice }]);
    // Refused for being shared, not for its credential: the usage probe would ask about this one.
    const stored = await prisma.modelProvider.findUniqueOrThrow({ where: { id: shared.id } });
    assert.equal(probesSubscriptionUsage(stored, decryptSecret(stored.apiKeyEnc)), true);

    // No owner a member row can carry matches a NULL one.
    await assert.rejects(
      rawMember(pool.id, shared.id, alice),
      pgError('23503', 'provider_pool_member_provider_id_owner_id_fkey'),
    );
    // Nor can a member become shared underneath its pool, while a provider in no pool still can.
    await assert.rejects(
      sql.query('UPDATE model_provider SET owner_id = NULL WHERE id = $1', [own.id]),
      (e: unknown) => {
        const error = e as { code?: string; table?: string; column?: string };
        assert.deepEqual([error.code, error.table, error.column], ['23502', 'provider_pool_member', 'owner_id'], String(e));
        return true;
      },
    );
    await sql.query('UPDATE model_provider SET owner_id = NULL WHERE id = $1', [loose.id]);
  });

  await t.test('(5) a metered key or a non-Anthropic endpoint is refused, and the refusal says which', async () => {
    const good = await connect(alice, 'Admitted subscription', subscriptionToken());
    const pool = await service.createPool(alice, { label: 'Admission', providerIds: [good.id] });
    const goodRow = await prisma.modelProvider.findUniqueOrThrow({ where: { id: good.id } });
    assert.equal(probesSubscriptionUsage(goodRow, decryptSecret(goodRow.apiKeyEnc)), true);

    const refusals = [
      {
        label: 'Metered key',
        reason: 'NOT_SUBSCRIPTION_TOKEN',
        says: /Metered API key/,
        row: () => connect(alice, 'Metered key', `sk-ant-api03-${randomUUID()}`),
      },
      {
        label: 'Proxy endpoint',
        reason: 'NOT_ANTHROPIC_ENDPOINT',
        says: /api\.anthropic\.com/,
        row: () => connect(alice, 'Proxy endpoint', subscriptionToken(), 'https://api.deepseek.com/anthropic'),
      },
      {
        label: 'Lookalike host',
        reason: 'NOT_ANTHROPIC_ENDPOINT',
        says: /api\.anthropic\.com/,
        row: () => connect(alice, 'Lookalike host', subscriptionToken(), 'https://api.anthropic.com.example.net'),
      },
      {
        label: 'Codex runtime',
        reason: 'NOT_CLAUDE_RUNTIME',
        says: /Claude/,
        row: () =>
          service.create(alice, { label: 'Codex runtime', baseUrl: ANTHROPIC, apiKey: subscriptionToken(), runtime: 'codex' }),
      },
    ];
    for (const refusal of refusals) {
      const row = await refusal.row();
      const added = await refusalOf(service.addPoolMember(alice, pool.id, row.id));
      assert.deepEqual(
        { code: added.code, reason: added.reason, providerId: added.providerId },
        { code: 'PROVIDER_POOL_MEMBER_REFUSED', reason: refusal.reason, providerId: row.id },
        refusal.label,
      );
      assert.match(added.message, refusal.says, refusal.label);
      const created = await refusalOf(
        service.createPool(alice, { label: `Admission: ${refusal.label}`, providerIds: [good.id, row.id] }),
      );
      assert.equal(created.reason, refusal.reason, refusal.label);
      assert.equal(await poolsLabelled(`Admission: ${refusal.label}`), 0, refusal.label);
      // The same verdict the usage probe reaches, because it is the same test: a row refused here is
      // a row plan-usage never asks about, and so one that could only ever sit in a pool unchosen.
      const stored = await prisma.modelProvider.findUniqueOrThrow({ where: { id: row.id } });
      assert.equal(probesSubscriptionUsage(stored, decryptSecret(stored.apiKeyEnc)), false, refusal.label);
    }

    // A key the server cannot decrypt cannot be judged, and is refused as that rather than as a 500.
    const unreadable = await prisma.modelProvider.create({
      data: { slug: 'unreadable-key', label: 'Unreadable key', baseUrl: ANTHROPIC, apiKeyEnc: 'not:a:ciphertext', ownerId: alice },
    });
    assert.equal((await refusalOf(service.addPoolMember(alice, pool.id, unreadable.id))).reason, 'KEY_UNREADABLE');

    assert.deepEqual(await memberRows(pool.id), [{ provider_id: good.id, owner_id: alice }], 'no refusal wrote a member');
  });
});
