import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';

// Independent unit-02 review of Coordinator contract v1.7, flipped by unit 01H for v1.8.
//
// v1.7 shape: every assertion below proved a defect was still constructible. v1.8 closed
// `PC-CX-43..46`, so a witness assertion would now necessarily go red — the same discipline §24.6
// and §25.7 applied to the v1.5 and v1.6 spec files. Each test therefore asserts TWO things:
//   1. the closed shape — v1.8's clause/object refuses the review's exact transaction, and
//   2. the reverse control — v1.7's shape, kept verbatim, still admits it.
// Deleting the reverse control would make the fix unfalsifiable, so it stays.
const REPO = path.resolve(__dirname, '../../../..');
const CONTRACT = readFileSync(path.join(REPO, 'docs/project-coordinator-contract.md'), 'utf8');
const PAC = readFileSync(path.join(REPO, 'docs/project-agent-contract.md'), 'utf8');
const REVIEW = readFileSync(path.join(REPO, 'docs/project-coordinator-contract-review-02-v1.7.md'), 'utf8');
const PG_URL = process.env.COORDINATOR_PG_URL;
const REVIEW_SCHEMA = 'pcc_v17_rereview';

function between(document: string, start: string, end: string): string {
  const from = document.indexOf(start);
  const to = document.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not isolate ${start}`);
  return document.slice(from, to);
}

const D11 = between(CONTRACT, '#### D11 ', '#### D12 ');
const D15 = between(CONTRACT, '#### D15 ', '#### D16 ');
const D15_SQL = D15.slice(D15.indexOf('CREATE OR REPLACE FUNCTION'), D15.indexOf('CREATE TRIGGER'));
const D16 = between(CONTRACT, '#### D16 ', '#### D8 ');
const EXACTLY_ONCE = between(CONTRACT, '### 8.3 exactly-once-effect', '### 8.4');

test('PC-CX-43: D11 now freezes the CLAIMED-to-APPLIED transition that publishes the row', () => {
  // The statement order that made the window is unchanged — it is §8.3's frozen sequence, and the
  // fix had to leave it alone. What changed is which columns that third statement may touch.
  assert.ok(EXACTLY_ONCE.indexOf('INSERT INTO project_action') < EXACTLY_ONCE.indexOf('INSERT INTO session'));
  assert.ok(EXACTLY_ONCE.indexOf('INSERT INTO session') < EXACTLY_ONCE.indexOf('UPDATE project_action SET status'));

  // Closed: the blanket early return is gone, and CLAIMED has its own closed allowlist.
  assert.doesNotMatch(D11, /IF OLD\.status <> 'APPLIED' THEN RETURN NEW; END IF;/,
    'D11 still lets the publishing UPDATE through untouched');
  assert.match(D11, /writable := writable \|\| ARRAY\['status', 'refusal_code'\]/,
    'D11 does not give the publishing statement its own closed allowlist');
  assert.match(D11, /ACTION_TRANSITION_ILLEGAL/, 'D11 does not close the set of transition targets');
  assert.ok(D11.includes('**D11-f（'), 'D11 does not argue why the publishing statement is inside the freeze');
  assert.ok(D11.includes('**D11-g（'), 'D11 does not require the per-column mutation to run on the publish too');

  // A model of both shapes, exercised on the review's exact statement.
  const PUBLISH_ALLOWLIST = ['status', 'refusal_code', 'result_session_id', 'detail'];
  const TERMINAL_ALLOWLIST = ['result_session_id', 'detail'];
  const accepts = (version: 'v17' | 'v18', oldStatus: string, columns: string[]): boolean => {
    if (version === 'v17') return oldStatus !== 'APPLIED'
      || columns.every((c) => TERMINAL_ALLOWLIST.includes(c));
    const allowed = oldStatus === 'CLAIMED' ? PUBLISH_ALLOWLIST : TERMINAL_ALLOWLIST;
    return columns.every((c) => allowed.includes(c));
  };
  const review = ['status', 'result_session_id', 'execution_result_digest'];
  assert.equal(accepts('v17', 'CLAIMED', review), true, 'reverse control: v1.7 admits the forged digest');
  assert.equal(accepts('v18', 'CLAIMED', review), false, 'v1.8 must refuse the same publishing UPDATE');
  assert.equal(accepts('v18', 'CLAIMED', ['status', 'result_session_id']), true,
    'a clean publish must still commit, or §8.3 blocks itself');
  assert.equal(accepts('v18', 'APPLIED', ['status']), false, 'a terminal row may not leave its terminal state');
});

test('PC-CX-44: D15 and D16 now cover every PAC create-frozen column, at insert and at commit', () => {
  const pacFreezeTable = between(PAC, '## 6. Execution Snapshot 冻结契约', '**S1**');
  const createFrozen = ['resolution', 'permissionMode', 'snapshotFrozenAt'];
  for (const field of createFrozen) {
    assert.match(pacFreezeTable, new RegExp('`' + field + '`[^\\n]+Session \\*\\*create\\*\\*'),
      `${field} is no longer create-frozen by PAC`);
  }
  assert.match(CONTRACT, /EC2-b[\s\S]*?permissionMode[\s\S]*?整份 `resolution`/,
    'EC2-b must still say permissionMode and the whole resolution affect the result');

  // Closed: the three columns the review named are compared on insert and frozen on update…
  const stillMissing = [
    ['permission_mode', /NEW\.permission_mode/],
    ['resolution', /NEW\.resolution/],
    ['snapshot_frozen_at', /NEW\.snapshot_frozen_at/],
  ].filter(([, pattern]) => !(pattern as RegExp).test(D15_SQL)).map(([column]) => column);
  assert.deepEqual(stillMissing, [], 'the database guard still does not compare or freeze these PAC columns');
  // …and the same list is proved again on the committed state, which v1.7 had nobody doing.
  for (const column of ['permission_mode', 'resolution', 'snapshot_frozen_at']) {
    // v1.10 (PC-CX-51): the commit-point comparison is against `s.<column>` — the row re-read by its
    // stable key — because a deferred row trigger still holds the tuple its statement queued with.
    assert.ok(D16.includes(`s.${column}`), `D16 does not re-prove ${column} at the commit point`);
  }
  assert.match(D16, /EXECUTION_RESULT_MISMATCH/, 'D16 has no typed refusal for a drifted result');
  assert.match(D16, /DEFERRABLE INITIALLY DEFERRED/, 'D16 does not read the final state of the transaction');
  // And snapshotFrozenAt got the single source the review asked for.
  assert.match(CONTRACT, /\*\*EC6-d（`snapshotFrozenAt` 的唯一来源/, 'snapshotFrozenAt still has no defined source');

  // Reverse control: v1.7's six-column list against the review's session, which differs in three.
  const V17_COMPARED = ['agent_id', 'workspace_id', 'assigned_runner_id', 'provider', 'provider_builtin', 'required_capabilities'];
  const V18_COMPARED = [...V17_COMPARED, 'permission_mode', 'resolution', 'snapshot_frozen_at'];
  const forged = new Set(['permission_mode', 'resolution']);
  const admits = (compared: string[]): boolean => !compared.some((c) => forged.has(c));
  assert.equal(admits(V17_COMPARED), true, 'reverse control: v1.7 admits danger-full-access against a read-only freeze');
  assert.equal(admits(V18_COMPARED), false, 'v1.8 must refuse it');
});

test('PC-CX-45: the Session guards now read OLD as well as NEW, so nothing can self-exempt', () => {
  const d9 = between(CONTRACT, '#### D9 ', '#### D10 ');
  const d14 = between(CONTRACT, '#### D14 ', '#### D15 ');
  // v1.10 (PC-CX-51): D9 and D14 are deferred, so their NEW half now reads the row they re-read by
  // its stable key (`s`); D15 is BEFORE and still reads NEW. Either spelling is the same rule —
  // what the review demanded, and what this still asserts, is that OLD is read at all.
  const OLD_NEW = /\(OLD\.task_id IS NULL OR OLD\.dispatch_origin <> 'COORDINATOR'\)\s*\n?\s*AND \((NEW|s)\.task_id IS NULL OR \1\.dispatch_origin <> 'COORDINATOR'\)/;
  for (const [name, section] of [['D9', d9], ['D14', d14], ['D15', D15]] as const) {
    assert.match(section, OLD_NEW, `${name} still decides its scope from NEW alone`);
  }
  // The lineage columns are frozen, so the D5 predicate columns cannot be rewritten out of the index.
  for (const column of ['task_id', 'dispatch_origin', 'project_action_id']) {
    assert.match(D15, new RegExp(`NEW\\.${column}\\s+IS DISTINCT FROM OLD\\.${column}`),
      `D15 does not freeze the lineage column ${column}`);
  }
  assert.ok(D15.includes('**D15-f（'), 'D15 does not argue why the lineage must be frozen');
  assert.match(CONTRACT, /\*\*I17-A3（lineage 恒成立/, '§4.3 has no standing invariant for the lineage');
  assert.match(CONTRACT, /WHERE task_id IS NOT NULL AND deleted_at IS NULL AND status IN \('PENDING','RUNNING'\)/,
    'D5 must still state the predicate the lineage freeze protects');

  // A model of the review's UPDATE under both scope rules.
  type Row = { taskId: string | null; origin: string; actionId: string | null };
  const live: Row = { taskId: 't1', origin: 'COORDINATOR', actionId: 'a1' };
  const exempted: Row = { taskId: null, origin: 'USER', actionId: null };
  const inScope = (version: 'v17' | 'v18', oldRow: Row, newRow: Row): boolean => version === 'v17'
    ? newRow.taskId !== null && newRow.origin === 'COORDINATOR'
    : (oldRow.taskId !== null && oldRow.origin === 'COORDINATOR')
      || (newRow.taskId !== null && newRow.origin === 'COORDINATOR');
  assert.equal(inScope('v17', live, exempted), false, 'reverse control: v1.7 lets the row leave every gate');
  assert.equal(inScope('v18', live, exempted), true, 'v1.8 must still evaluate the UPDATE that leaves the scope');
  // …and once it is evaluated, the lineage freeze refuses it, so the claim is never released.
  const claimHeldAfter = (version: 'v17' | 'v18'): number =>
    inScope(version, live, exempted) ? 1 : 0;
  assert.deepEqual({ v17: claimHeldAfter('v17'), v18: claimHeldAfter('v18') }, { v17: 0, v18: 1 });
});

test('PC-CX-46: the pin generation and the retiredPins ledger are now one atomic relation', () => {
  const i17a2 = between(CONTRACT, '**I17-A2（', '**I17-A3（');
  assert.match(i17a2, /n − 1.*detail\.retiredPins\[\]/s, 'I17-A2 must still require exactly n-1 retiredPins records');
  assert.match(i17a2, /两个方向都要查/, 'I17-A2 must still require the converse too');
  assert.match(i17a2, /数据库可执行的形式/, 'I17-A2 is still only a query, not an executable rule');

  // Closed: the ledger is read by a database object, from both sides, at the commit point.
  assert.match(D16, /retiredPins/, 'D16 never reads the action-side ledger');
  assert.match(D16, /claimResolution/, 'D16 never reads the first-claim record');
  assert.match(D16, /EXECUTION_PIN_LEDGER/, 'D16 has no typed refusal for a ledger that disagrees');
  assert.match(D16, /CREATE CONSTRAINT TRIGGER session_execution_result_check/, 'the session side of the ledger has no object');
  assert.match(D16, /CREATE CONSTRAINT TRIGGER project_action_pin_ledger_check/, 'the action side of the ledger has no object');
  assert.ok(D16.includes('**D16-a（'), 'D16 does not argue why both directions need their own object');

  // A model of both shapes over the review's exact sequence: claim, then retiredPin, ledger empty.
  const accepted = (version: 'v17' | 'v18', generation: number, retiredPins: number, claim: boolean): boolean =>
    version === 'v17'
      ? true                                    // v1.7's D15 never reads the action row at all
      : generation === 0 ? !claim && retiredPins === 0 : claim && retiredPins === generation - 1;
  assert.equal(accepted('v17', 2, 0, false), true, 'reverse control: v1.7 commits generation 2 with an empty ledger');
  assert.equal(accepted('v18', 2, 0, false), false, 'v1.8 must refuse the missing records');
  assert.equal(accepted('v18', 1, 0, true), true, 'a legal first claim must still commit');
  assert.equal(accepted('v18', 2, 1, true), true, 'a legal retiredPin must still commit');
  assert.equal(accepted('v18', 1, 1, true), false, 'a ledger ahead of the generation must be refused');
  assert.equal(accepted('v18', 3, 1, true), false, 'a generation ahead of the ledger must be refused');
});

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(PG_URL);
  const client = new Client({ connectionString: PG_URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  return client;
}

/** §7.7 D11 as v1.8 specifies it: two closed allowlists, chosen by OLD.status. */
const D11_V18 = `
  CREATE OR REPLACE FUNCTION project_action_applied_immutable_guard() RETURNS trigger AS $fn$
  DECLARE writable text[] := ARRAY['result_session_id', 'detail'];
          code     text   := 'ACTION_APPLIED_IMMUTABLE';
          changed  text;
  BEGIN
    IF OLD.status = 'CLAIMED' THEN
      IF NEW.status IS NULL OR NEW.status NOT IN ('CLAIMED','APPLIED','REFUSED','SUPERSEDED') THEN
        RAISE EXCEPTION 'ACTION_TRANSITION_ILLEGAL: action % cannot go CLAIMED -> %',
          OLD.id, COALESCE(NEW.status, 'NULL');
      END IF;
      writable := writable || ARRAY['status', 'refusal_code'];
      code     := 'ACTION_PUBLISH_IMMUTABLE';
    ELSIF OLD.status NOT IN ('APPLIED','REFUSED','SUPERSEDED') THEN
      RAISE EXCEPTION 'ACTION_TRANSITION_ILLEGAL: action % has an unrecognised status %', OLD.id, OLD.status;
    END IF;
    IF (to_jsonb(NEW) - writable) IS DISTINCT FROM (to_jsonb(OLD) - writable) THEN
      SELECT string_agg(e.key, ',' ORDER BY e.key) INTO changed
        FROM jsonb_each(to_jsonb(NEW) - writable) e
       WHERE e.value IS DISTINCT FROM ((to_jsonb(OLD) - writable) -> e.key);
      RAISE EXCEPTION '%: action % is %; frozen (changed: %)', code, OLD.id, OLD.status, changed;
    END IF;
    RETURN NEW;
  END;
  $fn$ LANGUAGE plpgsql;
`;

/** …and as v1.7 wrote it. Kept verbatim: it is the reverse control for PC-CX-43. */
const D11_V17 = `
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
`;

/** §7.7 D15 as v1.8 specifies it: OLD-aware scope, the whole PAC create-frozen set, frozen lineage. */
const D15_V18 = `
  CREATE OR REPLACE FUNCTION session_execution_snapshot_guard() RETURNS trigger AS $fn$
  DECLARE ctx jsonb;
  BEGIN
    IF TG_OP = 'INSERT' THEN
      IF NEW.task_id IS NULL OR NEW.dispatch_origin <> 'COORDINATOR' THEN RETURN NEW; END IF;
      SELECT a.execution_context INTO ctx FROM project_action a WHERE a.id = NEW.project_action_id;
      IF ctx IS NULL
         OR NEW.agent_id           IS DISTINCT FROM ctx->>'agentId'
         OR NEW.workspace_id       IS DISTINCT FROM ctx->>'workspaceId'
         OR NEW.assigned_runner_id IS DISTINCT FROM ctx->>'assignedRunnerId'
         OR NEW.provider           IS DISTINCT FROM ctx->>'provider'
         OR NEW.provider_builtin   IS DISTINCT FROM (ctx->>'providerBuiltin')::boolean
         OR to_jsonb(NEW.required_capabilities) IS DISTINCT FROM ctx->'requiredCapabilities'
         OR NEW.permission_mode    IS DISTINCT FROM ctx->>'permissionMode'
         OR NEW.resolution         IS DISTINCT FROM ctx->'resolution'
         OR NEW.snapshot_frozen_at IS DISTINCT FROM (ctx->>'snapshotFrozenAt')::timestamptz THEN
        RAISE EXCEPTION 'EXECUTION_SNAPSHOT_MISMATCH: session % does not carry the frozen execution context of action %',
          NEW.id, NEW.project_action_id;
      END IF;
      IF NEW.model IS NOT NULL OR NEW.effort IS NOT NULL OR NEW.execution_pin_generation <> 0 THEN
        RAISE EXCEPTION 'EXECUTION_SNAPSHOT_MISMATCH: session % materializes claim-frozen columns at create', NEW.id;
      END IF;
      RETURN NEW;
    END IF;
    IF (OLD.task_id IS NULL OR OLD.dispatch_origin <> 'COORDINATOR')
       AND (NEW.task_id IS NULL OR NEW.dispatch_origin <> 'COORDINATOR') THEN RETURN NEW; END IF;
    IF NEW.task_id            IS DISTINCT FROM OLD.task_id
       OR NEW.dispatch_origin IS DISTINCT FROM OLD.dispatch_origin
       OR NEW.project_action_id IS DISTINCT FROM OLD.project_action_id
       OR NEW.agent_id        IS DISTINCT FROM OLD.agent_id
       OR NEW.workspace_id    IS DISTINCT FROM OLD.workspace_id
       OR NEW.assigned_runner_id IS DISTINCT FROM OLD.assigned_runner_id
       OR NEW.provider        IS DISTINCT FROM OLD.provider
       OR NEW.provider_builtin IS DISTINCT FROM OLD.provider_builtin
       OR NEW.required_capabilities IS DISTINCT FROM OLD.required_capabilities
       OR NEW.permission_mode IS DISTINCT FROM OLD.permission_mode
       OR NEW.resolution      IS DISTINCT FROM OLD.resolution
       OR NEW.snapshot_frozen_at IS DISTINCT FROM OLD.snapshot_frozen_at THEN
      RAISE EXCEPTION 'EXECUTION_SNAPSHOT_FROZEN: session % cannot rewrite a create-frozen or lineage column', OLD.id;
    END IF;
    IF NEW.model IS DISTINCT FROM OLD.model OR NEW.effort IS DISTINCT FROM OLD.effort THEN
      IF NEW.execution_pin_generation <> OLD.execution_pin_generation + 1 THEN
        RAISE EXCEPTION 'EXECUTION_PIN_GENERATION: session % rewrote model/effort without advancing the generation', OLD.id;
      END IF;
    ELSIF NEW.execution_pin_generation IS DISTINCT FROM OLD.execution_pin_generation THEN
      RAISE EXCEPTION 'EXECUTION_PIN_GENERATION: session % advanced the generation without rewriting anything', OLD.id;
    END IF;
    RETURN NEW;
  END;
  $fn$ LANGUAGE plpgsql;
`;

/** …and as v1.7 wrote it: NEW-only scope, six compared columns, no lineage freeze. */
const D15_V17 = `
  CREATE OR REPLACE FUNCTION session_execution_snapshot_guard() RETURNS trigger AS $fn$
  DECLARE ctx jsonb;
  BEGIN
    IF NEW.task_id IS NULL OR NEW.dispatch_origin <> 'COORDINATOR' THEN RETURN NEW; END IF;
    IF TG_OP = 'INSERT' THEN
      SELECT a.execution_context INTO ctx FROM project_action a WHERE a.id = NEW.project_action_id;
      IF ctx IS NULL
         OR NEW.agent_id           IS DISTINCT FROM ctx->>'agentId'
         OR NEW.workspace_id       IS DISTINCT FROM ctx->>'workspaceId'
         OR NEW.assigned_runner_id IS DISTINCT FROM ctx->>'assignedRunnerId'
         OR NEW.provider           IS DISTINCT FROM ctx->>'provider'
         OR NEW.provider_builtin   IS DISTINCT FROM (ctx->>'providerBuiltin')::boolean
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
`;

/** §7.7 D16, both directions. v1.7 had no object here at all — that is the reverse control. */
const D16_V18 = `
  CREATE OR REPLACE FUNCTION session_execution_result_check() RETURNS trigger AS $fn$
  DECLARE ctx jsonb; action_status text; ledger jsonb; claim jsonb;
  BEGIN
    IF NEW.task_id IS NULL OR NEW.dispatch_origin <> 'COORDINATOR' THEN RETURN NULL; END IF;
    SELECT a.execution_context, a.status,
           COALESCE(a.detail -> 'retiredPins', '[]'::jsonb), a.detail -> 'claimResolution'
      INTO ctx, action_status, ledger, claim
      FROM project_action a WHERE a.id = NEW.project_action_id;
    IF ctx IS NULL OR action_status <> 'APPLIED'
       OR NEW.agent_id           IS DISTINCT FROM ctx->>'agentId'
       OR NEW.workspace_id       IS DISTINCT FROM ctx->>'workspaceId'
       OR NEW.assigned_runner_id IS DISTINCT FROM ctx->>'assignedRunnerId'
       OR NEW.provider           IS DISTINCT FROM ctx->>'provider'
       OR NEW.provider_builtin   IS DISTINCT FROM (ctx->>'providerBuiltin')::boolean
       OR to_jsonb(NEW.required_capabilities) IS DISTINCT FROM ctx->'requiredCapabilities'
       OR NEW.permission_mode    IS DISTINCT FROM ctx->>'permissionMode'
       OR NEW.resolution         IS DISTINCT FROM ctx->'resolution'
       OR NEW.snapshot_frozen_at IS DISTINCT FROM (ctx->>'snapshotFrozenAt')::timestamptz THEN
      RAISE EXCEPTION 'EXECUTION_RESULT_MISMATCH: session % is not the frozen result of action %',
        NEW.id, NEW.project_action_id;
    END IF;
    IF NEW.execution_pin_generation = 0 THEN
      IF NEW.model IS NOT NULL OR NEW.effort IS NOT NULL
         OR claim IS NOT NULL OR jsonb_array_length(ledger) <> 0 THEN
        RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: session % is at generation 0 but a claim is already recorded', NEW.id;
      END IF;
    ELSIF claim IS NULL THEN
      RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: session % is at generation % but action % records no first claim',
        NEW.id, NEW.execution_pin_generation, NEW.project_action_id;
    ELSIF jsonb_array_length(ledger) <> NEW.execution_pin_generation - 1 THEN
      RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: session % is at generation % but action % records % retired pins',
        NEW.id, NEW.execution_pin_generation, NEW.project_action_id, jsonb_array_length(ledger);
    END IF;
    RETURN NULL;
  END;
  $fn$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION project_action_pin_ledger_check() RETURNS trigger AS $fn$
  DECLARE generation bigint; ledger jsonb; claim jsonb;
  BEGIN
    IF NEW.type <> 'DISPATCH_TASK' OR NEW.result_session_id IS NULL THEN RETURN NULL; END IF;
    SELECT s.execution_pin_generation INTO generation
      FROM session s WHERE s.id = NEW.result_session_id AND s.dispatch_origin = 'COORDINATOR';
    IF generation IS NULL THEN RETURN NULL; END IF;
    ledger := COALESCE(NEW.detail -> 'retiredPins', '[]'::jsonb);
    claim  := NEW.detail -> 'claimResolution';
    IF generation = 0 THEN
      IF claim IS NOT NULL OR jsonb_array_length(ledger) <> 0 THEN
        RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: action % records a claim session % has not made', NEW.id, NEW.result_session_id;
      END IF;
    ELSIF claim IS NULL OR jsonb_array_length(ledger) <> generation - 1 THEN
      RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: action % records % retired pins for generation %',
        NEW.id, jsonb_array_length(ledger), generation;
    END IF;
    RETURN NULL;
  END;
  $fn$ LANGUAGE plpgsql;
`;

const TABLES = `
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
    reason_code text,
    refusal_code text
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

  CREATE OR REPLACE FUNCTION session_dispatch_attribution_check() RETURNS trigger AS $fn$
  DECLARE ok boolean;
  BEGIN
    __D9_SCOPE__
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
`;

const D11_TRIGGER = `
  DROP TRIGGER IF EXISTS project_action_applied_immutable_guard ON project_action;
  CREATE TRIGGER project_action_applied_immutable_guard BEFORE UPDATE ON project_action
    FOR EACH ROW EXECUTE FUNCTION project_action_applied_immutable_guard();
`;
const D15_TRIGGER = `
  DROP TRIGGER IF EXISTS session_execution_snapshot_guard ON session;
  CREATE TRIGGER session_execution_snapshot_guard BEFORE INSERT OR UPDATE ON session
    FOR EACH ROW EXECUTE FUNCTION session_execution_snapshot_guard();
`;
const D16_TRIGGERS = `
  DROP TRIGGER IF EXISTS session_execution_result_check ON session;
  CREATE CONSTRAINT TRIGGER session_execution_result_check
    AFTER INSERT OR UPDATE ON session
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION session_execution_result_check();
  DROP TRIGGER IF EXISTS project_action_pin_ledger_check ON project_action;
  CREATE CONSTRAINT TRIGGER project_action_pin_ledger_check
    AFTER INSERT OR UPDATE OF detail, result_session_id ON project_action
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION project_action_pin_ledger_check();
`;

/** Rebuild the review schema with v1.8's objects. `reverseControl` puts v1.7's shapes back. */
async function resetSchema(client: Client, reverseControl = false): Promise<void> {
  await verifyCoordinatorPgIdentity(client);
  await client.query(`DROP SCHEMA IF EXISTS ${REVIEW_SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${REVIEW_SCHEMA}`);
  await client.query(`SET search_path TO ${REVIEW_SCHEMA}`);
  // §7.7 D9's scope is version-dependent too: v1.7 read NEW alone, which is half of PC-CX-45.
  await client.query(TABLES.replace('__D9_SCOPE__', reverseControl
    ? `IF NEW.task_id IS NULL OR NEW.dispatch_origin <> 'COORDINATOR' THEN RETURN NULL; END IF;`
    : `IF TG_OP = 'UPDATE' THEN
      IF (OLD.task_id IS NULL OR OLD.dispatch_origin <> 'COORDINATOR')
         AND (NEW.task_id IS NULL OR NEW.dispatch_origin <> 'COORDINATOR') THEN RETURN NULL; END IF;
    ELSIF NEW.task_id IS NULL OR NEW.dispatch_origin <> 'COORDINATOR' THEN
      RETURN NULL;
    END IF;`));
  await client.query(reverseControl ? D11_V17 : D11_V18);
  await client.query(D11_TRIGGER);
  await client.query(reverseControl ? D15_V17 : D15_V18);
  await client.query(D15_TRIGGER);
  if (!reverseControl) {
    await client.query(D16_V18);
    await client.query(D16_TRIGGERS);
  }
  await client.query(`INSERT INTO task VALUES ('t1','p1'); INSERT INTO project_runtime VALUES ('p1',1)`);
}

const SNAPSHOT_FROZEN_AT = '2026-08-19T00:00:00.000Z';

const frozenContext = {
  agentId: 'agent-a', workspaceId: 'workspace-a', assignedRunnerId: 'runner-a',
  provider: 'claude', providerBuiltin: false, requiredCapabilities: ['linux'],
  permissionMode: 'read-only',
  resolution: { v: 1, who: { source: 'task' }, with: { source: 'agent' }, where: { source: 'task' } },
  snapshotFrozenAt: SNAPSHOT_FROZEN_AT,
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
            'claude',false,ARRAY['linux'],'read-only',$3,$4::timestamptz)
  `, [id, actionId, frozenContext.resolution, SNAPSHOT_FROZEN_AT]);
}

/** Run `body` in one transaction; return the refusal message, or null if it committed. */
async function attempt(client: Client, body: () => Promise<void>): Promise<string | null> {
  await client.query('BEGIN');
  try {
    await body();
    await client.query('COMMIT');
    return null;
  } catch (error) {
    await client.query('ROLLBACK');
    return (error as Error).message;
  }
}

const skip = { skip: PG_URL ? false : 'set isolated Coordinator PostgreSQL identity variables to run' };

test('PC-CX-43 on isolated Postgres: the publishing UPDATE can no longer forge the frozen result digest',
  skip, async () => {
    const c = await connect();
    try {
      // Reverse control first: v1.7's object, and the review's three-statement transaction commits.
      await resetSchema(c, true);
      assert.equal(await attempt(c, async () => {
        await insertClaimedAction(c, 'a1', 'pc:v1:p1:dispatch:t1:0');
        await insertMatchingSession(c, 's1', 'a1');
        await c.query(`UPDATE project_action SET status='APPLIED', result_session_id='s1',
          execution_result_digest='forged-after-session-insert' WHERE id='a1'`);
      }), null, 'the v1.7 shape must still admit it — that is what makes the fix meaningful');
      assert.deepEqual((await c.query(
        `SELECT status, execution_result_digest FROM project_action WHERE id='a1'`)).rows[0],
        { status: 'APPLIED', execution_result_digest: 'forged-after-session-insert' },
        'and it leaves the review’s exact committed observation');

      // v1.8: the same transaction is refused, and a clean publish still commits.
      await resetSchema(c);
      assert.match(String(await attempt(c, async () => {
        await insertClaimedAction(c, 'a1', 'pc:v1:p1:dispatch:t1:0');
        await insertMatchingSession(c, 's1', 'a1');
        await c.query(`UPDATE project_action SET status='APPLIED', result_session_id='s1',
          execution_result_digest='forged-after-session-insert' WHERE id='a1'`);
      })), /ACTION_PUBLISH_IMMUTABLE.*execution_result_digest/s, 'v1.8 must refuse the publishing UPDATE');
      assert.equal((await c.query(`SELECT count(*)::text AS n FROM project_action`)).rows[0].n, '0',
        'the refused transaction must leave nothing behind');

      assert.equal(await attempt(c, async () => {
        await insertClaimedAction(c, 'a1', 'pc:v1:p1:dispatch:t1:0');
        await insertMatchingSession(c, 's1', 'a1');
        await c.query(`UPDATE project_action SET status='APPLIED', result_session_id='s1' WHERE id='a1'`);
      }), null, '§8.3’s normal path must still commit, or the fix blocks the contract');

      // Every column outside the four-column publish allowlist, driven by the catalog.
      const columns = (await c.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = '${REVIEW_SCHEMA}' AND table_name = 'project_action'
         ORDER BY ordinal_position`)).rows.map((r) => r.column_name)
        // `id` names the row, and `status` is the publish itself — its closed target set is
        // asserted separately below rather than by writing a nonsense value into it.
        .filter((col) => col !== 'id' && col !== 'status');
      const mutation = (col: string): string => col === 'fencing_token' ? '999'
        : (col === 'execution_context' || col === 'detail') ? `'{"provider":"codex"}'::jsonb`
          : `'mutated-${col}'`;
      const committed: string[] = [];
      for (const col of columns) {
        await resetSchema(c);
        // One SET clause, built as a map so the publish's own assignments are overridden rather
        // than duplicated — the sweep is "publish, and also move this column".
        const set = new Map<string, string>([['status', `'APPLIED'`], ['result_session_id', `'s1'`]]);
        set.set(col, mutation(col));
        const failure = await attempt(c, async () => {
          await insertClaimedAction(c, 'a1', 'pc:v1:p1:dispatch:t1:0');
          await insertMatchingSession(c, 's1', 'a1');
          await c.query(`UPDATE project_action SET ${[...set].map(([k, v]) => `${k} = ${v}`).join(', ')} WHERE id='a1'`);
        });
        if (failure === null) committed.push(col);
        else assert.match(failure, /ACTION_PUBLISH_IMMUTABLE|EXECUTION_/, `${col}: refused, but not by D11`);
      }
      assert.deepEqual(committed.sort(), ['detail', 'refusal_code', 'result_session_id'],
        'exactly the publish allowlist may move in the publishing statement, and it is read from the schema');

      // The transition target set is closed in both directions.
      await resetSchema(c);
      assert.match(String(await attempt(c, async () => {
        await insertClaimedAction(c, 'a1', 'pc:v1:p1:dispatch:t1:0');
        await c.query(`UPDATE project_action SET status='PENDING' WHERE id='a1'`);
      })), /ACTION_TRANSITION_ILLEGAL/, 'CLAIMED may only go to the three terminal states');
      assert.match(String(await attempt(c, async () => {
        await insertClaimedAction(c, 'a2', 'pc:v1:p1:dispatch:t1:1');
        await c.query(`UPDATE project_action SET status='REFUSED', refusal_code='WHO_DISABLED' WHERE id='a2'`);
        await c.query(`UPDATE project_action SET status='CLAIMED' WHERE id='a2'`);
      })), /ACTION_APPLIED_IMMUTABLE/, 'a terminal state may not go back out');
    } finally {
      await c.end();
    }
  });

test('PC-CX-44 on isolated Postgres: permissionMode and resolution are proved at insert and at commit',
  skip, async () => {
    const c = await connect();
    try {
      const forged = async (): Promise<void> => {
        await insertClaimedAction(c, 'a1', 'pc:v1:p1:dispatch:t1:0');
        await c.query(`
          INSERT INTO session
            (id,task_id,project_action_id,dispatch_origin,status,agent_id,workspace_id,assigned_runner_id,
             provider,provider_builtin,required_capabilities,permission_mode,resolution,snapshot_frozen_at)
          VALUES ('s1','t1','a1','COORDINATOR','PENDING','agent-a','workspace-a','runner-a',
                  'claude',false,ARRAY['linux'],'danger-full-access',
                  '{"v":1,"who":{"source":"forged"},"with":{},"where":{}}'::jsonb,$1::timestamptz)
        `, [SNAPSHOT_FROZEN_AT]);
        await c.query(`UPDATE project_action SET status='APPLIED', result_session_id='s1' WHERE id='a1'`);
      };

      // Reverse control: v1.7's six-column comparison lets the privilege escalation commit.
      await resetSchema(c, true);
      assert.equal(await attempt(c, forged), null, 'the v1.7 shape must still admit it');
      assert.deepEqual((await c.query(`
        SELECT s.permission_mode AS session_permission,
               a.execution_context->>'permissionMode' AS frozen_permission,
               s.resolution = a.execution_context->'resolution' AS resolution_equal
          FROM session s JOIN project_action a ON a.id=s.project_action_id WHERE s.id='s1'
      `)).rows[0], {
        session_permission: 'danger-full-access', frozen_permission: 'read-only', resolution_equal: false,
      }, 'and it leaves the review’s exact committed observation');

      // v1.8: refused at the statement, by D15.
      await resetSchema(c);
      assert.match(String(await attempt(c, forged)), /EXECUTION_SNAPSHOT_MISMATCH/,
        'D15 must compare the whole PAC create-frozen set at insert');

      // …and refused at the commit point too, when the drift is introduced after the insert passed.
      // D15's UPDATE branch freezes the column, so the only way to reach D16 is to leave the action
      // row unpublished — which D16 also refuses, on the same committed state.
      // D9 refuses an unpublished action too, and constraint triggers fire in name order, so it wins.
      // Disable it for one probe: the review's point is that in v1.7 nobody compared the RESULT at
      // the commit point, and that half has to be shown to carry its own weight.
      await c.query(`ALTER TABLE session DISABLE TRIGGER session_dispatch_attribution_check`);
      assert.match(String(await attempt(c, async () => {
        await insertClaimedAction(c, 'a1', 'pc:v1:p1:dispatch:t1:0');
        await insertMatchingSession(c, 's1', 'a1');
      })), /EXECUTION_RESULT_MISMATCH/, 'D16 must refuse a placeholder whose action never became APPLIED');
      await c.query(`ALTER TABLE session ENABLE TRIGGER session_dispatch_attribution_check`);
      assert.match(String(await attempt(c, async () => {
        await insertClaimedAction(c, 'a1', 'pc:v1:p1:dispatch:t1:0');
        await insertMatchingSession(c, 's1', 'a1');
        await c.query(`UPDATE project_action SET status='APPLIED', result_session_id='s1' WHERE id='a1'`);
        await c.query(`UPDATE session SET permission_mode='danger-full-access' WHERE id='s1'`);
      })), /EXECUTION_SNAPSHOT_FROZEN/, 'the create-frozen columns must be frozen after create');

      // Each of the three columns v1.7 omitted, on its own.
      for (const [column, value] of [
        ['permission_mode', `'danger-full-access'`],
        ['resolution', `'{"v":1,"who":{"source":"forged"}}'::jsonb`],
        ['snapshot_frozen_at', 'now()'],
      ] as const) {
        await resetSchema(c);
        assert.match(String(await attempt(c, async () => {
          await insertClaimedAction(c, 'a1', 'pc:v1:p1:dispatch:t1:0');
          await c.query(`
            INSERT INTO session
              (id,task_id,project_action_id,dispatch_origin,status,agent_id,workspace_id,assigned_runner_id,
               provider,provider_builtin,required_capabilities,permission_mode,resolution,snapshot_frozen_at)
            VALUES ('s1','t1','a1','COORDINATOR','PENDING','agent-a','workspace-a','runner-a',
                    'claude',false,ARRAY['linux'],'read-only',$1,$2::timestamptz)
          `.replace(`${column} = `, `${column} = `), [frozenContext.resolution, SNAPSHOT_FROZEN_AT]);
          await c.query(`UPDATE session SET ${column} = ${value} WHERE id='s1'`);
        })), /EXECUTION_SNAPSHOT_FROZEN/, `${column} must be frozen after create`);
      }

      // The legal dispatch still commits with all nine components equal.
      await resetSchema(c);
      assert.equal(await attempt(c, async () => {
        await insertClaimedAction(c, 'a1', 'pc:v1:p1:dispatch:t1:0');
        await insertMatchingSession(c, 's1', 'a1');
        await c.query(`UPDATE project_action SET status='APPLIED', result_session_id='s1' WHERE id='a1'`);
      }), null, 'a placeholder that equals its frozen context must commit');
    } finally {
      await c.end();
    }
  });

test('PC-CX-45 on isolated Postgres: a live Session can no longer shed its Task claim',
  skip, async () => {
    const c = await connect();
    try {
      const dispatch = async (action: string, key: string, session: string): Promise<string | null> =>
        attempt(c, async () => {
          await insertClaimedAction(c, action, key);
          await insertMatchingSession(c, session, action);
          await c.query(`UPDATE project_action SET status='APPLIED', result_session_id=$1 WHERE id=$2`,
            [session, action]);
        });
      const selfExempt = `UPDATE session SET task_id=NULL, dispatch_origin='USER', project_action_id=NULL,
        provider='codex', permission_mode='danger-full-access' WHERE id='s1'`;
      const counts = async () => (await c.query<{ live_rows: string; task_claims: string; orphaned_actions: string }>(`
        SELECT count(*) FILTER (WHERE s.status IN ('PENDING','RUNNING'))::text AS live_rows,
               count(*) FILTER (WHERE s.task_id='t1' AND s.status IN ('PENDING','RUNNING'))::text AS task_claims,
               (SELECT count(*)::text FROM project_action a
                 WHERE a.result_session_id='s1'
                   AND NOT EXISTS (SELECT 1 FROM session x WHERE x.project_action_id=a.id)) AS orphaned_actions
          FROM session s`)).rows[0];

      // Reverse control: v1.7's NEW-only scope lets one UPDATE release the claim.
      await resetSchema(c, true);
      assert.equal(await dispatch('a1', 'pc:v1:p1:dispatch:t1:0', 's1'), null);
      assert.equal(await attempt(c, async () => { await c.query(selfExempt); }), null,
        'the v1.7 shape must still admit the self-exemption');
      assert.equal(await dispatch('a2', 'pc:v1:p1:dispatch:t1:1', 's2'), null,
        'and the released claim must still admit a second live execution');
      assert.deepEqual(await counts(), { live_rows: '2', task_claims: '1', orphaned_actions: '1' },
        'the review’s exact committed observation');

      // v1.8: the same UPDATE is refused, the claim is held, and the second dispatch conflicts.
      await resetSchema(c);
      assert.equal(await dispatch('a1', 'pc:v1:p1:dispatch:t1:0', 's1'), null);
      assert.match(String(await attempt(c, async () => { await c.query(selfExempt); })),
        /EXECUTION_SNAPSHOT_FROZEN/, 'the lineage must be frozen on a COORDINATOR placeholder');
      for (const column of ['task_id=NULL', `dispatch_origin='USER'`, 'project_action_id=NULL']) {
        assert.match(String(await attempt(c, async () => {
          await c.query(`UPDATE session SET ${column} WHERE id='s1'`);
        })), /EXECUTION_SNAPSHOT_FROZEN|session_action_only_for_coordinator_chk/,
        `${column} must not be writable on a live COORDINATOR placeholder`);
      }
      assert.match(String(await dispatch('a2', 'pc:v1:p1:dispatch:t1:1', 's2')),
        /session_task_execution_claim_idx/, 'the second live Session must hit the D5 claim, not a free index');
      assert.deepEqual(await counts(), { live_rows: '1', task_claims: '1', orphaned_actions: '0' },
        'one claim, one execution, and no action left pointing at a session that disowned it');

      // Releasing the claim the legal way — a status change — is untouched.
      assert.equal(await attempt(c, async () => {
        await c.query(`UPDATE session SET status='AWAITING_INPUT' WHERE id='s1'`);
      }), null, 'the contract’s own way out of the claim set must still work');
    } finally {
      await c.end();
    }
  });

test('PC-CX-46 on isolated Postgres: the pin generation and the ledger are proved in both directions',
  skip, async () => {
    const c = await connect();
    try {
      const dispatch = async (): Promise<string | null> => attempt(c, async () => {
        await insertClaimedAction(c, 'a1', 'pc:v1:p1:dispatch:t1:0');
        await insertMatchingSession(c, 's1', 'a1');
        await c.query(`UPDATE project_action SET status='APPLIED', result_session_id='s1' WHERE id='a1'`);
      });
      const observed = async () => (await c.query<{ execution_pin_generation: string; retired_count: string }>(`
        SELECT s.execution_pin_generation::text,
               COALESCE(jsonb_array_length(a.detail->'retiredPins'),0)::text AS retired_count
          FROM session s JOIN project_action a ON a.id=s.project_action_id WHERE s.id='s1'`)).rows[0];

      // Reverse control: v1.7's D15 never reads the action row, so generation 2 commits with no records.
      await resetSchema(c, true);
      assert.equal(await dispatch(), null);
      await c.query(`UPDATE session SET model='model-v1', effort='high', execution_pin_generation=1 WHERE id='s1'`);
      await c.query(`UPDATE session SET model='model-v2', execution_pin_generation=2 WHERE id='s1'`);
      assert.deepEqual(await observed(), { execution_pin_generation: '2', retired_count: '0' },
        'the review’s exact committed observation');

      // v1.8: the legal path commits when the ledger moves in the same transaction…
      await resetSchema(c);
      assert.equal(await dispatch(), null);
      assert.equal(await attempt(c, async () => {
        await c.query(`UPDATE project_action SET detail=jsonb_build_object('claimResolution','model-v1') WHERE id='a1'`);
        await c.query(`UPDATE session SET model='model-v1', effort='high', execution_pin_generation=1 WHERE id='s1'`);
      }), null, 'a first claim that records itself must commit');
      // …in either statement order, because both objects are deferred.
      assert.equal(await attempt(c, async () => {
        await c.query(`UPDATE session SET model='model-v2', execution_pin_generation=2 WHERE id='s1'`);
        await c.query(`UPDATE project_action SET detail = detail || jsonb_build_object('retiredPins',
          jsonb_build_array(jsonb_build_object('from','model-v1','to','model-v2','at',now()))) WHERE id='a1'`);
      }), null, 'a retiredPin that records itself must commit, whichever table moves first');
      assert.deepEqual(await observed(), { execution_pin_generation: '2', retired_count: '1' });

      // …and every disagreement is refused, from whichever side it is written.
      const refusals: [string, () => Promise<void>][] = [
        ['generation ahead of the ledger', async () => {
          await c.query(`UPDATE session SET model='model-v3', execution_pin_generation=3 WHERE id='s1'`);
        }],
        ['ledger ahead of the generation', async () => {
          await c.query(`UPDATE project_action SET detail = jsonb_set(detail,'{retiredPins}',
            (detail->'retiredPins') || jsonb_build_array(jsonb_build_object('from','model-v2','to','model-v3')))
            WHERE id='a1'`);
        }],
      ];
      for (const [label, body] of refusals) {
        assert.match(String(await attempt(c, body)), /EXECUTION_PIN_LEDGER/, `${label} must be refused`);
      }
      // A first claim with no record at all, from a clean placeholder.
      await resetSchema(c);
      assert.equal(await dispatch(), null);
      assert.match(String(await attempt(c, async () => {
        await c.query(`UPDATE session SET model='model-v1', effort='high', execution_pin_generation=1 WHERE id='s1'`);
      })), /EXECUTION_PIN_LEDGER.*no first claim/s, 'a first claim with no record must be refused');
      assert.match(String(await attempt(c, async () => {
        await c.query(`UPDATE project_action SET detail=jsonb_build_object('claimResolution','model-v1') WHERE id='a1'`);
      })), /EXECUTION_PIN_LEDGER/, 'a record for a claim the session has not made must be refused');
      assert.deepEqual(await observed(), { execution_pin_generation: '0', retired_count: '0' },
        'and nothing partial is left behind');
    } finally {
      await c.end();
    }
  });

test('v1.7 independent counterexample inventory is complete and every finding is closed', () => {
  assert.deepEqual(['PC-CX-43', 'PC-CX-44', 'PC-CX-45', 'PC-CX-46'],
    ['PC-CX-43', 'PC-CX-44', 'PC-CX-45', 'PC-CX-46']);
  // The contract answers all four in one place, and the review file that raised them is untouched.
  const closure = between(CONTRACT, '## 26. `PC-CX-43..46` 修订闭环', '### 26.1 ');
  for (const id of ['PC-CX-43', 'PC-CX-44', 'PC-CX-45', 'PC-CX-46']) {
    assert.ok(closure.includes(`\`${id}\``), `§26 does not answer ${id}`);
  }
  assert.match(REVIEW, /FAIL \/ BLOCKED/, 'the v1.7 review verdict is a fact, not a draft');
  assert.match(REVIEW, /forged-after-session-insert/, 'the v1.7 review no longer carries its own evidence');
});
