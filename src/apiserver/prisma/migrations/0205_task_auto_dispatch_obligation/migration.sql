-- Automatic dependency dispatch used to have three lossy gaps:
--   * a rolling-v1 completion ACK could derive Task=DONE without calling the in-process trigger;
--   * the ready sweep filtered policy refusals before any dispatch attempt was observable; and
--   * an execute/commit-gate refusal was only a process log line.
--
-- This migration makes the dependency transition itself a durable, idempotent request.  One
-- (task, dispatch epoch) spends at most one dispatch_attempt, carries one current canonical
-- obligation revision while blocked, and has a persistent wakeup.  A Session receipt wins over
-- any racing refusal and permanently resolves that epoch.

BEGIN;

CREATE TABLE "task_auto_dispatch_attempt" (
  "tenant_id"       UUID        NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "project_id"      UUID        REFERENCES "project"("id") ON DELETE CASCADE,
  "task_id"         UUID        NOT NULL REFERENCES "task"("id") ON DELETE CASCADE,
  "task_revision"   BIGINT      NOT NULL,
  "watermark"       BIGINT      NOT NULL,
  "attempt_ordinal" BIGINT      NOT NULL,
  "first_trigger"   TEXT        NOT NULL,
  "first_outcome"   TEXT        NOT NULL,
  "first_observed_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY ("task_id", "watermark"),
  CONSTRAINT "task_auto_dispatch_attempt_trigger_check"
    CHECK ("first_trigger" IN ('DEPENDENCY_TRIGGER', 'READY_SWEEP')),
  CONSTRAINT "task_auto_dispatch_attempt_outcome_check"
    CHECK ("first_outcome" IN ('ATTEMPTING', 'REFUSED', 'DISPATCHED', 'SUPERSEDED')),
  CONSTRAINT "task_auto_dispatch_attempt_ordinal_check" CHECK ("attempt_ordinal" > 0)
);

CREATE INDEX "task_auto_dispatch_attempt_tenant_project_idx"
  ON "task_auto_dispatch_attempt" ("tenant_id", "project_id", "first_observed_at" DESC);

-- Immutable definition of one operational obligation revision.  obligation_id is stable for the
-- Task; the revision/binding move with scopeRevision, dispatch watermark, Project configuration,
-- completion-contract digest or typed reason.
CREATE TABLE "task_auto_dispatch_obligation_revision" (
  "tenant_id"          UUID        NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "project_id"         UUID        REFERENCES "project"("id") ON DELETE CASCADE,
  "task_id"            UUID        NOT NULL REFERENCES "task"("id") ON DELETE CASCADE,
  "task_revision"      BIGINT      NOT NULL,
  "watermark"          BIGINT      NOT NULL,
  "obligation_id"      CHAR(64)    NOT NULL,
  "obligation_revision" CHAR(64)   NOT NULL,
  "binding_digest"     CHAR(64)    NOT NULL,
  "reason_code"        TEXT        NOT NULL,
  "reason"             JSONB       NOT NULL,
  "owner"              TEXT        NOT NULL,
  "next_action"        TEXT        NOT NULL,
  "binding"            JSONB       NOT NULL,
  "created_at"         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY ("tenant_id", "task_id", "obligation_revision"),
  CONSTRAINT "task_auto_dispatch_obligation_revision_digest_check"
    CHECK (outcome_valid_digest("obligation_id"::text)
       AND outcome_valid_digest("obligation_revision"::text)
       AND outcome_valid_digest("binding_digest"::text)),
  CONSTRAINT "task_auto_dispatch_obligation_revision_owner_check"
    CHECK ("owner" IN ('OWNER', 'AGENT', 'SYSTEM', 'PROJECT_COORDINATOR')),
  CONSTRAINT "task_auto_dispatch_obligation_revision_reason_check"
    CHECK (jsonb_typeof("reason") = 'object'),
  CONSTRAINT "task_auto_dispatch_obligation_revision_binding_check"
    CHECK (jsonb_typeof("binding") = 'object')
);

CREATE UNIQUE INDEX "task_auto_dispatch_obligation_identity_idx"
  ON "task_auto_dispatch_obligation_revision"
  ("tenant_id", "task_id", "obligation_id", "obligation_revision");

-- Rebuildable current projection for one dependency transition.  A successful Session receipt is
-- terminal and cannot be reopened by a late refusal from the racing trigger/sweep delivery.
CREATE TABLE "task_auto_dispatch_state" (
  "tenant_id"          UUID        NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "project_id"         UUID        REFERENCES "project"("id") ON DELETE CASCADE,
  "task_id"            UUID        NOT NULL REFERENCES "task"("id") ON DELETE CASCADE,
  "task_revision"      BIGINT      NOT NULL,
  "watermark"          BIGINT      NOT NULL,
  "attempt_ordinal"    BIGINT      NOT NULL,
  "obligation_id"      CHAR(64)    NOT NULL,
  "obligation_revision" CHAR(64)   NOT NULL,
  "state"              TEXT        NOT NULL,
  "outcome"            TEXT        NOT NULL,
  "reason_code"        TEXT        NOT NULL,
  "session_id"         UUID        REFERENCES "session"("id") ON DELETE SET NULL,
  "attempted_actions"  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  "first_observed_at"  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  "latest_observed_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  "observation_count"  BIGINT      NOT NULL DEFAULT 1,
  PRIMARY KEY ("task_id", "watermark"),
  CONSTRAINT "task_auto_dispatch_state_revision_fkey"
    FOREIGN KEY ("tenant_id", "task_id", "obligation_revision")
    REFERENCES "task_auto_dispatch_obligation_revision"
      ("tenant_id", "task_id", "obligation_revision") ON DELETE CASCADE,
  CONSTRAINT "task_auto_dispatch_state_state_check"
    CHECK ("state" IN ('ACTIVE', 'RESOLVED')),
  CONSTRAINT "task_auto_dispatch_state_outcome_check"
    CHECK ("outcome" IN ('ATTEMPTING', 'REFUSED', 'DISPATCHED', 'SUPERSEDED')),
  CONSTRAINT "task_auto_dispatch_state_attempted_actions_check"
    CHECK (jsonb_typeof("attempted_actions") = 'array'),
  CONSTRAINT "task_auto_dispatch_state_session_check"
    CHECK ("outcome" <> 'DISPATCHED' OR "session_id" IS NOT NULL)
);

CREATE INDEX "task_auto_dispatch_state_active_task_idx"
  ON "task_auto_dispatch_state" ("tenant_id", "task_id", "watermark")
  WHERE "state" = 'ACTIVE';
CREATE INDEX "task_auto_dispatch_state_active_project_idx"
  ON "task_auto_dispatch_state" ("tenant_id", "project_id", "first_observed_at")
  WHERE "state" = 'ACTIVE';

CREATE TABLE "task_auto_dispatch_event" (
  "event_id"            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "tenant_id"           UUID        NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "project_id"          UUID        REFERENCES "project"("id") ON DELETE CASCADE,
  "task_id"             UUID        NOT NULL REFERENCES "task"("id") ON DELETE CASCADE,
  "task_revision"       BIGINT      NOT NULL,
  "watermark"           BIGINT      NOT NULL,
  "obligation_id"       CHAR(64)    NOT NULL,
  "obligation_revision" CHAR(64)    NOT NULL,
  "from_state"          TEXT,
  "to_state"            TEXT        NOT NULL,
  "outcome"             TEXT        NOT NULL,
  "reason_code"         TEXT        NOT NULL,
  "session_id"          UUID        REFERENCES "session"("id") ON DELETE SET NULL,
  "idempotency_key"     CHAR(64)    NOT NULL UNIQUE,
  "recorded_at"         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "task_auto_dispatch_event_state_check"
    CHECK ("to_state" IN ('ACTIVE', 'RESOLVED', 'SUPERSEDED'))
);

CREATE INDEX "task_auto_dispatch_event_trace_idx"
  ON "task_auto_dispatch_event" ("tenant_id", "task_id", "watermark", "event_id");

CREATE TABLE "task_auto_dispatch_wakeup" (
  "wakeup_id"           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"           UUID        NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "project_id"          UUID        REFERENCES "project"("id") ON DELETE CASCADE,
  "task_id"             UUID        NOT NULL REFERENCES "task"("id") ON DELETE CASCADE,
  "task_revision"       BIGINT      NOT NULL,
  "watermark"           BIGINT      NOT NULL,
  "obligation_revision" CHAR(64)    NOT NULL,
  "generation"          BIGINT      NOT NULL DEFAULT 1,
  "due_at"              TIMESTAMPTZ NOT NULL,
  "reason_code"         TEXT        NOT NULL,
  "state"               TEXT        NOT NULL DEFAULT 'PENDING',
  "delivery_attempts"   INTEGER     NOT NULL DEFAULT 0,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "task_auto_dispatch_wakeup_revision_fkey"
    FOREIGN KEY ("tenant_id", "task_id", "obligation_revision")
    REFERENCES "task_auto_dispatch_obligation_revision"
      ("tenant_id", "task_id", "obligation_revision") ON DELETE CASCADE,
  CONSTRAINT "task_auto_dispatch_wakeup_identity_key"
    UNIQUE ("task_id", "watermark", "obligation_revision", "generation"),
  CONSTRAINT "task_auto_dispatch_wakeup_state_check"
    CHECK ("state" IN ('PENDING', 'CONSUMED', 'SUPERSEDED')),
  CONSTRAINT "task_auto_dispatch_wakeup_generation_check" CHECK ("generation" > 0),
  CONSTRAINT "task_auto_dispatch_wakeup_delivery_attempts_check"
    CHECK ("delivery_attempts" >= 0)
);

CREATE INDEX "task_auto_dispatch_wakeup_due_idx"
  ON "task_auto_dispatch_wakeup" ("state", "due_at", "tenant_id", "task_id")
  WHERE "state" = 'PENDING';

CREATE OR REPLACE FUNCTION task_auto_dispatch_record(
  p_tenant UUID,
  p_task UUID,
  p_watermark BIGINT,
  p_trigger TEXT,
  p_outcome TEXT,
  p_reason_code TEXT,
  p_reason JSONB,
  p_owner TEXT,
  p_next_action TEXT,
  p_session UUID DEFAULT NULL,
  p_wake_at TIMESTAMPTZ DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  task_project UUID;
  task_revision_value BIGINT;
  current_watermark BIGINT;
  project_config_revision BIGINT;
  contract_digest_value TEXT;
  obligation_id_value TEXT;
  obligation_revision_value TEXT;
  binding_digest_value TEXT;
  binding_value JSONB;
  attempt_ordinal_value BIGINT;
  inserted_attempt INTEGER;
  active_value BOOLEAN;
  old_state TEXT;
  old_outcome TEXT;
  old_revision TEXT;
  final_state TEXT;
  final_outcome TEXT;
  final_revision TEXT;
  final_reason TEXT;
  final_session UUID;
  event_key TEXT;
  wakeup_id_value UUID;
  prior RECORD;
BEGIN
  IF p_trigger NOT IN ('DEPENDENCY_TRIGGER', 'READY_SWEEP') THEN
    RAISE EXCEPTION 'AUTO_DISPATCH_TRIGGER_INVALID: %', p_trigger;
  END IF;
  IF p_outcome NOT IN ('ATTEMPTING', 'REFUSED', 'DISPATCHED', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'AUTO_DISPATCH_OUTCOME_INVALID: %', p_outcome;
  END IF;
  IF p_outcome = 'DISPATCHED' AND p_session IS NULL THEN
    RAISE EXCEPTION 'AUTO_DISPATCH_SESSION_REQUIRED';
  END IF;
  IF jsonb_typeof(COALESCE(p_reason, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'AUTO_DISPATCH_REASON_INVALID';
  END IF;

  -- The task lock serializes the first observation with every other attempt-count writer.  The
  -- Session effect remains fenced by task_run_request + the unique live-session claim.
  SELECT t."project_id", t."scope_revision"::bigint, COALESCE(epoch."epoch", 0),
         COALESCE(project."config_revision", 0), contract."contract_digest"::text
    INTO task_project, task_revision_value, current_watermark,
         project_config_revision, contract_digest_value
    FROM "task" t
    LEFT JOIN "task_dispatch_epoch" epoch ON epoch."task_id" = t."id"
    LEFT JOIN "project" project ON project."id" = t."project_id"
    LEFT JOIN "project_completion_contract" contract ON contract."project_id" = t."project_id"
   WHERE t."id" = p_task AND t."owner_id" = p_tenant
   FOR UPDATE OF t;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTO_DISPATCH_TASK_NOT_FOUND'; END IF;

  -- A delivery selected under an older dependency epoch may still arrive after the task moved.
  -- It is an observation, but never a current blocker. execute() performs the same authority
  -- fence before any Session effect; classifying it here closes the pre-execute crash window too.
  IF p_watermark <> current_watermark AND p_outcome IN ('ATTEMPTING', 'REFUSED') THEN
    p_outcome := 'SUPERSEDED';
    p_reason_code := 'DISPATCH_WATERMARK_SUPERSEDED';
    p_reason := jsonb_build_object(
      'code', p_reason_code,
      'message', 'A newer task/dependency watermark replaced this automatic dispatch delivery.',
      'nextAction', 'REEVALUATE_CURRENT_DEPENDENCY_WATERMARK'
    );
    p_owner := 'SYSTEM';
    p_next_action := 'REEVALUATE_CURRENT_DEPENDENCY_WATERMARK';
    p_wake_at := NULL;
  END IF;

  obligation_id_value := encode(digest(
    'task-auto-dispatch:v1:' || p_tenant::text || ':' || p_task::text,
    'sha256'
  ), 'hex');
  binding_value := jsonb_build_object(
    'schemaVersion', 1,
    'tenantId', p_tenant::text,
    'projectId', task_project::text,
    'taskId', p_task::text,
    'taskRevision', task_revision_value::text,
    'evaluatedThroughWatermark', p_watermark::text,
    'currentWatermarkAtObservation', current_watermark::text,
    'projectConfigRevision', project_config_revision::text,
    'contractDigest', contract_digest_value,
    'reasonCode', p_reason_code
  );
  binding_digest_value := encode(digest(binding_value::text, 'sha256'), 'hex');
  obligation_revision_value := encode(digest(
    obligation_id_value || ':' || binding_digest_value,
    'sha256'
  ), 'hex');

  -- Immutable even for DISPATCHED/SUPERSEDED: the observation state always points at an exact
  -- binding and a trace reader never has to special-case a missing revision.
  INSERT INTO "task_auto_dispatch_obligation_revision" (
    "tenant_id", "project_id", "task_id", "task_revision", "watermark",
    "obligation_id", "obligation_revision", "binding_digest", "reason_code", "reason",
    "owner", "next_action", "binding"
  ) VALUES (
    p_tenant, task_project, p_task, task_revision_value, p_watermark,
    obligation_id_value, obligation_revision_value, binding_digest_value, p_reason_code,
    COALESCE(p_reason, '{}'::jsonb), p_owner, p_next_action, binding_value
  ) ON CONFLICT ("tenant_id", "task_id", "obligation_revision") DO NOTHING;

  INSERT INTO "task_auto_dispatch_attempt" (
    "tenant_id", "project_id", "task_id", "task_revision", "watermark",
    "attempt_ordinal", "first_trigger", "first_outcome"
  ) VALUES (
    p_tenant, task_project, p_task, task_revision_value, p_watermark,
    1, p_trigger, p_outcome
  ) ON CONFLICT ("task_id", "watermark") DO NOTHING;
  GET DIAGNOSTICS inserted_attempt = ROW_COUNT;
  IF inserted_attempt = 1 THEN
    UPDATE "task" SET "dispatch_attempt" = "dispatch_attempt" + 1
     WHERE "id" = p_task AND "owner_id" = p_tenant
     RETURNING "dispatch_attempt" INTO attempt_ordinal_value;
    UPDATE "task_auto_dispatch_attempt"
       SET "attempt_ordinal" = attempt_ordinal_value
     WHERE "task_id" = p_task AND "watermark" = p_watermark;
  ELSE
    SELECT "attempt_ordinal" INTO attempt_ordinal_value
      FROM "task_auto_dispatch_attempt"
     WHERE "task_id" = p_task AND "watermark" = p_watermark;
  END IF;

  -- Moving to a new current watermark explicitly retires an older unresolved projection. The
  -- immutable revision/event history remains; task_get must never keep showing a reason bound to
  -- a dependency transition that is no longer current.
  IF p_watermark = current_watermark THEN
    FOR prior IN
      SELECT previous.*
        FROM "task_auto_dispatch_state" previous
       WHERE previous."task_id" = p_task
         AND previous."watermark" <> p_watermark
         AND previous."state" = 'ACTIVE'
       ORDER BY previous."watermark"
       FOR UPDATE
    LOOP
      UPDATE "task_auto_dispatch_state"
         SET "state" = 'RESOLVED', "outcome" = 'SUPERSEDED',
             "reason_code" = 'DISPATCH_WATERMARK_SUPERSEDED',
             "latest_observed_at" = clock_timestamp(),
             "observation_count" = "observation_count" + 1
       WHERE "task_id" = prior."task_id" AND "watermark" = prior."watermark";
      UPDATE "task_auto_dispatch_wakeup"
         SET "state" = 'SUPERSEDED', "updated_at" = clock_timestamp()
       WHERE "task_id" = prior."task_id" AND "watermark" = prior."watermark"
         AND "state" = 'PENDING';
      event_key := encode(digest(
        prior."task_id"::text || ':' || prior."watermark"::text || ':' ||
        prior."obligation_revision"::text || ':WATERMARK_SUPERSEDED:' || p_watermark::text,
        'sha256'
      ), 'hex');
      INSERT INTO "task_auto_dispatch_event" (
        "tenant_id", "project_id", "task_id", "task_revision", "watermark",
        "obligation_id", "obligation_revision", "from_state", "to_state", "outcome",
        "reason_code", "session_id", "idempotency_key"
      ) VALUES (
        prior."tenant_id", prior."project_id", prior."task_id", prior."task_revision",
        prior."watermark", prior."obligation_id", prior."obligation_revision",
        'ACTIVE', 'SUPERSEDED', 'SUPERSEDED', 'DISPATCH_WATERMARK_SUPERSEDED',
        prior."session_id", event_key
      ) ON CONFLICT ("idempotency_key") DO NOTHING;
    END LOOP;
  END IF;

  SELECT "state", "outcome", "obligation_revision"::text
    INTO old_state, old_outcome, old_revision
    FROM "task_auto_dispatch_state"
   WHERE "task_id" = p_task AND "watermark" = p_watermark;

  active_value := p_outcome IN ('ATTEMPTING', 'REFUSED');
  INSERT INTO "task_auto_dispatch_state" (
    "tenant_id", "project_id", "task_id", "task_revision", "watermark",
    "attempt_ordinal", "obligation_id", "obligation_revision", "state", "outcome",
    "reason_code", "session_id", "attempted_actions"
  ) VALUES (
    p_tenant, task_project, p_task, task_revision_value, p_watermark,
    attempt_ordinal_value, obligation_id_value, obligation_revision_value,
    CASE WHEN active_value THEN 'ACTIVE' ELSE 'RESOLVED' END,
    p_outcome, p_reason_code, p_session,
    jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'trigger', p_trigger, 'outcome', p_outcome, 'reasonCode', p_reason_code,
      'sessionId', p_session::text, 'observedAt', clock_timestamp()
    )))
  )
  ON CONFLICT ("task_id", "watermark") DO UPDATE SET
    -- A Session receipt is the terminal winner for this epoch.  A late refusal from the losing
    -- trigger/sweep delivery may increase observation_count but cannot reopen or rewrite it.
    "project_id" = EXCLUDED."project_id",
    "task_revision" = EXCLUDED."task_revision",
    "attempt_ordinal" = EXCLUDED."attempt_ordinal",
    "obligation_id" = CASE
      WHEN "task_auto_dispatch_state"."outcome" = 'DISPATCHED'
        THEN "task_auto_dispatch_state"."obligation_id"
      WHEN "task_auto_dispatch_state"."outcome" = 'REFUSED' AND EXCLUDED."outcome" = 'ATTEMPTING'
        THEN "task_auto_dispatch_state"."obligation_id"
      ELSE EXCLUDED."obligation_id" END,
    "obligation_revision" = CASE
      WHEN "task_auto_dispatch_state"."outcome" = 'DISPATCHED'
        THEN "task_auto_dispatch_state"."obligation_revision"
      WHEN "task_auto_dispatch_state"."outcome" = 'REFUSED' AND EXCLUDED."outcome" = 'ATTEMPTING'
        THEN "task_auto_dispatch_state"."obligation_revision"
      ELSE EXCLUDED."obligation_revision" END,
    "state" = CASE
      WHEN "task_auto_dispatch_state"."outcome" = 'DISPATCHED' THEN 'RESOLVED'
      ELSE EXCLUDED."state" END,
    "outcome" = CASE
      WHEN "task_auto_dispatch_state"."outcome" = 'DISPATCHED' THEN 'DISPATCHED'
      WHEN "task_auto_dispatch_state"."outcome" = 'REFUSED' AND EXCLUDED."outcome" = 'ATTEMPTING'
        THEN 'REFUSED'
      ELSE EXCLUDED."outcome" END,
    "reason_code" = CASE
      WHEN "task_auto_dispatch_state"."outcome" = 'DISPATCHED'
        THEN "task_auto_dispatch_state"."reason_code"
      WHEN "task_auto_dispatch_state"."outcome" = 'REFUSED' AND EXCLUDED."outcome" = 'ATTEMPTING'
        THEN "task_auto_dispatch_state"."reason_code"
      ELSE EXCLUDED."reason_code" END,
    "session_id" = COALESCE("task_auto_dispatch_state"."session_id", EXCLUDED."session_id"),
    "attempted_actions" = EXCLUDED."attempted_actions",
    "latest_observed_at" = clock_timestamp(),
    "observation_count" = "task_auto_dispatch_state"."observation_count" + 1
  RETURNING "state", "outcome", "obligation_revision"::text, "reason_code", "session_id"
    INTO final_state, final_outcome, final_revision, final_reason, final_session;

  -- A new reason/binding supersedes the prior active revision explicitly.  Revisions are immutable;
  -- only this rebuildable pointer moves.
  IF old_state = 'ACTIVE' AND old_revision IS DISTINCT FROM final_revision THEN
    event_key := encode(digest(
      p_task::text || ':' || p_watermark::text || ':' || old_revision || ':SUPERSEDED',
      'sha256'
    ), 'hex');
    INSERT INTO "task_auto_dispatch_event" (
      "tenant_id", "project_id", "task_id", "task_revision", "watermark",
      "obligation_id", "obligation_revision", "from_state", "to_state", "outcome",
      "reason_code", "session_id", "idempotency_key"
    ) VALUES (
      p_tenant, task_project, p_task, task_revision_value, p_watermark,
      obligation_id_value, old_revision, old_state, 'SUPERSEDED', old_outcome,
      'OBLIGATION_REVISION_SUPERSEDED', NULL, event_key
    ) ON CONFLICT ("idempotency_key") DO NOTHING;
  END IF;

  event_key := encode(digest(
    p_task::text || ':' || p_watermark::text || ':' || final_revision || ':' ||
    final_state || ':' || final_outcome || ':' || COALESCE(final_session::text, ''),
    'sha256'
  ), 'hex');
  INSERT INTO "task_auto_dispatch_event" (
    "tenant_id", "project_id", "task_id", "task_revision", "watermark",
    "obligation_id", "obligation_revision", "from_state", "to_state", "outcome",
    "reason_code", "session_id", "idempotency_key"
  ) VALUES (
    p_tenant, task_project, p_task, task_revision_value, p_watermark,
    obligation_id_value, final_revision, old_state, final_state, final_outcome,
    final_reason, final_session, event_key
  ) ON CONFLICT ("idempotency_key") DO NOTHING;

  IF final_state = 'ACTIVE' THEN
    UPDATE "task_auto_dispatch_wakeup"
       SET "state" = 'SUPERSEDED', "updated_at" = clock_timestamp()
     WHERE "task_id" = p_task AND "watermark" = p_watermark
       AND "state" = 'PENDING' AND "obligation_revision" <> final_revision;
    INSERT INTO "task_auto_dispatch_wakeup" (
      "tenant_id", "project_id", "task_id", "task_revision", "watermark",
      "obligation_revision", "generation", "due_at", "reason_code"
    ) VALUES (
      p_tenant, task_project, p_task, task_revision_value, p_watermark,
      final_revision, 1,
      COALESCE(p_wake_at, clock_timestamp() + interval '1 minute'), final_reason
    )
    ON CONFLICT ("task_id", "watermark", "obligation_revision", "generation")
    DO UPDATE SET
      -- Re-delivering a due wake which is still refused arms the next evaluation window. Keeping
      -- the old, already-due instant would turn the persistent clock into a tight retry loop.
      "due_at" = GREATEST("task_auto_dispatch_wakeup"."due_at", EXCLUDED."due_at"),
      "reason_code" = EXCLUDED."reason_code",
      "state" = 'PENDING',
      "updated_at" = clock_timestamp()
    RETURNING "wakeup_id" INTO wakeup_id_value;
  ELSE
    UPDATE "task_auto_dispatch_wakeup"
       SET "state" = 'CONSUMED', "updated_at" = clock_timestamp()
     WHERE "task_id" = p_task AND "watermark" = p_watermark AND "state" = 'PENDING';
    wakeup_id_value := NULL;
  END IF;

  RETURN jsonb_build_object(
    'taskId', p_task::text,
    'taskRevision', task_revision_value::text,
    'watermark', p_watermark::text,
    'currentWatermark', current_watermark::text,
    'dispatchAttempt', attempt_ordinal_value::text,
    'obligationId', obligation_id_value,
    'obligationRevision', final_revision,
    'state', final_state,
    'outcome', final_outcome,
    'reasonCode', final_reason,
    'wakeupId', wakeup_id_value::text,
    'sessionId', final_session::text
  );
END;
$$;

-- Crash recovery for the narrow post-Session/pre-receipt window.  The Session is authoritative:
-- once one exists, no ACTIVE dispatch obligation for that epoch may remain visible.
CREATE OR REPLACE FUNCTION task_auto_dispatch_reconcile_sessions()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  row RECORD;
  reconciled INTEGER := 0;
  event_key TEXT;
BEGIN
  FOR row IN
    SELECT state.*, session."id" AS active_session_id
      FROM "task_auto_dispatch_state" state
      JOIN LATERAL (
        SELECT candidate."id"
          FROM "session" candidate
         WHERE candidate."task_id" = state."task_id"
           AND candidate."deleted_at" IS NULL
           AND candidate."starts_task_work" = true
           AND candidate."status" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
         ORDER BY candidate."created_at", candidate."id"
         LIMIT 1
      ) session ON true
     WHERE state."state" = 'ACTIVE'
     ORDER BY state."task_id", state."watermark"
     FOR UPDATE OF state SKIP LOCKED
  LOOP
    UPDATE "task_auto_dispatch_state"
       SET "state" = 'RESOLVED', "outcome" = 'DISPATCHED',
           "reason_code" = 'SESSION_RECEIPT_RECONCILED',
           "session_id" = row.active_session_id,
           "latest_observed_at" = clock_timestamp(),
           "observation_count" = "observation_count" + 1
     WHERE "task_id" = row.task_id AND "watermark" = row.watermark;
    UPDATE "task_auto_dispatch_wakeup"
       SET "state" = 'CONSUMED', "updated_at" = clock_timestamp()
     WHERE "task_id" = row.task_id AND "watermark" = row.watermark AND "state" = 'PENDING';
    event_key := encode(digest(
      row.task_id::text || ':' || row.watermark::text || ':' ||
      row.obligation_revision::text || ':SESSION_RECEIPT_RECONCILED:' ||
      row.active_session_id::text,
      'sha256'
    ), 'hex');
    INSERT INTO "task_auto_dispatch_event" (
      "tenant_id", "project_id", "task_id", "task_revision", "watermark",
      "obligation_id", "obligation_revision", "from_state", "to_state", "outcome",
      "reason_code", "session_id", "idempotency_key"
    ) VALUES (
      row.tenant_id, row.project_id, row.task_id, row.task_revision, row.watermark,
      row.obligation_id, row.obligation_revision, 'ACTIVE', 'RESOLVED', 'DISPATCHED',
      'SESSION_RECEIPT_RECONCILED', row.active_session_id, event_key
    ) ON CONFLICT ("idempotency_key") DO NOTHING;
    reconciled := reconciled + 1;
  END LOOP;
  RETURN reconciled;
END;
$$;

COMMENT ON FUNCTION task_auto_dispatch_record(UUID, UUID, BIGINT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, UUID, TIMESTAMPTZ) IS
  'Atomic first-observation attempt counter, canonical dispatch obligation revision/event, and persistent wakeup for one task dispatch epoch.';
COMMENT ON TABLE "task_auto_dispatch_state" IS
  'Rebuildable current auto-dispatch state; ACTIVE rows are surfaced as controlPlaneObligations by task/project reads.';
COMMENT ON TABLE "task_auto_dispatch_wakeup" IS
  'Persistent retry clock for a blocked or interrupted automatic dependency dispatch.';

COMMIT;
