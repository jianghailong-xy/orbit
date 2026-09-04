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

  // (d) the EXECUTABLE acceptance verdict mechanism. 0221 was told not to touch 0200's admission
  // and attempt ledger and did not; migration 0227 removed that ledger outright by a later and
  // separate decision, and 0228 removed 0181's recorded command result by a third. What is left
  // of an EXECUTABLE task is 0177's declared pair — the half the account owner kept through all
  // three — so that is what this wall is checked against now.
  for (const [table, required] of [
    ['task', ['acceptance_command', 'acceptance_expected_exit_code']],
    ['task_completion_evidence', ['id', 'task_id', 'evidence', 'evidence_digest', 'revision']],
  ] as const) {
    const columns = await columnsOf(client, table);
    for (const column of required) {
      assert.ok(columns.includes(column), `${table}.${column} must survive the removal`);
    }
  }

  // (e) stood here: the failure continuation and successor tables, which 0221 was told not to
  // touch and did not. Migration 0226 removed them — a later decision about the failure router,
  // not a delayed effect of this one — so there is no relation left to count. What 0221 does to
  // them is still asserted where it belongs, over 0221's own frozen text.

  // (f) the obligation algebra and the canonical DONE gate were the sibling task's to keep or
  // remove, and it removed them in 0222. The assertion that used to stand here — that 0221 left
  // them installed — now belongs to that task's own removal spec; what remains checkable from
  // here is that 0221 names none of those relations, which the static spec asserts.

  // (g) project acceptance. The judging half went to 0229 — a later decision about the acceptance
  // judgment, not a delayed effect of this one — so what 0221 was told not to touch, and did not,
  // is the authored criterion definitions.
  const acceptance = await client.query(`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'project\\_acceptance\\_%'
     ORDER BY 1`);
  assert.deepEqual(acceptance.rows.map((row) => row.relname),
    ['project_acceptance_criterion_definition']);
  // `completion_criterion` stood in this list until migration 0233 removed it, with the three
  // wiring columns beside it — a later decision about which direction the criterion/work edge
  // points, not a delayed effect of this one. What 0221 was told not to touch is the authored
  // declaration, and that is what is checked.
  const definitionColumns = await columnsOf(client, 'project_acceptance_criterion_definition');
  for (const column of ['id', 'project_id', 'text', 'verification_method', 'content_hash']) {
    assert.ok(definitionColumns.includes(column),
      `project_acceptance_criterion_definition.${column} must be unchanged`);
  }
  for (const gone of ['completion_criterion', 'acceptance_command',
    'acceptance_expected_exit_code', 'evidence_task_id']) {
    assert.equal(definitionColumns.includes(gone), false,
      `project_acceptance_criterion_definition.${gone} was removed by migration 0233`);
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
      `INSERT INTO task (id, owner_id, creator_type, creator_id, title, status, updated_at, completion_criterion)
       VALUES ($1::uuid, $2::uuid, 'USER', $2::uuid, 'ordinary write after the removal', 'OPEN',
               now(), 'EVIDENCE_JUDGMENT')`,
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
