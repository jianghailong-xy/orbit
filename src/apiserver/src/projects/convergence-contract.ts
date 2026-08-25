/**
 * `[K1]`: the bounded-convergence contract, in code.
 *
 * This file is the normative source for the constants below. Nothing in it reads a clock, a database or a
 * session — it is the vocabulary the rest of `[K2]..[K9]` is written in.
 *
 * The one sentence the whole unit exists for (§0 RL0): **progress is strict improvement toward
 * acceptance, not activity**. Every table below is downstream of that. A control loop that counts
 * "did something happen" is green while a task is retried three hundred times on the same failure,
 * which is exactly the incident this contract was frozen after.
 */

/**
 * §2's states. `NEEDS_REPLAN` is deliberately NOT terminal (SM3): the circuit tripping means "stop
 * spending and go ask", and a terminal state would turn every trip into an abandoned task.
 */
export type TaskProgressState =
  | 'CONVERGING'
  | 'RETRYING_TRANSIENT'
  | 'VERIFYING'
  | 'NEEDS_REPLAN'
  | 'BLOCKED'
  | 'AWAITING_HUMAN'
  | 'SETTLED';

export const TASK_PROGRESS_STATES: readonly TaskProgressState[] = [
  'CONVERGING',
  'RETRYING_TRANSIENT',
  'VERIFYING',
  'NEEDS_REPLAN',
  'BLOCKED',
  'AWAITING_HUMAN',
  'SETTLED',
];

/** §2's events. Every one of them is a committed fact, never a timer firing. */
export type ConvergenceEvent =
  | 'ATTEMPT_STARTED'
  | 'ATTEMPT_DELIVERED'
  | 'ATTEMPT_FAILED_TRANSIENT'
  | 'ATTEMPT_FAILED_IN_SCOPE'
  | 'VERIFICATION_PASSED'
  | 'VERIFICATION_FAILED_IN_SCOPE'
  | 'PREREQUISITE_FOUND'
  | 'ENVIRONMENT_FAILURE'
  | 'HUMAN_REQUIRED'
  | 'SCOPE_EXPANSION_REQUESTED'
  | 'CIRCUIT_TRIPPED'
  | 'BLOCKER_CLEARED'
  | 'REPLAN_AUTHORIZED'
  | 'BUDGET_EXTENDED'
  | 'TASK_TERMINAL';

export const CONVERGENCE_EVENTS: readonly ConvergenceEvent[] = [
  'ATTEMPT_STARTED',
  'ATTEMPT_DELIVERED',
  'ATTEMPT_FAILED_TRANSIENT',
  'ATTEMPT_FAILED_IN_SCOPE',
  'VERIFICATION_PASSED',
  'VERIFICATION_FAILED_IN_SCOPE',
  'PREREQUISITE_FOUND',
  'ENVIRONMENT_FAILURE',
  'HUMAN_REQUIRED',
  'SCOPE_EXPANSION_REQUESTED',
  'CIRCUIT_TRIPPED',
  'BLOCKER_CLEARED',
  'REPLAN_AUTHORIZED',
  'BUDGET_EXTENDED',
  'TASK_TERMINAL',
];

/**
 * §2's transition table, verbatim. A pair that is absent is `NO_TRANSITION` — the state does not
 * move AND the decision that observed it counts as one without progress (§4 PV4), which is what
 * stops "nothing applies" from being a free pass through the budget.
 */
export const CONVERGENCE_TRANSITIONS: Readonly<
  Record<TaskProgressState, Readonly<Partial<Record<ConvergenceEvent, TaskProgressState>>>>
> = {
  CONVERGING: {
    ATTEMPT_STARTED: 'CONVERGING',
    ATTEMPT_DELIVERED: 'VERIFYING',
    ATTEMPT_FAILED_TRANSIENT: 'RETRYING_TRANSIENT',
    ATTEMPT_FAILED_IN_SCOPE: 'CONVERGING',
    PREREQUISITE_FOUND: 'BLOCKED',
    ENVIRONMENT_FAILURE: 'BLOCKED',
    HUMAN_REQUIRED: 'AWAITING_HUMAN',
    SCOPE_EXPANSION_REQUESTED: 'NEEDS_REPLAN',
    CIRCUIT_TRIPPED: 'NEEDS_REPLAN',
    TASK_TERMINAL: 'SETTLED',
  },
  RETRYING_TRANSIENT: {
    ATTEMPT_STARTED: 'CONVERGING',
    ATTEMPT_FAILED_TRANSIENT: 'RETRYING_TRANSIENT',
    ATTEMPT_FAILED_IN_SCOPE: 'CONVERGING',
    ENVIRONMENT_FAILURE: 'BLOCKED',
    HUMAN_REQUIRED: 'AWAITING_HUMAN',
    CIRCUIT_TRIPPED: 'NEEDS_REPLAN',
    TASK_TERMINAL: 'SETTLED',
  },
  VERIFYING: {
    VERIFICATION_PASSED: 'SETTLED',
    VERIFICATION_FAILED_IN_SCOPE: 'CONVERGING',
    SCOPE_EXPANSION_REQUESTED: 'NEEDS_REPLAN',
    PREREQUISITE_FOUND: 'BLOCKED',
    ENVIRONMENT_FAILURE: 'BLOCKED',
    HUMAN_REQUIRED: 'AWAITING_HUMAN',
    CIRCUIT_TRIPPED: 'NEEDS_REPLAN',
    TASK_TERMINAL: 'SETTLED',
  },
  NEEDS_REPLAN: {
    REPLAN_AUTHORIZED: 'CONVERGING',
    BUDGET_EXTENDED: 'CONVERGING',
    HUMAN_REQUIRED: 'AWAITING_HUMAN',
    TASK_TERMINAL: 'SETTLED',
  },
  BLOCKED: {
    BLOCKER_CLEARED: 'CONVERGING',
    HUMAN_REQUIRED: 'AWAITING_HUMAN',
    CIRCUIT_TRIPPED: 'NEEDS_REPLAN',
    TASK_TERMINAL: 'SETTLED',
  },
  AWAITING_HUMAN: {
    REPLAN_AUTHORIZED: 'CONVERGING',
    BUDGET_EXTENDED: 'CONVERGING',
    BLOCKER_CLEARED: 'CONVERGING',
    TASK_TERMINAL: 'SETTLED',
  },
  SETTLED: {},
};

/**
 * §2's SM4: the only three edges out of `NEEDS_REPLAN`, and every one of them needs a decision
 * somebody is accountable for. Nothing here is reachable from a timer, a restart or a redelivered
 * event, which is the property `[K9]`'s fault injection replays.
 */
export const REPLAN_EXIT_EVENTS: readonly ConvergenceEvent[] = [
  'REPLAN_AUTHORIZED',
  'BUDGET_EXTENDED',
  'HUMAN_REQUIRED',
];

/** The states §2's table marks dispatchable. Read by `[K7]`'s gate, never re-derived. */
export const DISPATCHABLE_PROGRESS_STATES: readonly TaskProgressState[] = [
  'CONVERGING',
  'RETRYING_TRANSIENT',
];

export function progressStateAfter(
  state: TaskProgressState,
  event: ConvergenceEvent,
): TaskProgressState | null {
  return CONVERGENCE_TRANSITIONS[state][event] ?? null;
}

export function isDispatchableProgressState(state: TaskProgressState): boolean {
  return DISPATCHABLE_PROGRESS_STATES.includes(state);
}

/** §3's six classes. A failure belongs to exactly one. */
export type ConvergenceClassification =
  | 'TRANSIENT'
  | 'IN_SCOPE_DEFECT'
  | 'PREREQUISITE'
  | 'SCOPE_EXPANSION'
  | 'ENVIRONMENT'
  | 'HUMAN_REQUIRED';

export const CONVERGENCE_CLASSIFICATIONS: readonly ConvergenceClassification[] = [
  'TRANSIENT',
  'IN_SCOPE_DEFECT',
  'PREREQUISITE',
  'SCOPE_EXPANSION',
  'ENVIRONMENT',
  'HUMAN_REQUIRED',
];

/** §3's "唯一合法结果" column. One class, one consequence — the table IS the dispatch of §6 FD2. */
export type ConvergenceOutcome =
  | 'RETRY_WITHIN_BUDGET'
  | 'CREATE_DEFECT_SUBTASK'
  | 'CREATE_PREREQUISITE_TASK'
  | 'FREEZE_AND_REQUEST_REPLAN'
  | 'RAISE_SYSTEM_BLOCKER'
  | 'RAISE_USER_BLOCKER';

export const CLASSIFICATION_OUTCOME: Readonly<
  Record<ConvergenceClassification, ConvergenceOutcome>
> = {
  TRANSIENT: 'RETRY_WITHIN_BUDGET',
  IN_SCOPE_DEFECT: 'CREATE_DEFECT_SUBTASK',
  PREREQUISITE: 'CREATE_PREREQUISITE_TASK',
  SCOPE_EXPANSION: 'FREEZE_AND_REQUEST_REPLAN',
  ENVIRONMENT: 'RAISE_SYSTEM_BLOCKER',
  HUMAN_REQUIRED: 'RAISE_USER_BLOCKER',
};

/**
 * §3 CL1: which counter a class spends. `null` means it spends none — re-running an
 * `ENVIRONMENT` or `HUMAN_REQUIRED` failure cannot change its outcome, so charging it to the
 * attempt budget would trip the breaker for a reason that is not the task's.
 */
export const CLASSIFICATION_COUNTER: Readonly<
  Record<ConvergenceClassification, ConvergenceCounterName | null>
> = {
  TRANSIENT: 'transientRetries',
  IN_SCOPE_DEFECT: 'attemptsWithoutProgress',
  PREREQUISITE: 'attemptsWithoutProgress',
  SCOPE_EXPANSION: 'scopeExpansionRequests',
  ENVIRONMENT: null,
  HUMAN_REQUIRED: null,
};

export type ConvergenceCounterName =
  | 'attemptsOnRevision'
  | 'attemptsWithoutProgress'
  | 'sameFingerprintRepeats'
  | 'sameActionRepeats'
  | 'repairsWithoutSeverityDrop'
  | 'decisionsWithoutProgress'
  | 'verificationRounds'
  | 'transientRetries'
  | 'scopeExpansionRequests';

/** The committed counters a breaker decision is a pure function of (§8 TH4). */
export interface ConvergenceCounters {
  /** Every attempt ever made on this scope revision. §4 PV4: never reset, not even by progress. */
  attemptsOnRevision: number;
  /** Attempts since the last strict improvement. §4 PV4 resets it; that is the whole point. */
  attemptsWithoutProgress: number;
  sameFingerprintRepeats: number;
  /**
   * `[K4]` (v1.2). How many times the action this decision proposes has ALREADY been proposed on
   * this revision since the last strict progress.
   *
   * Counted against the whole run rather than against the previous decision alone, because the
   * cheapest way past a consecutive counter is to alternate: A, B, A, B never repeats twice in a
   * row and never stops. The incident (§0) alternated between re-running the suite and pushing a
   * fix for one turn at a time, which is why "the same failure twice in a row" never fired.
   */
  sameActionRepeats: number;
  /**
   * `[K4]` (v1.2). Closed repair rounds since `openP0 + openP1` last strictly dropped.
   *
   * §8's `verificationRounds` asks "how many times has this been sent back"; this asks whether
   * being sent back is ACHIEVING anything. A task can burn repair rounds while the defect count
   * holds steady — every round closes one finding and opens another — and that is the shape of a
   * repair loop rather than of a repair.
   */
  repairsWithoutSeverityDrop: number;
  decisionsWithoutProgress: number;
  verificationRounds: number;
  transientRetries: number;
  scopeExpansionRequests: number;
}

export const ZERO_COUNTERS: Readonly<ConvergenceCounters> = {
  attemptsOnRevision: 0,
  attemptsWithoutProgress: 0,
  sameFingerprintRepeats: 0,
  sameActionRepeats: 0,
  repairsWithoutSeverityDrop: 0,
  decisionsWithoutProgress: 0,
  verificationRounds: 0,
  transientRetries: 0,
  scopeExpansionRequests: 0,
};

/**
 * §4 PV4's reset set: the four counters strict progress zeroes, and the ONLY four. The three
 * absolutes (`attemptsOnRevision`, `verificationRounds`, `scopeExpansionRequests`) are outside it
 * on purpose — a revision that needed twenty attempts to inch forward is still a revision that
 * should be replanned, and a counter progress can zero cannot express that.
 */
export const PROGRESS_RESET_COUNTERS: readonly ConvergenceCounterName[] = [
  'attemptsWithoutProgress',
  'sameFingerprintRepeats',
  'sameActionRepeats',
  'decisionsWithoutProgress',
  'transientRetries',
];

/**
 * `[K4]`: what happened to the defect load — `openP0 + openP1` — between two vectors.
 *
 * Three cases and not two, because "it did not fall" and "there was nothing to fall" are different
 * worlds and only one of them is evidence of a repair loop. A task whose findings are not filed as
 * P0/P1 at all would otherwise spend the repair budget on a line that has nothing to say about it,
 * and be stopped with a reason — 「返修没让缺陷数下降」— that is not true of it.
 */
export type SeverityTrend = 'DROPPED' | 'HELD' | 'NONE';

/**
 * `[K4]` (v1.2): the one counter with a reset licence of its own.
 *
 * `repairsWithoutSeverityDrop` is deliberately NOT in the set above. Strict progress is any
 * dimension improving, and closing an acceptance item while the defect count holds is exactly the
 * world this counter exists to name — letting it be zeroed by that would delete the observation
 * that produced it. It resets on its own evidence and on nothing else: `openP0 + openP1` went down.
 */
export const SEVERITY_RESET_COUNTERS: readonly ConvergenceCounterName[] = [
  'repairsWithoutSeverityDrop',
];

/** §8's thresholds. `null` is "unbounded" and is only legal with a USER's signature (OW4). */
export interface ConvergenceThresholds {
  maxAttemptsWithoutProgress: number | null;
  maxAttemptsPerScopeRevision: number | null;
  maxSameFingerprintRepeats: number | null;
  maxSameActionRepeats: number | null;
  maxRepairsWithoutSeverityDrop: number | null;
  maxDecisionsWithoutProgress: number | null;
  maxVerificationRounds: number | null;
  maxTransientRetries: number | null;
  maxScopeExpansionRequests: number | null;
}

export const DEFAULT_CONVERGENCE_THRESHOLDS: Readonly<ConvergenceThresholds> = {
  maxAttemptsWithoutProgress: 5,
  maxAttemptsPerScopeRevision: 24,
  maxSameFingerprintRepeats: 2,
  maxSameActionRepeats: 2,
  // Three rather than two, and the reason is ordering rather than generosity: at two this line
  // would fire on the incident's own replay one round BEFORE `SAME_FAILURE_REPEATED`, and report
  // "the defect count is not falling" about a loop whose actual diagnosis is "this exact failure,
  // again". These two lines exist to catch what the fingerprint line MISSES — a loop whose error
  // text changes every round — not to answer ahead of it when it is about to speak.
  maxRepairsWithoutSeverityDrop: 3,
  maxDecisionsWithoutProgress: 6,
  maxVerificationRounds: 2,
  maxTransientRetries: 3,
  maxScopeExpansionRequests: 0,
};

/**
 * §8's per-attempt resource budget. Reaching one ENDS the attempt; it does not fail it (TH2).
 *
 * The last two dimensions were added by `[K3]` (doc v1.1). Both were already in §8's prose — TH2
 * asks the attempt to write a checkpoint on its way out, TH3 says steering is not a new attempt —
 * and neither was in the table, which by RL1 means neither was a bound at all.
 *
 * `maxContextPercent` is a PERCENTAGE of the session's reported context window rather than a token
 * count, because a token count is a property of the model and not of the task: one absolute number
 * is too strict for every small window and vacuous for every large one. The 20% the default leaves
 * is not slack — it is the context TH2's wind-down has to be written in.
 */
export interface AttemptBudget {
  maxTurns: number | null;
  maxWallClockMs: number | null;
  maxToolCalls: number | null;
  maxCostMicros: number | null;
  maxContextPercent: number | null;
  maxCoordinatorSteers: number | null;
}

/**
 * What every project is judged by, because `project.attempt_budget` is NULL on every row that
 * exists (unit T5 measured; nothing has ever written the column). So these are not placeholders
 * waiting for a policy — they ARE the policy, and they are written down here with where they came
 * from, so that raising one is an argument about a number rather than a shrug.
 *
 * Calibrated against this deployment's own session population on 2026-08-25 (4,221 sessions),
 * because a limit derived from nothing is a limit nobody can defend when it fires:
 *
 *   dimension     p50      p90      p95      p99       max        default    lands at
 *   ----------    ----     ----     ----     ----      -------    -------    ---------
 *   turns         5        98       163      301       1,003      60         ~p80
 *   wall clock    6 min    137 min  429 min  8.3 days  20 days    60 min     ~p85
 *   cost          $3.46    $33.13   $70.33   $244.34   $1,847     $20        ~p85
 *   tool calls    50       178      247      523       56,252     1,200      >p99.9
 *   context %     20       52       —        89        —          80         ~p98
 *
 * Read the three that bind first. `maxTurns` at ~p80 is the one aimed squarely at the incident:
 * "hundreds of rounds" sits at p99 and above, and four sessions in five never come near 60.
 * `maxWallClockMs` at one hour is the one holding a runner slot, and the tail it exists for is
 * visible above — a p99 of 8.3 days is not a long task, it is a session nobody ever ended.
 * `maxCostMicros` at $20 is the same shape in money.
 *
 * `maxToolCalls` deliberately sits ABOVE p99.9 (3,933) rather than near the others: a session's
 * tool count is a property of the work (a large refactor greps a lot) and not of whether it is
 * converging, so this dimension is a runaway-loop backstop and not a working limit. Stated rather
 * than tuned, so nobody later reads its silence as evidence that it is doing something.
 *
 * `maxContextPercent` is the one number that is NOT a percentile: 80 leaves the 20% that TH2's
 * wind-down has to be written in. See `AttemptBudget` above.
 *
 * `maxCoordinatorSteers` has no distribution to calibrate against — nothing has ever charged one —
 * and 3 is the answer to a different question. §4's legal move once an attempt is not working is a
 * NEW GENERATION with a new hypothesis, so the steer allowance only has to cover "you missed
 * something small"; making it generous would restore the unbounded verb it exists to bound.
 */
export const DEFAULT_ATTEMPT_BUDGET: Readonly<AttemptBudget> = {
  maxTurns: 60,
  maxWallClockMs: 3_600_000,
  maxToolCalls: 1_200,
  maxCostMicros: 20_000_000,
  maxContextPercent: 80,
  maxCoordinatorSteers: 3,
};

/** §8's reasons, in TH1's fixed evaluation order. Exported as an array because the ORDER is the
 *  contract — two lines crossed at once must report one determinate answer or a replay forks. */
export type NonConvergenceReason =
  | 'SCOPE_EXPANSION_REQUIRED'
  | 'SAME_FAILURE_REPEATED'
  | 'SAME_ACTION_REPEATED'
  | 'SEVERITY_NOT_DECLINING'
  | 'VERIFICATION_ROUNDS_EXHAUSTED'
  | 'TRANSIENT_RETRY_BUDGET_EXHAUSTED'
  | 'ATTEMPT_BUDGET_EXHAUSTED'
  | 'HARD_ATTEMPT_CAP_REACHED'
  | 'NO_PROGRESS';

export const NON_CONVERGENCE_PRIORITY: readonly NonConvergenceReason[] = [
  'SCOPE_EXPANSION_REQUIRED',
  'SAME_FAILURE_REPEATED',
  'SAME_ACTION_REPEATED',
  'SEVERITY_NOT_DECLINING',
  'VERIFICATION_ROUNDS_EXHAUSTED',
  'TRANSIENT_RETRY_BUDGET_EXHAUSTED',
  'ATTEMPT_BUDGET_EXHAUSTED',
  'HARD_ATTEMPT_CAP_REACHED',
  'NO_PROGRESS',
];

/** Which counter each reason reads, and which threshold bounds it. §8's table, as a lookup. */
export const NON_CONVERGENCE_RULE: Readonly<Record<NonConvergenceReason, {
  counter: ConvergenceCounterName;
  threshold: keyof ConvergenceThresholds;
}>> = {
  SCOPE_EXPANSION_REQUIRED: {
    counter: 'scopeExpansionRequests',
    threshold: 'maxScopeExpansionRequests',
  },
  SAME_FAILURE_REPEATED: {
    counter: 'sameFingerprintRepeats',
    threshold: 'maxSameFingerprintRepeats',
  },
  // `[K4]`: the two lines the incident walked straight past. It never repeated a FAILURE twice in a
  // row — the error text carried a fresh session id every time — and it never ran out of
  // verification rounds, because each round did close something. What it did do was propose the
  // same action over and over while the defect count never moved, and neither of those was a line.
  SAME_ACTION_REPEATED: {
    counter: 'sameActionRepeats',
    threshold: 'maxSameActionRepeats',
  },
  SEVERITY_NOT_DECLINING: {
    counter: 'repairsWithoutSeverityDrop',
    threshold: 'maxRepairsWithoutSeverityDrop',
  },
  VERIFICATION_ROUNDS_EXHAUSTED: {
    counter: 'verificationRounds',
    threshold: 'maxVerificationRounds',
  },
  TRANSIENT_RETRY_BUDGET_EXHAUSTED: {
    counter: 'transientRetries',
    threshold: 'maxTransientRetries',
  },
  // The two attempt lines are separate because they answer different questions. "Five tries and
  // nothing moved" is a hypothesis that is not working; "twenty-four tries total" is a task that
  // was mis-sized however well each try went. Collapsing them onto the counter that never resets —
  // the draft this unit reviewed did exactly that — stops a task that is genuinely converging.
  ATTEMPT_BUDGET_EXHAUSTED: {
    counter: 'attemptsWithoutProgress',
    threshold: 'maxAttemptsWithoutProgress',
  },
  HARD_ATTEMPT_CAP_REACHED: {
    counter: 'attemptsOnRevision',
    threshold: 'maxAttemptsPerScopeRevision',
  },
  NO_PROGRESS: {
    counter: 'decisionsWithoutProgress',
    threshold: 'maxDecisionsWithoutProgress',
  },
};

/** §9's two extra dispatch refusals. Terminal answers: no queue, no backoff, no wake (GT1). */
export type ConvergenceDispatchRefusal =
  | 'TASK_NEEDS_REPLAN'
  | 'TASK_CONVERGENCE_BUDGET_EXHAUSTED';

export const CONVERGENCE_DISPATCH_REFUSALS: readonly ConvergenceDispatchRefusal[] = [
  'TASK_NEEDS_REPLAN',
  'TASK_CONVERGENCE_BUDGET_EXHAUSTED',
];

/** §7's two checkpoint kinds and §7 CP3's refusal codes. */
export type CheckpointKind = 'ACCEPTED' | 'WIP_RED';

export type MergeGateRefusal =
  | 'NO_CHECKPOINT'
  | 'CHECKPOINT_NOT_ACCEPTED'
  | 'SCOPE_REVISION_MISMATCH'
  | 'BRANCH_TIP_MISMATCH'
  | 'TEST_EVIDENCE_MISMATCH';

export const MERGE_GATE_REFUSALS: readonly MergeGateRefusal[] = [
  'NO_CHECKPOINT',
  'CHECKPOINT_NOT_ACCEPTED',
  'SCOPE_REVISION_MISMATCH',
  'BRANCH_TIP_MISMATCH',
  'TEST_EVIDENCE_MISMATCH',
];

/**
 * §1's authority table: WHO may change WHAT a task is asking for.
 *
 * `[K1]` freezes this as a table rather than as prose because the incident's scope grew from "fix
 * one bug" into "AutoRetry + deploy + lock ordering" without a single one of those expansions ever
 * being a decision somebody made. Every actor below can still SAY the task is too small — that is
 * `REQUEST_SCOPE_EXPANSION`, and §3 gives it exactly one consequence (freeze and ask). What none of
 * them can do is act on their own request, which is the difference between reporting a problem and
 * quietly redefining success.
 */
export type ScopeActor = 'USER' | 'COORDINATOR' | 'WORKER' | 'VERIFIER';

export const SCOPE_ACTORS: readonly ScopeActor[] = ['USER', 'COORDINATOR', 'WORKER', 'VERIFIER'];

export type ScopeAction =
  | 'REVISE_SCOPE'
  | 'ADD_ACCEPTANCE_CRITERION'
  | 'REQUEST_SCOPE_EXPANSION'
  | 'REPORT_FINDING'
  | 'AUTHORIZE_UNBOUNDED';

export const SCOPE_ACTIONS: readonly ScopeAction[] = [
  'REVISE_SCOPE',
  'ADD_ACCEPTANCE_CRITERION',
  'REQUEST_SCOPE_EXPANSION',
  'REPORT_FINDING',
  'AUTHORIZE_UNBOUNDED',
];

export type ScopeAuthorityRefusal =
  | 'SCOPE_CHANGE_REQUIRES_USER'
  | 'ACCEPTANCE_CHANGE_REQUIRES_USER'
  | 'UNBOUNDED_REQUIRES_USER'
  | 'REPLAN_REQUIRES_AUTHORIZATION';

export type ScopeAuthorityDecision = 'ALLOWED' | ScopeAuthorityRefusal;

/** The `GUARDED_AUTO` table — the default, and the one §8's thresholds are calibrated for. */
export const SCOPE_AUTHORITY: Readonly<
  Record<ScopeActor, Readonly<Record<ScopeAction, ScopeAuthorityDecision>>>
> = {
  USER: {
    REVISE_SCOPE: 'ALLOWED',
    ADD_ACCEPTANCE_CRITERION: 'ALLOWED',
    REQUEST_SCOPE_EXPANSION: 'ALLOWED',
    REPORT_FINDING: 'ALLOWED',
    AUTHORIZE_UNBOUNDED: 'ALLOWED',
  },
  COORDINATOR: {
    // OW3: the coordinator's answer to "this needs to be a different task" is to stop and ask,
    // not to write the different task. Under `AUTO` the user has signed for that; see below.
    REVISE_SCOPE: 'REPLAN_REQUIRES_AUTHORIZATION',
    ADD_ACCEPTANCE_CRITERION: 'ACCEPTANCE_CHANGE_REQUIRES_USER',
    REQUEST_SCOPE_EXPANSION: 'ALLOWED',
    REPORT_FINDING: 'ALLOWED',
    AUTHORIZE_UNBOUNDED: 'UNBOUNDED_REQUIRES_USER',
  },
  WORKER: {
    // OW2: a worker may report that the job is bigger. Self-approving the bigger job is how an
    // attempt budget gets spent on work nobody asked for.
    REVISE_SCOPE: 'SCOPE_CHANGE_REQUIRES_USER',
    ADD_ACCEPTANCE_CRITERION: 'ACCEPTANCE_CHANGE_REQUIRES_USER',
    REQUEST_SCOPE_EXPANSION: 'ALLOWED',
    REPORT_FINDING: 'ALLOWED',
    AUTHORIZE_UNBOUNDED: 'UNBOUNDED_REQUIRES_USER',
  },
  VERIFIER: {
    // OW1: a verifier that can edit the acceptance criteria is grading its own exam — it could
    // make any subject pass, and §6's findings would stop meaning anything.
    REVISE_SCOPE: 'SCOPE_CHANGE_REQUIRES_USER',
    ADD_ACCEPTANCE_CRITERION: 'ACCEPTANCE_CHANGE_REQUIRES_USER',
    REQUEST_SCOPE_EXPANSION: 'ALLOWED',
    REPORT_FINDING: 'ALLOWED',
    AUTHORIZE_UNBOUNDED: 'UNBOUNDED_REQUIRES_USER',
  },
};

/** The policies §1 reads. Mirrors `ProjectAutomationPolicy`; kept local so this file stays pure. */
export type ConvergenceAutomationPolicy = 'MANUAL' | 'GUARDED_AUTO' | 'AUTO';

/**
 * §1 OW1–OW3. The table above is the answer under every policy but one: `AUTO` is the user saying
 * in advance that the coordinator may re-plan without being asked each time, so that ONE cell
 * opens. Nothing else moves — `AUTO` is not a licence to add acceptance criteria or to switch the
 * breaker off, because those are the two ways an autonomous loop stops being bounded at all.
 */
export function authorizeScopeAction(
  actor: ScopeActor,
  action: ScopeAction,
  policy: ConvergenceAutomationPolicy,
): ScopeAuthorityDecision {
  if (actor === 'COORDINATOR' && action === 'REVISE_SCOPE' && policy === 'AUTO') return 'ALLOWED';
  return SCOPE_AUTHORITY[actor][action];
}

/** Who signed for an unbounded threshold. OW4 accepts exactly one kind of signature. */
export interface ScopeAuthorization {
  actor: ScopeActor;
  principal: string;
}

/**
 * OW4, enforced rather than documented: an unbounded threshold is only a threshold somebody signed
 * for, and §1's table says only a USER's signature counts. A configuration that says `null` with
 * nobody's name on it — or with the coordinator's own name on it — is read as the default, which is
 * finite. The failure mode this refuses is a migration, a stray PATCH, or an agent writing its own
 * authorization, silently turning the breaker off for every project at once.
 */
export function resolveThresholds(
  overrides: Partial<ConvergenceThresholds> | null | undefined,
  unboundedAuthorizedBy: ScopeAuthorization | null | undefined,
): ConvergenceThresholds {
  const resolved: ConvergenceThresholds = { ...DEFAULT_CONVERGENCE_THRESHOLDS };
  if (!overrides) return resolved;
  for (const key of Object.keys(DEFAULT_CONVERGENCE_THRESHOLDS) as Array<keyof ConvergenceThresholds>) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (value === null) {
      if (unboundedIsAuthorized(unboundedAuthorizedBy)) resolved[key] = null;
      continue;
    }
    if (!Number.isInteger(value) || value < 0) continue;
    resolved[key] = value;
  }
  return resolved;
}

/** The same rule for §8's resource budget: `null` without an authorizer falls back to the default. */
export function resolveAttemptBudget(
  overrides: Partial<AttemptBudget> | null | undefined,
  unboundedAuthorizedBy: ScopeAuthorization | null | undefined,
): AttemptBudget {
  const resolved: AttemptBudget = { ...DEFAULT_ATTEMPT_BUDGET };
  if (!overrides) return resolved;
  for (const key of Object.keys(DEFAULT_ATTEMPT_BUDGET) as Array<keyof AttemptBudget>) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (value === null) {
      if (unboundedIsAuthorized(unboundedAuthorizedBy)) resolved[key] = null;
      continue;
    }
    if (!Number.isInteger(value) || value <= 0) continue;
    resolved[key] = value;
  }
  return resolved;
}

/** OW4's one accepted signature: a named user. Anybody else's is not a smaller authorization. */
function unboundedIsAuthorized(by: ScopeAuthorization | null | undefined): boolean {
  return !!by
    && by.principal.trim() !== ''
    && authorizeScopeAction(by.actor, 'AUTHORIZE_UNBOUNDED', 'AUTO') === 'ALLOWED';
}
