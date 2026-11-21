-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1415: the three "ended" triggers read the release fact (docs/session-three-state-plan.md §7 step 4.4, appendix
-- A of docs/session-three-state-read-sites.md; project 3508bDBDE5xPH43TYuiqP).
--
-- WHAT IT CHANGES
-- ---------------
-- Three AFTER UPDATE triggers on session, re-created in place with CREATE OR REPLACE TRIGGER (same name, timing
-- and function). Each WHEN clause asks "released" as finished_at instead of listing terminal statuses, and each
-- column list gains "finished_at". The functions they run are not changed.
--
--   session_request_recipient_ended (0350)
--     was  OR NEW."status" IN ('SUCCEEDED', 'CANCELLED')
--          OR (NEW."status" = 'FAILED' AND <no retry armed or being taken>)
--     now  OR (NEW."finished_at" IS NOT NULL
--              AND (NEW."status" <> 'FAILED' OR <no retry armed or being taken>))
--   session_request_asker_stopped (0352, re-created by 0366): the same two lines, same change.
--   task_owner_confirmation_review_reviewer_ended (0507)
--     was  OR NEW."status" IN ('SUCCEEDED', 'CANCELLED')
--          OR (NEW."status" IN ('FAILED', 'INTERRUPTED') AND COALESCE(NEW."end_reason", '') <> '')
--     now  OR (NEW."finished_at" IS NOT NULL AND (NEW."status" <> 'FAILED' OR COALESCE(NEW."end_reason", '') <> ''))
--          OR (NEW."status" = 'INTERRUPTED' AND COALESCE(NEW."end_reason", '') <> '')
--   The deleted/completed/archived branches, the INTERRUPTED-with-an-end branch and asker_stopped's
--   AWAITING_INPUT branch are unchanged: INTERRUPTED and AWAITING_INPUT are held statuses (finished_at null),
--   read here as the turn and retry facts they are, not as "released".
--
-- KEPT: ONE TERMINAL LITERAL PER CLAUSE, 'FAILED'
-- -----------------------------------------------
-- kept: the release does not yet record whether it was a failure. All three clauses treat a FAILED release
-- apart from the other two: the request triggers wait while the auto-retry sweep may revive it (the sweep
-- revives FAILED rows only), and the review trigger waits unless an end was asked for. release_cause cannot
-- stand in: engine_exited is written for a SUCCEEDED and a FAILED finalize alike (the runner's own value), and
-- cancelled / completed / deleted for a FAILED "cancel not honoured" reap as well as for a CANCELLED finalize.
-- So `NEW."status" <> 'FAILED'` stays, once in each WHEN clause, until a failure fact on the release exists
-- (the coordinator's follow-up task); it is the only terminal word left in these three triggers.
-- session_request_recipient_ended's function also still writes NEW."status"::text into close_reason
-- (STATUS[:end_reason], unchanged): a read of the legacy word for display to the asker, not a decision.
--
-- WHY EVERY STORED ROW GETS THE SAME ANSWER
-- -----------------------------------------
-- session_release_fact_chk (1401/1402): finished_at is set exactly when the status is SUCCEEDED, FAILED or
-- CANCELLED. So "finished_at set and status not FAILED" is "SUCCEEDED or CANCELLED", and "finished_at set,
-- status FAILED, no retry" is the old FAILED branch; for the review trigger, "finished_at set and (not FAILED or
-- an end reason)" is "SUCCEEDED or CANCELLED, or FAILED with an end reason". Every WHEN answers what it did.
--
-- WHY THE COLUMN LISTS
-- --------------------
-- An AFTER UPDATE OF trigger does not fire for a write naming none of its columns (the restore() case 0130
-- describes). Every session write that sets or clears finished_at today also names status (the eight release
-- writers, the revive), so adding the column adds no firing now; it keeps the triggers firing on the release
-- fact once a write may carry it without the status word.
--
-- LOCKS
-- -----
-- CREATE OR REPLACE TRIGGER takes SHARE ROW EXCLUSIVE on session: asked for in one DO statement, 2 s at a time,
-- 1 s apart, up to 45 tries, as 1261 does. No function, column, constraint, index or type; no row written.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 1415: after 1414 (rescanned 2026-11-21). Not a multiple of 10. Can run twice: CREATE OR REPLACE TRIGGER.
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
              AND (NEW."status" <> 'FAILED'
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
              AND (NEW."status" <> 'FAILED'
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
              AND (NEW."status" <> 'FAILED' OR COALESCE(NEW."end_reason", '') <> ''))
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
