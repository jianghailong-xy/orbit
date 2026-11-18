-- 0850 — the help center's Ask session (docs/mocks/help-center board 02, decisions on board 03; task
-- "Help center: Ask — a read-only help session on the user's machine").
--
-- WHAT IT ADDS
-- ============
--   `session.help_ask` — `{ "page": { route, label, errors[] } | null }`. A session is an Ask exactly when it is
--   set. Written only by the Ask door (help/help-ask.ts), in the session row's own INSERT, and never afterwards:
--   a session is an Ask for its whole life or never, and the trigger below refuses an UPDATE that would change
--   it — as 0476's does for `wiki_chat_space_id`. The runner is told to start an Ask read-only by this column,
--   and the runner doors refuse an Ask anything but the reads it is allowed, so the column must not change
--   under a running session. A NULL default is catalog-only: no rewrite, no scan.
--
-- LOCKS
-- =====
-- `session` is read by every runner call. ADD COLUMN and CREATE TRIGGER need ACCESS EXCLUSIVE for a moment, so
-- the lock is taken in short tries, as 0476 takes it: 2 s each, 1 s apart, at most 45, then a clear error.
-- No index: Your questions reads one owner's sessions, which the owner's own indexes already narrow, and an index
-- build here would scan the table inside this file's one transaction (a file with a DO is sent whole).
-- Every statement is safe to run twice.
--
-- BACKWARD COMPATIBLE
-- ===================
-- Every existing row reads NULL, so no session is an Ask. An older apiserver writes nothing here.

CREATE OR REPLACE FUNCTION session_help_ask_guard() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."help_ask" IS DISTINCT FROM OLD."help_ask" THEN
    RAISE EXCEPTION
      'HELP_ASK_IMMUTABLE: session % was made an Ask or not when it was created; an Ask is a new session',
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

      ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "help_ask" JSONB;

      DROP TRIGGER IF EXISTS "session_help_ask_guard" ON "session";
      CREATE TRIGGER "session_help_ask_guard"
        BEFORE UPDATE OF "help_ask" ON "session"
        FOR EACH ROW EXECUTE FUNCTION session_help_ask_guard();
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      tries := tries + 1;
      IF tries >= 45 THEN
        RAISE EXCEPTION '0850: "session" was not free in 45 tries of 2 s each. Once what holds it has ended, mark the migration rolled back (prisma migrate resolve --rolled-back 0850_help_ask_session) and deploy again: it is safe to run twice.'
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;

