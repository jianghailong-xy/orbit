import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CRITERIA_DECISION_RECORDED_HEADING,
  CriteriaDecisionReceipt,
  INLINE_DIFF_LEGEND,
  SETTLED_APPROVED_LEAD,
  SETTLED_DROPPED_WORDS_GONE,
  SETTLED_NOTHING_APPLIED,
  SETTLED_NO_BEFORE_WORDS,
  SETTLED_REFUSED_LEAD,
  settledSummary,
  type CriteriaProposalDiff,
  type SettledCriteriaDecision,
  type SettledDecisionDiff,
  type SettledProposalMaterial,
} from './CriteriaDecisionCard';

/**
 * WHAT A RECORDED DECISION STILL SHOWS OF ITSELF.
 *
 * Pressing Approve used to replace a card carrying a word-by-word diff with a single line of
 * receipt, so the moment the owner answered was the moment the change became unreadable — their
 * own report, 2026-09-17: after approving, you can no longer see what the change was. The receipt
 * now carries the proposal the answer was about, folded away, and this file pins the three things
 * that fold has to get right:
 *
 *   * CLOSED, it says in one line what the decision moved — the receipt's job is still the receipt;
 *   * OPEN, it names WHICH criteria, by the server's ordinal rather than by list position, with the
 *     words the answer was given about;
 *   * and it says, in the HTML and not only in a comment, that the words each rewrite replaced were
 *     never stored — because a reader shown one version of a sentence on a card whose live form
 *     showed two will otherwise read it as both.
 *
 * Static markup, no DOM, no network: the receipt is presentational and takes the answer as a prop,
 * which is what lets the assertions be about what reaches a screen. `<details>` is closed by
 * default in the markup — there is no `open` attribute — and its contents are in the document
 * either way, which is exactly why the collapsed line and the expanded rows can both be asserted
 * off one render.
 */

const INTENT = '4TdXP1ChQx7vLmN3pR5sT8';
const SEAL = '6b1d02e4c8a1f3d5b7e9a2c4f6081a3c5e7f9b1d3a5c7e9f1b3d5a7c9e1f3b5d';
const MOVED_SEAL = 'f'.repeat(64);
const REWORDED_TEXT = '两个新测试文件都存在且至少跑过一个用例';
const ADDED_TEXT = 'The settled card can be expanded into what this approved';

/** One reworded criterion out of fourteen, which is the shape of an ordinary weakening edit. */
function oneRewording(): SettledProposalMaterial {
  return {
    changed: [{ change: 'REWORDED', definitionId: 'def-5', ordinal: 5, text: REWORDED_TEXT }],
    rewordedCount: 1,
    addedCount: 0,
    droppedCount: 0,
    unchangedCount: 13,
  };
}

/** And one that moves three at once, including a criterion it takes out altogether. */
function threeMoves(): SettledProposalMaterial {
  return {
    changed: [
      { change: 'REWORDED', definitionId: 'def-2', ordinal: 2, text: REWORDED_TEXT },
      { change: 'ADDED', definitionId: null, ordinal: 4, text: ADDED_TEXT },
      { change: 'DROPPED', definitionId: 'def-9', ordinal: null, text: null },
    ],
    rewordedCount: 1,
    addedCount: 1,
    droppedCount: 1,
    unchangedCount: 11,
  };
}

function answered(
  decision: 'APPROVE' | 'REJECT',
  proposal: SettledProposalMaterial | null,
  diff?: SettledDecisionDiff,
): SettledCriteriaDecision {
  return {
    intentId: INTENT,
    decision,
    decidedAt: '2026-09-17T09:15:00.000Z',
    baseSeal: SEAL,
    resultingSeal: decision === 'APPROVE' ? MOVED_SEAL : SEAL,
    proposal,
    ...(diff ? { diff } : {}),
  };
}

/**
 * THE OTHER HALF, STORED: the words each rewrite replaced, as the decision recorded them.
 *
 * A decision answered since 0279 carries the diff it was given — the same shape the live card is
 * drawn from, cut into runs by the server. The cut below is one criterion rewritten in the middle:
 * two words kept on either end, a phrase dropped, a phrase put in its place.
 */
const WORDS_ON_RECORD = '每条迁移都在装载过的库上重放过';
const WORDS_PROPOSED = '每条迁移在有人问起时重放过';

function storedDiff(): SettledDecisionDiff {
  const diff: CriteriaProposalDiff = {
    entries: [
      {
        change: 'CHANGED',
        definitionId: 'def-5',
        ordinal: 5,
        proposed: {
          text: WORDS_PROPOSED, verificationMethod: 'EXECUTABLE',
          completionCriterionOverrideReason: null,
        },
        onRecord: {
          text: WORDS_ON_RECORD, verificationMethod: 'EXECUTABLE',
          completionCriterionOverrideReason: null,
        },
        changed: ['text'],
        rewrites: [{
          field: 'text',
          segments: [
            { side: 'KEPT', text: '每条迁移' },
            { side: 'REMOVED', text: '都在装载过的库上' },
            { side: 'ADDED', text: '在有人问起时' },
            { side: 'KEPT', text: '重放过' },
          ],
        }],
      },
    ],
    sameCount: 13,
    changedCount: 1,
    newCount: 0,
    removedCount: 0,
  };
  return { state: 'SNAPSHOT', diff };
}

const render = (settled: SettledCriteriaDecision): string =>
  renderToStaticMarkup(<CriteriaDecisionReceipt settled={settled} />);

describe('the receipt of an approved proposal', () => {
  it('says in one closed line which criterion moved and how much it left alone', () => {
    const html = render(answered('APPROVE', oneRewording()));

    // The whole point of the closed state: a reader who does not open it still learns what the
    // decision was about. The ordinal is IN the line, because one moved criterion is the whole
    // answer and "1 reworded" is a worse way of saying it.
    expect(html).toContain('<summary>What this approved · criterion 5 reworded · 13 criteria '
      + 'unchanged</summary>');
    // And the receipt is still a receipt.
    expect(html).toContain(CRITERIA_DECISION_RECORDED_HEADING);
    expect(html).toContain('Approved by you at');
    // Folded, not expanded: `<details open>` would push the receipt off the screen it shares with
    // a conversation.
    expect(html).not.toContain('<details open');
    expect(html).toContain('<details class="criteria-decision-unchanged">');
  });

  it('lists the criteria by the server’s ordinal, with the words the answer was given about', () => {
    const html = render(answered('APPROVE', threeMoves()));

    // `value` is the criterion's place in the PROPOSED set, not its place in a list of three: a
    // list that renumbered them 1. 2. 3. would be naming criteria nobody proposed.
    expect(html).toContain(`<li value="2" class="criteria-decision-entry">`);
    expect(html).toContain(`<li value="4" class="criteria-decision-entry">`);
    expect(html).toContain(REWORDED_TEXT);
    expect(html).toContain(ADDED_TEXT);
    // The three words are the ones the live card counts in, so the two cards say one vocabulary.
    expect(html).toContain('>reworded</span>');
    expect(html).toContain('>added</span>');
    expect(html).toContain('>dropped</span>');
    // A dropped criterion has no place in the proposed set and no words on record. It is listed
    // without a number rather than handed the next one going — a position in the very collection it
    // was being taken out of.
    expect(html).toContain(SETTLED_DROPPED_WORDS_GONE);
    expect(html).not.toContain('<li value="5"');
    // The summary counts when more than one moved; the ordinals are one disclosure away.
    expect(html).toContain('<summary>What this approved · 1 reworded, 1 dropped, 1 added · 11 '
      + 'criteria unchanged</summary>');
  });

  it('says the words each rewrite replaced were never stored', () => {
    const html = render(answered('APPROVE', oneRewording()));

    // The claim this card must not make is "here is the change". It is one side of it, and the
    // other side is not stored anywhere — so the card says so in the HTML a reader gets.
    expect(html).toContain(SETTLED_NO_BEFORE_WORDS);
    expect(html).toContain('not a before-and-after');
  });

  it('reuses the live card’s classes rather than a second set of visuals', () => {
    const html = render(answered('APPROVE', threeMoves()));

    for (const className of [
      'criteria-decision-unchanged',
      'criteria-decision-proposed',
      'criteria-decision-entry',
      'criteria-decision-text',
      'criteria-decision-new',
    ]) {
      expect(html).toContain(className);
    }
  });
});

describe('the receipt of a refused proposal', () => {
  it('reads as words that were turned down, with nothing applied', () => {
    const html = render(answered('REJECT', oneRewording()));

    expect(html).toContain(SETTLED_REFUSED_LEAD);
    expect(html).not.toContain(SETTLED_APPROVED_LEAD);
    // The material is the same either way, so the answer beside it is the whole of what stops a
    // list of criteria under a refusal from reading as what the project now states.
    expect(html).toContain(SETTLED_NOTHING_APPLIED);
    expect(html).toContain(REWORDED_TEXT);
    expect(html).toContain(SETTLED_NO_BEFORE_WORDS);
    expect(html).toContain('Refused by you at');
  });

  it('is the only one of the two that claims nothing was applied', () => {
    expect(render(answered('APPROVE', oneRewording()))).not.toContain(SETTLED_NOTHING_APPLIED);
  });
});

describe('the receipt of a decision that stored the diff it was answered against', () => {
  it('draws the two versions as one line, struck through and underlined', () => {
    const html = render(answered('APPROVE', oneRewording(), storedDiff()));

    // The point of the whole exercise: the words that were REPLACED are on the screen, in the
    // same two elements and the same two class names the live card marks them with.
    expect(html).toContain('criteria-decision-cut');
    expect(html).toContain('criteria-decision-add');
    expect(html).toContain('<del class="criteria-decision-cut"');
    expect(html).toContain('<ins class="criteria-decision-add"');
    expect(html).toContain('都在装载过的库上');
    expect(html).toContain('在有人问起时');
    // And the marks are explained, by the one line that says what a strikethrough means.
    expect(html).toContain(INLINE_DIFF_LEGEND);
    // This card is not the one-sided list, so the sentence that admits to being one would be a
    // false statement here: the before-words are right there, cut against the after-words.
    expect(html).not.toContain(SETTLED_NO_BEFORE_WORDS);
    // Still a receipt, still folded.
    expect(html).toContain(CRITERIA_DECISION_RECORDED_HEADING);
    expect(html).not.toContain('<details open');
    expect(html).toContain('<summary>What this approved · 1 reworded, 13 unchanged</summary>');
  });

  it('says of a refusal that none of it was applied, with the same comparison', () => {
    const html = render(answered('REJECT', oneRewording(), storedDiff()));

    expect(html).toContain(SETTLED_REFUSED_LEAD);
    expect(html).toContain(SETTLED_NOTHING_APPLIED);
    expect(html).toContain('criteria-decision-cut');
    expect(html).toContain('criteria-decision-add');
  });

  it('falls back to the one-sided list for an answer given before the diff was stored', () => {
    // `PREDATES_SNAPSHOT` is not an empty diff and must not be drawn as one: those decisions have
    // no before-words anywhere, which is exactly what task A's display exists to say.
    for (const settled of [
      answered('APPROVE', oneRewording(), { state: 'PREDATES_SNAPSHOT' }),
      answered('APPROVE', oneRewording(), { state: 'UNREADABLE' }),
      answered('APPROVE', oneRewording()),
    ]) {
      const html = render(settled);
      expect(html).toContain(SETTLED_NO_BEFORE_WORDS);
      expect(html).toContain(REWORDED_TEXT);
      expect(html).not.toContain('criteria-decision-cut');
      expect(html).not.toContain('criteria-decision-add');
    }
  });
});

describe('an answer whose proposal the read does not carry', () => {
  it('draws the receipt line and no fold at all', () => {
    // A server older than this bundle sends no `proposal`, and a row whose action could not be read
    // sends null. Neither is a reason to draw an empty disclosure promising something behind it.
    const older = { ...answered('APPROVE', null), proposal: undefined };
    for (const settled of [answered('APPROVE', null), older]) {
      const html = render(settled);
      expect(html).toContain(CRITERIA_DECISION_RECORDED_HEADING);
      expect(html).not.toContain('<details');
      expect(html).not.toContain(SETTLED_NO_BEFORE_WORDS);
    }
  });
});

describe('the folded line', () => {
  it('says a restatement that moved nothing moved nothing', () => {
    const summary = settledSummary(answered('APPROVE', {
      changed: [],
      rewordedCount: 0,
      addedCount: 0,
      droppedCount: 0,
      unchangedCount: 14,
    }));

    expect(summary).toBe('What this approved · nothing moves · 14 criteria unchanged');
  });

  it('counts one unchanged criterion in the singular', () => {
    const summary = settledSummary(answered('REJECT', { ...oneRewording(), unchangedCount: 1 }));

    expect(summary).toBe('What this refused · criterion 5 reworded · 1 criterion unchanged');
  });
});
