-- 1681 — finishes 1680: validates `session_opened_by_check`, and builds the partial index the Drive chat list and its
-- default workspace read (drive/drive-chat.ts): an owner's Drive chats, newest first.
--
-- A file without a DO, so `migrate deploy` sends its statements one by one, outside any transaction (0479): the
-- VALIDATE scans without blocking writes, and the index is built CONCURRENTLY. A build that failed half way leaves an
-- invalid index of that name, which IF NOT EXISTS would keep, so it is dropped first (under a short lock_timeout:
-- DROP INDEX takes ACCESS EXCLUSIVE on `session` for a moment). Safe to run twice.

SET lock_timeout = '2s';

DROP INDEX IF EXISTS "session_drive_chat_owner_idx";

SET lock_timeout = 0;

ALTER TABLE "session" VALIDATE CONSTRAINT "session_opened_by_check";

CREATE INDEX CONCURRENTLY IF NOT EXISTS "session_drive_chat_owner_idx"
  ON "session" ("owner_id", "created_at" DESC) WHERE "opened_by" = 'DRIVE_CHAT';

RESET lock_timeout;
