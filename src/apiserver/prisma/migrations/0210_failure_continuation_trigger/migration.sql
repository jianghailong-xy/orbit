-- A failed typed EXECUTABLE attempt is an immutable fact, not a request to run the command again.
-- This migration closes the commit-to-coordinator gap with three database-owned records:
--
--   attempt termination -> immutable receipt -> canonical DIAGNOSIS obligation -> wakeup outbox
--
-- The receipt and the outbox are inserted by triggers in the SAME transaction that appends the
-- typed termination and its ACTIVE continuation.  Delivery happens later and at least once.  A
-- preallocated coordinator Session id makes the external effect recoverable on either side of a
-- worker crash, while lease generation + token fence every outbox acknowledgement.

CREATE OR REPLACE FUNCTION failure_continuation_idempotency_key(
  p_goal_id uuid,
  p_task_id uuid,
  p_binding_revision bigint,
  p_attempt_generation bigint,
  p_failure_fingerprint text
) RETURNS char(64) LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT encode(digest(concat(
    'failure-continuation:v1', E'\n',
    'goalId=', lower(p_goal_id::text), E'\n',
    'taskId=', lower(p_task_id::text), E'\n',
    'bindingRevision=', p_binding_revision::text, E'\n',
    'attemptGeneration=', p_attempt_generation::text, E'\n',
    'failureFingerprint=', lower(p_failure_fingerprint)
  ), 'sha256'), 'hex')::char(64)
$$;

CREATE TABLE failure_continuation_attempt_receipt (
  receipt_id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid        NOT NULL,
  goal_id                uuid        NOT NULL,
  task_id                uuid        NOT NULL,
  attempt_id             uuid        NOT NULL UNIQUE,
  session_id             uuid        NOT NULL,
  binding_revision       bigint      NOT NULL CHECK (binding_revision > 0),
  attempt_generation     bigint      NOT NULL CHECK (attempt_generation > 0),
  evaluation_plan_digest char(64)    NOT NULL CHECK (evaluation_plan_digest ~ '^[0-9a-f]{64}$'),
  termination_kind       executable_acceptance_termination_kind NOT NULL,
  expected_exit_code     integer     NOT NULL,
  actual_exit_code       integer,
  signal                 text,
  failure_fingerprint    char(64)    NOT NULL CHECK (failure_fingerprint ~ '^[0-9a-f]{64}$'),
  output_digest          char(64)    NOT NULL CHECK (output_digest ~ '^[0-9a-f]{64}$'),
  output_truncated       boolean     NOT NULL,
  terminated_at          timestamptz NOT NULL,
  receipt_digest         char(64)    NOT NULL UNIQUE CHECK (receipt_digest ~ '^[0-9a-f]{64}$'),
  recorded_at            timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT failure_continuation_receipt_failure_shape CHECK (
    (termination_kind = 'EXITED' AND actual_exit_code IS NOT NULL
      AND actual_exit_code <> expected_exit_code)
    OR (termination_kind <> 'EXITED' AND actual_exit_code IS NULL)
  ),
  CONSTRAINT failure_continuation_receipt_goal_fkey
    FOREIGN KEY (goal_id) REFERENCES project(id) ON DELETE CASCADE,
  CONSTRAINT failure_continuation_receipt_task_fkey
    FOREIGN KEY (task_id) REFERENCES task(id) ON DELETE CASCADE,
  CONSTRAINT failure_continuation_receipt_attempt_fkey
    FOREIGN KEY (attempt_id) REFERENCES task_executable_attempt(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX failure_continuation_receipt_identity_idx
  ON failure_continuation_attempt_receipt (
    goal_id, task_id, binding_revision, attempt_generation, failure_fingerprint
  );
CREATE INDEX failure_continuation_receipt_tenant_goal_idx
  ON failure_continuation_attempt_receipt (tenant_id, goal_id, recorded_at, receipt_id);

CREATE TABLE failure_continuation_obligation (
  obligation_id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id             uuid        NOT NULL UNIQUE,
  continuation_id        uuid        NOT NULL UNIQUE,
  tenant_id              uuid        NOT NULL,
  goal_id                uuid        NOT NULL,
  task_id                uuid        NOT NULL,
  binding_revision       bigint      NOT NULL CHECK (binding_revision > 0),
  attempt_generation     bigint      NOT NULL CHECK (attempt_generation > 0),
  failure_fingerprint    char(64)    NOT NULL CHECK (failure_fingerprint ~ '^[0-9a-f]{64}$'),
  idempotency_key        char(64)    NOT NULL UNIQUE CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  kind                   text        NOT NULL DEFAULT 'DIAGNOSIS' CHECK (kind = 'DIAGNOSIS'),
  reason_code            text        NOT NULL,
  owner                  text        NOT NULL DEFAULT 'PROJECT_COORDINATOR'
                                      CHECK (owner = 'PROJECT_COORDINATOR'),
  capability             text        NOT NULL DEFAULT 'failure-continuation.diagnose'
                                      CHECK (capability = 'failure-continuation.diagnose'),
  goal_actionable        boolean     NOT NULL DEFAULT true CHECK (goal_actionable),
  state                  text        NOT NULL DEFAULT 'ACTIVE' CHECK (state = 'ACTIVE'),
  created_at             timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT failure_continuation_obligation_receipt_fkey
    FOREIGN KEY (receipt_id) REFERENCES failure_continuation_attempt_receipt(receipt_id)
      ON DELETE CASCADE,
  CONSTRAINT failure_continuation_obligation_continuation_fkey
    FOREIGN KEY (continuation_id) REFERENCES task_executable_continuation(id)
      ON DELETE CASCADE,
  CONSTRAINT failure_continuation_obligation_goal_fkey
    FOREIGN KEY (goal_id) REFERENCES project(id) ON DELETE CASCADE,
  CONSTRAINT failure_continuation_obligation_task_fkey
    FOREIGN KEY (task_id) REFERENCES task(id) ON DELETE CASCADE
);
CREATE INDEX failure_continuation_obligation_active_idx
  ON failure_continuation_obligation (tenant_id, goal_id, task_id, created_at, obligation_id);

CREATE TABLE failure_continuation_wakeup_outbox (
  outbox_id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  obligation_id           uuid        NOT NULL UNIQUE,
  tenant_id               uuid        NOT NULL,
  goal_id                 uuid        NOT NULL,
  task_id                 uuid        NOT NULL,
  idempotency_key         char(64)    NOT NULL UNIQUE CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  planned_session_id      uuid        NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  state                   text        NOT NULL DEFAULT 'PENDING'
                                       CHECK (state IN ('PENDING', 'LEASED', 'DELIVERED', 'CANCELLED')),
  available_at            timestamptz NOT NULL DEFAULT statement_timestamp(),
  lease_owner             text,
  lease_token             uuid,
  lease_generation        bigint      NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  leased_until            timestamptz,
  delivery_attempts       integer     NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  coordinator_wake_id     uuid,
  coordinator_session_id  uuid,
  delivered_at            timestamptz,
  cancelled_at            timestamptz,
  last_error_code         text,
  created_at              timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at              timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT failure_continuation_outbox_obligation_fkey
    FOREIGN KEY (obligation_id) REFERENCES failure_continuation_obligation(obligation_id)
      ON DELETE CASCADE,
  CONSTRAINT failure_continuation_outbox_goal_fkey
    FOREIGN KEY (goal_id) REFERENCES project(id) ON DELETE CASCADE,
  CONSTRAINT failure_continuation_outbox_task_fkey
    FOREIGN KEY (task_id) REFERENCES task(id) ON DELETE CASCADE,
  -- Delivery ids are immutable snapshots, not lifecycle parents.  In particular, trashing a
  -- coordinator Session must not rewrite (or make invalid) a delivery receipt.
  CONSTRAINT failure_continuation_outbox_lease_shape CHECK (
    (state = 'LEASED' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL
      AND leased_until IS NOT NULL)
    OR (state <> 'LEASED' AND lease_owner IS NULL AND lease_token IS NULL
      AND leased_until IS NULL)
  ),
  CONSTRAINT failure_continuation_outbox_delivery_shape CHECK (
    (state = 'DELIVERED' AND delivered_at IS NOT NULL
      AND coordinator_wake_id IS NOT NULL AND coordinator_session_id IS NOT NULL)
    OR (state <> 'DELIVERED' AND delivered_at IS NULL)
  ),
  CONSTRAINT failure_continuation_outbox_cancel_shape CHECK (
    (state = 'CANCELLED' AND cancelled_at IS NOT NULL)
    OR (state <> 'CANCELLED' AND cancelled_at IS NULL)
  )
);
CREATE INDEX failure_continuation_outbox_due_idx
  ON failure_continuation_wakeup_outbox (state, available_at, leased_until, created_at, outbox_id);
CREATE INDEX failure_continuation_outbox_tenant_goal_idx
  ON failure_continuation_wakeup_outbox (tenant_id, goal_id, state, created_at, outbox_id);

CREATE TRIGGER failure_continuation_attempt_receipt_append_only
  BEFORE UPDATE OR DELETE ON failure_continuation_attempt_receipt
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER failure_continuation_obligation_append_only
  BEFORE UPDATE OR DELETE ON failure_continuation_obligation
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();

-- Snapshot one non-success typed attempt.  The executable attempt's own termination guard permits
-- exactly one NULL -> typed transition; this receipt then permits no transition at all.
CREATE OR REPLACE FUNCTION failure_continuation_record_attempt(p_attempt_id uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_attempt record;
  v_failure_fingerprint char(64);
  v_output_digest char(64);
  v_receipt_digest char(64);
  v_receipt_id uuid;
  v_standing_digest char(64);
BEGIN
  SELECT a.id, a.task_id, a.session_id, a.attempt_number,
         a.evaluation_plan_digest, a.expected_exit_code, a.terminated_at,
         a.termination_kind, a.actual_exit_code, a.signal, a.raw_output,
         a.output_truncated, a.failure_fingerprint,
         t.owner_id AS tenant_id, t.project_id AS goal_id,
         t.scope_revision::bigint AS binding_revision
    INTO v_attempt
    FROM task_executable_attempt a
    JOIN task_executable_admission admission
      ON admission.id = a.admission_id AND admission.decision = 'ADMITTED'
    JOIN task t ON t.id = a.task_id
   WHERE a.id = p_attempt_id
     AND a.legacy_termination IS NULL
     AND a.termination_kind IS NOT NULL
     AND a.terminated_at IS NOT NULL;
  IF NOT FOUND OR v_attempt.goal_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_attempt.termination_kind = 'EXITED'
     AND v_attempt.actual_exit_code = v_attempt.expected_exit_code THEN
    RETURN NULL;
  END IF;
  IF v_attempt.attempt_number < 1 THEN
    RAISE EXCEPTION 'FAILURE_CONTINUATION_ATTEMPT_GENERATION_INVALID'
      USING ERRCODE = 'check_violation';
  END IF;

  v_failure_fingerprint := COALESCE(v_attempt.failure_fingerprint, encode(digest(concat(
    'evaluationPlanDigest=', v_attempt.evaluation_plan_digest, E'\n',
    'terminationKind=', v_attempt.termination_kind::text, E'\n',
    'actualExitCode=', COALESCE(v_attempt.actual_exit_code::text, 'NULL'), E'\n',
    'signal=', COALESCE(v_attempt.signal, 'NULL')
  ), 'sha256'), 'hex'))::char(64);
  v_output_digest := encode(digest(COALESCE(v_attempt.raw_output, ''), 'sha256'), 'hex')::char(64);
  v_receipt_digest := encode(digest(concat(
    'failure-continuation-receipt:v1', E'\n',
    'tenantId=', lower(v_attempt.tenant_id::text), E'\n',
    'goalId=', lower(v_attempt.goal_id::text), E'\n',
    'taskId=', lower(v_attempt.task_id::text), E'\n',
    'attemptId=', lower(v_attempt.id::text), E'\n',
    'sessionId=', lower(v_attempt.session_id::text), E'\n',
    'bindingRevision=', v_attempt.binding_revision::text, E'\n',
    'attemptGeneration=', v_attempt.attempt_number::text, E'\n',
    'evaluationPlanDigest=', v_attempt.evaluation_plan_digest, E'\n',
    'terminationKind=', v_attempt.termination_kind::text, E'\n',
    'expectedExitCode=', v_attempt.expected_exit_code::text, E'\n',
    'actualExitCode=', COALESCE(v_attempt.actual_exit_code::text, 'NULL'), E'\n',
    'signal=', COALESCE(v_attempt.signal, 'NULL'), E'\n',
    'failureFingerprint=', v_failure_fingerprint, E'\n',
    'outputDigest=', v_output_digest, E'\n',
    'outputTruncated=', lower(v_attempt.output_truncated::text), E'\n',
    'terminatedAt=', to_char(v_attempt.terminated_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ), 'sha256'), 'hex')::char(64);

  INSERT INTO failure_continuation_attempt_receipt (
    tenant_id, goal_id, task_id, attempt_id, session_id, binding_revision,
    attempt_generation, evaluation_plan_digest, termination_kind, expected_exit_code,
    actual_exit_code, signal, failure_fingerprint, output_digest, output_truncated,
    terminated_at, receipt_digest
  ) VALUES (
    v_attempt.tenant_id, v_attempt.goal_id, v_attempt.task_id, v_attempt.id,
    v_attempt.session_id, v_attempt.binding_revision, v_attempt.attempt_number,
    v_attempt.evaluation_plan_digest, v_attempt.termination_kind,
    v_attempt.expected_exit_code, v_attempt.actual_exit_code, v_attempt.signal,
    v_failure_fingerprint, v_output_digest, v_attempt.output_truncated,
    v_attempt.terminated_at, v_receipt_digest
  ) ON CONFLICT (attempt_id) DO NOTHING
  RETURNING receipt_id INTO v_receipt_id;

  IF v_receipt_id IS NULL THEN
    SELECT receipt_id, receipt_digest INTO v_receipt_id, v_standing_digest
      FROM failure_continuation_attempt_receipt WHERE attempt_id = p_attempt_id;
    IF v_receipt_id IS NULL OR v_standing_digest <> v_receipt_digest THEN
      RAISE EXCEPTION 'FAILURE_CONTINUATION_RECEIPT_REPLAY_MISMATCH'
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;
  RETURN v_receipt_id;
END;
$$;

CREATE OR REPLACE FUNCTION failure_continuation_attempt_receipt_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM failure_continuation_record_attempt(NEW.id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER task_executable_attempt_failure_continuation_receipt
  AFTER UPDATE OF terminated_at, termination_kind, actual_exit_code, signal, raw_output,
    output_truncated, failure_fingerprint ON task_executable_attempt
  FOR EACH ROW
  WHEN (OLD.termination_kind IS NULL AND NEW.termination_kind IS NOT NULL)
  EXECUTE FUNCTION failure_continuation_attempt_receipt_trigger();

-- The continuation row supplies the routing decision; the receipt supplies the immutable failure.
-- Both inserts are idempotent, but an unequal replay is rejected instead of silently adopting it.
CREATE OR REPLACE FUNCTION failure_continuation_materialize(p_continuation_id uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_continuation record;
  v_receipt failure_continuation_attempt_receipt%ROWTYPE;
  v_obligation_id uuid;
  v_standing_key char(64);
  v_key char(64);
BEGIN
  SELECT c.id, c.attempt_id, c.task_id, c.kind::text AS kind, c.reason_code,
         c.goal_actionable, c.status
    INTO v_continuation
    FROM task_executable_continuation c
   WHERE c.id = p_continuation_id;
  IF NOT FOUND OR v_continuation.kind <> 'DIAGNOSIS'
     OR NOT v_continuation.goal_actionable OR v_continuation.status <> 'ACTIVE' THEN
    RETURN NULL;
  END IF;

  PERFORM failure_continuation_record_attempt(v_continuation.attempt_id);
  SELECT * INTO v_receipt
    FROM failure_continuation_attempt_receipt
   WHERE attempt_id = v_continuation.attempt_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_key := failure_continuation_idempotency_key(
    v_receipt.goal_id, v_receipt.task_id, v_receipt.binding_revision,
    v_receipt.attempt_generation, v_receipt.failure_fingerprint
  );
  INSERT INTO failure_continuation_obligation (
    receipt_id, continuation_id, tenant_id, goal_id, task_id, binding_revision,
    attempt_generation, failure_fingerprint, idempotency_key, reason_code
  ) VALUES (
    v_receipt.receipt_id, v_continuation.id, v_receipt.tenant_id, v_receipt.goal_id,
    v_receipt.task_id, v_receipt.binding_revision, v_receipt.attempt_generation,
    v_receipt.failure_fingerprint, v_key, v_continuation.reason_code
  ) ON CONFLICT (continuation_id) DO NOTHING
  RETURNING obligation_id INTO v_obligation_id;

  IF v_obligation_id IS NULL THEN
    SELECT obligation_id, idempotency_key INTO v_obligation_id, v_standing_key
      FROM failure_continuation_obligation
     WHERE continuation_id = p_continuation_id;
    IF v_obligation_id IS NULL OR v_standing_key <> v_key THEN
      RAISE EXCEPTION 'FAILURE_CONTINUATION_OBLIGATION_REPLAY_MISMATCH'
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;

  INSERT INTO failure_continuation_wakeup_outbox (
    obligation_id, tenant_id, goal_id, task_id, idempotency_key
  ) VALUES (
    v_obligation_id, v_receipt.tenant_id, v_receipt.goal_id, v_receipt.task_id, v_key
  ) ON CONFLICT (obligation_id) DO NOTHING;
  RETURN v_obligation_id;
END;
$$;

CREATE OR REPLACE FUNCTION failure_continuation_continuation_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM failure_continuation_materialize(NEW.id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER task_executable_continuation_failure_wakeup
  AFTER INSERT ON task_executable_continuation
  FOR EACH ROW
  WHEN (NEW.kind = 'DIAGNOSIS' AND NEW.goal_actionable AND NEW.status = 'ACTIVE')
  EXECUTE FUNCTION failure_continuation_continuation_trigger();

-- A timer may only rediscover an already-committed ACTIVE diagnosis.  It cannot invent a typed
-- failure, mutate its receipt, revive a superseded task, or use the clock as a diagnosis.
CREATE OR REPLACE FUNCTION failure_continuation_sweep(
  p_observed_at timestamptz,
  p_limit integer DEFAULT 64
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_candidate record;
  v_obligation_id uuid;
  v_scanned integer := 0;
  v_materialized integer := 0;
  v_requeued integer := 0;
BEGIN
  IF p_limit < 1 OR p_limit > 1024 THEN
    RAISE EXCEPTION 'FAILURE_CONTINUATION_SWEEP_LIMIT_INVALID'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  FOR v_candidate IN
    SELECT c.id,
           EXISTS (
             SELECT 1 FROM failure_continuation_obligation standing
              WHERE standing.continuation_id = c.id
           ) AS already_materialized
      FROM task_executable_continuation c
      JOIN task_executable_attempt a ON a.id = c.attempt_id
      JOIN task_executable_admission admission
        ON admission.id = a.admission_id AND admission.decision = 'ADMITTED'
      JOIN task t ON t.id = c.task_id
     WHERE c.kind = 'DIAGNOSIS'
       AND c.status = 'ACTIVE'
       AND c.goal_actionable = true
       AND a.termination_kind IS NOT NULL
       AND a.terminated_at IS NOT NULL
       AND (a.termination_kind <> 'EXITED' OR a.actual_exit_code <> a.expected_exit_code)
       AND t.project_id IS NOT NULL
       AND t.status NOT IN ('DONE', 'CANCELLED')
       AND t.superseded_by_task_id IS NULL
       AND NOT EXISTS (
         SELECT 1
           FROM failure_continuation_obligation stale_binding
          WHERE stale_binding.continuation_id = c.id
            AND (stale_binding.goal_id <> t.project_id
              OR stale_binding.binding_revision <> t.scope_revision::bigint)
       )
       AND NOT EXISTS (
         SELECT 1
           FROM failure_continuation_obligation obligation
           JOIN failure_continuation_wakeup_outbox wakeup
             ON wakeup.obligation_id = obligation.obligation_id
          WHERE obligation.continuation_id = c.id
            AND (
              wakeup.state = 'PENDING'
              OR (wakeup.state = 'LEASED' AND wakeup.leased_until > p_observed_at)
              OR (wakeup.state = 'DELIVERED' AND EXISTS (
                SELECT 1 FROM project_coordinator_wake delivered
                 WHERE delivered.id = wakeup.coordinator_wake_id
                   AND delivered.project_id = obligation.goal_id
                   AND delivered.event = 'FAILURE_CONTINUATION_ACTIONABLE'
                   AND delivered.subject_type = 'TASK'
                   AND delivered.subject_id = obligation.task_id::text
                   AND delivered.subject_version = obligation.idempotency_key::text
                   AND delivered.status = 'SESSION_OPENED'
                   AND delivered.session_id = wakeup.coordinator_session_id
              ))
            )
       )
     ORDER BY c.created_at, c.id
     FOR UPDATE OF c SKIP LOCKED
     LIMIT p_limit
  LOOP
    v_scanned := v_scanned + 1;
    v_obligation_id := failure_continuation_materialize(v_candidate.id);
    IF v_obligation_id IS NULL THEN
      CONTINUE;
    END IF;
    IF NOT v_candidate.already_materialized THEN
      v_materialized := v_materialized + 1;
    END IF;
    UPDATE failure_continuation_wakeup_outbox wakeup
       SET state = 'PENDING', available_at = p_observed_at,
           lease_owner = NULL, lease_token = NULL, leased_until = NULL,
           coordinator_wake_id = NULL, coordinator_session_id = NULL,
           delivered_at = NULL, cancelled_at = NULL,
           last_error_code = 'SWEEP_RECOVERED_MISSING_OR_EXPIRED_WAKEUP',
           updated_at = p_observed_at
     WHERE wakeup.obligation_id = v_obligation_id
       AND (
         (wakeup.state = 'LEASED' AND wakeup.leased_until <= p_observed_at)
         OR (wakeup.state = 'DELIVERED' AND NOT EXISTS (
           SELECT 1 FROM project_coordinator_wake delivered
            WHERE delivered.id = wakeup.coordinator_wake_id
              AND delivered.project_id = wakeup.goal_id
              AND delivered.event = 'FAILURE_CONTINUATION_ACTIONABLE'
              AND delivered.subject_type = 'TASK'
              AND delivered.subject_id = wakeup.task_id::text
              AND delivered.subject_version = wakeup.idempotency_key::text
              AND delivered.status = 'SESSION_OPENED'
              AND delivered.session_id = wakeup.coordinator_session_id
         ))
         OR wakeup.state = 'CANCELLED'
       );
    IF FOUND THEN
      v_requeued := v_requeued + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object(
    'scanned', v_scanned,
    'materialized', v_materialized,
    'requeued', v_requeued
  );
END;
$$;

-- One due row has one live lease.  An expired generation remains audit history in its counters but
-- can no longer acknowledge delivery after a new generation is claimed.
CREATE OR REPLACE FUNCTION failure_continuation_claim_wakeups(
  p_worker_id text,
  p_observed_at timestamptz,
  p_lease_seconds integer DEFAULT 30,
  p_limit integer DEFAULT 8
) RETURNS TABLE (
  outbox_id uuid,
  obligation_id uuid,
  tenant_id uuid,
  goal_id uuid,
  task_id uuid,
  continuation_id uuid,
  binding_revision bigint,
  attempt_generation bigint,
  failure_fingerprint text,
  idempotency_key text,
  planned_session_id uuid,
  lease_owner text,
  lease_token uuid,
  lease_generation bigint,
  leased_until timestamptz,
  delivery_attempts integer,
  reason_code text,
  termination_kind text,
  actual_exit_code integer,
  signal text,
  receipt_digest text
) LANGUAGE plpgsql AS $$
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' OR length(p_worker_id) > 300 THEN
    RAISE EXCEPTION 'FAILURE_CONTINUATION_WORKER_ID_INVALID'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_lease_seconds < 1 OR p_lease_seconds > 3600 OR p_limit < 1 OR p_limit > 128 THEN
    RAISE EXCEPTION 'FAILURE_CONTINUATION_CLAIM_BOUND_INVALID'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT wakeup.outbox_id
      FROM failure_continuation_wakeup_outbox wakeup
      JOIN failure_continuation_obligation obligation
        ON obligation.obligation_id = wakeup.obligation_id
      JOIN task_executable_continuation continuation
        ON continuation.id = obligation.continuation_id
      JOIN task current_task ON current_task.id = obligation.task_id
      JOIN project current_goal ON current_goal.id = obligation.goal_id
     WHERE (
         (wakeup.state = 'PENDING' AND wakeup.available_at <= p_observed_at)
         OR (wakeup.state = 'LEASED' AND wakeup.leased_until <= p_observed_at)
       )
       AND continuation.kind = 'DIAGNOSIS'
       AND continuation.status = 'ACTIVE'
       AND continuation.goal_actionable = true
       AND current_task.project_id = obligation.goal_id
       AND current_task.scope_revision::bigint = obligation.binding_revision
       AND current_task.status NOT IN ('DONE', 'CANCELLED')
       AND current_task.superseded_by_task_id IS NULL
       AND current_goal.coordinator_enabled = true
     ORDER BY wakeup.available_at, wakeup.created_at, wakeup.outbox_id
     FOR UPDATE OF wakeup SKIP LOCKED
     LIMIT p_limit
  ), claimed AS (
    UPDATE failure_continuation_wakeup_outbox wakeup
       SET state = 'LEASED', lease_owner = p_worker_id, lease_token = gen_random_uuid(),
           lease_generation = wakeup.lease_generation + 1,
           leased_until = p_observed_at + make_interval(secs => p_lease_seconds),
           delivery_attempts = wakeup.delivery_attempts + 1,
           last_error_code = NULL, updated_at = p_observed_at
      FROM candidates
     WHERE wakeup.outbox_id = candidates.outbox_id
     RETURNING wakeup.*
  )
  SELECT claimed.outbox_id, claimed.obligation_id, claimed.tenant_id, claimed.goal_id,
         claimed.task_id, obligation.continuation_id, obligation.binding_revision,
         obligation.attempt_generation, obligation.failure_fingerprint::text,
         claimed.idempotency_key::text, claimed.planned_session_id, claimed.lease_owner,
         claimed.lease_token, claimed.lease_generation, claimed.leased_until,
         claimed.delivery_attempts, obligation.reason_code,
         receipt.termination_kind::text, receipt.actual_exit_code, receipt.signal,
         receipt.receipt_digest::text
    FROM claimed
    JOIN failure_continuation_obligation obligation
      ON obligation.obligation_id = claimed.obligation_id
    JOIN failure_continuation_attempt_receipt receipt
      ON receipt.receipt_id = obligation.receipt_id
   ORDER BY claimed.created_at, claimed.outbox_id;
END;
$$;

CREATE OR REPLACE FUNCTION failure_continuation_ack_wakeup(
  p_outbox_id uuid,
  p_lease_token uuid,
  p_lease_generation bigint,
  p_wake_id uuid,
  p_session_id uuid,
  p_delivered_at timestamptz
) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  UPDATE failure_continuation_wakeup_outbox wakeup
     SET state = 'DELIVERED', lease_owner = NULL, lease_token = NULL, leased_until = NULL,
         coordinator_wake_id = p_wake_id, coordinator_session_id = p_session_id,
         delivered_at = p_delivered_at, cancelled_at = NULL, last_error_code = NULL,
         updated_at = p_delivered_at
   WHERE wakeup.outbox_id = p_outbox_id
     AND wakeup.state = 'LEASED'
     AND wakeup.lease_token = p_lease_token
     AND wakeup.lease_generation = p_lease_generation
     AND wakeup.planned_session_id = p_session_id
     AND EXISTS (
       SELECT 1 FROM project_coordinator_wake delivered
        WHERE delivered.id = p_wake_id
          AND delivered.project_id = wakeup.goal_id
          AND delivered.event = 'FAILURE_CONTINUATION_ACTIONABLE'
          AND delivered.subject_type = 'TASK'
          AND delivered.subject_id = wakeup.task_id::text
          AND delivered.subject_version = wakeup.idempotency_key::text
          AND delivered.status = 'SESSION_OPENED'
          AND delivered.session_id = p_session_id
     );
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION failure_continuation_retry_wakeup(
  p_outbox_id uuid,
  p_lease_token uuid,
  p_lease_generation bigint,
  p_available_at timestamptz,
  p_error_code text
) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  UPDATE failure_continuation_wakeup_outbox
     SET state = 'PENDING', available_at = p_available_at,
         lease_owner = NULL, lease_token = NULL, leased_until = NULL,
         last_error_code = left(COALESCE(NULLIF(btrim(p_error_code), ''), 'DELIVERY_RETRY'), 200),
         updated_at = statement_timestamp()
   WHERE outbox_id = p_outbox_id AND state = 'LEASED'
     AND lease_token = p_lease_token AND lease_generation = p_lease_generation;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION failure_continuation_cancel_wakeup(
  p_outbox_id uuid,
  p_lease_token uuid,
  p_lease_generation bigint,
  p_cancelled_at timestamptz,
  p_reason_code text
) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  UPDATE failure_continuation_wakeup_outbox
     SET state = 'CANCELLED', lease_owner = NULL, lease_token = NULL, leased_until = NULL,
         cancelled_at = p_cancelled_at,
         last_error_code = left(COALESCE(NULLIF(btrim(p_reason_code), ''),
           'OBLIGATION_NO_LONGER_CURRENT'), 200), updated_at = p_cancelled_at
   WHERE outbox_id = p_outbox_id AND state = 'LEASED'
     AND lease_token = p_lease_token AND lease_generation = p_lease_generation;
  RETURN FOUND;
END;
$$;

-- Reuse the established wake/session dedupe ledger.  Its subject version is the obligation's
-- stable key, so an outbox replay and a lease takeover necessarily target the same wake.
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
    'COMPLETION_ACK_STALE',
    'FAILURE_CONTINUATION_ACTIONABLE'
  ));
ALTER TABLE project_coordinator_wake
  ADD CONSTRAINT project_coordinator_wake_failure_continuation_subject_chk CHECK (
    "event" <> 'FAILURE_CONTINUATION_ACTIONABLE' OR "subject_type" = 'TASK'
  );

COMMENT ON TABLE failure_continuation_attempt_receipt IS
  'Append-only receipt written in the typed attempt termination transaction; never a command retry request.';
COMMENT ON TABLE failure_continuation_obligation IS
  'Immutable canonical identity of one ACTIVE goal-actionable executable DIAGNOSIS continuation.';
COMMENT ON TABLE failure_continuation_wakeup_outbox IS
  'At-least-once coordinator delivery with expiring generation/token leases and one preplanned Session id.';
COMMENT ON FUNCTION failure_continuation_sweep(timestamptz, integer) IS
  'Bounded compatibility recovery for ACTIVE goal-actionable DIAGNOSIS rows lacking a valid wake, lease or successor.';
