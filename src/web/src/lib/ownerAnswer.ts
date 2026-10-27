import type { OwnerAnswerCard } from '@orbit/shared';
import { routeId } from './idCodec';

/**
 * The owner's answer handed to the coordinator, as the control plane recorded it beside the turn's
 * echo (`ownerAnswer`, apiserver project-open-item.ts `readOwnerAnswerCard`) — the reading
 * `OwnerAnswerLine` is drawn from.
 *
 * The turn's words are written for the AGENT: `From Orbit · owner answer: you asked "…"`, the
 * question replayed in full and the answer with its ISO moment (or the Not yet… that sent back a
 * request to record the project done). Until this card existed they were the only thing recorded for
 * the turn, so it was drawn as a bubble the owner had typed.
 *
 * Read the way `parseOpenItemDelivery` reads an exception item's card: the shape is checked and a
 * payload that is not a card parses as NOTHING rather than as half a card, which leaves the turn
 * drawn exactly as it was before this existed. Nothing is derived from the words.
 */
export function parseOwnerAnswer(payload: unknown): OwnerAnswerCard | null {
  const raw = (payload as { ownerAnswer?: unknown } | null)?.ownerAnswer;
  if (!raw || typeof raw !== 'object') return null;
  const card = raw as Record<string, unknown>;
  // The item, what it was, the conversation and when it was told: all four make one. The moment has
  // to read as one, since it is the only word on the line that is not the product's own.
  if (
    typeof card.itemId !== 'string' || card.itemId === ''
    || (card.kind !== 'COORDINATOR_QUESTION' && card.kind !== 'DONE_REQUEST')
    || typeof card.sessionId !== 'string' || card.sessionId === ''
    || typeof card.deliveredAt !== 'string' || Number.isNaN(Date.parse(card.deliveredAt))
  ) {
    return null;
  }
  return { itemId: card.itemId, kind: card.kind, sessionId: card.sessionId, deliveredAt: card.deliveredAt };
}

/**
 * An answered item's key, in one spelling whichever the read it came from used: the open-items read
 * and the turn's card each name the item, and a lookup between them must not depend on both having
 * been served the same way.
 */
export function answeredItemKey(itemId: string): string {
  return routeId(itemId) ?? itemId;
}

/**
 * The questions a turn of this conversation hands to its coordinator — echoed, or still on the queue
 * — by item key (`answeredItemKey`). Each such turn draws the question's own card (`OwnerAnswerLine`), so the conversation
 * does not insert that card again at the moment the question was answered. A Not yet… to a request to
 * record the project done has no card to be, and is left out.
 */
export function answersHandedOver(
  events: ReadonlyArray<{ type: string; payload?: unknown }>,
  queued: ReadonlyArray<{ ownerAnswer?: OwnerAnswerCard }>,
): Set<string> {
  const items = new Set<string>();
  for (const event of events) {
    const card = event.type === 'user' ? parseOwnerAnswer(event.payload) : null;
    if (card?.kind === 'COORDINATOR_QUESTION') items.add(answeredItemKey(card.itemId));
  }
  for (const turn of queued) {
    if (turn.ownerAnswer?.kind === 'COORDINATOR_QUESTION') items.add(answeredItemKey(turn.ownerAnswer.itemId));
  }
  return items;
}
