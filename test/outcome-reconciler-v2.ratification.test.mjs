import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
    envelopeMoveKeepsRatification: false,
    envelopeMoveStillStalesRatifiedActions: false,
    ceilingCrossingRequiresOwner: false,
    tighteningNeedsNoOwnerDecision: false,
    looseningRequiresOwnerDecision: false,
    unorderableChangeFailsClosed: false,
    irreducibleJudgementStillInvalidates: false,
    abaProtectionSurvivesTheRecut: false,
    recutDerivesOneOwnerDecisionAndNoRatification: false,
    recutDoesNotPromoteDeferredBacklog: false,
    nonOwnerPrincipalRatificationRefused: false,
    // Agent proposes, owner ratifies: the proposal itself never moves the ruler.
    criteriaProposalDoesNotMoveTheRuler: false,
    criteriaProposalKeepsReadModelOnRatifiedSet: false,
    criteriaProposalCardCarriesOwnerProtocol: false,
    criteriaProposalCardRendersSemanticDiff: false,
    ownerApprovalAppliesAndRatifiesAtomically: false,
    criteriaProposalApprovesWhatWasShown: false,
    criteriaProposalMachineDecisionRefused: false,
    criteriaProposalHasNoAutomaticApplyPath: false,
    criteriaProposalDenialIsRecordedNotDropped: false,
    criteriaProposalAbaProtectionSurvivesRevert: false,
    criteriaProposalSupersedesRatherThanCoexists: false,
    criteriaEditingHasNoWebEntryPoint: false,
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
       "max_concurrent_tasks","session_budget_per_day","attempt_budget",
       "convergence_thresholds","updated_at"
     ) VALUES ($1,$2,$3,$4,$5,$6::"project_automation_policy",$7,$8,$9::jsonb,$10::jsonb,now())`,
    [
      projectId,
      ownerId,
      `${label} project`,
      goal,
      options.coordinatorEnabled ?? true,
      options.automationPolicy ?? 'GUARDED_AUTO',
      options.maxConcurrentTasks ?? 3,
      options.sessionBudgetPerDay ?? 10,
      options.attemptBudget === undefined ? null : JSON.stringify(options.attemptBudget),
      options.convergenceThresholds === undefined
        ? null
        : JSON.stringify(options.convergenceThresholds),
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

// ---------------------------------------------------------------------------------------------
// Authority-envelope helpers. The suite above reads state through the owner surface; these read
// the stored contract row directly, because two of the invariants below are about a Project whose
// owner changed and about a digest that no current composition produces.

async function contractRow(projectId) {
  const { rows } = await pool.query(
    `SELECT "contract_digest" AS "contractDigest",
            "contract_revision"::text AS "contractRevision",
            "semantic_material" AS "semanticMaterial",
            "authority_envelope" AS "authorityEnvelope",
            "permission_digest" AS "permissionDigest",
            "budget_digest" AS "budgetDigest",
            "risk_policy_digest" AS "riskPolicyDigest"
       FROM "project_completion_contract" WHERE "project_id"=$1`,
    [projectId],
  );
  return rows[0];
}

async function contractIsRatified(projectId) {
  const { rows } = await pool.query(
    `SELECT project_owner_ratification_effective($1::uuid, state."contract_digest"::text) AS ok
       FROM "project_completion_contract" state WHERE state."project_id"=$1`,
    [projectId],
  );
  return rows[0].ok;
}

async function pendingDecisions(projectId) {
  const { rows } = await pool.query(
    `SELECT "id", "reason_code" AS "reasonCode", "semantic_diff" AS "semanticDiff",
            "previous_contract_digest" AS "previousContractDigest",
            "routing_state" AS "routingState"
       FROM "project_owner_decision_request"
      WHERE "project_id"=$1 AND "status"='PENDING'
      ORDER BY "request_generation"`,
    [projectId],
  );
  return rows;
}

async function ratificationCount(projectId) {
  const { rows } = await pool.query(
    'SELECT count(*)::int AS count FROM "project_owner_ratification" WHERE "project_id"=$1',
    [projectId],
  );
  return rows[0].count;
}

/** One authority column at a time, so every assertion below names the exact field it moved. */
async function setAuthorityField(projectId, column, value, cast = '') {
  await pool.query(
    `UPDATE "project" SET "${column}"=$2${cast} WHERE "id"=$1`,
    [projectId, value === null || typeof value !== 'object' ? value : JSON.stringify(value)],
  );
  return state(projectId);
}

/** A project the owner really approved, through the real CTA protocol. */
async function ratifiedProject(label, options = {}) {
  const fixture = await createProject(label, options);
  const approved = await ownerDecision(fixture.projectId, { state: fixture.state });
  assert.equal(approved.ok, true, `${label} must start from a real owner approval`);
  const current = await state(fixture.projectId);
  assert.equal(current.ratified, true, `${label} must start ratified`);
  return { ...fixture, approvedDigest: current.contractDigest, approvedState: current };
}

/**
 * Asserts a move the owner already authorized: the ratification survives it, the digest does not
 * move, and no owner is asked anything. Reading the state twice is deliberate — every read runs a
 * refresh, so a request derived on the second pass would be a question with no new cause.
 */
async function assertInsideEnvelope(fixture, description) {
  const current = await state(fixture.projectId);
  assert.equal(current.contractDigest, fixture.approvedDigest,
    `${description} must not move contractDigest`);
  assert.equal(current.ratified, true, `${description} must not void the ratification`);
  assert.equal(current.decisionRequest, null, `${description} must not raise an owner decision`);
  const again = await state(fixture.projectId);
  assert.equal(again.contractDigest, fixture.approvedDigest);
  assert.deepEqual(await pendingDecisions(fixture.projectId), [],
    `${description} must leave the owner with nothing pending`);
}

/**
 * Asserts an expansion: the digest moves, the standing approval stops being effective, and exactly
 * one owner decision request carries the reason and the diff — once, however often it is re-read.
 */
async function assertOutsideEnvelope(fixture, description, changedField) {
  const current = await state(fixture.projectId);
  assert.notEqual(current.contractDigest, fixture.approvedDigest,
    `${description} must advance contractDigest`);
  assert.equal(current.ratified, false, `${description} must void the standing ratification`);
  assert.equal(current.decisionRequest.reasonCode, 'CONTRACT_CHANGED');
  if (changedField) {
    assert.ok(current.decisionRequest.semanticDiff.changedFields.includes(changedField),
      `${description} must name ${changedField} in its semantic diff`);
  }
  await state(fixture.projectId);
  const pending = await pendingDecisions(fixture.projectId);
  assert.equal(pending.length, 1, `${description} must ask exactly once`);
  assert.equal(pending[0].id, current.decisionRequest.id);
  assert.equal(pending[0].previousContractDigest, fixture.approvedDigest,
    `${description} must show the owner what their approval was replaced by`);
  return current;
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

// ---------------------------------------------------------------------------------------------
// Authority monotonicity. The question a field belongs to is not "is it operational or semantic"
// but "can it be used to widen the agent's own authority". Everything below is one of the three
// answers: inside an approved ceiling, provably tighter, or unprovable and therefore the owner's.

test('an approved envelope is authority the owner does not have to grant twice', async () => {
  const fixture = await ratifiedProject('envelope interior', {
    maxConcurrentTasks: 3,
    sessionBudgetPerDay: 10,
    attemptBudget: { maxTurns: 60, maxToolCalls: 1200 },
  });
  const approvedRow = await contractRow(fixture.projectId);
  assert.deepEqual(approvedRow.authorityEnvelope, {
    attemptBudget: { maxTurns: 60, maxToolCalls: 1200 },
    automationPolicy: 'GUARDED_AUTO',
    convergenceThresholds: null,
    coordinatorEnabled: true,
    maxConcurrentTasks: 3,
    sessionBudgetPerDay: 10,
  }, 'approving is what establishes the ceiling');
  assert.equal(approvedRow.semanticMaterial.permissions.maxConcurrentTasks, 3);
  assert.equal(approvedRow.semanticMaterial.permissionDigest, undefined,
    'a digest over the live values would smuggle every in-envelope move back into contractDigest');
  assert.equal(approvedRow.semanticMaterial.budgetDigest, undefined);
  assert.equal(approvedRow.semanticMaterial.permissions.authorizationRevision, undefined);
  assert.equal(approvedRow.semanticMaterial.budget.authorizationRevision, undefined);
  assert.equal(approvedRow.semanticMaterial.riskBoundary.authorizationRevision, undefined);

  // The real service path bumps configRevision on every authorization write, so the invariant is
  // only worth anything if it survives that bump too.
  await pool.query(
    `UPDATE "project" SET "max_concurrent_tasks"=1,
            "config_revision"="config_revision"+1 WHERE "id"=$1`,
    [fixture.projectId],
  );
  await assertInsideEnvelope(fixture, 'lowering concurrency under an approved ceiling');

  await setAuthorityField(fixture.projectId, 'max_concurrent_tasks', 3, '::int');
  await assertInsideEnvelope(fixture, 'returning to exactly the approved concurrency ceiling');

  await setAuthorityField(fixture.projectId, 'session_budget_per_day', 4, '::int');
  await assertInsideEnvelope(fixture, 'spending a smaller daily session budget');

  await setAuthorityField(
    fixture.projectId, 'attempt_budget', { maxTurns: 10, maxToolCalls: 50 }, '::jsonb');
  await assertInsideEnvelope(fixture, 'tightening every dimension of the attempt budget');
  evidence.invariants.envelopeMoveKeepsRatification = true;

  // Not asking the owner again is not the same as letting an in-flight action carry on under
  // parameters that moved. The operating digests still bind the live values.
  const moved = await contractRow(fixture.projectId);
  assert.notEqual(moved.permissionDigest, approvedRow.permissionDigest);
  assert.notEqual(moved.budgetDigest, approvedRow.budgetDigest);
  const current = await state(fixture.projectId);
  const intent = await submitAction(
    fixture.projectId, current, `envelope-intent:${randomUUID()}`);
  assert.equal(intent.ok, true, 'the project is still ratified, so the action is still admissible');
  await setAuthorityField(fixture.projectId, 'max_concurrent_tasks', 2, '::int');
  const stale = await commitAction(pool, fixture.projectId, intent);
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'RATIFIED_ACTION_BINDING_STALE');
  await assertInsideEnvelope(fixture, 'stalling an in-flight action');
  evidence.invariants.envelopeMoveStillStalesRatifiedActions = true;
});

test('crossing an approved ceiling is an expansion and goes back to the owner', async () => {
  const concurrency = await ratifiedProject('ceiling concurrency', { maxConcurrentTasks: 3 });
  await setAuthorityField(concurrency.projectId, 'max_concurrent_tasks', 4, '::int');
  await assertOutsideEnvelope(concurrency, 'raising concurrency past the ceiling', 'permissions');

  const sessions = await ratifiedProject('ceiling sessions', { sessionBudgetPerDay: 10 });
  await setAuthorityField(sessions.projectId, 'session_budget_per_day', 11, '::int');
  await assertOutsideEnvelope(sessions, 'raising the daily session budget', 'budget');

  // NULL is "no limit", which is the top of this dimension rather than an absent value.
  const unlimited = await ratifiedProject('ceiling unlimited', { sessionBudgetPerDay: 10 });
  await setAuthorityField(unlimited.projectId, 'session_budget_per_day', null, '::int');
  await assertOutsideEnvelope(unlimited, 'dropping the daily session budget entirely', 'budget');

  const attempts = await ratifiedProject('ceiling attempts', {
    attemptBudget: { maxTurns: 60, maxToolCalls: 1200 },
  });
  await setAuthorityField(
    attempts.projectId, 'attempt_budget', { maxTurns: 61, maxToolCalls: 1200 }, '::jsonb');
  await assertOutsideEnvelope(attempts, 'raising one attempt-budget dimension', 'budget');
  evidence.invariants.ceilingCrossingRequiresOwner = true;

  // An expansion the owner never answered records nothing, so the ceiling does not ratchet: the
  // digest comes back to the one they approved. The standing approval does NOT come back with it,
  // because contract_revision has moved on — asking a question and then withdrawing it is not the
  // same as never having asked, and the envelope must not weaken that fence into a way to dodge it.
  await setAuthorityField(concurrency.projectId, 'max_concurrent_tasks', 3, '::int');
  const withdrawn = await state(concurrency.projectId);
  assert.equal(withdrawn.contractDigest, concurrency.approvedDigest,
    'withdrawing an unapproved expansion leaves no widened ceiling behind');
  assert.equal(withdrawn.ratified, false,
    'and still cannot revive the approval the expansion invalidated');
  const withdrawnRow = await contractRow(concurrency.projectId);
  assert.equal(withdrawnRow.authorityEnvelope.maxConcurrentTasks, 3,
    'the ceiling only ever rises on an approval, never on an unanswered request');
});

test('tightening is free in both directions of the monotone-safe fields; loosening is not', async () => {
  const thresholds = await ratifiedProject('thresholds tighter', {
    convergenceThresholds: { maxAttemptsWithoutProgress: 5, maxTransientRetries: 3 },
  });
  await setAuthorityField(thresholds.projectId, 'convergence_thresholds',
    { maxAttemptsWithoutProgress: 2, maxTransientRetries: 1 }, '::jsonb');
  await assertInsideEnvelope(thresholds, 'tightening every convergence threshold');

  const coordinator = await ratifiedProject('coordinator off', { coordinatorEnabled: true });
  await setAuthorityField(coordinator.projectId, 'coordinator_enabled', false);
  await assertInsideEnvelope(coordinator, 'switching the coordinator off');

  const policy = await ratifiedProject('policy stricter', { automationPolicy: 'AUTO' });
  await setAuthorityField(
    policy.projectId, 'automation_policy', 'GUARDED_AUTO', '::"project_automation_policy"');
  await assertInsideEnvelope(policy, 'moving AUTO down to GUARDED_AUTO');
  await setAuthorityField(
    policy.projectId, 'automation_policy', 'MANUAL', '::"project_automation_policy"');
  await assertInsideEnvelope(policy, 'moving GUARDED_AUTO down to MANUAL');
  evidence.invariants.tighteningNeedsNoOwnerDecision = true;

  const loosened = await ratifiedProject('thresholds looser', {
    convergenceThresholds: { maxAttemptsWithoutProgress: 5, maxTransientRetries: 3 },
  });
  await setAuthorityField(loosened.projectId, 'convergence_thresholds',
    { maxAttemptsWithoutProgress: 5, maxTransientRetries: 4 }, '::jsonb');
  await assertOutsideEnvelope(loosened, 'raising one convergence threshold', 'riskBoundary');

  const switchedOn = await ratifiedProject('coordinator on', { coordinatorEnabled: false });
  await setAuthorityField(switchedOn.projectId, 'coordinator_enabled', true);
  await assertOutsideEnvelope(switchedOn, 'switching the coordinator on', 'permissions');

  const escalated = await ratifiedProject('policy looser', { automationPolicy: 'GUARDED_AUTO' });
  await setAuthorityField(
    escalated.projectId, 'automation_policy', 'AUTO', '::"project_automation_policy"');
  await assertOutsideEnvelope(escalated, 'escalating GUARDED_AUTO to AUTO', 'riskBoundary');
  evidence.invariants.looseningRequiresOwnerDecision = true;
});

test('a change with no mechanical direction is treated as an expansion, not as a tightening', async () => {
  const retyped = await ratifiedProject('unorderable value type', {
    convergenceThresholds: { maxAttemptsWithoutProgress: 5 },
  });
  await setAuthorityField(retyped.projectId, 'convergence_thresholds',
    { maxAttemptsWithoutProgress: '5' }, '::jsonb');
  await assertOutsideEnvelope(retyped, 'a threshold rewritten as a string', 'riskBoundary');

  const restructured = await ratifiedProject('unorderable structure', {
    convergenceThresholds: { maxAttemptsWithoutProgress: 5 },
  });
  await setAuthorityField(restructured.projectId, 'convergence_thresholds',
    { tiers: [{ maxAttemptsWithoutProgress: 5 }] }, '::jsonb');
  await assertOutsideEnvelope(restructured, 'a threshold map restructured', 'riskBoundary');

  // Every named limit is at or under what was approved, but a key the owner never saw cannot be
  // read as a tightening of anything: only the frozen defaults would say, and they are not what
  // was ratified.
  const widened = await ratifiedProject('unorderable key set', {
    convergenceThresholds: { maxAttemptsWithoutProgress: 5 },
  });
  await setAuthorityField(widened.projectId, 'convergence_thresholds',
    { maxAttemptsWithoutProgress: 1, maxScopeExpansionRequests: 0 }, '::jsonb');
  await assertOutsideEnvelope(widened, 'a threshold key the approval never named', 'riskBoundary');

  const dropped = await ratifiedProject('unorderable fallback', {
    attemptBudget: { maxTurns: 10 },
  });
  await setAuthorityField(dropped.projectId, 'attempt_budget', null, '::jsonb');
  await assertOutsideEnvelope(dropped, 'dropping an override back to the frozen defaults', 'budget');
  evidence.invariants.unorderableChangeFailsClosed = true;
});

test('envelope authority changes nothing about the judgement the owner cannot delegate', async () => {
  const goal = await ratifiedProject('irreducible goal');
  await setAuthorityField(goal.projectId, 'goal', 'a different goal than the one approved');
  await assertOutsideEnvelope(goal, 'rewriting the goal', 'goal');

  const criteria = await ratifiedProject('irreducible criteria');
  await pool.query(
    'UPDATE "project_acceptance_criterion_definition" SET "text"=$2 WHERE "id"=$1',
    [criteria.definitionId, 'a completion criterion the owner never read'],
  );
  await assertOutsideEnvelope(criteria, 'rewriting a criterion', 'criteria');

  const outcomes = await ratifiedProject('irreducible outcomes');
  await pool.query(
    `INSERT INTO "project_acceptance_criterion_definition" (
       "id","project_id","ordinal","text","verification_method","completion_criterion",
       "content_hash"
     ) VALUES ($1,$2,2,'a second outcome nobody approved','review it',
       'HUMAN_SIGNOFF'::"task_completion_criterion",$3)`,
    [randomUUID(), outcomes.projectId, digest(`extra outcome ${outcomes.projectId}`)],
  );
  await assertOutsideEnvelope(outcomes, 'adding an outcome', 'outcomes');

  const unbounded = await ratifiedProject('irreducible unbounded');
  await setAuthorityField(unbounded.projectId, 'unbounded_authorized_by',
    { actor: 'USER', principal: 'someone who did not sign this contract' }, '::jsonb');
  await assertOutsideEnvelope(unbounded, 'signing for an unbounded threshold', 'riskBoundary');

  const recipients = await ratifiedProject('irreducible recipients');
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await pool.query(
    `INSERT INTO "runner" (
       "id","owner_id","name","status","token_hash","capabilities_reported_at"
     ) VALUES ($1,$2,'recipient runner','ONLINE',$3,now())`,
    [runnerId, ownerId, `token-${runnerId}`],
  );
  await pool.query(
    `INSERT INTO "workspace" (
       "id","owner_id","name","runner_id","can_create_tasks","can_delegate"
     ) VALUES ($1,$2,'recipient workspace',$3,true,true)`,
    [workspaceId, ownerId, runnerId],
  );
  await pool.query(
    `INSERT INTO "project_member" ("id","project_id","agent_id","role")
     VALUES ($1,$2,$3,'COORDINATOR'::"project_role")`,
    [randomUUID(), recipients.projectId, workspaceId],
  );
  await assertOutsideEnvelope(recipients, 'adding a coordinator recipient', 'recipients');

  // The owner is the one field whose change makes the owner surface itself unreadable, so this one
  // is asserted against the stored contract rather than through project_owner_ratification_state_json.
  const reassigned = await ratifiedProject('irreducible owner');
  const successorOwner = randomUUID();
  await pool.query(
    `INSERT INTO "user" ("id","email","name","password_hash") VALUES ($1,$2,'successor owner','x')`,
    [successorOwner, `successor-${successorOwner}@example.test`],
  );
  await pool.query('UPDATE "project" SET "owner_id"=$2 WHERE "id"=$1',
    [reassigned.projectId, successorOwner]);
  await jsonCall(pool, 'SELECT project_refresh_completion_contract($1::uuid,$2) AS result',
    [reassigned.projectId, 'OWNER_REASSIGNED']);
  const reassignedRow = await contractRow(reassigned.projectId);
  assert.notEqual(reassignedRow.contractDigest, reassigned.approvedDigest,
    'handing the project to another owner must advance contractDigest');
  assert.equal(await contractIsRatified(reassigned.projectId), false);
  evidence.invariants.irreducibleJudgementStillInvalidates = true;
});

test('the ABA lane still refuses to let an old approval come back to life', async () => {
  const reverted = await ratifiedProject('aba revert');
  const originalText = reverted.state.semanticContract.criteria[0].text;
  await pool.query(
    'UPDATE "project_acceptance_criterion_definition" SET "text"=$2 WHERE "id"=$1',
    [reverted.definitionId, 'briefly something else'],
  );
  assert.equal((await state(reverted.projectId)).ratified, false);
  await pool.query(
    'UPDATE "project_acceptance_criterion_definition" SET "text"=$2 WHERE "id"=$1',
    [reverted.definitionId, originalText],
  );
  const back = await state(reverted.projectId);
  assert.notEqual(back.contractDigest, reverted.approvedDigest,
    'edit-then-revert must not land back on the approved digest');
  assert.equal(back.ratified, false);
  assert.equal(back.semanticContract.criteria[0].text, originalText);
  assert.ok(back.semanticContract.criteriaVersions[0].semanticRevision > 1,
    'semanticRevision is what makes the revert visible');

  const recreated = await ratifiedProject('aba recreate');
  const recreateClient = await pool.connect();
  try {
    await recreateClient.query('BEGIN');
    await recreateClient.query(
      'DELETE FROM "project_acceptance_criterion_definition" WHERE "id"=$1',
      [recreated.definitionId],
    );
    await recreateClient.query(
      `INSERT INTO "project_acceptance_criterion_definition" (
         "id","project_id","ordinal","text","verification_method","completion_criterion",
         "content_hash"
       ) VALUES ($1,$2,1,$3,$4,'HUMAN_SIGNOFF'::"task_completion_criterion",$5)`,
      [
        randomUUID(),
        recreated.projectId,
        recreated.state.semanticContract.criteria[0].text,
        'review aba recreate evidence',
        digest(`recreated:${recreated.projectId}`),
      ],
    );
    await recreateClient.query('COMMIT');
  } catch (error) {
    await recreateClient.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    recreateClient.release();
  }
  const afterRecreate = await state(recreated.projectId);
  assert.deepEqual(afterRecreate.semanticContract.criteria,
    recreated.state.semanticContract.criteria, 'the wording is byte-identical');
  assert.deepEqual(afterRecreate.semanticContract.outcomes,
    recreated.state.semanticContract.outcomes);
  assert.notEqual(afterRecreate.contractDigest, recreated.approvedDigest,
    'delete-and-recreate must not resurrect the approval');
  assert.equal(afterRecreate.ratified, false);

  const replaced = await ratifiedProject('aba identity');
  const replacementId = randomUUID();
  const replaceClient = await pool.connect();
  try {
    await replaceClient.query('BEGIN');
    await replaceClient.query(
      `INSERT INTO "project_acceptance_criterion_definition" (
         "id","project_id","ordinal","text","verification_method","completion_criterion",
         "content_hash"
       ) VALUES ($1,$2,2,$3,$4,'HUMAN_SIGNOFF'::"task_completion_criterion",$5)`,
      [
        replacementId,
        replaced.projectId,
        replaced.state.semanticContract.criteria[0].text,
        replaced.state.evaluationPlan.verifiers[0].verificationMethod,
        digest(`replacement:${replaced.projectId}`),
      ],
    );
    await replaceClient.query(
      'DELETE FROM "project_acceptance_criterion_definition" WHERE "id"=$1',
      [replaced.definitionId],
    );
    await replaceClient.query('COMMIT');
  } catch (error) {
    await replaceClient.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    replaceClient.release();
  }
  const afterReplace = await state(replaced.projectId);
  assert.deepEqual(afterReplace.semanticContract.criteria,
    replaced.state.semanticContract.criteria);
  assert.deepEqual(afterReplace.semanticContract.criteriaTrust,
    replaced.state.semanticContract.criteriaTrust);
  assert.equal(afterReplace.semanticContract.criteriaVersions[0].definitionId, replacementId);
  assert.notEqual(afterReplace.contractDigest, replaced.approvedDigest,
    'swapping the row identity behind identical wording must not resurrect the approval');
  assert.equal(afterReplace.ratified, false);

  // Revoking delegated authority advances the digest rather than merely failing a lookup: the
  // contract a revoked template stood behind is not the contract that is standing now.
  const delegated = await createProject('aba delegation');
  const delegation = await createDelegation({
    ...authoritySpec(delegated.state, { name: undefined }),
    delegateType: 'RUNNER',
    delegateId: 'runner-aba',
    projectId: delegated.projectId,
  });
  const approvedByDelegation = await preapproved(
    delegated.projectId, 'RUNNER', 'runner-aba', 'BOUND_DELEGATION', delegation.id,
    delegated.state.contractDigest, `aba-delegated:${randomUUID()}`,
  );
  assert.equal(approvedByDelegation.ok, true);
  const withDelegation = await state(delegated.projectId);
  assert.equal(withDelegation.ratified, true);
  assert.ok(withDelegation.semanticContract.delegationDigest);
  await pool.query(
    'UPDATE "project_ratification_delegation" SET "revoked_at"=now() WHERE "id"=$1',
    [delegation.id],
  );
  const revoked = await state(delegated.projectId);
  assert.notEqual(revoked.contractDigest, withDelegation.contractDigest,
    'revocation must advance contractDigest, not only fail the authority lookup');
  assert.notEqual(revoked.semanticContract.delegationDigest,
    withDelegation.semanticContract.delegationDigest);
  assert.equal(revoked.ratified, false);
  evidence.invariants.abaProtectionSurvivesTheRecut = true;
});

/**
 * The pre-0216 composition: the live authorization revision inside each group, plus the two
 * digests taken over the live values. A project sitting on one of these is exactly what deployment
 * finds — an approval bound to a digest the current composition no longer produces.
 */
function legacySemanticMaterial(current) {
  const contract = current.semanticContract;
  return {
    ...contract,
    budget: { ...contract.budget, authorizationRevision: '0' },
    permissions: { ...contract.permissions, authorizationRevision: '0' },
    riskBoundary: { ...contract.riskBoundary, authorizationRevision: '0' },
    budgetDigest: current.budgetDigest,
    permissionDigest: current.permissionDigest,
  };
}

async function bindToLegacyComposition(projectId, label) {
  const current = await state(projectId);
  const legacyDigest = digest(`legacy composition:${projectId}:${label}`);
  await pool.query(
    `UPDATE "project_completion_contract"
        SET "contract_digest"=$2, "semantic_material"=$3::jsonb,
            "contract_revision"="contract_revision"+1
      WHERE "project_id"=$1`,
    [projectId, legacyDigest, JSON.stringify(legacySemanticMaterial(current))],
  );
  return { currentDigest: current.contractDigest, legacyDigest };
}

test('re-cutting the digest asks the three standing approvals once and forges none of them', async () => {
  const migration = readFileSync(
    path.join(
      ROOT,
      'src/apiserver/prisma/migrations/0216_project_authority_envelope/migration.sql',
    ),
    'utf8',
  );
  assert.match(migration, /SELECT project_authority_envelope_recut\(\);/,
    'the migration must publish the recut through the same function this test exercises');
  assert.doesNotMatch(migration, /INSERT INTO "project_owner_ratification"/,
    'a migration that writes a ratification is forging a consent nobody gave');

  const affected = [];
  for (const label of ['recut alpha', 'recut beta', 'recut gamma']) {
    const fixture = await ratifiedProject(label);
    const bound = await bindToLegacyComposition(fixture.projectId, label);
    await pool.query(
      `INSERT INTO "project_owner_ratification" (
         "id","project_id","owner_id","contract_digest","evaluation_plan_digest_at_decision",
         "source","ratified_by_type","ratified_by_id","idempotency_key"
       ) VALUES ($1,$2,$3::uuid,$4,$5,'OWNER','OWNER',$6,$7)`,
      [
        randomUUID(), fixture.projectId, ownerId, bound.legacyDigest,
        fixture.approvedState.evaluationPlanDigest, ownerId, `legacy:${fixture.projectId}`,
      ],
    );
    assert.equal(await contractIsRatified(fixture.projectId), true,
      `${label} must be standing on an approval of the superseded composition`);
    affected.push({ ...fixture, ...bound, label });
  }

  // A project the owner was never asked about is not being asked anything new by a re-cut, so the
  // routing its superseded request carried must survive it.
  const dormant = await createProject('recut dormant');
  const dormantRequest = dormant.state.decisionRequest;
  await pool.query(
    `UPDATE "project_owner_decision_request"
        SET "routing_state"='DEFERRED', "routing_reason_code"='OWNER_RATIFICATION_LEGACY_INITIAL_BACKFILL',
            "deferred_at"=now()
      WHERE "id"=$1`,
    [dormantRequest.id],
  );
  const dormantBound = await bindToLegacyComposition(dormant.projectId, 'recut dormant');

  const scope = [...affected.map((entry) => entry.projectId), dormant.projectId];
  const ratificationsBefore = await pool.query(
    'SELECT count(*)::int AS count FROM "project_owner_ratification" WHERE "project_id"=ANY($1)',
    [scope],
  );
  const summary = await jsonCall(
    pool, 'SELECT project_authority_envelope_recut($1::uuid[]) AS result', [scope]);
  assert.equal(summary.contractsChanged, 4);
  assert.equal(summary.ownerDecisionsRequested, 3,
    'exactly the standing approvals the re-cut invalidated');
  assert.equal(summary.routingCarriedForward, 1);

  const ratificationsAfter = await pool.query(
    'SELECT count(*)::int AS count FROM "project_owner_ratification" WHERE "project_id"=ANY($1)',
    [scope],
  );
  assert.equal(ratificationsAfter.rows[0].count, ratificationsBefore.rows[0].count,
    'the re-cut must not write a ratification of any kind');

  for (const entry of affected) {
    const row = await contractRow(entry.projectId);
    assert.equal(row.contractDigest, entry.currentDigest,
      `${entry.label} must republish under the authority-envelope composition`);
    assert.equal(await contractIsRatified(entry.projectId), false,
      `${entry.label} must lose the approval the re-cut invalidated`);
    const pending = await pendingDecisions(entry.projectId);
    assert.equal(pending.length, 1, `${entry.label} must be asked exactly once`);
    assert.equal(pending[0].reasonCode, 'CONTRACT_CHANGED');
    assert.equal(pending[0].previousContractDigest, entry.legacyDigest);
    assert.ok(pending[0].semanticDiff.changedFields.length > 0,
      `${entry.label} must arrive with a non-empty semantic diff`);
    assert.equal(pending[0].routingState, 'ACTIONABLE');
    assert.equal(pending[0].semanticDiff.reason, 'AUTHORITY_ENVELOPE_RECUT');
  }
  evidence.invariants.recutDerivesOneOwnerDecisionAndNoRatification = true;

  const dormantPending = await pendingDecisions(dormant.projectId);
  assert.equal(dormantPending.length, 1);
  assert.notEqual(dormantPending[0].id, dormantRequest.id, 'the superseded request is replaced');
  assert.equal(dormantPending[0].routingState, 'DEFERRED',
    'a re-cut must not promote a dormant backlog into the owner inbox');
  assert.notEqual(dormantBound.legacyDigest, (await contractRow(dormant.projectId)).contractDigest);
  evidence.invariants.recutDoesNotPromoteDeferredBacklog = true;
});

test('a non-owner principal still cannot submit a ratification, at either door', async () => {
  const fixture = await createProject('non-owner principal');
  const current = await state(fixture.projectId);
  for (const actorType of ['AGENT', 'RUNNER', 'SERVICE']) {
    await assert.rejects(
      ownerDecision(fixture.projectId, {
        state: current,
        request: current.decisionRequest,
        actorType,
        actorId: `${actorType.toLowerCase()}-credential`,
        idempotencyKey: `non-owner:${actorType}:${randomUUID()}`,
      }),
      /OWNER_RATIFICATION_ACTOR_FORBIDDEN/,
      `${actorType} must be refused even holding the current request and its CTA token`,
    );
  }
  assert.equal(await ratificationCount(fixture.projectId), 0);
  assert.equal((await state(fixture.projectId)).ratified, false);

  const service = readFileSync(
    path.join(ROOT, 'src/apiserver/src/projects/projects.service.ts'),
    'utf8',
  );
  assert.match(service,
    /dto\.ownerRatification && \(principal\.type !== 'OWNER' \|\| principal\.id !== ownerId\)/,
    'the create door must still refuse a ratification submitted by a non-owner principal');
  assert.match(service, /OWNER_RATIFICATION_ACTOR_FORBIDDEN/);
  evidence.invariants.nonOwnerPrincipalRatificationRefused = true;
});

// ---------------------------------------------------------------------------------------------
// Agent proposes, owner decides.
//
// The lane above is about approving a contract the project already HAS. These are about the act of
// changing what the project counts as done: an agent may state a new acceptance-criteria set, and
// stating it must move nothing. Until the owner answers a rendered card with their own credential,
// the criteria in force, the contract digest and the standing ratification are exactly what they
// were — which is the whole point, because between an agent's write and an owner's answer the old
// code left the project measured by a ruler nobody had approved.

/** Every stored column of every effective definition, so "unchanged" can mean byte-for-byte. */
async function criteriaRows(projectId) {
  const { rows } = await pool.query(
    `SELECT to_jsonb(definition) AS row
       FROM "project_acceptance_criterion_definition" definition
      WHERE definition."project_id" = $1 ORDER BY definition."id"`,
    [projectId],
  );
  return rows.map((row) => row.row);
}

async function proposeCriteria(projectId, proposal, overrides = {}) {
  return jsonCall(
    pool,
    `SELECT project_propose_acceptance_criteria(
       $1::uuid,$2::uuid,$3,$4,$5::jsonb,$6
     ) AS result`,
    [
      ownerId,
      projectId,
      overrides.actorType ?? 'AGENT',
      overrides.actorId ?? 'proposing-agent',
      JSON.stringify(proposal),
      overrides.idempotencyKey ?? `proposal:${projectId}:${randomUUID()}`,
    ],
  );
}

async function proposalState(projectId) {
  return jsonCall(
    pool,
    'SELECT project_criteria_proposal_state_json($1::uuid,$2::uuid) AS result',
    [ownerId, projectId],
  );
}

async function decideProposal(projectId, overrides = {}) {
  const current = overrides.state ?? await proposalState(projectId);
  const proposal = overrides.proposal ?? current.proposal;
  return jsonCall(
    pool,
    `SELECT project_owner_decide_criteria_proposal(
       $1::uuid,$2::uuid,$3,$4,$5::uuid,$6,$7,$8
     ) AS result`,
    [
      ownerId,
      projectId,
      overrides.actorType ?? 'OWNER',
      overrides.actorId ?? ownerId,
      overrides.proposalId === undefined ? proposal?.id ?? null : overrides.proposalId,
      overrides.expectedCardDigest === undefined
        ? proposal?.cardDigest ?? null
        : overrides.expectedCardDigest,
      overrides.decision ?? 'APPROVE',
      overrides.idempotencyKey ?? `owner-proposal:${projectId}:${randomUUID()}`,
    ],
  );
}

/** A task in the project, so a criterion may name VERIFICATION evidence. */
async function evidenceTask(projectId, label) {
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const taskId = randomUUID();
  await pool.query(
    `INSERT INTO "runner" (
       "id","owner_id","name","status","token_hash","capabilities_reported_at"
     ) VALUES ($1,$2,$3,'ONLINE',$4,now())`,
    [runnerId, ownerId, `${label} runner`, `token-${runnerId}`],
  );
  await pool.query(
    `INSERT INTO "workspace" (
       "id","owner_id","name","runner_id","can_create_tasks","can_delegate"
     ) VALUES ($1,$2,$3,$4,true,true)`,
    [workspaceId, ownerId, `${label} workspace`, runnerId],
  );
  await pool.query(
    `INSERT INTO "task" (
       "id","title","status","owner_id","creator_type","creator_id","project_id",
       "assignee_id","updated_at"
     ) VALUES ($1,$2,'OPEN'::"task_status",$3,'USER'::"creator_type",$3,$4,$5,now())`,
    [taskId, `${label} verifier`, ownerId, projectId, workspaceId],
  );
  return taskId;
}

/** The one criterion `createProject` seeds, spelled the way a proposal spells it. */
function retainedCriterion(fixture, overrides = {}) {
  return {
    completionCriterion: 'HUMAN_SIGNOFF',
    definitionId: fixture.definitionId,
    text: fixture.state.semanticContract.criteria[0].text,
    verificationMethod: fixture.state.evaluationPlan.verifiers[0].verificationMethod,
    ...overrides,
  };
}

test('an agent proposal is inert: the criteria in force and their digest do not move', async () => {
  const fixture = await ratifiedProject('proposal inert');
  const before = await criteriaRows(fixture.projectId);
  const beforeState = await state(fixture.projectId);

  const proposed = await proposeCriteria(fixture.projectId, {
    criteria: [retainedCriterion(fixture, { text: 'an agent would rather be measured by this' })],
    whyNotAgent: 'the standard this project is judged by is not the agent to move',
  });
  assert.equal(proposed.ok, true, 'a well-formed proposal is accepted');
  assert.equal(proposed.applied, false);
  assert.equal(proposed.status, 'PENDING');
  assert.equal(proposed.effectiveCriteriaUnchanged, true);
  assert.equal(proposed.reasonCode, 'GOAL_DECISION');
  assert.equal(proposed.baseContractDigest, fixture.approvedDigest);

  // (a) The effective rows are byte-identical, including the revision lanes an edit would move.
  assert.deepEqual(await criteriaRows(fixture.projectId), before,
    'a proposal must not touch one byte of the effective criteria');
  const afterState = await state(fixture.projectId);
  assert.equal(afterState.contractDigest, fixture.approvedDigest,
    'a proposal must not advance contractDigest');
  assert.equal(afterState.contractRevision, beforeState.contractRevision);
  assert.deepEqual(afterState.semanticContract.criteria, beforeState.semanticContract.criteria);
  assert.deepEqual(afterState.semanticContract.criteriaTrust,
    beforeState.semanticContract.criteriaTrust);
  assert.deepEqual(afterState.semanticContract.criteriaVersions,
    beforeState.semanticContract.criteriaVersions);
  evidence.invariants.criteriaProposalDoesNotMoveTheRuler = true;

  // (b) Everything that reads this project still reads the approved set. `contract_digest` and
  // `project_owner_ratification_effective` ARE the canonical DONE gate's ratification inputs
  // (`project_canonical_done_gate`), so a proposal cannot make the gate see an unapproved ruler.
  assert.equal(afterState.ratified, true, 'the standing ratification survives a proposal');
  assert.equal(afterState.decisionRequest, null, 'a proposal raises no ratification question');
  assert.equal(await contractIsRatified(fixture.projectId), true);
  const gateSource = readFileSync(
    path.join(
      ROOT,
      'src/apiserver/prisma/migrations/0197_canonical_obligation_done_gate/migration.sql',
    ),
    'utf8',
  );
  assert.match(gateSource,
    /effective_ratification := contract_digest_value IS NOT NULL\s*\n\s*AND project_owner_ratification_effective\(p_project, contract_digest_value\);/,
    'the DONE gate derives its ratification verdict from exactly the two values asserted above');
  const surface = await proposalState(fixture.projectId);
  assert.equal(surface.currentContractDigest, fixture.approvedDigest);
  assert.equal(surface.ratified, true);
  assert.deepEqual(
    surface.effectiveCriteria.map((item) => item.text),
    beforeState.semanticContract.criteria.map((item) => item.text),
    'the read model shows the criteria in force, not the proposed ones',
  );
  assert.equal(surface.proposal.proposedCriteria[0].text,
    'an agent would rather be measured by this');
  assert.notEqual(surface.proposal.proposedCriteria[0].text, surface.effectiveCriteria[0].text);
  evidence.invariants.criteriaProposalKeepsReadModelOnRatifiedSet = true;
});

test('the card carries the whole owner-decision protocol and a real semantic diff', async () => {
  const fixture = await ratifiedProject('proposal card');
  const verifierTaskId = await evidenceTask(fixture.projectId, 'proposal card');
  const proposed = await proposeCriteria(fixture.projectId, {
    criteria: [
      retainedCriterion(fixture, {
        completionCriterion: 'VERIFICATION',
        evidenceTaskId: verifierTaskId,
        verificationMethod: 'an independent verifier task records a PASS verdict',
      }),
      {
        completionCriterion: 'HUMAN_SIGNOFF',
        text: 'the account owner agrees the rollout plan is acceptable',
        verificationMethod: 'the owner says so in the project thread',
      },
    ],
  });
  assert.equal(proposed.ok, true);
  const surface = await proposalState(fixture.projectId);
  const proposal = surface.proposal;

  // (c) A GOAL_DECISION card with all eight protocol fields actually filled in.
  assert.equal(proposal.reasonCode, 'GOAL_DECISION');
  assert.equal(proposal.kind, 'PROJECT_CRITERIA_PROPOSAL');
  assert.equal(proposal.card.reason, 'GOAL_DECISION');
  assert.ok(proposal.card.whyNotAgent.length > 0, 'whyNotAgent must be stated');
  assert.ok(Array.isArray(proposal.card.options) && proposal.card.options.length === 2,
    'options must offer both answers');
  assert.deepEqual(proposal.card.options.map((option) => option.value), ['APPROVE', 'DENY']);
  assert.ok(proposal.card.options.every((option) => option.label.length > 0));
  assert.ok(proposal.card.impacts.APPROVE.length > 0 && proposal.card.impacts.DENY.length > 0,
    'impacts must say what each answer does');
  assert.ok(proposal.card.recommendation.length > 0, 'recommendation must be stated');
  assert.ok(proposal.card.noActionConsequence.length > 0,
    'noActionConsequence must be stated');
  assert.ok(proposal.card.cost.length > 0, 'cost must be stated');
  assert.ok(proposal.card.deadline.length > 0, 'deadline must be stated');
  assert.ok(proposal.card.resumeBehavior.length > 0, 'resumeBehavior must be stated');
  assert.match(proposal.card.noActionConsequence, /no timeout, retry or resubmission/i,
    'the card must say in words that nothing applies itself');
  evidence.invariants.criteriaProposalCardCarriesOwnerProtocol = true;

  // (d) The diff names WHICH criteria change, HOW, and separately whether each one's
  // completionCriterion and verificationMethod moved.
  const diff = proposal.semanticDiff;
  const changed = diff.changedCriteria;
  assert.equal(diff.counts.modified, 1);
  assert.equal(diff.counts.added, 1);
  assert.equal(diff.counts.removed, 0);
  assert.deepEqual(diff.changedCriterionIds.slice().sort(),
    changed.map((entry) => entry.definitionId).slice().sort(),
    'the diff names exactly the criteria it describes');
  const modified = changed.find((entry) => entry.changeKind === 'MODIFIED');
  const added = changed.find((entry) => entry.changeKind === 'ADDED');
  assert.equal(modified.definitionId, fixture.definitionId,
    'the changed criterion is named by its stable id');
  assert.match(modified.summary, /MODIFIED/, 'the diff says how the criterion changes');
  assert.match(modified.summary, /completionCriterion: HUMAN_SIGNOFF -> VERIFICATION/);
  assert.match(added.summary, /^ADDED criterion the account owner agrees/);
  assert.equal(modified.textChanged, false, 'the wording of the retained criterion is unchanged');
  assert.equal(modified.completionCriterionChanged, true,
    'the diff must say that how completion is proved changed');
  assert.deepEqual(
    { after: modified.completionCriterion.after, before: modified.completionCriterion.before },
    { after: 'VERIFICATION', before: 'HUMAN_SIGNOFF' },
  );
  assert.equal(modified.verificationMethodChanged, true,
    'the diff must say that the verification method changed');
  assert.deepEqual(
    {
      after: modified.verificationMethod.after,
      before: modified.verificationMethod.before,
    },
    {
      after: 'an independent verifier task records a PASS verdict',
      before: fixture.state.evaluationPlan.verifiers[0].verificationMethod,
    },
  );
  assert.equal(diff.completionCriterionChanged, true);
  assert.equal(diff.verificationMethodChanged, true);
  assert.match(proposal.card.impacts.APPROVE, /how completion is PROVED/,
    'the card carries the consequence of a completionCriterion change, not just the diff');
  evidence.invariants.criteriaProposalCardRendersSemanticDiff = true;
});

test('only the owner applies a proposal, and approval applies and ratifies in one transaction',
  async () => {
    const fixture = await ratifiedProject('proposal approval');
    const before = await criteriaRows(fixture.projectId);
    await proposeCriteria(fixture.projectId, {
      criteria: [
        retainedCriterion(fixture, { text: 'the deployed build answers on /healthz' }),
      ],
    });
    const rendered = await proposalState(fixture.projectId);

    // (g) The machine principals are refused at the same door, with the same code, before
    // anything is read or written.
    for (const actorType of ['AGENT', 'RUNNER', 'SERVICE']) {
      await assert.rejects(
        decideProposal(fixture.projectId, {
          state: rendered,
          actorType,
          actorId: `${actorType.toLowerCase()}-credential`,
          idempotencyKey: `forbidden-proposal:${actorType}:${randomUUID()}`,
        }),
        /OWNER_RATIFICATION_ACTOR_FORBIDDEN.*agents and runners cannot ratify/i,
        `${actorType} must not be able to approve a criteria proposal`,
      );
    }
    // An OWNER-shaped claim with somebody else's id is the same refusal: the principal is the
    // credential, not the word in the request.
    await assert.rejects(
      decideProposal(fixture.projectId, {
        state: rendered, actorType: 'OWNER', actorId: randomUUID(),
        idempotencyKey: `forbidden-proposal:substituted:${randomUUID()}`,
      }),
      /OWNER_RATIFICATION_ACTOR_FORBIDDEN/,
    );
    assert.deepEqual(await criteriaRows(fixture.projectId), before,
      'a refused decision writes nothing');
    evidence.invariants.criteriaProposalMachineDecisionRefused = true;

    // (h) Nothing else applies one either. Re-reading, re-proposing under a new key, replaying the
    // same key and letting the stated deadline lapse all leave the proposal pending and inert.
    await pool.query(
      `UPDATE "project_criteria_proposal" SET "expires_at" = now() - INTERVAL '30 days'
        WHERE "id" = $1`,
      [rendered.proposal.id],
    );
    await proposalState(fixture.projectId);
    await state(fixture.projectId);
    const replayed = await proposeCriteria(fixture.projectId, {
      criteria: [retainedCriterion(fixture, { text: 'the deployed build answers on /healthz' })],
    }, { idempotencyKey: `replay:${fixture.projectId}` });
    assert.equal(replayed.ok, true);
    const replayedAgain = await proposeCriteria(fixture.projectId, {
      criteria: [retainedCriterion(fixture, { text: 'the deployed build answers on /healthz' })],
    }, { idempotencyKey: `replay:${fixture.projectId}` });
    assert.equal(replayedAgain.duplicate, true, 'a repeated submission is a replay, not an apply');
    assert.equal(replayedAgain.applied, false);
    const stillPending = await pool.query(
      `SELECT count(*)::int AS count FROM "project_criteria_proposal"
        WHERE "project_id" = $1 AND "status" = 'APPLIED'`,
      [fixture.projectId],
    );
    assert.equal(stillPending.rows[0].count, 0,
      'no elapsed deadline, retry or resubmission may apply a proposal');
    assert.deepEqual(await criteriaRows(fixture.projectId), before);
    assert.equal((await state(fixture.projectId)).contractDigest, fixture.approvedDigest);

    // The schema itself contains no second caller: the apply helper is reached from exactly one
    // place, the OWNER-gated decision, and the proposal table carries no trigger at all.
    const migration = readFileSync(
      path.join(
        ROOT,
        'src/apiserver/prisma/migrations/0217_project_criteria_proposal_card/migration.sql',
      ),
      'utf8',
    );
    assert.equal(
      (migration.match(/CREATE OR REPLACE FUNCTION project_apply_criteria_proposal\(/g) ?? []).length,
      1, 'the apply helper is declared once',
    );
    assert.equal(
      (migration.match(/PERFORM project_apply_criteria_proposal\(/g) ?? []).length, 1,
      'the apply helper is called from exactly one place',
    );
    assert.match(migration,
      /project_owner_decide_criteria_proposal[\s\S]*PERFORM project_apply_criteria_proposal\(p_project, proposal\."proposed_criteria"\);/,
      'that one place is the OWNER-gated decision');
    assert.doesNotMatch(migration, /CREATE\s+(?:CONSTRAINT\s+)?TRIGGER/i,
      'a proposal is applied by a decision, never by a trigger');
    const callers = readdirSync(path.join(ROOT, 'src/apiserver/prisma/migrations'))
      .filter((entry) => {
        const file = path.join(ROOT, 'src/apiserver/prisma/migrations', entry, 'migration.sql');
        return existsSync(file) && /project_apply_criteria_proposal/.test(readFileSync(file, 'utf8'));
      });
    assert.deepEqual(callers, ['0217_project_criteria_proposal_card'],
      'no other migration reaches the apply helper');
    evidence.invariants.criteriaProposalHasNoAutomaticApplyPath = true;

    // (e) The owner's own credential applies it — criteria, contract and ratification together.
    const current = await proposalState(fixture.projectId);
    const approved = await decideProposal(fixture.projectId, { state: current });
    assert.equal(approved.ok, true);
    assert.equal(approved.decision, 'APPROVE');
    assert.equal(approved.status, 'APPLIED');
    assert.equal(approved.atomic, true);
    assert.equal(approved.previousContractDigest, fixture.approvedDigest);
    assert.notEqual(approved.appliedContractDigest, fixture.approvedDigest);
    assert.equal(approved.ratified, true,
      'the contract the approval produced is ratified by the same decision');
    const settled = await state(fixture.projectId);
    assert.equal(settled.contractDigest, approved.appliedContractDigest);
    assert.equal(settled.ratified, true, 'no unratified window is left behind');
    assert.equal(settled.decisionRequest, null,
      'the owner is not asked a second time for the change they just made');
    assert.equal(settled.semanticContract.criteria[0].text,
      'the deployed build answers on /healthz');
    const ratifications = await pool.query(
      `SELECT "source","ratified_by_type","ratified_by_id","contract_digest"::text AS digest
         FROM "project_owner_ratification"
        WHERE "project_id" = $1 AND "contract_digest" = $2`,
      [fixture.projectId, approved.appliedContractDigest],
    );
    assert.equal(ratifications.rows.length, 1);
    assert.deepEqual(
      {
        by: ratifications.rows[0].ratified_by_id,
        source: ratifications.rows[0].source,
        type: ratifications.rows[0].ratified_by_type,
      },
      { by: ownerId, source: 'OWNER', type: 'OWNER' },
    );
    evidence.invariants.ownerApprovalAppliesAndRatifiesAtomically = true;
  });

test('a decision approves the exact rendering it was taken on, or it is refused', async () => {
  const fixture = await ratifiedProject('proposal what you see');
  const before = await criteriaRows(fixture.projectId);
  await proposeCriteria(fixture.projectId, {
    criteria: [retainedCriterion(fixture, { text: 'the first thing the agent proposed' })],
  });
  const firstRender = await proposalState(fixture.projectId);
  const firstProposalId = firstRender.proposal.id;
  const firstCardDigest = firstRender.proposal.cardDigest;

  // The agent changes its mind after the owner has the card open.
  await proposeCriteria(fixture.projectId, {
    criteria: [retainedCriterion(fixture, { text: 'the second thing the agent proposed' })],
  });

  // (f) Answering the card that was rendered fails, and says what replaced it.
  const staleProposal = await decideProposal(fixture.projectId, {
    proposalId: firstProposalId, expectedCardDigest: firstCardDigest,
  });
  assert.equal(staleProposal.ok, false);
  assert.equal(staleProposal.code, 'CRITERIA_PROPOSAL_ALREADY_SETTLED');
  assert.equal(staleProposal.status, 'SUPERSEDED');
  assert.ok(staleProposal.supersededById, 'the refusal names the proposal that replaced it');
  assert.match(staleProposal.requiredAction, /read the current criteria proposal/);

  // Answering the CURRENT proposal with the digest of the previous rendering fails too: the
  // decision has to carry the identity of what was actually shown.
  const secondRender = await proposalState(fixture.projectId);
  const staleDigest = await decideProposal(fixture.projectId, {
    state: secondRender, expectedCardDigest: firstCardDigest,
  });
  assert.equal(staleDigest.ok, false);
  assert.equal(staleDigest.code, 'CRITERIA_PROPOSAL_CARD_STALE');
  assert.equal(staleDigest.currentCardDigest, secondRender.proposal.cardDigest);
  assert.match(staleDigest.requiredAction, /re-read the criteria proposal card/);
  assert.deepEqual(await criteriaRows(fixture.projectId), before,
    'neither refusal applies anything');

  // (k) One proposal stands at a time, and the rule is the schema's rather than the function's:
  // a second pending row cannot be inserted even by direct SQL.
  await assert.rejects(
    pool.query(
      `INSERT INTO "project_criteria_proposal" (
         "id","project_id","owner_id","proposal_generation","base_contract_digest",
         "base_contract_revision","base_criteria","proposed_criteria","semantic_diff","card",
         "card_digest","input_digest","proposed_by_type","proposed_by_id",
         "proposal_idempotency_key","expires_at"
       )
       SELECT gen_random_uuid(), "project_id", "owner_id", "proposal_generation" + 100,
              "base_contract_digest", "base_contract_revision", "base_criteria",
              "proposed_criteria", "semantic_diff", "card", "card_digest", "input_digest",
              "proposed_by_type", "proposed_by_id", 'second-pending', "expires_at"
         FROM "project_criteria_proposal" WHERE "id" = $1`,
      [secondRender.proposal.id],
    ),
    /project_criteria_proposal_one_pending_idx/,
    'two proposals cannot be pending on one project even through direct SQL',
  );

  // The re-render carries a different identity, and answering THAT works.
  assert.notEqual(secondRender.proposal.cardDigest, firstCardDigest);
  const approved = await decideProposal(fixture.projectId, { state: secondRender });
  assert.equal(approved.ok, true);
  assert.equal((await state(fixture.projectId)).semanticContract.criteria[0].text,
    'the second thing the agent proposed');
  evidence.invariants.criteriaProposalApprovesWhatWasShown = true;

  // (k) The proposal the owner never answered is recorded as superseded, with a reason, and is
  // still there to read. One proposal stands at a time; the earlier one does not vanish.
  const history = (await proposalState(fixture.projectId)).history;
  const retired = history.find((entry) => entry.id === firstProposalId);
  assert.equal(retired.status, 'SUPERSEDED');
  assert.equal(retired.decision, null, 'a superseded proposal was never answered');
  assert.equal(retired.supersededById, secondRender.proposal.id);
  assert.match(retired.supersededReason, /at most one acceptance-criteria proposal/);
  const pending = await pool.query(
    `SELECT count(*)::int AS count FROM "project_criteria_proposal"
      WHERE "project_id" = $1 AND "status" = 'PENDING'`,
    [fixture.projectId],
  );
  assert.equal(pending.rows[0].count, 0);
  evidence.invariants.criteriaProposalSupersedesRatherThanCoexists = true;
});

test('denial changes nothing and is recorded as an answer, not a dropped request', async () => {
  const fixture = await ratifiedProject('proposal denial');
  const before = await criteriaRows(fixture.projectId);
  await proposeCriteria(fixture.projectId, {
    criteria: [retainedCriterion(fixture, { text: 'a standard the owner does not want' })],
  });
  const rendered = await proposalState(fixture.projectId);
  const denied = await decideProposal(fixture.projectId, {
    state: rendered, decision: 'DENY',
  });
  assert.equal(denied.ok, true);
  assert.equal(denied.decision, 'DENY');
  assert.equal(denied.status, 'DENIED');
  assert.equal(denied.effectiveCriteriaUnchanged, true);

  // (i) The criteria in force are untouched and the refusal is a durable, readable fact.
  assert.deepEqual(await criteriaRows(fixture.projectId), before);
  const after = await state(fixture.projectId);
  assert.equal(after.contractDigest, fixture.approvedDigest);
  assert.equal(after.ratified, true);
  const stored = await pool.query(
    `SELECT "status","decision","decided_by_type","decided_by_id"
       FROM "project_criteria_proposal" WHERE "id" = $1`,
    [rendered.proposal.id],
  );
  assert.deepEqual(stored.rows, [{
    decided_by_id: ownerId, decided_by_type: 'OWNER', decision: 'DENY', status: 'DENIED',
  }], 'a denied proposal is kept and attributed, not deleted');
  const surface = await proposalState(fixture.projectId);
  assert.equal(surface.proposal, null, 'nothing is awaiting the owner any more');
  assert.equal(surface.history.find((entry) => entry.id === rendered.proposal.id).decision,
    'DENY');
  evidence.invariants.criteriaProposalDenialIsRecordedNotDropped = true;
});

test('approving a proposal that undoes an earlier one does not revive the earlier approval',
  async () => {
    const fixture = await ratifiedProject('proposal aba');
    const originalText = fixture.state.semanticContract.criteria[0].text;
    const originalDigest = fixture.approvedDigest;
    const originalVersion =
      fixture.state.semanticContract.criteriaVersions[0].semanticRevision;

    await proposeCriteria(fixture.projectId, {
      criteria: [retainedCriterion(fixture, { text: 'briefly something else' })],
    });
    const away = await decideProposal(fixture.projectId);
    assert.equal(away.ok, true);
    assert.notEqual(away.appliedContractDigest, originalDigest);

    await proposeCriteria(fixture.projectId, {
      criteria: [retainedCriterion(fixture, { text: originalText })],
    });
    const back = await decideProposal(fixture.projectId);
    assert.equal(back.ok, true);

    // (j) The wording is identical again and the digest is not: `criteriaVersions` still carries
    // the semantic revision, so the first approval cannot be the one in force.
    const settled = await state(fixture.projectId);
    assert.equal(settled.semanticContract.criteria[0].text, originalText);
    assert.notEqual(settled.contractDigest, originalDigest,
      'proposing a revert must not land back on the first approved digest');
    assert.equal(settled.contractDigest, back.appliedContractDigest);
    assert.ok(settled.semanticContract.criteriaVersions[0].semanticRevision > originalVersion + 1,
      'each applied proposal advances the semantic revision');
    const approvals = await pool.query(
      `SELECT count(*)::int AS count FROM "project_owner_ratification"
        WHERE "project_id" = $1 AND "contract_digest" = $2`,
      [fixture.projectId, originalDigest],
    );
    assert.equal(approvals.rows[0].count, 1,
      'the original approval is still exactly one historical fact, not a live one');
    evidence.invariants.criteriaProposalAbaProtectionSurvivesRevert = true;
  });

test('the agent door proposes and the web app has no direct criteria editor', async () => {
  // The runner door no longer forwards `acceptanceCriteriaItems` into the write path: it routes
  // them into a proposal and says so in its response.
  const runner = readFileSync(
    path.join(ROOT, 'src/apiserver/src/runner-api/runner-projects.controller.ts'),
    'utf8',
  );
  assert.match(runner,
    /async updateProject\([\s\S]*const \{ acceptanceCriteriaItems, \.\.\.rest \} = dto;[\s\S]*this\.acceptance\.proposeCriteriaChange\(/,
    'a runner PATCH carrying acceptance criteria must become a proposal, not a write');
  assert.doesNotMatch(runner,
    /async updateProject\([\s\S]*this\.projects\.update\(runner\.ownerId, id, dto,/,
    'the whole body, acceptance criteria included, must not reach the project write path');
  assert.match(runner, /@Post\('projects\/:id\/acceptance\/criteria-proposals'\)/,
    'the agent has a door of its own onto the proposal channel');
  const service = readFileSync(
    path.join(ROOT, 'src/apiserver/src/projects/project-acceptance.service.ts'),
    'utf8',
  );
  assert.match(service, /project_propose_acceptance_criteria/);
  assert.match(service, /project_owner_decide_criteria_proposal/);
  assert.match(service,
    /async decideCriteriaProposal[\s\S]*actor\.actorType !== 'USER'[\s\S]*OWNER_RATIFICATION_ACTOR_FORBIDDEN/,
    'the owner decision is refused for every non-user principal before it reaches PostgreSQL');
  const controller = readFileSync(
    path.join(ROOT, 'src/apiserver/src/projects/projects.controller.ts'),
    'utf8',
  );
  assert.match(controller, /criteria-proposal/,
    'the owner decides through their own authenticated connection');

  // The product rule: people drive agents, they do not edit the ruler by hand. Three guards, so
  // an editor cannot be reintroduced by routing around any one of them: the structured authoring
  // field exists in the web only as a READ type, no request the web builds carries acceptance
  // criteria at all, and the project-scoped writes it makes are an enumerated set that contains
  // neither `POST /projects` nor `PATCH /projects/:id` — the only two routes that can restate a
  // project's criteria. Creating a project and ratifying it in one owner request is a different
  // act and is deliberately untouched.
  const webSources = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      webSources.push({ path: path.relative(ROOT, full), source: readFileSync(full, 'utf8') });
    }
  };
  walk(path.join(ROOT, 'src/web/src'));
  assert.ok(webSources.length > 50, 'the web scan must actually have read the app');

  for (const file of webSources) {
    for (const line of file.source.split('\n')) {
      if (!line.includes('acceptanceCriteriaItems')) continue;
      assert.match(line, /acceptanceCriteriaItems\?:/,
        `${file.path} may only READ acceptanceCriteriaItems, never author it`);
    }
  }

  /** Each `api(...)` invocation's arguments, sliced on balanced parentheses. */
  const apiCalls = (source) => {
    const calls = [];
    const opening = /\bapi(?:<[\s\S]*?>)?\(/g;
    let match;
    while ((match = opening.exec(source))) {
      let depth = 1;
      let index = opening.lastIndex;
      while (index < source.length && depth > 0) {
        if (source[index] === '(') depth += 1;
        else if (source[index] === ')') depth -= 1;
        index += 1;
      }
      calls.push(source.slice(opening.lastIndex, index - 1));
    }
    return calls;
  };
  // Path builders are followed, so a write cannot hide behind a helper: `foo(projectId)` is
  // resolved to the template `foo` returns, transitively.
  const builders = new Map();
  for (const file of webSources) {
    for (const match of file.source.matchAll(
      /export function ([A-Za-z0-9_]+)\([^)]*\): string \{\s*return ([^;]+);/g,
    )) builders.set(match[1], match[2].trim());
  }
  const resolveUrl = (expression, hops = 0) => {
    const literal = expression.match(/^[`'"](.*)[`'"]$/s);
    if (literal) return literal[1];
    const call = expression.match(/^([A-Za-z0-9_]+)\(/);
    if (!call || hops > 3 || !builders.has(call[1])) return expression;
    const body = builders.get(call[1]);
    const template = body.match(/^`(.*)`$/s);
    if (!template) return resolveUrl(body, hops + 1);
    return template[1].replace(/\$\{([A-Za-z0-9_]+)\([^)]*\)\}/g, (whole, name) =>
      (builders.has(name) ? resolveUrl(`${name}()`, hops + 1) : whole));
  };
  const projectWrites = [];
  for (const file of webSources) {
    for (const call of apiCalls(file.source)) {
      assert.doesNotMatch(call, /acceptanceCriteria/,
        `${file.path} must not send acceptance criteria in any request`);
      const url = resolveUrl(call.split(/,(?![^{[(]*[}\])])/)[0].trim());
      if (!url.startsWith('/projects')) continue;
      const method = call.match(/method:\s*'([A-Z]+)'/)?.[1] ?? 'GET';
      if (method === 'GET') continue;
      projectWrites.push(`${method} ${url}`.replace(/\$\{[^}]*\}/g, ':id'));
    }
  }
  assert.deepEqual([...new Set(projectWrites)].sort(), [
    'POST /projects/:id/acceptance/runs/:id/verdict',
    'POST /projects/:id/coordinator',
    'POST /projects/:id/coordinator/rebind',
    'POST /projects/:id/criteria-proposal/decision',
    'POST /projects/:id/handoffs/:id/decision',
    'POST /projects/:id/ratification',
    'POST /projects/:id/reopen',
  ], 'the web app writes to a project only through these routes: no POST /projects and no '
   + 'PATCH /projects/:id, which are the only two that can restate a project\'s criteria');

  const card = readFileSync(
    path.join(ROOT, 'src/web/src/components/ProjectCriteriaProposalCard.tsx'), 'utf8',
  );
  for (const field of [
    'whyNotAgent', 'options', 'impacts', 'recommendation', 'noActionConsequence',
    'cost', 'deadline', 'resumeBehavior',
  ]) {
    assert.ok(card.includes(field), `the owner's card must render ${field}`);
  }
  assert.match(card, /completionCriterionChanged/,
    'the card must show whether how completion is proved changed');
  assert.match(card, /verificationMethodChanged/,
    'the card must show whether the verification method changed');
  assert.match(card, /expectedCardDigest: proposal\.cardDigest/,
    'the decision must carry the digest of the rendering it was taken on');
  assert.match(readFileSync(path.join(ROOT, 'src/apiserver/src/projects/projects.service.ts'), 'utf8'),
    /atomicCreate/,
    'creating a project and ratifying it in one owner request is preserved');
  evidence.invariants.criteriaEditingHasNoWebEntryPoint = true;
});
