-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1423: the project-move guard reads the release fact, not the status (docs/session-three-state-plan.md §7 step
-- 4.4, appendix A of docs/session-three-state-read-sites.md; project 3508bDBDE5xPH43TYuiqP).
--
-- WHAT IT CHANGES
-- ---------------
--   task_claimed_project_move_guard (0610; trigger task_claimed_project_move_guard on task, UPDATE OF
--   project_id), replaced with its live body and one line changed:
--     was  AND s."status" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
--     now  AND s."finished_at" IS NULL
-- Its trigger watches task.project_id and reads session rows, so no column list changes.
--
-- WHY EVERY STORED ROW GETS THE SAME ANSWER
-- -----------------------------------------
-- As 1421: session_release_fact_chk (1401/1402) makes "one of the four held statuses" and "finished_at is null"
-- the same test for every session row (no row holds the unused PARKED label, 0071).
--
-- LOCKS
-- -----
-- CREATE OR REPLACE FUNCTION only: no table lock, no row written.
-- How it is sent: the file holds no DO block and no CREATE PROCEDURE, so prisma migrate deploy (7.10) sends it
-- statement by statement; each CREATE OR REPLACE FUNCTION stands alone and commits by itself. Nothing in it
-- COMMITs. sessions/session-release.pg.spec.ts (12) applies it that way, with deployAgain, on a database holding
-- rows.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 1423: after 1422 (rescanned 2026-11-21). Not a multiple of 10. Can run twice.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.task_claimed_project_move_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  confirmation text;
BEGIN
  IF NEW."project_id" IS DISTINCT FROM OLD."project_id" AND EXISTS (
    SELECT 1 FROM "session" s WHERE s."task_id" = NEW."id" AND s."deleted_at" IS NULL
      -- Held is `finished_at` null: the four held statuses exactly (session_release_fact_chk, 1401/1402).
      AND s."finished_at" IS NULL
  ) THEN
    confirmation := current_setting('orbit.move_task_handoff_id', true);
    IF confirmation IS NULL
       OR confirmation !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR NOT EXISTS (
         SELECT 1 FROM "project_handoff_approval" a
          WHERE a."id" = confirmation::uuid
            AND a."owner_id" = NEW."owner_id"
            AND a."kind" = 'MOVE_TASK'
            AND a."subject_task_id" = NEW."id"
            AND a."from_project_id" = OLD."project_id"
            AND a."to_project_id" IS NOT DISTINCT FROM NEW."project_id"
            AND a."state" = 'APPROVED'
            AND a."applied_task_id" IS NULL
            AND a."decided_by" = 'USER'
            AND a."decided_by_user_id" IS NOT NULL
       ) THEN
      RAISE EXCEPTION 'TASK_CLAIMED_PROJECT_MOVE: task % has a live execution claim', NEW."id";
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
