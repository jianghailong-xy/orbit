// @vitest-environment jsdom
import { type JSX } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { OpenItemFacts, ProjectOpenItemRow, ProjectOpenItemsView } from '@orbit/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  HANDLED_TAG,
  HANDLING_TAG,
  ItemAsCard,
  ProjectOpenItems,
  SUPERSEDED_TAG,
  exceptionCardRows,
  isOwnerExceptionCard,
} from './ProjectProgressStatus';
import { projectOpenItemsQuery } from '../lib/queries';

/**
 * An exception card through the coordinator's handling of it (contract §4.7 H1–H5): handling while
 * the rerun it asked for runs, handled once that rerun landed or passed (or the coordinator closed
 * it with a reason), superseded once the rerun failed again — and the owner's, as before, once the
 * clock handed it over. For a task's landing and for a merge of the project branch into main, which
 * names no task.
 *
 * What these assert is the card's own words: the state it wears, never "handled" before the
 * server's row says so, and the reason the coordinator gave.
 */

vi.mock('../api', () => ({ api: vi.fn() }));

const PROJECT_ID = '34Y7My8sqhKLWtmCQYv1l';
const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const MINUTE = 60 * 1000;
const REASON = 'the merge check’s runner-go baseline was repaired; the red was the baseline’s, not this delivery’s';

function at(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

function facts(over: Partial<OpenItemFacts> = {}): OpenItemFacts {
  return {
    task: null,
    targetRef: null,
    targetSha: null,
    files: [],
    nothingLanded: false,
    check: {
      name: 'MERGE_CHECK',
      command: 'npm test && go test ./...',
      expectedExitCode: 0,
      exitCode: 1,
      timedOut: false,
      durationMs: 1_609_148,
      outputTail: '--- FAIL: TestRealClaudeAcceptsASetModel (1.45s)\nFAIL',
    },
    branchUnchanged: true,
    errorCode: null,
    failure: null,
    ...over,
  };
}

/** A task's landing that failed its combined-tree check, with the coordinator. */
const LANDING: ProjectOpenItemRow = {
  itemId: '34ZLandingItem0000001',
  kind: 'INTEGRATION_CHECK_FAILED',
  title: 'Checks failed on the combined tree: ③ 实现所有者收尾门与 Done 优先语义',
  detailLine: '',
  assignee: 'COORDINATOR',
  assigneeReason: 'DEFAULT',
  waitingSince: at(30 * MINUTE),
  escalateAt: new Date(NOW + 90 * MINUTE).toISOString(),
  escalatedAt: null,
  taskId: '34Y7Utvsd47A14DjMzIzD',
  sessionId: '34Y7UtvsdSession00001',
  promotionId: null,
  fuseEpisodeId: null,
  delivery: { state: 'DELIVERED', sessionId: '34Y7Myo7G89Vk0fVpelbt', at: at(29 * MINUTE) },
  actions: ['OPEN_COORDINATOR', 'OPEN_TASK_SESSION', 'RETRY', 'CANCEL_TASK'],
  question: null,
  facts: facts({ task: { id: '34Y7Utvsd47A14DjMzIzD', title: '③ 实现所有者收尾门与 Done 优先语义' } }),
  handling: null,
  outcome: null,
};

/** A merge of the project branch into main that its MERGE_CHECK blocked: no task, a candidate. */
const PROMOTION: ProjectOpenItemRow = {
  ...LANDING,
  itemId: '34ZPromotionItem00001',
  title: 'Checks failed on the combined tree: merging the project branch into main',
  taskId: null,
  sessionId: null,
  promotionId: '34ZPromotion000000001',
  actions: ['REVIEW'],
  facts: facts(),
};

const HANDLING_LANDING: ProjectOpenItemRow = {
  ...LANDING,
  handling: {
    sessionId: '34Y7Myo7G89Vk0fVpelbt',
    reason: REASON,
    startedAt: at(4 * MINUTE),
    jobId: '34ZRerunJob0000000001',
    jobKind: 'LAND_TASK',
    generation: 2,
    state: 'RUNNING',
  },
};

const HANDLING_PROMOTION: ProjectOpenItemRow = {
  ...PROMOTION,
  handling: {
    sessionId: '34Y7Myo7G89Vk0fVpelbt',
    reason: 'main’s merge-check baseline was repaired',
    startedAt: at(1 * MINUTE),
    jobId: '34ZRecheckJob00000001',
    jobKind: 'CHECK_PROMOTION',
    generation: 2,
    state: 'QUEUED',
  },
};

/** What the read serves for a settled one: no presses, nothing on its way to anybody. */
function settled(row: ProjectOpenItemRow, outcome: NonNullable<ProjectOpenItemRow['outcome']>): ProjectOpenItemRow {
  return {
    ...row,
    escalateAt: null,
    delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null },
    actions: [],
    handling: null,
    outcome,
  };
}

const HANDLED_LANDING = settled(LANDING, {
  state: 'RESOLVED',
  resolution: 'HANDLED',
  resolvedBy: 'COORDINATOR',
  resolvedBySessionId: '34Y7Myo7G89Vk0fVpelbt',
  resolvedAt: at(12 * MINUTE),
  note: REASON,
  jobId: '34ZRerunJob0000000001',
  supersededByItemId: null,
});

const CLOSED_BY_HAND = settled(LANDING, {
  ...HANDLED_LANDING.outcome!,
  note: 'replayed onto the project branch by hand; the receipt is on the task',
  jobId: null,
});

const SUPERSEDED_PROMOTION = settled(PROMOTION, {
  state: 'SUPERSEDED',
  resolution: 'RETRIED',
  resolvedBy: 'COORDINATOR',
  resolvedBySessionId: '34Y7Myo7G89Vk0fVpelbt',
  resolvedAt: at(2 * MINUTE),
  note: 'main’s merge-check baseline was repaired',
  jobId: '34ZRecheckJob00000001',
  supersededByItemId: '34ZPromotionItem00002',
});

/** The owner's: the clock handed it over while the coordinator's rerun was still running. */
const ESCALATED_WHILE_HANDLING: ProjectOpenItemRow = {
  ...HANDLING_LANDING,
  assignee: 'OWNER',
  assigneeReason: 'ESCALATED',
  waitingSince: at(130 * MINUTE),
  escalateAt: null,
  escalatedAt: at(10 * MINUTE),
  delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null },
  actions: ['ASK_COORDINATOR_AGAIN', 'OPEN_TASK_SESSION', 'CANCEL_TASK'],
};

function paint(items: ProjectOpenItemsView, ui: () => JSX.Element): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(projectOpenItemsQuery(PROJECT_ID).queryKey, items);
  return renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{ui()}</QueryClientProvider>
    </MemoryRouter>,
  );
}

function card(row: ProjectOpenItemRow): string {
  return paint({ needsYou: [], withCoordinator: [] }, () => (
    <ItemAsCard projectId={PROJECT_ID} row={row} now={NOW} />
  ));
}

/** The text of the card, tags stripped, so a sentence split across elements reads as one. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&');
}

describe('a task landing card through the coordinator’s handling', () => {
  it('reads Handling while the rerun runs, with the generation and the reason, and never Handled', () => {
    const html = card(HANDLING_LANDING);
    expect(html).toContain(`project-open-item-state is-handling">${HANDLING_TAG}<`);
    expect(html).toContain('data-handling="handling"');
    expect(text(html)).toContain('the rerun of the landing — generation 2 is running · asked 4m ago');
    expect(text(html)).toContain(REASON);
    expect(html).not.toContain(HANDLED_TAG);
    expect(html).not.toContain(SUPERSEDED_TAG);
    // Still the coordinator's open item: the clock runs on, and the card keeps its presses.
    expect(text(html)).toContain('Owner: coordinator · waiting 30m · goes to the owner in 1h 30m');
    expect(text(html)).toContain('Open task session');
  });

  it('reads Handled once the rerun landed — the reason kept, nothing left to press', () => {
    const html = card(HANDLED_LANDING);
    expect(html).toContain(`project-open-item-state is-handled">${HANDLED_TAG}<`);
    expect(html).toContain('project-open-item-card is-settled');
    expect(text(html)).toContain('the rerun of the landing landed');
    expect(text(html)).toContain(REASON);
    expect(text(html)).toContain('Handled by the coordinator · 12m ago');
    expect(html).not.toContain(HANDLING_TAG);
    for (const press of ['Retry', 'Cancel task', 'Open task session', 'Mark as handled']) {
      expect(text(html)).not.toContain(press);
    }
    // Still says what it was about.
    expect(text(html)).toContain('③ 实现所有者收尾门与 Done 优先语义');
  });

  it('reads Handled, closed by the coordinator with its reason, when no rerun ended it', () => {
    const html = card(CLOSED_BY_HAND);
    expect(text(html)).toContain('closed by the coordinator, with its reason');
    expect(text(html)).toContain('replayed onto the project branch by hand; the receipt is on the task');
  });
});

describe('a merge-into-main card, which names no task, through the coordinator’s handling', () => {
  it('reads Handling while the candidate’s check is queued again', () => {
    const html = card(HANDLING_PROMOTION);
    expect(html).toContain(`project-open-item-state is-handling">${HANDLING_TAG}<`);
    expect(text(html)).toContain('the re-check of the merge into main — generation 2 is queued · asked 1m ago');
    expect(text(html)).toContain('main’s merge-check baseline was repaired');
    expect(html).not.toContain(HANDLED_TAG);
  });

  it('reads Superseded once the re-check failed again, and points at the item that took its place', () => {
    const html = card(SUPERSEDED_PROMOTION);
    expect(html).toContain(`project-open-item-state is-superseded">${SUPERSEDED_TAG}<`);
    expect(text(html)).toContain('the re-check of the merge into main failed again — a new item took its place');
    expect(html).toContain('href="#open-item-34ZPromotionItem00002"');
    expect(text(html)).toContain('Superseded after the coordinator’s rerun · 2m ago');
    expect(html).not.toContain(`is-handled">${HANDLED_TAG}`);
  });

  it('reads Handled once the re-check passed', () => {
    const html = card(settled(PROMOTION, {
      ...SUPERSEDED_PROMOTION.outcome!,
      state: 'RESOLVED',
      resolution: 'HANDLED',
      supersededByItemId: null,
    }));
    expect(text(html)).toContain('the re-check of the merge into main passed');
    expect(html).not.toContain(SUPERSEDED_TAG);
  });
});

describe('an item the clock handed to the owner while the coordinator’s rerun ran', () => {
  it('is the owner’s card — Now yours — and says the rerun is still running, not that it was handled', () => {
    const html = card(ESCALATED_WHILE_HANDLING);
    expect(html).toContain('project-open-item-card is-owner');
    expect(text(html)).toContain('Now yours — no one acted on this for 2h');
    expect(text(html)).toContain('the rerun of the landing — generation 2 is running');
    expect(html).not.toContain(HANDLED_TAG);
    expect(text(html)).toContain('Ask the coordinator again');
    expect(isOwnerExceptionCard(ESCALATED_WHILE_HANDLING)).toBe(true);
  });
});

describe('where the settled cards are drawn', () => {
  const items: ProjectOpenItemsView = {
    needsYou: [],
    withCoordinator: [HANDLING_PROMOTION],
    settled: [HANDLED_LANDING, SUPERSEDED_PROMOTION, settled(ESCALATED_WHILE_HANDLING, SUPERSEDED_PROMOTION.outcome!)],
  };

  it('keeps them in the conversation, at the moment each happened, beside the open ones', () => {
    const rows = exceptionCardRows(items, [{ seq: 1, ts: at(60 * MINUTE) }]);
    expect(rows.map(({ row }) => row.itemId).sort()).toEqual(
      [
        HANDLED_LANDING.itemId,
        SUPERSEDED_PROMOTION.itemId,
        HANDLING_PROMOTION.itemId,
        ESCALATED_WHILE_HANDLING.itemId,
      ].sort(),
    );
  });

  it('never points the owner’s pinned line at a card that has ended, whoever held it last', () => {
    expect(items.settled!.filter(isOwnerExceptionCard)).toEqual([]);
  });

  it('leaves them off the project page’s Open items, where the handling row says Handling', () => {
    const html = paint(items, () => <ProjectOpenItems projectId={PROJECT_ID} now={NOW} />);
    expect(text(html)).toContain('0 need you · 1 with the coordinator · oldest first');
    expect(html).toContain(`project-open-item-state is-handling">${HANDLING_TAG}<`);
    expect(text(html)).toContain('the re-check of the merge into main — generation 2 is queued');
    expect(html).not.toContain(HANDLED_TAG);
    expect(html).not.toContain(SUPERSEDED_TAG);
  });
});
