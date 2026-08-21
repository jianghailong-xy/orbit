import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';

// Unit 02's independent v1.13 review. v1.14 closes `PC-CX-62`, so every assertion below is flipped
// the way §26–§32 flip the rounds before it: it now proves the reviewed shape is refused, and it
// keeps the review's own witness alive inside the same test as a reverse control. Nothing here
// edits the review reports; the SQL under test is read straight out of the contract, and the v1.13
// predicate is rebuilt out of that same text — so a revision that moves the clause without moving
// its object turns this file red rather than silently passing.
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

/** Rebuild the superseded predicate out of the current clause, and fail loudly if the anchor moved. */
function rewrite(sql: string, from: string, to: string): string {
  assert.ok(sql.includes(from), `the reverse control anchor "${from}" is no longer in the contract`);
  return sql.split(from).join(to);
}

const D18_SQL = firstSql(between(CONTRACT, '#### D18 ', '#### D19 '));
const D19_SQL = firstSql(between(CONTRACT, '#### D19 ', '#### D20 '));
const D20 = between(CONTRACT, '#### D20 ', '#### D7 ');
const D20_SQL = firstSql(D20);
const I11 = between(CONTRACT, '- **I11-A（', '- **I12-A（');
const NORMATIVE = CONTRACT.slice(0, CONTRACT.indexOf('\n## 19. '));

/** ⓪ on its own, so the reverse control can replace exactly the predicate this round changed. */
const LEDGER_PAIRS = between(D20_SQL, 'CREATE OR REPLACE FUNCTION coordinator_purge_ledger_pairs',
  '-- ② 类型那一半');
const V114_PREDICATE = `AND a.status = 'APPLIED'
              AND a.result_session_id IS NOT DISTINCT FROM s.id
              AND a.subject_type = 'TASK'
              AND s.task_id IS NOT NULL
              AND a.subject_id IS NOT DISTINCT FROM s.task_id
              AND EXISTS (SELECT 1 FROM task t
                           WHERE t.id = s.task_id AND t.project_id = a.project_id)`;
const V113_PREDICATE = `AND ((a.status =  'APPLIED' AND a.result_session_id IS NOT DISTINCT FROM s.id)
                OR (a.status <> 'APPLIED' AND a.result_session_id IS NULL))`;
const LEDGER_PAIRS_V113 = rewrite(LEDGER_PAIRS, V114_PREDICATE, V113_PREDICATE);

test('PC-CX-62: D20 quantifies exactly the attribution I11-A defines', () => {
  assert.match(I11, /status = 'APPLIED'/,
    'positive control: I11-A no longer requires every COORDINATOR placeholder to belong to an APPLIED action');
  assert.match(I11, /subject_type = 'TASK'/,
    'positive control: I11-A no longer requires Task attribution');
  // The finding was that ⓪ was wider than the invariant it stands for. Both halves, flipped.
  assert.doesNotMatch(D20_SQL, /a\.status <> 'APPLIED' AND a\.result_session_id IS NULL/,
    'the reviewed predicate still admits every non-APPLIED terminal status');
  assert.match(D20_SQL, /AND a\.status = 'APPLIED'/, 'the purge scope no longer requires an APPLIED dispatch');
  for (const column of [/a\.subject_type = 'TASK'/, /a\.subject_id IS NOT DISTINCT FROM s\.task_id/,
    /t\.project_id = a\.project_id/]) {
    assert.match(D20_SQL, column, `the purge scope does not read the I11-A attribution column ${String(column)}`);
  }
  assert.doesNotMatch(D20, /非 `APPLIED` ⇒ `result_session_id IS NULL`/,
    'the over-broad status rule is still normative text as well as executable SQL');
  // Reverse control: the superseded wording survives, but only where a superseded rule may live.
  assert.doesNotMatch(NORMATIVE, /OR \(a\.status <> 'APPLIED' AND a\.result_session_id IS NULL\)\)/,
    'the reviewed predicate is alive in §1–§18');
  assert.match(between(CONTRACT, '### 22.8 ', '### 22.9 '), /a\.status <> 'APPLIED' AND a\.result_session_id IS NULL/,
    '§22.8 no longer registers the superseded predicate, so nothing holds it out of the normative body');
  assert.match(between(CONTRACT, '### 32.2 ', '### 32.3 '), /result_session_id IS NULL/,
    '§32.2 no longer quotes the superseded predicate verbatim');
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

test('PC-CX-62 on isolated Postgres: a terminal dispatch is not an authorisation to delete',
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
      assert.equal(classified.in_scope, false,
        'a REFUSED action is not an I11-A placeholder, and D20 must no longer admit it');
      assert.match(classified.reason, /never reached APPLIED/, 'the refusal does not name the reason');

      const answers: string[] = [];
      for (const [project, sql] of [['p-function', `SELECT * FROM coordinator_purge_project('p-function')`],
        ['p-bare', `DELETE FROM project WHERE id='p-bare'`]] as const) {
        const answer = await client.query(sql).then(() => 'committed')
          .catch((error: unknown) => message(error).split('\n')[0]);
        assert.match(answer, /PROJECT_PURGE_UNDECIDABLE/, `${project}: the entry point did not fail closed`);
        assert.match(answer, /owner=USER, recovery=HUMAN/, `${project}: the refusal names no owner or recovery`);
        answers.push(answer.replace(/p-function/g, 'p').replace(/p-bare/g, 'p')
          .replace(/-function/g, '').replace(/-bare/g, ''));
      }
      assert.equal(answers[0], answers[1],
        'the two entry points still disagree on the same committed fact — that is PC-CX-62');
      const kept = (await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM session WHERE id IN ('s-function','s-bare')`)).rows[0].n;
      assert.equal(kept, '2', 'a Session neither entry point may delete was deleted anyway');

      // Reverse control: v1.13's predicate, rebuilt from this same contract text. The witness the
      // review published — the function deletes what the bare DELETE keeps — must still reproduce.
      await client.query(LEDGER_PAIRS_V113);
      const asV113 = (await client.query<{ in_scope: boolean }>(
        `SELECT in_scope FROM coordinator_purge_ledger_pairs('p-function')`)).rows[0];
      assert.equal(asV113.in_scope, true, 'PC-CX-62 must reproduce: v1.13 called this pair in scope');
      const purged = (await client.query<{ purged_actions: string; purged_sessions: string }>(
        `SELECT * FROM coordinator_purge_project('p-function')`)).rows[0];
      assert.deepEqual(purged, { purged_actions: '1', purged_sessions: '1' });
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM session WHERE id='s-function'`)).rows[0].n, 0,
        'PC-CX-62 must reproduce: the malformed Session is physically deleted under v1.13');
      const bare = await client.query(`DELETE FROM project WHERE id='p-bare'`)
        .then(() => 'committed').catch((error: unknown) => message(error).split('\n')[0]);
      assert.match(bare, /PROJECT_PURGE_UNDECLARED/,
        'PC-CX-62 must reproduce: the bare entry point refuses the same shape the function deleted');
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM session WHERE id='s-bare'`)).rows[0].n, 1,
        'PC-CX-62 must reproduce: one committed fact, two committed results');
      console.log(`PC-CX-62 closed=${JSON.stringify({ classified, kept, v113: { function: purged, bare } })}`);
    } finally {
      await client.end();
    }
  });

test('PC-CX-62 on isolated Postgres: a Session attributed to another Project is out of scope',
  { skip: URL ? false : 'set isolated Coordinator PostgreSQL identity variables to run' }, async () => {
    const client = await connect();
    const seed = async (): Promise<void> => {
      await client.query(`
        INSERT INTO project VALUES ('p-owner'), ('p-foreign');
        INSERT INTO task VALUES ('t-owner','p-owner'), ('t-foreign','p-foreign');
        INSERT INTO project_action (id,project_id,type,status,subject_id)
          VALUES ('a-owner','p-owner','DISPATCH_TASK','CLAIMED','t-owner');
        INSERT INTO session VALUES ('s-foreign','t-foreign','COORDINATOR','a-owner');
        UPDATE project_action SET status='APPLIED', result_session_id='s-foreign' WHERE id='a-owner';
      `);
    };
    try {
      await buildFixture(client);
      await seed();
      const classified = (await client.query<{ in_scope: boolean; reason: string }>(
        `SELECT in_scope, reason FROM coordinator_purge_ledger_pairs('p-owner')`)).rows[0];
      assert.equal(classified.in_scope, false,
        'D20 still does not read the Session Task or action subject columns I11-A requires');
      assert.match(classified.reason, /different task than this session runs/,
        'the refusal does not name the attribution that failed');
      for (const sql of [`SELECT * FROM coordinator_purge_project('p-owner')`,
        `DELETE FROM project WHERE id='p-owner'`]) {
        const answer = await client.query(sql).then(() => 'committed')
          .catch((error: unknown) => message(error).split('\n')[0]);
        assert.match(answer, /PROJECT_PURGE_UNDECIDABLE/, 'a cross-Project link did not fail closed');
        assert.match(answer, /owner=USER, recovery=HUMAN/, 'the refusal names no owner or recovery');
      }
      assert.deepEqual((await client.query<{ session: string; project: string; task: string }>(
        `SELECT (SELECT count(*)::text FROM session WHERE id='s-foreign') AS session,
                (SELECT count(*)::text FROM project WHERE id='p-foreign') AS project,
                (SELECT count(*)::text FROM task    WHERE id='t-foreign') AS task`)).rows[0],
      { session: '1', project: '1', task: '1' },
      'purging one Project must leave the other Project, its Task and its Session untouched');

      // Reverse control: the same fixture under v1.13's predicate loses the foreign Session.
      await buildFixture(client);
      await seed();
      await client.query(LEDGER_PAIRS_V113);
      assert.equal((await client.query<{ in_scope: boolean }>(
        `SELECT in_scope FROM coordinator_purge_ledger_pairs('p-owner')`)).rows[0].in_scope, true,
      'PC-CX-62 must reproduce: v1.13 called a foreign-Task placeholder in scope');
      assert.deepEqual((await client.query<{ purged_actions: string; purged_sessions: string }>(
        `SELECT * FROM coordinator_purge_project('p-owner')`)).rows[0],
      { purged_actions: '1', purged_sessions: '1' });
      const after = (await client.query<{ session: string; project: string; task: string }>(
        `SELECT (SELECT count(*)::text FROM session WHERE id='s-foreign') AS session,
                (SELECT count(*)::text FROM project WHERE id='p-foreign') AS project,
                (SELECT count(*)::text FROM task    WHERE id='t-foreign') AS task`)).rows[0];
      assert.deepEqual(after, { session: '0', project: '1', task: '1' },
        'PC-CX-62 must reproduce: purging one Project deleted the Session of another, which stayed');
      console.log(`PC-CX-62 attribution=${JSON.stringify({ classified, v113: after })}`);
    } finally {
      await client.end();
    }
  });
