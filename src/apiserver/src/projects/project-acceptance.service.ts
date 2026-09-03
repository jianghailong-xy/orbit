import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, ProjectStatus, TaskCompletionCriterion } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  StatedAcceptanceCriterion,
  criteriaFromDefinitions,
} from './project-acceptance';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';

/** One stated criterion, as every read surface reports it. */
export interface AcceptanceCriterionStanding {
  id: string;
  key: string;
  text: string;
  ordinal: number;
  completionCriterion: TaskCompletionCriterion;
}

/** The criteria tally a project detail read embeds: what this project says it is for, next to the
 *  task tally's process measure. */
export interface ProjectAcceptanceCriteriaSummary {
  total: number;
  criteria: AcceptanceCriterionStanding[];
}

export interface RecordMergeEvidenceInput {
  requirementId: string;
  targetBranch: string;
  contentHash: string;
  source?: string;
  detail?: Record<string, unknown>;
}

/**
 * A project's acceptance CRITERIA — the authored declaration, and nothing that judges it.
 *
 * Migration 0229 removed the judging half of this service on the account owner's instruction:
 * acceptance runs, per-run criterion verdicts, conclusion events, the audit ledger, the DONE gate
 * and the accepted-run pointer are all gone, along with the four triggers on `project` that
 * enforced them. What is left is what the owner asked to keep — a project states its criteria
 * precisely, they are readable and editable, and NOTHING in Orbit decides whether they hold. That
 * is the same position an EXECUTABLE task has been in since 0228: declared, unimplemented.
 */
@Injectable()
export class ProjectAcceptanceService {
  private readonly logger = new Logger(ProjectAcceptanceService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Read the authored criteria. The delegate check is for unit-test doubles that stub Prisma with
   * only the tables the case is about; production schema always has it. */
  private static async statedCriteria(
    tx: Prisma.TransactionClient,
    projectId: string,
  ): Promise<StatedAcceptanceCriterion[]> {
    const delegate = (tx as unknown as {
      projectAcceptanceCriterionDefinition?: {
        findMany(args: unknown): Promise<Array<{
          id: string;
          ordinal: number;
          text: string;
          verificationMethod: string;
          completionCriterion: TaskCompletionCriterion;
          acceptanceCommand: string | null;
          acceptanceExpectedExitCode: number | null;
          evidenceTaskId: string | null;
          completionCriterionOverrideReason: string | null;
          revision: number;
          contentHash: string;
        }>>;
      };
    }).projectAcceptanceCriterionDefinition;
    if (!delegate) return [];
    const definitions = await delegate.findMany({
      where: { projectId },
      orderBy: { ordinal: 'asc' },
      select: {
        id: true,
        ordinal: true,
        text: true,
        verificationMethod: true,
        completionCriterion: true,
        acceptanceCommand: true,
        acceptanceExpectedExitCode: true,
        evidenceTaskId: true,
        completionCriterionOverrideReason: true,
        revision: true,
        contentHash: true,
      },
    });
    return criteriaFromDefinitions(definitions);
  }

  /**
   * The criteria a project detail read embeds.
   *
   * There is deliberately no verdict, no pass count and no last-judged time on this shape any more.
   * Reporting one would mean inventing the evaluator 0229 removed; reporting a constant would be a
   * projection that always says the same thing. A criterion is stated, and that is the whole fact.
   */
  async criteriaSummary(projectId: string): Promise<ProjectAcceptanceCriteriaSummary> {
    const stated = await ProjectAcceptanceService.statedCriteria(
      this.prisma as unknown as Prisma.TransactionClient,
      projectId,
    );
    return {
      total: stated.length,
      criteria: stated.map((criterion) => ({
        id: criterion.definitionId,
        key: criterion.key,
        text: criterion.text,
        ordinal: criterion.ordinal,
        completionCriterion: criterion.completionCriterion as TaskCompletionCriterion,
      })),
    };
  }

  /** Refresh the two digest lanes of `project_completion_contract` under the database's Project-row
   *  serialization point. That contract is a digest of what the project DECLARES — its goal, its
   *  operating settings, its members and its criterion definitions — and none of its inputs were
   *  removed by 0229. */
  async refreshCompletionContract(
    tx: Prisma.TransactionClient | PrismaService,
    projectId: string,
    reason: string,
  ): Promise<Record<string, unknown>> {
    const [row] = await tx.$queryRaw<Array<{ state: Prisma.JsonValue }>>(Prisma.sql`
      SELECT project_refresh_completion_contract(
        ${projectId}::uuid, ${reason}
      ) AS state
    `);
    if (!row?.state || typeof row.state !== 'object' || Array.isArray(row.state)) {
      throw new Error('completion contract refresh returned no state');
    }
    return row.state as Record<string, unknown>;
  }

  /**
   * The project row lock a merge-evidence write takes.
   *
   * `FOR NO KEY UPDATE` conflicts with another writer of the same row and not with the
   * `FOR KEY SHARE` a foreign key takes, which is the ordering §8.6 LO2 asks for.
   */
  private static async lockProject(
    tx: Prisma.TransactionClient,
    projectId: string,
    ownerId: string,
  ): Promise<{ id: string; status: ProjectStatus }> {
    const [row] = await tx.$queryRaw<Array<{ id: string; status: string }>>(Prisma.sql`
      SELECT p."id", p."status"::text AS "status"
        FROM "project" p
       WHERE p."id" = ${projectId}::uuid AND p."owner_id" = ${ownerId}::uuid
       FOR NO KEY UPDATE`);
    if (!row) throw new NotFoundException('project not found');
    return { id: row.id, status: row.status as ProjectStatus };
  }

  private static mergeRow(row: {
    id: string; projectId: string; requirementId: string; targetBranch: string;
    contentHash: string; refGeneration: bigint; source: string; detail: unknown;
    observedAt: Date; lastSeenAt: Date;
  }) {
    return {
      id: row.id,
      projectId: row.projectId,
      requirementId: row.requirementId,
      targetBranch: row.targetBranch,
      contentHash: row.contentHash,
      refGeneration: String(row.refGeneration),
      source: row.source,
      detail: row.detail,
      observedAt: row.observedAt,
      lastSeenAt: row.lastSeenAt,
    };
  }

  /**
   * Record what a target branch was observed to contain.
   *
   * This survives 0229 because it is an OBSERVATION about a git ref, not a verdict about a
   * project: `contentHash` is taken by content, never from `git branch --contains`, which is a
   * guaranteed false negative after a squash. Nothing reads it to decide anything any more —
   * acceptance runs were its only consumer — so it is a record kept for a reader.
   */
  async recordMergeEvidence(ownerId: string, projectId: string, input: RecordMergeEvidenceInput) {
    const requirementId = (input.requirementId ?? '').trim();
    const targetBranch = (input.targetBranch ?? '').trim();
    const contentHash = (input.contentHash ?? '').trim().toLowerCase();
    if (requirementId === '' || targetBranch === '') {
      throw new BadRequestException('requirementId and targetBranch are required');
    }
    if (!/^[0-9a-f]{64}$/.test(contentHash)) {
      throw new BadRequestException(
        'contentHash must be a sha256 hex digest of the observed CONTENT — a commit SHA or a ' +
          '`git branch --contains` boolean is a guaranteed false negative after a squash',
      );
    }
    // Retried whole. The evidence row is keyed by the merge it records, so a re-run writes the same
    // row rather than a second one.
    return withTransactionRetry(this.prisma, async (tx) => {
      await ProjectAcceptanceService.lockProject(tx, projectId, ownerId);
      const [latest] = await tx.$queryRaw<Array<{
        id: string; contentHash: string; refGeneration: bigint;
      }>>(Prisma.sql`
        SELECT m."id", m."content_hash" AS "contentHash", m."ref_generation" AS "refGeneration"
          FROM "project_merge_evidence" m
         WHERE m."project_id" = ${projectId}::uuid
           AND m."requirement_id" = ${requirementId}
           AND m."target_branch" = ${targetBranch}
         ORDER BY m."ref_generation" DESC
         LIMIT 1`);

      if (latest && latest.contentHash === contentHash) {
        const row = await tx.projectMergeEvidence.update({
          where: { id: latest.id },
          data: { lastSeenAt: new Date() },
        });
        return { ...ProjectAcceptanceService.mergeRow(row), changed: false };
      }

      const row = await tx.projectMergeEvidence.create({
        data: {
          projectId,
          requirementId,
          targetBranch,
          contentHash,
          refGeneration: (latest?.refGeneration ?? 0n) + 1n,
          source: input.source ?? 'MERGE_EVIDENCE_WRITER',
          detail: (input.detail ?? {}) as Prisma.InputJsonValue,
        },
      });
      return { ...ProjectAcceptanceService.mergeRow(row), changed: true };
    }, loggedRetry(this.logger, 'projectAcceptance.recordMergeEvidence'));
  }
}
