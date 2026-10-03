import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma, TaskStatus } from '@prisma/client';
import {
  RunEventType,
  type ConfirmationNeedsYouItem,
  type ConfirmationReviewLists,
  type OwnerConfirmationAnswer,
  type OwnerConfirmationReviewState,
} from '@orbit/shared';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { openFuseEpisodeId } from '../projects/project-fuse';
import { SESSION_ENDING_SELECT, sessionHasEnded } from '../projects/project-open-item';
import { PushService } from '../push/push.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { latestOwnerConfirmationRequest } from './owner-confirmation-read';
import {
  CONFIRMATION_RETURNS_BEFORE_OWNER,
  ReviewDeliveryRefused,
  confirmationReviewStates,
  readConfirmationReturnInput,
  readConfirmationReviewInput,
  readReviewRequestId,
  type ReadConfirmationReturn,
} from './owner-confirmation-review';
import {
  confirmationReturnTurnId,
  ownerAnswersMessage,
  ownerConfirmationAnswersTurnId,
  ownerConfirmationReviewTurnId,
} from './owner-confirmation-review-turn';
import { OWNER_CONFIRMATION_UNSETTLED_STATUSES, type OwnerConfirmationRefusal } from './task-owner-confirmation';

export const REVIEW_REQUIRES_SESSION_CODE = 'CONFIRMATION_REVIEW_REQUIRES_SESSION';
export const REVIEW_NOT_THE_REVIEWER_CODE = 'CONFIRMATION_REVIEW_NOT_THE_REVIEWER';
export const REVIEW_OUTSIDE_TURN_CODE = 'CONFIRMATION_REVIEW_OUTSIDE_TURN';
export const REVIEW_SUPERSEDED_CODE = 'CONFIRMATION_REVIEW_SUPERSEDED';
export const REVIEW_ALREADY_RECORDED_CODE = 'CONFIRMATION_REVIEW_ALREADY_RECORDED';
export const REVIEW_NEEDS_YOU_AFTER_DECISION_CODE = 'CONFIRMATION_REVIEW_NEEDS_YOU_AFTER_DECISION';
export const RETURN_ALREADY_SENT_BACK_CODE = 'CONFIRMATION_RETURN_ALREADY_SENT_BACK';
export const RETURN_TASK_SETTLED_CODE = 'CONFIRMATION_RETURN_TASK_SETTLED';
export const RETURN_RUN_ENDED_CODE = 'CONFIRMATION_RETURN_RUN_ENDED';
export const RETURN_LIMIT_CODE = 'CONFIRMATION_RETURN_LIMIT';
export const RETURN_COORDINATOR_DISABLED_CODE = 'COORDINATOR_DISABLED';
export const RETURN_PROJECT_FUSE_PAUSED_CODE = 'PROJECT_FUSE_PAUSED';
const RECORD_A_REVIEW_FOR_THE_OWNER = 'RECORD_A_REVIEW_FOR_THE_OWNER';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What `task_confirmation_review` answers (§3.5). */
export interface ConfirmationReviewReceipt {
  recordId: string;
  requestId: string;
  /** The review's state once the record is written (§4). */
  state: OwnerConfirmationReviewState | null;
  /** True when this session already recorded it in this turn: a retried call, which writes nothing. */
  alreadyRecorded: boolean;
}

/** What `task_confirmation_return` answers (§8): a RETURN to the run, or — after the owner confirmed — PROBLEMS. */
export interface ConfirmationReturnReceipt extends ConfirmationReviewReceipt {
  kind: 'RETURN' | 'PROBLEMS';
}

function refusal(code: string, requiredAction: string, message: string): OwnerConfirmationRefusal {
  return { code, kind: 'REFUSAL', requiredAction, message: `${message}; nothing was written.` };
}

/** One of the reviewer doors' refusals, thrown as the status its table gives it. */
function refuse(status: 400 | 403 | 409, code: string, requiredAction: string, message: string): never {
  const body = refusal(code, requiredAction, message);
  if (status === 403) throw new ForbiddenException(body);
  if (status === 400) throw new BadRequestException(body);
  throw new ConflictException(body);
}

/** Thrown out of a turn hook when the locked re-read says the call was already answered. */
class AlreadyRecorded extends Error {
  constructor(
    readonly standing: ReviewerStanding,
    readonly record: { id: string; kind: 'REVIEW' | 'RETURN' | 'PROBLEMS' },
  ) {
    super('already recorded');
  }
}

/** Thrown out of a return's turn hook when the owner confirmed while it was on its way: it is PROBLEMS now. */
class ReturnBecameProblems extends Error {}

interface ReviewerStanding {
  session: string;
  turnId: string;
  task: { status: string };
  request: {
    id: string;
    sessionId: string;
    branchSha: string | null;
    requestedAt: Date;
    decisions: Array<{ decision: 'CONFIRM' | 'SEND_BACK'; decidedAt: Date }>;
  };
  review: {
    id: string;
    reviewerKind: 'PROJECT_COORDINATOR' | 'TASK_CREATOR';
    projectId: string | null;
    records: Array<{ id: string; kind: 'REVIEW' | 'RETURN' | 'PROBLEMS'; sessionId: string; turnId: string }>;
  };
}

/**
 * A confirmation request's review, after the owner is asked or before: delivered to its reviewer
 * once (§2), answered by the reviewer with a structured record or a return to the run (§3.5, §8),
 * and — once the owner has answered its questions — told what they said (§7 Q5).
 *
 * The rules live in `owner-confirmation-review.ts` and the words in `owner-confirmation-review-turn.ts`;
 * this is where they meet the session they are written into. Nothing here confirms anything: a
 * review is a record beside the owner's card, never a decision, and the owner's door is
 * `TaskOwnerConfirmationService`'s alone (§10 G1).
 */
@Injectable()
export class OwnerConfirmationReviewService {
  private readonly logger = new Logger(OwnerConfirmationReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    @Optional() private readonly realtime?: RealtimeService,
    @Optional() private readonly push?: PushService,
  ) {}

  /**
   * D2: hand one review to its reviewer as a queued platform turn, after the transaction that wrote
   * it. Once: `delivery` leaves PENDING by a compare-and-set, to DELIVERED in the turn's own
   * transaction or to REFUSED with its code right after a refusal rolled the turn back — and a
   * refusal is final (D4). A fault that is not a refusal leaves the row PENDING for the reviewer's
   * next completion to deliver (D5).
   */
  async deliver(reviewId: string): Promise<void> {
    const review = await this.prisma.taskOwnerConfirmationReview.findUnique({
      where: { id: reviewId },
      select: {
        id: true,
        ownerId: true,
        taskId: true,
        reviewerSessionId: true,
        delivery: true,
        request: { select: { sessionId: true } },
      },
    });
    if (!review || review.delivery !== 'PENDING' || !review.reviewerSessionId) return;
    const moved = { ownerId: review.ownerId, taskId: review.taskId, runSessionId: review.request.sessionId };
    // Read before the turn, because `createTurn` refuses an ended conversation by itself and before
    // the hook below runs — which would write SESSION_UNAVAILABLE where the reason is that the
    // reviewer ended (S4). The hook asks again under the lock.
    const reviewer = await this.prisma.session.findUnique({
      where: { id: review.reviewerSessionId },
      select: SESSION_ENDING_SELECT,
    });
    if (!reviewer || sessionHasEnded(reviewer)) {
      await this.refuseDelivery(review.id, 'REVIEWER_ENDED', moved);
      return;
    }
    const clientTurnId = ownerConfirmationReviewTurnId(review.id);
    try {
      await this.sessions.createTurn(
        review.ownerId,
        review.reviewerSessionId,
        { clientTurnId, content: '', intent: 'NEXT_TURN' },
        { participateSendTransaction: (tx) => bindReviewDelivery(tx, review.id, clientTurnId) },
      );
    } catch (error) {
      // Checked first: it is a Conflict too, and its code is the one the hook found.
      const code = error instanceof ReviewDeliveryRefused
        ? error.refusalCode
        : error instanceof NotFoundException
          || error instanceof ConflictException
          || error instanceof ForbiddenException
          || error instanceof BadRequestException
          ? 'SESSION_UNAVAILABLE'
          : null;
      if (code === null) throw error;
      await this.refuseDelivery(review.id, code, moved);
      return;
    }
    // `createTurn` replays a turn already written under this key without running the hook; the only
    // writer of that key is this delivery, so the row is bound here as well. A no-op after the hook.
    await this.prisma.taskOwnerConfirmationReview.updateMany({
      where: { id: review.id, delivery: 'PENDING' },
      data: { delivery: 'DELIVERED', deliveryTurnClientId: clientTurnId, deliveredAt: new Date() },
    });
  }

  private async refuseDelivery(
    reviewId: string,
    code: string,
    moved: { ownerId: string; taskId: string; runSessionId: string },
  ): Promise<void> {
    const refused = await this.prisma.taskOwnerConfirmationReview.updateMany({
      where: { id: reviewId, delivery: 'PENDING' },
      data: { delivery: 'REFUSED', deliveryRefusal: code },
    });
    // N5: the card is the owner's from now on, and its row lights.
    if (refused.count > 0) this.publishMoved([moved]);
  }

  /**
   * D5: every review still PENDING for this reviewer, delivered — called after each completion of
   * the reviewer's own turns, which is where a delivery a crash cut off between its commit and D2 is
   * picked up again. A failure is logged and left PENDING; the window still runs out.
   */
  async deliverPendingFor(reviewerSessionId: string): Promise<void> {
    const pending = await this.prisma.taskOwnerConfirmationReview.findMany({
      where: { reviewerSessionId, delivery: 'PENDING' },
      select: { id: true },
    });
    for (const { id } of pending) {
      await this.deliver(id).catch((error) => this.logger.warn(
        `review ${id} delivery failed: ${error instanceof Error ? error.message : error}`,
      ));
    }
  }

  /** N5: a state the server itself moved — the task's views and the run's row re-read. */
  publishMoved(moved: ReadonlyArray<{ ownerId: string; taskId: string; runSessionId: string }>): void {
    for (const { ownerId, taskId, runSessionId } of moved) {
      this.realtime?.publishForUser(ownerId, RunEventType.TASK_CHANGED, { taskIds: [taskId], resync: false });
      this.realtime?.publishSessionUpdated(runSessionId);
    }
  }

  /**
   * `task_confirmation_review` (§3.5): the reviewer hands in its structured review. The table's rows
   * are asked in order and the first that fails answers, before anything is written; all of them but
   * the first are read under the task's row lock, which is also what the record is written under.
   */
  async review(
    ownerId: string,
    taskId: string,
    actingSessionId: string | null | undefined,
    raw: unknown,
  ): Promise<ConfirmationReviewReceipt> {
    const session = requireSession(actingSessionId);
    const requestId = readReviewRequestId(raw);
    const written = await withTransactionRetry(this.prisma, async (tx) => {
      const standing = await reviewerStanding(tx, ownerId, taskId, session, requestId);
      const retried = standing.review.records.find((record) => record.kind === 'REVIEW'
        && record.sessionId === session && record.turnId === standing.turnId);
      if (retried) return { recordId: retried.id, request: standing.request, alreadyRecorded: true };
      await assertNewestRequest(tx, taskId, standing.request.id);
      if (standing.review.records.some((record) => record.kind === 'REVIEW' || record.kind === 'RETURN')) {
        refuse(409, REVIEW_ALREADY_RECORDED_CODE, 'END_YOUR_TURN',
          'this request already has its reviewer\'s review or return');
      }
      const input = readConfirmationReviewInput(raw, standing.request.branchSha);
      if (standing.request.decisions.length > 0 && input.lists.needsYou.length > 0) {
        refuse(400, REVIEW_NEEDS_YOU_AFTER_DECISION_CODE, 'RETURN_IT_IF_SOMETHING_MUST_CHANGE',
          'the owner has already decided this request, so there is nobody left to answer needsYou; record '
          + 'the review without it, or use task_confirmation_return if something must change');
      }
      const recordId = await writeReviewRecord(tx, ownerId, taskId, standing, {
        kind: 'REVIEW',
        reviewedSha: input.reviewedSha,
        judgment: input.judgment,
        body: input.lists,
      });
      return { recordId, request: standing.request, alreadyRecorded: false };
    }, loggedRetry(this.logger, 'ownerConfirmationReview.review'));
    if (!written.alreadyRecorded) {
      this.publishMoved([{ ownerId, taskId, runSessionId: written.request.sessionId }]);
    }
    return {
      recordId: written.recordId,
      requestId: written.request.id,
      state: await this.stateOf(taskId, written.request),
      alreadyRecorded: written.alreadyRecorded,
    };
  }

  /**
   * `task_confirmation_return` (§8): the reviewer sends the request back to its run, which gets the
   * reason as its next message, and the owner is not asked. After the owner has confirmed, the same
   * call records PROBLEMS instead and tells the owner (§9 L2, L5).
   *
   * B8's table is read without a lock first, to know which session the turn is written into: the
   * turn's transaction has to take that session's row before anything else (rank 30), and the task's
   * row (rank 50) inside it — the shape the owner's own Send back has. Every row of the table is asked
   * again under both locks before the record is written.
   */
  async returnToRun(
    ownerId: string,
    taskId: string,
    actingSessionId: string | null | undefined,
    raw: unknown,
  ): Promise<ConfirmationReturnReceipt> {
    const session = requireSession(actingSessionId);
    const requestId = readReviewRequestId(raw);
    // At most a couple of rounds: one more only when the owner confirmed while a return was on its
    // way, which turns it into PROBLEMS.
    for (let round = 0; ; round += 1) {
      const route = await returnRoute(this.prisma, ownerId, taskId, session, requestId, raw);
      if (route.kind === 'ALREADY') return this.alreadyReturned(taskId, route.standing, route.record);
      if (route.kind === 'PROBLEMS') return this.recordProblems(ownerId, taskId, session, requestId, raw);
      try {
        return await this.recordReturn(ownerId, taskId, session, requestId, raw, route.standing.request.sessionId);
      } catch (error) {
        if (error instanceof ReturnBecameProblems && round < 2) continue;
        throw error;
      }
    }
  }

  private async alreadyReturned(
    taskId: string,
    standing: ReviewerStanding,
    record: { id: string; kind: 'REVIEW' | 'RETURN' | 'PROBLEMS' },
  ): Promise<ConfirmationReturnReceipt> {
    return {
      recordId: record.id,
      requestId: standing.request.id,
      kind: record.kind === 'PROBLEMS' ? 'PROBLEMS' : 'RETURN',
      state: await this.stateOf(taskId, standing.request),
      alreadyRecorded: true,
    };
  }

  /** B3: the RETURN record and the turn that carries it to the run, in that turn's transaction. */
  private async recordReturn(
    ownerId: string,
    taskId: string,
    session: string,
    requestId: string,
    raw: unknown,
    runSessionId: string,
  ): Promise<ConfirmationReturnReceipt> {
    const recordId = randomUUID();
    const clientTurnId = confirmationReturnTurnId(recordId);
    const held: { standing?: ReviewerStanding } = {};
    try {
      await this.sessions.createTurn(
        ownerId,
        runSessionId,
        { clientTurnId, content: '', intent: 'NEXT_TURN' },
        {
          participateSendTransaction: async (tx) => {
            const route = await returnRoute(tx, ownerId, taskId, session, requestId, raw, { lock: true });
            if (route.kind === 'ALREADY') throw new AlreadyRecorded(route.standing, route.record);
            if (route.kind === 'PROBLEMS') throw new ReturnBecameProblems();
            // The session this turn is being written into is the request's own: a request belongs to
            // one session, so the request still being the one returned is the turn still being right.
            held.standing = route.standing;
            await writeReviewRecord(tx, ownerId, taskId, route.standing, {
              id: recordId,
              kind: 'RETURN',
              reviewedSha: route.input.reviewedSha,
              reason: route.input.reason,
              body: { problems: route.input.problems },
              returnClientTurnId: clientTurnId,
            });
          },
        },
      );
    } catch (error) {
      if (error instanceof AlreadyRecorded) return this.alreadyReturned(taskId, error.standing, error.record);
      // `createTurn` refuses a run that has ended or gone to Trash before the hook asks row 11.
      if (error instanceof ConflictException && !isRefusalBody(error)) {
        refuse(409, RETURN_RUN_ENDED_CODE, RECORD_A_REVIEW_FOR_THE_OWNER,
          'the task\'s run has ended, so there is no session to send this back to; record a review for the '
          + 'owner with what must change under needsYou or notChecked instead');
      }
      throw error;
    }
    if (!held.standing) {
      // A replay of a turn already written under this key — impossible for a key minted above.
      throw new Error(`return ${recordId} filed a turn without recording it`);
    }
    this.publishMoved([{ ownerId, taskId, runSessionId }]);
    return {
      recordId,
      requestId: held.standing.request.id,
      kind: 'RETURN',
      state: await this.stateOf(taskId, held.standing.request),
      alreadyRecorded: false,
    };
  }

  /** §9 L2: the owner confirmed first, so what the reviewer found goes on the receipt, not to the run. */
  private async recordProblems(
    ownerId: string,
    taskId: string,
    session: string,
    requestId: string,
    raw: unknown,
  ): Promise<ConfirmationReturnReceipt> {
    const written = await withTransactionRetry(this.prisma, async (tx) => {
      const route = await returnRoute(tx, ownerId, taskId, session, requestId, raw, { lock: true });
      if (route.kind === 'ALREADY') {
        return { recordId: route.record.id, kind: route.record.kind, standing: route.standing, alreadyRecorded: true };
      }
      if (route.kind === 'RETURN') {
        // The owner's decision went away under us — nothing deletes one, so this is a fault.
        throw new Error(`request ${requestId} lost the owner's confirmation while its problems were recorded`);
      }
      const recordId = await writeReviewRecord(tx, ownerId, taskId, route.standing, {
        kind: 'PROBLEMS',
        reviewedSha: route.input.reviewedSha,
        reason: route.input.reason,
        body: { problems: route.input.problems },
      });
      return { recordId, kind: 'PROBLEMS' as const, standing: route.standing, alreadyRecorded: false };
    }, loggedRetry(this.logger, 'ownerConfirmationReview.problems'));
    if (!written.alreadyRecorded) {
      this.publishMoved([{ ownerId, taskId, runSessionId: written.standing.request.sessionId }]);
      // L5: once per record, and only about a task that is DONE — a settled task asks nobody anything,
      // so this is the one way the owner learns what was found.
      const task = await this.prisma.task.findUnique({ where: { id: taskId }, select: { status: true } });
      if (task?.status === TaskStatus.DONE) await this.push?.notifyConfirmationProblems(written.recordId);
    }
    return {
      recordId: written.recordId,
      requestId: written.standing.request.id,
      kind: written.kind === 'PROBLEMS' ? 'PROBLEMS' : 'RETURN',
      state: await this.stateOf(taskId, written.standing.request),
      alreadyRecorded: written.alreadyRecorded,
    };
  }

  /**
   * Q5 2: tell the reviewer what the owner answered, after the decision committed. Only a reviewer
   * that has not ended: it is not revived for this (ILC G6), and a crash between the commit and here
   * loses only the reminder — the answers are on the decision row and the task's comment.
   */
  async deliverAnswers(decisionId: string): Promise<void> {
    const decision = await this.prisma.taskOwnerDecision.findUnique({
      where: { id: decisionId },
      select: {
        ownerId: true,
        taskId: true,
        decidedAt: true,
        answers: true,
        task: { select: { title: true } },
        reviewRecord: { select: { body: true, review: { select: { reviewerSessionId: true } } } },
      },
    });
    const answers = (decision?.answers ?? null) as OwnerConfirmationAnswer[] | null;
    const reviewerSessionId = decision?.reviewRecord?.review.reviewerSessionId;
    if (!decision || !answers?.length || !reviewerSessionId) return;
    const reviewer = await this.prisma.session.findUnique({
      where: { id: reviewerSessionId },
      select: SESSION_ENDING_SELECT,
    });
    if (!reviewer || sessionHasEnded(reviewer)) return;
    const lists = decision.reviewRecord!.body as unknown as Partial<ConfirmationReviewLists>;
    const content = ownerAnswersMessage({
      taskId: decision.taskId,
      title: decision.task.title,
      decidedAt: decision.decidedAt,
      answers,
      needsYou: (lists.needsYou ?? []) as ConfirmationNeedsYouItem[],
    });
    try {
      await this.sessions.createTurn(decision.ownerId, reviewerSessionId, {
        clientTurnId: ownerConfirmationAnswersTurnId(decisionId),
        content,
        intent: 'NEXT_TURN',
      });
    } catch (error) {
      this.logger.warn(`answers of decision ${decisionId} were not delivered to its reviewer: `
        + `${error instanceof Error ? error.message : error}`);
    }
  }

  private async stateOf(
    taskId: string,
    request: { id: string; sessionId: string; requestedAt: Date },
  ): Promise<OwnerConfirmationReviewState | null> {
    const views = await confirmationReviewStates(
      this.prisma,
      [{ id: request.id, taskId, sessionId: request.sessionId, requestedAt: request.requestedAt }],
      new Date(),
    );
    return views.get(request.id)?.state ?? null;
  }
}

/**
 * D2's hook: run inside the turn's transaction, under the reviewer's Session lock `createTurn` already
 * holds. Each of the six conditions is asked of the rows as they are now; the first that fails throws
 * its code and the turn is not written. When all hold, the review is bound to the turn.
 */
async function bindReviewDelivery(
  tx: Prisma.TransactionClient,
  reviewId: string,
  clientTurnId: string,
): Promise<void> {
  const review = await tx.taskOwnerConfirmationReview.findUnique({
    where: { id: reviewId },
    select: {
      delivery: true,
      taskId: true,
      requestId: true,
      reviewerKind: true,
      reviewerSessionId: true,
      projectId: true,
      request: { select: { decisions: { select: { decision: true } } } },
    },
  });
  if (!review || review.delivery !== 'PENDING' || !review.reviewerSessionId) {
    throw new ReviewDeliveryRefused('SESSION_UNAVAILABLE', 'the review is no longer waiting to be delivered');
  }
  const reviewer = await tx.session.findUnique({
    where: { id: review.reviewerSessionId },
    select: { ...SESSION_ENDING_SELECT, taskId: true },
  });
  if (!reviewer || sessionHasEnded(reviewer)) {
    throw new ReviewDeliveryRefused('REVIEWER_ENDED', 'the reviewer\'s session has ended');
  }
  // S3, as `decidingSessionDisqualification`'s first rule: the session that did the work does not
  // review it.
  if (reviewer.taskId === review.taskId) {
    throw new ReviewDeliveryRefused('REVIEWER_IS_THE_RUN', 'the reviewer is a run of the task it would review');
  }
  const latest = await latestOwnerConfirmationRequest(tx, review.taskId);
  if (latest?.id !== review.requestId) {
    throw new ReviewDeliveryRefused('SUPERSEDED', 'a later run of the task has reported since');
  }
  if (review.request.decisions.some((decision) => decision.decision === 'SEND_BACK')) {
    throw new ReviewDeliveryRefused('SENT_BACK', 'the owner already sent this report back to its run');
  }
  if (review.reviewerKind === 'PROJECT_COORDINATOR' && review.projectId) {
    const project = await tx.project.findUnique({
      where: { id: review.projectId },
      select: { coordinatorEnabled: true },
    });
    if (!project?.coordinatorEnabled) {
      throw new ReviewDeliveryRefused('AUTOMATIC_OFF', 'Automatic was switched off for the project');
    }
    if ((await openFuseEpisodeId(tx, review.projectId)) !== null) {
      throw new ReviewDeliveryRefused('COORDINATOR_PAUSED', 'the project\'s coordinator is paused');
    }
  }
  await tx.taskOwnerConfirmationReview.updateMany({
    where: { id: reviewId, delivery: 'PENDING' },
    data: { delivery: 'DELIVERED', deliveryTurnClientId: clientTurnId, deliveredAt: new Date() },
  });
}

/** §3.5 row 1: the reviewer is a session, and the header is how it says which. */
function requireSession(actingSessionId: string | null | undefined): string {
  const session = actingSessionId?.trim() ? actingSessionId.trim() : null;
  if (!session) {
    refuse(403, REVIEW_REQUIRES_SESSION_CODE, 'CALL_FROM_THE_REVIEWER_SESSION',
      'a review is recorded by the session the request was handed to, and this call came from no session');
  }
  return session;
}

/**
 * One record, written by the reviewing session in the turn it is in, under the task's row lock its
 * caller already holds (§3.5, B3, L2). `recorded_at` is read from the database clock after that lock,
 * as 0267's `decided_at` is: records and decisions about one task are ordered by it, and B5 counts
 * returns against the newest decision by it.
 */
async function writeReviewRecord(
  tx: Prisma.TransactionClient,
  ownerId: string,
  taskId: string,
  standing: ReviewerStanding,
  record: {
    id?: string;
    kind: 'REVIEW' | 'RETURN' | 'PROBLEMS';
    reviewedSha: string | null;
    judgment?: string;
    reason?: string;
    body: unknown;
    returnClientTurnId?: string;
  },
): Promise<string> {
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
  const written = await tx.taskOwnerConfirmationReviewRecord.create({
    data: {
      ...(record.id ? { id: record.id } : {}),
      reviewId: standing.review.id,
      requestId: standing.request.id,
      taskId,
      ownerId,
      kind: record.kind,
      reviewedSha: record.reviewedSha,
      judgment: record.judgment ?? null,
      reason: record.reason ?? null,
      body: record.body as Prisma.InputJsonValue,
      sessionId: standing.session,
      turnId: standing.turnId,
      returnClientTurnId: record.returnClientTurnId ?? null,
      recordedAt: clock.now,
    },
    select: { id: true },
  });
  return written.id;
}

function isRefusalBody(error: ConflictException): boolean {
  const body = error.getResponse();
  return typeof body === 'object' && body !== null && (body as { kind?: unknown }).kind === 'REFUSAL';
}

/**
 * §3.5 rows 2–3 (and B8's, which are the same): the request is this account's, it has a review row,
 * the caller is its reviewer, and the caller is in a turn. With `lock`, the task's row is taken FOR
 * UPDATE first — the lock every record of this task is written under.
 */
async function reviewerStanding(
  tx: Prisma.TransactionClient,
  ownerId: string,
  taskId: string,
  session: string,
  requestId: string,
  opts: { lock?: boolean } = { lock: true },
): Promise<ReviewerStanding> {
  const notTheReviewer: (why: string) => never = (why) => refuse(403, REVIEW_NOT_THE_REVIEWER_CODE,
    'LEAVE_IT_TO_ITS_REVIEWER', why);
  const [task] = opts.lock === false
    ? await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`
        SELECT "status"::text AS "status" FROM "task"
         WHERE "id" = ${taskId}::uuid AND "owner_id" = ${ownerId}::uuid`)
    : await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`
        SELECT "status"::text AS "status" FROM "task"
         WHERE "id" = ${taskId}::uuid AND "owner_id" = ${ownerId}::uuid
         FOR UPDATE`);
  if (!task) notTheReviewer('this account has no such task, so there is no request of it to review');
  const request = await tx.taskOwnerConfirmationRequest.findFirst({
    where: { id: requestId, taskId, ownerId },
    select: {
      id: true,
      sessionId: true,
      branchSha: true,
      requestedAt: true,
      decisions: { select: { decision: true, decidedAt: true } },
      reviews: {
        select: {
          id: true,
          reviewerKind: true,
          reviewerSessionId: true,
          projectId: true,
          records: { select: { id: true, kind: true, sessionId: true, turnId: true } },
        },
      },
    },
  });
  if (!request) notTheReviewer('this task has no confirmation request with that id');
  const [review] = request.reviews;
  if (!review) {
    notTheReviewer('this task has no reviewer: the owner reviews it on the card themselves');
  }
  if (!UUID_RE.test(session) || review.reviewerSessionId !== session) {
    notTheReviewer('only the session this request was handed to for review may record its review or return it');
  }
  const turn = await tx.conversationTurn.findFirst({
    where: { sessionId: session, status: 'IN_FLIGHT' },
    orderBy: { seq: 'desc' },
    select: { id: true },
  });
  if (!turn) {
    refuse(409, REVIEW_OUTSIDE_TURN_CODE, 'CALL_FROM_INSIDE_A_TURN',
      'the reviewer session is between turns; record the review from the turn that read the request');
  }
  return {
    session,
    turnId: turn.id,
    task,
    request: {
      id: request.id,
      sessionId: request.sessionId,
      branchSha: request.branchSha,
      requestedAt: request.requestedAt,
      decisions: request.decisions,
    },
    review: { id: review.id, reviewerKind: review.reviewerKind, projectId: review.projectId, records: review.records },
  };
}

/** §3.5 row 5 / B8 row 5: a request a later report replaced is not anybody's question any more. */
async function assertNewestRequest(tx: Prisma.TransactionClient, taskId: string, requestId: string): Promise<void> {
  const latest = await latestOwnerConfirmationRequest(tx, taskId);
  if (latest && latest.id !== requestId) {
    const body = {
      ...refusal(REVIEW_SUPERSEDED_CODE, 'REVIEW_THE_NEWEST_REQUEST',
        'a later run of this task has reported since this request was made, so the owner is asked about '
        + 'that one'),
      latestRequestId: latest.id,
    };
    throw new ConflictException(body);
  }
}

type ReturnRoute =
  | { kind: 'ALREADY'; standing: ReviewerStanding; record: { id: string; kind: 'REVIEW' | 'RETURN' | 'PROBLEMS' } }
  | { kind: 'PROBLEMS' | 'RETURN'; standing: ReviewerStanding; input: ReadConfirmationReturn };

/**
 * B8, top to bottom: which way a `task_confirmation_return` goes — a retry of one already recorded,
 * PROBLEMS on a request the owner confirmed, or a RETURN to the run — or the refusal that stops it.
 */
async function returnRoute(
  tx: Prisma.TransactionClient,
  ownerId: string,
  taskId: string,
  session: string,
  requestId: string,
  raw: unknown,
  opts: { lock?: boolean } = { lock: false },
): Promise<ReturnRoute> {
  const standing = await reviewerStanding(tx, ownerId, taskId, session, requestId, { lock: opts.lock === true });
  const retried = standing.review.records.find((record) => (record.kind === 'RETURN' || record.kind === 'PROBLEMS')
    && record.sessionId === session && record.turnId === standing.turnId);
  if (retried) return { kind: 'ALREADY', standing, record: retried };
  await assertNewestRequest(tx, taskId, standing.request.id);
  if (standing.review.records.some((record) => record.kind === 'RETURN' || record.kind === 'PROBLEMS')) {
    refuse(409, REVIEW_ALREADY_RECORDED_CODE, 'END_YOUR_TURN', 'this request has already been returned once');
  }
  const input = readConfirmationReturnInput(raw, standing.request.branchSha);
  const decided = standing.request.decisions[0];
  if (decided?.decision === 'CONFIRM') return { kind: 'PROBLEMS', standing, input };
  if (decided?.decision === 'SEND_BACK') {
    refuse(409, RETURN_ALREADY_SENT_BACK_CODE, 'USE_SESSION_SEND_TO_ADD_TO_IT',
      'the owner has already sent this report back to the run; to add to what they said, message the run '
      + 'with session_send');
  }
  if (!(OWNER_CONFIRMATION_UNSETTLED_STATUSES as readonly string[]).includes(standing.task.status)) {
    refuse(409, RETURN_TASK_SETTLED_CODE, 'REOPEN_THE_TASK_FIRST',
      `the task is ${standing.task.status}, so there is no open request to send back`);
  }
  const run = await tx.session.findUnique({ where: { id: standing.request.sessionId }, select: SESSION_ENDING_SELECT });
  if (!run || sessionHasEnded(run)) {
    refuse(409, RETURN_RUN_ENDED_CODE, RECORD_A_REVIEW_FOR_THE_OWNER,
      'the task\'s run has ended, so there is no session to send this back to; record a review for the owner '
      + 'with what must change under needsYou or notChecked instead');
  }
  const lastDecision = await tx.taskOwnerDecision.findFirst({
    where: { taskId },
    orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
    select: { decidedAt: true },
  });
  const returns = await tx.taskOwnerConfirmationReviewRecord.count({
    where: {
      taskId,
      kind: 'RETURN',
      ...(lastDecision ? { recordedAt: { gt: lastDecision.decidedAt } } : {}),
    },
  });
  if (returns >= CONFIRMATION_RETURNS_BEFORE_OWNER) {
    refuse(409, RETURN_LIMIT_CODE, RECORD_A_REVIEW_FOR_THE_OWNER,
      `this task has been returned ${returns} times since its owner last decided it; record a review instead `
      + 'and put what is left under needsYou or notChecked, so the owner decides');
  }
  if (standing.review.reviewerKind === 'PROJECT_COORDINATOR' && standing.review.projectId) {
    const project = await tx.project.findUnique({
      where: { id: standing.review.projectId },
      select: { coordinatorEnabled: true },
    });
    if (!project?.coordinatorEnabled) {
      refuse(409, RETURN_COORDINATOR_DISABLED_CODE, RECORD_A_REVIEW_FOR_THE_OWNER,
        'Automatic is off for this project, so its coordinator does not send work back; record a review for '
        + 'the owner instead');
    }
    if ((await openFuseEpisodeId(tx, standing.review.projectId)) !== null) {
      refuse(409, RETURN_PROJECT_FUSE_PAUSED_CODE, RECORD_A_REVIEW_FOR_THE_OWNER,
        'this project\'s coordinator is paused, so what it starts is held; the card goes to the owner instead');
    }
  }
  return { kind: 'RETURN', standing, input };
}
