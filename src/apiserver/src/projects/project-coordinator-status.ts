/**
 * The one read that answers "what is this project's coordinator doing, and why is it not doing
 * something else" (contract AC10 / §6.2 · §11.1 · §13.4).
 *
 * Everything here is already committed somewhere — `project`, `project_runtime`, `project_member`,
 * `project_decision`, `project_action`, `project_blocker`, `project_event`, and the sessions the
 * work runs in. What was missing was a single door onto all of it: the control loop's state was
 * only readable by joining seven tables by hand, so "why has this been sitting still for an hour"
 * had no answer a person or an agent could fetch. Every section below is a projection of rows that
 * already exist; nothing here computes a second opinion about any of them.
 *
 * TWO RULES the shape follows, and both are the reason it is written down as a type rather than
 * assembled ad hoc at the query:
 *
 *  1. **Absent is a value, never an omission.** A section that has nothing to report carries an
 *     explicit `null` AND a sibling `…AbsentReason` from the closed set below. A field quietly
 *     left out of the body is indistinguishable, to every client, from a field the server does not
 *     know about — which is exactly how "this project has no blocker" and "this build is too old
 *     to report blockers" become the same JSON.
 *  2. **Nothing is re-derived against a second clock.** `nextWake.candidates` is the table the
 *     deciding pass actually recorded (§10.4 W5 clause 4, stored in `project_decision.outcome`),
 *     not a recomputation at read time: a reader that re-ran W5 with `now()` would print a
 *     candidate set that no decision ever saw, and the one thing this endpoint exists to be is a
 *     faithful account of what the loop did.
 */

/**
 * Why a nullable field is null. Closed set: a client switches on these, and a free-text reason is
 * one nobody can branch on.
 */
export const COORDINATOR_STATUS_ABSENT_REASONS = [
  /** No agent holds this project's COORDINATOR seat, so nothing is deciding for it. */
  'NO_COORDINATOR_AGENT',
  /** The coordination conversation has never been opened (POST /projects/:id/coordinator). */
  'COORDINATOR_NEVER_OPENED',
  /** It was opened and then trashed; the pointer was emptied and the next open replaces it. */
  'COORDINATOR_SESSION_TRASHED',
  /** No default coordination workspace is recorded — it is written when a coordinator is bound. */
  'NO_COORDINATION_WORKSPACE',
  /** The limit is deliberately not set: `sessionBudgetPerDay` null means uncapped (§9.4). */
  'UNLIMITED',
  /** Nobody currently holds the reconcile lease (§8.1) — normal between passes. */
  'NOT_LEASED',
  /** `project_runtime.next_wake_at` is empty: SETTLED, or nothing is waiting on a clock. */
  'NO_WAKE_SCHEDULED',
  /** This project has never been reconciled, so there is no decision to report. */
  'NO_DECISION_YET',
  /** The most recent decision predates migration 0125's wake audit and recorded no candidates. */
  'DECISION_PREDATES_WAKE_AUDIT',
  /** No action is claimed and unpublished, so nothing is mid-flight. */
  'NO_PENDING_ACTION',
  /** Nothing is blocking the project right now (§11). */
  'NO_OPEN_BLOCKER',
  /** Every durable signal has been consumed; the outbox is empty. */
  'NO_PENDING_EVENT',
  /** The project states no acceptance criteria, so there is nothing to accept it against. */
  'NO_ACCEPTANCE_CRITERIA',
  /** §13.4's project-level acceptance has not run on this project yet. */
  'ACCEPTANCE_NOT_ATTEMPTED',
  /** No session in this project has reported a branch, so there is no merge evidence to show. */
  'NO_MERGE_EVIDENCE',
] as const;

export type CoordinatorStatusAbsentReason = (typeof COORDINATOR_STATUS_ABSENT_REASONS)[number];

/**
 * The sections every response carries, whatever the project's state.
 *
 * Named as a value because it is the assertion: an empty project and a busy one return the same
 * KEYS, differing only in what those keys hold. A caller that has to test for the presence of a
 * section before reading it is a caller that will forget to, and the section most likely to be
 * missing is the one that says the project is stuck.
 */
export const COORDINATOR_STATUS_SECTIONS = [
  'project',
  'coordination',
  'policy',
  'consumption',
  'runtime',
  'nextWake',
  'decisions',
  'pendingActions',
  'blockers',
  'events',
  'acceptance',
] as const;

export type CoordinatorStatusSection = (typeof COORDINATOR_STATUS_SECTIONS)[number];

/** How far a control write may be behind the project it is writing to. */
export const STALE_CONFIG_REVISION_CODE = 'STALE_CONFIG_REVISION';

/** A manual trigger on a project whose coordinator is switched off (§5.5: the event would be
 *  discarded out of loop, so accepting it would be a run that silently never happens). */
export const COORDINATOR_DISABLED_CODE = 'COORDINATOR_DISABLED';

/** A manual trigger on a project that is DONE or CANCELLED — §4.2 guard 1 makes it SETTLED, and a
 *  settled project consumes no events. */
export const PROJECT_SETTLED_CODE = 'PROJECT_SETTLED';

/** How many decisions the read carries. Enough to see the last few passes and what each did;
 *  bounded because a project reconciles on every event and the ledger is append-only. */
export const COORDINATOR_STATUS_DECISION_LIMIT = 5;

/** Same reasoning for the two other unbounded ledgers this read projects. */
export const COORDINATOR_STATUS_EVENT_LIMIT = 20;
export const COORDINATOR_STATUS_MERGE_EVIDENCE_LIMIT = 50;

/**
 * Why a nullable field is null, or `null` when it is not.
 *
 * The pair is always spelled as TWO SIBLING KEYS — `agentId` and `agentIdAbsentReason` — and never
 * as a `{ value, absentReason }` wrapper, which is the shape this started as and had to be undone.
 * The id classification (`PUBLIC_ID_FIELDS`) is keyed on FIELD NAMES: the response interceptor
 * rewrites `agentId` because of what it is called, so an id moved to `agentId.value` is an id the
 * codec no longer recognises, and it goes out as a raw UUID. Flat also keeps one rule for every
 * field rather than one for ids and another for everything else.
 */
export function reasonIfAbsent(
  value: unknown,
  reason: CoordinatorStatusAbsentReason,
): CoordinatorStatusAbsentReason | null {
  return value == null ? reason : null;
}

/**
 * The same for a list. An empty array already renders as "nothing here", so this exists for the
 * reason the scalar form does: "nothing is blocking this project" and "this project has never been
 * looked at" are both `[]`, and only one of them means the loop is healthy.
 */
export function reasonIfEmpty(
  items: readonly unknown[],
  reason: CoordinatorStatusAbsentReason,
): CoordinatorStatusAbsentReason | null {
  return items.length === 0 ? reason : null;
}

/**
 * BigInt counters (`config_revision`, `fencing_token`, `coordinator_generation`) go out as decimal
 * STRINGS, never as JSON numbers.
 *
 * They are `bigint` columns and they are monotonic for the life of the project: past 2^53 a JSON
 * number stops being able to tell two of them apart, and the value whose whole job is to say "this
 * is not the revision you read" would start comparing equal to its successor. Every id-shaped
 * counter on this API is already a string for the same reason.
 */
export function counter(value: bigint | number | string | null | undefined): string {
  return value == null ? '0' : String(value);
}
