/**
 * §13.3 DEP as a table: one subject, a set of checks, and the clause that decides.
 *
 * The case that matters most is the first one, because it is the incident: a check that RAN and
 * concluded FAIL is DONE, and DONE used to be the whole of "satisfied".
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus, TaskStatus } from '@orbit/shared';
import {
  VerificationEpochCheckFact,
  VerificationEpochGate,
  VerificationRunFact,
  verificationCountsTowardEpoch,
  verificationEpochGate,
  verificationEpochGates,
  verificationRunSettled,
  verificationVerdictActionKeyOf,
} from './verification-dependency';
import { computeDependencyState, dependencySatisfied, statusPrerequisites } from './task-dependencies';

/** A run that ended the way a worker finishing its task ends one. */
const SETTLED_RUN: VerificationRunFact = {
  runStatus: RunStatus.SUCCEEDED,
  endReason: 'task_done',
  deletedAt: null,
  completionAt: '2026-08-22T10:00:00.000Z',
};

function check(overrides: Partial<VerificationEpochCheckFact> = {}): VerificationEpochCheckFact {
  return {
    id: 'v1',
    status: TaskStatus.DONE,
    verdict: 'PASS',
    verdictRevision: '1',
    retired: false,
    verdictApplied: true,
    runs: [SETTLED_RUN],
    ...overrides,
  };
}

const SUBJECT = { id: 's', status: TaskStatus.DONE };

function gate(
  checks: VerificationEpochCheckFact[],
  subject = SUBJECT,
): VerificationEpochGate | null {
  return verificationEpochGate(subject, checks);
}

// ---------------------------------------------------------------------------
// The incident
// ---------------------------------------------------------------------------

test('a check that concluded FAIL is DONE and does NOT satisfy a dependency', () => {
  assert.equal(gate([check({ verdict: 'FAIL' })]), 'VERIFICATION_FAILED');
  // ...and the row that used to release it is still exactly as it was.
  assert.equal(check({ verdict: 'FAIL' }).status, TaskStatus.DONE);
});

test('INCONCLUSIVE holds the work too — "we could not tell" is not a pass', () => {
  assert.equal(gate([check({ verdict: 'INCONCLUSIVE' })]), 'VERIFICATION_INCONCLUSIVE');
});

test('a PASS with every fact behind it opens the epoch', () => {
  assert.equal(gate([check()]), null);
});

// ---------------------------------------------------------------------------
// DEP1 — the epoch belongs to the subject
// ---------------------------------------------------------------------------

test('a newer check that has not concluded closes an older PASS', () => {
  const passed = check({ id: 'v1' });
  const rerun = check({ id: 'v2', status: TaskStatus.IN_PROGRESS, verdict: null, runs: [] });
  assert.equal(gate([passed, rerun]), 'VERIFICATION_IN_FLIGHT');
  // Order of the input must not matter: the newest id decides, not the array position.
  assert.equal(gate([rerun, passed]), 'VERIFICATION_IN_FLIGHT');
});

test('a newer FAIL overrides an older PASS', () => {
  assert.equal(
    gate([check({ id: 'v1' }), check({ id: 'v2', verdict: 'FAIL' })]),
    'VERIFICATION_FAILED',
  );
});

test('a newer PASS releases work an older FAIL held — fix, re-run, proceed', () => {
  assert.equal(gate([check({ id: 'v1', verdict: 'FAIL' }), check({ id: 'v2' })]), null);
});

test('a subject with no check at all is not passed — the empty world is not a pass', () => {
  assert.equal(gate([]), 'NO_LIVE_VERIFICATION');
});

test('a cancelled or superseded check does not count, so cancelling them all is not a pass', () => {
  assert.equal(gate([check({ status: TaskStatus.CANCELLED })]), 'NO_LIVE_VERIFICATION');
  assert.equal(gate([check({ retired: true })]), 'NO_LIVE_VERIFICATION');
  // ...and a cancelled NEWER check leaves the older PASS speaking again, because nothing replaced it.
  assert.equal(
    gate([check({ id: 'v1' }), check({ id: 'v2', status: TaskStatus.CANCELLED, verdict: null })]),
    null,
  );
  assert.equal(verificationCountsTowardEpoch(check()), true);
  assert.equal(verificationCountsTowardEpoch(check({ status: TaskStatus.CANCELLED })), false);
});

// ---------------------------------------------------------------------------
// DEP3 / DEP4 — the facts beyond the verdict value
// ---------------------------------------------------------------------------

test('a PASS written while the run is still live is a conclusion the turn can still revise', () => {
  assert.equal(
    gate([check({ runs: [{ ...SETTLED_RUN, runStatus: RunStatus.RUNNING, endReason: null }] })]),
    'RUN_NOT_SETTLED',
  );
});

test('a session a person completed or cancelled is not a worker finishing the task', () => {
  for (const endReason of ['completed', 'cancelled', 'ended', 'deleted', null]) {
    assert.equal(
      gate([check({ runs: [{ ...SETTLED_RUN, endReason }] })]),
      'RUN_NOT_SETTLED',
      `end_reason=${endReason} must not count as a natural finish`,
    );
  }
});

test('a run that never reached the COMPLETED lifecycle, or was trashed, is not evidence', () => {
  assert.equal(gate([check({ runs: [{ ...SETTLED_RUN, completionAt: null }] })]), 'RUN_NOT_SETTLED');
  assert.equal(
    gate([check({ runs: [{ ...SETTLED_RUN, deletedAt: '2026-08-22T11:00:00.000Z' }] })]),
    'RUN_NOT_SETTLED',
  );
  // `archivedAt` is the other half of the lifecycle derivation and counts the same.
  assert.equal(verificationRunSettled(check({ runs: [SETTLED_RUN] })), true);
});

test('a verdict with no run behind it at all has nothing to have concluded from', () => {
  assert.equal(gate([check({ runs: [] })]), 'RUN_NOT_SETTLED');
});

test('a PASS whose consequences have not been applied does not release downstream yet', () => {
  assert.equal(gate([check({ verdictApplied: false })]), 'VERDICT_NOT_APPLIED');
  // Outside a Project there is no ledger, and DEP4 reads that as not-applicable, not as not-applied.
  assert.equal(gate([check({ verdictApplied: null })]), null);
});

test('an unrevisioned verdict has no action identity, so it cannot be an applied one', () => {
  assert.equal(gate([check({ verdictRevision: '0' })]), 'VERDICT_UNREVISIONED');
});

test('a check that finished DONE without recording anything concluded nothing', () => {
  assert.equal(gate([check({ verdict: null })]), 'VERDICT_ABSENT');
});

// ---------------------------------------------------------------------------
// DEP1's second half — the subject has to still be the thing that was checked
// ---------------------------------------------------------------------------

test('a subject reverted or reopened after its PASS stops satisfying anything', () => {
  for (const status of [TaskStatus.OPEN, TaskStatus.IN_PROGRESS, TaskStatus.FAILED,
    TaskStatus.CANCELLED]) {
    assert.equal(
      gate([check()], { id: 's', status }),
      'SUBJECT_NOT_DONE',
      `a ${status} subject is not what the check passed`,
    );
  }
});

test('the check-specific clause is reported before the subject one, because it is actionable', () => {
  // A FAIL reverts its subject, so both are true at once; "the check failed" is the one to act on.
  assert.equal(
    gate([check({ verdict: 'FAIL' })], { id: 's', status: TaskStatus.OPEN }),
    'VERIFICATION_FAILED',
  );
});

// ---------------------------------------------------------------------------
// The batch builder
// ---------------------------------------------------------------------------

const RUNS = new Map([['v1', [SETTLED_RUN]], ['v2', [SETTLED_RUN]]]);

/** `{id: gate}` for readability — the subject each entry belongs to is asserted separately. */
function gatesOf(epochs: Map<string, { subjectTaskId: string; gate: unknown }>) {
  return Object.fromEntries([...epochs].map(([id, entry]) => [id, entry.gate]));
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    status: TaskStatus.DONE as string,
    verifiesTaskId: 's',
    verdict: 'PASS' as string | null,
    verdictRevision: '1',
    verdictApplied: true as boolean | null,
    retired: false,
    ...over,
  };
}

const SUBJECT_ROW = row({
  id: 's', verifiesTaskId: null, verdict: null, verdictRevision: '0', verdictApplied: null,
});

test('the SUBJECT is gated, and so is every check of it, with one answer between them', () => {
  const epochs = verificationEpochGates(
    [SUBJECT_ROW, row({ id: 'v1', verdict: 'FAIL' }), row({ id: 'v2', verdict: 'FAIL' })],
    RUNS,
  );
  assert.deepEqual(gatesOf(epochs), {
    s: 'VERIFICATION_FAILED', v1: 'VERIFICATION_FAILED', v2: 'VERIFICATION_FAILED',
  });
  // ...and every entry names the same subject, which is what lets a caller ask "is this MY epoch".
  assert.deepEqual([...epochs.values()].map((e) => e.subjectTaskId), ['s', 's', 's']);
});

test('a task nothing checks has no epoch at all — its status is the whole answer', () => {
  assert.deepEqual([...verificationEpochGates([SUBJECT_ROW], RUNS)], []);
});

test("depending on a DONE subject whose check FAILED is blocked - the incident's own shape", () => {
  // H1 and L1 named H0, not H0V. This is the edge callers are told to write, and the one that has
  // to hold: reading the subject's status alone is what let a failed check release its downstream.
  const epochs = verificationEpochGates([SUBJECT_ROW, row({ verdict: 'FAIL' })], RUNS);
  const statusOf = new Map([['s', 'DONE'], ['v1', 'DONE']]);
  const edges = new Map<string, string | null>([['s', null], ['v1', null]]);
  assert.equal(dependencySatisfied('s', statusOf, edges, epochs), false);
  // ...and the same world with an applied PASS releases it.
  const passed = verificationEpochGates([SUBJECT_ROW, row({ verdict: 'PASS' })], RUNS);
  assert.equal(dependencySatisfied('s', statusOf, edges, passed), true);
});

test('a check may depend on the subject it checks without waiting for its own conclusion', () => {
  // Without the exemption this is a deadlock: the epoch is closed BECAUSE this check has not
  // concluded, and it cannot conclude until it runs.
  const epochs = verificationEpochGates(
    [SUBJECT_ROW, row({ id: 'v1', status: TaskStatus.OPEN, verdict: null, verdictRevision: '0' })],
    new Map(),
  );
  const statusOf = new Map([['s', 'DONE'], ['v1', 'OPEN']]);
  const edges = new Map<string, string | null>([['s', null], ['v1', null]]);
  assert.equal(dependencySatisfied('s', statusOf, edges, epochs), false, 'anyone else waits');
  assert.equal(
    dependencySatisfied('s', statusOf, edges, epochs, 's'), true, 'its own check does not',
  );
});

test('a check whose SUBJECT was retired is history, and falls back to the status rule', () => {
  const epochs = verificationEpochGates(
    [row({ id: 's', verifiesTaskId: null, retired: true }), row({ id: 'v1', verdict: 'FAIL' })],
    RUNS,
  );
  assert.deepEqual([...epochs], []);
});

test('a check whose subject this read cannot see fails closed', () => {
  const epochs = verificationEpochGates([row({ id: 'v1' })], RUNS);
  assert.equal(epochs.get('v1')?.gate, 'SUBJECT_NOT_DONE');
});

test('a retired or cancelled check is gated too, and it cannot double-veto SU9', () => {
  // Every check of a live subject gets the subject's answer. On a retired one that answer is never
  // what decides — SU4 forbids a DONE row from naming a successor, so `dependencySatisfied` has
  // already rejected the row on its status before it would look at a gate — but it is the reason a
  // person reads instead of a bare "CANCELLED".
  const epochs = verificationEpochGates(
    [SUBJECT_ROW, row({ id: 'v1', retired: true }), row({ id: 'v2', status: TaskStatus.CANCELLED })],
    RUNS,
  );
  assert.deepEqual(gatesOf(epochs), {
    s: 'NO_LIVE_VERIFICATION', v1: 'NO_LIVE_VERIFICATION', v2: 'NO_LIVE_VERIFICATION',
  });
  // ...and cancelling every check of a DONE subject is not a pass: the subject's own edge is held.
  assert.equal(
    dependencySatisfied('s', new Map([['s', 'DONE']]), new Map([['s', null]]), epochs),
    false,
  );
  // The edge still resolves through the chain to a successor, whose own epoch is what decides.
  assert.equal(
    dependencySatisfied(
      'v1',
      new Map([['v1', 'CANCELLED'], ['v2', 'DONE']]),
      new Map<string, string | null>([['v1', 'v2'], ['v2', null]]),
      new Map([
        ['v1', { subjectTaskId: 's', gate: 'NO_LIVE_VERIFICATION' as const }],
        ['v2', { subjectTaskId: 's', gate: null }],
      ]),
    ),
    true,
  );
});

// ---------------------------------------------------------------------------
// What the gate does to the reduction the whole product reads
// ---------------------------------------------------------------------------

test('a DONE prerequisite with a gate is not READY, whatever its status says', () => {
  assert.equal(
    computeDependencyState([{ status: TaskStatus.DONE, verificationGate: 'VERIFICATION_FAILED' }]),
    'BLOCKED_FAILED',
  );
  assert.equal(
    computeDependencyState([{ status: TaskStatus.DONE, verificationGate: 'VERIFICATION_IN_FLIGHT' }]),
    'BLOCKED',
  );
  assert.equal(computeDependencyState(statusPrerequisites([TaskStatus.DONE])), 'READY');
});

test('a conclusive NO needs a human; every other clause is an ordinary wait', () => {
  const waiting: VerificationEpochGate[] = [
    'VERIFICATION_IN_FLIGHT', 'VERDICT_ABSENT', 'VERDICT_UNREVISIONED',
    'RUN_NOT_SETTLED', 'VERDICT_NOT_APPLIED', 'SUBJECT_NOT_DONE',
  ];
  for (const verificationGate of waiting) {
    assert.equal(
      computeDependencyState([{ status: TaskStatus.DONE, verificationGate }]),
      'BLOCKED',
      `${verificationGate} is a wait`,
    );
  }
  for (const verificationGate of ['VERIFICATION_FAILED', 'VERIFICATION_INCONCLUSIVE',
    'NO_LIVE_VERIFICATION'] as VerificationEpochGate[]) {
    assert.equal(
      computeDependencyState([{ status: TaskStatus.DONE, verificationGate }]),
      'BLOCKED_FAILED',
      `${verificationGate} needs a person`,
    );
  }
});

test('the gate rides §13.6 SU9 to the chain tail, not only to the row the edge names', () => {
  const statusOf = new Map([['old', 'CANCELLED'], ['new', 'DONE']]);
  const edges = new Map([['old', 'new'], ['new', null]]);
  assert.equal(dependencySatisfied('old', statusOf, edges), true);
  assert.equal(
    dependencySatisfied('old', statusOf, edges, new Map([
      ['new', { subjectTaskId: 'new', gate: 'VERIFICATION_FAILED' as const }],
    ])),
    false,
    'the attempt that replaced the cancelled one is the one whose epoch decides',
  );
  assert.equal(
    dependencySatisfied('old', statusOf, edges, new Map([
      ['new', { subjectTaskId: 'new', gate: null }],
    ])),
    true,
  );
});

// ---------------------------------------------------------------------------
// DEP4's key, in the one spelling both languages use
// ---------------------------------------------------------------------------

test('the ledger key is the §8.2 one, built from internal ids and the exact revision', () => {
  assert.equal(
    verificationVerdictActionKeyOf('11111111-1111-7111-8111-111111111111', 'v', 3n),
    'pc:v1:11111111-1111-7111-8111-111111111111:verdict:v:3',
  );
});
