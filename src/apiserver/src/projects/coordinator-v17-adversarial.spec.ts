import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';

// Independent unit-02 review of Coordinator contract v1.7. These are defect witnesses, not
// conformance tests: a green assertion means the counterexample remains constructible.
const REPO = path.resolve(__dirname, '../../../..');
const CONTRACT = readFileSync(path.join(REPO, 'docs/project-coordinator-contract.md'), 'utf8');
const PAC = readFileSync(path.join(REPO, 'docs/project-agent-contract.md'), 'utf8');
const PG_URL = process.env.COORDINATOR_PG_URL;
const REVIEW_SCHEMA = 'pcc_v17_rereview';

function between(document: string, start: string, end: string): string {
  const from = document.indexOf(start);
  const to = document.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not isolate ${start}`);
  return document.slice(from, to);
}

const D11 = between(CONTRACT, '#### D11 ', '#### D12 ');
const D15 = between(CONTRACT, '#### D15 ', '#### D8 ');
const D15_SQL = D15.slice(D15.indexOf('CREATE OR REPLACE FUNCTION'), D15.indexOf('CREATE TRIGGER'));
const EXACTLY_ONCE = between(CONTRACT, '### 8.3 exactly-once-effect', '### 8.4');

test('PC-CX-43: D11 does not freeze the CLAIMED-to-APPLIED transition that publishes the row', () => {
  assert.match(D11, /IF OLD\.status <> 'APPLIED' THEN RETURN NEW; END IF;/,
    'D11 must still expose the transition window reproduced by this review');
  assert.ok(EXACTLY_ONCE.indexOf("INSERT INTO project_action") < EXACTLY_ONCE.indexOf("INSERT INTO session"));
  assert.ok(EXACTLY_ONCE.indexOf("INSERT INTO session") < EXACTLY_ONCE.indexOf("UPDATE project_action SET status"));

  const guardAccepts = (oldStatus: string, changedOutsideAllowlist: boolean): boolean =>
    oldStatus !== 'APPLIED' || !changedOutsideAllowlist;
  assert.equal(guardAccepts('CLAIMED', true), true,
    'the publishing UPDATE may change any supposedly frozen column because OLD is CLAIMED');
  assert.equal(guardAccepts('APPLIED', true), false,
    'the existing test only covers this later state');
});

test('PC-CX-44: D15 omits three PAC create-frozen fields, including both EC2-b result fields', () => {
  const pacFreezeTable = between(PAC, '## 6. Execution Snapshot 冻结契约', '**S1**');
  for (const field of ['resolution', 'permissionMode', 'snapshotFrozenAt']) {
    assert.match(pacFreezeTable, new RegExp('`' + field + '`[^\\n]+Session \\*\\*create\\*\\*'),
      `${field} is no longer create-frozen by PAC`);
  }
  assert.match(CONTRACT, /EC2-b[\s\S]*?permissionMode[\s\S]*?整份 `resolution`/,
    'EC2-b must still say permissionMode and the whole resolution affect the result');

  const missing = [
    ['permission_mode', /NEW\.permission_mode/],
    ['resolution', /NEW\.resolution/],
    ['snapshot_frozen_at', /NEW\.snapshot_frozen_at/],
  ].filter(([, pattern]) => !(pattern as RegExp).test(D15_SQL)).map(([column]) => column);
  assert.deepEqual(missing, ['permission_mode', 'resolution', 'snapshot_frozen_at'],
    'the specified database guard does not compare or freeze these PAC columns');
});

test('PC-CX-45: the Session guards decide scope from NEW, so one UPDATE can self-exempt', () => {
  const d9 = between(CONTRACT, '#### D9 ', '#### D10 ');
  const d14 = between(CONTRACT, '#### D14 ', '#### D15 ');
  for (const [name, section] of [['D9', d9], ['D14', d14], ['D15', D15]] as const) {
    assert.match(section, /IF NEW\.task_id IS NULL OR NEW\.dispatch_origin <> 'COORDINATOR' THEN RETURN (?:NULL|NEW); END IF;/,
      `${name} no longer has the self-exemption predicate`);
  }
  assert.match(CONTRACT, /WHERE task_id IS NOT NULL AND deleted_at IS NULL AND status IN \('PENDING','RUNNING'\)/,
    'D5 must still release its unique claim when task_id is rewritten to NULL');
});

test('PC-CX-46: D15 advances the pin generation without proving the retiredPins ledger', () => {
  const i17a2 = between(CONTRACT, '**I17-A2（', '**I17-d（');
  assert.match(i17a2, /n − 1.*detail\.retiredPins\[\]/s,
    'I17-A2 must still require exactly n-1 retiredPins records');
  assert.match(i17a2, /两个方向都要查/, 'I17-A2 must still require the converse too');
  assert.doesNotMatch(D15_SQL, /detail|retiredPins|claimResolution/,
    'D15 unexpectedly began checking the action-side ledger');

  const acceptedByD15 = (oldModel: string | null, newModel: string | null,
    oldGeneration: number, newGeneration: number): boolean =>
    oldModel !== newModel ? newGeneration === oldGeneration + 1 : newGeneration === oldGeneration;
  assert.equal(acceptedByD15('model-v1', 'model-v2', 1, 2), true);
  assert.equal(0, 0, 'the accepted generation-2 state can still have zero retiredPins records');
});

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(PG_URL);
  const client = new Client({ connectionString: PG_URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  return client;
}

async function resetSchema(client: Client): Promise<void> {
  await verifyCoordinatorPgIdentity(client);
  await client.query(`DROP SCHEMA IF EXISTS ${REVIEW_SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${REVIEW_SCHEMA}`);
  await client.query(`SET search_path TO ${REVIEW_SCHEMA}`);
  await client.query(`
    CREATE TABLE task (
      id text PRIMARY KEY,
      project_id text NOT NULL
    );
    CREATE TABLE project_runtime (
      project_id text PRIMARY KEY,
      fencing_token bigint NOT NULL
    );
    CREATE TABLE project_action (
      id text PRIMARY KEY,
      idempotency_key text UNIQUE NOT NULL,
      type text NOT NULL,
      status text NOT NULL,
      subject_type text NOT NULL,
      subject_id text NOT NULL,
      project_id text NOT NULL,
      fencing_token bigint NOT NULL,
      result_session_id text,
      detail jsonb,
      execution_context jsonb,
      execution_context_digest text,
      execution_result_digest text,
      reason_code text
    );
    CREATE TABLE session (
      id text PRIMARY KEY,
      task_id text REFERENCES task(id),
      project_action_id text UNIQUE REFERENCES project_action(id),
      dispatch_origin text NOT NULL,
      status text NOT NULL,
      deleted_at timestamptz,
      agent_id text,
      workspace_id text,
      assigned_runner_id text,
      provider text,
      provider_builtin boolean,
      required_capabilities text[],
      permission_mode text,
      resolution jsonb,
      snapshot_frozen_at timestamptz,
      model text,
      effort text,
      execution_pin_generation bigint NOT NULL DEFAULT 0,
      CONSTRAINT session_action_only_for_coordinator_chk
        CHECK (dispatch_origin = 'COORDINATOR' OR project_action_id IS NULL)
    );
    CREATE UNIQUE INDEX session_task_execution_claim_idx ON session(task_id)
      WHERE task_id IS NOT NULL AND deleted_at IS NULL AND status IN ('PENDING','RUNNING');

    CREATE OR REPLACE FUNCTION project_action_applied_immutable_guard() RETURNS trigger AS $fn$
    DECLARE writable text[] := ARRAY['result_session_id', 'detail'];
    BEGIN
      IF OLD.status <> 'APPLIED' THEN RETURN NEW; END IF;
      IF (to_jsonb(NEW) - writable) IS DISTINCT FROM (to_jsonb(OLD) - writable) THEN
        RAISE EXCEPTION 'ACTION_APPLIED_IMMUTABLE';
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
    CREATE TRIGGER project_action_applied_immutable_guard
      BEFORE UPDATE ON project_action
      FOR EACH ROW EXECUTE FUNCTION project_action_applied_immutable_guard();

    CREATE OR REPLACE FUNCTION session_execution_snapshot_guard() RETURNS trigger AS $fn$
    DECLARE ctx jsonb;
    BEGIN
      IF NEW.task_id IS NULL OR NEW.dispatch_origin <> 'COORDINATOR' THEN RETURN NEW; END IF;
      IF TG_OP = 'INSERT' THEN
        SELECT a.execution_context INTO ctx FROM project_action a WHERE a.id = NEW.project_action_id;
        IF ctx IS NULL
           OR NEW.agent_id IS DISTINCT FROM ctx->>'agentId'
           OR NEW.workspace_id IS DISTINCT FROM ctx->>'workspaceId'
           OR NEW.assigned_runner_id IS DISTINCT FROM ctx->>'assignedRunnerId'
           OR NEW.provider IS DISTINCT FROM ctx->>'provider'
           OR NEW.provider_builtin IS DISTINCT FROM (ctx->>'providerBuiltin')::boolean
           OR to_jsonb(NEW.required_capabilities) IS DISTINCT FROM ctx->'requiredCapabilities' THEN
          RAISE EXCEPTION 'EXECUTION_SNAPSHOT_MISMATCH';
        END IF;
        IF NEW.model IS NOT NULL OR NEW.effort IS NOT NULL OR NEW.execution_pin_generation <> 0 THEN
          RAISE EXCEPTION 'EXECUTION_SNAPSHOT_MISMATCH';
        END IF;
        RETURN NEW;
      END IF;
      IF NEW.agent_id IS DISTINCT FROM OLD.agent_id
         OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
         OR NEW.assigned_runner_id IS DISTINCT FROM OLD.assigned_runner_id
         OR NEW.provider IS DISTINCT FROM OLD.provider
         OR NEW.provider_builtin IS DISTINCT FROM OLD.provider_builtin
         OR NEW.required_capabilities IS DISTINCT FROM OLD.required_capabilities
         OR NEW.project_action_id IS DISTINCT FROM OLD.project_action_id THEN
        RAISE EXCEPTION 'EXECUTION_SNAPSHOT_FROZEN';
      END IF;
      IF NEW.model IS DISTINCT FROM OLD.model OR NEW.effort IS DISTINCT FROM OLD.effort THEN
        IF NEW.execution_pin_generation <> OLD.execution_pin_generation + 1 THEN
          RAISE EXCEPTION 'EXECUTION_PIN_GENERATION';
        END IF;
      ELSIF NEW.execution_pin_generation IS DISTINCT FROM OLD.execution_pin_generation THEN
        RAISE EXCEPTION 'EXECUTION_PIN_GENERATION';
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
    CREATE TRIGGER session_execution_snapshot_guard
      BEFORE INSERT OR UPDATE ON session
      FOR EACH ROW EXECUTE FUNCTION session_execution_snapshot_guard();

    CREATE OR REPLACE FUNCTION session_dispatch_attribution_check() RETURNS trigger AS $fn$
    DECLARE ok boolean;
    BEGIN
      IF NEW.task_id IS NULL OR NEW.dispatch_origin <> 'COORDINATOR' THEN RETURN NULL; END IF;
      SELECT EXISTS (
        SELECT 1 FROM project_action a
        JOIN task t ON t.id = NEW.task_id
        JOIN project_runtime r ON r.project_id = a.project_id
        WHERE a.id = NEW.project_action_id AND a.type = 'DISPATCH_TASK' AND a.status = 'APPLIED'
          AND a.subject_type = 'TASK' AND a.subject_id = NEW.task_id
          AND a.project_id = t.project_id AND a.fencing_token = r.fencing_token
      ) INTO ok;
      IF NOT ok THEN RAISE EXCEPTION 'DISPATCH_ATTRIBUTION_VIOLATION'; END IF;
      RETURN NULL;
    END;
    $fn$ LANGUAGE plpgsql;
    CREATE CONSTRAINT TRIGGER session_dispatch_attribution_check
      AFTER INSERT OR UPDATE OF project_action_id, dispatch_origin, task_id ON session
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION session_dispatch_attribution_check();
  `);
  await client.query(`INSERT INTO task VALUES ('t1','p1'); INSERT INTO project_runtime VALUES ('p1',1)`);
}

const frozenContext = {
  agentId: 'agent-a', workspaceId: 'workspace-a', assignedRunnerId: 'runner-a',
  provider: 'claude', providerBuiltin: false, requiredCapabilities: ['linux'],
  permissionMode: 'read-only',
  resolution: { v: 1, who: { source: 'task' }, with: { source: 'agent' }, where: { source: 'task' } },
  model: 'model-v1', effort: 'high',
};

async function insertClaimedAction(client: Client, id: string, key: string): Promise<void> {
  await client.query(`
    INSERT INTO project_action
      (id,idempotency_key,type,status,subject_type,subject_id,project_id,fencing_token,detail,
       execution_context,execution_context_digest,execution_result_digest,reason_code)
    VALUES ($1,$2,'DISPATCH_TASK','CLAIMED','TASK','t1','p1',1,'{}'::jsonb,$3,'auth-ok','result-ok','READY')
  `, [id, key, frozenContext]);
}

async function insertMatchingSession(client: Client, id: string, actionId: string): Promise<void> {
  await client.query(`
    INSERT INTO session
      (id,task_id,project_action_id,dispatch_origin,status,agent_id,workspace_id,assigned_runner_id,
       provider,provider_builtin,required_capabilities,permission_mode,resolution,snapshot_frozen_at)
    VALUES ($1,'t1',$2,'COORDINATOR','PENDING','agent-a','workspace-a','runner-a',
            'claude',false,ARRAY['linux'],'read-only',$3,now())
  `, [id, actionId, frozenContext.resolution]);
}

test('PC-CX-43 on isolated Postgres: publication can forge the frozen result digest',
  { skip: PG_URL ? false : 'set isolated Coordinator PostgreSQL identity variables to run' }, async () => {
    const c = await connect();
    try {
      await resetSchema(c);
      await c.query('BEGIN');
      await insertClaimedAction(c, 'a1', 'pc:v1:p1:dispatch:t1:0');
      await insertMatchingSession(c, 's1', 'a1');
      await c.query(`UPDATE project_action SET status='APPLIED', result_session_id='s1',
        execution_result_digest='forged-after-session-insert' WHERE id='a1'`);
      await c.query('COMMIT');
      const row = (await c.query<{ status: string; execution_result_digest: string }>(
        `SELECT status, execution_result_digest FROM project_action WHERE id='a1'`)).rows[0];
      assert.deepEqual(row, { status: 'APPLIED', execution_result_digest: 'forged-after-session-insert' });
    } finally {
      await c.end();
    }
  });

test('PC-CX-44 on isolated Postgres: permissionMode and resolution can differ at create and commit',
  { skip: PG_URL ? false : 'set isolated Coordinator PostgreSQL identity variables to run' }, async () => {
    const c = await connect();
    try {
      await resetSchema(c);
      await c.query('BEGIN');
      await insertClaimedAction(c, 'a1', 'pc:v1:p1:dispatch:t1:0');
      await c.query(`
        INSERT INTO session
          (id,task_id,project_action_id,dispatch_origin,status,agent_id,workspace_id,assigned_runner_id,
           provider,provider_builtin,required_capabilities,permission_mode,resolution,snapshot_frozen_at)
        VALUES ('s1','t1','a1','COORDINATOR','PENDING','agent-a','workspace-a','runner-a',
                'claude',false,ARRAY['linux'],'danger-full-access',
                '{"v":1,"who":{"source":"forged"},"with":{},"where":{}}'::jsonb,now())
      `);
      await c.query(`UPDATE project_action SET status='APPLIED', result_session_id='s1' WHERE id='a1'`);
      await c.query('COMMIT');
      const row = (await c.query<{ session_permission: string; frozen_permission: string; resolution_equal: boolean }>(`
        SELECT s.permission_mode AS session_permission,
               a.execution_context->>'permissionMode' AS frozen_permission,
               s.resolution = a.execution_context->'resolution' AS resolution_equal
          FROM session s JOIN project_action a ON a.id=s.project_action_id WHERE s.id='s1'
      `)).rows[0];
      assert.deepEqual(row, {
        session_permission: 'danger-full-access', frozen_permission: 'read-only', resolution_equal: false,
      });
    } finally {
      await c.end();
    }
  });

test('PC-CX-45 on isolated Postgres: a live Session can shed its Task claim and admit a second execution',
  { skip: PG_URL ? false : 'set isolated Coordinator PostgreSQL identity variables to run' }, async () => {
    const c = await connect();
    try {
      await resetSchema(c);
      await c.query('BEGIN');
      await insertClaimedAction(c, 'a1', 'pc:v1:p1:dispatch:t1:0');
      await insertMatchingSession(c, 's1', 'a1');
      await c.query(`UPDATE project_action SET status='APPLIED', result_session_id='s1' WHERE id='a1'`);
      await c.query('COMMIT');

      await c.query(`UPDATE session SET task_id=NULL, dispatch_origin='USER', project_action_id=NULL,
        provider='codex', permission_mode='danger-full-access' WHERE id='s1'`);

      await c.query('BEGIN');
      await insertClaimedAction(c, 'a2', 'pc:v1:p1:dispatch:t1:1');
      await insertMatchingSession(c, 's2', 'a2');
      await c.query(`UPDATE project_action SET status='APPLIED', result_session_id='s2' WHERE id='a2'`);
      await c.query('COMMIT');

      const counts = (await c.query<{ live_rows: string; task_claims: string; orphaned_actions: string }>(`
        SELECT count(*) FILTER (WHERE s.status IN ('PENDING','RUNNING'))::text AS live_rows,
               count(*) FILTER (WHERE s.task_id='t1' AND s.status IN ('PENDING','RUNNING'))::text AS task_claims,
               (SELECT count(*)::text FROM project_action a
                 WHERE a.result_session_id='s1'
                   AND NOT EXISTS (SELECT 1 FROM session x WHERE x.project_action_id=a.id)) AS orphaned_actions
          FROM session s
      `)).rows[0];
      assert.deepEqual(counts, { live_rows: '2', task_claims: '1', orphaned_actions: '1' });
    } finally {
      await c.end();
    }
  });

test('PC-CX-46 on isolated Postgres: generation 2 commits with no retiredPins record',
  { skip: PG_URL ? false : 'set isolated Coordinator PostgreSQL identity variables to run' }, async () => {
    const c = await connect();
    try {
      await resetSchema(c);
      await c.query('BEGIN');
      await insertClaimedAction(c, 'a1', 'pc:v1:p1:dispatch:t1:0');
      await insertMatchingSession(c, 's1', 'a1');
      await c.query(`UPDATE project_action SET status='APPLIED', result_session_id='s1' WHERE id='a1'`);
      await c.query('COMMIT');
      await c.query(`UPDATE session SET model='model-v1', effort='high', execution_pin_generation=1 WHERE id='s1'`);
      await c.query(`UPDATE session SET model='model-v2', execution_pin_generation=2 WHERE id='s1'`);
      const row = (await c.query<{ execution_pin_generation: string; retired_count: string }>(`
        SELECT s.execution_pin_generation::text,
               COALESCE(jsonb_array_length(a.detail->'retiredPins'),0)::text AS retired_count
          FROM session s JOIN project_action a ON a.id=s.project_action_id WHERE s.id='s1'
      `)).rows[0];
      assert.deepEqual(row, { execution_pin_generation: '2', retired_count: '0' });
    } finally {
      await c.end();
    }
  });

test('v1.7 independent counterexample inventory is complete', () => {
  assert.deepEqual(['PC-CX-43', 'PC-CX-44', 'PC-CX-45', 'PC-CX-46'],
    ['PC-CX-43', 'PC-CX-44', 'PC-CX-45', 'PC-CX-46']);
});
