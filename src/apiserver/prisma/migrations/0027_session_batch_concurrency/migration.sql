-- Batch-run concurrency, decoupled from the runner's global cap. A "批量运行" batch
-- stamps its sessions with a shared batch_id and the batch's own concurrency limit
-- (batch_max_concurrent). The claim queue gates live sessions per batch on this value,
-- independently of and on top of runner.max_concurrent — so running a batch no longer
-- overwrites the runner's persistent slots. null = not part of any batch (ungated).
ALTER TABLE "session" ADD COLUMN "batch_id" UUID;
ALTER TABLE "session" ADD COLUMN "batch_max_concurrent" INTEGER;

CREATE INDEX "session_batch_id_status_idx" ON "session" ("batch_id", "status");
