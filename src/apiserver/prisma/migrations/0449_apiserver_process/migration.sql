-- 0449 — apiserver_process: the apiserver processes of this deployment, as each one reports itself
-- (realtime/control-plane-leader.ts, runners/runner-presence.ts; docs/self-hosting.md "Several apiservers").
--
-- One apiserver process runs the reaper, and the reaper reads a runner's silence for its death only while
-- this control plane could have heard it: not just after it started, not while a fifth of the cell is quiet,
-- and not while heartbeat writes are failing. The last of those was a fact kept in the memory of the process
-- that took the beat, which was every beat while there was one apiserver. With several, the link gateway
-- spreads beats over all of them, and a process whose database connections are exhausted fails the beats
-- it takes while the reaper on another process reads the silence that leaves as runners gone. So each
-- process reports here, and the reaper reads every other process's report before it reaps for silence:
--
--   id             the process: a UUID it draws when it starts. It also names the session-level advisory
--                  lock the process holds for as long as it is connected (hashtextextended of
--                  'orbit:apiserver-process:' and this id), which is how another process tells a process
--                  that has gone quiet but is still there from one that has gone.
--   started_at     when the process first wrote its row.
--   seen_at        when it last did: every ten seconds, through the same connection pool its heartbeats
--                  are written through, so a process whose pool cannot write goes quiet here too.
--   beat_lost_at   when a heartbeat it took last failed to be written, or when it last came back from
--                  being quiet; null until then. Written at the database's clock, as seen_at is.
--
-- No foreign key and no trigger: nothing else names a process. Rows of processes that have gone are
-- purged by the reaper's hourly pass a day after they were last seen. Nothing is backfilled: the table
-- starts empty and each process writes its row within one interval of starting. The one statement can run
-- twice.

CREATE TABLE IF NOT EXISTS "apiserver_process" (
    "id" UUID NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "beat_lost_at" TIMESTAMP(3),

    CONSTRAINT "apiserver_process_pkey" PRIMARY KEY ("id")
);
