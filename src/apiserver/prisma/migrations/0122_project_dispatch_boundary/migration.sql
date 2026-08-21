-- Project Coordinator dispatch is a separate authority from the legacy Task List sweeps. The
-- database owns the hand-off so a rolled-back apiserver cannot keep dispatching after a Project
-- is enabled, and every entry point shares one task-level execution claim.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE "task_dispatch_authority" AS ENUM ('LEGACY', 'COORDINATOR');
CREATE TYPE "session_dispatch_origin" AS ENUM ('USER', 'PROJECT_COORDINATOR', 'LEGACY_SWEEP');
CREATE TYPE "session_run_source" AS ENUM ('MANUAL', 'TASK_LIST_AUTO', 'PROJECT_COORDINATOR');

ALTER TABLE "runner"
  ADD COLUMN "capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "capabilities_reported_at" TIMESTAMPTZ;

ALTER TABLE "task"
  ADD COLUMN "dispatch_authority" "task_dispatch_authority" NOT NULL DEFAULT 'LEGACY',
  ADD COLUMN "dispatch_attempt" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "required_capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "session"
  ADD COLUMN "project_action_id" UUID,
  -- LEGACY_SWEEP is deliberate: an old binary omits the column and therefore fails closed after
  -- authority moves to the Project Coordinator. New manual entry points explicitly write USER.
  ADD COLUMN "dispatch_origin" "session_dispatch_origin" NOT NULL DEFAULT 'LEGACY_SWEEP',
  ADD COLUMN "run_source" "session_run_source" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "resolution" JSONB,
  ADD COLUMN "snapshot_frozen_at" TIMESTAMPTZ,
  ADD COLUMN "required_capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "execution_pin_generation" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "project_action"
  ADD COLUMN "execution_context" JSONB,
  ADD COLUMN "execution_context_digest" CHAR(64),
  ADD COLUMN "execution_result_digest" CHAR(64),
  ADD COLUMN "reason_code" TEXT;

ALTER TABLE "session"
  ADD CONSTRAINT "session_project_action_id_fkey"
  FOREIGN KEY ("project_action_id") REFERENCES "project_action"("id")
  ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "project_action"
  ADD CONSTRAINT "project_action_result_session_id_fkey"
  FOREIGN KEY ("result_session_id") REFERENCES "session"("id")
  ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

CREATE UNIQUE INDEX "session_project_action_id_key"
  ON "session"("project_action_id") WHERE "project_action_id" IS NOT NULL;
CREATE UNIQUE INDEX "project_action_result_session_id_key"
  ON "project_action"("result_session_id") WHERE "result_session_id" IS NOT NULL;

-- Make the projection true before installing its maintainers. Existing Projects remain inert
-- because all pre-0111 rows were migrated with coordinator_enabled=false.
UPDATE "task" t
   SET "dispatch_authority" = CASE
       WHEN p."coordinator_enabled" THEN 'COORDINATOR'::"task_dispatch_authority"
       ELSE 'LEGACY'::"task_dispatch_authority" END
  FROM "project" p
 WHERE p."id" = t."project_id";

CREATE OR REPLACE FUNCTION "task_dispatch_authority_derive"() RETURNS trigger AS $$
DECLARE enabled boolean;
BEGIN
  IF NEW."project_id" IS NULL THEN
    NEW."dispatch_authority" := 'LEGACY';
    RETURN NEW;
  END IF;
  SELECT p."coordinator_enabled" INTO enabled
    FROM "project" p WHERE p."id" = NEW."project_id";
  NEW."dispatch_authority" := CASE WHEN COALESCE(enabled, false)
    THEN 'COORDINATOR'::"task_dispatch_authority"
    ELSE 'LEGACY'::"task_dispatch_authority" END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_dispatch_authority_derive"
  BEFORE INSERT OR UPDATE OF "project_id", "dispatch_authority" ON "task"
  FOR EACH ROW EXECUTE FUNCTION "task_dispatch_authority_derive"();

CREATE OR REPLACE FUNCTION "project_dispatch_authority_fanout"() RETURNS trigger AS $$
BEGIN
  IF NEW."coordinator_enabled" IS DISTINCT FROM OLD."coordinator_enabled" THEN
    UPDATE "task"
       SET "dispatch_authority" = CASE WHEN NEW."coordinator_enabled"
           THEN 'COORDINATOR'::"task_dispatch_authority"
           ELSE 'LEGACY'::"task_dispatch_authority" END
     WHERE "project_id" = NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "project_dispatch_authority_fanout"
  AFTER UPDATE OF "coordinator_enabled" ON "project"
  FOR EACH ROW EXECUTE FUNCTION "project_dispatch_authority_fanout"();

-- An edge has no updated_at of its own. Touching its dependent Task gives the decision snapshot a
-- row it can lock and a version it can compare, so a dependency inserted/deleted concurrently
-- with dispatch either lands before the commit-time recheck or waits until after the Session.
CREATE OR REPLACE FUNCTION "task_dependency_dispatch_touch"() RETURNS trigger AS $$
BEGIN
  UPDATE "task" SET "updated_at" = CURRENT_TIMESTAMP
   WHERE "id" IN (
     CASE WHEN TG_OP = 'DELETE' THEN OLD."task_id" ELSE NEW."task_id" END,
     CASE WHEN TG_OP = 'UPDATE' THEN OLD."task_id" ELSE NULL END
   );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_dependency_dispatch_touch"
  AFTER INSERT OR UPDATE OR DELETE ON "task_dependency"
  FOR EACH ROW EXECUTE FUNCTION "task_dependency_dispatch_touch"();

-- Reconcile pre-existing duplicate live claims before the unique linearization primitive is
-- installed. Keep the newest run; older duplicates become visible terminal history.
DO $$
DECLARE reconciled integer;
BEGIN
  WITH ranked AS (
    SELECT s."id", row_number() OVER (
      PARTITION BY s."task_id" ORDER BY s."created_at" DESC, s."id" DESC
    ) AS n
      FROM "session" s
     WHERE s."task_id" IS NOT NULL AND s."deleted_at" IS NULL
       AND s."status" IN ('PENDING', 'RUNNING')
  )
  UPDATE "session" s
     SET "status" = 'CANCELLED', "finished_at" = COALESCE(s."finished_at", CURRENT_TIMESTAMP),
         "end_reason" = 'duplicate_live_session_reconciled', "updated_at" = CURRENT_TIMESTAMP
    FROM ranked r WHERE r."id" = s."id" AND r.n > 1;
  GET DIAGNOSTICS reconciled = ROW_COUNT;
  RAISE NOTICE '0122 reconciled % duplicate live task session(s)', reconciled;
END;
$$;

CREATE UNIQUE INDEX "session_task_execution_claim_idx" ON "session"("task_id")
 WHERE "task_id" IS NOT NULL AND "deleted_at" IS NULL
   AND "status" IN ('PENDING', 'RUNNING');

-- The insert-time authority gate. FOR SHARE makes an authority flip and a Session insert line up
-- on the Task row instead of observing one another through stale MVCC snapshots.
CREATE OR REPLACE FUNCTION "session_dispatch_authority_guard"() RETURNS trigger AS $$
DECLARE
  authority "task_dispatch_authority";
  task_project UUID;
  task_owner UUID;
BEGIN
  IF NEW."task_id" IS NULL THEN
    IF NEW."dispatch_origin" = 'PROJECT_COORDINATOR' OR NEW."project_action_id" IS NOT NULL THEN
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

CREATE TRIGGER "session_dispatch_authority_guard"
  BEFORE INSERT ON "session"
  FOR EACH ROW EXECUTE FUNCTION "session_dispatch_authority_guard"();

-- Project/Agent admission counts Session rows, so changes that enter or leave that counted set
-- must serialize with the Project row lock used by the authorization adapter. The harmless
-- updated_at write also makes an RR waiter restart with a post-change snapshot.
CREATE OR REPLACE FUNCTION "session_project_capacity_serialize"() RETURNS trigger AS $$
DECLARE old_live boolean; new_live boolean;
BEGIN
  old_live := TG_OP <> 'INSERT' AND OLD."task_id" IS NOT NULL
    AND OLD."deleted_at" IS NULL AND OLD."status" IN ('PENDING', 'RUNNING');
  new_live := TG_OP <> 'DELETE' AND NEW."task_id" IS NOT NULL
    AND NEW."deleted_at" IS NULL AND NEW."status" IN ('PENDING', 'RUNNING');
  IF TG_OP = 'UPDATE' AND old_live = new_live
     AND OLD."task_id" IS NOT DISTINCT FROM NEW."task_id" THEN
    RETURN NEW;
  END IF;
  UPDATE "project" SET "updated_at" = CURRENT_TIMESTAMP
   WHERE "id" IN (
     SELECT "project_id" FROM "task"
      WHERE "id" IN (
        CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD."task_id" END,
        CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW."task_id" END
      ) AND "project_id" IS NOT NULL
   );
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "session_project_capacity_serialize_insert_delete"
  BEFORE INSERT OR DELETE ON "session"
  FOR EACH ROW EXECUTE FUNCTION "session_project_capacity_serialize"();
CREATE TRIGGER "session_project_capacity_serialize_update"
  BEFORE UPDATE OF "status", "task_id", "deleted_at" ON "session"
  FOR EACH ROW EXECUTE FUNCTION "session_project_capacity_serialize"();

ALTER TABLE "session"
  ADD CONSTRAINT "session_action_only_for_coordinator_chk"
  CHECK ("dispatch_origin" = 'PROJECT_COORDINATOR' OR "project_action_id" IS NULL),
  ADD CONSTRAINT "session_coordinator_source_chk"
  CHECK (("dispatch_origin" = 'PROJECT_COORDINATOR') = ("run_source" = 'PROJECT_COORDINATOR')),
  ADD CONSTRAINT "session_coordinator_snapshot_chk"
  CHECK ("dispatch_origin" <> 'PROJECT_COORDINATOR' OR
    ("project_action_id" IS NOT NULL AND "resolution" IS NOT NULL
     AND "snapshot_frozen_at" IS NOT NULL));

-- Canonical enough for jsonb protocol objects: PostgreSQL stores object keys in deterministic
-- order and jsonb::text has one representation. Both application and database use this exact
-- function as the digest oracle, avoiding two subtly different serializers.
CREATE OR REPLACE FUNCTION "coordinator_json_digest"(value jsonb) RETURNS text AS $$
  SELECT encode(digest(COALESCE(value, 'null'::jsonb)::text, 'sha256'), 'hex')
$$ LANGUAGE sql IMMUTABLE STRICT;

CREATE OR REPLACE FUNCTION "session_coordinator_snapshot_guard"() RETURNS trigger AS $$
DECLARE ctx jsonb; auth_digest text; result_digest text;
BEGIN
  IF NEW."dispatch_origin" <> 'PROJECT_COORDINATOR' THEN RETURN NEW; END IF;
  SELECT a."execution_context", a."execution_context_digest", a."execution_result_digest"
    INTO ctx, auth_digest, result_digest
    FROM "project_action" a WHERE a."id" = NEW."project_action_id";
  IF ctx IS NULL OR ctx->'authorization' IS NULL OR ctx->'result' IS NULL
     OR auth_digest IS DISTINCT FROM "coordinator_json_digest"(ctx->'authorization')
     OR result_digest IS DISTINCT FROM "coordinator_json_digest"(ctx - 'authorization') THEN
    RAISE EXCEPTION 'EXECUTION_CONTEXT_INVALID: action % has no valid frozen context', NEW."project_action_id";
  END IF;
  IF ctx->'result'->>'provider' IS DISTINCT FROM NEW."provider"
     OR (ctx->'result'->>'model') IS DISTINCT FROM NEW."model"
     OR (ctx->'result'->>'workspaceId')::uuid IS DISTINCT FROM NEW."workspace_id"
     OR (ctx->'result'->>'runnerId')::uuid IS DISTINCT FROM NEW."assigned_runner_id"
     OR (ctx->'result'->>'permissionMode') IS DISTINCT FROM NEW."permission_mode"
     OR COALESCE(ARRAY(SELECT jsonb_array_elements_text(ctx->'result'->'requiredCapabilities')),
                      ARRAY[]::text[]) IS DISTINCT FROM NEW."required_capabilities"
     OR ctx->'result'->'resolution' IS DISTINCT FROM NEW."resolution" THEN
    RAISE EXCEPTION 'EXECUTION_RESULT_CHANGED: session % differs from action %', NEW."id", NEW."project_action_id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "session_coordinator_snapshot_guard"
  BEFORE INSERT ON "session"
  FOR EACH ROW EXECUTE FUNCTION "session_coordinator_snapshot_guard"();

CREATE OR REPLACE FUNCTION "session_coordinator_snapshot_immutable"() RETURNS trigger AS $$
BEGIN
  IF OLD."dispatch_origin" = 'PROJECT_COORDINATOR' AND (
       NEW."task_id" IS DISTINCT FROM OLD."task_id"
    OR NEW."project_action_id" IS DISTINCT FROM OLD."project_action_id"
    OR NEW."dispatch_origin" IS DISTINCT FROM OLD."dispatch_origin"
    OR NEW."run_source" IS DISTINCT FROM OLD."run_source"
    OR NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
    OR NEW."assigned_runner_id" IS DISTINCT FROM OLD."assigned_runner_id"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."provider_builtin" IS DISTINCT FROM OLD."provider_builtin"
    OR NEW."permission_mode" IS DISTINCT FROM OLD."permission_mode"
    OR NEW."resolution" IS DISTINCT FROM OLD."resolution"
    OR NEW."snapshot_frozen_at" IS DISTINCT FROM OLD."snapshot_frozen_at"
    OR NEW."required_capabilities" IS DISTINCT FROM OLD."required_capabilities"
  ) THEN
    RAISE EXCEPTION 'EXECUTION_SNAPSHOT_FROZEN: coordinator session %', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "session_coordinator_snapshot_immutable"
  BEFORE UPDATE ON "session"
  FOR EACH ROW EXECUTE FUNCTION "session_coordinator_snapshot_immutable"();

-- The final-state half of attribution: a CLAIMED action may precede the Session insert, but the
-- transaction may commit only after the action is APPLIED and both links point at one another.
CREATE OR REPLACE FUNCTION "session_dispatch_attribution_check"() RETURNS trigger AS $$
DECLARE s "session"%ROWTYPE;
BEGIN
  SELECT * INTO s FROM "session" WHERE "id" = NEW."id";
  IF NOT FOUND OR s."dispatch_origin" <> 'PROJECT_COORDINATOR' THEN RETURN NULL; END IF;
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

CREATE CONSTRAINT TRIGGER "session_dispatch_attribution_check"
  AFTER INSERT ON "session" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "session_dispatch_attribution_check"();

CREATE OR REPLACE FUNCTION "project_action_dispatch_result_check"() RETURNS trigger AS $$
DECLARE a "project_action"%ROWTYPE;
BEGIN
  SELECT * INTO a FROM "project_action" WHERE "id" = NEW."id";
  IF NOT FOUND OR a."type" <> 'DISPATCH_TASK' THEN RETURN NULL; END IF;
  IF a."status" = 'APPLIED' AND NOT EXISTS (
    SELECT 1 FROM "session" s WHERE s."id" = a."result_session_id"
      AND s."project_action_id" = a."id" AND s."dispatch_origin" = 'PROJECT_COORDINATOR'
      AND s."task_id" = a."subject_id"
  ) THEN
    RAISE EXCEPTION 'DISPATCH_RESULT_LINK_VIOLATION: applied action % has no owned session', a."id";
  END IF;
  IF a."status" IN ('REFUSED', 'SUPERSEDED') AND a."result_session_id" IS NOT NULL THEN
    RAISE EXCEPTION 'DISPATCH_RESULT_LINK_VIOLATION: non-applied action % carries a session', a."id";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "project_action_dispatch_result_check"
  AFTER INSERT OR UPDATE OF "status", "result_session_id" ON "project_action"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "project_action_dispatch_result_check"();

-- Once published, action identity, outcome and frozen resolution are history. detail remains the
-- append surface for later claim-time pin evidence; task 13 never rewrites it after publication.
CREATE OR REPLACE FUNCTION "project_action_dispatch_immutable"() RETURNS trigger AS $$
BEGIN
  IF OLD."type" <> 'DISPATCH_TASK' THEN RETURN NEW; END IF;
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

CREATE TRIGGER "project_action_dispatch_immutable"
  BEFORE UPDATE ON "project_action"
  FOR EACH ROW EXECUTE FUNCTION "project_action_dispatch_immutable"();

-- Moving a live task would sever action-to-Project attribution. Wait for/cancel the run first.
CREATE OR REPLACE FUNCTION "task_claimed_project_move_guard"() RETURNS trigger AS $$
BEGIN
  IF NEW."project_id" IS DISTINCT FROM OLD."project_id" AND EXISTS (
    SELECT 1 FROM "session" s WHERE s."task_id" = NEW."id" AND s."deleted_at" IS NULL
      AND s."status" IN ('PENDING', 'RUNNING')
  ) THEN
    RAISE EXCEPTION 'TASK_CLAIMED_PROJECT_MOVE: task % has a live execution claim', NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_claimed_project_move_guard"
  BEFORE UPDATE OF "project_id" ON "task"
  FOR EACH ROW EXECUTE FUNCTION "task_claimed_project_move_guard"();

COMMENT ON COLUMN "session"."run_source" IS
  'Auditable start provenance: MANUAL, TASK_LIST_AUTO, or PROJECT_COORDINATOR.';
COMMENT ON COLUMN "task"."dispatch_authority" IS
  'Database-derived mixed-version dispatch authority; never a user policy setting.';
