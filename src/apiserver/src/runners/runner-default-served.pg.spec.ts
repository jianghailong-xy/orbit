/**
 * A RUNNER AS ORBIT SERVES IT WITH A DEFAULT REMOVED FROM ORBIT, ON REAL POSTGRESQL.
 *
 * RunnersService.removeAccount records a removed Default in `runner.default_removed` (migration 0440),
 * and every runner read Orbit serves reads it back through usedRunnerEngines. What only the real list
 * can say is that its select reads the column, and that every route returning runners serves the same:
 *
 *   (1) Before any removal, GET /runners, GET /runners/:id and a reorder serve the engines as reported,
 *       with the names given in Orbit laid over them, and the quota as stored.
 *   (2) Removed beside two other accounts: Default is left out, the engine is marked with Default's
 *       directory and the name it was given in Orbit, and the engine reads signed in as the accounts
 *       that remain do. Codex's own quota windows, which were Default's, are gone.
 *   (3) Removed beside one: that account is the engine's sign-in, and its quota is the engine's own.
 *   (4) Brought back: the engine and its quota are served exactly as before the removal.
 *   (5) The other account gone from the report while the record stays: Default is listed and in use
 *       again, and an account reported later leaves it out again.
 *   (6) Another owner's runner reporting the same is served as reported, whatever this owner removed.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/runners/runner-default-served.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient, RunnerStatus } from '@prisma/client';
import type { PlanUsage, RunnerEngineAccount, RunnerEngineHealth } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { RunnersService } from './runners.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const WORK = '3fa91c2e';
const HOME = '5d2e8b10';
const TEAM = '77aa0c3d';

// Both Defaults signed out on the machine: what a client older than the marker would call the engine.
const CODEX_DEFAULT: RunnerEngineAccount = {
  id: 'default',
  home: '/root/.codex',
  codexHome: '/root/.codex',
  auth: 'no',
  fingerprintPrefix: 'cxa1_9f3a41c7',
};
const codexAccount = (id: string, name: string): RunnerEngineAccount => ({
  id,
  name,
  home: `/root/.orbit/codex-accounts/${id}`,
  codexHome: `/root/.orbit/codex-accounts/${id}`,
  auth: 'yes',
});
const CLAUDE_DEFAULT: RunnerEngineAccount = { id: 'default', home: '/root/.claude', auth: 'no' };
const TEAM_ACCOUNT: RunnerEngineAccount = {
  id: TEAM,
  name: 'Team',
  home: `/root/.orbit/claude-accounts/${TEAM}`,
  auth: 'yes',
  loginExpiresAt: '2026-11-30T08:00:00.000Z',
};

/** The engines as the heartbeat stores them, each engine's own answer being its Default's. */
const ENGINES: RunnerEngineHealth[] = [
  { engine: 'claude', installed: true, version: '2.1.287 (Claude Code)', auth: 'no', accounts: [CLAUDE_DEFAULT, TEAM_ACCOUNT] },
  {
    engine: 'codex',
    installed: true,
    version: 'codex-cli 0.156.0',
    auth: 'no',
    accounts: [CODEX_DEFAULT, codexAccount(WORK, 'Work'), codexAccount(HOME, 'Home')],
  },
];

/** The heartbeat's planUsage: each engine's own windows are Default's, every other account's by id. */
const TEAM_USAGE = { provider: 'claude', fiveHour: { utilization: 20, resetsAt: '2026-10-22T01:00:00.000Z' }, fetchedAt: '2026-10-21T16:00:00.000Z' };
const WORK_USAGE = { provider: 'codex', primary: { utilization: 10 }, fetchedAt: '2026-10-21T16:00:00.000Z' };
const PLAN_USAGE = {
  claude: {
    provider: 'claude',
    fiveHour: { utilization: 100, resetsAt: '2026-10-22T03:00:00.000Z' },
    accounts: { [TEAM]: TEAM_USAGE },
    fetchedAt: '2026-10-21T15:59:00.000Z',
  },
  codex: { provider: 'codex', primary: { utilization: 100 }, accounts: { [WORK]: WORK_USAGE } },
  fetchedAt: '2026-10-21T16:00:00.000Z',
};

/** The engines served before anything is removed: as reported, Codex's Default by its name in Orbit. */
const AS_REPORTED: RunnerEngineHealth[] = [
  ENGINES[0],
  { ...ENGINES[1], accounts: [{ ...CODEX_DEFAULT, name: 'Machine login' }, ...ENGINES[1].accounts!.slice(1)] },
];

test('a runner served with a Default removed from Orbit', { skip, concurrency: 1, timeout: 120_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const runners = new RunnersService(prisma);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  /** An owner and a runner reporting ENGINES and PLAN_USAGE, Codex's Default renamed in Orbit. */
  async function machine(label: string) {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    await db.user.create({ data: { id: ownerId, email: `${label}-${ownerId}@default-served.invalid`, name: 'The owner', passwordHash: 'x' } });
    await db.runner.create({
      data: {
        id: runnerId,
        ownerId,
        name: `${label}-runner`,
        tokenHash: `hash-${runnerId}`,
        status: RunnerStatus.ONLINE,
        lastHeartbeatAt: new Date(),
        engines: ENGINES as unknown as Prisma.InputJsonValue,
        planUsage: PLAN_USAGE as unknown as Prisma.InputJsonValue,
        accountNames: { codex: { default: 'Machine login' } },
      },
    });
    return { ownerId, runnerId };
  }

  /** The runner's next report, as its heartbeat stores it. */
  async function reports(runnerId: string, engines: RunnerEngineHealth[]) {
    await db.runner.update({ where: { id: runnerId }, data: { engines: engines as unknown as Prisma.InputJsonValue } });
  }

  async function removed(runnerId: string): Promise<string[]> {
    const r = await sql.query(`SELECT default_removed FROM "runner" WHERE id = $1::uuid`, [runnerId]);
    return r.rows[0].default_removed;
  }

  /** The runner as each route serves it — the list, the detail and a reorder — which must agree. */
  async function served(m: { ownerId: string; runnerId: string }) {
    const listed = await runners.listRunners(m.ownerId);
    assert.deepEqual(listed.map((runner) => runner.id), [m.runnerId], 'the owner’s one runner');
    const [runner] = listed;
    assert.deepEqual(await runners.getRunner(m.ownerId, m.runnerId), runner, 'GET /runners/:id');
    const [reordered] = await runners.reorderRunners(m.ownerId, [m.runnerId]);
    assert.deepEqual(
      { engines: reordered.engines, planUsage: reordered.planUsage },
      { engines: runner.engines, planUsage: runner.planUsage },
      'POST /runners/reorder',
    );
    return { engines: runner.engines!, planUsage: runner.planUsage as unknown as PlanUsage };
  }

  await t.test('(1)–(5) before removal, removed beside two and beside one, brought back, and the other account gone', async () => {
    const m = await machine('served');

    // (1) Nothing removed: as reported, and the quota as stored.
    const before = await served(m);
    assert.deepEqual(before.engines, AS_REPORTED);
    assert.deepEqual(before.planUsage, PLAN_USAGE);

    // (2) Codex's Default removed beside two other accounts.
    await runners.removeAccount(m.ownerId, m.runnerId, 'codex', 'default');
    const two = await served(m);
    assert.deepEqual(two.engines, [
      AS_REPORTED[0],
      {
        engine: 'codex',
        installed: true,
        version: 'codex-cli 0.156.0',
        // Default is signed out on the machine; the accounts Orbit uses are signed in.
        auth: 'yes',
        accounts: [codexAccount(WORK, 'Work'), codexAccount(HOME, 'Home')],
        removedDefault: { home: '/root/.codex', name: 'Machine login', fingerprintPrefix: 'cxa1_9f3a41c7' },
      },
    ]);
    assert.deepEqual(two.planUsage, { ...PLAN_USAGE, codex: { provider: 'codex', accounts: { [WORK]: WORK_USAGE } } });

    // (3) Claude Code's Default removed beside its one other account.
    await runners.removeAccount(m.ownerId, m.runnerId, 'claude', 'default');
    const one = await served(m);
    assert.deepEqual(one.engines[0], {
      engine: 'claude',
      installed: true,
      version: '2.1.287 (Claude Code)',
      auth: 'yes',
      accounts: [TEAM_ACCOUNT],
      removedDefault: { home: '/root/.claude' },
    });
    assert.deepEqual(one.planUsage.claude, { ...TEAM_USAGE, accounts: { [TEAM]: TEAM_USAGE } });
    assert.deepEqual(one.engines[1], two.engines[1], 'Codex as it was');
    assert.deepEqual((await removed(m.runnerId)).sort(), ['claude', 'codex']);

    // (4) Codex's Default brought back: exactly as before, and Claude Code's still removed.
    await runners.restoreDefault(m.ownerId, m.runnerId, 'codex');
    const restored = await served(m);
    assert.deepEqual(restored.engines, [one.engines[0], AS_REPORTED[1]]);
    assert.deepEqual(restored.planUsage, { ...PLAN_USAGE, claude: one.planUsage.claude });

    // (5) Team removed on the machine: the next report lists Claude Code's Default alone. It is the one
    // account Orbit has there, listed as reported and signed out as it is, and nothing marks it — while
    // the record stays.
    await reports(m.runnerId, [{ ...ENGINES[0], accounts: [CLAUDE_DEFAULT] }, ENGINES[1]]);
    const alone = await served(m);
    assert.deepEqual(alone.engines, [{ ...ENGINES[0], accounts: [CLAUDE_DEFAULT] }, AS_REPORTED[1]]);
    assert.deepEqual(alone.planUsage, PLAN_USAGE);
    assert.deepEqual(await removed(m.runnerId), ['claude']);
    // Another account reported later finds the record waiting.
    await reports(m.runnerId, ENGINES);
    assert.deepEqual((await served(m)).engines, restored.engines);
  });

  await t.test('(6) another owner’s runner is served as reported, whatever this owner removed', async () => {
    const mine = await machine('six-mine');
    const theirs = await machine('six-theirs');
    await runners.removeAccount(mine.ownerId, mine.runnerId, 'codex', 'default');
    await runners.removeAccount(mine.ownerId, mine.runnerId, 'claude', 'default');

    const other = await served(theirs);
    assert.deepEqual(other.engines, AS_REPORTED);
    assert.deepEqual(other.planUsage, PLAN_USAGE);
    assert.deepEqual(await removed(theirs.runnerId), []);
    await assert.rejects(runners.getRunner(theirs.ownerId, mine.runnerId), NotFoundException);

    // And the other way round: their removal leaves mine as it was.
    await runners.removeAccount(theirs.ownerId, theirs.runnerId, 'codex', 'default');
    await runners.restoreDefault(mine.ownerId, mine.runnerId, 'codex');
    const own = await served(mine);
    assert.deepEqual(own.engines[1], AS_REPORTED[1]);
    assert.equal('removedDefault' in own.engines[0], true, 'Claude Code’s Default still removed here');
  });
});
