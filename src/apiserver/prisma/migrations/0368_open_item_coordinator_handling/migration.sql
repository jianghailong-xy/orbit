-- 0368 — an exception item the project's coordinator is handling, and how that handling ended
-- (docs/project-integration-line-contract.md §4.1, §4.2, §4.7 H1–H5).
--
-- WHAT IT ADDS
-- ============
-- Five nullable columns on `project_open_item`, NULL on every row that was not handled this way:
--   * `handling_job_id` — the integration job the coordinator's rerun queued (`integration_retry`):
--     a DONE task's next LAND_TASK generation, or a blocked candidate's next CHECK_PROMOTION. History
--     with no foreign key, like `session_id`: a terminal item is never rewritten
--     (`project_open_item_terminal_guard`), so an ON DELETE SET NULL pointing here would be an UPDATE
--     the guard refuses.
--   * `handling_session_id` — the coordinator conversation that asked for the rerun.
--   * `handling_reason` — the sentence it gave for why the rerun would come out differently.
--   * `handling_started_at` — when it asked.
--   While that job is QUEUED or RUNNING the item stays OPEN and reads as being handled. It is not
--   closed early: the rerun can still fail.
--   * `resolved_by_job_id` — the integration job whose terminal state ended the item: the rerun that
--     landed or passed its check (RESOLVED / HANDLED), or the one that failed again (SUPERSEDED /
--     RETRIED, beside `superseded_by_item_id` naming the new item that failure opened).
-- One partial index, over OPEN rows, finds the items a finished job was handling.
--
-- `project_integration_job_retry_kind_chk` is widened to admit CHECK_PROMOTION: a blocked candidate's
-- check run again on purpose carries the same four retry columns 0344 gave a task's landing — what it
-- reruns, the failure class, why, and who asked.
--
-- BACKWARD COMPATIBLE
-- ===================
-- Catalog-only ADD COLUMNs with no default; CHECKs every stored row satisfies because all five
-- columns read NULL in it; and a job CHECK replaced by a superset of itself. No row is written, and no
-- trigger, function or type is created, replaced or dropped. Validating the CHECKs reads both tables
-- once under the ACCESS EXCLUSIVE lock the ALTERs take; both are small.
--
-- LOCK ORDER
-- ==========
-- The columns are written by the two writers that already write these rows: the coordinator's rerun
-- (task row FOR NO KEY UPDATE, or the candidate row FOR NO KEY UPDATE, then the item by primary key)
-- and the job-result transaction (the job row, then its items) — no new lock is taken.

BEGIN;

ALTER TABLE "project_open_item"
  ADD COLUMN "handling_job_id" uuid,
  ADD COLUMN "handling_session_id" uuid,
  ADD COLUMN "handling_reason" text,
  ADD COLUMN "handling_started_at" TIMESTAMPTZ(3),
  ADD COLUMN "resolved_by_job_id" uuid,
  -- All four or none: a rerun that does not say which job, who asked, why or when is not one.
  ADD CONSTRAINT "project_open_item_handling_chk" CHECK (
    ("handling_job_id" IS NULL) = ("handling_session_id" IS NULL)
    AND ("handling_job_id" IS NULL) = ("handling_reason" IS NULL)
    AND ("handling_job_id" IS NULL) = ("handling_started_at" IS NULL)),
  ADD CONSTRAINT "project_open_item_handling_reason_chk" CHECK (
    "handling_reason" IS NULL OR char_length(btrim("handling_reason")) BETWEEN 1 AND 2000),
  -- Only an integration failure is rerun: a task's failure is answered by the task moving on.
  ADD CONSTRAINT "project_open_item_handling_kind_chk" CHECK (
    "handling_job_id" IS NULL
    OR "kind" IN ('INTEGRATION_CONFLICT', 'INTEGRATION_CHECK_FAILED', 'INTEGRATION_ERROR')),
  -- A job ends an item; it does not hold one open.
  ADD CONSTRAINT "project_open_item_resolved_by_job_chk" CHECK (
    "resolved_by_job_id" IS NULL OR "state" <> 'OPEN');

CREATE INDEX "project_open_item_handling_job_open_idx"
  ON "project_open_item" ("handling_job_id")
  WHERE "state" = 'OPEN' AND "handling_job_id" IS NOT NULL;

ALTER TABLE "project_integration_job"
  DROP CONSTRAINT "project_integration_job_retry_kind_chk",
  -- A task's landing and a candidate's check are rerun on purpose; a candidate's landing is not —
  -- it is re-checked first, and its merge stays the owner's or the Automatic setting's to confirm.
  ADD CONSTRAINT "project_integration_job_retry_kind_chk" CHECK (
    "retry_of_job_id" IS NULL OR "kind" IN ('LAND_TASK', 'CHECK_PROMOTION'));

COMMIT;
