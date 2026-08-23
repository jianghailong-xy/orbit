import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MERGE_GATE_REFUSALS } from './convergence-contract';
import {
  CheckpointRequest,
  authorizeReportedLanding,
  CheckpointTestEvidence,
  checkpointContentDigest,
  checkpointEvidenceDigest,
  checkpointMergeReceiptKey,
  decideMergeGate,
  evidenceIsGreen,
  landedVerdict,
  planCheckpoint,
} from './task-checkpoint';

// `[K6]` §7, as a pure decision.
//
// The unit is written against the two ways a checkpoint stops being evidence. The first is the one
// §0's incident used: work saved where nobody else can reach it, so the next generation resumes
// from a baseline missing it and re-derives the same failure. The second is quieter — a commit
// that inherits the word "verified" from a measurement taken somewhere else: a different tree, a
// different scope revision, or no measurement at all.

const COMMIT = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const BUNDLE_DIGEST = 'd'.repeat(64);

const GREEN: CheckpointTestEvidence = {
  suite: 'apiserver',
  treeSha: TREE,
  passed: 2876,
  failed: 0,
  skipped: 461,
};

function request(over: Partial<CheckpointRequest> = {}): CheckpointRequest {
  return {
    projectId: 'p1',
    taskId: 't1',
    scopeRevision: 1,
    commit: { branch: 'orbit/k6', commitSha: COMMIT, treeSha: TREE, baseSha: BASE },
    evidence: GREEN,
    artifact: null,
    ...over,
  };
}

function planned(over: Partial<CheckpointRequest> = {}, taskRevision = 1) {
  const result = planCheckpoint(request(over), taskRevision);
  assert.notEqual(typeof result, 'string', `unexpected refusal: ${String(result)}`);
  return result as Exclude<typeof result, string>;
}

test('§7: the kind comes out of the evidence, never out of the caller', () => {
  assert.equal(planned().kind, 'ACCEPTED');
  assert.equal(
    planned({ evidence: { ...GREEN, failed: 1 }, artifact: bundle() }).kind,
    'WIP_RED',
  );
  assert.equal(planned({ evidence: null, artifact: bundle() }).kind, 'WIP_RED');
});

test('§7: a suite that ran nothing is not green', () => {
  // The most common way a red tree passes for green: zero failures, because zero tests ran. Every
  // property below `ACCEPTED` — what a later task starts from, what may reach main — would then
  // rest on a measurement that measured nothing.
  const empty = { ...GREEN, passed: 0, failed: 0, skipped: 0 };
  assert.equal(evidenceIsGreen(empty), false);
  assert.equal(planned({ evidence: empty, artifact: bundle() }).kind, 'WIP_RED');
});

test('CP2: known-red work with nowhere to be recovered from is refused', () => {
  assert.equal(
    planCheckpoint(request({ evidence: null, artifact: null }), 1),
    'CHECKPOINT_ARTIFACT_REQUIRED',
  );
});

test("CP2: a stash is a place, not an artifact — and the refusal says which", () => {
  // §0's incident, in one assertion. The work was in `git stash` on one runner: neither lost nor
  // reachable, which is the state that costs the most because it looks like it was kept.
  assert.equal(
    planCheckpoint(
      request({
        evidence: null,
        artifact: { kind: 'LOCAL_STASH', ref: 'stash@{0}', digest: BUNDLE_DIGEST },
      }),
      1,
    ),
    'CHECKPOINT_ARTIFACT_NOT_PORTABLE',
  );
  // And it stays that answer when the ref is also malformed: fixing the ref would not help.
  assert.equal(
    planCheckpoint(
      request({ evidence: null, artifact: { kind: 'LOCAL_STASH', ref: '', digest: 'nope' } }),
      1,
    ),
    'CHECKPOINT_ARTIFACT_NOT_PORTABLE',
  );
});

test('§7: evidence measured against another tree does not make this commit good', () => {
  assert.equal(
    planCheckpoint(request({ evidence: { ...GREEN, treeSha: 'e'.repeat(40) } }), 1),
    'CHECKPOINT_EVIDENCE_TREE_MISMATCH',
  );
});

test('FD4: a checkpoint measured against a scope revision nobody is asking any more is refused', () => {
  assert.equal(planCheckpoint(request({ scopeRevision: 1 }), 2), 'SCOPE_REVISION_MISMATCH');
});

test('MR1: an abbreviated object name is not evidence', () => {
  // It resolves against a repository that has since gained objects, so the value that verified
  // today can name a different commit later, silently — which is the one thing this row exists to
  // prevent.
  for (const bad of ['a'.repeat(8), 'A'.repeat(40).replace(/A/g, 'g'), '']) {
    assert.equal(
      planCheckpoint(request({ commit: { branch: 'b', commitSha: bad, treeSha: TREE, baseSha: BASE } }), 1),
      'CHECKPOINT_SHA_MALFORMED',
      bad,
    );
  }
});

test('CP1: changing any one field is a different checkpoint', () => {
  const base = planned();
  const variants: Array<[string, Partial<CheckpointRequest>]> = [
    ['branch', { commit: { branch: 'other', commitSha: COMMIT, treeSha: TREE, baseSha: BASE } }],
    ['commit', { commit: { branch: 'orbit/k6', commitSha: 'f'.repeat(40), treeSha: TREE, baseSha: BASE } }],
    ['tree', { commit: { branch: 'orbit/k6', commitSha: COMMIT, treeSha: '9'.repeat(40), baseSha: BASE }, evidence: { ...GREEN, treeSha: '9'.repeat(40) } }],
    ['base', { commit: { branch: 'orbit/k6', commitSha: COMMIT, treeSha: TREE, baseSha: '8'.repeat(40) } }],
    ['evidence', { evidence: { ...GREEN, passed: 2877 } }],
  ];
  const seen = new Set([base.dedupKey]);
  for (const [name, over] of variants) {
    const other = planned(over);
    assert.equal(seen.has(other.dedupKey), false, `${name} did not change the identity`);
    seen.add(other.dedupKey);
  }
  // And recording the SAME content twice is one checkpoint, which is what makes "changing a field
  // is a new checkpoint" affordable rather than a licence to write a row per report.
  assert.equal(planned().dedupKey, base.dedupKey);
  assert.equal(planned().contentDigest, base.contentDigest);
});

test('CP1: the kind is part of the identity', () => {
  // The same commit checkpointed red, then accepted once the suite went green, is two rows. If the
  // kind were outside the key the second record would collide with the first and silently keep
  // saying `WIP_RED` about work that is now verified.
  const red = checkpointContentDigest({
    kind: 'WIP_RED',
    commit: { branch: 'orbit/k6', commitSha: COMMIT, treeSha: TREE, baseSha: BASE },
    evidenceDigest: null,
    artifact: { kind: 'GIT_BUNDLE', ref: 'b1', digest: BUNDLE_DIGEST },
  });
  const green = checkpointContentDigest({
    kind: 'ACCEPTED',
    commit: { branch: 'orbit/k6', commitSha: COMMIT, treeSha: TREE, baseSha: BASE },
    evidenceDigest: checkpointEvidenceDigest(GREEN),
    artifact: null,
  });
  assert.notEqual(red, green);
});

test('§7 CP3: every refusal code is reachable, and none is reachable twice', () => {
  const gate = (cp: Parameters<typeof decideMergeGate>[0], req: Parameters<typeof decideMergeGate>[1]) =>
    decideMergeGate(cp, req).decision;
  const accepted = {
    id: 'cp1',
    kind: 'ACCEPTED' as const,
    scopeRevision: 3,
    commitSha: COMMIT,
    evidenceDigest: checkpointEvidenceDigest(GREEN),
  };
  const ask = { branchTipSha: COMMIT, taskScopeRevision: 3, evidenceDigest: null };

  assert.equal(gate(null, ask), 'NO_CHECKPOINT');
  assert.equal(gate({ ...accepted, kind: 'WIP_RED' }, ask), 'CHECKPOINT_NOT_ACCEPTED');
  assert.equal(gate(accepted, { ...ask, taskScopeRevision: 4 }), 'SCOPE_REVISION_MISMATCH');
  assert.equal(gate(accepted, { ...ask, branchTipSha: 'f'.repeat(40) }), 'BRANCH_TIP_MISMATCH');
  assert.equal(gate(accepted, { ...ask, evidenceDigest: '1'.repeat(64) }), 'TEST_EVIDENCE_MISMATCH');
  assert.equal(gate(accepted, ask), 'ALLOWED');

  // Every code `[K1]` froze is produced by this gate — a frozen code nothing can emit is a
  // vocabulary entry, not a refusal.
  const reachable = new Set([
    gate(null, ask),
    gate({ ...accepted, kind: 'WIP_RED' }, ask),
    gate(accepted, { ...ask, taskScopeRevision: 4 }),
    gate(accepted, { ...ask, branchTipSha: 'f'.repeat(40) }),
    gate(accepted, { ...ask, evidenceDigest: '1'.repeat(64) }),
  ]);
  assert.deepEqual([...reachable].sort(), [...MERGE_GATE_REFUSALS].sort());
});

test('§7 CP3: two conditions at once give ONE answer, and it is the more specific one', () => {
  // A red checkpoint on a stale revision whose commit is not the tip is all three at once. A gate
  // that reported whichever it noticed first would give different answers on replay, and TH1's
  // whole argument is that the reported reason has to be determined by the rule rather than by the
  // order the reader happened to check in.
  const decision = decideMergeGate(
    { id: 'cp1', kind: 'WIP_RED', scopeRevision: 1, commitSha: COMMIT, evidenceDigest: null },
    { branchTipSha: 'f'.repeat(40), taskScopeRevision: 9, evidenceDigest: '1'.repeat(64) },
  );
  assert.equal(decision.decision, 'CHECKPOINT_NOT_ACCEPTED');
});

test('§7 CP3: bringing no evidence contradicts nothing', () => {
  // The checkpoint's own evidence is what made it `ACCEPTED`, and it was already required to have
  // some. What the gate refuses is a SECOND measurement that disagrees — not the absence of one.
  const accepted = {
    id: 'cp1',
    kind: 'ACCEPTED' as const,
    scopeRevision: 1,
    commitSha: COMMIT,
    evidenceDigest: checkpointEvidenceDigest(GREEN),
  };
  assert.equal(
    decideMergeGate(accepted, { branchTipSha: COMMIT, taskScopeRevision: 1, evidenceDigest: null }).decision,
    'ALLOWED',
  );
  assert.equal(
    decideMergeGate(accepted, {
      branchTipSha: COMMIT.toUpperCase(),
      taskScopeRevision: 1,
      evidenceDigest: checkpointEvidenceDigest(GREEN).toUpperCase(),
    }).decision,
    'ALLOWED',
    'case is a spelling of a sha, not a different sha',
  );
});

test('CP4: the receipt key is the checkpoint, and it still tells two outcomes apart', () => {
  const merged = checkpointMergeReceiptKey({ checkpointId: 'cp1', targetBranch: 'main', result: 'MERGED' });
  assert.equal(
    checkpointMergeReceiptKey({ checkpointId: 'cp1', targetBranch: 'main', result: 'MERGED' }),
    merged,
    'the same landing re-reported is the same key — that is the whole of CP4',
  );
  for (const other of [
    checkpointMergeReceiptKey({ checkpointId: 'cp2', targetBranch: 'main', result: 'MERGED' }),
    checkpointMergeReceiptKey({ checkpointId: 'cp1', targetBranch: 'develop', result: 'MERGED' }),
    // A conflict and a successful merge of one checkpoint are two things that happened, not one
    // thing reported twice.
    checkpointMergeReceiptKey({ checkpointId: 'cp1', targetBranch: 'main', result: 'CONFLICT' }),
  ]) {
    assert.notEqual(other, merged);
  }
});

test('the already-there question has three answers and no fourth', () => {
  assert.equal(landedVerdict(COMMIT, COMMIT, false), 'TARGET_IS_SOURCE');
  assert.equal(landedVerdict(COMMIT, TREE, true), 'TARGET_CONTAINS_SOURCE');
  assert.equal(landedVerdict(COMMIT, TREE, false), 'NOT_LANDED');
  // Equality outranks the ancestry answer even when the caller could not compute one — the
  // incident's own shape, where the source branch and `main` named the same commit.
  assert.equal(landedVerdict(COMMIT, COMMIT.toUpperCase(), false), 'TARGET_IS_SOURCE');
  // An unknown target is not a landing. Conservative on purpose: guessing here routes work into a
  // no-op instead of into a merge.
  assert.equal(landedVerdict(COMMIT, null, false), 'NOT_LANDED');
});

test('a reported landing is judged against what the SERVER authorised, and fails closed', () => {
  const expected = { id: 'cp1', kind: 'ACCEPTED' as const, commitSha: COMMIT };
  const at = (
    cp: Parameters<typeof authorizeReportedLanding>[0],
    managed: boolean,
    sha: string | null,
  ) => authorizeReportedLanding(cp, managed, sha).decision;

  assert.equal(at(expected, true, COMMIT), 'ALLOWED');
  assert.equal(at(expected, true, COMMIT.toUpperCase()), 'ALLOWED', 'case is a spelling, not a sha');

  // The defect this exists for: a runner that ignored `requiredSourceSha` and merged something
  // else. Nothing about the report itself looks wrong — it is a well-formed successful merge.
  assert.equal(at(expected, true, 'f'.repeat(40)), 'BRANCH_TIP_MISMATCH');
  // ...and a runner too old to name a source at all. "It merged something" cannot be re-checked,
  // so it is refused rather than believed — the old behaviour skipped the receipt here but wrote
  // the projection anyway, which is the same fail-open by a quieter route.
  assert.equal(at(expected, true, null), 'BRANCH_TIP_MISMATCH');
  assert.equal(at(expected, true, '   '), 'BRANCH_TIP_MISMATCH');

  // An authorisation that points at red work, however it got there.
  assert.equal(at({ ...expected, kind: 'WIP_RED' }, true, COMMIT), 'CHECKPOINT_NOT_ACCEPTED');

  // A managed task with no expectation at all fails CLOSED: the queue-time gate would not have
  // authorised one, so a landing claiming otherwise is not a landing this server asked for.
  assert.equal(at(null, true, COMMIT), 'NO_CHECKPOINT');

  // ...and unmanaged work — every merge Orbit records today — is untouched by all of it.
  assert.equal(at(null, false, COMMIT), 'ALLOWED');
  assert.equal(at(null, false, null), 'ALLOWED');
  assert.equal(authorizeReportedLanding(null, false, COMMIT).checkpointId, null);
  assert.equal(authorizeReportedLanding(expected, true, COMMIT).checkpointId, 'cp1');
});

function bundle() {
  return { kind: 'GIT_BUNDLE' as const, ref: 'bundle:k6:1', digest: BUNDLE_DIGEST };
}
