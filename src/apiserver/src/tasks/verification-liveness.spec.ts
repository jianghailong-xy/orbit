import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus, TaskStatus } from '@orbit/shared';
import { computeDependencyState } from './task-dependencies';
import {
  VerificationEpochCheckFact,
  VerificationEpochGate,
  VerificationRunFact,
  newestLiveCheck,
  verificationEpochGate,
  verificationEpochGates,
} from './verification-dependency';
import { verificationGateStalled, verificationLiveness } from './verification-liveness';

// `[K5]` / `[H0V2]`: the 20 cells nobody was told about, and the two the audit filed beside them.
//
// The residue is a LIVENESS defect and not a safety one, which is exactly why it survived a
// 13200-cell exhaustive sweep of "does the wrong thing get through". Everything here therefore
// asserts the other direction: that a shut epoch which nothing will open says so, and that one
// which something WILL open does not — because a rule that escalated every wait would be as useless
// as the one that escalated none.

const SETTLED_RUN: VerificationRunFact = {
  runStatus: RunStatus.SUCCEEDED,
  endReason: 'task_done',
  deletedAt: null,
  completionAt: new Date('2026-08-22T10:00:00.000Z'),
};

const LIVE_RUN: VerificationRunFact = {
  runStatus: RunStatus.RUNNING,
  endReason: null,
  deletedAt: null,
  completionAt: null,
};

/** A run somebody ended by hand: it stopped, and it did not finish the task. */
const COMPLETED_OUT: VerificationRunFact = {
  runStatus: RunStatus.SUCCEEDED,
  endReason: 'complete',
  deletedAt: null,
  completionAt: new Date('2026-08-22T10:00:00.000Z'),
};

function check(over: Partial<VerificationEpochCheckFact> = {}): VerificationEpochCheckFact {
  return {
    id: 'v1',
    status: 'DONE',
    verdict: 'PASS',
    verdictRevision: '1',
    retired: false,
    verdictApplied: true,
    runs: [SETTLED_RUN],
    ...over,
  };
}

function gateOf(checks: VerificationEpochCheckFact[], subjectStatus = 'DONE'): VerificationEpochGate | null {
  return verificationEpochGate({ id: 's', status: subjectStatus as never }, checks);
}

function livenessOf(checks: VerificationEpochCheckFact[], subjectStatus = 'DONE') {
  return verificationLiveness(gateOf(checks, subjectStatus), newestLiveCheck(checks));
}

// ---------------------------------------------------------------------------------------------
// The residue itself.
// ---------------------------------------------------------------------------------------------

test('a check that is DONE with no verdict is a stall, not a wait', () => {
  // `[H0V2]`'s 20 cells. `recompute` writes nothing, `gapReason` used to open nothing, §13.2 raises
  // nothing, and the whole of the response was one WARN a minute.
  const checks = [check({ verdict: null, verdictRevision: '0' })];
  assert.equal(gateOf(checks), 'VERDICT_ABSENT');
  const liveness = livenessOf(checks);
  assert.equal(liveness.state, 'STALLED');
  if (liveness.state !== 'STALLED') return;
  assert.equal(liveness.reason, 'CONCLUDED_NOTHING');
  assert.equal(liveness.owner, 'USER');
  // RL2: the answer to a spent shape is a NEXT STEP, never "keep waiting".
  assert.match(liveness.requiredAction, /record one, or cancel it/);
});

test('the loop is NOT told to file another check for a verdict-less one', () => {
  // Deliberate, and the reason the stall is owned by a person. The DONE check still counts toward
  // the epoch, so an automatic re-file would leave the gate exactly where it was and mint one more
  // check on every pass — one silent shape traded for a loud one.
  const liveness = livenessOf([check({ verdict: null, verdictRevision: '0' })]);
  assert.equal(liveness.state === 'STALLED' && liveness.owner, 'USER');
});

test('an unrevisioned PASS can never be applied, and says so', () => {
  const checks = [check({ verdictRevision: '0' })];
  assert.equal(gateOf(checks), 'VERDICT_UNREVISIONED');
  const liveness = livenessOf(checks);
  assert.equal(liveness.state, 'STALLED');
  if (liveness.state !== 'STALLED') return;
  assert.equal(liveness.reason, 'UNREVISIONED_VERDICT');
});

// ---------------------------------------------------------------------------------------------
// The one gate whose answer is a function of the facts.
// ---------------------------------------------------------------------------------------------

test('RUN_NOT_SETTLED with a live run is an ordinary wait', () => {
  const checks = [check({ runs: [LIVE_RUN] })];
  assert.equal(gateOf(checks), 'RUN_NOT_SETTLED');
  assert.equal(livenessOf(checks).state, 'WAITING');
});

test('RUN_NOT_SETTLED with the run taken away is a stall', () => {
  // The case `[H0V2]` probe 4 line 8 records: somebody `complete`d the session out from under the
  // check. Nothing is running, the check is DONE, and no event these rows can produce settles it.
  const checks = [check({ runs: [COMPLETED_OUT] })];
  assert.equal(gateOf(checks), 'RUN_NOT_SETTLED');
  const liveness = livenessOf(checks);
  assert.equal(liveness.state, 'STALLED');
  if (liveness.state !== 'STALLED') return;
  assert.equal(liveness.reason, 'NO_RUN');
  assert.match(liveness.requiredAction, /completed or cancelled/);
});

test('a DONE check nothing ever ran is a stall, with its own sentence', () => {
  const checks = [check({ runs: [] })];
  assert.equal(gateOf(checks), 'RUN_NOT_SETTLED');
  const liveness = livenessOf(checks);
  assert.equal(liveness.state, 'STALLED');
  if (liveness.state !== 'STALLED') return;
  assert.match(liveness.requiredAction, /nothing having run it/);
});

// ---------------------------------------------------------------------------------------------
// The waits that really are waits.
// ---------------------------------------------------------------------------------------------

test('every genuine wait stays a wait', () => {
  const waits: Array<[string, VerificationEpochCheckFact[]]> = [
    // The check has not finished.
    ['VERIFICATION_IN_FLIGHT', [check({ status: 'IN_PROGRESS', runs: [LIVE_RUN] })]],
    // The coordinator applies it on the next pass, which is a pass that is already scheduled.
    ['VERDICT_NOT_APPLIED', [check({ verdictApplied: false })]],
  ];
  for (const [expected, checks] of waits) {
    assert.equal(gateOf(checks), expected);
    assert.equal(livenessOf(checks).state, 'WAITING', expected);
  }
  // And the subject being reopened: it is finished again when the work is redone.
  assert.equal(gateOf([check()], 'OPEN'), 'SUBJECT_NOT_DONE');
  assert.equal(livenessOf([check()], 'OPEN').state, 'WAITING');
});

test('an open epoch is not waiting for anything', () => {
  assert.equal(gateOf([check()]), null);
  assert.equal(livenessOf([check()]).state, 'WAITING');
  assert.equal(verificationGateStalled(null, null), false);
});

test('the three gates the epoch already escalated keep their answer, in one vocabulary', () => {
  const cases: Array<[VerificationEpochCheckFact[], string]> = [
    [[check({ verdict: 'FAIL' })], 'CONCLUDED_FAIL'],
    [[check({ verdict: 'INCONCLUSIVE' })], 'CONCLUDED_INCONCLUSIVE'],
    [[check({ status: 'CANCELLED' })], 'NO_LIVE_CHECK'],
  ];
  for (const [checks, reason] of cases) {
    const liveness = livenessOf(checks);
    assert.equal(liveness.state, 'STALLED', reason);
    if (liveness.state !== 'STALLED') continue;
    assert.equal(liveness.reason, reason);
  }
});

// ---------------------------------------------------------------------------------------------
// What the three faces do with it.
// ---------------------------------------------------------------------------------------------

test('the epoch map carries the stall, for the subject and for every check of it', () => {
  const epochs = verificationEpochGates(
    [
      { id: 's', status: 'DONE', verifiesTaskId: null, verdict: null, verdictRevision: '0', retired: false, verdictApplied: null },
      { id: 'v1', status: 'DONE', verifiesTaskId: 's', verdict: null, verdictRevision: '0', retired: false, verdictApplied: null },
    ] as never,
    new Map([['v1', [SETTLED_RUN]]]),
  );
  assert.equal(epochs.get('s')?.gate, 'VERDICT_ABSENT');
  assert.equal(epochs.get('s')?.stalled, true);
  // Both spellings of the edge answer the same thing about the same epoch.
  assert.equal(epochs.get('v1')?.stalled, true);
});

test('a stalled gate blocks downstream as BLOCKED_FAILED, not as an ordinary wait', () => {
  // §13.3's reduction. Both answers stop the dependent — the safety property `[H0G]` proved is
  // untouched — and the difference is whether anybody is told to go and do something.
  assert.equal(
    computeDependencyState([
      { status: TaskStatus.DONE, verificationGate: 'VERDICT_ABSENT', verificationGateStalled: true },
    ]),
    'BLOCKED_FAILED',
  );
  assert.equal(
    computeDependencyState([
      { status: TaskStatus.DONE, verificationGate: 'RUN_NOT_SETTLED', verificationGateStalled: false },
    ]),
    'BLOCKED',
  );
  // Absent reads as "asserts nothing", which is the pre-`[K5]` answer.
  assert.equal(
    computeDependencyState([{ status: TaskStatus.DONE, verificationGate: 'VERDICT_NOT_APPLIED' }]),
    'BLOCKED',
  );
});

test('a stall never turns a satisfied epoch into a refusal', () => {
  // The direction that would be a regression rather than a fix: nothing here may stop a dependent
  // whose prerequisite really has passed.
  assert.equal(
    computeDependencyState([
      { status: TaskStatus.DONE, verificationGate: null, verificationGateStalled: false },
    ]),
    'READY',
  );
});

test('a verdict waiting to be applied is a WAIT while there is budget left', () => {
  // The distinction criterion 7 turns on. "Not applied yet" is the coordinator's next pass, which
  // is already scheduled — telling somebody to go and look at it would be advice about a loop that
  // is working. It is only a stall once nothing is going to try again.
  assert.deepEqual(
    verificationLiveness('VERDICT_NOT_APPLIED', check({ verdictApplyExhausted: false })),
    { state: 'WAITING' },
  );
  // Absent reads as "not exhausted", so a caller that does not look at the ledger cannot invent one.
  assert.deepEqual(verificationLiveness('VERDICT_NOT_APPLIED', check({})), { state: 'WAITING' });
});

test('…and a STALL once the apply has run out of attempts', () => {
  const liveness = verificationLiveness(
    'VERDICT_NOT_APPLIED', check({ verdictApplyExhausted: true }),
  );
  assert.equal(liveness.state, 'STALLED');
  assert.equal(liveness.state === 'STALLED' && liveness.reason, 'VERDICT_APPLY_EXHAUSTED');
  assert.equal(liveness.state === 'STALLED' && liveness.owner, 'USER');
  // RL2: the sentence names the fix, and the fix is the one that also CLEARS the §11 row — a new
  // revision, which is a new action key.
  assert.match(
    liveness.state === 'STALLED' ? liveness.requiredAction : '',
    /revoke and re-record the verdict/,
  );
});

test('every gate value has a liveness answer, and it is one of the two', () => {
  // Exhaustive over the union, so a gate added later cannot silently default to "wait" — which is
  // the shape of the defect this whole file is about.
  const gates: VerificationEpochGate[] = [
    'NO_LIVE_VERIFICATION', 'VERIFICATION_IN_FLIGHT', 'VERDICT_ABSENT', 'VERIFICATION_FAILED',
    'VERIFICATION_INCONCLUSIVE', 'VERDICT_UNREVISIONED', 'RUN_NOT_SETTLED', 'VERDICT_NOT_APPLIED',
    'SUBJECT_NOT_DONE',
  ];
  // Asked of a check with no run and NO spent budget, which is the shape that separates the gates
  // that stall on their own value from the one that stalls on a fact in the ledger.
  const stalls = gates.filter((gate) => verificationGateStalled(gate, check({ runs: [] })));
  assert.deepEqual(stalls.sort(), [
    'NO_LIVE_VERIFICATION', 'RUN_NOT_SETTLED', 'VERDICT_ABSENT', 'VERDICT_UNREVISIONED',
    'VERIFICATION_FAILED', 'VERIFICATION_INCONCLUSIVE',
  ]);
  // …and the ninth joins them once it is spent, so `VERDICT_NOT_APPLIED` is not a gate that can
  // only ever answer "wait".
  assert.equal(
    verificationGateStalled('VERDICT_NOT_APPLIED', check({ runs: [], verdictApplyExhausted: true })),
    true,
  );
  for (const gate of gates) {
    const liveness = verificationLiveness(gate, check({ runs: [] }));
    if (liveness.state !== 'STALLED') continue;
    // RL2 again: a stall always names the next step and who owns it.
    assert.ok(liveness.requiredAction.length > 0, gate);
    assert.ok(liveness.owner === 'USER' || liveness.owner === 'COORDINATOR', gate);
  }
});
