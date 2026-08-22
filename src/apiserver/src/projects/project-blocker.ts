/**
 * Structured blockers (contract §11).
 *
 * A blocker is how the control loop says "this step did not go forward, and here is who can move
 * it". §11.1 BL1 leaves no third option: every pass that does not advance lands on a blocker or on
 * a `NOOP` audit row that says why. This module is the frozen half of that — the closed kind set,
 * the per-kind constants, the dedupe rule, the lifecycle generation, and the plan a reconcile
 * derives from one snapshot. It reads no clock of its own and touches no database.
 *
 * Three axes, three questions, and they are deliberately not one column (§11.2, `PC-CX-12`):
 *
 *   `kind`     → `opensTurn`: does the control loop wake the coordinator for this? A CONSTANT of
 *                the kind, so escalation — which rewrites `owner` — cannot change it.
 *   `owner`    → `run_state` (§4.2 guards 2/3): who it belongs to right now. Escalation moves it.
 *   `recovery` → the clock (§10.4): what can clear it. Escalation leaves it alone (ES1).
 *
 * v1 had only `owner` and used it for all three. `BUDGET_EXHAUSTED` is where that broke: the
 * person who can raise a budget is the user, so `owner = USER`, so `AWAITING_HUMAN`, so
 * `nextWakeAt = NULL` — and a wait that ends by itself in six hours became a wait for somebody who
 * was never told (`PC-CX-05`). Splitting `recovery` out is what makes that row expressible.
 */

import { createHash } from 'node:crypto';

/**
 * §11.2's closed set. The first six are PAC §12's rejection codes, same name and same meaning:
 * when the resolution chain refuses a dispatch, the refusal code IS the kind. Inventing a synonym
 * would give one event two names across two contracts.
 */
export const PROJECT_BLOCKER_KINDS = [
  'WHO_UNRESOLVED',
  'WHO_NOT_IN_TEAM',
  'WHO_DISABLED',
  'PROVIDER_UNAVAILABLE',
  'RUNTIME_REQUIREMENT_UNMET',
  'NO_PROJECT_WORKSPACE',
  'NO_MATCHING_RUNNER',
  'MERGE_CONFLICT',
  'TEST_FAILED',
  'VERIFICATION_FAILED',
  'BUDGET_EXHAUSTED',
  'AWAITING_USER_APPROVAL',
  'AWAITING_USER_INPUT',
  'POLICY_MANUAL_HOLD',
  'DEPENDENCY_CYCLE',
  'COORDINATOR_UNAVAILABLE',
  'COORDINATOR_NO_PROGRESS',
  'AGGREGATE_PARENT_UNSATISFIABLE',
  'SUCCESSOR_OUTSIDE_SUBTREE',
  'VERIFICATION_REQUIRED',
  'UNKNOWN_FAILURE',
] as const;

export type ProjectBlockerKind = (typeof PROJECT_BLOCKER_KINDS)[number];

export type ProjectBlockerOwner = 'USER' | 'COORDINATOR' | 'SYSTEM';
export type ProjectBlockerRecovery = 'TIME' | 'EVENT' | 'HUMAN';
export type ProjectBlockerSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
export type ProjectBlockerResolvedBy = 'AUTO' | 'USER' | 'COORDINATOR';

/** What a blocker is about. `PROJECT` is the subject for anything project-wide. */
export const PROJECT_BLOCKER_SUBJECT_TYPES = [
  'PROJECT',
  'TASK',
  'SESSION',
  'PROVIDER',
  'RUNNER',
  'WORKSPACE',
  'ACTION',
] as const;

export type ProjectBlockerSubjectType = (typeof PROJECT_BLOCKER_SUBJECT_TYPES)[number];

/** ES4's default escalation threshold. Kinds whose §11.2 row names their own use that instead. */
export const PROJECT_BLOCKER_DEFAULT_ESCALATION_MS = 30 * 60_000;

export interface ProjectBlockerPolicy {
  /** §11.2's `默认 owner` column. The row's own `owner` starts here and moves only on ES3. */
  owner: ProjectBlockerOwner;
  /** §11.2's `recovery` column. Frozen for the life of the row (ES1). */
  recovery: ProjectBlockerRecovery;
  /** §11.2's `opensTurn` column, and §7.2's `BLOCKER_DECISION` list. A constant of the kind. */
  opensTurn: boolean;
  /**
   * How severe this reads on the control plane. The contract names the column and leaves its
   * values free, so this freezes them on one rule: an expected wait is INFO, something a machine
   * can still resolve on its own is WARNING, and everything that has stopped the work until
   * somebody acts is CRITICAL.
   */
  severity: ProjectBlockerSeverity;
  /**
   * BL5, `recovery = EVENT`: `next_check_at` is a recompute POLL. The normal path is an event
   * waking the loop and §11.4 recomputing the condition; this is only the backstop, so it moves
   * with the clock and never with `occurrences` (ES5).
   */
  pollMs: number | null;
  /**
   * ES4: the escalation due instant is `first_seen_at + escalateMs`, and it is the only thing that
   * triggers escalation. `occurrences` deliberately does not appear here — v1.2's `occurrences > 10`
   * made the owner, the `run_state` and one notification depend on how many times the same fact
   * was redelivered (`PC-CX-15`).
   *
   * For `recovery = HUMAN` this is also `next_check_at` (BL5): the row's clock is an escalation
   * alarm, not a recovery poll.
   */
  escalateMs: number;
  /** BL0's fourth question, in one executable sentence rather than a restated error string. */
  requiredAction: string;
}

/**
 * §11.2's table, one row per kind, read by the contract test rather than restated in prose.
 *
 * BL4 is the mechanical cross-check on it: `opensTurn` is true for exactly the rows whose default
 * `owner` is `COORDINATOR`, in both directions.
 */
export const PROJECT_BLOCKER_POLICY: Readonly<Record<ProjectBlockerKind, ProjectBlockerPolicy>> = {
  WHO_UNRESOLVED: {
    owner: 'COORDINATOR',
    recovery: 'EVENT',
    opensTurn: true,
    severity: 'WARNING',
    pollMs: 5 * 60_000,
    escalateMs: PROJECT_BLOCKER_DEFAULT_ESCALATION_MS,
    requiredAction: 'Assign this task to an agent on the project team.',
  },
  WHO_NOT_IN_TEAM: {
    owner: 'USER',
    recovery: 'HUMAN',
    opensTurn: false,
    severity: 'CRITICAL',
    pollMs: null,
    escalateMs: 60 * 60_000,
    requiredAction: 'Add the assigned agent to this project team, or reassign the task.',
  },
  WHO_DISABLED: {
    owner: 'USER',
    recovery: 'HUMAN',
    opensTurn: false,
    severity: 'CRITICAL',
    pollMs: null,
    escalateMs: 60 * 60_000,
    requiredAction: 'Re-enable the assigned agent, or reassign the task to an enabled one.',
  },
  PROVIDER_UNAVAILABLE: {
    owner: 'SYSTEM',
    recovery: 'EVENT',
    opensTurn: false,
    severity: 'WARNING',
    pollMs: 5 * 60_000,
    escalateMs: PROJECT_BLOCKER_DEFAULT_ESCALATION_MS,
    requiredAction: 'Wait for the provider to come back, or pin the task to an available one.',
  },
  RUNTIME_REQUIREMENT_UNMET: {
    owner: 'USER',
    recovery: 'HUMAN',
    opensTurn: false,
    severity: 'CRITICAL',
    pollMs: null,
    escalateMs: 15 * 60_000,
    requiredAction: 'Install the missing runtime on a runner, or drop the requirement.',
  },
  NO_PROJECT_WORKSPACE: {
    owner: 'USER',
    recovery: 'HUMAN',
    opensTurn: false,
    severity: 'CRITICAL',
    pollMs: null,
    escalateMs: 60 * 60_000,
    requiredAction: 'Give this project a workspace to run in.',
  },
  NO_MATCHING_RUNNER: {
    owner: 'SYSTEM',
    recovery: 'EVENT',
    opensTurn: false,
    severity: 'WARNING',
    pollMs: 2 * 60_000,
    escalateMs: PROJECT_BLOCKER_DEFAULT_ESCALATION_MS,
    requiredAction: 'Bring a runner that satisfies this task back online.',
  },
  MERGE_CONFLICT: {
    owner: 'COORDINATOR',
    recovery: 'EVENT',
    opensTurn: true,
    severity: 'CRITICAL',
    pollMs: 10 * 60_000,
    escalateMs: PROJECT_BLOCKER_DEFAULT_ESCALATION_MS,
    requiredAction: 'Resolve the merge conflict on this branch and merge again.',
  },
  TEST_FAILED: {
    // Q3-b: USER and never COORDINATOR, and only ever created on the last row of Q3's table —
    // inside the backoff there is no blocker at all, just a NOOP and a wake at the retry instant.
    owner: 'USER',
    recovery: 'HUMAN',
    opensTurn: false,
    severity: 'CRITICAL',
    pollMs: null,
    escalateMs: 60 * 60_000,
    requiredAction: 'This task has exhausted its automatic retries; look at why it keeps failing.',
  },
  VERIFICATION_FAILED: {
    owner: 'COORDINATOR',
    recovery: 'EVENT',
    opensTurn: true,
    severity: 'CRITICAL',
    pollMs: 5 * 60_000,
    escalateMs: PROJECT_BLOCKER_DEFAULT_ESCALATION_MS,
    requiredAction: 'Fix what the verification found, then run the check again.',
  },
  BUDGET_EXHAUSTED: {
    // §9.4: the window rolls out on its own, so SYSTEM/TIME. Escalating it after 30 minutes is how
    // "this project's budget is chronically too small" reaches a person without turning "this one
    // window is full" into a wait for one.
    owner: 'SYSTEM',
    recovery: 'TIME',
    opensTurn: false,
    severity: 'WARNING',
    pollMs: null,
    escalateMs: PROJECT_BLOCKER_DEFAULT_ESCALATION_MS,
    requiredAction: 'Wait for the daily session budget window to roll over, or raise the budget.',
  },
  AWAITING_USER_APPROVAL: {
    owner: 'USER',
    recovery: 'HUMAN',
    opensTurn: false,
    severity: 'INFO',
    pollMs: null,
    escalateMs: 24 * 60 * 60_000,
    requiredAction: 'Approve or reject the pending action.',
  },
  AWAITING_USER_INPUT: {
    owner: 'USER',
    recovery: 'HUMAN',
    opensTurn: false,
    severity: 'INFO',
    pollMs: null,
    escalateMs: 24 * 60 * 60_000,
    requiredAction: 'Answer the session that is waiting on you.',
  },
  POLICY_MANUAL_HOLD: {
    owner: 'USER',
    recovery: 'HUMAN',
    opensTurn: false,
    severity: 'INFO',
    pollMs: null,
    escalateMs: 24 * 60 * 60_000,
    requiredAction: 'Automation is set to MANUAL; start the next step yourself or raise the policy.',
  },
  DEPENDENCY_CYCLE: {
    owner: 'COORDINATOR',
    recovery: 'EVENT',
    opensTurn: true,
    severity: 'CRITICAL',
    pollMs: 5 * 60_000,
    escalateMs: PROJECT_BLOCKER_DEFAULT_ESCALATION_MS,
    requiredAction: 'Break the cycle in the task graph.',
  },
  COORDINATOR_UNAVAILABLE: {
    owner: 'USER',
    recovery: 'HUMAN',
    opensTurn: false,
    severity: 'CRITICAL',
    pollMs: null,
    escalateMs: 15 * 60_000,
    requiredAction: 'Give this project a coordinator agent with a live coordination workspace.',
  },
  COORDINATOR_NO_PROGRESS: {
    owner: 'USER',
    recovery: 'HUMAN',
    opensTurn: false,
    severity: 'CRITICAL',
    pollMs: null,
    escalateMs: 60 * 60_000,
    requiredAction: 'The coordinator ran on these facts and did not change them; take it from here.',
  },
  AGGREGATE_PARENT_UNSATISFIABLE: {
    // §13.1 AG7. `TASK_AGGREGATE_PARENT` is a non-blocking refusal because the children ARE the
    // next step — that is true right up until there is no child that can be one, and then the same
    // silence becomes §10.3's idling with a status on it. This row is the other half of AG6: the
    // dispatch gates keep refusing (correctly, and for ever), and this says who can end that.
    //
    // `USER`, so `opensTurn` is ✘ by BL4: what the roll-up needs is a DECISION about its subtree —
    // restore a child, file a new one, take the policy back to MANUAL, or cancel the roll-up — and
    // none of the four is a fact the coordinator can derive from the world. Waking it on every
    // pass to re-read a shape it cannot change is exactly §7.6 TR3's no-progress loop.
    owner: 'USER',
    recovery: 'HUMAN',
    opensTurn: false,
    // The work has stopped and only a person restarts it, which is this table's own definition of
    // CRITICAL — and it is stopped SILENTLY, which is what makes the row worth its severity.
    severity: 'CRITICAL',
    pollMs: null,
    escalateMs: 60 * 60_000,
    requiredAction: 'Nothing left under this task can complete it; add or restore a subtask, or set its completion policy to MANUAL.',
  },
  SUCCESSOR_OUTSIDE_SUBTREE: {
    // §13.1 AG7's third shape: every subtask this roll-up is still counting is a RETIRED one whose
    // work is not represented under it — a replacement that went somewhere else, or an attempt that
    // was abandoned with nothing taking it over. Refusing to settle those is right (settling would
    // complete the parent over work that left, or over work nobody did), and the cost is that the
    // count cannot go down by itself: §13.6 SU6 never dispatches any of those rows again.
    //
    // `USER` for the same reason as the row above: both exits are a judgement about where the
    // replacement work belongs, which is not derivable from the graph that has the problem in it.
    owner: 'USER',
    recovery: 'HUMAN',
    opensTurn: false,
    severity: 'CRITICAL',
    pollMs: null,
    escalateMs: 60 * 60_000,
    requiredAction: 'A retired subtask still counts against this task; re-parent its successor under it, clear the subtask\'s retirement, or remove the subtask.',
  },
  VERIFICATION_REQUIRED: {
    // §13.1 AG7's other shape: `VERIFICATION_PASSED` with its children in and no live check named
    // on it. The loop files the check itself when the team makes one determinable (§13.2's
    // `FILE_VERIFICATION_TASK`), so this row is what is LEFT — no independent agent, or an attempt
    // that has already been spent — and every one of those is a person's call.
    owner: 'USER',
    recovery: 'HUMAN',
    opensTurn: false,
    severity: 'WARNING',
    pollMs: null,
    escalateMs: 60 * 60_000,
    requiredAction: 'This task completes only on a passing verification and has none; file a verification task for it, or change its completion policy.',
  },
  UNKNOWN_FAILURE: {
    // BL2: the way an unclassified failure exists is that this row gets opened, not that the pass
    // shrugs. Automatic dispatch for the project stops until somebody looks.
    owner: 'USER',
    recovery: 'HUMAN',
    opensTurn: false,
    severity: 'CRITICAL',
    pollMs: null,
    escalateMs: PROJECT_BLOCKER_DEFAULT_ESCALATION_MS,
    requiredAction: 'An unclassified failure stopped this project; read the detail and clear it.',
  },
};

/** §7.2's `BLOCKER_DECISION` kind list, derived from the table rather than restated beside it. */
export const PROJECT_BLOCKER_TURN_KINDS: readonly ProjectBlockerKind[] = PROJECT_BLOCKER_KINDS
  .filter((kind) => PROJECT_BLOCKER_POLICY[kind].opensTurn);

/**
 * The kinds the RESOLUTION CHAIN itself produces (§7.4 re-answers every one of them, from the
 * current world, on every attempt).
 *
 * They are singled out because a row of this kind is a DESCRIPTION of the last attempt, not an
 * additional gate on the next one — and treating it as a gate makes its own condition impossible to
 * falsify. §11.4 BL3 recomputes "was the latest dispatch refused, and how"; if the guard stops the
 * dispatch, no later attempt is ever recorded, the recomputation keeps reading the same historical
 * refusal, and a `recovery = EVENT` row that §11.2 says the world can end on its own instead stays
 * open forever — the provider comes back and nothing notices. Unit 18's counterexample is exactly
 * that shape, so this list is the boundary that keeps the guard on the rows the chain does NOT
 * re-derive (a merge conflict, an exhausted retry budget, a failed check, an unclassified failure,
 * and everything project-wide).
 */
export const PROJECT_BLOCKER_RESOLUTION_CHAIN_KINDS: readonly ProjectBlockerKind[] = [
  'WHO_UNRESOLVED',
  'WHO_NOT_IN_TEAM',
  'WHO_DISABLED',
  'PROVIDER_UNAVAILABLE',
  'RUNTIME_REQUIREMENT_UNMET',
  'NO_PROJECT_WORKSPACE',
  'NO_MATCHING_RUNNER',
  // A missing coordinator is also re-answered by the dispatcher. Once a coordinator is assigned,
  // the next attempt is the evidence that resolves the historical task-scoped refusal. Actual
  // coordinator unavailability is separately observed as a PROJECT-scoped blocker and remains a
  // hard gate through `openBlockersStoppingDispatch`.
  'COORDINATOR_UNAVAILABLE',
];

/**
 * PAC §12 refusal / authorization reason codes that ARE a blocker, and the kind they become.
 *
 * §11.2's first six rows say the code is carried across verbatim; the rest of this map is the same
 * rule applied to the codes this deployment's resolution chain actually emits.
 */
export const PROJECT_BLOCKER_REFUSAL_KINDS: Readonly<Record<string, ProjectBlockerKind>> = {
  WHO_UNRESOLVED: 'WHO_UNRESOLVED',
  WHO_NOT_IN_TEAM: 'WHO_NOT_IN_TEAM',
  WHO_DISABLED: 'WHO_DISABLED',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  RUNTIME_REQUIREMENT_UNMET: 'RUNTIME_REQUIREMENT_UNMET',
  NO_PROJECT_WORKSPACE: 'NO_PROJECT_WORKSPACE',
  NO_MATCHING_RUNNER: 'NO_MATCHING_RUNNER',
  RUNNER_UNAVAILABLE: 'NO_MATCHING_RUNNER',
  SESSION_BUDGET_EXHAUSTED: 'BUDGET_EXHAUSTED',
  MAX_ATTEMPTS_REACHED: 'TEST_FAILED',
  VERIFICATION_DEFECT_OPEN: 'VERIFICATION_FAILED',
  VERIFICATION_FAILED_UPSTREAM: 'VERIFICATION_FAILED',
  POLICY_REQUIRES_APPROVAL: 'AWAITING_USER_APPROVAL',
  APPROVAL_PENDING: 'AWAITING_USER_APPROVAL',
  USER_CONTROL_REQUIRED: 'POLICY_MANUAL_HOLD',
  COORDINATOR_NOT_ASSIGNED: 'COORDINATOR_UNAVAILABLE',
  COORDINATOR_DISABLED: 'COORDINATOR_UNAVAILABLE',
  COORDINATOR_NOT_PROJECT_MEMBER: 'COORDINATOR_UNAVAILABLE',
  COORDINATOR_AGENT_DISABLED: 'COORDINATOR_UNAVAILABLE',
  UNKNOWN_FAILURE: 'UNKNOWN_FAILURE',
};

/**
 * Codes that are deliberately NOT a blocker, and why — the other half of BL1's "no silent skip".
 *
 * Every one of these is a case where the loop has NOT stopped: it scheduled a definite retry
 * (backoff, concurrency, rate limit, a not-yet-due `runAt`), the work is already moving
 * (`TASK_ALREADY_RUNNING`), the snapshot moved under the proposal (`STALE_SNAPSHOT`), or the
 * subject is simply out of scope. §9.5 Q3-a, §9.4's `maxConcurrentTasks` row and §7.6 TR2-b all
 * say the same thing in the same words: a NOOP audit row and a wake, not a blocker.
 *
 * A code in NEITHER list is the thing BL2 exists for. It does not fall through — it fails closed
 * to `UNKNOWN_FAILURE`, which stops the project's automatic dispatch until somebody looks.
 */
export const PROJECT_BLOCKER_NON_BLOCKING_REFUSALS: ReadonlySet<string> = new Set([
  'POLICY_ALLOWED',
  'APPROVAL_GRANTED',
  'APPROVAL_DENIED',
  'APPROVAL_EXPIRED',
  'APPROVAL_TARGET_MISMATCH',
  'PROJECT_NOT_OPEN',
  'TASK_NOT_OPEN',
  'TASK_DISPATCH_HELD',
  'TASK_NOT_DUE',
  'TASK_DEPENDENCIES_INCOMPLETE',
  'TASK_ALREADY_RUNNING',
  'RETRY_BACKOFF_ACTIVE',
  'PROJECT_CONCURRENCY_LIMIT',
  'AGENT_CONCURRENCY_LIMIT',
  'COORDINATOR_PERMISSION_DENIED',
  'CREATE_TASK_PERMISSION_DENIED',
  'DELEGATE_PERMISSION_DENIED',
  'STALE_SNAPSHOT',
  'AUTHORITY_REVOKED',
  'EXECUTION_CONTEXT_REVOKED',
  'EXECUTION_RESULT_CHANGED',
  // A dispatch this unit's own guard stopped because a blocker is already open. Mapping it to a
  // kind would make every blocker breed a second one on the next pass.
  'PROJECT_BLOCKED',
  // §13.6 SU6: the attempt was replaced or abandoned. Nobody is being asked for anything — the
  // successor holds the work — so a row here would be a request addressed to no one, and §13.4's
  // DONE gate would hold the whole project open on it.
  'TASK_SUPERSEDED',
  // §13.1 AG6: the task is completed by aggregating its children, so it is not work that failed to
  // start — it is not work. A blocker here is wrong in all three of BL1's axes at once: it names
  // no owner (nobody is being asked for anything), no required action (the children are already
  // moving on their own account), and §13.4's DONE gate would hold the whole project open on a
  // parent whose entire completion condition is those children finishing.
  //
  // Leaving it out is not a cosmetic miss, and this is the line that says why: BL2 fails an
  // unlisted code CLOSED to `UNKNOWN_FAILURE`, whose subject is the PROJECT, and §11 BL1 reads a
  // PROJECT-subject row as "stop everything". One aggregate parent that the commit gate correctly
  // refused would therefore stop every OTHER task in the project, permanently — the planner would
  // skip from then on and nothing clears the row automatically (§11.4 needs an attempt that is not
  // refused, and this one always will be). The refusal and this entry are one change, and the
  // deployment order in §13.1 AG6 puts this list ahead of anything that can emit the code.
  'TASK_AGGREGATE_PARENT',
]);

/**
 * BL2, in one function: an unclassified refusal becomes `UNKNOWN_FAILURE`, never `null`.
 *
 * `null` means "this code is a known non-blocker" and only the frozen list above can produce it.
 */
export function blockerKindForRefusal(code: string | null | undefined): ProjectBlockerKind | null {
  if (!code) return 'UNKNOWN_FAILURE';
  if (PROJECT_BLOCKER_NON_BLOCKING_REFUSALS.has(code)) return null;
  return PROJECT_BLOCKER_REFUSAL_KINDS[code] ?? 'UNKNOWN_FAILURE';
}

/** One dead letter as both writers name it: what was lost, not how hard delivery tried. */
export interface ProjectDeadLetterFact {
  /** Base62, like every id a decision carries. */
  eventId: string;
  kind: string;
  dedupeKey: string;
  attempts: number;
}

/**
 * §5.4 F22's dead letter, as one condition both of its writers derive from.
 *
 * Two places have to name this row. The delivery path knows the batch it is about to mark DEAD and
 * opens the row inside that same transaction; §11.4's recomputation knows every dead letter nobody
 * has acknowledged yet, and is what keeps the row open afterwards. They must produce the SAME
 * dedupe key — a recomputation that did not observe this condition would clear the very row that
 * stopped the project, and automatic dispatch would resume as if the lost signal had been handled.
 * That is exactly the silent recovery BL2 exists to prevent, so the key is built here once and the
 * two callers differ only in which events they hand it.
 *
 * The subject is the PROJECT: a signal the loop could not consume is not a fact about one task,
 * and the dispatch guard reads a PROJECT-subject row as "stop everything" — which is what fail
 * closed means here.
 */
export function projectDeadLetterCondition(
  projectId: string,
  events: readonly ProjectDeadLetterFact[],
): ObservedBlockerCondition {
  const sorted = [...events].sort((a, b) => compare(a.eventId, b.eventId));
  return {
    kind: 'UNKNOWN_FAILURE',
    subjectType: 'PROJECT',
    subjectId: projectId,
    // TF2: WHICH signals were lost, never how many times delivery was attempted at them. A digest
    // that moved with the attempt counter would call the same loss a new failure on every redelivery.
    facts: { deadEventIds: sorted.map((event) => event.eventId) },
    detail: {
      reason: 'the control loop could not consume these signals and they were permanently discarded',
      deadEvents: sorted,
    },
  };
}

/** §11.3: the default key, and the one every detector here uses. */
export function projectBlockerDedupeKey(
  kind: ProjectBlockerKind,
  subjectType: ProjectBlockerSubjectType,
  subjectId: string,
): string {
  return `${kind}:${subjectType}:${subjectId}`;
}

/**
 * TF2's `condition_version`: a digest of the SNAPSHOT FACTS that produced this row, never of how
 * many times they were seen.
 *
 * It is what lets "the conflicting file set changed" and "the same conflict was observed again" be
 * told apart mechanically — the first gets a new digest and may legitimately open a new turn, the
 * second does not.
 */
export function projectBlockerConditionVersion(
  kind: ProjectBlockerKind,
  subjectType: ProjectBlockerSubjectType,
  subjectId: string,
  facts: unknown,
): string {
  return createHash('sha256')
    .update(canonicalJson({ v: 1, kind, subjectType, subjectId, facts }))
    .digest('hex');
}

/** §7.3 / §11.3 BE3: the key and the row are one-to-one, so "which action opened this" is a
 *  lookup on `project_action.idempotency_key`, not an inference. */
export function raiseBlockerIdempotencyKey(
  projectId: string,
  kind: ProjectBlockerKind,
  subjectId: string,
  lifecycleGeneration: bigint | string,
): string {
  return `pc:v1:${projectId}:blocker:${kind}:${subjectId}:${lifecycleGeneration}`;
}

/** §8.2: keyed on the row id, so one row is cleared once in its life. */
export function clearBlockerIdempotencyKey(projectId: string, blockerId: string): string {
  return `pc:v1:${projectId}:unblock:${blockerId}`;
}

/** One open blocker row as the decision snapshot carries it. Ids are Base62, like the rest of
 *  `decisionInput`; timestamps are ISO-8601. */
export interface ProjectBlockerFact {
  id: string;
  kind: ProjectBlockerKind;
  owner: ProjectBlockerOwner;
  recovery: ProjectBlockerRecovery;
  severity: ProjectBlockerSeverity;
  requiredAction: string;
  subjectType: ProjectBlockerSubjectType;
  subjectId: string;
  dedupeKey: string;
  /** Decimal string, as every BigInt column crosses this boundary. */
  lifecycleGeneration: string;
  conditionVersion: string;
  firstSeenAt: string;
  lastSeenAt: string;
  /** BL7: display and diagnosis only. It appears in no key, no digest and no decision here. */
  occurrences: number;
  nextCheckAt: string;
  escalatedAt: string | null;
}

/** One condition this pass observed in the world, before it is matched against the open rows. */
export interface ObservedBlockerCondition {
  kind: ProjectBlockerKind;
  subjectType: ProjectBlockerSubjectType;
  subjectId: string;
  /** TF2's projection for this kind — what `condition_version` is computed from. */
  facts: unknown;
  /** Display payload. Never an input to any decision. */
  detail: Record<string, unknown>;
  /**
   * `recovery = TIME` only: the instant the condition ends by itself (BL5). `BUDGET_EXHAUSTED`
   * is the one kind that has one today, and it is a committed fact, not a clock reading.
   */
  recoveryAt?: string;
}

export interface PlannedBlockerRaise {
  kind: ProjectBlockerKind;
  owner: ProjectBlockerOwner;
  recovery: ProjectBlockerRecovery;
  severity: ProjectBlockerSeverity;
  requiredAction: string;
  subjectType: ProjectBlockerSubjectType;
  subjectId: string;
  dedupeKey: string;
  conditionVersion: string;
  /**
   * `evaluation.epoch`, and the value the row is written with.
   *
   * Not the writer's own `now()`. ES4's escalation due instant is `first_seen_at + threshold`, and
   * later passes recompute it from the STORED column — so if the row were stamped with a second
   * clock reading, the `next_check_at` written here and the wake candidate computed from the same
   * row on the next pass would disagree. S5 allows exactly one clock reading per decision.
   */
  firstSeenAt: string;
  /** Computed by BL5 from `firstSeenAt` / the epoch / the condition's own recovery instant. */
  nextCheckAt: string;
  detail: Record<string, unknown>;
}

/** §11.3: the condition is still true and already open. Only the two display columns move. */
export interface PlannedBlockerTouch {
  blockerId: string;
  dedupeKey: string;
  /** Recomputed from CURRENT facts and overwritten (§11.3), so a changed condition is visible. */
  conditionVersion: string;
  /** `evaluation.epoch` — the instant this decision READ the world, which is what "last seen"
   *  means. One clock reading per decision (S5). */
  lastSeenAt: string;
  nextCheckAt: string;
  detail: Record<string, unknown>;
}

export interface PlannedBlockerClear {
  blockerId: string;
  dedupeKey: string;
  kind: ProjectBlockerKind;
  lifecycleGeneration: string;
}

export interface PlannedBlockerEscalation {
  blockerId: string;
  dedupeKey: string;
  kind: ProjectBlockerKind;
  /** ES3: always USER, whatever the default owner was. */
  owner: 'USER';
  dueAt: string;
}

export interface ProjectBlockerPlan {
  raises: PlannedBlockerRaise[];
  touches: PlannedBlockerTouch[];
  clears: PlannedBlockerClear[];
  escalations: PlannedBlockerEscalation[];
  /**
   * The open set as it will be once this pass commits — what §4.2's guards 2 and 3 read and what
   * §10.4's candidate table 1 and 2 enumerate. Raises appear here with the fields they will be
   * written with; cleared rows do not appear at all.
   */
  openAfter: ProjectBlockerProjection[];
}

/** An open blocker as the rest of this pass sees it, whether it was already open or is being
 *  opened right now. A raise has no id yet, which is exactly why the wake candidate for a
 *  brand-new blocker keys on its dedupe key (see `project-next-wake.ts`). */
export interface ProjectBlockerProjection {
  id: string | null;
  kind: ProjectBlockerKind;
  owner: ProjectBlockerOwner;
  recovery: ProjectBlockerRecovery;
  dedupeKey: string;
  subjectType: ProjectBlockerSubjectType;
  subjectId: string;
  firstSeenAt: string;
  nextCheckAt: string;
  escalatedAt: string | null;
  requiredAction: string;
  conditionVersion: string;
  lifecycleGeneration: string;
}

export interface ProjectBlockerPlanInput {
  /** §6.1 S5's frozen instant, in epoch SECONDS as `decisionInput` carries it. */
  epoch: number;
  open: readonly ProjectBlockerFact[];
  observed: readonly ObservedBlockerCondition[];
}

/**
 * One snapshot in, one plan out (§11.3 / §11.4 / §11.5).
 *
 * The whole of auto-clear is the set difference on the third line: a condition the recomputation
 * did not observe is gone, so the row it opened is cleared with `resolved_by = AUTO`. BL3 is the
 * reason it is written this way and not as a reaction to a `provider.restored` event — an event is
 * a signal, and a signal that is lost would leave the row open forever.
 */
export function planProjectBlockers(input: ProjectBlockerPlanInput): ProjectBlockerPlan {
  const epochMs = input.epoch * 1_000;
  const observed = new Map<string, ObservedBlockerCondition>();
  for (const condition of input.observed) {
    // A duplicate key inside one pass is the same condition seen twice, not two conditions. First
    // wins, so the plan does not depend on which detector ran first.
    const key = projectBlockerDedupeKey(condition.kind, condition.subjectType, condition.subjectId);
    if (!observed.has(key)) observed.set(key, condition);
  }
  const openByKey = new Map(input.open.map((blocker) => [blocker.dedupeKey, blocker]));

  const raises: PlannedBlockerRaise[] = [];
  const touches: PlannedBlockerTouch[] = [];
  const clears: PlannedBlockerClear[] = [];
  const escalations: PlannedBlockerEscalation[] = [];
  const openAfter: ProjectBlockerProjection[] = [];

  for (const [dedupeKey, condition] of [...observed].sort(byKey)) {
    const policy = PROJECT_BLOCKER_POLICY[condition.kind];
    const conditionVersion = projectBlockerConditionVersion(
      condition.kind, condition.subjectType, condition.subjectId, condition.facts,
    );
    const existing = openByKey.get(dedupeKey);
    if (existing) {
      // §11.3: same key, same open episode. `occurrences` and `last_seen_at` move at the database;
      // `condition_version` is recomputed from what is true NOW and overwritten. Nothing else on
      // the row changes, which is the whole of ES5.
      const nextCheckAt = nextCheckInstant(
        policy, epochMs, Date.parse(existing.firstSeenAt), condition.recoveryAt,
      );
      touches.push({
        blockerId: existing.id,
        dedupeKey,
        conditionVersion,
        lastSeenAt: new Date(epochMs).toISOString(),
        nextCheckAt,
        detail: condition.detail,
      });
      openAfter.push({
        id: existing.id,
        kind: existing.kind,
        owner: existing.owner,
        recovery: existing.recovery,
        dedupeKey,
        subjectType: existing.subjectType,
        subjectId: existing.subjectId,
        firstSeenAt: existing.firstSeenAt,
        nextCheckAt,
        escalatedAt: existing.escalatedAt,
        requiredAction: existing.requiredAction,
        conditionVersion,
        lifecycleGeneration: existing.lifecycleGeneration,
      });
      continue;
    }
    const firstSeenAt = new Date(epochMs).toISOString();
    const nextCheckAt = nextCheckInstant(policy, epochMs, epochMs, condition.recoveryAt);
    raises.push({
      kind: condition.kind,
      owner: policy.owner,
      recovery: policy.recovery,
      severity: policy.severity,
      requiredAction: policy.requiredAction,
      subjectType: condition.subjectType,
      subjectId: condition.subjectId,
      dedupeKey,
      conditionVersion,
      firstSeenAt,
      nextCheckAt,
      detail: condition.detail,
    });
    openAfter.push({
      id: null,
      kind: condition.kind,
      owner: policy.owner,
      recovery: policy.recovery,
      dedupeKey,
      subjectType: condition.subjectType,
      subjectId: condition.subjectId,
      firstSeenAt,
      nextCheckAt,
      escalatedAt: null,
      requiredAction: policy.requiredAction,
      conditionVersion,
      // Assigned by the database on insert (BE1: `MAX + 1` over this key's whole history). The
      // plan cannot know it, and a plan that guessed would be wrong under concurrency.
      lifecycleGeneration: '0',
    });
  }

  const known = new Set<string>(PROJECT_BLOCKER_KINDS);
  for (const blocker of [...input.open].sort((a, b) => compare(a.dedupeKey, b.dedupeKey))) {
    if (observed.has(blocker.dedupeKey)) continue;
    // BL3 auto-clear is "the recomputation no longer holds this condition", and a kind this binary
    // has never heard of is one it did not RECOMPUTE — silence about it is ignorance, not absence.
    //
    // This is the mixed-version half of adding a kind, and it is the half that only the OLDER
    // replica can perform. A newer one raises `AGGREGATE_PARENT_UNSATISFIABLE`; an older one, with
    // no detector for it, sees an open row its condition list does not mention and resolves it as
    // AUTO — deleting a row a person was being asked to act on, and then watching the new replica
    // open it again one generation later. Neither end can coordinate the other, so the rule has to
    // be one every version can apply to every version's kinds: leave alone what you cannot judge.
    //
    // It also keeps `openAfter` honest for the guards downstream (§4.2 2/3, §11 BL1): a row this
    // build cannot evaluate still STOPS what it says it stops.
    if (!known.has(blocker.kind)) {
      openAfter.push({
        id: blocker.id,
        kind: blocker.kind,
        owner: blocker.owner,
        recovery: blocker.recovery,
        dedupeKey: blocker.dedupeKey,
        subjectType: blocker.subjectType,
        subjectId: blocker.subjectId,
        firstSeenAt: blocker.firstSeenAt,
        nextCheckAt: blocker.nextCheckAt,
        escalatedAt: blocker.escalatedAt,
        requiredAction: blocker.requiredAction,
        conditionVersion: blocker.conditionVersion,
        lifecycleGeneration: blocker.lifecycleGeneration,
      });
      continue;
    }
    clears.push({
      blockerId: blocker.id,
      dedupeKey: blocker.dedupeKey,
      kind: blocker.kind,
      lifecycleGeneration: blocker.lifecycleGeneration,
    });
  }

  // ES4: the ONLY trigger is how long this row has been alive. Not how often it was delivered, not
  // how many attempts were made — those change with redelivery, and an owner that changes with
  // redelivery is a notification that fires because a queue retried.
  for (const projection of openAfter) {
    if (projection.escalatedAt) continue;
    // A kind this build does not know has no threshold here either, and inventing one would let an
    // older replica escalate a row it cannot even evaluate — ES1's "the row's own policy decides"
    // read the only way a mixed fleet can read it.
    if (!known.has(projection.kind)) continue;
    // A row this pass is OPENING cannot also be escalated by it: its `first_seen_at` is this very
    // epoch and every threshold is positive, so the arithmetic below already excludes it. Skipping
    // it explicitly is what keeps that an invariant rather than a coincidence — an escalation with
    // no row id has nothing to compare-and-set against.
    if (!projection.id) continue;
    const dueAt = Date.parse(projection.firstSeenAt)
      + PROJECT_BLOCKER_POLICY[projection.kind].escalateMs;
    if (epochMs < dueAt) continue;
    escalations.push({
      blockerId: projection.id,
      dedupeKey: projection.dedupeKey,
      kind: projection.kind,
      owner: 'USER',
      dueAt: new Date(dueAt).toISOString(),
    });
    // ES3: one step, always to USER, whatever the default owner was — the SYSTEM → COORDINATOR
    // rung changed nothing observable and only suggested that it did (`PC-CX-12`). ES1: `recovery`
    // is untouched, so a `BUDGET_EXHAUSTED` escalated to a person still clears itself when the
    // window rolls.
    projection.owner = 'USER';
    projection.escalatedAt = new Date(epochMs).toISOString();
  }

  return { raises, touches, clears, escalations, openAfter };
}

/**
 * §4.2 guards 2 and 3, and the I4a / I4b pair they are quantified by.
 *
 * A non-USER blocker masked by a USER one is still open: it keeps being recomputed (§11.4) and it
 * keeps contributing wake candidates (§10.4 N-mask). It just does not decide the state.
 */
export function blockerRunState(
  open: readonly Pick<ProjectBlockerProjection, 'owner'>[],
): 'AWAITING_HUMAN' | 'BLOCKED' | null {
  if (open.some((blocker) => blocker.owner === 'USER')) return 'AWAITING_HUMAN';
  if (open.length > 0) return 'BLOCKED';
  return null;
}

/**
 * BL5, the one place `next_check_at` is decided:
 *
 *   `TIME`  — the recovery instant itself (the budget window boundary). A committed fact.
 *   `EVENT` — a recompute poll from the frozen epoch. The event path is the normal one; this is
 *             what makes a lost event cost minutes instead of forever.
 *   `HUMAN` — the escalation alarm, `first_seen_at + escalateMs`, and NOT a recovery poll. Once it
 *             has fired, §10.4 clause 2 stops selecting this row and the project may legitimately
 *             stop its own clock (N-null).
 */
function nextCheckInstant(
  policy: ProjectBlockerPolicy,
  epochMs: number,
  firstSeenMs: number,
  recoveryAt: string | undefined,
): string {
  if (policy.recovery === 'TIME') {
    const at = recoveryAt ? Date.parse(recoveryAt) : NaN;
    // A TIME blocker whose detector could not name its recovery instant would otherwise get no
    // clock at all. Falling back to the escalation alarm keeps it wakeable and visible.
    if (Number.isFinite(at)) return new Date(at).toISOString();
    return new Date(firstSeenMs + policy.escalateMs).toISOString();
  }
  if (policy.recovery === 'EVENT') {
    return new Date(epochMs + (policy.pollMs ?? PROJECT_BLOCKER_DEFAULT_ESCALATION_MS)).toISOString();
  }
  return new Date(firstSeenMs + policy.escalateMs).toISOString();
}

function byKey(a: [string, unknown], b: [string, unknown]): number {
  return compare(a[0], b[0]);
}

/** Byte order, never a database collation — the same reason §10.4 W5 spells out `COLLATE "C"`. */
export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => compare(a, b))
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}
