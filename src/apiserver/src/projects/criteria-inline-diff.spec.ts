/**
 * WHERE A REWRITE ACTUALLY DIFFERS, MEASURED ON THE ONLY REAL PROPOSAL THERE IS.
 *
 * The read already said WHICH of eight criteria a restatement moves. What it could not say was
 * where inside a moved one the change is, so a card had to lay the two versions out whole and
 * leave a reader to find the clause by eye. On the first proposal Orbit ever held that meant six
 * paragraphs of ninety-character Chinese for three edits — 483px of content in a 360px box — for
 * three swapped clauses totalling about sixty characters.
 *
 * So this file asks one question of the cut, in several ways: DOES IT LAND ON THE CLAUSE. A cut
 * that reports the whole sentence as removed and the whole sentence as added is a correct diff and
 * a useless one — it reconstructs both sides perfectly, it just says nothing — which is why
 * reconstruction is asserted here as a floor and never as the point. The assertions that carry the
 * weight are the ones about coverage and about where the moved clause is and is not.
 *
 * NO DATABASE. `criteriaProposalDiff` is a function of two collections and is exported to be asked
 * without one; `criteria-pending-decisions.pg.spec.ts` is where the same fixture goes through the
 * production write path and comes back out of the derived read, which is a different claim.
 *
 * THE FIXTURE IS THE RECORD, NOT AN EXAMPLE. `criteria-weakening-1GB4IZ4B.fixture.json` is intent
 * 1GB4IZ4B as it was filed and answered on 2026-09-09. The web card's spec renders from the same
 * file, so what both ends are pinned to is one fact on disk.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  criteriaProposalDiff,
  criterionFieldSegments,
  type CriteriaProposalChangeEntry,
  type CriterionSegment,
} from './criteria-pending-decisions';
import type { ProposedCriterion } from './criteria-weakening-intent';
import type { StatedAcceptanceCriterion } from './project-acceptance';

const RECORDED_PROPOSAL = path.resolve(
  __dirname, '../../src/projects/criteria-weakening-1GB4IZ4B.fixture.json',
);

interface RecordedProposal {
  onRecord: Array<{ ordinal: number; text: string; verificationMethod: string }>;
  proposed: Array<{
    ordinal: number; retains: number | null; text: string; verificationMethod: string;
  }>;
  expected: {
    changedCount: number;
    entries: Array<{
      ordinal: number;
      change: string;
      changed: string[];
      /** Recorded for the CHANGED ones: the clause that moved, in the two versions' own words. */
      movedClause?: { removed: string; added: string };
      /** And a stretch of the same sentence that did NOT move, word for word on both sides. */
      stoodFast?: string;
      /** And the whole cut, as it is to come out — what both clients render, byte for byte. */
      rewrites?: Array<{ field: string; segments: CriterionSegment[] }>;
    }>;
  };
}

const recorded = JSON.parse(readFileSync(RECORDED_PROPOSAL, 'utf8')) as RecordedProposal;

/** The recorded proposal as the two collections the comparison takes, ids and all. */
function recordedSides(): { proposed: ProposedCriterion[]; onRecord: StatedAcceptanceCriterion[] } {
  return {
    onRecord: recorded.onRecord.map((each) => ({
      definitionId: `definition-${each.ordinal}`,
      ordinal: each.ordinal,
      text: each.text,
      verificationMethod: each.verificationMethod,
      completionCriterionOverrideReason: null,
    })) as unknown as StatedAcceptanceCriterion[],
    proposed: recorded.proposed.map((each) => ({
      id: each.retains === null ? null : `definition-${each.retains}`,
      ordinal: each.ordinal,
      text: each.text,
      verificationMethod: each.verificationMethod,
      completionCriterionOverrideReason: null,
    })) as unknown as ProposedCriterion[],
  };
}

const sides = recordedSides();
const diff = criteriaProposalDiff(sides.proposed, sides.onRecord);
const rewritten = diff.entries.filter((entry) => entry.change === 'CHANGED');

const joined = (segments: readonly CriterionSegment[], sides_: readonly string[]): string =>
  segments.filter((piece) => sides_.includes(piece.side)).map((piece) => piece.text).join('');

/** The words on record: everything the rewrite keeps plus everything it drops, in order. */
const beforeSide = (segments: readonly CriterionSegment[]): string =>
  joined(segments, ['KEPT', 'REMOVED']);
/** And the words proposed: everything it keeps plus everything it adds. */
const afterSide = (segments: readonly CriterionSegment[]): string =>
  joined(segments, ['KEPT', 'ADDED']);
const keptSide = (segments: readonly CriterionSegment[]): string => joined(segments, ['KEPT']);

const textRewrite = (entry: CriteriaProposalChangeEntry): CriterionSegment[] => {
  const rewrite = entry.rewrites.find((each) => each.field === 'text');
  assert.ok(rewrite, `criterion ${entry.ordinal} moved its text and carries no cut of it`);
  return rewrite.segments;
};

// ── The positive control: this really is the eight-for-three restatement ─────────────────────────

test('the recorded proposal restates eight criteria and rewords three of them', () => {
  assert.equal(diff.entries.length, 8, 'the whole collection is restated — that is the input');
  assert.equal(rewritten.length, recorded.expected.changedCount);
  assert.equal(rewritten.length, 3);
  assert.deepEqual(rewritten.map((entry) => entry.ordinal), [1, 2, 4]);
  // Every one of the three moved its assertion, which is what makes `text` the field cut below.
  for (const entry of rewritten) assert.deepEqual(entry.changed, ['text']);
});

test('a criterion that did not move is not cut up, and neither is one being added or dropped', () => {
  for (const entry of diff.entries) {
    if (entry.change === 'CHANGED') {
      assert.equal(entry.rewrites.length, entry.changed.length,
        `criterion ${entry.ordinal} carries one cut per field it moved`);
      continue;
    }
    assert.deepEqual(entry.rewrites, [],
      `criterion ${entry.ordinal} is ${entry.change} — there are not two versions of it to cut`);
  }
});

// ── The floor: a cut is of the two texts, not a summary of them ──────────────────────────────────

test('both versions are recovered from the cut, character for character', () => {
  for (const entry of rewritten) {
    const segments = textRewrite(entry);
    assert.equal(beforeSide(segments), entry.onRecord!.text,
      `the KEPT and REMOVED runs of ${entry.ordinal} are the words on record`);
    assert.equal(afterSide(segments), entry.proposed!.text,
      `the KEPT and ADDED runs of ${entry.ordinal} are the words proposed`);
  }
});

test('no run is empty, and no two neighbouring runs are the same kind', () => {
  for (const entry of rewritten) {
    const segments = textRewrite(entry);
    for (const [index, piece] of segments.entries()) {
      assert.notEqual(piece.text, '', `run ${index} of ${entry.ordinal} is empty`);
      const previous = segments[index - 1];
      if (previous) {
        assert.notEqual(piece.side, previous.side,
          `runs ${index - 1} and ${index} of ${entry.ordinal} are both ${piece.side} and should `
            + 'have been one run — split marks read as two separate edits');
      }
    }
  }
});

// ── The point: the cut lands on the clause that moved ────────────────────────────────────────────

/**
 * THE ASSERTION THIS FILE EXISTS FOR.
 *
 * Each of the three rewrites swapped one clause inside a long Chinese sentence. The fixture
 * records two things about each: `movedClause`, that clause in both versions' own words, and
 * `stoodFast`, a distinctive stretch of the SAME sentence that came through untouched. Both are
 * read off the fixture rather than recomputed here, so what this compares against is what a person
 * said about the edit and not what the algorithm happens to answer today.
 *
 * A cut has to get both halves right, and the second is the one a whole-sentence "diff" fails: the
 * clause that moved is inside the runs marked REMOVED and ADDED and nowhere in the runs marked
 * KEPT — AND the stretch that stood is inside the KEPT runs and nowhere in the marked ones. A cut
 * that reported "all of it went, all of it arrived" satisfies the first half exactly and fails the
 * second on every criterion, which is the point of stating them as a pair.
 */
test('the moved clause is what is marked removed and added, and nothing else is', () => {
  for (const entry of rewritten) {
    const said = recorded.expected.entries.find((each) => each.ordinal === entry.ordinal)!;
    const clause = said.movedClause;
    const stood = said.stoodFast;
    assert.ok(clause, `the fixture records no moved clause for criterion ${entry.ordinal}`);
    assert.ok(stood, `the fixture records nothing that stood for criterion ${entry.ordinal}`);
    const segments = textRewrite(entry);
    const removed = joined(segments, ['REMOVED']);
    const added = joined(segments, ['ADDED']);
    const kept = keptSide(segments);

    assert.ok(removed.includes(clause.removed),
      `criterion ${entry.ordinal}: the clause the rewrite drops (${clause.removed}) is not inside `
        + `what the cut marks removed (${removed})`);
    assert.ok(added.includes(clause.added),
      `criterion ${entry.ordinal}: the clause the rewrite introduces (${clause.added}) is not `
        + `inside what the cut marks added (${added})`);
    assert.ok(!kept.includes(clause.removed),
      `criterion ${entry.ordinal}: the dropped clause is inside the KEPT runs`);
    assert.ok(!kept.includes(clause.added),
      `criterion ${entry.ordinal}: the introduced clause is inside the KEPT runs`);

    // AND NOTHING ELSE IS. The words that stood are marked as having stood, and a reader is not
    // being told they were struck out and typed again.
    assert.ok(kept.includes(stood),
      `criterion ${entry.ordinal}: "${stood}" is in both versions and the cut does not mark it as `
        + 'unchanged');
    assert.ok(!removed.includes(stood),
      `criterion ${entry.ordinal}: "${stood}" is struck through, and it never moved`);
    assert.ok(!added.includes(stood),
      `criterion ${entry.ordinal}: "${stood}" is marked as new, and it was already on record`);
  }
});

/**
 * The same claim from the other side, and the one that fails loudest on a hollowed-out cut: after
 * the clause is taken out, the sentence is still there and is marked as still there.
 *
 * Two thirds is not a tuning knob dressed as a threshold — it is far below what the recorded
 * proposal actually gets (the three land at 98%, 79% and 98% of the shorter side) and far above
 * what any cut that gives up on a sentence can reach. A cut that reported "the whole sentence was
 * replaced" scores zero here.
 */
test('most of a reworded sentence is marked as unchanged, because most of it is', () => {
  for (const entry of rewritten) {
    const segments = textRewrite(entry);
    const shorter = Math.min(entry.onRecord!.text.length, entry.proposed!.text.length);
    const kept = keptSide(segments).length;
    assert.ok(kept >= shorter * (2 / 3),
      `criterion ${entry.ordinal}: only ${kept} of ${shorter} characters are marked unchanged — `
        + 'a reader is being shown the whole sentence twice again');
  }
});

test('neither version of a reworded criterion is reported as one undifferentiated run', () => {
  for (const entry of rewritten) {
    const segments = textRewrite(entry);
    assert.ok(segments.length >= 3,
      `criterion ${entry.ordinal} came back as ${segments.length} run(s): a clause swapped inside `
        + 'a sentence has a head and a tail that did not move');
    for (const piece of segments) {
      assert.notEqual(piece.text, entry.onRecord!.text,
        `criterion ${entry.ordinal}: a single run is the WHOLE sentence on record`);
      assert.notEqual(piece.text, entry.proposed!.text,
        `criterion ${entry.ordinal}: a single run is the WHOLE sentence proposed`);
    }
  }
});

/**
 * The whole cut, pinned run for run against the fixture — which is a DIFFERENT KIND OF ASSERTION
 * from the four above and is worth being clear about.
 *
 * The four above are properties somebody stated about this proposal in advance: the clause that
 * moved is here and not there, most of the sentence stood, no run is the whole sentence. They are
 * what makes a hollowed-out cut fail. THIS one is the cut written down, so a reader can see it
 * rather than infer it from properties, and so both clients can render exactly what the server
 * says without recomputing it — the web card's spec and OrbitKit's read these same runs out of
 * this same file. It is a change detector and it is honest about being one: it would go green on
 * an algorithm whose output was re-recorded, which is why it is not the only test here.
 *
 * Criterion 1 is the clearest of the three: it narrowed "add one, or raise a criterion from
 * VERIFICATION to EXECUTABLE, or narrow the expected exit codes" to "add one standard". 136
 * characters against 93, of which 43 move — head, dropped clause, new clause, tail.
 */
test('each rewrite is cut into the runs the fixture records, and into no others', () => {
  for (const entry of rewritten) {
    const expected = recorded.expected.entries
      .find((each) => each.ordinal === entry.ordinal)!.rewrites;
    assert.ok(expected, `the fixture records no cut for criterion ${entry.ordinal}`);
    assert.deepEqual(entry.rewrites, expected,
      `criterion ${entry.ordinal} is not cut the way the fixture says both clients will draw it`);
  }
});

// ── The unit the cut is made in ──────────────────────────────────────────────────────────────────

/**
 * A grapheme cluster is not a code unit, and cutting on the wrong one is visible: half a surrogate
 * pair renders as a replacement character, and a combining mark cut off its base lands on whatever
 * character the next run starts with. Both of these strings are one "character" to a reader and
 * several to `String.prototype.split('')`.
 */
test('an emoji and a combining mark are never cut in half', () => {
  const family = criterionFieldSegments('起点 👨‍👩‍👧 终点', '起点 👩‍👦 终点');
  for (const piece of family) {
    assert.ok(!/[\uD800-\uDFFF]/u.test(piece.text) || /\p{Emoji}/u.test(piece.text),
      `a run came back holding a lone surrogate: ${JSON.stringify(piece.text)}`);
  }
  assert.deepEqual(family.filter((piece) => piece.side === 'REMOVED').map((piece) => piece.text),
    ['👨‍👩‍👧'], 'the whole emoji sequence is what was replaced, not part of one');
  assert.deepEqual(family.filter((piece) => piece.side === 'ADDED').map((piece) => piece.text),
    ['👩‍👦']);

  // `é` written as e + U+0301: the mark belongs to the letter, and a run must not start with it.
  const combining = criterionFieldSegments('café done', 'café gone');
  for (const piece of combining) {
    assert.ok(!/^\p{M}/u.test(piece.text),
      `a run starts with a combining mark, so its base is in the previous run: `
        + JSON.stringify(piece.text));
  }
  assert.equal(beforeSide(combining), 'café done');
  assert.equal(afterSide(combining), 'café gone');
});

test('two texts with nothing in common are one run each way', () => {
  assert.deepEqual(criterionFieldSegments('abc', 'xyz'), [
    { side: 'REMOVED', text: 'abc' },
    { side: 'ADDED', text: 'xyz' },
  ]);
});

test('adding a field a criterion did not carry is an addition of the whole of it', () => {
  assert.deepEqual(criterionFieldSegments('', 'scripts/run-pg-spec.sh'), [
    { side: 'ADDED', text: 'scripts/run-pg-spec.sh' },
  ]);
});

/**
 * The budget, and what is given instead of a cut once it is past.
 *
 * A derived read is on the path of every card render and the table is quadratic, so a criterion
 * somebody pasted a chapter into must not be able to make this read expensive. What is asserted is
 * the shape at that size rather than a stopwatch: past the budget the middle comes back whole, one
 * run each way, which is the honest answer for two thousand-character paragraphs anyway.
 */
test('two texts too large to cut are reported whole rather than cut expensively', () => {
  // 1200 against 1200 is 1.44M cells, past MAX_REWRITE_CELLS — and they share a great deal, so a
  // cut IS available and is being declined on cost rather than for want of anything in common.
  const forwards = Array.from({ length: 1200 },
    (_, at) => String.fromCodePoint(0x4e00 + (at % 500))).join('');
  const backwards = [...forwards].reverse().join('');
  assert.notEqual(forwards, backwards, 'the positive control: these are two different texts');
  assert.deepEqual(criterionFieldSegments(forwards, backwards), [
    { side: 'REMOVED', text: forwards },
    { side: 'ADDED', text: backwards },
  ]);
});
