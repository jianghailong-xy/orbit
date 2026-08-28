-- Completion ACK persistent coordinator integration.
--
-- 0201 owns the canonical lifecycle.  This migration does not create another writable
-- obligation state machine: it adapts the exact immutable 0201 identity into the existing 0198
-- coordinator, and 0198 may resolve it only after the matching 0201 revision has a canonical
-- CLOSED event.  Delivery plans, receipts and remediation actions are append-only effect evidence.
BEGIN;

-- 0198 used closed-set CHECKs.  PROJECT_COORDINATOR is a product-facing requested owner; the
-- durable scheduler owner remains AGENT.
ALTER TABLE outcome_coordinator_obligation_revision
  DROP CONSTRAINT outcome_coordinator_obligation_revision_source_type_check;
ALTER TABLE outcome_coordinator_obligation_revision
  ADD CONSTRAINT outcome_coordinator_obligation_revision_source_type_check
  CHECK (source_type IN ('CANONICAL', 'EXECUTOR', 'COMPLETION_ACK'));
ALTER TABLE outcome_coordinator_obligation_revision
  DROP CONSTRAINT outcome_coordinator_obligation_revision_requested_owner_check;
ALTER TABLE outcome_coordinator_obligation_revision
  ADD CONSTRAINT outcome_coordinator_obligation_revision_requested_owner_check
  CHECK (requested_owner IN ('SYSTEM', 'AGENT', 'OWNER', 'EXTERNAL', 'PROJECT_COORDINATOR'));

ALTER TABLE outcome_coordinator_obligation
  DROP CONSTRAINT outcome_coordinator_obligation_source_type_check;
ALTER TABLE outcome_coordinator_obligation
  ADD CONSTRAINT outcome_coordinator_obligation_source_type_check
  CHECK (source_type IN ('CANONICAL', 'EXECUTOR', 'COMPLETION_ACK'));
ALTER TABLE outcome_coordinator_obligation
  DROP CONSTRAINT outcome_coordinator_obligation_requested_owner_check;
ALTER TABLE outcome_coordinator_obligation
  ADD CONSTRAINT outcome_coordinator_obligation_requested_owner_check
  CHECK (requested_owner IN ('SYSTEM', 'AGENT', 'OWNER', 'EXTERNAL', 'PROJECT_COORDINATOR'));

CREATE OR REPLACE FUNCTION completion_ack_uuid_from_digest(p_digest text)
RETURNS uuid LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT (
    substr(p_digest, 1, 8) || '-' || substr(p_digest, 9, 4) || '-5' ||
    substr(p_digest, 14, 3) || '-a' || substr(p_digest, 18, 3) || '-' ||
    substr(p_digest, 21, 12)
  )::uuid
$$;

-- Never pass completion_ack_active_obligation.obligation through to 0198.  That display payload
-- contains bounded retry telemetry and a reason that can change under one immutable revision.
-- The coordinator source below is synthesized only from the immutable revision row.
CREATE VIEW completion_ack_coordinator_source AS
SELECT revision.tenant_id,
       revision.project_id,
       revision.task_id,
       revision.session_id,
       revision.turn_id,
       'COMPLETION_ACK'::text AS source_type,
       revision.obligation_id::text AS source_key,
       revision.obligation_id,
       revision.obligation_revision,
       revision.obligation_revision AS binding_digest,
       jsonb_build_object(
         'schemaVersion', 1,
         'obligationId', revision.obligation_id::text,
         'obligationRevision', revision.obligation_revision::text,
         'bindingDigest', revision.obligation_revision::text,
         'kind', 'COMPLETION_ACK_STALE',
         'owner', 'PROJECT_COORDINATOR',
         'ownerType', 'AGENT',
         'capability', 'completion-ack.recover',
         'binding', jsonb_build_object(
           'tenantId', revision.tenant_id::text,
           'projectId', revision.project_id::text,
           'taskId', revision.task_id::text,
           'sessionId', revision.session_id::text,
           'turnId', revision.turn_id::text,
           'protocol', revision.protocol,
           'errorFingerprint', revision.error_fingerprint
         )
       ) AS obligation
  FROM completion_ack_obligation_revision revision
  JOIN completion_ack_active_obligation active
    ON active.tenant_id = revision.tenant_id
   AND active.project_id = revision.project_id
   AND active.task_id = revision.task_id
   AND active.session_id = revision.session_id
   AND active.turn_id = revision.turn_id
   AND active.obligation_id = revision.obligation_id
   AND active.obligation_revision = revision.obligation_revision;

COMMENT ON VIEW completion_ack_coordinator_source IS
  'Revision-stable adapter from the canonical 0201 ACTIVE reduction to 0198; display telemetry is deliberately excluded.';

-- Backfill only exact active completion sources.  Registration repeats this idempotently so a
-- project that acquires its first ACK obligation after rollout cannot depend on unrelated 0194
-- ingress having happened first.
INSERT INTO outcome_fact_stream(tenant_id, project_id)
SELECT DISTINCT source.tenant_id, source.project_id
  FROM completion_ack_coordinator_source source
  JOIN project
    ON project.id = source.project_id AND project.owner_id = source.tenant_id
ON CONFLICT (tenant_id, project_id) DO NOTHING;

-- One delivery attempt is planned under one immutable 0198 lease.  A successor lease may finish
-- an earlier unreceipted plan, preserving the exact target Session identity across the crash gap.
CREATE TABLE completion_ack_coordinator_delivery_plan (
  plan_id                 uuid        PRIMARY KEY,
  tenant_id               uuid        NOT NULL,
  project_id              uuid        NOT NULL,
  coordination_id         uuid        NOT NULL,
  obligation_id           char(64)    NOT NULL CHECK (outcome_valid_digest(obligation_id)),
  obligation_revision     char(64)    NOT NULL CHECK (outcome_valid_digest(obligation_revision)),
  task_id                  uuid        NOT NULL,
  affected_session_id      uuid        NOT NULL,
  turn_id                  uuid        NOT NULL,
  origin_lease_id          uuid        NOT NULL,
  origin_lease_generation  bigint      NOT NULL CHECK (origin_lease_generation > 0),
  origin_worker_id         text        NOT NULL CHECK (btrim(origin_worker_id) <> ''),
  target_session_id        uuid        NOT NULL,
  subject_version          char(64)    NOT NULL CHECK (outcome_valid_digest(subject_version)),
  created_logical_time     bigint      NOT NULL CHECK (created_logical_time >= 0),
  plan_digest              char(64)    NOT NULL CHECK (outcome_valid_digest(plan_digest)),
  recorded_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (coordination_id, obligation_revision, origin_lease_id),
  UNIQUE (target_session_id),
  UNIQUE (plan_digest),
  FOREIGN KEY (coordination_id) REFERENCES outcome_coordinator_obligation(coordination_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (origin_lease_id) REFERENCES outcome_coordinator_lease(lease_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (obligation_id, obligation_revision)
    REFERENCES completion_ack_obligation_revision(obligation_id, obligation_revision)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX completion_ack_delivery_plan_latest_idx
  ON completion_ack_coordinator_delivery_plan(
    tenant_id, coordination_id, recorded_at DESC, plan_id DESC
  );

CREATE TABLE completion_ack_coordinator_delivery_receipt (
  delivery_receipt_id     uuid        PRIMARY KEY,
  plan_id                 uuid        NOT NULL UNIQUE,
  tenant_id               uuid        NOT NULL,
  project_id              uuid        NOT NULL,
  coordination_id         uuid        NOT NULL,
  obligation_id           char(64)    NOT NULL CHECK (outcome_valid_digest(obligation_id)),
  obligation_revision     char(64)    NOT NULL CHECK (outcome_valid_digest(obligation_revision)),
  recorded_lease_id       uuid        NOT NULL,
  recorded_worker_id      text        NOT NULL CHECK (btrim(recorded_worker_id) <> ''),
  wake_id_snapshot        uuid        NOT NULL,
  session_id_snapshot     uuid        NOT NULL UNIQUE,
  receipt_digest          char(64)    NOT NULL UNIQUE CHECK (outcome_valid_digest(receipt_digest)),
  recorded_logical_time   bigint      NOT NULL CHECK (recorded_logical_time >= 0),
  recorded_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (plan_id) REFERENCES completion_ack_coordinator_delivery_plan(plan_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (recorded_lease_id) REFERENCES outcome_coordinator_lease(lease_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX completion_ack_delivery_receipt_coordination_idx
  ON completion_ack_coordinator_delivery_receipt(
    tenant_id, coordination_id, recorded_at DESC, delivery_receipt_id DESC
  );

-- A receipt is immutable; successor ownership is another immutable fact rather than an UPDATE.
CREATE TABLE completion_ack_coordinator_delivery_adoption (
  adoption_id             uuid        PRIMARY KEY,
  delivery_receipt_id     uuid        NOT NULL,
  plan_id                 uuid        NOT NULL,
  tenant_id               uuid        NOT NULL,
  project_id              uuid        NOT NULL,
  coordination_id         uuid        NOT NULL,
  obligation_revision     char(64)    NOT NULL CHECK (outcome_valid_digest(obligation_revision)),
  lease_id                 uuid        NOT NULL,
  lease_generation         bigint      NOT NULL CHECK (lease_generation > 0),
  worker_id                text        NOT NULL CHECK (btrim(worker_id) <> ''),
  adopted                  boolean     NOT NULL,
  recorded_logical_time   bigint      NOT NULL CHECK (recorded_logical_time >= 0),
  adoption_digest          char(64)    NOT NULL UNIQUE CHECK (outcome_valid_digest(adoption_digest)),
  recorded_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (delivery_receipt_id, lease_id),
  UNIQUE (lease_id),
  FOREIGN KEY (delivery_receipt_id) REFERENCES completion_ack_coordinator_delivery_receipt(delivery_receipt_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (plan_id) REFERENCES completion_ack_coordinator_delivery_plan(plan_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (lease_id) REFERENCES outcome_coordinator_lease(lease_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- UUIDs below are identity snapshots, intentionally not FKs.  A deleted Session or Task must not
-- rewrite or erase the evidence that the coordinator delivered/created it.
CREATE TABLE completion_ack_remediation_action (
  action_id                uuid        PRIMARY KEY,
  tenant_id                uuid        NOT NULL,
  project_id               uuid        NOT NULL,
  coordination_id         uuid        NOT NULL,
  obligation_id           char(64)    NOT NULL CHECK (outcome_valid_digest(obligation_id)),
  obligation_revision     char(64)    NOT NULL CHECK (outcome_valid_digest(obligation_revision)),
  plan_id                 uuid        NOT NULL,
  delivery_receipt_id     uuid        NOT NULL,
  source_session_id_snapshot uuid     NOT NULL,
  action_kind             text        NOT NULL CHECK (action_kind IN (
    'TASK_CREATED', 'TASK_UPDATED', 'TASK_EXECUTE_REQUESTED', 'TASK_COMMENTED'
  )),
  action_key              text        NOT NULL CHECK (
    length(btrim(action_key)) BETWEEN 1 AND 512
  ),
  task_id_snapshot        uuid        NOT NULL,
  task_project_id_snapshot uuid,
  evidence                jsonb       NOT NULL CHECK (
    jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 8192
  ),
  evidence_digest         char(64)    NOT NULL CHECK (outcome_valid_digest(evidence_digest)),
  action_digest           char(64)    NOT NULL UNIQUE CHECK (outcome_valid_digest(action_digest)),
  recorded_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (
    obligation_revision, source_session_id_snapshot, task_id_snapshot,
    action_kind, action_key
  ),
  CHECK (evidence_digest = outcome_sha256_json(evidence)),
  FOREIGN KEY (plan_id) REFERENCES completion_ack_coordinator_delivery_plan(plan_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (delivery_receipt_id) REFERENCES completion_ack_coordinator_delivery_receipt(delivery_receipt_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX completion_ack_remediation_action_coordination_idx
  ON completion_ack_remediation_action(
    tenant_id, coordination_id, recorded_at DESC, action_id DESC
  );

-- One operationally current delivery for one still-ACTIVE canonical obligation.  A receipt is
-- immutable history; becoming current is derived from (a) the 0201 source still being ACTIVE and
-- (b) being the latest valid receipt for that exact identity.  Later delivery-liveness migrations
-- may further exclude an append-only revocation fact without changing consumers of this view.
CREATE VIEW completion_ack_current_coordinator_delivery AS
SELECT DISTINCT ON (
         receipt.tenant_id, receipt.project_id,
         receipt.obligation_id, receipt.obligation_revision
       )
       receipt.tenant_id,
       receipt.project_id,
       receipt.coordination_id,
       receipt.obligation_id,
       receipt.obligation_revision,
       receipt.delivery_receipt_id,
       receipt.plan_id,
       receipt.wake_id_snapshot AS wake_id,
       receipt.session_id_snapshot AS session_id,
       coordinator_session.status::text AS session_status,
       COALESCE(coordinator_session.engine_turn_active, false) AS engine_turn_active,
       coordinator_session.retry_at,
       receipt.recorded_logical_time,
       receipt.recorded_at
  FROM completion_ack_coordinator_delivery_receipt receipt
  JOIN completion_ack_active_obligation active
    ON active.tenant_id = receipt.tenant_id
   AND active.project_id = receipt.project_id
   AND active.obligation_id = receipt.obligation_id
   AND active.obligation_revision = receipt.obligation_revision
  LEFT JOIN session coordinator_session
    ON coordinator_session.id = receipt.session_id_snapshot
   AND coordinator_session.owner_id = receipt.tenant_id
 ORDER BY receipt.tenant_id, receipt.project_id,
          receipt.obligation_id, receipt.obligation_revision,
          receipt.recorded_at DESC, receipt.delivery_receipt_id DESC;

COMMENT ON VIEW completion_ack_current_coordinator_delivery IS
  'Latest valid coordinator delivery for an exact ACTIVE 0201 completion-ACK obligation; closed sources confer no remediation authority.';

-- Public operational overlay.  The 0201 view remains the sole lifecycle authority and supplies the
-- immutable id/revision.  Delivery and remediation rows only enrich what that same obligation is
-- doing now; neither can create, resolve or revise it.  Every REST/SSE/UI consumer reads this view
-- through common/completion-ack-obligation.ts, while the coordinator reads the same receipt/action
-- ledgers through completion_ack_coordination_state.
CREATE VIEW completion_ack_operational_obligation AS
SELECT active.tenant_id,
       active.project_id,
       active.task_id,
       active.session_id,
       active.turn_id,
       active.error_fingerprint,
       active.obligation_id,
       active.obligation_revision,
       active.obligation || jsonb_build_object(
         -- Delivery is an operational projection of the immutable 0201 obligation. Keep the
         -- canonical requiredAction/nextAction stable for the lifetime of that revision;
         -- coordinator routing is exposed separately and cannot silently revise the obligation.
         'operationalAction', operational.next_action,
         'attemptedActions',
           CASE
             WHEN jsonb_typeof(active.obligation->'attemptedActions') = 'array'
               THEN active.obligation->'attemptedActions'
             ELSE '[]'::jsonb
           END
           || COALESCE(deliveries.attempted_actions, '[]'::jsonb)
           || COALESCE(actions.attempted_actions, '[]'::jsonb),
         'attemptedActionsTruncated',
           COALESCE((active.obligation->>'attemptedActionsTruncated')::boolean, false)
           OR COALESCE(deliveries.total_count, 0) > 8
           OR COALESCE(actions.total_count, 0) > 16,
         'totalAttemptedActionCount',
           COALESCE((active.obligation->>'totalAttemptedActionCount')::bigint, 0)
           + COALESCE(deliveries.total_count, 0)
           + COALESCE(actions.total_count, 0),
         'meaningfulAttemptedActionCount',
           COALESCE((active.obligation->>'meaningfulAttemptedActionCount')::bigint, 0)
           + COALESCE(deliveries.total_count, 0)
           + COALESCE(actions.total_count, 0),
         'currentDelivery', current_delivery.delivery,
         'remediationActions', COALESCE(actions.attempted_actions, '[]'::jsonb),
         'remediationActionCount', COALESCE(actions.total_count, 0),
         'activeRemediationTaskCount', COALESCE(action_summary.active_task_count, 0),
         'settledRemediationTaskCount', COALESCE(action_summary.settled_task_count, 0),
         'actionProtocol',
           CASE
             WHEN jsonb_typeof(active.obligation->'actionProtocol') = 'object'
               THEN active.obligation->'actionProtocol'
             ELSE '{}'::jsonb
           END || jsonb_build_object(
             'operationalSource', 'COMPLETION_ACK_DELIVERY_AND_REMEDIATION_LEDGER',
             'currentDeliveryReceiptId', current_delivery.delivery_receipt_id,
             'currentCoordinatorSessionId', current_delivery.session_id
           )
       ) AS obligation,
       active.first_failure_at,
       active.latest_failure_at,
       active.observation_count
  FROM completion_ack_active_obligation active
  LEFT JOIN LATERAL (
    SELECT current.delivery_receipt_id,
           current.session_id,
           current.session_status,
           current.engine_turn_active,
           current.retry_at,
           jsonb_strip_nulls(jsonb_build_object(
             'deliveryReceiptId', current.delivery_receipt_id::text,
             'planId', current.plan_id::text,
             'wakeId', current.wake_id::text,
             'sessionId', current.session_id::text,
             'sessionStatus', current.session_status,
             'engineTurnActive', current.engine_turn_active,
             'retryAt', current.retry_at,
             'recordedAt', current.recorded_at
           )) AS delivery
      FROM completion_ack_current_coordinator_delivery current
     WHERE current.tenant_id = active.tenant_id
       AND current.project_id = active.project_id
       AND current.obligation_id = active.obligation_id
       AND current.obligation_revision = active.obligation_revision
  ) current_delivery ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(max(bounded.total_count), 0)::bigint AS total_count,
           COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'action', 'COORDINATOR_DELIVERY',
             'outcome', COALESCE(bounded.session_status, 'SESSION_MISSING'),
             'deliveryReceiptId', bounded.delivery_receipt_id::text,
             'planId', bounded.plan_id::text,
             'sessionId', bounded.session_id_snapshot::text,
             'recordedAt', bounded.recorded_at
           )) ORDER BY bounded.recorded_at, bounded.delivery_receipt_id), '[]'::jsonb)
             AS attempted_actions
      FROM (
        SELECT receipt.delivery_receipt_id, receipt.plan_id,
               receipt.session_id_snapshot, receipt.recorded_at,
               coordinator_session.status::text AS session_status,
               count(*) OVER () AS total_count
          FROM completion_ack_coordinator_delivery_receipt receipt
          LEFT JOIN session coordinator_session
            ON coordinator_session.id = receipt.session_id_snapshot
           AND coordinator_session.owner_id = receipt.tenant_id
         WHERE receipt.tenant_id = active.tenant_id
           AND receipt.project_id = active.project_id
           AND receipt.obligation_id = active.obligation_id
           AND receipt.obligation_revision = active.obligation_revision
         ORDER BY receipt.recorded_at DESC, receipt.delivery_receipt_id DESC
         LIMIT 8
      ) bounded
  ) deliveries ON true
  LEFT JOIN LATERAL (
    SELECT count(DISTINCT action.task_id_snapshot) FILTER (
             WHERE remediation_task.status::text IN ('OPEN', 'IN_PROGRESS')
           )::bigint AS active_task_count,
           count(DISTINCT action.task_id_snapshot) FILTER (
             WHERE remediation_task.status::text IN ('DONE', 'FAILED', 'CANCELLED')
           )::bigint AS settled_task_count
      FROM completion_ack_remediation_action action
      LEFT JOIN task remediation_task
        ON remediation_task.id = action.task_id_snapshot
       AND remediation_task.owner_id = action.tenant_id
     WHERE action.tenant_id = active.tenant_id
       AND action.project_id = active.project_id
       AND action.obligation_id = active.obligation_id
       AND action.obligation_revision = active.obligation_revision
  ) action_summary ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(max(bounded.total_count), 0)::bigint AS total_count,
           COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'action', bounded.action_kind,
             'outcome', COALESCE(bounded.task_status, 'TASK_MISSING'),
             'actionId', bounded.action_id::text,
             'actionKey', bounded.action_key,
             'taskId', bounded.task_id_snapshot::text,
             'deliveryReceiptId', bounded.delivery_receipt_id::text,
             'evidenceDigest', bounded.evidence_digest::text,
             'recordedAt', bounded.recorded_at
           )) ORDER BY bounded.recorded_at, bounded.action_id), '[]'::jsonb)
             AS attempted_actions
      FROM (
        SELECT action.*, remediation_task.status::text AS task_status,
               count(*) OVER () AS total_count
          FROM completion_ack_remediation_action action
          LEFT JOIN task remediation_task
            ON remediation_task.id = action.task_id_snapshot
           AND remediation_task.owner_id = action.tenant_id
         WHERE action.tenant_id = active.tenant_id
           AND action.project_id = active.project_id
           AND action.obligation_id = active.obligation_id
           AND action.obligation_revision = active.obligation_revision
         ORDER BY action.recorded_at DESC, action.action_id DESC
         LIMIT 16
      ) bounded
  ) actions ON true
 CROSS JOIN LATERAL (
    SELECT CASE
      WHEN COALESCE(action_summary.active_task_count, 0) > 0
        THEN 'WAIT_FOR_REMEDIATION_TASKS'
      WHEN current_delivery.delivery_receipt_id IS NULL
        THEN 'ROUTE_TO_PROJECT_COORDINATOR'
      WHEN current_delivery.engine_turn_active
        OR current_delivery.session_status IN ('PENDING', 'RUNNING', 'INTERRUPTED')
        OR (current_delivery.session_status = 'FAILED' AND current_delivery.retry_at IS NOT NULL)
        THEN 'AWAIT_PROJECT_COORDINATOR_ACTION'
      ELSE 'ROUTE_NEXT_REMEDIATION_STEP'
    END AS next_action
  ) operational;

COMMENT ON VIEW completion_ack_operational_obligation IS
  'One canonical 0201 obligation enriched with the 0202 delivery/action ledgers; operational state never supplies lifecycle or canonical-action authority.';

CREATE TRIGGER completion_ack_delivery_plan_append_only
  BEFORE UPDATE OR DELETE ON completion_ack_coordinator_delivery_plan
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER completion_ack_delivery_receipt_append_only
  BEFORE UPDATE OR DELETE ON completion_ack_coordinator_delivery_receipt
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER completion_ack_delivery_adoption_append_only
  BEFORE UPDATE OR DELETE ON completion_ack_coordinator_delivery_adoption
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER completion_ack_remediation_action_append_only
  BEFORE UPDATE OR DELETE ON completion_ack_remediation_action
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();

CREATE OR REPLACE FUNCTION completion_ack_sanitize_action_evidence(p_evidence jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, outcome_watchdog AS $$
DECLARE
  v_sanitized jsonb;
BEGIN
  IF p_evidence IS NULL OR jsonb_typeof(p_evidence) <> 'object'
     OR octet_length(p_evidence::text) > 16384 THEN
    RAISE EXCEPTION 'COMPLETION_ACK_ACTION_EVIDENCE_INVALID'
      USING ERRCODE = 'program_limit_exceeded';
  END IF;
  v_sanitized := outcome_watchdog.sanitize_payload(p_evidence);
  IF octet_length(v_sanitized::text) > 8192 THEN
    RAISE EXCEPTION 'COMPLETION_ACK_ACTION_EVIDENCE_TOO_LARGE'
      USING ERRCODE = 'program_limit_exceeded';
  END IF;
  RETURN v_sanitized;
END;
$$;

CREATE OR REPLACE FUNCTION completion_ack_delivery_plan_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_standing outcome_coordinator_obligation%ROWTYPE;
  v_lease outcome_coordinator_lease%ROWTYPE;
  v_revision completion_ack_obligation_revision%ROWTYPE;
  v_plan_digest char(64);
  v_plan_id uuid;
  v_target_session_id uuid;
  v_subject_version char(64);
BEGIN
  SELECT * INTO v_standing
    FROM outcome_coordinator_obligation standing
   WHERE standing.coordination_id = NEW.coordination_id
   FOR KEY SHARE;
  SELECT * INTO v_lease
    FROM outcome_coordinator_lease lease
   WHERE lease.lease_id = NEW.origin_lease_id
   FOR KEY SHARE;
  SELECT * INTO v_revision
    FROM completion_ack_obligation_revision revision
   WHERE revision.obligation_revision = NEW.obligation_revision
   FOR KEY SHARE;

  IF v_standing.coordination_id IS NULL OR v_lease.lease_id IS NULL
     OR v_revision.obligation_revision IS NULL
     OR v_standing.source_type <> 'COMPLETION_ACK'
     OR v_standing.capability <> 'completion-ack.recover'
     OR v_standing.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR v_standing.project_id IS DISTINCT FROM NEW.project_id
     OR v_standing.obligation_id IS DISTINCT FROM NEW.obligation_id
     OR v_standing.obligation_revision IS DISTINCT FROM NEW.obligation_revision
     OR v_standing.status <> 'CLAIMED'
     OR v_standing.lease_id IS DISTINCT FROM NEW.origin_lease_id
     OR v_standing.lease_owner IS DISTINCT FROM NEW.origin_worker_id
     OR v_lease.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR v_lease.project_id IS DISTINCT FROM NEW.project_id
     OR v_lease.coordination_id IS DISTINCT FROM NEW.coordination_id
     OR v_lease.obligation_revision IS DISTINCT FROM NEW.obligation_revision
     OR v_lease.generation IS DISTINCT FROM NEW.origin_lease_generation
     OR v_lease.worker_id IS DISTINCT FROM NEW.origin_worker_id
     OR v_revision.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR v_revision.project_id IS DISTINCT FROM NEW.project_id
     OR v_revision.obligation_id IS DISTINCT FROM NEW.obligation_id
     OR v_revision.task_id IS DISTINCT FROM NEW.task_id
     OR v_revision.session_id IS DISTINCT FROM NEW.affected_session_id
     OR v_revision.turn_id IS DISTINCT FROM NEW.turn_id
     OR NOT EXISTS (
       SELECT 1 FROM completion_ack_coordinator_source source
        WHERE source.tenant_id = NEW.tenant_id
          AND source.project_id = NEW.project_id
          AND source.obligation_id = NEW.obligation_id
          AND source.obligation_revision = NEW.obligation_revision
     ) THEN
    RAISE EXCEPTION 'COMPLETION_ACK_DELIVERY_PLAN_SCOPE_INVALID:%', NEW.plan_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  v_plan_digest := outcome_sha256_json(jsonb_build_array(
    'completion-ack-delivery-plan:v1', NEW.tenant_id::text, NEW.project_id::text,
    NEW.coordination_id::text, NEW.obligation_id::text,
    NEW.obligation_revision::text, NEW.origin_lease_id::text
  ));
  v_plan_id := completion_ack_uuid_from_digest(v_plan_digest::text);
  v_target_session_id := completion_ack_uuid_from_digest(outcome_sha256_json(jsonb_build_array(
    'completion-ack-delivery-session:v1', v_plan_digest::text
  )));
  v_subject_version := outcome_sha256_json(jsonb_build_array(
    'completion-ack-delivery-subject:v1', NEW.obligation_revision::text,
    v_plan_digest::text
  ));
  IF NEW.plan_id IS DISTINCT FROM v_plan_id
     OR NEW.target_session_id IS DISTINCT FROM v_target_session_id
     OR NEW.subject_version IS DISTINCT FROM v_subject_version
     OR NEW.plan_digest IS DISTINCT FROM v_plan_digest
     OR NEW.created_logical_time IS DISTINCT FROM outcome_coordinator_now(NEW.tenant_id) THEN
    RAISE EXCEPTION 'COMPLETION_ACK_DELIVERY_PLAN_IDENTITY_INVALID:%', NEW.plan_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER completion_ack_delivery_plan_insert_guard
  BEFORE INSERT ON completion_ack_coordinator_delivery_plan
  FOR EACH ROW EXECUTE FUNCTION completion_ack_delivery_plan_insert_guard();

CREATE OR REPLACE FUNCTION completion_ack_delivery_receipt_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_plan completion_ack_coordinator_delivery_plan%ROWTYPE;
  v_standing outcome_coordinator_obligation%ROWTYPE;
  v_lease outcome_coordinator_lease%ROWTYPE;
  v_wake project_coordinator_wake%ROWTYPE;
  v_session session%ROWTYPE;
  v_project project%ROWTYPE;
  v_receipt_digest char(64);
  v_receipt_id uuid;
BEGIN
  SELECT * INTO v_plan FROM completion_ack_coordinator_delivery_plan plan
   WHERE plan.plan_id = NEW.plan_id FOR KEY SHARE;
  SELECT * INTO v_standing FROM outcome_coordinator_obligation standing
   WHERE standing.coordination_id = NEW.coordination_id FOR KEY SHARE;
  SELECT * INTO v_lease FROM outcome_coordinator_lease lease
   WHERE lease.lease_id = NEW.recorded_lease_id FOR KEY SHARE;
  SELECT * INTO v_wake FROM project_coordinator_wake wake
   WHERE wake.id = NEW.wake_id_snapshot FOR KEY SHARE;
  SELECT * INTO v_session FROM session coordinator_session
   WHERE coordinator_session.id = NEW.session_id_snapshot FOR KEY SHARE;
  SELECT * INTO v_project FROM project project_scope
   WHERE project_scope.id = NEW.project_id FOR KEY SHARE;

  IF v_plan.plan_id IS NULL OR v_standing.coordination_id IS NULL
     OR v_lease.lease_id IS NULL OR v_wake.id IS NULL OR v_session.id IS NULL
     OR v_project.id IS NULL
     OR v_plan.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR v_plan.project_id IS DISTINCT FROM NEW.project_id
     OR v_plan.coordination_id IS DISTINCT FROM NEW.coordination_id
     OR v_plan.obligation_id IS DISTINCT FROM NEW.obligation_id
     OR v_plan.obligation_revision IS DISTINCT FROM NEW.obligation_revision
     OR v_standing.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR v_standing.project_id IS DISTINCT FROM NEW.project_id
     OR v_standing.obligation_id IS DISTINCT FROM NEW.obligation_id
     OR v_standing.obligation_revision IS DISTINCT FROM NEW.obligation_revision
     OR v_standing.source_type <> 'COMPLETION_ACK'
     OR v_standing.capability <> 'completion-ack.recover'
     OR v_standing.status <> 'CLAIMED'
     OR v_standing.lease_id IS DISTINCT FROM NEW.recorded_lease_id
     OR v_standing.lease_owner IS DISTINCT FROM NEW.recorded_worker_id
     OR v_lease.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR v_lease.project_id IS DISTINCT FROM NEW.project_id
     OR v_lease.coordination_id IS DISTINCT FROM NEW.coordination_id
     OR v_lease.obligation_revision IS DISTINCT FROM NEW.obligation_revision
     OR v_lease.worker_id IS DISTINCT FROM NEW.recorded_worker_id
     OR v_project.owner_id IS DISTINCT FROM NEW.tenant_id
     OR v_wake.project_id IS DISTINCT FROM NEW.project_id
     OR v_wake.event <> 'COMPLETION_ACK_STALE'
     OR v_wake.subject_type <> 'TASK'
     OR v_wake.subject_id <> v_plan.task_id::text
     OR v_wake.subject_version <> v_plan.subject_version::text
     OR v_wake.idempotency_key <> concat(
       'cw:v1:COMPLETION_ACK_STALE:TASK:', v_plan.task_id::text, ':',
       v_plan.subject_version::text
     )
     OR v_wake.status <> 'SESSION_OPENED'
     OR v_wake.session_id IS DISTINCT FROM NEW.session_id_snapshot
     OR v_session.id IS DISTINCT FROM v_plan.target_session_id
     OR v_session.owner_id IS DISTINCT FROM NEW.tenant_id
     OR v_session.workspace_id IS DISTINCT FROM v_project.coordinator_workspace_id
     OR v_session.dispatch_origin::text <> 'PROJECT_COORDINATOR'
     OR v_session.run_source::text <> 'PROJECT_COORDINATOR'
     OR v_session.task_id IS NOT NULL
     OR v_session.starts_task_work
     OR v_session.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'COMPLETION_ACK_DELIVERY_RECEIPT_SCOPE_INVALID:%', NEW.delivery_receipt_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  v_receipt_digest := outcome_sha256_json(jsonb_build_array(
    'completion-ack-delivery-receipt:v1', v_plan.plan_digest::text,
    NEW.wake_id_snapshot::text, NEW.session_id_snapshot::text
  ));
  v_receipt_id := completion_ack_uuid_from_digest(v_receipt_digest::text);
  IF NEW.delivery_receipt_id IS DISTINCT FROM v_receipt_id
     OR NEW.receipt_digest IS DISTINCT FROM v_receipt_digest
     OR NEW.recorded_logical_time IS DISTINCT FROM outcome_coordinator_now(NEW.tenant_id) THEN
    RAISE EXCEPTION 'COMPLETION_ACK_DELIVERY_RECEIPT_IDENTITY_INVALID:%', NEW.delivery_receipt_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER completion_ack_delivery_receipt_insert_guard
  BEFORE INSERT ON completion_ack_coordinator_delivery_receipt
  FOR EACH ROW EXECUTE FUNCTION completion_ack_delivery_receipt_insert_guard();

CREATE OR REPLACE FUNCTION completion_ack_delivery_adoption_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_receipt completion_ack_coordinator_delivery_receipt%ROWTYPE;
  v_plan completion_ack_coordinator_delivery_plan%ROWTYPE;
  v_standing outcome_coordinator_obligation%ROWTYPE;
  v_lease outcome_coordinator_lease%ROWTYPE;
  v_digest char(64);
BEGIN
  SELECT * INTO v_receipt FROM completion_ack_coordinator_delivery_receipt receipt
   WHERE receipt.delivery_receipt_id = NEW.delivery_receipt_id FOR KEY SHARE;
  SELECT * INTO v_plan FROM completion_ack_coordinator_delivery_plan plan
   WHERE plan.plan_id = NEW.plan_id FOR KEY SHARE;
  SELECT * INTO v_standing FROM outcome_coordinator_obligation standing
   WHERE standing.coordination_id = NEW.coordination_id FOR KEY SHARE;
  SELECT * INTO v_lease FROM outcome_coordinator_lease lease
   WHERE lease.lease_id = NEW.lease_id FOR KEY SHARE;
  IF v_receipt.delivery_receipt_id IS NULL OR v_plan.plan_id IS NULL
     OR v_standing.coordination_id IS NULL OR v_lease.lease_id IS NULL
     OR v_receipt.plan_id IS DISTINCT FROM NEW.plan_id
     OR v_receipt.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR v_receipt.project_id IS DISTINCT FROM NEW.project_id
     OR v_receipt.coordination_id IS DISTINCT FROM NEW.coordination_id
     OR v_receipt.obligation_revision IS DISTINCT FROM NEW.obligation_revision
     OR v_standing.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR v_standing.project_id IS DISTINCT FROM NEW.project_id
     OR v_standing.obligation_revision IS DISTINCT FROM NEW.obligation_revision
     OR v_standing.status <> 'CLAIMED'
     OR v_standing.lease_id IS DISTINCT FROM NEW.lease_id
     OR v_standing.lease_owner IS DISTINCT FROM NEW.worker_id
     OR v_lease.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR v_lease.project_id IS DISTINCT FROM NEW.project_id
     OR v_lease.coordination_id IS DISTINCT FROM NEW.coordination_id
     OR v_lease.obligation_revision IS DISTINCT FROM NEW.obligation_revision
     OR v_lease.generation IS DISTINCT FROM NEW.lease_generation
     OR v_lease.worker_id IS DISTINCT FROM NEW.worker_id
     OR NEW.adopted IS DISTINCT FROM (v_plan.origin_lease_id <> NEW.lease_id)
     OR NEW.recorded_logical_time IS DISTINCT FROM outcome_coordinator_now(NEW.tenant_id) THEN
    RAISE EXCEPTION 'COMPLETION_ACK_DELIVERY_ADOPTION_SCOPE_INVALID:%', NEW.adoption_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  v_digest := outcome_sha256_json(jsonb_build_array(
    'completion-ack-delivery-adoption:v1', NEW.delivery_receipt_id::text,
    NEW.lease_id::text, NEW.worker_id
  ));
  IF NEW.adoption_id IS DISTINCT FROM completion_ack_uuid_from_digest(v_digest::text)
     OR NEW.adoption_digest IS DISTINCT FROM v_digest THEN
    RAISE EXCEPTION 'COMPLETION_ACK_DELIVERY_ADOPTION_IDENTITY_INVALID:%', NEW.adoption_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER completion_ack_delivery_adoption_insert_guard
  BEFORE INSERT ON completion_ack_coordinator_delivery_adoption
  FOR EACH ROW EXECUTE FUNCTION completion_ack_delivery_adoption_insert_guard();

CREATE OR REPLACE FUNCTION completion_ack_remediation_action_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_receipt completion_ack_coordinator_delivery_receipt%ROWTYPE;
  v_plan completion_ack_coordinator_delivery_plan%ROWTYPE;
  v_task task%ROWTYPE;
  v_digest char(64);
BEGIN
  SELECT * INTO v_receipt FROM completion_ack_coordinator_delivery_receipt receipt
   WHERE receipt.delivery_receipt_id = NEW.delivery_receipt_id FOR KEY SHARE;
  SELECT * INTO v_plan FROM completion_ack_coordinator_delivery_plan plan
   WHERE plan.plan_id = NEW.plan_id FOR KEY SHARE;
  SELECT * INTO v_task FROM task remediation_task
   WHERE remediation_task.id = NEW.task_id_snapshot FOR KEY SHARE;
  IF v_receipt.delivery_receipt_id IS NULL OR v_plan.plan_id IS NULL OR v_task.id IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM completion_ack_current_coordinator_delivery current
        WHERE current.tenant_id = NEW.tenant_id
          AND current.project_id = NEW.project_id
          AND current.coordination_id = NEW.coordination_id
          AND current.obligation_id = NEW.obligation_id
          AND current.obligation_revision = NEW.obligation_revision
          AND current.delivery_receipt_id = NEW.delivery_receipt_id
          AND current.session_id = NEW.source_session_id_snapshot
     )
     OR v_receipt.plan_id IS DISTINCT FROM NEW.plan_id
     OR v_receipt.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR v_receipt.project_id IS DISTINCT FROM NEW.project_id
     OR v_receipt.coordination_id IS DISTINCT FROM NEW.coordination_id
     OR v_receipt.obligation_id IS DISTINCT FROM NEW.obligation_id
     OR v_receipt.obligation_revision IS DISTINCT FROM NEW.obligation_revision
     OR v_receipt.session_id_snapshot IS DISTINCT FROM NEW.source_session_id_snapshot
     OR (NEW.action_kind = 'TASK_CREATED'
       AND v_task.creator_session_id IS DISTINCT FROM NEW.source_session_id_snapshot)
     OR v_task.owner_id IS DISTINCT FROM NEW.tenant_id
     OR v_task.project_id IS DISTINCT FROM NEW.task_project_id_snapshot
     OR v_task.project_id IS DISTINCT FROM NEW.project_id
     OR v_task.completion_criterion::text = 'HUMAN_SIGNOFF'
     OR NEW.action_kind NOT IN (
       'TASK_CREATED', 'TASK_UPDATED', 'TASK_EXECUTE_REQUESTED', 'TASK_COMMENTED'
     )
     OR NEW.evidence IS DISTINCT FROM completion_ack_sanitize_action_evidence(NEW.evidence)
     OR NEW.evidence_digest IS DISTINCT FROM outcome_sha256_json(NEW.evidence) THEN
    RAISE EXCEPTION 'COMPLETION_ACK_REMEDIATION_ACTION_SCOPE_INVALID:%', NEW.action_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  v_digest := outcome_sha256_json(jsonb_build_array(
    'completion-ack-remediation-action:v1', NEW.delivery_receipt_id::text,
    NEW.obligation_revision::text, NEW.source_session_id_snapshot::text,
    NEW.task_id_snapshot::text, NEW.action_kind, NEW.action_key,
    NEW.evidence_digest::text
  ));
  IF NEW.action_id IS DISTINCT FROM completion_ack_uuid_from_digest(v_digest::text)
     OR NEW.action_digest IS DISTINCT FROM v_digest THEN
    RAISE EXCEPTION 'COMPLETION_ACK_REMEDIATION_ACTION_IDENTITY_INVALID:%', NEW.action_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER completion_ack_remediation_action_insert_guard
  BEFORE INSERT ON completion_ack_remediation_action
  FOR EACH ROW EXECUTE FUNCTION completion_ack_remediation_action_insert_guard();

-- A canonical remediation Task is agent-owned executable/verifiable work.  HUMAN_SIGNOFF is not a
-- fallback criterion for it: irreducibly human input has the typed owner-decision protocol.  Check
-- the final Task row after every other trigger has run. A current ACTIVE delivery proves that a
-- newly-created Task is remediation work; an immutable action link keeps that Task's criterion
-- invariant after the source closes. Closure empties current-delivery, so the historical Session
-- gains no authority to create or exempt new work, while the Task it actually created cannot be
-- repurposed into an unowned human queue and thereby rewrite the incident's operational meaning.
CREATE OR REPLACE FUNCTION completion_ack_remediation_task_criterion_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_obligation_revision char(64);
BEGIN
  IF NEW.completion_criterion::text <> 'HUMAN_SIGNOFF' THEN RETURN NEW; END IF;

  SELECT candidate.obligation_revision INTO v_obligation_revision
    FROM (
      SELECT current.obligation_revision
        FROM completion_ack_current_coordinator_delivery current
       WHERE NEW.creator_session_id IS NOT NULL
         AND current.tenant_id = NEW.owner_id
         AND current.project_id = NEW.project_id
         AND current.session_id = NEW.creator_session_id
      UNION ALL
      SELECT action.obligation_revision
        FROM completion_ack_remediation_action action
       WHERE action.tenant_id = NEW.owner_id
         AND action.task_id_snapshot = NEW.id
    ) candidate
   ORDER BY candidate.obligation_revision
   LIMIT 1;

  IF v_obligation_revision IS NOT NULL THEN
    RAISE EXCEPTION 'COMPLETION_ACK_REMEDIATION_HUMAN_SIGNOFF_FORBIDDEN:%:%',
      NEW.id, v_obligation_revision
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- Two triggers avoid PostgreSQL's ambiguous INSERT OR UPDATE OF grammar.  The zz prefix makes the
-- final-row assertion run after the action-ledger AFTER INSERT trigger; a refusal rolls both back.
CREATE TRIGGER zz_task_completion_ack_remediation_criterion_insert_guard
  AFTER INSERT ON task
  FOR EACH ROW EXECUTE FUNCTION completion_ack_remediation_task_criterion_guard();
CREATE TRIGGER zz_task_completion_ack_remediation_criterion_update_guard
  AFTER UPDATE OF completion_criterion, status, project_id, creator_session_id ON task
  FOR EACH ROW EXECUTE FUNCTION completion_ack_remediation_task_criterion_guard();

CREATE OR REPLACE FUNCTION completion_ack_plan_coordinator_delivery(
  p_tenant_id uuid,
  p_coordination_id uuid,
  p_lease_token uuid,
  p_worker_id text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_standing outcome_coordinator_obligation%ROWTYPE;
  v_lease outcome_coordinator_lease%ROWTYPE;
  v_revision completion_ack_obligation_revision%ROWTYPE;
  v_plan completion_ack_coordinator_delivery_plan%ROWTYPE;
  v_plan_digest char(64);
  v_plan_id uuid;
  v_target_session_id uuid;
  v_subject_version char(64);
  v_now bigint;
BEGIN
  IF p_tenant_id IS NULL OR p_coordination_id IS NULL OR p_lease_token IS NULL
     OR btrim(COALESCE(p_worker_id, '')) = '' THEN
    RAISE EXCEPTION 'COMPLETION_ACK_DELIVERY_PLAN_ARGUMENT_INVALID'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_now := outcome_coordinator_now(p_tenant_id);
  SELECT * INTO v_standing
    FROM outcome_coordinator_obligation standing
   WHERE standing.tenant_id = p_tenant_id
     AND standing.coordination_id = p_coordination_id
   FOR UPDATE;
  IF NOT FOUND OR v_standing.source_type <> 'COMPLETION_ACK'
     OR v_standing.capability <> 'completion-ack.recover' THEN
    RAISE EXCEPTION 'COMPLETION_ACK_COORDINATION_NOT_FOUND'
      USING ERRCODE = 'no_data_found';
  END IF;
  IF v_standing.status <> 'CLAIMED'
     OR v_standing.lease_token IS DISTINCT FROM p_lease_token
     OR v_standing.lease_owner IS DISTINCT FROM p_worker_id
     OR v_standing.lease_expires_logical_time < v_now THEN
    RAISE EXCEPTION 'COMPLETION_ACK_COORDINATOR_LEASE_STALE'
      USING ERRCODE = 'serialization_failure';
  END IF;
  SELECT * INTO STRICT v_lease
    FROM outcome_coordinator_lease lease
   WHERE lease.lease_id = v_standing.lease_id
     AND lease.lease_token = p_lease_token;
  SELECT * INTO STRICT v_revision
    FROM completion_ack_obligation_revision revision
   WHERE revision.obligation_id = v_standing.obligation_id
     AND revision.obligation_revision = v_standing.obligation_revision
     AND revision.tenant_id = v_standing.tenant_id
     AND revision.project_id = v_standing.project_id;

  SELECT * INTO v_plan
    FROM completion_ack_coordinator_delivery_plan plan
   WHERE plan.coordination_id = v_standing.coordination_id
     AND plan.obligation_revision = v_standing.obligation_revision
     AND plan.origin_lease_id = v_lease.lease_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'planId', v_plan.plan_id::text,
      'targetSessionId', v_plan.target_session_id::text,
      'subjectVersion', v_plan.subject_version::text,
      'replayed', true
    );
  END IF;

  v_plan_digest := outcome_sha256_json(jsonb_build_array(
    'completion-ack-delivery-plan:v1', v_standing.tenant_id::text,
    v_standing.project_id::text, v_standing.coordination_id::text,
    v_standing.obligation_id::text, v_standing.obligation_revision::text,
    v_lease.lease_id::text
  ));
  v_plan_id := completion_ack_uuid_from_digest(v_plan_digest::text);
  v_target_session_id := completion_ack_uuid_from_digest(outcome_sha256_json(jsonb_build_array(
    'completion-ack-delivery-session:v1', v_plan_digest::text
  )));
  v_subject_version := outcome_sha256_json(jsonb_build_array(
    'completion-ack-delivery-subject:v1', v_standing.obligation_revision::text,
    v_plan_digest::text
  ));
  INSERT INTO completion_ack_coordinator_delivery_plan (
    plan_id, tenant_id, project_id, coordination_id, obligation_id,
    obligation_revision, task_id, affected_session_id, turn_id,
    origin_lease_id, origin_lease_generation, origin_worker_id,
    target_session_id, subject_version, created_logical_time, plan_digest
  ) VALUES (
    v_plan_id, v_standing.tenant_id, v_standing.project_id,
    v_standing.coordination_id, v_standing.obligation_id,
    v_standing.obligation_revision, v_revision.task_id, v_revision.session_id,
    v_revision.turn_id, v_lease.lease_id, v_lease.generation, p_worker_id,
    v_target_session_id, v_subject_version, v_now, v_plan_digest
  ) ON CONFLICT (coordination_id, obligation_revision, origin_lease_id) DO NOTHING;

  SELECT * INTO STRICT v_plan
    FROM completion_ack_coordinator_delivery_plan plan
   WHERE plan.coordination_id = v_standing.coordination_id
     AND plan.obligation_revision = v_standing.obligation_revision
     AND plan.origin_lease_id = v_lease.lease_id;
  IF v_plan.plan_digest IS DISTINCT FROM v_plan_digest THEN
    RAISE EXCEPTION 'COMPLETION_ACK_DELIVERY_PLAN_IDEMPOTENCY_CONFLICT'
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN jsonb_build_object(
    'planId', v_plan.plan_id::text,
    'targetSessionId', v_plan.target_session_id::text,
    'subjectVersion', v_plan.subject_version::text,
    'replayed', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION completion_ack_record_coordinator_delivery(
  p_tenant_id uuid,
  p_coordination_id uuid,
  p_current_lease_token uuid,
  p_worker_id text,
  p_plan_id uuid,
  p_wake_id uuid,
  p_session_id uuid
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_standing outcome_coordinator_obligation%ROWTYPE;
  v_lease outcome_coordinator_lease%ROWTYPE;
  v_plan completion_ack_coordinator_delivery_plan%ROWTYPE;
  v_receipt completion_ack_coordinator_delivery_receipt%ROWTYPE;
  v_receipt_digest char(64);
  v_receipt_id uuid;
  v_adoption_digest char(64);
  v_adoption_id uuid;
  v_now bigint;
  v_receipt_inserted boolean := false;
  v_adoption_inserted boolean := false;
  v_rows bigint;
BEGIN
  IF p_tenant_id IS NULL OR p_coordination_id IS NULL OR p_current_lease_token IS NULL
     OR p_plan_id IS NULL OR p_wake_id IS NULL OR p_session_id IS NULL
     OR btrim(COALESCE(p_worker_id, '')) = '' THEN
    RAISE EXCEPTION 'COMPLETION_ACK_DELIVERY_RECEIPT_ARGUMENT_INVALID'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_now := outcome_coordinator_now(p_tenant_id);
  SELECT * INTO v_standing
    FROM outcome_coordinator_obligation standing
   WHERE standing.tenant_id = p_tenant_id
     AND standing.coordination_id = p_coordination_id
   FOR UPDATE;
  IF NOT FOUND OR v_standing.source_type <> 'COMPLETION_ACK'
     OR v_standing.capability <> 'completion-ack.recover' THEN
    RAISE EXCEPTION 'COMPLETION_ACK_COORDINATION_NOT_FOUND'
      USING ERRCODE = 'no_data_found';
  END IF;
  IF v_standing.status <> 'CLAIMED'
     OR v_standing.lease_token IS DISTINCT FROM p_current_lease_token
     OR v_standing.lease_owner IS DISTINCT FROM p_worker_id
     OR v_standing.lease_expires_logical_time < v_now THEN
    RAISE EXCEPTION 'COMPLETION_ACK_COORDINATOR_LEASE_STALE'
      USING ERRCODE = 'serialization_failure';
  END IF;
  SELECT * INTO STRICT v_lease
    FROM outcome_coordinator_lease lease
   WHERE lease.lease_id = v_standing.lease_id
     AND lease.lease_token = p_current_lease_token;
  SELECT * INTO v_plan
    FROM completion_ack_coordinator_delivery_plan plan
   WHERE plan.plan_id = p_plan_id
   FOR KEY SHARE;
  IF NOT FOUND OR v_plan.tenant_id IS DISTINCT FROM p_tenant_id
     OR v_plan.project_id IS DISTINCT FROM v_standing.project_id
     OR v_plan.coordination_id IS DISTINCT FROM p_coordination_id
     OR v_plan.obligation_id IS DISTINCT FROM v_standing.obligation_id
     OR v_plan.obligation_revision IS DISTINCT FROM v_standing.obligation_revision
     OR v_plan.target_session_id IS DISTINCT FROM p_session_id THEN
    RAISE EXCEPTION 'COMPLETION_ACK_DELIVERY_PLAN_STALE_OR_FOREIGN'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  v_receipt_digest := outcome_sha256_json(jsonb_build_array(
    'completion-ack-delivery-receipt:v1', v_plan.plan_digest::text,
    p_wake_id::text, p_session_id::text
  ));
  v_receipt_id := completion_ack_uuid_from_digest(v_receipt_digest::text);
  INSERT INTO completion_ack_coordinator_delivery_receipt (
    delivery_receipt_id, plan_id, tenant_id, project_id, coordination_id,
    obligation_id, obligation_revision, recorded_lease_id, recorded_worker_id,
    wake_id_snapshot, session_id_snapshot, receipt_digest, recorded_logical_time
  ) VALUES (
    v_receipt_id, v_plan.plan_id, v_plan.tenant_id, v_plan.project_id,
    v_plan.coordination_id, v_plan.obligation_id, v_plan.obligation_revision,
    v_lease.lease_id, p_worker_id, p_wake_id, p_session_id,
    v_receipt_digest, v_now
  ) ON CONFLICT (plan_id) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_receipt_inserted := v_rows > 0;
  SELECT * INTO STRICT v_receipt
    FROM completion_ack_coordinator_delivery_receipt receipt
   WHERE receipt.plan_id = v_plan.plan_id;
  IF v_receipt.delivery_receipt_id IS DISTINCT FROM v_receipt_id
     OR v_receipt.wake_id_snapshot IS DISTINCT FROM p_wake_id
     OR v_receipt.session_id_snapshot IS DISTINCT FROM p_session_id
     OR v_receipt.receipt_digest IS DISTINCT FROM v_receipt_digest THEN
    RAISE EXCEPTION 'COMPLETION_ACK_DELIVERY_RECEIPT_IDEMPOTENCY_CONFLICT'
      USING ERRCODE = 'unique_violation';
  END IF;

  v_adoption_digest := outcome_sha256_json(jsonb_build_array(
    'completion-ack-delivery-adoption:v1', v_receipt.delivery_receipt_id::text,
    v_lease.lease_id::text, p_worker_id
  ));
  v_adoption_id := completion_ack_uuid_from_digest(v_adoption_digest::text);
  INSERT INTO completion_ack_coordinator_delivery_adoption (
    adoption_id, delivery_receipt_id, plan_id, tenant_id, project_id,
    coordination_id, obligation_revision, lease_id, lease_generation,
    worker_id, adopted, recorded_logical_time, adoption_digest
  ) VALUES (
    v_adoption_id, v_receipt.delivery_receipt_id, v_plan.plan_id, v_plan.tenant_id,
    v_plan.project_id, v_plan.coordination_id, v_plan.obligation_revision,
    v_lease.lease_id, v_lease.generation, p_worker_id,
    v_plan.origin_lease_id <> v_lease.lease_id, v_now, v_adoption_digest
  ) ON CONFLICT (delivery_receipt_id, lease_id) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_adoption_inserted := v_rows > 0;
  IF NOT EXISTS (
    SELECT 1 FROM completion_ack_coordinator_delivery_adoption adoption
     WHERE adoption.delivery_receipt_id = v_receipt.delivery_receipt_id
       AND adoption.lease_id = v_lease.lease_id
       AND adoption.worker_id = p_worker_id
       AND adoption.adoption_digest = v_adoption_digest
  ) THEN
    RAISE EXCEPTION 'COMPLETION_ACK_DELIVERY_ADOPTION_IDEMPOTENCY_CONFLICT'
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN jsonb_build_object(
    'deliveryReceiptId', v_receipt.delivery_receipt_id::text,
    'planId', v_plan.plan_id::text,
    'sessionId', v_receipt.session_id_snapshot::text,
    'wakeId', v_receipt.wake_id_snapshot::text,
    'replayed', NOT v_receipt_inserted AND NOT v_adoption_inserted,
    'adopted', v_plan.origin_lease_id <> v_lease.lease_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION completion_ack_task_created_action()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_receipt completion_ack_coordinator_delivery_receipt%ROWTYPE;
  v_active_count integer;
  v_evidence jsonb;
  v_evidence_digest char(64);
  v_action_digest char(64);
BEGIN
  IF NEW.creator_session_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO v_receipt
    FROM completion_ack_coordinator_delivery_receipt receipt
   WHERE receipt.delivery_receipt_id = (
     SELECT current.delivery_receipt_id
       FROM completion_ack_current_coordinator_delivery current
      WHERE current.tenant_id = NEW.owner_id
        AND current.project_id = NEW.project_id
        AND current.session_id = NEW.creator_session_id
   );
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.completion_criterion::text = 'HUMAN_SIGNOFF' THEN
    RAISE EXCEPTION 'COMPLETION_ACK_REMEDIATION_HUMAN_SIGNOFF_FORBIDDEN:%:%',
      NEW.id, v_receipt.obligation_revision
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.owner_id IS DISTINCT FROM v_receipt.tenant_id
     OR NEW.project_id IS DISTINCT FROM v_receipt.project_id THEN
    RAISE EXCEPTION 'COMPLETION_ACK_REMEDIATION_TASK_SCOPE_MISMATCH:%', NEW.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat('completion-ack-remediation-capacity:v1:',
      v_receipt.obligation_revision::text), 0
  ));
  SELECT count(DISTINCT action.task_id_snapshot) INTO v_active_count
    FROM completion_ack_remediation_action action
    JOIN task active_task
      ON active_task.id = action.task_id_snapshot
     AND active_task.owner_id = action.tenant_id
   WHERE action.obligation_revision = v_receipt.obligation_revision
     AND action.project_id = v_receipt.project_id
     AND active_task.status::text IN ('OPEN', 'IN_PROGRESS');
  IF v_active_count >= 16 THEN
    RAISE EXCEPTION 'COMPLETION_ACK_ACTIVE_REMEDIATION_LIMIT:%:16',
      v_receipt.obligation_revision
      USING ERRCODE = 'program_limit_exceeded';
  END IF;
  v_evidence := completion_ack_sanitize_action_evidence(jsonb_build_object(
    'source', 'TASK_INSERT_TRIGGER',
    'taskId', NEW.id::text,
    'taskProjectId', NEW.project_id::text,
    'initialStatus', NEW.status::text
  ));
  v_evidence_digest := outcome_sha256_json(v_evidence);
  v_action_digest := outcome_sha256_json(jsonb_build_array(
    'completion-ack-remediation-action:v1', v_receipt.delivery_receipt_id::text,
    v_receipt.obligation_revision::text, NEW.creator_session_id::text,
    NEW.id::text, 'TASK_CREATED', 'task-created:' || NEW.id::text,
    v_evidence_digest::text
  ));
  INSERT INTO completion_ack_remediation_action (
    action_id, tenant_id, project_id, coordination_id, obligation_id,
    obligation_revision, plan_id, delivery_receipt_id,
    source_session_id_snapshot, action_kind, action_key, task_id_snapshot,
    task_project_id_snapshot, evidence, evidence_digest, action_digest
  ) VALUES (
    completion_ack_uuid_from_digest(v_action_digest::text), v_receipt.tenant_id,
    v_receipt.project_id, v_receipt.coordination_id, v_receipt.obligation_id,
    v_receipt.obligation_revision, v_receipt.plan_id,
    v_receipt.delivery_receipt_id, NEW.creator_session_id, 'TASK_CREATED',
    'task-created:' || NEW.id::text, NEW.id, NEW.project_id,
    v_evidence, v_evidence_digest, v_action_digest
  ) ON CONFLICT (
    obligation_revision, source_session_id_snapshot, task_id_snapshot,
    action_kind, action_key
  ) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER task_completion_ack_remediation_action
  AFTER INSERT ON task
  FOR EACH ROW EXECUTE FUNCTION completion_ack_task_created_action();

CREATE OR REPLACE FUNCTION completion_ack_remediation_task_reactivation_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_scope record;
  v_active_count integer;
  v_in_current_scope boolean := false;
BEGIN
  IF NEW.status::text NOT IN ('OPEN', 'IN_PROGRESS')
     OR OLD.status::text IN ('OPEN', 'IN_PROGRESS') THEN
    RETURN NEW;
  END IF;
  -- One existing task may be deliberately reused by multiple completion-ACK
  -- obligations.  Capacity is a per-revision invariant, so check every scope in
  -- deterministic order rather than letting the first historical action win.
  FOR v_scope IN
    SELECT DISTINCT action.obligation_revision, action.project_id
      FROM completion_ack_remediation_action action
      JOIN completion_ack_current_coordinator_delivery current
        ON current.tenant_id = action.tenant_id
       AND current.project_id = action.project_id
       AND current.coordination_id = action.coordination_id
       AND current.obligation_id = action.obligation_id
       AND current.obligation_revision = action.obligation_revision
       AND current.delivery_receipt_id = action.delivery_receipt_id
     WHERE action.task_id_snapshot = NEW.id
     ORDER BY action.obligation_revision, action.project_id
  LOOP
    v_in_current_scope := true;
    IF v_scope.project_id IS DISTINCT FROM NEW.project_id THEN
      RAISE EXCEPTION 'COMPLETION_ACK_REMEDIATION_TASK_SCOPE_MISMATCH:%', NEW.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(
      concat('completion-ack-remediation-capacity:v1:',
        v_scope.obligation_revision::text), 0
    ));
    SELECT count(DISTINCT action.task_id_snapshot) INTO v_active_count
      FROM completion_ack_remediation_action action
      JOIN task active_task
        ON active_task.id = action.task_id_snapshot
       AND active_task.owner_id = action.tenant_id
     WHERE action.obligation_revision = v_scope.obligation_revision
       AND action.project_id = v_scope.project_id
       AND action.task_id_snapshot <> NEW.id
       AND active_task.status::text IN ('OPEN', 'IN_PROGRESS');
    IF v_active_count >= 16 THEN
      RAISE EXCEPTION 'COMPLETION_ACK_ACTIVE_REMEDIATION_LIMIT:%:16',
        v_scope.obligation_revision
        USING ERRCODE = 'program_limit_exceeded';
    END IF;
  END LOOP;
  IF NEW.completion_criterion::text = 'HUMAN_SIGNOFF' AND v_in_current_scope THEN
    RAISE EXCEPTION 'COMPLETION_ACK_REMEDIATION_HUMAN_SIGNOFF_FORBIDDEN:%', NEW.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER task_completion_ack_remediation_reactivation_guard
  BEFORE UPDATE OF status ON task
  FOR EACH ROW EXECUTE FUNCTION completion_ack_remediation_task_reactivation_guard();

CREATE OR REPLACE FUNCTION completion_ack_record_session_task_action(
  p_tenant_id uuid,
  p_coordinator_session_id uuid,
  p_task_id uuid,
  p_action_kind text,
  p_action_key text,
  p_evidence jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, outcome_watchdog AS $$
DECLARE
  v_receipt completion_ack_coordinator_delivery_receipt%ROWTYPE;
  v_task task%ROWTYPE;
  v_evidence jsonb;
  v_evidence_digest char(64);
  v_action_digest char(64);
  v_action_id uuid;
  v_existing completion_ack_remediation_action%ROWTYPE;
  v_rows bigint;
BEGIN
  IF p_action_kind NOT IN ('TASK_UPDATED', 'TASK_EXECUTE_REQUESTED', 'TASK_COMMENTED')
     OR length(btrim(COALESCE(p_action_key, ''))) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'COMPLETION_ACK_REMEDIATION_ACTION_ARGUMENT_INVALID'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO v_receipt
    FROM completion_ack_coordinator_delivery_receipt receipt
   WHERE receipt.delivery_receipt_id = (
     SELECT current.delivery_receipt_id
       FROM completion_ack_current_coordinator_delivery current
      WHERE current.tenant_id = p_tenant_id
        AND current.session_id = p_coordinator_session_id
   );
  SELECT * INTO v_task FROM task remediation_task
   WHERE remediation_task.id = p_task_id
     AND remediation_task.owner_id = p_tenant_id;
  IF v_receipt.delivery_receipt_id IS NULL OR v_task.id IS NULL
     OR v_task.project_id IS DISTINCT FROM v_receipt.project_id THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'UNBOUND_SCOPE');
  END IF;
  IF v_task.completion_criterion::text = 'HUMAN_SIGNOFF' THEN
    RAISE EXCEPTION 'COMPLETION_ACK_REMEDIATION_HUMAN_SIGNOFF_FORBIDDEN:%:%',
      v_task.id, v_receipt.obligation_revision
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_evidence := completion_ack_sanitize_action_evidence(COALESCE(p_evidence, '{}'::jsonb));
  v_evidence_digest := outcome_sha256_json(v_evidence);
  v_action_digest := outcome_sha256_json(jsonb_build_array(
    'completion-ack-remediation-action:v1', v_receipt.delivery_receipt_id::text,
    v_receipt.obligation_revision::text, p_coordinator_session_id::text,
    p_task_id::text, p_action_kind, btrim(p_action_key), v_evidence_digest::text
  ));
  v_action_id := completion_ack_uuid_from_digest(v_action_digest::text);
  INSERT INTO completion_ack_remediation_action (
    action_id, tenant_id, project_id, coordination_id, obligation_id,
    obligation_revision, plan_id, delivery_receipt_id,
    source_session_id_snapshot, action_kind, action_key, task_id_snapshot,
    task_project_id_snapshot, evidence, evidence_digest, action_digest
  ) VALUES (
    v_action_id, v_receipt.tenant_id, v_receipt.project_id,
    v_receipt.coordination_id, v_receipt.obligation_id,
    v_receipt.obligation_revision, v_receipt.plan_id,
    v_receipt.delivery_receipt_id, p_coordinator_session_id, p_action_kind,
    btrim(p_action_key), p_task_id, v_task.project_id, v_evidence,
    v_evidence_digest, v_action_digest
  ) ON CONFLICT (
    obligation_revision, source_session_id_snapshot, task_id_snapshot,
    action_kind, action_key
  ) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  SELECT * INTO STRICT v_existing
    FROM completion_ack_remediation_action action
   WHERE action.obligation_revision = v_receipt.obligation_revision
     AND action.source_session_id_snapshot = p_coordinator_session_id
     AND action.task_id_snapshot = p_task_id
     AND action.action_kind = p_action_kind
     AND action.action_key = btrim(p_action_key);
  IF v_existing.action_digest IS DISTINCT FROM v_action_digest THEN
    RAISE EXCEPTION 'COMPLETION_ACK_REMEDIATION_ACTION_IDEMPOTENCY_CONFLICT'
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN jsonb_build_object(
    'recorded', true,
    'actionId', v_existing.action_id::text,
    'replayed', v_rows = 0
  );
END;
$$;

CREATE OR REPLACE FUNCTION completion_ack_coordination_state(
  p_tenant_id uuid,
  p_coordination_id uuid
) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_standing outcome_coordinator_obligation%ROWTYPE;
  v_source_active boolean;
  v_source_closed boolean;
  v_latest_plan jsonb;
  v_latest_delivery jsonb;
  v_actions jsonb;
  v_action_total bigint;
  v_active_task_count bigint;
  v_settled_task_count bigint;
BEGIN
  SELECT * INTO v_standing
    FROM outcome_coordinator_obligation standing
   WHERE standing.tenant_id = p_tenant_id
     AND standing.coordination_id = p_coordination_id
     AND standing.source_type = 'COMPLETION_ACK'
     AND standing.capability = 'completion-ack.recover';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'COMPLETION_ACK_COORDINATION_NOT_FOUND'
      USING ERRCODE = 'no_data_found';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM completion_ack_coordinator_source source
     WHERE source.tenant_id = v_standing.tenant_id
       AND source.project_id = v_standing.project_id
       AND source.obligation_id = v_standing.obligation_id
       AND source.obligation_revision = v_standing.obligation_revision
  ) INTO v_source_active;
  SELECT COALESCE((
    SELECT event.state = 'CLOSED'
      FROM completion_ack_obligation_event event
     WHERE event.obligation_id = v_standing.obligation_id
       AND event.obligation_revision = v_standing.obligation_revision
     ORDER BY event.recorded_at DESC, event.ingested_at DESC, event.id DESC
     LIMIT 1
  ), false) INTO v_source_closed;

  -- Null delivery fields are deliberate protocol state: they distinguish the
  -- crash window after a stable plan was written but before Session/wake binding.
  SELECT jsonb_build_object(
           'planId', plan.plan_id::text,
           'targetSessionId', plan.target_session_id::text,
           'subjectVersion', plan.subject_version::text,
           'originLeaseId', plan.origin_lease_id::text,
           'originLeaseGeneration', plan.origin_lease_generation::text,
           'wakeId', wake.id::text,
           'wakeStatus', wake.status,
           'sessionId', coordinator_session.id::text,
           'sessionStatus', coordinator_session.status::text,
           'engineTurnActive', coordinator_session.engine_turn_active,
           'retryAt', coordinator_session.retry_at,
           'recordedAt', plan.recorded_at
         ) INTO v_latest_plan
    FROM completion_ack_coordinator_delivery_plan plan
    LEFT JOIN LATERAL (
      SELECT standing_wake.* FROM project_coordinator_wake standing_wake
       WHERE standing_wake.project_id = plan.project_id
         AND standing_wake.event = 'COMPLETION_ACK_STALE'
         AND standing_wake.subject_type = 'TASK'
         AND standing_wake.subject_id = plan.task_id::text
         AND standing_wake.subject_version = plan.subject_version::text
         AND standing_wake.status <> 'REFUSED'
       ORDER BY standing_wake.created_at DESC, standing_wake.id DESC
       LIMIT 1
    ) wake ON true
    LEFT JOIN session coordinator_session
      ON coordinator_session.id = plan.target_session_id
   WHERE plan.tenant_id = v_standing.tenant_id
     AND plan.coordination_id = v_standing.coordination_id
     AND plan.obligation_revision = v_standing.obligation_revision
   ORDER BY plan.recorded_at DESC, plan.plan_id DESC
   LIMIT 1;

  SELECT jsonb_build_object(
           'deliveryReceiptId', receipt.delivery_receipt_id::text,
           'planId', receipt.plan_id::text,
           'wakeId', receipt.wake_id_snapshot::text,
           'sessionId', receipt.session_id_snapshot::text,
           'sessionStatus', coordinator_session.status::text,
           'engineTurnActive', COALESCE(coordinator_session.engine_turn_active, false),
           'retryAt', coordinator_session.retry_at,
           'sessionDeleted', coordinator_session.id IS NULL,
           'recordedAt', receipt.recorded_at
         ) INTO v_latest_delivery
    FROM completion_ack_coordinator_delivery_receipt receipt
    LEFT JOIN session coordinator_session
      ON coordinator_session.id = receipt.session_id_snapshot
     AND coordinator_session.owner_id = receipt.tenant_id
   WHERE receipt.tenant_id = v_standing.tenant_id
     AND receipt.coordination_id = v_standing.coordination_id
     AND receipt.obligation_revision = v_standing.obligation_revision
   ORDER BY receipt.recorded_at DESC, receipt.delivery_receipt_id DESC
   LIMIT 1;

  SELECT count(*),
         count(DISTINCT action.task_id_snapshot) FILTER (
           WHERE remediation_task.status::text IN ('OPEN', 'IN_PROGRESS')
         ),
         count(DISTINCT action.task_id_snapshot) FILTER (
           WHERE remediation_task.status::text IN ('DONE', 'FAILED', 'CANCELLED')
         )
    INTO v_action_total, v_active_task_count, v_settled_task_count
    FROM completion_ack_remediation_action action
    LEFT JOIN task remediation_task
      ON remediation_task.id = action.task_id_snapshot
     AND remediation_task.owner_id = action.tenant_id
   WHERE action.tenant_id = v_standing.tenant_id
     AND action.coordination_id = v_standing.coordination_id
     AND action.obligation_revision = v_standing.obligation_revision;

  SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'actionId', bounded.action_id::text,
           'actionKind', bounded.action_kind,
           'actionKey', bounded.action_key,
           'taskId', bounded.task_id_snapshot::text,
           'taskProjectId', bounded.task_project_id_snapshot::text,
           'taskStatus', bounded.task_status,
           'taskDeleted', bounded.task_status IS NULL,
           'evidenceDigest', bounded.evidence_digest::text,
           'recordedAt', bounded.recorded_at
         )) ORDER BY bounded.recorded_at, bounded.action_id), '[]'::jsonb)
    INTO v_actions
    FROM (
      SELECT action.*,
             remediation_task.status::text AS task_status
        FROM completion_ack_remediation_action action
        LEFT JOIN task remediation_task
          ON remediation_task.id = action.task_id_snapshot
         AND remediation_task.owner_id = action.tenant_id
       WHERE action.tenant_id = v_standing.tenant_id
         AND action.coordination_id = v_standing.coordination_id
         AND action.obligation_revision = v_standing.obligation_revision
       ORDER BY action.recorded_at DESC, action.action_id DESC
       LIMIT 16
    ) bounded;

  RETURN jsonb_build_object(
    'coordinationId', v_standing.coordination_id::text,
    'obligationId', v_standing.obligation_id::text,
    'obligationRevision', v_standing.obligation_revision::text,
    'sourceActive', v_source_active,
    'sourceClosed', v_source_closed,
    'latestPlan', v_latest_plan,
    'latestDelivery', v_latest_delivery,
    'remediationActions', v_actions,
    'remediationActionsTruncated', v_action_total > 16,
    'totalRemediationActionCount', v_action_total,
    'activeTaskCount', v_active_task_count,
    'settledTaskCount', v_settled_task_count
  );
END;
$$;

-- Keep the 0198 implementation byte-for-byte available for its two original source classes.
ALTER FUNCTION outcome_register_coordinator_obligation(
  uuid, uuid, text, text, jsonb, bigint, integer, integer, integer, integer
) RENAME TO outcome_register_coordinator_obligation_0198;

CREATE OR REPLACE FUNCTION outcome_register_coordinator_obligation(
  p_tenant_id uuid,
  p_project_id uuid,
  p_source_type text,
  p_source_key text,
  p_source_obligation jsonb,
  p_liveness_delta bigint,
  p_attempt_budget integer,
  p_wake_budget integer,
  p_same_failure_fingerprint_limit integer,
  p_max_lease_renewals integer DEFAULT 1
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_expected_source jsonb;
  v_standing outcome_coordinator_obligation%ROWTYPE;
  v_now bigint;
  v_coordination_id uuid;
  v_source_digest text;
  v_coordination_revision text;
  v_wake jsonb;
BEGIN
  IF p_source_type IN ('CANONICAL', 'EXECUTOR') THEN
    RETURN outcome_register_coordinator_obligation_0198(
      p_tenant_id, p_project_id, p_source_type, p_source_key,
      p_source_obligation, p_liveness_delta, p_attempt_budget, p_wake_budget,
      p_same_failure_fingerprint_limit, p_max_lease_renewals
    );
  END IF;
  IF p_source_type <> 'COMPLETION_ACK'
     OR btrim(COALESCE(p_source_key, '')) = ''
     OR jsonb_typeof(p_source_obligation) <> 'object'
     OR p_liveness_delta <= 0 OR p_attempt_budget <= 0 OR p_wake_budget <= 0
     OR p_same_failure_fingerprint_limit <= 0
     OR p_same_failure_fingerprint_limit > p_attempt_budget
     OR p_max_lease_renewals < 0 THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_OBLIGATION_INVALID'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The active adapter, rather than caller input, proves tenant/project enrollment.  Production
  -- had no 0194 stream rows before this bridge, so requiring prior enrollment would silently make
  -- every completion obligation undispatchable.
  SELECT source.obligation INTO v_expected_source
    FROM completion_ack_coordinator_source source
   WHERE source.tenant_id = p_tenant_id
     AND source.project_id = p_project_id
     AND source.source_key = p_source_key;
  IF NOT FOUND OR p_source_obligation IS DISTINCT FROM v_expected_source THEN
    RAISE EXCEPTION 'COMPLETION_ACK_COORDINATOR_SOURCE_NOT_CANONICAL'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  INSERT INTO outcome_fact_stream(tenant_id, project_id)
  SELECT project.owner_id, project.id
    FROM project
   WHERE project.id = p_project_id AND project.owner_id = p_tenant_id
  ON CONFLICT (tenant_id, project_id) DO NOTHING;
  PERFORM 1 FROM outcome_fact_stream stream
   WHERE stream.tenant_id = p_tenant_id AND stream.project_id = p_project_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_STREAM_NOT_FOUND'
      USING ERRCODE = 'no_data_found';
  END IF;

  v_now := outcome_coordinator_now(p_tenant_id);
  v_source_digest := outcome_sha256_json(p_source_obligation);
  v_coordination_revision := outcome_sha256_json(jsonb_build_object(
    'namespace', 'orbit.outcome-coordinator.revision.v2',
    'tenantId', p_tenant_id::text,
    'projectId', p_project_id::text,
    'sourceType', p_source_type,
    'sourceKey', p_source_key,
    'obligationRevision', p_source_obligation->>'obligationRevision',
    'bindingDigest', p_source_obligation->>'bindingDigest',
    'livenessDelta', p_liveness_delta::text,
    'attemptBudget', p_attempt_budget,
    'wakeBudget', p_wake_budget,
    'sameFailureFingerprintLimit', p_same_failure_fingerprint_limit,
    'maxLeaseRenewals', p_max_lease_renewals
  ));
  INSERT INTO outcome_coordinator_obligation_revision (
    tenant_id, project_id, coordination_revision, source_type, source_key,
    obligation_id, obligation_revision, binding_digest, kind, requested_owner,
    capability, liveness_delta, attempt_budget, wake_budget,
    same_failure_fingerprint_limit, max_lease_renewals, source_obligation,
    source_digest, created_logical_time
  ) VALUES (
    p_tenant_id, p_project_id, v_coordination_revision, 'COMPLETION_ACK', p_source_key,
    p_source_obligation->>'obligationId', p_source_obligation->>'obligationRevision',
    p_source_obligation->>'bindingDigest', 'COMPLETION_ACK_STALE',
    'PROJECT_COORDINATOR', 'completion-ack.recover', p_liveness_delta,
    p_attempt_budget, p_wake_budget, p_same_failure_fingerprint_limit,
    p_max_lease_renewals, p_source_obligation, v_source_digest, v_now
  ) ON CONFLICT (tenant_id, project_id, coordination_revision) DO NOTHING;

  SELECT * INTO v_standing
    FROM outcome_coordinator_obligation standing
   WHERE standing.tenant_id = p_tenant_id
     AND standing.project_id = p_project_id
     AND standing.source_type = 'COMPLETION_ACK'
     AND standing.source_key = p_source_key
   FOR UPDATE;
  IF FOUND AND v_standing.coordination_revision::text = v_coordination_revision THEN
    IF v_standing.source_digest::text <> v_source_digest
       OR v_standing.source_obligation IS DISTINCT FROM p_source_obligation
       OR v_standing.requested_owner <> 'PROJECT_COORDINATOR'
       OR v_standing.durable_owner <> 'AGENT'
       OR v_standing.capability <> 'completion-ack.recover' THEN
      RAISE EXCEPTION 'COMPLETION_ACK_COORDINATOR_REVISION_COLLISION'
        USING ERRCODE = 'unique_violation';
    END IF;
    RETURN jsonb_build_object(
      'coordinationId', v_standing.coordination_id::text,
      'coordinationRevision', v_standing.coordination_revision::text,
      'status', v_standing.status,
      'durableOwner', v_standing.durable_owner,
      'replayed', true
    );
  END IF;

  IF FOUND THEN
    PERFORM outcome_append_coordinator_event(
      v_standing.coordination_id,
      'revision-superseded:' || v_standing.coordination_revision::text,
      'OBLIGATION_REVISION_SUPERSEDED', v_standing.status, 'SUPERSEDED',
      'SUPERSEDE', v_now, NULL,
      jsonb_build_object('successorRevision', v_coordination_revision)
    );
    UPDATE outcome_coordinator_wake SET state = 'CANCELLED', updated_at = clock_timestamp()
     WHERE coordination_id = v_standing.coordination_id AND state = 'SCHEDULED';
    UPDATE outcome_coordinator_external_wait SET state = 'SUPERSEDED', updated_at = clock_timestamp()
     WHERE coordination_id = v_standing.coordination_id AND state = 'ACTIVE';
    v_coordination_id := v_standing.coordination_id;
    UPDATE outcome_coordinator_obligation
       SET coordination_revision = v_coordination_revision,
           obligation_id = p_source_obligation->>'obligationId',
           obligation_revision = p_source_obligation->>'obligationRevision',
           binding_digest = p_source_obligation->>'bindingDigest',
           kind = 'COMPLETION_ACK_STALE', capability = 'completion-ack.recover',
           requested_owner = 'PROJECT_COORDINATOR', durable_owner = 'AGENT',
           status = 'READY', diagnostic_path = 'PRIMARY_RECOVERY',
           attempt_budget_max = p_attempt_budget,
           attempt_budget_remaining = p_attempt_budget,
           wake_budget_max = p_wake_budget, wake_budget_remaining = p_wake_budget,
           same_failure_fingerprint_limit = p_same_failure_fingerprint_limit,
           max_lease_renewals = p_max_lease_renewals,
           attempt_count = 0, lease_generation = lease_generation + 1,
           lease_renewal_count = 0, wake_generation = wake_generation + 1,
           liveness_delta = p_liveness_delta,
           last_progress_logical_time = v_now,
           progress_deadline_logical_time = v_now + p_liveness_delta,
           next_wake_logical_time = NULL,
           lease_id = NULL, lease_token = NULL, lease_owner = NULL,
           lease_expires_logical_time = NULL, action_intent_id = NULL,
           decision_request_id = NULL, external_wait_id = NULL, terminal_reason = NULL,
           source_obligation = p_source_obligation, source_digest = v_source_digest,
           updated_at = clock_timestamp()
     WHERE coordination_id = v_coordination_id;
  ELSE
    v_coordination_id := gen_random_uuid();
    INSERT INTO outcome_coordinator_obligation (
      coordination_id, tenant_id, project_id, coordination_revision,
      source_type, source_key, obligation_id, obligation_revision, binding_digest,
      kind, capability, requested_owner, durable_owner, status, diagnostic_path,
      attempt_budget_max, attempt_budget_remaining, wake_budget_max,
      wake_budget_remaining, same_failure_fingerprint_limit, max_lease_renewals,
      liveness_delta, last_progress_logical_time, progress_deadline_logical_time,
      source_obligation, source_digest
    ) VALUES (
      v_coordination_id, p_tenant_id, p_project_id, v_coordination_revision,
      'COMPLETION_ACK', p_source_key, p_source_obligation->>'obligationId',
      p_source_obligation->>'obligationRevision', p_source_obligation->>'bindingDigest',
      'COMPLETION_ACK_STALE', 'completion-ack.recover', 'PROJECT_COORDINATOR',
      'AGENT', 'READY', 'PRIMARY_RECOVERY', p_attempt_budget, p_attempt_budget,
      p_wake_budget, p_wake_budget, p_same_failure_fingerprint_limit,
      p_max_lease_renewals, p_liveness_delta, v_now, v_now + p_liveness_delta,
      p_source_obligation, v_source_digest
    );
  END IF;
  PERFORM outcome_append_coordinator_event(
    v_coordination_id, 'ownership:' || v_coordination_revision,
    'DURABLE_OWNERSHIP_ASSIGNED', NULL, 'READY', NULL, v_now, NULL,
    jsonb_build_object(
      'requestedOwner', 'PROJECT_COORDINATOR',
      'durableOwner', 'AGENT',
      'ownerDecisionRequiresValidatedRequest', false
    )
  );
  v_wake := outcome_schedule_coordinator_wake(
    v_coordination_id, v_now, 'OBLIGATION_ACTIVATED', 'SCHEDULED'
  );
  SELECT * INTO STRICT v_standing FROM outcome_coordinator_obligation
   WHERE coordination_id = v_coordination_id;
  RETURN jsonb_build_object(
    'coordinationId', v_coordination_id::text,
    'coordinationRevision', v_coordination_revision,
    'status', v_standing.status,
    'durableOwner', v_standing.durable_owner,
    'wake', v_wake,
    'replayed', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION completion_ack_reconcile_coordinator(
  p_tenant_id uuid,
  p_liveness_delta bigint,
  p_attempt_budget integer,
  p_wake_budget integer,
  p_same_failure_fingerprint_limit integer,
  p_max_lease_renewals integer DEFAULT 1
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_source record;
  v_standing outcome_coordinator_obligation%ROWTYPE;
  v_receipt jsonb;
  v_now bigint;
  v_registered integer := 0;
  v_replayed integer := 0;
  v_resolved integer := 0;
BEGIN
  v_now := outcome_coordinator_now(p_tenant_id);
  FOR v_source IN
    SELECT source.* FROM completion_ack_coordinator_source source
     WHERE source.tenant_id = p_tenant_id
     ORDER BY source.project_id, source.source_key
  LOOP
    v_receipt := outcome_register_coordinator_obligation(
      p_tenant_id, v_source.project_id, 'COMPLETION_ACK', v_source.source_key,
      v_source.obligation, p_liveness_delta, p_attempt_budget, p_wake_budget,
      p_same_failure_fingerprint_limit, p_max_lease_renewals
    );
    v_registered := v_registered + 1;
    IF COALESCE((v_receipt->>'replayed')::boolean, false) THEN
      v_replayed := v_replayed + 1;
    END IF;
  END LOOP;

  FOR v_standing IN
    SELECT standing.*
      FROM outcome_coordinator_obligation standing
     WHERE standing.tenant_id = p_tenant_id
       AND standing.source_type = 'COMPLETION_ACK'
       AND standing.status IN (
         'READY', 'CLAIMED', 'SCHEDULED', 'EXTERNAL_WAIT', 'OWNER_DECISION'
       )
       AND NOT EXISTS (
         SELECT 1 FROM completion_ack_coordinator_source source
          WHERE source.tenant_id = standing.tenant_id
            AND source.project_id = standing.project_id
            AND source.obligation_id = standing.obligation_id
            AND source.obligation_revision = standing.obligation_revision
       )
       AND COALESCE((
         SELECT event.state = 'CLOSED'
           FROM completion_ack_obligation_event event
          WHERE event.obligation_id = standing.obligation_id
            AND event.obligation_revision = standing.obligation_revision
          ORDER BY event.recorded_at DESC, event.ingested_at DESC, event.id DESC
          LIMIT 1
       ), false)
     ORDER BY standing.project_id, standing.queue_sequence
     FOR UPDATE
  LOOP
    PERFORM outcome_terminalize_coordination(
      v_standing.coordination_id, 'RESOLVED',
      'COMPLETION_ACK_CANONICAL_SOURCE_CLOSED', 'TERMINAL_DISPOSITION', v_now,
      jsonb_build_object(
        'sourceType', 'COMPLETION_ACK',
        'obligationId', v_standing.obligation_id::text,
        'obligationRevision', v_standing.obligation_revision::text,
        'authority', 'COMPLETION_ACK_CANONICAL_CLOSED_EVENT'
      )
    );
    v_resolved := v_resolved + 1;
  END LOOP;
  RETURN jsonb_build_object(
    'logicalNow', v_now::text,
    'registered', v_registered,
    'replayed', v_replayed,
    'resolved', v_resolved,
    'superseded', 0
  );
END;
$$;

-- Compatibility wrapper: existing callers keep reconciling standard sources unchanged, while a
-- mixed-version caller also registers completion ACK.  The production completion worker uses the
-- source-only function above and never consumes an unregistered resolver class.
ALTER FUNCTION outcome_reconcile_active_obligations(
  uuid, bigint, integer, integer, integer, integer
) RENAME TO outcome_reconcile_active_obligations_0198;

CREATE OR REPLACE FUNCTION outcome_reconcile_active_obligations(
  p_tenant_id uuid,
  p_liveness_delta bigint,
  p_attempt_budget integer,
  p_wake_budget integer,
  p_same_failure_fingerprint_limit integer,
  p_max_lease_renewals integer DEFAULT 1
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_standard jsonb;
  v_completion jsonb;
BEGIN
  v_standard := outcome_reconcile_active_obligations_0198(
    p_tenant_id, p_liveness_delta, p_attempt_budget, p_wake_budget,
    p_same_failure_fingerprint_limit, p_max_lease_renewals
  );
  v_completion := completion_ack_reconcile_coordinator(
    p_tenant_id, p_liveness_delta, p_attempt_budget, p_wake_budget,
    p_same_failure_fingerprint_limit, p_max_lease_renewals
  );
  RETURN v_standard || jsonb_build_object(
    'completionAck', v_completion,
    'registered', COALESCE((v_standard->>'registered')::integer, 0)
      + COALESCE((v_completion->>'registered')::integer, 0),
    'replayed', COALESCE((v_standard->>'replayed')::integer, 0)
      + COALESCE((v_completion->>'replayed')::integer, 0),
    'resolved', COALESCE((v_completion->>'resolved')::integer, 0)
  );
END;
$$;

CREATE OR REPLACE FUNCTION completion_ack_schedule_coordinator_wake(
  p_coordination_id uuid,
  p_due_logical_time bigint,
  p_reason_code text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_standing outcome_coordinator_obligation%ROWTYPE;
  v_clock outcome_coordinator_clock%ROWTYPE;
  v_now bigint;
  v_generation bigint;
  v_wake_id uuid;
  v_remaining integer;
  v_rearmed boolean;
BEGIN
  IF btrim(COALESCE(p_reason_code, '')) = '' THEN
    RAISE EXCEPTION 'COMPLETION_ACK_COORDINATOR_WAKE_INVALID'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO v_standing FROM outcome_coordinator_obligation standing
   WHERE standing.coordination_id = p_coordination_id FOR UPDATE;
  IF NOT FOUND OR v_standing.source_type <> 'COMPLETION_ACK'
     OR v_standing.capability <> 'completion-ack.recover' THEN
    RAISE EXCEPTION 'COMPLETION_ACK_COORDINATION_NOT_FOUND'
      USING ERRCODE = 'no_data_found';
  END IF;
  v_now := outcome_coordinator_now(v_standing.tenant_id);
  SELECT * INTO STRICT v_clock FROM outcome_coordinator_clock clock
   WHERE clock.tenant_id = v_standing.tenant_id;
  IF p_due_logical_time < v_now
     OR p_due_logical_time > v_now + v_standing.liveness_delta THEN
    RAISE EXCEPTION 'COMPLETION_ACK_COORDINATOR_WAKE_OUTSIDE_LIVENESS_BOUND'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_standing.status IN ('RESOLVED', 'SUPERSEDED', 'ESCALATED', 'TERMINAL') THEN
    RETURN jsonb_build_object(
      'coordinationId', v_standing.coordination_id::text,
      'status', v_standing.status, 'scheduled', false,
      'reasonCode', 'TERMINAL_COORDINATION'
    );
  END IF;
  UPDATE outcome_coordinator_wake SET state = 'CANCELLED', updated_at = clock_timestamp()
   WHERE coordination_id = v_standing.coordination_id AND state = 'SCHEDULED';
  v_generation := v_standing.wake_generation + 1;
  v_wake_id := gen_random_uuid();
  v_rearmed := v_standing.wake_budget_remaining <= 0;
  v_remaining := CASE WHEN v_rearmed
    THEN greatest(v_standing.wake_budget_max - 1, 0)
    ELSE v_standing.wake_budget_remaining - 1 END;
  INSERT INTO outcome_coordinator_wake (
    wake_id, tenant_id, project_id, coordination_id, obligation_revision,
    generation, clock_id, due_logical_time, reason_code, state
  ) VALUES (
    v_wake_id, v_standing.tenant_id, v_standing.project_id,
    v_standing.coordination_id, v_standing.obligation_revision,
    v_generation, v_clock.clock_id, p_due_logical_time, p_reason_code, 'SCHEDULED'
  );
  UPDATE outcome_coordinator_obligation
     SET status = 'SCHEDULED', durable_owner = 'AGENT',
         wake_generation = v_generation,
         wake_budget_remaining = v_remaining,
         next_wake_logical_time = p_due_logical_time,
         lease_id = NULL, lease_token = NULL, lease_owner = NULL,
         lease_expires_logical_time = NULL, external_wait_id = NULL,
         diagnostic_path = CASE WHEN v_rearmed
           THEN 'PERSISTENT_AGENT_RECOVERY' ELSE diagnostic_path END,
         updated_at = clock_timestamp()
   WHERE coordination_id = v_standing.coordination_id;
  PERFORM outcome_append_coordinator_event(
    v_standing.coordination_id,
    'completion-wake-scheduled:' || v_generation::text,
    'COMPLETION_ACK_WAKE_SCHEDULED', v_standing.status, 'SCHEDULED',
    NULL, v_now, NULL,
    jsonb_build_object(
      'wakeId', v_wake_id::text,
      'dueLogicalTime', p_due_logical_time::text,
      'reasonCode', p_reason_code,
      'wakeBudgetRemaining', v_remaining,
      'budgetWindowRearmed', v_rearmed,
      'terminalDisposition', false
    )
  );
  RETURN jsonb_build_object(
    'coordinationId', v_standing.coordination_id::text,
    'wakeId', v_wake_id::text,
    'generation', v_generation::text,
    'dueLogicalTime', p_due_logical_time::text,
    'status', 'SCHEDULED', 'scheduled', true,
    'wakeBudgetRemaining', v_remaining,
    'budgetWindowRearmed', v_rearmed
  );
END;
$$;

CREATE OR REPLACE FUNCTION completion_ack_sweep_coordinator(
  p_tenant_id uuid
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_standing outcome_coordinator_obligation%ROWTYPE;
  v_wake outcome_coordinator_wake%ROWTYPE;
  v_now bigint;
  v_receipt jsonb;
  v_rebuilt integer := 0;
  v_delivered integer := 0;
  v_expired integer := 0;
  v_rearmed integer := 0;
BEGIN
  v_now := outcome_coordinator_now(p_tenant_id);
  FOR v_standing IN
    SELECT standing.* FROM outcome_coordinator_obligation standing
     WHERE standing.tenant_id = p_tenant_id
       AND standing.source_type = 'COMPLETION_ACK'
       AND standing.capability = 'completion-ack.recover'
       AND standing.status IN ('SCHEDULED', 'EXTERNAL_WAIT')
       AND standing.next_wake_logical_time <= v_now
       AND NOT EXISTS (
         SELECT 1 FROM outcome_coordinator_wake wake
          WHERE wake.coordination_id = standing.coordination_id
            AND wake.generation = standing.wake_generation
            AND wake.state = 'SCHEDULED'
       )
     ORDER BY standing.project_id, standing.queue_sequence
     FOR UPDATE
  LOOP
    v_receipt := completion_ack_schedule_coordinator_wake(
      v_standing.coordination_id, v_now, 'RECOVER_LOST_COMPLETION_ACK_WAKE'
    );
    IF COALESCE((v_receipt->>'scheduled')::boolean, false) THEN
      v_rebuilt := v_rebuilt + 1;
    END IF;
  END LOOP;

  FOR v_wake IN
    SELECT wake.* FROM outcome_coordinator_wake wake
    JOIN outcome_coordinator_obligation standing
      ON standing.coordination_id = wake.coordination_id
     AND standing.source_type = 'COMPLETION_ACK'
     AND standing.capability = 'completion-ack.recover'
   WHERE wake.tenant_id = p_tenant_id AND wake.state = 'SCHEDULED'
     AND wake.due_logical_time <= v_now
   ORDER BY wake.due_logical_time, wake.project_id, wake.wake_id
   FOR UPDATE OF wake
  LOOP
    v_receipt := outcome_deliver_coordinator_wake(
      p_tenant_id, v_wake.wake_id,
      'completion-sweep:' || v_wake.wake_id::text || ':' || v_wake.generation::text
    );
    IF v_receipt->>'outcome' = 'DELIVERED' THEN v_delivered := v_delivered + 1; END IF;
  END LOOP;

  FOR v_standing IN
    SELECT standing.* FROM outcome_coordinator_obligation standing
     WHERE standing.tenant_id = p_tenant_id
       AND standing.source_type = 'COMPLETION_ACK'
       AND standing.capability = 'completion-ack.recover'
       AND standing.status = 'CLAIMED'
       AND (standing.lease_expires_logical_time <= v_now
         OR standing.progress_deadline_logical_time <= v_now)
     ORDER BY standing.project_id, standing.queue_sequence
     FOR UPDATE
  LOOP
    PERFORM outcome_append_coordinator_event(
      v_standing.coordination_id,
      'completion-lease-expired:' || v_standing.lease_generation::text,
      'COMPLETION_ACK_LEASE_EXPIRED', 'CLAIMED', 'SCHEDULED', NULL,
      v_now, NULL,
      jsonb_build_object(
        'leaseId', v_standing.lease_id::text,
        'leaseGeneration', v_standing.lease_generation::text,
        'workerId', v_standing.lease_owner,
        'terminalDisposition', false
      )
    );
    PERFORM completion_ack_schedule_coordinator_wake(
      v_standing.coordination_id, v_now, 'COMPLETION_ACK_LEASE_RETRY'
    );
    v_expired := v_expired + 1;
  END LOOP;

  FOR v_standing IN
    SELECT standing.* FROM outcome_coordinator_obligation standing
     WHERE standing.tenant_id = p_tenant_id
       AND standing.source_type = 'COMPLETION_ACK'
       AND standing.capability = 'completion-ack.recover'
       AND standing.status = 'READY'
       AND standing.progress_deadline_logical_time <= v_now
     ORDER BY standing.project_id, standing.queue_sequence
     FOR UPDATE
  LOOP
    PERFORM completion_ack_schedule_coordinator_wake(
      v_standing.coordination_id, v_now, 'COMPLETION_ACK_LIVENESS_RETRY'
    );
    v_rearmed := v_rearmed + 1;
  END LOOP;
  RETURN jsonb_build_object(
    'logicalNow', v_now::text,
    'wakesRebuilt', v_rebuilt,
    'wakesDelivered', v_delivered,
    'leasesExpired', v_expired,
    'livenessRearmed', v_rearmed,
    'escalated', 0
  );
END;
$$;

CREATE OR REPLACE FUNCTION completion_ack_claim_next_coordination(
  p_tenant_id uuid,
  p_worker_id text,
  p_lease_logical_ticks bigint
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_standing outcome_coordinator_obligation%ROWTYPE;
  v_scheduler outcome_coordinator_scheduler%ROWTYPE;
  v_lease_id uuid;
  v_token uuid;
  v_generation bigint;
  v_attempt integer;
  v_dispatch bigint;
  v_expiry bigint;
  v_now bigint;
  v_remaining integer;
  v_rearmed boolean;
BEGIN
  IF btrim(COALESCE(p_worker_id, '')) = '' OR p_lease_logical_ticks <= 0 THEN
    RAISE EXCEPTION 'COMPLETION_ACK_COORDINATOR_CLAIM_INVALID'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_now := outcome_coordinator_now(p_tenant_id);
  PERFORM completion_ack_sweep_coordinator(p_tenant_id);
  INSERT INTO outcome_coordinator_scheduler(tenant_id) VALUES (p_tenant_id)
  ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT v_scheduler FROM outcome_coordinator_scheduler scheduler
   WHERE scheduler.tenant_id = p_tenant_id FOR UPDATE;
  SELECT candidate.* INTO v_standing
    FROM (
      SELECT DISTINCT ON (standing.project_id) standing.*
        FROM outcome_coordinator_obligation standing
       WHERE standing.tenant_id = p_tenant_id
         AND standing.source_type = 'COMPLETION_ACK'
         AND standing.capability = 'completion-ack.recover'
         AND standing.status = 'READY'
       ORDER BY standing.project_id, standing.queue_sequence, standing.coordination_id
    ) candidate
    LEFT JOIN outcome_coordinator_project_fairness fairness
      ON fairness.tenant_id = candidate.tenant_id
     AND fairness.project_id = candidate.project_id
   ORDER BY fairness.last_dispatched_sequence ASC NULLS FIRST,
            candidate.project_id, candidate.queue_sequence, candidate.coordination_id
   LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO v_standing FROM outcome_coordinator_obligation standing
   WHERE standing.coordination_id = v_standing.coordination_id FOR UPDATE;
  IF v_standing.status <> 'READY' OR v_standing.source_type <> 'COMPLETION_ACK' THEN
    RETURN NULL;
  END IF;
  IF p_lease_logical_ticks > v_standing.liveness_delta THEN
    RAISE EXCEPTION 'COMPLETION_ACK_COORDINATOR_LEASE_OUTSIDE_LIVENESS_BOUND'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_dispatch := v_scheduler.dispatch_sequence + 1;
  UPDATE outcome_coordinator_scheduler SET dispatch_sequence = v_dispatch
   WHERE tenant_id = p_tenant_id;
  INSERT INTO outcome_coordinator_project_fairness(
    tenant_id, project_id, last_dispatched_sequence, dispatch_count
  ) VALUES (p_tenant_id, v_standing.project_id, v_dispatch, 1)
  ON CONFLICT (tenant_id, project_id) DO UPDATE SET
    last_dispatched_sequence = EXCLUDED.last_dispatched_sequence,
    dispatch_count = outcome_coordinator_project_fairness.dispatch_count + 1,
    updated_at = clock_timestamp();

  v_lease_id := gen_random_uuid();
  v_token := gen_random_uuid();
  v_generation := v_standing.lease_generation + 1;
  v_attempt := v_standing.attempt_count + 1;
  v_expiry := v_now + p_lease_logical_ticks;
  v_rearmed := v_standing.attempt_budget_remaining <= 0;
  v_remaining := CASE WHEN v_rearmed
    THEN greatest(v_standing.attempt_budget_max - 1, 0)
    ELSE v_standing.attempt_budget_remaining - 1 END;
  UPDATE outcome_coordinator_obligation
     SET status = 'CLAIMED', durable_owner = 'AGENT',
         attempt_count = v_attempt, attempt_budget_remaining = v_remaining,
         lease_generation = v_generation, lease_renewal_count = 0,
         lease_id = v_lease_id, lease_token = v_token, lease_owner = p_worker_id,
         lease_expires_logical_time = v_expiry, next_wake_logical_time = NULL,
         last_progress_logical_time = v_now,
         progress_deadline_logical_time = v_now + liveness_delta,
         diagnostic_path = CASE WHEN v_rearmed
           THEN 'PERSISTENT_AGENT_RECOVERY' ELSE diagnostic_path END,
         updated_at = clock_timestamp()
   WHERE coordination_id = v_standing.coordination_id;
  INSERT INTO outcome_coordinator_lease(
    lease_id, tenant_id, project_id, coordination_id, obligation_revision,
    generation, attempt_number, worker_id, lease_token,
    claimed_logical_time, expires_logical_time
  ) VALUES (
    v_lease_id, v_standing.tenant_id, v_standing.project_id,
    v_standing.coordination_id, v_standing.obligation_revision, v_generation,
    v_attempt, p_worker_id, v_token, v_now, v_expiry
  );
  PERFORM outcome_append_coordinator_event(
    v_standing.coordination_id, 'claim:' || v_generation::text,
    'VALID_ATTEMPT_STARTED', 'READY', 'CLAIMED', 'VALID_ATTEMPT',
    v_now, NULL,
    jsonb_build_object(
      'leaseId', v_lease_id::text, 'workerId', p_worker_id,
      'attemptNumber', v_attempt, 'attemptBudgetRemaining', v_remaining,
      'dispatchSequence', v_dispatch::text,
      'budgetWindowRearmed', v_rearmed, 'terminalDisposition', false
    )
  );
  RETURN jsonb_build_object(
    'coordinationId', v_standing.coordination_id::text,
    'tenantId', v_standing.tenant_id::text,
    'projectId', v_standing.project_id::text,
    'obligationId', v_standing.obligation_id::text,
    'obligationRevision', v_standing.obligation_revision::text,
    'capability', v_standing.capability,
    'attemptNumber', v_attempt,
    'attemptBudgetRemaining', v_remaining,
    'diagnosticPath', CASE WHEN v_rearmed
      THEN 'PERSISTENT_AGENT_RECOVERY' ELSE v_standing.diagnostic_path END,
    'leaseId', v_lease_id::text,
    'leaseToken', v_token::text,
    'leaseExpiresLogicalTime', v_expiry::text,
    'sourceObligation', v_standing.source_obligation
  );
END;
$$;

ALTER TABLE outcome_coordinator_attempt_result
  ADD COLUMN completion_delivery_receipt_id uuid;
ALTER TABLE outcome_coordinator_attempt_result
  ADD CONSTRAINT outcome_coordinator_attempt_completion_receipt_fk
  FOREIGN KEY (completion_delivery_receipt_id)
  REFERENCES completion_ack_coordinator_delivery_receipt(delivery_receipt_id)
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION completion_ack_coordination_terminal_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_closed boolean;
BEGIN
  IF OLD.source_type <> 'COMPLETION_ACK' THEN RETURN NEW; END IF;
  IF NEW.source_type IS DISTINCT FROM OLD.source_type
     OR NEW.obligation_id IS DISTINCT FROM OLD.obligation_id
     OR NEW.obligation_revision IS DISTINCT FROM OLD.obligation_revision
     OR NEW.requested_owner <> 'PROJECT_COORDINATOR'
     OR NEW.durable_owner <> 'AGENT'
     OR NEW.capability <> 'completion-ack.recover' THEN
    RAISE EXCEPTION 'COMPLETION_ACK_COORDINATION_SCOPE_IMMUTABLE:%', OLD.coordination_id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW.status IN ('SUPERSEDED', 'ESCALATED', 'TERMINAL')
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    RAISE EXCEPTION 'COMPLETION_ACK_NONCANONICAL_TERMINAL_FORBIDDEN:%:%',
      OLD.coordination_id, NEW.status
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW.status = 'RESOLVED' AND OLD.status IS DISTINCT FROM NEW.status THEN
    SELECT COALESCE((
      SELECT event.state = 'CLOSED'
        FROM completion_ack_obligation_event event
       WHERE event.obligation_id = OLD.obligation_id
         AND event.obligation_revision = OLD.obligation_revision
       ORDER BY event.recorded_at DESC, event.ingested_at DESC, event.id DESC
       LIMIT 1
    ), false) INTO v_closed;
    IF NOT v_closed THEN
      RAISE EXCEPTION 'COMPLETION_ACK_CANONICAL_CLOSED_REQUIRED:%', OLD.coordination_id
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER outcome_coordinator_completion_terminal_guard
  BEFORE UPDATE OF source_type, obligation_id, obligation_revision,
    requested_owner, durable_owner, capability, status
  ON outcome_coordinator_obligation
  FOR EACH ROW EXECUTE FUNCTION completion_ack_coordination_terminal_guard();

CREATE OR REPLACE FUNCTION completion_ack_attempt_result_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_standing outcome_coordinator_obligation%ROWTYPE;
  v_receipt_id uuid;
  v_closed boolean;
BEGIN
  SELECT * INTO v_standing FROM outcome_coordinator_obligation standing
   WHERE standing.coordination_id = NEW.coordination_id FOR KEY SHARE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF v_standing.source_type <> 'COMPLETION_ACK' THEN
    IF NEW.completion_delivery_receipt_id IS NOT NULL THEN
      RAISE EXCEPTION 'COMPLETION_ACK_RECEIPT_ON_STANDARD_RESULT_FORBIDDEN'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM v_standing.tenant_id
     OR NEW.project_id IS DISTINCT FROM v_standing.project_id
     OR NEW.obligation_revision IS DISTINCT FROM v_standing.obligation_revision THEN
    RAISE EXCEPTION 'COMPLETION_ACK_ATTEMPT_RESULT_SCOPE_INVALID'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.result = 'DELIVERED' THEN
    BEGIN
      v_receipt_id := (NEW.detail->>'deliveryReceiptId')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'COMPLETION_ACK_DELIVERY_RECEIPT_REQUIRED'
        USING ERRCODE = 'invalid_parameter_value';
    END;
    IF v_receipt_id IS NULL OR NOT EXISTS (
      SELECT 1
        FROM completion_ack_coordinator_delivery_receipt receipt
        JOIN completion_ack_coordinator_delivery_adoption adoption
          ON adoption.delivery_receipt_id = receipt.delivery_receipt_id
         AND adoption.plan_id = receipt.plan_id
       WHERE receipt.delivery_receipt_id = v_receipt_id
         AND receipt.tenant_id = NEW.tenant_id
         AND receipt.project_id = NEW.project_id
         AND receipt.coordination_id = NEW.coordination_id
         AND receipt.obligation_revision = NEW.obligation_revision
         AND adoption.tenant_id = NEW.tenant_id
         AND adoption.project_id = NEW.project_id
         AND adoption.coordination_id = NEW.coordination_id
         AND adoption.obligation_revision = NEW.obligation_revision
         AND adoption.lease_id = NEW.lease_id
    ) THEN
      RAISE EXCEPTION 'COMPLETION_ACK_DELIVERY_RECEIPT_NOT_ADOPTED:%', v_receipt_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    NEW.completion_delivery_receipt_id := v_receipt_id;
  ELSE
    IF NEW.completion_delivery_receipt_id IS NOT NULL THEN
      RAISE EXCEPTION 'COMPLETION_ACK_DELIVERY_RECEIPT_RESULT_MISMATCH'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  IF NEW.result = 'RESOLVED' THEN
    SELECT COALESCE((
      SELECT event.state = 'CLOSED'
        FROM completion_ack_obligation_event event
       WHERE event.obligation_id = v_standing.obligation_id
         AND event.obligation_revision = v_standing.obligation_revision
       ORDER BY event.recorded_at DESC, event.ingested_at DESC, event.id DESC
       LIMIT 1
    ), false) INTO v_closed;
    IF NOT v_closed THEN
      RAISE EXCEPTION 'COMPLETION_ACK_CANONICAL_CLOSED_REQUIRED:%', NEW.coordination_id
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  ELSIF NEW.result IN ('SUPERSEDED', 'ESCALATED', 'TERMINAL', 'ACTION_ENQUEUED') THEN
    RAISE EXCEPTION 'COMPLETION_ACK_RESULT_FORBIDDEN:%', NEW.result
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER outcome_coordinator_completion_attempt_result_guard
  BEFORE INSERT ON outcome_coordinator_attempt_result
  FOR EACH ROW EXECUTE FUNCTION completion_ack_attempt_result_insert_guard();

ALTER FUNCTION outcome_record_coordinator_result(
  uuid, uuid, uuid, text, text, text, text, bigint, jsonb
) RENAME TO outcome_record_coordinator_result_0198;

CREATE OR REPLACE FUNCTION outcome_record_coordinator_result(
  p_tenant_id uuid,
  p_coordination_id uuid,
  p_lease_token uuid,
  p_worker_id text,
  p_callback_key text,
  p_result text,
  p_failure_fingerprint text DEFAULT NULL,
  p_retry_after bigint DEFAULT NULL,
  p_detail jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_standing outcome_coordinator_obligation%ROWTYPE;
  v_lease outcome_coordinator_lease%ROWTYPE;
  v_previous outcome_coordinator_attempt_result%ROWTYPE;
  v_now bigint;
  v_delay bigint;
  v_occurrences integer;
  v_wake jsonb;
  v_terminal jsonb;
BEGIN
  SELECT * INTO v_standing FROM outcome_coordinator_obligation standing
   WHERE standing.tenant_id = p_tenant_id
     AND standing.coordination_id = p_coordination_id;
  IF FOUND AND v_standing.source_type <> 'COMPLETION_ACK' THEN
    RETURN outcome_record_coordinator_result_0198(
      p_tenant_id, p_coordination_id, p_lease_token, p_worker_id,
      p_callback_key, p_result, p_failure_fingerprint, p_retry_after, p_detail
    );
  END IF;
  IF NOT FOUND OR v_standing.capability <> 'completion-ack.recover' THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_OBLIGATION_NOT_FOUND'
      USING ERRCODE = 'no_data_found';
  END IF;
  IF btrim(COALESCE(p_worker_id, '')) = '' OR btrim(COALESCE(p_callback_key, '')) = ''
     OR p_result NOT IN (
       'DELIVERED', 'RETRYABLE_FAILURE', 'QUOTA_WAIT', 'EXTERNAL_WAIT', 'RESOLVED'
     ) OR jsonb_typeof(p_detail) <> 'object' THEN
    RAISE EXCEPTION 'COMPLETION_ACK_COORDINATOR_RESULT_INVALID'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (p_result = 'RETRYABLE_FAILURE')
     <> (p_failure_fingerprint IS NOT NULL
       AND COALESCE(outcome_valid_digest(p_failure_fingerprint), false)) THEN
    RAISE EXCEPTION 'COMPLETION_ACK_FAILURE_FINGERPRINT_INVALID'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_now := outcome_coordinator_now(p_tenant_id);
  SELECT * INTO v_previous FROM outcome_coordinator_attempt_result result
   WHERE result.tenant_id = p_tenant_id AND result.callback_key = p_callback_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'coordinationId', v_previous.coordination_id::text,
      'result', v_previous.result, 'replayed', true
    );
  END IF;
  SELECT * INTO v_standing FROM outcome_coordinator_obligation standing
   WHERE standing.tenant_id = p_tenant_id
     AND standing.coordination_id = p_coordination_id FOR UPDATE;
  IF v_standing.status <> 'CLAIMED'
     OR v_standing.lease_token IS DISTINCT FROM p_lease_token
     OR v_standing.lease_owner IS DISTINCT FROM p_worker_id
     OR v_standing.lease_expires_logical_time < v_now THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_LEASE_STALE'
      USING ERRCODE = 'serialization_failure';
  END IF;
  SELECT * INTO STRICT v_lease FROM outcome_coordinator_lease lease
   WHERE lease.lease_id = v_standing.lease_id AND lease.lease_token = p_lease_token;
  SELECT * INTO v_previous FROM outcome_coordinator_attempt_result result
   WHERE result.lease_id = v_lease.lease_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'coordinationId', v_previous.coordination_id::text,
      'result', v_previous.result, 'replayed', true
    );
  END IF;
  INSERT INTO outcome_coordinator_attempt_result(
    result_id, tenant_id, project_id, coordination_id, lease_id,
    obligation_revision, callback_key, result, failure_fingerprint,
    detail, logical_time
  ) VALUES (
    gen_random_uuid(), v_standing.tenant_id, v_standing.project_id,
    v_standing.coordination_id, v_lease.lease_id, v_standing.obligation_revision,
    p_callback_key, p_result, p_failure_fingerprint, p_detail, v_now
  );
  UPDATE outcome_coordinator_obligation
     SET last_progress_logical_time = v_now,
         progress_deadline_logical_time = v_now + liveness_delta,
         durable_owner = 'AGENT', updated_at = clock_timestamp()
   WHERE coordination_id = v_standing.coordination_id;

  IF p_result = 'RESOLVED' THEN
    v_terminal := outcome_terminalize_coordination(
      v_standing.coordination_id, 'RESOLVED',
      'COMPLETION_ACK_CANONICAL_SOURCE_CLOSED', 'TERMINAL_DISPOSITION', v_now,
      p_detail || jsonb_build_object(
        'authority', 'COMPLETION_ACK_CANONICAL_CLOSED_EVENT'
      )
    );
    RETURN v_terminal || jsonb_build_object('result', p_result, 'replayed', false);
  END IF;

  IF p_result = 'RETRYABLE_FAILURE' THEN
    INSERT INTO outcome_coordinator_failure_fingerprint(
      tenant_id, project_id, coordination_id, obligation_revision,
      failure_fingerprint, occurrence_count, last_logical_time, diagnostic_path
    ) VALUES (
      v_standing.tenant_id, v_standing.project_id, v_standing.coordination_id,
      v_standing.obligation_revision, p_failure_fingerprint, 1, v_now,
      'PERSISTENT_AGENT_RECOVERY'
    ) ON CONFLICT (coordination_id, obligation_revision, failure_fingerprint) DO UPDATE SET
      occurrence_count = outcome_coordinator_failure_fingerprint.occurrence_count + 1,
      last_logical_time = EXCLUDED.last_logical_time,
      diagnostic_path = 'PERSISTENT_AGENT_RECOVERY'
    RETURNING occurrence_count INTO v_occurrences;
    PERFORM outcome_append_coordinator_event(
      v_standing.coordination_id,
      'completion-failure:' || v_standing.obligation_revision::text || ':'
        || p_failure_fingerprint || ':' || v_occurrences::text,
      'COMPLETION_ACK_RETRYABLE_FAILURE', 'CLAIMED', 'SCHEDULED', NULL,
      v_now, p_failure_fingerprint,
      p_detail || jsonb_build_object(
        'occurrenceCount', v_occurrences,
        'diagnosticPath', 'PERSISTENT_AGENT_RECOVERY',
        'terminalDisposition', false, 'owner', 'PROJECT_COORDINATOR'
      )
    );
    v_delay := LEAST(COALESCE(p_retry_after, 1), v_standing.liveness_delta);
    IF v_delay <= 0 THEN v_delay := 1; END IF;
    v_wake := completion_ack_schedule_coordinator_wake(
      v_standing.coordination_id, v_now + v_delay, 'COMPLETION_ACK_RETRY_DUE'
    );
  ELSIF p_result IN ('QUOTA_WAIT', 'EXTERNAL_WAIT') THEN
    IF p_retry_after IS NULL OR p_retry_after <= 0
       OR btrim(COALESCE(p_detail->>'provider', '')) = ''
       OR NOT (p_detail ? 'condition') THEN
      RAISE EXCEPTION 'COMPLETION_ACK_EXTERNAL_WAIT_INVALID'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_delay := LEAST(p_retry_after, v_standing.liveness_delta);
    PERFORM outcome_append_coordinator_event(
      v_standing.coordination_id,
      'completion-external-wait:' || v_lease.lease_id::text,
      'COMPLETION_ACK_EXTERNAL_WAIT', 'CLAIMED', 'SCHEDULED',
      'EXTERNAL_WAIT', v_now, NULL,
      p_detail || jsonb_build_object(
        'terminalDisposition', false, 'owner', 'PROJECT_COORDINATOR'
      )
    );
    v_wake := completion_ack_schedule_coordinator_wake(
      v_standing.coordination_id, v_now + v_delay, 'COMPLETION_ACK_EXTERNAL_RECHECK_DUE'
    );
  ELSE
    PERFORM outcome_append_coordinator_event(
      v_standing.coordination_id,
      'completion-delivery:' || v_lease.lease_id::text,
      'COMPLETION_ACK_DELIVERED', 'CLAIMED', 'SCHEDULED',
      'EXTERNAL_DELIVERY', v_now, NULL, p_detail
    );
    v_wake := completion_ack_schedule_coordinator_wake(
      v_standing.coordination_id, v_now + LEAST(1, v_standing.liveness_delta),
      'COMPLETION_ACK_DELIVERY_REEVALUATION_DUE'
    );
  END IF;
  RETURN jsonb_build_object(
    'coordinationId', v_standing.coordination_id::text,
    'status', COALESCE(v_wake->>'status', 'SCHEDULED'),
    'result', p_result, 'wake', v_wake,
    'durableOwner', 'AGENT', 'replayed', false
  );
END;
$$;

-- The generic 0198 worker remains authoritative only for its original source classes.  Without
-- these filters it could acquire a completion lease before the capability-specific worker sees it.
CREATE OR REPLACE FUNCTION outcome_sweep_coordinator(
  p_tenant_id uuid
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_standing outcome_coordinator_obligation%ROWTYPE;
  v_wake outcome_coordinator_wake%ROWTYPE;
  v_now bigint;
  v_fingerprint text;
  v_rebuilt integer := 0;
  v_delivered integer := 0;
  v_expired integer := 0;
  v_escalated integer := 0;
  v_receipt jsonb;
BEGIN
  v_now := outcome_coordinator_now(p_tenant_id);
  FOR v_standing IN
    SELECT standing.* FROM outcome_coordinator_obligation standing
     WHERE standing.tenant_id = p_tenant_id
       AND standing.source_type IN ('CANONICAL', 'EXECUTOR')
       AND standing.status IN ('SCHEDULED', 'EXTERNAL_WAIT')
       AND standing.next_wake_logical_time <= v_now
       AND NOT EXISTS (
         SELECT 1 FROM outcome_coordinator_wake wake
          WHERE wake.coordination_id = standing.coordination_id
            AND wake.generation = standing.wake_generation
            AND wake.state = 'SCHEDULED'
       )
     ORDER BY standing.project_id, standing.queue_sequence
     FOR UPDATE
  LOOP
    v_receipt := outcome_schedule_coordinator_wake(
      v_standing.coordination_id, v_now, 'RECOVER_LOST_WAKE', v_standing.status
    );
    IF v_receipt->>'scheduled' = 'true' THEN
      v_rebuilt := v_rebuilt + 1;
      PERFORM outcome_append_coordinator_event(
        v_standing.coordination_id,
        'wake-rebuilt:' || (v_standing.wake_generation + 1)::text,
        'WAKE_REBUILT', v_standing.status, v_standing.status, NULL, v_now, NULL,
        jsonb_build_object('lostGeneration', v_standing.wake_generation::text)
      );
    ELSE
      v_escalated := v_escalated + 1;
    END IF;
  END LOOP;
  FOR v_wake IN
    SELECT wake.* FROM outcome_coordinator_wake wake
    JOIN outcome_coordinator_obligation standing
      ON standing.coordination_id = wake.coordination_id
     AND standing.source_type IN ('CANONICAL', 'EXECUTOR')
   WHERE wake.tenant_id = p_tenant_id AND wake.state = 'SCHEDULED'
     AND wake.due_logical_time <= v_now
   ORDER BY wake.due_logical_time, wake.project_id, wake.wake_id
   FOR UPDATE OF wake
  LOOP
    v_receipt := outcome_deliver_coordinator_wake(
      p_tenant_id, v_wake.wake_id,
      'sweep:' || v_wake.wake_id::text || ':' || v_wake.generation::text
    );
    IF v_receipt->>'outcome' = 'DELIVERED' THEN v_delivered := v_delivered + 1; END IF;
  END LOOP;
  FOR v_standing IN
    SELECT standing.* FROM outcome_coordinator_obligation standing
     WHERE standing.tenant_id = p_tenant_id
       AND standing.source_type IN ('CANONICAL', 'EXECUTOR')
       AND standing.status = 'CLAIMED'
       AND standing.lease_expires_logical_time <= v_now
     ORDER BY standing.project_id, standing.queue_sequence
     FOR UPDATE
  LOOP
    v_fingerprint := outcome_sha256_json(jsonb_build_object(
      'namespace', 'orbit.outcome-coordinator.failure.v2',
      'code', 'LEASE_EXPIRED',
      'obligationRevision', v_standing.obligation_revision::text
    ));
    v_receipt := outcome_apply_coordinator_failure(
      v_standing.coordination_id, v_fingerprint, 'LEASE_EXPIRED', v_now, 1,
      jsonb_build_object(
        'leaseId', v_standing.lease_id::text,
        'leaseGeneration', v_standing.lease_generation::text,
        'workerId', v_standing.lease_owner
      )
    );
    v_expired := v_expired + 1;
    IF v_receipt->>'status' = 'ESCALATED' THEN v_escalated := v_escalated + 1; END IF;
  END LOOP;
  FOR v_standing IN
    SELECT standing.* FROM outcome_coordinator_obligation standing
     WHERE standing.tenant_id = p_tenant_id
       AND standing.source_type IN ('CANONICAL', 'EXECUTOR')
       AND standing.status IN ('READY', 'SCHEDULED', 'CLAIMED')
       AND standing.progress_deadline_logical_time <= v_now
     ORDER BY standing.project_id, standing.queue_sequence
     FOR UPDATE
  LOOP
    PERFORM outcome_terminalize_coordination(
      v_standing.coordination_id, 'ESCALATED', 'LIVENESS_DELTA_EXCEEDED',
      'ESCALATE', v_now,
      jsonb_build_object(
        'progressDeadlineLogicalTime', v_standing.progress_deadline_logical_time::text,
        'lastProgressLogicalTime', v_standing.last_progress_logical_time::text
      )
    );
    v_escalated := v_escalated + 1;
  END LOOP;
  RETURN jsonb_build_object(
    'logicalNow', v_now::text, 'wakesRebuilt', v_rebuilt,
    'wakesDelivered', v_delivered, 'leasesExpired', v_expired,
    'escalated', v_escalated
  );
END;
$$;

CREATE OR REPLACE FUNCTION outcome_claim_next_coordination(
  p_tenant_id uuid,
  p_worker_id text,
  p_lease_logical_ticks bigint
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_standing outcome_coordinator_obligation%ROWTYPE;
  v_scheduler outcome_coordinator_scheduler%ROWTYPE;
  v_lease_id uuid;
  v_token uuid;
  v_generation bigint;
  v_attempt integer;
  v_dispatch bigint;
  v_expiry bigint;
  v_now bigint;
BEGIN
  IF btrim(COALESCE(p_worker_id, '')) = '' OR p_lease_logical_ticks <= 0 THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_CLAIM_INVALID'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_now := outcome_coordinator_now(p_tenant_id);
  PERFORM outcome_sweep_coordinator(p_tenant_id);
  INSERT INTO outcome_coordinator_scheduler(tenant_id) VALUES (p_tenant_id)
  ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT v_scheduler FROM outcome_coordinator_scheduler scheduler
   WHERE scheduler.tenant_id = p_tenant_id FOR UPDATE;
  SELECT candidate.* INTO v_standing
    FROM (
      SELECT DISTINCT ON (standing.project_id) standing.*
        FROM outcome_coordinator_obligation standing
       WHERE standing.tenant_id = p_tenant_id
         AND standing.source_type IN ('CANONICAL', 'EXECUTOR')
         AND standing.status = 'READY'
         AND standing.attempt_budget_remaining > 0
         AND standing.progress_deadline_logical_time >= v_now
       ORDER BY standing.project_id, standing.queue_sequence, standing.coordination_id
    ) candidate
    LEFT JOIN outcome_coordinator_project_fairness fairness
      ON fairness.tenant_id = candidate.tenant_id
     AND fairness.project_id = candidate.project_id
   ORDER BY fairness.last_dispatched_sequence ASC NULLS FIRST,
            candidate.project_id, candidate.queue_sequence, candidate.coordination_id
   LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO v_standing FROM outcome_coordinator_obligation standing
   WHERE standing.coordination_id = v_standing.coordination_id FOR UPDATE;
  IF v_standing.status <> 'READY' OR v_standing.source_type NOT IN ('CANONICAL', 'EXECUTOR')
     OR v_standing.attempt_budget_remaining <= 0 THEN RETURN NULL; END IF;
  IF p_lease_logical_ticks > v_standing.liveness_delta THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_LEASE_OUTSIDE_LIVENESS_BOUND'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_dispatch := v_scheduler.dispatch_sequence + 1;
  UPDATE outcome_coordinator_scheduler SET dispatch_sequence = v_dispatch
   WHERE tenant_id = p_tenant_id;
  INSERT INTO outcome_coordinator_project_fairness(
    tenant_id, project_id, last_dispatched_sequence, dispatch_count
  ) VALUES (p_tenant_id, v_standing.project_id, v_dispatch, 1)
  ON CONFLICT (tenant_id, project_id) DO UPDATE SET
    last_dispatched_sequence = EXCLUDED.last_dispatched_sequence,
    dispatch_count = outcome_coordinator_project_fairness.dispatch_count + 1,
    updated_at = clock_timestamp();
  v_lease_id := gen_random_uuid();
  v_token := gen_random_uuid();
  v_generation := v_standing.lease_generation + 1;
  v_attempt := v_standing.attempt_count + 1;
  v_expiry := v_now + p_lease_logical_ticks;
  UPDATE outcome_coordinator_obligation
     SET status = 'CLAIMED',
         durable_owner = CASE WHEN durable_owner = 'OWNER' THEN 'AGENT' ELSE durable_owner END,
         attempt_count = v_attempt,
         attempt_budget_remaining = attempt_budget_remaining - 1,
         lease_generation = v_generation, lease_renewal_count = 0,
         lease_id = v_lease_id, lease_token = v_token, lease_owner = p_worker_id,
         lease_expires_logical_time = v_expiry, next_wake_logical_time = NULL,
         last_progress_logical_time = v_now,
         progress_deadline_logical_time = v_now + liveness_delta,
         updated_at = clock_timestamp()
   WHERE coordination_id = v_standing.coordination_id;
  INSERT INTO outcome_coordinator_lease(
    lease_id, tenant_id, project_id, coordination_id, obligation_revision,
    generation, attempt_number, worker_id, lease_token,
    claimed_logical_time, expires_logical_time
  ) VALUES (
    v_lease_id, v_standing.tenant_id, v_standing.project_id,
    v_standing.coordination_id, v_standing.obligation_revision, v_generation,
    v_attempt, p_worker_id, v_token, v_now, v_expiry
  );
  PERFORM outcome_append_coordinator_event(
    v_standing.coordination_id, 'claim:' || v_generation::text,
    'VALID_ATTEMPT_STARTED', 'READY', 'CLAIMED', 'VALID_ATTEMPT', v_now, NULL,
    jsonb_build_object(
      'leaseId', v_lease_id::text, 'workerId', p_worker_id,
      'attemptNumber', v_attempt,
      'attemptBudgetRemaining', v_standing.attempt_budget_remaining - 1,
      'dispatchSequence', v_dispatch::text
    )
  );
  RETURN jsonb_build_object(
    'coordinationId', v_standing.coordination_id::text,
    'tenantId', v_standing.tenant_id::text,
    'projectId', v_standing.project_id::text,
    'obligationId', v_standing.obligation_id::text,
    'obligationRevision', v_standing.obligation_revision::text,
    'capability', v_standing.capability, 'attemptNumber', v_attempt,
    'attemptBudgetRemaining', v_standing.attempt_budget_remaining - 1,
    'diagnosticPath', v_standing.diagnostic_path,
    'leaseId', v_lease_id::text, 'leaseToken', v_token::text,
    'leaseExpiresLogicalTime', v_expiry::text,
    'sourceObligation', v_standing.source_obligation
  );
END;
$$;


-- Deployment-owned expectation ledger.  A worker self-registering cannot prove that it started;
-- the upgrade/deployment controller must append this row before it starts the expected process.
CREATE TABLE executable_runtime_expectation (
  generation                uuid        PRIMARY KEY,
  component                 text        NOT NULL CHECK (component IN (
    'outcome-coordinator', 'outcome-watchdog', 'completion-ack-watchdog'
  )),
  instance_id               text        NOT NULL CHECK (length(btrim(instance_id)) BETWEEN 1 AND 512),
  expected_source_sha       text        NOT NULL CHECK (expected_source_sha ~ '^[0-9a-f]{40}$'),
  module_graph_digest       char(64)    NOT NULL CHECK (outcome_valid_digest(module_graph_digest)),
  startup_grace_seconds     integer     NOT NULL CHECK (startup_grace_seconds BETWEEN 1 AND 3600),
  idempotency_key           text        NOT NULL UNIQUE CHECK (
    length(btrim(idempotency_key)) BETWEEN 1 AND 1024
  ),
  metadata                  jsonb       NOT NULL CHECK (
    jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 8192
  ),
  metadata_digest           char(64)    NOT NULL CHECK (outcome_valid_digest(metadata_digest)),
  expectation_digest        char(64)    NOT NULL UNIQUE CHECK (outcome_valid_digest(expectation_digest)),
  activated_at              timestamptz NOT NULL,
  startup_deadline_at       timestamptz NOT NULL,
  recorded_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (component, instance_id, generation),
  CHECK (metadata_digest = outcome_sha256_json(metadata)),
  CHECK (startup_deadline_at = activated_at + make_interval(secs => startup_grace_seconds)),
  CHECK (recorded_at >= activated_at)
);
CREATE INDEX executable_runtime_expectation_slot_idx
  ON executable_runtime_expectation(component, instance_id, activated_at DESC, generation);

CREATE TABLE executable_runtime_expectation_event (
  event_id                  uuid        PRIMARY KEY,
  generation                uuid        NOT NULL,
  component                 text        NOT NULL,
  instance_id               text        NOT NULL,
  kind                      text        NOT NULL CHECK (kind IN (
    'ACTIVATED', 'SUPERSEDED', 'RETIRED'
  )),
  reason_code               text        NOT NULL CHECK (btrim(reason_code) <> ''),
  idempotency_key           text        NOT NULL UNIQUE CHECK (btrim(idempotency_key) <> ''),
  event_digest              char(64)    NOT NULL UNIQUE CHECK (outcome_valid_digest(event_digest)),
  recorded_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (generation) REFERENCES executable_runtime_expectation(generation)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (component, instance_id, generation)
    REFERENCES executable_runtime_expectation(component, instance_id, generation)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX executable_runtime_expectation_terminal_idx
  ON executable_runtime_expectation_event(generation)
  WHERE kind IN ('SUPERSEDED', 'RETIRED');
CREATE INDEX executable_runtime_expectation_event_latest_idx
  ON executable_runtime_expectation_event(generation, recorded_at DESC, event_id DESC);

CREATE TRIGGER executable_runtime_expectation_append_only
  BEFORE UPDATE OR DELETE ON executable_runtime_expectation
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER executable_runtime_expectation_event_append_only
  BEFORE UPDATE OR DELETE ON executable_runtime_expectation_event
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();

CREATE OR REPLACE FUNCTION executable_runtime_expectation_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_metadata jsonb;
  v_digest char(64);
  v_now timestamptz := clock_timestamp();
BEGIN
  v_metadata := completion_ack_sanitize_action_evidence(NEW.metadata);
  v_digest := outcome_sha256_json(jsonb_build_array(
    'executable-runtime-expectation:v1', NEW.component, NEW.instance_id,
    NEW.generation::text, NEW.expected_source_sha,
    NEW.module_graph_digest::text, NEW.startup_grace_seconds, v_metadata
  ));
  IF NEW.metadata IS DISTINCT FROM v_metadata
     OR NEW.metadata_digest IS DISTINCT FROM outcome_sha256_json(v_metadata)
     OR NEW.expectation_digest IS DISTINCT FROM v_digest THEN
    RAISE EXCEPTION 'EXECUTABLE_RUNTIME_EXPECTATION_IDENTITY_INVALID:%', NEW.generation
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.activated_at := v_now;
  NEW.startup_deadline_at := v_now + make_interval(secs => NEW.startup_grace_seconds);
  NEW.recorded_at := v_now;
  RETURN NEW;
END;
$$;
CREATE TRIGGER executable_runtime_expectation_insert_guard
  BEFORE INSERT ON executable_runtime_expectation
  FOR EACH ROW EXECUTE FUNCTION executable_runtime_expectation_insert_guard();

CREATE OR REPLACE FUNCTION executable_runtime_expectation_event_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_expectation executable_runtime_expectation%ROWTYPE;
  v_digest char(64);
BEGIN
  SELECT * INTO v_expectation FROM executable_runtime_expectation expectation
   WHERE expectation.generation = NEW.generation FOR KEY SHARE;
  IF NOT FOUND OR v_expectation.component IS DISTINCT FROM NEW.component
     OR v_expectation.instance_id IS DISTINCT FROM NEW.instance_id THEN
    RAISE EXCEPTION 'EXECUTABLE_RUNTIME_EXPECTATION_EVENT_SCOPE_INVALID:%', NEW.generation
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.kind = 'ACTIVATED' AND EXISTS (
    SELECT 1 FROM executable_runtime_expectation_event event
     WHERE event.generation = NEW.generation
  ) THEN
    RAISE EXCEPTION 'EXECUTABLE_RUNTIME_EXPECTATION_REACTIVATION_FORBIDDEN:%', NEW.generation
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW.kind IN ('SUPERSEDED', 'RETIRED') AND NOT EXISTS (
    SELECT 1 FROM executable_runtime_expectation_event event
     WHERE event.generation = NEW.generation AND event.kind = 'ACTIVATED'
  ) THEN
    RAISE EXCEPTION 'EXECUTABLE_RUNTIME_EXPECTATION_NOT_ACTIVE:%', NEW.generation
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  v_digest := outcome_sha256_json(jsonb_build_array(
    'executable-runtime-expectation-event:v1', NEW.generation::text,
    NEW.component, NEW.instance_id, NEW.kind, NEW.reason_code,
    NEW.idempotency_key
  ));
  IF NEW.event_id IS DISTINCT FROM completion_ack_uuid_from_digest(v_digest::text)
     OR NEW.event_digest IS DISTINCT FROM v_digest THEN
    RAISE EXCEPTION 'EXECUTABLE_RUNTIME_EXPECTATION_EVENT_IDENTITY_INVALID:%', NEW.event_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER executable_runtime_expectation_event_insert_guard
  BEFORE INSERT ON executable_runtime_expectation_event
  FOR EACH ROW EXECUTE FUNCTION executable_runtime_expectation_event_insert_guard();

CREATE VIEW executable_runtime_active_expectation AS
WITH latest_event AS (
  SELECT DISTINCT ON (event.generation) event.*
    FROM executable_runtime_expectation_event event
   ORDER BY event.generation, event.recorded_at DESC, event.event_id DESC
)
SELECT expectation.*
  FROM executable_runtime_expectation expectation
  JOIN latest_event event ON event.generation = expectation.generation
 WHERE event.kind = 'ACTIVATED';

CREATE OR REPLACE FUNCTION executable_runtime_expect_generation(
  p_component text,
  p_instance_id text,
  p_generation uuid,
  p_expected_source_sha text,
  p_module_graph_digest text,
  p_startup_grace_seconds integer,
  p_idempotency_key text,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, outcome_watchdog AS $$
DECLARE
  v_existing executable_runtime_expectation%ROWTYPE;
  v_prior executable_runtime_expectation%ROWTYPE;
  v_metadata jsonb;
  v_metadata_digest char(64);
  v_digest char(64);
  v_event_digest char(64);
  v_recorded_at timestamptz;
BEGIN
  IF p_component NOT IN (
       'outcome-coordinator', 'outcome-watchdog', 'completion-ack-watchdog'
     ) OR length(btrim(COALESCE(p_instance_id, ''))) NOT BETWEEN 1 AND 512
     OR p_generation IS NULL OR COALESCE(p_expected_source_sha, '') !~ '^[0-9a-f]{40}$'
     OR NOT COALESCE(outcome_valid_digest(p_module_graph_digest), false)
     OR p_startup_grace_seconds NOT BETWEEN 1 AND 3600
     OR length(btrim(COALESCE(p_idempotency_key, ''))) NOT BETWEEN 1 AND 1024 THEN
    RAISE EXCEPTION 'EXECUTABLE_RUNTIME_EXPECTATION_ARGUMENT_INVALID'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat('runtime-expectation:v1:', p_component, ':', p_instance_id), 0
  ));
  v_metadata := completion_ack_sanitize_action_evidence(COALESCE(p_metadata, '{}'::jsonb));
  v_metadata_digest := outcome_sha256_json(v_metadata);
  v_digest := outcome_sha256_json(jsonb_build_array(
    'executable-runtime-expectation:v1', p_component, p_instance_id,
    p_generation::text, p_expected_source_sha, p_module_graph_digest,
    p_startup_grace_seconds, v_metadata
  ));
  SELECT * INTO v_existing FROM executable_runtime_expectation expectation
   WHERE expectation.idempotency_key = p_idempotency_key
      OR expectation.generation = p_generation
   ORDER BY (expectation.idempotency_key = p_idempotency_key) DESC LIMIT 1;
  IF FOUND THEN
    IF v_existing.generation IS DISTINCT FROM p_generation
       OR v_existing.component IS DISTINCT FROM p_component
       OR v_existing.instance_id IS DISTINCT FROM p_instance_id
       OR v_existing.expectation_digest IS DISTINCT FROM v_digest THEN
      RAISE EXCEPTION 'EXECUTABLE_RUNTIME_EXPECTATION_IDEMPOTENCY_CONFLICT'
        USING ERRCODE = 'unique_violation';
    END IF;
    RETURN jsonb_build_object(
      'generation', v_existing.generation::text,
      'component', v_existing.component,
      'instanceId', v_existing.instance_id,
      'expectationDigest', v_existing.expectation_digest::text,
      'startupDeadlineAt', v_existing.startup_deadline_at,
      'replayed', true
    );
  END IF;
  -- Capture the deployment admission clock once.  The insert guard independently
  -- enforces DB-owned timestamps, but the writer must still present the correct
  -- grace interval rather than relying on that guard to repair its semantics.
  v_recorded_at := clock_timestamp();
  INSERT INTO executable_runtime_expectation(
    generation, component, instance_id, expected_source_sha, module_graph_digest,
    startup_grace_seconds, idempotency_key, metadata, metadata_digest,
    expectation_digest, activated_at, startup_deadline_at, recorded_at
  ) VALUES (
    p_generation, p_component, p_instance_id, p_expected_source_sha,
    p_module_graph_digest::char(64), p_startup_grace_seconds, p_idempotency_key,
    v_metadata, v_metadata_digest, v_digest, v_recorded_at,
    v_recorded_at + make_interval(secs => p_startup_grace_seconds),
    v_recorded_at
  );
  SELECT * INTO STRICT v_existing FROM executable_runtime_expectation expectation
   WHERE expectation.generation = p_generation;

  FOR v_prior IN
    SELECT active.* FROM executable_runtime_active_expectation active
     WHERE active.component = p_component AND active.instance_id = p_instance_id
       AND active.generation <> p_generation
     ORDER BY active.activated_at, active.generation
  LOOP
    v_event_digest := outcome_sha256_json(jsonb_build_array(
      'executable-runtime-expectation-event:v1', v_prior.generation::text,
      v_prior.component, v_prior.instance_id, 'SUPERSEDED',
      'REPLACED_BY_DEPLOYMENT_GENERATION',
      'runtime-expectation:superseded-by:' || p_generation::text
    ));
    INSERT INTO executable_runtime_expectation_event(
      event_id, generation, component, instance_id, kind, reason_code,
      idempotency_key, event_digest
    ) VALUES (
      completion_ack_uuid_from_digest(v_event_digest::text), v_prior.generation,
      v_prior.component, v_prior.instance_id, 'SUPERSEDED',
      'REPLACED_BY_DEPLOYMENT_GENERATION',
      'runtime-expectation:superseded-by:' || p_generation::text,
      v_event_digest
    ) ON CONFLICT (generation) WHERE kind IN ('SUPERSEDED', 'RETIRED') DO NOTHING;
  END LOOP;
  v_event_digest := outcome_sha256_json(jsonb_build_array(
    'executable-runtime-expectation-event:v1', p_generation::text,
    p_component, p_instance_id, 'ACTIVATED', 'DEPLOYMENT_EXPECTED',
    'runtime-expectation:activated:' || p_generation::text
  ));
  INSERT INTO executable_runtime_expectation_event(
    event_id, generation, component, instance_id, kind, reason_code,
    idempotency_key, event_digest
  ) VALUES (
    completion_ack_uuid_from_digest(v_event_digest::text), p_generation,
    p_component, p_instance_id, 'ACTIVATED', 'DEPLOYMENT_EXPECTED',
    'runtime-expectation:activated:' || p_generation::text, v_event_digest
  );
  RETURN jsonb_build_object(
    'generation', v_existing.generation::text,
    'component', v_existing.component,
    'instanceId', v_existing.instance_id,
    'expectationDigest', v_existing.expectation_digest::text,
    'startupDeadlineAt', v_existing.startup_deadline_at,
    'replayed', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION executable_runtime_retire_expectation(
  p_component text,
  p_instance_id text,
  p_generation uuid,
  p_reason_code text,
  p_idempotency_key text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  v_expectation executable_runtime_expectation%ROWTYPE;
  v_event executable_runtime_expectation_event%ROWTYPE;
  v_digest char(64);
  v_rows bigint;
BEGIN
  IF btrim(COALESCE(p_reason_code, '')) = '' OR btrim(COALESCE(p_idempotency_key, '')) = '' THEN
    RAISE EXCEPTION 'EXECUTABLE_RUNTIME_EXPECTATION_RETIRE_ARGUMENT_INVALID'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat('runtime-expectation:v1:', p_component, ':', p_instance_id), 0
  ));
  SELECT * INTO v_expectation FROM executable_runtime_expectation expectation
   WHERE expectation.generation = p_generation
     AND expectation.component = p_component
     AND expectation.instance_id = p_instance_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('retired', false, 'reason', 'EXPECTATION_NOT_FOUND');
  END IF;
  v_digest := outcome_sha256_json(jsonb_build_array(
    'executable-runtime-expectation-event:v1', p_generation::text,
    p_component, p_instance_id, 'RETIRED', p_reason_code, p_idempotency_key
  ));
  INSERT INTO executable_runtime_expectation_event(
    event_id, generation, component, instance_id, kind, reason_code,
    idempotency_key, event_digest
  ) VALUES (
    completion_ack_uuid_from_digest(v_digest::text), p_generation,
    p_component, p_instance_id, 'RETIRED', p_reason_code,
    p_idempotency_key, v_digest
  ) ON CONFLICT (generation) WHERE kind IN ('SUPERSEDED', 'RETIRED') DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  SELECT * INTO STRICT v_event FROM executable_runtime_expectation_event event
   WHERE event.generation = p_generation
     AND event.kind IN ('SUPERSEDED', 'RETIRED');
  IF v_rows = 0 AND (v_event.kind <> 'RETIRED'
      OR v_event.idempotency_key <> p_idempotency_key
      OR v_event.event_digest IS DISTINCT FROM v_digest) THEN
    RAISE EXCEPTION 'EXECUTABLE_RUNTIME_EXPECTATION_ALREADY_TERMINAL'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN jsonb_build_object(
    'generation', p_generation::text,
    'retired', v_event.kind = 'RETIRED',
    'state', v_event.kind,
    'replayed', v_rows = 0
  );
END;
$$;

ALTER TABLE executable_runtime_heartbeat
  ADD COLUMN expectation_generation uuid,
  ADD COLUMN ingested_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE executable_runtime_heartbeat
  ADD CONSTRAINT executable_runtime_heartbeat_expectation_fk
  FOREIGN KEY (expectation_generation)
  REFERENCES executable_runtime_expectation(generation)
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX executable_runtime_heartbeat_expectation_idx
  ON executable_runtime_heartbeat(expectation_generation, sequence DESC)
  WHERE expectation_generation IS NOT NULL;

CREATE OR REPLACE FUNCTION executable_runtime_heartbeat_expectation_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_expectation executable_runtime_expectation%ROWTYPE;
BEGIN
  NEW.ingested_at := clock_timestamp();
  IF NEW.expectation_generation IS NULL THEN RETURN NEW; END IF;
  -- Serialize the latest-heartbeat register with dead-man observations.  This
  -- prevents a stale observation for heartbeat N from landing after heartbeat
  -- N+1 and temporarily masking the recovery.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat('runtime-expectation-observation:v1:',
      NEW.expectation_generation::text), 0
  ));
  SELECT * INTO v_expectation FROM executable_runtime_active_expectation expectation
   WHERE expectation.generation = NEW.expectation_generation;
  IF NOT FOUND OR v_expectation.component IS DISTINCT FROM NEW.component
     OR v_expectation.instance_id IS DISTINCT FROM NEW.instance_id
     OR v_expectation.expected_source_sha IS DISTINCT FROM NEW.source_sha
     OR v_expectation.module_graph_digest IS DISTINCT FROM NEW.module_graph_digest THEN
    RAISE EXCEPTION 'EXECUTABLE_RUNTIME_HEARTBEAT_EXPECTATION_MISMATCH:%',
      NEW.expectation_generation USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER executable_runtime_heartbeat_expectation_guard
  BEFORE INSERT ON executable_runtime_heartbeat
  FOR EACH ROW EXECUTE FUNCTION executable_runtime_heartbeat_expectation_guard();

ALTER TABLE executable_dead_man_event
  DROP CONSTRAINT executable_dead_man_event_kind_check;
ALTER TABLE executable_dead_man_event
  ADD CONSTRAINT executable_dead_man_event_kind_check CHECK (kind IN (
    'WATCHDOG_STALE', 'WATCHDOG_MISSING', 'WATCHDOG_RECOVERED'
  ));
ALTER TABLE executable_dead_man_event
  ADD COLUMN expectation_generation uuid,
  ADD COLUMN expectation_digest char(64),
  ADD COLUMN expectation_observation_key text;
ALTER TABLE executable_dead_man_event
  ADD CONSTRAINT executable_dead_man_event_expectation_fk
  FOREIGN KEY (expectation_generation)
  REFERENCES executable_runtime_expectation(generation)
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE executable_dead_man_event
  ADD CONSTRAINT executable_dead_man_event_expectation_shape_chk CHECK (
    (expectation_generation IS NULL AND expectation_digest IS NULL
      AND expectation_observation_key IS NULL)
    OR
    (expectation_generation IS NOT NULL AND outcome_valid_digest(expectation_digest)
      AND length(btrim(expectation_observation_key)) BETWEEN 1 AND 1024)
  );
CREATE UNIQUE INDEX executable_dead_man_expectation_observation_idx
  ON executable_dead_man_event(expectation_generation, expectation_observation_key)
  WHERE expectation_generation IS NOT NULL;
CREATE INDEX executable_dead_man_expectation_latest_idx
  ON executable_dead_man_event(
    expectation_generation, checked_at DESC, created_at DESC, id DESC
  ) WHERE expectation_generation IS NOT NULL;

CREATE OR REPLACE FUNCTION executable_runtime_dead_man_expectation_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_expectation executable_runtime_expectation%ROWTYPE;
  v_heartbeat executable_runtime_heartbeat%ROWTYPE;
  v_digest char(64);
BEGIN
  IF NEW.expectation_generation IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat('runtime-expectation-observation:v1:',
      NEW.expectation_generation::text), 0
  ));
  SELECT * INTO v_expectation FROM executable_runtime_expectation expectation
   WHERE expectation.generation = NEW.expectation_generation FOR KEY SHARE;
  IF NOT FOUND OR v_expectation.component IS DISTINCT FROM NEW.component
     OR v_expectation.instance_id IS DISTINCT FROM NEW.instance_id
     OR v_expectation.expectation_digest IS DISTINCT FROM NEW.expectation_digest THEN
    RAISE EXCEPTION 'EXECUTABLE_DEAD_MAN_EXPECTATION_SCOPE_INVALID:%',
      NEW.expectation_generation USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.kind = 'WATCHDOG_MISSING' THEN
    IF clock_timestamp() <= v_expectation.startup_deadline_at THEN
      RAISE EXCEPTION 'EXECUTABLE_DEAD_MAN_STARTUP_GRACE_ACTIVE:%',
        NEW.expectation_generation USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF NEW.heartbeat_digest IS NOT NULL OR EXISTS (
      SELECT 1 FROM executable_runtime_heartbeat heartbeat
       WHERE heartbeat.expectation_generation = NEW.expectation_generation
    ) THEN
      RAISE EXCEPTION 'EXECUTABLE_DEAD_MAN_MISSING_HAS_HEARTBEAT:%',
        NEW.expectation_generation USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    NEW.deadline_at := v_expectation.startup_deadline_at;
  ELSE
    SELECT * INTO v_heartbeat FROM executable_runtime_heartbeat heartbeat
     WHERE heartbeat.expectation_generation = NEW.expectation_generation
     ORDER BY heartbeat.sequence DESC, heartbeat.ingested_at DESC,
              heartbeat.id DESC LIMIT 1;
    IF NOT FOUND OR v_heartbeat.heartbeat_digest IS DISTINCT FROM NEW.heartbeat_digest THEN
      RAISE EXCEPTION 'EXECUTABLE_DEAD_MAN_HEARTBEAT_NOT_BOUND:%', NEW.heartbeat_digest
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.kind = 'WATCHDOG_STALE' AND clock_timestamp() <= v_heartbeat.deadline_at THEN
      RAISE EXCEPTION 'EXECUTABLE_DEAD_MAN_HEARTBEAT_NOT_STALE:%', NEW.heartbeat_digest
        USING ERRCODE = 'object_not_in_prerequisite_state';
    ELSIF NEW.kind = 'WATCHDOG_RECOVERED' AND clock_timestamp() > v_heartbeat.deadline_at THEN
      RAISE EXCEPTION 'EXECUTABLE_DEAD_MAN_HEARTBEAT_NOT_HEALTHY:%', NEW.heartbeat_digest
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    NEW.deadline_at := v_heartbeat.deadline_at;
  END IF;
  NEW.checked_at := clock_timestamp();
  NEW.created_at := NEW.checked_at;
  v_digest := outcome_sha256_json(jsonb_build_array(
    'executable-runtime-expectation-observation:v1',
    NEW.expectation_generation::text, NEW.component, NEW.instance_id,
    NEW.kind, NEW.heartbeat_digest::text, NEW.source_sha,
    NEW.expectation_observation_key
  ));
  NEW.event_digest := v_digest;
  NEW.id := completion_ack_uuid_from_digest(v_digest::text);
  RETURN NEW;
END;
$$;
CREATE TRIGGER executable_dead_man_expectation_guard
  BEFORE INSERT ON executable_dead_man_event
  FOR EACH ROW EXECUTE FUNCTION executable_runtime_dead_man_expectation_guard();

CREATE OR REPLACE FUNCTION executable_runtime_record_expectation_observation(
  p_component text,
  p_instance_id text,
  p_generation uuid,
  p_kind text,
  p_heartbeat_digest text,
  p_dead_man_source_sha text,
  p_idempotency_key text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  v_expectation executable_runtime_expectation%ROWTYPE;
  v_event executable_dead_man_event%ROWTYPE;
  v_rows bigint;
BEGIN
  IF p_kind NOT IN ('WATCHDOG_STALE', 'WATCHDOG_MISSING', 'WATCHDOG_RECOVERED')
     OR COALESCE(p_dead_man_source_sha, '') !~ '^[0-9a-f]{40}$'
     OR length(btrim(COALESCE(p_idempotency_key, ''))) NOT BETWEEN 1 AND 1024
     OR ((p_kind = 'WATCHDOG_MISSING') <> (p_heartbeat_digest IS NULL))
     OR (p_heartbeat_digest IS NOT NULL
       AND NOT COALESCE(outcome_valid_digest(p_heartbeat_digest), false)) THEN
    RAISE EXCEPTION 'EXECUTABLE_RUNTIME_EXPECTATION_OBSERVATION_INVALID'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO v_expectation FROM executable_runtime_active_expectation expectation
   WHERE expectation.component = p_component
     AND expectation.instance_id = p_instance_id
     AND expectation.generation = p_generation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'EXECUTABLE_RUNTIME_ACTIVE_EXPECTATION_NOT_FOUND'
      USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO executable_dead_man_event(
    id, component, instance_id, kind, heartbeat_digest, checked_at,
    deadline_at, source_sha, event_digest, expectation_generation,
    expectation_digest, expectation_observation_key
  ) VALUES (
    gen_random_uuid(), p_component, p_instance_id, p_kind,
    p_heartbeat_digest::char(64), clock_timestamp(), NULL,
    p_dead_man_source_sha, repeat('0', 64)::char(64), p_generation,
    v_expectation.expectation_digest, p_idempotency_key
  ) ON CONFLICT (expectation_generation, expectation_observation_key)
    WHERE expectation_generation IS NOT NULL DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  SELECT * INTO STRICT v_event FROM executable_dead_man_event event
   WHERE event.expectation_generation = p_generation
     AND event.expectation_observation_key = p_idempotency_key;
  IF v_event.component IS DISTINCT FROM p_component
     OR v_event.instance_id IS DISTINCT FROM p_instance_id
     OR v_event.kind IS DISTINCT FROM p_kind
     OR v_event.heartbeat_digest IS DISTINCT FROM p_heartbeat_digest::char(64)
     OR v_event.source_sha IS DISTINCT FROM p_dead_man_source_sha THEN
    RAISE EXCEPTION 'EXECUTABLE_RUNTIME_EXPECTATION_OBSERVATION_CONFLICT'
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN jsonb_build_object(
    'eventId', v_event.id::text,
    'generation', p_generation::text,
    'kind', v_event.kind,
    'checkedAt', v_event.checked_at,
    'replayed', v_rows = 0
  );
END;
$$;

CREATE VIEW executable_runtime_expected_liveness AS
SELECT expectation.component,
       expectation.instance_id,
       expectation.generation,
       expectation.expected_source_sha,
       expectation.module_graph_digest,
       expectation.expectation_digest,
       expectation.activated_at,
       expectation.startup_deadline_at,
       heartbeat.heartbeat_digest,
       heartbeat.observed_at,
       heartbeat.deadline_at,
       heartbeat.ingested_at AS heartbeat_ingested_at,
       dead_man.kind AS last_event_kind,
       CASE
         WHEN heartbeat.id IS NULL AND now() <= expectation.startup_deadline_at THEN 'STARTING'
         WHEN heartbeat.id IS NULL THEN 'WATCHDOG_STALE'
         WHEN now() > heartbeat.deadline_at THEN 'WATCHDOG_STALE'
         WHEN dead_man.kind IN ('WATCHDOG_STALE', 'WATCHDOG_MISSING')
          AND dead_man.checked_at >= heartbeat.ingested_at THEN 'WATCHDOG_STALE'
         ELSE 'HEALTHY'
       END::text AS state,
       CASE
         WHEN heartbeat.id IS NULL AND now() > expectation.startup_deadline_at
           THEN 'WATCHDOG_MISSING'
         WHEN heartbeat.id IS NOT NULL AND now() > heartbeat.deadline_at
           THEN 'WATCHDOG_STALE'
         WHEN dead_man.kind IN ('WATCHDOG_STALE', 'WATCHDOG_MISSING')
          AND (heartbeat.id IS NULL OR dead_man.checked_at >= heartbeat.ingested_at)
           THEN dead_man.kind
         WHEN heartbeat.id IS NULL THEN 'STARTING'
         ELSE 'HEALTHY'
       END::text AS condition_code
  FROM executable_runtime_active_expectation expectation
  LEFT JOIN LATERAL (
    SELECT candidate.* FROM executable_runtime_heartbeat candidate
     WHERE candidate.expectation_generation = expectation.generation
       AND candidate.component = expectation.component
       AND candidate.instance_id = expectation.instance_id
       AND candidate.source_sha = expectation.expected_source_sha
       AND candidate.module_graph_digest = expectation.module_graph_digest
     ORDER BY candidate.sequence DESC LIMIT 1
  ) heartbeat ON true
  LEFT JOIN LATERAL (
    SELECT event.* FROM executable_dead_man_event event
     WHERE event.expectation_generation = expectation.generation
     ORDER BY event.checked_at DESC, event.created_at DESC, event.id DESC
     LIMIT 1
  ) dead_man ON true;

-- Preserve the original nine-column contract.  Expected rows lead the union and use the immutable
-- expectation digest as the obligation revision until the first exact-generation heartbeat exists.
CREATE OR REPLACE VIEW executable_runtime_liveness AS
WITH latest_legacy_heartbeat AS (
  SELECT DISTINCT ON (heartbeat.component, heartbeat.instance_id) heartbeat.*
    FROM executable_runtime_heartbeat heartbeat
   WHERE heartbeat.expectation_generation IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM executable_runtime_expectation expectation
        WHERE expectation.component = heartbeat.component
          AND expectation.instance_id = heartbeat.instance_id
     )
   ORDER BY heartbeat.component, heartbeat.instance_id, heartbeat.sequence DESC
), latest_legacy_event AS (
  SELECT DISTINCT ON (event.component, event.instance_id) event.*
    FROM executable_dead_man_event event
   WHERE event.expectation_generation IS NULL
   ORDER BY event.component, event.instance_id, event.checked_at DESC, event.created_at DESC
)
SELECT expected.component::text AS component,
       expected.instance_id::text AS instance_id,
       expected.expected_source_sha::text AS source_sha,
       COALESCE(expected.heartbeat_digest, expected.expectation_digest)::char(64)
         AS heartbeat_digest,
       COALESCE(expected.observed_at, expected.activated_at)::timestamptz AS observed_at,
       COALESCE(expected.deadline_at, expected.startup_deadline_at)::timestamptz AS deadline_at,
       COALESCE(expected.last_event_kind, expected.condition_code)::text AS last_event_kind,
       expected.state::text AS state,
       CASE WHEN expected.state = 'WATCHDOG_STALE' THEN 1 ELSE 0 END::integer
         AS active_obligation_count
  FROM executable_runtime_expected_liveness expected
UNION ALL
SELECT heartbeat.component::text,
       heartbeat.instance_id::text,
       heartbeat.source_sha::text,
       heartbeat.heartbeat_digest::char(64),
       heartbeat.observed_at::timestamptz,
       heartbeat.deadline_at::timestamptz,
       event.kind::text,
       CASE
         WHEN now() > heartbeat.deadline_at THEN 'WATCHDOG_STALE'
         WHEN event.kind = 'WATCHDOG_STALE' AND event.checked_at >= heartbeat.observed_at
           THEN 'WATCHDOG_STALE'
         ELSE 'HEALTHY'
       END::text,
       CASE
         WHEN now() > heartbeat.deadline_at
           OR (event.kind = 'WATCHDOG_STALE' AND event.checked_at >= heartbeat.observed_at)
         THEN 1 ELSE 0
       END::integer
  FROM latest_legacy_heartbeat heartbeat
  LEFT JOIN latest_legacy_event event USING (component, instance_id);

COMMENT ON TABLE completion_ack_coordinator_delivery_plan IS
  'Append-only, lease-fenced delivery intent. One plan per 0198 completion lease; successor leases may finish an unreceipted plan.';
COMMENT ON TABLE completion_ack_coordinator_delivery_receipt IS
  'Append-only proof that one exact COMPLETION_ACK_STALE wake opened the plan''s exact PROJECT_COORDINATOR Session.';
COMMENT ON TABLE completion_ack_coordinator_delivery_adoption IS
  'Append-only lease adoption of a delivery receipt; an attempt result can cite a receipt only through its own lease adoption.';
COMMENT ON TABLE completion_ack_remediation_action IS
  'Append-only bounded action evidence. Session/Task UUIDs are immutable snapshots so later deletion cannot erase attribution.';
COMMENT ON TABLE executable_runtime_expectation IS
  'Deployment-owned expected component generation; it must be appended before process start to expose the never-heartbeated state.';
COMMENT ON VIEW executable_runtime_active_expectation IS
  'Current expected generations reduced from immutable ACTIVATED/SUPERSEDED/RETIRED events.';
COMMENT ON VIEW executable_runtime_expected_liveness IS
  'Exact generation liveness including STARTING and never-heartbeated WATCHDOG_MISSING.';

COMMIT;
