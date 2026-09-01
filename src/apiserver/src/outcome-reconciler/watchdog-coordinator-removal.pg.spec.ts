import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Client } from 'pg';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';

/**
 * The catalog half of the 0221 removal, against a real PostgreSQL that replayed every migration.
 *
 * `watchdog-coordinator-removal.spec.ts` reads the migration text; this reads the server. They can
 * disagree — a `CREATE OR REPLACE` in a later file, a cascade nobody named, a column an ALTER left
 * behind — and only the server settles which of the two describes the database that exists.
 *
 * The other half of its job is the load-bearing walls standing beside what was removed. Each one
 * is checked positively: present, shaped as before, and still writable.
 */

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;
const RUN = randomUUID().slice(0, 8);

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  return client;
}

async function columnsOf(client: Client, table: string): Promise<string[]> {
  const { rows } = await client.query(`
    SELECT a.attname FROM pg_attribute a
     WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attname`, [table]);
  return rows.map((row) => row.attname as string);
}

// (a) ---------------------------------------------------------------------------------------------
suite('(a) the installed database has no watchdog or persistent-coordinator object left',
  async (t) => {
    const client = await connect();
    t.after(async () => { await client.end(); });

    const schema = await client.query(
      `SELECT nspname FROM pg_namespace WHERE nspname = 'outcome_watchdog'`);
    assert.deepEqual(schema.rows, [], 'the watchdog schema and everything in it must be gone');

    const relations = await client.query(`
      SELECT n.nspname || '.' || c.relname AS name, c.relkind::text AS kind
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r','v','m','S')
         AND (c.relname LIKE 'outcome\\_coordinator\\_%'
              OR c.relname LIKE 'executable\\_runtime\\_binding%'
              OR c.relname = 'executable_runtime_current_binding')
       ORDER BY 1`);
    assert.deepEqual(relations.rows, []);

    const functions = await client.query(`
      SELECT n.nspname || '.' || p.proname AS name
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT IN ('pg_catalog','information_schema')
         AND p.proname IN (
           'outcome_advance_coordinator_clock', 'outcome_append_coordinator_event',
           'outcome_apply_coordinator_failure', 'outcome_claim_next_coordination',
           'outcome_coordinator_liveness_audit', 'outcome_coordinator_now',
           'outcome_coordinator_owner_request_binding_trigger',
           'outcome_decide_coordinator_owner_request', 'outcome_deliver_coordinator_wake',
           'outcome_reconcile_active_obligations', 'outcome_record_coordinator_result',
           'outcome_register_coordinator_obligation', 'outcome_renew_coordinator_lease',
           'outcome_request_coordinator_owner_decision', 'outcome_schedule_coordinator_wake',
           'outcome_sweep_coordinator', 'outcome_terminalize_coordination',
           'executable_runtime_register_current_binding',
           'executable_runtime_append_current_heartbeat')
       ORDER BY 1`);
    assert.deepEqual(functions.rows, []);

    // Nothing that stays may still reach for one of them: a plpgsql body naming a dropped relation
    // compiles fine and fails on first call, which is the whole failure mode this suite exists for.
    const danglingBodies = await client.query(`
      SELECT n.nspname || '.' || p.proname AS name
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND p.prokind IN ('f','p')
         AND (p.prosrc LIKE '%outcome\\_coordinator\\_%' OR p.prosrc LIKE '%outcome\\_watchdog.%'
              OR p.prosrc LIKE '%executable\\_runtime\\_binding%'
              OR p.prosrc LIKE '%executable\\_runtime\\_current\\_binding%')
       ORDER BY 1`);
    assert.deepEqual(danglingBodies.rows, []);

    const triggers = await client.query(`
      SELECT c.relname || '.' || t.tgname AS name
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE NOT t.tgisinternal
         AND (t.tgname LIKE 'outcome\\_coordinator\\_%' OR t.tgname LIKE 'outcome\\_watchdog\\_%'
              OR t.tgname LIKE 'executable\\_runtime\\_binding%')
       ORDER BY 1`);
    assert.deepEqual(triggers.rows, []);

    const indexes = await client.query(`
      SELECT indexname FROM pg_indexes
       WHERE indexname IN ('outcome_fact_stream_watchdog_recent_idx',
         'outcome_projection_reconciler_watchdog_sample_idx',
         'executable_runtime_heartbeat_binding_watermark_idx',
         'executable_runtime_heartbeat_binding_latest_idx')
       ORDER BY 1`);
    assert.deepEqual(indexes.rows, []);

    // 0206 widened a table that stays. The widening has to be gone with it, not left as two
    // permanently-null columns nothing can ever populate.
    const heartbeat = await columnsOf(client, 'executable_runtime_heartbeat');
    assert.equal(heartbeat.includes('runtime_binding_digest'), false);
    assert.equal(heartbeat.includes('runtime_binding_logical_time'), false);
    assert.ok(heartbeat.includes('heartbeat_digest') && heartbeat.includes('expectation_generation'),
      'the heartbeat ledger itself belongs to 0200 and stays');
  });

suite('(a) the surfaces 0206 replaced are restored, not dropped with it', async (t) => {
  const client = await connect();
  t.after(async () => { await client.end(); });

  // executable_runtime_liveness and executable_runtime_overlay_read_surface were created by 0200
  // and 0202 and only REPLACED by 0206, so they are not 0206's to remove. The DONE gate and
  // outcome_projection.read_surface still call the overlay through the same signature.
  const liveness = await client.query('SELECT * FROM executable_runtime_liveness LIMIT 1');
  assert.ok(Array.isArray(liveness.rows));
  const overlay = await client.query(
    `SELECT executable_runtime_overlay_read_surface(
       '{"schemaVersion":2,"staleness":"CURRENT","obligations":[],"doneGate":{"allowed":true}}'::jsonb,
       'DONE_GATE') AS payload`);
  assert.equal(overlay.rows[0].payload.doneGate.allowed, true,
    'with no stale runtime the overlay must pass the payload through untouched');

  // The metadata sanitizer 0220 built on outcome_watchdog.sanitize_payload keeps its behaviour
  // through the re-homed redaction chain: secrets out, structure intact, bounds still enforced.
  const sanitized = await client.query(
    `SELECT executable_runtime_sanitize_metadata($1::jsonb) AS value`,
    [JSON.stringify({ token: 'super-secret', note: 'Bearer abcdefghijklmnop', keep: 7 })]);
  assert.deepEqual(sanitized.rows[0].value,
    { token: '[REDACTED]', note: '[REDACTED]', keep: 7 });
  await assert.rejects(
    client.query(`SELECT executable_runtime_sanitize_metadata('[]'::jsonb)`),
    /EXECUTABLE_RUNTIME_METADATA_INVALID/);
});

// (d)(e)(f)(g) ------------------------------------------------------------------------------------
suite('(d)(e)(f)(g) every load-bearing wall beside the removal is still standing', async (t) => {
  const client = await connect();
  t.after(async () => { await client.end(); });

  // (d) the EXECUTABLE acceptance verdict mechanism.
  for (const [table, required] of [
    ['task_executable_admission', ['id', 'task_id', 'command_digest', 'decision']],
    ['task_executable_attempt', ['id', 'task_id', 'termination_kind', 'actual_exit_code']],
  ] as const) {
    const columns = await columnsOf(client, table);
    for (const column of required) {
      assert.ok(columns.includes(column), `${table}.${column} must survive the removal`);
    }
  }
  // Its sweeper is a 0200 database function and still resolves, even though the process that
  // called it on a timer went with the Compose services.
  assert.equal((await client.query(`
    SELECT count(*)::int AS count FROM pg_proc
     WHERE proname = 'executable_acceptance_mark_stale_attempts'`)).rows[0].count, 1);

  // (e) the failure continuation and successor decision.
  const failureTables = await client.query(`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND (c.relname LIKE 'failure\\_continuation\\_%' OR c.relname LIKE 'failure\\_successor\\_%')
     ORDER BY 1`);
  assert.ok(failureTables.rows.length >= 2,
    'the failure continuation and successor tables are a different decision and must remain');

  // (f) the obligation algebra and the canonical DONE gate, which belong to the sibling task.
  const algebra = await client.query(`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND c.relname IN ('outcome_fact_stream', 'outcome_fact_binding', 'outcome_active_obligation',
                         'outcome_obligation_revision', 'outcome_obligation_reduction',
                         'outcome_binding_transition', 'outcome_obsolete_obligation')
     ORDER BY 1`);
  assert.deepEqual(algebra.rows.map((row) => row.relname), [
    'outcome_active_obligation', 'outcome_binding_transition', 'outcome_fact_binding',
    'outcome_fact_stream', 'outcome_obligation_reduction', 'outcome_obligation_revision',
    'outcome_obsolete_obligation',
  ]);
  assert.equal((await client.query(`
    SELECT count(*)::int AS count FROM pg_proc WHERE proname = 'project_canonical_done_gate'`))
    .rows[0].count, 1, 'the canonical DONE gate is not this task to remove');

  // (g) project acceptance, untouched.
  const acceptance = await client.query(`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'project\\_acceptance\\_%'
     ORDER BY 1`);
  assert.ok(acceptance.rows.length >= 3);
  const runColumns = await columnsOf(client, 'project_acceptance_run');
  for (const column of ['id', 'project_id', 'verdict', 'criteria_snapshot', 'acceptance_epoch']) {
    assert.ok(runColumns.includes(column), `project_acceptance_run.${column} must be unchanged`);
  }
});

// (h) ---------------------------------------------------------------------------------------------
suite('(h) an ordinary task, session and run_event write still commits', async (t) => {
  const client = await connect();
  t.after(async () => { await client.end(); });

  const ownerId = randomUUID();
  const workspaceId = randomUUID();
  const taskId = randomUUID();
  const sessionId = randomUUID();
  await client.query('BEGIN');
  try {
    await client.query(
      `INSERT INTO "user" (id, email, password_hash, name)
       VALUES ($1::uuid, $2, 'x', 'removal probe')`,
      [ownerId, `watchdog-removal-${RUN}@example.test`]);
    await client.query(
      `INSERT INTO workspace (id, owner_id, name) VALUES ($1::uuid, $2::uuid, $3)`,
      [workspaceId, ownerId, `watchdog-removal-${RUN}`]);
    await client.query(
      `INSERT INTO task (id, owner_id, creator_type, creator_id, title, status, updated_at)
       VALUES ($1::uuid, $2::uuid, 'USER', $2::uuid, 'ordinary write after the removal', 'OPEN',
               now())`,
      [taskId, ownerId]);
    await client.query(
      `UPDATE task SET title = 'still writable' WHERE id = $1::uuid`, [taskId]);
    await client.query(
      `INSERT INTO session (id, owner_id, creator_id, task_id, workspace_id, title, prompt,
                            provider, status, dispatch_origin, starts_task_work, updated_at)
       VALUES ($1::uuid, $2::uuid, $2::uuid, $3::uuid, $4::uuid, 'probe', 'probe',
               'claude', 'PENDING', 'USER', true, now())`,
      [sessionId, ownerId, taskId, workspaceId]);
    await client.query(
      `UPDATE session SET status = 'RUNNING' WHERE id = $1::uuid`, [sessionId]);
    const event = await client.query(
      `INSERT INTO run_event (id, session_id, seq, type, payload)
       VALUES (gen_random_uuid(), $1::uuid, 1, 'stdout', '{"text":"ok"}'::jsonb)
       RETURNING ingested_at`, [sessionId]);
    assert.ok(event.rows[0].ingested_at instanceof Date,
      'run_event ingestion provenance is still owned by the database');
    const task = await client.query('SELECT title, status FROM task WHERE id = $1::uuid', [taskId]);
    assert.deepEqual(task.rows[0], { title: 'still writable', status: 'OPEN' });
  } finally {
    await client.query('ROLLBACK');
  }
});
