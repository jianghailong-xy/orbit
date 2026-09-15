-- A code project's integration line (`docs/project-integration-line-contract.md` §1.1).
--
-- `project_codebase` (0231) already says where a project's code comes from (`upstream_ref`) and
-- where its finished tasks go (`integration_ref`). What it could not say is who decided the second
-- one, whether the platform has started landing work there, and what to check on the combined tree
-- before it does. Four columns and one trigger:
--
--   1. `integration_ref_source`: `EXPLICIT` when the account owner chose the line, `DEFAULT_RULE`
--      when the platform decided it at the project's first integration (code tasks that depend on
--      one another go through a project branch, anything else straight to main). A constant
--      default, so no existing row is rewritten — and production has none.
--   2. `integration_started_at`: written in the transaction that queues the project's first
--      integration. Non-null is the lock: from then on the line is where work has landed, and
--      switching it would strand that work.
--   3. `merge_check_command` / `merge_check_timeout_seconds`: the project-level check run on the
--      combined tree before a landing. NULL is "none", and "the one-hour default" respectively.
--   4. `project_codebase_integration_lock`: once `integration_started_at` is set, refuses a write
--      that moves the line — either ref, the repository's identity or its authority — or clears
--      the start. The service refuses the same request first, with 409 `INTEGRATION_LINE_LOCKED`;
--      this is the same rule for a writer that never asked the service. The merge check stays
--      writable.
--
-- Additive only: no row is written, no existing column, constraint or trigger changes, and nothing
-- on `task`, `session`, `run_event` or `conversation_turn` is touched. No `work_dir`,
-- `workspace_id`, `default_merge_target` or `enable_worktree` column (PSC SR10).

ALTER TABLE "project_codebase"
  ADD COLUMN "integration_ref_source" TEXT NOT NULL DEFAULT 'DEFAULT_RULE',
  ADD COLUMN "integration_started_at" TIMESTAMPTZ(3),
  ADD COLUMN "merge_check_command" TEXT,
  ADD COLUMN "merge_check_timeout_seconds" INTEGER;

ALTER TABLE "project_codebase"
  ADD CONSTRAINT "project_codebase_integration_ref_source_chk"
    CHECK ("integration_ref_source" IN ('EXPLICIT', 'DEFAULT_RULE')),
  ADD CONSTRAINT "project_codebase_merge_check_timeout_chk"
    CHECK ("merge_check_timeout_seconds" IS NULL OR "merge_check_timeout_seconds" > 0);

CREATE OR REPLACE FUNCTION "project_codebase_integration_lock"() RETURNS trigger AS $$
BEGIN
  IF OLD."integration_started_at" IS NULL THEN RETURN NEW; END IF;
  IF NEW."integration_started_at" IS NULL
     OR NEW."integration_ref" IS DISTINCT FROM OLD."integration_ref"
     OR NEW."upstream_ref" IS DISTINCT FROM OLD."upstream_ref"
     OR NEW."canonical_repo_url" IS DISTINCT FROM OLD."canonical_repo_url"
     OR NEW."ref_authority" IS DISTINCT FROM OLD."ref_authority"
     OR NEW."remote_name" IS DISTINCT FROM OLD."remote_name"
     OR NEW."authority_runner_id" IS DISTINCT FROM OLD."authority_runner_id" THEN
    RAISE EXCEPTION 'INTEGRATION_LINE_LOCKED: project % started integrating into % at %; its integration line can no longer change',
      OLD."project_id", OLD."integration_ref", OLD."integration_started_at";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "project_codebase_integration_lock"
  BEFORE UPDATE ON "project_codebase"
  FOR EACH ROW EXECUTE FUNCTION "project_codebase_integration_lock"();
