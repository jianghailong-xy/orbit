/**
 * The provider/engine split's server doors on a real PostgreSQL (docs/provider-engine-contract.md §3,
 * §4.4–§4.5, §6; migration 0415): one resolver turns whatever a caller names — a provider, an engine,
 * both or neither — into one engine and one credential it can run, at every door that writes them:
 * session create, resume and config, task create, update and batch pin, run receipts. A key runs on
 * every engine its protocol reaches, a DeepSeek key on DeepSeek Harness too; the built-in `dsh` is
 * DeepSeek Harness on the owner's first DeepSeek key; a retired provider name resolves to the key it
 * was folded into; a key in use keeps the protocol its engines need; the sweep holds a run on a
 * runner's sign-in by that sign-in's quota, and never a run on a key. Named in
 * scripts/test-provider-engine-api.mjs; a missing server is a failure, not a skip.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { CreatorType, Prisma, RunStatus, RunnerStatus, TaskStatus } from '@prisma/client';
import { AgentProvider } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { establishProjectContractForPgTest } from '../projects/project-contract-test-helper';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerProvidersController } from '../runner-api/runner-providers.controller';
import { SessionsService } from '../sessions/sessions.service';
import { taskRunDesiredSessionId, taskRunRequestKey } from '../tasks/task-run-identity';
import { TASK_RUN_ACTION } from '../tasks/task-run-receipt';
import { TasksService } from '../tasks/tasks.service';
import { DEEPSEEK_KEY_REQUIRED_MESSAGE } from './engine-provider';
import { encryptSecret } from './provider-crypto';
import { ProvidersService } from './providers.service';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY ??= 'provider-engine-api-spec';
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
const SUBSCRIPTION_TOKEN = 'sk-ant-oat01-subscription';

/** The 4xx a door answers with: its status, and the body's code and message. */
async function refusal(operation: Promise<unknown>): Promise<{ status: number; code?: string; message: string; body: Record<string, unknown> }> {
  try {
    await operation;
  } catch (error) {
    const e = error as { getStatus?: () => number; getResponse?: () => unknown; message: string };
    assert.ok(e.getStatus, `not an HTTP refusal: ${String(error)}`);
    const body = (typeof e.getResponse?.() === 'object' ? e.getResponse!() : {}) as Record<string, unknown>;
    return { status: e.getStatus(), code: body.code as string | undefined, message: e.message, body };
  }
  assert.fail('the door accepted what it should have refused');
}

test('T3 provider-engine API on PostgreSQL', { timeout: 600_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(URL);
  t.after(async () => { await db.$disconnect(); await sql.end(); });

  // The DeepSeek Harness permission policy is P4's, and refuses the account default these fixtures
  // carry; scheduling, keys and PostgreSQL stay real (the seam session-engine-foundation.pg.spec uses).
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
  const prisma = db as unknown as PrismaService;
  const queue = new QueueService(prisma, realtime);
  const sessions = new SessionsService(prisma, queue, realtime);
  const tasks = new TasksService(prisma, sessions, realtime);
  // No credential here reports a quota: the shared list's quota column reads none.
  const providers = new ProvidersService(prisma, realtime, { snapshot: () => null } as never);

  async function account(label: string, role: 'USER' | 'ADMIN' = 'USER') {
    const id = randomUUID();
    await db.user.create({ data: { id, email: `${label}-${id}@engine-api.invalid`, name: label, passwordHash: 'x', role } });
    return id;
  }
  type Machine = { id: string; ownerId: string; workspaceId: string };
  /** A runner of `ownerId`'s with every CLI installed and signed in, and a workspace on it. */
  async function machine(ownerId: string, env?: Record<string, string>): Promise<Machine> {
    const id = randomUUID();
    const workspaceId = randomUUID();
    await db.runner.create({ data: {
      id, ownerId, name: 'engine-api', tokenHash: `x-${id}`, status: RunnerStatus.ONLINE, maxConcurrent: 64,
      capabilities: ['provider:dsh', 'provider:antigravity'], capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(), engines: ENGINES as Prisma.InputJsonValue,
    } });
    await db.workspace.create({ data: {
      id: workspaceId, ownerId, runnerId: id, name: 'engine-api', enabled: true, workDir: '/tmp/engine-api',
      ...(env ? { env } : {}),
    } });
    return { id, ownerId, workspaceId };
  }
  /** A key connected through the door a person uses: its preset decides what it is. */
  async function connect(ownerId: string | null, preset: string, opts: { apiKey?: string; label?: string; baseUrl?: string; slug?: string } = {}) {
    const baseUrls: Record<string, string> = {
      deepseek: 'https://api.deepseek.com/anthropic',
      glm: 'https://api.z.ai/api/anthropic',
      anthropic: 'https://api.anthropic.com',
      openai: 'https://api.openai.com/v1',
      gemini: 'https://generativelanguage.googleapis.com',
      moonshot: 'https://api.moonshot.ai/v1',
    };
    const apiKey = opts.apiKey ?? `sk-${randomUUID()}`;
    const row = await providers.create(ownerId, {
      label: opts.label ?? `${preset} ${randomUUID().slice(0, 6)}`, presetSlug: preset,
      baseUrl: opts.baseUrl ?? baseUrls[preset], apiKey, ...(opts.slug ? { slug: opts.slug } : {}),
    } as never) as { id: string; slug: string; label: string };
    return { id: row.id, slug: row.slug, label: row.label, apiKey };
  }
  const create = (at: Machine, dto: Record<string, unknown>) =>
    sessions.create(at.ownerId, { workspaceId: at.workspaceId, prompt: 'hi', permissionMode: 'default', ...dto } as never);
  const stored = (id: string) => db.session.findUniqueOrThrow({
    where: { id }, select: { engine: true, provider: true, providerBuiltin: true },
  });
  /** A runner of every engine asking for work, one that takes over a revived session's handoff too. */
  const claim = (at: Machine) => queue.claimSessionForRunner({ id: at.id, supportedProviders: ALL }, 0, true);
  async function claimed(at: Machine, sessionId: string) {
    const job = await claim(at);
    assert.equal(job?.sessionId, sessionId, `the runner was handed ${job?.sessionId ?? 'nothing'}, not ${sessionId}`);
    return job!;
  }
  /** A claimed run that did a turn and then failed: there is a conversation to resume. */
  const ranAndFailed = (id: string) => db.session.update({ where: { id }, data: {
    status: RunStatus.FAILED, numTurns: 1, runtimeSessionId: `runtime-${randomUUID()}`, startedAt: new Date(),
    finishedAt: new Date(), inboxLeaseOwner: null, inboxLeaseGeneration: null,
  } });
  const resume = (ownerId: string, id: string, dto: Record<string, unknown> = {}) =>
    sessions.resume(ownerId, id, { content: 'again', clientTurnId: randomUUID(), ...dto } as never);
  const TASK_CHECK = { completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0 } as const;
  const pins = (id: string) => db.task.findUniqueOrThrow({ where: { id }, select: { engine: true, provider: true, model: true } });

  await t.test('T3 one DeepSeek key runs Claude Code, OpenCode and DeepSeek Harness sessions, created, resumed and claimed each with its own variables', async () => {
    const owner = await account('one-key');
    const at = await machine(owner);
    const ds = await connect(owner, 'deepseek');
    const created = new Map<AgentProvider, string>();
    for (const engine of [AgentProvider.CLAUDE, AgentProvider.OPENCODE, AgentProvider.DSH]) {
      const session = await create(at, {
        engine, provider: ds.slug, ...(engine === AgentProvider.DSH ? {} : { model: 'deepseek-v4-flash' }),
      });
      assert.deepEqual(await stored(session.id), { engine, provider: ds.slug, providerBuiltin: false });
      created.set(engine, session.id);
    }
    const inject = (engine: AgentProvider, job: Awaited<ReturnType<typeof claimed>>) => {
      assert.equal(job.provider, engine, `the ${engine} session is spawned on its engine`);
      if (engine === AgentProvider.CLAUDE) {
        assert.equal(job.agent.env?.ANTHROPIC_AUTH_TOKEN, ds.apiKey);
        assert.equal(job.agent.env?.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
        assert.equal(job.agent.model, 'deepseek-v4-flash');
      } else if (engine === AgentProvider.OPENCODE) {
        assert.equal(job.agent.model, `orbit-${ds.slug}/deepseek-v4-flash`);
        const config = JSON.parse(job.agent.env?.OPENCODE_CONFIG_CONTENT ?? '{}');
        assert.equal(config.provider[`orbit-${ds.slug}`].options.apiKey, ds.apiKey);
        assert.equal(job.agent.env?.ANTHROPIC_AUTH_TOKEN, undefined);
      } else {
        assert.equal(job.agent.env?.ORBIT_DSH_API_KEY, ds.apiKey);
        assert.equal(job.agent.env?.ORBIT_DSH_BASE_URL, 'https://api.deepseek.com/anthropic');
        assert.equal(job.agent.env?.ANTHROPIC_AUTH_TOKEN, undefined);
      }
    };
    for (const [engine, id] of created) inject(engine, await claimed(at, id));
    // Each one ran, failed, and is resumed: on its own engine and the same key, injected the same way.
    for (const [engine, id] of created) {
      await ranAndFailed(id);
      await resume(owner, id);
      assert.deepEqual(await stored(id), { engine, provider: ds.slug, providerBuiltin: false });
      inject(engine, await claimed(at, id));
    }
  });

  await t.test('T3 DeepSeek Harness runs on either of two DeepSeek keys, created on one and switched to the other, and on no other key', async () => {
    const owner = await account('two-keys');
    const at = await machine(owner);
    const first = await connect(owner, 'deepseek');
    const second = await connect(owner, 'deepseek');
    const glm = await connect(owner, 'glm');
    const onSecond = await create(at, { engine: AgentProvider.DSH, provider: second.slug });
    assert.deepEqual(await stored(onSecond.id), { engine: AgentProvider.DSH, provider: second.slug, providerBuiltin: false });
    assert.equal((await claimed(at, onSecond.id)).agent.env?.ORBIT_DSH_API_KEY, second.apiKey);

    const session = await create(at, { engine: AgentProvider.DSH, provider: first.slug });
    assert.equal((await claimed(at, session.id)).agent.env?.ORBIT_DSH_API_KEY, first.apiKey);
    await ranAndFailed(session.id);
    await resume(owner, session.id, { provider: second.slug });
    assert.deepEqual(await stored(session.id), { engine: AgentProvider.DSH, provider: second.slug, providerBuiltin: false });
    assert.equal((await claimed(at, session.id)).agent.env?.ORBIT_DSH_API_KEY, second.apiKey, 'the switch reached the claim');

    // A key DeepSeek Harness cannot run is refused, and the session stays where it was.
    await ranAndFailed(session.id);
    const refused = await refusal(resume(owner, session.id, { provider: glm.slug }));
    assert.equal(refused.code, 'PROVIDER_ENGINE_INCOMPATIBLE');
    assert.equal(refused.message, `provider "${glm.slug}" cannot run on DeepSeek Harness; it runs on Claude Code, OpenCode`);
    assert.deepEqual(await stored(session.id), { engine: AgentProvider.DSH, provider: second.slug, providerBuiltin: false });
  });

  await t.test('T3 a provider alone, an engine alone, both, or neither each resolve to one engine and one credential', async () => {
    const owner = await account('four-ways');
    const at = await machine(owner);
    const ds = await connect(owner, 'deepseek');
    const codexKey = await connect(owner, 'openai');
    // A provider alone runs on the engine it ran on before the split.
    assert.deepEqual(await stored((await create(at, { provider: codexKey.slug, model: 'gpt-5.1' })).id),
      { engine: AgentProvider.CODEX, provider: codexKey.slug, providerBuiltin: false });
    assert.deepEqual(await stored((await create(at, { provider: ds.slug, model: 'deepseek-v4-flash' })).id),
      { engine: AgentProvider.CLAUDE, provider: ds.slug, providerBuiltin: false });
    // An engine alone runs on its own credential: a sign-in, OpenCode's own config, the default DeepSeek key.
    assert.deepEqual(await stored((await create(at, { engine: AgentProvider.CODEX })).id),
      { engine: AgentProvider.CODEX, provider: AgentProvider.CODEX, providerBuiltin: true });
    assert.deepEqual(await stored((await create(at, { engine: AgentProvider.OPENCODE })).id),
      { engine: AgentProvider.OPENCODE, provider: AgentProvider.OPENCODE, providerBuiltin: true });
    assert.deepEqual(await stored((await create(at, { engine: AgentProvider.DSH })).id),
      { engine: AgentProvider.DSH, provider: ds.slug, providerBuiltin: false });
    // Both, checked against each other.
    const both = await create(at, { engine: AgentProvider.OPENCODE, provider: codexKey.slug, model: 'gpt-5.1' });
    assert.deepEqual(await stored(both.id), { engine: AgentProvider.OPENCODE, provider: codexKey.slug, providerBuiltin: false });
    // Neither: where the workspace last started — that last session, on its engine and its credential.
    const neither = await create(at, {});
    assert.deepEqual(await stored(neither.id), { engine: AgentProvider.OPENCODE, provider: codexKey.slug, providerBuiltin: false });
    // An engine nobody has heard of is refused by name.
    const unknown = await refusal(create(at, { engine: 'gpt' }));
    assert.equal(unknown.code, 'ENGINE_UNKNOWN');
    assert.equal(unknown.message, 'engine "gpt" is not one of claude, codex, kimi, antigravity, opencode, dsh');
  });

  await t.test('T3 incompatible pairs are refused and write nothing: DeepSeek Harness on a GLM key, OpenCode on a subscription token, Claude Code on a Gemini key', async () => {
    const owner = await account('incompatible');
    const at = await machine(owner);
    const glm = await connect(owner, 'glm');
    const subscription = await connect(owner, 'anthropic', { apiKey: SUBSCRIPTION_TOKEN });
    const gemini = await connect(owner, 'gemini');
    for (const [engine, key, message, engines] of [
      [AgentProvider.DSH, glm.slug, `provider "${glm.slug}" cannot run on DeepSeek Harness; it runs on Claude Code, OpenCode`,
        [AgentProvider.CLAUDE, AgentProvider.OPENCODE]],
      [AgentProvider.OPENCODE, subscription.slug, `provider "${subscription.slug}" cannot run on OpenCode; it runs on Claude Code`,
        [AgentProvider.CLAUDE]],
      [AgentProvider.CLAUDE, gemini.slug, `provider "${gemini.slug}" cannot run on Claude Code; it runs on Antigravity CLI, OpenCode`,
        [AgentProvider.ANTIGRAVITY, AgentProvider.OPENCODE]],
    ] as const) {
      const refused = await refusal(create(at, { engine, provider: key }));
      assert.equal(refused.status, 400);
      assert.equal(refused.code, 'PROVIDER_ENGINE_INCOMPATIBLE');
      assert.equal(refused.message, message);
      assert.deepEqual({ engine: refused.body.engine, provider: refused.body.provider, engines: refused.body.engines },
        { engine, provider: key, engines });
    }
    assert.equal(await db.session.count({ where: { workspaceId: at.workspaceId } }), 0, 'a refused pair wrote a session');
  });

  await t.test("T3 a session's credential moves only within what its engine runs, and its engine never changes", async () => {
    const owner = await account('switch');
    const at = await machine(owner);
    const ds = await connect(owner, 'deepseek');
    const glm = await connect(owner, 'glm');
    const codexKey = await connect(owner, 'openai');
    const session = await create(at, { provider: ds.slug, model: 'deepseek-v4-flash' });
    // Another key Claude Code runs: moved.
    await sessions.updateConfig(owner, session.id, { provider: glm.slug, model: 'glm-5.2' } as never);
    assert.deepEqual(await stored(session.id), { engine: AgentProvider.CLAUDE, provider: glm.slug, providerBuiltin: false });
    // Claude Code's own sign-in: moved.
    await sessions.updateConfig(owner, session.id, { provider: AgentProvider.CLAUDE } as never);
    assert.deepEqual(await stored(session.id), { engine: AgentProvider.CLAUDE, provider: AgentProvider.CLAUDE, providerBuiltin: true });
    // A key, or a sign-in, of another engine: refused, the session where it was.
    const onCodexKey = await refusal(sessions.updateConfig(owner, session.id, { provider: codexKey.slug } as never));
    assert.equal(onCodexKey.message, `provider "${codexKey.slug}" cannot run on Claude Code; it runs on Codex, OpenCode`);
    const onCodexLogin = await refusal(sessions.updateConfig(owner, session.id, { provider: AgentProvider.CODEX } as never));
    assert.equal(onCodexLogin.message, 'provider "codex" cannot run on Claude Code; it runs on Codex');
    // Another engine, however it is asked for.
    const immutable = await refusal(sessions.updateConfig(owner, session.id, { engine: AgentProvider.OPENCODE, provider: ds.slug } as never));
    assert.equal(immutable.code, 'ENGINE_IMMUTABLE');
    assert.equal(immutable.message,
      "this session runs on Claude Code, and a session's engine never changes; start a new session to use OpenCode");
    assert.equal((await refusal(sessions.updateConfig(owner, session.id, { engine: AgentProvider.CODEX } as never))).code, 'ENGINE_IMMUTABLE');
    await ranAndFailed(session.id);
    assert.equal((await refusal(resume(owner, session.id, { engine: AgentProvider.DSH }))).code, 'ENGINE_IMMUTABLE');
    assert.deepEqual(await stored(session.id), { engine: AgentProvider.CLAUDE, provider: AgentProvider.CLAUDE, providerBuiltin: true });
    // Its own engine named again is no change at all.
    assert.equal((await refusal(sessions.updateConfig(owner, session.id, { engine: AgentProvider.CLAUDE } as never))).message, 'nothing to update');
    // An OpenCode session moves between the keys OpenCode runs, whatever their protocols.
    const openCode = await create(at, { engine: AgentProvider.OPENCODE, provider: codexKey.slug, model: 'gpt-5.1' });
    await sessions.updateConfig(owner, openCode.id, { provider: ds.slug, model: 'deepseek-v4-flash' } as never);
    assert.deepEqual(await stored(openCode.id), { engine: AgentProvider.OPENCODE, provider: ds.slug, providerBuiltin: false });
  });

  await t.test('T3 a key in use cannot change its protocol, endpoint or secret out from under an engine it runs, and never becomes dsh', async () => {
    const owner = await account('dialect');
    const at = await machine(owner);
    // A DeepSeek key of no preset: DeepSeek's by its endpoint, so the endpoint is what makes it one.
    const ds = await providers.create(owner, {
      label: 'My DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-dialect', models: [{ value: 'deepseek-v4-flash', label: 'Flash' }],
    } as never) as { id: string; slug: string };
    const harness = await create(at, { engine: AgentProvider.DSH, provider: ds.slug });
    const pinned = await tasks.create(owner, { title: 'on OpenCode', engine: AgentProvider.OPENCODE, provider: ds.slug, ...TASK_CHECK } as never);
    const inUse = (what: string) =>
      `provider "My DeepSeek" is in use on DeepSeek Harness by 1 open sessions and 0 task pins; its ${what} can't change while they use it`;
    for (const [edit, what] of [
      [{ runtime: 'codex' }, 'protocol'],
      [{ baseUrl: 'https://api.example.test/anthropic' }, 'endpoint'],
      [{ apiKey: SUBSCRIPTION_TOKEN }, 'key'],
    ] as const) {
      const refused = await refusal(providers.update(owner, ds.id, edit as never));
      assert.equal(refused.status, 409);
      assert.equal(refused.code, 'PROVIDER_DIALECT_IN_USE');
      // Codex's protocol and another endpoint both keep OpenCode, so only the Harness session is
      // stranded; a subscription token, which only Claude Code runs, strands the OpenCode pin too.
      if (what === 'key') {
        assert.equal(refused.message,
          'provider "My DeepSeek" is in use on DeepSeek Harness, OpenCode by 1 open sessions and 1 task pins; its key can\'t change while they use it');
      } else {
        assert.equal(refused.message, inUse(what));
      }
    }
    const retired = await refusal(providers.update(owner, ds.id, { runtime: 'dsh' } as never));
    assert.equal(retired.code, 'PROVIDER_RUNTIME_DSH_RETIRED');
    assert.equal(retired.message,
      'DeepSeek Harness is an engine now, not a kind of provider: keep the key as DeepSeek, then pick DeepSeek Harness as the engine');
    assert.deepEqual(await db.modelProvider.findUniqueOrThrow({ where: { id: ds.id }, select: { runtime: true, baseUrl: true } }),
      { runtime: 'claude', baseUrl: 'https://api.deepseek.com/anthropic' }, 'a refused edit wrote something');
    // An edit every engine using it survives is taken: another DeepSeek key.
    await providers.update(owner, ds.id, { apiKey: 'sk-dialect-rotated' } as never);
    // Once nothing uses it on DeepSeek Harness, the protocol may move.
    await db.session.update({ where: { id: harness.id }, data: { completedAt: new Date(), status: RunStatus.CANCELLED } });
    await db.task.update({ where: { id: pinned.id }, data: { status: TaskStatus.CANCELLED } });
    await providers.update(owner, ds.id, { runtime: 'codex' } as never);
    assert.equal((await db.modelProvider.findUniqueOrThrow({ where: { id: ds.id } })).runtime, 'codex');
    assert.equal((await stored(harness.id)).engine, AgentProvider.DSH, 'the edit never moved the session that used it');
  });

  await t.test('T3 a key usage read counts open sessions and task pins per engine, and only for its owner', async () => {
    const owner = await account('usage');
    const other = await account('usage-other');
    const at = await machine(owner);
    const ds = await connect(owner, 'deepseek');
    await create(at, { engine: AgentProvider.CLAUDE, provider: ds.slug, model: 'deepseek-v4-flash' });
    await create(at, { engine: AgentProvider.OPENCODE, provider: ds.slug, model: 'deepseek-v4-flash' });
    await create(at, { engine: AgentProvider.DSH, provider: ds.slug });
    const ended = await create(at, { engine: AgentProvider.CLAUDE, provider: ds.slug, model: 'deepseek-v4-flash' });
    await db.session.update({ where: { id: ended.id }, data: { completedAt: new Date(), status: RunStatus.CANCELLED } });
    // A session an older client opened in OpenCode's old encoding names the key by its model.
    await db.session.create({ data: {
      title: 'old encoding', prompt: '', ownerId: owner, creatorId: owner, workspaceId: at.workspaceId,
      assignedRunnerId: at.id, provider: AgentProvider.OPENCODE, providerBuiltin: true,
      model: `orbit-${ds.slug}/deepseek-v4-flash`, status: RunStatus.AWAITING_INPUT,
    } });
    await tasks.create(owner, { title: 'pinned on Harness', engine: AgentProvider.DSH, provider: ds.slug, ...TASK_CHECK } as never);
    const done = await tasks.create(owner, { title: 'finished', provider: ds.slug, ...TASK_CHECK } as never);
    await db.task.update({ where: { id: done.id }, data: { status: TaskStatus.DONE } });

    assert.deepEqual(await providers.usage(owner, ds.id), {
      providerId: ds.id,
      engines: [
        { engine: AgentProvider.CLAUDE, sessions: 1, tasks: 0 },
        { engine: AgentProvider.DSH, sessions: 1, tasks: 1 },
        { engine: AgentProvider.OPENCODE, sessions: 2, tasks: 0 },
      ],
      sessions: 4,
      tasks: 1,
    });
    // Another account's key reads as not found — the same answer as a key that does not exist.
    const theirs = await refusal(providers.usage(other, ds.id));
    assert.equal(theirs.status, 404);
    assert.equal((await refusal(providers.usage(owner, randomUUID()))).status, 404);
  });

  await t.test('T3 task engine and provider pins are written together and checked, one by one and in bulk', async () => {
    const owner = await account('pins');
    await machine(owner);
    const ds = await connect(owner, 'deepseek');
    const glm = await connect(owner, 'glm');
    const codexKey = await connect(owner, 'openai');
    const make = (dto: Record<string, unknown>) => tasks.create(owner, { title: `pins ${randomUUID()}`, ...TASK_CHECK, ...dto } as never);
    // Both, checked; a provider alone with its default engine; an engine alone; the built-in dsh.
    assert.deepEqual(await pins((await make({ engine: AgentProvider.OPENCODE, provider: codexKey.slug })).id),
      { engine: AgentProvider.OPENCODE, provider: codexKey.slug, model: null });
    const providerOnly = await make({ provider: codexKey.slug });
    assert.deepEqual(await pins(providerOnly.id), { engine: AgentProvider.CODEX, provider: codexKey.slug, model: null });
    assert.deepEqual(await pins((await make({ engine: AgentProvider.KIMI })).id), { engine: AgentProvider.KIMI, provider: null, model: null });
    assert.deepEqual(await pins((await make({ provider: AgentProvider.DSH })).id), { engine: AgentProvider.DSH, provider: ds.slug, model: null });
    const refused = await refusal(make({ engine: AgentProvider.DSH, provider: glm.slug }));
    assert.equal(refused.code, 'PROVIDER_ENGINE_INCOMPATIBLE');
    // An update: the engine alone is checked against the provider kept; null clears one pin only.
    assert.equal((await refusal(tasks.update(owner, providerOnly.id, { engine: AgentProvider.CLAUDE } as never))).message,
      `provider "${codexKey.slug}" cannot run on Claude Code; it runs on Codex, OpenCode`);
    await tasks.update(owner, providerOnly.id, { engine: AgentProvider.OPENCODE } as never);
    assert.deepEqual(await pins(providerOnly.id), { engine: AgentProvider.OPENCODE, provider: codexKey.slug, model: null });
    await tasks.update(owner, providerOnly.id, { engine: null } as never);
    assert.deepEqual(await pins(providerOnly.id), { engine: null, provider: codexKey.slug, model: null });
    await tasks.update(owner, providerOnly.id, { engine: AgentProvider.CODEX, provider: null } as never);
    assert.deepEqual(await pins(providerOnly.id), { engine: AgentProvider.CODEX, provider: null, model: null });

    // In bulk: an engine alone is checked against every provider pin the selection holds, and refuses
    // the whole batch over one, naming it; a pin that fits all is written to all.
    const list = await db.taskList.create({ data: { ownerId: owner, title: 'bulk' }, select: { id: true } });
    const onCodex = await make({ listId: list.id, provider: codexKey.slug });
    const onDeepSeek = await make({ listId: list.id, provider: ds.slug });
    const unpinned = await make({ listId: list.id });
    const batch = await refusal(tasks.pinMany(owner, { listId: list.id, engine: AgentProvider.DSH } as never));
    assert.equal(batch.code, 'PROVIDER_ENGINE_INCOMPATIBLE');
    assert.deepEqual(batch.body.incompatible, [{ provider: codexKey.slug, tasks: 1, engines: [AgentProvider.CODEX, AgentProvider.OPENCODE] }]);
    assert.deepEqual((await pins(onDeepSeek.id)).engine, AgentProvider.CLAUDE, 'a refused batch wrote a row');
    assert.deepEqual(await tasks.pinMany(owner, { listId: list.id, engine: AgentProvider.OPENCODE } as never), { changed: 3 });
    for (const [id, provider] of [[onCodex.id, codexKey.slug], [onDeepSeek.id, ds.slug], [unpinned.id, null]] as const) {
      assert.deepEqual(await pins(id), { engine: AgentProvider.OPENCODE, provider, model: null });
    }
    // Both named, refused once before anything is written; a provider alone takes its default engine.
    assert.equal((await refusal(tasks.pinMany(owner, { listId: list.id, engine: AgentProvider.DSH, provider: glm.slug } as never))).code,
      'PROVIDER_ENGINE_INCOMPATIBLE');
    assert.deepEqual(await tasks.pinMany(owner, { listId: list.id, provider: glm.slug } as never), { changed: 3 });
    assert.deepEqual(await pins(unpinned.id), { engine: AgentProvider.CLAUDE, provider: glm.slug, model: null });
  });

  await t.test('T3 a run receipt is v3, and a v2 one bound before the split runs on the engine pin beside it', async () => {
    const owner = await account('receipts');
    const at = await machine(owner);
    const projectId = randomUUID();
    await db.project.create({ data: { id: projectId, ownerId: owner, title: 'receipts', coordinatorEnabled: false } });
    const codexKey = await connect(owner, 'openai');
    const task = async () => (await db.task.create({ data: {
      ownerId: owner, projectId, assigneeId: at.workspaceId, title: 'pinned on OpenCode', creatorType: CreatorType.USER,
      creatorId: owner, completionCriterion: 'EVIDENCE_JUDGMENT', engine: AgentProvider.OPENCODE, provider: codexKey.slug,
      model: 'gpt-5.1',
    } })).id;
    const receipt = async (token: string) => (await db.$queryRaw<Array<{ status: string; target: Record<string, unknown> }>>`
      SELECT "status", "target" FROM "task_run_request"
       WHERE "owner_id" = ${owner}::uuid AND "action_kind" = ${TASK_RUN_ACTION.execute} AND "request_token" = ${token}`)[0];
    const desiredIdFor = (taskId: string, token: string) => taskRunDesiredSessionId(taskRunRequestKey({ taskId, requestToken: token }));

    // A fresh press freezes a v3 target naming the engine pin, and the run is created on it.
    const fresh = await task();
    const press = randomUUID();
    const run = await tasks.execute(owner, fresh, undefined, press);
    const bound = await receipt(press);
    assert.equal(bound.target.v, 3);
    assert.deepEqual({ engine: bound.target.engine, provider: bound.target.provider }, { engine: AgentProvider.OPENCODE, provider: codexKey.slug });
    assert.deepEqual(await stored(run.sessionId!), { engine: AgentProvider.OPENCODE, provider: codexKey.slug, providerBuiltin: false });

    // A v2 target an older replica bound for the same pins, and died on: taken over, it runs on the
    // task's engine pin, since its provider is the task's own provider pin (§6.4)…
    const v2 = (taskId: string, token: string, provider: string) => ({
      v: 2, kind: 'RUN', plan: { kind: 'CREATE', sessionId: desiredIdFor(taskId, token) }, taskId, title: 'v2', prompt: 'do it',
      workspaceId: at.workspaceId, runnerId: at.id, provider, model: 'gpt-5.1', effort: null, route: null, projectId,
      batch: null, dispatchOrigin: 'USER', runSource: 'MANUAL', runAt: null, clearFailed: false, auto: false,
    });
    const bind = (taskId: string, token: string, target: unknown) => db.$executeRaw`
      INSERT INTO "task_run_request" ("owner_id", "action_kind", "request_token", "fingerprint", "status", "target",
                                      "bound_at", "lease_holder", "lease_expires_at", "attempt")
      VALUES (${owner}::uuid, ${TASK_RUN_ACTION.execute}, ${token}, ${`task:${taskId}`}, 'BOUND', ${JSON.stringify(target)}::jsonb,
              statement_timestamp(), 'dead-holder', statement_timestamp() - make_interval(secs => 1), 1)`;
    const mixed = await task();
    const mixedPress = randomUUID();
    await bind(mixed, mixedPress, v2(mixed, mixedPress, codexKey.slug));
    const takenOver = await tasks.execute(owner, mixed, undefined, mixedPress);
    assert.equal(takenOver.sessionId, desiredIdFor(mixed, mixedPress));
    assert.deepEqual(await stored(takenOver.sessionId!), { engine: AgentProvider.OPENCODE, provider: codexKey.slug, providerBuiltin: false });
    // …and one naming another credential runs where that credential alone runs, as it was bound to.
    const other = await task();
    const otherPress = randomUUID();
    await bind(other, otherPress, { ...v2(other, otherPress, AgentProvider.CLAUDE), model: null });
    const onLogin = await tasks.execute(owner, other, undefined, otherPress);
    assert.deepEqual(await stored(onLogin.sessionId!), { engine: AgentProvider.CLAUDE, provider: AgentProvider.CLAUDE, providerBuiltin: true });
  });

  await t.test("T3 the built-in dsh is DeepSeek Harness on the first enabled DeepSeek key, or refused, and a workspace key's sessions keep theirs", async () => {
    const keyless = await account('no-deepseek');
    const bare = await machine(keyless);
    await connect(keyless, 'glm');
    for (const dto of [{ provider: AgentProvider.DSH }, { engine: AgentProvider.DSH }]) {
      const refused = await refusal(create(bare, dto));
      assert.equal(refused.status, 400);
      assert.equal(refused.code, 'DEEPSEEK_KEY_REQUIRED');
      assert.equal(refused.message, DEEPSEEK_KEY_REQUIRED_MESSAGE);
    }
    assert.equal((await refusal(tasks.create(keyless, { title: 'dsh', provider: AgentProvider.DSH, ...TASK_CHECK } as never))).code,
      'DEEPSEEK_KEY_REQUIRED');

    const owner = await account('default-key');
    const at = await machine(owner);
    await connect(owner, 'glm');
    await connect(owner, 'anthropic', { apiKey: SUBSCRIPTION_TOKEN });
    const first = await connect(owner, 'deepseek');
    const placed = await connect(owner, 'deepseek');
    // The picker's order: a placed key before an unplaced one, whenever it was connected.
    await db.modelProvider.update({ where: { id: placed.id }, data: { position: 0 } });
    const onPlaced = await create(at, { provider: AgentProvider.DSH });
    assert.deepEqual(await stored(onPlaced.id), { engine: AgentProvider.DSH, provider: placed.slug, providerBuiltin: false });
    await providers.update(owner, placed.id, { enabled: false } as never);
    assert.deepEqual(await stored((await create(at, { provider: AgentProvider.DSH })).id),
      { engine: AgentProvider.DSH, provider: first.slug, providerBuiltin: false });

    // Sessions of the built-in dsh from before the split: one in a workspace holding its own key keeps
    // it — resumed, it is still that key's — and one in a workspace without runs on the default key.
    const withKey = await machine(owner, { ORBIT_DSH_API_KEY: 'workspace-own-key' });
    const legacy = async (on: Machine) => (await db.session.create({ data: {
      title: 'legacy dsh', prompt: '', ownerId: owner, creatorId: owner, workspaceId: on.workspaceId, assignedRunnerId: on.id,
      provider: AgentProvider.DSH, providerBuiltin: true, engine: AgentProvider.DSH, status: RunStatus.FAILED, numTurns: 1,
      runtimeSessionId: `runtime-${randomUUID()}`, startedAt: new Date(), finishedAt: new Date(),
    } })).id;
    const kept = await legacy(withKey);
    await resume(owner, kept);
    assert.deepEqual(await stored(kept), { engine: AgentProvider.DSH, provider: AgentProvider.DSH, providerBuiltin: true });
    assert.equal((await claimed(withKey, kept)).agent.env?.ORBIT_DSH_API_KEY, 'workspace-own-key');
    const without = await machine(owner);
    const filled = await legacy(without);
    await resume(owner, filled);
    assert.equal((await claimed(without, filled)).agent.env?.ORBIT_DSH_API_KEY, first.apiKey);
  });

  await t.test('T3 a retired provider name resolves to its key, holds its slug in every table, and goes with the key', async () => {
    const owner = await account('alias');
    const at = await machine(owner);
    const key = await connect(owner, 'deepseek');
    const retired = `deepseek-harness-${randomUUID().slice(0, 8)}`;
    await db.providerSlugAlias.create({ data: { slug: retired, providerId: key.id, engine: AgentProvider.DSH, reason: 'RENAMED' } });
    // One slug namespace across the three tables (0265, widened by 0415).
    const taken = (write: Promise<unknown>) => assert.rejects(write, (error: { code?: string }) => error.code === 'P2002');
    await taken(db.modelProvider.create({ data: { slug: retired, label: 'x', baseUrl: 'https://api.example.test', apiKeyEnc: encryptSecret('x'), ownerId: owner } }));
    await taken(db.providerPool.create({ data: { slug: retired, label: 'x', ownerId: owner, engine: 'claude' } }));
    await taken(db.providerSlugAlias.create({ data: { slug: key.slug, providerId: key.id, engine: AgentProvider.DSH, reason: 'MERGED' } }));
    const named = await connect(owner, 'deepseek', { slug: retired });
    assert.notEqual(named.slug, retired, 'a new key took a retired name');

    // Named alone, it is the key on the engine the name ran on; named with an engine, that engine.
    // Either way the session stores the key's own slug.
    assert.deepEqual(await stored((await create(at, { provider: retired })).id),
      { engine: AgentProvider.DSH, provider: key.slug, providerBuiltin: false });
    assert.deepEqual(await stored((await create(at, { engine: AgentProvider.CLAUDE, provider: retired, model: 'deepseek-v4-flash' })).id),
      { engine: AgentProvider.CLAUDE, provider: key.slug, providerBuiltin: false });
    const pinned = await tasks.create(owner, { title: 'by the old name', provider: retired, ...TASK_CHECK } as never);
    assert.deepEqual(await pins(pinned.id), { engine: AgentProvider.DSH, provider: key.slug, model: null });
    // A session an older replica wrote under the old name is claimed on the key it names now.
    const elsewhere = await machine(owner);
    const written = await db.session.create({ data: {
      title: 'old name', prompt: '', ownerId: owner, creatorId: owner, workspaceId: elsewhere.workspaceId,
      assignedRunnerId: elsewhere.id, provider: retired, providerBuiltin: false, engine: AgentProvider.DSH,
      status: RunStatus.PENDING,
    } });
    assert.equal((await claimed(elsewhere, written.id)).agent.env?.ORBIT_DSH_API_KEY, key.apiKey);

    // Deleting the key deletes its names, which frees each one.
    await providers.remove(owner, key.id);
    assert.equal(await db.providerSlugAlias.count({ where: { slug: retired } }), 0);
    await db.modelProvider.create({ data: { slug: retired, label: 'x', baseUrl: 'https://api.example.test', apiKeyEnc: encryptSecret('x'), ownerId: owner } });
  });

  await t.test('T3 /providers, /providers/mine and /runner/providers carry the engines each credential runs on', async () => {
    const admin = await account('providers-admin', 'ADMIN');
    const owner = await account('providers');
    const ds = await connect(owner, 'deepseek');
    const glm = await connect(owner, 'glm');
    const subscription = await connect(owner, 'anthropic', { apiKey: SUBSCRIPTION_TOKEN });
    const codexKey = await connect(owner, 'openai');
    const gemini = await connect(owner, 'gemini');
    const kimi = await connect(owner, 'moonshot');
    const legacy = await db.modelProvider.create({ data: {
      slug: `harness-${randomUUID().slice(0, 8)}`, label: 'Harness', runtime: 'dsh', presetSlug: 'deepseek-harness',
      baseUrl: 'https://api.deepseek.com/anthropic', apiKeyEnc: encryptSecret('sk-legacy'), ownerId: owner,
    } });
    const pool = await db.providerPool.create({ data: { slug: `pool-${randomUUID().slice(0, 8)}`, label: 'Pool', ownerId: owner, engine: 'codex' } });
    const want = new Map<string, AgentProvider[]>([
      [ds.slug, [AgentProvider.CLAUDE, AgentProvider.OPENCODE, AgentProvider.DSH]],
      [glm.slug, [AgentProvider.CLAUDE, AgentProvider.OPENCODE]],
      [subscription.slug, [AgentProvider.CLAUDE]],
      [codexKey.slug, [AgentProvider.CODEX, AgentProvider.OPENCODE]],
      [gemini.slug, [AgentProvider.ANTIGRAVITY, AgentProvider.OPENCODE]],
      [kimi.slug, [AgentProvider.KIMI, AgentProvider.OPENCODE]],
      [legacy.slug, [AgentProvider.DSH, AgentProvider.CLAUDE, AgentProvider.OPENCODE]],
    ]);
    // The picker's list, and the management one: runtime and runsOnOpenCode stay for older clients.
    const picker = await providers.listPublic(owner) as unknown as Array<{ slug: string; engines: string[]; runsOnOpenCode: boolean }>;
    const mine = await providers.listMine(owner) as unknown as Array<{ slug: string; engines: string[]; runtime: string }>;
    for (const [slug, engines] of want) {
      const row = picker.find((r) => r.slug === slug);
      assert.deepEqual(row?.engines, engines, `/providers: ${slug}`);
      assert.equal(row?.runsOnOpenCode, engines.includes(AgentProvider.OPENCODE), `/providers runsOnOpenCode: ${slug}`);
      assert.deepEqual(mine.find((r) => r.slug === slug)?.engines, engines, `/providers/mine: ${slug}`);
    }
    assert.equal(mine.find((r) => r.slug === legacy.slug)?.runtime, 'dsh');
    // The list an agent picks from: every key's engines, a pool's, and each sign-in's own.
    const usable = await new RunnerProvidersController(providers).list({ ownerId: owner } as never) as unknown as Array<{ slug: string; engines: string[]; builtin: boolean }>;
    for (const [slug, engines] of want) assert.deepEqual(usable.find((r) => r.slug === slug)?.engines, engines, `/runner/providers: ${slug}`);
    assert.deepEqual(usable.find((r) => r.slug === pool.slug)?.engines, [AgentProvider.CODEX]);
    assert.deepEqual(usable.find((r) => r.slug === AgentProvider.CLAUDE && r.builtin)?.engines, [AgentProvider.CLAUDE]);
    // The shared list, an admin's own keys.
    const shared = await connect(null, 'deepseek');
    const listed = await providers.listPublic(admin) as unknown as Array<{ slug: string; engines: string[] }>;
    assert.deepEqual(listed.find((r) => r.slug === shared.slug)?.engines, [AgentProvider.CLAUDE, AgentProvider.OPENCODE, AgentProvider.DSH]);
  });

  await t.test('T3 the sweep runs a task on its own key while the runner reports its engine sign-in spent, and holds one on that sign-in', async () => {
    const owner = await account('quota');
    const runnerId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    // Claude Code's week is spent on the runner: its own sign-in can start nothing until it resets.
    await db.runner.create({ data: {
      id: runnerId, ownerId: owner, name: 'quota', tokenHash: `x-${runnerId}`, status: RunnerStatus.ONLINE, maxConcurrent: 10,
      lastHeartbeatAt: new Date(), capabilities: [], capabilitiesReportedAt: new Date(),
      engines: [{ engine: 'claude', installed: true, auth: 'yes' }] as Prisma.InputJsonValue,
      planUsage: { claude: { sevenDay: { utilization: 100, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() } } },
    } });
    await db.workspace.create({ data: { id: agentId, ownerId: owner, runnerId, name: 'quota-agent', enabled: true } });
    await db.project.create({ data: {
      id: projectId, ownerId: owner, title: 'quota', coordinatorEnabled: false, maxConcurrentTasks: 10, startedAt: new Date(),
    } });
    await establishProjectContractForPgTest(db, owner, projectId, 'quota');
    const key = await connect(owner, 'glm');
    const ready = async (pin: { engine: string; provider: string }) => {
      const base = { ownerId: owner, projectId, assigneeId: agentId, creatorType: CreatorType.USER, creatorId: owner,
        completionCriterion: 'EVIDENCE_JUDGMENT' as const };
      const prerequisite = await db.task.create({ data: { ...base, title: 'done first', status: TaskStatus.DONE, autoRunWhenReady: false } });
      const task = await db.task.create({ data: { ...base, title: `on ${pin.provider}`, autoRunWhenReady: true, ...pin } });
      await db.taskDependency.create({ data: { taskId: task.id, dependsOnTaskId: prerequisite.id } });
      return task.id;
    };
    const onKey = await ready({ engine: AgentProvider.CLAUDE, provider: key.slug });
    const onSignIn = await ready({ engine: AgentProvider.CLAUDE, provider: AgentProvider.CLAUDE });

    await (tasks as unknown as { reconcileReadyTasks(): Promise<void> }).reconcileReadyTasks();

    const runs = (taskId: string) => db.session.findMany({
      where: { taskId, startsTaskWork: true }, select: { engine: true, provider: true, providerBuiltin: true },
    });
    assert.deepEqual(await runs(onKey), [{ engine: AgentProvider.CLAUDE, provider: key.slug, providerBuiltin: false }],
      "a run on its own key was held by the runner's report on Claude Code's sign-in");
    assert.deepEqual(await runs(onSignIn), [], "a run on the spent sign-in was started anyway");
  });
});

