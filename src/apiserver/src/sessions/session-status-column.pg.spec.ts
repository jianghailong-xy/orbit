/**
 * THE DATABASE SIDE OF "NOTHING READS OR WRITES session.status" (docs/session-status-retirement-plan.md §5).
 *
 * session-status-column.spec.ts reads the server's source; what it cannot see are the objects the database holds. On a
 * database every migration has been applied to, this lists each one that names `session.status` or its type
 * `run_status`: the column and the type, trigger column lists and WHEN clauses, function bodies, indexes, CHECKs, views
 * and generated columns. Seeded from today's objects (task T1). The list may only shrink: T6 takes out what it
 * restates, and T15 turns this into the check that the column and the type are gone.
 *
 * A function body is told by what it says: `NEW.status` / `OLD.status` in a function a trigger on session runs,
 * `<alias>.status` or a `SET status` of a statement on the session table, or a mention of `run_status`.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-status-column.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';

const URL = process.env.COORDINATOR_PG_URL;

/** Today's objects. Take a line out when a task removes or restates the object; never add one (the four of deploy D1
 *  below are the plan's own, §4.1, added with the migration that installs them). */
const NAMING_STATUS: readonly string[] = [
  // The column and the type (T15).
  'column session.status',
  'type run_status',
  // Trigger column lists and WHEN clauses (T6 restates them in deploy 2; T15 takes `status` out of the lists).
  'trigger session_acquisition_engine_guard',
  'trigger session_admission_lock_order_update',
  'trigger session_antigravity_runner_claim_guard',
  'trigger session_cursor_runner_acquisition_guard',
  'trigger session_dsh_runner_acquisition_guard',
  'trigger session_listed_at_settle',
  'trigger session_opencode_runner_claim_guard',
  'trigger session_project_capacity_serialize_update',
  'trigger session_request_asker_stopped',
  'trigger session_request_recipient_ended',
  'trigger session_superseded_task_revive_guard',
  'trigger task_owner_confirmation_review_reviewer_ended',
  // Function bodies (T6).
  'function guard_antigravity_runner_claim',
  'function guard_cursor_runner_acquisition',
  'function guard_dsh_runner_acquisition',
  'function guard_opencode_runner_claim',
  'function guard_session_engine_acquisition',
  'function open_list_bump_owner',
  'function session_listed_at_on_settle',
  'function session_request_recipient_ended',
  // Not in the plan's §4.2 table: a task trigger's function that reads `s."status"` of the session into its error text.
  'function task_supersession_live_session_guard',
  // Deploy D1's own (T2, migration 1611; plan §4.1): the facts follow the word until the readers and writers move.
  // `session_aa_turn_state_from_status` and its function are replaced in D3 (T14) by the trigger that derives the
  // word from the facts; `session_zz_phase` loses `status` from its list and `session_turn_state_of_status` (the
  // backfill's) goes with the type in D4 (T15).
  'trigger session_aa_turn_state_from_status',
  'trigger session_zz_phase',
  'function session_turn_state_from_status',
  'function session_turn_state_of_status',
  // Deploy D2's own (T5, migration 1622; plan §4.1): a set turn_state held equal to the word while both exist. The task
  // that follows the backfill puts the plan's strict session_turn_state_agrees_chk in its place; T15 drops that one.
  'check session_turn_state_agrees_unless_null_chk',
  // Indexes and the release CHECK (go with the column, T15).
  'check session_release_fact_chk',
  'index session_assigned_runner_id_status_idx',
  'index session_batch_id_status_idx',
  'index session_over_capacity_pending_idx',
  'index session_owner_status_task_idx',
  'index session_root_session_id_status_idx',
  'index session_status_idx',
];

function bodyNamesStatus(body: string, onSession: boolean): boolean {
  const text = body.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  if (/\brun_status\b/i.test(text)) return true;
  if (onSession && /\b(new|old)\s*\.\s*"?status\b/i.test(text)) return true;
  const statements = text.split(';');
  return statements.some((statement) => {
    const tables = [...statement.matchAll(/\b(from|join|update|into)\s+(?:only\s+)?(?:"?public"?\.)?"?session"?(?![\w"])(?:\s+(?:as\s+)?([a-z_]\w*))?/gi)];
    return tables.some((table) => {
      const alias = table[2] && !/^(set|where|on|inner|left|join|for|order|group|limit)$/i.test(table[2]) ? table[2] : 'session';
      return new RegExp(`(?<![\\w.])"?${alias}"?\\s*\\.\\s*"?status\\b`, 'i').test(statement)
        || (table[1].toLowerCase() === 'update' && /\bset\b[\s\S]*?(?<![\w.])"?status"?\s*=/i.test(statement));
    });
  });
}

async function objectsNamingStatus(sql: Client): Promise<string[]> {
  const found: string[] = [];
  const names = async (query: string): Promise<void> => {
    found.push(...(await sql.query<{ name: string }>(query)).rows.map((row) => row.name));
  };
  await names(`SELECT 'column ' || c.relname || '.' || a.attname AS name
     FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    WHERE NOT a.attisdropped AND c.relkind IN ('r', 'p', 'v', 'm')
      AND (a.atttypid = to_regtype('public.run_status')
        OR (c.oid = 'public.session'::regclass AND a.attname = 'status'))`);
  await names(`SELECT 'type run_status' AS name WHERE to_regtype('public.run_status') IS NOT NULL`);
  // `\\m…\\M` take an underscore as part of a word, so `task_status` and `run_status_x` are other words.
  await names(`SELECT 'trigger ' || t.tgname AS name FROM pg_trigger t
    WHERE NOT t.tgisinternal AND t.tgrelid = 'public.session'::regclass
      AND regexp_replace(pg_get_triggerdef(t.oid), 'EXECUTE (FUNCTION|PROCEDURE).*$', '') ~* '\\m(status|run_status)\\M'`);
  await names(`SELECT 'index ' || i.indexrelid::regclass::text AS name FROM pg_index i
    WHERE (i.indrelid = 'public.session'::regclass
           AND regexp_replace(pg_get_indexdef(i.indexrelid), '^.* USING \\w+ ', '') ~ '\\mstatus\\M')
       OR pg_get_indexdef(i.indexrelid) ~ '\\mrun_status\\M'`);
  await names(`SELECT 'check ' || c.conname AS name FROM pg_constraint c
    WHERE c.contype = 'c' AND ((c.conrelid = 'public.session'::regclass AND pg_get_constraintdef(c.oid) ~ '\\mstatus\\M')
       OR pg_get_constraintdef(c.oid) ~ '\\mrun_status\\M')`);
  await names(`SELECT 'view ' || c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')
      AND pg_get_viewdef(c.oid) ~* '\\mrun_status\\M|session[^\\n]*\\mstatus\\M'`);
  await names(`SELECT 'generated ' || a.attrelid::regclass::text || '.' || a.attname AS name
     FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attgenerated <> '' AND (pg_get_expr(d.adbin, d.adrelid) ~ '\\mrun_status\\M'
       OR (a.attrelid = 'public.session'::regclass AND pg_get_expr(d.adbin, d.adrelid) ~ '\\mstatus\\M'))`);

  const functions = (await sql.query<{ name: string; body: string; onSession: boolean }>(
    `SELECT p.proname AS name, pg_get_functiondef(p.oid) AS body,
            EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgfoid = p.oid AND NOT t.tgisinternal
                      AND t.tgrelid = 'public.session'::regclass) AS "onSession"
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')`)).rows;
  assert.ok(functions.length > 50, `only ${functions.length} functions: is this a migrated database?`);
  found.push(...functions.filter((fn) => bodyNamesStatus(fn.body, fn.onSession)).map((fn) => `function ${fn.name}`));
  return found.sort();
}

test('no database object names session.status beyond the ones listed', { skip: !URL, timeout: 120_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  t.after(() => sql.end().catch(() => undefined));
  await verifyCoordinatorPgIdentity(sql);

  const added = (found: string[]): string[] => found.filter((name) => !NAMING_STATUS.includes(name));

  await t.test('today: every object that names it is listed', async () => {
    const found = await objectsNamingStatus(sql);
    assert.deepEqual(added(found), [], `\nthese name session.status and are not listed:\n${added(found).join('\n')}\n`);
  });

  await t.test('a planted function, index and CHECK are each reported by name', async () => {
    await sql.query('BEGIN');
    try {
      await sql.query(`CREATE FUNCTION planted_status_reader() RETURNS bigint LANGUAGE sql AS
        $$ SELECT count(*) FROM session s WHERE s.status = 'RUNNING' $$`);
      await sql.query('CREATE INDEX planted_status_index ON session (status)');
      await sql.query('ALTER TABLE session ADD CONSTRAINT planted_status_chk CHECK (status IS NOT NULL) NOT VALID');
      await sql.query(`CREATE FUNCTION planted_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`);
      await sql.query('CREATE TRIGGER planted_status_trigger BEFORE UPDATE OF status ON session FOR EACH ROW EXECUTE FUNCTION planted_noop()');
      assert.deepEqual(added(await objectsNamingStatus(sql)), [
        'check planted_status_chk',
        'function planted_status_reader',
        'index planted_status_index',
        'trigger planted_status_trigger',
      ]);
    } finally {
      await sql.query('ROLLBACK');
    }
  });
});
