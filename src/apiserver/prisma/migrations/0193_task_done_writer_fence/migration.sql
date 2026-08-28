-- A Task may become DONE only after its declared completion fact exists.  The revision marker is
-- an online-rollout fence: the database defaults and backfills every row to revision 1, while the
-- current service also writes it explicitly.  An old writer can continue serving reads and
-- non-terminal edits, but cannot become a second status writer for any row.
BEGIN;

ALTER TABLE "task"
  ADD COLUMN "completion_fence_revision" integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT "task_completion_fence_revision_supported"
    CHECK ("completion_fence_revision" = 1);

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

  -- A verifier's own verdict is its completion fact.  Migration 0192 derives the carrier status
  -- from this value and independently guards the role shape.
  IF NEW."verifies_task_id" IS NOT NULL AND NEW."verdict" IS NOT NULL THEN
    canonical := true;
  END IF;

  -- The three ordinary criteria close through one evidence-bound DECIDED/PASS request.  The
  -- request transition guards require the executable result, verifier verdict, or human signoff
  -- event before that decision can exist, so this cannot be forged by a bare status UPDATE.
  IF NOT canonical AND EXISTS (
    SELECT 1
      FROM "task_judgment_request" request
     WHERE request."task_id" = NEW."id"
       AND request."owner_id" = NEW."owner_id"
       AND request."kind" = NEW."completion_criterion"
       AND request."status" = 'DECIDED'::"task_judgment_request_status"
       AND request."decision" = 'PASS'::"task_judgment_decision"
  ) THEN
    canonical := true;
  END IF;

  -- Legacy aggregate policies remain canonical projections over other Task rows.  These are a
  -- conservative floor, not a second planner: the application may impose stricter supersession
  -- and epoch rules, while the trigger only ensures a naked writer cannot invent completion.
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
            HINT = 'record the executable result, verification verdict, or human signoff event';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_done_canonical_writer_fence"
  BEFORE UPDATE OF "status", "completion_fence_revision" ON "task"
  FOR EACH ROW EXECUTE FUNCTION "task_done_canonical_writer_fence"();

COMMIT;
