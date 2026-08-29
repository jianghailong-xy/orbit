-- Outcome Reconciler V2: one semantic read model, actor-specific CTAs.
--
-- A coordinator decision request used to be bound only to the obligation revision.  That was
-- enough for the coordinator itself, but not for a CTA which can sit in a browser tab while the
-- binding or request is superseded.  Persist the complete public binding and require it again at
-- the mutation boundary.  The opaque ratification CTA token remains a separate protocol and is
-- never copied into these surfaces.
BEGIN;

ALTER TABLE outcome_coordinator_owner_decision_request
  ADD COLUMN obligation_id char(64),
  ADD COLUMN binding_digest char(64),
  ADD COLUMN request_revision char(64),
  ADD COLUMN expires_logical_time bigint,
  ADD COLUMN superseded_by_request_revision char(64);

UPDATE outcome_coordinator_owner_decision_request request
   SET obligation_id = standing.obligation_id,
       binding_digest = standing.binding_digest,
       expires_logical_time = request.requested_logical_time + standing.liveness_delta,
       request_revision = outcome_sha256_json(jsonb_build_object(
         'namespace', 'orbit.owner-decision-request.v2',
         'requestId', request.request_id::text,
         'obligationId', standing.obligation_id::text,
         'obligationRevision', request.obligation_revision::text,
         'bindingDigest', standing.binding_digest::text,
         'requestDigest', request.request_digest::text,
         'requestedLogicalTime', request.requested_logical_time::text
       ))
  FROM outcome_coordinator_obligation standing
 WHERE standing.coordination_id = request.coordination_id;

ALTER TABLE outcome_coordinator_owner_decision_request
  ALTER COLUMN obligation_id SET NOT NULL,
  ALTER COLUMN binding_digest SET NOT NULL,
  ALTER COLUMN request_revision SET NOT NULL,
  ALTER COLUMN expires_logical_time SET NOT NULL,
  ADD CONSTRAINT outcome_coordinator_owner_obligation_id_check
    CHECK (outcome_valid_digest(obligation_id)),
  ADD CONSTRAINT outcome_coordinator_owner_binding_digest_check
    CHECK (outcome_valid_digest(binding_digest)),
  ADD CONSTRAINT outcome_coordinator_owner_request_revision_check
    CHECK (outcome_valid_digest(request_revision)),
  ADD CONSTRAINT outcome_coordinator_owner_expiry_check
    CHECK (expires_logical_time > requested_logical_time),
  ADD CONSTRAINT outcome_coordinator_owner_superseded_revision_check
    CHECK (superseded_by_request_revision IS NULL
      OR outcome_valid_digest(superseded_by_request_revision)),
  ADD CONSTRAINT outcome_coordinator_owner_payload_bound_check
    CHECK (pg_column_size(request) <= 32768);

CREATE UNIQUE INDEX outcome_coordinator_owner_current_revision_idx
  ON outcome_coordinator_owner_decision_request (
    tenant_id, project_id, obligation_id, request_revision
  );
CREATE INDEX outcome_coordinator_owner_surface_idx
  ON outcome_coordinator_owner_decision_request (
    tenant_id, project_id, status, expires_logical_time, obligation_id
  );

CREATE OR REPLACE FUNCTION outcome_coordinator_owner_request_binding_trigger()
RETURNS trigger AS $$
DECLARE
  standing outcome_coordinator_obligation%ROWTYPE;
BEGIN
  SELECT * INTO standing
    FROM outcome_coordinator_obligation
   WHERE coordination_id = NEW.coordination_id;
  IF NOT FOUND OR standing.tenant_id <> NEW.tenant_id OR standing.project_id <> NEW.project_id
     OR standing.obligation_revision::text <> NEW.obligation_revision::text THEN
    RAISE EXCEPTION 'OUTCOME_OWNER_DECISION_SOURCE_BINDING_STALE' USING ERRCODE = '40001';
  END IF;
  NEW.obligation_id := standing.obligation_id;
  NEW.binding_digest := standing.binding_digest;
  NEW.expires_logical_time := NEW.requested_logical_time + standing.liveness_delta;
  NEW.request_revision := outcome_sha256_json(jsonb_build_object(
    'namespace', 'orbit.owner-decision-request.v2',
    'requestId', NEW.request_id::text,
    'obligationId', standing.obligation_id::text,
    'obligationRevision', NEW.obligation_revision::text,
    'bindingDigest', standing.binding_digest::text,
    'requestDigest', NEW.request_digest::text,
    'requestedLogicalTime', NEW.requested_logical_time::text
  ));
  -- A replacement may be created after reconciliation has already marked its predecessor
  -- SUPERSEDED. Link the retained audit row to the exact successor revision without making the
  -- old revision callable again.
  UPDATE outcome_coordinator_owner_decision_request predecessor
     SET superseded_by_request_revision = NEW.request_revision
   WHERE predecessor.coordination_id = NEW.coordination_id
     AND predecessor.status = 'SUPERSEDED'
     AND predecessor.superseded_by_request_revision IS NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outcome_coordinator_owner_request_binding
  BEFORE INSERT ON outcome_coordinator_owner_decision_request
  FOR EACH ROW EXECUTE FUNCTION outcome_coordinator_owner_request_binding_trigger();

-- The old callback cannot express the CTA's request revision, obligation id or binding.  Retain
-- it only as an internal implementation after the exact wrapper has locked and checked the row.
ALTER FUNCTION outcome_decide_coordinator_owner_request(uuid, uuid, text, text, jsonb)
  RENAME TO outcome_decide_coordinator_owner_request_unbound_0198;
REVOKE ALL ON FUNCTION outcome_decide_coordinator_owner_request_unbound_0198(
  uuid, uuid, text, text, jsonb
) FROM PUBLIC;

CREATE FUNCTION outcome_decide_coordinator_owner_request(
  p_tenant_id uuid,
  p_request_id uuid,
  p_request_revision text,
  p_obligation_id text,
  p_obligation_revision text,
  p_binding_digest text,
  p_idempotency_key text,
  p_decision jsonb
) RETURNS jsonb AS $$
DECLARE
  request_value outcome_coordinator_owner_decision_request%ROWTYPE;
  standing outcome_coordinator_obligation%ROWTYPE;
  now_value bigint;
BEGIN
  IF NOT COALESCE(outcome_valid_digest(p_request_revision), false)
     OR NOT COALESCE(outcome_valid_digest(p_obligation_id), false)
     OR NOT COALESCE(outcome_valid_digest(p_obligation_revision), false)
     OR NOT COALESCE(outcome_valid_digest(p_binding_digest), false)
     OR COALESCE(p_idempotency_key, '') = ''
     OR jsonb_typeof(p_decision) <> 'object'
     OR pg_column_size(p_decision) > 32768 THEN
    RAISE EXCEPTION 'OUTCOME_OWNER_DECISION_CTA_INVALID' USING ERRCODE = '22023';
  END IF;
  now_value := outcome_coordinator_now(p_tenant_id);
  SELECT * INTO request_value
    FROM outcome_coordinator_owner_decision_request
   WHERE tenant_id = p_tenant_id AND request_id = p_request_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_OWNER_DECISION_REQUEST_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF request_value.request_revision::text <> p_request_revision
     OR request_value.obligation_id::text <> p_obligation_id
     OR request_value.obligation_revision::text <> p_obligation_revision
     OR request_value.binding_digest::text <> p_binding_digest THEN
    RAISE EXCEPTION 'OUTCOME_OWNER_DECISION_CTA_STALE_OR_EXPIRED' USING ERRCODE = '40001';
  END IF;
  -- A network retry of the exact already-committed decision is safe. The internal function
  -- compares both the idempotency key and decision digest; any variation still conflicts.
  IF request_value.status = 'DECIDED' THEN
    RETURN outcome_decide_coordinator_owner_request_unbound_0198(
      p_tenant_id, p_request_id, p_obligation_revision, p_idempotency_key, p_decision
    );
  END IF;
  IF request_value.status <> 'OPEN' OR request_value.expires_logical_time <= now_value THEN
    RAISE EXCEPTION 'OUTCOME_OWNER_DECISION_CTA_STALE_OR_EXPIRED' USING ERRCODE = '40001';
  END IF;
  SELECT * INTO standing
    FROM outcome_coordinator_obligation
   WHERE tenant_id = p_tenant_id AND coordination_id = request_value.coordination_id
   FOR UPDATE;
  IF NOT FOUND OR standing.status <> 'OWNER_DECISION'
     OR standing.decision_request_id IS DISTINCT FROM request_value.request_id
     OR standing.obligation_id::text <> p_obligation_id
     OR standing.obligation_revision::text <> p_obligation_revision
     OR standing.binding_digest::text <> p_binding_digest THEN
    RAISE EXCEPTION 'OUTCOME_OWNER_DECISION_CTA_STALE_OR_EXPIRED' USING ERRCODE = '40001';
  END IF;
  RETURN outcome_decide_coordinator_owner_request_unbound_0198(
    p_tenant_id, p_request_id, p_obligation_revision, p_idempotency_key, p_decision
  );
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION outcome_decide_coordinator_owner_request(
  uuid, uuid, text, text, text, text, text, jsonb
) IS 'Exact actor CTA boundary: tenant + request revision + obligation revision + binding + expiry.';

COMMIT;
