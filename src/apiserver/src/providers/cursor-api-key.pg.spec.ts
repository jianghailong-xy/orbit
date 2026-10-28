/**
 * A Cursor API key saved in Orbit, on a real PostgreSQL (project P2; docs/cursor-runtime-contract.md §9,
 * §16.2, §16.3; docs/provider-engine-contract.md §3, §4.1, §6.3; migration 0428). It is connected under
 * the Cursor preset and stored encrypted; every list says it runs on Cursor CLI alone; the doors a
 * person (the API) and an agent (MCP: the runner's session door) create sessions through resolve an
 * engine and the key, the key alone, the engine alone and neither, and refuse the key on any other
 * engine; the claim hands the runner the key as ORBIT_CURSOR_API_KEY; what a runner's `agent models`
 * said of the key is kept on it, an invalid key plainly so; and no log line, event, database row or API
 * response holds the key — the claim the session's own runner reads is the one place it goes. Named in
 * scripts/test-cursor-api-key.mjs; a missing server is a failure, not a skip.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { RunStatus, RunnerStatus } from '@prisma/client';
import { AgentProvider, ENGINE_CLI_NAMES, PermissionMode, RunEventType } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { RunnerProvidersController } from '../runner-api/runner-providers.controller';
import { RunnerSessionsController } from '../runner-api/runner-sessions.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { decryptSecret } from './provider-crypto';
import { ProvidersService } from './providers.service';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY ??= 'cursor-api-key-pg-spec';

/** What a runner of this version declares: every engine, Cursor CLI among them. */
const CURRENT = [
  AgentProvider.CLAUDE, AgentProvider.CODEX, AgentProvider.KIMI, AgentProvider.OPENCODE,
  AgentProvider.ANTIGRAVITY, AgentProvider.DSH, AgentProvider.CURSOR,
];
const OTHER_ENGINES = CURRENT.filter((engine) => engine !== AgentProvider.CURSOR);
const TASK_CHECK = { completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0 } as const;

/** A key shaped like a Cursor User API Key, and nothing else's: found anywhere, it leaked. */
const newKey = () => `key_p2pg${randomUUID().replace(/-/g, '')}`;

/** A value as JSON, the way it goes over the wire: a BigInt column as its digits. */
const serialize = (value: unknown) => JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? String(v) : v));

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

test('P2 Cursor API key on PostgreSQL', { timeout: 600_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(URL);

  // Everything this process prints — every Nest logger and console line of every service the doors and
  // the claim go through — is kept, so the last case can read it all for a key.
  const printed: string[] = [];
  const writes = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    printed.push(String(chunk));
    return (writes.out as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    printed.push(String(chunk));
    return (writes.err as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  t.after(async () => {
    process.stdout.write = writes.out as typeof process.stdout.write;
    process.stderr.write = writes.err as typeof process.stderr.write;
    await db.$disconnect();
    await sql.end();
  });
  // What the last case looks for to know the capture saw this process print at all.
  const SENTINEL = '[cursor-api-key] reading everything this process prints';
  console.log(SENTINEL);

  // Every realtime publication is kept the same way; the drains answer nothing pending.
  const published: string[] = [];
  const drains: Record<string, unknown> = {
    drainCancellations: async () => [], drainMergeRequests: async () => [],
    drainCommitRequests: async () => [], drainArtifactRequests: async () => [],
  };
  const realtime = new Proxy(drains, {
    get: (target, name: string) => target[name] ?? ((...args: unknown[]) => {
      try {
        published.push(`${name} ${serialize(args)}`);
      } catch {
        published.push(`${name} ${String(args)}`);
      }
    }),
  }) as unknown as RealtimeService;
  const prisma = db as unknown as PrismaService;
  const queue = new QueueService(prisma, realtime);
  const sessions = new SessionsService(prisma, queue, realtime);
  const tasks = new TasksService(prisma, sessions, realtime);
  const providers = new ProvidersService(prisma, realtime, { snapshot: () => null } as never);
  const runnerProviders = new RunnerProvidersController(providers);
  // A session's own key check is the daemon's call, served by the runner controller; ProvidersService is its last dependency.
  const runnerApi = new RunnerApiController(
    prisma, queue, realtime, {} as never, {} as never, {} as never,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    providers,
  );
  // The orchestration credential's check is the door's own concern (runner-orchestration-authorizer.ts);
  // here it vouches for the parent session it is shown.
  const mcp = new RunnerSessionsController(
    sessions, { assert: async (_runner: unknown, parentSessionId: string) => parentSessionId } as never, {} as never, {} as never,
  );

  /** Every answer a door gave, as its caller reads it — what the last case reads for a key. */
  const responses: string[] = [];
  const answered = <T>(value: T): T => {
    responses.push(serialize(value));
    return value;
  };
  /** Every key connected here, each of which must be found nowhere but in its runner's claim. */
  const keys: string[] = [];
  /** The claims a runner read: the one place a key is handed over. */
  const claims: string[] = [];

  async function account(label: string) {
    const id = randomUUID();
    await db.user.create({ data: { id, email: `${label}-${id}@cursor-api-key.invalid`, name: label, passwordHash: 'x' } });
    return id;
  }
  type Machine = { id: string; ownerId: string; workspaceId: string; runner: { id: string; ownerId: string } };
  /** A runner of `ownerId`'s that declared every engine Cursor CLI among them, and a workspace on it. */
  async function machine(ownerId: string, env?: Record<string, string>): Promise<Machine> {
    const id = randomUUID();
    const workspaceId = randomUUID();
    await db.runner.create({ data: {
      id, ownerId, name: 'cursor-api-key', tokenHash: `x-${id}`, status: RunnerStatus.ONLINE, maxConcurrent: 64,
      capabilities: CURRENT.filter((engine) => [AgentProvider.DSH, AgentProvider.ANTIGRAVITY, AgentProvider.CURSOR].includes(engine))
        .map((engine) => `provider:${engine}`),
      capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    } });
    await db.workspace.create({ data: {
      id: workspaceId, ownerId, runnerId: id, name: `cursor-api-key-${workspaceId.slice(0, 6)}`, enabled: true,
      workDir: '/tmp/cursor-api-key', ...(env ? { env } : {}),
    } });
    return { id, ownerId, workspaceId, runner: { id, ownerId } };
  }
  /** A Cursor key connected through the door a person uses. */
  async function connectCursor(ownerId: string) {
    const apiKey = newKey();
    keys.push(apiKey);
    const row = answered(await providers.create(ownerId, {
      label: 'Cursor', presetSlug: 'cursor-api', baseUrl: 'https://api2.cursor.sh', apiKey,
    } as never)) as unknown as { id: string; slug: string };
    return { id: row.id, slug: row.slug, apiKey };
  }
  async function connectGlm(ownerId: string) {
    const row = await providers.create(ownerId, {
      label: 'GLM', presetSlug: 'glm', baseUrl: 'https://api.z.ai/api/anthropic', apiKey: `sk-glm-${randomUUID()}`,
    } as never) as unknown as { slug: string };
    return row.slug;
  }
  const fingerprint = (key: string) => createHash('sha256').update(key.trim()).digest('hex').slice(0, 16);
  /** A session through the API's door (POST /sessions). */
  const viaApi = async (at: Machine, dto: Record<string, unknown>) => answered(await sessions.create(at.ownerId, {
    workspaceId: at.workspaceId, prompt: 'hi', permissionMode: PermissionMode.ACCEPT_EDITS, ...dto,
  } as never)) as unknown as { id: string; engine: string; provider: string };
  /** A session through MCP's door: session_create from inside `parent` (POST /runner/sessions). */
  const viaMcp = async (at: Machine, parent: string, dto: Record<string, unknown>) => answered(await mcp.createSession(
    at.runner as never, undefined, parent, 'orchestration-credential',
    { prompt: 'hi', workspaceId: at.workspaceId, permissionMode: PermissionMode.ACCEPT_EDITS, ...dto } as never,
  )) as unknown as { id: string; engine: string; provider: string };
  const stored = (id: string) => db.session.findUniqueOrThrow({
    where: { id }, select: { engine: true, provider: true, providerBuiltin: true },
  });
  /** The next session the runner is handed, as it reads it. */
  async function claim(at: Machine, providersDeclared: readonly AgentProvider[] = CURRENT) {
    const job = await queue.claimSessionForRunner({ id: at.id, supportedProviders: providersDeclared });
    if (job) claims.push(serialize(job));
    return job;
  }
  /** Parks every open session of a machine, so the next claim takes only the one a case makes. */
  const park = (at: Machine) => db.session.updateMany({
    where: { assignedRunnerId: at.id, status: RunStatus.PENDING }, data: { status: RunStatus.AWAITING_INPUT },
  });

  const owner = await account('cursor');
  const at = await machine(owner);
  const key = await connectCursor(owner);

  await t.test('P2 a Cursor key is saved encrypted under the Cursor preset, and every list says it runs on Cursor CLI alone', async () => {
    // As connecting it answered: the vendor's preset, Cursor's own protocol, no model list of its own, unchecked.
    const [row] = (answered(await providers.listMine(owner)) as unknown as Array<Record<string, unknown>>)
      .filter((candidate) => candidate.id === key.id);
    assert.ok(key.slug.startsWith('cursor-api'), `slug ${key.slug}`);
    assert.equal(row.runtime, 'cursor');
    assert.equal(row.presetSlug, 'cursor-api');
    assert.equal(row.label, 'Cursor');
    assert.deepEqual(row.engines, [AgentProvider.CURSOR]);
    assert.deepEqual(row.models, []);
    assert.equal(row.modelsFromRuntime, true);
    assert.equal(row.hasApiKey, true);
    assert.equal(row.keyCheckState, null);
    assert.equal(row.keyCheckedAt, null);
    assert.ok(!('apiKey' in row) && !('apiKeyEnc' in row), 'no key in the answer');
    assert.deepEqual(row.poolRefusal, { reason: 'NOT_CLAUDE_RUNTIME', message: (row.poolRefusal as { message: string }).message });
    // Encrypted at rest: the column holds a ciphertext the server alone can read back.
    const { rows } = await sql.query('SELECT "runtime", "api_key_enc" FROM "model_provider" WHERE "id" = $1', [key.id]);
    assert.equal(rows[0].runtime, 'cursor');
    assert.ok(!String(rows[0].api_key_enc).includes(key.apiKey));
    assert.equal(decryptSecret(rows[0].api_key_enc), key.apiKey);
    // The picker's list, `orbit provider list` / MCP's provider_list, and the admin's shared list.
    const picker = (answered(await providers.listPublic(owner)) as unknown as Array<{ slug: string; engines: string[]; runsOnOpenCode: boolean; runtime: string }>)
      .find((candidate) => candidate.slug === key.slug);
    assert.deepEqual([picker?.engines, picker?.runsOnOpenCode, picker?.runtime], [[AgentProvider.CURSOR], false, 'cursor']);
    const usable = answered(await runnerProviders.list({ ownerId: owner } as never)) as unknown as Array<{ slug: string; engines: string[]; builtin: boolean }>;
    assert.deepEqual(usable.find((candidate) => candidate.slug === key.slug), {
      slug: key.slug, label: 'Cursor', runtime: 'cursor', models: [], defaultModel: null, modelsFromRuntime: true,
      engines: [AgentProvider.CURSOR], builtin: false,
    });
    assert.deepEqual(usable.find((candidate) => candidate.slug === AgentProvider.CURSOR),
      { slug: AgentProvider.CURSOR, runtime: AgentProvider.CURSOR, engines: [AgentProvider.CURSOR], builtin: true });
    // Only its owner can read the key back; anybody else is told there is no such key.
    assert.equal((await providers.revealKey(owner, key.id)).apiKey, key.apiKey);
    const stranger = await account('stranger');
    assert.equal((await refusal(providers.revealKey(stranger, key.id))).status, 404);
  });

  await t.test('P2 the API resolves engine and provider, provider alone, engine alone and neither on a Cursor key', async () => {
    // Engine alone first: Cursor CLI on the runner's own sign-in.
    const engineOnly = await viaApi(at, { engine: AgentProvider.CURSOR });
    assert.deepEqual(await stored(engineOnly.id), { engine: AgentProvider.CURSOR, provider: AgentProvider.CURSOR, providerBuiltin: true });
    assert.deepEqual([engineOnly.engine, engineOnly.provider], [AgentProvider.CURSOR, AgentProvider.CURSOR]);
    const both = await viaApi(at, { engine: AgentProvider.CURSOR, provider: key.slug });
    assert.deepEqual(await stored(both.id), { engine: AgentProvider.CURSOR, provider: key.slug, providerBuiltin: false });
    assert.deepEqual([both.engine, both.provider], [AgentProvider.CURSOR, key.slug]);
    const providerOnly = await viaApi(at, { provider: key.slug });
    assert.deepEqual(await stored(providerOnly.id), { engine: AgentProvider.CURSOR, provider: key.slug, providerBuiltin: false });
    // Neither: where the workspace last started — on the key, on Cursor CLI.
    const neither = await viaApi(at, {});
    assert.deepEqual(await stored(neither.id), { engine: AgentProvider.CURSOR, provider: key.slug, providerBuiltin: false });
    await park(at);
  });

  await t.test('P2 MCP resolves engine and provider, provider alone, engine alone and neither on a Cursor key', async () => {
    const mcpMachine = await machine(owner);
    // The agent asking: a Cursor CLI session of the owner's on the key, in that workspace — which is also
    // where the workspace last started, the seed a session that names neither starts from (children and
    // task runs are no seed).
    const parent = (await viaApi(mcpMachine, { engine: AgentProvider.CURSOR, provider: key.slug })).id;
    const both = await viaMcp(mcpMachine, parent, { engine: AgentProvider.CURSOR, provider: key.slug });
    assert.deepEqual(await stored(both.id), { engine: AgentProvider.CURSOR, provider: key.slug, providerBuiltin: false });
    assert.deepEqual([both.engine, both.provider], [AgentProvider.CURSOR, key.slug]);
    const providerOnly = await viaMcp(mcpMachine, parent, { provider: key.slug });
    assert.deepEqual(await stored(providerOnly.id), { engine: AgentProvider.CURSOR, provider: key.slug, providerBuiltin: false });
    const neither = await viaMcp(mcpMachine, parent, {});
    assert.deepEqual(await stored(neither.id), { engine: AgentProvider.CURSOR, provider: key.slug, providerBuiltin: false });
    const engineOnly = await viaMcp(mcpMachine, parent, { engine: AgentProvider.CURSOR });
    assert.deepEqual(await stored(engineOnly.id), { engine: AgentProvider.CURSOR, provider: AgentProvider.CURSOR, providerBuiltin: true });
    await park(mcpMachine);
  });

  await t.test('P2 a Cursor key on any other engine, and any other key on Cursor CLI, is refused PROVIDER_ENGINE_INCOMPATIBLE at every door', async () => {
    const glm = await connectGlm(owner);
    const parent = (await viaApi(at, { engine: AgentProvider.CLAUDE })).id;
    const before = await db.session.count({ where: { ownerId: owner } });
    for (const engine of OTHER_ENGINES) {
      const expected = {
        code: 'PROVIDER_ENGINE_INCOMPATIBLE',
        message: `provider "${key.slug}" cannot run on ${ENGINE_CLI_NAMES[engine]}; it runs on Cursor CLI`,
        engine, provider: key.slug, engines: [AgentProvider.CURSOR],
      };
      for (const door of [viaApi(at, { engine, provider: key.slug }), viaMcp(at, parent, { engine, provider: key.slug })]) {
        const answer = await refusal(door);
        assert.equal(answer.status, 400);
        assert.deepEqual(answer.body, expected);
      }
      const pinned = await refusal(tasks.create(owner, { title: `on ${engine}`, engine, provider: key.slug, ...TASK_CHECK } as never));
      assert.deepEqual([pinned.status, pinned.code], [400, 'PROVIDER_ENGINE_INCOMPATIBLE']);
    }
    // Another key on Cursor CLI.
    for (const door of [viaApi(at, { engine: AgentProvider.CURSOR, provider: glm }), viaMcp(at, parent, { engine: AgentProvider.CURSOR, provider: glm })]) {
      const answer = await refusal(door);
      assert.deepEqual([answer.status, answer.code, answer.body.engines], [400, 'PROVIDER_ENGINE_INCOMPATIBLE', [AgentProvider.CLAUDE, AgentProvider.OPENCODE]]);
    }
    // The old OpenCode spelling naming the Cursor key: OpenCode cannot spend it.
    const openCode = await refusal(viaApi(at, { provider: AgentProvider.OPENCODE, model: `orbit-${key.slug}/default[]` }));
    assert.deepEqual([openCode.status, openCode.code], [400, 'PROVIDER_ENGINE_INCOMPATIBLE']);
    assert.equal(await db.session.count({ where: { ownerId: owner } }), before, 'a refused door wrote no session');

    // A task pins the key on Cursor CLI, and keeps every other engine off it.
    const task = answered(await tasks.create(owner, { title: 'on the key', provider: key.slug, ...TASK_CHECK } as never)) as { id: string };
    assert.deepEqual(await db.task.findUniqueOrThrow({ where: { id: task.id }, select: { engine: true, provider: true } }),
      { engine: AgentProvider.CURSOR, provider: key.slug });
    const moved = await refusal(tasks.update(owner, task.id, { engine: AgentProvider.CODEX } as never));
    assert.deepEqual([moved.status, moved.code], [400, 'PROVIDER_ENGINE_INCOMPATIBLE']);
    // A Claude Code session cannot move onto it either.
    const claude = (await viaApi(at, { engine: AgentProvider.CLAUDE })).id;
    await db.session.update({ where: { id: claude }, data: {
      status: RunStatus.FAILED, numTurns: 1, runtimeSessionId: `runtime-${randomUUID()}`, startedAt: new Date(), finishedAt: new Date(),
    } });
    const switched = await refusal(sessions.resume(owner, claude, { content: 'again', clientTurnId: randomUUID(), provider: key.slug } as never));
    assert.deepEqual([switched.status, switched.code], [400, 'PROVIDER_ENGINE_INCOMPATIBLE']);
    assert.deepEqual(await stored(claude), { engine: AgentProvider.CLAUDE, provider: AgentProvider.CLAUDE, providerBuiltin: true });
    await park(at);
  });

  let keySession = '';
  await t.test('P2 dispatch hands the session’s own runner the key as ORBIT_CURSOR_API_KEY, on Cursor CLI', async () => {
    const onKey = await viaApi(at, { engine: AgentProvider.CURSOR, provider: key.slug });
    keySession = onKey.id;
    // A runner that never declared Cursor CLI is handed nothing (migration 0426's gate).
    assert.equal(await claim(at, OTHER_ENGINES), null);
    const job = (await claim(at))!;
    assert.equal(job.sessionId, onKey.id);
    assert.equal(job.provider, AgentProvider.CURSOR);
    assert.equal(job.agent.provider, AgentProvider.CURSOR);
    assert.equal(job.agent.env?.ORBIT_CURSOR_API_KEY, key.apiKey);
    // In that variable alone: no other engine's, and not under the CLI's own name, which the runner sets.
    const holding = Object.entries(job.agent.env ?? {}).filter(([, value]) => String(value).includes(key.apiKey)).map(([name]) => name);
    assert.deepEqual(holding, ['ORBIT_CURSOR_API_KEY']);
    // A session on the runner's own sign-in is handed no key, not even one typed into its workspace.
    const typed = await machine(owner, { ORBIT_CURSOR_API_KEY: 'key_typed-into-the-workspace', FOO: 'bar' });
    const onLogin = await viaApi(typed, { engine: AgentProvider.CURSOR });
    const loginJob = (await claim(typed))!;
    assert.equal(loginJob.sessionId, onLogin.id);
    assert.equal(loginJob.agent.provider, AgentProvider.CURSOR);
    assert.equal(loginJob.agent.env?.ORBIT_CURSOR_API_KEY, undefined);
    assert.equal(loginJob.agent.env?.FOO, 'bar');
  });

  await t.test('P2 a runner’s check of a Cursor key is kept on the key, an invalid one plainly, and a replaced key is unchecked', async () => {
    const report = (runner: { id: string; ownerId: string }, sessionId: string, state: string, keyText: string) =>
      runnerApi.cursorKeyCheck(runner as never, sessionId, { state, keyFingerprint: fingerprint(keyText) } as never);
    const checkOf = async () => {
      const row = (await providers.listMine(owner) as unknown as Array<{ id: string; keyCheckState: string | null; keyCheckedAt: Date | null }>)
        .find((candidate) => candidate.id === key.id)!;
      return { state: row.keyCheckState, at: row.keyCheckedAt };
    };
    const changed = () => published.filter((line) => line.includes(RunEventType.PROVIDER_CHANGED) && line.includes(key.id)).length;
    const changedBefore = changed();
    // Cursor refused the key: the key says so.
    assert.deepEqual(answered(await report(at.runner, keySession, 'INVALID', key.apiKey)), { recorded: true });
    const invalid = await checkOf();
    assert.equal(invalid.state, 'INVALID');
    assert.ok(invalid.at instanceof Date && Date.now() - invalid.at.getTime() < 60_000);
    assert.ok(changed() > changedBefore, 'the owner is told the key changed');
    // A Cursor API that could not be reached, and a key Cursor accepts.
    for (const state of ['UNREACHABLE', 'VALID', 'INVALID']) {
      assert.deepEqual(await report(at.runner, keySession, state, key.apiKey), { recorded: true });
      assert.equal((await checkOf()).state, state);
    }
    // An answer about another key is about nothing here; a state nobody knows is refused.
    assert.deepEqual(await report(at.runner, keySession, 'VALID', newKey()), { recorded: false });
    assert.equal((await checkOf()).state, 'INVALID');
    assert.equal((await refusal(providers.recordCursorKeyCheck(at.id, keySession, { state: 'BROKEN', keyFingerprint: fingerprint(key.apiKey) }))).status, 400);
    // Only the session's own runner speaks for it: another of the owner's, and another account's, are refused.
    const otherMachine = await machine(owner);
    const stranger = await machine(await account('other-runner'));
    for (const runner of [otherMachine.runner, stranger.runner]) {
      assert.equal((await refusal(report(runner, keySession, 'VALID', key.apiKey))).status, 403);
    }
    // A session on anything but a Cursor key is no answer about one.
    const onLogin = await viaApi(at, { engine: AgentProvider.CURSOR });
    await db.session.update({ where: { id: onLogin.id }, data: { assignedRunnerId: at.id } });
    assert.deepEqual(await report(at.runner, onLogin.id, 'VALID', key.apiKey), { recorded: false });
    assert.equal((await checkOf()).state, 'INVALID');
    // A new key has not been checked: the old answer goes with the old key, and one about it is refused.
    const rotated = newKey();
    keys.push(rotated);
    const updated = answered(await providers.update(owner, key.id, { apiKey: rotated } as never)) as unknown as { keyCheckState: unknown; keyCheckedAt: unknown };
    assert.deepEqual([updated.keyCheckState, updated.keyCheckedAt], [null, null]);
    assert.deepEqual(await checkOf(), { state: null, at: null });
    assert.deepEqual(await report(at.runner, keySession, 'INVALID', key.apiKey), { recorded: false });
    assert.deepEqual(await checkOf(), { state: null, at: null });
    assert.deepEqual(await report(at.runner, keySession, 'VALID', rotated), { recorded: true });
    assert.equal((await checkOf()).state, 'VALID');
    // The database holds the pair together, and only the three states.
    for (const assignment of [`"key_check_state" = 'BROKEN', "key_checked_at" = now()`, `"key_check_state" = 'VALID', "key_checked_at" = NULL`]) {
      await assert.rejects(sql.query(`UPDATE "model_provider" SET ${assignment} WHERE "id" = $1`, [key.id]), /check constraint/);
    }
    // The claim of the session on it now hands over the new key.
    await park(at);
    await db.session.update({ where: { id: keySession }, data: { status: RunStatus.PENDING, inboxLeaseOwner: null, inboxLeaseGeneration: null } });
    const job = (await claim(at))!;
    assert.equal(job.sessionId, keySession);
    assert.equal(job.agent.env?.ORBIT_CURSOR_API_KEY, rotated);
  });

  await t.test('P2 no log line, event, database row or API response holds a Cursor key; only its runner’s claim does', async () => {
    assert.ok(keys.length >= 2, 'the cases connected and replaced keys');
    // The search finds a key where it is: the claims the runner read carry each key that ran.
    for (const handed of keys) assert.ok(claims.some((claimed) => claimed.includes(handed)), 'a claim holds the key it hands over');
    // Every table, every row, read as JSON.
    const { rows: tables } = await sql.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'");
    assert.ok(tables.length > 100, `${tables.length} tables`);
    for (const secret of keys) {
      for (const { table_name: table } of tables) {
        const { rows } = await sql.query(
          `SELECT count(*)::int AS n FROM "${table}" t WHERE position($1 in row_to_json(t)::text) > 0`, [secret]);
        assert.equal(rows[0].n, 0, `table ${table} holds a key in plaintext`);
      }
      for (const [where, texts] of [['an API response', responses], ['a realtime event', published], ['a log line', printed]] as const) {
        assert.ok(texts.length > 0, `nothing to read in ${where}`);
        assert.equal(texts.filter((text) => text.includes(secret)).length, 0, `${where} holds a key`);
      }
    }
    assert.ok(printed.some((line) => line.includes(SENTINEL)), 'the capture saw nothing this process printed');
  });
});
