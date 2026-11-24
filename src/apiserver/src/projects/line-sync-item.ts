import { Prisma } from '@prisma/client';

import { lineSyncDedupeKey } from './line-sync-hold';

/**
 * The line-sync item: docs/design/project-line-upstream-sync.md §4.
 *
 * A task landing that stops `CONFLICT` at `MAIN_SYNC` is a fact about the project branch — it could not absorb the
 * upstream — and not about the task that happened to land next. It opens one `INTEGRATION_CONFLICT` per line, with
 * no task (`IMS:<serial_key>`), for the coordinator; the task stays DONE, and its landing is queued again behind the
 * item (`queueMainSyncHeld`). The coordinator files one sync task from the item (`fixesOpenItemId`), which alone is
 * let through the hold (`lineSyncHoldSql`), and whose landing closes the item (L-T3, `resolveLineSyncOnLanding`).
 */

/** §4.1: the item's title, in `integrationItemTitle`'s pattern. */
export function lineSyncItemTitle(upstreamRef: string): string {
  return `Merge conflict: syncing ${upstreamRef.replace(/^refs\/heads\//, '')} into the project branch`;
}

/**
 * Read in the result transaction before the item is written: the upstream it is about, and whether the task whose
 * landing conflicted is itself a sync task filed against the line-sync item that is already OPEN (§4.2's exception:
 * such a task gets no held generation, because its branch cannot change without a new commit).
 */
export async function openLineSyncOf(
  tx: Prisma.TransactionClient,
  input: { projectId: string; serialKey: string; upstreamRef: string; taskId: string | null },
): Promise<{ upstreamRef: string; taskFixesIt: boolean }> {
  const open = await tx.projectOpenItem.findFirst({
    where: { projectId: input.projectId, dedupeKey: lineSyncDedupeKey(input.serialKey), state: 'OPEN' },
    select: { id: true },
  });
  const task = open && input.taskId
    ? await tx.task.findUnique({ where: { id: input.taskId }, select: { fixesOpenItemId: true } })
    : null;
  return { upstreamRef: input.upstreamRef, taskFixesIt: !!open && task?.fixesOpenItemId === open.id };
}

/**
 * §4.5 L-T3: a `LAND_TASK` on the serial key ended `LANDED`. Every such landing on a project branch contains the
 * upstream tip its own fetch read (J-S2, all three paths), and that fetch came after the one that conflicted, so the
 * line has absorbed the upstream: the item closes, by the platform, naming the job. The hold lifts, and the held
 * landings are claimed in enqueue order. Returns the closed item's id, or null when none was open.
 */
export async function resolveLineSyncOnLanding(
  tx: Prisma.TransactionClient,
  input: { projectId: string; serialKey: string; jobId: string },
): Promise<string | null> {
  const [closed] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "project_open_item"
       SET "state" = 'RESOLVED', "resolution" = 'LANDED', "resolved_by" = 'PLATFORM', "resolved_at" = now(),
           "resolved_by_job_id" = ${input.jobId}::uuid
     WHERE "project_id" = ${input.projectId}::uuid
       AND "dedupe_key" = ${lineSyncDedupeKey(input.serialKey)}
       AND "state" = 'OPEN'
     RETURNING "id"`);
  return closed?.id ?? null;
}

/**
 * §4.6 item 7, the bridge for items opened before the line-sync item existed: the DONE tasks whose OPEN task-level
 * MAIN_SYNC item is on this serial key. When a landing on the key ends `LANDED`, the line has the upstream, so each of
 * them gets its next landing generation queued (`queueLandingRetry`); that landing no longer meets the conflict, and
 * when it lands `resolveIntegrationItemsOnLanding` closes its item. Nobody reopens the task. Reads only; the caller
 * locks the tasks it returns, in id order, before the binding.
 */
export async function legacyMainSyncTaskIds(
  tx: Prisma.TransactionClient,
  input: { projectId: string; serialKey: string; exceptTaskId: string | null },
): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ taskId: string }>>(Prisma.sql`
    SELECT DISTINCT i."task_id" AS "taskId"
      FROM "project_open_item" i
      JOIN "project_integration_job" f ON f."id" = i."integration_job_id"
      JOIN "task" t ON t."id" = i."task_id"
     WHERE i."project_id" = ${input.projectId}::uuid
       AND i."kind" = 'INTEGRATION_CONFLICT' AND i."state" = 'OPEN'
       AND i."task_id" IS NOT NULL
       AND f."kind" = 'LAND_TASK' AND f."phase" = 'MAIN_SYNC' AND f."serial_key" = ${input.serialKey}
       AND t."status" = 'DONE'
       ${input.exceptTaskId ? Prisma.sql`AND i."task_id" <> ${input.exceptTaskId}::uuid` : Prisma.empty}
     ORDER BY 1`);
  return rows.map((row) => row.taskId);
}
