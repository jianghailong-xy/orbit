// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ApprovalInfo } from '../api';
import { ApprovalPanel, answerableDecisionCards } from './ApprovalPanel';
import {
  CONFIRM_LABEL,
  DecisionStrip,
  NO_CARD_NOTE,
  POINTER_HINT,
  SEND_BACK_LABEL,
  decisionRowKey,
  revealDecisionCard,
  type PendingDecisionQueue,
  type PendingDecisionRow,
} from './DecisionRail';

/**
 * The pointer, end to end: the rail and the cards in one document, as the page composes them.
 *
 * `DecisionRail.test.tsx` renders the strip alone and can only ask what it PUT on screen. The two
 * claims this round has to make are about two components agreeing — the rail points at a handle
 * and the card publishes it — so neither file can hold them and this one renders both. The strip's
 * `hasCard` is not hand-fed either: it comes from `answerableDecisionCards`, the same function
 * `WorkspaceView` calls, over the same approvals it would hold.
 *
 * WHY THE "NO CARD" HALF IS THE POINT
 * -----------------------------------
 * The rail could decide without a live turn; that is what it gave up. So a pointer with nothing to
 * point at would be strictly worse than the button it replaced — a control that does nothing when
 * pressed, in place of one that worked. Every way a waiting row can lack a card is asserted below,
 * and what is asserted is not "the click is a no-op" but that there is no control to click.
 */

const TASK_A = '34LMiluvx0jK63cj8arWl';
const TASK_B = '34LVWtmeCNjbcCbCF2wDd';

function row(over: Partial<PendingDecisionRow> = {}): PendingDecisionRow {
  return {
    taskId: TASK_A,
    title: 'the decision door',
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
    decidingSessionId: 'coordinator-session',
    count: rows.length,
    oldestAgeSeconds: rows[0]?.ageSeconds ?? null,
    pending: rows,
    waitingOnYou: [],
  };
}

/** The tool input exactly as `buildEvidenceQuestion` shapes it: the two option labels, and the
 *  trailing identity line that is the only part of the body the card reads. */
function decisionApproval(id: string, rows: PendingDecisionRow[]): ApprovalInfo {
  return {
    id,
    toolName: 'AskUserQuestion',
    input: {
      questions: rows.map((r) => ({
        question: `${r.title} — task ${r.taskId}, evidence rev ${r.evidenceRevision}`,
        header: 'Completion',
        options: [
          { label: CONFIRM_LABEL, description: 'This evidence settles the criterion it quotes.' },
          { label: SEND_BACK_LABEL, description: 'It does not settle it.' },
        ],
        multiSelect: false,
      })),
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

afterEach(async () => {
  scrolled.length = 0;
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
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
 * The page in miniature: the pinned strip, and under it the approval cards, wired exactly the way
 * `WorkspaceView` wires them — including the one computation that decides whether a row is a
 * pointer at all.
 */
async function page({
  rows,
  approvals = [],
  answerable,
}: {
  rows: PendingDecisionRow[];
  approvals?: ApprovalInfo[];
  /** The approval ids whose turn is still listening. Defaults to all of them. */
  answerable?: string[];
}): Promise<HTMLElement> {
  const live = new Set(answerable ?? approvals.map((each) => each.id));
  const payload = queue(rows);
  const cards = answerableDecisionCards(approvals, live, payload);
  return mount(
    <>
      <DecisionStrip
        queue={payload}
        open
        hasCard={(each) => cards.has(decisionRowKey(each))}
        onToggle={() => {}}
        onReveal={(each) => revealDecisionCard(each)}
      />
      {approvals.map((approval) => (
        <ApprovalPanel
          key={approval.id}
          approval={approval}
          decisions={payload}
          answerable={live.has(approval.id)}
          onDecide={() => {}}
        />
      ))}
    </>,
  );
}

const strip = (scope: HTMLElement): HTMLElement =>
  scope.querySelector<HTMLElement>('.decision-strip')!;

const pointers = (scope: HTMLElement): HTMLButtonElement[] =>
  [...scope.querySelectorAll<HTMLButtonElement>('.decision-rail-pointer')];

/** The card section that carries this row's handle, or null when no card publishes it. */
const anchorFor = (scope: HTMLElement, r: PendingDecisionRow): HTMLElement | null =>
  scope.querySelector<HTMLElement>(`[data-decision-row="${decisionRowKey(r)}"]`);

async function click(button: HTMLElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('a row points at the card that answers it', () => {
  it('takes the reader to that row’s question when the row is pressed', async () => {
    const only = row();
    const scope = await page({ rows: [only], approvals: [decisionApproval('a1', [only])] });

    const anchor = anchorFor(scope, only);
    expect(anchor, 'the card publishes no handle for this row').not.toBeNull();
    // The anchor is the question inside the real decision card, not a marker put somewhere else.
    expect(anchor!.closest('.approval-card.decision-ask')).not.toBeNull();

    expect(scrolled).toEqual([]);
    await click(pointers(scope)[0]);

    // The assertion this test exists for: the jump HAPPENED, and it arrived at that card.
    expect(scrolled).toEqual([anchor]);
  });

  it('sends each row to its own question, not to the first one on the card', async () => {
    // One ask over two rows is one card with two questions. A pointer that landed on the card
    // would put a reader on somebody else's evidence and let them answer it.
    const a = row();
    const b = row({ taskId: TASK_B, title: 'the evidence envelope', evidenceRevision: '1' });
    const scope = await page({ rows: [a, b], approvals: [decisionApproval('a1', [a, b])] });

    expect(pointers(scope)).toHaveLength(2);
    await click(pointers(scope)[1]);

    expect(scrolled).toEqual([anchorFor(scope, b)]);
    expect(scrolled[0]).not.toBe(anchorFor(scope, a));
  });

  it('offers the pointer as a destination rather than as an answer', async () => {
    const only = row();
    const scope = await page({ rows: [only], approvals: [decisionApproval('a1', [only])] });

    expect(strip(scope).textContent).toContain(POINTER_HINT);
    // And pressing it wrote nothing: the strip still says exactly what it said, because a
    // navigation does not settle a question.
    await click(pointers(scope)[0]);
    expect(pointers(scope)).toHaveLength(1);
    expect(strip(scope).textContent).not.toContain(NO_CARD_NOTE);
  });
});

/**
 * The half the acceptance calls the core: what a waiting row is when there is no card.
 *
 * Every case below is a real thing that happens, and all of them come out of one computation over
 * facts the page already holds. What each asserts is the same three things: the row is still
 * there, it is NOT a control, and it says what has to happen before it becomes one.
 */
describe('a row with no card to reach is not a pointer', () => {
  const only = row();

  /** Nothing to press, and something to read, in whichever way the card is missing. */
  const expectInert = (scope: HTMLElement): void => {
    const rail = strip(scope);
    expect(rail.querySelector('.decision-rail-row'), 'the row itself is gone').not.toBeNull();
    expect(rail.textContent).toContain(only.title);
    expect(pointers(scope)).toHaveLength(0);
    expect(rail.querySelector('.decision-rail-inert')).not.toBeNull();
    // The only control left in the whole strip is the fold. Nothing inside the group is pressable
    // — which is the assertion, rather than "the click does nothing".
    expect([...rail.querySelectorAll('button')].map((each) => each.className)).toEqual([
      'decision-strip-line',
    ]);
    expect(rail.textContent).toContain(NO_CARD_NOTE);
    expect(scrolled).toEqual([]);
  };

  it('when the coordinator session is not running, or has not reached the call yet', async () => {
    // No approval is held for it at all. Both situations arrive here as the same input, because
    // both mean the same thing to a reader: the question has not been raised.
    expectInert(await page({ rows: [only] }));
  });

  it('when the turn that raised the card is over', async () => {
    // The card is still on screen and still says PENDING — the engine writes nothing when it
    // abandons a call — but nothing is listening for an answer, so it is not a place to send
    // anybody. The card itself says as much; the rail must not contradict it.
    const scope = await page({
      rows: [only],
      approvals: [decisionApproval('a1', [only])],
      answerable: [],
    });

    expect(anchorFor(scope, only), 'the dead card is still rendered').not.toBeNull();
    expectInert(scope);
  });

  it('when it was answered a moment ago and this read is still 20s old', async () => {
    // The answer drops the approval optimistically while the strip goes on showing the row until
    // its next poll. The pointer goes with the card, so the stale row loses its control rather
    // than keeping one aimed at something that is no longer there.
    expectInert(await page({ rows: [only], approvals: [] }));
  });

  it('when the card on screen names a revision this read no longer lists', async () => {
    // A decision is a compare-and-set against ONE version, and the guard against answering the
    // wrong one turns out to be layered. The ask names rev 1; the queue lists rev 2; so the card
    // matches no row this session may decide and `ApprovalPanel` does not recognise it as a
    // decision at all — it renders as the ordinary option form, which publishes no handle. The
    // rail therefore has nothing to point at, which is the right answer arrived at twice.
    const scope = await page({
      rows: [only],
      approvals: [decisionApproval('a1', [row({ evidenceRevision: '1' })])],
    });

    expect(scope.querySelector('.approval-card'), 'the approval is on screen').not.toBeNull();
    expect(scope.querySelector('.decision-ask-q'), 'it is not a decision card').toBeNull();
    expect(scope.querySelector('[data-decision-row]'), 'it publishes no handle').toBeNull();
    expectInert(scope);
  });

  it('does not throw or scroll if a reveal is asked for anyway', async () => {
    // The last line of defence: `hasCard` is computed at render and pressed a moment later, so it
    // can go stale. Reveal says it did not arrive instead of scrolling something else.
    await page({ rows: [only] });
    expect(revealDecisionCard(only)).toBe(false);
    expect(scrolled).toEqual([]);
  });
});

/**
 * The index itself, as a function: this is what makes the four cases above one answer rather than
 * four branches somebody has to remember to keep in step.
 */
describe('which cards a pointer may point at', () => {
  const only = row();

  it('names a row only when its card is held AND still answerable', () => {
    const approval = decisionApproval('a1', [only]);
    const key = decisionRowKey(only);

    expect([...answerableDecisionCards([approval], new Set(['a1']), queue([only]))]).toEqual([key]);
    expect(answerableDecisionCards([approval], new Set(), queue([only])).size).toBe(0);
    expect(answerableDecisionCards([], new Set(['a1']), queue([only])).size).toBe(0);
  });

  it('names nothing for an approval that is not one of these questions', () => {
    const other = {
      id: 'a2',
      toolName: 'Bash',
      input: { command: 'npm test' },
    } as ApprovalInfo;

    expect(answerableDecisionCards([other], new Set(['a2']), queue([only])).size).toBe(0);
  });

  it('names nothing without a queue to recognise the question by', () => {
    const approval = decisionApproval('a1', [only]);
    expect(answerableDecisionCards([approval], new Set(['a1']), null).size).toBe(0);
  });
});
