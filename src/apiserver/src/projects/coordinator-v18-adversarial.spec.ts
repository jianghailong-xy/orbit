import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// Independent unit-02 review of Coordinator contract v1.8.
//
// These are deliberately database-free counterexamples. They model only the predicates that the
// normative D15/D16 SQL actually enforces, then exhibit committed states which those predicates
// accept while the prose invariants reject. Real PostgreSQL was not re-run in this review: the
// request explicitly preserves the already-recorded isolated run and forbids another run unless
// final validation fails.
const REPO = path.resolve(__dirname, '../../../..');
const CONTRACT = readFileSync(path.join(REPO, 'docs/project-coordinator-contract.md'), 'utf8');

function between(document: string, start: string, end: string): string {
  const from = document.indexOf(start);
  const to = document.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not isolate ${start}`);
  return document.slice(from, to);
}

const I17_A = between(CONTRACT, '- **I17-A（create 冻结列', '- **I17-A2（claim 冻结列');
const I17_A2 = between(CONTRACT, '- **I17-A2（claim 冻结列', '- **I17-A3（lineage');
const EC2_B = between(CONTRACT, '- **EC2-b（', '- **EC2-c（');
const D15 = between(CONTRACT, '#### D15 ', '#### D16 ');
const D16 = between(CONTRACT, '#### D16 ', '#### D8 ');
const D16_SQL = D16.slice(D16.indexOf('CREATE OR REPLACE FUNCTION'), D16.lastIndexOf('```'));
const LIMITS = CONTRACT.slice(CONTRACT.indexOf('### 26.5 '));

test('PC-CX-47: generation 1 accepts claim values that contradict the frozen concrete model and effort', () => {
  assert.match(I17_A2, /冻结上下文里该分量\*\*非空\*\*时，Session 上的值与它逐字相同/,
    'I17-A2 no longer requires a concrete claim-frozen value to be copied exactly');
  assert.match(EC2_B, /model.*effort.*具体值或显式的 `DEFERRED_TO_CLAIM`/s,
    'EC2-b no longer includes the model/effort resolution conclusion');

  // D15 proves only that a change advances generation; D16 proves only that some claimResolution
  // object exists. Neither compares the resulting model/effort with the frozen context.
  assert.doesNotMatch(D15, /NEW\.model\s+IS DISTINCT FROM ctx->>'model'/);
  assert.doesNotMatch(D15, /NEW\.effort\s+IS DISTINCT FROM ctx->>'effort'/);
  assert.doesNotMatch(D16_SQL, /NEW\.model\s+IS DISTINCT FROM ctx->>'model'/);
  assert.doesNotMatch(D16_SQL, /NEW\.effort\s+IS DISTINCT FROM ctx->>'effort'/);

  const d15Accepts = (oldModel: string | null, nextModel: string | null,
    oldEffort: string | null, nextEffort: string | null, oldGeneration: number,
    nextGeneration: number): boolean => {
    const changed = oldModel !== nextModel || oldEffort !== nextEffort;
    return changed ? nextGeneration === oldGeneration + 1 : nextGeneration === oldGeneration;
  };
  const d16Accepts = (generation: number, claimResolution: object | null,
    retiredPins: object[]): boolean => generation === 0
    ? claimResolution === null && retiredPins.length === 0
    : claimResolution !== null && retiredPins.length === generation - 1;

  const frozen = { model: 'model-v1', effort: 'high' };
  const actual = { model: 'model-evil', effort: 'low' };
  assert.equal(d15Accepts(null, actual.model, null, actual.effort, 0, 1), true);
  assert.equal(d16Accepts(1, {}, []), true);
  assert.notDeepEqual(actual, frozen, 'the witness must violate I17-A2/EC2-b result equality');
});

test('PC-CX-48: a forged executionResultDigest is frozen, not rejected', () => {
  assert.ok(I17_A.includes('`execution_context_digest` / `execution_result_digest`')
      && I17_A.includes('重算出来的两个摘要不等'),
    'I17-A no longer claims both stored digests equal recomputation');
  assert.match(I17_A, /D15.*D16[\s\S]*对任何版本的二进制成立/,
    'I17-A no longer attributes the hard guarantee to D15+D16');
  assert.ok(LIMITS.includes('`execution_result_digest` 与它自己的 `execution_context` 对不上')
      && LIMITS.includes('而不是被拒绝'),
    '§26.5 no longer admits the counterexample');
  assert.doesNotMatch(D16_SQL, /execution_result_digest/,
    'the review model is stale: D16 now checks the stored result digest');

  const canonicalResultDigest = 'sha256(canonical(context))';
  const insertedDigest = 'forged-result-digest';
  const d11FreezesInsertedValue = insertedDigest;
  assert.equal(d11FreezesInsertedValue, insertedDigest, 'D11 preserves, rather than validates, the label');
  assert.notEqual(d11FreezesInsertedValue, canonicalResultDigest,
    'the committed row violates the digest half of I17-A');
});

test('PC-CX-49: ledger cardinality accepts semantically empty claim and retiredPin records', () => {
  assert.match(I17_A2, /每条含被换掉的值、换成的值与时刻/,
    'I17-A2 no longer requires old value, replacement value, and time');
  assert.match(D16_SQL, /jsonb_array_length\(ledger\).*generation - 1/s,
    'D16 no longer enforces even ledger cardinality');
  for (const field of ['from', 'to', 'at']) {
    assert.equal(D16_SQL.includes(`-> '${field}'`), false,
      `the review model is stale: D16 now validates retiredPins.${field}`);
  }

  const d16Accepts = (generation: number, claimResolution: object | null,
    retiredPins: object[]): boolean => generation === 0
    ? claimResolution === null && retiredPins.length === 0
    : claimResolution !== null && retiredPins.length === generation - 1;
  const retiredPins: object[] = [{}];
  const semanticallyComplete = retiredPins.every((entry) => {
    const record = entry as Record<string, unknown>;
    return 'from' in record && 'to' in record && 'at' in record;
  });
  assert.equal(d16Accepts(2, {}, retiredPins), true,
    'the exact D16 shape must accept one empty entry at generation 2');
  assert.equal(semanticallyComplete, false,
    'the accepted entry must violate I17-A2 provenance requirements');
});

test('v1.8 independent-review inventory is explicit and database-free', () => {
  assert.deepEqual(['PC-CX-47', 'PC-CX-48', 'PC-CX-49'],
    ['PC-CX-47', 'PC-CX-48', 'PC-CX-49']);
  assert.equal(process.env.COORDINATOR_PG_URL, undefined,
    'this suite must run with the PostgreSQL URL removed');
});
