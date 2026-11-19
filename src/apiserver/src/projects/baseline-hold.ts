import { Prisma } from '@prisma/client';

/** K4: shared by dispatch and the task reader. The caller joins item i to its failed job f. */
export function baselineHoldSql(candidate: string): Prisma.Sql {
  const c = Prisma.raw(candidate);
  return Prisma.sql`
    ${c}."kind" = 'LAND_TASK'
    AND f."serial_key" = ${c}."serial_key"
    AND f."baseline_red" = true
    AND i."kind" = 'INTEGRATION_CHECK_FAILED' AND i."state" = 'OPEN'
    AND NOT EXISTS (
      SELECT 1 FROM "task" baseline_fix
       WHERE baseline_fix."id" = ${c}."task_id"
         AND baseline_fix."fixes_open_item_id" = i."id")`;
}
