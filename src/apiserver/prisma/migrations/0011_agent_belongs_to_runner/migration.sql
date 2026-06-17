-- Agents now belong to a Runner (the machine): one Runner -> many Agents.
-- `orbit register` mints one Runner per machine (named by hostname) and one Agent
-- per coding-tool/project-dir, bound to that runner via runner_id.
ALTER TABLE "agent" ADD COLUMN "runner_id" UUID;
ALTER TABLE "agent" ADD COLUMN "work_dir" TEXT;
ALTER TABLE "agent" ADD COLUMN "agent_key" TEXT;

CREATE INDEX "agent_runner_id_idx" ON "agent"("runner_id");

-- Cascade: unregistering a machine (deleting its runner) removes its agents.
-- Sessions referencing those agents keep their history (session.agent_id is SET NULL).
ALTER TABLE "agent" ADD CONSTRAINT "agent_runner_id_fkey"
  FOREIGN KEY ("runner_id") REFERENCES "runner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The project directory the minted agents run in, captured at `orbit register`.
ALTER TABLE "device_enrollment" ADD COLUMN "work_dir" TEXT;
