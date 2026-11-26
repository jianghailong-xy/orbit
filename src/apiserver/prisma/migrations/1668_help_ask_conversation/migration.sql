-- 1668 — the help center's Ask, answered on the server's DeepSeek key (help/help-ask.ts) instead of by a session on
-- one of the person's machines.
--
-- WHAT IT ADDS
-- ============
--   `help_ask_conversation` — one Ask: whose it is (`owner_id`), its first question as its title, the page it was
--   asked from (`page`, null when the person took the page chip off), the conversation (`messages`, a JSON array of
--   `{ role: 'user' | 'assistant', text, at, error? }` in the order said), and where it stands (`status`: `working`
--   while the server waits on DeepSeek, `answered`, or `failed`). Still stuck → Ask your admin writes the admin, the
--   admin's task and when it was sent (`admin_id`, `admin_task_id`, `sent_to_admin_at`) once, onto the same row.
--
--   The person deleted takes their Asks with them; the admin deleted leaves the Ask, with no admin; the admin's task
--   deleted leaves the Ask sent.
--
--   Asks made before this one (sessions with `help_ask` set, 0850, and their 0890 hand-off rows) are left as they are.
--
-- LOCKS
-- =====
-- The foreign keys take SHARE ROW EXCLUSIVE on `user` and `task` for a moment, so the lock is taken in short tries,
-- as 0900 takes its own: 2 s each, 1 s apart, at most 45, then a clear error. The table is new and empty: nothing is
-- scanned. Every statement is safe to run twice.
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
      CREATE TABLE IF NOT EXISTS "help_ask_conversation" (
        "id"               UUID NOT NULL,
        "owner_id"         UUID NOT NULL,
        "title"            TEXT NOT NULL,
        "page"             JSONB,
        "messages"         JSONB NOT NULL DEFAULT '[]'::jsonb,
        "status"           TEXT NOT NULL,
        "admin_id"         UUID,
        "admin_task_id"    UUID,
        "sent_to_admin_at" TIMESTAMP(3),
        "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "help_ask_conversation_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "help_ask_conversation_status_chk" CHECK ("status" IN ('working', 'answered', 'failed')),
        CONSTRAINT "help_ask_conversation_messages_chk" CHECK (jsonb_typeof("messages") = 'array'),
        CONSTRAINT "help_ask_conversation_owner_id_fkey" FOREIGN KEY ("owner_id")
          REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "help_ask_conversation_admin_id_fkey" FOREIGN KEY ("admin_id")
          REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE,
        CONSTRAINT "help_ask_conversation_admin_task_id_fkey" FOREIGN KEY ("admin_task_id")
          REFERENCES "task"("id") ON DELETE SET NULL ON UPDATE CASCADE
      );
      CREATE INDEX IF NOT EXISTS "help_ask_conversation_owner_id_created_at_idx"
        ON "help_ask_conversation"("owner_id", "created_at" DESC);
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      tries := tries + 1;
      IF tries >= 45 THEN
        RAISE EXCEPTION '1668: "user" or "task" was not free in 45 tries of 2 s each. Once what holds it has ended, mark the migration rolled back (prisma migrate resolve --rolled-back 1668_help_ask_conversation) and deploy again: it is safe to run twice.'
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;
