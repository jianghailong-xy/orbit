import { Prisma } from '@prisma/client';
import { postgresSqlState } from './task-supersession';

/**
 * §8.6 LO1's one acquisition order, as a function rather than as a paragraph each writer remembers.
 *
 * The order is frozen: **project (id asc) → task (id asc) → session (id asc)**. Before this module
 * three of the four task-side writers took only part of it and one took none of it, and every one
 * of the gaps was reachable from an ordinary request. Reproduced on a real PostgreSQL 16, each as a
 * native `40P01` reaching an HTTP caller as a 500:
 *
 *   1. a PURE status PATCH (`{status: 'DONE'}`) against a coordinator holding the project — the
 *      PATCH held the task and `project_acceptance_task_fact_update` reached for the project from
 *      an AFTER trigger, while the coordinator held the project and reached for the task;
 *   2. deleting a SUBJECT task against the authorization gate — the delete held the doomed row and
 *      its CASCADE took the verifier rows with it, each of which reaches for ITS project from an
 *      AFTER DELETE, while the gate held the project and reached for the task `FOR SHARE`;
 *   3. a whole-`dependsOn` replacement against a coordinator holding the project — the replacement
 *      held the owner row and the dependent task and reached for each prerequisite's `FOR KEY
 *      SHARE`, while the coordinator held the project and the prerequisite and reached for the
 *      dependent (this is the shape that reached production twice: `P2039`/`40P01` landing in
 *      `TasksService.update → taskDependency.createMany`, rolled back whole, succeeding on a retry
 *      seconds later);
 *   4. the same replacement against a status PATCH on one of its prerequisites — a mutual wait that
 *      only a `statement_timeout` broke.
 *
 * What every one of them has in common is that the task row was taken FIRST and the project row was
 * reached for afterwards, from a trigger. The fix is not a new primitive: it is taking the project
 * before the task in the service, so the trigger's acquisition is a re-acquisition of a lock this
 * transaction already holds and can never wait.
 *
 * `user` sits ABOVE `project` here — `lockDependencyGraph` takes it, and it is a single row per
 * tenant, so a transaction that takes it takes it first and nothing below it can be held while
 * waiting for it. It is not part of LO1's published chain and is not taken by this module; callers
 * that need it take it before calling in.
 */

/**
 * §13.4 AE6's closed set, as the columns of `task` that reach `project_acceptance_reopen`.
 *
 * This list and migration 0134's trigger column list are the same list written twice, and the two
 * are checked against each other by `task-lock-order.spec.ts` reading the migration text: a column
 * added to the trigger and not to this constant is a write path that takes the project from an
 * AFTER trigger with the task already held, which is exactly the inversion this module exists to
 * remove — and it would be invisible, because nothing about the added column says it reopens a
 * project.
 */
export const ACCEPTANCE_FACT_TASK_COLUMNS = [
  'status',
  'completion_policy',
  'project_id',
  'verdict',
  'verifies_task_id',
  'terminal_reason',
  'superseded_by_task_id',
] as const;

/** The same set spelled as the DTO fields a PATCH can carry, which is what a caller writes. */
export interface AcceptanceFactPatch {
  status?: unknown;
  completionPolicy?: unknown;
  projectId?: unknown;
  verdict?: unknown;
  verifiesTaskId?: unknown;
  terminalReason?: unknown;
  supersededByTaskId?: unknown;
}

/**
 * Does this PATCH touch an acceptance fact — i.e. will it reach an AFTER trigger that takes a
 * project row?
 *
 * `!== undefined`, deliberately, and this is the whole of the bug it replaces. The old routing
 * asked whether the write REACHED a verdict (`dto.verdict != null && dto.verdict !== before`),
 * which is the right question for §13.2 V7's revision counter and the wrong one for a lock: a
 * verdict REVOCATION (`verdict: null`) changes the column, fires the trigger and takes the project
 * — while `concludesVerdict` was false, so the request took the no-lock fast path. The same held
 * for a pure `{status}` and a pure `{completionPolicy}`. What decides whether a lock is needed is
 * whether the COLUMN is written, never what the value means.
 */
export function touchesAcceptanceFact(dto: AcceptanceFactPatch): boolean {
  return dto.status !== undefined
    || dto.completionPolicy !== undefined
    || dto.projectId !== undefined
    || dto.verdict !== undefined
    || dto.verifiesTaskId !== undefined
    || dto.terminalReason !== undefined
    || dto.supersededByTaskId !== undefined;
}

/** What a scope walk locked, in the order it locked it. Returned so callers can re-check it. */
export interface LockedTaskScope {
  /** Distinct, sorted, non-null. The first level of LO1 and the only one taken by waiting. */
  projectIds: string[];
  /** The full closure, sorted — not just the seeds. */
  taskIds: string[];
  /** Every session attached to a task in the closure, sorted. */
  sessionIds: string[];
}

/** How much of the task graph a write reaches, beyond the tasks it names. */
export interface TaskScopeRequest {
  /** Tasks this write names directly. */
  taskIds: string[];
  /** Projects the write moves rows INTO, which no read of the current rows can discover. */
  extraProjectIds?: Array<string | null | undefined>;
  /**
   * Follow `verifies_task_id` in both directions, transitively.
   *
   * On by default because both directions are real. A verdict write on a verifier applies its
   * consequences to the SUBJECT, and a delete of a subject CASCADEs its verifiers away — each
   * cascaded row reaching for its own project from an AFTER DELETE, in an order PostgreSQL picks.
   * Transitive because the CASCADE is: a check of a check goes too.
   */
  followVerification?: boolean;
  /**
   * Also take the rows a DELETE will write by SET NULL: children (`parent_task_id`) and predecessors
   * (`superseded_by_task_id`). The second is an acceptance-fact column, so a delete that skipped it
   * would reopen a project from a row this transaction never locked.
   */
  followDeleteFanout?: boolean;
  /** Take the sessions too. A write that ends or detaches runs must hold them before it reads them. */
  lockSessions?: boolean;
}

/**
 * A scope that moved between the unlocked read and the locks, which is not a failure — it is a
 * stale snapshot, and the caller's answer is to take a fresh one.
 *
 * Named the same way migration 0132's `TASK_AGGREGATE_SCOPE_MOVED` is, and translated by
 * `taskFenceConflictMessage` through the same door, so a caller sees one vocabulary for "these rows
 * moved while I was preparing; nothing was written; retry".
 */
export const TASK_FACT_SCOPE_MOVED = 'TASK_FACT_SCOPE_MOVED';

export class TaskScopeMovedError extends Error {
  constructor(what: string) {
    super(`${TASK_FACT_SCOPE_MOVED}: ${what} changed while this write was being prepared — `
      + 'nothing was written; retry');
    this.name = 'TaskScopeMovedError';
  }
}

/**
 * The closure of `seeds`, as one query, so the walk cannot disagree with itself between reads.
 *
 * No backticks anywhere below the `Prisma.sql` tag, and that is not a style rule. A backtick inside
 * a tagged template closes it, so a SQL comment written the way the comments above are written ends
 * the template at the word it was quoting and the rest of the statement parses as TypeScript. It
 * fails as a `TS1005` pointing at a line some distance further down, which is why this is said here
 * rather than left to be rediscovered: SQL comments in this file use plain words.
 */
async function readScope(
  tx: Prisma.TransactionClient,
  ownerId: string,
  request: TaskScopeRequest,
): Promise<{ taskIds: string[]; projectIds: string[] }> {
  const seeds = [...new Set(request.taskIds)].sort();
  if (seeds.length === 0) {
    const seeded = [...new Set((request.extraProjectIds ?? [])
      .filter((id): id is string => !!id))].sort();
    return { taskIds: [], projectIds: seeded };
  }
  const followVerification = request.followVerification !== false;
  const followDeleteFanout = request.followDeleteFanout === true;
  // Carried in the closure rather than fetched by a correlated subquery over it: PostgreSQL forbids
  // a recursive CTE from referring to itself inside a subquery, and the SUBJECT direction of the
  // verification edge (the seed's own verifies_task_id) needs that column of the row already in the
  // closure. Selecting it alongside the id costs nothing and keeps the recursive term a plain join.
  const rows = await tx.$queryRaw<Array<{ id: string; projectId: string | null }>>(Prisma.sql`
    WITH RECURSIVE closure AS (
      SELECT t."id", t."project_id", t."verifies_task_id", t."parent_task_id",
             t."superseded_by_task_id"
        FROM "task" t
       WHERE t."id" = ANY(${seeds}::uuid[]) AND t."owner_id" = ${ownerId}::uuid
      UNION
      SELECT n."id", n."project_id", n."verifies_task_id", n."parent_task_id",
             n."superseded_by_task_id"
        FROM closure c
        JOIN "task" n
          ON n."owner_id" = ${ownerId}::uuid
         AND (
           -- The verification edge, BOTH ways: a verdict's consequences land on the subject, and a
           -- subject's delete CASCADEs onto its verifiers.
           (${followVerification}::boolean
             AND (n."verifies_task_id" = c."id" OR n."id" = c."verifies_task_id"))
           -- The rows a DELETE rewrites by SET NULL. The superseded-by pointer is an acceptance-fact
           -- column, so those rows reopen projects of their own.
           OR (${followDeleteFanout}::boolean
             AND (n."parent_task_id" = c."id" OR n."superseded_by_task_id" = c."id"))
         )
    )
    SELECT "id", "project_id" AS "projectId" FROM closure
  `);
  const projectIds = [...new Set([
    ...rows.map((row) => row.projectId),
    ...(request.extraProjectIds ?? []),
  ].filter((id): id is string => !!id))].sort();
  return { taskIds: [...new Set(rows.map((row) => row.id))].sort(), projectIds };
}

/**
 * Take LO1's chain over a task write's whole reach, and prove afterwards that it was the right one.
 *
 * Three levels, and the difference between them is not decoration:
 *
 *   * **project — waiting `FOR NO KEY UPDATE`.** §13.4 AE6-a's exact spelling, and §8.6 LO3's
 *     reason for it: this transaction may have to `UPDATE` the row (AE8's reopen), so it takes the
 *     strong lock at the start rather than upgrading into a deadlock. Waiting is safe here because
 *     nothing in LO1 sits above it — a transaction blocked on level 1 holds no level 2 or 3 row.
 *   * **task — waiting `FOR UPDATE`**, descending, so it cannot close a loop against anything that
 *     followed the same order. A writer that did NOT follow it (raw SQL, an older binary) is caught
 *     one layer down by migration 0134's BEFORE guards, which take the project `NOWAIT` and refuse
 *     rather than wait — so the inverted direction never becomes an edge in the wait-for graph.
 *   * **session — waiting `FOR UPDATE`**, last, for the writes that end or detach runs.
 *
 * Then the scope is READ AGAIN under the locks and compared. The first read was a guess: between it
 * and the first lock a task can be re-filed into another project, a new verifier can be pointed at
 * a subject, a new run can be started. Committing on the guess would leave this transaction holding
 * the OLD project while a trigger reaches for the new one — the inversion, one step late, which is
 * precisely the failure migration 0132's `TASK_AGGREGATE_SCOPE_MOVED` was added for.
 */
export async function lockTaskScope(
  tx: Prisma.TransactionClient,
  ownerId: string,
  request: TaskScopeRequest,
): Promise<LockedTaskScope> {
  const guess = await readScope(tx, ownerId, request);

  for (const projectId of guess.projectIds) {
    await tx.$queryRaw`SELECT 1 FROM "project" WHERE "id" = ${projectId}::uuid FOR NO KEY UPDATE`;
  }
  if (guess.taskIds.length) {
    // One statement, `ORDER BY id`: PostgreSQL's LockRows node sits above the sort, so the rows are
    // locked in the order they come out of it. Two of these over overlapping sets therefore take
    // the shared rows in the same order and cannot invert against each other.
    await tx.$queryRaw`
      SELECT "id" FROM "task"
       WHERE "id" = ANY(${guess.taskIds}::uuid[]) AND "owner_id" = ${ownerId}::uuid
       ORDER BY "id" FOR UPDATE`;
  }

  // Under the locks now, and this is the read that decides. A closure that grew or a project that
  // changed means the guess above locked the wrong rows.
  const confirmed = await readScope(tx, ownerId, request);
  if (confirmed.taskIds.join(',') !== guess.taskIds.join(',')) {
    throw new TaskScopeMovedError('the set of tasks this write reaches');
  }
  if (confirmed.projectIds.join(',') !== guess.projectIds.join(',')) {
    throw new TaskScopeMovedError("a task's project");
  }

  let sessionIds: string[] = [];
  if (request.lockSessions && confirmed.taskIds.length) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT s."id" FROM "session" s
       WHERE s."owner_id" = ${ownerId}::uuid
         AND (s."task_id" = ANY(${confirmed.taskIds}::uuid[])
              OR s."context_task_id" = ANY(${confirmed.taskIds}::uuid[]))
       ORDER BY s."id" FOR UPDATE
    `);
    sessionIds = rows.map((row) => row.id);
  }
  return { projectIds: confirmed.projectIds, taskIds: confirmed.taskIds, sessionIds };
}

/**
 * §8.6 LO4, frozen: at most 3 retries (4 attempts), `50ms · 2^n` with ±25% jitter, a FRESH snapshot
 * every time, and a TYPED refusal at the end rather than an unclassified 500.
 *
 * LO1 removes the cycles that a lock order can remove. It does not remove all of them, and the
 * contract says so in as many words: trigger bodies and index maintenance take locks nobody
 * declared, in an order nobody chose. `40001` under `REPEATABLE READ` is the same shape. What is
 * left over is genuinely a retry, because it is genuinely transient — the production evidence for
 * this is that the identical idempotent request succeeded 14 seconds later, untouched.
 *
 * The whole `run` is re-executed, not just the failed statement: the caller's transaction has been
 * rolled back whole by PostgreSQL, so its snapshot is gone and re-reading is the only correct
 * resumption. That is also what makes "zero side effects on failure" true rather than hoped for —
 * there is no partial state to clean up, because the server discarded it.
 */
export const PROJECT_FACT_WRITE_CONTENDED = 'PROJECT_FACT_WRITE_CONTENDED';

export const LOCK_ORDER_RETRY_ATTEMPTS = 4;

/**
 * `40P01` a deadlock this transaction lost, `40001` a serialization failure, `55P03` a `NOWAIT`
 * that lost — plus the two typed markers the database's own BEFORE guards raise, which are the same
 * condition said out loud instead of left to chance.
 */
export function isLockOrderContention(error: unknown): boolean {
  const state = postgresSqlState(error);
  if (state === '40P01' || state === '40001' || state === '55P03') return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return new RegExp(
    `${TASK_FACT_SCOPE_MOVED}|TASK_FACT_PROJECT_BUSY|TASK_DEPENDENCY_PROJECT_BUSY`,
  ).test(message);
}

/** Injected only by the tests, which have no interest in waiting 350ms to prove a rule. */
export interface LockOrderRetryOptions {
  attempts?: number;
  /** Milliseconds; the base of `base · 2^n`. */
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Called once per retry, so a service can record that this project is contended (LO4 clause 3). */
  onRetry?: (attempt: number, error: unknown) => void;
}

export async function withLockOrderRetry<T>(
  run: () => Promise<T>,
  options: LockOrderRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? LOCK_ORDER_RETRY_ATTEMPTS;
  const base = options.baseDelayMs ?? 50;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!isLockOrderContention(error)) throw error;
      last = error;
      if (attempt === attempts - 1) break;
      options.onRetry?.(attempt + 1, error);
      // ±25% jitter, so a set of writers that collided once does not re-collide in lockstep.
      await sleep(Math.round(base * 2 ** attempt * (0.75 + random() * 0.5)));
    }
  }
  throw new LockOrderContendedError(attempts, last);
}

/**
 * What the caller gets after the retries are spent. A named, retryable condition — never the
 * untyped 500 that a raw `40P01` becomes, which is the single thing the production reports of this
 * bug had in common.
 */
export class LockOrderContendedError extends Error {
  readonly code = PROJECT_FACT_WRITE_CONTENDED;

  constructor(readonly attempts: number, readonly cause: unknown) {
    super(`${PROJECT_FACT_WRITE_CONTENDED}: this project's tasks are being written by something `
      + `else right now — ${attempts} attempts were made and every one was rolled back whole, so `
      + 'nothing was changed. Retry');
    this.name = 'LockOrderContendedError';
  }
}
