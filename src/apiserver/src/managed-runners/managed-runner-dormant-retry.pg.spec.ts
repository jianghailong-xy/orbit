/**
 * A retry armed on a session the auto-retry sweep can never fire does not keep a managed runner awake.
 *
 * Production 2026-11-22: a FAILED session with `completed_at` set held a past `retry_at` for a day. The
 * sweep requires `completed_at IS NULL` (sessions/auto-retry-eligibility.ts), so it never fired or cleared
 * the arm, and DUE_RETRY, which asked only `retry_at <= now()`, kept the runner "busy": it could not be
 * put to sleep or rolled to a new image.
 *
 *   dormant-arm-is-not-work     completed, trashed and landing arms are not work; an eligible arm still is;
 *                               the SQL and Prisma forms of the sweep's condition agree
 *   completing-leaves-no-arm    completing or trashing a session with an arm clears retry_at / retry_claimed_at
 *
 * Over a real PostgreSQL: bash scripts/run-pg-spec.sh src/apiserver/src/managed-runners/managed-runner-dormant-retry.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { PrismaClient, type ManagedRunner } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { autoRetryEligibleWhere } from '../sessions/auto-retry-eligibility';
import { SessionsService } from '../sessions/sessions.service';
import { managedRunnerWorld } from '../test-support/managed-runner-world';
import { managedRunnerWork } from './managed-runner-work';
import { turnStateOfWord } from '../sessions/session-turn-state';

const URL = process.env.COORDINATOR_PG_URL;

test('a dormant retry arm is not managed-runner work', { skip: !URL, concurrency: 1, timeout: 300_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  process.env.DATABASE_URL ??= url;
  const db: PrismaClient = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const publishes = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(prisma, { notifySessionQueued: () => undefined } as unknown as QueueService, publishes);
  const w = managedRunnerWorld(db);

  /** A FAILED session on the runner with a retry due a minute ago, plus whatever `extra` says. */
  async function armed(m: ManagedRunner, extra: Record<string, unknown> = {}): Promise<string> {
    const workspace = await db.workspace.create({
      data: { ownerId: m.ownerId, runnerId: m.runnerId, targetRunnerId: m.runnerId, name: 'Project', workDir: '/tmp/project' },
    });
    const id = randomUUID();
    const columns: Record<string, unknown> = {
      id, owner_id: m.ownerId, creator_id: m.ownerId, workspace_id: workspace.id, assigned_runner_id: m.runnerId,
      title: 'failed work', prompt: 'p', provider: 'claude', provider_builtin: true, status: 'FAILED', num_turns: 1,
      finished_at: new Date(), cancel_requested_at: new Date(), error: 'overloaded', retry_attempts: 1,
      // A failure release carries FAILED on its turn (removal step R2), which is what reads it as one since R7.
      last_turn_outcome: 'FAILED',
      ...extra,
    };
    // The word as its facts (deploy D3): the turn state of a held word; the release beside a released one is set above.
    if ('status' in columns) {
      columns.turn_state = turnStateOfWord(String(columns.status));
      delete columns.status;
    }
    const names = Object.keys(columns);
    await sql.query(
      `INSERT INTO "session" (${names.map((n) => `"${n}"`).join(', ')}, "started_at", "updated_at")
       VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}, now(), now())`,
      names.map((n) => columns[n]),
    );
    // Due by the database's clock: these columns are timestamps without a zone.
    await sql.query(`UPDATE "session" SET retry_at = now() - interval '1 minute' WHERE id = $1`, [id]);
    return id;
  }

  await t.test('dormant-arm-is-not-work', async () => {
    const { mapping } = await w.readyRunner('dormant-arm');
    const work = () => managedRunnerWork(prisma, mapping.runnerId);
    assert.deepEqual(await work(), [], 'before: nothing');

    // The arm the sweep fires: work, so the runner stays awake for it.
    const live = await armed(mapping);
    assert.deepEqual(await work(), ['DUE_RETRY'], 'an arm the sweep would fire is work');

    // The shapes the sweep never fires, written straight to the columns: the point is the reader.
    const dormant = [
      await armed(mapping, { completed_at: new Date() }),
      await armed(mapping, { deleted_at: new Date() }),
      await armed(mapping, { kind: 'LANDING' }),
    ];
    await sql.query(`UPDATE "session" SET retry_at = NULL WHERE id = $1`, [live]);
    assert.deepEqual(await work(), [], 'completed, trashed and landing arms are not work');

    // The same condition read both ways: the managed runner's SQL and the sweep's Prisma filter.
    await sql.query(`UPDATE "session" SET retry_at = now() - interval '1 minute' WHERE id = $1`, [live]);
    const swept = await db.session.findMany({
      where: { id: { in: [live, ...dormant] }, retryAt: { lte: new Date() }, ...autoRetryEligibleWhere() },
      select: { id: true },
    });
    assert.deepEqual(swept.map((s) => s.id), [live], 'the sweep would fire only the live arm');
    assert.deepEqual(await work(), ['DUE_RETRY'], 'and the live arm alone is work');

    await sql.query(`UPDATE "session" SET completed_at = now() WHERE id = $1`, [live]);
    assert.deepEqual(await work(), [], 'once completed, even that one is not');
  });

  await t.test('completing-leaves-no-arm', async () => {
    const { mapping } = await w.readyRunner('completing');
    const read = async (id: string) =>
      (await sql.query(`SELECT retry_at, retry_claimed_at, completed_at, deleted_at FROM "session" WHERE id = $1`, [id])).rows[0];

    // Released by a failure with a retry armed: the shape production had.
    const failed = await armed(mapping);
    assert.ok((await read(failed)).retry_at, 'armed before');
    await sessions.complete(mapping.ownerId, failed);
    const done = await read(failed);
    assert.ok(done.completed_at, 'completed');
    assert.equal(done.retry_at, null, 'completing it leaves no retry armed');
    assert.equal(done.retry_claimed_at, null);

    // Trashed, the same.
    const other = await armed(mapping);
    await sessions.remove(mapping.ownerId, other);
    const trashed = await read(other);
    assert.ok(trashed.deleted_at, 'trashed');
    assert.equal(trashed.retry_at, null, 'trashing it leaves no retry armed');
    assert.deepEqual(await managedRunnerWork(prisma, mapping.runnerId), [], 'and the runner has nothing to do');
  });
});
