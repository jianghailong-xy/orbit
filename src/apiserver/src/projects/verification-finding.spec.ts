import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONVERGENCE_CLASSIFICATIONS,
  CLASSIFICATION_OUTCOME,
  ConvergenceClassification,
  ConvergenceCounters,
  DEFAULT_CONVERGENCE_THRESHOLDS,
  SCOPE_ACTORS,
  ScopeActor,
  ZERO_COUNTERS,
  authorizeScopeAction,
} from './convergence-contract';
import {
  EFFECT_BLOCKER_KIND,
  FINDING_REPORTERS,
  FINDING_SEVERITIES,
  FindingSeverity,
  FindingSubjectState,
  OUTCOME_EFFECT,
  OUTCOME_OWNER,
  VerificationFinding,
  decideFinding,
  findingDedupKey,
  findingEffectKey,
  findingSeverityTrend,
  triageFinding,
  validateFinding,
} from './verification-finding';

// `[K5]` §6 and §3, as a table rather than as a story.
//
// The property this file exists for is FD2: one finding produces one result, and WHICH result is a
// function of the classification and of committed counters — never of who is asking, how many times
// they have asked, or how the request was phrased. Everything below is a pure function, so every
// assertion is a claim about the CONTRACT and not about a fixture; the database's half is
// `verification-finding.pg.spec.ts`.

const FINGERPRINT = 'a'.repeat(64);
const OTHER_FINGERPRINT = 'b'.repeat(64);

function finding(over: Partial<VerificationFinding> = {}): VerificationFinding {
  return {
    severity: 'P1',
    violatedInvariant: 'DEPENDENT_RAN_BEFORE_PASS',
    minimalRepro: 'npm test -w @orbit/apiserver -- verification-dependency',
    failureFingerprint: FINGERPRINT,
    scopeClassification: 'IN_SCOPE_DEFECT',
    evidence: { command: 'npm test', exitCode: 1 },
    verdict: 'FAIL',
    ...over,
  };
}

function address(over: Partial<{ reporter: ScopeActor; scopeRevision: number }> = {}) {
  return {
    projectId: 'PROJ',
    subjectTaskId: 'SUBJ',
    scopeRevision: 1,
    reporter: 'VERIFIER' as ScopeActor,
    ...over,
  };
}

function state(over: Partial<FindingSubjectState> = {}): FindingSubjectState {
  return {
    scopeRevision: 1,
    progressState: 'VERIFYING',
    counters: { ...ZERO_COUNTERS },
    lastFingerprint: null,
    lastRepairSeverity: null,
    ...over,
  };
}

function counters(over: Partial<ConvergenceCounters> = {}): ConvergenceCounters {
  return { ...ZERO_COUNTERS, ...over };
}

const T = DEFAULT_CONVERGENCE_THRESHOLDS;

// ---------------------------------------------------------------------------------------------
// §3: one class, one result.
// ---------------------------------------------------------------------------------------------

test('§3: each classification on a fresh revision produces its one legal result', () => {
  // The reporter is USER because §3's `谁能定` column is a SEPARATE rule, tested below. Mixing the
  // two here would let a reporter refusal masquerade as an outcome.
  const expected: Record<ConvergenceClassification, string> = {
    TRANSIENT: 'RETRY_WITHIN_BUDGET',
    IN_SCOPE_DEFECT: 'CREATE_DEFECT_SUBTASK',
    PREREQUISITE: 'CREATE_PREREQUISITE_TASK',
    SCOPE_EXPANSION: 'FREEZE_AND_REQUEST_REPLAN',
    ENVIRONMENT: 'RAISE_SYSTEM_BLOCKER',
    HUMAN_REQUIRED: 'RAISE_USER_BLOCKER',
  };
  for (const classification of CONVERGENCE_CLASSIFICATIONS) {
    const decision = decideFinding(
      finding({ scopeClassification: classification }),
      address({ reporter: 'USER' }),
      state(),
      T,
    );
    assert.equal(decision.ok, true, `${classification} was refused`);
    if (!decision.ok) continue;
    assert.equal(decision.triage.outcome, expected[classification], classification);
    // FD2's "不多不少": the effect is the outcome's own artifact, and exactly one of them.
    assert.equal(decision.triage.effect, OUTCOME_EFFECT[decision.triage.outcome], classification);
  }
});

test('§3 is exhaustive and the two tables agree with `[K1]`\'s frozen one', () => {
  for (const classification of CONVERGENCE_CLASSIFICATIONS) {
    // The only place K5 may disagree with K1 is where an override says so; with zero counters and
    // no prior repair, nothing overrides, so the two must be identical.
    const decision = decideFinding(
      finding({ scopeClassification: classification }), address({ reporter: 'USER' }), state(), T);
    assert.ok(decision.ok);
    if (!decision.ok) continue;
    const expectFrozen = classification === 'SCOPE_EXPANSION'
      // CL3 pins it, and §3's own row already says FREEZE — so they agree here too.
      ? 'FREEZE_AND_REQUEST_REPLAN'
      : CLASSIFICATION_OUTCOME[classification];
    assert.equal(decision.triage.outcome, expectFrozen, classification);
  }
});

test('CL1: neither exempt class charges a counter, and neither can be frozen by a budget', () => {
  // Every counter at its limit. An `ENVIRONMENT` failure must still produce a system blocker: the
  // breaker has none of its spend to trip on, and freezing it would replace a row a person can act
  // on with one that says "budget exhausted" about a machine.
  const spent = counters({
    attemptsOnRevision: 99, attemptsWithoutProgress: 99, sameFingerprintRepeats: 99,
    sameActionRepeats: 99, repairsWithoutSeverityDrop: 99, decisionsWithoutProgress: 99,
    verificationRounds: 99, transientRetries: 99, scopeExpansionRequests: 99,
  });
  for (const classification of ['ENVIRONMENT', 'HUMAN_REQUIRED'] as const) {
    const decision = decideFinding(
      finding({ scopeClassification: classification }),
      address({ reporter: 'USER' }),
      state({ counters: spent }),
      T,
    );
    assert.ok(decision.ok);
    if (!decision.ok) continue;
    assert.equal(decision.triage.outcome, CLASSIFICATION_OUTCOME[classification], classification);
    assert.equal(decision.triage.override, null, `${classification} was overridden`);
    // CL1's claim precisely: neither class spends a BUDGET counter. `decisionsWithoutProgress` is
    // outside that — a judgment really was made and it really did not move the task forward — and
    // it is charged by `[K4]`'s rule for every observation, which is why this asserts the three
    // budget lines rather than the whole record.
    for (const key of ['attemptsWithoutProgress', 'transientRetries', 'scopeExpansionRequests',
      'verificationRounds'] as const) {
      assert.equal(decision.triage.counters[key], spent[key], `${classification} charged ${key}`);
    }
  }
});

test('CL2: a transient told once too often is reclassified, not merely refused', () => {
  const decision = decideFinding(
    finding({ scopeClassification: 'TRANSIENT' }),
    address({ reporter: 'COORDINATOR' }),
    state({ counters: counters({ transientRetries: T.maxTransientRetries! }) }),
    T,
  );
  assert.ok(decision.ok);
  if (!decision.ok) return;
  assert.equal(decision.triage.effectiveClassification, 'IN_SCOPE_DEFECT');
  assert.equal(decision.triage.override, 'TRANSIENT_BUDGET_EXHAUSTED');
  // And it now spends the attempt budget, which is CL2's whole point.
  assert.equal(decision.triage.counters.attemptsWithoutProgress, 1);
  assert.equal(decision.triage.counters.transientRetries, T.maxTransientRetries!);
});

test('CL3: a scope expansion freezes however much budget is left', () => {
  for (const spent of [counters(), counters({ attemptsWithoutProgress: 1 })]) {
    const decision = decideFinding(
      finding({ scopeClassification: 'SCOPE_EXPANSION' }),
      address({ reporter: 'WORKER' }),
      state({ counters: spent }),
      T,
    );
    assert.ok(decision.ok);
    if (!decision.ok) continue;
    assert.equal(decision.triage.outcome, 'FREEZE_AND_REQUEST_REPLAN');
    assert.equal(decision.triage.effect, 'REPLAN_TASK');
    // §2: a freeze lands the task in NEEDS_REPLAN, which is what makes it undispatchable (SM2).
    assert.equal(decision.triage.progressState, 'NEEDS_REPLAN');
  }
});

// ---------------------------------------------------------------------------------------------
// FD3 / FD3': the repair that stopped helping.
// ---------------------------------------------------------------------------------------------

test("FD3': one verification round, and a repair that did not lower the severity, is a re-plan", () => {
  // The task's own sentence: 一次 verificationRound 后的返修仍失败则默认 NEEDS_REPLAN. Round one
  // filed a P1 defect; round two reports a DIFFERENT failure (FD1 collapses an identical one) that
  // is no less severe. That is a repair that did not converge, and one round is the default budget.
  const round2 = decideFinding(
    finding({ failureFingerprint: OTHER_FINGERPRINT, severity: 'P1' }),
    address({ reporter: 'VERIFIER' }),
    state({
      counters: counters({ verificationRounds: 1, attemptsWithoutProgress: 1 }),
      lastRepairSeverity: 'P1',
    }),
    T,
  );
  assert.ok(round2.ok);
  if (!round2.ok) return;
  assert.equal(round2.triage.outcome, 'FREEZE_AND_REQUEST_REPLAN');
  assert.equal(round2.triage.override, 'REPAIR_WITHOUT_SEVERITY_DROP');
  assert.equal(round2.triage.progressState, 'NEEDS_REPLAN');
  assert.equal(round2.triage.nonConvergenceReason, 'SEVERITY_NOT_DECLINING');
});

test("FD3': a repair that DID lower the severity buys another round", () => {
  const round2 = decideFinding(
    finding({ failureFingerprint: OTHER_FINGERPRINT, severity: 'P2' }),
    address({ reporter: 'VERIFIER' }),
    state({ counters: counters({ verificationRounds: 1 }), lastRepairSeverity: 'P1' }),
    T,
  );
  assert.ok(round2.ok);
  if (!round2.ok) return;
  assert.equal(round2.triage.outcome, 'CREATE_DEFECT_SUBTASK');
  assert.equal(round2.triage.override, null);
});

test("FD3': the FIRST finding on a revision is a diagnosis, never a failed cure", () => {
  const first = decideFinding(
    finding({ severity: 'P0' }), address(), state({ lastRepairSeverity: null }), T);
  assert.ok(first.ok);
  if (!first.ok) return;
  assert.equal(first.triage.outcome, 'CREATE_DEFECT_SUBTASK');
  assert.equal(findingSeverityTrend(null, 'P0'), 'NONE');
});

test('FD3: the verification rounds run out even when every repair got smaller', () => {
  // Severity strictly dropping each round, so FD3' never fires — and the ABSOLUTE round count
  // still stops it. This is the line `[K4]` says the incident walked past because each round did
  // close something.
  const rounds = T.maxVerificationRounds!;
  const decision = decideFinding(
    finding({ severity: 'P3', failureFingerprint: OTHER_FINGERPRINT }),
    address(),
    state({ counters: counters({ verificationRounds: rounds }), lastRepairSeverity: 'P2' }),
    T,
  );
  assert.ok(decision.ok);
  if (!decision.ok) return;
  assert.equal(decision.triage.outcome, 'FREEZE_AND_REQUEST_REPLAN');
  assert.equal(decision.triage.override, 'VERIFICATION_ROUNDS_EXHAUSTED');
});

test('a breaker already tripped on another line freezes the finding and says which line', () => {
  const decision = decideFinding(
    finding({ severity: 'P3', failureFingerprint: OTHER_FINGERPRINT }),
    address(),
    state({
      counters: counters({ attemptsWithoutProgress: T.maxAttemptsWithoutProgress! }),
      lastRepairSeverity: 'P2',
    }),
    T,
  );
  assert.ok(decision.ok);
  if (!decision.ok) return;
  assert.equal(decision.triage.outcome, 'FREEZE_AND_REQUEST_REPLAN');
  assert.equal(decision.triage.override, 'CIRCUIT_TRIPPED');
  assert.equal(decision.triage.nonConvergenceReason, 'ATTEMPT_BUDGET_EXHAUSTED');
});

// ---------------------------------------------------------------------------------------------
// §1 OW1/OW2: what a reporter may and may not claim.
// ---------------------------------------------------------------------------------------------

test('§3 谁能定: no agent may declare its own failure transient or environmental', () => {
  for (const reporter of ['WORKER', 'VERIFIER'] as const) {
    for (const classification of ['TRANSIENT', 'ENVIRONMENT'] as const) {
      const decision = decideFinding(
        finding({ scopeClassification: classification }), address({ reporter }), state(), T);
      assert.equal(decision.ok, false, `${reporter} was allowed to claim ${classification}`);
      if (decision.ok) continue;
      assert.equal(decision.refusal, 'CLASSIFICATION_NOT_REPORTABLE');
    }
  }
});

test('§1 OW2: a worker asking for more scope is a finding, and the answer is a freeze', () => {
  // The positive half of the prohibition. `ADD_ACCEPTANCE_CRITERION` is refused to a WORKER by
  // `[K1]`'s frozen matrix; `REPORT_FINDING` is not, and this is where that leads.
  assert.equal(
    authorizeScopeAction('WORKER', 'ADD_ACCEPTANCE_CRITERION', 'AUTO'),
    'ACCEPTANCE_CHANGE_REQUIRES_USER',
  );
  assert.equal(authorizeScopeAction('WORKER', 'REPORT_FINDING', 'GUARDED_AUTO'), 'ALLOWED');
  const decision = decideFinding(
    finding({ scopeClassification: 'SCOPE_EXPANSION' }),
    address({ reporter: 'WORKER' }),
    state(),
    T,
  );
  assert.ok(decision.ok);
  if (!decision.ok) return;
  assert.equal(decision.triage.outcome, 'FREEZE_AND_REQUEST_REPLAN');
  // OW3: the coordinator may not mint the new revision, so the row it files is addressed to a user.
  assert.equal(decision.triage.owner, 'USER');
});

test('§1 OW1: a verifier is never allowed to revise scope, under any policy', () => {
  for (const policy of ['MANUAL', 'GUARDED_AUTO', 'AUTO'] as const) {
    assert.equal(
      authorizeScopeAction('VERIFIER', 'REVISE_SCOPE', policy), 'SCOPE_CHANGE_REQUIRES_USER');
    assert.equal(
      authorizeScopeAction('VERIFIER', 'ADD_ACCEPTANCE_CRITERION', policy),
      'ACCEPTANCE_CHANGE_REQUIRES_USER');
  }
  // And the finding shape carries no field it could use to do so indirectly: §6's seven keys and
  // nothing else. A field named here that is not in §6's table is a door OW1 does not cover.
  assert.deepEqual(Object.keys(finding()).sort(), [
    'evidence', 'failureFingerprint', 'minimalRepro', 'scopeClassification', 'severity',
    'verdict', 'violatedInvariant',
  ]);
});

test('every actor may report SOMETHING, so the prohibition always has an exit', () => {
  for (const actor of SCOPE_ACTORS) {
    const open = CONVERGENCE_CLASSIFICATIONS
      .filter((classification) => FINDING_REPORTERS[classification].includes(actor));
    assert.ok(open.length > 0, `${actor} may report nothing at all`);
    assert.ok(open.includes('HUMAN_REQUIRED'), `${actor} cannot ask for a person`);
  }
});

// ---------------------------------------------------------------------------------------------
// §6: the shape gate.
// ---------------------------------------------------------------------------------------------

test('FD4: a finding measured against a revision the task has moved past is refused', () => {
  const decision = decideFinding(
    finding(), address({ scopeRevision: 1 }), state({ scopeRevision: 2 }), T);
  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.equal(decision.refusal, 'STALE_SCOPE_REVISION');
  assert.equal(decision.field, 'scopeRevision');
});

test('FD4 is asked FIRST, so a stale finding is never told to fix its other fields', () => {
  const decision = decideFinding(
    finding({ severity: 'P9' as FindingSeverity, minimalRepro: '' }),
    address({ scopeRevision: 1 }),
    state({ scopeRevision: 7 }),
    T,
  );
  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.equal(decision.refusal, 'STALE_SCOPE_REVISION');
});

test('§6: every required field is required, in the table\'s own order', () => {
  const cases: Array<[Partial<VerificationFinding>, string]> = [
    [{ severity: 'P4' as FindingSeverity }, 'UNKNOWN_SEVERITY'],
    [{ violatedInvariant: '   ' }, 'EMPTY_VIOLATED_INVARIANT'],
    [{ minimalRepro: '' }, 'EMPTY_MINIMAL_REPRO'],
    [{ failureFingerprint: 'not-a-digest' }, 'MALFORMED_FINGERPRINT'],
    [{ failureFingerprint: 'A'.repeat(64) }, 'MALFORMED_FINGERPRINT'],
    [{ scopeClassification: 'MAYBE' as ConvergenceClassification }, 'UNKNOWN_CLASSIFICATION'],
    [{ verdict: 'PASS' as never }, 'UNKNOWN_VERDICT'],
    [{ evidence: {} }, 'EMPTY_EVIDENCE'],
  ];
  for (const [over, refusal] of cases) {
    const result = validateFinding(finding(over), address({ reporter: 'USER' }), state());
    assert.equal(result.ok, false, `${refusal} was accepted`);
    if (result.ok) continue;
    assert.equal(result.refusal, refusal);
  }
});

test('§6: a verdict of PASS is not a finding', () => {
  // Stated on its own because it is the one refusal that looks like an oversight. A check that
  // passed has nothing §3 turns into work, so the row would have no consequence.
  const result = validateFinding(
    finding({ verdict: 'PASS' as never }), address({ reporter: 'USER' }), state());
  assert.equal(result.ok, false);
});

test('§6: evidence spelled with internal UUIDs is refused, however deeply nested', () => {
  const uuid = '018f2b3c-4d5e-7f80-9a1b-2c3d4e5f6071';
  for (const evidence of [
    { sessionId: uuid },
    { runs: [{ id: uuid }] },
    { outer: { inner: { deep: [{ taskId: uuid }] } } },
  ]) {
    const result = validateFinding(finding({ evidence }), address({ reporter: 'USER' }), state());
    assert.equal(result.ok, false, JSON.stringify(evidence));
    if (result.ok) continue;
    assert.equal(result.refusal, 'EVIDENCE_NOT_PUBLIC_ID');
  }
  // A Base62 public id is not a UUID and passes.
  const ok = validateFinding(
    finding({ evidence: { taskId: '34BTLPdio3UejBPEykVNt' } }), address({ reporter: 'USER' }),
    state());
  assert.equal(ok.ok, true);
});

// ---------------------------------------------------------------------------------------------
// FD1: identity.
// ---------------------------------------------------------------------------------------------

test('FD1: the dedup key is the document\'s, and carries only its four terms', () => {
  assert.equal(
    findingDedupKey('PROJ', 'SUBJ', 3, FINGERPRINT),
    `pc:v1:PROJ:finding:SUBJ:3:${FINGERPRINT}`,
  );
  // The same failure found by a second check, in a second session, on a later attempt, is ONE key.
  // If any of those were in it, the second report would file a second subtask — which is the
  // property this whole unit is measured on.
  assert.equal(
    findingDedupKey('PROJ', 'SUBJ', 3, FINGERPRINT),
    findingDedupKey('PROJ', 'SUBJ', 3, FINGERPRINT),
  );
  // A different revision is a different question (FP3), so it is a different key.
  assert.notEqual(
    findingDedupKey('PROJ', 'SUBJ', 3, FINGERPRINT),
    findingDedupKey('PROJ', 'SUBJ', 4, FINGERPRINT),
  );
  // And the effect key is a function of it and of nothing else.
  assert.equal(
    findingEffectKey(findingDedupKey('PROJ', 'SUBJ', 3, FINGERPRINT)),
    findingEffectKey(`pc:v1:PROJ:finding:SUBJ:3:${FINGERPRINT}`),
  );
  assert.notEqual(
    findingEffectKey(findingDedupKey('PROJ', 'SUBJ', 3, FINGERPRINT)),
    findingEffectKey(findingDedupKey('PROJ', 'SUBJ', 3, OTHER_FINGERPRINT)),
  );
});

// ---------------------------------------------------------------------------------------------
// The exhaustive property, and §0's incident.
// ---------------------------------------------------------------------------------------------

test('every (class × reporter × counter) world produces exactly one outcome', () => {
  const spends: Array<Partial<ConvergenceCounters>> = [
    {},
    { transientRetries: T.maxTransientRetries! },
    { verificationRounds: T.maxVerificationRounds! },
    { attemptsWithoutProgress: T.maxAttemptsWithoutProgress! },
    { scopeExpansionRequests: 1 },
    { repairsWithoutSeverityDrop: T.maxRepairsWithoutSeverityDrop! },
  ];
  const severities: FindingSeverity[] = [...FINDING_SEVERITIES];
  const repairs: Array<FindingSeverity | null> = [null, 'P0', 'P2'];
  let counted = 0;
  for (const classification of CONVERGENCE_CLASSIFICATIONS) {
    for (const reporter of SCOPE_ACTORS) {
      for (const spend of spends) {
        for (const severity of severities) {
          for (const lastRepairSeverity of repairs) {
            counted += 1;
            const decision = decideFinding(
              finding({ scopeClassification: classification, severity }),
              address({ reporter }),
              state({ counters: counters(spend), lastRepairSeverity }),
              T,
            );
            if (!decision.ok) {
              // The only legal refusal in this space is the reporter table; every other field is
              // well formed by construction.
              assert.equal(decision.refusal, 'CLASSIFICATION_NOT_REPORTABLE',
                `${classification}/${reporter}`);
              assert.equal(FINDING_REPORTERS[classification].includes(reporter), false);
              continue;
            }
            const triage = decision.triage;
            // Exactly one artifact, and it is the outcome's own.
            assert.equal(triage.effect, OUTCOME_EFFECT[triage.outcome]);
            assert.equal(triage.owner, OUTCOME_OWNER[triage.outcome]);
            // A blocker outcome names a kind; a task outcome does not, and neither names both.
            const blocker = triage.effect === 'SYSTEM_BLOCKER' || triage.effect === 'USER_BLOCKER';
            assert.equal(blocker, triage.outcome.startsWith('RAISE_'));
            if (blocker) assert.ok(EFFECT_BLOCKER_KIND[triage.effect as 'SYSTEM_BLOCKER']);
            // A required action is always present: RL2's "明确的下一步", never a silent drop.
            assert.ok(triage.requiredAction.length > 0);
            // The two exempt classes are never frozen by anybody else's budget (CL1).
            if (classification === 'ENVIRONMENT' || classification === 'HUMAN_REQUIRED') {
              assert.equal(triage.outcome, CLASSIFICATION_OUTCOME[classification]);
            }
            // A freeze always names why, and always lands the task where SM2 cannot dispatch it.
            if (triage.outcome === 'FREEZE_AND_REQUEST_REPLAN') {
              assert.ok(triage.nonConvergenceReason !== null);
              assert.equal(triage.progressState, 'NEEDS_REPLAN');
            }
          }
        }
      }
    }
  }
  assert.equal(counted, 6 * 4 * 6 * 4 * 3);
});

test('§0 replay: a failure told as transient for ever becomes a defect, then a re-plan', () => {
  // The incident's shape, one finding at a time. Every round has a NEW fingerprint (the error text
  // carried a fresh session id), so FD1 never collapses them and `sameFingerprintRepeats` never
  // climbs — which is exactly why the original loop ran unbounded.
  let live = state({ progressState: 'CONVERGING' });
  const outcomes: string[] = [];
  for (let round = 0; round < 8; round += 1) {
    const decision = decideFinding(
      finding({
        scopeClassification: 'TRANSIENT',
        failureFingerprint: String(round).padStart(64, '0'),
      }),
      address({ reporter: 'COORDINATOR' }),
      live,
      T,
    );
    assert.ok(decision.ok);
    if (!decision.ok) break;
    outcomes.push(decision.triage.outcome);
    live = state({
      progressState: decision.triage.progressState,
      counters: decision.triage.counters,
      lastFingerprint: String(round).padStart(64, '0'),
      lastRepairSeverity: decision.triage.effect === 'DEFECT_SUBTASK'
        ? 'P1'
        : live.lastRepairSeverity,
    });
  }
  // Bounded, and bounded quickly: three transient retries, then it stops being a transient story.
  assert.deepEqual(outcomes.slice(0, 3), [
    'RETRY_WITHIN_BUDGET', 'RETRY_WITHIN_BUDGET', 'RETRY_WITHIN_BUDGET',
  ]);
  assert.equal(outcomes[3], 'CREATE_DEFECT_SUBTASK');
  // And it never returns to retrying: RL1's "每一个可以循环的形状都有一个有限上限".
  assert.equal(outcomes.slice(4).every((o) => o === 'FREEZE_AND_REQUEST_REPLAN'), true,
    outcomes.join(','));
  assert.equal(live.progressState, 'NEEDS_REPLAN');
});

test('a finding never counts as progress, whatever it concludes', () => {
  // RL0, as the one thing that would make the whole bound vacuous. Producing findings is activity;
  // a counter that reset on activity would never reach any limit.
  for (const classification of CONVERGENCE_CLASSIFICATIONS) {
    const before = counters({ attemptsWithoutProgress: 2, decisionsWithoutProgress: 2 });
    const triage = triageFinding(
      finding({ scopeClassification: classification }),
      address({ reporter: 'USER' }),
      state({ counters: before }),
      T,
    );
    assert.ok(triage.counters.decisionsWithoutProgress >= before.decisionsWithoutProgress,
      classification);
    assert.ok(triage.counters.attemptsWithoutProgress >= before.attemptsWithoutProgress,
      classification);
    // And no counter ever walks backwards, which is RL3's whole claim about restarts.
    for (const key of Object.keys(before) as Array<keyof ConvergenceCounters>) {
      assert.ok(triage.counters[key] >= before[key], `${classification}/${key} went down`);
    }
  }
});
