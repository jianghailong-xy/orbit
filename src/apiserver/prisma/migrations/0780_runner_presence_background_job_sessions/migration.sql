-- 0780 — runner_presence.background_job_session_ids: the sessions a runner's background jobs hold slots for.
--
-- A runner counts a session as using one of its maxConcurrent slots while it holds a turn permit OR while runner-hosted
-- background jobs of its own (bg_run, kind job) still run (src/runner-go/session_pool.go admissionOccupancy). The
-- second kind runs no turn, so the runners list, which counted turns alone, read a full machine as "12 of 16 running"
-- while it claimed nothing. Each beat now names those sessions (RunnerHeartbeatRequest.backgroundJobSessionIds), and
-- the beat's own write keeps them here (runner-api/link-heartbeat.ts readLinkBeat, runners/runner-presence.ts
-- recordRunnerBeat): replaced on every beat, empty for a beat that names none, which an older runner never does.
-- The runners list counts them as running while the runner is online (runners/runner-background-holders.ts).
--
-- UNLOGGED like the rest of the table: a crash or a failover empties it, and the list counts turns alone until the
-- next beat. NOT NULL with a constant default: catalog-only, no row is rewritten, no trigger is created.

ALTER TABLE "runner_presence" ADD COLUMN IF NOT EXISTS "background_job_session_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];
