-- 0344 — a landing run again on purpose (docs/project-integration-line-contract.md §2.3 J-T1b).
--
-- WHAT IT ADDS
-- ============
-- Four nullable columns on `project_integration_job`, written only on the LAND_TASK generation a
-- coordinator queued through `integration_retry` and NULL on every other row:
--   * `retry_of_job_id` — the failed generation this one runs again. A history reference with no
--     foreign key, like the session ids on `project_open_item`: a job that reached a terminal state is
--     never rewritten (`project_integration_job_terminal_guard`), so an ON DELETE SET NULL pointing
--     here would be an UPDATE the guard refuses.
--   * `retry_failure_class` — what that generation failed of, frozen when the rerun was asked for:
--     CHECK_FAILED, CHECK_TIMED_OUT or ERROR. A conflict is not among them — only a branch that
--     changed answers one, so it is reworked rather than rerun.
--   * `retry_reason` — the sentence the requester gave for why this run will come out differently.
--   * `retry_requested_by_session_id` — the coordinator conversation that asked.
--
-- WHY ON THE JOB
-- ==============
-- The platform never reruns a failed landing by itself (J5), so the reason is the whole record of why
-- a second generation exists. The exception item about the failure is superseded with the same
-- reason when one is still open, but one is not always open — a coordinator may already have closed
-- it by hand — and the new generation is the one row every rerun has.
--
-- BACKWARD COMPATIBLE
-- ===================
-- Catalog-only ADD COLUMNs with no default, and CHECKs that every stored row satisfies because all
-- four columns read NULL in it. No row is read or written, and no trigger, function or type is
-- created, replaced or dropped.

ALTER TABLE "project_integration_job"
  ADD COLUMN "retry_of_job_id" uuid,
  ADD COLUMN "retry_failure_class" text,
  ADD COLUMN "retry_reason" text,
  ADD COLUMN "retry_requested_by_session_id" uuid,
  -- All four or none: a rerun that does not say what it reruns, why, or who asked is not one.
  ADD CONSTRAINT "project_integration_job_retry_chk" CHECK (
    ("retry_of_job_id" IS NULL) = ("retry_failure_class" IS NULL)
    AND ("retry_of_job_id" IS NULL) = ("retry_reason" IS NULL)
    AND ("retry_of_job_id" IS NULL) = ("retry_requested_by_session_id" IS NULL)),
  ADD CONSTRAINT "project_integration_job_retry_failure_class_chk" CHECK (
    "retry_failure_class" IS NULL
    OR "retry_failure_class" IN ('CHECK_FAILED', 'CHECK_TIMED_OUT', 'ERROR')),
  ADD CONSTRAINT "project_integration_job_retry_reason_chk" CHECK (
    "retry_reason" IS NULL OR char_length(btrim("retry_reason")) BETWEEN 1 AND 2000),
  -- A promotion's job is not one task's landing, and nothing reruns one through this door.
  ADD CONSTRAINT "project_integration_job_retry_kind_chk" CHECK (
    "retry_of_job_id" IS NULL OR "kind" = 'LAND_TASK');
