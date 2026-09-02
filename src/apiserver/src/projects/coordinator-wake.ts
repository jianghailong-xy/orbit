import { createHash } from 'node:crypto';

import { AttemptBudgetDimension } from './attempt-budget';
import { canonicalJson, compare } from './canonical-json';

/**
 * What wakes a project coordinator, and what makes one waking of it the same as another.
 *
 * §0 — A WAKE IS A COMMITTED FACT; A CLOCK MAY ONLY RE-DELIVER IT
 * =================================================================
 * The control loop this replaces woke on a timer, and a timer asks "is there anything to think
 * about?" — a question with no answer that ends the asking. `COORDINATOR_NO_PROGRESS` is what that
 * costs: the loop raised a blocker because it had made no progress, the blocker was a fact, the
 * fact justified the next wake, and the next wake made no progress either. A clock therefore may
 * not CREATE, DECIDE or RESOLVE a wake. It may re-observe, lease and re-deliver an already
 * committed immutable fact; stale completion ACK is exactly the case where delivery liveness
 * requires that independent clock. A wake is still DERIVED only from committed rows: a session
 * that ended, a budget that was spent, a task set that settled, or an ACK failure observation.
 *
 * Every reducer here is pure: no clock, no database, no session, for the reason
 * `attempt-budget.ts` and `convergence-progress.ts` are pure — a decision that can be replayed
 * byte for byte is a decision that can be argued about after the fact.
 *
 * §1 — THE KEY IS (EVENT, SUBJECT, SUBJECT VERSION)
 * ================================================
 * `wakeIdempotencyKey` is a total function of the fact and of nothing else. In particular it is
 * not a function of who is allowed to act on the fact: `CoordinatorWakeService.claim` computes it
 * and claims it BEFORE it asks whether the wake is authorized, because a key computed after an
 * authorization branch makes the winner of a race depend on the answer to a question that has
 * nothing to do with identity. (2026-08-23, `TasksService.create`: the gate ran first, a rotation
 * moved the scope, and the retry of an already-committed write could never read its own row back.)
 *
 * §2 — CHOOSING THE SUBJECT VERSION
 * =================================
 * The version has to move when the fact genuinely happens AGAIN, and stand still when anything
 * else is written. `task.updated_at` fails the second half — every unrelated PATCH pushes it, so
 * a wake keyed on it fires on a renamed title. The three candidates that were considered, and
 * what each one is actually for:
 *
 *   * `task.dispatch_attempt` — "Every first observation of a Coordinator dispatch OUTCOME
 *     advances it". Nothing advances it today (the observer was removed with the control loop), so
 *     every attempt on a task would derive version `0` and only the first attempt of that task
 *     could ever wake anybody. Rejected: a version that does not move is a fact that happens once.
 *   * `task.attempt_generation` — moves only for a task under convergence management (one with a
 *     `TaskScopeRevision` row) and is written by `[K3]`'s ledger, not by the dispatch path. Same
 *     failure, over a narrower set of tasks. Rejected.
 *   * `project.config_revision` — "Bumped by exactly one on every write to the four fields above —
 *     the authorization set." It moves when a person changes `maxConcurrentTasks`; it does not
 *     move when a task settles. As a version for a task-set fact it is a constant. Rejected.
 *
 * What IS available, per fact:
 *
 *   * The two attempt facts take **the session id of the attempt**. An attempt is one Session
 *     (`[K3]` §1), the id is a v7 uuid — monotone, allocated once, and immutable for the life of
 *     the row — and it is not moved by anything, because a primary key cannot be moved at all. Two
 *     attempts on one task are two ids and therefore two facts; one attempt's end redelivered ten
 *     times is one id and therefore one fact. That is exactly the identity wanted.
 *   * The two project-scoped facts have no such column: nothing in the schema versions "this
 *     project's task set is now settled". So they take a DIGEST of the rows the fact is defined
 *     over — `(taskId, status)` and nothing else (`settlementVersion`). That is the shape
 *     `project_blocker` already uses for `condition_version` ("a digest of the snapshot FACTS that
 *     produced this row"), and it is NOT the anti-pattern `attempt-budget.ts` warns about: that
 *     one hashes the whole world a decision was made from, so an unrelated column moves it.
 *     Hashing exactly the closed projection the event is defined over cannot be moved by an
 *     unrelated write, because no unrelated column is in it.
 *
 *     The price is stated rather than hidden: a digest is not monotone, so a project that settles,
 *     reopens a task and settles again to a BYTE-IDENTICAL task set derives the key it already
 *     used and does not wake a second time. That is the intended reading. Waking a coordinator to
 *     judge a world it has already judged, with nothing whatsoever changed, is the self-referential
 *     loop §0 exists to remove.
 */

/** The closed set of facts that may wake a coordinator. */
export const COORDINATOR_WAKE_EVENTS = [
  /** A task's bounded work attempt/turn ended and the task did not reach a settled status. */
  'ATTEMPT_ENDED_UNSETTLED',
  /** One attempt spent one of its six budget dimensions (`[K3]` §5). Produced by unit T5. */
  'ATTEMPT_BUDGET_SPENT',
  /** Every task filed under a project reached a terminal status. */
  'PROJECT_TASKS_SETTLED',
  /** The last task serving one acceptance criterion reached DONE. */
  'CRITERION_READY',
  /** N10 appended a new immutable completion-evidence revision. */
  'COMPLETION_EVIDENCE_REVISED',
  /** A terminal result is durable but the control plane has not committed its completion ACK. */
  'COMPLETION_ACK_STALE',
] as const;

export type CoordinatorWakeEvent = (typeof COORDINATOR_WAKE_EVENTS)[number];

/**
 * Spellings the database still accepts and this unit no longer writes.
 *
 * `project_coordinator_wake` is an event log. When migration 0224 deleted the human step, the
 * three judgment events lost the word "human" — but rows already written say `HUMAN_SIGNOFF_*`
 * because that is what happened when they were written, and rewriting them would edit the log
 * rather than continue it. Migration 0226 retired a fourth the same way: it deleted the failure
 * continuation machinery outright, so nothing raises `FAILURE_CONTINUATION_ACTIONABLE` any more,
 * but the wakes that were raised are still what happened. So the CHECK accepts all four, this list
 * names the retired half, and `coordinator-wake.spec.ts` requires the union to equal the
 * constraint exactly: an event added to the database without appearing in one of these two lists
 * is still a failure.
 */
export const RETIRED_COORDINATOR_WAKE_EVENTS = [
  'HUMAN_SIGNOFF_REQUESTED',
  'HUMAN_SIGNOFF_DECIDED',
  'HUMAN_SIGNOFF_REQUEST_SUPERSEDED',
  'FAILURE_CONTINUATION_ACTIONABLE',
  // Retired the same way on 2026-09-02, when the judgment machinery was removed: each of these
  // five was a fact ABOUT a `task_judgment_request`, or about the exit-code result that decided
  // one, and neither the request nor the result exists any more. The wakes already raised are
  // still what happened.
  'EXECUTABLE_RESULT_RECORDED',
  'VERIFICATION_VERDICT_RECORDED',
  'EVIDENCE_JUDGMENT_REQUESTED',
  'EVIDENCE_JUDGMENT_DECIDED',
  'EVIDENCE_JUDGMENT_REQUEST_SUPERSEDED',
] as const;

/**
 * What the fact is about. `CRITERION` has no row of its own — an acceptance criterion is a line of
 * the project's `acceptance_criteria` text, identified by `parseCriteria`'s content key — which is
 * why `subjectId` below is text rather than a uuid, exactly as `project_blocker.subject_id` is.
 */
export type WakeSubjectType = 'TASK' | 'PROJECT' | 'CRITERION' | 'JUDGMENT_REQUEST';

export interface WakeFact {
  event: CoordinatorWakeEvent;
  /** Which project's coordinator this wakes. Not part of the key — see `wakeIdempotencyKey`. */
  projectId: string;
  subjectType: WakeSubjectType;
  subjectId: string;
  subjectVersion: string;
  /**
   * Display and diagnosis, never an input to anything. It is deliberately outside the key, for the
   * reason `project_blocker` BL7 keeps `occurrences` out of one: a key that carries a field
   * nothing decides on is a key that changes when nothing has happened.
   */
  detail?: Record<string, unknown>;
}

/** The identity of the fact, without the parts of it that are only for a reader. */
export type WakeIdentity = Pick<WakeFact, 'event' | 'subjectType' | 'subjectId' | 'subjectVersion'>;

/**
 * Bumped only when the SHAPE of the key changes. In the key rather than beside it, so an old key
 * cannot silently match a new reading of the same fact — the reason `ACCEPTANCE_DIGEST_VERSION`
 * lives inside `acceptanceDigest`'s hash.
 */
export const WAKE_KEY_VERSION = 'cw:v1';

/**
 * §1's key: `cw:v1:<event>:<subjectType>:<subjectId>:<subjectVersion>`.
 *
 * Readable rather than hashed, the way `project_blocker.dedupe_key` is: a key nobody can read is a
 * key nobody can debug, and there is nothing secret in it. The project id is deliberately absent —
 * every subject id is either a uuid or already carries its project (`criterionSubjectId`), so
 * adding it would put a column in the key that cannot change the fact's identity.
 *
 * The signature is the first half of the winner-before-gate rule: this function cannot consult an
 * authorization decision because it is not given one.
 */
export function wakeIdempotencyKey(fact: WakeIdentity): string {
  return [
    WAKE_KEY_VERSION,
    fact.event,
    fact.subjectType,
    fact.subjectId,
    fact.subjectVersion,
  ].join(':');
}

/**
 * Finished, for the purposes of "there is nothing left to run here": the same two statuses
 * `project-graph-fold.ts` folds away, and the same pair `completionPolicy: ALL_CHILDREN_DONE`
 * settles a parent on.
 *
 * FAILED is deliberately NOT among them. A failed task is the single most important thing a
 * coordinator is woken FOR — that is `ATTEMPT_ENDED_UNSETTLED` — so counting it as settled would
 * let a project reach `PROJECT_TASKS_SETTLED` with a broken task in it and send the coordinator to
 * judge acceptance instead of the failure.
 */
export const SETTLED_TASK_STATUSES = ['DONE', 'CANCELLED'] as const;

export function isSettledTaskStatus(status: string): boolean {
  return (SETTLED_TASK_STATUSES as readonly string[]).includes(status);
}

/** One committed task row, reduced to the two columns the project-scoped facts are defined over. */
export interface TaskSettlement {
  taskId: string;
  status: string;
}

/**
 * §2's digest: sha256 over the sorted `(taskId, status)` pairs, and over nothing else.
 *
 * Sorted here rather than by the caller, because the caller is a SQL query whose row order is the
 * planner's business — and two callers reading the same rows in two orders must not derive two
 * versions of one fact. (`acceptanceDigest` sorts for the same reason and says so.)
 */
export function settlementVersion(tasks: readonly TaskSettlement[]): string {
  const pairs = tasks
    .map((task): [string, string] => [task.taskId, task.status])
    .sort((left, right) => compare(left[0], right[0]));
  return createHash('sha256').update(canonicalJson(pairs)).digest('hex');
}

/**
 * A criterion's subject id. The criterion key is `sha256(text).slice(0, 32)` (`parseCriteria`), so
 * two projects that state the same criterion in the same words share it; the project id is what
 * makes this a name for one of them.
 */
export function criterionSubjectId(projectId: string, criterionKey: string): string {
  return `${projectId}:${criterionKey}`;
}

/**
 * `ATTEMPT_ENDED_UNSETTLED` — a task's bounded work attempt/turn is over and the task is not.
 *
 * `null` when the task DID settle, which is the ordinary end of a run and is not a fact anybody
 * has to judge. The decision is made here, from the two committed values, rather than by the
 * caller, so every producer of this fact agrees about what "unsettled" means.
 */
export function attemptEndedUnsettledFact(ended: {
  projectId: string;
  taskId: string;
  taskStatus: string;
  sessionId: string;
  /** Diagnosis only: terminal runs and legacy AWAITING_INPUT parked turns keep one fact shape. */
  sessionStatus?: string;
}): WakeFact | null {
  if (isSettledTaskStatus(ended.taskStatus)) return null;
  return {
    event: 'ATTEMPT_ENDED_UNSETTLED',
    projectId: ended.projectId,
    subjectType: 'TASK',
    subjectId: ended.taskId,
    subjectVersion: ended.sessionId,
    detail: {
      sessionId: ended.sessionId,
      taskStatus: ended.taskStatus,
      ...(ended.sessionStatus ? { sessionStatus: ended.sessionStatus } : {}),
    },
  };
}

/**
 * `ATTEMPT_BUDGET_SPENT` — one attempt reached one of `ATTEMPT_BUDGET_DIMENSIONS`.
 *
 * Keyed on the attempt and NOT on the dimension: an attempt that crosses two lines in one moment
 * has spent its budget once, and `evaluateAttemptBudget` already decides which dimension is
 * reported. Putting the dimension in the key would make the same exhausted attempt wake the
 * coordinator once per line it crossed. It rides in `detail`, where the reader wants it.
 *
 * Unit T5 is what produces this; the type, the key and this derivation are here so that when it
 * does, it does not invent a second spelling of the same fact.
 */
export function attemptBudgetSpentFact(spent: {
  projectId: string;
  taskId: string;
  sessionId: string;
  /** `[K3]` §1's closed set, taken from the module that owns it so T5 cannot invent a seventh. */
  dimension: AttemptBudgetDimension;
}): WakeFact {
  return {
    event: 'ATTEMPT_BUDGET_SPENT',
    projectId: spent.projectId,
    subjectType: 'TASK',
    subjectId: spent.taskId,
    subjectVersion: spent.sessionId,
    detail: { sessionId: spent.sessionId, dimension: spent.dimension },
  };
}

/**
 * `PROJECT_TASKS_SETTLED` — every task filed under the project reached a terminal status.
 *
 * `null` when one has not, and `null` for a project with no tasks at all: an empty project has not
 * finished its work, it has not been given any, and waking a coordinator to judge the acceptance
 * of nothing is the emptiest possible version of §0's loop.
 */
export function projectTasksSettledFact(
  projectId: string,
  tasks: readonly TaskSettlement[],
): WakeFact | null {
  if (tasks.length === 0) return null;
  if (!tasks.every((task) => isSettledTaskStatus(task.status))) return null;
  return {
    event: 'PROJECT_TASKS_SETTLED',
    projectId,
    subjectType: 'PROJECT',
    subjectId: projectId,
    subjectVersion: settlementVersion(tasks),
    detail: { taskCount: tasks.length },
  };
}

/**
 * `CRITERION_READY` — the last task serving one acceptance criterion reached DONE.
 *
 * DONE, not settled: a cancelled task serves no criterion, and a criterion whose work was
 * abandoned is not ready to be judged. That is a deliberately different predicate from
 * `projectTasksSettledFact`'s, because the two events ask different questions — "is there anything
 * left running" against "is this claim now backed".
 *
 * `serving` is a parameter rather than a query because the edge does not exist yet: nothing today
 * records which tasks serve which criterion (`project_acceptance_criterion.evidence_task_id` is
 * written by a run that has already concluded, which is after the fact this event is about). Unit
 * T6 introduces it — it refuses a coordinator-opened task that does not name the criterion it
 * serves — and the producer of this event is one query away once it lands. See
 * `coordinator-wake.spec.ts` for the derivation's own tests.
 */
export function criterionReadyFact(
  projectId: string,
  criterionKey: string,
  serving: readonly TaskSettlement[],
): WakeFact | null {
  if (serving.length === 0) return null;
  if (!serving.every((task) => task.status === 'DONE')) return null;
  return {
    event: 'CRITERION_READY',
    projectId,
    subjectType: 'CRITERION',
    subjectId: criterionSubjectId(projectId, criterionKey),
    subjectVersion: settlementVersion(serving),
    detail: { criterionKey, taskCount: serving.length },
  };
}
