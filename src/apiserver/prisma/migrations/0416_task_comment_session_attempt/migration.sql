-- 0416 — which run wrote a comment: the session it came from, and the task's attempt that session is.
--
-- WHAT IT ADDS
-- ============
-- Two nullable UUID columns on `task_comment`, written by `TasksService.addComment` when an agent
-- comments from inside a session (the runner door's `X-Orbit-Session-Id`):
--   * `session_id` — the acting session, kept only when it is one of the task owner's sessions;
--   * `attempt_id` — the `task_attempt` that session is (0139), kept only when that attempt is one of
--                    THIS task's: a session running another task that comments here names its
--                    session, never another task's attempt.
-- A comment written in the app, by the CLI outside a session, or by the platform itself names neither.
--
-- WHY IT EXISTS
-- =============
-- A comment named only its author — a person or an agent — so a task that ran more than once could not
-- say which run a comment came from. The runner door's handler already took an `X-Orbit-Session-Id`
-- header, but the runner never sent one for a comment and the service did not keep it.
--
-- Both are snapshots rather than foreign keys, as `task_completion_evidence.source_session_id` and
-- `source_attempt_id` are: purging a session from Trash cascades to its attempt, and a comment keeps
-- naming the run it came from after that.
--
-- BACKWARD COMPATIBLE
-- ===================
-- Catalog-only ADD COLUMNs with no default and no constraint: no row is read, written or backfilled, and
-- every stored comment reads NULL. No index — comments are read by task, as before — and no trigger,
-- function, type or constraint is created, replaced or dropped.

ALTER TABLE "task_comment"
  ADD COLUMN "session_id" uuid,
  ADD COLUMN "attempt_id" uuid;
