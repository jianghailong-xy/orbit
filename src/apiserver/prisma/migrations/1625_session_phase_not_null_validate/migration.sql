-- 1625: validate session_phase_not_null_chk (1622; docs/session-status-retirement-plan.md §4.1 D2, §4.6; task T5).
--
-- No DO block, so prisma migrate deploy sends it statement by statement, and the scan does not run under 1622's ACCESS
-- EXCLUSIVE lock, which 1622 released when it committed. VALIDATE takes SHARE UPDATE EXCLUSIVE: it blocks no reader or
-- writer, only another schema change. 1622 asserted that every row agrees and the constraint has checked every write
-- since, so the scan finds nothing; if it ever does, the migration fails and names the row: fix the row, never the
-- CHECK. VALIDATE on a valid constraint is a no-op.

SET lock_timeout = 0;

ALTER TABLE "session" VALIDATE CONSTRAINT "session_phase_not_null_chk";

RESET lock_timeout;
