import { Prisma } from '@prisma/client';

/**
 * Keep Free's hold on a session that has not started yet: while its workspace's filesystem has less free than its
 * runner's floor (Runner.minFreeDiskMb), it stays queued, whether started by hand or by a task's Run Now. A spawn
 * (session_create) is refused before it is written instead, with the reason, since the agent that asked would wait on a
 * child that never starts (spawnFromSession). The auto-run sweep holds a task's run before it is a session
 * (diskBelowFloor, below); this is the same comparison for every session that gets past it.
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

/**
 * Is this workspace's filesystem below its runner's free-space floor, so no new work should be
 * dispatched onto it?
 *
 * Fail-open on every kind of missing information — no floor configured, or no reading from the
 * runner (too old to measure, work dir gone, a platform with no answer). A disk gate that fired
 * on absent telemetry would stop a fleet precisely because it knew nothing about it, and the
 * failure it is guarding against (a volume filling up) is one that its own silence cannot
 * evidence. The gate is only as good as the reading, and no reading means no gate.
 *
 * bigint throughout: a multi-terabyte volume's byte count is past Number.MAX_SAFE_INTEGER.
 */
export function diskBelowFloor(
  freeBytes: bigint | null | undefined,
  minFreeDiskMb: number | null | undefined,
): boolean {
  if (freeBytes == null) return false;
  if (minFreeDiskMb == null || !Number.isFinite(minFreeDiskMb) || minFreeDiskMb <= 0) return false;
  return freeBytes < BigInt(Math.floor(minFreeDiskMb)) * 1024n * 1024n;
}
