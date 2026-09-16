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
 * The seq a receipt is drawn after: the last event recorded at or before the decision.
 *
 * Null when every event loaded so far is later. The moment is then on a page that is not loaded
 * yet, and drawing the receipt at the top would put a decision above things that happened first.
 */
export function decisionReceiptAnchor(
  events: ReadonlyArray<{ seq: number; ts?: string }>,
  decidedAt: string,
): number | null {
  const at = Date.parse(decidedAt);
  let anchor: number | null = null;
  for (const event of events) {
    const ts = event.ts === undefined ? Number.NaN : Date.parse(event.ts);
    if (ts <= at && (anchor === null || event.seq > anchor)) anchor = event.seq;
  }
  return anchor;
}

/** One answer the read says belongs in this conversation, and where in its flow it goes. */
export interface CriteriaDecisionReceiptRow {
  settled: SettledCriteriaDecision;
  /** Where the answer went, when the window that pressed it knows — the door's own response. */
  reply: CriteriaDecisionReply | null;
  afterSeq: number;
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
    const afterSeq = decisionReceiptAnchor(events, settled.decidedAt);
    return afterSeq === null
      ? []
      : [{ settled, reply: replies[settled.intentId] ?? null, afterSeq }];
  });
}
