-- 0347 — session requests: one Orbit session asking another for a reply, and the one outcome every
-- such request comes to (docs/session-request-reply-contract.md §3–§5, P1).
--
-- WHAT IT ADDS
-- ============
--   * `session_request`: one row per `session_send` / `project_send` that carried `expectReply`. It
--     names the asking session, the session that was asked (for `project_send`, the coordinator the
--     message was DELIVERED to — the row does not follow a later rotation), the turn that carries the
--     request in the recipient's conversation, the options it offered, and when it is due. `state`
--     starts OPEN and is written exactly once to one of five outcomes, each by a compare-and-set on
--     `state = 'OPEN'`, so whichever arrives first is the outcome and nothing rewrites it.
--     `reply_client_turn_id` is the `session-reply:` turn of the asking session that carries the
--     outcome back to it (or the turn it was added to); `reply_held_at` says the outcome was kept on
--     the row instead — the asker had ended, or its reply turn was taken off its queue — to be added to
--     the next turn it is handed.
--   * `session_request_outcome_guard`: a closed request's outcome is final.
--   * `session_request_recipient_ended`: every way a session's run ends, or the session is completed
--     or moved to Trash, closes the requests still waiting on it as RECIPIENT_ENDED — in the statement
--     that ends it, whichever code path wrote it.
--
-- WHY THE RECIPIENT'S END IS A TRIGGER
-- ====================================
-- A run ends through a dozen writers — the runner's finalize, a failed turn, end, cancel, complete,
-- Trash, the reaper, the auto-retry sweep giving up, task settlement — and a request missed by any one
-- of them would stay OPEN until its deadline: the very wait this feature exists to end. The condition
-- is the one `sessionHasEnded` (runner-api/background-job-wake.ts) reads, spelled over the columns:
-- in Trash, completed, or a run status that is over. A FAILED run with a retry armed has not ended
-- (`retry_at`): the same session goes on, and the trigger fires when the retry is disarmed instead.
-- Nor has one the auto-retry sweep has just claimed: the claim clears `retry_at` and spends an
-- attempt in one statement (auto-retry.service.ts), and the next one revives the same session. If
-- that revive is refused, the sweep re-arms or disarms, and a disarm is the end the trigger reads.
--
-- LOCK ORDER
-- ==========
-- `session_request` is a child row (rank 60). A request is inserted inside `createTurn` (or the revive
-- in `resume`), under the RECIPIENT's session row lock that transaction already holds; its one foreign
-- key is to that same row. The asking session gets no foreign key, and neither does the owner: a key
-- would take the asker's session row FOR KEY SHARE (or the owner's user row, rank 10) while the
-- recipient's is held FOR UPDATE, and two sessions asking each other at the same moment would each
-- hold one session row and wait for the other — the reason `conversation_turn.sender_session_id` (0349)
-- has none either.
-- The trigger runs inside a session UPDATE that holds that session's row and takes only rows of this
-- table that name it as the recipient: rank 30, then 60.
--
-- BACKWARD COMPATIBLE
-- ===================
-- One new table, two functions and two triggers. No existing row is read or rewritten. The session
-- trigger's WHEN clause is false for every update that does not leave the row ended, so it executes
-- nothing for them; for one that does, it updates the rows of a table that starts empty.

BEGIN;

CREATE TABLE "session_request" (
  "id" uuid NOT NULL,
  "owner_id" uuid NOT NULL,
  "from_session_id" uuid NOT NULL,
  "to_session_id" uuid NOT NULL,
  -- The turn that carries the request in the recipient's conversation, and the key it was written
  -- under. History rather than a reference: a turn taken off the queue is deleted, and the request
  -- that rode on it is UNDELIVERED.
  "turn_id" uuid NOT NULL,
  "client_turn_id" text NOT NULL,
  -- The first 200 characters of the request, said back to the asker with its outcome.
  "request_preview" text NOT NULL,
  "options" jsonb,
  "reply_by" TIMESTAMPTZ(3) NOT NULL,
  "state" text NOT NULL DEFAULT 'OPEN',
  "reply_text" text,
  "reply_option" integer,
  -- What the recipient had last said, for every outcome but REPLIED.
  "excerpt" text,
  -- Why the request closed the way it did: the recipient's end (RECIPIENT_ENDED), what took the turn
  -- off the queue (UNDELIVERED), or how the recipient stood at the deadline (EXPIRED).
  "close_reason" text,
  "closed_at" TIMESTAMPTZ(3),
  "reply_client_turn_id" text,
  "reply_held_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "session_request_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "session_request_to_session_fkey" FOREIGN KEY ("to_session_id")
    REFERENCES "session" ("id") ON DELETE CASCADE,
  CONSTRAINT "session_request_state_chk" CHECK ("state" IN (
    'OPEN', 'REPLIED', 'NO_REPLY', 'RECIPIENT_ENDED', 'EXPIRED', 'UNDELIVERED')),
  CONSTRAINT "session_request_closed_at_chk" CHECK (("state" = 'OPEN') = ("closed_at" IS NULL)),
  CONSTRAINT "session_request_not_self_chk" CHECK ("from_session_id" <> "to_session_id"),
  CONSTRAINT "session_request_options_chk" CHECK (
    "options" IS NULL OR (jsonb_typeof("options") = 'array' AND jsonb_array_length("options") BETWEEN 2 AND 4)),
  CONSTRAINT "session_request_reply_option_chk" CHECK (
    "reply_option" IS NULL OR ("reply_option" >= 0 AND "reply_option" < jsonb_array_length(COALESCE("options", '[]'::jsonb)))),
  CONSTRAINT "session_request_replied_chk" CHECK (
    ("state" = 'REPLIED') = ("reply_text" IS NOT NULL OR "reply_option" IS NOT NULL)),
  -- Nothing is handed back to the asker before there is an outcome to hand.
  CONSTRAINT "session_request_reply_handoff_chk" CHECK (
    "state" <> 'OPEN' OR ("reply_client_turn_id" IS NULL AND "reply_held_at" IS NULL))
);

-- A retried send names the same turn: its request is found by the key the turn was written under.
CREATE UNIQUE INDEX "session_request_turn_key"
  ON "session_request" ("to_session_id", "client_turn_id");
-- What is still waiting on a session (its delivery block, the NO_REPLY judgment, the recipient's end),
-- and what a session is still waiting for (the fifty-request cap, wake source 4, the session list).
CREATE INDEX "session_request_to_open_idx"
  ON "session_request" ("to_session_id") WHERE "state" = 'OPEN';
CREATE INDEX "session_request_from_open_idx"
  ON "session_request" ("from_session_id") WHERE "state" = 'OPEN';
-- The expiry worker's read: what is still open past its deadline, the longest-due first.
CREATE INDEX "session_request_due_idx"
  ON "session_request" ("reply_by") WHERE "state" = 'OPEN';
-- Outcomes on no turn of the asker's yet: what a delivery adds to the asker's next turn.
CREATE INDEX "session_request_unhanded_idx"
  ON "session_request" ("from_session_id")
  WHERE "state" <> 'OPEN' AND "reply_client_turn_id" IS NULL;
-- ...and of those, the ones nobody has tried to hand back yet: the worker's read, oldest first.
CREATE INDEX "session_request_owed_idx"
  ON "session_request" ("closed_at")
  WHERE "state" <> 'OPEN' AND "reply_client_turn_id" IS NULL AND "reply_held_at" IS NULL;
-- The outcomes a reply turn carries, read when it is delivered and when its echo is stored.
CREATE INDEX "session_request_reply_turn_idx"
  ON "session_request" ("from_session_id", "reply_client_turn_id")
  WHERE "reply_client_turn_id" IS NOT NULL;

CREATE OR REPLACE FUNCTION "session_request_outcome_guard"() RETURNS trigger AS $$
BEGIN
  IF OLD."state" <> 'OPEN' AND (
    NEW."state" IS DISTINCT FROM OLD."state"
    OR NEW."reply_text" IS DISTINCT FROM OLD."reply_text"
    OR NEW."reply_option" IS DISTINCT FROM OLD."reply_option"
    OR NEW."excerpt" IS DISTINCT FROM OLD."excerpt"
    OR NEW."close_reason" IS DISTINCT FROM OLD."close_reason"
    OR NEW."closed_at" IS DISTINCT FROM OLD."closed_at"
  ) THEN
    RAISE EXCEPTION 'SESSION_REQUEST_CLOSED'
      USING ERRCODE = 'P0001',
            DETAIL = 'a session request''s outcome is written once; only its hand-off to the asker moves after that';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "session_request_outcome_guard"
  BEFORE UPDATE ON "session_request"
  FOR EACH ROW EXECUTE FUNCTION "session_request_outcome_guard"();

-- RECIPIENT_ENDED. `close_reason` is how the session ended — COMPLETED, TRASHED or its run status —
-- followed by its end reason when it has one; `excerpt` is what it had last said.
CREATE OR REPLACE FUNCTION "session_request_recipient_ended"() RETURNS trigger AS $$
BEGIN
  UPDATE "session_request"
     SET "state" = 'RECIPIENT_ENDED',
         "excerpt" = NEW."last_assistant_text",
         "close_reason" = CASE
             WHEN NEW."deleted_at" IS NOT NULL THEN 'TRASHED'
             WHEN NEW."completed_at" IS NOT NULL OR NEW."archived_at" IS NOT NULL THEN 'COMPLETED'
             ELSE NEW."status"::text
           END || COALESCE(':' || NULLIF(NEW."end_reason", ''), ''),
         "closed_at" = CURRENT_TIMESTAMP
   WHERE "to_session_id" = NEW."id" AND "state" = 'OPEN';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "session_request_recipient_ended"
  AFTER UPDATE OF "status", "end_reason", "retry_at", "completed_at", "archived_at", "deleted_at"
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
  )
  EXECUTE FUNCTION "session_request_recipient_ended"();

COMMIT;
