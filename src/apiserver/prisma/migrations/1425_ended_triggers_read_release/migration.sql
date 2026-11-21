-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1425: the three "ended" triggers read the release fact (docs/session-three-state-plan.md §7 step 4.4, appendix
-- A of docs/session-three-state-read-sites.md; project 3508bDBDE5xPH43TYuiqP).
--
-- WHAT IT CHANGES
-- ---------------
-- Three AFTER UPDATE triggers on session, re-created in place with CREATE OR REPLACE TRIGGER (same name, timing
-- and function). Each WHEN clause asks "released" as finished_at and "was the release a failure" as release_cause,
-- instead of listing terminal statuses, and each column list gains "finished_at". The functions are not changed.
--
--   session_request_recipient_ended (0350)
--     was  OR NEW."status" IN ('SUCCEEDED', 'CANCELLED')
--          OR (NEW."status" = 'FAILED' AND <no retry armed or being taken>)
--     now  OR (NEW."finished_at" IS NOT NULL
--              AND (NEW."release_cause" NOT IN (<the failure causes>) OR <no retry armed or being taken>))
--   session_request_asker_stopped (0352, re-created by 0366): the same two lines, same change.
--   task_owner_confirmation_review_reviewer_ended (0507)
--     was  OR NEW."status" IN ('SUCCEEDED', 'CANCELLED')
--          OR (NEW."status" IN ('FAILED', 'INTERRUPTED') AND COALESCE(NEW."end_reason", '') <> '')
--     now  OR (NEW."finished_at" IS NOT NULL
--              AND (NEW."release_cause" NOT IN (<the failure causes>) OR COALESCE(NEW."end_reason", '') <> ''))
--          OR (NEW."status" = 'INTERRUPTED' AND COALESCE(NEW."end_reason", '') <> '')
--   <the failure causes> is written out: 'turn_failed', 'runner_lost', 'setup_failed', 'engine_failed',
--   'end_not_honored', 'import_failed', common/session-release.ts FAILURE_RELEASE_CAUSES, the causes every writer
--   records exactly with FAILED. sessions/session-release.pg.spec.ts (12) asserts the list in each of the three WHEN
--   clauses equals FAILURE_RELEASE_CAUSES, so a seventh cause cannot be added in one place.
--   The deleted/completed/archived branches, the INTERRUPTED-with-an-end branch and asker_stopped's AWAITING_INPUT
--   branch are unchanged: INTERRUPTED and AWAITING_INPUT are held statuses (finished_at null), read here as the
--   turn and retry facts they are. No terminal status value is named in any of the three clauses.
--   session_request_recipient_ended's function still writes NEW."status"::text into close_reason
--   (STATUS[:end_reason], unchanged, by the coordinator's ruling): a read of the legacy word for display, not a
--   decision.
--
-- WHY EVERY STORED ROW GETS THE SAME ANSWER
-- -----------------------------------------
-- One validated CHECK and the writers. session_release_fact_chk (1401/1402): finished_at is set exactly when the
-- status is SUCCEEDED, FAILED or CANCELLED. Every writer that sets finished_at also sets release_cause, and sets a
-- failure cause exactly when it writes FAILED (1403/1404 and their writers, deploy 1 on). So inside "finished_at is
-- set", "release_cause is not a failure cause" is "SUCCEEDED or CANCELLED", and "a failure cause" is "FAILED": every
-- WHEN answers what it did, for every row those writers leave.
-- Not a CHECK since 2026-11-21 (design §12 decision D9, removal step R1): the CHECKs that held the cause to
-- finished_at and to FAILED were taken off the project branch before they were deployed, because the session keeps
-- no failure fact and release_cause goes. These three WHEN clauses still read the cause; the readers step (design
-- §12.6 R4) restates them on the turn outcome and the end reason before any writer stops writing the cause (R5). A
-- released row with no cause (none is written before R5) would read here as a failure.
--
-- WHICH RELEASE IT MAY SHIP IN
-- ----------------------------
-- Only after a release whose writers record the failure causes (1403/1404 and their writers). The new clauses equal
-- the old ones only for rows those writers leave: a replica from before them records engine_exited for a FAILED
-- finalize, which these clauses would read as an end. In the owner's plan that is deploy 2; the writers and
-- 1403/1404 are in deploy 1. Rows released before deploy 1 that are FAILED with a clean-end cause (1262 gave them
-- engine_exited or their end reason) are the exception: the backfill that rewrote their causes went with the CHECKs
-- (R1), so on such a row these clauses can answer otherwise than the old status clauses did. The readers step (R4)
-- restates the three clauses within the same deploy, so this file's clauses never serve on their own.
--
-- WHY THE COLUMN LISTS
-- --------------------
-- An AFTER UPDATE OF trigger does not fire for a write naming none of its columns (the restore() case 0130
-- describes). Every session write that sets or clears finished_at today also names status (the eight release
-- writers, the revive), so adding the column adds no firing now; it keeps the triggers firing on the release
-- fact once a write may carry it without the status word. release_cause is read but not listed: every writer moves a
-- cause across the failure line only with the status (FAILED to or from another value) and sets or clears it only
-- with finished_at, both listed; a cause renamed within one side leaves every clause's answer as it was, so a write
-- naming release_cause alone never changes what these triggers would decide.
--
-- LOCKS
-- -----
-- CREATE OR REPLACE TRIGGER takes SHARE ROW EXCLUSIVE on session: asked for in one DO statement, 2 s at a time,
-- 1 s apart, up to 45 tries, as 1261 does. No function, column, constraint, index or type; no row written.
-- How it is sent: the file holds a DO block, so prisma migrate deploy (7.10) sends it whole, as one transaction:
-- its three trigger re-creations commit together, and the trigger locks are held until that one commit. Nothing
-- in it COMMITs. sessions/session-release.pg.spec.ts (12) applies it that way, with deployAgain, on a database
-- holding rows.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 1425: after 1424 (rescanned 2026-11-21). Not a multiple of 10. Can run twice: CREATE OR REPLACE TRIGGER.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      CREATE OR REPLACE TRIGGER "session_request_recipient_ended"
        AFTER UPDATE OF "status", "end_reason", "retry_at", "retry_attempts", "finished_at", "completed_at", "archived_at", "deleted_at"
        ON "session"
        FOR EACH ROW
        WHEN (
          NEW."deleted_at" IS NOT NULL
          OR NEW."completed_at" IS NOT NULL
          OR NEW."archived_at" IS NOT NULL
          OR (NEW."finished_at" IS NOT NULL
              AND (NEW."release_cause" NOT IN ('turn_failed', 'runner_lost', 'setup_failed', 'engine_failed', 'end_not_honored', 'import_failed')
                   OR (NEW."retry_at" IS NULL
                       AND NOT (OLD."retry_at" IS NOT NULL AND NEW."retry_attempts" > OLD."retry_attempts"))))
          OR (NEW."status" = 'INTERRUPTED' AND COALESCE(NEW."end_reason", '') <> '')
        )
        EXECUTE FUNCTION "session_request_recipient_ended"();

      CREATE OR REPLACE TRIGGER "session_request_asker_stopped"
        AFTER UPDATE OF "status", "end_reason", "retry_at", "retry_attempts", "retry_claimed_at", "finished_at", "completed_at", "archived_at", "deleted_at"
        ON "session"
        FOR EACH ROW
        WHEN (
          NEW."deleted_at" IS NOT NULL
          OR NEW."completed_at" IS NOT NULL
          OR NEW."archived_at" IS NOT NULL
          OR (NEW."finished_at" IS NOT NULL
              AND (NEW."release_cause" NOT IN ('turn_failed', 'runner_lost', 'setup_failed', 'engine_failed', 'end_not_honored', 'import_failed')
                   OR (NEW."retry_at" IS NULL
                       AND NOT (OLD."retry_at" IS NOT NULL AND NEW."retry_attempts" > OLD."retry_attempts"))))
          OR (NEW."status" = 'INTERRUPTED' AND COALESCE(NEW."end_reason", '') <> '')
          OR (NEW."status" = 'AWAITING_INPUT' AND NEW."retry_at" IS NULL
              AND ((OLD."retry_at" IS NOT NULL AND NEW."retry_attempts" <= OLD."retry_attempts")
                   OR NEW."retry_attempts" < OLD."retry_attempts"
                   OR (OLD."retry_claimed_at" IS NOT NULL AND NEW."retry_claimed_at" IS NULL)))
        )
        EXECUTE FUNCTION "session_request_asker_stopped"();

      CREATE OR REPLACE TRIGGER "task_owner_confirmation_review_reviewer_ended"
        AFTER UPDATE OF "status", "end_reason", "finished_at", "completed_at", "archived_at", "deleted_at"
        ON "session"
        FOR EACH ROW
        WHEN (
          NEW."deleted_at" IS NOT NULL
          OR NEW."completed_at" IS NOT NULL
          OR NEW."archived_at" IS NOT NULL
          OR (NEW."finished_at" IS NOT NULL
              AND (NEW."release_cause" NOT IN ('turn_failed', 'runner_lost', 'setup_failed', 'engine_failed', 'end_not_honored', 'import_failed')
                   OR COALESCE(NEW."end_reason", '') <> ''))
          OR (NEW."status" = 'INTERRUPTED' AND COALESCE(NEW."end_reason", '') <> '')
        )
        EXECUTE FUNCTION "task_owner_confirmation_review_reviewer_ended"();
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      tries := tries + 1;
      IF tries >= 45 THEN
        RAISE;
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;
