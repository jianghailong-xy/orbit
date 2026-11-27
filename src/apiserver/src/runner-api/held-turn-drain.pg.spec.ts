/**
 * A message held for its translation (status HELD, translation TRANSLATING or FAILED) survives the drain that answers
 * every turn of an ending session. On 2026-11-15 from 22:57Z a message whose translation had failed sat HELD in a
 * session whose turn then failed: the drain set every unanswered turn ANSWERED, conversation_turn_translation_chk
 * refused ANSWERED beside FAILED, the whole completion rolled back, and the runner re-posted it every 2 s.
 *
 * scripts/run-pg-spec.sh src/apiserver/src/runner-api/held-turn-drain.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { RunStatus as SharedRunStatus } from '@orbit/shared';
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
import { wordOf, WORD_SELECT } from '../test-support/session-word';

const URL = process.env.COORDINATOR_PG_URL;

test('a message held for its translation survives the drain of an ending session', {
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
    data: { id: ownerId, email: `${ownerId}@held-turn-drain.invalid`, name: 'Owner', passwordHash: 'x' },
  });
  await db.runner.create({
    data: { id: runnerId, ownerId, name: 'held runner', tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE },
  });

  /** A running session with its turn in flight and, beside it, a message whose translation failed. */
  async function sessionWithHeld(translationState: 'FAILED' | 'TRANSLATING') {
    const session = await db.session.create({
      data: {
        ownerId, creatorId: ownerId, assignedRunnerId: runnerId, provider: 'claude', model: 'claude-opus-5-5',
        title: 'held session', prompt: 'work', turnState: 'IN_FLIGHT',
        engineTurnActive: true, dispatchOrigin: SessionDispatchOrigin.USER,
      },
      select: { id: true },
    });
    const running = await db.conversationTurn.create({
      data: {
        sessionId: session.id, seq: 1, clientTurnId: `run-${randomUUID()}`, kind: 'message', content: 'work',
        status: 'IN_FLIGHT', deliveredAt: new Date(), leaseDeadlineAt: new Date(Date.now() + 300_000),
      },
      select: { id: true },
    });
    const held = await db.conversationTurn.create({
      data: {
        sessionId: session.id, seq: 2, clientTurnId: `held-${randomUUID()}`, kind: 'message',
        content: '{"roots_installed":0}', displayPrompt: '{"roots_installed":0}',
        status: 'HELD', translationState, translationLang: 'zh-Hans',
      },
      select: { id: true },
    });
    return { sessionId: session.id, runningId: running.id, heldId: held.id };
  }

  async function turnRow(id: string) {
    return db.conversationTurn.findUniqueOrThrow({
      where: { id }, select: { status: true, translationState: true, displayPrompt: true },
    });
  }

  await t.test('a failed turn completes, and the held message keeps its failed translation', async () => {
    const s = await sessionWithHeld('FAILED');
    await api.turnComplete({ id: runnerId }, s.sessionId, {
      turnId: s.runningId, status: SharedRunStatus.FAILED, subtype: 'error_during_execution',
      numTurns: 1, costUsd: 0, error: 'the engine exited',
    });
    assert.equal((await turnRow(s.runningId)).status, 'ANSWERED', 'the failed turn is answered');
    assert.deepEqual(await turnRow(s.heldId), {
      status: 'HELD', translationState: 'FAILED', displayPrompt: '{"roots_installed":0}',
    }, 'the held message is left for Retry, Send as written or withdraw');
  });

  await t.test('a finalize drains the session, and a message still being translated stays held', async () => {
    const s = await sessionWithHeld('TRANSLATING');
    await api.finalize({ id: runnerId }, s.sessionId, { status: SharedRunStatus.FAILED, error: 'the engine exited' } as never);
    const session = await db.session.findUniqueOrThrow({ where: { id: s.sessionId }, select: { ...WORD_SELECT } });
    assert.equal(wordOf(session), RunStatus.FAILED, 'the finalize ended the run');
    assert.equal((await turnRow(s.runningId)).status, 'ANSWERED', 'the running turn is drained');
    assert.deepEqual(await turnRow(s.heldId), {
      status: 'HELD', translationState: 'TRANSLATING', displayPrompt: '{"roots_installed":0}',
    });
  });
});
