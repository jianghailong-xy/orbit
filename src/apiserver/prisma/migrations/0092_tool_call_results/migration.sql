-- tool_call already had output / is_error / finished_at columns, but the ingestion only ever
-- wrote name / input / started_at: a tool_result event lands in a later batch than its tool_use,
-- and with no id on the row there was nothing to join it back to, so those three columns were
-- unreachable and NULL on every row ever written. That made the table answer "what did the agent
-- call" but not "did it succeed" — the second half of the question a diagnosis actually asks (did
-- this task_create write, or fail?).
--
-- This adds the pairing key and the index the result update reads. Backfill is impossible (the
-- result payloads were never stored on this row), so historical rows keep NULL results; only calls
-- ingested after this migration carry outcomes.
ALTER TABLE "tool_call" ADD COLUMN "tool_use_id" TEXT;

CREATE INDEX "tool_call_session_id_tool_use_id_idx" ON "tool_call" ("session_id", "tool_use_id");
