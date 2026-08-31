-- A failure fingerprint that cannot say WHERE the run failed cannot tell convergence from repetition.
--
-- Before this migration the fingerprint was built from four inputs -- evaluation plan digest,
-- termination kind, exit code, signal -- every one of which is a constant along an acceptance chain
-- that keeps failing the same command with the same exit code.  Five consecutive Release DAG
-- attempts that completed 10, 25, 31, 36 and 36 nodes therefore produced ONE fingerprint: real
-- convergence was invisible, and the classifier had nothing to classify with.
--
-- This migration adds the missing input.  A command names its failing sites on one summary line;
-- the sites are sorted, de-duplicated and digested, and nothing else off the output -- no timestamp,
-- path, pid, nonce or log body -- is admitted, so the identity is stable across runs and different
-- across different failures.  A command that says nothing degrades to a NAMED source recorded on
-- the attempt row, never back to the silent constant this replaces.
--
-- No historical row is read, rewritten or backfilled: the two new columns are nullable and the new
-- composition applies to attempts terminated from here on.

CREATE TYPE executable_failure_site_source AS ENUM ('REPORTED', 'ABSENT', 'UNPARSABLE');

ALTER TABLE "task_executable_attempt"
  ADD COLUMN "failure_site_source" executable_failure_site_source,
  ADD COLUMN "failure_site_digest" char(64)
    CONSTRAINT "task_executable_attempt_failure_site_digest_check"
    CHECK ("failure_site_digest" ~ '^[0-9a-f]{64}$');

-- The site identity of one attempt output.  Keep this byte-for-byte identical to
-- executableFailureSiteIdentity() in src/apiserver/src/tasks/executable-acceptance-runtime.ts:
-- the two implementations exist so that neither the control plane nor the database has to wait for
-- the other, and outcome-reconciler-failure-routing asserts they agree on the same input.
CREATE OR REPLACE FUNCTION executable_failure_site_identity(
  p_raw_output text,
  OUT site_source text,
  OUT site_digest char(64)
) LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  c_marker constant text := '##orbit-failure-sites:v1';
  v_line text;
  v_sites text[];
  v_binding text;
BEGIN
  site_source := 'ABSENT';
  IF p_raw_output IS NOT NULL THEN
    -- The summary is printed last, so a later line supersedes anything the run echoed earlier.
    SELECT rtrim(l, E'\r') INTO v_line
      FROM regexp_split_to_table(p_raw_output, E'\n') WITH ORDINALITY AS s(l, ord)
     WHERE rtrim(l, E'\r') = c_marker
        OR left(rtrim(l, E'\r'), length(c_marker) + 1) = c_marker || ' '
     ORDER BY ord DESC
     LIMIT 1;
  END IF;
  IF v_line IS NOT NULL THEN
    SELECT COALESCE(array_agg(DISTINCT token), ARRAY[]::text[]) INTO v_sites
      FROM unnest(string_to_array(substr(v_line, length(c_marker) + 2), ' ')) AS token
     WHERE token <> '';
    IF EXISTS (
      SELECT 1 FROM unnest(v_sites) AS token WHERE token !~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
    ) THEN
      site_source := 'UNPARSABLE';
      v_sites := ARRAY[]::text[];
    ELSE
      site_source := 'REPORTED';
    END IF;
  END IF;
  v_binding := concat('executable-failure-site:v1', E'\n', 'source=', site_source);
  SELECT v_binding || COALESCE(string_agg(E'\n' || 'site=' || token, '' ORDER BY token COLLATE "C"), '')
    INTO v_binding
    FROM unnest(COALESCE(v_sites, ARRAY[]::text[])) AS token;
  site_digest := encode(digest(v_binding, 'sha256'), 'hex')::char(64);
END;
$$;

CREATE OR REPLACE FUNCTION executable_failure_site_digest(p_raw_output text)
RETURNS char(64) LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT site_digest FROM executable_failure_site_identity(p_raw_output)
$$;

CREATE OR REPLACE FUNCTION executable_failure_site_source(p_raw_output text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT site_source FROM executable_failure_site_identity(p_raw_output)
$$;

-- Keep this byte-for-byte identical to executableFailureFingerprint() in
-- src/apiserver/src/tasks/executable-acceptance-runtime.ts.  Deliberately not STRICT: a NULL exit
-- code and a NULL signal are the normal shape of every non-EXITED termination.
CREATE OR REPLACE FUNCTION executable_failure_fingerprint(
  p_evaluation_plan_digest text,
  p_termination_kind text,
  p_actual_exit_code integer,
  p_signal text,
  p_failure_site_digest text
) RETURNS char(64) LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT encode(digest(concat(
    'executable-failure-fingerprint:v2', E'\n',
    'evaluationPlanDigest=', p_evaluation_plan_digest, E'\n',
    'terminationKind=', p_termination_kind, E'\n',
    'actualExitCode=', COALESCE(p_actual_exit_code::text, 'NULL'), E'\n',
    'signal=', COALESCE(p_signal, 'NULL'), E'\n',
    'failureSiteDigest=', p_failure_site_digest
  ), 'sha256'), 'hex')::char(64)
$$;

-- Unchanged from 0200 except that the two site columns join the seven the one termination append
-- may carry.  Everything outside that list is still the attempt's immutable identity, and the
-- append is still permitted exactly once.
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
       'raw_output','output_truncated','failure_fingerprint','failure_site_source',
       'failure_site_digest']
     <> to_jsonb(OLD) - ARRAY['terminated_at','termination_kind','actual_exit_code','signal',
       'raw_output','output_truncated','failure_fingerprint','failure_site_source',
       'failure_site_digest'] THEN
    RAISE EXCEPTION 'task executable attempt identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Unchanged from 0210 except for the fingerprint expression: the reporter's own value still wins,
-- and the fallback now reaches the same value from the stored attempt instead of a four-constant
-- digest.  The recorded site digest is preferred over re-parsing so that an output truncated after
-- the fact cannot change what a fingerprint already committed to.
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
         a.output_truncated, a.failure_fingerprint, a.failure_site_digest,
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

  v_failure_fingerprint := COALESCE(v_attempt.failure_fingerprint, executable_failure_fingerprint(
    v_attempt.evaluation_plan_digest,
    v_attempt.termination_kind::text,
    v_attempt.actual_exit_code,
    v_attempt.signal,
    COALESCE(v_attempt.failure_site_digest, executable_failure_site_digest(v_attempt.raw_output))
  ))::char(64);
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

-- Unchanged from 0200 except that the dead-man sweep now writes the same composition as every other
-- writer of this column.  A swept attempt never produced output, so its site identity is the named
-- ABSENT degradation rather than a pretence that the sites are known.
CREATE OR REPLACE FUNCTION executable_acceptance_mark_stale_attempts(
  p_observed_at timestamptz,
  p_limit integer DEFAULT 64
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE candidate record; marked integer := 0; fingerprint char(64); repeated integer;
        site_digest char(64);
        continuation "executable_acceptance_continuation_kind"; reason text;
BEGIN
  IF p_limit < 1 OR p_limit > 1024 THEN
    RAISE EXCEPTION 'EXECUTABLE_STALE_SCAN_LIMIT_INVALID';
  END IF;
  site_digest := executable_failure_site_digest(NULL);
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
    fingerprint := executable_failure_fingerprint(
      candidate."evaluation_plan_digest", 'INFRASTRUCTURE_LOST', NULL, NULL, site_digest
    );
    UPDATE "task_executable_attempt"
       SET "terminated_at" = p_observed_at,
           "termination_kind" = 'INFRASTRUCTURE_LOST',
           "actual_exit_code" = NULL,
           "failure_fingerprint" = fingerprint,
           "failure_site_source" = 'ABSENT',
           "failure_site_digest" = site_digest
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
