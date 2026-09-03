-- The EXECUTABLE decision comes back as one exit-code comparison, and the DONE writer fence has
-- to stop refusing its result.
--
-- Why a migration exists at all, when the account owner's instruction was "根据 exit code 来简单
-- 判断，不需要实际记录数据" and this change is otherwise entirely in the application: 0193 installed
-- `task_done_canonical_writer_fence` as a BEFORE UPDATE trigger on `task`, and 0228 took away the
-- last lane an EXECUTABLE task had through it. With that lane gone the trigger raises
-- TASK_DONE_CANONICAL_FACT_REQUIRED on every DONE an EXECUTABLE task could reach, including the
-- one the restored comparison derives. So the comparison alone would be dead code: correct, and
-- rolled back by the database a statement later.
--
-- What this migration is NOT:
--   * It creates no table, no column, no index, no enum and no row. `git diff --stat` against
--     0229 shows one file, containing one CREATE OR REPLACE FUNCTION.
--   * It records nothing. There is no place in this text where an exit code, a command, an output
--     or a decision is stored, because the whole point of the owner's instruction is that the
--     comparison happens in memory and is then dropped.
--   * It does not restore the judgment request/result ledger 0228 dropped, the admission,
--     attempt, continuation and diagnosis family 0227 dropped, or any lane that reads one. Those
--     tables stay dropped and nothing here references them -- deliberately not even by name, so
--     this file cannot be read as returning to their vocabulary.
--
-- What the new lane can and cannot claim.
--
-- Every other lane in this fence names a row the database can go and look at: a verifier's own
-- verdict, a set of child tasks, a PASS verdict on a verifier. The EXECUTABLE lane cannot, because
-- the owner's decision is precisely that the comparison leaves nothing behind to look at. So the
-- lane checks what does exist -- an intact 0177 declaration on a task that declares EXECUTABLE --
-- and the real guarantee moves up one level, to `runnerApi.turnComplete`, where the comparison is
-- made under the rank-50 row lock on this same task and written as a compare-and-set that repeats
-- the command and the expectation in its WHERE clause.
--
-- This is a deliberate weakening and is worth stating plainly: for an EXECUTABLE task the fence is
-- no longer independent evidence, it is a declaration check. The wall that keeps an agent, a
-- coordinator or a person from simply writing DONE is `TasksService.update`, which refuses
-- `status: DONE` for every actor and every criterion before any statement reaches this trigger --
-- unconditionally, not as a function of this lane.
--
-- Carried over from 0228's definition byte for byte: the fence-revision downgrade refusal, the
-- early return, the verifier-carrier lane, ALL_CHILDREN_DONE and VERIFICATION_PASSED. This is a
-- CREATE OR REPLACE, so restating them is not cosmetic -- omitting one would silently revert it.
--
-- The HINT changes with the lane: it told readers that EXECUTABLE has no implementation, and as of
-- this migration it has one again.

BEGIN;

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

  -- The lane this migration adds. The declaration is the only durable fact an EXECUTABLE task
  -- has, by the owner's decision; the comparison against it is made and discarded in
  -- `runnerApi.turnComplete`. Both halves of 0177's pair are required, which the
  -- `task_executable_acceptance_pair` CHECK already guarantees for a well-formed row -- naming
  -- them here means a task whose declaration was cleared cannot ride this lane on its stale
  -- criterion label alone.
  IF NOT canonical
     AND NEW."completion_criterion" = 'EXECUTABLE'::"task_completion_criterion"
     AND NEW."acceptance_command" IS NOT NULL
     AND NEW."acceptance_expected_exit_code" IS NOT NULL THEN
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
            HINT = 'let the declared acceptance command run, or record a verification verdict; EVIDENCE_JUDGMENT is declared but has no implementation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
