import { Injectable } from '@nestjs/common';
import type { TaskDispatchRefusal } from '@orbit/shared';

import { PrismaService } from '../prisma/prisma.service';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import { CoordinatorDeliveryService } from './coordinator-delivery.service';
import { WakeFact, taskDispatchRefusedFact } from './coordinator-wake';
import type { WakeAuthorization, WakeAuthorizer } from './coordinator-wake.service';

/** The project disappeared between the committed task read and the wake's authorization. */
export const DISPATCH_REFUSED_WAKE_PROJECT_GONE = 'PROJECT_GONE';

/**
 * The project still exists and its automation switch is off at authorization time — the same
 * refusal, about the same column, its four siblings spell this way.
 */
export const DISPATCH_REFUSED_WAKE_COORDINATOR_DISABLED = 'COORDINATOR_DISABLED';

/** What one refused start's delivery answered, for a caller that has to say what happened. */
export interface DispatchRefusalDelivery {
  taskId: string;
  outcome: 'DELIVERED' | 'ALREADY_DELIVERED' | 'ALREADY_AWAKE' | 'REFUSED';
  refusalCode?: string;
}

/**
 * `TASK_DISPATCH_REFUSED`: the start the runner refused, delivered to the conversation coordinating
 * the project (`tasks/task-dispatch-refusal.ts` records it).
 *
 * WHY IT GOES TO THE STANDING CONVERSATION, EVERY TIME
 * ====================================================
 * Its siblings ask `wake-disposition.ts` what a fact is worth, because for them the answer turns on
 * the criteria: a failure while other work still serves the criterion changes nothing. A refused
 * start is not that. Nothing else is going to run this task — its run never began, and starting it
 * again meets the same refusal until something about the line changes — so it is always one action
 * owed by whoever is coordinating: bring the line up to the commit, then start it. That is the
 * shape `CRITERION_UNLANDED`'s merge has (§2.2 there), and it goes where that goes, through the
 * same `CoordinatorDeliveryService`: the wake ledger claims the fact's key, this unit's authorizer
 * decides whether it may be spent, and the message is a turn on the conversation the project
 * already has. A judgment session opened for it would be a second coordinator deciding about a
 * line the first one is already working on.
 *
 * AND WHAT HAPPENS WHEN IT CANNOT BE
 * ==================================
 * Exactly what happens to every delivery on that carrier: no conversation, an ended one, a switched
 * off coordinator or a conversation still holding an unread message is REFUSED, with the code, in
 * the ledger, and the key goes back. The refusal itself does not depend on it — it is on the task,
 * which is what the detail and the list show.
 *
 * WHY IT RE-READS
 * ===============
 * Post-commit, like every producer here: the fact is built from the task row the finalize
 * committed, not from anything the finalize had in hand, so a caller passes ids and this unit
 * decides what they justify — a task whose latest start was not refused justifies nothing.
 */
@Injectable()
export class TaskDispatchRefusalProducer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly convergence: CoordinatorConvergenceService,
    private readonly delivery: CoordinatorDeliveryService,
  ) {}

  /** The refused starts these committed tasks record, in task-id order. */
  async factsFor(taskIds: ReadonlyArray<string | null | undefined>): Promise<WakeFact[]> {
    const ids = [...new Set(taskIds.filter((id): id is string => !!id))].sort();
    if (ids.length === 0) return [];
    const rows = await this.prisma.task.findMany({
      where: { id: { in: ids }, projectId: { not: null } },
      select: { id: true, title: true, projectId: true, dispatchRefusal: true },
      orderBy: { id: 'asc' },
    });
    return rows
      .filter((row) => row.dispatchRefusal != null)
      .map((row) => taskDispatchRefusedFact({
        projectId: row.projectId!,
        taskId: row.id,
        taskTitle: row.title,
        refusal: row.dispatchRefusal as unknown as TaskDispatchRefusal,
      }));
  }

  /** Deliver each refused start these tasks record. Never throws for a delivery refused. */
  async deliver(taskIds: ReadonlyArray<string | null | undefined>): Promise<DispatchRefusalDelivery[]> {
    const deliveries: DispatchRefusalDelivery[] = [];
    for (const fact of await this.factsFor(taskIds)) {
      const delivered = await this.delivery.deliver(fact, this.authorize);
      deliveries.push({
        taskId: fact.subjectId,
        outcome: delivered.outcome,
        ...(delivered.outcome === 'REFUSED' ? { refusalCode: delivered.refusalCode } : {}),
      });
    }
    return deliveries;
  }

  /**
   * The authorizer every refused-start delivery must be spent with: its siblings' shape, cheapest
   * refusal first and `convergence.authorizeWake` LAST, because that one records a judgment.
   *
   * A property field rather than a method, for the reason `CoordinatorConvergenceService` gives
   * about its own.
   */
  readonly authorize: WakeAuthorizer = async (fact, claim): Promise<WakeAuthorization> => {
    const project = await this.prisma.project.findUnique({
      where: { id: fact.projectId },
      select: { coordinatorEnabled: true },
    });
    if (!project) return { allowed: false, refusalCode: DISPATCH_REFUSED_WAKE_PROJECT_GONE };
    if (!project.coordinatorEnabled) {
      return { allowed: false, refusalCode: DISPATCH_REFUSED_WAKE_COORDINATOR_DISABLED };
    }
    return this.convergence.authorizeWake(fact, claim);
  };
}
