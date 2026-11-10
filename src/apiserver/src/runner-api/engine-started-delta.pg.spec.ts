/**
 * A warm reused engine streaming a plain-text reply sends no handshake and stores nothing until the
 * `assistant` event that ends the reply; until then its batches carry only `text_delta` /
 * `thinking_delta`, which are never stored. engineStartedAt must still be stamped by the first of
 * them, or the session reads as "the engine has not started your message yet" under a reply the
 * reader can watch being written.
 *
 * scripts/run-pg-spec.sh src/apiserver/src/runner-api/engine-started-delta.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunEventType } from '@orbit/shared';
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

test('a streamed delta stamps engineStartedAt; the runner\'s own echo does not', {
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
    data: { id: ownerId, email: `${ownerId}@engine-started.invalid`, name: 'Owner', passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'engine-started runner', tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
    },
  });

  // A claimed run whose engine has not spoken yet: RUNNING, engineStartedAt cleared by the claim.
  async function claimedSession() {
    return db.session.create({
      data: {
        ownerId, creatorId: ownerId, assignedRunnerId: runnerId, provider: 'claude', model: null,
        title: 'engine-started session', prompt: 'hello', status: RunStatus.RUNNING,
        engineStartedAt: null, dispatchOrigin: SessionDispatchOrigin.USER,
      },
      select: { id: true },
    });
  }

  async function engineStartedAt(sessionId: string): Promise<Date | null> {
    const row = await db.session.findUniqueOrThrow({
      where: { id: sessionId }, select: { engineStartedAt: true },
    });
    return row.engineStartedAt;
  }

  const ts = () => new Date().toISOString();

  await t.test('a batch of deltas alone ends the starting state', async () => {
    const s = await claimedSession();
    await api.events({ id: runnerId }, s.id, {
      events: [
        { seq: 2, type: RunEventType.THINKING_DELTA, ts: ts(), payload: { text: 'Let me' } },
        { seq: 3, type: RunEventType.TEXT_DELTA, ts: ts(), payload: { text: 'Part one' } },
      ],
    });
    assert.ok(await engineStartedAt(s.id), 'the first streamed text proves the engine is on the message');
    const stored = await sql.query(`SELECT count(*)::int AS n FROM run_event WHERE session_id = $1::uuid`, [s.id]);
    assert.equal(stored.rows[0].n, 0, 'the deltas themselves are still not stored');
  });

  await t.test('the runner\'s user echo alone leaves the session starting', async () => {
    const s = await claimedSession();
    await api.events({ id: runnerId }, s.id, {
      events: [{ seq: 1, type: RunEventType.USER, ts: ts(), payload: { text: 'hello' } }],
    });
    assert.equal(await engineStartedAt(s.id), null);
  });
});
