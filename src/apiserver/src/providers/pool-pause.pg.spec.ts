import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Client } from 'pg';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ProviderPlanUsageService } from './plan-usage.service';
import { ProvidersService } from './providers.service';
import { SharedPoolsService } from './shared-pools.service';
import { encryptSecret } from './provider-crypto';
import { poolPauseBlocksRequest } from './pool-pause';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;
process.env.PROVIDER_SECRET_KEY ??= 'pool-pause-spec';
const realtime = new Proxy({}, { get: (_target, key) => key === 'then' ? undefined : () => undefined }) as RealtimeService;

suite('manual pool pauses: permissions, membership scope, next turn, expiry and gateway boundary', { timeout: 600_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  const db = prismaClientFor(URL!);
  t.after(async () => { await db.$disconnect(); await client.end(); });
  const prisma = db as unknown as PrismaService;
  const usage = new ProviderPlanUsageService(realtime);
  const providers = new ProvidersService(prisma, realtime, usage);
  const shared = new SharedPoolsService(prisma, realtime, providers);
  const queue = new QueueService(prisma, realtime, usage);
  const users = await Promise.all(['owner', 'contributor', 'member', 'outsider'].map((name) => db.user.create({
    data: { name, email: `${name}-${randomUUID()}@pool-pause.invalid`, passwordHash: 'x' },
  })));
  const [owner, contributor, member, outsider] = users;
  const pool = await shared.create(owner.id, { label: `Pause ${randomUUID()}` });
  await shared.addPerson(owner.id, pool.id, { email: contributor.email });
  await shared.addPerson(owner.id, pool.id, { email: member.email });
  await db.poolCodexLogin.create({ data: {
    poolId: pool.id, userId: contributor.id, accountId: 'pause-account-1234', email: 'account@pause.invalid',
    accessTokenEnc: encryptSecret('access'), refreshTokenEnc: encryptSecret('refresh'), expiresAt: new Date(Date.now() + 86400000),
  } });
  await shared.addKey(contributor.id, pool.id, { label: 'API backup', apiKey: `sk-proj-${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}` });
  const key = (await shared.get(owner.id, pool.id)).keys[0];
  const loginId = 'login:…1234';

  await t.test('only contributor/admin can pause; outsiders cannot discover pool; invalid durations write nothing', async () => {
    await assert.rejects(providers.pausePoolMember(outsider.id, pool.id, loginId, 60), NotFoundException);
    await assert.rejects(providers.pausePoolMember(member.id, pool.id, loginId, 60), ForbiddenException);
    await assert.rejects(providers.pausePoolMember(member.id, pool.id, key.id, 60), ForbiddenException);
    for (const duration of [0, -1, 0.5, 10081, undefined]) {
      await assert.rejects(providers.pausePoolMember(owner.id, pool.id, loginId, duration as number), BadRequestException);
    }
    assert.equal((await shared.get(owner.id, pool.id)).logins[0].pausedUntil, null);
  });

  await t.test('pause keeps authentication, usage and quota; another credential is next; all paused waits', async () => {
    const before = await db.poolCodexLogin.findUniqueOrThrow({ where: { poolId_accountId: { poolId: pool.id, accountId: 'pause-account-1234' } } });
    const result = await providers.pausePoolMember(contributor.id, pool.id, loginId, 120);
    const view = await shared.get(member.id, pool.id);
    assert.equal(view.logins[0].pausedUntil, result.pausedUntil);
    assert.equal(view.logins[0].state, 'ACTIVE');
    assert.equal(view.logins[0].next, false);
    assert.equal(view.keys[0].next, true);
    assert.equal(await queue.accountPoolPausedUntil(member.id, pool.slug, new Date()), null);
    const keyPause = await providers.pausePoolMember(owner.id, pool.id, key.id, 60);
    assert.deepEqual(await queue.accountPoolPausedUntil(member.id, pool.slug, new Date()), new Date(keyPause.pausedUntil!));
    await assert.rejects(queue.resolveSharedPool(prisma, { id: randomUUID(), ownerId: member.id, poolCodexAccountId: null, poolKeyId: null }, pool.slug), ConflictException);
    const after = await db.poolCodexLogin.findUniqueOrThrow({ where: { poolId_accountId: { poolId: pool.id, accountId: 'pause-account-1234' } } });
    assert.equal(after.accessTokenEnc, before.accessTokenEnc);
    assert.equal(after.state, before.state);
    assert.deepEqual(after.usage, before.usage);
    assert.deepEqual(after.spentUntil, before.spentUntil);
    await providers.pausePoolMember(contributor.id, pool.id, loginId, 240);
    const extended = await db.poolCodexLogin.findUniqueOrThrow({ where: { poolId_accountId: { poolId: pool.id, accountId: after.accountId } } });
    assert.deepEqual(extended.pausedAt, after.pausedAt);
    assert.deepEqual(await queue.pausedPoolMemberUntil(member.id, pool.slug, { poolCodexAccountId: after.accountId, poolKeyId: null, poolMemberProviderId: null }, new Date()), extended.pausedUntil);
    await providers.pausePoolMember(owner.id, pool.id, loginId, null);
    assert.equal(await queue.accountPoolPausedUntil(member.id, pool.slug, new Date()), null);
    const resumed = (await shared.get(member.id, pool.id)).logins[0];
    assert.equal(resumed.pausedUntil, null);
    assert.equal(resumed.next, true);
    await db.poolApiKey.update({ where: { id: key.id }, data: { pausedUntil: new Date(Date.now() - 1000) } });
    assert.equal((await shared.get(member.id, pool.id)).keys[0].pausedUntil, null);
  });

  await t.test('an owner Codex pool paused after preflight refuses resolution without erasing the selected account', async () => {
    const own = await providers.createPool(owner.id, { label: `Own pause ${randomUUID()}`, engine: 'codex' });
    await db.poolCodexLogin.create({ data: {
      poolId: own.id, userId: owner.id, accountId: 'own-pause-5678', email: 'own@pause.invalid',
      accessTokenEnc: encryptSecret('access'), refreshTokenEnc: encryptSecret('refresh'), expiresAt: new Date(Date.now() + 86400000),
    } });
    assert.equal(await queue.accountPoolPausedUntil(owner.id, own.slug, new Date()), null);
    await providers.pausePoolMember(owner.id, own.id, 'login:…5678', 60);
    await assert.rejects(queue.resolveLoginPool(prisma, { id: randomUUID(), ownerId: owner.id, poolCodexAccountId: 'own-pause-5678', poolKeyId: null }, own.slug), ConflictException);
  });

  await t.test('Claude pause is membership-scoped and all-paused resolution cannot fall back to the runner', async () => {
    const provider = await db.modelProvider.create({ data: {
      ownerId: owner.id, slug: `pause-member-${randomUUID()}`, label: 'Claude account', runtime: 'claude',
      baseUrl: 'https://api.anthropic.com', apiKeyEnc: encryptSecret('sk-ant-oat01-pause-token'), models: [],
    } });
    const first = await providers.createPool(owner.id, { label: `Pause Claude ${randomUUID()}`, providerIds: [provider.id] });
    const second = await providers.createPool(owner.id, { label: `Other Claude ${randomUUID()}`, providerIds: [provider.id] });
    const result = await providers.pausePoolMember(owner.id, first.id, provider.id, 60);
    assert.equal((await providers.getPool(owner.id, first.id)).members[0].pausedUntil, result.pausedUntil);
    assert.equal((await providers.getPool(owner.id, second.id)).members[0].pausedUntil, null);
    assert.deepEqual(await queue.accountPoolPausedUntil(owner.id, first.slug, new Date()), new Date(result.pausedUntil!));
    await assert.rejects(queue.resolvePoolMember(prisma, { id: randomUUID(), ownerId: owner.id, poolMemberProviderId: provider.id }, first.slug), ConflictException);
    await providers.pausePoolMember(owner.id, first.id, provider.id, null);
    assert.equal(await queue.accountPoolPausedUntil(owner.id, first.slug, new Date()), null);
    assert.equal((await db.modelProvider.findUniqueOrThrow({ where: { id: provider.id } })).enabled, true);
    const backup = await db.modelProvider.create({ data: {
      ownerId: owner.id, slug: `pause-backup-${randomUUID()}`, label: 'Claude backup', runtime: 'claude',
      baseUrl: 'https://api.anthropic.com', apiKeyEnc: encryptSecret('sk-ant-oat01-backup-token'), models: [],
    } });
    await providers.addPoolMember(owner.id, first.id, backup.id);
    const runner = await db.runner.create({ data: { ownerId: owner.id, name: 'pause-Claude', tokenHash: randomUUID() } });
    const workspace = await db.workspace.create({ data: { ownerId: owner.id, runnerId: runner.id, name: 'pause-Claude', workDir: '/tmp/pause-Claude' } });
    const session = await db.session.create({ data: {
      ownerId: owner.id, creatorId: owner.id, workspaceId: workspace.id, assignedRunnerId: runner.id,
      title: 'pause-Claude', prompt: 'hello', provider: first.slug, providerBuiltin: false, status: 'RUNNING',
      poolMemberProviderId: provider.id, usesRuntimeDefaultModel: true,
    } });
    await db.conversationTurn.create({ data: { sessionId: session.id, seq: 1, clientTurnId: 'next-message', kind: 'message', content: 'continue', status: 'PENDING' } });
    await providers.pausePoolMember(owner.id, first.id, provider.id, 60);
    const selected = await queue.resolvePoolMember(prisma, session, first.slug, true);
    assert.equal(selected?.id, backup.id);
    const reload = await db.conversationTurn.findFirstOrThrow({ where: { sessionId: session.id, kind: 'reload', status: 'PENDING' } });
    assert.deepEqual(JSON.parse(reload.content!), { provider: first.slug });
    const runnerApi = new RunnerApiController(prisma, queue, realtime, {} as never, {} as never, {
      expand: async (_ownerId: string, content?: string) => content,
    } as never);
    const delivered = await (runnerApi as unknown as {
      dequeueTurn(sessionId: string, runnerId: string, generation: null): Promise<{ kind: string; env?: Record<string, string> } | null>;
    }).dequeueTurn(session.id, runner.id, null);
    assert.equal(delivered?.kind, 'reload', 'credential reload must precede the pending executable message');
    assert.equal(delivered?.env?.ANTHROPIC_AUTH_TOKEN, 'sk-ant-oat01-backup-token');
    assert.equal((await db.conversationTurn.findFirstOrThrow({ where: { sessionId: session.id, kind: 'message' } })).status, 'PENDING');

  });

  await t.test('gateway permits the delivered active turn, blocks a later turn on the same warm token, and expires automatically', async () => {
    const runner = await db.runner.create({ data: { ownerId: owner.id, name: 'pause-test', tokenHash: randomUUID() } });
    const workspace = await db.workspace.create({ data: { ownerId: owner.id, runnerId: runner.id, name: 'pause-test', workDir: '/tmp/pause-test' } });
    const session = await db.session.create({ data: {
      ownerId: owner.id, creatorId: owner.id, workspaceId: workspace.id, assignedRunnerId: runner.id,
      title: 'pause-test', prompt: 'hello', provider: pool.slug, providerBuiltin: false, model: 'gpt-5.5', status: 'RUNNING',
    } });
    const now = new Date();
    const pausedAt = new Date(now.getTime() - 1000);
    const pausedUntil = new Date(now.getTime() + 60000);
    const turn = await db.conversationTurn.create({ data: { sessionId: session.id, seq: 1, clientTurnId: 'before', kind: 'message', status: 'IN_FLIGHT', leaseDeadlineAt: pausedUntil, deliveredAt: new Date(pausedAt.getTime() - 1000) } });
    assert.equal(await poolPauseBlocksRequest(prisma, session.id, { pausedAt, pausedUntil }, now), false);
    await db.conversationTurn.update({ where: { id: turn.id }, data: { leaseDeadlineAt: new Date(now.getTime() - 1) } });
    assert.equal(await poolPauseBlocksRequest(prisma, session.id, { pausedAt, pausedUntil }, now), true, 'an expired delivery lease cannot keep the paused credential alive');
    const generation = randomUUID();
    const leaseOwner = randomUUID();
    await db.inboxLeaseGeneration.create({ data: { generation, sessionId: session.id, leaseOwner } });
    await db.session.update({ where: { id: session.id }, data: { inboxLeaseGeneration: generation, inboxLeaseOwner: leaseOwner } });
    await db.conversationTurn.update({ where: { id: turn.id }, data: { leaseGeneration: generation } });
    assert.equal(await poolPauseBlocksRequest(prisma, session.id, { pausedAt, pausedUntil }, now), false, 'a long active turn remains authorized by its current engine generation after its delivery deadline');
    await db.inboxLeaseGeneration.update({ where: { generation }, data: { retiredAt: now } });
    assert.equal(await poolPauseBlocksRequest(prisma, session.id, { pausedAt, pausedUntil }, now), true, 'a retired generation cannot keep the paused credential alive');
    await db.inboxLeaseGeneration.update({ where: { generation }, data: { retiredAt: null } });
    await db.session.update({ where: { id: session.id }, data: { inboxLeaseGeneration: randomUUID() } });
    assert.equal(await poolPauseBlocksRequest(prisma, session.id, { pausedAt, pausedUntil }, now), true, 'a replaced generation cannot keep the paused credential alive');
    await db.session.update({ where: { id: session.id }, data: { inboxLeaseGeneration: null, inboxLeaseOwner: null } });

    await db.conversationTurn.update({ where: { id: turn.id }, data: { status: 'ANSWERED' } });
    await db.conversationTurn.create({ data: { sessionId: session.id, seq: 2, clientTurnId: 'after', kind: 'message', status: 'IN_FLIGHT', leaseDeadlineAt: pausedUntil, deliveredAt: now } });
    assert.equal(await poolPauseBlocksRequest(prisma, session.id, { pausedAt, pausedUntil }, now), true);
    assert.equal(await poolPauseBlocksRequest(prisma, session.id, { pausedAt, pausedUntil }, pausedUntil), false);

    // A pause waits behind inbox delivery. Its timestamp must be captured after that wait, not when
    // the HTTP handler began, or the just-delivered active turn would be rejected by the gateway.
    await db.conversationTurn.updateMany({ where: { sessionId: session.id }, data: { status: 'ANSWERED' } });
    await providers.pausePoolMember(owner.id, pool.id, key.id, null);
    await client.query('BEGIN');
    const blocker = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    await client.query('SELECT id FROM pool_api_key WHERE id = $1 FOR SHARE', [key.id]);
    const pauseWrite = providers.pausePoolMember(owner.id, pool.id, key.id, 60);
    let waiting = false;
    try {
      for (let attempt = 0; attempt < 200 && !waiting; attempt++) {
        const locks = await client.query('SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [blocker]);
        waiting = locks.rowCount! > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(waiting, true, 'pause must wait for the inbox membership lock');
      const delivered = new Date();
      await db.conversationTurn.create({ data: { sessionId: session.id, seq: 3, clientTurnId: 'while-pause-waits', kind: 'message', status: 'IN_FLIGHT', leaseDeadlineAt: new Date(delivered.getTime() + 60000), deliveredAt: delivered } });
      await client.query('COMMIT');
      await pauseWrite;
      const saved = await db.poolApiKey.findUniqueOrThrow({ where: { id: key.id } });
      assert.ok(saved.pausedAt! >= delivered);
      assert.equal(await poolPauseBlocksRequest(prisma, session.id, saved, new Date()), false);
    } finally {
      await client.query('ROLLBACK');
      await pauseWrite;
    }

  });
});
