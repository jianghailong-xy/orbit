-- Disk headroom: report it per working directory, and let a runner refuse work below a floor.
--
-- The heartbeat carried quota but never storage, so nothing in the control plane could tell that
-- a machine was about to run out of disk. On a fleet whose whole job is writing large files that
-- is not a task failure, it is an outage — and the failure mode is silent: runs keep being
-- dispatched, each one filling the volume a little further.
--
-- Measured per workspace rather than per runner. One machine's workspaces can sit on different
-- mounts, and the only figure that can gate a run is the one for the filesystem that run will
-- actually write to; a machine-wide number would be right for some workspaces and a fiction for
-- the rest. The runner already stats each work dir every heartbeat for the exists/is-git flags,
-- so this rides along on a probe that was happening anyway.
--
-- BIGINT because a multi-terabyte volume overflows INTEGER.
--
-- NULL is load-bearing and means "unknown", never "full": an older runner, a missing path and a
-- platform with no answer all report nothing, and a gate that read those as exhaustion would
-- stop a fleet on the strength of having no information about it.
ALTER TABLE "workspace" ADD COLUMN "work_dir_free_bytes" BIGINT;
ALTER TABLE "workspace" ADD COLUMN "work_dir_total_bytes" BIGINT;

-- The floor itself, in MB. NULL leaves the gate off, which is what every runner did before this
-- column existed, so nothing changes until someone sets one.
ALTER TABLE "runner" ADD COLUMN "min_free_disk_mb" INTEGER;
