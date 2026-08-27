import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ProjectAcceptanceVerdict, ProjectStatus } from '@prisma/client';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  ACCEPTANCE_BLOCKED,
  ACCEPTANCE_DIGEST_VERSION,
  ACCEPTANCE_EVIDENCE_STALE,
  ACCEPTANCE_FINDING_ROUTING,
  ACCEPTANCE_MISSING,
  AcceptanceFacts,
  AcceptanceRefusalCode,
  StatedAcceptanceCriterion,
  acceptanceDigest,
  acceptanceResultDigest,
  criteriaFromLegacy,
  criteriaLegacyProjection,
  criteriaSemanticRevision,
  statedCriteriaFrom,
} from './project-acceptance';
import {
  AuthorityPrincipal,
  authorityPrincipal,
  refuseHumanOnlyAction,
} from './coordinator-authority';
import { verificationFailureIsHistorySql } from '../tasks/task-supersession';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';

/** What a caller may say when opening a run. Both attributions are historical ids: they record who
 *  ran an acceptance, and nothing later may rewrite that by deleting a session. */
export interface OpenAcceptanceRunInput {
  decidedBy: 'COORDINATOR_AGENT' | 'USER';
  coordinatorAgentId?: string | null;
  coordinatorSessionId?: string | null;
  projectActionId?: string | null;
}

export interface AcceptanceCriterionOutcomeInput {
  ordinal?: number;
  criterionKey?: string;
  criterionId?: string;
  verdict: ProjectAcceptanceVerdict;
  summary?: string | null;
  evidence?: Record<string, unknown>;
  evidenceTaskId?: string | null;
  evidenceSessionId?: string | null;
}

/** What a criterion the latest run has not concluded about reports instead of a verdict. A value
 *  rather than `null`, so "not judged yet" is something a client can render rather than something
 *  it has to infer from an absence. Outside `ProjectAcceptanceVerdict` on purpose: it is not a
 *  conclusion, and it is never written to a column. */
export const ACCEPTANCE_UNDECIDED = 'UNDECIDED' as const;

/** One stated criterion and what the latest attempt currently says about it. */
export interface AcceptanceCriterionStanding {
  id: string;
  key: string;
  text: string;
  ordinal: number;
  verdict: ProjectAcceptanceVerdict | typeof ACCEPTANCE_UNDECIDED;
  summary: string | null;
  decidedAt: Date | null;
  evidenceTaskId: string | null;
}

/** The acceptance tally a project detail read embeds: the outcome measure next to the task tally's
 *  process measure. */
export interface ProjectAcceptanceCriteriaSummary {
  total: number;
  passed: number;
  lastRunAt: Date | null;
  criteria: AcceptanceCriterionStanding[];
}

export interface RecordMergeEvidenceInput {
  requirementId: string;
  targetBranch: string;
  contentHash: string;
  source?: string;
  detail?: Record<string, unknown>;
}

/** A DONE that was refused, with the code the caller switches on. Thrown as a 409 because it is a
 *  statement about the world's current state, not about the request being malformed.
 *
 *  Ids in `detail` are spelled by `PublicIdExceptionFilter`, which runs the allowlist over a THROWN
 *  body exactly as `PublicIdInterceptor` runs it over a returned one: put the row's UUID in `runId`
 *  and base62 is what reaches the wire. A `message` is prose, and nothing maps prose — an id named
 *  inside one is spelled base62 here, by hand. */
export class AcceptanceRefusal extends ConflictException {
  constructor(
    readonly code: AcceptanceRefusalCode,
    message: string,
    detail: Record<string, unknown> = {},
  ) {
    super({
      statusCode: 409,
      error: 'Conflict',
      code,
      message,
      owner: 'USER',
      ...detail,
    });
  }
}

/** The closed set migration 0127 declares as a CHECK, mirrored here so a typo is a compile error
 *  rather than a constraint violation at runtime. */
type AuditKind =
  | 'run_opened' | 'run_finalized' | 'run_superseded'
  | 'done_bound' | 'done_refused'
  | 'reopened_by_fact_change' | 'reopened_by_user'
  | 'legacy_marked' | 'merge_evidence_observed';

/**
 * Project-level acceptance, natively (contract §13.4, §13.5).
 *
 * The thing this replaces is worth naming, because it is what made the previous round of this
 * project unfinishable: acceptance existed as prose. Somebody ran the suites, wrote the numbers in
 * a document, and a person read that document and set the project DONE. Nothing in the system
 * related the claim to the facts it was about, so "is this project's DONE still true" had no
 * mechanical answer, and changing an acceptance condition could not invalidate anything.
 *
 * What is here instead is one row per attempt (`project_acceptance_run`), one row per stated
 * criterion (`project_acceptance_criterion`), a digest of the facts the attempt judged
 * (`inputDigest`, AE1), a digest of what it concluded (`resultDigest`), and a hard gate that
 * recomputes the first of those inside the transaction that writes DONE. Everything a caller can
 * do that would change the answer either moves the digest or supersedes the run — and the
 * acceptance-fact writes that could do it behind the service's back are caught by database
 * triggers rather than by a convention. Task-list state is deliberately outside that answer.
 */
@Injectable()
export class ProjectAcceptanceService {
  private readonly logger = new Logger(ProjectAcceptanceService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Read the structured authoring source, with a compatibility fallback for unit-test doubles and
   * the small rolling-upgrade window in which a project row can be visible before an old writer's
   * text has been backfilled. Production schema 0172 always has the delegate. */
  private static async statedCriteria(
    tx: Prisma.TransactionClient,
    projectId: string,
    legacy: string | null | undefined,
  ): Promise<StatedAcceptanceCriterion[]> {
    const delegate = (tx as unknown as {
      projectAcceptanceCriterionDefinition?: {
        findMany(args: unknown): Promise<Array<{
          id: string;
          ordinal: number;
          text: string;
          revision: number;
          contentHash: string;
        }>>;
      };
    }).projectAcceptanceCriterionDefinition;
    if (!delegate) return criteriaFromLegacy(legacy);
    const definitions = await delegate.findMany({
      where: { projectId },
      orderBy: { ordinal: 'asc' },
      select: {
        id: true,
        ordinal: true,
        text: true,
        revision: true,
        contentHash: true,
      },
    });
    return statedCriteriaFrom(definitions, legacy);
  }

  // ------------------------------------------------------------------------------------------
  // Facts and digests
  // ------------------------------------------------------------------------------------------

  /**
   * The acceptance-only projections, read from the current rows.
   *
   * Deliberately takes a transaction client: every caller that matters has already taken the
   * project row lock, and reading these through a different connection would answer about a world
   * the lock does not cover.
   */
  async facts(tx: Prisma.TransactionClient, projectId: string): Promise<AcceptanceFacts> {
    const project = await tx.project.findUnique({
      where: { id: projectId },
      select: { acceptanceCriteria: true },
    });
    if (!project) throw new NotFoundException('project not found');
    const criteria = await ProjectAcceptanceService.statedCriteria(
      tx, projectId, project.acceptanceCriteria,
    );

    // DISTINCT ON: only the newest generation of each (requirement, branch) pair is what the
    // project currently stands on. The older rows stay readable — that is the point of AE9's
    // append-only shape — but a superseded observation is not a fact about today.
    const merges = await tx.$queryRaw<Array<{
      requirementId: string; targetBranch: string; contentHash: string; refGeneration: bigint;
    }>>(Prisma.sql`
      SELECT DISTINCT ON (m."requirement_id", m."target_branch")
             m."requirement_id" AS "requirementId", m."target_branch" AS "targetBranch",
             m."content_hash" AS "contentHash", m."ref_generation" AS "refGeneration"
        FROM "project_merge_evidence" m
       WHERE m."project_id" = ${projectId}::uuid
       ORDER BY m."requirement_id", m."target_branch", m."ref_generation" DESC
    `);

    return {
      criteriaRevision: criteriaSemanticRevision(criteria),
      mergeEvidence: merges.map((m) => [
        m.requirementId, m.targetBranch, m.contentHash, String(m.refGeneration),
      ] as [string, string, string, string]),
    };
  }

  async digest(tx: Prisma.TransactionClient, projectId: string): Promise<string> {
    return acceptanceDigest(projectId, await this.facts(tx, projectId));
  }

  // ------------------------------------------------------------------------------------------
  // Locks, tenancy, audit
  // ------------------------------------------------------------------------------------------

  /**
   * AE6-a / AE7's lock, and the only place either spelling is written.
   *
   * `FOR UPDATE` for the DONE path, `FOR NO KEY UPDATE` for an acceptance-fact write. They conflict
   * with each other and not with the `FOR KEY SHARE` a foreign key takes, which is exactly the
   * ordering both clauses ask for. §8.6 LO3 forbids starting with the weaker one and upgrading, so
   * the caller states which it needs before it reads anything.
   */
  static async lockProject(
    tx: Prisma.TransactionClient,
    projectId: string,
    ownerId: string,
    mode: 'FOR UPDATE' | 'FOR NO KEY UPDATE',
  ): Promise<{
    id: string; status: ProjectStatus; acceptedRunId: string | null;
    legacyAcceptedAt: Date | null; acceptanceCriteria: string | null;
  }> {
    const sql = mode === 'FOR UPDATE'
      ? Prisma.sql`
          SELECT p."id", p."status"::text AS "status", p."accepted_run_id" AS "acceptedRunId",
                 p."legacy_accepted_at" AS "legacyAcceptedAt",
                 p."acceptance_criteria" AS "acceptanceCriteria"
            FROM "project" p
           WHERE p."id" = ${projectId}::uuid AND p."owner_id" = ${ownerId}::uuid
           FOR UPDATE`
      : Prisma.sql`
          SELECT p."id", p."status"::text AS "status", p."accepted_run_id" AS "acceptedRunId",
                 p."legacy_accepted_at" AS "legacyAcceptedAt",
                 p."acceptance_criteria" AS "acceptanceCriteria"
            FROM "project" p
           WHERE p."id" = ${projectId}::uuid AND p."owner_id" = ${ownerId}::uuid
           FOR NO KEY UPDATE`;
    const [row] = await tx.$queryRaw<Array<{
      id: string; status: string; acceptedRunId: string | null;
      legacyAcceptedAt: Date | null; acceptanceCriteria: string | null;
    }>>(sql);
    if (!row) throw new NotFoundException('project not found');
    return { ...row, status: row.status as ProjectStatus };
  }

  private async assertOwned(projectId: string, ownerId: string): Promise<void> {
    const found = await this.prisma.project.findFirst({
      where: { id: projectId, ownerId }, select: { id: true },
    });
    if (!found) throw new NotFoundException('project not found');
  }

  static async writeAudit(
    tx: Prisma.TransactionClient,
    projectId: string,
    kind: AuditKind,
    reason: string | null,
    detail: Prisma.InputJsonValue = {},
    runId: string | null = null,
  ): Promise<void> {
    await tx.projectAcceptanceAudit.create({
      data: { projectId, kind, reason, detail, runId },
    });
  }

  // ------------------------------------------------------------------------------------------
  // Running an acceptance
  // ------------------------------------------------------------------------------------------

  /**
   * Open an attempt (§13.4 clause 1–3).
   *
   * Three things happen together or not at all: the epoch is claimed and incremented (AE11), the
   * criteria are frozen with their digest, and one row per stated criterion is created empty. The
   * empty criterion rows are the point — they are the checklist the finalize call has to fill, so
   * "we forgot to check number 7" is a refusal rather than a silent PASS.
   *
   * A project with no acceptance criteria is refused here rather than allowed to pass vacuously:
   * §13.4 clause 2 is about checking a stated condition, and there is nothing to check.
   */
  async openRun(ownerId: string, projectId: string, input: OpenAcceptanceRunInput) {
    if (input.decidedBy !== 'COORDINATOR_AGENT' && input.decidedBy !== 'USER') {
      throw new BadRequestException('decidedBy must be COORDINATOR_AGENT or USER');
    }
    // Retried whole. The run is opened against the project row this closure locks and re-reads, so
    // a re-run opens against the state the winner left. A victim opened no run.
    return withTransactionRetry(this.prisma, async (tx) => {
      const locked = await ProjectAcceptanceService.lockProject(
        tx, projectId, ownerId, 'FOR NO KEY UPDATE',
      );
      if (locked.status === ProjectStatus.CANCELLED) {
        throw new ConflictException('this project is cancelled — acceptance would decide nothing');
      }
      const criteria = await ProjectAcceptanceService.statedCriteria(
        tx, projectId, locked.acceptanceCriteria,
      );
      if (criteria.length === 0) {
        throw new BadRequestException(
          'this project states no acceptance criteria — set them before running acceptance, ' +
            'because an acceptance with nothing to check would pass by having nothing to fail',
        );
      }

      // AE11: the key is the value READ, `+1` commits with the row. A retry of the same pass finds
      // the epoch already spent and lands on `project_acceptance_run_attempt_idx` instead of
      // opening a second attempt for one decision.
      const runtime = await tx.projectRuntime.upsert({
        where: { projectId },
        create: { projectId },
        update: {},
        select: { acceptanceAttempt: true },
      });
      const attempt = runtime.acceptanceAttempt;
      await tx.projectRuntime.update({
        where: { projectId },
        data: { acceptanceAttempt: { increment: 1 } },
      });

      const facts = await this.facts(tx, projectId);
      const inputDigest = acceptanceDigest(projectId, facts);

      // A newer attempt retires the older ones: two live runs would let a caller pick the one that
      // says what they want.
      await tx.projectAcceptanceRun.updateMany({
        where: { projectId, supersededAt: null },
        data: { supersededAt: new Date(), supersededReason: 'superseded_by_newer_attempt' },
      });

      const run = await tx.projectAcceptanceRun.create({
        data: {
          projectId,
          attempt,
          criteriaSnapshot: criteriaLegacyProjection(criteria) ?? '',
          criteriaSnapshotV2: criteria.map((criterion) => ({
            id: criterion.definitionId,
            revision: criterion.definitionRevision,
            ordinal: criterion.ordinal,
            text: criterion.text,
            contentHash: criterion.contentHash,
          })) as Prisma.InputJsonValue,
          criteriaRevision: facts.criteriaRevision,
          inputDigest,
          // Which reading of the world this evidence is about. Written explicitly, not defaulted:
          // the column's DEFAULT of 1 exists so an OLDER binary's run is fail-closed at 0130's DONE
          // gate, and only a writer that knows about §13.6 SU6's facts may claim the current one.
          digestVersion: ACCEPTANCE_DIGEST_VERSION,
          decidedBy: input.decidedBy,
          coordinatorAgentId: input.coordinatorAgentId ?? null,
          coordinatorSessionId: input.coordinatorSessionId ?? null,
          projectActionId: input.projectActionId ?? null,
        },
      });
      await tx.projectAcceptanceCriterion.createMany({
        data: criteria.map((c) => ({
          runId: run.id,
          projectId,
          ordinal: c.ordinal,
          criterionKey: c.key,
          criterionText: c.text,
          definitionId: c.definitionId,
          definitionRevision: c.definitionRevision,
        })),
      });
      await ProjectAcceptanceService.writeAudit(
        tx, projectId, 'run_opened', `attempt ${attempt}`,
        { attempt: String(attempt), inputDigest, criteria: criteria.length }, run.id,
      );
      return this.readRun(tx, run.id);
    }, loggedRetry(this.logger, 'projectAcceptance.openRun'));
  }

  /**
   * Unit T6 §1, read off the acting session's own row.
   *
   * Only asked when the write in hand actually reaches a PASS, so an acceptance concluded by a
   * person — or one that concludes nothing but failures — pays no query for a boundary that does
   * not apply to it.
   */
  private async assertMayConcludePass(
    ownerId: string,
    actingSessionId: string | undefined,
  ): Promise<void> {
    if (!actingSessionId) return;
    const acting = await this.prisma.session.findFirst({
      where: { id: actingSessionId, ownerId },
      select: { dispatchOrigin: true },
    });
    const principal: AuthorityPrincipal = authorityPrincipal(acting?.dispatchOrigin);
    const refusal = refuseHumanOnlyAction(principal, 'CONCLUDE_VERDICT_PASS');
    if (refusal) throw new ForbiddenException(refusal);
  }

  /**
   * Conclude an attempt (§13.4 clause 3–4).
   *
   * Every criterion in the snapshot must be answered — by ordinal or by content key — and the run's
   * verdict is DERIVED from the answers rather than supplied: all PASS is PASS, any FAIL is FAIL,
   * otherwise INCONCLUSIVE. A caller cannot hand in a PASS over a checklist that says otherwise,
   * which is the whole difference between this and a task comment.
   *
   * The run is re-digested against the world as it is NOW, and a run whose facts moved while it was
   * being judged concludes against those facts rather than the ones it opened on — otherwise a
   * finalize could bless a world nobody looked at.
   */
  async finalizeRun(
    ownerId: string,
    projectId: string,
    runId: string,
    outcomes: AcceptanceCriterionOutcomeInput[],
    actingSessionId?: string,
  ) {
    if (!Array.isArray(outcomes) || outcomes.length === 0) {
      throw new BadRequestException('a verdict must state a conclusion for every criterion');
    }
    // Unit T6: `CONCLUDE_VERDICT_PASS` is HUMAN_ONLY, and this is the door where a project's own
    // acceptance is concluded. A judgment session may open a run and may answer FAIL or
    // INCONCLUSIVE on every criterion — reporting that the goal is not met is exactly what a
    // coordinator is for — but a PASS here is what `assertDoneAllowed` binds a project's DONE to,
    // so it is not a coordinator's to record. Refused before the transaction: nothing written, no
    // lock taken, and the run stays open for whoever does conclude it.
    if (outcomes.some((outcome) => outcome?.verdict === 'PASS')) {
      await this.assertMayConcludePass(ownerId, actingSessionId);
    }
    // Retried whole: the verdict is computed inside the closure from facts read under the project
    // lock, so a re-run recomputes rather than replaying a verdict from a discarded snapshot.
    return withTransactionRetry(this.prisma, async (tx) => {
      await ProjectAcceptanceService.lockProject(tx, projectId, ownerId, 'FOR NO KEY UPDATE');
      const run = await tx.projectAcceptanceRun.findFirst({
        where: { id: runId, projectId },
        include: { criteria: { orderBy: { ordinal: 'asc' } } },
      });
      if (!run) throw new NotFoundException('acceptance run not found');
      if (run.verdict !== null) {
        throw new ConflictException(
          `acceptance run ${uuidToBase62(runId)} already concluded ${run.verdict} — open a new ` +
            'attempt instead',
        );
      }

      const byOrdinal = new Map(run.criteria.map((c) => [c.ordinal, c]));
      const byKey = new Map(run.criteria.map((c) => [c.criterionKey, c]));
      const byDefinitionId = new Map(
        run.criteria.flatMap((c) => c.definitionId ? [[c.definitionId, c] as const] : []),
      );
      const answered = new Map<number, AcceptanceCriterionOutcomeInput>();
      for (const outcome of outcomes) {
        let suppliedDefinitionId: string | undefined;
        if (outcome.criterionId !== undefined) {
          try {
            suppliedDefinitionId = toUuid(outcome.criterionId);
          } catch {
            throw new BadRequestException(`invalid criterionId ${outcome.criterionId}`);
          }
        }
        const criterion = outcome.ordinal !== undefined
          ? byOrdinal.get(outcome.ordinal)
          : outcome.criterionKey !== undefined
            ? byKey.get(outcome.criterionKey)
            : suppliedDefinitionId !== undefined
              ? byDefinitionId.get(suppliedDefinitionId)
              : undefined;
        if (!criterion) {
          throw new BadRequestException(
            `no criterion ${outcome.ordinal ?? outcome.criterionKey ?? outcome.criterionId} in this run's snapshot`,
          );
        }
        if (!Object.values(ProjectAcceptanceVerdict).includes(outcome.verdict)) {
          throw new BadRequestException(
            `criterion ${criterion.ordinal}: verdict must be one of ` +
              Object.values(ProjectAcceptanceVerdict).join(', '),
          );
        }
        answered.set(criterion.ordinal, outcome);
      }
      const missing = run.criteria
        .filter((c) => !answered.has(c.ordinal))
        .map((c) => c.ordinal);
      if (missing.length > 0) {
        throw new BadRequestException(
          `criteria ${missing.join(', ')} have no conclusion — every stated criterion must be ` +
            'judged, because a project-level PASS is the conjunction of them',
        );
      }

      const decidedAt = new Date();
      for (const criterion of run.criteria) {
        const outcome = answered.get(criterion.ordinal)!;
        await tx.projectAcceptanceCriterion.update({
          where: { id: criterion.id },
          data: {
            verdict: outcome.verdict,
            summary: outcome.summary ?? null,
            evidence: (outcome.evidence ?? {}) as Prisma.InputJsonValue,
            evidenceTaskId: outcome.evidenceTaskId ?? null,
            evidenceSessionId: outcome.evidenceSessionId ?? null,
            decidedAt,
          },
        });
      }

      const verdicts = run.criteria.map((c) => answered.get(c.ordinal)!.verdict);
      const verdict = verdicts.every((v) => v === ProjectAcceptanceVerdict.PASS)
        ? ProjectAcceptanceVerdict.PASS
        : verdicts.some((v) => v === ProjectAcceptanceVerdict.FAIL)
          ? ProjectAcceptanceVerdict.FAIL
          : ProjectAcceptanceVerdict.INCONCLUSIVE;

      // Re-read: the run concludes about the world it is committing against, not the one it opened
      // on. A caller whose facts moved underneath it gets a record that says so, and the DONE gate
      // then compares against this value.
      const inputDigest = await this.digest(tx, projectId);
      const resultDigest = acceptanceResultDigest(
        run.id,
        run.criteria.map((c) => ({
          ordinal: c.ordinal,
          criterionKey: c.criterionKey,
          verdict: answered.get(c.ordinal)!.verdict,
        })),
      );

      await tx.$executeRaw(Prisma.sql`
        UPDATE "project_acceptance_run"
           SET "verdict" = ${verdict}::"project_acceptance_verdict",
               "result_digest" = ${resultDigest},
               "input_digest" = ${inputDigest},
               "completed_at" = ${decidedAt}
         WHERE "id" = ${run.id}::uuid`);

      await ProjectAcceptanceService.writeAudit(
        tx, projectId, 'run_finalized', verdict,
        {
          attempt: String(run.attempt),
          verdict,
          inputDigest,
          resultDigest,
          criteria: run.criteria.map((c) => ({
            ordinal: c.ordinal,
            verdict: answered.get(c.ordinal)!.verdict,
          })),
        },
        run.id,
      );
      return this.readRun(tx, run.id);
    }, loggedRetry(this.logger, 'projectAcceptance.finalizeRun'));
  }

  // ------------------------------------------------------------------------------------------
  // Merge evidence (§13.4 AE9)
  // ------------------------------------------------------------------------------------------

  /**
   * The merge-evidence writer (AE9-b), and the only supported way a `contentHash` is written.
   *
   * Same content as the newest row for this `(requirement, branch)` ⇒ only the observation time
   * moves. Different content ⇒ a NEW row at `refGeneration + 1`, which is what makes "the branch
   * changed and changed back" visible to a database that cannot lock a git ref (AE9-a).
   *
   * The reopen that AE9-c requires when this lands on a DONE project is migration 0127's trigger,
   * not code here: an observation arriving through a future webhook path must reopen too.
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
      await ProjectAcceptanceService.lockProject(tx, projectId, ownerId, 'FOR NO KEY UPDATE');
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
      await ProjectAcceptanceService.writeAudit(
        tx, projectId, 'merge_evidence_observed',
        `${requirementId}@${targetBranch}`,
        {
          requirementId,
          targetBranch,
          contentHash,
          refGeneration: String(row.refGeneration),
          previousContentHash: latest?.contentHash ?? null,
        },
      );
      return { ...ProjectAcceptanceService.mergeRow(row), changed: true };
    }, loggedRetry(this.logger, 'projectAcceptance.recordMergeEvidence'));
  }

  // ------------------------------------------------------------------------------------------
  // The DONE hard gate (§13.4 AE2)
  // ------------------------------------------------------------------------------------------

  /**
   * AE2's three steps, in the transaction that is about to write DONE.
   *
   * The caller must already hold AE7's `FOR UPDATE` on the project row — this method does not take
   * it, because taking a lock inside a check is how a check ends up covering a different world than
   * the write it guards.
   *
   * Returns the run the DONE will be bound to. Throws a typed 409 otherwise, and the reason is
   * always one a person can act on: there is no run, the run says something other than PASS, the
   * run's evidence is about a world that has since changed, or the project still has something
   * unresolved in it. Task counts and task statuses are intentionally absent: they are a process
   * measure, while this gate decides whether the stated outcome was achieved.
   */
  async assertDoneAllowed(
    tx: Prisma.TransactionClient,
    projectId: string,
  ): Promise<{ runId: string; attempt: bigint; digest: string }> {
    const digest = await this.digest(tx, projectId);
    return this.assertDoneAllowedForDigest(tx, projectId, digest);
  }

  /** The gate after its acceptance digest has already been read in this transaction.
   *
   * The write path calls {@link assertDoneAllowed}, which computes the digest here under its
   * project lock. The read-only overview has to return that same digest beside the gate result, so
   * it computes it once and enters here directly. Keeping the rest of the decision in one helper
   * prevents a large project from materializing and hashing its complete task set twice merely to
   * describe why it is not DONE. */
  private async assertDoneAllowedForDigest(
    tx: Prisma.TransactionClient,
    projectId: string,
    digest: string,
  ): Promise<{ runId: string; attempt: bigint; digest: string }> {
    // HUMAN_SIGNOFF judgment blockers are projections of OPEN requests, not mutable
    // project_blocker rows. Count both sources at the gate so the read model cannot be bypassed
    // merely because there is intentionally no blocker row for somebody to close by hand.
    const [{ count: openBlockers }] = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT (
        (SELECT count(*) FROM "project_blocker" blocker
          WHERE blocker."project_id" = ${projectId}::uuid
            AND blocker."resolved_at" IS NULL)
        +
        (SELECT count(*) FROM "project_judgment_blocker" judgment
          WHERE judgment."project_id" = ${projectId}::uuid)
      )::int AS "count"
    `);
    // §13.6 SU6: a failure whose verifier or whose subject was REPLACED is a record, not a request
    // — nothing will ever run either of them again, so the later PASS that is the only thing which
    // resolves this row can never arrive. Counting it would make a project that re-ran a failed
    // check from scratch permanently unacceptable, which is precisely the history this project has.
    // Raw rather than Prisma because the predicate is shared verbatim with §7.4's own reader.
    const [{ count: unresolvedFailures }] = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT count(*)::int AS "count"
        FROM "task_verification_failure" f
        JOIN "task" verifier ON verifier."id" = f."verifier_task_id"
        JOIN "task" subject  ON subject."id"  = f."subject_task_id"
       WHERE f."project_id" = ${projectId}::uuid
         AND f."resolved_at" IS NULL
         AND NOT ${Prisma.raw(verificationFailureIsHistorySql())}
    `);
    if (openBlockers > 0 || unresolvedFailures > 0) {
      throw new AcceptanceRefusal(
        ACCEPTANCE_BLOCKED,
        `this project still has ${openBlockers} open blocker(s) and ${unresolvedFailures} ` +
          'unresolved verification failure(s) — a project cannot be finished over something it ' +
          'already knows is unfinished',
        {
          requiredAction: 'resolve the open blockers and verification failures, then re-run acceptance',
          openBlockers,
          unresolvedVerificationFailures: unresolvedFailures,
        },
      );
    }

    const live = await tx.projectAcceptanceRun.findFirst({
      where: { projectId, supersededAt: null },
      orderBy: { attempt: 'desc' },
      include: { criteria: { orderBy: { ordinal: 'asc' } } },
    });
    if (!live || live.verdict === null) {
      const undecided = live?.criteria
        .filter((criterion) => criterion.verdict === null)
        .map((criterion) => `#${criterion.ordinal} ${JSON.stringify(criterion.criterionText)}`)
        .join('; ');
      throw new AcceptanceRefusal(
        ACCEPTANCE_MISSING,
        live === null
          ? 'no project acceptance has been run — DONE is a claim about evidence, and there is ' +
            'none. ' + ACCEPTANCE_FINDING_ROUTING
          : `acceptance run ${uuidToBase62(live.id)} has not concluded; non-PASS criteria: ` +
            `${undecided || 'the run has no undecided criterion row to explain its open summary'}. ` +
            ACCEPTANCE_FINDING_ROUTING,
        {
          requiredAction: (live === null
            ? 'run project acceptance and record a conclusion for every criterion. '
            : 'record a conclusion for every criterion. ') + ACCEPTANCE_FINDING_ROUTING,
          acceptanceDigest: digest,
        },
      );
    }
    if (live.verdict !== ProjectAcceptanceVerdict.PASS) {
      const unmet = live.criteria
        .filter((criterion) => criterion.verdict !== ProjectAcceptanceVerdict.PASS)
        .map((criterion) => ({
          ordinal: criterion.ordinal,
          criterionKey: criterion.criterionKey,
          criterionText: criterion.criterionText,
          verdict: criterion.verdict ?? 'UNDECIDED',
        }));
      const named = unmet
        .map((criterion) =>
          `#${criterion.ordinal} ${JSON.stringify(criterion.criterionText)} (${criterion.verdict})`)
        .join('; ');
      throw new AcceptanceRefusal(
        ACCEPTANCE_MISSING,
        `the latest project acceptance did not PASS these criteria: ` +
          `${named || `the run summary is ${live.verdict}, but no non-PASS criterion row was found`}. ` +
          ACCEPTANCE_FINDING_ROUTING,
        {
          requiredAction: 'fix or re-scope the named criteria, then run a new acceptance. ' +
            ACCEPTANCE_FINDING_ROUTING,
          runId: live.id,
          verdict: live.verdict,
          unmetCriteria: unmet,
          acceptanceDigest: digest,
        },
      );
    }
    // §13.4 AE2 step 2 asks for a PASS whose `decidedBy` is COORDINATOR_AGENT, because clause 2
    // makes acceptance something a coordinator EXECUTES rather than something anyone asserts. A
    // non-PASS conclusion is rejected above for the more useful reason — the named unmet criteria
    // — regardless of who recorded it. Attribution matters only once the outcome could grant DONE.
    if (live.decidedBy !== 'COORDINATOR_AGENT') {
      throw new AcceptanceRefusal(
        ACCEPTANCE_MISSING,
        `the latest project acceptance was concluded by ${live.decidedBy}; §13.4 requires the ` +
          'coordinator agent to run it — do it from a session (CLI `orbit project acceptance-run`, ' +
          'MCP `project_acceptance_run`) rather than by hand',
        {
          requiredAction: 'run acceptance from a coordinator session',
          runId: live.id,
          decidedBy: live.decidedBy,
          acceptanceDigest: digest,
        },
      );
    }
    // Unit L2's epoch (migration 0150). `superseded_at` says the same thing along the paths that
    // remember to write it — `ProjectsService.update`'s DONE → OPEN branch, and 0127's fact-change
    // reopen — and says nothing along the ones that do not: a DONE → CANCELLED → OPEN route (that
    // branch tests `status = DONE`), a raw UPDATE, or a binary that predates the column. The epoch
    // is advanced by the database on every reopen whoever performs it, so this comparison holds
    // where the flag does not.
    //
    // Checked BEFORE the digest because it is the more specific answer AND the one the digest
    // cannot give: a reopen on its own moves none of the acceptance projections, so a project
    // reopened and left otherwise untouched has a PASS whose digest still matches perfectly.
    //
    // `ACCEPTANCE_EVIDENCE_STALE` rather than a new code: PAC §12 E2 forbids a synonym, and "your
    // evidence is about a world that is no longer this one" is what that code already means. The
    // run itself is not touched — a historical conclusion stops being current by being read, not
    // by being rewritten (§13.4's audit is append-only).
    const { acceptanceEpoch } = await tx.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { acceptanceEpoch: true },
    });
    if (live.acceptanceEpoch !== acceptanceEpoch) {
      throw new AcceptanceRefusal(
        ACCEPTANCE_EVIDENCE_STALE,
        `acceptance run ${uuidToBase62(live.id)} passed in acceptance epoch ` +
          `${live.acceptanceEpoch}, and this project is now in epoch ${acceptanceEpoch} — it was ` +
          'reopened after that run, so what it concluded is history rather than a claim about now',
        {
          requiredAction: 'run acceptance again in the current epoch',
          runId: live.id,
          evidenceEpoch: String(live.acceptanceEpoch),
          acceptanceEpoch: String(acceptanceEpoch),
        },
      );
    }
    if (live.inputDigest !== digest) {
      throw new AcceptanceRefusal(
        ACCEPTANCE_EVIDENCE_STALE,
        `acceptance run ${uuidToBase62(live.id)} passed against different acceptance facts — ` +
          'the acceptance criteria or their merge evidence changed since it ran. ' +
          ACCEPTANCE_FINDING_ROUTING,
        {
          requiredAction: 'run acceptance again against the current criteria and evidence. ' +
            ACCEPTANCE_FINDING_ROUTING,
          runId: live.id,
          evidenceDigest: live.inputDigest,
          acceptanceDigest: digest,
        },
      );
    }
    return { runId: live.id, attempt: live.attempt, digest };
  }

  // ------------------------------------------------------------------------------------------
  // Read faces
  // ------------------------------------------------------------------------------------------

  private async readRun(tx: Prisma.TransactionClient, runId: string) {
    const run = await tx.projectAcceptanceRun.findUniqueOrThrow({
      where: { id: runId },
      include: { criteria: { orderBy: { ordinal: 'asc' } } },
    });
    return ProjectAcceptanceService.runRow(run);
  }

  static runRow(run: {
    id: string; projectId: string; attempt: bigint; acceptanceEpoch: bigint; criteriaSnapshot: string;
    criteriaSnapshotV2?: unknown | null;
    criteriaRevision: string; inputDigest: string; resultDigest: string | null;
    verdict: ProjectAcceptanceVerdict | null; decidedBy: string;
    coordinatorAgentId: string | null; coordinatorSessionId: string | null;
    projectActionId: string | null;
    supersededAt: Date | null; supersededReason: string | null;
    startedAt: Date; completedAt: Date | null;
    criteria?: Array<{
      id: string; ordinal: number; criterionKey: string; criterionText: string;
      definitionId?: string | null; definitionRevision?: number | null;
      verdict: ProjectAcceptanceVerdict | null; summary: string | null; evidence: unknown;
      evidenceTaskId: string | null; evidenceSessionId: string | null; decidedAt: Date | null;
    }>;
  }) {
    return {
      id: run.id,
      projectId: run.projectId,
      attempt: String(run.attempt),
      // Which acceptance this run belongs to (migration 0150). String, like `attempt` beside it:
      // a BigInt has no JSON spelling, and a reader comparing it against the project's own epoch
      // needs the two rendered the same way.
      acceptanceEpoch: String(run.acceptanceEpoch),
      verdict: run.verdict,
      decidedBy: run.decidedBy,
      criteriaSnapshot: run.criteriaSnapshot,
      criteriaSnapshotV2: run.criteriaSnapshotV2 ?? null,
      criteriaRevision: run.criteriaRevision,
      inputDigest: run.inputDigest,
      resultDigest: run.resultDigest,
      coordinatorAgentId: run.coordinatorAgentId,
      coordinatorSessionId: run.coordinatorSessionId,
      projectActionId: run.projectActionId,
      supersededAt: run.supersededAt,
      supersededReason: run.supersededReason,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      criteria: (run.criteria ?? []).map((c) => ({
        id: c.id,
        ordinal: c.ordinal,
        criterionKey: c.criterionKey,
        criterionId: c.definitionId ?? null,
        definitionRevision: c.definitionRevision ?? null,
        criterionText: c.criterionText,
        verdict: c.verdict,
        summary: c.summary,
        evidence: c.evidence,
        evidenceTaskId: c.evidenceTaskId,
        evidenceSessionId: c.evidenceSessionId,
        decidedAt: c.decidedAt,
      })),
    };
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
   * Everything a person or a checker needs to answer "may this project be DONE, and if not, why"
   * (AC10 / AC12), in one read.
   *
   * `doneGate` is the same decision `assertDoneAllowed` makes, evaluated as a read: it is served
   * rather than only enforced so that a UI can say what is missing before somebody presses a button
   * and gets a 409. It is NOT authority — the gate that decides runs inside the writing transaction
   * under `FOR UPDATE`, and this read holds no lock.
   */
  async overview(ownerId: string, projectId: string, limit = 20) {
    await this.assertOwned(projectId, ownerId);
    const runs = await this.prisma.projectAcceptanceRun.findMany({
      where: { projectId },
      orderBy: [{ attempt: 'desc' }],
      take: Math.min(Math.max(limit, 1), 100),
      include: { criteria: { orderBy: { ordinal: 'asc' } } },
    });
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: {
        status: true, acceptanceCriteria: true, acceptedRunId: true, legacyAcceptedAt: true,
      },
    });
    const merges = await this.prisma.$queryRaw<Array<{
      id: string; projectId: string; requirementId: string; targetBranch: string;
      contentHash: string; refGeneration: bigint; source: string; detail: unknown;
      observedAt: Date; lastSeenAt: Date;
    }>>(Prisma.sql`
      SELECT DISTINCT ON (m."requirement_id", m."target_branch")
             m."id", m."project_id" AS "projectId", m."requirement_id" AS "requirementId",
             m."target_branch" AS "targetBranch", m."content_hash" AS "contentHash",
             m."ref_generation" AS "refGeneration", m."source", m."detail",
             m."observed_at" AS "observedAt", m."last_seen_at" AS "lastSeenAt"
        FROM "project_merge_evidence" m
       WHERE m."project_id" = ${projectId}::uuid
       ORDER BY m."requirement_id", m."target_branch", m."ref_generation" DESC
    `);
    const audit = await this.prisma.projectAcceptanceAudit.findMany({
      where: { projectId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
    });

    const evaluated = await this.evaluateGate(projectId);

    const criteria = await ProjectAcceptanceService.statedCriteria(
      this.prisma as unknown as Prisma.TransactionClient,
      projectId,
      project.acceptanceCriteria,
    );
    return {
      projectId,
      status: project.status,
      criteria: criteria.map((c) => ({
        ordinal: c.ordinal,
        criterionId: c.definitionId,
        criterionKey: c.key,
        criterionText: c.text,
      })),
      criteriaEmptyReason: criteria.length > 0 ? null : 'NO_ACCEPTANCE_CRITERIA',
      acceptanceDigest: evaluated.digest,
      acceptedRunId: project.acceptedRunId,
      legacyAcceptedAt: project.legacyAcceptedAt,
      legacyEvidence: project.legacyAcceptedAt !== null && project.acceptedRunId === null,
      doneGate: {
        allowed: evaluated.allowed,
        runId: evaluated.runId,
        refusalCode: evaluated.code,
        reason: evaluated.reason,
      },
      runs: runs.map((r) => ProjectAcceptanceService.runRow(r)),
      runsEmptyReason: runs.length > 0 ? null : 'ACCEPTANCE_NOT_ATTEMPTED',
      mergeEvidence: merges.map((m) => ProjectAcceptanceService.mergeRow(m)),
      mergeEvidenceEmptyReason: merges.length > 0 ? null : 'NO_MERGE_EVIDENCE',
      audit: audit.map((row) => ({
        id: row.id,
        kind: row.kind,
        runId: row.runId,
        reason: row.reason,
        detail: row.detail,
        createdAt: row.createdAt,
      })),
    };
  }

  /**
   * The DONE gate, evaluated as a READ.
   *
   * Same decision `assertDoneAllowed` makes and the same code path, so a client cannot be told one
   * thing and refused another. It holds no lock and grants nothing — the gate that DECIDES runs
   * inside the transaction that writes DONE, under `FOR UPDATE` (§13.4 AE7). One transaction all
   * the same: a digest assembled from separately-timed reads describes no world at all.
   */
  async evaluateGate(projectId: string): Promise<{
    digest: string;
    allowed: boolean;
    runId: string | null;
    code: AcceptanceRefusalCode | null;
    reason: string | null;
  }> {
    // Retried whole: the gate reads the project acceptance standing under the project lock and
    // decides from that read alone. Task status is not an input.
    return withTransactionRetry(this.prisma, async (tx) => {
      const digest = await this.digest(tx, projectId);
      try {
        const allowed = await this.assertDoneAllowedForDigest(tx, projectId, digest);
        return { digest, allowed: true, runId: allowed.runId, code: null, reason: null };
      } catch (e) {
        if (e instanceof AcceptanceRefusal) {
          const body = e.getResponse() as { code: AcceptanceRefusalCode; message: string };
          return { digest, allowed: false, runId: null, code: body.code, reason: body.message };
        }
        throw e;
      }
    }, loggedRetry(this.logger, 'projectAcceptance.evaluateGate', {
      // Digesting is linear in the number of tasks. Prisma's five-second default is smaller than
      // one legitimate large-project read, and expiring it also holds a pool connection long
      // enough to make unrelated runner requests fail while the client unwinds. This is a ceiling,
      // not a delay: ordinary projects still commit immediately.
      transaction: { timeout: 30_000, maxWait: 10_000 },
    }));
  }

  /**
   * The RESULT indicator for a project detail page: how many stated criteria the latest acceptance
   * attempt has concluded PASS about, and what each one currently says.
   *
   * The detail read already answers "how much of the work is done" with a task tally, which is a
   * PROCESS measure — it can reach 100% while the thing the project was for is unmet. This is the
   * other half, and it comes from `project_acceptance_criterion` rather than from anybody's
   * summary prose.
   *
   * Only the LATEST attempt is read, by `attempt` descending. A criterion key appears once per run
   * it was judged in, so a read that gathered rows by key across runs would mix last week's PASS
   * into this week's checklist and report a project as further along than any single attempt ever
   * concluded. `attempt` rather than `supersededAt is null`, because the newest run is superseded
   * too once a fact moves underneath a DONE (§13.4 AE8) — and after that, the newest LIVE run is an
   * older one whose verdicts are exactly the stale ones this must not report.
   *
   * A project that has never been run against is not an error and not an empty list: its criteria
   * are stated, they are simply unjudged, so they are listed from the stated text with
   * `ACCEPTANCE_UNDECIDED` — the same placeholder a criterion the current run has not reached
   * carries. Undecided is spelled as a value rather than as `null` so that a client renders "not
   * judged yet" instead of having to distinguish absent-because-unjudged from absent-because-the
   * -field-was-not-served.
   *
   * Current definitions are the list being reported. A latest run whose semantic revision differs
   * is history, not partial progress against today's checklist, so the current rows report
   * UNDECIDED. A pure reorder keeps the revision and the verdicts are remapped by stable definition
   * id into the new presentation order. Pre-v3 runs stored a differently shaped revision, so their
   * immutable criterion rows are re-hashed under today's content rule for DISPLAY only; the DONE
   * gate still rejects their older digestVersion and therefore never upgrades evidence by inference.
   */
  async criteriaSummary(
    projectId: string,
    acceptanceCriteria: string | null,
  ): Promise<ProjectAcceptanceCriteriaSummary> {
    const stated = await ProjectAcceptanceService.statedCriteria(
      this.prisma as unknown as Prisma.TransactionClient,
      projectId,
      acceptanceCriteria,
    );
    const unjudged = (lastRunAt: Date | null = null): ProjectAcceptanceCriteriaSummary => ({
      total: stated.length,
      passed: 0,
      // A run against an older definition is stale progress, not no history. Keeping its timestamp
      // distinguishes "never judged" from "judged before the exam changed" while every current
      // criterion correctly remains UNDECIDED.
      lastRunAt,
      criteria: stated.map((criterion) => ({
        id: criterion.definitionId ?? `legacy:${criterion.ordinal}:${criterion.key}`,
        key: criterion.key,
        text: criterion.text,
        ordinal: criterion.ordinal,
        verdict: ACCEPTANCE_UNDECIDED,
        summary: null,
        decidedAt: null,
        evidenceTaskId: null,
      })),
    });
    const latest = await this.prisma.projectAcceptanceRun.findFirst({
      where: { projectId },
      orderBy: { attempt: 'desc' },
      include: { criteria: { orderBy: { ordinal: 'asc' } } },
    });
    if (latest === null) return unjudged();
    const latestSemanticRevision = latest.digestVersion === ACCEPTANCE_DIGEST_VERSION
      ? latest.criteriaRevision
      : latest.digestVersion < ACCEPTANCE_DIGEST_VERSION
        ? criteriaSemanticRevision(latest.criteria.map((criterion) => ({
            text: criterion.criterionText,
          })))
        : null;
    if (latestSemanticRevision !== criteriaSemanticRevision(stated)) {
      return unjudged(latest.completedAt ?? latest.startedAt);
    }

    const byDefinition = new Map(
      latest.criteria.flatMap((criterion) => criterion.definitionId
        ? [[criterion.definitionId, criterion] as const]
        : []),
    );
    const byKey = new Map<string, typeof latest.criteria>();
    for (const criterion of latest.criteria) {
      const rows = byKey.get(criterion.criterionKey) ?? [];
      rows.push(criterion);
      byKey.set(criterion.criterionKey, rows);
    }
    const usedRunRows = new Set<string>();
    const criteria = stated.map((definition) => {
      let judged = definition.definitionId
        ? byDefinition.get(definition.definitionId)
        : undefined;
      if (!judged) {
        judged = (byKey.get(definition.key) ?? []).find((row) => !usedRunRows.has(row.id));
      }
      if (judged) usedRunRows.add(judged.id);
      return {
        id: definition.definitionId ?? `legacy:${definition.ordinal}:${definition.key}`,
        key: definition.key,
        text: definition.text,
        ordinal: definition.ordinal,
        verdict: judged?.verdict ?? ACCEPTANCE_UNDECIDED,
        summary: judged?.summary ?? null,
        decidedAt: judged?.decidedAt ?? null,
        evidenceTaskId: judged?.evidenceTaskId ?? null,
      };
    });
    return {
      total: criteria.length,
      passed: criteria.filter((c) => c.verdict === ProjectAcceptanceVerdict.PASS).length,
      // When it concluded, or — for an attempt still open — when it started. Either way the answer
      // to "when was acceptance last looked at", which is what a page shows next to the tally.
      lastRunAt: latest.completedAt ?? latest.startedAt,
      criteria,
    };
  }

  /** The compact form the coordinator status endpoint embeds — the latest live run and whether the
   *  gate would open, without the full history. */
  async summary(projectId: string) {
    const live = await this.prisma.projectAcceptanceRun.findFirst({
      where: { projectId, supersededAt: null },
      orderBy: { attempt: 'desc' },
      include: { criteria: { orderBy: { ordinal: 'asc' } } },
    });
    const latest = live ?? await this.prisma.projectAcceptanceRun.findFirst({
      where: { projectId },
      orderBy: { attempt: 'desc' },
      include: { criteria: { orderBy: { ordinal: 'asc' } } },
    });
    return latest === null ? null : ProjectAcceptanceService.runRow(latest);
  }

  /** A stable id for a run opened by one pass, so a retry of that pass finds the run it made.
   *  Same shape as §8.2's action keys, and public-id spelled for the same reason (§7.3). */
  static runIdempotencyKey(projectId: string, attempt: bigint): string {
    return `pc:v1:${projectId}:acceptance:${attempt}`;
  }
}
