import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { ConflictException } from '@nestjs/common';
import { RunStatus, RunnerStatus } from '@prisma/client';
import { AgentProvider } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { encryptSecret } from '../providers/provider-crypto';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController, SESSION_TERMINAL_HANDOFF_V1 } from '../runner-api/runner-api.controller';
import {
  DSH_NOT_INSTALLED_ERROR,
  DSH_PLATFORM_UNSUPPORTED_ERROR,
  DSH_RUNNER_UPGRADE_ERROR,
  DSH_VERSION_INCOMPATIBLE_ERROR,
} from '../runner-api/runner-provider-support';
import { SessionsService } from '../sessions/sessions.service';
import { QueueService } from './queue.service';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY ??= 'dsh-install-gate-spec';
const LEGACY = [AgentProvider.CLAUDE, AgentProvider.CODEX, AgentProvider.OPENCODE, AgentProvider.KIMI, AgentProvider.ANTIGRAVITY];
const CURRENT = [...LEGACY, AgentProvider.DSH];
// Engine reports as a runner built from this tree sends them (enginehealth.go, doctor.go checkEngine).
const health = { credentialPresent: false, modelCatalogReadable: false, requestValidation: 'unknown', sandboxEnforcement: 'unknown' };
const ENGINES = {
  notInstalled: [{ engine: 'dsh', installed: false, auth: 'unknown',
    installationError: "DSH_NOT_INSTALLED: DeepSeek Harness 0.2.0-rc.2 is not installed in Orbit's version directory: stat engines/dsh/0.2.0-rc.2: no such file or directory" }],
  installed: [{ engine: 'dsh', installed: true, version: '0.2.0-rc.2', auth: 'unknown', dsh: { ...health, versionCompatible: true } }],
  macos: [{ engine: 'dsh', installed: false, auth: 'unknown',
    installationError: 'DSH_PLATFORM_UNSUPPORTED: DeepSeek Harness 0.2.0-rc.2 is supported only on Linux x64; this runner is darwin/arm64' }],
  otherVersion: [{ engine: 'dsh', installed: true, version: '0.2.0-rc.1', auth: 'unknown',
    installationError: 'DSH_VERSION_INCOMPATIBLE: DeepSeek Harness version incompatible: supported version is exactly 0.2.0-rc.2', dsh: { ...health, versionCompatible: false } }],
};

// No skip path: a missing server is a failure (scripts/run-pg-spec.sh refuses a skipped run).
test('dsh install gate on PostgreSQL', { timeout: 300_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(URL);
  t.after(async () => { await db.$disconnect(); await sql.end(); });

  const realtime = {
    publish: () => {}, publishSessionUpdated: () => {}, publishSessionCreated: () => {},
    publishWorkspaceChanged: () => {}, publishQueuedTurnsChanged: () => {}, publishForUser: () => {},
    publishForAllUsers: () => {}, notifyInbox: () => {}, drainCancellations: async () => [],
    drainMergeRequests: async () => [], drainCommitRequests: async () => [], drainArtifactRequests: async () => [],
  } as unknown as RealtimeService;
  const queue = new QueueService(db as unknown as PrismaService, realtime);
  const api = new RunnerApiController(db as never, queue as never, realtime as never, {} as never, {} as never, {} as never);
  const sessions = new SessionsService(db as unknown as PrismaService,
    { notifySessionQueued: () => undefined, accountPoolRefusal: async () => null } as never, realtime);

  async function fixture() {
    const ownerId = randomUUID();
    const id = randomUUID();
    const workspaceId = randomUUID();
    await db.user.create({ data: { id: ownerId, email: `dsh-install-${ownerId}@gate.invalid`, name: 'dsh', passwordHash: 'x' } });
    await db.runner.create({ data: { id, ownerId, name: 'dsh-install', tokenHash: `x-${id}`, status: RunnerStatus.ONLINE, maxConcurrent: 8 } });
    await db.workspace.create({ data: {
      id: workspaceId, ownerId, runnerId: id, name: 'dsh', enabled: true, workDir: '/tmp/dsh-install-gate',
      env: { ORBIT_DSH_API_KEY: 'native-session-key' },
    } });
    const runner = { id, ownerId, version: null };
    const beat = (providers: readonly AgentProvider[], engines: unknown) => api.heartbeat(
      runner, { status: RunnerStatus.ONLINE, idleCapacity: 1, engines } as never, undefined, providers.join(','),
    );
    // What a current runner's claim carries: a revived session is handed only to one that can take
    // over its terminal handoff marker.
    const poll = (providers: readonly AgentProvider[]) => {
      const res = { once: (_event: string, close: () => void) => setTimeout(close, 100) };
      return api.claim(runner, SESSION_TERMINAL_HANDOFF_V1, providers.join(','), res as never);
    };
    const configured = `harness-${randomUUID()}`;
    await db.modelProvider.create({ data: {
      slug: configured, label: 'Harness', runtime: 'dsh', enabled: true, ownerId,
      baseUrl: 'https://api.deepseek.com', apiKeyEnc: encryptSecret('configured-session-key'),
    } });
    // A Harness session that already ran on this runner, as one the runner reported and settled.
    const persisted = async (status: RunStatus, provider = 'dsh') => (await db.session.create({ data: {
      title: 'persisted dsh', prompt: 'first', ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: id,
      provider, providerBuiltin: provider === 'dsh', status, numTurns: 1, usesRuntimeDefaultModel: true,
      runtimeSessionId: randomUUID(), startedAt: new Date(), permissionMode: 'default',
      ...(status === RunStatus.CANCELLED ? { completedAt: new Date(), endReason: 'ended' } : {}),
    } })).id;
    const create = (provider: string, prompt = `create ${randomUUID()}`) =>
      sessions.create(ownerId, { workspaceId, provider, prompt, permissionMode: 'default' });
    return { ownerId, runner, beat, poll, configured, persisted, create, workspaceId };
  }
  const row = (id: string) => db.session.findUniqueOrThrow({ where: { id } });
  const refusal = async (operation: () => Promise<unknown>, message: string) => {
    await assert.rejects(operation, (error: unknown) => {
      assert.ok(error instanceof ConflictException, String(error));
      assert.equal(error.message, message);
      return true;
    });
  };
  const turnsOf = (sessionId: string) => db.conversationTurn.findMany({
    where: { sessionId, kind: 'message' }, orderBy: { seq: 'asc' }, select: { content: true, status: true },
  });

  const f = await fixture();
  const followUp = await f.persisted(RunStatus.AWAITING_INPUT);
  const borrowed = await f.persisted(RunStatus.AWAITING_INPUT, f.configured);
  const ended = await f.persisted(RunStatus.CANCELLED);

  await t.test('IG-PG1 an upgraded runner without the pinned CLI keeps declaring dsh and reports it not installed', async () => {
    await f.beat(CURRENT, ENGINES.notInstalled);
    const runner = await db.runner.findUniqueOrThrow({ where: { id: f.runner.id } });
    assert.ok(runner.capabilities.includes('provider:dsh'), 'the declaration is protocol support and stays');
    assert.ok(runner.capabilitiesReportedAt);
    assert.deepEqual((runner.engines as Array<{ engine: string; installed: boolean; installationError?: string }>)
      .map(({ engine, installed, installationError }) => ({ engine, installed, installationError })),
    [{ engine: 'dsh', installed: false, installationError: 'DSH_NOT_INSTALLED' }]);
  });

  await t.test('IG-PG2 creating a Harness session there is refused with the not-installed notice and writes nothing', async () => {
    for (const provider of ['dsh', f.configured]) {
      const prompt = `refused ${randomUUID()}`;
      await refusal(() => f.create(provider, prompt), DSH_NOT_INSTALLED_ERROR);
      assert.equal(await db.session.count({ where: { prompt } }), 0, `${provider} left a session behind`);
    }
  });

  await t.test('IG-PG3 a persisted Harness session keeps its follow-up queued with the notice and is never claimed', async () => {
    for (const id of [followUp, borrowed]) {
      await sessions.createTurn(f.ownerId, id, { clientTurnId: `follow-${id}`, content: `follow-up for ${id}` });
      assert.equal((await row(id)).status, RunStatus.PENDING);
    }
    await refusal(() => sessions.resume(f.ownerId, ended, { clientTurnId: 'revive-ended', content: 'revive the ended one' }),
      DSH_NOT_INSTALLED_ERROR);
    for (let poll = 0; poll < 3; poll += 1) assert.equal(await f.poll(CURRENT), null, 'a Harness session was handed to a runner without the CLI');
    for (const id of [followUp, borrowed]) {
      const waiting = await row(id);
      assert.equal(waiting.status, RunStatus.PENDING, 'the waiting session left PENDING');
      assert.equal(waiting.error, DSH_NOT_INSTALLED_ERROR);
      assert.equal(waiting.numTurns, 1, 'a turn ran');
      assert.deepEqual((await turnsOf(id)).map((turn) => turn.status), ['PENDING'], 'the follow-up was delivered');
    }
    const stillEnded = await row(ended);
    assert.equal(stillEnded.status, RunStatus.CANCELLED, 'a refused resume moved the ended session');
    assert.equal((await turnsOf(ended)).length, 0, 'a refused resume queued its message');
  });

  await t.test('IG-PG4 a Claude session on the same runner is not held behind the Harness install', async () => {
    const claude = await f.create('claude');
    const job = await f.poll(CURRENT);
    assert.equal(job?.sessionId, claude.id);
    assert.equal(job?.provider, AgentProvider.CLAUDE);
    await db.session.update({ where: { id: claude.id }, data: { status: RunStatus.CANCELLED, completedAt: new Date() } });
  });

  await t.test('IG-PG5 after the install the next heartbeat hands the same sessions over and new ones are created', async () => {
    await f.beat(CURRENT, ENGINES.installed);
    const claimed = new Map<string, { provider?: string }>();
    for (let poll = 0; poll < 2; poll += 1) {
      const job = await f.poll(CURRENT);
      assert.ok(job, 'a waiting Harness session was not handed over after the install');
      claimed.set(job.sessionId, { provider: job.provider });
    }
    assert.deepEqual([...claimed.keys()].sort(), [followUp, borrowed].sort());
    for (const id of [followUp, borrowed]) {
      assert.equal(claimed.get(id)?.provider, AgentProvider.DSH);
      const running = await row(id);
      assert.equal(running.status, RunStatus.RUNNING);
      assert.equal(running.error, null, 'the not-installed notice survived the claim');
    }
    const revived = await sessions.resume(f.ownerId, ended, { clientTurnId: 'revive-ended', content: 'revive the ended one' });
    assert.equal(revived.revived, true);
    assert.equal((await f.poll(CURRENT))?.sessionId, ended);
    // A new session naming the built-in `dsh` runs on the owner's default DeepSeek key, the workspace's
    // own key notwithstanding (docs/provider-engine-contract.md §3.3); that one stays the credential of
    // the built-in sessions it already ran.
    const fresh = await f.create('dsh');
    assert.deepEqual(await db.session.findUniqueOrThrow({ where: { id: fresh.id }, select: { provider: true, providerBuiltin: true, engine: true } }),
      { provider: f.configured, providerBuiltin: false, engine: AgentProvider.DSH });
    const job = await f.poll(CURRENT);
    assert.equal(job?.sessionId, fresh.id);
    assert.equal(job?.provider, AgentProvider.DSH);
    assert.equal(job?.agent.env?.ORBIT_DSH_API_KEY, 'configured-session-key');
  });

  await t.test('IG-PG6 platform and version reports refuse with their own notices', async () => {
    const g = await fixture();
    const waiting = await g.persisted(RunStatus.AWAITING_INPUT);
    await sessions.createTurn(g.ownerId, waiting, { clientTurnId: 'platform-follow-up', content: 'follow-up' });
    for (const [engines, notice] of [[ENGINES.macos, DSH_PLATFORM_UNSUPPORTED_ERROR], [ENGINES.otherVersion, DSH_VERSION_INCOMPATIBLE_ERROR]] as const) {
      await g.beat(CURRENT, engines);
      await refusal(() => g.create('dsh'), notice);
      assert.equal(await g.poll(CURRENT), null);
      assert.equal((await row(waiting)).error, notice);
      assert.equal((await row(waiting)).status, RunStatus.PENDING);
    }
  });

  await t.test('IG-PG7 a runner that does not declare dsh still waits for an upgrade first (P1b)', async () => {
    const g = await fixture();
    await g.beat(LEGACY, ENGINES.notInstalled);
    await refusal(() => g.create('dsh'), DSH_RUNNER_UPGRADE_ERROR);
    const waiting = await g.persisted(RunStatus.AWAITING_INPUT);
    await sessions.createTurn(g.ownerId, waiting, { clientTurnId: 'legacy-follow-up', content: 'follow-up' });
    assert.equal(await g.poll(CURRENT), null, 'the request header cannot stand in for the heartbeat declaration');
    assert.equal((await row(waiting)).error, DSH_RUNNER_UPGRADE_ERROR);
  });
});
