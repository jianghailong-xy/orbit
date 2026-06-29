ALTER TABLE "agent" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'claude';

ALTER TABLE "session" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'claude';
ALTER TABLE "session" ADD COLUMN "runtime_session_id" TEXT;

UPDATE "session"
SET "runtime_session_id" = "claude_session_id"
WHERE "runtime_session_id" IS NULL AND "claude_session_id" IS NOT NULL;
