import { Prisma } from '@prisma/client';

/**
 * Keep Free's hold on a session that has not started yet: while its workspace's filesystem has less free than its
 * runner's floor (Runner.minFreeDiskMb), it stays queued, however it was started — by hand, a task's Run Now, a spawn.
 * The auto-run sweep holds a task's run before it is a session (diskBelowFloor in tasks.service.ts); this is the same
 * comparison for every session that gets past it.
 *
 * Only a session's first run: one that has started (started_at) takes its next message whatever the disk, so an agent
 * on a full machine can still be asked to free space. Fail-open as diskBelowFloor is: no floor, or no reading of the
 * workspace's free space, holds nothing.
 *
 * Two callers agree on it exactly: the session claim, which hands a held session no slot, and the session list, which
 * names the gate to the person waiting (queuedReason).
 */
export const RUNNER_DISK_BELOW_FLOOR = 'disk_below_floor';

/** True while the session `alias` names has never run and its workspace is below its runner's floor. */
export function sessionDiskHoldSql(alias: string): Prisma.Sql {
  const s = Prisma.raw(alias);
  return Prisma.sql`(${s}."started_at" IS NULL AND EXISTS (
    SELECT 1 FROM "workspace" disk_gate_w
      JOIN "runner" disk_gate_r ON disk_gate_r."id" = ${s}."assigned_runner_id"
     WHERE disk_gate_w."id" = ${s}."workspace_id"
       AND disk_gate_w."work_dir_free_bytes" IS NOT NULL
       AND disk_gate_r."min_free_disk_mb" > 0
       AND disk_gate_w."work_dir_free_bytes" < disk_gate_r."min_free_disk_mb"::bigint * 1048576
  ))`;
}
