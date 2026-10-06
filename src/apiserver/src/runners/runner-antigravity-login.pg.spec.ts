/**
 * Antigravity's Google sign-in relay on real PostgreSQL: the statements whose predicates
 * runner-antigravity-login.spec.ts can only imitate with rows in memory.
 *
 *  (1) A dismissed sign-in keeps its attempt as `cancelling`. A report the runner still sends about
 *      that attempt matches no row — `login_status <> 'cancelling'` — the next heartbeat claims the
 *      cancel by compare-and-set, once, and leaves the slot empty.
 *  (2) The pasted code is never written to the database — no column of the runner row carries it,
 *      not even before the heartbeat — and goes out on one heartbeat with its attempt.
 *  (3) A runner too old to name its start is still taken as it comes, a slot with no status
 *      included: the `<>` the cancel added applies only to a report that names an attempt, and
 *      SQL's `<>` would never match a NULL.
 *
 * Production code throughout: RunnersService and RunnerApiController. It only adds rows, and refuses
 * to run anywhere but the disposable server `coordinator-pg-test-safety` identifies.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { RunnerStatus } from '@prisma/client';
import { Client } from 'pg';

import { ANTIGRAVITY_GOOGLE_LOGIN_V1 } from '../common/antigravity-readiness';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { RunnersService } from './runners.service';

const URL = process.env.COORDINATOR_PG_URL;
const CAPABLE = `session-worktree-ops-v1,${ANTIGRAVITY_GOOGLE_LOGIN_V1}`;
const GOOGLE_URL = 'https://accounts.google.com/o/oauth2/auth?client_id=placeholder&response_type=code';
/** Shaped like a Google authorization code; not a real one. */
const CODE = '4/0-placeholder-authorization-code';

const suite = URL ? test : test.skip;

suite('Antigravity Google sign-in relay on real PostgreSQL', { timeout: 120_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  const db = prismaClientFor(URL!);
  const runners = new RunnersService(db as unknown as PrismaService);
  const api = new RunnerApiController(db as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  const relay = api as unknown as {
    drainLoginRequest(runnerId: string, capabilities: string): Promise<unknown>;
    loginResult(runner: { id: string }, body: Record<string, unknown>): Promise<{ ok: boolean; applied: boolean }>;
  };
  t.after(async () => {
    await db.$disconnect();
    await client.end();
  });

  async function runner(): Promise<{ ownerId: string; runnerId: string }> {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    await db.user.create({
      data: { id: ownerId, email: `antigravity-login-${ownerId}@spec.invalid`, name: 'owner', passwordHash: 'x' },
    });
    await db.runner.create({
      data: {
        id: runnerId, ownerId, name: 'hpc', tokenHash: `x-${runnerId}`, status: RunnerStatus.ONLINE,
        maxConcurrent: 1, lastHeartbeatAt: new Date(),
        capabilities: [ANTIGRAVITY_GOOGLE_LOGIN_V1], capabilitiesReportedAt: new Date(),
      },
    });
    return { ownerId, runnerId };
  }
  const slot = async (runnerId: string) => {
    const row = await db.runner.findUniqueOrThrow({ where: { id: runnerId } });
    return { status: row.loginStatus, engine: row.loginEngine, at: row.loginAt, code: row.loginCode };
  };

  await t.test('(1) a dismissed sign-in drops what its runner still says, and its cancel is claimed once', async () => {
    const { ownerId, runnerId } = await runner();
    await runners.startLogin(ownerId, runnerId, { engine: 'antigravity' });
    const attempt = (await slot(runnerId)).at!.toISOString();
    assert.deepEqual(await relay.drainLoginRequest(runnerId, CAPABLE), { action: 'start', engine: 'antigravity', attempt });
    assert.deepEqual(await relay.loginResult({ id: runnerId }, { status: 'awaiting_code', url: GOOGLE_URL, attempt }), { ok: true, applied: true });

    assert.equal((await runners.cancelLogin(ownerId, runnerId)).status, null);
    assert.equal((await slot(runnerId)).status, 'cancelling');
    for (const late of [{ status: 'awaiting_code', url: GOOGLE_URL }, { status: 'done' }]) {
      assert.deepEqual(await relay.loginResult({ id: runnerId }, { ...late, attempt }), { ok: true, applied: false }, late.status);
    }
    assert.equal((await runners.getLoginState(ownerId, runnerId)).status, null);

    assert.deepEqual(await relay.drainLoginRequest(runnerId, CAPABLE), { action: 'cancel', engine: 'antigravity', attempt });
    assert.deepEqual(await slot(runnerId), { status: null, engine: null, at: null, code: null });
    assert.equal(await relay.drainLoginRequest(runnerId, CAPABLE), undefined, 'handed over once');
    assert.deepEqual(
      await relay.loginResult({ id: runnerId }, { status: 'failed', message: 'Google sign-in cancelled', attempt }),
      { ok: true, applied: false },
    );
  });

  await t.test('(2) the pasted code never reaches the database, and goes out once with its attempt', async () => {
    const { ownerId, runnerId } = await runner();
    await runners.startLogin(ownerId, runnerId, { engine: 'antigravity' });
    const attempt = (await slot(runnerId)).at!.toISOString();
    await relay.drainLoginRequest(runnerId, CAPABLE);
    await relay.loginResult({ id: runnerId }, { status: 'awaiting_code', url: GOOGLE_URL, attempt });
    await runners.submitLoginCode(ownerId, runnerId, CODE);
    // Held in memory for the heartbeat, not in `login_code` — not even until then.
    assert.equal((await slot(runnerId)).code, null);
    const [{ found }] = await client
      .query<{ found: boolean }>('SELECT EXISTS (SELECT 1 FROM runner WHERE row_to_json(runner)::text LIKE $1) AS found', [`%${CODE}%`])
      .then((result) => result.rows);
    assert.equal(found, false, 'no column of any runner row carries the code');
    assert.deepEqual(await relay.drainLoginRequest(runnerId, CAPABLE), { action: 'code', engine: 'antigravity', code: CODE, attempt });
    assert.equal(await relay.drainLoginRequest(runnerId, CAPABLE), undefined);
    assert.deepEqual(await relay.loginResult({ id: runnerId }, { status: 'done', attempt }), { ok: true, applied: true });
    assert.equal((await runners.getLoginState(ownerId, runnerId)).status, 'done');
  });

  await t.test('(3) a report that names no attempt lands as before, on a slot with no status too', async () => {
    const { runnerId } = await runner();
    assert.deepEqual(await relay.loginResult({ id: runnerId }, { status: 'done' }), { ok: true, applied: true });
    assert.equal((await slot(runnerId)).status, 'done');
  });
});
