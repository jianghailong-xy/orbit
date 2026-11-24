-- 1573: an owner request kind PROJECT_REOPEN — a session whose write was refused because its project is DONE or
-- CANCELLED asks the account owner to reopen it (docs/project-reopen-request-design.md §4, project 35333WHtLOjBY6ustMt9A).
-- Filed only by `POST /runner/projects/:id/reopen-requests`, answered by `POST /owner-requests/:id/reopen-project`.
--
--   owner_request.payload    PROJECT_REOPEN: `{ projectId, statusAtAsk, settledAt, plannedWork, askers }`, written by the
--                            server: the project as it stood when asked, the work the agent plans to add, and every
--                            session that asked (the first is asked_by_session_id; later askers join the card).
--                            SETTINGS_CHANGE keeps its 1273 payload; every other kind's stays NULL.
--   owner_request_project_reopen_chk  a PROJECT_REOPEN names its project.
--   owner_request_project_reopen_pending_key  at most one PENDING PROJECT_REOPEN per project (design Q2 A): a second
--                            asker's insert loses on it and joins the waiting card instead.
--
-- The kind check restates 1538's (CHANGE) with PROJECT_REOPEN added, and 1273's payload CHECK is restated under a name
-- that is not one kind's, admitting PROJECT_REOPEN beside SETTINGS_CHANGE. Two constraint swaps, one CHECK and one
-- partial unique index over no rows: every stored row passes (none is a PROJECT_REOPEN), no row is written, no trigger or
-- function is named. Every statement can run twice.
ALTER TABLE "owner_request" DROP CONSTRAINT IF EXISTS "owner_request_kind_chk";
ALTER TABLE "owner_request" ADD CONSTRAINT "owner_request_kind_chk"
  CHECK ("kind" IN ('DECISION', 'SECRET', 'MANUAL_STEP', 'CONFIRM', 'WIKI_CREATE',
                    'SCHEDULE_FAILED', 'SCHEDULE_HELD', 'SCHEDULE_APPROVAL', 'SCHEDULE_WIDEN',
                    'CONDITION_UNKNOWN', 'CONDITION_STILL_WAITING', 'SETTINGS_CHANGE', 'BROWSER_SIGN_IN', 'CHANGE',
                    'PROJECT_REOPEN'));

ALTER TABLE "owner_request" DROP CONSTRAINT IF EXISTS "owner_request_settings_change_chk";
ALTER TABLE "owner_request" DROP CONSTRAINT IF EXISTS "owner_request_payload_chk";
ALTER TABLE "owner_request" ADD CONSTRAINT "owner_request_payload_chk"
  CHECK (("kind" IN ('SETTINGS_CHANGE', 'PROJECT_REOPEN')) = ("payload" IS NOT NULL));

ALTER TABLE "owner_request" DROP CONSTRAINT IF EXISTS "owner_request_project_reopen_chk";
ALTER TABLE "owner_request" ADD CONSTRAINT "owner_request_project_reopen_chk"
  CHECK ("kind" <> 'PROJECT_REOPEN' OR "project_id" IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS "owner_request_project_reopen_pending_key"
  ON "owner_request" ("project_id") WHERE "kind" = 'PROJECT_REOPEN' AND "state" = 'PENDING';
