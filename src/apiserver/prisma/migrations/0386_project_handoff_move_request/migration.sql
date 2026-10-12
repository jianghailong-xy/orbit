-- 0386 — a session can ask for an existing task to be MOVED into another project.
--
-- 0155 defined `MOVE_TASK` and the row its answer lives in, and no writer declared one: the edit
-- door admitted a re-filing as an ordinary update and §4 R7 refused every move an agent attempted,
-- declared or not. `TasksService.update` now files the question when a session sends `projectId`
-- with `handoff` (account owner, 2026-10-06). Two facts about a move request are new, and this
-- migration is where the database learns them.
--
-- WHAT IT ADDS
-- ============
--   * `requested_criterion_definition_id` — the target project's criterion the moved task will
--     declare once it is there, when the request names one. The person answering has to see it,
--     and whatever applies the move has to read it back; the payload digest binds it but cannot be
--     read. No foreign key, like `subject_task_id`: deleting the criterion must not rewrite the
--     record of what was asked (a foreign key's SET NULL would be refused by the guard below, and
--     would block the deletion). A CHECK keeps it to MOVE_TASK rows.
--   * One PENDING move per (owner, task, source, target). The owner's decision is that a second
--     request for a move already waiting — from any session, with any reason or criterion — gets
--     the one that waits, not a second question beside it. The service finds it first under both
--     project locks; this partial unique index is what holds for every other writer.
--     `from_project_id` is in it so that a request left behind by a task that has since moved by
--     other means does not stop the task being asked about from where it is now.
--   * The new column frozen in every state, like `title` and `reason`: an answer is about the
--     question as it was asked. A separate trigger rather than a rewrite of 0155's guard, so that
--     function stays byte-identical; it is named to fire after it (BEFORE UPDATE triggers run in
--     name order), so a spent row is still refused as PROJECT_HANDOFF_SPENT first.
--
-- WHAT IT DOES NOT DO
-- ===================
-- No row is written or backfilled: before this migration no MOVE_TASK row could exist, and every
-- existing row reads NULL in the new column, which the CHECK accepts. No other table, and no task,
-- project, acceptance or DONE-fence object, is named.
--
-- 0386: the highest number on main and on every local and origin branch was 0385 when this was
-- written (2026-10-06). Every statement can run twice: IF NOT EXISTS, the constraint inside a
-- `duplicate_object` guard, CREATE OR REPLACE for the function and DROP TRIGGER IF EXISTS before
-- the trigger. `down.sql` beside this file reverses it.

ALTER TABLE "project_handoff_approval"
  ADD COLUMN IF NOT EXISTS "requested_criterion_definition_id" UUID;

DO $$ BEGIN
  ALTER TABLE "project_handoff_approval" ADD CONSTRAINT "project_handoff_approval_requested_criterion_chk"
    CHECK ("requested_criterion_definition_id" IS NULL OR "kind" = 'MOVE_TASK');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "project_handoff_approval_pending_move_idx"
  ON "project_handoff_approval"("owner_id", "subject_task_id", "from_project_id", "to_project_id")
  WHERE "kind" = 'MOVE_TASK' AND "state" = 'PENDING';

CREATE OR REPLACE FUNCTION "project_handoff_approval_criterion_guard"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."requested_criterion_definition_id" IS DISTINCT FROM OLD."requested_criterion_definition_id" THEN
    RAISE EXCEPTION 'PROJECT_HANDOFF_IMMUTABLE: handoff approval % cannot change the criterion the '
                    'move it asks about would declare; the answer is about the question that was asked',
      OLD."id"
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "project_handoff_approval_guard_criterion" ON "project_handoff_approval";
CREATE TRIGGER "project_handoff_approval_guard_criterion"
  BEFORE UPDATE ON "project_handoff_approval"
  FOR EACH ROW EXECUTE FUNCTION "project_handoff_approval_criterion_guard"();
