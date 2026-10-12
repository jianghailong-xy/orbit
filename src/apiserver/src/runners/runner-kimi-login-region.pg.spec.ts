/**
 * Kimi's choice of site on real PostgreSQL: `runner.login_region` (migration 0397) as the relay's
 * statements write and read it, which runner-login-region.spec.ts can only imitate with a row in
 * memory.
 *
 *  (1) A start naming a site stores it, the heartbeat hands it to a runner that can choose one, and
 *      every redelivery names the same site.
 *  (2) A runner that cannot choose is refused the start, and the row says why.
 *  (3) Cancelling, and a start that names no site, leave the column NULL: no later sign-in inherits
 *      a site the user picked for an earlier one.
 *
 * Production code throughout: RunnersService and RunnerApiController. It only adds rows, and refuses
 * to run anywhere but the disposable server `coordinator-pg-test-safety` identifies.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { KIMI_LOGIN_REGION_V1 } from '@orbit/shared';
import { RunnerStatus } from '@prisma/client';
import { Client } from 'pg';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { RunnersService } from './runners.service';

const URL = process.env.COORDINATOR_PG_URL;
const CAPABLE = `session-worktree-ops-v1,${KIMI_LOGIN_REGION_V1}`;
const OLDER = 'session-worktree-ops-v1';

const suite = URL ? test : test.skip;

suite("Kimi's sign-in site on real PostgreSQL", { timeout: 120_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  const db = prismaClientFor(URL!);
  const runners = new RunnersService(db as unknown as PrismaService);
  const api = new RunnerApiController(db as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  const relay = api as unknown as {
    drainLoginRequest(runnerId: string, capabilities: string): Promise<unknown>;
  };
  t.after(async () => {
    await db.$disconnect();
    await client.end();
  });

  async function runner(): Promise<{ ownerId: string; runnerId: string }> {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    await db.user.create({
      data: { id: ownerId, email: `kimi-login-region-${ownerId}@spec.invalid`, name: 'owner', passwordHash: 'x' },
    });
    await db.runner.create({
      data: {
        id: runnerId, ownerId, name: 'hpc', tokenHash: `x-${runnerId}`, status: RunnerStatus.ONLINE,
        maxConcurrent: 1, lastHeartbeatAt: new Date(),
        capabilities: [KIMI_LOGIN_REGION_V1], capabilitiesReportedAt: new Date(),
      },
    });
    return { ownerId, runnerId };
  }
  /** The column as the database holds it, read past Prisma — and the attempt it belongs to, through
   *  Prisma, which reads `login_at` the way the relay does (a raw read takes the host's time zone). */
  const stored = async (runnerId: string) => {
    const { rows } = await client.query<{ login_region: string | null }>(
      'SELECT login_region FROM runner WHERE id = $1',
      [runnerId],
    );
    const row = await db.runner.findUniqueOrThrow({ where: { id: runnerId } });
    return { login_region: rows[0].login_region, login_at: row.loginAt };
  };

  await t.test('(1) the site a start names is stored, and handed to a runner that can choose it', async () => {
    const { ownerId, runnerId } = await runner();
    await runners.startLogin(ownerId, runnerId, { engine: 'kimi', region: 'global' });
    const row = await stored(runnerId);
    assert.equal(row.login_region, 'global');
    const attempt = row.login_at!.toISOString();
    for (let beat = 0; beat < 2; beat++) {
      assert.deepEqual(await relay.drainLoginRequest(runnerId, CAPABLE), { action: 'start', engine: 'kimi', attempt, region: 'global' });
    }
  });

  await t.test('(2) a runner that cannot choose a site is refused the start, and the row says why', async () => {
    const { ownerId, runnerId } = await runner();
    await runners.startLogin(ownerId, runnerId, { engine: 'kimi', region: 'mainland-cn' });
    assert.equal(await relay.drainLoginRequest(runnerId, OLDER), undefined);
    const state = await runners.getLoginState(ownerId, runnerId);
    assert.equal(state.status, 'failed');
    assert.match(state.message ?? '', /too old to choose a Kimi site/u);
  });

  await t.test('(3) cancelling, and a start naming no site, leave no site behind', async () => {
    const { ownerId, runnerId } = await runner();
    await runners.startLogin(ownerId, runnerId, { engine: 'kimi', region: 'global' });
    await runners.cancelLogin(ownerId, runnerId);
    assert.equal((await stored(runnerId)).login_region, null);

    await runners.startLogin(ownerId, runnerId, { engine: 'kimi', region: 'global' });
    await runners.startLogin(ownerId, runnerId, { engine: 'kimi' });
    const row = await stored(runnerId);
    assert.equal(row.login_region, null);
    assert.deepEqual(await relay.drainLoginRequest(runnerId, CAPABLE), {
      action: 'start', engine: 'kimi', attempt: row.login_at!.toISOString(),
    });
  });
});
