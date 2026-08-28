import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export const OUTCOME_PROJECTION_SURFACES = [
  'DONE_GATE',
  'AGENT_QUEUE',
  'OWNER_DECISION_INBOX',
  'PROJECT_ATTENTION',
  'MUTATION_RESPONSE',
  'WEB',
] as const;

export type OutcomeProjectionSurface = (typeof OUTCOME_PROJECTION_SURFACES)[number];

export interface OutcomeProjectionReceipt {
  applied: boolean;
  reason?: string;
  sourceEvaluationId: string;
  projectionRevision: string;
  projectionChecksum: string;
  proofChecksum?: string;
  obligationRowsetChecksum?: string;
  outboxEventKey?: string;
}

export interface OutcomeProjectionRebuildReceipt {
  rebuildId: string;
  sourceEvaluationCount: number;
  projectedSubjectCount: number;
  aggregateChecksum: string;
  projectionSchemaVersion: number;
  reducerVersion: string;
}

export interface OutcomeProjectionComparison {
  tenantId: string;
  projectId: string;
  subjectType: string;
  subjectId: string;
  sourceEvaluationId: string;
  comparisonStatus: 'MATCH' | 'MISSING' | 'RECONCILER_STALE' | 'CHECKSUM_MISMATCH';
  expectedProjectionChecksum: string;
  actualProjectionChecksum: string | null;
  expectedProofChecksum: string;
  actualProofChecksum: string | null;
}

/**
 * The read-side service has no table-writing path. PostgreSQL's reducer function is the sole
 * projection writer, while the evaluator-result trigger invokes that same function in the source
 * transaction. This class only exposes explicit replay, rebuild, shadow-compare and bounded reads.
 */
@Injectable()
export class OutcomeProjectionService {
  constructor(private readonly prisma: PrismaService) {}

  async reduce(
    evaluationId: string,
    projectionSchemaVersion = 2,
    reducerVersion = 'outcome-projection-reducer-v2',
  ): Promise<OutcomeProjectionReceipt> {
    const [row] = await this.prisma.$queryRaw<Array<{ receipt: Prisma.JsonValue }>>(Prisma.sql`
      SELECT outcome_projection.reduce_evaluation(
        ${evaluationId}::uuid,
        ${projectionSchemaVersion},
        ${reducerVersion},
        'INCREMENTAL',
        NULL::uuid
      ) AS receipt
    `);
    if (!row) throw new Error('Outcome projection reducer returned no receipt');
    return row.receipt as unknown as OutcomeProjectionReceipt;
  }

  async rebuildAll(
    projectionSchemaVersion = 2,
    reducerVersion = 'outcome-projection-reducer-v2',
  ): Promise<OutcomeProjectionRebuildReceipt> {
    const [row] = await this.prisma.$queryRaw<Array<{ receipt: Prisma.JsonValue }>>(Prisma.sql`
      SELECT outcome_projection.full_rebuild(
        ${projectionSchemaVersion},
        ${reducerVersion}
      ) AS receipt
    `);
    if (!row) throw new Error('Outcome projection rebuild returned no receipt');
    return row.receipt as unknown as OutcomeProjectionRebuildReceipt;
  }

  async reconcileSubject(input: {
    tenantId: string;
    projectId: string;
    subjectType: string;
    subjectId: string;
    projectionSchemaVersion?: number;
    reducerVersion?: string;
  }): Promise<OutcomeProjectionReceipt> {
    const [row] = await this.prisma.$queryRaw<Array<{ receipt: Prisma.JsonValue }>>(Prisma.sql`
      SELECT outcome_projection.reconcile_subject(
        ${input.tenantId}::uuid,
        ${input.projectId}::uuid,
        ${input.subjectType},
        ${input.subjectId},
        ${input.projectionSchemaVersion ?? 2},
        ${input.reducerVersion ?? 'outcome-projection-reducer-v2'}
      ) AS receipt
    `);
    if (!row) throw new Error('Outcome projection reconciliation returned no receipt');
    return row.receipt as unknown as OutcomeProjectionReceipt;
  }

  async shadowCompare(tenantId?: string, projectId?: string): Promise<OutcomeProjectionComparison[]> {
    return this.prisma.$queryRaw<OutcomeProjectionComparison[]>(Prisma.sql`
      SELECT tenant_id AS "tenantId",
             project_id AS "projectId",
             subject_type AS "subjectType",
             subject_id AS "subjectId",
             source_evaluation_id AS "sourceEvaluationId",
             comparison_status AS "comparisonStatus",
             expected_projection_checksum AS "expectedProjectionChecksum",
             actual_projection_checksum AS "actualProjectionChecksum",
             expected_proof_checksum AS "expectedProofChecksum",
             actual_proof_checksum AS "actualProofChecksum"
        FROM outcome_projection.shadow_compare(
          ${tenantId ?? null}::uuid,
          ${projectId ?? null}::uuid
        )
       ORDER BY tenant_id, project_id, subject_type, subject_id
    `);
  }

  async readSurface(input: {
    tenantId: string;
    projectId: string;
    subjectType: string;
    subjectId: string;
    surface: OutcomeProjectionSurface;
  }): Promise<Prisma.JsonValue> {
    const [row] = await this.prisma.$queryRaw<Array<{ projection: Prisma.JsonValue }>>(Prisma.sql`
      SELECT outcome_projection.read_surface(
        ${input.tenantId}::uuid,
        ${input.projectId}::uuid,
        ${input.subjectType},
        ${input.subjectId},
        ${input.surface}
      ) AS projection
    `);
    if (!row) throw new Error('Outcome projection read returned no row');
    return row.projection;
  }
}
