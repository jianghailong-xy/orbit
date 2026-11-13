/**
 * Phase 3 of the local Ollama provider, on real PostgreSQL against a fake Ollama (docs/ollama-local-provider-contract.md
 * §7): runner affinity, the readiness gate every door applies, what a claim hands the runner, and failing closed.
 *
 * The fake Ollama is a real HTTP server on loopback that answers /api/version, /api/tags, /api/show and /v1/messages
 * the way Ollama does, and can be stopped, emptied, or made to answer out-of-memory or busy. The control plane never
 * calls it: this spec plays the runner's probe against it (the same calls, the same states as
 * runner-go/local_provider_probe.go) and stores what it found through the phase 2 writer (storeLocalProviderProbes).
 *
 *  (1) Affinity: a session on a local provider is created and claimed only on the runner the provider is bound to. No
 *      other runner — the owner's other one, another account's — ever claims it, and a restarted other runner never
 *      rebuilds it.
 *  (2) The claim hands the runner Claude Code at the fake's root, the session's model, an in-memory placeholder token
 *      and CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC — and none of the workspace's Anthropic credentials. No row holds a
 *      key or the placeholder.
 *  (3) Before start, every door answers a stable code: a probe gone stale, none yet, a model the instance lacks, one
 *      without tools or with too little context; session create, task create and task edit alike.
 *  (4) Ollama stopped mid-life, then back: the waiting session is held PENDING with a readable reason and claimed by
 *      nobody — never onto a cloud engine — and claimed with the reason cleared once the runner sees Ollama again.
 *  (5) Resume and reload: a restarted runner rebuilds an idle session on the local provider only while it is ready;
 *      a reload (provider switch respawn) builds its environment or refuses with the gate's sentence.
 *  (6) Provider switch keeps the same-runtime rule: Claude Code moves from a cloud key onto a local provider on its own
 *      runner and back; a local provider on another runner, a stale one, and a Codex session are refused.
 *  (7) Disabled, deleted and an old runner fail closed: refused at create, held at the claim, never a cloud engine.
 *  (8) Runtime failures are told apart: the fake's out-of-memory and missing-model answers are not retried; its busy
 *      answer and a cold-start timeout are, within the bounded budget.
 *  (9) An account-scoped key beside it dispatches exactly as before, on any runner.
 *
 * It only adds rows under ids of its own, and refuses to run anywhere but the disposable server
 * `coordinator-pg-test-safety` identifies.
 */

import 'reflect-metadata';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';
import {
  AgentProvider,
  apiErrorRetryAt,
  isRetryableApiErrorText,
  LOCAL_AUTH_PLACEHOLDER,
  LOCAL_MIN_CONTEXT_WINDOW,
  LOCAL_PROBE_STALE_MS,
  LOCAL_PROVIDER_ERROR_PREFIX,
  MAX_API_ERROR_RETRIES,
  LOCAL_PROVIDER_RUN_CAPABILITY,
  OLLAMA_PROBE_CAPABILITY,
  RunEventType,
  RunStatus as SharedRunStatus,
  type ClaimedSession,
  type LocalInstanceModel,
  type LocalProviderProbe,
} from '@orbit/shared';
import { Client } from 'pg';

import { sha256 } from '../common/crypto.util';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { AutoRetryService } from '../sessions/auto-retry.service';
import { AUTO_RETRY_TURN_KEY_PREFIX } from '../sessions/watch-turn-key';
import { PROVIDER_UNAVAILABLE_ERROR } from '../runner-api/runner-provider-support';
import { storeLocalProviderProbes } from './local-provider-probe';
import { ProviderPlanUsageService } from './plan-usage.service';
import { ProvidersService } from './providers.service';
import '../test-support/dequeue-under-lease';
import { sessionLease } from '../test-support/dequeue-under-lease';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY ??= 'local-provider-dispatch-spec';

const MODEL = 'qwen3.8:27b';
const WORKSPACE_SECRET = 'workspace-anthropic-credential-never-local';
const TASK_CHECK = { completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0 } as const;

const realtime = new Proxy(
  {},
  { get: (_target, key) => (key === 'then' ? undefined : () => undefined) },
) as RealtimeService;

const suite = URL ? test : test.skip;

// ── The fake Ollama ──────────────────────────────────────────────────────────────────────────────────────

interface FakeModel { tools: boolean; contextWindow: number }

/** A loopback HTTP server that answers like Ollama 0.40, with knobs for what can go wrong. */
class FakeOllama {
  private server: http.Server | null = null;
  private port = 0;
  readonly models = new Map<string, FakeModel>([[MODEL, { tools: true, contextWindow: 262_144 }]]);
  /** How /v1/messages fails, when it does. */
  failure: null | 'oom' | 'busy' = null;
  /** Every request it was sent, as `METHOD path`. */
  readonly seen: string[] = [];

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    const server = http.createServer((req, res) => void this.answer(req, res));
    await new Promise<void>((resolve) => server.listen(this.port, '127.0.0.1', () => resolve()));
    this.port = (server.address() as AddressInfo).port;
    this.server = server;
  }

  /** Ollama stops: the port refuses connections until start() binds it again. */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private entry(name: string): [string, FakeModel] | undefined {
    const tagged = name.includes(':') ? name : `${name}:latest`;
    for (const key of [name, tagged]) {
      const model = this.models.get(key);
      if (model) return [key, model];
    }
    return undefined;
  }

  private async answer(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    this.seen.push(`${req.method} ${req.url}`);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    const body = raw ? (JSON.parse(raw) as { model?: string }) : {};
    if (req.method === 'GET' && req.url === '/api/version') return send(200, { version: '0.40.16' });
    if (req.method === 'GET' && req.url === '/api/tags') {
      return send(200, {
        models: [...this.models.keys()].map((name) => ({
          name, model: name, digest: sha256(name), details: { parameter_size: '27.3B', quantization_level: 'Q4_K_M' },
        })),
      });
    }
    if (req.method === 'POST' && req.url === '/api/show') {
      const found = this.entry(body.model ?? '');
      if (!found) return send(404, { error: `model '${body.model}' not found` });
      return send(200, {
        capabilities: found[1].tools ? ['completion', 'tools'] : ['completion'],
        model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': found[1].contextWindow },
      });
    }
    if (req.method === 'POST' && req.url === '/v1/messages') {
      if (!this.entry(body.model ?? '')) {
        return send(404, { type: 'error', error: { type: 'not_found_error', message: `model "${body.model}" not found, try pulling it first` } });
      }
      if (this.failure === 'oom') {
        return send(500, { type: 'error', error: { type: 'api_error', message: 'model requires more system memory (31.2 GiB) than is available (12.0 GiB)' } });
      }
      if (this.failure === 'busy') {
        return send(503, { type: 'error', error: { type: 'overloaded_error', message: 'server busy, please try again.  maximum pending requests exceeded' } });
      }
      return send(200, { id: 'msg_fake', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'ok' }] });
    }
    send(404, { error: 'not found' });
  }
}

/**
 * What the runner's probe finds at `baseUrl` for the models a row names (local_provider_probe.go, contract §6.2–6.3):
 * no answer is UNREACHABLE, no local model NO_MODELS, a named model not served MODEL_MISSING, one without tools or
 * with under LOCAL_MIN_CONTEXT_WINDOW CAPABILITY_MISSING, else READY — with the instance's catalogue.
 */
async function probeOf(providerId: string, baseUrl: string, named: string[], checkedAt = new Date()): Promise<LocalProviderProbe> {
  const at = { providerId, baseUrl, checkedAt: checkedAt.toISOString() };
  const call = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(2_000) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  let version: string;
  try {
    version = String((await call('/api/version')).json.version);
  } catch {
    return { ...at, state: 'UNREACHABLE', reason: 'connection_refused' };
  }
  const tags = ((await call('/api/tags')).json.models as Array<{ name: string }>).map((m) => m.name);
  const models: LocalInstanceModel[] = [];
  for (const name of tags) {
    const show = await call('/api/show', { method: 'POST', body: JSON.stringify({ model: name }) });
    const info = show.json.model_info as Record<string, number>;
    const contextWindow = Object.entries(info).filter(([k]) => k.endsWith('.context_length')).map(([, v]) => v)[0];
    models.push({ value: name, tools: (show.json.capabilities as string[]).includes('tools'), contextWindow });
  }
  const served = (name: string) => models.find((m) => m.value === name || m.value === `${name}:latest`);
  const state = !models.length
    ? 'NO_MODELS'
    : named.some((name) => !served(name))
      ? 'MODEL_MISSING'
      : named.some((name) => !served(name)!.tools || (served(name)!.contextWindow ?? 0) < LOCAL_MIN_CONTEXT_WINDOW)
        ? 'CAPABILITY_MISSING'
        : 'READY';
  return { ...at, state, version, latencyMs: 1, models };
}

/** The refusal's code (or message), `404`/`409` for those, or `accepted`. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    if (e instanceof NotFoundException) return '404';
    if (e instanceof BadRequestException || e instanceof ConflictException) {
      const body = e.getResponse() as string | { code?: string; message?: unknown };
      return typeof body === 'string' ? body : (body.code ?? String(body.message));
    }
    throw e;
  }
  return 'accepted';
}

suite('a local Ollama provider through dispatch, against a fake Ollama, on real PostgreSQL', { timeout: 600_000, concurrency: 1 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  const db: PrismaClient = prismaClientFor(URL!);
  const fake = new FakeOllama();
  await fake.start();
  t.after(async () => {
    await fake.stop();
    await db.$disconnect();
    await client.end();
  });

  const prisma = db as unknown as PrismaService;
  const usage = new ProviderPlanUsageService(realtime);
  const queue = new QueueService(prisma, realtime, usage);
  const providers = new ProvidersService(prisma, realtime, usage);
  const sessions = new SessionsService(prisma, queue, realtime);
  const tasks = new TasksService(prisma, sessions, realtime);
  const runnerApi = new RunnerApiController(
    db as never, queue as never, realtime as never, realtime as never, { issue: async () => 'orchestration-credential' } as never,
    // The messages here carry no `#`-references and reach no list console.
    { expand: async (_owner: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _id: string, content?: string) => content } as never,
    undefined, undefined, undefined, undefined, sessions,
  );
  const retries = new AutoRetryService(prisma, sessions, realtime);

  async function person(label: string): Promise<string> {
    const id = randomUUID();
    await db.user.create({ data: { id, email: `${label}-${id}@local-dispatch.invalid`, name: label, passwordHash: 'x', role: 'MEMBER' } });
    return id;
  }

  interface Machine { runnerId: string; workspaceId: string }
  /** A runner and a workspace on it. `capabilities` null is a runner too old to declare any. */
  async function machine(ownerId: string, label: string, capabilities: string[] | null = [OLLAMA_PROBE_CAPABILITY, LOCAL_PROVIDER_RUN_CAPABILITY]): Promise<Machine> {
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    await db.runner.create({
      data: {
        id: runnerId, ownerId, name: `${label}-runner`, tokenHash: sha256(`local-dispatch-runner-${runnerId}`),
        status: RunnerStatus.ONLINE, maxConcurrent: 8, lastHeartbeatAt: new Date(),
        ...(capabilities ? { capabilities, capabilitiesReportedAt: new Date() } : {}),
      },
    });
    await db.workspace.create({
      data: {
        id: workspaceId, ownerId, runnerId, name: `${label}-agent`, enabled: true, workDir: `/tmp/${label}`,
        // A credential typed into the workspace: never one a local session may carry to its endpoint.
        env: { ANTHROPIC_API_KEY: WORKSPACE_SECRET, KEEP_ME: 'yes' },
      },
    });
    return { runnerId, workspaceId };
  }

  interface Local { id: string; slug: string; runnerId: string }
  async function localOn(ownerId: string, at: Machine, models: string[] = [MODEL]): Promise<Local> {
    const created = (await providers.create(ownerId, {
      label: 'Ollama', presetSlug: 'ollama', baseUrl: fake.url, runnerId: at.runnerId,
      models: models.map((value) => ({ value, label: value, contextWindow: 65_536 })), defaultModel: models[0],
    })) as { id: string; slug: string };
    return { ...created, runnerId: at.runnerId };
  }

  /** The bound runner probes the fake and reports, as its heartbeat would. */
  async function probe(local: Local, checkedAt?: Date): Promise<string> {
    const row = await db.modelProvider.findUniqueOrThrow({ where: { id: local.id } });
    const named = [...new Set([...(row.models as Array<{ value: string }>).map((m) => m.value), row.defaultModel ?? ''].filter(Boolean))];
    const report = await probeOf(local.id, row.baseUrl, named, checkedAt);
    assert.equal(await storeLocalProviderProbes(prisma, local.runnerId, [report]), 1, 'the probe report did not land');
    return report.state;
  }

  /** A session through the API's own create door. */
  const create = (ownerId: string, at: Machine, provider: string, model?: string) =>
    sessions.create(ownerId, { prompt: 'hello', workspaceId: at.workspaceId, provider, ...(model ? { model } : {}) } as never);
  /** A session written as an existing one would be (for the claim, the reclaim and the switch). */
  async function sessionOn(ownerId: string, at: Machine, provider: string, status: RunStatus = RunStatus.PENDING, engine = AgentProvider.CLAUDE) {
    const started = status !== RunStatus.PENDING;
    return (await db.session.create({
      data: {
        title: 'local dispatch', prompt: 'hello', status, ownerId, creatorId: ownerId,
        workspaceId: at.workspaceId, assignedRunnerId: at.runnerId, provider, providerBuiltin: false,
        engine, model: MODEL, permissionMode: 'default', usesRuntimeDefaultModel: true,
        ...(started ? { numTurns: 1, runtimeSessionId: randomUUID(), startedAt: new Date() } : {}),
      },
      select: { id: true },
    })).id;
  }
  const claimOn = (at: Machine): Promise<ClaimedSession | null> =>
    queue.claimSessionForRunner({ id: at.runnerId, supportedProviders: [AgentProvider.CLAUDE, AgentProvider.CODEX] });
  const rowOf = (id: string) =>
    db.session.findUniqueOrThrow({ where: { id }, select: { status: true, error: true, provider: true, providerBuiltin: true, engine: true } });

  const owner = await person('owner');
  const stranger = await person('stranger');
  // Every case starts from the same instance, so a case that fails part-way does not take the next one with it.
  t.beforeEach(() => {
    fake.models.clear();
    fake.models.set(MODEL, { tools: true, contextWindow: 262_144 });
    fake.failure = null;
  });

  await t.test('(1) affinity: created and claimed on its own runner only; no other runner ever claims it', async () => {
    const home = await machine(owner, 'aff-home');
    const laptop = await machine(owner, 'aff-laptop');
    const theirs = await machine(stranger, 'aff-theirs');
    const local = await localOn(owner, home);
    assert.equal(await probe(local), 'READY');

    assert.equal(await outcome(() => create(owner, laptop, local.slug)), 'LOCAL_PROVIDER_ELSEWHERE', 'created on another runner');
    assert.equal(await outcome(() => create(stranger, theirs, local.slug)), `provider not available: "${local.slug}"`, 'another account named it');

    // Written onto the other runners anyway (an older replica, a hand-made row): they never claim it.
    const strayed = await sessionOn(owner, laptop, local.slug);
    const forged = await sessionOn(stranger, theirs, local.slug);
    for (let i = 0; i < 3; i++) {
      assert.equal(await claimOn(laptop), null);
      assert.equal(await claimOn(theirs), null);
    }
    assert.equal((await rowOf(strayed)).status, RunStatus.PENDING);
    assert.ok((await rowOf(strayed)).error?.startsWith(LOCAL_PROVIDER_ERROR_PREFIX), 'the stray waits with a reason');
    assert.equal((await rowOf(forged)).status, RunStatus.PENDING);
    // A restarted other runner does not rebuild one either.
    const idle = await sessionOn(owner, laptop, local.slug, RunStatus.AWAITING_INPUT);
    assert.equal((await runnerApi.reclaim({ id: laptop.runnerId, ownerId: owner })).sessions.find((s) => s.sessionId === idle), undefined);

    const mine = (await create(owner, home, local.slug)) as { id: string };
    assert.equal((await claimOn(home))?.sessionId, mine.id);
    assert.equal((await claimOn(laptop)), null, 'the stray is still never the laptop\'s');
  });

  await t.test('(2) a valid claim hands over the runtime, the model and the endpoint, and no stored or workspace secret', async () => {
    const home = await machine(owner, 'env-home');
    const local = await localOn(owner, home, [MODEL, 'llama3']);
    fake.models.set('llama3:latest', { tools: true, contextWindow: 131_072 });
    assert.equal(await probe(local), 'READY');
    const id = ((await create(owner, home, local.slug)) as { id: string }).id;
    const claimed = await claimOn(home);
    assert.equal(claimed?.sessionId, id);
    assert.equal(claimed?.agent.provider, AgentProvider.CLAUDE);
    assert.equal(claimed?.agent.model, MODEL);
    const env = claimed!.agent.env!;
    assert.equal(env.ANTHROPIC_BASE_URL, fake.url);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, LOCAL_AUTH_PLACEHOLDER);
    assert.equal(env.ANTHROPIC_MODEL, MODEL);
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
    assert.equal(env.KEEP_ME, 'yes', 'the rest of the workspace env still travels');
    // Named empty, so neither the workspace's key nor one in the runner's own environment reaches the endpoint.
    assert.equal(env.ANTHROPIC_API_KEY, '', 'a workspace Anthropic key reached the local endpoint');
    for (const route of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'AWS_BEARER_TOKEN_BEDROCK', 'CLAUDE_CODE_OAUTH_TOKEN']) {
      assert.equal(env[route], '', `${route} is not overridden`);
    }
    assert.equal(env.ORBIT_LOCAL_PROVIDER, '1', 'the runner is not told to isolate the run');
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, MODEL, 'background requests go to a model the instance does not serve');
    assert.ok(!JSON.stringify(claimed).includes(WORKSPACE_SECRET));
    // Nothing stored holds a key for it, or the placeholder.
    const keyed = await client.query(`SELECT 1 FROM "model_provider" WHERE "id" = $1 AND "api_key_enc" <> ''`, [local.id]);
    assert.equal(keyed.rowCount, 0);
    const session = await client.query(`SELECT row_to_json(s)::text AS j FROM "session" s WHERE id = $1`, [id]);
    assert.ok(!session.rows[0].j.includes('ANTHROPIC_AUTH_TOKEN') && !session.rows[0].j.includes(WORKSPACE_SECRET));
    const turns = await client.query(`SELECT coalesce(string_agg(content::text, ''), '') AS j FROM "conversation_turn" WHERE session_id = $1`, [id]);
    assert.ok(!turns.rows[0].j.includes('ANTHROPIC_AUTH_TOKEN'));

    // `llama3` is Ollama's `llama3:latest`.
    const tagless = ((await create(owner, home, local.slug, 'llama3')) as { id: string }).id;
    const second = await claimOn(home);
    assert.equal(second?.sessionId, tagless);
    assert.equal(second?.agent.model, 'llama3');
    fake.models.delete('llama3:latest');
  });

  await t.test('(3) before start: stale, unprobed, a missing model and a missing capability answer stable codes', async () => {
    const home = await machine(owner, 'pre-home');
    const laptop = await machine(owner, 'pre-laptop');
    const local = await localOn(owner, home);
    assert.equal(await outcome(() => create(owner, home, local.slug)), 'LOCAL_PROVIDER_UNPROBED');
    await probe(local, new Date(Date.now() - LOCAL_PROBE_STALE_MS - 60_000));
    assert.equal(await outcome(() => create(owner, home, local.slug)), 'LOCAL_PROVIDER_STALE');
    assert.equal(await probe(local), 'READY');
    assert.equal(await outcome(() => create(owner, home, local.slug, 'mistral:7b')), 'LOCAL_PROVIDER_MODEL_MISSING');
    fake.models.set('notools:8b', { tools: false, contextWindow: 131_072 });
    fake.models.set('tiny:1b', { tools: true, contextWindow: 8_192 });
    await probe(local);
    assert.equal(await outcome(() => create(owner, home, local.slug, 'notools:8b')), 'LOCAL_PROVIDER_CAPABILITY_MISSING');
    assert.equal(await outcome(() => create(owner, home, local.slug, 'tiny:1b')), 'LOCAL_PROVIDER_CAPABILITY_MISSING');
    assert.equal(await outcome(() => create(owner, home, local.slug)), 'accepted');

    // A task: created and edited under the same gate, against its assignee's runner.
    const title = 'local task';
    assert.equal(await outcome(() => tasks.create(owner, { title, provider: local.slug, assigneeId: laptop.workspaceId, ...TASK_CHECK } as never)), 'LOCAL_PROVIDER_ELSEWHERE');
    assert.equal(await outcome(() => tasks.create(owner, { title, provider: local.slug, model: 'mistral:7b', assigneeId: home.workspaceId, ...TASK_CHECK } as never)), 'LOCAL_PROVIDER_MODEL_MISSING');
    assert.equal(await outcome(() => tasks.create(owner, { title, provider: local.slug, model: 'notools:8b', ...TASK_CHECK } as never)), 'LOCAL_PROVIDER_CAPABILITY_MISSING');
    const task = (await tasks.create(owner, { title, provider: local.slug, assigneeId: home.workspaceId, ...TASK_CHECK } as never)) as { id: string };
    assert.equal(await outcome(() => tasks.update(owner, task.id, { assigneeId: laptop.workspaceId } as never)), 'LOCAL_PROVIDER_ELSEWHERE');
    assert.equal(await outcome(() => tasks.update(owner, task.id, { model: 'tiny:1b' } as never)), 'LOCAL_PROVIDER_CAPABILITY_MISSING');
    await probe(local, new Date(Date.now() - LOCAL_PROBE_STALE_MS - 60_000));
    assert.equal(await outcome(() => tasks.update(owner, task.id, { model: MODEL } as never)), 'LOCAL_PROVIDER_STALE');
    // A task on an ordinary provider is untouched by any of it.
    assert.equal(await outcome(() => tasks.update(owner, task.id, { provider: AgentProvider.CLAUDE } as never)), 'accepted');
    fake.models.delete('notools:8b');
    fake.models.delete('tiny:1b');
  });

  await t.test('(4) Ollama stops: the session waits with a reason, claimed by nobody; back up, it runs', async () => {
    const home = await machine(owner, 'stop-home');
    const local = await localOn(owner, home);
    assert.equal(await probe(local), 'READY');
    const id = ((await create(owner, home, local.slug)) as { id: string }).id;
    await fake.stop();
    try {
      assert.equal(await probe(local), 'UNREACHABLE');
      for (let i = 0; i < 3; i++) assert.equal(await claimOn(home), null);
      const held = await rowOf(id);
      assert.equal(held.status, RunStatus.PENDING);
      assert.match(held.error ?? '', /^Local provider ".+" is not answering on its runner/);
      assert.deepEqual([held.provider, held.providerBuiltin, held.engine], [local.slug, false, AgentProvider.CLAUDE], 'it moved onto a cloud engine');
      assert.equal(await outcome(() => create(owner, home, local.slug)), 'LOCAL_PROVIDER_UNREACHABLE');
    } finally {
      await fake.start();
    }
    assert.equal(await probe(local), 'READY');
    const claimed = await claimOn(home);
    assert.equal(claimed?.sessionId, id);
    assert.equal((await rowOf(id)).error, null, 'the hold\'s reason outlived it');

    // The model removed from Ollama while a session waits: held as a configuration error.
    const waiting = ((await create(owner, home, local.slug)) as { id: string }).id;
    fake.models.delete(MODEL);
    assert.equal(await probe(local), 'NO_MODELS');
    assert.equal(await claimOn(home), null);
    assert.match((await rowOf(waiting)).error ?? '', /serves no local model/);
    fake.models.set(MODEL, { tools: true, contextWindow: 262_144 });
    await probe(local);
    assert.equal((await claimOn(home))?.sessionId, waiting);
  });

  /** The runner's inbox poll, as it makes it: the session's live lease, and a poller that takes steers. */
  const inbox = async (at: Machine, id: string) =>
    runnerApi.inbox({ id: at.runnerId } as never, id, await sessionLease(prisma, id), '1') as Promise<{
      turnId: string; kind: string; env?: Record<string, string>; content?: string;
    }>;
  const reloadsOf = (id: string) => db.conversationTurn.findMany({ where: { sessionId: id, kind: 'reload' }, orderBy: { seq: 'asc' } });

  await t.test('(5) resume and reload: rebuilt on its own runner only while ready, through the runner\'s own doors', async () => {
    const home = await machine(owner, 'resume-home');
    const local = await localOn(owner, home);
    const twin = await localOn(owner, home);
    await probe(local);
    await probe(twin);
    const idle = await sessionOn(owner, home, local.slug, RunStatus.AWAITING_INPUT);
    const rebuilt = (await runnerApi.reclaim({ id: home.runnerId, ownerId: owner })).sessions.find((s) => s.sessionId === idle);
    assert.equal(rebuilt?.agent.env?.ANTHROPIC_BASE_URL, fake.url);
    assert.equal(rebuilt?.agent.env?.ANTHROPIC_AUTH_TOKEN, LOCAL_AUTH_PLACEHOLDER);

    // A provider switch onto the twin queues a reload; the runner's inbox hands it out with the twin's env.
    assert.equal(await outcome(() => sessions.updateConfig(owner, idle, { provider: twin.slug, model: MODEL } as never)), 'accepted');
    const handed = await inbox(home, idle);
    assert.equal(handed.kind, 'reload');
    assert.equal(handed.env?.ANTHROPIC_BASE_URL, fake.url);
    assert.equal(handed.env?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
    assert.equal(handed.env?.ORBIT_LOCAL_PROVIDER, '1');

    // Switched back while ready, then the twin's probe goes stale before the runner polls: the reload is not handed out.
    assert.equal(await outcome(() => sessions.updateConfig(owner, idle, { provider: local.slug, model: MODEL } as never)), 'accepted');
    await probe(local, new Date(Date.now() - LOCAL_PROBE_STALE_MS - 60_000));
    const refused = await inbox(home, idle);
    assert.notEqual(refused.kind, 'reload', 'a reload onto a stale local provider was handed out');
    assert.equal(refused.env, undefined);
    const again = (await runnerApi.reclaim({ id: home.runnerId, ownerId: owner })).sessions.find((s) => s.sessionId === idle);
    assert.equal(again, undefined, 'a stale local provider was rebuilt on reclaim');
    assert.equal((await rowOf(idle)).provider, local.slug, 'the session moved off its provider');
  });
  await t.test('(6) provider switch keeps the same-runtime rule, under the same gate', async () => {
    const home = await machine(owner, 'switch-home');
    const laptop = await machine(owner, 'switch-laptop');
    const local = await localOn(owner, home);
    const elsewhere = await localOn(owner, laptop);
    await probe(local);
    await probe(elsewhere);
    const cloud = (await providers.create(owner, {
      label: 'DeepSeek', presetSlug: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-local-dispatch-cloud',
    })) as { slug: string };
    const onCloud = await sessionOn(owner, home, cloud.slug, RunStatus.AWAITING_INPUT);
    assert.equal(await outcome(() => sessions.updateConfig(owner, onCloud, { provider: elsewhere.slug, model: MODEL } as never)), 'LOCAL_PROVIDER_ELSEWHERE');
    assert.equal(await outcome(() => sessions.updateConfig(owner, onCloud, { provider: local.slug, model: MODEL } as never)), 'accepted');
    assert.equal((await rowOf(onCloud)).provider, local.slug);
    assert.equal((await rowOf(onCloud)).engine, AgentProvider.CLAUDE, 'a switch moved the engine');
    await probe(local, new Date(Date.now() - LOCAL_PROBE_STALE_MS - 60_000));
    assert.equal(await outcome(() => sessions.updateConfig(owner, onCloud, { model: MODEL } as never)), 'LOCAL_PROVIDER_STALE');
    // Leaving a local provider that cannot run is how such a session recovers.
    assert.equal(await outcome(() => sessions.updateConfig(owner, onCloud, { provider: cloud.slug } as never)), 'accepted');

    // A Codex session cannot move onto a provider Claude Code alone runs.
    await probe(local);
    const codex = (await providers.create(owner, {
      label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-local-dispatch-codex', runtime: 'codex',
    } as never)) as { slug: string };
    const onCodex = await sessionOn(owner, home, codex.slug, RunStatus.AWAITING_INPUT, AgentProvider.CODEX);
    assert.equal(await outcome(() => sessions.updateConfig(owner, onCodex, { provider: local.slug, model: MODEL } as never)), 'PROVIDER_ENGINE_INCOMPATIBLE');
  });

  await t.test('(7) disabled, deleted and an old runner fail closed — never a cloud engine', async () => {
    const home = await machine(owner, 'closed-home');
    const local = await localOn(owner, home);
    await probe(local);
    await providers.update(owner, local.id, { enabled: false });
    // A disabled provider meets the refusals every disabled provider meets, at every door; the gate's own
    // LOCAL_PROVIDER_DISABLED is a backstop no door answers first.
    assert.equal(await outcome(() => create(owner, home, local.slug)), `provider not available: "${local.slug}"`);
    const cloud = (await providers.create(owner, {
      label: 'DeepSeek', presetSlug: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'local-dispatch-closed-cloud',
    })) as { slug: string };
    const onCloud = await sessionOn(owner, home, cloud.slug, RunStatus.AWAITING_INPUT);
    assert.equal(await outcome(() => sessions.updateConfig(owner, onCloud, { provider: local.slug } as never)), 'provider not available');
    const onDisabled = await sessionOn(owner, home, local.slug, RunStatus.AWAITING_INPUT);
    assert.equal(await outcome(() => sessions.updateConfig(owner, onDisabled, { model: MODEL } as never)), 'provider is disabled');
    const whileDisabled = await sessionOn(owner, home, local.slug);
    assert.equal(await claimOn(home), null);
    assert.equal((await rowOf(whileDisabled)).error, PROVIDER_UNAVAILABLE_ERROR);
    await providers.update(owner, local.id, { enabled: true });
    assert.equal((await claimOn(home))?.sessionId, whileDisabled);

    await providers.remove(owner, local.id);
    const afterDelete = await sessionOn(owner, home, local.slug);
    assert.equal(await claimOn(home), null);
    assert.deepEqual(
      { ...(await rowOf(afterDelete)), error: undefined },
      { status: RunStatus.PENDING, error: undefined, provider: local.slug, providerBuiltin: false, engine: AgentProvider.CLAUDE },
    );

    // A runner too old to declare the probe: whatever a stale row says, it is refused and held.
    const old = await machine(owner, 'closed-old', null);
    const onOld = await localOn(owner, old);
    await db.modelProvider.update({
      where: { id: onOld.id },
      data: { probeState: 'READY', probedAt: new Date(), instanceModels: [{ value: MODEL, tools: true, contextWindow: 262_144 }] },
    });
    assert.equal(await outcome(() => create(owner, old, onOld.slug)), 'LOCAL_PROVIDER_RUNNER_OUTDATED');
    const waiting = await sessionOn(owner, old, onOld.slug);
    assert.equal(await claimOn(old), null);
    assert.match((await rowOf(waiting)).error ?? '', /needs a newer runner/);
    // Once it declares the probe, the same session runs.
    await db.runner.update({ where: { id: old.runnerId }, data: { capabilities: [OLLAMA_PROBE_CAPABILITY], capabilitiesReportedAt: new Date() } });
    assert.equal(await claimOn(old), null, 'a runner that probes but does not isolate the run was handed it');
    await db.runner.update({ where: { id: old.runnerId }, data: { capabilities: [OLLAMA_PROBE_CAPABILITY, LOCAL_PROVIDER_RUN_CAPABILITY], capabilitiesReportedAt: new Date() } });
    assert.equal((await claimOn(old))?.sessionId, waiting);
  });

  await t.test('(8) the fake\'s out-of-memory and missing model are not retried; busy and a cold-start timeout are, boundedly', async () => {
    const said = async (model: string) => {
      const res = await fetch(`${fake.url}/v1/messages`, { method: 'POST', body: JSON.stringify({ model, max_tokens: 8, messages: [] }) });
      // Claude Code's own rendering of an answer it gave up on.
      return `API Error: ${res.status} ${await res.text()}`;
    };
    fake.failure = 'oom';
    assert.equal(isRetryableApiErrorText(await said(MODEL)), false, 'an out-of-memory load is re-sent');
    assert.equal(isRetryableApiErrorText('API Error: 500 {"error":"llama runner process has terminated: cudaMalloc failed: out of memory"}'), false);
    fake.failure = null;
    assert.equal(isRetryableApiErrorText(await said('gone:7b')), false, 'a missing model is re-sent');
    fake.failure = 'busy';
    assert.equal(isRetryableApiErrorText(await said(MODEL)), true, 'a busy Ollama is not re-sent');
    fake.failure = null;
    // Claude Code's words for a request a cold-loading model never answered.
    assert.equal(isRetryableApiErrorText('API Error: Request timed out.'), true);
    // …within the budget: the fourth failure in a row is handed back, not re-sent.
    const now = new Date();
    for (let attempt = 0; attempt < MAX_API_ERROR_RETRIES; attempt++) assert.ok(apiErrorRetryAt(attempt, now));
    assert.equal(apiErrorRetryAt(MAX_API_ERROR_RETRIES, now), null);
  });

  await t.test('(9) an account-scoped key beside it dispatches exactly as before, on any runner', async () => {
    const home = await machine(owner, 'keyed-home');
    const laptop = await machine(owner, 'keyed-laptop');
    const keyed = (await providers.create(owner, {
      label: 'DeepSeek', presetSlug: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-local-dispatch-keyed',
    })) as { slug: string };
    for (const at of [home, laptop]) {
      const id = ((await create(owner, at, keyed.slug)) as { id: string }).id;
      const claimed = await claimOn(at);
      assert.equal(claimed?.sessionId, id);
      assert.equal(claimed?.agent.env?.ANTHROPIC_AUTH_TOKEN, 'sk-local-dispatch-keyed');
      assert.equal(claimed?.agent.env?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined);
      assert.equal(claimed?.agent.env?.ANTHROPIC_API_KEY, WORKSPACE_SECRET, 'an ordinary key session lost its workspace env');
    }
    // No model request ever reached the fake but the three case (8) sent itself: the control plane runs nothing on it.
    assert.equal(fake.seen.filter((line) => line === 'POST /v1/messages').length, 3);
  });
  // ── A run, through the runner's own doors ────────────────────────────────────────────────────────────

  /** An idle session that has run its opening turn: nothing for a claim to seed. */
  async function idleOn(ownerId: string, at: Machine, provider: string): Promise<string> {
    const id = await sessionOn(ownerId, at, provider, RunStatus.AWAITING_INPUT);
    await db.conversationTurn.create({
      data: {
        sessionId: id, seq: 1, clientTurnId: `initial-${id}`, kind: 'message', content: 'hello',
        status: 'ANSWERED', deliveredAt: new Date(), answeredAt: new Date(),
      },
    });
    return id;
  }
  /** The runner process that holds the session's inbox lease, as every runner write names it. */
  const leaseOwnerOf = async (id: string) =>
    (await db.session.findUniqueOrThrow({ where: { id }, select: { inboxLeaseOwner: true } })).inboxLeaseOwner ?? undefined;
  const seqs = new Map<string, number>();
  /** The runner's events for one turn, through the real ingest. */
  async function say(at: Machine, id: string, turnId: string, type: RunEventType, payload: Record<string, unknown>) {
    const seq = (seqs.get(id) ?? 100) + 1;
    seqs.set(id, seq);
    await runnerApi.events({ id: at.runnerId } as never, id, {
      events: [{ seq, type, ts: new Date().toISOString(), turnId, payload }], leaseOwner: await leaseOwnerOf(id),
    } as never);
  }
  /** The runner's poll after a claim, until a message comes out; echoed as the engine echoes it. */
  async function handOut(at: Machine, id: string): Promise<string> {
    for (;;) {
      const handed = await (runnerApi as unknown as {
        dequeueTurn: (id: string, runnerId: string, lease: string | null) => Promise<Record<string, unknown> | null>;
      }).dequeueTurn(id, at.runnerId, null);
      assert.ok(handed, `the inbox of ${id} handed nothing out`);
      const turn = await db.conversationTurn.findUniqueOrThrow({ where: { id: String(handed.turnId) } });
      if (turn.kind !== 'message') continue;
      await say(at, id, turn.id, RunEventType.USER, { text: String(handed.content ?? '') });
      return turn.id;
    }
  }
  /** A person's message: queued, claimed by the bound runner, handed out. */
  async function running(at: Machine, id: string, words: string): Promise<{ turnId: string; claimed: ClaimedSession }> {
    await sessions.createTurn(owner, id, { clientTurnId: randomUUID(), content: words });
    const claimed = await claimOn(at);
    assert.equal(claimed?.sessionId, id, 'the bound runner was not handed the turn');
    return { turnId: await handOut(at, id), claimed: claimed! };
  }
  /** The turn ends as the runner settles it: the engine's last words, then the completion. */
  async function ends(at: Machine, id: string, turnId: string, failed: boolean, text: string) {
    await say(at, id, turnId, RunEventType.ASSISTANT, { text });
    await runnerApi.turnComplete({ id: at.runnerId } as never, id, {
      leaseOwner: await leaseOwnerOf(id),
      turnId, status: failed ? SharedRunStatus.FAILED : SharedRunStatus.SUCCEEDED,
      subtype: failed ? 'error_during_execution' : 'success', numTurns: 1, costUsd: 0, ...(failed ? { error: text } : {}),
    } as never);
  }
  /** What the fake answers a model request with, in Claude Code's own rendering of an answer it gave up on. */
  async function said(model: string, failure: FakeOllama['failure'] = null): Promise<string> {
    fake.failure = failure;
    try {
      const res = await fetch(`${fake.url}/v1/messages`, { method: 'POST', body: JSON.stringify({ model, max_tokens: 8, messages: [] }) });
      return `API Error: ${res.status} ${await res.text()}`;
    } finally {
      fake.failure = null;
    }
  }
  const COLD_START_TIMEOUT = 'API Error: Request timed out.';
  const resentOf = (id: string) => db.conversationTurn.findMany({ where: { sessionId: id, clientTurnId: { startsWith: AUTO_RETRY_TURN_KEY_PREFIX } } });

  await t.test('(10) task start: the task-bound session is made and claimed on the bound runner; stale or stopped, the start is refused', async () => {
    const home = await machine(owner, 'task-home');
    const laptop = await machine(owner, 'task-laptop');
    const local = await localOn(owner, home);
    await probe(local);
    const task = (await tasks.create(owner, { title: 'local task run', provider: local.slug, assigneeId: home.workspaceId, ...TASK_CHECK } as never)) as { id: string };
    const started = (await tasks.execute(owner, task.id, undefined, randomUUID())) as { sessionId: string };
    const run = await db.session.findUniqueOrThrow({
      where: { id: started.sessionId },
      select: { taskId: true, assignedRunnerId: true, provider: true, providerBuiltin: true, engine: true },
    });
    assert.deepEqual(run, { taskId: task.id, assignedRunnerId: home.runnerId, provider: local.slug, providerBuiltin: false, engine: AgentProvider.CLAUDE });
    assert.equal(await claimOn(laptop), null);
    const claimed = await claimOn(home);
    assert.equal(claimed?.sessionId, started.sessionId);
    assert.equal(claimed?.agent.env?.ANTHROPIC_BASE_URL, fake.url);
    assert.equal(claimed?.agent.env?.ORBIT_LOCAL_PROVIDER, '1');

    // Created while READY, then the probe goes stale — or Ollama stops — before the task is started.
    for (const turn of ['stale', 'stopped'] as const) {
      const later = (await tasks.create(owner, { title: `local task ${turn}`, provider: local.slug, assigneeId: home.workspaceId, ...TASK_CHECK } as never)) as { id: string };
      if (turn === 'stale') {
        await probe(local, new Date(Date.now() - LOCAL_PROBE_STALE_MS - 60_000));
      } else {
        await fake.stop();
        try {
          assert.equal(await probe(local), 'UNREACHABLE');
        } finally {
          await fake.start();
        }
      }
      const code = turn === 'stale' ? 'LOCAL_PROVIDER_STALE' : 'LOCAL_PROVIDER_UNREACHABLE';
      assert.equal(await outcome(() => tasks.execute(owner, later.id, undefined, randomUUID())), code);
      assert.deepEqual(await db.session.findMany({ where: { taskId: later.id }, select: { id: true } }), [], 'a refused start left a run behind');
      assert.deepEqual(
        await db.task.findUniqueOrThrow({ where: { id: later.id }, select: { provider: true, assigneeId: true } }),
        { provider: local.slug, assigneeId: home.workspaceId },
        'a refused start moved the task',
      );
      assert.equal(await claimOn(laptop), null);
      await probe(local);
    }
  });

  await t.test('(11) Ollama stops after a run: the next turn, a reclaim and a reload hand out nothing until it is back', async () => {
    const home = await machine(owner, 'mid-home');
    const local = await localOn(owner, home);
    const twin = await localOn(owner, home);
    await probe(local);
    await probe(twin);
    const id = await idleOn(owner, home, local.slug);
    const first = await running(home, id, 'list the files');
    assert.equal(first.claimed.agent.env?.ANTHROPIC_BASE_URL, fake.url);
    await ends(home, id, first.turnId, false, 'here they are');
    assert.equal((await rowOf(id)).status, RunStatus.AWAITING_INPUT, 'the run did not end recoverable');
    // A second idle session, switched while ready: its reload is queued for the runner's next poll.
    const idle = await sessionOn(owner, home, local.slug, RunStatus.AWAITING_INPUT);
    assert.equal(await outcome(() => sessions.updateConfig(owner, idle, { provider: twin.slug, model: MODEL } as never)), 'accepted');

    await fake.stop();
    try {
      assert.equal(await probe(local), 'UNREACHABLE');
      assert.equal(await probe(twin), 'UNREACHABLE');
      await sessions.createTurn(owner, id, { clientTurnId: randomUUID(), content: 'and now?' });
      for (let i = 0; i < 3; i++) assert.equal(await claimOn(home), null, 'a turn was handed to a runner whose Ollama is down');
      const held = await rowOf(id);
      assert.equal(held.status, RunStatus.PENDING);
      assert.match(held.error ?? '', /is not answering on its runner/);
      const reclaimed = (await runnerApi.reclaim({ id: home.runnerId, ownerId: owner })).sessions.map((s) => s.sessionId);
      assert.ok(!reclaimed.includes(id) && !reclaimed.includes(idle), 'a reclaim rebuilt a session onto a stopped Ollama');
      const reload = await inbox(home, idle);
      assert.notEqual(reload.kind, 'reload', 'a reload onto a stopped Ollama was handed out');
      assert.equal(reload.env, undefined);
      for (const sid of [id, idle]) {
        const row = await rowOf(sid);
        assert.deepEqual([row.providerBuiltin, row.engine], [false, AgentProvider.CLAUDE], 'a session moved onto a cloud engine');
      }
    } finally {
      await fake.start();
    }
    await probe(local);
    await probe(twin);
    const back = await claimOn(home);
    assert.equal(back?.sessionId, id);
    assert.equal(back?.agent.env?.ANTHROPIC_BASE_URL, fake.url);
    assert.equal((await rowOf(id)).error, null);
  });

  await t.test('(12) failures through ingest, settlement and the retry sweep: out of memory and a missing model are never re-sent; a cold-start timeout is, within the budget, on the same runner and provider', async () => {
    const home = await machine(owner, 'retry-home');
    const local = await localOn(owner, home);
    await probe(local);
    const heartbeat = () => db.runner.update({ where: { id: home.runnerId }, data: { lastHeartbeatAt: new Date() } });

    for (const [label, text] of [['out of memory', await said(MODEL, 'oom')], ['missing model', await said('gone:7b')]] as const) {
      const id = await idleOn(owner, home, local.slug);
      const turn = await running(home, id, `the ${label} turn`);
      await ends(home, id, turn.turnId, true, text);
      const failed = await db.session.findUniqueOrThrow({ where: { id }, select: { status: true, retryAt: true } });
      assert.equal(failed.status, RunStatus.FAILED);
      assert.equal(failed.retryAt, null, `${label} armed an automatic retry`);
      await heartbeat();
      await retries.sweep();
      assert.equal((await resentOf(id)).length, 0, `${label} was re-sent`);
      assert.equal(await claimOn(home), null);
    }

    const id = await idleOn(owner, home, local.slug);
    let turnId = (await running(home, id, 'load the big model')).turnId;
    for (let attempt = 0; ; attempt++) {
      await ends(home, id, turnId, true, COLD_START_TIMEOUT);
      const row = await db.session.findUniqueOrThrow({ where: { id }, select: { retryAt: true, provider: true, providerBuiltin: true, assignedRunnerId: true } });
      assert.deepEqual([row.provider, row.providerBuiltin, row.assignedRunnerId], [local.slug, false, home.runnerId], 'a retry moved the session');
      if (!row.retryAt) break;
      assert.ok(attempt < MAX_API_ERROR_RETRIES, 'a timeout was re-sent past the budget');
      await db.session.update({ where: { id }, data: { retryAt: new Date(Date.now() - 3_600_000) } });
      await heartbeat();
      await retries.sweep();
      const claimed = await claimOn(home);
      assert.equal(claimed?.sessionId, id, 'the re-sent turn was not handed to the bound runner');
      assert.equal(claimed?.agent.env?.ANTHROPIC_BASE_URL, fake.url);
      assert.equal(claimed?.agent.env?.ORBIT_LOCAL_PROVIDER, '1');
      turnId = await handOut(home, id);
    }
    assert.equal((await resentOf(id)).length, MAX_API_ERROR_RETRIES);
  });

  await t.test('(13) a task run that ended on Ollama refusing the request is held off the auto-run ladder; a timeout only backs off', async () => {
    const home = await machine(owner, 'auto-home');
    const local = await localOn(owner, home);
    await probe(local);
    const policy = async (taskId: string) => {
      const refused = new Set<string>();
      const held = await (tasks as unknown as {
        autoRunHoldOff: (ids: string[], blind: Set<string>, o: { countUnrequestedEnds: boolean; localServerRefused: Set<string> }) => Promise<Map<string, Date | null>>;
      }).autoRunHoldOff([taskId], new Set(), { countUnrequestedEnds: true, localServerRefused: refused });
      return { held, refused };
    };
    for (const [label, error, final] of [
      ['out of memory', await said(MODEL, 'oom'), true],
      ['missing model', await said('gone:7b'), true],
      ['cold-start timeout', COLD_START_TIMEOUT, false],
      ['busy', await said(MODEL, 'busy'), false],
    ] as const) {
      const task = (await tasks.create(owner, { title: `auto ${label}`, provider: local.slug, assigneeId: home.workspaceId, ...TASK_CHECK } as never)) as { id: string };
      const { sessionId } = (await tasks.execute(owner, task.id, undefined, randomUUID())) as { sessionId: string };
      await db.session.update({ where: { id: sessionId }, data: { status: RunStatus.FAILED, error, finishedAt: new Date() } });
      const { held, refused } = await policy(task.id);
      if (final) {
        assert.ok(held.has(task.id) && held.get(task.id) === null, `${label}: the ladder would re-run it`);
        assert.ok(refused.has(task.id), `${label}: not told apart from a spent budget`);
      } else {
        assert.ok(held.get(task.id) instanceof Date, `${label}: not backed off`);
        assert.ok(!refused.has(task.id), `${label}: held as final`);
      }
    }
  });
});
