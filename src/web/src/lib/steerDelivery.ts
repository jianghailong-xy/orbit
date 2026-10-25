/**
 * What to say about a message sent into a turn that was already running.
 *
 * The server decides, under the Session row lock, whether a message queues behind the running
 * turn or joins it (`ConversationTurnKind.steer`), and says which in the POST /turns response and
 * on the queued-turns list. The two look nothing alike to the person who sent one:
 *
 * - a QUEUED message is waiting for its own turn. It has not been read by anything, it can still
 *   be cancelled, and when it finally runs it gets a reply of its own.
 * - a STEER is already on its way into the turn in progress. It produces no reply of its own — the
 *   running turn's does — and so how far it got IS the whole visible outcome. Silence here is
 *   indistinguishable from a message that was dropped, which is why every stage has a word for it.
 *   Until the engine reads it, it can be withdrawn where the engine can drop it unread and say so
 *   (claude: its runner marks the steer `withdrawable`); once read, it is part of the turn.
 *
 * The words follow the read receipts people already know from chat: sending, then waiting to be
 * read, then read. "Delivering…" used to stand where "Waiting to be read" does, and read as a
 * message stuck in transit: by then it has arrived, and what it waits for is the engine.
 *
 * The stages are the runner's, not invented here (see RunEventType.USER_DELIVERY): a message is
 * accepted, then handed to the engine, then echoed back by it, which is the only moment it is
 * really in the conversation. How each engine takes one differs — claude reads a frame off a
 * stdin that stays open, codex is asked to write it into the turn (`turn/steer`) — but the stages
 * mean the same thing on both, which is why there is one vocabulary and not two. `enqueued` reads
 * as "accepted" rather than as its own stage — the runner taking it and the control plane taking
 * it are the same promise to the person waiting, and splitting them would be a distinction only
 * the implementation can see.
 */
export type SteerDeliveryTone = 'progress' | 'delivered' | 'failed';

export interface SteerDeliveryState {
  /** The word shown under the bubble. */
  label: string;
  tone: SteerDeliveryTone;
}

/** Was this turn filed as a steer? `kind` comes from POST /turns or GET /sessions/:id/turns. */
export const isSteerKind = (kind?: string | null): boolean => kind === 'steer';

/**
 * The stage a steer is at, from the `delivery` its `user` event opened with and every
 * `user_delivery` that amended it. Undefined covers the window before any event exists at all —
 * the control plane has accepted the message and the runner has not yet leased it — which is the
 * same promise as `enqueued` and reads the same.
 */
export function steerDeliveryState(delivery?: string | null): SteerDeliveryState {
  switch (delivery) {
    case 'written':
      // The engine has it and the model has not read it yet: `claude` busy in a tool call takes it
      // into the conversation only when that tool finishes, and codex buffers a steer until its next
      // model request — measured at 31 seconds. It has arrived; what it waits for is the engine.
      return { label: 'Waiting to be read', tone: 'progress' };
    case 'acknowledged':
      // The engine echoed it back (claude's --replay-user-messages, codex's userMessage item).
      // The message is in the conversation, and the reply this turn gives is the answer to it.
      return { label: 'Read in this turn', tone: 'delivered' };
    case 'requeued':
      // It missed the turn it was aimed at, and that is provable, so nothing about it was lost:
      // the runner handed it back and it runs as a turn of its own. Progress, not failure — the
      // only non-delivery in this vocabulary that still ends with the message being read.
      return { label: 'Queued for next turn instead', tone: 'progress' };
    case 'failed':
      return { label: 'Not delivered', tone: 'failed' };
    case 'unconfirmed':
      // It reached the engine; whether the engine read it is what nobody can say. Neutral on
      // purpose: it may have been acted on, and a resend would do the work twice.
      return { label: "Couldn't confirm it was read", tone: 'failed' };
    default:
      return { label: 'Sending…', tone: 'progress' };
  }
}

/** The runner's word that the engine dropped a steer unread: its bubble leaves the transcript. */
export const WITHDRAWN_DELIVERY = 'withdrawn';

/**
 * Whether to offer taking a steer back: its runner said the engine can drop it unread
 * (`withdrawable` on its user event), and nothing has read, failed or withdrawn it since.
 */
export function offersSteerWithdraw(delivery?: string | null, withdrawable?: boolean): boolean {
  return withdrawable === true && (delivery == null || delivery === 'enqueued' || delivery === 'written');
}

/**
 * Why it did not land, in the sender's words rather than the protocol's.
 *
 * The durable reason stored on the row is written for whoever debugs the boundary that failed it
 * ("the target turn completed before CURRENT_WORK could be delivered") and names an internal
 * routing intent. What the person needs is the one fact that decides what they do next: what
 * stopped reading, and whether anything here still can. The server's own text stays reachable as
 * the tooltip, so nothing is hidden by saying it plainly first.
 */
export function deliveryFailureExplanation(
  code?: string | null,
  reason?: string | null,
): string | undefined {
  switch (code) {
    case 'CURRENT_WORK_TARGET_COMPLETED':
      return 'The turn finished before it was read.';
    case 'CURRENT_WORK_INTERRUPTED':
      return 'The turn was interrupted before it was read.';
    case 'CURRENT_WORK_SESSION_ENDED':
    case 'CURRENT_WORK_SESSION_FINALIZED':
      return 'The session ended before it was read.';
    case 'CURRENT_WORK_SESSION_REAPED':
      return 'The runner disappeared while it was being delivered.';
    case 'CURRENT_WORK_RUNTIME_REJECTED':
      return 'The engine rejected it.';
    default:
      return reason ?? undefined;
  }
}

/**
 * Whether this event supersedes the live streaming drafts, so they can be cleared without losing
 * anything. A durable `assistant` carries the authoritative full text; a turn/user/interrupt
 * boundary means whatever was streaming is over.
 *
 * A steer is the one `user` event that is not a boundary — it is written INTO the turn that is
 * streaming right now. The text beside it has no authoritative event yet, so clearing on it would
 * blank a reply mid-sentence and leave the pane empty until the block finished.
 */
export function supersedesLiveDrafts(ev: {
  type: string;
  payload?: { steer?: unknown } | null;
}): boolean {
  if (ev.type === 'user' && ev.payload?.steer === true) return false;
  return ['assistant', 'turn_end', 'user', 'interrupt', 'error'].includes(ev.type);
}
