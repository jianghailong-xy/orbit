import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_CONVERGENCE_THRESHOLDS,
  ZERO_COUNTERS,
  ConvergenceCounters,
  ConvergenceThresholds,
} from './convergence-contract';
import { EMPTY_PROGRESS_VECTOR, ProgressVector, scopeHash } from './convergence-progress';
import {
  ConvergenceLedgerEntry,
  ConvergenceObservation,
  ConvergenceState,
  convergenceActionKey,
  convergenceDecisionKey,
  planConvergenceDecision,
  planScopeRevision,
  recoverConvergenceState,
} from './convergence-ledger';

// `[K2]`'s planner, against the frozen contract.
//
// The pg spec proves the DATABASE refuses a bad write. This one proves the plan handed to it was
// right in the first place, and it is written against the two failures the ledger exists to make
// impossible:
//
//   * a redelivered event writing a second row — which is counter inflation, and therefore a budget
//     that never runs out;
//   * a tripped breaker producing an action anyway — which is the incident's three hundred rounds.
//
// Every assertion below is a line of `docs/project-coordinator-convergence-contract.md`, cited.

const TASK = '019fcda0-d021-72a2-a914-2f4de38f469c';
const SCOPE = scopeHash({ title: 'T', description: null, acceptanceCriteria: 'AC' });
const OTHER_SCOPE = scopeHash({ title: 'T', description: null, acceptanceCriteria: 'AC and more' });
const AT = new Date('2026-08-22T10:00:00.000Z');

function vector(over: Partial<ProgressVector> = {}): ProgressVector {
  return { ...EMPTY_PROGRESS_VECTOR, scopeHash: SCOPE, acceptanceTotal: 4, ...over };
}

function state(over: Partial<ConvergenceState> = {}): ConvergenceState {
  return {
    scopeRevision: 1,
    scopeHash: SCOPE,
    attemptGeneration: 1,
    progressState: 'CONVERGING',
    counters: { ...ZERO_COUNTERS },
    lastProgressAt: null,
    knownGoodSha: null,
    progressVector: vector(),
    lastFingerprint: null,
    ...over,
  };
}

function observation(over: Partial<ConvergenceObservation> = {}): ConvergenceObservation {
  return {
    observationKey: 'session:abc:failed',
    event: 'ATTEMPT_FAILED_IN_SCOPE',
    classification: 'IN_SCOPE_DEFECT',
    failure: {
      stage: 'RUN',
      subjectKind: 'TASK',
      scopeHash: SCOPE,
      violatedInvariant: 'TEST_RED',
      message: 'expected 3 got 4',
    },
    progressVector: vector(),
    observedAt: AT,
    decidedBy: 'ORCHESTRATOR',
    action: 'DISPATCH_ATTEMPT',
    ...over,
  };
}

const T = DEFAULT_CONVERGENCE_THRESHOLDS;

// -------------------------------------------------------------------------------------------
// AC1 — one logical decision per fact, whatever the delivery order or the reader's snapshot.
// -------------------------------------------------------------------------------------------

test('AC1: the idempotency key is the fact\'s identity, not the reader\'s snapshot', () => {
  // The whole point. After the first delivery commits, a redelivery reads a DIFFERENT world — the
  // counters moved. A key derived from that world would differ, and the same fact would be written
  // twice. So: same key, different input hash.
  const first = planConvergenceDecision(TASK, state(), observation(), T);
  const afterwards = state({
    counters: first.counters,
    lastFingerprint: first.failureFingerprint,
    progressVector: first.progressVector,
  });
  const redelivery = planConvergenceDecision(TASK, afterwards, observation(), T);

  assert.equal(redelivery.idempotencyKey, first.idempotencyKey);
  assert.notEqual(redelivery.inputHash, first.inputHash);
  assert.equal(
    first.idempotencyKey,
    convergenceDecisionKey(TASK, 1, 'session:abc:failed'),
  );
});

test('AC1: the same fact after a re-plan is a NEW judgment, not a deduplicated old one', () => {
  // §5 FP3's logic applied to keys: "the same error" under a different question is a different
  // problem, and deduping it against revision 1's row would answer the new question with the old
  // answer.
  const before = planConvergenceDecision(TASK, state(), observation(), T);
  const after = planConvergenceDecision(
    TASK,
    state({ scopeRevision: 2, scopeHash: OTHER_SCOPE, progressVector: null }),
    observation({
      progressVector: vector({ scopeHash: OTHER_SCOPE }),
      failure: { ...observation().failure!, scopeHash: OTHER_SCOPE },
    }),
    T,
  );
  assert.notEqual(after.idempotencyKey, before.idempotencyKey);
});

test('AC1: an action is keyed per attempt, so a takeover cannot dispatch a second time', () => {
  const planned = planConvergenceDecision(
    TASK,
    state({ progressState: 'CONVERGING' }),
    observation({ event: 'ATTEMPT_STARTED', classification: null, failure: null }),
    T,
  );
  assert.equal(planned.attemptGeneration, 2, 'ATTEMPT_STARTED allocates the next generation');
  assert.equal(
    planned.actionIdempotencyKey,
    convergenceActionKey(TASK, 1, 2, 'DISPATCH_ATTEMPT'),
  );
});

test('a judgment that acts on nothing records no action key', () => {
  const planned = planConvergenceDecision(TASK, state(), observation({ action: null }), T);
  assert.equal(planned.action, null);
  assert.equal(planned.actionIdempotencyKey, null);
});

// -------------------------------------------------------------------------------------------
// §8 — the breaker, and what it is allowed to do afterwards.
// -------------------------------------------------------------------------------------------

test('§8/§9 GT1: a tripped breaker produces NO action, however much budget is left', () => {
  // The incident in one assertion. Every one of those three hundred rounds produced an action, so
  // every liveness check was green while nothing converged.
  const counters: ConvergenceCounters = { ...ZERO_COUNTERS, sameFingerprintRepeats: 2 };
  const planned = planConvergenceDecision(
    TASK,
    state({ counters, lastFingerprint: fingerprintOf() }),
    observation(),
    T,
  );
  assert.equal(planned.nonConvergenceReason, 'SAME_FAILURE_REPEATED');
  assert.equal(planned.toState, 'NEEDS_REPLAN');
  assert.equal(planned.decision, 'FREEZE_AND_REQUEST_REPLAN');
  assert.equal(planned.action, null);
  assert.equal(planned.actionIdempotencyKey, null);
});

test('§3 CL3: a scope expansion freezes and asks, with maxScopeExpansionRequests at 0', () => {
  const planned = planConvergenceDecision(
    TASK,
    state(),
    observation({
      event: 'SCOPE_EXPANSION_REQUESTED',
      classification: 'SCOPE_EXPANSION',
      observationKey: 'finding:bigger',
    }),
    T,
  );
  assert.equal(planned.toState, 'NEEDS_REPLAN');
  assert.equal(planned.nonConvergenceReason, 'SCOPE_EXPANSION_REQUIRED');
  assert.equal(planned.action, null);
  assert.equal(planned.owner, 'USER');
  assert.equal(planned.nextCheckAt, null, 'a wait for a person has no clock');
});

test('§6 FD3: verification that keeps failing is re-planned, not repaired again', () => {
  const counters: ConvergenceCounters = { ...ZERO_COUNTERS, verificationRounds: 2 };
  const planned = planConvergenceDecision(
    TASK,
    state({ progressState: 'VERIFYING', counters }),
    observation({
      event: 'VERIFICATION_FAILED_IN_SCOPE',
      classification: 'IN_SCOPE_DEFECT',
      verificationRoundClosed: true,
      observationKey: 'verdict:v1:3',
    }),
    T,
  );
  assert.equal(planned.counters.verificationRounds, 3);
  assert.equal(planned.nonConvergenceReason, 'VERIFICATION_ROUNDS_EXHAUSTED');
  assert.equal(planned.decision, 'FREEZE_AND_REQUEST_REPLAN');
});

test('§3 CL2: a transient failure past its budget is re-classified before it is charged', () => {
  const counters: ConvergenceCounters = { ...ZERO_COUNTERS, transientRetries: 3 };
  const planned = planConvergenceDecision(
    TASK,
    state({ counters, progressState: 'RETRYING_TRANSIENT' }),
    observation({ event: 'ATTEMPT_FAILED_TRANSIENT', classification: 'TRANSIENT' }),
    T,
  );
  assert.equal(planned.classification, 'IN_SCOPE_DEFECT', '「一直偶发」就是必然');
  assert.equal(planned.counters.transientRetries, 3, 'the transient counter is not charged again');
  assert.equal(planned.counters.attemptsWithoutProgress, 1, 'it lands on the attempt budget');
});

test('§3 CL1: an environment failure never spends the attempt budget', () => {
  const planned = planConvergenceDecision(
    TASK,
    state(),
    observation({
      event: 'ENVIRONMENT_FAILURE',
      classification: 'ENVIRONMENT',
      observationKey: 'env:disk-full',
    }),
    T,
  );
  assert.equal(planned.counters.attemptsWithoutProgress, 0);
  assert.equal(planned.toState, 'BLOCKED');
  assert.equal(planned.owner, 'SYSTEM');
  assert.ok(planned.nextCheckAt, 'a system blocker recovers on a clock, so it has one');
});

test('a blocked prerequisite is the coordinator\'s to clear, not a person\'s', () => {
  const planned = planConvergenceDecision(
    TASK,
    state(),
    observation({
      event: 'PREREQUISITE_FOUND',
      classification: 'PREREQUISITE',
      observationKey: 'finding:needs-x',
    }),
    T,
  );
  assert.equal(planned.decision, 'CREATE_PREREQUISITE_TASK');
  assert.equal(planned.owner, 'COORDINATOR');
  assert.ok(planned.requiredAction);
});

test('§2: a (state, event) pair the table does not have still costs a decision', () => {
  // "Nothing applied" was the incident's most common step. Treating it as free is what let the loop
  // run unbounded while every individual rule looked satisfied.
  const planned = planConvergenceDecision(
    TASK,
    state({ progressState: 'NEEDS_REPLAN' }),
    observation({ event: 'ATTEMPT_FAILED_IN_SCOPE', classification: null, failure: null }),
    T,
  );
  assert.equal(planned.decision, 'NO_TRANSITION');
  assert.equal(planned.toState, 'NEEDS_REPLAN');
  assert.equal(planned.counters.decisionsWithoutProgress, 1);
});

test('SM1: a SETTLED task is never tripped and never leaves', () => {
  const spent: ConvergenceCounters = { ...ZERO_COUNTERS, decisionsWithoutProgress: 99 };
  const planned = planConvergenceDecision(
    TASK,
    state({ progressState: 'SETTLED', counters: spent }),
    observation({ event: 'TASK_TERMINAL', classification: null, failure: null }),
    T,
  );
  assert.equal(planned.toState, 'SETTLED');
  assert.equal(planned.nonConvergenceReason, null);
});

// -------------------------------------------------------------------------------------------
// §4 — progress.
// -------------------------------------------------------------------------------------------

test('§4 PV4: strict progress zeroes the four, and only the four', () => {
  const spent: ConvergenceCounters = {
    attemptsOnRevision: 7,
    attemptsWithoutProgress: 4,
    sameFingerprintRepeats: 1,
    decisionsWithoutProgress: 5,
    verificationRounds: 1,
    transientRetries: 2,
    scopeExpansionRequests: 0,
  };
  const planned = planConvergenceDecision(
    TASK,
    state({ counters: spent }),
    observation({
      event: 'ATTEMPT_DELIVERED',
      classification: null,
      failure: null,
      progressVector: vector({ acceptanceClosed: 1 }),
      observationKey: 'session:abc:delivered',
    }),
    T,
  );
  assert.equal(planned.progressed, true);
  assert.deepEqual(planned.counters, {
    attemptsOnRevision: 7,
    attemptsWithoutProgress: 0,
    sameFingerprintRepeats: 0,
    decisionsWithoutProgress: 0,
    verificationRounds: 1,
    transientRetries: 0,
    scopeExpansionRequests: 0,
  });
  assert.deepEqual(planned.taskState.lastProgressAt, AT);
});

test('§4 PV3: measuring a different scope is not progress', () => {
  const planned = planConvergenceDecision(
    TASK,
    state({ counters: { ...ZERO_COUNTERS, attemptsWithoutProgress: 3 } }),
    observation({
      progressVector: vector({ scopeHash: OTHER_SCOPE, acceptanceClosed: 4 }),
      classification: null,
      failure: null,
      event: 'ATTEMPT_DELIVERED',
    }),
    T,
  );
  assert.equal(planned.progressed, false, '换了目标不算逼近目标');
  assert.equal(planned.counters.attemptsWithoutProgress, 3);
});

test('§4 PV5: a new known-good checkpoint counts once, and moving it does not', () => {
  const first = planConvergenceDecision(
    TASK,
    state(),
    observation({
      classification: null,
      failure: null,
      event: 'ATTEMPT_DELIVERED',
      progressVector: vector({ knownGoodSha: 'a'.repeat(40) }),
    }),
    T,
  );
  assert.equal(first.progressed, true);
  assert.equal(first.taskState.knownGoodSha, 'a'.repeat(40));

  const moved = planConvergenceDecision(
    TASK,
    state({ progressVector: first.progressVector, knownGoodSha: 'a'.repeat(40) }),
    observation({
      classification: null,
      failure: null,
      event: 'ATTEMPT_DELIVERED',
      observationKey: 'session:abc:delivered-2',
      progressVector: vector({ knownGoodSha: 'b'.repeat(40) }),
    }),
    T,
  );
  assert.equal(moved.progressed, false, '「又推了一个提交」不是进展');
});

// -------------------------------------------------------------------------------------------
// The incident, replayed.
// -------------------------------------------------------------------------------------------

test('§0: three hundred rounds of one failure stop inside four, and stay stopped', () => {
  let current = state({ progressVector: vector() });
  let tripped: number | null = null;

  for (let round = 1; round <= 300; round += 1) {
    // Every round is a new session, a new timestamp and a moved line number — which is exactly why
    // the incident's every retry looked like a new problem.
    const planned = planConvergenceDecision(
      TASK,
      current,
      observation({
        observationKey: `session:round-${round}:failed`,
        failure: {
          stage: 'RUN',
          subjectKind: 'TASK',
          scopeHash: SCOPE,
          violatedInvariant: 'TEST_RED',
          message: `2026-08-22T1${round % 10}:00:00Z /w/${round}/src/a.ts:${round}:4 expected 3 got 4`,
        },
      }),
      T,
    );
    if (planned.nonConvergenceReason && tripped === null) tripped = round;
    if (tripped !== null) {
      assert.equal(planned.action, null, `round ${round} must not act after the trip`);
      assert.equal(planned.toState, 'NEEDS_REPLAN');
    }
    current = {
      ...current,
      counters: planned.counters,
      lastFingerprint: planned.failureFingerprint,
      progressState: planned.toState,
      progressVector: planned.progressVector,
    };
  }

  assert.equal(tripped, 4, 'the fourth identical failure is the one that trips SAME_FAILURE_REPEATED');
});

test('§0: SM4 — nothing but an explicit authorization leaves NEEDS_REPLAN', () => {
  const frozen = state({ progressState: 'NEEDS_REPLAN', counters: { ...ZERO_COUNTERS, scopeExpansionRequests: 1 } });
  for (const event of ['ATTEMPT_STARTED', 'ATTEMPT_DELIVERED', 'BLOCKER_CLEARED'] as const) {
    const planned = planConvergenceDecision(
      TASK,
      frozen,
      observation({ event, classification: null, failure: null, observationKey: `retry:${event}` }),
      T,
    );
    assert.equal(planned.toState, 'NEEDS_REPLAN', `${event} must not restart a frozen task`);
    assert.equal(planned.action, null);
  }
  const authorized = planConvergenceDecision(
    TASK,
    frozen,
    observation({
      event: 'REPLAN_AUTHORIZED',
      classification: null,
      failure: null,
      observationKey: 'user:replan',
      decidedBy: 'USER',
    }),
    T,
  );
  // The state machine moves; the breaker still reads a spent counter, which is why authorizing a
  // re-plan means writing a new revision (`planScopeRevision`) and not merely sending an event.
  assert.equal(authorized.nonConvergenceReason, 'SCOPE_EXPANSION_REQUIRED');
});

// -------------------------------------------------------------------------------------------
// AC2 — a scope change is somebody's decision.
// -------------------------------------------------------------------------------------------

const CURRENT = { scopeRevision: 1, scopeHash: SCOPE };
const PROPOSAL = {
  title: 'T',
  description: null,
  acceptanceCriteria: 'AC and more',
  reason: 'the defect is bigger than the task',
};

test('AC2: §1 — a worker or a verifier may report, never revise', () => {
  for (const actor of ['WORKER', 'VERIFIER'] as const) {
    for (const policy of ['MANUAL', 'GUARDED_AUTO', 'AUTO'] as const) {
      assert.equal(
        planScopeRevision(CURRENT, { ...PROPOSAL, actor, principal: 'p' }, policy),
        'SCOPE_CHANGE_REQUIRES_USER',
        `${actor} under ${policy}`,
      );
    }
  }
});

test('AC2: §1 OW3/OW5 — the coordinator re-scopes only where the user signed for it in advance', () => {
  assert.equal(
    planScopeRevision(CURRENT, { ...PROPOSAL, actor: 'COORDINATOR', principal: 'agent' }, 'GUARDED_AUTO'),
    'REPLAN_REQUIRES_AUTHORIZATION',
  );
  const underAuto = planScopeRevision(
    CURRENT,
    { ...PROPOSAL, actor: 'COORDINATOR', principal: 'agent' },
    'AUTO',
  );
  assert.notEqual(typeof underAuto, 'string');
});

test('AC2: a revision restarts the budget and names the one it replaced', () => {
  const planned = planScopeRevision(CURRENT, { ...PROPOSAL, actor: 'USER', principal: 'u-1' }, 'GUARDED_AUTO');
  assert.notEqual(typeof planned, 'string');
  if (typeof planned === 'string') return;
  assert.equal(planned.revision, 2);
  assert.equal(planned.supersedesRevision, 1);
  assert.notEqual(planned.scopeHash, SCOPE);
  assert.deepEqual(planned.counters, ZERO_COUNTERS);
});

test('AC2: a revision that changes nothing is refused', () => {
  // Otherwise the cheapest way past §8 is to re-file the same scope and take a fresh budget.
  assert.equal(
    planScopeRevision(
      CURRENT,
      { title: 'T', description: null, acceptanceCriteria: 'AC', actor: 'USER', principal: 'u-1', reason: 'x' },
      'GUARDED_AUTO',
    ),
    'SCOPE_UNCHANGED',
  );
});

test('AC2: OW4\'s shape — a signature with no principal is not a weaker signature', () => {
  assert.equal(
    planScopeRevision(CURRENT, { ...PROPOSAL, actor: 'USER', principal: '  ' }, 'GUARDED_AUTO'),
    'SCOPE_AUTHOR_UNIDENTIFIED',
  );
});

// -------------------------------------------------------------------------------------------
// AC4 — recovery from the ledger alone.
// -------------------------------------------------------------------------------------------

function entry(over: Partial<ConvergenceLedgerEntry> & { seq: number }): ConvergenceLedgerEntry {
  return {
    scopeRevision: 1,
    scopeHash: SCOPE,
    attemptGeneration: 1,
    event: 'ATTEMPT_FAILED_IN_SCOPE',
    toState: 'CONVERGING',
    progressed: false,
    counters: { ...ZERO_COUNTERS },
    progressVector: vector(),
    failureFingerprint: null,
    knownGoodSha: null,
    createdAt: AT,
    ...over,
  };
}

test('AC4: the state is rebuilt from the ledger, in seq order and not arrival order', () => {
  const rebuilt = recoverConvergenceState(1, SCOPE, [
    entry({ seq: 3, attemptGeneration: 2, toState: 'VERIFYING', counters: { ...ZERO_COUNTERS, attemptsOnRevision: 2 } }),
    entry({ seq: 1, toState: 'CONVERGING' }),
    entry({
      seq: 2,
      progressed: true,
      knownGoodSha: 'c'.repeat(40),
      createdAt: new Date('2026-08-22T09:00:00.000Z'),
    }),
  ]);
  assert.equal(rebuilt.progressState, 'VERIFYING');
  assert.equal(rebuilt.attemptGeneration, 2);
  assert.equal(rebuilt.counters.attemptsOnRevision, 2);
  assert.deepEqual(rebuilt.lastProgressAt, new Date('2026-08-22T09:00:00.000Z'));
  assert.equal(rebuilt.knownGoodSha, 'c'.repeat(40));
});

test('AC4: a superseded revision\'s spend is not charged to the new one', () => {
  const rebuilt = recoverConvergenceState(2, OTHER_SCOPE, [
    entry({ seq: 1, counters: { ...ZERO_COUNTERS, attemptsOnRevision: 24 } }),
    entry({ seq: 2, scopeRevision: 2, scopeHash: OTHER_SCOPE, counters: { ...ZERO_COUNTERS, attemptsOnRevision: 1 } }),
  ]);
  assert.equal(rebuilt.counters.attemptsOnRevision, 1);
});

test('AC4: a task with no ledger recovers to the opening state, not to an error', () => {
  const rebuilt = recoverConvergenceState(1, SCOPE, []);
  assert.equal(rebuilt.progressState, 'CONVERGING');
  assert.equal(rebuilt.attemptGeneration, 0);
  assert.deepEqual(rebuilt.counters, ZERO_COUNTERS);
});

// -------------------------------------------------------------------------------------------
// OW4 — an unbounded threshold only exists with a user's signature.
// -------------------------------------------------------------------------------------------

test('OW4: an unbounded threshold cannot stop the breaker without a USER behind it', () => {
  const unbounded: ConvergenceThresholds = { ...T, maxSameFingerprintRepeats: null };
  const counters: ConvergenceCounters = { ...ZERO_COUNTERS, sameFingerprintRepeats: 99 };
  const bounded = planConvergenceDecision(
    TASK,
    state({ counters, lastFingerprint: fingerprintOf() }),
    observation(),
    T,
  );
  assert.equal(bounded.nonConvergenceReason, 'SAME_FAILURE_REPEATED');

  // With a USER's signature that one line really is off. The others are not, which is the property
  // that says the breaker has no single point of failure: raise `decisionsWithoutProgress` past its
  // own limit and the next line down answers instead.
  const signed = planConvergenceDecision(
    TASK,
    state({ counters, lastFingerprint: fingerprintOf() }),
    observation(),
    unbounded,
  );
  assert.equal(signed.nonConvergenceReason, null);

  const spentElsewhere = planConvergenceDecision(
    TASK,
    state({
      counters: { ...counters, decisionsWithoutProgress: 6 },
      lastFingerprint: fingerprintOf(),
    }),
    observation(),
    unbounded,
  );
  assert.equal(spentElsewhere.nonConvergenceReason, 'NO_PROGRESS');
});

/** The fingerprint the default observation produces, for tests that need the PREVIOUS one. */
function fingerprintOf(): string {
  return planConvergenceDecision(TASK, state(), observation(), T).failureFingerprint!;
}
