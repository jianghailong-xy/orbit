import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_CONVERGENCE_THRESHOLDS,
  DEFAULT_COORDINATOR_SPEND_LIMITS,
  ZERO_COUNTERS,
} from './convergence-contract';
import { DerivedProgress, deriveProgressVector } from './convergence-evidence';
import { ProgressVector, progressVectorDigest } from './convergence-progress';
import {
  ChainedTask,
  EMPTY_WAKE_CONVERGENCE_STATE,
  PlannedWakeConvergence,
  WakeConvergenceState,
  coordinatorSpendVerdict,
  planWakeConvergence,
  successorRetries,
  wakeConvergenceKey,
} from './coordinator-convergence';

/**
 * Unit T4's decision procedure, without a database.
 *
 * Two halves. The wake half has NO opinion about progress: it asks `strictlyImproves` and records
 * the answer, and what these tests hold is that a wake is recorded and never charged or stopped.
 * The fuse half is the only thing that pauses a coordinator, and these tests hold its lines.
 */

const PROJECT = 'e2f1c3d4-0000-4000-8000-00000000beef';
const SCOPE = 'a'.repeat(64);
const OTHER_SCOPE = 'b'.repeat(64);
const AT = new Date('2026-08-25T00:00:00.000Z');

/** N: the limit the retired breaker counted to, read from the frozen table. */
const N = DEFAULT_CONVERGENCE_THRESHOLDS.maxDecisionsWithoutProgress as number;

/** A believable measurement of a world with `total` stated criteria and `closed` of the project's
 *  blockers resolved. Migration 0229 removed the acceptance judgment, so a criterion can no longer
 *  be closed and `acceptanceClosed` left the vector with it; `openBlockers` is the dimension these
 *  cases move now, and it moves the same way for the same reason. */
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
      observedAt: asOf,
    })),
    findings: Array.from({ length: options.openP0 ?? 0 }, (_, i) => ({
      fingerprint: `f${i}`,
      severity: 'P0' as const,
      resolved: false,
      regression: false,
      observedAt: asOf,
    })),
    // `total` blockers, of which the first `closed` are resolved — so the caller's two numbers
    // read exactly as they always did (`measured(1, 4)` is one step better than `measured(0, 4)`)
    // against a dimension that still exists. `openBlockers` adds unresolved ones on top.
    blockers: [
      ...Array.from({ length: total }, (_, i) => ({
        key: `c${i}`,
        resolved: i < closed,
        observedAt: asOf,
      })),
      ...Array.from({ length: options.openBlockers ?? 0 }, (_, i) => ({
        key: `b${i}`,
        resolved: false,
        observedAt: asOf,
      })),
    ],
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

test('a wake records whether it improved, and is charged nothing either way', () => {
  const first = plan(EMPTY_WAKE_CONVERGENCE_STATE, measured(0, 4));
  assert.equal(first.progressed, false);
  assert.deepEqual(first.counters, ZERO_COUNTERS);

  const stalled = plan(committed(first), measured(0, 4));
  assert.equal(stalled.progressed, false);
  assert.deepEqual(stalled.counters, ZERO_COUNTERS);

  const moved = plan(committed(stalled), measured(1, 4));
  assert.equal(moved.progressed, true);
  assert.deepEqual(moved.counters, ZERO_COUNTERS);
});

test("a project's first wake is measured against an empty baseline, and says so", () => {
  // `EMPTY_PROGRESS_VECTOR` is the fallback the task ledger uses for a first observation too, and
  // what it means changed when migration 0229 removed `acceptanceClosed` from the vector. That was
  // the one dimension that improved by going UP, and it carried a consequence worth stating: a
  // project that already had a criterion passing before anybody woke its coordinator read as one
  // free improvement. Every remaining dimension is a defect count, and an empty baseline is
  // already the best reading of one — so a first wake now claims no progress at all, and the free
  // pass is gone with the axis that granted it.
  const first = plan(EMPTY_WAKE_CONVERGENCE_STATE, measured(1, 4));
  assert.equal(first.input.previousProgressVector, null);
  assert.equal(first.progressed, false, 'a first measurement cannot improve on nothing');
  const second = plan(committed(first), measured(1, 4));
  assert.equal(second.progressed, false);
  // And a genuine improvement against that first real measurement still counts.
  assert.equal(plan(committed(second), measured(2, 4)).progressed, true);
});

test('activity is not progress: a different wake event on an unchanged world is not an improvement', () => {
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
});

test('trading one dimension for another is not progress', () => {
  // Even against the empty baseline this is not progress: one criterion closed, but a P0 opened.
  const first = plan(EMPTY_WAKE_CONVERGENCE_STATE, measured(1, 4, { openP0: 1 }));
  assert.equal(first.progressed, false);
  // One criterion closed AND one more P0 open: `strictlyImproves` disqualifies the whole step.
  const traded = plan(committed(first), measured(2, 4, { openP0: 2 }));
  assert.equal(traded.progressed, false);
});

test('however many wakes improve nothing, every one proceeds and none is charged', () => {
  let state: WakeConvergenceState = EMPTY_WAKE_CONVERGENCE_STATE;
  // Well past the line the retired breaker stopped at: the (N + 1)th wake is the one it refused.
  for (let i = 0; i < N + 20; i += 1) {
    const planned = plan(state, measured(0, 4), `k${i}`);
    assert.equal(planned.outcome, 'PROCEED', `wake ${i + 1} was not allowed`);
    assert.deepEqual(planned.counters, ZERO_COUNTERS, `wake ${i + 1} charged a counter`);
    state = committed(planned);
  }
});

test('a project the retired breaker stopped proceeds from its next wake, its old counters carried as they were', () => {
  const stopped: WakeConvergenceState = {
    scopeHash: SCOPE,
    counters: { ...ZERO_COUNTERS, decisionsWithoutProgress: N + 1 },
    progressVector: measured(0, 4).vector,
    lastOutcome: 'STOP',
  };
  const next = plan(stopped, measured(0, 4), 'after-the-stop');
  assert.equal(next.outcome, 'PROCEED');
  assert.equal(next.input.lastOutcome, 'STOP', 'the row records what the previous one concluded');
  assert.deepEqual(next.counters, stopped.counters, 'a wake neither charges nor clears the old count');
});

test('a new scope is a new question: neither the counters nor the vector carry', () => {
  const stopped: WakeConvergenceState = {
    scopeHash: SCOPE,
    counters: { ...ZERO_COUNTERS, decisionsWithoutProgress: N + 1 },
    progressVector: measured(0, 4).vector,
    lastOutcome: 'STOP',
  };
  // A person rewrote what the project is asking for. §4 PV4's second licence: the old counters
  // were about a different question, and a measurement against a different target says nothing
  // about this one.
  const rescoped = plan(stopped, measured(0, 9, { scope: OTHER_SCOPE }), 'rescoped');
  assert.equal(rescoped.input.scopeChanged, true);
  assert.equal(rescoped.input.previousProgressVector, null);
  assert.deepEqual(rescoped.counters, ZERO_COUNTERS);
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
  assert.equal((second.progressVector as ProgressVector).openBlockers, 2);
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

test('the fuse pauses on a kind of spend that exceeds its limit, never on one that reaches it', () => {
  const limits = DEFAULT_COORDINATOR_SPEND_LIMITS;
  const turns = limits.maxSelfStartedTurnsPerDay as number;
  const sessions = limits.maxSessionsOpenedPerDay as number;
  const retries = limits.maxRetriesPerSuccessorChain as number;

  assert.deepEqual(
    coordinatorSpendVerdict({ selfStartedTurns: turns, sessionsOpened: sessions, successorRetries: retries }, limits),
    { paused: false, reason: null, observed: null, limit: null },
  );
  assert.deepEqual(
    coordinatorSpendVerdict({ selfStartedTurns: 0, sessionsOpened: 0, successorRetries: retries + 1 }, limits),
    { paused: true, reason: 'SUCCESSOR_RETRIES', observed: retries + 1, limit: retries },
  );
  // Two lines crossed at once report one of them, and always the same one.
  assert.deepEqual(
    coordinatorSpendVerdict({ selfStartedTurns: turns + 1, sessionsOpened: sessions + 1, successorRetries: 0 }, limits),
    { paused: true, reason: 'SELF_STARTED_TURNS', observed: turns + 1, limit: turns },
  );
  // An unbounded line is not a line.
  assert.equal(
    coordinatorSpendVerdict(
      { selfStartedTurns: turns * 10, sessionsOpened: 0, successorRetries: 0 },
      { ...limits, maxSelfStartedTurnsPerDay: null },
    ).paused,
    false,
  );
});

test('retries count what an agent filed in the longest chain extended inside the window', () => {
  const since = new Date(AT.getTime() - 24 * 60 * 60_000);
  const recent = AT;
  const stale = new Date(since.getTime() - 1);
  /** A chain from its first attempt: `filedBy[i]` filed attempt i + 1, `at` dates every link. */
  const chain = (name: string, filedBy: boolean[], at: Date): ChainedTask[] => {
    const ids = Array.from({ length: filedBy.length + 1 }, (_, i) => `${name}${i}`);
    return ids.map((id, i) => ({
      id,
      supersededByTaskId: ids[i + 1] ?? null,
      supersededAt: i < filedBy.length ? at : null,
      // The first attempt is an agent's too, and is still not a retry.
      filedByAgent: i === 0 ? true : filedBy[i - 1]!,
    }));
  };

  const tasks = [
    ...chain('agent', [true, true, true], recent),
    ...chain('person', [false, false, false, false, false], recent),
    ...chain('mixed', [true, false, true, true], recent),
    ...chain('stopped', [true, true, true, true, true, true], stale),
  ];
  assert.equal(successorRetries(tasks, since), 3);
  assert.equal(successorRetries(chain('person', [false, false], recent), since), 0);
  assert.equal(successorRetries(chain('stopped', [true, true, true], stale), since), 0);
  assert.equal(successorRetries([], since), 0);
});
