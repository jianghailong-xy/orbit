-- 0380 — the account owner's integration retry door.
--
-- A retry is still one explicit decision, but its requester may now be the account owner as well
-- as the project's coordinator.  The requester columns are an XOR: a generation cannot be
-- attributed to both channels (or to neither).  The same attribution is carried by the open-item
-- handling columns so H1–H5 can close an owner's item as USER and preserve that owner on a second
-- failure.

BEGIN;

ALTER TABLE "project_integration_job"
  ADD COLUMN "retry_requested_by_user_id" uuid,
  DROP CONSTRAINT "project_integration_job_retry_chk",
  ADD CONSTRAINT "project_integration_job_retry_chk" CHECK (
    ("retry_of_job_id" IS NULL) = ("retry_failure_class" IS NULL)
    AND ("retry_of_job_id" IS NULL) = ("retry_reason" IS NULL)
    AND (
      ("retry_of_job_id" IS NULL AND "retry_requested_by_session_id" IS NULL
        AND "retry_requested_by_user_id" IS NULL)
      OR ("retry_of_job_id" IS NOT NULL
        AND (("retry_requested_by_session_id" IS NOT NULL)
          <> ("retry_requested_by_user_id" IS NOT NULL)))
    ));

ALTER TABLE "project_open_item"
  ADD COLUMN "handling_user_id" uuid,
  DROP CONSTRAINT "project_open_item_handling_chk",
  ADD CONSTRAINT "project_open_item_handling_chk" CHECK (
    ("handling_job_id" IS NULL) = ("handling_reason" IS NULL)
    AND ("handling_job_id" IS NULL) = ("handling_started_at" IS NULL)
    AND (
      ("handling_job_id" IS NULL AND "handling_session_id" IS NULL
        AND "handling_user_id" IS NULL)
      OR ("handling_job_id" IS NOT NULL
        AND (("handling_session_id" IS NOT NULL) <> ("handling_user_id" IS NOT NULL)))
    ));

COMMIT;
