/**
 * A claim scoped to named sessions, on real PostgreSQL (runner-go drainClaimScope). A runner draining for
 * an update takes no new work, but a session whose engine is running a turn on it — one the engine started
 * by itself, so the row read AWAITING_INPUT — is moved to PENDING by any message queued to it. Unclaimed,
 * that row read PENDING for the whole drain while its engine was visibly at work. The draining runner now
 * claims with `drainScope=<those sessions>`: the claim takes one of them and no other session, so the row
 * reads RUNNING and nothing new starts on the draining runner.
 *
 * Production code between the rows and the job: RunnerApiController.claim and
 * QueueService.claimSessionForRunner. It only adds rows of its own, and refuses to run anywhere but the
 * disposable server `coordinator-pg-test-safety` identifies.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { RunStatus, RunnerStatus } from '@prisma/client';
import { AgentProvider } from '@orbit/shared';
import { Client } from 'pg';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { QueueService } from './queue.service';

const URL = process.env.COORDINATOR_PG_URL;
const PROVIDERS = [AgentProvider.CLAUDE, AgentProvider.CODEX, AgentProvider.OPENCODE, AgentProvider.ANTIGRAVITY].join(',');

const suite = URL ? test : test.skip;

suite('a drain-scoped claim, on real PostgreSQL', async (t) => {
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
    db as never, queue as never, realtime as never, {} as never, { issue: async () => 'orchestration-credential' } as never, {} as never,
  );

  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `drain-${ownerId}@drain-scope.invalid`, name: 'drain', passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'draining-runner', tokenHash: `x-${runnerId}`,
      status: RunnerStatus.ONLINE, maxConcurrent: 8, heartbeatDraining: true,
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: 'drain-ws', enabled: true, workDir: '/tmp/drain' },
  });
  const runner = { id: runnerId, ownerId };

  let minute = 0;
  /** A PENDING Claude session on the runner; earlier ones are created first, so an unscoped claim takes them first. */
  async function queued(title: string): Promise<string> {
    const at = new Date(Date.UTC(2026, 10, 12, 4, minute++));
    const session = await db.session.create({
      data: {
        title, prompt: 'hello', status: RunStatus.PENDING, ownerId, creatorId: ownerId, workspaceId,
        assignedRunnerId: runnerId, provider: AgentProvider.CLAUDE, providerBuiltin: true,
        engine: AgentProvider.CLAUDE, usesRuntimeDefaultModel: true, createdAt: at, lastTurnAt: at,
      },
      select: { id: true },
    });
    return session.id;
  }
  const status = async (id: string) => (await db.session.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
  // The route as Nest calls it, its query parameter last. Typed loosely so this spec compiles, and goes red,
  // against a controller that has no drainScope parameter yet.
  const claimRoute = runnerApi.claim.bind(runnerApi) as (...args: unknown[]) => Promise<{ sessionId: string } | null>;
  const claim = (drainScope?: string) => claimRoute(runner, PROVIDERS, undefined, undefined, undefined, drainScope);

  // A brand-new session waits first in the queue; the second is the one whose engine runs a turn on
  // the draining runner, its message queued.
  const fresh = await queued('new work');
  const atWork = await queued('engine at work');

  await t.test('the scoped claim takes the session it names, and leaves the new one queued', async () => {
    const job = await claim(atWork);
    assert.equal(job?.sessionId, atWork, 'the claim did not take the session whose engine is at work');
    assert.equal(await status(atWork), RunStatus.RUNNING);
    assert.equal(await status(fresh), RunStatus.PENDING, 'the draining runner took new work');
  });

  await t.test('a scope naming no PENDING session claims nothing', async () => {
    assert.equal(await claim(atWork), null, 'a RUNNING session was claimed again');
    assert.equal(await claim(randomUUID()), null, 'a session outside the scope was claimed');
    assert.equal(await status(fresh), RunStatus.PENDING);
  });

  await t.test('a scope with no session id in it claims nothing', async () => {
    assert.equal(await claim(''), null);
    assert.equal(await claim('not-a-session,,'), null);
    assert.equal(await status(fresh), RunStatus.PENDING);
  });

  await t.test('an unscoped claim (a runner that is not draining) takes any session, as before', async () => {
    const job = await claim();
    assert.equal(job?.sessionId, fresh);
  });
});
