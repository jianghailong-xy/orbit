-- 0720 — runner_presence.resources: the machine's CPU, memory and disk, and its last hour of them.
--
-- A runner that declares machine-resources/v1 reports a reading on every heartbeat (RunnerHeartbeatRequest.resources),
-- for the Resources section of the machine's page. It is kept here, beside the beat, by the statement that already
-- writes the beat (runners/runner-presence.ts, runner-api/link-heartbeat.ts): a link beat stays one statement.
--
--   resources   NULL until the runner reports one; then {"at": epoch ms, "latest": <the reading>, "samples":
--               [[epoch ms, cpu %, memory %, disk %], …]}, the samples within an hour of "at", oldest first. A beat
--               that carries no reading leaves it as it is, so an offline machine shows its last hour.
--
-- UNLOGGED like the rest of the table: a crash or a failover empties it, and the page shows no reading until the next
-- beat — nothing that lasts is lost. Nullable, no default: catalog-only, no row is written, no trigger is created.

ALTER TABLE "runner_presence" ADD COLUMN IF NOT EXISTS "resources" JSONB;
