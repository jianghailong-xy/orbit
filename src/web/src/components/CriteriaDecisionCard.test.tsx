import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  APPROVE_LABEL,
  CRITERIA_DECISION_ALREADY_SETTLED,
  CRITERIA_DECISION_BASE_SEAL_MOVED,
  CRITERIA_DECISION_HEADING,
  CRITERIA_DECISION_STALE_HEADING,
  CRITERION_ADDED_LABEL,
  CRITERION_DROPPED_LABEL,
  CRITERION_REWORDED_LABEL,
  CriteriaDecisionCard,
  DROPPED_RUN_TITLE,
  INLINE_DIFF_LEGEND,
  METHOD_LABEL,
  PROVENANCE_LABEL,
  REFUSE_LABEL,
  changeSummary,
  criteriaApprovedLine,
  criteriaDecisionRequest,
  criteriaDecisionStanding,
  criteriaRefusedLine,
  isAnswerable,
  shortSeal,
  unchangedLine,
  type CriteriaDecisionResult,
  type CriteriaDecisionStanding,
  type CriteriaProposalChangeEntry,
  type CriteriaProposalDiff,
  type CriterionSegment,
  type PendingCriteriaDecisionQueue,
  type PendingCriteriaDecisionRow,
  type ProposedCriterion,
} from './CriteriaDecisionCard';
import {
  CRITERIA_ROW_LABEL,
  DecisionStrip,
  NEEDS_DECISION_LABEL,
  needsDecisionCount,
  type PendingDecisionQueue,
} from './DecisionRail';

/**
 * What the delivered card puts on screen, and — the half this file exists for — what it REFUSES to
 * offer once the question it was about has moved on.
 *
 * The three ways a delivered card goes stale are the three ways a person ends up pressing a button
 * that cannot work: somebody answered it in another window, a newer proposal displaced it, or the
 * ruler it was composed against stopped being the ruler in force. None of them writes anything to
 * this browser, so none of them can be noticed by a card holding a frozen copy of what it was
 * delivered with. Every test below therefore feeds a DERIVED READ and an address, and asserts what
 * the card concludes from them — which is the whole design in one sentence: the frame keeps the
 * address, the read decides everything else.
 *
 * Assertions are predicates over the rendered output — this control is disabled, that word is
 * present, this string is absent — rather than paragraphs pinned verbatim, so a typo fix does not
 * fail and a lying screen does not pass.
 *
 * The positive control is not decoration: the decidable case asserts both actions ENABLED, so the
 * three disabled assertions can actually fail. Without it a card that rendered every button dead
 * would pass this file.
 *
 * NO `../api` MOCK and none needed. The card takes its standing as a prop and issues no request;
 * what a press would send is asserted through `criteriaDecisionRequest`, which is that request as
 * data. The last test in the file holds both properties in place.
 */

const SEAL_DRAFTED = '6b1d02e4c8a1f3d5b7e9a2c4f6081a3c5e7f9b1d3a5c7e9f1b3d5a7c9e1f3b5d';
const SEAL_MOVED = '9c4f7a1b2d3e4f5061728394a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e';
const CRITERION_TEXT = 'Full API is green on the merge boundary';

function proposed(over: Partial<ProposedCriterion> = {}): ProposedCriterion {
  return {
    id: '3t4PyphGUWQtzDGfvOLY9R',
    ordinal: 1,
    text: CRITERION_TEXT,
    verificationMethod: 'EXECUTABLE',
    completionCriterionOverrideReason: null,
    ...over,
  };
}

/** One entry of the server's diff. `change` and `changed` are the server's conclusion, never one
 *  this file recomputes: a test that diffed the two sides itself would be testing its own diff. */
function entry(over: Partial<CriteriaProposalChangeEntry> = {}): CriteriaProposalChangeEntry {
  return {
    change: 'SAME',
    definitionId: '3t4PyphGUWQtzDGfvOLY9R',
    ordinal: 1,
    proposed: { text: CRITERION_TEXT, verificationMethod: 'EXECUTABLE',
      completionCriterionOverrideReason: null },
    onRecord: { text: CRITERION_TEXT, verificationMethod: 'EXECUTABLE',
      completionCriterionOverrideReason: null },
    changed: [],
    rewrites: [],
    ...over,
  };
}

/** The counts as the server publishes them: taken over the entries, so the two cannot disagree. */
function diffOf(entries: CriteriaProposalChangeEntry[]): CriteriaProposalDiff {
  const counted = (change: CriteriaProposalChangeEntry['change']): number =>
    entries.filter((each) => each.change === change).length;
  return {
    entries,
    sameCount: counted('SAME'),
    changedCount: counted('CHANGED'),
    newCount: counted('NEW'),
    removedCount: counted('REMOVED'),
  };
}

function row(over: Partial<PendingCriteriaDecisionRow> = {}): PendingCriteriaDecisionRow {
  return {
    intentId: '7f3a91c2-1d4e-4a6b-8c9d-0e1f2a3b4c5d',
    projectId: '34LWcmLItBx6ytdO26XXF',
    commitToken: 'b81c7d2e-3f4a-4b5c-9d6e-7f8091a2b3c4',
    actionDigest: 'a'.repeat(64),
    filedAt: '2026-09-09T01:14:24.471Z',
    ageSeconds: 12 * 60,
    baselineSeal: SEAL_DRAFTED,
    currentSeal: SEAL_DRAFTED,
    proposed: [proposed(), proposed({ id: null, ordinal: 2, text: 'the scheduled nodes are green' })],
    diff: diffOf([
      entry({ change: 'CHANGED', changed: ['text'],
        onRecord: { text: 'Full API was green last week', verificationMethod: 'EXECUTABLE',
          completionCriterionOverrideReason: null },
        rewrites: [{ field: 'text', segments: [
          { side: 'KEPT', text: 'Full API ' },
          { side: 'REMOVED', text: 'was green last week' },
          { side: 'ADDED', text: 'is green on the merge boundary' },
        ] }] }),
      entry({ change: 'NEW', definitionId: null, ordinal: 2, onRecord: null,
        proposed: { text: 'the scheduled nodes are green', verificationMethod: 'EXECUTABLE',
          completionCriterionOverrideReason: null } }),
    ]),
    supersededIntentId: null,
    decidability: { decidable: true, refusal: null, requiredAction: null },
    ...over,
  };
}

function queue(rows: PendingCriteriaDecisionRow[]): PendingCriteriaDecisionQueue {
  return {
    readAt: '2026-09-09T03:56:08.733Z',
    projectId: '34LWcmLItBx6ytdO26XXF',
    count: rows.length,
    oldestAgeSeconds: rows.length === 0 ? null : rows[0].ageSeconds,
    decidableCount: rows.filter((each) => each.decidability.decidable).length,
    pending: rows,
  };
}

function card(standing: CriteriaDecisionStanding): string {
  return renderToStaticMarkup(<CriteriaDecisionCard standing={standing} onDecide={() => {}} />);
}

/**
 * A string as it appears in the markup rather than as it is written in source.
 *
 * `Approve & re-seal` is `Approve &amp; re-seal` once rendered, so a search for the raw label finds
 * nothing — which quietly turns every `not.toContain(label)` in this file into a test that cannot
 * fail. Escaping is what keeps those assertions about the screen instead of about ampersands.
 */
function escaped(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#x27;');
}

/** The opening tag of the button carrying this label, so `disabled` can be asked about. */
function buttonFor(html: string, label: string): string {
  const at = html.indexOf(escaped(label));
  expect(at, `no control labelled ${label}`).toBeGreaterThan(-1);
  const opened = html.lastIndexOf('<button', at);
  expect(opened, `${label} is not inside a button`).toBeGreaterThan(-1);
  return html.slice(opened, html.indexOf('>', opened) + 1);
}

function isDisabled(html: string, label: string): boolean {
  return /\bdisabled\b/u.test(buttonFor(html, label));
}

/** Both spellings, because the web suite runs from `src/web` and a runner may start at the root. */
function fromRepo(...candidates: string[]): string {
  const found = candidates.map((each) => resolve(process.cwd(), each)).find(existsSync);
  if (!found) throw new Error(`none of ${candidates.join(', ')} exists from ${process.cwd()}`);
  return readFileSync(found, 'utf8');
}

/**
 * The one real proposal, as it was filed and answered, read off the file the server's spec replays.
 *
 * Shared rather than restated so that "the same input" is one fact on disk instead of two examples
 * that drift. `retains` names the ordinal on record whose definition id a proposed criterion reuses
 * (null would be an addition); the definition ids themselves are the fixture project's and are not
 * what this card is about, so they are spelled here as stable stand-ins.
 */
interface RecordedProposal {
  intentPublicId: string;
  onRecord: Array<{ ordinal: number; text: string; verificationMethod: string }>;
  proposed: Array<{
    ordinal: number; retains: number | null; text: string; verificationMethod: string;
  }>;
  expected: {
    sameCount: number; changedCount: number; newCount: number; removedCount: number;
    entries: Array<{
      ordinal: number;
      change: CriteriaProposalChangeEntry['change'];
      changed: CriteriaProposalChangeEntry['changed'];
      /** The clause a person said moved, and the server's cut of it — see the fixture's note. */
      movedClause?: { removed: string; added: string };
      rewrites?: CriteriaProposalChangeEntry['rewrites'];
    }>;
  };
}

function realProposal(): PendingCriteriaDecisionRow {
  const recorded = JSON.parse(fromRepo(
    'src/apiserver/src/projects/criteria-weakening-1GB4IZ4B.fixture.json',
    '../apiserver/src/projects/criteria-weakening-1GB4IZ4B.fixture.json',
  )) as RecordedProposal;
  const onRecord = new Map(recorded.onRecord.map((each) => [each.ordinal, each]));
  const entries = recorded.proposed.map((each, index) => {
    const verdict = recorded.expected.entries[index]!;
    const was = each.retains === null ? null : onRecord.get(each.retains)!;
    return entry({
      change: verdict.change,
      changed: verdict.changed,
      // Fed in as the SERVER's cut, off the same file its own spec pins it with. This file must
      // not compute one: the card's claim is that the comparison came from the derived read.
      rewrites: verdict.rewrites ?? [],
      definitionId: was ? `definition-${was.ordinal}` : null,
      ordinal: each.ordinal,
      proposed: { text: each.text, verificationMethod: each.verificationMethod,
        completionCriterionOverrideReason: null },
      onRecord: was
        ? { text: was.text, verificationMethod: was.verificationMethod,
          completionCriterionOverrideReason: null }
        : null,
    });
  });
  return row({
    proposed: recorded.proposed.map((each) => proposed({
      id: each.retains === null ? null : `definition-${each.retains}`,
      ordinal: each.ordinal,
      text: each.text,
      verificationMethod: each.verificationMethod,
    })),
    diff: diffOf(entries),
  });
}

/**
 * The rows the card draws WITHOUT anything being opened — the whole of what "only what changed"
 * means, measured as markup rather than as a count this file was handed.
 *
 * `criteria-decision-entry` is on the moved rows and on no others, so the folded ones are outside
 * this set even though they are in the document: `<details>` keeps them off screen, and a check
 * that counted every `<li>` would pass on the card this one rejects.
 */
function entryRows(html: string): string[] {
  return [...html.matchAll(/<li[^>]*class="criteria-decision-entry[^"]*"[^>]*>/gu)]
    .map((match) => match[0]);
}

/** The number a row is drawn with: the server's ordinal, not this list's position. */
function ordinalOf(tag: string): number {
  const found = /value="(\d+)"/u.exec(tag);
  expect(found, `no ordinal on ${tag}`).not.toBeNull();
  return Number(found![1]);
}

/** Selector/body pairs, comments stripped so a rule cannot be satisfied by a sentence about it. */
function rules(css: string): Array<{ selector: string; body: string }> {
  const found: Array<{ selector: string; body: string }> = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/gu;
  const stripped = css.replace(/\/\*[\s\S]*?\*\//gu, '');
  for (let match = pattern.exec(stripped); match; match = pattern.exec(stripped)) {
    found.push({ selector: match[1].trim(), body: match[2] });
  }
  return found;
}

describe('a proposal the door would answer', () => {
  const live = row();
  const standing = criteriaDecisionStanding(queue([live]), live.intentId);

  it('is the one state whose actions can be pressed', () => {
    // The positive control for every `disabled` assertion below it.
    expect(standing.state).toBe('DECIDABLE');
    expect(isAnswerable(standing)).toBe(true);
    const html = card(standing);
    expect(isDisabled(html, APPROVE_LABEL)).toBe(false);
    expect(isDisabled(html, REFUSE_LABEL)).toBe(false);
    expect(html).toContain(CRITERIA_DECISION_HEADING);
  });

  it('shows what is being proposed, and that nothing is held up meanwhile', () => {
    const html = card(standing);
    // The words a rewrite proposes are on the card, cut into the runs that moved and the runs that
    // did not — a search for the whole sentence would be asserting the layout this card replaced.
    expect(html).toContain('Full API ');
    expect(html).toContain('is green on the merge boundary');
    expect(html).toContain(shortSeal(SEAL_DRAFTED));
    // A criterion the proposal is ADDING is marked as one rather than reading as an edit.
    expect(html).toContain(CRITERION_ADDED_LABEL);
    // The sentence readers get wrong: refusing stops the ruler, not the work.
    expect(html.toLowerCase()).toContain('nothing is on hold');
  });
});

/**
 * THE CARD IS A DIFF, AND THE ONE REAL EDIT ORBIT HELD IS WHAT IT IS MEASURED ON.
 *
 * The first weakening proposal Orbit ever held restated eight criteria to reword three of them, and
 * the card laid out all eight with their verification methods — so the three that moved were buried
 * inside a 360px scroll box, and reading to the end did not tell anybody which three they were. The
 * account owner's words were "it should only show what changed".
 *
 * That proposal is on disk (`criteria-weakening-1GB4IZ4B.fixture.json`), because it was approved and
 * so cannot be read back out of the pending queue, and because the same file is what the server's
 * own spec replays through the write path. Both ends are pinned to one recorded fact rather than to
 * two hand-made examples that can drift apart.
 *
 * WHAT IS AND IS NOT ASSERTED HERE. `change` and `changed` are fed in as the SERVER's conclusion,
 * never recomputed from the two sides — a test that diffed them itself would be testing its own
 * diff, and the rule this surface is built on is that the comparison is the server's.
 */
describe('a proposal that restates eight criteria to reword three', () => {
  const real = realProposal();

  it('is fed to the card as the whole restatement, so folding it is the card’s doing', () => {
    // The positive control under every count below: the input really is all eight.
    expect(real.diff.entries.length).toBe(8);
    expect(real.proposed.length).toBe(8);
    expect([real.diff.changedCount, real.diff.sameCount, real.diff.newCount,
      real.diff.removedCount]).toEqual([3, 5, 0, 0]);
  });

  it('draws three rows and not eight, and says how many it left alone', () => {
    const html = card(criteriaDecisionStanding(queue([real]), real.intentId));
    expect(entryRows(html).length).toBe(3);
    // And WHICH three: the server's own ordinals, so a reader can see it was 1, 2 and 4 that moved
    // rather than the first three of a list this card renumbered.
    expect(entryRows(html).map(ordinalOf)).toEqual([1, 2, 4]);
    // The count is on screen without opening anything — "three reworded" and "the whole set
    // replaced with three" are the same three rows until a reader is told how many did not move.
    expect(html).toContain(unchangedLine(5));
    expect(html).toContain(changeSummary(real.diff));
    // Folded, not open: the five are one disclosure away rather than back in the scroll box. The
    // presence check is what keeps the second line from passing on a card with no fold at all.
    expect(html).toContain('<details');
    expect(/<details[^>]*\bopen\b/u.test(html)).toBe(false);
  });

  /**
   * ONE LINE PER REWRITE, NOT TWO PARAGRAPHS.
   *
   * Showing both versions whole was the shape that put 483px of content in a 360px box: three
   * rewrites of ninety-character Chinese each cost two long blocks, of which sixty characters in
   * total actually differed. So the card draws the server's cut in place — the sentence as it
   * would stand, with the dropped run struck through inside it — and the assertion below is that
   * the two versions are no longer laid out one after the other.
   */
  it('draws each rewrite as one merged line rather than both versions in full', () => {
    const html = card(criteriaDecisionStanding(queue([real]), real.intentId));
    const moved = real.diff.entries.filter((each) => each.change === 'CHANGED');
    expect(moved.length).toBe(3);
    for (const each of moved) {
      const runs = each.rewrites.find((rewrite) => rewrite.field === 'text')!.segments;
      // The positive control: the cut fed in really is a cut, so the two assertions under it are
      // about the card and not about a rewrite that happened to have one run.
      expect(runs.length, `the cut of ${each.ordinal}`).toBeGreaterThan(2);
      for (const run of runs) {
        expect(html, `run ${run.side} of ${each.ordinal}`).toContain(escaped(run.text));
      }
      // And the shape that is gone: neither version is on the card as one uninterrupted block.
      // `onRecord` is the one that used to be printed whole under `on record now:`.
      expect(html, `${each.ordinal} still lays out the words on record in full`)
        .not.toContain(escaped(each.onRecord!.text));
      expect(html, `${each.ordinal} still lays out the proposed words in full`)
        .not.toContain(escaped(each.proposed!.text));
      expect(html).toContain(CRITERION_REWORDED_LABEL);
    }
  });

  it('marks the dropped runs as dropped, and says once what the mark means', () => {
    const html = card(criteriaDecisionStanding(queue([real]), real.intentId));
    const dropped = real.diff.entries
      .filter((each) => each.change === 'CHANGED')
      .flatMap((each) => each.rewrites)
      .flatMap((rewrite) => rewrite.segments)
      .filter((run: CriterionSegment) => run.side === 'REMOVED');
    expect(dropped.length).toBe(4);
    for (const run of dropped) {
      // Inside a `<del>`, which is what carries "these words go" to a screen reader — a class name
      // and a strikethrough carry it to a sighted reader and to nobody else.
      const at = html.indexOf(escaped(run.text));
      expect(at, `no ${JSON.stringify(run.text)} on the card`).toBeGreaterThan(-1);
      expect(html.lastIndexOf('<del', at)).toBeGreaterThan(html.lastIndexOf('</del>', at));
    }
    expect(html).toContain(DROPPED_RUN_TITLE);
    // The legend is the only thing that says what a strikethrough means, and it is said once.
    expect(html).toContain(INLINE_DIFF_LEGEND);
    expect(html.split(INLINE_DIFF_LEGEND).length - 1).toBe(1);
  });
});

describe('the three ways a criterion can move', () => {
  const unchangedNeighbour = entry({ definitionId: 'kept', ordinal: 2 });

  it('calls a criterion changed when only HOW IT IS JUDGED moved', () => {
    // `text` is byte-for-byte the same on both sides. An edit that leaves the assertion alone and
    // rewrites the procedure has still changed what the project has to prove, and a comparison
    // that only read `text` would report this proposal as changing nothing at all.
    const reworded = row({
      diff: diffOf([
        entry({
          change: 'CHANGED',
          changed: ['verificationMethod'],
          proposed: { text: CRITERION_TEXT, verificationMethod: 'somebody says it looks fine',
            completionCriterionOverrideReason: null },
          onRecord: { text: CRITERION_TEXT, verificationMethod: 'the full API suite passes',
            completionCriterionOverrideReason: null },
          // Two procedures with nothing in common: the server's cut of them is one run each way.
          rewrites: [{ field: 'verificationMethod', segments: [
            { side: 'REMOVED', text: 'the full API suite passes' },
            { side: 'ADDED', text: 'somebody says it looks fine' },
          ] }],
        }),
        unchangedNeighbour,
      ]),
    });
    const html = card(criteriaDecisionStanding(queue([reworded]), reworded.intentId));
    expect(entryRows(html).length).toBe(1);
    expect(html).toContain(CRITERION_REWORDED_LABEL);
    // The procedure is cut and merged like the assertion is, under its own label — the words alone
    // would look like the card had drawn the same criterion twice, since `text` did not move.
    expect(html).toContain(`${METHOD_LABEL}: `);
    expect(html).toContain('somebody says it looks fine');
    expect(html).toContain('the full API suite passes');
    expect(html).toContain(unchangedLine(1));
  });

  it('says a criterion is being dropped, in the words it would drop', () => {
    // The shape the card could not express at all before: a proposal that removes a criterion has
    // nothing to lay out for it, so a card built from the restatement showed one row fewer and
    // said nothing about the row that went.
    const dropped = row({
      diff: diffOf([
        entry({ definitionId: 'kept', ordinal: 1 }),
        entry({
          change: 'REMOVED',
          definitionId: 'gone',
          ordinal: 2,
          proposed: null,
          onRecord: { text: 'the migrations replay from empty', verificationMethod: 'a pg spec',
            completionCriterionOverrideReason: null },
          changed: [],
        }),
      ]),
    });
    const html = card(criteriaDecisionStanding(queue([dropped]), dropped.intentId));
    expect(entryRows(html).length).toBe(1);
    expect(html).toContain(CRITERION_DROPPED_LABEL);
    expect(html).toContain('the migrations replay from empty');
    expect(html).toContain(unchangedLine(1));
  });

  it('folds nothing away when everything moved', () => {
    // The negative of the fold: a proposal that rewrites the whole set has no unchanged count to
    // report, and a card that printed "0 criteria are unchanged" would be noise on the one card
    // where the reader most needs the rows.
    const wholesale = row({
      diff: diffOf([
        entry({ change: 'CHANGED', changed: ['text'],
          proposed: { text: 'a looser ruler', verificationMethod: 'EXECUTABLE',
            completionCriterionOverrideReason: null },
          rewrites: [{ field: 'text', segments: [
            { side: 'REMOVED', text: CRITERION_TEXT },
            { side: 'ADDED', text: 'a looser ruler' },
          ] }] }),
      ]),
    });
    const html = card(criteriaDecisionStanding(queue([wholesale]), wholesale.intentId));
    expect(entryRows(html).length).toBe(1);
    expect(html).not.toContain('unchanged by this proposal');
    expect(html).not.toContain('<details');
  });
});

/**
 * THE THREE STALE INPUTS.
 *
 * Each one is fed as a derived read plus the address the delivery named — never as a hand-built
 * standing — because "the card notices" is a claim about what it concludes from that read.
 */
describe('a card whose question has moved on', () => {
  it('cannot be pressed once the base seal has moved, and says which seal and which refusal', () => {
    const stranded = row({
      currentSeal: SEAL_MOVED,
      decidability: {
        decidable: false,
        refusal: CRITERIA_DECISION_BASE_SEAL_MOVED,
        requiredAction: 'REFILE_AGAINST_THE_CURRENT_STANDARD_SET',
      },
    });
    const standing = criteriaDecisionStanding(queue([stranded]), stranded.intentId);
    expect(standing.state).toBe('BASE_SEAL_MOVED');

    const html = card(standing);
    expect(isDisabled(html, APPROVE_LABEL)).toBe(true);
    expect(isDisabled(html, REFUSE_LABEL)).toBe(true);
    // The reason, in the door's own words, and both versions so a reader can see what moved.
    expect(html).toContain(CRITERIA_DECISION_BASE_SEAL_MOVED);
    expect(html).toContain(shortSeal(SEAL_DRAFTED));
    expect(html).toContain(shortSeal(SEAL_MOVED));
    // And what clears it, which is somebody else's to do.
    expect(html).toContain('REFILE_AGAINST_THE_CURRENT_STANDARD_SET');
    expect(html).toContain(CRITERIA_DECISION_STALE_HEADING);
  });

  it('cannot be pressed once a newer proposal displaced it, and says nothing was applied', () => {
    const displaced = row();
    const replacement = row({
      intentId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
      commitToken: 'ffffffff-1111-4222-8333-444455556666',
      ageSeconds: 4 * 60,
      supersededIntentId: displaced.intentId,
      proposed: [proposed({ text: 'a narrower change' })],
    });
    // The displaced row is GONE from the read — that is what supersession does to it — and the
    // only trace of it is the link the replacement carries.
    const standing = criteriaDecisionStanding(queue([replacement]), displaced.intentId);
    expect(standing.state).toBe('SUPERSEDED');

    const html = card(standing);
    expect(isDisabled(html, APPROVE_LABEL)).toBe(true);
    expect(isDisabled(html, REFUSE_LABEL)).toBe(true);
    expect(html.toLowerCase()).toContain('superseded');
    expect(html.toLowerCase()).toContain('nothing was applied');
  });

  it('cannot be pressed once it was answered at another end, and names that refusal too', () => {
    const answered = row();
    // Settled rows are not returned at all: an answered question is not a question. So the read
    // that comes back is simply empty, and the card has to conclude the rest.
    const standing = criteriaDecisionStanding(queue([]), answered.intentId);
    expect(standing.state).toBe('ALREADY_SETTLED');

    const html = card(standing);
    expect(isDisabled(html, APPROVE_LABEL)).toBe(true);
    expect(isDisabled(html, REFUSE_LABEL)).toBe(true);
    expect(html.toLowerCase()).toContain('already answered');
    expect(html).toContain(CRITERIA_DECISION_ALREADY_SETTLED);
  });

  it('keeps no frozen copy of what it was delivered with', () => {
    // The property the three states above are worth having: a stale card shows the ADDRESS and
    // what happened to it, and cannot show a diff, because the read has stopped publishing one.
    // A card that still displayed the proposal would be displaying a local frame nobody re-derived.
    const gone = row();
    for (const standing of [
      criteriaDecisionStanding(queue([]), gone.intentId),
      criteriaDecisionStanding(
        queue([row({
          intentId: 'other', supersededIntentId: gone.intentId, proposed: [], diff: diffOf([]),
        })]),
        gone.intentId,
      ),
    ]) {
      expect(card(standing)).not.toContain(CRITERION_TEXT);
    }
  });

  it('offers nothing at all while the read it derives from has not come back', () => {
    // Not a state of the proposal — a state of this browser. A card that cannot re-derive itself
    // has no idea whether the door would take an answer, so it does not offer one.
    const standing = criteriaDecisionStanding(null, row().intentId);
    expect(standing.state).toBe('UNREAD');
    const html = card(standing);
    expect(isDisabled(html, APPROVE_LABEL)).toBe(true);
    expect(isDisabled(html, REFUSE_LABEL)).toBe(true);
    // And it does not claim the question was settled: a failed read is not an answer, and telling
    // a reader their decision is no longer theirs to make would be inventing one.
    expect(html).not.toContain(CRITERIA_DECISION_STALE_HEADING);
    expect(html).not.toContain(CRITERIA_DECISION_ALREADY_SETTLED);
  });
});

describe('the provenance mark', () => {
  it('is on the card in every state it can be in', () => {
    // The whole security argument is that this card is not the agent's typing. A mark that is
    // present only while the card is live would be absent exactly where a forgery is cheapest.
    const live = row();
    const stranded = row({
      currentSeal: SEAL_MOVED,
      decidability: {
        decidable: false,
        refusal: CRITERIA_DECISION_BASE_SEAL_MOVED,
        requiredAction: 'REFILE_AGAINST_THE_CURRENT_STANDARD_SET',
      },
    });
    for (const standing of [
      criteriaDecisionStanding(queue([live]), live.intentId),
      criteriaDecisionStanding(queue([stranded]), stranded.intentId),
      criteriaDecisionStanding(queue([]), live.intentId),
      criteriaDecisionStanding(null, live.intentId),
    ]) {
      const html = card(standing);
      expect(html, standing.state).toContain(PROVENANCE_LABEL);
      // And it says WHY it is there rather than being a badge somebody has to interpret.
      expect(html.toLowerCase(), standing.state).toContain('agent');
    }
  });

  it('never puts the second key on screen', () => {
    // The card says a key is bound to the press. Rendering the key itself would hand it to anyone
    // reading the conversation — including the party that proposed the change.
    const live = row();
    const html = card(criteriaDecisionStanding(queue([live]), live.intentId));
    expect(html).not.toContain(live.commitToken);
    expect(html.toLowerCase()).toContain('commit token bound');
  });
});

describe('what one press sends', () => {
  it('goes to the decision door with both keys and the seal it was composed against', () => {
    const live = row({ currentSeal: SEAL_DRAFTED });
    const request = criteriaDecisionRequest(live, 'APPROVE');
    expect(request.path).toBe(
      `/projects/${live.projectId}/acceptance/criteria-decisions/${live.intentId}`,
    );
    expect(request.body).toEqual({
      commitToken: live.commitToken,
      decision: 'APPROVE',
      baseSeal: live.baselineSeal,
    });
  });

  it('binds the answer to the version that was on the table, not to whatever stands now', () => {
    // `baseSeal` is freshness rather than a key: it is what the door compares to decide the answer
    // was composed against the ruler it is about to move.
    const stale = row({ currentSeal: SEAL_MOVED });
    expect(criteriaDecisionRequest(stale, 'REJECT').body.baseSeal).toBe(SEAL_DRAFTED);
  });
});

describe('what a decision leaves in the transcript', () => {
  const result = (over: Partial<CriteriaDecisionResult> = {}): CriteriaDecisionResult => ({
    intentId: row().intentId,
    decision: 'REJECT',
    decidedAt: '2026-09-09T04:02:00.000Z',
    baseSeal: SEAL_DRAFTED,
    resultingSeal: SEAL_DRAFTED,
    applied: false,
    ...over,
  });

  it('says which way the ruler went, in the seals the door compared', () => {
    const approved = criteriaApprovedLine(
      result({ decision: 'APPROVE', resultingSeal: SEAL_MOVED, applied: true }),
    );
    expect(approved).toContain(shortSeal(SEAL_DRAFTED));
    expect(approved).toContain(shortSeal(SEAL_MOVED));

    const refused = criteriaRefusedLine(result());
    expect(refused.toLowerCase()).toContain('nothing was applied');
    expect(refused).toContain(shortSeal(SEAL_DRAFTED));
  });
});

describe('the floor under the card', () => {
  const empty: PendingDecisionQueue = {
    decidingSessionId: '7RIOvpVLDjc8ZsFkf2GN5V',
    count: 0,
    oldestAgeSeconds: null,
    pending: [],
  };
  const strip = (criteria: PendingCriteriaDecisionQueue): string =>
    renderToStaticMarkup(
      <DecisionStrip queue={empty} criteria={criteria} open onToggle={() => {}} />,
    );

  it('lists a held proposal as a row, and counts it in the one line above', () => {
    // The floor exists because the card can be missed: nobody answered, nothing was written, and
    // the question is still there on the next read.
    const html = strip(queue([row()]));
    expect(html).toContain(CRITERIA_ROW_LABEL);
    expect(html).toContain(NEEDS_DECISION_LABEL);
    expect(html).toContain(needsDecisionCount(1));
    // The row states the facts a reader needs before opening anything.
    expect(html).toContain(shortSeal(SEAL_DRAFTED));
    expect(html).toContain('2 criteria proposed');
  });

  it('does not list one nobody can answer', () => {
    // A row under a heading that says DECIDE, whose every answer the door refuses, is the exact
    // bug this strip was fixed for once already. The card explains that one where it was met.
    const html = strip(
      queue([
        row({
          currentSeal: SEAL_MOVED,
          decidability: {
            decidable: false,
            refusal: CRITERIA_DECISION_BASE_SEAL_MOVED,
            requiredAction: 'REFILE_AGAINST_THE_CURRENT_STANDARD_SET',
          },
        }),
      ]),
    );
    expect(html).not.toContain(CRITERIA_ROW_LABEL);
  });

  it('answers nothing itself', () => {
    // One decision surface per proposal. Two would be two faces racing for one answer, and the
    // loser comes back refused.
    const html = strip(queue([row()]));
    expect(html).not.toContain(escaped(APPROVE_LABEL));
    expect(html).not.toContain(escaped(REFUSE_LABEL));
  });
});

describe('what is left on disk', () => {
  it('drops the primary fill while it is disabled, so a dead card differs in shape', () => {
    // `CardAction.tsx`'s one rule reaches the stylesheet: a solid brand slab at half strength is
    // still the most pressable thing on a card that has just said this cannot be answered.
    const css = fromRepo('src/index.css', 'src/web/src/index.css');
    // `:not(:disabled)` names both halves and is the hover rule, so it comes out of the selector
    // before the question is asked — without this the check passes on the stylesheet it rejects.
    const disabledPrimary = rules(css).filter((rule) => {
      const selector = rule.selector.replace(/:not\([^)]*\)/gu, '');
      return /\.card-action--primary\b/u.test(selector) && selector.includes(':disabled');
    });
    expect(disabledPrimary.length).toBeGreaterThan(0);
    expect(disabledPrimary.some((rule) => /(^|[;\s])background\s*:/u.test(rule.body))).toBe(true);
  });

  it('renders its actions through the shared component rather than its own buttons', () => {
    // The sizes and the one rule live in `CardAction.tsx`; a card that hand-rolled a button would
    // be a second place for both to drift.
    const source = fromRepo(
      'src/components/CriteriaDecisionCard.tsx',
      'src/web/src/components/CriteriaDecisionCard.tsx',
    );
    expect(source).toContain("from './CardAction'");
    expect(source.includes('<button')).toBe(false);
  });
});
