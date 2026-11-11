-- K3 records attribution only. Retry remains an explicit request, like CHECK_FAILED.
ALTER TABLE "project_integration_job"
  ADD COLUMN "baseline_red" boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT "project_integration_job_baseline_red_chk" CHECK (
    NOT "baseline_red" OR ("kind" = 'LAND_TASK' AND "state" = 'CHECK_FAILED'));
ALTER TABLE "project_integration_job"
  DROP CONSTRAINT "project_integration_job_retry_failure_class_chk",
  ADD CONSTRAINT "project_integration_job_retry_failure_class_chk" CHECK (
    "retry_failure_class" IS NULL
    OR "retry_failure_class" IN ('CHECK_FAILED', 'CHECK_TIMED_OUT', 'ERROR', 'BASELINE_RED'));
