-- An acceptance shell can have durable terminal output while its completion callback is rejected
-- forever by the control plane.  This migration gives that condition its own canonical,
-- append-only facts and an obligation reduced from those facts.  Detection is protocol-version
-- neutral across the reserved v1/v2 acceptance lanes and deliberately does not read or manufacture
-- executable admission/attempt rows.
--
-- Clocks are part of the trust boundary.  Caller and runner timestamps are retained only inside
-- evidence; every SLO decision, bucket and ordering key below is stamped by PostgreSQL.

BEGIN;

-- A terminal runner event becomes eligible for the completion-ACK SLO only after the database has
-- ingested it.  created_at is runner/caller data and conversation_turn.delivered_at is the start
-- of the command, so neither can be the dead-man clock. Existing rows remain NULL (no high-volume
-- rewrite) and use one immutable rollout epoch, receiving a full window instead of alarming now.
ALTER TABLE run_event
  ADD COLUMN ingested_at timestamptz,
  ADD COLUMN ingested_by_runner_id uuid,
  ADD COLUMN ingested_under_lease_generation uuid;
ALTER TABLE run_event ALTER COLUMN ingested_at SET DEFAULT clock_timestamp();

CREATE TABLE completion_ack_rollout_epoch (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  rollout_recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT completion_ack_rollout_singleton_chk CHECK (singleton = true)
);
INSERT INTO completion_ack_rollout_epoch(singleton) VALUES (true);

CREATE OR REPLACE FUNCTION completion_ack_rollout_epoch_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'COMPLETION_ACK_ROLLOUT_EPOCH_APPEND_ONLY'
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$$;
CREATE TRIGGER completion_ack_rollout_epoch_append_only
  BEFORE UPDATE OR DELETE ON completion_ack_rollout_epoch
  FOR EACH ROW EXECUTE FUNCTION completion_ack_rollout_epoch_append_only();

CREATE OR REPLACE FUNCTION run_event_completion_ack_ingestion_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.ingested_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF NEW.ingested_at IS DISTINCT FROM OLD.ingested_at THEN
    RAISE EXCEPTION 'RUN_EVENT_INGESTED_AT_DB_OWNED:%', OLD.id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW.ingested_by_runner_id IS DISTINCT FROM OLD.ingested_by_runner_id
     OR NEW.ingested_under_lease_generation
        IS DISTINCT FROM OLD.ingested_under_lease_generation THEN
    RAISE EXCEPTION 'RUN_EVENT_INGESTION_PROVENANCE_IMMUTABLE:%', OLD.id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER run_event_completion_ack_ingestion_guard
  BEFORE INSERT OR UPDATE OF ingested_at, ingested_by_runner_id,
    ingested_under_lease_generation ON run_event
  FOR EACH ROW EXECUTE FUNCTION run_event_completion_ack_ingestion_guard();

COMMENT ON COLUMN run_event.ingested_at IS
  'Nullable for pre-0201 history; new inserts are DB-clocked. Historical NULL uses completion_ack_rollout_epoch and gets a full detection window without a high-volume rewrite.';
COMMENT ON COLUMN run_event.ingested_by_runner_id IS
  'Immutable UUID identity snapshot, intentionally no FK so runner unregister/delete is not blocked; NULL means historical LEGACY_INFERRED provenance.';
COMMENT ON COLUMN run_event.ingested_under_lease_generation IS
  'Exact API-validated turn lease generation when available. No FK: inbox_lease_generation cascades with Session while run_event has its own Session cascade.';

CREATE OR REPLACE FUNCTION completion_ack_json_digest(p_value jsonb)
RETURNS char(64) LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT encode(digest(convert_to(COALESCE(p_value, 'null'::jsonb)::text, 'UTF8'), 'sha256'), 'hex')::char(64)
$$;

CREATE OR REPLACE FUNCTION completion_ack_sanitize_evidence(p_kind text, p_value jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  v_value jsonb := COALESCE(p_value, '{}'::jsonb);
  v_message text;
  v_message_digest text;
  v_observed_error_fingerprint text;
BEGIN
  IF jsonb_typeof(v_value) <> 'object' THEN RETURN '{}'::jsonb; END IF;
  v_observed_error_fingerprint := NULLIF(
    btrim(v_value->>'observedErrorFingerprint'), ''
  );
  IF v_observed_error_fingerprint IS NOT NULL
     AND length(v_observed_error_fingerprint) > 512 THEN
    RAISE EXCEPTION 'COMPLETION_ACK_OBSERVED_FINGERPRINT_INVALID'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_kind = 'CONTROL_PLANE_COMMIT_REJECTED' THEN
    v_message := concat_ws(E'\n', v_value->>'message', v_value->>'databaseMessage');
    v_message_digest := NULLIF(v_value->>'messageDigest', '');
    IF v_message_digest IS NOT NULL AND v_message_digest !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'COMPLETION_ACK_MESSAGE_DIGEST_INVALID'
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_message_digest IS NULL AND v_message <> '' THEN
      v_message_digest := completion_ack_json_digest(
        jsonb_build_array('completion-ack-error:v1', v_message)
      )::text;
    END IF;
    RETURN jsonb_strip_nulls(jsonb_build_object(
      'source', v_value->'source',
      'endpoint', v_value->'endpoint',
      'prismaCode', v_value->'prismaCode',
      'sqlstate', v_value->'sqlstate',
      'invariant', v_value->'invariant',
      'messageDigest', v_message_digest,
      'errorDigest', v_message_digest,
      'runnerId', v_value->'runnerId',
      'callbackStatus', v_value->'callbackStatus',
      'callbackSubtype', v_value->'callbackSubtype',
      'turnClientId', v_value->'turnClientId',
      'executionProtocol', v_value->'executionProtocol',
      'observedErrorFingerprint', v_observed_error_fingerprint
    ));
  ELSIF p_kind = 'COMPLETION_ACK_STALE' THEN
    RETURN jsonb_strip_nulls(jsonb_build_object(
      'source', v_value->'source',
      'detectorRecordedAt', v_value->'detectorRecordedAt',
      'detectionDeltaSeconds', v_value->'detectionDeltaSeconds',
      'turnClientId', v_value->'turnClientId',
      'turnDeliveredAt', v_value->'turnDeliveredAt',
      'terminalEvent', CASE WHEN jsonb_typeof(v_value->'terminalEvent') = 'object'
        THEN jsonb_strip_nulls(jsonb_build_object(
          'id', v_value#>'{terminalEvent,id}',
          'seq', v_value#>'{terminalEvent,seq}',
          'type', v_value#>'{terminalEvent,type}',
          'sourceTime', v_value#>'{terminalEvent,sourceTime}',
          'ingestedAt', v_value#>'{terminalEvent,ingestedAt}',
          'payloadDigest', v_value#>'{terminalEvent,payloadDigest}'
        )) END,
      'sloClock', v_value->'sloClock',
      'runnerEventTimeIsSloClock', v_value->'runnerEventTimeIsSloClock',
      'ingestedRunEventId', v_value->'ingestedRunEventId',
      'ingestedAt', v_value->'ingestedAt',
      'ingestedByRunnerId', v_value->'ingestedByRunnerId',
      'ingestedUnderLeaseGeneration', v_value->'ingestedUnderLeaseGeneration',
      'runnerProvenance', v_value->'runnerProvenance',
      'leaseProvenance', v_value->'leaseProvenance',
      'executionProtocol', v_value->'executionProtocol',
      'observedErrorFingerprint', v_observed_error_fingerprint
    ));
  ELSE
    RETURN jsonb_strip_nulls(jsonb_build_object(
      'source', v_value->'source',
      'runnerId', v_value->'runnerId',
      'applied', v_value->'applied',
      'answeredAt', v_value->'answeredAt',
      'detectorRecordedAt', v_value->'detectorRecordedAt',
      'ackAuthority', v_value->'ackAuthority',
      'terminalEventId', v_value->'terminalEventId',
      'turnClientId', v_value->'turnClientId',
      'executionProtocol', v_value->'executionProtocol'
    ));
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION completion_ack_obligation_id(
  p_task_id uuid, p_session_id uuid, p_turn_id uuid, p_error_fingerprint text
) RETURNS char(64) LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT completion_ack_json_digest(jsonb_build_array(
    'completion-ack-obligation:v1', p_task_id::text, p_session_id::text,
    p_turn_id::text
  ))
$$;

CREATE OR REPLACE FUNCTION completion_ack_obligation_revision(
  p_task_id uuid, p_session_id uuid, p_turn_id uuid, p_error_fingerprint text
) RETURNS char(64) LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT completion_ack_json_digest(jsonb_build_array(
    'completion-ack-obligation-revision:v1', p_task_id::text, p_session_id::text,
    p_turn_id::text
  ))
$$;

CREATE OR REPLACE FUNCTION completion_ack_observation_bucket(p_recorded_at timestamptz)
RETURNS timestamptz LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT timestamptz '2000-01-01 00:00:00+00'
       + floor(extract(epoch FROM (p_recorded_at - timestamptz '2000-01-01 00:00:00+00')) / 15)
         * interval '15 seconds'
$$;

CREATE OR REPLACE FUNCTION completion_ack_fact_idempotency_key(
  p_obligation_revision char(64), p_fact_kind text, p_tenant_id uuid, p_project_id uuid,
  p_task_id uuid, p_session_id uuid, p_turn_id uuid, p_lease_generation uuid,
  p_error_fingerprint text, p_observation_bucket timestamptz
) RETURNS char(64) LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT completion_ack_json_digest(jsonb_build_array(
    'completion-ack-first-fact:v1', p_obligation_revision::text, p_fact_kind,
    p_tenant_id::text, p_project_id::text, p_task_id::text, p_session_id::text,
    p_turn_id::text, p_error_fingerprint
  ))
$$;

CREATE TABLE completion_ack_obligation_revision (
  obligation_id       char(64)    NOT NULL,
  obligation_revision char(64)    PRIMARY KEY,
  protocol             text        NOT NULL DEFAULT 'completion-ack-obligation:v1',
  tenant_id            uuid        NOT NULL,
  project_id           uuid        NOT NULL,
  task_id              uuid        NOT NULL,
  session_id           uuid        NOT NULL,
  turn_id              uuid        NOT NULL,
  error_fingerprint    text        NOT NULL,
  recorded_at          timestamptz NOT NULL DEFAULT statement_timestamp(),
  ingested_at          timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT completion_ack_obligation_protocol_chk
    CHECK (protocol = 'completion-ack-obligation:v1'),
  CONSTRAINT completion_ack_obligation_fingerprint_chk
    CHECK (length(btrim(error_fingerprint)) BETWEEN 1 AND 512),
  CONSTRAINT completion_ack_obligation_id_chk CHECK (
    obligation_id = completion_ack_obligation_id(task_id, session_id, turn_id, error_fingerprint)
  ),
  CONSTRAINT completion_ack_obligation_revision_chk CHECK (
    obligation_revision = completion_ack_obligation_revision(
      task_id, session_id, turn_id, error_fingerprint
    )
  ),
  CONSTRAINT completion_ack_obligation_id_revision_uniq UNIQUE (
    obligation_id, obligation_revision
  ),
  CONSTRAINT completion_ack_obligation_binding_uniq UNIQUE (
    obligation_id, obligation_revision, tenant_id, project_id, task_id,
    session_id, turn_id, error_fingerprint
  ),
  -- One acceptance execution has one ACK lifecycle.  Failure fingerprints describe observations
  -- of that lifecycle; they are not independent obligations.
  CONSTRAINT completion_ack_obligation_scope_uniq UNIQUE (
    tenant_id, task_id, session_id, turn_id
  )
);

CREATE INDEX completion_ack_obligation_project_idx
  ON completion_ack_obligation_revision(project_id, task_id, recorded_at);
CREATE INDEX completion_ack_obligation_turn_idx
  ON completion_ack_obligation_revision(session_id, turn_id);

CREATE TABLE completion_ack_fact (
  id                    uuid        PRIMARY KEY,
  obligation_id         char(64)    NOT NULL,
  obligation_revision   char(64)    NOT NULL,
  tenant_id             uuid        NOT NULL,
  project_id            uuid        NOT NULL,
  task_id               uuid        NOT NULL,
  session_id            uuid        NOT NULL,
  turn_id               uuid        NOT NULL,
  lease_generation      uuid,
  lease_provenance      text        NOT NULL DEFAULT 'LEGACY_INFERRED',
  runner_provenance     text        NOT NULL DEFAULT 'LEGACY_INFERRED',
  fact_kind             text        NOT NULL,
  error_fingerprint     text        NOT NULL,
  first_failure_at      timestamptz,
  latest_failure_at     timestamptz,
  source_observed_at    timestamptz,
  observed_at           timestamptz NOT NULL,
  recorded_at           timestamptz NOT NULL,
  ingested_at           timestamptz NOT NULL,
  observation_bucket    timestamptz NOT NULL,
  evidence_source       jsonb       NOT NULL,
  evidence_source_digest char(64)   NOT NULL,
  idempotency_key       char(64)    NOT NULL,
  fact_digest           char(64)    NOT NULL,

  CONSTRAINT completion_ack_fact_kind_chk CHECK (fact_kind IN (
    'COMPLETION_ACK_STALE', 'CONTROL_PLANE_COMMIT_REJECTED', 'COMPLETION_ACK_RECOVERED'
  )),
  CONSTRAINT completion_ack_fact_provenance_chk CHECK (
    lease_provenance IN ('LEGACY_INFERRED', 'INGESTED_EXACT')
    AND runner_provenance IN ('LEGACY_INFERRED', 'INGESTED_EXACT')
  ),
  CONSTRAINT completion_ack_fact_evidence_object_chk
    CHECK (jsonb_typeof(evidence_source) = 'object'
      AND octet_length(evidence_source::text) <= 16384),
  CONSTRAINT completion_ack_fact_db_clock_chk CHECK (
    observed_at = recorded_at
    AND ingested_at >= recorded_at
    AND observation_bucket = completion_ack_observation_bucket(recorded_at)
  ),
  CONSTRAINT completion_ack_fact_failure_window_chk CHECK (
    (fact_kind = 'COMPLETION_ACK_RECOVERED'
      AND ((first_failure_at IS NULL AND latest_failure_at IS NULL)
        OR (first_failure_at IS NOT NULL AND latest_failure_at >= first_failure_at)))
    OR
    (fact_kind <> 'COMPLETION_ACK_RECOVERED'
      AND first_failure_at IS NOT NULL AND latest_failure_at IS NOT NULL
      AND latest_failure_at >= first_failure_at AND latest_failure_at <= recorded_at)
  ),
  CONSTRAINT completion_ack_fact_evidence_digest_chk CHECK (
    evidence_source_digest = completion_ack_json_digest(evidence_source)
  ),
  CONSTRAINT completion_ack_fact_idempotency_chk CHECK (
    idempotency_key = completion_ack_fact_idempotency_key(
      obligation_revision, fact_kind, tenant_id, project_id, task_id, session_id,
      turn_id, lease_generation, error_fingerprint, observation_bucket
    )
  ),
  CONSTRAINT completion_ack_fact_event_binding_uniq UNIQUE (
    id, obligation_id, obligation_revision, fact_kind, evidence_source_digest
  ),
  CONSTRAINT completion_ack_fact_revision_fk FOREIGN KEY (
    obligation_id, obligation_revision, tenant_id, project_id, task_id,
    session_id, turn_id, error_fingerprint
  ) REFERENCES completion_ack_obligation_revision (
    obligation_id, obligation_revision, tenant_id, project_id, task_id,
    session_id, turn_id, error_fingerprint
  ) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX completion_ack_fact_idempotency_idx
  ON completion_ack_fact(idempotency_key);
CREATE UNIQUE INDEX completion_ack_fact_digest_idx
  ON completion_ack_fact(fact_digest);
CREATE INDEX completion_ack_fact_revision_time_idx
  ON completion_ack_fact(obligation_revision, recorded_at, ingested_at, id);
CREATE INDEX completion_ack_fact_project_time_idx
  ON completion_ack_fact(project_id, recorded_at DESC);
CREATE INDEX completion_ack_fact_turn_idx
  ON completion_ack_fact(session_id, turn_id, recorded_at DESC);
CREATE INDEX completion_ack_fact_kind_time_idx
  ON completion_ack_fact(fact_kind, recorded_at DESC);

CREATE TABLE completion_ack_obligation_event (
  id                    uuid        PRIMARY KEY,
  obligation_id         char(64)    NOT NULL,
  obligation_revision   char(64)    NOT NULL,
  state                 text        NOT NULL,
  source_fact_id        uuid        NOT NULL,
  source_fact_kind      text        NOT NULL,
  reason_code           text        NOT NULL,
  evidence_source       jsonb       NOT NULL,
  evidence_source_digest char(64)   NOT NULL,
  recorded_at           timestamptz NOT NULL,
  ingested_at           timestamptz NOT NULL,
  event_digest          char(64)    NOT NULL,

  CONSTRAINT completion_ack_event_state_chk CHECK (state IN ('ACTIVE', 'CLOSED')),
  CONSTRAINT completion_ack_event_reason_chk CHECK (
    (state = 'ACTIVE' AND reason_code IN (
      'COMPLETION_ACK_STALE', 'CONTROL_PLANE_COMMIT_REJECTED'
    ) AND source_fact_kind = reason_code) OR
    (state = 'CLOSED' AND reason_code = 'COMPLETION_ACK_RECOVERED'
      AND source_fact_kind = 'COMPLETION_ACK_RECOVERED')
  ),
  CONSTRAINT completion_ack_event_evidence_object_chk
    CHECK (jsonb_typeof(evidence_source) = 'object'
      AND octet_length(evidence_source::text) <= 16384),
  CONSTRAINT completion_ack_event_evidence_digest_chk CHECK (
    evidence_source_digest = completion_ack_json_digest(evidence_source)
  ),
  CONSTRAINT completion_ack_event_revision_fk
    FOREIGN KEY (obligation_id, obligation_revision)
    REFERENCES completion_ack_obligation_revision(obligation_id, obligation_revision)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT completion_ack_event_fact_fk
    FOREIGN KEY (
      source_fact_id, obligation_id, obligation_revision, source_fact_kind,
      evidence_source_digest
    ) REFERENCES completion_ack_fact(
      id, obligation_id, obligation_revision, fact_kind, evidence_source_digest
    )
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX completion_ack_event_digest_idx
  ON completion_ack_obligation_event(event_digest);
CREATE UNIQUE INDEX completion_ack_event_source_state_idx
  ON completion_ack_obligation_event(obligation_revision, source_fact_id, state);
CREATE INDEX completion_ack_event_latest_idx
  ON completion_ack_obligation_event(obligation_revision, recorded_at DESC, ingested_at DESC, id DESC);

-- Repeated transport callbacks are useful liveness telemetry, but making each one an immutable
-- fact would grow without bound (a two-second retry is 43,200 rows/day).  This register is the
-- deliberately non-authoritative exception: exactly one bounded, monotone row per obligation.
-- Identity and ACTIVE/CLOSED state remain exclusively revision/fact/event reductions.  Losing this
-- row loses retry count/last-seen precision, never completion evidence or lifecycle state.
CREATE TABLE completion_ack_observation_register (
  obligation_id              char(64)    NOT NULL,
  obligation_revision        char(64)    PRIMARY KEY,
  tenant_id                  uuid        NOT NULL,
  project_id                 uuid        NOT NULL,
  task_id                    uuid        NOT NULL,
  session_id                 uuid        NOT NULL,
  turn_id                    uuid        NOT NULL,
  error_fingerprint          text        NOT NULL,
  first_failure_at           timestamptz NOT NULL,
  latest_failure_at          timestamptz NOT NULL,
  observation_count          bigint      NOT NULL,
  meaningful_observation_count bigint    NOT NULL,
  latest_observation_key     char(64)    NOT NULL,
  recent_observations        jsonb       NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at                 timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT completion_ack_observation_register_binding_fk FOREIGN KEY (
    obligation_id, obligation_revision, tenant_id, project_id, task_id,
    session_id, turn_id, error_fingerprint
  ) REFERENCES completion_ack_obligation_revision (
    obligation_id, obligation_revision, tenant_id, project_id, task_id,
    session_id, turn_id, error_fingerprint
  ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT completion_ack_observation_register_window_chk CHECK (
    first_failure_at <= latest_failure_at
    AND latest_failure_at <= updated_at
    AND created_at <= updated_at
  ),
  CONSTRAINT completion_ack_observation_register_count_chk CHECK (
    observation_count >= 1
    AND meaningful_observation_count >= 1
    AND meaningful_observation_count <= observation_count
  ),
  CONSTRAINT completion_ack_observation_register_recent_chk CHECK (
    jsonb_typeof(recent_observations) = 'array'
    AND jsonb_array_length(recent_observations) BETWEEN 1 AND 8
    AND octet_length(recent_observations::text) <= 6144
  )
);
CREATE INDEX completion_ack_observation_register_project_idx
  ON completion_ack_observation_register(project_id, latest_failure_at DESC);

CREATE OR REPLACE FUNCTION completion_ack_bounded_observation_history(
  p_existing jsonb,
  p_observation jsonb
) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  v_existing jsonb := CASE WHEN jsonb_typeof(p_existing) = 'array'
    THEN p_existing ELSE '[]'::jsonb END;
  v_length integer := jsonb_array_length(v_existing);
  v_last jsonb;
  v_combined jsonb;
  v_result jsonb;
BEGIN
  IF jsonb_typeof(p_observation) <> 'object' THEN
    RAISE EXCEPTION 'COMPLETION_ACK_OBSERVATION_MUST_BE_OBJECT'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_length > 0 THEN
    v_last := v_existing -> (v_length - 1);
  END IF;
  IF v_last->>'observationKey' = p_observation->>'observationKey' THEN
    p_observation := p_observation || jsonb_build_object(
      'firstSeenAt', v_last->'firstSeenAt',
      'occurrences', COALESCE((v_last->>'occurrences')::bigint, 1) + 1
    );
    RETURN (v_existing - (v_length - 1)) || jsonb_build_array(p_observation);
  END IF;

  v_combined := v_existing || jsonb_build_array(p_observation);
  SELECT COALESCE(jsonb_agg(entry.value ORDER BY entry.ordinality), '[]'::jsonb)
    INTO v_result
    FROM jsonb_array_elements(v_combined) WITH ORDINALITY entry(value, ordinality)
   WHERE entry.ordinality > greatest(jsonb_array_length(v_combined) - 8, 0);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION completion_ack_observation_register_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'COMPLETION_ACK_OBSERVATION_REGISTER_DELETE_FORBIDDEN:%',
      OLD.obligation_revision USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := clock_timestamp();
    NEW.updated_at := NEW.created_at;
    RETURN NEW;
  END IF;

  IF NEW.obligation_id IS DISTINCT FROM OLD.obligation_id
     OR NEW.obligation_revision IS DISTINCT FROM OLD.obligation_revision
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.turn_id IS DISTINCT FROM OLD.turn_id
     OR NEW.error_fingerprint IS DISTINCT FROM OLD.error_fingerprint THEN
    RAISE EXCEPTION 'COMPLETION_ACK_OBSERVATION_REGISTER_SCOPE_IMMUTABLE:%',
      OLD.obligation_revision USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW.first_failure_at IS DISTINCT FROM OLD.first_failure_at
     OR NEW.latest_failure_at < OLD.latest_failure_at
     OR NEW.observation_count <> OLD.observation_count + 1
     OR NEW.meaningful_observation_count < OLD.meaningful_observation_count THEN
    RAISE EXCEPTION 'COMPLETION_ACK_OBSERVATION_REGISTER_MONOTONE:%',
      OLD.obligation_revision USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF (NEW.latest_observation_key IS DISTINCT FROM OLD.latest_observation_key
        AND NEW.meaningful_observation_count <> OLD.meaningful_observation_count + 1)
     OR (NEW.latest_observation_key IS NOT DISTINCT FROM OLD.latest_observation_key
        AND NEW.meaningful_observation_count <> OLD.meaningful_observation_count) THEN
    RAISE EXCEPTION 'COMPLETION_ACK_OBSERVATION_REGISTER_MEANING_INVALID:%',
      OLD.obligation_revision USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  NEW.created_at := OLD.created_at;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER completion_ack_observation_register_guard
  BEFORE INSERT OR UPDATE OR DELETE ON completion_ack_observation_register
  FOR EACH ROW EXECUTE FUNCTION completion_ack_observation_register_guard();

CREATE OR REPLACE FUNCTION completion_ack_record_observation(
  p_revision completion_ack_obligation_revision,
  p_fact_id uuid,
  p_lease_generation uuid,
  p_fact_kind text,
  p_source_observed_at timestamptz,
  p_evidence_source jsonb,
  p_runner_provenance text,
  p_lease_provenance text
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_recorded_at timestamptz := statement_timestamp();
  v_bucket timestamptz := completion_ack_observation_bucket(statement_timestamp());
  v_semantic_evidence jsonb;
  v_evidence_digest char(64);
  v_observation_key char(64);
  v_observation jsonb;
BEGIN
  IF p_fact_kind NOT IN ('COMPLETION_ACK_STALE', 'CONTROL_PLANE_COMMIT_REJECTED') THEN
    RETURN;
  END IF;
  v_semantic_evidence := completion_ack_sanitize_evidence(
    p_fact_kind, COALESCE(p_evidence_source, '{}'::jsonb)
  );
  v_evidence_digest := completion_ack_json_digest(v_semantic_evidence);
  v_observation_key := completion_ack_json_digest(jsonb_build_array(
    'completion-ack-meaningful-observation:v1', p_revision.obligation_revision::text,
    p_fact_kind, v_bucket, v_evidence_digest::text
  ));
  v_observation := jsonb_strip_nulls(jsonb_build_object(
    'observationKey', v_observation_key::text,
    'observationBucket', v_bucket,
    'action', CASE p_fact_kind
      WHEN 'CONTROL_PLANE_COMMIT_REJECTED' THEN 'TURN_COMPLETE_CALLBACK'
      ELSE 'DETECT_STALE_COMPLETION_ACK'
    END,
    'outcome', p_fact_kind,
    'observedErrorFingerprint', COALESCE(
      NULLIF(p_evidence_source->>'observedErrorFingerprint', ''),
      p_revision.error_fingerprint
    ),
    'rootErrorFingerprint', p_revision.error_fingerprint,
    'firstSeenAt', v_recorded_at,
    'lastSeenAt', v_recorded_at,
    'occurrences', 1,
    'leaseProvenance', p_lease_provenance,
    'runnerProvenance', p_runner_provenance,
    'evidenceSourceDigest', v_evidence_digest::text,
    'clockAuthority', 'DATABASE_RECORDED_AT'
  ));

  INSERT INTO completion_ack_observation_register (
    obligation_id, obligation_revision, tenant_id, project_id, task_id, session_id,
    turn_id, error_fingerprint, first_failure_at, latest_failure_at,
    observation_count, meaningful_observation_count, latest_observation_key,
    recent_observations, created_at, updated_at
  ) VALUES (
    p_revision.obligation_id, p_revision.obligation_revision, p_revision.tenant_id,
    p_revision.project_id, p_revision.task_id, p_revision.session_id,
    p_revision.turn_id, p_revision.error_fingerprint, v_recorded_at, v_recorded_at,
    1, 1, v_observation_key, jsonb_build_array(v_observation),
    v_recorded_at, v_recorded_at
  ) ON CONFLICT (obligation_revision) DO UPDATE
    SET latest_failure_at = greatest(
          completion_ack_observation_register.latest_failure_at,
          EXCLUDED.latest_failure_at
        ),
        observation_count = completion_ack_observation_register.observation_count + 1,
        meaningful_observation_count =
          completion_ack_observation_register.meaningful_observation_count
          + CASE WHEN completion_ack_observation_register.latest_observation_key
                        = EXCLUDED.latest_observation_key THEN 0 ELSE 1 END,
        latest_observation_key = EXCLUDED.latest_observation_key,
        recent_observations = completion_ack_bounded_observation_history(
          completion_ack_observation_register.recent_observations, v_observation
        );
END;
$$;

-- Rebuild is intentionally a baseline reconstruction, not a claim that transient retry telemetry
-- is recoverable.  It inserts a missing register from immutable failure facts and never overwrites
-- a live monotone register.  ACTIVE/CLOSED state is untouched either way.
CREATE OR REPLACE FUNCTION completion_ack_rebuild_observation_baseline(
  p_obligation_revision char(64) DEFAULT NULL
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  v_inserted bigint;
BEGIN
  INSERT INTO completion_ack_observation_register (
    obligation_id, obligation_revision, tenant_id, project_id, task_id, session_id,
    turn_id, error_fingerprint, first_failure_at, latest_failure_at,
    observation_count, meaningful_observation_count, latest_observation_key,
    recent_observations, created_at, updated_at
  )
  SELECT revision.obligation_id, revision.obligation_revision, revision.tenant_id,
         revision.project_id, revision.task_id, revision.session_id, revision.turn_id,
         revision.error_fingerprint, aggregate.first_failure_at,
         aggregate.latest_failure_at, aggregate.observation_count,
         aggregate.observation_count, recent.latest_observation_key,
         recent.recent_observations, statement_timestamp(), clock_timestamp()
    FROM completion_ack_obligation_revision revision
    JOIN LATERAL (
      SELECT min(fact.recorded_at) AS first_failure_at,
             max(fact.recorded_at) AS latest_failure_at,
             count(*)::bigint AS observation_count
        FROM completion_ack_fact fact
       WHERE fact.obligation_revision = revision.obligation_revision
         AND fact.fact_kind <> 'COMPLETION_ACK_RECOVERED'
    ) aggregate ON aggregate.observation_count > 0
    JOIN LATERAL (
      SELECT (array_agg(entry.observation_key
                 ORDER BY entry.recorded_at DESC, entry.ingested_at DESC, entry.id DESC))[1]
               AS latest_observation_key,
             jsonb_agg(entry.observation ORDER BY entry.recorded_at, entry.ingested_at, entry.id)
               AS recent_observations
        FROM (
          SELECT bounded.id, bounded.recorded_at, bounded.ingested_at,
                 completion_ack_json_digest(jsonb_build_array(
                   'completion-ack-meaningful-observation:v1',
                   bounded.obligation_revision::text, bounded.fact_kind,
                   bounded.observation_bucket,
                   completion_ack_json_digest(completion_ack_sanitize_evidence(
                     bounded.fact_kind, bounded.evidence_source
                   ))::text
                 )) AS observation_key,
                 jsonb_strip_nulls(jsonb_build_object(
                   'observationKey', completion_ack_json_digest(jsonb_build_array(
                     'completion-ack-meaningful-observation:v1',
                     bounded.obligation_revision::text, bounded.fact_kind,
                     bounded.observation_bucket,
                     completion_ack_json_digest(completion_ack_sanitize_evidence(
                       bounded.fact_kind, bounded.evidence_source
                     ))::text
                   ))::text,
                   'observationBucket', bounded.observation_bucket,
                   'action', CASE bounded.fact_kind
                     WHEN 'CONTROL_PLANE_COMMIT_REJECTED' THEN 'TURN_COMPLETE_CALLBACK'
                     ELSE 'DETECT_STALE_COMPLETION_ACK'
                   END,
                   'outcome', bounded.fact_kind,
                   'observedErrorFingerprint', COALESCE(
                     NULLIF(bounded.evidence_source->>'observedErrorFingerprint', ''),
                     bounded.error_fingerprint
                   ),
                   'rootErrorFingerprint', revision.error_fingerprint,
                   'firstSeenAt', bounded.recorded_at,
                   'lastSeenAt', bounded.recorded_at,
                   'occurrences', 1,
                   'leaseProvenance', bounded.lease_provenance,
                   'runnerProvenance', bounded.runner_provenance,
                   'evidenceSourceDigest', completion_ack_json_digest(
                     completion_ack_sanitize_evidence(
                       bounded.fact_kind, bounded.evidence_source
                     )
                   )::text,
                   'clockAuthority', 'DATABASE_RECORDED_AT'
                 )) AS observation
            FROM completion_ack_fact bounded
           WHERE bounded.obligation_revision = revision.obligation_revision
             AND bounded.fact_kind <> 'COMPLETION_ACK_RECOVERED'
           ORDER BY bounded.recorded_at DESC, bounded.ingested_at DESC, bounded.id DESC
           LIMIT 8
        ) entry
    ) recent ON true
   WHERE (p_obligation_revision IS NULL
       OR revision.obligation_revision = p_obligation_revision)
     AND NOT EXISTS (
       SELECT 1 FROM completion_ack_observation_register register
        WHERE register.obligation_revision = revision.obligation_revision
     )
  ON CONFLICT (obligation_revision) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

-- DB-owned stamps and digests are set in BEFORE INSERT triggers.  Supplying a timestamp in raw SQL
-- cannot backdate an SLO observation; source_observed_at is the sole field that preserves it.
CREATE OR REPLACE FUNCTION completion_ack_revision_before_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_scope_valid boolean := false;
BEGIN
  -- The revision table is part of the authorization boundary, not merely an internal target of
  -- completion_ack_record_failure.  A raw INSERT must prove exactly the same tenant and reserved
  -- acceptance-shell scope, including the execution workspace when the Session has one.
  SELECT true INTO v_scope_valid
    FROM task
    JOIN project
      ON project.id = task.project_id
    JOIN session
      ON session.id = NEW.session_id
     AND session.task_id = task.id
     AND session.starts_task_work = true
    JOIN conversation_turn turn
      ON turn.id = NEW.turn_id
     AND turn.session_id = session.id
    LEFT JOIN workspace
      ON workspace.id = session.workspace_id
   WHERE task.id = NEW.task_id
     AND task.project_id = NEW.project_id
     AND task.owner_id = NEW.tenant_id
     AND project.owner_id = NEW.tenant_id
     AND session.owner_id = NEW.tenant_id
     AND (session.workspace_id IS NULL OR workspace.owner_id = NEW.tenant_id)
     AND turn.kind = 'shell'
     AND (turn.client_turn_id LIKE 'system:task-acceptance:v1:%'
       OR turn.client_turn_id LIKE 'system:task-acceptance:v2:%')
   FOR KEY SHARE OF task, project, session, turn;
  IF NOT COALESCE(v_scope_valid, false) THEN
    RAISE EXCEPTION 'COMPLETION_ACK_REVISION_SCOPE_MISMATCH:%:%:%:%:%',
      NEW.tenant_id, NEW.project_id, NEW.task_id, NEW.session_id, NEW.turn_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  NEW.protocol := 'completion-ack-obligation:v1';
  NEW.recorded_at := statement_timestamp();
  NEW.ingested_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER completion_ack_revision_before_insert
  BEFORE INSERT ON completion_ack_obligation_revision
  FOR EACH ROW EXECUTE FUNCTION completion_ack_revision_before_insert();

CREATE OR REPLACE FUNCTION completion_ack_fact_before_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_first_failure_at timestamptz;
  v_latest_failure_at timestamptz;
BEGIN
  IF NEW.evidence_source IS NULL OR jsonb_typeof(NEW.evidence_source) <> 'object' THEN
    RAISE EXCEPTION 'COMPLETION_ACK_EVIDENCE_SOURCE_MUST_BE_OBJECT'
      USING ERRCODE = 'check_violation';
  END IF;
  IF octet_length(NEW.evidence_source::text) > 65536 THEN
    RAISE EXCEPTION 'COMPLETION_ACK_EVIDENCE_INPUT_TOO_LARGE'
      USING ERRCODE = 'program_limit_exceeded';
  END IF;

  NEW.id := COALESCE(NEW.id, gen_random_uuid());
  NEW.lease_provenance := COALESCE(NEW.lease_provenance, 'LEGACY_INFERRED');
  NEW.runner_provenance := COALESCE(NEW.runner_provenance, 'LEGACY_INFERRED');
  NEW.recorded_at := statement_timestamp();
  NEW.observed_at := NEW.recorded_at;
  NEW.ingested_at := clock_timestamp();
  NEW.observation_bucket := completion_ack_observation_bucket(NEW.recorded_at);

  SELECT min(fact.recorded_at), max(fact.recorded_at)
    INTO v_first_failure_at, v_latest_failure_at
    FROM completion_ack_fact fact
   WHERE fact.obligation_revision = NEW.obligation_revision
     AND fact.fact_kind <> 'COMPLETION_ACK_RECOVERED';
  IF NEW.fact_kind = 'COMPLETION_ACK_RECOVERED' THEN
    NEW.first_failure_at := v_first_failure_at;
    NEW.latest_failure_at := v_latest_failure_at;
  ELSE
    NEW.first_failure_at := COALESCE(v_first_failure_at, NEW.recorded_at);
    NEW.latest_failure_at := NEW.recorded_at;
  END IF;

  -- Canonicalize at the table boundary.  Internal functions and raw SQL therefore have exactly
  -- the same allowlist; raw exception messages, credentials and caller-supplied protocol/clock
  -- claims can never survive in the immutable fact.
  NEW.evidence_source := completion_ack_sanitize_evidence(
    NEW.fact_kind, NEW.evidence_source
  ) || jsonb_strip_nulls(jsonb_build_object(
    'schemaVersion', 1,
    'protocol', 'completion-ack-fact:v1',
    'sourceObservedAt', NEW.source_observed_at,
    'databaseRecordedAt', NEW.recorded_at,
    'clockAuthority', 'DATABASE_RECORDED_AT',
    'runnerProvenance', NEW.runner_provenance,
    'leaseProvenance', NEW.lease_provenance,
    'typedAttempt', CASE
      WHEN NEW.evidence_source->>'executionProtocol' = 'LEGACY_V1' THEN false
    END,
    'typedAdmission', CASE
      WHEN NEW.evidence_source->>'executionProtocol' = 'LEGACY_V1' THEN false
    END,
    'typedStateDependency', 'NOT_READ'
  ));
  NEW.evidence_source_digest := completion_ack_json_digest(NEW.evidence_source);
  NEW.idempotency_key := completion_ack_fact_idempotency_key(
    NEW.obligation_revision, NEW.fact_kind, NEW.tenant_id, NEW.project_id, NEW.task_id,
    NEW.session_id, NEW.turn_id, NEW.lease_generation, NEW.error_fingerprint,
    NEW.observation_bucket
  );
  NEW.fact_digest := completion_ack_json_digest(jsonb_build_object(
    'schemaVersion', 1,
    'protocol', 'completion-ack-fact:v1',
    'id', NEW.id::text,
    'obligationId', NEW.obligation_id::text,
    'obligationRevision', NEW.obligation_revision::text,
    'tenantId', NEW.tenant_id::text,
    'projectId', NEW.project_id::text,
    'taskId', NEW.task_id::text,
    'sessionId', NEW.session_id::text,
    'turnId', NEW.turn_id::text,
    'leaseGeneration', NEW.lease_generation::text,
    'leaseProvenance', NEW.lease_provenance,
    'runnerProvenance', NEW.runner_provenance,
    'kind', NEW.fact_kind,
    'errorFingerprint', NEW.error_fingerprint,
    'firstFailureEpoch', extract(epoch FROM NEW.first_failure_at)::numeric,
    'latestFailureEpoch', extract(epoch FROM NEW.latest_failure_at)::numeric,
    'recordedEpoch', extract(epoch FROM NEW.recorded_at)::numeric,
    'ingestedEpoch', extract(epoch FROM NEW.ingested_at)::numeric,
    'evidenceSourceDigest', NEW.evidence_source_digest::text,
    'idempotencyKey', NEW.idempotency_key::text
  ));
  RETURN NEW;
END;
$$;

CREATE TRIGGER completion_ack_fact_before_insert
  BEFORE INSERT ON completion_ack_fact
  FOR EACH ROW EXECUTE FUNCTION completion_ack_fact_before_insert();

CREATE OR REPLACE FUNCTION completion_ack_fact_observation_after_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_revision completion_ack_obligation_revision%ROWTYPE;
BEGIN
  IF NEW.fact_kind = 'COMPLETION_ACK_RECOVERED' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO STRICT v_revision
    FROM completion_ack_obligation_revision revision
   WHERE revision.obligation_revision = NEW.obligation_revision;
  PERFORM completion_ack_record_observation(
    v_revision, NEW.id, NEW.lease_generation, NEW.fact_kind,
    NEW.source_observed_at, NEW.evidence_source,
    NEW.runner_provenance, NEW.lease_provenance
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER completion_ack_fact_observation_after_insert
  AFTER INSERT ON completion_ack_fact
  FOR EACH ROW EXECUTE FUNCTION completion_ack_fact_observation_after_insert();

CREATE OR REPLACE FUNCTION completion_ack_event_before_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_source_fact completion_ack_fact%ROWTYPE;
  v_latest_state text;
BEGIN
  IF NEW.evidence_source IS NULL OR jsonb_typeof(NEW.evidence_source) <> 'object' THEN
    RAISE EXCEPTION 'COMPLETION_ACK_EVENT_EVIDENCE_SOURCE_MUST_BE_OBJECT'
      USING ERRCODE = 'check_violation';
  END IF;
  IF octet_length(NEW.evidence_source::text) > 65536 THEN
    RAISE EXCEPTION 'COMPLETION_ACK_EVENT_EVIDENCE_INPUT_TOO_LARGE'
      USING ERRCODE = 'program_limit_exceeded';
  END IF;

  SELECT fact.* INTO v_source_fact
    FROM completion_ack_fact fact
   WHERE fact.id = NEW.source_fact_id
   FOR KEY SHARE;
  IF NOT FOUND
     OR v_source_fact.obligation_id <> NEW.obligation_id
     OR v_source_fact.obligation_revision <> NEW.obligation_revision
     OR v_source_fact.fact_kind <> NEW.source_fact_kind THEN
    RAISE EXCEPTION 'COMPLETION_ACK_EVENT_SOURCE_FACT_SCOPE_MISMATCH:%',
      NEW.source_fact_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.evidence_source IS DISTINCT FROM v_source_fact.evidence_source
     OR completion_ack_json_digest(NEW.evidence_source)
        <> v_source_fact.evidence_source_digest THEN
    RAISE EXCEPTION 'COMPLETION_ACK_EVENT_SOURCE_EVIDENCE_MISMATCH:%',
      NEW.source_fact_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- The execution tuple, not a changing failure fingerprint, owns one lifecycle.  The task lock
  -- serializes both the supported reducer and raw event inserts, so two observations cannot race
  -- into parallel ACTIVE obligations.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat('completion-ack-task:v1:', v_source_fact.task_id::text), 0
  ));
  IF NEW.state = 'ACTIVE' AND EXISTS (
    SELECT 1 FROM completion_ack_active_obligation active
     WHERE active.tenant_id = v_source_fact.tenant_id
       AND active.task_id = v_source_fact.task_id
       AND active.session_id = v_source_fact.session_id
       AND active.turn_id = v_source_fact.turn_id
       AND active.obligation_revision <> NEW.obligation_revision
  ) THEN
    RAISE EXCEPTION 'COMPLETION_ACK_ACTIVE_SCOPE_ALREADY_OWNED:%:%:%',
      v_source_fact.task_id, v_source_fact.session_id, v_source_fact.turn_id
      USING ERRCODE = 'unique_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.obligation_id::text, 0));
  SELECT event.state INTO v_latest_state
    FROM completion_ack_obligation_event event
   WHERE event.obligation_revision = NEW.obligation_revision
   ORDER BY event.recorded_at DESC, event.ingested_at DESC, event.id DESC
   LIMIT 1;
  IF (NEW.state = 'ACTIVE' AND v_latest_state IS NOT NULL)
     OR (NEW.state = 'CLOSED' AND v_latest_state IS DISTINCT FROM 'ACTIVE') THEN
    RAISE EXCEPTION 'COMPLETION_ACK_EVENT_TRANSITION_INVALID:%:%:%',
      NEW.obligation_revision, COALESCE(v_latest_state, 'NONE'), NEW.state
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  NEW.id := COALESCE(NEW.id, gen_random_uuid());
  NEW.recorded_at := statement_timestamp();
  NEW.ingested_at := clock_timestamp();
  NEW.evidence_source_digest := v_source_fact.evidence_source_digest;
  NEW.event_digest := completion_ack_json_digest(jsonb_build_array(
    'completion-ack-obligation-event:v1', NEW.obligation_revision::text,
    NEW.state, NEW.source_fact_id::text, NEW.source_fact_kind, NEW.reason_code
  ));
  RETURN NEW;
END;
$$;

CREATE TRIGGER completion_ack_event_before_insert
  BEFORE INSERT ON completion_ack_obligation_event
  FOR EACH ROW EXECUTE FUNCTION completion_ack_event_before_insert();

CREATE OR REPLACE FUNCTION completion_ack_append_only_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'COMPLETION_ACK_APPEND_ONLY:%:%', TG_TABLE_NAME, OLD.obligation_revision
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$$;

CREATE TRIGGER completion_ack_revision_append_only
  BEFORE UPDATE OR DELETE ON completion_ack_obligation_revision
  FOR EACH ROW EXECUTE FUNCTION completion_ack_append_only_guard();
CREATE TRIGGER completion_ack_fact_append_only
  BEFORE UPDATE OR DELETE ON completion_ack_fact
  FOR EACH ROW EXECUTE FUNCTION completion_ack_append_only_guard();
CREATE TRIGGER completion_ack_event_append_only
  BEFORE UPDATE OR DELETE ON completion_ack_obligation_event
  FOR EACH ROW EXECUTE FUNCTION completion_ack_append_only_guard();

-- The obligation is a reduction, never a writable summary.  The latest immutable lifecycle event
-- decides whether it is active; facts at or after that ACTIVE event describe only this episode.
CREATE VIEW completion_ack_active_obligation AS
WITH latest_event AS (
  SELECT DISTINCT ON (event.obligation_revision)
         event.obligation_id, event.obligation_revision, event.state,
         event.source_fact_id, event.recorded_at, event.ingested_at, event.id
    FROM completion_ack_obligation_event event
   ORDER BY event.obligation_revision, event.recorded_at DESC,
            event.ingested_at DESC, event.id DESC
), active AS (
  SELECT latest.*
    FROM latest_event latest
   WHERE latest.state = 'ACTIVE'
)
SELECT revision.tenant_id,
       revision.project_id,
       revision.task_id,
       revision.session_id,
       revision.turn_id,
       revision.error_fingerprint,
       revision.obligation_id,
       revision.obligation_revision,
       jsonb_build_object(
         'schemaVersion', 1,
         'kind', 'COMPLETION_ACK_STALE',
         'factKind', latest_failure.fact_kind,
         'state', 'ACTIVE',
         'obligationId', revision.obligation_id::text,
         'obligationRevision', revision.obligation_revision::text,
         'binding', jsonb_build_object(
           'tenantId', revision.tenant_id::text,
           'projectId', revision.project_id::text,
           'taskId', revision.task_id::text,
           'sessionId', revision.session_id::text,
           'turnId', revision.turn_id::text,
           'protocol', revision.protocol,
           'errorFingerprint', revision.error_fingerprint
         ),
         'reason', reason_state.message,
         'reasonCode', reason_state.code,
         'reasonDetail', jsonb_build_object(
           'code', reason_state.code,
           'category', 'CONTROL_PLANE_COMPLETION_ACK',
           'message', reason_state.message,
           'owner', 'PROJECT_COORDINATOR',
           'actor', 'PROJECT_COORDINATOR',
           'blocksGate', true,
           'nextAction', reason_state.next_action,
           'errorFingerprint', revision.error_fingerprint,
           'evidenceFactIds', evidence_ids.failure_fact_ids,
           'evidenceFactIdsTruncated', aggregate.evidence_fact_count > 16,
           'totalEvidenceFactCount', aggregate.evidence_fact_count
         ),
         'owner', 'PROJECT_COORDINATOR',
         'ownerType', 'AGENT',
         'attemptedActions', COALESCE(
           observation_register.recent_observations, recent.attempted_actions
         ),
         'attemptedActionsTruncated', CASE
           WHEN observation_register.obligation_revision IS NOT NULL THEN
             observation_register.meaningful_observation_count
               > jsonb_array_length(observation_register.recent_observations)
           ELSE aggregate.evidence_fact_count > 8
         END,
         'totalAttemptedActionCount', COALESCE(
           observation_register.observation_count, aggregate.evidence_fact_count
         ),
         'meaningfulAttemptedActionCount', COALESCE(
           observation_register.meaningful_observation_count,
           aggregate.evidence_fact_count
         ),
         'requiredAction', reason_state.next_action,
         'nextAction', reason_state.next_action,
         'actionProtocol', jsonb_build_object(
           'name', 'completion-ack-recovery',
           'version', 1,
           'operation', reason_state.next_action
         ),
         'firstFailureAt', COALESCE(
           observation_register.first_failure_at, aggregate.first_failure_at
         ),
         'latestFailureAt', COALESCE(
           observation_register.latest_failure_at, aggregate.latest_failure_at
         ),
         'observationCount', COALESCE(
           observation_register.observation_count, aggregate.evidence_fact_count
         ),
         'clockAuthority', 'DATABASE_RECORDED_AT',
         'observationTelemetry', jsonb_build_object(
           'authority', 'NON_AUTHORITATIVE_BOUNDED_MONOTONE_REGISTER',
           'lifecycleAuthority', 'APPEND_ONLY_FACTS_AND_EVENTS',
           'recentLimit', 8,
           'exactAfterLoss', false,
           'rebuildSemantics', 'CANONICAL_FACT_BASELINE_ONLY',
           'clockAuthority', 'DATABASE_RECORDED_AT'
         ),
         'provenance', jsonb_build_object(
           'runner', latest_failure.runner_provenance,
           'lease', latest_failure.lease_provenance,
           'executionProtocol', latest_failure.evidence_source->>'executionProtocol',
           'typedAttempt', latest_failure.evidence_source->'typedAttempt',
           'typedAdmission', latest_failure.evidence_source->'typedAdmission',
           'typedStateDependency', 'NOT_READ'
         )
       ) AS obligation,
       COALESCE(observation_register.first_failure_at, aggregate.first_failure_at)
         AS first_failure_at,
       COALESCE(observation_register.latest_failure_at, aggregate.latest_failure_at)
         AS latest_failure_at,
       COALESCE(observation_register.observation_count, aggregate.evidence_fact_count)
         AS observation_count
  FROM active
  JOIN completion_ack_obligation_revision revision
    ON revision.obligation_revision = active.obligation_revision
  JOIN completion_ack_fact activation_fact ON activation_fact.id = active.source_fact_id
  LEFT JOIN completion_ack_observation_register observation_register
    ON observation_register.obligation_revision = revision.obligation_revision
   AND observation_register.obligation_id = revision.obligation_id
   AND observation_register.tenant_id = revision.tenant_id
   AND observation_register.project_id = revision.project_id
   AND observation_register.task_id = revision.task_id
   AND observation_register.session_id = revision.session_id
   AND observation_register.turn_id = revision.turn_id
  -- Defence in depth for every SQL consumer of the view.  The INSERT trigger rejects a bad
  -- binding, and the reducer independently refuses to surface one if historical/raw corruption
  -- ever bypassed that boundary.
  JOIN task obligation_task
    ON obligation_task.id = revision.task_id
   AND obligation_task.project_id = revision.project_id
   AND obligation_task.owner_id = revision.tenant_id
  JOIN project obligation_project
    ON obligation_project.id = revision.project_id
   AND obligation_project.owner_id = revision.tenant_id
  JOIN session obligation_session
    ON obligation_session.id = revision.session_id
   AND obligation_session.task_id = revision.task_id
   AND obligation_session.owner_id = revision.tenant_id
  LEFT JOIN workspace obligation_workspace
    ON obligation_workspace.id = obligation_session.workspace_id
  JOIN conversation_turn obligation_turn
    ON obligation_turn.id = revision.turn_id
   AND obligation_turn.session_id = revision.session_id
  JOIN LATERAL (
    SELECT min(fact.recorded_at) AS first_failure_at,
           max(fact.recorded_at) AS latest_failure_at,
           count(*)::bigint AS evidence_fact_count
      FROM completion_ack_fact fact
     WHERE fact.obligation_revision = active.obligation_revision
       AND fact.fact_kind <> 'COMPLETION_ACK_RECOVERED'
       AND (fact.recorded_at, fact.ingested_at, fact.id)
           >= (activation_fact.recorded_at, activation_fact.ingested_at, activation_fact.id)
  ) aggregate ON true
  JOIN LATERAL (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'action', CASE fact.fact_kind
               WHEN 'CONTROL_PLANE_COMMIT_REJECTED' THEN 'TURN_COMPLETE_CALLBACK'
               ELSE 'DETECT_STALE_COMPLETION_ACK'
             END,
             'outcome', fact.fact_kind,
             'factId', fact.id::text,
             'recordedAt', fact.recorded_at,
             'sourceObservedAt', fact.source_observed_at,
             'leaseGeneration', fact.lease_generation::text,
             'leaseProvenance', fact.lease_provenance,
             'runnerProvenance', fact.runner_provenance,
             'evidenceSourceDigest', fact.evidence_source_digest::text
           ) ORDER BY fact.recorded_at, fact.ingested_at, fact.id), '[]'::jsonb)
           AS attempted_actions
      FROM (
        SELECT bounded.*
          FROM completion_ack_fact bounded
         WHERE bounded.obligation_revision = active.obligation_revision
           AND bounded.fact_kind <> 'COMPLETION_ACK_RECOVERED'
           AND (bounded.recorded_at, bounded.ingested_at, bounded.id)
               >= (activation_fact.recorded_at, activation_fact.ingested_at, activation_fact.id)
         ORDER BY bounded.recorded_at DESC, bounded.ingested_at DESC, bounded.id DESC
         LIMIT 8
      ) fact
  ) recent ON true
  JOIN LATERAL (
    SELECT COALESCE(jsonb_agg(to_jsonb(fact.id::text)
             ORDER BY fact.recorded_at, fact.ingested_at, fact.id), '[]'::jsonb)
           AS failure_fact_ids
      FROM (
        SELECT bounded.id, bounded.recorded_at, bounded.ingested_at
          FROM completion_ack_fact bounded
         WHERE bounded.obligation_revision = active.obligation_revision
           AND bounded.fact_kind <> 'COMPLETION_ACK_RECOVERED'
           AND (bounded.recorded_at, bounded.ingested_at, bounded.id)
               >= (activation_fact.recorded_at, activation_fact.ingested_at, activation_fact.id)
         ORDER BY bounded.recorded_at DESC, bounded.ingested_at DESC, bounded.id DESC
         LIMIT 16
      ) fact
  ) evidence_ids ON true
  JOIN LATERAL (
    SELECT fact.fact_kind, fact.runner_provenance, fact.lease_provenance,
           fact.evidence_source
      FROM completion_ack_fact fact
     WHERE fact.obligation_revision = active.obligation_revision
       AND fact.fact_kind <> 'COMPLETION_ACK_RECOVERED'
       AND (fact.recorded_at, fact.ingested_at, fact.id)
           >= (activation_fact.recorded_at, activation_fact.ingested_at, activation_fact.id)
     ORDER BY fact.recorded_at DESC, fact.ingested_at DESC, fact.id DESC
     LIMIT 1
  ) latest_failure ON true
  JOIN LATERAL (
    SELECT CASE
      WHEN obligation_turn.status = 'ANSWERED' THEN 'ACK_COMMIT_FACT_MISSING'
      ELSE latest_failure.fact_kind
    END AS code,
    CASE
      WHEN obligation_turn.status = 'ANSWERED'
        THEN 'The turn is acknowledged, but its append-only callback commit receipt is missing.'
      WHEN latest_failure.fact_kind = 'CONTROL_PLANE_COMMIT_REJECTED' THEN
        'The acceptance shell is terminal, but the control-plane completion commit was rejected.'
      ELSE
        'A terminal acceptance-shell event is durable, but its completion acknowledgement is still stale.'
    END AS message,
    CASE
      WHEN obligation_turn.status = 'ANSWERED' THEN 'RECORD_ACK_COMMIT_RECEIPT'
      ELSE 'RETRY_CANONICAL_COMPLETION_COMMIT'
    END AS next_action
  ) reason_state ON true
 WHERE obligation_session.workspace_id IS NULL
    OR obligation_workspace.owner_id = revision.tenant_id;

CREATE OR REPLACE FUNCTION session_completion_ack_dispatch_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_became_live boolean := false;
  v_obligation_id char(64);
  v_obligation_revision char(64);
BEGIN
  IF NEW.task_id IS NULL OR NOT NEW.starts_task_work OR NEW.deleted_at IS NOT NULL
     OR NEW.status::text NOT IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    v_became_live := true;
  ELSE
    v_became_live := OLD.task_id IS DISTINCT FROM NEW.task_id
      OR NOT OLD.starts_task_work
      OR OLD.deleted_at IS NOT NULL
      OR (NEW.status::text IN ('PENDING', 'RUNNING')
        AND OLD.status IS DISTINCT FROM NEW.status);
  END IF;
  IF NOT v_became_live THEN RETURN NEW; END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(concat('completion-ack-task:v1:', NEW.task_id::text), 0)
  );
  SELECT active.obligation_id, active.obligation_revision
    INTO v_obligation_id, v_obligation_revision
    FROM completion_ack_active_obligation active
   WHERE active.task_id = NEW.task_id
   ORDER BY active.first_failure_at, active.obligation_revision
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'COMPLETION_ACK_RECONCILIATION_REQUIRED:%:%',
      v_obligation_id::text, v_obligation_revision::text
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER session_completion_ack_dispatch_insert_guard
  BEFORE INSERT ON session
  FOR EACH ROW EXECUTE FUNCTION session_completion_ack_dispatch_guard();
CREATE TRIGGER session_completion_ack_dispatch_revive_guard
  BEFORE UPDATE OF task_id, starts_task_work, deleted_at, status ON session
  FOR EACH ROW EXECUTE FUNCTION session_completion_ack_dispatch_guard();

CREATE OR REPLACE FUNCTION conversation_turn_completion_ack_execution_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_task_id uuid;
  v_starts_task_work boolean;
  v_obligation_id char(64);
  v_obligation_revision char(64);
  v_crosses_execution_boundary boolean := false;
BEGIN
  SELECT session.task_id, session.starts_task_work
    INTO v_task_id, v_starts_task_work
    FROM session
   WHERE session.id = NEW.session_id;
  IF v_task_id IS NULL OR NOT COALESCE(v_starts_task_work, false) THEN RETURN NEW; END IF;

  IF TG_OP = 'INSERT' THEN
    v_crosses_execution_boundary := NEW.kind NOT IN ('interrupt', 'end');
  ELSE
    v_crosses_execution_boundary := (
      NEW.status = 'IN_FLIGHT' AND OLD.status IS DISTINCT FROM NEW.status
    ) OR NEW.delivered_at IS DISTINCT FROM OLD.delivered_at
      OR NEW.lease_generation IS DISTINCT FROM OLD.lease_generation;
  END IF;
  IF NOT v_crosses_execution_boundary THEN RETURN NEW; END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(concat('completion-ack-task:v1:', v_task_id::text), 0)
  );
  SELECT active.obligation_id, active.obligation_revision
    INTO v_obligation_id, v_obligation_revision
    FROM completion_ack_active_obligation active
   WHERE active.task_id = v_task_id
   ORDER BY active.first_failure_at, active.obligation_revision
   LIMIT 1;
  IF NOT FOUND THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'COMPLETION_ACK_RECONCILIATION_REQUIRED:%:%',
    v_obligation_id::text, v_obligation_revision::text
    USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER conversation_turn_completion_ack_insert_guard
  BEFORE INSERT ON conversation_turn
  FOR EACH ROW EXECUTE FUNCTION conversation_turn_completion_ack_execution_guard();
CREATE TRIGGER conversation_turn_completion_ack_lease_guard
  BEFORE UPDATE OF status, delivered_at, lease_generation ON conversation_turn
  FOR EACH ROW EXECUTE FUNCTION conversation_turn_completion_ack_execution_guard();

CREATE OR REPLACE FUNCTION completion_ack_append_fact(
  p_revision completion_ack_obligation_revision,
  p_lease_generation uuid,
  p_fact_kind text,
  p_source_observed_at timestamptz,
  p_evidence_source jsonb,
  p_runner_provenance text DEFAULT 'LEGACY_INFERRED',
  p_lease_provenance text DEFAULT 'LEGACY_INFERRED'
) RETURNS TABLE(fact_id uuid, inserted boolean) LANGUAGE plpgsql AS $$
DECLARE
  v_recorded_at timestamptz := statement_timestamp();
  v_first_failure_at timestamptz;
  v_latest_failure_at timestamptz;
  v_idempotency_key char(64);
  v_evidence jsonb;
BEGIN
  IF p_runner_provenance NOT IN ('LEGACY_INFERRED', 'INGESTED_EXACT')
     OR p_lease_provenance NOT IN ('LEGACY_INFERRED', 'INGESTED_EXACT') THEN
    RAISE EXCEPTION 'COMPLETION_ACK_PROVENANCE_INVALID:%:%',
      p_runner_provenance, p_lease_provenance USING ERRCODE = 'check_violation';
  END IF;
  SELECT min(fact.recorded_at), max(fact.recorded_at)
    INTO v_first_failure_at, v_latest_failure_at
    FROM completion_ack_fact fact
   WHERE fact.obligation_revision = p_revision.obligation_revision
     AND fact.fact_kind <> 'COMPLETION_ACK_RECOVERED';

  IF p_fact_kind <> 'COMPLETION_ACK_RECOVERED' THEN
    v_first_failure_at := COALESCE(v_first_failure_at, v_recorded_at);
    v_latest_failure_at := v_recorded_at;
  END IF;

  v_evidence := COALESCE(p_evidence_source, '{}'::jsonb) || jsonb_build_object(
    'schemaVersion', 1,
    'protocol', 'completion-ack-fact:v1',
    'sourceObservedAt', p_source_observed_at,
    'clockAuthority', 'DATABASE_RECORDED_AT',
    'runnerProvenance', p_runner_provenance,
    'leaseProvenance', p_lease_provenance,
    'typedStateDependency', 'NOT_READ'
  );

  INSERT INTO completion_ack_fact (
    id, obligation_id, obligation_revision, tenant_id, project_id, task_id,
    session_id, turn_id, lease_generation, lease_provenance, runner_provenance,
    fact_kind, error_fingerprint,
    first_failure_at, latest_failure_at, source_observed_at,
    observed_at, recorded_at, ingested_at, observation_bucket,
    evidence_source, evidence_source_digest, idempotency_key, fact_digest
  ) VALUES (
    gen_random_uuid(), p_revision.obligation_id, p_revision.obligation_revision,
    p_revision.tenant_id, p_revision.project_id, p_revision.task_id,
    p_revision.session_id, p_revision.turn_id, p_lease_generation,
    p_lease_provenance, p_runner_provenance, p_fact_kind,
    p_revision.error_fingerprint, v_first_failure_at, v_latest_failure_at,
    p_source_observed_at, v_recorded_at, v_recorded_at, v_recorded_at,
    completion_ack_observation_bucket(v_recorded_at), v_evidence,
    repeat('0', 64)::char(64), repeat('0', 64)::char(64), repeat('0', 64)::char(64)
  ) ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO fact_id;

  IF fact_id IS NOT NULL THEN
    inserted := true;
    RETURN NEXT;
    RETURN;
  END IF;

  v_idempotency_key := completion_ack_fact_idempotency_key(
    p_revision.obligation_revision, p_fact_kind, p_revision.tenant_id,
    p_revision.project_id, p_revision.task_id, p_revision.session_id,
    p_revision.turn_id, p_lease_generation, p_revision.error_fingerprint,
    completion_ack_observation_bucket(v_recorded_at)
  );
  SELECT fact.id INTO fact_id
    FROM completion_ack_fact fact
   WHERE fact.idempotency_key = v_idempotency_key;
  IF fact_id IS NULL THEN
    RAISE EXCEPTION 'COMPLETION_ACK_FACT_REPLAY_MISSING:%', v_idempotency_key
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  inserted := false;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION completion_ack_sync_blocker(
  p_obligation_revision char(64), p_recorded_at timestamptz
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_active record;
  v_blocker project_blocker%ROWTYPE;
  v_dedupe_key text;
  v_generation bigint;
  v_seen_at timestamp without time zone;
  v_next_check_at timestamp without time zone;
  v_occurrences integer;
BEGIN
  SELECT * INTO v_active
    FROM completion_ack_active_obligation active
   WHERE active.obligation_revision = p_obligation_revision;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_active.obligation_id::text, 0));
  v_dedupe_key := concat(
    'completion-ack:v1:', v_active.obligation_id::text, ':',
    v_active.obligation_revision::text
  );
  v_seen_at := timezone('UTC', p_recorded_at);
  v_next_check_at := timezone('UTC', p_recorded_at + interval '15 seconds');
  v_occurrences := least(v_active.observation_count, 2147483647)::integer;

  SELECT * INTO v_blocker
    FROM project_blocker blocker
   WHERE blocker.project_id = v_active.project_id
     AND blocker.dedupe_key = v_dedupe_key
     AND blocker.resolved_at IS NULL
   FOR UPDATE;

  IF FOUND THEN
    UPDATE project_blocker
       SET required_action = v_active.obligation->>'requiredAction',
           next_check_at = v_next_check_at,
           detail = v_active.obligation || jsonb_build_object(
             'compatibilityProjection', true,
             'obligationId', v_active.obligation_id::text,
             'obligationRevision', v_active.obligation_revision::text
           ),
           condition_version = v_active.obligation_revision,
           first_seen_at = least(first_seen_at, timezone('UTC', v_active.first_failure_at)),
           last_seen_at = greatest(last_seen_at, timezone('UTC', v_active.latest_failure_at)),
           occurrences = greatest(occurrences, v_occurrences),
           updated_at = v_seen_at
     WHERE id = v_blocker.id
     RETURNING * INTO v_blocker;
    RETURN v_blocker.id;
  END IF;

  SELECT COALESCE(max(blocker.lifecycle_generation), 0) + 1
    INTO v_generation
    FROM project_blocker blocker
   WHERE blocker.project_id = v_active.project_id
     AND blocker.dedupe_key = v_dedupe_key;

  INSERT INTO project_blocker (
    id, project_id, kind, owner, recovery, severity, required_action, next_check_at,
    subject_type, subject_id, detail, dedupe_key, lifecycle_generation,
    condition_version, first_seen_at, last_seen_at, occurrences, created_at, updated_at
  ) VALUES (
    gen_random_uuid(), v_active.project_id, 'COMPLETION_ACK_STALE', 'COORDINATOR',
    'EVENT', 'WARNING', v_active.obligation->>'requiredAction', v_next_check_at,
    'TASK', v_active.task_id::text,
    v_active.obligation || jsonb_build_object(
      'compatibilityProjection', true,
      'obligationId', v_active.obligation_id::text,
      'obligationRevision', v_active.obligation_revision::text
    ),
    v_dedupe_key, v_generation, v_active.obligation_revision,
    timezone('UTC', v_active.first_failure_at),
    timezone('UTC', v_active.latest_failure_at), v_occurrences, v_seen_at, v_seen_at
  ) RETURNING * INTO v_blocker;
  RETURN v_blocker.id;
END;
$$;

CREATE OR REPLACE FUNCTION completion_ack_resolve_blocker(
  p_project_id uuid, p_obligation_id char(64), p_obligation_revision char(64),
  p_recorded_at timestamptz
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_count integer;
BEGIN
  UPDATE project_blocker
     SET resolved_at = timezone('UTC', p_recorded_at),
         resolved_by = 'AUTO',
         updated_at = timezone('UTC', p_recorded_at),
         detail = detail || jsonb_build_object(
           'resolvedByFact', 'COMPLETION_ACK_RECOVERED',
           'resolvedAt', p_recorded_at,
           'obligationId', p_obligation_id::text,
           'obligationRevision', p_obligation_revision::text
         )
   WHERE project_id = p_project_id
     AND dedupe_key = concat(
       'completion-ack:v1:', p_obligation_id::text, ':', p_obligation_revision::text
     )
     AND resolved_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION completion_ack_record_recovery(
  p_session_id uuid,
  p_turn_id uuid,
  p_observed_at timestamptz,
  p_evidence_source jsonb
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_turn record;
  v_terminal_event record;
  v_callback_runner_id uuid;
  v_active record;
  v_revision completion_ack_obligation_revision%ROWTYPE;
  v_latest_state text;
  v_fact_id uuid;
  v_inserted boolean;
  v_closed integer := 0;
  v_fact_count integer := 0;
  v_active_count integer := 0;
  v_recorded_at timestamptz := statement_timestamp();
  v_runner_provenance text := 'LEGACY_INFERRED';
  v_lease_provenance text := 'LEGACY_INFERRED';
  v_evidence jsonb;
BEGIN
  IF p_session_id IS NULL OR p_turn_id IS NULL THEN
    RAISE EXCEPTION 'COMPLETION_ACK_SCOPE_REQUIRED'
      USING ERRCODE = 'not_null_violation';
  END IF;
  IF p_evidence_source IS NULL OR jsonb_typeof(p_evidence_source) <> 'object' THEN
    RAISE EXCEPTION 'COMPLETION_ACK_EVIDENCE_SOURCE_MUST_BE_OBJECT'
      USING ERRCODE = 'check_violation';
  END IF;
  IF octet_length(p_evidence_source::text) > 65536 THEN
    RAISE EXCEPTION 'COMPLETION_ACK_EVIDENCE_INPUT_TOO_LARGE'
      USING ERRCODE = 'program_limit_exceeded';
  END IF;

  SELECT turn.status, turn.answered_at, turn.lease_generation,
         turn.kind, turn.client_turn_id, session.task_id,
         session.assigned_runner_id
    INTO v_turn
    FROM conversation_turn turn
    JOIN session ON session.id = turn.session_id
   WHERE turn.id = p_turn_id AND turn.session_id = p_session_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'COMPLETION_ACK_TURN_SCOPE_MISMATCH:%:%', p_session_id, p_turn_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended(concat('completion-ack-task:v1:', v_turn.task_id::text), 0)
  );

  -- ACK is a database fact, not an inference from Session lifecycle or a runner event.  Until the
  -- turn itself is ANSWERED, a caller may ask for evaluation but may not close the obligation.
  IF v_turn.status IS DISTINCT FROM 'ANSWERED' THEN
    RETURN jsonb_build_object(
      'recorded', false,
      'state', 'PENDING_ACK',
      'reason', 'TURN_NOT_ANSWERED',
      'sessionId', p_session_id::text,
      'turnId', p_turn_id::text,
      'databaseRecordedAt', v_recorded_at,
      'sourceObservedAt', p_observed_at
    );
  END IF;

  SELECT count(*) INTO v_active_count
    FROM completion_ack_active_obligation active
   WHERE active.session_id = p_session_id AND active.turn_id = p_turn_id;
  IF v_active_count = 0 THEN
    RETURN jsonb_build_object(
      'recorded', false,
      'state', 'NO_OBLIGATION',
      'closedObligationCount', 0,
      'recoveryFactCount', 0,
      'sessionId', p_session_id::text,
      'turnId', p_turn_id::text,
      'databaseRecordedAt', v_recorded_at,
      'sourceObservedAt', p_observed_at
    );
  END IF;

  -- Closing an ACK-liveness obligation is independent of PASS/FAIL/continuation.  Authority is
  -- the exact runner callback receipt, not the executable judgment.  This function is intended to
  -- run in the callback transaction after the turn's ANSWERED write; the current post-commit edge
  -- call remains a rolling-upgrade fallback and produces the same append-only fact.
  IF p_evidence_source->>'source' IS DISTINCT FROM 'RUNNER_API_TURN_COMPLETE_COMMITTED'
     OR COALESCE(p_evidence_source->>'runnerId', '') = '' THEN
    FOR v_active IN
      SELECT active.obligation_revision
        FROM completion_ack_active_obligation active
       WHERE active.session_id = p_session_id AND active.turn_id = p_turn_id
       ORDER BY active.obligation_revision
    LOOP
      PERFORM completion_ack_sync_blocker(
        v_active.obligation_revision, v_recorded_at
      );
    END LOOP;
    RETURN jsonb_build_object(
      'recorded', false,
      'state', 'ACTIVE',
      'reason', 'ACK_COMMIT_RECEIPT_MISSING',
      'closedObligationCount', 0,
      'recoveryFactCount', 0,
      'sessionId', p_session_id::text,
      'turnId', p_turn_id::text,
      'databaseRecordedAt', v_recorded_at,
      'sourceObservedAt', p_observed_at
    );
  END IF;
  BEGIN
    v_callback_runner_id := (p_evidence_source->>'runnerId')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'COMPLETION_ACK_CALLBACK_RUNNER_INVALID'
      USING ERRCODE = 'check_violation';
  END;
  SELECT event.id, event.ingested_by_runner_id,
         event.ingested_under_lease_generation
    INTO v_terminal_event
    FROM run_event event
   WHERE event.session_id = p_session_id
     AND event.turn_id = p_turn_id
     AND event.type = 'tool_result'
     AND event.payload->>'toolUseId' = concat('shell-', p_turn_id::text)
     AND (
       event.ingested_by_runner_id = v_callback_runner_id
       OR (event.ingested_by_runner_id IS NULL
         AND v_turn.assigned_runner_id = v_callback_runner_id)
     )
     AND (event.ingested_under_lease_generation IS NULL
       OR event.ingested_under_lease_generation = v_turn.lease_generation)
   ORDER BY event.seq DESC, event.ingested_at DESC, event.id DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'COMPLETION_ACK_COMMIT_TERMINAL_EVENT_MISMATCH:%:%',
      p_session_id, p_turn_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_terminal_event.ingested_by_runner_id IS NOT NULL THEN
    v_runner_provenance := 'INGESTED_EXACT';
  END IF;
  IF v_terminal_event.ingested_under_lease_generation IS NOT NULL THEN
    v_lease_provenance := 'INGESTED_EXACT';
  END IF;

  v_evidence := completion_ack_sanitize_evidence(
    'COMPLETION_ACK_RECOVERED', p_evidence_source
  ) || jsonb_build_object(
    'source', 'RUNNER_API_TURN_COMPLETE_COMMITTED',
    'ackAuthority', 'EXACT_TURN_COMPLETE_CALLBACK',
    'answeredAt', v_turn.answered_at,
    'terminalEventId', v_terminal_event.id::text,
    'turnClientId', v_turn.client_turn_id,
    'executionProtocol', CASE
      WHEN v_turn.client_turn_id LIKE 'system:task-acceptance:v1:%' THEN 'LEGACY_V1'
      ELSE 'TYPED_V2'
    END,
    'sourceObservedAt', p_observed_at,
    'clockAuthority', 'DATABASE_RECORDED_AT',
    'runnerProvenance', v_runner_provenance,
    'leaseProvenance', v_lease_provenance
  );

  FOR v_active IN
    SELECT active.*
      FROM completion_ack_active_obligation active
     WHERE active.session_id = p_session_id AND active.turn_id = p_turn_id
     ORDER BY active.obligation_revision
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(v_active.obligation_id::text, 0));
    SELECT event.state INTO v_latest_state
      FROM completion_ack_obligation_event event
     WHERE event.obligation_revision = v_active.obligation_revision
     ORDER BY event.recorded_at DESC, event.ingested_at DESC, event.id DESC
     LIMIT 1;
    IF v_latest_state IS DISTINCT FROM 'ACTIVE' THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_revision
      FROM completion_ack_obligation_revision revision
     WHERE revision.obligation_revision = v_active.obligation_revision;
    SELECT appended.fact_id, appended.inserted
      INTO v_fact_id, v_inserted
      FROM completion_ack_append_fact(
        v_revision, v_turn.lease_generation, 'COMPLETION_ACK_RECOVERED',
        p_observed_at, v_evidence, v_runner_provenance, v_lease_provenance
      ) appended;
    IF v_inserted THEN v_fact_count := v_fact_count + 1; END IF;
    SELECT fact.evidence_source INTO v_evidence
      FROM completion_ack_fact fact
     WHERE fact.id = v_fact_id;

    INSERT INTO completion_ack_obligation_event (
      id, obligation_id, obligation_revision, state, source_fact_id,
      source_fact_kind, reason_code, evidence_source, evidence_source_digest,
      recorded_at, ingested_at, event_digest
    ) VALUES (
      gen_random_uuid(), v_revision.obligation_id, v_revision.obligation_revision,
      'CLOSED', v_fact_id, 'COMPLETION_ACK_RECOVERED',
      'COMPLETION_ACK_RECOVERED', v_evidence,
      repeat('0', 64)::char(64), v_recorded_at, v_recorded_at,
      repeat('0', 64)::char(64)
    ) ON CONFLICT (event_digest) DO NOTHING;

    PERFORM completion_ack_resolve_blocker(
      v_revision.project_id, v_revision.obligation_id,
      v_revision.obligation_revision, v_recorded_at
    );
    v_closed := v_closed + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'recorded', v_closed > 0,
    'state', 'CLOSED',
    'closedObligationCount', v_closed,
    'recoveryFactCount', v_fact_count,
    'sessionId', p_session_id::text,
    'turnId', p_turn_id::text,
    'databaseRecordedAt', v_recorded_at,
    'sourceObservedAt', p_observed_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION completion_ack_record_failure(
  p_tenant_id uuid,
  p_project_id uuid,
  p_task_id uuid,
  p_session_id uuid,
  p_turn_id uuid,
  p_lease_generation uuid,
  p_fact_kind text,
  p_error_fingerprint text,
  p_observed_at timestamptz,
  p_evidence_source jsonb
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_scope record;
  v_obligation_id char(64);
  v_obligation_revision char(64);
  v_revision completion_ack_obligation_revision%ROWTYPE;
  v_latest_state text;
  v_fact_id uuid;
  v_fact_inserted boolean;
  v_event_inserted boolean := false;
  v_event_row_count bigint := 0;
  v_blocker_id uuid;
  v_effective_lease uuid;
  v_ingested_event_id uuid;
  v_ingested_event_at timestamptz;
  v_ingested_runner_id uuid;
  v_ingested_lease_generation uuid;
  v_runner_provenance text := 'LEGACY_INFERRED';
  v_lease_provenance text := 'LEGACY_INFERRED';
  v_execution_protocol text;
  v_recorded_at timestamptz := statement_timestamp();
  v_evidence jsonb;
BEGIN
  IF p_tenant_id IS NULL OR p_project_id IS NULL OR p_task_id IS NULL
     OR p_session_id IS NULL OR p_turn_id IS NULL THEN
    RAISE EXCEPTION 'COMPLETION_ACK_SCOPE_REQUIRED'
      USING ERRCODE = 'not_null_violation';
  END IF;
  IF p_fact_kind NOT IN ('COMPLETION_ACK_STALE', 'CONTROL_PLANE_COMMIT_REJECTED') THEN
    RAISE EXCEPTION 'COMPLETION_ACK_FAILURE_KIND_INVALID:%', p_fact_kind
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_error_fingerprint IS NULL
     OR length(btrim(p_error_fingerprint)) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'COMPLETION_ACK_ERROR_FINGERPRINT_INVALID'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_evidence_source IS NULL OR jsonb_typeof(p_evidence_source) <> 'object' THEN
    RAISE EXCEPTION 'COMPLETION_ACK_EVIDENCE_SOURCE_MUST_BE_OBJECT'
      USING ERRCODE = 'check_violation';
  END IF;
  IF octet_length(p_evidence_source::text) > 65536 THEN
    RAISE EXCEPTION 'COMPLETION_ACK_EVIDENCE_INPUT_TOO_LARGE'
      USING ERRCODE = 'program_limit_exceeded';
  END IF;

  -- This join is the tenant/scope proof.  In particular, accepting a caller-supplied tenant id is
  -- not sufficient: task.owner_id is the authority and project/session must agree with it.
  SELECT task.owner_id AS tenant_id, task.project_id, task.id AS task_id,
         session.id AS session_id, session.owner_id AS session_owner_id,
         session.task_id AS session_task_id,
         turn.id AS turn_id, turn.session_id AS turn_session_id,
         turn.lease_generation, turn.status AS turn_status,
         turn.kind AS turn_kind, turn.client_turn_id, turn.delivered_at,
         project.owner_id AS project_owner_id
    INTO v_scope
    FROM task
    JOIN project ON project.id = task.project_id
    JOIN session ON session.id = p_session_id AND session.task_id = task.id
    JOIN conversation_turn turn
      ON turn.id = p_turn_id AND turn.session_id = session.id
   WHERE task.id = p_task_id
     AND task.project_id = p_project_id
     AND task.owner_id = p_tenant_id
     AND project.owner_id = p_tenant_id
     AND session.owner_id = p_tenant_id
   FOR SHARE OF task, project, session, turn;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'COMPLETION_ACK_SCOPE_MISMATCH:%:%:%:%:%',
      p_tenant_id, p_project_id, p_task_id, p_session_id, p_turn_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended(concat('completion-ack-task:v1:', p_task_id::text), 0)
  );

  -- Reserved acceptance shells are admitted independent of their typed execution lane.  The ACK
  -- detector never reads admission/attempt state, so either protocol remains visible when the
  -- control-plane commit itself is stuck.
  IF v_scope.turn_kind IS DISTINCT FROM 'shell'
     OR NOT (v_scope.client_turn_id LIKE 'system:task-acceptance:v1:%'
       OR v_scope.client_turn_id LIKE 'system:task-acceptance:v2:%') THEN
    RETURN jsonb_build_object(
      'recorded', false,
      'eligible', false,
      'reason', 'TURN_NOT_ACCEPTANCE_SHELL',
      'sessionId', p_session_id::text,
      'turnId', p_turn_id::text,
      'databaseRecordedAt', v_recorded_at
    );
  END IF;
  v_execution_protocol := CASE
    WHEN v_scope.client_turn_id LIKE 'system:task-acceptance:v1:%' THEN 'LEGACY_V1'
    ELSE 'TYPED_V2'
  END;

  IF p_evidence_source ? 'ingestedRunEventId' THEN
    BEGIN
      SELECT event.id, COALESCE(event.ingested_at, rollout.rollout_recorded_at),
             event.ingested_by_runner_id,
             event.ingested_under_lease_generation
        INTO v_ingested_event_id, v_ingested_event_at, v_ingested_runner_id,
             v_ingested_lease_generation
        FROM run_event event
        CROSS JOIN completion_ack_rollout_epoch rollout
       WHERE event.id = (p_evidence_source->>'ingestedRunEventId')::uuid
         AND event.session_id = p_session_id
         AND event.turn_id = p_turn_id
         AND event.type = 'tool_result'
         AND event.payload->>'toolUseId' = concat('shell-', p_turn_id::text);
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'COMPLETION_ACK_INGESTED_EVENT_ID_INVALID'
        USING ERRCODE = 'check_violation';
    END;
    IF v_ingested_event_id IS NULL THEN
      RAISE EXCEPTION 'COMPLETION_ACK_INGESTED_EVENT_SCOPE_MISMATCH'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF v_ingested_runner_id IS NOT NULL THEN
      v_runner_provenance := 'INGESTED_EXACT';
    END IF;
    IF v_ingested_lease_generation IS NOT NULL THEN
      v_lease_provenance := 'INGESTED_EXACT';
    END IF;
  END IF;

  IF p_lease_generation IS NOT NULL AND v_scope.lease_generation IS NOT NULL
     AND p_lease_generation <> v_scope.lease_generation THEN
    RAISE EXCEPTION 'COMPLETION_ACK_LEASE_MISMATCH:%:%',
      p_lease_generation, v_scope.lease_generation
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_ingested_lease_generation IS NOT NULL
     AND COALESCE(p_lease_generation, v_scope.lease_generation) IS NOT NULL
     AND v_ingested_lease_generation
         <> COALESCE(p_lease_generation, v_scope.lease_generation) THEN
    RAISE EXCEPTION 'COMPLETION_ACK_EVENT_LEASE_MISMATCH:%:%',
      v_ingested_lease_generation,
      COALESCE(p_lease_generation, v_scope.lease_generation)
      USING ERRCODE = 'check_violation';
  END IF;
  v_effective_lease := COALESCE(
    p_lease_generation, v_scope.lease_generation,
    v_ingested_lease_generation
  );

  -- A later rejection observation may race an already committed ACK.  ANSWERED is authoritative;
  -- do not reopen it and do not infer recovery from Session status.
  IF v_scope.turn_status = 'ANSWERED' THEN
    RETURN completion_ack_record_recovery(
      p_session_id, p_turn_id, p_observed_at,
      p_evidence_source || jsonb_build_object('source', 'FAILURE_OBSERVED_AFTER_ACK')
    );
  END IF;
  IF v_scope.turn_status IS DISTINCT FROM 'IN_FLIGHT' THEN
    RETURN jsonb_build_object(
      'recorded', false,
      'eligible', false,
      'reason', 'TURN_NOT_IN_FLIGHT',
      'turnStatus', v_scope.turn_status,
      'sessionId', p_session_id::text,
      'turnId', p_turn_id::text,
      'databaseRecordedAt', v_recorded_at
    );
  END IF;

  v_obligation_id := completion_ack_obligation_id(
    p_task_id, p_session_id, p_turn_id, btrim(p_error_fingerprint)
  );
  v_obligation_revision := completion_ack_obligation_revision(
    p_task_id, p_session_id, p_turn_id, btrim(p_error_fingerprint)
  );
  PERFORM pg_advisory_xact_lock(hashtextextended(v_obligation_id::text, 0));

  INSERT INTO completion_ack_obligation_revision (
    obligation_id, obligation_revision, tenant_id, project_id, task_id,
    session_id, turn_id, error_fingerprint
  ) VALUES (
    v_obligation_id, v_obligation_revision, p_tenant_id, p_project_id, p_task_id,
    p_session_id, p_turn_id, btrim(p_error_fingerprint)
  ) ON CONFLICT (obligation_revision) DO NOTHING;

  SELECT * INTO v_revision
    FROM completion_ack_obligation_revision revision
   WHERE revision.obligation_revision = v_obligation_revision;
  IF NOT FOUND OR v_revision.obligation_id <> v_obligation_id
     OR v_revision.tenant_id <> p_tenant_id OR v_revision.project_id <> p_project_id
     OR v_revision.task_id <> p_task_id OR v_revision.session_id <> p_session_id
     OR v_revision.turn_id <> p_turn_id THEN
    RAISE EXCEPTION 'COMPLETION_ACK_OBLIGATION_IDENTITY_COLLISION:%', v_obligation_revision
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  v_evidence := completion_ack_sanitize_evidence(
    p_fact_kind, p_evidence_source
  ) || jsonb_build_object(
    'sourceObservedAt', p_observed_at,
    'databaseRecordedAt', v_recorded_at,
    'turnDeliveredAt', v_scope.delivered_at,
    'turnClientId', v_scope.client_turn_id,
    'turnStatus', v_scope.turn_status,
    'executionProtocol', v_execution_protocol,
    'observedErrorFingerprint', btrim(p_error_fingerprint),
    'ingestedRunEventId', v_ingested_event_id::text,
    'ingestedAt', v_ingested_event_at,
    'ingestedByRunnerId', v_ingested_runner_id::text,
    'ingestedUnderLeaseGeneration',
      v_ingested_lease_generation::text,
    'runnerProvenance', v_runner_provenance,
    'leaseProvenance', v_lease_provenance,
    'clockAuthority', 'DATABASE_RECORDED_AT'
  );
  SELECT appended.fact_id, appended.inserted
    INTO v_fact_id, v_fact_inserted
    FROM completion_ack_append_fact(
      v_revision, v_effective_lease, p_fact_kind, p_observed_at, v_evidence,
      v_runner_provenance, v_lease_provenance
    ) appended;
  -- The immutable fact is first-observation-per-kind.  A replay advances only the bounded,
  -- non-authoritative monotone register; lifecycle/event cardinality is unchanged.
  IF NOT v_fact_inserted THEN
    PERFORM completion_ack_record_observation(
      v_revision, v_fact_id, v_effective_lease, p_fact_kind,
      p_observed_at, v_evidence, v_runner_provenance, v_lease_provenance
    );
  END IF;
  SELECT fact.evidence_source INTO v_evidence
    FROM completion_ack_fact fact
   WHERE fact.id = v_fact_id;

  SELECT event.state INTO v_latest_state
    FROM completion_ack_obligation_event event
   WHERE event.obligation_revision = v_obligation_revision
   ORDER BY event.recorded_at DESC, event.ingested_at DESC, event.id DESC
   LIMIT 1;
  IF v_latest_state IS DISTINCT FROM 'ACTIVE' THEN
    INSERT INTO completion_ack_obligation_event (
      id, obligation_id, obligation_revision, state, source_fact_id,
      source_fact_kind, reason_code, evidence_source, evidence_source_digest,
      recorded_at, ingested_at, event_digest
    ) VALUES (
      gen_random_uuid(), v_obligation_id, v_obligation_revision, 'ACTIVE', v_fact_id,
      p_fact_kind, p_fact_kind, v_evidence, repeat('0', 64)::char(64),
      v_recorded_at, v_recorded_at, repeat('0', 64)::char(64)
    ) ON CONFLICT (event_digest) DO NOTHING;
    GET DIAGNOSTICS v_event_row_count = ROW_COUNT;
    v_event_inserted := v_event_row_count > 0;
  END IF;

  v_blocker_id := completion_ack_sync_blocker(v_obligation_revision, v_recorded_at);
  RETURN jsonb_build_object(
    'recorded', true,
    'eligible', true,
    'factId', v_fact_id::text,
    'factInserted', v_fact_inserted,
    'activeEventInserted', v_event_inserted,
    'obligationId', v_obligation_id::text,
    'obligationRevision', v_obligation_revision::text,
    'state', 'ACTIVE',
    'blockerId', v_blocker_id::text,
    'databaseRecordedAt', v_recorded_at,
    'sourceObservedAt', p_observed_at,
    'provenance', jsonb_strip_nulls(jsonb_build_object(
      'protocol', v_execution_protocol,
      'runner', v_runner_provenance,
      'lease', v_lease_provenance,
      'typedAttempt', CASE WHEN v_execution_protocol = 'LEGACY_V1' THEN false END,
      'typedAdmission', CASE WHEN v_execution_protocol = 'LEGACY_V1' THEN false END,
      'typedStateDependency', 'NOT_READ'
    ))
  );
END;
$$;

CREATE OR REPLACE FUNCTION completion_ack_evaluate(
  p_session_id uuid,
  p_turn_id uuid,
  p_observed_at timestamptz,
  p_evidence_source jsonb
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_status text; v_active_count bigint;
BEGIN
  SELECT turn.status INTO v_status
    FROM conversation_turn turn
   WHERE turn.id = p_turn_id AND turn.session_id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'COMPLETION_ACK_TURN_SCOPE_MISMATCH:%:%', p_session_id, p_turn_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_status = 'ANSWERED' THEN
    RETURN completion_ack_record_recovery(
      p_session_id, p_turn_id, p_observed_at,
      COALESCE(p_evidence_source, '{}'::jsonb) || jsonb_build_object(
        'source', 'COMPLETION_ACK_EVALUATE'
      )
    );
  END IF;
  SELECT count(*) INTO v_active_count
    FROM completion_ack_active_obligation active
   WHERE active.session_id = p_session_id AND active.turn_id = p_turn_id;
  RETURN jsonb_build_object(
    'recorded', false,
    'state', CASE WHEN v_active_count > 0 THEN 'ACTIVE' ELSE 'NO_OBLIGATION' END,
    'activeObligationCount', v_active_count,
    'turnStatus', v_status,
    'sessionId', p_session_id::text,
    'turnId', p_turn_id::text,
    'databaseRecordedAt', statement_timestamp(),
    'sourceObservedAt', p_observed_at
  );
END;
$$;

-- This partial index is the detector's only turn scan.  Both reserved acceptance protocols are
-- included, but typed admission/attempt tables remain outside the detector's authority.
CREATE INDEX conversation_turn_completion_ack_scan_idx
  ON conversation_turn(delivered_at, id)
  WHERE status = 'IN_FLIGHT'
    AND kind = 'shell'
    AND (client_turn_id LIKE 'system:task-acceptance:v1:%'
      OR client_turn_id LIKE 'system:task-acceptance:v2:%');

CREATE OR REPLACE FUNCTION completion_ack_reconcile_stale(
  p_observed_at timestamptz,
  p_detection_delta_seconds integer,
  p_limit integer
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_recorded_at timestamptz := statement_timestamp();
  v_candidate record;
  v_active record;
  v_result jsonb;
  v_candidate_count integer := 0;
  v_fact_count integer := 0;
  v_recovered_count integer := 0;
  v_active_count bigint := 0;
BEGIN
  IF p_detection_delta_seconds IS NULL
     OR p_detection_delta_seconds NOT BETWEEN 1 AND 86400 THEN
    RAISE EXCEPTION 'COMPLETION_ACK_DETECTION_DELTA_INVALID:%', p_detection_delta_seconds
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'COMPLETION_ACK_RECONCILE_LIMIT_INVALID:%', p_limit
      USING ERRCODE = 'check_violation';
  END IF;

  -- ANSWERED without the explicit callback commit receipt remains fail-closed.  This lane refreshes
  -- its compatibility projection but cannot manufacture recovery from status or task judgment.
  FOR v_active IN
    SELECT DISTINCT active.session_id, active.turn_id
      FROM completion_ack_active_obligation active
     JOIN conversation_turn turn
        ON turn.id = active.turn_id AND turn.session_id = active.session_id
     WHERE turn.status = 'ANSWERED'
     ORDER BY active.session_id, active.turn_id
     LIMIT p_limit
  LOOP
    v_result := completion_ack_record_recovery(
      v_active.session_id, v_active.turn_id, p_observed_at,
      jsonb_build_object(
        'source', 'INDEPENDENT_COMPLETION_ACK_RECONCILER',
        'detectorRecordedAt', v_recorded_at,
        'clockAuthority', 'DATABASE_RECORDED_AT'
      )
    );
    v_recovered_count := v_recovered_count
      + COALESCE((v_result->>'closedObligationCount')::integer, 0);
  END LOOP;

  -- A terminal same-turn runner event is outcome-neutral: exit 0 and exit nonzero both require a
  -- durable ACK.  Its DB-owned ingested_at (not runner created_at and not command delivered_at)
  -- starts the detection window. No admission, typed attempt, or 0194 outcome stream is read.
  FOR v_candidate IN
    SELECT task.owner_id AS tenant_id,
           task.project_id,
           task.id AS task_id,
           session.id AS session_id,
           turn.id AS turn_id,
           turn.lease_generation,
           turn.client_turn_id,
           turn.delivered_at,
           terminal_event.id AS terminal_event_id,
           terminal_event.seq AS terminal_event_seq,
           terminal_event.type AS terminal_event_type,
           terminal_event.created_at AS terminal_event_source_time,
           terminal_event.ingested_at AS terminal_event_ingested_at,
           terminal_event.ingested_by_runner_id,
           terminal_event.ingested_under_lease_generation,
           terminal_event.payload AS terminal_event_payload,
           CASE
             WHEN turn.client_turn_id LIKE 'system:task-acceptance:v1:%'
               THEN 'LEGACY_V1_TERMINAL_EVIDENCE_WITHOUT_COMPLETION_ACK'
             ELSE 'TYPED_V2_TERMINAL_EVIDENCE_WITHOUT_COMPLETION_ACK'
           END AS error_fingerprint
      FROM conversation_turn turn
      JOIN session ON session.id = turn.session_id
      JOIN task ON task.id = session.task_id
      JOIN project ON project.id = task.project_id AND project.owner_id = task.owner_id
      LEFT JOIN workspace execution_workspace ON execution_workspace.id = session.workspace_id
      CROSS JOIN completion_ack_rollout_epoch rollout
      -- run_event_turn_id_idx (migration 0012) supplies the bounded per-turn lookup.  Deliberately
      -- do not build a new index on the multi-gigabyte append-only event table in this transactional
      -- rollout.
      JOIN LATERAL (
        SELECT event.id, event.seq, event.type, event.created_at,
               COALESCE(event.ingested_at, rollout.rollout_recorded_at) AS ingested_at,
               event.ingested_by_runner_id, event.ingested_under_lease_generation,
               event.payload
          FROM run_event event
         WHERE event.session_id = turn.session_id
           AND event.turn_id = turn.id
           AND event.type = 'tool_result'
           AND event.payload->>'toolUseId' = concat('shell-', turn.id::text)
         ORDER BY event.seq DESC, event.ingested_at DESC, event.id DESC
         LIMIT 1
      ) terminal_event ON true
     WHERE turn.status = 'IN_FLIGHT'
       AND turn.kind = 'shell'
       AND (turn.client_turn_id LIKE 'system:task-acceptance:v1:%'
         OR turn.client_turn_id LIKE 'system:task-acceptance:v2:%')
       AND turn.delivered_at IS NOT NULL
       AND session.starts_task_work = true
       AND session.owner_id = task.owner_id
       AND (session.workspace_id IS NULL
         OR execution_workspace.owner_id = task.owner_id)
       AND terminal_event.ingested_at <= v_recorded_at
         - make_interval(secs => p_detection_delta_seconds)
       -- An active identity is routed/recovered by its own bounded lane.  Excluding it before LIMIT
       -- is the fairness boundary: the oldest N stale rows cannot monopolize every later scan.
       AND NOT EXISTS (
         SELECT 1
           FROM completion_ack_active_obligation active
          WHERE active.session_id = turn.session_id
            AND active.turn_id = turn.id
       )
     ORDER BY terminal_event.ingested_at, turn.id
     LIMIT p_limit
  LOOP
    v_candidate_count := v_candidate_count + 1;
    v_result := completion_ack_record_failure(
      v_candidate.tenant_id, v_candidate.project_id, v_candidate.task_id,
      v_candidate.session_id, v_candidate.turn_id, v_candidate.lease_generation,
      'COMPLETION_ACK_STALE', v_candidate.error_fingerprint, p_observed_at,
      jsonb_build_object(
        'source', 'INDEPENDENT_COMPLETION_ACK_RECONCILER',
        'detectorRecordedAt', v_recorded_at,
        'detectionDeltaSeconds', p_detection_delta_seconds,
        'turnClientId', v_candidate.client_turn_id,
        'turnDeliveredAt', v_candidate.delivered_at,
        'terminalEvent', jsonb_build_object(
          'id', v_candidate.terminal_event_id::text,
          'seq', v_candidate.terminal_event_seq,
          'type', v_candidate.terminal_event_type,
          'sourceTime', v_candidate.terminal_event_source_time,
          'ingestedAt', v_candidate.terminal_event_ingested_at,
          'payloadDigest', completion_ack_json_digest(v_candidate.terminal_event_payload)
        ),
        'ingestedRunEventId', v_candidate.terminal_event_id::text,
        'ingestedAt', v_candidate.terminal_event_ingested_at,
        'ingestedByRunnerId', v_candidate.ingested_by_runner_id::text,
        'ingestedUnderLeaseGeneration',
          v_candidate.ingested_under_lease_generation::text,
        'sloClock', 'DATABASE_RECORDED_AT',
        'runnerEventTimeIsSloClock', false,
        'runnerProvenance', CASE WHEN v_candidate.ingested_by_runner_id IS NULL
          THEN 'LEGACY_INFERRED' ELSE 'INGESTED_EXACT' END,
        'leaseProvenance', CASE
          WHEN v_candidate.ingested_under_lease_generation IS NULL
          THEN 'LEGACY_INFERRED' ELSE 'INGESTED_EXACT' END
      )
    );
    IF COALESCE((v_result->>'factInserted')::boolean, false) THEN
      v_fact_count := v_fact_count + 1;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_active_count FROM completion_ack_active_obligation;
  RETURN jsonb_build_object(
    'databaseRecordedAt', v_recorded_at,
    'sourceObservedAt', p_observed_at,
    'clockAuthority', 'DATABASE_RECORDED_AT',
    'candidateCount', v_candidate_count,
    'newFactCount', v_fact_count,
    'recoveredObligationCount', v_recovered_count,
    'activeObligationCount', v_active_count
  );
END;
$$;

-- Compatibility surfaces accept the new reason but never become its authority.
ALTER TABLE project_blocker DROP CONSTRAINT project_blocker_kind_chk;
ALTER TABLE project_blocker ADD CONSTRAINT project_blocker_kind_chk CHECK (kind IN (
  'WHO_UNRESOLVED', 'WHO_NOT_IN_TEAM', 'WHO_DISABLED', 'PROVIDER_UNAVAILABLE',
  'RUNTIME_REQUIREMENT_UNMET', 'NO_PROJECT_WORKSPACE', 'NO_MATCHING_RUNNER',
  'MERGE_CONFLICT', 'TEST_FAILED', 'VERIFICATION_FAILED', 'BUDGET_EXHAUSTED',
  'AWAITING_USER_APPROVAL', 'AWAITING_USER_INPUT', 'POLICY_MANUAL_HOLD',
  'DEPENDENCY_CYCLE', 'COORDINATOR_UNAVAILABLE', 'COORDINATOR_NO_PROGRESS',
  'AGGREGATE_PARENT_UNSATISFIABLE', 'SUCCESSOR_OUTSIDE_SUBTREE',
  'VERIFICATION_REQUIRED', 'VERIFICATION_CANNOT_CONCLUDE', 'ENVIRONMENT_BROKEN',
  'HUMAN_DECISION_REQUIRED', 'VERDICT_APPLY_EXHAUSTED',
  'COMPLETION_ACK_STALE', 'UNKNOWN_FAILURE'
));

ALTER TABLE project_coordinator_wake
  DROP CONSTRAINT project_coordinator_wake_event_chk;
ALTER TABLE project_coordinator_wake
  ADD CONSTRAINT project_coordinator_wake_event_chk CHECK ("event" IN (
    'ATTEMPT_ENDED_UNSETTLED',
    'ATTEMPT_BUDGET_SPENT',
    'PROJECT_TASKS_SETTLED',
    'CRITERION_READY',
    'COMPLETION_EVIDENCE_REVISED',
    'EXECUTABLE_RESULT_RECORDED',
    'VERIFICATION_VERDICT_RECORDED',
    'HUMAN_SIGNOFF_REQUESTED',
    'HUMAN_SIGNOFF_DECIDED',
    'HUMAN_SIGNOFF_REQUEST_SUPERSEDED',
    'COMPLETION_ACK_STALE'
  ));
ALTER TABLE project_coordinator_wake
  ADD CONSTRAINT project_coordinator_wake_completion_ack_subject_chk CHECK (
    event <> 'COMPLETION_ACK_STALE' OR subject_type = 'TASK'
  );

-- Operational obligations are appended only after a projection-only read.  Migration 0200's
-- first overlay replaced doneGate before project_canonical_done_gate compared it with expected_gate,
-- causing a healthy projection plus a stale watchdog to be mislabeled RECONCILER_STALE.  The
-- explicit two-stage functions below make the integrity cut observable and regression-testable.
CREATE OR REPLACE FUNCTION completion_ack_overlay_read_surface(
  p_payload jsonb,
  p_project_id uuid,
  p_surface text
) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_payload jsonb := COALESCE(p_payload, '{}'::jsonb);
  v_obligations jsonb;
  v_existing_obligations jsonb;
  v_existing_blocking jsonb;
  v_done_gate jsonb;
  v_operational_reason jsonb;
  v_primary_reason jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(
           active.obligation || jsonb_build_object(
             'bindingDigest', active.obligation_revision::text,
             'capability', 'completion-ack.recover',
             'staleness', 'COMPLETION_ACK_STALE'
           ) ORDER BY active.first_failure_at, active.obligation_revision
         ), '[]'::jsonb)
    INTO v_obligations
    FROM completion_ack_active_obligation active
   WHERE active.project_id = p_project_id;

  IF jsonb_array_length(v_obligations) = 0 THEN
    RETURN v_payload;
  END IF;
  v_existing_obligations := CASE WHEN jsonb_typeof(v_payload->'obligations') = 'array'
    THEN v_payload->'obligations' ELSE '[]'::jsonb END;
  v_existing_blocking := CASE WHEN jsonb_typeof(v_payload->'blockingObligations') = 'array'
    THEN v_payload->'blockingObligations' ELSE '[]'::jsonb END;
  v_done_gate := CASE WHEN jsonb_typeof(v_payload->'doneGate') = 'object'
    THEN v_payload->'doneGate' ELSE '{}'::jsonb END;
  v_operational_reason := v_obligations->0->'reasonDetail';
  v_primary_reason := CASE
    WHEN v_done_gate->>'allowed' IS DISTINCT FROM 'true'
      AND jsonb_typeof(v_done_gate->'reason') = 'object'
    THEN v_done_gate->'reason'
    ELSE v_operational_reason
  END;

  RETURN v_payload || jsonb_build_object(
    'surface', COALESCE(v_payload->>'surface', p_surface),
    'staleness', 'OPERATIONAL_BLOCKED',
    'obligations', v_existing_obligations || v_obligations,
    'blockingObligations', v_existing_blocking || v_obligations,
    'activeObligationCount',
      jsonb_array_length(v_existing_obligations) + jsonb_array_length(v_obligations),
    'completionAckObligations', v_obligations,
    'doneGate', v_done_gate || jsonb_build_object(
      'allowed', false,
      'decision', 'DENY',
      'reason', v_primary_reason,
      'reasons', CASE WHEN jsonb_typeof(v_done_gate->'reasons') = 'array'
        THEN v_done_gate->'reasons' ELSE '[]'::jsonb END
        || jsonb_build_array(v_operational_reason),
      'blockingReasons', CASE WHEN jsonb_typeof(v_done_gate->'blockingReasons') = 'array'
        THEN v_done_gate->'blockingReasons' ELSE '[]'::jsonb END
        || jsonb_build_array(v_operational_reason),
      'operationalObligations', v_obligations,
      'operationalState', 'COMPLETION_ACK_STALE',
      'staleness', 'OPERATIONAL_BLOCKED'
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION completion_ack_operational_read_surface(
  p_authenticated_tenant uuid,
  p_project_id uuid,
  p_subject_type text,
  p_subject_id text,
  p_surface text
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
   SET search_path = pg_catalog, public, outcome_projection AS $$
DECLARE
  v_projection jsonb;
  v_runtime jsonb;
  v_reason jsonb;
BEGIN
  BEGIN
    v_projection := outcome_projection.read_surface_projection_only(
      p_authenticated_tenant, p_project_id, p_subject_type, p_subject_id, p_surface
    );
  EXCEPTION WHEN no_data_found THEN
    -- A missing 0194 stream is a canonical-projection outage, not permission to hide an exact
    -- 0201 obligation.  Only the tenant-bound ACTIVE fact can activate this fallback; projects
    -- without one retain the original projection error semantics.
    IF NOT EXISTS (
      SELECT 1 FROM completion_ack_active_obligation active
       WHERE active.tenant_id = p_authenticated_tenant
         AND active.project_id = p_project_id
    ) THEN
      RAISE;
    END IF;
    v_reason := jsonb_build_object(
      'code', 'CANONICAL_PROJECTION_UNAVAILABLE',
      'category', 'CANONICAL_PROJECTION',
      'message', 'Canonical outcome projection is unavailable; completion ACK recovery remains required.',
      'owner', 'SYSTEM',
      'blocksGate', true,
      'nextAction', 'RESTORE_CANONICAL_PROJECTION_STREAM'
    );
    v_projection := jsonb_build_object(
      'surface', p_surface,
      'projectId', p_project_id::text,
      'subjectType', p_subject_type,
      'subjectId', p_subject_id,
      'staleness', 'CANONICAL_PROJECTION_UNAVAILABLE',
      'canonicalProjectionAvailable', false,
      'canonicalProjectionErrorCode', 'OUTCOME_PROJECTION_STREAM_NOT_FOUND',
      'obligations', '[]'::jsonb,
      'blockingObligations', '[]'::jsonb,
      'activeObligationCount', 0,
      'doneGate', jsonb_build_object(
        'allowed', false,
        'decision', 'DENY',
        'reason', v_reason,
        'reasons', jsonb_build_array(v_reason),
        'blockingReasons', jsonb_build_array(v_reason),
        'staleness', 'CANONICAL_PROJECTION_UNAVAILABLE'
      )
    );
  END;
  v_runtime := executable_runtime_overlay_read_surface(
    v_projection || jsonb_build_object(
      'canonicalDoneGate', v_projection->'doneGate',
      'projectionIntegritySource', CASE
        WHEN v_projection->>'canonicalProjectionAvailable' = 'false'
          THEN 'UNAVAILABLE_NO_OUTCOME_STREAM'
        ELSE 'read_surface_projection_only'
      END
    ),
    p_surface
  );
  RETURN completion_ack_overlay_read_surface(v_runtime, p_project_id, p_surface);
END;
$$;

-- A private, transaction-local mode lets the pre-0201 gate body perform its integrity comparison
-- without copying hundreds of lines of canonical proof logic.  Public reads remain operational;
-- the closure wrapper below always restores the previous setting before applying overlays.
CREATE OR REPLACE FUNCTION outcome_projection.read_surface(
  p_authenticated_tenant uuid,
  p_project_id uuid,
  p_subject_type text,
  p_subject_id text,
  p_surface text
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
   SET search_path = pg_catalog, public, outcome_projection AS $$
  SELECT CASE
    WHEN current_setting('orbit.projection_integrity_only', true) = 'on'
      THEN outcome_projection.read_surface_projection_only(
        p_authenticated_tenant, p_project_id, p_subject_type, p_subject_id, p_surface
      )
    ELSE completion_ack_operational_read_surface(
      p_authenticated_tenant, p_project_id, p_subject_type, p_subject_id, p_surface
    )
  END
$$;

ALTER FUNCTION project_canonical_done_gate(uuid, text, text)
  RENAME TO project_canonical_done_gate_projection_integrity_body;

CREATE FUNCTION project_canonical_done_gate(
  p_project uuid,
  p_subject_type text DEFAULT 'PROJECT',
  p_subject_id text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
   SET search_path = pg_catalog, public, outcome_projection AS $$
DECLARE
  v_previous_mode text := current_setting('orbit.projection_integrity_only', true);
  v_canonical_gate jsonb;
  v_operational_surface jsonb;
  v_projection_available boolean := true;
  v_projection_reason jsonb;
BEGIN
  PERFORM set_config('orbit.projection_integrity_only', 'on', true);
  BEGIN
    v_canonical_gate := project_canonical_done_gate_projection_integrity_body(
      p_project, p_subject_type, p_subject_id
    );
  EXCEPTION WHEN no_data_found THEN
    PERFORM set_config(
      'orbit.projection_integrity_only', COALESCE(v_previous_mode, ''), true
    );
    IF NOT EXISTS (
      SELECT 1 FROM completion_ack_active_obligation active
       WHERE active.project_id = p_project
    ) THEN
      RAISE;
    END IF;
    v_projection_available := false;
    v_projection_reason := jsonb_build_object(
      'code', 'CANONICAL_PROJECTION_UNAVAILABLE',
      'category', 'CANONICAL_PROJECTION',
      'message', 'Canonical outcome projection is unavailable; completion ACK recovery remains required.',
      'owner', 'SYSTEM',
      'blocksGate', true,
      'nextAction', 'RESTORE_CANONICAL_PROJECTION_STREAM'
    );
    v_canonical_gate := jsonb_build_object(
      'allowed', false,
      'decision', 'DENY',
      'reason', v_projection_reason,
      'reasons', jsonb_build_array(v_projection_reason),
      'blockingReasons', jsonb_build_array(v_projection_reason),
      'staleness', 'CANONICAL_PROJECTION_UNAVAILABLE',
      'canonicalProjectionAvailable', false,
      'canonicalProjectionErrorCode', 'OUTCOME_PROJECTION_STREAM_NOT_FOUND'
    );
  WHEN OTHERS THEN
    PERFORM set_config(
      'orbit.projection_integrity_only', COALESCE(v_previous_mode, ''), true
    );
    RAISE;
  END;
  PERFORM set_config(
    'orbit.projection_integrity_only', COALESCE(v_previous_mode, ''), true
  );

  -- Apply operational liveness only after the canonical projection/checksum comparison succeeded
  -- (or returned its own structured denial).  Operational state can deny closure but can no longer
  -- masquerade as a corrupt or stale canonical projection.
  v_operational_surface := completion_ack_overlay_read_surface(
    executable_runtime_overlay_read_surface(
      jsonb_build_object(
        'surface', 'DONE_GATE',
        'canonicalDoneGate', v_canonical_gate,
        'projectionIntegritySource', 'project_canonical_done_gate_projection_integrity_body',
        'doneGate', v_canonical_gate,
        'obligations', '[]'::jsonb,
        'blockingObligations', '[]'::jsonb,
        'activeObligationCount', 0
      ),
      'DONE_GATE'
    ),
    p_project,
    'DONE_GATE'
  );
  RETURN COALESCE(v_operational_surface->'doneGate', v_canonical_gate)
    || jsonb_build_object(
      'projectionIntegrity', CASE WHEN v_projection_available
        THEN 'PROJECTION_ONLY_CHECKED' ELSE 'UNAVAILABLE_FAIL_CLOSED' END,
      'canonicalDoneGate', v_canonical_gate,
      'operationalObligations', COALESCE(
        v_operational_surface->'completionAckObligations', '[]'::jsonb
      ),
      'runtimeLiveness', COALESCE(v_operational_surface->'runtimeLiveness', '[]'::jsonb)
    );
END;
$$;

-- Stable test/read entry: callers can assert that operational overlays changed only the second
-- surface, while canonicalDoneGate remains byte-for-byte the projection-only value.
CREATE OR REPLACE FUNCTION completion_ack_done_gate_surface_probe(
  p_authenticated_tenant uuid,
  p_project_id uuid,
  p_subject_type text DEFAULT 'PROJECT',
  p_subject_id text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
   SET search_path = pg_catalog, public, outcome_projection AS $$
DECLARE
  v_subject_id text := COALESCE(NULLIF(p_subject_id, ''), p_project_id::text);
  v_projection jsonb;
  v_operational jsonb;
  v_reason jsonb;
BEGIN
  BEGIN
    v_projection := outcome_projection.read_surface_projection_only(
      p_authenticated_tenant, p_project_id, p_subject_type,
      v_subject_id, 'DONE_GATE'
    );
  EXCEPTION WHEN no_data_found THEN
    IF NOT EXISTS (
      SELECT 1 FROM completion_ack_active_obligation active
       WHERE active.tenant_id = p_authenticated_tenant
         AND active.project_id = p_project_id
    ) THEN
      RAISE;
    END IF;
    v_reason := jsonb_build_object(
      'code', 'CANONICAL_PROJECTION_UNAVAILABLE',
      'category', 'CANONICAL_PROJECTION',
      'message', 'Canonical outcome projection is unavailable; completion ACK recovery remains required.',
      'owner', 'SYSTEM', 'blocksGate', true,
      'nextAction', 'RESTORE_CANONICAL_PROJECTION_STREAM'
    );
    v_projection := jsonb_build_object(
      'surface', 'DONE_GATE',
      'canonicalProjectionAvailable', false,
      'canonicalProjectionErrorCode', 'OUTCOME_PROJECTION_STREAM_NOT_FOUND',
      'doneGate', jsonb_build_object(
        'allowed', false, 'decision', 'DENY', 'reason', v_reason,
        'reasons', jsonb_build_array(v_reason),
        'blockingReasons', jsonb_build_array(v_reason),
        'staleness', 'CANONICAL_PROJECTION_UNAVAILABLE'
      )
    );
  END;
  v_operational := completion_ack_operational_read_surface(
    p_authenticated_tenant, p_project_id, p_subject_type,
    v_subject_id, 'DONE_GATE'
  );
  RETURN jsonb_build_object(
    'projectionOnly', v_projection,
    'operational', v_operational,
    'projectionIntegrityPreserved',
      v_operational->'canonicalDoneGate' IS NOT DISTINCT FROM v_projection->'doneGate'
  );
END;
$$;

COMMENT ON TABLE completion_ack_fact IS
  'Append-only DB-clocked canonical completion-ACK facts for reserved v1/v2 acceptance shells: at most the first fact per failure kind and one recovery fact per execution-scoped obligation; never an executable attempt or admission.';
COMMENT ON COLUMN completion_ack_fact.recorded_at IS
  'PostgreSQL statement clock and sole SLO clock; caller/runner time is retained only as source_observed_at/evidence.';
COMMENT ON COLUMN completion_ack_fact.ingested_at IS
  'PostgreSQL ingestion ordering clock, forcibly stamped by the BEFORE INSERT trigger.';
COMMENT ON COLUMN completion_ack_fact.lease_provenance IS
  'INGESTED_EXACT only for a post-0201 event identity snapshot; otherwise LEGACY_INFERRED. Neither value manufactures typed-attempt authority.';
COMMENT ON TABLE completion_ack_obligation_event IS
  'Append-only ACTIVE/CLOSED lifecycle events; the latest event plus facts derives the active obligation.';
COMMENT ON TABLE completion_ack_observation_register IS
  'Non-authoritative, tenant-bound, bounded monotone operational telemetry. Direct delete/reset/rebind is rejected; disaster loss can be rebuilt only to a canonical-fact baseline. It never decides identity, ACTIVE/CLOSED, completion, or doneGate.';
COMMENT ON COLUMN completion_ack_observation_register.recent_observations IS
  'At most eight 15-second/evidence semantic observations; same-key transport retries aggregate occurrences. The immutable facts remain the audit authority.';
COMMENT ON VIEW completion_ack_active_obligation IS
  'Current completion ACK obligations reduced only from immutable revisions/append-only events and facts; a LEFT JOIN adds explicitly non-authoritative bounded retry telemetry.';
COMMENT ON FUNCTION completion_ack_record_failure(uuid, uuid, uuid, uuid, uuid, uuid, text, text, timestamptz, jsonb) IS
  'Validate tenant/project/task/session/reserved-acceptance-turn scope, merge all fingerprints for one execution into one lifecycle, append at most the first fact per failure kind and one ACTIVE episode, then monotonically aggregate bounded retry telemetry.';
COMMENT ON FUNCTION completion_ack_reconcile_stale(timestamptz, integer, integer) IS
  'Fair independent v1/v2 acceptance-shell detector using the DB-ingestion age of the exact same-turn shell tool_result, outcome-neutral; excludes ACTIVE identities and does not read typed attempts/admissions or outcome streams.';
COMMENT ON FUNCTION completion_ack_record_recovery(uuid, uuid, timestamptz, jsonb) IS
  'Close active obligations only from ANSWERED plus an exact runner turn-complete commit receipt bound to the same shell event/runner/lease; PASS, FAIL and typed continuation semantics are deliberately irrelevant.';
COMMENT ON FUNCTION completion_ack_rebuild_observation_baseline(char(64)) IS
  'Insert only missing non-authoritative telemetry from immutable failure facts; transient retry count/latest precision is intentionally not recoverable and lifecycle state is untouched.';
COMMENT ON FUNCTION outcome_projection.read_surface(uuid, uuid, text, text, text) IS
  'Projection-only canonical surface followed by runtime and completion-ACK operational overlays; internal integrity mode bypasses overlays.';
COMMENT ON FUNCTION project_canonical_done_gate(uuid, text, text) IS
  'Canonical projection integrity and owner-ratification gate first, then independently derived operational liveness overlays.';

COMMIT;
