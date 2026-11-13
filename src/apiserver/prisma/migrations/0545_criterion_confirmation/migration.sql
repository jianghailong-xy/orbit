-- 0545: a project criterion may be met by confirmation (owner decision 2026-11-11, project
-- 34vfv0OR79IojfYntb8SA criterion 5).
--
--   project_acceptance_criterion_definition.satisfied_by   TASKS (default, every existing row) or
--       CONFIRMATION. A change of mode is a change of what the criterion means, so the normalize
--       trigger bumps `revision` and `semantic_revision` for it as it does for a text edit, and a
--       CONFIRMATION row folds the mode into `content_hash` and `semantic_hash`. A TASKS row's two
--       hashes are computed exactly as 0233 computes them, so no existing row's hash, seal or
--       owner confirmation moves.
--   project_criterion_confirmation   one confirmation of one revision of a criterion, or one Agent
--       check attempt at it. Withdrawal is a stamp, never a delete.
--
-- No preserved row, completion ledger or DONE fence is named. The only function replaced is 0234's
-- `project_acceptance_definition_normalize`, restated with the mode added; the trigger is recreated
-- with `satisfied_by` in its column list so a mode-only UPDATE reaches it.

CREATE TYPE "criterion_satisfied_by" AS ENUM ('TASKS', 'CONFIRMATION');
CREATE TYPE "criterion_confirmer_kind" AS ENUM ('OWNER', 'COORDINATOR', 'AGENT_CHECK');
CREATE TYPE "criterion_confirmation_outcome" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED');

ALTER TABLE "project_acceptance_criterion_definition"
  ADD COLUMN "satisfied_by" "criterion_satisfied_by" NOT NULL DEFAULT 'TASKS';

CREATE TABLE "project_criterion_confirmation" (
  "id" UUID NOT NULL,
  "owner_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "definition_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "confirmer_kind" "criterion_confirmer_kind" NOT NULL,
  "outcome" "criterion_confirmation_outcome" NOT NULL,
  "session_id" UUID,
  "check_task_id" UUID,
  "note" TEXT,
  "attachment_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settled_at" TIMESTAMP(3),
  "withdrawn_at" TIMESTAMP(3),
  "withdrawn_by_kind" "criterion_confirmer_kind",
  CONSTRAINT "project_criterion_confirmation_pkey" PRIMARY KEY ("id"),
  -- Only an Agent check waits for an answer or can fail; the owner and the coordinator confirm.
  CONSTRAINT "project_criterion_confirmation_outcome_chk"
    CHECK ("confirmer_kind" = 'AGENT_CHECK' OR "outcome" = 'CONFIRMED'),
  CONSTRAINT "project_criterion_confirmation_check_task_chk"
    CHECK (("confirmer_kind" = 'AGENT_CHECK') = ("check_task_id" IS NOT NULL)),
  CONSTRAINT "project_criterion_confirmation_withdrawn_chk"
    CHECK (("withdrawn_at" IS NULL) = ("withdrawn_by_kind" IS NULL))
);

CREATE INDEX "project_criterion_confirmation_definition_idx"
  ON "project_criterion_confirmation" ("definition_id", "created_at");
CREATE INDEX "project_criterion_confirmation_check_task_idx"
  ON "project_criterion_confirmation" ("check_task_id");

ALTER TABLE "project_criterion_confirmation"
  ADD CONSTRAINT "project_criterion_confirmation_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_criterion_confirmation"
  ADD CONSTRAINT "project_criterion_confirmation_definition_id_fkey"
  FOREIGN KEY ("definition_id") REFERENCES "project_acceptance_criterion_definition"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 0234's body, with the mode as a third input to the revision and the two hashes.
CREATE OR REPLACE FUNCTION project_acceptance_definition_normalize() RETURNS TRIGGER AS $$
DECLARE
  semantic_changed BOOLEAN;
  method_changed BOOLEAN;
  mode_changed BOOLEAN;
BEGIN
  NEW."text" := btrim(NEW."text");
  NEW."verification_method" := btrim(NEW."verification_method");
  NEW."completion_criterion_override_reason" := CASE
    WHEN NEW."completion_criterion_override_reason" IS NULL THEN NULL
    ELSE btrim(NEW."completion_criterion_override_reason") END;

  IF TG_OP = 'INSERT' THEN
    NEW."revision" := 1;
    NEW."semantic_revision" := 1;
  ELSE
    semantic_changed := NEW."text" IS DISTINCT FROM OLD."text";
    method_changed := NEW."verification_method" IS DISTINCT FROM OLD."verification_method";
    mode_changed := NEW."satisfied_by" IS DISTINCT FROM OLD."satisfied_by";
    NEW."revision" := CASE WHEN semantic_changed OR method_changed OR mode_changed
      THEN OLD."revision" + 1 ELSE OLD."revision" END;
    NEW."semantic_revision" := CASE WHEN semantic_changed OR mode_changed
      THEN OLD."semantic_revision" + 1 ELSE OLD."semantic_revision" END;
    NEW."updated_at" := CURRENT_TIMESTAMP;
  END IF;

  IF NEW."satisfied_by" = 'TASKS' THEN
    NEW."content_hash" := project_acceptance_definition_content_hash(
      NEW."text", NEW."verification_method"
    );
    NEW."semantic_hash" := project_acceptance_definition_semantic_hash(NEW."text");
  ELSE
    NEW."content_hash" := encode(digest(jsonb_build_object(
      'text', NEW."text",
      'verificationMethod', NEW."verification_method",
      'satisfiedBy', NEW."satisfied_by"::text
    )::text, 'sha256'), 'hex')::CHAR(64);
    NEW."semantic_hash" := encode(digest(jsonb_build_object(
      'text', btrim(NEW."text"),
      'satisfiedBy', NEW."satisfied_by"::text
    )::text, 'sha256'), 'hex')::CHAR(64);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER project_acceptance_definition_normalize ON "project_acceptance_criterion_definition";
CREATE TRIGGER project_acceptance_definition_normalize
  BEFORE INSERT OR UPDATE OF
    "text", "verification_method", "satisfied_by",
    "completion_criterion_override_reason", "revision", "content_hash",
    "semantic_revision", "semantic_hash"
  ON "project_acceptance_criterion_definition"
  FOR EACH ROW EXECUTE FUNCTION project_acceptance_definition_normalize();
