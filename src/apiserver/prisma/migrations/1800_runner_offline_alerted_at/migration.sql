-- 1800 — runner.offline_alerted_at: when the owner was last told this runner went offline, and so is owed a
-- "back online" push (realtime/reaper.service.ts alertRunnerPresence, PushService.notifyRunnerPresence).
--
-- The reaper sets it when a runner that did not sign off or drain has been silent past RUNNER_REAP_AFTER_MS, and the
-- owner's devices are told; it clears it when the runner reads online again, and the owner is told it is back. Set and
-- cleared by a conditional update, so two sweeps never send the same alert twice. Null: no offline alert is open.
--
-- Nullable, no default: catalog-only, no row is rewritten, no trigger, no index (the sweep reads the owner's runners
-- by the runner table it already scans). Can run twice.

ALTER TABLE "runner" ADD COLUMN IF NOT EXISTS "offline_alerted_at" TIMESTAMP(3);
