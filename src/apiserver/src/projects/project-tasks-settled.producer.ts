import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import {
  CoordinatorJudgmentService,
  type JudgmentOutcome,
} from './coordinator-judgment.service';
import { projectTasksSettledFact } from './coordinator-wake';

/**
 * The project's automation switch is off at the authorization read which follows a won claim.
 *
 * Kept as the same spelling T2's ledger examples already use: this is a refusal of automation,
 * not a statement that the committed task fact was false. The refused wake releases its key.
 */
export const SETTLED_WAKE_COORDINATOR_DISABLED = 'COORDINATOR_DISABLED';

/** The project disappeared after its task rows were read and before the won wake was authorized. */
export const SETTLED_WAKE_PROJECT_GONE = 'PROJECT_GONE';

export interface SettledProjectDelivery {
  projectId: string;
  outcome: JudgmentOutcome['outcome'] | 'NOT_SETTLED';
}

/**
 * Unit T7: turn committed task rows into `PROJECT_TASKS_SETTLED` judgment wakes.
 *
 * This deliberately lives on the post-commit side of a task write. A judgment session is heavy —
 * opening it may queue a runner — and cannot be part of the transaction which changes the task.
 * More importantly, the fact's version must be derived from the rows which ACTUALLY committed,
 * including aggregate parents that the originating write may have settled. The producer therefore
 * receives project ids, re-reads their complete task sets, derives T2's closed fact, and hands it
 * to T3's composed `wake` entry point.
 *
 * There is no timer and no process-local exclusion here. Concurrent last-task writes can both
 * derive the same fact; the wake ledger's partial unique index decides which one opens the single
 * judgment session. Re-delivery is consequently both safe and useful.
 */
@Injectable()
export class ProjectTasksSettledProducer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly judgments: CoordinatorJudgmentService,
    private readonly convergence: CoordinatorConvergenceService,
  ) {}

  async afterCommit(
    projectIds: ReadonlyArray<string | null | undefined>,
  ): Promise<SettledProjectDelivery[]> {
    const ids = [...new Set(projectIds.filter((id): id is string => !!id))].sort();
    const deliveries: SettledProjectDelivery[] = [];

    for (const projectId of ids) {
      const tasks = await this.prisma.task.findMany({
        where: { projectId },
        select: { id: true, status: true },
      });
      const fact = projectTasksSettledFact(
        projectId,
        tasks.map((task) => ({ taskId: task.id, status: task.status })),
      );
      if (!fact) {
        deliveries.push({ projectId, outcome: 'NOT_SETTLED' });
        continue;
      }

      const outcome = await this.judgments.wake(fact, async (claimedFact, claim) => {
        // T2's order is claim first, authorize second. Do not hoist this read above `wake`: doing
        // so would make permission participate in who wins the idempotency key.
        const project = await this.prisma.project.findUnique({
          where: { id: projectId },
          select: { coordinatorEnabled: true },
        });
        if (!project) {
          return { allowed: false as const, refusalCode: SETTLED_WAKE_PROJECT_GONE };
        }
        if (!project.coordinatorEnabled) {
          return { allowed: false as const, refusalCode: SETTLED_WAKE_COORDINATOR_DISABLED };
        }
        // T4 is deliberately last: this decision spends a convergence pass, so no cheaper refusal
        // may run after it and charge a judgment whose session will never open.
        return this.convergence.authorizeWake(claimedFact, claim);
      });
      deliveries.push({ projectId, outcome: outcome.outcome });
    }

    return deliveries;
  }
}
