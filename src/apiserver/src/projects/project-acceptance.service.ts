import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ProjectAcceptanceVerdict, ProjectStatus } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  ACCEPTANCE_BLOCKED,
  ACCEPTANCE_EVIDENCE_STALE,
  ACCEPTANCE_MISSING,
  AcceptanceFacts,
  AcceptanceRefusalCode,
  ParsedCriterion,
  acceptanceDigest,
  acceptanceResultDigest,
  parseCriteria,
  sha256,
} from './project-acceptance';

/** What a caller may say when opening a run. Both attributions are historical ids: they record who
 *  ran an acceptance, and nothing later may rewrite that by deleting a session. */
export interface OpenAcceptanceRunInput {
  decidedBy: 'COORDINATOR_AGENT' | 'USER';
  coordinatorAgentId?: string | null;
  coordinatorSessionId?: string | null;
  decisionId?: string | null;
  projectActionId?: string | null;
}

export interface AcceptanceCriterionOutcomeInput {
  ordinal?: number;
  criterionKey?: string;
  verdict: ProjectAcceptanceVerdict;
  summary?: string | null;
  evidence?: Record<string, unknown>;
  evidenceTaskId?: string | null;
  evidenceSessionId?: string | null;
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
 * mechanical answer, and re-opening one task could not invalidate anything.
 *
 * What is here instead is one row per attempt (`project_acceptance_run`), one row per stated
 * criterion (`project_acceptance_criterion`), a digest of the facts the attempt judged
 * (`inputDigest`, AE1), a digest of what it concluded (`resultDigest`), and a hard gate that
 * recomputes the first of those inside the transaction that writes DONE. Everything a caller can
 * do that would change the answer either moves the digest or supersedes the run — and the writes
 * that could do it behind the service's back are caught by migration 0127's triggers rather than by
 * a convention.
 */
@Injectable()
export class ProjectAcceptanceService {
  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------------------------------
  // Facts and digests
  // ------------------------------------------------------------------------------------------

  /**
   * AE1's four projections, read from the current rows.
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

    const tasks = await tx.task.findMany({
      where: { projectId },
      select: {
        id: true, status: true, completionPolicy: true, verifiesTaskId: true, verdict: true,
      },
    });
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
      criteriaRevision: sha256(project.acceptanceCriteria ?? ''),
      taskSet: tasks.map((t) => [t.id, t.status, t.completionPolicy] as [string, string, string]),
      verdicts: tasks
        .filter((t) => t.verifiesTaskId !== null)
        .map((t) => [t.id, t.verifiesTaskId!, t.verdict ?? 'PENDING'] as [string, string, string]),
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
    return this.prisma.$transaction(async (tx) => {
      const locked = await ProjectAcceptanceService.lockProject(
        tx, projectId, ownerId, 'FOR NO KEY UPDATE',
      );
      if (locked.status === ProjectStatus.CANCELLED) {
        throw new ConflictException('this project is cancelled — acceptance would decide nothing');
      }
      const criteria = parseCriteria(locked.acceptanceCriteria);
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
          criteriaSnapshot: locked.acceptanceCriteria ?? '',
          criteriaRevision: facts.criteriaRevision,
          inputDigest,
          decidedBy: input.decidedBy,
          coordinatorAgentId: input.coordinatorAgentId ?? null,
          coordinatorSessionId: input.coordinatorSessionId ?? null,
          decisionId: input.decisionId ?? null,
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
        })),
      });
      await ProjectAcceptanceService.writeAudit(
        tx, projectId, 'run_opened', `attempt ${attempt}`,
        { attempt: String(attempt), inputDigest, criteria: criteria.length }, run.id,
      );
      return this.readRun(tx, run.id);
    });
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
  ) {
    if (!Array.isArray(outcomes) || outcomes.length === 0) {
      throw new BadRequestException('a verdict must state a conclusion for every criterion');
    }
    return this.prisma.$transaction(async (tx) => {
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
      const answered = new Map<number, AcceptanceCriterionOutcomeInput>();
      for (const outcome of outcomes) {
        const criterion = outcome.ordinal !== undefined
          ? byOrdinal.get(outcome.ordinal)
          : outcome.criterionKey !== undefined
            ? byKey.get(outcome.criterionKey)
            : undefined;
        if (!criterion) {
          throw new BadRequestException(
            `no criterion ${outcome.ordinal ?? outcome.criterionKey} in this run's snapshot`,
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
    });
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
    return this.prisma.$transaction(async (tx) => {
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
    });
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
   * unresolved in it.
   */
  async assertDoneAllowed(
    tx: Prisma.TransactionClient,
    projectId: string,
  ): Promise<{ runId: string; attempt: bigint; digest: string }> {
    const digest = await this.digest(tx, projectId);

    const openBlockers = await tx.projectBlocker.count({
      where: { projectId, resolvedAt: null },
    });
    const unresolvedFailures = await tx.taskVerificationFailure.count({
      where: { projectId, resolvedAt: null },
    });
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
    });
    if (!live || live.verdict === null) {
      throw new AcceptanceRefusal(
        ACCEPTANCE_MISSING,
        live === null
          ? 'no project acceptance has been run — DONE is a claim about evidence, and there is none'
          : `acceptance run ${uuidToBase62(live.id)} has not concluded yet`,
        {
          requiredAction: 'run project acceptance and record a conclusion for every criterion',
          acceptanceDigest: digest,
        },
      );
    }
    // §13.4 AE2 step 2 asks for a record whose `decidedBy` is COORDINATOR_AGENT, because clause 2
    // makes acceptance something a coordinator EXECUTES rather than something anyone asserts. A run
    // recorded by a person is kept — it is a real record of a real check — but it does not open
    // this gate on its own, and the refusal says which half is missing rather than reading as "no
    // acceptance exists" when one plainly does.
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
    if (live.verdict !== ProjectAcceptanceVerdict.PASS) {
      throw new AcceptanceRefusal(
        ACCEPTANCE_MISSING,
        `the latest project acceptance concluded ${live.verdict}, not PASS`,
        {
          requiredAction: 'fix what the acceptance found, then run a new acceptance',
          runId: live.id,
          verdict: live.verdict,
          acceptanceDigest: digest,
        },
      );
    }
    if (live.inputDigest !== digest) {
      throw new AcceptanceRefusal(
        ACCEPTANCE_EVIDENCE_STALE,
        `acceptance run ${uuidToBase62(live.id)} passed against a different set of facts — a ` +
          'task, a verdict, the acceptance criteria or the merge evidence has changed since it ran',
        {
          requiredAction: 'run acceptance again against the current facts',
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
    id: string; projectId: string; attempt: bigint; criteriaSnapshot: string;
    criteriaRevision: string; inputDigest: string; resultDigest: string | null;
    verdict: ProjectAcceptanceVerdict | null; decidedBy: string;
    coordinatorAgentId: string | null; coordinatorSessionId: string | null;
    decisionId: string | null; projectActionId: string | null;
    supersededAt: Date | null; supersededReason: string | null;
    startedAt: Date; completedAt: Date | null;
    criteria?: Array<{
      id: string; ordinal: number; criterionKey: string; criterionText: string;
      verdict: ProjectAcceptanceVerdict | null; summary: string | null; evidence: unknown;
      evidenceTaskId: string | null; evidenceSessionId: string | null; decidedAt: Date | null;
    }>;
  }) {
    return {
      id: run.id,
      projectId: run.projectId,
      attempt: String(run.attempt),
      verdict: run.verdict,
      decidedBy: run.decidedBy,
      criteriaSnapshot: run.criteriaSnapshot,
      criteriaRevision: run.criteriaRevision,
      inputDigest: run.inputDigest,
      resultDigest: run.resultDigest,
      coordinatorAgentId: run.coordinatorAgentId,
      coordinatorSessionId: run.coordinatorSessionId,
      decisionId: run.decisionId,
      projectActionId: run.projectActionId,
      supersededAt: run.supersededAt,
      supersededReason: run.supersededReason,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      criteria: (run.criteria ?? []).map((c) => ({
        id: c.id,
        ordinal: c.ordinal,
        criterionKey: c.criterionKey,
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

    const criteria = parseCriteria(project.acceptanceCriteria);
    return {
      projectId,
      status: project.status,
      criteria: criteria.map((c: ParsedCriterion) => ({
        ordinal: c.ordinal, criterionKey: c.key, criterionText: c.text,
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
   * the same: a digest assembled from four separately-timed reads describes no world at all.
   */
  async evaluateGate(projectId: string): Promise<{
    digest: string;
    allowed: boolean;
    runId: string | null;
    code: AcceptanceRefusalCode | null;
    reason: string | null;
  }> {
    return this.prisma.$transaction(async (tx) => {
      const digest = await this.digest(tx, projectId);
      try {
        const allowed = await this.assertDoneAllowed(tx, projectId);
        return { digest, allowed: true, runId: allowed.runId, code: null, reason: null };
      } catch (e) {
        if (e instanceof AcceptanceRefusal) {
          const body = e.getResponse() as { code: AcceptanceRefusalCode; message: string };
          return { digest, allowed: false, runId: null, code: body.code, reason: body.message };
        }
        throw e;
      }
    });
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
