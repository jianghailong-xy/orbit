/**
 * The `runner_at_capacity` queue gate counted as the runner admits work (src/runner-go/session_pool.go): its turns
 * plus the sessions its background jobs hold a slot for (runner_presence.background_job_session_ids, migration 0780),
 * against a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty, through the production apiserver's
 * GET /api/sessions. What it is held to:
 *
 *   (1) 1 turn + 2 sessions held by background jobs on a runner of 3: runner_at_capacity, queuedActive 3,
 *       queuedLimit 3, queuedHeldByJobs 2 (on 11-15 HPC read 10 of 16 turns with 6 more slots held, and the
 *       queued row said nothing);
 *   (2) a RUNNING session the beat also names counts once: 2 of 3 is not full;
 *   (3) a named session that is finished, or assigned to another runner, holds nothing here;
 *   (4) a runner with no presence row (an older runner, or one a crash emptied) counts turns alone, as before;
 *   (5) full by turns alone: queuedHeldByJobs 0;
 *   (6) an offline runner's stale holders do not turn runner_offline into runner_at_capacity.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/queued-runner-full.pg.spec.ts
 *
 * Not destructive: every row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { JwtService } from '@nestjs/jwt';
import { Prisma, SessionDispatchOrigin, type PrismaClient } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { isReleasedStatus } from '../common/session-release';
import { toUuid } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import '../test-support/daemon-routes-over-http';
import { turnStateOfWord } from './session-turn-state';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const MINUTE = 60_000;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

test('queuedReason runner_at_capacity: a runner full of turns and background-job slot holders says so', {
  skip: !URL, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  const jwtSecret = `queued-runner-full-spec-${randomUUID()}`;
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
    const email = `${name}-${RUN}@queued-runner-full.test`;
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
        prompt: title, provider: 'claude', providerBuiltin: true, turnState: turnStateOfWord(status),
        ...(isReleasedStatus(status) ? {
          finishedAt: new Date(),
        } : {}),
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
  async function holders(runnerId: string, ids: string[], lastBeatAt = new Date()) {
    await db.runnerPresence.create({ data: { runnerId, lastBeatAt, linkState: 'LINK', backgroundJobSessionIds: ids } });
  }

  await t.test('(1) turns plus background-job slot holders fill the runner', async () => {
    const r = await runner(alice.id, 'hpc', { maxConcurrent: 3 });
    await session(alice.id, r, 'a turn', RunStatus.RUNNING);
    const build = await session(alice.id, r, 'a long build in bg_run', RunStatus.AWAITING_INPUT);
    const wait = await session(alice.id, r, 'a loop waiting for memory', RunStatus.INTERRUPTED);
    const queued = await session(alice.id, r, 'the screenshot request', RunStatus.PENDING);
    await holders(r.id, [build, wait]);
    const got = await row(aliceToken, queued);
    assert.equal(got.queuedReason, 'runner_at_capacity');
    assert.equal(got.queuedActive, 3, 'turns plus held slots');
    assert.equal(got.queuedLimit, 3);
    assert.equal(got.queuedHeldByJobs, 2);
  });

  await t.test('(2) a RUNNING session the beat also names counts once', async () => {
    const r = await runner(alice.id, 'both-ways', { maxConcurrent: 3 });
    const turn = await session(alice.id, r, 'a turn with a job', RunStatus.RUNNING);
    await session(alice.id, r, 'another turn', RunStatus.RUNNING);
    const queued = await session(alice.id, r, 'room for one', RunStatus.PENDING);
    await holders(r.id, [turn]);
    const got = await row(aliceToken, queued);
    assert.equal(got.queuedReason, null, '2 of 3 is not full');
    assert.equal(got.queuedHeldByJobs, null);
  });

  await t.test('(3) a finished session, or another runner’s, holds nothing here', async () => {
    const r = await runner(alice.id, 'stale-names', { maxConcurrent: 2 });
    const other = await runner(alice.id, 'elsewhere', { maxConcurrent: 2 });
    await session(alice.id, r, 'a turn', RunStatus.RUNNING);
    const done = await session(alice.id, r, 'finished', RunStatus.SUCCEEDED);
    const theirs = await session(alice.id, other, 'on another machine', RunStatus.AWAITING_INPUT);
    const queued = await session(alice.id, r, 'room for one', RunStatus.PENDING);
    await holders(r.id, [done, theirs]);
    const got = await row(aliceToken, queued);
    assert.equal(got.queuedReason, null);
  });

  await t.test('(4) no presence row: turns alone, as before', async () => {
    const r = await runner(alice.id, 'old-runner', { maxConcurrent: 2 });
    await session(alice.id, r, 'a turn', RunStatus.RUNNING);
    await session(alice.id, r, 'parked', RunStatus.AWAITING_INPUT);
    const queued = await session(alice.id, r, 'room for one', RunStatus.PENDING);
    const got = await row(aliceToken, queued);
    assert.equal(got.queuedReason, null);
  });

  await t.test('(5) full by turns alone: no slot held by a job', async () => {
    const r = await runner(alice.id, 'turns-only', { maxConcurrent: 1 });
    await session(alice.id, r, 'the one turn', RunStatus.RUNNING);
    const queued = await session(alice.id, r, 'waiting for a slot', RunStatus.PENDING);
    await holders(r.id, []);
    const got = await row(aliceToken, queued);
    assert.equal(got.queuedReason, 'runner_at_capacity');
    assert.equal(got.queuedActive, 1);
    assert.equal(got.queuedLimit, 1);
    assert.equal(got.queuedHeldByJobs, 0);
  });

  await t.test('(6) an offline runner stays runner_offline whatever its last beat named', async () => {
    const stale = new Date(Date.now() - 30 * MINUTE);
    const r = await runner(alice.id, 'gone', { maxConcurrent: 1, lastHeartbeatAt: stale });
    const parked = await session(alice.id, r, 'parked with a job', RunStatus.AWAITING_INPUT);
    const queued = await session(alice.id, r, 'queued on a gone runner', RunStatus.PENDING);
    await holders(r.id, [parked], stale);
    const got = await row(aliceToken, queued);
    assert.equal(got.queuedReason, 'runner_offline');
    assert.equal(got.queuedHeldByJobs, null);
  });
});
