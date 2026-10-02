// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProjectOpenItemRow } from '@orbit/shared';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DecisionStrip,
  GO_TO_NEXT_CARD_HINT,
  needsDecisionCount,
  revealOpenItemCard,
  wayPosition,
  type ExceptionCardPointer,
  type PendingDecisionQueue,
  type PendingDecisionRow,
} from './DecisionRail';
import { ItemAsCard } from './ProjectProgressStatus';

/**
 * The cards the owner answers by pressing — an exception that became theirs, the pause only they
 * can lift — on the pinned line.
 *
 * These are drawn among the messages, at the moment each became the owner's, rather than at the
 * foot with the questions. The line pointed at questions only, so an escalation hours up the
 * conversation had nothing pointing at it on the web while the phone's bar pointed at the same card
 * (the account owner's report, 2026-10-02). The fixture is that report's escalation.
 *
 * Static renders for what the line says; jsdom, with the real cards under the strip as the page
 * draws them, for where a press goes.
 */

vi.mock('../api', () => ({ api: vi.fn() }));

const PROJECT_ID = '34ODoUKJGEsfbgcJDGS4q';
const HOUR = 3600;
const MINUTE = 60;

function item(over: Partial<ProjectOpenItemRow> = {}): ProjectOpenItemRow {
  return {
    itemId: '3mZLAZL3OvQix77hxsBQYH',
    kind: 'INTEGRATION_CHECK_FAILED',
    title: 'Checks failed on the combined tree: merging the project branch into main',
    detailLine: 'npm --prefix src/apiserver test exited 1 after 30m 3s',
    assignee: 'OWNER',
    assigneeReason: 'ESCALATED',
    waitingSince: '2026-10-01T19:41:40.338Z',
    escalateAt: null,
    escalatedAt: '2026-10-01T21:49:29.794Z',
    taskId: null,
    sessionId: null,
    promotionId: null,
    fuseEpisodeId: null,
    delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null },
    actions: ['ASK_COORDINATOR_AGAIN'],
    question: null,
    facts: null,
    ...over,
  };
}

const ESCALATED = item();
const PAUSED = item({
  itemId: '6fWujE4NBkVyzMWkL975oc',
  kind: 'FUSE_PAUSED',
  title: 'The coordinator paused itself',
  detailLine: 'It started 31 turns on its own today — the limit is 30.',
  assigneeReason: 'DEFAULT',
  waitingSince: '2026-10-02T00:40:00.000Z',
  escalatedAt: null,
  fuseEpisodeId: '5Grmtl4G1LatjDDEmX492i',
  actions: ['RESUME'],
});

const pointer = (
  row: ProjectOpenItemRow,
  above: boolean,
  ageSeconds: number | null = 3 * HOUR + 10 * MINUTE,
): ExceptionCardPointer => ({ row, ageSeconds, above });

function evidence(over: Partial<PendingDecisionRow> = {}): PendingDecisionRow {
  return {
    taskId: '34IovIcRNjv3rAC1vespN',
    title: 'the derived pending queue',
    projectId: PROJECT_ID,
    criterion: { key: '3t4PyphGUWQtzDGfvOLY9R', text: 'the pending queue is derived from facts' },
    evidenceRevision: '2',
    ageSeconds: 5 * HOUR,
    claim: 'the web render test passed',
    gaps: [],
    citations: [],
    decidability: { decidable: true, refusal: null, requiredAction: null },
    independence: { independent: true, disqualification: null, requiredAction: null },
    ...over,
  };
}

function queue(pending: PendingDecisionRow[] = []): PendingDecisionQueue {
  return {
    decidingSessionId: '61DehW1OsRMagU5WxOb2yZ',
    count: pending.length,
    oldestAgeSeconds: pending[0]?.ageSeconds ?? null,
    pending,
    waitingOnYou: [],
  };
}

const drawn = (exceptions: ExceptionCardPointer[], pending: PendingDecisionRow[] = []): string =>
  renderToStaticMarkup(
    <DecisionStrip
      queue={queue(pending)}
      open={false}
      hasCard={() => true}
      onToggle={() => {}}
      exceptions={exceptions}
    />,
  );

/** What the caret says, in a static render of the line. */
const caretOf = (html: string): string | undefined =>
  /class="decision-strip-caret"[^>]*>([^<]*)</u.exec(html)?.[1];

describe('the cards the owner presses, on the line', () => {
  it('names an escalation in its session row’s word, then the item, with how long it has been theirs', () => {
    const html = drawn([pointer(ESCALATED, true)]);
    expect(html).toContain(`>Escalated to you: ${ESCALATED.title}<`);
    expect(html).toContain('>3h 10m<');
    expect(html).toContain(
      `aria-label="${needsDecisionCount(1)}: Escalated to you: ${ESCALATED.title}"`,
    );
  });

  it('is drawn for an exception alone, with no question waiting', () => {
    expect(drawn([])).toBe('');
    expect(drawn([pointer(ESCALATED, false)])).toContain('decision-strip-line');
  });

  it('names the pause by its own title, which is its card’s heading', () => {
    const html = drawn([pointer(PAUSED, false, 19 * MINUTE)]);
    expect(html).toContain('>The coordinator paused itself<');
    expect(html).not.toContain('Escalated to you');
  });

  it('puts them ahead of every question, as the conversation draws them, and counts them all', () => {
    // The evidence row is older, and is still named second: its card waits at the foot of the
    // conversation, under every message — the exception's is among them.
    const html = drawn([pointer(ESCALATED, true)], [evidence()]);
    expect(html).toContain(`>Escalated to you: ${ESCALATED.title}<`);
    expect(html).not.toContain('>the derived pending queue<');
    expect(html).toContain(wayPosition(1, 2));
  });

  it('points up at a card above the reader, and down at one that is not', () => {
    expect(caretOf(drawn([pointer(ESCALATED, true)]))).toBe('↑');
    expect(caretOf(drawn([pointer(ESCALATED, false)]))).toBe('↓');
    // A question is never above: its card is at the foot.
    expect(caretOf(drawn([], [evidence()]))).toBe('↓');
  });
});

/** Which elements were scrolled to and marked, in order. jsdom has neither `scrollIntoView` nor Web
 *  Animations, so these are the whole implementations rather than spies over them. */
const scrolled: Element[] = [];
const marked: Element[] = [];

beforeAll(() => {
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = function (
    this: Element,
  ): void {
    scrolled.push(this);
  };
  (Element.prototype as unknown as { animate: () => unknown }).animate = function (
    this: Element,
  ): unknown {
    marked.push(this);
    return { pause() {}, play() {} };
  };
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  scrolled.length = 0;
  marked.length = 0;
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

/** The strip over the conversation's cards, wired the way `SessionDecisionStrip` wires the press. */
async function page(
  exceptions: ExceptionCardPointer[],
  pending: PendingDecisionRow[] = [],
): Promise<HTMLElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const node = document.createElement('div');
  document.body.appendChild(node);
  container = node;
  root = createRoot(node);
  await act(async () =>
    root!.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <DecisionStrip
            queue={queue(pending)}
            open={false}
            hasCard={() => true}
            onToggle={() => {}}
            exceptions={exceptions}
            onRevealException={(row) => revealOpenItemCard(row.itemId)}
          />
          {exceptions.map(({ row }) => (
            <ItemAsCard key={row.itemId} projectId={PROJECT_ID} row={row} now={Date.now()} />
          ))}
        </QueryClientProvider>
      </MemoryRouter>,
    ),
  );
  return node;
}

const line = (scope: HTMLElement): HTMLButtonElement =>
  scope.querySelector<HTMLButtonElement>('.decision-strip-line')!;

async function press(scope: HTMLElement): Promise<void> {
  await act(async () => {
    line(scope).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('a press goes to the card', () => {
  it('scrolls to the escalation’s card and marks it as the one the press meant', async () => {
    const scope = await page([pointer(ESCALATED, true)]);
    const card = scope.querySelector(`#open-item-${ESCALATED.itemId}`);
    expect(card, 'the escalation’s card is not on the page').not.toBeNull();

    await press(scope);
    expect(scrolled).toEqual([card]);
    expect(marked).toEqual([card]);
  });

  it('reaches the pause by the same handle, though its card has an id of its own', async () => {
    const scope = await page([pointer(PAUSED, true)]);
    const card = scope.querySelector(`#fuse-${PAUSED.itemId}`);
    expect(card, 'the pause’s card is not on the page').not.toBeNull();

    await press(scope);
    expect(scrolled).toEqual([card]);
  });

  it('points the caret at where the NEXT press goes once a press has gone somewhere', async () => {
    const scope = await page([pointer(ESCALATED, true)], [evidence()]);
    expect(line(scope).querySelector('.decision-strip-caret')?.textContent).toBe('↑');

    await press(scope);
    // The line names the card it went to; the next press goes down, to the question at the foot.
    expect(line(scope).querySelector('.decision-strip-title')?.textContent)
      .toBe(`Escalated to you: ${ESCALATED.title}`);
    expect(line(scope).getAttribute('title')).toBe(GO_TO_NEXT_CARD_HINT);
    expect(line(scope).querySelector('.decision-strip-caret')?.textContent).toBe('↓');
  });
});
