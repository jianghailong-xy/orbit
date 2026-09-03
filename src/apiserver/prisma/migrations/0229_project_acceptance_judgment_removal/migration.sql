-- 0229 · Remove the project acceptance JUDGMENT. Keep the acceptance CRITERIA.
--
-- The account owner's decision on 2026-09-03, in the order it was given: "delete the project
-- acceptance judgment too", then "`acceptance_criteria` should be deleted, `acceptance_criteria`
-- is supposed to have been split into the per-item table", and finally — correcting a coordinator
-- session that had drawn the line in the wrong place twice — "why would this project's acceptance
-- criteria be deleted, isn't `project_acceptance_criterion_definition` being kept".
--
-- Same shape as 0219–0228: the machine goes, the declaration stays. After this migration a project
-- is in exactly the state an EXECUTABLE task is in after 0228 — its criteria are stated precisely
-- and nothing whatsoever evaluates them.
--
-- Removed here
--   * `project_acceptance_run` (0127), `project_acceptance_criterion` (0127),
--     `project_acceptance_conclusion` (0179) and `project_acceptance_audit` (0127), with every
--     constraint, index, trigger and function that reads them, and the `project_acceptance_verdict`
--     enum that existed only to type three of their columns.
--   * 0150's `project_acceptance_done_gate` / `_advance_epoch` / `_epoch_audit` and 0172's
--     `project_acceptance_criteria_fact` — the four triggers on the core `project` table. 0150's
--     load-bearing alphabetical firing order (`..._advance_epoch` before `..._done_gate`) goes with
--     them. That constraint disappearing is the intent of this change, not a casualty of it.
--   * Six `project` columns. Three are machine state: `accepted_run_id` (0127),
--     `acceptance_epoch` (0150), `legacy_accepted_at` (0127). Three are the legacy blob and its
--     bookkeeping: `acceptance_criteria`, `acceptance_criteria_digest` and
--     `acceptance_criteria_format` (0172).
--   * `project_acceptance_parse_legacy` and `project_acceptance_sync_legacy_definitions` (0172),
--     which are the blob's parser. They go WITH the blob: the per-item table is the authority and
--     the text was its input form, so once nothing parses the text the text is not a second
--     representation of the criteria, it is dead prose beside them.
--
-- The DONE gate is not replaced. The owner was offered a narrower guard and chose the other
-- option: after this migration `project.status = 'DONE'` is an ordinary column write that any
-- actor may make, with no database gate and (in the same change) no application-layer refusal.
--
-- Deliberately NOT removed — this is the point of the change, not an omission
--   * `project_acceptance_criterion_definition` (0172/0178/0189/0195): the table, all 274 rows
--     across 41 projects as counted on the deployment on 2026-09-03, every column, its
--     `project_acceptance_definition_normalize` trigger and its six `..._definition_*` functions.
--     Note how close its name is to `project_acceptance_criterion`, which this migration DOES
--     drop: that one is a run's per-criterion verdict row and carries a `run_id`; this one is the
--     authored criterion itself and carries a `project_id`.
--   * `project_completion_contract` and its three `zz_` triggers. Its snapshot function reads the
--     criterion DEFINITIONS and six `project` columns, none of which this migration touches.
--   * `project_merge_evidence`. It is an observation about a git ref, not a verdict.
--
-- Rows deleted, counted on the deployment on 2026-09-03: project_acceptance_run 34,
-- project_acceptance_criterion 313, project_acceptance_conclusion 152, project_acceptance_audit
-- 108 — 607 in total, every one of them the judging machine's own output. Eleven projects are
-- DONE; ten of them stand on an `accepted_run_id` this migration deletes. Not one project row's
-- `status` is read or written here: those projects stay DONE, with the evidence for it gone.
--
-- This migration is pure DDL. It contains no INSERT, UPDATE or DELETE against any preserved table,
-- so no BEFORE ROW guard on `project` or anywhere else is on its path.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 1 · Detach the core `project` table first.
--
--     All four triggers name a column or a table this migration removes. They are dropped before
--     anything they read, so nothing is left dangling for even one statement.
-- ---------------------------------------------------------------------------------------------

DROP TRIGGER "project_acceptance_advance_epoch" ON "project";
DROP TRIGGER "project_acceptance_criteria_fact" ON "project";
DROP TRIGGER "project_acceptance_done_gate" ON "project";
DROP TRIGGER "project_acceptance_epoch_audit" ON "project";

-- ---------------------------------------------------------------------------------------------
-- 2 · The six `project` columns.
--
--     `accepted_run_id` goes before `project_acceptance_run` does, which is what breaks the
--     project -> run -> project foreign-key cycle by hand instead of letting DROP TABLE take the
--     constraint out from under it. Dropping each column takes its own dependants with it:
--     `project_accepted_run_id_fkey` and `project_accepted_run_idx` with the first,
--     `project_acceptance_epoch_chk` with the second, `project_acceptance_criteria_format_chk`
--     with the last.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "project" DROP COLUMN "accepted_run_id";
ALTER TABLE "project" DROP COLUMN "acceptance_epoch";
ALTER TABLE "project" DROP COLUMN "legacy_accepted_at";
ALTER TABLE "project" DROP COLUMN "acceptance_criteria";
ALTER TABLE "project" DROP COLUMN "acceptance_criteria_digest";
ALTER TABLE "project" DROP COLUMN "acceptance_criteria_format";

-- ---------------------------------------------------------------------------------------------
-- 3 · The four tables, child-first so no foreign key is dropped by cascade behind our back.
--
--     `project_acceptance_criterion_definition` is NOT in this list and is not touched by any
--     statement in this file. Nothing points at it; it points only at `project`.
-- ---------------------------------------------------------------------------------------------

DROP TABLE "project_acceptance_conclusion";
DROP TABLE "project_acceptance_criterion";
DROP TABLE "project_acceptance_run";
DROP TABLE "project_acceptance_audit";

-- ---------------------------------------------------------------------------------------------
-- 4 · Every function whose body named one of those tables or one of those columns.
--
--     Dropping the tables took their own triggers with them; these are the function bodies left
--     behind, plus the four detached from `project` in section 1 and the blob's parser pair.
--
--     The six `..._definition_*` functions are absent from this list on purpose: they serve the
--     criterion definitions, which stay. `project_acceptance_definition_digest` in particular
--     loses its only caller here and is kept anyway — the criteria's content identity is a fact
--     about the criteria, and it is not this change's business to retire it.
-- ---------------------------------------------------------------------------------------------

DROP FUNCTION "project_acceptance_done_gate"();
DROP FUNCTION "project_acceptance_advance_epoch"();
DROP FUNCTION "project_acceptance_epoch_audit"();
DROP FUNCTION "project_acceptance_criteria_fact"();
DROP FUNCTION "project_acceptance_run_epoch"();
DROP FUNCTION "project_acceptance_run_immutable"();
DROP FUNCTION "project_acceptance_criterion_immutable"();
DROP FUNCTION "project_acceptance_conclusion_immutable"();
DROP FUNCTION "project_acceptance_conclusion_reconcile"();
DROP FUNCTION "project_acceptance_conclusion_validate"();
DROP FUNCTION "project_acceptance_audit_append_only"();
DROP FUNCTION "project_acceptance_is_pass"(uuid, bigint);
DROP FUNCTION "project_acceptance_standing"(uuid, bigint);
DROP FUNCTION "project_acceptance_reopen"(uuid, text, jsonb);
DROP FUNCTION "project_acceptance_sync_legacy_definitions"(uuid, text);
DROP FUNCTION "project_acceptance_parse_legacy"(text);

-- ---------------------------------------------------------------------------------------------
-- 5 · The enum that existed only to type `verdict` on the three tables dropped above.
--
--     `task_completion_criterion` is NOT touched: it types
--     `project_acceptance_criterion_definition.completion_criterion`, and every one of those rows
--     keeps the criterion it declares.
-- ---------------------------------------------------------------------------------------------

DROP TYPE "project_acceptance_verdict";

COMMIT;
