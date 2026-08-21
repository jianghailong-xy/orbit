/**
 * §13.7's merge receipt, as pure functions: what counts as a checkable SHA, what makes two reports
 * the same report, and which of the four results means the work landed.
 *
 * The idempotency key is the one worth testing hardest. It is what stops a retried report from
 * minting a second row — and it is derived, not stored, so a caller in Go and a caller in
 * TypeScript agreeing about it is the whole mechanism. If they disagreed, nothing would collide:
 * they would each insert, quietly, which is the exact failure the key exists to prevent.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MERGE_RECEIPT_RESULTS,
  mergeReceiptIdempotencyKey,
  mergeReceiptRow,
  mergeStatusForResult,
  normalizeSha,
  resultLanded,
} from './merge-receipt';

const SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const OTHER = '0000000000000000000000000000000000000000';

test('a full object name normalises to lowercase; anything shorter is refused', () => {
  assert.equal(normalizeSha(SHA.toUpperCase(), 'sourceSha'), SHA);
  assert.equal(normalizeSha(`  ${SHA}  `, 'sourceSha'), SHA);
  assert.throws(() => normalizeSha('a1b2c3d', 'sourceSha'), /40-character/);
  assert.throws(() => normalizeSha(`${SHA}0`, 'sourceSha'), /40-character/);
  assert.throws(() => normalizeSha('z'.repeat(40), 'sourceSha'), /40-character/);
});

test('absent and blank are absent, not a refusal — an optional SHA may be omitted', () => {
  assert.equal(normalizeSha(null, 'rebaseBaseSha'), null);
  assert.equal(normalizeSha(undefined, 'rebaseBaseSha'), null);
  assert.equal(normalizeSha('   ', 'rebaseBaseSha'), null);
});

test('the refusal names the field, so a caller passing four SHAs knows which one was wrong', () => {
  assert.throws(() => normalizeSha('nope', 'targetShaAfter'), /^Error: targetShaAfter/);
});

test('the same merge reported twice keys the same', () => {
  const a = mergeReceiptIdempotencyKey({
    sessionId: 's1', sourceSha: SHA, targetBranch: 'feat/project', result: 'MERGED',
  });
  const b = mergeReceiptIdempotencyKey({
    // Case is not a difference: the same commit spelled two ways is one commit.
    sessionId: 's1', sourceSha: SHA.toUpperCase(), targetBranch: 'feat/project', result: 'MERGED',
  });
  assert.equal(a, b);
});

test('each of the four facts changes the key, and nothing else does', () => {
  const base = { sessionId: 's1', sourceSha: SHA, targetBranch: 'feat/project', result: 'MERGED' } as const;
  const key = mergeReceiptIdempotencyKey(base);
  assert.notEqual(key, mergeReceiptIdempotencyKey({ ...base, sessionId: 's2' }));
  assert.notEqual(key, mergeReceiptIdempotencyKey({ ...base, sourceSha: OTHER }));
  assert.notEqual(key, mergeReceiptIdempotencyKey({ ...base, targetBranch: 'main' }));
  assert.notEqual(key, mergeReceiptIdempotencyKey({ ...base, result: 'ALREADY_MERGED' }));
});

test('the key does not move when the target does', () => {
  // A merge re-reported after somebody else pushed is still the same merge. Keying on the target
  // tip would mint a fresh receipt every time anybody asked again — which is not idempotence, it
  // is an append-only table growing one row per question.
  const key = mergeReceiptIdempotencyKey({
    sessionId: 's1', sourceSha: SHA, targetBranch: 'feat/project', result: 'MERGED',
  });
  assert.equal(
    key,
    mergeReceiptIdempotencyKey({
      sessionId: 's1', sourceSha: SHA, targetBranch: 'feat/project', result: 'MERGED',
    }),
  );
});

test('the key is separated, so two adjacent fields cannot spell one other pair', () => {
  // 'ab' + 'c' and 'a' + 'bc' would collide under naive concatenation.
  assert.notEqual(
    mergeReceiptIdempotencyKey({ sessionId: 'ab', sourceSha: SHA, targetBranch: 'c', result: 'MERGED' }),
    mergeReceiptIdempotencyKey({ sessionId: 'a', sourceSha: SHA, targetBranch: 'bc', result: 'MERGED' }),
  );
});

test('both landed results mean landed — that is what fixes the external fast-forward', () => {
  assert.equal(resultLanded('MERGED'), true);
  assert.equal(resultLanded('ALREADY_MERGED'), true);
  assert.equal(resultLanded('CONFLICT'), false);
  assert.equal(resultLanded('ERROR'), false);
});

test('every result maps to a merge-button state, and only landed ones map to merged', () => {
  const seen = new Set<string>();
  for (const result of MERGE_RECEIPT_RESULTS) {
    const status = mergeStatusForResult(result);
    assert.ok(['merged', 'conflict', 'error'].includes(status), `${result} -> ${status}`);
    assert.equal(status === 'merged', resultLanded(result));
    seen.add(result);
  }
  assert.equal(seen.size, 4);
});

test('a row says whether it landed and whether it was rebased, rather than making a client guess', () => {
  const row = mergeReceiptRow({
    id: 'r1', sessionId: 's1', taskId: 't1', projectId: 'p1',
    result: 'ALREADY_MERGED',
    sourceBranch: 'orbit/x', sourceSha: SHA,
    targetBranch: 'feat/project', targetShaBefore: OTHER, targetShaAfter: OTHER,
    rebaseBaseSha: null,
    conflicts: [], recordedBy: 'AGENT', detail: {}, idempotencyKey: 'k',
    createdAt: new Date(0),
  });
  assert.equal(row.landed, true);
  assert.equal(row.rebaseBaseSha, null);
  assert.equal(row.rebaseBaseShaAbsentReason, 'NOT_REBASED');
});
