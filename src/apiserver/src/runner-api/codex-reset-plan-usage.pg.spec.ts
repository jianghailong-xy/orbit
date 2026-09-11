import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import {
  codexRateLimitResetOf,
  type PlanUsage,
  type PlanUsageRateLimitReset,
  type RunnerHeartbeatRequest,
} from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { storeHeartbeatPlanUsage } from './codex-reset-plan-usage';
import { RunnerApiController } from './runner-api.controller';

/**
 * The heartbeat's planUsage compare-and-set, run as SQL against a real PostgreSQL
 * (docs/codex-rate-limit-reset-contract.md §8), named in scripts/test-codex-reset-read.sh.
 *
 * codex-reset-plan-usage.spec.ts pins the merge against a double that compares JSON by value. Only a
 * real database can say that Prisma's `equals` on a jsonb column is that comparison — that a stored
 * NULL matches, that a value re-read and sent back matches, and that a row changed between the read
 * and the write does not — and only real concurrent heartbeats can show that two processes racing
 * never leave an older block stored. Every row is read back over a second connection.
 *
 * Needs COORDINATOR_PG_URL (scripts/run-pg-spec.sh provides a disposable one); without it every case
 * reports as skipped, and that script counts a skip as red.
 */

const PG_URL = process.env.COORDINATOR_PG_URL;
const skip = !PG_URL;

const FIXTURES = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../../contracts/codex-rate-limit-reset.fixtures.json'), 'utf8'),
) as { heartbeats: Record<'nestedReset', RunnerHeartbeatRequest> };

const A = '6f1c2b7e-4d3a-4b8e-9c21-7a5e0d3f9b12';
const B = '0b9e8d7c-6a5f-4e3d-8c2b-1a0f9e8d7c6b';

function beat(leaseOwner: string, block: Partial<PlanUsageRateLimitReset>, utilization: number): RunnerHeartbeatRequest {
  const dto = structuredClone(FIXTURES.heartbeats.nestedReset);
  const codex = dto.planUsage!.codex!;
  codex.primary!.utilization = utilization;
  codex.rateLimitReset = { ...codex.rateLimitReset!, ...block };
  return { ...dto, leaseOwner };
}

/** A read started `offsetMs` after 04:00 on the fixtures' day: always in the past. */
const readAt = (offsetMs: number) => new Date(Date.parse('2026-09-11T04:00:00.000Z') + offsetMs).toISOString();

test('the planUsage compare-and-set against PostgreSQL', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
  const url = PG_URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma = new PrismaClient({ adapter: new PrismaPg(url) });
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const owner = await prisma.user.create({
    data: { email: `codex-reset-${randomUUID()}@example.invalid`, name: 'codex reset', passwordHash: 'not-a-login' },
  });
  const newRunner = async () =>
    (await prisma.runner.create({ data: { name: 'codex-reset', ownerId: owner.id, tokenHash: randomUUID() } })).id;
  const stored = async (runnerId: string) =>
    (await sql.query<{ plan_usage: PlanUsage | null }>('SELECT plan_usage FROM runner WHERE id = $1', [runnerId])).rows[0].plan_usage;
  const storedBlock = async (runnerId: string) => codexRateLimitResetOf(await stored(runnerId));

  await t.test('a runner that never reported (NULL) is written, and a value re-read and sent back matches', async () => {
    const runnerId = await newRunner();
    assert.equal(await stored(runnerId), null);
    const first = beat(A, { fetchedAt: readAt(1_000), sequence: 1 }, 10);
    assert.equal(await storeHeartbeatPlanUsage(prisma as unknown as PrismaService, runnerId, first.planUsage!, A), true);
    assert.deepEqual(await stored(runnerId), first.planUsage);
    const next = beat(A, { fetchedAt: readAt(2_000), sequence: 2 }, 20);
    assert.equal(await storeHeartbeatPlanUsage(prisma as unknown as PrismaService, runnerId, next.planUsage!, A), true);
    assert.deepEqual(await stored(runnerId), next.planUsage);
  });

  await t.test('an older read from an old process keeps the stored block while the rest of its report lands', async () => {
    const runnerId = await newRunner();
    const newer = beat(B, { fetchedAt: readAt(5_000), generation: B, sequence: 1 }, 30);
    await storeHeartbeatPlanUsage(prisma as unknown as PrismaService, runnerId, newer.planUsage!, B);
    const older = beat(A, { fetchedAt: readAt(4_000), generation: A, sequence: 12 }, 35);
    assert.equal(await storeHeartbeatPlanUsage(prisma as unknown as PrismaService, runnerId, older.planUsage!, A), true);
    assert.deepEqual(await storedBlock(runnerId), codexRateLimitResetOf(newer.planUsage));
    assert.equal((await stored(runnerId))!.codex!.primary!.utilization, 35);
  });

  await t.test('a newer block written between the read and the write makes the stale write match nothing', async () => {
    const runnerId = await newRunner();
    const base = beat(A, { fetchedAt: readAt(10_000), sequence: 1 }, 40);
    await storeHeartbeatPlanUsage(prisma as unknown as PrismaService, runnerId, base.planUsage!, A);
    const concurrent = beat(B, { fetchedAt: readAt(12_000), generation: B, sequence: 1 }, 45);
    let stale = 0;
    const racing = {
      runner: {
        findUnique: (args: Parameters<typeof prisma.runner.findUnique>[0]) => prisma.runner.findUnique(args),
        updateMany: async (args: Parameters<typeof prisma.runner.updateMany>[0]) => {
          if (stale === 0) {
            await sql.query('UPDATE runner SET plan_usage = $1::jsonb WHERE id = $2', [JSON.stringify(concurrent.planUsage), runnerId]);
          }
          const result = await prisma.runner.updateMany(args);
          if (result.count === 0) stale += 1;
          return result;
        },
      },
    };
    const late = beat(A, { fetchedAt: readAt(11_000), sequence: 2 }, 48);
    assert.equal(await storeHeartbeatPlanUsage(racing as unknown as PrismaService, runnerId, late.planUsage!, A), true);
    assert.equal(stale, 1, 'the write merged against the replaced value matched no row');
    assert.deepEqual(await storedBlock(runnerId), codexRateLimitResetOf(concurrent.planUsage), 'the newer block survives');
    assert.equal((await stored(runnerId))!.codex!.primary!.utilization, 48, 'the late report still lands, merged against it');
  });

  await t.test('two processes heartbeating at once, round after round, never leave an older block stored', async () => {
    const runnerId = await newRunner();
    const realtime = { drainCancellations: async () => [], drainArtifactRequests: async () => [] };
    const controller = new RunnerApiController(
      prisma as unknown as PrismaService,
      {} as never,
      realtime as never,
      {} as never,
      {} as never,
      {} as never,
      { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never,
    );
    const runner = { id: runnerId, version: null };
    await controller.heartbeat(runner, beat(A, { fetchedAt: readAt(100_000), generation: A, sequence: 1 }, 0));
    for (let round = 1; round <= 25; round++) {
      const [ahead, behind] = round % 2 ? [B, A] : [A, B];
      const newer = beat(ahead, { fetchedAt: readAt(100_000 + round * 1_000), generation: ahead, sequence: round + 1 }, round);
      const older = beat(behind, { fetchedAt: readAt(100_000 + round * 1_000 - 500), generation: behind, sequence: round + 1 }, round + 50);
      const beats = round % 3 ? [newer, older] : [older, newer];
      await Promise.all(beats.map((dto) => controller.heartbeat(runner, structuredClone(dto))));
      assert.deepEqual(await storedBlock(runnerId), codexRateLimitResetOf(newer.planUsage), `round ${round}`);
    }
  });
});
