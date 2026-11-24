-- 1562 — what a wiki chat's delivery last told its agent (contracts/wiki.contract.json `chat.notes.chat` and
-- `chat.notes.contents`; docs/wiki-contract.md §28.4; docs/wiki-chat-design.md §4.2).
--
--   session.wiki_chat_prompt_digest    the digest of the `<orbit_wiki_chat>` text last delivered in this chat
--   session.wiki_chat_contents_version the confirmed plan version the `<orbit_wiki_contents>` note last delivered named
--
-- Delivery re-sends the chat's instructions when their digest differs from the first, and the contents when the confirmed
-- plan's version differs from the second; both are written in the delivery's own transaction (like
-- wiki_chat_draft.told_at), so a claim rolled back sends both again. NULL = never delivered, so a chat opened before this
-- migration gets both on its next message.
-- Additive: two nullable columns with no default, which the running release neither reads nor writes. `session` is read by
-- every runner call, so the lock is taken in short tries (as 0476 does) rather than waited for.
DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      LOCK TABLE "session" IN ACCESS EXCLUSIVE MODE;
      ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "wiki_chat_prompt_digest" TEXT;
      ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "wiki_chat_contents_version" INTEGER;
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      tries := tries + 1;
      IF tries >= 45 THEN
        RAISE EXCEPTION '1562: "session" was not free in 45 tries of 2 s each. Once what holds it has ended, mark the migration rolled back (prisma migrate resolve --rolled-back 1562_wiki_chat_delivery_markers) and deploy again: it is safe to run twice.'
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(0.1);
    END;
  END LOOP;
END
$$;
