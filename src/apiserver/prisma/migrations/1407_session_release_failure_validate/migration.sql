-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1407: validate 1406's CHECK, session_release_failure_chk.
--
-- VALIDATE takes SHARE UPDATE EXCLUSIVE: it blocks no reader or writer, only another schema change. No DO block, so
-- Prisma sends it as its own statement, outside the transaction that held 1406's ACCESS EXCLUSIVE lock. 1405 left
-- zero FAILED rows without a failure cause, no writer or backfill ever gave a SUCCEEDED or CANCELLED row one, and
-- every writer decides its cause with its status, so the scan finds nothing. If it does find a row (a replica older
-- than this task's writers wrote one after 1405), the migration fails and names the row: fix the row, never the
-- CHECK. Ships with 1405 and 1406 (see 1406's header). Can run twice: VALIDATE on a valid constraint is a no-op.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

SET lock_timeout = 0;

ALTER TABLE "session" VALIDATE CONSTRAINT "session_release_failure_chk";

RESET lock_timeout;
