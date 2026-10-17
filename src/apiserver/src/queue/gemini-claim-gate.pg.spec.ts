/**
 * A Gemini key at claim time, on real PostgreSQL: a session on a configured provider that borrows
 * Antigravity is handed only to a runner that advertises `antigravity`. A runner that does not would
 * read the `antigravity` job as Claude — every runner released before the engine does — so the claim
 * withholds it and says why on the row, reclaim leaves it out, and the runner that names the
 * runtime gets an `antigravity` job carrying the row's own key and endpoint.
 *
 * Production code between the rows and the job: QueueService.claimSessionForRunner, and
 * RunnerApiController's claim and reclaim, which a runner calls with its X-Orbit-Supported-Providers
 * header. It only adds rows, under ids and slugs of its own, and refuses to run anywhere but the
 * disposable server `coordinator-pg-test-safety` identifies.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';
import { AgentProvider } from '@orbit/shared';
import { Client } from 'pg';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { encryptSecret } from '../providers/provider-crypto';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { ANTIGRAVITY_RUNNER_UPGRADE_ERROR, PROVIDER_UNAVAILABLE_ERROR } from '../runner-api/runner-provider-support';
import { QueueService } from './queue.service';

const URL = process.env.COORDINATOR_PG_URL;
// The spec encrypts the row's key and the claim decrypts it; both only need the same secret.
process.env.PROVIDER_SECRET_KEY ??= 'gemini-claim-gate-spec';

/** What every runner in the field sent before the engine existed, and what one that drives agy sends. */
const LEGACY = [AgentProvider.CLAUDE, AgentProvider.CODEX, AgentProvider.OPENCODE];
const CURRENT = [...LEGACY, AgentProvider.ANTIGRAVITY];

const suite = URL ? test : test.skip;

suite('a Gemini key at claim time, on real PostgreSQL', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  const db = prismaClientFor(URL);
  t.after(async () => {
    await db.$disconnect();
    await client.end();
  });

  const realtime = {
    publish: () => {},
    publishSessionUpdated: () => {},
    publishSessionCreated: () => {},
    publishQueuedTurnsChanged: () => {},
    publishForUser: () => {},
    publishForAllUsers: () => {},
    notifyInbox: () => {},
  } as unknown as RealtimeService;
  const queue = new QueueService(db as unknown as PrismaService, realtime);
  const runnerApi = new RunnerApiController(
    db as never, queue as never, realtime as never, {} as never, {} as never, {} as never,
  );

  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `gemini-${ownerId}@claim-gate.invalid`, name: 'gemini', passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'gemini-runner', tokenHash: `x-${runnerId}`,
      status: RunnerStatus.ONLINE, maxConcurrent: 4,
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: 'gemini-ws', enabled: true, workDir: '/tmp/gemini' },
  });
  const runner = { id: runnerId, ownerId };

  /** A row the Gemini preset saves, with a key of its own; `enabled` false is one switched off. */
  async function geminiProvider(key: string, enabled = true): Promise<string> {
    const row = await db.modelProvider.create({
      data: {
        slug: `gemini-${randomUUID()}`,
        label: 'Gemini',
        runtime: AgentProvider.ANTIGRAVITY,
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKeyEnc: encryptSecret(key),
        presetSlug: 'gemini',
        followsPreset: true,
        enabled,
        ownerId,
      },
    });
    return row.slug;
  }
  async function queuedSession(provider: string): Promise<string> {
    const session = await db.session.create({
      data: {
        title: 'gemini',
        prompt: 'hello',
        status: RunStatus.PENDING,
        ownerId,
        creatorId: ownerId,
        workspaceId,
        assignedRunnerId: runnerId,
        provider,
        providerBuiltin: false,
        usesRuntimeDefaultModel: true,
      },
      select: { id: true },
    });
    return session.id;
  }
  const row = (id: string) =>
    db.session.findUniqueOrThrow({ where: { id }, select: { status: true, error: true } });
  /** The runner's long poll, as the controller answers it, hung up as soon as it has nothing to hand
   *  over — the claim waits up to 25s otherwise. */
  const longPoll = (providerHeader: string) => {
    const res = { once: (event: string, hangUp: () => void) => event === 'close' && setTimeout(hangUp, 100) };
    return runnerApi.claim(runner, undefined, providerHeader, res as never);
  };

  const key = `AIza-${randomUUID()}`;
  const gemini = await geminiProvider(key);
  const sessionId = await queuedSession(gemini);

  await t.test('(1) a runner that does not advertise antigravity is not handed the session', async () => {
    assert.equal(await queue.claimSessionForRunner({ id: runnerId, supportedProviders: LEGACY }, 0, false, false), null);
    assert.equal((await row(sessionId)).status, RunStatus.PENDING);
    // Nor on the runner's own long poll, which says on the row why it waits.
    assert.equal(await longPoll(LEGACY.join(',')), null);
    assert.deepEqual(await row(sessionId), { status: RunStatus.PENDING, error: ANTIGRAVITY_RUNNER_UPGRADE_ERROR });
  });

  await t.test('(2) its reclaim leaves the session out, so it is not rebuilt as Claude either', async () => {
    const reclaimed = (await runnerApi.reclaim(runner, undefined, LEGACY.join(','))).sessions;
    assert.ok(!reclaimed.some((s) => s.sessionId === sessionId), 'a legacy reclaim was handed the Gemini session');
  });

  await t.test('(3) a runner that advertises antigravity claims it as an antigravity job on the row’s key', async () => {
    const claimed = await queue.claimSessionForRunner({ id: runnerId, supportedProviders: CURRENT }, 0, false, false);
    assert.ok(claimed, 'the runner that names antigravity was offered nothing');
    assert.equal(claimed.sessionId, sessionId);
    assert.equal(claimed.provider, AgentProvider.ANTIGRAVITY);
    assert.equal(claimed.agent.provider, AgentProvider.ANTIGRAVITY);
    assert.equal(claimed.agent.env?.GEMINI_API_KEY, key);
    assert.equal(claimed.agent.env?.GOOGLE_GEMINI_BASE_URL, 'https://generativelanguage.googleapis.com');
    // No catalogue reported on this runner: the preset's own default.
    assert.equal(claimed.agent.model, 'gemini-3.8-flash');
    // The notice the legacy poll left is answered by the claim itself.
    assert.deepEqual(await row(sessionId), { status: RunStatus.RUNNING, error: null });
  });

  await t.test('(4) and its reclaim keeps the session, on the antigravity runtime', async () => {
    const reclaimed = (await runnerApi.reclaim(runner, undefined, CURRENT.join(','))).sessions;
    const mine = reclaimed.find((s) => s.sessionId === sessionId);
    assert.ok(mine, 'a capable reclaim lost the Gemini session');
    assert.equal(mine.provider, AgentProvider.ANTIGRAVITY);
    assert.equal(mine.agent.env?.GEMINI_API_KEY, key);
  });

  await t.test('(5) a switched-off Gemini row is unavailable instead of dispatching as Claude', async () => {
    const disabled = await queuedSession(await geminiProvider(`AIza-${randomUUID()}`, false));
    const claimed = await queue.claimSessionForRunner({ id: runnerId, supportedProviders: LEGACY }, 0, false, false);
    assert.equal(claimed, null);
    assert.deepEqual(await row(disabled), { status: RunStatus.PENDING, error: PROVIDER_UNAVAILABLE_ERROR });
    const reclaimed = await runnerApi.reclaim(runner, undefined, CURRENT.join(','));
    assert.ok(!reclaimed.sessions.some((session) => session.sessionId === disabled));
  });
});
