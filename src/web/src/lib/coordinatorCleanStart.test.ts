import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  COORDINATOR_HANDOFF_COPY,
  type ProjectClosedQuestion,
  type ProjectOpenItemRow,
  type ProjectOpenItemsView,
} from '@orbit/shared';
import { decisionReceiptAnchor, recordsBeforeConversation } from './decisionReceipt';
import { closedQuestionRows } from '../components/CoordinatorQuestionCard';
import { exceptionCardRows } from '../components/ProjectProgressStatus';
import { CoordinatorHandoffReceivedCard } from '../components/CoordinatorHandoff';

/**
 * A coordinator conversation starts clean (docs/coordinator-handoff-v2-design.md §4), held to the
 * fixture all three clients read: `contracts/coordinator-clean-start.fixtures.json` (OrbitKit
 * `CoordinatorCleanStartTests`, Android `CoordinatorCleanStartTest`). A missing fixture is a
 * failure, never a skip.
 */
type Expect = 'hidden' | 'head' | { after: string };
interface Fixture {
  createdAt: string;
  loaded: Array<{ id: string; seq: number; ts: string }>;
  records: Array<{ name: string; stamp: string; expect: Expect }>;
  openItems: Array<{ name: string; stamp: string; expect: Expect }>;
  counts: Array<{ name: string; decisions: string[]; merges: string[]; expect: { decisions: number; merges: number } }>;
  noteLine: Array<{ decisions: number; merges: number; expect: string | null }>;
  openPrevious: string;
}

const FIXTURE_PATH = fileURLToPath(new URL('../../../../contracts/coordinator-clean-start.fixtures.json', import.meta.url));
const F: Fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

/** The fixture's expectation as the web's placement spells it: a seq, 'head', or null (not drawn). */
function placementOf(expect: Expect): number | 'head' | null {
  if (expect === 'hidden') return null;
  if (expect === 'head') return 'head';
  const row = F.loaded.find((event) => event.id === expect.after);
  if (!row) throw new Error(`the fixture names a row it does not load: ${expect.after}`);
  return row.seq;
}

const events = F.loaded.map(({ seq, ts }) => ({ seq, ts }));

function closed(itemId: string, resolvedAt: string): ProjectClosedQuestion {
  return {
    itemId,
    question: { question: `Question ${itemId}?`, options: [] } as unknown as ProjectClosedQuestion['question'],
    askedAt: resolvedAt,
    resolution: 'ANSWERED',
    resolvedBy: 'USER',
    resolvedAt,
    answer: { option: null, text: 'Yes' },
    delivery: null,
    withdrawReason: null,
  };
}

function openQuestion(itemId: string, waitingSince: string): ProjectOpenItemRow {
  return {
    itemId,
    kind: 'COORDINATOR_QUESTION',
    title: 'A question',
    detailLine: '',
    assignee: 'OWNER',
    assigneeReason: 'QUESTION',
    waitingSince,
    escalateAt: null,
    escalatedAt: null,
    taskId: null,
    sessionId: null,
  } as unknown as ProjectOpenItemRow;
}

describe('a record is drawn only if it is stamped after the conversation was created (shared fixture)', () => {
  for (const c of F.records) {
    it(`record: ${c.name}`, () => {
      expect(decisionReceiptAnchor(events, c.stamp, F.createdAt)).toBe(placementOf(c.expect));
    });
  }

  it('a conversation whose creation is unknown draws as before', () => {
    expect(decisionReceiptAnchor(events, '2026-11-15T09:00:00.000Z', null)).toBe('head');
    expect(decisionReceiptAnchor(events, '2026-11-15T09:00:00.000Z', 'not a stamp')).toBe('head');
  });

  it("the answered questions: one before createdAt is not placed, one after it but older than the page leads at the head", () => {
    const items = {
      needsYou: [],
      withCoordinator: [],
      closedQuestions: F.records
        .filter((c) => c.stamp !== 'not a stamp')
        .map((c, i) => closed(`q${i}`, c.stamp)),
    } as unknown as ProjectOpenItemsView;
    const rows = closedQuestionRows(items, events, F.createdAt);
    const expected = F.records
      .filter((c) => c.stamp !== 'not a stamp')
      .map((c, i) => ({ id: `q${i}`, placement: placementOf(c.expect) }))
      .filter((row) => row.placement !== null);
    expect(rows.map((row) => ({ id: row.record.itemId, placement: row.placement }))).toEqual(
      expect.arrayContaining(expected),
    );
    expect(rows).toHaveLength(expected.length);
  });
});

describe('open items are not records: drawn as before (shared fixture)', () => {
  for (const c of F.openItems) {
    it(`open item: ${c.name}`, () => {
      const items = { needsYou: [openQuestion('open-1', c.stamp)], withCoordinator: [] } as unknown as ProjectOpenItemsView;
      const [row] = exceptionCardRows(items, events);
      expect(row.anchor).toBe(placementOf(c.expect));
    });
  }
});

describe("the successor's note card counts what came before it (shared fixture)", () => {
  for (const c of F.counts) {
    it(`counts: ${c.name}`, () => {
      expect(recordsBeforeConversation(F.createdAt, c.decisions, c.merges)).toEqual(c.expect);
    });
  }

  for (const c of F.noteLine) {
    it(`line for ${c.decisions} decisions and ${c.merges} merges`, () => {
      expect(COORDINATOR_HANDOFF_COPY.historyBefore(c.decisions, c.merges)).toBe(c.expect);
    });
  }

  it('the link says the fixture’s words', () => {
    expect(COORDINATOR_HANDOFF_COPY.openPrevious).toBe(F.openPrevious);
  });

  const received = {
    handoffFromSessionId: 'prev-1',
    note: 'Where things stand\n- All code is on main.',
    handedOverAt: '2026-11-16T15:00:00.000Z',
    movedWaits: [],
  };

  it('the card draws the line with its link when there is history', () => {
    const html = renderToStaticMarkup(
      createElement(CoordinatorHandoffReceivedCard, { received, history: { decisions: 12, merges: 3 } }),
    );
    expect(html).toContain('12 decisions and 3 merges before this conversation');
    expect(html).toContain(`${F.openPrevious} ›`);
  });

  it('the card omits the line at zero', () => {
    const html = renderToStaticMarkup(
      createElement(CoordinatorHandoffReceivedCard, { received, history: { decisions: 0, merges: 0 } }),
    );
    expect(html).not.toContain('before this conversation');
    expect(html).not.toContain(F.openPrevious);
  });
});
