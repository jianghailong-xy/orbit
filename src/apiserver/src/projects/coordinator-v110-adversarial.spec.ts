import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';

// Unit 02's independent review of the v1.10 Coordinator contract, flipped by v1.11 (§29). The
// assertions used to prove `PC-CX-53..55` existed; every one of them now proves the opposite —
// that the v1.10 shape is refused and the legal path exists — and each keeps the v1.10 shape as
// the reverse control, so the flip stays falsifiable. Same discipline §26 / §27 / §28 applied to
// the rounds before this one: a counter-example is flipped, never deleted.
//
// The real PostgreSQL path still installs the SQL fences extracted from the authoritative contract
// itself, so a document that stops saying this is a document that fails here.
const REPO = path.resolve(__dirname, '../../../..');
const CONTRACT = readFileSync(path.join(REPO, 'docs/project-coordinator-contract.md'), 'utf8');
const PAC = readFileSync(path.join(REPO, 'docs/project-agent-contract.md'), 'utf8');
const TEST_SOURCE = path.join(REPO, 'src/apiserver/src/projects/coordinator-v110-adversarial.spec.ts');
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

const PAC_RESOLUTION = between(PAC, '### 7.5 `session.resolution`', '## 8. 授权矩阵');
const EC2_B = between(CONTRACT, '- **EC2-b（', '- **EC2-b2（');
const D9_F = between(CONTRACT, '**D9-f（', '#### D10 ');
const D11_SQL = firstSql(between(CONTRACT, '#### D11 ', '#### D12 '));
const D16_SQL = firstSql(between(CONTRACT, '#### D16 ', '#### D8 '));
const D17_SQL = firstSql(between(CONTRACT, '#### D17 ', '#### D18 '));
const D18_SQL = firstSql(between(CONTRACT, '#### D18 ', '#### D19 '));
const D19_SQL = firstSql(between(CONTRACT, '#### D19 ', '#### D7 '));

test('PC-CX-53: the executable shape now admits PAC 7.5\'s mandatory version key', () => {
  // The two facts the finding was built on are unchanged, and must stay unchanged: closing it by
  // making `v` optional in PAC, or by dropping EC2-b's claim to freeze the whole resolution, would
  // have removed the contradiction by removing one of its halves.
  assert.match(PAC_RESOLUTION, /"v": 1/, 'PAC 7.5 no longer shows the version discriminator');
  assert.match(PAC_RESOLUTION, /`v` 必须写/, 'PAC 7.5 no longer requires the version discriminator');
  assert.match(EC2_B, /PAC §7\.5 的整份 `resolution`/, 'EC2-b no longer claims to freeze the whole PAC resolution');

  // What changed is the one thing that was wrong: the predicate.
  assert.doesNotMatch(D17_SQL, /IS DISTINCT FROM ARRAY\['where','who','with'\]/,
    'the executable shape still compares against the three-key array PAC 7.5 has no intersection with');
  assert.match(D17_SQL, /'v','number', 'who','object', 'with','object', 'where','object'/,
    'the shape does not state PAC 7.5 four top-level keys as a key-and-type table');
  assert.match(D17_SQL, /not a positive integer/, 'the version key has no value constraint');
  assert.match(CONTRACT, /- \*\*EC2-b3（/, '§7.4 does not close the resolution row');

  const admits = (version: 'v110' | 'v111', resolution: Record<string, unknown>): boolean => {
    if (version === 'v110') return Object.keys(resolution).sort().join(',') === 'where,who,with';
    const shape: Record<string, string> = { v: 'number', who: 'object', with: 'object', where: 'object' };
    const type = (value: unknown): string | undefined => (value === undefined ? undefined
      : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
    for (const key of new Set([...Object.keys(resolution), ...Object.keys(shape)])) {
      if (type(resolution[key]) !== shape[key]) return false;
    }
    return Number.isInteger(resolution.v) && (resolution.v as number) >= 1;
  };
  const pac = { v: 1, who: {}, with: {}, where: {} };
  assert.equal(admits('v111', pac), true, 'a PAC-conforming resolution must now be the legal one');
  assert.equal(admits('v111', { who: {}, with: {}, where: {} }), false,
    'and the versionless shape v1.10 demanded must now be refused');
  assert.equal(admits('v111', { ...pac, v: 7 }), true, 'PAC 7.5 requires readers to tolerate an unknown version');
  assert.equal(admits('v111', { ...pac, v: 0 }), false, 'a version must be a positive integer');
  assert.equal(admits('v111', { ...pac, extra: 1 }), false, 'a key PAC 7.5 does not have must be refused');

  // Reverse control: v1.10's predicate still gives both answers back to front.
  assert.equal(admits('v110', pac), false, 'reverse control: v1.10 refuses every conforming resolution');
  assert.equal(admits('v110', { who: {}, with: {}, where: {} }), true,
    'reverse control: v1.10 admits only the shape PAC forbids');
});

test('PC-CX-54: a database object now stands on the third verb, and Session rotation is untouched', () => {
  // Unchanged facts: deleting a Coordinator Session is still a supported rotation trigger, and the
  // deferred constraints still return on NOT FOUND. The fix had to live somewhere else.
  assert.match(CONTRACT, /被用户删除（`coordinatorSessionId` 被 SetNull）/,
    'the contract no longer treats deleting a Coordinator Session as a supported lifecycle event');
  assert.match(D9_F, /`NOT FOUND` ⇒ 没有要提交的状态，返回/,
    'the final-row rule no longer explicitly returns after a delete');
  assert.match(D16_SQL, /AFTER INSERT OR UPDATE ON session/, 'D16 unexpectedly changed its own event surface');

  // What changed: §7.7 D19 gives DELETE the two objects the other verbs already had, and §2.4
  // freezes the on-delete behaviour the review found simply absent.
  assert.match(CONTRACT, /#### D19 · Session 的物理删除也要有一道门/, '§7.7 has no D19');
  assert.match(D19_SQL, /FOREIGN KEY \(result_session_id\) REFERENCES session\(id\) ON DELETE RESTRICT/,
    'the result link is still not a real foreign key');
  assert.match(D19_SQL, /BEFORE DELETE ON session/, 'nothing observes DELETE on session');
  assert.match(D19_SQL, /SESSION_RESULT_LINK_REFERENCED/, 'a purge has no typed refusal');
  assert.match(D19_SQL, /owner=USER, recovery=HUMAN/, 'the typed refusal names no owner or recovery');
  assert.match(between(CONTRACT, '### 2.4 ', '## 3. 词汇表'), /project_action_result_session_fk/,
    '§2.4 still does not freeze the action → Session on-delete behaviour');
  assert.match(between(CONTRACT, '- **I17-A3（', '- **I17-d（'), /DELETE/,
    'I17-A3 still says nothing about the verb that made it false');
  for (const clause of ['**D19-a（', '**D19-b（', '**D19-c（', '**D19-d（', '**D19-e（', '**D19-f（']) {
    assert.ok(CONTRACT.includes(clause), `D19 does not state ${clause}）`);
  }
});

test('PC-CX-55: the ledger type is proved before any array function, on insert as well as update', () => {
  // The review's mechanism, inverted: the type test used to sit behind the array expansion that
  // raises on a non-array, and the trigger used to observe UPDATE only.
  const expand = D18_SQL.indexOf('FROM jsonb_array_elements(new_ledger)');
  const validate = D18_SQL.indexOf("IF jsonb_typeof(new_ledger) <> 'array'");
  assert.ok(validate >= 0 && expand > validate,
    'D18 still expands retiredPins before validating that it is an array');
  assert.match(D18_SQL, /BEFORE INSERT OR UPDATE ON project_action/,
    'the mutator still does not observe the INSERT that writes the initial ledger');
  assert.match(D18_SQL, /owner=SYSTEM; recovery/, 'the malformed-ledger refusal names no owner or recovery');
  assert.match(D18_SQL, /IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;/,
    'D18 does not separate the insert branch, so it would read an unassigned OLD');

  // The commit point carries the same sentence, so a malformed value cannot reach APPLIED either.
  const foldExpand = D16_SQL.indexOf('jsonb_array_length(ledger)');
  const foldValidate = D16_SQL.indexOf("IF jsonb_typeof(ledger) <> 'array'");
  assert.ok(foldValidate >= 0 && foldExpand > foldValidate,
    'the commit-point fold still measures the ledger before it proves it is one');
  assert.ok(CONTRACT.includes('**D18-g（'), 'D18 does not argue why the order and the event surface are the rule');

  // Unchanged: an unpublished CLAIMED row still bypasses the fold. That was never the defect — the
  // defect was that nothing else looked at it either.
  assert.match(D16_SQL, /a\.status <> 'APPLIED' AND a\.result_session_id IS NULL THEN RETURN NULL/,
    'D16 changed its early exit, which is not what this finding asked for');
  assert.match(D11_SQL, /writable text\[\] := ARRAY\['result_session_id', 'detail'\]/,
    'D11 no longer leaves the two ledger columns writable, which is what makes D18 necessary');
});

type ClientCtor = new (config: { connectionString?: string }) => Client;
async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const { Client: Ctor } = (await import('pg')) as unknown as { Client: ClientCtor };
  const client = new Ctor({ connectionString: URL });
  await client.connect();
  // The identity gate is deliberately the first query. setup() starts with destructive fixture DDL.
  await verifyCoordinatorPgIdentity(client);
  return client;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
function sqlJson(value: Json): string {
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
}

const FROZEN_AT = '2026-08-19T00:00:00.000Z';
function context(includePacVersion: boolean): { [key: string]: Json } {
  const resolution: { [key: string]: Json } = {
    who: { agentId: 'a1', source: 'task-assignee' },
    with: { provider: 'claude', model: 'model-v1', effort: null, source: 'task-pin' },
    where: {
      workspaceId: 'w1', runnerId: 'r1', source: 'task-pin', required: ['linux'], candidatesConsidered: 1,
    },
  };
  if (includePacVersion) resolution.v = 1;
  return {
    agentId: 'a1', workspaceId: 'w1', assignedRunnerId: 'r1', provider: 'claude', providerBuiltin: true,
    requiredCapabilities: ['linux'], permissionMode: 'read-only', resolution,
    snapshotFrozenAt: FROZEN_AT, model: 'model-v1', effort: 'high',
    authorization: {
      resolvedAgentId: 'a1', projectMemberId: 'm1', taskId: 't1', taskAssigneeAgentId: 'a1',
      providerSlug: 'claude', model: 'model-v1', workspaceId: 'w1', runnerId: 'r1',
      coordinatorWorkspaceId: null,
    },
  };
}

const TABLES = `
  CREATE TABLE project_action (
    id text PRIMARY KEY, idempotency_key text UNIQUE NOT NULL, project_id text NOT NULL,
    type text NOT NULL, status text NOT NULL, subject_type text NOT NULL, subject_id text NOT NULL,
    fencing_token bigint NOT NULL, result_session_id text, detail jsonb, execution_context jsonb,
    execution_context_digest text, execution_result_digest text, reason_code text, refusal_code text
  );
  CREATE TABLE session (
    id text PRIMARY KEY, task_id text, project_action_id text UNIQUE REFERENCES project_action(id),
    dispatch_origin text NOT NULL, status text NOT NULL, deleted_at timestamptz,
    agent_id text, workspace_id text, assigned_runner_id text, provider text,
    provider_builtin boolean, required_capabilities text[], permission_mode text, resolution jsonb,
    snapshot_frozen_at timestamptz, model text, effort text,
    execution_pin_generation bigint NOT NULL DEFAULT 0
  );
  CREATE INDEX project_action_result_session_idx ON project_action (result_session_id);
`;

/** v1.10's resolution predicate, kept verbatim as the reverse control for `PC-CX-53`. */
const V110_RESOLUTION_PREDICATE = `  IF (SELECT array_agg(t.k ORDER BY t.k COLLATE "C") FROM jsonb_object_keys(result -> 'resolution') AS t(k))
     IS DISTINCT FROM ARRAY['where','who','with'] THEN
    RAISE EXCEPTION 'EXECUTION_RESULT_SHAPE: % resolution is not PAC 7.5''s who/with/where', subject;
  END IF;
`;

/** Downgrade the authoritative shape function to the one the review reproduced against. */
function shapeAsV110(): string {
  const from = D17_SQL.indexOf('  -- EC2-b3：PAC §7.5 的四个顶层 key');
  const to = D17_SQL.indexOf('  RETURN result;', from);
  assert.ok(from >= 0 && to > from, 'could not isolate the v1.11 resolution predicate');
  return D17_SQL.slice(0, from) + V110_RESOLUTION_PREDICATE + D17_SQL.slice(to);
}

/** v1.10's D18, verbatim: UPDATE only, and the type test behind the expansion that raises 22023. */
const D18_AS_V110 = `
CREATE OR REPLACE FUNCTION project_action_result_ledger_mutator() RETURNS trigger AS $v110$
DECLARE old_ledger jsonb := COALESCE(OLD.detail -> 'retiredPins', '[]'::jsonb);
        new_ledger jsonb := COALESCE(NEW.detail -> 'retiredPins', '[]'::jsonb);
        kept jsonb;
BEGIN
  IF NEW.type <> 'DISPATCH_TASK' THEN RETURN NEW; END IF;
  IF OLD.result_session_id IS NOT NULL
     AND NEW.result_session_id IS DISTINCT FROM OLD.result_session_id THEN
    RAISE EXCEPTION 'ACTION_RESULT_LINK_FROZEN: action % cannot detach or repoint its result session (% -> %)',
      OLD.id, OLD.result_session_id, COALESCE(NEW.result_session_id, 'NULL');
  END IF;
  IF OLD.detail ? 'claimResolution'
     AND NEW.detail -> 'claimResolution' IS DISTINCT FROM OLD.detail -> 'claimResolution' THEN
    RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: action % rewrites a claimResolution that is already recorded', OLD.id;
  END IF;
  SELECT jsonb_agg(t.v ORDER BY t.i) INTO kept
    FROM jsonb_array_elements(new_ledger) WITH ORDINALITY AS t(v, i)
   WHERE t.i <= jsonb_array_length(old_ledger);
  IF jsonb_typeof(new_ledger) <> 'array'
     OR jsonb_array_length(new_ledger) < jsonb_array_length(old_ledger)
     OR (jsonb_array_length(old_ledger) > 0 AND kept IS DISTINCT FROM old_ledger) THEN
    RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: action % rewrites or truncates a retired pin that is already recorded (% -> %)',
      OLD.id, jsonb_array_length(old_ledger), jsonb_typeof(new_ledger);
  END IF;
  RETURN NEW;
END;
$v110$ LANGUAGE plpgsql;

CREATE TRIGGER project_action_result_ledger_mutator
  BEFORE UPDATE ON project_action
  FOR EACH ROW EXECUTE FUNCTION project_action_result_ledger_mutator();
`;

type Downgrade = { shape?: 'v110'; mutator?: 'v110'; sessionDelete?: false };
async function setup(c: Client, schema: string, downgrade: Downgrade = {}): Promise<void> {
  await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}; SET search_path TO ${schema}; ${TABLES}`);
  await c.query(downgrade.shape === 'v110' ? shapeAsV110() : D17_SQL);
  await c.query(D11_SQL);
  await c.query(D16_SQL);
  if (downgrade.mutator === 'v110') await c.query(D18_AS_V110);
  else await c.query(D18_SQL);
  if (downgrade.sessionDelete !== false) await c.query(D19_SQL);
}

type Fault = { message: string; code?: string };
async function txn(c: Client, body: () => Promise<void>): Promise<Fault | null> {
  await c.query('BEGIN');
  try {
    await body();
    await c.query('COMMIT');
    return null;
  } catch (error) {
    await c.query('ROLLBACK');
    const fault = error as Error & { code?: string };
    return { message: fault.message, code: fault.code };
  }
}

async function insertAction(c: Client, id: string, status: string, detail: Json,
  withVersion = true): Promise<void> {
  const ctx = sqlJson(context(withVersion));
  await c.query(`
    INSERT INTO project_action (id,idempotency_key,project_id,type,status,subject_type,subject_id,
      fencing_token,result_session_id,detail,execution_context,execution_context_digest,
      execution_result_digest,reason_code,refusal_code)
    VALUES ($1,$2,'p1','DISPATCH_TASK',$3,'TASK','t1',1,NULL,${sqlJson(detail)},${ctx},
      coordinator_execution_digest(${ctx}->'authorization'),
      coordinator_execution_digest(${ctx}-'authorization'),'MANUAL',NULL)`, [id, `key-${id}`, status]);
}

async function insertSession(c: Client, actionId: string, sessionId: string): Promise<void> {
  await c.query(`
    INSERT INTO session (id,task_id,project_action_id,dispatch_origin,status,agent_id,workspace_id,
      assigned_runner_id,provider,provider_builtin,required_capabilities,permission_mode,resolution,
      snapshot_frozen_at)
    SELECT $1,'t1',$2,'COORDINATOR','PENDING',execution_context->>'agentId',
      execution_context->>'workspaceId',execution_context->>'assignedRunnerId',
      execution_context->>'provider',(execution_context->>'providerBuiltin')::boolean,
      ARRAY(SELECT jsonb_array_elements_text(execution_context->'requiredCapabilities')),
      execution_context->>'permissionMode',execution_context->'resolution',
      (execution_context->>'snapshotFrozenAt')::timestamptz
      FROM project_action WHERE id=$2`, [sessionId, actionId]);
}

/** §8.3's three statements. The whole of `PC-CX-53` is whether this commits at all. */
async function dispatch(c: Client, actionId: string, sessionId: string, withVersion: boolean): Promise<Fault | null> {
  return txn(c, async () => {
    await c.query(`TRUNCATE session, project_action`);
    await insertAction(c, actionId, 'CLAIMED', {}, withVersion);
    await insertSession(c, actionId, sessionId);
    await c.query(`UPDATE project_action SET status='APPLIED',result_session_id=$1 WHERE id=$2`,
      [sessionId, actionId]);
  });
}

test('PC-CX-53 on isolated Postgres: the PAC-conforming dispatch commits and the versionless one is refused',
  { skip: URL ? false : 'set isolated Coordinator PostgreSQL identity variables to run' }, async () => {
    const c = await connect();
    const schema = 'pcc_v110_resolution_02';
    try {
      await setup(c, schema);
      // The closing assertion is a positive: the finding was that no legal path existed at all.
      assert.equal(await dispatch(c, 'act-pac', 'session-pac', true), null,
        'a dispatch carrying PAC 7.5 resolution — v included — must commit end to end');
      assert.deepEqual((await c.query(`
        SELECT a.status, a.result_session_id,
               a.execution_context #>> '{resolution,v}' AS version,
               ARRAY(SELECT k FROM jsonb_object_keys(s.resolution) k ORDER BY k) AS keys
          FROM project_action a JOIN session s ON s.id = a.result_session_id WHERE a.id='act-pac'`)).rows[0],
      { status: 'APPLIED', result_session_id: 'session-pac', version: '1', keys: ['v', 'where', 'who', 'with'] },
      'and the committed session carries PAC 7.5 four top-level keys, byte for byte');

      const versionless = await dispatch(c, 'act-versionless', 'session-versionless', false);
      assert.match(versionless?.message ?? '', /EXECUTION_RESULT_SHAPE.*closed v\/who\/with\/where/,
        'a resolution missing the key PAC requires must now be the refused one');

      // Reverse control — v1.10's exact-key predicate: the two answers come back inverted, which is
      // the review's §6 observation for PC-CX-53 verbatim.
      await setup(c, schema, { shape: 'v110' });
      const underV110 = await dispatch(c, 'act-pac', 'session-pac', true);
      assert.match(underV110?.message ?? '', /EXECUTION_RESULT_SHAPE.*resolution is not PAC 7\.5's who\/with\/where/,
        'PC-CX-53 must reproduce: v1.10 refuses the conforming resolution');
      assert.equal(await dispatch(c, 'act-versionless', 'session-versionless', false), null,
        'PC-CX-53 must reproduce: deleting mandatory PAC 7.5.v is the only way through v1.10');
    } finally {
      await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await c.end();
    }
  });

test('PC-CX-54 on isolated Postgres: soft delete still commits and the purge is refused with an owner',
  { skip: URL ? false : 'set isolated Coordinator PostgreSQL identity variables to run' }, async () => {
    const c = await connect();
    const schema = 'pcc_v110_session_delete_02';
    try {
      await setup(c, schema);
      assert.equal(await dispatch(c, 'act-delete', 'session-delete', true), null,
        'the ordinary dispatch must establish the valid two-way link first');
      assert.equal(await txn(c, async () => {
        await c.query(`UPDATE session SET deleted_at=clock_timestamp() WHERE id='session-delete'`);
      }), null, 'the supported trash step must still commit — soft delete is an UPDATE, the row stays');

      const purge = await txn(c, async () => {
        await c.query(`DELETE FROM session WHERE id='session-delete'`);
      });
      assert.match(purge?.message ?? '', /SESSION_RESULT_LINK_REFERENCED/,
        'purging a published result session must be refused by this contract own code');
      assert.match(purge?.message ?? '', /owner=USER, recovery=HUMAN/,
        'and the refusal must name an owner and a recovery, not just fail');
      assert.deepEqual((await c.query(`
        SELECT a.status, a.result_session_id,
               EXISTS (SELECT 1 FROM session s WHERE s.id=a.result_session_id) AS session_exists
          FROM project_action a WHERE a.id='act-delete'`)).rows[0],
      { status: 'APPLIED', result_session_id: 'session-delete', session_exists: true },
      'the committed state is the one I17-A3 requires, not the orphan');

      // A session no action row points at is still deletable — that is the §7.5 rotation path.
      assert.equal(await txn(c, async () => {
        await c.query(`INSERT INTO session (id,dispatch_origin,status) VALUES ('coord-1','USER','RUNNING')`);
        await c.query(`DELETE FROM session WHERE id='coord-1'`);
      }), null, 'a Coordinator Session carries no result link and must still be deletable');

      // Reverse control — v1.10: no object on DELETE, and the review's orphan comes straight back.
      await setup(c, schema, { sessionDelete: false });
      assert.equal(await dispatch(c, 'act-delete', 'session-delete', true), null);
      assert.equal(await txn(c, async () => {
        await c.query(`UPDATE session SET deleted_at=clock_timestamp() WHERE id='session-delete'`);
      }), null);
      assert.equal(await txn(c, async () => {
        await c.query(`DELETE FROM session WHERE id='session-delete'`);
      }), null, 'PC-CX-54 must reproduce: no v1.10 DELETE event or declared FK protects the invariant');
      assert.deepEqual((await c.query(`
        SELECT a.status, a.result_session_id,
               EXISTS (SELECT 1 FROM session s WHERE s.id=a.result_session_id) AS session_exists
          FROM project_action a WHERE a.id='act-delete'`)).rows[0],
      { status: 'APPLIED', result_session_id: 'session-delete', session_exists: false },
      'and it leaves the review exact committed observation: the I17-A3 forbidden orphan');
    } finally {
      await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await c.end();
    }
  });

test('PC-CX-55 on isolated Postgres: the malformed ledger is refused at insert, and a legacy one is repairable',
  { skip: URL ? false : 'set isolated Coordinator PostgreSQL identity variables to run' }, async () => {
    const c = await connect();
    const schema = 'pcc_v110_malformed_ledger_02';
    try {
      await setup(c, schema);
      const refused = await txn(c, async () => {
        await insertAction(c, 'act-malformed', 'CLAIMED', { retiredPins: {} });
      });
      assert.match(refused?.message ?? '', /EXECUTION_PIN_LEDGER/,
        'a malformed initial ledger must be refused on the INSERT statement itself');
      assert.notEqual(refused?.code, '22023', 'and the refusal must not be Postgres native JSON error');
      assert.match(refused?.message ?? '', /owner=SYSTEM; recovery/, 'the refusal names no owner or recovery');
      assert.equal((await c.query(`SELECT count(*)::int AS n FROM project_action`)).rows[0].n, 0,
        'nothing committed, so no permanent action key was taken');
      assert.equal(await txn(c, async () => {
        await insertAction(c, 'act-empty-ledger', 'CLAIMED', { retiredPins: [] });
      }), null, 'an empty-array ledger is a ledger and must still insert');

      // The legacy half: a row an older binary already committed. The normal terminal transition
      // and the prescribed repair both have to work, which is exactly what v1.10 made impossible.
      await c.query(`DROP TRIGGER project_action_result_ledger_mutator ON project_action`);
      await c.query(`TRUNCATE session, project_action`);
      assert.equal(await txn(c, async () => {
        await insertAction(c, 'act-legacy', 'CLAIMED', { retiredPins: {} });
      }), null, 'the mixed-version premise: an older write end already committed one');
      await c.query(`CREATE TRIGGER project_action_result_ledger_mutator
                       BEFORE INSERT OR UPDATE ON project_action
                       FOR EACH ROW EXECUTE FUNCTION project_action_result_ledger_mutator()`);
      assert.equal(await txn(c, async () => {
        await c.query(`UPDATE project_action SET status='REFUSED',refusal_code='PROVIDER_UNAVAILABLE'
                        WHERE id='act-legacy'`);
      }), null, 'the normal terminal transition must commit — it never touched the ledger');
      assert.equal(await txn(c, async () => {
        await c.query(`UPDATE project_action
                          SET detail = (detail - 'retiredPins')
                                     || jsonb_build_object('malformedRetiredPins', detail->'retiredPins')
                        WHERE id='act-legacy'`);
      }), null, 'and the repair D18-e ④-a prescribes must commit, with the evidence moved not dropped');
      assert.deepEqual((await c.query(`SELECT status,detail::text AS detail FROM project_action
                                       WHERE id='act-legacy'`)).rows[0],
        { status: 'REFUSED', detail: '{"malformedRetiredPins": {}}' },
        'the permanent action key reaches a terminal state and the audit is clean');

      // Reverse control — v1.10: no INSERT event, and the type test behind the array expansion.
      await setup(c, schema, { mutator: 'v110' });
      assert.equal(await txn(c, async () => {
        await insertAction(c, 'act-stuck', 'CLAIMED', { retiredPins: {} });
      }), null, 'PC-CX-55 must reproduce: D18 has no INSERT event under v1.10');
      const terminal = await txn(c, async () => {
        await c.query(`UPDATE project_action SET status='REFUSED',refusal_code='PROVIDER_UNAVAILABLE'
                        WHERE id='act-stuck'`);
      });
      assert.equal(terminal?.code, '22023', 'PC-CX-55 must reproduce: the terminal transition raises 22023');
      const repair = await txn(c, async () => {
        await c.query(`UPDATE project_action SET detail='{}'::jsonb WHERE id='act-stuck'`);
      });
      assert.equal(repair?.code, '22023', 'PC-CX-55 must reproduce: even the repair evaluates the old object');
      assert.deepEqual((await c.query(`SELECT status,detail::text AS detail FROM project_action
                                       WHERE id='act-stuck'`)).rows[0],
        { status: 'CLAIMED', detail: '{"retiredPins": {}}' },
        'and it leaves the review exact committed observation: a permanent key stuck in CLAIMED');
    } finally {
      await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await c.end();
    }
  });

test('v1.10 independent-review inventory is explicit, flipped, and every destructive PG path is safety-gated', () => {
  const source = readFileSync(TEST_SOURCE, 'utf8');
  for (const id of ['PC-CX-53', 'PC-CX-54', 'PC-CX-55']) assert.ok(source.includes(id), `${id} is missing`);
  // Every finding keeps its v1.10 shape as a reverse control; a flip without one proves nothing.
  for (const control of ['shapeAsV110', 'D18_AS_V110', 'sessionDelete: false']) {
    assert.ok(source.includes(control), `the flip lost its reverse control ${control}`);
  }
  const connectAt = source.indexOf('async function connect()');
  const identityAt = source.indexOf('await verifyCoordinatorPgIdentity(client)', connectAt);
  const setupAt = source.indexOf('async function setup(');
  assert.ok(connectAt >= 0 && identityAt > connectAt && setupAt > identityAt,
    'the identity gate must be defined before the first destructive fixture helper');
  assert.equal(source.includes(['orbit', 'postgres'].join('-')), false,
    'the independent fixture must not contain the shared control-plane container name');
  assert.equal(source.includes(['postgres://', 'orbit'].join('')), false,
    'the independent fixture must not contain the shared control-plane credential prefix');
});
