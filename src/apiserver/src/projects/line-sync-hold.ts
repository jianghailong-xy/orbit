import { Prisma } from '@prisma/client';

/**
 * docs/design/project-line-upstream-sync.md §4.1: the dedupe key of the line-sync item, one OPEN item per line
 * (the open-dedupe index of 0278). The serial key names the repository and the project branch.
 */
export function lineSyncDedupeKey(serialKey: string): string {
  return `IMS:${serialKey}`;
}

/**
 * M2, as the claim and both readers spell it (the contract's T17 rule: the reader says what the claim does). The
 * caller joins item i to the job f that found the conflict, as `baselineHoldSql` does.
 *
 * Two shapes of OPEN MAIN_SYNC `INTEGRATION_CONFLICT` hold the job named `candidate` on the same serial key:
 *
 *  - The line-sync item (`IMS:<serial_key>`, task_id NULL; docs/design/project-line-upstream-sync.md §4.3). It holds
 *    every landing on the line, the conflicted task's own held generation too, except the landings of a task filed
 *    to fix it (`fixes_open_item_id`): that is the sync task, and its landing closes the item (L-T3).
 *  - A legacy task-level item, opened before the line-sync item existed (§4.6 item 7). It keeps its old predicate,
 *    with the conflicted task's own later landings exempt (§3.1 M3), and the item's fix tasks exempt. Bridge: a task
 *    filed to fix the OPEN line-sync item on the same serial key is exempt too, so a sync task is never held by an
 *    older item about the same conflict.
 */
export function lineSyncHoldSql(candidate: string): Prisma.Sql {
  const c = Prisma.raw(candidate);
  return Prisma.sql`
    f."serial_key" = ${c}."serial_key"
    AND f."phase" = 'MAIN_SYNC'
    AND i."kind" = 'INTEGRATION_CONFLICT' AND i."state" = 'OPEN'
    AND (i."dedupe_key" = 'IMS:' || f."serial_key" OR f."task_id" IS DISTINCT FROM ${c}."task_id")
    AND NOT EXISTS (
      SELECT 1 FROM "task" sync_fix
        JOIN "project_open_item" sync_fixed ON sync_fixed."id" = sync_fix."fixes_open_item_id"
       WHERE sync_fix."id" = ${c}."task_id"
         AND (sync_fixed."id" = i."id"
              OR (i."dedupe_key" <> 'IMS:' || f."serial_key"
                  AND sync_fixed."dedupe_key" = 'IMS:' || f."serial_key"
                  AND sync_fixed."state" = 'OPEN')))`;
}
