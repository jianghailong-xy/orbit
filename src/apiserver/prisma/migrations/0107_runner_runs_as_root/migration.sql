-- Whether a runner's process is root, reported each heartbeat. See Runner.runsAsRoot: Claude Code
-- refuses `--permission-mode bypassPermissions` under root and exits during startup, so this is the
-- fact that lets the pickers and dispatch withdraw that one mode.
--
-- Deliberately nullable with no default. NULL is "this runner has not told us yet", which stays
-- unrestricted; the first heartbeat from an updated runner replaces it with true/false. A
-- `NOT NULL DEFAULT false` would instead assert that every runner in the fleet is non-root the
-- moment this runs — including the root one whose sessions are the reason for the column.
ALTER TABLE "runner" ADD COLUMN "runs_as_root" BOOLEAN;
