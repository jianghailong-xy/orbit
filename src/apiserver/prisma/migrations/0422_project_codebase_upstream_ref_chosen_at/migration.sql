-- When the account owner chose a project's main branch, so a new project on the same repository can
-- start from that choice (`docs/project-integration-line-contract.md` L6).
--
-- `project_codebase.upstream_ref` is "main" for a project: the branch its line comes from and the one
-- a project branch is merged into. Until now a new binding always wrote `refs/heads/main`, and a
-- repository whose main branch is `master`, `develop` or `trunk` had to be corrected by hand on every
-- project. The platform still does not look inside the repository to guess; it remembers what the
-- account owner said:
--
--   1. `upstream_ref_chosen_at`: written `now()` by every write of the owner's that names an upstream
--      (the start door, `PATCH /projects/:id/integration`, `integration` on a project update, the
--      CLI). NULL is "nobody chose this project's upstream": the default, or the owner's earlier
--      choice for the same repository carried over by the binding.
--   2. `project_codebase_upstream_choice_idx`: the read a new binding makes — the newest row of the
--      same owner and repository that has a choice — as one index range. Partial on the choice being
--      there, the only rows that read ever wants.
--
-- 0270's lock (`project_codebase_integration_lock`) does not name the new column, so a choice can be
-- recorded on a project whose line has started without moving either ref; 0231's
-- `project_codebase_config_guard` does not name it either, so recording it is no configuration change
-- and moves no `config_revision`.
--
-- Additive only: one nullable column with no default (catalog-only) and one index. No row is written,
-- no existing column, constraint, function or trigger changes, and nothing on `task`, `session`,
-- `project`, `run_event` or `conversation_turn` is touched.

ALTER TABLE "project_codebase" ADD COLUMN "upstream_ref_chosen_at" TIMESTAMPTZ(3);

CREATE INDEX "project_codebase_upstream_choice_idx"
  ON "project_codebase" ("owner_id", "canonical_repo_url", "upstream_ref_chosen_at" DESC)
  WHERE "upstream_ref_chosen_at" IS NOT NULL;
