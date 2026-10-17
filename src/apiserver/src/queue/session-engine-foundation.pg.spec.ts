/**
 * The provider/engine split's first step on a real PostgreSQL (docs/provider-engine-contract.md §1,
 * §4, §5, §7.1; migration 0414): every shape of session is backfilled with the engine that produced
 * its runtime id, the database keeps a recorded engine fixed and refuses it to a transaction that
 * does not read it, the runtime capability gates follow the engine rather than the key, and every
 * run path — claim, reclaim, lease takeover and activation, meta, create, resume, steer, move —
 * reads the session's engine, so editing, disabling or deleting a key never moves a session onto
 * another CLI. Named in scripts/test-provider-engine-foundation.mjs; a missing server is a failure,
 * not a skip.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { RunStatus, RunnerStatus } from '@prisma/client';
import { AgentProvider, SESSION_CODEX_STEER_V1 } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { newTerminalResumeHandoffOwner } from '../common/session-inbox-fence';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { engineIncompatibleMessage } from '../providers/custom-provider';
import { encryptSecret } from '../providers/provider-crypto';
import { ProvidersService } from '../providers/providers.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { PROVIDER_UNAVAILABLE_ERROR } from '../runner-api/runner-provider-support';
import { MOVE_REFUSAL } from '../sessions/session-move';
import { SessionsService } from '../sessions/sessions.service';
import { QueueService } from './queue.service';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY ??= 'session-engine-foundation-spec';
const MIGRATION = readFileSync(
  path.join(__dirname, '..', '..', 'prisma', 'migrations', '0414_session_engine', 'migration.sql'),
  'utf8',
);
/** The backfill exactly as the migration runs it: its Session and Task sections. */
const BACKFILL = MIGRATION.slice(
  MIGRATION.indexOf('-- 2. Backfill Session.engine'),
  MIGRATION.indexOf('-- 4. The runtime claim guards'),
);
const ALL = [
  AgentProvider.CLAUDE, AgentProvider.CODEX, AgentProvider.KIMI,
  AgentProvider.OPENCODE, AgentProvider.ANTIGRAVITY, AgentProvider.DSH,
];
const WITHOUT = (...engines: AgentProvider[]) => ALL.filter((engine) => !engines.includes(engine));
const DECLARED = "SELECT set_config('orbit.claim_reads_session_engine', '1', true)";

test('T2 provider-engine foundation on PostgreSQL', { timeout: 600_000 }, async (t) => {
  assert.ok(BACKFILL.includes('UPDATE "session"') && BACKFILL.includes('UPDATE "task"'), 'the backfill sections moved');
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(URL);
  t.after(async () => { await db.$disconnect(); await sql.end(); });

  // The DeepSeek Harness permission policy is P4's, and refuses the account default these fixtures
  // carry; scheduling, keys and PostgreSQL stay real (the same seam dsh-provider-gate.pg.spec uses).
  const runtimePolicy = require('../common/runtime-provider') as typeof import('../common/runtime-provider');
  const originalPermissionPolicy = runtimePolicy.normalizeBuiltinPermissionMode;
  runtimePolicy.normalizeBuiltinPermissionMode = (...args: Parameters<typeof originalPermissionPolicy>) =>
    args[0] === AgentProvider.DSH ? args[2] : originalPermissionPolicy(...args);
  t.after(() => { runtimePolicy.normalizeBuiltinPermissionMode = originalPermissionPolicy; });

  // Every announcement is a no-op here; the drains answer nothing pending.
  const drains = {
    drainCancellations: async () => [], drainMergeRequests: async () => [],
    drainCommitRequests: async () => [], drainArtifactRequests: async () => [],
  } as Record<string, unknown>;
  const realtime = new Proxy(drains, {
    get: (target, name: string) => target[name] ?? (() => undefined),
  }) as unknown as RealtimeService;
  const queue = new QueueService(db as unknown as PrismaService, realtime);
  // References in a delivered turn are expanded by their own service; the turns here carry none.
  const references = { expand: async (_ownerId: string, content: string | null | undefined) => content };
  const api = new RunnerApiController(db as never, queue as never, realtime as never, {} as never, {} as never, references as never);
  const sessions = new SessionsService(db as unknown as PrismaService, queue, realtime);
  const providers = new ProvidersService(db as unknown as PrismaService, realtime, {} as never);

  async function account(label: string, role: 'USER' | 'ADMIN' = 'USER') {
    const id = randomUUID();
    await db.user.create({ data: { id, email: `${label}-${id}@engine.invalid`, name: label, passwordHash: 'x', role } });
    return id;
  }
  /** A runner of `ownerId`'s, online, declaring DeepSeek Harness on its persisted heartbeat, and a
   *  workspace on it. */
  async function machine(ownerId: string, capabilities: string[] = ['provider:dsh']) {
    const id = randomUUID();
    const workspaceId = randomUUID();
    await db.runner.create({ data: {
      id, ownerId, name: 'engine', tokenHash: `x-${id}`, status: RunnerStatus.ONLINE, maxConcurrent: 64,
      capabilities, capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    } });
    await db.workspace.create({ data: {
      id: workspaceId, ownerId, runnerId: id, name: 'engine', enabled: true, workDir: '/tmp/engine',
    } });
    return { id, ownerId, workspaceId, runner: { id, ownerId, version: null } };
  }
  async function key(
    ownerId: string | null,
    opts: { runtime?: string; presetSlug?: string | null; baseUrl?: string; enabled?: boolean; slug?: string } = {},
  ) {
    const slug = opts.slug ?? `key-${randomUUID().slice(0, 12)}`;
    const apiKey = `sk-${randomUUID()}`;
    const { id } = await db.modelProvider.create({ data: {
      slug, label: slug, runtime: opts.runtime ?? 'claude', presetSlug: opts.presetSlug ?? null,
      baseUrl: opts.baseUrl ?? 'https://api.example.test', apiKeyEnc: encryptSecret(apiKey),
      enabled: opts.enabled ?? true, ownerId,
    } });
    return { id, slug, apiKey };
  }
  /** A DeepSeek key: the `deepseek` preset, Anthropic-compatible, on DeepSeek's own endpoint. */
  const deepSeekKey = (ownerId: string, enabled = true) =>
    key(ownerId, { presetSlug: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', enabled });
  async function pool(ownerId: string, engine: 'claude' | 'codex', shared = false) {
    const slug = `pool-${randomUUID().slice(0, 12)}`;
    const created = await db.providerPool.create({ data: { slug, label: slug, ownerId, engine, shared } });
    return { slug, id: created.id };
  }
  async function session(
    on: { ownerId: string; id: string; workspaceId: string },
    provider: string,
    opts: {
      providerBuiltin?: boolean; engine?: string | null; status?: RunStatus; runtimeSessionId?: string | null;
      model?: string | null; taskId?: string; startsTaskWork?: boolean; effort?: string | null; numTurns?: number;
    } = {},
  ) {
    return (await db.session.create({ data: {
      title: 'engine', prompt: '', ownerId: on.ownerId, creatorId: on.ownerId, workspaceId: on.workspaceId,
      assignedRunnerId: on.id, provider, providerBuiltin: opts.providerBuiltin ?? false,
      ...(opts.engine !== undefined ? { engine: opts.engine } : {}),
      status: opts.status ?? RunStatus.PENDING, usesRuntimeDefaultModel: true,
      model: opts.model === undefined ? 'pinned-model' : opts.model,
      runtimeSessionId: opts.runtimeSessionId ?? null,
      // A session that ran a turn was claimed once: resume refuses one that never was.
      ...(opts.numTurns !== undefined ? { numTurns: opts.numTurns, startedAt: new Date() } : {}),
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
      ...(opts.taskId ? { taskId: opts.taskId, startsTaskWork: opts.startsTaskWork ?? true } : {}),
    } })).id;
  }
  async function task(ownerId: string, provider: string | null) {
    return (await db.task.create({ data: {
      ownerId, title: `pinned to ${provider}`, creatorType: 'USER', creatorId: ownerId,
      completionCriterion: 'EVIDENCE_JUDGMENT', provider,
    } })).id;
  }
  let seq = 0;
  const event = (sessionId: string, payload: Record<string, unknown>) =>
    db.runEvent.create({ data: { sessionId, seq: ++seq, type: 'system', payload: payload as never } });
  const engineOf = async (id: string) => (await db.session.findUniqueOrThrow({ where: { id } })).engine;
  const row = (id: string) => db.session.findUniqueOrThrow({ where: { id } });
  const backfill = () => sql.query(BACKFILL);
  /** One raw statement in its own transaction, with the transaction-local settings named first. */
  async function raw(statement: string, params: unknown[], settings: Record<string, string> = {}) {
    await sql.query('BEGIN');
    try {
      for (const [name, value] of Object.entries(settings)) {
        await sql.query('SELECT set_config($1, $2, true)', [name, value]);
      }
      const result = await sql.query(statement, params);
      await sql.query('COMMIT');
      return result.rowCount;
    } catch (error) {
      await sql.query('ROLLBACK');
      throw error;
    }
  }
  const claimRaw = (id: string, settings: Record<string, string> = {}) =>
    raw(`UPDATE "session" SET status = 'RUNNING' WHERE id = $1 AND status = 'PENDING'`, [id], settings);
  const reads = { 'orbit.claim_reads_session_engine': '1' };

  await t.test('T2 backfill records built-in sign-ins, OpenCode own config and the built-in dsh as themselves', async () => {
    const owner = await account('builtin');
    const at = await machine(owner);
    const rows: Array<[string, string]> = [];
    // An older replica omits provider_builtin, whose default is false: the four unambiguous slugs
    // are themselves whatever it says.
    for (const provider of [AgentProvider.CLAUDE, AgentProvider.CODEX, AgentProvider.OPENCODE, AgentProvider.ANTIGRAVITY]) {
      rows.push([await session(at, provider, { providerBuiltin: false }), provider]);
    }
    rows.push([await session(at, AgentProvider.KIMI, { providerBuiltin: true }), AgentProvider.KIMI]);
    rows.push([await session(at, AgentProvider.DSH, { providerBuiltin: true }), AgentProvider.DSH]);
    await backfill();
    for (const [id, engine] of rows) assert.equal(await engineOf(id), engine);
  });

  await t.test('T2 backfill records a key session on every protocol as its row runtime, disabled and out-of-reach rows included', async () => {
    const owner = await account('keys');
    const at = await machine(owner);
    const rows: Array<[string, string]> = [];
    for (const runtime of ['claude', 'codex', 'kimi', 'antigravity']) {
      rows.push([await session(at, (await key(owner, { runtime })).slug), runtime]);
    }
    // Disabled: not Claude, as execRuntime used to read it — the runtime it ran on.
    rows.push([await session(at, (await key(owner, { runtime: 'codex', enabled: false })).slug), 'codex']);
    // A shared key a member may not use: still the engine it ran on.
    rows.push([await session(at, (await key(null, { runtime: 'kimi' })).slug), 'kimi']);
    // A configured identity named `kimi` was renamed by 0077; one named like a key of another owner
    // is no key of this session's, and is unresolved below (it is not this owner's).
    await backfill();
    for (const [id, engine] of rows) assert.equal(await engineOf(id), engine);
  });

  await t.test('T2 backfill records own and shared account pools as the pool engine', async () => {
    const owner = await account('pools');
    const other = await account('pool-owner');
    const at = await machine(owner);
    const own = await pool(owner, 'claude');
    const ownCodex = await pool(owner, 'codex');
    const shared = await pool(other, 'codex', true);
    await db.providerPoolPerson.create({ data: { poolId: shared.id, userId: owner, role: 'MEMBER' } });
    const rows: Array<[string, string]> = [
      [await session(at, own.slug), 'claude'],
      [await session(at, ownCodex.slug), 'codex'],
      [await session(at, shared.slug), 'codex'],
    ];
    await backfill();
    for (const [id, engine] of rows) assert.equal(await engineOf(id), engine);
  });

  await t.test('T2 backfill records an OpenCode session on a key and a DeepSeek Harness row session', async () => {
    const owner = await account('opencode-dsh');
    const at = await machine(owner);
    const anthropic = await key(owner);
    const onKey = await session(at, AgentProvider.OPENCODE, { providerBuiltin: true, model: `orbit-${anthropic.slug}/glm-5` });
    const harnessRow = await key(owner, { runtime: 'dsh', presetSlug: 'deepseek-harness', baseUrl: 'https://api.deepseek.com/anthropic' });
    const onHarness = await session(at, harnessRow.slug);
    // `dsh` that does not say it is the built-in engine names a configured identity (0377 kept
    // them); with no row, pool or event of its own it is unknown — never Claude.
    const colliding = await session(at, AgentProvider.DSH, { providerBuiltin: false });
    await backfill();
    assert.equal(await engineOf(onKey), AgentProvider.OPENCODE);
    assert.equal(await engineOf(onHarness), AgentProvider.DSH);
    assert.equal(await engineOf(colliding), null);
  });

  await t.test('T2 backfill reads a deleted key from the init event, Claude Code without a provider, and leaves the rest unresolved', async () => {
    const owner = await account('deleted');
    const at = await machine(owner);
    const codexThread = `thread-${randomUUID()}`;
    const ranCodex = await session(at, 'gone-codex-key', { runtimeSessionId: codexThread });
    await event(ranCodex, { subtype: 'init', sessionId: codexThread, provider: 'codex' });
    const claudeId = randomUUID();
    const ranClaude = await session(at, 'gone-claude-key', { runtimeSessionId: claudeId });
    // Claude Code's own init carries no provider (runner-go claude.go).
    await event(ranClaude, { subtype: 'init', sessionId: claudeId, model: 'deepseek-flash' });
    const resumedKimi = await session(at, 'gone-kimi-key', { runtimeSessionId: 'kimi-1' });
    await event(resumedKimi, { subtype: 'init', sessionId: 'kimi-0', provider: 'codex' });
    await event(resumedKimi, { subtype: 'resumed', sessionId: 'kimi-1', provider: 'kimi', runtime: 'acp' });
    const neverRan = await session(at, 'gone-unused-key');
    const otherConversation = await session(at, 'gone-other-key', { runtimeSessionId: 'mine' });
    await event(otherConversation, { subtype: 'init', sessionId: 'not-mine', provider: 'codex' });
    await backfill();
    assert.equal(await engineOf(ranCodex), AgentProvider.CODEX);
    assert.equal(await engineOf(ranClaude), AgentProvider.CLAUDE);
    assert.equal(await engineOf(resumedKimi), AgentProvider.KIMI, 'the event of its own runtime id, the latest of them');
    assert.equal(await engineOf(neverRan), null);
    assert.equal(await engineOf(otherConversation), null, 'an event of another conversation says nothing');
  });

  await t.test('T2 backfill prefers the init event over a key runtime edited since', async () => {
    const owner = await account('edited');
    const at = await machine(owner);
    const edited = await key(owner, { runtime: 'claude' });
    const thread = `thread-${randomUUID()}`;
    const ran = await session(at, edited.slug, { runtimeSessionId: thread });
    await event(ran, { subtype: 'init', sessionId: thread, provider: 'codex' });
    const fresh = await session(at, edited.slug);
    await backfill();
    assert.equal(await engineOf(ran), AgentProvider.CODEX, 'Codex minted its id, whatever the row says now');
    assert.equal(await engineOf(fresh), AgentProvider.CLAUDE, 'a session that never ran takes the row');
  });

  await t.test('T2 backfill gives pinned tasks the engine their pin dispatches on today', async () => {
    const owner = await account('tasks');
    const other = await account('dsh-row-owner');
    const codexKey = await key(owner, { runtime: 'codex' });
    const disabled = await key(owner, { runtime: 'kimi', enabled: false });
    const codexPool = await pool(owner, 'codex');
    const pins: Array<[string | null, string | null]> = [
      [AgentProvider.CLAUDE, 'claude'], [AgentProvider.KIMI, 'kimi'], [AgentProvider.OPENCODE, 'opencode'],
      [AgentProvider.ANTIGRAVITY, 'antigravity'], [codexKey.slug, 'codex'], [disabled.slug, 'kimi'],
      [codexPool.slug, 'codex'], [AgentProvider.DSH, 'dsh'], ['nothing-holds-this', null], [null, null],
    ];
    const ids = await Promise.all(pins.map(([provider]) => task(owner, provider)));
    // A configured row named `dsh` of the task owner's own is that key, as SessionsService.create reads it.
    const collidingSlug = AgentProvider.DSH;
    const existing = await db.modelProvider.findUnique({ where: { slug: collidingSlug } });
    let collidingTask: string | null = null;
    if (!existing) {
      await db.modelProvider.create({ data: {
        slug: collidingSlug, label: 'colliding', runtime: 'codex', baseUrl: 'https://x.test', apiKeyEnc: encryptSecret('x'), ownerId: other,
      } });
      collidingTask = await task(other, collidingSlug);
    }
    await backfill();
    for (const [index, [, engine]] of pins.entries()) {
      assert.equal((await db.task.findUniqueOrThrow({ where: { id: ids[index] } })).engine, engine, `pin ${pins[index][0]}`);
    }
    if (collidingTask) {
      assert.equal((await db.task.findUniqueOrThrow({ where: { id: collidingTask } })).engine, 'codex');
      await db.modelProvider.delete({ where: { slug: collidingSlug } });
    }
  });

  await t.test('T2 backfill is idempotent', async () => {
    const before = await sql.query('SELECT id, engine FROM "session" ORDER BY id');
    const tasksBefore = await sql.query('SELECT id, engine FROM "task" ORDER BY id');
    await backfill();
    await backfill();
    assert.deepEqual((await sql.query('SELECT id, engine FROM "session" ORDER BY id')).rows, before.rows);
    assert.deepEqual((await sql.query('SELECT id, engine FROM "task" ORDER BY id')).rows, tasksBefore.rows);
  });

  await t.test('T2 a recorded engine never changes and a missing one may be recorded once', async () => {
    const owner = await account('immutable');
    const at = await machine(owner);
    const recorded = await session(at, AgentProvider.CODEX, { engine: AgentProvider.CODEX });
    await assert.rejects(
      () => raw('UPDATE "session" SET engine = $2 WHERE id = $1', [recorded, AgentProvider.CLAUDE]),
      (error: { code?: string; constraint?: string }) =>
        error.code === '23514' && error.constraint === 'session_engine_immutable',
    );
    await assert.rejects(() => raw('UPDATE "session" SET engine = NULL WHERE id = $1', [recorded]), /never changes/);
    assert.equal(await raw('UPDATE "session" SET engine = $2 WHERE id = $1', [recorded, AgentProvider.CODEX]), 1, 'the same value is no change');
    const missing = await session(at, 'gone-key');
    assert.equal(await raw('UPDATE "session" SET engine = $2 WHERE id = $1', [missing, AgentProvider.KIMI]), 1);
    await assert.rejects(() => raw('UPDATE "session" SET engine = $2 WHERE id = $1', [missing, AgentProvider.CLAUDE]), /never changes/);
    // Only the six engines, on either table.
    const unrecorded = await session(at, 'gone-key');
    await assert.rejects(() => raw('UPDATE "session" SET engine = $2 WHERE id = $1', [unrecorded, 'gpt']), /session_engine_check/);
    const unpinned = await task(owner, null);
    await assert.rejects(() => raw('UPDATE "task" SET engine = $2 WHERE id = $1', [unpinned, 'gpt']), /task_engine_check/);
  });

  await t.test('T2 a claim that does not declare reading the engine is skipped for a session that has one', async () => {
    const owner = await account('claim-guard');
    const at = await machine(owner);
    for (const engine of ALL) {
      const id = await session(at, engine, { providerBuiltin: true, engine });
      const capable = {
        'orbit.runner_supports_opencode': '1', 'orbit.runner_supports_antigravity': '1', 'orbit.runner_supports_dsh': '1',
      };
      assert.equal(await claimRaw(id, capable), 0, `an older replica claimed a ${engine} session`);
      assert.equal((await row(id)).status, RunStatus.PENDING);
      assert.equal(await claimRaw(id, { ...capable, ...reads }), 1);
    }
    // A session an older replica created itself has no engine, and stays its to claim.
    const unrecorded = await session(at, AgentProvider.CLAUDE, { providerBuiltin: true });
    assert.equal(await claimRaw(unrecorded), 1);
  });

  await t.test('T2 a lease takeover or activation that does not declare it is refused, before the dsh guard can skip it', async () => {
    const owner = await account('lease-guard');
    const at = await machine(owner);
    const recorded = await session(at, AgentProvider.CODEX, { providerBuiltin: true, engine: AgentProvider.CODEX, status: RunStatus.RUNNING });
    const refused = /does not read session engines/;
    await assert.rejects(() => raw('UPDATE "session" SET inbox_lease_owner = $2 WHERE id = $1', [recorded, randomUUID()]), refused);
    await assert.rejects(() => raw('UPDATE "session" SET inbox_lease_generation = $2 WHERE id = $1', [recorded, randomUUID()]), refused);
    await assert.rejects(
      () => raw('UPDATE "session" SET inbox_lease_owner = $2 WHERE id = $1', [recorded, randomUUID()]),
      (error: { code?: string }) => error.code === '55000',
    );
    const owner2 = randomUUID();
    assert.equal(await raw('UPDATE "session" SET inbox_lease_owner = $2 WHERE id = $1', [recorded, owner2], reads), 1);
    assert.equal(await raw('UPDATE "session" SET inbox_lease_generation = $2 WHERE id = $1', [recorded, randomUUID()], reads), 1);
    assert.equal(await raw('UPDATE "session" SET inbox_lease_owner = NULL, inbox_lease_generation = NULL WHERE id = $1', [recorded]), 1, 'release stays open');
    assert.equal(await raw(`UPDATE "session" SET status = 'CANCELLED' WHERE id = $1`, [recorded]), 1);
    assert.equal(
      await raw(`UPDATE "session" SET status = 'PENDING', inbox_lease_owner = $2 WHERE id = $1`, [recorded, newTerminalResumeHandoffOwner()]),
      1, 'a server terminal revive only reserves its handoff marker',
    );
    // Harness on a DeepSeek key, whose runtime an older replica reads as Claude: it never declares
    // dsh for it, so the dsh guard would drop its lease write in silence. This guard speaks first.
    const ds = await deepSeekKey(owner);
    const harness = await session(at, ds.slug, { engine: AgentProvider.DSH, status: RunStatus.RUNNING });
    await assert.rejects(() => raw('UPDATE "session" SET inbox_lease_owner = $2 WHERE id = $1', [harness, randomUUID()]), refused);
    assert.equal((await row(harness)).inboxLeaseOwner, null);
  });

  await t.test('T2 the DeepSeek Harness capability gate follows the session engine, not the key runtime', async () => {
    const owner = await account('dsh-gate');
    const at = await machine(owner, []);
    const ds = await deepSeekKey(owner);
    const harness = await session(at, ds.slug, { engine: AgentProvider.DSH, model: 'opaque-acp-model' });
    // A runner that does not declare Harness is not handed it, though the key's runtime is Claude's.
    assert.equal(await queue.claimSessionForRunner({ id: at.id, supportedProviders: WITHOUT(AgentProvider.DSH) }), null);
    assert.equal(await claimRaw(harness, { ...reads }), 0, 'the database repeats the gate');
    assert.equal(await claimRaw(harness, { ...reads, 'orbit.runner_supports_dsh': '1' }), 0, 'and wants the heartbeat too');
    await db.runner.update({ where: { id: at.id }, data: { capabilities: ['provider:dsh'], capabilitiesReportedAt: new Date() } });
    const job = await queue.claimSessionForRunner({ id: at.id, supportedProviders: ALL });
    assert.equal(job?.sessionId, harness);
    assert.equal(job?.provider, AgentProvider.DSH);
    assert.equal(job?.agent.env?.ORBIT_DSH_API_KEY, ds.apiKey);
    assert.equal(job?.agent.env?.ORBIT_DSH_BASE_URL, 'https://api.deepseek.com/anthropic');
    assert.equal(job?.agent.env?.ANTHROPIC_AUTH_TOKEN, undefined);
    // …and a Claude Code session on a legacy Harness row is not gated as Harness.
    const legacy = await key(owner, { runtime: 'dsh', presetSlug: 'deepseek-harness', baseUrl: 'https://api.deepseek.com/anthropic' });
    const onClaude = await session(at, legacy.slug, { engine: AgentProvider.CLAUDE, model: 'deepseek-flash' });
    const claude = await queue.claimSessionForRunner({ id: at.id, supportedProviders: WITHOUT(AgentProvider.DSH) });
    assert.equal(claude?.sessionId, onClaude);
    assert.equal(claude?.provider, AgentProvider.CLAUDE);
    assert.equal(claude?.agent.env?.ANTHROPIC_AUTH_TOKEN, legacy.apiKey);
    // A key that is not DeepSeek's carries no Harness session: held with the reason, never run.
    const plain = await key(owner);
    const wrong = await session(at, plain.slug, { engine: AgentProvider.DSH });
    assert.equal(await queue.claimSessionForRunner({ id: at.id, supportedProviders: ALL }), null);
    assert.equal((await row(wrong)).error, engineIncompatibleMessage(plain.slug, AgentProvider.DSH, [AgentProvider.CLAUDE, AgentProvider.OPENCODE]));
    assert.equal(await engineOf(wrong), AgentProvider.DSH);
  });

  await t.test('T2 the OpenCode and Antigravity gates follow the session engine', async () => {
    const owner = await account('runtime-gates');
    const at = await machine(owner);
    const gemini = await key(owner, { runtime: 'antigravity', presetSlug: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' });
    // OpenCode on a Gemini key: an OpenCode job, not an Antigravity one.
    const onOpenCode = await session(at, gemini.slug, { engine: AgentProvider.OPENCODE, model: 'gemini-3.8-flash' });
    assert.equal(await queue.claimSessionForRunner({ id: at.id, supportedProviders: WITHOUT(AgentProvider.OPENCODE) }), null);
    assert.equal(await claimRaw(onOpenCode, { ...reads, 'orbit.runner_supports_antigravity': '1' }), 0);
    const job = await queue.claimSessionForRunner({ id: at.id, supportedProviders: WITHOUT(AgentProvider.ANTIGRAVITY) });
    assert.equal(job?.sessionId, onOpenCode, 'a runner without Antigravity runs it');
    assert.equal(job?.provider, AgentProvider.OPENCODE);
    assert.equal(job?.agent.model, `orbit-${gemini.slug}/gemini-3.8-flash`);
    assert.match(job?.agent.env?.OPENCODE_CONFIG_CONTENT ?? '', new RegExp(gemini.apiKey));
    assert.equal(job?.agent.env?.GEMINI_API_KEY, undefined);
    // Antigravity on the same key still needs Antigravity.
    const onAgy = await session(at, gemini.slug, { engine: AgentProvider.ANTIGRAVITY, model: 'gemini-3.8-flash' });
    assert.equal(await queue.claimSessionForRunner({ id: at.id, supportedProviders: WITHOUT(AgentProvider.ANTIGRAVITY) }), null);
    assert.equal(await claimRaw(onAgy, { ...reads, 'orbit.runner_supports_opencode': '1' }), 0);
    const agy = await queue.claimSessionForRunner({ id: at.id, supportedProviders: ALL });
    assert.equal(agy?.sessionId, onAgy);
    assert.equal(agy?.agent.env?.GEMINI_API_KEY, gemini.apiKey);
  });

  await t.test("T2 an older replica's run on the pinned credential takes the task's engine pin", async () => {
    const owner = await account('pin');
    const at = await machine(owner);
    const ds = await deepSeekKey(owner);
    const pinned = await task(owner, ds.slug);
    await db.task.update({ where: { id: pinned }, data: { engine: AgentProvider.DSH } });
    const run = await session(at, ds.slug, { taskId: pinned });
    assert.equal(await engineOf(run), AgentProvider.DSH);
    assert.equal(await claimRaw(run, { 'orbit.runner_supports_dsh': '1' }), 0, 'so that replica cannot run it as Claude');
    await db.session.update({ where: { id: run }, data: { status: RunStatus.CANCELLED } });
    const other = await key(owner);
    const elsewhere = await session(at, other.slug, { taskId: pinned });
    assert.equal(await engineOf(elsewhere), null, 'a run on another credential is not the pin');
    await db.session.update({ where: { id: elsewhere }, data: { status: RunStatus.CANCELLED } });
    const conversation = await session(at, ds.slug, { taskId: pinned, startsTaskWork: false });
    assert.equal(await engineOf(conversation), null, 'a conversation about the task is not its run');
  });

  await t.test('T2 the claim records the engine of a session an older replica wrote', async () => {
    const owner = await account('record');
    const at = await machine(owner);
    const codexKey = await key(owner, { runtime: 'codex' });
    const unrecorded = await session(at, codexKey.slug, { model: 'gpt-6' });
    assert.equal(await engineOf(unrecorded), null);
    const job = await queue.claimSessionForRunner({ id: at.id, supportedProviders: ALL });
    assert.equal(job?.sessionId, unrecorded);
    assert.equal(job?.provider, AgentProvider.CODEX);
    assert.equal(await engineOf(unrecorded), AgentProvider.CODEX);
    // Recorded, it no longer follows the key: an edit now holds it instead of moving it.
    await db.modelProvider.update({ where: { slug: codexKey.slug }, data: { runtime: 'claude' } });
    assert.equal(await engineOf(unrecorded), AgentProvider.CODEX);
  });

  await t.test('T2 one DeepSeek key runs Claude Code, OpenCode and DeepSeek Harness sessions, each in its own variables', async () => {
    const owner = await account('one-key');
    const at = await machine(owner);
    const ds = await deepSeekKey(owner);
    const jobs = new Map<string, Awaited<ReturnType<typeof queue.claimSessionForRunner>>>();
    for (const engine of [AgentProvider.CLAUDE, AgentProvider.OPENCODE, AgentProvider.DSH]) {
      const id = await session(at, ds.slug, { engine, model: engine === AgentProvider.DSH ? 'opaque' : 'deepseek-flash' });
      const job = await queue.claimSessionForRunner({ id: at.id, supportedProviders: ALL });
      assert.equal(job?.sessionId, id);
      jobs.set(engine, job);
    }
    const claude = jobs.get(AgentProvider.CLAUDE)!;
    assert.equal(claude.provider, AgentProvider.CLAUDE);
    assert.equal(claude.agent.env?.ANTHROPIC_AUTH_TOKEN, ds.apiKey);
    assert.equal(claude.agent.env?.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
    const openCode = jobs.get(AgentProvider.OPENCODE)!;
    assert.equal(openCode.provider, AgentProvider.OPENCODE);
    assert.equal(openCode.agent.model, `orbit-${ds.slug}/deepseek-flash`);
    const config = JSON.parse(openCode.agent.env?.OPENCODE_CONFIG_CONTENT ?? '{}');
    assert.equal(config.provider[`orbit-${ds.slug}`].options.apiKey, ds.apiKey);
    assert.equal(config.provider[`orbit-${ds.slug}`].options.baseURL, 'https://api.deepseek.com/anthropic/v1');
    assert.equal(openCode.agent.env?.ANTHROPIC_AUTH_TOKEN, undefined);
    const harness = jobs.get(AgentProvider.DSH)!;
    assert.equal(harness.provider, AgentProvider.DSH);
    assert.equal(harness.agent.env?.ORBIT_DSH_API_KEY, ds.apiKey);
    assert.equal(harness.agent.env?.ORBIT_DSH_BASE_URL, 'https://api.deepseek.com/anthropic');
  });

  await t.test('T2 changing a key protocol, disabling it or deleting it never changes a session engine', async () => {
    const owner = await account('key-edits');
    const at = await machine(owner);
    const k = await key(owner, { runtime: 'claude' });
    const id = await session(at, k.slug, { engine: AgentProvider.CLAUDE, model: 'glm-5' });
    await db.modelProvider.update({ where: { slug: k.slug }, data: { runtime: 'codex' } });
    assert.equal(await queue.claimSessionForRunner({ id: at.id, supportedProviders: ALL }), null, 'not run as Codex');
    assert.equal((await row(id)).status, RunStatus.PENDING);
    assert.equal((await row(id)).error, engineIncompatibleMessage(k.slug, AgentProvider.CLAUDE, [AgentProvider.CODEX, AgentProvider.OPENCODE]));
    assert.equal(await engineOf(id), AgentProvider.CLAUDE);
    await db.modelProvider.update({ where: { slug: k.slug }, data: { runtime: 'claude' } });
    const job = await queue.claimSessionForRunner({ id: at.id, supportedProviders: ALL });
    assert.equal(job?.sessionId, id);
    assert.equal(job?.provider, AgentProvider.CLAUDE);
    assert.equal(job?.agent.env?.ANTHROPIC_AUTH_TOKEN, k.apiKey);
    assert.equal((await row(id)).error, null, 'the claim clears the hold');

    const codexKey = await key(owner, { runtime: 'codex' });
    const onCodex = await session(at, codexKey.slug, { engine: AgentProvider.CODEX, model: 'gpt-6' });
    await db.modelProvider.update({ where: { slug: codexKey.slug }, data: { enabled: false } });
    assert.equal(await queue.claimSessionForRunner({ id: at.id, supportedProviders: ALL }), null, 'not run on the Claude login either');
    assert.equal((await row(onCodex)).error, PROVIDER_UNAVAILABLE_ERROR);
    assert.equal(await engineOf(onCodex), AgentProvider.CODEX);
    await db.modelProvider.delete({ where: { slug: codexKey.slug } });
    assert.equal(await queue.claimSessionForRunner({ id: at.id, supportedProviders: ALL }), null);
    assert.equal((await row(onCodex)).error, PROVIDER_UNAVAILABLE_ERROR);
    assert.equal(await engineOf(onCodex), AgentProvider.CODEX);
    // Its steer, move and meta still answer for Codex (the scenarios below), not for the Claude a
    // missing key used to read as.

    // A session an older replica wrote carries no engine: editing its key through the door records
    // the one it runs on first, so the edit does not become its engine either. The door refuses a
    // protocol its open session's engine would lose (T3, PROVIDER_DIALECT_IN_USE); an edit it takes —
    // here the endpoint — records the engine, and a protocol changed behind the door then holds it.
    const edited = await key(owner, { runtime: 'kimi', presetSlug: 'moonshot', baseUrl: 'https://api.moonshot.ai/v1' });
    const unrecorded = await session(at, edited.slug, { model: 'kimi-k3' });
    await assert.rejects(providers.update(owner, edited.id, { runtime: 'codex' } as never),
      (error: { response?: { code?: string } }) => error.response?.code === 'PROVIDER_DIALECT_IN_USE');
    await providers.update(owner, edited.id, { baseUrl: 'https://api.moonshot.cn/v1' } as never);
    await db.modelProvider.update({ where: { slug: edited.slug }, data: { runtime: 'codex' } });
    assert.equal(await engineOf(unrecorded), AgentProvider.KIMI, 'the protocol it ran on, not the one it was edited to');
    assert.equal(await queue.claimSessionForRunner({ id: at.id, supportedProviders: ALL }), null);
    assert.equal((await row(unrecorded)).error,
      engineIncompatibleMessage(edited.slug, AgentProvider.KIMI, [AgentProvider.CODEX, AgentProvider.OPENCODE]));
    const deleted = await key(owner, { runtime: 'codex' });
    const orphan = await session(at, deleted.slug, { model: 'gpt-6' });
    await providers.remove(owner, deleted.id);
    assert.equal(await engineOf(orphan), AgentProvider.CODEX, 'deleting the key leaves its sessions their engine');
  });

  await t.test('T2 reclaim, lease takeover and activation rebuild a session on its recorded engine', async () => {
    const owner = await account('reclaim');
    const at = await machine(owner);
    const kimiKey = await key(owner, { runtime: 'kimi', presetSlug: 'moonshot', baseUrl: 'https://api.moonshot.ai/v1' });
    const id = await session(at, kimiKey.slug, { engine: AgentProvider.KIMI, status: RunStatus.AWAITING_INPUT, model: 'kimi-k3', runtimeSessionId: 'kimi-thread' });
    const rebuilt = (await api.reclaim(at.runner, undefined, ALL.join(','))).sessions.find((s) => s.sessionId === id);
    assert.equal(rebuilt?.provider, AgentProvider.KIMI);
    assert.equal(rebuilt?.agent.env?.KIMI_MODEL_API_KEY, kimiKey.apiKey);
    const leaseOwner = randomUUID();
    await api.takeoverLeases(at.runner, id, { leaseOwner, expectedLeaseOwner: null } as never, undefined, ALL.join(','));
    assert.equal((await row(id)).inboxLeaseOwner, leaseOwner, 'the takeover declares it reads the engine, and lands');
    const generation = randomUUID();
    await api.activateLeases(at.runner, id, { leaseOwner, leaseGeneration: generation }, ALL.join(','));
    assert.equal((await row(id)).inboxLeaseGeneration, generation);
    // The key's protocol changed under it: reclaim leaves it out rather than rebuild it as Codex.
    await db.modelProvider.update({ where: { slug: kimiKey.slug }, data: { runtime: 'codex' } });
    assert.ok(!(await api.reclaim(at.runner, undefined, ALL.join(','))).sessions.some((s) => s.sessionId === id));
    assert.equal(await engineOf(id), AgentProvider.KIMI);
  });

  await t.test('T2 meta reports the recorded engine', async () => {
    const owner = await account('meta');
    const at = await machine(owner);
    const codexKey = await key(owner, { runtime: 'codex' });
    const id = await session(at, codexKey.slug, { engine: AgentProvider.CODEX, status: RunStatus.AWAITING_INPUT, runtimeSessionId: 'codex-thread' });
    const meta = await api.getSessionMeta(at.runner, id);
    assert.equal(meta.engine, AgentProvider.CODEX);
    assert.equal(meta.provider, AgentProvider.CODEX, 'an older `orbit resume` reads provider: it gets Codex, not Claude');
    await db.modelProvider.delete({ where: { slug: codexKey.slug } });
    assert.equal((await api.getSessionMeta(at.runner, id)).engine, AgentProvider.CODEX);
    const unknown = await session(at, 'gone-key', { status: RunStatus.AWAITING_INPUT, runtimeSessionId: 'who-knows' });
    await assert.rejects(() => api.getSessionMeta(at.runner, unknown), /engine was never recorded/);
  });

  await t.test('T2 new sessions record their engine at creation', async () => {
    const owner = await account('create');
    const at = await machine(owner);
    // A Harness session is created only on a runner that reports the CLI installed.
    await db.runner.update({ where: { id: at.id }, data: {
      engines: [{ engine: 'dsh', installed: true, version: '0.2.0-rc.2', auth: 'unknown', dsh: { versionCompatible: true } }],
    } });
    const builtin = await sessions.create(owner, { prompt: 'hi', workspaceId: at.workspaceId, provider: AgentProvider.CLAUDE });
    assert.equal(await engineOf(builtin.id), AgentProvider.CLAUDE);
    const codexKey = await key(owner, { runtime: 'codex' });
    const onKey = await sessions.create(owner, { prompt: 'hi', workspaceId: at.workspaceId, provider: codexKey.slug });
    assert.equal(await engineOf(onKey.id), AgentProvider.CODEX);
    const harnessRow = await key(owner, { runtime: 'dsh', presetSlug: 'deepseek-harness', baseUrl: 'https://api.deepseek.com/anthropic' });
    const onHarness = await sessions.create(owner, { prompt: 'hi', workspaceId: at.workspaceId, provider: harnessRow.slug, permissionMode: 'default' });
    assert.equal(await engineOf(onHarness.id), AgentProvider.DSH);
    const imported = await sessions.importSession(owner, { claudeSessionId: randomUUID(), workspaceId: at.workspaceId });
    assert.equal(await engineOf(imported.id), AgentProvider.CLAUDE);
  });

  await t.test('T2 resume normalizes effort for the session engine and records a missing engine before a switch', async () => {
    const owner = await account('resume');
    const at = await machine(owner);
    const moonshot = await key(owner, { runtime: 'kimi', presetSlug: 'moonshot', baseUrl: 'https://api.moonshot.ai/v1' });
    // Sessions that ran a turn, so there is a conversation to resume.
    const id = await session(at, moonshot.slug, { engine: AgentProvider.KIMI, status: RunStatus.FAILED, model: 'kimi-k3', runtimeSessionId: 'kimi-thread', numTurns: 1 });
    await sessions.resume(owner, id, { content: 'again', clientTurnId: randomUUID(), effort: 'medium' } as never);
    assert.equal((await row(id)).effort, 'high', "Kimi's levels, not the Claude ones its slug used to be read as");
    assert.equal(await engineOf(id), AgentProvider.KIMI);
    // A Codex session with no recorded engine on a key that has since been disabled: its engine is
    // the row's, so it may move to another Codex key — and is recorded before it does.
    const disabled = await key(owner, { runtime: 'codex', enabled: false });
    const target = await key(owner, { runtime: 'codex' });
    const unrecorded = await session(at, disabled.slug, { status: RunStatus.FAILED, model: 'gpt-6', runtimeSessionId: 'codex-thread', numTurns: 1 });
    await sessions.resume(owner, unrecorded, { content: 'again', clientTurnId: randomUUID(), provider: target.slug } as never);
    const moved = await row(unrecorded);
    assert.equal(moved.provider, target.slug);
    assert.equal(moved.engine, AgentProvider.CODEX);
    // …and a Claude key is refused for it, where the disabled row used to read as Claude.
    const claudeKey = await key(owner);
    const other = await session(at, disabled.slug, { status: RunStatus.FAILED, model: 'gpt-6', runtimeSessionId: 'codex-2', numTurns: 1 });
    await assert.rejects(
      () => sessions.resume(owner, other, { content: 'again', clientTurnId: randomUUID(), provider: claudeKey.slug } as never),
      // PROVIDER_ENGINE_INCOMPATIBLE (T3), which retired the "a codex session cannot switch…" wording.
      /provider "key-[^"]+" cannot run on Codex; it runs on Claude Code, OpenCode/,
    );
    assert.equal((await row(other)).provider, disabled.slug);
  });

  await t.test('T2 the inbox hands a mid-turn steer by the session engine', async () => {
    const owner = await account('inbox-steer');
    const at = await machine(owner);
    const internals = api as unknown as {
      dequeueTurn(sessionId: string, runnerId: string, generation: string | null, acceptsSteer: boolean,
        declared: readonly string[]): Promise<{ kind: string } | null>;
    };
    /** A session running a turn on its current generation, with a steer waiting to go into it. */
    async function running(provider: string, engine: string) {
      const id = await session(at, provider, { engine, status: RunStatus.RUNNING, runtimeSessionId: `rt-${randomUUID()}` });
      const generation = randomUUID();
      const leaseOwner = randomUUID();
      await sql.query(
        'INSERT INTO "inbox_lease_generation" ("generation", "session_id", "lease_owner") VALUES ($1, $2, $3)',
        [generation, id, leaseOwner],
      );
      await raw('UPDATE "session" SET inbox_lease_owner = $2, inbox_lease_generation = $3 WHERE id = $1', [id, leaseOwner, generation], reads);
      await sql.query(
        `INSERT INTO "conversation_turn"(id, session_id, seq, client_turn_id, kind, content, status, delivered_at, lease_deadline_at, lease_generation)
         VALUES ($1, $2, 1, $3, 'message', 'build it', 'IN_FLIGHT', clock_timestamp(), clock_timestamp() + interval '2 minutes', $4)`,
        [randomUUID(), id, `run-${randomUUID()}`, generation],
      );
      await sql.query(
        `INSERT INTO "conversation_turn"(id, session_id, seq, client_turn_id, kind, content, status)
         VALUES ($1, $2, 2, $3, 'steer', 'actually, call it gadget', 'PENDING')`,
        [randomUUID(), id, `steer-${randomUUID()}`],
      );
      return { id, generation };
    }
    // Codex on a key that is gone is still Codex, which takes a steer only from a runner that
    // declares it — not the Claude a missing key used to be read as, which takes every steer.
    const codexKey = await key(owner, { runtime: 'codex' });
    const codex = await running(codexKey.slug, AgentProvider.CODEX);
    await db.modelProvider.delete({ where: { slug: codexKey.slug } });
    assert.equal(await internals.dequeueTurn(codex.id, at.id, codex.generation, true, []), null);
    assert.equal((await internals.dequeueTurn(codex.id, at.id, codex.generation, true, [SESSION_CODEX_STEER_V1]))?.kind, 'steer');
    const claude = await running((await key(owner)).slug, AgentProvider.CLAUDE);
    assert.equal((await internals.dequeueTurn(claude.id, at.id, claude.generation, true, []))?.kind, 'steer');
  });

  await t.test('T2 a provider reload builds the environment for the recorded engine', async () => {
    const owner = await account('reload');
    const at = await machine(owner);
    const internals = api as unknown as {
      reloadProviderEnv(tx: unknown, sessionId: string, content: string | null): Promise<Record<string, string> | undefined>;
    };
    const ds = await deepSeekKey(owner);
    const reload = (id: string) => internals.reloadProviderEnv(db, id, JSON.stringify({ provider: ds.slug }));
    const harness = await session(at, ds.slug, { engine: AgentProvider.DSH, status: RunStatus.RUNNING, model: 'opaque' });
    const harnessEnv = await reload(harness);
    assert.equal(harnessEnv?.ORBIT_DSH_API_KEY, ds.apiKey);
    assert.equal(harnessEnv?.ANTHROPIC_AUTH_TOKEN, undefined);
    const claude = await session(at, ds.slug, { engine: AgentProvider.CLAUDE, status: RunStatus.RUNNING, model: 'deepseek-flash' });
    const claudeEnv = await reload(claude);
    assert.equal(claudeEnv?.ANTHROPIC_AUTH_TOKEN, ds.apiKey);
    assert.equal(claudeEnv?.ORBIT_DSH_API_KEY, undefined);
    // A key whose protocol changed is not rebuilt as the engine the key now picks.
    await db.modelProvider.update({ where: { slug: ds.slug }, data: { runtime: 'codex' } });
    await assert.rejects(() => reload(claude), /cannot run on Claude Code/);
  });

  await t.test('T2 steer and move judge the session engine', async () => {
    const owner = await account('steer-move');
    const at = await machine(owner, []);
    const internals = sessions as unknown as {
      runtimeTakesLegacySteer(tx: unknown, session: unknown): Promise<boolean>;
      readMoveSubject(db: unknown, ownerId: string, id: string): Promise<{ runtime: string | null; verdict: { reason: string | null } }>;
    };
    // A Codex session whose key is disabled: Codex takes a steer only on a runner that declares it,
    // and this one does not. Read as the Claude it used to be, the steer would have gone to Codex.
    const codexKey = await key(owner, { runtime: 'codex', enabled: false });
    const onCodex = await session(at, codexKey.slug, { status: RunStatus.RUNNING });
    assert.equal(await internals.runtimeTakesLegacySteer(db, await row(onCodex)), false);
    await db.runner.update({ where: { id: at.id }, data: { capabilities: [SESSION_CODEX_STEER_V1] } });
    assert.equal(await internals.runtimeTakesLegacySteer(db, await row(onCodex)), true);
    const claudeSession = await session(at, (await key(owner)).slug, { engine: AgentProvider.CLAUDE, status: RunStatus.RUNNING });
    assert.equal(await internals.runtimeTakesLegacySteer(db, await row(claudeSession)), true);
    // A Kimi session on a disabled Moonshot key is still a Kimi session: its move is refused as one.
    const moonshot = await key(owner, { runtime: 'kimi', enabled: false });
    const onKimi = await session(at, moonshot.slug, { status: RunStatus.CANCELLED });
    const subject = await internals.readMoveSubject(db, owner, onKimi);
    assert.equal(subject.runtime, AgentProvider.KIMI);
    assert.equal(subject.verdict.reason, "Moving Kimi sessions isn't supported yet.");
    const unknown = await session(at, 'gone-key', { status: RunStatus.CANCELLED });
    assert.equal((await internals.readMoveSubject(db, owner, unknown)).verdict.reason, MOVE_REFUSAL.ENGINE_UNKNOWN);
    const recorded = await session(at, 'gone-key', { engine: AgentProvider.CLAUDE, status: RunStatus.CANCELLED });
    assert.equal((await internals.readMoveSubject(db, owner, recorded)).verdict.reason, null);
  });
});
