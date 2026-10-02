import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, type ConversationTurn, type SessionRequest } from '@prisma/client';
import {
  deriveSessionState,
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
 *                    migration 0347's trigger, in the statement that ended it, whichever path that was;
 *   EXPIRED          `replyBy` passed (`expireSessionRequest`, the worker);
 *   UNDELIVERED      the turn carrying it was taken off the recipient's queue before any engine read
 *                    it — an interrupt dropping the queue, the owner withdrawing it
 *                    (`settleUnrunSessionRequests`).
 *
 * Migration 0347's guard refuses any later rewrite of an outcome, so "first wins" is the database's
 * rule and not only this file's.
 *
 * HANDED BACK ONCE. An outcome is handed to the asker on a `session-reply:` turn of its conversation
 * (`SessionRequestService.handOff`): queued like any other turn, NEXT_TURN, with no words of its own —
 * the outcomes are kept beside it on their rows (`reply_client_turn_id`) and written in at delivery
 * (`appendSessionRepliesContext`), exactly as a background job's wake is. Outcomes that arrive while
 * that turn is still queued join it, so five workers answering at once wake the asker once. An asker
 * that has ended is not revived for it (§4.3): the outcome is held on the row, and a comment goes on
 * the task the asker ran. An asker interrupted with the reply turn still queued loses that turn with
 * the rest of its queue — stopping means stopping — and the outcome is held the same way. Either way a
 * held outcome is written into the next turn the asker IS handed, so none is lost.
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
 * §4.1: whether a session still has something that will wake it by itself — and so may yet answer.
 * Any one of the five keeps the requests waiting on it OPEN; with none of them, a request it received
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
 *   4. a request of its own still OPEN — the answer to it will come back as a turn;
 *   5. a question it asked the owner AS the project's coordinator (`ask_owner`) still OPEN. The answer
 *      goes to whichever session coordinates the project when it comes, so a question asked by a
 *      conversation that has since been rotated out wakes it no more.
 */
export async function hasPendingWakeSource(
  tx: Prisma.TransactionClient,
  session: { id: string; runningBgJobs: readonly string[] },
): Promise<boolean> {
  const sessionId = session.id;
  const watch = await tx.watch.findFirst({
    where: { observerSessionId: sessionId, action: 'RESUME_SESSION', state: 'ACTIVE' },
    select: { id: true },
  });
  if (watch) return true;
  if (session.runningBgJobs.length > 0) return true;
  const wakeup = await tx.sessionScheduledWakeup.findFirst({
    where: { sessionId, state: 'PENDING' },
    select: { id: true },
  });
  if (wakeup) return true;
  const asked = await tx.sessionRequest.findFirst({
    where: { fromSessionId: sessionId, state: 'OPEN' },
    select: { id: true },
  });
  if (asked) return true;
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
 * the turn carrying it was handed to an engine — is closed with what it last said, unless something
 * will still wake it (`hasPendingWakeSource`). A request still queued has not been read and is not
 * judged. Answers the requests this closed, for the asker's hand-off once the transaction commits.
 */
export async function closeUnansweredRequests(
  tx: Prisma.TransactionClient,
  session: { id: string; runningBgJobs: readonly string[]; lastAssistantText: string | null },
): Promise<string[]> {
  const open = await tx.sessionRequest.findMany({
    where: { toSessionId: session.id, state: 'OPEN' },
    select: { id: true, turnId: true },
  });
  if (open.length === 0) return [];
  const received = new Set((await tx.conversationTurn.findMany({
    where: { sessionId: session.id, id: { in: open.map((request) => request.turnId) }, deliveredAt: { not: null } },
    select: { id: true },
  })).map((turn) => turn.id));
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
   * The session's run is ending and its queue is drained. `closesRequests` is true where the status
   * write that ends the run has ALREADY happened in this transaction (a failed turn, the runner's
   * finalize, the reaper): migration 0347's trigger has closed every request the end closes, so what
   * is still OPEN here is a run that goes on (a retry is armed), and a request in its queue was never
   * read. It is false where the drain comes before the status write (`transitionEnd`), whose end the
   * trigger reads as RECIPIENT_ENDED once it is written — which the contract says wins (§4).
   */
  | { code: 'SESSION_ENDED'; closesRequests: boolean };

/**
 * What rides on the turns about to be taken off a session's queue unrun (§4, §4.3). Called beside
 * `deadLetterQueuedWatchWakes` and `returnQueuedTurns` — under the session lock, before the turns are
 * deleted or retired, in the same transaction, so a refusal further down rolls this back too.
 *
 * Two kinds of turn are taken. A REQUEST another session queued here was never read: it is closed
 * UNDELIVERED, with what took it. A REPLY turn of this session as an asker carried outcomes back to
 * it, and those outcomes are not lost with it. When the session lives on — interrupted, or the owner
 * withdrew the turn — they are held on their rows for the next turn it is handed: stopping means
 * stopping, so no new reply turn is queued for them. When its run is ending they are let go again,
 * and the hand-off finds an asker that has ended, holds them and writes on its task (§4.3).
 */
export async function settleUnrunSessionRequests(
  tx: Prisma.TransactionClient,
  sessionId: string,
  unrun: UnrunSessionRequests,
): Promise<void> {
  const unrunTurns = await tx.conversationTurn.findMany({
    where: {
      sessionId,
      kind: { in: ['message', 'steer'] },
      status: 'PENDING',
      ...(unrun.code === 'TURN_WITHDRAWN' ? { id: unrun.turnId } : {}),
    },
    select: { id: true, clientTurnId: true },
  });
  if (unrunTurns.length === 0) return;
  const replyTurns = unrunTurns.filter((turn) => isSessionReplyTurn(turn.clientTurnId)).map((turn) => turn.clientTurnId);
  if (replyTurns.length > 0) {
    await tx.sessionRequest.updateMany({
      where: { fromSessionId: sessionId, replyClientTurnId: { in: replyTurns } },
      data: { replyClientTurnId: null, replyHeldAt: unrun.code === 'SESSION_ENDED' ? null : new Date() },
    });
  }
  if (unrun.code === 'SESSION_ENDED' && !unrun.closesRequests) return;
  await tx.sessionRequest.updateMany({
    where: { toSessionId: sessionId, turnId: { in: unrunTurns.map((turn) => turn.id) }, state: 'OPEN' },
    data: {
      state: 'UNDELIVERED',
      closeReason: unrun.code === 'TURN_INTERRUPTED' ? 'INTERRUPTED' : unrun.code === 'TURN_WITHDRAWN' ? 'WITHDRAWN' : 'DRAINED',
      closedAt: new Date(),
    },
  });
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
 * The asker's reply turn nobody has been handed yet, if there is one. Read under the Session lock
 * `createTurn` holds, as `undeliveredWakeTurn` reads the wake turn: every door that hands a turn out
 * or takes a queued one away takes that same lock first.
 */
export function undeliveredReplyTurn(
  tx: Prisma.TransactionClient,
  sessionId: string,
): Promise<ConversationTurn | null> {
  return tx.conversationTurn.findFirst({
    where: {
      sessionId,
      kind: 'message',
      status: 'PENDING',
      clientTurnId: { startsWith: SESSION_REPLY_TURN_PREFIX },
    },
    orderBy: { seq: 'asc' },
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
 * out again after its runner died still has to say what it is for. Throws on a database failure: for
 * a reply turn this block IS the turn, and the claim rolls back and leaves it queued.
 */
export async function appendSessionRepliesContext(
  tx: Prisma.TransactionClient,
  sessionId: string,
  clientTurnId: string,
  content: string | null | undefined,
): Promise<string | null | undefined> {
  // Held outcomes join this turn — and so does one whose hand-off has not run yet: it is said now,
  // and the hand-off finds it already on a turn. Every path that takes a reply turn off the queue
  // unrun lets its outcomes go first (`settleUnrunSessionRequests`), so none is left on a turn that
  // will never be delivered.
  await tx.sessionRequest.updateMany({
    where: { fromSessionId: sessionId, state: { not: 'OPEN' }, replyClientTurnId: null },
    data: { replyClientTurnId: clientTurnId },
  });
  const carried = await tx.sessionRequest.findMany({
    where: { fromSessionId: sessionId, replyClientTurnId: clientTurnId },
  });
  if (carried.length === 0) return content;
  // In the order the outcomes arrived, ordered here rather than trusted from the read.
  carried.sort((a, b) => (a.closedAt?.getTime() ?? 0) - (b.closedAt?.getTime() ?? 0) || a.id.localeCompare(b.id));
  const recipients = await recipientsOf(tx, carried);
  const blocks = carried.map((request) => sessionReplyBlock(request, recipients.get(request.toSessionId) ?? null));
  const block = blocks.join('\n\n');
  return content ? `${content}\n\n${block}` : block;
}

/**
 * What a queued reply turn will be delivered with, read without writing anything: the queue view a
 * client draws before the runner takes the turn (`SessionsService.listQueuedTurns`). Empty when no
 * outcome is on it.
 */
export async function queuedRepliesContent(
  db: Pick<Prisma.TransactionClient, 'sessionRequest' | 'session'>,
  sessionId: string,
  clientTurnId: string,
): Promise<string> {
  const carried = await db.sessionRequest.findMany({
    where: { fromSessionId: sessionId, replyClientTurnId: clientTurnId },
  });
  if (carried.length === 0) return '';
  carried.sort((a, b) => (a.closedAt?.getTime() ?? 0) - (b.closedAt?.getTime() ?? 0) || a.id.localeCompare(b.id));
  const recipients = await recipientsOf(db, carried);
  return carried.map((request) => sessionReplyBlock(request, recipients.get(request.toSessionId) ?? null)).join('\n\n');
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
};

/** §4.2: one outcome, as the asker reads it. */
export function sessionReplyBlock(request: SessionRequest, recipient: { id: string; title: string } | null): string {
  const attributes = [
    `request-id="${uuidToBase62(request.id)}"`,
    `from-session="${uuidToBase62(request.toSessionId)}"`,
    `from-title="${attribute(recipient?.title ?? '')}"`,
    `outcome="${request.state}"`,
  ];
  const lines = [`你问的是：${request.requestPreview}`];
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
