-- Latest Claude subscription quota for the account a runner uses (the `/usage`
-- popover numbers: 5-hour / 7-day windows), reported via heartbeat and surfaced
-- per-runner in the UI. Shape mirrors @orbit/shared PlanUsage; null until a runner
-- that supports it heartbeats in (older/api-key runners leave it null).
ALTER TABLE "runner" ADD COLUMN "plan_usage" JSONB;
