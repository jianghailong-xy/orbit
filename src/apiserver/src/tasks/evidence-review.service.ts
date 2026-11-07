import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SESSION_ENDING_SELECT, sessionHasEnded, conversationIsOver } from '../projects/project-open-item';
import { COORDINATOR_PAUSE_SELECT, conversationIsPaused } from '../projects/coordinator-evidence-queue';
import { readBlockSender } from '../sessions/session-message';
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
export type EvidenceReviewDelivery = 'DELIVERED' | 'WAITING' | EvidenceReviewDeliveryRefusalCode | null;

/**
 * Delivers dispatched evidence and recovers unread deliveries when the conversation returns.
 * Failed runs and scheduled retries wait; genuinely ended conversations retain the owner route.
 * SEND_BACK notes are delivered to the run that submitted the evidence.
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
      select: COORDINATOR_PAUSE_SELECT,
    });
    if (!reviewer || conversationIsOver(reviewer)) return this.refused(taskId, 'REVIEWER_ENDED');
    if (conversationIsPaused(reviewer)) return 'WAITING';
    const previous = await this.prisma.conversationTurn.findFirst({
      where: { sessionId: reviewerSessionId, clientTurnId: { startsWith: evidenceReviewTurnId(evidenceId) } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (previous && (previous.deliveredAt || previous.status !== 'ANSWERED')) return 'DELIVERED';
    // Concurrent recovery attempts derive the same replacement key; createTurn serializes its write.
    const clientTurnId = previous
      ? `${evidenceReviewTurnId(evidenceId)}:retry:${previous.id}`
      : evidenceReviewTurnId(evidenceId);
    try {
      await this.sessions.createTurn(
        ownerId,
        reviewerSessionId,
        { clientTurnId, content: '', intent: 'NEXT_TURN' },
        {
          steerIfLive: true,
          participateSendTransaction: (tx) => bindEvidenceReviewDelivery(
            tx, { id: evidenceId, taskId, ownerId }, reviewerSessionId,
          ),
        },
      );
    } catch (error) {
      // Checked first: it is a Conflict too, and its code is the one the hook found.
      if (error instanceof EvidenceReviewDeliveryRefused) {
        return error.refusalCode === 'SESSION_UNAVAILABLE' ? 'WAITING' : this.refused(taskId, error.refusalCode);
      }
      if (error instanceof NotFoundException || error instanceof ConflictException
        || error instanceof ForbiddenException || error instanceof BadRequestException) {
        return 'WAITING';
      }
      throw error;
    }
    return 'DELIVERED';
  }

  /** Recover only the latest undecided revision, on turn end and the periodic idle sweep. */
  async deliverOwedTo(sessionId?: string): Promise<void> {
    try {
      const tasks = await this.prisma.task.findMany({
        where: {
          projectId: null, completionCriterion: 'EVIDENCE_JUDGMENT',
          status: { in: ['OPEN', 'IN_PROGRESS'] },
          creatorSession: {
            ...(sessionId ? { id: sessionId } : { status: { in: ['AWAITING_INPUT', 'INTERRUPTED'] } }),
          },
        },
        select: {
          id: true, ownerId: true,
          completionEvidence: { orderBy: { revision: 'desc' }, take: 1,
            select: { id: true, submittedAt: true, decisions: { select: { id: true } } } },
        },
      });
      tasks.sort((a, b) => (a.completionEvidence[0]?.submittedAt.getTime() ?? 0)
        - (b.completionEvidence[0]?.submittedAt.getTime() ?? 0));
      for (const task of tasks) {
        const revision = task.completionEvidence[0];
        if (revision && revision.decisions.length === 0) await this.deliver(task.ownerId, task.id, revision.id);
      }
    } catch (error) {
      this.logger.warn(`waiting evidence delivery failed: ${error instanceof Error ? error.message : error}`);
    }
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
   * door's own replay replays the turn instead of delivering twice. A replay whose block would read
   * differently now, its session's mode having moved, is refused by that key and logged like any
   * other delivery that cannot be made: the turn already delivered stands.
   *
   * `fromSessionId` is the session that decided, and null for the account owner's press in the app:
   * the block names it and its mode, as a session's message says who sent it (session-message.ts).
   */
  async deliverSendBack(ownerId: string, taskId: string, decisionId: string, fromSessionId: string | null): Promise<void> {
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
    const from = fromSessionId ? await readBlockSender(this.prisma, ownerId, fromSessionId, runSessionId) : null;
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
            from,
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
