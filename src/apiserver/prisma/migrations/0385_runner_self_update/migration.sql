-- 0385 — where a runner's updates of itself stand, and the owner's "Update Runner Now".
--
-- Until now a runner pinned to an old release said so only in its own runner.log: the install
-- directory not writable by the service user, ORBIT_NO_SELFUPDATE in a LaunchAgent, a download
-- that failed its checksum. The Runners page could only guess, from `runs_as_root`, and for a
-- runner the macOS App installed the guess prescribed a `sudo orbit upgrade` that was wrong.
--
-- `self_update` is the runner's own report, from every heartbeat: @orbit/shared RunnerSelfUpdate
-- (state, reason, installDir, lastUpdatedAt/From/To), sanitized on the way in and out. Rewritten
-- by every beat, including back to NULL when a beat omits it: NULL is "this runner does not
-- report it", and a runner rolled back to a release older than the field must read that way
-- rather than keep the state a newer binary last reported. No backfill: every existing runner
-- reads NULL until its first heartbeat from a release that reports.
--
-- `self_update_requested_at` is the owner asking for a release check now. A one-slot request like
-- `model_catalog_refresh_at` (0240), for the same reason: nothing is reported back but the state
-- above, so the timestamp is cleared as the next heartbeat hands it over. NULL = nobody asked.
--
-- Two nullable columns with no default, so both ADDs are catalog-only. No index (the only readers
-- go by primary key), no trigger, no constraint, no DML.

ALTER TABLE "runner" ADD COLUMN "self_update" JSONB;
ALTER TABLE "runner" ADD COLUMN "self_update_requested_at" TIMESTAMP(3);
