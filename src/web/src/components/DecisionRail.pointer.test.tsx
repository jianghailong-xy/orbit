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
  GO_TO_CARD_HINT,
  GO_TO_NEXT_CARD_HINT,
  decisionRowKey,
  needsDecisionCount,
  revealDecisionCard,
  wayPosition,
  type PendingDecisionQueue,
  type PendingDecisionRow,
} from './DecisionRail';
import { SessionEvidenceDecisionCard, evidenceDecisionCardRows } from './EvidenceDecisionCard';

/**
 * The line, end to end: the strip and the evidence cards in one document, as the page composes them.
 *
 * `DecisionRail.test.tsx` renders the strip alone and can only ask what it PUT on screen. The claims
 * this file makes are about a press — the line points at a handle and the card publishes it, and
 * with several cards each press goes on to the next and the line names the one it went to — so
 * neither file can hold them and this one renders both. The strip's `hasCard` is not hand-fed either:
 * it is computed the way `WorkspaceView` computes it, with the card's own filter
 * (`evidenceDecisionCardRows`) over the read the card is drawn from.
 *
 * WHY THE "NO CARD" HALF IS THE POINT
 * -----------------------------------
 * The rail could decide without a live turn; that is what it gave up. So a pointer with nothing to
 * point at would be strictly worse than the button it replaced — a control that does nothing when
 * pressed, in place of one that worked. Every way a waiting row can lack a card in a conversation
 * is asserted below, and what is asserted is not "the click is a no-op" but that the question is
 * not in the line's count at all, and no press can reach for it.
 */

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const SESSION_ID = '34MOJw69NzKSq2X0exxf9';
const PROJECT_ID = '34MPiBgZ80YpSKt0lmTQA';
const OTHER_PROJECT_ID = '34LWcmLItBx6ytdO26XXF';
const TASK_A = '34LMiluvx0jK63cj8arWl';
const TASK_B = '34LVWtmeCNjbcCbCF2wDd';
const TASK_C = '34LXq2fT1wZbN8mUe5RkA';
const MINUTE = 60;

function row(over: Partial<PendingDecisionRow> = {}): PendingDecisionRow {
  return {
    taskId: TASK_A,
    title: 'the decision door',
    projectId: PROJECT_ID,
    criterion: { key: '6KG2mjp63PrtVvGwxRLvFY', text: 'one decision surface, and this is not it' },
    evidenceRevision: '2',
    ageSeconds: 20 * MINUTE,
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
/** Which elements were given the mark that says "this is the card the press meant", in order. jsdom
 *  has no Web Animations either, so this stands in for `animate`. */
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
let client: QueryClient | null = null;

afterEach(async () => {
  scrolled.length = 0;
  marked.length = 0;
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  client?.clear();
  client = null;
  apiMock.mockReset();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

interface PageProps {
  rows: PendingDecisionRow[];
  /** The project this session coordinates; null for an ordinary session. */
  projectId?: string | null;
  approvals?: ApprovalInfo[];
}

/**
 * The page in miniature: the pinned strip, the evidence cards under it and any question cards after
 * that, over one read that has already come back — wired the way `WorkspaceView` wires them,
 * including the one computation that decides whether a row is counted at all.
 */
function composition({ rows, projectId = PROJECT_ID, approvals = [] }: PageProps): JSX.Element {
  const payload = queue(rows);
  client!.setQueryData(pendingDecisionsQuery(SESSION_ID).queryKey, payload);
  const cards = new Set(evidenceDecisionCardRows(payload, projectId).map(decisionRowKey));
  return (
    <QueryClientProvider client={client!}>
      <DecisionStrip
        queue={payload}
        open={false}
        hasCard={(each) => cards.has(decisionRowKey(each))}
        onToggle={() => {}}
        onReveal={(each) => revealDecisionCard(each)}
      />
      <SessionEvidenceDecisionCard sessionId={SESSION_ID} projectId={projectId} />
      {approvals.map((approval) => (
        <ApprovalPanel key={approval.id} approval={approval} onDecide={() => {}} />
      ))}
    </QueryClientProvider>
  );
}

async function page(props: PageProps): Promise<HTMLElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnMount: false, retryOnMount: false, refetchOnWindowFocus: false },
    },
  });
  const node = document.createElement('div');
  document.body.appendChild(node);
  const nextRoot = createRoot(node);
  container = node;
  root = nextRoot;
  await act(async () => nextRoot.render(composition(props)));
  return node;
}

/** The same page after the read comes back different, with the strip still mounted — as a re-read
 *  arrives on a page that stays open. */
async function repage(props: PageProps): Promise<void> {
  await act(async () => root!.render(composition(props)));
}

const strip = (scope: HTMLElement): HTMLElement =>
  scope.querySelector<HTMLElement>('.decision-strip')!;

/** The line that goes to the cards. */
const line = (scope: HTMLElement): HTMLButtonElement =>
  scope.querySelector<HTMLButtonElement>('.decision-strip-line')!;

/** The question the line names, in its own words. */
const named = (scope: HTMLElement): string | null =>
  line(scope).querySelector('.decision-strip-title')?.textContent ?? null;

/** The element that carries this row's handle, or null when nothing on the page publishes it. */
const anchorFor = (scope: HTMLElement, r: PendingDecisionRow): HTMLElement | null =>
  scope.querySelector<HTMLElement>(`[data-decision-row="${decisionRowKey(r)}"]`);

async function click(button: HTMLElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('the line takes the reader to the evidence card that answers it', () => {
  it('goes to the card Orbit drew for that row, not to a question that reads like one', async () => {
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
    expect(named(scope)).toBe(only.title);

    expect(scrolled).toEqual([]);
    await click(line(scope));

    // The assertion this test exists for: the jump HAPPENED, and it arrived at that card.
    expect(scrolled).toEqual([card]);
    // And the card is marked as the one the press meant.
    expect(marked, 'the card the line went to is not marked').toEqual([card]);
    // Drawn from the read the page already holds: nothing was asked of the server to get here.
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('names the oldest first, goes to each card in turn, and names the one it went to', async () => {
    const a = row({ ageSeconds: 40 * MINUTE });
    const b = row({ taskId: TASK_B, title: 'the evidence envelope', evidenceRevision: '1', ageSeconds: 20 * MINUTE });
    const scope = await page({ rows: [a, b] });

    // Before any press: the oldest, where the first press goes, and how many there are.
    expect(named(scope)).toBe(a.title);
    expect(line(scope).textContent).toContain('40m');
    expect(line(scope).textContent).toContain(wayPosition(1, 2));
    expect(line(scope).getAttribute('aria-label')).toBe(`${needsDecisionCount(2)}: ${a.title}`);
    expect(line(scope).getAttribute('title')).toBe(GO_TO_CARD_HINT);

    await click(line(scope));
    expect(scrolled).toEqual([anchorFor(scope, a)]);
    expect(named(scope)).toBe(a.title);
    expect(line(scope).textContent).toContain(wayPosition(1, 2));
    // From here a press goes on, and the line says so.
    expect(line(scope).getAttribute('title')).toBe(GO_TO_NEXT_CARD_HINT);

    await click(line(scope));
    expect(scrolled).toEqual([anchorFor(scope, a), anchorFor(scope, b)]);
    expect(named(scope)).toBe(b.title);
    expect(line(scope).textContent).toContain('20m');
    expect(line(scope).textContent).toContain(wayPosition(2, 2));

    await click(line(scope));
    expect(scrolled.at(-1), 'the press after the last card did not go back to the first').toBe(anchorFor(scope, a));
    expect(named(scope)).toBe(a.title);
    expect(line(scope).textContent).toContain(wayPosition(1, 2));
    // Each press marked the card it went to, and only that one.
    expect(marked).toEqual([anchorFor(scope, a), anchorFor(scope, b), anchorFor(scope, a)]);

    // Three presses, and no list ever opened under the line; nothing was asked of the server.
    expect(strip(scope).querySelectorAll('.decision-strip-body, .decision-rail-row')).toHaveLength(0);
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('names the oldest whatever order the read arrived in, and goes there first', async () => {
    const newer = row({ taskId: TASK_B, title: 'the evidence envelope', evidenceRevision: '1', ageSeconds: 5 * MINUTE });
    const older = row({ ageSeconds: 3 * 60 * MINUTE });
    const scope = await page({ rows: [newer, older] });

    expect(named(scope)).toBe(older.title);
    expect(line(scope).textContent).toContain('3h');
    await click(line(scope));
    expect(scrolled).toEqual([anchorFor(scope, older)]);
  });

  it('names the first again when the card it last went to is answered in between', async () => {
    const a = row({ ageSeconds: 30 * MINUTE });
    const b = row({ taskId: TASK_B, title: 'the evidence envelope', evidenceRevision: '1', ageSeconds: 20 * MINUTE });
    const c = row({ taskId: TASK_C, title: 'the stalled inventory', evidenceRevision: '1', ageSeconds: 10 * MINUTE });
    const scope = await page({ rows: [a, b, c] });

    await click(line(scope));
    await click(line(scope));
    expect(scrolled.at(-1)).toBe(anchorFor(scope, b));
    expect(named(scope)).toBe(b.title);
    expect(line(scope).textContent).toContain(wayPosition(2, 3));

    // b is answered: the next read no longer has it, so the line cannot still be "on" it.
    await repage({ rows: [a, c] });
    expect(named(scope), 'the line still names a card that is no longer a question').toBe(a.title);
    expect(line(scope).getAttribute('aria-label')).toBe(`${needsDecisionCount(2)}: ${a.title}`);
    expect(line(scope).textContent).toContain(wayPosition(1, 2));

    await click(line(scope));
    expect(scrolled.at(-1)).toBe(anchorFor(scope, a));
    expect(named(scope)).toBe(a.title);
  });

  it('offers the line as a destination rather than as an answer', async () => {
    const only = row();
    const scope = await page({ rows: [only] });

    expect(line(scope).getAttribute('title')).toBe(GO_TO_CARD_HINT);
    expect(line(scope).textContent).toContain('20m');
    // Pressing it wrote nothing: a navigation does not settle a question, so the line says what it
    // said — and with one card there is no position to claim and no "next" to promise.
    await click(line(scope));
    expect(line(scope).getAttribute('aria-label')).toBe(`${needsDecisionCount(1)}: ${only.title}`);
    expect(line(scope).textContent).not.toMatch(/\d of \d/u);
    expect(line(scope).getAttribute('title')).toBe(GO_TO_CARD_HINT);
  });
});

/**
 * The half the acceptance calls the core: what a waiting row is when this conversation draws no
 * card for it.
 *
 * Each case is a real thing that happens, and all of them come out of the card's own filter. What
 * each asserts is the same: the row is not in the line's count, no press reaches for it, and
 * nothing on the page carries its handle.
 */
describe('a row this conversation draws no card for is not on its strip', () => {
  /** Nothing to press and nothing to read, whichever way the card is missing. */
  const expectAbsent = (scope: HTMLElement, r: PendingDecisionRow): void => {
    // The only row in the read, so the strip has nothing left to say and is not drawn at all.
    expect(scope.querySelector('.decision-strip'), 'the strip is still drawn').toBeNull();
    expect(scope.textContent).not.toContain(r.title);
    expect(anchorFor(scope, r), 'something on the page publishes this row’s handle').toBeNull();
    expect(scrolled).toEqual([]);
  };

  it('in a session that coordinates no project', async () => {
    // An ordinary conversation can still be handed rows it may decide; it draws a card for none.
    const only = row();
    expectAbsent(await page({ rows: [only], projectId: null }), only);
  });

  it('in a coordinator session, for a task filed under another project', async () => {
    const elsewhere = row({ projectId: OTHER_PROJECT_ID });
    expectAbsent(await page({ rows: [elsewhere] }), elsewhere);
  });

  it('in a coordinator session, for a task filed under no project', async () => {
    const unfiled = row({ projectId: null });
    expectAbsent(await page({ rows: [unfiled] }), unfiled);
  });

  it('counts only its own project’s row when the account has others waiting elsewhere, and goes only to its card', async () => {
    // The screenshot this came from: a coordinator leading with "5 needs your decision", every one
    // of them another project's task and none with a card in the conversation it sat above. The
    // others are older, and still not the one the line names.
    const own = row();
    const elsewhere = row({ taskId: TASK_B, title: 'the evidence envelope', projectId: OTHER_PROJECT_ID, ageSeconds: 90 * MINUTE });
    const unfiled = row({ taskId: TASK_C, title: 'the stalled inventory', projectId: null, ageSeconds: 60 * MINUTE });
    const scope = await page({ rows: [elsewhere, own, unfiled] });

    expect(line(scope).getAttribute('aria-label')).toBe(`${needsDecisionCount(1)}: ${own.title}`);
    await click(line(scope));
    await click(line(scope));
    expect(scrolled).toEqual([anchorFor(scope, own), anchorFor(scope, own)]);
    expect(scope.textContent).not.toContain(elsewhere.title);
    expect(scope.textContent).not.toContain(unfiled.title);
  });

  it('does not throw, scroll or mark anything if a reveal is asked for anyway', async () => {
    // The last line of defence: `hasCard` is computed at render and pressed a moment later, so it
    // can go stale. Reveal says it did not arrive instead of scrolling something else.
    const only = row();
    await page({ rows: [only], projectId: null });
    expect(revealDecisionCard(only)).toBe(false);
    expect(scrolled).toEqual([]);
    expect(marked).toEqual([]);
  });
});
