/**
 * THE COLUMN `release_cause` AND ITS CHECK STAY IN THE DATABASE AFTER DEPLOY 2, AND NOTHING IN THE SERVER USES THEM.
 *
 * Design §12.6, removal step R5: the field left the Prisma model, the column and `session_release_cause_chk` stay
 * until R8 (one deploy later), because deploy 1 still writes the column while deploy 2 is handed over, and a server
 * that still selected the column must not meet a database without it. This is the only spec that names the column; it
 * shows, on a database every migration has been applied to:
 *
 *   (1) the column is there, nullable, and its CHECK is there, validated, and allows null (from its own text)
 *   (2) the writers of this build release sessions (finalize, the reaper, the revive) and leave the column null
 *   (3) a deploy-1 server writing the column beside this build harms nothing: its rows read as released and failed
 *       as the turn and the end reason say, this build revives and releases them again, and the stale value stays
 *   (4) no trigger, function or other constraint reads the column
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-release-column-compat.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin, SessionRunSource,
} from '@prisma/client';
import { RunStatus as SharedRunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { ReaperService } from '../realtime/reaper.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { releaseWasFailure, releaseWasFailureFilter } from '../common/session-release';
import { SessionsService } from './sessions.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

interface Stack {
  db: PrismaClient;
  sql: Client;
  api: RunnerApiController;
  sessions: SessionsService;
  reaper: ReaperService;
}

function stackFor(url: string, sql: Client): Stack {
  const db = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = new QueueService(prisma, realtime);
  const sessions = new SessionsService(prisma, queue, realtime);
  return {
    db,
    sql,
    sessions,
    reaper: new ReaperService(prisma, realtime),
    api: new RunnerApiController(
      prisma,
      queue,
      realtime,
      new Proxy({}, { get: () => async () => undefined }) as never,
      { assert: async (_runner: unknown, callingSessionId?: string) => callingSessionId ?? randomUUID() } as never,
      { expand: async (_ownerId: string, content?: string) => content } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      sessions,
    ),
  };
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
}

async function world(db: PrismaClient, label: string): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@release.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, workDir: `/srv/${label}` },
  });
  return { ownerId, runnerId, workspaceId };
}

/** A conversation on the world's runner, in the given state. */
async function session(db: PrismaClient, w: World, data: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await db.session.create({
    data: {
      id,
      ownerId: w.ownerId,
      creatorId: w.ownerId,
      workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId,
      title: 'a conversation',
      prompt: 'Explain the error in the log',
      status: RunStatus.RUNNING,
      provider: 'claude',
      providerBuiltin: true,
      engine: 'claude',
      dispatchOrigin: SessionDispatchOrigin.USER,
      runSource: SessionRunSource.MANUAL,
      startedAt: new Date(),
      runtimeSessionId: randomUUID(),
      ...data,
    },
  });
  return id;
}


test('release_cause and session_release_cause_chk stay in the database; this build never writes them', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const s = stackFor(url, sql);
  t.after(async () => {
    await s.db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const row = async (id: string) => (await sql.query(
    `SELECT status::text AS status, finished_at, release_cause, end_reason, last_turn_outcome FROM "session"
      WHERE id = $1::uuid`, [id])).rows[0] as {
    status: string; finished_at: Date | null; release_cause: string | null; end_reason: string | null;
    last_turn_outcome: string | null;
  };

  await t.test('(1) the nullable column and its validated CHECK are there, and the CHECK allows null', async () => {
    const column = (await sql.query(
      `SELECT is_nullable, data_type FROM information_schema.columns
        WHERE table_name = 'session' AND column_name = 'release_cause'`)).rows;
    assert.deepEqual(column, [{ is_nullable: 'YES', data_type: 'text' }]);
    const check = (await sql.query(
      `SELECT convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'session_release_cause_chk' AND conrelid = 'session'::regclass`)).rows as
      Array<{ convalidated: boolean; def: string }>;
    console.log(`# session_release_cause_chk ${JSON.stringify(check)}`);
    assert.equal(check.length, 1);
    assert.equal(check[0].convalidated, true);
    assert.match(check[0].def, /\(release_cause IS NULL\) OR/, 'the constraint text allows null');
  });

  await t.test('(2) this build\'s writers release and revive sessions and leave the column null', async () => {
    const w = await world(s.db, 'compat-own');
    const failed = await session(s.db, w);
    await s.api.finalize({ id: w.runnerId }, failed, { status: SharedRunStatus.FAILED, error: 'engine crashed' } as never);
    const cancelled = await session(s.db, w, { cancelRequestedAt: new Date(Date.now() - 10 * 60_000) });
    await (s.reaper as unknown as { sweep(): Promise<void> }).sweep();
    const ended = await session(s.db, w, { status: RunStatus.PENDING, startedAt: null });
    await s.sessions.end(w.ownerId, ended);
    await s.sessions.resume(w.ownerId, failed, { clientTurnId: randomUUID(), content: 'Try again' });
    for (const [name, id] of [['finalized', failed], ['reaped', cancelled], ['ended queued', ended]] as const) {
      const r = await row(id);
      assert.equal(r.release_cause, null, `${name}: nothing wrote the column`);
    }
    assert.equal((await row(failed)).status, 'PENDING', 'the revive worked');
    assert.equal((await row(cancelled)).status, 'FAILED');
    assert.ok((await row(cancelled)).finished_at instanceof Date);
    // A model read selects every field of the model: it runs against the database that still has the column.
    const read = await s.db.session.findUniqueOrThrow({ where: { id: failed } });
    assert.equal('releaseCause' in read, false, 'the model has no such field');
  });

  await t.test('(3) a deploy-1 server writing the column beside this build harms nothing', async () => {
    const w = await world(s.db, 'compat-d1');
    // What deploy 1 writes during the hand-over: the status, finished_at and the cause, in one statement.
    const d1 = await session(s.db, w);
    await sql.query(
      `UPDATE "session" SET status = 'FAILED', finished_at = now(), release_cause = 'turn_failed', error = 'boom',
              last_turn_outcome = 'FAILED' WHERE id = $1::uuid`, [d1]);
    const r = await row(d1);
    assert.equal(releaseWasFailure({
      finishedAt: r.finished_at, endReason: r.end_reason, lastTurnOutcome: r.last_turn_outcome, status: r.status,
    }), true, 'this build reads the turn outcome and the end reason, not the cause');
    const listed = await s.db.session.findMany({ where: { id: d1, ...releaseWasFailureFilter() }, select: { id: true } });
    assert.equal(listed.length, 1, 'and its filters find the row');
    // This build revives it; the stale value stays (the CHECK holds it) and the session runs again.
    await s.sessions.resume(w.ownerId, d1, { clientTurnId: randomUUID(), content: 'Try again' });
    const revived = await row(d1);
    assert.equal(revived.status, 'PENDING');
    assert.equal(revived.finished_at, null);
    assert.equal(revived.release_cause, 'turn_failed', 'this build leaves the old value alone');
    // A deploy-1 revive that clears the column and a deploy-1 release that sets it both pass.
    await sql.query(
      `UPDATE "session" SET status = 'PENDING', finished_at = NULL, release_cause = NULL WHERE id = $1::uuid`, [d1]);
    await sql.query(
      `UPDATE "session" SET status = 'SUCCEEDED', finished_at = now(), release_cause = 'task_done',
              end_reason = 'task_done' WHERE id = $1::uuid`, [d1]);
    assert.equal((await s.db.session.findUniqueOrThrow({ where: { id: d1 } })).status, RunStatus.SUCCEEDED);
  });

  await t.test('(4) no trigger, function or other constraint reads the column', async () => {
    const functions = (await sql.query(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p') AND pg_get_functiondef(p.oid) LIKE '%release_cause%'`)).rows;
    assert.deepEqual(functions, []);
    const triggers = (await sql.query(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'session'::regclass AND NOT tgisinternal
          AND pg_get_triggerdef(oid) LIKE '%release_cause%'`)).rows;
    assert.deepEqual(triggers, []);
    const constraints = (await sql.query(
      `SELECT conname FROM pg_constraint WHERE pg_get_constraintdef(oid) LIKE '%release_cause%' ORDER BY conname`)).rows;
    assert.deepEqual(constraints, [{ conname: 'session_release_cause_chk' }]);
    const indexes = (await sql.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'session' AND indexdef LIKE '%release_cause%'`)).rows;
    assert.deepEqual(indexes, []);
  });
});
