-- 1267 — when, on the runner's clock, the events path last moved a session's executing sets (plan step 1.7).
--
-- A runner's beat states what is executing in each session it supervises, and the server replaces the stored sets
-- with it (runners/runner-executing-sets.ts, plan step 1.6). The beat and the event batches travel by different
-- requests, so a beat composed just before a launch can be written after that launch's batch, and its replace then
-- takes the new id out again until the next beat: the session reads as idle for a beat interval while its job runs.
-- The beat now says when it was composed (`executingAt`), and a session whose sets an event batch moved at or after
-- that instant is left as the batch left it.
--
-- Both instants are the runner's own clock: an event's `ts` and the beat's `executingAt`, so no clock skew enters the
-- comparison. NULL until a batch moves the sets. Nullable with no default: adding it rewrites no row.

ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "executing_event_at" TIMESTAMP(3);

COMMENT ON COLUMN "session"."executing_event_at" IS
  'The runner-clock time of the newest event that moved engine_turn_active, running_subagents, running_bg_jobs or running_bg_shells; a beat composed before it does not replace them (runners/runner-executing-sets.ts).';
