-- The default provider a new session inherits is no longer stored on the agent; it is read from
-- the project's most recent interactive session. This index is that lookup.
-- CreateIndex
CREATE INDEX "session_agent_id_created_at_idx" ON "session"("agent_id", "created_at" DESC);
