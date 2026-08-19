import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';

// Unit 02's independent review of the v1.12 Coordinator contract. These tests deliberately assert
// the counterexample shape: they should turn red when the next contract revision closes it. They
// never edit the authoritative contract or the development fixtures.
const REPO = path.resolve(__dirname, '../../../..');
const CONTRACT = readFileSync(path.join(REPO, 'docs/project-coordinator-contract.md'), 'utf8');
const URL = process.env.COORDINATOR_PG_URL;

function between(document: string, start: string, end: string): string {
  const from = document.indexOf(start);
  const to = document.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not isolate ${start}`);
  return document.slice(from, to);
}

function firstSql(section: string): string {
  const fence = '```sql\n';
  const from = section.indexOf(fence);
  const to = section.indexOf('\n```', from + fence.length);
  assert.ok(from >= 0 && to > from, 'could not isolate SQL fence');
  return section.slice(from + fence.length, to);
}

const INFRA = between(CONTRACT, '### 2.4 ', '## 3. 词汇表');
const D18 = between(CONTRACT, '#### D18 ', '#### D19 ');
const D18_SQL = firstSql(D18);
const D19 = between(CONTRACT, '#### D19 ', '#### D20 ');
const D19_SQL = firstSql(D19);
const D20 = between(CONTRACT, '#### D20 ', '#### D7 ');
const D20_SQL = firstSql(D20);
const MIGRATION_TABLE = between(CONTRACT, '迁移 `0111_project_coordinator`', '- **G1');

test('PC-CX-58: the current contract gives the lineage FK two different initial modes', () => {
  assert.match(INFRA, /NO ACTION[^\n]+DEFERRABLE INITIALLY IMMEDIATE/,
    'positive control: §2.4 no longer states the intended immediate-by-default edge');
  assert.match(D20_SQL, /DEFERRABLE INITIALLY IMMEDIATE/,
    'positive control: D20 SQL no longer creates the intended immediate-by-default edge');
  assert.match(D19, /NO ACTION DEFERRABLE INITIALLY DEFERRED/,
    'the D19-c counterexample disappeared; flip this test when all normative clauses agree');
  assert.notEqual(
    /INITIALLY IMMEDIATE/.test(INFRA),
    /INITIALLY IMMEDIATE/.test(D19.match(/\*\*v1\.12[^\n]+/s)?.[0] ?? ''),
    'the two normative clauses unexpectedly give the same answer',
  );
});

test('PC-CX-59: the one-shot migration table skips every v1.11 database object', () => {
  const row6g = MIGRATION_TABLE.split('\n').find((line) => line.includes('**6g**')) ?? '';
  const row6h = MIGRATION_TABLE.split('\n').find((line) => line.includes('**6h**')) ?? '';
  assert.match(row6g, /v1\.10/);
  assert.match(row6g, /project_action_result_ledger_mutator[^\n]+BEFORE UPDATE/,
    'positive control: 6g is still explicitly the obsolete UPDATE-only D18');
  assert.match(row6h, /v1\.12/);
  assert.match(row6h, /session_project_action_fk/,
    'positive control: 6h installs only the v1.12 purge edge');
  assert.doesNotMatch(MIGRATION_TABLE,
    /project_action_result_session_fk|session_result_link_delete_guard/,
    'a v1.11 migration row now exists; flip this counterexample after checking all three objects');
  assert.doesNotMatch(row6h, /project_action_result_ledger_mutator|BEFORE INSERT OR UPDATE/,
    '6h unexpectedly upgrades D18 as well as installing D20');
  assert.match(D19_SQL, /project_action_result_session_fk/,
    'positive control: the omitted structural D19 object is normative');
  assert.match(D19_SQL, /session_result_link_delete_guard/,
    'positive control: the omitted typed D19 object is normative');
  assert.match(D18_SQL, /BEFORE INSERT OR UPDATE ON project_action/,
    'positive control: the current normative D18 differs from the migration table');
});

type ClientCtor = new (config: { connectionString?: string }) => Client;

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const { Client: Ctor } = (await import('pg')) as unknown as { Client: ClientCtor };
  const client = new Ctor({ connectionString: URL });
  await client.connect();
  // This must be the first query on every connection. Destructive fixture DDL follows only after it passes.
  await verifyCoordinatorPgIdentity(client);
  return client;
}

async function resetSchema(client: Client, schema: string): Promise<void> {
  assert.match(schema, /^pcc_v112_review_[a-z_]+$/);
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}, public`);
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

function errorConstraint(error: unknown): string | undefined {
  return (error as { constraint?: string }).constraint;
}

async function buildPurgeFixture(client: Client, schema: string): Promise<void> {
  await resetSchema(client, schema);
  await client.query(`
    CREATE TABLE project (id text PRIMARY KEY);
    CREATE TABLE project_action (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      type text NOT NULL,
      status text NOT NULL,
      result_session_id text,
      detail jsonb NOT NULL DEFAULT '{"retiredPins":[]}'::jsonb
    );
    CREATE TABLE session (
      id text PRIMARY KEY,
      dispatch_origin text NOT NULL,
      project_action_id text UNIQUE
    );
    CREATE INDEX project_action_result_session_idx ON project_action(result_session_id);
    CREATE INDEX project_action_project_idx ON project_action(project_id);
  `);
  await client.query(D18_SQL);
  await client.query(D19_SQL);
  await client.query(D20_SQL);
}

test('PC-CX-60 on isolated Postgres: the purge function deletes a USER Session that D20-c excludes',
  { skip: URL ? false : 'set isolated Coordinator PostgreSQL identity variables to run' }, async () => {
    const client = await connect();
    try {
      await buildPurgeFixture(client, 'pcc_v112_review_purge_scope');
      await client.query(`
        INSERT INTO project VALUES ('p-function'), ('p-bare');
        INSERT INTO session VALUES ('s-user-function', 'USER', NULL), ('s-user-bare', 'USER', NULL);
        INSERT INTO project_action (id, project_id, type, status, result_session_id) VALUES
          ('a-function', 'p-function', 'DISPATCH_TASK', 'REFUSED', 's-user-function'),
          ('a-bare',     'p-bare',     'DISPATCH_TASK', 'REFUSED', 's-user-bare');
      `);

      const purged = (await client.query<{ purged_actions: string; purged_sessions: string }>(
        `SELECT * FROM coordinator_purge_project('p-function')`)).rows[0];
      assert.deepEqual(purged, { purged_actions: '1', purged_sessions: '1' },
        'the OR branch treats result_session_id alone as permission to delete the Session');
      assert.equal((await client.query(
        `SELECT count(*)::int AS n FROM session WHERE id='s-user-function'`)).rows[0].n, 0,
      'the declared exclusion of every USER-origin Session is not enforced by the function');

      await client.query(`DELETE FROM project WHERE id='p-bare'`);
      assert.equal((await client.query(
        `SELECT count(*)::int AS n FROM session WHERE id='s-user-bare'`)).rows[0].n, 1,
      'the fence sees no reverse lineage, so the bare DELETE commits and keeps the same USER Session');
      console.log(`PC-CX-60 witness=${JSON.stringify({ function: 'USER session deleted', bare: 'USER session kept' })}`);
    } finally {
      await client.end();
    }
  });

test('PC-CX-61 on isolated Postgres: publication after the doomed snapshot aborts the declared purge',
  { skip: URL ? false : 'set isolated Coordinator PostgreSQL identity variables to run' }, async () => {
    const purger = await connect();
    const publisher = await connect();
    try {
      await buildPurgeFixture(purger, 'pcc_v112_review_purge_race');
      await publisher.query(`SET search_path TO pcc_v112_review_purge_race, public`);
      await purger.query(`
        INSERT INTO project VALUES ('p-race');
        INSERT INTO project_action (id, project_id, type, status) VALUES
          ('a-old',  'p-race', 'DISPATCH_TASK', 'CLAIMED'),
          ('a-late', 'p-race', 'DISPATCH_TASK', 'CLAIMED');
        INSERT INTO session VALUES ('s-old', 'COORDINATOR', 'a-old');
        UPDATE project_action SET status='APPLIED', result_session_id='s-old' WHERE id='a-old';
      `);

      // D20 ③-1..③-3, stopped immediately after the function's doomed-session snapshot.
      await purger.query('BEGIN');
      await purger.query(`SELECT 1 FROM project WHERE id='p-race' FOR UPDATE`);
      await purger.query(`SELECT set_config('coordinator.purging_project','p-race',true)`);
      await purger.query(`SET CONSTRAINTS session_project_action_fk DEFERRED`);
      const doomed = (await purger.query<{ doomed: string[] }>(`
        SELECT COALESCE(array_agg(DISTINCT s.id), '{}'::text[]) AS doomed
          FROM session s JOIN project_action a
            ON a.id = s.project_action_id OR a.result_session_id = s.id
         WHERE a.project_id = 'p-race'`)).rows[0].doomed;
      assert.deepEqual(doomed, ['s-old'], 'positive control: the late publication is not in ③-3 yet');

      // A complete, internally consistent publication does not touch the locked Project row and commits.
      await publisher.query('BEGIN');
      await publisher.query(`INSERT INTO session VALUES ('s-late','COORDINATOR','a-late')`);
      await publisher.query(`UPDATE project_action SET status='APPLIED', result_session_id='s-late' WHERE id='a-late'`);
      await publisher.query('COMMIT');

      // D20 ③-4..③-6 uses the stale snapshot. The deferred FK is safe, but only by aborting the purge.
      await purger.query(`DELETE FROM project WHERE id='p-race'`);
      await purger.query(`DELETE FROM session WHERE id = ANY($1::text[])`, [doomed]);
      await assert.rejects(purger.query('COMMIT'), (error: unknown) => {
        assert.equal(errorCode(error), '23503');
        assert.equal(errorConstraint(error), 'session_project_action_fk');
        return true;
      });
      const rolledBack = (await publisher.query<{ p: number; a: number; s: number }>(`
        SELECT (SELECT count(*)::int FROM project) AS p,
               (SELECT count(*)::int FROM project_action) AS a,
               (SELECT count(*)::int FROM session) AS s`)).rows[0];
      assert.deepEqual(rolledBack, { p: 1, a: 2, s: 2 },
        'the structural gate prevents an orphan by rolling the whole declared purge back');

      const control = (await publisher.query<{ purged_actions: string; purged_sessions: string }>(
        `SELECT * FROM coordinator_purge_project('p-race')`)).rows[0];
      assert.deepEqual(control, { purged_actions: '2', purged_sessions: '2' },
        'positive control: with no publication between snapshot and delete, the same Project purges');
      console.log(`PC-CX-61 witness=${JSON.stringify({ doomed, late: 's-late', commit: '23503', rolledBack })}`);
    } finally {
      await purger.query('ROLLBACK').catch(() => undefined);
      await publisher.query('ROLLBACK').catch(() => undefined);
      await Promise.all([purger.end(), publisher.end()]);
    }
  });
