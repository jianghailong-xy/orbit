import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const MODULE_PATH = process.env.OUTCOME_SURFACES_MODULE;
const FIXTURE_PATH = process.env.OUTCOME_SURFACES_FIXTURE;
const URL = process.env.OUTCOME_SURFACES_PG_URL;
const EVIDENCE_PATH = process.env.OUTCOME_SURFACES_EVIDENCE_PATH;
for (const [key, value] of Object.entries({ MODULE_PATH, FIXTURE_PATH, URL, EVIDENCE_PATH })) {
  assert.ok(value, `${key} is required`);
}

const surfaces = await import(pathToFileURL(path.resolve(MODULE_PATH)).href);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const pool = new Pool({ connectionString: URL, max: 8 });
const evidence = {
  suite: 'outcome-reconciler-v2-surfaces',
  schemaVersion: 2,
  invariants: {},
  samples: {},
};

const clone = (value) => structuredClone(value);
const digest = (value) => createHash('sha256').update(String(value)).digest('hex');

function derive(surface, actor, overrides = {}) {
  return surfaces.deriveOutcomeSurface({
    projection: clone(overrides.projection ?? fixture.projection),
    surface,
    actor,
    decisionRequests: clone(overrides.requests ?? fixture.decisionRequests),
    logicalNow: overrides.logicalNow ?? fixture.logicalNow,
    now: new Date('2026-08-28T00:00:00.000Z'),
  });
}

function currentSet() {
  return {
    doneGate: derive('DONE_GATE', 'SYSTEM'),
    agentQueue: derive('AGENT_QUEUE', 'AGENT'),
    ownerInbox: derive('OWNER_DECISION_INBOX', 'OWNER'),
    projectAttention: derive('PROJECT_ATTENTION', 'OWNER'),
    web: derive('WEB', 'OWNER'),
  };
}

before(async () => {
  const result = await pool.query('SELECT current_setting(\'server_version\') AS version');
  assert.match(result.rows[0].version, /^1[6-9]\./);
});

after(async () => {
  await pool.end();
  mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
});

test('API, CLI and Web preserve one semantic tuple while CTA follows the actor', () => {
  const set = currentSet();
  surfaces.assertOutcomeSurfaceSetConsistency(set);
  const agent = set.agentQueue.items;
  const owner = set.ownerInbox.items;
  assert.deepEqual(agent.map((item) => item.semantic.obligationId), fixture.expected.agentQueue);
  assert.deepEqual(owner.map((item) => item.semantic.obligationId), fixture.expected.ownerInbox);
  assert.equal(agent[0].cta.kind, fixture.expected.agentCta);
  assert.equal(owner[0].cta.kind, fixture.expected.ownerCta);

  const reference = new Map(set.doneGate.items.map((item) => [
    item.semantic.obligationId,
    surfaces.outcomeSurfaceSemanticTuple(item),
  ]));
  for (const [transport, view] of Object.entries({
    api: set.projectAttention,
    cli: JSON.parse(JSON.stringify(set.agentQueue)),
    web: set.web,
  })) {
    for (const item of view.items) {
      assert.deepEqual(
        surfaces.outcomeSurfaceSemanticTuple(item),
        reference.get(item.semantic.obligationId),
        `${transport} changed semantic identity/binding/reason/watermark`,
      );
    }
  }
  evidence.invariants.transportSemanticParity = true;
  evidence.invariants.actorSpecificCta = true;
  evidence.samples.canonicalIdentity = set.doneGate.canonicalIdentity;
});

test('a doneGate obligation cannot disappear into an empty owner inbox', () => {
  const set = currentSet();
  set.ownerInbox = { ...set.ownerInbox, items: [] };
  assert.throws(
    () => surfaces.assertOutcomeSurfaceSetConsistency(set),
    /OUTCOME_OWNER_INBOX_MISSING_DONE_GATE_OBLIGATION/,
  );
  evidence.invariants.doneGateCannotOutrunInbox = true;
});

test('agent work cannot be routed to the human inbox', () => {
  const set = currentSet();
  set.ownerInbox.items.push(set.agentQueue.items[0]);
  assert.throws(
    () => surfaces.assertOutcomeSurfaceSetConsistency(set),
    /OUTCOME_NON_OWNER_OBLIGATION_IN_HUMAN_INBOX/,
  );
  assert.equal(set.ownerInbox.items.filter((item) => item.semantic.owner === 'AGENT').length, 1);
  evidence.invariants.agentWorkNeverBecomesHumanTodo = true;
});

test('expired CTA stays visible as attention but is impossible to invoke', () => {
  const expired = clone(fixture.decisionRequests);
  expired[0].expiresLogicalTime = fixture.logicalNow;
  const inbox = derive('OWNER_DECISION_INBOX', 'OWNER', { requests: expired });
  assert.equal(inbox.items.length, 1, 'expiry must not create a false empty inbox');
  assert.equal(inbox.items[0].cta, null);
  assert.equal(inbox.items[0].ctaUnavailableReason, 'OWNER_DECISION_CTA_EXPIRED');
  assert.equal(inbox.items[0].decisionRequest.requestRevision, expired[0].requestRevision);
  evidence.invariants.expiredCtaCannotOperate = true;
  evidence.invariants.expiredRequestDoesNotDisappear = true;
});

test('a superseded request cannot shadow its current bound successor', () => {
  const current = clone(fixture.decisionRequests[0]);
  const predecessor = {
    ...clone(current),
    requestId: '22222222-2222-4222-a222-222222222222',
    requestRevision: digest('superseded-owner-request'),
    status: 'SUPERSEDED',
  };
  const inbox = derive('OWNER_DECISION_INBOX', 'OWNER', { requests: [predecessor, current] });
  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0].cta.binding.requestRevision, current.requestRevision);
  assert.equal(inbox.items[0].decisionRequest.requestId, current.requestId);
  evidence.invariants.supersededCtaSelectsCurrentRevision = true;
});

test('secret keys and bearer/token values never cross the surface boundary', () => {
  const requests = clone(fixture.decisionRequests);
  requests[0].protocol.recommendation = {
    apiToken: 'sk-super-secret-value-123456789',
    nested: {
      authorization: 'Bearer should-never-leak',
      diagnostic: 'failed against postgres://user:password-leak@example.test/database',
    },
  };
  const inbox = derive('OWNER_DECISION_INBOX', 'OWNER', { requests });
  const rendered = JSON.stringify(inbox);
  assert.doesNotMatch(rendered, /super-secret|should-never-leak|password-leak|Bearer/i);
  assert.match(rendered, /\[REDACTED\]/);
  evidence.invariants.secretRedaction = true;
});

test('stale projection is explicit and can never assert an empty todo list', () => {
  const projection = {
    schemaVersion: 2,
    staleness: 'RECONCILER_STALE',
    canonicalIdentity: fixture.projection.canonicalIdentity,
    error: { code: 'RECONCILER_STALE' },
  };
  const stale = derive('AGENT_QUEUE', 'AGENT', { projection });
  assert.equal(stale.staleness, 'RECONCILER_STALE');
  assert.equal(Object.hasOwn(stale, 'obligations'), false);
  assert.equal(Object.hasOwn(stale, 'items'), false);
  assert.throws(
    () => derive('AGENT_QUEUE', 'AGENT', { projection: { ...projection, obligations: [] } }),
    /OUTCOME_STALE_PROJECTION_MUST_NOT_ASSERT_EMPTY_OR_PRESENT_WORK/,
  );
  evidence.invariants.staleNeverLooksEmpty = true;
});

test('database enforces tenant scope, and the coordinator decision lane is gone', async () => {
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const projectId = randomUUID();
  const bindingDigest = fixture.projection.canonicalIdentity.bindingDigest;
  const binding = {
    evaluatorDigest: digest('surface-evaluator'),
    contractDigest: digest('surface-contract'),
    evaluationPlanDigest: digest('surface-plan'),
  };
  await pool.query('INSERT INTO outcome_fact_stream (tenant_id,project_id,last_logical_time,binding_epoch) VALUES ($1,$2,1,1)', [tenantId, projectId]);
  await pool.query({
    text: `INSERT INTO outcome_fact_binding (
      tenant_id,project_id,binding_digest,binding_epoch,subject_type,subject_id,goal_id,
      goal_revision,risk_policy_digest,fact_schema_digest,target_digest,target_ref,binding
    ) VALUES ($1::uuid,$2::uuid,$3,1,'PROJECT',$2::uuid::text,'goal:surface',1,$4,$5,$6,'refs/heads/main',$7::jsonb)`,
    values: [tenantId, projectId, bindingDigest, digest('risk'), digest('schema'), digest('target'), JSON.stringify(binding)],
  });
  const stale = (await pool.query(
    `SELECT outcome_projection.read_surface($1::uuid,$2::uuid,'PROJECT',$2::uuid::text,'AGENT_QUEUE') AS value`,
    [tenantId, projectId],
  )).rows[0].value;
  assert.equal(stale.staleness, 'RECONCILER_STALE');
  assert.equal(Object.hasOwn(stale, 'obligations'), false);
  await assert.rejects(
    pool.query(`SELECT outcome_projection.read_surface($1::uuid,$2::uuid,'PROJECT',$2::uuid::text,'AGENT_QUEUE')`, [otherTenantId, projectId]),
    /OUTCOME_PROJECTION_STREAM_NOT_FOUND/,
  );

  // The request-revision binding, database expiry and payload bound this case used to prove were
  // all enforced by the persistent coordinator's owner-decision request table. 0221 removed that
  // table and both callbacks with it, so what is left to assert is that the lane is unreachable:
  // a surface can no longer offer a DECIDE CTA because there is nothing to decide against.
  const relations = (await pool.query(`
    SELECT to_regclass('public.outcome_coordinator_owner_decision_request') AS request_table,
           to_regclass('public.outcome_coordinator_obligation') AS obligation_table,
           to_regclass('public.outcome_coordinator_clock') AS clock_table
  `)).rows[0];
  assert.deepEqual(relations, { request_table: null, obligation_table: null, clock_table: null });
  const callbacks = (await pool.query(`
    SELECT coalesce(string_agg(proname, ',' ORDER BY proname), '') AS names
      FROM pg_proc WHERE proname LIKE 'outcome\\_%coordinator\\_owner\\_%'
         OR proname LIKE 'outcome\\_%owner\\_decision%'
  `)).rows[0].names;
  assert.equal(callbacks, '', 'no owner-decision callback may outlive its table');
  evidence.samples.bindingDigest = bindingDigest;
  evidence.invariants.crossTenantReadDenied = true;
  evidence.invariants.coordinatorDecisionTablesRemoved = true;
  evidence.invariants.coordinatorDecisionCallbacksRemoved = true;
  evidence.invariants.staleProjectionStillFailsClosed = true;
  evidence.invariants.ownerDecisionLaneUnreachable = true;
});

test('an evaluation-plan-only edit moves the plan digest and leaves the contract where it is',
  async () => {
  const ownerId = randomUUID();
  const projectId = randomUUID();
  const definitionId = randomUUID();
  await pool.query(
    `INSERT INTO "user" ("id","email","name","password_hash") VALUES ($1,$2,'surface owner','x')`,
    [ownerId, `surface-${ownerId}@example.test`],
  );
  await pool.query(
    `INSERT INTO "project" (
      "id","owner_id","title","goal","coordinator_enabled","automation_policy",
      "max_concurrent_tasks","session_budget_per_day","updated_at"
    ) VALUES ($1,$2,'surface contract','exact goal',true,
      'GUARDED_AUTO'::"project_automation_policy",3,10,now())`,
    [projectId, ownerId],
  );
  await pool.query(
    `INSERT INTO "project_acceptance_criterion_definition" (
      "id","project_id","ordinal","text","verification_method","completion_criterion","content_hash"
    ) VALUES ($1,$2,1,'exact outcome','review version one',
      'HUMAN_SIGNOFF'::"task_completion_criterion",$3)`,
    [definitionId, projectId, digest(`placeholder:${definitionId}`)],
  );
  const readState = async () => {
    await pool.query('SELECT project_refresh_completion_contract($1::uuid, $2)',
      [projectId, 'SURFACE_READ']);
    return (await pool.query(
      `SELECT "contract_digest"::text AS "contractDigest",
              "evaluation_plan_digest"::text AS "evaluationPlanDigest"
         FROM "project_completion_contract" WHERE "project_id" = $1::uuid`,
      [projectId],
    )).rows[0];
  };
  const before = await readState();
  await pool.query(
    `UPDATE "project_acceptance_criterion_definition"
        SET "verification_method"='review version two' WHERE "id"=$1`,
    [definitionId],
  );
  const evolved = await readState();
  // The two lanes are still independent: how a criterion is CHECKED may move without moving what
  // the project counts as done.
  assert.equal(evolved.contractDigest, before.contractDigest);
  assert.notEqual(evolved.evaluationPlanDigest, before.evaluationPlanDigest);
  evidence.invariants.evaluationPlanLaneIsIndependent = true;
});
