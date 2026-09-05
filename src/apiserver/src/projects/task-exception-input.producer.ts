import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import type { CompletionInputConsumer } from './completion-input';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import { WakeFact, attemptEndedUnsettledFact } from './coordinator-wake';
import type { WakeAuthorization, WakeAuthorizer } from './coordinator-wake.service';

/** The project disappeared between the committed task read and the wake's authorization. */
export const EXCEPTION_WAKE_PROJECT_GONE = 'PROJECT_GONE';

/**
 * The project still exists and its automation switch is off at authorization time.
 *
 * Spelled as the two sibling producers spell it, because it is the same refusal about the same
 * column: a refusal of automation, not a claim that the committed task fact was false.
 */
export const EXCEPTION_WAKE_COORDINATOR_DISABLED = 'COORDINATOR_DISABLED';

/**
 * Who this fact is recorded FOR today.
 *
 * A task that failed, or an attempt that ended with the task still open, is not consumed by any
 * evaluator in this tree — the four evaluator consumers lost their producers with the judgment
 * machinery — and whether such a fact should also OPEN a judgment session is a decision this unit
 * deliberately does not make: it is `CRITERION_READY`'s sibling question, "does this event change
 * the coordinator's decision", and it belongs to the unit that answers it. So the terminal claimed
 * here is the honest one: the fact is durable, idempotent and convergence-bounded, and the surface
 * it is visible on is the one a person reads.
 */
export const TASK_EXCEPTION_CONSUMER: CompletionInputConsumer = 'HUMAN_INBOX';

/** One committed task write, reduced to the columns `attemptEndedUnsettledFact` is defined over. */
interface EndedAttemptRow {
  taskId: string;
  taskStatus: string;
  projectId: string;
  sessionId: string;
  sessionStatus: string;
}

/**
 * The exception facts a committed task write justifies, and the authorizer they must be spent on.
 *
 * WHAT IS AN EXCEPTION HERE
 * =========================
 * `coordinator-wake.ts` spells exactly two: an attempt that ENDED with its task unsettled, and an
 * attempt that SPENT one of its six budget dimensions. This unit produces the first. The second
 * already has a producer (`AttemptBudgetMeterService`), already reaches the wake ledger from the
 * runner's turn-complete, and already composes `convergence.authorizeWake` — so it is covered by
 * tests here rather than reimplemented.
 *
 * A failed task and an attempt that ended over an open one are the SAME fact, deliberately. The
 * event is about the attempt, its subject version is the session id, and what distinguishes the two
 * readings is `taskStatus` in `detail`. Splitting them into two events would give one attempt two
 * keys and let one ending wake a coordinator twice.
 *
 * WHY THE AUTHORIZER IS THIS UNIT'S AND NOT THE ROUTER'S DEFAULT
 * =============================================================
 * `CompletionInputRouter.route`'s default authorizer allows every committed input. That is right
 * for a revision an agent chose to submit — the agent is the bound thing, and the fact cannot
 * arrive faster than it is written. It is wrong here, and this is precisely where "failed → open a
 * successor → fail again → open another" lives: nothing about an exception bounds how often it can
 * happen, so the only thing that can bound the WAKING is the convergence ledger. Hence
 * `authorize` below, composed cheapest refusal first with `convergence.authorizeWake` LAST — a
 * convergence pass is charged when it runs, so no cheaper refusal may follow it.
 *
 * WHY IT IS POST-COMMIT AND RE-READS
 * ==================================
 * Same reason unit T7 states: the fact's version must come from rows that ACTUALLY committed, and
 * the session that ended is not something the writing transaction has in hand. The caller passes
 * task ids generously; this unit decides what, if anything, they justify.
 */
@Injectable()
export class TaskExceptionInputProducer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly convergence: CoordinatorConvergenceService,
  ) {}

  /**
   * The `ATTEMPT_ENDED_UNSETTLED` facts these committed tasks justify, in task-id order.
   *
   * Empty is the ordinary answer: a task that settled, a task filed under no project, and a task
   * whose work attempt has not ended all owe the coordinator nothing. Whether the task settled is
   * decided by `attemptEndedUnsettledFact` rather than by a predicate in the SQL, so this producer
   * and every other one agree about what "unsettled" means.
   */
  async factsFor(taskIds: ReadonlyArray<string | null | undefined>): Promise<WakeFact[]> {
    const ids = [...new Set(taskIds.filter((id): id is string => !!id))].sort();
    if (ids.length === 0) return [];

    // The task's most recent ENDED work attempt. `starts_task_work` is what makes a session an
    // attempt on this task rather than a judgment or a conversation about it; `retry_at IS NULL`
    // is what makes it ended rather than paused — a retry still armed will run another turn on the
    // same session, so the attempt is not over and its id is not yet a fact.
    const rows = await this.prisma.$queryRaw<EndedAttemptRow[]>(Prisma.sql`
      SELECT t."id" AS "taskId", t."status"::text AS "taskStatus",
             t."project_id" AS "projectId",
             a."id" AS "sessionId", a."status"::text AS "sessionStatus"
        FROM "task" t
        JOIN LATERAL (
          SELECT s."id", s."status"
            FROM "session" s
           WHERE s."task_id" = t."id"
             AND s."starts_task_work" = true
             AND s."deleted_at" IS NULL
             AND s."retry_at" IS NULL
             AND s."status" IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
           ORDER BY s."updated_at" DESC, s."id" DESC
           LIMIT 1
        ) a ON true
       WHERE t."id" = ANY(${ids}::uuid[])
         AND t."project_id" IS NOT NULL
       ORDER BY t."id"
    `);

    return rows
      .map((row) => attemptEndedUnsettledFact({
        projectId: row.projectId,
        taskId: row.taskId,
        taskStatus: row.taskStatus,
        sessionId: row.sessionId,
        sessionStatus: row.sessionStatus,
      }))
      .filter((fact): fact is WakeFact => fact !== null);
  }

  /**
   * The authorizer every exception delivery must be routed with.
   *
   * A property field rather than a method, for the reason `CoordinatorConvergenceService` states
   * about its own: handed to `route` as a bare method it would arrive without its `this`, and a
   * throw inside an authorizer is recorded as `WAKE_AUTHORIZATION_FAILED` — a wiring mistake
   * wearing the costume of a transient failure.
   */
  readonly authorize: WakeAuthorizer = async (fact, claim): Promise<WakeAuthorization> => {
    // T2's order is claim first, authorize second. This read stays here rather than in `factsFor`:
    // hoisting it would make permission decide who wins the idempotency key.
    const project = await this.prisma.project.findUnique({
      where: { id: fact.projectId },
      select: { coordinatorEnabled: true },
    });
    if (!project) return { allowed: false, refusalCode: EXCEPTION_WAKE_PROJECT_GONE };
    if (!project.coordinatorEnabled) {
      return { allowed: false, refusalCode: EXCEPTION_WAKE_COORDINATOR_DISABLED };
    }
    return this.convergence.authorizeWake(fact, claim);
  };
}
