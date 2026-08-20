-- Native consequences of a verification verdict (contract AC6 / §13.2).
--
-- Migration 0123 gave a verification task somewhere to record what it concluded. This one makes
-- that conclusion do something: a FAIL reverts the subject, files a defect subtask under it and
-- stops the work downstream, and none of that is a prompt asking an agent to be diligent.
--
-- Two objects carry it. `task.verdict_revision` is the identity of one conclusion (V7): without it
-- the action key is built from a value with three possible states, and the SECOND FAIL on the same
-- verifier — the one after somebody fixed the defect and ran the check again — collides with the
-- first key, is skipped as already applied, and leaves the subject sitting at DONE. The
-- `task_verification_failure` row is the condition that FAIL and INCONCLUSIVE leave behind: what
-- failed, at which revision, with which defect, and whether it is still unresolved.

-- V7. Monotonic, never reused, never reset by any path. The trigger is what makes "never reset" a
-- property of the database rather than a rule each writer is trusted to remember, and it is the
-- half that matters: a reset silently RESTORES an old action key, which reads as "already done".
ALTER TABLE "task" ADD COLUMN "verdict_revision" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "task" ADD CONSTRAINT "task_verdict_revision_nonnegative_chk"
  CHECK ("verdict_revision" >= 0);

CREATE OR REPLACE FUNCTION "task_verdict_revision_monotonic"() RETURNS trigger AS $$
BEGIN
  IF NEW."verdict_revision" < OLD."verdict_revision" THEN
    RAISE EXCEPTION 'VERDICT_REVISION_NOT_MONOTONIC: task % cannot move verdict_revision % -> %',
      OLD."id", OLD."verdict_revision", NEW."verdict_revision";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_verdict_revision_monotonic"
  BEFORE UPDATE OF "verdict_revision" ON "task"
  FOR EACH ROW EXECUTE FUNCTION "task_verdict_revision_monotonic"();

-- And the other half: the counter advances by itself, in the transaction that reached the verdict.
--
-- A trigger rather than a line in the service that happens to own the PATCH, because "reaching a
-- verdict" has more than one writer — the task API, the MCP tool and the CLI all land here, and a
-- raw statement lands here too. A rule each of them is trusted to remember is a rule the next
-- write path forgets, and forgetting it is not visible: it silently RE-USES the previous action
-- key, and the second failure of the same check is skipped as already applied.
--
-- Only a transition TO a conclusion counts. Writing FAIL onto a row that already says FAIL
-- concluded nothing and must not file a second defect; revoking (to NULL) does not advance it
-- either, so the counter is never given back — the NEXT conclusion is what advances it, which is
-- exactly how a re-run produces a new key while a duplicate delivery does not.
CREATE OR REPLACE FUNCTION "task_verdict_revision_advance"() RETURNS trigger AS $$
BEGIN
  IF NEW."verdict" IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."verdict_revision" = 0 THEN NEW."verdict_revision" := 1; END IF;
    RETURN NEW;
  END IF;
  -- A caller that advanced the counter itself (the same statement writing both) is left alone, so
  -- this can never double-count.
  IF NEW."verdict" IS DISTINCT FROM OLD."verdict"
     AND NEW."verdict_revision" = OLD."verdict_revision" THEN
    NEW."verdict_revision" := OLD."verdict_revision" + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_verdict_revision_advance"
  BEFORE INSERT OR UPDATE OF "verdict" ON "task"
  FOR EACH ROW EXECUTE FUNCTION "task_verdict_revision_advance"();

-- A check that is no longer finished holds no conclusion.
--
-- This is what makes V4 possible at all. Running the check again means putting the verification
-- task back to OPEN; if its old conclusion stayed on the row, the re-run ending in the SAME
-- verdict would write a value the row already held, advance nothing, and produce no new action
-- key — so `FAIL -> fix -> FAIL again` would silently do nothing the second time. Clearing it
-- here means the next conclusion is a transition, and a transition is what advances the revision.
--
-- A conclusion written in the SAME statement as the status change is left alone: that caller said
-- what it concluded, and this must not overwrite it. Fires after the advance trigger above by
-- name order, so a status change carrying a new verdict has already been counted.
CREATE OR REPLACE FUNCTION "task_verdict_revoked_on_reopen"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'DONE' AND NEW."status" <> 'DONE'
     AND NEW."verdict" IS NOT NULL
     AND NEW."verdict" IS NOT DISTINCT FROM OLD."verdict" THEN
    NEW."verdict" := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_verdict_revoked_on_reopen"
  BEFORE UPDATE OF "status" ON "task"
  FOR EACH ROW EXECUTE FUNCTION "task_verdict_revoked_on_reopen"();

-- The condition a non-PASS verdict leaves behind.
--
-- It is a row rather than a status written onto the blocked tasks, because "why can this task not
-- run" has to stay answerable (V3). Rewriting the downstream tasks' status would move the answer
-- out of the data and into whoever remembers the incident.
--
-- `verdict` is deliberately constrained to the two conclusions that leave something behind: a PASS
-- has no condition to record, it RESOLVES the ones already here.
CREATE TABLE "task_verification_failure" (
  "id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "verifier_task_id" UUID NOT NULL,
  "subject_task_id" UUID NOT NULL,
  "verdict" "task_verdict" NOT NULL,
  "verdict_revision" BIGINT NOT NULL,
  -- FAIL stops the tasks that depend on the subject; INCONCLUSIVE records the condition and stops
  -- nothing (§13.2's table gives downstream blocking to FAIL alone).
  "blocks_downstream" BOOLEAN NOT NULL,
  "defect_task_id" UUID,
  "raised_by_action_id" UUID,
  -- Base62 throughout, like project_decision.decision_input: this is read back out over the audit
  -- API, and an id spelled as a UUID here is one no caller can hand to any other endpoint.
  "evidence" JSONB NOT NULL DEFAULT '{}',
  -- Historical attribution, deliberately without a foreign key (as project_decision does it):
  -- deleting the verification that passed must not rewrite what resolved this condition.
  "resolved_at" TIMESTAMP(3),
  "resolved_by_task_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "task_verification_failure_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_verification_failure_verdict_chk" CHECK ("verdict" <> 'PASS'),
  CONSTRAINT "task_verification_failure_revision_chk" CHECK ("verdict_revision" > 0),
  CONSTRAINT "task_verification_failure_resolution_chk"
    CHECK (("resolved_at" IS NULL) = ("resolved_by_task_id" IS NULL)),
  -- Only a revert files a defect, so only a revert may name one.
  CONSTRAINT "task_verification_failure_defect_chk"
    CHECK ("defect_task_id" IS NULL OR "verdict" = 'FAIL'),
  CONSTRAINT "task_verification_failure_blocks_chk"
    CHECK ("blocks_downstream" = ("verdict" = 'FAIL'))
);

-- The dedup key of the whole mechanism, and the same one the action ledger uses: one conclusion,
-- identified by (verifier, revision), leaves exactly one condition however many times it is
-- delivered. A genuinely new conclusion has a new revision and therefore a new row.
CREATE UNIQUE INDEX "task_verification_failure_verifier_task_id_verdict_revision_key"
  ON "task_verification_failure"("verifier_task_id", "verdict_revision");
-- The dispatch guard's read: "is there an unresolved failure on this subject". Partial, because
-- resolved rows are history and the guard never looks at them.
CREATE INDEX "task_verification_failure_open_subject_idx"
  ON "task_verification_failure"("subject_task_id") WHERE "resolved_at" IS NULL;
CREATE INDEX "task_verification_failure_project_id_created_at_idx"
  ON "task_verification_failure"("project_id", "created_at");

ALTER TABLE "task_verification_failure"
  ADD CONSTRAINT "task_verification_failure_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Both cascade. Deleting the subject already deletes its verifications (task.verifies_task_id is
-- ON DELETE CASCADE), so a condition about a subject nobody kept is not a row anybody can read.
ALTER TABLE "task_verification_failure"
  ADD CONSTRAINT "task_verification_failure_verifier_task_id_fkey"
  FOREIGN KEY ("verifier_task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_verification_failure"
  ADD CONSTRAINT "task_verification_failure_subject_task_id_fkey"
  FOREIGN KEY ("subject_task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- The defect outlives nothing: deleting it leaves the condition, unresolved and now without the
-- work item that was going to resolve it, which is exactly what a reader needs to see.
ALTER TABLE "task_verification_failure"
  ADD CONSTRAINT "task_verification_failure_defect_task_id_fkey"
  FOREIGN KEY ("defect_task_id") REFERENCES "task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "task_verification_failure"
  ADD CONSTRAINT "task_verification_failure_raised_by_action_id_fkey"
  FOREIGN KEY ("raised_by_action_id") REFERENCES "project_action"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMENT ON COLUMN "task"."verdict_revision" IS
  'Monotonic identity of one verification conclusion (§13.2 V7). Advances when a verdict is reached, never resets, and is what keeps a second FAIL from colliding with the first.';
