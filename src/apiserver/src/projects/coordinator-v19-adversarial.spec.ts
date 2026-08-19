import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';

// Independent unit-02 review of Coordinator contract v1.9. The real-server tests execute the SQL
// extracted from the authoritative document itself; this file deliberately does not import or
// modify unit 01I's fixture. A passing PC-CX test means the counterexample was reproduced.
const REPO = path.resolve(__dirname, '../../../..');
const CONTRACT_PATH = path.join(REPO, 'docs/project-coordinator-contract.md');
const CONTRACT = readFileSync(CONTRACT_PATH, 'utf8');
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

const I17_A = between(CONTRACT, '- **I17-A（create 冻结列', '- **I17-A2（claim 冻结列');
const EC2_B = between(CONTRACT, '- **EC2-b（', '- **EC2-c（');
const EC6_C = between(CONTRACT, '- **EC6-c（', '- **EC6-d（');
const D11 = between(CONTRACT, '#### D11 ', '#### D12 ');
const D15 = between(CONTRACT, '#### D15 ', '#### D16 ');
const D16 = between(CONTRACT, '#### D16 ', '#### D8 ');
const D17 = between(CONTRACT, '#### D17 ', '#### D7 ');
const D11_SQL = firstSql(D11);
const D15_SQL = firstSql(D15);
const D16_SQL = firstSql(D16);
const D17_SQL = firstSql(D17);

test('PC-CX-50: D11 can detach the action-side half of D16 and then rewrite the ledger unchecked', () => {
  assert.match(D11_SQL, /ARRAY\['result_session_id', 'detail'\]/,
    'the two columns used by the witness are not D11-writable');
  assert.match(D11, /两者都不进任何硬门的谓词/,
    'D11-b no longer makes the claim contradicted by the executable gate');
  assert.match(D16_SQL, /NEW\.result_session_id IS NULL THEN RETURN NULL/,
    'the action-side gate no longer self-disables when the writable link is null');
  assert.match(D16_SQL, /NEW\.detail -> 'claimResolution'/,
    'the action-side hard gate no longer reads the other D11-writable column');
  assert.match(I17_A, /project_action_id.*指向的那条.*APPLIED.*DISPATCH_TASK/s,
    'I17-A no longer requires the reverse Session-to-action relationship');
});

test('PC-CX-51: deferred row events retain intermediate NEW tuples instead of re-reading final rows', () => {
  assert.match(D16, /判据都落在 `COMMIT` 那一刻的最终状态上/,
    'D16-a no longer promises final-state/order-independent validation');
  assert.match(D16_SQL, /FOR EACH ROW EXECUTE FUNCTION session_execution_result_check/);
  assert.match(D16_SQL, /FOR EACH ROW EXECUTE FUNCTION project_action_pin_ledger_check/);
  assert.match(D16_SQL, /coordinator_pin_ledger_fold\(NEW\.id, ctx, claim, ledger, NEW\.execution_pin_generation\)/,
    'the Session event no longer validates its captured NEW tuple');
  assert.match(D16_SQL, /coordinator_pin_ledger_fold\(NEW\.id, NEW\.execution_context, NEW\.detail/,
    'the action event no longer validates its captured NEW tuple');
  assert.doesNotMatch(D16_SQL, /FROM session s WHERE s\.id = NEW\.id/,
    'the Session trigger now re-reads the final triggering row');
  assert.doesNotMatch(D16_SQL, /FROM project_action a WHERE a\.id = NEW\.id/,
    'the action trigger now re-reads the final triggering row');
});

test('PC-CX-52: D17 neither enforces nonempty claim conclusions nor closes EC2-b result shape', () => {
  assert.match(EC6_C, /非空的具体值/, 'EC6-c no longer requires a nonempty conclusion');
  assert.match(EC2_B, /恰好三部分，封闭/, 'EC2-b no longer claims a closed result half');
  assert.match(D17_SQL, /ctx->>'model' IS NULL OR ctx->>'effort' IS NULL/,
    'the executable check changed; update the witness');
  assert.doesNotMatch(D17_SQL, /COALESCE\(ctx->>'model',''\) = ''/,
    'D17 now rejects the empty model value');
  for (const required of ['requiredCapabilities', 'permissionMode', 'resolution', 'snapshotFrozenAt']) {
    assert.equal(D17_SQL.includes(`ctx ? '${required}'`), false,
      `D17 now requires EC2-b.${required}; update the witness`);
  }
});

type ClientCtor = new (config: { connectionString?: string }) => Client;
async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const { Client: Ctor } = (await import('pg')) as unknown as { Client: ClientCtor };
  const client = new Ctor({ connectionString: URL });
  await client.connect();
  // This read-only identity probe is deliberately before install(), whose first statement is DDL.
  await verifyCoordinatorPgIdentity(client);
  return client;
}

const SCHEMA = 'pcc_v19_rereview_02';
const FROZEN_AT = '2026-08-19T00:00:00.000Z';
const CLAIM_AT = '2026-08-19T00:01:00.000Z';
const RETIRE_AT = '2026-08-19T00:02:00.000Z';

const TABLES = `
  CREATE TABLE task (id text PRIMARY KEY, project_id text NOT NULL);
  CREATE TABLE project_action (
    id text PRIMARY KEY, idempotency_key text UNIQUE NOT NULL, project_id text NOT NULL,
    type text NOT NULL, status text NOT NULL, subject_type text NOT NULL, subject_id text NOT NULL,
    fencing_token bigint NOT NULL, result_session_id text, detail jsonb, execution_context jsonb,
    execution_context_digest text, execution_result_digest text, reason_code text, refusal_code text
  );
  CREATE TABLE session (
    id text PRIMARY KEY, task_id text REFERENCES task(id),
    project_action_id text UNIQUE REFERENCES project_action(id), dispatch_origin text NOT NULL,
    status text NOT NULL, deleted_at timestamptz, agent_id text, workspace_id text,
    assigned_runner_id text, provider text, provider_builtin boolean, required_capabilities text[],
    permission_mode text, resolution jsonb, snapshot_frozen_at timestamptz, model text, effort text,
    execution_pin_generation bigint NOT NULL DEFAULT 0,
    CONSTRAINT session_action_only_for_coordinator_chk
      CHECK (dispatch_origin = 'COORDINATOR' OR project_action_id IS NULL)
  );
  INSERT INTO task VALUES ('t1', 'p1');
`;

async function install(c: Client): Promise<void> {
  await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}; SET search_path TO ${SCHEMA}; ${TABLES}`);
  // These are the normative SQL blocks, not copies maintained by this test.
  await c.query(D17_SQL); // digest helpers are also used to construct honest fixture rows
  await c.query(D11_SQL);
  await c.query(D15_SQL);
  await c.query(D16_SQL);
}

async function txn(c: Client, body: () => Promise<void>): Promise<string> {
  await c.query('BEGIN');
  try {
    await body();
    await c.query('COMMIT');
    return '';
  } catch (error) {
    await c.query('ROLLBACK');
    return (error as Error).message;
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
function sqlJson(value: Json): string {
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
}

function context(options: { model?: string; effort?: string; omit?: string[] } = {}): { [key: string]: Json } {
  const model = options.model ?? 'model-v1';
  const ctx: { [key: string]: Json } = {
    agentId: 'a1', workspaceId: 'w1', assignedRunnerId: 'r1', provider: 'claude', providerBuiltin: true,
    requiredCapabilities: ['linux'], permissionMode: 'read-only',
    resolution: { v: 1, who: { source: 'task' } }, snapshotFrozenAt: FROZEN_AT,
    model, effort: options.effort ?? 'high',
    authorization: {
      resolvedAgentId: 'a1', projectMemberId: 'm1', taskId: 't1', taskAssigneeAgentId: 'a1',
      providerSlug: 'claude', model, workspaceId: 'w1', runnerId: 'r1', coordinatorWorkspaceId: null,
    },
  };
  for (const key of options.omit ?? []) delete ctx[key];
  return ctx;
}

async function dispatch(c: Client, ctx: { [key: string]: Json } = context()): Promise<string> {
  const literal = sqlJson(ctx);
  return txn(c, async () => {
    await c.query('DELETE FROM session; DELETE FROM project_action');
    await c.query(`
      INSERT INTO project_action (id,idempotency_key,project_id,type,status,subject_type,subject_id,
        fencing_token,result_session_id,detail,execution_context,execution_context_digest,
        execution_result_digest,reason_code,refusal_code)
      VALUES ('act1','k1','p1','DISPATCH_TASK','CLAIMED','TASK','t1',1,NULL,'{}'::jsonb,
        ${literal},coordinator_execution_digest(${literal}->'authorization'),
        coordinator_execution_digest(${literal}-'authorization'),'MANUAL',NULL)`);
    await c.query(`
      INSERT INTO session (id,task_id,project_action_id,dispatch_origin,status,agent_id,workspace_id,
        assigned_runner_id,provider,provider_builtin,required_capabilities,permission_mode,resolution,
        snapshot_frozen_at)
      SELECT 's1','t1','act1','COORDINATOR','PENDING', execution_context->>'agentId',
        execution_context->>'workspaceId', execution_context->>'assignedRunnerId',
        execution_context->>'provider', (execution_context->>'providerBuiltin')::boolean,
        CASE WHEN execution_context ? 'requiredCapabilities'
             THEN ARRAY(SELECT jsonb_array_elements_text(execution_context->'requiredCapabilities')) END,
        execution_context->>'permissionMode', execution_context->'resolution',
        (execution_context->>'snapshotFrozenAt')::timestamptz
        FROM project_action WHERE id='act1'`);
    await c.query(`UPDATE project_action SET status='APPLIED', result_session_id='s1' WHERE id='act1'`);
  });
}

function part(frozen: string, value = frozen, source = 'FROZEN_CONTEXT'): { [key: string]: Json } {
  return { frozen, value, source };
}

function claim(model = 'model-v1', effort = 'high'): { [key: string]: Json } {
  return { generation: 1, at: CLAIM_AT, model: part(model), effort: part(effort) };
}

function retired(): { [key: string]: Json } {
  return {
    generation: 2, component: 'model', from: 'model-v1', to: 'model-v2',
    at: RETIRE_AT, reason: 'RUNTIME_RETIRED',
  };
}

test('PC-CX-50 on real Postgres: clearing result_session_id disables action-side ledger validation',
  { skip: URL ? false : 'set an isolated COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    try {
      await install(c);
      assert.equal(await dispatch(c), '');
      assert.equal(await txn(c, async () => {
        await c.query(`UPDATE project_action SET detail=jsonb_build_object('claimResolution',${sqlJson(claim())}) WHERE id='act1'`);
        await c.query(`UPDATE session SET model='model-v1',effort='high',execution_pin_generation=1 WHERE id='s1'`);
      }), '', 'the honest first claim must commit');

      assert.equal(await txn(c, async () => {
        await c.query(`UPDATE project_action SET result_session_id=NULL WHERE id='act1'`);
      }), '', 'D11 permits the link to be cleared and D16 returns early');
      assert.equal(await txn(c, async () => {
        await c.query(`UPDATE project_action SET detail='{"claimResolution":{}}'::jsonb WHERE id='act1'`);
      }), '', 'after detach, the other D11-writable predicate is unchecked');

      const observed = (await c.query<{
        action_result: string | null; session_action: string; generation: string; claim: string;
      }>(`
        SELECT a.result_session_id AS action_result, s.project_action_id AS session_action,
               s.execution_pin_generation::text AS generation, (a.detail->'claimResolution')::text AS claim
          FROM session s JOIN project_action a ON a.id=s.project_action_id WHERE s.id='s1'`)).rows[0];
      assert.deepEqual(observed, { action_result: null, session_action: 'act1', generation: '1', claim: '{}' },
        'committed state violates the advertised bidirectional action/session/pin relation');
      console.log(`PC-CX-50 witness=${JSON.stringify(observed)}`);
    } finally {
      await c.end();
    }
  });

test('PC-CX-51 on real Postgres: intermediate heartbeat/detail events reject a valid final claim state',
  { skip: URL ? false : 'set an isolated COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    try {
      await install(c);
      assert.equal(await dispatch(c), '');
      const heartbeatFirst = await txn(c, async () => {
        await c.query(`UPDATE session SET status='RUNNING' WHERE id='s1'`);
        await c.query(`UPDATE project_action SET detail=jsonb_build_object('claimResolution',${sqlJson(claim())}) WHERE id='act1'`);
        await c.query(`UPDATE session SET model='model-v1',effort='high',execution_pin_generation=1 WHERE id='s1'`);
      });
      assert.match(heartbeatFirst, /EXECUTION_PIN_LEDGER/,
        'the early Session event retains generation 0 while reading the final claim ledger');

      assert.equal(await dispatch(c), '');
      const displayFirst = await txn(c, async () => {
        await c.query(`UPDATE project_action SET detail='{"display":{"note":"ready"}}'::jsonb WHERE id='act1'`);
        await c.query(`UPDATE project_action SET detail=detail || jsonb_build_object('claimResolution',${sqlJson(claim())}) WHERE id='act1'`);
        await c.query(`UPDATE session SET model='model-v1',effort='high',execution_pin_generation=1 WHERE id='s1'`);
      });
      assert.match(displayFirst, /EXECUTION_PIN_LEDGER/,
        'the early action event retains a pre-claim detail while reading the final generation');
      console.log(`PC-CX-51 heartbeat=${JSON.stringify(heartbeatFirst)} display=${JSON.stringify(displayFirst)}`);

      const state = (await c.query<{ status: string; generation: string; detail: string }>(`
        SELECT s.status,s.execution_pin_generation::text AS generation,a.detail::text AS detail
          FROM session s JOIN project_action a ON a.id=s.project_action_id WHERE s.id='s1'`)).rows[0];
      assert.deepEqual(state, { status: 'PENDING', generation: '0', detail: '{}' }, 'both transactions rolled back');

      // The proposed final state is internally valid; it is the queued historical events that reject it.
      const folded = (await c.query<{ pin: { model: string; effort: string } }>(`
        SELECT coordinator_pin_ledger_fold('final-state', ${sqlJson(context())}, ${sqlJson(claim())},
          '[]'::jsonb, 1) AS pin`)).rows[0].pin;
      assert.deepEqual(folded, { model: 'model-v1', effort: 'high' });
    } finally {
      await c.end();
    }
  });

test('PC-CX-52 on real Postgres: empty conclusions and an incomplete EC2-b half both commit',
  { skip: URL ? false : 'set an isolated COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    try {
      await install(c);
      assert.equal(await dispatch(c, context({ model: '', effort: '' })), '',
        'D17 mistakes empty strings for concrete conclusions');
      assert.equal(await txn(c, async () => {
        await c.query(`UPDATE project_action SET detail=jsonb_build_object('claimResolution',${sqlJson(claim('', ''))}) WHERE id='act1'`);
        await c.query(`UPDATE session SET model='',effort='',execution_pin_generation=1 WHERE id='s1'`);
      }), '', 'D16 accepts empty concrete frozen/value pins');
      const empty = (await c.query<{ model: string; effort: string }>(
        `SELECT model,effort FROM session WHERE id='s1'`)).rows[0];
      assert.deepEqual(empty, { model: '', effort: '' });

      const missing = ['requiredCapabilities', 'permissionMode', 'resolution', 'snapshotFrozenAt'];
      assert.equal(await dispatch(c, context({ omit: missing })), '',
        'D17 does not enforce EC2-b\'s closed top-level result shape');
      const shape = (await c.query<{ missing: string[]; capabilities: string[] | null; permission: string | null }>(`
        SELECT ARRAY(SELECT k FROM unnest(ARRAY['requiredCapabilities','permissionMode','resolution','snapshotFrozenAt']) k
                     WHERE NOT (a.execution_context ? k)) AS missing,
               s.required_capabilities AS capabilities, s.permission_mode AS permission
          FROM project_action a JOIN session s ON s.project_action_id=a.id WHERE a.id='act1'`)).rows[0];
      assert.deepEqual(shape, { missing, capabilities: null, permission: null },
        'a digest can be correct for an incomplete result half while the Session carries SQL nulls');
      console.log(`PC-CX-52 empty=${JSON.stringify(empty)} incomplete=${JSON.stringify(shape)}`);
    } finally {
      await c.end();
    }
  });

test('v1.9 independent-review inventory is explicit and its PG path is safety-gated', () => {
  assert.deepEqual(['PC-CX-50', 'PC-CX-51', 'PC-CX-52'], ['PC-CX-50', 'PC-CX-51', 'PC-CX-52']);
  const self = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-v19-adversarial.spec.ts'), 'utf8');
  assert.match(self, /assertCoordinatorPgUrlIsIsolated\(URL\)/);
  assert.match(self, /await verifyCoordinatorPgIdentity\(client\)/);
  assert.ok(self.indexOf('await verifyCoordinatorPgIdentity(client)') < self.indexOf('await c.query(`DROP SCHEMA'),
    'identity verification must textually precede the first destructive statement');
});
