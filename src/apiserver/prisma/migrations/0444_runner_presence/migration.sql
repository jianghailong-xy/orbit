-- 0444 — runner_presence: when each runner was last heard from, in a table of its own
-- (docs/runner-link-design.md §5.7, §6.5).
--
-- Until now every heartbeat rewrote `runner.last_heartbeat_at`, and every online reading read that
-- column. From here on a heartbeat upserts the runner's one row here — the HTTP heartbeat now
-- (POST /api/runner/heartbeat), the link gateway's heartbeat once the link carries runners — and
-- `runner.last_heartbeat_at` becomes a low-frequency record that a heartbeat rewrites at most every
-- five minutes. Every online reading goes through runners/runner-presence.ts, which takes the later
-- of the two, so a reading never goes back in time: where this table has no row for a runner, the
-- runner's own record answers.
--
-- UNLOGGED: never written to the WAL, so a beat is cheap, and never replicated. PostgreSQL empties
-- the table when it recovers from a crash, and a promoted standby starts with it empty. That loses
-- nothing that lasts — every live runner writes its row again within one heartbeat interval — as
-- long as nothing reads the empty table as a fleet that died, and the reaper does not: it reaps no
-- session as `runner offline` for a grace period after it starts, while a fifth of the cell's
-- runners have gone quiet together, or while heartbeat writes are failing
-- (realtime/reaper.service.ts).
--
--   runner_id       the runner; its row goes with it (ON DELETE CASCADE). An UNLOGGED table may
--                   reference a permanent one; only the reverse is refused.
--   process_id      the process that beat: its lease owner, the heartbeat's `leaseOwner`, a UUID
--                   per runner process. NULL for a runner too old to send one.
--   gateway_id      the link gateway node holding the runner's connection. NULL over HTTP.
--   last_beat_at    when the beat was received. TIMESTAMP(3), the type of runner.last_heartbeat_at,
--                   so GREATEST of the two compares like with like.
--   link_state      what carried the beat: 'HTTP' or 'LINK'. The CHECK says which; another state
--                   is a decision for the migration that writes it.
--   facts_hash      the runner's hash of the facts it reports (model catalogue, skills, engine state,
--                   repository health), so a link heartbeat can say "unchanged". NULL over HTTP,
--                   which sends the facts themselves on every beat.
--   reconcile_hash  the hash of what the last full reconciliation compared. NULL over HTTP, which
--                   reconciles in full on every beat.
--
-- Nothing is written to an existing row and nothing is backfilled: the table starts empty, and until
-- a runner's next heartbeat writes its row, readings answer from `runner.last_heartbeat_at`, which
-- every heartbeat wrote until this migration. No trigger is created.

CREATE UNLOGGED TABLE "runner_presence" (
    "runner_id" UUID NOT NULL,
    "process_id" UUID,
    "gateway_id" TEXT,
    "last_beat_at" TIMESTAMP(3) NOT NULL,
    "link_state" TEXT NOT NULL,
    "facts_hash" TEXT,
    "reconcile_hash" TEXT,

    CONSTRAINT "runner_presence_pkey" PRIMARY KEY ("runner_id"),
    CONSTRAINT "runner_presence_link_state_chk" CHECK ("link_state" IN ('HTTP', 'LINK'))
);

ALTER TABLE "runner_presence" ADD CONSTRAINT "runner_presence_runner_id_fkey" FOREIGN KEY ("runner_id") REFERENCES "runner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
