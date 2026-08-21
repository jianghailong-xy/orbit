-- Every Project event producer lives at the authoritative database write, rather than at one
-- HTTP/MCP caller. This is what keeps old binaries, runner callbacks, batch writes and raw SQL on
-- the same contract: the business row and its dirty signal either both commit or both disappear.

CREATE OR REPLACE FUNCTION "project_event_enqueue_signal"(
    p_project_id UUID,
    p_kind TEXT,
    p_source_type TEXT,
    p_source_id UUID,
    p_payload JSONB DEFAULT '{}'::jsonb,
    p_dedupe_key TEXT DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    happened_at TIMESTAMP(3) := statement_timestamp();
    key TEXT := COALESCE(
      NULLIF(p_dedupe_key, ''),
      p_kind || ':tx:' || txid_current()::text
    );
BEGIN
    -- Project-less legacy rows are intentionally outside this event graph.
    IF p_project_id IS NULL THEN
      RETURN;
    END IF;

    INSERT INTO "project_event" (
      "id", "project_id", "v", "kind", "occurred_at", "source_type", "source_id",
      "dedupe_key", "payload", "last_at"
    ) VALUES (
      gen_random_uuid(), p_project_id, 1, p_kind, happened_at, p_source_type, p_source_id,
      key, COALESCE(p_payload, '{}'::jsonb), happened_at
    )
    ON CONFLICT ("project_id", "dedupe_key") WHERE "consumed_at" IS NULL
    DO UPDATE SET
      "occurrences" = "project_event"."occurrences" + 1,
      "last_at" = GREATEST("project_event"."last_at", EXCLUDED."occurred_at"),
      "v" = EXCLUDED."v",
      "kind" = EXCLUDED."kind",
      "source_type" = EXCLUDED."source_type",
      "source_id" = EXCLUDED."source_id",
      "payload" = EXCLUDED."payload";
END;
$$;

-- A user pressing Run is itself the durable request: there is no separate mutable business row
-- whose lifetime could be made atomic with it. Callers invoke this only after the task's run gates
-- pass. A request id, rather than the transaction id, gives retries/clicks distinct identities;
-- uniqueness remains scoped to the Project by the outbox partial index.
CREATE OR REPLACE FUNCTION "project_event_manual_trigger"(
    p_project_id UUID,
    p_user_id UUID,
    p_request_id UUID
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM "project_event_enqueue_signal"(
      p_project_id,
      'user.manual_trigger',
      'USER',
      p_user_id,
      jsonb_build_object('requestId', p_request_id),
      'user.manual_trigger:' || p_request_id::text
    );
END;
$$;

CREATE OR REPLACE FUNCTION "project_task_event_source"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    old_project UUID := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD."project_id" END;
    new_project UUID := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW."project_id" END;
    task_id UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD."id" ELSE NEW."id" END;
    audit JSONB := jsonb_build_object('operation', TG_OP, 'taskId', task_id);
BEGIN
    IF TG_OP = 'INSERT' THEN
      PERFORM "project_event_enqueue_signal"(
        new_project, 'task.created', 'TASK', task_id, audit
      );
      RETURN NULL;
    END IF;

    IF TG_OP = 'DELETE' THEN
      PERFORM "project_event_enqueue_signal"(
        old_project, 'task.deleted', 'TASK', task_id, audit
      );
      RETURN NULL;
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status" THEN
      PERFORM "project_event_enqueue_signal"(
        new_project,
        'task.status_changed',
        'TASK',
        task_id,
        audit || jsonb_build_object('from', OLD."status", 'to', NEW."status")
      );
    END IF;

    IF NEW."project_id" IS DISTINCT FROM OLD."project_id"
       OR NEW."parent_task_id" IS DISTINCT FROM OLD."parent_task_id" THEN
      -- Moving a row dirties both the Project that lost it and the Project that gained it. The
      -- same-project reparent collapses naturally on (project, kind, transaction).
      PERFORM "project_event_enqueue_signal"(
        old_project,
        'task.reparented',
        'TASK',
        task_id,
        audit || jsonb_build_object(
          'fromProjectId', OLD."project_id", 'toProjectId', NEW."project_id",
          'fromParentTaskId', OLD."parent_task_id", 'toParentTaskId', NEW."parent_task_id"
        )
      );
      PERFORM "project_event_enqueue_signal"(
        new_project,
        'task.reparented',
        'TASK',
        task_id,
        audit || jsonb_build_object(
          'fromProjectId', OLD."project_id", 'toProjectId', NEW."project_id",
          'fromParentTaskId', OLD."parent_task_id", 'toParentTaskId', NEW."parent_task_id"
        )
      );
    END IF;

    -- updated_at is an implementation clock, while the three fields above each have a more
    -- specific event. Every other scalar/relation change is task.updated.
    IF (to_jsonb(NEW) - ARRAY['updated_at', 'status', 'project_id', 'parent_task_id'])
       IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['updated_at', 'status', 'project_id', 'parent_task_id']) THEN
      PERFORM "project_event_enqueue_signal"(
        new_project, 'task.updated', 'TASK', task_id, audit
      );
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER "project_task_event_source"
AFTER INSERT OR UPDATE OR DELETE ON "task"
FOR EACH ROW EXECUTE FUNCTION "project_task_event_source"();

CREATE OR REPLACE FUNCTION "project_task_dependency_event_source"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    dependent_id UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD."task_id" ELSE NEW."task_id" END;
    prerequisite_id UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD."depends_on_task_id" ELSE NEW."depends_on_task_id" END;
    dependent_project UUID;
    prerequisite_project UUID;
    audit JSONB := jsonb_build_object(
      'operation', TG_OP,
      'taskId', dependent_id,
      'dependsOnTaskId', prerequisite_id
    );
BEGIN
    SELECT "project_id" INTO dependent_project FROM "task" WHERE "id" = dependent_id;
    SELECT "project_id" INTO prerequisite_project FROM "task" WHERE "id" = prerequisite_id;

    PERFORM "project_event_enqueue_signal"(
      dependent_project, 'task.dependency_changed', 'TASK', dependent_id, audit
    );
    IF prerequisite_project IS DISTINCT FROM dependent_project THEN
      PERFORM "project_event_enqueue_signal"(
        prerequisite_project, 'task.dependency_changed', 'TASK', dependent_id, audit
      );
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER "project_task_dependency_event_source"
AFTER INSERT OR UPDATE OR DELETE ON "task_dependency"
FOR EACH ROW EXECUTE FUNCTION "project_task_dependency_event_source"();

CREATE OR REPLACE FUNCTION "project_session_event_source"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    session_id UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD."id" ELSE NEW."id" END;
    task_id UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD."task_id" ELSE NEW."task_id" END;
    project_id UUID;
    event_kind TEXT;
    audit JSONB;
    started_dedupe TEXT;
BEGIN
    SELECT t."project_id" INTO project_id FROM "task" t WHERE t."id" = task_id;
    IF project_id IS NULL THEN
      RETURN NULL;
    END IF;

    audit := jsonb_build_object('operation', TG_OP, 'sessionId', session_id, 'taskId', task_id);

    IF TG_OP = 'INSERT' THEN
      -- Batch execution creates its sessions in separate short transactions. batch_id is the
      -- request identity that lets those starts remain one pending signal per Project.
      started_dedupe := CASE
        WHEN NEW."batch_id" IS NULL THEN NULL
        ELSE 'session.started:batch:' || NEW."batch_id"::text
      END;
      PERFORM "project_event_enqueue_signal"(
        project_id,
        'session.started',
        'SESSION',
        session_id,
        audit || jsonb_build_object('status', NEW."status"),
        started_dedupe
      );
      RETURN NULL;
    END IF;

    IF TG_OP = 'DELETE' THEN
      PERFORM "project_event_enqueue_signal"(
        project_id, 'session.ended', 'SESSION', session_id, audit || jsonb_build_object('deleted', true)
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
          project_id,
          event_kind,
          'SESSION',
          session_id,
          audit || jsonb_build_object('from', OLD."status", 'to', NEW."status")
        );
      END IF;
    END IF;

    IF NEW."merge_status" IS DISTINCT FROM OLD."merge_status" THEN
      event_kind := CASE
        WHEN NEW."merge_status" = 'merged' THEN 'merge.succeeded'
        WHEN NEW."merge_status" IN ('conflict', 'error') THEN 'merge.conflict'
        ELSE NULL
      END;
      IF event_kind IS NOT NULL THEN
        PERFORM "project_event_enqueue_signal"(
          project_id,
          event_kind,
          'MERGE',
          session_id,
          audit || jsonb_build_object('status', NEW."merge_status", 'error', NEW."merge_error")
        );
      END IF;
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER "project_session_event_source"
AFTER INSERT OR UPDATE OR DELETE ON "session"
FOR EACH ROW EXECUTE FUNCTION "project_session_event_source"();

CREATE OR REPLACE FUNCTION "project_approval_event_source"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    project_id UUID;
    session_owner UUID;
    task_id UUID;
    audit JSONB;
BEGIN
    SELECT s."owner_id", s."task_id", t."project_id"
      INTO session_owner, task_id, project_id
      FROM "session" s
      LEFT JOIN "task" t ON t."id" = s."task_id"
     WHERE s."id" = NEW."session_id";
    IF project_id IS NULL THEN
      RETURN NULL;
    END IF;
    audit := jsonb_build_object(
      'approvalId', NEW."id", 'sessionId', NEW."session_id", 'status', NEW."status"
    );

    IF TG_OP = 'INSERT' AND NEW."status" = 'PENDING' THEN
      PERFORM "project_event_enqueue_signal"(
        project_id, 'session.approval_pending', 'SESSION', NEW."session_id", audit
      );
    ELSIF TG_OP = 'UPDATE'
          AND NEW."status" IS DISTINCT FROM OLD."status"
          AND OLD."status" = 'PENDING'
          AND NEW."status" IN ('ALLOWED', 'DENIED') THEN
      PERFORM "project_event_enqueue_signal"(
        project_id,
        'user.approval_resolved',
        'USER',
        COALESCE(NEW."decided_by_id", session_owner),
        audit
      );
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER "project_approval_event_source"
AFTER INSERT OR UPDATE OF "status", "decided_by_id" ON "approval"
FOR EACH ROW EXECUTE FUNCTION "project_approval_event_source"();

CREATE OR REPLACE FUNCTION "project_user_edit_event_source"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    policy_changed BOOLEAN := false;
    project_edited BOOLEAN := false;
    audit JSONB;
BEGIN
    audit := jsonb_build_object('operation', TG_OP, 'projectId', NEW."id");
    IF TG_OP = 'INSERT' THEN
      PERFORM "project_event_enqueue_signal"(
        NEW."id", 'user.project_edited', 'USER', NEW."owner_id", audit
      );
      RETURN NULL;
    END IF;

    policy_changed :=
      NEW."coordinator_enabled" IS DISTINCT FROM OLD."coordinator_enabled"
      OR NEW."automation_policy" IS DISTINCT FROM OLD."automation_policy"
      OR NEW."max_concurrent_tasks" IS DISTINCT FROM OLD."max_concurrent_tasks"
      OR NEW."session_budget_per_day" IS DISTINCT FROM OLD."session_budget_per_day"
      OR NEW."config_revision" IS DISTINCT FROM OLD."config_revision";
    project_edited :=
      NEW."title" IS DISTINCT FROM OLD."title"
      OR NEW."goal" IS DISTINCT FROM OLD."goal"
      OR NEW."acceptance_criteria" IS DISTINCT FROM OLD."acceptance_criteria"
      OR NEW."instructions" IS DISTINCT FROM OLD."instructions"
      OR NEW."status" IS DISTINCT FROM OLD."status"
      OR NEW."coordinator_session_id" IS DISTINCT FROM OLD."coordinator_session_id"
      OR NEW."coordinator_workspace_id" IS DISTINCT FROM OLD."coordinator_workspace_id";

    IF policy_changed THEN
      PERFORM "project_event_enqueue_signal"(
        NEW."id", 'user.policy_changed', 'USER', NEW."owner_id", audit
      );
    END IF;
    IF project_edited THEN
      PERFORM "project_event_enqueue_signal"(
        NEW."id", 'user.project_edited', 'USER', NEW."owner_id", audit
      );
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER "project_user_edit_event_source"
AFTER INSERT OR UPDATE ON "project"
FOR EACH ROW EXECUTE FUNCTION "project_user_edit_event_source"();
