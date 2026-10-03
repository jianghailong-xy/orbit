import { Injectable } from '@nestjs/common';
import { TaskStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  criterionStandingRefusal,
  decidingSessionDisqualification,
  quotedCriterion,
} from '../tasks/task-evidence-decision';
import { completionEvidenceWakeKey } from './completion-input';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import {
  CoordinatorDeliveryService,
  type CoordinatorDeliveryOutcome,
} from './coordinator-delivery.service';
import { type WakeFact, wakeIdempotencyKey } from './coordinator-wake';
import type { WakeAuthorization, WakeAuthorizer } from './coordinator-wake.service';
import { openFuseEpisodeId, refusingWhileFusePaused } from './project-fuse';

/** The project disappeared between the committed read and the wake's authorization. */
export const COMPLETION_EVIDENCE_WAKE_PROJECT_GONE = 'PROJECT_GONE';

/**
 * The project still exists and its automation switch is off at authorization time — spelled as the
 * sibling producers spell it, because it is the same refusal about the same column.
 */
export const COMPLETION_EVIDENCE_WAKE_COORDINATOR_DISABLED = 'COORDINATOR_DISABLED';

/**
 * In an Automatic project, the evidence revision a task submits goes to the project's standing
 * coordinator conversation, which decides it; the account owner's card is the fallback.
 *
 * WHY THE COORDINATOR, AND WHY THE OWNER'S CARD STAYS
 * ===================================================
 * An EVIDENCE_JUDGMENT is meant to be decided by a session that did not do the work, and the
 * authority table says so: concluding a verdict from evidence is COORDINATOR_BOUNDED
 * (`coordinator-authority.ts`). On 2026-09-10 the delivery of this fact was removed on the premise
 * that only the owner could answer it — the turn could only relay the question, and the relay was
 * slow and died with its turn — and from 09-14 to 09-29 the owner pressed 96 of the 100 evidence
 * cards in Automatic projects. Relaying is still not what this does: the coordinator is told to
 * DECIDE (`task_evidence_decide`), and the owner's card, drawn from `readPendingEvidenceJudgments`,
 * is held back only while the delivered revision is the coordinator's to decide
 * (`exceptionEscalationSeconds` from the delivery, the clock the project's exception items use).
 * The owner may decide at any time regardless; the decision door does not ask who was told.
 *
 * WHICH REVISIONS
 * ===============
 * Only the ones the standing conversation could actually settle, asked through the decision
 * door's own predicates: the project is Automatic; the task declared EVIDENCE_JUDGMENT and has not
 * settled; the revision this fact names is still its latest and still unanswered; the evidence
 * quotes a live stated standard (`criterionStandingRefusal`); and the conversation took no part in
 * the work (`decidingSessionDisqualification`). Anything else is recorded exactly as it was before this
 * producer existed (`CompletionInputRouter.routeCompletionEvidence`) and is the owner's question
 * from the start. A project with no conversation, or one that has ended, is NOT filtered here:
 * `CoordinatorDeliveryService.queue` refuses those, and the refusal is the record of why the owner
 * was asked.
 *
 * WHY THE AUTHORIZER IS THIS UNIT'S
 * =================================
 * The switch is read again at authorization — the router's read is not a permission — then the
 * fuse (`refusingWhileFusePaused`: a coordinator paused for over-spending is not handed more to
 * decide, and the owner's card covers the pause), and `convergence.authorizeWake` LAST, because it
 * records a judgment and no refusal may follow it.
 */
@Injectable()
export class CompletionEvidenceProducer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly convergence: CoordinatorConvergenceService,
    private readonly deliveries: CoordinatorDeliveryService,
  ) {}

  /**
   * Deliver one committed revision to the project's standing conversation as a queued turn, or
   * answer null — nothing claimed, nothing delivered — when it is not a revision that conversation
   * decides.
   *
   * After the commit and never inside it, for the reason every door on the router gives.
   */
  async deliver(fact: WakeFact): Promise<CoordinatorDeliveryOutcome | null> {
    const told = await this.decidedByCoordinator(fact);
    return told ? this.deliveries.queue(told, this.authorize) : null;
  }

  /**
   * The fact as the coordinator is told it — with the task's title, the criterion the evidence
   * quotes and the project's escalation clock in its `detail`, for the message and nothing else —
   * or null when the standing conversation is not the one to decide it.
   */
  private async decidedByCoordinator(fact: WakeFact): Promise<WakeFact | null> {
    const project = await this.prisma.project.findUnique({
      where: { id: fact.projectId },
      select: {
        ownerId: true,
        coordinatorEnabled: true,
        exceptionEscalationSeconds: true,
        coordinatorSession: { select: { id: true, taskId: true } },
      },
    });
    if (!project?.coordinatorEnabled) return null;

    const task = await this.prisma.task.findFirst({
      where: {
        id: fact.subjectId,
        ownerId: project.ownerId,
        projectId: fact.projectId,
        completionCriterion: 'EVIDENCE_JUDGMENT',
        status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] },
      },
      select: {
        id: true,
        title: true,
        projectId: true,
        criterionDefinitionId: true,
        criterionRevision: true,
        acceptanceCriteria: true,
        completionEvidence: {
          orderBy: { revision: 'desc' },
          take: 1,
          select: {
            revision: true,
            criterionRevision: true,
            evidenceDigest: true,
            evidence: true,
            decisions: { select: { id: true }, take: 1 },
          },
        },
      },
    });
    const [latest] = task?.completionEvidence ?? [];
    if (!task || !latest || latest.decisions.length > 0) return null;
    // Compared by the fact's identity rather than by its `detail`: a revision a later one has
    // already replaced is not a question anybody is asking, and that one routes its own fact.
    const current = completionEvidenceWakeKey(task.id, {
      revision: latest.revision.toString(),
      criterionRevision: latest.criterionRevision,
      evidenceDigest: latest.evidenceDigest,
    });
    if (current !== wakeIdempotencyKey(fact)) return null;

    if ((await criterionStandingRefusal(this.prisma, task, latest.evidence)) !== null) return null;
    const standing = project.coordinatorSession;
    if (standing) {
      const scope = { ownerId: project.ownerId, taskId: task.id };
      const disqualified = await decidingSessionDisqualification(this.prisma, scope, standing);
      if (disqualified !== null) return null;
    }

    return {
      ...fact,
      detail: {
        ...fact.detail,
        title: task.title,
        criterion: quotedCriterion(latest.evidence),
        escalationSeconds: project.exceptionEscalationSeconds,
      },
    };
  }

  /**
   * The authorizer every evidence delivery is routed with. A property rather than a method, for the
   * reason `DependentReadyProducer.authorize` gives: handed across bare, a method loses its `this`.
   */
  readonly authorize: WakeAuthorizer = async (fact, claim): Promise<WakeAuthorization> => {
    const project = await this.prisma.project.findUnique({
      where: { id: fact.projectId },
      select: { coordinatorEnabled: true },
    });
    if (!project) return { allowed: false, refusalCode: COMPLETION_EVIDENCE_WAKE_PROJECT_GONE };
    if (!project.coordinatorEnabled) {
      return { allowed: false, refusalCode: COMPLETION_EVIDENCE_WAKE_COORDINATOR_DISABLED };
    }
    return refusingWhileFusePaused(
      this.convergence.authorizeWake,
      () => openFuseEpisodeId(this.prisma, fact.projectId),
    )(fact, claim);
  };
}
