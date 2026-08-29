import { createHash, randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { ratifyProjectForPgTest } from '../projects/project-ratification-test-helper';
import {
  OUTCOME_DIMENSIONS,
  evaluateCanonicalOutcome,
  outcomeDigest,
  outcomeEvaluatorDigest,
} from './outcome-evaluator';

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Publish a real closed canonical reduction for a disposable PostgreSQL project fixture. */
async function establishCanonicalEvaluationForPgTest(
  db: PrismaClient,
  ownerId: string,
  projectId: string,
  goal: string,
  label: string,
  expectedClosed: boolean,
  refutedDimensionId?: string,
): Promise<void> {
  const state = await ratifyProjectForPgTest(db, ownerId, projectId, label) as {
    contractDigest: string;
    evaluationPlanDigest: string;
    riskPolicyDigest: string;
    permissionDigest: string;
    budgetDigest: string;
    recipientDigest: string;
    ratification?: { id?: string };
  };
  const principalId = randomUUID();
  const collectorId = `pg-test-canonical-${randomUUID()}`;
  const [grant] = await db.$queryRawUnsafe<Array<{ authority: Record<string, unknown> }>>(
    `SELECT outcome_register_authority_grant(
       $1::uuid,$2::uuid,$3::uuid,'SYSTEM',$4,'DIMENSION_EVALUATED',
       'ATTESTATION','OUTCOME_EVALUATOR',$5,'pg-test-canonical-v1',NULL,
       1::bigint,NULL::bigint,$6
     ) AS authority`,
    ownerId,
    projectId,
    randomUUID(),
    principalId,
    collectorId,
    state.riskPolicyDigest,
  );
  const authority = grant?.authority;
  if (!authority?.grantDigest) throw new Error(`${label} received no canonical authority grant`);

  const binding = {
    tenantId: ownerId,
    projectId,
    subjectType: 'PROJECT',
    subjectId: projectId,
    goalId: `goal:${projectId}`,
    goalRevision: '1',
    contractDigest: state.contractDigest,
    evaluationPlanDigest: state.evaluationPlanDigest,
    policyDigest: digest(`policy:${projectId}:${label}`),
    riskPolicyDigest: state.riskPolicyDigest,
    permissionDigest: state.permissionDigest,
    authorityGrantDigest: String(authority.grantDigest),
    budgetDigest: state.budgetDigest,
    capabilityRegistryDigest: digest(`registry:${projectId}:${label}`),
    recipientDigest: state.recipientDigest,
    evaluatorDigest: outcomeEvaluatorDigest('outcome-reducer-v2'),
    factSchemaDigest: digest('pg-test-canonical-fact-schema-v2'),
    environmentDigest: digest(`environment:${projectId}:${label}`),
    artifactDigest: digest(`artifact:${projectId}:${label}`),
    targetDigest: digest(`target:${projectId}:${label}`),
    targetRef: 'refs/heads/main',
    asOfLogicalTime: '0',
    factCutDigest: digest(`prospective-cut:${projectId}:${label}`),
  };
  const [registration] = await db.$queryRawUnsafe<Array<{
    result: { bindingDigest: string; bindingEpoch: string };
  }>>(
    'SELECT outcome_register_fact_binding($1::uuid,$2::uuid,$3::jsonb) AS result',
    ownerId,
    projectId,
    JSON.stringify(binding),
  );
  const bindingDigest = registration?.result?.bindingDigest;
  if (!bindingDigest) throw new Error(`${label} received no canonical binding receipt`);

  for (const dimension of OUTCOME_DIMENSIONS) {
    const state = dimension.id === refutedDimensionId ? 'UNSATISFIED' : 'SATISFIED';
    const payload = {
      dimensionId: dimension.id,
      state,
      applicabilityProofDigest: null,
      reasonCode: `${dimension.id}_${state}`,
    };
    const draft = {
      factKind: 'DIMENSION_EVALUATED',
      tenantId: ownerId,
      subject: { type: 'PROJECT', id: projectId, projectId },
      binding,
      schemaVersion: 2,
      schemaDigest: binding.factSchemaDigest,
      payload,
      payloadDigest: outcomeDigest(payload),
      claimType: 'ATTESTATION',
      principal: { type: 'SYSTEM', id: principalId },
      authority,
      observedAt: '2026-08-29T00:00:00.000Z',
      causalPredecessorFactId: null,
      idempotencyKey: `pg-test:${bindingDigest}:${dimension.id}`,
      source: { system: 'OUTCOME_EVALUATOR', collectorId, collectorVersion: 'pg-test-canonical-v1' },
      signature: null,
    };
    await db.$queryRawUnsafe(
      `SELECT outcome_ingest_canonical_fact($1::uuid,'SYSTEM',$2,$3::jsonb)`,
      ownerId,
      principalId,
      JSON.stringify(draft),
    );
  }

  const [sealed] = await db.$queryRawUnsafe<Array<{
    result: { cutId: string; watermarkLogicalTime: string };
  }>>(
    'SELECT outcome_seal_evaluation_cut($1::uuid,$2::uuid,$3,$4,$5) AS result',
    ownerId,
    projectId,
    bindingDigest,
    `pg-test:${bindingDigest}:cut`,
    'pg-test-canonical-v1',
  );
  const cut = sealed?.result;
  if (!cut?.cutId) throw new Error(`${label} received no canonical cut receipt`);
  const facts = await db.$queryRawUnsafe<Array<{
    trustDecision: string;
    proofEligible: boolean;
    envelope: Record<string, unknown>;
  }>>(
    `SELECT cut_fact.trust_decision AS "trustDecision",
            cut_fact.proof_eligible AS "proofEligible", fact.envelope
       FROM outcome_evaluation_cut_fact cut_fact
       JOIN outcome_canonical_fact fact
         ON fact.tenant_id=cut_fact.tenant_id AND fact.project_id=cut_fact.project_id
        AND fact.fact_id=cut_fact.fact_id
      WHERE cut_fact.tenant_id=$1::uuid AND cut_fact.project_id=$2::uuid
        AND cut_fact.cut_id=$3::uuid
      ORDER BY cut_fact.ordinal`,
    ownerId,
    projectId,
    cut.cutId,
  );
  const evaluation = evaluateCanonicalOutcome({
    binding,
    goal: {
      goalId: binding.goalId,
      goalRevision: binding.goalRevision,
      tenantId: ownerId,
      projectId,
      statement: goal,
      contractDigest: binding.contractDigest,
      evaluationPlanDigest: binding.evaluationPlanDigest,
      ratification: {
        status: 'RATIFIED',
        ratifierType: 'OWNER',
        ratifierId: ownerId,
        contractDigest: binding.contractDigest,
        factId: state.ratification?.id ?? randomUUID(),
      },
      disposition: 'ACHIEVED',
    },
    factCut: cut,
    facts,
    clock: {
      logicalNow: cut.watermarkLogicalTime,
      clockId: `pg-test-clock:${projectId}`,
      evaluatedThroughLogicalTime: cut.watermarkLogicalTime,
    },
    evaluatorVersion: 'outcome-reducer-v2',
  });
  if (evaluation.closed !== expectedClosed) {
    throw new Error(
      `${label} canonical evaluation closed=${evaluation.closed}, expected ${expectedClosed}: `
      + JSON.stringify(evaluation),
    );
  }
  await db.$queryRawUnsafe(
    `SELECT outcome_commit_evaluation(
       $1::uuid,$2::uuid,'PROJECT',$2::text,$3::uuid,$4,$5::bigint,$6,$7,$8::jsonb
     )`,
    ownerId,
    projectId,
    cut.cutId,
    bindingDigest,
    cut.watermarkLogicalTime,
    evaluation.evaluatorVersion,
    evaluation.evaluatorDigest,
    JSON.stringify(evaluation),
  );
}

/** Publish a real closed canonical reduction for a disposable PostgreSQL project fixture. */
export function establishCanonicalClosedEvaluationForPgTest(
  db: PrismaClient,
  ownerId: string,
  projectId: string,
  goal: string,
  label: string,
): Promise<void> {
  return establishCanonicalEvaluationForPgTest(
    db, ownerId, projectId, goal, label, true,
  );
}

/** Publish a newer canonical cut that refutes one required dimension and therefore reopens. */
export function establishCanonicalRefutedEvaluationForPgTest(
  db: PrismaClient,
  ownerId: string,
  projectId: string,
  goal: string,
  label: string,
): Promise<void> {
  return establishCanonicalEvaluationForPgTest(
    db, ownerId, projectId, goal, label, false, OUTCOME_DIMENSIONS[0].id,
  );
}
