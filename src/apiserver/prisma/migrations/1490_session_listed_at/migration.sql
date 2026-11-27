-- 1434 — `session.listed_at`: where a session sits in the session list, a clock that moves only when the session
-- changes for its owner.
--
-- WHY
-- ===
-- Every client sorted by `last_turn_at`, and the server moves that on every persisted activity event, every queue
-- claim and every state move: a session waiting on CI went back to the top of the list each time a poll printed a
-- line. `last_turn_at` stays what it is, the liveness clock (the idle reaper, the active-session window); the list
-- reads this one instead.
--
-- And `conversation_turn.by_person`: the turn was a person's message. A turn that ends waiting for input moves
-- `listed_at` only when it answered one; the end of a wake-up, a notification or a task brief does not. Nothing is
-- backfilled: a turn already answered is never read again for this.
--
-- WHAT MOVES IT
-- =============
--   * creation: the column default;
--   * a person's message (the owner's doors, a guest, a Feishu sender): the application, at enqueue;
--   * a turn that ends waiting on the owner (a person's turn answered, a permission card, a question, an owner
--     request): the application;
--   * a session that ends (SUCCEEDED / FAILED / CANCELLED) or is completed (completed_at set): the trigger below, so
--     no writer of either can forget it.
-- Streamed events, tool calls, background-job output, wake-up turns, queue claims and runner handshakes do not.
--
-- BACKWARD COMPATIBLE
-- ===================
-- A nullable column, and a boolean whose constant default PostgreSQL stores in the catalog. The default is set after the backfill, so the ALTER is a catalog change and the backfill writes
-- each row once; a row an older server inserts in between reads NULL, which every reader takes as created_at. The
-- trigger fires only on UPDATEs that name `status` or `completed_at`, so the event ingest's writes never run it.
-- Rolling the code back leaves the column and trigger in place, unread.

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "listed_at" TIMESTAMP(3);
      ALTER TABLE "conversation_turn" ADD COLUMN IF NOT EXISTS "by_person" BOOLEAN NOT NULL DEFAULT false;
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

UPDATE "session"
   SET "listed_at" = COALESCE("last_turn_at", "created_at")
 WHERE "listed_at" IS NULL;

ALTER TABLE "session" ALTER COLUMN "listed_at" SET DEFAULT CURRENT_TIMESTAMP;

CREATE OR REPLACE FUNCTION session_listed_at_on_settle()
RETURNS trigger AS $$
BEGIN
  IF (NEW."status" IS DISTINCT FROM OLD."status" AND NEW."status" IN ('SUCCEEDED', 'FAILED', 'CANCELLED'))
     OR (NEW."completed_at" IS NOT NULL AND OLD."completed_at" IS NULL) THEN
    NEW."listed_at" := CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS session_listed_at_settle ON "session";
CREATE TRIGGER session_listed_at_settle
BEFORE UPDATE OF "status", "completed_at" ON "session"
FOR EACH ROW EXECUTE FUNCTION session_listed_at_on_settle();
