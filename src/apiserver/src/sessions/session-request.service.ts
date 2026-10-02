import {
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CreatorType, type SessionRequest } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { uuidToBase62, type SessionRequestView } from '@orbit/shared';

import { PrismaService } from '../prisma/prisma.service';
import { derivedUuid } from '../projects/project-dispatch-identity';
import { RealtimeService } from '../realtime/realtime.service';
import { sessionHasEnded } from '../runner-api/background-job-wake';
import {
  attachReplyToTurn,
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
 * onto one already queued (MERGED), kept on the row because the asker had ended (HELD) — or
 * somewhere another pass had already put it (ALREADY).
 */
export type SessionReplyHandOff = 'QUEUED' | 'MERGED' | 'HELD' | 'ALREADY';

/** The id of the one comment that tells an ended asker's task what its request came to (§4.3). */
export function sessionReplyCommentId(requestId: string): string {
  return derivedUuid(`session-request:v1:reply-comment:${requestId}`);
}

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
    const handOff = await this.handOff(answered.request.id);
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
   * Publishes both sessions' rows when it moved anything: the asker stops waiting, the recipient stops
   * owing, and both clients' request cards read the state again.
   */
  async handOff(requestId: string): Promise<SessionReplyHandOff> {
    const request = await this.prisma.sessionRequest.findUnique({ where: { id: requestId } });
    if (!request || request.state === 'OPEN' || request.replyClientTurnId || request.replyHeldAt) return 'ALREADY';
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
            const queued = await undeliveredReplyTurn(tx, request.fromSessionId);
            merged = queued !== null;
            await attachReplyToTurn(tx, request.id, queued?.clientTurnId ?? clientTurnId);
            return queued;
          },
        },
      );
    } catch (error) {
      if (error instanceof SessionReplyHandedOff) return 'ALREADY';
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

  /** `handOff` for each of these, for a caller with nothing to do about a failure but log it. */
  async handOffQuietly(requestIds: readonly string[]): Promise<void> {
    for (const requestId of requestIds) {
      try {
        await this.handOff(requestId);
      } catch (error) {
        this.log.warn(
          `session request ${requestId} was not handed back yet: ${error instanceof Error ? error.message : error}; `
          + 'the request worker tries again',
        );
      }
    }
  }

  /**
   * §4.3: the asker ended before its request came to anything, so the outcome is said where whoever
   * runs its task next will read it. Written before the hold that marks the hand-off done, and keyed by
   * the request, so a hand-off cut off between the two writes it again as nothing. An asker that ran no
   * task, or is gone, has nowhere to be told — and one that has NOT ended, whose conversation refused
   * the turn for some other reason of its state, reads the outcome on its next turn instead.
   */
  private async commentIfAskerEnded(request: SessionRequest): Promise<void> {
    const asker = await this.prisma.session.findFirst({
      where: { id: request.fromSessionId, ownerId: request.ownerId },
      select: {
        title: true, taskId: true, status: true, endReason: true, cancelRequestedAt: true,
        completedAt: true, archivedAt: true, deletedAt: true,
      },
    });
    if (!asker?.taskId) return;
    if (!sessionHasEnded(asker) && !asker.cancelRequestedAt) return;
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
      `会话「${asker.title}」发出的会话间请求有了结局，但它在那之前已经结束；平台不会为了送回信去复活一段已经结束的对话，所以把结局记在这里。`,
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
