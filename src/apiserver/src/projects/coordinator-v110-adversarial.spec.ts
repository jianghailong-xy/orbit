import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';

// Independent unit-02 review of the v1.10 Coordinator contract. A passing adversarial assertion
// means the counterexample was reproduced; it does not mean the contract passed review. The real
// PostgreSQL path installs the SQL fences extracted from the authoritative contract itself.
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
const D18_SQL = firstSql(between(CONTRACT, '#### D18 ', '#### D7 '));

test('PC-CX-53: the v1.10 closed resolution shape rejects PAC 7.5\'s mandatory version key', () => {
  assert.match(PAC_RESOLUTION, /"v": 1/, 'PAC 7.5 no longer shows the version discriminator');
  assert.match(PAC_RESOLUTION, /`v` 必须写/, 'PAC 7.5 no longer requires the version discriminator');
  assert.match(EC2_B, /PAC §7\.5 的整份 `resolution`/, 'EC2-b no longer claims to freeze the whole PAC resolution');
  assert.match(D17_SQL, /ARRAY\['where','who','with'\]/,
    'the executable shape no longer excludes PAC 7.5.v from its exact key set');
  assert.doesNotMatch(D17_SQL, /ARRAY\[[^\]]*'v'[^\]]*\]/,
    'the executable exact key set unexpectedly includes PAC 7.5.v');

  const acceptedByV110 = (resolution: Record<string, unknown>): boolean =>
    Object.keys(resolution).sort().join(',') === ['where', 'who', 'with'].join(',');
  const pacResolution = { v: 1, who: {}, with: {}, where: {} };
  assert.equal(acceptedByV110(pacResolution), false,
    'a PAC-conforming resolution must expose the contradiction in v1.10');
  assert.equal(acceptedByV110({ who: {}, with: {}, where: {} }), true,
    'reverse control: deleting PAC 7.5.v is the only way through the v1.10 exact-key predicate');
});

test('PC-CX-54: final-row rereads do not protect a row deleted through the supported Session lifecycle', () => {
  assert.match(CONTRACT, /被用户删除（`coordinatorSessionId` 被 SetNull）/,
    'the contract no longer treats deleting a Coordinator Session as a supported lifecycle event');
  assert.match(D9_F, /`NOT FOUND` ⇒ 没有要提交的状态，返回/,
    'the final-row rule no longer explicitly fails open after a delete');
  assert.match(D16_SQL, /AFTER INSERT OR UPDATE ON session/,
    'D16 unexpectedly observes DELETE on Session');
  assert.doesNotMatch(D16_SQL, /AFTER INSERT OR UPDATE OR DELETE ON session/,
    'D16 unexpectedly gained a Session DELETE event');
  assert.match(CONTRACT, /不存在一条 `status = 'APPLIED'` 的 `DISPATCH_TASK` 行，其 `result_session_id`[\s\S]*Session 缺失/,
    'I17-A3 no longer forbids an APPLIED action that points at a missing Session');
});

test('PC-CX-55: D18 expands an untrusted retiredPins value before checking its type', () => {
  const expand = D18_SQL.indexOf('FROM jsonb_array_elements(new_ledger)');
  const validate = D18_SQL.indexOf("IF jsonb_typeof(new_ledger) <> 'array'");
  assert.ok(expand >= 0 && validate > expand,
    'the authoritative D18 no longer expands retiredPins before validating that it is an array');
  assert.match(D18_SQL, /BEFORE UPDATE ON project_action/,
    'the mutator unexpectedly validates the initial INSERT too');
  assert.doesNotMatch(D18_SQL, /BEFORE INSERT OR UPDATE ON project_action/,
    'the malformed initial ledger is unexpectedly covered at INSERT');
  assert.match(D16_SQL, /a\.status <> 'APPLIED' AND a\.result_session_id IS NULL THEN RETURN NULL/,
    'an unpublished CLAIMED row no longer bypasses the ledger fold');
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
`;

async function setup(c: Client, schema: string): Promise<void> {
  await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}; SET search_path TO ${schema}; ${TABLES}`);
  await c.query(D17_SQL);
  await c.query(D11_SQL);
  await c.query(D16_SQL);
  await c.query(D18_SQL);
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

async function insertAction(c: Client, id: string, status: string, detail: Json): Promise<void> {
  const ctx = sqlJson(context(false));
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

test('PC-CX-53 on isolated Postgres: a PAC-conforming resolution is rejected and the versionless one passes',
  { skip: URL ? false : 'set isolated Coordinator PostgreSQL identity variables to run' }, async () => {
    const c = await connect();
    const schema = 'pcc_v110_resolution_02';
    try {
      await setup(c, schema);
      const pac = await txn(c, async () => {
        await c.query('SELECT coordinator_execution_result_shape($1,$2::jsonb)', ['pac-session', context(true)]);
      });
      assert.match(pac?.message ?? '', /EXECUTION_RESULT_SHAPE.*resolution is not PAC 7\.5's who\/with\/where/,
        'PAC 7.5.v should expose the exact-key contradiction');
      assert.equal(await txn(c, async () => {
        await c.query('SELECT coordinator_execution_result_shape($1,$2::jsonb)', ['versionless-session', context(false)]);
      }), null, 'reverse control: the same resolution passes only after deleting mandatory PAC 7.5.v');
    } finally {
      await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await c.end();
    }
  });

test('PC-CX-54 on isolated Postgres: soft delete passes and later hard delete orphans the APPLIED action',
  { skip: URL ? false : 'set isolated Coordinator PostgreSQL identity variables to run' }, async () => {
    const c = await connect();
    const schema = 'pcc_v110_session_delete_02';
    try {
      await setup(c, schema);
      assert.equal(await txn(c, async () => {
        await insertAction(c, 'act-delete', 'CLAIMED', {});
        await insertSession(c, 'act-delete', 'session-delete');
        await c.query(`UPDATE project_action SET status='APPLIED',result_session_id='session-delete'
                        WHERE id='act-delete'`);
      }), null, 'the ordinary dispatch must establish the valid two-way link first');
      assert.equal(await txn(c, async () => {
        await c.query(`UPDATE session SET deleted_at=clock_timestamp() WHERE id='session-delete'`);
      }), null, 'the supported trash step must still commit');
      assert.equal(await txn(c, async () => {
        await c.query(`DELETE FROM session WHERE id='session-delete'`);
      }), null, 'no v1.10 DELETE event or declared FK protects the standing invariant');
      assert.deepEqual((await c.query(`
        SELECT a.status, a.result_session_id,
               EXISTS (SELECT 1 FROM session s WHERE s.id=a.result_session_id) AS session_exists
          FROM project_action a WHERE a.id='act-delete'`)).rows[0],
      { status: 'APPLIED', result_session_id: 'session-delete', session_exists: false },
      'the committed state is the I17-A3 forbidden orphan');
    } finally {
      await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await c.end();
    }
  });

test('PC-CX-55 on isolated Postgres: a malformed initial ledger commits, then bricks every legal update',
  { skip: URL ? false : 'set isolated Coordinator PostgreSQL identity variables to run' }, async () => {
    const c = await connect();
    const schema = 'pcc_v110_malformed_ledger_02';
    try {
      await setup(c, schema);
      assert.equal(await txn(c, async () => {
        await insertAction(c, 'act-malformed', 'CLAIMED', { retiredPins: {} });
      }), null, 'D18 has no INSERT event and D16 returns early for an unpublished CLAIMED action');

      const terminal = await txn(c, async () => {
        await c.query(`UPDATE project_action SET status='REFUSED',refusal_code='PROVIDER_UNAVAILABLE'
                        WHERE id='act-malformed'`);
      });
      assert.equal(terminal?.code, '22023', 'the normal terminal transition raises PostgreSQL\'s native JSON error');
      assert.match(terminal?.message ?? '', /cannot get array length of a non-array|cannot extract elements from an object/);
      assert.doesNotMatch(terminal?.message ?? '', /EXECUTION_PIN_LEDGER/,
        'the failure is not the typed contract refusal promised to callers');

      const repair = await txn(c, async () => {
        await c.query(`UPDATE project_action SET detail='{}'::jsonb WHERE id='act-malformed'`);
      });
      assert.equal(repair?.code, '22023', 'even repairing the malformed value evaluates the old object as an array');
      assert.deepEqual((await c.query(`SELECT status,detail::text AS detail FROM project_action
                                       WHERE id='act-malformed'`)).rows[0],
        { status: 'CLAIMED', detail: '{"retiredPins": {}}' },
        'the permanent action/key remains stuck in CLAIMED with the value no legal UPDATE can repair');
    } finally {
      await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await c.end();
    }
  });

test('v1.10 independent-review inventory is explicit and every destructive PG path is safety-gated', () => {
  const source = readFileSync(TEST_SOURCE, 'utf8');
  for (const id of ['PC-CX-53', 'PC-CX-54', 'PC-CX-55']) assert.ok(source.includes(id), `${id} is missing`);
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
