/**
 * Unit L6: the one statement every start path asks the ownership question with.
 *
 * It lives here, as one exported `Prisma.Sql`, for `project-blocker-guard.ts`'s reason: the rule
 * and the paths that enforce it read the same bytes. Four doors evaluate this gate — `task_start`
 * and the sweeps through `executeLeased`, the bulk Run through `batchExecute`, the coordinator
 * through `dispatchInTransaction`, and the recovery scan — and three of them are in different
 * files. Written out four times it would be four predicates that agree today.
 *
 * The join is the whole of it: the task's own two columns, and whether unit L4's ledger holds an
 * answer that explains the difference between them. `APPLIED` and not `APPROVED`, because an
 * approval that was granted and never spent authorises a crossing that never happened — the row
 * that says this task's project is where a person put it is the one recording that it was SPENT,
 * on this task, into this project.
 *
 * `subject_task_id OR applied_task_id`, because L4 records the two kinds of crossing in the two
 * different columns its own schema comment explains: a `MOVE_TASK` names the task it moves before
 * the move happens, while a `FILE_TASK` cannot — the task does not exist yet — and names it when
 * the yes is spent. Reading only one of them would let one lawful crossing look like an incident.
 */

import { Prisma } from '@prisma/client';

import type { TaskOwnershipFacts } from './project-ownership-gate';

/** One row as the query returns it. `generation` is text: `BIGINT` has no JSON form. */
export interface TaskOwnershipRow {
  taskId: string;
  title: string;
  projectId: string | null;
  creatorCoordinatorProjectId: string | null;
  creatorCoordinatorGeneration: string | null;
  approvedCrossing: boolean;
}

/**
 * Every fact the gate reads, for a set of tasks under one owner.
 *
 * Owner-scoped like every other read on these paths: ownership is a tenant fact before it is a
 * project fact, and a task reached without the owner clause would be a gate answered across
 * tenants. A task id that does not resolve simply produces no row, and the callers treat an absent
 * row as "nothing to check" — which is right, because a task that is not there is not running.
 */
export function taskOwnershipQuery(ownerId: string, taskIds: readonly string[]): Prisma.Sql {
  return Prisma.sql`
    SELECT t."id" AS "taskId", t."title",
           t."project_id" AS "projectId",
           t."creator_coordinator_project_id" AS "creatorCoordinatorProjectId",
           t."creator_coordinator_generation"::text AS "creatorCoordinatorGeneration",
           EXISTS (
             SELECT 1 FROM "project_handoff_approval" h
              WHERE h."owner_id" = t."owner_id"
                AND h."state" = 'APPLIED'
                AND h."to_project_id" = t."project_id"
                AND (h."applied_task_id" = t."id" OR h."subject_task_id" = t."id")
           ) AS "approvedCrossing"
      FROM "task" t
     WHERE t."owner_id" = ${ownerId}::uuid
       AND t."id" IN (${Prisma.join(taskIds.map((id) => Prisma.sql`${id}::uuid`))})
  `;
}

/** The row, as the pure decision wants it. Kept next to the query so the mapping has one home. */
export function ownershipFactsOf(row: TaskOwnershipRow): TaskOwnershipFacts {
  return {
    taskId: row.taskId,
    projectId: row.projectId,
    creatorCoordinatorProjectId: row.creatorCoordinatorProjectId,
    creatorCoordinatorGeneration: row.creatorCoordinatorGeneration,
    approvedCrossing: row.approvedCrossing,
  };
}

/**
 * The audit sweep's half: every mis-filed task in this database, or in one project.
 *
 * The predicate is the partial index 0156 installs, written the same way round so the planner can
 * use it — on a healthy deployment this reads one empty index page rather than the task table.
 *
 * `LEFT JOIN` on the replacement rather than `NOT EXISTS`, because the scan has to be able to say
 * "already repaired, and here is what it became" as well as "not repaired". Those are different
 * answers and a scan that could only count offenders would report the repaired ones for ever.
 */
export function misfiledTasksQuery(scope: {
  ownerId?: string;
  projectId?: string;
  limit: number;
}): Prisma.Sql {
  // `Prisma.empty` and not `Prisma.join([])`, which throws: the unfiltered sweep — every task in
  // the database — is the recovery scan's normal call, not an edge case to be tripped by.
  const filters = [
    scope.ownerId ? Prisma.sql`AND t."owner_id" = ${scope.ownerId}::uuid` : Prisma.empty,
    scope.projectId ? Prisma.sql`AND t."project_id" = ${scope.projectId}::uuid` : Prisma.empty,
  ];
  return Prisma.sql`
    SELECT t."id" AS "taskId", t."owner_id" AS "ownerId", t."title", t."status"::text AS "status",
           t."project_id" AS "projectId",
           t."creator_coordinator_project_id" AS "creatorCoordinatorProjectId",
           t."creator_coordinator_generation"::text AS "creatorCoordinatorGeneration",
           r."id" AS "replacementTaskId",
           EXISTS (
             SELECT 1 FROM "project_handoff_approval" h
              WHERE h."owner_id" = t."owner_id"
                AND h."state" = 'APPLIED'
                AND h."to_project_id" = t."project_id"
                AND (h."applied_task_id" = t."id" OR h."subject_task_id" = t."id")
           ) AS "approvedCrossing"
      FROM "task" t
      LEFT JOIN "task" r
        ON r."source_task_id" = t."id" AND r."trigger_event" = 'project.ownership_refiled'
     WHERE t."creator_coordinator_project_id" IS NOT NULL
       AND t."creator_coordinator_project_id" IS DISTINCT FROM t."project_id"
       ${filters[0]}
       ${filters[1]}
     ORDER BY t."id"
     LIMIT ${scope.limit}
  `;
}

export interface MisfiledTaskRow extends TaskOwnershipRow {
  ownerId: string;
  status: string;
  replacementTaskId: string | null;
}
