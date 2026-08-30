#!/usr/bin/env node
// Explicit one-shot production publisher. Run only after the exact remote target has passed the
// prebinding matrix and its immutable task evidence exists. It never creates or replaces Owner
// Ratification, never writes Project/Task status, and leaves the independent verifier dimension
// honestly open for the successor verifier task.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const required = (name) => {
  const value = process.env[name];
  assert.ok(value, `${name} is required`);
  return value;
};
const targetSha = required('OUTCOME_RELEASE_TARGET_SHA');
const targetContentDigest = required('OUTCOME_RELEASE_TARGET_CONTENT_DIGEST');
const artifactDigest = required('OUTCOME_RELEASE_ARTIFACT_DIGEST');
const releaseEvidenceId = required('OUTCOME_RELEASE_EVIDENCE_ID');
const releaseEvidenceDigest = required('OUTCOME_RELEASE_EVIDENCE_DIGEST');
const mergeReceiptId = required('OUTCOME_RELEASE_MERGE_RECEIPT_ID');
assert.match(targetSha, SHA);
for (const value of [targetContentDigest, artifactDigest, releaseEvidenceDigest]) {
  assert.match(value, DIGEST);
}

const contractPath = process.env.OUTCOME_RELEASE_CONTRACT_PATH
  ?? '/app/contracts/outcome-reconciler-release-frontier.json';
const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
const requireFromApp = createRequire('/app/package.json');
const { Client } = requireFromApp('pg');
const {
  OUTCOME_DIMENSIONS,
  evaluateCanonicalOutcome,
  outcomeDigest,
  outcomeEvaluatorDigest,
} = await import('/app/src/apiserver/dist/outcome-reconciler/outcome-evaluator.js');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function deterministicUuid(label) {
  const hex = [...sha256(label).slice(0, 32)];
  hex[12] = '4';
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const one = async (text, values = []) => {
  const result = await client.query(text, values);
  assert.equal(result.rows.length, 1, `expected one database row, received ${result.rows.length}`);
  return result.rows[0];
};

let committed = false;
try {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

  const scope = await one(`
    SELECT project.id::text AS "projectId", project.owner_id::text AS "ownerId",
           project.goal,
           btrim(contract.contract_digest::text) AS "contractDigest",
           contract.contract_revision::text AS "contractRevision",
           btrim(contract.evaluation_plan_digest::text) AS "evaluationPlanDigest",
           btrim(contract.risk_policy_digest::text) AS "riskPolicyDigest",
           btrim(contract.permission_digest::text) AS "permissionDigest",
           btrim(contract.budget_digest::text) AS "budgetDigest",
           btrim(contract.recipient_digest::text) AS "recipientDigest",
           ratification.id::text AS "ratificationId",
           ratification.contract_revision::text AS "ratificationContractRevision",
           btrim(ratification.contract_digest::text) AS "ratificationContractDigest",
           btrim(ratification.evaluation_plan_digest_at_decision::text)
             AS "ratificationEvaluationPlanDigest",
           ratification.source AS "ratificationSource",
           ratification.ratified_by_type AS "ratifiedByType",
           ratification.ratified_by_id AS "ratifiedById",
           project_owner_ratification_effective(
             project.id, contract.contract_digest::text) AS "ratificationEffective"
      FROM project
      JOIN project_completion_contract contract ON contract.project_id=project.id
      JOIN project_owner_ratification ratification
        ON ratification.id=$3::uuid AND ratification.project_id=project.id
     WHERE project.id=$1::uuid AND project.owner_id=$2::uuid
     FOR UPDATE OF project
  `, [
    contract.project.databaseId,
    contract.ownerRatification.ownerDatabaseId,
    contract.ownerRatification.databaseId,
  ]);
  assert.equal(scope.projectId, contract.project.databaseId);
  assert.equal(scope.ownerId, contract.ownerRatification.ownerDatabaseId);
  assert.equal(scope.contractDigest, contract.ownerRatification.contractDigest,
    'semantic contract changed; owner decision is required');
  assert.equal(scope.contractRevision, contract.ownerRatification.contractRevision,
    'semantic contract revision changed; owner decision is required');
  assert.equal(scope.evaluationPlanDigest, contract.ownerRatification.evaluationPlanDigest,
    'evaluation plan changed after the declared ratification');
  assert.equal(scope.ratificationId, contract.ownerRatification.databaseId);
  assert.equal(scope.ratificationContractRevision, contract.ownerRatification.contractRevision);
  assert.equal(scope.ratificationContractDigest, contract.ownerRatification.contractDigest);
  assert.equal(scope.ratificationEvaluationPlanDigest,
    contract.ownerRatification.evaluationPlanDigest);
  assert.equal(scope.ratificationSource, 'OWNER');
  assert.equal(scope.ratifiedByType, 'OWNER');
  assert.equal(scope.ratifiedById, contract.ownerRatification.ownerDatabaseId);
  assert.equal(scope.ratificationEffective, true,
    'Owner Ratification is not effective; this publisher will not substitute for the owner');

  const evidence = await one(`
    SELECT evidence.id::text AS id,
           btrim(evidence.evidence_digest::text) AS "evidenceDigest",
           evidence.submitted_at AS "submittedAt", evidence.evidence,
           evidence.source_session_id::text AS "sourceSessionId"
      FROM task_completion_evidence evidence
     WHERE evidence.id=$1::uuid AND evidence.task_id=$2::uuid
       AND evidence.source_session_id=$3::uuid
  `, [releaseEvidenceId, contract.task.databaseId, contract.session.databaseId]);
  assert.equal(evidence.evidenceDigest, releaseEvidenceDigest);
  assert.equal(evidence.sourceSessionId, contract.session.databaseId);
  assert.equal(evidence.evidence.kind, 'orbit.outcome-reconciler.release-frontier-prebinding');
  assert.equal(evidence.evidence.projectId, contract.project.publicId);
  assert.equal(evidence.evidence.taskId, contract.task.publicId);
  assert.equal(evidence.evidence.sessionId, contract.session.publicId);
  assert.equal(evidence.evidence.targetSha, targetSha);
  assert.equal(evidence.evidence.targetRef, contract.repository.targetRef);
  assert.equal(evidence.evidence.targetContentDigest, targetContentDigest);
  assert.equal(evidence.evidence.artifactDigest, artifactDigest);

  const mergeReceipt = await one(`
    SELECT id::text AS id, result, source_branch AS "sourceBranch",
           btrim(source_sha::text) AS "sourceSha", target_branch AS "targetBranch",
           btrim(target_sha_before::text) AS "targetShaBefore",
           btrim(target_sha_after::text) AS "targetShaAfter", recorded_by AS "recordedBy",
           created_at AS "createdAt"
      FROM session_merge_receipt
     WHERE id=$1::uuid AND session_id=$2::uuid
  `, [mergeReceiptId, contract.session.databaseId]);
  assert.ok(['MERGED', 'ALREADY_MERGED'].includes(mergeReceipt.result));
  assert.equal(mergeReceipt.sourceBranch, contract.session.sourceBranch);
  assert.equal(mergeReceipt.sourceSha, targetSha);
  assert.equal(mergeReceipt.targetBranch, contract.repository.targetBranch);
  assert.equal(mergeReceipt.targetShaAfter, targetSha);
  assert.match(mergeReceipt.targetShaBefore, SHA);
  assert.notEqual(mergeReceipt.targetShaBefore, targetSha);

  await client.query(`
    INSERT INTO outcome_fact_stream(tenant_id,project_id)
    VALUES($1::uuid,$2::uuid) ON CONFLICT DO NOTHING
  `, [scope.ownerId, scope.projectId]);
  const stream = await one(`
    SELECT last_logical_time::text AS "logicalTime"
      FROM outcome_fact_stream WHERE tenant_id=$1::uuid AND project_id=$2::uuid
     FOR UPDATE
  `, [scope.ownerId, scope.projectId]);
  const principalId = contract.session.databaseId;
  const collectorId = `release-frontier:${targetSha}`;
  const collectorVersion = 'release-frontier-v1';
  const grantId = deterministicUuid(`release-frontier-authority:${releaseEvidenceDigest}`);
  let grantResult = await client.query(`
    SELECT grant_id::text AS "grantId", grant_digest::text AS "grantDigest",
           scope_digest::text AS "scopeDigest",
           delegation_chain_digest::text AS "delegationChainDigest",
           valid_from_logical_time::text AS "validFromLogicalTime",
           CASE WHEN valid_through_logical_time IS NULL THEN NULL
                ELSE valid_through_logical_time::text END AS "validThroughLogicalTime",
           (SELECT revoked_at_logical_time::text FROM outcome_fact_authority_revocation revocation
             WHERE revocation.tenant_id=authority.tenant_id
               AND revocation.project_id=authority.project_id
               AND revocation.grant_id=authority.grant_id) AS "revokedAtLogicalTime"
      FROM outcome_fact_authority_grant authority
     WHERE tenant_id=$1::uuid AND project_id=$2::uuid AND grant_id=$3::uuid
  `, [scope.ownerId, scope.projectId, grantId]);
  let authority;
  if (grantResult.rows.length === 0) {
    const row = await one(`
      SELECT outcome_register_authority_grant(
        $1::uuid,$2::uuid,$3::uuid,'SYSTEM',$4,'DIMENSION_EVALUATED','ATTESTATION',
        'OUTCOME_EVALUATOR',$5,$6,NULL,$7::bigint,NULL::bigint,$8
      ) AS authority
    `, [
      scope.ownerId, scope.projectId, grantId, principalId, collectorId, collectorVersion,
      (BigInt(stream.logicalTime) + 1n).toString(), scope.riskPolicyDigest,
    ]);
    authority = row.authority;
  } else {
    assert.equal(grantResult.rows.length, 1);
    authority = grantResult.rows[0];
  }
  assert.equal(authority.grantId, grantId);
  assert.match(authority.grantDigest, DIGEST);
  assert.equal(authority.revokedAtLogicalTime, null);

  const targetDigest = outcomeDigest({
    repositoryProvider: contract.repository.provider,
    repositoryId: contract.repository.id,
    targetRef: contract.repository.targetRef,
    targetSha,
    targetContentDigest,
  });
  const currentResult = await client.query(`
    SELECT binding FROM outcome_fact_binding
     WHERE tenant_id=$1::uuid AND project_id=$2::uuid
     ORDER BY binding_epoch DESC LIMIT 1
  `, [scope.ownerId, scope.projectId]);
  const current = currentResult.rows[0]?.binding;
  const binding = current
    && current.artifactDigest === artifactDigest
    && current.targetDigest === targetDigest
    && current.authorityGrantDigest === authority.grantDigest
    ? current
    : {
        tenantId: scope.ownerId,
        projectId: scope.projectId,
        subjectType: contract.canonicalBinding.subjectType,
        subjectId: scope.projectId,
        goalId: `goal:${scope.projectId}`,
        goalRevision: scope.contractRevision,
        contractDigest: scope.contractDigest,
        evaluationPlanDigest: scope.evaluationPlanDigest,
        policyDigest: outcomeDigest({
          contractDigest: scope.contractDigest,
          riskPolicyDigest: scope.riskPolicyDigest,
          permissionDigest: scope.permissionDigest,
        }),
        riskPolicyDigest: scope.riskPolicyDigest,
        permissionDigest: scope.permissionDigest,
        authorityGrantDigest: authority.grantDigest,
        budgetDigest: scope.budgetDigest,
        capabilityRegistryDigest: outcomeDigest({
          registry: 'orbit.outcome-reconciler.release-frontier', version: 1, targetSha,
        }),
        recipientDigest: scope.recipientDigest,
        evaluatorDigest: outcomeEvaluatorDigest('outcome-reducer-v2'),
        factSchemaDigest: outcomeDigest({
          schema: 'orbit.release-frontier-dimension-fact', version: 1,
        }),
        environmentDigest: outcomeDigest({
          environment: 'COMPOSE_CURRENT_REMOTE_MAIN', targetSha, mergeReceiptId,
          targetContentDigest,
        }),
        artifactDigest,
        targetDigest,
        targetRef: contract.repository.targetRef,
        asOfLogicalTime: stream.logicalTime,
        factCutDigest: outcomeDigest({
          prospective: true, targetSha, artifactDigest, releaseEvidenceDigest,
        }),
      };
  const registration = (await one(`
    SELECT outcome_register_fact_binding($1::uuid,$2::uuid,$3::jsonb) AS receipt
  `, [scope.ownerId, scope.projectId, binding])).receipt;
  assert.match(registration.bindingDigest, DIGEST);

  const observedAt = new Date(evidence.submittedAt).toISOString();
  for (const dimension of OUTCOME_DIMENSIONS) {
    const pending = dimension.id === contract.canonicalBinding.pendingDimension;
    const state = pending ? 'UNSATISFIED' : 'SATISFIED';
    const reasonCode = pending
      ? contract.canonicalBinding.pendingReasonCode
      : `${dimension.id}_SATISFIED_BY_RELEASE_FRONTIER`;
    const payload = {
      dimensionId: dimension.id,
      state,
      applicabilityProofDigest: null,
      reasonCode,
      releaseEvidenceId,
      releaseEvidenceDigest,
      artifactDigest,
      targetSha,
      targetContentDigest,
      mergeReceiptId,
    };
    const draft = {
      factKind: 'DIMENSION_EVALUATED',
      tenantId: scope.ownerId,
      subject: { type: 'PROJECT', id: scope.projectId, projectId: scope.projectId },
      binding,
      schemaVersion: 2,
      schemaDigest: binding.factSchemaDigest,
      payload,
      payloadDigest: outcomeDigest(payload),
      claimType: 'ATTESTATION',
      principal: { type: 'SYSTEM', id: principalId },
      authority,
      observedAt,
      causalPredecessorFactId: null,
      idempotencyKey: `release-frontier:${registration.bindingDigest}:${dimension.id}`,
      source: { system: 'OUTCOME_EVALUATOR', collectorId, collectorVersion },
      signature: null,
    };
    await one(`SELECT outcome_ingest_canonical_fact($1::uuid,'SYSTEM',$2,$3::jsonb) AS receipt`,
      [scope.ownerId, principalId, draft]);
  }

  const cut = (await one(`
    SELECT outcome_seal_evaluation_cut($1::uuid,$2::uuid,$3,$4,$5) AS receipt
  `, [
    scope.ownerId, scope.projectId, registration.bindingDigest,
    `release-frontier:${registration.bindingDigest}:cut`, collectorVersion,
  ])).receipt;
  assert.equal(Number(cut.factCount), 15);
  const facts = (await client.query(`
    SELECT cut_fact.trust_decision AS "trustDecision",
           cut_fact.proof_eligible AS "proofEligible", fact.envelope
      FROM outcome_evaluation_cut_fact cut_fact
      JOIN outcome_canonical_fact fact
        ON fact.tenant_id=cut_fact.tenant_id AND fact.project_id=cut_fact.project_id
       AND fact.fact_id=cut_fact.fact_id
     WHERE cut_fact.tenant_id=$1::uuid AND cut_fact.project_id=$2::uuid
       AND cut_fact.cut_id=$3::uuid ORDER BY cut_fact.ordinal
  `, [scope.ownerId, scope.projectId, cut.cutId])).rows;
  assert.equal(facts.length, 15);
  assert.equal(facts.filter((fact) => fact.proofEligible).length, 15);
  const goal = {
    goalId: binding.goalId,
    goalRevision: binding.goalRevision,
    tenantId: scope.ownerId,
    projectId: scope.projectId,
    statement: scope.goal,
    contractDigest: scope.contractDigest,
    evaluationPlanDigest: scope.evaluationPlanDigest,
    ratification: {
      status: 'RATIFIED',
      ratifierType: 'OWNER',
      ratifierId: scope.ownerId,
      contractDigest: scope.contractDigest,
      factId: scope.ratificationId,
    },
    disposition: contract.canonicalBinding.goalDisposition,
  };
  const evaluation = evaluateCanonicalOutcome({
    binding,
    goal,
    factCut: cut,
    facts,
    clock: {
      logicalNow: cut.watermarkLogicalTime,
      clockId: `release-frontier:${targetSha}`,
      evaluatedThroughLogicalTime: cut.watermarkLogicalTime,
    },
    evaluatorVersion: 'outcome-reducer-v2',
  });
  assert.equal(evaluation.closed, false);
  assert.deepEqual(evaluation.proof.modelGaps, []);
  const pendingDimension = evaluation.proof.dimensions.find(
    (dimension) => dimension.dimensionId === contract.canonicalBinding.pendingDimension,
  );
  assert.equal(pendingDimension?.state, 'UNSATISFIED');
  assert.equal(pendingDimension?.reasonCode, contract.canonicalBinding.pendingReasonCode);
  assert.equal(evaluation.proof.dimensions.filter((dimension) => (
    !['SATISFIED', 'NOT_APPLICABLE'].includes(dimension.state)
  )).length, 1);
  const committedReceipt = (await one(`
    SELECT outcome_commit_evaluation(
      $1::uuid,$2::uuid,'PROJECT',$2::text,$3::uuid,$4,$5::bigint,$6,$7,$8::jsonb
    ) AS receipt
  `, [
    scope.ownerId, scope.projectId, cut.cutId, registration.bindingDigest,
    cut.watermarkLogicalTime, evaluation.evaluatorVersion, evaluation.evaluatorDigest, evaluation,
  ])).receipt;

  const acceptanceCommandDigest = sha256(contract.task.acceptanceCommand);
  const deliverySpec = {
    schemaVersion: 1,
    goalId: binding.goalId,
    goalRevision: binding.goalRevision,
    canonicalBindingDigest: registration.bindingDigest,
    policyMode: 'CURRENT_TARGET_CONTAINS',
    repositoryProvider: contract.repository.provider,
    repositoryId: contract.repository.id,
    repositoryDigest: targetDigest,
    targetRef: contract.repository.targetRef,
    currentTargetSha: targetSha,
    currentTargetContentDigest: targetContentDigest,
    artifactDigest,
    evaluationPlanDigest: scope.evaluationPlanDigest,
    acceptanceCommandDigest,
    integrationProviderIdentity: 'ORBIT_MERGE_RECEIPT',
    verificationProviderIdentity: 'ORBIT_EXECUTABLE_ACCEPTANCE',
    asOfLogicalTime: cut.watermarkLogicalTime,
    idempotencyKey: `release-frontier:delivery-binding:${targetSha}:${artifactDigest}`,
  };
  const deliveryBinding = (await one(`
    SELECT outcome_register_delivery_binding($1::uuid,$2::uuid,$3::jsonb) AS receipt
  `, [scope.ownerId, scope.projectId, deliverySpec])).receipt;
  const attestation = {
    schemaVersion: 1,
    deliveryBindingDigest: deliveryBinding.deliveryBindingDigest,
    bindingRevisionDigest: deliveryBinding.bindingRevisionDigest,
    providerReceiptId: mergeReceiptId,
    providerIdentity: deliverySpec.integrationProviderIdentity,
    repositoryProvider: deliverySpec.repositoryProvider,
    repositoryId: deliverySpec.repositoryId,
    repositoryDigest: targetDigest,
    targetRef: deliverySpec.targetRef,
    targetSha,
    targetContentDigest,
    artifactDigest,
    result: mergeReceipt.result === 'MERGED' ? 'INTEGRATED' : 'ALREADY_INTEGRATED',
    externalEffectState: 'NONE',
    verifiedAt: new Date(mergeReceipt.createdAt).toISOString(),
    verifiedLogicalTime: cut.watermarkLogicalTime,
    idempotencyKey: `release-frontier:delivery-attestation:${mergeReceiptId}`,
  };
  const deliveryAttestation = (await one(`
    SELECT outcome_record_delivery_attestation($1::uuid,$2::uuid,$3,$4::jsonb) AS receipt
  `, [
    scope.ownerId, scope.projectId, deliverySpec.integrationProviderIdentity, attestation,
  ])).receipt;
  assert.ok(new Date(evidence.submittedAt) >= new Date(mergeReceipt.createdAt));
  const verification = {
    schemaVersion: 1,
    deliveryBindingDigest: deliveryBinding.deliveryBindingDigest,
    bindingRevisionDigest: deliveryBinding.bindingRevisionDigest,
    providerReceiptId: releaseEvidenceId,
    providerIdentity: deliverySpec.verificationProviderIdentity,
    repositoryDigest: targetDigest,
    targetRef: deliverySpec.targetRef,
    targetSha,
    targetContentDigest,
    artifactDigest,
    evaluationPlanDigest: scope.evaluationPlanDigest,
    acceptanceCommandDigest,
    environment: 'CLEAN_TARGET_SHA',
    result: 'PASS',
    exitCode: 0,
    skipCount: 0,
    verifiedAt: new Date(evidence.submittedAt).toISOString(),
    verifiedLogicalTime: cut.watermarkLogicalTime,
    idempotencyKey: `release-frontier:delivery-verification:${releaseEvidenceId}`,
  };
  const deliveryVerification = (await one(`
    SELECT outcome_record_delivery_verification($1::uuid,$2::uuid,$3,$4::jsonb) AS receipt
  `, [
    scope.ownerId, scope.projectId, deliverySpec.verificationProviderIdentity, verification,
  ])).receipt;

  const gate = (await one(`
    SELECT project_canonical_done_gate($1::uuid,'PROJECT',$1::text) AS gate
  `, [scope.projectId])).gate;
  assert.notEqual(gate?.reason?.code, 'CURRENT_BINDING_MISSING');
  assert.equal(gate?.canonicalIdentity?.bindingDigest, registration.bindingDigest);
  assert.equal(gate?.canonicalIdentity?.cutId, cut.cutId);
  assert.equal(gate?.ratification?.effectiveNow, true);
  assert.equal(gate?.ratification?.currentContractDigest, scope.contractDigest);
  assert.equal(gate?.ratification?.boundContractDigest, scope.contractDigest);

  await client.query('COMMIT');
  committed = true;
  console.log(JSON.stringify({
    schemaVersion: 1,
    kind: 'orbit.outcome-reconciler.release-publication-receipt',
    targetSha,
    targetContentDigest,
    targetDigest,
    artifactDigest,
    releaseEvidenceId,
    releaseEvidenceDigest,
    mergeReceiptId,
    ownerRatification: {
      id: scope.ratificationId,
      contractDigest: scope.contractDigest,
      contractRevision: scope.contractRevision,
      evaluationPlanDigest: scope.evaluationPlanDigest,
      effective: true,
      unchanged: true,
    },
    canonicalBinding: registration,
    cut,
    evaluation: {
      evaluationDigest: evaluation.evaluationDigest,
      proofDigest: evaluation.proof.proofDigest,
      closed: evaluation.closed,
      pendingDimension: contract.canonicalBinding.pendingDimension,
      pendingReasonCode: contract.canonicalBinding.pendingReasonCode,
    },
    committed: committedReceipt,
    delivery: {
      binding: deliveryBinding,
      attestation: deliveryAttestation,
      verification: deliveryVerification,
    },
    doneGate: gate,
    publishedAt: new Date().toISOString(),
  }));
} finally {
  if (!committed) {
    try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
  }
  await client.end();
}
