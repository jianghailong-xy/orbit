import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SESSION_ENDING_SELECT, sessionHasEnded } from '../projects/project-open-item';
import { SessionsService } from '../sessions/sessions.service';
import {
  EvidenceReviewDeliveryRefused,
  bindEvidenceReviewDelivery,
  evidenceReviewTurnId,
  evidenceSendBackMessage,
  evidenceSendBackTurnId,
  type EvidenceReviewDeliveryRefusalCode,
} from './evidence-review';

/** What one delivery came to: handed over, refused with its reason, or not a revision anybody is handed. */
export type EvidenceReviewDelivery = 'DELIVERED' | EvidenceReviewDeliveryRefusalCode | null;

/**
 * Hands a dispatched task's evidence revision to the session that dispatched it (`evidence-review.ts`).
 *
 * The delivery of a confirmation request to its reviewer, applied to an evidence revision
 * (`OwnerConfirmationReviewService.deliver`, docs/owner-confirmation-review-contract.md §2 D2): after
 * the commit that wrote the revision, one `NEXT_TURN` platform turn keyed by the revision, no
 * words of anybody's, never reviving a conversation that has ended, and the owner's card covering
 * every refusal.
 *
 * Written into the turn the session is running when it can be (`steerIfLive`, the way a background
 * job's exit is): a dispatching session usually is running one — watching the very tasks it filed —
 * and a review queued behind it waited out the whole 30-minute hold unread, so the owner was asked
 * every time (2026-10-06: four revisions, all PENDING while every message after them steered in). It differs in keeping nothing of its own: the turn is the delivery, so a refusal
 * writes nothing and a fault leaves the revision undelivered — and either way not held, which puts it
 * in front of the owner at once.
 *
 * The same unit also carries the one delivery a decision makes: `deliverSendBack` hands a recorded
 * SEND_BACK's note to the run that submitted the revision, so the loop the decision opens has
 * somebody told to walk it.
 */
@Injectable()
export class EvidenceReviewService {
  private readonly logger = new Logger(EvidenceReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
  ) {}

  /**
   * Deliver one committed revision, or answer why not. Null when the task is not dispatched work in
   * no project waiting on a judgment — the revision is nobody's to be handed, and nothing changes for
   * it. A redelivery of the same revision replays the turn already written, which is what makes it once.
   */
  async deliver(ownerId: string, taskId: string, evidenceId: string): Promise<EvidenceReviewDelivery> {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, ownerId },
      select: { projectId: true, creatorSessionId: true, completionCriterion: true },
    });
    if (!task || task.projectId !== null || !task.creatorSessionId
      || task.completionCriterion !== 'EVIDENCE_JUDGMENT') return null;
    const reviewerSessionId = task.creatorSessionId;
    // Read before the turn, because `createTurn` refuses an ended conversation by itself and before
    // the hook below runs, which would read as SESSION_UNAVAILABLE where the reason is that it ended.
    // The hook asks again under the lock.
    const reviewer = await this.prisma.session.findFirst({
      where: { id: reviewerSessionId, ownerId },
      select: SESSION_ENDING_SELECT,
    });
    if (!reviewer || sessionHasEnded(reviewer)) return this.refused(taskId, 'REVIEWER_ENDED');
    try {
      await this.sessions.createTurn(
        ownerId,
        reviewerSessionId,
        { clientTurnId: evidenceReviewTurnId(evidenceId), content: '', intent: 'NEXT_TURN' },
        {
          steerIfLive: true,
          participateSendTransaction: (tx) => bindEvidenceReviewDelivery(
            tx, { id: evidenceId, taskId, ownerId }, reviewerSessionId,
          ),
        },
      );
    } catch (error) {
      // Checked first: it is a Conflict too, and its code is the one the hook found.
      if (error instanceof EvidenceReviewDeliveryRefused) return this.refused(taskId, error.refusalCode);
      if (error instanceof NotFoundException || error instanceof ConflictException
        || error instanceof ForbiddenException || error instanceof BadRequestException) {
        return this.refused(taskId, 'SESSION_UNAVAILABLE');
      }
      throw error;
    }
    return 'DELIVERED';
  }

  private refused(taskId: string, code: EvidenceReviewDeliveryRefusalCode): EvidenceReviewDeliveryRefusalCode {
    this.logger.log(`evidence of task ${taskId} was not handed to its dispatching session (${code}); `
      + 'the owner\'s card has it');
    return code;
  }

  /**
   * Deliver a recorded SEND_BACK's note to the run that submitted the decided revision — the one
   * session that must act on it, which the decision row alone never told (2026-10-09: an owner's
   * send-back stalled a task because neither the run nor the project's coordinator could see the
   * reason). In a project or out of it, and whoever decided: the revision's `sourceSessionId` is
   * always the run to carry on.
   *
   * Called after the decision's commit, so a delivery that cannot be made — the run has ended, or
   * a fault — is logged and never reported as a failed decision: the note is recorded, and stays
   * readable on the revision in `task_evidence_list`. Keyed by the decision row, so the decide
   * door's own replay replays the turn instead of delivering twice.
   */
  async deliverSendBack(ownerId: string, taskId: string, decisionId: string): Promise<void> {
    const decision = await this.prisma.taskEvidenceDecision.findFirst({
      where: { id: decisionId, taskId, ownerId },
      select: {
        decision: true,
        note: true,
        decidedByType: true,
        evidence: { select: { revision: true, sourceSessionId: true } },
        task: { select: { title: true } },
      },
    });
    if (!decision || decision.decision !== 'SEND_BACK' || !decision.note) return;
    const runSessionId = decision.evidence.sourceSessionId;
    // Read before the turn for the log's sake: `createTurn` refuses an ended conversation itself,
    // which the catch below would report as a fault where the reason is that it ended.
    const run = await this.prisma.session.findFirst({
      where: { id: runSessionId, ownerId },
      select: SESSION_ENDING_SELECT,
    });
    if (!run || sessionHasEnded(run)) {
      this.logger.log(`send-back of task ${taskId} was not handed to its run: the session has ended; `
        + 'the note is on the revision in task_evidence_list');
      return;
    }
    try {
      await this.sessions.createTurn(
        ownerId,
        runSessionId,
        {
          clientTurnId: evidenceSendBackTurnId(decisionId),
          content: evidenceSendBackMessage({
            taskId,
            taskTitle: decision.task.title,
            revision: decision.evidence.revision.toString(),
            decidedByType: decision.decidedByType,
            note: decision.note,
          }),
          intent: 'NEXT_TURN',
        },
        { steerIfLive: true },
      );
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ConflictException
        || error instanceof ForbiddenException || error instanceof BadRequestException) {
        this.logger.warn(`send-back of task ${taskId} was not handed to its run: `
          + `${error instanceof Error ? error.message : error}`);
        return;
      }
      throw error;
    }
  }
}
