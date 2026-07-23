-- L3 orchestration: agents may opt in to spawning/managing other sessions via `orbit mcp`.
ALTER TABLE "agent" ADD COLUMN "enable_orchestration" BOOLEAN NOT NULL DEFAULT false;

-- A session spawned by another session's agent points back at its parent (orchestration
-- tree + spawn-depth / child-count guards). SetNull so purging a parent detaches its children.
ALTER TABLE "session" ADD COLUMN "parent_session_id" UUID;

ALTER TABLE "session" ADD CONSTRAINT "session_parent_session_id_fkey"
  FOREIGN KEY ("parent_session_id") REFERENCES "session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "session_parent_session_id_idx" ON "session"("parent_session_id");
