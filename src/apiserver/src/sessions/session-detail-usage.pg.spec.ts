/**
 * Settings → Info: `GET /sessions/:id` answers `usage` (tokens in / out / cache, cost, turns) and
 * `engineVersion`.
 *
 * Tokens come from the session's `usage` rows. A Claude row written before the running-totals rule
 * (migration 0478) held the CLI process's running totals, so only each model's latest such row
 * counts; every row written since holds its turn's own counts and is summed. Engines other than
 * Claude always wrote a turn's own counts, before the rule as after it.
 *
 * scripts/run-pg-spec.sh src/apiserver/src/sessions/session-detail-usage.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Prisma, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { SessionsService } from './sessions.service';

const URL = process.env.COORDINATOR_PG_URL;
const OPUS = 'claude-opus-5-5';
const HAIKU = 'claude-haiku-5-5';
const HOUR = 3_600_000;

/** input, output, cache reads, cache writes */
type Counts = [number, number, number, number];

test('the session detail answers usage totals over legacy running-total rows and per-turn rows', {
  skip: !URL, concurrency: 1, timeout: 120_000,
}, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const sql = new Client({ connectionString: URL!, connectionTimeoutMillis: 5_000 });
  t.after(async () => { await sql.end(); });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(URL!);
  t.after(async () => { await db.$disconnect(); });

  const sessions = new SessionsService(
    db as unknown as PrismaService,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService,
  );

  // The moment the rule shipped: rows before it are the old kind.
  const { rows: [applied] } = await sql.query<{ finished_at: Date | null }>(
    `SELECT finished_at FROM "_prisma_migrations" WHERE migration_name = '0478_session_engine_usage_totals'`,
  );
  assert.ok(applied?.finished_at, 'migration 0478 is applied');
  const rule = applied.finished_at.getTime();

  const ownerId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${ownerId}@detail-usage.invalid`, name: 'Owner', passwordHash: 'x' },
  });
  const runnerId = randomUUID();
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'usage runner', tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      engines: [
        { engine: 'claude', installed: true, version: '2.1.318 (Claude Code)', auth: 'yes' },
        { engine: 'codex', installed: true, version: 'codex-cli 0.130.0', auth: 'yes' },
        { engine: 'kimi', installed: false, auth: 'unknown' },
      ] as unknown as Prisma.InputJsonValue,
    },
  });

  async function session(engine: string, data: { costUsd?: number; numTurns?: number } = {}) {
    const { id } = await db.session.create({
      data: {
        ownerId, creatorId: ownerId, assignedRunnerId: runnerId, provider: engine, engine,
        model: engine === 'claude' ? OPUS : 'gpt-5.5', costUsd: data.costUsd ?? 0, numTurns: data.numTurns ?? 0,
        title: 'usage session', prompt: 'spend', status: RunStatus.AWAITING_INPUT,
        dispatchOrigin: SessionDispatchOrigin.USER,
      },
      select: { id: true },
    });
    return id;
  }
  async function row(sessionId: string, model: string, at: number, [input, output, cacheRead, cacheWrite]: Counts) {
    await db.llmUsage.create({
      data: {
        sessionId, model, createdAt: new Date(at),
        inputTokens: input, outputTokens: output, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheWrite,
      },
    });
  }
  const detail = async (id: string) =>
    await sessions.get(ownerId, id) as unknown as { usage: Record<string, number>; engineVersion: string | null };

  await t.test('Claude: each model\'s latest legacy row, plus every per-turn row after the rule', async () => {
    const id = await session('claude', { costUsd: 12.5, numTurns: 7 });
    // Before the rule: the process's running totals, growing turn by turn.
    await row(id, OPUS, rule - 3 * HOUR, [100, 10, 1_000, 50]);
    await row(id, OPUS, rule - 2 * HOUR, [250, 25, 3_000, 120]);
    await row(id, OPUS, rule - 1 * HOUR, [400, 40, 5_000, 200]);
    await row(id, HAIKU, rule - 2 * HOUR, [5, 1, 0, 0]);
    await row(id, HAIKU, rule - 1 * HOUR, [9, 2, 0, 0]);
    // Since the rule: each turn's own counts.
    await row(id, OPUS, rule + 1 * HOUR, [30, 3, 700, 20]);
    await row(id, OPUS, rule + 2 * HOUR, [70, 7, 300, 80]);
    await row(id, HAIKU, rule + 2 * HOUR, [4, 1, 0, 0]);

    const got = await detail(id);
    assert.deepEqual(got.usage, {
      inputTokens: 400 + 9 + 30 + 70 + 4,
      outputTokens: 40 + 2 + 3 + 7 + 1,
      cacheReadTokens: 5_000 + 0 + 700 + 300,
      cacheCreationTokens: 200 + 0 + 20 + 80,
      costUsd: 12.5,
      numTurns: 7,
    });
    // A plain SUM would have counted the first legacy turns again on each later one.
    assert.notEqual(got.usage.inputTokens, 100 + 250 + 400 + 5 + 9 + 30 + 70 + 4);
    assert.equal(got.engineVersion, '2.1.318 (Claude Code)');
  });

  await t.test('Claude with only legacy rows: the latest per model', async () => {
    const id = await session('claude');
    await row(id, OPUS, rule - 2 * HOUR, [10, 1, 100, 5]);
    await row(id, OPUS, rule - 1 * HOUR, [20, 2, 200, 10]);
    assert.deepEqual((await detail(id)).usage, {
      inputTokens: 20, outputTokens: 2, cacheReadTokens: 200, cacheCreationTokens: 10, costUsd: 0, numTurns: 0,
    });
  });

  await t.test('Codex rows were always per turn: every row is summed, before the rule as after', async () => {
    const id = await session('codex', { numTurns: 3 });
    await row(id, 'gpt-5.5', rule - 2 * HOUR, [100, 10, 50, 0]);
    await row(id, 'gpt-5.5', rule - 1 * HOUR, [200, 20, 60, 0]);
    await row(id, 'gpt-5.5', rule + 1 * HOUR, [300, 30, 70, 0]);
    const got = await detail(id);
    assert.deepEqual(got.usage, {
      inputTokens: 600, outputTokens: 60, cacheReadTokens: 180, cacheCreationTokens: 0, costUsd: 0, numTurns: 3,
    });
    assert.equal(got.engineVersion, 'codex-cli 0.130.0');
  });

  await t.test('no rows, and an engine the runner reports no version for: zeros and null', async () => {
    const id = await session('kimi');
    const got = await detail(id);
    assert.deepEqual(got.usage, {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, numTurns: 0,
    });
    assert.equal(got.engineVersion, null);
  });

  await t.test('no assigned runner: engineVersion is null', async () => {
    const id = await session('claude');
    await db.session.update({ where: { id }, data: { assignedRunnerId: null } });
    assert.equal((await detail(id)).engineVersion, null);
  });
});
