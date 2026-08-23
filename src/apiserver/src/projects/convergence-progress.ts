import { createHash } from 'node:crypto';

import { canonicalJson } from './canonical-json';
import {
  CLASSIFICATION_COUNTER,
  ConvergenceClassification,
  ConvergenceCounters,
  ConvergenceDispatchRefusal,
  ConvergenceThresholds,
  NON_CONVERGENCE_PRIORITY,
  NON_CONVERGENCE_RULE,
  NonConvergenceReason,
  PROGRESS_RESET_COUNTERS,
  SEVERITY_RESET_COUNTERS,
  SeverityTrend,
  TaskProgressState,
  ZERO_COUNTERS,
} from './convergence-contract';

/**
 * `[K1]`: the progress vector, the failure fingerprint and the breaker, as pure functions.
 *
 * These are the frozen contract's decision procedure, not its wiring. `[K1]` owes an answer to
 * "did this move", "is this the same failure" and "is this still bounded" that a replay can
 * recompute; `[K2]` persists the ledger these read, `[K4]` calls them from the control loop.
 * Nothing here touches a database, a clock or a session, and nothing outside `[K1]` calls it yet.
 *
 * Everything here is a pure function of committed facts. That is not a style preference — the
 * project's decisions are replayed byte-for-byte by `assertDecisionReplay`, so a breaker that read
 * a clock or a counter held in process memory would make two replays of one world disagree about
 * whether a task was stopped. It is also the only way §8 TH4 can be true: counters that live in the
 * ledger cannot be reset by a restart, and a function that only reads them cannot be tricked by one.
 */

/**
 * §4's table, exhaustively. Adding a field here is a contract change and
 * `convergence-contract.spec.ts` §4 PV1 refuses the specific additions that would re-admit
 * "the agent was busy" as evidence of progress.
 */
export interface ProgressVector {
  /** Which target this measurement is against. Two vectors are only comparable when these match. */
  scopeHash: string;
  acceptanceClosed: number;
  acceptanceTotal: number;
  openP0: number;
  openP1: number;
  regressions: number;
  openBlockers: number;
  knownGoodSha: string | null;
}

export const EMPTY_PROGRESS_VECTOR: Readonly<ProgressVector> = {
  scopeHash: '',
  acceptanceClosed: 0,
  acceptanceTotal: 0,
  openP0: 0,
  openP1: 0,
  regressions: 0,
  openBlockers: 0,
  knownGoodSha: null,
};

/** Which way each numeric dimension is allowed to move for the change to count as improvement. */
const DIMENSIONS: ReadonlyArray<{ key: keyof ProgressVector; better: 'UP' | 'DOWN' }> = [
  { key: 'acceptanceClosed', better: 'UP' },
  { key: 'openP0', better: 'DOWN' },
  { key: 'openP1', better: 'DOWN' },
  { key: 'regressions', better: 'DOWN' },
  { key: 'openBlockers', better: 'DOWN' },
];

/**
 * §4 PV2/PV3: strict improvement toward acceptance.
 *
 * True iff the two vectors measure the SAME target, nothing got worse, and at least one dimension
 * got better. Three failures this shape is chosen to refuse:
 *
 *  - "I closed one acceptance item and opened two P0s" is not progress. Any dimension moving the
 *    wrong way disqualifies the whole step, so trading one axis for another cannot buy budget.
 *  - "I changed what I was doing" is not progress. A different `scopeHash` is incomparable, which
 *    is what stopped the incident's scope from expanding its way out of every limit (§0).
 *  - "It has been running for an hour" is not progress, because time is not in the vector at all.
 */
export function strictlyImproves(before: ProgressVector, after: ProgressVector): boolean {
  if (before.scopeHash !== after.scopeHash) return false;
  let better = false;
  for (const { key, better: direction } of DIMENSIONS) {
    const from = before[key] as number;
    const to = after[key] as number;
    if (direction === 'UP') {
      if (to < from) return false;
      if (to > from) better = true;
    } else {
      if (to > from) return false;
      if (to < from) better = true;
    }
  }
  // §4's table, exactly: `null → 非 null 是进展；非 null → 另一个非 null 不是`. A checkpoint APPEARING
  // is improvement on its own — it is the one dimension whose value is an identity rather than a
  // count — and MOVING one is not.
  //
  // PV5 is why the second half is not a detail. Every other dimension is bounded (a count that can
  // only walk toward its edge), so the number of times a revision can strictly improve is finite
  // and TH6's bound holds. A checkpoint that could be moved would be the one dimension with no
  // edge: push another commit, claim progress, zero the four counters, repeat. That is the shape
  // the incident actually had — 「又推了一个提交」— and it is what makes the attempt budget
  // unreachable rather than merely generous.
  if (before.knownGoodSha === null && after.knownGoodSha !== null) better = true;
  // Losing one is the reverse, and disqualifies the step for the same reason a rising P0 count does.
  if (before.knownGoodSha !== null && after.knownGoodSha === null) return false;
  return better;
}

/** The vector's identity, for storing next to a decision so "did this move" is a comparison. */
export function progressVectorDigest(vector: ProgressVector): string {
  return sha256(canonicalJson(vector));
}

/** §5's stages and subjects — the two coordinates that keep unrelated failures apart. */
export type FailureStage = 'DISPATCH' | 'RUN' | 'VERIFY' | 'MERGE' | 'ACCEPTANCE';
export type FailureSubjectKind = 'TASK' | 'SESSION' | 'PROJECT' | 'BRANCH';

export interface FailureFacts {
  stage: FailureStage;
  subjectKind: FailureSubjectKind;
  scopeHash: string;
  /** A stable code for what broke. Empty when the failure carries no invariant of its own. */
  violatedInvariant: string;
  /** Raw text, as it was observed. Normalized here rather than by the caller (FP1). */
  message: string;
}

/**
 * §5's normalization, in the document's order.
 *
 * The point is FP1: the same defect reported with a new timestamp, a new session id and a line
 * number that moved by two must land on ONE fingerprint, or the repeat counter never counts to two
 * and the breaker never trips. The incident in §0 is exactly this — every retry's error text
 * differed in an id, so every retry looked like a new problem.
 *
 * It is equally important that it stops there. Normalizing away words would merge genuinely
 * different root causes (FP2), and a breaker that trips on unrelated failures stops work that was
 * converging.
 */
export function normalizeFailureText(message: string): string {
  return message
    // 1. ISO 8601 timestamps, before the digit rule can eat them.
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
    // 2. UUIDs, before the hex rule can claim their fragments.
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    // 3. Commit-shaped hex.
    .replace(/\b[0-9a-f]{40}\b|\b[0-9a-f]{64}\b/gi, '<sha>')
    // 4. Absolute paths keep their basename: which file broke is the root cause, which worktree it
    //    was checked out in is not — and every session gets a different worktree.
    .replace(/(?:\/[\w.@+-]+){2,}/g, (match) => `<path>/${match.slice(match.lastIndexOf('/') + 1)}`)
    // 5. `:line:col` positions.
    .replace(/:\d+:\d+\b/g, ':<pos>')
    // 6. Remaining numbers, decimal or hex.
    .replace(/\b0x[0-9a-f]+\b/gi, '<n>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<n>')
    // 7/8. Whitespace, then case.
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** §5: the failure's identity within one scope revision. */
export function failureFingerprint(facts: FailureFacts): string {
  return sha256(canonicalJson({
    stage: facts.stage,
    subjectKind: facts.subjectKind,
    scopeHash: facts.scopeHash,
    violatedInvariant: facts.violatedInvariant,
    normalizedMessage: normalizeFailureText(facts.message),
  }));
}

/** §1: the frozen identity of what a task is asking for. A scope change moves this and only this. */
export function scopeHash(scope: {
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
}): string {
  return sha256(canonicalJson({
    title: scope.title,
    description: scope.description ?? '',
    acceptanceCriteria: scope.acceptanceCriteria ?? '',
  }));
}

/**
 * How one observation moves the committed counters — §3's `计入` column plus §4 PV4's reset.
 *
 * Three properties this shape buys, all of which the incident needed:
 *
 *  - Strict progress zeroes exactly §4 PV4's four counters and nothing else. `attemptsOnRevision`
 *    keeps climbing, because a revision that took twenty attempts to inch forward is still a
 *    revision that should be replanned — but it is bounded by its OWN line (the hard cap), not by
 *    the five-attempt budget, so inching forward is not punished as if nothing had moved.
 *  - A step that progressed never charges a counter the same step just reset. Charging and
 *    resetting in one call would make the budget depend on which happened last, and the result
 *    would differ between a live decision and its replay.
 *  - An observation with no classification and no progress still spends `decisionsWithoutProgress`.
 *    "Nothing applied" was the incident's most common step, and treating it as free is what let the
 *    loop run unbounded while every individual rule looked satisfied.
 *
 * `[K4]`'s two inputs — `sameActionPriorCount` and `severity` — are REQUIRED rather than optional,
 * and that is deliberate. A default for `severity` would charge the repair line to a task that DID
 * reduce its defect load, which is the false stop this unit was reviewed for; a default for
 * `sameActionPriorCount` would fail open on the line the incident actually crossed. Both are facts
 * about the world that only the caller can have looked up, and a caller that has not looked should
 * find that out from the type checker rather than from a task that was stopped for a bad reason.
 */
export function advanceCounters(
  counters: ConvergenceCounters,
  observation: {
    classification: ConvergenceClassification | null;
    progressed: boolean;
    fingerprint: string | null;
    previousFingerprint: string | null;
    /** An attempt was started for this observation. Charges the absolute per-revision counter. */
    attemptStarted?: boolean;
    verificationRoundClosed?: boolean;
    /**
     * `[K4]`: how many decisions in the CURRENT no-progress window already proposed this action.
     * Read from the ledger by the writer, because it is a fact about committed rows and not
     * something a counter can accumulate — see `sameActionRepeats` below for why it is a window
     * rather than a run.
     */
    sameActionPriorCount: number;
    /** `[K4]`: what happened to `openP0 + openP1` — see `severityTrend`. */
    severity: SeverityTrend;
  },
): ConvergenceCounters {
  const next: ConvergenceCounters = { ...counters };
  if (observation.attemptStarted) next.attemptsOnRevision += 1;
  if (observation.progressed) {
    for (const key of PROGRESS_RESET_COUNTERS) next[key] = 0;
  } else {
    next.decisionsWithoutProgress += 1;
    next.sameFingerprintRepeats = observation.fingerprint !== null
      && observation.fingerprint === observation.previousFingerprint
      ? counters.sameFingerprintRepeats + 1
      : 0;
    // The MAXIMUM over the window, not this action's own count. Two properties come out of that
    // and both are needed: it cannot go down while the window is open (RL3/TH4 — a new action
    // must not talk the counter back down and buy another round), and it reads as "some action
    // has now been proposed N+1 times without moving", which is the sentence §8 bounds.
    next.sameActionRepeats = Math.max(
      counters.sameActionRepeats,
      observation.sameActionPriorCount,
    );
  }
  // §8's repair line. Charged only where somebody claims this is a defect of THIS task — the
  // classification whose promise is "one more repair closes it" — and only when the defect load
  // did not in fact fall. Reset needs both licences: the load fell AND the step was strict
  // progress overall, because a round that closed a P0 and opened a regression has not earned a
  // fresh repair budget.
  if (observation.progressed && observation.severity === 'DROPPED') {
    for (const key of SEVERITY_RESET_COUNTERS) next[key] = 0;
  } else if (observation.classification === 'IN_SCOPE_DEFECT' && observation.severity === 'HELD') {
    next.repairsWithoutSeverityDrop += 1;
  }
  if (observation.verificationRoundClosed) next.verificationRounds += 1;
  const counter = observation.classification
    ? CLASSIFICATION_COUNTER[observation.classification]
    : null;
  // A counter this step just zeroed is not charged in the same step: the reset is the newer fact.
  if (counter && !(observation.progressed && PROGRESS_RESET_COUNTERS.includes(counter))) {
    next[counter] += 1;
  }
  return next;
}

export interface NonConvergenceVerdict {
  tripped: boolean;
  reason: NonConvergenceReason | null;
  /** The counter and the limit it crossed, so the blocker can say WHY without re-deriving it. */
  observed: number | null;
  limit: number | null;
}

/**
 * §8's breaker, evaluated in TH1's fixed order.
 *
 * Order matters and is not an implementation detail: a world can cross two lines in one step, and
 * a replay that reported whichever the iteration happened to reach first would produce two
 * different blockers for one decision. The order also encodes a judgment — a scope expansion is
 * reported ahead of a repeated failure because the repeated failure is a SYMPTOM of working on the
 * wrong thing, and telling a person "the same test failed three times" when the truth is "this
 * task grew into a different project" sends them to fix the wrong problem.
 */
export function detectNonConvergence(
  counters: ConvergenceCounters,
  thresholds: ConvergenceThresholds,
): NonConvergenceVerdict {
  for (const reason of NON_CONVERGENCE_PRIORITY) {
    const rule = NON_CONVERGENCE_RULE[reason];
    const limit = thresholds[rule.threshold];
    if (limit === null) continue;
    const observed = counters[rule.counter];
    if (observed > limit) return { tripped: true, reason, observed, limit };
  }
  return { tripped: false, reason: null, observed: null, limit: null };
}

/**
 * §3 CL2: "it keeps being flaky" stops being a transient story once it has been told often enough.
 *
 * Reclassification rather than an immediate trip, because the two say different things to whoever
 * reads it: `TRANSIENT` promises "retrying will work", and after `maxTransientRetries` failures
 * that promise is simply false. Calling the next one an in-scope defect puts it on the attempt
 * budget where it belongs — and the attempt budget is what eventually trips.
 */
export function reclassifyExhaustedTransient(
  classification: ConvergenceClassification,
  counters: ConvergenceCounters,
  thresholds: ConvergenceThresholds,
): ConvergenceClassification {
  if (classification !== 'TRANSIENT') return classification;
  const limit = thresholds.maxTransientRetries;
  if (limit === null) return classification;
  return counters.transientRetries >= limit ? 'IN_SCOPE_DEFECT' : 'TRANSIENT';
}

/**
 * §8 TH4, as an assertion the ledger writer can make before committing.
 *
 * A counter that goes DOWN without strict progress is the shape every escape from this breaker
 * has: a restart that re-initialises from zero, a duplicate event processed as a fresh attempt, a
 * second coordinator taking over and starting its own count. Returning the maximum rather than
 * throwing is deliberate — the writer is on the commit path and refusing to write would stall the
 * project, while a counter that only ever climbs cannot be talked downward.
 */
export function mergeCounters(
  committed: ConvergenceCounters,
  proposed: ConvergenceCounters,
  progressed: boolean,
  severity: SeverityTrend = 'NONE',
): ConvergenceCounters {
  const merged: ConvergenceCounters = { ...ZERO_COUNTERS };
  for (const key of Object.keys(ZERO_COUNTERS) as Array<keyof ConvergenceCounters>) {
    // Strict progress is the ONE licence to reset, and §4 PV4 says which it resets. `[K4]`'s
    // repair counter is outside that set and carries the second licence, which is strictly
    // narrower: progress AND the defect load actually falling.
    const resettable = progressed
      && (PROGRESS_RESET_COUNTERS.includes(key)
        || (severity === 'DROPPED' && SEVERITY_RESET_COUNTERS.includes(key)));
    merged[key] = resettable ? proposed[key] : Math.max(committed[key], proposed[key]);
  }
  return merged;
}

/**
 * §9's gate, as the pure function GT2 asks for.
 *
 * It answers §9's two questions and no others: whether the breaker has already landed in the
 * state column, and whether it has crossed a line the state column has not caught up with yet.
 * Whether the task is in a state that may be attempted at all is §2 SM2's question and stays
 * with `isDispatchableProgressState`, and the rest of the preconditions are the main contract's
 * §7.4 — a gate that quietly answered those too would be a second, disagreeing copy of them.
 *
 * `null` is "§9 has no objection", not "dispatch". The distinction matters because the caller has
 * other questions to ask, and a gate that returns a cheerful `ALLOWED` invites skipping them.
 *
 * GT1: both answers are terminal. A caller that gets one must not queue, back off or schedule a
 * wake — SM4's three explicit authorizations are the only things that clear them, and a retry
 * timer would just re-ask a question whose answer cannot change on its own.
 */
export function convergenceDispatchRefusal(
  state: { progressState: TaskProgressState; counters: ConvergenceCounters },
  thresholds: ConvergenceThresholds,
): ConvergenceDispatchRefusal | null {
  if (state.progressState === 'NEEDS_REPLAN') return 'TASK_NEEDS_REPLAN';
  if (state.progressState === 'SETTLED') return null;
  return detectNonConvergence(state.counters, thresholds).tripped
    ? 'TASK_CONVERGENCE_BUDGET_EXHAUSTED'
    : null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
