-- 0469 — the owner's Reopen project is recorded, so that the projection can leave it standing.
--
-- WHAT IT ADDS
-- ============
-- Two columns on `project`, written together by the one press they record: the account owner
-- signed in, `PATCH /projects/:id` with `{ "status": "OPEN" }`, taking the row out of DONE or
-- CANCELLED.
--   `reopened_at`     when it was pressed.
--   `reopened_facts`  what it was pressed over: the seal of the criteria, and each task serving one by
--                     a digest of its facts (`project-done-derived.ts`). While those have not moved, the
--                     projection does not store DONE over the press.
--
-- WHY THE FACTS, AND NOT ONLY THE TIME
-- ====================================
-- The owner's rule is that a fact has to have changed since the press, and a task's status is one of
-- those facts. No row records when a task's status moved: `task.updated_at` moves on a rename too,
-- and `task_progress.epoch_started_at` only on the way back to OPEN. Comparing what the facts ARE
-- needs neither. One digest per task rather than one for the project, because a task joining or
-- leaving a criterion is not a fact of its own, and one digest could not tell that from the others.
--
-- BACKWARD COMPATIBLE
-- ===================
-- Both columns are nullable and start NULL, which reads as "no press on record": every existing
-- project is projected exactly as it was, and no status, task, criterion or confirmation row moves.
-- A press made before this migration cannot be told from a status write now, so none is backfilled.
-- A deployment that applies this and rolls the code back keeps working: the old code names neither
-- column. Which is why the CHECKs below do not tie them to `status`: the old projection storing DONE
-- over a recorded press must not become a refused write.

BEGIN;

ALTER TABLE "project"
  ADD COLUMN "reopened_at" TIMESTAMPTZ(3),
  ADD COLUMN "reopened_facts" jsonb;

ALTER TABLE "project"
  ADD CONSTRAINT "project_reopened_record_chk"
    CHECK (("reopened_at" IS NULL) = ("reopened_facts" IS NULL)),
  ADD CONSTRAINT "project_reopened_facts_chk"
    CHECK ("reopened_facts" IS NULL OR jsonb_typeof("reopened_facts") = 'object');

COMMIT;
