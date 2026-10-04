import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client } from 'pg';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { RunnersService } from './runners.service';
import { QueueService } from '../queue/queue.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { CODEX_ACCOUNT_MOVE_V1 } from '../providers/account-move-capability';
import { ConflictException } from '@nestjs/common';

const url = process.env.COORDINATOR_PG_URL;
const work = '1fda3f43';
const quiet = new Proxy({}, { get: () => () => undefined });
const engines = [{ engine: 'codex', installed: true, auth: 'yes', accounts: [
  { id: 'default', home: '/home/test/.codex', auth: 'yes' },
  { id: work, home: '/home/test/codex-work', auth: 'yes' },
]}];

test('personal account pause persists and gates claims and inbox without interrupting a turn', { skip: !url, timeout: 120_000 }, async t => {
  assertCoordinatorPgUrlIsIsolated(url!);
  const sql = new Client({ connectionString: url });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(url!);
  t.after(async () => { await db.$disconnect(); await sql.end(); });
  const runners = new RunnersService(db as never);
  const queue = new QueueService(db as never, quiet as never);
  const api = new RunnerApiController(db as never, queue, quiet as never, {} as never, {} as never,
    { expand: async (_ownerId: string, content: string) => content } as never);
  const dequeue = (id: string, runnerId: string, generation: string | null = null) => (api as unknown as {
    dequeueTurn(id: string, runnerId: string, generation: string | null): Promise<{ kind: string; env?: Record<string, string> } | null>;
  }).dequeueTurn(id, runnerId, generation);
  const activate = async (id: string, runnerId: string) => {
    const leaseOwner = randomUUID(), leaseGeneration = randomUUID();
    await api.takeoverLeases({ id: runnerId }, id, { leaseOwner, expectedLeaseOwner: null });
    await api.activateLeases({ id: runnerId }, id, { leaseOwner, leaseGeneration });
    return leaseGeneration;
  };
  async function fixture() {
    const ownerId = randomUUID(), runnerId = randomUUID(), workspaceId = randomUUID();
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@pause.invalid`, name: 'Pause test', passwordHash: 'x' } });
    await db.runner.create({ data: {
      id: runnerId, ownerId, name: 'pause-runner', tokenHash: randomUUID(), status: 'ONLINE',
      lastHeartbeatAt: new Date(), maxConcurrent: 4, engines, capabilities: [CODEX_ACCOUNT_MOVE_V1],
    } });
    await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'Pause', workDir: '/tmp/pause', enabled: true } });
    const session = async (status: 'PENDING' | 'RUNNING' = 'PENDING', pinned = false) => db.session.create({ data: {
      ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId,
      title: 'Pause test', prompt: 'hello', provider: 'codex', providerBuiltin: true,
      codexAccount: 'default', codexAccountPinned: pinned, status, usesRuntimeDefaultModel: true,
    } });
    return { ownerId, runnerId, workspaceId, session };
  }
  await t.test('persists separately from heartbeat; concurrent pauses do not overwrite; other owner denied', async () => {
    const f = await fixture();
    await Promise.all([
      runners.pauseAccount(f.ownerId, f.runnerId, 'codex', 'default', 120),
      runners.pauseAccount(f.ownerId, f.runnerId, 'codex', work, 60),
    ]);
    await db.runner.update({ where: { id: f.runnerId }, data: { engines } });
    const listed = (await runners.listRunners(f.ownerId))[0].engines?.[0].accounts!;
    assert.ok(listed.every(a => a.pausedUntil && a.auth === 'yes'));
    await assert.rejects(runners.pauseAccount(randomUUID(), f.runnerId, 'codex', work, null), /runner not found/);
    await runners.pauseAccount(f.ownerId, f.runnerId, 'codex', 'default', null);
    const row = await db.runner.findUniqueOrThrow({ where: { id: f.runnerId } });
    assert.deepEqual(Object.keys((row.accountPauses as { codex: object }).codex), [work]);
  });
  await t.test('automatic moves to an unpaused account, pinned waits, resume and expiry both release it', async () => {
    const f = await fixture();
    await runners.pauseAccount(f.ownerId, f.runnerId, 'codex', 'default', 120);
    const pinned = await f.session('PENDING', true);
    const automatic = await f.session();
    const message = await db.conversationTurn.create({ data: {
      sessionId: automatic.id, seq: 1, kind: 'message', content: 'next turn', clientTurnId: randomUUID(),
    } });
    const job = await queue.claimSessionForRunner({ id: f.runnerId });
    assert.equal(job?.sessionId, automatic.id, 'paused oldest session must not starve runnable work');
    assert.equal((await db.session.findUniqueOrThrow({ where: { id: automatic.id } })).codexAccount, work);
    const reload = await dequeue(automatic.id, f.runnerId);
    assert.equal(reload?.kind, 'reload', 'warm engines must reload before receiving the queued message');
    assert.equal(reload?.env?.CODEX_HOME, '/home/test/codex-work');
    assert.equal((await db.conversationTurn.findUniqueOrThrow({ where: { id: message.id } })).status, 'PENDING');
    assert.equal((await db.session.findUniqueOrThrow({ where: { id: pinned.id } })).status, 'PENDING');
    await runners.pauseAccount(f.ownerId, f.runnerId, 'codex', 'default', null);
    assert.equal((await queue.claimSessionForRunner({ id: f.runnerId }))?.sessionId, pinned.id);
    await runners.pauseAccount(f.ownerId, f.runnerId, 'codex', 'default', 1);
    const expired = await f.session('PENDING', true);
    assert.equal(await queue.claimSessionForRunner({ id: f.runnerId }), null);
    await db.runner.update({ where: { id: f.runnerId }, data: { accountPauses: { codex: { default: new Date(Date.now() - 1).toISOString() } } } });
    assert.equal((await queue.claimSessionForRunner({ id: f.runnerId }))?.sessionId, expired.id);
  });
  await t.test('pause between claim and delivery requeues; active turn and controls remain intact', async () => {
    const f = await fixture();
    const s = await f.session('RUNNING', true);
    const turn = await db.conversationTurn.create({ data: { sessionId: s.id, seq: 1, kind: 'message', content: 'hello', clientTurnId: randomUUID() } });
    await runners.pauseAccount(f.ownerId, f.runnerId, 'codex', 'default', 120);
    await assert.rejects(dequeue(s.id, f.runnerId), ConflictException);
    assert.equal((await db.conversationTurn.findUniqueOrThrow({ where: { id: turn.id } })).status, 'PENDING');
    assert.equal((await db.session.findUniqueOrThrow({ where: { id: s.id } })).status, 'PENDING');
    const parked = await db.session.findUniqueOrThrow({ where: { id: s.id } });
    assert.equal(parked.inboxLeaseOwner, null, 'heartbeat must detach the old process and release its permit');
    const fences = await db.$queryRaw<Array<{ retired_at: Date | null }>>`
      SELECT retired_at FROM inbox_lease_generation WHERE generation = ${parked.inboxLeaseGeneration}::uuid
    `;
    assert.ok(fences[0]?.retired_at);
    // A different session already delivering a turn may finish it despite the pause.
    const active = await f.session('RUNNING', true);
    const activeGeneration = await activate(active.id, f.runnerId);
    const startedAt = new Date(Date.now() - 600_000);
    await db.conversationTurn.update({ where: { id: turn.id }, data: { sessionId: active.id } });
    await db.conversationTurn.update({ where: { id: turn.id }, data: {
      status: 'IN_FLIGHT', deliveredAt: startedAt,
      leaseDeadlineAt: new Date(Date.now() - 300_000), leaseGeneration: activeGeneration,
    } });
    await db.conversationTurn.create({ data: { sessionId: active.id, seq: 2, kind: 'message', content: 'later', clientTurnId: randomUUID() } });
    // Inbox may re-deliver the same id; the resident engine deduplicates it. The pause
    // must not detach a turn merely because it has run beyond the five-minute deadline.
    await dequeue(active.id, f.runnerId, activeGeneration);
    assert.equal((await db.session.findUniqueOrThrow({ where: { id: active.id } })).status, 'RUNNING');
    assert.equal((await db.conversationTurn.findUniqueOrThrow({ where: { id: turn.id } })).status, 'IN_FLIGHT');
    assert.equal((await db.conversationTurn.findUniqueOrThrow({ where: { id: turn.id } })).deliveredAt?.getTime(), startedAt.getTime());
    await db.conversationTurn.create({ data: { sessionId: active.id, seq: 3, kind: 'diff', clientTurnId: randomUUID() } });
    assert.equal((await dequeue(active.id, f.runnerId, activeGeneration))?.kind, 'diff');
  });
  await t.test('expired delivery waits for resume instead of retrying on the paused account', async () => {
    const f = await fixture();
    const s = await f.session('RUNNING', true);
    const generation = await activate(s.id, f.runnerId);
    const turn = await db.conversationTurn.create({ data: {
      sessionId: s.id, seq: 1, kind: 'message', content: 'retry me', clientTurnId: randomUUID(),
      status: 'IN_FLIGHT', deliveredAt: new Date(Date.now() - 120_000), leaseDeadlineAt: new Date(Date.now() - 1),
    } });
    await runners.pauseAccount(f.ownerId, f.runnerId, 'codex', 'default', 120);
    await assert.rejects(dequeue(s.id, f.runnerId, generation), ConflictException);
    assert.equal((await db.session.findUniqueOrThrow({ where: { id: s.id } })).status, 'PENDING');
    assert.equal((await db.conversationTurn.findUniqueOrThrow({ where: { id: turn.id } })).status, 'PENDING');
    await runners.pauseAccount(f.ownerId, f.runnerId, 'codex', 'default', null);
    assert.equal((await queue.claimSessionForRunner({ id: f.runnerId }))?.sessionId, s.id);
    const resumedGeneration = await activate(s.id, f.runnerId);
    await assert.rejects(dequeue(s.id, f.runnerId, generation), ConflictException);
    assert.equal((await dequeue(s.id, f.runnerId, resumedGeneration))?.kind, 'message');
  });
});
