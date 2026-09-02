-- 0227 · Remove the judgment machinery and the EXECUTABLE completion implementation.
--
-- The account owner's decision on 2026-09-02, in the order it was given: "delete everything to do
-- with judgement, it will be redone later", "delete the EXECUTABLE decision too", and finally the
-- sentence that fixed the shape — "can we delete only the executable and judgement DEPENDENCIES,
-- and not the executable DATA".
--
-- So: the machine goes, the declaration stays.
--
-- Removed here
--   * `task_judgment_request` (0181), `task_executable_judgment_result` (0181),
--     `task_judgment_inbox_item` (0182), `task_judgment_push_delivery` (0182) and
--     `task_judgment_backfill_batch` (0184), with their views, enums and every function and
--     trigger that reads them — including the two 0192 guards installed on the core `task` table
--     and the 0192 carrier-state assertion, whose whole body is a join against
--     `task_judgment_request` and which is therefore vacuous the moment that table is gone.
--   * The judgment lane of 0193's `task_done_canonical_writer_fence` — which, after 0227 removed
--     0200's typed-attempt lane the same day, is the last lane an EXECUTABLE task had. Every
--     other lane is carried over byte for byte from 0227's definition.
--
-- Deliberately NOT removed — this is the point of the change, not an omission
--   * `task.acceptance_command` and `task.acceptance_expected_exit_code` (0177), the
--     `task_executable_acceptance_pair` CHECK, and every row of that data.
--   * All three `task_completion_criterion` labels. EXECUTABLE and EVIDENCE_JUDGMENT become
--     DECLARED BUT UNIMPLEMENTED: a task may still declare either one and carry its command and
--     expected exit code, and nothing will automatically satisfy it until the owner rebuilds the
--     implementation. No task row's criterion is rewritten, and no task row is deleted.
--   * The `project_acceptance_*` tables, their data, and 0150/0172's four triggers, names and
--     alphabetical firing order.
--   * 0141's `task_verification_verdict_atomic_insert` / `_update` and 0192's
--     `task_verification_carrier_status_derive`. After this migration VERIFICATION is the ONE
--     criterion that still has an implementation.
--
-- Rows deleted, counted on the deployment on 2026-09-02: task_judgment_request 38,
-- task_executable_judgment_result 12, task_judgment_inbox_item 17, task_judgment_push_delivery 17,
-- task_judgment_backfill_batch 2 — 86 in total. All of it is the machine's own running state, not
-- task data. Nothing is archived: a copy of a request ledger with no evaluator is not evidence.
--
-- This migration reads no `task` row and updates no existing row in any preserved table.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 1 · Detach the core `task` table first.
--
--     `task_judgment_verifier_delete_guard` and `task_judgment_verifier_terminal_guard` (0192) sit
--     on `task` itself and both query `task_judgment_request WHERE kind = 'VERIFICATION'`; they
--     would dangle the instant the table went. `task_open_verification_request_carrier_guard`
--     (0192) is the third: it delegates to `assert_verification_request_carrier_state`, whose four
--     EXISTS clauses all start `FROM "task_judgment_request"`.
--
--     None of the three is what completes a VERIFICATION task. That is
--     `task_verification_carrier_status_derive` (verdict -> carrier DONE) and 0141's atomic
--     verdict functions, none of which reference a judgment relation. They are untouched.
-- ---------------------------------------------------------------------------------------------

DROP TRIGGER "task_judgment_verifier_delete_guard" ON "task";
DROP TRIGGER "task_judgment_verifier_terminal_guard" ON "task";
DROP TRIGGER "task_open_verification_request_carrier_guard" ON "task";

-- ---------------------------------------------------------------------------------------------
-- 2 · The DONE writer fence loses its judgment lane, and with it the last lane an EXECUTABLE
--     task had.
--
--     0227 removed 0200's typed-attempt lane an hour before this migration was written, and its
--     comment says the DECIDED PASS `task_judgment_request` lane is "the lane an EXECUTABLE task
--     now takes". That lane is what the account owner asked for next, so it goes here. Carried
--     over from 0227's text unchanged: the fence-revision downgrade refusal, the early return, the
--     verifier-carrier lane, ALL_CHILDREN_DONE and VERIFICATION_PASSED. Three lanes remain, and
--     all three are VERIFICATION or an aggregate of it.
--
--     The HINT changes with them: it named an executable result this change deletes and a "human
--     signoff event" 0224 already did.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "task_done_canonical_writer_fence"() RETURNS trigger AS $$
DECLARE
  canonical boolean := false;
BEGIN
  IF NEW."completion_fence_revision" < OLD."completion_fence_revision" THEN
    RAISE EXCEPTION 'TASK_COMPLETION_FENCE_REVISION_DOWNGRADE'
      USING ERRCODE = 'P0001',
            DETAIL = 'a fenced task cannot be returned to a legacy writer cohort';
  END IF;
  IF NEW."completion_fence_revision" < 1
     OR NEW."status" <> 'DONE'::"task_status"
     OR OLD."status" = 'DONE'::"task_status" THEN
    RETURN NEW;
  END IF;

  IF NEW."verifies_task_id" IS NOT NULL AND NEW."verdict" IS NOT NULL THEN
    canonical := true;
  END IF;

  IF NOT canonical AND NEW."completion_policy" = 'ALL_CHILDREN_DONE'::"task_completion_policy"
     AND EXISTS (
       SELECT 1 FROM "task" child
        WHERE child."parent_task_id" = NEW."id" AND child."status" = 'DONE'::"task_status"
     )
     AND NOT EXISTS (
       SELECT 1 FROM "task" child
        WHERE child."parent_task_id" = NEW."id"
          AND child."status" NOT IN ('DONE'::"task_status", 'CANCELLED'::"task_status")
     ) THEN
    canonical := true;
  END IF;

  IF NOT canonical AND NEW."completion_policy" = 'VERIFICATION_PASSED'::"task_completion_policy"
     AND EXISTS (
       SELECT 1 FROM "task" verifier
        WHERE verifier."verifies_task_id" = NEW."id"
          AND verifier."verdict" = 'PASS'::"task_verdict"
          AND verifier."terminal_reason" IS NULL
          AND verifier."superseded_by_task_id" IS NULL
     ) THEN
    canonical := true;
  END IF;

  IF NOT canonical THEN
    RAISE EXCEPTION 'TASK_DONE_CANONICAL_FACT_REQUIRED'
      USING ERRCODE = 'P0001',
            DETAIL = 'status=DONE is a projection of the declared completion fact, not a writer input',
            HINT = 'record a verification verdict; EXECUTABLE and EVIDENCE_JUDGMENT are declared but have no implementation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- 3 · The read-only projections of an OPEN request go before the table they project.
-- ---------------------------------------------------------------------------------------------

DROP VIEW "project_judgment_blocker";
DROP VIEW "task_judgment_signal";

-- ---------------------------------------------------------------------------------------------
-- 4 · The five tables, child-first so no foreign key is dropped by cascade behind our back.
-- ---------------------------------------------------------------------------------------------

DROP TABLE "task_judgment_push_delivery";
DROP TABLE "task_judgment_inbox_item";
DROP TABLE "task_executable_judgment_result";
DROP TABLE "task_judgment_request";
DROP TABLE "task_judgment_backfill_batch";

-- ---------------------------------------------------------------------------------------------
-- 5 · Every function whose body named one of those tables.
--
--     Dropping the tables took their own triggers with them; these are the function bodies left
--     behind, plus the two 0192 helpers on the `task` side detached in section 1.
-- ---------------------------------------------------------------------------------------------

DROP FUNCTION "task_judgment_request_transition_guard"();
DROP FUNCTION "task_judgment_request_verifier_role_guard"();
DROP FUNCTION "task_judgment_request_migration_metadata_guard"();
DROP FUNCTION "task_judgment_delivery_file"();
DROP FUNCTION "task_judgment_delivery_stop"();
DROP FUNCTION "task_executable_judgment_result_request_guard"();
DROP FUNCTION "task_judgment_verifier_delete_guard"();
DROP FUNCTION "task_judgment_verifier_terminal_guard"();
DROP FUNCTION "task_open_verification_request_guard"();
DROP FUNCTION "task_open_verification_request_carrier_guard"();
DROP FUNCTION "assert_verification_request_carrier_state"(text);

-- ---------------------------------------------------------------------------------------------
-- 6 · The enums that existed only to type columns of those tables.
--
--     `task_completion_criterion` is NOT among them and is not touched: it types
--     `task.completion_criterion`, whose EXECUTABLE / VERIFICATION / EVIDENCE_JUDGMENT labels and
--     every row carrying them survive this migration intact.
--
--     `task_judgment_device_policy` is not dropped either. 0184 also gave it to
--     `task_legacy_evidence_import."device_policy"`, and that table is a preserved import ledger,
--     not judgment machinery. Dropping the type would mean rewriting a column of a table this
--     change has no mandate over; the name outliving its namesake is the cheaper honesty.
-- ---------------------------------------------------------------------------------------------

DROP TYPE "task_judgment_request_status";
DROP TYPE "task_judgment_recipient_type";
DROP TYPE "task_judgment_decision";
DROP TYPE "task_judgment_supersession_rule";
DROP TYPE "task_judgment_request_origin";
DROP TYPE "task_judgment_push_delivery_status";

COMMIT;
