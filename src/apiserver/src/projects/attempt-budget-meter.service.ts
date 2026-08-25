import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AttemptBudgetReport, AttemptSpend } from './attempt-budget';
import { COORDINATOR_DISABLED, meterAttempt } from './attempt-budget-meter';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import {
  CoordinatorWakeService,
  WakeAuthorization,
  WakeAuthorizer,
  WakeOutcome,
} from './coordinator-wake.service';
import { AttemptRow, SessionAttemptService } from './session-attempt.service';

/**
 * Unit T5's producer: the six dimensions, charged against a session that is actually running.
 *
 * WHAT WAS ALREADY THERE AND WHAT WAS NOT
 * =======================================
 * `SessionAttemptService.evaluate` already measures the six dimensions off the session row and the
 * tool-call table, persists the reading into `task_attempt.spend`, and asks a worker over one of
 * the first five lines to wind down. It had no caller. `coordinator-wake.ts` already spells
 * `ATTEMPT_BUDGET_SPENT` and says in as many words that unit T5 is what produces it. It had no
 * producer. This service is both halves of that join and nothing else: it measures, and it hands
 * the resulting fact to the wake ledger.
 *
 * WHY THE MEASUREMENT IS NOT AN ARGUMENT
 * ======================================
 * Nobody passes a spend in. It is read from `session.num_turns`, `session.cost_usd`,
 * `session.context_tokens/context_window`, `session.started_at`, `count(tool_call)` and
 * `task_attempt.coordinator_steers` — committed columns, every one of them written by somebody
 * other than the code that is about to be bounded by them. A budget a caller reports its own spend
 * against is not a budget.
 *
 * WHY THIS HOLDS NO TIMER
 * =======================
 * It is called from where the spend is COMMITTED — the runner's turn-complete, once the turn's
 * numbers, its events and its tool calls are all in the database. A sweep that asked "has anything
 * gone over?" on a clock is the shape `coordinator-wake.ts` §0 forbids, and it would answer the
 * question for every live session in the fleet to find the nought or one that moved.
 *
 * The price of that choice is stated rather than hidden: `WALL_CLOCK` only advances between turns,
 * so a session that hangs mid-turn is not metered until its turn ends. That dimension is not this
 * unit's only guard against a wedged run — `ReaperService`'s cancel-grace and offline-runner
 * branches finalize a session whose runner stopped answering — and a wall clock spent by a turn
 * still genuinely running is the case where asking a worker to wind down has nowhere to land.
 */
@Injectable()
export class AttemptBudgetMeterService {
  private readonly logger = new Logger(AttemptBudgetMeterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly attempts: SessionAttemptService,
    private readonly wakes: CoordinatorWakeService,
    private readonly convergence: CoordinatorConvergenceService,
  ) {}

  /**
   * Charge one session's attempt against its frozen budget, and wake its coordinator if it is spent.
   *
   * `null` for a session that is not an open attempt, which is nearly every session that exists:
   * a run with no `task_attempt` row is not under convergence management and is not bounded by this
   * unit at all. That check is the first query and it is one index probe, so the hot path costs a
   * single lookup on `task_attempt_session_key` and stops.
   */
  async meter(sessionId: string, now: Date): Promise<AttemptBudgetMeterResult | null> {
    const bound = await this.boundAttempt(sessionId);
    if (!bound) return null;

    // Measure, persist, and — for the five dimensions that bound the WORKER — ask it to wind down.
    // Delegated rather than repeated: `evaluate` is where the reading and the wind-down request are
    // one transaction, and a second writer of `task_attempt.spend` is a second answer to "what did
    // this attempt spend".
    const measured = await this.attempts.evaluate(bound.ownerId, sessionId, now);
    if (!measured) return null;
    const { attempt, spend } = measured;

    // A task filed under no project has no coordinator to wake. The budget still applies — the
    // wind-down above already happened — because a bound run is bound whether or not anybody is
    // listening; what is absent is the audience, not the limit.
    if (!bound.projectId) {
      return { attempt, spend, report: measured.report, fact: false, wake: null };
    }

    const verdict = meterAttempt(
      { projectId: bound.projectId, taskId: attempt.taskId, sessionId },
      attempt.budget,
      spend,
    );
    if (!verdict.fact) return { attempt, spend, report: verdict.report, fact: false, wake: null };

    return {
      attempt,
      spend,
      report: verdict.report,
      fact: true,
      wake: await this.wakes.claim(verdict.fact, this.authorize),
    };
  }

  /**
   * `meter`, for a caller that is in the middle of answering a runner.
   *
   * A budget that could not be charged is a fact that did not reach the coordinator, and the next
   * turn re-derives it from the same committed columns and charges it then — so failing the runner's
   * turn-complete over it would trade a recoverable miss for an unrecoverable one.
   */
  async meterQuietly(sessionId: string, now: Date): Promise<void> {
    try {
      await this.meter(sessionId, now);
    } catch (error) {
      this.logger.error(
        `attempt budget metering failed for session ${sessionId}: `
        + (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  /**
   * T2's authorizer for this fact, cheapest refusal first.
   *
   * A property field rather than a method, for the reason `CoordinatorConvergenceService` states
   * about its own: handing a bare method to `claim` would hand over an authorizer with no `this`,
   * and a throw there is recorded as `WAKE_AUTHORIZATION_FAILED` — a wiring mistake wearing the
   * costume of a transient failure.
   */
  private readonly authorize: WakeAuthorizer = async (fact, claim): Promise<WakeAuthorization> => {
    const [project] = await this.prisma.$queryRaw<Array<{ coordinatorEnabled: boolean }>>(Prisma.sql`
      SELECT "coordinator_enabled" AS "coordinatorEnabled" FROM "project"
       WHERE "id" = ${fact.projectId}::uuid
    `);
    if (!project?.coordinatorEnabled) {
      return { allowed: false, refusalCode: COORDINATOR_DISABLED };
    }
    return this.convergence.authorizeWake(fact, claim);
  };

  /**
   * The session's attempt, if it has a live one, and the project whose coordinator it would wake.
   *
   * `status <> 'CLOSED'` on purpose: a closed attempt's budget is history. Re-measuring one would
   * report a wall clock that kept running after the work stopped, and waking a coordinator about a
   * run that already wrote down how it ended is the emptiest kind of wake there is.
   */
  private async boundAttempt(
    sessionId: string,
  ): Promise<{ ownerId: string; projectId: string | null } | null> {
    const [row] = await this.prisma.$queryRaw<Array<{
      ownerId: string;
      projectId: string | null;
    }>>(Prisma.sql`
      SELECT a."owner_id" AS "ownerId", t."project_id" AS "projectId"
        FROM "task_attempt" a
        JOIN "task" t ON t."id" = a."task_id" AND t."owner_id" = a."owner_id"
       WHERE a."session_id" = ${sessionId}::uuid AND a."status" <> 'CLOSED'
    `);
    return row ?? null;
  }
}

export interface AttemptBudgetMeterResult {
  attempt: AttemptRow;
  /** What was read this pass, and what `task_attempt.spend` now holds. */
  spend: AttemptSpend;
  report: AttemptBudgetReport;
  /** Whether this pass derived an `ATTEMPT_BUDGET_SPENT` fact at all. */
  fact: boolean;
  /** What the wake ledger did with it. `null` when there was no fact, or nobody to wake. */
  wake: WakeOutcome | null;
}
