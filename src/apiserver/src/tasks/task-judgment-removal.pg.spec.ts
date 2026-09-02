import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import {
  DROPPED_CORE_TASK_TRIGGERS,
  DROPPED_JUDGMENT_FUNCTIONS,
  DROPPED_JUDGMENT_TABLES,
  DROPPED_JUDGMENT_VIEWS,
} from './task-judgment-removal.spec';

/**
 * What a migrated server actually has after 0227 — the other half of `task-judgment-removal.spec`.
 *
 * The source scan cannot see a relation that still exists because a migration forgot to drop it,
 * and it cannot see a preserved function that a `CREATE OR REPLACE` quietly rewrote. This asks the
 * catalogue.
 */

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

const MIGRATIONS = path.resolve(__dirname, '../../prisma/migrations');

/**
 * The body the append-only ledger DECLARES for a function, as of its last definition.
 *
 * "Unchanged" needs a baseline that is content rather than a remembered digest, and the migration
 * that last wrote a function is immutable — so comparing the installed body against it says
 * exactly "0227 did not rewrite this", before a merge and after one.
 */
function declaredBody(name: string): { dir: string; body: string } {
  let found: { dir: string; body: string } | null = null;
  for (const dir of readdirSync(MIGRATIONS).filter((entry) => /^\d{4}_/.test(entry)).sort()) {
    let sql: string;
    try {
      sql = readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
    } catch {
      continue;
    }
    const pattern = new RegExp(`CREATE (?:OR REPLACE )?FUNCTION "?${name}"?\\s*\\(`, 'g');
    let match = pattern.exec(sql);
    while (match) {
      const open = sql.indexOf('AS $$', match.index);
      const close = open < 0 ? -1 : sql.indexOf('$$', open + 5);
      if (open >= 0 && close > open) found = { dir, body: sql.slice(open + 5, close) };
      match = pattern.exec(sql);
    }
  }
  assert.ok(found, `no migration declares ${name}`);
  return found;
}

async function installedBody(client: Client, name: string): Promise<string> {
  const rows = (await client.query<{ src: string }>(
    `SELECT p.prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = $1`, [name],
  )).rows;
  assert.equal(rows.length, 1, `${name} must be installed exactly once`);
  return rows[0].src;
}

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  return client;
}

// (a) --------------------------------------------------------------------------------------------
suite('(a) none of the five judgment relations, or their two views, exists', async (t) => {
  const client = await connect();
  t.after(async () => { await client.end(); });
  const present = (await client.query<{ relname: string; relkind: string }>(
    `SELECT c.relname, c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) ORDER BY 1`,
    [[...DROPPED_JUDGMENT_TABLES, ...DROPPED_JUDGMENT_VIEWS]],
  )).rows;
  assert.deepEqual(present, []);

  // Nor anything else named after the machine, by any relkind — an index or sequence left behind
  // would mean a table survived under another name.
  const anyJudgment = (await client.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname ~ 'judgment' ORDER BY 1`,
  )).rows.map((row) => row.relname);
  assert.deepEqual(anyJudgment, []);
});

// (b) --------------------------------------------------------------------------------------------
suite('(b) the eight functions, their triggers, and the three on the core task table are gone',
  async (t) => {
    const client = await connect();
    t.after(async () => { await client.end(); });

    const functions = (await client.query<{ proname: string }>(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = ANY($1::text[]) ORDER BY 1`,
      [[...DROPPED_JUDGMENT_FUNCTIONS]],
    )).rows.map((row) => row.proname);
    assert.deepEqual(functions, [], 'every removed function must be absent, listed by name');

    const triggers = (await client.query<{ name: string }>(
      `SELECT c.relname || '::' || t.tgname AS name
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND (t.tgname ~ 'judgment' OR c.relname ~ 'judgment')
        ORDER BY 1`,
    )).rows.map((row) => row.name);
    assert.deepEqual(triggers, []);

    // Named individually, because these three sat on `task` itself and a leftover would fire on
    // every ordinary task write in production.
    for (const trigger of DROPPED_CORE_TASK_TRIGGERS) {
      const found = await client.query(
        `SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          WHERE c.relname = 'task' AND t.tgname = $1`, [trigger],
      );
      assert.equal(found.rowCount, 0, `task still carries ${trigger}`);
    }

    // No function body anywhere may still name one of the removed relations: a dangling body is a
    // production error on the first write that reaches it, and compiles perfectly until then.
    const dangling = (await client.query<{ proname: string }>(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosrc ~ $1 ORDER BY 1`,
      [[...DROPPED_JUDGMENT_TABLES, ...DROPPED_JUDGMENT_VIEWS].join('|')],
    )).rows.map((row) => row.proname);
    assert.deepEqual(dangling, []);
  });

// (m)(q)(w) --------------------------------------------------------------------------------------
suite('(m)(q)(w) VERIFICATION, the 0150/0172 gate and the core task triggers are intact',
  async (t) => {
    const client = await connect();
    t.after(async () => { await client.end(); });

    // (m) 0141's atomic verdict pair. Present, and on the table they have always been on.
    const atomic = (await client.query<{ name: string; fn: string }>(
      `SELECT t.tgname AS name, p.proname AS fn
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE NOT t.tgisinternal AND c.relname = 'task'
          AND t.tgname IN ('task_verification_verdict_atomic_insert',
                           'task_verification_verdict_atomic_update')
        ORDER BY 1`,
    )).rows;
    assert.deepEqual(atomic, [
      { name: 'task_verification_verdict_atomic_insert', fn: 'task_verification_verdict_atomic' },
      { name: 'task_verification_verdict_atomic_update', fn: 'task_verification_verdict_atomic' },
    ]);
    // And its body is byte for byte the one the ledger declares — which is what "unchanged"
    // means when the baseline has to be content rather than a remembered digest.
    for (const preserved of [
      'task_verification_verdict_atomic',
      'task_verification_carrier_status_derive',
      'project_acceptance_done_gate',
      'project_acceptance_advance_epoch',
      'project_acceptance_epoch_audit',
      'project_acceptance_criteria_fact',
    ]) {
      const declared = declaredBody(preserved);
      assert.equal(await installedBody(client, preserved), declared.body,
        `${preserved} differs from the body ${declared.dir} declares; 0227 rewrote it`);
      assert.doesNotMatch(declared.body, /judgment/u,
        `${preserved} names a judgment relation, so it cannot have survived untouched`);
    }

    // The one function 0227 DOES rewrite, and the only one: the DONE writer fence, which loses
    // its judgment lane and keeps the other four.
    const fence = await installedBody(client, 'task_done_canonical_writer_fence');
    assert.doesNotMatch(fence, /task_judgment_request/u);
    assert.equal(fence, declaredBody('task_done_canonical_writer_fence').body);

    // The verdict -> carrier DONE projection, which is what actually completes a VERIFICATION.
    const derive = (await client.query(
      `SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND c.relname = 'task'
          AND t.tgname IN ('task_verification_carrier_status_derive_insert',
                           'task_verification_carrier_status_derive_update')`,
    ));
    assert.equal(derive.rowCount, 2);

    // (q) 0150's three and 0172's one, on `project`, in the alphabetical order that makes
    // `advance_epoch` pin the epoch the `done_gate` then reads.
    const gate = (await client.query<{ tgname: string }>(
      `SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND c.relname = 'project'
          AND t.tgname LIKE 'project_acceptance%'
        ORDER BY t.tgname`,
    )).rows.map((row) => row.tgname);
    assert.deepEqual(gate, [
      'project_acceptance_advance_epoch',
      'project_acceptance_criteria_fact',
      'project_acceptance_done_gate',
      'project_acceptance_epoch_audit',
    ]);
    assert.ok(gate.indexOf('project_acceptance_advance_epoch')
      < gate.indexOf('project_acceptance_done_gate'),
      'PostgreSQL fires BEFORE ROW triggers in name order; advance_epoch must still precede the gate');

    // (w) the core table still carries every trigger it did, minus exactly the three removed here.
    const taskTriggers = (await client.query<{ tgname: string }>(
      `SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND c.relname = 'task' ORDER BY t.tgname`,
    )).rows.map((row) => row.tgname);
    // Measured on the merged base (origin/main a6c02b35, ledger through 0227): 27 triggers on
    // `task`, of which this change removes exactly the three below.
    assert.equal(taskTriggers.length, 24,
      `task carries ${taskTriggers.length} triggers: ${taskTriggers.join(', ')}`);
    for (const removed of DROPPED_CORE_TASK_TRIGGERS) {
      assert.ok(!taskTriggers.includes(removed));
    }
    for (const kept of ['task_done_canonical_writer_fence', 'task_dispatch_epoch_update',
      'task_verdict_revoked_on_reopen', 'task_supersession_guard_update',
      'task_verification_subject_guard']) {
      assert.ok(taskTriggers.includes(kept), `task lost ${kept}, which this change never named`);
    }
  });

// (r) --------------------------------------------------------------------------------------------
suite('(r) the project DONE gate still refuses a hand-written DONE at epoch zero', async (t) => {
  const client = await connect();
  t.after(async () => { await client.end(); });
  await client.query('TRUNCATE "user" RESTART IDENTITY CASCADE');
  const owner = '00000000-0000-7000-8000-0000000000e1';
  const project = '00000000-0000-7000-8000-0000000000e2';
  await client.query(
    `INSERT INTO "user" (id, email, name, password_hash) VALUES ($1, $2, 'gate', 'x')`,
    [owner, `${owner}@gate.invalid`],
  );
  await client.query(
    `INSERT INTO "project" (id, owner_id, title, updated_at) VALUES ($1, $2, 'gate', now())`,
    [project, owner],
  );
  await assert.rejects(
    client.query(
      `UPDATE "project" SET "status" = 'DONE', "acceptance_epoch" = 0 WHERE "id" = $1`, [project],
    ),
    /ACCEPTANCE_MISSING|ACCEPTANCE_EVIDENCE_STALE|ACCEPTANCE_BLOCKED/,
  );
  const after = await client.query<{ status: string }>(
    `SELECT "status"::text FROM "project" WHERE "id" = $1`, [project],
  );
  assert.equal(after.rows[0].status, 'OPEN');
});

// (e)(g) -----------------------------------------------------------------------------------------
suite('(e)(g) the 0177 declaration and all three criterion labels survive the removal', async (t) => {
  const client = await connect();
  t.after(async () => { await client.end(); });

  const columns = (await client.query<{
    column_name: string; data_type: string; is_nullable: string; column_default: string | null;
  }>(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'task'
        AND column_name IN ('acceptance_command', 'acceptance_expected_exit_code')
      ORDER BY column_name`,
  )).rows;
  assert.deepEqual(columns, [
    {
      column_name: 'acceptance_command', data_type: 'text',
      is_nullable: 'YES', column_default: null,
    },
    {
      column_name: 'acceptance_expected_exit_code', data_type: 'integer',
      is_nullable: 'YES', column_default: null,
    },
  ]);

  // The CHECK, byte for byte as 0177 wrote it: both halves or neither, non-blank, MANUAL policy,
  // and not on a verifier.
  const check = (await client.query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'task_executable_acceptance_pair'`,
  )).rows;
  assert.equal(check.length, 1, 'the 0177 pair CHECK must still exist');
  assert.equal(
    check[0].def,
    'CHECK ((((acceptance_command IS NULL) AND (acceptance_expected_exit_code IS NULL)) OR '
    + '((acceptance_command IS NOT NULL) AND (btrim(acceptance_command) <> \'\'::text) AND '
    + '(acceptance_expected_exit_code IS NOT NULL) AND (completion_policy = '
    + '\'MANUAL\'::task_completion_policy) AND (verifies_task_id IS NULL))))',
  );

  const labels = (await client.query<{ labels: string }>(
    `SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels
       FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'task_completion_criterion'`,
  )).rows[0].labels;
  assert.equal(labels, 'EXECUTABLE,VERIFICATION,EVIDENCE_JUDGMENT');
});
