import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { uuidToBase62, type SessionMessageCard } from '@orbit/shared';

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
 * WHO SENT IT is `conversation_turn.sender_session_id`, written by those two doors and by nothing
 * else, from the session the orchestration credential proved — never from a request body, so no
 * caller can name somebody else as the sender. Null is every other turn: the account owner, a
 * headless credential, the platform's own deliveries.
 *
 * It is said three times, each from that one column:
 *   - to the engine, as a block appended AFTER the message at delivery (`appendSessionMessageContext`),
 *     so `controlPlaneNoteOf` records it as the control plane's note and not as the sender's words;
 *   - to the clients, as the card stored beside the runner's echo (`readSessionMessageCard`);
 *   - to the limit, which counts what one session sent another in the last hour
 *     (`chargeSessionMessage`).
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
 * What is counted is the turns themselves: the sender column on the recipient's turns in the last
 * hour. A refusal rolls back with the turn it was for, so nothing a refusal answered is counted.
 *
 * Only the two session-to-session doors call it. A person's message, a headless credential's and the
 * platform's own deliveries carry no sender, are not counted, and are never refused here.
 */
export async function chargeSessionMessage(
  tx: Prisma.TransactionClient,
  fromSessionId: string,
  toSessionId: string,
): Promise<void> {
  const sent = await tx.conversationTurn.count({
    where: {
      sessionId: toSessionId,
      senderSessionId: fromSessionId,
      // Counted the way the spawn-rate window counts its hour (`SessionsService`
      // SPAWN_RATE_WINDOW_MS): a Prisma DateTime against the column Prisma wrote.
      createdAt: { gt: new Date(Date.now() - SESSION_MESSAGE_WINDOW_MS) },
    },
  });
  if (sent < SESSION_MESSAGES_PER_PAIR_PER_HOUR) return;
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
function attribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\s*[\r\n]+\s*/g, ' ');
}

/** §2.2: the block the engine reads after another session's message. */
export function sessionMessageBlock(sender: Sender): string {
  const attributes = [
    `from-session="${uuidToBase62(sender.id)}"`,
    `from-title="${attribute(sender.title)}"`,
    `from-agent="${attribute(sender.workspace?.name ?? '')}"`,
    // A sender that runs no task has none to name.
    ...(sender.taskId ? [`task="${uuidToBase62(sender.taskId)}"`] : []),
  ];
  return [
    `<${SESSION_MESSAGE_BLOCK_TAG} ${attributes.join(' ')}>`,
    '这条消息来自另一个 Orbit 会话，不是账号 owner 本人。',
    `</${SESSION_MESSAGE_BLOCK_TAG}>`,
  ].join('\n');
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
): Promise<string | null | undefined> {
  const sender = await readSender(tx, ownerId, senderSessionId);
  if (!sender) return content;
  return `${content ?? ''}\n\n${sessionMessageBlock(sender)}`;
}

/**
 * §2.3: the card a `user` event is stored with when another session sent its turn — the sending
 * session as it stands when the echo is stored. Null when there is no such session left to name.
 */
export async function readSessionMessageCard(
  db: Pick<Prisma.TransactionClient, 'session'>,
  ownerId: string,
  senderSessionId: string,
): Promise<SessionMessageCard | null> {
  const sender = await readSender(db, ownerId, senderSessionId);
  if (!sender) return null;
  return {
    fromSessionId: sender.id,
    fromTitle: sender.title,
    fromAgentName: sender.workspace?.name ?? '',
    ...(sender.taskId ? { fromTaskId: sender.taskId } : {}),
  };
}
