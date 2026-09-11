-- What the runner said about a commit that went through.
--
-- A runner reports a message with every commit outcome, and only a failed commit's was kept
-- (`commit_error`); for `committed` and `nochange` it was dropped. What a runner puts there on
-- success is something a person needs to see: before committing it may evict the session's parked
-- engine — the engine was running MCP servers the agent configured itself — and it says so in this
-- message. Dropping it left the only account of why the engine was gone in the runner's own log.
--
-- A column of its own rather than a wider `commit_error`: that column means the commit failed, and
-- every client reads it that way. A reported outcome's message is in exactly one of the two.
--
-- Nullable with no default: a catalog-only change. There is no backfill; every existing session
-- reads NULL, which is what a commit that reported nothing reads.
ALTER TABLE "session" ADD COLUMN "commit_result_message" TEXT;

COMMENT ON COLUMN "session"."commit_result_message" IS
  'The runner''s message for a commit that went through (commit_status committed or nochange), verbatim. A failed commit keeps its message in commit_error; cleared wherever commit_error is.';
