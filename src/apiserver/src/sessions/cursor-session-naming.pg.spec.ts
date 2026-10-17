/**
 * CURSOR CLI'S OWN TITLE FOR A SESSION — KEPT WHEN ITS CLAIM ASKED FOR ONE, AND NEVER OVER A TITLE THAT IS
 * ALREADY SOMEBODY'S.
 *
 * Cursor CLI names a session in its first turn (session_info_update, docs/cursor-runtime-contract.md §3.2).
 * Its runner reports that title through POST /runner/sessions/:id/naming only when the claim carries `naming`
 * (runner-go cursor_acp.go), and the report is kept only while the session still carries the title the
 * claim did (SessionsService.applyEngineTitle). On real PostgreSQL, through the production claim
 * (QueueService.claimSessionForRunner), the production report route (RunnerApiController.sessionNaming) and
 * SessionsService's create and rename:
 *
 *   (1) A Cursor CLI session nothing else names — on the runner's sign-in, or on a Cursor key saved in
 *       Orbit, which the server cannot spend — is claimed with `naming`, and the title its runner reports
 *       against the claimed one lands.
 *   (2) A session that runs a task keeps the task's title: its claim asks for none.
 *   (3) A person's rename stands: made before the claim, the claim asks for none; made after it, the
 *       runner's report is refused.
 *   (4) DeepSeek's title stands: a session the server names on its DeepSeek key is claimed without
 *       `naming`, even while DeepSeek's answer is still on its way.
 *   (5) Claude Code and Codex sessions are claimed with `naming` as before, and their titles land.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/cursor-session-naming.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Prisma, PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';
import { AgentProvider, PermissionMode, type ClaimedSession } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { ProviderPlanUsageService } from '../providers/plan-usage.service';
import { ProvidersService } from '../providers/providers.service';
import { QueueService as RealQueueService } from '../queue/queue.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { ENGINE_NAMING_INSTRUCTIONS } from './naming';
import { SessionsService } from './sessions.service';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY ??= 'cursor-session-naming-pg-spec';

const PROMPT = 'Fix the flaky login timeout on Safari\nIt fails about once in ten runs.';
/** The title cut from PROMPT, which a session created without one carries until something names it. */
const FALLBACK = 'Fix the flaky login timeout on Safari';
const NAMING = { description: PROMPT, instructions: ENGINE_NAMING_INSTRUCTIONS };
/** The title Cursor CLI's session_info_update gives, as its runner reports it. */
const CURSOR_TITLE = 'Safari login timeout';
/** A claim from a runner that runs every engine, Cursor CLI's included. */
const CURRENT = [
  AgentProvider.CLAUDE, AgentProvider.CODEX, AgentProvider.KIMI, AgentProvider.OPENCODE,
  AgentProvider.ANTIGRAVITY, AgentProvider.DSH, AgentProvider.CURSOR,
];
/** Where case (4) aims the server's DeepSeek key; this spec's fetch answers it, and nothing else does. */
const DEEPSEEK = 'https://deepseek.cursor-session-naming.invalid';

const quiet = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;

async function until(check: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('P5a Cursor CLI session titles on PostgreSQL', { concurrency: 1, timeout: 300_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(URL);
  const prisma = db as unknown as PrismaService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, quiet);
  const providers = new ProvidersService(prisma, quiet, { snapshot: () => null } as never);
  const claims = new RealQueueService(prisma, quiet, new ProviderPlanUsageService(quiet));
  const api = new RunnerApiController(
    prisma, queue, quiet, {} as never, {} as never, {} as never,
    undefined, undefined, undefined, undefined, undefined, sessions,
  );
  // The server holds no DeepSeek key unless a case gives it one.
  const deepSeek = { key: process.env.DEEPSEEK_API_KEY, baseUrl: process.env.DEEPSEEK_BASE_URL };
  delete process.env.DEEPSEEK_API_KEY;
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  t.after(async () => {
    restore('DEEPSEEK_API_KEY', deepSeek.key);
    restore('DEEPSEEK_BASE_URL', deepSeek.baseUrl);
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  type Machine = { ownerId: string; runnerId: string; workspaceId: string };
  /** An owner, a runner of theirs that runs Cursor CLI signed in, and a workspace on it. */
  async function machine(label: string): Promise<Machine> {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    await db.user.create({ data: { id: ownerId, email: `${label}-${ownerId}@cursor-session-naming.invalid`, name: 'The owner', passwordHash: 'x' } });
    await db.runner.create({ data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: ['provider:cursor'], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
      engines: [{ engine: 'cursor', installed: true, auth: 'yes' }] as unknown as Prisma.InputJsonValue,
    } });
    await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true } });
    return { ownerId, runnerId, workspaceId };
  }
  /** A session through the API's door with no title of its own: it carries the one cut from PROMPT. */
  const create = async (m: Machine, provider: string) =>
    (await sessions.create(m.ownerId, { prompt: PROMPT, workspaceId: m.workspaceId, provider } as never)).id;
  /** The next session the machine's runner is handed. */
  async function claim(m: Machine): Promise<ClaimedSession> {
    const claimed = await claims.claimSessionForRunner({ id: m.runnerId, supportedProviders: CURRENT });
    assert.ok(claimed, 'the runner was offered no session');
    return claimed;
  }
  /** What the runner reports once the engine has named the session: its title, against the claimed one. */
  const report = (m: Machine, claimed: ClaimedSession, title = CURSOR_TITLE) =>
    api.sessionNaming({ id: m.runnerId }, claimed.sessionId, { replaces: claimed.title, title });
  const titleOf = async (id: string) => (await db.session.findUniqueOrThrow({ where: { id }, select: { title: true } })).title;

  await t.test('P5a a Cursor CLI session nothing else names is claimed with naming, and the title its runner reports lands', async () => {
    // On the runner's own sign-in.
    const m = await machine('sign-in');
    const id = await create(m, AgentProvider.CURSOR);
    assert.equal(await titleOf(id), FALLBACK);
    const claimed = await claim(m);
    assert.equal(claimed.sessionId, id);
    assert.equal(claimed.agent.provider, AgentProvider.CURSOR);
    assert.equal(claimed.title, FALLBACK);
    assert.deepEqual(claimed.naming, NAMING);
    assert.deepEqual(await report(m, claimed), { applied: true });
    assert.equal(await titleOf(id), CURSOR_TITLE);
    // A later title from the same process is reported against the same claimed title, which is gone.
    assert.deepEqual(await report(m, claimed, 'Another Cursor title'), { applied: false });
    assert.equal(await titleOf(id), CURSOR_TITLE);

    // On a Cursor key saved in Orbit: Cursor CLI alone spends one, so the server did not name the session.
    const k = await machine('cursor-key');
    const apiKey = `key_p5a${randomUUID().replace(/-/g, '')}`;
    const key = (await providers.create(k.ownerId, {
      label: 'Cursor', presetSlug: 'cursor-api', baseUrl: 'https://api2.cursor.sh', apiKey,
    } as never)) as unknown as { slug: string };
    const onKey = await create(k, key.slug);
    const keyed = await claim(k);
    assert.equal(keyed.sessionId, onKey);
    assert.equal(keyed.agent.provider, AgentProvider.CURSOR);
    assert.equal(keyed.agent.env?.ORBIT_CURSOR_API_KEY, apiKey, 'it runs on the key');
    assert.deepEqual(keyed.naming, NAMING);
    assert.deepEqual(await report(k, keyed), { applied: true });
    assert.equal(await titleOf(onKey), CURSOR_TITLE);
  });

  await t.test("P5a a Cursor CLI session that runs a task keeps the task's title", async () => {
    const m = await machine('task');
    // Titled like the fallback on purpose: the task is all that tells this session from case (1)'s.
    const task = await db.task.create({ data: {
      ownerId: m.ownerId, creatorType: 'USER', creatorId: m.ownerId, title: FALLBACK, completionCriterion: 'EVIDENCE_JUDGMENT',
    } });
    const id = (await db.session.create({ data: {
      ownerId: m.ownerId, creatorId: m.ownerId, workspaceId: m.workspaceId, assignedRunnerId: m.runnerId,
      taskId: task.id, startsTaskWork: true, title: task.title, prompt: PROMPT,
      provider: AgentProvider.CURSOR, providerBuiltin: true, engine: AgentProvider.CURSOR, model: 'default[]',
      usesRuntimeDefaultModel: true, permissionMode: PermissionMode.ACCEPT_EDITS, status: RunStatus.PENDING,
    } })).id;
    const claimed = await claim(m);
    assert.equal(claimed.sessionId, id);
    assert.equal(claimed.agent.provider, AgentProvider.CURSOR);
    assert.equal(claimed.naming, undefined);
    assert.equal(await titleOf(id), FALLBACK);
  });

  await t.test("P5a a person's rename stands over Cursor CLI's title, made before the claim or after it", async () => {
    // Before: the session has a title of its own, so its claim asks for none.
    const before = await machine('renamed-before');
    const early = await create(before, AgentProvider.CURSOR);
    await sessions.rename(before.ownerId, early, 'My own name');
    const unasked = await claim(before);
    assert.equal(unasked.sessionId, early);
    assert.equal(unasked.naming, undefined);
    assert.equal(await titleOf(early), 'My own name');

    // After: the claim asked, and the runner's report finds the title it would replace gone.
    const after = await machine('renamed-after');
    const late = await create(after, AgentProvider.CURSOR);
    const asked = await claim(after);
    assert.equal(asked.sessionId, late);
    assert.deepEqual(asked.naming, NAMING);
    await sessions.rename(after.ownerId, late, 'My own name');
    assert.deepEqual(await report(after, asked), { applied: false });
    assert.equal(await titleOf(late), 'My own name');
  });

  await t.test("P5a DeepSeek's title stands: a Cursor CLI session the server names is claimed without naming", async () => {
    const m = await machine('deepseek');
    const originalFetch = globalThis.fetch;
    let asked!: () => void;
    const deepSeekAsked = new Promise<void>((resolve) => { asked = resolve; });
    let answer!: (title: string) => void;
    const deepSeekAnswer = new Promise<string>((resolve) => { answer = resolve; });
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith(DEEPSEEK)) return originalFetch(input, init);
      asked();
      const title = await deepSeekAnswer;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title, tags: [] }) } }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
    process.env.DEEPSEEK_BASE_URL = DEEPSEEK;
    try {
      const id = await create(m, AgentProvider.CURSOR);
      await deepSeekAsked;
      // DeepSeek has not answered yet: the session still carries the fallback, and its claim asks Cursor CLI
      // for nothing.
      const claimed = await claim(m);
      assert.equal(claimed.sessionId, id);
      assert.equal(claimed.title, FALLBACK);
      assert.equal(claimed.naming, undefined);
      answer('Safari login flake');
      await until(async () => (await titleOf(id)) === 'Safari login flake', "DeepSeek's title did not land");
    } finally {
      answer('Cleanup title');
      globalThis.fetch = originalFetch;
      delete process.env.DEEPSEEK_API_KEY;
      restore('DEEPSEEK_BASE_URL', deepSeek.baseUrl);
    }
  });

  await t.test('P5a Claude Code and Codex sessions are claimed with naming as before, and their titles land', async () => {
    for (const engine of [AgentProvider.CLAUDE, AgentProvider.CODEX]) {
      const m = await machine(engine);
      const id = await create(m, engine);
      const claimed = await claim(m);
      assert.equal(claimed.sessionId, id, engine);
      assert.equal(claimed.agent.provider, engine);
      assert.deepEqual(claimed.naming, NAMING, engine);
      assert.deepEqual(await report(m, claimed, `Named by ${engine}`), { applied: true }, engine);
      assert.equal(await titleOf(id), `Named by ${engine}`);
    }
  });
});
