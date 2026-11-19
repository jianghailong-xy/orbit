-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 0502: who outside Orbit sent a turn (Feishu bot integration, project 34tJs8k23brO8Ie2WtMSk, task F3-5).
-- docs/feishu-bot-design.md section 8.2 ("sender attribution") is the authority.
--
-- WHY
-- ---
-- A connected Feishu group's members send work into the owner's sessions (F3-2). Their turns were written exactly
-- as the owner's own: every client drew them as "You", and the agent read a group member's words as the account
-- owner's. 0349's `sender_session_id` names another Orbit SESSION; a person in a Feishu group is no session.
--
-- WHAT IT ADDS
-- ------------
-- conversation_turn, three nullable columns, written once with the turn (SessionsService.createTurn, and the seeded
-- opening turn of a session a group mention started):
--   external_sender_source  'FEISHU', or NULL for every turn nobody outside Orbit sent (the owner, a session, the
--                           platform). The bot owner's own words in a group are the owner's: NULL.
--   external_sender_id      the sender's open_id in the app that received the message.
--   external_sender_name    the sender's name as Feishu gave it when the turn was written; NULL when Feishu would not
--                           say (the contact permission not granted, the person out of the app's range).
-- conversation_turn_external_sender_chk: a source names its sender, and nothing else is set without one.
--
-- session, two nullable columns beside 0485's `last_user_from_*`, written and cleared in the same statements as
-- `last_user_text` (session-message.ts pendingMessageColumns), so a row can say "From Feishu · <name>: ..." for the
-- message it previews:
--   last_user_from_external_source  'FEISHU' when that message came from outside Orbit, else NULL.
--   last_user_from_external_name    the sender's name, as on the turn.
-- session_last_user_from_external_chk: the name is set only with a source.
--
-- Nothing is backfilled: every existing turn and row reads NULL, which is what every client drew before.
--
-- LOCKS
-- -----
-- ADD COLUMN without a default is a catalogue change, no rewrite. `session` and `conversation_turn` are read by every
-- runner call, and a waiting ALTER queues each later reader and writer behind it, so (as 0485) the lock is asked for
-- 2 s at a time, 1 s apart, up to 60 tries, in one DO statement. The CHECKs are added NOT VALID and then validated,
-- so the scan of existing rows (all NULL, all pass) runs under SHARE UPDATE EXCLUSIVE, not ACCESS EXCLUSIVE.
-- No function, trigger or type is created, replaced or dropped. No INSERT, UPDATE or DELETE.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0502: main and the project line stand at 0501 (F2-1's feishu_outbox); claimed on the task first (instruction 6).
-- Can run twice: ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      ALTER TABLE "conversation_turn"
        ADD COLUMN IF NOT EXISTS "external_sender_source" TEXT,
        ADD COLUMN IF NOT EXISTS "external_sender_id" TEXT,
        ADD COLUMN IF NOT EXISTS "external_sender_name" TEXT;
      ALTER TABLE "conversation_turn" DROP CONSTRAINT IF EXISTS "conversation_turn_external_sender_chk";
      ALTER TABLE "conversation_turn"
        ADD CONSTRAINT "conversation_turn_external_sender_chk" CHECK (
          ("external_sender_source" IS NULL AND "external_sender_id" IS NULL AND "external_sender_name" IS NULL)
          OR ("external_sender_source" = 'FEISHU' AND "external_sender_id" IS NOT NULL)
        ) NOT VALID;
      ALTER TABLE "session"
        ADD COLUMN IF NOT EXISTS "last_user_from_external_source" TEXT,
        ADD COLUMN IF NOT EXISTS "last_user_from_external_name" TEXT;
      ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_last_user_from_external_chk";
      ALTER TABLE "session"
        ADD CONSTRAINT "session_last_user_from_external_chk" CHECK (
          ("last_user_from_external_source" IS NULL AND "last_user_from_external_name" IS NULL)
          OR "last_user_from_external_source" = 'FEISHU'
        ) NOT VALID;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF tries >= 60 THEN
        RAISE;
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;

ALTER TABLE "conversation_turn" VALIDATE CONSTRAINT "conversation_turn_external_sender_chk";
ALTER TABLE "session" VALIDATE CONSTRAINT "session_last_user_from_external_chk";
