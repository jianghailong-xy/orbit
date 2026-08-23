import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { Client } from 'pg';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';

/**
 * 0137 is ATOMIC, and a failure leaves nothing behind.
 *
 * The migration creates three tables, backfills one of them from `task`, and installs six triggers
 * and three foreign keys. Every one of those objects is meaningless without the others — a
 * `task_dispatch_epoch` table whose seed trigger is missing silently stops naming new tasks, and a
 * receipt table with no effect marker beside it makes the marker's guarantee vanish — so a partial
 * application is not a degraded state, it is a wrong one. And a partial application is exactly what
 * a re-run meets: `migrate resolve --rolled-back` followed by `migrate deploy` replays the file
 * from the top, straight into `relation already exists`, with no way forward but hand surgery.
 *
 * The file therefore carries its own `BEGIN`/`COMMIT` rather than trusting the deployer to wrap it,
 * which is what 0130, 0131 and 0134 do for the same reason. This proves it against a real server:
 * the same SQL, made to fail at its last statement, must leave a database that has never heard of
 * it — and then the unmodified file must apply cleanly onto that database.
 *
 * Destructive by design: it DROPS 0137's objects and rebuilds them, so it needs a database of its
 * own. `scripts/project-pg-matrix.sh` gives every pg spec one.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const MIGRATION = readFileSync(
  path.join(__dirname, '../../prisma/migrations/0137_task_run_request_receipt/migration.sql'),
  'utf8',
);

/** Everything 0137 creates, by the question "is it there?". */
const OBJECTS = {
  tables: ['task_run_request', 'task_run_manual_trigger', 'task_dispatch_epoch'],
  triggers: [
    'task_dispatch_epoch_seed',
    'task_dispatch_epoch_update',
    'task_dispatch_epoch_edges_insert',
    'task_dispatch_epoch_edges_update',
    'task_dispatch_epoch_edges_delete',
  ],
  functions: [
    'task_dispatch_epoch_seed',
    'task_dispatch_epoch_advance',
    'task_dispatch_epoch_bump_update',
    'task_dispatch_epoch_bump_edges_insert',
    'task_dispatch_epoch_bump_edges_update',
    'task_dispatch_epoch_bump_edges_delete',
  ],
};

async function present(client: Client) {
  const tables = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [OBJECTS.tables],
  );
  const triggers = await client.query<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname = ANY($1::text[])`,
    [OBJECTS.triggers],
  );
  const functions = await client.query<{ proname: string }>(
    `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND proname = ANY($1::text[])`,
    [OBJECTS.functions],
  );
  return {
    tables: tables.rows.map((r) => r.table_name).sort(),
    triggers: [...new Set(triggers.rows.map((r) => r.tgname))].sort(),
    functions: [...new Set(functions.rows.map((r) => r.proname))].sort(),
  };
}

async function drop0137(client: Client) {
  for (const trigger of OBJECTS.triggers) {
    const on = trigger.includes('edges') ? 'task_dependency' : 'task';
    await client.query(`DROP TRIGGER IF EXISTS "${trigger}" ON "${on}"`);
  }
  await client.query('DROP TABLE IF EXISTS "task_run_request", "task_run_manual_trigger", "task_dispatch_epoch"');
  for (const fn of OBJECTS.functions) {
    await client.query(`DROP FUNCTION IF EXISTS "${fn}"() CASCADE`);
    await client.query(`DROP FUNCTION IF EXISTS "${fn}"(uuid[]) CASCADE`);
  }
}

test('a 0137 that fails part-way leaves nothing, and the unchanged file then applies',
  { skip, timeout: 180_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const client = new Client({ connectionString: URL!, connectionTimeoutMillis: 5_000 });
    await client.connect();
    await verifyCoordinatorPgIdentity(client);
    t.after(() => client.end().catch(() => undefined));

    // Back to a database that has never seen this migration, which is what the failure case has to
    // be measured from.
    await drop0137(client);
    assert.deepEqual(await present(client), { tables: [], triggers: [], functions: [] },
      'the fixture starts from a database without 0137');

    // The same SQL, made to fail at its last statement. Everything before it ran inside the
    // transaction the FILE opened, so the failure aborts all of it — and the `ROLLBACK` that
    // follows is what a deployer does with a statement that errored, not a crutch this test needs:
    // without the file's own `BEGIN` there would be nothing to roll back and every object above the
    // failure would already be committed.
    const doomed = MIGRATION.replace(/COMMIT;\s*$/, 'SELECT 1 / 0;\nROLLBACK;\n');
    assert.notEqual(doomed, MIGRATION, 'the fault has to actually be injected');
    const failure = await client.query(doomed).catch((e: Error) => e);
    assert.ok(failure instanceof Error, 'the injected fault must actually fail the migration');
    await client.query('ROLLBACK').catch(() => undefined);

    assert.deepEqual(await present(client), { tables: [], triggers: [], functions: [] },
      'a failed 0137 leaves NOTHING — no table, no trigger, no function to collide with on re-run');

    // ...and the file the repository ships applies onto exactly that database.
    await client.query(MIGRATION);
    const after = await present(client);
    assert.deepEqual(after.tables, [...OBJECTS.tables].sort());
    assert.deepEqual(after.triggers, [...OBJECTS.triggers].sort());
    assert.deepEqual(after.functions, [...OBJECTS.functions].sort());

    // The backfill is complete rather than partial: one epoch row per task, however many existed
    // before the migration ran.
    const seeded = await client.query<{ tasks: string; epochs: string }>(
      `SELECT (SELECT count(*) FROM "task")::text AS tasks,
              (SELECT count(*) FROM "task_dispatch_epoch")::text AS epochs`,
    );
    assert.equal(seeded.rows[0].epochs, seeded.rows[0].tasks,
      'every task has an epoch row, including the ones that existed before this migration');

    // Re-running the applied file is refused rather than half-applied. That is the honest contract:
    // this migration is atomic, NOT idempotent, and atomicity is what makes `migrate resolve
    // --rolled-back` + `migrate deploy` a safe pair — the rolled-back state has nothing in it.
    await assert.rejects(() => client.query(MIGRATION), /already exists/);
    // And the refusal aborted the transaction the file opened, exactly as the injected fault did —
    // which is the same guarantee seen from the other side: a re-run that meets an object it
    // already created leaves everything as it found it.
    await client.query('ROLLBACK');
    const unchanged = await present(client);
    assert.deepEqual(unchanged, after, 'and the refused re-run changed nothing');
  });
