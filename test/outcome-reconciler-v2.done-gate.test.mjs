import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { Client, Pool } = require('pg');
const ROOT = path.resolve(import.meta.dirname, '..');
const MODULE_PATH = process.env.OUTCOME_DONE_GATE_EVALUATOR_MODULE;
const URL = process.env.OUTCOME_DONE_GATE_PG_URL;
const EXPECTED_DATABASE = process.env.OUTCOME_DONE_GATE_PG_EXPECTED_DATABASE;
const EXPECTED_USER = process.env.OUTCOME_DONE_GATE_PG_EXPECTED_USER;
const EXPECTED_SYSTEM_IDENTIFIER = process.env.OUTCOME_DONE_GATE_PG_EXPECTED_SYSTEM_IDENTIFIER;
const EVIDENCE_PATH = process.env.OUTCOME_DONE_GATE_EVIDENCE_PATH;

assert.ok(MODULE_PATH, 'OUTCOME_DONE_GATE_EVALUATOR_MODULE is required');
assert.ok(URL, 'OUTCOME_DONE_GATE_PG_URL is required; PostgreSQL absence is a hard failure');
assert.ok(EXPECTED_DATABASE, 'OUTCOME_DONE_GATE_PG_EXPECTED_DATABASE is required');
assert.ok(EXPECTED_USER, 'OUTCOME_DONE_GATE_PG_EXPECTED_USER is required');
assert.ok(EXPECTED_SYSTEM_IDENTIFIER, 'OUTCOME_DONE_GATE_PG_EXPECTED_SYSTEM_IDENTIFIER is required');
assert.ok(EVIDENCE_PATH, 'OUTCOME_DONE_GATE_EVIDENCE_PATH is required');

const {
  OUTCOME_DIMENSIONS,
  evaluateCanonicalOutcome,
  outcomeDigest,
  outcomeEvaluatorDigest,
} = await import(pathToFileURL(path.resolve(MODULE_PATH)).href);

const pool = new Pool({ connectionString: URL, max: 20 });
const ownerId = randomUUID();
const evidence = {
  schemaVersion: 1,
  suite: 'outcome-reconciler-v2-done-gate',
  postgres: { required: true, connected: false, version: null, systemIdentifier: null },
  invariants: {
    sameCutAgreement: false,
    canonicalProofReturned: false,
    structuredReasons: false,
    unknownAndConflictFailClosed: false,
    modelGapFailClosed: false,
    ownerRatificationEnforced: false,
    deliveryPolicyEnforced: false,
    mandatoryObligationsEnforced: false,
    crossProjectEdgesOrthogonal: false,
    unknownObligationFailClosed: false,
    staleProjectionFailClosed: false,
    readFailureFailClosed: false,
    authoritativeRecoveryAutomatic: false,
    legacySummaryNotAWriter: false,
    databaseWallUsesCanonicalGate: false,
    soleProjectionReducer: false,
    currentRebuildVersionExact: false,
  },
  samples: {},
};

function digest(label) {
  return createHash('sha256').update(label).digest('hex');
}

before(async () => {
  await pool.query(
    `INSERT INTO "user" ("id","email","name","password_hash")
     VALUES ($1,$2,'done gate owner','x')`,
    [ownerId, `done-gate-${ownerId}@example.test`],
  );
});

after(async () => {
  await pool.end();
  mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
});

async function jsonCall(client, text, values) {
  const result = await client.query({ text, values });
  return result.rows[0].result;
}

async function ratificationState(projectId, client = pool) {
  return jsonCall(
    client,
    'SELECT project_owner_ratification_state_json($1::uuid,$2::uuid) AS result',
    [ownerId, projectId],
  );
}

async function createProject(label, { ratify = true } = {}) {
  const projectId = randomUUID();
  const definitionId = randomUUID();
  const goal = `${label} canonical goal`;
  await pool.query(
    `INSERT INTO "project" (
       "id","owner_id","title","goal","coordinator_enabled","automation_policy",
       "max_concurrent_tasks","session_budget_per_day","updated_at"
     ) VALUES ($1,$2,$3,$4,true,'GUARDED_AUTO'::"project_automation_policy",3,10,now())`,
    [projectId, ownerId, `${label} project`, goal],
  );
  await pool.query(
    `INSERT INTO "project_acceptance_criterion_definition" (
       "id","project_id","ordinal","text","verification_method","completion_criterion",
       "content_hash"
     ) VALUES ($1,$2,1,$3,$4,'HUMAN_SIGNOFF'::"task_completion_criterion",$5)`,
    [
      definitionId,
      projectId,
      `${label} outcome is closed by canonical proof`,
      `inspect ${label} canonical proof`,
      digest(`criterion:${definitionId}`),
    ],
  );
  let current = await ratificationState(projectId);
  if (ratify) {
    const request = current.decisionRequest;
    const approved = await jsonCall(
      pool,
      `SELECT project_owner_ratify_contract(
         $1::uuid,$2::uuid,'OWNER',$1::text,$3,$4::uuid,$5::uuid,'APPROVE',$6,false
       ) AS result`,
      [
        ownerId,
        projectId,
        current.contractDigest,
        request?.id ?? null,
        request?.ctaToken ?? null,
        `done-gate-owner:${projectId}:${randomUUID()}`,
      ],
    );
    assert.equal(approved.ok, true);
    current = await ratificationState(projectId);
    assert.equal(current.ratified, true);
  }
  return { projectId, definitionId, goal, state: current };
}

async function registerAuthority(scope) {
  const result = await pool.query({
    text: `SELECT outcome_register_authority_grant(
      $1::uuid,$2::uuid,$3::uuid,'SYSTEM',$4,'DIMENSION_EVALUATED',
      'ATTESTATION','OUTCOME_EVALUATOR',$5,'done-gate-test-v1',NULL,
      1::bigint,NULL::bigint,$6
    ) AS authority`,
    values: [
      scope.tenantId,
      scope.projectId,
      scope.grantId,
      scope.principalId,
      scope.collectorId,
      scope.riskDigest,
    ],
  });
  return result.rows[0].authority;
}

function makeBinding(scope) {
  return {
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    subjectType: 'PROJECT',
    subjectId: scope.projectId,
    goalId: `goal:${scope.projectId}`,
    goalRevision: '1',
    contractDigest: scope.project.state.contractDigest,
    evaluationPlanDigest: scope.project.state.evaluationPlanDigest,
    policyDigest: digest(`policy:${scope.projectId}`),
    riskPolicyDigest: scope.project.state.riskPolicyDigest,
    permissionDigest: scope.project.state.permissionDigest,
    authorityGrantDigest: scope.authority.grantDigest,
    budgetDigest: scope.project.state.budgetDigest,
    capabilityRegistryDigest: digest(`registry:${scope.projectId}`),
    recipientDigest: scope.project.state.recipientDigest,
    evaluatorDigest: outcomeEvaluatorDigest('outcome-reducer-v2'),
    factSchemaDigest: digest('done-gate-fact-schema-v2'),
    environmentDigest: digest(`environment:${scope.projectId}`),
    artifactDigest: digest(`artifact:${scope.projectId}`),
    targetDigest: digest(`target:${scope.projectId}`),
    targetRef: 'refs/heads/main',
    asOfLogicalTime: '0',
    factCutDigest: digest(`prospective-cut:${scope.projectId}`),
  };
}

async function setupScope(label, options = {}) {
  const project = await createProject(label, options);
  const scope = {
    project,
    tenantId: ownerId,
    projectId: project.projectId,
    subjectId: project.projectId,
    grantId: randomUUID(),
    principalId: randomUUID(),
    collectorId: `done-gate-${randomUUID()}`,
    riskDigest: project.state.riskPolicyDigest,
  };
  scope.authority = await registerAuthority(scope);
  scope.binding = makeBinding(scope);
  const registered = await jsonCall(
    pool,
    'SELECT outcome_register_fact_binding($1::uuid,$2::uuid,$3::jsonb) AS result',
    [scope.tenantId, scope.projectId, JSON.stringify(scope.binding)],
  );
  scope.bindingDigest = registered.bindingDigest;
  return scope;
}

function makeGoal(scope) {
  return {
    goalId: scope.binding.goalId,
    goalRevision: scope.binding.goalRevision,
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    statement: scope.project.goal,
    contractDigest: scope.binding.contractDigest,
    evaluationPlanDigest: scope.binding.evaluationPlanDigest,
    ratification: {
      status: 'RATIFIED',
      ratifierType: 'OWNER',
      ratifierId: ownerId,
      contractDigest: scope.binding.contractDigest,
      factId: randomUUID(),
    },
    disposition: 'ACHIEVED',
  };
}

async function appendDimension(client, scope, dimensionId, state, key) {
  const payload = {
    dimensionId,
    state,
    applicabilityProofDigest: state === 'NOT_APPLICABLE' ? digest(`n/a:${key}`) : null,
    reasonCode: `${dimensionId}_${state}`,
  };
  const draft = {
    factKind: 'DIMENSION_EVALUATED',
    tenantId: scope.tenantId,
    subject: { type: 'PROJECT', id: scope.projectId, projectId: scope.projectId },
    binding: scope.binding,
    schemaVersion: 2,
    schemaDigest: scope.binding.factSchemaDigest,
    payload,
    payloadDigest: outcomeDigest(payload),
    claimType: 'ATTESTATION',
    principal: { type: 'SYSTEM', id: scope.principalId },
    authority: scope.authority,
    observedAt: '2026-08-28T00:00:00.000Z',
    causalPredecessorFactId: null,
    idempotencyKey: key,
    source: {
      system: 'OUTCOME_EVALUATOR',
      collectorId: scope.collectorId,
      collectorVersion: 'done-gate-test-v1',
    },
    signature: null,
  };
  return jsonCall(
    client,
    'SELECT outcome_ingest_canonical_fact($1::uuid,\'SYSTEM\',$2,$3::jsonb) AS result',
    [scope.tenantId, scope.principalId, JSON.stringify(draft)],
  );
}

async function appendDimensions(scope, prefix, overrides = {}, omit = [], client = pool) {
  const facts = [];
  for (const declaration of OUTCOME_DIMENSIONS) {
    if (omit.includes(declaration.id)) continue;
    facts.push(await appendDimension(
      client,
      scope,
      declaration.id,
      overrides[declaration.id] ?? 'SATISFIED',
      `${prefix}:${declaration.id}:${randomUUID()}`,
    ));
  }
  return facts;
}

async function sealCut(client, scope, key) {
  return jsonCall(
    client,
    'SELECT outcome_seal_evaluation_cut($1::uuid,$2::uuid,$3,$4,$5) AS result',
    [scope.tenantId, scope.projectId, scope.bindingDigest, key, 'done-gate-test-v1'],
  );
}

async function evaluateCut(client, scope, cut) {
  const facts = await client.query({
    text: `SELECT cf.trust_decision AS "trustDecision",
                  cf.proof_eligible AS "proofEligible", f.envelope
             FROM outcome_evaluation_cut_fact cf
             JOIN outcome_canonical_fact f
               ON f.tenant_id=cf.tenant_id AND f.project_id=cf.project_id
              AND f.fact_id=cf.fact_id
            WHERE cf.tenant_id=$1::uuid AND cf.project_id=$2::uuid AND cf.cut_id=$3::uuid
            ORDER BY cf.ordinal`,
    values: [scope.tenantId, scope.projectId, cut.cutId],
  });
  return evaluateCanonicalOutcome({
    binding: scope.binding,
    goal: makeGoal(scope),
    factCut: cut,
    facts: facts.rows,
    clock: {
      logicalNow: cut.watermarkLogicalTime,
      clockId: 'done-gate-logical-clock',
      evaluatedThroughLogicalTime: cut.watermarkLogicalTime,
    },
    evaluatorVersion: 'outcome-reducer-v2',
  });
}

async function commitEvaluation(client, scope, cut, evaluation) {
  return jsonCall(
    client,
    `SELECT outcome_commit_evaluation(
       $1::uuid,$2::uuid,'PROJECT',$3,$4::uuid,$5,$6::bigint,$7,$8,$9::jsonb
     ) AS result`,
    [
      scope.tenantId,
      scope.projectId,
      scope.projectId,
      cut.cutId,
      scope.bindingDigest,
      cut.watermarkLogicalTime,
      evaluation.evaluatorVersion,
      evaluation.evaluatorDigest,
      JSON.stringify(evaluation),
    ],
  );
}

async function createEvaluation(scope, prefix, overrides = {}, omit = [], client = pool) {
  await appendDimensions(scope, prefix, overrides, omit, client);
  const cut = await sealCut(client, scope, `${prefix}:cut:${randomUUID()}`);
  const evaluation = await evaluateCut(client, scope, cut);
  const committed = await commitEvaluation(client, scope, cut, evaluation);
  return { cut, evaluation, committed };
}

async function queryGate(projectId, subjectType = 'PROJECT', subjectId = projectId, client = pool) {
  return jsonCall(
    client,
    'SELECT project_canonical_done_gate($1::uuid,$2,$3) AS result',
    [projectId, subjectType, subjectId],
  );
}

async function directGate(evaluation, client = pool) {
  return jsonCall(
    client,
    `SELECT outcome_projection.done_gate_value(
       $1::jsonb,$2,$3::boolean,$4,$5::bigint,1::bigint
     ) AS result`,
    [
      JSON.stringify(evaluation),
      evaluation.proof.proofDigest,
      evaluation.closed,
      evaluation.bindingDigest,
      evaluation.evaluatedThroughLogicalTime,
    ],
  );
}

function reasonCodes(gate) {
  return gate.reasons.map((reason) => reason.code);
}

function assertStructuredGate(gate) {
  assert.equal(gate.schemaVersion, 2);
  assert.ok(['ALLOW', 'DENY'].includes(gate.decision));
  assert.equal(typeof gate.allowed, 'boolean');
  assert.ok(gate.canonicalIdentity && typeof gate.canonicalIdentity === 'object');
  for (const field of [
    'reasons', 'blockingReasons', 'diagnostics', 'obligations',
    'blockingObligations', 'nonBlockingObligations',
  ]) assert.ok(Array.isArray(gate[field]), `${field} must be an array`);
  for (const field of ['canonicalIdentity', 'ratification', 'deliveryPolicy', 'crossProject']) {
    assert.ok(gate[field] && typeof gate[field] === 'object', `${field} must be an object`);
  }
  assert.ok(gate.reason && typeof gate.reason === 'object');
  for (const reason of gate.reasons) {
    assert.equal(typeof reason.code, 'string');
    assert.equal(typeof reason.message, 'string');
    assert.equal(typeof reason.owner, 'string');
    assert.equal(typeof reason.actor, 'string');
    assert.equal(typeof reason.nextAction, 'string');
    assert.equal(typeof reason.blocksGate, 'boolean');
  }
  assert.equal(gate.compatibility.legacyBlockerSignalInputs, false);
  assert.equal(gate.compatibility.projectionIsAuthority, false);
}

function rehashEvaluation(value) {
  const evaluation = structuredClone(value);
  const proofBody = structuredClone(evaluation.proof);
  delete proofBody.proofDigest;
  evaluation.proof.proofDigest = outcomeDigest(proofBody);
  const graphBody = structuredClone(evaluation.proofGraph);
  delete graphBody.proofGraphDigest;
  if ('proofGraphDigest' in evaluation.proofGraph) {
    evaluation.proofGraph.proofGraphDigest = outcomeDigest(graphBody);
  }
  const evaluationBody = structuredClone(evaluation);
  delete evaluationBody.evaluationDigest;
  evaluation.evaluationDigest = outcomeDigest(evaluationBody);
  return evaluation;
}

function foreignObligationEvaluation(base, options = {}) {
  const evaluation = structuredClone(base);
  for (const dimension of evaluation.proof.dimensions) {
    dimension.state = 'SATISFIED';
    dimension.applicabilityProofDigest = null;
    dimension.reasonCode = 'SYNTHETIC_CROSS_PROJECT_SATISFIED';
  }
  evaluation.proof.modelGaps = [];
  for (const clause of Object.keys(evaluation.proof.closedClauseResults)) {
    evaluation.proof.closedClauseResults[clause] = true;
  }
  evaluation.proof.closedClauseResults.NO_ACTIVE_MANDATORY_OBLIGATION = false;
  evaluation.closed = false;
  evaluation.proof.closed = false;
  evaluation.proofGraph.root.closed = false;
  const obligation = evaluation.activeMandatoryObligations[0];
  assert.ok(obligation, 'cross-project fixture requires one canonical obligation');
  obligation.servesCriterionIds = options.servesCriterionIds ?? ['criterion:foreign'];
  obligation.blocksClosureOf = options.blocksClosureOf ?? ['CRITERIA_EVALUATION'];
  obligation.ownership = {
    homeProjectId: options.homeProjectId ?? randomUUID(),
    blockingProjectIds: options.blockingProjectIds ?? [obligation.binding.projectId],
    crossingId: options.accepted ? randomUUID() : null,
    handoffId: options.accepted ? randomUUID() : null,
    handoffStatus: options.accepted ? 'ACCEPTED' : 'PROPOSED',
    attributionDecisionFactId: options.accepted ? randomUUID() : null,
  };
  return rehashEvaluation(evaluation);
}

let closedFixture;
let activeFixture;

test('requires isolated PostgreSQL and installs one canonical gate wall with no legacy inputs', async () => {
  const server = (await pool.query(`
    SELECT current_database() AS database, current_user AS role,
           (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
           current_setting('server_version') AS version,
           pg_get_functiondef('project_canonical_done_gate(uuid,text,text)'::regprocedure) AS gate_def,
           pg_get_functiondef('project_acceptance_done_gate()'::regprocedure) AS wall_def
  `)).rows[0];
  assert.equal(server.database, EXPECTED_DATABASE);
  assert.equal(server.role, EXPECTED_USER);
  assert.equal(server.system_identifier, EXPECTED_SYSTEM_IDENTIFIER);
  assert.match(server.version, /^1[6-9]\./);
  assert.doesNotMatch(server.gate_def, /project_blocker|task_verification_failure|signal/i);
  assert.match(server.wall_def, /project_canonical_done_gate/);
  assert.doesNotMatch(server.wall_def, /accepted_run_id|project_blocker|task_verification_failure/i);

  const migration = readFileSync(path.join(
    ROOT,
    'src/apiserver/prisma/migrations/0197_canonical_obligation_done_gate/migration.sql',
  ), 'utf8');
  assert.match(migration, /legacyBlockerSignalInputs', false/);
  assert.match(migration, /DROP CONSTRAINT IF EXISTS project_done_evidence_chk/);
  evidence.postgres = {
    required: true,
    connected: true,
    version: server.version.split(' ')[0],
    systemIdentifier: server.system_identifier,
  };
  evidence.invariants.soleProjectionReducer = true;
});

test('gate and evaluator return the exact same current cut, proof and empty obligations', async () => {
  const scope = await setupScope('closed-same-cut');
  closedFixture = { scope, ...await createEvaluation(scope, 'closed-same-cut') };
  assert.equal(closedFixture.evaluation.closed, true);
  const gate = await queryGate(scope.projectId);
  assertStructuredGate(gate);
  assert.equal(gate.allowed, true);
  assert.equal(gate.decision, 'ALLOW');
  assert.deepEqual(gate.proof, closedFixture.evaluation.proof);
  assert.deepEqual(gate.proofGraph, closedFixture.evaluation.proofGraph);
  assert.deepEqual(gate.obligations, closedFixture.evaluation.activeMandatoryObligations);
  assert.equal(gate.canonicalIdentity.evaluationId, closedFixture.committed.evaluationId);
  assert.equal(gate.canonicalIdentity.cutId, closedFixture.cut.cutId);
  assert.equal(
    gate.canonicalIdentity.evaluatedThroughLogicalTime,
    closedFixture.cut.watermarkLogicalTime,
  );
  assert.equal(gate.canonicalIdentity.bindingDigest, scope.bindingDigest);
  assert.equal(gate.canonicalIdentity.proofDigest, closedFixture.evaluation.proof.proofDigest);
  assert.equal(gate.ratification.effectiveNow, true);
  assert.equal(gate.deliveryPolicy.mode, 'POST_MERGE_VERIFIED');
  evidence.invariants.sameCutAgreement = true;
  evidence.invariants.canonicalProofReturned = true;
  evidence.invariants.structuredReasons = true;
  evidence.samples.gateProofDigest = gate.canonicalIdentity.proofDigest;
  evidence.samples.evaluatorDigest = closedFixture.evaluation.evaluatorDigest;
});

test('an unknown evaluator result shape is still a complete actionable gate view', async () => {
  const gate = await jsonCall(
    pool,
    `SELECT outcome_projection.done_gate_value(
       $1::jsonb,$2,false,$3,0::bigint,1::bigint
     ) AS result`,
    [JSON.stringify({ schemaVersion: 999 }), digest('unknown-proof'), digest('unknown-binding')],
  );
  assertStructuredGate(gate);
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason.code, 'EVALUATOR_RESULT_UNKNOWN_TYPE');
  assert.equal(gate.reason.owner, 'SYSTEM');
  assert.equal(gate.reason.actor, 'SYSTEM');
  assert.equal(gate.reason.nextAction, 'outcome.evaluator.repair');
  assert.equal(gate.ratification.validOnEvaluationCut, false);
  assert.equal(gate.deliveryPolicy.mode, 'UNKNOWN');
});

test('the database DONE transition uses the same canonical gate and needs no legacy run row', async () => {
  const updated = await pool.query(
    `UPDATE project SET status='DONE'::project_status, updated_at=now()
      WHERE id=$1::uuid RETURNING status::text, accepted_run_id, legacy_accepted_at`,
    [closedFixture.scope.projectId],
  );
  assert.deepEqual(updated.rows[0], {
    status: 'DONE',
    accepted_run_id: null,
    legacy_accepted_at: null,
  });
  evidence.invariants.databaseWallUsesCanonicalGate = true;
});

test('UNKNOWN dimension is a structured canonical obligation with owner, actor and next action', async () => {
  const scope = await setupScope('unknown-dimension');
  const fixture = await createEvaluation(scope, 'unknown-dimension', {
    CRITERIA_EVALUATION: 'UNKNOWN',
  });
  const gate = await queryGate(scope.projectId);
  assertStructuredGate(gate);
  assert.equal(gate.allowed, false);
  assert.ok(reasonCodes(gate).includes('DIMENSION_UNKNOWN'));
  assert.ok(reasonCodes(gate).includes('ACTIVE_MANDATORY_OBLIGATION'));
  assert.ok(gate.blockingObligations.length > 0);
  assert.deepEqual(gate.obligations, fixture.evaluation.activeMandatoryObligations);
  evidence.invariants.mandatoryObligationsEnforced = true;
});

test('CONFLICT is refused by the gate even when supplied as a future evaluator result shape', async () => {
  const evaluation = structuredClone(closedFixture.evaluation);
  const dimension = evaluation.proof.dimensions.find(
    (item) => item.dimensionId === 'CRITERIA_EVALUATION',
  );
  dimension.state = 'CONFLICT';
  dimension.reasonCode = 'AUTHORITATIVE_FACT_CONFLICT';
  evaluation.closed = false;
  evaluation.proof.closed = false;
  evaluation.proof.closedClauseResults.NO_CONFLICT_DIMENSION = false;
  evaluation.proof.closedClauseResults.EVERY_MANDATORY_DIMENSION_IS_SATISFIED_OR_PROVEN_NOT_APPLICABLE = false;
  evaluation.proofGraph.root.closed = false;
  const gate = await directGate(rehashEvaluation(evaluation));
  assertStructuredGate(gate);
  assert.equal(gate.allowed, false);
  assert.ok(reasonCodes(gate).includes('DIMENSION_CONFLICT'));
  evidence.invariants.unknownAndConflictFailClosed = true;
});

test('a missing required dimension becomes MODEL_GAP and cannot look like empty work', async () => {
  const scope = await setupScope('model-gap');
  await createEvaluation(scope, 'model-gap', {}, ['MODEL_COVERAGE']);
  const gate = await queryGate(scope.projectId);
  assertStructuredGate(gate);
  assert.equal(gate.allowed, false);
  assert.ok(reasonCodes(gate).includes('MODEL_GAP'));
  assert.ok(reasonCodes(gate).includes('DIMENSION_UNKNOWN'));
  assert.ok(gate.obligations.length > 0);
  evidence.invariants.modelGapFailClosed = true;
});

test('a contract change invalidates Owner Ratification after an otherwise closed evaluation', async () => {
  const scope = await setupScope('ratification-invalid');
  await createEvaluation(scope, 'ratification-invalid');
  assert.equal((await queryGate(scope.projectId)).allowed, true);
  await pool.query(
    'UPDATE project SET goal=$2, updated_at=now() WHERE id=$1::uuid',
    [scope.projectId, `${scope.project.goal} changed after ratification`],
  );
  const current = await ratificationState(scope.projectId);
  assert.equal(current.ratified, false);
  const gate = await queryGate(scope.projectId);
  assertStructuredGate(gate);
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason.code, 'OWNER_RATIFICATION_INVALID');
  assert.equal(gate.reason.owner, 'OWNER');
  assert.equal(gate.reason.actor, 'OWNER');
  assert.equal(gate.reason.nextAction, 'owner.ratification.review');
  evidence.invariants.ownerRatificationEnforced = true;
});

test('missing delivery attestation is explicit and names the bound dimensions to repair', async () => {
  const scope = await setupScope('delivery-missing');
  await createEvaluation(scope, 'delivery-missing', { ARTIFACT_INTEGRATION: 'UNKNOWN' });
  const gate = await queryGate(scope.projectId);
  assertStructuredGate(gate);
  assert.equal(gate.allowed, false);
  const reason = gate.reasons.find((item) => item.code === 'DELIVERY_ATTESTATION_MISSING');
  assert.ok(reason);
  assert.ok(reason.missingDimensions.includes('ARTIFACT_INTEGRATION'));
  assert.equal(reason.nextAction, 'delivery.attestation.record');
  assert.ok(gate.deliveryPolicy.missingDimensions.includes('ARTIFACT_INTEGRATION'));
  evidence.invariants.deliveryPolicyEnforced = true;
});

test('an active mandatory obligation blocks closure without a blocker boolean or string signal', async () => {
  const scope = await setupScope('active-obligation');
  activeFixture = { scope, ...await createEvaluation(scope, 'active-obligation', {
    CRITERIA_EVALUATION: 'UNSATISFIED',
  }) };
  const gate = await queryGate(scope.projectId);
  assertStructuredGate(gate);
  const reason = gate.reasons.find((item) => item.code === 'ACTIVE_MANDATORY_OBLIGATION');
  assert.ok(reason);
  assert.equal(reason.obligationId, gate.blockingObligations[0].obligationId);
  assert.equal(reason.obligationRevision, gate.blockingObligations[0].obligationRevision);
  assert.equal(typeof reason.owner, 'string');
  assert.equal(typeof reason.nextAction, 'string');
});

test('servesCriterion alone never creates a foreign closure edge', async () => {
  const evaluation = foreignObligationEvaluation(activeFixture.evaluation, {
    servesCriterionIds: ['criterion:peer-project'],
    blocksClosureOf: [],
    blockingProjectIds: [],
  });
  const gate = await directGate(evaluation);
  assertStructuredGate(gate);
  assert.equal(gate.allowed, true);
  assert.equal(gate.blockingObligations.length, 0);
  assert.equal(gate.nonBlockingObligations.length, 1);
  assert.equal(gate.crossProject.servesCriterionDoesNotImplyBlocksClosure, true);
});

test('an unaccepted foreign blocksClosureOf claim is diagnosed but cannot lock the wrong project', async () => {
  const evaluation = foreignObligationEvaluation(activeFixture.evaluation);
  const gate = await directGate(evaluation);
  assertStructuredGate(gate);
  assert.equal(gate.allowed, true);
  assert.equal(gate.blockingObligations.length, 0);
  assert.equal(gate.nonBlockingObligations.length, 1);
  const diagnostic = gate.diagnostics.find(
    (item) => item.code === 'CROSS_PROJECT_ATTRIBUTION_REJECTED',
  );
  assert.ok(diagnostic);
  assert.equal(diagnostic.blocksGate, false);
  assert.equal(diagnostic.nextAction, 'cross-project.attribution.repair');
  evidence.invariants.crossProjectEdgesOrthogonal = true;
});

test('an accepted explicit foreign closure crossing blocks exactly the declared project', async () => {
  const evaluation = foreignObligationEvaluation(activeFixture.evaluation, { accepted: true });
  const gate = await directGate(evaluation);
  assertStructuredGate(gate);
  assert.equal(gate.allowed, false);
  assert.equal(gate.blockingObligations.length, 1);
  assert.ok(reasonCodes(gate).includes('ACTIVE_MANDATORY_OBLIGATION'));
  assert.equal(gate.blockingObligations[0].ownership.handoffStatus, 'ACCEPTED');
});

test('an unknown obligation kind fails closed with a structured model repair action', async () => {
  const evaluation = foreignObligationEvaluation(activeFixture.evaluation);
  evaluation.activeMandatoryObligations[0].kind = 'FUTURE_UNKNOWN_OBLIGATION';
  const gate = await directGate(rehashEvaluation(evaluation));
  assertStructuredGate(gate);
  assert.equal(gate.allowed, false);
  assert.ok(reasonCodes(gate).includes('UNKNOWN_OBLIGATION_TYPE'));
  const reason = gate.reasons.find((item) => item.code === 'UNKNOWN_OBLIGATION_TYPE');
  assert.equal(reason.owner, 'SYSTEM');
  assert.equal(reason.nextAction, 'outcome.obligation-model.repair');
  evidence.invariants.unknownObligationFailClosed = true;
});

test('unknown project-gate subject types fail closed instead of selecting a nearby cut', async () => {
  const gate = await queryGate(
    closedFixture.scope.projectId,
    'FUTURE_SUBJECT_TYPE',
    closedFixture.scope.projectId,
  );
  assertStructuredGate(gate);
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason.code, 'UNKNOWN_SUBJECT_TYPE');
});

test('stale projection and active work recover automatically from newer authoritative facts', async () => {
  const scope = await setupScope('automatic-recovery');
  const initial = await createEvaluation(scope, 'automatic-recovery-initial');
  assert.equal((await queryGate(scope.projectId)).allowed, true);

  const blockerId = randomUUID();
  await pool.query(
    `INSERT INTO project_blocker (
       id,project_id,kind,owner,recovery,severity,required_action,next_check_at,
       subject_type,subject_id,detail,dedupe_key,lifecycle_generation,condition_version,
       first_seen_at,last_seen_at,updated_at
     ) VALUES (
       $1::uuid,$2::uuid,'AWAITING_USER_INPUT','USER','HUMAN','INFO',
       'legacy row must not decide canonical closure',now(),'PROJECT',$2::text,'{}'::jsonb,
       $3,1,$4,now(),now(),now()
     )`,
    [blockerId, scope.projectId, `legacy:${scope.projectId}`, digest(`legacy:${scope.projectId}`)],
  );
  assert.equal((await queryGate(scope.projectId)).allowed, true);

  await appendDimension(
    pool,
    scope,
    'CRITERIA_EVALUATION',
    'UNKNOWN',
    `automatic-recovery:unknown:${randomUUID()}`,
  );
  const stale = await queryGate(scope.projectId);
  assertStructuredGate(stale);
  assert.equal(stale.allowed, false);
  assert.equal(stale.reason.code, 'RECONCILER_STALE');
  assert.equal(stale.staleness, 'RECONCILER_STALE');
  assert.deepEqual(stale.proof, initial.evaluation.proof);
  evidence.invariants.staleProjectionFailClosed = true;

  const unknownCut = await sealCut(pool, scope, `automatic-recovery:unknown-cut:${randomUUID()}`);
  const unknownEvaluation = await evaluateCut(pool, scope, unknownCut);
  await commitEvaluation(pool, scope, unknownCut, unknownEvaluation);
  assert.equal((await queryGate(scope.projectId)).allowed, false);

  await appendDimension(
    pool,
    scope,
    'CRITERIA_EVALUATION',
    'SATISFIED',
    `automatic-recovery:satisfied:${randomUUID()}`,
  );
  const recoveredCut = await sealCut(pool, scope, `automatic-recovery:recovered-cut:${randomUUID()}`);
  const recoveredEvaluation = await evaluateCut(pool, scope, recoveredCut);
  const recoveredCommit = await commitEvaluation(pool, scope, recoveredCut, recoveredEvaluation);
  const recovered = await queryGate(scope.projectId);
  assertStructuredGate(recovered);
  assert.equal(recovered.allowed, true);
  assert.equal(recovered.canonicalIdentity.evaluationId, recoveredCommit.evaluationId);
  assert.equal(recovered.obligations.length, 0);

  await pool.query(
    `UPDATE project SET status='DONE'::project_status,updated_at=now() WHERE id=$1::uuid`,
    [scope.projectId],
  );
  const legacy = (await pool.query(
    'SELECT resolved_at,status::text FROM project_blocker JOIN project ON project.id=project_id WHERE project_blocker.id=$1',
    [blockerId],
  )).rows[0];
  assert.equal(legacy.resolved_at, null);
  assert.equal(legacy.status, 'DONE');
  evidence.invariants.authoritativeRecoveryAutomatic = true;
  evidence.invariants.legacySummaryNotAWriter = true;
  evidence.samples.recoveredProofDigest = recovered.canonicalIdentity.proofDigest;
});

test('a projection read failure returns a diagnosable structured denial', async () => {
  const client = new Client({ connectionString: URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE OR REPLACE FUNCTION outcome_projection.read_surface(
        p_authenticated_tenant uuid,
        p_project_id uuid,
        p_subject_type text,
        p_subject_id text,
        p_surface text
      ) RETURNS jsonb AS $broken$
      BEGIN
        RAISE EXCEPTION 'forced done-gate projection read failure';
      END;
      $broken$ LANGUAGE plpgsql
    `);
    const gate = await queryGate(closedFixture.scope.projectId, 'PROJECT', closedFixture.scope.projectId, client);
    assertStructuredGate(gate);
    assert.equal(gate.allowed, false);
    assert.equal(gate.reason.code, 'GATE_READ_FAILED');
    assert.equal(gate.staleness, 'READ_FAILED');
    assert.equal(gate.reason.nextAction, 'reconciler.recover');
    assert.match(gate.reason.detail.databaseMessage, /forced done-gate projection read failure/);
    await client.query('ROLLBACK');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
  evidence.invariants.readFailureFailClosed = true;
});

test('the current full rebuild stays on the same v2 reducer as incremental writes', async () => {
  const rebuilt = await jsonCall(
    pool,
    `SELECT outcome_projection.full_rebuild(
       2, 'outcome-projection-reducer-v2'
     ) AS result`,
    [],
  );
  assert.ok(Number(rebuilt.projectedSubjectCount) > 0);
  const versions = await pool.query(`
    SELECT count(*)::int AS rows,
           bool_and(projection_schema_version=2) AS schema_current,
           bool_and(reducer_version='outcome-projection-reducer-v2') AS reducer_current
      FROM outcome_projection.reconciler_state
  `);
  assert.ok(versions.rows[0].rows > 0);
  assert.equal(versions.rows[0].schema_current, true);
  assert.equal(versions.rows[0].reducer_current, true);
  evidence.invariants.currentRebuildVersionExact = true;
});
