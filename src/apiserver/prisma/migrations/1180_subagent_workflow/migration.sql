CREATE TABLE "subagent_workflow_run" (
  "id" UUID NOT NULL,
  "owner_id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "tool_use_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "phases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "script" TEXT NOT NULL,
  "script_sha256" TEXT NOT NULL,
  "args" JSONB,
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "result" TEXT,
  "error" TEXT,
  "max_cost_usd" DOUBLE PRECISION,
  "cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "calls_done" INTEGER NOT NULL DEFAULT 0,
  "calls_failed" INTEGER NOT NULL DEFAULT 0,
  "wake_owed" BOOLEAN NOT NULL DEFAULT false,
  "wake_filed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at" TIMESTAMPTZ(3),
  CONSTRAINT "subagent_workflow_run_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subagent_workflow_run_status_chk" CHECK ("status" IN ('RUNNING', 'DONE', 'FAILED', 'INTERRUPTED', 'STOPPED')),
  CONSTRAINT "subagent_workflow_run_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "subagent_workflow_run_session_id_tool_use_id_key" ON "subagent_workflow_run"("session_id", "tool_use_id");
CREATE INDEX "subagent_workflow_run_session_id_status_idx" ON "subagent_workflow_run"("session_id", "status");
CREATE INDEX "subagent_workflow_run_wake_unfiled_idx" ON "subagent_workflow_run"("ended_at")
  WHERE "wake_owed" AND "wake_filed_at" IS NULL AND "status" <> 'RUNNING';

ALTER TABLE "subagent_run"
  ADD COLUMN "workflow_run_id" UUID,
  ADD COLUMN "call_index" INTEGER,
  ADD COLUMN "label" TEXT,
  ADD COLUMN "phase" TEXT,
  ADD CONSTRAINT "subagent_run_workflow_run_id_fkey"
    FOREIGN KEY ("workflow_run_id") REFERENCES "subagent_workflow_run"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

CREATE UNIQUE INDEX "subagent_run_workflow_run_id_call_index_key" ON "subagent_run"("workflow_run_id", "call_index");

ALTER TABLE "workspace" ALTER COLUMN "subagents_max_running" SET DEFAULT 8;
UPDATE "workspace" SET "subagents_max_running" = 8 WHERE "subagents_max_running" = 4;
