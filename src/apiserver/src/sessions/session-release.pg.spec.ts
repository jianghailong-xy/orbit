/**
 * EVERY WRITE THAT RELEASES A SESSION SETS THE RELEASE COLUMN, AND THE REVIVE CLEARS IT.
 *
 * docs/session-three-state-plan.md §6 steps 3.1-3.3, design §4.2 and §6.3: `session.finished_at` is the release
 * column (the cause column of migration 1261 is no longer written: sessions/session-release-column-compat.pg.spec.ts).
 * Each case drives a real writer against PostgreSQL
 * and reads the row back:
 *
 *   (1) runner finalize, no end requested            → the runner's status: engine_exited, or engine_failed for FAILED
 *   (2) runner finalize after a task-done end        → SUCCEEDED, task_done
 *   (3) runner finalize after a cancel with no reason → CANCELLED, cancelled
 *   (4) a transcript import that failed              → FAILED, import_failed (plan step 3.1: it set no finished_at)
 *   (5) the reaper, through its sweep: an end settled late → that end's status, its reason; a cancel never
 *       honoured → FAILED, end_not_honored
 *   (6) the reaper's other three causes              → runner_lost, setup_failed, turn_failed
 *   (7) ending a session still queued                → CANCELLED, ended
 *   (8) the revive                                   → PENDING, finished_at null
 *   (9) migrations 1202 and 1262 re-applied by the real `prisma migrate deploy` on a database that holds rows:
 *       1262's backfill, one session per rule, then the two counts of plan step 3.3 over the database
 *  (10) migrations 1401 and 1402 (plan step 3.4), by prisma: rows shaped as the release before the release-fact work
 *       writes them during a hand-over get or lose finished_at by 1402, the two counts
 *       on finished_at are zero, the CHECK is listed validated with its one clause, and each violating write is refused
 *  (11) removed on 2026-11-21 with migrations 1405 to 1407 (design §12 decision D9, removal step R1): the session
 *       keeps no failure fact, so nothing holds a cause to the status any more
 *  (12) migrations 1421 to 1425 (plan step 4.4; 1425 restated on the turn outcome and the end reason by removal step
 *       R4) and 1442 (removal step R7: the ended-triggers without the status bridge), re-applied by the real `prisma
 *       migrate deploy` on a database that holds rows: they write none; the three ended-triggers fire on every release
 *       shape of design §12.2 where their old status clauses did, but for the named differences, and each WHEN clause
 *       is the release module's failure question; then a write of the release
 *       fact alone, with the status word left as it was, fires every guard and ended-trigger that used to read the
 *       status, and each decides from the release fact
 *
 * Every writer's row in (1)-(8) is also asserted to read as released by a failure (releaseWasFailure) exactly when it
 * is FAILED with no end reason: an end somebody asked for and the runner never honoured is a stop (design §12.3, W7).
 * The other three writers are asserted where they are already driven: turn-complete's failed turn in
 * runner-api/turn-complete-outcome.pg.spec.ts (2), the landing container in projects/landing-session.pg.spec.ts
 * (settles) and sessions/engine-session-guard.pg.spec.ts (inserted settled), the runner's source refusal in
 * projects/source-freeze.pg.spec.ts ("a refused run is closed").
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-release.pg.spec.ts
 *
 * Not destructive: every id is freshly generated, and the assertions read only the rows they made, except the
 * two counts of (9), which are over the whole disposable database by design.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  CreatorType,
  PrismaClient,
  RunnerStatus,
  SessionDispatchOrigin,
  SessionRunSource,
  TaskCompletionPolicy,
} from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { RunStatus as SharedRunStatus, SessionEndReason } from '@orbit/shared';
import { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { ReaperService } from '../realtime/reaper.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { releaseWasFailure, releaseWasFailureSql } from '../common/session-release';
import { RELEASE_SHAPES } from '../common/session-release-shapes.fixture';
import { SessionsService } from './sessions.service';
import { turnStateOfWord } from './session-turn-state';
import { fixtureFacts } from '../test-support/session-word';
import { restoreStatusColumn } from '../test-support/session-d3-database';

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

/** Migration 1671 (deploy D3) and its rollback: (9) and (10) rehearse migrations that read and write the stored word,
 *  on the database deploy D2 left (1691's column restored, then 1671 rolled back), and put 1671 back after. */
const D3_DOWN = readFileSync(join(__dirname, '..', '..', '..', '..', 'scripts', 'session-status-from-facts-down.sql'), 'utf8');
const D3_UP = readFileSync(join(__dirname, '..', '..', 'prisma', 'migrations', '1671_session_status_from_facts', 'migration.sql'), 'utf8');
/** While 1671 is rolled back: the helper writes the fixture word as the stored word, as writers before deploy D3 did. */
let storedWords = false;

/** A conversation on the world's runner, in the given state. */
async function session(db: PrismaClient, w: World, data: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  const { finishedAt, ...facts } = fixtureFacts(data) as Record<string, unknown> & { finishedAt?: Date | null };
  const row = {
    id,
    ownerId: w.ownerId,
    creatorId: w.ownerId,
    workspaceId: w.workspaceId,
    assignedRunnerId: w.runnerId,
    title: 'a conversation',
    prompt: 'Explain the error in the log',
    turnState: 'IN_FLIGHT',
    provider: 'claude',
    providerBuiltin: true,
    engine: 'claude',
    dispatchOrigin: SessionDispatchOrigin.USER,
    runSource: SessionRunSource.MANUAL,
    startedAt: new Date(),
    runtimeSessionId: randomUUID(),
    ...facts,
  };
  if (!storedWords) {
    await db.session.create({ data: { ...row, finishedAt } as never });
    return id;
  }
  // While 1671 is rolled back: in as the default word's row (PENDING, QUEUED) with the row triggers off for the insert
  // alone, since an insert guard such as the aggregate parent's would read that default where deploy 2's writer
  // inserted the row as it is; then the word alone, with its release column, as that writer wrote it, 1611's trigger
  // keeping the facts from it, under the engine read's declaration, as a claim makes it, so the engine guards let a
  // move to RUNNING through. The helper's own word is RUNNING, the turn in flight it writes.
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    // phase too, which session_zz_phase writes when the triggers are on: a queued turn with nothing executing.
    await tx.session.create({ data: { ...row, turnState: 'QUEUED', phase: 'PENDING' } as never });
  });
  await db.$transaction([
    db.$executeRaw`SELECT set_config('orbit.claim_reads_session_engine', '1', true)`,
    db.$executeRawUnsafe(`UPDATE "session" SET "status" = $2::run_status, "finished_at" = $3 WHERE "id" = $1::uuid`,
      id, String(data.status ?? 'RUNNING'), finishedAt ?? null),
  ]);
  return id;
}

interface Released {
  status: string;
  finished_at: Date | null;
  end_reason: string | null;
  last_turn_outcome: string | null;
}

async function released(sql: Client, id: string): Promise<Released> {
  const row = (await sql.query(
    `SELECT status::text AS status, finished_at, end_reason, last_turn_outcome FROM "session"
      WHERE id = $1::uuid`,
    [id],
  )).rows[0] as Released;
  console.log(`# ${id} ${JSON.stringify(row)}`);
  return row;
}

function assertReleased(row: Released, status: string, why: string, failure?: boolean): void {
  assert.equal(row.status, status);
  assert.ok(row.finished_at instanceof Date, `${status}/${why}: the release column is set`);
  // The failure question (common/session-release.ts, design §12.3): released by a failure exactly when FAILED with no
  // end reason. W7 (removal step R4): FAILED with an end recorded, one somebody asked for and the runner never
  // honoured, is a stop; while the cause was read, it was a failure. `failure` names the cases removal step R7 (the
  // status bridge gone) answers otherwise, each where it is called.
  const failed = releaseWasFailure({
    finishedAt: row.finished_at, endReason: row.end_reason, lastTurnOutcome: row.last_turn_outcome, turnState: turnStateOfWord(row.status),
  });
  assert.equal(failed, failure ?? (row.status === 'FAILED' && row.end_reason == null),
    `${status}/${why}: read as a failure ${failure === undefined ? 'exactly when FAILED with no end reason' : `: ${failure}`}`);
}

/**
 * Re-apply migrations with the real `prisma migrate deploy`, on this database as it stands: their rows in
 * `_prisma_migrations` are forgotten first, so deploy finds them pending and applies them, in order, the way it
 * applies them on an installation (prisma decides per file whether to send it whole, as one transaction, or
 * statement by statement). Replaying a file by any other path is what hid that 1262's per-batch COMMIT is refused
 * on a database holding a terminal row: this spec once split it into statements itself, while prisma sends a file
 * with a CREATE PROCEDURE whole (production's deploy of af55a2fb38 failed on 1202 with 2D000).
 */
async function deployAgain(sql: Client, url: string, migrations: string[]): Promise<void> {
  await sql.query(`DELETE FROM _prisma_migrations WHERE migration_name = ANY($1::text[])`, [migrations]);
  const api = join(__dirname, '..', '..');
  try {
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: api, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', stdio: 'pipe',
    });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    assert.fail(`prisma migrate deploy of ${migrations.join(', ')} failed:\n${e.stdout ?? ''}${e.stderr ?? ''}`);
  }
  const applied = (await sql.query(
    `SELECT count(*)::int AS n FROM _prisma_migrations
      WHERE migration_name = ANY($1::text[]) AND finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    [migrations],
  )).rows[0] as { n: number };
  assert.equal(applied.n, migrations.length, 'prisma recorded every one of them applied');
}

test('every release writes the release column and its cause, and the revive clears both', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  // The column session.status was dropped in deploy D4 (migration 1691): this file rehearses deploys it
  // was part of, on the database deploy D3 left, as the D4 down script restores it.
  await restoreStatusColumn(sql);
  const s = stackFor(url, sql);
  t.after(async () => {
    await s.db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  await t.test('(1) finalize with no end requested: the runner\'s status, engine_exited or engine_failed', async () => {
    const w = await world(s.db, 'finalize-exited');
    const failed = await session(s.db, w);
    await s.api.finalize({ id: w.runnerId }, failed, { status: SharedRunStatus.FAILED, error: 'engine crashed' } as never);
    const failedRow = await released(sql, failed);
    assertReleased(failedRow, 'FAILED', 'engine_failed');
    assert.equal(failedRow.end_reason, null, 'end_reason is written exactly as before: not at all');
    const cancelled = await session(s.db, w);
    await s.api.finalize({ id: w.runnerId }, cancelled, { status: SharedRunStatus.CANCELLED } as never);
    assertReleased(await released(sql, cancelled), 'CANCELLED', 'engine_exited');
    const succeeded = await session(s.db, w, { status: RunStatus.AWAITING_INPUT });
    await s.api.finalize({ id: w.runnerId }, succeeded, { status: SharedRunStatus.SUCCEEDED } as never);
    const row = await released(sql, succeeded);
    // The runner's SUCCEEDED with no end asked (plan §3.4 C5): the stored word is the release facts' since deploy D3.
    assertReleased(row, 'CANCELLED', 'engine_exited');
    assert.equal(row.end_reason, null, 'end_reason is written exactly as before: not at all');
  });

  await t.test('(2) finalize after a task-done end: SUCCEEDED, task_done', async () => {
    const w = await world(s.db, 'finalize-done');
    const id = await session(s.db, w, {
      status: RunStatus.AWAITING_INPUT, cancelRequestedAt: new Date(), endReason: SessionEndReason.TASK_DONE,
    });
    await s.api.finalize({ id: w.runnerId }, id, { status: SharedRunStatus.CANCELLED } as never);
    const row = await released(sql, id);
    assertReleased(row, 'SUCCEEDED', 'task_done');
    assert.equal(row.end_reason, 'task_done');
  });

  await t.test('(3) finalize after a cancel that recorded no reason: CANCELLED, cancelled', async () => {
    const w = await world(s.db, 'finalize-cancel');
    const id = await session(s.db, w, { cancelRequestedAt: new Date() });
    await s.api.finalize({ id: w.runnerId }, id, { status: SharedRunStatus.FAILED } as never);
    const row = await released(sql, id);
    assertReleased(row, 'CANCELLED', 'cancelled');
    assert.equal(row.end_reason, null);
  });

  await t.test('(4) a failed transcript import: FAILED, import_failed, and now a release column', async () => {
    const w = await world(s.db, 'import');
    const id = await session(s.db, w, { importSourceCwd: '/home/someone/project' });
    const answer = await s.api.importResult({ id: w.runnerId, ownerId: w.ownerId } as never, id, {
      ok: false, error: 'transcript holds no conversation',
    });
    assert.equal(answer.failed, true);
    // W5 (removal step R7): a failed import runs no turn, so it records no turn outcome, and goes to Trash; once the
    // status bridge went it reads as a stop.
    assertReleased(await released(sql, id), 'FAILED', 'import_failed', false);
  });

  await t.test('(5) the reaper\'s sweep: an end settled late keeps its reason, a cancel never honoured is a stop', async () => {
    const w = await world(s.db, 'reaper-end');
    const stale = new Date(Date.now() - 10 * 60_000);
    // A graceful end the runner never acknowledged, and a cancel that landed on a queued row.
    const ended = await session(s.db, w, {
      status: RunStatus.AWAITING_INPUT, cancelRequestedAt: stale, endReason: SessionEndReason.ENDED,
    });
    const queued = await session(s.db, w, {
      status: RunStatus.PENDING, cancelRequestedAt: stale, endReason: SessionEndReason.CANCELLED,
    });
    const unhonoured = await session(s.db, w, { cancelRequestedAt: stale });
    // A delete the runner never honoured: FAILED, and end_reason still says a delete was asked for.
    const deleteUnhonoured = await session(s.db, w, {
      cancelRequestedAt: stale, endReason: SessionEndReason.DELETED, deletedAt: stale,
    });
    // A graceful task-done end the runner never acknowledged: SUCCEEDED, as asked.
    const doneLate = await session(s.db, w, {
      status: RunStatus.AWAITING_INPUT, cancelRequestedAt: stale, endReason: SessionEndReason.TASK_DONE,
    });
    await (s.reaper as unknown as { sweep(): Promise<void> }).sweep();
    assertReleased(await released(sql, ended), 'CANCELLED', 'ended');
    assertReleased(await released(sql, queued), 'CANCELLED', 'cancelled');
    const unhonouredRow = await released(sql, unhonoured);
    // W7 with no reason recorded (no current writer leaves one: every end request writes its reason): the turn the
    // reaper cut off records CANCELLED, so once the status bridge went (R7) it reads as the stop W7's rule says.
    // Its stored word is the facts' since deploy D3: CANCELLED (plan §3.4 C6).
    assertReleased(unhonouredRow, 'CANCELLED', 'end_not_honored', false);
    assert.equal(unhonouredRow.end_reason, null, 'end_reason is written exactly as before: not at all');
    assert.equal(unhonouredRow.last_turn_outcome, 'CANCELLED', 'the cut-off records CANCELLED');
    const deleteRow = await released(sql, deleteUnhonoured);
    // An end asked for and not honoured (plan §3.4 C1): CANCELLED since deploy D3.
    assertReleased(deleteRow, 'CANCELLED', 'end_not_honored');
    assert.equal(deleteRow.end_reason, 'deleted', 'end_reason keeps the end that was asked for');
    assertReleased(await released(sql, doneLate), 'SUCCEEDED', 'task_done');
  });

  await t.test('(6) the reaper\'s other causes: runner_lost, setup_failed, turn_failed', async () => {
    const w = await world(s.db, 'reaper-causes');
    const forceFinalize = (s.reaper as unknown as {
      forceFinalize(id: string, runnerId: string, taskId: null, reason: string, opts: object): Promise<void>;
    }).forceFinalize.bind(s.reaper);
    // As the sweep's three branches call it (reaper.service.ts): offline, runtime never up, API-error reply, each
    // with the carrying turn's outcome it records (removal step R2).
    const lost = await session(s.db, w);
    await forceFinalize(lost, w.runnerId, null, 'runner offline', {
      expectedStatuses: [RunStatus.RUNNING], onlyIfNotCancelling: true,
      carryingTurn: { outcome: 'FAILED', orLatest: false },
    });
    assertReleased(await released(sql, lost), 'FAILED', 'runner_lost');
    const neverUp = await session(s.db, w, { runtimeSessionId: null });
    await forceFinalize(neverUp, w.runnerId, null, 'claude runtime not initialized', {
      expectedStatuses: [RunStatus.RUNNING], onlyIfNotCancelling: true,
      carryingTurn: { outcome: 'FAILED', orLatest: false },
    });
    assertReleased(await released(sql, neverUp), 'FAILED', 'setup_failed');
    const apiError = await session(s.db, w, { status: RunStatus.AWAITING_INPUT });
    await forceFinalize(apiError, w.runnerId, null, 'run failed (API error)', {
      expectedStatuses: [RunStatus.AWAITING_INPUT], onlyIfNotCancelling: true,
      carryingTurn: { outcome: 'FAILED', orLatest: true },
    });
    assertReleased(await released(sql, apiError), 'FAILED', 'turn_failed');
  });

  await t.test('(7) ending a session still queued: CANCELLED, ended', async () => {
    const w = await world(s.db, 'end-queued');
    const id = await session(s.db, w, { status: RunStatus.PENDING, startedAt: null });
    await s.sessions.end(w.ownerId, id);
    const row = await released(sql, id);
    assertReleased(row, 'CANCELLED', 'ended');
    assert.equal(row.end_reason, 'ended', 'end_reason is written exactly as before');
  });

  await t.test('(8) the revive clears the release column', async () => {
    const w = await world(s.db, 'revive');
    const id = await session(s.db, w);
    await s.api.finalize({ id: w.runnerId }, id, { status: SharedRunStatus.FAILED, error: 'engine crashed' } as never);
    assertReleased(await released(sql, id), 'FAILED', 'engine_failed');
    await s.sessions.resume(w.ownerId, id, { clientTurnId: randomUUID(), content: 'Try again' });
    const row = await released(sql, id);
    assert.equal(row.status, 'PENDING');
    assert.equal(row.finished_at, null, 'held again: no release column');
  });

  await t.test('(9) prisma migrate deploy of 1202 and 1262 on a populated database backfills every terminal row; the counts are zero', async () => {
    // The database deploy D2 left (1671 rolled back), whose writers wrote the word these rows are made of.
    await sql.query(D3_DOWN);
    storedWords = true;
    const w = await world(s.db, 'backfill');
    const now = new Date();
    // Rows from before 1261 break session_release_fact_chk (1401) by design; the check comes back, by its own two
    // migrations, once the backfill has made the rows whole.
    await sql.query(`ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_release_fact_chk"`);
    // Nor can they satisfy deploy D2's released CHECK (1622), which that constraint implies: some hold a word's turn
    // beside finished_at. It stays dropped for (10), whose hand-over rows are the same.
    await sql.query(`ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_turn_state_released_chk"`);
    // One row per rule of 1262's table, written as a row from before 1261: no cause, and no release column where
    // the old writer set none. Three of each, so the counts are counts.
    const cases: Array<{ name: string; data: Record<string, unknown> }> = [
      { name: 'landing', data: {
        sessionKind: 'LANDING', status: RunStatus.SUCCEEDED, provider: 'orbit', engine: null, assignedRunnerId: null,
        completedAt: now, finishedAt: null,
      } },
      { name: 'end reason', data: {
        status: RunStatus.CANCELLED, endReason: 'task_cancelled', cancelRequestedAt: now, finishedAt: now,
      } },
      { name: 'legacy end reason', data: { status: RunStatus.CANCELLED, endReason: 'idle', finishedAt: now } },
      { name: 'import', data: {
        status: RunStatus.FAILED, importSourceCwd: '/home/someone', deletedAt: now, finishedAt: null,
      } },
      { name: 'source refused', data: {
        // A chat source, the shape session_source_snapshot_chk admits with the fewest columns.
        status: RunStatus.FAILED, sourceState: 'REFUSED', sourceRefusalCode: 'BASE_REF_NOT_FOUND', finishedAt: now,
        sourceKind: 'CHAT_UPSTREAM', sourceRepoUrl: 'https://git.invalid/acme/widgets', sourceRefAuthority: 'REMOTE',
        sourceRef: 'refs/heads/main',
      } },
      { name: 'runner offline', data: {
        status: RunStatus.FAILED, error: 'runner offline', cancelRequestedAt: now, finishedAt: now,
      } },
      { name: 'runtime', data: {
        status: RunStatus.FAILED, error: 'codex runtime not initialized', cancelRequestedAt: now, finishedAt: now,
      } },
      { name: 'cancel not honored', data: {
        status: RunStatus.FAILED, error: 'cancel not honored', cancelRequestedAt: now, finishedAt: now,
      } },
      { name: 'failed turn', data: {
        status: RunStatus.FAILED, error: 'API Error: 500', cancelRequestedAt: now, finishedAt: now,
      } },
      { name: 'engine failed', data: { status: RunStatus.FAILED, error: 'crashed', finishedAt: now } },
      { name: 'cancel, no reason', data: { status: RunStatus.CANCELLED, cancelRequestedAt: now, finishedAt: now } },
      { name: 'runner cancelled', data: { status: RunStatus.CANCELLED, finishedAt: now } },
      { name: 'succeeded, no end reason', data: { status: RunStatus.SUCCEEDED, finishedAt: null } },
      { name: 'held', data: { status: RunStatus.AWAITING_INPUT } },
      { name: 'interrupted with an end reason', data: { status: RunStatus.INTERRUPTED, endReason: 'cancelled' } },
    ];
    const made: Array<{ id: string; name: string; terminal: boolean }> = [];
    for (const c of cases) {
      for (let n = 0; n < 3; n++) {
        made.push({
          id: await session(s.db, w, c.data),
          name: c.name,
          terminal: ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(c.data.status as string),
        });
      }
    }
    // Both backfills of this project, by prisma, on a database holding every row the cases above wrote. 1262 writes
    // release_cause, which 1443 (deploy 3) dropped, so 1261 runs again first to give the column back as 1262 met it,
    // and 1443 drops it again after, leaving the database as every migration leaves it.
    await deployAgain(sql, url, ['1202_turn_outcome_backfill', '1261_session_release_cause', '1262_session_release_backfill']);
    await deployAgain(sql, url, ['1443_session_release_cause_drop']);

    for (const m of made) {
      const row = await released(sql, m.id);
      if (m.terminal) assert.ok(row.finished_at instanceof Date, `${m.name}: the release column`);
      else assert.equal(row.finished_at, null, `${m.name}: a held row gets no release column`);
    }
    const held = (await sql.query(
      `SELECT count(*)::int AS n FROM "session" WHERE id = ANY($1::uuid[]) AND last_turn_outcome = 'ANSWERED'`,
      [made.filter((m) => m.name === 'held').map((m) => m.id)],
    )).rows[0] as { n: number };
    assert.equal(held.n, 3, '1202 ran too: a held AWAITING_INPUT row reads ANSWERED');

    // Plan step 3.3's two counts, over the whole database: everything this spec's writers released above and
    // everything the backfill just wrote.
    const releasedWithout = `SELECT count(*)::int AS n FROM "session"
       WHERE status IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND finished_at IS NULL`;
    const heldWith = `SELECT count(*)::int AS n FROM "session"
       WHERE status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND finished_at IS NOT NULL`;
    const total = (await sql.query(`SELECT status::text AS status, count(*)::int AS n FROM "session" GROUP BY 1 ORDER BY 1`)).rows;
    const a = (await sql.query(releasedWithout)).rows[0] as { n: number };
    const b = (await sql.query(heldWith)).rows[0] as { n: number };
    console.log(`# sessions by status ${JSON.stringify(total)}`);
    console.log(`# ${releasedWithout.replace(/\s+/g, ' ')} -> ${a.n}`);
    console.log(`# ${heldWith.replace(/\s+/g, ' ')} -> ${b.n}`);
    assert.equal(a.n, 0, 'terminal rows without the release column');
    assert.equal(b.n, 0, 'open rows with the release column');
  });

  await t.test('(10) 1401 and 1402: the hand-over rows get or lose finished_at, the check is validated, each violating write is refused', async () => {
    const old = await world(s.db, 'handover');
    const stale = new Date(Date.now() - 10 * 60_000);
    // Rows the server of the release before the release-fact work writes during the hand-over after 1262: terminal
    // with no finished_at, and revived (open) with the finished_at 1262 wrote. 1402 gives the first finished_at and
    // takes it from the second.
    const shapes: Array<{ name: string; data: Record<string, unknown> }> = [
      { name: 'ended SUCCEEDED, no release column', data: { status: RunStatus.SUCCEEDED, finishedAt: null } },
      { name: 'engine crash, no release column', data: { status: RunStatus.FAILED, error: 'crashed', finishedAt: null } },
      { name: 'cancelled, no release column', data: { status: RunStatus.CANCELLED, cancelRequestedAt: stale, finishedAt: null } },
      { name: 'reaper offline, already released', data: {
        status: RunStatus.FAILED, error: 'runner offline', cancelRequestedAt: stale, finishedAt: stale } },
      { name: 'revived, open with finished_at', data: { status: RunStatus.AWAITING_INPUT, finishedAt: stale } },
      { name: 'revived, open with finished_at, queued', data: { status: RunStatus.PENDING, finishedAt: stale } },
    ];
    const handover: Array<{ id: string; name: string; status: string }> = [];
    for (const shape of shapes) {
      handover.push({
        id: await session(s.db, old, shape.data), name: shape.name, status: shape.data.status as string,
      });
    }

    await deployAgain(sql, url, ['1401_session_release_fact_chk', '1402_session_release_fact_validate']);

    for (const h of handover) {
      const row = await released(sql, h.id);
      assert.equal(row.status, h.status, `${h.name}: the status is not written`);
      const terminal = ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(h.status);
      assert.equal(row.finished_at instanceof Date, terminal, `${h.name}: the release column exactly when terminal`);
    }
    // The two counts on finished_at, over the whole database: this spec's writers, (9)'s 1262 rows and these.
    const terminalWithout = `SELECT count(*)::int AS n FROM "session"
       WHERE status IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND finished_at IS NULL`;
    const openWith = `SELECT count(*)::int AS n FROM "session"
       WHERE status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND finished_at IS NOT NULL`;
    const a = (await sql.query(terminalWithout)).rows[0] as { n: number };
    const b = (await sql.query(openWith)).rows[0] as { n: number };
    console.log(`# ${terminalWithout.replace(/\s+/g, ' ')} -> ${a.n}`);
    console.log(`# ${openWith.replace(/\s+/g, ' ')} -> ${b.n}`);
    assert.equal(a.n, 0, 'terminal rows without finished_at');
    assert.equal(b.n, 0, 'open rows with finished_at');
    const listed = (await sql.query(
      `SELECT convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'session_release_fact_chk' AND conrelid = 'session'::regclass`,
    )).rows as Array<{ convalidated: boolean; def: string }>;
    console.log(`# pg_constraint session_release_fact_chk ${JSON.stringify(listed)}`);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].convalidated, true, 'validated');
    assert.match(listed[0].def, /finished_at IS NOT NULL/, 'its clause reads finished_at');

    const w = await world(s.db, 'check');
    const refused = async (what: string, run: () => Promise<unknown>): Promise<void> => {
      await assert.rejects(run, (error: { code?: string; constraint?: string }) => {
        console.log(`# ${what}: refused ${error.code} ${error.constraint}`);
        return error.code === '23514' && error.constraint === 'session_release_fact_chk';
      }, what);
    };
    const held = await session(s.db, w, { status: RunStatus.AWAITING_INPUT });
    const done = await session(s.db, w);
    // Released as a deploy-2 writer released it, the word and the release column in one statement: this database is
    // the one D2 left (1671 rolled back in (9)), whose CHECK this case is about; D3's writers name the facts only.
    await sql.query(`UPDATE "session" SET status = 'SUCCEEDED', turn_state = NULL, finished_at = now() WHERE id = $1::uuid`, [done]);
    assertReleased(await released(sql, done), 'SUCCEEDED', 'engine_exited');

    await refused('a terminal status with no finished_at', () =>
      sql.query(`UPDATE "session" SET status = 'FAILED' WHERE id = $1::uuid`, [held]));
    await refused('an open status with finished_at set', () =>
      sql.query(`UPDATE "session" SET finished_at = now() WHERE id = $1::uuid`, [held]));
    await refused('a revive that clears the status but not the release column', () =>
      sql.query(`UPDATE "session" SET status = 'PENDING' WHERE id = $1::uuid`, [done]));
    // Through Prisma the driver error is wrapped; the constraint is still named in its message.
    await assert.rejects(() => session(s.db, w, { status: RunStatus.CANCELLED, finishedAt: null }), /session_release_fact_chk/);
    await assert.rejects(
      () => s.db.$executeRawUnsafe(`UPDATE "session" SET status = 'FAILED' WHERE id = $1::uuid`, held), /session_release_fact_chk/);
    // The rows are as they were, and the legal writes still go through.
    assert.equal((await released(sql, held)).finished_at, null);
    await sql.query(
      `UPDATE "session" SET status = 'FAILED', finished_at = now() WHERE id = $1::uuid`, [held],
    );
    await sql.query(
      `UPDATE "session" SET status = 'PENDING', finished_at = NULL WHERE id = $1::uuid`, [held],
    );
    // Deploy D3 back, as every migration leaves the database, for what runs after.
    storedWords = false;
    await sql.query(D3_UP);
  });
});

/**
 * (12) Plan step 4.4: the database guards read the release fact. Each case writes `finished_at` ALONE, naming no
 * status, so the status word keeps the value it had: a guard that still decided from the status would answer the old
 * way, and a trigger whose column list named only `status` would not fire at all.
 *
 * First, with session_release_fact_chk on, the three ended-triggers 1425 installs (restated on the turn outcome and the
 * end reason by removal step R4, design §12.3) and 1442 re-creates without the status bridge (R7) are driven through every release shape of design §12.2, each written as
 * its writer writes it, with and without a retry armed, and each fires where its old status clause would have but for
 * the differences design §12.3 and §12.6 name; each WHEN clause is read back from the migration and held to the release
 * module's failure question, releaseWasFailureSql('NEW'). Then session_release_fact_chk is dropped, in this disposable database, because it refuses
 * exactly the release-fact-only write (terminal-ness and `finished_at` must move together). Today every writer moves
 * them in one statement, so in production the spellings agree row for row; what the rest shows is which of them each
 * object reads. It runs after (1)-(10), which need the CHECK.
 */
test('(12) the release fact alone fires every guard and ended-trigger (plan step 4.4)', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  // The column session.status was dropped in deploy D4 (migration 1691): this file rehearses deploys it
  // was part of, on the database deploy D3 left, as the D4 down script restores it.
  await restoreStatusColumn(sql);
  const db = prismaClientFor(url);
  // The database deploy D2 left: what this test shows is that its guards and ended-triggers read the release fact
  // and not the word, by writing the fact alone and leaving the word as it was, which since deploy D3 follows the
  // facts (1671). Rolled back for it, and put back after.
  await sql.query(D3_DOWN);
  storedWords = true;
  t.after(async () => {
    storedWords = false;
    await sql.query(D3_UP).catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const task = async (w: World, data: Record<string, unknown> = {}): Promise<string> => {
    const id = randomUUID();
    await db.task.create({
      data: {
        id, ownerId: w.ownerId, title: 'a task', creatorType: CreatorType.USER, creatorId: w.ownerId,
        completionCriterion: 'EVIDENCE_JUDGMENT', acceptanceCriteria: 'the guard answers from the release fact', ...data,
      },
    });
    return id;
  };
  const project = async (w: World): Promise<string> => {
    const id = randomUUID();
    await db.project.create({ data: { id, ownerId: w.ownerId, title: `project ${id.slice(0, 8)}` } });
    return id;
  };
  const ask = async (w: World, from: string, to: string, extra = '') => {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "session_request" ("id", "owner_id", "from_session_id", "to_session_id", "turn_id", "client_turn_id",
              "request_preview", "reply_by"${extra ? ', "state", "closed_at", "reply_held_at"' : ''})
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, 'a question', now() + interval '1 hour'${extra})`,
      [id, w.ownerId, from, to, randomUUID(), `turn-${id}`]);
    return id;
  };
  const request = async (id: string) => (await sql.query(
    `SELECT "state", "close_reason", "reply_comment_due_at" FROM "session_request" WHERE "id" = $1::uuid`, [id],
  )).rows[0] as { state: string; close_reason: string | null; reply_comment_due_at: Date | null };
  /** An unanswered confirmation review whose reviewer is `reviewer`; returns the review's id. */
  const review = async (w: World, asker: string, reviewer: string): Promise<string> => {
    const reviewed = await task(w);
    const requestId = randomUUID();
    const reviewId = randomUUID();
    await sql.query(
      `INSERT INTO "task_owner_confirmation_request" ("id", "task_id", "owner_id", "session_id", "turn_id")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid)`,
      [requestId, reviewed, w.ownerId, asker, randomUUID()]);
    await sql.query(
      `INSERT INTO "task_owner_confirmation_review" ("id", "request_id", "task_id", "owner_id", "reviewer_kind",
              "window_seconds", "due_at", "reviewer_session_id")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'TASK_CREATOR', 3600, now() + interval '1 hour', $5::uuid)`,
      [reviewId, requestId, reviewed, w.ownerId, reviewer]);
    return reviewId;
  };
  const reviewerEnded = async (reviewId: string) => ((await sql.query(
    `SELECT "reviewer_ended_at" FROM "task_owner_confirmation_review" WHERE "id" = $1::uuid`, [reviewId],
  )).rows[0] as { reviewer_ended_at: Date | null }).reviewer_ended_at instanceof Date;

  await t.test('1421-1425 and 1442 apply by the real prisma migrate deploy on a database holding rows', async () => {
    // Rows of every shape the guards and triggers read, written before the five files run again: held work on a
    // task in a project, a confirmation review, an open request, and released rows of each kind.
    const w = await world(db, 'g-deploy');
    const projectId = await project(w);
    const taskId = await task(w, { projectId });
    const asker = await session(db, w);
    const held = await session(db, w, { taskId, startsTaskWork: true });
    const parked = await session(db, w, { status: RunStatus.AWAITING_INPUT, retryAt: new Date(Date.now() + 3_600_000) });
    const failed = await session(db, w, {
      status: RunStatus.FAILED, finishedAt: new Date(), retryAt: new Date(Date.now() + 3_600_000),
    });
    const done = await session(db, w, { status: RunStatus.SUCCEEDED, finishedAt: new Date() });
    const ended = await session(db, w, { status: RunStatus.CANCELLED, finishedAt: new Date() });
    const open = await ask(w, asker, held);
    const reviewId = await review(w, asker, held);
    const rows = async () => (await sql.query(
      `SELECT id, status::text AS status, finished_at, retry_at FROM "session"
        WHERE id = ANY($1::uuid[]) ORDER BY id`, [[held, parked, failed, done, ended]])).rows;
    const before = await rows();

    // 1442 after 1425, as an installation applies them: it is what the ended-triggers are once deploy 3 has run.
    const six = [
      '1421_supersession_capacity_guards_read_release', '1422_admission_aggregate_guards_read_release',
      '1423_project_move_guard_reads_release', '1424_acquisition_revive_reads_release', '1425_ended_triggers_read_release',
      '1442_ended_triggers_drop_status_bridge',
    ];
    await deployAgain(sql, url, six);

    assert.deepEqual(await rows(), before, 'no row was written: CREATE OR REPLACE only');
    assert.equal((await request(open)).state, 'OPEN', 'no trigger fired on the open request');
    assert.equal(await reviewerEnded(reviewId), false, 'nor on the review');
    // What is installed is what the files say: the release column in the lists, and no terminal status anywhere.
    const triggers = (await sql.query(
      `SELECT tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgrelid = 'session'::regclass AND tgname = ANY($1)
        ORDER BY tgname`,
      [['session_superseded_task_revive_guard', 'session_project_capacity_serialize_update',
        'session_admission_lock_order_update', 'session_request_recipient_ended', 'session_request_asker_stopped',
        'task_owner_confirmation_review_reviewer_ended']],
    )).rows as Array<{ tgname: string; def: string }>;
    assert.equal(triggers.length, 6);
    const ENDED = ['session_request_recipient_ended', 'session_request_asker_stopped', 'task_owner_confirmation_review_reviewer_ended'];
    for (const { tgname, def } of triggers) {
      const columns = /UPDATE OF (.*?) ON public\.session/.exec(def)?.[1] ?? '';
      assert.match(columns, /\bfinished_at\b/, `${tgname}: finished_at is in its column list (${columns})`);
      if (ENDED.includes(tgname)) {
        // R4: the ended-triggers read the turn outcome, list it, and name no cause. R7 (1442): the status bridge
        // went, so they name no terminal status either; their one 'FAILED' is the turn outcome's ('FAILED'::text).
        assert.match(columns, /\blast_turn_outcome\b/, `${tgname}: last_turn_outcome is in its column list (${columns})`);
      }
      assert.doesNotMatch(def, /'(SUCCEEDED|FAILED|CANCELLED)'::run_status/, `${tgname}: no terminal status`);
    }
    const bodies = (await sql.query(
      `SELECT proname, pg_get_functiondef(p.oid) AS def FROM pg_proc p WHERE proname = ANY($1) ORDER BY proname`,
      [['session_superseded_task_guard', 'task_supersession_live_session_guard', 'session_project_capacity_serialize',
        'session_admission_lock_order', 'task_aggregate_parent_shape_guard', 'task_claimed_project_move_guard',
        'guard_session_engine_acquisition', 'guard_dsh_runner_acquisition', 'guard_cursor_runner_acquisition']],
    )).rows as Array<{ proname: string; def: string }>;
    assert.equal(bodies.length, 9);
    for (const { proname, def } of bodies) {
      assert.match(def, /"finished_at"/, `${proname}: reads finished_at`);
      assert.doesNotMatch(def, /'(SUCCEEDED|FAILED|CANCELLED)'/, `${proname}: names no terminal status`);
    }
  });

  await t.test('the ended-triggers fire on every release shape where their old status clauses did, but for W7, the residual shape and the bridged rows', async () => {
    const w = await world(db, 'g-ended-table');
    const asker = await session(db, w);
    const later = new Date(Date.now() + 3_600_000);
    interface Row {
      status: string; end_reason: string | null; retry_at: Date | null; retry_attempts: number;
      retry_claimed_at: Date | null; deleted_at: Date | null; completed_at: Date | null; archived_at: Date | null;
      finished_at: Date | null; last_turn_outcome: string | null;
    }
    const row = async (id: string) => (await sql.query(
      `SELECT status::text AS status, end_reason, retry_at, retry_attempts, retry_claimed_at, deleted_at, completed_at,
              archived_at, finished_at, last_turn_outcome FROM "session" WHERE "id" = $1::uuid`, [id])).rows[0] as Row;
    // The clauses 1425 replaced, as 0350, 0366 and 0507 wrote them, over the statement's OLD and NEW rows. A trigger
    // also fires only if the statement names a column of its list.
    const filed = (n: Row) => n.deleted_at != null || n.completed_at != null || n.archived_at != null;
    const ended = (n: Row) => (n.end_reason ?? '') !== '';
    const noRetry = (o: Row, n: Row) => n.retry_at == null && !(o.retry_at != null && n.retry_attempts > o.retry_attempts);
    const parkedAsker = (o: Row, n: Row) => n.status === 'AWAITING_INPUT' && n.retry_at == null
      && ((o.retry_at != null && n.retry_attempts <= o.retry_attempts) || n.retry_attempts < o.retry_attempts
          || (o.retry_claimed_at != null && n.retry_claimed_at == null));
    const oldRecipient = (o: Row, n: Row) => filed(n) || ['SUCCEEDED', 'CANCELLED'].includes(n.status)
      || (n.status === 'FAILED' && noRetry(o, n)) || (n.status === 'INTERRUPTED' && ended(n));
    const oldAsker = (o: Row, n: Row) => oldRecipient(o, n) || parkedAsker(o, n);
    const oldReviewer = (_o: Row, n: Row) => filed(n) || ['SUCCEEDED', 'CANCELLED'].includes(n.status)
      || (['FAILED', 'INTERRUPTED'].includes(n.status) && ended(n));
    // The clauses 1442 states: released, and not by a failure (the release module's question), or no retry armed.
    const failed = (n: Row) => releaseWasFailure({
      finishedAt: n.finished_at, endReason: n.end_reason, lastTurnOutcome: n.last_turn_outcome, turnState: turnStateOfWord(n.status),
    });
    const newRecipient = (o: Row, n: Row) => filed(n) || (n.finished_at != null && (!failed(n) || noRetry(o, n)))
      || (n.status === 'INTERRUPTED' && ended(n));
    const newAsker = (o: Row, n: Row) => newRecipient(o, n) || parkedAsker(o, n);
    const newReviewer = (_o: Row, n: Row) => filed(n) || (n.finished_at != null && !failed(n))
      || (n.status === 'INTERRUPTED' && ended(n));
    const OLD_LISTS = {
      recipient: ['status', 'end_reason', 'retry_at', 'retry_attempts', 'completed_at', 'archived_at', 'deleted_at'],
      asker: ['status', 'end_reason', 'retry_at', 'retry_attempts', 'retry_claimed_at', 'completed_at', 'archived_at', 'deleted_at'],
      reviewer: ['status', 'end_reason', 'completed_at', 'archived_at', 'deleted_at'],
    };
    const NEW_LISTS = {
      recipient: [...OLD_LISTS.recipient, 'finished_at', 'last_turn_outcome'],
      asker: [...OLD_LISTS.asker, 'finished_at', 'last_turn_outcome'],
      reviewer: [...OLD_LISTS.reviewer, 'finished_at', 'last_turn_outcome'],
    };
    const quoted = (value: string | null) => (value === null ? 'NULL' : `'${value}'`);
    interface Case { name: string; start: Record<string, unknown>; set: Record<string, string>; why?: string }
    const cases: Case[] = [];
    // Every release shape of design §12.2 (common/session-release-shapes.fixture.ts), released by one statement the
    // way its writer releases it: from a held session (one an end was asked of when the shape keeps an end reason),
    // the status, the release column and the turn outcome together, with and without a retry armed in
    // the same write (as turn-complete and the reaper arm one). The clauses read no session kind, so every shape is
    // driven as a conversation.
    for (const shape of RELEASE_SHAPES.filter((candidate) => candidate.released)) {
      for (const retry of [false, true]) {
        cases.push({
          name: `${shape.name}${retry ? ', retry armed' : ''}`,
          start: shape.endReason ? { cancelRequestedAt: new Date(), endReason: shape.endReason } : {},
          set: {
            status: `'${shape.status}'`, finished_at: 'now()',
            last_turn_outcome: quoted(shape.lastTurnOutcome), ...(retry ? { retry_at: `now() + interval '1 hour'` } : {}),
          },
          why: shape.failureChange,
        });
      }
    }
    // And the writes that move a released or a parked row without releasing it, as the table before R4 drove them.
    cases.push(
      { name: 'a quota park with its retry armed is ended: CANCELLED, retry_at still set',
        start: { status: RunStatus.AWAITING_INPUT, retryAt: later, cancelRequestedAt: new Date(), endReason: 'ended' },
        set: { status: `'CANCELLED'`, finished_at: 'now()' } },
      { name: 'the sweep takes an armed retry: FAILED stays, retry_at cleared, attempts up', start: {
        status: RunStatus.FAILED, finishedAt: new Date(), lastTurnOutcome: 'FAILED',
        retryAt: later, retryAttempts: 0 },
        set: { retry_at: 'NULL', retry_attempts: '1', retry_claimed_at: 'now()' } },
      { name: 'a parked session gives its claimed retry up: AWAITING_INPUT, the attempt handed back', start: {
        status: RunStatus.AWAITING_INPUT, retryAttempts: 1, retryClaimedAt: new Date() },
        set: { retry_attempts: '0', retry_claimed_at: 'NULL' } },
    );
    const differences: string[] = [];
    const seen = new Set<string>();
    for (const c of cases) {
      const id = await session(db, w, c.start);
      const open = await ask(w, asker, id);
      const held = await ask(w, id, await session(db, w), `, 'NO_REPLY', now(), now()`);
      const reviewId = await review(w, asker, id);
      const before = await row(id);
      const assignments = Object.entries(c.set).map(([column, value]) => `"${column}" = ${value}`).join(', ');
      await sql.query(`UPDATE "session" SET ${assignments} WHERE "id" = $1::uuid`, [id]);
      const after = await row(id);
      const names = (list: string[]) => list.some((column) => column in c.set);
      const old = {
        recipient: names(OLD_LISTS.recipient) && oldRecipient(before, after),
        asker: names(OLD_LISTS.asker) && oldAsker(before, after),
        reviewer: names(OLD_LISTS.reviewer) && oldReviewer(before, after),
      };
      const expected = {
        recipient: names(NEW_LISTS.recipient) && newRecipient(before, after),
        asker: names(NEW_LISTS.asker) && newAsker(before, after),
        reviewer: names(NEW_LISTS.reviewer) && newReviewer(before, after),
      };
      const observed = {
        recipient: (await request(open)).state === 'RECIPIENT_ENDED',
        asker: (await request(held)).reply_comment_due_at instanceof Date,
        reviewer: await reviewerEnded(reviewId),
      };
      const word = (fired: boolean) => (fired ? 'fires' : 'waits');
      console.log(`# ${c.name} | recipient_ended ${word(observed.recipient)} | asker_stopped ${word(observed.asker)}`
        + ` | reviewer_ended ${word(observed.reviewer)} | old clauses: ${word(old.recipient)}, ${word(old.asker)},`
        + ` ${word(old.reviewer)}${c.why ? ` | ${c.why}` : ''}`);
      assert.deepEqual(observed, expected, c.name);
      for (const trigger of ['recipient', 'asker', 'reviewer'] as const) {
        seen.add(`${trigger}:${observed[trigger]}`);
        if (observed[trigger] !== old[trigger]) differences.push(`${c.name}: ${trigger} ${word(observed[trigger])}`);
      }
    }
    // Where the answer is not the old clauses', it is one of the two differences design §12.3 names. W7's rule: a
    // release with an end asked for is a stop, so for every row released FAILED with an end reason (W7, W4 after an
    // end, and the old FAILED rows 1262 left with one, B1) recipient_ended and asker_stopped no longer wait for a retry
    // armed on it; 1425 as the project branch had it, reading the cause, already fired for B1. The residual shape: a
    // failed turn's copy kept through a release that is no failure reads as a failure, so the three wait where the old
    // clauses, reading SUCCEEDED or CANCELLED, fired. The bridged rows (R7): a release FAILED with no end reason and no
    // FAILED turn outcome is no failure without the bridge, so recipient_ended and asker_stopped no longer wait for a
    // retry armed on it, and reviewer_ended fires as for any stop. Of those shapes, migration 1441 gave every stored
    // row outside Trash the FAILED turn outcome before 1442 ran (common/session-release-backfill.pg.spec.ts); written
    // after deploy 3 they come only from the import (W5, released into Trash, where the deleted_at branch fires
    // anyway), from no writer (W7 with no reason) or from a deploy-1 server, of which none remains (H2, H4, H6).
    const named = [
      ...RELEASE_SHAPES.filter((shape) => shape.released && shape.status === 'FAILED' && shape.endReason !== null)
        .flatMap((shape) => [`${shape.name}, retry armed: recipient fires`, `${shape.name}, retry armed: asker fires`]),
      ...RELEASE_SHAPES.filter((shape) => shape.released && shape.failureChange === 'RESIDUAL')
        .flatMap((shape) => [`${shape.name}: reviewer waits`, `${shape.name}, retry armed: recipient waits`,
          `${shape.name}, retry armed: asker waits`, `${shape.name}, retry armed: reviewer waits`]),
      ...RELEASE_SHAPES.filter((shape) => shape.released && shape.status === 'FAILED' && shape.endReason === null
        && shape.lastTurnOutcome !== 'FAILED')
        .flatMap((shape) => [`${shape.name}: reviewer fires`, `${shape.name}, retry armed: recipient fires`,
          `${shape.name}, retry armed: asker fires`, `${shape.name}, retry armed: reviewer fires`]),
    ];
    console.log(`# differences from the old clauses: ${JSON.stringify(differences)}`);
    assert.deepEqual(differences.sort(), named.sort());
    // The table is not one-sided: each trigger both fires and waits somewhere in it.
    for (const trigger of ['recipient', 'asker', 'reviewer']) {
      assert.ok(seen.has(`${trigger}:true`) && seen.has(`${trigger}:false`), `${trigger} both fires and waits`);
    }
  });

  await t.test('each ended-trigger asks the release module\'s failure question, whole', async () => {
    // 1442's three WHEN clauses each carry releaseWasFailureSql('NEW'), character for character: released, no end
    // reason, the turn outcome. And 1442 is 1425 with the status bridge taken out of each, and nothing else changed.
    const codeOf = (name: string) => readFileSync(join(__dirname, '..', '..', 'prisma', 'migrations', name,
      'migration.sql'), 'utf8').split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
    const code = codeOf('1442_ended_triggers_drop_status_bridge');
    const bridged = ` AND (NEW."last_turn_outcome" IS NOT DISTINCT FROM 'FAILED' OR NEW."status" = 'FAILED'))`;
    const deploy2 = codeOf('1425_ended_triggers_read_release');
    assert.equal(deploy2.split(bridged).length - 1, 3, '1425 carries the bridge in each of its three clauses');
    assert.equal(deploy2.split(bridged).join(` AND NEW."last_turn_outcome" IS NOT DISTINCT FROM 'FAILED')`), code,
      '1442 is 1425 without the bridge');
    const fragment = releaseWasFailureSql('NEW').sql;
    const blocks = code.split('CREATE OR REPLACE TRIGGER').slice(1);
    assert.equal(blocks.length, 3);
    for (const block of blocks) {
      const name = /^\s*"([a-z_]+)"/.exec(block)?.[1];
      assert.equal(block.split(fragment).length - 1, 1, `${name}: its WHEN clause holds the failure question once`);
    }
    const defs = (await sql.query(
      `SELECT tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger
        WHERE tgrelid = 'session'::regclass
          AND tgname IN ('session_request_recipient_ended', 'session_request_asker_stopped',
                         'task_owner_confirmation_review_reviewer_ended')
        ORDER BY tgname`,
    )).rows as Array<{ tgname: string; def: string }>;
    assert.equal(defs.length, 3);
    for (const { tgname, def } of defs) {
      console.log(`# ${tgname}: ${def}`);
      // PostgreSQL deparses `x IS NOT DISTINCT FROM y` as `NOT (x IS DISTINCT FROM y)`.
      assert.match(def, /NOT \(new\.last_turn_outcome IS DISTINCT FROM 'FAILED'::text\)/, `${tgname}: reads the turn outcome`);
    }
  });

  await sql.query(`ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_release_fact_chk"`);
  // And deploy D2's released CHECK (1622), which refuses the same writes: finished_at set under a held word's turn.
  await sql.query(`ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_turn_state_released_chk"`);

  const releaseAlone = (id: string) => sql.query(
    `UPDATE "session" SET "finished_at" = now() WHERE "id" = $1::uuid`, [id]);
  const reviveAlone = (id: string) => sql.query(
    `UPDATE "session" SET "finished_at" = NULL WHERE "id" = $1::uuid`, [id]);
  const statusOf = async (id: string) => (await released(sql, id)).status;
  const refusedWith = (pattern: RegExp) => (error: { message?: string }) => {
    console.log(`# refused: ${error.message}`);
    return pattern.test(error.message ?? '');
  };
  /** A released session as every writer leaves one today: terminal status and finished_at. */
  const releasedData = { status: RunStatus.CANCELLED, finishedAt: new Date() };

  await t.test('session_superseded_task_guard: reviving by the release fact alone onto a retired task is refused', async () => {
    const w = await world(db, 'g-superseded');
    const taskId = await task(w);
    const id = await session(db, w, { taskId, startsTaskWork: true, ...releasedData });
    await sql.query(`UPDATE "task" SET "status" = 'CANCELLED', "terminal_reason" = 'ABANDONED' WHERE "id" = $1::uuid`, [taskId]);
    await assert.rejects(() => reviveAlone(id), refusedWith(/TASK_SUPERSEDED/));
    assert.equal(await statusOf(id), 'CANCELLED', 'the status word never left CANCELLED: the guard read finished_at');
    assert.ok((await released(sql, id)).finished_at instanceof Date, 'nothing was written');
  });

  await t.test('task_supersession_live_session_guard: a run released by the fact alone no longer holds its task', async () => {
    const w = await world(db, 'g-retire');
    const taskId = await task(w);
    const id = await session(db, w, { taskId, startsTaskWork: true });
    const retire = () => sql.query(`UPDATE "task" SET "status" = 'CANCELLED', "terminal_reason" = 'ABANDONED' WHERE "id" = $1::uuid`, [taskId]);
    await assert.rejects(retire, refusedWith(/TASK_RETIRED_WHILE_RUNNING/));
    await releaseAlone(id);
    assert.equal(await statusOf(id), 'RUNNING');
    await retire();
  });

  await t.test('session_project_capacity_serialize: the release fact alone touches the project row', async () => {
    const w = await world(db, 'g-capacity');
    const projectId = await project(w);
    const taskId = await task(w, { projectId });
    const id = await session(db, w, { taskId });
    // Whether project.updated_at still holds the sentinel this case wrote, read in the database's own terms.
    const untouched = async () => ((await sql.query(
      `SELECT "updated_at" = '2000-01-01' AS same FROM "project" WHERE "id" = $1::uuid`, [projectId],
    )).rows[0] as { same: boolean }).same;
    await sql.query(`UPDATE "project" SET "updated_at" = '2000-01-01' WHERE "id" = $1::uuid`, [projectId]);
    await sql.query(`UPDATE "session" SET "title" = 'renamed' WHERE "id" = $1::uuid`, [id]);
    assert.equal(await untouched(), true, 'control: a write naming no listed column does not fire it');
    await releaseAlone(id);
    assert.equal(await untouched(), false, 'leaving live by finished_at alone serialized on the project');
    await sql.query(`UPDATE "project" SET "updated_at" = '2000-01-01' WHERE "id" = $1::uuid`, [projectId]);
    await reviveAlone(id);
    assert.equal(await untouched(), false, 'entering live by finished_at alone did too');
  });

  await t.test('session_admission_lock_order: reviving an aggregate parent\'s work by the release fact alone is refused', async () => {
    const w = await world(db, 'g-admission');
    const parent = await task(w, { completionPolicy: TaskCompletionPolicy.ALL_CHILDREN_DONE });
    await task(w, { parentTaskId: parent });
    const id = await session(db, w, { taskId: parent, startsTaskWork: true, ...releasedData });
    await assert.rejects(() => reviveAlone(id), refusedWith(/TASK_AGGREGATE_PARENT:/));
    assert.equal(await statusOf(id), 'CANCELLED');
  });

  await t.test('task_aggregate_parent_shape_guard: a run released by the fact alone no longer blocks a subtask', async () => {
    const w = await world(db, 'g-shape');
    const parent = await task(w, { completionPolicy: TaskCompletionPolicy.ALL_CHILDREN_DONE });
    const id = await session(db, w, { taskId: parent, startsTaskWork: true });
    await assert.rejects(() => task(w, { parentTaskId: parent }), refusedWith(/TASK_AGGREGATE_PARENT_ACTIVATION/));
    await releaseAlone(id);
    assert.equal(await statusOf(id), 'RUNNING');
    await task(w, { parentTaskId: parent });
  });

  await t.test('task_claimed_project_move_guard: a run released by the fact alone no longer claims its task', async () => {
    const w = await world(db, 'g-move');
    const from = await project(w);
    const to = await project(w);
    const taskId = await task(w, { projectId: from });
    const id = await session(db, w, { taskId });
    const move = () => sql.query(`UPDATE "task" SET "project_id" = $2::uuid WHERE "id" = $1::uuid`, [taskId, to]);
    await assert.rejects(move, refusedWith(/TASK_CLAIMED_PROJECT_MOVE/));
    await releaseAlone(id);
    assert.equal(await statusOf(id), 'RUNNING');
    await move();
  });

  await t.test('the three acquisition guards: the revive exemption reads OLD.finished_at', async () => {
    const w = await world(db, 'g-acquire');
    const marker = '00000000-0000-5000-8000-000000000001'; // a v5 server handoff marker
    const revive = (id: string, settings: string[] = []) => (async () => {
      await sql.query('BEGIN');
      try {
        for (const setting of settings) await sql.query(`SELECT set_config($1, '1', true)`, [setting]);
        const out = await sql.query(
          `UPDATE "session" SET "status" = 'PENDING', "finished_at" = NULL,
                  "inbox_lease_owner" = $2::uuid WHERE "id" = $1::uuid`, [id, marker]);
        await sql.query('COMMIT');
        return out.rowCount;
      } catch (error) {
        await sql.query('ROLLBACK');
        throw error;
      }
    })();
    // guard_session_engine_acquisition refuses; dsh and cursor skip the write (RETURN NULL), so the count says it.
    for (const engine of ['claude', 'dsh', 'cursor']) {
      const settings = engine === 'claude' ? [] : ['orbit.claim_reads_session_engine'];
      const data = { engine, provider: engine };
      // Released by the fact while the status word is still a held one: exempt.
      const byFact = await session(db, w, { ...data, status: RunStatus.AWAITING_INPUT, finishedAt: new Date() });
      assert.equal(await revive(byFact, settings), 1, `${engine}: OLD.finished_at set is a revive`);
      // A terminal status word with no release fact: not exempt.
      const byWord = await session(db, w, { ...data, status: RunStatus.CANCELLED, finishedAt: null });
      if (engine === 'claude') {
        await assert.rejects(() => revive(byWord, settings), refusedWith(/does not read session engines/));
      } else {
        assert.equal(await revive(byWord, settings), 0, `${engine}: OLD.status alone is no longer a revive`);
      }
      assert.equal(await statusOf(byWord), 'CANCELLED');
    }
  });

  await t.test('the three ended-triggers fire on the release fact alone', async () => {
    const w = await world(db, 'g-ended');
    const asker = await session(db, w);

    // session_request_recipient_ended (0350).
    const recipient = await session(db, w);
    const open = await ask(w, asker, recipient);
    await releaseAlone(recipient);
    const closed = await request(open);
    console.log(`# recipient_ended ${JSON.stringify(closed)}`);
    assert.equal(closed.state, 'RECIPIENT_ENDED');
    // Since 1641 (task T6) the word in close_reason is the projector's (session_legacy_status), not the stored one the
    // release fact alone left RUNNING: released with no end reason and no turn outcome reads CANCELLED (P5).
    assert.equal(closed.close_reason, 'CANCELLED', 'close_reason is WORD[:end_reason], the word read from the facts');

    // A release by a failure with a retry armed is not an end. The status word is still RUNNING, so it is the turn
    // outcome the clause read (removal step R4: the failure is the turn's).
    const retrying = await session(db, w, { retryAt: new Date(Date.now() + 60_000) });
    const waiting = await ask(w, asker, retrying);
    await sql.query(
      `UPDATE "session" SET "finished_at" = now(), "last_turn_outcome" = 'FAILED'
        WHERE "id" = $1::uuid`, [retrying]);
    assert.equal((await request(waiting)).state, 'OPEN', 'a failed turn with a retry armed: still waiting for the retry');

    // session_request_asker_stopped (0366): a reply held for the asker is released as a comment.
    const stopping = await session(db, w);
    const held = await ask(w, stopping, await session(db, w), `, 'NO_REPLY', now(), now()`);
    await releaseAlone(stopping);
    assert.ok((await request(held)).reply_comment_due_at instanceof Date, 'asker_stopped fired');

    // task_owner_confirmation_review_reviewer_ended (0507).
    const reviewer = await session(db, w);
    const reviewId = await review(w, asker, reviewer);
    await releaseAlone(reviewer);
    assert.ok(await reviewerEnded(reviewId), 'reviewer_ended fired');
  });
});
