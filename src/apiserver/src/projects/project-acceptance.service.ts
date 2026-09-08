import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ProjectStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  RecordedStandardSetConfirmation,
  StandardSetConfirmationStanding,
  StatedAcceptanceCriterion,
  criteriaFromDefinitions,
  standardSetConfirmationStanding,
  standardSetVersion,
} from './project-acceptance';
import { refuseSessionAuthoredConfirmation } from './coordinator-authority';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';

/** One stated criterion, as every read surface reports it. */
export interface AcceptanceCriterionStanding {
  id: string;
  key: string;
  text: string;
  ordinal: number;
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
      })),
    };
  }

  /**
   * Where this project stands on owner confirmation of its acceptance standard set.
   *
   * Two reads and a comparison, and no third stored fact between them: the criteria as they are
   * now, the newest confirmation on record, and whether the second names the first. That is the
   * whole of "a confirmation stops counting once the criteria move" — there is no flag an edit
   * has to remember to clear, so there is no way for an edit to forget.
   */
  async standardSetConfirmation(
    ownerId: string,
    projectId: string,
  ): Promise<StandardSetConfirmationStanding> {
    await this.assertProject(ownerId, projectId);
    const stated = await ProjectAcceptanceService.statedCriteria(
      this.prisma as unknown as Prisma.TransactionClient,
      projectId,
    );
    return standardSetConfirmationStanding(
      standardSetVersion(stated),
      await this.latestConfirmation(projectId),
    );
  }

  /**
   * `CONFIRM_ACCEPTANCE_CRITERIA`: the account owner says this exact version of the standard set
   * expresses the goal. The one writer this HUMAN_ONLY action has.
   *
   * Two rules, in the order a caller can act on them.
   *
   * 1. NO ACTING SESSION. `refuseSessionAuthoredConfirmation` is the whole of the authority check
   *    and it lives here rather than at a controller, so the runner door, the user door and a
   *    direct call all meet it — §2 of `coordinator-authority.ts`, and the reason a rule enforced
   *    at one door is not a boundary.
   * 2. THE CALLER NAMES THE VERSION IT IS CONFIRMING. Without that, "confirm the criteria" means
   *    "confirm whatever they say when this request lands", and an edit that arrives between the
   *    render and the click would be confirmed by somebody who never read it. That is precisely
   *    the move this tier exists to refuse, so a digest that is no longer current is a 409 telling
   *    the caller to read the set again — not a confirmation of something else.
   *
   * Deliberately not in a transaction and deliberately taking no project lock. An edit landing
   * between the comparison and the INSERT can only make the row it writes non-current, which the
   * read above already reports honestly: the row says which version was confirmed, and it is the
   * read, never the write, that decides whether that version is the one standing.
   */
  async confirmStandardSet(
    ownerId: string,
    projectId: string,
    input: { criteriaDigest: string },
    actingSessionId?: string,
  ): Promise<StandardSetConfirmationStanding> {
    const refusal = refuseSessionAuthoredConfirmation(actingSessionId);
    if (refusal) throw new ForbiddenException(refusal);
    await this.assertProject(ownerId, projectId);

    const currentVersion = standardSetVersion(await ProjectAcceptanceService.statedCriteria(
      this.prisma as unknown as Prisma.TransactionClient,
      projectId,
    ));
    if (input.criteriaDigest !== currentVersion.digest) {
      throw new ConflictException({
        code: 'PROJECT_CRITERIA_CONFIRMATION_VERSION_MOVED',
        currentDigest: currentVersion.digest,
        message:
          'The acceptance criteria changed after the version being confirmed was read. Read them '
          + 'again and confirm the set that stands now: a confirmation carried over an edit would '
          + 'say a person approved wording they never saw.',
      });
    }

    await this.prisma.projectStandardSetConfirmation.create({
      data: {
        projectId,
        // The credentialed actor. On the owner door this is the same row as `ownerId` — the
        // controller passes the authenticated user as both — and it is stored separately because
        // it records WHO acted, not whose project it is.
        ownerId,
        confirmedById: ownerId,
        criteriaDigest: currentVersion.digest,
        // Prisma types a JSON column as an object-or-scalar union; the array shape is the one
        // the CHECK constraint on the column requires, so the cast is the type system catching up
        // with the database rather than a widening.
        criteriaMaterial: currentVersion.material as unknown as Prisma.InputJsonValue,
      },
    });

    return standardSetConfirmationStanding(
      currentVersion,
      await this.latestConfirmation(projectId),
    );
  }

  /** This project, or a 404. Tenancy, before either half of the confirmation path reads anything. */
  private async assertProject(ownerId: string, projectId: string): Promise<void> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, ownerId },
      select: { id: true },
    });
    if (!project) throw new NotFoundException('project not found');
  }

  /** The newest confirmation on record — current or not; deciding which is the caller's read. */
  private async latestConfirmation(
    projectId: string,
  ): Promise<RecordedStandardSetConfirmation | null> {
    const row = await this.prisma.projectStandardSetConfirmation.findFirst({
      where: { projectId },
      // `id` is uuid(7), so it breaks a tie inside one stored millisecond in the order the rows
      // were written rather than arbitrarily.
      orderBy: [{ confirmedAt: 'desc' }, { id: 'desc' }],
      select: {
        criteriaDigest: true,
        criteriaMaterial: true,
        confirmedAt: true,
        confirmedById: true,
      },
    });
    return row === null ? null : {
      criteriaDigest: row.criteriaDigest,
      criteriaMaterial: row.criteriaMaterial as unknown as RecordedStandardSetConfirmation['criteriaMaterial'],
      confirmedAt: row.confirmedAt,
      confirmedById: row.confirmedById,
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
