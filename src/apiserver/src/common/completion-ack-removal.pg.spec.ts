import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Client } from 'pg';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';

/**
 * The catalog half of the 0220 removal, against a real PostgreSQL that replayed every migration.
 *
 * `completion-ack-removal.spec.ts` reads the migration text; this reads the server. They can
 * disagree — a `CREATE OR REPLACE` in a later file, a cascade nobody named — and only the server
 * settles which of the two is describing the database that actually exists.
 */

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

/** The nine triggers the protocol installed on tables that stay. */
const CORE_TABLE_TRIGGERS: ReadonlyArray<[string, string]> = [
  ['task', 'task_completion_ack_remediation_action'],
  ['task', 'task_completion_ack_remediation_reactivation_guard'],
  ['task', 'zz_task_completion_ack_remediation_criterion_insert_guard'],
  ['task', 'zz_task_completion_ack_remediation_criterion_update_guard'],
  ['session', 'session_completion_ack_dispatch_insert_guard'],
  ['session', 'session_completion_ack_dispatch_revive_guard'],
  ['conversation_turn', 'conversation_turn_completion_ack_insert_guard'],
  ['conversation_turn', 'conversation_turn_completion_ack_lease_guard'],
  ['run_event', 'run_event_completion_ack_ingestion_guard'],
];

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  return client;
}

suite('(a) the installed database has no completion-ACK relation, function or view left', async (t) => {
  const client = await connect();
  t.after(async () => { await client.end(); });

  const relations = await client.query(`
    SELECT n.nspname || '.' || c.relname AS name, c.relkind::text AS kind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname ILIKE '%completion\\_ack%' AND c.relkind IN ('r','v','m','i','S')
     ORDER BY 1`);
  assert.deepEqual(relations.rows, [],
    'no table, view, index or sequence may still carry the protocol');

  const functions = await client.query(`
    SELECT n.nspname || '.' || p.proname AS name
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog','information_schema')
       AND (p.proname ILIKE '%completion\\_ack%' OR p.prosrc LIKE '%completion\\_ack%')
     ORDER BY 1`);
  assert.deepEqual(functions.rows, [],
    'no installed function may be named for, or still read, the removed protocol');

  const views = await client.query(`
    SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('v','m') AND pg_get_viewdef(c.oid) LIKE '%completion_ack%' ORDER BY 1`);
  assert.deepEqual(views.rows, [], 'no view may still read a dropped relation');

  const columns = await client.query(`
    SELECT table_name || '.' || column_name AS name FROM information_schema.columns
     WHERE column_name = 'completion_delivery_receipt_id'`);
  assert.deepEqual(columns.rows, [],
    'the coordinator attempt result must not keep its completion-ACK pointer');
});

suite('(b) the nine core-table triggers are gone and run_event keeps its own guard', async (t) => {
  const client = await connect();
  t.after(async () => { await client.end(); });

  const installed = await client.query(`
    SELECT c.relname AS "table", t.tgname AS "trigger"
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE NOT t.tgisinternal AND t.tgname ILIKE '%completion\\_ack%'
     ORDER BY 1, 2`);
  assert.deepEqual(installed.rows, [], 'no completion-ACK trigger may still be installed');

  for (const [table, trigger] of CORE_TABLE_TRIGGERS) {
    const present = await client.query(
      `SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND c.relname = $1 AND t.tgname = $2`,
      [table, trigger],
    );
    assert.equal(present.rowCount, 0, `${trigger} must be gone from ${table}`);
  }

  // `conversation_turn` carried only completion-ACK triggers, so it now carries none.
  const turnTriggers = await client.query(
    `SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname = 'conversation_turn' ORDER BY 1`);
  assert.deepEqual(turnTriggers.rows, [], 'conversation_turn is left with no user trigger at all');

  // run_event keeps the behaviour the misnamed guard actually owned, under a neutral name.
  const runEvent = await client.query(
    `SELECT t.tgname AS name, pg_get_triggerdef(t.oid) AS def
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname = 'run_event' ORDER BY 1`);
  assert.deepEqual(runEvent.rows.map((row) => row.name), ['run_event_ingestion_provenance_guard']);
  assert.match(runEvent.rows[0].def, /BEFORE INSERT OR UPDATE OF ingested_at, ingested_by_runner_id, ingested_under_lease_generation/);
  const body = (await client.query(
    `SELECT pg_get_functiondef('run_event_ingestion_provenance_guard()'::regprocedure) AS def`,
  )).rows[0].def as string;
  assert.match(body, /NEW\.ingested_at := clock_timestamp\(\);/);
  assert.match(body, /RUN_EVENT_INGESTED_AT_DB_OWNED/);
  assert.match(body, /RUN_EVENT_INGESTION_PROVENANCE_IMMUTABLE/);
  assert.equal(body.includes('completion_ack'), false);
});

suite('(j) every protected family is still installed and still guarded', async (t) => {
  const client = await connect();
  t.after(async () => { await client.end(); });

  for (const [prefix, minimum] of [
    ['task_executable_', 6],
    ['failure_continuation_', 5],
    ['failure_successor_', 4],
    ['project_acceptance_', 5],
    ['executable_runtime_', 8],
  ] as const) {
    const relations = await client.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','v') AND c.relname LIKE $1 ORDER BY 1`,
      [`${prefix}%`],
    );
    assert.ok(relations.rowCount! >= minimum,
      `${prefix}* lost relations: ${relations.rows.map((r) => r.relname).join(', ')}`);
  }

  // The EXECUTABLE liveness wall borrowed two helpers from the protocol; they are re-created under
  // neutral names, and every borrower resolves to one that exists. A plpgsql body binds its callee
  // at run time, so this is a real call, not a signature check.
  const uuid = (await client.query(
    `SELECT outcome_uuid_from_digest(repeat('a', 64)) AS value`)).rows[0].value as string;
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  const sanitized = (await client.query(
    `SELECT executable_runtime_sanitize_metadata('{"a":1}'::jsonb) AS value`)).rows[0].value;
  assert.deepEqual(sanitized, { a: 1 });
  await assert.rejects(
    client.query(`SELECT executable_runtime_sanitize_metadata('[]'::jsonb)`),
    /EXECUTABLE_RUNTIME_METADATA_INVALID/,
  );

  // Registering and retiring a runtime generation exercises both helpers through the real
  // functions the dead-man and the heartbeat guard call.
  const generation = randomUUID();
  const instanceId = `removal-${generation.slice(0, 8)}`;
  const registered = (await client.query(
    `SELECT executable_runtime_expect_generation(
       'outcome-watchdog', $1, $2::uuid, repeat('b', 40), repeat('c', 64), 30, $3, '{"probe":true}'::jsonb
     ) AS value`,
    [instanceId, generation, `expect:${generation}`],
  )).rows[0].value;
  assert.equal(registered.component, 'outcome-watchdog');
  assert.equal(registered.generation, generation);
  const retired = (await client.query(
    `SELECT executable_runtime_retire_expectation(
       'outcome-watchdog', $1, $2::uuid, 'REMOVAL_PROBE', $3
     ) AS value`,
    [instanceId, generation, `retire:${generation}`],
  )).rows[0].value;
  assert.equal(retired.retired, true);
});

suite('(j) the restored coordinator entry points are the 0198 implementations', async (t) => {
  const client = await connect();
  t.after(async () => { await client.end(); });

  const shadows = await client.query(`
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'outcome_register_coordinator_obligation_0198',
         'outcome_reconcile_active_obligations_0198',
         'outcome_record_coordinator_result_0198'
       ) ORDER BY 1`);
  assert.deepEqual(shadows.rows, [], 'the 0202 shadows must have been renamed back, not left beside');

  for (const [name, signature] of [
    ['outcome_register_coordinator_obligation',
      'outcome_register_coordinator_obligation(uuid,uuid,text,text,jsonb,bigint,integer,integer,integer,integer)'],
    ['outcome_reconcile_active_obligations',
      'outcome_reconcile_active_obligations(uuid,bigint,integer,integer,integer,integer)'],
    ['outcome_record_coordinator_result',
      'outcome_record_coordinator_result(uuid,uuid,uuid,text,text,text,text,bigint,jsonb)'],
  ] as const) {
    const def = (await client.query(
      `SELECT pg_get_functiondef($1::regprocedure) AS def`, [signature])).rows[0].def as string;
    assert.equal(def.includes('completion_ack'), false, `${name} must not read the removed protocol`);
    assert.equal(def.includes('_0198'), false, `${name} must be the implementation, not a wrapper`);
  }

  // The sweep and the claim never handled COMPLETION_ACK, and still only see the two source types
  // that remain.
  const sweep = (await client.query(
    `SELECT pg_get_functiondef('outcome_sweep_coordinator(uuid)'::regprocedure) AS def`)).rows[0].def as string;
  assert.match(sweep, /source_type IN \('CANONICAL', 'EXECUTOR'\)/);
});
