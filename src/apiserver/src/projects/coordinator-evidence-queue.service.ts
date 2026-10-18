import { Injectable, Logger } from '@nestjs/common';
import { RunStatus, TaskStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { readEvidenceWaitingForCoordinator } from '../tasks/pending-evidence-judgments';
import { CompletionEvidenceProducer } from './completion-evidence.producer';
import { completionEvidenceRevisedFact } from './completion-input';
import {
  COORDINATOR_PAUSE_SELECT,
  DELIVERY_COORDINATOR_PAUSED,
  conversationIsPaused,
} from './coordinator-evidence-queue';
import { conversationIsOver } from './project-open-item';

/**
 * Hands an Automatic project's coordinator the evidence revisions that WAITED for it
 * (`coordinator-evidence-queue.ts`), oldest submission first, once it can read them.
 *
 * A revision is delivered when it is submitted and when a confirmed move hands it to a project; a
 * coordinator that is paused at that moment is not written to, and nothing about the revision
 * changes when the coordinator comes back. So this is the other half: the same rows the owner's read
 * shows as waiting, delivered through the same producer (`CompletionEvidenceProducer.deliverWaiting`)
 * at three moments —
 *
 *  - a turn of the coordinator's conversation has ended (`runner-api.controller.ts`, beside the
 *    exception items' `deliverOwedTo`): the moment a retried, re-signed-in or re-modelled coordinator
 *    is known to be back, and the moment what was queued while it was busy can be handed over;
 *  - the project's coordinator conversation was replaced (`ProjectsService.coordinator`, beside
 *    `openItems.deliverOwed`): what waited for the old one is the new one's;
 *  - and the task service's periodic tick (`TasksService.onModuleInit`), for a coordinator that is
 *    live and idle and has nothing ending to hand it over on — a paused one whose retry was cleared
 *    without a turn, or a delivery a crash cut off. The turn end is the latency; the tick is the
 *    guarantee.
 *
 * Nothing is attempted for a conversation that cannot take it now: a paused one would only refuse,
 * and every refusal is a wake row. A delivery refused as paused part-way through stops the rest,
 * which wait for the next time. Nothing here throws at its caller — each is called after somebody
 * else's write has committed — and what is not delivered is still waiting on the next read.
 */
@Injectable()
export class CoordinatorEvidenceQueueService {
  private readonly logger = new Logger(CoordinatorEvidenceQueueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly producer: CompletionEvidenceProducer,
  ) {}

  /** A conversation's turn has just ended: if it coordinates a project, hand it what waited for it. */
  async deliverOwedTo(sessionId: string): Promise<void> {
    await this.guarded('deliverOwedTo', async () => {
      const project = await this.prisma.project.findUnique({
        where: { coordinatorSessionId: sessionId },
        select: { id: true },
      });
      if (project) await this.deliverWaiting(project.id);
    });
  }

  /** Everything waiting for this project's coordinator, oldest submission first. */
  async deliverOwed(projectId: string): Promise<void> {
    await this.guarded('deliverOwed', () => this.deliverWaiting(projectId));
  }

  /**
   * The tick's half: every Automatic project whose coordinator conversation is live and idle — between
   * turns, not parked on a retry, not ended — and that has evidence nobody has settled. A project with
   * nothing waiting reads its queue and writes nothing.
   */
  async deliverToIdleCoordinators(): Promise<void> {
    await this.guarded('deliverToIdleCoordinators', async () => {
      const idle = await this.prisma.project.findMany({
        where: {
          coordinatorEnabled: true,
          coordinatorSession: {
            status: { in: [RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED] },
            endReason: null,
            retryAt: null,
            cancelRequestedAt: null,
            completedAt: null,
            archivedAt: null,
            deletedAt: null,
          },
          tasks: {
            some: {
              completionCriterion: 'EVIDENCE_JUDGMENT',
              status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] },
              completionEvidence: { some: {} },
            },
          },
        },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      for (const project of idle) await this.deliverWaiting(project.id);
    });
  }

  private async deliverWaiting(projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        ownerId: true,
        coordinatorEnabled: true,
        coordinatorSession: { select: COORDINATOR_PAUSE_SELECT },
      },
    });
    const coordinator = project?.coordinatorSession;
    if (!project?.coordinatorEnabled || !coordinator) return;
    if (conversationIsOver(coordinator) || conversationIsPaused(coordinator)) return;
    for (const waiting of await readEvidenceWaitingForCoordinator(this.prisma, project.ownerId, projectId)) {
      const fact = completionEvidenceRevisedFact({
        projectId,
        taskId: waiting.taskId,
        revision: waiting.revision,
        criterionRevision: waiting.criterionRevision,
        evidenceDigest: waiting.evidenceDigest,
        ...(waiting.place.movedFromProjectId ? { movedFromProjectId: waiting.place.movedFromProjectId } : {}),
      });
      const outcome = await this.producer.deliverWaiting(fact, {
        submittedAt: waiting.submittedAt,
        resend: waiting.place.resend,
      });
      // Paused again part-way: the rest wait for the next time it is back.
      if (outcome?.outcome === 'REFUSED' && outcome.refusalCode === DELIVERY_COORDINATOR_PAUSED) return;
    }
  }

  /** The edges this hangs off run after somebody else's commit, and may not cost it. */
  private async guarded(what: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.logger.warn(`${what} failed: ${error instanceof Error ? error.message : error}`);
    }
  }
}
