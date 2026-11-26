-- 1680 — the Drive chat's session (project "Drive chat: manage files by talking to an agent", board
-- docs/mocks/drive-chat/01-board.html; modelled on the wiki chat's 0476 and 1561). 1681 validates the CHECK below and
-- builds the index the chat list and the default workspace read.
--
-- WHAT IT ADDS
-- ============
--   1. `session.opened_by` takes 'DRIVE_CHAT' (0670's check, widened by 0830): a chat opened from Drive
--      (POST /api/drive/chats, drive/drive-chat.ts). A session is a Drive chat exactly when it holds it, written in the
--      row's own INSERT by that door alone.
--   2. `session.drive_chat_prompt_digest` — the digest of the `<orbit_drive_chat>` guidance its delivery last handed
--      out (drive/drive-chat-notes.ts), written in the delivery's own transaction, so a claim rolled back sends it again
--      and a change of its text sends it once more. NULL = never delivered.
--   3. `conversation_turn.drive_context` — the folder the owner had open and the items they selected
--      (`{ folderId, entryIds }`), as ids, never text. Delivery reads the paths, kinds, sizes and last writers they name
--      when it hands the turn to the runner, so the turn's content stays the owner's words alone.
--
-- LOCKS
-- =====
-- As 0476 takes them: one DO, `session` first and then `conversation_turn` (lock ranks 30, 60), each in short tries of
-- 2 s, 1 s apart, at most 45, then a clear error. Catalog changes only: the columns are nullable with no default and
-- the CHECK is re-added NOT VALID, so nothing is scanned while the locks are held. Safe to run twice.
--
-- BACKWARD COMPATIBLE
-- ===================
-- The check is widened, never narrowed; every existing row reads NULL in both new columns. An older apiserver writes
-- neither column and never 'DRIVE_CHAT', and rolling the code back leaves them unread.
--
-- 1680: the highest number in use on origin/main, every origin/project/* and origin/orbit/* branch was 1671
-- (2026-11-26); 1680 leaves room for the ones in flight.

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      LOCK TABLE "session" IN ACCESS EXCLUSIVE MODE;
      LOCK TABLE "conversation_turn" IN ACCESS EXCLUSIVE MODE;
      ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "drive_chat_prompt_digest" TEXT;
      ALTER TABLE "conversation_turn" ADD COLUMN IF NOT EXISTS "drive_context" JSONB;
      ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_opened_by_check";
      ALTER TABLE "session" ADD CONSTRAINT "session_opened_by_check"
        CHECK ("opened_by" IN (
          'PERSON',
          'COORDINATOR',
          'COORDINATOR_JUDGMENT',
          'TASK_LIST_CONSOLE',
          'WIKI_CHAT',
          'DRIVE_CHAT',
          'FEISHU',
          'SERVICE_TOKEN',
          'MENTION_REPLY',
          'ORBIT',
          'SCHEDULE'
        )) NOT VALID;
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      tries := tries + 1;
      IF tries >= 45 THEN
        RAISE EXCEPTION '1680: "session" or "conversation_turn" was not free in 45 tries of 2 s each. Once what holds it has ended, mark the migration rolled back (prisma migrate resolve --rolled-back 1680_drive_chat_session) and deploy again: it is safe to run twice.'
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;
