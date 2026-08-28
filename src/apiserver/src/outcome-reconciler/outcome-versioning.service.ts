import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  canonicalOutcomeJson,
  evaluateCanonicalOutcome,
  type OutcomeEvaluationResult,
} from './outcome-evaluator';
import type {
  CanonicalFactDraft,
  OutcomeIngressContext,
} from './outcome-fact-ingress.service';

type JsonRecord = Record<string, unknown>;

export interface OutcomeVersionedReductionInput {
  tenantId: string;
  projectId: string;
  subjectType: string;
  subjectId: string;
  binding: JsonRecord;
  goal: JsonRecord;
  idempotencyKey: string;
  collectorVersion: string;
  clockId: string;
  evaluatorVersion?: string;
}

export interface OutcomeBindingReplacementInput extends OutcomeVersionedReductionInput {
  facts?: Array<{ context: OutcomeIngressContext; draft: CanonicalFactDraft }>;
}

export interface OutcomeFactReevaluationInput extends OutcomeVersionedReductionInput {
  context: OutcomeIngressContext;
  draft: CanonicalFactDraft;
}

export interface OutcomeVersionedReductionReceipt {
  bindingDigest: string;
  bindingEpoch: string;
  cut: JsonRecord;
  evaluation: OutcomeEvaluationResult;
  committed: JsonRecord;
}

/**
 * Linearizes a semantic version change with its new reduction. PostgreSQL's outcome_fact_stream
 * row is held for the entire interactive transaction: readers observe either the prior binding
 * and proof, or the new binding, immutable cut, obsolete audit records and successor reduction.
 * They cannot observe an old proof satisfying a new binding.
 */
@Injectable()
export class OutcomeVersioningService {
  constructor(private readonly prisma: PrismaService) {}

  async replaceBindingAndReevaluate(
    input: OutcomeBindingReplacementInput,
  ): Promise<OutcomeVersionedReductionReceipt> {
    return this.prisma.$transaction(async (transaction) => {
      const [registered] = await transaction.$queryRaw<Array<{ registered: Prisma.JsonValue }>>(
        Prisma.sql`
          SELECT outcome_register_fact_binding(
            ${input.tenantId}::uuid,
            ${input.projectId}::uuid,
            ${JSON.stringify(input.binding)}::jsonb
          ) AS registered
        `,
      );
      if (!registered) throw new Error('Binding registration returned no receipt');
      const bindingReceipt = registered.registered as JsonRecord;
      const bindingDigest = String(bindingReceipt.bindingDigest ?? '');
      for (const fact of input.facts ?? []) {
        this.assertFactScope(input, fact.context, fact.draft);
        await this.append(transaction, fact.context, fact.draft);
      }
      return this.reduce(transaction, input, bindingDigest, String(bindingReceipt.bindingEpoch ?? ''));
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 60_000,
    });
  }

  async appendFactAndReevaluate(
    input: OutcomeFactReevaluationInput,
  ): Promise<OutcomeVersionedReductionReceipt> {
    this.assertFactScope(input, input.context, input.draft);
    return this.prisma.$transaction(async (transaction) => {
      await this.append(transaction, input.context, input.draft);
      const [binding] = await transaction.$queryRaw<Array<{
        bindingDigest: string;
        bindingEpoch: bigint;
      }>>(Prisma.sql`
        SELECT binding_digest::text AS "bindingDigest", binding_epoch AS "bindingEpoch"
          FROM outcome_fact_binding
         WHERE tenant_id = ${input.tenantId}::uuid
           AND project_id = ${input.projectId}::uuid
         ORDER BY binding_epoch DESC LIMIT 1
      `);
      if (!binding) throw new Error('Current binding disappeared during fact append');
      return this.reduce(
        transaction,
        input,
        binding.bindingDigest,
        binding.bindingEpoch.toString(),
      );
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 60_000,
    });
  }

  private assertFactScope(
    input: OutcomeVersionedReductionInput,
    context: OutcomeIngressContext,
    draft: CanonicalFactDraft,
  ): void {
    if (context.tenantId !== input.tenantId || draft.tenantId !== input.tenantId
      || draft.subject.projectId !== input.projectId) {
      throw new Error('Versioned fact scope does not match the transition tenant/project');
    }
    if (canonicalOutcomeJson(draft.binding) !== canonicalOutcomeJson(input.binding)) {
      throw new Error('Versioned fact must carry the exact replacement binding');
    }
  }

  private async append(
    transaction: Prisma.TransactionClient,
    context: OutcomeIngressContext,
    draft: CanonicalFactDraft,
  ): Promise<void> {
    const [row] = await transaction.$queryRaw<Array<{ envelope: Prisma.JsonValue }>>(Prisma.sql`
      SELECT outcome_ingest_canonical_fact(
        ${context.tenantId}::uuid,
        ${context.principalType},
        ${context.principalId},
        ${JSON.stringify(draft)}::jsonb
      ) AS envelope
    `);
    if (!row) throw new Error('Canonical fact append returned no envelope');
  }

  private async reduce(
    transaction: Prisma.TransactionClient,
    input: OutcomeVersionedReductionInput,
    bindingDigest: string,
    bindingEpoch: string,
  ): Promise<OutcomeVersionedReductionReceipt> {
    const [sealed] = await transaction.$queryRaw<Array<{ cut: Prisma.JsonValue }>>(Prisma.sql`
      SELECT outcome_seal_evaluation_cut(
        ${input.tenantId}::uuid,
        ${input.projectId}::uuid,
        ${bindingDigest},
        ${`${input.idempotencyKey}:cut`},
        ${input.collectorVersion}
      ) AS cut
    `);
    if (!sealed) throw new Error('Versioned evaluation cut returned no receipt');
    const cut = sealed.cut as JsonRecord;
    const facts = await transaction.$queryRaw<Array<{
      trustDecision: string;
      proofEligible: boolean;
      envelope: Prisma.JsonValue;
    }>>(Prisma.sql`
      SELECT cut_fact.trust_decision AS "trustDecision",
             cut_fact.proof_eligible AS "proofEligible",
             fact.envelope
        FROM outcome_evaluation_cut_fact cut_fact
        JOIN outcome_canonical_fact fact
          ON fact.tenant_id = cut_fact.tenant_id
         AND fact.project_id = cut_fact.project_id
         AND fact.fact_id = cut_fact.fact_id
       WHERE cut_fact.tenant_id = ${input.tenantId}::uuid
         AND cut_fact.project_id = ${input.projectId}::uuid
         AND cut_fact.cut_id = ${String(cut.cutId)}::uuid
       ORDER BY cut_fact.ordinal
    `);
    const watermark = String(cut.watermarkLogicalTime ?? '0');
    const evaluation = evaluateCanonicalOutcome({
      binding: input.binding,
      goal: input.goal,
      factCut: cut,
      facts,
      clock: {
        logicalNow: watermark,
        clockId: input.clockId,
        evaluatedThroughLogicalTime: watermark,
      },
      ...(input.evaluatorVersion ? { evaluatorVersion: input.evaluatorVersion } : {}),
    });
    const [committed] = await transaction.$queryRaw<Array<{ committed: Prisma.JsonValue }>>(
      Prisma.sql`
        SELECT outcome_commit_evaluation(
          ${input.tenantId}::uuid,
          ${input.projectId}::uuid,
          ${input.subjectType},
          ${input.subjectId},
          ${String(cut.cutId)}::uuid,
          ${bindingDigest},
          ${watermark}::bigint,
          ${evaluation.evaluatorVersion},
          ${evaluation.evaluatorDigest},
          ${JSON.stringify(evaluation)}::jsonb
        ) AS committed
      `,
    );
    if (!committed) throw new Error('Versioned evaluation commit returned no receipt');
    return {
      bindingDigest,
      bindingEpoch,
      cut,
      evaluation,
      committed: committed.committed as JsonRecord,
    };
  }
}
