import type {
  CriteriaDecisionReply,
  PendingCriteriaDecisionQueue,
  SettledCriteriaDecision,
} from '../components/CriteriaDecisionCard';

/**
 * WHERE A DECISION LEAVES ITS RECEIPT IN A CONVERSATION
 * ====================================================
 * A card's question leaves the pending read the moment it is answered, so a card that kept the
 * answer for as long as the window remembered it took the decision out of the conversation the
 * moment the page was reloaded — in the one place the question had been asked. What survives is the
 * ANSWER, which is a committed row: every client reads it back (`settled` on the criteria queue,
 * `decided` on the evidence queue) and draws a receipt for it in the transcript, at the moment it
 * was decided. This is the arithmetic both halves share: which moment, and which answers are this
 * conversation's to draw.
 */

/**
 * WHERE A RECEIPT IS DRAWN, in the three answers the rule has — the same three the native clients
 * compute (`ReceiptAnchor.place`), because two ends of one rule is how a phone and a browser come
 * to disagree about where the same answer happened:
 *
 *   `seq`     after that row: the last event recorded at or before the decision.
 *   `'head'`  older than EVERY event loaded: drawn at the head of the window, above the first row
 *             and above the "load earlier" control — as close to where it happened as this client
 *             can get, and it walks down into place as older pages arrive. NOT at the tail: a
 *             record's own stamp on a card under everything that happened after it says the
 *             decision was made now, and not drawn at all is what this used to do — a record that
 *             vanishes on a long conversation is a record the reader cannot find.
 *   `null`    a stamp nothing can parse. The head claims "older than everything here", which is a
 *             claim about a moment, and there is none: not drawn.
 */
export type ReceiptPlacement = number | 'head';

/** Where the receipt for `decidedAt` is drawn among the events loaded right now, or null. */
export function decisionReceiptAnchor(
  events: ReadonlyArray<{ seq: number; ts?: string }>,
  decidedAt: string,
): ReceiptPlacement | null {
  const at = Date.parse(decidedAt);
  if (Number.isNaN(at)) return null;
  let anchor: number | null = null;
  for (const event of events) {
    const ts = event.ts === undefined ? Number.NaN : Date.parse(event.ts);
    if (ts <= at && (anchor === null || event.seq > anchor)) anchor = event.seq;
  }
  return anchor ?? 'head';
}

/** One answer the read says belongs in this conversation, and where in its flow it goes. */
export interface CriteriaDecisionReceiptRow {
  settled: SettledCriteriaDecision;
  /** Where the answer went, when the window that pressed it knows — the door's own response. */
  reply: CriteriaDecisionReply | null;
  placement: ReceiptPlacement;
}

/**
 * The receipts an open coordinator conversation draws for the proposals it was asked about and no
 * longer holds. Newest first, as the read publishes them; the anchor puts each one where it
 * happened rather than in a stack at the end.
 *
 * Drawn from the READ and not from the window that pressed, because the window is exactly what a
 * reload takes away — the account owner's report, 2026-09-16: approved a weakening, refreshed the
 * conversation, and the decision was gone from it. Nothing was left to draw: a settled question is
 * not a question, so the card goes; and the receipt was state in the page that pressed.
 *
 * `replies` is the door's response for presses made in this window, and it is deliberately the only
 * thing a press contributes: the read publishes the outcome and its seals to every client, and a
 * session has never been told where its answer went by this conversation. A press in another window
 * or on another device therefore draws the same receipt minus that clause, and draws it where it
 * happened rather than where the reader happens to be looking.
 */
export function criteriaDecisionReceiptRows(
  queue: PendingCriteriaDecisionQueue | null | undefined,
  events: ReadonlyArray<{ seq: number; ts?: string }>,
  replies: Readonly<Record<string, CriteriaDecisionReply | null | undefined>> = {},
): CriteriaDecisionReceiptRow[] {
  return (queue?.settled ?? []).flatMap((settled) => {
    const placement = decisionReceiptAnchor(events, settled.decidedAt);
    return placement === null
      ? []
      : [{ settled, reply: replies[settled.intentId] ?? null, placement }];
  });
}
