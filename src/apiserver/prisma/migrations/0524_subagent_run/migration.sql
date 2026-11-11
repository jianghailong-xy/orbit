-- SubAgent (docs/subagent-design.md §6.1, §6.2): the per-Agent switch and running cap, and one row per
-- delegate call. No existing row, trigger or DONE fence is touched.
ALTER TABLE "workspace"
  ADD COLUMN "subagents_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "subagents_max_running" INTEGER NOT NULL DEFAULT 4;

CREATE TABLE "subagent_run" (
  "id" UUID NOT NULL,
  "owner_id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "tool_use_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "definition_source" TEXT NOT NULL,
  "background" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "decision" JSONB NOT NULL,
  "attempts" JSONB NOT NULL DEFAULT '[]',
  "result_summary" TEXT,
  "changed_files" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "usage" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at" TIMESTAMPTZ(3),
  CONSTRAINT "subagent_run_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subagent_run_status_chk" CHECK ("status" IN ('RUNNING', 'DONE', 'FAILED', 'INTERRUPTED', 'STOPPED'))
);

CREATE UNIQUE INDEX "subagent_run_session_id_tool_use_id_key" ON "subagent_run"("session_id", "tool_use_id");
CREATE INDEX "subagent_run_session_id_status_idx" ON "subagent_run"("session_id", "status");

ALTER TABLE "subagent_run" ADD CONSTRAINT "subagent_run_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
