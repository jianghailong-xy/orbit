-- N13: a person may conclude that the current HUMAN_SIGNOFF evidence is not yet sufficient.
-- The request row is already the append-only audit boundary (who, when, request and digest); this
-- adds the required reason and allows its terminal decision to be INCONCLUSIVE. It deliberately
-- does not add a Task.status transition: a later evidence revision creates a new OPEN request.

ALTER TABLE "task_judgment_request"
  ADD COLUMN "decision_note" text;

ALTER TABLE "task_judgment_request"
  DROP CONSTRAINT "task_judgment_request_decider_matches_kind";

ALTER TABLE "task_judgment_request"
  ADD CONSTRAINT "task_judgment_request_decider_matches_kind" CHECK (
    "status" <> 'DECIDED' OR
    ("kind" = 'EXECUTABLE' AND "decided_by_type" = 'SYSTEM'
      AND "decision" IN ('PASS', 'FAIL')) OR
    ("kind" = 'VERIFICATION' AND "decided_by_type" IN ('USER', 'AGENT')) OR
    ("kind" = 'HUMAN_SIGNOFF' AND "decided_by_type" = 'USER'
      AND "decided_by_id" = "recipient_id"
      AND (
        "decision" = 'PASS' OR
        ("decision" = 'INCONCLUSIVE' AND length(btrim("decision_note")) > 0)
      ))
  );

ALTER TABLE "task_judgment_request"
  ADD CONSTRAINT "task_judgment_request_decision_note_lifecycle" CHECK (
    ("status" <> 'DECIDED' AND "decision_note" IS NULL) OR
    "status" = 'DECIDED'
  );

-- Same immutable identity and one-way lifecycle as 0181. The only widened branch is the human
-- INCONCLUSIVE conclusion: its own request row, digest, recipient, user and non-blank note are the
-- complete audit fact. PASS still requires the separate TaskHumanSignoff event, so no raw update
-- can manufacture DONE.
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
    SELECT * INTO successor FROM "task_judgment_request"
     WHERE "id" = NEW."superseded_by_id";
    IF NOT FOUND OR successor."task_id" <> NEW."task_id"
       OR successor."status" <> 'OPEN' OR successor."created_at" < OLD."created_at" THEN
      RAISE EXCEPTION 'TASK_JUDGMENT_REQUEST_INVALID_SUCCESSOR';
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

COMMENT ON COLUMN "task_judgment_request"."decision_note" IS
  'Human decision audit; required for HUMAN_SIGNOFF INCONCLUSIVE (wait for new evidence).';
