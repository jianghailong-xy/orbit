-- 0860 — a scheduled CHECK_ONLY run on Claude Code may ask (docs/scheduled-tasks-design.md §6.2, §6.4; S2e).
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
-- Every started run gets its schedule's current level (the only record there is of it). No rule is marked: a rule is
-- marked only when Always allow on a CHECK_ONLY run's card writes it, and those rules are computed by the server from
-- the card's command (`checkOnlyRuleRefusal`). A rule written before this (by any session's card, a scheduled one's
-- included) was chosen by the client and is not carried; a CHECK_ONLY run asks for it once.
--
-- BACKWARD COMPATIBLE
-- ===================
-- A nullable column and a NOT NULL boolean with a constant default (catalog-only in PostgreSQL 11+), then one
-- UPDATE bounded by the schedule tables, which no release before 0790 has. An older apiserver neither reads nor
-- writes either column: it reads the schedule's level and every workspace rule, as before.
--
-- 0860: renumbered from 0850, which 0850_help_ask_session takes on other branches; the highest number in use on the
-- local branches, origin/main, every origin/project/* and origin/orbit/* branch was 0850 (2026-11-16).
BEGIN;

ALTER TABLE "schedule_run" ADD COLUMN "access_level" "schedule_access_level";
ALTER TABLE "workspace_permission_rule" ADD COLUMN "from_schedule_run" BOOLEAN NOT NULL DEFAULT false;

UPDATE "schedule_run" r
   SET "access_level" = s."access_level"
  FROM "schedule" s
 WHERE s."id" = r."schedule_id"
   AND r."session_id" IS NOT NULL;

COMMIT;
