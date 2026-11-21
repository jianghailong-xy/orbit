-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1402: make the rows whole again, then validate 1401's CHECK (docs/session-three-state-plan.md §6 step 3.4).
--
-- WHY IT WRITES ROWS FIRST
-- ------------------------
-- 1262 left zero terminal rows without finished_at and zero open rows with it, but the release that carried 1262 was
-- deployed with a hand-over: the server of the release before it kept running for a short while after 1262's UPDATE,
-- and it knows nothing of the release fact. A session it ended in that window is terminal with no finished_at (from
-- three of its writers); a session it revived that 1262 had backfilled is open with the finished_at 1262 wrote (its
-- revive does not clear a column it has never heard of). Nothing else fixes those rows, and this VALIDATE would fail
-- on them and stop the deploy. So, before it:
--   1. a terminal row with no finished_at gets 1262's value for it, the same expression: it writes only rows where
--      finished_at is still null, so rows 1262 or a writer already made whole are not touched;
--   2. an open row with finished_at has it cleared, as today's revive clears it.
-- release_cause is not written (2026-11-21, design §12 decision D9: the session keeps no failure fact and the column
-- goes, design §12.6 step R1). An earlier version of this file also gave terminal rows 1262's cause and cleared the
-- cause on open rows, for a second clause of 1401's CHECK that R1 removed before either file was deployed. A row this
-- file heals keeps whatever release_cause it had; session_release_cause_chk (1261, 1403/1404) holds only its value.
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
-- Where an earlier version of this file is recorded as applied, `migrate deploy` does not run it again, and needs
-- not: that database validated the CHECK, so it holds no such row (for the two-clause CHECK, see 1401's header).
-- ══════════════════════════════════════════════════════════════════════════════════════════════

SET statement_timeout = 0;

UPDATE "session" s
   SET "finished_at" = COALESCE(s."completed_at", s."deleted_at", s."updated_at")
 WHERE s."status"::text IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
   AND s."finished_at" IS NULL;

UPDATE "session"
   SET "finished_at" = NULL
 WHERE "status"::text NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
   AND "finished_at" IS NOT NULL;

RESET statement_timeout;

SET lock_timeout = 0;

ALTER TABLE "session" VALIDATE CONSTRAINT "session_release_fact_chk";

RESET lock_timeout;
