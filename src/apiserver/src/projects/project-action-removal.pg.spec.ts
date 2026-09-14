import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';

/**
 * Migration 0272: `project_action` is gone with everything that pointed at it, and nothing that only
 * shares its name went with it.
 *
 * The table was the control loop's dispatch ledger. Its writer left with the loop (6418a1e5), its last
 * reader with DEP's `VERDICT_NOT_APPLIED` clause (9135ae64), and the account owner chose to drop it
 * once the rows were archived. The removal can go wrong in two directions, and each has a case:
 *
 *  - something survives: the table, one of its trigger functions or enums, one of the two columns
 *    that referenced it, or the blocker kind only its verdict-apply retry could raise;
 *  - something is taken that was never its: the three live guards on the ratified-action tables have
 *    functions named `project_action_*`, and removing by prefix would take them too.
 *
 * Every catalog case asks about a survivor in the same query as the thing that must be gone, so an
 * empty answer means the object is absent rather than that the query can see nothing.
 */

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

const MIGRATION = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0272_drop_project_action/migration.sql'),
  'utf8',
);
/** Comments stripped: the header names the guards it leaves alone, and prose is not a statement. */
const STATEMENTS = MIGRATION.split('\n').filter((line) => !/^\s*--/.test(line)).join('\n');

/** The live guards whose functions share the prefix, as `table|trigger|function`. */
const NAMESAKES = [
  'project_ratified_action_commit|project_ratified_action_commit_immutable|project_action_commit_immutable',
  'project_ratified_action_intent|project_action_intent_bind_full_revision|project_action_intent_bind_full_revision',
  'project_ratified_action_intent|project_ratified_action_intent_immutable|project_action_intent_immutable',
];

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  return client;
}

suite('0272 on a migrated database', async (t) => {
  const client = await connect();
  t.after(async () => { await client.end(); });

  await t.test('the table and the session key it backed are gone; their neighbours are not', async () => {
    const { rows } = await client.query<{ name: string; present: boolean }>(`
      SELECT name, to_regclass('public.' || name) IS NOT NULL AS present
        FROM unnest(ARRAY['project_action', 'session_project_action_id_key',
                          'project_ratified_action_intent', 'session_share_token_key']) AS name
       ORDER BY name COLLATE "C"`);
    assert.deepEqual(rows, [
      { name: 'project_action', present: false },
      { name: 'project_ratified_action_intent', present: true },
      { name: 'session_project_action_id_key', present: false },
      { name: 'session_share_token_key', present: true },
    ]);
  });

  await t.test('the only project_action_ functions left are the three ratified-action guards', async () => {
    const { rows } = await client.query<{ proname: string }>(`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname LIKE 'project\\_action\\_%'
       ORDER BY p.proname COLLATE "C"`);
    assert.deepEqual(rows.map((row) => row.proname), [
      'project_action_commit_immutable',
      'project_action_intent_bind_full_revision',
      'project_action_intent_immutable',
    ], 'the two dispatch functions must be gone and no ratified-action guard with them');
  });

  await t.test('those three guards are still attached to their tables and enabled', async () => {
    const { rows } = await client.query<{ entry: string }>(`
      SELECT c.relname || '|' || t.tgname || '|' || p.proname AS entry
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE NOT t.tgisinternal AND t.tgenabled <> 'D' AND p.proname LIKE 'project\\_action\\_%'
       ORDER BY (c.relname || '|' || t.tgname || '|' || p.proname) COLLATE "C"`);
    assert.deepEqual(rows.map((row) => row.entry), NAMESAKES);
  });

  await t.test('both enums are gone, and so are both columns that referenced the table', async () => {
    const { rows: enums } = await client.query<{ typname: string }>(`
      SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public' AND t.typtype = 'e'
         AND t.typname IN ('project_action_type', 'project_action_status', 'task_completion_criterion')
       ORDER BY 1`);
    assert.deepEqual(enums.map((row) => row.typname), ['task_completion_criterion']);

    const { rows: columns } = await client.query<{ col: string }>(`
      SELECT table_name::text || '.' || column_name::text AS col FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (table_name::text, column_name::text) IN (
               ('session', 'project_action_id'), ('session', 'task_id'),
               ('task_verification_failure', 'raised_by_action_id'),
               ('task_verification_failure', 'defect_task_id'))
       ORDER BY (table_name::text || '.' || column_name::text) COLLATE "C"`);
    assert.deepEqual(columns.map((row) => row.col),
      ['session.task_id', 'task_verification_failure.defect_task_id']);
  });

  await t.test('project_blocker no longer admits the kind only the verdict-apply retry raised', async () => {
    const { rows: [check] } = await client.query<{ def: string }>(`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname = 'project_blocker_kind_chk' AND conrelid = 'project_blocker'::regclass`);
    const kinds = [...check.def.matchAll(/'([A-Z][A-Z0-9_]*)'::text/g)].map((match) => match[1]);
    assert.ok(kinds.includes('VERIFICATION_FAILED'), `the CHECK lost the kinds it keeps: ${check.def}`);
    assert.equal(kinds.includes('VERDICT_APPLY_EXHAUSTED'), false, check.def);
  });
});

test('0272 names each object it removes, removes nothing by pattern, and writes no row', () => {
  const named = (statement: string): string[] => [
    ...STATEMENTS.matchAll(new RegExp(`${statement}\\s+(?:IF\\s+EXISTS\\s+)?"([a-z_0-9]+)"`, 'gi')),
  ].map((match) => match[1]);
  assert.deepEqual(named('DROP\\s+TRIGGER'),
    ['project_action_dispatch_result_check', 'project_action_dispatch_immutable']);
  assert.deepEqual(named('DROP\\s+FUNCTION'),
    ['project_action_dispatch_result_check', 'project_action_dispatch_immutable']);
  assert.deepEqual(named('DROP\\s+COLUMN'), ['project_action_id', 'raised_by_action_id']);
  assert.deepEqual(named('DROP\\s+TABLE'), ['project_action']);
  assert.deepEqual(named('DROP\\s+TYPE'), ['project_action_type', 'project_action_status']);

  // Nothing that could reach past the names above: no catalog loop, no dynamic SQL, no cascade.
  for (const reach of [/\bDO\s+\$/i, /\bEXECUTE\b/i, /\bLIKE\b/i, /\bCASCADE\b/i, /\bpg_proc\b/i]) {
    assert.equal(reach.test(STATEMENTS), false, `0272 carries ${reach}`);
  }
  for (const guard of ['project_action_intent_immutable', 'project_action_commit_immutable',
    'project_action_intent_bind_full_revision']) {
    assert.equal(STATEMENTS.includes(guard), false, `0272 names ${guard}, a live ratified-action guard`);
  }
  for (const write of [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+(?:ONLY\s+)?"?[a-z_]+"?\s+SET\b/i,
    /\bDELETE\s+FROM\b/i, /\bTRUNCATE\b/i]) {
    assert.equal(write.test(STATEMENTS), false, `0272 carries ${write}`);
  }
});
