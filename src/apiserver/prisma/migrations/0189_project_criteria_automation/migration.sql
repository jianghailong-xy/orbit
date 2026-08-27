-- N22: project criteria use Task's three peer completion criteria, while the one human value
-- judgment moves to an append-only confirmation of the complete, digest-bound standard set.
--
-- Migration is deliberately conservative: every existing definition and run snapshot becomes
-- HUMAN_SIGNOFF. No command, evidence Task, conclusion, PASS, or Project DONE is invented.

BEGIN;

ALTER TABLE "project_acceptance_criterion_definition"
  ADD COLUMN "completion_criterion" "task_completion_criterion",
  ADD COLUMN "acceptance_command" TEXT,
  ADD COLUMN "acceptance_expected_exit_code" INTEGER,
  ADD COLUMN "evidence_task_id" UUID,
  ADD COLUMN "completion_criterion_override_reason" TEXT;

UPDATE "project_acceptance_criterion_definition"
   SET "completion_criterion" = 'HUMAN_SIGNOFF'::"task_completion_criterion";

ALTER TABLE "project_acceptance_criterion_definition"
  ALTER COLUMN "completion_criterion" SET NOT NULL,
  ADD CONSTRAINT "project_acceptance_definition_declaration_chk" CHECK (
    (
      "completion_criterion" = 'EXECUTABLE'::"task_completion_criterion"
      AND "acceptance_command" IS NOT NULL
      AND btrim("acceptance_command") <> ''
      AND "acceptance_expected_exit_code" IS NOT NULL
      AND "evidence_task_id" IS NOT NULL
    ) OR (
      "completion_criterion" = 'VERIFICATION'::"task_completion_criterion"
      AND "acceptance_command" IS NULL
      AND "acceptance_expected_exit_code" IS NULL
      AND "evidence_task_id" IS NOT NULL
    ) OR (
      "completion_criterion" = 'HUMAN_SIGNOFF'::"task_completion_criterion"
      AND "acceptance_command" IS NULL
      AND "acceptance_expected_exit_code" IS NULL
      AND "evidence_task_id" IS NULL
    )
  ),
  ADD CONSTRAINT "project_acceptance_definition_override_reason_chk" CHECK (
    "completion_criterion_override_reason" IS NULL OR (
      btrim("completion_criterion_override_reason") <> ''
      AND char_length("completion_criterion_override_reason") <= 2000
    )
  );

ALTER TABLE "project_acceptance_criterion"
  ADD COLUMN "completion_criterion" "task_completion_criterion"
    NOT NULL DEFAULT 'HUMAN_SIGNOFF',
  ADD COLUMN "acceptance_command" TEXT,
  ADD COLUMN "acceptance_expected_exit_code" INTEGER;

CREATE TABLE "project_acceptance_criteria_confirmation" (
  "id"                 UUID PRIMARY KEY,
  "project_id"         UUID NOT NULL,
  "criteria_digest"    CHAR(64) NOT NULL,
  "confirmed_by_type"  TEXT NOT NULL,
  "confirmed_by_id"    UUID NOT NULL,
  "acting_session_id"  UUID,
  "confirmed_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_acceptance_confirmation_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "project"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "project_acceptance_confirmation_digest_chk"
    CHECK ("criteria_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "project_acceptance_confirmation_actor_chk"
    CHECK ("confirmed_by_type" IN ('USER', 'RUNNER'))
);

CREATE UNIQUE INDEX "project_acceptance_confirmation_digest_key"
  ON "project_acceptance_criteria_confirmation" ("project_id", "criteria_digest");
CREATE INDEX "project_acceptance_confirmation_project_idx"
  ON "project_acceptance_criteria_confirmation" ("project_id", "confirmed_at" DESC);

CREATE OR REPLACE FUNCTION project_acceptance_confirmation_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'PROJECT_ACCEPTANCE_CONFIRMATION_IMMUTABLE: confirmation % is an event and cannot be rewritten',
    OLD."id" USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_acceptance_confirmation_immutable
  BEFORE UPDATE ON "project_acceptance_criteria_confirmation"
  FOR EACH ROW EXECUTE FUNCTION project_acceptance_confirmation_immutable();

-- One canonical semantic hash for assertion + declared evaluation. `verification_method` remains
-- useful reader-facing prose, and changing it still changes the standard that was confirmed.
CREATE OR REPLACE FUNCTION project_acceptance_definition_content_hash(
  p_text TEXT,
  p_verification_method TEXT,
  p_completion_criterion "task_completion_criterion",
  p_acceptance_command TEXT,
  p_expected_exit_code INTEGER,
  p_evidence_task_id UUID
) RETURNS CHAR(64) AS $$
  SELECT encode(digest(jsonb_build_object(
    'acceptanceCommand', p_acceptance_command,
    'completionCriterion', p_completion_criterion::text,
    'evidenceTaskId', p_evidence_task_id::text,
    'expectedExitCode', p_expected_exit_code,
    'text', p_text,
    'verificationMethod', p_verification_method
  )::text, 'sha256'), 'hex')::CHAR(64)
$$ LANGUAGE SQL IMMUTABLE;

DROP TRIGGER project_acceptance_definition_normalize
  ON "project_acceptance_criterion_definition";

CREATE OR REPLACE FUNCTION project_acceptance_definition_normalize() RETURNS TRIGGER AS $$
BEGIN
  NEW."text" := btrim(NEW."text");
  NEW."verification_method" := btrim(NEW."verification_method");
  NEW."acceptance_command" := CASE
    WHEN NEW."acceptance_command" IS NULL THEN NULL ELSE btrim(NEW."acceptance_command") END;
  NEW."completion_criterion_override_reason" := CASE
    WHEN NEW."completion_criterion_override_reason" IS NULL THEN NULL
    ELSE btrim(NEW."completion_criterion_override_reason") END;
  NEW."content_hash" := project_acceptance_definition_content_hash(
    NEW."text", NEW."verification_method", NEW."completion_criterion",
    NEW."acceptance_command", NEW."acceptance_expected_exit_code", NEW."evidence_task_id"
  );
  IF TG_OP = 'INSERT' THEN
    NEW."revision" := 1;
  ELSE
    NEW."revision" := CASE
      WHEN NEW."text" IS DISTINCT FROM OLD."text"
        OR NEW."verification_method" IS DISTINCT FROM OLD."verification_method"
        OR NEW."completion_criterion" IS DISTINCT FROM OLD."completion_criterion"
        OR NEW."acceptance_command" IS DISTINCT FROM OLD."acceptance_command"
        OR NEW."acceptance_expected_exit_code" IS DISTINCT FROM OLD."acceptance_expected_exit_code"
        OR NEW."evidence_task_id" IS DISTINCT FROM OLD."evidence_task_id"
      THEN OLD."revision" + 1
      ELSE OLD."revision"
    END;
    NEW."updated_at" := CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_acceptance_definition_normalize
  BEFORE INSERT OR UPDATE OF
    "text", "verification_method", "completion_criterion", "acceptance_command",
    "acceptance_expected_exit_code", "evidence_task_id",
    "completion_criterion_override_reason", "revision", "content_hash"
  ON "project_acceptance_criterion_definition"
  FOR EACH ROW EXECUTE FUNCTION project_acceptance_definition_normalize();

-- Re-hash in place without advancing a definition revision: this is a schema interpretation
-- change, not an author edit. No conclusion rows or project statuses are touched.
UPDATE "project_acceptance_criterion_definition"
   SET "content_hash" = project_acceptance_definition_content_hash(
     "text", "verification_method", "completion_criterion", "acceptance_command",
     "acceptance_expected_exit_code", "evidence_task_id"
   );

-- A standard-set digest includes stable identity + monotone revision as well as content. Editing a
-- criterion and later restoring the same words therefore still requires a fresh confirmation;
-- reordering remains cosmetic because the rows are sorted independently of ordinal.
CREATE OR REPLACE FUNCTION project_acceptance_definition_digest(p_project UUID)
RETURNS CHAR(64) AS $$
  SELECT encode(digest(COALESCE(string_agg(
           d."id"::text || ':' || d."revision"::text || ':' || d."content_hash"::text,
           ',' ORDER BY d."id"
         ), ''), 'sha256'), 'hex')::CHAR(64)
    FROM "project_acceptance_criterion_definition" d
   WHERE d."project_id" = p_project
$$ LANGUAGE SQL STABLE;

-- Legacy text remains a supported compatibility authoring path. It cannot declare a mechanical
-- criterion, so every genuinely new legacy line is explicitly HUMAN_SIGNOFF and gets no command.
CREATE OR REPLACE FUNCTION project_acceptance_sync_legacy_definitions(
  p_project UUID,
  p_text TEXT
) RETURNS VOID AS $$
BEGIN
  UPDATE "project_acceptance_criterion_definition"
     SET "ordinal" = "ordinal" + 1000000000
   WHERE "project_id" = p_project;

  WITH existing AS (
    SELECT d."id",
           encode(digest(d."text", 'sha256'), 'hex') AS text_hash,
           row_number() OVER (
             PARTITION BY encode(digest(d."text", 'sha256'), 'hex')
             ORDER BY d."ordinal", d."id"
           ) AS occurrence
      FROM "project_acceptance_criterion_definition" d
     WHERE d."project_id" = p_project
  ), incoming_counts AS (
    SELECT p.content_hash AS text_hash, count(*) AS occurrences
      FROM project_acceptance_parse_legacy(p_text) p
     GROUP BY p.content_hash
  )
  DELETE FROM "project_acceptance_criterion_definition" d
   USING existing e
   LEFT JOIN incoming_counts i ON i.text_hash = e.text_hash
   WHERE d."id" = e."id"
     AND e.occurrence > COALESCE(i.occurrences, 0);

  WITH existing AS (
    SELECT d."id",
           encode(digest(d."text", 'sha256'), 'hex') AS text_hash,
           row_number() OVER (
             PARTITION BY encode(digest(d."text", 'sha256'), 'hex')
             ORDER BY d."ordinal", d."id"
           ) AS occurrence
      FROM "project_acceptance_criterion_definition" d
     WHERE d."project_id" = p_project
  ), incoming AS (
    SELECT p.*, row_number() OVER (
      PARTITION BY p.content_hash ORDER BY p.ordinal
    ) AS occurrence
      FROM project_acceptance_parse_legacy(p_text) p
  )
  UPDATE "project_acceptance_criterion_definition" d
     SET "ordinal" = i.ordinal, "text" = i.criterion_text
    FROM existing e
    JOIN incoming i ON i.content_hash = e.text_hash AND i.occurrence = e.occurrence
   WHERE d."id" = e."id";

  WITH incoming AS (
    SELECT p.*, row_number() OVER (
      PARTITION BY p.content_hash ORDER BY p.ordinal
    ) AS occurrence
      FROM project_acceptance_parse_legacy(p_text) p
  ), existing_counts AS (
    SELECT encode(digest(d."text", 'sha256'), 'hex') AS text_hash, count(*) AS occurrences
      FROM "project_acceptance_criterion_definition" d
     WHERE d."project_id" = p_project
     GROUP BY encode(digest(d."text", 'sha256'), 'hex')
  )
  INSERT INTO "project_acceptance_criterion_definition" (
    "id", "project_id", "ordinal", "text", "verification_method",
    "completion_criterion", "acceptance_command", "acceptance_expected_exit_code",
    "evidence_task_id", "revision", "content_hash"
  )
  SELECT gen_random_uuid(), p_project, i.ordinal, i.criterion_text,
         'Human review against direct evidence for this migrated criterion',
         'HUMAN_SIGNOFF'::"task_completion_criterion", NULL, NULL, NULL, 1, i.content_hash
    FROM incoming i
    LEFT JOIN existing_counts e ON e.text_hash = i.content_hash
   WHERE i.occurrence > COALESCE(e.occurrences, 0)
   ORDER BY i.ordinal;
END;
$$ LANGUAGE plpgsql;

UPDATE "project" p
   SET "acceptance_criteria_digest" = project_acceptance_definition_digest(p."id");

-- Mechanical conclusions are peers of human conclusions. The actor column says which evaluator
-- produced the event; it does not create a fallback from one criterion to another.
ALTER TABLE "project_acceptance_conclusion"
  DROP CONSTRAINT "project_acceptance_conclusion_decided_by_chk",
  DROP CONSTRAINT "project_acceptance_conclusion_pass_human_chk",
  ADD CONSTRAINT "project_acceptance_conclusion_decided_by_chk"
    CHECK ("decided_by" IN ('USER', 'COORDINATOR_AGENT', 'SYSTEM')),
  ADD CONSTRAINT "project_acceptance_conclusion_pass_authority_chk"
    CHECK (
      "verdict" <> 'PASS'::"project_acceptance_verdict"
      OR "decided_by" IN ('USER', 'SYSTEM')
    );

-- The database's last wall now also requires a confirmation for the exact current standard-set
-- digest. It is identity-independent: whichever credential edited a definition, the digest moved.
CREATE OR REPLACE FUNCTION project_acceptance_done_gate() RETURNS TRIGGER AS $$
DECLARE
  run             "project_acceptance_run"%ROWTYPE;
  criterion_count INTEGER;
  unmet_criteria  TEXT;
  open_blocker    INTEGER;
  open_defect     INTEGER;
BEGIN
  IF NEW."status" <> 'DONE' OR OLD."status" = 'DONE' THEN RETURN NEW; END IF;

  IF NEW."accepted_run_id" IS NULL THEN
    IF NEW."legacy_accepted_at" IS NOT NULL AND NEW."acceptance_epoch" = 0 THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'ACCEPTANCE_MISSING: project % has no current evidence version', NEW."id"
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT * INTO run FROM "project_acceptance_run" WHERE "id" = NEW."accepted_run_id";
  IF NOT FOUND OR run."project_id" <> NEW."id" THEN
    RAISE EXCEPTION 'ACCEPTANCE_MISSING: evidence version % does not belong to project %',
      NEW."accepted_run_id", NEW."id" USING ERRCODE = 'raise_exception';
  END IF;
  IF run."superseded_at" IS NOT NULL THEN
    RAISE EXCEPTION 'ACCEPTANCE_MISSING: evidence version % is not the current project version',
      run."id" USING ERRCODE = 'raise_exception';
  END IF;

  SELECT count(*) INTO criterion_count
    FROM "project_acceptance_criterion_definition" d WHERE d."project_id" = NEW."id";
  IF criterion_count = 0 THEN
    RAISE EXCEPTION 'ACCEPTANCE_MISSING: project % states no acceptance criteria', NEW."id"
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "project_acceptance_criteria_confirmation" c
     WHERE c."project_id" = NEW."id"
       AND c."criteria_digest" = NEW."acceptance_criteria_digest"
  ) THEN
    RAISE EXCEPTION
      'CRITERIA_CONFIRMATION_REQUIRED: project % current criteria digest % is not confirmed',
      NEW."id", NEW."acceptance_criteria_digest" USING ERRCODE = 'raise_exception';
  END IF;

  SELECT string_agg(
           format('#%s %L (%s)', s.ordinal, s.criterion_text,
                  COALESCE(s.verdict::text, 'UNDECIDED')),
           '; ' ORDER BY s.ordinal
         )
    INTO unmet_criteria
    FROM project_acceptance_standing(NEW."id", run."attempt") s
   WHERE s.verdict IS DISTINCT FROM 'PASS'::"project_acceptance_verdict";
  IF unmet_criteria IS NOT NULL THEN
    RAISE EXCEPTION
      'ACCEPTANCE_MISSING: current acceptance criteria are non-PASS: %. A new finding belongs to this project only if it changes an acceptance criterion: record a new conclusion event; otherwise create a separate project.',
      unmet_criteria USING ERRCODE = 'raise_exception';
  END IF;

  SELECT count(*) INTO open_blocker FROM "project_blocker" b
   WHERE b."project_id" = NEW."id" AND b."resolved_at" IS NULL;
  IF open_blocker > 0 THEN
    RAISE EXCEPTION 'ACCEPTANCE_BLOCKED: project % has % open blocker(s)', NEW."id", open_blocker
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT count(*) INTO open_defect
    FROM "task_verification_failure" f
    JOIN "task" verifier ON verifier."id" = f."verifier_task_id"
    JOIN "task" subject  ON subject."id"  = f."subject_task_id"
   WHERE f."project_id" = NEW."id" AND f."resolved_at" IS NULL
     AND verifier."terminal_reason" IS NULL AND verifier."superseded_by_task_id" IS NULL
     AND subject."terminal_reason" IS NULL AND subject."superseded_by_task_id" IS NULL;
  IF open_defect > 0 THEN
    RAISE EXCEPTION 'ACCEPTANCE_BLOCKED: project % has % unresolved verification failure(s)',
      NEW."id", open_defect USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION project_acceptance_done_gate() IS
  'Allows automatic DONE only for the current confirmed standard-set digest and append-only PASS projection.';

COMMIT;
