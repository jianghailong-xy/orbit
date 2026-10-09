-- 0389 — the account owner's confirmation of a MOVE_TASK request moves the task, live run and all.
--
-- `task_claimed_project_move_guard` (0122, widened to every live status by 0130) refuses any change
-- of `task.project_id` while a session holds the task's execution claim. That stays the rule for
-- every writer but one. The account owner decided (2026-10-06, project 34b8pthjtmO06pvd8i3FW) that
-- confirming a move an agent asked for completes it, and that a run in progress goes WITH the task
-- into the project it moves to, which then judges its work. The confirmation is
-- `ProjectHandoffService.decide` → `TasksService.applyMoveApproval`, and it is the only writer that
-- may move a claimed task.
--
-- WHAT IT CHANGES
-- ===============
-- One function body. The trigger, its event and its error are unchanged. The exception holds only
-- when all of these are true:
--
--   * the transaction has set `orbit.move_task_handoff_id` (transaction-local, `set_config(.., true)`)
--     to the id of a `project_handoff_approval` row;
--   * that row is a MOVE_TASK about THIS task, out of the project the row leaves (OLD) and into the
--     one it enters (NEW), under the same owner;
--   * it was answered yes by a person (`decided_by = 'USER'` with a user named) and is not yet spent.
--
-- The confirmation writes the task after that answer and spends it in the same transaction, so the
-- yes authorises one move and the guard cannot be reached through it again: once APPLIED, 0155 keeps
-- the row from becoming unspent. The setting names a row; it grants nothing by itself. A
-- transaction that sets it without such a row, or sets it to something that is not a uuid, meets the
-- same refusal as before.
--
-- WHAT IT DOES NOT CHANGE
-- =======================
-- The owner's own move (PATCH /tasks/:id, §4 R1) is still refused while a run is live, by
-- `TasksService.update` and by this trigger. No row is written or backfilled, no other trigger and
-- no table is touched. `down.sql` beside this file restores 0130's body.
--
-- 0389: 0386 is on main (0386_project_handoff_move_request) and on one other branch under another
-- name; 0387 and 0388 are taken on unmerged branches (2026-10-06). Re-runnable: CREATE OR REPLACE.

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
            AND a."to_project_id" = NEW."project_id"
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
