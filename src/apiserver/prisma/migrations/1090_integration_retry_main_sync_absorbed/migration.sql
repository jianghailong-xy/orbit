-- §3.1 M3: a LAND_TASK that stopped on a CONFLICT at MAIN_SYNC is rerun once the task's branch carries
-- both the project-line tip and main's tip (the next landing skips the main sync and lands by J-S4
-- MERGE). The rerun records CONFLICT as the class it reruns.
ALTER TABLE "project_integration_job"
  DROP CONSTRAINT "project_integration_job_retry_failure_class_chk",
  ADD CONSTRAINT "project_integration_job_retry_failure_class_chk" CHECK (
    "retry_failure_class" IS NULL
    OR "retry_failure_class" IN ('CHECK_FAILED', 'CHECK_TIMED_OUT', 'ERROR', 'BASELINE_RED', 'CONFLICT'));
