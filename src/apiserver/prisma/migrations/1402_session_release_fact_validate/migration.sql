-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1402: make the rows whole again, then validate 1401's CHECK (docs/session-three-state-plan.md §6 step 3.4).
--
-- WHY IT WRITES ROWS FIRST
-- ------------------------
-- 1262 left zero terminal rows without both columns and zero open rows with either, but the release that carried
-- 1262 was deployed with a hand-over: the server of the release before it kept running for a short while after
-- 1262's UPDATE, and it knows nothing of the release fact. A session it ended in that window is terminal with no
-- release_cause (and, from three of its writers, no finished_at); a session it revived that 1262 had backfilled is
-- open with the release_cause 1262 wrote (its revive clears finished_at, not the cause it has never heard of).
-- Nothing else fixes those rows, and this VALIDATE would fail on them and stop the deploy. So, before it:
--   1. 1262's UPDATE, the same statement with the same rules: it writes only terminal rows where a column is
--      still null, so rows 1262 or a writer already made whole are not touched;
--   2. an open row with finished_at or release_cause has both cleared, as today's revive clears them.
-- FAILED rows the first step writes take 1262's causes (engine_exited, an end reason), which are not failure causes;
-- 1405, which runs after this file, rewrites every FAILED row whose cause is not a failure, these included.
-- No replica older than the release-fact work can write after this point: this file ships only once every replica
-- runs that release (1401's header), and 1401's NOT VALID CHECK already refuses any new write that breaks it, so
-- the VALIDATE that follows finds nothing.
--
-- HOW PRISMA RUNS IT, LOCKS
-- -------------------------
-- No DO block and no CREATE PROCEDURE, so `prisma migrate deploy` sends it statement by statement and each statement
-- commits on its own (tested; see 1202's header). Neither UPDATE runs under 1401's ACCESS EXCLUSIVE lock, which 1401
-- released when it committed. Each holds ROW EXCLUSIVE on session (blocks no reader or writer) and a row lock on each
-- row it writes until it commits: a handful of rows from a hand-over window, so in practice a scan of session with
-- almost nothing locked (1262's UPDATE, writing every terminal row of 100,000 sessions, took 0.8 s). statement_timeout
-- is lifted for the two UPDATEs only. The VALIDATE then takes SHARE UPDATE EXCLUSIVE for its scan: it blocks no
-- reader or writer, only another schema change. If it still finds a row, the migration fails and names it: fix the
-- row, never the CHECK.
--
-- RE-RUNNABILITY
-- --------------
-- Can run twice: both UPDATEs write only rows that break the CHECK, and VALIDATE on a valid constraint is a no-op.
-- Where the earlier version of this file (the VALIDATE alone) is recorded as applied, `migrate deploy` does not run
-- it again, and needs not: that database validated the CHECK, so it holds no such row.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

SET statement_timeout = 0;

UPDATE "session" s
   SET "finished_at" = COALESCE(s."finished_at", s."completed_at", s."deleted_at", s."updated_at"),
       "release_cause" = COALESCE(s."release_cause", CASE
         WHEN s."kind" = 'LANDING' THEN 'landing_settled'
         WHEN s."end_reason" IN (
           'task_done', 'task_cancelled', 'ended', 'completed', 'deleted', 'cancelled', 'idle', 'orphaned'
         ) THEN s."end_reason"
         WHEN s."status"::text = 'FAILED' AND s."import_source_cwd" IS NOT NULL THEN 'import_failed'
         WHEN s."status"::text = 'FAILED' AND s."source_state" = 'REFUSED' THEN 'setup_failed'
         WHEN s."status"::text = 'FAILED' AND s."error" = 'runner offline' THEN 'runner_lost'
         WHEN s."status"::text = 'FAILED' AND s."error" LIKE '% runtime not initialized' THEN 'setup_failed'
         WHEN s."status"::text = 'FAILED' AND s."error" = 'cancel not honored' THEN 'cancelled'
         WHEN s."status"::text = 'FAILED' AND s."cancel_requested_at" IS NOT NULL THEN 'turn_failed'
         WHEN s."status"::text = 'CANCELLED' AND s."cancel_requested_at" IS NOT NULL THEN 'cancelled'
         ELSE 'engine_exited'
       END)
 WHERE s."status"::text IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
   AND (s."finished_at" IS NULL OR s."release_cause" IS NULL);

UPDATE "session"
   SET "finished_at" = NULL,
       "release_cause" = NULL
 WHERE "status"::text NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
   AND ("finished_at" IS NOT NULL OR "release_cause" IS NOT NULL);

RESET statement_timeout;

SET lock_timeout = 0;

ALTER TABLE "session" VALIDATE CONSTRAINT "session_release_fact_chk";

RESET lock_timeout;
