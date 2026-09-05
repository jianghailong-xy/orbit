/**
 * The landing fold, without a database.
 *
 * Its module's pg spec answers whether the lane reaches the endpoint and reads the receipts the
 * product actually writes; that one costs a PostgreSQL instance per case, so it builds each
 * criterion with a single serving task. The shapes below are the ones that are cheap here and
 * awkward there — most of all the CONJUNCTION, which a criterion with one serving task can never
 * tell apart from a disjunction.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  criterionLanding,
  receiptIsLandingEvidence,
  type CriterionWithLandingFacts,
} from './project-criterion-landing';

const MERGED_INTO_MAIN = { result: 'MERGED', targetBranch: 'main' };

/** One criterion, stated as the rows the fold reads. */
const criterion = (
  id: string,
  ...servingTasks: Array<Array<{ result: string; targetBranch: string }>>
): CriterionWithLandingFacts => ({ id, servingTasks: servingTasks.map((r) => ({ mergeReceipts: r })) });

test('a criterion is LANDED only when EVERY task serving it has landing evidence', () => {
  assert.deepEqual(
    criterionLanding([
      criterion('all', [MERGED_INTO_MAIN], [MERGED_INTO_MAIN]),
      criterion('one-of-two', [MERGED_INTO_MAIN], []),
      criterion('neither', [], []),
    ]),
    [
      { definitionId: 'all', landing: 'LANDED' },
      { definitionId: 'one-of-two', landing: 'UNKNOWN' },
      { definitionId: 'neither', landing: 'UNKNOWN' },
    ],
    'two tasks serve a criterion and one of them merged: the criterion’s work is not on the '
      + 'default branch, and a fold that asked whether ANY of them landed would say it was',
  );
});

test('a criterion nobody serves is UNKNOWN, not vacuously landed', () => {
  assert.deepEqual(criterionLanding([criterion('unserved')]),
    [{ definitionId: 'unserved', landing: 'UNKNOWN' }],
    '"every one of zero serving tasks landed" is true and says nothing; there is no evidence '
      + 'here to stand on, which is exactly what UNKNOWN means');
});

test('one task’s several receipts are searched, not just its latest', () => {
  assert.deepEqual(
    criterionLanding([criterion('retried', [
      { result: 'CONFLICT', targetBranch: 'main' },
      { result: 'MERGED', targetBranch: 'main' },
      { result: 'ERROR', targetBranch: 'main' },
    ])]),
    [{ definitionId: 'retried', landing: 'LANDED' }],
    'a receipt is a statement about a moment and they are never rewritten, so a merge that '
      + 'happened stays true however many attempts were recorded after it',
  );
});

test('only the two landed results, and only into the default branch, are evidence', () => {
  for (const branch of ['main', 'master']) {
    assert.equal(receiptIsLandingEvidence({ result: 'MERGED', targetBranch: branch }), true);
    assert.equal(receiptIsLandingEvidence({ result: 'ALREADY_MERGED', targetBranch: branch }), true,
      'the external fast-forward case is a landing, and it is how most of this work lands');
  }
  for (const result of ['CONFLICT', 'ERROR']) {
    assert.equal(receiptIsLandingEvidence({ result, targetBranch: 'main' }), false);
  }
  assert.equal(receiptIsLandingEvidence({ result: 'MERGED', targetBranch: 'orbit/some-lane' }), false,
    'a merge into another branch is evidence about THAT branch — and the answer it leaves here '
      + 'is UNKNOWN, never a denial, because this read cannot see what else has landed');
});
