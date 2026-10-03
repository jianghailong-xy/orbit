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
  type EvidenceReviewDeliveryRefusalCode,
} from './evidence-review';

/** What one delivery came to: handed over, refused with its reason, or not a revision anybody is handed. */
export type EvidenceReviewDelivery = 'DELIVERED' | EvidenceReviewDeliveryRefusalCode | null;

/**
 * Hands a dispatched task's evidence revision to the session that dispatched it (`evidence-review.ts`).
 *
 * The delivery of a confirmation request to its reviewer, applied to an evidence revision
 * (`OwnerConfirmationReviewService.deliver`, docs/owner-confirmation-review-contract.md §2 D2): after
 * the commit that wrote the revision, one queued `NEXT_TURN` platform turn keyed by the revision, no
 * words of anybody's, never reviving a conversation that has ended, and the owner's card covering
 * every refusal. It differs in keeping nothing of its own: the turn is the delivery, so a refusal
 * writes nothing and a fault leaves the revision undelivered — and either way not held, which puts it
 * in front of the owner at once.
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
}
