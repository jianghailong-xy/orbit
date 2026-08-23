-- Rollback for 0155. Not read by Prisma (which reads only `migration.sql`); it exists so a rollback
-- is a reviewed script rather than one improvised at 3am. Re-runnable, in the reverse order.
--
-- WHAT ROLLING THIS BACK COSTS
-- ============================
--   * Every recorded answer is deleted, including the APPLIED ones. The tasks those answers
--     authorised STAY — they are ordinary tasks in their project, with their provenance columns
--     intact (0150) — so nothing is orphaned and nothing is silently unfiled. What is lost is the
--     evidence of WHO said yes to each of them, and the row that made a second application of one
--     yes impossible.
--   * Consequently: rolling back and rolling forward again does NOT restore the state. The
--     crossings come back unanswered, and a coordinator that retries one asks the user again. That
--     is the safe direction — an approval nobody can produce a record of is not an approval — but
--     it is a real cost and it is the reason this file deletes rather than tries to preserve.
--   * Rolling back does not loosen any rule: without the table there is no approval, so R10 refuses
--     every crossing and the server is back to "declared crossings are impossible", which is what
--     it did before this unit.

DROP TRIGGER IF EXISTS "project_handoff_approval_guard" ON "project_handoff_approval";
DROP FUNCTION IF EXISTS "project_handoff_approval_guard"();

DROP INDEX IF EXISTS "project_handoff_approval_from_state_idx";
DROP INDEX IF EXISTS "project_handoff_approval_to_state_idx";
DROP INDEX IF EXISTS "project_handoff_approval_applied_task_idx";
DROP INDEX IF EXISTS "project_handoff_approval_crossing_idx";

DROP TABLE IF EXISTS "project_handoff_approval";
