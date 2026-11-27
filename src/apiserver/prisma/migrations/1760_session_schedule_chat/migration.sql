-- 1760 — the Scheduled page's chat (docs/scheduled-chat-design.md §4.3, D4 A; board docs/mocks/scheduled-chat/). 1761
-- builds the index its doors read.
--
-- WHAT IT ADDS
-- ============
--   `session.schedule_chat_at` — when the page chat was opened. A session is the page chat exactly when it is set.
--   Written only by `POST /api/schedules/chat` (schedules/schedule-page-chat.ts), in the session row's own INSERT, and
--   never afterwards: the trigger below refuses an UPDATE that would change it, as 0476's does for
--   `wiki_chat_space_id`. The session is otherwise an ordinary MANUAL one, listed in its workspace's sessions with a
--   From Scheduled tag. No run source is added: shipped clients decode `runSource`, and about 17 filters name its
--   values.
--
-- LOCKS
-- =====
-- `session` is read by every runner call. ADD COLUMN and CREATE TRIGGER need ACCESS EXCLUSIVE for a moment, so the
-- lock is taken in short tries, as 0476 and 0850 take it: 2 s each, 1 s apart, at most 45, then a clear error. A
-- nullable column with no default is catalog-only: no rewrite, no scan. Every statement is safe to run twice.
--
-- BACKWARD COMPATIBLE
-- ===================
-- Every existing row reads NULL, so no session is a page chat. An older apiserver writes nothing here, and rolling the
-- code back leaves the column unread.
--
-- 1760: the highest number on origin/main was 1750 and on every origin/project/* and origin/orbit/* branch 1736
-- (2026-11-27); 1760 leaves room for the ones in flight.

CREATE OR REPLACE FUNCTION session_schedule_chat_guard() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."schedule_chat_at" IS DISTINCT FROM OLD."schedule_chat_at" THEN
    RAISE EXCEPTION
      'SCHEDULE_CHAT_IMMUTABLE: session % was made the Scheduled page chat or not when it was created; a page chat is a new session',
      OLD."id" USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      LOCK TABLE "session" IN ACCESS EXCLUSIVE MODE;

      ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "schedule_chat_at" TIMESTAMP(3);

      DROP TRIGGER IF EXISTS "session_schedule_chat_guard" ON "session";
      CREATE TRIGGER "session_schedule_chat_guard"
        BEFORE UPDATE OF "schedule_chat_at" ON "session"
        FOR EACH ROW EXECUTE FUNCTION session_schedule_chat_guard();
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      tries := tries + 1;
      IF tries >= 45 THEN
        RAISE EXCEPTION '1760: "session" was not free in 45 tries of 2 s each. Once what holds it has ended, mark the migration rolled back (prisma migrate resolve --rolled-back 1760_session_schedule_chat) and deploy again: it is safe to run twice.'
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;
