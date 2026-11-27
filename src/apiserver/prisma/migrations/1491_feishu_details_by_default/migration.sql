-- 1491: a Feishu alert card carries its details by default (docs/feishu-bot-design.md §6.4).
--
-- 0489 made `message_detail` TITLES_ONLY by default, so an approval card read "Details hidden by your settings" and
-- the owner had to open Orbit to see what a tool would run. The owner asked for the details open by default
-- (2026-11-23). A new app now reads FULL, and every stored app is moved to FULL too: a row cannot tell an owner who
-- chose TITLES_ONLY from one who never touched the switch, and the owner chose to move them all. Whoever wants titles
-- only turns "Include details in alerts" off again. Runs twice safely: the second pass finds no TITLES_ONLY row.
--
-- 1491: the highest number on every ref and session worktree was 1490 (1490_session_listed_at) when this was written.

ALTER TABLE "feishu_app" ALTER COLUMN "message_detail" SET DEFAULT 'FULL';
UPDATE "feishu_app" SET "message_detail" = 'FULL' WHERE "message_detail" = 'TITLES_ONLY';
