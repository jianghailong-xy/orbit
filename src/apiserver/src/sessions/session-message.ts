import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  uuidToBase62,
  type SessionMessageCard,
  type SessionReplyOption,
  type SessionRequestState,
} from '@orbit/shared';

/**
 * One Orbit session's message to another, and what the platform says about who sent it
 * (docs/session-request-reply-contract.md §2, P0).
 *
 * `session_send` (`POST /runner/sessions/:id/turns`) and `project_send`
 * (`POST /runner/projects/:id/coordinator/messages`) write a turn into somebody else's
 * conversation. Until this existed the turn was `{ clientTurnId, content }` and nothing else: the
 * recipient read another agent's words as the account owner's, a coordinator could not tell which
 * worker was speaking, and every client drew the message as the owner's own bubble.
 *
 * WHO SENT IT is `conversation_turn.sender_session_id`, written by those two doors and by the message
 * `session_interrupt` carries (`POST /runner/sessions/:id/interrupt`), from the session the
 * orchestration credential proved — never from a request body, so no caller can name somebody else as
 * the sender. Null is every other turn: the account owner, a headless credential, the platform's own
 * deliveries. The one exception is the platform's re-send of a failed message — the auto-retry sweep's,
 * or the failure card's Retry asking the server for it — which keeps the sender of the message it
 * re-sends (§2.1).
 *
 * It is said twice from that one column:
 *   - to the engine, as a block appended AFTER the message at delivery (`appendSessionMessageContext`),
 *     so `controlPlaneNoteOf` records it as the control plane's note and not as the sender's words;
 *   - to the clients, as the card stored beside the runner's echo (`readSessionMessageCard`).
 * The limit counts what one session sent another in the last hour from a record of its own, written as
 * each message is sent (`chargeSessionMessage`).
 */

/**
 * §2.4: the most messages one session may send ONE other session in any rolling hour — ordinary
 * messages and, once they exist, requests together.
 *
 * A constant, not a setting. An agent's turn takes minutes, so collaboration does not come near 20
 * in an hour; the loop this exists for — "how is it going" / "still working" — goes round in a minute
 * or two. Before it, nothing bounded a free session talking to another: `maxCoordinatorSteers` only
 * charges a session that runs a task attempt (`SessionAttemptService#chargeSteer`).
 */
export const SESSION_MESSAGES_PER_PAIR_PER_HOUR = 20;

/** The rolling hour §2.4 counts over. */
const SESSION_MESSAGE_WINDOW_MS = 60 * 60 * 1000;

export const SESSION_MESSAGE_RATE_LIMITED_CODE = 'SESSION_MESSAGE_RATE_LIMITED';

/** A refusal of its own class, so `project_send` can let it through as itself rather than as a
 *  delivery that failed (`ProjectsService#sendToCoordinator`). */
export class SessionMessageRateLimited extends ConflictException {}

/**
 * Charge one NEW message from `fromSessionId` to `toSessionId` against §2.4's hourly limit, or
 * refuse it.
 *
 * Called from `createTurn`'s `participateSendTransaction` — under the recipient's Session lock, after
 * idempotency and placement, before the turn is written — so a retry that replays a committed
 * `clientTurnId` never reaches it, and two sends to one session are counted one after the other.
 * `session_interrupt`'s message is charged the same way, from `interrupt`'s
 * `participateFollowUpTransaction`. A refusal rolls back with the turn it was for, so nothing a
 * refusal answered is counted.
 *
 * What is counted is what was SENT: a `session_message_charge` row written here for every message
 * admitted (migration 0351), and not the recipient's turns. A turn still queued is deleted when an
 * interrupt drops the queue or the owner withdraws it, and counted off the turns the hour went down
 * with it — queue a few messages, drop them with an interrupt that carries one more, and the pair
 * starts again. A row here is untouched by whatever happens to its message afterwards. The pair's rows
 * whose hour is over are dropped as it counts, so within the window the count only grows.
 *
 * Only the three session-to-session doors call it. A person's message, a headless credential's and the
 * platform's own deliveries carry no sender, are not counted, and are never refused here. Nor is a
 * re-send of a message that failed — the auto-retry sweep's, or the failure card's Retry asking the
 * server for it (§2.1): the words are still the sending session's, but the session did not send them
 * again, and neither re-send comes through here.
 */
export async function chargeSessionMessage(
  tx: Prisma.TransactionClient,
  fromSessionId: string,
  toSessionId: string,
): Promise<void> {
  // Counted the way the spawn-rate window counts its hour (`SessionsService` SPAWN_RATE_WINDOW_MS): a
  // Prisma DateTime against the column Prisma wrote.
  const windowStart = new Date(Date.now() - SESSION_MESSAGE_WINDOW_MS);
  const pair = { toSessionId, fromSessionId };
  await tx.sessionMessageCharge.deleteMany({ where: { ...pair, createdAt: { lte: windowStart } } });
  const sent = await tx.sessionMessageCharge.count({ where: pair });
  if (sent < SESSION_MESSAGES_PER_PAIR_PER_HOUR) {
    await tx.sessionMessageCharge.create({ data: pair });
    return;
  }
  throw new SessionMessageRateLimited({
    statusCode: 409,
    error: 'Conflict',
    code: SESSION_MESSAGE_RATE_LIMITED_CODE,
    message:
      `this session has already sent session ${uuidToBase62(toSessionId)} ${sent} messages in the `
      + `last hour, the most one session may send another. Asking it again will not make it finish `
      + `sooner: to wait for that session to finish its work, call session_await on it and end your `
      + `turn — you are woken when it is done`,
    retryable: false,
  });
}

/** What the block and the card are drawn from: the sending session as it stands now. */
interface Sender {
  id: string;
  title: string;
  taskId: string | null;
  workspace: { name: string } | null;
}

/** The sending session, within the recipient's own account — a sender is never anybody else's. */
function readSender(
  db: Pick<Prisma.TransactionClient, 'session'>,
  ownerId: string,
  senderSessionId: string,
): Promise<Sender | null> {
  return db.session.findFirst({
    where: { id: senderSessionId, ownerId },
    select: { id: true, title: true, taskId: true, workspace: { select: { name: true } } },
  });
}

/** The tag the block is written under. */
export const SESSION_MESSAGE_BLOCK_TAG = 'orbit-session-message';

/**
 * An attribute value as it can sit between double quotes: escaped, and on one line. A title is
 * anybody's text, and one holding a quote, a `<` or a newline would otherwise end the attribute, or
 * the block, early — and `describeNote` on every client reads the block's shape.
 */
export function attribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\s*[\r\n]+\s*/g, ' ');
}

/**
 * The request a message is, when its sender asked for a reply (session-request.ts) — what the block
 * says beside it so the recipient knows it is being waited on, how to answer and by when.
 */
export interface RequestForBlock {
  id: string;
  replyBy: Date;
  options: SessionReplyOption[] | null;
  state: SessionRequestState;
}

/**
 * §2.2: the block the engine reads after another session's message — and §3.3, the lines a request
 * adds to it: its id and deadline, how to answer, what happens when it is not answered, and the
 * options by index when it offered any. A request that already came to an outcome by the time its
 * message is read (it waited in the queue past its deadline) says so instead of asking for an answer
 * nobody can give any more.
 */
export function sessionMessageBlock(sender: Sender, request?: RequestForBlock | null): string {
  const attributes = [
    `from-session="${uuidToBase62(sender.id)}"`,
    `from-title="${attribute(sender.title)}"`,
    `from-agent="${attribute(sender.workspace?.name ?? '')}"`,
    // A sender that runs no task has none to name.
    ...(sender.taskId ? [`task="${uuidToBase62(sender.taskId)}"`] : []),
    ...(request
      ? [`request-id="${uuidToBase62(request.id)}"`, `reply-by="${request.replyBy.toISOString().replace(/\.\d{3}Z$/, 'Z')}"`]
      : []),
  ];
  return [
    `<${SESSION_MESSAGE_BLOCK_TAG} ${attributes.join(' ')}>`,
    '这条消息来自另一个 Orbit 会话，不是账号 owner 本人。',
    ...(request ? requestLines(request) : []),
    `</${SESSION_MESSAGE_BLOCK_TAG}>`,
  ].join('\n');
}

function requestLines(request: RequestForBlock): string[] {
  const requestId = uuidToBase62(request.id);
  if (request.state !== 'OPEN') {
    return [`对方曾要求回复，但这条请求已经以 ${request.state} 结案，不必再调用 session_reply。`];
  }
  const lines = [
    `对方在等你回复：处理完后调用 session_reply(requestId="${requestId}") 回答；做不到也用它说明原因。`,
    '如果你空闲下来时还没回复，平台会以 NO_REPLY 结案，并把你最后一段输出转给对方。',
  ];
  if (request.options) {
    lines.push('对方给了几个选项：回复时用 option 传你选的下标，也可以同时用 message 补充说明。');
    request.options.forEach((option, index) => {
      lines.push(`${index}. ${oneLine(option.label)}${option.description ? `：${oneLine(option.description)}` : ''}`);
    });
  }
  return lines;
}

/** An option's words on one line of the block, so a newline in them cannot end it early. */
function oneLine(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, ' ');
}

/**
 * The message as the engine is handed it: the sender's words, then §2.2's block.
 *
 * AFTER the words, never before: `controlPlaneNoteOf` finds where the author's words end by the echo
 * STARTING with them, and everything after is recorded as the control plane's note. Put first, the
 * block would be stored as the sender's own words.
 *
 * Not best-effort, unlike the background jobs and the wiki beside it at delivery: who is speaking is
 * part of what the message says, and delivered without it another agent's words read as the owner's.
 * A failure here rolls the claim back and leaves the turn queued. A sender that no longer exists is
 * the one case with nothing to say, and the message goes as it was written.
 */
export async function appendSessionMessageContext(
  tx: Prisma.TransactionClient,
  ownerId: string,
  senderSessionId: string,
  content: string | null | undefined,
  request?: RequestForBlock | null,
): Promise<string | null | undefined> {
  const sender = await readSender(tx, ownerId, senderSessionId);
  if (!sender) return content;
  return `${content ?? ''}\n\n${sessionMessageBlock(sender, request)}`;
}

/**
 * §2.3: the card a `user` event is stored with when another session sent its turn — the sending
 * session as it stands when the echo is stored. Null when there is no such session left to name.
 */
export async function readSessionMessageCard(
  db: Pick<Prisma.TransactionClient, 'session'>,
  ownerId: string,
  senderSessionId: string,
  /** The request the turn carries (session-request.ts), when its sender asked for a reply. */
  requestId?: string | null,
): Promise<SessionMessageCard | null> {
  const sender = await readSender(db, ownerId, senderSessionId);
  if (!sender) return null;
  return {
    fromSessionId: sender.id,
    fromTitle: sender.title,
    fromAgentName: sender.workspace?.name ?? '',
    ...(sender.taskId ? { fromTaskId: sender.taskId } : {}),
    // The public spelling, written here: `requestId` is a name the public-id codec never translates
    // (it is the manual project trigger's fence there), so the card carries the address as it is read.
    ...(requestId ? { requestId: uuidToBase62(requestId) } : {}),
  };
}
