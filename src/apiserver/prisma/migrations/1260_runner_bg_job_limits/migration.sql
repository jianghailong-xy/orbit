-- 1260 — per-runner limits on background jobs.
--
-- The owner may limit the CPU and memory of each background job (bg_run) a machine runs. NULL is no limit on that
-- dimension; both NULL, which every existing runner keeps, is limits off. The columns are handed to the runner in
-- every heartbeat answer.

ALTER TABLE "runner"
  ADD COLUMN IF NOT EXISTS "bg_job_cpus" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "bg_job_memory_mb" INTEGER;
