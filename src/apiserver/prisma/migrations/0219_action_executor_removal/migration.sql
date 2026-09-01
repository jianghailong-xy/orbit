-- Remove the constrained Action Executor.
--
-- 0196_outcome_constrained_action_executor built a queue, budget ledger, lease/attempt trace,
-- receipt store, fairness cursor and an executor-owned obligation set for side-effecting
-- resolvers. Nothing ever enqueued an action: on 2026-09-01 every one of its thirteen tables
-- held zero rows, and the only non-test caller was the coordinator branch removed below. This
-- migration deletes the machinery rather than keeping a second, unexercised obligation lifecycle
-- alive beside the canonical one.
--
-- What is deliberately NOT touched: outcome_canonical_fact, outcome_obligation and the DONE gate,
-- task_executable_attempt / task_executable_admission, and every project_acceptance_* relation.
-- outcome_coordinator_obligation keeps its nullable action_intent_id column: it belongs to the
-- coordinator, carries no foreign key into anything dropped here, and after this migration simply
-- stays NULL.
BEGIN;

-- The executor-owned half of the canonical active-obligation view. Nothing selects from it.
DROP VIEW outcome_canonical_active_obligation;

-- Children first; PostgreSQL drops each table's triggers, indexes and constraints with it.
DROP TABLE outcome_executor_obligation_event;
DROP TABLE outcome_executor_active_obligation;
DROP TABLE outcome_executor_obligation_revision;
DROP TABLE outcome_action_event;
DROP TABLE outcome_action_failure_fingerprint;
DROP TABLE outcome_action_receipt;
DROP TABLE outcome_action_attempt;
DROP TABLE outcome_action_diagnostic;
DROP TABLE outcome_action_intent;
DROP TABLE outcome_action_budget_account;
DROP TABLE outcome_action_precondition;
DROP TABLE outcome_action_project_fairness;
DROP TABLE outcome_action_scheduler;

DROP FUNCTION outcome_record_action_diagnostic(uuid, uuid, text, text, text, jsonb, jsonb);
DROP FUNCTION outcome_assert_action_commit_fence(uuid, uuid, uuid);
DROP FUNCTION outcome_fail_claimed_action_diagnosis(uuid, uuid, uuid, text, bigint);
DROP FUNCTION outcome_finish_action_commit(uuid, uuid, uuid, jsonb, jsonb, bigint);
DROP FUNCTION outcome_begin_action_commit(uuid, uuid, uuid, text, bigint);
DROP FUNCTION outcome_claim_next_action(uuid, text, bigint, bigint);
DROP FUNCTION outcome_sweep_action_queue(uuid, bigint);
DROP FUNCTION outcome_enqueue_action(uuid, uuid, jsonb, jsonb, bigint[], bigint, bigint);
DROP FUNCTION outcome_resolve_executor_obligation(uuid, bigint, text);
DROP FUNCTION outcome_activate_executor_obligation(uuid, text, bigint, bigint, jsonb);
DROP FUNCTION outcome_register_action_precondition(uuid, uuid, text, text, text, text);
DROP FUNCTION outcome_register_action_budget(uuid, uuid, text, text, text, numeric);
DROP FUNCTION outcome_append_action_event(uuid, integer, text, text, text, bigint, jsonb);

DROP FUNCTION outcome_action_committing_guard();

-- The persistent coordinator reconciled two obligation sources. 0202 renamed the 0198 body to
-- outcome_reconcile_active_obligations_0198 and wrapped it, so the executor union is replaced
-- here rather than in the wrapper. Only the canonical evaluator source remains.
CREATE OR REPLACE FUNCTION outcome_reconcile_active_obligations_0198(
  p_tenant_id uuid,
  p_liveness_delta bigint,
  p_attempt_budget integer,
  p_wake_budget integer,
  p_same_failure_fingerprint_limit integer,
  p_max_lease_renewals integer DEFAULT 1
) RETURNS jsonb AS $$
DECLARE
  source_value record;
  standing outcome_coordinator_obligation%ROWTYPE;
  now_value bigint;
  registered_count integer := 0;
  replayed_count integer := 0;
  superseded_count integer := 0;
  receipt jsonb;
BEGIN
  now_value := outcome_coordinator_now(p_tenant_id);
  FOR source_value IN
    SELECT a.project_id, 'CANONICAL'::text AS source_type,
           a.obligation_id::text AS source_key, a.obligation
      FROM outcome_active_obligation a
     WHERE a.tenant_id = p_tenant_id
     ORDER BY project_id, source_type, source_key
  LOOP
    receipt := outcome_register_coordinator_obligation(
      p_tenant_id, source_value.project_id, source_value.source_type,
      source_value.source_key, source_value.obligation, p_liveness_delta,
      p_attempt_budget, p_wake_budget, p_same_failure_fingerprint_limit,
      p_max_lease_renewals
    );
    registered_count := registered_count + 1;
    IF receipt->>'replayed' = 'true' THEN replayed_count := replayed_count + 1; END IF;
  END LOOP;

  FOR standing IN
    SELECT * FROM outcome_coordinator_obligation c
     WHERE c.tenant_id = p_tenant_id
       AND c.status IN ('READY', 'CLAIMED', 'SCHEDULED', 'EXTERNAL_WAIT', 'OWNER_DECISION')
       AND (
         (c.source_type = 'CANONICAL' AND NOT EXISTS (
           SELECT 1 FROM outcome_active_obligation a
            WHERE a.tenant_id = c.tenant_id AND a.project_id = c.project_id
              AND a.obligation_id = c.obligation_id
              AND a.obligation_revision = c.obligation_revision
         ))
       )
     ORDER BY c.project_id, c.queue_sequence
     FOR UPDATE
  LOOP
    PERFORM outcome_terminalize_coordination(
      standing.coordination_id,
      'SUPERSEDED',
      'SOURCE_OBLIGATION_NO_LONGER_ACTIVE',
      'SUPERSEDE',
      now_value,
      jsonb_build_object('sourceType', standing.source_type, 'sourceKey', standing.source_key)
    );
    superseded_count := superseded_count + 1;
  END LOOP;
  RETURN jsonb_build_object(
    'logicalNow', now_value::text,
    'registered', registered_count,
    'replayed', replayed_count,
    'superseded', superseded_count
  );
END;
$$ LANGUAGE plpgsql;

-- ACTION_ENQUEUED was the coordinator's one effectful reply: it demanded a matching admitted
-- outcome_action_intent row before delivery could be recorded. With no executor to admit one, the
-- result kind is refused rather than accepted with nothing behind it. 0202 renamed this body too.
CREATE OR REPLACE FUNCTION outcome_record_coordinator_result_0198(
  p_tenant_id uuid,
  p_coordination_id uuid,
  p_lease_token uuid,
  p_worker_id text,
  p_callback_key text,
  p_result text,
  p_failure_fingerprint text DEFAULT NULL,
  p_retry_after bigint DEFAULT NULL,
  p_detail jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb AS $$
DECLARE
  standing outcome_coordinator_obligation%ROWTYPE;
  lease_value outcome_coordinator_lease%ROWTYPE;
  previous outcome_coordinator_attempt_result%ROWTYPE;
  wait_value outcome_coordinator_external_wait%ROWTYPE;
  now_value bigint;
  delay_value bigint;
  condition_value jsonb;
  condition_digest_value text;
  poll_budget_value integer;
  poll_remaining_value integer;
  wait_id_value uuid;
  wake_receipt jsonb;
  transition_receipt jsonb;
BEGIN
  IF COALESCE(p_worker_id, '') = '' OR COALESCE(p_callback_key, '') = ''
     OR p_result NOT IN (
       'DELIVERED', 'RETRYABLE_FAILURE', 'QUOTA_WAIT', 'EXTERNAL_WAIT',
       'RESOLVED', 'SUPERSEDED', 'ESCALATED', 'TERMINAL'
     ) OR jsonb_typeof(p_detail) <> 'object' THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_RESULT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF (p_result = 'RETRYABLE_FAILURE')
     <> (p_failure_fingerprint IS NOT NULL
       AND COALESCE(outcome_valid_digest(p_failure_fingerprint), false)) THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_FAILURE_FINGERPRINT_INVALID' USING ERRCODE = '22023';
  END IF;
  now_value := outcome_coordinator_now(p_tenant_id);
  SELECT * INTO previous
    FROM outcome_coordinator_attempt_result
   WHERE tenant_id = p_tenant_id AND callback_key = p_callback_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'coordinationId', previous.coordination_id::text,
      'result', previous.result,
      'replayed', true
    );
  END IF;
  SELECT * INTO standing
    FROM outcome_coordinator_obligation
   WHERE tenant_id = p_tenant_id AND coordination_id = p_coordination_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_OBLIGATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF standing.status <> 'CLAIMED' OR standing.lease_token IS DISTINCT FROM p_lease_token
     OR standing.lease_owner IS DISTINCT FROM p_worker_id
     OR standing.lease_expires_logical_time < now_value THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_LEASE_STALE' USING ERRCODE = '40001';
  END IF;
  SELECT * INTO lease_value
    FROM outcome_coordinator_lease
   WHERE lease_id = standing.lease_id AND lease_token = p_lease_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_LEASE_EVIDENCE_MISSING' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO previous
    FROM outcome_coordinator_attempt_result
   WHERE lease_id = lease_value.lease_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'coordinationId', previous.coordination_id::text,
      'result', previous.result,
      'replayed', true
    );
  END IF;

  INSERT INTO outcome_coordinator_attempt_result (
    result_id, tenant_id, project_id, coordination_id, lease_id,
    obligation_revision, callback_key, result, failure_fingerprint,
    detail, logical_time
  ) VALUES (
    gen_random_uuid(), standing.tenant_id, standing.project_id, standing.coordination_id,
    lease_value.lease_id, standing.obligation_revision, p_callback_key, p_result,
    p_failure_fingerprint, p_detail, now_value
  );
  UPDATE outcome_coordinator_obligation
     SET last_progress_logical_time = now_value,
         progress_deadline_logical_time = now_value + liveness_delta,
         updated_at = clock_timestamp()
   WHERE coordination_id = standing.coordination_id;

  IF p_result = 'RETRYABLE_FAILURE' THEN
    delay_value := COALESCE(p_retry_after, GREATEST(1, standing.attempt_count));
    RETURN outcome_apply_coordinator_failure(
      standing.coordination_id,
      p_failure_fingerprint,
      'ATTEMPT_RETRYABLE_FAILURE',
      now_value,
      delay_value,
      p_detail || jsonb_build_object('leaseId', lease_value.lease_id::text)
    );
  ELSIF p_result IN ('QUOTA_WAIT', 'EXTERNAL_WAIT') THEN
    IF COALESCE(p_detail->>'provider', '') = ''
       OR NOT (p_detail ? 'condition')
       OR COALESCE(p_detail->>'pollBudget', '') !~ '^[1-9][0-9]*$'
       OR p_retry_after IS NULL OR p_retry_after <= 0 THEN
      RAISE EXCEPTION 'OUTCOME_COORDINATOR_EXTERNAL_WAIT_INVALID' USING ERRCODE = '22023';
    END IF;
    IF p_retry_after > standing.liveness_delta THEN
      RAISE EXCEPTION 'OUTCOME_COORDINATOR_EXTERNAL_WAIT_OUTSIDE_LIVENESS_BOUND'
        USING ERRCODE = '22023';
    END IF;
    condition_value := p_detail->'condition';
    condition_digest_value := outcome_sha256_json(condition_value);
    poll_budget_value := (p_detail->>'pollBudget')::integer;
    SELECT * INTO wait_value
      FROM outcome_coordinator_external_wait
     WHERE coordination_id = standing.coordination_id
       AND obligation_revision = standing.obligation_revision
       AND state = 'ACTIVE'
     ORDER BY created_at DESC LIMIT 1
     FOR UPDATE;
    IF FOUND THEN
      poll_budget_value := wait_value.poll_budget_max;
      poll_remaining_value := wait_value.poll_budget_remaining - 1;
      IF wait_value.condition_digest::text <> condition_digest_value THEN
        UPDATE outcome_coordinator_external_wait
           SET state = 'SUPERSEDED', updated_at = clock_timestamp()
         WHERE wait_id = wait_value.wait_id;
        wait_value.wait_id := NULL;
      END IF;
    ELSE
      poll_remaining_value := poll_budget_value - 1;
    END IF;
    IF poll_remaining_value < 0 THEN
      UPDATE outcome_coordinator_obligation
         SET diagnostic_path = 'EXTERNAL_WAIT_BUDGET_EXHAUSTED'
       WHERE coordination_id = standing.coordination_id;
      RETURN outcome_terminalize_coordination(
        standing.coordination_id,
        'ESCALATED',
        'EXTERNAL_WAIT_BUDGET_EXHAUSTED',
        'ESCALATE',
        now_value,
        jsonb_build_object('provider', p_detail->>'provider', 'condition', condition_value)
      );
    END IF;
    wait_id_value := COALESCE(wait_value.wait_id, gen_random_uuid());
    INSERT INTO outcome_coordinator_external_wait (
      wait_id, tenant_id, project_id, coordination_id, obligation_revision,
      provider, condition, condition_digest, poll_budget_max, poll_budget_remaining,
      next_poll_logical_time, state
    ) VALUES (
      wait_id_value, standing.tenant_id, standing.project_id, standing.coordination_id,
      standing.obligation_revision, p_detail->>'provider', condition_value,
      condition_digest_value, poll_budget_value, poll_remaining_value,
      now_value + p_retry_after, 'ACTIVE'
    ) ON CONFLICT (coordination_id, obligation_revision, condition_digest) DO UPDATE SET
      provider = EXCLUDED.provider,
      poll_budget_remaining = EXCLUDED.poll_budget_remaining,
      next_poll_logical_time = EXCLUDED.next_poll_logical_time,
      state = 'ACTIVE', updated_at = clock_timestamp()
    RETURNING wait_id INTO wait_id_value;
    UPDATE outcome_coordinator_obligation
       SET durable_owner = 'SYSTEM', external_wait_id = wait_id_value,
           diagnostic_path = CASE WHEN p_result = 'QUOTA_WAIT'
             THEN 'QUOTA_MONITOR' ELSE 'EXTERNAL_MONITOR' END,
           updated_at = clock_timestamp()
     WHERE coordination_id = standing.coordination_id;
    PERFORM outcome_append_coordinator_event(
      standing.coordination_id,
      'external-wait:' || wait_id_value::text || ':' || poll_remaining_value::text,
      CASE WHEN p_result = 'QUOTA_WAIT' THEN 'QUOTA_WAIT_OBSERVED'
        ELSE 'EXTERNAL_WAIT_OBSERVED' END,
      'CLAIMED',
      'EXTERNAL_WAIT',
      'EXTERNAL_WAIT',
      now_value,
      NULL,
      jsonb_build_object(
        'provider', p_detail->>'provider',
        'conditionDigest', condition_digest_value,
        'pollBudgetRemaining', poll_remaining_value,
        'ownerNotified', false
      )
    );
    wake_receipt := outcome_schedule_coordinator_wake(
      standing.coordination_id,
      now_value + p_retry_after,
      CASE WHEN p_result = 'QUOTA_WAIT' THEN 'QUOTA_RECHECK_DUE'
        ELSE 'EXTERNAL_RECHECK_DUE' END,
      'EXTERNAL_WAIT'
    );
    RETURN jsonb_build_object(
      'coordinationId', standing.coordination_id::text,
      'status', COALESCE(wake_receipt->>'status', 'EXTERNAL_WAIT'),
      'durableOwner', 'SYSTEM',
      'ownerNotified', false,
      'waitId', wait_id_value::text,
      'pollBudgetRemaining', poll_remaining_value,
      'wake', wake_receipt,
      'replayed', false
    );
  ELSIF p_result = 'DELIVERED' THEN
    UPDATE outcome_coordinator_obligation
       SET diagnostic_path = 'DELIVERY_FOLLOWUP',
           updated_at = clock_timestamp()
     WHERE coordination_id = standing.coordination_id;
    PERFORM outcome_append_coordinator_event(
      standing.coordination_id,
      'attempt-delivery:' || lease_value.lease_id::text,
      'ATTEMPT_DELIVERED',
      'CLAIMED',
      'SCHEDULED',
      'EXTERNAL_DELIVERY',
      now_value,
      NULL,
      p_detail
    );
    wake_receipt := outcome_schedule_coordinator_wake(
      standing.coordination_id,
      now_value + LEAST(1, standing.liveness_delta),
      'DELIVERY_REEVALUATION_DUE',
      'SCHEDULED'
    );
    RETURN jsonb_build_object(
      'coordinationId', standing.coordination_id::text,
      'status', COALESCE(wake_receipt->>'status', 'SCHEDULED'),
      'result', p_result,
      'wake', wake_receipt,
      'replayed', false
    );
  ELSIF p_result = 'RESOLVED' THEN
    transition_receipt := outcome_terminalize_coordination(
      standing.coordination_id, 'RESOLVED', 'OBLIGATION_RESOLVED',
      'TERMINAL_DISPOSITION', now_value, p_detail
    );
  ELSIF p_result = 'SUPERSEDED' THEN
    transition_receipt := outcome_terminalize_coordination(
      standing.coordination_id, 'SUPERSEDED', 'OBLIGATION_SUPERSEDED',
      'SUPERSEDE', now_value, p_detail
    );
  ELSIF p_result = 'ESCALATED' THEN
    transition_receipt := outcome_terminalize_coordination(
      standing.coordination_id, 'ESCALATED', 'AGENT_ESCALATION_RECORDED',
      'ESCALATE', now_value, p_detail
    );
  ELSE
    transition_receipt := outcome_terminalize_coordination(
      standing.coordination_id, 'TERMINAL', 'EXPLICIT_TERMINAL_DISPOSITION',
      'TERMINAL_DISPOSITION', now_value, p_detail
    );
  END IF;
  RETURN transition_receipt || jsonb_build_object('result', p_result, 'replayed', false);
END;
$$ LANGUAGE plpgsql;

COMMIT;
