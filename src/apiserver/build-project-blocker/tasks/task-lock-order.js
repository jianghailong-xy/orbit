"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskScopeMovedError = exports.TASK_FACT_SCOPE_MOVED = exports.ACCEPTANCE_FACT_TASK_COLUMNS = void 0;
exports.touchesAcceptanceFact = touchesAcceptanceFact;
exports.cascadedTaskClosure = cascadedTaskClosure;
exports.assertAcceptanceScopeUnmoved = assertAcceptanceScopeUnmoved;
const client_1 = require("@prisma/client");
/**
 * The acceptance-fact half of the canonical lock order, beside `common/lock-order.ts` rather than
 * instead of it.
 *
 * `common/lock-order.ts` states the order itself — user (10), task_list (20), session (30),
 * project (40), task (50), children (60), revision (70) — and every rank in it was read off
 * `pg_locks` rather than inferred. This module does not restate it and does not re-derive it. It
 * answers the one question that order cannot answer on its own: WHICH writes take rank 40 at all.
 *
 * The answer is not "the ones that mention a project". 0127 put the acceptance projection in AFTER
 * triggers on seven columns of `task`, and a write to any of them calls `project_acceptance_reopen`
 * and takes that task's project row. Nothing in the statement says so. So the closed set of those
 * seven columns is written down here, checked against the trigger that defines it, and used by the
 * one predicate the service routes on.
 *
 * Nothing in this file retries and nothing in it takes a lock the service could not take itself:
 * `withTransactionRetry` owns re-running a transaction PostgreSQL threw away, and the typed
 * refusals the database guards raise are `lock_not_available`, which that classifier deliberately
 * does not call transient — they are decisions, translated to a 409 by `taskFenceConflictMessage`.
 */
/**
 * §13.4 AE6's closed set, as the columns of `task` that reach `project_acceptance_reopen`.
 *
 * This list and migration 0136's trigger column list are the same list written twice, and the two
 * are checked against each other by `task-lock-order.spec.ts` reading the migration text: a column
 * added to the trigger and not to this constant is a write path that takes the project from an
 * AFTER trigger with the task already held, which is exactly the inversion this module exists to
 * remove — and it would be invisible, because nothing about the added column says it reopens a
 * project.
 */
exports.ACCEPTANCE_FACT_TASK_COLUMNS = [
    'status',
    'completion_policy',
    'project_id',
    'verdict',
    'verifies_task_id',
    'terminal_reason',
    'superseded_by_task_id',
];
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
function touchesAcceptanceFact(dto) {
    return dto.status !== undefined
        || dto.completionPolicy !== undefined
        || dto.projectId !== undefined
        || dto.verdict !== undefined
        || dto.verifiesTaskId !== undefined
        || dto.terminalReason !== undefined
        || dto.supersededByTaskId !== undefined;
}
/**
 * A scope that moved between the unlocked read and the locks, which is not a failure — it is a
 * stale snapshot, and the caller's answer is to take a fresh one.
 *
 * Named the same way migration 0134's `TASK_AGGREGATE_SCOPE_MOVED` is, and translated by
 * `taskFenceConflictMessage` through the same door, so a caller sees one vocabulary for "these rows
 * moved while I was preparing; nothing was written; retry".
 */
exports.TASK_FACT_SCOPE_MOVED = 'TASK_FACT_SCOPE_MOVED';
class TaskScopeMovedError extends Error {
    constructor(what) {
        super(`${exports.TASK_FACT_SCOPE_MOVED}: ${what} changed while this write was being prepared — `
            + 'nothing was written; retry');
        this.name = 'TaskScopeMovedError';
    }
}
exports.TaskScopeMovedError = TaskScopeMovedError;
/**
 * The tasks a DELETE of `ids` will actually REMOVE, which is more than the ids it names.
 *
 * `verifies_task_id` is `ON DELETE CASCADE`, so deleting a SUBJECT takes its checks with it — and
 * a check of a check goes too. Transitive, therefore, and computed in one statement so the walk
 * cannot disagree with itself between reads.
 *
 * This is a READ, not a lock: `TasksService.deleteAndStopRuns` already takes rank 30, 40 and 50 in
 * `common/lock-order.ts`'s order, and this only widens WHICH rows those statements cover. Adding a
 * second ordered acquisition here would be a second lock order beside the canonical one, which is
 * the thing that produced the incident in the first place.
 *
 * Deliberately only the CASCADE direction. The subject of a check is a row this transaction may
 * need to LOCK, but it is not a row this delete removes, and ending the runs on it would cancel
 * sessions doing live work on tasks that survive.
 */
async function cascadedTaskClosure(tx, ownerId, ids) {
    if (ids.length === 0)
        return [];
    const rows = await tx.$queryRaw(client_1.Prisma.sql `
    WITH RECURSIVE cascaded AS (
      SELECT t."id" FROM "task" t
       WHERE t."id" = ANY(${[...ids]}::uuid[]) AND t."owner_id" = ${ownerId}::uuid
      UNION
      SELECT v."id" FROM cascaded c
        JOIN "task" v ON v."verifies_task_id" = c."id" AND v."owner_id" = ${ownerId}::uuid
    )
    SELECT "id" FROM cascaded
  `);
    return [...new Set(rows.map((row) => row.id))].sort();
}
/**
 * Re-read the projects a write's acceptance facts reach, now that they are held, and refuse if the
 * set moved.
 *
 * The projects a caller pre-locks are chosen from a read taken BEFORE the first of them was held.
 * Between that read and the lock a task can be re-filed into another project — the owner graph
 * mutex does not cover a single-row status write — and then this transaction holds the OLD project
 * while `project_acceptance_reopen` reaches for the new one from an AFTER trigger. That is the
 * inversion, one step late, and it commits on a guess rather than deadlocking, which is worse.
 *
 * Called AFTER the rank-40 acquisition and BEFORE the first `task` write, so a refusal costs
 * nothing: the transaction has written nothing yet and PostgreSQL discards the rest.
 */
async function assertAcceptanceScopeUnmoved(tx, ownerId, taskIds, expected) {
    if (taskIds.length === 0)
        return;
    const rows = await tx.$queryRaw(client_1.Prisma.sql `
    SELECT DISTINCT t."project_id" AS "projectId" FROM "task" t
     WHERE t."id" = ANY(${[...taskIds]}::uuid[]) AND t."owner_id" = ${ownerId}::uuid
  `);
    const actual = [...new Set(rows.map((r) => r.projectId).filter((id) => !!id))].sort();
    const want = [...new Set(expected)].sort();
    // Subset, not equality: the caller also pre-locks the project it is moving a task INTO, which no
    // read of the current rows can discover. What may not happen is a project appearing that nothing
    // holds.
    const unheld = actual.filter((id) => !want.includes(id));
    if (unheld.length > 0)
        throw new TaskScopeMovedError("a task's project");
}
//# sourceMappingURL=task-lock-order.js.map