import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import {
  ConvergenceCounters,
  ConvergenceThresholds,
  ScopeAuthorization,
  ZERO_COUNTERS,
  resolveThresholds,
} from './convergence-contract';
import {
  AcceptanceEvidence,
  BlockerEvidence,
  DerivedProgress,
  EvidenceSnapshot,
  FindingEvidence,
  FindingSeverity,
  deriveProgressVector,
} from './convergence-evidence';
import { ProgressVector, scopeHash } from './convergence-progress';
import {
  PROJECT_NOT_CONVERGING,
  PlannedWakeConvergence,
  WakeConvergenceOutcome,
  WakeConvergenceState,
  noProgressBlocker,
  noProgressDedupeKey,
  planWakeConvergence,
  wakeConvergenceKey,
} from './coordinator-convergence';
import { WakeFact } from './coordinator-wake';
import { WakeAuthorization, WakeAuthorizer, WakeClaim } from './coordinator-wake.service';
import { parseCriteria } from './project-acceptance';

/**
 * `[T4]`: the durable half — the progress ledger, and the stop.
 *
 * WHAT THIS UNIT DOES
 * ===================
 * It answers one question about one committed wake: given everything the database says about this
 * project, is the coordinator still getting closer to acceptance, and may it go on being woken? It
 * writes the answer down (`project_convergence_decision`), and where the answer is no it raises the
 * one `project_blocker` a person can act on.
 *
 * It does NOT open sessions, choose tasks, judge failures or hold a timer. Those belong to T3 and
 * to the coordinator itself. What is here is the accounting and the brake.
 *
 * WHERE IT ATTACHES
 * =================
 * To T2's `WakeAuthorizer` seam, which is the reason that seam has the shape it has: the authorizer
 * is handed the CLAIM, so it cannot run before the database has picked a winner, and a refusal
 * releases the key rather than burning it. So a stopped project refuses every wake it is given and
 * the facts behind them stay deliverable — the moment the project starts converging again (or a
 * person restates what it is asking for), the same facts wake it.
 *
 * Compose it LAST, after the cheaper refusals. A judgment recorded here charges the budget, and a
 * wake refused afterwards by somebody else would have spent a pass the coordinator never got.
 *
 * WHY THE MEASUREMENT IS A READ AND NOT AN ARGUMENT
 * =================================================
 * `convergence-evidence.ts` states the rule the incident needed: the vector is 「由证据推导，无人手
 * 写」. Every existing caller of the task ledger passes a `ProgressVector` it computed itself, which
 * is exactly the hole — a caller that computes its own vector can claim any improvement it likes,
 * and the four "since last progress" counters zero themselves on its word. This service reads the
 * four projections out of committed rows under the project's own row lock and hands them to
 * `deriveProgressVector`. Nobody gets to pass one in.
 *
 * The snapshot is a measurement of NOW: every item is stamped `asOf`, because every item was read
 * live from a committed row at that instant, and a row read now is a fact observed now. PV6's fence
 * still does its one job at this scope — an EMPTY snapshot reads `UNMEASURED` rather than `FRESH`,
 * so a project with nothing to converge toward cannot claim it closed everything.
 */
@Injectable()
export class CoordinatorConvergenceService {
  private readonly logger = new Logger(CoordinatorConvergenceService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * T2's authorizer, made of this unit's answer.
   *
   * A property field rather than a method so that `wakes.claim(fact, convergence.authorizeWake)`
   * carries its own `this` — a producer handing the bare method across would get an authorizer that
   * throws, and `CoordinatorWakeService.claim` treats a throw as "release the key and re-raise",
   * which would make a wiring mistake look like a transient failure.
   */
  readonly authorizeWake: WakeAuthorizer = async (
    fact: WakeFact,
    claim: WakeClaim,
  ): Promise<WakeAuthorization> => {
    const decision = await this.judge(fact, claim);
    return decision.outcome === 'PROCEED'
      ? { allowed: true }
      : { allowed: false, refusalCode: PROJECT_NOT_CONVERGING };
  };

  /**
   * Judge one wake and commit the judgment.
   *
   * The order inside the transaction is load-bearing:
   *
   *  1. lock the project row, which serialises every writer on this project and makes steps 2 and 5
   *     decisions rather than guesses;
   *  2. look the idempotency key up FIRST. A redelivered fact returns the committed judgment having
   *     written nothing — not a second counter charge, and not a second blocker;
   *  3. measure the world, from committed rows only;
   *  4. plan, in `convergence-progress`'s frozen order;
   *  5. raise the blocker if this is the TRANSITION into a stop, and only then;
   *  6. insert the ledger row, which is what makes the counters survive the process.
   */
  async judge(fact: WakeFact, wake: WakeClaim): Promise<RecordedWakeConvergence> {
    return withTransactionRetry(this.prisma, async (tx) => {
      const project = await this.lockProject(tx, fact.projectId);
      const key = wakeConvergenceKey(fact.projectId, project.scopeHash, wake.idempotencyKey);

      const committed = await this.byKey(tx, key);
      if (committed) return { ...committed, duplicate: true };

      const state = await this.readState(tx, fact.projectId);
      // One instant for the whole judgment: the snapshot's `asOf`, every evidence item's
      // `observedAt`, and the row's own `observed_at`. Two clocks a few milliseconds apart would
      // make the ledger say the measurement was taken at a time the measurement does not agree with.
      const observedAt = new Date();
      const derived = await this.measure(tx, fact.projectId, project, observedAt);
      const planned = planWakeConvergence(
        fact.projectId,
        state,
        { wakeKey: wake.idempotencyKey, event: fact.event, derived, observedAt },
        project.thresholds,
      );

      const blockerId = planned.raisesBlocker
        ? await this.raiseBlocker(tx, fact, wake, planned, observedAt)
        : null;

      const id = randomUUID();
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "project_convergence_decision" (
          "id", "project_id", "wake_id", "seq", "idempotency_key", "input_hash", "input",
          "event", "scope_hash", "previous_progress_vector", "progress_vector",
          "progress_vector_digest", "progressed", "evidence_freshness", "evidence_as_of",
          "counters", "thresholds", "non_convergence_reason", "observed", "crossed_limit",
          "outcome", "blocker_id", "observed_at"
        ) VALUES (
          ${id}::uuid, ${fact.projectId}::uuid, ${wake.wakeId}::uuid, ${BigInt(state.nextSeq)},
          ${planned.idempotencyKey}, ${planned.inputHash}, ${JSON.stringify(planned.input)}::jsonb,
          ${planned.input.event}, ${planned.scopeHash},
          ${planned.previousProgressVector === null
            ? null
            : JSON.stringify(planned.previousProgressVector)}::jsonb,
          ${JSON.stringify(planned.progressVector)}::jsonb, ${planned.progressVectorDigest},
          ${planned.progressed}, ${planned.evidenceFreshness}, ${planned.evidenceAsOf},
          ${JSON.stringify(planned.counters)}::jsonb,
          ${JSON.stringify(project.thresholds)}::jsonb,
          ${planned.nonConvergenceReason}, ${planned.observed}, ${planned.limit},
          ${planned.outcome}, ${blockerId}::uuid, ${observedAt}
        )
      `);

      return {
        id,
        idempotencyKey: planned.idempotencyKey,
        outcome: planned.outcome,
        progressed: planned.progressed,
        counters: planned.counters,
        progressVector: planned.progressVector,
        previousProgressVector: planned.previousProgressVector,
        nonConvergenceReason: planned.nonConvergenceReason,
        raisedBlockerId: blockerId,
        duplicate: false,
      };
    }, loggedRetry(this.logger, 'coordinatorConvergence.judge'));
  }

  /**
   * What the ledger says this project's convergence state is — the read a restart resumes from.
   *
   * There is no column anywhere holding these numbers, deliberately: a second home for a counter is
   * a second thing that can be reset, and the whole of this unit's red line is that a restart must
   * not give the project a fresh budget. The last committed row IS the state.
   */
  async state(projectId: string): Promise<WakeConvergenceState & { decisions: number }> {
    const state = await this.readState(this.prisma, projectId);
    return {
      scopeHash: state.scopeHash,
      counters: state.counters,
      progressVector: state.progressVector,
      lastOutcome: state.lastOutcome,
      decisions: state.nextSeq - 1,
    };
  }

  /** The thresholds in force for a project, resolved — what `null` in the column actually means. */
  async thresholds(projectId: string): Promise<ConvergenceThresholds> {
    return (await this.readProject(this.prisma, projectId)).thresholds;
  }

  /**
   * §4, measured: the four projections `deriveProgressVector` folds into a vector.
   *
   * Each one is read from committed rows and stamped `asOf`, which is the honest reading — the
   * snapshot is not assembled from cached observations of varying age, it is one look at the
   * database taken under the project's row lock.
   */
  private async measure(
    tx: Prisma.TransactionClient | PrismaService,
    projectId: string,
    project: ProjectScope,
    asOf: Date,
  ): Promise<DerivedProgress> {

    // 1. Acceptance. The stated criteria are the denominator whether or not anybody has judged them
    //    (`parseCriteria` is the one place that decides what "one criterion" is); the live run's
    //    per-criterion verdicts are the numerator. A criterion nobody has judged is not closed,
    //    which is the correct reading of "no evidence" — never "assume passing".
    const verdicts = await tx.$queryRaw<Array<{ criterionKey: string; verdict: string | null }>>(Prisma.sql`
      SELECT c."criterion_key" AS "criterionKey", c."verdict"::text AS "verdict"
        FROM "project_acceptance_criterion" c
        JOIN "project_acceptance_run" r ON r."id" = c."run_id"
       WHERE r."project_id" = ${projectId}::uuid AND r."superseded_at" IS NULL
    `);
    const passed = new Set(
      verdicts.filter((row) => row.verdict === 'PASS').map((row) => row.criterionKey),
    );
    const acceptance: AcceptanceEvidence[] = parseCriteria(project.acceptanceCriteria)
      .map((criterion) => ({
        id: criterion.key,
        closed: passed.has(criterion.key),
        observedAt: asOf,
      }));

    // 2. Findings, for `openP0` / `openP1`. A finding is closed when the defect task it filed
    //    reached DONE, and open otherwise — including when it filed none (its consequence is a
    //    blocker, counted below) and when somebody deleted the defect, which `SetNull` leaves
    //    visible on purpose. Counting one fact on two axes cannot manufacture an improvement:
    //    `strictlyImproves` needs every axis to hold and one to move, so a double count moves both
    //    the same way or neither.
    const findings = await tx.$queryRaw<Array<{
      fingerprint: string;
      severity: string;
      closed: boolean;
    }>>(Prisma.sql`
      SELECT f."failure_fingerprint" AS "fingerprint", f."severity",
             (d."status" = 'DONE') AS "closed"
        FROM "task_verification_finding" f
        LEFT JOIN "task" d ON d."id" = f."effect_task_id"
       WHERE f."project_id" = ${projectId}::uuid
    `);

    // 3. Blockers — every one of them EXCEPT this unit's own stop-loss row.
    //
    //    The exclusion is what keeps the measurement independent of the thing doing the measuring.
    //    Counted, the breaker's own output would enter the next vector as a defect: whether
    //    clearing it read as "the work improved" would then depend on whether a fact happened to
    //    arrive while it was open, and the coordinator would resume — or not — for a reason that
    //    is about the breaker's history rather than about the project. Left out, the rule is one
    //    sentence a person can act on: closing this row changes nothing, and the coordinator comes
    //    back when the work moves, when the project is re-scoped, or when somebody raises the
    //    limit on purpose.
    //
    //    Every OTHER blocker is counted, including a second episode of this kind on a subject that
    //    is not the project, because those are real things standing between the project and its
    //    acceptance — `assertDoneAllowed` refuses a project that has any open blocker at all.
    const blockers = await tx.$queryRaw<Array<{ key: string; resolved: boolean }>>(Prisma.sql`
      SELECT b."dedupe_key" || ':' || b."lifecycle_generation"::text AS "key",
             (b."resolved_at" IS NOT NULL) AS "resolved"
        FROM "project_blocker" b
       WHERE b."project_id" = ${projectId}::uuid
         AND b."dedupe_key" <> ${noProgressDedupeKey(projectId)}
    `);

    const snapshot: EvidenceSnapshot = {
      scopeHash: project.scopeHash,
      acceptance,
      findings: findings.map((row): FindingEvidence => ({
        fingerprint: row.fingerprint,
        severity: row.severity as FindingSeverity,
        resolved: row.closed === true,
        // §4 counts regressions separately from severity — "a P1 that used to pass" — and nothing
        // committed records that today. Zero rather than a guess: a dimension inferred from
        // something that is not it is a dimension that can move for the wrong reason.
        regression: false,
        observedAt: asOf,
      })),
      blockers: blockers.map((row): BlockerEvidence => ({
        key: row.key,
        resolved: row.resolved === true,
        observedAt: asOf,
      })),
      // §7 CP1: only an ACCEPTED checkpoint is a known-good baseline, and a project has no such
      // row — `project_merge_evidence` describes what a branch contained, which is not the same
      // claim. Null keeps PV5's one unbounded dimension out of reach: a checkpoint that could be
      // MOVED would let "I pushed another commit" zero the counters for ever.
      checkpoint: null,
      asOf,
      // The absolute horizon only. There is no attempt whose start this measurement has to be
      // newer than — a wake is not an attempt — and inventing a fence would refuse progress claims
      // for a reason that is not about the work.
      notBefore: null,
    };
    return deriveProgressVector(snapshot);
  }

  /**
   * §11: the row a person acts on, inserted at most once per episode.
   *
   * `ON CONFLICT DO NOTHING` against the partial unique index over OPEN rows is the second guard,
   * not the first: the planner has already refused to raise while a stop is committed, and this is
   * what holds if two writers reach the same edge at once. `lifecycle_generation` is allocated
   * `MAX + 1` over the key's whole history so that a genuinely new episode — a project that
   * converged again, stalled again and crossed the line again — is a NEW row rather than the old
   * one seen twice.
   */
  private async raiseBlocker(
    tx: Prisma.TransactionClient,
    fact: WakeFact,
    wake: WakeClaim,
    planned: PlannedWakeConvergence,
    observedAt: Date,
  ): Promise<string | null> {
    const blocker = noProgressBlocker(fact.projectId, planned, {
      wakeId: wake.wakeId,
      event: fact.event,
      idempotencyKey: wake.idempotencyKey,
    });
    const id = randomUUID();
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO "project_blocker" (
        "id", "project_id", "kind", "owner", "recovery", "severity", "required_action",
        "next_check_at", "subject_type", "subject_id", "detail", "dedupe_key",
        "lifecycle_generation", "condition_version", "first_seen_at", "last_seen_at", "updated_at"
      )
      SELECT ${id}::uuid, ${fact.projectId}::uuid, ${blocker.kind},
             ${blocker.owner}::"project_blocker_owner",
             ${blocker.recovery}::"project_blocker_recovery",
             ${blocker.severity}::"project_blocker_severity",
             ${blocker.requiredAction}, ${blocker.nextCheckAt}, ${blocker.subjectType},
             ${blocker.subjectId}, ${JSON.stringify(blocker.detail)}::jsonb,
             ${blocker.dedupeKey},
             coalesce(max(b."lifecycle_generation"), 0) + 1,
             ${blocker.conditionVersion}, ${observedAt}, ${observedAt}, ${observedAt}
        FROM "project_blocker" b
       WHERE b."project_id" = ${fact.projectId}::uuid AND b."dedupe_key" = ${blocker.dedupeKey}
      ON CONFLICT ("project_id", "dedupe_key") WHERE "resolved_at" IS NULL DO NOTHING
      RETURNING "id"
    `);
    return rows[0]?.id ?? null;
  }

  /** The project row, locked, plus what it is asking for and the thresholds in force. */
  private async lockProject(
    tx: Prisma.TransactionClient,
    projectId: string,
  ): Promise<ProjectScope> {
    await tx.$executeRaw(Prisma.sql`
      SELECT "id" FROM "project" WHERE "id" = ${projectId}::uuid FOR NO KEY UPDATE
    `);
    return this.readProject(tx, projectId);
  }

  private async readProject(
    tx: Prisma.TransactionClient | PrismaService,
    projectId: string,
  ): Promise<ProjectScope> {
    const [row] = await tx.$queryRaw<Array<{
      title: string;
      goal: string | null;
      acceptanceCriteria: string | null;
      thresholdOverrides: unknown;
      unboundedAuthorizedBy: string | null;
    }>>(Prisma.sql`
      SELECT "title", "goal", "acceptance_criteria" AS "acceptanceCriteria",
             "convergence_thresholds" AS "thresholdOverrides",
             "unbounded_authorized_by" AS "unboundedAuthorizedBy"
        FROM "project" WHERE "id" = ${projectId}::uuid
    `);
    if (!row) throw new Error(`project ${projectId} not found`);
    return {
      acceptanceCriteria: row.acceptanceCriteria,
      // §1's frozen identity of what is being asked for, over the same three fields the task ledger
      // digests. Editing any of them is a new question — and, per §4 PV4, a new budget. That is the
      // one reset a person has that does not require the work itself to improve.
      scopeHash: scopeHash({
        title: row.title,
        description: row.goal,
        acceptanceCriteria: row.acceptanceCriteria,
      }),
      // `convergence_thresholds` is null on essentially every project, so this is where the
      // documented default actually comes from: `DEFAULT_CONVERGENCE_THRESHOLDS`, whose
      // `maxDecisionsWithoutProgress` of 6 is the N this unit's stop-loss counts to.
      thresholds: resolveThresholds(
        row.thresholdOverrides as Partial<ConvergenceThresholds> | null,
        row.unboundedAuthorizedBy as ScopeAuthorization | null,
      ),
    };
  }

  /** The last committed decision, which is the whole of the state the next one reads. */
  private async readState(
    tx: Prisma.TransactionClient | PrismaService,
    projectId: string,
  ): Promise<WakeConvergenceState & { nextSeq: number }> {
    const [last] = await tx.$queryRaw<Array<{
      seq: bigint;
      scopeHash: string;
      counters: unknown;
      progressVector: unknown;
      outcome: string;
    }>>(Prisma.sql`
      SELECT "seq", "scope_hash" AS "scopeHash", "counters",
             "progress_vector" AS "progressVector", "outcome"
        FROM "project_convergence_decision"
       WHERE "project_id" = ${projectId}::uuid
       ORDER BY "seq" DESC LIMIT 1
    `);
    if (!last) {
      return {
        scopeHash: null,
        counters: { ...ZERO_COUNTERS },
        progressVector: null,
        lastOutcome: null,
        nextSeq: 1,
      };
    }
    // The scope this row was decided on is returned as it was committed, never reconciled against
    // the project's current one: "the previous decision measured a different target" is a fact the
    // ledger row has to record (`scopeChanged`), not one this reader may quietly absorb.
    return {
      scopeHash: last.scopeHash,
      counters: last.counters as ConvergenceCounters,
      progressVector: last.progressVector as ProgressVector,
      lastOutcome: last.outcome as WakeConvergenceOutcome,
      nextSeq: Number(last.seq) + 1,
    };
  }

  private async byKey(
    tx: Prisma.TransactionClient,
    key: string,
  ): Promise<Omit<RecordedWakeConvergence, 'duplicate'> | null> {
    const [row] = await tx.$queryRaw<Array<{
      id: string;
      idempotencyKey: string;
      outcome: string;
      progressed: boolean;
      counters: unknown;
      progressVector: unknown;
      previousProgressVector: unknown;
      nonConvergenceReason: string | null;
      raisedBlockerId: string | null;
    }>>(Prisma.sql`
      SELECT "id", "idempotency_key" AS "idempotencyKey", "outcome", "progressed", "counters",
             "progress_vector" AS "progressVector",
             "previous_progress_vector" AS "previousProgressVector",
             "non_convergence_reason" AS "nonConvergenceReason",
             "blocker_id" AS "raisedBlockerId"
        FROM "project_convergence_decision" WHERE "idempotency_key" = ${key}
    `);
    if (!row) return null;
    return {
      id: row.id,
      idempotencyKey: row.idempotencyKey,
      outcome: row.outcome as WakeConvergenceOutcome,
      progressed: row.progressed,
      counters: row.counters as ConvergenceCounters,
      progressVector: row.progressVector as ProgressVector,
      previousProgressVector: row.previousProgressVector as ProgressVector | null,
      nonConvergenceReason: row.nonConvergenceReason,
      raisedBlockerId: row.raisedBlockerId,
    };
  }
}

/** What the project is asking for, and what bounds the asking. */
interface ProjectScope {
  acceptanceCriteria: string | null;
  scopeHash: string;
  thresholds: ConvergenceThresholds;
}

export interface RecordedWakeConvergence {
  id: string;
  idempotencyKey: string;
  outcome: WakeConvergenceOutcome;
  progressed: boolean;
  counters: ConvergenceCounters;
  progressVector: ProgressVector;
  previousProgressVector: ProgressVector | null;
  nonConvergenceReason: string | null;
  /** Named as the column's Prisma field is, and for the same reason: `blockerId` is a spelling the
   *  public-id codec already owns on another surface. */
  raisedBlockerId: string | null;
  /** True when this delivery read a judgment that was already committed for the same fact. */
  duplicate: boolean;
}
