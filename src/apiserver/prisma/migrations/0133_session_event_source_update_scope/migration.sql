-- The Session event source stops running on writes that cannot produce an event.
--
-- `project_session_event_source` (0117, rewritten by 0126) is installed as
-- `AFTER INSERT OR UPDATE OR DELETE`, so EVERY UPDATE of a `session` row runs its body — and the
-- first thing the body does, before it has looked at a single column, is two lookups:
--
--     SELECT t."project_id" FROM "task"    t WHERE t."id"  = task_id;
--     SELECT p."id"         FROM "project" p WHERE p."coordinator_session_id" = session_id;
--
-- Only three columns can make that work produce anything: `status`, `deleted_at` and
-- `merge_status`. Everything else a `session` row carries is telemetry the runner writes at
-- conversation rate — `last_turn_at`, `last_tool_use`, `last_assistant_text`, `last_user_text`,
-- `engine_turn_active`, `context_tokens`, `updated_at` — and a single `/events` batch issues
-- several such UPDATEs (runner-api.controller.ts). Each one currently pays for two index probes
-- and, which is the point of this migration, joins `task` and `project` to the lock set of a
-- transaction that has no business being there:
--
--   * the probe takes an `AccessShareLock` on `task`, so a telemetry write queues behind ANY
--     `AccessExclusiveLock` on that table — an `ALTER TABLE task` during a deploy, a `REINDEX`,
--     a `VACUUM FULL`. The writes are not merely delayed: each one is already holding its own
--     `session` row lock while it waits, so a sub-second DDL turns into a fan-out of blocked
--     runner transactions;
--   * and it makes "a telemetry write enqueues nothing" a property of the function BODY, which
--     is one edit away from being false, rather than of the trigger DEFINITION, which the
--     planner and the lock manager can both see.
--
-- So the trigger is split. INSERT and DELETE are unchanged and unconditional — both are events.
-- UPDATE is declared over the three columns that carry event meaning, with a `WHEN` that also
-- requires the value to have actually changed, because `UPDATE OF` fires on a column being
-- ASSIGNED, not on it changing (a writer that re-asserts `status` in its SET list is common).
--
-- The same predicate is repeated as an early return at the top of the function. It is not
-- redundant: the function is a function, and the `AFTER INSERT OR UPDATE OR DELETE` trigger this
-- migration replaces still exists in every database that has not run this file yet. A defensive
-- early return means a rolled-back trigger definition, a hand-installed one, or a future event
-- type cannot silently restore the lookups.
--
-- Nothing else about the event contract moves: the body below is 0126's, verbatim, with the
-- early return added ahead of the two lookups.
--
-- Re-runnable: `CREATE OR REPLACE` for the function, `DROP TRIGGER IF EXISTS` before each
-- `CREATE TRIGGER`. It adds no column, rewrites no row and backfills nothing.

CREATE OR REPLACE FUNCTION "project_session_event_source"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    session_id UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD."id" ELSE NEW."id" END;
    task_id UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD."task_id" ELSE NEW."task_id" END;
    task_project UUID;
    coordinated_project UUID;
    event_kind TEXT;
    audit JSONB;
    started_dedupe TEXT;
BEGIN
    -- The trigger below already refuses to call this for a telemetry-only UPDATE. This is the
    -- same statement said a second time, where it survives the trigger being redefined: an
    -- UPDATE that moves none of the three event-bearing columns has nothing to enqueue, so it
    -- must not read `task` or `project` either.
    IF TG_OP = 'UPDATE'
       AND NEW."status" IS NOT DISTINCT FROM OLD."status"
       AND NEW."deleted_at" IS NOT DISTINCT FROM OLD."deleted_at"
       AND NEW."merge_status" IS NOT DISTINCT FROM OLD."merge_status" THEN
      RETURN NULL;
    END IF;

    SELECT t."project_id" INTO task_project FROM "task" t WHERE t."id" = task_id;
    SELECT p."id" INTO coordinated_project
      FROM "project" p WHERE p."coordinator_session_id" = session_id;
    IF task_project IS NULL AND coordinated_project IS NULL THEN
      RETURN NULL;
    END IF;

    audit := jsonb_build_object('operation', TG_OP, 'sessionId', session_id, 'taskId', task_id);
    IF coordinated_project IS NOT NULL THEN
      audit := audit || jsonb_build_object('coordinatorSession', true);
    END IF;

    IF TG_OP = 'INSERT' THEN
      started_dedupe := CASE
        WHEN NEW."batch_id" IS NULL THEN NULL
        ELSE 'session.started:batch:' || NEW."batch_id"::text
      END;
      PERFORM "project_event_enqueue_signal"(
        task_project, 'session.started', 'SESSION', session_id,
        audit || jsonb_build_object('status', NEW."status"), started_dedupe
      );
      RETURN NULL;
    END IF;

    IF TG_OP = 'DELETE' THEN
      PERFORM "project_event_enqueue_signal"(
        task_project, 'session.ended', 'SESSION', session_id,
        audit || jsonb_build_object('deleted', true)
      );
      PERFORM "project_event_enqueue_signal"(
        coordinated_project, 'session.ended', 'SESSION', session_id,
        audit || jsonb_build_object('deleted', true)
      );
      RETURN NULL;
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status" THEN
      event_kind := CASE
        WHEN NEW."status" = 'FAILED' THEN 'session.failed'
        WHEN NEW."status" IN ('AWAITING_INPUT', 'INTERRUPTED') THEN 'session.awaiting_input'
        WHEN NEW."status" IN ('SUCCEEDED', 'CANCELLED') THEN 'session.ended'
        WHEN NEW."status" IN ('PENDING', 'RUNNING')
             AND OLD."status" IN ('SUCCEEDED', 'FAILED', 'CANCELLED') THEN 'session.started'
        ELSE NULL
      END;
      IF event_kind IS NOT NULL THEN
        PERFORM "project_event_enqueue_signal"(
          task_project, event_kind, 'SESSION', session_id,
          audit || jsonb_build_object('from', OLD."status", 'to', NEW."status")
        );
        PERFORM "project_event_enqueue_signal"(
          coordinated_project, event_kind, 'SESSION', session_id,
          audit || jsonb_build_object('from', OLD."status", 'to', NEW."status")
        );
      END IF;
    END IF;

    IF NEW."deleted_at" IS NOT NULL AND OLD."deleted_at" IS NULL THEN
      PERFORM "project_event_enqueue_signal"(
        coordinated_project, 'session.ended', 'SESSION', session_id,
        audit || jsonb_build_object('deleted', true)
      );
    END IF;

    IF NEW."merge_status" IS DISTINCT FROM OLD."merge_status" THEN
      event_kind := CASE
        WHEN NEW."merge_status" = 'merged' THEN 'merge.succeeded'
        WHEN NEW."merge_status" IN ('conflict', 'error') THEN 'merge.conflict'
        ELSE NULL
      END;
      IF event_kind IS NOT NULL THEN
        PERFORM "project_event_enqueue_signal"(
          task_project, event_kind, 'MERGE', session_id,
          audit || jsonb_build_object('status', NEW."merge_status", 'error', NEW."merge_error")
        );
      END IF;
    END IF;
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION "project_session_event_source"() IS
  'Session lifecycle signals for a Project. Runs on INSERT/DELETE, and on an UPDATE only when status, deleted_at or merge_status actually changed — telemetry-only writes read neither task nor project.';

-- INSERT and DELETE keep the original trigger name: both are events unconditionally, and the
-- name is what an operator disabling the event source reaches for.
DROP TRIGGER IF EXISTS "project_session_event_source" ON "session";
CREATE TRIGGER "project_session_event_source"
AFTER INSERT OR DELETE ON "session"
FOR EACH ROW EXECUTE FUNCTION "project_session_event_source"();

-- `UPDATE OF` is the column list the STATEMENT assigns; `WHEN` is the value actually moving.
-- Both are needed, and the order matters for what they buy:
--
--   * `UPDATE OF` is evaluated without fetching anything — a telemetry UPDATE never enters the
--     after-trigger queue at all, which is the property that keeps `task` and `project` out of
--     that transaction's lock set;
--   * `WHEN` catches the writer that DOES name one of the three columns while assigning it the
--     value it already had (`updateMany({ data: { status: 'RUNNING', lastTurnAt } })` is exactly
--     that shape), which `UPDATE OF` alone would let through.
--
-- The three columns are the complete set the body can act on. `merge_error` is deliberately not
-- among them: it is only ever read as payload alongside a `merge_status` change, and a write
-- that moves it alone has no event.
--
-- No BEFORE trigger on `session` assigns any of the three (0076 syncs completed_at/archived_at,
-- 0080's OpenCode claim guard only vetoes the row, 0122's snapshot guard only raises), so
-- "assigned by the statement" and "assigned by the time AFTER runs" are the same set here.
DROP TRIGGER IF EXISTS "project_session_event_source_update" ON "session";
CREATE TRIGGER "project_session_event_source_update"
AFTER UPDATE OF "status", "deleted_at", "merge_status" ON "session"
FOR EACH ROW
WHEN (OLD."status" IS DISTINCT FROM NEW."status"
      OR OLD."deleted_at" IS DISTINCT FROM NEW."deleted_at"
      OR OLD."merge_status" IS DISTINCT FROM NEW."merge_status")
EXECUTE FUNCTION "project_session_event_source"();
