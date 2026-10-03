import {
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CreatorType, Prisma, type SessionRequest } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { uuidToBase62, type SessionRequestView } from '@orbit/shared';

import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { derivedUuid } from '../projects/project-dispatch-identity';
import { RealtimeService } from '../realtime/realtime.service';
import { sessionHasEnded } from '../runner-api/background-job-wake';
import {
  attachReplyToTurn,
  awaitsAutoRetry,
  holdReply,
  readSessionRequestView,
  replyToSessionRequest,
  requestClosedRefusal,
  SESSION_REPLY_TURN_PREFIX,
  sessionReplyBlock,
  SessionReplyHandedOff,
  type SessionReplyInput,
  type SessionRequestReceipt,
  sessionRequestReceipt,
  undeliveredReplyTurn,
} from './session-request';
import { SessionNotSendable, SessionsService } from './sessions.service';

/**
 * Where a request's outcome went (contract §4.2, §4.3): onto a new reply turn of the asker (QUEUED),
 * onto one already queued (MERGED), kept on the row because the asker had ended or is waiting on its
 * auto-retry (HELD) — or somewhere another pass had already put it (ALREADY). DEFERRED: nowhere yet,
 * because the hand-off failed; the outcome is safe on its row and the request worker hands it back on
 * its next pass.
 */
export type SessionReplyHandOff = 'QUEUED' | 'MERGED' | 'HELD' | 'ALREADY' | 'DEFERRED';

/**
 * What `tellStoppedAsker` did with an outcome it was told to say (§8 criterion 21): `COMMENTED` on the
 * task the asker ran and never will read (§4.3), `HANDED_BACK` to an asker that is merely idle (§4.2),
 * `WAITED` because it has been armed again — the retry's turn says it — and `ALREADY` when another
 * pass got there first.
 */
export type StoppedAskerTold = 'COMMENTED' | 'HANDED_BACK' | 'WAITED' | 'ALREADY';

/** The id of the one comment that tells an ended asker's task what its request came to (§4.3). */
export function sessionReplyCommentId(requestId: string): string {
  return derivedUuid(`session-request:v1:reply-comment:${requestId}`);
}

/** An auto-retry was armed on the asker after the hand-off last looked: the look is taken again. */
class AskerAwaitsRetry extends Error {}

/**
 * The verbs of a session request that act on more than one session: `session_reply`, and handing an
 * outcome back to the session that asked (sessions/session-request.ts for the rows themselves).
 *
 * Handing back writes the ASKER's conversation, so it always runs on its own, after whatever wrote
 * the outcome has committed: the outcome is written under the recipient's lock, the hand-off takes the
 * asker's, and one transaction holding one while it waits for the other is how two sessions asking each
 * other would deadlock. Between the two the outcome is safe on its row, and the request worker hands
 * off whatever a crash left in between (session-request.worker.ts).
 */
@Injectable()
export class SessionRequestService {
  private readonly log = new Logger('SessionRequests');

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * `session_reply` (§3.2): the recipient answers, and the answer goes back. Only the session the
   * request was sent to may answer it; a request that already has an outcome is refused with that
   * outcome (409 REQUEST_CLOSED), and the recipient can still add a word with an ordinary message.
   */
  async reply(
    ownerId: string,
    callerSessionId: string,
    requestId: string,
    input: SessionReplyInput,
  ): Promise<{ requestId: string; state: 'REPLIED'; handOff: SessionReplyHandOff }> {
    // One compare-and-set on the request row, so no transaction: an answer and a NO_REPLY judgment
    // racing each other meet on that row's lock, and the second finds it no longer OPEN.
    const answered = await replyToSessionRequest(this.prisma, { ownerId, callerSessionId, requestId, reply: input });
    if (!answered.ok) {
      if (answered.kind === 'NOT_FOUND') throw new NotFoundException('session request not found');
      if (answered.kind === 'NOT_RECIPIENT') {
        throw new ForbiddenException('only the session this request was sent to can reply to it');
      }
      throw requestClosedRefusal(answered.request);
    }
    // REPLIED has committed, so the answer is given: what is left is the platform's to deliver, not
    // the recipient's to retry. A hand-off that fails now is not the caller's failure — reported as
    // one, a retry would only meet REQUEST_CLOSED — so it is left to the request worker, which hands
    // back every outcome on no turn and not held (session-request.worker.ts).
    const [handOff] = await this.handOffQuietly([answered.request.id]);
    return { requestId: uuidToBase62(answered.request.id), state: 'REPLIED', handOff };
  }

  /**
   * What a send that may have carried a request answers beside its placement (§3.1): `requestId` and
   * `replyBy` when it did. Read after the write by the key the turn went under, so a retry that
   * replayed a committed turn answers the request it carries; a key first used for a plain message
   * cannot turn into a request on a retry, nor the other way round. Announces the request to both
   * sessions' rows, since the asker is now waiting on the recipient.
   */
  async receipt(
    toSessionId: string,
    clientTurnId: string,
    asked: boolean,
    fromSessionId: string,
  ): Promise<SessionRequestReceipt | null> {
    const receipt = await sessionRequestReceipt(this.prisma, toSessionId, clientTurnId, asked);
    if (receipt) {
      this.realtime.publishSessionUpdated(fromSessionId);
      this.realtime.publishSessionUpdated(toSessionId);
    }
    return receipt;
  }

  /** A request as the clients read it. */
  async view(ownerId: string, requestId: string): Promise<SessionRequestView> {
    const view = await readSessionRequestView(this.prisma, ownerId, requestId);
    if (!view) throw new NotFoundException('session request not found');
    return view;
  }

  /**
   * Hand one request's outcome back to the session that asked (§4.2, §4.3).
   *
   * As a turn of the asker's conversation — NEXT_TURN, with no words of its own, the outcome kept on
   * its row and written in at delivery — through `createTurn`, exactly as a background job's wake is
   * filed: onto the asker's reply turn nobody has been handed yet if there is one, so outcomes that
   * arrive together wake it once, else as a new `session-reply:` turn. Each hand-off attempt takes a
   * key of its own: what makes the outcome go back once is the compare-and-set inside the turn's
   * transaction (`attachReplyToTurn`), not the key, so a key a dropped reply turn once used can never
   * answer for a hand-off it did not carry.
   *
   * An asker that has ended — its run over, being cancelled, completed or in Trash — is not revived to
   * be told (§4.3). The outcome is held on the row, written into the next turn the asker is handed if
   * it ever is, and said on the task it ran, in a comment keyed by the request so saying it again
   * writes nothing.
   *
   * An asker a transient failure stopped with an auto-retry armed has not ended (§8 criterion 17,
   * `awaitsAutoRetry`), and is not handed a reply turn either: a new turn disarms the retry, and the
   * message the failure killed would never be re-sent. The outcome is held for the retry's turn, with
   * nothing said on the task (`holdForRetry`); if the retry is given up instead, migration 0352 marks
   * it and the request worker says it there (`commentForStoppedAsker`).
   *
   * Publishes both sessions' rows when it moved anything: the asker stops waiting, the recipient stops
   * owing, and both clients' request cards read the state again.
   */
  async handOff(requestId: string): Promise<SessionReplyHandOff> {
    // Twice at most: once more when a retry was armed between the look and the turn (below).
    for (let attempt = 0; ; attempt++) {
      const handedOff = await this.handOffOnce(requestId, attempt === 0);
      if (handedOff !== 'RETRY_ARMED') return handedOff;
    }
  }

  private async handOffOnce(
    requestId: string,
    mayLookAgain: boolean,
  ): Promise<SessionReplyHandOff | 'RETRY_ARMED'> {
    const request = await this.prisma.sessionRequest.findUnique({ where: { id: requestId } });
    if (!request || request.state === 'OPEN' || request.replyClientTurnId || request.replyHeldAt) return 'ALREADY';
    const parked = await this.holdForRetry(request);
    if (parked) return parked;
    const clientTurnId = `${SESSION_REPLY_TURN_PREFIX}${request.id}:${randomUUID().slice(0, 8)}`;
    let merged = false;
    try {
      await this.sessions.createTurn(
        request.ownerId,
        request.fromSessionId,
        { clientTurnId, content: '', intent: 'NEXT_TURN' },
        {
          coalesce: async (tx, asker) => {
            if (sessionHasEnded(asker) || asker.cancelRequestedAt) {
              throw new SessionNotSendable('the session has ended');
            }
            // A retry armed since the look above — a quota that ran out a moment ago. The look is
            // taken again, under the lock it needs.
            if (mayLookAgain && awaitsAutoRetry(asker)) throw new AskerAwaitsRetry();
            const queued = await undeliveredReplyTurn(tx, request.fromSessionId);
            merged = queued !== null;
            await attachReplyToTurn(tx, request.id, queued?.clientTurnId ?? clientTurnId);
            return queued;
          },
        },
      );
    } catch (error) {
      if (error instanceof SessionReplyHandedOff) return 'ALREADY';
      if (error instanceof AskerAwaitsRetry) return 'RETRY_ARMED';
      // The asker cannot be written to: it ended, went to Trash or is being cancelled (Conflict), it
      // is gone (Not Found), or its conversation refuses a new turn for any other reason of state
      // (Forbidden, Bad Request) — the set `criteria-decision-reply.ts` treats as "not a turn, then".
      // Anything else is a fault: rethrown, and the worker tries again on its next pass.
      if (!(error instanceof HttpException) || error.getStatus() >= 500) throw error;
      await this.commentIfAskerEnded(request);
      if (!(await holdReply(this.prisma, request.id))) return 'ALREADY';
      this.publish(request);
      return 'HELD';
    }
    this.publish(request);
    return merged ? 'MERGED' : 'QUEUED';
  }

  /**
   * `handOff` for each of these, for a caller with nothing to do about a failure but log it: one that
   * fails is DEFERRED to the request worker. Answers where each went, in order.
   */
  async handOffQuietly(requestIds: readonly string[]): Promise<SessionReplyHandOff[]> {
    const handedOff: SessionReplyHandOff[] = [];
    for (const requestId of requestIds) {
      try {
        handedOff.push(await this.handOff(requestId));
      } catch (error) {
        this.log.warn(
          `session request ${requestId} was not handed back yet: ${error instanceof Error ? error.message : error}; `
          + 'the request worker tries again',
        );
        handedOff.push('DEFERRED');
      }
    }
    return handedOff;
  }

  /**
   * §8 criterion 17: an asker a transient failure stopped, with its auto-retry armed, keeps the outcome
   * for the retry's turn — held, and its task told nothing. Null when the asker is not waiting on one.
   *
   * Decided under the asker's row lock, FOR SHARE, which an UPDATE of that row waits for: a retry given
   * up at the same moment either committed first — seen here, so the outcome goes the way any other
   * does — or commits after this hold, and migration 0352's trigger finds the outcome held and marks it
   * for the request worker. Either way, an outcome held for a retry that never comes is said on the task.
   */
  private async holdForRetry(request: SessionRequest): Promise<'HELD' | 'ALREADY' | null> {
    const held = await withTransactionRetry(this.prisma, async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT 1 FROM "session"
         WHERE "id" = ${request.fromSessionId}::uuid AND "owner_id" = ${request.ownerId}::uuid
         FOR SHARE
      `);
      const asker = await tx.session.findFirst({
        where: { id: request.fromSessionId, ownerId: request.ownerId },
        select: {
          status: true, retryAt: true, retryClaimedAt: true, cancelRequestedAt: true,
          completedAt: true, archivedAt: true, deletedAt: true,
        },
      });
      if (!asker || !awaitsAutoRetry(asker)) return null;
      return holdReply(tx, request.id);
    }, loggedRetry(this.log, 'sessionRequests.holdForRetry'));
    if (held === null) return null;
    if (!held) return 'ALREADY';
    this.publish(request);
    return 'HELD';
  }

  /**
   * The request worker's, for an outcome migration 0352 marked: held for an asker that has since
   * stopped — the retry it waited on was given up, or it ended. Which of the two it was is read off the
   * asker NOW, not off the statement that marked it (§8 criterion 21), because the same "stopped"
   * covers two states with different endings:
   *
   *   - it has ENDED — a FAILED run with no retry, cancelled, completed, in Trash: §4.3. No turn is
   *     coming, so the outcome goes on the task the asker ran as a comment, keyed by the request so a
   *     pass that does it twice writes it once;
   *   - it is merely IDLE — parked and live: §4.2. It can take a turn, so the outcome goes back to it
   *     as a reply turn like any other, and about a task it never ran as readily as about one it did.
   *     The hold was for the retry's turn; with the retry gone it is released first, so the ordinary
   *     hand-off says it (`handOff`, which queues or merges the reply turn).
   *
   * An asker that has been armed again in the meantime waits: the retry's turn says the outcome. Its
   * mark is answered all the same (`waitForRetry`) — the retry given up again marks it again — so that
   * it stops holding a place at the head of every pass's batch.
   */
  async tellStoppedAsker(requestId: string): Promise<StoppedAskerTold> {
    const request = await this.prisma.sessionRequest.findUnique({ where: { id: requestId } });
    if (!request?.replyCommentDueAt || request.replyClientTurnId || !request.replyHeldAt) return 'ALREADY';
    const asker = await this.prisma.session.findFirst({
      where: { id: request.fromSessionId, ownerId: request.ownerId },
      select: {
        title: true, taskId: true, status: true, endReason: true, cancelRequestedAt: true, retryAt: true,
        retryClaimedAt: true, completedAt: true, archivedAt: true, deletedAt: true,
      },
    });
    // The asker's row is gone: nothing left to tell, and the mark is cleared so a request that
    // outlived its asker is not re-read by every pass for ever (the FK is the recipient's, 0350).
    if (!asker) {
      await this.clearMark(request);
      return 'ALREADY';
    }
    // Looked at again under the asker's lock before the mark goes: an asker that stopped waiting in
    // between keeps its mark, and the next pass reads where it stands then.
    if (awaitsAutoRetry(asker)) return (await this.waitForRetry(request)) ? 'WAITED' : 'ALREADY';
    if (!sessionHasEnded(asker) && !asker.cancelRequestedAt) {
      if (!(await this.releaseHeld(request.id))) return 'ALREADY';
      await this.handOff(request.id);
      return 'HANDED_BACK';
    }
    if (asker.taskId) await this.commentOnAskerTask(request, { title: asker.title, taskId: asker.taskId }, 'STOPPED');
    return (await this.clearMark(request)) ? 'COMMENTED' : 'ALREADY';
  }

  /**
   * Answer the mark of an outcome whose asker is waiting on a retry again — re-armed, or its retry
   * claimed — so the retry's turn will say it. Left standing, the mark kept its place at the head of
   * the worker's batch (oldest first) for as long as the asker waited, and twenty-five of them were a
   * batch that told nobody anything. Nothing is lost by answering it: an outcome held with no mark is
   * marked again by the statement that gives the retry up (0352's trigger, 0366's for a claim taken
   * back, `AutoRetryService.releaseExpiredClaims` for one that ran out).
   *
   * Under the asker's row FOR SHARE, as `holdForRetry` decides, and for the same reason: an UPDATE that
   * gives the retry up waits for this lock, so its trigger runs after the mark is gone and marks the
   * outcome again — never before it, where this clear would erase that mark. Answers whether the asker
   * was still waiting, and so whether the mark was this pass's to answer.
   */
  private async waitForRetry(request: SessionRequest): Promise<boolean> {
    return withTransactionRetry(this.prisma, async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT 1 FROM "session"
         WHERE "id" = ${request.fromSessionId}::uuid AND "owner_id" = ${request.ownerId}::uuid
         FOR SHARE
      `);
      const asker = await tx.session.findFirst({
        where: { id: request.fromSessionId, ownerId: request.ownerId },
        select: {
          status: true, retryAt: true, retryClaimedAt: true, cancelRequestedAt: true,
          completedAt: true, archivedAt: true, deletedAt: true,
        },
      });
      if (!asker || !awaitsAutoRetry(asker)) return false;
      await tx.sessionRequest.updateMany({
        where: { id: request.id, replyCommentDueAt: request.replyCommentDueAt, replyClientTurnId: null },
        data: { replyCommentDueAt: null },
      });
      return true;
    }, loggedRetry(this.log, 'sessionRequests.waitForRetry'));
  }

  /** Answer migration 0352's mark, by a compare-and-set on the mark as it was read. */
  private async clearMark(request: SessionRequest): Promise<boolean> {
    const { count } = await this.prisma.sessionRequest.updateMany({
      where: { id: request.id, replyCommentDueAt: request.replyCommentDueAt, replyClientTurnId: null },
      data: { replyCommentDueAt: null },
    });
    return count === 1;
  }

  /**
   * §4.2, §8 criterion 21: let go of an outcome held for an asker that turned out to be merely idle —
   * its retry given up while it stayed parked and live. A compare-and-set on the row still being held
   * and on no turn, so a pass racing another releases it once; the mark goes with the hold, because
   * what it stood for ("no next turn is coming") is exactly what this just decided is not true.
   */
  private async releaseHeld(requestId: string): Promise<boolean> {
    const { count } = await this.prisma.sessionRequest.updateMany({
      where: { id: requestId, state: { not: 'OPEN' }, replyClientTurnId: null, replyHeldAt: { not: null } },
      data: { replyHeldAt: null, replyCommentDueAt: null },
    });
    return count === 1;
  }

  /**
   * §4.3: the asker ended before its request came to anything, so the outcome is said where whoever
   * runs its task next will read it. Written before the hold that marks the hand-off done, and keyed by
   * the request, so a hand-off cut off between the two writes it again as nothing. An asker that ran no
   * task, or is gone, has nowhere to be told — and one that has NOT ended, whose conversation refused
   * the turn for some other reason of its state, reads the outcome on its next turn instead. So does one
   * waiting on its auto-retry (§8 criterion 17): it has not ended either.
   */
  private async commentIfAskerEnded(request: SessionRequest): Promise<void> {
    const asker = await this.prisma.session.findFirst({
      where: { id: request.fromSessionId, ownerId: request.ownerId },
      select: {
        title: true, taskId: true, status: true, endReason: true, cancelRequestedAt: true, retryAt: true,
        retryClaimedAt: true, completedAt: true, archivedAt: true, deletedAt: true,
      },
    });
    if (!asker?.taskId) return;
    if (!sessionHasEnded(asker) && !asker.cancelRequestedAt) return;
    if (awaitsAutoRetry(asker)) return;
    await this.commentOnAskerTask(request, { title: asker.title, taskId: asker.taskId }, 'ENDED');
  }

  /** §4.3's comment itself, on the task the asker ran, keyed by the request. */
  private async commentOnAskerTask(
    request: SessionRequest,
    asker: { title: string; taskId: string },
    why: 'ENDED' | 'STOPPED',
  ): Promise<void> {
    const task = await this.prisma.task.findFirst({
      where: { id: asker.taskId, ownerId: request.ownerId },
      select: { id: true, assigneeId: true, creatorType: true, creatorId: true },
    });
    if (!task) return;
    const recipient = await this.prisma.session.findFirst({
      where: { id: request.toSessionId, ownerId: request.ownerId },
      select: { id: true, title: true },
    });
    const body = [
      why === 'ENDED'
        ? `会话「${asker.title}」发出的会话间请求有了结局，但它在那之前已经结束；平台不会为了送回信去复活一段已经结束的对话，所以把结局记在这里。`
        : `会话「${asker.title}」发出的会话间请求有了结局，回信原本留到它的下一轮补上；但它已经停下，不会再有下一轮（它等着的自动重试被放弃了，或会话已经结束）。平台不会为了送回信去复活一段对话，所以把结局记在这里。`,
      '',
      sessionReplyBlock(request, recipient),
    ].join('\n');
    await this.prisma.taskComment.createMany({
      data: [{
        id: sessionReplyCommentId(request.id),
        taskId: task.id,
        // Attributed the way every comment Orbit writes on a task is (`postRunFailureComment`): to the
        // agent the task is assigned to, else to whoever filed it. The words say it is Orbit's.
        authorType: task.assigneeId ? CreatorType.AGENT : task.creatorType,
        authorId: task.assigneeId ?? task.creatorId,
        body,
      }],
      skipDuplicates: true,
    });
  }

  /** Both ends of a request whose outcome moved: the list rows and the cards read it again. */
  private publish(request: Pick<SessionRequest, 'fromSessionId' | 'toSessionId'>): void {
    this.realtime.publishSessionUpdated(request.fromSessionId);
    this.realtime.publishSessionUpdated(request.toSessionId);
  }
}
