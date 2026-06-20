-- Custom environment variables injected into an agent's claude process (string map).
ALTER TABLE "agent" ADD COLUMN "env" JSONB;
