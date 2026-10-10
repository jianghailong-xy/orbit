import type { OwnerAnswerCard } from '@orbit/shared';

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
