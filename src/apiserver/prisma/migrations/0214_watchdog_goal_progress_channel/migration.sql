-- Give the independent watchdog a progress dimension, on a signal source the self-correction
-- channel does not share.
--
-- The collector could already prove the reconciler was alive: heartbeat sequence advancing,
-- projection CURRENT, no stale attempts, dead-man green.  It could not observe whether the goal
-- those components exist to advance was still moving, so a target that stopped moving entirely
-- reported healthy for three days.  Progress is added here as a new dimension; every existing
-- liveness probe is left exactly as it was.
--
-- The independence is structural, not a convention: the probes below read settlement and
-- engagement facts (coordinator obligation status, task status, typed acceptance exits, live
-- session status) and the watchdog's own append-only sample history.  They read nothing from the
-- convergence ledger or the failure-fingerprint repeat counters, which is what lets the alarm keep
-- working when the self-correction channel is the thing that broke.

BEGIN;

ALTER TABLE outcome_watchdog.sample
  ADD COLUMN progress jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(progress) = 'object'),
  ADD COLUMN conclusions jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(conclusions) = 'array');

COMMENT ON COLUMN outcome_watchdog.sample.progress IS
  'Settled/outstanding/engaged goal work, counted independently of the self-correction channel.';
COMMENT ON COLUMN outcome_watchdog.sample.conclusions IS
  'Typed conclusions about the sample sequence. Kept out of alerts so an alert-fatigue conclusion cannot perturb the alert count it measures.';

-- Samples written before this migration were digested over the pre-progress body and the table is
-- append-only, so they cannot be rewritten to satisfy the wider formula.  The replacement is
-- therefore added NOT VALID: it binds every sample written from here on, and leaves the historical
-- rows asserting exactly what they were digested over.
ALTER TABLE outcome_watchdog.sample DROP CONSTRAINT sample_check;
ALTER TABLE outcome_watchdog.sample
  ADD CONSTRAINT sample_check CHECK (sample_digest = outcome_sha256_json(jsonb_build_object(
    'tenantId', tenant_id::text,
    'observedLogicalTime', observed_logical_time::text,
    'observedAt', to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'collectorSha', collector_sha::text,
    'targetSha', target_sha::text,
    'policyDigest', policy_digest::text,
    'projectionStatus', projection_status,
    'metrics', metrics,
    'snapshot', snapshot,
    'alerts', alerts,
    'progress', progress,
    'conclusions', conclusions
  ))) NOT VALID;

CREATE OR REPLACE FUNCTION outcome_watchdog.collect(
  p_authenticated_tenant uuid,
  p_tenant_id uuid,
  p_policy jsonb,
  p_collector_sha text,
  p_target_sha text,
  p_observed_at timestamptz DEFAULT clock_timestamp()
) RETURNS jsonb AS $$
DECLARE
  logical_now bigint;
  row_limit integer;
  checksum_limit integer;
  window_seconds integer;
  window_ticks bigint;
  watermark_limit bigint;
  active_limit bigint;
  outbox_age_limit numeric;
  inbox_age_limit numeric;
  retry_ratio_limit numeric;
  retry_cost_limit numeric;
  streams_examined integer := 0;
  watermark_lag bigint := 0;
  active_examined integer := 0;
  oldest_active bigint := 0;
  expired_examined integer := 0;
  expired_count integer := 0;
  dead_examined integer := 0;
  dead_count integer := 0;
  outbox_examined integer := 0;
  outbox_count integer := 0;
  oldest_outbox numeric := 0;
  scheduler_examined integer := 0;
  scheduler_starved integer := 0;
  retry_total integer := 0;
  retry_count integer := 0;
  retry_cost numeric := 0;
  inbox_examined integer := 0;
  inbox_count integer := 0;
  oldest_inbox numeric := 0;
  checksum_examined integer := 0;
  checksum_mismatch integer := 0;
  snapshot_value jsonb;
  metrics_value jsonb;
  alerts_value jsonb := '[]'::jsonb;
  projection_status_value text := 'CURRENT';
  policy_digest_value text;
  sample_digest_value text;
  sample_row outcome_watchdog.sample%ROWTYPE;
  retry_ratio numeric;
  progress_limit integer;
  history_limit integer;
  settled_obligations integer := 0;
  open_obligations integer := 0;
  engaged_obligations integer := 0;
  settled_tasks integer := 0;
  open_tasks integer := 0;
  running_sessions integer := 0;
  accepted_executions integer := 0;
  settled_units integer := 0;
  outstanding_units integer := 0;
  engaged_units integer := 0;
  alert_count integer := 0;
  progress_value jsonb;
  conclusions_value jsonb := '[]'::jsonb;
  flat_run integer := 0;
  flat_seconds numeric := 0;
  constant_run integer := 0;
  constant_seconds numeric := 0;
  flat_limit integer;
  flat_window numeric;
  minimum_alerts integer;
  constant_limit integer;
  constant_window numeric;
  progress_min_samples integer;
  constancy_min_samples integer;
  history_rows integer := 0;
  history_row record;
  previous_settled integer;
  previous_alerts integer;
  newest_at timestamptz;
  flat_at timestamptz;
  constant_at timestamptz;
  flat_open boolean := true;
  constant_open boolean := true;
BEGIN
  IF p_authenticated_tenant IS NULL OR p_authenticated_tenant <> p_tenant_id THEN
    RAISE EXCEPTION 'OUTCOME_WATCHDOG_TENANT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_collector_sha !~ '^[0-9a-f]{40}$' OR p_target_sha !~ '^[0-9a-f]{40}$' THEN
    RAISE EXCEPTION 'OUTCOME_WATCHDOG_RUNTIME_SHA_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF COALESCE((p_policy->>'schemaVersion')::integer, 0) <> 1
     OR jsonb_typeof(p_policy->'metrics') <> 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_policy->'metrics')) < 9 THEN
    RAISE EXCEPTION 'OUTCOME_WATCHDOG_POLICY_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_each(p_policy->'metrics') metric
     WHERE jsonb_typeof(metric.value->'window') <> 'object'
        OR COALESCE(metric.value->>'denominator', '') = ''
        OR COALESCE((metric.value->>'minSampleSize')::integer, 0) < 1
        OR metric.value->>'collectorSha' <> 'RUNTIME_REQUIRED'
        OR metric.value->>'targetSha' <> 'RUNTIME_REQUIRED'
        OR jsonb_typeof(metric.value->'abortThreshold') <> 'object'
  ) THEN
    RAISE EXCEPTION 'OUTCOME_WATCHDOG_METRIC_CONTRACT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_policy->'metrics'->'goalProgress' IS NULL
     OR p_policy->'metrics'->'alertConstancy' IS NULL
     OR jsonb_typeof(p_policy#>'{progressIndependence,forbiddenSignalSources}') <> 'array' THEN
    RAISE EXCEPTION 'OUTCOME_WATCHDOG_PROGRESS_CONTRACT_MISSING' USING ERRCODE = '22023';
  END IF;
  row_limit := LEAST(GREATEST((p_policy#>>'{collector,maximumRowsPerProbe}')::integer, 2), 1024);
  checksum_limit := LEAST(GREATEST((p_policy#>>'{collector,checksumSubjectsPerProbe}')::integer, 1), 256);
  window_seconds := (p_policy#>>'{metrics,retryCost,window,seconds}')::integer;
  window_ticks := (p_policy#>>'{metrics,retryCost,window,logicalTicks}')::bigint;
  watermark_limit := (p_policy#>>'{metrics,evaluatedThroughWatermarkLag,threshold,maximumLogicalTicks}')::bigint;
  active_limit := (p_policy#>>'{metrics,oldestActiveObligation,threshold,maximumLogicalTicksWithoutProgress}')::bigint;
  outbox_age_limit := (p_policy#>>'{metrics,outboxBacklog,threshold,maximumOldestAgeSeconds}')::numeric;
  inbox_age_limit := (p_policy#>>'{metrics,inboxAge,threshold,maximumOldestAgeSeconds}')::numeric;
  retry_ratio_limit := (p_policy#>>'{metrics,retryCost,threshold,maximumRetryRatio}')::numeric;
  retry_cost_limit := (p_policy#>>'{metrics,retryCost,threshold,maximumRetryCostUnits}')::numeric;
  progress_limit := LEAST(GREATEST(
    (p_policy#>>'{collector,progressUnitsPerProbe}')::integer, 1), 1048576);
  history_limit := LEAST(GREATEST(
    (p_policy#>>'{collector,progressHistorySamples}')::integer, 2), 64);
  flat_limit := (p_policy#>>'{metrics,goalProgress,threshold,maximumConsecutiveFlatSamples}')::integer;
  flat_window := (p_policy#>>'{metrics,goalProgress,threshold,minimumFlatWindowSeconds}')::numeric;
  progress_min_samples := (p_policy#>>'{metrics,goalProgress,minSampleSize}')::integer;
  minimum_alerts := (p_policy#>>'{metrics,alertConstancy,threshold,minimumAlertCount}')::integer;
  constant_limit :=
    (p_policy#>>'{metrics,alertConstancy,threshold,maximumConsecutiveIdenticalSamples}')::integer;
  constant_window :=
    (p_policy#>>'{metrics,alertConstancy,threshold,minimumConstantWindowSeconds}')::numeric;
  IF row_limit IS NULL OR checksum_limit IS NULL OR window_seconds <= 0 OR window_ticks <= 0
     OR progress_limit IS NULL OR history_limit IS NULL OR flat_limit IS NULL
     OR flat_window IS NULL OR progress_min_samples IS NULL OR minimum_alerts IS NULL
     OR constant_limit IS NULL OR constant_window IS NULL THEN
    RAISE EXCEPTION 'OUTCOME_WATCHDOG_POLICY_BOUND_INVALID' USING ERRCODE = '22023';
  END IF;
  constancy_min_samples := (p_policy#>>'{metrics,alertConstancy,minSampleSize}')::integer;
  SELECT COALESCE(c.logical_time, (
    SELECT max(last_logical_time) FROM outcome_fact_stream WHERE tenant_id = p_tenant_id
  ), 0) INTO logical_now
    FROM (SELECT 1) seed
    LEFT JOIN outcome_coordinator_clock c ON c.tenant_id = p_tenant_id;

  WITH recent AS (
    SELECT s.tenant_id, s.project_id, s.last_logical_time
      FROM outcome_fact_stream s
     WHERE s.tenant_id = p_tenant_id
     ORDER BY s.updated_at DESC, s.project_id
     LIMIT row_limit
  ), lagged AS (
    SELECT recent.*,
           (SELECT min(r.evaluated_through_logical_time)
              FROM outcome_projection.reconciler_state r
             WHERE r.tenant_id = recent.tenant_id AND r.project_id = recent.project_id) AS evaluated
      FROM recent
  )
  SELECT count(*)::integer,
         COALESCE(max(CASE WHEN evaluated IS NULL THEN last_logical_time
                           ELSE GREATEST(last_logical_time - evaluated, 0) END), 0)
    INTO streams_examined, watermark_lag FROM lagged;

  WITH bounded AS (
    SELECT last_progress_logical_time
      FROM outcome_coordinator_obligation
     WHERE tenant_id = p_tenant_id
       AND status IN ('READY', 'CLAIMED', 'SCHEDULED', 'EXTERNAL_WAIT', 'OWNER_DECISION')
     ORDER BY last_progress_logical_time, project_id, coordination_id
     LIMIT row_limit
  ) SELECT count(*)::integer,
           COALESCE(max(GREATEST(logical_now - last_progress_logical_time, 0)), 0)
      INTO active_examined, oldest_active FROM bounded;

  WITH bounded AS (
    SELECT lease_expires_logical_time
      FROM outcome_coordinator_obligation
     WHERE tenant_id = p_tenant_id AND status = 'CLAIMED'
       AND lease_expires_logical_time <= logical_now
     ORDER BY lease_expires_logical_time, project_id, coordination_id
     LIMIT row_limit
  ) SELECT count(*)::integer, count(*)::integer
      INTO expired_examined, expired_count FROM bounded;

  WITH bounded AS (
    SELECT wake_id FROM outcome_coordinator_wake
     WHERE tenant_id = p_tenant_id AND state = 'DEAD'
     ORDER BY due_logical_time, project_id, wake_id LIMIT row_limit
  ) SELECT count(*)::integer, count(*)::integer INTO dead_examined, dead_count FROM bounded;

  WITH bounded AS (
    SELECT o.occurred_at
      FROM outcome_projection.outbox o
      LEFT JOIN outcome_watchdog.inbox i
        ON i.tenant_id = o.tenant_id AND i.source_outbox_id = o.outbox_id
     WHERE o.tenant_id = p_tenant_id AND i.inbox_id IS NULL
     ORDER BY o.outbox_id LIMIT row_limit
  ) SELECT count(*)::integer, count(*)::integer,
           COALESCE(max(GREATEST(extract(epoch FROM (p_observed_at - occurred_at)), 0)), 0)
      INTO outbox_examined, outbox_count, oldest_outbox FROM bounded;

  WITH bounded AS (
    SELECT coordination_id
      FROM outcome_coordinator_obligation
     WHERE tenant_id = p_tenant_id
       AND (status = 'READY' OR (
         status = 'SCHEDULED' AND next_wake_logical_time <= logical_now
       ))
       AND logical_now - last_progress_logical_time > active_limit
     ORDER BY progress_deadline_logical_time, project_id, coordination_id
     LIMIT row_limit
  ) SELECT count(*)::integer, count(*)::integer
      INTO scheduler_examined, scheduler_starved FROM bounded;

  WITH bounded AS (
    SELECT result FROM outcome_coordinator_attempt_result
     WHERE tenant_id = p_tenant_id
       AND logical_time >= GREATEST(logical_now - window_ticks, 0)
     ORDER BY logical_time DESC, result_id LIMIT row_limit
  ) SELECT count(*)::integer,
           count(*) FILTER (WHERE result = 'RETRYABLE_FAILURE')::integer,
           count(*) FILTER (WHERE result = 'RETRYABLE_FAILURE')::numeric
      INTO retry_total, retry_count, retry_cost FROM bounded;
  retry_ratio := CASE WHEN retry_total = 0 THEN 0 ELSE retry_count::numeric / retry_total END;

  WITH bounded AS (
    SELECT received_at FROM outcome_watchdog.inbox
     WHERE tenant_id = p_tenant_id AND state = 'RECEIVED'
     ORDER BY received_at, inbox_id LIMIT row_limit
  ) SELECT count(*)::integer, count(*)::integer,
           COALESCE(max(GREATEST(extract(epoch FROM (p_observed_at - received_at)), 0)), 0)
      INTO inbox_examined, inbox_count, oldest_inbox FROM bounded;

  WITH selected AS (
    SELECT project_id, subject_type, subject_id
      FROM outcome_projection.reconciler_state
     WHERE tenant_id = p_tenant_id
     ORDER BY written_at, project_id, subject_type, subject_id
     LIMIT checksum_limit
  ), checked AS (
    SELECT outcome_watchdog.subject_checksum_status(
      p_tenant_id, project_id, subject_type, subject_id
    ) AS status FROM selected
  ) SELECT count(*)::integer,
           count(*) FILTER (WHERE status = 'CHECKSUM_MISMATCH')::integer
      INTO checksum_examined, checksum_mismatch FROM checked;

  -- Independent goal-progress probes.  Every source below is a settlement or engagement fact:
  -- coordinator obligation status, task status, typed acceptance exit, live session status.  None
  -- of them is the self-correction channel (convergence ledger, failure-fingerprint repeat
  -- counters), and that separation is the point: those two channels have to be able to fail
  -- independently, or one bug silences both the strategy change and the alarm.
  SELECT count(*)::integer INTO settled_obligations FROM (
    SELECT 1 FROM outcome_coordinator_obligation
     WHERE tenant_id = p_tenant_id AND status IN ('RESOLVED', 'TERMINAL')
     LIMIT progress_limit) bounded;
  SELECT count(*)::integer INTO open_obligations FROM (
    SELECT 1 FROM outcome_coordinator_obligation
     WHERE tenant_id = p_tenant_id
       AND status IN ('READY', 'CLAIMED', 'SCHEDULED', 'EXTERNAL_WAIT', 'OWNER_DECISION')
     LIMIT progress_limit) bounded;
  SELECT count(*)::integer INTO engaged_obligations FROM (
    SELECT 1 FROM outcome_coordinator_obligation
     WHERE tenant_id = p_tenant_id AND status IN ('CLAIMED', 'SCHEDULED')
     LIMIT progress_limit) bounded;
  SELECT count(*)::integer INTO settled_tasks FROM (
    SELECT 1 FROM task WHERE owner_id = p_tenant_id AND status = 'DONE'
     LIMIT progress_limit) bounded;
  SELECT count(*)::integer INTO open_tasks FROM (
    SELECT 1 FROM task WHERE owner_id = p_tenant_id AND status IN ('OPEN', 'IN_PROGRESS')
     LIMIT progress_limit) bounded;
  SELECT count(*)::integer INTO running_sessions FROM (
    SELECT 1 FROM session
     WHERE owner_id = p_tenant_id AND status = 'RUNNING' AND deleted_at IS NULL
     LIMIT progress_limit) bounded;
  SELECT count(*)::integer INTO accepted_executions FROM (
    SELECT 1 FROM task_executable_attempt attempt
      JOIN task ON task.id = attempt.task_id
     WHERE task.owner_id = p_tenant_id
       AND attempt.termination_kind = 'EXITED' AND attempt.actual_exit_code = 0
     LIMIT progress_limit) bounded;
  settled_units := settled_obligations + settled_tasks + accepted_executions;
  outstanding_units := open_obligations + open_tasks;
  engaged_units := engaged_obligations + running_sessions;
  progress_value := jsonb_build_object(
    'settledUnits', settled_units,
    'outstandingUnits', outstanding_units,
    'engagedUnits', engaged_units,
    'settlementLanes', jsonb_build_object(
      'settledObligations', settled_obligations,
      'settledTasks', settled_tasks,
      'acceptedExecutions', accepted_executions
    ),
    'engagementLanes', jsonb_build_object(
      'engagedObligations', engaged_obligations,
      'runningSessions', running_sessions
    ),
    'outstandingLanes', jsonb_build_object(
      'openObligations', open_obligations,
      'openTasks', open_tasks
    ),
    'probeBounds', jsonb_build_object(
      'progressUnitsPerProbe', progress_limit,
      'progressHistorySamples', history_limit
    )
  );

  snapshot_value := jsonb_build_object(
    'watermarkLagLogicalTicks', watermark_lag,
    'oldestActiveObligationLogicalTicks', oldest_active,
    'expiredLeaseCount', expired_count,
    'deadLetterCount', dead_count,
    'outboxBacklogCount', outbox_count,
    'oldestOutboxAgeSeconds', round(oldest_outbox, 3),
    'schedulerStarvationCount', scheduler_starved,
    'retryAttempts', retry_count,
    'totalAttempts', retry_total,
    'retryCostUnits', retry_cost,
    'retryRatio', round(retry_ratio, 6),
    'pendingInboxCount', inbox_count,
    'oldestInboxAgeSeconds', round(oldest_inbox, 3),
    'checksumMismatchCount', checksum_mismatch,
    'denominators', jsonb_build_object(
      'canonicalStreamsExamined', streams_examined,
      'activeObligationsExamined', active_examined,
      'claimedLeasesExamined', expired_examined,
      'deadLettersExamined', dead_examined,
      'outboxEventsExamined', outbox_examined,
      'schedulerCandidatesExamined', scheduler_examined,
      'attemptResultsExamined', retry_total,
      'inboxRecordsExamined', inbox_examined,
      'checksumSubjectsExamined', checksum_examined
    ),
    'probeBounds', jsonb_build_object(
      'maximumRowsPerProbe', row_limit,
      'checksumSubjectsPerProbe', checksum_limit
    )
  );
  IF watermark_lag > watermark_limit THEN
    alerts_value := alerts_value || jsonb_build_array(
      jsonb_build_object('code', 'RECONCILER_STOPPED', 'observed', watermark_lag, 'threshold', watermark_limit),
      jsonb_build_object('code', 'PROJECTION_STALE', 'observed', watermark_lag, 'threshold', watermark_limit)
    );
    projection_status_value := 'RECONCILER_STALE';
  END IF;
  IF oldest_active > active_limit THEN alerts_value := alerts_value || jsonb_build_array(
    jsonb_build_object('code', 'OLDEST_ACTIVE_OBLIGATION', 'observed', oldest_active, 'threshold', active_limit)); END IF;
  IF expired_count > 0 THEN alerts_value := alerts_value || jsonb_build_array(
    jsonb_build_object('code', 'LEASE_EXPIRED', 'observed', expired_count, 'threshold', 0)); END IF;
  IF dead_count > 0 THEN alerts_value := alerts_value || jsonb_build_array(
    jsonb_build_object('code', 'DEAD_LETTER_BACKLOG', 'observed', dead_count, 'threshold', 0)); END IF;
  IF outbox_count > 0 AND oldest_outbox > outbox_age_limit THEN alerts_value := alerts_value || jsonb_build_array(
    jsonb_build_object('code', 'OUTBOX_BLOCKED', 'observed', round(oldest_outbox, 3), 'threshold', outbox_age_limit)); END IF;
  IF scheduler_starved > 0 THEN alerts_value := alerts_value || jsonb_build_array(
    jsonb_build_object('code', 'SCHEDULER_STARVATION', 'observed', scheduler_starved, 'threshold', 0)); END IF;
  IF retry_ratio > retry_ratio_limit OR retry_cost > retry_cost_limit THEN alerts_value := alerts_value || jsonb_build_array(
    jsonb_build_object('code', 'RETRY_STORM', 'observedRatio', round(retry_ratio, 6),
      'observedCostUnits', retry_cost, 'ratioThreshold', retry_ratio_limit,
      'costThreshold', retry_cost_limit)); END IF;
  IF inbox_count > 0 AND oldest_inbox > inbox_age_limit THEN alerts_value := alerts_value || jsonb_build_array(
    jsonb_build_object('code', 'INBOX_STALE', 'observed', round(oldest_inbox, 3), 'threshold', inbox_age_limit)); END IF;
  IF checksum_mismatch > 0 THEN
    alerts_value := alerts_value || jsonb_build_array(
      jsonb_build_object('code', 'CHECKSUM_DRIFT', 'observed', checksum_mismatch, 'threshold', 0));
    projection_status_value := 'RECONCILER_STALE';
  END IF;

  -- Sequence-level conclusions.  These are kept out of `alerts` on purpose: an alert-fatigue
  -- conclusion appended to the alert array would perturb the very count it is measuring.
  alert_count := jsonb_array_length(alerts_value);
  FOR history_row IN
    WITH prior AS (
      SELECT s.sample_sequence, s.observed_at, s.progress, s.alerts
        FROM outcome_watchdog.sample s
       WHERE s.tenant_id = p_tenant_id
         AND s.collector_sha = p_collector_sha::char(40)
         AND s.target_sha = p_target_sha::char(40)
         AND s.progress ? 'settledUnits'
       ORDER BY s.sample_sequence DESC
       LIMIT history_limit - 1
    ), combined AS (
      SELECT NULL::bigint AS sample_sequence, p_observed_at AS observed_at,
             settled_units AS s_units, alert_count AS a_count
      UNION ALL
      SELECT prior.sample_sequence, prior.observed_at,
             (prior.progress->>'settledUnits')::integer,
             jsonb_array_length(prior.alerts)
        FROM prior
    )
    SELECT sample_sequence, observed_at, s_units, a_count FROM combined
     ORDER BY (sample_sequence IS NULL) DESC, sample_sequence DESC
  LOOP
    history_rows := history_rows + 1;
    IF newest_at IS NULL THEN
      newest_at := history_row.observed_at;
      flat_at := history_row.observed_at;
      constant_at := history_row.observed_at;
    ELSE
      IF flat_open AND previous_settled <= history_row.s_units THEN
        flat_run := flat_run + 1;
        flat_at := history_row.observed_at;
      ELSE
        flat_open := false;
      END IF;
      IF constant_open AND previous_alerts = history_row.a_count THEN
        constant_run := constant_run + 1;
        constant_at := history_row.observed_at;
      ELSE
        constant_open := false;
      END IF;
    END IF;
    previous_settled := history_row.s_units;
    previous_alerts := history_row.a_count;
  END LOOP;
  flat_seconds := GREATEST(extract(epoch FROM (newest_at - flat_at)), 0);
  constant_seconds := GREATEST(extract(epoch FROM (newest_at - constant_at)), 0);
  IF history_rows >= progress_min_samples AND engaged_units > 0
     AND flat_run >= flat_limit AND flat_seconds >= flat_window THEN
    conclusions_value := conclusions_value || jsonb_build_array(jsonb_build_object(
      'code', 'GOAL_PROGRESS_STALLED',
      'observed', jsonb_build_object(
        'consecutiveFlatSamples', flat_run,
        'flatWindowSeconds', round(flat_seconds, 3),
        'settledUnits', settled_units,
        'outstandingUnits', outstanding_units,
        'engagedUnits', engaged_units
      ),
      'threshold', jsonb_build_object(
        'maximumConsecutiveFlatSamples', flat_limit,
        'minimumFlatWindowSeconds', flat_window
      )
    ));
  END IF;
  IF history_rows >= constancy_min_samples AND alert_count >= minimum_alerts
     AND constant_run >= constant_limit AND constant_seconds >= constant_window THEN
    conclusions_value := conclusions_value || jsonb_build_array(jsonb_build_object(
      'code', 'ALERT_FATIGUE',
      'observed', jsonb_build_object(
        'consecutiveIdenticalSamples', constant_run,
        'constantWindowSeconds', round(constant_seconds, 3),
        'alertCount', alert_count
      ),
      'threshold', jsonb_build_object(
        'minimumAlertCount', minimum_alerts,
        'maximumConsecutiveIdenticalSamples', constant_limit,
        'minimumConstantWindowSeconds', constant_window
      )
    ));
  END IF;
  SELECT COALESCE(jsonb_agg(entry ORDER BY entry->>'code'), '[]'::jsonb)
    INTO conclusions_value FROM jsonb_array_elements(conclusions_value) entry;

  SELECT jsonb_object_agg(metric.key,
    metric.value || jsonb_build_object(
      'collectorSha', p_collector_sha,
      'targetSha', p_target_sha,
      'sampleObservedAt', to_jsonb(p_observed_at),
      'sampleObservedLogicalTime', logical_now::text
    ) ORDER BY metric.key)
    INTO metrics_value FROM jsonb_each(p_policy->'metrics') metric;
  policy_digest_value := outcome_sha256_json(p_policy);
  sample_digest_value := outcome_sha256_json(jsonb_build_object(
    'tenantId', p_tenant_id::text,
    'observedLogicalTime', logical_now::text,
    'observedAt', to_char(p_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'collectorSha', p_collector_sha,
    'targetSha', p_target_sha,
    'policyDigest', policy_digest_value,
    'projectionStatus', projection_status_value,
    'metrics', metrics_value,
    'snapshot', snapshot_value,
    'alerts', alerts_value,
    'progress', progress_value,
    'conclusions', conclusions_value
  ));
  INSERT INTO outcome_watchdog.sample (
    tenant_id, observed_logical_time, observed_at, window_started_at, window_seconds,
    window_logical_ticks, collector_sha, target_sha, policy_digest, projection_status,
    metrics, snapshot, alerts, progress, conclusions, sample_digest
  ) VALUES (
    p_tenant_id, logical_now, p_observed_at,
    p_observed_at - make_interval(secs => window_seconds), window_seconds, window_ticks,
    p_collector_sha, p_target_sha, policy_digest_value, projection_status_value,
    metrics_value, snapshot_value, alerts_value, progress_value, conclusions_value,
    sample_digest_value
  ) RETURNING * INTO sample_row;
  RETURN jsonb_build_object(
    'sampleId', sample_row.sample_id::text,
    'sampleSequence', sample_row.sample_sequence::text,
    'tenantId', sample_row.tenant_id::text,
    'observedLogicalTime', sample_row.observed_logical_time::text,
    'observedAt', sample_row.observed_at,
    'collectorSha', sample_row.collector_sha::text,
    'targetSha', sample_row.target_sha::text,
    'projectionStatus', sample_row.projection_status,
    'metrics', sample_row.metrics,
    'snapshot', sample_row.snapshot,
    'alerts', sample_row.alerts,
    'progress', sample_row.progress,
    'conclusions', sample_row.conclusions,
    'progressHistorySamples', history_rows,
    'sampleDigest', sample_row.sample_digest::text
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = pg_catalog, public, outcome_watchdog, outcome_projection;

GRANT EXECUTE ON FUNCTION outcome_watchdog.collect(uuid,uuid,jsonb,text,text,timestamptz) TO PUBLIC;

COMMENT ON FUNCTION outcome_watchdog.collect IS
  'Bounded independent probes for lag, liveness, leases, dead letters, outbox, starvation, retries, inbox, drift, and for goal progress and alert constancy on a separate signal source.';

COMMIT;
