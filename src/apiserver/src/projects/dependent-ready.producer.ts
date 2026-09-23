import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { manualRunnableTaskSql } from '../tasks/manual-runnable-task-sql';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import {
  CoordinatorDeliveryService,
  type CoordinatorDeliveryOutcome,
} from './coordinator-delivery.service';
import { WakeFact, dependentReadyFact } from './coordinator-wake';
import type { WakeAuthorization, WakeAuthorizer } from './coordinator-wake.service';

/** The project disappeared between the committed read and the wake's authorization. */
export const DEPENDENT_READY_WAKE_PROJECT_GONE = 'PROJECT_GONE';

/**
 * The project still exists and its automation switch is off at authorization time.
 *
 * Spelled as the sibling producers spell it, because it is the same refusal about the same column:
 * a refusal of automation, not a claim that the committed fact was false.
 */
export const DEPENDENT_READY_WAKE_COORDINATOR_DISABLED = 'COORDINATOR_DISABLED';

/** What one dependent's delivery answered, for a caller that has to say what happened. */
export interface DependentReadyDelivery {
  /** The dependent the fact names — the task that can now be started. */
  taskId: string;
  outcome: CoordinatorDeliveryOutcome['outcome'];
  refusalCode?: string;
}

/**
 * The `DEPENDENT_READY` facts a committed landing (or completion) justifies, and the delivery they
 * are spent on.
 *
 * WHERE THE CANDIDATES COME FROM
 * ==============================
 * From the dispatch that starts auto-run dependents on the same two edges
 * (`TasksService.dispatchDependentsOf`, reached from a task's DONE and from a landing receipt —
 * contract §2.5 J10). That pass already answers "what did this release" — the dependents of the
 * task that just finished or landed, followed through supersession, each judged by the dependency
 * rule's own read (`computeDependencyState` over `prerequisiteLanded`, §2.5 J9) — and the ones it
 * finds READY and leaves alone because `autoRunWhenReady = false` are handed here. So the trigger
 * is exactly the one the task that opted in would have been started on: its LAST prerequisite
 * landing on the integration line, or its DONE where there is nothing to land. A prerequisite that
 * is only DONE holds its dependent out of both.
 *
 * Anchored on those tasks rather than read project-wide, for the reason
 * `project-tasks-settled.producer.ts` gives about its roster read: one project on this deployment
 * holds ~110k tasks, and a scan of a whole project on every completion is the cost that producer
 * had to remove.
 *
 * WHAT IS RE-READ, AND WHY
 * ========================
 * The ids are the caller's; the fact is derived from the committed rows, by id, after the commit —
 * "callers pass ids generously; this unit decides what they justify", as every door here says. A
 * candidate becomes a fact when it
 *
 *   * is filed under a project — the fact goes to that project's coordinator;
 *   * waits on at least one prerequisite — the fact is about work that was being held;
 *   * is OPEN — not started, or put back to be started again;
 *   * will not start by itself: `auto_run_when_ready = false` and no `run_at`. A task with an
 *     appointment is started by the schedule, and telling a coordinator about it would be telling it
 *     about work that is already on its way;
 *   * and is startable NOW, by `manualRunnableTaskSql` — the predicate the execute gate and the
 *     Ready-to-run list share, which reaches the dependency rule through `dependenciesSatisfiedSql`
 *     (§2.5 J9's SQL spelling). Whatever moved between the dispatch's read and this one, what is
 *     delivered is what `task_start` would accept.
 *
 * WHY IT DELIVERS RATHER THAN RECORDS
 * ===================================
 * A fact whose whole content is "a decision is waiting" is worth nothing recorded where nobody
 * reads it, so it goes to the project's standing coordinator conversation — through
 * `CoordinatorDeliveryService.queue`, the carrier that queues behind a busy conversation instead of
 * refusing it (that method says why this fact, in particular, cannot survive the other one). It is
 * NOT routed through `WakeDispositionService`: that unit decides between a judgment session and a
 * record by the coverage of the criterion a TASK serves, and a dependent that has not started is
 * pending work, which is not what this fact is about.
 *
 * WHY THE AUTHORIZER IS THIS UNIT'S
 * =================================
 * The fact is derived from the project's rows, so it answers to the project's coordinator switch,
 * composed cheapest refusal first with `convergence.authorizeWake` LAST — that records a judgment,
 * so no refusal may follow it and leave a record of a wake that never happened.
 */
@Injectable()
export class DependentReadyProducer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly convergence: CoordinatorConvergenceService,
    private readonly deliveries: CoordinatorDeliveryService,
  ) {}

  /**
   * The `DEPENDENT_READY` facts these released dependents justify, oldest first.
   *
   * Empty is an ordinary answer: the dependent may have been started, scheduled or re-held between
   * the dispatch that named it and this read.
   */
  async factsFor(taskIds: ReadonlyArray<string | null | undefined>): Promise<WakeFact[]> {
    const ids = [...new Set(taskIds.filter((id): id is string => !!id))].sort();
    if (ids.length === 0) return [];

    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; projectId: string; title: string; epoch: bigint }>
    >(Prisma.sql`
      SELECT t.id, t.project_id AS "projectId", t.title, COALESCE(e.epoch, 0) AS "epoch"
        FROM task t
        LEFT JOIN task_dispatch_epoch e ON e.task_id = t.id
       WHERE t.id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
         AND t.project_id IS NOT NULL
         AND t.status = 'OPEN'::task_status
         AND t.auto_run_when_ready = false
         AND t.run_at IS NULL
         AND EXISTS (SELECT 1 FROM task_dependency d WHERE d.task_id = t.id)
         AND ${Prisma.raw(manualRunnableTaskSql('t'))}
       ORDER BY t.created_at, t.id`);

    return rows.map((row) => dependentReadyFact({
      projectId: row.projectId,
      taskId: row.id,
      title: row.title,
      dispatchEpoch: row.epoch,
    }));
  }

  /**
   * Derive, then deliver each fact to its project's standing coordinator conversation.
   *
   * After the commit and never inside it, for the reason every door on the router gives: the
   * facts are derived from the rows that actually committed, and a delivery writes a turn on
   * another conversation, which no write of a receipt or a task may hold its locks across.
   */
  async afterCommit(
    taskIds: ReadonlyArray<string | null | undefined>,
  ): Promise<DependentReadyDelivery[]> {
    const facts = await this.factsFor(taskIds);
    const delivered: DependentReadyDelivery[] = [];
    for (const fact of facts) {
      const answer = await this.deliveries.queue(fact, this.authorize);
      delivered.push({
        taskId: fact.subjectId,
        outcome: answer.outcome,
        ...(answer.outcome === 'REFUSED' ? { refusalCode: answer.refusalCode } : {}),
      });
    }
    return delivered;
  }

  /**
   * The authorizer every dependent-readiness delivery is routed with.
   *
   * A property field rather than a method, for the reason `CoordinatorConvergenceService` states
   * about its own: handed across as a bare method it would arrive without its `this`, and a throw
   * inside an authorizer is recorded as `WAKE_AUTHORIZATION_FAILED` — a wiring mistake wearing the
   * costume of a transient failure.
   */
  readonly authorize: WakeAuthorizer = async (fact, claim): Promise<WakeAuthorization> => {
    // T2's order is claim first, authorize second. This read stays here rather than in `factsFor`:
    // hoisting it would make permission decide who wins the idempotency key.
    const project = await this.prisma.project.findUnique({
      where: { id: fact.projectId },
      select: { coordinatorEnabled: true },
    });
    if (!project) return { allowed: false, refusalCode: DEPENDENT_READY_WAKE_PROJECT_GONE };
    if (!project.coordinatorEnabled) {
      return { allowed: false, refusalCode: DEPENDENT_READY_WAKE_COORDINATOR_DISABLED };
    }
    return this.convergence.authorizeWake(fact, claim);
  };
}
