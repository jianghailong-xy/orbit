-- A promoted project coordinator needs its full standing instructions once per live engine
-- context, not once per user message. The Session records the last context a successful turn
-- confirmed; each leased turn records what was actually attached so a lost inbox response is
-- retried with the context instead of being mistaken for delivery.
--
-- The epoch is the highest durable compaction event seq. Using the event identity makes event
-- batch retries idempotent without another table or a per-event update.
ALTER TABLE "session"
  ADD COLUMN "coordinator_context_epoch" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "coordinator_context_ack_key" CHAR(64);

ALTER TABLE "conversation_turn"
  ADD COLUMN "coordinator_context_key" CHAR(64);
