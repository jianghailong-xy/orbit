import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ACCEPTANCE_CONFIRM_LABEL, ACCEPTANCE_NOT_YET_LABEL } from './AcceptanceConfirmationCard';
import type { PendingCriteriaDecisionQueue } from './CriteriaDecisionCard';
import {
  DecisionStrip,
  NEEDS_DECISION_LABEL,
  POINTER_HINT,
  SETTLEMENT_ROW_LABEL,
  needsDecisionCount,
  waitingOnYouCount,
  type PendingDecisionQueue,
  type PendingDecisionRow,
} from './DecisionRail';

/**
 * What the settlement question puts in the strip, given the page's answer about its card — and, on
 * a phone, what the strip is at all.
 *
 * `confirmation` is the card's own report, passed on by the page; `WorkspaceView.settlementPointer
 * .test.tsx` holds that wiring against the real card. What only a render of the strip can hold is
 * what the answer draws: one more row and one more in the count, a row that is a way to the card and
 * never an answer, and on a phone a single line that no list opens under. Every assertion is a
 * predicate over the rendered output, and every absence sits beside the presence it is absent from.
 *
 * NO `../api` MOCK, as in `DecisionRail.test.tsx`: the strip takes its payload as props.
 */

const HOUR = 3600;
const PROJECT = '34LWcmLItBx6ytdO26XXF';
const SEAL = `4fc57753a6ec${'0'.repeat(52)}`;

function row(over: Partial<PendingDecisionRow> = {}): PendingDecisionRow {
  return {
    taskId: '34IovIcRNjv3rAC1vespN',
    title: 'the derived pending queue',
    projectId: PROJECT,
    criterion: { key: '3t4PyphGUWQtzDGfvOLY9R', text: 'the pending queue is derived from facts' },
    evidenceRevision: '2',
    ageSeconds: 90 * 60,
    claim: 'the web render test passed',
    gaps: [],
    citations: [],
    decidability: { decidable: true, refusal: null, requiredAction: null },
    independence: { independent: true, disqualification: null, requiredAction: null },
    ...over,
  };
}

/** Two evidence rows, oldest first, as the server hands them over. */
function queue(over: Partial<PendingDecisionQueue> = {}): PendingDecisionQueue {
  const pending = [
    row({ taskId: 'task-older', title: 'the decision door', ageSeconds: 3 * HOUR }),
    row({ taskId: 'task-newer', title: 'the evidence envelope', ageSeconds: 40 * 60 }),
  ];
  return {
    decidingSessionId: '61DehW1OsRMagU5WxOb2yZ',
    count: pending.length,
    oldestAgeSeconds: pending[0].ageSeconds,
    pending,
    waitingOnYou: [],
    ...over,
  };
}

const NOTHING = queue({ count: 0, pending: [], oldestAgeSeconds: null });

/** One held weakening of the same project's criteria, which the owner can answer. */
function proposals(): PendingCriteriaDecisionQueue {
  const wording = { text: 'the pg spec may be skipped', verificationMethod: 'EXECUTABLE', completionCriterionOverrideReason: null };
  return {
    readAt: '2026-09-11T03:10:00.000Z',
    projectId: PROJECT,
    count: 1,
    oldestAgeSeconds: 60,
    decidableCount: 1,
    pending: [
      {
        intentId: '2SXZNKDyOUtFL540SQ0oz6',
        projectId: PROJECT,
        commitToken: 'token-2SXZNKDyOUtFL540SQ0oz6',
        actionDigest: 'a'.repeat(64),
        filedAt: '2026-09-11T03:09:00.000Z',
        ageSeconds: 60,
        baselineSeal: SEAL,
        currentSeal: SEAL,
        proposed: [{ id: null, ordinal: 3, ...wording }],
        diff: {
          entries: [{ change: 'NEW', definitionId: null, ordinal: 3, proposed: wording, onRecord: null, changed: [], rewrites: [] }],
          sameCount: 2,
          changedCount: 0,
          newCount: 1,
          removedCount: 0,
        },
        supersededIntentId: null,
        decidability: { decidable: true, refusal: null, requiredAction: null },
      },
    ],
  };
}

type StripProps = Parameters<typeof DecisionStrip>[0];

/** The strip as the page draws it: folded unless a case opens it, a desktop unless it says phone. */
const render = (props: Partial<StripProps> & { queue: PendingDecisionQueue }): string =>
  renderToStaticMarkup(<DecisionStrip open={false} onToggle={() => {}} {...props} />);

const EVERY_CARD = (): boolean => true;
const NO_CARDS = (): boolean => false;

function occurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

/** Every `<button>` in the output, as its opening tag: a census, so a control worded differently or
 *  left `disabled` is found as surely as one labelled Confirm. */
function buttonTags(html: string): string[] {
  return html
    .split('<button')
    .slice(1)
    .map((chunk) => `<button${chunk.split('>')[0]}>`);
}

/** The controls the strip may carry, every one of which moves the reader rather than writes: the
 *  fold, a row pointing at its card, and a weakening's way to its card. */
const WAYS = ['decision-strip-line', 'decision-rail-pointer', 'decision-rail-criteria-summary'];

function strayControls(html: string): string[] {
  return buttonTags(html).filter((tag) => !WAYS.some((cls) => tag.includes(cls)));
}

describe('the settlement question in the strip', () => {
  it('is exactly one more row, and one more in the count', () => {
    const without = render({ queue: queue(), open: true, hasCard: EVERY_CARD });
    const withIt = render({ queue: queue(), open: true, hasCard: EVERY_CARD, confirmation: true });

    expect(occurrences(withIt, 'decision-rail-row')).toBe(occurrences(without, 'decision-rail-row') + 1);
    expect(occurrences(withIt, SETTLEMENT_ROW_LABEL)).toBe(1);
    expect(without).not.toContain(SETTLEMENT_ROW_LABEL);
    expect(render({ queue: queue(), confirmation: true })).toContain(needsDecisionCount(3));
    expect(render({ queue: queue() })).toContain(needsDecisionCount(2));
  });

  it('is a way to its card, said as where it goes', () => {
    const html = render({ queue: NOTHING, open: true, confirmation: true });
    const at = html.indexOf(SETTLEMENT_ROW_LABEL);
    expect(at).toBeGreaterThan(-1);
    const button = html.slice(html.lastIndexOf('<button', at), html.indexOf('</button>', at));
    expect(button).toContain('decision-rail-pointer');
    expect(button).toContain(POINTER_HINT);
  });

  it('draws the strip on its own, under a heading that claims no age for it', () => {
    // Nothing waiting and no settlement question: no strip at all, the state this is the opposite of.
    expect(render({ queue: NOTHING })).toBe('');
    const folded = render({ queue: NOTHING, confirmation: true });
    expect(folded).toContain(needsDecisionCount(1));
    expect(folded).toContain('decision-strip-dot');
    const opened = render({ queue: NOTHING, open: true, confirmation: true });
    expect(opened).toContain(NEEDS_DECISION_LABEL);
    expect(occurrences(opened, 'decision-rail-row')).toBe(1);
    // Its card does not know when settlement began to wait on it, so the heading does not say.
    expect(opened).not.toContain('oldest');
    // Beside rows that have an age, the heading still leads with theirs.
    expect(render({ queue: queue(), open: true, confirmation: true })).toContain('oldest 3h');
  });
});

describe('nothing the settlement question puts in the strip answers it', () => {
  /** Every shape the question can give the strip, so the census is asked of all of them. */
  const everyState = (): string[] => [
    render({ queue: NOTHING, confirmation: true }),
    render({ queue: NOTHING, open: true, confirmation: true }),
    render({ queue: queue(), open: true, hasCard: NO_CARDS, confirmation: true }),
    render({ queue: queue(), criteria: proposals(), open: true, hasCard: EVERY_CARD, confirmation: true, onOpenCriteria: () => {} }),
    render({ queue: NOTHING, phone: true, confirmation: true }),
    render({ queue: queue(), criteria: proposals(), phone: true, hasCard: EVERY_CARD, confirmation: true, onOpenCriteria: () => {} }),
  ];

  it('renders no control other than the fold and the ways to a card', () => {
    for (const html of everyState()) {
      // Drawn, so the census below is asked of a strip and not of an empty string.
      expect(html).toContain('decision-strip-line');
      expect(strayControls(html)).toEqual([]);
    }
  });

  it('never carries the card’s own actions as words', () => {
    for (const html of everyState()) {
      expect(html).not.toContain(ACCEPTANCE_CONFIRM_LABEL);
      expect(html).not.toContain(ACCEPTANCE_NOT_YET_LABEL);
    }
  });
});

describe('on a phone', () => {
  it('is one line whatever the fold was left at, and never a list', () => {
    const html = render({
      queue: queue(),
      criteria: proposals(),
      open: true,
      phone: true,
      hasCard: EVERY_CARD,
      confirmation: true,
      onOpenCriteria: () => {},
    });

    expect(buttonTags(html)).toHaveLength(1);
    expect(html).toContain('decision-strip-line');
    expect(html).not.toContain('aria-expanded');
    expect(html).not.toContain('decision-strip-body');
    expect(occurrences(html, 'decision-rail-row')).toBe(0);
    expect(html).not.toContain(SETTLEMENT_ROW_LABEL);
    // One number, for everything the line can reach: the weakening, two evidence rows, the settlement question.
    expect(occurrences(html, 'decision-strip-count')).toBe(1);
    expect(html).toContain(needsDecisionCount(4));
  });

  it('counts only what the line can reach, and is not drawn when that is nothing', () => {
    // The same rows with no card on screen: a desktop lists them, with the sentence saying why.
    expect(render({ queue: queue(), open: true, hasCard: NO_CARDS })).toContain('decision-rail-inert');
    expect(render({ queue: queue(), phone: true, hasCard: NO_CARDS })).toBe('');

    // A row waiting on this reader's own resubmission is never a way to a card either.
    const mine = queue({
      count: 0,
      pending: [],
      oldestAgeSeconds: null,
      waitingOnYou: [
        row({
          taskId: 'task-legacy',
          decidability: { decidable: false, refusal: 'this evidence quotes no project criterion', requiredAction: 'ASK_FOR_EVIDENCE_AGAINST_THE_CURRENT_CRITERION' },
          independence: { independent: false, disqualification: 'this session is a run of the task it is deciding', requiredAction: 'DECIDE_FROM_A_SESSION_THAT_DID_NOT_DO_THIS_WORK' },
        }),
      ],
    });
    expect(render({ queue: mine })).toContain(waitingOnYouCount(1));
    expect(render({ queue: mine, phone: true })).toBe('');

    // The settlement question is counted only while its card is there, so it is always reached.
    expect(render({ queue: queue(), phone: true, hasCard: NO_CARDS, confirmation: true })).toContain(needsDecisionCount(1));
  });
});
