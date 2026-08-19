import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';

// Unit 02's independent review of the v1.11 Coordinator contract. These tests deliberately do not
// edit the authoritative contract or the development fixtures: they exercise legal paths that the
// v1.11 closure tests do not cover. The PostgreSQL cases only run after the shared isolation guard
// has verified the dedicated database, role, and server system identifier.
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
const D19 = between(CONTRACT, '#### D19 ', '#### D7 ');
const D19_SQL = firstSql(D19);

test('PC-CX-56: the declared two-way RESTRICT topology has no Project-purge transition', () => {
  assert.match(INFRA, /五张新表，全部 `onDelete: Cascade` 挂在 `project` 下/,
    'the action ledger is no longer declared to cascade with its Project');
  assert.match(INFRA, /`project_action\.result_session_id → session\.id` \| \*\*RESTRICT\*\*/,
    'the action-to-Session side is no longer RESTRICT');
  assert.match(INFRA, /`session\.projectActionId → project_action\.id` \| \*\*RESTRICT\*\*/,
    'the Session-to-action side is no longer RESTRICT');
  assert.match(D19, /物理清除的粒度是 Project，不是 Session/,
    'D19-c no longer claims that deleting the Project releases the linked Session');

  // The three durable objects form a cycle. Deleting the Project cascades to the action, but the
  // Session's RESTRICT reference refuses that delete. Deleting the Session first is refused by the
  // action's RESTRICT reference. Neither link may be cleared under D15/D18.
  type ObjectName = 'project' | 'action' | 'session';
  const present = new Set<ObjectName>(['project', 'action', 'session']);
  const canDelete = (object: ObjectName): boolean => {
    if (object === 'session') return !present.has('action');
    if (object === 'action') return !present.has('session');
    return !present.has('action'); // the cascade must be able to delete action first
  };
  assert.equal(canDelete('session'), false, 'action → Session RESTRICT blocks Session-first purge');
  assert.equal(canDelete('action'), false, 'Session → action RESTRICT blocks action-first purge');
  assert.equal(canDelete('project'), false, 'Project cascade cannot cross the same action restriction');
});

test('PC-CX-57: the malformed-ledger compatibility return bypasses unrelated immutable fields', () => {
  const malformed = D18_SQL.indexOf("IF jsonb_typeof(new_ledger) <> 'array'");
  const earlyReturn = D18_SQL.indexOf('RETURN NEW;', malformed);
  const linkFreeze = D18_SQL.indexOf('IF OLD.result_session_id IS NOT NULL');
  const claimFreeze = D18_SQL.indexOf("IF OLD.detail ? 'claimResolution'");
  assert.ok(malformed >= 0 && earlyReturn > malformed, 'D18 has no malformed-ledger compatibility branch');
  assert.ok(earlyReturn < linkFreeze && earlyReturn < claimFreeze,
    'the compatibility branch no longer returns before the unrelated link/claim checks');
  assert.match(D18, /新旧值逐字相同[^\n]*放行/,
    'D18-g no longer declares the compatibility path this test attacks');

  const mutator = (oldLedger: unknown, newLedger: unknown, rewritesClaim: boolean): 'ALLOW' | 'REFUSE' => {
    if (!Array.isArray(newLedger)) {
      if (JSON.stringify(oldLedger) === JSON.stringify(newLedger)) return 'ALLOW';
      return 'REFUSE';
    }
    if (rewritesClaim) return 'REFUSE';
    return 'ALLOW';
  };
  assert.equal(mutator({}, {}, true), 'ALLOW',
    'an unchanged malformed retiredPins currently disables claimResolution immutability');
  assert.equal(mutator([], [], true), 'REFUSE',
    'the identical claim rewrite is refused as soon as retiredPins is a legal array');
});

type ClientCtor = new (config: { connectionString?: string }) => Client;

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const { Client: Ctor } = (await import('pg')) as unknown as { Client: ClientCtor };
  const client = new Ctor({ connectionString: URL });
  await client.connect();
  // This must remain the first query on every connection. Fixture DDL follows only after it passes.
  await verifyCoordinatorPgIdentity(client);
  return client;
}

async function resetSchema(client: Client, schema: string): Promise<void> {
  assert.match(schema, /^pcc_v111_review_[a-z_]+$/);
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
  return error instanceof Error ? error.message : String(error);
}

test('PC-CX-56 on isolated Postgres: the documented Project purge is blocked or leaves an orphan',
  { skip: URL ? false : 'set isolated Coordinator PostgreSQL identity variables to run' }, async () => {
    const client = await connect();
    try {
      await resetSchema(client, 'pcc_v111_review_purge');
      await client.query(`
        CREATE TABLE project (id text PRIMARY KEY);
        CREATE TABLE project_action (
          id text PRIMARY KEY,
          project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
          status text NOT NULL,
          result_session_id text
        );
        CREATE TABLE session (
          id text PRIMARY KEY,
          project_action_id text UNIQUE
        );
        ALTER TABLE session ADD CONSTRAINT session_project_action_fk
          FOREIGN KEY (project_action_id) REFERENCES project_action(id)
          ON DELETE RESTRICT ON UPDATE RESTRICT;
        CREATE INDEX project_action_result_session_idx ON project_action(result_session_id);
      `);
      await client.query(D19_SQL);
      await client.query(`
        INSERT INTO project VALUES ('p-linked'), ('p-empty');
        INSERT INTO project_action VALUES ('a1', 'p-linked', 'APPLIED', NULL);
        INSERT INTO session VALUES ('s1', 'a1');
        UPDATE project_action SET result_session_id = 's1' WHERE id = 'a1';
      `);

      await assert.rejects(client.query(`DELETE FROM project WHERE id = 'p-linked'`), (error: unknown) => {
        assert.equal(errorCode(error), '23503');
        assert.equal(errorConstraint(error), 'session_project_action_fk');
        return true;
      });
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM project WHERE id='p-linked'`)).rows[0].n, 1,
        'the Project survives because its cascaded action cannot be deleted');

      await client.query(`DELETE FROM project WHERE id = 'p-empty'`);
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM project WHERE id='p-empty'`)).rows[0].n, 0,
        'positive control: a Project without the cycle still deletes');

      // Reverse control: removing the Session → action half lets the Project delete, but only by
      // leaving the Session's frozen lineage pointing at an action that no longer exists.
      await client.query(`ALTER TABLE session DROP CONSTRAINT session_project_action_fk`);
      await client.query(`DELETE FROM project WHERE id = 'p-linked'`);
      const orphan = (await client.query(`
        SELECT s.project_action_id,
               EXISTS (SELECT 1 FROM project_action a WHERE a.id=s.project_action_id) AS action_exists
          FROM session s WHERE s.id='s1'
      `)).rows[0];
      assert.deepEqual(orphan, { project_action_id: 'a1', action_exists: false });
    } finally {
      await client.end();
    }
  });

test('D19 concurrency control: a concurrent publication still produces the typed delete refusal',
  { skip: URL ? false : 'set isolated Coordinator PostgreSQL identity variables to run' }, async () => {
    const publisher = await connect();
    const deleter = await connect();
    try {
      await resetSchema(publisher, 'pcc_v111_review_delete_race');
      await deleter.query(`SET search_path TO pcc_v111_review_delete_race, public`);
      await publisher.query(`
        CREATE TABLE project_action (id text PRIMARY KEY, status text NOT NULL, result_session_id text);
        CREATE TABLE session (id text PRIMARY KEY);
        CREATE INDEX project_action_result_session_idx ON project_action(result_session_id);
      `);
      await publisher.query(D19_SQL);
      await publisher.query(`
        INSERT INTO session VALUES ('s-sequential'), ('s-race');
        INSERT INTO project_action VALUES ('a-sequential', 'APPLIED', 's-sequential'),
                                          ('a-race', 'APPLIED', NULL);
      `);

      await assert.rejects(deleter.query(`DELETE FROM session WHERE id='s-sequential'`), (error: unknown) => {
        assert.match(errorMessage(error), /SESSION_RESULT_LINK_REFERENCED/);
        assert.match(errorMessage(error), /owner=USER, recovery=HUMAN/);
        return true;
      });

      await publisher.query('BEGIN');
      await publisher.query(`UPDATE project_action SET result_session_id='s-race' WHERE id='a-race'`);
      const pendingDelete = deleter.query(`DELETE FROM session WHERE id='s-race'`);
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      await publisher.query('COMMIT');

      await assert.rejects(pendingDelete, (error: unknown) => {
        assert.equal(errorCode(error), 'P0001');
        assert.match(errorMessage(error), /SESSION_RESULT_LINK_REFERENCED/);
        assert.match(errorMessage(error), /owner=USER, recovery=HUMAN/);
        return true;
      });
      assert.equal((await publisher.query(`SELECT count(*)::int AS n FROM session WHERE id='s-race'`)).rows[0].n, 1,
        'the typed refusal and structural safety both survive the publication race');
    } finally {
      await publisher.query('ROLLBACK').catch(() => undefined);
      await Promise.all([publisher.end(), deleter.end()]);
    }
  });

test('PC-CX-57 on isolated Postgres: unchanged malformed retiredPins disables claim immutability',
  { skip: URL ? false : 'set isolated Coordinator PostgreSQL identity variables to run' }, async () => {
    const client = await connect();
    try {
      await resetSchema(client, 'pcc_v111_review_ledger_bypass');
      await client.query(`
        CREATE TABLE project_action (
          id text PRIMARY KEY,
          type text NOT NULL,
          status text NOT NULL,
          result_session_id text,
          detail jsonb NOT NULL DEFAULT '{}'::jsonb
        );
      `);
      await client.query(D18_SQL);
      await client.query(`ALTER TABLE project_action DISABLE TRIGGER project_action_result_ledger_mutator`);
      await client.query(`
        INSERT INTO project_action VALUES
          ('a-malformed', 'DISPATCH_TASK', 'REFUSED', NULL,
           '{"retiredPins":{},"claimResolution":{"old":1}}'),
          ('a-terminal', 'DISPATCH_TASK', 'CLAIMED', NULL,
           '{"retiredPins":{}}');
      `);
      await client.query(`ALTER TABLE project_action ENABLE TRIGGER project_action_result_ledger_mutator`);

      await client.query(`
        UPDATE project_action
           SET detail = jsonb_set(detail, '{claimResolution}', '{"new":2}'::jsonb)
         WHERE id='a-malformed'
      `);
      assert.deepEqual((await client.query(`SELECT detail->'claimResolution' AS claim FROM project_action WHERE id='a-malformed'`)).rows[0].claim,
        { new: 2 }, 'the immutable claim audit was rewritten while retiredPins stayed malformed');

      await client.query(`UPDATE project_action SET status='REFUSED' WHERE id='a-terminal'`);
      assert.equal((await client.query(`SELECT status FROM project_action WHERE id='a-terminal'`)).rows[0].status, 'REFUSED',
        'positive control: the intended legacy terminal transition remains available');

      await client.query(`
        INSERT INTO project_action VALUES
          ('a-valid', 'DISPATCH_TASK', 'REFUSED', NULL,
           '{"retiredPins":[],"claimResolution":{"old":1}}')
      `);
      await assert.rejects(client.query(`
        UPDATE project_action
           SET detail = jsonb_set(detail, '{claimResolution}', '{"new":2}'::jsonb)
         WHERE id='a-valid'
      `), /EXECUTION_PIN_LEDGER: action a-valid rewrites a claimResolution/);
    } finally {
      await client.end();
    }
  });
