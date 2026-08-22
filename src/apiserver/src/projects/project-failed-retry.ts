/**
 * §7.4 precondition 1 for the state a real failure actually leaves behind — one definition of
 * "can the control loop still move this task by itself", read by everything that asks.
 *
 * Why this file exists (`PC-CX-64`)
 * ---------------------------------
 * §9.5 Q3's middle rows — inside the backoff, backoff expired, dispatch again — describe a retry
 * ladder that §7.4's first precondition made unreachable: a genuine failed run lands the task at
 * `FAILED` (runner-api and the reaper both call `reclaimStalledTask(..., FAILED)`), and every gate
 * answered `TASK_NOT_OPEN` for anything that is not `OPEN`. Q3-d wrote that consequence down in
 * v1.17 and left the cell empty on purpose; `TASK_FAILURE` filled it with a turn, which tells a
 * person's coordinator about a failure the loop had a mechanical answer for. v1.18 gives the answer
 * back to the loop: **a `FAILED` task below its attempt cap, with attributable failures and an
 * expired backoff, is dispatchable** — the same ladder §9.5 always described, on the status the
 * failure really produces.
 *
 * Why one function instead of a predicate in each caller
 * -----------------------------------------------------
 * Four gates ask this question and they must not be able to disagree:
 *
 *  - §7.8's pass (`selectDispatchableTasks`) — is this a candidate at all;
 *  - §9.2's authorization (`authorizeTaskState`) — may the candidate be admitted;
 *  - §7.2 TU2's turn predicate (`failureEpisodes`) — the loop's own two-state table, whose whole
 *    judgement is "还能不能动它". A retryable failure that ALSO woke the coordinator would be the
 *    foreman shape TU2 exists to prevent, and an unretryable one that did NOT is the silence
 *    `PC-CX-63` closed;
 *  - §11.4's detectors (`project-blocker-conditions`) — which terminal cell opens which row.
 *
 * Split across four call sites, the first divergence would be silent in exactly the way the two
 * defects above were: each gate individually correct, the composition doing nothing.
 *
 * The order of the arms is the frozen one
 * ---------------------------------------
 * `UNATTRIBUTABLE` is asked before `ATTEMPTS_EXHAUSTED` because §9.2's `classifyPolicyRow` already
 * resolves that overlap the same way (both land on `DISPATCH_MAX_ATTEMPTS`; the reason code is
 * `UNKNOWN_FAILURE` when nothing attributed the failure). Two answers for one world would put the
 * blocker's kind and the authorization's reason code in disagreement about the same task.
 */

import { MAX_AUTO_RUN_FAILURES } from '../tasks/task-retry-policy';
import type { TaskRetirement } from '../tasks/task-supersession';

/**
 * What a `FAILED` task is to the control loop. Closed set, and every arm names a different owner:
 * the loop itself, its clock, or a person.
 */
export type FailedTaskDisposition =
  /** Not a failure the loop has to answer for: the task is `OPEN`, running, or settled. */
  | 'NOT_FAILED'
  /**
   * §13.6 SU6: this attempt was replaced or abandoned. It is a historical failure, not a current
   * one — nothing here is the loop's to move, retry, blocker or turn, and the successor (where
   * there is one) carries the work. Asked BEFORE `OCCUPIED` on purpose: a retirement is a stated
   * fact about the attempt, while a live session is a passing property of it, and letting the
   * session decide would flip a retired task's disposition back and forth as runs start and end —
   * which moves TF6's episode identity and mints a second permanent turn key for one dead task.
   */
  | 'RETIRED'
  /** `FAILED` on the row, but a Session is still on it — §7.4 precondition 4 owns this task. */
  | 'OCCUPIED'
  /** §9.5 Q3 row 3: below the cap, attributable, backoff expired. The loop dispatches it. */
  | 'RETRY_DUE'
  /** §9.5 Q3 row 2: below the cap, but the retry instant has not arrived. A wake, not a blocker. */
  | 'RETRY_BACKOFF'
  /** Failures nothing attributed. §9.2 answers `UNKNOWN_FAILURE`; §11.2's fallback row opens. */
  | 'UNATTRIBUTABLE'
  /** §9.5 Q3's last row: the automatic budget is spent. `TEST_FAILED`, owned by a person. */
  | 'ATTEMPTS_EXHAUSTED';

/**
 * The facts this judgement is made of, spelled so both shapes that carry them fit without a
 * translation layer: §6.1's `world.tasks[]` + `evaluation.dueTasks[]` (the pass and the turn
 * predicate) and §9.2's `ProjectActionAuthorizationInput['task']` (the commit-point adapter).
 *
 * `retryBackoffExpired` is a fact and not a clock read on purpose (S5): the snapshot answers it
 * once, so a replay of one decision reaches one conclusion.
 */
export interface FailedTaskFacts {
  status: string;
  hasLiveSession: boolean;
  failureCount: number;
  /** §6.1: `failures.every(f => f.error)` — vacuously true at zero failures, hence the guard. */
  failureAttributable: boolean;
  retryBackoffExpired: boolean;
  /** §9.5's cap. Defaulted rather than required so a caller cannot quietly install a second one. */
  maxAutoRunFailures?: number;
  /**
   * §13.6 SU6's answer for this task, or null when nothing has retired it. Optional so a snapshot
   * captured before this field existed replays to what it originally produced: absent reads as
   * "not retired", which is what every one of those rows was.
   */
  retirement?: TaskRetirement | null;
  /**
   * §13.6 SU6's derived half: the retirement of the task this one VERIFIES, when it verifies one.
   *
   * Here rather than only at the pass, because this function is the single judgement four gates
   * read: a FAILED check whose subject was replaced would otherwise be classified by its BUDGET —
   * `ATTEMPTS_EXHAUSTED`, a `TEST_FAILED` blocker and a turn — for failures that are no longer
   * about anything. Obsolete is not a kind of failure; it is the absence of a question.
   */
  subjectRetirement?: TaskRetirement | null;
}

/**
 * §11.2's terminal row for one task's failure HISTORY, or none — and the single place a blocker
 * kind is chosen for a failure (v1.18, `PC-CX-64`).
 *
 * The two rows overlap, and the overlap is reachable
 * --------------------------------------------------
 * `failureCount >= MAX` (§9.5 Q3's last row → `TEST_FAILED`) and "no failed run recorded an error"
 * (§9.2's `UNKNOWN_FAILURE`) are both properties of the same run history, and a task can hold both
 * at once — five runs that all died without saying why. §11.3's dedupe key is
 * `kind:subjectType:subjectId`, so two detectors reading the raw facts do NOT collapse into one
 * row: they open TWO, with two owners' worth of contradictory required action ("look at why it
 * keeps failing" beside "read the detail and clear it"), each with its own lifecycle, escalation
 * clock and `nextCheckAt`. Clearing either leaves the other holding the task. Nothing downstream
 * could tell you which one was the answer, because both were.
 *
 * So the precedence is frozen HERE, once, and both detectors ask this function instead of the
 * facts. `UNKNOWN_FAILURE` wins, for a reason that predates this unit: §9.2's `classifyPolicyRow`
 * has resolved the same overlap the same way since v1 (both land on `DISPATCH_MAX_ATTEMPTS`; the
 * reason code is `UNKNOWN_FAILURE` when nothing attributed the failure), and a §11 row that
 * contradicted §9.2's refusal code about one task would put the two halves of "why is this not
 * running" in disagreement. BL2 says the same thing from the other side: an unclassified failure
 * must be NAMED unclassified, and "it has failed five times" is not that name.
 *
 * Keyed on the run history and not on `status`, because that is what §9.5 Q3 measures: an `OPEN`
 * task that burned its budget has opened `TEST_FAILED` since v1.1 and still does.
 */
export function failedTaskBlockerKind(
  task: Pick<FailedTaskFacts, 'failureCount' | 'failureAttributable' | 'maxAutoRunFailures'>,
): 'UNKNOWN_FAILURE' | 'TEST_FAILED' | null {
  // The `> 0` guard is load-bearing: `every` over an empty list is true, so a task with no counted
  // failure at all would otherwise read as attributable-by-vacuity — which it is.
  if (task.failureCount > 0 && !task.failureAttributable) return 'UNKNOWN_FAILURE';
  if (task.failureCount >= (task.maxAutoRunFailures ?? MAX_AUTO_RUN_FAILURES)) return 'TEST_FAILED';
  return null;
}

export function failedTaskDisposition(task: FailedTaskFacts): FailedTaskDisposition {
  if (task.status !== 'FAILED') return 'NOT_FAILED';
  // §13.6 SU6, first — both halves. See the `RETIRED` arm for why it outranks even `OCCUPIED`, and
  // `subjectRetirement` for why a check of replaced work is retired even when it is healthy.
  if (task.retirement != null || task.subjectRetirement != null) return 'RETIRED';
  // §7.4 precondition 4 and §4.2 guard 5 in one line: somebody is on it, and the failure being
  // asked about is not settled yet.
  if (task.hasLiveSession) return 'OCCUPIED';
  // The same precedence expression the blocker detectors read, evaluated once. A disposition that
  // said `ATTEMPTS_EXHAUSTED` while §11 opened `UNKNOWN_FAILURE` for the same task would be the
  // overlap moved rather than closed.
  const terminal = failedTaskBlockerKind(task);
  if (terminal === 'UNKNOWN_FAILURE') return 'UNATTRIBUTABLE';
  if (terminal === 'TEST_FAILED') return 'ATTEMPTS_EXHAUSTED';
  // A `FAILED` task with zero COUNTED failures is deliberately retryable: §6.1 excludes runs killed
  // by an exhausted provider quota from the budget, and `autoRunHoldOff` gives the same exemption
  // the same reason — one quota outage must not leave a task permanently un-runnable.
  //
  // It is also not inside any backoff, whatever a caller passes: §9.5's `retryBackoffUntil(0, …)`
  // is null, so "no counted failure" and "a retry instant to wait for" cannot both be true of one
  // world. §9.2's own backoff clause has carried the same `failureCount > 0` guard since v1, and
  // the property test over the whole input space is what noticed that this line did not.
  if (task.failureCount === 0) return 'RETRY_DUE';
  return task.retryBackoffExpired ? 'RETRY_DUE' : 'RETRY_BACKOFF';
}

/**
 * §7.2 TU2's two-state table, as one predicate: is this failure still the loop's to move?
 *
 * True for `RETRY_DUE` and `RETRY_BACKOFF` — the loop dispatches, or has scheduled the instant it
 * will. Both are v1.1's original "不得开 turn" case, restored to the status a real failure produces.
 * False for the two terminal arms, which is `PC-CX-63`'s "不开 turn 不是克制，是静默" —— and false
 * for `OCCUPIED`, where the answer is neither a turn nor a dispatch but waiting for the run, and
 * for `RETIRED`, where there is no answer to give because this attempt is not the live one.
 */
export function loopCanRetryFailedTask(disposition: FailedTaskDisposition): boolean {
  return disposition === 'RETRY_DUE' || disposition === 'RETRY_BACKOFF';
}

/**
 * The two arms nothing mechanical can advance: a person has to look. §11.2 gives each of them a
 * row, and §7.2 TU2 gives the pair a turn.
 *
 * `RETIRED` is deliberately not one of them, and that is the whole point of the arm: a replaced
 * attempt asks nothing of anybody. Calling somebody to a failure that has already been re-done is
 * the foreman shape TU2 exists to prevent, arriving through the one door TU2 opened.
 */
export function failedTaskNeedsAttention(disposition: FailedTaskDisposition): boolean {
  return disposition === 'UNATTRIBUTABLE' || disposition === 'ATTEMPTS_EXHAUSTED';
}
