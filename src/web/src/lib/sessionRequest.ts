import type {
  SessionReplyCard,
  SessionRequestOutcome,
  SessionRequestState,
} from '@orbit/shared';
import { SESSION_REQUEST_OUTCOMES } from '@orbit/shared';

/**
 * One Orbit session asking another for a reply (docs/session-request-reply-contract.md §6), as the
 * two cards draw it.
 *
 * The RECIPIENT's card is the "From [session]" card its message arrived as, with the request it is
 * (`sessionMessage.requestId`) read live: a stored event never changes and the request's state does.
 * The ASKER's card is the turn the outcome came back as (`sessionReplies`), a snapshot — an outcome is
 * written once. Both are read-only: the account owner does not answer on the recipient's behalf.
 *
 * Every word here is shared with the native cards (OrbitKit `SessionRequestCopy`), and
 * `SessionRequestCopyParityTests.swift` reads this file to hold the two to it.
 */

/** The recipient's card: the line saying this message is a request. */
export const SESSION_REQUEST_ASKS = 'Asked for a reply';
/** Before the deadline, on the same line. */
export const SESSION_REQUEST_DUE = 'due';

/** What each state is called on the recipient's card. */
export const SESSION_REQUEST_STATE_LABEL: Record<SessionRequestState, string> = {
  OPEN: 'Waiting for a reply',
  REPLIED: 'Replied',
  NO_REPLY: 'Closed: went idle without replying',
  RECIPIENT_ENDED: 'Closed: this session ended',
  EXPIRED: 'Closed: the deadline passed',
  UNDELIVERED: 'Closed: never delivered',
};

/** The asker's card: whose reply this is. */
export const SESSION_REPLY_FROM = 'Reply from';
/** What each outcome is called on the asker's card. */
export const SESSION_REPLY_OUTCOME_LABEL: Record<SessionRequestOutcome, string> = {
  REPLIED: 'Replied',
  NO_REPLY: 'No reply',
  RECIPIENT_ENDED: 'Session ended',
  EXPIRED: 'Expired',
  UNDELIVERED: 'Not delivered',
};
/** Above the request the outcome answers. */
export const SESSION_REPLY_YOU_ASKED = 'You asked';
/** Above the recipient's last words, when there is no reply to show instead. */
export const SESSION_REPLY_LAST_WORDS = 'Its last words, not a reply';
/** The chosen answer, when the request offered options. */
export const SESSION_REPLY_CHOSE = 'Chose';
/** The link back to the original request, in the asked session's transcript. */
export const SESSION_REPLY_OPEN_REQUEST = 'Open the request ↗';
/** The foot line: who wrote this turn. */
export const SESSION_REPLY_NOT_YOU = 'Handed back by Orbit, not typed by you';
/** What an UNDELIVERED outcome says in place of a reply. */
export const SESSION_REPLY_NEVER_SEEN = 'The session never saw the request.';

/** The deadline as a card says it: the time today, otherwise the day and the time. */
export function formatReplyBy(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const sameDay = at.getFullYear() === now.getFullYear()
    && at.getMonth() === now.getMonth()
    && at.getDate() === now.getDate();
  if (sameDay) return time;
  return `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

/**
 * The outcomes a `user` event of the asking session carries (`sessionReplies`), as the control plane
 * recorded them beside the echo. A payload that is not a list of cards parses as NOTHING, so every
 * other turn — and every one stored before the field existed — keeps the reading it has always had.
 */
export function parseSessionReplies(payload: unknown): SessionReplyCard[] | null {
  const raw = (payload as { sessionReplies?: unknown } | null)?.sessionReplies;
  if (!Array.isArray(raw)) return null;
  const cards: SessionReplyCard[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const card = item as Record<string, unknown>;
    if (typeof card.requestId !== 'string' || card.requestId === '') continue;
    if (!SESSION_REQUEST_OUTCOMES.includes(card.outcome as SessionRequestOutcome)) continue;
    if (typeof card.fromSessionId !== 'string' || card.fromSessionId === '') continue;
    const text = (key: string): string | undefined =>
      typeof card[key] === 'string' && card[key] !== '' ? (card[key] as string) : undefined;
    cards.push({
      requestId: card.requestId,
      outcome: card.outcome as SessionRequestOutcome,
      fromSessionId: card.fromSessionId,
      fromTitle: typeof card.fromTitle === 'string' ? card.fromTitle : '',
      requestPreview: typeof card.requestPreview === 'string' ? card.requestPreview : '',
      ...(text('requestTurnId') ? { requestTurnId: text('requestTurnId') } : {}),
      ...(text('replyText') ? { replyText: text('replyText') } : {}),
      ...(typeof card.replyOption === 'number' ? { replyOption: card.replyOption } : {}),
      ...(text('replyOptionLabel') ? { replyOptionLabel: text('replyOptionLabel') } : {}),
      ...(text('excerpt') ? { excerpt: text('excerpt') } : {}),
      ...(text('closeReason') ? { closeReason: text('closeReason') } : {}),
      ...(text('closedAt') ? { closedAt: text('closedAt') } : {}),
    });
  }
  return cards.length > 0 ? cards : null;
}

/** What the sticky bar names a turn of replies by: whose, and the first outcome's word. */
export function sessionReplySticky(cards: readonly SessionReplyCard[]): { label: string; text: string } {
  const first = cards[0];
  const who = first.fromTitle.trim() || 'Untitled session';
  const more = cards.length > 1 ? ` (+${cards.length - 1})` : '';
  return {
    label: `${SESSION_REPLY_FROM} ${who}${more}`,
    text: first.replyText ?? SESSION_REPLY_OUTCOME_LABEL[first.outcome],
  };
}

/**
 * A recorded note without the `<orbit-session-reply>` blocks in it: what is left for the folded
 * "Orbit attached" entry once the reply cards have drawn those. Empty when the blocks were all of it.
 */
export function withoutReplyBlocks(note: string | undefined): string {
  if (!note) return '';
  return note.replace(/<orbit-session-reply[\s>][\s\S]*?\n<\/orbit-session-reply>/g, '').trim();
}
