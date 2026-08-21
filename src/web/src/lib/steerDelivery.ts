/**
 * What to say about a message sent into a turn that was already running.
 *
 * The server decides, under the Session row lock, whether a message queues behind the running
 * turn or joins it (`ConversationTurnKind.steer`), and says which in the POST /turns response and
 * on the queued-turns list. The two look nothing alike to the person who sent one:
 *
 * - a QUEUED message is waiting for its own turn. It has not been read by anything, it can still
 *   be withdrawn, and when it finally runs it gets a reply of its own.
 * - a STEER is already on its way into the turn in progress. It cannot be withdrawn (the engine
 *   may be reading it as we ask), it produces no reply of its own — the running turn's does — and
 *   so how far it got IS the whole visible outcome. Silence here is indistinguishable from a
 *   message that was dropped, which is why every stage has a word for it.
 *
 * The stages are the runner's, not invented here (see RunEventType.USER_DELIVERY): a message is
 * accepted, then written into the engine's stdin, then echoed back by the engine, which is the
 * only moment it is really in the conversation. `enqueued` reads as "accepted" rather than as its
 * own stage — the runner taking it and the control plane taking it are the same promise to the
 * person waiting, and splitting them would be a distinction only the implementation can see.
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
      // In the engine's stdin, unread: `claude` inside a tool call reads nothing until that tool
      // finishes, so this can sit for as long as the tool runs. Still "on its way", but past us.
      return { label: 'Delivering…', tone: 'progress' };
    case 'acknowledged':
      // The engine echoed it back (--replay-user-messages). The message is in the conversation.
      return { label: 'Sent into this turn', tone: 'delivered' };
    case 'failed':
      return { label: 'Not delivered', tone: 'failed' };
    default:
      return { label: 'Sending…', tone: 'progress' };
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
