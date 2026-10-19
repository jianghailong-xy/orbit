-- 0433 — a QUEUED integration job never carries a stop request (docs/project-integration-line-contract.md
-- §2.2 J-T8; revision 23's "叫停一个按 §7.2 V6 已超时的 RUNNING 作业" and the CHECK it allows).
--
-- WHAT WAS WRONG
-- ==============
-- Until now `applyCancel` and `supersedeLiveCandidates` wrote `cancel_requested_at` onto a QUEUED row
-- and left it QUEUED. `claimOne` never handed such a row out, but every in-flight reader counts
-- QUEUED: the project never looked finished, `inFlightJobs` showed a job nobody would ever run, and a
-- managed runner never went to sleep. J-T8 now ends a QUEUED job in the transaction that asks, and
-- this migration makes the old shape impossible in the table itself.
--
-- WHAT IT DOES
-- ============
--   1. Backfills every stored row that is QUEUED and carries a stop request to CANCELLED, with
--      `finished_at` set (the instant it stopped being able to run, which for these rows is now).
--      `cancel_requested_at` stays: it is the fact that was recorded.
--   2. Settles the promotions of those jobs the way M-T10 does: a QUEUED `LAND_PROMOTION` was never
--      claimed and therefore never pushed, so a CONFIRMED / RECHECKING promotion it belongs to ends
--      CANCELLED, and the OPEN `INTEGRATION_*` items about it are RESOLVED `PROMOTION_MOVED_ON` by
--      the platform. (The owner's approval card was answered when the merge was confirmed.)
--   3. Adds `CHECK (state <> 'QUEUED' OR cancel_requested_at IS NULL)` — NOT VALID first, then
--      VALIDATED — so no future writer can recreate the row, including one of the two result paths
--      that send a "judged too early" answer back to QUEUED (both now write CANCELLED when a stop
--      was asked; the two must land together, or the runner's cached result would hit 23514 on every
--      resend).
--
-- RE-RUNNABLE
-- ===========
-- Each statement names only rows that still match: the backfills are idempotent by their predicate,
-- and the constraint is added inside a `duplicate_object` guard and re-validated by a no-op
-- `VALIDATE` when it is already valid. No column, index or trigger is created, dropped or replaced.
--
-- LOCK
-- ====
-- Two UPDATEs over rows selected by a partial state, and one VALIDATE that reads the table once under
-- SHARE UPDATE EXCLUSIVE (it does not block reads or writes). The table is small — one row per
-- landing attempt — so both scans are bounded by its size.

-- 1. The rows themselves. A QUEUED job somebody asked to stop was never claimable; it is over.
UPDATE "project_integration_job"
   SET "state" = 'CANCELLED',
       "finished_at" = COALESCE("finished_at", now()),
       "updated_at" = now()
 WHERE "state" = 'QUEUED'
   AND "cancel_requested_at" IS NOT NULL;

-- 2. The promotions those jobs were landing (M-T10). A QUEUED landing was never claimed, so nothing
--    was pushed and the merge can be called off outright.
UPDATE "project_promotion" p
   SET "state" = 'CANCELLED',
       "decided_at" = COALESCE(p."decided_at", now())
  FROM "project_integration_job" j
 WHERE j."promotion_id" = p."id"
   AND j."kind" = 'LAND_PROMOTION'
   AND j."state" = 'CANCELLED'
   AND j."cancel_requested_at" IS NOT NULL
   AND j."finished_at" IS NOT NULL
   AND p."state" IN ('CONFIRMED', 'RECHECKING');

UPDATE "project_open_item" i
   SET "state" = 'RESOLVED',
       "resolution" = 'PROMOTION_MOVED_ON',
       "resolved_by" = 'PLATFORM',
       "resolved_at" = now()
  FROM "project_integration_job" j
 WHERE j."promotion_id" = i."promotion_id"
   AND j."kind" = 'LAND_PROMOTION'
   AND j."state" = 'CANCELLED'
   AND j."cancel_requested_at" IS NOT NULL
   AND i."state" = 'OPEN'
   AND i."kind" IN ('INTEGRATION_CONFLICT', 'INTEGRATION_CHECK_FAILED', 'INTEGRATION_ERROR');

-- 3. The invariant, from here on.
DO $$ BEGIN
  ALTER TABLE "project_integration_job"
    ADD CONSTRAINT "project_integration_job_queued_cancel_chk"
    CHECK ("state" <> 'QUEUED' OR "cancel_requested_at" IS NULL) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "project_integration_job"
  VALIDATE CONSTRAINT "project_integration_job_queued_cancel_chk";
