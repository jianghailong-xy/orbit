-- 0610 — a session can ask for a task to be taken OUT of its project, and the account owner's
-- confirmation does it.
--
-- §4 R4 refuses a session acting under a project scope that writes `projectId: null`: work that
-- names no goal is counted by no acceptance, so no agent may leave it there on its own say-so. That
-- stays the rule for the write. What was missing was a way to ASK: a move request (0386) had to
-- name a target project, so a coordinator holding a task that belongs to no goal could only stop
-- and wait for the owner to notice. The account owner decided (2026-11-13) that the coordinator may
-- ask, and that the owner's confirmation takes the task out, exactly as it moves one elsewhere.
--
-- WHAT IT CHANGES
-- ===============
--   * `to_project_id` may be NULL, for a MOVE_TASK only (a CHECK): a filing or a dependency always
--     lands in, or waits on, a project. The foreign key is unchanged; NULL references nothing.
--     0155's `from <> to` CHECK passes a NULL target, which is right — out of a project is a crossing.
--   * 0386's one-PENDING-move index is rebuilt NULLS NOT DISTINCT, so two requests to take the same
--     task out of the same project still meet one row instead of filing two questions.
--   * `task_claimed_project_move_guard` (0389's body) compares the target with IS NOT DISTINCT FROM,
--     so a confirmed move out carries a live run with it like any confirmed move. Nothing else in
--     the body changes.
--
-- WHAT IT DOES NOT CHANGE
-- =======================
-- No row is written or backfilled; every existing row has a target. 0155's append-only guard
-- already compares `to_project_id` with IS DISTINCT FROM and needs nothing.
--
-- 0610: the highest number on main and on every local branch was 0607 when this was written
-- (2026-11-13). Re-runnable: the constraint inside a `duplicate_object` guard, the index dropped and
-- recreated, CREATE OR REPLACE for the function. `down.sql` beside this file reverses it.

ALTER TABLE "project_handoff_approval" ALTER COLUMN "to_project_id" DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE "project_handoff_approval" ADD CONSTRAINT "project_handoff_approval_no_target_chk"
    CHECK ("to_project_id" IS NOT NULL OR "kind" = 'MOVE_TASK');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DROP INDEX IF EXISTS "project_handoff_approval_pending_move_idx";
CREATE UNIQUE INDEX "project_handoff_approval_pending_move_idx"
  ON "project_handoff_approval"("owner_id", "subject_task_id", "from_project_id", "to_project_id")
  NULLS NOT DISTINCT
  WHERE "kind" = 'MOVE_TASK' AND "state" = 'PENDING';

CREATE OR REPLACE FUNCTION "task_claimed_project_move_guard"() RETURNS trigger AS $$
DECLARE
  confirmation text;
BEGIN
  IF NEW."project_id" IS DISTINCT FROM OLD."project_id" AND EXISTS (
    SELECT 1 FROM "session" s WHERE s."task_id" = NEW."id" AND s."deleted_at" IS NULL
      AND s."status" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
  ) THEN
    confirmation := current_setting('orbit.move_task_handoff_id', true);
    IF confirmation IS NULL
       OR confirmation !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR NOT EXISTS (
         SELECT 1 FROM "project_handoff_approval" a
          WHERE a."id" = confirmation::uuid
            AND a."owner_id" = NEW."owner_id"
            AND a."kind" = 'MOVE_TASK'
            AND a."subject_task_id" = NEW."id"
            AND a."from_project_id" = OLD."project_id"
            AND a."to_project_id" IS NOT DISTINCT FROM NEW."project_id"
            AND a."state" = 'APPROVED'
            AND a."applied_task_id" IS NULL
            AND a."decided_by" = 'USER'
            AND a."decided_by_user_id" IS NOT NULL
       ) THEN
      RAISE EXCEPTION 'TASK_CLAIMED_PROJECT_MOVE: task % has a live execution claim', NEW."id";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
