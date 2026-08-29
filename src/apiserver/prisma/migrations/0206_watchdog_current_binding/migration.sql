-- Bind the independently deployed outcome-watchdog to exactly one current runtime generation.
--
-- Runtime expectations (0202) are deployment declarations scoped to an instance slot.  They are
-- intentionally allowed to coexist for the two outcome-coordinator peers.  That scope is too
-- weak for the singleton outcome-watchdog, however: a pre-expectation heartbeat emitted under a
-- container hostname remains a distinct forever-stale instance even after the Compose generation
-- is healthy.  The read overlay consequently kept the historical c4bc5303e476:1 heartbeat alive.
--
-- This migration adds a component-wide, append-only binding/fact ledger for the watchdog only.
-- Registration is serialized, replacement appends SUPERSEDED/OBSOLETED facts, and every bound
-- heartbeat advances a database-owned logical watermark.  Historical expectations, heartbeats,
-- and dead-man events remain immutable audit facts.
BEGIN;

CREATE TABLE executable_runtime_binding_stream (
  component             text        PRIMARY KEY,
  last_logical_time     bigint      NOT NULL DEFAULT 0 CHECK (last_logical_time >= 0),
  updated_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (component = 'outcome-watchdog')
);

CREATE TABLE executable_runtime_binding (
  binding_digest         char(64)    PRIMARY KEY CHECK (outcome_valid_digest(binding_digest)),
  component              text        NOT NULL CHECK (component = 'outcome-watchdog'),
  expectation_generation uuid        NOT NULL,
  expectation_digest     char(64)    NOT NULL CHECK (outcome_valid_digest(expectation_digest)),
  instance_id            text        NOT NULL CHECK (length(btrim(instance_id)) BETWEEN 1 AND 512),
  source_sha             text        NOT NULL CHECK (source_sha ~ '^[0-9a-f]{40}$'),
  target_sha             text        NOT NULL CHECK (target_sha ~ '^[0-9a-f]{40}$'),
  target_ref             text        NOT NULL CHECK (
    length(btrim(target_ref)) BETWEEN 1 AND 1024 AND target_ref ~ '^refs/'
  ),
  module_graph_digest    char(64)    NOT NULL CHECK (outcome_valid_digest(module_graph_digest)),
  binding                jsonb       NOT NULL,
  registered_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (component, expectation_generation),
  UNIQUE (component, binding_digest),
  FOREIGN KEY (expectation_generation)
    REFERENCES executable_runtime_expectation(generation)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (component, instance_id, expectation_generation)
    REFERENCES executable_runtime_expectation(component, instance_id, generation)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK (binding_digest = outcome_sha256_json(binding)),
  CHECK (outcome_jsonb_exact_keys(binding, ARRAY[
    'schemaVersion', 'component', 'expectationGeneration', 'expectationDigest',
    'instanceId', 'sourceSha', 'targetSha', 'targetRef', 'moduleGraphDigest'
  ]))
);

CREATE INDEX executable_runtime_binding_registered_idx
  ON executable_runtime_binding(component, registered_at DESC, expectation_generation);

CREATE TABLE executable_runtime_binding_fact (
  fact_id                       uuid        PRIMARY KEY,
  component                     text        NOT NULL CHECK (component = 'outcome-watchdog'),
  logical_time                  bigint      NOT NULL CHECK (logical_time > 0),
  kind                          text        NOT NULL CHECK (kind IN (
    'CURRENT_REGISTERED', 'SUPERSEDED', 'OBSOLETED', 'HEARTBEAT_INGESTED'
  )),
  binding_digest                char(64),
  superseded_by_binding_digest  char(64),
  subject_instance_id           text        NOT NULL CHECK (
    length(btrim(subject_instance_id)) BETWEEN 1 AND 512
  ),
  subject_source_sha            text        NOT NULL CHECK (subject_source_sha ~ '^[0-9a-f]{40}$'),
  heartbeat_digest              char(64),
  idempotency_key               text        NOT NULL UNIQUE CHECK (
    length(btrim(idempotency_key)) BETWEEN 1 AND 1024
  ),
  payload                       jsonb       NOT NULL,
  fact_digest                   char(64)    NOT NULL UNIQUE CHECK (outcome_valid_digest(fact_digest)),
  recorded_at                   timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (component, logical_time),
  FOREIGN KEY (component, binding_digest)
    REFERENCES executable_runtime_binding(component, binding_digest)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (component, superseded_by_binding_digest)
    REFERENCES executable_runtime_binding(component, binding_digest)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (heartbeat_digest)
    REFERENCES executable_runtime_heartbeat(heartbeat_digest)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK (fact_digest = outcome_sha256_json(payload)),
  CHECK (
    (kind = 'OBSOLETED' AND binding_digest IS NULL
      AND superseded_by_binding_digest IS NOT NULL AND heartbeat_digest IS NOT NULL)
    OR
    (kind = 'CURRENT_REGISTERED' AND binding_digest IS NOT NULL
      AND superseded_by_binding_digest IS NULL AND heartbeat_digest IS NULL)
    OR
    (kind = 'SUPERSEDED' AND binding_digest IS NOT NULL
      AND superseded_by_binding_digest IS NOT NULL AND heartbeat_digest IS NULL
      AND binding_digest <> superseded_by_binding_digest)
    OR
    (kind = 'HEARTBEAT_INGESTED' AND binding_digest IS NOT NULL
      AND superseded_by_binding_digest IS NULL AND heartbeat_digest IS NOT NULL)
  )
);

CREATE INDEX executable_runtime_binding_fact_subject_idx
  ON executable_runtime_binding_fact(
    component, binding_digest, logical_time DESC, fact_id DESC
  );
CREATE INDEX executable_runtime_binding_fact_legacy_idx
  ON executable_runtime_binding_fact(component, heartbeat_digest)
  WHERE kind = 'OBSOLETED';

CREATE TRIGGER executable_runtime_binding_append_only
  BEFORE UPDATE OR DELETE ON executable_runtime_binding
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER executable_runtime_binding_fact_append_only
  BEFORE UPDATE OR DELETE ON executable_runtime_binding_fact
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();

ALTER TABLE executable_runtime_heartbeat
  ADD COLUMN runtime_binding_digest char(64),
  ADD COLUMN runtime_binding_logical_time bigint;
ALTER TABLE executable_runtime_heartbeat
  ADD CONSTRAINT executable_runtime_heartbeat_binding_shape_chk CHECK (
    (runtime_binding_digest IS NULL AND runtime_binding_logical_time IS NULL)
    OR
    (outcome_valid_digest(runtime_binding_digest)
      AND runtime_binding_logical_time IS NOT NULL
      AND runtime_binding_logical_time > 0
      AND component = 'outcome-watchdog')
  ),
  ADD CONSTRAINT executable_runtime_heartbeat_binding_fk
    FOREIGN KEY (component, runtime_binding_digest)
    REFERENCES executable_runtime_binding(component, binding_digest)
    ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX executable_runtime_heartbeat_binding_watermark_idx
  ON executable_runtime_heartbeat(component, runtime_binding_logical_time)
  WHERE runtime_binding_digest IS NOT NULL;
CREATE INDEX executable_runtime_heartbeat_binding_latest_idx
  ON executable_runtime_heartbeat(
    component, runtime_binding_digest, runtime_binding_logical_time DESC, id DESC
  ) WHERE runtime_binding_digest IS NOT NULL;

-- One component-wide binding registration.  Two starting instances may both be valid deployment
-- expectations, but this lock makes their current-binding cuts linearizable: the later register
-- appends a supersession rather than creating two current rows.
CREATE OR REPLACE FUNCTION executable_runtime_register_current_binding(
  p_component text,
  p_instance_id text,
  p_generation uuid,
  p_source_sha text,
  p_target_sha text,
  p_target_ref text,
  p_module_graph_digest text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  v_expectation executable_runtime_expectation%ROWTYPE;
  v_existing executable_runtime_binding%ROWTYPE;
  v_current executable_runtime_binding%ROWTYPE;
  v_legacy executable_runtime_heartbeat%ROWTYPE;
  v_binding jsonb;
  v_binding_digest char(64);
  v_payload jsonb;
  v_fact_digest char(64);
  v_now timestamptz := clock_timestamp();
  v_logical bigint;
  v_registered_logical bigint;
  v_obsoleted integer := 0;
BEGIN
  IF p_component <> 'outcome-watchdog'
     OR length(btrim(COALESCE(p_instance_id, ''))) NOT BETWEEN 1 AND 512
     OR p_generation IS NULL
     OR COALESCE(p_source_sha, '') !~ '^[0-9a-f]{40}$'
     OR COALESCE(p_target_sha, '') !~ '^[0-9a-f]{40}$'
     OR length(btrim(COALESCE(p_target_ref, ''))) NOT BETWEEN 1 AND 1024
     OR p_target_ref !~ '^refs/'
     OR NOT COALESCE(outcome_valid_digest(p_module_graph_digest), false) THEN
    RAISE EXCEPTION 'EXECUTABLE_RUNTIME_BINDING_ARGUMENT_INVALID'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat('runtime-current-binding:v1:', p_component), 0
  ));
  INSERT INTO executable_runtime_binding_stream(component)
  VALUES (p_component) ON CONFLICT DO NOTHING;
  SELECT last_logical_time INTO STRICT v_logical
    FROM executable_runtime_binding_stream
   WHERE component = p_component FOR UPDATE;

  SELECT expectation.* INTO v_expectation
    FROM executable_runtime_expectation expectation
    JOIN LATERAL (
      SELECT event.kind
        FROM executable_runtime_expectation_event event
       WHERE event.generation = expectation.generation
       ORDER BY event.recorded_at DESC, event.event_id DESC LIMIT 1
    ) latest ON true
   WHERE expectation.generation = p_generation
     AND expectation.component = p_component
     AND expectation.instance_id = p_instance_id
     AND latest.kind = 'ACTIVATED';
  IF NOT FOUND
     OR v_expectation.expected_source_sha IS DISTINCT FROM p_source_sha
     OR v_expectation.module_graph_digest::text IS DISTINCT FROM p_module_graph_digest THEN
    RAISE EXCEPTION 'EXECUTABLE_RUNTIME_BINDING_EXPECTATION_MISMATCH:%', p_generation
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  v_binding := jsonb_build_object(
    'schemaVersion', 1,
    'component', p_component,
    'expectationGeneration', p_generation::text,
    'expectationDigest', v_expectation.expectation_digest::text,
    'instanceId', p_instance_id,
    'sourceSha', p_source_sha,
    'targetSha', p_target_sha,
    'targetRef', p_target_ref,
    'moduleGraphDigest', p_module_graph_digest
  );
  v_binding_digest := outcome_sha256_json(v_binding);

  SELECT * INTO v_existing FROM executable_runtime_binding binding
   WHERE binding.component = p_component
     AND binding.expectation_generation = p_generation;
  IF FOUND THEN
    IF v_existing.binding_digest IS DISTINCT FROM v_binding_digest THEN
      RAISE EXCEPTION 'EXECUTABLE_RUNTIME_BINDING_IDEMPOTENCY_CONFLICT:%', p_generation
        USING ERRCODE = 'unique_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM executable_runtime_binding_fact fact
       WHERE fact.component = p_component
         AND fact.binding_digest = v_existing.binding_digest
         AND fact.kind = 'SUPERSEDED'
    ) THEN
      RAISE EXCEPTION 'EXECUTABLE_RUNTIME_STALE_BINDING_CANNOT_REACTIVATE:%',
        v_existing.binding_digest USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    SELECT fact.logical_time INTO STRICT v_registered_logical
      FROM executable_runtime_binding_fact fact
     WHERE fact.component = p_component
       AND fact.binding_digest = v_existing.binding_digest
       AND fact.kind = 'CURRENT_REGISTERED';
    RETURN jsonb_build_object(
      'component', p_component,
      'instanceId', p_instance_id,
      'generation', p_generation::text,
      'bindingDigest', v_existing.binding_digest::text,
      'registeredLogicalTime', v_registered_logical::text,
      'registeredAt', v_existing.registered_at,
      'obsoletedLegacyInstances', 0,
      'replayed', true
    );
  END IF;

  SELECT binding.* INTO v_current
    FROM executable_runtime_binding binding
    JOIN executable_runtime_binding_fact registered
      ON registered.component = binding.component
     AND registered.binding_digest = binding.binding_digest
     AND registered.kind = 'CURRENT_REGISTERED'
   WHERE binding.component = p_component
     AND NOT EXISTS (
       SELECT 1 FROM executable_runtime_binding_fact terminal
        WHERE terminal.component = binding.component
          AND terminal.binding_digest = binding.binding_digest
          AND terminal.kind = 'SUPERSEDED'
     )
   ORDER BY registered.logical_time DESC LIMIT 1;

  INSERT INTO executable_runtime_binding(
    binding_digest, component, expectation_generation, expectation_digest,
    instance_id, source_sha, target_sha, target_ref, module_graph_digest,
    binding, registered_at
  ) VALUES (
    v_binding_digest, p_component, p_generation, v_expectation.expectation_digest,
    p_instance_id, p_source_sha, p_target_sha, p_target_ref, p_module_graph_digest,
    v_binding, v_now
  );

  IF v_current.binding_digest IS NOT NULL THEN
    v_logical := v_logical + 1;
    v_payload := jsonb_build_object(
      'schemaVersion', 1, 'kind', 'SUPERSEDED', 'component', p_component,
      'logicalTime', v_logical::text,
      'bindingDigest', v_current.binding_digest::text,
      'instanceId', v_current.instance_id,
      'sourceSha', v_current.source_sha,
      'supersededByBindingDigest', v_binding_digest::text,
      'supersededByGeneration', p_generation::text,
      'reasonCode', 'REPLACED_BY_CURRENT_WATCHDOG_BINDING'
    );
    v_fact_digest := outcome_sha256_json(v_payload);
    INSERT INTO executable_runtime_binding_fact(
      fact_id, component, logical_time, kind, binding_digest,
      superseded_by_binding_digest, subject_instance_id, subject_source_sha,
      heartbeat_digest, idempotency_key, payload, fact_digest, recorded_at
    ) VALUES (
      gen_random_uuid(), p_component, v_logical, 'SUPERSEDED',
      v_current.binding_digest, v_binding_digest, v_current.instance_id,
      v_current.source_sha, NULL,
      concat('runtime-binding:superseded:', v_current.binding_digest::text, ':',
        v_binding_digest::text), v_payload, v_fact_digest, v_now
    );
  END IF;

  v_logical := v_logical + 1;
  v_registered_logical := v_logical;
  v_payload := jsonb_build_object(
    'schemaVersion', 1, 'kind', 'CURRENT_REGISTERED', 'component', p_component,
    'logicalTime', v_logical::text, 'bindingDigest', v_binding_digest::text,
    'instanceId', p_instance_id, 'sourceSha', p_source_sha,
    'targetSha', p_target_sha, 'targetRef', p_target_ref,
    'expectationGeneration', p_generation::text,
    'expectationDigest', v_expectation.expectation_digest::text,
    'registeredAt', v_now
  );
  v_fact_digest := outcome_sha256_json(v_payload);
  INSERT INTO executable_runtime_binding_fact(
    fact_id, component, logical_time, kind, binding_digest,
    superseded_by_binding_digest, subject_instance_id, subject_source_sha,
    heartbeat_digest, idempotency_key, payload, fact_digest, recorded_at
  ) VALUES (
    gen_random_uuid(), p_component, v_logical, 'CURRENT_REGISTERED',
    v_binding_digest, NULL, p_instance_id, p_source_sha, NULL,
    concat('runtime-binding:registered:', v_binding_digest::text),
    v_payload, v_fact_digest, v_now
  );

  -- Pre-expectation instance identities have no generation row to retire.  Keep their heartbeat
  -- chains intact and append one explicit obsoletion fact for the latest digest of each instance.
  FOR v_legacy IN
    SELECT DISTINCT ON (heartbeat.component, heartbeat.instance_id) heartbeat.*
      FROM executable_runtime_heartbeat heartbeat
     WHERE heartbeat.component = p_component
       AND heartbeat.expectation_generation IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM executable_runtime_binding_fact obsolete
          WHERE obsolete.component = heartbeat.component
            AND obsolete.kind = 'OBSOLETED'
            AND obsolete.heartbeat_digest = heartbeat.heartbeat_digest
       )
     ORDER BY heartbeat.component, heartbeat.instance_id, heartbeat.sequence DESC
  LOOP
    v_logical := v_logical + 1;
    v_payload := jsonb_build_object(
      'schemaVersion', 1, 'kind', 'OBSOLETED', 'component', p_component,
      'logicalTime', v_logical::text,
      'legacyInstanceId', v_legacy.instance_id,
      'legacySourceSha', v_legacy.source_sha,
      'legacyHeartbeatDigest', v_legacy.heartbeat_digest::text,
      'legacyObservedAt', v_legacy.observed_at,
      'legacyDeadlineAt', v_legacy.deadline_at,
      'supersededByBindingDigest', v_binding_digest::text,
      'reasonCode', 'LEGACY_INSTANCE_REPLACED_BY_CURRENT_BINDING'
    );
    v_fact_digest := outcome_sha256_json(v_payload);
    INSERT INTO executable_runtime_binding_fact(
      fact_id, component, logical_time, kind, binding_digest,
      superseded_by_binding_digest, subject_instance_id, subject_source_sha,
      heartbeat_digest, idempotency_key, payload, fact_digest, recorded_at
    ) VALUES (
      gen_random_uuid(), p_component, v_logical, 'OBSOLETED', NULL,
      v_binding_digest, v_legacy.instance_id, v_legacy.source_sha,
      v_legacy.heartbeat_digest,
      concat('runtime-binding:obsolete:', v_legacy.heartbeat_digest::text, ':',
        v_binding_digest::text), v_payload, v_fact_digest, v_now
    );
    v_obsoleted := v_obsoleted + 1;
  END LOOP;

  UPDATE executable_runtime_binding_stream
     SET last_logical_time = v_logical, updated_at = clock_timestamp()
   WHERE component = p_component;
  RETURN jsonb_build_object(
    'component', p_component,
    'instanceId', p_instance_id,
    'generation', p_generation::text,
    'bindingDigest', v_binding_digest::text,
    'registeredLogicalTime', v_registered_logical::text,
    'registeredAt', v_now,
    'obsoletedLegacyInstances', v_obsoleted,
    'replayed', false
  );
END;
$$;

-- The heartbeat row and its canonical runtime fact share one transaction and one stream lock.
-- A process whose binding was superseded cannot keep an old deployment healthy by continuing to
-- emit heartbeats after the replacement registered.
CREATE OR REPLACE FUNCTION executable_runtime_append_current_heartbeat(
  p_component text,
  p_instance_id text,
  p_generation uuid,
  p_source_sha text,
  p_module_graph_digest text,
  p_observed_at timestamptz,
  p_deadline_at timestamptz,
  p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  v_binding executable_runtime_binding%ROWTYPE;
  v_sequence bigint;
  v_previous_digest char(64);
  v_payload_digest char(64);
  v_heartbeat_digest char(64);
  v_logical bigint;
  v_fact_payload jsonb;
  v_fact_digest char(64);
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_component <> 'outcome-watchdog'
     OR length(btrim(COALESCE(p_instance_id, ''))) NOT BETWEEN 1 AND 512
     OR p_generation IS NULL
     OR COALESCE(p_source_sha, '') !~ '^[0-9a-f]{40}$'
     OR NOT COALESCE(outcome_valid_digest(p_module_graph_digest), false)
     OR p_observed_at IS NULL OR p_deadline_at IS NULL
     OR p_deadline_at <= p_observed_at
     OR jsonb_typeof(COALESCE(p_payload, 'null'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'EXECUTABLE_RUNTIME_BOUND_HEARTBEAT_ARGUMENT_INVALID'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat('runtime-current-binding:v1:', p_component), 0
  ));
  SELECT last_logical_time INTO STRICT v_logical
    FROM executable_runtime_binding_stream
   WHERE component = p_component FOR UPDATE;
  SELECT binding.* INTO v_binding
    FROM executable_runtime_binding binding
    JOIN executable_runtime_binding_fact registered
      ON registered.component = binding.component
     AND registered.binding_digest = binding.binding_digest
     AND registered.kind = 'CURRENT_REGISTERED'
   WHERE binding.component = p_component
     AND binding.expectation_generation = p_generation
     AND NOT EXISTS (
       SELECT 1 FROM executable_runtime_binding_fact terminal
        WHERE terminal.component = binding.component
          AND terminal.binding_digest = binding.binding_digest
          AND terminal.kind = 'SUPERSEDED'
     )
   ORDER BY registered.logical_time DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'EXECUTABLE_RUNTIME_HEARTBEAT_BINDING_NOT_CURRENT:%', p_generation
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_binding.instance_id IS DISTINCT FROM p_instance_id
     OR v_binding.source_sha IS DISTINCT FROM p_source_sha
     OR v_binding.module_graph_digest::text IS DISTINCT FROM p_module_graph_digest THEN
    -- Preserve the pre-binding API contract: a heartbeat aimed at the current generation but
    -- carrying different instance/source/module identity is an expectation mismatch.  A
    -- superseded generation reaches the branch above and remains a binding-not-current error.
    RAISE EXCEPTION 'EXECUTABLE_RUNTIME_HEARTBEAT_EXPECTATION_MISMATCH:%', p_generation
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT heartbeat.sequence, heartbeat.heartbeat_digest
    INTO v_sequence, v_previous_digest
    FROM executable_runtime_heartbeat heartbeat
   WHERE heartbeat.component = p_component
     AND heartbeat.instance_id = p_instance_id
   ORDER BY heartbeat.sequence DESC LIMIT 1;
  v_sequence := COALESCE(v_sequence, 0) + 1;
  v_logical := v_logical + 1;
  v_payload_digest := encode(digest(p_payload::text, 'sha256'), 'hex');
  v_heartbeat_digest := encode(digest(jsonb_build_object(
    'component', p_component,
    'instanceId', p_instance_id,
    'sequence', v_sequence,
    'sourceSha', p_source_sha,
    'moduleGraphDigest', p_module_graph_digest,
    'expectationGeneration', p_generation,
    'runtimeBindingDigest', v_binding.binding_digest::text,
    'runtimeBindingLogicalTime', v_logical,
    'observedAt', p_observed_at,
    'deadlineAt', p_deadline_at,
    'payloadDigest', v_payload_digest,
    'previousDigest', v_previous_digest
  )::text, 'sha256'), 'hex');

  INSERT INTO executable_runtime_heartbeat(
    id, component, instance_id, sequence, source_sha, module_graph_digest,
    observed_at, deadline_at, payload, payload_digest, previous_digest,
    heartbeat_digest, expectation_generation, runtime_binding_digest,
    runtime_binding_logical_time
  ) VALUES (
    gen_random_uuid(), p_component, p_instance_id, v_sequence, p_source_sha,
    p_module_graph_digest, p_observed_at, p_deadline_at, p_payload,
    v_payload_digest, v_previous_digest, v_heartbeat_digest, p_generation,
    v_binding.binding_digest, v_logical
  );

  v_fact_payload := jsonb_build_object(
    'schemaVersion', 1, 'kind', 'HEARTBEAT_INGESTED', 'component', p_component,
    'logicalTime', v_logical::text,
    'bindingDigest', v_binding.binding_digest::text,
    'instanceId', p_instance_id, 'sourceSha', p_source_sha,
    'targetSha', v_binding.target_sha, 'targetRef', v_binding.target_ref,
    'expectationGeneration', p_generation::text,
    'sequence', v_sequence::text,
    'heartbeatDigest', v_heartbeat_digest::text,
    'previousHeartbeatDigest', v_previous_digest::text,
    'observedAt', p_observed_at, 'deadlineAt', p_deadline_at,
    'payloadDigest', v_payload_digest::text
  );
  v_fact_digest := outcome_sha256_json(v_fact_payload);
  INSERT INTO executable_runtime_binding_fact(
    fact_id, component, logical_time, kind, binding_digest,
    superseded_by_binding_digest, subject_instance_id, subject_source_sha,
    heartbeat_digest, idempotency_key, payload, fact_digest, recorded_at
  ) VALUES (
    gen_random_uuid(), p_component, v_logical, 'HEARTBEAT_INGESTED',
    v_binding.binding_digest, NULL, p_instance_id, p_source_sha,
    v_heartbeat_digest, concat('runtime-binding:heartbeat:', v_heartbeat_digest::text),
    v_fact_payload, v_fact_digest, v_now
  );
  UPDATE executable_runtime_binding_stream
     SET last_logical_time = v_logical, updated_at = clock_timestamp()
   WHERE component = p_component;
  RETURN jsonb_build_object(
    'heartbeatDigest', v_heartbeat_digest::text,
    'sequence', v_sequence::text,
    'bindingDigest', v_binding.binding_digest::text,
    'evaluatedThroughLogicalTime', v_logical::text
  );
END;
$$;

CREATE VIEW executable_runtime_current_binding AS
WITH current_binding AS (
  SELECT binding.*, registered.logical_time AS registered_logical_time,
         registered.fact_digest AS registered_fact_digest
    FROM executable_runtime_binding binding
    JOIN executable_runtime_binding_fact registered
      ON registered.component = binding.component
     AND registered.binding_digest = binding.binding_digest
     AND registered.kind = 'CURRENT_REGISTERED'
   WHERE NOT EXISTS (
     SELECT 1 FROM executable_runtime_binding_fact terminal
      WHERE terminal.component = binding.component
        AND terminal.binding_digest = binding.binding_digest
        AND terminal.kind = 'SUPERSEDED'
   )
), latest_heartbeat AS (
  SELECT DISTINCT ON (heartbeat.runtime_binding_digest) heartbeat.*
    FROM executable_runtime_heartbeat heartbeat
   WHERE heartbeat.runtime_binding_digest IS NOT NULL
   ORDER BY heartbeat.runtime_binding_digest,
            heartbeat.runtime_binding_logical_time DESC, heartbeat.id DESC
), latest_event AS (
  SELECT DISTINCT ON (event.expectation_generation) event.*
    FROM executable_dead_man_event event
   WHERE event.expectation_generation IS NOT NULL
   ORDER BY event.expectation_generation, event.checked_at DESC,
            event.created_at DESC, event.id DESC
)
SELECT binding.component, binding.binding_digest, binding.expectation_generation,
       binding.expectation_digest, binding.instance_id, binding.source_sha,
       binding.target_sha, binding.target_ref, binding.module_graph_digest,
       binding.binding, binding.registered_at, binding.registered_logical_time,
       binding.registered_fact_digest,
       heartbeat.sequence AS heartbeat_sequence,
       heartbeat.heartbeat_digest, heartbeat.previous_digest,
       heartbeat.observed_at, heartbeat.deadline_at,
       heartbeat.runtime_binding_logical_time AS evaluated_through_logical_time,
       event.kind AS last_event_kind,
       expectation.startup_deadline_at,
       CASE
         WHEN heartbeat.id IS NULL AND now() <= expectation.startup_deadline_at THEN 'STARTING'
         WHEN heartbeat.id IS NULL THEN 'WATCHDOG_STALE'
         WHEN now() > heartbeat.deadline_at THEN 'WATCHDOG_STALE'
         WHEN event.kind IN ('WATCHDOG_STALE', 'WATCHDOG_MISSING')
              AND event.checked_at >= heartbeat.observed_at THEN 'WATCHDOG_STALE'
         ELSE 'HEALTHY'
       END AS state,
       CASE
         WHEN heartbeat.id IS NULL AND now() <= expectation.startup_deadline_at THEN 0
         WHEN heartbeat.id IS NULL OR now() > heartbeat.deadline_at
           OR (event.kind IN ('WATCHDOG_STALE', 'WATCHDOG_MISSING')
               AND event.checked_at >= heartbeat.observed_at) THEN 1
         ELSE 0
       END::integer AS active_obligation_count
  FROM current_binding binding
  JOIN executable_runtime_expectation expectation
    ON expectation.generation = binding.expectation_generation
  LEFT JOIN latest_heartbeat heartbeat
    ON heartbeat.runtime_binding_digest = binding.binding_digest
  LEFT JOIN latest_event event
    ON event.expectation_generation = binding.expectation_generation;

-- Preserve the legacy surface shape for every caller.  For outcome-watchdog, a current binding is
-- authoritative.  Before its first registration an active expectation is the fail-closed source;
-- unbound legacy instances are consulted only when no expectation or binding exists at all.
CREATE OR REPLACE VIEW executable_runtime_liveness AS
WITH latest_legacy_heartbeat AS (
  SELECT DISTINCT ON (heartbeat.component, heartbeat.instance_id) heartbeat.*
    FROM executable_runtime_heartbeat heartbeat
   WHERE heartbeat.expectation_generation IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM executable_runtime_active_expectation expectation
        WHERE expectation.component = heartbeat.component
     )
     AND NOT EXISTS (
       SELECT 1 FROM executable_runtime_current_binding binding
        WHERE binding.component = heartbeat.component
     )
   ORDER BY heartbeat.component, heartbeat.instance_id, heartbeat.sequence DESC
), latest_legacy_event AS (
  SELECT DISTINCT ON (event.component, event.instance_id) event.*
    FROM executable_dead_man_event event
   WHERE event.expectation_generation IS NULL
   ORDER BY event.component, event.instance_id, event.checked_at DESC, event.created_at DESC
)
SELECT binding.component, binding.instance_id, binding.source_sha,
       COALESCE(binding.heartbeat_digest, binding.binding_digest) AS heartbeat_digest,
       COALESCE(binding.observed_at, binding.registered_at) AS observed_at,
       COALESCE(binding.deadline_at, binding.startup_deadline_at) AS deadline_at,
       binding.last_event_kind, binding.state, binding.active_obligation_count
  FROM executable_runtime_current_binding binding
UNION ALL
SELECT expected.component, expected.instance_id, expected.expected_source_sha AS source_sha,
       COALESCE(expected.heartbeat_digest, expected.expectation_digest) AS heartbeat_digest,
       COALESCE(expected.observed_at, expected.activated_at) AS observed_at,
       COALESCE(expected.deadline_at, expected.startup_deadline_at) AS deadline_at,
       COALESCE(expected.last_event_kind, expected.condition_code)::text AS last_event_kind,
       expected.state::text AS state,
       CASE WHEN expected.state = 'WATCHDOG_STALE' THEN 1 ELSE 0 END::integer
         AS active_obligation_count
  FROM executable_runtime_expected_liveness expected
 WHERE expected.component <> 'outcome-watchdog'
    OR NOT EXISTS (
      SELECT 1 FROM executable_runtime_current_binding binding
       WHERE binding.component = expected.component
    )
UNION ALL
SELECT heartbeat.component, heartbeat.instance_id, heartbeat.source_sha,
       heartbeat.heartbeat_digest, heartbeat.observed_at, heartbeat.deadline_at,
       event.kind AS last_event_kind,
       CASE
         WHEN now() > heartbeat.deadline_at THEN 'WATCHDOG_STALE'
         WHEN event.kind = 'WATCHDOG_STALE' AND event.checked_at >= heartbeat.observed_at
           THEN 'WATCHDOG_STALE'
         ELSE 'HEALTHY'
       END AS state,
       CASE
         WHEN now() > heartbeat.deadline_at
           OR (event.kind = 'WATCHDOG_STALE' AND event.checked_at >= heartbeat.observed_at)
         THEN 1 ELSE 0
       END::integer AS active_obligation_count
  FROM latest_legacy_heartbeat heartbeat
  LEFT JOIN latest_legacy_event event USING (component, instance_id);

-- The direct read overlay now reports the healthy current binding as well as stale obligations.
-- This lets project_acceptance expose which generation/watermark it actually consulted, while a
-- historical obsolete heartbeat remains queryable only through the immutable audit ledger.
CREATE OR REPLACE FUNCTION executable_runtime_overlay_read_surface(
  p_payload jsonb,
  p_surface text
) RETURNS jsonb AS $$
DECLARE
  payload_value jsonb := COALESCE(p_payload, '{}'::jsonb);
  runtime_bindings jsonb;
  runtime_obligations jsonb;
  existing_obligations jsonb;
  existing_blocking jsonb;
  primary_obligation jsonb;
  merged_obligations jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'component', binding.component,
    'bindingDigest', binding.binding_digest,
    'registeredFactDigest', binding.registered_fact_digest,
    'generation', binding.expectation_generation,
    'expectationDigest', binding.expectation_digest,
    'instanceId', binding.instance_id,
    'sourceSha', binding.source_sha,
    'targetSha', binding.target_sha,
    'targetRef', binding.target_ref,
    'registeredAt', binding.registered_at,
    'registeredLogicalTime', binding.registered_logical_time::text,
    'heartbeatDigest', binding.heartbeat_digest,
    'heartbeatSequence', binding.heartbeat_sequence::text,
    'evaluatedThroughLogicalTime', binding.evaluated_through_logical_time::text,
    'state', binding.state
  ) ORDER BY binding.component), '[]'::jsonb)
    INTO runtime_bindings
    FROM executable_runtime_current_binding binding;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'obligationId', encode(digest(concat(
      'WATCHDOG_STALE', E'\n', live.component, E'\n', live.instance_id
    ), 'sha256'), 'hex'),
    'obligationRevision', live.heartbeat_digest,
    'bindingDigest', COALESCE(binding.binding_digest, live.heartbeat_digest),
    'binding', jsonb_build_object(
      'component', live.component,
      'instanceId', live.instance_id,
      'sourceSha', live.source_sha,
      'targetSha', binding.target_sha,
      'targetRef', binding.target_ref,
      'generation', binding.expectation_generation,
      'bindingDigest', binding.binding_digest,
      'heartbeatDigest', live.heartbeat_digest
    ),
    'kind', 'WATCHDOG_STALE',
    'owner', 'SYSTEM',
    'capability', 'watchdog.heartbeat',
    'reason', jsonb_build_object(
      'code', 'WATCHDOG_STALE',
      'category', 'RUNTIME_LIVENESS',
      'message', concat('External dead-man observed an expired watchdog heartbeat for ',
        live.instance_id, '.'),
      'owner', 'SYSTEM',
      'actor', 'EXTERNAL_DEAD_MAN',
      'nextAction', 'RESTORE_WATCHDOG_HEARTBEAT',
      'blocksGate', true,
      'evidenceFactIds', CASE
        WHEN binding.registered_fact_digest IS NULL
          THEN jsonb_build_array(live.heartbeat_digest)
        ELSE jsonb_build_array(binding.registered_fact_digest, live.heartbeat_digest)
      END,
      'attemptedActions', '[]'::jsonb,
      'detail', jsonb_build_object(
        'component', live.component,
        'instanceId', live.instance_id,
        'observedAt', live.observed_at,
        'deadlineAt', live.deadline_at,
        'lastEventKind', live.last_event_kind,
        'generation', binding.expectation_generation,
        'targetSha', binding.target_sha
      )
    ),
    'evaluatedThroughLogicalTime', binding.evaluated_through_logical_time::text,
    'projectionRevision', binding.registered_logical_time::text,
    'staleness', 'WATCHDOG_STALE'
  ) ORDER BY live.component, live.instance_id), '[]'::jsonb)
    INTO runtime_obligations
    FROM executable_runtime_liveness live
    LEFT JOIN executable_runtime_current_binding binding
      ON binding.component = live.component AND binding.instance_id = live.instance_id
   WHERE live.state = 'WATCHDOG_STALE';

  payload_value := payload_value || jsonb_build_object('runtimeBindings', runtime_bindings);
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

REVOKE INSERT, UPDATE, DELETE ON executable_runtime_binding FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON executable_runtime_binding_fact FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON executable_runtime_binding_stream FROM PUBLIC;

COMMENT ON TABLE executable_runtime_binding IS
  'Immutable target-SHA and deployment-generation identity for a singleton outcome-watchdog binding.';
COMMENT ON TABLE executable_runtime_binding_fact IS
  'Append-only current/superseded/obsolete/heartbeat facts with a component logical watermark.';
COMMENT ON VIEW executable_runtime_current_binding IS
  'Exactly one current outcome-watchdog binding and its latest evaluated-through heartbeat watermark.';

COMMIT;
