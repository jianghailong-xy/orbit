import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';

// Unit 02's independent review of the v1.11 Coordinator contract, flipped by v1.12 (`PC-CX-56..57`).
// Every assertion below originally proved the defect was present; a proof of presence necessarily
// turns red the moment the defect is fixed, so each one now states the closed shape *and keeps the
// v1.11 shape beside it as a reverse control* — the same discipline §22.9 / §23.5 / §24.6 / §25.7 /
// §26.5 / §27.4 / §28.4 / §29.4 record for the eight rounds before this one. The file still edits
// neither the authoritative contract nor the development fixtures, and the PostgreSQL cases still
// run only after the shared isolation guard has verified the dedicated database, role, and server
// system identifier.
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

test('PC-CX-56: the Project purge is one declared transaction, not an unreachable cycle', () => {
  // §2.4's cascade and the action → Session RESTRICT are unchanged: the finding was never that
  // either of them was wrong, it was that the *third* edge made all three orders unreachable.
  // The COUNT of tables is not what this finding is about and is checked for §14 agreement in
  // `coordinator-contract.spec.ts`; pinning it here made a later unit adding a table look like a
  // regression of PC-CX-56. What must not change is the cascade itself.
  assert.match(INFRA, /新表，全部 `onDelete: Cascade` 挂在 `project` 下/,
    'the action ledger no longer cascades with its Project, which is not what this finding asked for');
  assert.match(INFRA, /`project_action\.result_session_id → session\.id` \| \*\*RESTRICT\*\*/,
    'the action-to-Session side must stay immediate: the purge never needs it deferred');
  // The one edge that moved, and the two objects that make the move usable.
  assert.match(INFRA, /`session\.projectActionId → project_action\.id` \| \*\*NO ACTION\*\*/,
    'the Session-to-action side is still an immediate RESTRICT, so the Project cascade is still refused');
  assert.match(INFRA, /DEFERRABLE INITIALLY IMMEDIATE/,
    'the constraint is not declared deferrable, and RESTRICT can never be deferred at all');
  assert.match(D20, /coordinator_purge_project/, 'there is still no single public purge entry point');
  assert.match(D20, /PROJECT_PURGE_UNDECLARED/, 'a bare DELETE that would strand a placeholder has no typed code');
  assert.match(D19, /物理清除的粒度是 Project，不是 Session/,
    'D19-c no longer states the granularity this protocol implements');
  assert.doesNotMatch(D19, /那之后这条 Session 就是一条普通 Session，照常可删/,
    'D19-c still states the transition that had no transaction behind it');

  // The reachability model the review published, with the deferrability of each edge as its input.
  // v1.11: both edges immediate, so no order gets past its first statement. v1.12: the lineage edge
  // can be deferred inside a declared purge, so Project-first works and COMMIT re-checks it.
  type Edge = 'immediate' | 'deferrable';
  const purgeReachable = (lineage: Edge, declared: boolean): boolean => {
    // Session-first is refused by the action → Session RESTRICT and D19 in both versions, and
    // deleting the action row on its own violates §8.2 GE1. Project-first is the only candidate.
    if (lineage === 'immediate') return false;      // the cascade trips the reference check itself
    return declared;                                // and only a declared purge may defer it
  };
  assert.equal(purgeReachable('deferrable', true), true,
    'a declared purge on the v1.12 topology must have a transaction that reaches the end');
  assert.equal(purgeReachable('deferrable', false), false,
    'and an undeclared one must not — that is the statement PROJECT_PURGE_UNDECLARED answers');
  assert.equal(purgeReachable('immediate', true), false,
    'reverse control: with v1.11 immediate RESTRICT there is no reachable order at all');
});

test('PC-CX-57: the malformed-ledger compatibility branch no longer returns past the link and claim gates', () => {
  const malformed = D18_SQL.indexOf("IF jsonb_typeof(new_ledger) <> 'array'");
  const flag = D18_SQL.indexOf('ledger_untouched := true;', malformed);
  const linkFreeze = D18_SQL.indexOf('IF OLD.result_session_id IS NOT NULL');
  const claimFreeze = D18_SQL.indexOf("IF OLD.detail ? 'claimResolution'");
  const skip = D18_SQL.indexOf('IF ledger_untouched THEN RETURN NEW; END IF;');
  const expand = D18_SQL.indexOf('FROM jsonb_array_elements(new_ledger)');
  assert.ok(malformed >= 0 && flag > malformed,
    'the compatibility branch still returns out of the whole mutator instead of recording a flag');
  assert.ok(flag < linkFreeze && flag < claimFreeze,
    'the two unrelated gates are still upstream of the compatibility branch');
  assert.ok(skip > linkFreeze && skip > claimFreeze && skip < expand,
    'the skip must sit after ① and ② and before the array expansion — that position is the fix');
  assert.match(D18, /新旧值逐字相同[^\n]*放行/,
    'D18-g no longer declares the compatibility path at all, which would brick the legacy rows');
  assert.match(D18, /\*\*D18-h（/, 'D18 does not argue how wide the compatibility branch is allowed to be');

  // The mutator, modelled on the two inputs the review varied: is the ledger a legal array, and does
  // this statement rewrite an already-recorded claim? Under v1.12 the second answer no longer
  // depends on the first — that independence is the whole finding.
  type Version = 'v111' | 'v112';
  const mutator = (version: Version, oldLedger: unknown, newLedger: unknown,
    rewritesClaim: boolean): 'ALLOW' | 'REFUSE' => {
    if (!Array.isArray(newLedger)) {
      if (JSON.stringify(oldLedger) !== JSON.stringify(newLedger)) return 'REFUSE';
      if (version === 'v111') return 'ALLOW';       // `RETURN NEW`: out of the function entirely
    }
    return rewritesClaim ? 'REFUSE' : 'ALLOW';      // ② runs on malformed and legal rows alike
  };
  assert.equal(mutator('v112', {}, {}, true), 'REFUSE',
    'an unchanged malformed retiredPins must no longer disable claimResolution immutability');
  assert.equal(mutator('v112', [], [], true), 'REFUSE',
    'and the legal-ledger row must give the identical answer — one rule, not two');
  assert.equal(mutator('v112', {}, {}, false), 'ALLOW',
    'while a statement that touches neither the ledger nor the claim still commits (D18-g)');
  assert.equal(mutator('v112', {}, 'still-bad', false), 'REFUSE',
    'swapping one malformed value for another is still not a repair');
  assert.equal(mutator('v111', {}, {}, true), 'ALLOW',
    'reverse control: under v1.11 the same rewrite was admitted by an unrelated sibling key');
  assert.notEqual(mutator('v111', {}, {}, true), mutator('v111', [], [], true),
    'reverse control: and that is why v1.11 gave one rewrite two different answers');
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


test('PC-CX-56 on isolated Postgres: the declared Project purge commits and leaves no orphan',
  { skip: URL ? false : 'set isolated Coordinator PostgreSQL identity variables to run' }, async () => {
    const client = await connect();
    const build = async (lineage: 'v112' | 'v111' | 'none'): Promise<void> => {
      await resetSchema(client, 'pcc_v111_review_purge');
      await client.query(`
        CREATE TABLE project (id text PRIMARY KEY);
        -- v1.14 (PC-CX-62): D20 ⓪ is now §4.3 I11-A's attribution closure, so the fixture carries
        -- the Task it reads. Same discipline as the two columns v1.13 added below: the defaults are
        -- the in-scope ones, so every assertion in this file is the same fixture it always was.
        CREATE TABLE task (id text PRIMARY KEY, project_id text NOT NULL);
        CREATE TABLE project_action (
          id text PRIMARY KEY,
          project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
          status text NOT NULL,
          result_session_id text,
          -- v1.13 (PC-CX-60): D20 ⓪ reads the action type and the Session origin, because D20-c
          -- always excluded a USER Session and a non-dispatch action. The two columns carry the
          -- in-scope defaults so every assertion below is the same fixture it was in v1.12.
          type text NOT NULL DEFAULT 'DISPATCH_TASK',
          subject_type text NOT NULL DEFAULT 'TASK',
          subject_id text NOT NULL DEFAULT 't1'
        );
        CREATE TABLE session (
          id text PRIMARY KEY,
          project_action_id text UNIQUE,
          dispatch_origin text NOT NULL DEFAULT 'COORDINATOR',
          task_id text DEFAULT 't1'
        );
        CREATE INDEX project_action_result_session_idx ON project_action(result_session_id);
        CREATE INDEX project_action_project_idx ON project_action(project_id);
      `);
      await client.query(D19_SQL);
      // v1.12 runs the contract's own D20 fence, which includes the deferrable constraint. The two
      // reverse controls build the v1.11 edge (or none at all) and install no D20 objects.
      if (lineage === 'v112') await client.query(D20_SQL);
      else if (lineage === 'v111') {
        await client.query(`
          ALTER TABLE session ADD CONSTRAINT session_project_action_fk
            FOREIGN KEY (project_action_id) REFERENCES project_action(id)
            ON DELETE RESTRICT ON UPDATE RESTRICT;
        `);
      }
      await client.query(`
        INSERT INTO project VALUES ('p-linked'), ('p-empty');
        INSERT INTO task VALUES ('t1', 'p-linked');
        INSERT INTO project_action VALUES ('a1', 'p-linked', 'APPLIED', NULL);
        INSERT INTO session VALUES ('s1', 'a1');
        UPDATE project_action SET result_session_id = 's1' WHERE id = 'a1';
      `);
    };
    const one = async (sql: string): Promise<string> => {
      await client.query('BEGIN');
      try { await client.query(sql); await client.query('COMMIT'); return ''; } catch (error) {
        await client.query('ROLLBACK'); return errorMessage(error);
      }
    };
    const census = async () => (await client.query<{ p: number; a: number; s: number }>(`
      SELECT (SELECT count(*)::int FROM project) AS p, (SELECT count(*)::int FROM project_action) AS a,
             (SELECT count(*)::int FROM session) AS s`)).rows[0];

    try {
      await build('v112');

      // The positive that closes the finding: one transaction, and it commits.
      await client.query('BEGIN');
      const purged = (await client.query<{ purged_actions: string; purged_sessions: string }>(
        `SELECT * FROM coordinator_purge_project('p-linked')`)).rows[0];
      const insideOrphans = (await client.query<{ n: number }>(`
        SELECT count(*)::int AS n FROM session s WHERE s.project_action_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM project_action a WHERE a.id = s.project_action_id)`)).rows[0].n;
      await client.query('COMMIT');
      assert.deepEqual(purged, { purged_actions: '1', purged_sessions: '1' },
        'the declared purge must remove the ledger and the placeholder it owns');
      assert.equal(insideOrphans, 0, 'and I17-A3 must already hold inside that transaction');
      assert.deepEqual(await census(), { p: 1, a: 0, s: 0 }, 'the linked Project is gone, row and ledger alike');

      await build('v112');
      // The bare statement is refused where the caller can see it, with an owner and a recovery.
      const bare = await one(`DELETE FROM project WHERE id='p-linked'`);
      assert.match(bare, /PROJECT_PURGE_UNDECLARED/, 'a bare DELETE that strands the placeholder must be refused');
      assert.match(bare, /owner=SYSTEM, recovery=EVENT/, 'and it must name an owner and a recovery');
      assert.deepEqual(await census(), { p: 2, a: 1, s: 1 }, 'and nothing moved');
      assert.equal(await one(`DELETE FROM project WHERE id='p-empty'`), '',
        'positive control: a Project with nothing to strand still deletes on a bare statement');
      // A forged fence proves the structural half is unconditional: it dies at COMMIT.
      const forged = await one(`
        SELECT set_config('coordinator.purging_project','p-linked',true);
        SET CONSTRAINTS session_project_action_fk DEFERRED;
        DELETE FROM project WHERE id='p-linked';`);
      assert.match(forged, /session_project_action_fk/, 'a forged fence must still be caught by the constraint');
      assert.deepEqual(await census(), { p: 1, a: 1, s: 1 }, 'and it rolls back whole');

      // Reverse control — the v1.11 topology this file was written against. The Project cascade is
      // refused by the lineage RESTRICT and nothing is removed: the review's committed observation.
      await build('v111');
      await assert.rejects(client.query(`DELETE FROM project WHERE id = 'p-linked'`), (error: unknown) => {
        assert.equal(errorCode(error), '23503');
        assert.equal(errorConstraint(error), 'session_project_action_fk');
        return true;
      });
      assert.deepEqual(await census(), { p: 2, a: 1, s: 1 },
        'v1.11 must still reproduce: the Project survives because its cascaded action cannot be deleted');

      // Reverse control — and dropping that edge is not an answer either: the Project deletes, and
      // the placeholder is left pointing at an action row that no longer exists.
      await build('none');
      assert.equal(await one(`DELETE FROM project WHERE id='p-linked'`), '');
      assert.deepEqual((await client.query(`
        SELECT s.project_action_id,
               EXISTS (SELECT 1 FROM project_action a WHERE a.id=s.project_action_id) AS action_exists
          FROM session s WHERE s.id='s1'`)).rows[0], { project_action_id: 'a1', action_exists: false },
      'v1.11 must still reproduce: removing the Session half admits the orphan lineage instead');
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
      // Observe the outcome eagerly. The delete is blocked on the publisher's row lock and rejects
      // the instant COMMIT releases it; attaching the assertion afterwards leaves a window in which
      // the runtime reports it as an unhandled rejection instead.
      const pendingDelete = deleter.query(`DELETE FROM session WHERE id='s-race'`)
        .then(() => undefined, (error: unknown) => error);
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      await publisher.query('COMMIT');

      const raced = await pendingDelete;
      assert.ok(raced, 'the racing delete must not succeed once the publication commits');
      assert.equal(errorCode(raced), 'P0001');
      assert.match(errorMessage(raced), /SESSION_RESULT_LINK_REFERENCED/);
      assert.match(errorMessage(raced), /owner=USER, recovery=HUMAN/);
      assert.equal((await publisher.query(`SELECT count(*)::int AS n FROM session WHERE id='s-race'`)).rows[0].n, 1,
        'the typed refusal and structural safety both survive the publication race');
    } finally {
      await publisher.query('ROLLBACK').catch(() => undefined);
      await Promise.all([publisher.end(), deleter.end()]);
    }
  });

test('PC-CX-57 on isolated Postgres: an unchanged malformed ledger no longer admits a claim rewrite',
  { skip: URL ? false : 'set isolated Coordinator PostgreSQL identity variables to run' }, async () => {
    const client = await connect();
    // The v1.11 body, rebuilt from the contract's current one: the exception is `RETURN NEW` again,
    // and it is the only thing that differs. `rewrite` fails loudly if the contract wording moves,
    // so this reverse control can never quietly degrade into testing the same body twice.
    const rewrite = (body: string, from: string, to: string): string => {
      const out = body.replace(from, to);
      assert.notEqual(out, body, `D18's current body no longer contains ${JSON.stringify(from)}`);
      return out;
    };
    let D18_AS_V111 = rewrite(D18_SQL, ' ledger_untouched boolean := false;', '');
    D18_AS_V111 = rewrite(D18_AS_V111, '      ledger_untouched := true;\n    ELSE\n',
      '      RETURN NEW;\n    END IF;\n');
    D18_AS_V111 = rewrite(D18_AS_V111, "    END IF;\n  END IF;\n  IF TG_OP = 'INSERT'",
      "  END IF;\n  IF TG_OP = 'INSERT'");
    D18_AS_V111 = D18_AS_V111.replace(/^ *IF ledger_untouched THEN RETURN NEW; END IF;.*\n/m, '');
    assert.doesNotMatch(D18_AS_V111, /ledger_untouched/, 'the v1.11 reverse control still carries the v1.12 flag');
    const build = async (body: string): Promise<void> => {
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
      await client.query(body);
      await client.query(`ALTER TABLE project_action DISABLE TRIGGER project_action_result_ledger_mutator`);
      await client.query(`
        INSERT INTO project_action VALUES
          ('a-malformed', 'DISPATCH_TASK', 'REFUSED', NULL, '{"retiredPins":{},"claimResolution":{"old":1}}'),
          ('a-linked',    'DISPATCH_TASK', 'APPLIED', 's1',  '{"retiredPins":{}}'),
          ('a-terminal',  'DISPATCH_TASK', 'CLAIMED', NULL, '{"retiredPins":{}}'),
          ('a-valid',     'DISPATCH_TASK', 'REFUSED', NULL, '{"retiredPins":[],"claimResolution":{"old":1}}');
      `);
      await client.query(`ALTER TABLE project_action ENABLE TRIGGER project_action_result_ledger_mutator`);
    };
    const rewriteClaim = (id: string): string =>
      `UPDATE project_action SET detail = jsonb_set(detail, '{claimResolution}', '{"new":2}'::jsonb) WHERE id='${id}'`;
    const claimOf = async (id: string): Promise<unknown> => (await client.query(
      `SELECT detail->'claimResolution' AS claim FROM project_action WHERE id='${id}'`)).rows[0].claim;

    try {
      await build(D18_SQL);
      // ② now runs on the malformed row exactly as it runs on the legal one.
      await assert.rejects(client.query(rewriteClaim('a-malformed')),
        /EXECUTION_PIN_LEDGER: action a-malformed rewrites a claimResolution/);
      assert.deepEqual(await claimOf('a-malformed'), { old: 1 }, 'the recorded audit is untouched');
      await assert.rejects(client.query(rewriteClaim('a-valid')),
        /EXECUTION_PIN_LEDGER: action a-valid rewrites a claimResolution/);
      // ① as well: a published link cannot be detached through a malformed ledger.
      await assert.rejects(client.query(`UPDATE project_action SET result_session_id=NULL WHERE id='a-linked'`),
        /ACTION_RESULT_LINK_FROZEN/);
      // …and D18-g's outlet is untouched, which is the thing the compatibility branch exists for.
      await client.query(`UPDATE project_action SET status='REFUSED' WHERE id='a-terminal'`);
      assert.equal((await client.query(`SELECT status FROM project_action WHERE id='a-terminal'`)).rows[0].status,
        'REFUSED', 'positive control: the intended legacy terminal transition is still available');

      // Reverse control — the v1.11 body, where the exception returned out of the whole mutator.
      await build(D18_AS_V111);
      await client.query(rewriteClaim('a-malformed'));
      assert.deepEqual(await claimOf('a-malformed'), { new: 2 },
        'v1.11 must still reproduce: the immutable claim audit is rewritten while retiredPins stays malformed');
      await client.query(`UPDATE project_action SET result_session_id=NULL WHERE id='a-linked'`);
      assert.equal((await client.query(`SELECT result_session_id AS l FROM project_action WHERE id='a-linked'`)).rows[0].l,
        null, 'and the published link is detached by the same early return');
      await assert.rejects(client.query(rewriteClaim('a-valid')),
        /EXECUTION_PIN_LEDGER: action a-valid rewrites a claimResolution/,
        'while the legal-ledger row is refused — the two answers v1.11 gave one rewrite');
    } finally {
      await client.end();
    }
  });
