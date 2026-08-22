import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ConvergenceAutomationPolicy,
  ConvergenceClassification,
  ConvergenceCounters,
  ConvergenceThresholds,
  DEFAULT_CONVERGENCE_THRESHOLDS,
  NON_CONVERGENCE_PRIORITY,
  NON_CONVERGENCE_RULE,
  ScopeActor,
  ZERO_COUNTERS,
  authorizeScopeAction,
  isDispatchableProgressState,
  progressStateAfter,
} from './convergence-contract';
import {
  EMPTY_PROGRESS_VECTOR,
  FailureFacts,
  ProgressVector,
  advanceCounters,
  detectNonConvergence,
  failureFingerprint,
  mergeCounters,
  normalizeFailureText,
  progressVectorDigest,
  reclassifyExhaustedTransient,
  scopeHash,
  strictlyImproves,
} from './convergence-progress';

// `[K1]`. Two halves: the fingerprint has to merge one defect reported many ways without merging
// two defects, and the breaker has to stop a loop in a bounded number of steps without stopping a
// task that is getting somewhere. The last test replays the incident this unit was written after.

const SCOPE = scopeHash({ title: 'K', description: 'd', acceptanceCriteria: 'a' });

function vector(over: Partial<ProgressVector> = {}): ProgressVector {
  return { ...EMPTY_PROGRESS_VECTOR, scopeHash: SCOPE, acceptanceTotal: 10, ...over };
}

function facts(over: Partial<FailureFacts> = {}): FailureFacts {
  return {
    stage: 'RUN',
    subjectKind: 'TASK',
    scopeHash: SCOPE,
    violatedInvariant: 'AC6',
    message: 'expected 3 to equal 4',
    ...over,
  };
}

test('§5 FP1: ids, timestamps, shas, paths, positions and numbers do not fork the fingerprint', () => {
  const first = facts({
    message: 'run 2026-08-22T09:04:29.299Z session 0198e2f1-1b0a-7a5e-9f31-2c4b6d8e0a11 '
      + 'at /root/.orbit/worktrees/aaa/src/apiserver/src/projects/x.ts:120:9 '
      + 'sha 54744005f6aa8cb82146b51a6e9a7d6fd87d4b0c expected 3 to equal 4',
  });
  const second = facts({
    message: 'run 2026-08-23T11:55:01Z session 0198e2f1-1b0a-7a5e-9f31-99999999cafe '
      + 'at /root/.orbit/worktrees/zzz/src/apiserver/src/projects/x.ts:404:1 '
      + 'sha 2e75075a84a390a15ea0b72ed0416cb91876b95c expected 7 to equal 9',
  });
  assert.equal(failureFingerprint(first), failureFingerprint(second));
  assert.equal(
    normalizeFailureText(first.message),
    'run <ts> session <id> at <path>/x.ts:<pos> sha <sha> expected <n> to equal <n>',
  );
});

test('§5 FP2: a different invariant is a different fingerprint even when the text normalizes equal', () => {
  assert.notEqual(
    failureFingerprint(facts({ violatedInvariant: 'AC6' })),
    failureFingerprint(facts({ violatedInvariant: 'AC7' })),
  );
  // …and so is a genuinely different message, because normalization stops at ids and numbers.
  assert.notEqual(
    failureFingerprint(facts({ message: 'connection reset by peer' })),
    failureFingerprint(facts({ message: 'expected 3 to equal 4' })),
  );
  // Stage and subject are coordinates too: the same words from the merge gate are not the same
  // problem as the same words from the test run.
  assert.notEqual(
    failureFingerprint(facts({ stage: 'MERGE' })),
    failureFingerprint(facts({ stage: 'RUN' })),
  );
});

test('§5 FP3: the fingerprint is scoped — a new revision makes it a new problem', () => {
  const other = scopeHash({ title: 'K', description: 'd2', acceptanceCriteria: 'a' });
  assert.notEqual(SCOPE, other);
  assert.notEqual(failureFingerprint(facts()), failureFingerprint(facts({ scopeHash: other })));
});

test('§4 PV2: improvement needs one dimension better and none worse', () => {
  const before = vector({ acceptanceClosed: 3, openP0: 2, openP1: 4 });
  assert.equal(strictlyImproves(before, vector({ acceptanceClosed: 4, openP0: 2, openP1: 4 })), true);
  assert.equal(strictlyImproves(before, vector({ acceptanceClosed: 3, openP0: 1, openP1: 4 })), true);
  assert.equal(strictlyImproves(before, vector({ acceptanceClosed: 3, openP0: 2, openP1: 4 })), false);
  // The trade the incident kept making: close one acceptance item, open two P0s, call it progress.
  assert.equal(strictlyImproves(before, vector({ acceptanceClosed: 4, openP0: 4, openP1: 4 })), false);
  // Regressions and open blockers count the same way.
  assert.equal(strictlyImproves(before, vector({ acceptanceClosed: 3, openP0: 2, openP1: 4, regressions: 1 })), false);
  assert.equal(
    strictlyImproves(vector({ openBlockers: 2 }), vector({ openBlockers: 1 })),
    true,
  );
});

test('§4 PV2: a known-good checkpoint appearing is progress; losing one is not', () => {
  assert.equal(strictlyImproves(vector(), vector({ knownGoodSha: 'abc' })), true);
  assert.equal(strictlyImproves(vector({ knownGoodSha: 'abc' }), vector()), false);
  // §4's table and PV5: `非 null → 另一个非 null 不是`. Moving a checkpoint is the only dimension
  // with no edge to walk toward, so counting it would make a revision's strict-progress count
  // unbounded and TH6's bound false — push a commit, zero the four counters, repeat.
  assert.equal(strictlyImproves(vector({ knownGoodSha: 'abc' }), vector({ knownGoodSha: 'def' })), false);
});

test('§4 PV3: changing the target is not approaching it', () => {
  const moved = { ...vector({ acceptanceClosed: 9, openP0: 0 }), scopeHash: 'other' };
  assert.equal(strictlyImproves(vector({ acceptanceClosed: 0, openP0: 9 }), moved), false);
});

test('§4 PV1: the vector has no way to express activity', () => {
  const keys = Object.keys(EMPTY_PROGRESS_VECTOR).sort();
  assert.deepEqual(keys, [
    'acceptanceClosed',
    'acceptanceTotal',
    'knownGoodSha',
    'openBlockers',
    'openP0',
    'openP1',
    'regressions',
    'scopeHash',
  ]);
  // The digest is a function of those eight fields and nothing else, so two worlds that differ
  // only in how hard the agent worked have one digest.
  assert.equal(progressVectorDigest(vector()), progressVectorDigest(vector()));
});

test('§8 TH1: the breaker reports one determinate reason when two lines are crossed', () => {
  const counters: ConvergenceCounters = {
    ...ZERO_COUNTERS,
    scopeExpansionRequests: 1,
    sameFingerprintRepeats: 9,
    attemptsOnRevision: 99,
    decisionsWithoutProgress: 99,
  };
  const verdict = detectNonConvergence(counters, DEFAULT_CONVERGENCE_THRESHOLDS);
  assert.equal(verdict.reason, 'SCOPE_EXPANSION_REQUIRED');

  // Peel the highest-priority reason off one at a time and the next one down must be reported —
  // that IS the priority list, checked against the order rather than restating it.
  const peeled = { ...counters, scopeExpansionRequests: 0 };
  assert.equal(detectNonConvergence(peeled, DEFAULT_CONVERGENCE_THRESHOLDS).reason, 'SAME_FAILURE_REPEATED');
});

test('§8: every threshold trips on its own, in a finite number of steps', () => {
  for (const reason of NON_CONVERGENCE_PRIORITY) {
    const rule = NON_CONVERGENCE_RULE[reason];
    const limit = DEFAULT_CONVERGENCE_THRESHOLDS[rule.threshold];
    assert.notEqual(limit, null, `${reason} must be bounded by default`);
    const counters = { ...ZERO_COUNTERS, [rule.counter]: (limit as number) } as ConvergenceCounters;
    assert.equal(detectNonConvergence(counters, DEFAULT_CONVERGENCE_THRESHOLDS).tripped, false,
      `${reason} must not trip AT the limit`);
    const over = { ...ZERO_COUNTERS, [rule.counter]: (limit as number) + 1 } as ConvergenceCounters;
    const verdict = detectNonConvergence(over, DEFAULT_CONVERGENCE_THRESHOLDS);
    assert.equal(verdict.tripped, true, `${reason} must trip one past the limit`);
    assert.equal(verdict.reason, reason);
    assert.equal(verdict.limit, limit);
  }
});

test('§8: an authorized unbounded threshold is the only way to not trip, and only for its own line', () => {
  const unbounded: ConvergenceThresholds = {
    ...DEFAULT_CONVERGENCE_THRESHOLDS,
    maxAttemptsPerScopeRevision: null,
  };
  const counters = { ...ZERO_COUNTERS, attemptsOnRevision: 10_000 };
  assert.equal(detectNonConvergence(counters, unbounded).tripped, false);
  // …and the other lines still hold, so "let it retry forever" cannot be bought by one override.
  assert.equal(
    detectNonConvergence({ ...counters, decisionsWithoutProgress: 7 }, unbounded).reason,
    'NO_PROGRESS',
  );
});

test('§3 CL2: a failure that keeps being called transient is reclassified once the budget is spent', () => {
  const under = { ...ZERO_COUNTERS, transientRetries: 2 };
  assert.equal(reclassifyExhaustedTransient('TRANSIENT', under, DEFAULT_CONVERGENCE_THRESHOLDS), 'TRANSIENT');
  const at = { ...ZERO_COUNTERS, transientRetries: 3 };
  assert.equal(
    reclassifyExhaustedTransient('TRANSIENT', at, DEFAULT_CONVERGENCE_THRESHOLDS),
    'IN_SCOPE_DEFECT',
  );
  // Every other class is passed through untouched.
  for (const other of ['IN_SCOPE_DEFECT', 'PREREQUISITE', 'SCOPE_EXPANSION', 'ENVIRONMENT', 'HUMAN_REQUIRED'] as ConvergenceClassification[]) {
    assert.equal(reclassifyExhaustedTransient(other, at, DEFAULT_CONVERGENCE_THRESHOLDS), other);
  }
});

test('§4 PV4: strict progress resets the four counters it names and nothing else', () => {
  const before: ConvergenceCounters = {
    attemptsOnRevision: 4,
    attemptsWithoutProgress: 3,
    sameFingerprintRepeats: 2,
    decisionsWithoutProgress: 5,
    verificationRounds: 1,
    transientRetries: 2,
    scopeExpansionRequests: 0,
  };
  const after = advanceCounters(before, {
    classification: null,
    progressed: true,
    fingerprint: null,
    previousFingerprint: null,
  });
  assert.deepEqual(after, {
    attemptsOnRevision: 4,
    attemptsWithoutProgress: 0,
    sameFingerprintRepeats: 0,
    decisionsWithoutProgress: 0,
    verificationRounds: 1,
    transientRetries: 0,
    scopeExpansionRequests: 0,
  });
});

test('a step that classifies nothing and moves nothing still spends the no-progress budget', () => {
  let counters = { ...ZERO_COUNTERS };
  for (let i = 0; i < 7; i++) {
    counters = advanceCounters(counters, {
      classification: null,
      progressed: false,
      fingerprint: null,
      previousFingerprint: null,
    });
  }
  assert.equal(counters.decisionsWithoutProgress, 7);
  assert.equal(detectNonConvergence(counters, DEFAULT_CONVERGENCE_THRESHOLDS).reason, 'NO_PROGRESS');
});

test('§8 TH4: a restart cannot talk a counter downward', () => {
  const committed: ConvergenceCounters = {
    attemptsOnRevision: 4,
    attemptsWithoutProgress: 3,
    sameFingerprintRepeats: 2,
    decisionsWithoutProgress: 5,
    verificationRounds: 2,
    transientRetries: 3,
    scopeExpansionRequests: 1,
  };
  // A process that came up fresh and believes it is at zero.
  const merged = mergeCounters(committed, { ...ZERO_COUNTERS }, false);
  assert.deepEqual(merged, committed);
  // Only strict progress may reset, and only the three §4 PV4 names.
  const afterProgress = mergeCounters(committed, {
    ...committed,
    attemptsWithoutProgress: 0,
    sameFingerprintRepeats: 0,
    decisionsWithoutProgress: 0,
    transientRetries: 0,
  }, true);
  assert.deepEqual(afterProgress, {
    attemptsOnRevision: 4,
    attemptsWithoutProgress: 0,
    sameFingerprintRepeats: 0,
    decisionsWithoutProgress: 0,
    verificationRounds: 2,
    transientRetries: 0,
    scopeExpansionRequests: 1,
  });
});

test('incident replay: three hundred rounds of the same failure trip the breaker inside four', () => {
  // The `[E]` incident, in the only two facts the breaker gets to see: one defect, reported three
  // hundred times with a fresh session id and timestamp each round, and never any strict progress.
  let counters = { ...ZERO_COUNTERS };
  let previous: string | null = null;
  let trippedAt: number | null = null;
  for (let round = 1; round <= 300; round++) {
    const fingerprint = failureFingerprint(facts({
      message: `attempt ${round} at 2026-08-${String((round % 28) + 1).padStart(2, '0')}T09:00:00Z `
        + `session 0198e2f1-1b0a-7a5e-9f31-${String(round).padStart(12, '0')} expected 3 to equal 4`,
    }));
    counters = advanceCounters(counters, {
      classification: 'IN_SCOPE_DEFECT',
      progressed: false,
      fingerprint,
      previousFingerprint: previous,
    });
    previous = fingerprint;
    const verdict = detectNonConvergence(counters, DEFAULT_CONVERGENCE_THRESHOLDS);
    if (verdict.tripped) {
      trippedAt = round;
      assert.equal(verdict.reason, 'SAME_FAILURE_REPEATED');
      break;
    }
  }
  assert.equal(trippedAt, 4, 'the breaker must trip on the fourth round, not the three hundredth');
});

test('incident replay, mutated: without §5 normalization the same loop never trips on repeats', () => {
  // The reverse mutation AC5 asks for. Fingerprint the RAW message instead of the normalized
  // one — which is what every "compare the error string" implementation does — and the identical
  // three hundred rounds produce three hundred distinct fingerprints, so the repeat counter never
  // reaches two. This is the test proving the first replay is biting on normalization and not on
  // something incidental.
  let counters = { ...ZERO_COUNTERS };
  let previous: string | null = null;
  for (let round = 1; round <= 300; round++) {
    const raw = `attempt ${round} session ${round} expected 3 to equal 4`;
    counters = advanceCounters(counters, {
      classification: 'IN_SCOPE_DEFECT',
      progressed: false,
      fingerprint: raw,
      previousFingerprint: previous,
    });
    previous = raw;
  }
  assert.equal(counters.sameFingerprintRepeats, 0, 'raw text never repeats');
  // It still stops — that is the point of having more than one line. The attempt budget and the
  // no-progress budget are both crossed, and TH1 makes the reported one determinate.
  const verdict = detectNonConvergence(counters, DEFAULT_CONVERGENCE_THRESHOLDS);
  assert.equal(verdict.tripped, true);
  assert.equal(verdict.reason, 'ATTEMPT_BUDGET_EXHAUSTED');
});

test('a task that is genuinely converging is never stopped by the attempt budget', () => {
  // The defect this unit was reviewed for. The draft had ONE attempt threshold, set to 5, reading
  // `attemptsOnRevision` — the counter §4 PV4 says never resets. A task closing one acceptance item
  // per attempt was therefore cut off at attempt six, with `ATTEMPT_BUDGET_EXHAUSTED`, for the
  // reason "no progress", while making progress every single round. Ten rounds, each a genuine
  // strict improvement and each a fresh failure fingerprint, must run.
  let counters = { ...ZERO_COUNTERS };
  let before = vector({ acceptanceClosed: 0, openP0: 5 });
  for (let round = 1; round <= 10; round++) {
    const after = vector({ acceptanceClosed: round, openP0: Math.max(0, 5 - round) });
    const progressed = strictlyImproves(before, after);
    assert.equal(progressed, true, `round ${round} should be progress`);
    counters = advanceCounters(counters, {
      classification: 'IN_SCOPE_DEFECT',
      progressed,
      fingerprint: `fp-${round}`,
      previousFingerprint: `fp-${round - 1}`,
      attemptStarted: true,
    });
    before = after;
    assert.equal(detectNonConvergence(counters, DEFAULT_CONVERGENCE_THRESHOLDS).tripped, false,
      `a converging task must not be stopped at round ${round}`);
  }
  // Ten attempts, twice the no-progress budget — and still running, because the budget counts
  // attempts SINCE THE LAST PROGRESS and every round had some. The absolute counter kept climbing.
  assert.equal(counters.attemptsOnRevision, 10);
  assert.equal(counters.attemptsWithoutProgress, 0);
});

test('§8: the hard cap still stops a task that inches forward forever', () => {
  // The other half of the same split: progress resets the budget, so without a second line a task
  // that closes one criterion per attempt out of a hundred would run a hundred attempts. The cap
  // reads the counter progress cannot touch, and reports its own reason so the two are told apart.
  let counters = { ...ZERO_COUNTERS };
  const limit = DEFAULT_CONVERGENCE_THRESHOLDS.maxAttemptsPerScopeRevision as number;
  let trippedAt: number | null = null;
  for (let round = 1; round <= limit * 2; round++) {
    counters = advanceCounters(counters, {
      classification: 'IN_SCOPE_DEFECT',
      progressed: true,
      fingerprint: `fp-${round}`,
      previousFingerprint: `fp-${round - 1}`,
      attemptStarted: true,
    });
    const verdict = detectNonConvergence(counters, DEFAULT_CONVERGENCE_THRESHOLDS);
    if (verdict.tripped) {
      trippedAt = round;
      assert.equal(verdict.reason, 'HARD_ATTEMPT_CAP_REACHED');
      assert.equal(verdict.limit, limit);
      break;
    }
  }
  assert.equal(trippedAt, limit + 1);
});

test('§8 TH6: the attempt count on one revision is bounded by the two lines together', () => {
  // TH6 as arithmetic rather than as a promise. `P` is §4 PV5's bound on how many times a vector
  // can strictly improve; between two improvements at most `maxAttemptsWithoutProgress + 1`
  // attempts are spendable, and the hard cap bounds the product from above regardless.
  const t = DEFAULT_CONVERGENCE_THRESHOLDS;
  const start = vector({ acceptanceTotal: 10, openP0: 2, openP1: 1, regressions: 0, openBlockers: 1 });
  const P = start.acceptanceTotal + start.openP0 + start.openP1 + start.regressions + start.openBlockers + 1;
  const bound = Math.min(
    (P + 1) * ((t.maxAttemptsWithoutProgress as number) + 1),
    t.maxAttemptsPerScopeRevision as number,
  );
  assert.equal(bound, t.maxAttemptsPerScopeRevision);

  // And it holds when walked: the worst legal schedule is "spend the whole budget, then progress".
  let counters = { ...ZERO_COUNTERS };
  let attempts = 0;
  for (let cycle = 0; cycle <= P; cycle++) {
    for (let i = 0; i <= (t.maxAttemptsWithoutProgress as number) + 1; i++) {
      counters = advanceCounters(counters, {
        classification: 'IN_SCOPE_DEFECT',
        progressed: i === (t.maxAttemptsWithoutProgress as number) + 1,
        fingerprint: `fp-${cycle}-${i}`,
        previousFingerprint: `fp-${cycle}-${i - 1}`,
        attemptStarted: true,
      });
      attempts++;
      if (detectNonConvergence(counters, DEFAULT_CONVERGENCE_THRESHOLDS).tripped) {
        assert.ok(attempts <= bound, `stopped after ${attempts} attempts, bound is ${bound}`);
        return;
      }
    }
  }
  assert.fail('the breaker must trip within the bound, not run to the end of the schedule');
});

test('incident replay: the scope-expansion loop stops at the first request, under every actor', () => {
  // The other half of the `[E]` incident. The task did not only fail repeatedly — it GREW, from
  // "fix one bug" into "AutoRetry + deploy + lock ordering", and each expansion made the failure a
  // new problem against a new target, so no counter that measured the old target ever finished.
  //
  // Two independent guards have to hold for that to be impossible, and this replays both.
  const original = scopeHash({ title: 'fix one bug', description: 'd', acceptanceCriteria: 'a' });
  const grown = scopeHash({
    title: 'AutoRetry + deploy + lock ordering',
    description: 'd',
    acceptanceCriteria: 'a',
  });
  assert.notEqual(original, grown);

  // 1. Nobody who noticed is allowed to act on it. Under the default policy the request is the
  //    only legal move for a worker, a verifier AND the coordinator.
  const policy: ConvergenceAutomationPolicy = 'GUARDED_AUTO';
  for (const actor of ['WORKER', 'VERIFIER', 'COORDINATOR'] as ScopeActor[]) {
    assert.notEqual(authorizeScopeAction(actor, 'REVISE_SCOPE', policy), 'ALLOWED', actor);
    assert.equal(authorizeScopeAction(actor, 'REQUEST_SCOPE_EXPANSION', policy), 'ALLOWED', actor);
  }

  // 2. The request itself trips on round one — `maxScopeExpansionRequests` is 0 — and lands on a
  //    state that is not dispatchable, so "ask and keep going anyway" has no edge to travel on.
  const counters = advanceCounters(ZERO_COUNTERS, {
    classification: 'SCOPE_EXPANSION',
    progressed: false,
    fingerprint: 'fp',
    previousFingerprint: null,
    attemptStarted: true,
  });
  assert.equal(counters.scopeExpansionRequests, 1);
  const verdict = detectNonConvergence(counters, DEFAULT_CONVERGENCE_THRESHOLDS);
  assert.equal(verdict.tripped, true);
  assert.equal(verdict.reason, 'SCOPE_EXPANSION_REQUIRED');
  const next = progressStateAfter('CONVERGING', 'SCOPE_EXPANSION_REQUESTED');
  assert.equal(next, 'NEEDS_REPLAN');
  assert.equal(isDispatchableProgressState(next!), false);

  // 3. And the request is never cleared by more work: `scopeExpansionRequests` is outside §4 PV4's
  //    reset set, so even a round of genuine progress leaves the breaker tripped until somebody
  //    authorizes the re-plan.
  const afterProgress = advanceCounters(counters, {
    classification: null,
    progressed: true,
    fingerprint: null,
    previousFingerprint: null,
    attemptStarted: true,
  });
  assert.equal(afterProgress.scopeExpansionRequests, 1);
  assert.equal(
    detectNonConvergence(afterProgress, DEFAULT_CONVERGENCE_THRESHOLDS).reason,
    'SCOPE_EXPANSION_REQUIRED',
  );
});

test('incident replay, mutated: letting the loop revise its own scope makes it unbounded', () => {
  // The mutation is the incident's actual behaviour: the loop rewrites the target whenever it is
  // stuck, so every round measures against a fresh `scopeHash`. Two things follow, and this asserts
  // both — they are why §1's table and §4 PV3 are separate rules.
  let counters = { ...ZERO_COUNTERS };
  let previous: string | null = null;
  for (let round = 1; round <= 300; round++) {
    const grown = scopeHash({ title: `goal v${round}`, description: 'd', acceptanceCriteria: 'a' });
    // PV3: a re-measured vector against a moved target never reads as progress…
    assert.equal(
      strictlyImproves(
        { ...vector({ acceptanceClosed: 0 }), scopeHash: previous ?? SCOPE },
        { ...vector({ acceptanceClosed: 9 }), scopeHash: grown },
      ),
      false,
    );
    // …and FP3 makes every round's failure a new fingerprint, so the repeat line never counts.
    const fingerprint = failureFingerprint(facts({ scopeHash: grown }));
    counters = advanceCounters(counters, {
      classification: 'IN_SCOPE_DEFECT',
      progressed: false,
      fingerprint,
      previousFingerprint: previous,
      attemptStarted: true,
    });
    previous = fingerprint;
  }
  assert.equal(counters.sameFingerprintRepeats, 0, 'a moving target never repeats a fingerprint');

  // If revising scope also reset the ledger — which is what "start a new scopeRevision" means —
  // nothing above would be left to stop it. §1's table is what makes that path unreachable: no
  // agent can take it, so the counters that DO see 300 rounds are still the ones being read.
  assert.equal(counters.attemptsWithoutProgress, 300);
  const verdict = detectNonConvergence(counters, DEFAULT_CONVERGENCE_THRESHOLDS);
  assert.equal(verdict.tripped, true);
  assert.equal(verdict.reason, 'ATTEMPT_BUDGET_EXHAUSTED');
});
