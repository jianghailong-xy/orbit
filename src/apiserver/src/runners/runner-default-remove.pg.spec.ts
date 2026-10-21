/**
 * REMOVING A RUNNER'S DEFAULT FROM ORBIT, AND BRINGING IT BACK, ON REAL POSTGRESQL.
 *
 * Default is the directory a runner's own environment selects for an engine that keeps accounts, the
 * one that engine's CLI in a terminal there shares. Removing it is Orbit's record alone: the engine
 * goes into `runner.default_removed` (migration 0440) in one statement of RunnersService.removeAccount,
 * and comes out in one of restoreDefault. What only PostgreSQL can say about those statements:
 *
 *   (1) A removal lands under its engine, for every engine that keeps accounts, while the runner
 *       reports another account of it, and nothing goes to the runner: the account-removal relay's
 *       columns stay empty and the runner is not woken. A runner offline and too old to remove any
 *       account is answered the same.
 *   (2) The column is NOT NULL with an empty default: a runner nobody removed anything from reads `{}`.
 *   (3) Removing twice stores the engine once; removals sent at once all land, each once.
 *   (4) A restore takes its engine out and leaves the others; restoring a Default that is not removed
 *       changes nothing; restores sent at once all land.
 *   (5) Somebody else's runner is not found, by either statement, and not written.
 *   (6) With no other account of that engine the removal is refused, and nothing is written.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/runners/runner-default-remove.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient, RunnerStatus } from '@prisma/client';
import type { LoginEngine, RunnerEngineHealth } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { RunnersService } from './runners.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const WORK = '3fa91c2e';
const ACCOUNT_ENGINES: readonly LoginEngine[] = ['codex', 'claude', 'antigravity', 'kimi', 'cursor'];

/** One engine as a runner reports it, with these accounts. */
function reported(engine: LoginEngine, ids: string[]): RunnerEngineHealth {
  return {
    engine,
    installed: true,
    auth: 'yes',
    accounts: ids.map((id) => ({
      id,
      home: id === 'default' ? `/root/.${engine}` : `/root/.orbit/${engine}-accounts/${id}`,
      auth: 'yes' as const,
    })),
  };
}

/** Every engine that keeps accounts, each with Default and one added account. */
const ENGINES = ACCOUNT_ENGINES.map((engine) => reported(engine, ['default', WORK]));

test('removing a runner’s Default from Orbit, and bringing it back', { skip, concurrency: 1, timeout: 120_000 }, async (t) => {
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
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  /** An owner and a runner reporting `engines`, with `extra` on the runner row. */
  async function machine(
    label: string,
    engines: RunnerEngineHealth[] = ENGINES,
    extra: Partial<Prisma.RunnerUncheckedCreateInput> = {},
  ) {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    await db.user.create({ data: { id: ownerId, email: `${label}-${ownerId}@default-remove.invalid`, name: 'The owner', passwordHash: 'x' } });
    await db.runner.create({
      data: {
        id: runnerId,
        ownerId,
        name: `${label}-runner`,
        tokenHash: `hash-${runnerId}`,
        status: RunnerStatus.ONLINE,
        lastHeartbeatAt: new Date(),
        engines: engines as unknown as Prisma.InputJsonValue,
        ...extra,
      },
    });
    return { ownerId, runnerId };
  }

  /** The runner's row as the two statements leave it: the record, and the relay beside it. */
  async function stored(runnerId: string) {
    const r = await sql.query(
      `SELECT default_removed, account_remove_engine, codex_account_remove_account, codex_account_remove_status,
              codex_account_remove_message, codex_account_remove_at
         FROM "runner" WHERE id = $1::uuid`,
      [runnerId],
    );
    const { default_removed: removed, ...relay } = r.rows[0];
    return { removed: removed as string[], relay: relay as Record<string, unknown> };
  }
  const NO_RELAY = {
    account_remove_engine: null,
    codex_account_remove_account: null,
    codex_account_remove_status: null,
    codex_account_remove_message: null,
    codex_account_remove_at: null,
  };

  await t.test('(1) a removal lands under its engine, for every engine, and nothing goes to the runner', async () => {
    const m = await machine('one');
    for (const engine of ACCOUNT_ENGINES) {
      assert.deepEqual(
        await runners.removeAccount(m.ownerId, m.runnerId, engine, 'default'),
        { engine, account: 'default', status: 'done', message: null },
      );
    }
    const after = await stored(m.runnerId);
    assert.deepEqual(after.removed, [...ACCOUNT_ENGINES]);
    assert.deepEqual(after.relay, NO_RELAY, 'the account-removal relay is not written');
    assert.deepEqual(woken, [], 'the runner is not woken');

    // A runner offline for days, and too old to remove any account, is answered the same.
    const old = await machine('one-old', [reported('codex', ['default', WORK])], {
      status: RunnerStatus.OFFLINE,
      lastHeartbeatAt: new Date('2026-01-01T00:00:00Z'),
      version: '0.1.100',
      capabilities: [],
      capabilitiesReportedAt: null,
    });
    assert.equal((await runners.removeAccount(old.ownerId, old.runnerId, 'codex', 'default')).status, 'done');
    assert.deepEqual(await stored(old.runnerId), { removed: ['codex'], relay: NO_RELAY });
    assert.deepEqual(woken, []);
  });

  await t.test('(2) the column is NOT NULL, and a runner nobody removed anything from reads empty', async () => {
    const column = await sql.query(
      `SELECT a.attnotnull, format_type(a.atttypid, a.atttypmod) AS type, pg_get_expr(d.adbin, d.adrelid) AS fallback
         FROM pg_attribute a
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = '"runner"'::regclass AND a.attname = 'default_removed' AND NOT a.attisdropped`,
    );
    assert.deepEqual(column.rows, [{ attnotnull: true, type: 'text[]', fallback: 'ARRAY[]::text[]' }]);
    const m = await machine('two');
    assert.deepEqual((await stored(m.runnerId)).removed, []);
    await assert.rejects(
      sql.query(`UPDATE "runner" SET default_removed = NULL WHERE id = $1::uuid`, [m.runnerId]),
      /null value in column "default_removed"/,
    );
  });

  await t.test('(3) removing twice stores the engine once, and removals sent at once all land', async () => {
    const m = await machine('three');
    await runners.removeAccount(m.ownerId, m.runnerId, 'codex', 'default');
    await runners.removeAccount(m.ownerId, m.runnerId, 'codex', 'default');
    assert.deepEqual((await stored(m.runnerId)).removed, ['codex']);

    await Promise.all([
      runners.removeAccount(m.ownerId, m.runnerId, 'claude', 'default'),
      runners.removeAccount(m.ownerId, m.runnerId, 'kimi', 'default'),
      runners.removeAccount(m.ownerId, m.runnerId, 'cursor', 'default'),
      runners.removeAccount(m.ownerId, m.runnerId, 'cursor', 'default'),
      runners.removeAccount(m.ownerId, m.runnerId, 'codex', 'default'),
    ]);
    assert.deepEqual((await stored(m.runnerId)).removed.sort(), ['claude', 'codex', 'cursor', 'kimi']);
  });

  await t.test('(4) a restore takes its engine out and leaves the others; one not removed changes nothing', async () => {
    const m = await machine('four');
    for (const engine of ['codex', 'claude', 'antigravity'] as const) {
      await runners.removeAccount(m.ownerId, m.runnerId, engine, 'default');
    }

    assert.deepEqual(await runners.restoreDefault(m.ownerId, m.runnerId, 'claude'), { ok: true });
    assert.deepEqual((await stored(m.runnerId)).removed, ['codex', 'antigravity']);
    assert.deepEqual(await runners.restoreDefault(m.ownerId, m.runnerId, 'claude'), { ok: true });
    assert.deepEqual(await runners.restoreDefault(m.ownerId, m.runnerId, 'kimi'), { ok: true });
    assert.deepEqual((await stored(m.runnerId)).removed, ['codex', 'antigravity'], 'a Default not removed is left as it is');

    await Promise.all([
      runners.restoreDefault(m.ownerId, m.runnerId, 'codex'),
      runners.restoreDefault(m.ownerId, m.runnerId, 'antigravity'),
    ]);
    assert.deepEqual(await stored(m.runnerId), { removed: [], relay: NO_RELAY });
    assert.deepEqual(woken, []);

    // Removed again after a restore, it is recorded again.
    await runners.removeAccount(m.ownerId, m.runnerId, 'claude', 'default');
    assert.deepEqual((await stored(m.runnerId)).removed, ['claude']);
  });

  await t.test('(5) somebody else’s runner is not found, by either statement, and not written', async () => {
    const mine = await machine('five-mine');
    const theirs = await machine('five-theirs');
    await runners.removeAccount(theirs.ownerId, theirs.runnerId, 'codex', 'default');

    await assert.rejects(runners.removeAccount(mine.ownerId, theirs.runnerId, 'claude', 'default'), NotFoundException);
    await assert.rejects(runners.restoreDefault(mine.ownerId, theirs.runnerId, 'codex'), NotFoundException);

    assert.deepEqual(await stored(theirs.runnerId), { removed: ['codex'], relay: NO_RELAY });
    assert.deepEqual((await stored(mine.runnerId)).removed, []);
  });

  await t.test('(6) with no other account of that engine the removal is refused, and nothing is written', async () => {
    const m = await machine('six', [reported('codex', ['default']), reported('claude', ['default', WORK])]);
    await assert.rejects(
      runners.removeAccount(m.ownerId, m.runnerId, 'codex', 'default'),
      (error: unknown) => {
        assert.ok(error instanceof BadRequestException, String(error));
        assert.equal(
          (error.getResponse() as { message?: string }).message,
          'Add another Codex account to this machine before removing Default.',
        );
        return true;
      },
    );
    await assert.rejects(runners.removeAccount(m.ownerId, m.runnerId, 'kimi', 'default'), BadRequestException);
    assert.deepEqual(await stored(m.runnerId), { removed: [], relay: NO_RELAY });

    // Claude Code's added account is beside its Default, so that one goes.
    await runners.removeAccount(m.ownerId, m.runnerId, 'claude', 'default');
    assert.deepEqual((await stored(m.runnerId)).removed, ['claude']);
  });
});
