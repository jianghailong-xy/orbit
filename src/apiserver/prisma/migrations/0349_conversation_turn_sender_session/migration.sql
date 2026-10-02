-- Who sent a turn, when it is one Orbit session's message to another (docs/session-request-reply-contract.md §2.1).
--
-- `session_send` and `project_send` write a turn into somebody else's conversation, and until now the
-- row said nothing about who: `content` is defined as the user's message, so the recipient read
-- another agent's words as the account owner's. This column records the calling session. It is
-- written only by those two runner doors, from the caller's own identity, never from a request body;
-- NULL is every other turn and the meaning every existing row keeps — the owner, a headless
-- credential, or the platform's own deliveries.
--
-- Deliberately NOT a foreign key. A turn is written under its own session's row lock (FOR UPDATE),
-- and a foreign key would take the SENDER's row as well (FOR KEY SHARE), which waits on exactly that
-- lock: two sessions messaging each other at the same moment would each hold one session row and
-- wait for the other. The column is a fact about the past, read at delivery and when the echo is
-- stored, and a sender purged since then simply reads as unknown.
ALTER TABLE "conversation_turn"
  ADD COLUMN "sender_session_id" UUID;

-- §2.4: what one session sent another in the last hour, counted under the recipient's row lock
-- before each new message is written. Partial, so it holds the session-to-session messages and
-- nothing else.
CREATE INDEX "conversation_turn_sender_session_id_idx"
  ON "conversation_turn"("session_id", "sender_session_id", "created_at")
  WHERE "sender_session_id" IS NOT NULL;
