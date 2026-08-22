import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ConvergenceCounters,
  DEFAULT_CONVERGENCE_THRESHOLDS,
  SeverityTrend,
  ZERO_COUNTERS,
} from './convergence-contract';
import {
  EVIDENCE_MAX_AGE_MS,
  EvidenceSnapshot,
  actionIdentity,
  deriveProgressVector,
  evidenceSupportsProgress,
  hypothesisIdentity,
  severityTrend,
} from './convergence-evidence';
import {
  EMPTY_PROGRESS_VECTOR,
  ProgressVector,
  advanceCounters,
  convergenceDispatchRefusal,
  detectNonConvergence,
  scopeHash,
  strictlyImproves,
} from './convergence-progress';
import {
  ConvergenceObservation,
  ConvergenceState,
  convergenceActionKey,
  planConvergenceDecision,
} from './convergence-ledger';

// `[K4]`: the progress vector's evidence, the action's identity, and the two lines §0 walked past.
//
// `[K1]` proved the breaker is decidable and `[K2]` made its counters durable. Neither would have
// stopped the incident on its own, and this spec is written against the three reasons why:
//
//   1. the vector was whatever the caller said it was, so "we improved" was an assertion rather
//      than a measurement (§1: 由证据推导，无人手写);
//   2. every round's failure text carried a fresh session id, so `sameFingerprintRepeats` never
//      counted to two — while the ACTION was the same one every time;
//   3. every round closed something and opened something else, so no line about defects ever moved.
//
// The four `mutated:` tests at the end are AC5's reverse mutation: each one re-runs a replay with
// exactly one of this unit's rules removed and asserts the loop becomes unbounded again. A test
// that passes with the rule and fails without it is the only evidence that the rule is what is
// doing the work.

const TASK = '019fcda0-d021-72a2-a914-2f4de38f469c';
const SCOPE = scopeHash({ title: 'T', description: null, acceptanceCriteria: 'AC' });
const OTHER_SCOPE = scopeHash({ title: 'T', description: null, acceptanceCriteria: 'AC and more' });
const AT = new Date('2026-08-22T10:00:00.000Z');
const T = DEFAULT_CONVERGENCE_THRESHOLDS;

/** Minutes before `AT`, for saying how old a piece of evidence is without arithmetic in the test. */
function ago(minutes: number): Date {
  return new Date(AT.getTime() - minutes * 60_000);
}

function snapshot(over: Partial<EvidenceSnapshot> = {}): EvidenceSnapshot {
  return {
    scopeHash: SCOPE,
    acceptance: [
      { id: 'ac1', closed: true, observedAt: ago(1) },
      { id: 'ac2', closed: false, observedAt: ago(1) },
    ],
    findings: [
      { fingerprint: 'f1', severity: 'P0', resolved: false, regression: false, observedAt: ago(1) },
      { fingerprint: 'f2', severity: 'P1', resolved: false, regression: true, observedAt: ago(1) },
      { fingerprint: 'f3', severity: 'P0', resolved: true, regression: false, observedAt: ago(1) },
      { fingerprint: 'f4', severity: 'P2', resolved: false, regression: false, observedAt: ago(1) },
    ],
    blockers: [
      { key: 'b1', resolved: false, observedAt: ago(1) },
      { key: 'b2', resolved: true, observedAt: ago(1) },
    ],
    checkpoint: { sha: 'abc123', accepted: true, observedAt: ago(1) },
    asOf: AT,
    notBefore: ago(30),
    ...over,
  };
}

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

/** One round of the loop, as the counters see it. */
function round(
  counters: ConvergenceCounters,
  over: {
    classification?: 'IN_SCOPE_DEFECT' | 'TRANSIENT' | null;
    progressed?: boolean;
    fingerprint?: string | null;
    previousFingerprint?: string | null;
    sameActionPriorCount?: number;
    severity?: SeverityTrend;
  } = {},
): ConvergenceCounters {
  return advanceCounters(counters, {
    classification: over.classification === undefined ? 'IN_SCOPE_DEFECT' : over.classification,
    progressed: over.progressed ?? false,
    fingerprint: over.fingerprint ?? null,
    previousFingerprint: over.previousFingerprint ?? null,
    sameActionPriorCount: over.sameActionPriorCount ?? 0,
    severity: over.severity ?? 'HELD',
  });
}

// -------------------------------------------------------------------------------------------
// §4 — the vector, derived.
// -------------------------------------------------------------------------------------------

test('§4: every dimension is counted off the evidence, not off the caller\'s word', () => {
  const { vector: derived } = deriveProgressVector(snapshot());
  assert.deepEqual(derived, {
    scopeHash: SCOPE,
    acceptanceClosed: 1,
    acceptanceTotal: 2,
    // Resolved findings are not open, and a P2 is neither a P0 nor a P1 — the vector counts the
    // two severities §4 names and does not quietly fold the rest into them.
    openP0: 1,
    openP1: 1,
    regressions: 1,
    openBlockers: 1,
    knownGoodSha: 'abc123',
  });
});

test('§7 CP3: a WIP_RED checkpoint is not a known-good sha', () => {
  const red = deriveProgressVector(snapshot({
    checkpoint: { sha: 'def456', accepted: false, observedAt: ago(1) },
  }));
  assert.equal(red.vector.knownGoodSha, null);
  // And the difference is worth a whole dimension: "I saved my work" must not read as "there is a
  // good state to go back to", because §4 counts the appearance of one as progress.
  assert.equal(
    strictlyImproves({ ...red.vector, knownGoodSha: null }, red.vector),
    false,
  );
});

// -------------------------------------------------------------------------------------------
// §4 PV6 — freshness.
// -------------------------------------------------------------------------------------------

test('§4 PV6: the oldest item decides the reading, not the newest', () => {
  const fresh = deriveProgressVector(snapshot());
  assert.equal(fresh.freshness, 'FRESH');
  assert.deepEqual(fresh.evidenceAsOf, ago(1));

  // One stale item among six fresh ones. The vector is identical; the reading is not.
  const mixed = deriveProgressVector(snapshot({
    acceptance: [
      { id: 'ac1', closed: true, observedAt: ago(90) },
      { id: 'ac2', closed: false, observedAt: ago(1) },
    ],
  }));
  assert.deepEqual(mixed.vector, fresh.vector);
  assert.equal(mixed.freshness, 'STALE');
  assert.deepEqual(mixed.staleItems, ['acceptance:ac1']);
});

test('§4 PV6: evidence from before the attempt it claims to describe is STALE', () => {
  // The fence that does the work. Everything here is minutes old and well inside the absolute
  // horizon — it is stale only relative to the attempt whose work it is being read as evidence of.
  const reading = deriveProgressVector(snapshot({ notBefore: ago(0) }));
  assert.equal(reading.freshness, 'STALE');
  assert.equal(reading.staleItems.length, 9, 'every item in the snapshot predates the fence');
});

test('§4 PV6: with no attempt to measure against, the absolute horizon still applies', () => {
  const old = ago(EVIDENCE_MAX_AGE_MS / 60_000 + 1);
  const reading = deriveProgressVector(snapshot({
    notBefore: null,
    blockers: [{ key: 'b1', resolved: false, observedAt: old }],
  }));
  assert.equal(reading.freshness, 'STALE');
  assert.deepEqual(reading.staleItems, ['blocker:b1']);
});

test('§4 PV6: an empty snapshot is UNMEASURED, and UNMEASURED is not a world with no defects', () => {
  const empty = deriveProgressVector(snapshot({
    acceptance: [], findings: [], blockers: [], checkpoint: null,
  }));
  assert.equal(empty.freshness, 'UNMEASURED');
  assert.deepEqual(empty.evidenceAsOf, null);
  // The trap this is here for: the vector reads as all-zeros, which compares against a world with
  // three open P0s as a clean sweep. Only the reading tells the two apart.
  assert.equal(strictlyImproves(vector({ openP0: 3 }), empty.vector), true);
  assert.equal(evidenceSupportsProgress(empty), false);
});

test('§4 PV6: a STALE reading cannot refresh lastProgressAt, and still spends the pass', () => {
  const before = vector({ openP0: 3 });
  const measured = { ...before, openP0: 1 };
  const stale = { freshness: 'STALE' as const, evidenceAsOf: ago(90), staleItems: ['acceptance:ac1'] };

  const believed = planConvergenceDecision(
    TASK,
    state({ progressVector: before, lastProgressAt: null }),
    observation({ progressVector: measured }),
    T,
  );
  assert.equal(believed.progressed, true);
  assert.deepEqual(believed.taskState.lastProgressAt, AT);

  const doubted = planConvergenceDecision(
    TASK,
    state({ progressVector: before, lastProgressAt: null }),
    observation({ progressVector: measured, evidence: stale }),
    T,
  );
  assert.equal(doubted.progressed, false);
  assert.equal(doubted.taskState.lastProgressAt, null);
  assert.equal(doubted.evidenceFreshness, 'STALE');
  assert.deepEqual(doubted.evidenceAsOf, ago(90));
  // PV6's second half: it is not a free pass. The decision still spends the no-progress budget,
  // because "we could not measure" is a round that happened and produced nothing.
  assert.equal(doubted.counters.decisionsWithoutProgress, 1);
  assert.equal(doubted.counters.attemptsWithoutProgress, 1);
});

// -------------------------------------------------------------------------------------------
// §5.1 — action and hypothesis identity.
// -------------------------------------------------------------------------------------------

test('§5.1 FP1/FP4: new ids, new timestamps and new constants are the same action', () => {
  const first = actionIdentity({
    kind: 'DISPATCH_ATTEMPT',
    target: '/root/.orbit/worktrees/0198e2f1-1b0a-7a5e-9f31-000000000001/src/app.ts',
    hypothesis: 'Raise the pool timeout to 5 and re-run at 2026-08-22T09:00:00Z',
    scopeHash: SCOPE,
  });
  const second = actionIdentity({
    kind: 'DISPATCH_ATTEMPT',
    target: '/root/.orbit/worktrees/0198e2f1-1b0a-7a5e-9f31-000000000002/src/app.ts',
    hypothesis: 'raise the  pool timeout to 30 and re-run at 2026-08-23T11:30:00Z',
    scopeHash: SCOPE,
  });
  assert.equal(first, second);
  // The boundary of the same eight steps, stated so nobody has to rediscover it: a number glued to
  // a unit is not a standalone token, so `5s` and `30s` are still two identities. `[K4]` reuses
  // §5's normalization rather than growing a second one — a divergence between how a failure and
  // an action are normalized would be a much worse bug than this residue.
  const glued = (n: string) => actionIdentity({ kind: 'RETRY', target: null, hypothesis: `wait ${n}`, scopeHash: SCOPE });
  assert.notEqual(glued('5s'), glued('30s'));
  assert.equal(glued('5'), glued('30'));
});

test('§5.1 FP2: a different plan is a different action', () => {
  const base = { kind: 'DISPATCH_ATTEMPT', target: 'src/app.ts', hypothesis: 'raise the timeout', scopeHash: SCOPE };
  assert.notEqual(actionIdentity(base), actionIdentity({ ...base, kind: 'FILE_DEFECT' }));
  assert.notEqual(actionIdentity(base), actionIdentity({ ...base, target: 'src/other.ts' }));
  assert.notEqual(actionIdentity(base), actionIdentity({ ...base, hypothesis: 'rewrite the reducer' }));
  assert.notEqual(actionIdentity(base), actionIdentity({ ...base, target: null }));
});

test('§5.1 FP5: the identity is stable across generations, the idempotency key is not', () => {
  const facts = { kind: 'DISPATCH_ATTEMPT', target: null, hypothesis: 'retry', scopeHash: SCOPE };
  assert.equal(actionIdentity(facts), actionIdentity(facts));
  // The key's job is the opposite one, and the two must not be conflated: a key that repeated
  // across generations would refuse the second attempt as a redelivery, and an identity that
  // changed with the generation would never see a repeat at all.
  assert.notEqual(
    convergenceActionKey(TASK, 1, 1, 'DISPATCH_ATTEMPT'),
    convergenceActionKey(TASK, 1, 2, 'DISPATCH_ATTEMPT'),
  );
});

test('§5.1 FP6: a re-plan makes the same sentence a different proposal', () => {
  assert.notEqual(hypothesisIdentity('rewrite the reducer', SCOPE), hypothesisIdentity('rewrite the reducer', OTHER_SCOPE));
  assert.equal(hypothesisIdentity('Rewrite  the REDUCER ', SCOPE), hypothesisIdentity('rewrite the reducer', SCOPE));
});

// -------------------------------------------------------------------------------------------
// §8 — the two new lines, and what they must NOT stop.
// -------------------------------------------------------------------------------------------

test('AC2: the same action, proposed round after round, trips inside four', () => {
  let counters = { ...ZERO_COUNTERS };
  let trippedAt: number | null = null;
  for (let n = 1; n <= 300; n++) {
    // Each round's failure text is different — this is the incident's shape, where the fingerprint
    // line never counts — but the action is the same one, so the window count climbs.
    counters = round(counters, {
      fingerprint: `fp-${n}`,
      previousFingerprint: `fp-${n - 1}`,
      sameActionPriorCount: n - 1,
      severity: 'NONE',
    });
    const verdict = detectNonConvergence(counters, T);
    if (verdict.tripped) {
      trippedAt = n;
      assert.equal(verdict.reason, 'SAME_ACTION_REPEATED');
      assert.equal(verdict.limit, T.maxSameActionRepeats);
      break;
    }
  }
  assert.equal(trippedAt, 4, 'the fourth proposal of one action is the third repeat');
});

test('AC2: alternating two actions does not buy another round', () => {
  // The escape a consecutive counter has and a window count does not. A and B alternate forever,
  // so no action is ever proposed twice in a row.
  // Classified as nothing, so the attempt budget is not charged and the action line is the one
  // being tested rather than the one that happens to fire first.
  let counters = { ...ZERO_COUNTERS };
  const seen = new Map<string, number>();
  let trippedAt: number | null = null;
  for (let n = 1; n <= 300; n++) {
    const action = n % 2 === 0 ? 'A' : 'B';
    const prior = seen.get(action) ?? 0;
    seen.set(action, prior + 1);
    counters = round(counters, {
      classification: null,
      fingerprint: `fp-${n}`,
      previousFingerprint: `fp-${n - 1}`,
      sameActionPriorCount: prior,
      severity: 'NONE',
    });
    if (detectNonConvergence(counters, T).tripped) {
      trippedAt = n;
      break;
    }
  }
  assert.equal(trippedAt, 7, 'the fourth B is the third repeat of B');
  assert.equal(detectNonConvergence(counters, T).reason, 'SAME_ACTION_REPEATED');
});

test('AC2: repairs that never reduce the defect count trip, whatever the error text says', () => {
  let counters = { ...ZERO_COUNTERS };
  let trippedAt: number | null = null;
  for (let n = 1; n <= 300; n++) {
    // A fresh fingerprint AND a fresh action every round: both of the other repeat lines are blind
    // here. What is not fresh is the defect load, which never falls.
    counters = round(counters, {
      fingerprint: `fp-${n}`,
      previousFingerprint: `fp-${n - 1}`,
      sameActionPriorCount: 0,
      severity: 'HELD',
    });
    const verdict = detectNonConvergence(counters, T);
    if (verdict.tripped) {
      trippedAt = n;
      assert.equal(verdict.reason, 'SEVERITY_NOT_DECLINING');
      break;
    }
  }
  assert.equal(trippedAt, 4);
});

test('AC2: a task with no P0/P1 at all is not charged the repair line', () => {
  // `NONE` rather than `HELD`: there is no defect load to reduce, so "the defect count did not
  // fall" is not a statement about this task. It still stops — on the attempt budget, with the
  // reason that is actually true of it.
  let counters = { ...ZERO_COUNTERS };
  let trippedAt: number | null = null;
  for (let n = 1; n <= 300; n++) {
    counters = round(counters, { fingerprint: `fp-${n}`, previousFingerprint: `fp-${n - 1}`, severity: 'NONE' });
    const verdict = detectNonConvergence(counters, T);
    if (verdict.tripped) {
      trippedAt = n;
      assert.equal(verdict.reason, 'ATTEMPT_BUDGET_EXHAUSTED');
      break;
    }
  }
  assert.equal(trippedAt, 6);
  assert.equal(counters.repairsWithoutSeverityDrop, 0);
});

test('AC3: a defect count that keeps falling is never stopped by the repair line', () => {
  // The false stop this unit was reviewed for, in its `[K4]` form. Twenty rounds, each closing one
  // P0 out of twenty, each one a genuine repair — and `maxRepairsWithoutSeverityDrop` is 3.
  let counters = { ...ZERO_COUNTERS };
  let before = vector({ openP0: 20 });
  for (let n = 1; n <= 20; n++) {
    const after = vector({ openP0: 20 - n });
    const progressed = strictlyImproves(before, after);
    counters = advanceCounters(counters, {
      classification: 'IN_SCOPE_DEFECT',
      progressed,
      fingerprint: `fp-${n}`,
      previousFingerprint: `fp-${n - 1}`,
      attemptStarted: true,
      sameActionPriorCount: 0,
      severity: severityTrend(before, after),
    });
    before = after;
    assert.equal(detectNonConvergence(counters, T).tripped, false, `stopped at round ${n}`);
  }
  assert.equal(counters.repairsWithoutSeverityDrop, 0);
  assert.equal(counters.attemptsOnRevision, 20);
});

test('AC3: new evidence is a legal reason to go on — a fresh fingerprint clears the repeat', () => {
  let counters = { ...ZERO_COUNTERS };
  counters = round(counters, { fingerprint: 'same', previousFingerprint: 'same', severity: 'NONE' });
  counters = round(counters, { fingerprint: 'same', previousFingerprint: 'same', severity: 'NONE' });
  assert.equal(counters.sameFingerprintRepeats, 2);
  // A genuinely different failure resets the repeat line to zero: the loop learned something.
  counters = round(counters, { fingerprint: 'different', previousFingerprint: 'same', severity: 'NONE' });
  assert.equal(counters.sameFingerprintRepeats, 0);
  assert.equal(detectNonConvergence(counters, T).tripped, false);
});

test('AC3: an explicitly transient failure spends its own budget and no other', () => {
  let counters = { ...ZERO_COUNTERS };
  for (let n = 0; n < 3; n++) {
    counters = round(counters, { classification: 'TRANSIENT', fingerprint: 'net', previousFingerprint: 'net', severity: 'NONE' });
  }
  assert.equal(counters.transientRetries, 3);
  assert.equal(counters.attemptsWithoutProgress, 0);
  assert.equal(counters.repairsWithoutSeverityDrop, 0);
  // §3 CL2 still applies: the fourth is reclassified rather than retried forever, and the
  // fingerprint line has been counting all along.
  assert.equal(detectNonConvergence(counters, T).reason, 'SAME_FAILURE_REPEATED');
});

// -------------------------------------------------------------------------------------------
// §9 — and then it stops being retried.
// -------------------------------------------------------------------------------------------

test('§9 GT1: a tripped task is refused dispatch, whether or not the state column caught up', () => {
  const spent: ConvergenceCounters = { ...ZERO_COUNTERS, sameActionRepeats: 9 };
  // The state has landed: the answer is the state's.
  assert.equal(
    convergenceDispatchRefusal({ progressState: 'NEEDS_REPLAN', counters: { ...ZERO_COUNTERS } }, T),
    'TASK_NEEDS_REPLAN',
  );
  // The state has not landed yet — a crash between the two writes, or a reader ahead of the
  // writer. The counters are committed facts, so the gate answers from them rather than waiting.
  assert.equal(
    convergenceDispatchRefusal({ progressState: 'CONVERGING', counters: spent }, T),
    'TASK_CONVERGENCE_BUDGET_EXHAUSTED',
  );
  // And a task that is simply converging is not this gate's business.
  assert.equal(
    convergenceDispatchRefusal({ progressState: 'CONVERGING', counters: { ...ZERO_COUNTERS } }, T),
    null,
  );
  // A settled task is not refused either: SM1 gives it no out-edge, and reporting a live budget
  // obligation about finished work would put a blocker on something nobody can act on.
  assert.equal(convergenceDispatchRefusal({ progressState: 'SETTLED', counters: spent }, T), null);
});

test('§9: a tripped decision produces no action, however much budget is left', () => {
  const planned = planConvergenceDecision(
    TASK,
    // The window count the writer read from the ledger: this action has been proposed three times
    // already since the last progress. The committed counter is behind it, and the max of the two
    // is what the breaker reads (RL3 — a counter may not be talked downward).
    state({ counters: { ...ZERO_COUNTERS, sameActionRepeats: 2 }, sameActionPriorCount: 3 }),
    observation({ actionIdentity: 'a'.repeat(64), action: 'DISPATCH_ATTEMPT' }),
    T,
  );
  assert.equal(planned.nonConvergenceReason, 'SAME_ACTION_REPEATED');
  assert.equal(planned.toState, 'NEEDS_REPLAN');
  assert.equal(planned.action, null);
  assert.equal(planned.actionIdempotencyKey, null);
  // The identity is still recorded. The row says what this judgment PROPOSED; `action` says what
  // it was allowed to do, and erasing the first would delete the evidence of the repeat from the
  // very decision the repeat caused.
  assert.equal(planned.actionIdentity, 'a'.repeat(64));
  assert.equal(planned.owner, 'USER');
  assert.match(planned.requiredAction ?? '', /same action/i);
});

// -------------------------------------------------------------------------------------------
// AC5 — the reverse mutations. Each removes one rule and shows the loop escaping again.
// -------------------------------------------------------------------------------------------

test('mutated: an action identity that keeps the ids never repeats, and the line never fires', () => {
  // The mutation is the obvious implementation: hash the action text as written. It is what every
  // "have we done this before" check does before somebody notices §5.
  const raw = (n: number) => `DISPATCH_ATTEMPT|retry session 0198e2f1-1b0a-7a5e-9f31-${String(n).padStart(12, '0')}`;
  const seen = new Map<string, number>();
  let counters = { ...ZERO_COUNTERS };
  for (let n = 1; n <= 300; n++) {
    const identity = raw(n);
    const prior = seen.get(identity) ?? 0;
    seen.set(identity, prior + 1);
    counters = round(counters, {
      fingerprint: `fp-${n}`,
      previousFingerprint: `fp-${n - 1}`,
      sameActionPriorCount: prior,
      severity: 'NONE',
    });
  }
  assert.equal(counters.sameActionRepeats, 0, 'raw text never repeats');

  // The same three hundred rounds through the real identity: it is one action, three hundred times.
  const normalized = new Map<string, number>();
  let honest = { ...ZERO_COUNTERS };
  let trippedAt: number | null = null;
  for (let n = 1; n <= 300 && trippedAt === null; n++) {
    const identity = actionIdentity({
      kind: 'DISPATCH_ATTEMPT',
      target: null,
      hypothesis: `retry session 0198e2f1-1b0a-7a5e-9f31-${String(n).padStart(12, '0')}`,
      scopeHash: SCOPE,
    });
    const prior = normalized.get(identity) ?? 0;
    normalized.set(identity, prior + 1);
    honest = round(honest, {
      fingerprint: `fp-${n}`,
      previousFingerprint: `fp-${n - 1}`,
      sameActionPriorCount: prior,
      severity: 'NONE',
    });
    if (detectNonConvergence(honest, T).reason === 'SAME_ACTION_REPEATED') trippedAt = n;
  }
  assert.equal(trippedAt, 4);
});

test('mutated: a consecutive-only action counter is defeated by alternating two actions', () => {
  // The other half of the same rule. Count "the same action as last time" instead of "this action
  // within the window", and A/B/A/B walks past it forever — while the window count stops it.
  let previous: string | null = null;
  let consecutive = 0;
  for (let n = 1; n <= 300; n++) {
    const action = n % 2 === 0 ? 'A' : 'B';
    consecutive = action === previous ? consecutive + 1 : 0;
    previous = action;
  }
  assert.equal(consecutive, 0, 'alternating never repeats consecutively');
  assert.ok(consecutive <= (T.maxSameActionRepeats as number), 'so a consecutive counter never trips');
});

test('mutated: without the freshness gate, one stale measurement buys unlimited budget', () => {
  // The loop re-reports the SAME improvement it measured an hour ago, once per round. With PV6 the
  // reading is stale, so nothing is refreshed and the budget runs out. Without it, every round
  // looks like a fresh step forward and the four "since last progress" counters never survive to
  // reach a line.
  const before = vector({ openP0: 3 });
  const measured = { ...before, openP0: 2 };
  const stale = { freshness: 'STALE' as const, evidenceAsOf: ago(90), staleItems: ['acceptance:ac1'] };

  let counters = { ...ZERO_COUNTERS };
  let mutated = { ...ZERO_COUNTERS };
  let trippedAt: number | null = null;
  for (let n = 1; n <= 300; n++) {
    const planned = planConvergenceDecision(
      TASK,
      state({ counters, progressVector: before }),
      observation({ progressVector: measured, evidence: stale, observationKey: `k${n}` }),
      T,
    );
    counters = planned.counters;
    // The mutation: believe the reading. `strictlyImproves` alone says this moved, every round.
    mutated = advanceCounters(mutated, {
      classification: 'IN_SCOPE_DEFECT',
      progressed: strictlyImproves(before, measured),
      fingerprint: `fp-${n}`,
      previousFingerprint: `fp-${n - 1}`,
      sameActionPriorCount: 0,
      severity: severityTrend(before, measured),
    });
    if (trippedAt === null && detectNonConvergence(counters, T).tripped) trippedAt = n;
  }
  assert.ok(trippedAt !== null && trippedAt <= 6, `PV6 must stop it; stopped at ${trippedAt}`);
  assert.equal(detectNonConvergence(mutated, T).tripped, false, 'the mutation runs forever');
  assert.equal(mutated.attemptsWithoutProgress, 0);
});

test('mutated: a repair counter that any progress can reset never notices close-one-open-one', () => {
  // The world: every round closes one acceptance item (so it IS strict progress) while the defect
  // count holds at three. PV7 refuses that as a licence to reset the repair line; the mutation —
  // treating it like the other four — hands the loop a fresh budget every round, forever.
  let honest = { ...ZERO_COUNTERS };
  let mutated = { ...ZERO_COUNTERS };
  let trippedAt: number | null = null;
  for (let n = 1; n <= 50; n++) {
    const before = vector({ acceptanceClosed: n - 1, acceptanceTotal: 100, openP0: 3 });
    const after = vector({ acceptanceClosed: n, acceptanceTotal: 100, openP0: 3 });
    const progressed = strictlyImproves(before, after);
    assert.equal(progressed, true, 'closing a criterion is progress — that is not in dispute');
    const shared = {
      classification: 'IN_SCOPE_DEFECT' as const,
      progressed,
      fingerprint: `fp-${n}`,
      previousFingerprint: `fp-${n - 1}`,
      sameActionPriorCount: 0,
    };
    honest = advanceCounters(honest, { ...shared, severity: severityTrend(before, after) });
    // The mutation: `DROPPED` whenever the step progressed at all.
    mutated = advanceCounters(mutated, { ...shared, severity: 'DROPPED' });
    if (trippedAt === null && detectNonConvergence(honest, T).tripped) trippedAt = n;
  }
  assert.ok(trippedAt !== null && trippedAt <= 4, `PV7 must stop it; stopped at ${trippedAt}`);
  assert.equal(detectNonConvergence(honest, T).reason, 'SEVERITY_NOT_DECLINING');
  assert.equal(mutated.repairsWithoutSeverityDrop, 0);
  assert.equal(detectNonConvergence(mutated, T).tripped, false, 'the mutation runs forever');
});
