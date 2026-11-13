/**
 * The runner's probe of its local model servers, on real PostgreSQL (docs/ollama-local-provider-contract.md §6):
 *
 *  (1) Targets: a runner is handed the enabled runner-scoped providers bound to it, its owner's own, with the models
 *      each names (no cloud model); never another runner's, another account's, or an account-scoped key.
 *  (2) Reports land only where they belong: on the reporting runner's own row, still at the endpoint it probed. Two
 *      runners report different catalogues for providers of the same owner, and neither lands on the other's row —
 *      not even when a runner names the other's provider id.
 *  (3) What is kept is sanitized: an unknown state, a bad id or a bad endpoint is dropped; the catalogue keeps
 *      well-formed names and bounded fields only (no cloud model, nothing the server said beyond them); a report with
 *      no catalogue keeps the stored one; a future checkedAt is clamped to now.
 *  (4) Reads tell UNKNOWN, an unavailable state, READY and STALE apart, with version and latency.
 *  (5) The HTTPS heartbeat route writes them and answers with the targets; the link's one-statement report writer
 *      (writeLinkBeatReports) writes them the same way.
 *  (6) Migration 0647 rolls back and forward.
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

import { PrismaClient, RunnerStatus } from '@prisma/client';
import { LOCAL_PROBE_STALE_MS, OLLAMA_PROBE_CAPABILITY, type LocalProviderProbe, type RunnerHeartbeatRequest } from '@orbit/shared';
import { Client } from 'pg';

import { sha256 } from '../common/crypto.util';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { linkBeatDigests, writeLinkBeatReports } from '../runner-api/link-heartbeat';
import { localProviderTargets, storeLocalProviderProbes } from './local-provider-probe';
import { ProviderPlanUsageService } from './plan-usage.service';
import { ProvidersService } from './providers.service';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY ??= 'local-provider-probe-spec';

const UNIT = '0647_model_provider_probe_latency';
const MIGRATIONS = path.resolve(__dirname, '../../prisma/migrations');
const FORWARD = readFileSync(path.join(MIGRATIONS, UNIT, 'migration.sql'), 'utf8');
const BACKWARD = readFileSync(path.join(MIGRATIONS, UNIT, 'down.sql'), 'utf8');

const marked: string[] = [];
const realtime = new Proxy(
  {},
  {
    get: (_target, key) =>
      key === 'then' ? undefined : key === 'markRunnerChanged' ? (id: string) => marked.push(id) : () => undefined,
  },
) as RealtimeService;

const suite = URL ? test : test.skip;
const PRIVATE = 'PRIVATE-BODY SYSTEM PROMPT sk-live-secret';

suite('the runner\'s probe of its local model servers, on real PostgreSQL', { timeout: 600_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  const db: PrismaClient = prismaClientFor(URL!);
  t.after(async () => {
    await db.$disconnect();
    await client.end();
  });
  const prisma = db as unknown as PrismaService;
  const usage = new ProviderPlanUsageService(realtime);
  const providers = new ProvidersService(prisma, realtime, usage);
  const api = new RunnerApiController(
    prisma, new QueueService(prisma, realtime, usage), realtime, { notifyEngineSignedOut: async () => undefined } as never,
    {} as never, {} as never,
  );

  async function person(label: string): Promise<string> {
    const id = randomUUID();
    await db.user.create({ data: { id, email: `${label}-${id}@local-probe.invalid`, name: label, passwordHash: 'x', role: 'MEMBER' } });
    return id;
  }
  async function runnerOf(ownerId: string, label: string): Promise<string> {
    const id = randomUUID();
    await db.runner.create({
      data: {
        id, ownerId, name: `${label}-runner`, tokenHash: sha256(`local-probe-runner-${id}`), status: RunnerStatus.ONLINE,
        maxConcurrent: 4, lastHeartbeatAt: new Date(), capabilities: [OLLAMA_PROBE_CAPABILITY], capabilitiesReportedAt: new Date(),
      },
    });
    return id;
  }
  const local = async (ownerId: string, runnerId: string, baseUrl: string, model: string) =>
    (await providers.create(ownerId, {
      label: 'Ollama', presetSlug: 'ollama', baseUrl, runnerId,
      models: [{ value: model, label: model }, { value: 'extra:7b', label: 'extra' }], defaultModel: model,
    })) as { id: string };
  const row = (id: string) => db.modelProvider.findUniqueOrThrow({ where: { id } });
  const now = () => new Date().toISOString();
  const probe = (over: Partial<LocalProviderProbe> & { providerId: string; baseUrl: string }): LocalProviderProbe => ({
    state: 'READY', version: '0.40.16', checkedAt: now(), latencyMs: 4,
    models: [{ value: 'qwen3.8:27b', contextWindow: 131072, tools: true, parameterSize: '27.3B', quantization: 'Q4_K_M' }],
    ...over,
  });
  const read = async (ownerId: string, id: string) =>
    ((await providers.listMine(ownerId)) as Array<{ id: string; local?: Record<string, unknown> }>).find((p) => p.id === id)!.local!;

  const owner = await person('owner');
  const stranger = await person('stranger');
  const home = await runnerOf(owner, 'home');
  const laptop = await runnerOf(owner, 'laptop');
  const theirs = await runnerOf(stranger, 'theirs');
  marked.length = 0;
  const onHome = await local(owner, home, 'http://127.0.0.1:11434', 'qwen3.8:27b');
  const onLaptop = await local(owner, laptop, 'http://[::1]:11434/', 'llama3:latest');
  const onTheirs = await local(stranger, theirs, 'http://127.0.0.1:11434', 'qwen3.8:27b');
  const keyed = (await providers.create(owner, { label: 'DeepSeek', presetSlug: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-x' })) as { id: string };

  await t.test('(1) a runner is handed its own local providers and nothing else; a write marks its runner', async () => {
    assert.deepEqual(marked.sort(), [home, laptop, theirs].sort(), 'each create marks the runner it binds');
    assert.deepEqual(await localProviderTargets(prisma, home), [
      { providerId: onHome.id, baseUrl: 'http://127.0.0.1:11434', models: ['qwen3.8:27b', 'extra:7b'] },
    ]);
    assert.deepEqual((await localProviderTargets(prisma, laptop)).map((p) => p.providerId), [onLaptop.id]);
    assert.deepEqual((await localProviderTargets(prisma, theirs)).map((p) => p.providerId), [onTheirs.id]);
    const all = [home, laptop, theirs].map((r) => localProviderTargets(prisma, r));
    assert.ok(!(await Promise.all(all)).flat().some((p) => p.providerId === keyed.id), 'an account-scoped key is a target');

    marked.length = 0;
    await providers.update(owner, onHome.id, { enabled: false });
    assert.deepEqual(marked, [home]);
    assert.deepEqual(await localProviderTargets(prisma, home), [], 'a disabled provider is still probed');
    await providers.update(owner, onHome.id, { enabled: true });
  });

  await t.test('(2) two runners report different catalogues, and neither lands on the other\'s row', async () => {
    assert.equal(await storeLocalProviderProbes(prisma, home, [
      probe({ providerId: onHome.id, baseUrl: 'http://127.0.0.1:11434' }),
      // home names laptop's and the stranger's providers: neither is home's.
      probe({ providerId: onLaptop.id, baseUrl: 'http://[::1]:11434/', state: 'NO_MODELS', models: [] }),
      probe({ providerId: onTheirs.id, baseUrl: 'http://127.0.0.1:11434', state: 'UNREACHABLE', models: undefined }),
    ]), 1);
    assert.equal(await storeLocalProviderProbes(prisma, laptop, [
      probe({ providerId: onLaptop.id, baseUrl: 'http://[::1]:11434/', models: [{ value: 'llama3:latest', contextWindow: 65536, tools: true }] }),
    ]), 1);
    const h = await row(onHome.id);
    const l = await row(onLaptop.id);
    assert.equal(h.probeState, 'READY');
    assert.deepEqual((h.instanceModels as Array<{ value: string }>).map((m) => m.value), ['qwen3.8:27b']);
    assert.equal(l.probeState, 'READY');
    assert.deepEqual((l.instanceModels as Array<{ value: string }>).map((m) => m.value), ['llama3:latest']);
    assert.equal((await row(onTheirs.id)).probeState, null, 'another account\'s row took a report');

    // A report about the endpoint the row has left is about nothing here.
    assert.equal(await storeLocalProviderProbes(prisma, home, [probe({ providerId: onHome.id, baseUrl: 'http://127.0.0.1:9999', state: 'UNREACHABLE' })]), 0);
    assert.equal((await row(onHome.id)).probeState, 'READY');
  });

  await t.test('(3) what is kept is sanitized, and a report without a catalogue keeps the stored one', async () => {
    const sent = probe({
      providerId: onHome.id, baseUrl: 'http://127.0.0.1:11434', state: 'CAPABILITY_MISSING', reason: 'no_tools:qwen3.8:27b',
      checkedAt: new Date(Date.now() + 3_600_000).toISOString(),
      models: [
        { value: 'qwen3.8:27b', tools: false, contextWindow: 131072, template: PRIVATE, license: PRIVATE } as never,
        { value: 'gpt-oss:20b-cloud', tools: true },
        { value: `bad name ${PRIVATE}` },
        { value: 'ok:1b', parameterSize: PRIVATE.repeat(4), quantization: '\u0000Q4' },
      ],
    });
    assert.equal(await storeLocalProviderProbes(prisma, home, [sent, { providerId: 'not-a-uuid', baseUrl: 'x', state: 'READY' }, { ...sent, state: 'HEALTHY' }]), 1);
    const h = await row(onHome.id);
    assert.equal(h.probeState, 'CAPABILITY_MISSING');
    assert.equal(h.probeMessage, 'no_tools:qwen3.8:27b');
    assert.deepEqual(h.instanceModels, [{ value: 'qwen3.8:27b', tools: false, contextWindow: 131072 }, { value: 'ok:1b' }]);
    assert.ok(!JSON.stringify(h).includes('PRIVATE'), 'a private body was stored');
    assert.ok(h.probedAt!.getTime() <= Date.now() + 1000, 'a future checkedAt was kept');

    await storeLocalProviderProbes(prisma, home, [probe({ providerId: onHome.id, baseUrl: 'http://127.0.0.1:11434', state: 'UNREACHABLE', reason: 'connection_refused', version: undefined, latencyMs: undefined, models: undefined })]);
    const after = await row(onHome.id);
    assert.equal(after.probeState, 'UNREACHABLE');
    assert.equal(after.probeLatencyMs, null);
    assert.equal((after.instanceModels as unknown[]).length, 2, 'an unanswered inventory cleared the catalogue');
  });

  await t.test('(4) reads tell UNKNOWN, unavailable, READY and STALE apart', async () => {
    assert.equal((await read(stranger, onTheirs.id)).state, 'UNKNOWN', 'never probed');
    assert.equal((await read(owner, onHome.id)).state, 'UNREACHABLE');
    await storeLocalProviderProbes(prisma, home, [probe({ providerId: onHome.id, baseUrl: 'http://127.0.0.1:11434' })]);
    const ready = await read(owner, onHome.id);
    assert.equal(ready.state, 'READY');
    assert.equal(ready.version, '0.40.16');
    assert.equal(ready.latencyMs, 4);
    assert.ok(!('probeMessage' in ready));
    await storeLocalProviderProbes(prisma, home, [probe({ providerId: onHome.id, baseUrl: 'http://127.0.0.1:11434', checkedAt: new Date(Date.now() - LOCAL_PROBE_STALE_MS - 60_000).toISOString() })]);
    assert.equal((await read(owner, onHome.id)).state, 'STALE');
    // A rebind is a target nothing has probed: back to UNKNOWN, latency and all.
    await providers.update(owner, onLaptop.id, { runnerId: home });
    const moved = await row(onLaptop.id);
    assert.equal(moved.probeState, null);
    assert.equal(moved.probeLatencyMs, null);
    assert.equal((await read(owner, onLaptop.id)).state, 'UNKNOWN');
    assert.equal(await storeLocalProviderProbes(prisma, laptop, [probe({ providerId: onLaptop.id, baseUrl: 'http://[::1]:11434/' })]), 0, 'the old runner still writes it');
    await providers.update(owner, onLaptop.id, { runnerId: laptop });
  });

  await t.test('(5) the link\'s one-statement report writer stores them the same way', async () => {
    const dto = { status: 'ONLINE', idleCapacity: 1, localProviderProbes: [
      probe({ providerId: onLaptop.id, baseUrl: 'http://[::1]:11434/', state: 'MODEL_MISSING', reason: 'missing:llama3:latest', models: [] }),
      probe({ providerId: onHome.id, baseUrl: 'http://127.0.0.1:11434', state: 'NO_MODELS', models: [] }),
    ] } as RunnerHeartbeatRequest;
    await writeLinkBeatReports(prisma, {
      runnerId: laptop, leaseOwner: null, dto, reports: ['localProviderProbes'], digests: linkBeatDigests(dto, {}),
      storedFacts: {}, storedPlanUsage: null, now: new Date(),
    });
    const l = await row(onLaptop.id);
    assert.equal(l.probeState, 'MODEL_MISSING');
    assert.deepEqual(l.instanceModels, []);
    assert.notEqual((await row(onHome.id)).probeState, 'NO_MODELS', 'the link writer wrote another runner\'s row');
  });

  await t.test('(5b) the HTTPS heartbeat route stores the probes and answers with the runner\'s own targets', async () => {
    const answer = await api.heartbeat(
      { id: home, version: null },
      { status: 'ONLINE', idleCapacity: 1, localProviderProbes: [
        probe({ providerId: onHome.id, baseUrl: 'http://127.0.0.1:11434', state: 'READY', latencyMs: 9 }),
        probe({ providerId: onTheirs.id, baseUrl: 'http://127.0.0.1:11434', state: 'READY' }),
      ] } as RunnerHeartbeatRequest,
      OLLAMA_PROBE_CAPABILITY,
      'claude',
    );
    assert.deepEqual(answer.localProviders?.map((p) => p.providerId), [onHome.id]);
    assert.equal((await row(onHome.id)).probeLatencyMs, 9);
    assert.equal((await row(onTheirs.id)).probeState, null);
    const theirAnswer = await api.heartbeat({ id: theirs, version: null }, { status: 'ONLINE', idleCapacity: 1 } as RunnerHeartbeatRequest, OLLAMA_PROBE_CAPABILITY, 'claude');
    assert.deepEqual(theirAnswer.localProviders?.map((p) => p.providerId), [onTheirs.id]);
  });

  await t.test('(6) migration 0647 rolls back and forward', async () => {
    await client.query(BACKWARD);
    await client.query(BACKWARD);
    const gone = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'model_provider' AND column_name = 'probe_latency_ms'`);
    assert.equal(gone.rowCount, 0);
    await client.query(FORWARD);
    await client.query(FORWARD);
    const back = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'model_provider' AND column_name = 'probe_latency_ms'`);
    assert.equal(back.rowCount, 1);
  });
});
