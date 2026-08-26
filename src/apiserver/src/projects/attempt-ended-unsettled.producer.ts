import { Injectable, Logger } from '@nestjs/common';
import { RunStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import {
  CoordinatorJudgmentService,
  type JudgmentOutcome,
} from './coordinator-judgment.service';
import { attemptEndedUnsettledFact } from './coordinator-wake';

/** The project vanished between the committed attempt read and wake authorization. */
export const ATTEMPT_WAKE_PROJECT_GONE = 'PROJECT_GONE';

/** The project still exists, but its automation switch is off at authorization time. */
export const ATTEMPT_WAKE_COORDINATOR_DISABLED = 'COORDINATOR_DISABLED';

export type AttemptEndedDelivery =
  | { outcome: 'NOT_ENDED' | 'NOT_PROJECT_TASK' | 'TASK_SETTLED' }
  | { outcome: JudgmentOutcome['outcome']; projectId: string; taskId: string };

const TERMINAL_SESSION_STATUSES: readonly RunStatus[] = [
  RunStatus.SUCCEEDED,
  RunStatus.FAILED,
  RunStatus.CANCELLED,
];

/**
 * Turn a committed terminal task attempt into T2's `ATTEMPT_ENDED_UNSETTLED` fact.
 *
 * The caller supplies only the Session identity. Status, task settlement and project scope are
 * re-read after the transaction that ended the attempt committed, so a request body cannot claim
 * its own failure and a pre-commit snapshot cannot race the Task write. A retry which is still
 * armed is not an ended attempt yet: the same Session may run another turn, so its immutable id is
 * not a final subject version until `retryAt` clears.
 *
 * Authorization follows T2/T4's load-bearing order: win the fact key first, apply the cheap
 * project switch next, and charge the durable convergence decision last. There is no timer and no
 * process-local exclusion; re-delivery is collapsed by the wake ledger.
 */
@Injectable()
export class AttemptEndedUnsettledProducer {
  private readonly logger = new Logger(AttemptEndedUnsettledProducer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly judgments: CoordinatorJudgmentService,
    private readonly convergence: CoordinatorConvergenceService,
  ) {}

  async afterCommit(sessionId: string): Promise<AttemptEndedDelivery> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: {
        status: true,
        retryAt: true,
        task: { select: { id: true, status: true, projectId: true } },
      },
    });
    if (
      !session
      || !TERMINAL_SESSION_STATUSES.includes(session.status)
      || session.retryAt != null
    ) {
      return { outcome: 'NOT_ENDED' };
    }
    const task = session.task;
    if (!task) return { outcome: 'NOT_PROJECT_TASK' };
    const projectId = task.projectId;
    if (!projectId) return { outcome: 'NOT_PROJECT_TASK' };
    const fact = attemptEndedUnsettledFact({
      projectId,
      taskId: task.id,
      taskStatus: task.status,
      sessionId,
    });
    if (!fact) return { outcome: 'TASK_SETTLED' };

    const result = await this.judgments.wake(fact, async (claimedFact, claim) => {
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { coordinatorEnabled: true },
      });
      if (!project) {
        return { allowed: false as const, refusalCode: ATTEMPT_WAKE_PROJECT_GONE };
      }
      if (!project.coordinatorEnabled) {
        return { allowed: false as const, refusalCode: ATTEMPT_WAKE_COORDINATOR_DISABLED };
      }
      return this.convergence.authorizeWake(claimedFact, claim);
    });
    return { outcome: result.outcome, projectId, taskId: task.id };
  }

  /** A post-commit producer cannot roll the already committed runner transaction back. */
  async afterCommitQuietly(sessionId: string): Promise<void> {
    try {
      await this.afterCommit(sessionId);
    } catch (error) {
      this.logger.error(
        `ATTEMPT_ENDED_UNSETTLED delivery failed for session ${sessionId}: `
          + (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}
