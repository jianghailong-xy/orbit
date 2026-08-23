-- Rollback for 0156. Not read by Prisma (which reads only `migration.sql`); it exists so a rollback
-- is a reviewed script rather than one improvised at 3am. Re-runnable, in the reverse order.
--
-- WHAT ROLLING THIS BACK COSTS
-- ============================
--   * The recorded coordination scope of every task is deleted, and it does NOT come back. Rolling
--     forward again re-runs the backfill, which reconstructs only what `project_decision` and the
--     live coordinator binding can still prove — so every attribution written at CREATION time
--     since this migration landed is lost for good. That is the real cost of this file, and it is
--     why it drops columns rather than trying to preserve them somewhere.
--   * With the columns gone the run-time gate has nothing to compare, so `decideTaskOwnership`
--     answers `UNATTRIBUTED` for everything and every mis-filed task becomes runnable again. This
--     rollback therefore REOPENS the incident; it does not merely remove a feature. Roll the
--     binary back first, or the service will be reading a column that is not there.
--   * Open `PROJECT_OWNERSHIP_MISMATCH` blockers are deleted with the same statement that narrows
--     the CHECK, because a value the constraint no longer admits cannot be left in the column. What
--     is lost is a row somebody was being asked to act on — so read them before running this.
--   * The replacements a repair already filed STAY. They are ordinary tasks in the project that
--     owns them, and the tasks they replaced stay CANCELLED/ABANDONED: a repair that was carried
--     out is not undone by removing the thing that found it. What is lost is the uniqueness of the
--     mapping, so nothing after this stops a second replacement being filed for one original.

DROP INDEX IF EXISTS "task_ownership_refile_source_uq";

DELETE FROM "project_blocker" WHERE "kind" = 'PROJECT_OWNERSHIP_MISMATCH';

ALTER TABLE "project_blocker" DROP CONSTRAINT IF EXISTS "project_blocker_kind_chk";
ALTER TABLE "project_blocker" ADD CONSTRAINT "project_blocker_kind_chk"
  CHECK ("kind" IN (
    'WHO_UNRESOLVED', 'WHO_NOT_IN_TEAM', 'WHO_DISABLED', 'PROVIDER_UNAVAILABLE',
    'RUNTIME_REQUIREMENT_UNMET', 'NO_PROJECT_WORKSPACE', 'NO_MATCHING_RUNNER',
    'MERGE_CONFLICT', 'TEST_FAILED', 'VERIFICATION_FAILED', 'BUDGET_EXHAUSTED',
    'AWAITING_USER_APPROVAL', 'AWAITING_USER_INPUT', 'POLICY_MANUAL_HOLD',
    'DEPENDENCY_CYCLE', 'COORDINATOR_UNAVAILABLE', 'COORDINATOR_NO_PROGRESS',
    'AGGREGATE_PARENT_UNSATISFIABLE', 'SUCCESSOR_OUTSIDE_SUBTREE', 'VERIFICATION_REQUIRED',
    'VERIFICATION_CANNOT_CONCLUDE', 'ENVIRONMENT_BROKEN', 'HUMAN_DECISION_REQUIRED',
    'VERDICT_APPLY_EXHAUSTED',
    'UNKNOWN_FAILURE'
  ));

DROP INDEX IF EXISTS "task_creator_scope_mismatch_idx";

DROP TRIGGER IF EXISTS "task_creator_scope_retire_on_move" ON "task";
DROP FUNCTION IF EXISTS "task_creator_scope_retire_on_move"();

DROP TRIGGER IF EXISTS "task_creator_scope_immutable_guard" ON "task";
DROP FUNCTION IF EXISTS "task_creator_scope_immutable"();

ALTER TABLE "task"
  DROP COLUMN IF EXISTS "creator_coordinator_generation",
  DROP COLUMN IF EXISTS "creator_coordinator_project_id";
