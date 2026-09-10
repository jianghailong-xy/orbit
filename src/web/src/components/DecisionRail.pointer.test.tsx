// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ApprovalInfo } from '../api';
import { pendingDecisionsQuery } from '../lib/queries';
import { ApprovalPanel } from './ApprovalPanel';
import {
  DecisionStrip,
  NO_CARD_NOTE,
  POINTER_HINT,
  decisionRowKey,
  revealDecisionCard,
  type PendingDecisionQueue,
  type PendingDecisionRow,
} from './DecisionRail';
import { SessionEvidenceDecisionCard, evidenceDecisionCardRows } from './EvidenceDecisionCard';

/**
 * The pointer, end to end: the rail and the evidence card in one document, as the page composes them.
 *
 * `DecisionRail.test.tsx` renders the strip alone and can only ask what it PUT on screen. The claim
 * this file makes is about two components agreeing — the rail points at a handle and the card
 * publishes it — so neither file can hold it and this one renders both. The strip's `hasCard` is
 * not hand-fed either: it is computed the way `WorkspaceView` computes it, with the card's own
 * filter (`evidenceDecisionCardRows`) over the read the card is drawn from.
 *
 * WHY THE "NO CARD" HALF IS THE POINT
 * -----------------------------------
 * The rail could decide without a live turn; that is what it gave up. So a pointer with nothing to
 * point at would be strictly worse than the button it replaced — a control that does nothing when
 * pressed, in place of one that worked. Every way a waiting row can lack a card in a conversation
 * is asserted below, and what is asserted is not "the click is a no-op" but that there is no
 * control to click.
 */

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const SESSION_ID = '34MOJw69NzKSq2X0exxf9';
const PROJECT_ID = '34MPiBgZ80YpSKt0lmTQA';
const OTHER_PROJECT_ID = '34LWcmLItBx6ytdO26XXF';
const TASK_A = '34LMiluvx0jK63cj8arWl';
const TASK_B = '34LVWtmeCNjbcCbCF2wDd';

function row(over: Partial<PendingDecisionRow> = {}): PendingDecisionRow {
  return {
    taskId: TASK_A,
    title: 'the decision door',
    projectId: PROJECT_ID,
    criterion: { key: '6KG2mjp63PrtVvGwxRLvFY', text: 'one decision surface, and this is not it' },
    evidenceRevision: '2',
    ageSeconds: 20 * 60,
    claim: 'the rail no longer posts a decision',
    gaps: [],
    citations: [
      { kind: 'TOOL_CALL', ref: 'toolu_held', resolved: true, reason: null, label: 'Bash · npm test' },
    ],
    decidability: { decidable: true, refusal: null, requiredAction: null },
    independence: { independent: true, disqualification: null, requiredAction: null },
    ...over,
  };
}

function queue(rows: PendingDecisionRow[]): PendingDecisionQueue {
  return {
    decidingSessionId: SESSION_ID,
    count: rows.length,
    oldestAgeSeconds: rows[0]?.ageSeconds ?? null,
    pending: rows,
    waitingOnYou: [],
  };
}

/** A question that reads like the verdict: the two answers the coordinator's ask used to offer, and
 *  the task and revision in its text. The page renders it as it renders every question. */
function lookalike(r: PendingDecisionRow): ApprovalInfo {
  return {
    id: 'approval-lookalike',
    toolName: 'AskUserQuestion',
    input: {
      questions: [{
        question: `${r.title} — task ${r.taskId}, evidence rev ${r.evidenceRevision}`,
        header: 'Completion',
        options: [
          { label: 'Confirm completion', description: 'This evidence settles the criterion it quotes.' },
          { label: 'Send back', description: 'It does not settle it.' },
        ],
        multiSelect: false,
      }],
    },
  } as ApprovalInfo;
}

/** Which elements were scrolled to, in order, and which one each call was made on. jsdom has no
 *  `scrollIntoView` at all, so this is the whole implementation rather than a spy over one. */
const scrolled: Element[] = [];

beforeAll(() => {
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = function (
    this: Element,
  ): void {
    scrolled.push(this);
  };
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const clients: QueryClient[] = [];

afterEach(async () => {
  scrolled.length = 0;
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  for (const qc of clients.splice(0)) qc.clear();
  apiMock.mockReset();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

async function mount(ui: JSX.Element): Promise<HTMLElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement('div');
  document.body.appendChild(node);
  const nextRoot = createRoot(node);
  container = node;
  root = nextRoot;
  await act(async () => nextRoot.render(ui));
  return node;
}

/**
 * The page in miniature: the pinned strip, the evidence card under it and any question cards after
 * that, over one read that has already come back — wired the way `WorkspaceView` wires them,
 * including the one computation that decides whether a row is a pointer at all.
 */
async function page({
  rows,
  projectId = PROJECT_ID,
  approvals = [],
}: {
  rows: PendingDecisionRow[];
  /** The project this session coordinates; null for an ordinary session. */
  projectId?: string | null;
  approvals?: ApprovalInfo[];
}): Promise<HTMLElement> {
  const payload = queue(rows);
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnMount: false, retryOnMount: false, refetchOnWindowFocus: false },
    },
  });
  clients.push(qc);
  qc.setQueryData(pendingDecisionsQuery(SESSION_ID).queryKey, payload);
  const cards = new Set(evidenceDecisionCardRows(payload, projectId).map(decisionRowKey));
  return mount(
    <QueryClientProvider client={qc}>
      <DecisionStrip
        queue={payload}
        open
        hasCard={(each) => cards.has(decisionRowKey(each))}
        onToggle={() => {}}
        onReveal={(each) => revealDecisionCard(each)}
      />
      <SessionEvidenceDecisionCard sessionId={SESSION_ID} projectId={projectId} />
      {approvals.map((approval) => (
        <ApprovalPanel key={approval.id} approval={approval} onDecide={() => {}} />
      ))}
    </QueryClientProvider>,
  );
}

const strip = (scope: HTMLElement): HTMLElement =>
  scope.querySelector<HTMLElement>('.decision-strip')!;

const pointers = (scope: HTMLElement): HTMLButtonElement[] =>
  [...scope.querySelectorAll<HTMLButtonElement>('.decision-rail-pointer')];

/** The element that carries this row's handle, or null when nothing on the page publishes it. */
const anchorFor = (scope: HTMLElement, r: PendingDecisionRow): HTMLElement | null =>
  scope.querySelector<HTMLElement>(`[data-decision-row="${decisionRowKey(r)}"]`);

async function click(button: HTMLElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('a row points at the evidence card that answers it', () => {
  it('takes the reader to the card Orbit drew for that row, not to a question that reads like one', async () => {
    const only = row();
    const scope = await page({ rows: [only], approvals: [lookalike(only)] });

    // One handle on the whole page, and it is the evidence card's root. The look-alike question is
    // on screen, as a question, and publishes none.
    const handles = [...scope.querySelectorAll<HTMLElement>('[data-decision-row]')];
    expect(handles).toHaveLength(1);
    const card = handles[0];
    expect(card.getAttribute('data-decision-row')).toBe(decisionRowKey(only));
    expect(card.matches('.approval-card.evidence-decision'), 'the handle is not the evidence card').toBe(true);
    expect(scope.querySelector('.chat-q-opt-btn'), 'the look-alike question is not on screen').not.toBeNull();

    expect(scrolled).toEqual([]);
    await click(pointers(scope)[0]);

    // The assertion this test exists for: the jump HAPPENED, and it arrived at that card.
    expect(scrolled).toEqual([card]);
    // Drawn from the read the page already holds: nothing was asked of the server to get here.
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('sends each row to its own card, not to the first one on the page', async () => {
    const a = row();
    const b = row({ taskId: TASK_B, title: 'the evidence envelope', evidenceRevision: '1' });
    const scope = await page({ rows: [a, b] });

    expect(pointers(scope)).toHaveLength(2);
    await click(pointers(scope)[1]);

    expect(scrolled).toEqual([anchorFor(scope, b)]);
    expect(scrolled[0]).not.toBe(anchorFor(scope, a));
  });

  it('offers the pointer as a destination rather than as an answer', async () => {
    const only = row();
    const scope = await page({ rows: [only] });

    expect(strip(scope).textContent).toContain(POINTER_HINT);
    // And pressing it wrote nothing: the strip still says exactly what it said, because a
    // navigation does not settle a question.
    await click(pointers(scope)[0]);
    expect(pointers(scope)).toHaveLength(1);
    expect(strip(scope).textContent).not.toContain(NO_CARD_NOTE);
  });
});

/**
 * The half the acceptance calls the core: what a waiting row is when this conversation draws no
 * card for it.
 *
 * Each case is a real thing that happens, and all of them come out of the card's own filter. What
 * each asserts is the same: the row is still there, it is NOT a control, it says where its card is
 * drawn, and nothing on the page carries its handle.
 */
describe('a row this conversation draws no card for is not a pointer', () => {
  /** Nothing to press, and something to read, whichever way the card is missing. */
  const expectInert = (scope: HTMLElement, r: PendingDecisionRow): void => {
    const rail = strip(scope);
    expect(rail.querySelector('.decision-rail-row'), 'the row itself is gone').not.toBeNull();
    expect(rail.textContent).toContain(r.title);
    expect(pointers(scope)).toHaveLength(0);
    expect(rail.querySelector('.decision-rail-inert')).not.toBeNull();
    // The only control left in the whole strip is the fold. Nothing inside the group is pressable
    // — which is the assertion, rather than "the click does nothing".
    expect([...rail.querySelectorAll('button')].map((each) => each.className)).toEqual([
      'decision-strip-line',
    ]);
    expect(rail.textContent).toContain(NO_CARD_NOTE);
    expect(anchorFor(scope, r), 'something on the page publishes this row’s handle').toBeNull();
    expect(scrolled).toEqual([]);
  };

  it('in a session that coordinates no project', async () => {
    // An ordinary conversation can still be handed rows it may decide; it draws a card for none.
    const only = row();
    expectInert(await page({ rows: [only], projectId: null }), only);
  });

  it('in a coordinator session, for a task filed under another project', async () => {
    const elsewhere = row({ projectId: OTHER_PROJECT_ID });
    expectInert(await page({ rows: [elsewhere] }), elsewhere);
  });

  it('in a coordinator session, for a task filed under no project', async () => {
    const unfiled = row({ projectId: null });
    expectInert(await page({ rows: [unfiled] }), unfiled);
  });

  it('does not throw or scroll if a reveal is asked for anyway', async () => {
    // The last line of defence: `hasCard` is computed at render and pressed a moment later, so it
    // can go stale. Reveal says it did not arrive instead of scrolling something else.
    const only = row();
    await page({ rows: [only], projectId: null });
    expect(revealDecisionCard(only)).toBe(false);
    expect(scrolled).toEqual([]);
  });
});
