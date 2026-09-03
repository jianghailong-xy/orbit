-- 0231 的回滚，按相反顺序。Prisma 不读这个文件（它只读 `migration.sql`），它在这里是为了让回滚是一份
-- 被审过的脚本，而不是凌晨三点临时写的。与 `migration.sql` 一样自带事务、一样可重跑。
--
-- 会丢什么：所有 `project_codebase` 行，以及每一条 session 的 SOURCE 快照（包括已冻结的
-- `source_base_sha`）。回滚之后那些 session 全部读作 Legacy —— 这正是回滚**应该**做的事，因为回滚的
-- 前提是写这些列的代码也一起退了；但如果有任何一条 `PINNED` 的 session 正在跑，它的 worktree 建在一个
-- 数据库不再记得的 SHA 上。先停掉它们再回滚。
--
-- `project_blocker_kind_chk` 退回本迁移之前生效的 26 个值 —— 那是 `0201_completion_ack_canonical_obligation`
-- 留下的集合，其中 `COMPLETION_ACK_STALE` 是 `0220_completion_ack_removal` 明确保留的（线上有一条
-- RESOLVED 的 project_blocker 行带着它，收窄会让 ADD CONSTRAINT 当场失败）。回滚只撤回本迁移加的
-- 那一个值，不顺手收窄任何别人的。
--
-- 任何已经写下的 `SOURCE_UNRESOLVED` blocker 会让 `ADD CONSTRAINT` 失败（那是对的：约束不能对着违反
-- 它的数据装上去），所以它们先被删掉 —— 不是标成已解决：解决意味着有人修好了配置，而这里发生的是
-- "能表达这个问题的词汇被撤回了"。

BEGIN;

DELETE FROM "project_blocker" WHERE "kind" = 'SOURCE_UNRESOLVED';

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
    'VERDICT_APPLY_EXHAUSTED', 'COMPLETION_ACK_STALE',
    'UNKNOWN_FAILURE'
  ));

ALTER TABLE "task" DROP CONSTRAINT IF EXISTS "task_pinned_revision_verification_chk";
ALTER TABLE "task" DROP CONSTRAINT IF EXISTS "task_pinned_revision_shape_chk";
ALTER TABLE "task" DROP COLUMN IF EXISTS "codeless";
ALTER TABLE "task" DROP COLUMN IF EXISTS "pinned_revision";

DROP TRIGGER IF EXISTS "session_source_freeze_guard" ON "session";
DROP FUNCTION IF EXISTS session_source_freeze_guard();

DROP INDEX IF EXISTS "session_source_codebase_idx";

ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_source_refusal_chk";
ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_source_pin_chk";
ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_source_kind_selector_chk";
ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_source_snapshot_chk";
ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_source_ref_chk";
ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_source_sha_chk";
ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_source_refusal_code_chk";
ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_source_ref_authority_chk";
ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_source_kind_chk";
ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_source_state_chk";

ALTER TABLE "session" DROP COLUMN IF EXISTS "source_refusal_detail";
ALTER TABLE "session" DROP COLUMN IF EXISTS "source_refusal_code";
ALTER TABLE "session" DROP COLUMN IF EXISTS "source_resolved_by_runner_id";
ALTER TABLE "session" DROP COLUMN IF EXISTS "source_resolved_at";
ALTER TABLE "session" DROP COLUMN IF EXISTS "source_base_sha";
ALTER TABLE "session" DROP COLUMN IF EXISTS "source_required_contains";
ALTER TABLE "session" DROP COLUMN IF EXISTS "source_ref_authority";
ALTER TABLE "session" DROP COLUMN IF EXISTS "source_config_revision";
ALTER TABLE "session" DROP COLUMN IF EXISTS "source_revision_sha";
ALTER TABLE "session" DROP COLUMN IF EXISTS "source_ref";
ALTER TABLE "session" DROP COLUMN IF EXISTS "source_root_commit_sha";
ALTER TABLE "session" DROP COLUMN IF EXISTS "source_repo_url";
ALTER TABLE "session" DROP COLUMN IF EXISTS "source_codebase_id";
ALTER TABLE "session" DROP COLUMN IF EXISTS "source_kind";
ALTER TABLE "session" DROP COLUMN IF EXISTS "source_state";

DROP TRIGGER IF EXISTS "project_codebase_config_guard" ON "project_codebase";
DROP TABLE IF EXISTS "project_codebase";
DROP FUNCTION IF EXISTS project_codebase_config_guard();

DROP INDEX IF EXISTS "runner_id_owner_id_key";
DROP INDEX IF EXISTS "project_id_owner_id_key";

COMMIT;
