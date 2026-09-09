/**
 * The direction rules, one case each, with no database anywhere near them.
 *
 * Every case below is an ASSERTED VALUE rather than an absence: `classifyCriteriaEdit` answers
 * with one of two words for every input, so there is no shape of this spec that passes by doing
 * nothing. That matters most for the loosening cases, where the thing being protected is a
 * refusal — a spec that only ever asked "did anything get through" would go green on a classifier
 * that had been emptied out.
 *
 * The pairing is deliberate too: every rule that can go both ways is written as a tightening case
 * AND its mirror, because a classifier hard-wired to one answer passes half of them and no more.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyCriteriaEdit, type CriteriaEditItem } from './criteria-edit-classification';

/** One criterion. Prose `verificationMethod` by default, which is what a stored one holds. */
const criterion = (
  id: string | undefined,
  overrides: Partial<CriteriaEditItem> = {},
): CriteriaEditItem => ({
  id,
  text: `the thing ${id ?? 'nobody has stored yet'} asserts`,
  verificationMethod: 'a pg spec run through scripts/run-pg-spec.sh',
  ...overrides,
});

const FIRST = criterion('a');
const SECOND = criterion('b');

// ── Tightening: the edit may take effect where it was made ──────────────────────────────────────

test('adding a criterion is additive', () => {
  assert.equal(
    classifyCriteriaEdit([FIRST], [FIRST, criterion(undefined)]),
    'ADDITIVE',
    'a set that asserts everything it used to assert and one thing more is strictly harder to '
      + 'satisfy, so holding it for a decision would gate the one direction that needs no gate',
  );
});

test('the verification predicate stepping up the ladder is additive', () => {
  for (const [from, to] of [
    ['HUMAN', 'VERIFICATION'],
    ['VERIFICATION', 'EXECUTABLE'],
    ['HUMAN', 'EXECUTABLE'],
  ]) {
    assert.equal(
      classifyCriteriaEdit(
        [criterion('a', { verificationMethod: from })],
        [criterion('a', { verificationMethod: to })],
      ),
      'ADDITIVE',
      `${from} → ${to} demands more of whoever answers the criterion, not less`,
    );
  }
});

test('narrowing the accepted exit codes is additive, including naming any at all', () => {
  assert.equal(
    classifyCriteriaEdit(
      [criterion('a', { acceptanceExpectedExitCode: [0, 1] })],
      [criterion('a', { acceptanceExpectedExitCode: [0] })],
    ),
    'ADDITIVE',
    'an edit that stops accepting exit 1 accepts strictly less than it did',
  );
  assert.equal(
    classifyCriteriaEdit([criterion('a')], [criterion('a', { acceptanceExpectedExitCode: [0] })]),
    'ADDITIVE',
    'no stated exit code accepts every exit code, so stating one rules the rest out',
  );
});

// ── Loosening, and everything whose direction cannot be read ────────────────────────────────────

test('deleting a criterion is weakening', () => {
  assert.equal(
    classifyCriteriaEdit([FIRST, SECOND], [FIRST]),
    'WEAKENING',
    'dropping an assertion is the plainest way to make a ruler kinder',
  );
});

test('the verification predicate stepping down the ladder is weakening', () => {
  for (const [from, to] of [
    ['EXECUTABLE', 'VERIFICATION'],
    ['VERIFICATION', 'HUMAN'],
    ['EXECUTABLE', 'HUMAN'],
  ]) {
    assert.equal(
      classifyCriteriaEdit(
        [criterion('a', { verificationMethod: from })],
        [criterion('a', { verificationMethod: to })],
      ),
      'WEAKENING',
      `${from} → ${to} asks less of the evidence than the criterion on record does`,
    );
  }
});

test('widening the accepted exit codes is weakening, including dropping them entirely', () => {
  assert.equal(
    classifyCriteriaEdit(
      [criterion('a', { acceptanceExpectedExitCode: [0] })],
      [criterion('a', { acceptanceExpectedExitCode: [0, 1] })],
    ),
    'WEAKENING',
    'a criterion that now also passes on exit 1 passes in a case where it used to fail',
  );
  assert.equal(
    classifyCriteriaEdit([criterion('a', { acceptanceExpectedExitCode: [0] })], [criterion('a')]),
    'WEAKENING',
    'taking the expectation away accepts every exit code, which is the widest set there is',
  );
});

test('an exit-code set that is neither wider nor narrower is weakening', () => {
  assert.equal(
    classifyCriteriaEdit(
      [criterion('a', { acceptanceExpectedExitCode: [0] })],
      [criterion('a', { acceptanceExpectedExitCode: [1] })],
    ),
    'WEAKENING',
    'swapping which code passes is not a tightening, and the safe side is where undecidable goes',
  );
});

test('repointing evidenceTaskId is weakening', () => {
  assert.equal(
    classifyCriteriaEdit(
      [criterion('a', { evidenceTaskId: 'task-1' })],
      [criterion('a', { evidenceTaskId: 'task-2' })],
    ),
    'WEAKENING',
    'a criterion answered by different work is a different criterion, and the swap states no '
      + 'direction — the new task may assert anything at all',
  );
});

test('rewording the text is weakening, because no machine can read the direction off prose', () => {
  assert.equal(
    classifyCriteriaEdit(
      [criterion('a', { text: 'every write path refuses an unsealed edit' })],
      [criterion('a', { text: 'the write path refuses an unsealed edit' })],
    ),
    'WEAKENING',
    'dropping "every" narrows what is being asserted, and no rule available here can tell that '
      + 'apart from fixing a typo — so it defaults to the side that costs a decision, not a hole',
  );
});

test('rewriting verificationMethod as prose is weakening, on either side of the ladder', () => {
  assert.equal(
    classifyCriteriaEdit(
      [criterion('a', { verificationMethod: 'a pg spec, skip counts as red' })],
      [criterion('a', { verificationMethod: 'a pg spec' })],
    ),
    'WEAKENING',
    'prose to prose is the case that actually happens on stored criteria today, where '
      + 'verificationMethod is required free text and holds no rung to compare',
  );
  assert.equal(
    classifyCriteriaEdit(
      [criterion('a', { verificationMethod: 'HUMAN' })],
      [criterion('a', { verificationMethod: 'somebody looks at it' })],
    ),
    'WEAKENING',
    'a rung on one side and prose on the other is not a comparison, whichever side is which',
  );
});

// ── Neutral: nothing moved, so nothing needs a gate ─────────────────────────────────────────────

test('a pure reorder is additive, because position is not identity', () => {
  assert.equal(
    classifyCriteriaEdit([FIRST, SECOND], [SECOND, FIRST]),
    'ADDITIVE',
    'the write path derives ordinal from array index, so the same ids in another order restate '
      + 'the same two criteria and gating that would make the gate mean nothing',
  );
});

test('re-sending the set unchanged is additive', () => {
  assert.equal(
    classifyCriteriaEdit([FIRST, SECOND], [FIRST, SECOND]),
    'ADDITIVE',
    'ADDITIVE is the answer "this may be applied", and applying an edit that changes nothing '
      + 'changes nothing',
  );
});

// ── The mixed edit, which is the whole reason one signal decides the set ────────────────────────

test('an edit that adds one criterion and deletes another is weakening', () => {
  assert.equal(
    classifyCriteriaEdit([FIRST, SECOND], [FIRST, criterion(undefined)]),
    'WEAKENING',
    'the addition does not pay for the deletion: b is gone from the ruler either way, and an '
      + 'edit that could buy its way past this gate by bundling a new criterion with a dropped '
      + 'one would be the hole the gate exists to close',
  );
});
