-- 0870 — Still stuck → Ask your admin (docs/mocks/help-center board 02 ② right frame, side note 5; task
-- "Help center: Still stuck — retry, ask your admin, report on GitHub").
--
-- WHAT IT ADDS
-- ============
--   `help_ask_admin_request` — one row per Ask its person sent to an admin: the Ask (`session_id`, the key, so an Ask
--   is sent at most once), whose it is (`owner_id`), the admin it went to (`admin_id`) and the ordinary task that
--   carries it in the admin's own task list (`task_id`). /help → Your questions reads it to say "With your admin".
--   Written only by the Ask door (help/help-ask.ts#askAdmin), after the admin's task is made.
--
--   Its own table rather than a key in `session.help_ask`: 0850's trigger keeps that column as the Ask's INSERT
--   wrote it, because the runner doors read it under a running session.
--
--   The Ask, the asker or the admin deleted takes the row with it; the admin deleting the task leaves the row (the
--   question was sent) with no task.
--
-- LOCKS
-- =====
-- The foreign keys take SHARE ROW EXCLUSIVE on `session`, `task` and `user` for a moment, so the locks are taken in
-- short tries, as 0850 takes its own: 2 s each, 1 s apart, at most 45, then a clear error. The table is new and
-- empty: nothing is scanned. Every statement is safe to run twice.
--
-- BACKWARD COMPATIBLE
-- ===================
-- A new table nothing older reads or writes.

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      CREATE TABLE IF NOT EXISTS "help_ask_admin_request" (
        "session_id" UUID NOT NULL,
        "owner_id"   UUID NOT NULL,
        "admin_id"   UUID NOT NULL,
        "task_id"    UUID,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "help_ask_admin_request_pkey" PRIMARY KEY ("session_id"),
        CONSTRAINT "help_ask_admin_request_session_id_fkey" FOREIGN KEY ("session_id")
          REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "help_ask_admin_request_owner_id_fkey" FOREIGN KEY ("owner_id")
          REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "help_ask_admin_request_admin_id_fkey" FOREIGN KEY ("admin_id")
          REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "help_ask_admin_request_task_id_fkey" FOREIGN KEY ("task_id")
          REFERENCES "task"("id") ON DELETE SET NULL ON UPDATE CASCADE
      );
      CREATE INDEX IF NOT EXISTS "help_ask_admin_request_owner_id_idx" ON "help_ask_admin_request"("owner_id");
      CREATE INDEX IF NOT EXISTS "help_ask_admin_request_admin_id_idx" ON "help_ask_admin_request"("admin_id");
      CREATE INDEX IF NOT EXISTS "help_ask_admin_request_task_id_idx" ON "help_ask_admin_request"("task_id");
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      tries := tries + 1;
      IF tries >= 45 THEN
        RAISE EXCEPTION '0870: "session", "task" or "user" was not free in 45 tries of 2 s each. Once what holds it has ended, mark the migration rolled back (prisma migrate resolve --rolled-back 0870_help_ask_admin_request) and deploy again: it is safe to run twice.'
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;
