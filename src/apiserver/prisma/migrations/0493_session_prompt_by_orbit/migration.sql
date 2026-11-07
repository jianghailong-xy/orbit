-- 0493 — that the platform wrote a session's opening prompt, so the row can say "Orbit: …" instead of
-- "You: …" for the opening nobody typed (docs/session-list-projects-design.md §3.5, coordinator
-- 2026-11-07).
--
-- WHY
-- ===
-- 0491 records that Orbit wrote the message a row previews, read off the turn's key and the cards the
-- conversation draws it as. A session the platform opens with a prompt of its own — a project's
-- coordinator, a judgment a fact wakes, a task list's dispatch console, the reply to an @-mention —
-- files that prompt under the same `initial-<id>` key as a person's own opening, with no card, so its
-- row read "You: …" for words the owner never wrote. Who wrote the prompt is known only when the
-- session is made, so it is recorded then.
--
-- WHAT IT ADDS
-- ============
--   prompt_by_orbit  BOOLEAN NOT NULL DEFAULT false. True on a session one of those four doors made.
-- Nothing is backfilled: no column says which door made an existing session. Every existing row reads
-- false, which is what every client drew before.
--
-- BACKWARD COMPATIBLE
-- ===================
-- A column with a constant default is a catalog change only since PostgreSQL 11: no table rewrite, no
-- lock beyond the ALTER's own. Rolling the code back leaves it in place, unread. No trigger.
--
-- TAKING THE LOCK IN SHORT TRIES
-- ==============================
-- As 0491: `session` is the table every runner call reads, and a waiting ALTER queues each later
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
        ADD COLUMN IF NOT EXISTS "prompt_by_orbit" BOOLEAN NOT NULL DEFAULT false;
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
