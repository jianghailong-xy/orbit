-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1425: the three "ended" triggers read the release fact (docs/session-three-state-plan.md §7 step 4.4, appendix
-- A of docs/session-three-state-read-sites.md), restated on 2026-11-21 on the turn outcome and the end reason (design
-- §12.3, decision D9, removal step R4; project 3508bDBDE5xPH43TYuiqP). Not deployed before the restatement: edited in
-- place, under the same name.
--
-- WHAT IT CHANGES
-- ---------------
-- Three AFTER UPDATE triggers on session, re-created in place with CREATE OR REPLACE TRIGGER (same name, timing
-- and function). Each WHEN clause asks "released" as finished_at and "was the release a failure" as the release
-- module asks it (common/session-release.ts releaseWasFailureSql, written out with NEW as the row), instead of
-- listing terminal statuses, and each column list gains "finished_at" and "last_turn_outcome". The functions are not
-- changed. <failed> below is that fragment, the whole reading:
--
--   (NEW."finished_at" IS NOT NULL AND NEW."end_reason" IS NULL
--    AND (NEW."last_turn_outcome" IS NOT DISTINCT FROM 'FAILED' OR NEW."status" = 'FAILED'))
--
--   session_request_recipient_ended (0350)
--     was  OR NEW."status" IN ('SUCCEEDED', 'CANCELLED')
--          OR (NEW."status" = 'FAILED' AND <no retry armed or being taken>)
--     now  OR (NEW."finished_at" IS NOT NULL AND (NOT <failed> OR <no retry armed or being taken>))
--   session_request_asker_stopped (0352, re-created by 0366): the same two lines, same change.
--   task_owner_confirmation_review_reviewer_ended (0507)
--     was  OR NEW."status" IN ('SUCCEEDED', 'CANCELLED')
--          OR (NEW."status" IN ('FAILED', 'INTERRUPTED') AND COALESCE(NEW."end_reason", '') <> '')
--     now  OR (NEW."finished_at" IS NOT NULL AND NOT <failed>)
--          OR (NEW."status" = 'INTERRUPTED' AND COALESCE(NEW."end_reason", '') <> '')
--     (released and not failed: <failed> already asks for no end reason, so "or an end reason" adds nothing)
--   The deleted/completed/archived branches, the INTERRUPTED-with-an-end branch and asker_stopped's AWAITING_INPUT
--   branch are unchanged: INTERRUPTED and AWAITING_INPUT are held statuses (finished_at null), read here as the
--   turn and retry facts they are. No release_cause is read. session_request_recipient_ended's function still writes
--   NEW."status"::text into close_reason (STATUS[:end_reason], unchanged, by the coordinator's ruling): a read of the
--   legacy word for display, not a decision.
--
-- THE 'FAILED' LITERAL IS THE BRIDGE
-- ----------------------------------
-- The one terminal status the three clauses name, NEW."status" = 'FAILED' inside <failed>, is the status bridge of
-- design §12.6 (fact 1), the same arm as FAILED_STATUS_BRIDGE in common/session-release.ts: a deploy-1 server still
-- releases sessions during deploy 2's hand-over, after this file has run, and its reaper, finalize, refused source
-- and import record a failure in the status alone. Without the arm such a release with a retry armed would close its
-- open requests as ended. Removal step R7 (task 351QPAh8wuz6nl3n1ghm2, deploy 3, after R6 backfills the turn
-- outcome) re-creates the three triggers without it, in a migration of its own. sessions/session-release.pg.spec.ts
-- (12) holds each WHEN clause of this file to releaseWasFailureSql('NEW') character for character, so the two
-- spellings cannot drift.
--
-- WHERE THE ANSWER IS THE OLD ONE
-- -------------------------------
-- session_release_fact_chk (1401/1402): finished_at is set exactly when the status is SUCCEEDED, FAILED or CANCELLED.
-- Every writer that releases a session after a failure writes FAILED and records it on the turn that carries it,
-- copied to last_turn_outcome in the same statement (design §12.1, removal step R2), and FAILED exactly then. So for
-- every row with no end reason: a FAILED release is <failed> and a SUCCEEDED or CANCELLED one is not, and each clause
-- answers what the status clause it replaced did. The answers that change, both by design (§12.3, W7's rule): a row
-- released FAILED with an end reason recorded (an end that was asked for and not honoured, end_not_honored; a source
-- refused after an end was asked) is not a failure but a stop, so with a retry still armed recipient_ended and
-- asker_stopped now fire for it where the old clause waited for the retry. And one shape no writer is known to leave
-- (a late failed completion copied onto an idle session, then a release with no end asked and no failure and no turn
-- to cut off): it reads as a failure here and not in the old clauses. sessions/session-release.pg.spec.ts (12) drives
-- every release shape of design §12.2 through these clauses and the old ones and prints both.
--
-- WHICH RELEASE IT MAY SHIP IN
-- ----------------------------
-- Deploy 2: with the writers of removal step R2 (they record the turn outcome) and the readers of R3/R4 (the same
-- reading in TypeScript). A deploy-1 replica's releases during the hand-over are read through the bridge above.
--
-- WHY THE COLUMN LISTS
-- --------------------
-- An AFTER UPDATE OF trigger does not fire for a write naming none of its columns (the restore() case 0130
-- describes). Every session write that sets or clears finished_at today also names status (the eight release
-- writers, the revive), so adding finished_at adds no firing now; it keeps the triggers firing on the release fact
-- once a write may carry it without the status word. last_turn_outcome is listed because <failed> reads it: a write
-- naming the turn outcome without the status word (turn-complete copies an outcome onto a session it does not park,
-- runner-api.controller.ts) moves what <failed> answers, and the triggers must see it. release_cause is not read.
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
        AFTER UPDATE OF "status", "end_reason", "retry_at", "retry_attempts", "finished_at", "last_turn_outcome", "completed_at", "archived_at", "deleted_at"
        ON "session"
        FOR EACH ROW
        WHEN (
          NEW."deleted_at" IS NOT NULL
          OR NEW."completed_at" IS NOT NULL
          OR NEW."archived_at" IS NOT NULL
          OR (NEW."finished_at" IS NOT NULL
              AND (NOT (NEW."finished_at" IS NOT NULL AND NEW."end_reason" IS NULL AND (NEW."last_turn_outcome" IS NOT DISTINCT FROM 'FAILED' OR NEW."status" = 'FAILED'))
                   OR (NEW."retry_at" IS NULL
                       AND NOT (OLD."retry_at" IS NOT NULL AND NEW."retry_attempts" > OLD."retry_attempts"))))
          OR (NEW."status" = 'INTERRUPTED' AND COALESCE(NEW."end_reason", '') <> '')
        )
        EXECUTE FUNCTION "session_request_recipient_ended"();

      CREATE OR REPLACE TRIGGER "session_request_asker_stopped"
        AFTER UPDATE OF "status", "end_reason", "retry_at", "retry_attempts", "retry_claimed_at", "finished_at", "last_turn_outcome", "completed_at", "archived_at", "deleted_at"
        ON "session"
        FOR EACH ROW
        WHEN (
          NEW."deleted_at" IS NOT NULL
          OR NEW."completed_at" IS NOT NULL
          OR NEW."archived_at" IS NOT NULL
          OR (NEW."finished_at" IS NOT NULL
              AND (NOT (NEW."finished_at" IS NOT NULL AND NEW."end_reason" IS NULL AND (NEW."last_turn_outcome" IS NOT DISTINCT FROM 'FAILED' OR NEW."status" = 'FAILED'))
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
        AFTER UPDATE OF "status", "end_reason", "finished_at", "last_turn_outcome", "completed_at", "archived_at", "deleted_at"
        ON "session"
        FOR EACH ROW
        WHEN (
          NEW."deleted_at" IS NOT NULL
          OR NEW."completed_at" IS NOT NULL
          OR NEW."archived_at" IS NOT NULL
          OR (NEW."finished_at" IS NOT NULL AND NOT (NEW."finished_at" IS NOT NULL AND NEW."end_reason" IS NULL AND (NEW."last_turn_outcome" IS NOT DISTINCT FROM 'FAILED' OR NEW."status" = 'FAILED')))
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
