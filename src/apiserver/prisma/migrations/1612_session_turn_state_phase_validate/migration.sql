-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1612: validate 1611's value CHECKs on session.turn_state and session.phase (docs/session-status-retirement-plan.md
-- §4.1 deploy D1, §4.6; project 353SgnUjvamRr06Sho0EZ, task T2).
--
-- Both are trivially true on every row that exists when 1611 commits: the columns are new and null. Every row written
-- since was checked by the NOT VALID constraints, and the triggers only write allowed values. So the scan finds
-- nothing; if it ever does, the migration fails and names the row: fix the row, never the CHECK.
--
-- HOW PRISMA RUNS IT, LOCKS
-- -------------------------
-- No DO block, so prisma migrate deploy sends it statement by statement, and the VALIDATEs do not run under 1611's
-- ACCESS EXCLUSIVE lock, which 1611 released when it committed. Each takes SHARE UPDATE EXCLUSIVE for its scan: it
-- blocks no reader or writer, only another schema change.
--
-- RE-RUNNABILITY
-- --------------
-- VALIDATE on a valid constraint is a no-op. 1612: next to 1611 (numbering in 1611's header).
-- ══════════════════════════════════════════════════════════════════════════════════════════════

SET lock_timeout = 0;

ALTER TABLE "session" VALIDATE CONSTRAINT "session_turn_state_chk";

ALTER TABLE "session" VALIDATE CONSTRAINT "session_phase_chk";

RESET lock_timeout;
