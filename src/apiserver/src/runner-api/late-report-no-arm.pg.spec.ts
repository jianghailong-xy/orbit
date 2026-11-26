/**
 * A report that lands after the owner completed or trashed a session arms no retry.
 *
 * Production 2026-11-21: a session was completed at 02:14:07 and a retry was armed on it 13 s later, by
 * a runner report of the turn the completion had cancelled. The auto-retry sweep never reads a completed
 * session, so the arm stayed due for a day and kept its managed runner awake. complete() clearing the arm
 * is not enough, because it runs BEFORE the late report; every writer of `retry_at` has to refuse itself.
 *
 *   events      a retryable API error among the events of a session completed first: retry_at stays NULL
 *   control     the same events on a session that was not completed arm a retry (the guard is the only difference)
 *   turn-done   a failed turn-complete after the completion: retry_at stays NULL
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/late-report-no-arm.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { RunEventType, RunStatus as SharedRunStatus } from '@orbit/shared';
import { PrismaClient, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import '../test-support/dequeue-under-lease';
import { RunnerApiController } from './runner-api.controller';

const URL = process.env.COORDINATOR_PG_URL;
const OVERLOADED = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';

test('a report after complete arms no retry', { skip: !URL, concurrency: 1, timeout: 300_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const api = new RunnerApiController(
    prisma, queue, realtime, {} as never, {} as never,
    { expand: async (_o: string, c?: string) => c } as never,
    { appendFor: async (_tx: unknown, _s: string, c?: string) => c } as never,
  );
  const sessions = new SessionsService(prisma, queue, realtime);

  /** A RUNNING session with a turn out on delivery, as the runner executes it. */
  async function running(label: string) {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    const sessionId = randomUUID();
    await db.user.create({ data: { id: ownerId, email: `${label}-${ownerId}@late.invalid`, name: 'Owner', passwordHash: 'x' } });
    await db.runner.create({
      data: {
        id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
        capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
      },
    });
    await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `${label}-ws`, enabled: true } });
    await db.session.create({
      data: {
        id: sessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title: label, prompt: 'p',
        provider: 'claude', turnState: 'IN_FLIGHT', engineTurnActive: true, dispatchOrigin: SessionDispatchOrigin.USER,
        startedAt: new Date(), runtimeSessionId: randomUUID(),
      },
    });
    const turn = await db.conversationTurn.create({
      data: {
        sessionId, seq: 1, clientTurnId: `${label}-${randomUUID()}`, kind: 'message', content: 'p', status: 'IN_FLIGHT',
        deliveredAt: new Date(), leaseDeadlineAt: new Date(Date.now() + 300_000), leaseGeneration: randomUUID(),
      },
      select: { id: true },
    });
    return { ownerId, runnerId, sessionId, turnId: turn.id };
  }
  const retryAt = async (id: string) =>
    (await sql.query(`SELECT retry_at, completed_at FROM "session" WHERE id = $1`, [id])).rows[0] as { retry_at: Date | null; completed_at: Date | null };
  const overloaded = (f: { runnerId: string; sessionId: string; turnId: string }) =>
    api.events({ id: f.runnerId }, f.sessionId, {
      events: [{ seq: 2, type: RunEventType.ASSISTANT, ts: new Date().toISOString(), turnId: f.turnId, payload: { text: OVERLOADED } }],
    });

  await t.test('control: the overloaded error on a live session arms a retry', async () => {
    const f = await running('control');
    await overloaded(f);
    assert.ok((await retryAt(f.sessionId)).retry_at, 'armed: the guard is the only difference below');
  });

  await t.test('events: after complete, the retryable error arms nothing', async () => {
    const f = await running('events');
    await sessions.complete(f.ownerId, f.sessionId);
    assert.ok((await retryAt(f.sessionId)).completed_at, 'completed first');
    await overloaded(f);
    assert.equal((await retryAt(f.sessionId)).retry_at, null, 'no retry armed on a completed session');
  });

  await t.test('turn-done: after complete, a failed turn-complete arms nothing', async () => {
    const f = await running('turn-done');
    await sessions.complete(f.ownerId, f.sessionId);
    await overloaded(f);
    await api.turnComplete({ id: f.runnerId }, f.sessionId, {
      turnId: f.turnId, status: SharedRunStatus.FAILED, subtype: 'error_during_execution', numTurns: 0, costUsd: 0, error: OVERLOADED,
    } as never);
    assert.equal((await retryAt(f.sessionId)).retry_at, null, 'no retry armed on a completed session');
  });
});
