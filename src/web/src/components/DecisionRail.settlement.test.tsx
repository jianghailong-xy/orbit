import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_CONFIRMATION_TITLE,
  ACCEPTANCE_CONFIRM_LABEL,
  ACCEPTANCE_NOT_YET_LABEL,
} from './AcceptanceConfirmationCard';
import { CRITERIA_DECISION_HEADING, type PendingCriteriaDecisionQueue } from './CriteriaDecisionCard';
import {
  DecisionStrip,
  GO_TO_CARD_HINT,
  needsDecisionCount,
  waitingOnYouCount,
  wayPosition,
  type PendingDecisionQueue,
  type PendingDecisionRow,
} from './DecisionRail';

/**
 * What the settlement question puts in the strip, given the page's answer about its card — on a
 * desktop and on a phone, which draw the same line.
 *
 * `confirmation` is the card's own report, passed on by the page; `WorkspaceView.settlementPointer
 * .test.tsx` holds that wiring against the real card. What only a render of the strip can hold is
 * what the answer draws: one more in the count of a line that is a way to the cards and never an
 * answer, where it stands in the order the line names questions in, and no list under it on any
 * screen. Every assertion is a predicate over the rendered output, and every absence sits beside the
 * presence it is absent from.
 *
 * Evidence rows are given a card on screen (`hasCard`) wherever they are meant to count: the line
 * counts a row only where its card is, so a row without one would say nothing about this question.
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

/** One held weakening of the same project's criteria, which the owner can answer — filed a minute
 *  ago, so younger than every evidence row above. */
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

/** What the door says about evidence it would refuse whoever answered. */
const REFUSED = {
  decidable: false,
  refusal: 'this evidence quotes no project criterion',
  requiredAction: 'ASK_FOR_EVIDENCE_AGAINST_THE_CURRENT_CRITERION',
} as const;

type StripProps = Parameters<typeof DecisionStrip>[0];

/** The strip as the page draws it: the fold shut unless a case opens it, a desktop unless it says phone. */
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

/** The words the line names its question in: the text of its title span. */
function named(html: string): string | null {
  const match = /<span class="decision-strip-title">([^<]*)<\/span>/u.exec(html);
  return match ? match[1] : null;
}

/** The one kind of control the strip may carry, which moves the reader rather than writes: a line. */
const WAYS = ['decision-strip-line'];

function strayControls(html: string): string[] {
  return buttonTags(html).filter((tag) => !WAYS.some((cls) => tag.includes(cls)));
}

describe('the settlement question on the line', () => {
  it('is exactly one more in the count, and no row', () => {
    const without = render({ queue: queue(), open: true, hasCard: EVERY_CARD });
    const withIt = render({ queue: queue(), open: true, hasCard: EVERY_CARD, confirmation: true });

    expect(without).toContain(needsDecisionCount(2));
    expect(withIt).toContain(needsDecisionCount(3));
    expect(occurrences(withIt, 'decision-rail-row')).toBe(0);
    expect(withIt).not.toContain('decision-strip-body');
  });

  it('comes after every question that has an age, as its card comes after theirs', () => {
    // It has no age to give, so the line goes on naming the oldest evidence beside it.
    const html = render({ queue: queue(), hasCard: EVERY_CARD, confirmation: true });
    expect(named(html)).toBe('the decision door');
    expect(html).not.toContain(ACCEPTANCE_CONFIRMATION_TITLE);
    expect(html).toContain(wayPosition(1, 3));
  });

  it('draws the line on its own, in its card’s own words and with no age', () => {
    // Nothing waiting and no settlement question: no strip at all, the state this is the opposite of.
    expect(render({ queue: NOTHING })).toBe('');
    const html = render({ queue: NOTHING, open: true, confirmation: true });
    expect(named(html)).toBe(ACCEPTANCE_CONFIRMATION_TITLE);
    expect(html).toContain(needsDecisionCount(1));
    expect(html).toContain('decision-strip-dot');
    // No age, and one question has no position to stand in.
    expect(html).not.toContain('decision-strip-quiet');
    expect(buttonTags(html)).toHaveLength(1);
    expect(buttonTags(html)[0]).toContain(`title="${GO_TO_CARD_HINT}"`);
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

  it('renders no control other than the line', () => {
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

describe('the same line on a desktop and on a phone', () => {
  it('is one line whatever the fold was left at, and never a list', () => {
    for (const phone of [false, true]) {
      const screen = phone ? 'phone' : 'desktop';
      const html = render({
        queue: queue(),
        criteria: proposals(),
        open: true,
        phone,
        hasCard: EVERY_CARD,
        confirmation: true,
        onOpenCriteria: () => {},
      });

      expect(buttonTags(html), screen).toHaveLength(1);
      expect(html, screen).not.toContain('aria-expanded');
      expect(html, screen).not.toContain('decision-strip-body');
      expect(occurrences(html, 'decision-rail-row'), screen).toBe(0);
      // One question named, and one number for everything the line can reach: the weakening, two
      // evidence rows, the settlement question.
      expect(occurrences(html, 'decision-strip-title'), screen).toBe(1);
      expect(html, screen).toContain(needsDecisionCount(4));
      expect(html, screen).toContain(wayPosition(1, 4));
    }
  });

  it('names the weakening ahead of older evidence, because it moves the ruler the evidence is read against', () => {
    const html = render({
      queue: queue(),
      criteria: proposals(),
      hasCard: EVERY_CARD,
      onOpenCriteria: () => {},
    });
    expect(named(html)).toBe(CRITERIA_DECISION_HEADING);
    expect(html).toContain('>1m<');
    expect(html).not.toContain('the decision door');
  });

  it('counts only what the line can reach, and is not drawn when that is nothing', () => {
    for (const phone of [false, true]) {
      const screen = phone ? 'phone' : 'desktop';
      // Rows with no card on screen: nowhere for the press to go.
      expect(render({ queue: queue(), phone, hasCard: NO_CARDS }), screen).toBe('');
      // A row the door would refuse, whatever the page says about a card: nowhere to go either.
      const refused = queue({ pending: [row({ taskId: 'task-refused', decidability: { ...REFUSED } })] });
      expect(render({ queue: refused, phone, hasCard: EVERY_CARD }), screen).toBe('');
      // A weakening with no way given to open its card is not a question the line can take anyone to.
      expect(render({ queue: NOTHING, criteria: proposals(), phone }), screen).toBe('');
      // The settlement question is counted only while its card is there, so it is always reached.
      expect(render({ queue: queue(), phone, hasCard: NO_CARDS, confirmation: true }), screen)
        .toContain(needsDecisionCount(1));
    }
  });

  it('gives a row waiting on the reader’s own resubmission its fold on a desktop, and a phone no line for it', () => {
    const mine = queue({
      count: 0,
      pending: [],
      oldestAgeSeconds: null,
      waitingOnYou: [
        row({
          taskId: 'task-legacy',
          decidability: { ...REFUSED },
          independence: { independent: false, disqualification: 'this session is a run of the task it is deciding', requiredAction: 'DECIDE_FROM_A_SESSION_THAT_DID_NOT_DO_THIS_WORK' },
        }),
      ],
    });
    expect(render({ queue: mine })).toContain(waitingOnYouCount(1));
    expect(render({ queue: mine, phone: true })).toBe('');
  });
});
