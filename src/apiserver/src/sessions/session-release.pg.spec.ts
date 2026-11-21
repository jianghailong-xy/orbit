/**
 * EVERY WRITE THAT RELEASES A SESSION SETS THE RELEASE COLUMN AND A CAUSE, AND THE REVIVE CLEARS BOTH.
 *
 * docs/session-three-state-plan.md §6 steps 3.1-3.3, design §4.2 and §6.3: `session.finished_at` is the release
 * column and `session.release_cause` (migration 1261) says why. Each case drives a real writer against PostgreSQL
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
 *   (8) the revive                                   → PENDING, finished_at and release_cause both null
 *   (9) migrations 1202 and 1262 re-applied by the real `prisma migrate deploy` on a database that holds rows:
 *       1262's backfill, one session per rule, then the two counts of plan step 3.3 over the database
 *  (10) migrations 1401 and 1402 (plan step 3.4), by prisma: rows shaped as the release before the release-fact work
 *       writes them during a hand-over are made whole by 1402, the CHECK is listed validated, and each violating
 *       write is refused
 *  (11) migrations 1403-1407, by prisma: the failure reading. 1405's backfill on a populated database (old rows as
 *       1262 left them), then the two counts (FAILED rows not read as failures; other released rows read as
 *       failures) are zero, both CHECKs are listed validated, and for every cause of SESSION_RELEASE_CAUSES the
 *       database takes it with FAILED exactly when isFailedRelease says it is a failure, and refuses it with the
 *       other statuses then
 *
 * Every writer's row in (1)-(8) is also asserted to read as a failure (isFailedRelease) exactly when it is FAILED.
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
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';

import { PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin, SessionRunSource } from '@prisma/client';
import { RunStatus as SharedRunStatus, SessionEndReason } from '@orbit/shared';
import { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { ReaperService } from '../realtime/reaper.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import {
  failedReleaseFilter, failedReleaseSql, isFailedRelease, SESSION_RELEASE_CAUSES,
} from '../common/session-release';
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

interface Released {
  status: string;
  finished_at: Date | null;
  release_cause: string | null;
  end_reason: string | null;
}

async function released(sql: Client, id: string): Promise<Released> {
  const row = (await sql.query(
    `SELECT status::text AS status, finished_at, release_cause, end_reason FROM "session" WHERE id = $1::uuid`,
    [id],
  )).rows[0] as Released;
  console.log(`# ${id} ${JSON.stringify(row)}`);
  return row;
}

function assertReleased(row: Released, status: string, cause: string): void {
  assert.equal(row.status, status);
  assert.ok(row.finished_at instanceof Date, `${status}/${cause}: the release column is set`);
  assert.equal(row.release_cause, cause);
  // The failure reading (common/session-release.ts): the release fact alone says whether the run failed.
  assert.equal(isFailedRelease(row.release_cause), row.status === 'FAILED', `${status}/${cause}: read as a failure exactly when FAILED`);
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
    assertReleased(row, 'SUCCEEDED', 'engine_exited');
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
    assertReleased(await released(sql, id), 'FAILED', 'import_failed');
  });

  await t.test('(5) the reaper\'s sweep: an end settled late keeps its reason, a cancel never honoured is a failure', async () => {
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
    assertReleased(unhonouredRow, 'FAILED', 'end_not_honored');
    assert.equal(unhonouredRow.end_reason, null, 'end_reason is written exactly as before: not at all');
    const deleteRow = await released(sql, deleteUnhonoured);
    assertReleased(deleteRow, 'FAILED', 'end_not_honored');
    assert.equal(deleteRow.end_reason, 'deleted', 'end_reason keeps the end that was asked for');
    assertReleased(await released(sql, doneLate), 'SUCCEEDED', 'task_done');
  });

  await t.test('(6) the reaper\'s other causes: runner_lost, setup_failed, turn_failed', async () => {
    const w = await world(s.db, 'reaper-causes');
    const forceFinalize = (s.reaper as unknown as {
      forceFinalize(id: string, runnerId: string, taskId: null, reason: string, opts: object): Promise<void>;
    }).forceFinalize.bind(s.reaper);
    // As the sweep's three branches call it (reaper.service.ts): offline, runtime never up, API-error reply.
    const lost = await session(s.db, w);
    await forceFinalize(lost, w.runnerId, null, 'runner offline', {
      expectedStatuses: [RunStatus.RUNNING], onlyIfNotCancelling: true, releaseCause: 'runner_lost',
    });
    assertReleased(await released(sql, lost), 'FAILED', 'runner_lost');
    const neverUp = await session(s.db, w, { runtimeSessionId: null });
    await forceFinalize(neverUp, w.runnerId, null, 'claude runtime not initialized', {
      expectedStatuses: [RunStatus.RUNNING], onlyIfNotCancelling: true, releaseCause: 'setup_failed',
    });
    assertReleased(await released(sql, neverUp), 'FAILED', 'setup_failed');
    const apiError = await session(s.db, w, { status: RunStatus.AWAITING_INPUT });
    await forceFinalize(apiError, w.runnerId, null, 'run failed (API error)', {
      expectedStatuses: [RunStatus.AWAITING_INPUT], onlyIfNotCancelling: true, releaseCause: 'turn_failed',
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

  await t.test('(8) the revive clears the release column and its cause', async () => {
    const w = await world(s.db, 'revive');
    const id = await session(s.db, w);
    await s.api.finalize({ id: w.runnerId }, id, { status: SharedRunStatus.FAILED, error: 'engine crashed' } as never);
    assertReleased(await released(sql, id), 'FAILED', 'engine_failed');
    await s.sessions.resume(w.ownerId, id, { clientTurnId: randomUUID(), content: 'Try again' });
    const row = await released(sql, id);
    assert.equal(row.status, 'PENDING');
    assert.equal(row.finished_at, null, 'held again: no release column');
    assert.equal(row.release_cause, null, 'and no cause');
  });

  await t.test('(9) prisma migrate deploy of 1202 and 1262 on a populated database backfills every terminal row; the counts are zero', async () => {
    const w = await world(s.db, 'backfill');
    const now = new Date();
    // Rows from before 1261 break session_release_fact_chk (1401) by design; the check comes back, by its own two
    // migrations, once the backfill has made the rows whole.
    await sql.query(`ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_release_fact_chk"`);
    // And 1262 writes the causes as it did before 1403 split them (engine_exited and the end's cause on FAILED rows),
    // which session_release_failure_chk (1406) refuses: it comes back by its own migrations in (11), after 1405.
    await sql.query(`ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_release_failure_chk"`);
    // One row per rule of 1262's table, written as a row from before 1261: no cause, and no release column where
    // the old writer set none. Three of each, so the counts are counts.
    const cases: Array<{ name: string; data: Record<string, unknown>; cause: string | null }> = [
      { name: 'landing', cause: 'landing_settled', data: {
        sessionKind: 'LANDING', status: RunStatus.SUCCEEDED, provider: 'orbit', engine: null, assignedRunnerId: null,
        completedAt: now, finishedAt: null,
      } },
      { name: 'end reason', cause: 'task_cancelled', data: {
        status: RunStatus.CANCELLED, endReason: 'task_cancelled', cancelRequestedAt: now, finishedAt: now,
      } },
      { name: 'legacy end reason', cause: 'idle', data: { status: RunStatus.CANCELLED, endReason: 'idle', finishedAt: now } },
      { name: 'import', cause: 'import_failed', data: {
        status: RunStatus.FAILED, importSourceCwd: '/home/someone', deletedAt: now, finishedAt: null,
      } },
      { name: 'source refused', cause: 'setup_failed', data: {
        // A chat source, the shape session_source_snapshot_chk admits with the fewest columns.
        status: RunStatus.FAILED, sourceState: 'REFUSED', sourceRefusalCode: 'BASE_REF_NOT_FOUND', finishedAt: now,
        sourceKind: 'CHAT_UPSTREAM', sourceRepoUrl: 'https://git.invalid/acme/widgets', sourceRefAuthority: 'REMOTE',
        sourceRef: 'refs/heads/main',
      } },
      { name: 'runner offline', cause: 'runner_lost', data: {
        status: RunStatus.FAILED, error: 'runner offline', cancelRequestedAt: now, finishedAt: now,
      } },
      { name: 'runtime', cause: 'setup_failed', data: {
        status: RunStatus.FAILED, error: 'codex runtime not initialized', cancelRequestedAt: now, finishedAt: now,
      } },
      { name: 'cancel not honored', cause: 'cancelled', data: {
        status: RunStatus.FAILED, error: 'cancel not honored', cancelRequestedAt: now, finishedAt: now,
      } },
      { name: 'failed turn', cause: 'turn_failed', data: {
        status: RunStatus.FAILED, error: 'API Error: 500', cancelRequestedAt: now, finishedAt: now,
      } },
      { name: 'engine failed', cause: 'engine_exited', data: { status: RunStatus.FAILED, error: 'crashed', finishedAt: now } },
      { name: 'cancel, no reason', cause: 'cancelled', data: { status: RunStatus.CANCELLED, cancelRequestedAt: now, finishedAt: now } },
      { name: 'runner cancelled', cause: 'engine_exited', data: { status: RunStatus.CANCELLED, finishedAt: now } },
      { name: 'succeeded, no end reason', cause: 'engine_exited', data: { status: RunStatus.SUCCEEDED, finishedAt: null } },
      { name: 'held', cause: null, data: { status: RunStatus.AWAITING_INPUT } },
      { name: 'interrupted with an end reason', cause: null, data: { status: RunStatus.INTERRUPTED, endReason: 'cancelled' } },
    ];
    const made: Array<{ id: string; name: string; cause: string | null; terminal: boolean }> = [];
    for (const c of cases) {
      for (let n = 0; n < 3; n++) {
        made.push({
          id: await session(s.db, w, c.data),
          name: c.name,
          cause: c.cause,
          terminal: ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(c.data.status as string),
        });
      }
    }
    // A cause a writer recorded after 1261 is not the backfill's to change.
    const written = await session(s.db, w, { status: RunStatus.FAILED, finishedAt: now, releaseCause: 'runner_lost' });

    // Both backfills of this project, by prisma, on a database holding every row the cases above wrote.
    await deployAgain(sql, url, ['1202_turn_outcome_backfill', '1262_session_release_backfill']);

    for (const m of made) {
      const row = await released(sql, m.id);
      assert.equal(row.release_cause, m.cause, `${m.name}: the cause`);
      if (m.terminal) assert.ok(row.finished_at instanceof Date, `${m.name}: the release column`);
      else assert.equal(row.finished_at, null, `${m.name}: a held row gets no release column`);
    }
    assert.equal((await released(sql, written)).release_cause, 'runner_lost', 'a recorded cause is kept');
    const held = (await sql.query(
      `SELECT count(*)::int AS n FROM "session" WHERE id = ANY($1::uuid[]) AND last_turn_outcome = 'ANSWERED'`,
      [made.filter((m) => m.name === 'held').map((m) => m.id)],
    )).rows[0] as { n: number };
    assert.equal(held.n, 3, '1202 ran too: a held AWAITING_INPUT row reads ANSWERED');

    // Plan step 3.3's two counts, over the whole database: everything this spec's writers released above and
    // everything the backfill just wrote.
    const releasedWithout = `SELECT count(*)::int AS n FROM "session"
       WHERE status IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND (finished_at IS NULL OR release_cause IS NULL)`;
    const heldWith = `SELECT count(*)::int AS n FROM "session"
       WHERE status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND (finished_at IS NOT NULL OR release_cause IS NOT NULL)`;
    const total = (await sql.query(`SELECT status::text AS status, count(*)::int AS n FROM "session" GROUP BY 1 ORDER BY 1`)).rows;
    const a = (await sql.query(releasedWithout)).rows[0] as { n: number };
    const b = (await sql.query(heldWith)).rows[0] as { n: number };
    console.log(`# sessions by status ${JSON.stringify(total)}`);
    console.log(`# ${releasedWithout.replace(/\s+/g, ' ')} -> ${a.n}`);
    console.log(`# ${heldWith.replace(/\s+/g, ' ')} -> ${b.n}`);
    assert.equal(a.n, 0, 'terminal rows without the release column or a cause');
    assert.equal(b.n, 0, 'open rows with either');
  });

  // Rows the server of the release before the release-fact work writes during the hand-over after 1262, which 1402
  // makes whole before it validates, and which (11) then sees 1405 give a failure cause where they are FAILED.
  const handover: Array<{ id: string; name: string; status: string; after1402: string | null; after1405: string | null }> = [];

  await t.test('(10) 1401 and 1402: the hand-over rows are made whole, the check is validated, each violating write is refused', async () => {
    const old = await world(s.db, 'handover');
    const stale = new Date(Date.now() - 10 * 60_000);
    const shapes: Array<{ name: string; data: Record<string, unknown>; after1402: string | null; after1405: string | null }> = [
      { name: 'ended SUCCEEDED, no release column', after1402: 'engine_exited', after1405: 'engine_exited',
        data: { status: RunStatus.SUCCEEDED, finishedAt: null } },
      { name: 'engine crash, no release column', after1402: 'engine_exited', after1405: 'engine_failed',
        data: { status: RunStatus.FAILED, error: 'crashed', finishedAt: null } },
      { name: 'cancelled, no release column', after1402: 'cancelled', after1405: 'cancelled',
        data: { status: RunStatus.CANCELLED, cancelRequestedAt: stale, finishedAt: null } },
      { name: 'reaper offline, released with no cause', after1402: 'runner_lost', after1405: 'runner_lost',
        data: { status: RunStatus.FAILED, error: 'runner offline', cancelRequestedAt: stale, finishedAt: stale } },
      { name: 'a failed session completed, released with no cause', after1402: 'completed', after1405: 'engine_failed',
        data: { status: RunStatus.FAILED, endReason: SessionEndReason.COMPLETED, finishedAt: stale } },
      { name: 'revived after 1262: open, with 1262\'s cause', after1402: null, after1405: null,
        data: { status: RunStatus.PENDING, finishedAt: null, releaseCause: 'engine_exited' } },
      { name: 'revived, open with both', after1402: null, after1405: null,
        data: { status: RunStatus.AWAITING_INPUT, finishedAt: stale, releaseCause: 'ended' } },
    ];
    for (const shape of shapes) {
      handover.push({
        id: await session(s.db, old, shape.data), name: shape.name, status: shape.data.status as string,
        after1402: shape.after1402, after1405: shape.after1405,
      });
    }

    await deployAgain(sql, url, ['1401_session_release_fact_chk', '1402_session_release_fact_validate']);

    for (const h of handover) {
      const row = await released(sql, h.id);
      assert.equal(row.status, h.status, `${h.name}: the status is not written`);
      assert.equal(row.release_cause, h.after1402, `${h.name}: the cause 1402 leaves`);
      assert.equal(row.finished_at instanceof Date, h.after1402 !== null, `${h.name}: the release column with the cause`);
    }
    const listed = (await sql.query(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'session_release_fact_chk' AND conrelid = 'session'::regclass`,
    )).rows as Array<{ convalidated: boolean }>;
    console.log(`# pg_constraint session_release_fact_chk ${JSON.stringify(listed)}`);
    assert.deepEqual(listed, [{ convalidated: true }]);

    const w = await world(s.db, 'check');
    const refused = async (what: string, run: () => Promise<unknown>): Promise<void> => {
      await assert.rejects(run, (error: { code?: string; constraint?: string }) => {
        console.log(`# ${what}: refused ${error.code} ${error.constraint}`);
        return error.code === '23514' && error.constraint === 'session_release_fact_chk';
      }, what);
    };
    const held = await session(s.db, w, { status: RunStatus.AWAITING_INPUT });
    const done = await session(s.db, w);
    await s.api.finalize({ id: w.runnerId }, done, { status: SharedRunStatus.SUCCEEDED } as never);
    assertReleased(await released(sql, done), 'SUCCEEDED', 'engine_exited');

    await refused('a terminal status with no finished_at (and no cause)', () =>
      sql.query(`UPDATE "session" SET status = 'FAILED' WHERE id = $1::uuid`, [held]));
    await refused('a terminal status with a cause but no finished_at', () =>
      sql.query(`UPDATE "session" SET status = 'FAILED', release_cause = 'turn_failed' WHERE id = $1::uuid`, [held]));
    await refused('an open status with finished_at set', () =>
      sql.query(`UPDATE "session" SET finished_at = now() WHERE id = $1::uuid`, [held]));
    await refused('an open status with finished_at and a cause', () =>
      sql.query(`UPDATE "session" SET finished_at = now(), release_cause = 'ended' WHERE id = $1::uuid`, [held]));
    await refused('released without a cause', () =>
      sql.query(`UPDATE "session" SET release_cause = NULL WHERE id = $1::uuid`, [done]));
    await refused('a cause on a held session', () =>
      sql.query(`UPDATE "session" SET release_cause = 'ended' WHERE id = $1::uuid`, [held]));
    await refused('a revive that clears the status but not the release column', () =>
      sql.query(`UPDATE "session" SET status = 'PENDING' WHERE id = $1::uuid`, [done]));
    // Through Prisma the driver error is wrapped; the constraint is still named in its message.
    await assert.rejects(() => session(s.db, w, { status: RunStatus.CANCELLED }), /session_release_fact_chk/);
    await assert.rejects(
      () => s.db.session.update({ where: { id: held }, data: { status: RunStatus.FAILED } }), /session_release_fact_chk/);
    // The rows are as they were, and the legal writes still go through.
    assert.equal((await released(sql, held)).finished_at, null);
    await sql.query(
      `UPDATE "session" SET status = 'FAILED', finished_at = now(), release_cause = 'turn_failed' WHERE id = $1::uuid`, [held],
    );
    await sql.query(
      `UPDATE "session" SET status = 'PENDING', finished_at = NULL, release_cause = NULL WHERE id = $1::uuid`, [held],
    );
  });

  await t.test('(11) 1403-1407: every FAILED row gets a failure cause, and the database holds the two readings equal', async () => {
    const w = await world(s.db, 'failure');
    const now = new Date();
    const later = new Date(Date.now() + 3_600_000);
    // Rows as the writers before 1403, and 1262, left them, so session_release_failure_chk is not there yet: it comes
    // back by its own two migrations below. Three of each, so the counts are counts.
    await sql.query(`ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_release_failure_chk"`);
    const cases: Array<{ name: string; data: Record<string, unknown>; cause: string | null }> = [
      // The ambiguous causes on FAILED rows, each given the cause its own facts name.
      { name: 'finalize FAILED, no end requested', cause: 'engine_failed', data: {
        status: RunStatus.FAILED, error: 'engine crashed', finishedAt: now, releaseCause: 'engine_exited',
      } },
      { name: 'a cancel not honoured', cause: 'end_not_honored', data: {
        status: RunStatus.FAILED, error: 'cancel not honored', cancelRequestedAt: now, finishedAt: now, releaseCause: 'cancelled',
      } },
      { name: 'a delete not honoured', cause: 'end_not_honored', data: {
        status: RunStatus.FAILED, error: 'cancel not honored', endReason: 'deleted', deletedAt: now, cancelRequestedAt: now,
        finishedAt: now, releaseCause: 'deleted',
      } },
      { name: 'a complete not honoured', cause: 'end_not_honored', data: {
        status: RunStatus.FAILED, error: 'cancel not honored', endReason: 'completed', completedAt: now, cancelRequestedAt: now,
        finishedAt: now, releaseCause: 'completed',
      } },
      { name: 'a failed turn, completed afterwards', cause: 'turn_failed', data: {
        status: RunStatus.FAILED, error: 'API Error: 500', endReason: 'completed', completedAt: now, cancelRequestedAt: now,
        finishedAt: now, releaseCause: 'completed',
      } },
      { name: 'runner lost, ended afterwards', cause: 'runner_lost', data: {
        status: RunStatus.FAILED, error: 'runner offline', endReason: 'ended', cancelRequestedAt: now, finishedAt: now,
        releaseCause: 'ended',
      } },
      { name: 'runtime never up, task done afterwards', cause: 'setup_failed', data: {
        status: RunStatus.FAILED, error: 'kimi runtime not initialized', endReason: 'task_done', cancelRequestedAt: now,
        finishedAt: now, releaseCause: 'task_done',
      } },
      { name: 'a failed import, deleted', cause: 'import_failed', data: {
        status: RunStatus.FAILED, importSourceCwd: '/home/someone', endReason: 'deleted', deletedAt: now, finishedAt: now,
        releaseCause: 'deleted',
      } },
      { name: 'a refused source, cancelled afterwards', cause: 'setup_failed', data: {
        status: RunStatus.FAILED, sourceState: 'REFUSED', sourceRefusalCode: 'BASE_REF_NOT_FOUND', endReason: 'cancelled',
        sourceKind: 'CHAT_UPSTREAM', sourceRepoUrl: 'https://git.invalid/acme/widgets', sourceRefAuthority: 'REMOTE',
        sourceRef: 'refs/heads/main', finishedAt: now, releaseCause: 'cancelled',
      } },
      { name: 'legacy idle on a FAILED row', cause: 'engine_failed', data: {
        status: RunStatus.FAILED, endReason: 'idle', finishedAt: now, releaseCause: 'idle',
      } },
      // Rows the backfill leaves as they are.
      { name: 'a failure cause already', cause: 'turn_failed', data: {
        status: RunStatus.FAILED, error: 'API Error: 500', endReason: 'ended', cancelRequestedAt: now, finishedAt: now,
        releaseCause: 'turn_failed',
      } },
      { name: 'SUCCEEDED engine exit', cause: 'engine_exited', data: {
        status: RunStatus.SUCCEEDED, finishedAt: now, releaseCause: 'engine_exited',
      } },
      { name: 'CANCELLED by the runner', cause: 'engine_exited', data: {
        status: RunStatus.CANCELLED, finishedAt: now, releaseCause: 'engine_exited',
      } },
      { name: 'CANCELLED end with no reason', cause: 'cancelled', data: {
        status: RunStatus.CANCELLED, cancelRequestedAt: now, finishedAt: now, releaseCause: 'cancelled',
      } },
      { name: 'a quota park with a retry armed, ended', cause: 'ended', data: {
        status: RunStatus.CANCELLED, endReason: 'ended', cancelRequestedAt: now, retryAt: later, finishedAt: now,
        releaseCause: 'ended',
      } },
      { name: 'SUCCEEDED task done', cause: 'task_done', data: {
        status: RunStatus.SUCCEEDED, endReason: 'task_done', cancelRequestedAt: now, finishedAt: now, releaseCause: 'task_done',
      } },
      { name: 'landing', cause: 'landing_settled', data: {
        sessionKind: 'LANDING', status: RunStatus.CANCELLED, provider: 'orbit', engine: null, assignedRunnerId: null,
        completedAt: now, finishedAt: now, releaseCause: 'landing_settled',
      } },
      { name: 'held', cause: null, data: { status: RunStatus.AWAITING_INPUT } },
    ];
    const made: Array<{ id: string; name: string; cause: string | null; status: string; endReason: unknown; retryAt: unknown }> = [];
    for (const c of cases) {
      for (let n = 0; n < 3; n++) {
        made.push({
          id: await session(s.db, w, c.data), name: c.name, cause: c.cause, status: c.data.status as string,
          endReason: c.data.endReason ?? null, retryAt: c.data.retryAt ?? null,
        });
      }
    }

    await deployAgain(sql, url, [
      '1405_session_release_failure_backfill', '1406_session_release_failure_chk', '1407_session_release_failure_validate',
    ]);

    for (const h of handover) {
      const row = await released(sql, h.id);
      assert.equal(row.release_cause, h.after1405, `${h.name}: the cause after 1405`);
      assert.equal(isFailedRelease(row.release_cause), row.status === 'FAILED', `${h.name}: a failure exactly when FAILED`);
    }
    for (const m of made) {
      const row = (await sql.query(
        `SELECT status::text AS status, release_cause, end_reason FROM "session" WHERE id = $1::uuid`, [m.id],
      )).rows[0] as { status: string; release_cause: string | null; end_reason: string | null };
      // retry_at through Prisma, which reads the timestamp column as UTC as it was written (the pg driver reads it in
      // the host's zone).
      const { retryAt } = await s.db.session.findUniqueOrThrow({ where: { id: m.id }, select: { retryAt: true } });
      console.log(`# ${m.name}: ${JSON.stringify({ ...row, retryAt })}`);
      assert.equal(row.release_cause, m.cause, `${m.name}: the cause`);
      assert.equal(row.status, m.status, `${m.name}: the status is not written`);
      assert.equal(row.end_reason, m.endReason, `${m.name}: end_reason is not written`);
      assert.equal(retryAt?.getTime() ?? null, (m.retryAt as Date | null)?.getTime() ?? null, `${m.name}: retry_at is not written`);
      assert.equal(isFailedRelease(row.release_cause), row.status === 'FAILED', `${m.name}: a failure exactly when FAILED`);
    }

    // The two counts, over the whole database: this spec's writers above, (9)'s 1262 rows and the rows just written.
    const failure = failedReleaseSql('release_cause').text;
    const failedNotFailure = `SELECT count(*)::int AS n FROM "session" WHERE status = 'FAILED' AND NOT COALESCE(${failure}, false)`;
    const otherFailure = `SELECT count(*)::int AS n FROM "session" WHERE finished_at IS NOT NULL AND status <> 'FAILED' AND ${failure}`;
    const byCause = (await sql.query(
      `SELECT status::text AS status, release_cause, count(*)::int AS n FROM "session" GROUP BY 1, 2 ORDER BY 1, 2`,
    )).rows;
    const a = (await sql.query(failedNotFailure)).rows[0] as { n: number };
    const b = (await sql.query(otherFailure)).rows[0] as { n: number };
    console.log(`# sessions by status and cause ${JSON.stringify(byCause)}`);
    console.log(`# ${failedNotFailure} -> ${a.n}`);
    console.log(`# ${otherFailure} -> ${b.n}`);
    assert.equal(a.n, 0, 'FAILED rows not read as failures');
    assert.equal(b.n, 0, 'released rows that are not FAILED but read as failures');
    // The Prisma filter reads the same rows: this world's failures are its FAILED rows.
    const filtered = await s.db.session.count({ where: { ownerId: w.ownerId, releaseCause: failedReleaseFilter() } });
    const failedRows = await s.db.session.count({ where: { ownerId: w.ownerId, status: RunStatus.FAILED } });
    console.log(`# failedReleaseFilter ${filtered}, FAILED ${failedRows}`);
    assert.equal(filtered, failedRows);
    assert.equal(filtered, made.filter((m) => m.status === 'FAILED').length);

    const listed = (await sql.query(
      `SELECT conname, convalidated FROM pg_constraint
        WHERE conname IN ('session_release_failure_chk', 'session_release_cause_chk') AND conrelid = 'session'::regclass
        ORDER BY conname`,
    )).rows as Array<{ conname: string; convalidated: boolean }>;
    console.log(`# pg_constraint ${JSON.stringify(listed)}`);
    assert.deepEqual(listed, [
      { conname: 'session_release_cause_chk', convalidated: true },
      { conname: 'session_release_failure_chk', convalidated: true },
    ]);

    // Every cause of the module's list, with each terminal status: the database takes it exactly when the status is
    // FAILED for a failure cause and not FAILED otherwise, so the TypeScript set and the CHECK's are the same set.
    const held = await session(s.db, w, { status: RunStatus.AWAITING_INPUT });
    const release = (status: string, cause: string) => sql.query(
      `UPDATE "session" SET status = $2::run_status, finished_at = now(), release_cause = $3 WHERE id = $1::uuid`,
      [held, status, cause],
    );
    for (const cause of SESSION_RELEASE_CAUSES) {
      for (const status of ['FAILED', 'SUCCEEDED', 'CANCELLED']) {
        const allowed = (status === 'FAILED') === isFailedRelease(cause);
        if (allowed) {
          await release(status, cause);
          await sql.query(
            `UPDATE "session" SET status = 'AWAITING_INPUT', finished_at = NULL, release_cause = NULL WHERE id = $1::uuid`, [held],
          );
          console.log(`# ${status} ${cause}: taken`);
        } else {
          await assert.rejects(() => release(status, cause), (error: { code?: string; constraint?: string }) => {
            console.log(`# ${status} ${cause}: refused ${error.code} ${error.constraint}`);
            return error.code === '23514' && error.constraint === 'session_release_failure_chk';
          }, `${status} ${cause}`);
        }
      }
    }
    // Through Prisma the driver error is wrapped; the constraint is still named in its message.
    await assert.rejects(() => s.db.session.update({
      where: { id: held }, data: { status: RunStatus.FAILED, finishedAt: new Date(), releaseCause: 'engine_exited' },
    }), /session_release_failure_chk/);
    await assert.rejects(() => s.db.session.update({
      where: { id: held }, data: { status: RunStatus.CANCELLED, finishedAt: new Date(), releaseCause: 'end_not_honored' },
    }), /session_release_failure_chk/);
    assert.equal((await released(sql, held)).release_cause, null, 'the refused writes left the row held');
  });
});
