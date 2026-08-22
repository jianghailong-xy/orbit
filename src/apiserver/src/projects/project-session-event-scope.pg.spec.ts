import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Client } from 'pg';

import { OPEN_SESSION_STATUSES } from '../common/session-scheduling';
import { newFixtureIds, seedLockFixture, type FixtureIds } from '../deadlock/orbit-lock-fixture';
import { runScenario } from '../deadlock/pg-barrier';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';

/**
 * Migration 0130 — `project_session_event_source` stops running on Session writes that cannot
 * produce an event.
 *
 * Two things have to be true at once, and this file proves them against the REAL migrated
 * schema on a disposable server (`scripts/deadlock-barrier.sh session-scope`), never against a
 * hand-built approximation of it:
 *
 *   1. a telemetry-only UPDATE — `last_turn_at`, `last_tool_use`, `last_user_text`,
 *      `engine_turn_active`, `context_tokens`, `updated_at` — reads neither `task` nor
 *      `project` and enqueues nothing. Proved structurally (the relations the backend holds a
 *      lock on afterwards) and behaviourally (a second connection holds `task` locked and the
 *      write still commits inside a strict `lock_timeout`);
 *
 *   2. every event the old, unconditional trigger produced is still produced: session start,
 *      the five status transitions, coordinator-session lifecycle, soft delete, merge success
 *      and merge conflict, hard delete — with the outbox row still atomic with the business row.
 *
 * The barrier is deliberately run against the PRE-0130 shape first (0126's function plus the
 * `AFTER INSERT OR UPDATE OR DELETE` trigger it was installed with) and asserted to TIME OUT
 * there. Without that half, a green barrier would only prove that nothing in the environment
 * happens to block — not that the narrowing is what unblocked it.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = URL ? false : 'set COORDINATOR_PG_URL to run';

const MIGRATIONS = path.resolve(__dirname, '../../prisma/migrations');
const read = (dir: string): string => readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
/** The migration under test. Applied by `prisma migrate deploy`; re-applied here to prove it re-runs. */
const NARROWED = read('0130_session_event_source_update_scope');
/** The function body 0130 inherits. Re-applied to rebuild the pre-fix state for the control. */
const PRE_FIX_FUNCTION = read('0126_project_coordinator_session_lifecycle');
/** The trigger 0117 installed and 0130 replaces: every UPDATE, whatever it wrote. */
const PRE_FIX_TRIGGER = `
  DROP TRIGGER IF EXISTS "project_session_event_source" ON "session";
  DROP TRIGGER IF EXISTS "project_session_event_source_update" ON "session";
  CREATE TRIGGER "project_session_event_source"
  AFTER INSERT OR UPDATE OR DELETE ON "session"
  FOR EACH ROW EXECUTE FUNCTION "project_session_event_source"();`;

/**
 * Strict enough that a blocked write cannot be mistaken for a slow one, and far below the
 * barrier's own wall clock so the timeout is what fails, not the deadline.
 */
const LOCK_TIMEOUT = '2s';
const BARRIER_BUDGET_MS = 30_000;
/** PostgreSQL's `lock_timeout` SQLSTATE. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * The two telemetry-only Session writes the runner's `/events` ingest issues, as Prisma emits
 * them (runner-api.controller.ts): the liveness stamp on every batch that carries session
 * activity, and the denormalisation of the conversation preview. Neither names `status`,
 * `deleted_at` or `merge_status` — which is exactly why neither has an event to enqueue.
 */
const TELEMETRY_LAST_TURN = `
  UPDATE "session" SET "last_turn_at" = $2, "updated_at" = $2
   WHERE "id" = $1::uuid
     AND "cancel_requested_at" IS NULL
     AND "status" = ANY($3::run_status[])`;
const TELEMETRY_PREVIEW = `
  UPDATE "session"
     SET "last_assistant_text" = $2, "last_tool_use" = $3, "last_user_text" = $4,
         "engine_turn_active" = $5, "context_tokens" = $6, "updated_at" = $7
   WHERE "id" = $1::uuid`;

interface Telemetry {
  what: string;
  sql: string;
  values: unknown[];
}

function telemetryWrites(ids: FixtureIds, at: Date): Telemetry[] {
  return [
    {
      what: 'last_turn_at',
      sql: TELEMETRY_LAST_TURN,
      values: [ids.telemetrySessionId, at, OPEN_SESSION_STATUSES],
    },
    {
      what: 'preview/tool/user-text/turn-active/context',
      sql: TELEMETRY_PREVIEW,
      values: [ids.telemetrySessionId, 'assistant text', 'Bash', 'user text', true, 4096, at],
    },
  ];
}

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  return client;
}

/**
 * The whole fixture for one test: the seeded rows the barrier fixture already owns, plus the
 * project's coordinator pointer — a task-less Session whose lifecycle is a signal for the
 * project that names it (0126).
 */
async function seed(client: Client, label: string): Promise<FixtureIds> {
  const ids = newFixtureIds(label);
  await seedLockFixture(client, ids);
  await client.query(`UPDATE "project" SET "coordinator_session_id" = $2::uuid WHERE "id" = $1::uuid`, [
    ids.projectId,
    ids.contendedSessionId,
  ]);
  await clearEvents(client, ids);
  return ids;
}

async function clearEvents(client: Client, ids: FixtureIds): Promise<void> {
  await client.query(`DELETE FROM "project_event" WHERE "project_id" = $1::uuid`, [ids.projectId]);
}

async function events(client: Client, ids: FixtureIds): Promise<Array<[string, number]>> {
  const { rows } = await client.query<{ kind: string; occurrences: number }>(
    // By kind, not by id: every row a single statement enqueues shares one `statement_timestamp()`
    // and carries a random uuid, so `occurred_at, id` would order a multi-row statement's signals
    // differently from one run to the next.
    `SELECT "kind", "occurrences" FROM "project_event"
      WHERE "project_id" = $1::uuid ORDER BY "occurred_at", "kind"`,
    [ids.projectId],
  );
  return rows.map((row) => [row.kind, row.occurrences]);
}

async function kinds(client: Client, ids: FixtureIds): Promise<string[]> {
  return (await events(client, ids)).map(([kind]) => kind);
}

/**
 * The tables this backend currently holds a relation lock on, restricted to the ones that can
 * say anything about the event source. Reading it from inside the transaction is what makes
 * "the trigger did not run" observable rather than inferred: a plpgsql `SELECT … FROM "task"`
 * leaves an `AccessShareLock` on `task` that lives until COMMIT.
 */
async function lockedTables(client: Client): Promise<string[]> {
  const { rows } = await client.query<{ relname: string }>(
    `SELECT DISTINCT c.relname
       FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
      WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation'
        AND c.relname IN ('session', 'task', 'project', 'project_event')
      ORDER BY 1`,
  );
  return rows.map((row) => row.relname);
}

/** Run `sql` in its own transaction and report what it left locked. */
async function lockedBy(client: Client, sql: string, values: unknown[]): Promise<string[]> {
  await client.query('BEGIN');
  try {
    await client.query(sql, values as never);
    return await lockedTables(client);
  } finally {
    await client.query('COMMIT').catch(() => client.query('ROLLBACK').catch(() => undefined));
  }
}

test('a telemetry-only Session UPDATE reads neither Task nor Project, and enqueues nothing', { skip }, async () => {
  const client = await connect();
  try {
    const ids = await seed(client, 'scope-locks');

    for (const write of telemetryWrites(ids, new Date('2026-08-22T00:00:00.000Z'))) {
      const locked = await lockedBy(client, write.sql, write.values);
      assert.deepEqual(
        locked,
        ['session'],
        `the ${write.what} telemetry write locked ${locked.join(', ')} — the event source still ran`,
      );
    }
    assert.deepEqual(await events(client, ids), [], 'a telemetry-only write enqueued a Project signal');

    // The control, and the reason the assertion above means anything: `merge_status` is the one
    // event-bearing column NO other Session trigger is declared over (0122's capacity fence is
    // `UPDATE OF status, task_id, deleted_at`), so the lookups it leaves behind are this
    // trigger's and nobody else's.
    const locked = await lockedBy(client, `UPDATE "session" SET "merge_status" = 'merged' WHERE "id" = $1::uuid`, [
      ids.telemetrySessionId,
    ]);
    assert.deepEqual(locked, ['project', 'project_event', 'session', 'task']);
    assert.deepEqual(await kinds(client, ids), ['merge.succeeded']);
  } finally {
    await client.end();
  }
});

/**
 * Connection A holds the relation the event source probes; connection B does the telemetry
 * write under a strict `lock_timeout`. `AccessExclusiveLock` is what an `ALTER TABLE`, a
 * `REINDEX` or a `VACUUM FULL` on that table takes, and `AccessShareLock` — the lock the
 * trigger's `SELECT` needs — is the only one it conflicts with. A row lock on the Task is NOT
 * the barrier: MVCC means the probe reads straight through one, which is asserted separately
 * below so the choice is on the record rather than assumed.
 */
function barrier(ids: FixtureIds, relation: 'task' | 'project', write: Telemetry) {
  return {
    name: `telemetry-vs-${relation}-lock`,
    parties: [
      { name: 'schema-change', deadlockTimeout: '30min' },
      { name: 'telemetry', deadlockTimeout: '30min' },
    ],
    plan: [
      {
        op: 'run' as const,
        party: 'schema-change',
        label: `L1 lock-${relation}`,
        sql: `LOCK TABLE "${relation}" IN ACCESS EXCLUSIVE MODE`,
      },
      {
        op: 'run' as const,
        party: 'telemetry',
        label: 'T1 lock-timeout',
        sql: `SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`,
      },
      { op: 'run' as const, party: 'telemetry', label: 'T2 telemetry-write', sql: write.sql, values: write.values },
      { op: 'finish' as const, party: 'telemetry', action: 'COMMIT' as const },
      { op: 'finish' as const, party: 'schema-change', action: 'ROLLBACK' as const },
    ],
  };
}

test('with Task or Project locked, a telemetry-only Session UPDATE still commits inside lock_timeout', { skip }, async () => {
  const client = await connect();
  try {
    const ids = await seed(client, 'scope-barrier');
    const write = telemetryWrites(ids, new Date('2026-08-22T01:00:00.000Z'))[0];

    // 1 · The control: the pre-0130 trigger, on the same schedule, times out on both relations.
    await client.query(PRE_FIX_FUNCTION);
    await client.query(PRE_FIX_TRIGGER);
    for (const relation of ['task', 'project'] as const) {
      await assert.rejects(
        runScenario(URL!, barrier(ids, relation, write), BARRIER_BUDGET_MS),
        new RegExp(`T2 telemetry-write.*\\(${LOCK_NOT_AVAILABLE}\\)`, 's'),
        `the unnarrowed trigger did not block on a locked ${relation} — the barrier proves nothing`,
      );
    }
    assert.deepEqual(await events(client, ids), [], 'a blocked telemetry write still enqueued something');

    // 2 · The migration under test, on the identical schedule.
    await client.query(NARROWED);
    for (const relation of ['task', 'project'] as const) {
      const outcome = await runScenario(URL!, barrier(ids, relation, write), BARRIER_BUDGET_MS);
      assert.deepEqual(
        outcome.statements.map((s) => [s.label, s.ok]),
        [
          [`L1 lock-${relation}`, true],
          ['T1 lock-timeout', true],
          ['T2 telemetry-write', true],
        ],
        `a statement failed while ${relation} was locked`,
      );
      assert.equal(outcome.committed['telemetry'], true, `the telemetry transaction did not commit (${relation})`);
    }
    assert.deepEqual(await events(client, ids), [], 'a telemetry-only write enqueued a Project signal');
    const { rows } = await client.query<{ last_turn_at: Date }>(
      `SELECT "last_turn_at" FROM "session" WHERE "id" = $1::uuid`,
      [ids.telemetrySessionId],
    );
    assert.equal(rows[0].last_turn_at.toISOString(), '2026-08-22T01:00:00.000Z');

    // 3 · A ROW lock on the associated Task never blocked the probe and still does not: the
    // barrier above is about the relation lock, and this is what says so out loud.
    await client.query('BEGIN');
    await client.query(`SELECT "id" FROM "task" WHERE "id" = $1::uuid FOR UPDATE`, [ids.prerequisiteTaskId]);
    const second = await connect();
    try {
      await second.query(`SET lock_timeout = '${LOCK_TIMEOUT}'`);
      await second.query(write.sql, [ids.telemetrySessionId, new Date('2026-08-22T02:00:00.000Z'), OPEN_SESSION_STATUSES]);
    } finally {
      await second.end();
      await client.query('ROLLBACK');
    }
  } finally {
    await client.end();
  }
});

test('every Session lifecycle event the unconditional trigger produced is still produced', { skip }, async () => {
  const client = await connect();
  try {
    const ids = await seed(client, 'scope-matrix');
    const telemetry = telemetryWrites(ids, new Date('2026-08-22T03:00:00.000Z'));
    const session = ids.telemetrySessionId;
    const coordinator = ids.contendedSessionId;

    // INSERT — a task session's start is a signal, and a batch of them collapses on batch_id.
    const batch = newFixtureIds('scope-matrix-batch');
    const batchId = batch.projectId;
    const pairs: Array<[string, string]> = [
      [batch.batchTaskId, batch.contendedSessionId],
      [batch.dependentTaskId, batch.telemetrySessionId],
    ];
    for (const [taskId] of pairs) {
      await client.query(
        `INSERT INTO "task" ("id", "title", "owner_id", "creator_type", "creator_id", "project_id", "updated_at")
         VALUES ($1::uuid, $2, $3::uuid, 'AGENT'::creator_type, $3::uuid, $4::uuid, CURRENT_TIMESTAMP)`,
        [taskId, `${ids.label}-batch-task`, ids.ownerId, ids.projectId],
      );
    }
    // The tasks are scaffolding; their own `task.created` signals are not what this asserts.
    await clearEvents(client, ids);
    for (const [taskId, sessionId] of pairs) {
      // Separate statements, as batch execution issues them: only batch_id can coalesce these.
      await client.query(
        `INSERT INTO "session" ("id", "title", "prompt", "owner_id", "creator_id", "assigned_runner_id",
                                "workspace_id", "task_id", "batch_id", "status", "updated_at")
         VALUES ($1::uuid, $2, 'fixture', $3::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid,
                 'PENDING'::run_status, CURRENT_TIMESTAMP)`,
        [sessionId, `${ids.label}-batch-session`, ids.ownerId, ids.runnerId, ids.workspaceId, taskId, batchId],
      );
    }
    assert.deepEqual(await events(client, ids), [['session.started', 2]]);

    // UPDATE — the five status transitions, each still classified as before.
    for (const [status, kind] of [
      ['AWAITING_INPUT', 'session.awaiting_input'],
      ['INTERRUPTED', 'session.awaiting_input'],
      ['FAILED', 'session.failed'],
      ['SUCCEEDED', 'session.ended'],
      ['PENDING', 'session.started'],
      ['CANCELLED', 'session.ended'],
    ] as Array<[string, string]>) {
      await clearEvents(client, ids);
      await client.query(`UPDATE "session" SET "status" = $2::run_status WHERE "id" = $1::uuid`, [session, status]);
      assert.deepEqual(await kinds(client, ids), [kind], `${status} did not produce ${kind}`);
    }

    // A writer that names `status` without moving it — `updateMany({ data: { status, lastTurnAt } })`
    // is exactly this shape. `UPDATE OF` alone would let it through; the WHEN clause is why it
    // produces nothing, as it produced nothing before.
    await clearEvents(client, ids);
    await client.query(
      `UPDATE "session" SET "status" = $2::run_status, "last_turn_at" = $3, "updated_at" = $3 WHERE "id" = $1::uuid`,
      [session, 'CANCELLED', new Date('2026-08-22T04:00:00.000Z')],
    );
    for (const write of telemetry) await client.query(write.sql, write.values as never);
    assert.deepEqual(await events(client, ids), []);

    // The coordinator session: its status is a signal for the project that NAMES it, even though
    // it has no task of its own.
    await client.query(`UPDATE "session" SET "status" = 'FAILED'::run_status WHERE "id" = $1::uuid`, [coordinator]);
    assert.deepEqual(await kinds(client, ids), ['session.failed']);

    // A soft delete is an UPDATE, and it is how a user deletes the conversation a project is
    // coordinated from.
    await clearEvents(client, ids);
    await client.query(`UPDATE "session" SET "deleted_at" = CURRENT_TIMESTAMP WHERE "id" = $1::uuid`, [coordinator]);
    assert.deepEqual(await kinds(client, ids), ['session.ended']);
    await clearEvents(client, ids);
    // Restoring it is not a second ending — the body's own asymmetric condition, unchanged.
    await client.query(`UPDATE "session" SET "deleted_at" = NULL WHERE "id" = $1::uuid`, [coordinator]);
    assert.deepEqual(await events(client, ids), []);

    // merge_status: success, both spellings of failure, and the queued state that is neither.
    for (const [status, expected] of [
      ['merged', ['merge.succeeded']],
      ['pending', []],
      ['conflict', ['merge.conflict']],
      ['error', ['merge.conflict']],
    ] as Array<[string, string[]]>) {
      await clearEvents(client, ids);
      await client.query(`UPDATE "session" SET "merge_status" = $2, "merge_error" = $3 WHERE "id" = $1::uuid`, [
        session,
        status,
        status === 'merged' || status === 'pending' ? null : `${status} detail`,
      ]);
      assert.deepEqual(await kinds(client, ids), expected, `merge_status ${status}`);
    }
    // A merge_error that moves on its own has no event, exactly as before: the body only ever
    // reads it as payload for a merge_status change.
    await clearEvents(client, ids);
    await client.query(`UPDATE "session" SET "merge_error" = 'restated' WHERE "id" = $1::uuid`, [session]);
    assert.deepEqual(await events(client, ids), []);

    // DELETE — unconditional, for the task's project and for the coordinated one.
    await clearEvents(client, ids);
    await client.query(`DELETE FROM "session" WHERE "id" = $1::uuid`, [session]);
    assert.deepEqual(await kinds(client, ids), ['session.ended']);
    // Hard-deleting the coordinator also empties the pointer — `coordinator_session_id` is
    // ON DELETE SET NULL — so the project row is updated inside the same transaction. That is
    // 0117's project producer speaking (`user.project_edited`), alongside the one `session.ended`
    // that this trigger and 0126's pointer trigger collapse onto under a shared dedupe key.
    await clearEvents(client, ids);
    await client.query(`DELETE FROM "session" WHERE "id" = $1::uuid`, [coordinator]);
    assert.deepEqual(await kinds(client, ids), ['session.ended', 'user.project_edited']);
  } finally {
    await client.end();
  }
});

test('the Session row and its Project signal still commit or roll back together', { skip }, async () => {
  const client = await connect();
  try {
    const ids = await seed(client, 'scope-atomic');
    const session = ids.telemetrySessionId;

    await client.query('BEGIN');
    await client.query(`UPDATE "session" SET "status" = 'FAILED'::run_status WHERE "id" = $1::uuid`, [session]);
    assert.deepEqual(await kinds(client, ids), ['session.failed'], 'the signal is not written with the row');
    await client.query('ROLLBACK');
    assert.deepEqual(await events(client, ids), [], 'a rolled-back status change left an orphan signal');
    const { rows } = await client.query<{ status: string }>(
      `SELECT "status"::text AS status FROM "session" WHERE "id" = $1::uuid`,
      [session],
    );
    assert.equal(rows[0].status, 'RUNNING');

    // The other direction: a signal that cannot be written must take its business row with it.
    // NOT VALID: the rows earlier tests left behind are not what this is about — only the row
    // the next statement tries to write.
    await client.query(
      `ALTER TABLE "project_event"
         ADD CONSTRAINT "reject_merge_succeeded" CHECK ("kind" <> 'merge.succeeded') NOT VALID`,
    );
    try {
      await assert.rejects(
        client.query(`UPDATE "session" SET "merge_status" = 'merged' WHERE "id" = $1::uuid`, [session]),
        /reject_merge_succeeded/,
      );
      const { rows: merge } = await client.query<{ merge_status: string | null }>(
        `SELECT "merge_status" FROM "session" WHERE "id" = $1::uuid`,
        [session],
      );
      assert.equal(merge[0].merge_status, null);
    } finally {
      await client.query(`ALTER TABLE "project_event" DROP CONSTRAINT "reject_merge_succeeded"`);
    }
  } finally {
    await client.end();
  }
});

test('0130 re-applies cleanly and leaves exactly the two declared triggers', { skip }, async () => {
  const client = await connect();
  try {
    // Applied once by `prisma migrate deploy`; twice more here. Nothing it contains depends on
    // the state it finds.
    await client.query(NARROWED);
    await client.query(NARROWED);

    const { rows } = await client.query<{ tgname: string; def: string }>(
      `SELECT t.tgname, pg_get_triggerdef(t.oid) AS def
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relname = 'session' AND NOT t.tgisinternal
          AND t.tgname LIKE 'project_session_event_source%'
        ORDER BY t.tgname`,
    );
    assert.deepEqual(
      rows.map((row) => row.tgname),
      ['project_session_event_source', 'project_session_event_source_update'],
    );
    assert.match(rows[0].def, /AFTER INSERT OR DELETE ON public\.session/);
    assert.doesNotMatch(rows[0].def, /UPDATE/);
    assert.match(rows[1].def, /AFTER UPDATE OF status, deleted_at, merge_status ON public\.session/);
    assert.match(
      rows[1].def,
      /WHEN \(\(\(old\.status IS DISTINCT FROM new\.status\) OR \(old\.deleted_at IS DISTINCT FROM new\.deleted_at\) OR \(old\.merge_status IS DISTINCT FROM new\.merge_status\)\)\)/,
    );

    // And it still behaves after being re-applied.
    const ids = await seed(client, 'scope-rerun');
    for (const write of telemetryWrites(ids, new Date('2026-08-22T05:00:00.000Z'))) {
      await client.query(write.sql, write.values as never);
    }
    assert.deepEqual(await events(client, ids), []);
    await client.query(`UPDATE "session" SET "status" = 'FAILED'::run_status WHERE "id" = $1::uuid`, [
      ids.telemetrySessionId,
    ]);
    assert.deepEqual(await kinds(client, ids), ['session.failed']);
  } finally {
    await client.end();
  }
});
