-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1342: validate 1341's CHECK (docs/session-three-state-plan.md §6 step 3.4).
--
-- VALIDATE takes SHARE UPDATE EXCLUSIVE: it blocks no reader or writer, only another schema change. No DO block, so
-- Prisma sends it as its own statement, outside the transaction that held 1341's ACCESS EXCLUSIVE lock. 1262 left
-- zero terminal rows without both columns and zero open rows with either, and every writer sets them together, so
-- the scan finds nothing. If it does find a row (a replica older than the release-fact work wrote one after 1262),
-- the migration fails and names the row: fix the row, never the CHECK.
-- Can run twice: VALIDATE on a valid constraint is a no-op.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

SET lock_timeout = 0;

ALTER TABLE "session" VALIDATE CONSTRAINT "session_release_fact_chk";

RESET lock_timeout;
