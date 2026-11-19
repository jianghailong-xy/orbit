-- Landing checks are mutable after integration starts, like merge checks. The 0270 lock
-- trigger deliberately does not name either of these columns.
ALTER TABLE "project_codebase"
  ADD COLUMN "landing_check_command" text,
  ADD COLUMN "landing_check_timeout_seconds" integer,
  ADD CONSTRAINT "project_codebase_landing_check_timeout_positive"
    CHECK ("landing_check_timeout_seconds" > 0);

-- Both durable check-name readers must accept the landing layer, including streamed output.
ALTER TABLE "project_integration_job_event"
  DROP CONSTRAINT "project_integration_job_event_check_name_chk",
  ADD CONSTRAINT "project_integration_job_event_check_name_chk"
    CHECK ("check_name" IS NULL OR "check_name" IN ('TASK_ACCEPTANCE', 'MERGE_CHECK', 'LANDING_CHECK'));
ALTER TABLE "project_integration_job_log"
  DROP CONSTRAINT "project_integration_job_log_check_name_chk",
  ADD CONSTRAINT "project_integration_job_log_check_name_chk"
    CHECK ("check_name" IN ('TASK_ACCEPTANCE', 'MERGE_CHECK', 'LANDING_CHECK'));
