-- 1501 — a landing failure goes first to the task's own work session
-- (Written as 1444 on the project line; renumbered when main took 1444 for the claim-index drop.)
-- (docs/project-integration-line-contract.md §12.4, revision 42 part one, ruling R1).
--
-- WHAT IT ADDS
-- ============
-- Four nullable columns on `project_open_item`, NULL on every row that was never handed to a work session:
--   * `work_session_id` — the task's work session the item was handed to first (W4, W5). History with no
--     foreign key, like `session_id`: a session purged from Trash leaves the item as it was.
--   * `work_session_offered_at` — when it was handed over; written with `work_session_id`, both or neither.
--   * `work_session_returned_at` — when it was handed back to the coordinator (W7). NULL while the work
--     session still holds it, or when its landing resolved it.
--   * `work_session_return_reason` — why it was handed back, one of NO_NEW_COMMIT, TURN_FAILED,
--     SESSION_ENDED, ROUNDS_EXHAUSTED, TASK_MOVED_ON; written with `work_session_returned_at`, both or neither.
-- The item's kind, assignee, dedupe key and payload are unchanged: `assignee` stays in its closed set, and who
-- holds the item right now is read from these four columns.
--
-- R1: `project_integration_job_retry_failure_class_chk` (0344, 0513) is widened to admit CONFLICT, so the next
-- generation a work session's fix queues can copy the CONFLICT class of the generation that failed and count
-- toward W8. No other constraint, table or column changes; `retry_kind_chk` already admits CHECK_PROMOTION.
--
-- BACKWARD COMPATIBLE
-- ===================
-- Catalog-only ADD COLUMNs with no default; CHECKs every stored row satisfies because all four columns read
-- NULL in it; and a job CHECK replaced by a superset of itself. No row is written or backfilled: an item open
-- at deploy keeps NULL work-session columns and stays the coordinator's. No trigger, function or type is
-- created, replaced or dropped.
--
-- LOCK ORDER
-- ==========
-- The two columns written at hand-off are written by the INSERT the job-result transaction already makes
-- (`recordIntegrationFailure`, the job row then its item, rank 60); no new lock is taken.

BEGIN;

ALTER TABLE "project_open_item"
  ADD COLUMN "work_session_id" uuid,
  ADD COLUMN "work_session_offered_at" TIMESTAMPTZ(3),
  ADD COLUMN "work_session_returned_at" TIMESTAMPTZ(3),
  ADD COLUMN "work_session_return_reason" text,
  ADD CONSTRAINT "project_open_item_work_session_chk" CHECK (
    ("work_session_id" IS NULL) = ("work_session_offered_at" IS NULL)),
  ADD CONSTRAINT "project_open_item_work_session_return_chk" CHECK (
    ("work_session_returned_at" IS NULL) = ("work_session_return_reason" IS NULL)),
  ADD CONSTRAINT "project_open_item_work_session_return_reason_chk" CHECK (
    "work_session_return_reason" IS NULL
    OR "work_session_return_reason" IN
      ('NO_NEW_COMMIT', 'TURN_FAILED', 'SESSION_ENDED', 'ROUNDS_EXHAUSTED', 'TASK_MOVED_ON'));

ALTER TABLE "project_integration_job"
  DROP CONSTRAINT "project_integration_job_retry_failure_class_chk",
  ADD CONSTRAINT "project_integration_job_retry_failure_class_chk" CHECK (
    "retry_failure_class" IS NULL
    OR "retry_failure_class" IN ('CHECK_FAILED', 'CHECK_TIMED_OUT', 'ERROR', 'BASELINE_RED', 'CONFLICT'));

COMMIT;
