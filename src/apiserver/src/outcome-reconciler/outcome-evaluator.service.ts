import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  evaluateCanonicalOutcome,
  type OutcomeEvaluationResult,
} from './outcome-evaluator';

export interface EvaluateSealedOutcomeCutInput {
  tenantId: string;
  projectId: string;
  cutId: string;
  goal: Record<string, unknown>;
  binding: Record<string, unknown>;
  logicalNow: string;
  clockId: string;
  evaluatorVersion?: string;
}

export interface CommitOutcomeEvaluationInput {
  tenantId: string;
  projectId: string;
  subjectType: string;
  subjectId: string;
  cutId: string;
  expectedBindingDigest: string;
  expectedWatermarkLogicalTime: string;
  result: OutcomeEvaluationResult;
}

export interface CommittedOutcomeEvaluation {
  evaluationId: string;
  evaluationDigest: string;
  bindingDigest: string;
  watermarkLogicalTime: string;
  closed: boolean;
  replayed: boolean;
  activeMandatoryObligations: number;
}

/**
 * The service deliberately keeps reading/evaluating separate from committing. Evaluation is the
 * pure function above; commit takes the expected binding and watermark and linearizes that result
 * with append/binding writers under outcome_fact_stream's row lock.
 */
@Injectable()
export class OutcomeEvaluatorService {
  constructor(private readonly prisma: PrismaService) {}

  evaluate(input: unknown): OutcomeEvaluationResult {
    return evaluateCanonicalOutcome(input);
  }

  async evaluateSealedCut(input: EvaluateSealedOutcomeCutInput): Promise<OutcomeEvaluationResult> {
    const [cut] = await this.prisma.$queryRaw<Array<{ cut: Prisma.JsonValue }>>(Prisma.sql`
      SELECT cut_envelope AS cut
        FROM outcome_evaluation_cut
       WHERE tenant_id = ${input.tenantId}::uuid
         AND project_id = ${input.projectId}::uuid
         AND cut_id = ${input.cutId}::uuid
    `);
    if (!cut) throw new Error('Evaluation cut is absent from the tenant/project stream');
    const facts = await this.prisma.$queryRaw<Array<{
      trustDecision: string;
      proofEligible: boolean;
      envelope: Prisma.JsonValue;
    }>>(Prisma.sql`
      SELECT cf.trust_decision AS "trustDecision",
             cf.proof_eligible AS "proofEligible",
             f.envelope
        FROM outcome_evaluation_cut_fact cf
        JOIN outcome_canonical_fact f
          ON f.tenant_id = cf.tenant_id
         AND f.project_id = cf.project_id
         AND f.fact_id = cf.fact_id
       WHERE cf.tenant_id = ${input.tenantId}::uuid
         AND cf.project_id = ${input.projectId}::uuid
         AND cf.cut_id = ${input.cutId}::uuid
       ORDER BY cf.ordinal
    `);
    const factCut = cut.cut as unknown as Record<string, unknown>;
    return evaluateCanonicalOutcome({
      goal: input.goal,
      binding: input.binding,
      factCut,
      facts,
      clock: {
        logicalNow: input.logicalNow,
        clockId: input.clockId,
        evaluatedThroughLogicalTime: factCut.watermarkLogicalTime,
      },
      ...(input.evaluatorVersion ? { evaluatorVersion: input.evaluatorVersion } : {}),
    });
  }

  async commit(input: CommitOutcomeEvaluationInput): Promise<CommittedOutcomeEvaluation> {
    const [row] = await this.prisma.$queryRaw<Array<{ committed: Prisma.JsonValue }>>(Prisma.sql`
      SELECT outcome_commit_evaluation(
        ${input.tenantId}::uuid,
        ${input.projectId}::uuid,
        ${input.subjectType},
        ${input.subjectId},
        ${input.cutId}::uuid,
        ${input.expectedBindingDigest},
        ${input.expectedWatermarkLogicalTime}::bigint,
        ${input.result.evaluatorVersion},
        ${input.result.evaluatorDigest},
        ${JSON.stringify(input.result)}::jsonb
      ) AS committed
    `);
    if (!row) throw new Error('Outcome evaluation commit returned no receipt');
    return row.committed as unknown as CommittedOutcomeEvaluation;
  }

  async evaluateAndCommit(
    input: EvaluateSealedOutcomeCutInput & { expectedBindingDigest: string; subjectType: string; subjectId: string },
  ): Promise<{ result: OutcomeEvaluationResult; committed: CommittedOutcomeEvaluation }> {
    const result = await this.evaluateSealedCut(input);
    const committed = await this.commit({
      tenantId: input.tenantId,
      projectId: input.projectId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      cutId: input.cutId,
      expectedBindingDigest: input.expectedBindingDigest,
      expectedWatermarkLogicalTime: result.evaluatedThroughLogicalTime,
      result,
    });
    return { result, committed };
  }
}
