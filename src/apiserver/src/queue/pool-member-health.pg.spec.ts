/**
 * POOL MEMBER CHOICE AT CLAIM READS ACCOUNT HEALTH (docs/routing-account-health-design.md §9 "Claude pool", "Codex
 * pool"): "A blocked member is skipped by bestPoolMember and by claim-time member choice."
 *
 *   (1) A Claude pool's session on a member health blocks is claimed on the other member, and told why in health's
 *       words; with every member blocked it stays where it was, as before health.
 *   (2) The run that holds a member's trial is not moved off it; another session on that member is, while the trial
 *       runs.
 *   (3) A Codex pool of the owner's own moves a session off a ChatGPT account health blocks, onto the other.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/queue/pool-member-health.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Client } from 'pg';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import type { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import type { RealtimeService } from '../realtime/realtime.service';
import { AccountHealthService } from '../providers/account-health.service';
import type { AccountHealthFailure, AccountHealthSubject } from '../providers/account-health';
import { ProviderPlanUsageService } from '../providers/plan-usage.service';
import { ProvidersService } from '../providers/providers.service';
import { encryptSecret } from '../providers/provider-crypto';
import { QueueService } from './queue.service';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;
process.env.PROVIDER_SECRET_KEY ??= 'pool-member-health-spec';
const realtime = new Proxy({}, { get: (_target, key) => key === 'then' ? undefined : () => undefined }) as RealtimeService;
/** Anthropic's usage endpoint, unavailable: nothing here reports a quota, and a real 401 would make a member refused. */
const usageEndpoint = (async () => new Response('unavailable', { status: 500 })) as typeof fetch;

const HOUR = 60 * 60_000;

suite('pool member choice at claim skips a member account health blocks', { timeout: 300_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  const db = prismaClientFor(URL!);
  const realFetch = globalThis.fetch;
  globalThis.fetch = usageEndpoint;
  t.after(async () => { globalThis.fetch = realFetch; await db.$disconnect(); await client.end(); });
  const prisma = db as unknown as PrismaService;
  const usage = new ProviderPlanUsageService(realtime);
  const providers = new ProvidersService(prisma, realtime, usage);
  const queue = new QueueService(prisma, realtime, usage);
  const health = new AccountHealthService(prisma);
  const owner = await db.user.create({ data: { name: 'owner', email: `owner-${randomUUID()}@pool-health.invalid`, passwordHash: 'x' } });
  const runner = await db.runner.create({ data: { ownerId: owner.id, name: 'pool-health', tokenHash: randomUUID() } });
  const workspace = await db.workspace.create({ data: { ownerId: owner.id, runnerId: runner.id, name: 'pool-health', workDir: '/tmp/pool-health' } });

  const refused = (): AccountHealthFailure => ({
    sessionId: randomUUID(), kind: 'ACCOUNT_ACTION_REQUIRED', admission: true, runnerOnline: true,
    said: 'Add a payment method to continue',
  });
  /** A classified refusal at `at`: the subject is blocked for an hour from then (§6.4). */
  const block = (subject: AccountHealthSubject, at = new Date()) => health.recordFailure(owner.id, subject, refused(), at);

  const member = (label: string) => db.modelProvider.create({ data: {
    ownerId: owner.id, slug: `health-member-${randomUUID()}`, label, runtime: 'claude',
    baseUrl: 'https://api.anthropic.com', apiKeyEnc: encryptSecret(`sk-ant-oat01-${randomUUID()}`), models: [],
  } });
  const session = (slug: string, extra: Record<string, unknown> = {}) => db.session.create({ data: {
    ownerId: owner.id, creatorId: owner.id, workspaceId: workspace.id, assignedRunnerId: runner.id,
    title: 'pool-health', prompt: 'hello', provider: slug, providerBuiltin: false, turnState: 'QUEUED',
    usesRuntimeDefaultModel: true, ...extra,
  } });

  await t.test('(1) a blocked Claude member is skipped, and kept when every member is blocked', async () => {
    const first = await member('First');
    const second = await member('Second');
    const pool = await providers.createPool(owner.id, { label: `Health ${randomUUID()}`, providerIds: [first.id, second.id] });
    const healthy = await session(pool.slug, { poolMemberProviderId: first.id });
    assert.equal((await queue.resolvePoolMember(prisma, healthy, pool.slug))?.id, first.id, 'with nothing blocked it stays on its member');

    await block({ type: 'provider', providerId: first.id });
    const moved = await session(pool.slug, { poolMemberProviderId: first.id });
    assert.equal((await queue.resolvePoolMember(prisma, moved, pool.slug))?.id, second.id);
    const row = await db.session.findUniqueOrThrow({ where: { id: moved.id } });
    assert.equal(row.poolMemberProviderId, second.id);
    assert.equal(row.poolSwitchNotice, 'Switched to Second — First needs action');

    await block({ type: 'provider', providerId: second.id });
    const stays = await session(pool.slug, { poolMemberProviderId: first.id });
    assert.equal((await queue.resolvePoolMember(prisma, stays, pool.slug))?.id, first.id, 'every member out: chosen as before health');
    assert.equal((await db.session.findUniqueOrThrow({ where: { id: stays.id } })).poolSwitchNotice, null);
  });

  await t.test('(2) the run that holds a member’s trial stays on it; another session on that member moves', async () => {
    const first = await member('Tried');
    const second = await member('Other');
    const pool = await providers.createPool(owner.id, { label: `Trial ${randomUUID()}`, providerIds: [first.id, second.id] });
    const subject: AccountHealthSubject = { type: 'provider', providerId: first.id };
    // Blocked two hours ago for one hour: its trial is due now.
    await block(subject, new Date(Date.now() - 2 * HOUR));
    const trial = await session(pool.slug, { poolMemberProviderId: first.id });
    assert.equal(await health.claimTrial(owner.id, subject, '', trial.id), 'CLAIMED');
    assert.equal((await queue.resolvePoolMember(prisma, trial, pool.slug))?.id, first.id, 'the trial runs where it was sent');
    const other = await session(pool.slug, { poolMemberProviderId: first.id });
    assert.equal((await queue.resolvePoolMember(prisma, other, pool.slug))?.id, second.id, 'the account is being tried by another run');
  });

  await t.test('(3) a Codex pool of the owner’s own moves a session off a ChatGPT account health blocks', async () => {
    const pool = await providers.createPool(owner.id, { label: `Own health ${randomUUID()}`, engine: 'codex' });
    for (const [accountId, email] of [['health-acct-1111', 'one@pool-health.invalid'], ['health-acct-2222', 'two@pool-health.invalid']]) {
      await db.poolCodexLogin.create({ data: {
        poolId: pool.id, userId: owner.id, accountId, email,
        accessTokenEnc: encryptSecret('access'), refreshTokenEnc: encryptSecret('refresh'), expiresAt: new Date(Date.now() + 86400000),
      } });
    }
    const stays = await session(pool.slug, { poolCodexAccountId: 'health-acct-1111' });
    await queue.resolveLoginPool(prisma, stays, pool.slug);
    assert.equal((await db.session.findUniqueOrThrow({ where: { id: stays.id } })).poolCodexAccountId, 'health-acct-1111');

    await block({ type: 'pool-login', poolId: pool.id, accountId: 'health-acct-1111' });
    const moved = await session(pool.slug, { poolCodexAccountId: 'health-acct-1111' });
    await queue.resolveLoginPool(prisma, moved, pool.slug);
    const row = await db.session.findUniqueOrThrow({ where: { id: moved.id } });
    assert.equal(row.poolCodexAccountId, 'health-acct-2222');
    assert.equal(row.poolSwitchNotice, 'Switched to two@pool-health.invalid — one@pool-health.invalid needs action');
  });
});
