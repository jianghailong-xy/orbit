-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1404: validate 1403's widened session_release_cause_chk.
--
-- VALIDATE takes SHARE UPDATE EXCLUSIVE: it blocks no reader or writer, only another schema change. No DO block, so
-- Prisma sends it as its own statement, outside the transaction that held 1403's ACCESS EXCLUSIVE lock. Every stored
-- value passed 1261's narrower list (validated by 1262), so the scan finds nothing.
-- Ships with 1403 (see its header). Can run twice: VALIDATE on a valid constraint is a no-op.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

SET lock_timeout = 0;

ALTER TABLE "session" VALIDATE CONSTRAINT "session_release_cause_chk";

RESET lock_timeout;
