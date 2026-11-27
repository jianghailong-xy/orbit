-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1730: session.client_request_id, the key a person's POST /sessions may carry so a repeat of it
-- answers with the session the first one made instead of opening a second.
--
-- The web composer draws a new session's first message as a "Sending…" bubble and offers Retry
-- when no answer came (docs/mocks/composer-sending-bubble). A request whose answer was lost may
-- still have made its session, so Retry sends the same key: the second create finds that row and
-- returns it. Turns already have this (conversation_turn.client_turn_id); a create had nothing.
--
-- Additive only: a nullable column, which rewrites no row, and a unique index over the rows that
-- carry one, which every session made before this has not. Per owner, so one account's key never
-- answers for another's. No trigger, function, CHECK or DONE fence is touched.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "session" ADD COLUMN "client_request_id" TEXT;

CREATE UNIQUE INDEX "session_owner_client_request_key" ON "session" ("owner_id", "client_request_id")
  WHERE "client_request_id" IS NOT NULL;
