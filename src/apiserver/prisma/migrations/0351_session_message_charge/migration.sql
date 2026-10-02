-- 0351 — what one session sent another, kept as it was sent (docs/session-request-reply-contract.md
-- §2.4, §8 criterion 16).
--
-- WHAT IT ADDS
-- ============
--   * `session_message_charge`: one row for every message §2.4's hourly limit admits — a
--     `session_send`, a `project_send`, or the message a `session_interrupt` carries — written in the
--     transaction that writes the message, by `chargeSessionMessage` (sessions/session-message.ts),
--     which counts these rows instead of the turns.
--
-- WHY NOT THE TURNS
-- =================
-- The limit used to count the recipient's turns that name the sender (0349's column). A turn still
-- queued is deleted when an interrupt drops the queue or the owner withdraws it, and the count went
-- down with it: queue a few messages in another session, drop them with an interrupt that carries one
-- more, and the hour starts again. A row here is written when the message is admitted and is not
-- touched by anything that happens to the message afterwards. The one row ever deleted is one whose
-- hour is over — `chargeSessionMessage` drops the pair's expired rows as it counts — so within the
-- window the count only grows.
--
-- LOCK ORDER
-- ==========
-- A child row (rank 60). It is written under the RECIPIENT's session row lock that the sending
-- transaction already holds, and its one foreign key is to that same row, so it takes no lock of its
-- own. The sending session gets no foreign key, for the reason `conversation_turn.sender_session_id`
-- (0349) and `session_request.from_session_id` (0350) have none: a key would take the sender's row
-- FOR KEY SHARE while the recipient's is held FOR UPDATE, and two sessions messaging each other at the
-- same moment would each hold one row and wait for the other.
--
-- BACKWARD COMPATIBLE
-- ===================
-- One new table and its index. No existing row is rewritten. The messages of the last hour are
-- copied in from the turns the old count read — the same turns it counted, the auto-retry sweep's
-- re-sends left out as it left them out — so the hour that is under way when this ships is counted
-- the same on both sides of it. `conversation_turn.created_at` is stored as UTC without a zone, so
-- the hour is spelled in UTC on that side and the copy is read back as UTC.

BEGIN;

CREATE TABLE "session_message_charge" (
  "id" uuid NOT NULL,
  "from_session_id" uuid NOT NULL,
  "to_session_id" uuid NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "session_message_charge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "session_message_charge_to_session_fkey" FOREIGN KEY ("to_session_id")
    REFERENCES "session" ("id") ON DELETE CASCADE
);

-- What one session sent another in the last hour, counted under the recipient's row lock before
-- each new message is admitted; and the pair's expired rows, dropped by the same call.
CREATE INDEX "session_message_charge_pair_idx"
  ON "session_message_charge" ("to_session_id", "from_session_id", "created_at");

INSERT INTO "session_message_charge" ("id", "from_session_id", "to_session_id", "created_at")
SELECT gen_random_uuid(), t."sender_session_id", t."session_id", t."created_at" AT TIME ZONE 'UTC'
  FROM "conversation_turn" t
 WHERE t."sender_session_id" IS NOT NULL
   AND t."created_at" > (CURRENT_TIMESTAMP - interval '1 hour') AT TIME ZONE 'UTC'
   AND t."client_turn_id" NOT LIKE 'auto-retry:%';

COMMIT;
