/**
 * Codex's token-only turn completions belong in the same usage ledger as Claude's per-model
 * breakdown. The runner forwards tokenUsage.last (the latest request, not the thread's total),
 * so the API persists the reported counters directly, once per completed turn.
 *
 * scripts/run-pg-spec.sh src/apiserver/src/runner-api/codex-usage-rows.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunEventType, RunStatus as SharedRunStatus, type TurnCompleteRequest } from '@orbit/shared';
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

test('turn-complete persists Codex tokens and preserves Claude model usage', {
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

  const ownerId = randomUUID();
  const runnerId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${ownerId}@codex-usage.invalid`, name: 'Owner', passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'usage runner', tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
    },
  });

  async function session(provider: string, model: string | null) {
    return db.session.create({
      data: {
        ownerId, creatorId: ownerId, assignedRunnerId: runnerId, provider, model,
        title: 'usage session', prompt: 'report usage', status: RunStatus.RUNNING,
        engineTurnActive: true, dispatchOrigin: SessionDispatchOrigin.USER,
      },
      select: { id: true },
    });
  }

  async function turn(sessionId: string, seq = 1) {
    await db.session.update({
      where: { id: sessionId }, data: { status: RunStatus.RUNNING, engineTurnActive: true },
    });
    const row = await db.conversationTurn.create({
      data: {
        sessionId, seq, clientTurnId: `usage-${randomUUID()}`, kind: 'message',
        content: 'report usage', status: 'IN_FLIGHT', deliveredAt: new Date(),
        leaseDeadlineAt: new Date(Date.now() + 300_000),
      },
      select: { id: true },
    });
    await api.events({ id: runnerId }, sessionId, {
      events: [{
        seq, type: RunEventType.ASSISTANT, ts: new Date().toISOString(),
        turnId: row.id, payload: { text: 'done' },
      }],
    });
    return row.id;
  }

  function complete(sessionId: string, turnId: string, usage: Partial<TurnCompleteRequest> = {}) {
    return api.turnComplete({ id: runnerId }, sessionId, {
      turnId, status: SharedRunStatus.SUCCEEDED, subtype: 'completed', numTurns: 1,
      costUsd: 0, ...usage,
    });
  }

  async function rows(sessionId: string) {
    return (await sql.query(
      `SELECT model, input_tokens AS "inputTokens", output_tokens AS "outputTokens",
              cache_creation_input_tokens AS "cacheCreationInputTokens",
              cache_read_input_tokens AS "cacheReadInputTokens", cost_usd AS "costUsd"
         FROM usage WHERE session_id = $1::uuid ORDER BY model`,
      [sessionId],
    )).rows;
  }

  await t.test('Codex writes one token-only row per turn, using the current model, without replay billing', async () => {
    const s = await session('codex', 'old-model');
    const first = await turn(s.id);
    await db.session.update({ where: { id: s.id }, data: { model: 'gpt-6-sol' } });
    const usage = {
      input_tokens: 1_200, output_tokens: 80,
      cache_creation_input_tokens: 30, cache_read_input_tokens: 600,
    };
    const expected = {
      model: 'gpt-6-sol', inputTokens: 1_200, outputTokens: 80,
      cacheCreationInputTokens: 30, cacheReadInputTokens: 600, costUsd: 0,
    };
    assert.deepEqual(await complete(s.id, first, { usage }), {
      ok: true, status: RunStatus.AWAITING_INPUT,
    });
    assert.deepEqual(await rows(s.id), [expected]);
    await complete(s.id, first, { usage });
    assert.deepEqual(await rows(s.id), [expected], 'a repeated completion cannot book another row');

    const second = await turn(s.id, 2);
    await db.session.update({ where: { id: s.id }, data: { model: 'gpt-6.1-sol' } });
    await complete(s.id, second, {
      usage: {
        input_tokens: 40, output_tokens: 5,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 10,
      },
    });
    assert.deepEqual(await rows(s.id), [expected, {
      model: 'gpt-6.1-sol', inputTokens: 40, outputTokens: 5,
      cacheCreationInputTokens: 0, cacheReadInputTokens: 10, costUsd: 0,
    }], 'each turn stores its reported counters without subtracting earlier turns');
  });

  await t.test('Claude keeps its per-model counters and costs when aggregate usage is also present', async () => {
    const s = await session('claude', 'session-model');
    const turnId = await turn(s.id);
    const dto = {
      costUsd: 0.75,
      usage: {
        input_tokens: 999, output_tokens: 888,
        cache_creation_input_tokens: 777, cache_read_input_tokens: 666,
      },
      modelUsage: {
        'claude-haiku-4-5': {
          inputTokens: 10, outputTokens: 20,
          cacheCreationInputTokens: 30, cacheReadInputTokens: 40, costUSD: 0.25,
        },
        'claude-opus-4-6': {
          inputTokens: 100, outputTokens: 200,
          cacheCreationInputTokens: 300, cacheReadInputTokens: 400, costUSD: 0.5,
        },
      },
    };
    await complete(s.id, turnId, dto);
    const expected = Object.entries(dto.modelUsage).map(([model, { costUSD, ...tokens }]) => ({
      model, ...tokens, costUsd: costUSD,
    }));
    assert.deepEqual(await rows(s.id), expected, 'modelUsage takes precedence over aggregate usage');
    await complete(s.id, turnId, dto);
    assert.deepEqual(await rows(s.id), expected, 'Claude replay remains idempotent');
  });

  await t.test('a completion without usage adds no row', async () => {
    const s = await session('codex', 'gpt-6.1-sol');
    await complete(s.id, await turn(s.id));
    assert.deepEqual(await rows(s.id), []);
  });

  await t.test('an empty modelUsage keeps the existing behavior instead of using aggregate usage', async () => {
    const s = await session('claude', 'claude-opus-4-6');
    await complete(s.id, await turn(s.id), {
      modelUsage: {},
      usage: {
        input_tokens: 10, output_tokens: 20,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 5,
      },
    });
    assert.deepEqual(await rows(s.id), []);
  });

  await t.test('a legacy session without a materialized model still completes', async () => {
    const s = await session('codex', null);
    assert.deepEqual(await complete(s.id, await turn(s.id), {
      usage: {
        input_tokens: 10, output_tokens: 20,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 5,
      },
    }), { ok: true, status: RunStatus.AWAITING_INPUT });
    assert.deepEqual(await rows(s.id), []);
  });
});
