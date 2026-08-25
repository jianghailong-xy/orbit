import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_CONVERGENCE_THRESHOLDS,
  ZERO_COUNTERS,
} from './convergence-contract';
import { DerivedProgress, deriveProgressVector } from './convergence-evidence';
import { ProgressVector, progressVectorDigest } from './convergence-progress';
import {
  COORDINATOR_NO_PROGRESS_KIND,
  COORDINATOR_NO_PROGRESS_OWNER,
  EMPTY_WAKE_CONVERGENCE_STATE,
  PlannedWakeConvergence,
  WakeConvergenceState,
  noProgressBlocker,
  noProgressDedupeKey,
  planWakeConvergence,
  wakeConvergenceKey,
} from './coordinator-convergence';

/**
 * Unit T4's decision procedure, without a database.
 *
 * The point every test below is making is the same one: this module has NO opinion about progress.
 * It asks `strictlyImproves`, `advanceCounters` and `detectNonConvergence` — the frozen contract's
 * own functions — and what it adds is the order they are asked in and the answer "may the
 * coordinator go on being woken". The tests are therefore mostly about what a WAKE costs and when
 * the raise happens, because those are the two things the incident got wrong.
 */

const PROJECT = 'e2f1c3d4-0000-4000-8000-00000000beef';
const SCOPE = 'a'.repeat(64);
const OTHER_SCOPE = 'b'.repeat(64);
const AT = new Date('2026-08-25T00:00:00.000Z');

/** N: the documented default, read from the frozen table rather than restated as a literal here. */
const N = DEFAULT_CONVERGENCE_THRESHOLDS.maxDecisionsWithoutProgress as number;

/** A believable measurement of a world with `closed` of `total` criteria passing. */
function measured(closed: number, total: number, options: {
  scope?: string;
  openP0?: number;
  openBlockers?: number;
} = {}): DerivedProgress {
  const scope = options.scope ?? SCOPE;
  const asOf = AT;
  return deriveProgressVector({
    scopeHash: scope,
    acceptance: Array.from({ length: total }, (_, i) => ({
      id: `c${i}`,
      closed: i < closed,
      observedAt: asOf,
    })),
    findings: Array.from({ length: options.openP0 ?? 0 }, (_, i) => ({
      fingerprint: `f${i}`,
      severity: 'P0' as const,
      resolved: false,
      regression: false,
      observedAt: asOf,
    })),
    blockers: Array.from({ length: options.openBlockers ?? 0 }, (_, i) => ({
      key: `b${i}`,
      resolved: false,
      observedAt: asOf,
    })),
    checkpoint: null,
    asOf,
    notBefore: null,
  });
}

function plan(
  state: WakeConvergenceState,
  derived: DerivedProgress,
  wakeKey = 'cw:v1:ATTEMPT_ENDED_UNSETTLED:TASK:t:s',
): PlannedWakeConvergence {
  return planWakeConvergence(
    PROJECT,
    state,
    { wakeKey, event: 'ATTEMPT_ENDED_UNSETTLED', derived, observedAt: AT },
    DEFAULT_CONVERGENCE_THRESHOLDS,
  );
}

/** The state the next wake reads, as the service derives it from the row just committed. */
function committed(planned: PlannedWakeConvergence): WakeConvergenceState {
  return {
    scopeHash: planned.scopeHash,
    counters: planned.counters,
    progressVector: planned.progressVector,
    lastOutcome: planned.outcome,
  };
}

test('a wake that changed nothing is charged, and one that closed a criterion is not', () => {
  const first = plan(EMPTY_WAKE_CONVERGENCE_STATE, measured(0, 4));
  assert.equal(first.progressed, false);
  assert.equal(first.counters.decisionsWithoutProgress, 1);

  const stalled = plan(committed(first), measured(0, 4));
  assert.equal(stalled.progressed, false);
  assert.equal(stalled.counters.decisionsWithoutProgress, 2);

  const moved = plan(committed(stalled), measured(1, 4));
  assert.equal(moved.progressed, true);
  assert.equal(moved.counters.decisionsWithoutProgress, 0);
});

test("a project's first wake is measured against an empty baseline, and says so", () => {
  // `EMPTY_PROGRESS_VECTOR` is the fallback the task ledger uses for a first observation too, and
  // it has a consequence worth stating rather than discovering: a project that already had a
  // criterion passing before anybody woke its coordinator reads as one improvement. It happens at
  // most once per scope — the second wake compares against a real measurement — so it costs the
  // budget one pass and cannot be repeated without genuinely closing something.
  const first = plan(EMPTY_WAKE_CONVERGENCE_STATE, measured(1, 4));
  assert.equal(first.input.previousProgressVector, null);
  assert.equal(first.progressed, true);
  const second = plan(committed(first), measured(1, 4));
  assert.equal(second.progressed, false);
});

test('activity is not progress: a different wake event on an unchanged world still costs a pass', () => {
  let state = EMPTY_WAKE_CONVERGENCE_STATE;
  const events = ['ATTEMPT_ENDED_UNSETTLED', 'ATTEMPT_BUDGET_SPENT', 'CRITERION_READY'] as const;
  events.forEach((event, i) => {
    const planned = planWakeConvergence(
      PROJECT,
      state,
      { wakeKey: `k${i}`, event, derived: measured(0, 4), observedAt: AT },
      DEFAULT_CONVERGENCE_THRESHOLDS,
    );
    assert.equal(planned.progressed, false, `${event} moved nothing but claimed progress`);
    state = committed(planned);
  });
  assert.equal(state.counters.decisionsWithoutProgress, 3);
});

test('trading one dimension for another is not progress', () => {
  // Even against the empty baseline this is not progress: one criterion closed, but a P0 opened.
  const first = plan(EMPTY_WAKE_CONVERGENCE_STATE, measured(1, 4, { openP0: 1 }));
  assert.equal(first.progressed, false);
  // One criterion closed AND one more P0 open: `strictlyImproves` disqualifies the whole step, so
  // an agent cannot buy budget by moving one axis at the cost of another.
  const traded = plan(committed(first), measured(2, 4, { openP0: 2 }));
  assert.equal(traded.progressed, false);
  assert.equal(traded.counters.decisionsWithoutProgress, 2);
});

test('N consecutive wakes without strict improvement stop the N+1th, and only it raises', () => {
  let state: WakeConvergenceState = EMPTY_WAKE_CONVERGENCE_STATE;
  const outcomes: string[] = [];
  const raises: boolean[] = [];
  // N + 2 wakes: the first N are the budget, N+1 is the one that crosses it, N+2 is the proof that
  // being stopped raises nothing more.
  for (let i = 0; i < N + 2; i += 1) {
    const planned = plan(state, measured(0, 4), `k${i}`);
    outcomes.push(planned.outcome);
    raises.push(planned.raisesBlocker);
    state = committed(planned);
  }
  assert.deepEqual(
    outcomes,
    [...Array.from({ length: N }, () => 'PROCEED'), 'STOP', 'STOP'],
    'the stop must land on the wake AFTER N unimproved ones, not before and not later',
  );
  assert.deepEqual(
    raises,
    [...Array.from({ length: N }, () => false), true, false],
    'exactly one raise, on the transition into the stop',
  );
  assert.equal(state.counters.decisionsWithoutProgress, N + 2);
});

test('a stop names the line it crossed and the two numbers that crossed it', () => {
  let state: WakeConvergenceState = EMPTY_WAKE_CONVERGENCE_STATE;
  let stop: PlannedWakeConvergence | null = null;
  for (let i = 0; i < N + 1; i += 1) {
    const planned = plan(state, measured(0, 4), `k${i}`);
    if (planned.outcome === 'STOP') stop = planned;
    state = committed(planned);
  }
  assert.ok(stop);
  assert.equal(stop.nonConvergenceReason, 'NO_PROGRESS');
  assert.equal(stop.limit, N);
  assert.equal(stop.observed, N + 1);

  const blocker = noProgressBlocker(PROJECT, stop, {
    wakeId: 'w',
    event: 'ATTEMPT_ENDED_UNSETTLED',
    idempotencyKey: 'cw:v1:x',
  });
  assert.equal(blocker.kind, COORDINATOR_NO_PROGRESS_KIND);
  assert.equal(blocker.owner, COORDINATOR_NO_PROGRESS_OWNER);
  assert.equal(blocker.owner, 'USER');
  assert.equal(blocker.recovery, 'HUMAN');
  assert.equal(blocker.subjectType, 'PROJECT');
  assert.equal(blocker.subjectId, PROJECT);
  assert.equal(blocker.dedupeKey, noProgressDedupeKey(PROJECT));
  assert.match(blocker.requiredAction, new RegExp(`${N + 1} consecutive`));
});

test('strict progress after a stop re-arms the raise; without it nothing raises again', () => {
  let state: WakeConvergenceState = EMPTY_WAKE_CONVERGENCE_STATE;
  for (let i = 0; i < N + 1; i += 1) state = committed(plan(state, measured(0, 4), `k${i}`));
  assert.equal(state.lastOutcome, 'STOP');

  // The work actually moves. `strictlyImproves` says so, `advanceCounters` zeroes the window, and
  // the breaker has nothing left to trip on — so the coordinator is woken again.
  const recovered = plan(state, measured(1, 4), 'recovered');
  assert.equal(recovered.progressed, true);
  assert.equal(recovered.outcome, 'PROCEED');
  assert.equal(recovered.raisesBlocker, false);
  state = committed(recovered);

  // Stalling again is a NEW episode, and it gets its own row.
  for (let i = 0; i < N; i += 1) state = committed(plan(state, measured(1, 4), `m${i}`));
  const second = plan(state, measured(1, 4), 'second-stop');
  assert.equal(second.outcome, 'STOP');
  assert.equal(second.raisesBlocker, true);
});

test('a stop that is already committed never raises again, however many facts arrive', () => {
  let state: WakeConvergenceState = EMPTY_WAKE_CONVERGENCE_STATE;
  for (let i = 0; i < N + 1; i += 1) state = committed(plan(state, measured(0, 4), `k${i}`));

  // This is the regression test for `COORDINATOR_NO_PROGRESS`'s self-referential rebirth: the old
  // detector re-derived the condition from a snapshot on every pass and re-raised the row with an
  // unchanged reasonDigest, so clearing it bought a few seconds. Here the condition still holds —
  // and holds harder, twenty facts later — and not one of them raises anything.
  for (let i = 0; i < 20; i += 1) {
    const planned = plan(state, measured(0, 4), `after-${i}`);
    assert.equal(planned.outcome, 'STOP');
    assert.equal(planned.raisesBlocker, false, `wake ${i} after the stop raised a second blocker`);
    state = committed(planned);
  }
});

test('a new scope is a new question and a new budget', () => {
  let state: WakeConvergenceState = EMPTY_WAKE_CONVERGENCE_STATE;
  for (let i = 0; i < N + 1; i += 1) state = committed(plan(state, measured(0, 4), `k${i}`));
  assert.equal(state.lastOutcome, 'STOP');

  // A person rewrote what the project is asking for. §4 PV4's second licence: the old counters were
  // spent answering a different question, so they do not carry — and the old vector does not
  // either, because a measurement against a different target says nothing about this one.
  const rescoped = plan(state, measured(0, 9, { scope: OTHER_SCOPE }), 'rescoped');
  assert.equal(rescoped.input.scopeChanged, true);
  assert.equal(rescoped.input.previousProgressVector, null);
  assert.equal(rescoped.counters.decisionsWithoutProgress, 1);
  assert.equal(rescoped.outcome, 'PROCEED');
});

test('an unmeasured snapshot cannot claim progress', () => {
  // Nothing to measure: no criteria, no findings, no blockers. The vector is all zeros, which reads
  // as "every defect closed" to a comparison that only sees numbers, so PV6 refuses it the claim.
  const empty = deriveProgressVector({
    scopeHash: SCOPE,
    acceptance: [],
    findings: [],
    blockers: [],
    checkpoint: null,
    asOf: AT,
    notBefore: null,
  });
  assert.equal(empty.freshness, 'UNMEASURED');

  const withWork = plan(EMPTY_WAKE_CONVERGENCE_STATE, measured(0, 4, { openP0: 2 }));
  const nowEmpty = plan(committed(withWork), empty);
  assert.equal(nowEmpty.progressed, false, 'an empty snapshot claimed two P0s had been closed');
  assert.equal(nowEmpty.evidenceFreshness, 'UNMEASURED');
});

test('the ledger key is a function of the fact and the scope, and of nothing else', () => {
  const key = wakeConvergenceKey(PROJECT, SCOPE, 'cw:v1:PROJECT_TASKS_SETTLED:PROJECT:p:v');
  assert.equal(key, `pcv:v1:${PROJECT}:${SCOPE}:cw:v1:PROJECT_TASKS_SETTLED:PROJECT:p:v`);
  // Same fact, different scope: a judgment about a different question, so a different row.
  assert.notEqual(key, wakeConvergenceKey(PROJECT, OTHER_SCOPE, 'cw:v1:PROJECT_TASKS_SETTLED:PROJECT:p:v'));
});

test('the recorded pair is the before and the after, and the digest is of the after', () => {
  const first = plan(EMPTY_WAKE_CONVERGENCE_STATE, measured(0, 4));
  const second = plan(committed(first), measured(2, 4));
  assert.deepEqual(second.previousProgressVector, first.progressVector);
  assert.equal((second.progressVector as ProgressVector).acceptanceClosed, 2);
  assert.equal(second.progressVectorDigest, progressVectorDigest(second.progressVector));
  // The row's own input carries the same pair, so a replay reads it without its predecessor.
  assert.deepEqual(second.input.previousProgressVector, first.progressVector);
  assert.deepEqual(second.input.observedProgressVector, second.progressVector);
});

test('the planner reads a clock from nowhere: the same world plans the same decision', () => {
  const state: WakeConvergenceState = {
    scopeHash: SCOPE,
    counters: { ...ZERO_COUNTERS, decisionsWithoutProgress: 3 },
    progressVector: measured(0, 4).vector,
    lastOutcome: 'PROCEED',
  };
  const a = plan(state, measured(0, 4), 'replayed');
  const b = plan(state, measured(0, 4), 'replayed');
  assert.equal(a.inputHash, b.inputHash);
  assert.deepEqual(a.counters, b.counters);
});
