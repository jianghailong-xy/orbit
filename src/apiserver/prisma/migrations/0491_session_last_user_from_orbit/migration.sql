-- 0491 — that the message a session row previews is Orbit's own, so the row can say "Orbit: …"
-- instead of "You: …" for words nobody typed (docs/session-list-projects-design.md §3.5, owner
-- 2026-11-07).
--
-- WHY
-- ===
-- 0485 records who sent `last_user_text` when another session did; a message the platform wrote — a
-- fact told to a coordinator, a watch's wake, the owner's answer handed on — was left with no sender,
-- which every client draws as the owner's: a coordinator's row read "You: From Orbit · project …" for
-- as long as it took to read the notification. Which turns are the platform's is known when the text
-- is written (the turn's own key, sessions/orbit-authored-turn.ts, and the cards the conversation draws
-- it as), so it is recorded beside the text, in the same writes.
--
-- WHAT IT ADDS
-- ============
-- One nullable column, written and cleared in the same statements as `last_user_text`:
--   last_user_from_orbit  NULL unless Orbit wrote the message. When it did, an object
--                         `{"coordinatorDelivery": <card> | null}`: the card the conversation draws a
--                         fact told to a coordinator (or the answer to a criteria proposal) as, which
--                         the row's sentence is written from; null for any other message of Orbit's.
-- Nothing is backfilled: no column says which turn a stored `last_user_text` came from. Every existing
-- row reads NULL, which is what every client drew before; the next message or reply writes it.
--
-- BACKWARD COMPATIBLE
-- ===================
-- A nullable column with no default is a catalog change only: no table rewrite, no lock beyond the
-- ALTER's own. Rolling the code back leaves it in place, unread.
--
-- TAKING THE LOCK IN SHORT TRIES
-- ==============================
-- As 0485: `session` is the table every runner call reads, and a waiting ALTER queues each later
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
        ADD COLUMN IF NOT EXISTS "last_user_from_orbit" JSONB;
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
