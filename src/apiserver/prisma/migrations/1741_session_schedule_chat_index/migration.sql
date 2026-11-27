-- 1741 — finishes 1740: the partial index the Scheduled page chat's doors read (schedules/schedule-page-chat.ts): an
-- owner's page chats, newest first, so `GET /api/schedules/chat` finds the open one without walking the owner's
-- sessions.
--
-- A file without a DO, so `migrate deploy` sends its statements one by one, outside any transaction (0479, 1681): the
-- index is built CONCURRENTLY. A build that failed half way leaves an invalid index of that name, which IF NOT EXISTS
-- would keep, so it is dropped first (under a short lock_timeout: DROP INDEX takes ACCESS EXCLUSIVE on `session` for a
-- moment). Safe to run twice.

SET lock_timeout = '2s';

DROP INDEX IF EXISTS "session_schedule_chat_owner_idx";

SET lock_timeout = 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "session_schedule_chat_owner_idx"
  ON "session" ("owner_id", "created_at" DESC) WHERE "schedule_chat_at" IS NOT NULL;

RESET lock_timeout;
