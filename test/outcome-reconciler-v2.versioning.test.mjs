import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const MODULE_PATH = process.env.OUTCOME_VERSIONING_MODULE;
const URL = process.env.OUTCOME_VERSIONING_PG_URL;
const EXPECTED_DATABASE = process.env.OUTCOME_VERSIONING_PG_EXPECTED_DATABASE;
const EXPECTED_USER = process.env.OUTCOME_VERSIONING_PG_EXPECTED_USER;
const EXPECTED_SYSTEM_IDENTIFIER = process.env.OUTCOME_VERSIONING_PG_EXPECTED_SYSTEM_IDENTIFIER;
const EVIDENCE_PATH = process.env.OUTCOME_VERSIONING_EVIDENCE_PATH;

assert.ok(MODULE_PATH, 'OUTCOME_VERSIONING_MODULE is required');
assert.ok(URL, 'OUTCOME_VERSIONING_PG_URL is required; PostgreSQL absence is a hard failure');
assert.ok(EXPECTED_DATABASE, 'OUTCOME_VERSIONING_PG_EXPECTED_DATABASE is required');
assert.ok(EXPECTED_USER, 'OUTCOME_VERSIONING_PG_EXPECTED_USER is required');
assert.ok(EXPECTED_SYSTEM_IDENTIFIER, 'OUTCOME_VERSIONING_PG_EXPECTED_SYSTEM_IDENTIFIER is required');
assert.ok(EVIDENCE_PATH, 'OUTCOME_VERSIONING_EVIDENCE_PATH is required');

const {
  OUTCOME_DIMENSIONS,
  evaluateCanonicalOutcome,
  outcomeDigest,
  outcomeEvaluatorDigest,
} = await import(pathToFileURL(path.resolve(MODULE_PATH)).href);

const pool = new Pool({ connectionString: URL, max: 32 });
const ownerId = randomUUID();
const bindingCases = [
  ['contractDigest', 'CONTRACT_CHANGED', false],
  ['evaluationPlanDigest', 'CRITERIA_CHANGED', true],
  ['policyDigest', 'POLICY_CHANGED', true],
  ['riskPolicyDigest', 'RISK_POLICY_CHANGED', false],
  ['permissionDigest', 'PERMISSION_CHANGED', false],
  ['authorityGrantDigest', 'AUTHORITY_CHANGED', true],
  ['budgetDigest', 'BUDGET_CHANGED', false],
  ['capabilityRegistryDigest', 'CAPABILITY_REGISTRY_CHANGED', true],
  ['recipientDigest', 'RECIPIENT_CHANGED', false],
  ['evaluatorDigest', 'EVALUATOR_CHANGED', true],
  ['factSchemaDigest', 'FACT_SCHEMA_CHANGED', true],
  ['environmentDigest', 'ENVIRONMENT_CHANGED', true],
  ['artifactDigest', 'ARTIFACT_CHANGED', true],
  ['targetDigest', 'TARGET_CHANGED', true],
  ['targetRef', 'TARGET_CHANGED', true],
  ['asOfLogicalTime', 'AS_OF_ADVANCED', true],
  ['factCutDigest', 'AS_OF_ADVANCED', true],
];

const evidence = {
  schemaVersion: 1,
  suite: 'outcome-reconciler-v2-binding-versioning',
  postgres: { required: true, connected: false, version: null, systemIdentifier: null },
  dimensions: Object.fromEntries(bindingCases.map(([field]) => [field, false])),
  invariants: {
    everyBindingFieldInvalidates: false,
    oldProofRetainedButIneligible: false,
    evaluationPlanLaneIsIndependent: false,
    semanticChangeAdvancesTheContract: false,
    oldActionIntentRejected: false,
    zeroSuccessorDecided: false,
    multipleSuccessorsAllowed: false,
    noDuplicateConcurrentSuccessor: false,
    lateMatchingContradictionReevaluated: false,
    staleEvidenceRejected: false,
    authorityRevocationReevaluated: false,
    recipientAndBudgetVersioned: false,
    registryAndEvaluatorVersioned: false,
    semanticEpochAbaPrevented: false,
    noFalseClose: false,
    noForeverPendingRequest: false,
  },
  races: {
    bindingChangeVsOldAction: false,
    concurrentDoubleSuccessor: false,
    lateContradictionVsClosedProof: false,
    authorityRevokeVsAction: false,
  },
  samples: {},
};

function digest(label) {
  return createHash('sha256').update(label).digest('hex');
}

function clone(value) {
  return structuredClone(value);
}

async function jsonCall(client, text, values) {
  const result = await client.query({ text, values });
  return result.rows[0].result;
}

after(async () => {
  await pool.end();
  mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
});

before(async () => {
  await pool.query(
    `INSERT INTO "user" ("id","email","name","password_hash")
     VALUES ($1,$2,'versioning owner','x')`,
    [ownerId, `versioning-${ownerId}@example.test`],
  );
});

async function contractState(projectId, client = pool) {
  await client.query({
    text: 'SELECT project_refresh_completion_contract($1::uuid,$2) AS result',
    values: [projectId, 'VERSIONING_READ'],
  });
  return (await client.query({
    text: `SELECT "contract_digest"::text AS "contractDigest",
                  "contract_revision"::text AS "contractRevision",
                  "evaluation_plan_digest"::text AS "evaluationPlanDigest",
                  "risk_policy_digest"::text AS "riskPolicyDigest",
                  "permission_digest"::text AS "permissionDigest",
                  "budget_digest"::text AS "budgetDigest",
                  "recipient_digest"::text AS "recipientDigest"
             FROM "project_completion_contract" WHERE "project_id" = $1::uuid`,
    values: [projectId],
  })).rows[0];
}

async function createProject(label) {
  const projectId = randomUUID();
  const definitionId = randomUUID();
  const criterionText = `${label} outcome is current and complete`;
  await pool.query(
    `INSERT INTO "project" (
       "id","owner_id","title","goal","coordinator_enabled","automation_policy",
       "max_concurrent_tasks","session_budget_per_day","updated_at"
     ) VALUES ($1,$2,$3,$4,true,'GUARDED_AUTO'::"project_automation_policy",3,100,now())`,
    [projectId, ownerId, `${label} project`, `${label} exact owner goal`],
  );
  await pool.query(
    `INSERT INTO "project_acceptance_criterion_definition" (
       "id","project_id","ordinal","text","verification_method","completion_criterion",
       "content_hash"
     ) VALUES ($1,$2,1,$3,$4,'HUMAN_SIGNOFF'::"task_completion_criterion",$5)`,
    [definitionId, projectId, criterionText, `verify ${label} evidence`, digest(`placeholder:${definitionId}`)],
  );
  return { projectId, definitionId, criterionText, state: await contractState(projectId) };
}

async function registerGrant(project, label) {
  const grantId = randomUUID();
  return {
    grantId,
    authority: await jsonCall(
      pool,
      `SELECT outcome_register_authority_grant(
        $1::uuid,$2::uuid,$3::uuid,'SYSTEM',$4,'DIMENSION_EVALUATED','ATTESTATION',
        'OUTCOME_EVALUATOR',$5,'versioning-v1',NULL,0,NULL,$6
      ) AS result`,
      [
        ownerId,
        project.projectId,
        grantId,
        `system:${label}`,
        `collector:${label}`,
        project.state.riskPolicyDigest,
      ],
    ),
    principalId: `system:${label}`,
    collectorId: `collector:${label}`,
  };
}

function makeBinding(project, grant, label, overrides = {}) {
  const evaluatorVersion = overrides.evaluatorVersion ?? 'outcome-reducer-v2';
  const bindingOverrides = { ...overrides };
  delete bindingOverrides.evaluatorVersion;
  return {
    tenantId: ownerId,
    projectId: project.projectId,
    subjectType: 'PROJECT',
    subjectId: project.projectId,
    goalId: `goal:${project.projectId}`,
    goalRevision: '1',
    contractDigest: project.state.contractDigest,
    evaluationPlanDigest: project.state.evaluationPlanDigest,
    policyDigest: digest(`policy:${label}`),
    riskPolicyDigest: project.state.riskPolicyDigest,
    permissionDigest: project.state.permissionDigest,
    authorityGrantDigest: grant.authority.grantDigest,
    budgetDigest: project.state.budgetDigest,
    capabilityRegistryDigest: digest(`registry:${label}`),
    recipientDigest: project.state.recipientDigest,
    evaluatorDigest: outcomeEvaluatorDigest(evaluatorVersion),
    factSchemaDigest: digest(`schema:${label}`),
    environmentDigest: digest(`environment:${label}`),
    artifactDigest: digest(`artifact:${label}`),
    targetDigest: digest(`target:${label}`),
    targetRef: 'refs/heads/main',
    asOfLogicalTime: '0',
    factCutDigest: digest(`prospective-cut:${label}`),
    ...bindingOverrides,
  };
}

function makeGoal(binding, ratified = true, overrides = {}) {
  return {
    goalId: binding.goalId,
    goalRevision: binding.goalRevision,
    tenantId: binding.tenantId,
    projectId: binding.projectId,
    statement: 'Reach the exact versioned outcome.',
    contractDigest: binding.contractDigest,
    evaluationPlanDigest: binding.evaluationPlanDigest,
    ratification: {
      status: ratified ? 'RATIFIED' : 'STALE',
      ratifierType: 'OWNER',
      ratifierId: ownerId,
      contractDigest: binding.contractDigest,
      factId: randomUUID(),
    },
    disposition: 'ACHIEVED',
    ...overrides,
  };
}

async function registerBinding(binding) {
  return jsonCall(
    pool,
    'SELECT outcome_register_fact_binding($1::uuid,$2::uuid,$3::jsonb) AS result',
    [ownerId, binding.projectId, JSON.stringify(binding)],
  );
}

async function appendDimension(scope, dimensionId, state, key, extras = {}) {
  const payload = {
    dimensionId,
    state,
    applicabilityProofDigest: state === 'NOT_APPLICABLE' ? digest(`na:${key}`) : null,
    reasonCode: `${key}:${state}`,
    ...extras.payload,
  };
  const draft = {
    factKind: 'DIMENSION_EVALUATED',
    tenantId: ownerId,
    subject: { type: 'PROJECT', id: scope.project.projectId, projectId: scope.project.projectId },
    binding: scope.binding,
    schemaVersion: 2,
    schemaDigest: scope.binding.factSchemaDigest,
    payload,
    payloadDigest: outcomeDigest(payload),
    claimType: 'ATTESTATION',
    principal: { type: 'SYSTEM', id: scope.grant.principalId },
    authority: scope.grant.authority,
    observedAt: extras.observedAt ?? '2026-08-28T00:00:00.000Z',
    causalPredecessorFactId: extras.causalPredecessorFactId ?? null,
    idempotencyKey: key,
    source: {
      system: 'OUTCOME_EVALUATOR',
      collectorId: scope.grant.collectorId,
      collectorVersion: 'versioning-v1',
    },
    signature: null,
  };
  return jsonCall(
    pool,
    `SELECT outcome_ingest_canonical_fact($1::uuid,'SYSTEM',$2,$3::jsonb) AS result`,
    [ownerId, scope.grant.principalId, JSON.stringify(draft)],
  );
}

async function appendDimensions(scope, prefix, overrides = {}) {
  const facts = [];
  for (const [index, dimension] of OUTCOME_DIMENSIONS.entries()) {
    facts.push(await appendDimension(
      scope,
      dimension.id,
      overrides[dimension.id] ?? 'SATISFIED',
      `${prefix}:${index}:${dimension.id}`,
    ));
  }
  return facts;
}

async function sealCut(scope, key) {
  return jsonCall(
    pool,
    'SELECT outcome_seal_evaluation_cut($1::uuid,$2::uuid,$3,$4,$5) AS result',
    [ownerId, scope.project.projectId, scope.bindingDigest, key, 'versioning-v1'],
  );
}

async function evaluateCut(scope, cut, options = {}) {
  const rows = await pool.query({
    text: `SELECT cut_fact.trust_decision AS "trustDecision",
                  cut_fact.proof_eligible AS "proofEligible", fact.envelope
             FROM outcome_evaluation_cut_fact cut_fact
             JOIN outcome_canonical_fact fact
               ON fact.tenant_id=cut_fact.tenant_id AND fact.project_id=cut_fact.project_id
              AND fact.fact_id=cut_fact.fact_id
            WHERE cut_fact.tenant_id=$1::uuid AND cut_fact.project_id=$2::uuid
              AND cut_fact.cut_id=$3::uuid ORDER BY cut_fact.ordinal`,
    values: [ownerId, scope.project.projectId, cut.cutId],
  });
  return evaluateCanonicalOutcome({
    binding: scope.binding,
    goal: makeGoal(scope.binding, options.ratified ?? true, options.goalOverrides),
    factCut: cut,
    facts: rows.rows,
    clock: {
      logicalNow: cut.watermarkLogicalTime,
      clockId: 'versioning-logical-clock',
      evaluatedThroughLogicalTime: cut.watermarkLogicalTime,
    },
    evaluatorVersion: options.evaluatorVersion ?? scope.evaluatorVersion ?? 'outcome-reducer-v2',
  });
}

async function commitEvaluation(scope, cut, evaluation, client = pool) {
  return jsonCall(
    client,
    `SELECT outcome_commit_evaluation(
       $1::uuid,$2::uuid,'PROJECT',$2::text,$3::uuid,$4,$5::bigint,$6,$7,$8::jsonb
     ) AS result`,
    [
      ownerId,
      scope.project.projectId,
      cut.cutId,
      scope.bindingDigest,
      cut.watermarkLogicalTime,
      evaluation.evaluatorVersion,
      evaluation.evaluatorDigest,
      JSON.stringify(evaluation),
    ],
  );
}

async function submitAction(scope, key) {
  const state = await contractState(scope.project.projectId);
  return jsonCall(
    pool,
    `SELECT project_submit_ratified_action(
       $1::uuid,$2::uuid,'RUNNER',$3,'AUTO',$4::jsonb,$5
     ) AS result`,
    [
      ownerId,
      scope.project.projectId,
      `runner:${scope.project.projectId}`,
      JSON.stringify({
        effectClass: 'EXTERNAL_REVERSIBLE',
        budgetCharge: 1,
        bindingDigest: scope.bindingDigest,
        contractDigest: state.contractDigest,
        evaluationPlanDigest: state.evaluationPlanDigest,
        riskPolicyDigest: state.riskPolicyDigest,
        permissionDigest: state.permissionDigest,
        budgetDigest: state.budgetDigest,
        recipientDigest: state.recipientDigest,
        operation: 'version-bound test action',
      }),
      key,
    ],
  );
}

async function commitAction(projectId, intent) {
  return jsonCall(
    pool,
    'SELECT project_commit_ratified_action($1::uuid,$2::uuid,$3::uuid,$4::uuid) AS result',
    [ownerId, projectId, intent.intentId, intent.commitToken],
  );
}

async function setupScope(label, options = {}) {
  const project = await createProject(label);
  const grant = await registerGrant(project, label);
  const binding = makeBinding(project, grant, label);
  const registered = await registerBinding(binding);
  const scope = {
    project,
    grant,
    binding,
    bindingDigest: registered.bindingDigest,
    evaluatorVersion: 'outcome-reducer-v2',
  };
  let facts = [];
  if (!options.empty) {
    facts = await appendDimensions(scope, `${label}:initial`, options.closed ? {} : {
      CRITERIA_EVALUATION: 'UNSATISFIED',
    });
  }
  const cut = await sealCut(scope, `${label}:initial-cut`);
  const evaluation = await evaluateCut(scope, cut);
  if (options.closed) assert.equal(evaluation.closed, true);
  const committed = await commitEvaluation(scope, cut, evaluation);
  const action = options.action === false ? null : await submitAction(scope, `${label}:action`);
  if (action) assert.equal(action.ok, true);
  return { ...scope, facts, cut, evaluation, committed, action };
}

function replacementValue(field, label) {
  if (field === 'targetRef') return `refs/heads/version-${label}`;
  if (field === 'asOfLogicalTime') return '1';
  if (field === 'evaluatorDigest') return outcomeEvaluatorDigest('outcome-reducer-v3');
  return digest(`replacement:${field}:${label}`);
}

async function assertNoPending(projectId) {
  const pending = await pool.query(
    `SELECT count(*)::int AS count FROM outcome_reconcile_request
      WHERE tenant_id=$1::uuid AND project_id=$2::uuid AND status='PENDING'`,
    [ownerId, projectId],
  );
  assert.equal(pending.rows[0].count, 0);
}

test('requires isolated PostgreSQL 16 and installs the versioning ledger', async () => {
  const result = await pool.query(`SELECT current_database() AS database, current_user AS role,
    (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
    current_setting('server_version') AS version,
    to_regclass('outcome_obligation_successor')::text AS successor_table`);
  const server = result.rows[0];
  assert.equal(server.database, EXPECTED_DATABASE);
  assert.equal(server.role, EXPECTED_USER);
  assert.equal(server.system_identifier, EXPECTED_SYSTEM_IDENTIFIER);
  assert.match(server.version, /^1[6-9]\./);
  assert.equal(server.successor_table, 'outcome_obligation_successor');
  evidence.postgres = {
    required: true,
    connected: true,
    version: server.version.split(' ')[0],
    systemIdentifier: server.system_identifier,
  };
});

test('every semantic binding field atomically obsoletes proof, obligation and action intent', async () => {
  for (const [field, invalidator, ownerDecisionCarries] of bindingCases) {
    const label = `dimension-${field}`;
    const scope = await setupScope(label);
    const oldEvaluationId = scope.committed.evaluationId;
    const oldObligation = scope.evaluation.activeMandatoryObligations.find(
      (entry) => entry.blocksClosureOf.includes('CRITERIA_EVALUATION'),
    );
    assert.ok(oldObligation, `${field} fixture lacks its old criterion obligation`);

    const replacement = clone(scope.binding);
    replacement[field] = replacementValue(field, label);
    const version = field === 'evaluatorDigest' ? 'outcome-reducer-v3' : 'outcome-reducer-v2';
    const registered = await registerBinding(replacement);
    scope.binding = replacement;
    scope.bindingDigest = registered.bindingDigest;
    scope.evaluatorVersion = version;

    const boundary = await pool.query({
      text: `SELECT result.is_current, result.effective_closed,
                    request.status AS request_status, request.requires_reconcile,
                    (SELECT count(*)::int FROM outcome_active_obligation active
                      WHERE active.tenant_id=$1::uuid AND active.project_id=$2::uuid) AS active_count
               FROM outcome_current_evaluator_result result
               JOIN outcome_current_reconcile_request request
                 ON request.tenant_id=result.tenant_id AND request.project_id=result.project_id
              WHERE result.tenant_id=$1::uuid AND result.project_id=$2::uuid`,
      values: [ownerId, scope.project.projectId],
    });
    assert.deepEqual(boundary.rows[0], {
      is_current: false,
      effective_closed: false,
      request_status: 'PENDING',
      requires_reconcile: true,
      active_count: 0,
    });

    const transition = await pool.query({
      text: `SELECT changed_fields, invalidators FROM outcome_binding_transition
              WHERE tenant_id=$1::uuid AND project_id=$2::uuid AND to_binding_digest=$3`,
      values: [ownerId, scope.project.projectId, scope.bindingDigest],
    });
    assert.ok(transition.rows[0].changed_fields.includes(field));
    assert.ok(transition.rows[0].invalidators.includes(invalidator));

    const proof = await pool.query(
      `SELECT reason_code FROM outcome_proof_obsolescence WHERE evaluation_id=$1::uuid`,
      [oldEvaluationId],
    );
    assert.deepEqual(proof.rows[0], { reason_code: 'BINDING_OBSOLETE' });
    const staleAction = await commitAction(scope.project.projectId, scope.action);
    assert.equal(staleAction.ok, false);
    assert.match(staleAction.code, /^RATIFIED_ACTION_(BINDING|AUTHORITY)_STALE$/);

    const cut = await sealCut(scope, `${label}:replacement-cut`);
    const evaluation = await evaluateCut(scope, cut, {
      evaluatorVersion: version,
      ratified: ownerDecisionCarries,
    });
    assert.equal(evaluation.closed, false);
    const committed = await commitEvaluation(scope, cut, evaluation);
    assert.equal(committed.bindingDigest, scope.bindingDigest);
    const successor = await pool.query({
      text: `SELECT successor_count FROM outcome_obligation_successor_set
              WHERE tenant_id=$1::uuid AND project_id=$2::uuid
                AND predecessor_obligation_revision=$3`,
      values: [ownerId, scope.project.projectId, oldObligation.obligationRevision],
    });
    assert.ok(successor.rows[0].successor_count >= 1);
    await assertNoPending(scope.project.projectId);
    evidence.dimensions[field] = true;
  }

  evidence.invariants.everyBindingFieldInvalidates = Object.values(evidence.dimensions).every(Boolean);
  evidence.invariants.oldProofRetainedButIneligible = true;
  evidence.invariants.oldActionIntentRejected = true;
  evidence.invariants.recipientAndBudgetVersioned = true;
  evidence.invariants.registryAndEvaluatorVersioned = true;
  evidence.races.bindingChangeVsOldAction = true;
});

test('a new reduction decides an explicit zero-successor set', async () => {
  const scope = await setupScope('zero-successor');
  const predecessor = scope.evaluation.activeMandatoryObligations.find(
    (entry) => entry.blocksClosureOf.includes('CRITERIA_EVALUATION'),
  );
  assert.ok(predecessor);
  scope.binding = { ...scope.binding, artifactDigest: digest('zero-successor:new-artifact') };
  const registered = await registerBinding(scope.binding);
  scope.bindingDigest = registered.bindingDigest;
  await appendDimensions(scope, 'zero-successor:replacement');
  const cut = await sealCut(scope, 'zero-successor:replacement-cut');
  const evaluation = await evaluateCut(scope, cut);
  assert.equal(evaluation.closed, true);
  await commitEvaluation(scope, cut, evaluation);
  const successor = await pool.query({
    text: `SELECT successor_count FROM outcome_obligation_successor_set
            WHERE tenant_id=$1::uuid AND project_id=$2::uuid
              AND predecessor_obligation_revision=$3`,
    values: [ownerId, scope.project.projectId, predecessor.obligationRevision],
  });
  assert.deepEqual(successor.rows[0], { successor_count: 0 });
  await assertNoPending(scope.project.projectId);
  evidence.invariants.zeroSuccessorDecided = true;
});

test('one obsolete revision may have multiple contract-derived successors and concurrent commits do not duplicate them', async () => {
  const scope = await setupScope('multiple-successor', { empty: true, action: false });
  const predecessor = scope.evaluation.activeMandatoryObligations.find(
    (entry) => entry.kind === 'DIAGNOSE_MODEL_GAP',
  );
  assert.ok(predecessor);
  scope.binding = { ...scope.binding, environmentDigest: digest('multiple-successor:new-environment') };
  const registered = await registerBinding(scope.binding);
  scope.bindingDigest = registered.bindingDigest;
  const cut = await sealCut(scope, 'multiple-successor:replacement-cut');
  const evaluation = await evaluateCut(scope, cut);
  const receipts = await Promise.all([
    commitEvaluation(scope, cut, clone(evaluation)),
    commitEvaluation(scope, cut, clone(evaluation)),
  ]);
  assert.equal(receipts.filter((receipt) => receipt.replayed).length, 1);
  const successor = await pool.query({
    text: `SELECT successor_count FROM outcome_obligation_successor_set
            WHERE tenant_id=$1::uuid AND project_id=$2::uuid
              AND predecessor_obligation_revision=$3`,
    values: [ownerId, scope.project.projectId, predecessor.obligationRevision],
  });
  assert.ok(successor.rows[0].successor_count > 1);
  const duplicates = await pool.query({
    text: `SELECT count(*)::int AS total,
                  count(DISTINCT successor_obligation_revision)::int AS distinct_total
             FROM outcome_obligation_successor WHERE tenant_id=$1::uuid AND project_id=$2::uuid
              AND predecessor_obligation_revision=$3`,
    values: [ownerId, scope.project.projectId, predecessor.obligationRevision],
  });
  assert.equal(duplicates.rows[0].total, duplicates.rows[0].distinct_total);
  await assertNoPending(scope.project.projectId);
  evidence.invariants.multipleSuccessorsAllowed = true;
  evidence.invariants.noDuplicateConcurrentSuccessor = true;
  evidence.races.concurrentDoubleSuccessor = true;
  evidence.samples.multipleSuccessorCount = successor.rows[0].successor_count;
});

test('a late matching contradiction invalidates a closed proof and is reduced to CONFLICT', async () => {
  const scope = await setupScope('late-contradiction', { closed: true });
  const oldEvaluationId = scope.committed.evaluationId;
  const criterion = scope.facts.find(
    (fact) => fact.payload.dimensionId === 'CRITERIA_EVALUATION',
  );
  const late = await appendDimension(
    scope,
    'CRITERIA_EVALUATION',
    'UNSATISFIED',
    'late-contradiction:fact',
    {
      observedAt: '2026-08-27T23:59:00.000Z',
      payload: { contradictsFactId: criterion.factId },
    },
  );
  assert.ok(late.factId);
  const stale = await pool.query({
    text: `SELECT is_current, effective_closed FROM outcome_current_evaluator_result
            WHERE tenant_id=$1::uuid AND project_id=$2::uuid`,
    values: [ownerId, scope.project.projectId],
  });
  assert.deepEqual(stale.rows[0], { is_current: false, effective_closed: false });
  const staleAction = await commitAction(scope.project.projectId, scope.action);
  assert.deepEqual(staleAction.ok, false);
  const cut = await sealCut(scope, 'late-contradiction:cut');
  const evaluation = await evaluateCut(scope, cut);
  const criterionResult = evaluation.proof.dimensions.find(
    (dimension) => dimension.dimensionId === 'CRITERIA_EVALUATION',
  );
  assert.equal(criterionResult.state, 'CONFLICT');
  assert.equal(evaluation.closed, false);
  await commitEvaluation(scope, cut, evaluation);
  const request = await pool.query({
    text: `SELECT reason_code, status FROM outcome_reconcile_request
            WHERE tenant_id=$1::uuid AND project_id=$2::uuid
            ORDER BY request_generation DESC LIMIT 1`,
    values: [ownerId, scope.project.projectId],
  });
  assert.deepEqual(request.rows[0], {
    reason_code: 'LATE_MATCHING_CONTRADICTION', status: 'COMMITTED',
  });
  const obsolete = await pool.query(
    'SELECT count(*)::int AS count FROM outcome_proof_obsolescence WHERE evaluation_id=$1::uuid',
    [oldEvaluationId],
  );
  assert.equal(obsolete.rows[0].count, 1);
  evidence.invariants.lateMatchingContradictionReevaluated = true;
  evidence.races.lateContradictionVsClosedProof = true;
});

test('stale-binding evidence is refused while a current authority revocation forces a fresh reduction', async () => {
  const staleScope = await setupScope('stale-evidence', { closed: true, action: false });
  const oldBinding = clone(staleScope.binding);
  staleScope.binding = { ...staleScope.binding, targetDigest: digest('stale-evidence:new-target') };
  const registered = await registerBinding(staleScope.binding);
  staleScope.bindingDigest = registered.bindingDigest;
  const staleDraftScope = { ...staleScope, binding: oldBinding };
  await assert.rejects(
    appendDimension(staleDraftScope, 'CRITERIA_EVALUATION', 'UNSATISFIED', 'stale-evidence:late'),
    /OUTCOME_FACT_BINDING_STALE/,
  );
  const replacementCut = await sealCut(staleScope, 'stale-evidence:replacement-cut');
  const replacementEvaluation = await evaluateCut(staleScope, replacementCut);
  await commitEvaluation(staleScope, replacementCut, replacementEvaluation);
  evidence.invariants.staleEvidenceRejected = true;

  const authorityScope = await setupScope('authority-revocation', { closed: true });
  const revokedAt = await jsonCall(
    pool,
    'SELECT outcome_revoke_authority_grant($1::uuid,$2::uuid,$3::uuid,$4) AS result',
    [ownerId, authorityScope.project.projectId, authorityScope.grant.grantId, digest('revoke-authority')],
  );
  assert.ok(BigInt(revokedAt) > 0n);
  const staleAction = await commitAction(authorityScope.project.projectId, authorityScope.action);
  assert.equal(staleAction.ok, false);
  assert.match(staleAction.code, /^RATIFIED_ACTION_(BINDING|AUTHORITY)_STALE$/);
  const cut = await sealCut(authorityScope, 'authority-revocation:cut');
  const evaluation = await evaluateCut(authorityScope, cut);
  assert.equal(evaluation.closed, false);
  assert.ok(evaluation.rejectedFacts.some((fact) => fact.decision === 'REVOKED'));
  await commitEvaluation(authorityScope, cut, evaluation);
  const request = await pool.query({
    text: `SELECT reason_code, status FROM outcome_reconcile_request
            WHERE tenant_id=$1::uuid AND project_id=$2::uuid
            ORDER BY request_generation DESC LIMIT 1`,
    values: [ownerId, authorityScope.project.projectId],
  });
  assert.deepEqual(request.rows[0], { reason_code: 'AUTHORITY_REVOKED', status: 'COMMITTED' });
  evidence.invariants.authorityRevocationReevaluated = true;
  evidence.races.authorityRevokeVsAction = true;
});

test('semantic-equivalent evaluation-plan evolution moves only the evaluation-plan lane',
  async () => {
  const project = await createProject('plan-evolution');
  const old = project.state;
  await pool.query(
    `UPDATE "project_acceptance_criterion_definition"
        SET "verification_method"='equivalent evaluator plan version two' WHERE "id"=$1`,
    [project.definitionId],
  );
  const current = await contractState(project.projectId);
  // The two lanes stay independent after the approval queue is gone: changing HOW a criterion is
  // checked moves the evaluation plan and leaves what the project counts as done exactly where it
  // was, revision included.
  assert.equal(current.contractDigest, old.contractDigest);
  assert.equal(current.contractRevision, old.contractRevision);
  assert.notEqual(current.evaluationPlanDigest, old.evaluationPlanDigest);
  evidence.invariants.evaluationPlanLaneIsIndependent = true;
});

test('contract A to B to A lands on a fresh semantic epoch, never back on the old digest',
  async () => {
  const project = await createProject('semantic-aba');
  const initial = project.state;

  await pool.query(
    `UPDATE "project_acceptance_criterion_definition" SET "text"=$2 WHERE "id"=$1`,
    [project.definitionId, 'semantic contract B'],
  );
  const middle = await contractState(project.projectId);
  assert.notEqual(middle.contractDigest, initial.contractDigest);
  assert.ok(BigInt(middle.contractRevision) > BigInt(initial.contractRevision));
  evidence.invariants.semanticChangeAdvancesTheContract = true;

  await pool.query(
    `UPDATE "project_acceptance_criterion_definition" SET "text"=$2 WHERE "id"=$1`,
    [project.definitionId, project.criterionText],
  );
  const current = await contractState(project.projectId);
  // This is the ABA lane, and it is exactly what the criteria-proposal channel now binds to:
  // `semanticRevision` only ever increases, so an edit and its revert cannot land back on the
  // digest that was cut before the edit.
  assert.notEqual(
    current.contractDigest,
    initial.contractDigest,
    'returning to the same visible contract must retain a fresh semantic epoch digest',
  );
  assert.notEqual(current.contractDigest, middle.contractDigest);
  assert.ok(BigInt(current.contractRevision) > BigInt(middle.contractRevision));
  const versions = (await pool.query({
    text: `SELECT ("semantic_material"->'criteriaVersions'->0->>'semanticRevision')::int AS revision
             FROM "project_completion_contract" WHERE "project_id"=$1::uuid`,
    values: [project.projectId],
  })).rows[0];
  assert.equal(versions.revision, 3, 'two edits, and the revision never goes back down');
  evidence.invariants.semanticEpochAbaPrevented = true;
});

test('all exercised scopes end with no false current close and no forever-pending reconcile request', async () => {
  const falseCloses = await pool.query(`SELECT count(*)::int AS count
    FROM outcome_current_evaluator_result result
    JOIN outcome_current_reconcile_request request
      ON request.tenant_id=result.tenant_id AND request.project_id=result.project_id
   WHERE result.effective_closed AND request.requires_reconcile`);
  assert.equal(falseCloses.rows[0].count, 0);
  const pending = await pool.query(`SELECT count(*)::int AS count
    FROM outcome_current_reconcile_request WHERE requires_reconcile`);
  assert.equal(pending.rows[0].count, 0);
  evidence.invariants.noFalseClose = true;
  evidence.invariants.noForeverPendingRequest = true;
  evidence.samples.bindingDimensions = bindingCases.length;
  evidence.samples.obsoleteProofs = Number((await pool.query(
    'SELECT count(*)::int AS count FROM outcome_proof_obsolescence',
  )).rows[0].count);
  evidence.samples.successorEdges = Number((await pool.query(
    'SELECT count(*)::int AS count FROM outcome_obligation_successor',
  )).rows[0].count);
});
