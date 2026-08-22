import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NEVER_PUBLIC_ID_FIELDS, PUBLIC_ID_FIELDS } from '@orbit/shared';
import {
  ACCEPTANCE_BLOCKED,
  ACCEPTANCE_EVIDENCE_STALE,
  ACCEPTANCE_MISSING,
  ACCEPTANCE_DIGEST_VERSION,
  AcceptanceFacts,
  acceptanceDigest,
  acceptanceResultDigest,
  parseCriteria,
  sha256,
} from './project-acceptance';

// The digest and the criteria parser, on their own. They are pure by design (§13.4 AE1 is a
// function of stated facts), which is what makes "this evidence is about THAT world" checkable by
// anything — a test, a CLI, a future auditor — without a database in the room.

const PROJECT = '00000000-0000-7000-8000-000000002501';

function facts(overrides: Partial<AcceptanceFacts> = {}): AcceptanceFacts {
  return {
    criteriaRevision: sha256('every suite green\nmerged to main'),
    taskSet: [['t1', 'DONE', 'MANUAL', '', ''], ['t2', 'DONE', 'MANUAL', '', '']],
    verdicts: [['v1', 't1', 'PASS']],
    mergeEvidence: [['r1', 'main', 'a'.repeat(64), '3']],
    ...overrides,
  };
}

test('the digest is stable under reordering and unstable under every projection', () => {
  const base = facts();
  assert.equal(acceptanceDigest(PROJECT, base), acceptanceDigest(PROJECT, base));

  // Order is not a fact: the same rows read in another order describe the same world. AE1 says
  // `sorted[...]` for exactly this reason, and a digest that moved here would make every DONE
  // depend on a query plan.
  assert.equal(
    acceptanceDigest(PROJECT, base),
    acceptanceDigest(PROJECT, {
      ...base,
      taskSet: [...base.taskSet].reverse(),
    }),
  );

  // ...and each of the four projections moves it. These are the four write paths AE6 closes over,
  // so a projection that stopped mattering here is a way to change the world without invalidating
  // the evidence about it.
  const moved: Array<[string, AcceptanceFacts]> = [
    ['criteria edited', facts({ criteriaRevision: sha256('every suite green') })],
    // A task reopened: the id set is identical and the digest must still move (AE1's note on
    // carrying `status`, not only ids).
    ['task reopened', facts({ taskSet: [['t1', 'OPEN', 'MANUAL', '', ''], ['t2', 'DONE', 'MANUAL', '', '']] })],
    ['task added', facts({ taskSet: [...base.taskSet, ['t3', 'OPEN', 'MANUAL', '', '']] })],
    ['completion policy changed', facts({ taskSet: [['t1', 'DONE', 'VERIFICATION_PASSED', '', ''], ['t2', 'DONE', 'MANUAL', '', '']] })],
    ['verdict changed', facts({ verdicts: [['v1', 't1', 'FAIL']] })],
    ['verifier repointed', facts({ verdicts: [['v1', 't2', 'PASS']] })],
    ['branch content changed', facts({ mergeEvidence: [['r1', 'main', 'b'.repeat(64), '4']] })],
    // AE9's whole point: identical content at a new generation is still a different observation,
    // because "changed and changed back" is real for squash and force-push.
    ['same content, new generation', facts({ mergeEvidence: [['r1', 'main', 'a'.repeat(64), '4']] })],
  ];
  for (const [what, changed] of moved) {
    assert.notEqual(acceptanceDigest(PROJECT, changed), acceptanceDigest(PROJECT, base), what);
  }
});

test('the digest names the project and its own version', () => {
  const other = '00000000-0000-7000-8000-0000000025ff';
  assert.notEqual(acceptanceDigest(PROJECT, facts()), acceptanceDigest(other, facts()));
  // The version is INSIDE the hash, so a future change to the input shape cannot let an old record
  // match a new reading of the same world. It moved to 2 when §13.6 SU6's two columns joined
  // `taskSet` — a run frozen before that change re-digests differently and its DONE is refused
  // ACCEPTANCE_EVIDENCE_STALE, which is the recoverable outcome and the honest one.
  assert.equal(ACCEPTANCE_DIGEST_VERSION, 2);
});

test('the result digest is about the conclusions, not the world', () => {
  const run = '00000000-0000-7000-8000-0000000025aa';
  const outcomes = [
    { ordinal: 1, criterionKey: 'k1', verdict: 'PASS' },
    { ordinal: 2, criterionKey: 'k2', verdict: 'PASS' },
  ];
  assert.equal(acceptanceResultDigest(run, outcomes), acceptanceResultDigest(run, [...outcomes].reverse()));
  assert.notEqual(
    acceptanceResultDigest(run, outcomes),
    acceptanceResultDigest(run, [outcomes[0], { ...outcomes[1], verdict: 'FAIL' }]),
  );
});

test('criteria decompose one per non-blank line, markers are cosmetic, keys are content', () => {
  const parsed = parseCriteria('1. every suite green\n\n- merged to main\n   \n第 3 条 no open blocker');
  assert.deepEqual(parsed.map((c) => c.ordinal), [1, 2, 3]);
  assert.deepEqual(
    parsed.map((c) => c.text),
    ['every suite green', 'merged to main', 'no open blocker'],
  );
  // Renumbering the list does not change what each criterion IS, so a later run can be lined up
  // against an earlier one; editing the words does.
  assert.equal(parseCriteria('7) every suite green')[0].key, parsed[0].key);
  assert.notEqual(parseCriteria('every suite greenish')[0].key, parsed[0].key);

  // A criteria field somebody wrote as one paragraph is one criterion, not none: refusing to
  // decompose it would make acceptance impossible for the most common way people write these.
  assert.equal(parseCriteria('all twelve standards pass').length, 1);
  assert.deepEqual(parseCriteria(''), []);
  assert.deepEqual(parseCriteria(null), []);
});

test('the refusal codes are the contract’s two plus this unit’s one, and they are distinct', () => {
  // §13.4 AE2 step 3 freezes the first two by name. The third is separate on purpose: "your
  // evidence does not match the world" and "the world still has something unfinished in it" send
  // the caller to two different places.
  assert.deepEqual(
    [...new Set([ACCEPTANCE_MISSING, ACCEPTANCE_EVIDENCE_STALE, ACCEPTANCE_BLOCKED])].sort(),
    ['ACCEPTANCE_BLOCKED', 'ACCEPTANCE_EVIDENCE_STALE', 'ACCEPTANCE_MISSING'],
  );
});

test('every id the acceptance record serves is classified as a public id', () => {
  // The response interceptor keys on FIELD NAMES, so a new uuid column served under an
  // unclassified name comes back as a raw uuid beside base62 siblings — which is how a client ends
  // up unable to hand back an id it was just given.
  for (const field of ['runId', 'acceptedRunId', 'evidenceTaskId', 'evidenceSessionId']) {
    assert.ok(PUBLIC_ID_FIELDS.has(field), `${field} is not classified as a public id`);
    assert.equal(NEVER_PUBLIC_ID_FIELDS.has(field), false, `${field} is classified twice`);
  }
});
