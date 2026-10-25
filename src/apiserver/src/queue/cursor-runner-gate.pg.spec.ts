import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { RunStatus, RunnerStatus } from '@prisma/client';
import { AgentProvider, PermissionMode } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { newTerminalResumeHandoffOwner } from '../common/session-inbox-fence';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { CURSOR_RUNNER_UPGRADE_ERROR } from '../runner-api/runner-provider-support';
import { QueueService } from './queue.service';

/**
 * Migration 0426's runner gate against a real server, through the real claim, reclaim and lease routes:
 * a Cursor CLI session is claimed, reclaimed and leased only by a runner whose request AND persisted
 * heartbeat declare `cursor`, and no API replica that does not know Cursor CLI — one that reads no
 * session engine (before 0414), or one that does but has never heard of `orbit.runner_supports_cursor`
 * — can claim or lease one by raw SQL. The task's mandatory evidence (scripts/test-cursor-engine.mjs):
 * a missing server is a failure, not a skip.
 */

const URL = process.env.COORDINATOR_PG_URL;
const LEGACY = [
  AgentProvider.CLAUDE, AgentProvider.CODEX, AgentProvider.KIMI, AgentProvider.OPENCODE,
  AgentProvider.ANTIGRAVITY, AgentProvider.DSH,
];
const CURRENT = [...LEGACY, AgentProvider.CURSOR];
const UPGRADE = /Cursor CLI requires a newer Orbit runner/;

/** What each control plane sets in a claim or lease transaction (QueueService.trySessionClaim, the lease routes). */
const BEFORE_0414: Record<string, string> = {
  'orbit.runner_supports_opencode': '1', 'orbit.runner_supports_antigravity': '1', 'orbit.runner_supports_dsh': '1',
};
const BEFORE_0426: Record<string, string> = { ...BEFORE_0414, 'orbit.claim_reads_session_engine': '1' };
const CURRENT_REPLICA: Record<string, string> = { ...BEFORE_0426, 'orbit.runner_supports_cursor': '1' };

test('P1 Cursor CLI runner gate on PostgreSQL', { timeout: 300_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(URL);
  t.after(async () => { await db.$disconnect(); await sql.end(); });

  const realtime = {
    publish: () => {}, publishSessionUpdated: () => {}, publishSessionCreated: () => {},
    publishQueuedTurnsChanged: () => {}, publishForUser: () => {}, publishForAllUsers: () => {},
    notifyInbox: () => {}, drainCancellations: async () => [], drainMergeRequests: async () => [],
    drainCommitRequests: async () => [], drainArtifactRequests: async () => [],
  } as unknown as RealtimeService;
  const queue = new QueueService(db as unknown as PrismaService, realtime);
  const api = new RunnerApiController(db as never, queue as never, realtime as never, {} as never, {} as never, {} as never);

  async function fixture(maxConcurrent = 8) {
    const ownerId = randomUUID();
    const id = randomUUID();
    const workspaceId = randomUUID();
    await db.user.create({ data: { id: ownerId, email: `cursor-${ownerId}@gate.invalid`, name: 'cursor', passwordHash: 'x' } });
    await db.runner.create({ data: { id, ownerId, name: 'cursor', tokenHash: `x-${id}`, status: RunnerStatus.ONLINE, maxConcurrent } });
    await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId: id, name: 'cursor', enabled: true, workDir: '/tmp/cursor-gate' } });
    const runner = { id, ownerId, version: null };
    const beat = (providers?: readonly AgentProvider[]) => api.heartbeat(
      runner, { status: RunnerStatus.ONLINE, idleCapacity: 1 } as never, undefined, providers?.join(','),
    );
    /** A Cursor CLI session on the runner's own sign-in (or, with `engine: null`, the row an older replica
     *  would write under the slug). A pinned model and a mode Cursor CLI keeps, as a session created
     *  through SessionsService.create always has. */
    const session = async (opts: { provider?: string; engine?: string | null; status?: RunStatus } = {}) =>
      (await db.session.create({ data: {
        title: 'cursor', prompt: '', ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: id,
        provider: opts.provider ?? AgentProvider.CURSOR, providerBuiltin: true,
        engine: opts.engine === undefined ? AgentProvider.CURSOR : opts.engine,
        status: opts.status ?? RunStatus.PENDING, usesRuntimeDefaultModel: true,
        model: (opts.provider ?? AgentProvider.CURSOR) === AgentProvider.CURSOR ? 'default[]' : null,
        permissionMode: PermissionMode.ACCEPT_EDITS,
      } })).id;
    const claim = (providers?: readonly AgentProvider[]) => queue.claimSessionForRunner({ id, supportedProviders: providers });
    const reclaim = (providers?: readonly AgentProvider[]) => api.reclaim(runner, undefined, providers?.join(','));
    const poll = (providers?: readonly AgentProvider[]) => {
      const res = { once: (_event: string, close: () => void) => setTimeout(close, 100) };
      return api.claim(runner, undefined, providers?.join(','), res as never);
    };
    return { runner, beat, session, claim, reclaim, poll };
  }
  const row = (id: string) => db.session.findUniqueOrThrow({ where: { id } });
  /** One UPDATE in a transaction that set exactly `settings`, as a control plane of that age would. */
  async function rawUpdate(id: string, assignment: string, settings: Record<string, string> = {}) {
    await sql.query('BEGIN');
    try {
      for (const [name, value] of Object.entries(settings)) {
        await sql.query('SELECT set_config($1, $2, true)', [name, value]);
      }
      const result = await sql.query(`UPDATE "session" SET ${assignment} WHERE id = $1 RETURNING id`, [id]);
      await sql.query('COMMIT');
      return result.rowCount;
    } catch (error) {
      await sql.query('ROLLBACK');
      throw error;
    }
  }

  await t.test('P1 a runner without provider:cursor cannot claim a Cursor CLI session', async () => {
    const f = await fixture();
    const id = await f.session();
    // Neither the request alone nor the heartbeat alone is a declaration.
    assert.equal(await f.claim(CURRENT), null, 'the header cannot substitute for a missing heartbeat');
    await f.beat(CURRENT);
    for (const declaration of [undefined, LEGACY]) {
      assert.equal(await f.poll(declaration), null);
      assert.equal((await row(id)).status, RunStatus.PENDING);
      assert.equal((await row(id)).error, CURSOR_RUNNER_UPGRADE_ERROR);
    }
    assert.equal(await f.claim(LEGACY), null);
    const job = await f.claim(CURRENT);
    assert.equal(job?.sessionId, id);
    assert.equal(job?.provider, AgentProvider.CURSOR);
    assert.equal(job?.agent.provider, AgentProvider.CURSOR);
    assert.equal(job?.agent.permissionMode, PermissionMode.ACCEPT_EDITS);
    assert.equal((await row(id)).status, RunStatus.RUNNING);
    assert.equal((await row(id)).error, null, 'the claim clears the upgrade notice');
  });

  await t.test('P1 a runner without provider:cursor cannot reclaim a Cursor CLI session', async () => {
    const f = await fixture();
    const id = await f.session({ status: RunStatus.AWAITING_INPUT });
    const claude = await f.session({ provider: AgentProvider.CLAUDE, engine: AgentProvider.CLAUDE, status: RunStatus.AWAITING_INPUT });
    await db.session.update({ where: { id: claude }, data: { runtimeSessionId: randomUUID() } });
    for (const declaration of [undefined, LEGACY, CURRENT]) {
      const sessions = (await f.reclaim(declaration)).sessions;
      assert.ok(!sessions.some((s) => s.sessionId === id), `${declaration ?? 'no header'} reclaimed Cursor CLI before a heartbeat declared it`);
      assert.ok(sessions.some((s) => s.sessionId === claude), 'the runner keeps its other checkouts');
    }
    await f.beat(LEGACY);
    assert.ok(!(await f.reclaim(CURRENT)).sessions.some((s) => s.sessionId === id), 'a heartbeat without cursor');
    await f.beat(CURRENT);
    assert.ok(!(await f.reclaim(LEGACY)).sessions.some((s) => s.sessionId === id), 'a request without cursor');
    const reclaimed = (await f.reclaim(CURRENT)).sessions.find((s) => s.sessionId === id);
    assert.equal(reclaimed?.provider, AgentProvider.CURSOR);
    assert.equal(reclaimed?.agent.provider, AgentProvider.CURSOR);
  });

  await t.test('P1 a runner without provider:cursor cannot take over or activate a Cursor CLI lease', async () => {
    const f = await fixture();
    await f.beat(CURRENT);
    const id = await f.session();
    assert.equal((await f.claim(CURRENT))?.sessionId, id);
    const owner = randomUUID();
    const takeover = (leaseOwner: string, expectedLeaseOwner: string | null, providers?: readonly AgentProvider[]) =>
      api.takeoverLeases(f.runner, id, { leaseOwner, expectedLeaseOwner } as never, undefined, providers?.join(','));
    for (const declaration of [undefined, LEGACY]) {
      await assert.rejects(() => takeover(owner, null, declaration), UPGRADE);
    }
    await f.beat(LEGACY);
    await assert.rejects(() => takeover(owner, null, CURRENT), UPGRADE, 'a heartbeat without cursor');
    assert.equal((await row(id)).inboxLeaseOwner, null, 'a refused takeover wrote nothing');
    await f.beat(CURRENT);
    await takeover(owner, null, CURRENT);
    assert.equal((await row(id)).inboxLeaseOwner, owner);

    const activation = { leaseOwner: owner, leaseGeneration: randomUUID() };
    for (const declaration of [undefined, LEGACY]) {
      await assert.rejects(() => api.activateLeases(f.runner, id, activation, declaration?.join(',')), UPGRADE);
    }
    await api.activateLeases(f.runner, id, activation, CURRENT.join(','));
    assert.equal((await row(id)).inboxLeaseGeneration, activation.leaseGeneration);
    // A withdrawn heartbeat refuses even an idempotent activation of the installed generation, and a
    // takeover by the next process.
    await f.beat(LEGACY);
    await assert.rejects(() => api.activateLeases(f.runner, id, activation, CURRENT.join(',')), UPGRADE);
    await assert.rejects(() => takeover(randomUUID(), owner, CURRENT), UPGRADE);
    assert.equal((await row(id)).inboxLeaseOwner, owner);
  });

  await t.test('P1 missing and withdrawn heartbeats fence Cursor CLI claims and reclaims', async () => {
    const f = await fixture();
    const id = await f.session();
    // A capability without its reported-at snapshot is not a declaration.
    await db.runner.update({ where: { id: f.runner.id }, data: { capabilities: ['provider:cursor'], capabilitiesReportedAt: null } });
    assert.equal(await f.claim(CURRENT), null);
    assert.equal(await rawUpdate(id, "status = 'RUNNING'", CURRENT_REPLICA), 0);
    assert.ok(!(await f.reclaim(CURRENT)).sessions.some((s) => s.sessionId === id));
    await f.beat(CURRENT);
    assert.equal((await f.claim(CURRENT))?.sessionId, id);
    // A heartbeat that omits the provider header withdraws every provider declaration.
    const pending = await f.session();
    await f.beat(undefined);
    assert.deepEqual((await db.runner.findUniqueOrThrow({ where: { id: f.runner.id } })).capabilities, []);
    assert.equal(await f.poll(CURRENT), null);
    assert.equal((await row(pending)).error, CURSOR_RUNNER_UPGRADE_ERROR);
    assert.ok(!(await f.reclaim(CURRENT)).sessions.some((s) => s.sessionId === id || s.sessionId === pending));
    await f.beat(CURRENT);
    assert.equal((await f.claim(CURRENT))?.sessionId, pending);
  });

  await t.test('P1 an API replica that does not read session engines or know Cursor CLI cannot claim or lease one', async () => {
    const f = await fixture();
    await f.beat(CURRENT);
    // Recorded on Cursor CLI, and the row an older replica would have written under the slug alone.
    for (const engine of [AgentProvider.CURSOR, null]) {
      const id = await f.session({ engine });
      // Before 0414 a replica reads no engine: a claim is skipped, and a lease write on a recorded one refused.
      assert.equal(await rawUpdate(id, "status = 'RUNNING'", BEFORE_0414), 0, 'a replica before 0414 claimed it');
      // After it, one that does not know Cursor CLI never declares it: skipped, a lease write too.
      assert.equal(await rawUpdate(id, "status = 'RUNNING'", BEFORE_0426), 0, 'a replica before 0426 claimed it');
      await f.beat(LEGACY);
      assert.equal(await rawUpdate(id, "status = 'RUNNING'", CURRENT_REPLICA), 0, 'a declaration cannot replace the heartbeat');
      await f.beat(CURRENT);
      assert.equal(await rawUpdate(id, "status = 'RUNNING'", CURRENT_REPLICA), 1);
      const leaseOwner = randomUUID();
      const generation = randomUUID();
      if (engine) {
        await assert.rejects(rawUpdate(id, `inbox_lease_owner = '${leaseOwner}'::uuid`, BEFORE_0414),
          (error: { code?: string; message?: string }) => error.code === '55000' && /does not read session engines/.test(error.message ?? ''));
        await assert.rejects(rawUpdate(id, `inbox_lease_generation = '${generation}'::uuid`, BEFORE_0414),
          (error: { code?: string }) => error.code === '55000');
      }
      assert.equal(await rawUpdate(id, `inbox_lease_owner = '${leaseOwner}'::uuid`, BEFORE_0426), 0, 'a replica before 0426 took the lease');
      assert.equal(await rawUpdate(id, `inbox_lease_generation = '${generation}'::uuid`, BEFORE_0426), 0, 'a replica before 0426 activated it');
      await f.beat(LEGACY);
      assert.equal(await rawUpdate(id, `inbox_lease_owner = '${leaseOwner}'::uuid`, CURRENT_REPLICA), 0);
      await f.beat(CURRENT);
      assert.equal(await rawUpdate(id, `inbox_lease_owner = '${leaseOwner}'::uuid`, CURRENT_REPLICA), 1);
      assert.equal(await rawUpdate(id, `inbox_lease_generation = '${generation}'::uuid`, CURRENT_REPLICA), 1);
      // Letting go is never an acquisition: release, cancel and a server terminal revive stay open to all.
      assert.equal(await rawUpdate(id, 'inbox_lease_owner = NULL, inbox_lease_generation = NULL'), 1, 'release stays available');
      assert.equal(await rawUpdate(id, "status = 'CANCELLED'"), 1);
      const handoff = newTerminalResumeHandoffOwner();
      assert.equal(await rawUpdate(id, `status = 'PENDING', inbox_lease_owner = '${handoff}'::uuid`), 1, 'a terminal revive only reserves a handoff marker');
      assert.equal(await rawUpdate(id, "status = 'RUNNING'", BEFORE_0426), 0, 'the handoff marker cannot bypass the claim gate');
      await rawUpdate(id, "status = 'CANCELLED', inbox_lease_owner = NULL");
    }
    // The declaration is transaction-local: the last authorized transaction cannot authorize the next.
    assert.equal(await rawUpdate(await f.session(), "status = 'RUNNING'", BEFORE_0426), 0);
    // A heartbeat withdrawing the declaration while a claim runs makes it skip, without deadlock.
    const contested = await f.session();
    const heartbeat = new Client({ connectionString: URL });
    await heartbeat.connect();
    try {
      await verifyCoordinatorPgIdentity(heartbeat);
      await heartbeat.query('BEGIN');
      await heartbeat.query('UPDATE "runner" SET capabilities = ARRAY[]::text[] WHERE id = $1', [f.runner.id]);
      assert.equal(await rawUpdate(contested, "status = 'RUNNING'", CURRENT_REPLICA), 0);
      await heartbeat.query('COMMIT');
      assert.equal(await rawUpdate(contested, "status = 'RUNNING'", CURRENT_REPLICA), 0, 'the committed withdrawal holds');
      await f.beat(CURRENT);
      assert.equal(await rawUpdate(contested, "status = 'RUNNING'", CURRENT_REPLICA), 1);
    } finally {
      await heartbeat.query('ROLLBACK');
      await heartbeat.end();
    }
  });

  await t.test('P1 every other engine still dispatches beside a waiting Cursor CLI session', async () => {
    const f = await fixture(16);
    await f.beat(LEGACY);
    const cursor = await f.session();
    for (const engine of LEGACY) {
      if (engine === AgentProvider.DSH) continue; // DeepSeek Harness has its own gate (dsh-provider-gate.pg.spec.ts).
      const id = await f.session({ provider: engine, engine });
      await db.session.update({ where: { id }, data: { model: null } });
      const job = await f.claim(LEGACY);
      assert.equal(job?.sessionId, id, `${engine} waited behind Cursor CLI`);
      assert.equal(job?.provider, engine);
      assert.equal(await rawUpdate(id, "status = 'AWAITING_INPUT'"), 1);
    }
    assert.equal((await row(cursor)).status, RunStatus.PENDING);
    assert.equal((await row(cursor)).error, null, 'the queue never held it for another runtime');
    // The capability gates of the others are untouched: OpenCode still needs its own declaration.
    const opencode = await f.session({ provider: AgentProvider.OPENCODE, engine: AgentProvider.OPENCODE });
    await db.session.update({ where: { id: opencode }, data: { model: null } });
    assert.equal(await rawUpdate(opencode, "status = 'RUNNING'", { 'orbit.claim_reads_session_engine': '1' }), 0);
    const withoutOpenCode = CURRENT.filter((engine) => engine !== AgentProvider.OPENCODE);
    await f.beat(CURRENT);
    const next = await f.claim(withoutOpenCode);
    assert.equal(next?.sessionId, cursor, 'the Cursor CLI session goes to a runner that declares it');
    assert.equal((await row(opencode)).status, RunStatus.PENDING);
  });
});
