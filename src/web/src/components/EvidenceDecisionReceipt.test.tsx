import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { pendingDecisionsQuery } from '../lib/queries';
import type { PendingDecisionQueue, PendingDecisionRow, RecordedDecisionRow } from './DecisionRail';
import {
  DECISION_ASK_HEADING,
  DECISION_CONFIRM_ACTION,
  DECISION_RECEIPT_OPEN,
  DECISION_RECEIPT_REASON,
  DECISION_SEND_BACK_ACTION,
  EVIDENCE_DECISION_AGENT_RECORDED_HEADING,
  EVIDENCE_DECISION_RECORDED_HEADING,
  EvidenceDecisionReceipt,
  SessionEvidenceDecisionCard,
  decisionReceiptAnchor,
  decisionReceiptLine,
  decisionReceiptTime,
} from './EvidenceDecisionCard';

/**
 * What a decision leaves in the conversation once its card's question is gone.
 *
 * The card remembered a decision only for as long as the page did, so a reload took it out of the
 * conversation. The receipt is drawn from the decision rows the pending read now carries, which is
 * what these pin: what one says, where it goes, and that the card for a version with a receipt is
 * not drawn beside it.
 */

const SESSION_ID = '34MOJw69NzKSq2X0exxf9';
const PROJECT_ID = '34MPiBgZ80YpSKt0lmTQA';
const TASK_ID = '34MQU2Y12ag8HVafcL8qL';
const DECIDED_AT = '2026-09-13T13:09:34.230Z';

function decided(over: Partial<RecordedDecisionRow> = {}): RecordedDecisionRow {
  return {
    taskId: TASK_ID,
    title: '改写项目硬约束 1、3 与判据 2',
    projectId: PROJECT_ID,
    evidenceRevision: '2',
    decision: 'CONFIRM',
    note: null,
    decidedAt: DECIDED_AT,
    decidedByType: 'USER',
    ...over,
  };
}

function row(over: Partial<PendingDecisionRow> = {}): PendingDecisionRow {
  return {
    taskId: TASK_ID,
    title: '改写项目硬约束 1、3 与判据 2',
    projectId: PROJECT_ID,
    criterion: { key: '7L4At4DOupG7FwgxfXykzS', text: '后台进程不阻塞 merge/commit' },
    evidenceRevision: '2',
    ageSeconds: 600,
    claim: '判据 2 已按 owner 定调改写',
    gaps: [],
    citations: [],
    decidability: { decidable: true, refusal: null, requiredAction: null },
    independence: { independent: true, disqualification: null, requiredAction: null },
    ...over,
  };
}

function queue(pending: PendingDecisionRow[], recorded?: RecordedDecisionRow[]): PendingDecisionQueue {
  return {
    decidingSessionId: SESSION_ID,
    count: pending.length,
    oldestAgeSeconds: pending[0]?.ageSeconds ?? null,
    pending,
    waitingOnYou: [],
    ...(recorded ? { decided: recorded } : {}),
  };
}

function newClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnMount: false, retryOnMount: false, refetchOnWindowFocus: false },
    },
  });
}

function receipt(value: RecordedDecisionRow): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={newClient()}>
      <EvidenceDecisionReceipt decided={value} />
    </QueryClientProvider>,
  );
}

function sessionCards(read: PendingDecisionQueue): string {
  const qc = newClient();
  qc.setQueryData(pendingDecisionsQuery(SESSION_ID).queryKey, read);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <SessionEvidenceDecisionCard sessionId={SESSION_ID} projectId={PROJECT_ID} />
    </QueryClientProvider>,
  );
}

/** Every rendered button's text, tags stripped. */
function buttonTexts(html: string): string[] {
  return [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gu)].map((match) =>
    match[1].replace(/<[^>]*>/gu, ''),
  );
}

describe('the receipt a decision leaves', () => {
  it('says what was answered and offers nothing to press but its fold', () => {
    const html = receipt(decided());

    expect(html).toContain(EVIDENCE_DECISION_RECORDED_HEADING);
    expect(html).toContain('改写项目硬约束 1、3 与判据 2');
    expect(html).toContain(decisionReceiptLine(decided()));
    expect(html).not.toContain(DECISION_ASK_HEADING);
    expect(buttonTexts(html)).toEqual([`${DECISION_RECEIPT_OPEN} ▾`]);
  });

  it('names who recorded it: the owner, or a run of this session', () => {
    expect(receipt(decided({ decidedByType: 'AGENT' }))).toContain(EVIDENCE_DECISION_AGENT_RECORDED_HEADING);
    expect(receipt(decided({ decidedByType: 'AGENT' }))).not.toContain(EVIDENCE_DECISION_RECORDED_HEADING);
    expect(receipt(decided())).not.toContain(EVIDENCE_DECISION_AGENT_RECORDED_HEADING);
  });

  it('carries the reason a send-back gave, and a confirm has none', () => {
    const note = '把 pg spec 跑一遍，并给出改前先红的原始输出';
    const sentBack = receipt(decided({ decision: 'SEND_BACK', note }));

    expect(sentBack).toContain(`${DECISION_RECEIPT_REASON}：${note}`);
    expect(receipt(decided())).not.toContain(DECISION_RECEIPT_REASON);
  });

  it('reads which answer, which version, and when', () => {
    const sameDay = new Date(DECIDED_AT);
    const twoDaysLater = new Date(Date.parse(DECIDED_AT) + 2 * 24 * 3600 * 1000);

    expect(decisionReceiptLine(decided(), sameDay)).toBe(
      `${DECISION_CONFIRM_ACTION} · rev 2 · ${decisionReceiptTime(DECIDED_AT, sameDay)}`,
    );
    expect(decisionReceiptLine(decided({ decision: 'SEND_BACK', note: 'x' }), sameDay)).toBe(
      `${DECISION_SEND_BACK_ACTION} · rev 2 · ${decisionReceiptTime(DECIDED_AT, sameDay)}`,
    );
    // On a later day the clock alone would read as today's, so the date comes with it.
    const clock = decisionReceiptTime(DECIDED_AT, sameDay);
    const dated = decisionReceiptTime(DECIDED_AT, twoDaysLater);
    expect(dated.endsWith(clock)).toBe(true);
    expect(dated.length).toBeGreaterThan(clock.length);
  });
});

describe('where a receipt goes', () => {
  const events = [
    { seq: 1, ts: '2026-09-13T12:50:00.000Z' },
    { seq: 2, ts: '2026-09-13T12:53:55.000Z' },
    { seq: 3 },
    { seq: 4, ts: '2026-09-13T13:20:00.000Z' },
  ];

  it('follows the last event recorded at or before the decision', () => {
    expect(decisionReceiptAnchor(events, DECIDED_AT)).toBe(2);
    expect(decisionReceiptAnchor(events, '2026-09-13T12:53:55.000Z')).toBe(2);
    expect(decisionReceiptAnchor(events, '2026-09-13T14:00:00.000Z')).toBe(4);
  });

  it('has no place when every loaded event is later, rather than going to the top', () => {
    expect(decisionReceiptAnchor(events, '2026-09-13T12:00:00.000Z')).toBeNull();
  });
});

describe('a decided version keeps its receipt, not its card', () => {
  it('draws no card for a version this conversation has decided', () => {
    // The paired positive first: the same pending row with no decision on the read is a card.
    expect(sessionCards(queue([row()]))).toContain(DECISION_ASK_HEADING);
    expect(sessionCards(queue([row()], []))).toContain(DECISION_ASK_HEADING);

    // The read that lands while the press is still in flight: the decision row is there and the
    // pending row may not have left yet. The receipt answers for it, so the card does not.
    expect(sessionCards(queue([row()], [decided()]))).toBe('');
  });

  it('keeps the card for a later version of the same task', () => {
    const html = sessionCards(queue([row({ evidenceRevision: '3' })], [decided({ evidenceRevision: '2' })]));

    expect(html).toContain(DECISION_ASK_HEADING);
    expect(html).toContain(`data-decision-row="${TASK_ID}@3"`);
  });
});
