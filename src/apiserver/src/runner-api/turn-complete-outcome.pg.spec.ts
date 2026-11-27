/**
 * EVERY TURN THE RUNNER REPORTS COMPLETE HAS ITS OUTCOME ON THE TURN, AND ITS COPY ON THE SESSION.
 *
 * docs/session-three-state-plan.md §5, design §4.2: `conversation_turn.outcome` and `.error`, and
 * `session.last_turn_outcome` (migration 1201). Each case posts a real turn-complete through the controller
 * and reads both rows back over a second connection:
 *
 *   (1) SUCCEEDED with a reply             → ANSWERED, no error
 *   (2) FAILED with the runtime's error    → FAILED, that error
 *   (3) INTERRUPTED after a Stop           → INTERRUPTED
 *   (4) CANCELLED (Codex, Antigravity)     → CANCELLED
 *   (5) a `!`-shell turn                   → ANSWERED: a turn of work, answered by its exit code
 *   (6) a steer folded into a running turn → nothing: it is not a turn of its own
 *   (7) a retried completion               → the first one's outcome stands
 *   (8) migration 1202's backfill, re-applied by the real `prisma migrate deploy` over one session per status,
 *       counted per status against design §4.3
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/turn-complete-outcome.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { PrismaClient, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { RunEventType, RunStatus as SharedRunStatus } from '@orbit/shared';
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
import { turnStateOfWord } from '../sessions/session-turn-state';
import { restoreStatusColumn } from '../test-support/session-d3-database';
import { wordSql } from '../test-support/session-word';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

function connect(url: string): { db: PrismaClient; api: RunnerApiController } {
  const db = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  return {
    db,
    api: new RunnerApiController(
      prisma,
      queue,
      realtime,
      {} as never,
      {} as never,
      { expand: async (_ownerId: string, content?: string) => content } as never,
      { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    ),
  };
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
}

/** One owner, one runner, a session with the given status and, when RUNNING, a turn out on delivery. */
async function fixture(
  db: PrismaClient,
  label: string,
  kind: 'message' | 'shell' = 'message',
  session: { status?: RunStatus; endReason?: string | null } = {},
): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@outcome.invalid`, name: 'The owner', passwordHash: 'x' },
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
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true },
  });
  await db.session.create({
    data: {
      id: sessionId,
      ownerId,
      creatorId: ownerId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: `${label} session`,
      prompt: 'Explain the error in the log',
      provider: 'claude',
      turnState: turnStateOfWord(session.status ?? RunStatus.RUNNING),
      ...(['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(session.status ?? RunStatus.RUNNING)
        ? { finishedAt: new Date()}
        : {}),
      endReason: session.endReason ?? null,
      engineTurnActive: (session.status ?? RunStatus.RUNNING) === RunStatus.RUNNING,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startedAt: new Date(),
      runtimeSessionId: randomUUID(),
    },
  });
  const turn = await db.conversationTurn.create({
    data: {
      sessionId,
      seq: 1,
      clientTurnId: `${label}-${randomUUID()}`,
      kind,
      content: kind === 'shell' ? 'npm test' : 'Explain the error in the log',
      status: 'IN_FLIGHT',
      deliveredAt: new Date(),
      leaseDeadlineAt: new Date(Date.now() + 300_000),
      leaseGeneration: randomUUID(),
    },
    select: { id: true },
  });
  return { ownerId, runnerId, workspaceId, sessionId, turnId: turn.id };
}

function say(api: RunnerApiController, f: Fixture, seq: number, type: RunEventType, payload: Record<string, unknown>) {
  return api.events({ id: f.runnerId }, f.sessionId, {
    events: [{ seq, type, ts: new Date().toISOString(), turnId: f.turnId, payload }],
  });
}

/**
 * Re-apply migration 1202 with the real `prisma migrate deploy`, on this database as it stands: its row in
 * `_prisma_migrations` is forgotten first, so deploy finds it pending and applies it the way it does on an
 * installation (prisma decides per file whether to send it whole, as one transaction, or statement by statement).
 * This spec once split the file into statements itself, while prisma sends a file with a CREATE PROCEDURE whole, in
 * which the old procedure's per-batch COMMIT is refused (production's deploy of af55a2fb38 failed with 2D000).
 */
/** Migration 1671 (deploy D3) and its down script, which leaves the database deploy 2 ran on: for case (8). */
const D3_DOWN = readFileSync(join(__dirname, '..', '..', '..', '..', 'scripts', 'session-status-from-facts-down.sql'), 'utf8');
const D3_UP = readFileSync(join(__dirname, '..', '..', 'prisma', 'migrations', '1671_session_status_from_facts', 'migration.sql'), 'utf8');

async function deployAgain(sql: Client, url: string, migration: string): Promise<void> {
  await sql.query(`DELETE FROM _prisma_migrations WHERE migration_name = $1`, [migration]);
  try {
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: join(__dirname, '..', '..'), env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', stdio: 'pipe',
    });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    assert.fail(`prisma migrate deploy of ${migration} failed:\n${e.stdout ?? ''}${e.stderr ?? ''}`);
  }
  const applied = (await sql.query(
    `SELECT count(*)::int AS n FROM _prisma_migrations
      WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    [migration],
  )).rows[0] as { n: number };
  assert.equal(applied.n, 1, 'prisma recorded it applied');
}

test('turn-complete records the turn outcome on the turn and on the session', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const { db, api } = connect(url);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  /** Both rows, read over a second connection. */
  async function rows(f: Fixture, turnId = f.turnId) {
    const turn = (await sql.query(
      `SELECT status, outcome, error FROM "conversation_turn" WHERE id = $1::uuid`, [turnId],
    )).rows[0] as { status: string; outcome: string | null; error: string | null };
    const session = (await sql.query(
      `SELECT ${wordSql()} AS status, last_turn_outcome, finished_at FROM "session" WHERE id = $1::uuid`,
      [f.sessionId],
    )).rows[0] as { status: string; last_turn_outcome: string | null; finished_at: Date | null };
    console.log(`# ${JSON.stringify({ turn, session })}`);
    return { turn, session };
  }

  await t.test('(1) SUCCEEDED with a reply: ANSWERED', async () => {
    const f = await fixture(db, 'succeeded');
    await say(api, f, 1, RunEventType.USER, { text: 'Explain the error in the log' });
    await say(api, f, 2, RunEventType.ASSISTANT, { text: 'It is a 401 from the gateway.' });
    await api.turnComplete({ id: f.runnerId }, f.sessionId, {
      turnId: f.turnId, status: SharedRunStatus.SUCCEEDED, subtype: 'success', numTurns: 1, costUsd: 0.01,
    });
    const { turn, session } = await rows(f);
    assert.equal(turn.status, 'ANSWERED');
    assert.equal(turn.outcome, 'ANSWERED');
    assert.equal(turn.error, null, 'an answered turn carries no error');
    assert.equal(session.last_turn_outcome, 'ANSWERED');
    assert.equal(session.status, 'AWAITING_INPUT', 'the status write is the one it always was');
    assert.equal(session.finished_at, null, 'a parked session is held: no release column');
  });

  await t.test('(2) FAILED: FAILED, with the error the runtime reported', async () => {
    const f = await fixture(db, 'failed');
    await say(api, f, 1, RunEventType.USER, { text: 'Explain the error in the log' });
    await say(api, f, 2, RunEventType.ASSISTANT, { text: 'Reading the log now.' });
    await api.turnComplete({ id: f.runnerId }, f.sessionId, {
      turnId: f.turnId,
      status: SharedRunStatus.FAILED,
      subtype: 'error_during_execution',
      error: 'API Error: 500 Internal server error',
      result: 'Reading the log now.',
      numTurns: 1,
      costUsd: 0.01,
    });
    const { turn, session } = await rows(f);
    assert.equal(turn.outcome, 'FAILED');
    assert.equal(turn.error, 'API Error: 500 Internal server error', 'the failure, not the last reply');
    assert.equal(session.last_turn_outcome, 'FAILED');
    assert.equal(session.status, 'FAILED', 'the status write is the one it always was');
    // Released by the failed turn, in the same write (plan step 3.2).
    assert.ok(session.finished_at instanceof Date, 'the failed turn sets the release column');
  });

  await t.test('(3) INTERRUPTED after a Stop: INTERRUPTED', async () => {
    const f = await fixture(db, 'interrupted');
    await say(api, f, 1, RunEventType.USER, { text: 'Explain the error in the log' });
    await say(api, f, 2, RunEventType.INTERRUPT, { requestId: randomUUID() });
    await api.turnComplete({ id: f.runnerId }, f.sessionId, {
      turnId: f.turnId, status: SharedRunStatus.INTERRUPTED, subtype: 'error_during_execution', numTurns: 0, costUsd: 0,
    });
    const { turn, session } = await rows(f);
    assert.equal(turn.status, 'ANSWERED');
    assert.equal(turn.outcome, 'INTERRUPTED');
    assert.equal(turn.error, null);
    assert.equal(session.last_turn_outcome, 'INTERRUPTED');
  });

  await t.test('(4) CANCELLED, as Codex and Antigravity report a cancelled turn: CANCELLED', async () => {
    const f = await fixture(db, 'cancelled');
    await say(api, f, 1, RunEventType.USER, { text: 'Explain the error in the log' });
    await say(api, f, 2, RunEventType.ASSISTANT, { text: 'Stopping here.' });
    await api.turnComplete({ id: f.runnerId }, f.sessionId, {
      turnId: f.turnId, status: SharedRunStatus.CANCELLED, numTurns: 1, costUsd: 0.01,
    });
    const { turn, session } = await rows(f);
    assert.equal(turn.outcome, 'CANCELLED');
    assert.equal(session.last_turn_outcome, 'CANCELLED');
  });

  await t.test('(5) a `!`-shell turn is a turn of work: ANSWERED', async () => {
    const f = await fixture(db, 'shell', 'shell');
    await api.turnComplete({ id: f.runnerId }, f.sessionId, {
      turnId: f.turnId, status: SharedRunStatus.SUCCEEDED, shellExitCode: 0, shellOutput: 'ok', numTurns: 0, costUsd: 0,
    });
    const { turn, session } = await rows(f);
    assert.equal(turn.outcome, 'ANSWERED');
    assert.equal(session.last_turn_outcome, 'ANSWERED');
  });

  await t.test('(6) a steer folded into the running turn has no outcome of its own', async () => {
    const f = await fixture(db, 'steer');
    const steer = await db.conversationTurn.create({
      data: {
        sessionId: f.sessionId,
        seq: 2,
        clientTurnId: `steer-${randomUUID()}`,
        kind: 'steer',
        content: 'Also check the second log',
        status: 'IN_FLIGHT',
        deliveredAt: new Date(),
        leaseDeadlineAt: new Date(Date.now() + 300_000),
        leaseGeneration: randomUUID(),
      },
      select: { id: true },
    });
    await api.turnComplete({ id: f.runnerId }, f.sessionId, {
      turnId: steer.id, status: SharedRunStatus.SUCCEEDED, numTurns: 1, costUsd: 0,
    });
    const { turn, session } = await rows(f, steer.id);
    assert.equal(turn.status, 'ANSWERED', 'the steer is acked as before');
    assert.equal(turn.outcome, null, 'a steer is not a turn outcome');
    assert.equal(session.last_turn_outcome, null, 'and the session copy is untouched');
    assert.equal(session.status, 'RUNNING', 'the running turn still runs');
  });

  await t.test('(7) a retried completion does not rewrite the first one\'s outcome', async () => {
    const f = await fixture(db, 'retried');
    await say(api, f, 1, RunEventType.USER, { text: 'Explain the error in the log' });
    await say(api, f, 2, RunEventType.ASSISTANT, { text: 'It is a 401 from the gateway.' });
    await api.turnComplete({ id: f.runnerId }, f.sessionId, {
      turnId: f.turnId, status: SharedRunStatus.SUCCEEDED, numTurns: 1, costUsd: 0.01,
    });
    await api.turnComplete({ id: f.runnerId }, f.sessionId, {
      turnId: f.turnId, status: SharedRunStatus.FAILED, error: 'late duplicate', numTurns: 1, costUsd: 0.01,
    });
    const { turn, session } = await rows(f);
    assert.equal(turn.outcome, 'ANSWERED');
    assert.equal(turn.error, null);
    assert.equal(session.last_turn_outcome, 'ANSWERED');
  });

  await t.test('(8) migration 1202 backfills last_turn_outcome per status as design §4.3 says', async (st) => {
    // 1202 is a deploy-1 backfill that reads the stored word. Since deploy D3 that word follows the facts (migration
    // 1671), so the rehearsal runs on the database deploy 2 left, 1671 rolled back by its down script, with the words
    // written as deploy 2 wrote them; 1671 is put back after. The rows are made first, as today's writers make them.
    st.after(() => sql.query(D3_UP));
    // One session per row of the table, the outcome cleared as on a row written before 1201.
    const cases: Array<{ status: RunStatus; endReason: string | null; expected: string | null }> = [
      { status: RunStatus.PENDING, endReason: null, expected: null },
      { status: RunStatus.RUNNING, endReason: null, expected: null },
      { status: RunStatus.AWAITING_INPUT, endReason: null, expected: 'ANSWERED' },
      { status: RunStatus.INTERRUPTED, endReason: null, expected: 'INTERRUPTED' },
      { status: RunStatus.FAILED, endReason: null, expected: 'FAILED' },
      { status: RunStatus.SUCCEEDED, endReason: 'task_done', expected: 'ANSWERED' },
      { status: RunStatus.SUCCEEDED, endReason: null, expected: null },
      { status: RunStatus.CANCELLED, endReason: 'ended', expected: null },
      { status: RunStatus.INTERRUPTED, endReason: 'cancelled', expected: null },
    ];
    const made: Array<{ id: string; expected: string | null }> = [];
    for (const [i, c] of cases.entries()) {
      // Three of each, so the counts are counts.
      for (let n = 0; n < 3; n++) {
        const f = await fixture(db, `backfill-${i}-${n}`, 'message', { status: c.status, endReason: c.endReason });
        made.push({ id: f.sessionId, expected: c.expected });
      }
    }
    // A value turn-complete wrote after 1201 is not the backfill's to change.
    const written = await fixture(db, 'backfill-written', 'message', { status: RunStatus.FAILED });
    await sql.query(`UPDATE "session" SET last_turn_outcome = 'CANCELLED' WHERE id = $1::uuid`, [written.sessionId]);
    const ids = made.map((m) => m.id);
    await restoreStatusColumn(sql);
    await sql.query(D3_DOWN);
    for (const [i, c] of cases.entries()) {
      await sql.query(`UPDATE "session" SET status = $2::run_status WHERE id = ANY($1::uuid[])`, [ids.slice(3 * i, 3 * i + 3), c.status]);
    }
    await sql.query(`UPDATE "session" SET last_turn_outcome = NULL WHERE id = ANY($1::uuid[])`, [ids]);

    await deployAgain(sql, url, '1202_turn_outcome_backfill');

    const counts = (await sql.query(
      `SELECT status::text AS status, coalesce(end_reason, '-') AS end_reason,
              coalesce(last_turn_outcome, 'null') AS outcome, count(*)::int AS n
         FROM "session" WHERE id = ANY($1::uuid[])
        GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
      [ids],
    )).rows as Array<{ status: string; end_reason: string; outcome: string; n: number }>;
    console.log(`# backfill counts ${JSON.stringify(counts)}`);
    const expected = cases
      .map((c) => ({ status: c.status as string, end_reason: c.endReason ?? '-', outcome: c.expected ?? 'null', n: 3 }))
      .sort((a, b) => `${a.status}|${a.end_reason}`.localeCompare(`${b.status}|${b.end_reason}`));
    assert.deepEqual(
      [...counts].sort((a, b) => `${a.status}|${a.end_reason}`.localeCompare(`${b.status}|${b.end_reason}`)),
      expected,
    );
    const kept = (await sql.query(`SELECT last_turn_outcome FROM "session" WHERE id = $1::uuid`, [written.sessionId])).rows[0];
    assert.equal(kept.last_turn_outcome, 'CANCELLED', 'a value already written is kept');
  });
});
