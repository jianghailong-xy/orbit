-- 0352 — an outcome held for an asker that will not be woken again is said on its task
-- (docs/session-request-reply-contract.md §4.3, §8 criterion 17).
--
-- WHAT IT ADDS
-- ============
--   * `session_request.reply_comment_due_at`: the asking session stopped for good while this outcome
--     was held for its next turn, so there will be no next turn to say it on. The request worker writes
--     §4.3's comment on the task the asker ran and clears it (session-request.worker.ts).
--   * `session_request_asker_stopped`: the trigger that sets it, on the `session` row of the asker.
--
-- WHY
-- ===
-- An outcome is HELD (`reply_held_at`) when the asker cannot take a turn for it now but will be handed
-- one: it was interrupted with the reply turn still queued, or a transient failure — a quota, an
-- outage, a runner that went away — stopped it with an auto-retry armed. The held outcome is written
-- into whichever turn the asker is handed next, the retry's re-send among them (§8 criterion 17). But
-- a retry can be given up instead: the sweep runs out of attempts or finds the task replaced, the runner
-- never comes back, the owner turns the retry off — or the session is completed, moved to Trash or
-- ended while it waited. Then no turn comes, and the outcome would sit on its row unsaid, with nothing on
-- the task either: §4.3 writes that comment only for an asker that had ended BEFORE its outcome came
-- back, which a parked asker had not.
--
-- So the moment the asker stops for good is caught where every one of those writers meets: the asker's
-- own row, in the statement that stops it, whichever code path wrote it — as 0350's
-- `session_request_recipient_ended` catches the same moment for the requests a session was asked.
--
-- WHEN AN ASKER HAS STOPPED FOR GOOD
-- ==================================
-- Every way 0350 reads a run as ended — Trash, completed, a run status that is over, a FAILED run with
-- no retry armed — and one more: a session parked idle (AWAITING_INPUT) whose retry was armed and is
-- now gone without a turn, because the retry was disarmed or the attempt its claim spent was handed
-- back. Never the claim itself: the auto-retry sweep claims by clearing `retry_at` and spending an
-- attempt in one statement, and the next one revives the same session (auto-retry.service.ts), so a
-- statement that raised `retry_attempts` is a retry going ahead, as 0350 reads it. And never a new
-- turn: a message to an idle session clears `retry_at` in the same statement that moves it out of
-- AWAITING_INPUT, and the held outcomes are said on that turn.
--
-- LOCK ORDER
-- ==========
-- The trigger runs inside a session UPDATE that holds that session's row (rank 30), and writes only
-- `session_request` rows (rank 60) that name it as the ASKER. Rows held for an asker are otherwise
-- written under that same asker's lock or by single autocommit statements (session-request.ts), so this
-- adds no wait edge.
--
-- BACKWARD COMPATIBLE
-- ===================
-- One nullable column with no default, one CHECK every existing row satisfies because the column reads
-- NULL in it, one partial index, one function and one trigger. No existing row is read or rewritten.

BEGIN;

ALTER TABLE "session_request" ADD COLUMN "reply_comment_due_at" TIMESTAMPTZ(3);

-- Only an outcome can be owed a comment.
ALTER TABLE "session_request" ADD CONSTRAINT "session_request_comment_due_chk"
  CHECK ("state" <> 'OPEN' OR "reply_comment_due_at" IS NULL);

-- The worker's read: the comments owed, oldest first.
CREATE INDEX "session_request_comment_due_idx"
  ON "session_request" ("reply_comment_due_at")
  WHERE "reply_comment_due_at" IS NOT NULL;

CREATE OR REPLACE FUNCTION "session_request_asker_stopped"() RETURNS trigger AS $$
BEGIN
  UPDATE "session_request"
     SET "reply_comment_due_at" = CURRENT_TIMESTAMP
   WHERE "from_session_id" = NEW."id"
     AND "state" <> 'OPEN'
     AND "reply_client_turn_id" IS NULL
     AND "reply_held_at" IS NOT NULL
     AND "reply_comment_due_at" IS NULL;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "session_request_asker_stopped"
  AFTER UPDATE OF "status", "end_reason", "retry_at", "retry_attempts", "completed_at", "archived_at", "deleted_at"
  ON "session"
  FOR EACH ROW
  WHEN (
    NEW."deleted_at" IS NOT NULL
    OR NEW."completed_at" IS NOT NULL
    OR NEW."archived_at" IS NOT NULL
    OR NEW."status" IN ('SUCCEEDED', 'CANCELLED')
    OR (NEW."status" = 'FAILED' AND NEW."retry_at" IS NULL
        AND NOT (OLD."retry_at" IS NOT NULL AND NEW."retry_attempts" > OLD."retry_attempts"))
    OR (NEW."status" = 'INTERRUPTED' AND COALESCE(NEW."end_reason", '') <> '')
    OR (NEW."status" = 'AWAITING_INPUT' AND NEW."retry_at" IS NULL
        AND ((OLD."retry_at" IS NOT NULL AND NEW."retry_attempts" <= OLD."retry_attempts")
             OR NEW."retry_attempts" < OLD."retry_attempts"))
  )
  EXECUTE FUNCTION "session_request_asker_stopped"();

COMMIT;
