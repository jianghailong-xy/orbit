-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 0301 — a merge into main the platform makes by itself, under the project's Automatic setting
-- (docs/project-integration-line-contract.md §3.3 M7, M-T11, M-T12; the owner's decision of
-- 2026-09-23: "有自己的项目集成分支 + automatic 就可以合并；如果是 main 或非 automatic，就需要人来点").
--
-- WHAT THE DECISION IS
-- ====================
-- A promotion of a project's OWN branch (`source_kind = 'PROJECT_BRANCH'`) whose project has
-- `coordinator_enabled` on, and whose check came back clean, is confirmed by the platform instead
-- of being put in front of the owner as a card. Everything else — a MAIN-line project, a project
-- with Automatic off, a check that is not clean — still waits for the owner's press, as before.
-- The two halves are why this does not overreach: the project branch is a line every task already
-- passed its checks on, and Automatic is an authorization the owner already gave.
--
-- WHAT IT ADDS
-- ============
--   * `project_promotion.confirmed_automatically`: nobody pressed Merge — the project's Automatic
--     setting confirmed it. `confirmed_by_user_id` stays NULL on such a row, so "who merged this"
--     has two honest answers rather than one borrowed one: a person, or the setting.
--   * `project_integration_job.confirmed_automatically`: the same fact on the LAND_PROMOTION that
--     such a confirmation queued, kept on the job because the job is the record of what was pushed
--     — and because a landing handed back to the owner (below) turns the promotion into a question
--     again, while the job that was sent out automatically stays what it was.
--   * `project_promotion_confirmed_by_chk`, widened: a CONFIRMED, RECHECKING or MERGED row names
--     the person who confirmed it OR says the setting did. Until now the owner's press was the only
--     way past READY, and this CHECK said so.
--   * `project_promotion_automatic_chk`: an automatic confirmation is of a project branch and names
--     no person. A MAIN-line candidate (`TASK_BRANCH`) always asks, and the database refuses to
--     record one as confirmed by the setting.
--   * `project_integration_job_automatic_chk`: only a LAND_PROMOTION is confirmed at all.
--
-- WHAT A CLEAN LANDING MEANS HERE, AND WHY THE JOB CARRIES IT
-- ===========================================================
-- A landing the owner confirmed re-checks the combined tree when main has moved since the check,
-- and lands if it still passes (M5): the owner confirmed "these tasks, these checks". A landing the
-- setting confirmed does not: it is authorized for the tree its check ran on, onto the main tip
-- that check ran against, and nothing else. The runner is told so by this column (`automatic` in
-- the command), finds main where the check left it or hands the candidate back without merging,
-- and the owner is asked (M-T12). A clean landing is never widened to meet the setting halfway.
--
-- BACKWARD COMPATIBLE
-- ===================
-- Two `ADD COLUMN … NOT NULL DEFAULT false`. A constant default is written to the catalog
-- (`attmissingval`) on PG 11+ and no row is rewritten — which matters for `project_promotion`,
-- whose terminal rows `project_promotion_terminal_guard` refuses to UPDATE. Every row written
-- before this reads false, and that is true of it: every one was confirmed by a person, or by
-- nobody yet. The widened CHECK admits every row the old one did; the two new ones hold of every
-- existing row because the column they read is false in all of them. No DML.
--
-- LOCK ORDER
-- ==========
-- Both tables are rank 60 (`src/apiserver/src/common/lock-order.ts`). The constraint swap takes
-- the table's ACCESS EXCLUSIVE lock for the scan that validates it, over tables of hundreds of rows.

ALTER TABLE "project_promotion"
  ADD COLUMN "confirmed_automatically" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "project_integration_job"
  ADD COLUMN "confirmed_automatically" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "project_promotion" DROP CONSTRAINT "project_promotion_confirmed_by_chk";
ALTER TABLE "project_promotion" ADD CONSTRAINT "project_promotion_confirmed_by_chk" CHECK (
  "state" NOT IN ('CONFIRMED', 'RECHECKING', 'MERGED')
  OR "confirmed_by_user_id" IS NOT NULL
  OR "confirmed_automatically");

ALTER TABLE "project_promotion" ADD CONSTRAINT "project_promotion_automatic_chk" CHECK (
  NOT "confirmed_automatically"
  OR ("source_kind" = 'PROJECT_BRANCH' AND "confirmed_by_user_id" IS NULL));

ALTER TABLE "project_integration_job" ADD CONSTRAINT "project_integration_job_automatic_chk" CHECK (
  NOT "confirmed_automatically" OR "kind" = 'LAND_PROMOTION');

COMMENT ON COLUMN "project_promotion"."confirmed_automatically" IS
  'The project''s Automatic setting (project.coordinator_enabled) confirmed this merge into the '
  'upstream; no person pressed it, and confirmed_by_user_id is NULL. Only a PROJECT_BRANCH '
  'promotion whose check came back clean is ever confirmed this way (contract §3.3 M-T11).';

COMMENT ON COLUMN "project_integration_job"."confirmed_automatically" IS
  'A LAND_PROMOTION queued by the project''s Automatic setting rather than by the owner''s press. '
  'It lands only onto the upstream tip its check ran against; if the upstream moved, the runner '
  'lands nothing and the promotion goes back to the owner as a card (contract §3.3 M-T12).';
