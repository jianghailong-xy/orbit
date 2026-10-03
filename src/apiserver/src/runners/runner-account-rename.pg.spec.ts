/**
 * RENAMING A RUNNER'S ACCOUNTS — DEFAULT INCLUDED — ON REAL POSTGRESQL.
 *
 * A name given an account in Orbit is kept in `runner.account_names`, written into its one key by jsonb
 * operators inside the statement itself (RunnersService.renameAccount), and laid over the runner's
 * report wherever an account is named. What only PostgreSQL can say about those statements:
 *
 *   (1) A name lands under its engine and account, and the runner list names the account by it —
 *       Default included, which the machine never names.
 *   (2) Renaming one account leaves every other name alone, on its engine and on the other one; and
 *       renames sent at once all land.
 *   (3) A name the account carries anyway takes its key out: Default renamed "Default" is Default
 *       again, and an added account renamed to the name it was added under reads as reported.
 *   (4) Somebody else's runner is not found, and not written.
 *   (5) A removal the runner reports done takes the removed account's name with it, and no other;
 *       a report that does not apply takes none.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/runners/runner-account-rename.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient, RunnerStatus } from '@prisma/client';
import type { RunnerEngineHealth } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { RunnersService } from './runners.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const WORK = '3fa91c2e';
const OTHER = '0b05070e';

const ENGINES: RunnerEngineHealth[] = [
  {
    engine: 'codex',
    installed: true,
    auth: 'yes',
    accounts: [
      { id: 'default', home: '/root/.codex', codexHome: '/root/.codex', auth: 'yes' },
      { id: WORK, name: 'Work', home: '/root/.orbit/codex-accounts/3fa91c2e', codexHome: '/root/.orbit/codex-accounts/3fa91c2e', auth: 'yes' },
    ],
  },
  {
    engine: 'claude',
    installed: true,
    auth: 'yes',
    accounts: [
      { id: 'default', home: '/root/.claude', auth: 'yes' },
      { id: WORK, name: 'jianghailong.rd', home: '/root/.orbit/claude-accounts/3fa91c2e', auth: 'yes' },
      { id: OTHER, name: 'jianghailong.orbit', home: '/root/.orbit/claude-accounts/0b05070e', auth: 'yes' },
    ],
  },
];

const quiet = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;

test('renaming a runner’s accounts, Default included', { skip, concurrency: 1, timeout: 120_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const runners = new RunnersService(prisma);
  const api = new RunnerApiController(
    prisma,
    {} as never,
    quiet,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  /** An owner and a runner reporting ENGINES, with `extra` on the runner row. */
  async function machine(label: string, extra: Partial<Prisma.RunnerUncheckedCreateInput> = {}) {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    await db.user.create({ data: { id: ownerId, email: `${label}-${ownerId}@rename.invalid`, name: 'The owner', passwordHash: 'x' } });
    await db.runner.create({
      data: {
        id: runnerId,
        ownerId,
        name: `${label}-runner`,
        tokenHash: `hash-${runnerId}`,
        status: RunnerStatus.ONLINE,
        lastHeartbeatAt: new Date(),
        engines: ENGINES as unknown as Prisma.InputJsonValue,
        ...extra,
      },
    });
    return { ownerId, runnerId };
  }

  async function stored(runnerId: string): Promise<unknown> {
    const r = await sql.query(`SELECT account_names FROM "runner" WHERE id = $1::uuid`, [runnerId]);
    return r.rows[0].account_names;
  }

  /** What the runner list names each account of `engine`, by id. */
  async function listed(m: { ownerId: string; runnerId: string }, engine: 'claude' | 'codex') {
    const runner = (await runners.listRunners(m.ownerId)).find((r) => r.id === m.runnerId)!;
    const accounts = runner.engines?.find((entry) => entry.engine === engine)?.accounts ?? [];
    return Object.fromEntries(accounts.map((account) => [account.id, account.name ?? null]));
  }

  await t.test('(1) a name lands under its engine and account, and the list names the account by it', async () => {
    const m = await machine('one');
    assert.equal(await stored(m.runnerId), null, 'nothing is named until something is renamed');

    const renamed = await runners.renameAccount(m.ownerId, m.runnerId, 'claude', 'default', 'jianghailong.main');

    assert.equal(renamed.name, 'jianghailong.main');
    assert.deepEqual(await stored(m.runnerId), { claude: { default: 'jianghailong.main' } });
    assert.deepEqual(await listed(m, 'claude'), { default: 'jianghailong.main', [WORK]: 'jianghailong.rd', [OTHER]: 'jianghailong.orbit' });
    // Codex's Default is another account, and keeps no name.
    assert.deepEqual(await listed(m, 'codex'), { default: null, [WORK]: 'Work' });
  });

  await t.test('(2) one rename leaves every other name alone, and renames sent at once all land', async () => {
    const m = await machine('two');
    await runners.renameAccount(m.ownerId, m.runnerId, 'claude', 'default', 'Main');
    await runners.renameAccount(m.ownerId, m.runnerId, 'codex', WORK, 'Clients');
    await runners.renameAccount(m.ownerId, m.runnerId, 'claude', 'default', 'Main again');

    assert.deepEqual(await stored(m.runnerId), { claude: { default: 'Main again' }, codex: { [WORK]: 'Clients' } });

    await Promise.all([
      runners.renameAccount(m.ownerId, m.runnerId, 'claude', WORK, 'Research'),
      runners.renameAccount(m.ownerId, m.runnerId, 'claude', OTHER, 'Orbit'),
      runners.renameAccount(m.ownerId, m.runnerId, 'codex', 'default', 'Codex main'),
    ]);

    assert.deepEqual(await stored(m.runnerId), {
      claude: { default: 'Main again', [WORK]: 'Research', [OTHER]: 'Orbit' },
      codex: { default: 'Codex main', [WORK]: 'Clients' },
    });
  });

  await t.test('(3) a name the account carries anyway takes its key out', async () => {
    const m = await machine('three');
    await runners.renameAccount(m.ownerId, m.runnerId, 'claude', 'default', 'Main');
    await runners.renameAccount(m.ownerId, m.runnerId, 'claude', WORK, 'Research');

    const back = await runners.renameAccount(m.ownerId, m.runnerId, 'claude', 'default', 'Default');
    assert.equal(back.name, undefined, 'plain Default again: nothing for a mark to point at');
    await runners.renameAccount(m.ownerId, m.runnerId, 'claude', WORK, 'jianghailong.rd');

    assert.deepEqual(await listed(m, 'claude'), { default: null, [WORK]: 'jianghailong.rd', [OTHER]: 'jianghailong.orbit' });
    assert.deepEqual(await stored(m.runnerId), { claude: {} });
    // Taking out a key that is not there is the same state, not an error.
    await runners.renameAccount(m.ownerId, m.runnerId, 'claude', 'default', 'Default');
    assert.deepEqual(await stored(m.runnerId), { claude: {} });
  });

  await t.test('(4) somebody else’s runner is not found, and not written', async () => {
    const mine = await machine('four-mine');
    const theirs = await machine('four-theirs');

    await assert.rejects(
      runners.renameAccount(mine.ownerId, theirs.runnerId, 'claude', 'default', 'Mine now'),
      NotFoundException,
    );
    assert.equal(await stored(theirs.runnerId), null);
  });

  await t.test('(5) a removal reported done takes the removed account’s name, and no other', async () => {
    const asked = new Date('2026-10-03T03:00:00Z');
    const m = await machine('five', {
      accountRemoveEngine: 'claude',
      codexAccountRemoveAccount: WORK,
      codexAccountRemoveStatus: 'pending',
      codexAccountRemoveAt: asked,
    });
    await runners.renameAccount(m.ownerId, m.runnerId, 'claude', 'default', 'Main');
    await runners.renameAccount(m.ownerId, m.runnerId, 'claude', WORK, 'Research');
    await runners.renameAccount(m.ownerId, m.runnerId, 'codex', WORK, 'Clients');

    // A report about another removal does not apply, and takes nothing.
    const stale = await api.accountRemoveResult(
      { id: m.runnerId },
      { engine: 'claude', account: WORK, status: 'done', attempt: '2026-10-03T02:00:00Z' },
    );
    assert.equal(stale.applied, false);
    assert.deepEqual(await stored(m.runnerId), { claude: { default: 'Main', [WORK]: 'Research' }, codex: { [WORK]: 'Clients' } });

    const done = await api.accountRemoveResult(
      { id: m.runnerId },
      { engine: 'claude', account: WORK, status: 'done', attempt: asked.toISOString() },
    );
    assert.equal(done.applied, true);
    // Codex's slot with the same id is another account, and keeps its name.
    assert.deepEqual(await stored(m.runnerId), { claude: { default: 'Main' }, codex: { [WORK]: 'Clients' } });
  });
});
