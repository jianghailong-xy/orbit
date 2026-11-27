-- 1410 — the bg_run jobs a session's owner asked to stop from the app (POST /sessions/:id/background/jobs/:jobId/stop).
--
-- session.bg_job_stop_requests: job ids (`bgj_…`) of session.running_bg_jobs the owner asked to stop. Every full
-- heartbeat answer to the session's runner lists the ones still running (stopBackgroundJobs); an id that is no longer
-- running is inert, and the route prunes the list as it adds to it.
--
-- Existing rows get the empty list. No UPDATE or DELETE. The statement can run twice.

ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "bg_job_stop_requests" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
