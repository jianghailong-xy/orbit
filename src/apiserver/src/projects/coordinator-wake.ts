import { createHash } from 'node:crypto';

import { AttemptBudgetDimension } from './attempt-budget';
import { canonicalJson, compare } from './canonical-json';
import type { CriterionLanding } from './project-criterion-landing';

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
 *   * The project-scoped facts have no such column: nothing in the schema versions "this project's
 *     task set is now settled". So they take a DIGEST of the rows the fact is defined over —
 *     `(taskId, status)` and nothing else for the two cut on the task set alone
 *     (`settlementVersion`), and those pairs TOGETHER with each criterion's `(key, satisfied,
 *     landing)` for the one that is also a claim about the criteria (`acceptanceLandingVersion`).
 *     That is the shape `project_blocker` already uses for `condition_version` ("a digest of the
 *     snapshot FACTS that produced this row"), and it is NOT the anti-pattern `attempt-budget.ts`
 *     warns about: that one hashes the whole world a decision was made from, so an unrelated
 *     column moves it. Hashing exactly the closed projection the event is defined over cannot be
 *     moved by an unrelated write, because no unrelated column is in it — which is a rule about
 *     matching the digest to the FACT, not a licence to hash one projection for every event.
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
  /** That, AND every criterion the project states is satisfied with its work on the branch. */
  'PROJECT_ACCEPTANCE_LANDED',
  /** The last task serving one acceptance criterion reached DONE. */
  'CRITERION_READY',
  /** A criterion's work is finished and no merge receipt puts it on the default branch. */
  'CRITERION_UNLANDED',
  /** N10 appended a new immutable completion-evidence revision. */
  'COMPLETION_EVIDENCE_REVISED',
  /** A terminal result is durable but the control plane has not committed its completion ACK. */
  'COMPLETION_ACK_STALE',
  /** A loosening edit to this project's acceptance criteria is held, waiting on the owner. */
  'CRITERIA_DECISION_PENDING',
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
 * The closed set of ends one delivery of a fact can reach, and the one state that is not an end.
 *
 * Held here beside the events, and by a CHECK in the migration, for the reason the events are: the
 * values are frozen in a TypeScript module, and a second spelling of them is a second place to
 * drift. `coordinator-wake.spec.ts` requires this list to equal the constraint exactly, so a
 * status that reaches the database without appearing here is a failure rather than a surprise.
 *
 * Only `CLAIMED` is not terminal. Of the four that are, three are successes that go on holding the
 * fact's idempotency key (0174's index excludes `REFUSED` and nothing else), and they differ in
 * WHAT the fact was spent on — which is the question a reader of this ledger is asking:
 *
 *   * `SESSION_OPENED` — a new judgment session was created for it (`coordinator-judgment.service`).
 *   * `DELIVERED`      — it was handed to the project's standing coordinator conversation, which
 *     already existed (`coordinator-delivery.service`). No session row is created.
 *   * `CONSUMED`       — recorded against a named non-session consumer, and nothing more.
 *
 * `REFUSED` is the one that is not a success: it releases the key so the same fact may be
 * delivered again, and keeps the code it was refused with so that "it silently did nothing" is not
 * a state this table can be in.
 */
export const COORDINATOR_WAKE_STATUSES = [
  'CLAIMED',
  'SESSION_OPENED',
  'DELIVERED',
  'CONSUMED',
  'REFUSED',
] as const;

export type CoordinatorWakeStatus = (typeof COORDINATOR_WAKE_STATUSES)[number];

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
 * A criterion's subject id. The key used to be a hash of the criterion's WORDS, so two projects
 * stating the same condition in the same words shared one, and the project id in front was what
 * made this a name for one of them. Since the key became the criterion's own id
 * (`criterionKeyOf`) it names a single row by itself; the prefix stays because this string is a
 * persisted wake SUBJECT, and re-spelling one of those is a migration rather than a comment.
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
 * One stated criterion as the two project-scoped facts REPORT it.
 *
 * In `PROJECT_TASKS_SETTLED`'s `detail` it is display and diagnosis like every other `detail`, and
 * it must not become part of THAT fact's identity: the version that event is keyed on is the task
 * settlement, so a criterion whose landing arrives later is the SAME settled project rather than a
 * second one. What the roster is for there is the message — a question about "these N conditions"
 * that does not carry them is a question nobody can answer — and the wake row a reader later opens
 * to find out which of them was missing.
 *
 * `PROJECT_ACCEPTANCE_LANDED` is the fact this roster is a CLAIM in rather than a note beside one,
 * so `acceptanceLandingVersion` hashes it. The two readings do not conflict: one event is about a
 * task set and mentions the criteria, the other is about the criteria and cannot be stated without
 * them.
 *
 * `satisfied` is a boolean rather than a coverage word because it is the only value the reader is
 * shown; which of the three coverages produced it belongs to the unit that decided it.
 */
export interface SettledCriterionReport {
  /** The criterion's stable key, as `project_get` spells it. */
  key: string;
  /** The condition itself. */
  text: string;
  /** Every task serving it is DONE, and at least one does. */
  satisfied: boolean;
  landing: CriterionLanding;
  /** The work that serves it, named so the reader can see what the claim rests on. */
  serving: ReadonlyArray<{ taskId: string; title: string; status: string }>;
}

/**
 * `PROJECT_TASKS_SETTLED` — every task filed under the project reached a terminal status.
 *
 * `null` when one has not, and `null` for a project with no tasks at all: an empty project has not
 * finished its work, it has not been given any, and waking a coordinator to judge the acceptance
 * of nothing is the emptiest possible version of §0's loop.
 *
 * `criteria` defaults to empty because it is display only: a caller with nothing to say about the
 * project's stated conditions still derives exactly the same fact, with exactly the same key.
 */
export function projectTasksSettledFact(
  projectId: string,
  tasks: readonly TaskSettlement[],
  criteria: readonly SettledCriterionReport[] = [],
): WakeFact | null {
  if (tasks.length === 0) return null;
  if (!tasks.every((task) => isSettledTaskStatus(task.status))) return null;
  return {
    event: 'PROJECT_TASKS_SETTLED',
    projectId,
    subjectType: 'PROJECT',
    subjectId: projectId,
    subjectVersion: settlementVersion(tasks),
    detail: { taskCount: tasks.length, criteria },
  };
}

/**
 * §2's digest for the fact below: the settled task set AND what every stated criterion reports.
 *
 * Two independently moving projections in one version, which §2 permits for exactly the reason it
 * permits `settlementVersion`: both are inside the closed projection the event is defined over,
 * and no column outside it is hashed. `PROJECT_ACCEPTANCE_LANDED` is a claim about a task set AND
 * about a criteria roster, so a version naming only one of them would stand still while the other
 * moved — which is the whole of the defect this fact exists to repair.
 *
 * `satisfied` and `landing` are constant TODAY, because the predicate below admits the fact only
 * when every criterion reports `true` and `LANDED`. They are hashed anyway, and that is not
 * decoration: a predicate later loosened to admit some other combination must not be able to
 * derive a key an earlier, stricter reading already spent. The criterion KEY is what does the work
 * in the meantime — a ruler that gains or loses a condition is a different question to ask.
 *
 * A criterion whose WORDS were rewritten under the same key is deliberately not in here. That
 * changes which ruler a confirmation is about rather than whether this fact holds, and
 * `standardSetVersion` / `criteriaSemanticRevision` already answer it where it is asked: the
 * project's confirmation read reports "confirmed, about criteria that have since been rewritten"
 * as its own state. Folding it in here would raise this fact again for an edit that changed
 * nothing about where the work is.
 */
export function acceptanceLandingVersion(
  tasks: readonly TaskSettlement[],
  criteria: readonly SettledCriterionReport[],
): string {
  const landings = criteria
    .map((criterion): [string, boolean, CriterionLanding] =>
      [criterion.key, criterion.satisfied, criterion.landing])
    // Sorted here for `settlementVersion`'s reason: the roster arrives in a query's row order, and
    // two readers of the same rows must not derive two versions of one fact.
    .sort((left, right) => compare(left[0], right[0]));
  return createHash('sha256')
    .update(canonicalJson([settlementVersion(tasks), landings]))
    .digest('hex');
}

/**
 * `PROJECT_ACCEPTANCE_LANDED` — every task is terminal AND every stated criterion is satisfied
 * with its work on the default branch.
 *
 * WHY THIS IS AN EVENT AND NOT A BRANCH OF `PROJECT_TASKS_SETTLED`
 * ===============================================================
 * It was a branch, for one commit, and the branch could not deliver. `PROJECT_TASKS_SETTLED` is
 * keyed on `settlementVersion` — the task set and nothing else — which is right for what that
 * event says. But merge receipts are written by paths the task write path does not touch, and the
 * order they actually arrive in is: the last task settles while the work is still on a branch, the
 * fact is derived and SPENT on a judgment session, and the receipt lands afterwards with no task
 * write anywhere near it. The roster has flipped; the task set has not moved a byte; the key is
 * the one already spent. The card could then never be sent — not "later", never — until some
 * unrelated task write happened to move the digest.
 *
 * `criterionUnlandedFact` below has the sentence this is the other half of: "When the receipts
 * complete, the answer stops being this fact at all." What it stops being is that one. What it
 * starts being is this one, and that is a second FACT rather than a second version of the first,
 * which is the distinction that paragraph draws when it refuses to fold receipts into
 * `settlementVersion`: doing so would make PARTIAL landing a second fact about one unfinished
 * situation. This event admits no partial state. Every criterion satisfied and landed, or nothing
 * — so a project on its way to landing derives it zero times, and the moment it arrives it derives
 * a key nothing has ever claimed. No key is spent early, because there is nothing to spend until
 * the answer is complete.
 *
 * `null` for a project that states NO criteria, and the emptiness is the reason rather than an
 * oversight: `[].every` is vacuously true, and "these zero conditions express your goal" is not a
 * question anybody can answer. Such a project is `PROJECT_TASKS_SETTLED` and nothing more.
 *
 * The roster reaches `detail` and the version from the same argument, and they take different
 * things out of it. `detail` gets all of it, because the card has to carry the question it is
 * asking. The version takes `key`, `satisfied` and `landing` and leaves `text` and `serving`
 * behind — so re-titling a task that served a criterion changes what the card SAYS and cannot
 * change which fact it is.
 */
export function projectAcceptanceLandedFact(
  projectId: string,
  tasks: readonly TaskSettlement[],
  criteria: readonly SettledCriterionReport[],
): WakeFact | null {
  if (tasks.length === 0) return null;
  if (!tasks.every((task) => isSettledTaskStatus(task.status))) return null;
  if (criteria.length === 0) return null;
  if (!criteria.every((criterion) => criterion.satisfied && criterion.landing === 'LANDED')) {
    return null;
  }
  return {
    event: 'PROJECT_ACCEPTANCE_LANDED',
    projectId,
    subjectType: 'PROJECT',
    subjectId: projectId,
    subjectVersion: acceptanceLandingVersion(tasks, criteria),
    detail: { taskCount: tasks.length, criteria },
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
 * `serving` is a parameter rather than a query because this function predates the edge. Migration
 * 0232 landed it since, on the work side: `task.criterion_definition_id` records which criterion a
 * piece of work says it serves, and `readCriterionSatisfaction` already answers from it, so the
 * producer of this event is one query away. See `coordinator-wake.spec.ts` for the derivation's
 * own tests.
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

/**
 * `CRITERION_UNLANDED` — a criterion's work is finished and none of it is on the default branch.
 *
 * WHY THIS IS `CRITERION_READY` PLUS ONE CLAUSE, AND NOT A SECOND SHAPE
 * ====================================================================
 * The two questions are asked about the same subject in the same unit, and the honest reading of
 * the second is "the first, and the result is nowhere anybody can get at it". So the readiness
 * predicate is restated here in full rather than approximated: a non-empty serving set, every
 * member of it DONE. Cutting this one per TASK instead would say "this branch is not on main"
 * about a piece of work whose SIBLINGS are still running, which is not a fact anybody can act on —
 * merging one of three unfinished contributions to a criterion is not what a coordinator would do
 * with it.
 *
 * `landing` is the answer this event exists to carry and it arrives as a parameter, computed by
 * the module that owns what a merge receipt means. It is deliberately not recomputed here: the
 * three-valued vocabulary, the two results that count and the branch names that count are one
 * reading in one place, and a second one in a fact reducer would be a second definition of
 * "landed" that could drift from the one a person is shown.
 *
 * `null` for `LANDED`, which is the ordinary end of a piece of work and the whole point of the
 * pairing: the only difference between a criterion that produces this fact and one that does not
 * is whether a receipt exists.
 *
 * THE VERSION IS THE SETTLEMENT, AND NOT THE RECEIPTS
 * ==================================================
 * `settlementVersion` again, so one finished task set wakes a coordinator about its landing at
 * most once. Folding the receipts into the version instead would make PARTIAL progress towards
 * landing — one of three serving tasks merged, the criterion still not on main — a second fact
 * about the same unfinished situation, which is §0's loop with a merge in the middle of it. When
 * the receipts complete, the answer stops being this fact at all.
 */
export function criterionUnlandedFact(
  projectId: string,
  criterionKey: string,
  serving: readonly TaskSettlement[],
  landing: CriterionLanding,
): WakeFact | null {
  if (landing === 'LANDED') return null;
  if (serving.length === 0) return null;
  if (!serving.every((task) => task.status === 'DONE')) return null;
  return {
    event: 'CRITERION_UNLANDED',
    projectId,
    subjectType: 'CRITERION',
    subjectId: criterionSubjectId(projectId, criterionKey),
    subjectVersion: settlementVersion(serving),
    detail: { criterionKey, taskCount: serving.length, landing },
  };
}

/**
 * `CRITERIA_DECISION_PENDING` — a loosening edit to this project's criteria is held for the owner.
 *
 * THE PREDICATE IS "DECIDABLE", NOT "EXISTS"
 * ==========================================
 * The fact is admitted only for a proposal a decision could actually be recorded on today. A
 * proposal whose baseline seal has since moved is a question nobody can answer — the door refuses
 * every decision on it — and delivering a card whose only button is refused whichever way it is
 * pressed is the defect `pending-evidence-judgments.ts` was re-scoped to stop. So this event admits
 * no partial state: answerable, or the fact does not exist. Nothing is lost by that, because the
 * derived read (`criteria-pending-decisions.ts`) still returns the stalled row, carrying the
 * refusal and the action that clears it, to whoever goes looking.
 *
 * THE VERSION IS THE PROPOSAL ROW, AND THE PREDICATE IT SATISFIED
 * ==============================================================
 * `intentId` is a primary key of an immutable row: 0195's BEFORE UPDATE OR DELETE trigger refuses
 * every write to a filed proposal, so it cannot be moved at all, and one proposal is therefore one
 * question however many times it is re-derived. That is §2's "the session id of the attempt"
 * argument, over a row with a stronger guarantee behind it. Superseding a proposal files a NEW row
 * with a new id, which is a new question — correctly, because what the owner is being asked to
 * approve has changed.
 *
 * `baselineSeal`, `actionDigest` and the pinned `decidable` are hashed in beside it even though the
 * id alone already determines the first two. That is the rule `PROJECT_ACCEPTANCE_LANDED` learned:
 * a field the predicate pins constant TODAY still goes into the version, so that a predicate later
 * loosened to admit some other combination cannot derive a key the stricter reading already spent.
 */
export function criteriaDecisionPendingFact(
  projectId: string,
  proposal: {
    intentId: string;
    actionDigest: string;
    baselineSeal: string;
    decidability: { decidable: boolean };
  },
): WakeFact | null {
  if (!proposal.decidability.decidable) return null;
  return {
    event: 'CRITERIA_DECISION_PENDING',
    projectId,
    subjectType: 'PROJECT',
    subjectId: projectId,
    subjectVersion: createHash('sha256')
      .update(canonicalJson([
        proposal.intentId,
        proposal.baselineSeal,
        proposal.actionDigest,
        true,
      ]))
      .digest('hex'),
    detail: {
      intentId: proposal.intentId,
      actionDigest: proposal.actionDigest,
      baselineSeal: proposal.baselineSeal,
    },
  };
}
