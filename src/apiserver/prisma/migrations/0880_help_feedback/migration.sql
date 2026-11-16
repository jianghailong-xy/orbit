-- 0880 — Did this help? / Did this answer it? (docs/mocks/help-center board 03, decision 3: Yes / No counts for
-- admins, counts only, no text; task "Help center: Yes/No feedback and the Admin → Help feedback page").
--
-- WHAT IT ADDS
-- ============
--   `help_feedback` — one person's Yes / No on one help item: what it is about (`kind`: an article, by its slug, or
--   one Ask answer, by `<Ask session id>:<seq>`, in `item_id`), the answer (`helpful`), whose it is (`user_id`) and
--   when it was given (`created_at`). Nothing else: there is no text column, so a reason, a question or an answer
--   cannot be stored here. The key (user_id, kind, item_id) keeps one vote per person per item; a second vote
--   replaces the first (help/help-feedback.ts#record). Admin → Help feedback reads only counts of it.
--
--   The person deleted takes their votes with them.
--
-- LOCKS
-- =====
-- The foreign key takes SHARE ROW EXCLUSIVE on `user` for a moment, so the lock is taken in short tries, as 0870
-- takes its own: 2 s each, 1 s apart, at most 45, then a clear error. The table is new and empty: nothing is
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
      CREATE TABLE IF NOT EXISTS "help_feedback" (
        "user_id"    UUID NOT NULL,
        "kind"       TEXT NOT NULL,
        "item_id"    TEXT NOT NULL,
        "helpful"    BOOLEAN NOT NULL,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "help_feedback_pkey" PRIMARY KEY ("user_id", "kind", "item_id"),
        CONSTRAINT "help_feedback_kind_chk" CHECK ("kind" IN ('article', 'answer')),
        CONSTRAINT "help_feedback_item_id_chk" CHECK (char_length("item_id") BETWEEN 1 AND 200),
        CONSTRAINT "help_feedback_user_id_fkey" FOREIGN KEY ("user_id")
          REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE
      );
      CREATE INDEX IF NOT EXISTS "help_feedback_kind_item_id_idx" ON "help_feedback"("kind", "item_id");
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      tries := tries + 1;
      IF tries >= 45 THEN
        RAISE EXCEPTION '0880: "user" was not free in 45 tries of 2 s each. Once what holds it has ended, mark the migration rolled back (prisma migrate resolve --rolled-back 0880_help_feedback) and deploy again: it is safe to run twice.'
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;
