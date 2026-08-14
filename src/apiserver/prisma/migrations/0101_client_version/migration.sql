-- Which build of each client a user is running, so a wire-format migration has a gate it can
-- actually query instead of a guess it has to make.
--
-- The motivating evidence is in the tree already: `workspace-alias.interceptor.ts` says "DELETE
-- THIS once every client in the field speaks `workspace*`", and it is still running — not because
-- the cutover is hard, but because nothing can answer whether it is safe. Runners were the one
-- client already covered (`runner.version`, sent on every heartbeat). A browser tab nobody
-- reloaded and a TestFlight build from last month were covered by nothing.
--
-- Started now, deliberately ahead of the migration that consumes it (the base62 public-id
-- cutover, docs/public-id-migration-design.md): the value of this table is the age of its data.
-- Creating it at the moment you want to drop an old field means waiting a full upgrade cycle
-- before it can tell you anything.
--
-- Keyed by (user, kind), not by device or session: the question is "what is this user's iOS app
-- on", and a user with a current browser and a stale phone has to read as stale. Runners are
-- excluded on purpose — `runner.version` already answers for them, and a second source of truth
-- for one fact is how the two end up disagreeing.
--
-- No history rows. "What is in the field right now" is the whole question; a per-version audit
-- trail would grow without bound to answer one nobody asked.
CREATE TABLE "client_version" (
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_version_pkey" PRIMARY KEY ("user_id", "kind")
);

ALTER TABLE "client_version"
    ADD CONSTRAINT "client_version_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
