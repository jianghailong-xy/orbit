import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';

// Independent unit-02 review of Coordinator contract v1.9, flipped by unit 01J for v1.10.
//
// v1.9 shape: every assertion below exhibited the predicate D11/D16/D17 actually enforced and a
// committed state those predicates accept while the prose invariants reject. v1.10 closed
// `PC-CX-50..52`, so a witness assertion would now necessarily go red — the same discipline §24.6,
// §25.7, §26.5 and §27.4 applied to the v1.5–v1.8 spec files. Each test therefore asserts TWO
// things:
//   1. the closed shape — v1.10's clause/object refuses the review's exact state, and
//   2. the reverse control — v1.9's shape, rebuilt verbatim, still admits it.
// Deleting the reverse control would make the fix unfalsifiable, so it stays. The real-server tests
// still execute the SQL extracted from the authoritative document itself; this file deliberately
// does not import or modify unit 01I/01J's fixture.
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
const I17_A3 = between(CONTRACT, '- **I17-A3（lineage', '- **I17-d（');
const EC2_B = between(CONTRACT, '- **EC2-b（', '- **EC2-b2（');
const EC2_B2 = between(CONTRACT, '- **EC2-b2（', '- **EC2-c（');
const EC6_C = between(CONTRACT, '- **EC6-c（', '- **EC6-d（');
const D11 = between(CONTRACT, '#### D11 ', '#### D12 ');
const D15 = between(CONTRACT, '#### D15 ', '#### D16 ');
const D16 = between(CONTRACT, '#### D16 ', '#### D8 ');
const D17 = between(CONTRACT, '#### D17 ', '#### D18 ');
const D18 = between(CONTRACT, '#### D18 ', '#### D7 ');
const D11_SQL = firstSql(D11);
const D15_SQL = firstSql(D15);
const D16_SQL = firstSql(D16);
const D17_SQL = firstSql(D17);
const D18_SQL = firstSql(D18);

test('PC-CX-50: the two D11-writable columns can no longer close the gate that reads them', () => {
  // The review's premise is unchanged and must stay true, or the witness stopped being a witness:
  // these are still the two columns D11 leaves open after APPLIED.
  assert.match(D11_SQL, /ARRAY\['result_session_id', 'detail'\]/,
    'the two columns used by the witness are no longer D11-writable');

  // Closed (1/3): D11-b withdraws the sentence that said they enter no predicate, and hands the
  // *how* to D18 — the closed, monotonic mutator the review asked for.
  assert.doesNotMatch(
    D11.split('\n').filter((line) => !/v1\.[789]|PC-CX-\d\d/.test(line)).join('\n'),
    /两者都不进任何硬门的谓词/,
    'D11-b still claims, without provenance, that the writable columns enter no hard gate');
  assert.match(D18_SQL, /ACTION_RESULT_LINK_FROZEN/, 'D18 does not freeze a published result link');
  assert.match(D18_SQL, /cannot detach or repoint its result session/,
    'D18 does not refuse both a detach and a repoint');
  assert.match(D18_SQL, /rewrites a claimResolution that is already recorded/,
    'D18 lets a recorded first claim be rewritten');
  assert.match(D18_SQL, /rewrites or truncates a retired pin that is already recorded/,
    'D18 lets the retiredPins ledger shrink or be rewritten in place');
  assert.match(D18_SQL, /BEFORE UPDATE ON project_action/, 'D18 is not a statement-level mutator');

  // Closed (2/3): the action side no longer early-exits on the column it is supposed to protect.
  assert.doesNotMatch(D16_SQL, /NEW\.result_session_id IS NULL THEN RETURN NULL/,
    'the action-side gate still self-disables when the writable link is null');
  assert.match(D16_SQL, /EXECUTION_RESULT_LINK/, 'the commit point has no typed refusal for a one-sided link');
  assert.match(D16_SQL, /do not point at each other/, 'the commit point does not require the link to be symmetric');
  assert.match(D16_SQL, /AFTER INSERT OR UPDATE ON project_action/,
    'the action-side trigger still carries an UPDATE OF column list');

  // Closed (3/3): I17-A3's queryable form no longer admits a null link as vacuously symmetric.
  assert.match(I17_A3, /result_session_id` \*\*为 NULL\*\*/, 'I17-A3 still states only the symmetric half');
  assert.match(I17_A, /project_action_id.*指向的那条.*APPLIED.*DISPATCH_TASK/s,
    'I17-A no longer requires the reverse Session-to-action relationship');

  // Reverse control — v1.9's action-side predicate, modelled verbatim. It early-exits on the very
  // column D11 leaves writable, so the review's two transactions still commit under it.
  const v19ActionSideRuns = (resultSessionId: string | null): boolean => resultSessionId !== null;
  const v110ActionSideRuns = (status: string, resultSessionId: string | null): boolean =>
    status === 'APPLIED' || resultSessionId !== null;
  assert.equal(v19ActionSideRuns(null), false, 'reverse control: v1.9 stops looking once the link is cleared');
  assert.equal(v110ActionSideRuns('APPLIED', null), true, 'v1.10 must still judge an applied dispatch with no link');
  assert.equal(v110ActionSideRuns('CLAIMED', null), false, 'an unpublished dispatch still has nothing to say');
});

test('PC-CX-51: every deferred row constraint judges the final row, not the tuple it queued with', () => {
  // The promise the review measured against is still made, so the fix is still load-bearing.
  assert.match(D16, /判据都落在 `COMMIT` 那一刻的最终状态上/,
    'D16-a no longer promises final-state/order-independent validation');
  assert.match(D16_SQL, /FOR EACH ROW EXECUTE FUNCTION session_execution_result_check/);
  assert.match(D16_SQL, /FOR EACH ROW EXECUTE FUNCTION project_action_pin_ledger_check/);

  // Closed: each deferred row constraint re-reads its own row by the stable key before judging it.
  const deferred: [string, string, string][] = [
    ['D9', between(CONTRACT, '#### D9 ', '#### D10 '), 'FROM session WHERE id = NEW.id'],
    ['D10', between(CONTRACT, '#### D10 ', '#### D11 '), 'FROM task WHERE id = NEW.id'],
    ['D14', between(CONTRACT, '#### D14 ', '#### D15 '), 'FROM session WHERE id = NEW.id'],
    ['D16 session side', D16_SQL, 'FROM session WHERE id = NEW.id'],
    ['D16 action side', D16_SQL, 'FROM project_action WHERE id = NEW.id'],
    ['D17', D17_SQL, 'FROM project_action WHERE id = NEW.id'],
  ];
  for (const [name, section, reread] of deferred) {
    assert.ok(section.includes(reread), `${name} still validates the NEW tuple its statement queued with`);
  }
  assert.doesNotMatch(D16_SQL, /coordinator_pin_ledger_fold\(NEW\.id, ctx, claim, ledger, NEW\.execution_pin_generation\)/,
    'the Session event still folds against its captured NEW tuple');
  assert.doesNotMatch(D16_SQL, /coordinator_pin_ledger_fold\(NEW\.id, NEW\.execution_context, NEW\.detail/,
    'the action event still folds against its captured NEW tuple');
  assert.ok(CONTRACT.includes('**D9-f（'), '§7.7 states the rule for one gate but never as a rule');

  // Reverse control — the two readings, modelled. `queued` is what a row event holds; `final` is
  // what the transaction is about to commit. v1.9 compared one side's queued tuple against the
  // other side's final row, which is why a legal final state could be refused.
  type Snapshot = { generation: number; hasClaim: boolean };
  const legalPair = (a: Snapshot, b: Snapshot): boolean =>
    (a.generation === 0 && !b.hasClaim) || (a.generation === 1 && b.hasClaim);
  const queued: Snapshot = { generation: 0, hasClaim: false };   // the heartbeat statement's tuple
  const final: Snapshot = { generation: 1, hasClaim: true };     // what COMMIT is about to store
  assert.equal(legalPair(queued, final), false, 'reverse control: v1.9 compares a queued tuple with a final row');
  assert.equal(legalPair(final, final), true, 'v1.10 compares the final row with the final row');
});

test('PC-CX-52: EC2-b\'s result half is a closed key-and-type table, enforced at the commit point', () => {
  // The two clauses the review read against each other are unchanged.
  assert.match(EC6_C, /非空的具体值/, 'EC6-c no longer requires a nonempty conclusion');
  assert.match(EC2_B, /恰好三部分，封闭/, 'EC2-b no longer claims a closed result half');

  // Closed: the claim now has an executable form, and the empty string is named as its fourth
  // look-alike (missing key, JSON null, the deferral sentinel — and now '').
  assert.match(EC2_B2, /空字符串/, 'EC2-b2 does not close the empty-string hole');
  assert.match(EC6_C, /空字符串/, 'EC6-c does not name the empty string as a non-conclusion');
  assert.doesNotMatch(D17_SQL, /IF ctx->>'model' IS NULL OR ctx->>'effort' IS NULL THEN/,
    'D17 still tests only for SQL NULL conclusions');
  assert.match(D17_SQL, /CREATE OR REPLACE FUNCTION coordinator_execution_result_shape/,
    'the closed result shape has no object');
  assert.match(D17_SQL, /EXECUTION_RESULT_SHAPE/, 'an incomplete result half has no typed refusal');
  for (const required of ['requiredCapabilities', 'permissionMode', 'resolution', 'snapshotFrozenAt',
    'agentId', 'workspaceId', 'assignedRunnerId', 'provider', 'providerBuiltin', 'model', 'effort']) {
    assert.ok(D17_SQL.includes(`'${required}',`), `the shape table does not require EC2-b.${required}`);
  }
  // …and all three readers call the one definition, so they cannot grow two standards (D16-f).
  assert.match(D15_SQL, /coordinator_execution_result_shape\(NEW\.id, ctx\)/, 'D15 does not prove the shape at insert');
  assert.equal((D16_SQL.match(/coordinator_execution_result_shape\(/g) ?? []).length, 2,
    'D16 must prove the shape from both sides');

  // Reverse control — v1.9's two predicates, modelled verbatim against the review's two contexts.
  const v19Accepts = (ctx: Record<string, unknown>): boolean =>
    ctx.model !== undefined && ctx.model !== null && ctx.effort !== undefined && ctx.effort !== null;
  const SHAPE = ['agentId', 'workspaceId', 'assignedRunnerId', 'provider', 'providerBuiltin',
    'requiredCapabilities', 'permissionMode', 'snapshotFrozenAt', 'resolution', 'model', 'effort'];
  const v110Accepts = (ctx: Record<string, unknown>): boolean =>
    Object.keys(ctx).sort().join() === [...SHAPE].sort().join()
    && !SHAPE.some((k) => ctx[k] === '' || ctx[k] === null || ctx[k] === undefined);
  const complete = Object.fromEntries(SHAPE.map((k) => [k, k === 'providerBuiltin' ? true : `${k}-value`]));
  const empty = { ...complete, model: '', effort: '' };
  const incomplete = { ...complete } as Record<string, unknown>;
  for (const k of ['requiredCapabilities', 'permissionMode', 'resolution', 'snapshotFrozenAt']) delete incomplete[k];
  assert.equal(v19Accepts(empty), true, 'reverse control: v1.9 mistakes an empty string for a conclusion');
  assert.equal(v19Accepts(incomplete), true, 'reverse control: v1.9 never counts the keys of the result half');
  assert.equal(v110Accepts(empty), false, 'v1.10 must refuse an empty conclusion');
  assert.equal(v110Accepts(incomplete), false, 'v1.10 must refuse an incomplete result half');
  assert.equal(v110Accepts(complete), true, 'and it must still admit a complete one');
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

/** v1.9's action-side D16, verbatim: it early-exits on the column D11 leaves writable. */
const D16_ACTION_V19 = `
  CREATE OR REPLACE FUNCTION project_action_pin_ledger_check() RETURNS trigger AS $fn$
  DECLARE generation bigint; pinned_model text; pinned_effort text; pin jsonb;
  BEGIN
    IF NEW.type <> 'DISPATCH_TASK' OR NEW.result_session_id IS NULL THEN RETURN NULL; END IF;
    SELECT s.execution_pin_generation, s.model, s.effort INTO generation, pinned_model, pinned_effort
      FROM session s WHERE s.id = NEW.result_session_id AND s.dispatch_origin = 'COORDINATOR';
    IF generation IS NULL THEN RETURN NULL; END IF;
    pin := coordinator_pin_ledger_fold(NEW.id, NEW.execution_context, NEW.detail -> 'claimResolution',
             COALESCE(NEW.detail -> 'retiredPins', '[]'::jsonb), generation);
    IF generation > 0 AND (pinned_model IS DISTINCT FROM pin->>'model'
                           OR pinned_effort IS DISTINCT FROM pin->>'effort') THEN
      RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: action % records %/% while session % runs %/%',
        NEW.id, COALESCE(pin->>'model','NULL'), COALESCE(pin->>'effort','NULL'), NEW.result_session_id,
        COALESCE(pinned_model,'NULL'), COALESCE(pinned_effort,'NULL');
    END IF;
    RETURN NULL;
  END;
  $fn$ LANGUAGE plpgsql;
`;

/** v1.9's Session-side D16, verbatim: it folds against the tuple its statement queued with. */
const D16_SESSION_V19 = `
  CREATE OR REPLACE FUNCTION session_execution_result_check() RETURNS trigger AS $fn$
  DECLARE ctx jsonb; action_status text; ledger jsonb; claim jsonb; pin jsonb;
  BEGIN
    IF NEW.task_id IS NULL OR NEW.dispatch_origin <> 'COORDINATOR' THEN RETURN NULL; END IF;
    SELECT a.execution_context, a.status,
           COALESCE(a.detail -> 'retiredPins', '[]'::jsonb), a.detail -> 'claimResolution'
      INTO ctx, action_status, ledger, claim
      FROM project_action a WHERE a.id = NEW.project_action_id;
    IF ctx IS NULL OR action_status <> 'APPLIED' THEN
      RAISE EXCEPTION 'EXECUTION_RESULT_MISMATCH: session % is not the frozen result of action %',
        NEW.id, NEW.project_action_id;
    END IF;
    pin := coordinator_pin_ledger_fold(NEW.id, ctx, claim, ledger, NEW.execution_pin_generation);
    IF NEW.execution_pin_generation = 0 THEN
      IF NEW.model IS NOT NULL OR NEW.effort IS NOT NULL THEN
        RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: session % is at generation 0 but already carries a pin', NEW.id;
      END IF;
    ELSIF NEW.model IS DISTINCT FROM pin->>'model' OR NEW.effort IS DISTINCT FROM pin->>'effort' THEN
      RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: session % runs %/% while action % records %/%',
        NEW.id, COALESCE(NEW.model,'NULL'), COALESCE(NEW.effort,'NULL'), NEW.project_action_id,
        COALESCE(pin->>'model','NULL'), COALESCE(pin->>'effort','NULL');
    END IF;
    RETURN NULL;
  END;
  $fn$ LANGUAGE plpgsql;
`;

/** v1.9's D17 body, verbatim: it tests the two conclusions for SQL NULL and counts no keys. */
const D17_V19 = `
  CREATE OR REPLACE FUNCTION project_action_execution_digest_check() RETURNS trigger AS $fn$
  DECLARE ctx jsonb; auth jsonb;
          components constant text[] := ARRAY['resolvedAgentId','projectMemberId','taskId','taskAssigneeAgentId',
            'providerSlug','model','workspaceId','runnerId','coordinatorWorkspaceId'];
  BEGIN
    IF NEW.type <> 'DISPATCH_TASK' OR NEW.execution_context IS NULL THEN RETURN NULL; END IF;
    ctx  := NEW.execution_context;
    auth := ctx -> 'authorization';
    IF auth IS NULL OR jsonb_typeof(auth) <> 'object'
       OR (SELECT array_agg(t.k ORDER BY t.k COLLATE "C") FROM jsonb_object_keys(auth) AS t(k))
          IS DISTINCT FROM ARRAY(SELECT c FROM unnest(components) c ORDER BY c COLLATE "C") THEN
      RAISE EXCEPTION 'EXECUTION_DIGEST_MISMATCH: action % does not carry nine authorization components', NEW.id;
    END IF;
    IF ctx->>'model' IS NULL OR ctx->>'effort' IS NULL THEN
      RAISE EXCEPTION 'EXECUTION_DIGEST_MISMATCH: action % freezes no model/effort conclusion', NEW.id;
    END IF;
    IF NEW.execution_context_digest IS DISTINCT FROM coordinator_execution_digest(auth)
       OR NEW.execution_result_digest IS DISTINCT FROM coordinator_execution_digest(ctx - 'authorization') THEN
      RAISE EXCEPTION 'EXECUTION_DIGEST_MISMATCH: action % stores a digest that is not a recomputation', NEW.id;
    END IF;
    RETURN NULL;
  END;
  $fn$ LANGUAGE plpgsql;
`;

/** v1.9's D15, verbatim: it compares nine columns without first proving the half is complete. */
const D15_SQL_V19 = D15_SQL.replace(/\n\s*PERFORM coordinator_execution_result_shape\(NEW\.id, ctx\);/, '');

type Version = 'v110' | 'v19';

async function install(c: Client, version: Version = 'v110'): Promise<void> {
  await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}; SET search_path TO ${SCHEMA}; ${TABLES}`);
  // These are the normative SQL blocks, not copies maintained by this test.
  await c.query(D17_SQL); // digest helpers are also used to construct honest fixture rows
  await c.query(D11_SQL);
  await c.query(version === 'v110' ? D15_SQL : D15_SQL_V19);
  await c.query(D16_SQL);
  if (version === 'v110') {
    await c.query(D18_SQL);
  } else {
    // Reverse control: rebuild v1.9's three objects over v1.10's, and drop D18 and the column list.
    await c.query(`DROP TRIGGER IF EXISTS project_action_result_ledger_mutator ON project_action`);
    await c.query(D16_ACTION_V19);
    await c.query(D16_SESSION_V19);
    await c.query(D17_V19);
    await c.query(`DROP TRIGGER project_action_pin_ledger_check ON project_action`);
    await c.query(`CREATE CONSTRAINT TRIGGER project_action_pin_ledger_check
                     AFTER INSERT OR UPDATE OF detail, result_session_id ON project_action
                     DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION project_action_pin_ledger_check()`);
  }
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

function context(options: { model?: string; effort?: string; omit?: string[]; extra?: { [k: string]: Json } } = {}):
{ [key: string]: Json } {
  const model = options.model ?? 'model-v1';
  const ctx: { [key: string]: Json } = {
    agentId: 'a1', workspaceId: 'w1', assignedRunnerId: 'r1', provider: 'claude', providerBuiltin: true,
    requiredCapabilities: ['linux'], permissionMode: 'read-only',
    resolution: { who: { source: 'task' }, with: { source: 'agent' }, where: { source: 'workspace' } },
    snapshotFrozenAt: FROZEN_AT,
    model, effort: options.effort ?? 'high',
    authorization: {
      resolvedAgentId: 'a1', projectMemberId: 'm1', taskId: 't1', taskAssigneeAgentId: 'a1',
      providerSlug: 'claude', model, workspaceId: 'w1', runnerId: 'r1', coordinatorWorkspaceId: null,
    },
  };
  for (const key of options.omit ?? []) delete ctx[key];
  return { ...ctx, ...(options.extra ?? {}) };
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

const CLAIM_SQL = `UPDATE project_action SET detail = detail || jsonb_build_object('claimResolution',${sqlJson(claim())}) WHERE id='act1'`;
const PIN_SQL = `UPDATE session SET model='model-v1',effort='high',execution_pin_generation=1 WHERE id='s1'`;

test('PC-CX-50 on real Postgres: the review\'s two transactions are both refused',
  { skip: URL ? false : 'set an isolated COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    const one = async (sql: string): Promise<string> => txn(c, async () => { await c.query(sql); });
    const observed = async () => (await c.query<{
      action_result: string | null; session_action: string; generation: string; claim: string | null;
    }>(`
      SELECT a.result_session_id AS action_result, s.project_action_id AS session_action,
             s.execution_pin_generation::text AS generation, (a.detail->'claimResolution')::text AS claim
        FROM session s JOIN project_action a ON a.id=s.project_action_id WHERE s.id='s1'`)).rows[0];
    try {
      await install(c);
      assert.equal(await dispatch(c), '');
      assert.equal(await txn(c, async () => {
        await c.query(CLAIM_SQL);
        await c.query(PIN_SQL);
      }), '', 'the honest first claim must still commit');

      // The review's two transactions, verbatim. Both are now refused on the statement itself.
      assert.match(await one(`UPDATE project_action SET result_session_id=NULL WHERE id='act1'`),
        /ACTION_RESULT_LINK_FROZEN/, 'a published result link must not be clearable');
      assert.match(await one(`UPDATE project_action SET result_session_id='s2' WHERE id='act1'`),
        /ACTION_RESULT_LINK_FROZEN/, 'a published result link must not be repointable');
      assert.match(await one(`UPDATE project_action SET detail='{"claimResolution":{}}'::jsonb WHERE id='act1'`),
        /EXECUTION_PIN_LEDGER/, 'a recorded claimResolution must not be rewritten to an empty object');
      assert.deepEqual({ ...await observed(), claim: undefined },
        { action_result: 's1', session_action: 'act1', generation: '1', claim: undefined },
        'the committed link is still symmetric and the ledger still says what it said');

      // The ledger half: append-only, prefix verbatim.
      assert.equal(await txn(c, async () => {
        await c.query(`UPDATE session SET model='model-v2',execution_pin_generation=2 WHERE id='s1'`);
        await c.query(`UPDATE project_action SET detail = jsonb_set(detail,'{retiredPins}',
          jsonb_build_array(${sqlJson(retired())})) WHERE id='act1'`);
      }), '', 'a legal retiredPin must still commit');
      for (const [label, sql] of [
        ['truncated', `UPDATE project_action SET detail = jsonb_set(detail,'{retiredPins}','[]') WHERE id='act1'`],
        ['rewritten in place', `UPDATE project_action SET detail = jsonb_set(detail,'{retiredPins,0,at}','"${FROZEN_AT}"') WHERE id='act1'`],
        ['replaced by an empty record', `UPDATE project_action SET detail = jsonb_set(detail,'{retiredPins}','[{}]') WHERE id='act1'`],
      ] as [string, string][]) {
        assert.match(await one(sql), /EXECUTION_PIN_LEDGER/, `a ledger ${label} must be refused`);
      }
      // …and a display write, which the ledger does not own, still commits.
      assert.equal(await one(`UPDATE project_action SET detail = detail || '{"display":{"note":"ready"}}'::jsonb WHERE id='act1'`),
        '', 'a display write must still commit');

      // Reverse control — v1.9's objects, rebuilt verbatim. The review's exact state comes back.
      await install(c, 'v19');
      assert.equal(await dispatch(c), '');
      assert.equal(await txn(c, async () => {
        await c.query(CLAIM_SQL);
        await c.query(PIN_SQL);
      }), '');
      assert.equal(await one(`UPDATE project_action SET result_session_id=NULL WHERE id='act1'`), '',
        'reverse control: v1.9 permits the link to be cleared and D16 returns early');
      assert.equal(await one(`UPDATE project_action SET detail='{"claimResolution":{}}'::jsonb WHERE id='act1'`), '',
        'reverse control: after the detach the other D11-writable predicate is unchecked');
      assert.deepEqual(await observed(), { action_result: null, session_action: 'act1', generation: '1', claim: '{}' },
        'v1.9 commits the state that violates the advertised bidirectional action/session/pin relation');
      console.log(`PC-CX-50 v1.9 witness=${JSON.stringify(await observed())}`);
    } finally {
      await c.end();
    }
  });

test('PC-CX-51 on real Postgres: a heartbeat or display write before the claim still commits',
  { skip: URL ? false : 'set an isolated COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    const state = async () => (await c.query<{ status: string; generation: string; detail: string }>(`
      SELECT s.status,s.execution_pin_generation::text AS generation,a.detail::text AS detail
        FROM session s JOIN project_action a ON a.id=s.project_action_id WHERE s.id='s1'`)).rows[0];
    try {
      await install(c);
      assert.equal(await dispatch(c), '');
      assert.equal(await txn(c, async () => {
        await c.query(`UPDATE session SET status='RUNNING' WHERE id='s1'`);
        await c.query(CLAIM_SQL);
        await c.query(PIN_SQL);
      }), '', 'a heartbeat before the first claim must not stop the transaction from committing');
      assert.equal((await state()).generation, '1');

      assert.equal(await dispatch(c), '');
      assert.equal(await txn(c, async () => {
        await c.query(`UPDATE project_action SET detail='{"display":{"note":"ready"}}'::jsonb WHERE id='act1'`);
        await c.query(CLAIM_SQL);
        await c.query(PIN_SQL);
      }), '', 'a display write before the first claim must not stop the transaction from committing');
      assert.equal((await state()).generation, '1');

      // An illegal final state is still refused under the same orders, and it rolls back whole.
      assert.equal(await dispatch(c), '');
      assert.match(await txn(c, async () => {
        await c.query(`UPDATE session SET status='RUNNING' WHERE id='s1'`);
        await c.query(CLAIM_SQL);
        await c.query(`UPDATE session SET model='model-v1',effort='high',execution_pin_generation=2 WHERE id='s1'`);
      }), /EXECUTION_PIN_GENERATION|EXECUTION_PIN_LEDGER/, 'generation 2 with no retiredPin must still be refused');
      assert.deepEqual(await state(), { status: 'PENDING', generation: '0', detail: '{}' },
        'and the refused transaction rolled back whole');

      // Reverse control — v1.9's two functions, rebuilt verbatim: both orders fail deterministically.
      await install(c, 'v19');
      assert.equal(await dispatch(c), '');
      const heartbeatFirst = await txn(c, async () => {
        await c.query(`UPDATE session SET status='RUNNING' WHERE id='s1'`);
        await c.query(CLAIM_SQL);
        await c.query(PIN_SQL);
      });
      assert.match(heartbeatFirst, /EXECUTION_PIN_LEDGER/,
        'reverse control: the early Session event retains generation 0 while reading the final claim ledger');
      assert.equal(await dispatch(c), '');
      const displayFirst = await txn(c, async () => {
        await c.query(`UPDATE project_action SET detail='{"display":{"note":"ready"}}'::jsonb WHERE id='act1'`);
        await c.query(CLAIM_SQL);
        await c.query(PIN_SQL);
      });
      assert.match(displayFirst, /EXECUTION_PIN_LEDGER/,
        'reverse control: the early action event retains a pre-claim detail while reading the final generation');
      console.log(`PC-CX-51 v1.9 heartbeat=${JSON.stringify(heartbeatFirst)} display=${JSON.stringify(displayFirst)}`);

      // The proposed final state was internally valid all along — that is what made it a defect.
      const folded = (await c.query<{ pin: { model: string; effort: string } }>(`
        SELECT coordinator_pin_ledger_fold('final-state', ${sqlJson(context())}, ${sqlJson(claim())},
          '[]'::jsonb, 1) AS pin`)).rows[0].pin;
      assert.deepEqual(folded, { model: 'model-v1', effort: 'high' });
    } finally {
      await c.end();
    }
  });

test('PC-CX-52 on real Postgres: an empty or incomplete result half is refused at the commit point',
  { skip: URL ? false : 'set an isolated COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    const missing = ['requiredCapabilities', 'permissionMode', 'resolution', 'snapshotFrozenAt'];
    try {
      await install(c);
      assert.equal(await dispatch(c), '', 'the complete eleven-key result half must commit');

      assert.match(await dispatch(c, context({ model: '', effort: '' })), /EXECUTION_RESULT_SHAPE/,
        'an empty string is not a concrete conclusion');
      assert.match(await dispatch(c, context({ omit: missing })), /EXECUTION_RESULT_SHAPE/,
        'an incomplete result half must be refused even when both digests are correct');
      for (const key of missing) {
        assert.match(await dispatch(c, context({ omit: [key] })), /EXECUTION_RESULT_SHAPE/,
          `a result half missing ${key} must be refused`);
      }
      assert.match(await dispatch(c, context({ extra: { surprise: 1 } })), /EXECUTION_RESULT_SHAPE/,
        'a key EC2-b does not have must be refused');
      assert.match(await dispatch(c, context({ extra: { providerBuiltin: 'true' } })), /EXECUTION_RESULT_SHAPE/,
        'a providerBuiltin that is a string must be refused');
      assert.match(await dispatch(c, context({ extra: { resolution: { v: 1 } } })), /EXECUTION_RESULT_SHAPE/,
        'a resolution that is not PAC 7.5 who/with/where must be refused');
      // Each refused dispatch rolls back whole, so the last committed one is still what is stored.
      const committed = (await c.query<{ model: string | null }>(
        `SELECT execution_context->>'model' AS model FROM project_action WHERE id='act1'`)).rows[0]?.model ?? null;
      assert.equal(committed, 'model-v1', 'every refused dispatch rolled back whole');

      // Reverse control — v1.9's D17 and D15: both of the review's contexts commit, and the second
      // one carries two digests that are, honestly, correct.
      await install(c, 'v19');
      assert.equal(await dispatch(c, context({ model: '', effort: '' })), '',
        'reverse control: v1.9 mistakes empty strings for concrete conclusions');
      const empty = (await c.query<{ model: string; effort: string }>(
        `SELECT model,effort FROM session WHERE id='s1'`)).rows[0];
      assert.deepEqual(empty, { model: null, effort: null }, 'the placeholder starts unpinned');
      assert.equal(await txn(c, async () => {
        await c.query(`UPDATE project_action SET detail=jsonb_build_object('claimResolution',${sqlJson(claim('', ''))}) WHERE id='act1'`);
        await c.query(`UPDATE session SET model='',effort='',execution_pin_generation=1 WHERE id='s1'`);
      }), '', 'reverse control: v1.9 accepts empty concrete frozen/value pins');

      assert.equal(await dispatch(c, context({ omit: missing })), '',
        'reverse control: v1.9 does not enforce EC2-b\'s closed top-level result shape');
      const shape = (await c.query<{ missing: string[]; capabilities: string[] | null; permission: string | null }>(`
        SELECT ARRAY(SELECT k FROM unnest(ARRAY['requiredCapabilities','permissionMode','resolution','snapshotFrozenAt']) k
                     WHERE NOT (a.execution_context ? k)) AS missing,
               s.required_capabilities AS capabilities, s.permission_mode AS permission
          FROM project_action a JOIN session s ON s.project_action_id=a.id WHERE a.id='act1'`)).rows[0];
      assert.deepEqual(shape, { missing, capabilities: null, permission: null },
        'a digest can be correct for an incomplete result half while the Session carries SQL nulls');
      console.log(`PC-CX-52 v1.9 incomplete=${JSON.stringify(shape)}`);
    } finally {
      await c.end();
    }
  });

test('v1.9 independent-review inventory is explicit, flipped, and its PG path is safety-gated', () => {
  assert.deepEqual(['PC-CX-50', 'PC-CX-51', 'PC-CX-52'], ['PC-CX-50', 'PC-CX-51', 'PC-CX-52']);
  const self = readFileSync(path.join(REPO, 'src/apiserver/src/projects/coordinator-v19-adversarial.spec.ts'), 'utf8');
  assert.match(self, /assertCoordinatorPgUrlIsIsolated\(URL\)/);
  assert.match(self, /await verifyCoordinatorPgIdentity\(client\)/);
  assert.ok(self.indexOf('await verifyCoordinatorPgIdentity(client)') < self.indexOf('await c.query(`DROP SCHEMA'),
    'identity verification must textually precede the first destructive statement');
  // Every finding keeps a reverse control, or the fix stops being falsifiable (§28.4).
  for (const finding of ['PC-CX-50', 'PC-CX-51', 'PC-CX-52']) {
    assert.ok(self.includes(`test('${finding}`) || self.includes(`test("${finding}`),
      `${finding} lost its no-database test`);
  }
  assert.equal((self.match(/reverse control/g) ?? []).length >= 6, true,
    'the v1.9 shapes must stay as reverse controls in both halves of every finding');
  // §28 must answer exactly what this review raised.
  const closure = CONTRACT.slice(CONTRACT.indexOf('## 28. '));
  for (const finding of ['PC-CX-50', 'PC-CX-51', 'PC-CX-52']) {
    assert.ok(closure.includes(finding), `§28 does not answer ${finding}`);
  }
});
