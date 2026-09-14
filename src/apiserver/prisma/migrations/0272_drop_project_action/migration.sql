-- `project_action`, dropped with the two columns that pointed at it.
--
-- The table was the control loop's permanent idempotency ledger: one row per task dispatched or
-- refused, blocker raised or cleared, verdict applied, coordinator turn opened and coordinator session
-- rotated. The loop was removed in 6418a1e5 and nothing has written a row since; the newest of the
-- 3616 on the production deployment is from 2026-08-23 20:44:45. 0163 and 0164 kept the table and its
-- two triggers because `tasks/verification-dependency.ts` still read it. That reader, DEP's
-- `VERDICT_NOT_APPLIED` clause, was removed in 9135ae64, so the reason those two headers give no
-- longer holds and nothing reads the table either. Dropped by account-owner decision (2026-09-14).
--
-- ARCHIVED FIRST
-- ==============
-- Before this migration was written, the production rows were dumped on the host, outside git, to
-- /root/orbit/data/archive/project_action-2026-09-14/: the table with its schema, its two enums and
-- its two trigger functions, and the values of both columns removed below (127 sessions, 4
-- verification failures). README.txt there gives the restore order and the fingerprints to check.
--
-- NAMED, NEVER MATCHED
-- ====================
-- Five functions have `project_action` in their name, and two of them belong to this table.
-- `project_action_intent_immutable`, `project_action_commit_immutable` and
-- `project_action_intent_bind_full_revision` are the live guards on `project_ratified_action_intent`
-- and `project_ratified_action_commit`; their bodies never mention this table. So every object below
-- is named exactly, and nothing is removed by pattern.
--
-- ALSO REMOVED
-- ============
-- `VERDICT_APPLY_EXHAUSTED`, from `project_blocker_kind_chk`. The only code that could raise that kind
-- was `projects/task-verification-verdict.ts`, the retry policy for applying a verdict through this
-- ledger, which has had no caller since 6418a1e5 and is deleted in the same change. The production
-- deployment holds no blocker of that kind, so the narrowed CHECK validates there. Every other kind
-- is restated exactly as 0231 left it, in 0231's order.
--
-- Nothing here writes a row: removing a column is catalog-only, and putting the CHECK back reads
-- `project_blocker` to validate it.

-- 1. The table's two triggers. Removing the table would take them too; they are named, as 0164 named
--    the ones it removed, so each one can be seen going.
DROP TRIGGER IF EXISTS "project_action_dispatch_result_check" ON "project_action";
DROP TRIGGER IF EXISTS "project_action_dispatch_immutable" ON "project_action";

-- 2. Their functions. Nothing else calls either.
DROP FUNCTION IF EXISTS "project_action_dispatch_result_check"();
DROP FUNCTION IF EXISTS "project_action_dispatch_immutable"();

-- 3. The two columns that pointed at the table. Each takes its foreign key with it, and the session
--    column its partial unique index `session_project_action_id_key` as well.
ALTER TABLE "session" DROP COLUMN IF EXISTS "project_action_id";
ALTER TABLE "task_verification_failure" DROP COLUMN IF EXISTS "raised_by_action_id";

-- 4. The table, with its indexes and its own two foreign keys.
DROP TABLE IF EXISTS "project_action";

-- 5. Its two enums, which nothing else uses.
DROP TYPE IF EXISTS "project_action_type";
DROP TYPE IF EXISTS "project_action_status";

-- 6. The blocker kind nothing can raise any more.
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
    'COMPLETION_ACK_STALE', 'SOURCE_UNRESOLVED',
    'UNKNOWN_FAILURE'
  ));
