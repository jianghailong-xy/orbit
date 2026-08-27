-- Forward-order repair for the N4 + N5 integration.
--
-- 0179 introduced append-only project_acceptance_conclusion events and made current acceptance a
-- projection over those events. 0182 then removed Task lifecycle from project completion, but its
-- older copy of project_acceptance_done_gate() replaced the event projection with a read of the
-- immutable snapshot rows. On a freshly migrated database the service consequently saw PASS while
-- the database wall saw those deliberately-unmodified snapshot rows as UNDECIDED.
--
-- Keep 0182's removal of every Task-fact trigger. Only restore the final hard wall so it reads the
-- same current conclusion projection as ProjectAcceptanceService. This migration is intentionally
-- after both inputs: deployed databases get a forward correction and migration history is never
-- rewritten.

BEGIN;

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
      unmet_criteria
      USING ERRCODE = 'raise_exception';
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
  'Allows DONE from the current append-only conclusion projection; Task status is not a completion input.';

COMMIT;
