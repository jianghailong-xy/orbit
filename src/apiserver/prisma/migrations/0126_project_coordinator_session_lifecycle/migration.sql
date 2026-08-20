-- Unit 19 — the coordinator SESSION becomes a rotatable, recoverable run record (§7.5, §8.4, §12.4).
--
-- Three things are missing from the database before this migration, and all three are the kind that
-- cannot be fixed in one binary's service layer:
--
--   1. A coordinator session's lifecycle is INVISIBLE to the control loop. `project_session_event_
--      source` (0117) resolves a session's project through `session.task_id → task.project_id`, and
--      a coordinator session has no task. So the conversation a project is coordinated from could
--      end, fail or be deleted and not one `project_event` row was written — §8.4's "Coordinator
--      Session 在 turn 中途死 ⇒ session.failed ⇒ reconcile ⇒ §7.5 轮换" had no first step.
--   2. The dispatch boundary (0122) states, in the database, that a `PROJECT_COORDINATOR`-origin
--      session is a task dispatch: `session_dispatch_authority_guard` refuses a task-less session
--      that carries a `project_action_id` at all. That was true when the only such action was
--      `DISPATCH_TASK`; §7.3's action table has a second one, and a rotation's product is exactly
--      a task-less session owned by a Project action. The guard is EXTENDED, not relaxed — the
--      rotate branch carries its own fence, subject and landing conditions.
--   3. Nothing stops any writer — an old binary, a raw statement, a future service — from pointing
--      `project.coordinator_session_id` at a session that belongs to somebody else, or that runs
--      somewhere other than the project's fixed coordination workspace. §7.5 freezes "轮换不是迁移";
--      that sentence has to hold against the 0110-era binary still serving requests during a
--      rolling deploy (§12.4), which means it belongs here rather than in a service.
--
-- Every statement is re-runnable: functions are `CREATE OR REPLACE`, triggers are dropped by name
-- first, and nothing is backfilled — this migration adds no column and rewrites no row.

-- ── 1 · The coordinator session's own lifecycle is a signal (§5.3 session class, §8.4) ─────────
--
-- 0117's fan-out rule (N1) is "the projectId is decided by the ROW being written". For a session
-- that is a project's coordinator, that row decides TWO projects at most: the one its task belongs
-- to (unchanged, and normally none — a coordinator session has no task) and the one that names it
-- as coordinator. Both are enqueued, because they are two different facts about two different
-- projects; the outbox's partial unique index is per project, so neither can collapse the other.
--
-- The coordinated project is found through `project.coordinator_session_id`, which is `@unique` —
-- so the lookup is one index probe and can name at most one project. That is the bounded query N2
-- demands of every fan-out.
--
-- What this does NOT do is decide anything about the project. §5.1 E1: an event is a signal, never
-- a fact. Whether the session's end means a rotation is a question the reconcile pass answers from
-- the world, and a project that is out of the loop discards the row under §5.5 EV3.
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
    SELECT t."project_id" INTO task_project FROM "task" t WHERE t."id" = task_id;
    SELECT p."id" INTO coordinated_project
      FROM "project" p WHERE p."coordinator_session_id" = session_id;
    IF task_project IS NULL AND coordinated_project IS NULL THEN
      RETURN NULL;
    END IF;

    audit := jsonb_build_object('operation', TG_OP, 'sessionId', session_id, 'taskId', task_id);
    -- Which of the two roles this session plays for the project being told. A reader that has to
    -- work that out by re-querying would be reading a fact out of an event, which E1 forbids; it is
    -- an audit field, and §6.1 re-reads the world regardless.
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
      -- A session cannot already be a project's coordinator at INSERT time: the pointer is written
      -- afterwards, by a statement of its own, and that statement is what tells the project.
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

    -- A soft delete is an UPDATE, and it is the way a user "deletes" the conversation a project is
    -- coordinated from (`SessionsService.remove`). Without this the pointer would keep naming a row
    -- in Trash and the loop would never hear that its coordinator is gone.
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

-- The other half of "the coordinator is gone": a HARD delete of the session sets the pointer to
-- NULL through the foreign key (`onDelete: SetNull`), and a foreign key's own write fires no
-- session trigger for the project it just emptied. This one is on the project row, so it hears the
-- FK's write, a user's write and a rotation's write with the same statement.
--
-- Only the pointer being EMPTIED is a signal. A rotation (non-null → different non-null) is the
-- loop's own committed action and it schedules its own next wake; telling it about its own write
-- would be a self-wake on every rotation for no new fact.
CREATE OR REPLACE FUNCTION "project_coordinator_session_event_source"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM "project_event_enqueue_signal"(
      NEW."id", 'session.ended', 'SESSION', OLD."coordinator_session_id",
      jsonb_build_object(
        'operation', TG_OP, 'sessionId', OLD."coordinator_session_id",
        'coordinatorSession', true, 'cleared', true
      )
    );
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS "project_coordinator_session_event_source" ON "project";
CREATE TRIGGER "project_coordinator_session_event_source"
AFTER UPDATE OF "coordinator_session_id" ON "project"
FOR EACH ROW
WHEN (OLD."coordinator_session_id" IS NOT NULL AND NEW."coordinator_session_id" IS NULL)
EXECUTE FUNCTION "project_coordinator_session_event_source"();

-- ── 2 · A rotation's product is a legal coordinator session, proved by the database (§12.4) ────
--
-- 0122's guard refused every task-less session that carried a Project action, because at the time
-- "Project action that makes a session" and "task dispatch" were the same sentence. §7.3's table
-- has two such actions. The rotate branch below is the second one written out with the SAME
-- structure the dispatch branch has — a fenced, correctly-subjected, correctly-typed action row —
-- plus the one condition that is special to §7.5: **落点固定**. The new conversation opens in the
-- project's recorded coordination workspace or it does not open at all, and that is checked here
-- rather than in a service so that "轮换不是迁移" survives whichever binary is writing.
CREATE OR REPLACE FUNCTION "session_dispatch_authority_guard"() RETURNS trigger AS $$
DECLARE
  authority "task_dispatch_authority";
  task_project UUID;
  task_owner UUID;
BEGIN
  IF NEW."task_id" IS NULL THEN
    IF NEW."dispatch_origin" = 'PROJECT_COORDINATOR' OR NEW."project_action_id" IS NOT NULL THEN
      IF NEW."dispatch_origin" = 'PROJECT_COORDINATOR'
         AND NEW."project_action_id" IS NOT NULL
         AND EXISTS (
           SELECT 1
             FROM "project_action" a
             JOIN "project_runtime" r ON r."project_id" = a."project_id"
             JOIN "project" p ON p."id" = a."project_id"
            WHERE a."id" = NEW."project_action_id"
              AND a."type" = 'ROTATE_COORDINATOR_SESSION'
              AND a."status" IN ('CLAIMED', 'APPLIED')
              AND a."subject_type" = 'PROJECT' AND a."subject_id" = a."project_id"
              AND a."fencing_token" = r."fencing_token"
              AND p."owner_id" = NEW."owner_id"
              -- §7.5 落点固定. `IS NOT DISTINCT FROM` rather than `=`: a project whose landing was
              -- hard-deleted holds NULL there, and NULL must not silently admit any workspace.
              AND p."coordinator_workspace_id" IS NOT DISTINCT FROM NEW."workspace_id"
              AND NEW."workspace_id" IS NOT NULL
         ) THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'DISPATCH_AUTHORITY_VIOLATION: coordinator session % has no task', NEW."id";
    END IF;
    RETURN NEW;
  END IF;

  SELECT t."dispatch_authority", t."project_id", t."owner_id"
    INTO authority, task_project, task_owner
    FROM "task" t WHERE t."id" = NEW."task_id" FOR SHARE;
  IF NOT FOUND OR task_owner IS DISTINCT FROM NEW."owner_id" THEN
    RAISE EXCEPTION 'DISPATCH_AUTHORITY_VIOLATION: task % is unavailable to session owner', NEW."task_id";
  END IF;

  IF NEW."dispatch_origin" = 'USER' THEN
    IF NEW."project_action_id" IS NOT NULL THEN
      RAISE EXCEPTION 'DISPATCH_ATTRIBUTION_VIOLATION: user session % carries a Project action', NEW."id";
    END IF;
    RETURN NEW;
  END IF;

  IF authority = 'LEGACY' THEN
    IF NEW."dispatch_origin" <> 'LEGACY_SWEEP' OR NEW."project_action_id" IS NOT NULL THEN
      RAISE EXCEPTION 'DISPATCH_AUTHORITY_VIOLATION: Project Coordinator dispatch on LEGACY task %', NEW."task_id";
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."dispatch_origin" = 'PROJECT_COORDINATOR'
     AND NEW."project_action_id" IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM "project_action" a
         JOIN "project_runtime" r ON r."project_id" = a."project_id"
        WHERE a."id" = NEW."project_action_id"
          AND a."type" = 'DISPATCH_TASK'
          AND a."status" IN ('CLAIMED', 'APPLIED')
          AND a."subject_type" = 'TASK' AND a."subject_id" = NEW."task_id"
          AND a."project_id" = task_project
          AND a."fencing_token" = r."fencing_token"
     ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'DISPATCH_AUTHORITY_VIOLATION: task % is Coordinator-authority', NEW."task_id";
END;
$$ LANGUAGE plpgsql;

-- D15's commit-time half, extended the same way: at COMMIT the two rows must point at one another
-- and the action must have reached APPLIED. The dispatch branch is unchanged; the rotate branch
-- says the same three things about a task-less session and a PROJECT subject.
CREATE OR REPLACE FUNCTION "session_dispatch_attribution_check"() RETURNS trigger AS $$
DECLARE s "session"%ROWTYPE;
BEGIN
  SELECT * INTO s FROM "session" WHERE "id" = NEW."id";
  IF NOT FOUND OR s."dispatch_origin" <> 'PROJECT_COORDINATOR' THEN RETURN NULL; END IF;
  IF s."task_id" IS NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM "project_action" a
       WHERE a."id" = s."project_action_id" AND a."type" = 'ROTATE_COORDINATOR_SESSION'
         AND a."status" = 'APPLIED' AND a."subject_type" = 'PROJECT'
         AND a."subject_id" = a."project_id" AND a."result_session_id" = s."id"
    ) THEN
      RAISE EXCEPTION 'DISPATCH_ATTRIBUTION_VIOLATION: session % is not an applied rotation', s."id";
    END IF;
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "project_action" a JOIN "task" t ON t."id" = s."task_id"
     WHERE a."id" = s."project_action_id" AND a."type" = 'DISPATCH_TASK'
       AND a."status" = 'APPLIED' AND a."subject_type" = 'TASK'
       AND a."subject_id" = s."task_id" AND a."project_id" = t."project_id"
       AND a."result_session_id" = s."id"
  ) THEN
    RAISE EXCEPTION 'DISPATCH_ATTRIBUTION_VIOLATION: session % is not an applied dispatch', s."id";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- The ledger side of the same equality, and the reason it is quantified over both types: an
-- `APPLIED` action of either kind that produced no session, or a refused one that carries a
-- session, is the shape §8.3's exactly-once claim would be false in.
CREATE OR REPLACE FUNCTION "project_action_dispatch_result_check"() RETURNS trigger AS $$
DECLARE a "project_action"%ROWTYPE;
BEGIN
  SELECT * INTO a FROM "project_action" WHERE "id" = NEW."id";
  IF NOT FOUND OR a."type" NOT IN ('DISPATCH_TASK', 'ROTATE_COORDINATOR_SESSION') THEN
    RETURN NULL;
  END IF;
  IF a."status" = 'APPLIED' AND a."type" = 'DISPATCH_TASK' AND NOT EXISTS (
    SELECT 1 FROM "session" s WHERE s."id" = a."result_session_id"
      AND s."project_action_id" = a."id" AND s."dispatch_origin" = 'PROJECT_COORDINATOR'
      AND s."task_id" = a."subject_id"
  ) THEN
    RAISE EXCEPTION 'DISPATCH_RESULT_LINK_VIOLATION: applied action % has no owned session', a."id";
  END IF;
  -- A rotation that was applied must have produced the conversation, and that conversation must be
  -- the one the project now names. The second half is what makes "the pointer and the ledger agree"
  -- a committed fact rather than a service-layer intention.
  IF a."status" = 'APPLIED' AND a."type" = 'ROTATE_COORDINATOR_SESSION' AND NOT EXISTS (
    SELECT 1 FROM "session" s JOIN "project" p ON p."id" = a."project_id"
     WHERE s."id" = a."result_session_id" AND s."project_action_id" = a."id"
       AND s."dispatch_origin" = 'PROJECT_COORDINATOR' AND s."task_id" IS NULL
       AND p."coordinator_session_id" = s."id"
  ) THEN
    RAISE EXCEPTION 'ROTATION_RESULT_LINK_VIOLATION: applied rotation % is not this project''s coordinator', a."id";
  END IF;
  IF a."status" IN ('REFUSED', 'SUPERSEDED') AND a."result_session_id" IS NOT NULL THEN
    RAISE EXCEPTION 'DISPATCH_RESULT_LINK_VIOLATION: non-applied action % carries a session', a."id";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- D11's publication immutability, quantified over the same two types for the same reason: once a
-- rotation is published, which conversation it opened is history.
CREATE OR REPLACE FUNCTION "project_action_dispatch_immutable"() RETURNS trigger AS $$
BEGIN
  IF OLD."type" NOT IN ('DISPATCH_TASK', 'ROTATE_COORDINATOR_SESSION') THEN RETURN NEW; END IF;
  IF OLD."status" <> 'CLAIMED' AND (
       NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
    OR NEW."type" IS DISTINCT FROM OLD."type"
    OR NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."subject_type" IS DISTINCT FROM OLD."subject_type"
    OR NEW."subject_id" IS DISTINCT FROM OLD."subject_id"
    OR NEW."fencing_token" IS DISTINCT FROM OLD."fencing_token"
    OR NEW."decision_id" IS DISTINCT FROM OLD."decision_id"
    OR NEW."result_session_id" IS DISTINCT FROM OLD."result_session_id"
    OR NEW."refusal_code" IS DISTINCT FROM OLD."refusal_code"
    OR NEW."execution_context" IS DISTINCT FROM OLD."execution_context"
    OR NEW."execution_context_digest" IS DISTINCT FROM OLD."execution_context_digest"
    OR NEW."execution_result_digest" IS DISTINCT FROM OLD."execution_result_digest"
    OR NEW."reason_code" IS DISTINCT FROM OLD."reason_code"
  ) THEN
    RAISE EXCEPTION 'ACTION_APPLIED_IMMUTABLE: dispatch action % is terminal', OLD."id";
  END IF;
  IF OLD."status" = 'CLAIMED' AND NEW."status" NOT IN
       ('CLAIMED', 'APPLIED', 'REFUSED', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'ACTION_TRANSITION_ILLEGAL: dispatch action %', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── 3 · What a coordinator pointer is allowed to name (§7.5, §12.4) ────────────────────────────
--
-- Deliberately NOT a check on how the pointer is written or by whom: a person opening a coordinator
-- through the API, the control loop rotating one, and a 0110-era binary relocating one all end up
-- executing the same UPDATE, so the rule has to be about the VALUE. Four conditions, each of which
-- is a way the project would otherwise end up naming a conversation nobody can use:
--
--   * the session must exist (a dangling pointer is not a coordinator);
--   * it must belong to the project's owner (`coordinator_session_id` carries no tenant check of
--     its own, exactly as `coordinator_workspace_id` carries none — 0113 says so about WHO);
--   * it must run in the project's coordination workspace when the project records one. §7.5:
--     rotation replaces the SESSION, not the landing. NULL admits anything because a project that
--     records no landing has not fixed one yet — that is the FIRST binding, not a migration.
--
-- What is deliberately NOT checked is whether the session is in Trash. A bound coordinator can be
-- soft-deleted at any time — that is an UPDATE on `session`, which never passes here — so "the
-- pointer names a trashed conversation" is a state this system reaches on its own and already
-- knows how to leave: `ProjectsService.coordinator` replaces such a binding rather than reviving
-- it, and §7.5's planner reads it as a rotation trigger. Refusing to WRITE the state the system
-- can already be IN would only break the paths that repair it.
--
-- Emptying the pointer is always allowed: the FK's SET NULL does exactly that, and a project
-- waiting for its next coordinator is a legal, recoverable state (§7.5, and it is the state the
-- rotation planner reads as "rotate me").
-- Quantified over BOTH columns rather than over the pointer alone. Moving the landing out from
-- under a live pointer produces the same contradiction as re-pointing the session — the project
-- names a coordination workspace and a conversation that does not run in it — and 04R's lesson is
-- that a rule about a committed pair has to be evaluated against the pair.
CREATE OR REPLACE FUNCTION "project_coordinator_pointer_guard"() RETURNS trigger AS $$
DECLARE s "session"%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."coordinator_session_id" IS NOT DISTINCT FROM OLD."coordinator_session_id"
     AND NEW."coordinator_workspace_id" IS NOT DISTINCT FROM OLD."coordinator_workspace_id" THEN
    RETURN NEW;
  END IF;
  IF NEW."coordinator_session_id" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO s FROM "session" WHERE "id" = NEW."coordinator_session_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'COORDINATOR_POINTER_INVALID: session % does not exist', NEW."coordinator_session_id";
  END IF;
  IF s."owner_id" IS DISTINCT FROM NEW."owner_id" THEN
    RAISE EXCEPTION 'COORDINATOR_POINTER_INVALID: session % belongs to another owner', s."id";
  END IF;
  IF NEW."coordinator_workspace_id" IS NOT NULL
     AND s."workspace_id" IS DISTINCT FROM NEW."coordinator_workspace_id" THEN
    RAISE EXCEPTION 'COORDINATOR_POINTER_RELOCATED: session % does not run in this project''s coordination workspace', s."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "project_coordinator_pointer_guard" ON "project";
CREATE TRIGGER "project_coordinator_pointer_guard"
BEFORE INSERT OR UPDATE OF "coordinator_session_id", "coordinator_workspace_id" ON "project"
FOR EACH ROW EXECUTE FUNCTION "project_coordinator_pointer_guard"();

COMMENT ON FUNCTION "project_coordinator_pointer_guard"() IS
  'Contract §7.5/§12.4: which session a project may name as its coordinator, enforced for every writer.';
