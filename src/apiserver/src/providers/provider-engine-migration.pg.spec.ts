/**
 * The provider/engine split's data migration on a real PostgreSQL (docs/provider-engine-contract.md §7.2–§7.6,
 * migration 0417, provider-engine-migration.ts): every `deepseek-harness` row folds into a DeepSeek key —
 * merged when the same owner's enabled DeepSeek key holds the same key on the same endpoint, converted where
 * it stands otherwise, turned-off rows staying off — and leaves its slug as a retired name for the key on
 * DeepSeek Harness; whatever names it is rewritten; the old OpenCode spelling and the built-in dsh move onto
 * keys; a second run changes nothing; and every session resolves to the same engine, key, endpoint, model
 * and runtime id before and after, which a real claim confirms. Named in
 * scripts/test-provider-engine-migration.mjs; a missing server is a failure, not a skip.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { Prisma, RunStatus, RunnerStatus, TaskStatus, type ModelProvider } from '@prisma/client';
import { AgentProvider, openCodeKeyOf, providerPreset, type ClaimedSession } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { resolveEngineProvider, resolveTaskPin } from './engine-provider';
import { catalogDefaultModel, catalogModels } from './model-catalog';
import { encryptSecret } from './provider-crypto';
import {
  PROVIDER_ENGINE_MIGRATION_LOCK,
  ProviderEngineMigration,
  type MigrationResult,
  type ReportLine,
} from './provider-engine-migration';
import { keyFingerprint, normalizedEndpoint, sessionResolution, type SessionResolution } from './provider-engine-resolution';
import { ProvidersService } from './providers.service';
import { legacySessionEngine } from './session-engine';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY ??= 'provider-engine-migration-spec';
const ALL = [
  AgentProvider.CLAUDE, AgentProvider.CODEX, AgentProvider.KIMI,
  AgentProvider.OPENCODE, AgentProvider.ANTIGRAVITY, AgentProvider.DSH,
];
/** What a runner that has every CLI installed and signed in reports on its heartbeat. */
const ENGINES = [
  { engine: 'claude', installed: true, auth: 'yes' },
  { engine: 'codex', installed: true, auth: 'yes' },
  { engine: 'kimi', installed: true, auth: 'yes' },
  { engine: 'antigravity', installed: true, auth: 'yes' },
  { engine: 'opencode', installed: true, auth: 'yes' },
  { engine: 'dsh', installed: true, version: '0.2.0-rc.2', auth: 'unknown', dsh: { versionCompatible: true } },
];
const DEEPSEEK = 'https://api.deepseek.com/anthropic';
const GLM = 'https://api.z.ai/api/anthropic';
/** What the comparison holds equal (task acceptance: engine, key fingerprint, endpoint, model, runtime id). */
const comparable = (r: SessionResolution) => ({
  engine: r.engine, keyFingerprint: r.keyFingerprint, endpoint: r.endpoint, model: r.model,
  runtimeSessionId: r.runtimeSessionId, dispatchable: r.dispatchable,
});
const CHANGES = new Set(['MERGED', 'CONVERTED', 'ALIASED', 'REWRITTEN', 'SKIPPED_CHANGED']);

test('T4 provider-engine migration on PostgreSQL', { timeout: 900_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(URL!);
  t.after(async () => { await db.$disconnect(); await sql.end(); });

  // The DeepSeek Harness permission policy is P4's, and refuses the account default these fixtures
  // carry; scheduling, keys and PostgreSQL stay real (the seam session-engine-foundation.pg.spec uses).
  const runtimePolicy = require('../common/runtime-provider') as typeof import('../common/runtime-provider');
  const originalPermissionPolicy = runtimePolicy.normalizeBuiltinPermissionMode;
  runtimePolicy.normalizeBuiltinPermissionMode = (...args: Parameters<typeof originalPermissionPolicy>) =>
    args[0] === AgentProvider.DSH ? args[2] : originalPermissionPolicy(...args);
  t.after(() => { runtimePolicy.normalizeBuiltinPermissionMode = originalPermissionPolicy; });

  const drains = {
    drainCancellations: async () => [], drainMergeRequests: async () => [],
    drainCommitRequests: async () => [], drainArtifactRequests: async () => [],
  } as Record<string, unknown>;
  const realtime = new Proxy(drains, {
    get: (target, name: string) => target[name] ?? (() => undefined),
  }) as unknown as RealtimeService;
  const prisma = db as unknown as PrismaService;
  const queue = new QueueService(prisma, realtime);
  const sessions = new SessionsService(prisma, queue, realtime);
  const providers = new ProvidersService(prisma, realtime, { snapshot: () => null } as never);
  const deps = { db, poolRefusal: async () => null };

  /** Everything the migration logs, by line. */
  const logged: string[] = [];
  const log = { log: (m: string) => logged.push(m), warn: (m: string) => logged.push(m), error: (m: string) => logged.push(m) };
  const migration = (lockTimeoutMs?: number) => new ProviderEngineMigration(db, { databaseUrl: URL!, log, lockTimeoutMs });
  /** Every key a fixture holds, so the report and the log can be searched for one. */
  const secrets = new Set<string>();

  // ── Fixtures ──────────────────────────────────────────────────────────────────────────────────
  async function account(label: string, role: 'USER' | 'ADMIN' = 'USER', preferences: Record<string, unknown> = {}) {
    const id = randomUUID();
    await db.user.create({ data: {
      id, email: `${label}-${id}@engine-migration.invalid`, name: label, passwordHash: 'x', role,
      preferences: preferences as Prisma.InputJsonValue,
    } });
    return id;
  }
  type Machine = { id: string; ownerId: string; workspaceId: string };
  async function machine(ownerId: string, workspace: { env?: Record<string, string>; fallbacks?: unknown[] } = {}): Promise<Machine> {
    const id = randomUUID();
    await db.runner.create({ data: {
      id, ownerId, name: 'engine-migration', tokenHash: `x-${id}`, status: RunnerStatus.ONLINE, maxConcurrent: 64,
      capabilities: ['provider:dsh', 'provider:antigravity'], capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(), engines: ENGINES as Prisma.InputJsonValue,
    } });
    return { id, ownerId, workspaceId: await workspaceOn({ id, ownerId }, workspace) };
  }
  async function workspaceOn(at: { id: string; ownerId: string }, opts: { env?: Record<string, string>; fallbacks?: unknown[] } = {}) {
    const workspaceId = randomUUID();
    await db.workspace.create({ data: {
      id: workspaceId, ownerId: at.ownerId, runnerId: at.id, name: 'engine-migration', enabled: true, workDir: '/tmp/engine-migration',
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.fallbacks ? { providerFallbacks: opts.fallbacks as Prisma.InputJsonValue } : {}),
    } });
    return workspaceId;
  }
  type Key = ModelProvider & { apiKey: string };
  async function key(ownerId: string | null, opts: {
    slug?: string; label?: string; runtime?: string; presetSlug?: string | null; baseUrl?: string; apiKey?: string;
    enabled?: boolean; position?: number | null; followsPreset?: boolean;
  } = {}): Promise<Key> {
    const apiKey = opts.apiKey ?? `sk-${randomUUID()}`;
    const slug = opts.slug ?? `key-${randomUUID().slice(0, 12)}`;
    const row = await db.modelProvider.create({ data: {
      slug, label: opts.label ?? slug, runtime: opts.runtime ?? 'claude', presetSlug: opts.presetSlug ?? null,
      baseUrl: opts.baseUrl ?? 'https://api.example.test', apiKeyEnc: encryptSecret(apiKey),
      enabled: opts.enabled ?? true, position: opts.position ?? null, followsPreset: opts.followsPreset ?? false, ownerId,
    } });
    secrets.add(apiKey.trim());
    return { ...row, apiKey };
  }
  /** A DeepSeek key, as the connect page makes one. */
  const deepSeekKey = (ownerId: string | null, opts: Parameters<typeof key>[1] = {}) =>
    key(ownerId, { presetSlug: 'deepseek', baseUrl: DEEPSEEK, label: 'DeepSeek', followsPreset: true, ...opts });
  /** A `deepseek-harness` row, as the retired preset made one before the split. */
  const harnessRow = (ownerId: string | null, opts: Parameters<typeof key>[1] = {}) =>
    key(ownerId, {
      slug: `deepseek-harness-${randomUUID().slice(0, 8)}`, runtime: AgentProvider.DSH, presetSlug: 'deepseek-harness',
      baseUrl: DEEPSEEK, label: 'DeepSeek Harness', followsPreset: true, ...opts,
    });

  /** Every fixture session, with what it is for, and its resolution before and after each run. */
  const fixtures = new Map<string, string>();
  const compared = new Map<string, Array<{ before: SessionResolution; after: SessionResolution }>>();
  async function session(at: Machine, provider: string, opts: {
    label: string; engine: string | null; providerBuiltin?: boolean; model?: string | null; status?: RunStatus;
    completed?: boolean; workspaceId?: string; runtimeSessionId?: string | null; createdAt?: Date;
  }) {
    const id = (await db.session.create({ data: {
      title: opts.label, prompt: '', ownerId: at.ownerId, creatorId: at.ownerId, workspaceId: opts.workspaceId ?? at.workspaceId,
      assignedRunnerId: at.id, provider, providerBuiltin: opts.providerBuiltin ?? false,
      ...(opts.engine !== null ? { engine: opts.engine } : {}),
      status: opts.status ?? RunStatus.PENDING, usesRuntimeDefaultModel: true,
      model: opts.model === undefined ? 'pinned-model' : opts.model,
      runtimeSessionId: opts.runtimeSessionId === undefined ? `runtime-${randomUUID()}` : opts.runtimeSessionId,
      numTurns: 1, startedAt: new Date(),
      ...(opts.completed ? { completedAt: new Date(), finishedAt: new Date() } : {}),
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    } })).id;
    fixtures.set(id, opts.label);
    return id;
  }
  async function task(ownerId: string, pins: { provider: string | null; engine?: string | null; model?: string | null; status?: TaskStatus }) {
    return (await db.task.create({ data: {
      ownerId, title: `pinned to ${pins.provider}`, creatorType: 'USER', creatorId: ownerId,
      completionCriterion: 'EVIDENCE_JUDGMENT', provider: pins.provider,
      ...(pins.engine ? { engine: pins.engine } : {}), model: pins.model ?? null,
      ...(pins.status ? { status: pins.status } : {}),
    } })).id;
  }
  const stored = (id: string) => db.session.findUniqueOrThrow({
    where: { id }, select: { provider: true, providerBuiltin: true, engine: true, model: true },
  });
  const pins = (id: string) => db.task.findUniqueOrThrow({ where: { id }, select: { provider: true, engine: true, model: true } });
  const keyRow = (id: string) => db.modelProvider.findUnique({ where: { id } });
  const alias = (slug: string) => db.providerSlugAlias.findUnique({ where: { slug }, select: { providerId: true, engine: true, reason: true } });
  const preferencesOf = async (id: string) =>
    ((await db.user.findUniqueOrThrow({ where: { id }, select: { preferences: true } })).preferences as { defaultModels?: Record<string, string> }).defaultModels;
  const linesOf = (result: MigrationResult, ownerId: string) => result.lines.filter((line) => line.ownerId === ownerId);
  const DEEPSEEK_MODELS = catalogModels(providerPreset('deepseek')!).map((m) => ({
    value: m.value, label: m.label, ...(m.contextWindow != null ? { contextWindow: m.contextWindow } : {}),
  }));

  /** Every run the spec made, in order: what the report checks read back. */
  const runs: MigrationResult[] = [];
  /**
   * One full scan (§7.6: a run with no completion marker; the marker an earlier scenario's run wrote is
   * taken back first), with every fixture session resolved just before and just after it, each pair held
   * equal on the fields dispatch builds a run from.
   */
  async function migrate(): Promise<MigrationResult> {
    const ids = [...fixtures.keys()];
    const before = new Map<string, SessionResolution>();
    for (const id of ids) before.set(id, await sessionResolution(db, id));
    await db.providerEngineMigrationRun.updateMany({ where: { complete: true }, data: { complete: false } });
    const result = await migration().run();
    runs.push(result);
    for (const id of ids) {
      const after = await sessionResolution(db, id);
      compared.set(id, [...(compared.get(id) ?? []), { before: before.get(id)!, after }]);
      assert.deepEqual(comparable(after), comparable(before.get(id)!), `${fixtures.get(id)}: resolves differently after the migration`);
    }
    assert.equal(result.summary?.failures.length, 0, JSON.stringify(result.summary?.failures));
    assert.equal(result.summary?.leftOver, 0);
    assert.equal(result.summary?.complete, true, 'a full scan with nothing left writes the completion marker');
    assert.equal(result.summary?.resolutions.changed, 0);
    return result;
  }

  /** What a claimed run hands its engine, read off the job alone. */
  function fromJob(job: ClaimedSession) {
    const engine = job.provider ?? null;
    const env = job.agent.env ?? {};
    const model = job.agent.model ?? null;
    let apiKey: string | undefined;
    let endpoint: string | undefined;
    if (engine === AgentProvider.OPENCODE) {
      const named = openCodeKeyOf(model);
      const config = env.OPENCODE_CONFIG_CONTENT ? JSON.parse(env.OPENCODE_CONFIG_CONTENT) : {};
      const options = named ? config.provider?.[`orbit-${named.slug}`]?.options : undefined;
      apiKey = options?.apiKey;
      endpoint = options?.baseURL;
    } else {
      const variables: Record<string, [string, string]> = {
        claude: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'], dsh: ['ORBIT_DSH_API_KEY', 'ORBIT_DSH_BASE_URL'],
        codex: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'], kimi: ['KIMI_MODEL_API_KEY', 'KIMI_MODEL_BASE_URL'],
        antigravity: ['GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL'],
      };
      const [k, e] = variables[engine ?? ''] ?? [];
      apiKey = k ? env[k] : undefined;
      endpoint = e ? env[e] : undefined;
    }
    return {
      engine,
      keyFingerprint: apiKey ? keyFingerprint(apiKey) : null,
      endpoint: endpoint ? normalizedEndpoint(endpoint) : null,
      model: model ? openCodeKeyOf(model)?.model ?? model : null,
      runtimeSessionId: job.runtimeSessionId ?? null,
      dispatchable: true,
    };
  }
  /** Claim everything a runner is offered. */
  async function claimAll(at: Machine): Promise<Map<string, ClaimedSession>> {
    const jobs = new Map<string, ClaimedSession>();
    for (;;) {
      const job = await queue.claimSessionForRunner({ id: at.id, supportedProviders: ALL }, 0, true);
      if (!job) return jobs;
      jobs.set(job.sessionId, job);
    }
  }

  await t.test('T4 a DeepSeek Harness row merges into the same owner\'s enabled DeepSeek key holding the same key on the same endpoint', async () => {
    const owner = await account('merge');
    const at = await machine(owner);
    const apiKey = `sk-${randomUUID()}`;
    const target = await deepSeekKey(owner, { apiKey, position: 1 });
    // The same key, padded, on the same endpoint spelled with an upper-case host and a trailing slash.
    const row = await harnessRow(owner, { apiKey: `  ${apiKey} `, baseUrl: 'https://API.DeepSeek.com/anthropic/', position: 0 });
    const live = await session(at, row.slug, { label: 'merge: a DeepSeek Harness session', engine: AgentProvider.DSH, model: 'opaque-acp-model' });
    const older = await session(at, row.slug, { label: 'merge: an older replica\'s, no engine recorded', engine: null });
    const finished = await session(at, row.slug, { label: 'merge: finished', engine: AgentProvider.DSH, status: RunStatus.SUCCEEDED, completed: true });

    const result = await migrate();
    assert.equal(await keyRow(row.id), null, 'the row is merged away');
    assert.deepEqual(await alias(row.slug), { providerId: target.id, engine: AgentProvider.DSH, reason: 'MERGED' });
    for (const id of [live, older, finished]) {
      assert.deepEqual(await stored(id), {
        provider: target.slug, providerBuiltin: false, engine: AgentProvider.DSH,
        model: id === live ? 'opaque-acp-model' : 'pinned-model',
      });
    }
    const shape = (r: ModelProvider | null) => r && {
      slug: r.slug, label: r.label, runtime: r.runtime, presetSlug: r.presetSlug, baseUrl: r.baseUrl,
      apiKeyEnc: r.apiKeyEnc, enabled: r.enabled, position: r.position, followsPreset: r.followsPreset,
    };
    assert.deepEqual(shape(await keyRow(target.id)), shape(target), 'the key it merged into is untouched');

    const lines = linesOf(result, owner);
    const merged = lines.filter((l) => l.step === 'dsh-row' && l.action === 'MERGED');
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0].after, { mergedInto: target.id, slug: target.slug, sameKey: true });
    assert.equal(lines.filter((l) => l.step === 'dsh-row' && l.action === 'ALIASED').length, 1);
    assert.deepEqual(
      lines.filter((l) => l.step === 'reference' && l.table === 'session').map((l) => [l.rowId, l.action]).sort(),
      [live, older, finished].map((id) => [id, 'REWRITTEN']).sort(),
    );
    assert.deepEqual(
      lines.find((l) => l.step === 'reference' && l.rowId === older)?.after,
      { provider: target.slug, engine: AgentProvider.DSH },
      'an older replica\'s session records DeepSeek Harness, the engine its slug ran on',
    );
  });

  await t.test('T4 a row with another key, on another endpoint, or with either side turned off converts where it stands, and one turned off stays off', async () => {
    const owner = await account('convert');
    const at = await machine(owner);
    const apiKey = `sk-${randomUUID()}`;
    const target = await deepSeekKey(owner, { apiKey });
    const otherKey = await harnessRow(owner, { position: 1 });
    const otherEndpoint = await harnessRow(owner, { apiKey, baseUrl: `${DEEPSEEK}/beta`, position: 2 });
    const turnedOff = await harnessRow(owner, { apiKey, enabled: false, position: 3 });
    const named = await harnessRow(owner, { label: 'Team Harness', position: 4 });
    // The row migration 0377 kept under the bare `dsh` slug.
    const dshNamed = await harnessRow(owner, { slug: AgentProvider.DSH, position: 5 });
    // The other side turned off: the same key on the same endpoint, but the DeepSeek key is off.
    const owner2 = await account('convert-target-off');
    const at2 = await machine(owner2);
    const apiKey2 = `sk-${randomUUID()}`;
    const offTarget = await deepSeekKey(owner2, { apiKey: apiKey2, enabled: false });
    const besideOff = await harnessRow(owner2, { apiKey: apiKey2 });

    const rows = [otherKey, otherEndpoint, turnedOff, named, dshNamed];
    const onRows = new Map<string, string>();
    for (const row of rows) onRows.set(row.id, await session(at, row.slug, { label: `convert: on ${row.slug}`, engine: AgentProvider.DSH }));
    const onDshConfigured = await session(at, AgentProvider.DSH, { label: 'convert: the configured dsh row, by name', engine: AgentProvider.DSH, providerBuiltin: false });
    const dshPin = await task(owner, { provider: AgentProvider.DSH, engine: AgentProvider.DSH });
    const onBesideOff = await session(at2, besideOff.slug, { label: 'convert: beside a turned-off DeepSeek key', engine: AgentProvider.DSH });

    const result = await migrate();
    const expected = new Map([
      [otherKey.id, { label: 'DeepSeek 2', enabled: true, why: 'no enabled DeepSeek key of the same owner holds the same key on the same endpoint' }],
      [otherEndpoint.id, { label: 'DeepSeek 3', enabled: true, why: 'no enabled DeepSeek key of the same owner holds the same key on the same endpoint' }],
      [turnedOff.id, { label: 'DeepSeek 4', enabled: false, why: 'it is turned off, so it is not merged; it stays off' }],
      [named.id, { label: 'Team Harness', enabled: true, why: 'no enabled DeepSeek key of the same owner holds the same key on the same endpoint' }],
      [dshNamed.id, { label: 'DeepSeek 5', enabled: true, why: 'no enabled DeepSeek key of the same owner holds the same key on the same endpoint' }],
      [besideOff.id, { label: 'DeepSeek 2', enabled: true, why: 'no enabled DeepSeek key of the same owner holds the same key on the same endpoint' }],
    ]);
    const slugs = new Set<string>();
    for (const row of [...rows, besideOff]) {
      const now = (await keyRow(row.id))!;
      const want = expected.get(row.id)!;
      assert.deepEqual(
        { presetSlug: now.presetSlug, runtime: now.runtime, followsPreset: now.followsPreset, models: now.models, defaultModel: now.defaultModel },
        { presetSlug: 'deepseek', runtime: AgentProvider.CLAUDE, followsPreset: true, models: DEEPSEEK_MODELS, defaultModel: catalogDefaultModel(providerPreset('deepseek')!) },
        `${row.slug}: a DeepSeek key on Anthropic's protocol, its models the preset's`,
      );
      assert.equal(now.label, want.label);
      assert.equal(now.enabled, want.enabled, 'enabled or not as it was');
      assert.deepEqual(
        { baseUrl: now.baseUrl, apiKeyEnc: now.apiKeyEnc, position: now.position, ownerId: now.ownerId },
        { baseUrl: row.baseUrl, apiKeyEnc: row.apiKeyEnc, position: row.position, ownerId: row.ownerId },
      );
      assert.match(now.slug, /^deepseek(?:-\d+)?$/);
      assert.ok(!slugs.has(now.slug));
      slugs.add(now.slug);
      assert.deepEqual(await alias(row.slug), { providerId: row.id, engine: AgentProvider.DSH, reason: 'RENAMED' });
      const line = result.lines.find((l) => l.step === 'dsh-row' && l.action === 'CONVERTED' && l.rowId === row.id)!;
      assert.equal(line.note, want.why);
      assert.equal((line.after as { slug: string }).slug, now.slug);
      const onRow = row.id === besideOff.id ? onBesideOff : onRows.get(row.id)!;
      assert.deepEqual(await stored(onRow), { provider: now.slug, providerBuiltin: false, engine: AgentProvider.DSH, model: 'pinned-model' });
    }
    assert.deepEqual(await keyRow(target.id).then((r) => r?.slug), target.slug);
    assert.equal((await keyRow(offTarget.id))?.enabled, false, 'the turned-off DeepSeek key stays off, and is not merged into');
    // The configured `dsh` row's session and pin follow it; `dsh` is its retired name now.
    const dshKey = (await keyRow(dshNamed.id))!;
    assert.deepEqual(await stored(onDshConfigured), { provider: dshKey.slug, providerBuiltin: false, engine: AgentProvider.DSH, model: 'pinned-model' });
    assert.deepEqual(await pins(dshPin), { provider: dshKey.slug, engine: AgentProvider.DSH, model: null });
    const resolved = await resolveEngineProvider(deps, { ownerId: owner, provider: AgentProvider.DSH, door: 'session' });
    assert.deepEqual([resolved.engine, resolved.provider], [AgentProvider.DSH, dshKey.slug]);
  });

  await t.test('T4 several DeepSeek Harness rows of one owner each become a key, and the ones holding the same key become one', async () => {
    const owner = await account('several');
    const at = await machine(owner);
    const shared = `sk-${randomUUID()}`;
    const first = await harnessRow(owner, { apiKey: shared, position: 0 });
    const twin = await harnessRow(owner, { apiKey: shared, position: 1 });
    const other = await harnessRow(owner, { position: 2 });
    const off = await harnessRow(owner, { apiKey: shared, enabled: false, position: 3 });
    const on = new Map<string, string>();
    for (const row of [first, twin, other, off]) on.set(row.id, await session(at, row.slug, { label: `several: on ${row.slug}`, engine: AgentProvider.DSH }));

    const result = await migrate();
    const firstNow = (await keyRow(first.id))!;
    const otherNow = (await keyRow(other.id))!;
    const offNow = (await keyRow(off.id))!;
    assert.equal(await keyRow(twin.id), null, 'the second row with the same key merges into the first, now a DeepSeek key');
    assert.deepEqual([firstNow.label, otherNow.label, offNow.label], ['DeepSeek', 'DeepSeek 2', 'DeepSeek 3']);
    assert.deepEqual([firstNow.enabled, otherNow.enabled, offNow.enabled], [true, true, false]);
    assert.deepEqual(await alias(first.slug), { providerId: first.id, engine: AgentProvider.DSH, reason: 'RENAMED' });
    assert.deepEqual(await alias(twin.slug), { providerId: first.id, engine: AgentProvider.DSH, reason: 'MERGED' });
    assert.deepEqual(await alias(other.slug), { providerId: other.id, engine: AgentProvider.DSH, reason: 'RENAMED' });
    assert.deepEqual(await alias(off.slug), { providerId: off.id, engine: AgentProvider.DSH, reason: 'RENAMED' });
    assert.equal((await stored(on.get(first.id)!)).provider, firstNow.slug);
    assert.equal((await stored(on.get(twin.id)!)).provider, firstNow.slug);
    assert.equal((await stored(on.get(other.id)!)).provider, otherNow.slug);
    assert.equal((await stored(on.get(off.id)!)).provider, offNow.slug);
    assert.deepEqual(
      linesOf(result, owner).filter((l) => l.step === 'dsh-row' && l.table === 'model_provider').map((l) => [l.rowId, l.action]),
      [[first.id, 'CONVERTED'], [twin.id, 'MERGED'], [other.id, 'CONVERTED'], [off.id, 'CONVERTED']],
      'folded in the order keys are chosen in',
    );
    assert.equal(await db.modelProvider.count({ where: { ownerId: owner, runtime: AgentProvider.DSH } }), 0);
  });

  await t.test('T4 sessions, task pins, preferences, Wiki maintenance settings and workspace fallbacks naming an old slug name the key after, and nothing open names a retired slug', async () => {
    const apiKey = `sk-${randomUUID()}`;
    const owner = await account('references');
    const target = await deepSeekKey(owner, { apiKey });
    const row = await harnessRow(owner, { apiKey });
    const s = row.slug;
    await db.user.update({ where: { id: owner }, data: { preferences: { theme: 'dark', defaultModels: {
      [s]: 'opaque-acp-model',
      [`claude:${s}`]: 'deepseek-v4-flash',
      [`claude:${target.slug}`]: 'deepseek-v4-pro',
      [`opencode/${s}`]: `orbit-${s}/deepseek-v4-pro`,
      'anthropic-2': 'claude-opus-5-5',
    } } } });
    const at = await machine(owner, { fallbacks: [{ provider: s, model: 'opaque-acp-model' }, { provider: AgentProvider.CLAUDE }] });
    const otherWorkspace = await workspaceOn(at, { fallbacks: [{ provider: AgentProvider.CODEX }] });
    const space = await db.wikiSpace.create({ data: {
      ownerId: owner, slug: `space-${randomUUID().slice(0, 8)}`, title: 'space',
      settings: { push: 'manual', maintenance: { provider: s, listId: null } },
    } });
    const onDsh = await session(at, s, { label: 'references: on DeepSeek Harness', engine: AgentProvider.DSH });
    const onClaude = await session(at, s, { label: 'references: Claude Code on the row', engine: AgentProvider.CLAUDE, model: 'deepseek-v4-flash' });
    const onOpenCode = await session(at, s, { label: 'references: OpenCode on the row', engine: AgentProvider.OPENCODE, model: 'deepseek-v4-pro' });
    const spelled = await session(at, AgentProvider.OPENCODE, {
      label: 'references: the old OpenCode spelling of the row', engine: AgentProvider.OPENCODE, providerBuiltin: true, model: `orbit-${s}/deepseek-v4-pro`,
    });
    const pinned = await task(owner, { provider: s, engine: AgentProvider.DSH });
    const pinnedOlder = await task(owner, { provider: s });
    const pinnedClaude = await task(owner, { provider: s, engine: AgentProvider.CLAUDE, model: 'deepseek-v4-flash' });
    const pinnedClosed = await task(owner, { provider: s, engine: AgentProvider.DSH, status: TaskStatus.CANCELLED });
    const pinnedSpelled = await task(owner, { provider: AgentProvider.OPENCODE, model: `orbit-${s}/deepseek-v4-pro` });
    // History reads through the retired name: a route decision is left as written.
    const decision = await db.taskRouteDecision.create({ data: {
      ownerId: owner, taskId: pinned, requestToken: randomUUID(), applied: false, policyVersion: 1, provider: s,
      baseline: { provider: s }, features: {}, reasons: [],
    } });

    const result = await migrate();
    const t1 = target.slug;
    assert.deepEqual(await stored(onDsh), { provider: t1, providerBuiltin: false, engine: AgentProvider.DSH, model: 'pinned-model' });
    assert.deepEqual(await stored(onClaude), { provider: t1, providerBuiltin: false, engine: AgentProvider.CLAUDE, model: 'deepseek-v4-flash' });
    assert.deepEqual(await stored(onOpenCode), { provider: t1, providerBuiltin: false, engine: AgentProvider.OPENCODE, model: 'deepseek-v4-pro' });
    assert.deepEqual(await stored(spelled), { provider: t1, providerBuiltin: false, engine: AgentProvider.OPENCODE, model: 'deepseek-v4-pro' });
    assert.deepEqual(await pins(pinned), { provider: t1, engine: AgentProvider.DSH, model: null });
    assert.deepEqual(await pins(pinnedOlder), { provider: t1, engine: AgentProvider.DSH, model: null }, 'the engine pin is written with the provider pin');
    assert.deepEqual(await pins(pinnedClaude), { provider: t1, engine: AgentProvider.CLAUDE, model: 'deepseek-v4-flash' });
    assert.deepEqual(await pins(pinnedClosed), { provider: t1, engine: AgentProvider.DSH, model: null });
    assert.deepEqual(await pins(pinnedSpelled), { provider: t1, engine: AgentProvider.OPENCODE, model: 'deepseek-v4-pro' });
    assert.deepEqual(await preferencesOf(owner), {
      [`dsh:${t1}`]: 'opaque-acp-model',
      [`claude:${t1}`]: 'deepseek-v4-pro',
      [`opencode:${t1}`]: 'deepseek-v4-pro',
      'anthropic-2': 'claude-opus-5-5',
    });
    assert.equal(((await db.user.findUniqueOrThrow({ where: { id: owner } })).preferences as { theme: string }).theme, 'dark');
    assert.deepEqual((await db.workspace.findUniqueOrThrow({ where: { id: at.workspaceId } })).providerFallbacks,
      [{ provider: t1, model: 'opaque-acp-model' }, { provider: AgentProvider.CLAUDE }]);
    assert.deepEqual((await db.workspace.findUniqueOrThrow({ where: { id: otherWorkspace } })).providerFallbacks, [{ provider: AgentProvider.CODEX }]);
    assert.deepEqual((await db.wikiSpace.findUniqueOrThrow({ where: { id: space.id } })).settings,
      { push: 'manual', maintenance: { provider: t1, listId: null } });
    assert.equal((await db.taskRouteDecision.findUniqueOrThrow({ where: { id: decision.id } })).provider, s, 'history is left as written');

    const lines = linesOf(result, owner);
    const conflict = lines.find((l) => l.step === 'reference' && l.table === 'user' && l.rowId === `${owner}:claude:${s}`)!;
    assert.equal(conflict.note, `conflict: "claude:${t1}" already held a model, which is kept`);
    assert.ok(lines.some((l) => l.table === 'wiki_space' && l.action === 'REWRITTEN' && l.rowId === space.id && /flagged/.test(l.note ?? '')));
    assert.ok(lines.some((l) => l.table === 'workspace' && l.action === 'REWRITTEN' && l.rowId === at.workspaceId));
    for (const id of [pinned, pinnedOlder, pinnedClaude, pinnedClosed, pinnedSpelled]) {
      assert.ok(lines.some((l) => l.table === 'task' && l.rowId === id && l.action === 'REWRITTEN'), `task ${id} reported`);
    }
    assert.equal(result.summary?.aliasReferences, 0, 'nothing open names a retired slug');
    assert.deepEqual(result.lines.filter((l) => l.step === 'alias-reference').map((l) => l.action), ['NOOP']);
  });

  await t.test('T4 a retired slug resolves to its key on DeepSeek Harness at every door that takes a provider', async () => {
    const owner = await account('retired');
    const at = await machine(owner);
    const apiKey = `sk-${randomUUID()}`;
    const target = await deepSeekKey(owner, { apiKey, position: 0 });
    const merged = await harnessRow(owner, { apiKey, position: 1 });
    const renamed = await harnessRow(owner, { position: 2 });
    await migrate();
    const renamedNow = (await keyRow(renamed.id))!;
    for (const [old, key] of [[merged.slug, target], [renamed.slug, renamedNow]] as const) {
      // A provider alone: the key, on the engine the old slug ran on.
      const alone = await resolveEngineProvider(deps, { ownerId: owner, provider: old, door: 'session' });
      assert.deepEqual([alone.engine, alone.provider, alone.providerBuiltin], [AgentProvider.DSH, key.slug, false]);
      // An engine named beside it wins over the alias's own.
      const onClaude = await resolveEngineProvider(deps, { ownerId: owner, provider: old, engine: AgentProvider.CLAUDE, door: 'session' });
      assert.deepEqual([onClaude.engine, onClaude.provider], [AgentProvider.CLAUDE, key.slug]);
      assert.deepEqual(await resolveTaskPin(deps, owner, { provider: old }, null), { engine: AgentProvider.DSH, provider: key.slug });
    }
    // A new session named by the old slug is stored on the key and runs on DeepSeek Harness with it.
    const created = await sessions.create(owner, { workspaceId: at.workspaceId, prompt: 'hi', permissionMode: 'default', provider: merged.slug } as never);
    const createdRow = await stored(created.id);
    assert.deepEqual([createdRow.provider, createdRow.providerBuiltin, createdRow.engine], [target.slug, false, AgentProvider.DSH]);
    const job = (await claimAll(at)).get(created.id)!;
    assert.equal(job.provider, AgentProvider.DSH);
    assert.equal(job.agent.env?.ORBIT_DSH_API_KEY, apiKey);
    assert.equal(job.agent.env?.ORBIT_DSH_BASE_URL, DEEPSEEK);
    // An older replica's session written on the old slug derives DeepSeek Harness and spends the key.
    const straggler = await session(at, merged.slug, { label: 'retired: an older replica\'s, on the old slug', engine: null });
    assert.equal(await legacySessionEngine(db, { ownerId: owner, provider: merged.slug, providerBuiltin: false }), AgentProvider.DSH);
    const resolution = await sessionResolution(db, straggler);
    assert.deepEqual([resolution.engine, resolution.keyFingerprint], [AgentProvider.DSH, keyFingerprint(apiKey)]);
    // The next run lists it, the one open reference to a retired name, and folds nothing.
    const listed = await migrate();
    assert.deepEqual(
      listed.lines.filter((l) => l.step === 'alias-reference').map((l) => [l.table, l.rowId, l.action]),
      [['session', straggler, 'UNRESOLVED']],
    );
    assert.equal(listed.summary?.aliasReferences, 1);
    await db.session.update({ where: { id: straggler }, data: { completedAt: new Date(), status: RunStatus.SUCCEEDED } });
    // The name is held in the one slug namespace, and nothing lists it.
    await assert.rejects(key(owner, { slug: merged.slug }), (e: { code?: string }) => e.code === 'P2002');
    const listedKeys = (await providers.listUsable(owner)).map((p) => p.slug);
    assert.ok(!listedKeys.includes(merged.slug) && !listedKeys.includes(renamed.slug) && listedKeys.includes(target.slug));
  });

  await t.test('T4 the old OpenCode spelling becomes the key on OpenCode in sessions, task pins and preferences', async () => {
    const owner = await account('opencode');
    const at = await machine(owner);
    const glm = await key(owner, { presetSlug: 'glm', baseUrl: GLM, label: 'GLM' });
    const apiKey = `sk-${randomUUID()}`;
    const target = await deepSeekKey(owner, { apiKey });
    const row = await harnessRow(owner, { apiKey });
    const subscription = await key(owner, { presetSlug: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: `sk-ant-oat01-${randomUUID()}` });
    await db.user.update({ where: { id: owner }, data: { preferences: { defaultModels: {
      [`opencode/${glm.slug}`]: `orbit-${glm.slug}/glm-5`,
      opencode: `orbit-${target.slug}/deepseek-v4-flash`,
      'opencode/gone-key': 'orbit-gone-key/whatever',
    } } } });
    const onGlm = await session(at, AgentProvider.OPENCODE, { label: 'opencode: a GLM key', engine: AgentProvider.OPENCODE, providerBuiltin: true, model: `orbit-${glm.slug}/glm-5` });
    const onRow = await session(at, AgentProvider.OPENCODE, { label: 'opencode: a DeepSeek Harness row', engine: AgentProvider.OPENCODE, providerBuiltin: true, model: `orbit-${row.slug}/deepseek-v4-pro` });
    const gone = await session(at, AgentProvider.OPENCODE, { label: 'opencode: a key that is gone', engine: AgentProvider.OPENCODE, providerBuiltin: true, model: 'orbit-gone-key/whatever' });
    const token = await session(at, AgentProvider.OPENCODE, { label: 'opencode: a subscription token', engine: AgentProvider.OPENCODE, providerBuiltin: true, model: `orbit-${subscription.slug}/claude-opus-5-5` });
    const own = await session(at, AgentProvider.OPENCODE, { label: 'opencode: OpenCode\'s own configuration', engine: AgentProvider.OPENCODE, providerBuiltin: true, model: 'anthropic/claude-sonnet-5-5' });
    const pinned = await task(owner, { provider: AgentProvider.OPENCODE, engine: AgentProvider.OPENCODE, model: `orbit-${glm.slug}/glm-5` });
    const pinnedOlder = await task(owner, { provider: AgentProvider.OPENCODE, model: `orbit-${glm.slug}/glm-4.7` });
    const pinnedGone = await task(owner, { provider: AgentProvider.OPENCODE, engine: AgentProvider.OPENCODE, model: 'orbit-gone-key/whatever' });

    const result = await migrate();
    assert.deepEqual(await stored(onGlm), { provider: glm.slug, providerBuiltin: false, engine: AgentProvider.OPENCODE, model: 'glm-5' });
    assert.deepEqual(await stored(onRow), { provider: target.slug, providerBuiltin: false, engine: AgentProvider.OPENCODE, model: 'deepseek-v4-pro' });
    for (const id of [gone, token]) assert.equal((await stored(id)).provider, AgentProvider.OPENCODE, 'left as it was');
    assert.deepEqual(await stored(own), { provider: AgentProvider.OPENCODE, providerBuiltin: true, engine: AgentProvider.OPENCODE, model: 'anthropic/claude-sonnet-5-5' });
    assert.deepEqual(await pins(pinned), { provider: glm.slug, engine: AgentProvider.OPENCODE, model: 'glm-5' });
    assert.deepEqual(await pins(pinnedOlder), { provider: glm.slug, engine: AgentProvider.OPENCODE, model: 'glm-4.7' });
    assert.deepEqual(await pins(pinnedGone), { provider: AgentProvider.OPENCODE, engine: AgentProvider.OPENCODE, model: 'orbit-gone-key/whatever' });
    assert.deepEqual(await preferencesOf(owner), {
      [`opencode:${glm.slug}`]: 'glm-5',
      [`opencode:${target.slug}`]: 'deepseek-v4-flash',
      'opencode/gone-key': 'orbit-gone-key/whatever',
    });
    const unresolved = linesOf(result, owner).filter((l) => l.action === 'UNRESOLVED').map((l) => [l.table, l.rowId, l.note]);
    assert.deepEqual(unresolved.sort(), [
      ['session', gone, 'no key of this account is called "gone-key"'],
      ['session', token, `"${subscription.slug}" is a key OpenCode cannot run`],
      ['task', pinnedGone, 'no key of this account is called "gone-key"'],
      ['user', `${owner}:opencode/gone-key`, 'no key of this account is called "gone-key"'],
    ].sort());
    // Dispatch reads the new shape: the key in OpenCode's config, under its own slug.
    const job = (await claimAll(at)).get(onGlm)!;
    assert.equal(job.provider, AgentProvider.OPENCODE);
    assert.equal(job.agent.model, `orbit-${glm.slug}/glm-5`);
    assert.equal(JSON.parse(job.agent.env!.OPENCODE_CONFIG_CONTENT).provider[`orbit-${glm.slug}`].options.apiKey, glm.apiKey);
  });

  await t.test('T4 built-in dsh sessions move to the first enabled DeepSeek key, keep a workspace key, and are listed without one', async () => {
    const owner = await account('builtin-dsh');
    const at = await machine(owner);
    const envKey = `sk-env-${randomUUID()}`;
    secrets.add(envKey);
    const withKey = await workspaceOn(at, { env: { ORBIT_DSH_API_KEY: envKey } });
    await deepSeekKey(owner, { enabled: false, position: 0 });
    const first = await deepSeekKey(owner, { position: 1 });
    await deepSeekKey(owner, { position: 2 });
    const onDefault = await session(at, AgentProvider.DSH, { label: 'builtin dsh: no workspace key', engine: AgentProvider.DSH, providerBuiltin: true });
    const finished = await session(at, AgentProvider.DSH, { label: 'builtin dsh: finished, no workspace key', engine: AgentProvider.DSH, providerBuiltin: true, status: RunStatus.SUCCEEDED, completed: true });
    const onEnv = await session(at, AgentProvider.DSH, { label: 'builtin dsh: its workspace key', engine: AgentProvider.DSH, providerBuiltin: true, workspaceId: withKey });
    const pin = await task(owner, { provider: AgentProvider.DSH, engine: AgentProvider.DSH });
    const keyless = await account('builtin-dsh-keyless');
    const keylessAt = await machine(keyless);
    const onNothing = await session(keylessAt, AgentProvider.DSH, { label: 'builtin dsh: no DeepSeek key at all', engine: AgentProvider.DSH, providerBuiltin: true });

    const result = await migrate();
    for (const id of [onDefault, finished]) {
      assert.deepEqual(await stored(id), { provider: first.slug, providerBuiltin: false, engine: AgentProvider.DSH, model: 'pinned-model' });
    }
    assert.deepEqual(await stored(onEnv), { provider: AgentProvider.DSH, providerBuiltin: true, engine: AgentProvider.DSH, model: 'pinned-model' });
    assert.deepEqual(await stored(onNothing), { provider: AgentProvider.DSH, providerBuiltin: true, engine: AgentProvider.DSH, model: 'pinned-model' });
    assert.deepEqual(await pins(pin), { provider: AgentProvider.DSH, engine: AgentProvider.DSH, model: null }, 'a task pin naming the built-in dsh is resolved at dispatch');
    assert.deepEqual(
      [...linesOf(result, owner), ...linesOf(result, keyless)].filter((l) => l.step === 'legacy-dsh').map((l) => [l.rowId, l.action]).sort(),
      [[onDefault, 'REWRITTEN'], [finished, 'REWRITTEN'], [onEnv, 'LEGACY_DSH_ENV_KEY'], [onNothing, 'LEGACY_DSH_NO_KEY']].sort(),
    );
    const jobs = await claimAll(at);
    assert.equal(jobs.get(onDefault)?.agent.env?.ORBIT_DSH_API_KEY, first.apiKey);
    assert.equal(jobs.get(onEnv)?.agent.env?.ORBIT_DSH_API_KEY, envKey, 'the workspace\'s own key, as it always ran on');
  });

  await t.test('T4 the backfill\'s leftovers are listed, and account pools and managed runners are left as they are', async () => {
    const owner = await account('untouched');
    const at = await machine(owner);
    // Nothing answers its slug and it never said which engine it ran: unresolved, before and after.
    const lost = await session(at, 'gone-key-untouched', { label: 'untouched: a key that is gone, no engine', engine: null, runtimeSessionId: null });
    const lostPin = await task(owner, { provider: 'gone-key-untouched' });
    // Made before 0414 ran; its init event said Claude Code where its key's row now says Codex.
    const codexKey = await key(owner, { runtime: AgentProvider.CODEX, baseUrl: 'https://api.openai.com/v1' });
    const preSplit = await session(at, codexKey.slug, { label: 'untouched: recorded from its init event', engine: AgentProvider.CLAUDE, createdAt: new Date('2026-01-01T00:00:00Z'), model: 'claude-sonnet-5-5' });
    // An account pool and its member, and a managed runner: none of them is a DeepSeek Harness row.
    const subscription = await key(owner, { presetSlug: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: `sk-ant-oat01-${randomUUID()}` });
    const pool = await db.providerPool.create({ data: { slug: `pool-${randomUUID().slice(0, 8)}`, label: 'pool', ownerId: owner, engine: 'claude' } });
    await db.providerPoolMember.create({ data: { poolId: pool.id, providerId: subscription.id, ownerId: owner } });
    // A DeepSeek Harness row someone put in a pool by hand: it keeps its place, so it is never merged.
    const apiKey = `sk-${randomUUID()}`;
    await deepSeekKey(owner, { apiKey });
    const pooledRow = await harnessRow(owner, { apiKey });
    await db.providerPoolMember.create({ data: { poolId: pool.id, providerId: pooledRow.id, ownerId: owner } });
    const runner = await db.managedRunner.create({ data: {
      ownerId: owner, runnerId: at.id, defaultWorkspaceId: at.workspaceId, clusterKey: 'spec', namespace: 'spec',
      pvcName: `mr-data-${at.id}`, initialProvider: AgentProvider.CLAUDE,
    } });

    const result = await migrate();
    const lines = linesOf(result, owner);
    assert.ok(result.lines.some((l) => l.step === 'backfill' && l.table === 'session' && l.rowId === lost && l.action === 'UNRESOLVED'));
    assert.ok(result.lines.some((l) => l.step === 'backfill' && l.table === 'task' && l.rowId === lostPin && l.action === 'UNRESOLVED'));
    const inconsistent = result.lines.find((l) => l.step === 'backfill' && l.rowId === preSplit)!;
    assert.deepEqual([inconsistent.action, inconsistent.before, inconsistent.after],
      ['INCONSISTENT', { provider: codexKey.slug, keyRuntime: AgentProvider.CODEX }, { engine: AgentProvider.CLAUDE }]);
    assert.ok(result.lines.some((l) => l.step === 'check' && l.table === 'provider_pool_member' && l.rowId === `${pool.id}:${pooledRow.id}` && l.action === 'UNRESOLVED'));
    assert.ok(result.lines.some((l) => l.step === 'check' && l.table === 'managed_runner' && l.action === 'NOOP'));
    const pooledNow = (await keyRow(pooledRow.id))!;
    assert.equal(pooledNow.runtime, AgentProvider.CLAUDE, 'converted where it stands');
    assert.equal(lines.find((l) => l.rowId === pooledRow.id && l.action === 'CONVERTED')?.note,
      'it is a member of an account pool, which a merge would take it out of');
    assert.equal(await db.providerPoolMember.count({ where: { poolId: pool.id } }), 2, 'the pool keeps both members');
    assert.deepEqual(await db.managedRunner.findUniqueOrThrow({ where: { id: runner.id }, select: { initialProvider: true } }), { initialProvider: AgentProvider.CLAUDE });
    assert.equal((await keyRow(subscription.id))?.slug, subscription.slug);
    assert.deepEqual(await stored(lost), { provider: 'gone-key-untouched', providerBuiltin: false, engine: null, model: 'pinned-model' });
  });

  await t.test('T4 every fixture session resolves to the same engine, key, endpoint, model and runtime id before and after, and dispatch agrees', async () => {
    /** One owner holding every shape of session the migration touches, and a control of each it does not. */
    async function everyShape(label: string) {
      const owner = await account(label);
      const at = await machine(owner);
      const envKey = `sk-env-${randomUUID()}`;
      secrets.add(envKey);
      const withKey = await workspaceOn(at, { env: { ORBIT_DSH_API_KEY: envKey } });
      const apiKey = `sk-${randomUUID()}`;
      const target = await deepSeekKey(owner, { apiKey, position: 0 });
      const merged = await harnessRow(owner, { apiKey: ` ${apiKey}`, baseUrl: `${DEEPSEEK}/`, position: 1 });
      const converted = await harnessRow(owner, { position: 2 });
      const glm = await key(owner, { presetSlug: 'glm', baseUrl: GLM, label: 'GLM' });
      const ids = [
        await session(at, merged.slug, { label: `${label}: DeepSeek Harness on a row that merges`, engine: AgentProvider.DSH, model: 'opaque-a' }),
        await session(at, merged.slug, { label: `${label}: no engine on a row that merges`, engine: null, model: 'opaque-b' }),
        await session(at, merged.slug, { label: `${label}: Claude Code on a row that merges`, engine: AgentProvider.CLAUDE, model: 'deepseek-v4-flash' }),
        await session(at, merged.slug, { label: `${label}: OpenCode on a row that merges`, engine: AgentProvider.OPENCODE, model: 'deepseek-v4-pro' }),
        await session(at, converted.slug, { label: `${label}: DeepSeek Harness on a row that converts`, engine: AgentProvider.DSH, model: 'opaque-c' }),
        await session(at, AgentProvider.OPENCODE, { label: `${label}: the old OpenCode spelling of a key`, engine: AgentProvider.OPENCODE, providerBuiltin: true, model: `orbit-${glm.slug}/glm-5` }),
        await session(at, AgentProvider.OPENCODE, { label: `${label}: the old OpenCode spelling of a row that merges`, engine: AgentProvider.OPENCODE, providerBuiltin: true, model: `orbit-${merged.slug}/deepseek-v4-pro` }),
        await session(at, AgentProvider.DSH, { label: `${label}: the built-in dsh, on the default key`, engine: AgentProvider.DSH, providerBuiltin: true, model: 'opaque-d' }),
        await session(at, AgentProvider.DSH, { label: `${label}: the built-in dsh, on its workspace key`, engine: AgentProvider.DSH, providerBuiltin: true, model: 'opaque-e', workspaceId: withKey }),
        await session(at, target.slug, { label: `${label}: Claude Code on the DeepSeek key (control)`, engine: AgentProvider.CLAUDE, model: 'deepseek-v4-pro' }),
        await session(at, AgentProvider.CODEX, { label: `${label}: the Codex sign-in (control)`, engine: AgentProvider.CODEX, providerBuiltin: true, model: 'gpt-5.5' }),
      ];
      return { owner, at, ids };
    }
    const twin = await everyShape('dispatch-before');
    const world = await everyShape('dispatch-after');
    // Before the migration, a real claim of each twin session hands its engine what its resolution says.
    const twinBefore = new Map<string, SessionResolution>();
    for (const id of twin.ids) twinBefore.set(id, await sessionResolution(db, id));
    const twinJobs = await claimAll(twin.at);
    assert.deepEqual([...twinJobs.keys()].sort(), [...twin.ids].sort(), 'every twin session is dispatched before the migration');
    for (const id of twin.ids) assert.deepEqual(fromJob(twinJobs.get(id)!), comparable(twinBefore.get(id)!), `${fixtures.get(id)}: the claim before the migration`);

    const result = await migrate();
    for (const id of world.ids) {
      const line = result.lines.find((l) => l.step === 'resolution' && l.rowId === id);
      if (line) assert.equal(line.action, 'SAME', `${fixtures.get(id)}: reported the same`);
    }
    // After it, a real claim of each session hands its engine what it resolved to before.
    const jobs = await claimAll(world.at);
    assert.deepEqual([...jobs.keys()].sort(), [...world.ids].sort(), 'every session is dispatched after the migration');
    for (const id of world.ids) {
      const [{ before }] = compared.get(id)!;
      assert.deepEqual(fromJob(jobs.get(id)!), comparable(before), `${fixtures.get(id)}: the claim after the migration`);
    }
    // And every fixture session so far: compared on every run, never different.
    for (const id of fixtures.keys()) {
      assert.ok(compared.get(id)?.length, `${fixtures.get(id)}: never compared`);
      for (const { before, after } of compared.get(id)!) assert.deepEqual(comparable(after), comparable(before), String(fixtures.get(id)));
    }
    assert.ok(fixtures.size >= 50, `only ${fixtures.size} fixture sessions`);
  });

  /** The rows the migration writes, without timestamps: what a second run must leave exactly as it is. */
  const state = async () => ({
    keys: await db.modelProvider.findMany({ orderBy: { id: 'asc' }, select: {
      id: true, slug: true, label: true, runtime: true, presetSlug: true, baseUrl: true, apiKeyEnc: true, enabled: true,
      position: true, followsPreset: true, models: true, defaultModel: true, ownerId: true,
    } }),
    aliases: await db.providerSlugAlias.findMany({ orderBy: { slug: 'asc' }, select: { slug: true, providerId: true, engine: true, reason: true } }),
    sessions: await db.session.findMany({ orderBy: { id: 'asc' }, select: { id: true, provider: true, providerBuiltin: true, engine: true, model: true, runtimeSessionId: true } }),
    tasks: await db.task.findMany({ orderBy: { id: 'asc' }, select: { id: true, provider: true, engine: true, model: true } }),
    users: await db.user.findMany({ orderBy: { id: 'asc' }, select: { id: true, preferences: true } }),
    workspaces: await db.workspace.findMany({ orderBy: { id: 'asc' }, select: { id: true, providerFallbacks: true } }),
    wiki: await db.wikiSpace.findMany({ orderBy: { id: 'asc' }, select: { id: true, settings: true } }),
  });

  await t.test('T4 running it again changes nothing, and a start after the marker folds only the rows an older replica made', async () => {
    const before = await state();
    // A start that finds the marker and no deepseek-harness row does nothing at all.
    const marked = await migration().run();
    assert.deepEqual([marked.runId, marked.lines.length, marked.summary], [null, 0, null]);
    // A full scan again, with no marker: nothing but NOOPs and the rows it keeps listing.
    const again = await migrate();
    assert.deepEqual(again.lines.filter((l) => CHANGES.has(l.action)), [], 'a second run changes nothing');
    assert.deepEqual(await state(), before, 'and leaves every row as it was');
    assert.equal(again.summary?.resolutions.changed, 0);

    // An older replica, after the marker: a new deepseek-harness row, a session on it with no engine, and an
    // old OpenCode spelling, which only a full scan rewrites.
    const owner = await account('older-replica');
    const at = await machine(owner);
    const glm = await key(owner, { presetSlug: 'glm', baseUrl: GLM });
    const row = await harnessRow(owner);
    const onRow = await session(at, row.slug, { label: 'older replica: on a row made after the marker', engine: null });
    const spelled = await session(at, AgentProvider.OPENCODE, { label: 'older replica: an old OpenCode spelling after the marker', engine: AgentProvider.OPENCODE, providerBuiltin: true, model: `orbit-${glm.slug}/glm-5` });
    const beforeFold = new Map([[onRow, await sessionResolution(db, onRow)], [spelled, await sessionResolution(db, spelled)]]);
    const fold = await migration().run();
    runs.push(fold);
    assert.equal(fold.fullScan, false);
    assert.equal(fold.summary?.complete, false, 'the marker is the full scan\'s');
    const rowNow = (await keyRow(row.id))!;
    assert.equal(rowNow.runtime, AgentProvider.CLAUDE);
    assert.deepEqual(await stored(onRow), { provider: rowNow.slug, providerBuiltin: false, engine: AgentProvider.DSH, model: 'pinned-model' });
    assert.equal((await stored(spelled)).provider, AgentProvider.OPENCODE, 'not a full scan: the spelling is read as it is');
    for (const [id, was] of beforeFold) {
      const after = await sessionResolution(db, id);
      compared.set(id, [...(compared.get(id) ?? []), { before: was, after }]);
      assert.deepEqual(comparable(after), comparable(was), String(fixtures.get(id)));
    }
    const runRows = await db.providerEngineMigrationRun.findMany({ where: { complete: true }, select: { id: true } });
    assert.deepEqual(runRows.map((r) => r.id), [again.runId], 'one completion marker');
  });

  await t.test('T4 two replicas starting together: one migrates, the other waits for it and finds nothing left', async () => {
    const owner = await account('replicas');
    const at = await machine(owner);
    const row = await harnessRow(owner);
    const onRow = await session(at, row.slug, { label: 'replicas: on a row two starts race for', engine: AgentProvider.DSH });
    const was = await sessionResolution(db, onRow);
    // Hold the lock, start two runs, and let go once both wait for it.
    const holder = new Client({ connectionString: URL });
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [PROVIDER_ENGINE_MIGRATION_LOCK]);
      const first = migration().run();
      const second = migration().run();
      for (let i = 0; ; i++) {
        const { rows } = await sql.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`);
        if (rows[0].n >= 2) break;
        assert.ok(i < 200, 'both runs wait for the lock');
        await sleep(50);
      }
      // A third that gives up waiting fails (the boot hook logs that and starts anyway).
      await assert.rejects(migration(200).run(), /lock timeout/);
      await holder.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [PROVIDER_ENGINE_MIGRATION_LOCK]);
      const results = await Promise.all([first, second]);
      runs.push(...results.filter((r) => r.runId));
      const folded = results.flatMap((r) => r.lines).filter((l) => l.step === 'dsh-row' && l.rowId === row.id);
      assert.deepEqual(folded.map((l) => l.action), ['CONVERTED'], 'one run folded the row, once');
      assert.equal(results.filter((r) => r.runId === null).length, 1, 'the other found nothing left to do');
    } finally {
      await holder.end();
    }
    assert.equal(await db.providerSlugAlias.count({ where: { providerId: row.id } }), 1);
    const after = await sessionResolution(db, onRow);
    compared.set(onRow, [{ before: was, after }]);
    assert.deepEqual(comparable(after), comparable(was));
  });

  await t.test('T4 a row whose key cannot be read is left as it is, and the run stays incomplete until a start can read it', async () => {
    const owner = await account('unreadable');
    const at = await machine(owner);
    const apiKey = `sk-${randomUUID()}`;
    const target = await deepSeekKey(owner, { apiKey });
    const row = await harnessRow(owner, { apiKey });
    // Its key under another secret: what a missing or rotated PROVIDER_SECRET_KEY leaves the server with.
    const secret = process.env.PROVIDER_SECRET_KEY;
    process.env.PROVIDER_SECRET_KEY = 'a-secret-this-server-does-not-hold';
    const foreign = encryptSecret(apiKey);
    process.env.PROVIDER_SECRET_KEY = secret;
    await db.modelProvider.update({ where: { id: row.id }, data: { apiKeyEnc: foreign } });
    const onRow = await session(at, row.slug, { label: 'unreadable: on a row whose key cannot be read', engine: AgentProvider.DSH });
    await db.providerEngineMigrationRun.updateMany({ where: { complete: true }, data: { complete: false } });
    const was = await sessionResolution(db, onRow);
    const result = await migration().run();
    runs.push(result);
    assert.deepEqual([result.summary?.complete, result.summary?.legacyRowsLeft], [false, 1], 'no completion marker while a row is left');
    const line = linesOf(result, owner).find((l) => l.rowId === row.id)!;
    assert.equal(line.action, 'UNRESOLVED');
    assert.match(line.note ?? '', /cannot be decrypted/);
    const kept = (await keyRow(row.id))!;
    assert.deepEqual([kept.runtime, kept.slug, kept.presetSlug], [AgentProvider.DSH, row.slug, 'deepseek-harness'], 'neither merged nor converted');
    assert.equal(await alias(row.slug), null);
    assert.equal((await stored(onRow)).provider, row.slug);
    const now = await sessionResolution(db, onRow);
    compared.set(onRow, [{ before: was, after: now }]);
    assert.deepEqual(comparable(now), comparable(was));
    // A start that can read it — its key entered again — folds it.
    await db.modelProvider.update({ where: { id: row.id }, data: { apiKeyEnc: encryptSecret(apiKey) } });
    await migrate();
    assert.equal(await keyRow(row.id), null);
    assert.deepEqual(await alias(row.slug), { providerId: target.id, engine: AgentProvider.DSH, reason: 'MERGED' });
    assert.equal((await stored(onRow)).provider, target.slug);
  });

  await t.test('T4 a rehearsal reports what a run would do and writes nothing', async () => {
    const owner = await account('rehearsal');
    const at = await machine(owner);
    const row = await harnessRow(owner);
    const onRow = await session(at, row.slug, { label: 'rehearsal: on a row a rehearsal folds', engine: AgentProvider.DSH });
    await db.providerEngineMigrationRun.updateMany({ where: { complete: true }, data: { complete: false } });
    const before = await state();
    const runsBefore = await db.providerEngineMigrationRun.count();
    const rehearsal = await migration().rehearse();
    assert.equal(rehearsal.rehearsal, true);
    assert.ok(linesOf(rehearsal, owner).some((l) => l.rowId === row.id && l.action === 'CONVERTED'));
    assert.ok(linesOf(rehearsal, owner).some((l) => l.rowId === onRow && l.action === 'REWRITTEN'));
    assert.ok(linesOf(rehearsal, owner).some((l) => l.rowId === onRow && l.action === 'SAME'));
    assert.deepEqual(await state(), before, 'nothing written');
    assert.equal(await db.providerEngineMigrationRun.count(), runsBefore);
    assert.equal(await db.providerEngineMigrationReport.count({ where: { runId: rehearsal.runId! } }), 0);
    // The run it rehearsed does what the rehearsal said.
    const real = await migrate();
    assert.deepEqual(
      linesOf(real, owner).filter((l) => l.step !== 'resolution').map((l) => [l.step, l.table, l.rowId, l.action]),
      linesOf(rehearsal, owner).filter((l) => l.step !== 'resolution').map((l) => [l.step, l.table, l.rowId, l.action]),
    );
  });

  await t.test('T4 the report lists every row it touched, in its table and in the log, and holds no key material', async () => {
    assert.ok(runs.length >= 10);
    for (const run of runs) {
      const rows = await db.providerEngineMigrationReport.findMany({ where: { runId: run.runId! }, orderBy: { id: 'asc' } });
      assert.equal(rows.length, run.lines.length, `run ${run.runId}: every line is in the table`);
      const asLine = (r: (typeof rows)[number]): ReportLine => ({
        step: r.step as ReportLine['step'], table: r.tableName, rowId: r.rowId, ownerId: r.ownerId, action: r.action as ReportLine['action'],
        ...(r.before === null ? {} : { before: r.before }), ...(r.after === null ? {} : { after: r.after }), ...(r.note === null ? {} : { note: r.note }),
      });
      const key = (l: ReportLine) => JSON.stringify([l.step, l.table, l.rowId, l.action, l.note ?? null]);
      assert.deepEqual(rows.map(asLine).map(key).sort(), run.lines.map(key).sort());
      for (const line of run.lines) {
        assert.ok(logged.includes(`provider-engine-migration ${run.runId} ${JSON.stringify(line)}`), `run ${run.runId}: logged ${key(line)}`);
      }
      const stored = await db.providerEngineMigrationRun.findUniqueOrThrow({ where: { id: run.runId! } });
      assert.ok(stored.finishedAt);
      assert.deepEqual(stored.summary, JSON.parse(JSON.stringify(run.summary)));
    }
    const { rows: [{ text }] } = await sql.query(
      `SELECT string_agg(coalesce("before"::text, '') || coalesce("after"::text, '') || coalesce("note", ''), ' ') AS text FROM "provider_engine_migration_report"`,
    );
    const everything = `${text}\n${logged.join('\n')}`;
    for (const secret of secrets) assert.ok(!everything.includes(secret), 'no key in the report or the log');
    for (const { apiKeyEnc } of await db.modelProvider.findMany({ select: { apiKeyEnc: true } })) {
      assert.ok(!everything.includes(apiKeyEnc), 'no ciphertext either');
    }
    assert.ok(!/apiKeyEnc|api_key_enc/.test(everything));
  });
});
