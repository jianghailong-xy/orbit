import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { Client } from 'pg';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';

/**
 * Unit L2 — migration 0150 against a real PostgreSQL, because every claim it makes is the
 * DATABASE's rather than a code path's.
 *
 * None of this is testable any other way. "An interrupted apply can be retried" is a statement
 * about DDL that has half happened. "Deleting the project that OWNS a task is refused while
 * deleting the project it was NOTICED in is not" is two foreign keys' ON DELETE, on one table,
 * pointing at the same target. "A PASS from before the reopen is not the current one" is a trigger
 * refusing an UPDATE. And "a binary that has never heard of these columns still writes them
 * correctly" is only meaningful against a server, since the whole point is that no TypeScript is
 * involved.
 *
 * The pre-migration database is the REAL one: every migration below 0150, applied in order into a
 * schema of this spec's own. A hand-rolled subset of the tables would be a copy of the schema that
 * can drift from it, and the drift always favours the test.
 *
 * Skipped unless a disposable database is pointed at it, so `node --test` stays green on a laptop:
 *
 *   docker run -d --name pcc-l2-pg -e POSTGRES_PASSWORD=pccl2 -e POSTGRES_USER=pccl2_admin \
 *     -e POSTGRES_DB=pccl2_mig -p 127.0.0.1:55473:5432 postgres:16-alpine
 *   COORDINATOR_PG_URL=postgres://pccl2_admin:pccl2@127.0.0.1:55473/pccl2_mig \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pccl2_mig COORDINATOR_PG_EXPECTED_USER=pccl2_admin \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=<pg_control_system().system_identifier> \
 *   node --test build/projects/project-provenance-epoch.pg.spec.js
 */
const URL = process.env.COORDINATOR_PG_URL;

const MIGRATIONS = path.resolve(__dirname, '../../prisma/migrations');
const UNIT = '0150_task_provenance_project_acceptance_epoch';
const FORWARD = readFileSync(path.join(MIGRATIONS, UNIT, 'migration.sql'), 'utf8');
const BACKWARD = readFileSync(path.join(MIGRATIONS, UNIT, 'down.sql'), 'utf8');

/** Every migration this one lands on top of, in the order Prisma applies them. */
const PRIOR = readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^\d{4}_/.test(e.name) && e.name < UNIT)
  .map((e) => e.name)
  .sort();

const USER = '00000000-0000-7000-8000-00000000e001';
const OWNED = '00000000-0000-7000-8000-00000000a001';
const NOTICED = '00000000-0000-7000-8000-00000000a002';
const TASK = '00000000-0000-7000-8000-00000000b001';
const BARE_TASK = '00000000-0000-7000-8000-00000000b002';
const RUN = '00000000-0000-7000-8000-00000000c001';

type ClientCtor = new (config: { connectionString?: string }) => Client;

async function connect(schema: string): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  // Loaded lazily and only when a database was pointed at this file: a top-level import would turn
  // "skipped" into a module-resolution failure in a worktree with no node_modules.
  const { Client: Ctor } = (await import('pg')) as unknown as { Client: ClientCtor };
  const client = new Ctor({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  await client.query(`SET search_path TO ${schema}`);
  return client;
}

/**
 * Extensions are the one thing this spec touches outside its own schema, because they are
 * DATABASE-global: `CREATE EXTENSION IF NOT EXISTS` inside a scratch schema installs the operator
 * classes THERE, and the next run's `IF NOT EXISTS` then finds the extension present and skips —
 * leaving `gin_trgm_ops` unreachable from a search_path that no longer contains the schema it went
 * into. Pinned to `public` once, and moved there if a previous run put it somewhere else.
 */
async function pinExtensions(client: Client): Promise<void> {
  for (const name of ['pgcrypto', 'pg_trgm']) {
    const { rows } = await client.query<{ schema: string }>(
      `SELECT extnamespace::regnamespace::text AS schema FROM pg_extension WHERE extname = $1`,
      [name],
    );
    if (rows.length === 0) {
      await client.query(`CREATE EXTENSION IF NOT EXISTS ${name} WITH SCHEMA public`);
    } else if (rows[0].schema !== 'public') {
      await client.query(`ALTER EXTENSION ${name} SET SCHEMA public`);
    }
  }
}

/** The database as it stands the moment before 0150: the real chain, in its own schema. */
async function buildPreMigrationSchema(client: Client, schema: string): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.query(`CREATE SCHEMA ${schema}`);
  await pinExtensions(client);
  // `public` is on the path only while the chain runs, because 0068's index needs `gin_trgm_ops`
  // and the extension lives there. It comes OFF for everything after, which is how a deployment
  // actually runs — one schema, nothing else visible. The difference is not cosmetic: an
  // unqualified `DROP FUNCTION IF EXISTS` with `public` still on the path reaches out of this
  // scratch schema and finds the REAL deployment's function when its own has already gone.
  await client.query(`SET search_path TO ${schema}, public`);
  for (const name of PRIOR) {
    await client.query(readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
  }
  await client.query(`SET search_path TO ${schema}`);
}

/** The rows a real deployment has when the migration lands. Written BEFORE 0150 exists, by
 *  statements that could not have mentioned a single column it adds. `settle` binds the project's
 *  DONE to the run, which is the shape the upgrade test is judged on and the wrong starting point
 *  for the behavioural ones. */
async function seedPreMigrationHistory(client: Client, settle: boolean): Promise<void> {
  await client.query(
    `INSERT INTO "user"(id, email, name, password_hash) VALUES ($1, 'l2@example.test', 'l2', 'x')`,
    [USER],
  );
  for (const [id, title] of [[OWNED, 'owned'], [NOTICED, 'noticed']]) {
    await client.query(
      `INSERT INTO "project"(id, title, owner_id, updated_at, acceptance_criteria)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP, '1. it works')`,
      [id, title, USER],
    );
  }
  await client.query(
    `INSERT INTO "task"(id, title, owner_id, creator_type, creator_id, updated_at, project_id)
     VALUES ($1, 'work', $2, 'USER', $2, CURRENT_TIMESTAMP, $3)`,
    [TASK, USER, OWNED],
  );
  // A concluded acceptance and the DONE standing on it — the exact shape a project reaches today,
  // and the one whose survival this migration is judged on.
  await client.query(
    `INSERT INTO "project_acceptance_run"
       (id, project_id, attempt, criteria_snapshot, criteria_revision, input_digest, result_digest,
        decided_by, verdict, completed_at, digest_version)
     VALUES ($1, $2, 0, '1. it works', repeat('a',64), repeat('b',64), repeat('c',64),
             'COORDINATOR_AGENT', 'PASS', CURRENT_TIMESTAMP, 2)`,
    [RUN, OWNED],
  );
  if (settle) {
    await client.query(
      `UPDATE "project" SET status = 'DONE', accepted_run_id = $2 WHERE id = $1`, [OWNED, RUN],
    );
  }
}

/** A catalog fingerprint: what 0150 promises exists, in a form two applies can be compared on. */
async function fingerprint(client: Client, schema: string): Promise<string> {
  const { rows } = await client.query<{ line: string }>(
    `SELECT line FROM (
       SELECT 'column '||table_name||'.'||column_name||' '||data_type||' '||is_nullable||' '||
              COALESCE(column_default,'-') AS line
         FROM information_schema.columns
        WHERE table_schema = $1
          AND (column_name IN ('acceptance_epoch','discovered_from_project_id','trigger_event',
                               'source_task_id','source_session_id'))
       UNION ALL
       SELECT 'constraint '||conname||' '||pg_get_constraintdef(oid)
         FROM pg_constraint
        WHERE connamespace = $1::regnamespace
          AND conname IN ('task_discovered_from_project_id_fkey','task_source_task_id_fkey',
                          'task_source_session_id_fkey','task_trigger_event_chk',
                          'project_acceptance_epoch_chk','project_acceptance_run_epoch_chk',
                          'project_acceptance_audit_kind_chk')
       UNION ALL
       SELECT 'index '||indexname||' '||indexdef FROM pg_indexes
        WHERE schemaname = $1
          AND indexname IN ('task_discovered_from_project_idx','task_source_task_idx',
                            'task_source_session_idx','project_acceptance_run_epoch_idx')
       UNION ALL
       SELECT 'trigger '||tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relnamespace = $1::regnamespace AND NOT t.tgisinternal
          AND tgname IN ('task_provenance_immutable_guard','project_acceptance_advance_epoch',
                         'project_acceptance_epoch_audit','project_acceptance_run_epoch_guard',
                         'project_acceptance_done_gate')
     ) x ORDER BY line`,
    [schema],
  );
  return rows.map((r) => r.line).join('\n');
}

async function refusal(client: Client, sql: string, params: unknown[] = []): Promise<string> {
  await client.query('SAVEPOINT probe');
  try {
    await client.query(sql, params);
    await client.query('RELEASE SAVEPOINT probe');
    return '';
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT probe');
    return (e as Error).message;
  }
}

// ── 1 · Applying it ───────────────────────────────────────────────────────────────────────────

test('0150 applies to a database with history in it, and rewrites none of it', async (t) => {
  if (!URL) return t.skip('COORDINATOR_PG_URL not set');
  const schema = 'pccl2_l2_upgrade';
  const client = await connect('public');
  try {
    await buildPreMigrationSchema(client, schema);
    await seedPreMigrationHistory(client, true);

    const before = await client.query(
      `SELECT status::text AS status, accepted_run_id, legacy_accepted_at, updated_at
         FROM "project" WHERE id = $1`, [OWNED],
    );
    await client.query(FORWARD);

    const after = await client.query(
      `SELECT status::text AS status, accepted_run_id, legacy_accepted_at, updated_at,
              acceptance_epoch FROM "project" WHERE id = $1`, [OWNED],
    );
    assert.equal(after.rows[0].status, 'DONE', 'a DONE that stood before the migration still stands');
    assert.equal(after.rows[0].accepted_run_id, before.rows[0].accepted_run_id);
    assert.deepEqual(after.rows[0].updated_at, before.rows[0].updated_at,
      'the migration touched no row: `updated_at` is the tell');
    assert.equal(after.rows[0].acceptance_epoch, '0', 'existing projects start in epoch 0');

    const run = await client.query(
      `SELECT acceptance_epoch, verdict::text AS verdict, superseded_at
         FROM "project_acceptance_run" WHERE id = $1`, [RUN],
    );
    assert.equal(run.rows[0].acceptance_epoch, '0', 'existing runs start in epoch 0 — they match');
    assert.equal(run.rows[0].verdict, 'PASS');
    assert.equal(run.rows[0].superseded_at, null, 'the migration retires nothing');

    const tasks = await client.query(
      `SELECT discovered_from_project_id, trigger_event, source_task_id, source_session_id
         FROM "task" WHERE id = $1`, [TASK],
    );
    assert.deepEqual(tasks.rows[0], {
      discovered_from_project_id: null, trigger_event: null,
      source_task_id: null, source_session_id: null,
    }, 'a task that predates provenance records none — absence, not a guess');

    // ── 2 · An interrupted apply, retried ────────────────────────────────────────────────────
    const once = await fingerprint(client, schema);
    assert.ok(once.includes('column task.discovered_from_project_id'), 'the fingerprint sees 0150');
    await client.query(FORWARD);
    assert.equal(await fingerprint(client, schema), once,
      're-running 0150 reaches the same state; nothing is added twice and nothing fails');
    const stillDone = await client.query(
      `SELECT status::text AS status, acceptance_epoch FROM "project" WHERE id = $1`, [OWNED],
    );
    assert.deepEqual(stillDone.rows[0], { status: 'DONE', acceptance_epoch: '0' });

    // ── 3 · Rolling back, and going forward again ────────────────────────────────────────────
    await client.query(BACKWARD);
    const rolledBack = await fingerprint(client, schema);
    assert.ok(!rolledBack.includes('column task.discovered_from_project_id'),
      'the provenance columns are gone');
    assert.ok(!rolledBack.includes('column project.acceptance_epoch'), 'the epoch is gone');
    assert.ok(rolledBack.includes('constraint project_acceptance_audit_kind_chk'),
      '0127\'s audit CHECK survives — the rollback narrows nothing it did not widen');
    const survived = await client.query(
      `SELECT status::text AS status, accepted_run_id FROM "project" WHERE id = $1`, [OWNED],
    );
    assert.deepEqual(survived.rows[0], { status: 'DONE', accepted_run_id: RUN },
      'rolling back destroys the columns 0150 added and nothing else');
    await client.query(BACKWARD);
    assert.equal(await fingerprint(client, schema), rolledBack, 'down.sql is re-runnable too');

    await client.query(FORWARD);
    assert.equal(await fingerprint(client, schema), once, 'forward again lands where it did before');
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await client.end();
  }
});

// ── 4 · A fresh server, and everything the migration then refuses ─────────────────────────────

test('0150 on a fresh PostgreSQL: the objects, and the rules they carry', async (t) => {
  if (!URL) return t.skip('COORDINATOR_PG_URL not set');
  const schema = 'pccl2_l2_fresh';
  const client = await connect('public');
  try {
    await buildPreMigrationSchema(client, schema);
    await client.query(FORWARD);

    await t.test('every object 0150 promises exists', async () => {
      const state = await fingerprint(client, schema);
      for (const expected of [
        'column task.discovered_from_project_id',
        'column task.trigger_event',
        'column task.source_task_id',
        'column task.source_session_id',
        'column project.acceptance_epoch',
        'column project_acceptance_run.acceptance_epoch',
        'constraint task_discovered_from_project_id_fkey',
        'constraint task_source_task_id_fkey',
        'constraint task_source_session_id_fkey',
        'constraint task_trigger_event_chk',
        'index task_discovered_from_project_idx',
        'index task_source_task_idx',
        'index task_source_session_idx',
        'index project_acceptance_run_epoch_idx',
        'trigger task_provenance_immutable_guard',
        'trigger project_acceptance_advance_epoch',
        'trigger project_acceptance_epoch_audit',
        'trigger project_acceptance_run_epoch_guard',
      ]) {
        assert.ok(state.includes(expected), `missing: ${expected}`);
      }
      assert.match(state, /acceptance_epoch bigint NO 0/, 'the epoch is NOT NULL DEFAULT 0');
    });

    await t.test('the provenance indexes are partial, and cover their foreign keys', async () => {
      const { rows } = await client.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE schemaname = $1 AND indexname LIKE 'task_%'
            AND indexname IN ('task_discovered_from_project_idx','task_source_task_idx','task_source_session_idx')
          ORDER BY indexname`, [schema],
      );
      assert.equal(rows.length, 3);
      for (const row of rows) {
        assert.match(row.indexdef, /WHERE .* IS NOT NULL/,
          `${row.indexname} must be partial — most tasks carry no provenance and belong in none of these`);
      }
    });

    // Seeded UNSETTLED: the behavioural tests below each drive their own transition, and a project
    // that arrived already reopened would start them all in epoch 1.
    await seedPreMigrationHistory(client, false);

    await t.test('authority refuses the delete; evidence absorbs it', async () => {
      await client.query('BEGIN');
      try {
        await client.query(
          `UPDATE "task" SET project_id = $2 WHERE id = $1`, [TASK, OWNED],
        );
        await client.query(
          `INSERT INTO "task"(id, title, owner_id, creator_type, creator_id, updated_at,
                              project_id, discovered_from_project_id, trigger_event)
           VALUES ($1, 'noticed elsewhere', $2, 'USER', $2, CURRENT_TIMESTAMP, $3, $4, 'task.verdict_failed')`,
          [BARE_TASK, USER, OWNED, NOTICED],
        );
        const owning = await refusal(client, `DELETE FROM "project" WHERE id = $1`, [OWNED]);
        assert.match(owning, /violates foreign key constraint "task_project_id_fkey"/,
          'deleting the project that OWNS work must be refused — that is what authority means');

        await client.query(`DELETE FROM "project" WHERE id = $1`, [NOTICED]);
        const { rows } = await client.query(
          `SELECT project_id, discovered_from_project_id, trigger_event FROM "task" WHERE id = $1`,
          [BARE_TASK],
        );
        assert.equal(rows[0].project_id, OWNED, 'the authoritative column is untouched');
        assert.equal(rows[0].discovered_from_project_id, null, 'the evidence emptied instead of refusing');
        assert.equal(rows[0].trigger_event, 'task.verdict_failed',
          'what survives is the absence of the id, not the absence of the note');
      } finally {
        await client.query('ROLLBACK');
      }
    });

    await t.test('provenance is written once: no rewrite, no retrofit', async () => {
      await client.query('BEGIN');
      try {
        await client.query(
          `INSERT INTO "task"(id, title, owner_id, creator_type, creator_id, updated_at,
                              project_id, discovered_from_project_id, trigger_event)
           VALUES ($1, 'noticed elsewhere', $2, 'USER', $2, CURRENT_TIMESTAMP, $3, $4, 'task.verdict_failed')`,
          [BARE_TASK, USER, OWNED, NOTICED],
        );
        const rewrite = await refusal(
          client, `UPDATE "task" SET discovered_from_project_id = $2 WHERE id = $1`, [BARE_TASK, OWNED],
        );
        assert.match(rewrite, /TASK_PROVENANCE_IMMUTABLE/, 'evidence that can be edited is testimony');
        const retrofit = await refusal(
          client, `UPDATE "task" SET trigger_event = 'backfilled' WHERE id = $1`, [TASK],
        );
        assert.match(retrofit, /TASK_PROVENANCE_IMMUTABLE/,
          'evidence cannot be attached to a write that has already happened');

        // A handoff — L4's declared crossing — moves the authoritative column and leaves these.
        await client.query(`UPDATE "task" SET project_id = $2 WHERE id = $1`, [BARE_TASK, OWNED]);
        const { rows } = await client.query(
          `SELECT project_id, discovered_from_project_id FROM "task" WHERE id = $1`, [BARE_TASK],
        );
        assert.equal(rows[0].project_id, OWNED);
        assert.equal(rows[0].discovered_from_project_id, NOTICED,
          'where the work was noticed did not change when it changed hands');
      } finally {
        await client.query('ROLLBACK');
      }
    });

    await t.test('a trigger event is a fact name, not a second description', async () => {
      await client.query('BEGIN');
      try {
        for (const bad of ['', '   ', 'x'.repeat(121)]) {
          const message = await refusal(
            client,
            `INSERT INTO "task"(id, title, owner_id, creator_type, creator_id, updated_at,
                                project_id, trigger_event)
             VALUES ($1, 't', $2, 'USER', $2, CURRENT_TIMESTAMP, $3, $4)`,
            [BARE_TASK, USER, OWNED, bad],
          );
          assert.match(message, /task_trigger_event_chk/, `"${bad.slice(0, 12)}" should be refused`);
        }
      } finally {
        await client.query('ROLLBACK');
      }
    });

    await t.test('a reopen advances the epoch, from either settled status', async () => {
      await client.query('BEGIN');
      try {
        for (const settled of ['DONE', 'CANCELLED']) {
          await client.query('SAVEPOINT round');
          // A DONE needs evidence; a CANCELLED does not. Use the legacy stamp for the DONE leg so
          // this test says one thing rather than re-testing the gate.
          await client.query(
            `UPDATE "project" SET status = $2::project_status,
                    legacy_accepted_at = CASE WHEN $2 = 'DONE' THEN CURRENT_TIMESTAMP ELSE NULL END
              WHERE id = $1`, [NOTICED, settled],
          );
          await client.query(`UPDATE "project" SET status = 'OPEN' WHERE id = $1`, [NOTICED]);
          const { rows } = await client.query(
            `SELECT acceptance_epoch FROM "project" WHERE id = $1`, [NOTICED],
          );
          assert.equal(rows[0].acceptance_epoch, '1',
            `${settled} -> OPEN must advance the epoch; the service's own branch only sees DONE`);
          await client.query('ROLLBACK TO SAVEPOINT round');
        }
      } finally {
        await client.query('ROLLBACK');
      }
    });

    await t.test('a PASS from a previous epoch is not the current acceptance', async () => {
      await client.query('BEGIN');
      try {
        await client.query(
          `UPDATE "project" SET status = 'DONE', accepted_run_id = $2 WHERE id = $1`, [OWNED, RUN],
        );
        // The route the service does not cover: put the project down, pick it up again.
        await client.query(`UPDATE "project" SET status = 'CANCELLED' WHERE id = $1`, [OWNED]);
        await client.query(`UPDATE "project" SET status = 'OPEN' WHERE id = $1`, [OWNED]);

        const project = await client.query(
          `SELECT acceptance_epoch, accepted_run_id FROM "project" WHERE id = $1`, [OWNED],
        );
        assert.equal(project.rows[0].acceptance_epoch, '1');

        const message = await refusal(
          client, `UPDATE "project" SET status = 'DONE' WHERE id = $1`, [OWNED],
        );
        assert.match(message, /ACCEPTANCE_EVIDENCE_STALE/);
        assert.match(message, /passed in epoch 0, and this project is now in epoch 1/);

        const run = await client.query(
          `SELECT verdict::text AS verdict, superseded_at, acceptance_epoch, completed_at
             FROM "project_acceptance_run" WHERE id = $1`, [RUN],
        );
        assert.equal(run.rows[0].verdict, 'PASS', 'the historical conclusion is not rewritten');
        assert.equal(run.rows[0].superseded_at, null, 'and it is not retired to say so either');
        assert.equal(run.rows[0].acceptance_epoch, '0', 'it keeps the epoch it was reached in');
      } finally {
        await client.query('ROLLBACK');
      }
    });

    await t.test('a legacy DONE stops buying a DONE once the project has been reopened', async () => {
      await client.query('BEGIN');
      try {
        await client.query(
          `UPDATE "project" SET status = 'DONE', legacy_accepted_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [NOTICED],
        );
        await client.query(`UPDATE "project" SET status = 'OPEN' WHERE id = $1`, [NOTICED]);
        const message = await refusal(
          client, `UPDATE "project" SET status = 'DONE' WHERE id = $1`, [NOTICED],
        );
        assert.match(message, /ACCEPTANCE_EVIDENCE_STALE/);
        assert.match(message, /reopened after its legacy DONE/);
        const { rows } = await client.query(
          `SELECT legacy_accepted_at IS NOT NULL AS stamped FROM "project" WHERE id = $1`, [NOTICED],
        );
        assert.equal(rows[0].stamped, true,
          'the stamp is kept and stops being honoured — clearing it would rewrite what the project was');
      } finally {
        await client.query('ROLLBACK');
      }
    });

    await t.test('nobody chooses the epoch: not a writer, not a run, not an old binary', async () => {
      await client.query('BEGIN');
      try {
        await client.query(`UPDATE "project" SET status = 'CANCELLED' WHERE id = $1`, [NOTICED]);
        await client.query(`UPDATE "project" SET status = 'OPEN' WHERE id = $1`, [NOTICED]);

        await client.query(`UPDATE "project" SET acceptance_epoch = 99 WHERE id = $1`, [NOTICED]);
        const project = await client.query(
          `SELECT acceptance_epoch FROM "project" WHERE id = $1`, [NOTICED],
        );
        assert.equal(project.rows[0].acceptance_epoch, '1', 'a writer-chosen epoch is overwritten');

        // The mixed-version case, literally: an INSERT that names the column and sends the value a
        // 0.1.131 binary would have left at its default.
        await client.query(
          `INSERT INTO "project_acceptance_run"
             (id, project_id, attempt, criteria_snapshot, criteria_revision, input_digest,
              decided_by, acceptance_epoch)
           VALUES ($1, $2, 7, '1. it works', repeat('a',64), repeat('b',64), 'COORDINATOR_AGENT', 0)`,
          ['00000000-0000-7000-8000-00000000c009', NOTICED],
        );
        const run = await client.query(
          `SELECT acceptance_epoch FROM "project_acceptance_run" WHERE id = $1`,
          ['00000000-0000-7000-8000-00000000c009'],
        );
        assert.equal(run.rows[0].acceptance_epoch, '1',
          'a run opened by a binary that has never heard of the column still lands in the current epoch');

        const frozen = await refusal(
          client, `UPDATE "project_acceptance_run" SET acceptance_epoch = 0 WHERE id = $1`,
          ['00000000-0000-7000-8000-00000000c009'],
        );
        assert.match(frozen, /ACCEPTANCE_RUN_IMMUTABLE/,
          'the epoch a run was opened in is the identity of the world it judged, not a field');
      } finally {
        await client.query('ROLLBACK');
      }
    });

    await t.test('a reopen still goes through the transactional outbox, and lands in the audit', async () => {
      await client.query('BEGIN');
      try {
        await client.query(`DELETE FROM "project_event" WHERE project_id = $1`, [NOTICED]);
        await client.query(`DELETE FROM "project_acceptance_audit" WHERE project_id = $1`, [NOTICED]);

        await client.query(`UPDATE "project" SET status = 'CANCELLED' WHERE id = $1`, [NOTICED]);
        await client.query(`UPDATE "project" SET status = 'OPEN' WHERE id = $1`, [NOTICED]);

        const events = await client.query<{ kind: string; occurrences: number; consumed_at: Date | null }>(
          `SELECT kind, occurrences, consumed_at FROM "project_event"
            WHERE project_id = $1 AND consumed_at IS NULL ORDER BY kind`, [NOTICED],
        );
        assert.deepEqual(events.rows.map((r) => r.kind), ['user.project_edited'],
          'the status change is still a dirty signal on the same outbox, in the same transaction');

        const audit = await client.query<{ kind: string; from_epoch: string; to_epoch: string }>(
          `SELECT kind, detail->>'fromEpoch' AS from_epoch, detail->>'toEpoch' AS to_epoch
             FROM "project_acceptance_audit"
            WHERE project_id = $1 AND kind = 'acceptance_epoch_advanced'`, [NOTICED],
        );
        assert.equal(audit.rows.length, 1);
        assert.equal(audit.rows[0].from_epoch, '0');
        assert.equal(audit.rows[0].to_epoch, '1');

        // A second reopen coalesces on the outbox's partial unique index — one unconsumed signal,
        // more occurrences — while the audit gains a second row, because two reopens are two facts.
        await client.query(`UPDATE "project" SET status = 'CANCELLED' WHERE id = $1`, [NOTICED]);
        await client.query(`UPDATE "project" SET status = 'OPEN' WHERE id = $1`, [NOTICED]);
        const again = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM "project_event"
            WHERE project_id = $1 AND consumed_at IS NULL`, [NOTICED],
        );
        assert.equal(again.rows[0].count, '1', 'redelivery does not become a second signal');
        const audits = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM "project_acceptance_audit"
            WHERE project_id = $1 AND kind = 'acceptance_epoch_advanced'`, [NOTICED],
        );
        assert.equal(audits.rows[0].count, '2', 'two reopens are two facts');
      } finally {
        await client.query('ROLLBACK');
      }
    });
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await client.end();
  }
});
