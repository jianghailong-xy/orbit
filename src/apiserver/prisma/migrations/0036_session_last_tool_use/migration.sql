-- Denormalized "frontier" activity for the sidebar's live status line: the tool name
-- when a tool_use is the latest durable event for a RUNNING session (in flight, no
-- tool_result yet), cleared to NULL on any other frontier. Written on event ingestion.
-- No backfill: this is transient live state, populated on the next event batch; a stale
-- value on a non-running session is never shown (the list gates display on status).
ALTER TABLE "session" ADD COLUMN "last_tool_use" TEXT;
