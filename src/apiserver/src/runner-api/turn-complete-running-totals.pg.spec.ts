/**
 * A Claude turn books its own cost and tokens (task 34sjn2yQvNJg1JhQIARvd). Claude Code's
 * `total_cost_usd` and `modelUsage` are running totals of its process, and a process started with
 * `--resume` restores what its transcript last saved, which a killed process never wrote: so a new
 * process carries the total on, goes back to an older one, or starts from zero. turn-complete used
 * to add the total to `session.cost_usd` and write it as a new `usage` row on every turn.
 *
 * The runner names the process each completion's totals are of and what it restored when it started
 * (`runningTotals`), and the session holds the totals it booked last (`engine_usage_totals`): a turn
 * books the difference from the completion before it in the same process, or from what its process
 * restored. Costs are binary fractions, so every sum here is exact.
 *
 * scripts/run-pg-spec.sh src/apiserver/src/runner-api/turn-complete-running-totals.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import {
  RunEventType,
  RunStatus as SharedRunStatus,
  type ModelUsage,
  type TurnCompleteRequest,
} from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { RunnerApiController } from './runner-api.controller';

const URL = process.env.COORDINATOR_PG_URL;
const OPUS = 'claude-opus-5-5';
const HAIKU = 'claude-haiku-5-5';

/** One model's counts: input, output, cache writes, cache reads, cost. */
type Counts = [number, number, number, number, number];
type Totals = { costUsd: number; models: Record<string, Counts> };
/** A usage row as `[model, ...Counts]`. */
type Row = [string, ...Counts];

const usage = ([input, output, cacheWrite, cacheRead, cost]: Counts): ModelUsage => ({
  inputTokens: input, outputTokens: output,
  cacheCreationInputTokens: cacheWrite, cacheReadInputTokens: cacheRead, costUSD: cost,
});
const modelUsage = (models: Record<string, Counts>): Record<string, ModelUsage> =>
  Object.fromEntries(Object.entries(models).map(([model, counts]) => [model, usage(counts)]));
const NOTHING: Totals = { costUsd: 0, models: {} };

test('a Claude turn books its own cost and tokens, and no turn twice', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const sql = new Client({ connectionString: URL!, connectionTimeoutMillis: 5_000 });
  t.after(async () => { await sql.end(); });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(URL!);
  t.after(async () => { await db.$disconnect(); });

  const api = new RunnerApiController(
    db as unknown as PrismaService,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService,
    {} as never,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
  );
  (api as unknown as { logger: { warn: (line: string) => void } }).logger.warn = () => undefined;

  const ownerId = randomUUID();
  const runnerId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${ownerId}@running-totals.invalid`, name: 'Owner', passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'totals runner', tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
    },
  });

  async function session(data: { provider?: string; model?: string; costUsd?: number } = {}) {
    const { id } = await db.session.create({
      data: {
        ownerId, creatorId: ownerId, assignedRunnerId: runnerId, provider: data.provider ?? 'claude',
        model: data.model ?? OPUS, costUsd: data.costUsd ?? 0,
        title: 'totals session', prompt: 'report totals', status: RunStatus.RUNNING,
        engineTurnActive: true, dispatchOrigin: SessionDispatchOrigin.USER,
      },
      select: { id: true },
    });
    return id;
  }

  let seq = 0;
  /** A delivered message turn its engine answered. */
  async function turn(sessionId: string) {
    seq += 1;
    await db.session.update({
      where: { id: sessionId }, data: { status: RunStatus.RUNNING, engineTurnActive: true },
    });
    const { id } = await db.conversationTurn.create({
      data: {
        sessionId, seq, clientTurnId: `totals-${randomUUID()}`, kind: 'message',
        content: 'report totals', status: 'IN_FLIGHT', deliveredAt: new Date(),
        leaseDeadlineAt: new Date(Date.now() + 300_000),
      },
      select: { id: true },
    });
    await api.events({ id: runnerId }, sessionId, {
      events: [{ seq, type: RunEventType.ASSISTANT, ts: new Date().toISOString(), turnId: id, payload: { text: 'done' } }],
    });
    return id;
  }

  /** A Claude completion: the process's totals, and — from a runner that says — whose they are. */
  function claude(turnId: string, totals: Totals, process?: { id: string; restored: Totals }): TurnCompleteRequest {
    return {
      turnId, status: SharedRunStatus.SUCCEEDED, subtype: 'success', numTurns: 1,
      costUsd: totals.costUsd, modelUsage: modelUsage(totals.models),
      ...(process ? {
        runningTotals: {
          process: process.id,
          restored: { costUsd: process.restored.costUsd, modelUsage: modelUsage(process.restored.models) },
        },
      } : {}),
    };
  }

  async function complete(sessionId: string, report: TurnCompleteRequest) {
    assert.deepEqual(await api.turnComplete({ id: runnerId }, sessionId, report), {
      ok: true, status: RunStatus.AWAITING_INPUT,
    });
  }

  /** What the session has booked: its cost, and its usage rows in a fixed order. */
  async function booked(sessionId: string): Promise<{ cost: number; rows: Row[] }> {
    const { costUsd } = await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { costUsd: true } });
    const { rows } = await sql.query<{ row: Row }>(
      `SELECT json_build_array(model, input_tokens, output_tokens, cache_creation_input_tokens,
                               cache_read_input_tokens, cost_usd) AS row
         FROM usage WHERE session_id = $1::uuid`,
      [sessionId],
    );
    return { cost: costUsd, rows: rows.map(({ row }) => row).sort(byRow) };
  }
  const byRow = (a: Row, b: Row) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1;
  const sorted = (rows: Row[]) => [...rows].sort(byRow);

  // ── The four cases the task names, in the order a session meets them ──────────────────────────
  const s = await session();
  const first = randomUUID();
  const turn1: Totals = { costUsd: 0.25, models: { [OPUS]: [1000, 10, 100, 5000, 0.25] } };
  const turn2: Totals = {
    costUsd: 0.75,
    models: { [OPUS]: [1600, 30, 300, 12000, 0.5], [HAIKU]: [40, 4, 0, 0, 0.25] },
  };
  const expected: Row[] = [];
  const turns: string[] = [];
  const next = async () => { turns.push(await turn(s)); return turns.at(-1)!; };

  await t.test('two turns of one process: each books its own share', async () => {
    await complete(s, claude(await next(), turn1, { id: first, restored: NOTHING }));
    expected.push([OPUS, 1000, 10, 100, 5000, 0.25]);
    assert.deepEqual(await booked(s), { cost: 0.25, rows: sorted(expected) },
      'a new conversation starts from nothing: its first turn is all of its totals');

    await complete(s, claude(await next(), turn2, { id: first, restored: NOTHING }));
    // A subagent's model joins the totals: it is the turn's, and so is opus's difference.
    expected.push([OPUS, 600, 20, 200, 7000, 0.25], [HAIKU, 40, 4, 0, 0, 0.25]);
    assert.deepEqual(await booked(s), { cost: 0.75, rows: sorted(expected) },
      'the second turn books its totals less the first turn\'s, not the totals again');
  });

  await t.test('a resume that carries the total on books only its own turn', async () => {
    // The process before it exited on its own and saved its totals; this one restored them.
    const turn3: Totals = {
      costUsd: 1,
      models: { [OPUS]: [2100, 40, 400, 16000, 0.75], [HAIKU]: [40, 4, 0, 0, 0.25] },
    };
    await complete(s, claude(await next(), turn3, { id: randomUUID(), restored: turn2 }));
    expected.push([OPUS, 500, 10, 100, 4000, 0.25]);
    assert.deepEqual(await booked(s), { cost: 1, rows: sorted(expected) },
      'the restored totals are not booked again, and a model the turn did not use writes no row');
  });

  await t.test('a process that restored an older save books its own turn exactly', async () => {
    // The process before was killed, which saves nothing: this one restored the save from before
    // turn 2. Its totals are below what was booked, and its turn is still exactly theirs.
    const turn4: Totals = { costUsd: 0.375, models: { [OPUS]: [1300, 15, 150, 7000, 0.375] } };
    await complete(s, claude(await next(), turn4, { id: randomUUID(), restored: turn1 }));
    expected.push([OPUS, 300, 5, 50, 2000, 0.125]);
    assert.deepEqual(await booked(s), { cost: 1.125, rows: sorted(expected) });
  });

  const fromZero = randomUUID();
  const turn5: Totals = { costUsd: 0.0625, models: { [OPUS]: [200, 2, 20, 1000, 0.0625] } };
  await t.test('a restart from zero books its turn whole', async () => {
    // A transcript that saved nothing (rebuilt from Orbit's events, or never exited gracefully).
    await complete(s, claude(await next(), turn5, { id: fromZero, restored: NOTHING }));
    expected.push([OPUS, 200, 2, 20, 1000, 0.0625]);
    assert.deepEqual(await booked(s), { cost: 1.1875, rows: sorted(expected) });
  });

  await t.test('a re-posted completion books nothing', async () => {
    const before = await db.session.findUniqueOrThrow({ where: { id: s }, select: { engineUsageTotals: true } });
    const last = await next();
    const turn6: Totals = { costUsd: 0.125, models: { [OPUS]: [300, 4, 30, 1500, 0.125] } };
    const report = claude(last, turn6, { id: fromZero, restored: NOTHING });
    await complete(s, report);
    expected.push([OPUS, 100, 2, 10, 500, 0.0625]);
    const once = await booked(s);
    assert.deepEqual(once, { cost: 1.25, rows: sorted(expected) });
    const totals = await db.session.findUniqueOrThrow({ where: { id: s }, select: { engineUsageTotals: true } });
    assert.notDeepEqual(totals, before);

    // The runner's re-post of a completion whose answer it lost, and a late one of an earlier
    // process's turn: neither books a cent or a row, nor moves what the next turn is measured from.
    await complete(s, report);
    await complete(s, claude(turns[1]!, turn2, { id: first, restored: NOTHING }));
    assert.deepEqual(await booked(s), once);
    assert.deepEqual(
      await db.session.findUniqueOrThrow({ where: { id: s }, select: { engineUsageTotals: true } }),
      totals,
    );
  });

  // ── What else the rule touches ──────────────────────────────────────────────────────────────
  await t.test('a resumed turn that ran no engine turn is still owed its delivery', async () => {
    // A message from another session, settled by its turn running unless no engine turn ran. The
    // restored totals made "cost 0" false for a turn that spent nothing, and it was answered unread.
    const sender = await session();
    const r = await session();
    const restored: Totals = { costUsd: 0.5, models: { [OPUS]: [900, 9, 90, 4000, 0.5] } };
    const { id: turnId } = await db.conversationTurn.create({
      data: {
        sessionId: r, seq: 1, clientTurnId: `totals-${randomUUID()}`, kind: 'message',
        content: 'read this', status: 'IN_FLIGHT', deliveredAt: new Date(),
        leaseDeadlineAt: new Date(Date.now() + 300_000), senderSessionId: sender,
      },
      select: { id: true },
    });
    const report = { ...claude(turnId, restored, { id: randomUUID(), restored }), numTurns: 0 };
    await api.turnComplete({ id: runnerId }, r, report);
    const row = await db.conversationTurn.findUniqueOrThrow({ where: { id: turnId } });
    assert.equal(row.status, 'PENDING', 'never read, so back in the queue rather than answered');
    const after = await db.session.findUniqueOrThrow({ where: { id: r }, select: { retryAt: true } });
    assert.notEqual(after.retryAt, null, 'with the retry that re-sends it armed');
    assert.deepEqual(await booked(r), { cost: 0, rows: [] }, 'and nothing it did not spend is booked');
  });

  await t.test('a completion settled without its reports leaves its spend to the next turn', async () => {
    const q = await session();
    const process = { id: randomUUID(), restored: NOTHING };
    await complete(q, claude(await turn(q), turn1, process));
    // A report the database refuses (0347's shape) rolls back with the turn's booking, and the turn
    // settles on what decides it alone: nothing booked, and the totals booked before stay put.
    await complete(q, { ...claude(await turn(q), turn2, process), numTurns: 3_000_000_000 });
    assert.deepEqual(await booked(q), { cost: 0.25, rows: [[OPUS, 1000, 10, 100, 5000, 0.25]] });
    const turn3: Totals = {
      costUsd: 1,
      models: { [OPUS]: [2100, 40, 400, 16000, 0.75], [HAIKU]: [40, 4, 0, 0, 0.25] },
    };
    await complete(q, claude(await turn(q), turn3, process));
    assert.deepEqual(await booked(q), {
      cost: 1,
      rows: sorted([[OPUS, 1000, 10, 100, 5000, 0.25], [OPUS, 1100, 30, 300, 11000, 0.5], [HAIKU, 40, 4, 0, 0, 0.25]]),
    }, 'the next turn of the process books both, measured from what was booked: the session\'s cost is the engine\'s');
  });

  await t.test('from an older runner: measured from what was booked last, and never twice', async () => {
    // No `runningTotals`: the runner names no process and has not read what one restored.
    const o = await session();
    await complete(o, claude(await turn(o), turn1));
    await complete(o, claude(await turn(o), turn2));
    const steady: Row[] = [[OPUS, 1000, 10, 100, 5000, 0.25], [OPUS, 600, 20, 200, 7000, 0.25], [HAIKU, 40, 4, 0, 0, 0.25]];
    assert.deepEqual(await booked(o), { cost: 0.75, rows: sorted(steady) }, 'exact while one process lives');

    // Its engine restarted from zero. What it restored cannot be known here, so a count below what
    // was booked books nothing for that turn: short, never twice.
    await complete(o, claude(await turn(o), turn5));
    assert.deepEqual(await booked(o), { cost: 0.75, rows: sorted(steady) });
    // And the next turn of that process is measured from the totals its first one reported.
    const next: Totals = { costUsd: 0.1875, models: { [OPUS]: [500, 6, 50, 3000, 0.1875] } };
    await complete(o, claude(await turn(o), next));
    assert.deepEqual(await booked(o), {
      cost: 0.875, rows: sorted([...steady, [OPUS, 300, 4, 30, 2000, 0.125]]),
    });
  });

  await t.test('a session booked before this change: measured from its last rows, which stay as they were', async () => {
    // Before, every turn added the running total to cost_usd and wrote it as a row.
    const b = await session({ costUsd: 5 });
    await db.llmUsage.create({ data: {
      sessionId: b, model: OPUS, inputTokens: 1000, outputTokens: 10, cacheCreationInputTokens: 100,
      cacheReadInputTokens: 5000, costUsd: 2, createdAt: new Date('2026-11-01T00:00:00Z'),
    } });
    await db.llmUsage.create({ data: {
      sessionId: b, model: OPUS, inputTokens: 1500, outputTokens: 15, cacheCreationInputTokens: 150,
      cacheReadInputTokens: 7000, costUsd: 3, createdAt: new Date('2026-11-02T00:00:00Z'),
    } });
    const old: Row[] = [[OPUS, 1000, 10, 100, 5000, 2], [OPUS, 1500, 15, 150, 7000, 3]];
    await complete(b, claude(await turn(b), { costUsd: 3.5, models: { [OPUS]: [1700, 20, 170, 8000, 3.5] } }));
    assert.deepEqual(await booked(b), {
      cost: 5.5, rows: sorted([...old, [OPUS, 200, 5, 20, 1000, 0.5]]),
    }, 'an older runner\'s first turn after the change books its share, and the rows before it are untouched');

    // A runner that names its process measures from what that process restored, whatever came before.
    const n = await session({ costUsd: 5 });
    for (const [row, day] of old.map((r, i) => [r, i + 1] as const)) {
      await db.llmUsage.create({ data: {
        sessionId: n, model: row[0], inputTokens: row[1], outputTokens: row[2], cacheCreationInputTokens: row[3],
        cacheReadInputTokens: row[4], costUsd: row[5], createdAt: new Date(`2026-11-0${day}T00:00:00Z`),
      } });
    }
    const restored: Totals = { costUsd: 2, models: { [OPUS]: [1000, 10, 100, 5000, 2] } };
    await complete(n, claude(await turn(n), { costUsd: 2.25, models: { [OPUS]: [1100, 12, 110, 5500, 2.25] } },
      { id: randomUUID(), restored }));
    assert.deepEqual(await booked(n), { cost: 5.25, rows: sorted([...old, [OPUS, 100, 2, 10, 500, 0.25]]) });
  });

  await t.test('engines that report a turn\'s own numbers book as before', async () => {
    // Codex: one token-only row per turn under the session's model, cost 0, nothing subtracted.
    const c = await session({ provider: 'codex', model: 'gpt-6-sol' });
    const tokens = { input_tokens: 1200, output_tokens: 80, cache_creation_input_tokens: 30, cache_read_input_tokens: 600 };
    for (let i = 0; i < 2; i++) {
      await complete(c, {
        turnId: await turn(c), status: SharedRunStatus.SUCCEEDED, subtype: 'completed', numTurns: 1,
        costUsd: 0, usage: tokens,
      });
    }
    const codexRow: Row = ['gpt-6-sol', 1200, 80, 30, 600, 0];
    assert.deepEqual(await booked(c), { cost: 0, rows: [codexRow, codexRow] });

    // OpenCode: its turn's own cost, added as it comes.
    const o = await session({ provider: 'opencode', model: 'opencode-model' });
    for (let i = 0; i < 2; i++) {
      await complete(o, {
        turnId: await turn(o), status: SharedRunStatus.SUCCEEDED, subtype: 'success', numTurns: 1, costUsd: 0.25,
      });
    }
    assert.deepEqual(await booked(o), { cost: 0.5, rows: [] });

    for (const id of [c, o]) {
      const { engineUsageTotals } = await db.session.findUniqueOrThrow({ where: { id }, select: { engineUsageTotals: true } });
      assert.equal(engineUsageTotals, null, 'and no running totals are held for them');
    }
  });
});
