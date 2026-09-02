-- Remove the standard-set confirmation record. It has zero writers and zero readers.
--
-- 0189_project_criteria_automation created `project_acceptance_criteria_confirmation` to hold one
-- append-only row per (project, criteria digest): the record that the complete current acceptance
-- standard set expressed the project's goal. Exactly two things ever touched it, and both are
-- already gone.
--
--   * The READER was 0189's own DONE gate, which refused a project whose current
--     `acceptance_criteria_digest` had no matching row (CRITERIA_CONFIRMATION_REQUIRED).
--     0222_canonical_done_gate_removal is the last migration to CREATE OR REPLACE
--     `project_acceptance_done_gate()`, and its body names no confirmation at all. On the deployed
--     database `SELECT count(*) FROM pg_proc WHERE proname LIKE 'project_acceptance%' AND prosrc
--     LIKE '%criteria_confirmation%'` is 0, and no view, no other function and no inbound foreign
--     key names the table either.
--   * The WRITER was `ProjectAcceptanceService#confirmCriteria`, reached through
--     `orbit project criteria-confirm` and the `project_criteria_confirm` MCP tool. `da6b8f5a`
--     deleted the service method, the CLI command, its help block and the tool together with the
--     owner-approval queue.
--
-- What is left after that commit is a table nothing can write and nothing reads, plus the BEFORE
-- UPDATE trigger that kept its rows immutable. Both go here, by the account owner's 2026-09-02
-- decision to remove what is left rather than invent a new writer for it.
--
-- What this destroys, stated here rather than discovered later: four rows on the deployed
-- database, confirmed 2026-08-27/28 by the account owner across three projects. Each is the
-- historical fact that a specific 64-hex criteria digest was once affirmed. Nothing derives from
-- them any more -- the gate that used to read them stopped in 0222 -- so they are audit history
-- with no live consumer, and they are not backfilled anywhere. Unlike
-- 0225_session_current_work_startup_fragment_removal this migration deliberately carries NO
-- fail-closed row-count guard: the rows are known to exist and destroying them is the decision.
--
-- What is deliberately NOT touched: `project_acceptance_criterion_definition`,
-- `project_acceptance_criterion`, `project_acceptance_conclusion`, `project_acceptance_run` and
-- `project_acceptance_audit` -- the account-level acceptance standard set itself, shared across
-- every project. Nor 0150's `project_acceptance_done_gate` / `..._advance_epoch` / `..._epoch_audit`
-- and 0172's `..._criteria_fact` on `project`, whose alphabetical firing order is load-bearing.
-- This migration names none of them in any statement, and it re-creates nothing.
--
-- Every statement below is DDL. Not one of them reads or writes a row of the table it drops, which
-- is what keeps `project_acceptance_confirmation_immutable` -- a BEFORE UPDATE ROW trigger that
-- raises unconditionally -- out of the way: on a database that actually holds the four rows, a
-- single `UPDATE project_acceptance_criteria_confirmation SET ...` in this file would abort the
-- whole migration. Deliberately not wrapped in an explicit BEGIN/COMMIT: Prisma already runs the
-- file in one transaction.

-- The guard and its function, named rather than left to the DROP TABLE cascade. The cascade takes
-- the trigger; it does NOT take the function, which would be left behind as an orphan that can
-- never fire again.
DROP TRIGGER "project_acceptance_confirmation_immutable"
  ON "project_acceptance_criteria_confirmation";
DROP FUNCTION project_acceptance_confirmation_immutable();

-- 0189's two indexes, named for the same reason 0225 named its own: DROP TABLE would cascade to
-- them, and a reader of this file should see them go without replaying the catalogue.
DROP INDEX "project_acceptance_confirmation_project_idx";
DROP INDEX "project_acceptance_confirmation_digest_key";

-- The table, with its primary key, its `project` foreign key and both 0189 CHECKs.
DROP TABLE "project_acceptance_criteria_confirmation";
