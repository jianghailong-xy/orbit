/**
 * Account pools' admission boundary, as a regression of its own rather than a side effect of the specs
 * that built pools: a row whose credential has no 5-hour window — a metered `sk-ant-api…` key, or any
 * key pointed somewhere other than api.anthropic.com — is never asked about by the plan-usage probe and
 * never becomes a pool member, and the pool admits by the probe's own test (probesSubscriptionUsage)
 * rather than by a second copy of it that could drift.
 *
 * Both halves guard something nothing downstream asks about again. The probe sends the row's key to
 * Anthropic's usage endpoint, so probing a row that is not an Anthropic subscription hands someone
 * else's key to Anthropic. And a member the probe skips has no quota to be chosen by: admitted, it would
 * sit in the pool, never picked, with nothing to say why.
 *
 * Real ProvidersService and ProviderPlanUsageService. Only the database (an in-memory stand-in that
 * answers the few queries admission makes, and throws on any other) and the network (`fetch`) are
 * replaced. The halves that need real PostgreSQL — another owner's pool, the browser payloads, the
 * agent's env — are in pool-security-boundary.pg.spec.ts.
 */

import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { BadRequestException } from '@nestjs/common';

import { OAUTH_USAGE_URL, probesSubscriptionUsage, subscriptionUsageRefusal } from './plan-usage';
import { ProviderPlanUsageService } from './plan-usage.service';
import { encryptSecret } from './provider-crypto';
import { ProvidersService } from './providers.service';

process.env.PROVIDER_SECRET_KEY ??= 'pool-security-boundary-spec';

const OWNER = randomUUID();
const ANTHROPIC = 'https://api.anthropic.com';

interface ProviderRow {
  id: string;
  slug: string;
  label: string;
  ownerId: string | null;
  runtime: string;
  baseUrl: string;
  apiKeyEnc: string;
  enabled: boolean;
}

interface Account {
  row: ProviderRow;
  /** The plaintext key, which only the usage endpoint may ever be sent — and only for a subscription. */
  key: string;
  /** Whether it has a 5-hour window to be pooled by: a Claude subscription on Anthropic's own endpoint. */
  eligible: boolean;
}

function account(label: string, key: string, baseUrl: string, eligible: boolean): Account {
  const id = randomUUID();
  return {
    key,
    eligible,
    row: { id, slug: `t6-${id}`, label, ownerId: OWNER, runtime: 'claude', baseUrl, apiKeyEnc: encryptSecret(key), enabled: true },
  };
}

const subscription = () => `sk-ant-oat01-${randomUUID()}`;
const metered = () => `sk-ant-api03-${randomUUID()}`;

const ACCOUNTS: Account[] = [
  account('Work', subscription(), ANTHROPIC, true),
  account('Personal', subscription(), `${ANTHROPIC}/`, true),
  account('Metered key', metered(), ANTHROPIC, false),
  account('Metered key behind a gateway', metered(), 'https://gateway.example.net', false),
  account('Proxy endpoint', subscription(), 'https://api.deepseek.com/anthropic', false),
  account('Lookalike host', subscription(), 'https://api.anthropic.com.example.net', false),
  account('Anthropic as the userinfo', subscription(), 'https://api.anthropic.com@gateway.example.net', false),
  account('No scheme', subscription(), 'api.anthropic.com', false),
];
const ELIGIBLE = ACCOUNTS.filter((a) => a.eligible);
const INELIGIBLE = ACCOUNTS.filter((a) => !a.eligible);
const labels = (accounts: Account[]) => accounts.map((a) => a.row.label);

/** Every broadcast goes nowhere. */
const realtime = { publishForUser: () => undefined, publishForAllUsers: () => undefined } as never;

/**
 * The usage endpoint, recording every request that leaves the process: which URL, and which key it
 * carried. Answers a 40% five-hour window to anything, so a probe that should not have happened would
 * also produce a quota rather than fail quietly.
 */
async function withUsageEndpoint<T>(run: (sent: Array<{ url: string; key: string }>) => Promise<T>): Promise<T> {
  const sent: Array<{ url: string; key: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
    sent.push({ url: String(url), key: String(init?.headers?.authorization ?? '').replace(/^Bearer /, '') });
    const resetsAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    return new Response(JSON.stringify({ five_hour: { utilization: 40, resets_at: resetsAt } }), { status: 200 });
  }) as typeof fetch;
  try {
    return await run(sent);
  } finally {
    globalThis.fetch = original;
  }
}

/** The accounts whose key reached the usage endpoint when each one was refreshed. */
async function probed(accounts: Account[]): Promise<Account[]> {
  return withUsageEndpoint(async (sent) => {
    const usage = new ProviderPlanUsageService(realtime);
    for (const a of accounts) await usage.refresh(a.row);
    return accounts.filter((a) => sent.some((request) => request.key === a.key));
  });
}

/**
 * The database as far as admitting a pool member goes: the provider rows, and the pools and
 * memberships written. A query of any other shape throws — a change in what admission reads has to
 * surface here, not be answered by something this stand-in made up.
 */
function database(rows: ProviderRow[]) {
  const pools: Array<{ id: string; slug: string; label: string; ownerId: string; members: string[] }> = [];
  const at = new Date();
  const view = (pool: (typeof pools)[number]) => ({
    id: pool.id,
    slug: pool.slug,
    label: pool.label,
    createdAt: at,
    updatedAt: at,
    members: pool.members.map((providerId) => {
      const row = rows.find((r) => r.id === providerId)!;
      return { provider: { id: row.id, slug: row.slug, label: row.label } };
    }),
  });
  const unexpected = (what: string, args: unknown): never => {
    throw new Error(`admission asked something this stand-in does not answer: ${what} ${JSON.stringify(args)}`);
  };
  type Where = Record<string, any>;
  const visible = (where: Where) => (row: ProviderRow) =>
    (where.OR as Array<{ ownerId: string | null }>).some((scope) => scope.ownerId === row.ownerId);
  const prisma = {
    modelProvider: {
      findMany: async (args: { where: Where }) => {
        const { where } = args;
        if (where.id?.in && where.OR && where.slug?.not) {
          return rows.filter((r) => where.id.in.includes(r.id) && r.slug !== where.slug.not && visible(where)(r));
        }
        if (typeof where.slug?.startsWith === 'string' && Object.keys(where).length === 1) {
          return rows.filter((r) => r.slug.startsWith(where.slug.startsWith)).map((r) => ({ slug: r.slug }));
        }
        return unexpected('modelProvider.findMany', args);
      },
    },
    providerPool: {
      findMany: async (args: { where: Where }) => {
        const { where } = args;
        if (typeof where.slug?.startsWith === 'string' && Object.keys(where).length === 1) {
          return pools.filter((p) => p.slug.startsWith(where.slug.startsWith)).map((p) => ({ slug: p.slug }));
        }
        return unexpected('providerPool.findMany', args);
      },
      findFirst: async (args: { where: Where }) => {
        const pool = pools.find((p) => p.id === args.where.id && p.ownerId === args.where.ownerId);
        return pool ? view(pool) : null;
      },
      create: async (args: { data: Where }) => {
        const { data } = args;
        const pool = {
          id: randomUUID(),
          slug: data.slug as string,
          label: data.label as string,
          ownerId: data.ownerId as string,
          members: (data.members.createMany.data as Array<{ providerId: string }>).map((m) => m.providerId),
        };
        pools.push(pool);
        return view(pool);
      },
    },
    providerPoolMember: {
      createMany: async (args: { data: Array<{ poolId: string; providerId: string; ownerId: string }> }) => {
        let count = 0;
        for (const member of args.data) {
          const pool = pools.find((p) => p.id === member.poolId) ?? unexpected('a member of no pool', member);
          if (!pool.members.includes(member.providerId)) {
            pool.members.push(member.providerId);
            count += 1;
          }
        }
        return { count };
      },
    },
  };
  return {
    prisma,
    /** Every pool and its members, as written. */
    written: () => pools.map((p) => ({ label: p.label, members: [...p.members] })),
  };
}

function providersOver(db: ReturnType<typeof database>) {
  // Admission never reads a quota; a service that tried to would fail loudly here.
  return new ProvidersService(db.prisma as never, realtime, {} as never);
}

/** What refused a pool write: the structured body of its 400, or null when the write went through. */
async function refusal(write: Promise<unknown>): Promise<Record<string, unknown> | null> {
  try {
    await write;
    return null;
  } catch (error) {
    if (error instanceof BadRequestException) return error.getResponse() as Record<string, unknown>;
    throw error;
  }
}

test('(1) the usage probe never sends a metered key, or a key for a non-Anthropic endpoint — and does send a subscription on api.anthropic.com', async () => {
  await withUsageEndpoint(async (sent) => {
    const usage = new ProviderPlanUsageService(realtime);
    for (const a of ACCOUNTS) await usage.refresh(a.row);

    // The one positive this case rests on: the probe is live, and it is this endpoint it would use.
    assert.deepEqual(
      labels(ACCOUNTS.filter((a) => sent.some((request) => request.key === a.key))),
      labels(ELIGIBLE),
      'the accounts whose key reached the usage endpoint',
    );
    assert.deepEqual([...new Set(sent.map((request) => request.url))], [OAUTH_USAGE_URL]);
    for (const a of INELIGIBLE) {
      assert.equal(usage.snapshot(a.row), null, `${a.row.label} has a quota, so it was probed`);
    }
    for (const a of ELIGIBLE) {
      assert.equal(usage.snapshot(a.row)?.fiveHour?.utilization, 40, `${a.row.label} was not probed`);
    }
    // Reading a snapshot refreshes a row that has none; that must not send one either.
    for (const a of INELIGIBLE) await usage.refresh(a.row);
    assert.deepEqual(
      sent.filter((request) => INELIGIBLE.some((a) => a.key === request.key)),
      [],
      'a key the probe must not send left the process',
    );
  });
});

test('(2) neither can become a pool member: a pool created with it, or an add of it, is refused and writes nothing — while a subscription on api.anthropic.com joins', async () => {
  const db = database(ACCOUNTS.map((a) => a.row));
  const providers = providersOver(db);
  const [work, personal] = ELIGIBLE;

  // Positive control: admission is not simply shut. Both subscriptions join, one at create, one added.
  const pool = await providers.createPool(OWNER, { label: 'Claude accounts', providerIds: [work.row.id] });
  await providers.addPoolMember(OWNER, pool.id, personal.row.id);
  const admitted = [{ label: 'Claude accounts', members: [work.row.id, personal.row.id] }];
  assert.deepEqual(db.written(), admitted);

  for (const a of INELIGIBLE) {
    const onCreate = await refusal(
      providers.createPool(OWNER, { label: `Claude accounts + ${a.row.label}`, providerIds: [work.row.id, a.row.id] }),
    );
    const onAdd = await refusal(providers.addPoolMember(OWNER, pool.id, a.row.id));
    for (const [door, refused] of [['create', onCreate], ['add', onAdd]] as const) {
      assert.ok(refused, `${a.row.label} was admitted on ${door}`);
      assert.equal(refused.code, 'PROVIDER_POOL_MEMBER_REFUSED', `${a.row.label} on ${door}`);
      assert.equal(refused.providerId, a.row.id, `${a.row.label} on ${door}`);
      // Refused by the test the probe skips it with, which is what the reason names.
      assert.equal(refused.reason, subscriptionUsageRefusal(a.row, a.key), `${a.row.label} on ${door}`);
    }
  }
  assert.deepEqual(db.written(), admitted, 'a refused row wrote a pool or a membership');
});

test('(3) a pool admits exactly the rows the usage probe asks about, which are the rows probesSubscriptionUsage passes', async () => {
  const admitted: Account[] = [];
  for (const a of ACCOUNTS) {
    const providers = providersOver(database(ACCOUNTS.map((x) => x.row)));
    if (!(await refusal(providers.createPool(OWNER, { label: a.row.label, providerIds: [a.row.id] })))) admitted.push(a);
  }
  const asked = await probed(ACCOUNTS);
  assert.deepEqual(labels(admitted), labels(asked), 'admitted into a pool vs asked about by the probe');
  assert.deepEqual(labels(asked), labels(ACCOUNTS.filter((a) => probesSubscriptionUsage(a.row, a.key))));
});
