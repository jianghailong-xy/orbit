BEGIN;

-- Per-engine health on each machine (installed / version / signed in), reported by the runner
-- heartbeat from the same probe `orbit doctor` prints. NULL means "this runner has not reported
-- yet" — either an older binary or one that has not heartbeaten since the upgrade — which the UI
-- shows as such rather than claiming every engine is missing.
ALTER TABLE "runner" ADD COLUMN "engines" JSONB;

-- Browser-driven install of one engine CLI, mirroring the sign-in relay columns above: one slot
-- per machine, redelivered on each heartbeat until the runner reports a status that moves it on.
ALTER TABLE "runner" ADD COLUMN "install_status" TEXT;
ALTER TABLE "runner" ADD COLUMN "install_engine" TEXT;
ALTER TABLE "runner" ADD COLUMN "install_command" TEXT;
ALTER TABLE "runner" ADD COLUMN "install_message" TEXT;
ALTER TABLE "runner" ADD COLUMN "install_at" TIMESTAMP(3);

COMMIT;
