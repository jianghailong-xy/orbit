-- 0485 — who sent the message a session row previews, so the row can say "<that session>: …"
-- instead of "You: …" for words the owner never wrote (docs/session-list-projects-design.md §3.5,
-- owner 2026-11-07).
--
-- WHY
-- ===
-- `last_user_text` is the message sent into a session and not answered yet, whoever sent it: the
-- owner, or another session through `session_send`, `project_send` or `session_interrupt`. A
-- coordinator's pending message is usually a task's report, and every client drew it as `You: …`.
-- The sender is already on the turn (`conversation_turn.sender_session_id`, 0349), but nothing on the
-- session row says which turn `last_user_text` came from: a message queued behind a running turn
-- overwrites it, the running turn's reply clears it, and the queued one's echo writes it again.
-- So the sender is recorded beside the text, in the same writes.
--
-- WHAT IT ADDS
-- ============
-- Two nullable columns, written and cleared in the same statements as `last_user_text`:
--   last_user_from_session_id  the sending session, when another session sent it; NULL when the owner
--                              (or the platform) did.
--   last_user_from_title       that session's title as it stood when the text was written, the title
--                              the conversation's "From <title>" card is drawn with.
-- Deliberately NOT a foreign key, for the reason 0349 gives for `sender_session_id`: the row is
-- written under its own FOR UPDATE, and a foreign key would also take the sender's row FOR KEY
-- SHARE, so two sessions messaging each other at the same moment would each wait for the other. A
-- sender purged since is an id that resolves to nothing, as on the card.
-- Nothing is backfilled: no column says which turn a stored `last_user_text` came from. Every
-- existing row reads NULL, the owner's, which is what every client drew before; the next message
-- or reply writes both.
--
-- BACKWARD COMPATIBLE
-- ===================
-- Nullable columns with no default are a catalog change only: no table rewrite, no lock beyond the
-- ALTER's own. Rolling the code back leaves them in place, unread.
--
-- TAKING THE LOCK IN SHORT TRIES
-- ==============================
-- As 0478: `session` is the table every runner call reads, and a waiting ALTER queues each later
-- reader and writer behind it, so the lock is asked for 2 s at a time, with 1 s between tries, up to
-- 60 tries. One DO statement, because `migrate deploy` sends each statement on its own. IF NOT
-- EXISTS keeps a retried apply harmless.

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      ALTER TABLE "session"
        ADD COLUMN IF NOT EXISTS "last_user_from_session_id" UUID,
        ADD COLUMN IF NOT EXISTS "last_user_from_title" TEXT;
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
