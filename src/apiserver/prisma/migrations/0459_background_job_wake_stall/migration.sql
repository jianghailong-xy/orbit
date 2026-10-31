-- 0459 — a background job's stall wake (docs/long-running-loop-contract.md §2).
--
-- A job the agent starts with `bg_run({wakeOnStall: {afterSeconds}})` wakes its session when it is still running
-- and has written nothing for that long (runner-go background_job.go watchForStall). The runner reports it on the
-- same door as an exit or output wake, POST /runner/sessions/:id/background-wake, with `trigger: 'stall'`, and the
-- control plane keeps it in `background_job_wake` beside the turn that delivers it (runner-api/background-job-wake.ts).
--
--   background_job_wake_trigger_check   Dropped and added back under the same name, widened by 'stall'. Every stored
--                                       row reads 'exit' or 'output', which the wider set admits.
--   background_job_wake.elapsed_ms      BIGINT. How long the job had run when its stall wake was sent, as the runner
--                                       measured it. NULL on an exit or output wake.
--   background_job_wake.idle_ms         BIGINT. How long it had written nothing by then. NULL on an exit or output wake.
--   background_job_wake.last_output_at  TIMESTAMPTZ(3). When it last wrote anything, on the control plane's clock:
--                                       the instant the wake was received less idle_ms. A duration crosses from the
--                                       runner's clock intact and an instant would not (sessions/background-job-activity.ts).
--                                       NULL on an exit or output wake.
--
-- Catalog-only ADD COLUMNs, nullable with no default: no table is rewritten and no row is read, written or backfilled.
-- Adding the CHECK back reads the stored rows to validate them and writes none. No index, trigger, function or type is
-- created, replaced or dropped.
--
-- 0459: the number the project gave this change (0458 is the server-held loop's), free on main and on every ref of
-- this repository (2026-10-31). Every statement can run twice.

ALTER TABLE "background_job_wake" DROP CONSTRAINT IF EXISTS "background_job_wake_trigger_check";
ALTER TABLE "background_job_wake"
  ADD CONSTRAINT "background_job_wake_trigger_check" CHECK ("trigger" IN ('exit', 'output', 'stall'));

ALTER TABLE "background_job_wake" ADD COLUMN IF NOT EXISTS "elapsed_ms" BIGINT;
ALTER TABLE "background_job_wake" ADD COLUMN IF NOT EXISTS "idle_ms" BIGINT;
ALTER TABLE "background_job_wake" ADD COLUMN IF NOT EXISTS "last_output_at" TIMESTAMPTZ(3);
