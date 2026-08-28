-- A verifier is a result-producing activity, not a subject waiting for a second human signoff.
-- Its relation is the role declaration, MANUAL says no child aggregation owns its lifecycle, and
-- any non-null verdict settles the carrier.  Only PASS is consumed by the verified subject.
BEGIN;

-- 0181 froze every terminal verification carrier before this migration owned its derived
-- lifecycle. Remove that guard before the first normalization UPDATE: an old DECIDED request may
-- already have a matching verdict while its carrier is still non-DONE, and that is exactly one of
-- the split states repaired below. The stricter replacement is installed before COMMIT.
DROP TRIGGER IF EXISTS "task_judgment_verifier_terminal_guard" ON "task";

UPDATE "task"
   SET "completion_criterion" = 'VERIFICATION',
       "completion_policy" = 'MANUAL',
       "completion_criterion_override_reason" = NULL,
       "acceptance_command" = NULL,
       "acceptance_expected_exit_code" = NULL,
       "status" = CASE
         WHEN "status" <> 'CANCELLED'::"task_status"
              AND "terminal_reason" IS NULL AND "superseded_by_task_id" IS NULL
              AND "verdict" IS NOT NULL THEN 'DONE'::"task_status"
         WHEN "terminal_reason" IS NULL AND "superseded_by_task_id" IS NULL
              AND "verdict" IS NULL AND "status" = 'DONE' THEN 'OPEN'::"task_status"
         ELSE "status"
       END
 WHERE "verifies_task_id" IS NOT NULL;

ALTER TABLE "task"
  ADD CONSTRAINT "task_verifier_completion_declaration" CHECK (
    "verifies_task_id" IS NULL OR (
      "completion_criterion" = 'VERIFICATION'
      AND "completion_policy" = 'MANUAL'
      AND "acceptance_command" IS NULL
      AND "acceptance_expected_exit_code" IS NULL
    )
  );

-- VERIFIER_ROLE is a system projection correction, not a decision attributed to a person or
-- agent.  It is allowed only for a request whose subject is itself a correctly-declared verifier.
ALTER TABLE "task_judgment_request"
  DROP CONSTRAINT "task_judgment_request_lifecycle";

ALTER TABLE "task_judgment_request"
  ADD CONSTRAINT "task_judgment_request_lifecycle" CHECK (
    ("status" = 'OPEN' AND "decided_at" IS NULL AND "decided_by_type" IS NULL
      AND "decided_by_id" IS NULL AND "decision" IS NULL
      AND "superseded_at" IS NULL AND "superseded_by_id" IS NULL
      AND "supersession_rule" IS NULL AND "superseded_actor_type" IS NULL
      AND "superseded_actor_id" IS NULL AND "superseded_source_session_id" IS NULL) OR
    ("status" = 'DECIDED' AND "decided_at" IS NOT NULL AND "decided_by_type" IS NOT NULL
      AND length(btrim("decided_by_type")) > 0 AND "decided_by_id" IS NOT NULL
      AND length(btrim("decided_by_id")) > 0 AND "decision" IS NOT NULL
      AND "superseded_at" IS NULL AND "superseded_by_id" IS NULL
      AND "supersession_rule" IS NULL AND "superseded_actor_type" IS NULL
      AND "superseded_actor_id" IS NULL AND "superseded_source_session_id" IS NULL) OR
    ("status" = 'SUPERSEDED' AND "decided_at" IS NULL AND "decided_by_type" IS NULL
      AND "decided_by_id" IS NULL AND "decision" IS NULL AND "superseded_at" IS NOT NULL
      AND (
        ("superseded_by_id" IS NOT NULL AND "supersession_rule" IS NULL
          AND "superseded_actor_type" IS NULL AND "superseded_actor_id" IS NULL
          AND "superseded_source_session_id" IS NULL) OR
        ("superseded_by_id" IS NOT NULL AND "supersession_rule" = 'EVIDENCE_REVISED'
          AND "superseded_actor_type" IS NOT NULL AND "superseded_actor_id" IS NOT NULL
          AND "superseded_source_session_id" IS NOT NULL) OR
        ("superseded_by_id" IS NULL AND "supersession_rule" = 'TASK_ALREADY_DONE'
          AND "superseded_actor_type" IS NOT NULL AND "superseded_actor_id" IS NOT NULL
          AND "superseded_source_session_id" IS NOT NULL) OR
        ("superseded_by_id" IS NULL AND "supersession_rule" = 'VERIFIER_ROLE'
          AND "superseded_actor_type" IS NULL AND "superseded_actor_id" IS NULL
          AND "superseded_source_session_id" IS NULL)
      ))
  );

CREATE OR REPLACE FUNCTION "task_judgment_request_transition_guard"() RETURNS trigger AS $$
DECLARE successor "task_judgment_request"%ROWTYPE;
BEGIN
  IF ROW(NEW."task_id", NEW."owner_id", NEW."evidence_id", NEW."criterion_revision",
         NEW."evidence_digest", NEW."kind", NEW."recipient_type", NEW."recipient_id",
         NEW."created_at") IS DISTINCT FROM
     ROW(OLD."task_id", OLD."owner_id", OLD."evidence_id", OLD."criterion_revision",
         OLD."evidence_digest", OLD."kind", OLD."recipient_type", OLD."recipient_id",
         OLD."created_at") THEN
    RAISE EXCEPTION 'TASK_JUDGMENT_REQUEST_IDENTITY_IMMUTABLE';
  END IF;
  IF OLD."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'TASK_JUDGMENT_REQUEST_TERMINAL_IMMUTABLE';
  END IF;
  IF NEW."status" = 'OPEN' THEN
    RAISE EXCEPTION 'TASK_JUDGMENT_REQUEST_OPEN_UPDATE_REFUSED';
  ELSIF NEW."status" = 'SUPERSEDED' THEN
    IF NEW."supersession_rule" IS NULL OR NEW."supersession_rule" = 'EVIDENCE_REVISED' THEN
      SELECT * INTO successor FROM "task_judgment_request"
       WHERE "id" = NEW."superseded_by_id";
      IF NOT FOUND OR successor."task_id" <> NEW."task_id"
         OR successor."status" <> 'OPEN' OR successor."created_at" < OLD."created_at" THEN
        RAISE EXCEPTION 'TASK_JUDGMENT_REQUEST_INVALID_SUCCESSOR';
      END IF;
    ELSIF NEW."supersession_rule" = 'TASK_ALREADY_DONE' THEN
      IF NEW."superseded_by_id" IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM "task" task
         WHERE task."id" = NEW."task_id" AND task."owner_id" = NEW."owner_id"
           AND task."status" = 'DONE'
      ) THEN
        RAISE EXCEPTION 'TASK_JUDGMENT_REQUEST_DONE_RULE_REQUIRES_DONE_TASK';
      END IF;
    ELSIF NEW."supersession_rule" = 'VERIFIER_ROLE' THEN
      IF NEW."superseded_by_id" IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM "task" task
         WHERE task."id" = NEW."task_id" AND task."owner_id" = NEW."owner_id"
           AND task."verifies_task_id" IS NOT NULL
           AND task."completion_criterion" = 'VERIFICATION'
           AND task."completion_policy" = 'MANUAL'
      ) THEN
        RAISE EXCEPTION 'TASK_JUDGMENT_REQUEST_VERIFIER_RULE_REQUIRES_VERIFIER_TASK';
      END IF;
    END IF;

    IF NEW."supersession_rule" IS NOT NULL
       AND NEW."supersession_rule" <> 'VERIFIER_ROLE'
       AND NEW."superseded_actor_type" = 'USER'
       AND NEW."superseded_actor_id" <> NEW."owner_id" THEN
      RAISE EXCEPTION 'TASK_JUDGMENT_REQUEST_SUPERSESSION_ACTOR_REQUIRED';
    END IF;
  ELSIF NEW."kind" = 'EXECUTABLE' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "task_executable_judgment_result" result
       WHERE result."request_id" = NEW."id"
         AND CASE WHEN result."actual_exit_code" = result."expected_exit_code"
                  THEN 'PASS'::"task_judgment_decision"
                  ELSE 'FAIL'::"task_judgment_decision" END = NEW."decision"
    ) THEN
      RAISE EXCEPTION 'TASK_EXECUTABLE_JUDGMENT_RESULT_REQUIRED';
    END IF;
  ELSIF NEW."kind" = 'VERIFICATION' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "task" verifier
       WHERE verifier."id" = NEW."recipient_id"::uuid
         AND verifier."verifies_task_id" = NEW."task_id"
         AND verifier."verdict"::text = NEW."decision"::text
    ) THEN
      RAISE EXCEPTION 'TASK_VERIFIER_VERDICT_REQUIRED';
    END IF;
  ELSIF NEW."kind" = 'HUMAN_SIGNOFF' AND NEW."decision" = 'PASS' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "task_human_signoff" signoff
       WHERE signoff."request_id" = NEW."id"
         AND signoff."task_id" = NEW."task_id"
         AND signoff."evidence_digest" = NEW."evidence_digest"
         AND signoff."signed_by_id"::text = NEW."recipient_id"
    ) THEN
      RAISE EXCEPTION 'TASK_HUMAN_SIGNOFF_EVENT_REQUIRED';
    END IF;
  ELSIF NEW."kind" = 'HUMAN_SIGNOFF' AND NEW."decision" = 'INCONCLUSIVE' THEN
    IF NEW."decided_by_type" <> 'USER'
       OR NEW."decided_by_id" <> NEW."recipient_id"
       OR length(btrim(NEW."decision_note")) = 0 THEN
      RAISE EXCEPTION 'TASK_HUMAN_EVIDENCE_REQUEST_AUDIT_REQUIRED';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Close legacy HUMAN_SIGNOFF and check-of-check requests.  The evidence remains append-only and
-- the terminal request remains auditable; it simply ceases to project as pending work.
UPDATE "task_judgment_request" request
   SET "status" = 'SUPERSEDED',
       "superseded_at" = clock_timestamp(),
       "supersession_rule" = 'VERIFIER_ROLE',
       "superseded_by_id" = NULL,
       "superseded_actor_type" = NULL,
       "superseded_actor_id" = NULL,
       "superseded_source_session_id" = NULL
  FROM "task" verifier
 WHERE request."task_id" = verifier."id"
   AND verifier."verifies_task_id" IS NOT NULL
   AND request."status" = 'OPEN';

-- A VERIFICATION request against a verifier may already have created a nested carrier.  Its
-- request is now terminal and can never accept a verdict, so retire that obsolete runnable row.
UPDATE "task" carrier
   SET "status" = 'CANCELLED'
  FROM "task_judgment_request" request
 WHERE request."supersession_rule" = 'VERIFIER_ROLE'
   AND request."kind" = 'VERIFICATION'
   AND request."recipient_type" = 'VERIFIER_TASK'
   AND carrier."id"::text = request."recipient_id"
   AND carrier."verdict" IS NULL
   AND carrier."status" <> 'CANCELLED';

-- Repair impossible split states raw/old writers could create. The old terminal guard was removed
-- before the first normalization UPDATE; its recipient lookup could miss a detached carrier and
-- would otherwise refuse correction of a terminal one. The stricter guard is recreated below.

-- The request owns the carrier identity in every lifecycle state, so first restore its declared
-- subject and role shape.
UPDATE "task" carrier
   SET "verifies_task_id" = request."task_id",
       "completion_criterion" = 'VERIFICATION',
       "completion_policy" = 'MANUAL',
       "completion_criterion_override_reason" = NULL,
       "acceptance_command" = NULL,
       "acceptance_expected_exit_code" = NULL
  FROM "task_judgment_request" request
 WHERE request."kind" = 'VERIFICATION'
   AND request."recipient_type" = 'VERIFIER_TASK'
   AND request."recipient_id" = carrier."id"::text
   AND carrier."verifies_task_id" IS DISTINCT FROM request."task_id";

-- An OPEN request has not consumed a conclusion. Clear a prematurely written verdict (and its
-- derived DONE); the caller may replay the verdict through the service, which consumes the request
-- even if an earlier scalar value happened to be the same.
UPDATE "task" carrier
   SET "verdict" = NULL,
       "status" = CASE WHEN carrier."status" = 'DONE' THEN 'OPEN'::"task_status"
                       ELSE carrier."status" END
  FROM "task_judgment_request" request
 WHERE request."kind" = 'VERIFICATION'
   AND request."recipient_type" = 'VERIFIER_TASK'
   AND request."recipient_id" = carrier."id"::text
   AND request."status" = 'OPEN'
   AND carrier."verdict" IS NOT NULL;

-- A superseded request can never consume a verdict, while a decided request's immutable decision
-- is the authoritative copy of the conclusion. These repairs also make the deferred invariant
-- below safe to install over databases that experienced the old cross-table race.
UPDATE "task" carrier
   SET "verdict" = NULL,
       "status" = 'CANCELLED'
  FROM "task_judgment_request" request
 WHERE request."kind" = 'VERIFICATION'
   AND request."recipient_type" = 'VERIFIER_TASK'
   AND request."recipient_id" = carrier."id"::text
   AND request."status" = 'SUPERSEDED'
   AND (carrier."verdict" IS NOT NULL OR carrier."status" <> 'CANCELLED');

UPDATE "task" carrier
   SET "verdict" = request."decision"::text::"task_verdict",
       "status" = CASE
         WHEN carrier."status" <> 'CANCELLED'::"task_status"
              AND carrier."terminal_reason" IS NULL
              AND carrier."superseded_by_task_id" IS NULL
           THEN 'DONE'::"task_status"
         ELSE carrier."status"
       END
  FROM "task_judgment_request" request
 WHERE request."kind" = 'VERIFICATION'
   AND request."recipient_type" = 'VERIFIER_TASK'
   AND request."recipient_id" = carrier."id"::text
   AND request."status" = 'DECIDED'
   AND (
     carrier."verdict"::text IS DISTINCT FROM request."decision"::text
     OR (
       carrier."status" <> 'CANCELLED'::"task_status"
       AND carrier."terminal_reason" IS NULL
       AND carrier."superseded_by_task_id" IS NULL
       AND carrier."status" <> 'DONE'::"task_status"
     )
   );

-- A request on a verifier is the recursive check-of-check lifecycle this migration removes. Keep
-- rolling old apiservers and raw writers from recreating one after the one-time repair above. An
-- old evidence transaction therefore fails atomically and loudly; the current writer records the
-- evidence without inserting a request and consumes it through the verifier's own verdict.
CREATE OR REPLACE FUNCTION "task_judgment_request_verifier_role_guard"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "task" verifier
     WHERE verifier."id" = NEW."task_id"
       AND verifier."owner_id" = NEW."owner_id"
       AND verifier."verifies_task_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'VERIFIER_JUDGMENT_REQUEST_REFUSED';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_judgment_request_verifier_role_guard"
  BEFORE INSERT ON "task_judgment_request"
  FOR EACH ROW EXECUTE FUNCTION "task_judgment_request_verifier_role_guard"();

-- An evidence-bound verifier's subject is part of the request identity.  The original guard
-- protected it only after the request became terminal, so an OPEN carrier could detach/repoint
-- and leave a request that no verdict could ever satisfy.  Resolve by recipient identity first;
-- do not join through OLD.verifies_task_id, which is precisely the column being protected.
CREATE OR REPLACE FUNCTION "task_judgment_verifier_terminal_guard"() RETURNS trigger AS $$
DECLARE request_status "task_judgment_request_status";
BEGIN
  SELECT request."status" INTO request_status
    FROM "task_judgment_request" request
   WHERE request."kind" = 'VERIFICATION'
     AND request."recipient_type" = 'VERIFIER_TASK'
     AND request."recipient_id" = OLD."id"::text;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF NEW."verifies_task_id" IS DISTINCT FROM OLD."verifies_task_id" THEN
    RAISE EXCEPTION 'VERIFICATION_REQUEST_CARRIER_SUBJECT_IMMUTABLE';
  END IF;
  IF request_status = 'OPEN' THEN
    RETURN NEW;
  END IF;
  IF request_status = 'DECIDED' AND
     ROW(NEW."status", NEW."verdict") IS DISTINCT FROM
     ROW(OLD."status", OLD."verdict") THEN
    RAISE EXCEPTION 'TASK_JUDGMENT_VERIFIER_TERMINAL_IMMUTABLE';
  ELSIF request_status = 'SUPERSEDED' AND (
    NEW."verdict" IS DISTINCT FROM OLD."verdict" OR
    (NEW."status" IS DISTINCT FROM OLD."status" AND NEW."status" <> 'CANCELLED')
  ) THEN
    RAISE EXCEPTION 'TASK_JUDGMENT_VERIFIER_TERMINAL_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "task_judgment_verifier_terminal_guard" ON "task";
CREATE TRIGGER "task_judgment_verifier_terminal_guard"
  BEFORE UPDATE OF "status", "verdict", "verifies_task_id" ON "task"
  FOR EACH ROW EXECUTE FUNCTION "task_judgment_verifier_terminal_guard"();

-- recipient_id is intentionally not an FK because the request is owned by its subject. Refuse a
-- direct carrier delete while an OPEN request and its subject still exist. This is deferred rather
-- than BEFORE-row: DELETE FROM task WHERE id IN (subject, carrier) has no portable row order, and
-- must be equivalent to deleting the subject alone. At transaction end a direct carrier delete
-- still has both the OPEN request and subject; a complete lifecycle delete has neither.
CREATE OR REPLACE FUNCTION "task_judgment_verifier_delete_guard"() RETURNS trigger AS $$
BEGIN
  -- Same commit fence as verdict/request transitions. In particular, an OPEN request insertion
  -- that wins the fence becomes visible before this direct-delete check is allowed to pass.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('orbit:verification-request-carrier-state', 0)
  );
  IF EXISTS (
    SELECT 1 FROM "task_judgment_request" request
      JOIN "task" subject ON subject."id" = request."task_id"
     WHERE request."kind" = 'VERIFICATION'
       AND request."recipient_type" = 'VERIFIER_TASK'
       AND request."recipient_id" = OLD."id"::text
       AND request."status" = 'OPEN'
  ) THEN
    RAISE EXCEPTION 'VERIFICATION_REQUEST_CARRIER_DELETE_REFUSED';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "task_judgment_verifier_delete_guard"
  AFTER DELETE ON "task"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "task_judgment_verifier_delete_guard"();

-- 0124 silently cleared an unchanged verifier verdict whenever raw SQL moved DONE elsewhere.
-- That ran before the derived carrier trigger by trigger-name order, making raw cancellation
-- succeed while TasksService correctly refused it. Keep legacy behavior only for a hypothetical
-- non-verifier row; a verifier must explicitly clear verdict in the same statement.
CREATE OR REPLACE FUNCTION "task_verdict_revoked_on_reopen"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'DONE' AND NEW."status" <> 'DONE'
     AND NEW."verdict" IS NOT NULL
     AND NEW."verdict" IS NOT DISTINCT FROM OLD."verdict" THEN
    IF NEW."verifies_task_id" IS NOT NULL THEN
      RAISE EXCEPTION 'VERIFIER_STATUS_DERIVED_FROM_VERDICT';
    END IF;
    NEW."verdict" := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Keep raw/secondary writers on the same derived lifecycle as TasksService.  An explicit
-- retirement may revoke the verdict and choose a terminal status in one statement; an ordinary
-- revocation of a DONE carrier falls back to OPEN.
CREATE OR REPLACE FUNCTION "task_verification_carrier_status_derive"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."verifies_task_id" IS NULL
     AND NEW."verifies_task_id" IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM "task_completion_evidence" evidence
        WHERE evidence."task_id" = NEW."id"
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'VERIFIER_ATTACH_COMPLETION_EVIDENCE_EXISTS';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."verifies_task_id" IS NOT NULL AND NEW."verdict" IS NOT NULL
     AND NEW."verdict" IS DISTINCT FROM OLD."verdict"
     AND (OLD."status" = 'CANCELLED' OR OLD."terminal_reason" IS NOT NULL
          OR OLD."superseded_by_task_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'RETIRED_VERIFIER_VERDICT_REFUSED';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."verifies_task_id" IS NOT NULL
     AND NEW."verdict" IS NOT NULL
     AND NEW."status" IS DISTINCT FROM OLD."status"
     AND NEW."status" <> 'DONE'::"task_status" THEN
    RAISE EXCEPTION 'VERIFIER_STATUS_DERIVED_FROM_VERDICT';
  END IF;
  IF NEW."verifies_task_id" IS NOT NULL THEN
    NEW."completion_criterion" := 'VERIFICATION';
    NEW."completion_policy" := 'MANUAL';
    NEW."completion_criterion_override_reason" := NULL;
    NEW."acceptance_command" := NULL;
    NEW."acceptance_expected_exit_code" := NULL;
    IF NEW."status" <> 'CANCELLED'::"task_status"
       AND NEW."terminal_reason" IS NULL AND NEW."superseded_by_task_id" IS NULL THEN
      IF NEW."verdict" IS NOT NULL THEN
        NEW."status" := 'DONE';
      ELSIF TG_OP = 'UPDATE' AND NEW."status" = OLD."status"
            AND (
              (OLD."verifies_task_id" IS NULL AND OLD."status" = 'DONE')
              OR (OLD."verdict" IS NOT NULL AND OLD."status" = 'DONE')
            ) THEN
        NEW."status" := 'OPEN';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_verification_carrier_status_derive_insert"
  BEFORE INSERT ON "task"
  FOR EACH ROW
  WHEN (NEW."verifies_task_id" IS NOT NULL)
  EXECUTE FUNCTION "task_verification_carrier_status_derive"();

CREATE TRIGGER "task_verification_carrier_status_derive_update"
  BEFORE UPDATE OF "status", "verdict", "verifies_task_id", "completion_criterion",
    "completion_policy", "completion_criterion_override_reason", "terminal_reason",
    "superseded_by_task_id" ON "task"
  FOR EACH ROW
  WHEN (NEW."verifies_task_id" IS NOT NULL)
  EXECUTE FUNCTION "task_verification_carrier_status_derive"();

-- End-of-transaction invariant: when a VERIFICATION request's carrier exists it still verifies
-- that request's subject. OPEN and SUPERSEDED requests have no carrier verdict; a DECIDED
-- request's verdict is exactly its durable decision. A brief request-without-carrier window is intentional:
-- the durable request commits first and afterEvidenceCommit/replay files its runnable carrier.
-- Deferred is essential. TasksService writes the carrier verdict first because the request's
-- transition guard requires that fact, then decides the request in the same transaction. A raw
-- autocommit verdict has no matching transition and therefore rolls back at commit.
--
-- Both relation triggers take the SAME transaction lock before re-reading BOTH final rows. Without
-- it, concurrent request transitions and carrier writes can each observe the other's old fact and
-- both commit. Reading current rows instead of historical NEW also makes PASS->NULL and
-- OPEN->DECIDED legal when their final state satisfies the invariant.
CREATE OR REPLACE FUNCTION "assert_verification_request_carrier_state"(
  carrier_id text
) RETURNS void AS $$
BEGIN
  -- This lifecycle is low-volume, and one global key avoids a second carrier-order protocol in
  -- transactions that already lock subject+carrier Tasks at rank 50 and the request at rank 60.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('orbit:verification-request-carrier-state', 0)
  );
  IF EXISTS (
    SELECT 1
      FROM "task_judgment_request" request
      JOIN "task" carrier ON carrier."id"::text = request."recipient_id"
     WHERE request."kind" = 'VERIFICATION'
       AND request."recipient_type" = 'VERIFIER_TASK'
       AND request."recipient_id" = carrier_id
       AND carrier."verifies_task_id" IS DISTINCT FROM request."task_id"
  ) THEN
    RAISE EXCEPTION 'VERIFICATION_REQUEST_CARRIER_SUBJECT_IMMUTABLE';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM "task_judgment_request" request
      JOIN "task" carrier ON carrier."id"::text = request."recipient_id"
     WHERE request."kind" = 'VERIFICATION'
       AND request."recipient_type" = 'VERIFIER_TASK'
       AND request."recipient_id" = carrier_id
       AND request."status" = 'OPEN'
       AND carrier."verdict" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'OPEN_VERIFICATION_REQUEST_CARRIER_VERDICT_REFUSED';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM "task_judgment_request" request
      JOIN "task" carrier ON carrier."id"::text = request."recipient_id"
     WHERE request."kind" = 'VERIFICATION'
       AND request."recipient_type" = 'VERIFIER_TASK'
       AND request."recipient_id" = carrier_id
       AND request."status" = 'SUPERSEDED'
       AND carrier."verdict" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'SUPERSEDED_VERIFICATION_REQUEST_CARRIER_VERDICT_REFUSED';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM "task_judgment_request" request
      JOIN "task" carrier ON carrier."id"::text = request."recipient_id"
     WHERE request."kind" = 'VERIFICATION'
       AND request."recipient_type" = 'VERIFIER_TASK'
       AND request."recipient_id" = carrier_id
       AND request."status" = 'DECIDED'
       AND carrier."verdict"::text IS DISTINCT FROM request."decision"::text
  ) THEN
    RAISE EXCEPTION 'DECIDED_VERIFICATION_REQUEST_CARRIER_VERDICT_MISMATCH';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "task_open_verification_request_carrier_guard"() RETURNS trigger AS $$
BEGIN
  PERFORM "assert_verification_request_carrier_state"(NEW."id"::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "task_open_verification_request_carrier_guard"
  AFTER INSERT OR UPDATE OF "verdict", "verifies_task_id" ON "task"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "task_open_verification_request_carrier_guard"();

CREATE OR REPLACE FUNCTION "task_open_verification_request_guard"() RETURNS trigger AS $$
BEGIN
  IF NEW."kind" = 'VERIFICATION' AND NEW."recipient_type" = 'VERIFIER_TASK' THEN
    PERFORM "assert_verification_request_carrier_state"(NEW."recipient_id");
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "task_open_verification_request_guard"
  AFTER INSERT OR UPDATE OF "status" ON "task_judgment_request"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "task_open_verification_request_guard"();

COMMENT ON COLUMN "task_judgment_request"."supersession_rule" IS
  'Why the request became SUPERSEDED; TASK_ALREADY_DONE and VERIFIER_ROLE are no-successor terminal rules.';

COMMIT;
