/**
 * A shared model provider — owner_id NULL, kept by an admin under /admin/providers — runs an admin's sessions
 * only, on real PostgreSQL. A session on a configured provider is handed its key in the engine's environment, on
 * the runner the session runs on, which its owner registered themselves: a shared row every account could
 * resolve gave its key to anybody who can sign up. The owner decided (task 34bVBK1mGO89SmqDb0doH, 2026-10-07)
 * that a shared provider is the admins' own, and that a key is shared with other people through a shared pool,
 * whose gateway keeps it off their runners. Each claim below is paired with the same request made for an admin,
 * which has to go through, so a door that refused everybody could not pass.
 *
 *  (1) Every door that takes a provider slug refuses a member who names a shared one, with the sentence that
 *      says who can use it, and writes nothing: a new session (named, inherited from the agent's last session,
 *      or an OpenCode model on the key), a provider switch, a revive, a task (create, update, batch), an
 *      agent's mention, a Wiki space's maintenance pin.
 *  (2) No door that builds an engine hands a member's session the key: the claim, which leaves the session
 *      PENDING and says why; a restarted runner's reclaim; a provider-switch reload; an OpenCode model naming
 *      the key. A member's own provider still runs, on their own key.
 *  (3) The lists and the runtime: the picker (GET /providers), the slugs an agent may pass (GET
 *      /runner/providers), the slugs a runtime gate asks about, and the runtime a session resolves to.
 *  (4) The role is read at every door: a member promoted to admin runs on the shared provider at the next
 *      claim, and loses it again at the next claim once demoted.
 *  (5) Sharing goes through a shared pool: a member the admin adds runs on the pool's key through the gateway,
 *      on a token of their own, and never holds the key.
 *  (6) Nothing handed to any of the member's runners, and no table, holds a shared key in the clear.
 *
 * Everything between the rows and the answers is production code — SessionsService, TasksService,
 * ProvidersService, SharedPoolsService, QueueService, RunnerApiController — with the realtime fan-out and the
 * network the server calls out on stood in for. It only adds rows, under ids and slugs of its own, and refuses to
 * run anywhere but the disposable server `coordinator-pg-test-safety` identifies.
 */

import 'reflect-metadata';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { BadRequestException } from '@nestjs/common';
import { PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';
import { AgentProvider, type ClaimedSession } from '@orbit/shared';
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
import { ADMIN_ONLY_PROVIDER_ERROR } from '../runner-api/runner-provider-support';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { wikiMaintenanceProviderProblem } from '../wiki/wiki-maintenance-settings';
import { openCodeKeyRows, providerSlugsOn, sessionExecRuntime } from './custom-provider';
import { ProviderPlanUsageService } from './plan-usage.service';
import { ProvidersService } from './providers.service';
import { SharedPoolsService } from './shared-pools.service';

const URL = process.env.COORDINATOR_PG_URL;
// The spec stores keys through the providers' own door and the code under test decrypts them.
process.env.PROVIDER_SECRET_KEY ??= 'shared-provider-admin-only-spec';

/** In every shared key this spec makes: what no member's runner may be handed, and no table may hold. */
const MARK = 'adminonlykey';
const sharedKey = (name: string) => `sk-${MARK}-${name}-${randomUUID()}`;

/** What would have reached a client's stream; nothing here reads it. */
const realtime = new Proxy(
  {},
  { get: (_target, key) => (key === 'then' ? undefined : () => undefined) },
) as RealtimeService;

/** Nothing here calls out; if something did, it gets nothing back. */
const offline = (async () => new Response('offline', { status: 503 })) as typeof fetch;
const realFetch = globalThis.fetch;

/** A runner and the agent (workspace) bound to it. */
interface Machine {
  runnerId: string;
  workspaceId: string;
}

/** `value` as the text it would go over the wire as. */
const wire = (value: unknown) =>
  JSON.stringify(value ?? null, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

const TASK_CHECK = {
  completionCriterion: 'EXECUTABLE',
  acceptanceCommand: 'true',
  acceptanceExpectedExitCode: 0,
} as const;

/** The refusal a door owes a member who names `slug` (adminOnlyProviderRefusal). */
const adminOnly = (slug: string) =>
  `provider "${slug}" is available to admins only; ask an admin to add you to a shared pool`;
const refusedAsAdminOnly = (slug: string) => (error: unknown) =>
  error instanceof BadRequestException && error.message === adminOnly(slug);

const suite = URL ? test : test.skip;

suite('a shared model provider runs an admin\'s sessions only, on real PostgreSQL', { timeout: 600_000 }, async (t) => {
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
  const sessions = new SessionsService(prisma, queue, realtime);
  const tasks = new TasksService(prisma, sessions, realtime);
  const providers = new ProvidersService(prisma, realtime, usage);
  const pools = new SharedPoolsService(prisma, realtime, providers);
  const runnerApi = new RunnerApiController(
    db as never, queue as never, realtime as never, {} as never, {} as never, {} as never,
  );

  async function person(label: string, role = 'MEMBER'): Promise<{ id: string; email: string }> {
    const id = randomUUID();
    const email = `${label}-${id}@shared-provider.invalid`;
    await db.user.create({ data: { id, email, name: label, passwordHash: 'x', role } });
    return { id, email };
  }

  async function machine(ownerId: string, label: string): Promise<Machine> {
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    await db.runner.create({
      data: {
        id: runnerId, ownerId, name: `${label}-runner`, tokenHash: sha256(`shared-provider-runner-${runnerId}`),
        status: RunnerStatus.ONLINE, maxConcurrent: 4, lastHeartbeatAt: new Date(),
      },
    });
    await db.workspace.create({
      data: { id: workspaceId, ownerId, runnerId, name: `${label}-agent`, enabled: true, workDir: `/tmp/${label}` },
    });
    return { runnerId, workspaceId };
  }

  /**
   * A session row on `provider`, written straight into the table: how a member's session on a shared provider
   * comes to exist now that every door refuses to write one — one made before this change, or a forged row.
   */
  async function sessionOn(
    ownerId: string,
    at: Machine,
    provider: string,
    status: RunStatus,
    over: { model?: string; started?: boolean } = {},
  ): Promise<string> {
    const builtin = (Object.values(AgentProvider) as string[]).includes(provider);
    const started = over.started ?? status !== RunStatus.PENDING;
    const session = await db.session.create({
      data: {
        title: 'shared provider',
        prompt: 'hello',
        status,
        ownerId,
        creatorId: ownerId,
        workspaceId: at.workspaceId,
        assignedRunnerId: at.runnerId,
        provider,
        providerBuiltin: builtin,
        model: over.model ?? 'claude-opus-5',
        permissionMode: 'default',
        usesRuntimeDefaultModel: true,
        ...(started ? { numTurns: 1, runtimeSessionId: randomUUID(), startedAt: new Date() } : {}),
      },
      select: { id: true },
    });
    return session.id;
  }
  const recorded = (sessionId: string) =>
    db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { provider: true, status: true, error: true } });

  /** Everything any runner of the member's was handed: (6) reads it whole at the end. */
  const handedToMember: unknown[] = [];
  /** …and of the admin's: what shows the sweep can see a key at all. */
  const handedToAdmin: unknown[] = [];

  /** The runner asking for work, as one that drives every runtime this spec dispatches. */
  async function claimOn(at: Machine, handed: unknown[]): Promise<ClaimedSession | null> {
    const claimed = await queue.claimSessionForRunner(
      { id: at.runnerId, supportedProviders: [AgentProvider.CLAUDE, AgentProvider.CODEX, AgentProvider.OPENCODE] },
      0, false, false,
    );
    handed.push(claimed);
    return claimed;
  }
  /** The runner's inbox poll, until it is handed the reload a provider switch queued. */
  async function dequeueReload(sessionId: string, runnerId: string) {
    const dequeue = (runnerApi as unknown as {
      dequeueTurn(sessionId: string, runnerId: string, leaseGeneration: string | null): Promise<
        { kind: string; env?: Record<string, string> } | null
      >;
    }).dequeueTurn.bind(runnerApi);
    for (let polls = 0; polls < 4; polls += 1) {
      const turn = await dequeue(sessionId, runnerId, null);
      assert.ok(turn, 'the inbox handed out nothing');
      if (turn.kind === 'reload') return turn;
    }
    throw new Error('the inbox never handed out the reload');
  }

  const admin = await person('admin', 'ADMIN');
  const member = await person('member');

  // Two shared providers, made through the admin's own door (AdminProvidersController → create(null, …)): one
  // on the Claude Code runtime, one on Codex — which OpenCode can also spend. And one of the member's own.
  const CLAUDE_KEY = sharedKey('claude');
  const CODEX_KEY = sharedKey('codex');
  const OWN_KEY = `sk-own-${randomUUID()}`;
  const providerRow = async (ownerId: string | null, dto: Parameters<ProvidersService['create']>[1]) => {
    const created = await providers.create(ownerId, dto);
    return db.modelProvider.findUniqueOrThrow({ where: { id: created.id }, select: { id: true, slug: true, ownerId: true } });
  };
  const sharedClaude = await providerRow(null, {
    label: 'Team DeepSeek', runtime: 'claude', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: CLAUDE_KEY,
    models: [{ value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }], defaultModel: 'deepseek-v4-pro',
  });
  const sharedCodex = await providerRow(null, {
    label: 'Team OpenAI', runtime: 'codex', baseUrl: 'https://api.openai.com/v1', apiKey: CODEX_KEY,
    models: [{ value: 'gpt-5.5', label: 'GPT-5.5' }], defaultModel: 'gpt-5.5',
  });
  const own = await providerRow(member.id, {
    label: 'My DeepSeek', runtime: 'claude', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: OWN_KEY,
    models: [{ value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }], defaultModel: 'deepseek-v4-pro',
  });
  assert.deepEqual([sharedClaude.ownerId, sharedCodex.ownerId, own.ownerId], [null, null, member.id]);
  const openCodeModel = `orbit-${sharedCodex.slug}/gpt-5.5`;

  await t.test('(1) a new session: a member naming a shared provider is told who can use it, and nothing is written; an admin is not', async () => {
    const at = await machine(member.id, 'member-opens');
    await assert.rejects(
      sessions.create(member.id, { prompt: 'hello', title: 'on shared', workspaceId: at.workspaceId, provider: sharedClaude.slug }),
      refusedAsAdminOnly(sharedClaude.slug),
    );
    // An OpenCode model on the shared key is the same key, and the same refusal.
    await assert.rejects(
      sessions.create(member.id, { prompt: 'hello', title: 'on shared key', workspaceId: at.workspaceId, provider: 'opencode', model: openCodeModel }),
      refusedAsAdminOnly(sharedCodex.slug),
    );
    assert.equal(await db.session.count({ where: { workspaceId: at.workspaceId } }), 0, 'a session was written');
    // The member's own provider is theirs to run.
    const mine = await sessions.create(member.id, { prompt: 'hello', title: 'on mine', workspaceId: at.workspaceId, provider: own.slug });
    assert.equal((await recorded(mine.id)).provider, own.slug);

    const adminAt = await machine(admin.id, 'admin-opens');
    const theirs = await sessions.create(admin.id, { prompt: 'hello', title: 'on shared', workspaceId: adminAt.workspaceId, provider: sharedClaude.slug });
    assert.equal((await recorded(theirs.id)).provider, sharedClaude.slug);
    const onKey = await sessions.create(admin.id, { prompt: 'hello', title: 'on shared key', workspaceId: adminAt.workspaceId, provider: 'opencode', model: openCodeModel });
    assert.equal((await recorded(onKey.id)).provider, 'opencode');
  });

  await t.test("(1) a new session that inherits a shared provider from the agent's last one is refused for a member, and opens for an admin", async () => {
    const at = await machine(member.id, 'member-inherits');
    await sessionOn(member.id, at, sharedClaude.slug, RunStatus.SUCCEEDED, { model: 'deepseek-v4-pro' });
    await assert.rejects(
      sessions.create(member.id, { prompt: 'hello', title: 'inherits', workspaceId: at.workspaceId }),
      refusedAsAdminOnly(sharedClaude.slug),
    );
    assert.equal(await db.session.count({ where: { workspaceId: at.workspaceId } }), 1, 'a session was written');

    const adminAt = await machine(admin.id, 'admin-inherits');
    await sessionOn(admin.id, adminAt, sharedClaude.slug, RunStatus.SUCCEEDED, { model: 'deepseek-v4-pro' });
    const inherited = await sessions.create(admin.id, { prompt: 'hello', title: 'inherits', workspaceId: adminAt.workspaceId });
    assert.equal((await recorded(inherited.id)).provider, sharedClaude.slug);
  });

  await t.test('(1) a live session switches onto a shared provider for an admin, and not for a member', async () => {
    const at = await machine(member.id, 'member-switches');
    const session = await sessionOn(member.id, at, 'claude', RunStatus.AWAITING_INPUT);
    await assert.rejects(
      sessions.updateConfig(member.id, session, { provider: sharedClaude.slug }),
      refusedAsAdminOnly(sharedClaude.slug),
    );
    assert.equal((await recorded(session)).provider, 'claude');
    assert.equal(await db.conversationTurn.count({ where: { sessionId: session } }), 0, 'a reload was queued');

    const adminAt = await machine(admin.id, 'admin-switches');
    const theirs = await sessionOn(admin.id, adminAt, 'claude', RunStatus.AWAITING_INPUT);
    await sessions.updateConfig(admin.id, theirs, { provider: sharedClaude.slug });
    assert.equal((await recorded(theirs)).provider, sharedClaude.slug);
    // The reload re-spawns the admin's engine on the shared key.
    const reload = await dequeueReload(theirs, adminAt.runnerId);
    handedToAdmin.push(reload);
    assert.equal(reload.env?.ANTHROPIC_AUTH_TOKEN, CLAUDE_KEY);
  });

  await t.test('(1) an ended session revives onto a shared provider for an admin, and not for a member', async () => {
    const at = await machine(member.id, 'member-revives');
    const session = await sessionOn(member.id, at, 'claude', RunStatus.FAILED);
    await assert.rejects(
      sessions.resume(member.id, session, { clientTurnId: randomUUID(), content: 'again', provider: sharedClaude.slug }),
      refusedAsAdminOnly(sharedClaude.slug),
    );
    assert.deepEqual(
      { ...(await recorded(session)), turns: await db.conversationTurn.count({ where: { sessionId: session } }) },
      { provider: 'claude', status: RunStatus.FAILED, error: null, turns: 0 },
    );

    const adminAt = await machine(admin.id, 'admin-revives');
    const theirs = await sessionOn(admin.id, adminAt, 'claude', RunStatus.FAILED);
    await sessions.resume(admin.id, theirs, { clientTurnId: randomUUID(), content: 'again', provider: sharedClaude.slug });
    assert.deepEqual(
      { provider: (await recorded(theirs)).provider, status: (await recorded(theirs)).status },
      { provider: sharedClaude.slug, status: RunStatus.PENDING },
    );
  });

  await t.test('(1) a task pins a shared provider for an admin, and not for a member — created, edited or in a batch', async () => {
    const title = `pinned ${randomUUID()}`;
    await assert.rejects(
      tasks.create(member.id, { title, provider: sharedClaude.slug, ...TASK_CHECK } as never),
      refusedAsAdminOnly(sharedClaude.slug),
    );
    const pinned = await tasks.create(member.id, { title, provider: own.slug, ...TASK_CHECK } as never);
    await assert.rejects(tasks.update(member.id, pinned.id, { provider: sharedClaude.slug }), refusedAsAdminOnly(sharedClaude.slug));
    await assert.rejects(
      tasks.createMany(member.id, { tasks: [{ title: `${title} batched`, provider: sharedClaude.slug, ...TASK_CHECK }] } as never),
      refusedAsAdminOnly(sharedClaude.slug),
    );
    assert.deepEqual(
      await db.task.findMany({ where: { ownerId: member.id }, select: { title: true, provider: true } }),
      [{ title, provider: own.slug }],
      'a task of the member was pinned to the shared provider',
    );

    const theirs = await tasks.create(admin.id, { title, provider: sharedClaude.slug, ...TASK_CHECK } as never);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: theirs.id } })).provider, sharedClaude.slug);
    await tasks.createMany(admin.id, { tasks: [{ title: `${title} batched`, provider: sharedClaude.slug, ...TASK_CHECK }] } as never);
    assert.equal(await db.task.count({ where: { ownerId: admin.id, provider: sharedClaude.slug } }), 2);
  });

  await t.test("(1) a mention of an agent that last ran on a shared provider is held for a member's agent, and answered for an admin's", async () => {
    const mention = async (ownerId: string, at: Machine) => {
      const task = await tasks.create(ownerId, { title: `mentions ${randomUUID()}`, ...TASK_CHECK } as never);
      return db.taskComment.create({
        data: {
          taskId: task.id, authorType: 'USER', authorId: ownerId, body: 'have a look at this',
          mentions: [at.workspaceId], mentionDeliveryVersion: 1,
        },
        select: { id: true },
      });
    };
    const memberAgent = await machine(member.id, 'member-mentioned');
    const forged = await sessionOn(member.id, memberAgent, sharedClaude.slug, RunStatus.SUCCEEDED, { model: 'deepseek-v4-pro' });
    const adminAgent = await machine(admin.id, 'admin-mentioned');
    await sessionOn(admin.id, adminAgent, sharedClaude.slug, RunStatus.SUCCEEDED, { model: 'deepseek-v4-pro' });
    const toMember = await mention(member.id, memberAgent);
    const toAdmin = await mention(admin.id, adminAgent);

    await tasks.deliverMentions();

    const delivery = (commentId: string) => db.taskCommentMentionDelivery.findFirstOrThrow({
      where: { commentId },
      select: { status: true, errorCode: true, lastError: true, requiredAction: true, targetSessionId: true },
    });
    const held = await delivery(toMember.id);
    assert.equal(held.errorCode, 'PROVIDER_UNAVAILABLE', JSON.stringify(held));
    assert.match(held.lastError ?? '', /available to admins only/);
    assert.match(held.requiredAction ?? '', /ask an admin to add you to a shared pool/);
    assert.equal(held.targetSessionId, null, 'the mention was bound to a session');
    assert.deepEqual(
      (await db.session.findMany({ where: { workspaceId: memberAgent.workspaceId }, select: { id: true } })).map((s) => s.id),
      [forged],
      "the mention opened a session on the shared provider for the member's agent",
    );

    const answered = await delivery(toAdmin.id);
    assert.equal(answered.status, 'SESSION_CREATED', JSON.stringify(answered));
    assert.equal((await recorded(answered.targetSessionId!)).provider, sharedClaude.slug);
  });

  await t.test('(1) a Wiki space pins a shared provider for its maintenance for an admin, and not for a member', async () => {
    assert.deepEqual(
      await wikiMaintenanceProviderProblem(prisma, member.id, sharedClaude.slug),
      { why: adminOnly(sharedClaude.slug), unavailable: false },
    );
    assert.equal(await wikiMaintenanceProviderProblem(prisma, admin.id, sharedClaude.slug), null);
  });

  await t.test("(2) the claim hands a member's session on a shared provider nothing and holds it, saying why; the admin's runs on the key, the member's own on theirs", async () => {
    for (const [label, provider, model] of [
      ['claude', sharedClaude.slug, 'deepseek-v4-pro'],
      ['codex', sharedCodex.slug, 'gpt-5.5'],
      // An OpenCode model on the shared key: the built-in engine, the shared key written into its config.
      ['opencode', 'opencode', openCodeModel],
    ] as const) {
      const at = await machine(member.id, `member-claims-${label}`);
      const session = await sessionOn(member.id, at, provider, RunStatus.PENDING, { model });
      assert.equal(await claimOn(at, handedToMember), null, `the member's runner was handed the ${label} session`);
      assert.deepEqual(await recorded(session), { provider, status: RunStatus.PENDING, error: ADMIN_ONLY_PROVIDER_ERROR });
    }

    const adminClaims = async (label: string, provider: string, model: string) => {
      const at = await machine(admin.id, `admin-claims-${label}`);
      const session = await sessionOn(admin.id, at, provider, RunStatus.PENDING, { model });
      const claimed = await claimOn(at, handedToAdmin);
      assert.equal(claimed?.sessionId, session, `the admin's runner was not handed the ${label} session`);
      return claimed!.agent.env ?? {};
    };
    assert.equal((await adminClaims('claude', sharedClaude.slug, 'deepseek-v4-pro')).ANTHROPIC_AUTH_TOKEN, CLAUDE_KEY);
    assert.equal((await adminClaims('codex', sharedCodex.slug, 'gpt-5.5')).OPENAI_API_KEY, CODEX_KEY);
    assert.ok((await adminClaims('opencode', 'opencode', openCodeModel)).OPENCODE_CONFIG_CONTENT?.includes(CODEX_KEY));

    const mineAt = await machine(member.id, 'member-claims-own');
    const mine = await sessionOn(member.id, mineAt, own.slug, RunStatus.PENDING, { model: 'deepseek-v4-pro' });
    const claimed = await claimOn(mineAt, handedToMember);
    assert.equal(claimed?.sessionId, mine);
    assert.equal(claimed?.agent.env?.ANTHROPIC_AUTH_TOKEN, OWN_KEY);
  });

  await t.test("(2) a restarted runner's reclaim rebuilds none of a member's sessions on a shared provider, and the admin's on the key", async () => {
    const at = await machine(member.id, 'member-reclaims');
    const onShared = await sessionOn(member.id, at, sharedClaude.slug, RunStatus.AWAITING_INPUT, { model: 'deepseek-v4-pro' });
    const mine = await sessionOn(member.id, at, own.slug, RunStatus.AWAITING_INPUT, { model: 'deepseek-v4-pro' });
    const reclaimed = (await runnerApi.reclaim({ id: at.runnerId, ownerId: member.id })).sessions;
    handedToMember.push(reclaimed);
    assert.equal(reclaimed.find((s) => s.sessionId === onShared), undefined, 'the session on the shared provider was rebuilt');
    assert.equal(reclaimed.find((s) => s.sessionId === mine)?.agent.env?.ANTHROPIC_AUTH_TOKEN, OWN_KEY);

    const adminAt = await machine(admin.id, 'admin-reclaims');
    const theirs = await sessionOn(admin.id, adminAt, sharedClaude.slug, RunStatus.AWAITING_INPUT, { model: 'deepseek-v4-pro' });
    const rebuilt = (await runnerApi.reclaim({ id: adminAt.runnerId, ownerId: admin.id })).sessions;
    handedToAdmin.push(rebuilt);
    assert.equal(rebuilt.find((s) => s.sessionId === theirs)?.agent.env?.ANTHROPIC_AUTH_TOKEN, CLAUDE_KEY);
  });

  await t.test("(2) a provider-switch reload onto a shared provider hands a member's session nothing, and stays undelivered", async () => {
    // Past the door — the row and the queued reload written by hand, as nothing in the product can now.
    const at = await machine(member.id, 'member-reloads');
    const session = await sessionOn(member.id, at, sharedClaude.slug, RunStatus.AWAITING_INPUT, { model: 'deepseek-v4-pro' });
    const reload = await db.conversationTurn.create({
      data: {
        sessionId: session, seq: 1, clientTurnId: randomUUID(), kind: 'reload',
        content: JSON.stringify({ provider: sharedClaude.slug }), status: 'PENDING',
      },
    });
    await assert.rejects(
      dequeueReload(session, at.runnerId).then((turn) => handedToMember.push(turn)),
      (e: unknown) => e instanceof BadRequestException,
    );
    assert.deepEqual(
      await db.conversationTurn.findUniqueOrThrow({ where: { id: reload.id }, select: { status: true, deliveredAt: true } }),
      { status: 'PENDING', deliveredAt: null },
    );
  });

  await t.test('(3) the picker, the slugs an agent may pass, a runtime gate and the runtime a session runs on name a shared provider for an admin only', async () => {
    const slugs = (rows: Array<{ slug: string }>) => rows.map((row) => row.slug);
    const shared = [sharedClaude.slug, sharedCodex.slug];
    const named = (list: string[]) => shared.filter((slug) => list.includes(slug));

    // GET /providers (the picker) and GET /runner/providers (`orbit provider list`).
    assert.deepEqual(named(slugs(await providers.listPublic(member.id))), []);
    assert.deepEqual(named(slugs(await providers.listUsable(member.id))), []);
    assert.ok(slugs(await providers.listPublic(member.id)).includes(own.slug), "the member's own provider is not in their picker");
    assert.deepEqual(named(slugs(await providers.listPublic(admin.id))), shared);
    assert.deepEqual(named(slugs(await providers.listUsable(admin.id))), shared);

    // The slugs a runner that does not drive a runtime is withheld (ADVERTISED_RUNTIMES), and the keys an
    // OpenCode model may name.
    assert.deepEqual(await providerSlugsOn(db as never, member.id, AgentProvider.CODEX), [AgentProvider.CODEX]);
    assert.deepEqual(await providerSlugsOn(db as never, admin.id, AgentProvider.CODEX), [AgentProvider.CODEX, sharedCodex.slug]);
    assert.deepEqual(named(slugs(await openCodeKeyRows(db as never, member.id))), []);
    assert.deepEqual(named(slugs(await openCodeKeyRows(db as never, admin.id))), shared);

    // The runtime a session on the shared Codex provider runs on: Codex for an admin's; for a member's, the row
    // resolves to nothing, as a slug nothing holds — the very slug the claim never hands out.
    const onCodex = (ownerId: string) => sessionExecRuntime(db as never, { provider: sharedCodex.slug, providerBuiltin: false, ownerId });
    assert.equal(await onCodex(admin.id), AgentProvider.CODEX);
    assert.equal(await onCodex(member.id), AgentProvider.CLAUDE);
  });

  await t.test('(4) the role is read at every claim: promoted, a member runs on the shared provider; demoted again, they do not', async () => {
    const carol = await person('carol');
    const at = await machine(carol.id, 'carol');
    const first = await sessionOn(carol.id, at, sharedClaude.slug, RunStatus.PENDING, { model: 'deepseek-v4-pro' });
    assert.equal(await claimOn(at, handedToMember), null);
    assert.equal((await recorded(first)).error, ADMIN_ONLY_PROVIDER_ERROR);

    await db.user.update({ where: { id: carol.id }, data: { role: 'ADMIN' } });
    const promoted = await claimOn(at, handedToAdmin);
    assert.equal(promoted?.sessionId, first);
    assert.equal(promoted?.agent.env?.ANTHROPIC_AUTH_TOKEN, CLAUDE_KEY);
    // The claim that ran it is the answer to why it waited: the notice goes with it.
    assert.equal((await recorded(first)).error, null);

    await db.user.update({ where: { id: carol.id }, data: { role: 'MEMBER' } });
    const second = await sessionOn(carol.id, at, sharedClaude.slug, RunStatus.PENDING, { model: 'deepseek-v4-pro' });
    assert.equal(await claimOn(at, handedToMember), null);
    assert.deepEqual(await recorded(second), { provider: sharedClaude.slug, status: RunStatus.PENDING, error: ADMIN_ONLY_PROVIDER_ERROR });
  });

  await t.test('(5) a key shared through a shared pool runs the sessions of the people its admin adds, through the gateway, on a token of their own', async () => {
    const poolKey = `sk-proj-${MARK}-${randomUUID().replace(/-/g, '')}`;
    const made = await pools.create(admin.id, { label: `Team Codex ${randomUUID()}` });
    const pool = await db.providerPool.findUniqueOrThrow({ where: { id: made.id }, select: { id: true, slug: true } });
    await pools.addKey(admin.id, pool.id, { label: 'team key', apiKey: poolKey });
    await pools.addPerson(admin.id, pool.id, { email: member.email });

    const at = await machine(member.id, 'member-pool');
    const session = await sessions.create(member.id, { prompt: 'hello', title: 'on the pool', workspaceId: at.workspaceId, provider: pool.slug });
    const claimed = await claimOn(at, handedToMember);
    assert.equal(claimed?.sessionId, session.id);
    const env = claimed!.agent.env ?? {};
    assert.match(env.OPENAI_API_KEY ?? '', /^orbit-gw-[A-Za-z0-9_-]{43}$/, "not a person's token");
    assert.ok(env.OPENAI_BASE_URL?.endsWith('/api/gw/codex'), `not the gateway: ${env.OPENAI_BASE_URL}`);
    assert.equal(wire(claimed).includes(poolKey), false, "the pool's key was handed to the member's runner");
  });

  await t.test("(6) nothing handed to any of the member's runners, and no table, holds a shared key in the clear", async () => {
    // The member's sessions, every one of them, as a restarted runner of theirs would rebuild them now.
    const runners = await db.runner.findMany({ where: { ownerId: member.id }, select: { id: true } });
    for (const { id } of runners) handedToMember.push(await runnerApi.reclaim({ id, ownerId: member.id }));
    assert.ok(handedToMember.length > runners.length, 'nothing was handed to the member');
    assert.equal(wire(handedToMember).includes(MARK), false, "a shared key reached one of the member's runners");
    // The positive control: the same check finds the key in what the admin's runners were handed.
    assert.ok(wire(handedToAdmin).includes(CLAUDE_KEY), 'the check cannot see a key');

    const { rows: tables } = await client.query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY 1`,
    );
    const names = tables.map((row) => row.name);
    for (const table of ['model_provider', 'session', 'workspace', 'conversation_turn', 'run_event', 'pool_api_key']) {
      assert.ok(names.includes(table), `the sweep did not read ${table}`);
    }
    const holding: string[] = [];
    for (const name of names) {
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${name.replace(/"/g, '""')}" AS r WHERE strpos(r::text, $1) > 0`,
        [MARK],
      );
      if (rows[0].n > 0) holding.push(name);
    }
    assert.deepEqual(holding, [], 'a table holds a shared key in the clear');
  });
});
