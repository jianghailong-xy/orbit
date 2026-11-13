-- Written as 0536; renumbered to 0605 before landing, main having reached 0595 and 0600 being taken on another branch.
-- Cross-workspace SubAgents (docs/subagent-design.md §10): a run may go to another workspace of the parent's
-- repository, on that workspace's runner. `workspace_id` and `target_runner_id` name where; `remote` keeps what the
-- target runner needs that the parent's machine had locally (the brief, read-only flag, permission mode, needs);
-- `claimed_at` and `stop_requested_at` are the hand-over and the parent's stop. No existing row changes meaning:
-- every one of them is a run on the parent's own machine, with all of these NULL.
ALTER TABLE "subagent_run"
  ADD COLUMN "workspace_id" UUID,
  ADD COLUMN "target_runner_id" UUID,
  ADD COLUMN "remote" JSONB,
  ADD COLUMN "claimed_at" TIMESTAMPTZ(3),
  ADD COLUMN "stop_requested_at" TIMESTAMPTZ(3);

ALTER TABLE "subagent_run" ADD CONSTRAINT "subagent_run_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- What a runner's heartbeat reads: the runs it is the target of, by status.
CREATE INDEX "subagent_run_target_runner_id_status_idx" ON "subagent_run"("target_runner_id", "status");

-- The events a remote run's target runner relayed, rewritten for the parent's stream, numbered by the run.
CREATE TABLE "subagent_relay_event" (
  "id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "seq" INTEGER NOT NULL,
  "type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subagent_relay_event_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "subagent_relay_event_run_id_seq_key" ON "subagent_relay_event"("run_id", "seq");
ALTER TABLE "subagent_relay_event" ADD CONSTRAINT "subagent_relay_event_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "subagent_run"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
