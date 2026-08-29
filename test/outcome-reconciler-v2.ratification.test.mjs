import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { after, before } from 'node:test';

const require = createRequire(import.meta.url);
const { Client, Pool } = require('pg');
const ROOT = path.resolve(import.meta.dirname, '..');
const URL = process.env.OWNER_RATIFICATION_PG_URL;
const EXPECTED_DATABASE = process.env.OWNER_RATIFICATION_PG_EXPECTED_DATABASE;
const EXPECTED_USER = process.env.OWNER_RATIFICATION_PG_EXPECTED_USER;
const EXPECTED_SYSTEM_IDENTIFIER = process.env.OWNER_RATIFICATION_PG_EXPECTED_SYSTEM_IDENTIFIER;
const EVIDENCE_PATH = process.env.OWNER_RATIFICATION_EVIDENCE_PATH;

assert.ok(URL, 'OWNER_RATIFICATION_PG_URL is required; PostgreSQL absence is a hard failure');
assert.ok(EXPECTED_DATABASE, 'OWNER_RATIFICATION_PG_EXPECTED_DATABASE is required');
assert.ok(EXPECTED_USER, 'OWNER_RATIFICATION_PG_EXPECTED_USER is required');
assert.ok(EXPECTED_SYSTEM_IDENTIFIER, 'OWNER_RATIFICATION_PG_EXPECTED_SYSTEM_IDENTIFIER is required');
assert.ok(EVIDENCE_PATH, 'OWNER_RATIFICATION_EVIDENCE_PATH is required');

const pool = new Pool({ connectionString: URL, max: 20 });
const ownerId = randomUUID();
const evidence = {
  schemaVersion: 1,
  suite: 'outcome-reconciler-v2-owner-ratification',
  postgres: { required: true, connected: false, version: null, systemIdentifier: null },
  invariants: {
    agentSelfApprovalRefused: false,
    runnerSelfApprovalRefused: false,
    atomicOwnerCreateExactDigest: false,
    preapprovedTemplateBounded: false,
    delegationPrincipalAndProjectBounded: false,
    contractChangeInvalidatesImmediately: false,
    evaluationPlanEvolutionPreservesRatification: false,
    evaluationPlanEvolutionCreatesNoOwnerTodo: false,
    ownerDecisionPayloadExplainsImpact: false,
    authorityFactsImmutableAndRevocable: false,
    projectDeletionLifecyclePreserved: false,
    runnerDecisionCapabilityRedacted: false,
    unratifiedAutomaticExecutionRefused: false,
    harmlessManualPlanningAllowed: false,
    autoRunBlockedWorkIsDurablyVisible: false,
  },
  races: {
    permissionRevocationFailsClosed: false,
    budgetChangeFailsClosed: false,
    riskPolicyChangeFailsClosed: false,
    commitWaitsForProjectPolicyWriter: false,
  },
  cta: {
    expiredTokenCannotApprove: false,
    replacementRequestIssued: false,
    wrongTokenCannotApprove: false,
    exactReplayIdempotent: false,
    staleAndDuplicateCtaAppendOnce: false,
  },
  samples: {},
};

function digest(label) {
  return createHash('sha256').update(label).digest('hex');
}

after(async () => {
  await pool.end();
  mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence)}\n`);
});

before(async () => {
  await pool.query(
    `INSERT INTO "user" ("id","email","name","password_hash") VALUES ($1,$2,'ratification owner','x')`,
    [ownerId, `ratification-${ownerId}@example.test`],
  );
});

async function jsonCall(client, text, values) {
  const result = await client.query({ text, values });
  return result.rows[0].result;
}

async function state(projectId, client = pool) {
  return jsonCall(
    client,
    'SELECT project_owner_ratification_state_json($1::uuid,$2::uuid) AS result',
    [ownerId, projectId],
  );
}

async function createProject(label, options = {}) {
  const projectId = randomUUID();
  const definitionId = randomUUID();
  const goal = options.goal ?? `${label} owner goal`;
  await pool.query(
    `INSERT INTO "project" (
       "id","owner_id","title","goal","coordinator_enabled","automation_policy",
       "max_concurrent_tasks","session_budget_per_day","updated_at"
     ) VALUES ($1,$2,$3,$4,$5,$6::"project_automation_policy",$7,$8,now())`,
    [
      projectId,
      ownerId,
      `${label} project`,
      goal,
      options.coordinatorEnabled ?? true,
      options.automationPolicy ?? 'GUARDED_AUTO',
      options.maxConcurrentTasks ?? 3,
      options.sessionBudgetPerDay ?? 10,
    ],
  );
  await pool.query(
    `INSERT INTO "project_acceptance_criterion_definition" (
       "id","project_id","ordinal","text","verification_method","completion_criterion",
       "content_hash"
     ) VALUES ($1,$2,1,$3,$4,'HUMAN_SIGNOFF'::"task_completion_criterion",$5)`,
    [
      definitionId,
      projectId,
      options.criterionText ?? `${label} outcome is demonstrably complete`,
      options.verificationMethod ?? `review ${label} evidence`,
      digest(`placeholder:${definitionId}`),
    ],
  );
  return { projectId, definitionId, goal, state: await state(projectId) };
}

async function ownerDecision(projectId, overrides = {}, client = pool) {
  const current = overrides.state ?? await state(projectId, client);
  const request = overrides.request ?? current.decisionRequest;
  return jsonCall(
    client,
    `SELECT project_owner_ratify_contract(
       $1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7::uuid,$8,$9,$10
     ) AS result`,
    [
      ownerId,
      projectId,
      overrides.actorType ?? 'OWNER',
      overrides.actorId ?? ownerId,
      overrides.expectedContractDigest ?? current.contractDigest,
      overrides.decisionRequestId === undefined ? request?.id ?? null : overrides.decisionRequestId,
      overrides.ctaToken === undefined ? request?.ctaToken ?? null : overrides.ctaToken,
      overrides.decision ?? 'APPROVE',
      overrides.idempotencyKey ?? `owner:${projectId}:${randomUUID()}`,
      overrides.atomicCreate ?? false,
    ],
  );
}

function semanticConstraint(current) {
  const semantic = current.semanticContract;
  return {
    goal: semantic.goal,
    outcomes: semantic.outcomes,
    criteria: semantic.criteria,
    criteriaTrust: semantic.criteriaTrust,
    riskBoundary: semantic.riskBoundary,
    ownerId: semantic.ownerId,
  };
}

function authoritySpec(current, overrides = {}) {
  return {
    name: overrides.name ?? 'bounded owner template',
    contractConstraint: overrides.contractConstraint ?? semanticConstraint(current),
    riskPolicyDigests: overrides.riskPolicyDigests ?? [current.riskPolicyDigest],
    permissionDigests: overrides.permissionDigests ?? [current.permissionDigest],
    budgetDigests: overrides.budgetDigests ?? [current.budgetDigest],
    recipientDigests: overrides.recipientDigests ?? [current.recipientDigest],
    maxSessionBudgetPerDay: overrides.maxSessionBudgetPerDay ?? 10,
    maxUses: overrides.maxUses ?? 1,
    validThrough: overrides.validThrough ?? new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides.extra,
  };
}

async function createTemplate(spec) {
  return jsonCall(
    pool,
    'SELECT project_create_ratification_template($1::uuid,$2::jsonb) AS result',
    [ownerId, JSON.stringify(spec)],
  );
}

async function createDelegation(spec) {
  return jsonCall(
    pool,
    'SELECT project_create_ratification_delegation($1::uuid,$2::jsonb) AS result',
    [ownerId, JSON.stringify(spec)],
  );
}

async function preapproved(projectId, actorType, actorId, authority, authorityId, expected, key) {
  return jsonCall(
    pool,
    `SELECT project_preapproved_ratify_contract(
       $1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7,$8
     ) AS result`,
    [ownerId, projectId, actorType, actorId, authority, authorityId, expected, key],
  );
}

function actionEnvelope(current, overrides = {}) {
  return {
    effectClass: 'EXTERNAL_REVERSIBLE',
    budgetCharge: 1,
    contractDigest: current.contractDigest,
    evaluationPlanDigest: current.evaluationPlanDigest,
    riskPolicyDigest: current.riskPolicyDigest,
    permissionDigest: current.permissionDigest,
    budgetDigest: current.budgetDigest,
    recipientDigest: current.recipientDigest,
    operation: 'ratification acceptance fixture',
    ...overrides,
  };
}

async function submitAction(projectId, current, key, overrides = {}, client = pool) {
  return jsonCall(
    client,
    `SELECT project_submit_ratified_action(
       $1::uuid,$2::uuid,'RUNNER',$3,$4,$5::jsonb,$6
     ) AS result`,
    [
      ownerId,
      projectId,
      overrides.principalId ?? 'ratification-runner',
      overrides.triggerKind ?? 'AUTO',
      JSON.stringify(actionEnvelope(current, overrides.action)),
      key,
    ],
  );
}

async function commitAction(client, projectId, intent) {
  return jsonCall(
    client,
    'SELECT project_commit_ratified_action($1::uuid,$2::uuid,$3::uuid,$4::uuid) AS result',
    [ownerId, projectId, intent.intentId, intent.commitToken],
  );
}

test('requires isolated PostgreSQL 16 and automatic dispatch never loses unratified work', async () => {
  const result = await pool.query(`
    SELECT current_database() AS database,
           current_user AS role,
           (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
           current_setting('server_version') AS version
  `);
  const server = result.rows[0];
  assert.equal(server.database, EXPECTED_DATABASE);
  assert.equal(server.role, EXPECTED_USER);
  assert.equal(server.system_identifier, EXPECTED_SYSTEM_IDENTIFIER);
  assert.match(server.version, /^1[6-9]\./);
  evidence.postgres = {
    required: true,
    connected: true,
    version: server.version.split(' ')[0],
    systemIdentifier: server.system_identifier,
  };

  const source = readFileSync(
    path.join(ROOT, 'src/apiserver/src/tasks/tasks.service.ts'),
    'utf8',
  );
  assert.match(source, /const AUTO_RUN_READY_SQL[\s\S]*task_auto_dispatch_state/,
    'ready work with a standing refusal must remain durably wakeable');
  assert.match(source, /const AUTO_RUN_READY_SQL[\s\S]*Policy is deliberately NOT a candidate filter/,
    'ready work must reach the guarded dispatch door that records a typed obligation');
  assert.match(source, /const SCHEDULED_DUE_SQL[\s\S]*project_owner_ratification_effective\(/,
    'scheduled scans retain their bounded ratification prefilter');
  assert.match(source, /dispatchReadyTask[\s\S]*recordAutoDispatchObservation/,
    'the guarded dispatch door must persist its outcome instead of silently dropping work');
  const migration = readFileSync(
    path.join(
      ROOT,
      'src/apiserver/prisma/migrations/0195_project_owner_ratification/migration.sql',
    ),
    'utf8',
  );
  assert.match(migration, /CREATE TRIGGER session_owner_ratification_guard/);
  assert.match(migration, /FOR NO KEY UPDATE OF p/);
  evidence.invariants.autoRunBlockedWorkIsDurablyVisible = true;
});

test('agent and runner self-approval are rejected, including the rolling runner route', async () => {
  const fixture = await createProject('self-approval');
  for (const actorType of ['AGENT', 'RUNNER']) {
    await assert.rejects(
      ownerDecision(fixture.projectId, {
        actorType,
        actorId: `${actorType.toLowerCase()}-self`,
        idempotencyKey: `forbidden:${actorType}:${randomUUID()}`,
      }),
      /OWNER_RATIFICATION_ACTOR_FORBIDDEN.*agents and runners cannot ratify/i,
    );
  }
  const rows = await pool.query(
    'SELECT count(*)::int AS count FROM "project_owner_ratification" WHERE "project_id"=$1',
    [fixture.projectId],
  );
  assert.equal(rows.rows[0].count, 0);
  const acceptanceSource = readFileSync(
    path.join(ROOT, 'src/apiserver/src/projects/project-acceptance.service.ts'),
    'utf8',
  );
  assert.match(acceptanceSource, /if \(actor\.actorType !== 'USER'\)/);
  assert.match(acceptanceSource, /OWNER_RATIFICATION_ACTOR_FORBIDDEN/);
  assert.match(acceptanceSource,
    /async machineRatification[\s\S]*withoutOwnerRatificationCapability\(state\)/);
  const surfaceSource = readFileSync(
    path.join(ROOT, 'src/apiserver/src/projects/owner-ratification-surface.ts'),
    'utf8',
  );
  assert.match(surfaceSource, /key !== 'ctaToken' && key !== 'cta_token'/);
  assert.match(surfaceSource,
    /value\.map\(withoutOwnerRatificationCapability\)[\s\S]*withoutOwnerRatificationCapability\(nested\)/,
    'capability redaction must recursively cover arrays and nested objects');
  const runnerSource = readFileSync(
    path.join(ROOT, 'src/apiserver/src/runner-api/runner-projects.controller.ts'),
    'utf8',
  );
  assert.match(runnerSource, /projectRatification[\s\S]*machineRatification\(/);
  evidence.invariants.agentSelfApprovalRefused = true;
  evidence.invariants.runnerSelfApprovalRefused = true;
  evidence.invariants.runnerDecisionCapabilityRedacted = true;
});

test('one authenticated owner create transaction ratifies only its exact final digest', async () => {
  const client = await pool.connect();
  const projectId = randomUUID();
  const definitionId = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO "project" (
         "id","owner_id","title","goal","coordinator_enabled","automation_policy",
         "session_budget_per_day","updated_at"
       ) VALUES ($1,$2,'atomic project','atomic exact goal',true,
         'GUARDED_AUTO'::"project_automation_policy",10,now())`,
      [projectId, ownerId],
    );
    await client.query(
      `INSERT INTO "project_acceptance_criterion_definition" (
         "id","project_id","ordinal","text","verification_method","completion_criterion",
         "content_hash"
       ) VALUES ($1,$2,1,'atomic outcome','review atomic evidence',
         'HUMAN_SIGNOFF'::"task_completion_criterion",$3)`,
      [definitionId, projectId, digest('atomic placeholder')],
    );
    await jsonCall(
      client,
      `SELECT project_refresh_completion_contract($1::uuid,'ATOMIC_CREATE_FINAL') AS result`,
      [projectId],
    );
    const exact = await state(projectId, client);
    const approved = await ownerDecision(projectId, {
      state: exact,
      request: null,
      decisionRequestId: null,
      ctaToken: null,
      atomicCreate: true,
      idempotencyKey: `atomic-create:${projectId}`,
    }, client);
    assert.equal(approved.ok, true);
    assert.equal(approved.source, 'OWNER_ATOMIC_CREATE');
    assert.equal(approved.contractDigest, exact.contractDigest);

    const invisible = await pool.query('SELECT count(*)::int AS count FROM "project" WHERE "id"=$1', [projectId]);
    assert.equal(invisible.rows[0].count, 0, 'project and ratification become visible together');
    await client.query('COMMIT');

    const committed = await state(projectId);
    assert.equal(committed.ratified, true);
    assert.equal(committed.contractDigest, exact.contractDigest);
    assert.equal(committed.ratification.source, 'OWNER_ATOMIC_CREATE');
    evidence.invariants.atomicOwnerCreateExactDigest = true;
    evidence.samples.atomicContractDigest = exact.contractDigest;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
});

test('preapproved templates and delegations cannot escape semantic, digest, budget, principal, project, time, or use bounds', async () => {
  const templateProject = await createProject('template');
  await assert.rejects(
    createTemplate({
      ...authoritySpec(templateProject.state),
      contractConstraint: { goal: templateProject.goal },
    }),
    /RATIFICATION_TEMPLATE_UNBOUNDED/,
  );

  const wrongBudgetTemplate = await createTemplate(authoritySpec(templateProject.state, {
    name: 'wrong budget template',
    budgetDigests: [digest('not this budget')],
  }));
  const outside = await preapproved(
    templateProject.projectId,
    'RUNNER',
    'runner-template',
    'PREAPPROVED_TEMPLATE',
    wrongBudgetTemplate.id,
    templateProject.state.contractDigest,
    `wrong-template:${randomUUID()}`,
  );
  assert.equal(outside.ok, false);
  assert.equal(outside.code, 'RATIFICATION_TEMPLATE_OUT_OF_BOUNDS');

  const template = await createTemplate(authoritySpec(templateProject.state, { maxUses: 2 }));
  const templateApproval = await preapproved(
    templateProject.projectId,
    'RUNNER',
    'runner-template',
    'PREAPPROVED_TEMPLATE',
    template.id,
    templateProject.state.contractDigest,
    `template:${randomUUID()}`,
  );
  assert.equal(templateApproval.ok, true);
  assert.equal(templateApproval.source, 'PREAPPROVED_TEMPLATE');
  const afterTemplate = await state(templateProject.projectId);
  assert.equal(afterTemplate.ratified, true);
  assert.equal(templateApproval.contractDigest, afterTemplate.contractDigest);

  // A template is reusable semantic authority, not a disguised Project/criterion UUID allowlist.
  // The peer has fresh row identities (and therefore a different contractDigest) but exactly the
  // bounded goal/outcome/trust/policy material the owner pre-approved.
  const templatePeer = await createProject('template peer', {
    goal: templateProject.goal,
    criterionText: templateProject.state.semanticContract.outcomes[0],
    verificationMethod: 'a newer evaluator may implement the same semantic contract',
  });
  assert.notEqual(templatePeer.state.contractDigest, templateProject.state.contractDigest);
  const peerApproval = await preapproved(
    templatePeer.projectId,
    'RUNNER',
    'runner-template',
    'PREAPPROVED_TEMPLATE',
    template.id,
    templatePeer.state.contractDigest,
    `template-peer:${randomUUID()}`,
  );
  assert.equal(peerApproval.ok, true);
  assert.equal((await state(templatePeer.projectId)).ratified, true);

  await assert.rejects(
    pool.query(
      `UPDATE "project_ratification_template"
          SET "budget_digests"=ARRAY[$2::char(64)] WHERE "id"=$1`,
      [template.id, digest('widened after signature')],
    ),
    /RATIFICATION_TEMPLATE_IMMUTABLE/,
  );
  await pool.query(
    'UPDATE "project_ratification_template" SET "revoked_at"=now() WHERE "id"=$1',
    [template.id],
  );
  assert.equal((await state(templateProject.projectId)).ratified, false);
  assert.equal((await state(templatePeer.projectId)).ratified, false);

  const delegationProject = await createProject('delegation');
  const delegation = await createDelegation({
    ...authoritySpec(delegationProject.state, { name: undefined }),
    delegateType: 'RUNNER',
    delegateId: 'runner-delegate',
    projectId: delegationProject.projectId,
  });
  const wrongPrincipal = await preapproved(
    delegationProject.projectId,
    'RUNNER',
    'runner-intruder',
    'BOUND_DELEGATION',
    delegation.id,
    delegationProject.state.contractDigest,
    `wrong-delegate:${randomUUID()}`,
  );
  assert.equal(wrongPrincipal.ok, false);
  assert.equal(wrongPrincipal.code, 'RATIFICATION_DELEGATION_UNAVAILABLE');
  const delegated = await preapproved(
    delegationProject.projectId,
    'RUNNER',
    'runner-delegate',
    'BOUND_DELEGATION',
    delegation.id,
    delegationProject.state.contractDigest,
    `delegated:${randomUUID()}`,
  );
  assert.equal(delegated.ok, true);
  assert.equal(delegated.source, 'BOUND_DELEGATION');

  const otherProject = await createProject('other delegation project');
  const crossProject = await preapproved(
    otherProject.projectId,
    'RUNNER',
    'runner-delegate',
    'BOUND_DELEGATION',
    delegation.id,
    otherProject.state.contractDigest,
    `cross-project:${randomUUID()}`,
  );
  assert.equal(crossProject.ok, false);
  assert.equal(crossProject.code, 'RATIFICATION_DELEGATION_UNAVAILABLE');
  evidence.invariants.preapprovedTemplateBounded = true;
  evidence.invariants.delegationPrincipalAndProjectBounded = true;
  evidence.invariants.authorityFactsImmutableAndRevocable = true;
});

test('semantic wording changes invalidate immediately; evaluation-plan-only evolution does not create owner work', async () => {
  const semantic = await createProject('semantic lane');
  await ownerDecision(semantic.projectId, { state: semantic.state });
  const approvedDigest = semantic.state.contractDigest;
  await pool.query(
    'UPDATE "project_acceptance_criterion_definition" SET "text"=$2 WHERE "id"=$1',
    [semantic.definitionId, 'semantically changed completion wording'],
  );
  const invalidated = await state(semantic.projectId);
  assert.notEqual(invalidated.contractDigest, approvedDigest);
  assert.equal(invalidated.ratified, false);
  assert.equal(invalidated.decisionRequest.reasonCode, 'CONTRACT_CHANGED');
  assert.ok(invalidated.decisionRequest.semanticDiff.changedFields.includes('criteria'));
  assert.equal(
    invalidated.decisionRequest.payload.whyNotAgent,
    'an agent or runner cannot approve its own goal, authority, risk or budget',
  );
  assert.equal(invalidated.decisionRequest.payload.contractDigest, invalidated.contractDigest);
  assert.deepEqual(invalidated.decisionRequest.payload.contract, invalidated.semanticContract);
  assert.deepEqual(
    invalidated.decisionRequest.payload.costAndDeadline.budget,
    invalidated.semanticContract.budget,
  );
  assert.ok(invalidated.semanticContract.permissions);
  assert.ok(invalidated.semanticContract.recipients);
  evidence.invariants.contractChangeInvalidatesImmediately = true;
  evidence.invariants.ownerDecisionPayloadExplainsImpact = true;

  const plan = await createProject('evaluation lane');
  await ownerDecision(plan.projectId, { state: plan.state });
  const before = await state(plan.projectId);
  await pool.query(
    `UPDATE "project_acceptance_criterion_definition"
        SET "verification_method"='use independent evaluator version two' WHERE "id"=$1`,
    [plan.definitionId],
  );
  const evolved = await state(plan.projectId);
  assert.equal(evolved.contractDigest, before.contractDigest);
  assert.notEqual(evolved.evaluationPlanDigest, before.evaluationPlanDigest);
  assert.equal(evolved.ratified, true);
  assert.equal(evolved.decisionRequest, null);
  const pending = await pool.query(
    `SELECT count(*)::int AS count FROM "project_owner_decision_request"
      WHERE "project_id"=$1 AND "status"='PENDING'`,
    [plan.projectId],
  );
  assert.equal(pending.rows[0].count, 0);
  evidence.invariants.evaluationPlanEvolutionPreservesRatification = true;
  evidence.invariants.evaluationPlanEvolutionCreatesNoOwnerTodo = true;
  evidence.samples.evolvedEvaluationPlanDigest = evolved.evaluationPlanDigest;
});

async function policyRace(label, updateSql) {
  const fixture = await createProject(`race ${label}`);
  await ownerDecision(fixture.projectId, { state: fixture.state });
  const current = await state(fixture.projectId);
  const intent = await submitAction(
    fixture.projectId,
    current,
    `intent:${label}:${randomUUID()}`,
    { action: { budgetCharge: 2 } },
  );
  assert.equal(intent.ok, true);

  const writer = new Client({ connectionString: URL });
  const committer = new Client({ connectionString: URL });
  await writer.connect();
  await committer.connect();
  let settled = false;
  try {
    await writer.query('BEGIN');
    await writer.query(updateSql, [fixture.projectId]);
    const pendingCommit = commitAction(committer, fixture.projectId, intent).then(
      (value) => {
        settled = true;
        return value;
      },
      (error) => {
        settled = true;
        throw error;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(settled, false, `${label} action commit must serialize behind the Project writer`);
    await writer.query('COMMIT');
    const committed = await pendingCommit;
    assert.equal(committed.ok, false);
    assert.equal(committed.code, 'RATIFIED_ACTION_BINDING_STALE');
    const rows = await pool.query(
      'SELECT count(*)::int AS count FROM "project_ratified_action_commit" WHERE "intent_id"=$1',
      [intent.intentId],
    );
    assert.equal(rows.rows[0].count, 0);
    return { fixture, intent };
  } catch (error) {
    await writer.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await writer.end();
    await committer.end();
  }
}

test('permission revocation, budget tightening, and risk-policy change win races fail closed', async () => {
  await policyRace(
    'permission',
    'UPDATE "project" SET "coordinator_enabled"=false WHERE "id"=$1',
  );
  evidence.races.permissionRevocationFailsClosed = true;
  evidence.races.commitWaitsForProjectPolicyWriter = true;

  await policyRace(
    'budget',
    'UPDATE "project" SET "session_budget_per_day"=1 WHERE "id"=$1',
  );
  evidence.races.budgetChangeFailsClosed = true;

  await policyRace(
    'risk',
    `UPDATE "project" SET "automation_policy"='MANUAL'::"project_automation_policy" WHERE "id"=$1`,
  );
  evidence.races.riskPolicyChangeFailsClosed = true;
});

test('expired, mismatched, stale, and duplicate CTAs never append an unintended decision', async () => {
  const fixture = await createProject('cta');
  const first = fixture.state.decisionRequest;
  await pool.query(
    `UPDATE "project_owner_decision_request" SET "expires_at"=now()-interval '1 second'
      WHERE "id"=$1`,
    [first.id],
  );
  const expired = await ownerDecision(fixture.projectId, {
    state: fixture.state,
    request: first,
    idempotencyKey: `expired:${randomUUID()}`,
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.code, 'OWNER_DECISION_CTA_EXPIRED');
  assert.notEqual(expired.newDecisionRequestId, first.id);
  evidence.cta.expiredTokenCannotApprove = true;
  evidence.cta.replacementRequestIssued = true;

  const refreshed = await state(fixture.projectId);
  const wrong = await ownerDecision(fixture.projectId, {
    state: refreshed,
    request: refreshed.decisionRequest,
    ctaToken: randomUUID(),
    idempotencyKey: `wrong-token:${randomUUID()}`,
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, 'OWNER_DECISION_CTA_MISMATCH');
  evidence.cta.wrongTokenCannotApprove = true;

  const key = `cta-approval:${fixture.projectId}`;
  const approved = await ownerDecision(fixture.projectId, {
    state: refreshed,
    request: refreshed.decisionRequest,
    idempotencyKey: key,
  });
  assert.equal(approved.ok, true);
  const replay = await ownerDecision(fixture.projectId, {
    state: refreshed,
    request: refreshed.decisionRequest,
    idempotencyKey: key,
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.ratificationId, approved.ratificationId);
  evidence.cta.exactReplayIdempotent = true;

  const stale = await ownerDecision(fixture.projectId, {
    state: refreshed,
    request: first,
    idempotencyKey: `stale-cta:${randomUUID()}`,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'OWNER_DECISION_ALREADY_SPENT');
  const duplicateCta = await ownerDecision(fixture.projectId, {
    state: refreshed,
    request: refreshed.decisionRequest,
    idempotencyKey: `same-cta-new-key:${randomUUID()}`,
  });
  assert.equal(duplicateCta.ok, true);
  assert.equal(duplicateCta.duplicate, true);
  const rows = await pool.query(
    'SELECT count(*)::int AS count FROM "project_owner_ratification" WHERE "project_id"=$1',
    [fixture.projectId],
  );
  assert.equal(rows.rows[0].count, 1);
  evidence.cta.staleAndDuplicateCtaAppendOnce = true;
});

test('an unratified project permits bounded planning but cannot start an automatic side-effect chain', async () => {
  const fixture = await createProject('unratified execution');
  const current = await state(fixture.projectId);
  const refused = await submitAction(
    fixture.projectId,
    current,
    `unratified-auto:${randomUUID()}`,
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'OWNER_RATIFICATION_REQUIRED');

  const planning = await submitAction(
    fixture.projectId,
    current,
    `manual-planning:${randomUUID()}`,
    {
      triggerKind: 'MANUAL',
      action: { effectClass: 'PLANNING', budgetCharge: 0 },
    },
  );
  assert.equal(planning.ok, true);
  const planningCommit = await commitAction(pool, fixture.projectId, planning);
  assert.equal(planningCommit.ok, true);
  evidence.invariants.harmlessManualPlanningAllowed = true;

  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const taskId = randomUUID();
  await pool.query(
    `INSERT INTO "runner" (
       "id","owner_id","name","status","token_hash","capabilities_reported_at"
     ) VALUES ($1,$2,'ratification runner','ONLINE',$3,now())`,
    [runnerId, ownerId, `token-${runnerId}`],
  );
  await pool.query(
    `INSERT INTO "workspace" (
       "id","owner_id","name","runner_id","can_create_tasks","can_delegate"
     ) VALUES ($1,$2,'ratification workspace',$3,true,true)`,
    [workspaceId, ownerId, runnerId],
  );
  await pool.query(
    `INSERT INTO "task" (
       "id","title","status","owner_id","creator_type","creator_id","project_id",
       "assignee_id","updated_at"
     ) VALUES ($1,'ratification task','OPEN'::"task_status",$2,
       'USER'::"creator_type",$2,$3,$4,now())`,
    [taskId, ownerId, fixture.projectId, workspaceId],
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO "session" (
         "id","owner_id","workspace_id","task_id","title","prompt","creator_id","provider",
         "status","starts_task_work","dispatch_origin","run_source","updated_at"
       ) VALUES ($1,$2,$3,$4,'automatic ratification run','side effect',$2,'claude',
         'PENDING'::"run_status",true,'LEGACY_SWEEP'::"session_dispatch_origin",
         'TASK_LIST_AUTO'::"session_run_source",now())`,
      [randomUUID(), ownerId, workspaceId, taskId],
    ),
    /OWNER_RATIFICATION_REQUIRED.*automatic execution/i,
  );
  const sessions = await pool.query(
    'SELECT count(*)::int AS count FROM "session" WHERE "task_id"=$1',
    [taskId],
  );
  assert.equal(sessions.rows[0].count, 0);
  evidence.invariants.unratifiedAutomaticExecutionRefused = true;
});

test('append-only ratification facts do not prevent the owning Project lifecycle delete', async () => {
  const fixture = await createProject('ratified deletion');
  await ownerDecision(fixture.projectId, { state: fixture.state });
  const current = await state(fixture.projectId);
  const intent = await submitAction(
    fixture.projectId,
    current,
    `deletion-intent:${randomUUID()}`,
  );
  assert.equal(intent.ok, true);
  assert.equal((await commitAction(pool, fixture.projectId, intent)).ok, true);

  // Direct event deletion remains forbidden; only the parent lifecycle cascade is admitted.
  await assert.rejects(
    pool.query('DELETE FROM "project_owner_ratification" WHERE "project_id"=$1', [fixture.projectId]),
    /OWNER_RATIFICATION_IMMUTABLE/,
  );
  await pool.query('DELETE FROM "project" WHERE "id"=$1', [fixture.projectId]);
  const remaining = await pool.query(
    `SELECT
       (SELECT count(*) FROM "project" WHERE "id"=$1)::int AS projects,
       (SELECT count(*) FROM "project_owner_ratification" WHERE "project_id"=$1)::int AS ratifications,
       (SELECT count(*) FROM "project_ratified_action_intent" WHERE "project_id"=$1)::int AS intents,
       (SELECT count(*) FROM "project_ratified_action_commit" WHERE "project_id"=$1)::int AS commits`,
    [fixture.projectId],
  );
  assert.deepEqual(remaining.rows[0], {
    projects: 0,
    ratifications: 0,
    intents: 0,
    commits: 0,
  });
  evidence.invariants.projectDeletionLifecyclePreserved = true;
});
