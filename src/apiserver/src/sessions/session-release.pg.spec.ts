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
 *   (9) migrations 1202 and 1262 applied as prisma applies them (each file one transaction) on a database that
 *       holds rows: 1262's backfill, one session per rule, then the two counts of plan step 3.3 over the database
 *
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
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
}

/**
 * A migration applied the way `prisma migrate deploy` applies it: the whole file sent as one query string, which
 * PostgreSQL runs as ONE transaction (and in which a COMMIT is refused, 2D000). Splitting it into statements and
 * sending each on its own, as this spec once did, is what hid that the 1262 procedure's per-batch COMMIT fails on
 * any database holding a terminal row (production's deploy of af55a2fb38).
 */
async function applyAsPrismaDoes(sql: Client, migration: string): Promise<void> {
  const file = join(__dirname, '..', '..', 'prisma', 'migrations', migration, 'migration.sql');
  await sql.query(readFileSync(file, 'utf8'));
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

  await t.test('(9) migrations 1202 and 1262, each one transaction, backfill every terminal row; the two counts are zero', async () => {
    const w = await world(s.db, 'backfill');
    const now = new Date();
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

    // Both backfills of this project, in deploy order, on a database holding every row the cases above wrote.
    await applyAsPrismaDoes(sql, '1202_turn_outcome_backfill');
    await applyAsPrismaDoes(sql, '1262_session_release_backfill');

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
});
