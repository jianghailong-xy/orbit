import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import {
  ConvergenceCounters,
  ConvergenceThresholds,
  CoordinatorSpendLimits,
  ScopeAuthorization,
  ZERO_COUNTERS,
  resolveCoordinatorSpendLimits,
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
  COORDINATOR_SPEND_WINDOW_MS,
  ChainedTask,
  CoordinatorSpend,
  CoordinatorSpendVerdict,
  WakeConvergenceOutcome,
  WakeConvergenceState,
  coordinatorSpendVerdict,
  noProgressDedupeKey,
  planWakeConvergence,
  successorRetries,
  wakeConvergenceKey,
} from './coordinator-convergence';
import { WakeFact } from './coordinator-wake';
import { WakeAuthorization, WakeAuthorizer, WakeClaim } from './coordinator-wake.service';

/**
 * §3's "sessions opened": Orbit's two tools that open a session, under both names runners file
 * them as — `mcp__orbit__task_start` from Claude's MCP client, `orbit__task_start` from Codex's.
 */
const SESSION_OPENING_TOOL = '^(mcp__)?orbit__(task_start|session_create)$';

/**
 * `[T4]`: the durable half — the wake ledger, and the reading the coordinator fuse decides on.
 *
 * WHAT THIS UNIT DOES
 * ===================
 * Two things about one project, both read off committed rows.
 *
 * It records every committed wake in `project_convergence_decision`: the progress vector before the
 * wake, the vector at it, and whether that step strictly improved. A record and nothing more —
 * `coordinator-convergence.ts` §1 says why a wake no longer charges a budget or refuses anything.
 *
 * And it measures what the coordinator spent on its own, and whether that pauses it
 * (`assessSpend`, §3 there).
 *
 * It does NOT open sessions, choose tasks, judge failures or hold a timer. Those belong to T3 and
 * to the coordinator itself.
 *
 * WHERE THE RECORD ATTACHES
 * =========================
 * To T2's `WakeAuthorizer` seam: the authorizer is handed the CLAIM, so a judgment is recorded only
 * for a fact the database has picked a winner for, and once per fact. Compose it LAST, after the
 * cheaper refusals: a judgment recorded for a wake somebody else then refused would be a record of a
 * wake that never happened.
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
   * T2's authorizer: record the wake, and allow it.
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
    await this.judge(fact, claim);
    return { allowed: true };
  };

  /**
   * Record one wake's judgment.
   *
   * The order inside the transaction is load-bearing:
   *
   *  1. lock the project row, which serialises every judgment of this project and makes the `seq`
   *     allocation and step 2 decisions rather than guesses;
   *  2. look the idempotency key up FIRST, so a redelivered fact returns the committed judgment
   *     having written nothing;
   *  3. measure the world, from committed rows only;
   *  4. plan, in `coordinator-convergence.ts`'s order;
   *  5. insert the ledger row.
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

      const id = randomUUID();
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "project_convergence_decision" (
          "id", "project_id", "wake_id", "seq", "idempotency_key", "input_hash", "input",
          "event", "scope_hash", "previous_progress_vector", "progress_vector",
          "progress_vector_digest", "progressed", "evidence_freshness", "evidence_as_of",
          "counters", "thresholds", "outcome", "observed_at"
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
          ${planned.outcome}, ${observedAt}
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
        duplicate: false,
      };
    }, loggedRetry(this.logger, 'coordinatorConvergence.judge'));
  }

  /**
   * §3 of `coordinator-convergence.ts`, measured: what this project's coordinator spent on its own
   * in the 24 hours up to `asOf`, the limits in force, and whether that pauses it.
   *
   * A read and nothing else — no lock and no row. A pause is a conclusion anybody can recompute from
   * the same committed rows, so whoever acts on it can act on it again after a restart.
   *
   * Each kind is counted on the clock of the row that records it: `run_event.ingested_at`, which the
   * database writes; `tool_call.started_at`, the only time a tool call has; `task.superseded_at`,
   * written with the link it dates.
   */
  async assessSpend(projectId: string, asOf: Date = new Date()): Promise<CoordinatorSpendAssessment> {
    const since = new Date(asOf.getTime() - COORDINATOR_SPEND_WINDOW_MS);
    const [project] = await this.prisma.$queryRaw<Array<{
      coordinatorSessionId: string | null;
      limitOverrides: unknown;
      unboundedAuthorizedBy: unknown;
      selfStartedTurns: number;
      sessionsOpened: number;
    }>>(Prisma.sql`
      SELECT p."coordinator_session_id" AS "coordinatorSessionId",
             p."convergence_thresholds" AS "limitOverrides",
             p."unbounded_authorized_by" AS "unboundedAuthorizedBy",
             (SELECT count(*)::int FROM "run_event" e
               WHERE e."session_id" = p."coordinator_session_id"
                 AND e."type" = 'turn_end' AND e."turn_id" IS NULL
                 AND e."ingested_at" > ${since} AND e."ingested_at" <= ${asOf}) AS "selfStartedTurns",
             (SELECT count(*)::int FROM "tool_call" c
               WHERE c."session_id" = p."coordinator_session_id"
                 AND c."name" ~ ${SESSION_OPENING_TOOL}
                 AND c."is_error" = false AND c."finished_at" IS NOT NULL
                 AND c."started_at" > ${since} AND c."started_at" <= ${asOf}) AS "sessionsOpened"
        FROM "project" p
       WHERE p."id" = ${projectId}::uuid
    `);
    if (!project) throw new Error(`project ${projectId} not found`);

    const chained = await this.prisma.$queryRaw<ChainedTask[]>(Prisma.sql`
      SELECT t."id", t."superseded_by_task_id" AS "supersededByTaskId",
             t."superseded_at" AS "supersededAt", (t."creator_type" = 'AGENT') AS "filedByAgent"
        FROM "task" t
       WHERE t."project_id" = ${projectId}::uuid
         AND (t."superseded_by_task_id" IS NOT NULL
              OR t."id" IN (SELECT r."superseded_by_task_id" FROM "task" r
                             WHERE r."project_id" = ${projectId}::uuid
                               AND r."superseded_by_task_id" IS NOT NULL))
    `);

    const spend: CoordinatorSpend = {
      selfStartedTurns: project.selfStartedTurns,
      sessionsOpened: project.sessionsOpened,
      successorRetries: successorRetries(chained, since),
    };
    const limits = resolveCoordinatorSpendLimits(
      project.limitOverrides as Partial<CoordinatorSpendLimits> | null,
      project.unboundedAuthorizedBy as ScopeAuthorization | null,
    );
    return {
      projectId,
      coordinatorSessionId: project.coordinatorSessionId,
      since,
      asOf,
      spend,
      limits,
      ...coordinatorSpendVerdict(spend, limits),
    };
  }

  /**
   * What the ledger says this project's convergence state is — the read a restart resumes from.
   *
   * There is no column anywhere holding these numbers, deliberately: a second home for them is a
   * second thing that can disagree with the ledger. The last committed row IS the state.
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

    // 1. Acceptance. The criteria the project STATES, read from the authored definition rows.
    //    Migration 0229 removed the judgment, so there is no numerator to read beside them: no
    //    criterion is closed, because nothing in Orbit closes one. They remain evidence that this
    //    snapshot looked at the project at all, which is what stops an empty read being FRESH.
    const criteria = await tx.$queryRaw<Array<{ criterionKey: string }>>(Prisma.sql`
      SELECT d."id"::text AS "criterionKey"
        FROM "project_acceptance_criterion_definition" d
       WHERE d."project_id" = ${projectId}::uuid
       ORDER BY d."ordinal"
    `);
    const acceptance: AcceptanceEvidence[] = criteria
      .map((criterion) => ({ id: criterion.criterionKey, observedAt: asOf }));

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

    // 3. Blockers — every one of them EXCEPT the rows the retired breaker raised.
    //
    //    Those record that this ledger once stopped the project (`coordinator-convergence.ts` §1),
    //    not something standing between the project and its acceptance, so counting them would put
    //    the ledger's own history into the thing it measures.
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
    // The criteria come from the authored definition rows, rendered by the projection function
    // 0172 installed and 0229 kept. They used to come from `project.acceptance_criteria`, which
    // 0229 dropped: the per-item table is the only representation now, and the projection is the
    // same numbered text that column held — so the scope identity keeps meaning "the criteria as
    // written", read from where they are actually written.
    const [row] = await tx.$queryRaw<Array<{
      title: string;
      goal: string | null;
      acceptanceCriteria: string | null;
      thresholdOverrides: unknown;
      unboundedAuthorizedBy: string | null;
    }>>(Prisma.sql`
      SELECT "title", "goal",
             project_acceptance_definition_projection("id") AS "acceptanceCriteria",
             "convergence_thresholds" AS "thresholdOverrides",
             "unbounded_authorized_by" AS "unboundedAuthorizedBy"
        FROM "project" WHERE "id" = ${projectId}::uuid
    `);
    if (!row) throw new Error(`project ${projectId} not found`);
    return {
      acceptanceCriteria: row.acceptanceCriteria,
      // §1's frozen identity of what is being asked for, over the same three fields the task ledger
      // digests. Editing any of them is a new question, and the ledger records it as one.
      scopeHash: scopeHash({
        title: row.title,
        description: row.goal,
        acceptanceCriteria: row.acceptanceCriteria,
      }),
      // `convergence_thresholds` is null on essentially every project, so what each judgment
      // records beside itself is `DEFAULT_CONVERGENCE_THRESHOLDS`.
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
    }>>(Prisma.sql`
      SELECT "id", "idempotency_key" AS "idempotencyKey", "outcome", "progressed", "counters",
             "progress_vector" AS "progressVector",
             "previous_progress_vector" AS "previousProgressVector"
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
    };
  }
}

/** What the project is asking for, and the thresholds recorded beside each judgment. */
interface ProjectScope {
  acceptanceCriteria: string | null;
  scopeHash: string;
  thresholds: ConvergenceThresholds;
}

export interface RecordedWakeConvergence {
  id: string;
  idempotencyKey: string;
  /** `PROCEED` for every judgment recorded now; a row the retired breaker wrote may read `STOP`. */
  outcome: WakeConvergenceOutcome;
  progressed: boolean;
  counters: ConvergenceCounters;
  progressVector: ProgressVector;
  previousProgressVector: ProgressVector | null;
  /** True when this delivery read a judgment that was already committed for the same fact. */
  duplicate: boolean;
}

/** What the fuse read, and what it concluded. */
export interface CoordinatorSpendAssessment extends CoordinatorSpendVerdict {
  projectId: string;
  /** The standing coordinator conversation whose turns and calls were counted, if there is one. */
  coordinatorSessionId: string | null;
  /** The window: after `since`, up to and including `asOf`. */
  since: Date;
  asOf: Date;
  spend: CoordinatorSpend;
  limits: CoordinatorSpendLimits;
}
