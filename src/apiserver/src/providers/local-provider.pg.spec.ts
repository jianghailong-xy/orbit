/**
 * A runner-scoped provider — a local Ollama — on real PostgreSQL, through the production ProvidersService,
 * QueueService and RunnerApiController (docs/ollama-local-provider-contract.md). Each claim is paired with
 * the ordinary provider beside it, which must still behave exactly as before.
 *
 *  (1) Create: a local Ollama needs no API key and must be bound to a runner the caller owns; another owner's
 *      runner is refused as if it did not exist, and nothing is written. Every other provider still refuses a
 *      missing or empty key, and still stores its key encrypted.
 *  (2) The database holds the same rules for any writer: no key exactly when authMode is none, which goes with
 *      runner scope, which only a personal row may have.
 *  (3) Reads: no response carries a key; the picker and the dispatch list carry no endpoint; a runner is named
 *      only to its owner, and only while it is still theirs; another account sees none of it; a runner too old
 *      to probe reads as capability UNKNOWN.
 *  (4) Update: another owner cannot touch it; it takes no key; it is rebound only to the owner's own runner.
 *  (5) Fail closed: a session on it is claimed by its own runner with an in-memory placeholder token, and by
 *      no other runner; disabled, deleted, or with its runner removed, it is claimed by none — never onto the
 *      runner's own Claude sign-in — and a restarted runner's reclaim rebuilds it nowhere else either.
 *  (6) Migration 0646 rolls back and forward with every existing provider row unchanged; its rollback refuses
 *      while a runner-scoped row exists; a row an older replica writes in between comes back as account/bearer.
 *
 * It only adds rows under ids of its own, and refuses to run anywhere but the disposable server
 * `coordinator-pg-test-safety` identifies.
 */

import 'reflect-metadata';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';
import { AgentProvider, LOCAL_AUTH_PLACEHOLDER, OLLAMA_PROBE_CAPABILITY, type ClaimedSession } from '@orbit/shared';
import { Client } from 'pg';

import { sha256 } from '../common/crypto.util';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { ProviderPlanUsageService } from './plan-usage.service';
import { ProvidersService } from './providers.service';
import '../test-support/dequeue-under-lease';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY ??= 'local-provider-spec';

const UNIT = '0646_model_provider_runner_scope';
const MIGRATIONS = path.resolve(__dirname, '../../prisma/migrations');
const FORWARD = readFileSync(path.join(MIGRATIONS, UNIT, 'migration.sql'), 'utf8');
const BACKWARD = readFileSync(path.join(MIGRATIONS, UNIT, 'down.sql'), 'utf8');

const OLLAMA_URL = 'http://127.0.0.1:11434';
const MODEL = { value: 'qwen3.8:27b', label: 'Qwen 3.8 27B', contextWindow: 65536 };

const realtime = new Proxy(
  {},
  { get: (_target, key) => (key === 'then' ? undefined : () => undefined) },
) as RealtimeService;

/** Nothing here calls out; a probe of the endpoint from this side would get nothing. */
const outbound: string[] = [];
const offline = (async (input: unknown) => {
  outbound.push(String(input));
  return new Response('offline', { status: 503 });
}) as typeof fetch;
const realFetch = globalThis.fetch;

const suite = URL ? test : test.skip;

/** The refusal's code, `404` for a not-found, or `accepted`. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    if (e instanceof NotFoundException) return '404';
    if (e instanceof BadRequestException) {
      const body = e.getResponse() as { code?: string; message?: unknown };
      return body.code ?? String(body.message);
    }
    throw e;
  }
  return 'accepted';
}

suite('a runner-scoped local provider, on real PostgreSQL', { timeout: 600_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  const db: PrismaClient = prismaClientFor(URL!);
  globalThis.fetch = offline;
  t.after(async () => {
    globalThis.fetch = realFetch;
    await db.$disconnect();
    await client.end();
  });

  const prisma = db as unknown as PrismaService;
  const usage = new ProviderPlanUsageService(realtime);
  const queue = new QueueService(prisma, realtime, usage);
  const providers = new ProvidersService(prisma, realtime, usage);
  const runnerApi = new RunnerApiController(
    db as never, queue as never, realtime as never, {} as never, { issue: async () => 'orchestration-credential' } as never, {} as never,
  );

  async function person(label: string): Promise<string> {
    const id = randomUUID();
    await db.user.create({ data: { id, email: `${label}-${id}@local-provider.invalid`, name: label, passwordHash: 'x', role: 'MEMBER' } });
    return id;
  }

  interface Machine { runnerId: string; workspaceId: string }
  async function machine(ownerId: string, label: string, capabilities: string[] | null = [OLLAMA_PROBE_CAPABILITY]): Promise<Machine> {
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    await db.runner.create({
      data: {
        id: runnerId, ownerId, name: `${label}-runner`, tokenHash: sha256(`local-provider-runner-${runnerId}`),
        status: RunnerStatus.ONLINE, maxConcurrent: 8, lastHeartbeatAt: new Date(),
        ...(capabilities ? { capabilities, capabilitiesReportedAt: new Date() } : {}),
      },
    });
    await db.workspace.create({
      data: { id: workspaceId, ownerId, runnerId, name: `${label}-agent`, enabled: true, workDir: `/tmp/${label}` },
    });
    return { runnerId, workspaceId };
  }

  async function sessionOn(ownerId: string, at: Machine, provider: string, status: RunStatus = RunStatus.PENDING): Promise<string> {
    const started = status !== RunStatus.PENDING;
    const session = await db.session.create({
      data: {
        title: 'local provider', prompt: 'hello', status, ownerId, creatorId: ownerId,
        workspaceId: at.workspaceId, assignedRunnerId: at.runnerId, provider, providerBuiltin: false,
        engine: AgentProvider.CLAUDE, model: MODEL.value, permissionMode: 'default', usesRuntimeDefaultModel: true,
        ...(started ? { numTurns: 1, runtimeSessionId: randomUUID(), startedAt: new Date() } : {}),
      },
      select: { id: true },
    });
    return session.id;
  }
  const claimOn = (at: Machine): Promise<ClaimedSession | null> =>
    queue.claimSessionForRunner({ id: at.runnerId, supportedProviders: [AgentProvider.CLAUDE, AgentProvider.CODEX] });
  const statusOf = async (id: string) => (await db.session.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

  const owner = await person('owner');
  const stranger = await person('stranger');
  const home = await machine(owner, 'home');
  const laptop = await machine(owner, 'laptop');
  const theirs = await machine(stranger, 'theirs');

  const created = (await providers.create(owner, {
    label: 'Ollama', presetSlug: 'ollama', baseUrl: OLLAMA_URL, runnerId: home.runnerId,
    models: [MODEL], defaultModel: MODEL.value,
  })) as { id: string; slug: string };
  const slug = created.slug;

  await t.test('(1) a local Ollama needs no key, and only the caller\'s own runner; every other provider still needs its key', async () => {
    const row = await db.modelProvider.findUniqueOrThrow({ where: { id: created.id } });
    assert.equal(row.apiKeyEnc, '');
    assert.equal(row.scope, 'runner');
    assert.equal(row.authMode, 'none');
    assert.equal(row.runnerId, home.runnerId);
    assert.equal(row.ownerId, owner);
    assert.equal(row.followsPreset, false);

    const before = await db.modelProvider.count();
    assert.equal(await outcome(() => providers.create(owner, {
      label: 'Ollama', presetSlug: 'ollama', baseUrl: OLLAMA_URL, runnerId: theirs.runnerId,
    })), '404', 'bound to another owner\'s runner');
    assert.equal(await outcome(() => providers.create(owner, { label: 'Ollama', presetSlug: 'ollama', baseUrl: OLLAMA_URL })), 'PROVIDER_RUNNER_REQUIRED');
    assert.equal(await outcome(() => providers.create(null, {
      label: 'Ollama', presetSlug: 'ollama', baseUrl: OLLAMA_URL, runnerId: home.runnerId,
    })), 'PROVIDER_RUNNER_SHARED', 'a shared (admin) row bound to a runner');
    for (const apiKey of [undefined, '']) {
      assert.equal(await outcome(() => providers.create(owner, { label: 'DeepSeek', presetSlug: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', apiKey })), 'PROVIDER_API_KEY_REQUIRED');
      assert.equal(await outcome(() => providers.create(owner, { label: 'Mine', baseUrl: 'https://llm.example.com', apiKey })), 'PROVIDER_API_KEY_REQUIRED');
      assert.equal(await outcome(() => providers.create(null, { label: 'Shared', baseUrl: 'https://llm.example.com', apiKey })), 'PROVIDER_API_KEY_REQUIRED');
    }
    assert.equal(await outcome(() => providers.create(owner, {
      label: 'Sneaky', baseUrl: 'https://llm.example.com', authMode: 'none',
    })), 'PROVIDER_SCOPE_AUTH_MISMATCH', 'authMode none on an ordinary endpoint');
    assert.equal(await db.modelProvider.count(), before, 'a refused create wrote a row');

    const keyed = (await providers.create(owner, { label: 'DeepSeek', presetSlug: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-local-spec-keyed' })) as { id: string; hasApiKey: boolean; scope: string };
    assert.equal(keyed.hasApiKey, true);
    assert.equal(keyed.scope, 'account');
    const stored = await db.modelProvider.findUniqueOrThrow({ where: { id: keyed.id } });
    assert.notEqual(stored.apiKeyEnc, '');
    assert.ok(!stored.apiKeyEnc.includes('sk-local-spec-keyed'), 'the key was stored in the clear');
    assert.equal(stored.scope, 'account');
    assert.equal(stored.authMode, 'bearer');
    assert.equal(stored.runnerId, null);
  });

  await t.test('(2) the database holds the same rules for a writer that skips the service', async () => {
    const insert = (over: string) => client.query(`
      INSERT INTO "model_provider" ("id", "slug", "label", "runtime", "base_url", "api_key_enc", "models", "owner_id",
        "scope", "auth_mode", "runner_id", "updated_at")
      SELECT gen_random_uuid(), 'local-spec-' || gen_random_uuid(), 'x', 'claude', '${OLLAMA_URL}', v.key, '[]'::jsonb, v.owner,
        v.scope, v.auth, v.runner, now()
      FROM (SELECT ${over}) v`);
    const violates = async (over: string, constraint: string) => {
      await assert.rejects(insert(over), (e: { constraint?: string }) => e.constraint === constraint, over);
    };
    const me = `'${owner}'::uuid AS owner`;
    const runner = `'${home.runnerId}'::uuid AS runner`;
    await violates(`'enc' AS key, ${me}, 'runner' AS scope, 'none' AS auth, ${runner}`, 'model_provider_auth_key_chk');
    await violates(`'' AS key, ${me}, 'account' AS scope, 'bearer' AS auth, NULL::uuid AS runner`, 'model_provider_auth_key_chk');
    await violates(`'' AS key, ${me}, 'account' AS scope, 'none' AS auth, NULL::uuid AS runner`, 'model_provider_scope_auth_chk');
    await violates(`'' AS key, NULL::uuid AS owner, 'runner' AS scope, 'none' AS auth, ${runner}`, 'model_provider_runner_scope_chk');
    await violates(`'enc' AS key, ${me}, 'account' AS scope, 'bearer' AS auth, ${runner}`, 'model_provider_runner_scope_chk');
    await violates(`'enc' AS key, ${me}, 'account' AS scope, 'token' AS auth, NULL::uuid AS runner`, 'model_provider_auth_mode_chk');
  });

  await t.test('(3) reads carry no key, no endpoint where they never did, and no runner but the owner\'s own', async () => {
    const mine = (await providers.listMine(owner)).find((p) => p.id === created.id)!;
    assert.equal(mine.hasApiKey, false);
    assert.equal(mine.runnerId, home.runnerId);
    assert.equal(mine.local?.state, 'UNKNOWN', 'never probed is unknown, not healthy');
    assert.equal(mine.local?.capability, 'SUPPORTED');

    const picker = (await providers.listPublic(owner)).find((p) => p.slug === slug)!;
    assert.equal(picker.runnerId, home.runnerId);
    assert.deepEqual(picker.engines, [AgentProvider.CLAUDE]);
    const usable = (await providers.listUsable(owner)).find((p) => p.slug === slug)!;
    assert.deepEqual({ scope: usable.scope, runnerId: usable.runnerId }, { scope: 'runner', runnerId: home.runnerId });
    // The ordinary entries read exactly as they did: no scope keys on them.
    assert.ok((await providers.listUsable(owner)).filter((p) => p.slug !== slug && !p.builtin).every((p) => !('scope' in p)));

    for (const [door, payload] of [['listPublic', picker], ['listUsable', usable]] as const) {
      const text = JSON.stringify(payload);
      for (const secret of ['127.0.0.1', '11434', 'baseUrl', 'apiKeyEnc', 'probeMessage']) {
        assert.ok(!text.includes(secret), `${door} carries ${secret}`);
      }
    }
    for (const payload of [await providers.listMine(owner), await providers.listPublic(owner), await providers.listUsable(owner)]) {
      const text = JSON.stringify(payload);
      assert.ok(!text.includes('apiKeyEnc') && !text.includes('sk-local-spec-keyed'), 'a read carries a key');
    }

    // Another account sees none of it, and nothing of the owner's runner.
    for (const payload of [await providers.listMine(stranger), await providers.listPublic(stranger), await providers.listUsable(stranger)]) {
      const text = JSON.stringify(payload);
      assert.ok(!text.includes(created.id) && !text.includes(slug) && !text.includes(home.runnerId));
    }

    // A runner that leaves the owner's account is no longer named, and reads as NO_RUNNER.
    await db.runner.update({ where: { id: home.runnerId }, data: { ownerId: stranger } });
    try {
      const moved = (await providers.listMine(owner)).find((p) => p.id === created.id)!;
      assert.equal(moved.runnerId, null);
      assert.equal(moved.local?.state, 'NO_RUNNER');
      assert.ok(!JSON.stringify(await providers.listPublic(owner)).includes(home.runnerId));
    } finally {
      await db.runner.update({ where: { id: home.runnerId }, data: { ownerId: owner } });
    }

    // A runner too old to report capabilities: unknown, whatever a stale probe said.
    await db.modelProvider.update({ where: { id: created.id }, data: { probeState: 'READY', probedAt: new Date(), probeVersion: '0.40.16' } });
    await db.runner.update({ where: { id: home.runnerId }, data: { capabilities: [], capabilitiesReportedAt: null } });
    try {
      const old = (await providers.listMine(owner)).find((p) => p.id === created.id)!;
      assert.deepEqual([old.local?.capability, old.local?.state], ['UNKNOWN', 'UNKNOWN']);
    } finally {
      await db.runner.update({ where: { id: home.runnerId }, data: { capabilities: [OLLAMA_PROBE_CAPABILITY], capabilitiesReportedAt: new Date() } });
    }
    const probed = (await providers.listMine(owner)).find((p) => p.id === created.id)!;
    assert.equal(probed.local?.state, 'READY');
    assert.equal(probed.local?.version, '0.40.16');
    assert.equal(await outcome(() => providers.revealKey(owner, created.id)), '404', 'a keyless row reveals a key');
    assert.ok(!outbound.some((u) => u.includes('127.0.0.1') || u.includes('11434')), 'the control plane reached out to the local endpoint');
  });

  await t.test('(4) another owner cannot edit it; it takes no key; it is rebound only to the owner\'s own runner', async () => {
    assert.equal(await outcome(() => providers.update(stranger, created.id, { label: 'mine now' })), '404');
    assert.equal(await outcome(() => providers.remove(stranger, created.id)), '404');
    assert.equal(await outcome(() => providers.update(owner, created.id, { apiKey: 'sk-pasted' })), 'PROVIDER_API_KEY_UNUSED');
    assert.equal(await outcome(() => providers.update(owner, created.id, { runnerId: theirs.runnerId })), '404');
    const row = await db.modelProvider.findUniqueOrThrow({ where: { id: created.id } });
    assert.deepEqual([row.apiKeyEnc, row.runnerId, row.label], ['', home.runnerId, 'Ollama']);

    const rebound = await providers.update(owner, created.id, { runnerId: laptop.runnerId });
    assert.equal(rebound.runnerId, laptop.runnerId);
    assert.equal(rebound.local?.state, 'UNKNOWN', 'the old runner\'s probe outlived the move');
    await providers.update(owner, created.id, { runnerId: home.runnerId });
  });

  await t.test('(5) it runs on its own runner and nowhere else; disabled, deleted or runner-less it runs nowhere', async () => {
    const onHome = await sessionOn(owner, home, slug);
    const claimed = await claimOn(home);
    assert.equal(claimed?.sessionId, onHome);
    assert.equal(claimed?.agent.provider, AgentProvider.CLAUDE);
    assert.equal(claimed?.agent.env?.ANTHROPIC_BASE_URL, OLLAMA_URL);
    assert.equal(claimed?.agent.env?.ANTHROPIC_AUTH_TOKEN, LOCAL_AUTH_PLACEHOLDER);
    // The placeholder lives in that answer alone: no row holds it.
    const persisted = await client.query(`SELECT 1 FROM "model_provider" WHERE "id" = $1 AND "api_key_enc" <> ''`, [created.id]);
    assert.equal(persisted.rowCount, 0);

    // Assigned to another of the owner's runners: that runner is never handed it.
    const onLaptop = await sessionOn(owner, laptop, slug);
    assert.equal(await claimOn(laptop), null);
    assert.equal(await statusOf(onLaptop), RunStatus.PENDING);
    // …and a restarted laptop runner does not rebuild one there either.
    const idleOnLaptop = await sessionOn(owner, laptop, slug, RunStatus.AWAITING_INPUT);
    const reclaimed = (await runnerApi.reclaim({ id: laptop.runnerId, ownerId: owner })).sessions;
    assert.equal(reclaimed.find((s) => s.sessionId === idleOnLaptop), undefined);
    // The stranger naming the slug from their own runner gets nothing.
    const forged = await sessionOn(stranger, theirs, slug);
    assert.equal(await claimOn(theirs), null);
    assert.equal(await statusOf(forged), RunStatus.PENDING);

    // Disabled: claimed by nobody, its own runner included.
    await providers.update(owner, created.id, { enabled: false });
    const whileDisabled = await sessionOn(owner, home, slug);
    assert.equal(await claimOn(home), null);
    assert.equal(await statusOf(whileDisabled), RunStatus.PENDING);
    await providers.update(owner, created.id, { enabled: true });
    assert.equal((await claimOn(home))?.sessionId, whileDisabled);

    // Its runner removed: the row stays, unbound, and is claimed by nobody.
    const doomed = await machine(owner, 'doomed');
    await providers.update(owner, created.id, { runnerId: doomed.runnerId });
    await db.workspace.deleteMany({ where: { runnerId: doomed.runnerId } });
    await db.runner.delete({ where: { id: doomed.runnerId } });
    const orphan = await db.modelProvider.findUniqueOrThrow({ where: { id: created.id } });
    assert.deepEqual([orphan.scope, orphan.runnerId], ['runner', null]);
    assert.equal((await providers.listMine(owner)).find((p) => p.id === created.id)?.local?.state, 'NO_RUNNER');
    const whileUnbound = await sessionOn(owner, home, slug);
    assert.equal(await claimOn(home), null);
    assert.equal(await claimOn(laptop), null);
    assert.equal(await statusOf(whileUnbound), RunStatus.PENDING);
    await providers.update(owner, created.id, { runnerId: home.runnerId });
    assert.equal((await claimOn(home))?.sessionId, whileUnbound);

    // Deleted: sessions naming it wait; none becomes a Claude session on the runner's own sign-in.
    await providers.remove(owner, created.id);
    const afterDelete = await sessionOn(owner, home, slug);
    assert.equal(await claimOn(home), null);
    const left = await db.session.findUniqueOrThrow({ where: { id: afterDelete }, select: { status: true, provider: true, providerBuiltin: true } });
    assert.deepEqual(left, { status: RunStatus.PENDING, provider: slug, providerBuiltin: false });
  });

  await t.test('(6) 0646 rolls back and forward with every existing provider row unchanged', async () => {
    // A runner-scoped row of its own, which the rollback must refuse to strand.
    const local = (await providers.create(owner, {
      label: 'Ollama', presetSlug: 'ollama', baseUrl: OLLAMA_URL, runnerId: home.runnerId, models: [MODEL],
    })) as { id: string };
    const BEFORE_COLUMNS = `"id", "slug", "label", "runtime", "base_url", "api_key_enc", "models", "default_model",
      "preset_slug", "follows_preset", "enabled", "position", "owner_id", "created_at", "updated_at",
      "key_check_state", "key_checked_at", "spent_until"`;
    const snapshot = async () =>
      (await client.query(`SELECT ${BEFORE_COLUMNS} FROM "model_provider" WHERE "scope" = 'account' ORDER BY "id"`)).rows;
    const columns = async () =>
      (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'model_provider'
        AND column_name IN ('scope', 'runner_id', 'auth_mode', 'probe_state', 'probe_version', 'probe_message', 'probed_at', 'instance_models')
        ORDER BY 1`)).rows.map((r) => r.column_name as string);

    await client.query('BEGIN');
    try {
      await assert.rejects(client.query(BACKWARD), /runner-scoped model_provider rows exist/);
      await client.query('ROLLBACK');
      await client.query('BEGIN');

      const legacy = await snapshot();
      assert.ok(legacy.length >= 2, 'the snapshot holds the providers made above and the guard rows');
      await client.query(`DELETE FROM "model_provider" WHERE "id" = $1`, [local.id]);
      await client.query(BACKWARD);
      assert.deepEqual(await columns(), [], 'down.sql left a 0646 column behind');
      assert.deepEqual(
        (await client.query(`SELECT ${BEFORE_COLUMNS} FROM "model_provider" ORDER BY "id"`)).rows,
        legacy,
        'rolling back changed an existing provider row',
      );
      await client.query(BACKWARD); // re-runnable

      // An older replica writes a provider the way it always has, while the schema is back where it was.
      const oldWrite = randomUUID();
      await client.query(`
        INSERT INTO "model_provider" ("id", "slug", "label", "runtime", "base_url", "api_key_enc", "models", "owner_id", "updated_at")
        VALUES ($1, $2, 'Old replica', 'claude', 'https://api.deepseek.com/anthropic', 'iv:tag:ct', '[]'::jsonb, $3, now())`,
      [oldWrite, `old-replica-${oldWrite}`, owner]);

      await client.query(FORWARD);
      await client.query(FORWARD); // re-runnable
      assert.equal((await columns()).length, 8);
      const after = (await client.query(`SELECT ${BEFORE_COLUMNS} FROM "model_provider" WHERE "id" <> $1 ORDER BY "id"`, [oldWrite])).rows;
      assert.deepEqual(after, legacy, 'rolling forward changed an existing provider row');
      const defaults = await client.query(
        `SELECT DISTINCT "scope", "auth_mode", "runner_id", "probe_state", "instance_models" FROM "model_provider"`,
      );
      assert.deepEqual(defaults.rows, [{ scope: 'account', auth_mode: 'bearer', runner_id: null, probe_state: null, instance_models: null }]);
    } finally {
      await client.query('ROLLBACK');
    }
    // The transaction took everything with it: the schema, and the row made above, are as they were.
    assert.equal((await columns()).length, 8);
    assert.equal((await db.modelProvider.findUniqueOrThrow({ where: { id: local.id } })).scope, 'runner');
  });
});
