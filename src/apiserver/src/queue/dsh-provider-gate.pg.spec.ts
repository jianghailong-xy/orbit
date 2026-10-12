import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { RunStatus, RunnerStatus } from '@prisma/client';
import { AgentProvider, DEFAULT_MODEL_BY_PROVIDER } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { newTerminalResumeHandoffOwner } from '../common/session-inbox-fence';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { encryptSecret } from '../providers/provider-crypto';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { DSH_RUNNER_UPGRADE_ERROR, PROVIDER_UNAVAILABLE_ERROR } from '../runner-api/runner-provider-support';
import { QueueService } from './queue.service';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY ??= 'dsh-provider-gate-spec';
const LEGACY = [AgentProvider.CLAUDE, AgentProvider.CODEX, AgentProvider.OPENCODE, AgentProvider.KIMI, AgentProvider.ANTIGRAVITY];
const CURRENT = [...LEGACY, AgentProvider.DSH];

// No skip path: this is the task's mandatory PostgreSQL evidence, and a missing server is a failure.
test('P1b DeepSeek Harness provider gate on PostgreSQL', { timeout: 300_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(URL);
  t.after(async () => { await db.$disconnect(); await sql.end(); });

  // P1a deliberately refuses every dsh global permission mode until P4 establishes an enforced
  // file policy. This fixture enables only that future policy boundary to exercise P1b scheduling:
  // QueueService/controller, runtime resolution, keys, heartbeat and PostgreSQL remain real.
  // The separate preflight test still verifies the production dsh permission refusal. Forward all
  // other runtimes through their unchanged policy, and restore the export when this suite ends.
  const runtimePolicy = require('../common/runtime-provider') as typeof import('../common/runtime-provider');
  const originalPermissionPolicy = runtimePolicy.normalizeBuiltinPermissionMode;
  runtimePolicy.normalizeBuiltinPermissionMode = (...args: Parameters<typeof originalPermissionPolicy>) =>
    args[0] === AgentProvider.DSH ? args[2] : originalPermissionPolicy(...args);
  t.after(() => { runtimePolicy.normalizeBuiltinPermissionMode = originalPermissionPolicy; });

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
    await db.user.create({ data: { id: ownerId, email: `dsh-${ownerId}@gate.invalid`, name: 'dsh', passwordHash: 'x' } });
    await db.runner.create({ data: { id, ownerId, name: 'dsh', tokenHash: `x-${id}`, status: RunnerStatus.ONLINE, maxConcurrent } });
    await db.workspace.create({ data: {
      id: workspaceId, ownerId, runnerId: id, name: 'dsh', enabled: true, workDir: '/tmp/dsh-gate',
      env: { ORBIT_DSH_API_KEY: 'native-session-key' },
    } });
    const runner = { id, ownerId, version: null };
    const beat = (providers?: readonly AgentProvider[], protocol?: string) => api.heartbeat(
      runner, { status: RunnerStatus.ONLINE, idleCapacity: 1 } as never, protocol, providers?.join(','),
    );
    const session = async (provider = 'dsh', providerBuiltin = true, status: RunStatus = RunStatus.PENDING) =>
      (await db.session.create({ data: {
        title: 'dsh', prompt: '', ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: id,
        provider, providerBuiltin, status, usesRuntimeDefaultModel: true,
        // Reclaim is read-only for these pinned rows, so the claim race measures the capacity gate
        // without model-materialization row locks making a NOWAIT claim return empty.
        model: (providerBuiltin && DEFAULT_MODEL_BY_PROVIDER[provider as AgentProvider]) || '{"provider":"deepseek","model":"gate-model"}',
      } })).id;
    const provider = async (runtime = 'dsh', enabled = true, slug = `dsh-${randomUUID()}`, shared = false) => {
      const key = `key-${randomUUID()}`;
      await db.modelProvider.create({ data: {
        slug, label: 'Harness', runtime, enabled, ownerId: shared ? null : ownerId,
        baseUrl: 'https://api.deepseek.com', apiKeyEnc: encryptSecret(key),
      } });
      return { slug, key };
    };
    const claim = (providers?: readonly AgentProvider[]) => queue.claimSessionForRunner({ id, supportedProviders: providers });
    const reclaim = (providers?: readonly AgentProvider[]) => api.reclaim(runner, undefined, providers?.join(','));
    const poll = (providers?: readonly AgentProvider[]) => {
      const res = { once: (_event: string, close: () => void) => setTimeout(close, 100) };
      return api.claim(runner, undefined, providers?.join(','), res as never);
    };
    return { runner, beat, session, provider, claim, reclaim, poll };
  }
  const row = (id: string) => db.session.findUniqueOrThrow({ where: { id } });
  async function rawUpdate(id: string, assignment: string, supportsDsh?: boolean) {
    await sql.query('BEGIN');
    try {
      if (supportsDsh !== undefined) {
        await sql.query("SELECT set_config('orbit.runner_supports_dsh', $1, true)", [supportsDsh ? '1' : '0']);
      }
      const result = await sql.query(`UPDATE "session" SET ${assignment} WHERE id = $1 RETURNING id`, [id]);
      await sql.query('COMMIT');
      return result.rowCount;
    } catch (error) {
      await sql.query('ROLLBACK');
      throw error;
    }
  }

  await t.test('P1b direct dsh requires request and heartbeat declarations', async () => {
    const f = await fixture();
    const id = await f.session();
    assert.equal(await f.claim(CURRENT), null, 'the header cannot substitute for a missing heartbeat');
    await f.beat(CURRENT);
    for (const declaration of [undefined, LEGACY]) {
      assert.equal(await f.poll(declaration), null);
      assert.equal((await row(id)).status, RunStatus.PENDING);
      assert.equal((await row(id)).error, DSH_RUNNER_UPGRADE_ERROR);
      assert.ok(!(await f.reclaim(declaration)).sessions.some((s) => s.sessionId === id));
    }
    const job = await f.claim(CURRENT);
    assert.equal(job?.sessionId, id);
    assert.equal(job?.provider, AgentProvider.DSH);
    assert.equal(job?.agent.provider, AgentProvider.DSH);
    assert.equal(job?.agent.env?.ORBIT_DSH_API_KEY, 'native-session-key');
    assert.equal((await row(id)).error, null);
    assert.equal((await f.reclaim(CURRENT)).sessions.find((s) => s.sessionId === id)?.provider, AgentProvider.DSH);
  });

  await t.test('P1b configured providers borrowing dsh require the same declarations', async () => {
    const f = await fixture();
    await f.beat(CURRENT);
    for (const shared of [false, true]) {
      // A shared provider runs an admin's sessions only (usableProviderScope); a member's is
      // shared-provider-admin-only.pg.spec.ts's.
      if (shared) await db.user.update({ where: { id: f.runner.ownerId }, data: { role: 'ADMIN' } });
      const configured = await f.provider('dsh', true, undefined, shared);
      const id = await f.session(configured.slug, false);
      assert.equal(await f.poll(LEGACY), null);
      assert.equal((await row(id)).error, DSH_RUNNER_UPGRADE_ERROR);
      assert.ok(!(await f.reclaim(LEGACY)).sessions.some((s) => s.sessionId === id));
      const job = await f.claim(CURRENT);
      assert.equal(job?.sessionId, id);
      assert.equal(job?.provider, AgentProvider.DSH);
      assert.equal(job?.agent.env?.ORBIT_DSH_API_KEY, configured.key);
      assert.equal(job?.agent.env?.ORBIT_DSH_BASE_URL, 'https://api.deepseek.com');
      const reclaimed = (await f.reclaim(CURRENT)).sessions.find((s) => s.sessionId === id);
      assert.equal(reclaimed?.provider, AgentProvider.DSH);
      assert.equal(reclaimed?.agent.env?.ORBIT_DSH_API_KEY, configured.key);
    }
  });

  await t.test('P1b missing and withdrawn heartbeats fence claims and reclaims', async () => {
    const f = await fixture();
    const id = await f.session();
    // A capability value without its reported-at snapshot is not a declaration.
    await db.runner.update({ where: { id: f.runner.id }, data: { capabilities: ['provider:dsh'], capabilitiesReportedAt: null } });
    assert.equal(await f.claim(CURRENT), null);
    assert.equal(await rawUpdate(id, "status = 'RUNNING'", true), 0);
    assert.ok(!(await f.reclaim(CURRENT)).sessions.some((s) => s.sessionId === id));
    await f.beat(CURRENT);
    assert.equal((await f.claim(CURRENT))?.sessionId, id);
    const pending = await f.session((await f.provider()).slug, false);
    // Even a capability-shaped protocol token cannot keep a declaration whose provider header is omitted.
    await f.beat(undefined, 'provider:dsh');
    assert.deepEqual((await db.runner.findUniqueOrThrow({ where: { id: f.runner.id } })).capabilities, []);
    assert.equal(await f.poll(CURRENT), null);
    assert.equal((await row(pending)).error, DSH_RUNNER_UPGRADE_ERROR);
    assert.ok(!(await f.reclaim(CURRENT)).sessions.some((s) => s.sessionId === id || s.sessionId === pending));
    await f.beat(CURRENT);
    assert.equal((await f.claim(CURRENT))?.sessionId, pending);
    await f.beat(LEGACY);
    assert.ok(!(await f.reclaim(CURRENT)).sessions.some((s) => s.provider === AgentProvider.DSH));
  });

  await t.test('P1b old control plane raw claims cannot bypass the database barrier', async () => {
    const f = await fixture();
    await f.beat(CURRENT);
    const configured = await f.provider();
    for (const [slug, builtin] of [['dsh', true], [configured.slug, false]] as const) {
      const id = await f.session(slug, builtin);
      assert.equal(await rawUpdate(id, "status = 'RUNNING'"), 0);
      assert.equal(await rawUpdate(id, "status = 'RUNNING'", false), 0);
      await f.beat(LEGACY);
      assert.equal(await rawUpdate(id, "status = 'RUNNING'", true), 0, 'a GUC cannot replace the heartbeat');
      await f.beat(CURRENT);
      assert.equal(await rawUpdate(id, "status = 'RUNNING'", true), 1);
      const leaseOwner = randomUUID();
      const generation = randomUUID();
      assert.equal(await rawUpdate(id, `inbox_lease_owner = '${leaseOwner}'::uuid`), 0, 'legacy reclaim takeover');
      assert.equal(await rawUpdate(id, `inbox_lease_generation = '${generation}'::uuid`), 0, 'legacy engine activation');
      await f.beat(LEGACY);
      assert.equal(await rawUpdate(id, `inbox_lease_owner = '${leaseOwner}'::uuid`, true), 0);
      await f.beat(CURRENT);
      assert.equal(await rawUpdate(id, `inbox_lease_owner = '${leaseOwner}'::uuid`, true), 1);
      assert.equal(await rawUpdate(id, `inbox_lease_generation = '${generation}'::uuid`, true), 1);
      assert.equal(await rawUpdate(id, 'inbox_lease_owner = NULL, inbox_lease_generation = NULL'), 1, 'release stays available');
      assert.equal(await rawUpdate(id, "status = 'CANCELLED'"), 1);
      const handoff = newTerminalResumeHandoffOwner();
      assert.equal(await rawUpdate(id, `status = 'PENDING', inbox_lease_owner = '${handoff}'::uuid`), 1, 'server terminal revive only reserves a handoff marker');
      assert.equal(await rawUpdate(id, "status = 'RUNNING'"), 0, 'the handoff marker cannot bypass the actual claim gate');
      assert.equal(await rawUpdate(id, `inbox_lease_owner = '${leaseOwner}'::uuid`), 0, 'the handoff marker cannot bypass runner takeover');
      await rawUpdate(id, "status = 'CANCELLED', inbox_lease_owner = NULL");
    }
    // The GUC is transaction-local: the prior authorized transaction cannot authorize the next one.
    assert.equal(await rawUpdate(await f.session(), "status = 'RUNNING'"), 0);
    const disabled = await f.session((await f.provider('dsh', false)).slug, false);
    assert.equal(await rawUpdate(disabled, "status = 'RUNNING'", true), 0, 'a capable raw acquisition cannot use a disabled Harness provider');

    const contested = await f.session();
    const heartbeat = new Client({ connectionString: URL });
    await heartbeat.connect();
    try {
      await verifyCoordinatorPgIdentity(heartbeat);
      await heartbeat.query('BEGIN');
      await heartbeat.query('UPDATE "runner" SET capabilities = ARRAY[]::text[] WHERE id = $1', [f.runner.id]);
      assert.equal(await rawUpdate(contested, "status = 'RUNNING'", true), 0, 'a concurrent heartbeat withdrawal makes acquisition skip without deadlock');
      await heartbeat.query('COMMIT');
      assert.equal(await rawUpdate(contested, "status = 'RUNNING'", true), 0, 'the committed withdrawal remains authoritative');
      await f.beat(CURRENT);
      assert.equal(await rawUpdate(contested, "status = 'RUNNING'", true), 1);
    } finally {
      await heartbeat.query('ROLLBACK');
      await heartbeat.end();
    }
  });

  await t.test('P1b concurrent claims and reclaims obey runtime gates and capacity', async () => {
    const f = await fixture(1);
    await f.beat(CURRENT);
    const dsh = await f.session();
    const borrowed = await f.session((await f.provider()).slug, false);
    const claude = await f.session('claude');
    const [old, current, reclaimed] = await Promise.all([f.claim(LEGACY), f.claim(CURRENT), f.reclaim(LEGACY)]);
    const jobs = [old, current].filter((job) => job !== null);
    assert.equal(jobs.length, 1, 'concurrent pollers share the same one-slot runner cap');
    if (old) assert.equal(old.provider, AgentProvider.CLAUDE);
    assert.ok(!reclaimed.sessions.some((s) => s.sessionId === dsh || s.sessionId === borrowed));
    assert.equal(await db.session.count({ where: { assignedRunnerId: f.runner.id, status: RunStatus.RUNNING } }), 1);
    await db.session.update({ where: { id: jobs[0]!.sessionId }, data: { status: RunStatus.AWAITING_INPUT } });
    const pendingDsh = (await row(dsh)).status === RunStatus.PENDING ? dsh : borrowed;
    const race = await Promise.all([f.claim(CURRENT), f.claim(CURRENT), f.reclaim(LEGACY), f.reclaim(CURRENT)]);
    const claimed = [race[0], race[1]].filter((job) => job !== null);
    assert.equal(claimed.length, 1, 'two capable requests still share the same runner cap');
    assert.equal(claimed[0]?.sessionId, pendingDsh);
    assert.equal(claimed[0]?.provider, AgentProvider.DSH);
    assert.ok(!race[2].sessions.some((s) => s.provider === AgentProvider.DSH));
    assert.ok(race[3].sessions.some((s) => s.sessionId === dsh && s.provider === AgentProvider.DSH));
    assert.ok(new Set<RunStatus>([RunStatus.PENDING, RunStatus.RUNNING, RunStatus.AWAITING_INPUT]).has((await row(claude)).status));

    const active = claimed[0]!.sessionId;
    const owners = [randomUUID(), randomUUID()];
    await assert.rejects(() => api.takeoverLeases(f.runner, active,
      { leaseOwner: owners[0], expectedLeaseOwner: null } as never, undefined, LEGACY.join(',')), /DeepSeek|update|newer/i);
    const takeovers = await Promise.allSettled(owners.map((leaseOwner) => api.takeoverLeases(f.runner, active,
      { leaseOwner, expectedLeaseOwner: null } as never, undefined, CURRENT.join(','))));
    assert.equal(takeovers.filter((result) => result.status === 'fulfilled').length, 1, 'only one reclaim process wins the owner CAS');
    const winner = owners[takeovers.findIndex((result) => result.status === 'fulfilled')];
    assert.equal((await row(active)).inboxLeaseOwner, winner);
    const generation = randomUUID();
    const activation = { leaseOwner: winner, leaseGeneration: generation };
    await assert.rejects(() => api.activateLeases(f.runner, active, activation), /DeepSeek|update|newer/i);
    await api.activateLeases(f.runner, active, activation, CURRENT.join(','));
    assert.equal((await row(active)).inboxLeaseGeneration, generation);
    await f.beat();
    // Capability withdrawal applies even to an idempotent activation of the installed generation.
    await assert.rejects(() => api.activateLeases(f.runner, active, activation, CURRENT.join(',')), /DeepSeek|update|newer/i);
    await assert.rejects(() => api.takeoverLeases(f.runner, active,
      { leaseOwner: randomUUID(), expectedLeaseOwner: winner } as never, undefined, CURRENT.join(',')), /DeepSeek|update|newer/i);
    assert.equal((await row(active)).inboxLeaseOwner, winner);
  });

  await t.test('P1b existing engines and legacy dsh identities still dispatch', async () => {
    const f = await fixture(16);
    for (const engine of LEGACY) {
      const id = await f.session(engine);
      const job = await f.claim(LEGACY);
      assert.equal(job?.sessionId, id);
      assert.equal(job?.provider, engine, `existing ${engine} engine dispatch changed`);
      assert.equal((await f.reclaim(LEGACY)).sessions.find((s) => s.sessionId === id)?.provider, engine);
    }
    // An old control plane omits provider_builtin, whose database default is false. These four
    // pre-discriminator builtins keep the same meaning in a mixed control-plane deployment.
    for (const engine of [AgentProvider.CLAUDE, AgentProvider.CODEX, AgentProvider.OPENCODE, AgentProvider.ANTIGRAVITY]) {
      const id = await f.session(engine, false);
      assert.equal((await f.claim(LEGACY))?.sessionId, id);
      assert.equal((await f.reclaim(LEGACY)).sessions.find((s) => s.sessionId === id)?.provider, engine);
    }
    const legacy = await f.provider('claude', true, 'dsh');
    const id = await f.session('dsh', false);
    const job = await f.claim(LEGACY);
    assert.equal(job?.sessionId, id);
    assert.equal(job?.provider, AgentProvider.CLAUDE);
    assert.equal(job?.agent.env?.ANTHROPIC_AUTH_TOKEN, legacy.key);
    assert.ok((await f.reclaim(LEGACY)).sessions.some((s) => s.sessionId === id && s.provider === AgentProvider.CLAUDE));
    await db.modelProvider.update({ where: { slug: 'dsh' }, data: { runtime: 'dsh' } });
    const borrowed = await f.session('dsh', false);
    assert.equal(await f.claim(LEGACY), null, 'a colliding slug borrowing Harness still needs the capability');
    assert.equal(await rawUpdate(borrowed, "status = 'RUNNING'"), 0);
    await f.beat(CURRENT);
    assert.equal((await f.claim(CURRENT))?.provider, AgentProvider.DSH);
    assert.equal((await db.modelProvider.findUniqueOrThrow({ where: { slug: 'dsh' } })).slug, 'dsh');

    await db.modelProvider.update({ where: { slug: 'dsh' }, data: { runtime: 'antigravity' } });
    const native = await f.session('dsh', true);
    const withoutAntigravity = CURRENT.filter((engine) => engine !== AgentProvider.ANTIGRAVITY);
    await f.beat(withoutAntigravity);
    const nativeJob = await f.claim(withoutAntigravity);
    assert.equal(nativeJob?.sessionId, native);
    assert.equal(nativeJob?.provider, AgentProvider.DSH, 'native Harness must ignore a colliding Antigravity provider');
    assert.ok((await f.reclaim(withoutAntigravity)).sessions.some((s) => s.sessionId === native && s.provider === AgentProvider.DSH));
    const legacyAntigravity = await f.session('dsh', false);
    assert.equal(await f.claim(withoutAntigravity), null, 'the configured colliding identity still requires Antigravity');
    assert.equal(await rawUpdate(legacyAntigravity, "status = 'RUNNING'", true), 0, 'the Antigravity database barrier still applies to the configured identity');
    assert.ok(!(await f.reclaim(withoutAntigravity)).sessions.some((s) => s.sessionId === legacyAntigravity));
    assert.equal((await f.claim(LEGACY))?.provider, AgentProvider.ANTIGRAVITY);
    assert.ok((await f.reclaim(LEGACY)).sessions.some((s) => s.sessionId === legacyAntigravity && s.provider === AgentProvider.ANTIGRAVITY));
  });

  await t.test('P1b unavailable and unknown providers never dispatch as Claude', async () => {
    const f = await fixture();
    await f.beat(CURRENT);
    const disabled = await f.provider('dsh', false);
    const unknownRuntime = await f.provider('unknown-runtime');
    const foreign = await (await fixture()).provider();
    for (const slug of [disabled.slug, unknownRuntime.slug, foreign.slug, `missing-${randomUUID()}`]) {
      const id = await f.session(slug, false);
      assert.equal(await f.claim(CURRENT), null, `unavailable ${slug} produced a job`);
      assert.equal((await row(id)).status, RunStatus.PENDING);
      assert.equal((await row(id)).error, PROVIDER_UNAVAILABLE_ERROR);
      assert.ok(!(await f.reclaim(CURRENT)).sessions.some((s) => s.sessionId === id), 'invalid provider reappeared on reclaim');
    }
    const claude = await f.session('claude');
    assert.equal((await f.claim(CURRENT))?.sessionId, claude, 'an unavailable provider must not strand another engine');
  });
});
