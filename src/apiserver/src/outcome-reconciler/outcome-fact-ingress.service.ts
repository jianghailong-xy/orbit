import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type OutcomePrincipalType = 'SYSTEM' | 'AGENT' | 'OWNER' | 'RUNNER' | 'PROVIDER';

export interface OutcomeIngressContext {
  tenantId: string;
  principalType: OutcomePrincipalType;
  principalId: string;
}

/**
 * Client-authored material only. Identity, recorded time and logical time are deliberately absent:
 * PostgreSQL adds those under the per-scope stream lock and returns the complete trust envelope.
 */
export interface CanonicalFactDraft {
  factKind: string;
  tenantId: string;
  subject: { type: string; id: string; projectId: string };
  binding: Record<string, unknown>;
  schemaVersion: number;
  schemaDigest: string;
  payload: unknown;
  payloadDigest: string;
  claimType: string;
  principal: { type: OutcomePrincipalType; id: string };
  authority: Record<string, unknown>;
  observedAt: string;
  causalPredecessorFactId: string | null;
  idempotencyKey: string;
  source: { system: string; collectorId: string; collectorVersion: string };
  signature: { algorithm: string; keyId: string; value: string } | null;
}

export interface SealEvaluationCutInput {
  tenantId: string;
  projectId: string;
  bindingDigest: string;
  idempotencyKey: string;
  collectorVersion: string;
}

@Injectable()
export class OutcomeFactIngressService {
  constructor(private readonly prisma: PrismaService) {}

  async append(context: OutcomeIngressContext, draft: CanonicalFactDraft): Promise<Prisma.JsonValue> {
    const [row] = await this.prisma.$queryRaw<Array<{ envelope: Prisma.JsonValue }>>(Prisma.sql`
      SELECT outcome_ingest_canonical_fact(
        ${context.tenantId}::uuid,
        ${context.principalType},
        ${context.principalId},
        ${JSON.stringify(draft)}::jsonb
      ) AS envelope
    `);
    if (!row) throw new Error('Canonical fact ingress returned no envelope');
    return row.envelope;
  }

  async sealEvaluationCut(input: SealEvaluationCutInput): Promise<Prisma.JsonValue> {
    const [row] = await this.prisma.$queryRaw<Array<{ cut: Prisma.JsonValue }>>(Prisma.sql`
      SELECT outcome_seal_evaluation_cut(
        ${input.tenantId}::uuid,
        ${input.projectId}::uuid,
        ${input.bindingDigest},
        ${input.idempotencyKey},
        ${input.collectorVersion}
      ) AS cut
    `);
    if (!row) throw new Error('Evaluation-cut seal returned no cut');
    return row.cut;
  }

  async replayDigest(tenantId: string, cutId: string): Promise<string> {
    const [row] = await this.prisma.$queryRaw<Array<{ digest: string | null }>>(Prisma.sql`
      SELECT outcome_replay_fact_set_digest(${tenantId}::uuid, ${cutId}::uuid) AS digest
    `);
    if (!row?.digest) throw new Error('Evaluation cut is absent from the tenant canonical ledger');
    return row.digest;
  }

  async readEvaluationCut(
    tenantId: string,
    cutId: string,
    proofOnly = false,
  ): Promise<Array<{ ordinal: number; trustDecision: string; proofEligible: boolean; envelope: Prisma.JsonValue }>> {
    return this.prisma.$queryRaw<Array<{
      ordinal: number;
      trustDecision: string;
      proofEligible: boolean;
      envelope: Prisma.JsonValue;
    }>>(Prisma.sql`
      SELECT ordinal,
             trust_decision AS "trustDecision",
             proof_eligible AS "proofEligible",
             envelope
        FROM outcome_read_evaluation_cut(${tenantId}::uuid, ${cutId}::uuid, ${proofOnly})
       ORDER BY ordinal
    `);
  }
}
