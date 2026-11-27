-- 1750 — runner_presence.last_heard_at: when the beating process last opened a link connection, its Welcome
-- (docs/runner-link-design.md §15.16, runners/runner-presence.ts).
--
-- Presence was written by heartbeats alone. On a weak network (ai-sg, 2026-11-27 17:21–17:44Z, up to 30% loss) the link
-- dropped every 10–40 s and every new connection still said Hello, while its heartbeats queued behind the event resend or
-- died with the connection, so the runner read OFFLINE while it was visibly reconnecting. Now the welcome route writes
-- this column (recordRunnerLinkOpened), only on a LINK row of the process that connects, never creating a row. Event
-- batches and RPCs do not: on a stable connection, a stuck work loop whose engine still emits events keeps going offline
-- 90 s after its last beat. Readers of presence take GREATEST(last_beat_at, LEAST(last_heard_at, last_beat_at + 5 min),
-- runner.last_heartbeat_at): a Welcome never keeps a runner present more than RUNNER_HEARD_CAP_MS past its last beat.
--
-- UNLOGGED like the rest of the table: a crash or a failover empties it, and nothing is heard until the next beat
-- recreates the row. TIMESTAMP(3), the type of last_beat_at, written on Postgres' clock in UTC. Nullable, no default:
-- catalog-only, no row is rewritten, no trigger, no index (every write and read is by the primary key).
--
-- 1750: written as 1673 on its task branch and renumbered when it landed on main (2026-11-27): 1680–1730 had landed
-- on main meanwhile and 1735–1741 were taken on branches, so it runs after them. It was never applied anywhere as
-- 1673. Can run twice.

ALTER TABLE "runner_presence" ADD COLUMN IF NOT EXISTS "last_heard_at" TIMESTAMP(3);
