-- A routed Failure Continuation becomes executable work through one all-or-nothing handoff.
-- The new Task is inserted by TasksService in the surrounding transaction; this migration owns
-- the rest of the commit boundary: immutable provenance, one current lineage binding, predecessor
-- retirement, downstream dependency rebinding, continuation resolution and a durable one-shot
-- automatic-dispatch trigger.  A caller that loses its process after COMMIT can replay the same
-- obligation or leave the scheduled sweep to consume `run_at`; neither path needs process memory.

CREATE TABLE failure_successor_handoff (
  handoff_id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  obligation_id                 uuid        NOT NULL UNIQUE,
  route_decision_id             uuid        NOT NULL UNIQUE,
  source_receipt_id             uuid        NOT NULL UNIQUE,
  source_attempt_id             uuid        NOT NULL UNIQUE,
  source_continuation_id        uuid        NOT NULL UNIQUE,
  tenant_id                     uuid        NOT NULL,
  goal_id                       uuid        NOT NULL,
  lineage_root_task_id          uuid        NOT NULL,
  source_task_id                uuid        NOT NULL UNIQUE,
  successor_task_id             uuid        NOT NULL UNIQUE,
  source_binding_revision       bigint      NOT NULL CHECK (source_binding_revision > 0),
  source_attempt_generation     bigint      NOT NULL CHECK (source_attempt_generation > 0),
  binding_generation            bigint      NOT NULL CHECK (binding_generation > 0),
  failure_fingerprint           char(64)    NOT NULL CHECK (failure_fingerprint ~ '^[0-9a-f]{64}$'),
  required_capabilities         text[]      NOT NULL DEFAULT ARRAY[]::text[],
  requires_owner                boolean     NOT NULL,
  auto_dispatch_requested       boolean     NOT NULL,
  continuation_disposition      text        NOT NULL DEFAULT 'RESOLVED_TO_SUCCESSOR'
                                           CHECK (continuation_disposition = 'RESOLVED_TO_SUCCESSOR'),
  dependency_rebind_count       integer     NOT NULL CHECK (dependency_rebind_count >= 0),
  obligation_revision           char(64)    NOT NULL CHECK (obligation_revision ~ '^[0-9a-f]{64}$'),
  route_decision_digest         char(64)    NOT NULL CHECK (route_decision_digest ~ '^[0-9a-f]{64}$'),
  binding_digest                char(64)    NOT NULL UNIQUE CHECK (binding_digest ~ '^[0-9a-f]{64}$'),
  idempotency_key               char(64)    NOT NULL UNIQUE CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  committed_by_session_id       uuid        NOT NULL,
  committed_at                  timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT failure_successor_handoff_obligation_fkey
    FOREIGN KEY (obligation_id) REFERENCES failure_continuation_obligation(obligation_id)
      ON DELETE RESTRICT,
  CONSTRAINT failure_successor_handoff_route_fkey
    FOREIGN KEY (route_decision_id) REFERENCES failure_continuation_route_decision(decision_id)
      ON DELETE RESTRICT,
  CONSTRAINT failure_successor_handoff_receipt_fkey
    FOREIGN KEY (source_receipt_id) REFERENCES failure_continuation_attempt_receipt(receipt_id)
      ON DELETE RESTRICT,
  CONSTRAINT failure_successor_handoff_attempt_fkey
    FOREIGN KEY (source_attempt_id) REFERENCES task_executable_attempt(id) ON DELETE RESTRICT,
  CONSTRAINT failure_successor_handoff_continuation_fkey
    FOREIGN KEY (source_continuation_id) REFERENCES task_executable_continuation(id)
      ON DELETE RESTRICT,
  CONSTRAINT failure_successor_handoff_goal_fkey
    FOREIGN KEY (goal_id) REFERENCES project(id) ON DELETE RESTRICT,
  CONSTRAINT failure_successor_handoff_root_fkey
    FOREIGN KEY (lineage_root_task_id) REFERENCES task(id) ON DELETE RESTRICT,
  CONSTRAINT failure_successor_handoff_source_fkey
    FOREIGN KEY (source_task_id) REFERENCES task(id) ON DELETE RESTRICT,
  CONSTRAINT failure_successor_handoff_successor_fkey
    FOREIGN KEY (successor_task_id) REFERENCES task(id) ON DELETE RESTRICT,
  CONSTRAINT failure_successor_handoff_distinct_tasks
    CHECK (source_task_id <> successor_task_id),
  CONSTRAINT failure_successor_handoff_generation_key
    UNIQUE (lineage_root_task_id, binding_generation)
);

CREATE INDEX failure_successor_handoff_goal_idx
  ON failure_successor_handoff (tenant_id, goal_id, committed_at, handoff_id);
CREATE INDEX failure_successor_handoff_lineage_idx
  ON failure_successor_handoff (lineage_root_task_id, binding_generation DESC);

-- The only mutable projection: one row says which immutable handoff currently owns a lineage.
-- Updating it and appending the next handoff happen in the same transaction and under the source
-- task lock, so no reader can observe two current generations or a generation with no Task.
CREATE TABLE failure_successor_current_binding (
  lineage_root_task_id      uuid        PRIMARY KEY,
  tenant_id                 uuid        NOT NULL,
  goal_id                   uuid        NOT NULL,
  handoff_id                uuid        NOT NULL UNIQUE,
  current_successor_task_id uuid        NOT NULL UNIQUE,
  binding_generation        bigint      NOT NULL CHECK (binding_generation > 0),
  binding_digest            char(64)    NOT NULL CHECK (binding_digest ~ '^[0-9a-f]{64}$'),
  updated_at                timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT failure_successor_current_root_fkey
    FOREIGN KEY (lineage_root_task_id) REFERENCES task(id) ON DELETE RESTRICT,
  CONSTRAINT failure_successor_current_goal_fkey
    FOREIGN KEY (goal_id) REFERENCES project(id) ON DELETE RESTRICT,
  CONSTRAINT failure_successor_current_handoff_fkey
    FOREIGN KEY (handoff_id) REFERENCES failure_successor_handoff(handoff_id) ON DELETE RESTRICT,
  CONSTRAINT failure_successor_current_task_fkey
    FOREIGN KEY (current_successor_task_id) REFERENCES task(id) ON DELETE RESTRICT
);

-- Append-only receipt for every physical edge changed by a handoff. `edge_id` deliberately has no
-- FK: a later legitimate edge delete must not erase (or be blocked by) the proof of what moved.
CREATE TABLE failure_successor_dependency_rebind (
  rebind_id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  handoff_id             uuid        NOT NULL,
  edge_id                uuid        NOT NULL,
  dependent_task_id      uuid        NOT NULL,
  source_task_id         uuid        NOT NULL,
  successor_task_id      uuid        NOT NULL,
  binding_generation     bigint      NOT NULL CHECK (binding_generation > 0),
  action                 text        NOT NULL CHECK (action IN ('MOVED', 'DEDUPLICATED')),
  replacement_edge_id    uuid,
  recorded_at            timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT failure_successor_rebind_handoff_fkey
    FOREIGN KEY (handoff_id) REFERENCES failure_successor_handoff(handoff_id) ON DELETE RESTRICT,
  CONSTRAINT failure_successor_rebind_once UNIQUE (handoff_id, edge_id)
);
CREATE INDEX failure_successor_rebind_dependent_idx
  ON failure_successor_dependency_rebind (dependent_task_id, binding_generation, rebind_id);

CREATE TRIGGER failure_successor_handoff_append_only
  BEFORE UPDATE OR DELETE ON failure_successor_handoff
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER failure_successor_dependency_rebind_append_only
  BEFORE UPDATE OR DELETE ON failure_successor_dependency_rebind
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();

CREATE OR REPLACE FUNCTION failure_successor_current_binding_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_handoff failure_successor_handoff%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'FAILURE_SUCCESSOR_CURRENT_BINDING_DELETE_FORBIDDEN'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_handoff FROM failure_successor_handoff
   WHERE handoff_id = NEW.handoff_id;
  IF NOT FOUND
     OR v_handoff.lineage_root_task_id <> NEW.lineage_root_task_id
     OR v_handoff.tenant_id <> NEW.tenant_id
     OR v_handoff.goal_id <> NEW.goal_id
     OR v_handoff.successor_task_id <> NEW.current_successor_task_id
     OR v_handoff.binding_generation <> NEW.binding_generation
     OR v_handoff.binding_digest <> NEW.binding_digest
     OR NOT EXISTS (
       SELECT 1 FROM task source
        WHERE source.id = v_handoff.source_task_id
          AND source.status = 'FAILED'::task_status
          AND source.superseded_by_task_id = v_handoff.successor_task_id
          AND source.terminal_reason = 'SUPERSEDED'
     ) THEN
    RAISE EXCEPTION 'FAILURE_SUCCESSOR_CURRENT_BINDING_HANDOFF_MISMATCH'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND (
       NEW.binding_generation <> 1
       OR v_handoff.source_task_id <> NEW.lineage_root_task_id
     ) THEN
    RAISE EXCEPTION 'FAILURE_SUCCESSOR_CURRENT_BINDING_INITIAL_INVALID'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (
       NEW.lineage_root_task_id <> OLD.lineage_root_task_id
       OR NEW.tenant_id <> OLD.tenant_id OR NEW.goal_id <> OLD.goal_id
       OR NEW.binding_generation <> OLD.binding_generation + 1
       OR NEW.current_successor_task_id = OLD.current_successor_task_id
       OR NEW.handoff_id = OLD.handoff_id OR NEW.binding_digest = OLD.binding_digest
       OR v_handoff.source_task_id <> OLD.current_successor_task_id
     ) THEN
    RAISE EXCEPTION 'FAILURE_SUCCESSOR_CURRENT_BINDING_NON_MONOTONIC'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER failure_successor_current_binding_monotonic
  BEFORE INSERT OR UPDATE OR DELETE ON failure_successor_current_binding
  FOR EACH ROW EXECUTE FUNCTION failure_successor_current_binding_guard();

-- Once a Task is the source of an immutable handoff, its FAILED result and exact successor link
-- are evidence, not an editable workflow hint. While it is merely the current successor, an
-- ordinary supersession write is refused; the next failure handoff is allowed because it appends
-- its exact immutable receipt before applying this Task update in the same transaction.
CREATE OR REPLACE FUNCTION failure_successor_task_binding_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_handoff failure_successor_handoff%ROWTYPE;
BEGIN
  SELECT * INTO v_handoff FROM failure_successor_handoff
   WHERE source_task_id = OLD.id;
  IF FOUND THEN
    IF NEW.status <> 'FAILED'::task_status
       OR NEW.superseded_by_task_id IS DISTINCT FROM v_handoff.successor_task_id
       OR NEW.superseded_at IS DISTINCT FROM v_handoff.committed_at
       OR NEW.terminal_reason IS DISTINCT FROM 'SUPERSEDED' THEN
      RAISE EXCEPTION 'FAILURE_SUCCESSOR_SOURCE_BINDING_IMMUTABLE:%', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (
       NEW.superseded_by_task_id IS DISTINCT FROM OLD.superseded_by_task_id
       OR NEW.superseded_at IS DISTINCT FROM OLD.superseded_at
       OR NEW.terminal_reason IS DISTINCT FROM OLD.terminal_reason
     ) AND EXISTS (
       SELECT 1 FROM failure_successor_current_binding current_binding
        WHERE current_binding.current_successor_task_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'FAILURE_SUCCESSOR_CURRENT_TASK_REQUIRES_HANDOFF:%', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER failure_successor_task_binding_immutable
  BEFORE UPDATE OF status, superseded_by_task_id, superseded_at, terminal_reason ON task
  FOR EACH ROW EXECUTE FUNCTION failure_successor_task_binding_guard();

CREATE OR REPLACE FUNCTION failure_successor_handoff_read(p_obligation_id uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'handoffId', handoff.handoff_id::text,
    'obligationId', handoff.obligation_id::text,
    'routeDecisionId', handoff.route_decision_id::text,
    'sourceReceiptId', handoff.source_receipt_id::text,
    'sourceAttemptId', handoff.source_attempt_id::text,
    'sourceContinuationId', handoff.source_continuation_id::text,
    'tenantId', handoff.tenant_id::text,
    'goalId', handoff.goal_id::text,
    'lineageRootTaskId', handoff.lineage_root_task_id::text,
    'sourceTaskId', handoff.source_task_id::text,
    'successorTaskId', handoff.successor_task_id::text,
    'sourceBindingRevision', handoff.source_binding_revision::text,
    'sourceAttemptGeneration', handoff.source_attempt_generation::text,
    'bindingGeneration', handoff.binding_generation::text,
    'failureFingerprint', handoff.failure_fingerprint::text,
    'requiredCapabilities', to_jsonb(handoff.required_capabilities),
    'requiresOwner', handoff.requires_owner,
    'autoDispatchRequested', handoff.auto_dispatch_requested,
    'continuationDisposition', handoff.continuation_disposition,
    'dependencyRebindCount', handoff.dependency_rebind_count,
    'obligationRevision', handoff.obligation_revision::text,
    'routeDecisionDigest', handoff.route_decision_digest::text,
    'bindingDigest', handoff.binding_digest::text,
    'idempotencyKey', handoff.idempotency_key::text,
    'committedBySessionId', handoff.committed_by_session_id::text,
    'committedAt', to_jsonb(handoff.committed_at),
    'current', current_binding.handoff_id = handoff.handoff_id
  )
    FROM failure_successor_handoff handoff
    LEFT JOIN failure_successor_current_binding current_binding
      ON current_binding.lineage_root_task_id = handoff.lineage_root_task_id
   WHERE handoff.obligation_id = p_obligation_id
$$;

-- Commit one coordinator decision. The successor Task must have been inserted earlier in this
-- same transaction. An already-committed equal request returns byte-identical provenance only when
-- it names the same Task; a different candidate raises a typed winner marker so its surrounding
-- task INSERT is rolled back and the caller can adopt the committed current successor.
CREATE OR REPLACE FUNCTION failure_successor_handoff_commit(
  p_obligation_id uuid,
  p_obligation_revision text,
  p_route_decision_id uuid,
  p_route_decision_digest text,
  p_source_task_id uuid,
  p_successor_task_id uuid,
  p_coordinator_session_id uuid,
  p_observed_at timestamptz DEFAULT statement_timestamp()
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_context record;
  v_source task%ROWTYPE;
  v_successor task%ROWTYPE;
  v_existing failure_successor_handoff%ROWTYPE;
  v_previous failure_successor_current_binding%ROWTYPE;
  v_root_task_id uuid;
  v_generation bigint;
  v_handoff_id uuid := gen_random_uuid();
  v_required_capability text;
  v_required_capabilities text[] := ARRAY[]::text[];
  v_requires_owner boolean;
  v_capability_available boolean;
  v_auto_dispatch boolean;
  v_rebind_count integer;
  v_binding_digest char(64);
  v_idempotency_key char(64);
  v_edge record;
  v_replacement_edge_id uuid;
  v_cycle boolean;
BEGIN
  IF p_obligation_revision !~ '^[0-9a-f]{64}$'
     OR p_route_decision_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'FAILURE_SUCCESSOR_HANDOFF_DIGEST_INVALID'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_observed_at IS NULL OR p_coordinator_session_id IS NULL THEN
    RAISE EXCEPTION 'FAILURE_SUCCESSOR_HANDOFF_CONTEXT_REQUIRED'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_existing FROM failure_successor_handoff
   WHERE obligation_id = p_obligation_id;
  IF FOUND THEN
    IF v_existing.obligation_revision::text <> p_obligation_revision
       OR v_existing.route_decision_id <> p_route_decision_id
       OR v_existing.route_decision_digest::text <> p_route_decision_digest THEN
      RAISE EXCEPTION 'FAILURE_SUCCESSOR_HANDOFF_REPLAY_MISMATCH'
        USING ERRCODE = 'unique_violation';
    END IF;
    IF v_existing.successor_task_id <> p_successor_task_id THEN
      RAISE EXCEPTION 'FAILURE_SUCCESSOR_ALREADY_CURRENT:%', v_existing.successor_task_id
        USING ERRCODE = 'unique_violation';
    END IF;
    RETURN failure_successor_handoff_read(p_obligation_id)
      || jsonb_build_object('replayed', true);
  END IF;

  SELECT obligation.obligation_id, obligation.idempotency_key,
         obligation.receipt_id, obligation.continuation_id, obligation.tenant_id,
         obligation.goal_id, obligation.task_id, obligation.binding_revision,
         obligation.attempt_generation, obligation.failure_fingerprint,
         receipt.attempt_id, route.decision_id, route.decision_digest,
         route.failure_domain, route.canonical_reason, route.next_action,
         route.binding_digest AS route_binding_digest,
         continuation.status AS continuation_status,
         wakeup.state AS wakeup_state,
         wakeup.coordinator_session_id,
         coordinator_wake.status AS coordinator_wake_status,
         coordinator_wake.session_id AS wake_session_id
    INTO v_context
    FROM failure_continuation_obligation obligation
    JOIN failure_continuation_attempt_receipt receipt
      ON receipt.receipt_id = obligation.receipt_id
    JOIN failure_continuation_route_decision route
      ON route.obligation_id = obligation.obligation_id
    JOIN task_executable_continuation continuation
      ON continuation.id = obligation.continuation_id
    JOIN failure_continuation_wakeup_outbox wakeup
      ON wakeup.obligation_id = obligation.obligation_id
    LEFT JOIN project_coordinator_wake coordinator_wake
      ON coordinator_wake.id = wakeup.coordinator_wake_id
   WHERE obligation.obligation_id = p_obligation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAILURE_SUCCESSOR_HANDOFF_OBLIGATION_NOT_FOUND'
      USING ERRCODE = 'no_data_found';
  END IF;
  IF v_context.idempotency_key::text <> p_obligation_revision
     OR v_context.decision_id <> p_route_decision_id
     OR v_context.decision_digest::text <> p_route_decision_digest THEN
    RAISE EXCEPTION 'FAILURE_SUCCESSOR_HANDOFF_BINDING_STALE'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_context.task_id <> p_source_task_id THEN
    RAISE EXCEPTION 'FAILURE_SUCCESSOR_HANDOFF_SOURCE_MISMATCH'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_context.continuation_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'FAILURE_SUCCESSOR_HANDOFF_CONTINUATION_NOT_ACTIVE'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_context.wakeup_state <> 'DELIVERED'
     OR v_context.coordinator_session_id IS DISTINCT FROM p_coordinator_session_id
     OR v_context.wake_session_id IS DISTINCT FROM p_coordinator_session_id
     OR v_context.coordinator_wake_status <> 'SESSION_OPENED' THEN
    RAISE EXCEPTION 'FAILURE_SUCCESSOR_HANDOFF_COORDINATOR_SESSION_NOT_CURRENT'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The source row is the serialization point shared with every ordinary supersession writer.
  -- Re-read the winner after taking it: a concurrent coordinator may have committed while this
  -- statement waited, and the loser must roll back its just-created candidate rather than strand it.
  -- TasksService already owns this exact row through the ordinary supersession NOWAIT fence and
  -- has proved that no live work Session holds it. Re-locking is consequently non-blocking while
  -- keeping this function safe for another transaction-aware caller. The explicit source input is
  -- a comparison value: a mixed request cannot make the function lock some obligation-derived row
  -- other than the one its surrounding transaction fenced.
  SELECT * INTO v_source FROM task WHERE id = p_source_task_id FOR UPDATE;
  SELECT * INTO v_existing FROM failure_successor_handoff
   WHERE obligation_id = p_obligation_id;
  IF FOUND THEN
    IF v_existing.obligation_revision::text <> p_obligation_revision
       OR v_existing.route_decision_id <> p_route_decision_id
       OR v_existing.route_decision_digest::text <> p_route_decision_digest THEN
      RAISE EXCEPTION 'FAILURE_SUCCESSOR_HANDOFF_REPLAY_MISMATCH'
        USING ERRCODE = 'unique_violation';
    END IF;
    IF v_existing.successor_task_id <> p_successor_task_id THEN
      RAISE EXCEPTION 'FAILURE_SUCCESSOR_ALREADY_CURRENT:%', v_existing.successor_task_id
        USING ERRCODE = 'unique_violation';
    END IF;
    RETURN failure_successor_handoff_read(p_obligation_id)
      || jsonb_build_object('replayed', true);
  END IF;
  -- `FOUND` now describes the handoff re-read above, not the source SELECT. Test the row itself so
  -- a missing source is rejected without making every legitimate first handoff look missing.
  IF v_source.id IS NULL OR v_source.owner_id <> v_context.tenant_id
     OR v_source.project_id IS DISTINCT FROM v_context.goal_id
     OR v_source.scope_revision::bigint <> v_context.binding_revision
     OR v_source.status <> 'FAILED'::task_status THEN
    RAISE EXCEPTION 'FAILURE_SUCCESSOR_HANDOFF_SOURCE_NOT_CURRENT_FAILED_BINDING'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_source.superseded_by_task_id IS NOT NULL OR v_source.terminal_reason IS NOT NULL THEN
    RAISE EXCEPTION 'FAILURE_SUCCESSOR_HANDOFF_SOURCE_ALREADY_RETIRED'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_successor FROM task WHERE id = p_successor_task_id FOR UPDATE;
  IF NOT FOUND OR v_successor.id = v_source.id
     OR v_successor.owner_id <> v_context.tenant_id
     OR v_successor.project_id IS DISTINCT FROM v_context.goal_id
     OR v_successor.creator_session_id IS DISTINCT FROM p_coordinator_session_id
     OR v_successor.source_session_id IS DISTINCT FROM p_coordinator_session_id
     OR v_successor.status <> 'OPEN'::task_status
     OR v_successor.superseded_by_task_id IS NOT NULL OR v_successor.terminal_reason IS NOT NULL
     OR EXISTS (SELECT 1 FROM session s WHERE s.task_id = v_successor.id
                 AND s.starts_task_work AND s.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'FAILURE_SUCCESSOR_HANDOFF_SUCCESSOR_INVALID'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM task_dependency d
              WHERE d.task_id = v_successor.id AND d.depends_on_task_id = v_source.id) THEN
    RAISE EXCEPTION 'FAILURE_SUCCESSOR_HANDOFF_SUCCESSOR_DEPENDS_ON_SOURCE'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT current_binding.* INTO v_previous
    FROM failure_successor_current_binding current_binding
   WHERE current_binding.current_successor_task_id = v_source.id
   FOR UPDATE;
  IF FOUND THEN
    v_root_task_id := v_previous.lineage_root_task_id;
    v_generation := v_previous.binding_generation + 1;
  ELSE
    IF EXISTS (
      SELECT 1 FROM failure_successor_handoff member
       WHERE member.source_task_id = v_source.id OR member.successor_task_id = v_source.id
    ) THEN
      RAISE EXCEPTION 'FAILURE_SUCCESSOR_HANDOFF_SOURCE_NOT_CURRENT_SUCCESSOR'
        USING ERRCODE = 'check_violation';
    END IF;
    v_root_task_id := v_source.id;
    v_generation := 1;
  END IF;

  v_required_capability := NULLIF(btrim(v_context.canonical_reason->>'requiredCapability'), '');
  IF v_required_capability IS NOT NULL THEN
    v_required_capabilities := ARRAY[v_required_capability];
  END IF;
  v_requires_owner := v_context.failure_domain = 'OWNER_REQUIRED'
    OR COALESCE((v_context.next_action->>'requiresOwnerDecision')::boolean, false);
  v_capability_available := COALESCE(
    (v_context.canonical_reason->>'capabilityAvailable')::boolean,
    v_required_capability IS NULL
  );
  v_auto_dispatch := NOT v_requires_owner AND v_capability_available;
  SELECT count(*)::integer INTO v_rebind_count
    FROM task_dependency d WHERE d.depends_on_task_id = v_source.id
      AND d.task_id <> v_successor.id;
  v_binding_digest := outcome_sha256_json(jsonb_build_object(
    'namespace', 'orbit.failure-successor-binding.v1',
    'tenantId', v_context.tenant_id::text,
    'goalId', v_context.goal_id::text,
    'lineageRootTaskId', v_root_task_id::text,
    'sourceTaskId', v_source.id::text,
    'successorTaskId', v_successor.id::text,
    'sourceAttemptId', v_context.attempt_id::text,
    'sourceContinuationId', v_context.continuation_id::text,
    'failureFingerprint', v_context.failure_fingerprint::text,
    'sourceBindingRevision', v_context.binding_revision::text,
    'bindingGeneration', v_generation::text,
    'routeBindingDigest', v_context.route_binding_digest::text,
    'requiresOwner', v_requires_owner,
    'autoDispatchRequested', v_auto_dispatch,
    'requiredCapabilities', to_jsonb(v_required_capabilities)
  ));
  v_idempotency_key := outcome_sha256_json(jsonb_build_object(
    'namespace', 'orbit.failure-successor-handoff.v1',
    'obligationId', p_obligation_id::text,
    'obligationRevision', p_obligation_revision,
    'routeDecisionDigest', p_route_decision_digest
  ));

  -- Append the immutable authority first inside this transaction. The Task binding guard below
  -- recognises only the exact successor and committed timestamp on this receipt, so an ordinary
  -- task_update cannot create, clear or redirect a managed supersession. No other transaction can
  -- observe the receipt until every mutation here commits.
  INSERT INTO failure_successor_handoff (
    handoff_id, obligation_id, route_decision_id, source_receipt_id,
    source_attempt_id, source_continuation_id, tenant_id, goal_id,
    lineage_root_task_id, source_task_id, successor_task_id,
    source_binding_revision, source_attempt_generation, binding_generation,
    failure_fingerprint, required_capabilities, requires_owner,
    auto_dispatch_requested, dependency_rebind_count, obligation_revision,
    route_decision_digest, binding_digest, idempotency_key,
    committed_by_session_id, committed_at
  ) VALUES (
    v_handoff_id, p_obligation_id, p_route_decision_id, v_context.receipt_id,
    v_context.attempt_id, v_context.continuation_id, v_context.tenant_id,
    v_context.goal_id, v_root_task_id, v_source.id, v_successor.id,
    v_context.binding_revision, v_context.attempt_generation, v_generation,
    v_context.failure_fingerprint, v_required_capabilities, v_requires_owner,
    v_auto_dispatch, v_rebind_count, p_obligation_revision,
    p_route_decision_digest, v_binding_digest, v_idempotency_key,
    p_coordinator_session_id, p_observed_at
  );

  -- Preserve status=FAILED. Only the structured replacement relation is added.
  UPDATE task
     SET superseded_by_task_id = v_successor.id,
         superseded_at = p_observed_at,
         terminal_reason = 'SUPERSEDED'
   WHERE id = v_source.id AND status = 'FAILED'::task_status
     AND superseded_by_task_id IS NULL AND terminal_reason IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAILURE_SUCCESSOR_HANDOFF_SOURCE_CAS_LOST'
      USING ERRCODE = 'serialization_failure';
  END IF;

  IF v_previous.lineage_root_task_id IS NULL THEN
    INSERT INTO failure_successor_current_binding (
      lineage_root_task_id, tenant_id, goal_id, handoff_id,
      current_successor_task_id, binding_generation, binding_digest, updated_at
    ) VALUES (
      v_root_task_id, v_context.tenant_id, v_context.goal_id, v_handoff_id,
      v_successor.id, v_generation, v_binding_digest, p_observed_at
    );
  ELSE
    UPDATE failure_successor_current_binding
       SET handoff_id = v_handoff_id,
           current_successor_task_id = v_successor.id,
           binding_generation = v_generation,
           binding_digest = v_binding_digest,
           updated_at = p_observed_at
     WHERE lineage_root_task_id = v_root_task_id
       AND handoff_id = v_previous.handoff_id
       AND current_successor_task_id = v_source.id
       AND binding_generation = v_previous.binding_generation;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'FAILURE_SUCCESSOR_CURRENT_BINDING_CAS_LOST'
        USING ERRCODE = 'serialization_failure';
    END IF;
  END IF;

  -- Re-point every physical downstream edge. A pre-existing direct edge to the successor is kept
  -- and the stale source edge is deleted; otherwise the existing edge id moves. Before either,
  -- prove the new edge cannot close a dependency cycle through the successor's own prerequisites.
  FOR v_edge IN
    SELECT d.id, d.task_id FROM task_dependency d
     WHERE d.depends_on_task_id = v_source.id AND d.task_id <> v_successor.id
     ORDER BY d.task_id, d.id
  LOOP
    WITH RECURSIVE upstream(id) AS (
      SELECT d.depends_on_task_id FROM task_dependency d
       WHERE d.task_id = v_successor.id
      UNION
      SELECT d.depends_on_task_id FROM task_dependency d JOIN upstream u ON d.task_id = u.id
    )
    SELECT EXISTS (SELECT 1 FROM upstream WHERE id = v_edge.task_id) INTO v_cycle;
    IF v_cycle THEN
      RAISE EXCEPTION 'FAILURE_SUCCESSOR_HANDOFF_DEPENDENCY_CYCLE:%', v_edge.task_id
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT d.id INTO v_replacement_edge_id FROM task_dependency d
     WHERE d.task_id = v_edge.task_id AND d.depends_on_task_id = v_successor.id;
    INSERT INTO failure_successor_dependency_rebind (
      handoff_id, edge_id, dependent_task_id, source_task_id,
      successor_task_id, binding_generation, action, replacement_edge_id, recorded_at
    ) VALUES (
      v_handoff_id, v_edge.id, v_edge.task_id, v_source.id, v_successor.id,
      v_generation, CASE WHEN v_replacement_edge_id IS NULL THEN 'MOVED'
                         ELSE 'DEDUPLICATED' END,
      v_replacement_edge_id, p_observed_at
    );
    IF v_replacement_edge_id IS NULL THEN
      UPDATE task_dependency SET depends_on_task_id = v_successor.id WHERE id = v_edge.id;
    ELSE
      DELETE FROM task_dependency WHERE id = v_edge.id;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM task_dependency d WHERE d.depends_on_task_id = v_source.id) THEN
    RAISE EXCEPTION 'FAILURE_SUCCESSOR_HANDOFF_STALE_EDGE_REMAINS'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE task_executable_continuation
     SET status = 'RESOLVED', resolved_at = p_observed_at
   WHERE id = v_context.continuation_id AND status = 'ACTIVE';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAILURE_SUCCESSOR_HANDOFF_CONTINUATION_CAS_LOST'
      USING ERRCODE = 'serialization_failure';
  END IF;

  -- `run_at` is the durable dispatch fact. The immediate post-commit nudge and the periodic
  -- scheduled sweep derive the same request token from its dispatch epoch. Owner-required work is
  -- held even from Run Now; it cannot be started until an explicit future protocol releases it.
  UPDATE task
     SET required_capabilities = ARRAY(
           SELECT DISTINCT capability FROM unnest(
             COALESCE(required_capabilities, ARRAY[]::text[]) || v_required_capabilities
           ) capability WHERE btrim(capability) <> '' ORDER BY capability
         ),
         auto_run_when_ready = v_auto_dispatch,
         run_at = CASE WHEN v_auto_dispatch THEN p_observed_at ELSE NULL END,
         dispatch_hold = dispatch_hold OR v_requires_owner
   WHERE id = v_successor.id;

  RETURN failure_successor_handoff_read(p_obligation_id)
    || jsonb_build_object('replayed', false);
END;
$$;

-- The existing global resolver remains the one predicate used by Ready, Run Now, instant trigger,
-- both sweeps and the deferred Session commit gate. The additional check binds every member of a
-- managed lineage to its one current pointer; a mismatched or missing chain fails closed.
CREATE OR REPLACE FUNCTION task_dependency_tail_id(p_task_id uuid)
RETURNS uuid LANGUAGE plpgsql STABLE AS $$
DECLARE cursor_id uuid := p_task_id; next_id uuid; root_owner uuid; current_owner uuid;
        current_status text; current_reason text; bound_successor uuid;
        seen uuid[] := ARRAY[]::uuid[]; depth integer := 0;
BEGIN
  SELECT t.owner_id INTO root_owner FROM task t WHERE t.id = p_task_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  LOOP
    IF cursor_id = ANY(seen) OR depth > 256 THEN RETURN NULL; END IF;
    seen := array_append(seen, cursor_id);
    SELECT t.owner_id, t.superseded_by_task_id, t.status::text, t.terminal_reason
      INTO current_owner, next_id, current_status, current_reason
      FROM task t WHERE t.id = cursor_id;
    IF NOT FOUND OR current_owner <> root_owner THEN RETURN NULL; END IF;
    IF next_id IS NULL THEN
      IF current_reason = 'SUPERSEDED' THEN RETURN NULL; END IF;
      EXIT;
    END IF;
    IF current_status NOT IN ('FAILED', 'CANCELLED')
       OR current_reason IS DISTINCT FROM 'SUPERSEDED' THEN RETURN NULL; END IF;
    cursor_id := next_id;
    depth := depth + 1;
  END LOOP;

  SELECT current_binding.current_successor_task_id INTO bound_successor
    FROM failure_successor_handoff member
    JOIN failure_successor_current_binding current_binding
      ON current_binding.lineage_root_task_id = member.lineage_root_task_id
   WHERE member.source_task_id = p_task_id OR member.successor_task_id = p_task_id
   ORDER BY member.binding_generation DESC LIMIT 1;
  IF FOUND AND bound_successor <> cursor_id THEN RETURN NULL; END IF;
  RETURN cursor_id;
END;
$$;

-- The Session insert is the final automatic-execution authority gate. Keep ordinary project work
-- on owner ratification, but recognise the narrower authority this migration just committed: the
-- exact current successor whose immutable route proved both `requires_owner = false` and required
-- capability availability. A stale generation, old successor or owner route cannot match.
CREATE OR REPLACE FUNCTION session_owner_ratification_guard() RETURNS TRIGGER AS $$
DECLARE
  project_value UUID;
  contract_value TEXT;
BEGIN
  IF NEW."task_id" IS NULL OR NEW."dispatch_origin" = 'USER'::"session_dispatch_origin" THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM failure_successor_current_binding current_binding
      JOIN failure_successor_handoff handoff
        ON handoff.handoff_id = current_binding.handoff_id
     WHERE current_binding.current_successor_task_id = NEW."task_id"
       AND handoff.successor_task_id = NEW."task_id"
       AND handoff.auto_dispatch_requested = true
       AND handoff.requires_owner = false
  ) THEN
    RETURN NEW;
  END IF;
  SELECT p."id" INTO project_value
    FROM "task" t
    JOIN "project" p ON p."id" = t."project_id"
   WHERE t."id" = NEW."task_id"
   FOR NO KEY UPDATE OF p;
  IF project_value IS NULL THEN RETURN NEW; END IF;
  SELECT c."contract_digest" INTO contract_value FROM "project_completion_contract" c
   WHERE c."project_id" = project_value;
  IF contract_value IS NULL
     OR NOT project_owner_ratification_effective(project_value, contract_value) THEN
    RAISE EXCEPTION
      'OWNER_RATIFICATION_REQUIRED: automatic execution for project % has no effective ratification',
      project_value USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE VIEW failure_successor_current AS
SELECT current_binding.lineage_root_task_id, current_binding.tenant_id,
       current_binding.goal_id, current_binding.handoff_id,
       current_binding.current_successor_task_id, current_binding.binding_generation,
       current_binding.binding_digest, handoff.source_task_id,
       handoff.source_attempt_id, handoff.source_continuation_id,
       handoff.failure_fingerprint, handoff.requires_owner,
       handoff.auto_dispatch_requested, handoff.required_capabilities,
       handoff.committed_at, current_binding.updated_at
  FROM failure_successor_current_binding current_binding
  JOIN failure_successor_handoff handoff ON handoff.handoff_id = current_binding.handoff_id;

COMMENT ON TABLE failure_successor_handoff IS
  'Immutable atomic takeover receipt: exact failure attempt/continuation/fingerprint to one successor and binding generation.';
COMMENT ON TABLE failure_successor_current_binding IS
  'One monotone current successor pointer per failure lineage; the unique row is the current binding authority.';
COMMENT ON TABLE failure_successor_dependency_rebind IS
  'Append-only proof of each downstream dependency edge moved or deduplicated in the handoff transaction.';
COMMENT ON FUNCTION failure_successor_handoff_commit(
  uuid, text, uuid, text, uuid, uuid, uuid, timestamptz
) IS
  'Atomically retire one FAILED attempt, bind one current successor, rebind all downstream edges, resolve its continuation and arm durable auto-dispatch when authorised.';
COMMENT ON FUNCTION session_owner_ratification_guard() IS
  'Final automatic Session gate: owner ratification for ordinary work, or the immutable no-owner/capable authority of the exact current failure successor.';
COMMENT ON VIEW failure_successor_current IS
  'Canonical current-successor projection with source attempt, continuation, fingerprint and binding generation.';
