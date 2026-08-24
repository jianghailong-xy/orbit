-- The last of the control loop in the database: three CHECK constraints that hold a
-- `dispatch_origin = 'PROJECT_COORDINATOR'` session to the shape the loop gave it.
--
-- 0164 removed the loop's triggers and its outbox but missed these, because a CHECK is not a
-- trigger and did not show up in the same sweep. They are the same kind of leftover: they describe
-- an invariant of dispatch that nothing performs any more. No new PROJECT_COORDINATOR session can
-- be created — opening a coordinator conversation goes through `sessions.create({source:'user'})`
-- — so what is left is 202 historical rows and three rules that only stop those rows being tidied.
--
--   session_coordinator_snapshot_chk        a coordinator session must carry an action, a
--                                           resolution and a frozen-at stamp
--   session_action_only_for_coordinator_chk only a coordinator session may name an action
--   session_coordinator_source_chk          dispatch_origin and run_source must agree
--
-- Dropping them lets those rows outlive the project that dispatched them: deleting a project
-- cascades its `project_action` rows, and a session pointing at one has to be able to let go.

ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_coordinator_snapshot_chk";
ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_action_only_for_coordinator_chk";
ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_coordinator_source_chk";
