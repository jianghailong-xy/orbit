-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1442: the three "ended" triggers lose the status bridge (docs/session-three-state-design.md §12.6, removal step
-- R7, decision D9; project 3508bDBDE5xPH43TYuiqP). Deploy 3, after 1441.
--
-- WHAT IT CHANGES
-- ---------------
-- The three AFTER UPDATE triggers 1425 installed on session, re-created with CREATE OR REPLACE TRIGGER (same name,
-- timing, column list and function). Each WHEN clause carries the release module's failure question
-- (common/session-release.ts releaseWasFailureSql, written out with NEW as the row); the question loses its bridge
-- arm, here as in the module:
--
--   was  (NEW."finished_at" IS NOT NULL AND NEW."end_reason" IS NULL
--         AND (NEW."last_turn_outcome" IS NOT DISTINCT FROM 'FAILED' OR NEW."status" = 'FAILED'))
--   now  (NEW."finished_at" IS NOT NULL AND NEW."end_reason" IS NULL
--         AND NEW."last_turn_outcome" IS NOT DISTINCT FROM 'FAILED')
--
-- in session_request_recipient_ended, session_request_asker_stopped and
-- task_owner_confirmation_review_reviewer_ended. Nothing else in them moves: the column lists (status stays in them,
-- because the INTERRUPTED and AWAITING_INPUT branches read it; those are held statuses), the filed branches, the
-- functions. After it no trigger on session names a terminal status ('SUCCEEDED', 'FAILED', 'CANCELLED' as
-- run_status); the one 'FAILED' left in these three is the turn outcome's ('FAILED'::text). 1425 is deployed (deploy
-- 2), so this is a file of its own rather than an edit of 1425.
--
-- WHERE THE ANSWER IS THE OLD ONE
-- -------------------------------
-- The bridge answered yes only for a row released FAILED with no end reason and no FAILED turn outcome. 1441, in the
-- same deploy and before this file, wrote last_turn_outcome = 'FAILED' on every such row that is not in Trash, so
-- for every stored row outside Trash each clause answers what it answered before. A trashed row fires both before
-- and after through its deleted_at branch, so the arm never decided for one. Rows written later: every writer of
-- deploy 2 and 3 records the turn outcome of a failure (removal step R2), and no deploy-1 server remains when deploy
-- 3 ships. sessions/session-release.pg.spec.ts (12) drives every release shape of design §12.2 through these clauses
-- and the ones before 1425, and holds each clause to releaseWasFailureSql('NEW') character for character.
--
-- WHICH RELEASE IT MAY SHIP IN
-- ----------------------------
-- Deploy 3, with 1441 before it and the release module without the bridge. Rolling the code back to deploy 2 after
-- it is safe: deploy 2's readers still carry the arm, which reads nothing this file or 1441 changed.
--
-- LOCKS
-- -----
-- CREATE OR REPLACE TRIGGER takes SHARE ROW EXCLUSIVE on session: asked for in one DO statement, 2 s at a time,
-- 1 s apart, up to 45 tries, as 1261 does. No function, column, constraint, index or type; no row written.
-- How it is sent: the file holds a DO block, so prisma migrate deploy (7.10) sends it whole, as one transaction;
-- the three trigger re-creations commit together. Nothing in it COMMITs.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 1442: after 1441 (main, project/*, pushed orbit/* and probe/* scanned 2026-11-22; written as 1429, then 1434).
-- Not a multiple of 10. Can run twice:
-- CREATE OR REPLACE TRIGGER.
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
              AND (NOT (NEW."finished_at" IS NOT NULL AND NEW."end_reason" IS NULL AND NEW."last_turn_outcome" IS NOT DISTINCT FROM 'FAILED')
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
              AND (NOT (NEW."finished_at" IS NOT NULL AND NEW."end_reason" IS NULL AND NEW."last_turn_outcome" IS NOT DISTINCT FROM 'FAILED')
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
          OR (NEW."finished_at" IS NOT NULL AND NOT (NEW."finished_at" IS NOT NULL AND NEW."end_reason" IS NULL AND NEW."last_turn_outcome" IS NOT DISTINCT FROM 'FAILED'))
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
