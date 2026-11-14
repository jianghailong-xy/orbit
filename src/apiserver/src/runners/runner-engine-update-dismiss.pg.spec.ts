/**
 * DISMISSING A RUNNER'S ENGINE UPDATE WARNING UNTIL THE NEXT RELEASE, ON REAL POSTGRESQL.
 *
 * POST /runners/:id/engines/:engine/update-warning/dismiss records the engine's current
 * `update.latest` under its key of `runner.engine_update_dismissals` (migration 0705), and the runner
 * payload every client reads returns it as `engineUpdateDismissals`. The clients hide that engine's
 * update warning while it equals the engine's `update.latest`. What is checked here:
 *
 *   (1) The column is a nullable JSONB, and a runner nobody dismissed anything on reads `{}`.
 *   (2) A dismissal stores the engine's current latest, through the controller, and the payload
 *       (list and one runner) returns it. The runner is not woken.
 *   (3) A newer latest reported later and dismissed again replaces the stored version; dismissals of
 *       two engines sent at once both land.
 *   (4) An engine with no known latest is refused and nothing is written; an unknown engine is
 *       refused at the controller; somebody else's runner is not found and not written.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/runners/runner-engine-update-dismiss.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient, RunnerStatus } from '@prisma/client';
import type { RunnerEngineHealth } from '@orbit/shared';
import { Client } from 'pg';

import type { AuthUser } from '../common/current-user.decorator';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { RunnersController } from './runners.controller';
import { RunnersService } from './runners.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** Codex 13 days behind `latest`, its update failing; Claude Code current. */
function engines(codexLatest: string | undefined): RunnerEngineHealth[] {
  return [
    {
      engine: 'codex',
      installed: true,
      version: 'codex-cli 0.159.2',
      auth: 'no',
      update: {
        status: 'failed',
        at: '2026-11-13T23:50:00.000Z',
        okAt: '2026-10-31T00:00:00.000Z',
        ...(codexLatest ? { latest: codexLatest, behindSince: '2026-10-31T00:10:00.000Z' } : {}),
        message: 'Error: No such file or directory (os error 2)',
      },
    },
    {
      engine: 'claude',
      installed: true,
      version: '2.1.290 (Claude Code)',
      auth: 'yes',
      update: { status: 'failed', at: '2026-11-13T23:50:00.000Z', latest: '2.1.300', behindSince: '2026-10-30T00:00:00.000Z' },
    },
  ];
}

test('dismissing an engine update warning until the next release', { skip, concurrency: 1, timeout: 120_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const woken: string[] = [];
  const realtime = { notifyRunnerWake: (id: string) => woken.push(id) } as unknown as RealtimeService;
  const runners = new RunnersService(prisma, realtime);
  const controller = new RunnersController(runners);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  async function machine(label: string, reported: RunnerEngineHealth[] = engines('0.169.0')) {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    await db.user.create({ data: { id: ownerId, email: `${label}-${ownerId}@engine-dismiss.invalid`, name: 'The owner', passwordHash: 'x' } });
    await db.runner.create({
      data: {
        id: runnerId,
        ownerId,
        name: `${label}-runner`,
        tokenHash: `hash-${runnerId}`,
        status: RunnerStatus.ONLINE,
        lastHeartbeatAt: new Date(),
        engines: reported as unknown as Prisma.InputJsonValue,
      },
    });
    return { ownerId, runnerId, user: { userId: ownerId } as AuthUser };
  }

  async function stored(runnerId: string): Promise<unknown> {
    const r = await sql.query(`SELECT engine_update_dismissals FROM "runner" WHERE id = $1::uuid`, [runnerId]);
    return r.rows[0].engine_update_dismissals;
  }

  await t.test('(1) the column is a nullable JSONB, and nothing dismissed reads {}', async () => {
    const column = await sql.query(
      `SELECT a.attnotnull, format_type(a.atttypid, a.atttypmod) AS type
         FROM pg_attribute a
        WHERE a.attrelid = '"runner"'::regclass AND a.attname = 'engine_update_dismissals' AND NOT a.attisdropped`,
    );
    assert.deepEqual(column.rows, [{ attnotnull: false, type: 'jsonb' }]);
    const m = await machine('one');
    assert.equal(await stored(m.runnerId), null);
    assert.deepEqual((await runners.getRunner(m.ownerId, m.runnerId)).engineUpdateDismissals, {});
  });

  await t.test('(2) a dismissal stores the engine’s current latest, and the runner payload returns it', async () => {
    const m = await machine('two');
    assert.deepEqual(
      await controller.dismissEngineUpdateWarning(m.user, m.runnerId, 'codex'),
      { engine: 'codex', latest: '0.169.0' },
    );
    assert.deepEqual(await stored(m.runnerId), { codex: '0.169.0' });
    assert.deepEqual((await runners.getRunner(m.ownerId, m.runnerId)).engineUpdateDismissals, { codex: '0.169.0' });
    const listed = (await runners.listRunners(m.ownerId)).find((r) => r.id === m.runnerId);
    assert.deepEqual(listed?.engineUpdateDismissals, { codex: '0.169.0' });
    // The engines themselves are untouched: the warning is the client's to hide, the facts stay.
    const codex = listed?.engines?.find((e) => e.engine === 'codex');
    assert.equal(codex?.update?.latest, '0.169.0');
    assert.equal(codex?.update?.behindSince, '2026-10-31T00:10:00.000Z', 'the behind clock is not reset');
    assert.deepEqual(woken, [], 'the runner is not woken');
  });

  await t.test('(3) a newer latest dismissed again replaces it; two engines at once both land', async () => {
    const m = await machine('three');
    await runners.dismissEngineUpdateWarning(m.ownerId, m.runnerId, 'codex');
    await db.runner.update({
      where: { id: m.runnerId },
      data: { engines: engines('0.170.0') as unknown as Prisma.InputJsonValue },
    });
    // Reported newer, not yet dismissed: the stored version is the old one, which is what brings
    // the warning back on every client.
    assert.deepEqual((await runners.getRunner(m.ownerId, m.runnerId)).engineUpdateDismissals, { codex: '0.169.0' });
    await Promise.all([
      runners.dismissEngineUpdateWarning(m.ownerId, m.runnerId, 'codex'),
      runners.dismissEngineUpdateWarning(m.ownerId, m.runnerId, 'claude'),
    ]);
    assert.deepEqual(await stored(m.runnerId), { codex: '0.170.0', claude: '2.1.300' });
  });

  await t.test('(4) no known latest, an unknown engine and somebody else’s runner are refused', async () => {
    const m = await machine('four', engines(undefined));
    await assert.rejects(runners.dismissEngineUpdateWarning(m.ownerId, m.runnerId, 'codex'), BadRequestException);
    await assert.rejects(runners.dismissEngineUpdateWarning(m.ownerId, m.runnerId, 'kimi'), BadRequestException);
    assert.equal(await stored(m.runnerId), null, 'nothing is written');
    assert.throws(() => controller.dismissEngineUpdateWarning(m.user, m.runnerId, 'notepad'), BadRequestException);

    const other = await machine('four-other');
    await assert.rejects(runners.dismissEngineUpdateWarning(m.ownerId, other.runnerId, 'codex'), NotFoundException);
    assert.equal(await stored(other.runnerId), null, 'another owner’s runner is not written');
  });
});
