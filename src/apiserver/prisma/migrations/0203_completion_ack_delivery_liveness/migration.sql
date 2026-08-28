-- Completion-ACK coordinator delivery liveness.
--
-- 0201 owns the canonical completion-ACK obligation and 0202 owns delivery.  This migration
-- adds the missing independent feedback edge: a delivered coordinator Session that stops making
-- durable progress is revoked by an append-only fact and the SAME 0198 coordination is requeued.
-- Polling is not progress.  A deadline is bound to a durable state fingerprint and is never
-- extended when a watchdog observes that same fingerprint again.

CREATE TABLE completion_ack_delivery_progress_event (
  event_id                    uuid        PRIMARY KEY,
  tenant_id                   uuid        NOT NULL,
  project_id                  uuid        NOT NULL,
  coordination_id             uuid        NOT NULL,
  obligation_id               char(64)    NOT NULL CHECK (outcome_valid_digest(obligation_id)),
  obligation_revision         char(64)    NOT NULL CHECK (outcome_valid_digest(obligation_revision)),
  delivery_receipt_id         uuid        NOT NULL,
  plan_id                     uuid        NOT NULL,
  coordinator_session_id      uuid        NOT NULL,
  event_kind                  text        NOT NULL CHECK (event_kind IN (
    'PROGRESS_OBSERVED', 'DELIVERY_REVOKED'
  )),
  progress_fingerprint        char(64)    NOT NULL CHECK (outcome_valid_digest(progress_fingerprint)),
  reason_code                 text        CHECK (reason_code IN (
    'DELIVERY_SESSION_MISSING',
    'DELIVERY_SESSION_FROZEN',
    'DELIVERY_SESSION_AWAITING_INPUT_WITHOUT_ACTION',
    'DELIVERY_SESSION_RETRY_EXPIRED',
    'DELIVERY_SESSION_FAILED_WITHOUT_RETRY',
    'DELIVERY_SESSION_TERMINATED_WITHOUT_ACTION'
  )),
  source_progress_at          timestamptz NOT NULL,
  deadline_at                 timestamptz NOT NULL,
  detection_delta_seconds     integer     NOT NULL CHECK (
    detection_delta_seconds BETWEEN 1 AND 86400
  ),
  source_observed_at          timestamptz NOT NULL,
  evidence                    jsonb       NOT NULL CHECK (
    jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 8192
  ),
  evidence_digest             char(64)    NOT NULL CHECK (outcome_valid_digest(evidence_digest)),
  event_digest                char(64)    NOT NULL UNIQUE CHECK (outcome_valid_digest(event_digest)),
  recorded_at                 timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (delivery_receipt_id, event_kind, progress_fingerprint),
  CHECK ((event_kind = 'PROGRESS_OBSERVED') = (reason_code IS NULL)),
  CHECK (deadline_at = source_progress_at
    + make_interval(secs => detection_delta_seconds)),
  CHECK (evidence_digest = outcome_sha256_json(evidence)),
  FOREIGN KEY (delivery_receipt_id)
    REFERENCES completion_ack_coordinator_delivery_receipt(delivery_receipt_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (plan_id)
    REFERENCES completion_ack_coordinator_delivery_plan(plan_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (coordination_id)
    REFERENCES outcome_coordinator_obligation(coordination_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (obligation_id, obligation_revision)
    REFERENCES completion_ack_obligation_revision(obligation_id, obligation_revision)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX completion_ack_delivery_one_revocation_idx
  ON completion_ack_delivery_progress_event(delivery_receipt_id)
  WHERE event_kind = 'DELIVERY_REVOKED';
CREATE INDEX completion_ack_delivery_progress_trace_idx
  ON completion_ack_delivery_progress_event(
    tenant_id, coordination_id, recorded_at DESC, event_id DESC
  );
CREATE INDEX completion_ack_delivery_progress_deadline_idx
  ON completion_ack_delivery_progress_event(event_kind, deadline_at, delivery_receipt_id);

CREATE TRIGGER completion_ack_delivery_progress_append_only
  BEFORE UPDATE OR DELETE ON completion_ack_delivery_progress_event
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();

-- This is cursor bookkeeping only: it decides which bounded rows are inspected next and has no
-- lifecycle or deadline authority.  Keeping one cyclic cursor prevents a stable healthy receipt
-- at the head of the index from starving later tenants.  The semantic history remains append-only
-- in completion_ack_delivery_progress_event.
CREATE TABLE completion_ack_delivery_reconcile_cursor (
  singleton_id                boolean     PRIMARY KEY DEFAULT true CHECK (singleton_id),
  last_delivery_receipt_id    uuid,
  scan_count                  bigint      NOT NULL DEFAULT 0 CHECK (scan_count >= 0),
  updated_at                  timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO completion_ack_delivery_reconcile_cursor(singleton_id) VALUES (true);

-- Produce one immutable, deterministic progress snapshot from the delivery's own durable facts.
-- It deliberately does not read acceptance admission/attempt tables and does not call the
-- monitored turn-complete transaction.  Session.updated_at is safe here because no watchdog poll
-- writes the coordinator Session; status/lease changes and event ingestion do.
CREATE OR REPLACE FUNCTION completion_ack_delivery_progress_snapshot(
  p_delivery_receipt_id uuid
) RETURNS TABLE (
  progress_fingerprint char(64),
  source_progress_at timestamptz,
  evidence jsonb,
  active_task_count bigint,
  open_owner_decision_count bigint,
  session_missing boolean,
  session_status text,
  engine_turn_active boolean,
  retry_at timestamptz
) LANGUAGE sql STABLE AS $$
  WITH receipt_scope AS (
    SELECT receipt.*
      FROM completion_ack_coordinator_delivery_receipt receipt
     WHERE receipt.delivery_receipt_id = p_delivery_receipt_id
  ), latest_event AS (
    SELECT event.id, event.session_id, event.seq, event.type, event.payload,
           event.created_at, event.ingested_at,
           event.ingested_by_runner_id, event.ingested_under_lease_generation
      FROM receipt_scope receipt
      JOIN LATERAL (
        SELECT candidate.*
          FROM run_event candidate
         WHERE candidate.session_id = receipt.session_id_snapshot
         ORDER BY candidate.seq DESC, candidate.ingested_at DESC NULLS LAST,
                  candidate.id DESC
         LIMIT 1
      ) event ON true
  ), latest_turn AS (
    SELECT turn.*
      FROM receipt_scope receipt
      JOIN LATERAL (
        SELECT candidate.*
          FROM conversation_turn candidate
         WHERE candidate.session_id = receipt.session_id_snapshot
         ORDER BY candidate.seq DESC, candidate.id DESC
         LIMIT 1
      ) turn ON true
  ), action_summary AS (
    SELECT count(action.action_id)::bigint AS action_count,
           max(action.recorded_at) AS latest_action_at
      FROM receipt_scope receipt
      LEFT JOIN completion_ack_remediation_action action
        ON action.tenant_id = receipt.tenant_id
       AND action.project_id = receipt.project_id
       AND action.coordination_id = receipt.coordination_id
       AND action.obligation_id = receipt.obligation_id
       AND action.obligation_revision = receipt.obligation_revision
  ), owner_decision_summary AS (
    SELECT count(request.request_id) FILTER (WHERE request.status = 'OPEN')::bigint
             AS open_owner_decision_count,
           max(greatest(request.created_at, request.decided_at)) AS latest_owner_decision_at
      FROM receipt_scope receipt
      LEFT JOIN outcome_coordinator_owner_decision_request request
        ON request.tenant_id = receipt.tenant_id
       AND request.project_id = receipt.project_id
       AND request.coordination_id = receipt.coordination_id
       AND request.obligation_revision = receipt.obligation_revision
  ), task_rows AS (
    SELECT DISTINCT action.task_id_snapshot AS task_id,
           remediation_task.status::text AS task_status,
           remediation_task.updated_at AS task_updated_at
      FROM receipt_scope receipt
      JOIN completion_ack_remediation_action action
        ON action.tenant_id = receipt.tenant_id
       AND action.project_id = receipt.project_id
       AND action.coordination_id = receipt.coordination_id
       AND action.obligation_id = receipt.obligation_id
       AND action.obligation_revision = receipt.obligation_revision
      LEFT JOIN task remediation_task
        ON remediation_task.id = action.task_id_snapshot
       AND remediation_task.owner_id = action.tenant_id
  ), task_summary AS (
    SELECT count(*) FILTER (WHERE task_status IN ('OPEN', 'IN_PROGRESS'))::bigint
             AS active_task_count,
           max(task_updated_at) AS latest_task_at,
           count(*)::bigint AS total_task_count,
           count(*) FILTER (WHERE task_status = 'OPEN')::bigint AS open_task_count,
           count(*) FILTER (WHERE task_status = 'IN_PROGRESS')::bigint AS running_task_count,
           count(*) FILTER (WHERE task_status IN ('DONE', 'FAILED', 'CANCELLED'))::bigint
             AS settled_task_count,
           count(*) FILTER (WHERE task_status IS NULL)::bigint AS missing_task_count
      FROM task_rows
  ), bounded_task_states AS (
    SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'taskId', bounded.task_id::text,
             'status', COALESCE(bounded.task_status, 'TASK_MISSING'),
             'updatedAt', bounded.task_updated_at
           )) ORDER BY bounded.task_updated_at, bounded.task_id), '[]'::jsonb) AS task_states
      FROM (
        SELECT task_rows.*
          FROM task_rows
         ORDER BY task_updated_at DESC NULLS LAST, task_id DESC
         LIMIT 16
      ) bounded
  ), material AS (
    SELECT receipt.*,
           coordinator_session.id IS NULL AS session_missing,
           coordinator_session.status::text AS session_status,
           COALESCE(coordinator_session.engine_turn_active, false) AS engine_turn_active,
           coordinator_session.retry_at AT TIME ZONE 'UTC' AS retry_at,
           COALESCE(task_summary.active_task_count, 0)::bigint AS active_task_count,
           COALESCE(owner_decision_summary.open_owner_decision_count, 0)::bigint
             AS open_owner_decision_count,
           jsonb_strip_nulls(jsonb_build_object(
             'namespace', 'orbit.completion-ack.delivery-progress.v1',
             'deliveryReceiptId', receipt.delivery_receipt_id::text,
             'planId', receipt.plan_id::text,
             'obligationRevision', receipt.obligation_revision::text,
             'coordinatorSessionId', receipt.session_id_snapshot::text,
             'session', jsonb_build_object(
               'exists', coordinator_session.id IS NOT NULL,
               'status', coordinator_session.status::text,
               'engineTurnActive', COALESCE(coordinator_session.engine_turn_active, false),
               'lastTurnAt', coordinator_session.last_turn_at,
               'engineStartedAt', coordinator_session.engine_started_at,
               'finishedAt', coordinator_session.finished_at,
               'retryAt', coordinator_session.retry_at,
               'retryAttempts', coordinator_session.retry_attempts,
               'inboxLeaseGeneration', coordinator_session.inbox_lease_generation::text,
               'inboxLeaseOwner', coordinator_session.inbox_lease_owner::text,
               'updatedAt', coordinator_session.updated_at
             ),
             'latestRunEvent', CASE WHEN latest_event.id IS NULL THEN NULL ELSE
               jsonb_build_object(
                 'id', latest_event.id::text,
                 'seq', latest_event.seq,
                 'type', latest_event.type,
                 'ingestedAt', latest_event.ingested_at,
                 'sourceTime', latest_event.created_at,
                 'payloadDigest', outcome_sha256_json(latest_event.payload),
                 'runnerId', latest_event.ingested_by_runner_id::text,
                 'leaseGeneration', latest_event.ingested_under_lease_generation::text
               ) END,
             'latestConversationTurn', CASE WHEN latest_turn.id IS NULL THEN NULL ELSE
               jsonb_build_object(
                 'id', latest_turn.id::text,
                 'seq', latest_turn.seq,
                 'kind', latest_turn.kind,
                 'status', latest_turn.status,
                 'deliveredAt', latest_turn.delivered_at,
                 'answeredAt', latest_turn.answered_at,
                 'leaseGeneration', latest_turn.lease_generation::text,
                 'createdAt', latest_turn.created_at
               ) END,
             'remediationActionCount', COALESCE(action_summary.action_count, 0),
             'activeRemediationTaskCount', COALESCE(task_summary.active_task_count, 0),
             'openOwnerDecisionCount',
               COALESCE(owner_decision_summary.open_owner_decision_count, 0),
             'remediationTaskCount', COALESCE(task_summary.total_task_count, 0),
             'remediationTaskCounts', jsonb_build_object(
               'open', COALESCE(task_summary.open_task_count, 0),
               'inProgress', COALESCE(task_summary.running_task_count, 0),
               'settled', COALESCE(task_summary.settled_task_count, 0),
               'missing', COALESCE(task_summary.missing_task_count, 0)
             ),
             'remediationTasks', bounded_task_states.task_states,
             'remediationTasksTruncated', COALESCE(task_summary.total_task_count, 0) > 16
           )) AS snapshot,
           greatest(
             receipt.recorded_at,
             coordinator_session.updated_at AT TIME ZONE 'UTC',
             coordinator_session.last_turn_at AT TIME ZONE 'UTC',
             coordinator_session.engine_started_at AT TIME ZONE 'UTC',
             coordinator_session.finished_at AT TIME ZONE 'UTC',
             latest_event.ingested_at,
             latest_turn.created_at AT TIME ZONE 'UTC',
             latest_turn.delivered_at AT TIME ZONE 'UTC',
             latest_turn.answered_at AT TIME ZONE 'UTC',
             action_summary.latest_action_at,
             owner_decision_summary.latest_owner_decision_at,
             task_summary.latest_task_at AT TIME ZONE 'UTC'
           ) AS source_progress_at
      FROM receipt_scope receipt
      LEFT JOIN session coordinator_session
        ON coordinator_session.id = receipt.session_id_snapshot
       AND coordinator_session.owner_id = receipt.tenant_id
      LEFT JOIN latest_event ON latest_event.session_id = receipt.session_id_snapshot
      LEFT JOIN latest_turn ON latest_turn.session_id = receipt.session_id_snapshot
      CROSS JOIN action_summary
      CROSS JOIN owner_decision_summary
      CROSS JOIN task_summary
      CROSS JOIN bounded_task_states
  )
  SELECT outcome_sha256_json(material.snapshot)::char(64),
         material.source_progress_at,
         material.snapshot,
         material.active_task_count,
         material.open_owner_decision_count,
         material.session_missing,
         material.session_status,
         material.engine_turn_active,
         material.retry_at
    FROM material
$$;

COMMENT ON FUNCTION completion_ack_delivery_progress_snapshot(uuid) IS
  'Durable coordinator-delivery state fingerprint; repeated watchdog polls are absent by design.';

CREATE OR REPLACE FUNCTION completion_ack_delivery_progress_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_receipt completion_ack_coordinator_delivery_receipt%ROWTYPE;
  v_snapshot record;
  v_expected_digest char(64);
BEGIN
  SELECT * INTO v_receipt
    FROM completion_ack_coordinator_delivery_receipt receipt
   WHERE receipt.delivery_receipt_id = NEW.delivery_receipt_id
   FOR KEY SHARE;
  SELECT * INTO v_snapshot
    FROM completion_ack_delivery_progress_snapshot(NEW.delivery_receipt_id);
  IF NOT FOUND OR v_receipt.delivery_receipt_id IS NULL
     OR NEW.tenant_id IS DISTINCT FROM v_receipt.tenant_id
     OR NEW.project_id IS DISTINCT FROM v_receipt.project_id
     OR NEW.coordination_id IS DISTINCT FROM v_receipt.coordination_id
     OR NEW.obligation_id IS DISTINCT FROM v_receipt.obligation_id
     OR NEW.obligation_revision IS DISTINCT FROM v_receipt.obligation_revision
     OR NEW.plan_id IS DISTINCT FROM v_receipt.plan_id
     OR NEW.coordinator_session_id IS DISTINCT FROM v_receipt.session_id_snapshot
     OR NEW.progress_fingerprint IS DISTINCT FROM v_snapshot.progress_fingerprint
     OR NEW.source_progress_at IS DISTINCT FROM v_snapshot.source_progress_at
     OR NEW.evidence IS DISTINCT FROM v_snapshot.evidence
     OR NEW.evidence_digest IS DISTINCT FROM outcome_sha256_json(NEW.evidence) THEN
    RAISE EXCEPTION 'COMPLETION_ACK_DELIVERY_PROGRESS_SCOPE_INVALID:%', NEW.event_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  v_expected_digest := outcome_sha256_json(jsonb_build_array(
    'completion-ack-delivery-progress-event:v1', NEW.delivery_receipt_id::text,
    NEW.obligation_revision::text, NEW.event_kind, NEW.progress_fingerprint::text,
    COALESCE(NEW.reason_code, '')
  ));
  IF NEW.event_digest IS DISTINCT FROM v_expected_digest
     OR NEW.event_id IS DISTINCT FROM completion_ack_uuid_from_digest(v_expected_digest::text) THEN
    RAISE EXCEPTION 'COMPLETION_ACK_DELIVERY_PROGRESS_IDENTITY_INVALID:%', NEW.event_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER completion_ack_delivery_progress_insert_guard
  BEFORE INSERT ON completion_ack_delivery_progress_event
  FOR EACH ROW EXECUTE FUNCTION completion_ack_delivery_progress_insert_guard();

-- Select the latest raw receipt FIRST, then exclude it when revoked.  Applying the anti-join before
-- DISTINCT ON would silently fall back to an older receipt and restore authority to its Session.
CREATE OR REPLACE VIEW completion_ack_current_coordinator_delivery AS
WITH latest_receipt AS (
  SELECT DISTINCT ON (
           receipt.tenant_id, receipt.project_id,
           receipt.obligation_id, receipt.obligation_revision
         )
         receipt.*
    FROM completion_ack_coordinator_delivery_receipt receipt
    JOIN completion_ack_active_obligation active
      ON active.tenant_id = receipt.tenant_id
     AND active.project_id = receipt.project_id
     AND active.obligation_id = receipt.obligation_id
     AND active.obligation_revision = receipt.obligation_revision
   ORDER BY receipt.tenant_id, receipt.project_id,
            receipt.obligation_id, receipt.obligation_revision,
            receipt.recorded_at DESC, receipt.delivery_receipt_id DESC
)
SELECT receipt.tenant_id,
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
  FROM latest_receipt receipt
  LEFT JOIN session coordinator_session
    ON coordinator_session.id = receipt.session_id_snapshot
   AND coordinator_session.owner_id = receipt.tenant_id
 WHERE NOT EXISTS (
   SELECT 1
     FROM completion_ack_delivery_progress_event event
    WHERE event.delivery_receipt_id = receipt.delivery_receipt_id
      AND event.event_kind = 'DELIVERY_REVOKED'
 );

COMMENT ON VIEW completion_ack_current_coordinator_delivery IS
  'Latest receipt for an exact ACTIVE completion-ACK identity, iff not append-only revoked; never falls back to older delivery authority.';

-- Preserve the 0202 JSON contract and add an explicit revocation signal.  The resolver needs this
-- distinction: an unreceipted latest plan is a recoverable crash window, whereas a receipted AND
-- revoked latest plan must never be delivered again.
ALTER FUNCTION completion_ack_coordination_state(uuid, uuid)
  RENAME TO completion_ack_coordination_state_0202;

CREATE OR REPLACE FUNCTION completion_ack_coordination_state(
  p_tenant_id uuid,
  p_coordination_id uuid
) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_state jsonb;
  v_latest_receipt completion_ack_coordinator_delivery_receipt%ROWTYPE;
  v_revocation completion_ack_delivery_progress_event%ROWTYPE;
BEGIN
  v_state := completion_ack_coordination_state_0202(p_tenant_id, p_coordination_id);
  SELECT * INTO v_latest_receipt
    FROM completion_ack_coordinator_delivery_receipt receipt
   WHERE receipt.tenant_id = p_tenant_id
     AND receipt.coordination_id = p_coordination_id
     AND receipt.obligation_revision = v_state->>'obligationRevision'
   ORDER BY receipt.recorded_at DESC, receipt.delivery_receipt_id DESC
   LIMIT 1;
  IF FOUND THEN
    SELECT * INTO v_revocation
      FROM completion_ack_delivery_progress_event event
     WHERE event.delivery_receipt_id = v_latest_receipt.delivery_receipt_id
       AND event.event_kind = 'DELIVERY_REVOKED'
     ORDER BY event.recorded_at DESC, event.event_id DESC
     LIMIT 1;
  END IF;
  RETURN v_state || jsonb_build_object(
    'latestDeliveryRevoked', v_revocation.event_id IS NOT NULL,
    'latestDeliveryRevocation', CASE WHEN v_revocation.event_id IS NULL THEN NULL ELSE
      jsonb_build_object(
        'eventId', v_revocation.event_id::text,
        'deliveryReceiptId', v_revocation.delivery_receipt_id::text,
        'planId', v_revocation.plan_id::text,
        'coordinatorSessionId', v_revocation.coordinator_session_id::text,
        'progressFingerprint', v_revocation.progress_fingerprint::text,
        'reasonCode', v_revocation.reason_code,
        'sourceProgressAt', v_revocation.source_progress_at,
        'deadlineAt', v_revocation.deadline_at,
        'recordedAt', v_revocation.recorded_at
      ) END
  );
END;
$$;

-- Requeue only the exact latest revoked delivery.  The advisory lock is the shared authority
-- fence for revocation and the 0204 structured owner-decision child protocol: a decision request
-- cannot be authorized by a receipt that revokes between validation and insert.
CREATE OR REPLACE FUNCTION completion_ack_requeue_revoked_delivery(
  p_delivery_receipt_id uuid
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_receipt completion_ack_coordinator_delivery_receipt%ROWTYPE;
  v_standing outcome_coordinator_obligation%ROWTYPE;
  v_now bigint;
  v_wake jsonb;
BEGIN
  SELECT * INTO v_receipt
    FROM completion_ack_coordinator_delivery_receipt receipt
   WHERE receipt.delivery_receipt_id = p_delivery_receipt_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'COMPLETION_ACK_DELIVERY_RECEIPT_NOT_FOUND:%', p_delivery_receipt_id
      USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'completion-ack-delivery-authority:v1:' || v_receipt.obligation_revision::text, 0
  ));
  SELECT * INTO v_standing
    FROM outcome_coordinator_obligation standing
   WHERE standing.tenant_id = v_receipt.tenant_id
     AND standing.coordination_id = v_receipt.coordination_id
     AND standing.obligation_id = v_receipt.obligation_id
     AND standing.obligation_revision = v_receipt.obligation_revision
     AND standing.source_type = 'COMPLETION_ACK'
     AND standing.capability = 'completion-ack.recover'
   FOR UPDATE;
  IF NOT FOUND
     OR v_standing.status IN ('RESOLVED', 'SUPERSEDED', 'ESCALATED', 'TERMINAL')
     OR NOT EXISTS (
       SELECT 1 FROM completion_ack_coordinator_source source
        WHERE source.tenant_id = v_receipt.tenant_id
          AND source.project_id = v_receipt.project_id
          AND source.obligation_id = v_receipt.obligation_id
          AND source.obligation_revision = v_receipt.obligation_revision
     )
     OR NOT EXISTS (
       SELECT 1 FROM completion_ack_delivery_progress_event event
        WHERE event.delivery_receipt_id = v_receipt.delivery_receipt_id
          AND event.event_kind = 'DELIVERY_REVOKED'
     )
     OR EXISTS (
       SELECT 1 FROM completion_ack_coordinator_delivery_receipt newer
        WHERE newer.tenant_id = v_receipt.tenant_id
          AND newer.coordination_id = v_receipt.coordination_id
          AND newer.obligation_revision = v_receipt.obligation_revision
          AND (newer.recorded_at, newer.delivery_receipt_id)
            > (v_receipt.recorded_at, v_receipt.delivery_receipt_id)
     ) THEN
    RETURN jsonb_build_object(
      'deliveryReceiptId', p_delivery_receipt_id::text,
      'requeued', false,
      'reasonCode', 'DELIVERY_NO_LONGER_CURRENT_OR_ACTIVE'
    );
  END IF;
  v_now := outcome_coordinator_now(v_receipt.tenant_id);
  UPDATE outcome_coordinator_external_wait
     SET state = 'SUPERSEDED', updated_at = clock_timestamp()
   WHERE coordination_id = v_receipt.coordination_id AND state = 'ACTIVE';
  v_wake := completion_ack_schedule_coordinator_wake(
    v_receipt.coordination_id, v_now, 'COMPLETION_ACK_DELIVERY_REVOKED'
  );
  RETURN jsonb_build_object(
    'deliveryReceiptId', p_delivery_receipt_id::text,
    'coordinationId', v_receipt.coordination_id::text,
    'obligationId', v_receipt.obligation_id::text,
    'obligationRevision', v_receipt.obligation_revision::text,
    'requeued', COALESCE((v_wake->>'scheduled')::boolean, false),
    'wake', v_wake
  );
END;
$$;

CREATE OR REPLACE FUNCTION completion_ack_observe_coordinator_delivery(
  p_delivery_receipt_id uuid,
  p_source_observed_at timestamptz,
  p_detection_delta_seconds integer
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_receipt completion_ack_coordinator_delivery_receipt%ROWTYPE;
  v_snapshot record;
  v_progress_digest char(64);
  v_progress_event_id uuid;
  v_revocation_digest char(64);
  v_revocation_event_id uuid;
  v_reason text;
  v_deadline timestamptz;
  v_now timestamptz := statement_timestamp();
  v_rows bigint;
  v_progress_inserted boolean := false;
  v_revocation_inserted boolean := false;
  v_requeue jsonb := '{}'::jsonb;
BEGIN
  IF p_detection_delta_seconds IS NULL
     OR p_detection_delta_seconds NOT BETWEEN 1 AND 86400 THEN
    RAISE EXCEPTION 'COMPLETION_ACK_DELIVERY_DETECTION_DELTA_INVALID:%',
      p_detection_delta_seconds USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_receipt
    FROM completion_ack_coordinator_delivery_receipt receipt
   WHERE receipt.delivery_receipt_id = p_delivery_receipt_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'deliveryReceiptId', p_delivery_receipt_id::text,
      'observed', false, 'reasonCode', 'DELIVERY_RECEIPT_MISSING'
    );
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'completion-ack-delivery-authority:v1:' || v_receipt.obligation_revision::text, 0
  ));

  -- Re-read after the authority lock.  Only the latest receipt for the exact ACTIVE source can
  -- acquire or lose authority.  A prior revoked receipt must never be reconsidered.
  IF NOT EXISTS (
       SELECT 1 FROM completion_ack_coordinator_source source
        WHERE source.tenant_id = v_receipt.tenant_id
          AND source.project_id = v_receipt.project_id
          AND source.obligation_id = v_receipt.obligation_id
          AND source.obligation_revision = v_receipt.obligation_revision
     ) OR EXISTS (
       SELECT 1 FROM completion_ack_coordinator_delivery_receipt newer
        WHERE newer.tenant_id = v_receipt.tenant_id
          AND newer.coordination_id = v_receipt.coordination_id
          AND newer.obligation_revision = v_receipt.obligation_revision
          AND (newer.recorded_at, newer.delivery_receipt_id)
            > (v_receipt.recorded_at, v_receipt.delivery_receipt_id)
     ) OR EXISTS (
       SELECT 1 FROM completion_ack_delivery_progress_event event
        WHERE event.delivery_receipt_id = v_receipt.delivery_receipt_id
          AND event.event_kind = 'DELIVERY_REVOKED'
     ) THEN
    RETURN jsonb_build_object(
      'deliveryReceiptId', p_delivery_receipt_id::text,
      'observed', false, 'reasonCode', 'DELIVERY_NO_LONGER_CURRENT_OR_ACTIVE'
    );
  END IF;

  -- Session updates serialize event/turn ingestion in the API.  Holding this row while the two
  -- facts are checked keeps the snapshot and insert guard on one real progress frontier.
  PERFORM coordinator_session.id
    FROM session coordinator_session
   WHERE coordinator_session.id = v_receipt.session_id_snapshot
     AND coordinator_session.owner_id = v_receipt.tenant_id
   FOR SHARE;
  SELECT * INTO v_snapshot
    FROM completion_ack_delivery_progress_snapshot(v_receipt.delivery_receipt_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'COMPLETION_ACK_DELIVERY_PROGRESS_SNAPSHOT_MISSING:%',
      v_receipt.delivery_receipt_id USING ERRCODE = 'no_data_found';
  END IF;
  v_deadline := v_snapshot.source_progress_at
    + make_interval(secs => p_detection_delta_seconds);
  v_progress_digest := outcome_sha256_json(jsonb_build_array(
    'completion-ack-delivery-progress-event:v1', v_receipt.delivery_receipt_id::text,
    v_receipt.obligation_revision::text, 'PROGRESS_OBSERVED',
    v_snapshot.progress_fingerprint::text, ''
  ));
  v_progress_event_id := completion_ack_uuid_from_digest(v_progress_digest::text);
  INSERT INTO completion_ack_delivery_progress_event(
    event_id, tenant_id, project_id, coordination_id, obligation_id,
    obligation_revision, delivery_receipt_id, plan_id, coordinator_session_id,
    event_kind, progress_fingerprint, reason_code, source_progress_at, deadline_at,
    detection_delta_seconds, source_observed_at, evidence, evidence_digest, event_digest
  ) VALUES (
    v_progress_event_id, v_receipt.tenant_id, v_receipt.project_id,
    v_receipt.coordination_id, v_receipt.obligation_id, v_receipt.obligation_revision,
    v_receipt.delivery_receipt_id, v_receipt.plan_id, v_receipt.session_id_snapshot,
    'PROGRESS_OBSERVED', v_snapshot.progress_fingerprint, NULL,
    v_snapshot.source_progress_at, v_deadline, p_detection_delta_seconds,
    p_source_observed_at, v_snapshot.evidence,
    outcome_sha256_json(v_snapshot.evidence), v_progress_digest
  ) ON CONFLICT (delivery_receipt_id, event_kind, progress_fingerprint) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_progress_inserted := v_rows > 0;

  v_reason := CASE
    WHEN v_snapshot.active_task_count > 0 THEN NULL
    WHEN v_snapshot.open_owner_decision_count > 0 THEN NULL
    WHEN v_snapshot.session_missing THEN 'DELIVERY_SESSION_MISSING'
    WHEN v_snapshot.engine_turn_active
      OR v_snapshot.session_status IN ('PENDING', 'RUNNING', 'INTERRUPTED')
      THEN 'DELIVERY_SESSION_FROZEN'
    WHEN v_snapshot.session_status = 'AWAITING_INPUT'
      THEN 'DELIVERY_SESSION_AWAITING_INPUT_WITHOUT_ACTION'
    WHEN v_snapshot.session_status = 'FAILED' AND v_snapshot.retry_at IS NULL
      THEN 'DELIVERY_SESSION_FAILED_WITHOUT_RETRY'
    WHEN v_snapshot.session_status = 'FAILED' AND v_snapshot.retry_at <= v_now
      THEN 'DELIVERY_SESSION_RETRY_EXPIRED'
    WHEN v_snapshot.session_status IN ('SUCCEEDED', 'CANCELLED', 'PARKED')
      THEN 'DELIVERY_SESSION_TERMINATED_WITHOUT_ACTION'
    ELSE NULL
  END;

  IF v_reason IS NOT NULL AND v_deadline <= v_now THEN
    v_revocation_digest := outcome_sha256_json(jsonb_build_array(
      'completion-ack-delivery-progress-event:v1', v_receipt.delivery_receipt_id::text,
      v_receipt.obligation_revision::text, 'DELIVERY_REVOKED',
      v_snapshot.progress_fingerprint::text, v_reason
    ));
    v_revocation_event_id := completion_ack_uuid_from_digest(v_revocation_digest::text);
    INSERT INTO completion_ack_delivery_progress_event(
      event_id, tenant_id, project_id, coordination_id, obligation_id,
      obligation_revision, delivery_receipt_id, plan_id, coordinator_session_id,
      event_kind, progress_fingerprint, reason_code, source_progress_at, deadline_at,
      detection_delta_seconds, source_observed_at, evidence, evidence_digest, event_digest
    ) VALUES (
      v_revocation_event_id, v_receipt.tenant_id, v_receipt.project_id,
      v_receipt.coordination_id, v_receipt.obligation_id, v_receipt.obligation_revision,
      v_receipt.delivery_receipt_id, v_receipt.plan_id, v_receipt.session_id_snapshot,
      'DELIVERY_REVOKED', v_snapshot.progress_fingerprint, v_reason,
      v_snapshot.source_progress_at, v_deadline, p_detection_delta_seconds,
      p_source_observed_at, v_snapshot.evidence,
      outcome_sha256_json(v_snapshot.evidence), v_revocation_digest
    ) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_revocation_inserted := v_rows > 0;
    IF v_revocation_inserted THEN
      v_requeue := completion_ack_requeue_revoked_delivery(v_receipt.delivery_receipt_id);
    END IF;
  END IF;
  RETURN jsonb_build_object(
    'deliveryReceiptId', v_receipt.delivery_receipt_id::text,
    'coordinationId', v_receipt.coordination_id::text,
    'obligationId', v_receipt.obligation_id::text,
    'obligationRevision', v_receipt.obligation_revision::text,
    'observed', true,
    'progressFingerprint', v_snapshot.progress_fingerprint::text,
    'sourceProgressAt', v_snapshot.source_progress_at,
    'deadlineAt', v_deadline,
    'progressFactInserted', v_progress_inserted,
    'candidateReason', v_reason,
    'revocationInserted', v_revocation_inserted,
    'requeue', v_requeue
  );
END;
$$;

CREATE OR REPLACE FUNCTION completion_ack_reconcile_stale_deliveries(
  p_source_observed_at timestamptz,
  p_detection_delta_seconds integer,
  p_limit integer DEFAULT 64
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_cursor completion_ack_delivery_reconcile_cursor%ROWTYPE;
  v_candidate record;
  v_result jsonb;
  v_last uuid;
  v_scanned integer := 0;
  v_progress_facts integer := 0;
  v_revocations integer := 0;
  v_requeues integer := 0;
BEGIN
  IF p_detection_delta_seconds IS NULL
     OR p_detection_delta_seconds NOT BETWEEN 1 AND 86400 THEN
    RAISE EXCEPTION 'COMPLETION_ACK_DELIVERY_DETECTION_DELTA_INVALID:%',
      p_detection_delta_seconds USING ERRCODE = 'check_violation';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'COMPLETION_ACK_DELIVERY_RECONCILE_LIMIT_INVALID:%', p_limit
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO STRICT v_cursor
    FROM completion_ack_delivery_reconcile_cursor
   WHERE singleton_id = true FOR UPDATE;

  FOR v_candidate IN
    WITH latest_receipt AS (
      SELECT DISTINCT ON (
               receipt.tenant_id, receipt.project_id,
               receipt.obligation_id, receipt.obligation_revision
             ) receipt.*
        FROM completion_ack_coordinator_delivery_receipt receipt
        JOIN completion_ack_coordinator_source source
          ON source.tenant_id = receipt.tenant_id
         AND source.project_id = receipt.project_id
         AND source.obligation_id = receipt.obligation_id
         AND source.obligation_revision = receipt.obligation_revision
       ORDER BY receipt.tenant_id, receipt.project_id,
                receipt.obligation_id, receipt.obligation_revision,
                receipt.recorded_at DESC, receipt.delivery_receipt_id DESC
    )
    SELECT receipt.delivery_receipt_id
      FROM latest_receipt receipt
     WHERE NOT EXISTS (
       SELECT 1 FROM completion_ack_delivery_progress_event event
        WHERE event.delivery_receipt_id = receipt.delivery_receipt_id
          AND event.event_kind = 'DELIVERY_REVOKED'
     )
     ORDER BY CASE
       WHEN v_cursor.last_delivery_receipt_id IS NULL
         OR receipt.delivery_receipt_id > v_cursor.last_delivery_receipt_id THEN 0 ELSE 1
     END, receipt.delivery_receipt_id
     LIMIT p_limit
  LOOP
    v_scanned := v_scanned + 1;
    v_last := v_candidate.delivery_receipt_id;
    v_result := completion_ack_observe_coordinator_delivery(
      v_candidate.delivery_receipt_id,
      p_source_observed_at,
      p_detection_delta_seconds
    );
    IF COALESCE((v_result->>'progressFactInserted')::boolean, false) THEN
      v_progress_facts := v_progress_facts + 1;
    END IF;
    IF COALESCE((v_result->>'revocationInserted')::boolean, false) THEN
      v_revocations := v_revocations + 1;
    END IF;
    IF COALESCE((v_result->'requeue'->>'requeued')::boolean, false) THEN
      v_requeues := v_requeues + 1;
    END IF;
  END LOOP;
  UPDATE completion_ack_delivery_reconcile_cursor
     SET last_delivery_receipt_id = COALESCE(v_last, last_delivery_receipt_id),
         scan_count = scan_count + v_scanned,
         updated_at = clock_timestamp()
   WHERE singleton_id = true;
  RETURN jsonb_build_object(
    'databaseRecordedAt', statement_timestamp(),
    'sourceObservedAt', p_source_observed_at,
    'clockAuthority', 'DATABASE_RECORDED_AT',
    'scannedDeliveryCount', v_scanned,
    'newProgressFactCount', v_progress_facts,
    'revokedDeliveryCount', v_revocations,
    'requeuedCoordinationCount', v_requeues,
    'lastDeliveryReceiptId', v_last::text
  );
END;
$$;

COMMENT ON FUNCTION completion_ack_reconcile_stale_deliveries(timestamptz, integer, integer) IS
  'Independent bounded delivery watchdog: durable fingerprints fix deadlines; stale latest receipts revoke once and requeue the same 0198 coordination.';
