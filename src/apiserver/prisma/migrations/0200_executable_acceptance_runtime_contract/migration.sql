-- EXECUTABLE completion runtime v2: admission is a pre-spawn decision; attempts and their typed
-- terminations are separate append-only facts. Historical -1 observations remain explicitly
-- UNTYPED and are never converted into a typed process termination by this migration.

CREATE TYPE "executable_acceptance_admission_decision" AS ENUM ('ADMITTED', 'REJECTED');
CREATE TYPE "executable_acceptance_termination_kind" AS ENUM
  ('EXITED', 'TIMED_OUT', 'CANCELLED', 'SIGNALED', 'START_FAILED', 'INFRASTRUCTURE_LOST');
CREATE TYPE "executable_acceptance_legacy_termination" AS ENUM ('UNTYPED');
CREATE TYPE "executable_acceptance_continuation_kind" AS ENUM ('RETRY', 'DIAGNOSIS', 'SUCCESSOR');

ALTER TABLE "runner"
  ADD COLUMN "acceptance_runtime_schema_revision" integer,
  ADD COLUMN "acceptance_runtime_capability_revision" integer,
  ADD COLUMN "acceptance_runtime_hard_max_seconds" integer,
  ADD COLUMN "acceptance_runtime_reported_at" timestamptz;

ALTER TABLE "runner" ADD CONSTRAINT "runner_acceptance_runtime_shape_check" CHECK (
  (
    "acceptance_runtime_schema_revision" IS NULL
    AND "acceptance_runtime_capability_revision" IS NULL
    AND "acceptance_runtime_hard_max_seconds" IS NULL
    AND "acceptance_runtime_reported_at" IS NULL
  ) OR (
    "acceptance_runtime_schema_revision" > 0
    AND "acceptance_runtime_capability_revision" > 0
    AND "acceptance_runtime_hard_max_seconds" > 0
    AND "acceptance_runtime_reported_at" IS NOT NULL
  )
);

ALTER TABLE "task"
  ADD COLUMN "acceptance_timeout_seconds" integer,
  ADD COLUMN "acceptance_owner_timeout_ceiling_seconds" integer,
  ADD COLUMN "acceptance_policy_timeout_ceiling_seconds" integer,
  ADD COLUMN "acceptance_schema_revision" integer,
  ADD COLUMN "acceptance_capability_revision" integer,
  ADD COLUMN "acceptance_command_digest" char(64),
  ADD COLUMN "acceptance_evaluation_plan_digest" char(64),
  ADD COLUMN "execution_attempt_count" integer NOT NULL DEFAULT 0;

ALTER TABLE "task" ADD CONSTRAINT "task_executable_runtime_shape_check" CHECK (
  (
    "acceptance_timeout_seconds" IS NULL
    AND "acceptance_owner_timeout_ceiling_seconds" IS NULL
    AND "acceptance_policy_timeout_ceiling_seconds" IS NULL
    AND "acceptance_schema_revision" IS NULL
    AND "acceptance_capability_revision" IS NULL
    AND "acceptance_command_digest" IS NULL
    AND "acceptance_evaluation_plan_digest" IS NULL
  ) OR (
    "completion_criterion" = 'EXECUTABLE'
    AND "acceptance_command" IS NOT NULL
    AND "acceptance_expected_exit_code" IS NOT NULL
    AND "acceptance_timeout_seconds" > 0
    AND "acceptance_timeout_seconds" <= 86400
    AND "acceptance_owner_timeout_ceiling_seconds" > 0
    AND "acceptance_policy_timeout_ceiling_seconds" > 0
    AND "acceptance_schema_revision" > 0
    AND "acceptance_capability_revision" > 0
    AND "acceptance_command_digest" ~ '^[0-9a-f]{64}$'
    AND "acceptance_evaluation_plan_digest" ~ '^[0-9a-f]{64}$'
  )
);

ALTER TABLE "task" ADD CONSTRAINT "task_execution_attempt_count_check"
  CHECK ("execution_attempt_count" >= 0);

CREATE OR REPLACE FUNCTION executable_acceptance_plan_digest(
  p_schema_revision integer,
  p_capability_revision integer,
  p_command_digest text,
  p_expected_exit_code integer,
  p_requested_timeout_seconds integer,
  p_owner_ceiling_seconds integer,
  p_policy_ceiling_seconds integer
) RETURNS char(64) LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT encode(digest(
    concat(
      'schemaRevision=', p_schema_revision, E'\n',
      'capabilityRevision=', p_capability_revision, E'\n',
      'commandDigest=', p_command_digest, E'\n',
      'expectedExitCode=', p_expected_exit_code, E'\n',
      'requestedTimeoutSeconds=', p_requested_timeout_seconds, E'\n',
      'ownerTimeoutCeilingSeconds=', p_owner_ceiling_seconds, E'\n',
      'policyTimeoutCeilingSeconds=', p_policy_ceiling_seconds
    ), 'sha256'
  ), 'hex')::char(64)
$$;

CREATE OR REPLACE FUNCTION task_executable_plan_bind() RETURNS trigger AS $$
BEGIN
  IF NEW."acceptance_timeout_seconds" IS NULL THEN
    NEW."acceptance_owner_timeout_ceiling_seconds" := NULL;
    NEW."acceptance_policy_timeout_ceiling_seconds" := NULL;
    NEW."acceptance_schema_revision" := NULL;
    NEW."acceptance_capability_revision" := NULL;
    NEW."acceptance_command_digest" := NULL;
    NEW."acceptance_evaluation_plan_digest" := NULL;
    RETURN NEW;
  END IF;
  IF NEW."acceptance_command" IS NULL OR NEW."acceptance_expected_exit_code" IS NULL
     OR NEW."acceptance_owner_timeout_ceiling_seconds" IS NULL
     OR NEW."acceptance_policy_timeout_ceiling_seconds" IS NULL
     OR NEW."acceptance_schema_revision" IS NULL
     OR NEW."acceptance_capability_revision" IS NULL THEN
    RAISE EXCEPTION 'EXECUTABLE_ACCEPTANCE_PLAN_INCOMPLETE: timeout-bound plans require command, expected exit, both ceilings, schema and capability revision'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW."acceptance_command_digest" := encode(digest(NEW."acceptance_command", 'sha256'), 'hex');
  NEW."acceptance_evaluation_plan_digest" := executable_acceptance_plan_digest(
    NEW."acceptance_schema_revision",
    NEW."acceptance_capability_revision",
    NEW."acceptance_command_digest",
    NEW."acceptance_expected_exit_code",
    NEW."acceptance_timeout_seconds",
    NEW."acceptance_owner_timeout_ceiling_seconds",
    NEW."acceptance_policy_timeout_ceiling_seconds"
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_executable_plan_bind"
  BEFORE INSERT OR UPDATE OF
    "completion_criterion", "acceptance_command", "acceptance_expected_exit_code",
    "acceptance_timeout_seconds", "acceptance_owner_timeout_ceiling_seconds",
    "acceptance_policy_timeout_ceiling_seconds", "acceptance_schema_revision",
    "acceptance_capability_revision"
  ON "task" FOR EACH ROW EXECUTE FUNCTION task_executable_plan_bind();

CREATE TABLE "task_executable_admission" (
  "id" uuid PRIMARY KEY,
  "task_id" uuid NOT NULL REFERENCES "task"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL REFERENCES "session"("id") ON DELETE CASCADE,
  "turn_id" uuid NOT NULL UNIQUE,
  "runner_id" uuid NOT NULL REFERENCES "runner"("id") ON DELETE RESTRICT,
  "evaluation_plan_digest" char(64) NOT NULL CHECK ("evaluation_plan_digest" ~ '^[0-9a-f]{64}$'),
  "command_digest" char(64) NOT NULL CHECK ("command_digest" ~ '^[0-9a-f]{64}$'),
  "expected_exit_code" integer NOT NULL,
  "requested_timeout_seconds" integer NOT NULL CHECK ("requested_timeout_seconds" > 0),
  "owner_timeout_ceiling_seconds" integer NOT NULL CHECK ("owner_timeout_ceiling_seconds" > 0),
  "policy_timeout_ceiling_seconds" integer NOT NULL CHECK ("policy_timeout_ceiling_seconds" > 0),
  "required_schema_revision" integer NOT NULL CHECK ("required_schema_revision" > 0),
  "required_capability_revision" integer NOT NULL CHECK ("required_capability_revision" > 0),
  "runner_schema_revision" integer,
  "runner_capability_revision" integer,
  "runner_hard_max_seconds" integer,
  "runner_sha" text,
  "decision" "executable_acceptance_admission_decision" NOT NULL,
  "rejection_code" text,
  "effective_timeout_seconds" integer,
  "effective_deadline" timestamptz,
  "spawn_count" integer NOT NULL DEFAULT 0,
  "decided_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "task_executable_admission_decision_shape_check" CHECK (
    (
      "decision" = 'ADMITTED'
      AND "rejection_code" IS NULL
      AND "effective_timeout_seconds" = "requested_timeout_seconds"
      AND "effective_deadline" IS NOT NULL
      AND "runner_schema_revision" = "required_schema_revision"
      AND "runner_capability_revision" >= "required_capability_revision"
      AND "runner_hard_max_seconds" >= "requested_timeout_seconds"
    ) OR (
      "decision" = 'REJECTED'
      AND "rejection_code" IS NOT NULL
      AND "effective_timeout_seconds" IS NULL
      AND "effective_deadline" IS NULL
      AND "spawn_count" = 0
    )
  ),
  CONSTRAINT "task_executable_admission_spawn_count_check" CHECK ("spawn_count" IN (0, 1))
);

CREATE INDEX "task_executable_admission_task_idx"
  ON "task_executable_admission"("task_id", "decided_at" DESC);
CREATE INDEX "task_executable_admission_decision_idx"
  ON "task_executable_admission"("decision", "decided_at" DESC);

CREATE TABLE "task_executable_attempt" (
  "id" uuid PRIMARY KEY,
  "admission_id" uuid UNIQUE REFERENCES "task_executable_admission"("id") ON DELETE RESTRICT,
  "task_id" uuid NOT NULL REFERENCES "task"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL REFERENCES "session"("id") ON DELETE CASCADE,
  "turn_id" uuid,
  "attempt_number" integer NOT NULL DEFAULT 0,
  "evaluation_plan_digest" char(64),
  "expected_exit_code" integer,
  "deadline_at" timestamptz,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "terminated_at" timestamptz,
  "termination_kind" "executable_acceptance_termination_kind",
  "actual_exit_code" integer,
  "signal" text,
  "raw_output" text,
  "output_truncated" boolean NOT NULL DEFAULT false,
  "failure_fingerprint" char(64),
  "legacy_termination" "executable_acceptance_legacy_termination",
  "legacy_exit_code" integer,
  CONSTRAINT "task_executable_attempt_number_key" UNIQUE ("task_id", "attempt_number"),
  CONSTRAINT "task_executable_attempt_digest_check" CHECK (
    ("evaluation_plan_digest" IS NULL OR "evaluation_plan_digest" ~ '^[0-9a-f]{64}$')
    AND ("failure_fingerprint" IS NULL OR "failure_fingerprint" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "task_executable_attempt_origin_shape_check" CHECK (
    (
      "admission_id" IS NOT NULL
      AND "legacy_termination" IS NULL
      AND "legacy_exit_code" IS NULL
      AND "evaluation_plan_digest" IS NOT NULL
      AND "expected_exit_code" IS NOT NULL
      AND "deadline_at" IS NOT NULL
    ) OR (
      "admission_id" IS NULL
      AND "termination_kind" IS NULL
      AND "legacy_termination" = 'UNTYPED'
      AND "legacy_exit_code" IS NOT NULL
    )
  ),
  CONSTRAINT "task_executable_attempt_termination_shape_check" CHECK (
    ("termination_kind" IS NULL AND "terminated_at" IS NULL)
    OR (
      "termination_kind" IS NOT NULL
      AND "terminated_at" IS NOT NULL
      AND (
        ("termination_kind" = 'EXITED' AND "actual_exit_code" IS NOT NULL)
        OR ("termination_kind" <> 'EXITED' AND "actual_exit_code" IS NULL)
      )
    )
  )
);

CREATE INDEX "task_executable_attempt_stale_idx"
  ON "task_executable_attempt"("terminated_at", "deadline_at");
CREATE INDEX "task_executable_attempt_session_idx"
  ON "task_executable_attempt"("session_id", "started_at" DESC);

CREATE OR REPLACE FUNCTION task_executable_attempt_start_guard() RETURNS trigger AS $$
DECLARE admission_row "task_executable_admission"%ROWTYPE; next_attempt integer;
BEGIN
  IF NEW."admission_id" IS NULL THEN
    -- Honest legacy import: it creates no new execution and therefore spends no current budget.
    IF NEW."legacy_termination" <> 'UNTYPED' OR NEW."termination_kind" IS NOT NULL THEN
      RAISE EXCEPTION 'EXECUTABLE_LEGACY_ATTEMPT_INVALID: legacy imports remain UNTYPED';
    END IF;
    -- Negative audit ordinals cannot collide with the positive v2 executionAttemptCount lane.
    SELECT COALESCE(MIN("attempt_number") FILTER (WHERE "attempt_number" < 0), 0) - 1
      INTO NEW."attempt_number"
      FROM "task_executable_attempt" WHERE "task_id" = NEW."task_id";
    RETURN NEW;
  END IF;

  -- Parent before child: spend the Task budget while holding the same rank-50 mutex used by
  -- completion, then serialize this admission at rank 60. Locking the admission first would add
  -- a child -> Task wait edge opposite to turnComplete's Task -> attempt edge.
  PERFORM 1 FROM "task" WHERE "id" = NEW."task_id" FOR UPDATE;
  SELECT * INTO admission_row FROM "task_executable_admission"
   WHERE "id" = NEW."admission_id" FOR UPDATE;
  IF NOT FOUND OR admission_row."decision" <> 'ADMITTED' THEN
    RAISE EXCEPTION 'EXECUTABLE_ATTEMPT_NOT_ADMITTED: rejected or missing admission cannot spawn'
      USING ERRCODE = 'check_violation';
  END IF;
  IF admission_row."task_id" <> NEW."task_id"
     OR admission_row."session_id" <> NEW."session_id"
     OR admission_row."turn_id" IS DISTINCT FROM NEW."turn_id"
     OR admission_row."evaluation_plan_digest" <> NEW."evaluation_plan_digest" THEN
    RAISE EXCEPTION 'EXECUTABLE_ATTEMPT_BINDING_MISMATCH: attempt does not match its admission'
      USING ERRCODE = 'check_violation';
  END IF;
  IF admission_row."spawn_count" <> 0 THEN
    RAISE EXCEPTION 'EXECUTABLE_ATTEMPT_ALREADY_STARTED: admission has already crossed spawn';
  END IF;
  UPDATE "task_executable_admission" SET "spawn_count" = 1 WHERE "id" = admission_row."id";
  UPDATE "task" SET "execution_attempt_count" = "execution_attempt_count" + 1
   WHERE "id" = NEW."task_id" RETURNING "execution_attempt_count" INTO next_attempt;
  NEW."attempt_number" := next_attempt;
  NEW."expected_exit_code" := admission_row."expected_exit_code";
  NEW."deadline_at" := admission_row."effective_deadline";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_executable_attempt_start_guard"
  BEFORE INSERT ON "task_executable_attempt"
  FOR EACH ROW EXECUTE FUNCTION task_executable_attempt_start_guard();

CREATE OR REPLACE FUNCTION task_executable_admission_immutable_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."spawn_count" = 1 AND OLD."spawn_count" = 0
     AND to_jsonb(NEW) - 'spawn_count' = to_jsonb(OLD) - 'spawn_count' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'task executable admission is immutable except for its one start transition';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_executable_admission_immutable_guard"
  BEFORE UPDATE OR DELETE ON "task_executable_admission"
  FOR EACH ROW EXECUTE FUNCTION task_executable_admission_immutable_guard();

CREATE OR REPLACE FUNCTION task_executable_attempt_termination_guard() RETURNS trigger AS $$
BEGIN
  IF OLD."legacy_termination" IS NOT NULL THEN
    RAISE EXCEPTION 'legacy executable attempt is immutable and may not receive a typed termination';
  END IF;
  IF OLD."terminated_at" IS NOT NULL OR OLD."termination_kind" IS NOT NULL THEN
    RAISE EXCEPTION 'task executable attempt termination is append-only';
  END IF;
  IF NEW."termination_kind" IS NULL OR NEW."terminated_at" IS NULL THEN
    RAISE EXCEPTION 'task executable attempt update must append one complete termination';
  END IF;
  IF to_jsonb(NEW) - ARRAY['terminated_at','termination_kind','actual_exit_code','signal',
       'raw_output','output_truncated','failure_fingerprint']
     <> to_jsonb(OLD) - ARRAY['terminated_at','termination_kind','actual_exit_code','signal',
       'raw_output','output_truncated','failure_fingerprint'] THEN
    RAISE EXCEPTION 'task executable attempt identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_executable_attempt_termination_guard"
  BEFORE UPDATE ON "task_executable_attempt"
  FOR EACH ROW EXECUTE FUNCTION task_executable_attempt_termination_guard();
CREATE TRIGGER "task_executable_attempt_no_delete"
  BEFORE DELETE ON "task_executable_attempt"
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();

-- Revision 2's typed attempt is itself a canonical completion fact. Extend the pre-existing DONE
-- writer fence without weakening its other lanes: only an ADMITTED, digest-bound EXITED fact whose
-- actual exit equals the task's current expected exit can authorize the optimistic transition.
-- A timeout, cancellation, signal, start failure, infrastructure loss, legacy -1, stale plan, or
-- non-matching exit remains incapable of making this branch canonical.
CREATE OR REPLACE FUNCTION "task_done_canonical_writer_fence"() RETURNS trigger AS $$
DECLARE
  canonical boolean := false;
BEGIN
  IF NEW."completion_fence_revision" < OLD."completion_fence_revision" THEN
    RAISE EXCEPTION 'TASK_COMPLETION_FENCE_REVISION_DOWNGRADE'
      USING ERRCODE = 'P0001',
            DETAIL = 'a fenced task cannot be returned to a legacy writer cohort';
  END IF;
  IF NEW."completion_fence_revision" < 1
     OR NEW."status" <> 'DONE'::"task_status"
     OR OLD."status" = 'DONE'::"task_status" THEN
    RETURN NEW;
  END IF;

  IF NEW."verifies_task_id" IS NOT NULL AND NEW."verdict" IS NOT NULL THEN
    canonical := true;
  END IF;

  IF NOT canonical
     AND NEW."completion_criterion" = 'EXECUTABLE'
     AND NEW."acceptance_evaluation_plan_digest" IS NOT NULL
     AND NEW."acceptance_command_digest" IS NOT NULL
     AND NEW."acceptance_expected_exit_code" IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM "task_executable_attempt" attempt
         JOIN "task_executable_admission" admission
           ON admission."id" = attempt."admission_id"
        WHERE attempt."task_id" = NEW."id"
          AND attempt."evaluation_plan_digest" = NEW."acceptance_evaluation_plan_digest"
          AND attempt."expected_exit_code" = NEW."acceptance_expected_exit_code"
          AND attempt."termination_kind" = 'EXITED'
          AND attempt."actual_exit_code" = NEW."acceptance_expected_exit_code"
          AND attempt."terminated_at" IS NOT NULL
          AND attempt."legacy_termination" IS NULL
          AND admission."decision" = 'ADMITTED'
          AND admission."evaluation_plan_digest" = NEW."acceptance_evaluation_plan_digest"
          AND admission."command_digest" = NEW."acceptance_command_digest"
          AND admission."expected_exit_code" = NEW."acceptance_expected_exit_code"
     ) THEN
    canonical := true;
  END IF;

  IF NOT canonical AND EXISTS (
    SELECT 1
      FROM "task_judgment_request" request
     WHERE request."task_id" = NEW."id"
       AND request."owner_id" = NEW."owner_id"
       AND request."kind" = NEW."completion_criterion"
       AND request."status" = 'DECIDED'::"task_judgment_request_status"
       AND request."decision" = 'PASS'::"task_judgment_decision"
  ) THEN
    canonical := true;
  END IF;

  IF NOT canonical AND NEW."completion_policy" = 'ALL_CHILDREN_DONE'::"task_completion_policy"
     AND EXISTS (
       SELECT 1 FROM "task" child
        WHERE child."parent_task_id" = NEW."id" AND child."status" = 'DONE'::"task_status"
     )
     AND NOT EXISTS (
       SELECT 1 FROM "task" child
        WHERE child."parent_task_id" = NEW."id"
          AND child."status" NOT IN ('DONE'::"task_status", 'CANCELLED'::"task_status")
     ) THEN
    canonical := true;
  END IF;

  IF NOT canonical AND NEW."completion_policy" = 'VERIFICATION_PASSED'::"task_completion_policy"
     AND EXISTS (
       SELECT 1 FROM "task" verifier
        WHERE verifier."verifies_task_id" = NEW."id"
          AND verifier."verdict" = 'PASS'::"task_verdict"
          AND verifier."terminal_reason" IS NULL
          AND verifier."superseded_by_task_id" IS NULL
     ) THEN
    canonical := true;
  END IF;

  IF NOT canonical THEN
    RAISE EXCEPTION 'TASK_DONE_CANONICAL_FACT_REQUIRED'
      USING ERRCODE = 'P0001',
            DETAIL = 'status=DONE is a projection of the declared completion fact, not a writer input',
            HINT = 'record the executable result, verification verdict, or human signoff event';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE "task_executable_continuation" (
  "id" uuid PRIMARY KEY,
  "task_id" uuid NOT NULL REFERENCES "task"("id") ON DELETE CASCADE,
  "attempt_id" uuid NOT NULL UNIQUE REFERENCES "task_executable_attempt"("id") ON DELETE CASCADE,
  "kind" "executable_acceptance_continuation_kind" NOT NULL,
  "reason_code" text NOT NULL,
  "goal_actionable" boolean NOT NULL DEFAULT true CHECK ("goal_actionable"),
  "status" text NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE', 'RESOLVED')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "resolved_at" timestamptz,
  CHECK (("status" = 'ACTIVE' AND "resolved_at" IS NULL)
      OR ("status" = 'RESOLVED' AND "resolved_at" IS NOT NULL))
);
CREATE INDEX "task_executable_continuation_active_idx"
  ON "task_executable_continuation"("task_id", "status", "created_at" DESC);

CREATE TABLE "task_executable_diagnosis" (
  "id" uuid PRIMARY KEY,
  "task_id" uuid NOT NULL REFERENCES "task"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL REFERENCES "session"("id") ON DELETE CASCADE,
  "attempt_id" uuid,
  "kind" text NOT NULL,
  "source" text NOT NULL,
  "evidence" jsonb NOT NULL,
  "evidence_digest" char(64) NOT NULL CHECK ("evidence_digest" ~ '^[0-9a-f]{64}$'),
  "idempotency_key" text NOT NULL UNIQUE,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "task_executable_diagnosis_task_idx"
  ON "task_executable_diagnosis"("task_id", "created_at" DESC);
CREATE INDEX "task_executable_diagnosis_session_idx"
  ON "task_executable_diagnosis"("session_id");
CREATE TRIGGER "task_executable_diagnosis_append_only"
  BEFORE UPDATE OR DELETE ON "task_executable_diagnosis"
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();

CREATE TABLE "executable_runtime_heartbeat" (
  "id" uuid PRIMARY KEY,
  "component" text NOT NULL,
  "instance_id" text NOT NULL,
  "runner_id" uuid REFERENCES "runner"("id") ON DELETE SET NULL,
  "sequence" bigint NOT NULL CHECK ("sequence" > 0),
  "source_sha" text NOT NULL CHECK ("source_sha" ~ '^[0-9a-f]{40}$'),
  "module_graph_digest" char(64) NOT NULL CHECK ("module_graph_digest" ~ '^[0-9a-f]{64}$'),
  "observed_at" timestamptz NOT NULL,
  "deadline_at" timestamptz NOT NULL CHECK ("deadline_at" > "observed_at"),
  "payload" jsonb NOT NULL,
  "payload_digest" char(64) NOT NULL CHECK ("payload_digest" ~ '^[0-9a-f]{64}$'),
  "previous_digest" char(64),
  "heartbeat_digest" char(64) NOT NULL UNIQUE CHECK ("heartbeat_digest" ~ '^[0-9a-f]{64}$'),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("component", "instance_id", "sequence")
);
CREATE INDEX "executable_runtime_heartbeat_latest_idx"
  ON "executable_runtime_heartbeat"("component", "instance_id", "observed_at" DESC);
CREATE TRIGGER "executable_runtime_heartbeat_append_only"
  BEFORE UPDATE OR DELETE ON "executable_runtime_heartbeat"
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();

CREATE TABLE "executable_dead_man_event" (
  "id" uuid PRIMARY KEY,
  "component" text NOT NULL,
  "instance_id" text NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('WATCHDOG_STALE', 'WATCHDOG_RECOVERED')),
  "heartbeat_digest" char(64),
  "checked_at" timestamptz NOT NULL,
  "deadline_at" timestamptz,
  "source_sha" text NOT NULL CHECK ("source_sha" ~ '^[0-9a-f]{40}$'),
  "event_digest" char(64) NOT NULL UNIQUE CHECK ("event_digest" ~ '^[0-9a-f]{64}$'),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "executable_dead_man_latest_idx"
  ON "executable_dead_man_event"("component", "instance_id", "checked_at" DESC);
CREATE TRIGGER "executable_dead_man_event_append_only"
  BEFORE UPDATE OR DELETE ON "executable_dead_man_event"
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();

-- The watchdog's stale-attempt scan is bounded, lock-safe and protocol-selective: only an attempt
-- that crossed an ADMITTED v2 start boundary can become typed INFRASTRUCTURE_LOST. Legacy UNTYPED
-- rows have no admission and are outside this query by construction.
CREATE OR REPLACE FUNCTION executable_acceptance_mark_stale_attempts(
  p_observed_at timestamptz,
  p_limit integer DEFAULT 64
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE candidate record; marked integer := 0; fingerprint char(64); repeated integer;
        continuation "executable_acceptance_continuation_kind"; reason text;
BEGIN
  IF p_limit < 1 OR p_limit > 1024 THEN
    RAISE EXCEPTION 'EXECUTABLE_STALE_SCAN_LIMIT_INVALID';
  END IF;
  FOR candidate IN
    SELECT a."id", a."task_id", a."attempt_number", a."evaluation_plan_digest"
      FROM "task_executable_attempt" a
      JOIN "task_executable_admission" admission ON admission."id" = a."admission_id"
     WHERE admission."decision" = 'ADMITTED'
       AND a."termination_kind" IS NULL
       AND a."terminated_at" IS NULL
       AND a."deadline_at" < p_observed_at
     ORDER BY a."deadline_at", a."id"
     FOR UPDATE OF a SKIP LOCKED
     LIMIT p_limit
  LOOP
    fingerprint := encode(digest(concat(
      'evaluationPlanDigest=', candidate."evaluation_plan_digest", E'\n',
      'terminationKind=INFRASTRUCTURE_LOST', E'\nactualExitCode=NULL\nsignal=NULL'
    ), 'sha256'), 'hex')::char(64);
    UPDATE "task_executable_attempt"
       SET "terminated_at" = p_observed_at,
           "termination_kind" = 'INFRASTRUCTURE_LOST',
           "actual_exit_code" = NULL,
           "failure_fingerprint" = fingerprint
     WHERE "id" = candidate."id";

    SELECT count(*) INTO repeated
      FROM "task_executable_attempt"
     WHERE "task_id" = candidate."task_id"
       AND "failure_fingerprint" = fingerprint;
    IF candidate."attempt_number" < 3 AND repeated <= 1 THEN
      continuation := 'RETRY';
      reason := 'ATTEMPT_INFRASTRUCTURE_LOST_RETRY_BUDGET_AVAILABLE';
    ELSIF candidate."attempt_number" < 3 THEN
      continuation := 'DIAGNOSIS';
      reason := 'ATTEMPT_INFRASTRUCTURE_LOST_FINGERPRINT_REPEATED';
    ELSE
      continuation := 'SUCCESSOR';
      reason := 'ATTEMPT_INFRASTRUCTURE_LOST_ATTEMPT_BUDGET_EXHAUSTED';
    END IF;
    INSERT INTO "task_executable_continuation"
      ("id", "task_id", "attempt_id", "kind", "reason_code", "goal_actionable")
    VALUES (gen_random_uuid(), candidate."task_id", candidate."id", continuation, reason, true)
    ON CONFLICT ("attempt_id") DO NOTHING;
    marked := marked + 1;
  END LOOP;
  RETURN marked;
END;
$$;

-- Every API/UI/CLI reader can consume this one direct read model. It does not depend on the
-- watchdog's projection: a deadline that passed is stale even before another module acknowledges
-- it, while any newer heartbeat clears an older stale event immediately.
CREATE VIEW executable_runtime_liveness AS
WITH latest_heartbeat AS (
  SELECT DISTINCT ON (h."component", h."instance_id") h.*
    FROM "executable_runtime_heartbeat" h
   ORDER BY h."component", h."instance_id", h."sequence" DESC
), latest_event AS (
  SELECT DISTINCT ON (e."component", e."instance_id") e.*
    FROM "executable_dead_man_event" e
   ORDER BY e."component", e."instance_id", e."checked_at" DESC, e."created_at" DESC
)
SELECT h."component", h."instance_id", h."source_sha", h."heartbeat_digest",
       h."observed_at", h."deadline_at", e."kind" AS "last_event_kind",
       CASE
         WHEN now() > h."deadline_at" THEN 'WATCHDOG_STALE'
         WHEN e."kind" = 'WATCHDOG_STALE' AND e."checked_at" >= h."observed_at"
           THEN 'WATCHDOG_STALE'
         ELSE 'HEALTHY'
       END AS "state",
       CASE
         WHEN now() > h."deadline_at"
           OR (e."kind" = 'WATCHDOG_STALE' AND e."checked_at" >= h."observed_at")
         THEN 1 ELSE 0
       END::integer AS "active_obligation_count"
  FROM latest_heartbeat h
  LEFT JOIN latest_event e USING ("component", "instance_id");

-- Overlay external runtime liveness onto the six existing Outcome Reconciler read surfaces. This
-- is intentionally a read-time join over the heartbeat/event base tables: it does not ask the
-- disposable projection whether the watchdog that checks that projection is alive. Once a newer
-- heartbeat is healthy, the derived obligation disappears without a projection rebuild.
CREATE OR REPLACE FUNCTION executable_runtime_overlay_read_surface(
  p_payload jsonb,
  p_surface text
) RETURNS jsonb AS $$
DECLARE
  payload_value jsonb := COALESCE(p_payload, '{}'::jsonb);
  runtime_obligations jsonb;
  existing_obligations jsonb;
  existing_blocking jsonb;
  primary_obligation jsonb;
  merged_obligations jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'obligationId', encode(digest(concat(
      'WATCHDOG_STALE', E'\n', live."component", E'\n', live."instance_id"
    ), 'sha256'), 'hex'),
    'obligationRevision', live."heartbeat_digest",
    'bindingDigest', live."heartbeat_digest",
    'binding', jsonb_build_object(
      'component', live."component",
      'instanceId', live."instance_id",
      'sourceSha', live."source_sha",
      'heartbeatDigest', live."heartbeat_digest"
    ),
    'kind', 'WATCHDOG_STALE',
    'owner', 'SYSTEM',
    'capability', 'watchdog.heartbeat',
    'reason', jsonb_build_object(
      'code', 'WATCHDOG_STALE',
      'category', 'RUNTIME_LIVENESS',
      'message', concat('External dead-man observed an expired watchdog heartbeat for ',
        live."instance_id", '.'),
      'owner', 'SYSTEM',
      'actor', 'EXTERNAL_DEAD_MAN',
      'nextAction', 'RESTORE_WATCHDOG_HEARTBEAT',
      'blocksGate', true,
      'evidenceFactIds', jsonb_build_array(live."heartbeat_digest"),
      'attemptedActions', '[]'::jsonb,
      'detail', jsonb_build_object(
        'component', live."component",
        'instanceId', live."instance_id",
        'observedAt', live."observed_at",
        'deadlineAt', live."deadline_at",
        'lastEventKind', live."last_event_kind"
      )
    ),
    'evaluatedThroughLogicalTime', NULL,
    'projectionRevision', NULL,
    'staleness', 'WATCHDOG_STALE'
  ) ORDER BY live."component", live."instance_id"), '[]'::jsonb)
    INTO runtime_obligations
    FROM executable_runtime_liveness live
   WHERE live."state" = 'WATCHDOG_STALE';

  IF jsonb_array_length(runtime_obligations) = 0 THEN
    RETURN payload_value;
  END IF;
  existing_obligations := CASE WHEN jsonb_typeof(payload_value->'obligations') = 'array'
    THEN payload_value->'obligations' ELSE '[]'::jsonb END;
  existing_blocking := CASE WHEN jsonb_typeof(payload_value->'blockingObligations') = 'array'
    THEN payload_value->'blockingObligations' ELSE '[]'::jsonb END;
  merged_obligations := existing_obligations || runtime_obligations;
  primary_obligation := runtime_obligations->0;

  RETURN payload_value || jsonb_build_object(
    'surface', COALESCE(payload_value->>'surface', p_surface),
    'staleness', 'WATCHDOG_STALE',
    'obligations', merged_obligations,
    'blockingObligations', existing_blocking || runtime_obligations,
    'activeObligationCount', jsonb_array_length(merged_obligations),
    'runtimeLiveness', runtime_obligations,
    'doneGate', COALESCE(payload_value->'doneGate', '{}'::jsonb) || jsonb_build_object(
      'allowed', false,
      'reason', primary_obligation->'reason',
      'obligationId', primary_obligation->>'obligationId',
      'obligationRevision', primary_obligation->>'obligationRevision',
      'owner', 'SYSTEM',
      'staleness', 'WATCHDOG_STALE'
    )
  );
END;
$$ LANGUAGE plpgsql STABLE;

ALTER FUNCTION outcome_projection.read_surface(uuid, uuid, text, text, text)
  RENAME TO read_surface_projection_only;

CREATE FUNCTION outcome_projection.read_surface(
  p_authenticated_tenant uuid,
  p_project_id uuid,
  p_subject_type text,
  p_subject_id text,
  p_surface text
) RETURNS jsonb AS $$
  SELECT executable_runtime_overlay_read_surface(
    outcome_projection.read_surface_projection_only(
      p_authenticated_tenant, p_project_id, p_subject_type, p_subject_id, p_surface
    ),
    p_surface
  )
$$ LANGUAGE sql STABLE SECURITY DEFINER
   SET search_path = pg_catalog, public, outcome_projection;

COMMENT ON FUNCTION outcome_projection.read_surface IS
  'Six canonical read surfaces plus direct external dead-man liveness; WATCHDOG_STALE is never rendered as an empty obligation set.';

-- One database resolver for task_get/list/project, Ready, Run Now, every automatic trigger and
-- the commit gate. A missing row, owner boundary, cycle or chain longer than 256 fails closed.
CREATE OR REPLACE FUNCTION task_dependency_tail_id(p_task_id uuid)
RETURNS uuid LANGUAGE plpgsql STABLE AS $$
DECLARE cursor_id uuid := p_task_id; next_id uuid; root_owner uuid; current_owner uuid;
        current_status text; current_reason text;
        seen uuid[] := ARRAY[]::uuid[]; depth integer := 0;
BEGIN
  SELECT t."owner_id" INTO root_owner FROM "task" t WHERE t."id" = p_task_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  LOOP
    IF cursor_id = ANY(seen) OR depth > 256 THEN RETURN NULL; END IF;
    seen := array_append(seen, cursor_id);
    SELECT t."owner_id", t."superseded_by_task_id", t."status"::text, t."terminal_reason"
      INTO current_owner, next_id, current_status, current_reason
      FROM "task" t WHERE t."id" = cursor_id;
    IF NOT FOUND OR current_owner <> root_owner THEN RETURN NULL; END IF;
    IF next_id IS NULL THEN
      -- ON DELETE SET NULL preserves SUPERSEDED as honest history; it does not leave a tail whose
      -- status can satisfy new work. That broken chain is deliberately unresolved.
      IF current_reason = 'SUPERSEDED' THEN RETURN NULL; END IF;
      RETURN cursor_id;
    END IF;
    IF current_status NOT IN ('FAILED', 'CANCELLED') OR current_reason IS DISTINCT FROM 'SUPERSEDED'
      THEN RETURN NULL;
    END IF;
    cursor_id := next_id;
    depth := depth + 1;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION task_dependency_tail_satisfied(p_task_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
    SELECT t."status" = 'DONE'
      FROM "task" t
     WHERE t."id" = task_dependency_tail_id(p_task_id)
  ), false)
$$;

CREATE OR REPLACE FUNCTION task_all_dependency_tails_satisfied(p_task_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM "task_dependency" d
     WHERE d."task_id" = p_task_id
       AND NOT task_dependency_tail_satisfied(d."depends_on_task_id")
  )
$$;

-- Replace 0132's direct-status commit check. Every task-work Session (manual, instant, scheduled,
-- sweep or batch) is checked against the same successor-tail predicate immediately before commit.
CREATE OR REPLACE FUNCTION "session_dispatch_dependency_check"() RETURNS trigger AS $$
DECLARE s "session"%ROWTYPE; blocker uuid;
BEGIN
  SELECT * INTO s FROM "session" WHERE "id" = NEW."id";
  IF NOT FOUND OR NOT s."starts_task_work" OR s."task_id" IS NULL THEN RETURN NULL; END IF;
  SELECT d."depends_on_task_id" INTO blocker
    FROM "task_dependency" d
   WHERE d."task_id" = s."task_id"
     AND NOT task_dependency_tail_satisfied(d."depends_on_task_id")
   LIMIT 1;
  IF blocker IS NOT NULL THEN
    RAISE EXCEPTION 'DISPATCH_DEPENDENCY_CHANGED: task % has unresolved prerequisite tail % at commit',
      s."task_id", blocker USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "session_dispatch_dependency_check" ON "session";
CREATE CONSTRAINT TRIGGER "session_dispatch_dependency_check"
  AFTER INSERT ON "session" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "session_dispatch_dependency_check"();

-- No blanket historical rewrite follows. In particular, no -1 row receives a typed termination.
COMMENT ON TABLE "task_executable_diagnosis" IS
  'Append evidence-backed diagnoses separately; legacy exit=-1 remains UNTYPED and never becomes typed TIMED_OUT.';

-- One evidence-gated historical import for the bootstrap incident named by this change. It does
-- not infer from exit=-1 alone: the exact v1 shell turn ran for at least its fixed 120-second
-- deadline, the captured TAP reaches ok 12 but never test 13, and the system comment records -1.
-- The observation remains legacy UNTYPED; TIMEOUT exists only as a separate diagnosis claim.
CREATE OR REPLACE FUNCTION executable_acceptance_import_bootstrap_legacy_timeout()
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE shell_turn record; evidence_comment record; task_uuid uuid; attempt_uuid uuid;
        evidence jsonb;
BEGIN
  SELECT s."task_id", turn."id", turn."created_at", turn."answered_at"
    INTO shell_turn
    FROM "session" s
    JOIN "conversation_turn" turn ON turn."session_id" = s."id"
   WHERE s."id" = '01d2bdbf-f122-5b50-8f2c-02112709dcba'::uuid
     AND s."task_id" = '01a04672-4b57-7267-9f0c-24ac4e0ab282'::uuid
     AND turn."client_turn_id" LIKE 'system:task-acceptance:v1:%'
     AND turn."kind" = 'shell'
   ORDER BY turn."seq" DESC LIMIT 1;
  IF NOT FOUND OR shell_turn."answered_at" IS NULL
     OR shell_turn."answered_at" - shell_turn."created_at" < interval '120 seconds' THEN
    RETURN false;
  END IF;
  task_uuid := shell_turn."task_id";

  SELECT c."id", c."body" INTO evidence_comment
    FROM "task_comment" c
   WHERE c."task_id" = task_uuid
     AND c."body" LIKE '%实际退出码：-1%'
     AND c."body" LIKE '%ok 12 - samples are append-only%'
     AND c."body" NOT LIKE '%ok 13 -%'
   ORDER BY c."created_at" DESC LIMIT 1;
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT a."id" INTO attempt_uuid
    FROM "task_executable_attempt" a
   WHERE a."session_id" = '01d2bdbf-f122-5b50-8f2c-02112709dcba'::uuid
     AND a."legacy_termination" = 'UNTYPED'
   LIMIT 1;
  IF attempt_uuid IS NULL THEN
    attempt_uuid := 'b3a7b8e5-5c87-4e78-9abc-120000000001'::uuid;
    INSERT INTO "task_executable_attempt"
      ("id", "task_id", "session_id", "turn_id", "started_at", "legacy_termination",
       "legacy_exit_code", "raw_output", "output_truncated")
    VALUES
      (attempt_uuid, task_uuid, '01d2bdbf-f122-5b50-8f2c-02112709dcba'::uuid,
       shell_turn."id", shell_turn."created_at", 'UNTYPED', -1, evidence_comment."body", true);
  END IF;

  evidence := jsonb_build_object(
    'claim', 'TIMEOUT',
    'protocol', 'LEGACY_V1_UNTYPED',
    'legacyExitCode', -1,
    'fixedDeadlineSeconds', 120,
    'elapsedMilliseconds', floor(extract(epoch FROM
      (shell_turn."answered_at" - shell_turn."created_at")) * 1000)::bigint,
    'outputStreamComplete', false,
    'lastObservedPassingSubtest', 12,
    'declaredSubtestCount', 13,
    'shellTurnId', shell_turn."id",
    'sourceCommentId', evidence_comment."id",
    'typedTerminationClaimed', false
  );
  INSERT INTO "task_executable_diagnosis"
    ("id", "task_id", "session_id", "attempt_id", "kind", "source", "evidence",
     "evidence_digest", "idempotency_key")
  VALUES
    ('b3a7b8e5-5c87-4e78-9abc-120000000002'::uuid, task_uuid,
     '01d2bdbf-f122-5b50-8f2c-02112709dcba'::uuid, attempt_uuid, 'TIMEOUT',
     'LEGACY_DEADLINE_EVIDENCE', evidence,
     encode(digest(evidence::text, 'sha256'), 'hex'),
     'legacy-timeout:3RIgJAt2GsNCTVoKKfOvK')
  ON CONFLICT ("idempotency_key") DO NOTHING;
  RETURN true;
END;
$$;

SELECT executable_acceptance_import_bootstrap_legacy_timeout();

-- Bind the already-filed watchdog successor in the same migration transaction that introduces
-- the protocol it requires. The BEFORE trigger computes both SHA digests from this exact command,
-- expectation, 1200-second request, ceilings and current capability revision atomically.
UPDATE "task"
   SET "acceptance_timeout_seconds" = 1200,
       "acceptance_owner_timeout_ceiling_seconds" = 1200,
       "acceptance_policy_timeout_ceiling_seconds" = 3600,
       "acceptance_schema_revision" = 2,
       "acceptance_capability_revision" = 2
 WHERE "id" = '01a0480d-7aba-7281-9b84-aefcba1e75b0'::uuid
   AND "completion_criterion" = 'EXECUTABLE'
   AND "acceptance_command" IS NOT NULL
   AND "acceptance_expected_exit_code" IS NOT NULL;
