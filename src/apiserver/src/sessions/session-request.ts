import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, type ConversationTurn, type SessionRequest } from '@prisma/client';
import {
  deriveSessionState,
  RunEventType,
  uuidToBase62,
  WATCH_LIMITS,
  type SessionReplyCard,
  type SessionRequestOutcome,
  type SessionRequestPeer,
  type SessionRequestView,
} from '@orbit/shared';

import { attribute, type RequestForBlock } from './session-message';
import { SESSION_REPLY_TURN_KEY_PREFIX } from './watch-turn-key';

/**
 * One Orbit session asking another for a reply, and the one outcome every such request comes to
 * (docs/session-request-reply-contract.md §3–§5, P1).
 *
 * A REQUEST is a `session_send` / `project_send` that carried `expectReply`. The message is written
 * into the recipient's conversation exactly as P0 writes any other (session-message.ts), and beside
 * the turn that carries it a `session_request` row records who asked, what they offered as answers
 * and when they need one by. The send returns at once: the asker ends its turn, and the outcome
 * comes back to it as a turn of its own, so nothing ever has to poll.
 *
 * EXACTLY ONE OUTCOME. The row starts OPEN and is written once, by a compare-and-set on
 * `state = 'OPEN'`, to the first of these that happens (§4):
 *
 *   REPLIED          the recipient called `session_reply` (`replyToSessionRequest`);
 *   NO_REPLY         the recipient's turn settled with the request received, unanswered, and nothing
 *                    left that would wake it again (`closeUnansweredRequests`, judged in the
 *                    transaction that parks the session — runnerApi.turnComplete);
 *   RECIPIENT_ENDED  the recipient's run ended, or the session was completed or moved to Trash —
 *                    migration 0350's trigger, in the statement that ended it, whichever path that was;
 *   EXPIRED          `replyBy` passed (`expireSessionRequest`, the worker);
 *   UNDELIVERED      the turn carrying it was taken off the recipient's queue before any engine read
 *                    it — an interrupt dropping the queue, the owner withdrawing it
 *                    (`settleUnrunSessionRequests`) — or it was a steer the engine never confirmed:
 *                    the runner failed to write it into the running turn, or the run failed with it
 *                    still in flight (`closeUnreadSteerRequests`) — or its turn failed before any
 *                    engine read it and was kept for a retry that another turn then took the place of
 *                    (`closeRequestsTheRetryWillNotResend`).
 *
 * Migration 0350's guard refuses any later rewrite of an outcome, so "first wins" is the database's
 * rule and not only this file's.
 *
 * HANDED BACK ONCE. An outcome is handed to the asker on a `session-reply:` turn of its conversation
 * (`SessionRequestService.handOff`), with no words of its own — the outcomes are kept beside it on
 * their rows (`reply_client_turn_id`) and written in at delivery (`appendSessionRepliesContext`),
 * exactly as a background job's wake is, and routed as one is: written into the turn the asker is
 * running, as a CURRENT_WORK steer aimed at it, when its runtime and runner can take one (createTurn's
 * `steerIfLive`) — an asker running a turn is usually waiting in it for this very answer — and queued
 * for its next turn otherwise. Outcomes that arrive while that turn still waits join it, on its own
 * route only: a steer still waiting for the same running turn, or the queued next-turn reply turn. So
 * five workers answering at once reach the asker once. A steer whose turn ended before the engine read
 * it is the next-turn reply turn again, on the same row, and takes the one already queued into itself
 * (`foldQueuedReplyTurnsInto`); one the runner could not write in lets its outcomes go, to be handed
 * back again (`releaseUnreadSteerReplies`). An asker that has ended is not revived for it (§4.3): the
 * outcome is held on the row, and a comment goes on the task the asker ran. An asker interrupted with
 * the reply turn still queued — or its reply steer not yet taken — loses that turn with the rest of
 * its queue: stopping means stopping, and the outcome is held the same way. So is one whose turn the
 * asker never read through: the turn failed, or its run ended with it in flight. Either way a held
 * outcome is written into the next turn the asker IS handed, so none is lost — and a retry of a
 * failed reply turn is that turn (`hasHeldSessionReplies`, auto-retry.service.ts).
 *
 * An asker a transient failure stopped with an auto-retry armed has NOT ended (§8 criterion 17,
 * `awaitsAutoRetry`): its outcomes are held for the retry's turn, and its task is told nothing. If the
 * retry is given up instead — or the asker ends while it waits — there is no next turn to say them on:
 * migration 0352's trigger marks what is held for it (`reply_comment_due_at`), and the request worker
 * says it on the asker's task as §4.3 says an ended asker's outcome.
 */

/**
 * The `client_turn_id` prefix of the turn that hands outcomes back to the asking session — reserved
 * at every door that lets a caller choose a key (watch-turn-key.ts).
 */
export const SESSION_REPLY_TURN_PREFIX = SESSION_REPLY_TURN_KEY_PREFIX;

export function isSessionReplyTurn(clientTurnId: string | null | undefined): boolean {
  return typeof clientTurnId === 'string' && clientTurnId.startsWith(SESSION_REPLY_TURN_PREFIX);
}

/** §3.1: the most requests one session may have waiting for a reply at once (`SPAWN_TREE_OUTSTANDING`). */
export const MAX_OPEN_REQUESTS_PER_SESSION = 50;

/** §4.2: how much of the request is said back to the asker beside its outcome. */
export const REQUEST_PREVIEW_CHARS = 200;

/** The longest reply `session_reply` takes: it is written into the asker's next turn as it stands. */
export const REPLY_TEXT_MAX = 20_000;

/** How much of the recipient's last words an outcome block quotes. The row keeps all of them. */
const EXCERPT_BLOCK_CHARS = 2_000;

export const SELF_REQUEST_CODE = 'SELF_REQUEST';
export const TOO_MANY_OPEN_REQUESTS_CODE = 'TOO_MANY_OPEN_REQUESTS';
export const REQUEST_CLOSED_CODE = 'REQUEST_CLOSED';

/** One answer the asker offers: `ask_owner`'s option shape. */
export interface ReplyOption {
  label: string;
  description?: string;
}

/** What a send asked for, once the body has been read (`readRequestAsk`). */
export interface SessionRequestAsk {
  options: ReplyOption[] | null;
  replyWithinSeconds: number;
}

/** The three request parameters, as either send door's body carries them. */
export interface SessionRequestParams {
  expectReply?: unknown;
  replyOptions?: unknown;
  replyWithinSeconds?: unknown;
}

const OPTION_LABEL_MAX = 200;
const OPTION_DESCRIPTION_MAX = 500;

/**
 * §3.1: read the request parameters off a send's body. Null when the send asks for no reply, which is
 * every send that does not say `expectReply: true` — the message then goes exactly as it did before.
 * `replyOptions` and `replyWithinSeconds` mean something only beside `expectReply: true`, so either
 * of them without it is refused rather than quietly dropped: a caller that offered options believes
 * it asked for an answer.
 */
export function readRequestAsk(params: SessionRequestParams): SessionRequestAsk | null {
  const { expectReply, replyOptions, replyWithinSeconds } = params;
  if (expectReply != null && typeof expectReply !== 'boolean') {
    throw new BadRequestException('expectReply must be true or false');
  }
  if (expectReply !== true) {
    if (replyOptions != null || replyWithinSeconds != null) {
      throw new BadRequestException(
        'replyOptions and replyWithinSeconds are only accepted with expectReply: true',
      );
    }
    return null;
  }
  return {
    options: readReplyOptions(replyOptions),
    replyWithinSeconds: readReplyWithin(replyWithinSeconds),
  };
}

function readReplyOptions(value: unknown): ReplyOption[] | null {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length < 2 || value.length > 4) {
    throw new BadRequestException('replyOptions must be 2 to 4 options, or left out');
  }
  return value.map((option, index) => {
    if (option == null || typeof option !== 'object' || Array.isArray(option)) {
      throw new BadRequestException(`replyOptions[${index}] must be { label, description? }`);
    }
    const { label, description, ...rest } = option as Record<string, unknown>;
    const unknown = Object.keys(rest);
    if (unknown.length > 0) {
      throw new BadRequestException(`replyOptions[${index}] has unknown field ${unknown[0]}: only label and description`);
    }
    if (typeof label !== 'string' || label.trim() === '' || label.length > OPTION_LABEL_MAX) {
      throw new BadRequestException(`replyOptions[${index}].label must be 1 to ${OPTION_LABEL_MAX} characters`);
    }
    if (description != null && (typeof description !== 'string' || description.length > OPTION_DESCRIPTION_MAX)) {
      throw new BadRequestException(`replyOptions[${index}].description must be at most ${OPTION_DESCRIPTION_MAX} characters`);
    }
    return {
      label: stripNul(label.trim()),
      ...(typeof description === 'string' && description.trim() ? { description: stripNul(description.trim()) } : {}),
    };
  });
}

/** §3.1: the deadline, in the range and with the default a watch's TTL has (`WATCH_LIMITS`). */
function readReplyWithin(value: unknown): number {
  if (value == null) return WATCH_LIMITS.defaultTtlSeconds;
  if (
    typeof value !== 'number'
    || !Number.isInteger(value)
    || value < WATCH_LIMITS.minTtlSeconds
    || value > WATCH_LIMITS.maxTtlSeconds
  ) {
    throw new BadRequestException(
      `replyWithinSeconds must be a whole number of seconds from ${WATCH_LIMITS.minTtlSeconds} to ${WATCH_LIMITS.maxTtlSeconds}`,
    );
  }
  return value;
}

/** §3.1: a request needs a conversation for its outcome to come back to. */
export const HEADLESS_REQUEST_REFUSAL =
  'expectReply requires a calling session: a reply needs a conversation to come back to';

/** §3.1: a session cannot ask itself. */
export function selfRequestRefusal(): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: SELF_REQUEST_CODE,
    message: 'a session cannot ask itself for a reply: send without expectReply, or ask another session',
  });
}

/** A refusal of its own class, so `project_send` lets it through as itself rather than as a delivery that failed. */
export class TooManyOpenRequests extends ConflictException {}

/**
 * §3.1: refuse a NEW request when the asker already has fifty waiting. Backpressure rather than a
 * mistake in the request, so the words say what to do instead.
 *
 * Called from the send's `participateSendTransaction` — after idempotency and placement, before the
 * turn is written — so a retry that replays a committed key never reaches it, and a refusal rolls
 * back with the turn it was for.
 */
export async function chargeOpenRequest(tx: Prisma.TransactionClient, fromSessionId: string): Promise<void> {
  const open = await tx.sessionRequest.count({ where: { fromSessionId, state: 'OPEN' } });
  if (open < MAX_OPEN_REQUESTS_PER_SESSION) return;
  throw new TooManyOpenRequests({
    statusCode: 409,
    error: 'Conflict',
    code: TOO_MANY_OPEN_REQUESTS_CODE,
    message:
      `this session already has ${open} requests waiting for a reply (limit ${MAX_OPEN_REQUESTS_PER_SESSION}); `
      + 'wait for some of them to be answered before asking more — each outcome comes back to you as a turn',
    retryable: false,
  });
}

/**
 * Write the request beside the turn that carries it — in the transaction that wrote the turn, under
 * the recipient's row lock (`createTurn` / `resume`'s `onTurnWritten`).
 */
export async function recordSessionRequest(
  tx: Prisma.TransactionClient,
  input: {
    ownerId: string;
    fromSessionId: string;
    toSessionId: string;
    turn: Pick<ConversationTurn, 'id' | 'clientTurnId' | 'content'>;
    ask: SessionRequestAsk;
  },
): Promise<void> {
  await tx.sessionRequest.create({
    data: {
      ownerId: input.ownerId,
      fromSessionId: input.fromSessionId,
      toSessionId: input.toSessionId,
      turnId: input.turn.id,
      clientTurnId: input.turn.clientTurnId,
      requestPreview: preview(input.turn.content ?? ''),
      options: input.ask.options ? (input.ask.options as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      replyBy: new Date(Date.now() + input.ask.replyWithinSeconds * 1_000),
    },
  });
}

/** What a send that asked for a reply answers beside its placement (§3.1). */
export interface SessionRequestReceipt {
  requestId: string;
  replyBy: string;
}

/**
 * The receipt of a send door that carried a request — or the refusal of a retry whose body no
 * longer matches what its key was first written with.
 *
 * Read after the write, by the key the turn was written under, so a retry that replayed a committed
 * turn answers the request that turn carries rather than asking again. A key first used for a plain
 * message cannot become a request on a retry, nor the other way round: that is a different payload
 * under the same key, and it is refused the way `createTurn` refuses one.
 */
export async function sessionRequestReceipt(
  db: Pick<Prisma.TransactionClient, 'sessionRequest'>,
  toSessionId: string,
  clientTurnId: string,
  asked: boolean,
): Promise<SessionRequestReceipt | null> {
  const request = await db.sessionRequest.findUnique({
    where: { toSessionId_clientTurnId: { toSessionId, clientTurnId } },
    select: { id: true, replyBy: true },
  });
  if (asked !== (request != null)) {
    throw new ConflictException(
      asked
        ? 'clientTurnId was already used for a message that asked for no reply'
        : 'clientTurnId was already used for a request; repeat it with expectReply to read it back',
    );
  }
  return request ? { requestId: uuidToBase62(request.id), replyBy: request.replyBy.toISOString() } : null;
}

/** The request a delivered turn carries, as its `<orbit-session-message>` block names it. */
export async function readRequestForBlock(
  tx: Prisma.TransactionClient,
  sessionId: string,
  turnId: string,
): Promise<RequestForBlock | null> {
  const request = await tx.sessionRequest.findFirst({
    where: { toSessionId: sessionId, turnId },
    select: { id: true, replyBy: true, options: true, state: true },
  });
  if (!request) return null;
  return {
    id: request.id,
    replyBy: request.replyBy,
    options: readStoredOptions(request.options),
    state: request.state as SessionRequestOutcome | 'OPEN',
  };
}

// ── the outcomes ──────────────────────────────────────────────────────────────────────────────────

/** Why a REPLIED could not be written: the request is not the caller's, or it already has an outcome. */
export type ReplyRefusal =
  | { kind: 'NOT_FOUND' }
  | { kind: 'NOT_RECIPIENT' }
  | { kind: 'CLOSED'; request: SessionRequest };

/** What `session_reply` carries. */
export interface SessionReplyInput {
  message?: string | null;
  option?: number | null;
}

/**
 * §3.2: validate a reply against the request it answers. With options, an `option` (an index into
 * them) or a `message`, or both; without, a `message`.
 */
export function readReply(request: Pick<SessionRequest, 'options'>, input: SessionReplyInput): {
  replyText: string | null;
  replyOption: number | null;
} {
  const message = typeof input.message === 'string' ? stripNul(input.message).trim() : '';
  if (input.message != null && typeof input.message !== 'string') {
    throw new BadRequestException('message must be text');
  }
  const options = readStoredOptions(request.options);
  let option: number | null = null;
  if (input.option != null) {
    if (!options) {
      throw new BadRequestException('this request offered no options: answer with message');
    }
    if (typeof input.option !== 'number' || !Number.isInteger(input.option) || input.option < 0 || input.option >= options.length) {
      throw new BadRequestException(`option must be the index of one of the ${options.length} options (0 to ${options.length - 1})`);
    }
    option = input.option;
  }
  if (options && option === null && message === '') {
    throw new BadRequestException('give option (the index of the answer you choose), message, or both');
  }
  if (message.length > REPLY_TEXT_MAX) {
    throw new BadRequestException(
      `message is ${message.length} characters, more than a reply may carry (${REPLY_TEXT_MAX}): `
      + 'put the long part in a file or on the task, and say where in the reply',
    );
  }
  if (!options && message === '') {
    throw new BadRequestException('message is required: this request offered no options to choose from');
  }
  return { replyText: message === '' ? null : message, replyOption: option };
}

/**
 * REPLIED, by a compare-and-set on OPEN. Only the recipient may answer, and only once: a request that
 * already has an outcome — the recipient answered, or the platform closed it a moment earlier — is
 * refused as itself, with the outcome it has.
 */
export async function replyToSessionRequest(
  tx: Prisma.TransactionClient,
  input: { ownerId: string; callerSessionId: string; requestId: string; reply: SessionReplyInput },
): Promise<{ ok: true; request: SessionRequest } | ({ ok: false } & ReplyRefusal)> {
  const request = await tx.sessionRequest.findFirst({ where: { id: input.requestId, ownerId: input.ownerId } });
  if (!request) return { ok: false, kind: 'NOT_FOUND' };
  if (request.toSessionId !== input.callerSessionId) return { ok: false, kind: 'NOT_RECIPIENT' };
  if (request.state !== 'OPEN') return { ok: false, kind: 'CLOSED', request };
  const { replyText, replyOption } = readReply(request, input.reply);
  const [written] = await tx.sessionRequest.updateManyAndReturn({
    where: { id: request.id, state: 'OPEN' },
    data: { state: 'REPLIED', replyText, replyOption, closedAt: new Date() },
  });
  if (written) return { ok: true, request: written };
  // Somebody else's outcome landed between the read and the write: that one stands.
  return {
    ok: false,
    kind: 'CLOSED',
    request: await tx.sessionRequest.findUniqueOrThrow({ where: { id: request.id } }),
  };
}

/** The refusal a closed request answers `session_reply` with, naming the outcome it already has. */
export function requestClosedRefusal(request: SessionRequest): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: REQUEST_CLOSED_CODE,
    message:
      `this request is already closed as ${request.state}; its outcome has gone back to the session `
      + 'that asked. To add something, send that session an ordinary message with session_send.',
    outcome: request.state,
    closedAt: request.closedAt?.toISOString() ?? null,
  });
}

/**
 * §2.1: a re-send of a failed message takes the request it carried with it. The platform re-sends the
 * words of a turn another session sent as a new turn — the auto-retry sweep, or the failure card's
 * Retry asking the server for it (`AutoRetryService.resend`) — and when that turn carried a request,
 * the request is asked on the new one from then on: its block and its card name it there
 * (`readRequestForBlock`, `readTurnRequestIds`), it is received when that turn is
 * (`closeUnansweredRequests`), and it goes with that turn when the turn is taken off the queue unrun
 * (`settleUnrunSessionRequests`). Left on the failed turn, the re-sent words would reach the engine
 * as a plain message, with nothing saying an answer is awaited or how to give one.
 *
 * Written in the transaction that writes the re-sent turn (its `onTurnWritten` hook), under the
 * recipient's lock. `client_turn_id` stays the key the request was SENT under, so a retry of that send
 * still reads its own receipt (`sessionRequestReceipt`). A request that has already come to its outcome
 * moves as well: the re-sent words are still that request, and their block says it is closed instead
 * of saying nothing.
 */
export async function moveSessionRequestToTurn(
  tx: Prisma.TransactionClient,
  sessionId: string,
  fromTurnId: string,
  toTurnId: string,
): Promise<void> {
  await tx.sessionRequest.updateMany({
    where: { toSessionId: sessionId, turnId: fromTurnId },
    data: { turnId: toTurnId },
  });
}

/**
 * §4.1: whether a session still has something that will wake it by itself — and so may yet answer.
 * Any one of the six keeps the requests waiting on it OPEN; with none of them, a request it received
 * and has not answered never will be, and is closed NO_REPLY. Whatever is not on this list is left to
 * the deadline.
 *
 *   1. an ACTIVE watch it observes whose action resumes it;
 *   2. a background job still running: `session.running_bg_jobs`, the running set ingest folds out of
 *      the session's `background_task` events under its row lock — the same events
 *      `appendBackgroundJobsContext` reads, kept as a set rather than re-folded here. It leaves out a
 *      `service` job (a dev server runs for the life of the session and wakes nobody), and it is what
 *      `runStoppedWorking` reads for the same question about a task's run;
 *   3. a scheduled wakeup still PENDING;
 *   4. a request of its own whose outcome has not reached it yet — the outcome comes back to it as a
 *      turn. Still OPEN, unless its recipient is itself waiting on an OPEN request from this session:
 *      two sessions each waiting for the other's reply wake neither, and counting the wait would hold
 *      both to the deadline (a longer cycle, A→B→C→A, is left to the deadline). Or closed, with the
 *      outcome on its way back: on no turn of this session yet and not held, so the hand-off that is
 *      about to queue it — or the worker after a crash — wakes this session with it. One on a turn
 *      still queued needs no read here: that turn keeps the session from parking at all, so the
 *      judgment is never reached;
 *   5. a question it asked the owner AS the project's coordinator (`ask_owner`) still OPEN. The answer
 *      goes to whichever session coordinates the project when it comes, so a question asked by a
 *      conversation that has since been rotated out wakes it no more;
 *   6. an auto-retry armed (`session.retry_at`): a turn a quota or the provider killed stopped it, and
 *      the sweep re-sends that turn's message — a request it carried goes with it
 *      (`moveSessionRequestToTurn`) — so it runs again. `retryAt` is the row as the caller has just
 *      written it.
 */
export async function hasPendingWakeSource(
  tx: Prisma.TransactionClient,
  session: { id: string; runningBgJobs: readonly string[]; retryAt: Date | null },
): Promise<boolean> {
  const sessionId = session.id;
  const watch = await tx.watch.findFirst({
    where: { observerSessionId: sessionId, action: 'RESUME_SESSION', state: 'ACTIVE' },
    select: { id: true },
  });
  if (watch) return true;
  if (session.runningBgJobs.length > 0) return true;
  if (session.retryAt != null) return true;
  const wakeup = await tx.sessionScheduledWakeup.findFirst({
    where: { sessionId, state: 'PENDING' },
    select: { id: true },
  });
  if (wakeup) return true;
  const asked = await tx.sessionRequest.findMany({
    where: { fromSessionId: sessionId, state: 'OPEN' },
    select: { toSessionId: true },
  });
  if (asked.length > 0) {
    const waitingOnThis = new Set((await tx.sessionRequest.findMany({
      where: {
        toSessionId: sessionId,
        state: 'OPEN',
        fromSessionId: { in: [...new Set(asked.map((request) => request.toSessionId))] },
      },
      select: { fromSessionId: true },
    })).map((request) => request.fromSessionId));
    if (asked.some((request) => !waitingOnThis.has(request.toSessionId))) return true;
  }
  const onItsWay = await tx.sessionRequest.findFirst({
    where: { fromSessionId: sessionId, state: { not: 'OPEN' }, replyClientTurnId: null, replyHeldAt: null },
    select: { id: true },
  });
  if (onItsWay) return true;
  const question = await tx.projectOpenItem.findFirst({
    where: {
      askedBySessionId: sessionId,
      kind: 'COORDINATOR_QUESTION',
      state: 'OPEN',
      project: { coordinatorSessionId: sessionId },
    },
    select: { id: true },
  });
  return question != null;
}

/**
 * NO_REPLY (§4.1), judged once each time the recipient's turn settles: in the transaction that parks
 * the session idle, under its row lock (runnerApi.turnComplete). Every OPEN request it has RECEIVED —
 * the turn carrying it was handed to an engine, and the engine took it — is closed with what it last
 * said, unless something will still wake it (`hasPendingWakeSource`). A request still queued has not
 * been read and is not judged.
 *
 * Nor is one on a steer the runner has not settled. A steer's `delivered_at` is stamped when the
 * runner takes it, before it is written into the running turn, and the turn can end before the
 * engine reads it — the steer then comes back as a queued message (steer_requeue) or fails. Received
 * is the runner's word that the engine took it: the steer settled, or a CURRENT_WORK one the engine
 * acknowledged. One that failed was closed UNDELIVERED as it settled (`closeUnreadSteerRequests`), so a
 * settled steer whose request is still OPEN here is one the engine read. A steer the engine took only
 * after this turn's result is judged when a later turn settles, or by the deadline — not as the steer
 * settles: an engine that read a message after its result is running a turn for it that no completion
 * here will report, and judging then would close a request it may be answering.
 *
 * And one a turn of the owner's came after (§8 criterion 26): a message an engine was handed, whose run
 * then failed before the engine answered it, kept for a retry the owner's message took the place of
 * (`closeRequestsTheRetryWillNotResend`). Put back in the queue and drained with that run, its turn has
 * lost the claim's stamp the read below goes by, but it was read, and is judged as read.
 *
 * Answers the requests this closed, for the asker's hand-off once the transaction commits.
 */
export async function closeUnansweredRequests(
  tx: Prisma.TransactionClient,
  session: {
    id: string;
    runningBgJobs: readonly string[];
    retryAt: Date | null;
    lastAssistantText: string | null;
  },
): Promise<string[]> {
  const open = await tx.sessionRequest.findMany({
    where: { toSessionId: session.id, state: 'OPEN' },
    select: { id: true, turnId: true },
  });
  if (open.length === 0) return [];
  const received: Set<string> = new Set((await tx.conversationTurn.findMany({
    where: {
      sessionId: session.id,
      id: { in: open.map((request) => request.turnId) },
      deliveredAt: { not: null },
      OR: [
        { kind: { not: 'steer' } },
        { status: 'ANSWERED', deliveryStatus: null },
        { deliveryStatus: 'ACKNOWLEDGED' },
      ],
    },
    select: { id: true },
  })).map((turn) => turn.id));
  const unstamped = open.filter((request) => !received.has(request.turnId)).map((request) => request.turnId);
  if (unstamped.length > 0) {
    const drained = await tx.conversationTurn.findMany({
      where: { sessionId: session.id, id: { in: unstamped }, kind: 'message', status: 'ANSWERED', deliveredAt: null },
      select: { id: true },
    });
    for (const turnId of await turnsAnEngineWasHanded(tx, session.id, drained.map((turn) => turn.id))) {
      received.add(turnId);
    }
  }
  const due = open.filter((request) => received.has(request.turnId)).map((request) => request.id);
  if (due.length === 0) return [];
  if (await hasPendingWakeSource(tx, session)) return [];
  const closed = await tx.sessionRequest.updateManyAndReturn({
    where: { id: { in: due }, state: 'OPEN' },
    data: { state: 'NO_REPLY', excerpt: session.lastAssistantText ?? null, closedAt: new Date() },
    select: { id: true },
  });
  return closed.map((request) => request.id);
}

/** What is taking a session's queued turns away unrun — the shape `returnQueuedTurns` is told. */
export type UnrunSessionRequests =
  /** An interrupt drops the whole queue. */
  | { code: 'TURN_INTERRUPTED' }
  /** The account owner withdrew one queued turn. */
  | { code: 'TURN_WITHDRAWN'; turnId: string }
  /**
   * The session's run is ending and its turns are drained. `closesRequests` is true where the status
   * write that ends the run has ALREADY happened in this transaction (a failed turn, the runner's
   * finalize, the reaper): migration 0350's trigger has closed every request the end closes, so what
   * is still OPEN here is a run that goes on (a retry is armed), and a request in its queue was never
   * read. Those callers then drain every turn not yet answered, the one in flight among them. It is
   * false where the drain comes before the status write and takes only the queue (`transitionEnd`),
   * whose end the trigger reads as RECIPIENT_ENDED once it is written — which the contract says wins
   * (§4) — and whose turn in flight is still its runner's to finish.
   *
   * `retryArmed`: the run has a retry armed, so the same session goes on, and the retry's re-send is
   * the next turn it is handed — which is why the request on that turn is kept OPEN rather than closed
   * UNDELIVERED (criterion 18). `failedTurnKey`: the turn whose failure is ending the run, already
   * acknowledged by the time this runs — what it carried was not read through either.
   */
  | { code: 'SESSION_ENDED'; closesRequests: boolean; retryArmed: boolean; failedTurnKey?: string };

/**
 * What rides on the turns about to be taken away unrun (§4, §4.3). Called beside
 * `deadLetterQueuedWatchWakes` and `returnQueuedTurns` — under the session lock, before the turns are
 * deleted or retired, in the same transaction, so a refusal further down rolls this back too.
 *
 * Two kinds of turn are taken. A REQUEST another session sent here that no engine read is closed
 * UNDELIVERED, with what took it: one still queued, and — when a run is ending — a steer still in
 * flight that the engine never acknowledged. The one exception is the turn the retry re-sends (§8
 * criteria 18 and 23): its request stays OPEN and goes with the re-sent turn, because those words are
 * not being dropped — provided the retry can find them again. So does a message in flight when a reap
 * or a finalize ends the run, which the retry re-sends even when the runner went away before recording
 * anything of it (§8 criterion 27, `retryRecords`); one the retry cannot find is UNDELIVERED here, as a
 * queued one is. If another turn later takes the retry's place, what no engine read is closed then
 * (`closeRequestsTheRetryWillNotResend`). A turn of this session as an ASKER may
 * carry outcomes back to it — a reply turn still queued, a reply steer the engine never confirmed
 * (every door that calls this has just written its CURRENT_WORK steers off as FAILED or UNCONFIRMED,
 * `terminalizePendingCurrentWorkSteers`, and an earlier one may have), or any turn they were written
 * into when it was handed out — and those outcomes are not lost with it, nor with the turn whose
 * failure is ending the run. A reply steer the engine acknowledged has said them, as a delivered turn
 * has. When the session lives on — interrupted, the owner withdrew the turn, or a retry is armed —
 * they are held on their rows for the next turn it is handed: stopping means stopping, so no new reply
 * turn is queued for them, and a retry's re-send is that next turn (a failed reply turn is re-sent as
 * one, auto-retry.service.ts). When its run is over they are let go again, and the hand-off finds an
 * asker that has ended, holds them and writes on its task (§4.3).
 */
export async function settleUnrunSessionRequests(
  tx: Prisma.TransactionClient,
  sessionId: string,
  unrun: UnrunSessionRequests,
): Promise<void> {
  const ending = unrun.code === 'SESSION_ENDED';
  const drainsInFlight = ending && unrun.closesRequests;
  const unrunTurns = await tx.conversationTurn.findMany({
    where: {
      sessionId,
      kind: { in: ['message', 'steer'] },
      status: drainsInFlight ? { in: ['PENDING', 'IN_FLIGHT'] } : 'PENDING',
      ...(unrun.code === 'TURN_WITHDRAWN' ? { id: unrun.turnId } : {}),
    },
    select: { id: true, clientTurnId: true, kind: true, status: true, deliveryStatus: true },
  });
  const carriers = [
    ...unrunTurns.filter((turn) => turn.kind === 'message').map((turn) => turn.clientTurnId),
    ...(await replySteersSettledUnread(tx, sessionId)),
    ...(ending && unrun.failedTurnKey ? [unrun.failedTurnKey] : []),
  ];
  if (carriers.length > 0) {
    await tx.sessionRequest.updateMany({
      where: { fromSessionId: sessionId, replyClientTurnId: { in: carriers } },
      data: { replyClientTurnId: null, replyHeldAt: ending && !unrun.retryArmed ? null : new Date() },
    });
  }
  if (ending && !unrun.closesRequests) return;
  // §8 criterion 18: a turn the auto-retry is going to re-send is not lost with the queue. The turn
  // whose failure ended the run is the one the sweep re-sends — an engine that produced nothing comes
  // back as the same message on the sweeper's own ladder — and the request it carries travels with it
  // (`moveSessionRequestToTurn`). Closing it UNDELIVERED would tell the asker the request was dropped
  // for good, and the block on the re-sent turn would say it is closed, which is the one reading the
  // retry exists to avoid. Without a retry armed the words really are gone and it is UNDELIVERED.
  //
  // §8 criteria 23 and 27: and only when the sweep can find those words again — asked of every message
  // the end takes unrun, the queued and the one in flight alike, with the very records the sweep's own
  // chooser reads (`turnsTheRetryCanFind`). A turn with no record would be passed over for an older
  // message, and its request would sit OPEN on a turn nothing will ever deliver, to be judged NO_REPLY
  // against what the re-send of something else says. Such a turn is not re-sent, so its request is
  // UNDELIVERED now. A queued message the runner echoed and put back (its engine never came up) is one
  // the sweep does find, and its request stays with it.
  const resent = new Set(ending && unrun.retryArmed
    ? await turnsTheRetryCanFind(tx, sessionId, unrunTurns
        .filter((turn) => turn.kind === 'message')
        .map((turn) => turn.id))
    : []);
  const queued = unrunTurns
    .filter((turn) => turn.status === 'PENDING' && !resent.has(turn.id))
    .map((turn) => turn.id);
  if (queued.length > 0) {
    await tx.sessionRequest.updateMany({
      where: { toSessionId: sessionId, turnId: { in: queued }, state: 'OPEN' },
      data: {
        state: 'UNDELIVERED',
        closeReason: unrun.code === 'TURN_INTERRUPTED' ? 'INTERRUPTED' : unrun.code === 'TURN_WITHDRAWN' ? 'WITHDRAWN' : 'DRAINED',
        closedAt: new Date(),
      },
    });
  }
  const lost = unrunTurns
    .filter((turn) => turn.kind === 'message' && turn.status === 'IN_FLIGHT' && !resent.has(turn.id))
    .map((turn) => turn.id);
  if (lost.length > 0) {
    await tx.sessionRequest.updateMany({
      where: { toSessionId: sessionId, turnId: { in: lost }, state: 'OPEN' },
      data: { state: 'UNDELIVERED', closeReason: 'LOST_IN_FLIGHT', closedAt: new Date() },
    });
  }
  await closeUnreadSteerRequests(tx, sessionId, unrunTurns
    .filter((turn) => turn.kind === 'steer' && turn.status === 'IN_FLIGHT' && turn.deliveryStatus !== 'ACKNOWLEDGED')
    .map((turn) => turn.id));
}

/**
 * The keys of this session's reply steers that were written off undelivered — FAILED or UNCONFIRMED
 * (`terminalizePendingCurrentWorkSteers`): an interrupt took one before the runner did, or a run ended
 * with one its engine never acknowledged — so whatever outcome is still on one, nothing will deliver
 * it now. One whose outcomes an earlier pass already let go is found again and moves nothing.
 */
async function replySteersSettledUnread(
  tx: Prisma.TransactionClient,
  sessionId: string,
): Promise<string[]> {
  // A delivery written off is only ever a CURRENT_WORK steer's (the row constraints of 0210).
  const writtenOff = await tx.conversationTurn.findMany({
    where: { sessionId, sendIntent: 'CURRENT_WORK', deliveryStatus: { in: ['FAILED', 'UNCONFIRMED'] } },
    select: { clientTurnId: true },
  });
  return writtenOff.map((turn) => turn.clientTurnId).filter((key) => isSessionReplyTurn(key));
}

/**
 * UNDELIVERED (§4) for the requests these steers carry: the runner took each one to write it into the
 * running turn, and the engine never confirmed it — the runner reported it failed (runnerApi.turnComplete,
 * as the steer settles), or the run failed or was finalized with it still in flight
 * (`settleUnrunSessionRequests`). Left OPEN, a steer settled that way would read as received, and the
 * next settle would close a request no engine had read as NO_REPLY. A compare-and-set on OPEN like every
 * outcome: a run whose end has already closed the request RECIPIENT_ENDED keeps that.
 *
 * Answers the requests this closed, for the asker's hand-off once the transaction commits.
 */
export async function closeUnreadSteerRequests(
  tx: Prisma.TransactionClient,
  sessionId: string,
  steerTurnIds: readonly string[],
): Promise<string[]> {
  if (steerTurnIds.length === 0) return [];
  const closed = await tx.sessionRequest.updateManyAndReturn({
    where: { toSessionId: sessionId, turnId: { in: [...steerTurnIds] }, state: 'OPEN' },
    data: { state: 'UNDELIVERED', closeReason: 'STEER_UNCONFIRMED', closedAt: new Date() },
    select: { id: true },
  });
  return closed.map((request) => request.id);
}

/**
 * The runner's receipt for a message it was handed and could not give the engine: a `user_delivery`
 * whose `delivery` is `failed`, naming the turn in its payload. For Claude it is the ONLY trace of such
 * a message — a write queue that refuses the turn (a CLI that stopped reading stdin, a process already
 * gone) fails it before the `user` echo is written (runner-go session.go, `failUndeliveredTurn`), so a
 * reader that looks for the words by their echo alone walks past the message that failed to the one
 * before it. The retry reads its words off the receipt's turn instead (`retryRecords`).
 */
export const FAILED_DELIVERY_RECEIPT = {
  type: RunEventType.USER_DELIVERY,
  payload: { path: ['delivery'], equals: 'failed' },
} satisfies Prisma.RunEventWhereInput;

/**
 * The runner's receipt that a message it had echoed was never read after all: a `user_delivery` whose
 * `delivery` is `requeued` — a steer whose engine was fenced before it read the frame goes back to the
 * queue as a message of its own (runner-go session.go, `deliveryRequeued`).
 */
const REQUEUED_DELIVERY_RECEIPT = {
  type: RunEventType.USER_DELIVERY,
  payload: { path: ['delivery'], equals: 'requeued' },
} satisfies Prisma.RunEventWhereInput;

/**
 * What says a message's engine replied to it: the workspace's own reply (runnerApi's ANSWERS_USER_TURN).
 * A system line, stderr, a background job's event, an engine refusing the turn, or the interrupt a
 * draining runner files as it tears the turn down is none of these.
 */
const ENGINE_REPLIES = [RunEventType.ASSISTANT, RunEventType.RESULT];

/** How many of the runner's records the retry reads back: enough to cover a run of image-only turns. */
const RETRY_RECORDS = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One record the runner left of a message it took (`retryRecords`). */
export interface RetryRecord {
  /** The turn it is about; null for an echo from before turns were attributed. */
  turnId: string | null;
  /** Where it stands in the session's stream — null for the message the runner went away with, which it wrote nothing of. */
  seq: number | null;
  payload: Prisma.JsonValue | null;
}

/**
 * The turn a receipt is about: the one it names. The runner files a delivery's settling under whatever
 * turn is running when the write settles, which is often another (runner-go session.go, `reportDelivery`).
 */
function receiptTurn(receipt: { payload: Prisma.JsonValue; turnId: string | null }): string | null {
  const named = (receipt.payload as { turnId?: unknown } | null)?.turnId;
  return typeof named === 'string' && UUID.test(named) ? named : receipt.turnId;
}

/**
 * §2.1: how the auto-retry finds the message it re-sends — the last one the runner took — read one way by
 * both readers that need it: the chooser (`AutoRetryService.messageToResend`, which the failure card's
 * Retry shares) and the drain that keeps a failed turn's request for that re-send (`turnsTheRetryCanFind`,
 * from `settleUnrunSessionRequests`). A request kept for words the chooser then walks past is left on a
 * turn nothing will deliver, and words the drain gave up on are re-sent carrying a request already closed.
 *
 * What the runner recorded, oldest first:
 *
 *   - its `user` echo, written as it hands a message to the engine. The events themselves rather than a
 *     tail of the whole stream: one workspace turn emits hundreds of tool and system events after the
 *     message that provoked it, so a fixed window of the end misses the very message a retry exists to
 *     re-send. A handful covers a run of image-only turns, which carry no text;
 *   - its receipt saying it could not hand one over (FAILED_DELIVERY_RECEIPT), for the turn the receipt
 *     names: for Claude the only trace of a message the runtime refused before writing it;
 *   - and last, the message it took and went away with before recording it (`lostDelivery`).
 */
export async function retryRecords(
  db: Pick<Prisma.TransactionClient, 'runEvent' | 'conversationTurn' | 'session'>,
  sessionId: string,
): Promise<RetryRecord[]> {
  const select = { payload: true, turnId: true, seq: true } as const;
  const echoes = await db.runEvent.findMany({
    where: { sessionId, type: RunEventType.USER },
    orderBy: { seq: 'desc' },
    take: RETRY_RECORDS,
    select,
  });
  const receipts = await db.runEvent.findMany({
    where: { sessionId, ...FAILED_DELIVERY_RECEIPT },
    orderBy: { seq: 'desc' },
    take: RETRY_RECORDS,
    select,
  });
  const records: RetryRecord[] = receipts.length === 0 ? echoes.reverse() : [
    ...echoes,
    ...receipts.map((receipt) => ({ ...receipt, turnId: receiptTurn(receipt) })),
  ].sort((a, b) => a.seq - b.seq).slice(-RETRY_RECORDS);
  const lost = await lostDelivery(db, sessionId, records);
  return lost ? [...records, { turnId: lost, seq: null, payload: null }] : records;
}

/**
 * The message the runner took last, when the run ended under it before the runner recorded it — no
 * `user` echo, no receipt saying it could not hand it over — and before its engine replied to it (§8
 * criterion 27): the runner was reaped as offline, or the run finalized with its engine gone, and the
 * run's drain answers the turn unrun. The claim's stamp, which that drain leaves on the row
 * (`delivered_at`), is all there is to say it was taken, and it is the message the retry re-sends (§2.1)
 * — not the one before it, which was answered.
 *
 * Other events can be filed under it all the same: the runner points its output at a turn as it takes
 * it, before it echoes the turn (runner-go session.go and codex.go, `setTurn`), so a system line, stderr,
 * a background job's event, or the engine refusing the turn ("already has an active turn") lands on the
 * lost message. None of them is the engine replying to it (`ENGINE_REPLIES`).
 *
 * "Last" is by turn: message and shell turns are taken one at a time and in order, so a shell the owner
 * revived the session with after it is newer, and so is a message put back in the queue with a record of
 * its own. "The run ended under it": answered unrun, or — inside the very transaction that ends the run
 * and drains it, after the end is written — still out on its delivery.
 */
async function lostDelivery(
  db: Pick<Prisma.TransactionClient, 'runEvent' | 'conversationTurn' | 'session'>,
  sessionId: string,
  records: readonly RetryRecord[],
): Promise<string | null> {
  const taken = await db.conversationTurn.findFirst({
    where: { sessionId, kind: { in: ['message', 'shell'] }, deliveredAt: { not: null } },
    orderBy: { seq: 'desc' },
    select: { id: true, seq: true, kind: true, status: true },
  });
  const recorded = new Set(records.flatMap((record) => (record.turnId ? [record.turnId] : [])));
  if (!taken || taken.kind !== 'message' || recorded.has(taken.id)) return null;
  if (taken.status !== 'ANSWERED') {
    const session = await db.session.findUnique({ where: { id: sessionId }, select: { status: true } });
    if (!session || !RUN_ENDED.includes(session.status)) return null;
  }
  // Looked for under the turn itself, not in the window of records.
  const reached = await db.runEvent.findFirst({
    where: {
      sessionId,
      OR: [
        { turnId: taken.id, type: { in: [RunEventType.USER, ...ENGINE_REPLIES] } },
        { ...FAILED_DELIVERY_RECEIPT, turnId: taken.id },
        { type: RunEventType.USER_DELIVERY, AND: [{ payload: FAILED_DELIVERY_RECEIPT.payload }, { payload: { path: ['turnId'], equals: taken.id } }] },
      ],
    },
    select: { id: true },
  });
  if (reached) return null;
  const after = recorded.size === 0 ? null : await db.conversationTurn.findFirst({
    where: { sessionId, kind: { in: ['message', 'shell'] }, seq: { gt: taken.seq }, id: { in: [...recorded] } },
    select: { id: true },
  });
  return after ? null : taken.id;
}

/** A run that is over: what a reap or a finalize writes before it drains the run's turns. */
const RUN_ENDED: string[] = ['SUCCEEDED', 'FAILED', 'CANCELLED'];

/**
 * Of these failed turns, the ones the auto-retry will find again: a turn the records it reads are about
 * (`retryRecords`), so the drain keeps a request for exactly the re-send the chooser will make.
 */
export async function turnsTheRetryCanFind(
  db: Pick<Prisma.TransactionClient, 'runEvent' | 'conversationTurn' | 'session'>,
  sessionId: string,
  turnIds: readonly string[],
): Promise<string[]> {
  if (turnIds.length === 0) return [];
  const asked = new Set(turnIds);
  return [...new Set((await retryRecords(db, sessionId))
    .flatMap((record) => (record.turnId && asked.has(record.turnId) ? [record.turnId] : [])))];
}

/**
 * Of these message turns, the ones an engine was handed (§4, §8 criterion 26): the runner's last word on
 * each is its `user` echo, written as it hands the words over, and not a receipt after it saying the
 * frame never reached the engine — Claude echoes a message as it queues it for the CLI, and a write that
 * then fails says so (FAILED_DELIVERY_RECEIPT), as a steer put back in the queue unread does
 * (REQUEUED_DELIVERY_RECEIPT).
 */
async function turnsAnEngineWasHanded(
  db: Pick<Prisma.TransactionClient, 'runEvent'>,
  sessionId: string,
  turnIds: readonly string[],
): Promise<Set<string>> {
  if (turnIds.length === 0) return new Set();
  const echoes = await db.runEvent.findMany({
    where: { sessionId, type: RunEventType.USER, turnId: { in: [...new Set(turnIds)] } },
    select: { turnId: true, seq: true },
  });
  const lastEcho = new Map<string, number>();
  for (const echo of echoes) {
    if (echo.turnId) lastEcho.set(echo.turnId, Math.max(lastEcho.get(echo.turnId) ?? echo.seq, echo.seq));
  }
  if (lastEcho.size === 0) return new Set();
  const refusals = await db.runEvent.findMany({
    where: {
      sessionId,
      seq: { gt: Math.min(...lastEcho.values()) },
      OR: [FAILED_DELIVERY_RECEIPT, REQUEUED_DELIVERY_RECEIPT],
    },
    select: { payload: true, turnId: true, seq: true },
  });
  for (const refusal of refusals) {
    const turnId = receiptTurn(refusal);
    const echoed = turnId == null ? undefined : lastEcho.get(turnId);
    if (turnId != null && echoed != null && echoed < refusal.seq) lastEcho.delete(turnId);
  }
  return new Set(lastEcho.keys());
}

/**
 * §8 criterion 26: a new turn has taken the place of the retry a failed run was waiting on — the owner
 * sent a message of their own instead of pressing Retry, or another door revived the session — and the
 * retry is disarmed with it. A request kept for the retry's re-send (criteria 18 and 27) will not get
 * one now: it is left on a turn the run's end answered unrun, which nothing will deliver again.
 *
 * What no engine was handed is UNDELIVERED at once (§4: taken away before any engine read it, and not
 * to be re-sent). What one was is left OPEN — it was read — and is judged as read when a turn of this
 * session next settles (§4.1, `closeUnansweredRequests`). The request worker hands the outcomes back.
 *
 * Called by the revive that writes that turn (`SessionsService.resume`), in its transaction and under
 * the recipient's lock, after the turn and what rides on it are written: the sweep's own re-send, and
 * the failure card's Retry, have by then taken their request onto the new turn and leave nothing here.
 */
export async function closeRequestsTheRetryWillNotResend(
  tx: Prisma.TransactionClient,
  sessionId: string,
): Promise<void> {
  const open = await tx.sessionRequest.findMany({
    where: { toSessionId: sessionId, state: 'OPEN' },
    select: { turnId: true },
  });
  if (open.length === 0) return;
  const answered = await tx.conversationTurn.findMany({
    where: { sessionId, id: { in: open.map((request) => request.turnId) }, kind: 'message', status: 'ANSWERED' },
    select: { id: true },
  });
  const kept = await turnsTheRetryCanFind(tx, sessionId, answered.map((turn) => turn.id));
  const handed = await turnsAnEngineWasHanded(tx, sessionId, kept);
  const unread = kept.filter((turnId) => !handed.has(turnId));
  if (unread.length === 0) return;
  await tx.sessionRequest.updateMany({
    where: { toSessionId: sessionId, turnId: { in: unread }, state: 'OPEN' },
    data: { state: 'UNDELIVERED', closeReason: 'NOT_RESENT', closedAt: new Date() },
  });
}

/**
 * Whether any outcome of this session's own requests is waiting for a turn to be said on: closed, and
 * on no turn of it yet — held, or about to be handed back. What decides that the auto-retry sweep
 * re-sends a failed reply turn as a reply turn rather than dropping it: the turn's own failure held
 * what it carried (`settleUnrunSessionRequests`, `holdTurnRepliesForRetry`), and the re-sent turn says
 * it again. Read before the sweep claims the retry, so it is the sweep's first look and not its word:
 * the re-sent turn takes the outcomes in the transaction that writes it (`attachHeldReplies`).
 */
export async function hasHeldSessionReplies(
  db: Pick<Prisma.TransactionClient, 'sessionRequest'>,
  sessionId: string,
): Promise<boolean> {
  const held = await db.sessionRequest.findFirst({
    where: { fromSessionId: sessionId, state: { not: 'OPEN' }, replyClientTurnId: null },
    select: { id: true },
  });
  return held != null;
}

/**
 * How long a claim (`retry_claimed_at`) is believed: its lease. The sweep writes the turn it claimed
 * the retry for in the next transaction — seconds, even with attachments to copy — so a claim older
 * than this is one whose writer died between the two, and that session is not coming back on its own:
 * believing it anyway would hold an outcome for a turn that will never be handed, and say nothing on
 * the task. Both ends keep to it. Readers stop believing a claim past it, the re-send is written only
 * inside it (`AutoRetryService.whileClaimHeld`), and the sweep gives up a claim that outlived it
 * (`AutoRetryService.releaseExpiredClaims`, §8 criterion 24) — in a statement migration 0352's trigger
 * reads as the retry given up, which is what hands over whatever was held for it.
 */
export const RETRY_CLAIM_WINDOW_MS = 10 * 60_000;

/**
 * §4.3, §8 criteria 17 and 20: a session a transient failure stopped — the provider failed its turn, or
 * its quota ran out and it parked idle — with an auto-retry armed, or with one the sweep has CLAIMED
 * and not yet re-sent. It has NOT ended: the retry re-sends the turn that failed, and an outcome of its
 * own requests is said on that turn. Nor is it to be handed a reply turn of its own meanwhile: a new
 * turn disarms the retry (`createTurn`), and the message the failure killed would never be re-sent. The
 * shapes the auto-retry sweep re-sends from (its `due`), read off one row.
 *
 * The claim is the one that needs saying: the claim clears `retry_at` in the same statement that spends
 * an attempt, and the re-sent turn is written a moment later — in between, the row looks exactly like a
 * retry that was given up (`retry_at` NULL, still parked). Reading that window as "ended" wrote the
 * asker's task a comment saying its request would never be answered, and then the retry's turn said the
 * outcome as well: told twice, and once wrongly.
 */
export function awaitsAutoRetry(
  session: {
    status: string;
    retryAt: Date | null;
    retryClaimedAt: Date | null;
    cancelRequestedAt: Date | null;
    completedAt: Date | null;
    archivedAt: Date | null;
    deletedAt: Date | null;
  },
  now: Date = new Date(),
): boolean {
  if (session.deletedAt || session.completedAt || session.archivedAt) return false;
  const parked = session.status === 'FAILED'
    || (session.status === 'AWAITING_INPUT' && session.cancelRequestedAt == null);
  if (!parked) return false;
  if (session.retryAt != null) return true;
  return session.retryClaimedAt != null && now.getTime() - session.retryClaimedAt.getTime() < RETRY_CLAIM_WINDOW_MS;
}

/**
 * §8 criterion 17: the outcomes a turn of this session carried, when a transient failure killed the turn
 * and parked the session idle with a retry armed — a quota ran out. The turn is answered (the failure is
 * its reply), but its engine never got to read what it said, so its outcomes are held for the retry's
 * turn as a failed turn's are (`settleUnrunSessionRequests`'s `failedTurnKey`). Without this they stay on
 * an answered turn, the sweep finds nothing held to re-send a reply turn with, and gives the retry up.
 *
 * Called by runnerApi.turnComplete, in the transaction that parks the session, under its lock.
 */
export async function holdTurnRepliesForRetry(
  tx: Prisma.TransactionClient,
  sessionId: string,
  clientTurnId: string,
): Promise<void> {
  await tx.sessionRequest.updateMany({
    where: { fromSessionId: sessionId, replyClientTurnId: clientTurnId },
    data: { replyClientTurnId: null, replyHeldAt: new Date() },
  });
}

/** The re-sent reply turn found nothing left to say: another turn of the session took the outcomes first. */
export class NothingHeldToResend extends Error {}

/**
 * The auto-retry sweep's re-send of a failed reply turn takes the outcomes it is re-sent for, in the
 * transaction that writes it (`createTurn` / `resume`'s `onTurnWritten`, under the asker's lock) —
 * which is also what makes it a reply turn the hand-off merges into while it waits. The sweep decided
 * to re-send it on a read taken before its claim and outside any transaction; another turn of the
 * session delivered in between says the held outcomes itself, and a reply turn written anyway would be
 * delivered with nothing in it. So none left throws, and the turn rolls back with it.
 */
export async function attachHeldReplies(
  tx: Prisma.TransactionClient,
  sessionId: string,
  clientTurnId: string,
): Promise<void> {
  const { count } = await tx.sessionRequest.updateMany({
    where: { fromSessionId: sessionId, state: { not: 'OPEN' }, replyClientTurnId: null },
    data: { replyClientTurnId: clientTurnId, replyCommentDueAt: null },
  });
  if (count === 0) {
    throw new NothingHeldToResend(`session ${sessionId} has no outcome left for a re-sent reply turn to say`);
  }
}

/**
 * EXPIRED (§4): the deadline passed with the request still OPEN. `excerpt` and `closeReason` are the
 * recipient as it stood: what it last said, and its state. A compare-and-set like every other
 * outcome, so an answer that lands first stands. Answers whether this call wrote it.
 */
export async function expireSessionRequest(
  tx: Prisma.TransactionClient,
  requestId: string,
  now: Date,
): Promise<boolean> {
  const request = await tx.sessionRequest.findUnique({
    where: { id: requestId },
    select: { state: true, replyBy: true, toSessionId: true },
  });
  if (!request || request.state !== 'OPEN' || request.replyBy > now) return false;
  const recipient = await tx.session.findUnique({
    where: { id: request.toSessionId },
    select: {
      status: true, endReason: true, completedAt: true, archivedAt: true, deletedAt: true, lastAssistantText: true,
    },
  });
  const { count } = await tx.sessionRequest.updateMany({
    where: { id: requestId, state: 'OPEN', replyBy: { lte: now } },
    data: {
      state: 'EXPIRED',
      excerpt: recipient?.lastAssistantText ?? null,
      closeReason: recipient ? deriveSessionState({ ...recipient, status: recipient.status }) : 'GONE',
      closedAt: now,
    },
  });
  return count === 1;
}

// ── handing an outcome back ───────────────────────────────────────────────────────────────────────

/** An outcome was handed back, or held, by another pass before this one reached it. */
export class SessionReplyHandedOff extends Error {}

/**
 * The asker's reply turn nobody has been handed yet on this route, if there is one: the queued
 * next-turn reply turn, or — for an outcome going into the turn the asker is running — a reply steer
 * still waiting for that same turn. Never the other route's, as `undeliveredWakeTurn` keeps a wake's:
 * an outcome joining a queued reply turn would wait for the next turn after all, and one joining a
 * steer would be written into a turn it was not routed to. A steer the runner has taken, or the engine
 * has acknowledged, is no longer PENDING, so a later outcome is a steer of its own.
 *
 * Read under the Session lock `createTurn` holds: every door that hands a turn out or takes a queued
 * one away takes that same lock first.
 */
export function undeliveredReplyTurn(
  tx: Prisma.TransactionClient,
  sessionId: string,
  route: { kind: string; targetTurnId?: string } = { kind: 'message' },
): Promise<ConversationTurn | null> {
  return tx.conversationTurn.findFirst({
    where: {
      sessionId,
      ...(route.kind === 'steer'
        ? { kind: 'steer', sendIntent: 'CURRENT_WORK', targetTurnId: route.targetTurnId }
        : { kind: 'message' }),
      status: 'PENDING',
      clientTurnId: { startsWith: SESSION_REPLY_TURN_PREFIX },
    },
    orderBy: { seq: 'asc' },
  });
}

/**
 * Fold every other queued next-turn reply turn into the reply turn a missed steer just became.
 *
 * A reply steer whose turn ended before the engine read it is put back in the queue as an ordinary
 * next-turn message, on the same row and still carrying its outcomes (`requeueUnreadCurrentWorkSteers`
 * at the target's completion, or the runner's `steer_requeue`). An outcome that arrived meanwhile for
 * the next turn — the running turn's lease was running out, say — is queued on a reply turn of its
 * own, so without this the two would each open a turn, back to back, to say what one turn says.
 *
 * The requeued row is the one kept, so every outcome it carried still names the turn that delivers it:
 * it may already have a `user` event in the transcript, and its re-delivery amends that line. A queued
 * reply turn nobody was handed hands its outcomes over and goes, as a withdrawn one would. One already
 * in the transcript (handed out once, and back unanswered) is left as it is: deleting it would strand
 * the line drawn for it. So is one a steer is still aimed at, which the row's own foreign key keeps.
 * `foldQueuedWakeTurnsInto` is the same fold for a background job's wakes.
 *
 * Under the Session lock its caller holds, in the transaction that requeued the steer.
 */
export async function foldQueuedReplyTurnsInto(
  tx: Prisma.TransactionClient,
  sessionId: string,
  kept: { id: string; clientTurnId: string },
): Promise<number> {
  if (!isSessionReplyTurn(kept.clientTurnId)) return 0;
  const queued = await tx.conversationTurn.findMany({
    where: {
      sessionId,
      id: { not: kept.id },
      kind: 'message',
      status: 'PENDING',
      clientTurnId: { startsWith: SESSION_REPLY_TURN_PREFIX },
      targetedTurns: { none: {} },
    },
    select: { id: true, clientTurnId: true },
    orderBy: { seq: 'asc' },
  });
  if (queued.length === 0) return 0;
  const shown = new Set((await tx.runEvent.findMany({
    where: { sessionId, type: RunEventType.USER, turnId: { in: queued.map((turn) => turn.id) } },
    select: { turnId: true },
  })).map((event) => event.turnId));
  const others = queued.filter((turn) => !shown.has(turn.id));
  for (const other of others) {
    await tx.sessionRequest.updateMany({
      where: { fromSessionId: sessionId, replyClientTurnId: other.clientTurnId },
      data: { replyClientTurnId: kept.clientTurnId },
    });
    await tx.conversationTurn.deleteMany({ where: { id: other.id, sessionId, status: 'PENDING' } });
  }
  return others.length;
}

/**
 * `foldQueuedReplyTurnsInto` for the steers a turn's completion just requeued: the first of them that
 * is a reply turn keeps every other reply queued for the next turn, the other requeued ones included.
 */
export async function foldRequeuedReplyTurns(
  tx: Prisma.TransactionClient,
  sessionId: string,
  requeuedTurnIds: readonly string[],
): Promise<void> {
  const kept = await tx.conversationTurn.findFirst({
    where: { sessionId, id: { in: [...requeuedTurnIds] }, clientTurnId: { startsWith: SESSION_REPLY_TURN_PREFIX } },
    select: { id: true, clientTurnId: true },
    orderBy: { seq: 'asc' },
  });
  if (kept) await foldQueuedReplyTurnsInto(tx, sessionId, kept);
}

/**
 * A reply steer the runner could not write into the running turn, settled FAILED with no
 * acknowledgement (runnerApi.turnComplete, as the steer settles): no engine confirmed reading what it
 * carries — the platform's reading of an unconfirmed steer, as `closeUnreadSteerRequests` reads one
 * for the requests a steer carries. Left on that row they are on a turn nothing will deliver, and the
 * asker has not stopped, so nothing holds them for a later turn either: they are let go, on no turn and
 * not held, and the request worker hands them back on its next pass (`SessionRequestService.handOff`)
 * — into the running turn if it can still take one, else as the next turn's reply turn. The worker's
 * pass, and not this completion, is what hands them back: a runtime refusing every steer would
 * otherwise be handed a new one as fast as it can refuse it.
 *
 * Under the asker's Session lock, which the steer's completion holds.
 */
export async function releaseUnreadSteerReplies(
  tx: Prisma.TransactionClient,
  sessionId: string,
  clientTurnId: string,
): Promise<void> {
  if (!isSessionReplyTurn(clientTurnId)) return;
  await tx.sessionRequest.updateMany({
    where: { fromSessionId: sessionId, replyClientTurnId: clientTurnId },
    data: { replyClientTurnId: null, replyHeldAt: null },
  });
}

/**
 * File one outcome onto the reply turn that will deliver it, inside that turn's transaction (the
 * `coalesce` hook of `createTurn`): either both are written or neither is. An outcome already handed
 * back or held throws, which rolls the turn back with it — the compare-and-set that makes a hand-off
 * happen once however many passes reach it.
 */
export async function attachReplyToTurn(
  tx: Prisma.TransactionClient,
  requestId: string,
  clientTurnId: string,
): Promise<void> {
  const { count } = await tx.sessionRequest.updateMany({
    where: { id: requestId, state: { not: 'OPEN' }, replyClientTurnId: null, replyHeldAt: null },
    data: { replyClientTurnId: clientTurnId },
  });
  if (count !== 1) throw new SessionReplyHandedOff(`session request ${requestId} was already handed back`);
}

/** The asker had ended (§4.3): the outcome stays on the row, held for its next turn. False when another pass got there first. */
export async function holdReply(
  db: Pick<Prisma.TransactionClient, 'sessionRequest'>,
  requestId: string,
): Promise<boolean> {
  const { count } = await db.sessionRequest.updateMany({
    where: { id: requestId, state: { not: 'OPEN' }, replyClientTurnId: null, replyHeldAt: null },
    data: { replyHeldAt: new Date() },
  });
  return count === 1;
}

/**
 * Write the outcomes a turn of the asking session carries into what it is handed — the reply turn's
 * own, and any held for it: an outcome kept on its row because the asker had ended or its reply turn
 * was dropped is added to whichever turn of the asker is handed out next, and from then on rides on
 * that turn (`reply_client_turn_id`), so a re-delivery of it says it again and no other turn does.
 *
 * Called at delivery for every message turn, outside the first-delivery branch: a reply turn handed
 * out again after its runner died still has to say what it is for. And for a reply steer, whose blocks
 * say they joined the turn the asker is in (`turnKind`). Throws on a database failure: for a reply
 * turn this block IS the turn, and the claim rolls back and leaves it queued.
 */
export async function appendSessionRepliesContext(
  tx: Prisma.TransactionClient,
  sessionId: string,
  clientTurnId: string,
  content: string | null | undefined,
  turnKind: string = 'message',
): Promise<string | null | undefined> {
  // Held outcomes join this turn — and so does one whose hand-off has not run yet: it is said now,
  // and the hand-off finds it already on a turn. Every path that takes a reply turn off the queue
  // unrun lets its outcomes go first (`settleUnrunSessionRequests`), so none is left on a turn that
  // will never be delivered. Said here, it is owed no comment on the asker's task any more.
  await tx.sessionRequest.updateMany({
    where: { fromSessionId: sessionId, state: { not: 'OPEN' }, replyClientTurnId: null },
    data: { replyClientTurnId: clientTurnId, replyCommentDueAt: null },
  });
  const carried = await tx.sessionRequest.findMany({
    where: { fromSessionId: sessionId, replyClientTurnId: clientTurnId },
  });
  if (carried.length === 0) return content;
  // In the order the outcomes arrived, ordered here rather than trusted from the read.
  carried.sort((a, b) => (a.closedAt?.getTime() ?? 0) - (b.closedAt?.getTime() ?? 0) || a.id.localeCompare(b.id));
  const recipients = await recipientsOf(tx, carried);
  const blocks = carried.map((request) => sessionReplyBlock(request, recipients.get(request.toSessionId) ?? null, turnKind));
  const block = blocks.join('\n\n');
  return content ? `${content}\n\n${block}` : block;
}

/**
 * What a queued reply turn will be delivered with, read without writing anything: the queue view a
 * client draws before the runner takes the turn (`SessionsService.listQueuedTurns`). Empty when no
 * outcome is on it. In the turn's own kind, as the claim writes it: a steer's blocks say which turn
 * they join.
 */
export async function queuedRepliesContent(
  db: Pick<Prisma.TransactionClient, 'sessionRequest' | 'session'>,
  sessionId: string,
  clientTurnId: string,
  turnKind: string = 'message',
): Promise<string> {
  const carried = await db.sessionRequest.findMany({
    where: { fromSessionId: sessionId, replyClientTurnId: clientTurnId },
  });
  if (carried.length === 0) return '';
  carried.sort((a, b) => (a.closedAt?.getTime() ?? 0) - (b.closedAt?.getTime() ?? 0) || a.id.localeCompare(b.id));
  const recipients = await recipientsOf(db, carried);
  return carried
    .map((request) => sessionReplyBlock(request, recipients.get(request.toSessionId) ?? null, turnKind))
    .join('\n\n');
}

/** The recipient sessions of these requests, by id: what a block and a card name them by. */
async function recipientsOf(
  db: Pick<Prisma.TransactionClient, 'session'>,
  requests: Array<Pick<SessionRequest, 'toSessionId' | 'ownerId'>>,
): Promise<Map<string, { id: string; title: string }>> {
  if (requests.length === 0) return new Map();
  const rows = await db.session.findMany({
    where: { id: { in: [...new Set(requests.map((request) => request.toSessionId))] }, ownerId: requests[0].ownerId },
    select: { id: true, title: true },
  });
  return new Map(rows.map((row) => [row.id, row]));
}

/** What took an UNDELIVERED request off the recipient's queue, as the asker is told it. */
const UNDELIVERED_BECAUSE: Record<string, string> = {
  INTERRUPTED: '这条请求没有送到：对方被打断时它还在队列里，随队列一起被清掉了。对方从没看到它。',
  WITHDRAWN: '这条请求没有送到：它还在对方的队列里时，被账号 owner 撤回了。对方从没看到它。',
  DRAINED: '这条请求没有送到：对方正在跑的那一轮失败了，排队中的消息随队列一起被清掉（平台会重试失败的那一轮，但不会重发这条请求）。对方从没看到它。',
  STEER_UNCONFIRMED: '这条请求没有送到：它本要插进对方正在跑的那一轮，但对方的引擎没有确认收到它——没能写进去，或者那一轮在它送达前就结束了。对方很可能没看到它，需要的话请重新发送。',
  NOT_RESENT: '这条请求没有送到：承载它的那一轮在对方的引擎收到它之前就失败了，之后对方的会话由另一条消息接着跑下去，失败的那一轮不会再重发。对方从没看到它，需要的话请重新发送。',
  LOST_IN_FLIGHT: '这条请求没有送到：对方的 runner 领走它之后，那一轮随对方的 run 一起结束了，平台的自动重试找不回这一轮，不会重发它。需要的话请重新发送。',
};

/**
 * The line a reply block opens with when a steer delivers it — what background-job-wake.ts's
 * `WAKE_HEADS` says for a steered wake: the asker is working, so the outcome joined the turn it is in,
 * and no turn was opened for it. Said of every outcome the steer carries, a held one that rides along
 * included (`appendSessionRepliesContext`). A reply turn of its own says nothing of the kind: the
 * blocks are all that turn is.
 */
const STEERED_REPLY_HEAD = '你正在工作，所以这条回信加进了你当前这一轮，没有为它另开一轮。';

/**
 * §4.2: one outcome, as the asker reads it. `turnKind` is the delivering turn's: a steer's block says
 * it joined the turn the asker is in.
 */
export function sessionReplyBlock(
  request: SessionRequest,
  recipient: { id: string; title: string } | null,
  turnKind: string = 'message',
): string {
  const attributes = [
    `request-id="${uuidToBase62(request.id)}"`,
    `from-session="${uuidToBase62(request.toSessionId)}"`,
    `from-title="${attribute(recipient?.title ?? '')}"`,
    `outcome="${request.state}"`,
  ];
  const lines = [...(turnKind === 'steer' ? [STEERED_REPLY_HEAD] : []), `你问的是：${request.requestPreview}`];
  const options = readStoredOptions(request.options);
  const excerpt = request.excerpt ? clip(request.excerpt, EXCERPT_BLOCK_CHARS) : null;
  switch (request.state) {
    case 'REPLIED':
      if (request.replyOption != null) {
        const chosen = options?.[request.replyOption];
        lines.push(`选择：${request.replyOption}. ${chosen?.label ?? ''}`.trimEnd());
      }
      if (request.replyText) lines.push(`回复：${request.replyText}`);
      break;
    case 'NO_REPLY':
      lines.push('对方空闲下来时没有回复（NO_REPLY）。下面是它最后一段输出，不是正式回复：');
      lines.push(excerpt ?? '（没有输出）');
      break;
    case 'RECIPIENT_ENDED':
      lines.push(`对方的会话已经结束（${request.closeReason ?? 'ENDED'}），没有回复。下面是它最后一段输出，不是正式回复：`);
      lines.push(excerpt ?? '（没有输出）');
      break;
    case 'EXPIRED':
      lines.push(
        `到截止时间 ${isoSeconds(request.replyBy)} 仍未回复（EXPIRED）。对方当时的状态：${request.closeReason ?? '未知'}。`
        + '下面是它当时最后一段输出，不是正式回复：',
      );
      lines.push(excerpt ?? '（没有输出）');
      break;
    case 'UNDELIVERED':
      lines.push(UNDELIVERED_BECAUSE[request.closeReason ?? ''] ?? UNDELIVERED_BECAUSE.INTERRUPTED);
      break;
  }
  return [
    `<orbit-session-reply ${attributes.join(' ')}>`,
    ...lines,
    '</orbit-session-reply>',
  ].join('\n');
}

/**
 * The cards the `user` events of the asking session are stored with, by the key of the turn each
 * echoes: one card per outcome that turn carried, read when the runner's echo is stored. A turn that
 * carried none is absent from the map, and a batch of ordinary messages costs one indexed read.
 */
export async function readSessionReplyCards(
  db: Pick<Prisma.TransactionClient, 'sessionRequest' | 'session'>,
  sessionId: string,
  clientTurnIds: readonly string[],
): Promise<Map<string, SessionReplyCard[]>> {
  const cards = new Map<string, SessionReplyCard[]>();
  if (clientTurnIds.length === 0) return cards;
  const carried = await db.sessionRequest.findMany({
    where: { fromSessionId: sessionId, replyClientTurnId: { in: [...new Set(clientTurnIds)] } },
  });
  if (carried.length === 0) return cards;
  carried.sort((a, b) => (a.closedAt?.getTime() ?? 0) - (b.closedAt?.getTime() ?? 0) || a.id.localeCompare(b.id));
  const recipients = await recipientsOf(db, carried);
  for (const request of carried) {
    const key = request.replyClientTurnId!;
    cards.set(key, [...(cards.get(key) ?? []), sessionReplyCard(request, recipients.get(request.toSessionId) ?? null)]);
  }
  return cards;
}

/** One outcome as the asker's card shows it: a snapshot, because an outcome never changes. */
function sessionReplyCard(request: SessionRequest, recipient: { title: string } | null): SessionReplyCard {
  const options = readStoredOptions(request.options);
  return {
    requestId: uuidToBase62(request.id),
    outcome: request.state as SessionRequestOutcome,
    fromSessionId: request.toSessionId,
    fromTitle: recipient?.title ?? '',
    requestTurnId: request.turnId,
    requestPreview: request.requestPreview,
    ...(request.replyText != null ? { replyText: request.replyText } : {}),
    ...(request.replyOption != null
      ? { replyOption: request.replyOption, replyOptionLabel: options?.[request.replyOption]?.label ?? '' }
      : {}),
    ...(request.excerpt != null ? { excerpt: clip(request.excerpt, EXCERPT_BLOCK_CHARS) } : {}),
    ...(request.closeReason != null ? { closeReason: request.closeReason } : {}),
    ...(request.closedAt ? { closedAt: request.closedAt.toISOString() } : {}),
  };
}

/** The requests these turns of a recipient carry, by turn id: what its `sessionMessage` cards name. */
export async function readTurnRequestIds(
  db: Pick<Prisma.TransactionClient, 'sessionRequest'>,
  sessionId: string,
  turnIds: readonly string[],
): Promise<Map<string, string>> {
  if (turnIds.length === 0) return new Map();
  const rows = await db.sessionRequest.findMany({
    where: { toSessionId: sessionId, turnId: { in: [...new Set(turnIds)] } },
    select: { id: true, turnId: true },
  });
  return new Map(rows.map((row) => [row.turnId, row.id]));
}

/** A request as the clients read it: `GET /session-requests/:id` and the session's own list. */
export async function readSessionRequestView(
  db: Pick<Prisma.TransactionClient, 'sessionRequest' | 'session'>,
  ownerId: string,
  requestId: string,
): Promise<SessionRequestView | null> {
  const request = await db.sessionRequest.findFirst({ where: { id: requestId, ownerId } });
  if (!request) return null;
  const sessions = await db.session.findMany({
    where: { id: { in: [request.fromSessionId, request.toSessionId] }, ownerId },
    select: { id: true, title: true },
  });
  const titleOf = (id: string) => sessions.find((session) => session.id === id)?.title ?? '';
  return {
    requestId: uuidToBase62(request.id),
    state: request.state as SessionRequestView['state'],
    fromSessionId: request.fromSessionId,
    fromTitle: titleOf(request.fromSessionId),
    toSessionId: request.toSessionId,
    toTitle: titleOf(request.toSessionId),
    requestPreview: request.requestPreview,
    ...(readStoredOptions(request.options) ? { replyOptions: readStoredOptions(request.options)! } : {}),
    replyBy: request.replyBy.toISOString(),
    createdAt: request.createdAt.toISOString(),
    ...(request.closedAt ? { closedAt: request.closedAt.toISOString() } : {}),
    ...(request.replyText != null ? { replyText: request.replyText } : {}),
    ...(request.replyOption != null ? { replyOption: request.replyOption } : {}),
    ...(request.excerpt != null ? { excerpt: clip(request.excerpt, EXCERPT_BLOCK_CHARS) } : {}),
    ...(request.closeReason != null ? { closeReason: request.closeReason } : {}),
  };
}

/** Who a session is waiting on for a reply, and who is waiting on it: its list row's two lists. */
export interface OpenRequestPeers {
  awaitingReplyFrom: SessionRequestPeer[];
  owesReplyTo: SessionRequestPeer[];
}

/**
 * §6: for each of these sessions, the requests still OPEN on it — the sessions it asked and is waiting
 * on, and the sessions that asked it and are waiting on it — so a list shows who is waiting on whose
 * reply. Every session asked about is in the answer, with empty lists when nothing is open, because an
 * empty list is how a row that was showing one learns it cleared.
 */
export async function readOpenRequestPeers(
  db: Pick<Prisma.TransactionClient, 'sessionRequest' | 'session'>,
  ownerId: string,
  sessionIds: readonly string[],
): Promise<Map<string, OpenRequestPeers>> {
  const peers = new Map<string, OpenRequestPeers>(
    sessionIds.map((id) => [id, { awaitingReplyFrom: [], owesReplyTo: [] }]),
  );
  if (sessionIds.length === 0) return peers;
  const ids = [...new Set(sessionIds)];
  const open = await db.sessionRequest.findMany({
    where: { ownerId, state: 'OPEN', OR: [{ fromSessionId: { in: ids } }, { toSessionId: { in: ids } }] },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, fromSessionId: true, toSessionId: true },
  });
  if (open.length === 0) return peers;
  const titles = new Map((await db.session.findMany({
    where: { ownerId, id: { in: [...new Set(open.flatMap((request) => [request.fromSessionId, request.toSessionId]))] } },
    select: { id: true, title: true },
  })).map((session) => [session.id, session.title]));
  for (const request of open) {
    const requestId = uuidToBase62(request.id);
    peers.get(request.fromSessionId)?.awaitingReplyFrom.push({
      requestId, sessionId: request.toSessionId, title: titles.get(request.toSessionId) ?? '',
    });
    peers.get(request.toSessionId)?.owesReplyTo.push({
      requestId, sessionId: request.fromSessionId, title: titles.get(request.fromSessionId) ?? '',
    });
  }
  return peers;
}

// ── small things ──────────────────────────────────────────────────────────────────────────────────

/** The options as stored, or null when the request offered none. */
export function readStoredOptions(value: Prisma.JsonValue | null | undefined): ReplyOption[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.map((option) => {
    const record = (option ?? {}) as Record<string, unknown>;
    return {
      label: String(record.label ?? ''),
      ...(typeof record.description === 'string' ? { description: record.description } : {}),
    };
  });
}

/** The first `REQUEST_PREVIEW_CHARS` characters (code points, so no pair is cut in half). */
function preview(text: string): string {
  return clip(stripNul(text).trim(), REQUEST_PREVIEW_CHARS);
}

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…`;
}

/** An instant to the second, as the blocks write one: `2026-10-02T09:30:00Z`. */
export function isoSeconds(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Postgres stores no U+0000 (runner-api/strip-nul.ts). */
function stripNul(text: string): string {
  return text.replace(/\u0000/g, '');
}
