import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';

// Unit 02's independent v1.13 review. These are finding witnesses, not development acceptance
// tests: they stay green while the reviewed defect exists and must be flipped by its repair.
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

const D18_SQL = firstSql(between(CONTRACT, '#### D18 ', '#### D19 '));
const D19_SQL = firstSql(between(CONTRACT, '#### D19 ', '#### D20 '));
const D20 = between(CONTRACT, '#### D20 ', '#### D7 ');
const D20_SQL = firstSql(D20);
const I11 = between(CONTRACT, '- **I11-A（', '- **I12-A（');

test('PC-CX-62: D20 quantifies statuses and attribution more broadly than I11-A', () => {
  assert.match(I11, /status = 'APPLIED'/,
    'positive control: I11-A no longer requires every COORDINATOR placeholder to belong to an APPLIED action');
  assert.match(I11, /subject_type = 'TASK'/,
    'positive control: I11-A no longer requires Task attribution');
  assert.match(D20_SQL, /a\.status <> 'APPLIED' AND a\.result_session_id IS NULL/,
    'the reviewed predicate no longer admits every non-APPLIED terminal status');
  assert.doesNotMatch(D20_SQL, /a\.subject_type|a\.subject_id|s\.task_id/,
    'the reviewed predicate unexpectedly checks the I11-A attribution columns');
  assert.match(D20, /非 `APPLIED` ⇒ `result_session_id IS NULL`/,
    'the over-broad status rule is no longer normative text as well as executable SQL');
});

type ClientCtor = new (config: { connectionString?: string }) => Client;

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const { Client: Ctor } = (await import('pg')) as unknown as { Client: ClientCtor };
  const client = new Ctor({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client); // first query, before every fixture mutation
  return client;
}

function message(error: unknown): string {
  return String((error as { message?: string }).message ?? error);
}

async function buildFixture(client: Client): Promise<void> {
  const schema = 'pcc_v113_review_scope_gap';
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}, public`);
  await client.query(`
    CREATE TABLE project (id text PRIMARY KEY);
    CREATE TABLE task (id text PRIMARY KEY, project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE);
    CREATE TABLE project_action (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      type text NOT NULL,
      status text NOT NULL,
      subject_type text NOT NULL DEFAULT 'TASK',
      subject_id text,
      result_session_id text,
      detail jsonb NOT NULL DEFAULT '{"retiredPins":[]}'::jsonb
    );
    CREATE TABLE session (
      id text PRIMARY KEY,
      task_id text,
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

test('PC-CX-62 on isolated Postgres: invalid status is authorised for irreversible purge',
  { skip: URL ? false : 'set isolated Coordinator PostgreSQL identity variables to run' }, async () => {
    const client = await connect();
    try {
      await buildFixture(client);
      await client.query(`
        INSERT INTO project VALUES ('p-function'), ('p-bare');
        INSERT INTO task VALUES ('t-function','p-function'), ('t-bare','p-bare');
        INSERT INTO project_action (id,project_id,type,status,subject_id) VALUES
          ('a-function','p-function','DISPATCH_TASK','REFUSED','t-function'),
          ('a-bare','p-bare','DISPATCH_TASK','REFUSED','t-bare');
        INSERT INTO session VALUES
          ('s-function','t-function','COORDINATOR','a-function'),
          ('s-bare','t-bare','COORDINATOR','a-bare');
      `);

      const classified = (await client.query<{ in_scope: boolean; reason: string }>(
        `SELECT in_scope, reason FROM coordinator_purge_ledger_pairs('p-function')`)).rows[0];
      assert.deepEqual(classified, { in_scope: true, reason: 'in scope' },
        'a REFUSED action is not an I11-A placeholder, but D20 admits it');

      const purged = (await client.query<{ purged_actions: string; purged_sessions: string }>(
        `SELECT * FROM coordinator_purge_project('p-function')`)).rows[0];
      assert.deepEqual(purged, { purged_actions: '1', purged_sessions: '1' });
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM session WHERE id='s-function'`)).rows[0].n, 0,
        'the malformed Session was physically deleted instead of typed fail-closed');

      const bare = await client.query(`DELETE FROM project WHERE id='p-bare'`)
        .then(() => 'committed').catch((error: unknown) => message(error).split('\n')[0]);
      assert.match(bare, /PROJECT_PURGE_UNDECLARED/,
        'the bare entry point no longer disagrees with the public purge on the same malformed shape');
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM session WHERE id='s-bare'`)).rows[0].n, 1,
        'positive control: the refused bare delete keeps the Session');
      console.log(`PC-CX-62 witness=${JSON.stringify({ classified, function: purged, bare, kept: 's-bare' })}`);
    } finally {
      await client.end();
    }
  });

test('PC-CX-62 on isolated Postgres: wrong Task attribution is also silently in scope',
  { skip: URL ? false : 'set isolated Coordinator PostgreSQL identity variables to run' }, async () => {
    const client = await connect();
    try {
      await buildFixture(client);
      await client.query(`
        INSERT INTO project VALUES ('p-owner'), ('p-foreign');
        INSERT INTO task VALUES ('t-owner','p-owner'), ('t-foreign','p-foreign');
        INSERT INTO project_action (id,project_id,type,status,subject_id)
          VALUES ('a-owner','p-owner','DISPATCH_TASK','CLAIMED','t-owner');
        INSERT INTO session VALUES ('s-foreign','t-foreign','COORDINATOR','a-owner');
        UPDATE project_action SET status='APPLIED', result_session_id='s-foreign' WHERE id='a-owner';
      `);
      const classified = (await client.query<{ in_scope: boolean; reason: string }>(
        `SELECT in_scope, reason FROM coordinator_purge_ledger_pairs('p-owner')`)).rows[0];
      assert.deepEqual(classified, { in_scope: true, reason: 'in scope' },
        'D20 does not read the Session Task or action subject columns I11-A requires');
      assert.deepEqual((await client.query<{ purged_actions: string; purged_sessions: string }>(
        `SELECT * FROM coordinator_purge_project('p-owner')`)).rows[0],
      { purged_actions: '1', purged_sessions: '1' });
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM session WHERE id='s-foreign'`)).rows[0].n, 0,
        'purging one Project physically deleted a Session attributed to another Project Task');
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM project WHERE id='p-foreign'`)).rows[0].n, 1,
        'positive control: the foreign Project and Task still exist, only their Session was lost');
      console.log(`PC-CX-62 attribution=${JSON.stringify({ classified, foreignProject: 'kept', foreignSession: 'deleted' })}`);
    } finally {
      await client.end();
    }
  });
