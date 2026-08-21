import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';

// Unit 02's independent review of the v1.12 Coordinator contract. v1.13 closes `PC-CX-58..61`, so
// every assertion below is flipped the way §26–§31 flip the rounds before it: it now proves the old
// shape is refused (or that the promised path exists), and it keeps the v1.12 shape alive inside
// the same test as a reverse control. Nothing here edits the review reports or the contract; the
// SQL under test is read straight out of the contract, so a revision that moves a clause without
// moving its object turns this file red rather than silently passing.
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

/** Rebuild a superseded shape out of the current clause, and fail loudly if the anchor moved. */
function rewrite(sql: string, from: string, to: string): string {
  assert.ok(sql.includes(from), `the reverse control anchor "${from}" is no longer in the contract`);
  return sql.split(from).join(to);
}

/**
 * D20 creates a constraint and three triggers alongside its functions. A reverse control replays it
 * on a fixture that already has all of them, and only the function bodies are what it is varying —
 * so keep those and drop the rest. It fails loudly if D20 stops opening with the constraint.
 */
function functionsOnly(sql: string): string {
  const at = sql.indexOf('CREATE OR REPLACE FUNCTION');
  assert.ok(at > 0 && sql.slice(0, at).includes('ADD CONSTRAINT session_project_action_fk'),
    'D20 no longer opens with the lineage constraint, so this reverse control is replaying the wrong thing');
  const body = sql.slice(at);
  assert.match(body, /CREATE TRIGGER/, 'D20 no longer creates the triggers this helper is meant to drop');
  return body.replace(/CREATE TRIGGER[\s\S]*?;/g, '');
}

const INFRA = between(CONTRACT, '### 2.4 ', '## 3. 词汇表');
const NORMATIVE = CONTRACT.slice(0, CONTRACT.indexOf('\n## 19. '));
const D18 = between(CONTRACT, '#### D18 ', '#### D19 ');
const D18_SQL = firstSql(D18);
const D19 = between(CONTRACT, '#### D19 ', '#### D20 ');
const D19_SQL = firstSql(D19);
const D20 = between(CONTRACT, '#### D20 ', '#### D7 ');
const D20_SQL = firstSql(D20);
const MIGRATION_TABLE = between(CONTRACT, '迁移 `0111_project_coordinator`', '- **G1');
const MIGRATION_ROW = (label: string): string =>
  MIGRATION_TABLE.split('\n').find((line) => line.includes(`**${label}**`)) ?? '';

test('PC-CX-58: the lineage FK now has exactly one initial mode in every current clause', () => {
  // The finding was two *current* answers, so the closing assertion is that all four agree.
  const clauses: [string, string][] = [
    ['§2.4 on-delete table', INFRA.split('\n').find((l) => l.includes('session.projectActionId → project_action.id')) ?? ''],
    ['D20 ① SQL', D20_SQL],
    ['§12.1 step 6h', MIGRATION_ROW('6h')],
    ['§7.7 D19-c', D19],
  ];
  for (const [where, text] of clauses) {
    assert.match(text, /INITIALLY IMMEDIATE/, `${where} no longer states the single initial mode`);
    assert.doesNotMatch(text, /INITIALLY DEFERRED/,
      `${where} still gives the lineage FK a second initial mode — that is PC-CX-58`);
  }
  // The v1.12 wording survives, but only where a superseded rule is allowed to live.
  assert.doesNotMatch(NORMATIVE, /NO ACTION DEFERRABLE INITIALLY DEFERRED/,
    'the superseded wording is alive in §1–§18');
  assert.match(between(CONTRACT, '### 22.8 ', '### 22.9 '), /NO ACTION DEFERRABLE INITIALLY DEFERRED/,
    '§22.8 no longer registers the superseded wording, so nothing holds it out of the normative body');
  assert.match(between(CONTRACT, '### 31.5 ', '### 31.6 '), /NO ACTION DEFERRABLE INITIALLY DEFERRED/,
    '§31.5 no longer quotes the superseded wording verbatim');
  // And the contract now states the uniqueness as a clause with a mechanical check behind it.
  assert.ok(D20.includes('**D20-l（'), 'D20 does not state the single-initial-mode clause');
  assert.match(D20, /condeferrable/, 'D20-l does not name the catalog columns that tell the two apart');
  assert.match(D20, /condeferred/, 'D20-l does not name the column the two versions actually differ on');
});

test('PC-CX-59: the one-shot migration table installs every v1.11 database object', () => {
  const row6g = MIGRATION_ROW('6g');
  const row6g2 = MIGRATION_ROW('6g2');
  const row6h = MIGRATION_ROW('6h');
  assert.match(row6g, /v1\.10/, 'positive control: 6g is still the v1.10 row');
  assert.ok(row6g2, 'there is still no migration row for the three v1.11 objects — that is PC-CX-59');
  assert.match(row6g2, /v1\.11/, '6g2 does not say which version it lands');
  for (const object of ['project_action_result_session_fk', 'session_result_link_delete_guard',
    'project_action_result_ledger_mutator', 'BEFORE INSERT OR UPDATE']) {
    assert.ok(row6g2.includes(object), `6g2 does not install ${object}`);
  }
  // Dependency order: audits first, then D18's event surface, then D19's two objects, then D20.
  assert.ok(row6g2.indexOf('D18-e') < row6g2.indexOf('BEFORE INSERT OR UPDATE'),
    'the existing-data audits must run before the trigger they gate');
  assert.ok(row6g2.indexOf('D19-e') < row6g2.indexOf('project_action_result_session_fk'),
    'the D19-e audit must run before the foreign key it decides');
  assert.ok(row6g2.indexOf('project_action_result_session_fk') < row6g2.indexOf('session_result_link_delete_guard'),
    'the structural half must land before the typed half');
  assert.ok(MIGRATION_TABLE.indexOf('**6g2**') < MIGRATION_TABLE.indexOf('**6h**'),
    '6g2 must precede 6h: D20-g assumes both ledger gates are already in place');
  assert.match(row6h, /v1\.12/, 'positive control: 6h is still the D20 row');
  assert.match(row6h, /coordinator_project_publish_fence/, '6h does not install the v1.13 publish fence');
  assert.match(row6h, /coordinator_purge_ledger_pairs/, '6h does not install the v1.13 quantification domain');
  // And the normative function body the table has to agree with.
  assert.match(D18_SQL, /BEFORE INSERT OR UPDATE ON project_action/, 'D18 is no longer the event surface 6g2 installs');
  assert.match(D19_SQL, /project_action_result_session_fk/, 'D19 no longer states the structural object');
  assert.match(D19_SQL, /session_result_link_delete_guard/, 'D19 no longer states the typed object');
  // Reverse control: the v1.12 table jumped straight from 6g to 6h, so 6h alone had to carry them.
  assert.doesNotMatch(row6h, /session_result_link_delete_guard/,
    'the v1.11 objects belong to 6g2; 6h carrying them would hide the ordering the finding is about');
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

function errorMessage(error: unknown): string {
  return String((error as { message?: string }).message ?? error);
}

const LEDGER_TABLES = `
    CREATE TABLE project (id text PRIMARY KEY);
    -- v1.14 (PC-CX-62): D20 ⓪ is §4.3 I11-A's attribution closure, so the fixture carries the three
    -- columns it reads. Every shape below states its own attribution; nothing else changed.
    CREATE TABLE task (id text PRIMARY KEY, project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE);
    CREATE TABLE project_action (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      type text NOT NULL,
      status text NOT NULL,
      result_session_id text,
      detail jsonb NOT NULL DEFAULT '{"retiredPins":[]}'::jsonb,
      subject_type text NOT NULL DEFAULT 'TASK',
      subject_id text
    );
    CREATE TABLE session (
      id text PRIMARY KEY,
      dispatch_origin text NOT NULL,
      project_action_id text UNIQUE,
      task_id text
    );
    CREATE INDEX project_action_result_session_idx ON project_action(result_session_id);
    CREATE INDEX project_action_project_idx ON project_action(project_id);
`;

async function buildPurgeFixture(client: Client, schema: string): Promise<void> {
  await resetSchema(client, schema);
  await client.query(LEDGER_TABLES);
  await client.query(D18_SQL);
  await client.query(D19_SQL);
  await client.query(D20_SQL);
}

/**
 * Every object §12.1's steps 6g2 and 6h are required to leave behind, read out of the catalog.
 * Every lookup is scoped to the fixture schema: the three migration paths install same-named
 * objects side by side, and an unscoped `pg_trigger`/`pg_constraint` read would answer for
 * whichever schema happened to be created first.
 */
const OBJECT_CENSUS = `
  WITH ns AS (SELECT current_schema()::regnamespace AS oid),
       trg AS (SELECT t.* FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                WHERE NOT t.tgisinternal AND c.relnamespace = (SELECT oid FROM ns)),
       con AS (SELECT c.* FROM pg_constraint c WHERE c.connamespace = (SELECT oid FROM ns))
  SELECT
    (SELECT (t.tgtype & 4) > 0 FROM trg t WHERE t.tgname = 'project_action_result_ledger_mutator') AS d18_on_insert,
    (SELECT (t.tgtype & 16) > 0 FROM trg t WHERE t.tgname = 'project_action_result_ledger_mutator') AS d18_on_update,
    (SELECT c.confdeltype::text FROM con c WHERE c.conname = 'project_action_result_session_fk') AS d19_fk_on_delete,
    (SELECT count(*)::int FROM trg t WHERE t.tgname = 'session_result_link_delete_guard') AS d19_guard,
    (SELECT c.condeferrable FROM con c WHERE c.conname = 'session_project_action_fk') AS fk_deferrable,
    (SELECT c.condeferred FROM con c WHERE c.conname = 'session_project_action_fk') AS fk_deferred,
    (SELECT c.confdeltype::text FROM con c WHERE c.conname = 'session_project_action_fk') AS fk_on_delete,
    (SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM ns)
        AND p.proname IN ('coordinator_purge_ledger_pairs','coordinator_purge_lock_ledger',
                          'coordinator_purge_project','project_purge_fence','coordinator_project_publish_fence')) AS d20_functions,
    (SELECT count(*)::int FROM trg t
      WHERE t.tgname IN ('project_purge_fence','coordinator_project_publish_fence')) AS d20_triggers`;

test('PC-CX-58 on isolated Postgres: the lineage FK is immediate by default and deferrable only on demand',
  { skip: URL ? false : 'set isolated Coordinator PostgreSQL identity variables to run' }, async () => {
    const client = await connect();
    try {
      await buildPurgeFixture(client, 'pcc_v112_review_initial_mode');
      const fk = (await client.query<{ condeferrable: boolean; condeferred: boolean;
        confdeltype: string; confupdtype: string }>(`
        SELECT condeferrable, condeferred, confdeltype::text, confupdtype::text
          FROM pg_constraint
         WHERE conname = 'session_project_action_fk'
           AND connamespace = current_schema()::regnamespace`)).rows[0];
      assert.deepEqual(fk, { condeferrable: true, condeferred: false, confdeltype: 'a', confupdtype: 'a' },
        'the catalog does not agree with the single initial mode §2.4 / D20 ① / step 6h state');

      await client.query(`
        INSERT INTO project VALUES ('p-mode');
        INSERT INTO project_action (id,project_id,type,status) VALUES ('a-mode','p-mode','DISPATCH_TASK','CLAIMED');
        INSERT INTO session VALUES ('s-mode','COORDINATOR','a-mode');
      `);
      // The behavioural half: the catalog columns are not the claim, "when does it refuse" is.
      await client.query('BEGIN');
      await assert.rejects(client.query(`DELETE FROM project_action WHERE id='a-mode'`), (error: unknown) => {
        assert.equal(errorCode(error), '23503');
        assert.equal(errorConstraint(error), 'session_project_action_fk');
        return true;
      }, 'INITIALLY IMMEDIATE must refuse on the statement, exactly as v1.11 RESTRICT did');
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      await client.query('SET CONSTRAINTS session_project_action_fk DEFERRED');
      await client.query(`DELETE FROM project_action WHERE id='a-mode'`);   // now it passes the statement…
      await assert.rejects(client.query('COMMIT'), (error: unknown) => {
        assert.equal(errorCode(error), '23503');
        return true;
      }, '…and is only refused at COMMIT — the difference the two clauses used to disagree about');
      // Reverse control: an immediate RESTRICT of the same name is a different pair of catalog columns.
      await client.query(`ALTER TABLE session DROP CONSTRAINT session_project_action_fk`);
      await client.query(`ALTER TABLE session ADD CONSTRAINT session_project_action_fk
        FOREIGN KEY (project_action_id) REFERENCES project_action(id) ON DELETE RESTRICT ON UPDATE RESTRICT`);
      const v111 = (await client.query<{ condeferrable: boolean; confdeltype: string }>(`
        SELECT condeferrable, confdeltype::text FROM pg_constraint
         WHERE conname='session_project_action_fk'
           AND connamespace = current_schema()::regnamespace`)).rows[0];
      assert.deepEqual(v111, { condeferrable: false, confdeltype: 'r' },
        'positive control: the v1.11 shape is still distinguishable in exactly these columns');
      console.log(`PC-CX-58 witness=${JSON.stringify({ current: fk, v111 })}`);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  });

test('PC-CX-59 on isolated Postgres: empty / v1.10 / v1.11 all converge on the same object set',
  { skip: URL ? false : 'set isolated Coordinator PostgreSQL identity variables to run' }, async () => {
    const client = await connect();
    try {
      // §12.1 step 6g2 ②: CREATE OR REPLACE cannot change a trigger's event list, so the row is a
      // DROP + CREATE. This is that row, executed.
      const step6g2 = async (): Promise<void> => {
        await client.query('DROP TRIGGER IF EXISTS project_action_result_ledger_mutator ON project_action');
        await client.query(D18_SQL);
        await client.query('DROP TRIGGER IF EXISTS session_result_link_delete_guard ON session');
        await client.query('ALTER TABLE project_action DROP CONSTRAINT IF EXISTS project_action_result_session_fk');
        await client.query(D19_SQL);
      };
      const v110D18 = rewrite(D18_SQL, 'BEFORE INSERT OR UPDATE ON project_action', 'BEFORE UPDATE ON project_action');
      const census: Record<string, unknown>[] = [];
      const paths: [string, string, () => Promise<void>][] = [
        ['empty', 'pcc_v112_review_path_empty', async () => undefined],
        ['v1.10', 'pcc_v112_review_path_ten', async () => { await client.query(v110D18); }],
        ['v1.11', 'pcc_v112_review_path_eleven', async () => { await client.query(D18_SQL); await client.query(D19_SQL); }],
      ];
      for (const [label, schema, seed] of paths) {
        await resetSchema(client, schema);
        await client.query(LEDGER_TABLES);
        await seed();
        await step6g2();                     // 6g2
        await client.query(D20_SQL);         // 6h
        const row = (await client.query(OBJECT_CENSUS)).rows[0];
        census.push({ path: label, ...row });
      }
      const [, ...rest] = census;
      for (const row of rest) {
        assert.deepEqual({ ...row, path: undefined }, { ...census[0], path: undefined },
          `the ${row.path} path does not converge on the same object set as an empty database`);
      }
      assert.deepEqual({ ...census[0], path: undefined }, {
        path: undefined,
        d18_on_insert: true, d18_on_update: true,
        d19_fk_on_delete: 'r', d19_guard: 1,
        fk_deferrable: true, fk_deferred: false, fk_on_delete: 'a',
        d20_functions: 5, d20_triggers: 3,
      }, 'the converged object set is not the one §7.7 D18 / D19 / D20 specify');

      // Reverse control: v1.12's table had no 6g2, so a v1.10 database went straight to 6h.
      await resetSchema(client, 'pcc_v112_review_path_skipped');
      await client.query(LEDGER_TABLES);
      await client.query(v110D18);
      await client.query(D20_SQL);
      const skipped = (await client.query(OBJECT_CENSUS)).rows[0];
      assert.equal(skipped.d18_on_insert, false, 'PC-CX-59 must reproduce: D18 stays UPDATE-only without 6g2');
      assert.equal(skipped.d19_fk_on_delete, null, 'PC-CX-59 must reproduce: D19 structural half never exists');
      assert.equal(skipped.d19_guard, 0, 'PC-CX-59 must reproduce: D19 typed half never exists');
      console.log(`PC-CX-59 witness=${JSON.stringify({ converged: census.map((c) => c.path), skipped })}`);
    } finally {
      await client.end();
    }
  });

/** The five shapes D20-c excludes and D20-i must refuse, each seeded on its own Project. */
const UNDECIDABLE_SHAPES: { project: string; seed: string; reason: RegExp; kept: string }[] = [
  {
    project: 'p-user',
    seed: `INSERT INTO session VALUES ('s-user','USER',NULL);
           INSERT INTO project_action (id,project_id,type,status,result_session_id)
             VALUES ('a-user','p-user','DISPATCH_TASK','REFUSED','s-user');`,
    reason: /not a COORDINATOR placeholder/,
    kept: 's-user',
  },
  {
    project: 'p-oneway',
    seed: `INSERT INTO session VALUES ('s-oneway','COORDINATOR',NULL);
           INSERT INTO project_action (id,project_id,type,status,result_session_id)
             VALUES ('a-oneway','p-oneway','DISPATCH_TASK','APPLIED','s-oneway');`,
    reason: /one-way/,
    kept: 's-oneway',
  },
  {
    project: 'p-cross',
    seed: `INSERT INTO task VALUES ('t-cross','p-cross');
           INSERT INTO project_action (id,project_id,type,status,subject_id) VALUES ('a-cross','p-cross','DISPATCH_TASK','CLAIMED','t-cross');
           INSERT INTO session VALUES ('s-cross','COORDINATOR','a-cross','t-cross');
           UPDATE project_action SET status='APPLIED', result_session_id='s-cross' WHERE id='a-cross';
           INSERT INTO project VALUES ('p-other');
           INSERT INTO project_action (id,project_id,type,status,result_session_id)
             VALUES ('a-other','p-other','DISPATCH_TASK','APPLIED','s-cross');`,
    reason: /another project ledger/,
    kept: 's-cross',
  },
  {
    project: 'p-type',
    seed: `INSERT INTO project_action (id,project_id,type,status) VALUES ('a-type','p-type','ROTATE_COORDINATOR_SESSION','APPLIED');
           INSERT INTO session VALUES ('s-type','COORDINATOR','a-type');`,
    reason: /not a DISPATCH_TASK/,
    kept: 's-type',
  },
  {
    project: 'p-status',
    seed: `INSERT INTO project_action (id,project_id,type,status) VALUES ('a-status','p-status','DISPATCH_TASK','CLAIMED');
           INSERT INTO session VALUES ('s-status','COORDINATOR','a-status');
           UPDATE project_action SET status='REFUSED', result_session_id='s-status' WHERE id='a-status';`,
    reason: /unpublished dispatch already carries a result link/,
    kept: 's-status',
  },
];

test('PC-CX-60 on isolated Postgres: every undecidable link fails closed on both entry points',
  { skip: URL ? false : 'set isolated Coordinator PostgreSQL identity variables to run' }, async () => {
    const client = await connect();
    try {
      await buildPurgeFixture(client, 'pcc_v112_review_purge_scope');
      for (const shape of UNDECIDABLE_SHAPES) {
        await client.query(`INSERT INTO project VALUES ('${shape.project}')`);
        await client.query(shape.seed);
      }
      // Positive controls, so "it refuses everything" cannot pass this test. v1.14 (PC-CX-62) moves
      // `p-unpublished` across the line: I11-A only ever attributed a placeholder to an APPLIED
      // dispatch, so an unpublished one is existing data to adjudicate, not a row to sweep.
      await client.query(`
        INSERT INTO project VALUES ('p-ok'), ('p-unpublished'), ('p-empty');
        INSERT INTO task VALUES ('t-ok','p-ok'), ('t-unpublished','p-unpublished');
        INSERT INTO project_action (id,project_id,type,status,subject_id) VALUES
          ('a-ok','p-ok','DISPATCH_TASK','CLAIMED','t-ok'),
          ('a-unpublished','p-unpublished','DISPATCH_TASK','CLAIMED','t-unpublished');
        INSERT INTO session VALUES ('s-ok','COORDINATOR','a-ok','t-ok'),
          ('s-unpublished','COORDINATOR','a-unpublished','t-unpublished');
        UPDATE project_action SET status='APPLIED', result_session_id='s-ok' WHERE id='a-ok';
      `);

      const witness: Record<string, string[]> = {};
      for (const shape of UNDECIDABLE_SHAPES) {
        const seen: string[] = [];
        for (const [entry, sql] of [
          ['function', `SELECT * FROM coordinator_purge_project('${shape.project}')`],
          ['bare', `DELETE FROM project WHERE id='${shape.project}'`],
        ] as const) {
          await assert.rejects(client.query(sql), (error: unknown) => {
            assert.match(errorMessage(error), /PROJECT_PURGE_UNDECIDABLE/,
              `${shape.project} via ${entry} is not refused with the typed code D20-i states`);
            assert.match(errorMessage(error), shape.reason, `${shape.project} via ${entry} names the wrong reason`);
            assert.match(errorMessage(error), /owner=USER, recovery=HUMAN/,
              `${shape.project} via ${entry} has no owner or recovery`);
            seen.push(errorMessage(error).split('\n')[0]);
            return true;
          });
        }
        assert.equal(seen[0], seen[1], `${shape.project}: the two entry points give different answers — that is PC-CX-60`);
        witness[shape.project] = seen;
        // …and the data is still there. This is the assertion the finding is actually about.
        assert.equal((await client.query(
          `SELECT count(*)::int AS n FROM session WHERE id='${shape.kept}'`)).rows[0].n, 1,
        `${shape.project}: the session D20-c excludes was deleted anyway`);
      }

      assert.deepEqual((await client.query(`SELECT * FROM coordinator_purge_project('p-ok')`)).rows[0],
        { purged_actions: '1', purged_sessions: '1' }, 'positive control: a well-formed linked Project must still purge');
      await assert.rejects(client.query(`SELECT * FROM coordinator_purge_project('p-unpublished')`),
        (error: unknown) => {
          assert.match(errorMessage(error), /PROJECT_PURGE_UNDECIDABLE/,
            'v1.14 control: an unpublished dispatch is not an I11-A placeholder and must fail closed');
          assert.match(errorMessage(error), /never reached APPLIED/, 'and the refusal must name why');
          return true;
        });
      assert.equal((await client.query(
        `SELECT count(*)::int AS n FROM session WHERE id='s-unpublished'`)).rows[0].n, 1,
      'v1.14 control: and nothing was deleted (PC-CX-62)');
      await client.query(`DELETE FROM project WHERE id='p-empty'`);

      // Reverse control: v1.12's raw OR predicate, rebuilt from the current function.
      let v112 = functionsOnly(D20_SQL);
      // ③-6 back to the bare OR union…
      v112 = rewrite(v112,
        `SELECT COALESCE(array_agg(DISTINCT session_id), '{}'::text[]) INTO doomed
    FROM coordinator_purge_ledger_pairs(p_project_id) WHERE in_scope;`,
        `SELECT COALESCE(array_agg(DISTINCT s.id), '{}'::text[]) INTO doomed
    FROM session s JOIN project_action a ON a.id = s.project_action_id OR a.result_session_id = s.id
   WHERE a.project_id = p_project_id;`);
      // …and both entry points back to having no quantification-domain adjudication at all.
      for (const owner of ['p_project_id', 'OLD.id']) {
        v112 = rewrite(v112,
          `SELECT * INTO bad FROM coordinator_purge_ledger_pairs(${owner})
   WHERE NOT in_scope ORDER BY action_id, session_id LIMIT 1;`,
          `SELECT * INTO bad FROM coordinator_purge_ledger_pairs(${owner}) WHERE false;`);
      }
      v112 = rewrite(v112,
        `SELECT count(DISTINCT session_id) INTO stranded
    FROM coordinator_purge_ledger_pairs(OLD.id) WHERE in_scope;`,
        `SELECT count(DISTINCT s.id) INTO stranded
    FROM session s JOIN project_action a ON a.id = s.project_action_id
   WHERE a.project_id = OLD.id;`);
      await client.query(v112);
      await client.query(`
        INSERT INTO project VALUES ('p-v112-fn'), ('p-v112-bare');
        INSERT INTO session VALUES ('s-v112-fn','USER',NULL), ('s-v112-bare','USER',NULL);
        INSERT INTO project_action (id,project_id,type,status,result_session_id) VALUES
          ('a-v112-fn','p-v112-fn','DISPATCH_TASK','REFUSED','s-v112-fn');
      `);
      const reverted = (await client.query<{ purged_actions: string; purged_sessions: string }>(
        `SELECT * FROM coordinator_purge_project('p-v112-fn')`)).rows[0];
      assert.deepEqual(reverted, { purged_actions: '1', purged_sessions: '1' },
        'PC-CX-60 must reproduce: the v1.12 OR predicate treats a reverse link alone as permission to delete');
      assert.equal((await client.query(
        `SELECT count(*)::int AS n FROM session WHERE id='s-v112-fn'`)).rows[0].n, 0,
      'PC-CX-60 must reproduce: the USER Session D20-c excludes is physically deleted');
      console.log(`PC-CX-60 witness=${JSON.stringify({ refused: Object.keys(witness), v112: 'USER session deleted' })}`);
    } finally {
      await client.end();
    }
  });

test('PC-CX-61 on isolated Postgres: both commit orders have a typed winner',
  { skip: URL ? false : 'set isolated Coordinator PostgreSQL identity variables to run' }, async () => {
    const purger = await connect();
    const publisher = await connect();
    const observer = await connect();
    const schema = 'pcc_v112_review_purge_race';
    const seed = async (p: string): Promise<void> => {
      await observer.query(`
        INSERT INTO project VALUES ('${p}');
        INSERT INTO task VALUES ('${p}-t-old','${p}'), ('${p}-t-late','${p}');
        INSERT INTO project_action (id,project_id,type,status,subject_id) VALUES
          ('${p}-a-old','${p}','DISPATCH_TASK','CLAIMED','${p}-t-old'),
          ('${p}-a-late','${p}','DISPATCH_TASK','CLAIMED','${p}-t-late');
        INSERT INTO session VALUES ('${p}-s-old','COORDINATOR','${p}-a-old','${p}-t-old');
        UPDATE project_action SET status='APPLIED', result_session_id='${p}-s-old' WHERE id='${p}-a-old';
      `);
    };
    const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 250));
    try {
      await buildPurgeFixture(purger, schema);
      for (const c of [publisher, observer]) await c.query(`SET search_path TO ${schema}, public`);

      // ── purge-wins: the publication blocks on the fence and gets a typed answer, not a 23503.
      await seed('r1');
      await purger.query('BEGIN');
      const purge1 = purger.query<{ purged_actions: string; purged_sessions: string }>(
        `SELECT * FROM coordinator_purge_project('r1')`);
      await settle();
      await publisher.query('BEGIN');
      let blocked = true;
      const publish1 = publisher.query(`INSERT INTO session VALUES ('r1-s-late','COORDINATOR','r1-a-late','r1-t-late')`)
        .then(() => { blocked = false; return 'committed'; })
        .catch((error: unknown) => { blocked = false; return errorMessage(error).split('\n')[0]; });
      await settle();
      assert.equal(blocked, true, 'the publication did not queue on the shared linearization point');
      assert.deepEqual((await purge1).rows[0], { purged_actions: '2', purged_sessions: '1' });
      await purger.query('COMMIT');
      const loser = await publish1;
      assert.match(loser, /PROJECT_PURGED/, 'the losing publication got no typed result');
      assert.match(loser, /owner=SYSTEM, recovery=EVENT/, 'the losing publication got no owner or recovery');
      assert.doesNotMatch(loser, /23503/, 'a bare 23503 is a structural backstop, not normal control flow');
      await publisher.query('ROLLBACK');
      assert.deepEqual((await observer.query<{ p: number; a: number; s: number }>(`
        SELECT (SELECT count(*)::int FROM project WHERE id='r1') AS p,
               (SELECT count(*)::int FROM project_action WHERE project_id='r1') AS a,
               (SELECT count(*)::int FROM session WHERE id LIKE 'r1-%') AS s`)).rows[0],
      { p: 0, a: 0, s: 0 }, 'purge-wins must leave nothing of the project behind');

      // ── publish-wins: the purge queues on ③-1 and the late placeholder is inside its snapshot.
      await seed('r2');
      await publisher.query('BEGIN');
      await publisher.query(`INSERT INTO session VALUES ('r2-s-late','COORDINATOR','r2-a-late','r2-t-late')`);
      await publisher.query(`UPDATE project_action SET status='APPLIED', result_session_id='r2-s-late' WHERE id='r2-a-late'`);
      await purger.query('BEGIN');
      const purge2 = purger.query<{ purged_actions: string; purged_sessions: string }>(
        `SELECT * FROM coordinator_purge_project('r2')`).then((r) => r.rows[0]).catch((e: unknown) => errorMessage(e));
      await settle();
      await publisher.query('COMMIT');
      assert.deepEqual(await purge2, { purged_actions: '2', purged_sessions: '2' },
        'publish-wins must sweep the placeholder that committed before the snapshot');
      await purger.query('COMMIT');
      assert.equal((await observer.query(PURGE_ORPHANS)).rows[0].n, '0', 'publish-wins left an orphan lineage');

      // ── the bypass: a writer that skips ④ holds an action row lock. NOWAIT ⇒ typed, not 40P01.
      await seed('r3');
      await observer.query('DROP TRIGGER coordinator_project_publish_fence ON project_action');
      await publisher.query('BEGIN');
      await publisher.query(`UPDATE project_action SET detail = detail || '{"display":"x"}'::jsonb WHERE id='r3-a-late'`);
      await purger.query('BEGIN');
      const contended = await purger.query(`SELECT * FROM coordinator_purge_project('r3')`)
        .then(() => 'committed').catch((e: unknown) => errorMessage(e).split('\n')[0]);
      assert.match(contended, /PROJECT_PURGE_CONTENDED/, 'the bypass produced a native deadlock instead of a typed refusal');
      assert.match(contended, /owner=SYSTEM, recovery=EVENT/, 'the contention refusal names no owner or recovery');
      await purger.query('ROLLBACK');
      await publisher.query('COMMIT');
      assert.deepEqual((await observer.query<{ purged_actions: string; purged_sessions: string }>(
        `SELECT * FROM coordinator_purge_project('r3')`)).rows[0], { purged_actions: '2', purged_sessions: '1' },
      'the retry after the other transaction settles must succeed — the refusal has to be idempotent');
      console.log(`PC-CX-61 witness=${JSON.stringify({
        purgeWins: loser.slice(0, 40), publishWins: '(2,2)', bypass: contended.slice(0, 40) })}`);

      // ── reverse control: v1.12's D20 had neither ③-2 nor ④, so the same interleaving aborts the purge.
      await purger.query(rewrite(functionsOnly(D20_SQL),
        '  PERFORM coordinator_purge_lock_ledger(p_project_id);\n', ''));
      await purger.query('DROP TRIGGER IF EXISTS coordinator_project_publish_fence ON session');
      await purger.query('DROP TRIGGER IF EXISTS coordinator_project_publish_fence ON project_action');
      await seed('r4');
      await purger.query('BEGIN');
      await purger.query(`SELECT 1 FROM project WHERE id='r4' FOR UPDATE`);
      await purger.query(`SELECT set_config('coordinator.purging_project','r4',true)`);
      await purger.query('SET CONSTRAINTS session_project_action_fk DEFERRED');
      const doomed = (await purger.query<{ doomed: string[] }>(
        `SELECT COALESCE(array_agg(DISTINCT session_id), '{}'::text[]) AS doomed
           FROM coordinator_purge_ledger_pairs('r4') WHERE in_scope`)).rows[0].doomed;
      assert.deepEqual(doomed, ['r4-s-old'], 'positive control: the late publication is not in the snapshot yet');
      await publisher.query('BEGIN');
      await publisher.query(`INSERT INTO session VALUES ('r4-s-late','COORDINATOR','r4-a-late','r4-t-late')`);
      await publisher.query(`UPDATE project_action SET status='APPLIED', result_session_id='r4-s-late' WHERE id='r4-a-late'`);
      await publisher.query('COMMIT');
      await purger.query(`DELETE FROM project WHERE id='r4'`);
      await purger.query(`DELETE FROM session WHERE id = ANY($1::text[])`, [doomed]);
      await assert.rejects(purger.query('COMMIT'), (error: unknown) => {
        assert.equal(errorCode(error), '23503');
        assert.equal(errorConstraint(error), 'session_project_action_fk');
        return true;
      }, 'PC-CX-61 must reproduce: without ③-2 and ④ the stale snapshot aborts the whole purge');
      assert.deepEqual((await observer.query<{ p: number; a: number; s: number }>(`
        SELECT (SELECT count(*)::int FROM project WHERE id='r4') AS p,
               (SELECT count(*)::int FROM project_action WHERE project_id='r4') AS a,
               (SELECT count(*)::int FROM session WHERE id LIKE 'r4-%') AS s`)).rows[0],
      { p: 1, a: 2, s: 2 }, 'PC-CX-61 must reproduce: the structural gate saves the invariant by rolling everything back');
    } finally {
      for (const c of [purger, publisher, observer]) await c.query('ROLLBACK').catch(() => undefined);
      await Promise.all([purger.end(), publisher.end(), observer.end()]);
    }
  });

/** §4.3 I17-A3's lineage half as a query: no session may point at an action row that is gone. */
const PURGE_ORPHANS = `
  SELECT count(*)::text AS n FROM session s
   WHERE s.project_action_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM project_action a WHERE a.id = s.project_action_id)`;
