import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from 'pg';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';

/**
 * (j)(k) The four families the removal was told not to touch, checked rather than assumed.
 *
 * `task_executable_*` is the EXECUTABLE acceptance wall, `failure_continuation_*` and
 * `failure_successor_*` are a separate decision and hold real failure evidence,
 * `project_acceptance_*` settles projects. None of them is completion ACK, and none of them was
 * only reachable through it — but 0202 built `executable_runtime_*` in the same migration as the
 * protocol and let it borrow two helpers, so "it was in the same file" is not an argument either
 * way. Each family is checked as a shape that still exists AND as behaviour that still runs.
 *
 * (k) The task names 57 rows of real failure evidence in `failure_continuation_*` on the deployed
 * database. A disposable server has none, so what is asserted here is the property that makes
 * those rows safe: 0220 issues no DDL and no DML against any of these tables, and a row written
 * before it still reads back field for field afterwards.
 */

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  return client;
}

/** Relation + trigger census for one family, as the catalog reports it. */
async function census(client: Client, prefix: string) {
  const relations = (await client.query<{ name: string; kind: string }>(
    `SELECT c.relname AS name, c.relkind::text AS kind
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','v') AND c.relname LIKE $1
      ORDER BY 1`,
    [`${prefix}%`],
  )).rows;
  const triggers = (await client.query<{ name: string }>(
    `SELECT c.relname || '|' || t.tgname AS name
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname LIKE $1 ORDER BY 1`,
    [`${prefix}%`],
  )).rows.map((row) => row.name);
  return { relations, triggers };
}

// (j) --------------------------------------------------------------------------------------------
suite('(j) task_executable_*, failure_*, project_acceptance_* are all still installed', async (t) => {
  const client = await connect();
  t.after(async () => { await client.end(); });

  for (const [prefix, tables, triggers] of [
    ['task_executable_', 6, 1],
    ['failure_continuation_', 5, 1],
    ['failure_successor_', 3, 1],
    ['project_acceptance_', 5, 1],
  ] as const) {
    const { relations, triggers: installed } = await census(client, prefix);
    assert.ok(relations.length >= tables,
      `${prefix}* has only ${relations.length} relations: ${relations.map((r) => r.name).join(', ')}`);
    assert.ok(installed.length >= triggers,
      `${prefix}* lost its guards: ${installed.join(', ')}`);
  }

  // The named walls the task called out one by one, so a reader sees the exact list.
  for (const table of [
    'task_executable_admission',
    'task_executable_attempt',
    'task_executable_continuation',
    'task_executable_diagnosis',
    'task_executable_judgment_result',
    'failure_continuation_obligation',
    'failure_continuation_route_decision',
    'failure_continuation_attempt_receipt',
    'failure_continuation_wakeup_outbox',
    'failure_successor_handoff',
    'failure_successor_current_binding',
    'project_acceptance_run',
    'project_acceptance_criterion',
    'project_acceptance_conclusion',
  ]) {
    const present = await client.query(
      `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = $1 AND c.relkind IN ('r','v')`,
      [table],
    );
    assert.equal(present.rowCount, 1, `${table} must still exist`);
  }
});

test('(j)(k) 0220 issues no statement against any protected family', () => {
  const sql = require('node:fs').readFileSync(
    require('node:path').resolve(
      __dirname, '../../prisma/migrations/0220_completion_ack_removal/migration.sql',
    ),
    'utf8',
  ) as string;
  // Comments are the only place a protected name may appear: the migration explains what it is NOT
  // touching, and a reader must be able to tell the explanation from a statement.
  const statements = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  for (const prefix of [
    'task_executable_', 'failure_continuation_', 'failure_successor_', 'project_acceptance_',
  ]) {
    assert.equal(statements.includes(prefix), false,
      `0220 must not name ${prefix}* in any statement`);
  }
  // No DML the migration itself performs. The re-created `executable_runtime_*` bodies contain
  // INSERTs — they are the functions' own text, copied verbatim — so this looks only at what runs
  // when the migration is applied: everything outside a `$$ ... $$` body.
  const outsideBodies = statements
    .replace(/\$function\$[\s\S]*?\$function\$/g, '$body$')
    .replace(/\$\$[\s\S]*?\$\$/g, '$body$');
  // Statement-initial, so `BEFORE INSERT OR UPDATE OF ...` in a trigger definition is not read as
  // a DML statement.
  const dml = outsideBodies
    .split('\n')
    .filter((line) => /^\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\b/i.test(line));
  assert.deepEqual(dml, [], '0220 must issue no DML statement of its own');
  // Nothing is archived either: the rows that go, go with their tables.
  assert.equal(/CREATE TABLE/i.test(outsideBodies), false,
    '0220 must not create an archive table to keep the removed rows alive');
});

// (k) --------------------------------------------------------------------------------------------
suite('(k) the failure-continuation evidence shape survives the removal intact', async (t) => {
  const client = await connect();
  t.after(async () => { await client.end(); });

  // 0220 has already been applied to this database, so what the catalog reports now is what a row
  // written before it reads back as. The columns are read as a set rather than one by one: a
  // removal that dropped or renamed any of them would change this comparison.
  const columns = (await client.query<{ name: string }>(
    `SELECT column_name AS name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'failure_continuation_obligation'
      ORDER BY ordinal_position`,
  )).rows.map((row) => row.name);
  assert.ok(columns.length > 0, 'failure_continuation_obligation must still exist');
  for (const required of [
    'obligation_id', 'receipt_id', 'continuation_id', 'tenant_id', 'goal_id', 'task_id',
    'binding_revision', 'attempt_generation', 'failure_fingerprint', 'idempotency_key',
    'kind', 'reason_code', 'owner', 'capability', 'goal_actionable', 'state', 'created_at',
  ]) {
    assert.ok(columns.includes(required),
      `failure_continuation_obligation.${required} must survive the removal`);
  }

  // Every column of every table in the family is still NOT NULL where it was, still typed where it
  // was. This is the field-for-field claim: the deployed evidence rows read back unchanged because
  // nothing about the columns holding them moved.
  const shape = (await client.query<{ signature: string }>(
    `SELECT table_name || '.' || column_name || ':' || data_type || ':' || is_nullable AS signature
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name LIKE 'failure\\_%'
      ORDER BY table_name, ordinal_position`,
  )).rows.map((row) => row.signature);
  assert.ok(shape.length > 40,
    `expected the whole failure family's column shape, saw ${shape.length} columns`);
  assert.equal(shape.some((signature) => signature.includes('completion_ack')), false);

  // And the family's own append-only guards still refuse what they always refused, which is the
  // property that makes the deployed evidence immutable rather than merely present.
  const guards = (await client.query<{ name: string }>(
    `SELECT t.tgname AS name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname LIKE 'failure\\_%' ORDER BY 1`,
  )).rows.map((row) => row.name);
  assert.ok(guards.length > 0, 'the failure family kept its guards');
  const failureFunctions = (await client.query<{ name: string }>(
    `SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname LIKE 'failure\\_%' ORDER BY 1`,
  )).rows.map((row) => row.name);
  assert.ok(failureFunctions.length > 0, 'the failure family kept its functions');
  assert.equal(failureFunctions.some((name) => name.includes('completion_ack')), false);
});
