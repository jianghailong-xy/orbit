/**
 * One Orbit session asking another for a reply, as the clients read it
 * (docs/session-request-reply-contract.md §3–§6, P1).
 *
 * A request is a `session_send` / `project_send` that carried `expectReply`. It comes to exactly one
 * outcome, and that outcome is handed back to the asking session as a turn of its own. The recipient's
 * card is the `user` event its message arrived as (`SessionMessageCard.requestId`) with the request's
 * state read live; the asker's card is the `user` event the outcome arrived as (`SessionReplyCard`).
 * Both are read-only: the account owner does not answer on a recipient's behalf (§9.3).
 */

/** The five outcomes, each written once (§4). */
export type SessionRequestOutcome = 'REPLIED' | 'NO_REPLY' | 'RECIPIENT_ENDED' | 'EXPIRED' | 'UNDELIVERED';

export type SessionRequestState = 'OPEN' | SessionRequestOutcome;

export const SESSION_REQUEST_OUTCOMES: readonly SessionRequestOutcome[] = [
  'REPLIED', 'NO_REPLY', 'RECIPIENT_ENDED', 'EXPIRED', 'UNDELIVERED',
];

/** One answer the asker offered: `ask_owner`'s option shape. */
export interface SessionReplyOption {
  label: string;
  description?: string;
}

/** A request as it stands now: `GET /session-requests/:id`. */
export interface SessionRequestView {
  /** The request's public id. */
  requestId: string;
  state: SessionRequestState;
  /** The session that asked. */
  fromSessionId: string;
  fromTitle: string;
  /** The session that was asked — for `project_send`, the coordinator the message was delivered to. */
  toSessionId: string;
  toTitle: string;
  /** The first 200 characters of the request. */
  requestPreview: string;
  replyOptions?: SessionReplyOption[];
  /** ISO-8601: the deadline, after which the request is EXPIRED. */
  replyBy: string;
  createdAt: string;
  closedAt?: string;
  /** REPLIED: what the recipient wrote, and the index of the option it chose. */
  replyText?: string;
  replyOption?: number;
  /** Every other outcome: what the recipient had last said. Not an answer. */
  excerpt?: string;
  /** RECIPIENT_ENDED: how it ended; UNDELIVERED: what took it off the queue; EXPIRED: the recipient's state. */
  closeReason?: string;
}

/**
 * What a `user` event of the ASKING session carries beside its text when its turn handed outcomes
 * back (`sessionReplies`): one card per outcome, a snapshot of the request when the echo was stored —
 * an outcome never changes, so the snapshot is the answer. Absent on every other turn.
 */
export interface SessionReplyCard {
  /** The request's public id. */
  requestId: string;
  outcome: SessionRequestOutcome;
  /** The session that was asked: where the request is, and who answered. */
  fromSessionId: string;
  fromTitle: string;
  /** The turn the request arrived as in that session's transcript — where "the original request" is. */
  requestTurnId?: string;
  requestPreview: string;
  replyText?: string;
  replyOption?: number;
  replyOptionLabel?: string;
  excerpt?: string;
  closeReason?: string;
  closedAt?: string;
}

/**
 * One open request on a session's list row (§6, "who is waiting on whose reply"): the other session
 * and the request. `awaitingReplyFrom` on the asker's row names the sessions it is waiting on;
 * `owesReplyTo` on the recipient's row names the sessions waiting on it.
 */
export interface SessionRequestPeer {
  requestId: string;
  sessionId: string;
  title: string;
}
