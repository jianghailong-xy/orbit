import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';

// A fresh Unit 02 review of v1.14. This file is deliberately separate from the development tests
// and from the flipped v1.13 witness: it extracts the normative SQL again and attacks the compound
// case where one valid placeholder shares a Project with one unattributable legacy placeholder.
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
const PAIRS_SQL = between(D20_SQL, 'CREATE OR REPLACE FUNCTION coordinator_purge_ledger_pairs', '-- ② ');

test('fresh v1.14 review: one D20 predicate binds every stable I11-A attribution column', () => {
  for (const clause of [
    "s.dispatch_origin = 'COORDINATOR'",
    "a.type = 'DISPATCH_TASK'",
    's.project_action_id IS NOT DISTINCT FROM a.id',
    "a.status = 'APPLIED'",
    'a.result_session_id IS NOT DISTINCT FROM s.id',
    "a.subject_type = 'TASK'",
    's.task_id IS NOT NULL',
    'a.subject_id IS NOT DISTINCT FROM s.task_id',
    't.id = s.task_id AND t.project_id = a.project_id',
  ]) {
    assert.ok(PAIRS_SQL.includes(clause), `D20 ⓪ is not mechanically bound to ${clause}`);
  }
  assert.doesNotMatch(PAIRS_SQL, /a\.status <> 'APPLIED' AND a\.result_session_id IS NULL/,
    'the v1.13 terminal/unpublished branch is still executable');

  // Both public entry points must consume the same function; a second hand-written domain would
  // recreate PC-CX-60 even if this copy were correct.
  const fence = between(D20_SQL, 'CREATE OR REPLACE FUNCTION project_purge_fence', 'CREATE TRIGGER project_purge_fence');
  const purge = between(D20_SQL, 'CREATE OR REPLACE FUNCTION coordinator_purge_project', '-- ④ ');
  for (const [name, sql] of [['bare DELETE fence', fence], ['public purge', purge]] as const) {
    assert.match(sql, /coordinator_purge_ledger_pairs/,
      `${name} does not read D20 ⓪`);
    assert.match(sql, /WHERE NOT in_scope/,
      `${name} does not fail closed on an unattributable pair`);
    assert.match(sql, /PROJECT_PURGE_UNDECIDABLE/,
      `${name} has no typed refusal`);
    assert.match(sql, /owner=USER, recovery=HUMAN/,
      `${name} names no owner or recovery`);
  }

  const migration = between(CONTRACT, '### 12.1 ', '### 12.2 ');
  const step6h = migration.split('\n').find((line) => line.includes('**6h**')) ?? '';
  assert.match(step6h, /coordinator_purge_ledger_pairs/,
    'the one-shot migration does not install the same attribution predicate');
  assert.match(step6h, /in_scope = false/,
    'the migration does not audit legacy pairs outside the attribution closure');
  assert.match(migration, /㉖/,
    'the migration verification matrix has no PC-CX-62 gate');
  assert.match(between(CONTRACT, '## 15. ', '## 16. '), /\*\*F62\*\*/,
    'the fault matrix has no row for unattributable purge lineage');
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

function errorMessage(error: unknown): string {
  return String((error as { message?: string }).message ?? error).split('\n')[0];
}

async function buildFixture(client: Client): Promise<void> {
  const schema = 'pcc02r_v114_fresh_review';
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

test('fresh v1.14 review on isolated Postgres: one bad pair stops a mixed purge atomically and is recoverable',
  { skip: URL ? false : 'set isolated Coordinator PostgreSQL identity variables to run' }, async () => {
    const client = await connect();
    try {
      await buildFixture(client);
      await client.query(`
        INSERT INTO project VALUES ('p-mixed'), ('p-empty');
        INSERT INTO task VALUES ('t-good','p-mixed');
        INSERT INTO project_action (id,project_id,type,status,subject_id) VALUES
          ('a-good','p-mixed','DISPATCH_TASK','CLAIMED','t-good'),
          ('a-missing-task','p-mixed','DISPATCH_TASK','CLAIMED','t-missing');
        INSERT INTO session VALUES
          ('s-good','t-good','COORDINATOR','a-good'),
          ('s-missing-task','t-missing','COORDINATOR','a-missing-task');
        UPDATE project_action SET status='APPLIED', result_session_id='s-good' WHERE id='a-good';
        UPDATE project_action SET status='APPLIED', result_session_id='s-missing-task'
          WHERE id='a-missing-task';
      `);

      const classified = await client.query<{ action_id: string; in_scope: boolean; reason: string }>(
        `SELECT action_id, in_scope, reason FROM coordinator_purge_ledger_pairs('p-mixed') ORDER BY action_id`);
      assert.deepEqual(classified.rows, [
        { action_id: 'a-good', in_scope: true, reason: 'in scope' },
        { action_id: 'a-missing-task', in_scope: false,
          reason: 'the task this session runs belongs to another project' },
      ], 'D20 ⓪ did not distinguish the attributed pair from the missing-Task legacy pair');

      const answers: string[] = [];
      for (const sql of [
        `SELECT * FROM coordinator_purge_project('p-mixed')`,
        `DELETE FROM project WHERE id='p-mixed'`,
      ]) {
        const answer = await client.query(sql).then(() => 'committed').catch(errorMessage);
        assert.match(answer, /PROJECT_PURGE_UNDECIDABLE/,
          'an unattributable pair did not stop the entire purge');
        assert.match(answer, /a-missing-task.*s-missing-task.*belongs to another project/,
          'the refusal does not identify the bad action/session/reason');
        assert.match(answer, /owner=USER, recovery=HUMAN/,
          'the refusal has no responsible owner or recovery path');
        answers.push(answer);
      }
      assert.equal(answers[0], answers[1],
        'the function and bare DELETE disagree on the same mixed committed state');
      assert.deepEqual((await client.query<{ projects: string; tasks: string; actions: string; sessions: string }>(`
        SELECT (SELECT count(*)::text FROM project WHERE id='p-mixed') AS projects,
               (SELECT count(*)::text FROM task WHERE project_id='p-mixed') AS tasks,
               (SELECT count(*)::text FROM project_action WHERE project_id='p-mixed') AS actions,
               (SELECT count(*)::text FROM session WHERE id IN ('s-good','s-missing-task')) AS sessions
      `)).rows[0], { projects: '1', tasks: '1', actions: '2', sessions: '2' },
      'fail-closed was partial: a valid sibling or one of the ledger rows was deleted');

      const audited = (await client.query<{ n: string }>(`
        SELECT count(*)::text AS n
          FROM coordinator_purge_ledger_pairs('p-mixed')
         WHERE NOT in_scope
      `)).rows[0].n;
      assert.equal(audited, '1', 'the migration audit cannot see the missing-Task legacy pair');

      // D20-i's stated HUMAN recovery: restore the missing attribution, then retry the exact purge.
      await client.query(`INSERT INTO task VALUES ('t-missing','p-mixed')`);
      assert.equal((await client.query<{ n: string }>(`
        SELECT count(*)::text AS n FROM coordinator_purge_ledger_pairs('p-mixed') WHERE NOT in_scope
      `)).rows[0].n, '0', 'repairing the attribution did not close the blocker mechanically');
      assert.deepEqual((await client.query<{ purged_actions: string; purged_sessions: string }>(
        `SELECT * FROM coordinator_purge_project('p-mixed')`)).rows[0],
      { purged_actions: '2', purged_sessions: '2' },
      'the exact retry did not purge both now-attributed placeholders');
      assert.deepEqual((await client.query<{ projects: string; tasks: string; actions: string; sessions: string }>(`
        SELECT (SELECT count(*)::text FROM project WHERE id='p-mixed') AS projects,
               (SELECT count(*)::text FROM task WHERE project_id='p-mixed') AS tasks,
               (SELECT count(*)::text FROM project_action WHERE project_id='p-mixed') AS actions,
               (SELECT count(*)::text FROM session WHERE id IN ('s-good','s-missing-task')) AS sessions
      `)).rows[0], { projects: '0', tasks: '0', actions: '0', sessions: '0' },
      'the successful Project-level purge left part of the ledger or either placeholder behind');

      await client.query(`DELETE FROM project WHERE id='p-empty'`);
      console.log(`pcc02r-v114-mixed=${JSON.stringify({ classified: classified.rows, answers, audited,
        recovered: { purgedActions: 2, purgedSessions: 2 }, emptyProject: 'bare-delete-committed' })}`);
    } finally {
      await client.end();
    }
  });
