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

test('database enforces tenant scope, request revision binding, expiry and payload bounds', async () => {
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const projectId = randomUUID();
  const coordinationId = randomUUID();
  const requestId = randomUUID();
  const bindingDigest = fixture.projection.canonicalIdentity.bindingDigest;
  const obligation = fixture.projection.obligations[1];
  const coordinationRevision = digest(`coordination:${coordinationId}`);
  const source = { ...obligation, binding: { tenantId, projectId } };
  const binding = {
    evaluatorDigest: digest('surface-evaluator'),
    contractDigest: digest('surface-contract'),
    evaluationPlanDigest: digest('surface-plan'),
  };
  const request = {
    whyNotAgent: 'Only the owner can accept this exact risk.',
    options: ['APPROVE', 'DENY'],
    impacts: ['resume or remain blocked'],
    recommendation: 'DENY',
    noActionConsequence: 'doneGate remains blocked',
    cost: { amount: 0 },
    deadline: { logicalTime: '11' },
    resumeBehavior: 'wake the same coordinator',
    idempotencyKey: `surface:${requestId}`,
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

  await pool.query('INSERT INTO outcome_coordinator_clock (tenant_id,clock_id,logical_time) VALUES ($1,$2,20)', [tenantId, randomUUID()]);
  await pool.query({
    text: `INSERT INTO outcome_coordinator_obligation_revision (
      tenant_id,project_id,coordination_revision,source_type,source_key,obligation_id,
      obligation_revision,binding_digest,kind,requested_owner,capability,liveness_delta,
      attempt_budget,wake_budget,same_failure_fingerprint_limit,max_lease_renewals,
      source_obligation,source_digest,created_logical_time
    ) VALUES ($1,$2,$3,'CANONICAL',$4,$5,$6,$7,$8,'OWNER',$9,10,3,3,2,1,$10::jsonb,
      outcome_sha256_json($10::jsonb),1)`,
    values: [tenantId, projectId, coordinationRevision, `surface:${coordinationId}`, obligation.obligationId,
      obligation.obligationRevision, bindingDigest, obligation.kind, obligation.capability, JSON.stringify(source)],
  });
  await pool.query({
    text: `INSERT INTO outcome_coordinator_obligation (
      coordination_id,tenant_id,project_id,coordination_revision,source_type,source_key,
      obligation_id,obligation_revision,binding_digest,kind,capability,requested_owner,
      durable_owner,status,attempt_budget_max,attempt_budget_remaining,wake_budget_max,
      wake_budget_remaining,same_failure_fingerprint_limit,max_lease_renewals,liveness_delta,
      last_progress_logical_time,progress_deadline_logical_time,source_obligation,source_digest
    ) VALUES ($1,$2,$3,$4,'CANONICAL',$5,$6,$7,$8,$9,$10,'OWNER','OWNER','READY',
      3,3,3,3,2,1,10,1,11,$11::jsonb,outcome_sha256_json($11::jsonb))`,
    values: [coordinationId, tenantId, projectId, coordinationRevision, `surface:${coordinationId}`,
      obligation.obligationId, obligation.obligationRevision, bindingDigest, obligation.kind,
      obligation.capability, JSON.stringify(source)],
  });
  await pool.query({
    text: `INSERT INTO outcome_coordinator_owner_decision_request (
      request_id,tenant_id,project_id,coordination_id,obligation_revision,reason,why_not_agent,
      idempotency_key,request,request_digest,status,requested_logical_time
    ) VALUES ($1,$2,$3,$4,$5,'RISK_ACCEPTANCE',$6,$7,$8::jsonb,
      outcome_sha256_json($8::jsonb),'OPEN',1)`,
    values: [requestId, tenantId, projectId, coordinationId, obligation.obligationRevision,
      request.whyNotAgent, request.idempotencyKey, JSON.stringify(request)],
  });
  await pool.query(
    `UPDATE outcome_coordinator_obligation SET status='OWNER_DECISION',decision_request_id=$2 WHERE coordination_id=$1`,
    [coordinationId, requestId],
  );
  const bound = (await pool.query(
    `SELECT request_revision,obligation_id,obligation_revision,binding_digest,
            expires_logical_time::text AS expires
       FROM outcome_coordinator_owner_decision_request WHERE request_id=$1`,
    [requestId],
  )).rows[0];
  assert.equal(bound.expires, '11');
  await assert.rejects(pool.query({
    text: `SELECT outcome_decide_coordinator_owner_request(
      $1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8::jsonb)`,
    values: [tenantId, requestId, bound.request_revision, bound.obligation_id,
      bound.obligation_revision, bound.binding_digest, 'expired-attempt', JSON.stringify({ choice: 'APPROVE' })],
  }), /OUTCOME_OWNER_DECISION_CTA_STALE_OR_EXPIRED/);
  await assert.rejects(pool.query({
    text: 'SELECT outcome_decide_coordinator_owner_request($1::uuid,$2::uuid,$3,$4,$5::jsonb)',
    values: [tenantId, requestId, bound.obligation_revision, 'unbound-attempt', JSON.stringify({ choice: 'APPROVE' })],
  }), /function outcome_decide_coordinator_owner_request.*does not exist/i);
  const oversized = {
    ...request,
    idempotencyKey: `huge:${requestId}`,
    impacts: Array.from({ length: 1_000 }, (_, index) => digest(`uncompressible:${requestId}:${index}`)),
  };
  await assert.rejects(pool.query({
    text: `INSERT INTO outcome_coordinator_owner_decision_request (
      request_id,tenant_id,project_id,coordination_id,obligation_revision,reason,why_not_agent,
      idempotency_key,request,request_digest,status,requested_logical_time
    ) VALUES ($1,$2,$3,$4,$5,'RISK_ACCEPTANCE',$6,$7,$8::jsonb,
      outcome_sha256_json($8::jsonb),'OPEN',1)`,
    values: [randomUUID(), tenantId, projectId, coordinationId, obligation.obligationRevision,
      oversized.whyNotAgent, oversized.idempotencyKey, JSON.stringify(oversized)],
  }), /outcome_coordinator_owner_payload_bound_check/);
  evidence.invariants.crossTenantReadDenied = true;
  evidence.invariants.requestRevisionBound = true;
  evidence.invariants.databaseExpiryEnforced = true;
  evidence.invariants.unboundCallbackRemoved = true;
  evidence.invariants.payloadBounded = true;
  evidence.samples.requestRevision = bound.request_revision;
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
