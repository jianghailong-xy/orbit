-- claude_session_id was fully redundant with runtime_session_id: every write path set both to
-- the same value, and every read coalesced the two. Backfill defensively (0050 already did this
-- in the other direction) so no id is lost if a legacy replica wrote only the Claude column,
-- then drop it. `provider` records which runtime owns the surviving id.
UPDATE "session"
SET "runtime_session_id" = "claude_session_id"
WHERE "runtime_session_id" IS NULL AND "claude_session_id" IS NOT NULL;

ALTER TABLE "session" DROP COLUMN "claude_session_id";
