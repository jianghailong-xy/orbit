-- 0850 — a scheduled CHECK_ONLY run on Claude Code may ask (docs/scheduled-tasks-design.md §6.2, §6.4; S2e).
--
-- WHAT IT ADDS
-- ============
--   * `schedule_run.access_level`: the level the run started with, written when its session is opened. The claim,
--     the reclaim and the approval door read the run's own level, so moving the schedule to OPEN_PR, or deleting
--     it, while a check runs does not widen what that check's session may do. NULL for a run that has not started.
--   * `workspace_permission_rule.from_schedule_run`: the rule was written by answering Always allow on a scheduled
--     run's card. A CHECK_ONLY run on Claude Code carries only such Bash rules, not the ones a person's interactive
--     sessions wrote (`Bash(python:*)`, `Bash(git:*)` would run writing commands unasked).
--
-- BACKFILL
-- ========
-- Every started run gets its schedule's current level (the only record there is of it). A rule whose approval was a
-- card of a scheduled run's session is marked; a rule whose approval or session is gone stays unmarked, so such a
-- rule asks again once rather than being carried on a guess.
--
-- BACKWARD COMPATIBLE
-- ===================
-- A nullable column and a NOT NULL boolean with a constant default (catalog-only in PostgreSQL 11+), then two
-- UPDATEs bounded by the schedule tables, which no release before 0790 has. An older apiserver neither reads nor
-- writes either column: it reads the schedule's level and every workspace rule, as before.
--
-- 0850: the highest number in use on the local branches, origin/main, every origin/project/* and origin/orbit/*
-- branch was 0840 (2026-11-16).
BEGIN;

ALTER TABLE "schedule_run" ADD COLUMN "access_level" "schedule_access_level";
ALTER TABLE "workspace_permission_rule" ADD COLUMN "from_schedule_run" BOOLEAN NOT NULL DEFAULT false;

UPDATE "schedule_run" r
   SET "access_level" = s."access_level"
  FROM "schedule" s
 WHERE s."id" = r."schedule_id"
   AND r."session_id" IS NOT NULL;

UPDATE "workspace_permission_rule" w
   SET "from_schedule_run" = true
  FROM "approval" a
  JOIN "session" s ON s."id" = a."session_id"
 WHERE a."id" = w."approval_id"
   AND s."schedule_run_id" IS NOT NULL;

COMMIT;
