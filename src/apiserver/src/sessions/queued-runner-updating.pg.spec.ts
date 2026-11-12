/**
 * The `runner_updating` queue gate (docs/runner-update-drain-design.md §3–§4) against a real
 * PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty, through the production apiserver's
 * GET /api/sessions — the list row is where the gate is read. What it is held to:
 *
 *   (1) a session queued on an online runner whose last heartbeat said `draining` reads
 *       `runner_updating`, with queuedActive = the runner's turns in flight and no limit, and carries
 *       queuedRunnerUpdate: the release the runner reported, when its drain began, and the owner's
 *       turns it waits for (another owner's turn is counted, never named);
 *   (2) draining outranks capacity: the same gate on a draining runner that is also full;
 *   (3) a draining runner that reports no target or start: targetVersion null, and the session's own
 *       wait as the clock;
 *   (4) an offline runner reads `runner_offline` even when its last beat said draining;
 *   (5) a full runner that is not draining reads `runner_at_capacity` (n/n), with no queuedRunnerUpdate.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/queued-runner-updating.pg.spec.ts
 *
 * Not destructive: every row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { JwtService } from '@nestjs/jwt';
import { Prisma, RunStatus, SessionDispatchOrigin, type PrismaClient } from '@prisma/client';
import { toUuid } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import '../test-support/daemon-routes-over-http';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const MINUTE = 60_000;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

test('queuedReason runner_updating: a draining runner names its update, ahead of every capacity gate', {
  skip: !URL, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  const jwtSecret = `queued-runner-updating-spec-${randomUUID()}`;
  const jwt = new JwtService({ secret: jwtSecret, signOptions: { expiresIn: '1h' } });
  let server: Apiserver | null = null;
  t.after(async () => {
    await server?.stop().catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);
  server = await startApiserver(url, jwtSecret);

  async function owner(name: string) {
    const id = randomUUID();
    const email = `${name}-${RUN}@queued-runner-updating.test`;
    await db.user.create({ data: { id, email, name, passwordHash: 'x' } });
    return { id, login: () => jwt.signAsync({ sub: id, email }) };
  }
  async function runner(ownerId: string, name: string, data: Partial<Prisma.RunnerUncheckedCreateInput>) {
    const id = randomUUID();
    await db.runner.create({
      data: {
        id, ownerId, name: `${name}-${RUN}`, tokenHash: sha256(randomBytes(32).toString('base64url')),
        status: 'ONLINE', lastHeartbeatAt: new Date(), ...data,
      },
    });
    const workspaceId = randomUUID();
    await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId: id, name: `${name}-${RUN}`, enabled: true } });
    return { id, workspaceId };
  }
  async function session(
    ownerId: string,
    r: { id: string; workspaceId: string },
    title: string,
    status: RunStatus,
    lastTurnAt?: Date,
  ) {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, ownerId, creatorId: ownerId, workspaceId: r.workspaceId, assignedRunnerId: r.id, title,
        prompt: title, provider: 'claude', providerBuiltin: true, status,
        dispatchOrigin: SessionDispatchOrigin.USER,
        ...(lastTurnAt ? { lastTurnAt } : {}),
        ...(status === RunStatus.RUNNING
          ? { startedAt: new Date(Date.now() - 50 * MINUTE), runtimeSessionId: randomUUID(), numTurns: 1 }
          : {}),
      },
    });
    return id;
  }
  async function row(token: string, sessionId: string): Promise<Record<string, any>> {
    const list = await call(server!, 'GET', '/api/sessions?view=open', token);
    assert.equal(list.status, 200, list.text);
    const found = (list.json as Array<Record<string, any>>).find((x) => toUuid(String(x.id)) === sessionId);
    assert.ok(found, 'the queued session is in the list');
    return found;
  }

  const alice = await owner('alice');
  const aliceToken = await alice.login();
  const drainingSince = new Date(Date.now() - 38 * MINUTE);

  await t.test('(1) an online draining runner: runner_updating, its turns in flight, its release', async () => {
    const r = await runner(alice.id, 'studio-mac', {
      maxConcurrent: 8,
      heartbeatDraining: true,
      selfUpdate: {
        state: 'waitingForIdle',
        reason: 'deferred for 1h0m0s, the limit; taking no new work until the 3 turn(s) in flight end',
        targetVersion: '0.1.254',
        drainingSince: drainingSince.toISOString(),
      },
    });
    const backfill = await session(alice.id, r, 'Backfill missing shard rows', RunStatus.RUNNING, new Date(Date.now() - 50 * MINUTE));
    const metrics = await session(alice.id, r, 'Why are 11-08 metrics zero', RunStatus.RUNNING, new Date(Date.now() - 40 * MINUTE));
    // Another owner's turn on the same machine: counted, never named.
    const bob = await owner('bob');
    await session(bob.id, r, 'bob’s private turn', RunStatus.RUNNING);
    const queued = await session(alice.id, r, 'Why is the send stuck in Queued', RunStatus.PENDING);

    const got = await row(aliceToken, queued);
    assert.equal(got.queuedReason, 'runner_updating');
    assert.equal(got.queuedActive, 3, 'every turn in flight on the runner');
    assert.equal(got.queuedLimit, null, 'a drain has no limit to show');
    const update = got.queuedRunnerUpdate;
    assert.equal(update.targetVersion, '0.1.254');
    assert.equal(new Date(update.since).getTime(), drainingSince.getTime(), 'the runner’s own drain start');
    assert.deepEqual(
      update.turns.map((x: { id: string; title: string }) => [toUuid(x.id), x.title]),
      [[backfill, 'Backfill missing shard rows'], [metrics, 'Why are 11-08 metrics zero']],
      'the owner’s own turns, oldest first, and not bob’s',
    );
  });

  await t.test('(2) draining outranks capacity: a draining runner that is also full', async () => {
    const r = await runner(alice.id, 'full-draining', {
      maxConcurrent: 1, heartbeatDraining: true, selfUpdate: { state: 'waitingForIdle', targetVersion: '0.1.254' },
    });
    await session(alice.id, r, 'the one turn', RunStatus.RUNNING);
    const queued = await session(alice.id, r, 'behind it', RunStatus.PENDING);
    const got = await row(aliceToken, queued);
    assert.equal(got.queuedReason, 'runner_updating', 'not runner_at_capacity');
    assert.equal(got.queuedActive, 1);
  });

  await t.test('(3) a draining runner that reports no target: no version, the session’s own wait as the clock', async () => {
    const r = await runner(alice.id, 'old-runner', {
      maxConcurrent: 4, heartbeatDraining: true, selfUpdate: { state: 'waitingForIdle' },
    });
    const waitedFrom = new Date(Date.now() - 12 * MINUTE);
    const queued = await session(alice.id, r, 'queued on an old runner', RunStatus.PENDING, waitedFrom);
    const got = await row(aliceToken, queued);
    assert.equal(got.queuedReason, 'runner_updating');
    assert.equal(got.queuedActive, 0);
    assert.equal(got.queuedRunnerUpdate.targetVersion, null);
    assert.equal(new Date(got.queuedRunnerUpdate.since).getTime(), waitedFrom.getTime());
    assert.equal(got.queuedRunnerUpdate.turns.length, 0);
  });

  await t.test('(4) an offline runner reads runner_offline, even if its last beat said draining', async () => {
    const r = await runner(alice.id, 'offline', {
      maxConcurrent: 4, heartbeatDraining: true, lastHeartbeatAt: new Date(Date.now() - 30 * MINUTE),
    });
    const queued = await session(alice.id, r, 'queued on an offline runner', RunStatus.PENDING);
    const got = await row(aliceToken, queued);
    assert.equal(got.queuedReason, 'runner_offline');
    assert.equal(got.queuedRunnerUpdate, null);
  });

  await t.test('(5) a full runner that is not draining reads runner_at_capacity', async () => {
    const r = await runner(alice.id, 'full', { maxConcurrent: 1, heartbeatDraining: false });
    await session(alice.id, r, 'the one turn', RunStatus.RUNNING);
    const queued = await session(alice.id, r, 'waiting for a slot', RunStatus.PENDING);
    const got = await row(aliceToken, queued);
    assert.equal(got.queuedReason, 'runner_at_capacity');
    assert.equal(got.queuedActive, 1);
    assert.equal(got.queuedLimit, 1);
    assert.equal(got.queuedRunnerUpdate, null);
  });
});
