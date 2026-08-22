import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  AttemptBudget,
  ConvergenceClassification,
  ScopeAuthorization,
  resolveAttemptBudget,
} from './convergence-contract';
import { ProgressVector } from './convergence-progress';
import { ConvergenceLedgerService } from './convergence-ledger.service';
import {
  AttemptBudgetDimension,
  AttemptBudgetReport,
  AttemptClose,
  AttemptOutcome,
  AttemptSeed,
  AttemptSpend,
  AttemptStatus,
  PreviousAttempt,
  SessionLifecycleActor,
  ZERO_ATTEMPT_SPEND,
  attemptObservationKey,
  authorizeAttemptLifecycle,
  authorizeFreshAttempt,
  authorizeSteer,
  buildAttemptSeed,
  evaluateAttemptBudget,
  hypothesisDigest,
  planAttemptClose,
} from './attempt-budget';

/**
 * `[K3]`: the attempt, written down.
 *
 * `[K1]` froze the limits and `[K2]` made the counters durable, and the incident would still have
 * happened, because it never crossed an attempt line: it was one Session steered hundreds of times.
 * This service is where "a Session is ONE attempt" stops being a sentence in a contract and becomes
 * a row with a unique index on it.
 *
 * Four verbs, and each is the durable half of a rule the contract could only state:
 *
 *  - **`open`** allocates a generation through `[K2]`'s ledger — never privately — and freezes the
 *    budget it will be judged by. A replay after a crash re-derives the same `attemptKey` and reads
 *    its own row back rather than opening a second generation (§4 GN1).
 *  - **`evaluate`** measures the six dimensions and, if one is spent, ASKS the attempt to wind
 *    down. It does not end anything: reaching a budget is not a failure (TH2).
 *  - **`close`** is the worker's, and records one of four real outcomes plus what it left behind.
 *    `CANCELLED` is not among them, and migration 0133 refuses it — so overwriting a result with a
 *    cancellation is not a thing a caller can decide to do carefully.
 *  - **`authorize*`** answers who may end or steer somebody else's attempt. The user may; another
 *    agent session may not (§3 AU2).
 */
@Injectable()
export class SessionAttemptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: ConvergenceLedgerService,
  ) {}

  /**
   * §4: open one attempt.
   *
   * The order is not free to vary. `record(ATTEMPT_STARTED)` runs FIRST because it is what
   * allocates the generation: advancing `task.attempt_generation` privately here would leave the
   * ledger and the column telling two different stories about how many attempts a revision has had,
   * and `[K2]`'s `recover()` exists to notice exactly that disagreement. Migration 0133's fence
   * then refuses any attempt row whose generation is not the one the ledger just committed, which
   * is what makes "went through the ledger" a property of the database rather than a convention.
   *
   * `attemptKey` must be the durable identity of the DISPATCH — a `randomUUID()` here means a
   * replay after a crash opens a second generation instead of reading back its own row, which is
   * the same mistake, in the same place, as hashing a snapshot for an idempotency key.
   */
  async open(
    ownerId: string,
    taskId: string,
    request: {
      attemptKey: string;
      sessionId: string;
      hypothesis: string;
      progressVector: ProgressVector;
      observedAt: Date;
      decidedBy?: 'ORCHESTRATOR' | 'COORDINATOR_AGENT' | 'USER';
    },
  ): Promise<{ attempt: AttemptRow; seed: AttemptSeed; reused: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await this.byAttemptKey(tx, ownerId, request.attemptKey);
      // GN1. Returned rather than refused: a replay is the same dispatch arriving twice, and the
      // caller is owed the row it already committed, not an error it has no way to act on.
      if (existing) {
        return { attempt: existing, seed: await this.seedFor(tx, ownerId, existing), reused: true };
      }

      const previous = await this.previousAttempt(tx, ownerId, taskId);
      const authorized = authorizeFreshAttempt(request.hypothesis, previous);
      if (authorized !== 'ALLOWED') throw new ConflictException(authorized);

      // `record` FIRST, and not only for the generation: it is also what opens the task's ledger
      // (`ensureBaseline`), and the attempt's composite foreign key has nothing to point at until
      // that scope revision row exists.
      const recorded = await this.ledger.record(tx, taskId, ownerId, {
        observationKey: attemptObservationKey(request.attemptKey),
        event: 'ATTEMPT_STARTED',
        classification: null,
        failure: null,
        progressVector: request.progressVector,
        observedAt: request.observedAt,
        decidedBy: request.decidedBy ?? 'ORCHESTRATOR',
        action: null,
        sessionId: request.sessionId,
      });
      // Read AFTER the ledger wrote: the baseline revision row now exists, and `known_good_sha`
      // is whatever this observation's progress vector just established. A duplicate ledger row
      // (the previous pass committed it and died before its own INSERT — not possible inside one
      // transaction, but the ledger is reachable from elsewhere) leaves the task's own generation
      // as the honest answer, because that is the one that was allocated.
      const context = await this.taskContext(tx, ownerId, taskId);
      const generation = recorded.decision?.attemptGeneration ?? context.attemptGeneration;

      const budget = context.budget;
      const id = randomUUID();
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "task_attempt" (
          "id", "task_id", "owner_id", "session_id", "scope_revision", "scope_hash",
          "attempt_generation", "attempt_key", "hypothesis", "hypothesis_digest", "budget",
          "inherited_known_good_sha", "created_at", "updated_at"
        ) VALUES (
          ${id}::uuid, ${taskId}::uuid, ${ownerId}::uuid, ${request.sessionId}::uuid,
          ${context.scopeRevision}, ${context.scopeHash}, ${BigInt(generation)},
          ${request.attemptKey}, ${request.hypothesis},
          ${hypothesisDigest(request.hypothesis)}, ${JSON.stringify(budget)}::jsonb,
          ${context.knownGoodSha}, ${request.observedAt}, ${request.observedAt}
        )
      `);

      const attempt = await this.byId(tx, ownerId, id);
      if (!attempt) throw new Error('failed to open the attempt');
      return {
        attempt,
        seed: buildAttemptSeed(
          { taskId, ...context },
          generation,
          request.hypothesis,
          previous,
        ),
        reused: false,
      };
    });
  }

  /**
   * §1/§2 NC1: measure the six dimensions, and ask for a wind-down if one is spent.
   *
   * Nothing here ends anything. Reaching a budget is not a failure (TH2) — it is the moment the
   * attempt is told to finish what it is holding and write it down, and the finishing is the
   * worker's to do. The first exhausted dimension in BD1's order is recorded and NOT overwritten
   * later: which line was crossed first is a fact about what happened, and a second pass that finds
   * a different one is looking at a world the wind-down already changed.
   */
  async evaluate(
    ownerId: string,
    sessionId: string,
    now: Date,
  ): Promise<{ attempt: AttemptRow; spend: AttemptSpend; report: AttemptBudgetReport } | null> {
    return this.prisma.$transaction(async (tx) => {
      const attempt = await this.bySessionId(tx, ownerId, sessionId, true);
      if (!attempt) return null;
      // A closed attempt is measured as it was, not as the clock has moved since. Re-measuring it
      // would report a wall clock that kept running after the work stopped.
      if (attempt.status === 'CLOSED') {
        const recorded = attempt.spend ?? ZERO_ATTEMPT_SPEND;
        return { attempt, spend: recorded, report: evaluateAttemptBudget(attempt.budget, recorded) };
      }
      const spend = await this.measure(tx, attempt, now);
      const report = evaluateAttemptBudget(attempt.budget, spend);

      const askNow = report.windDownRequired && attempt.windDownRequestedAt === null;
      await tx.$executeRaw(Prisma.sql`
        UPDATE "task_attempt"
           SET "spend" = ${JSON.stringify(spend)}::jsonb,
               "status" = ${askNow ? 'WINDING_DOWN' : attempt.status},
               "exhausted_dimension" = ${askNow ? report.exhausted : attempt.exhaustedDimension},
               "wind_down_requested_at" = ${askNow ? now : attempt.windDownRequestedAt}
         WHERE "id" = ${attempt.id}::uuid AND "owner_id" = ${ownerId}::uuid
           AND "status" <> 'CLOSED'
      `);

      const refreshed = await this.byId(tx, ownerId, attempt.id);
      return { attempt: refreshed ?? attempt, spend, report };
    });
  }

  /**
   * §2 NC2/NC3: the worker records how this attempt actually ended.
   *
   * Writing the outcome and writing the checkpoint are ONE statement, because the failure mode the
   * whole unit is about is exactly the half-written ending: a run that stopped, with the reason
   * living somewhere the next generation cannot read. An `ACCEPTED` checkpoint also moves
   * `task.known_good_sha` in the same transaction — that pointer is the one thing §5 lets a fresh
   * generation inherit, so it cannot be allowed to lag behind the attempt that established it.
   */
  async close(
    ownerId: string,
    sessionId: string,
    close: AttemptClose,
    closedAt: Date,
  ): Promise<AttemptRow> {
    return this.prisma.$transaction(async (tx) => {
      const attempt = await this.bySessionId(tx, ownerId, sessionId, true);
      if (!attempt) throw new NotFoundException('attempt not found');
      const planned = planAttemptClose(
        attempt.status,
        attempt.windDownRequestedAt !== null,
        close,
      );
      if (typeof planned === 'string') throw new ConflictException(planned);

      await tx.$executeRaw(Prisma.sql`
        UPDATE "task_attempt"
           SET "status" = 'CLOSED',
               "outcome" = ${planned.outcome},
               "classification" = ${planned.classification},
               "checkpoint_sha" = ${planned.checkpoint?.sha ?? null},
               "checkpoint_kind" = ${planned.checkpoint?.kind ?? null},
               "checkpoint_evidence_digest" = ${planned.checkpoint?.evidenceDigest ?? null},
               "no_checkpoint_reason" = ${planned.noCheckpointReason},
               "closed_at" = ${closedAt}
         WHERE "id" = ${attempt.id}::uuid AND "owner_id" = ${ownerId}::uuid
      `);

      if (planned.knownGoodSha) {
        await tx.$executeRaw(Prisma.sql`
          UPDATE "task" SET "known_good_sha" = ${planned.knownGoodSha},
                            "updated_at" = CURRENT_TIMESTAMP
           WHERE "id" = ${attempt.taskId}::uuid AND "owner_id" = ${ownerId}::uuid
        `);
      }

      const refreshed = await this.byId(tx, ownerId, attempt.id);
      if (!refreshed) throw new Error('failed to close the attempt');
      return refreshed;
    });
  }

  /**
   * §6 CR1: close an attempt whose session already stopped without one.
   *
   * Only for a session that is ALREADY terminal, and only ever as `INTERRUPTED`. It does not guess:
   * a live attempt is left alone, and a crashed one is not written down as `FAILED`, because
   * "failed" is a conclusion about the work and this reconciler was not there. What it does record
   * is that there is no checkpoint (CR2) — inventing one would make the next generation resume from
   * a known-good point that does not exist.
   */
  async reconcileAbandoned(
    ownerId: string,
    sessionId: string,
    reason: string,
    closedAt: Date,
  ): Promise<AttemptRow | null> {
    const [live] = await this.prisma.$queryRaw<Array<{ status: string }>>(Prisma.sql`
      SELECT "status"::text AS "status" FROM "session"
       WHERE "id" = ${sessionId}::uuid AND "owner_id" = ${ownerId}::uuid
    `);
    if (!live) throw new NotFoundException('session not found');
    if (!TERMINAL_RUN_STATUS.includes(live.status)) return null;
    const attempt = await this.bySessionId(this.prisma, ownerId, sessionId, true);
    if (!attempt) return null;
    return this.close(
      ownerId,
      sessionId,
      {
        outcome: 'INTERRUPTED',
        checkpoint: null,
        noCheckpointReason: reason,
        classification: null,
      },
      closedAt,
    );
  }

  /**
   * §3's first row: may this actor end, complete or cancel the session this attempt runs in?
   *
   * Called by the session lifecycle itself, so the refusal lands on the API that would have
   * overwritten the result rather than on a later reconciliation that finds the damage done. A
   * session with no attempt row is not under convergence management and is not affected at all —
   * which is every session that exists today (project AC11).
   */
  async assertMayEndSession(
    ownerId: string,
    sessionId: string,
    actor: SessionLifecycleActor,
  ): Promise<void> {
    if (actor.kind === 'USER') return;
    const attempt = await this.bySessionId(this.prisma, ownerId, sessionId, true);
    if (!attempt) return;
    const decision = authorizeAttemptLifecycle(actor, attempt);
    if (decision !== 'ALLOWED') throw new ConflictException(decision);
  }

  /**
   * §3's second row (AU3): charge one coordinator steer, or refuse it.
   *
   * The increment and the check are ONE conditional UPDATE, so two coordinators steering at once
   * cannot both read "one left". Zero rows affected means it was refused, and the reason is then
   * read from the row — deriving it from the same read that decided would let the two disagree.
   *
   * "Keep going" is the only verb in the system that produces activity without producing an
   * attempt, a fingerprint or a unit of progress. That is precisely why it needs a bound: every
   * liveness check stayed green through the incident because this verb kept firing.
   */
  async chargeSteer(
    ownerId: string,
    sessionId: string,
    actor: SessionLifecycleActor,
  ): Promise<void> {
    if (actor.kind === 'USER') return;
    const attempt = await this.bySessionId(this.prisma, ownerId, sessionId, true);
    if (!attempt) return;
    if (actor.sessionId === attempt.sessionId) return;

    const charged = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "task_attempt"
         SET "coordinator_steers" = "coordinator_steers" + 1
       WHERE "id" = ${attempt.id}::uuid AND "owner_id" = ${ownerId}::uuid
         AND "status" = 'OPEN'
         AND (
           "budget"->'maxCoordinatorSteers' = 'null'::jsonb
           OR "coordinator_steers" < ("budget"->>'maxCoordinatorSteers')::int
         )
    `);
    if (charged > 0) return;

    const current = await this.bySessionId(this.prisma, ownerId, sessionId, true);
    const refusal = current
      ? authorizeSteer(actor, current, current.budget, { coordinatorSteers: current.coordinatorSteers })
      : 'ALLOWED';
    // A race that closed the attempt between the UPDATE and this read leaves nothing to refuse:
    // the steer lands on a session that is no longer an open attempt, which is allowed.
    if (refusal === 'ALLOWED') return;
    throw new ConflictException(refusal);
  }

  /**
   * The read face (project AC10, this unit's AC1): every dimension's REMAINING, readable.
   *
   * The live attempt is re-measured against `now` so that wall clock is current; closed attempts
   * report the spend recorded when they were last measured. Ids leave as Base62.
   */
  async describe(ownerId: string, taskId: string, now: Date) {
    const attempts = await this.attempts(this.prisma, ownerId, taskId);
    const open = attempts.find((attempt) => attempt.status !== 'CLOSED') ?? null;
    const spend = open ? await this.measure(this.prisma, open, now) : null;
    return {
      taskId: uuidToBase62(taskId),
      current: open === null || spend === null ? null : {
        ...publicAttempt(open),
        spend,
        budgetReport: evaluateAttemptBudget(open.budget, spend),
      },
      attempts: attempts.map((attempt) => ({
        ...publicAttempt(attempt),
        spend: attempt.spend,
        budgetReport: attempt.spend
          ? evaluateAttemptBudget(attempt.budget, attempt.spend)
          : null,
      })),
    };
  }

  /**
   * §1's "花费从哪读" column, in one query.
   *
   * Wall clock runs from the session's `started_at` and falls back to the attempt's own creation —
   * a session that never started has still been holding the slot since it was opened, and reading
   * zero there would make a dispatch that never ran immortal.
   */
  private async measure(
    tx: Prisma.TransactionClient | PrismaService,
    attempt: AttemptRow,
    now: Date,
  ): Promise<AttemptSpend> {
    const [row] = await tx.$queryRaw<Array<{
      numTurns: number;
      costUsd: number;
      contextTokens: number | null;
      contextWindow: number | null;
      startedAt: Date | null;
      toolCalls: bigint;
    }>>(Prisma.sql`
      SELECT s."num_turns" AS "numTurns", s."cost_usd" AS "costUsd",
             s."context_tokens" AS "contextTokens", s."context_window" AS "contextWindow",
             s."started_at" AS "startedAt",
             (SELECT count(*) FROM "tool_call" c WHERE c."session_id" = s."id") AS "toolCalls"
        FROM "session" s
       WHERE s."id" = ${attempt.sessionId}::uuid AND s."owner_id" = ${attempt.ownerId}::uuid
    `);
    const startedAt = row?.startedAt ?? attempt.createdAt;
    return {
      turns: Number(row?.numTurns ?? 0),
      wallClockMs: Math.max(0, now.getTime() - startedAt.getTime()),
      toolCalls: Number(row?.toolCalls ?? 0n),
      costMicros: Math.round(Number(row?.costUsd ?? 0) * 1_000_000),
      contextTokens: row?.contextTokens ?? null,
      contextWindow: row?.contextWindow ?? null,
      coordinatorSteers: attempt.coordinatorSteers,
    };
  }

  /** The task's scope identity plus the budget a new attempt would be frozen against. */
  private async taskContext(
    tx: Prisma.TransactionClient | PrismaService,
    ownerId: string,
    taskId: string,
  ): Promise<{
    scopeRevision: number;
    scopeHash: string;
    attemptGeneration: number;
    knownGoodSha: string | null;
    budget: AttemptBudget;
  }> {
    const [row] = await tx.$queryRaw<Array<{
      scopeRevision: number;
      scopeHash: string | null;
      attemptGeneration: bigint;
      knownGoodSha: string | null;
      budgetOverrides: unknown;
      unboundedAuthorizedBy: unknown;
    }>>(Prisma.sql`
      SELECT t."scope_revision" AS "scopeRevision",
             t."attempt_generation" AS "attemptGeneration",
             t."known_good_sha" AS "knownGoodSha",
             r."scope_hash" AS "scopeHash",
             p."attempt_budget" AS "budgetOverrides",
             p."unbounded_authorized_by" AS "unboundedAuthorizedBy"
        FROM "task" t
        LEFT JOIN "project" p ON p."id" = t."project_id"
        LEFT JOIN "task_scope_revision" r
               ON r."task_id" = t."id" AND r."revision" = t."scope_revision"
       WHERE t."id" = ${taskId}::uuid AND t."owner_id" = ${ownerId}::uuid
    `);
    if (!row) throw new NotFoundException('task not found');
    return {
      scopeRevision: row.scopeRevision,
      // Null only for a task the ledger has never opened; `record()` writes the baseline in the
      // same transaction, and it writes exactly this digest.
      scopeHash: row.scopeHash ?? '',
      attemptGeneration: Number(row.attemptGeneration),
      knownGoodSha: row.knownGoodSha,
      budget: resolveAttemptBudget(
        row.budgetOverrides as Partial<AttemptBudget> | null,
        row.unboundedAuthorizedBy as ScopeAuthorization | null,
      ),
    };
  }

  private async seedFor(
    tx: Prisma.TransactionClient,
    ownerId: string,
    attempt: AttemptRow,
  ): Promise<AttemptSeed> {
    const previous = await this.previousAttempt(tx, ownerId, attempt.taskId, attempt.generation);
    return buildAttemptSeed(
      {
        taskId: attempt.taskId,
        scopeRevision: attempt.scopeRevision,
        scopeHash: attempt.scopeHash,
        knownGoodSha: attempt.inheritedKnownGoodSha,
      },
      attempt.generation,
      attempt.hypothesis,
      previous,
    );
  }

  /** The newest attempt on the task's CURRENT revision, optionally strictly before a generation. */
  private async previousAttempt(
    tx: Prisma.TransactionClient | PrismaService,
    ownerId: string,
    taskId: string,
    before?: number,
  ): Promise<PreviousAttempt | null> {
    const [row] = await tx.$queryRaw<Array<AttemptDbRow>>(Prisma.sql`
      SELECT a.* FROM "task_attempt" a
        JOIN "task" t ON t."id" = a."task_id" AND t."scope_revision" = a."scope_revision"
       WHERE a."task_id" = ${taskId}::uuid AND a."owner_id" = ${ownerId}::uuid
         ${before === undefined
        ? Prisma.empty
        : Prisma.sql`AND a."attempt_generation" < ${BigInt(before)}`}
       ORDER BY a."attempt_generation" DESC
       LIMIT 1
    `);
    if (!row) return null;
    const attempt = toAttempt(row);
    return {
      attemptGeneration: attempt.generation,
      hypothesisDigest: attempt.hypothesisDigest,
      status: attempt.status,
      outcome: attempt.outcome,
      exhaustedDimension: attempt.exhaustedDimension,
      classification: attempt.classification,
    };
  }

  private async attempts(
    tx: Prisma.TransactionClient | PrismaService,
    ownerId: string,
    taskId: string,
  ): Promise<AttemptRow[]> {
    const rows = await tx.$queryRaw<Array<AttemptDbRow>>(Prisma.sql`
      SELECT * FROM "task_attempt"
       WHERE "task_id" = ${taskId}::uuid AND "owner_id" = ${ownerId}::uuid
       ORDER BY "scope_revision" DESC, "attempt_generation" DESC
    `);
    return rows.map(toAttempt);
  }

  private async byId(
    tx: Prisma.TransactionClient | PrismaService,
    ownerId: string,
    id: string,
  ): Promise<AttemptRow | null> {
    const [row] = await tx.$queryRaw<Array<AttemptDbRow>>(Prisma.sql`
      SELECT * FROM "task_attempt"
       WHERE "id" = ${id}::uuid AND "owner_id" = ${ownerId}::uuid
    `);
    return row ? toAttempt(row) : null;
  }

  private async byAttemptKey(
    tx: Prisma.TransactionClient,
    ownerId: string,
    attemptKey: string,
  ): Promise<AttemptRow | null> {
    const [row] = await tx.$queryRaw<Array<AttemptDbRow>>(Prisma.sql`
      SELECT * FROM "task_attempt"
       WHERE "attempt_key" = ${attemptKey} AND "owner_id" = ${ownerId}::uuid
    `);
    return row ? toAttempt(row) : null;
  }

  private async bySessionId(
    tx: Prisma.TransactionClient | PrismaService,
    ownerId: string,
    sessionId: string,
    forUpdate = false,
  ): Promise<AttemptRow | null> {
    const [row] = await tx.$queryRaw<Array<AttemptDbRow>>(Prisma.sql`
      SELECT * FROM "task_attempt"
       WHERE "session_id" = ${sessionId}::uuid AND "owner_id" = ${ownerId}::uuid
       ${forUpdate ? Prisma.sql`FOR UPDATE` : Prisma.empty}
    `);
    return row ? toAttempt(row) : null;
  }
}

const TERMINAL_RUN_STATUS: readonly string[] = ['SUCCEEDED', 'FAILED', 'CANCELLED'];

export interface AttemptRow {
  id: string;
  taskId: string;
  ownerId: string;
  sessionId: string;
  scopeRevision: number;
  scopeHash: string;
  generation: number;
  attemptKey: string;
  hypothesis: string;
  hypothesisDigest: string;
  budget: AttemptBudget;
  spend: AttemptSpend | null;
  coordinatorSteers: number;
  status: AttemptStatus;
  outcome: AttemptOutcome | null;
  classification: ConvergenceClassification | null;
  exhaustedDimension: AttemptBudgetDimension | null;
  checkpointSha: string | null;
  checkpointKind: 'ACCEPTED' | 'WIP_RED' | null;
  checkpointEvidenceDigest: string | null;
  noCheckpointReason: string | null;
  inheritedKnownGoodSha: string | null;
  windDownRequestedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
}

interface AttemptDbRow {
  id: string;
  task_id: string;
  owner_id: string;
  session_id: string;
  scope_revision: number;
  scope_hash: string;
  attempt_generation: bigint;
  attempt_key: string;
  hypothesis: string;
  hypothesis_digest: string;
  budget: unknown;
  spend: unknown;
  coordinator_steers: number;
  status: string;
  outcome: string | null;
  classification: string | null;
  exhausted_dimension: string | null;
  checkpoint_sha: string | null;
  checkpoint_kind: string | null;
  checkpoint_evidence_digest: string | null;
  no_checkpoint_reason: string | null;
  inherited_known_good_sha: string | null;
  wind_down_requested_at: Date | null;
  closed_at: Date | null;
  created_at: Date;
}

function toAttempt(row: AttemptDbRow): AttemptRow {
  return {
    id: row.id,
    taskId: row.task_id,
    ownerId: row.owner_id,
    sessionId: row.session_id,
    scopeRevision: row.scope_revision,
    scopeHash: row.scope_hash,
    generation: Number(row.attempt_generation),
    attemptKey: row.attempt_key,
    hypothesis: row.hypothesis,
    hypothesisDigest: row.hypothesis_digest,
    budget: row.budget as AttemptBudget,
    spend: (row.spend ?? null) as AttemptSpend | null,
    coordinatorSteers: row.coordinator_steers,
    status: row.status as AttemptStatus,
    outcome: row.outcome as AttemptOutcome | null,
    classification: row.classification as ConvergenceClassification | null,
    exhaustedDimension: row.exhausted_dimension as AttemptBudgetDimension | null,
    checkpointSha: row.checkpoint_sha,
    checkpointKind: row.checkpoint_kind as 'ACCEPTED' | 'WIP_RED' | null,
    checkpointEvidenceDigest: row.checkpoint_evidence_digest,
    noCheckpointReason: row.no_checkpoint_reason,
    inheritedKnownGoodSha: row.inherited_known_good_sha,
    windDownRequestedAt: row.wind_down_requested_at,
    closedAt: row.closed_at,
    createdAt: row.created_at,
  };
}

/** The attempt as a caller outside the tenant boundary sees it: Base62 ids, no raw UUIDs. */
function publicAttempt(attempt: AttemptRow) {
  return {
    id: uuidToBase62(attempt.id),
    taskId: uuidToBase62(attempt.taskId),
    sessionId: uuidToBase62(attempt.sessionId),
    scopeRevision: attempt.scopeRevision,
    scopeHash: attempt.scopeHash,
    attemptGeneration: String(attempt.generation),
    // The key is caller-supplied free text that may well embed an id, and the interceptor cannot
    // see inside a string — the same reason `publicConvergenceKey` exists for the ledger's.
    attemptKey: attempt.attemptKey.replace(UUID_PATTERN, (id) => uuidToBase62(id)),
    hypothesis: attempt.hypothesis,
    budget: attempt.budget,
    coordinatorSteers: attempt.coordinatorSteers,
    status: attempt.status,
    outcome: attempt.outcome,
    classification: attempt.classification,
    exhaustedDimension: attempt.exhaustedDimension,
    checkpointSha: attempt.checkpointSha,
    checkpointKind: attempt.checkpointKind,
    checkpointEvidenceDigest: attempt.checkpointEvidenceDigest,
    noCheckpointReason: attempt.noCheckpointReason,
    inheritedKnownGoodSha: attempt.inheritedKnownGoodSha,
    windDownRequestedAt: attempt.windDownRequestedAt,
    closedAt: attempt.closedAt,
    createdAt: attempt.createdAt,
  };
}

const UUID_PATTERN = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
