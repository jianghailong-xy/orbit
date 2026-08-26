-- Project completion is defined by project acceptance, not by the state of its task list.
--
-- Before this migration, task rows were part of the service digest and four task triggers made
-- any task create/delete/status/verdict change reopen a DONE project. That made OPEN nice-to-have
-- work a second, accidental completion definition. The service digest moved to v4 in the same
-- release; this migration removes the database half of that coupling and teaches the hard gate to
-- report the actual non-PASS criteria.
--
-- Blockers remain independent gate inputs. They record a known unfinished condition; they are not
-- a task-status aggregate. The unresolved-verification-failure check is retained for the same
-- reason and continues to exclude retired verifier/subject history without reading task status.

BEGIN;

-- Task rows no longer invalidate project acceptance. The BEFORE triggers existed only to put the
-- project lock ahead of the AFTER triggers, so both halves and their now-unreferenced functions go
-- together.
DROP TRIGGER IF EXISTS "project_acceptance_task_fact" ON "task";
DROP TRIGGER IF EXISTS "project_acceptance_task_fact_update" ON "task";
DROP TRIGGER IF EXISTS "task_acceptance_fact_lock_order_insert_delete" ON "task";
DROP TRIGGER IF EXISTS "task_acceptance_fact_lock_order_update" ON "task";
DROP FUNCTION IF EXISTS project_acceptance_task_fact();
DROP FUNCTION IF EXISTS "task_acceptance_fact_lock_order"();

-- The service supplies typed refusals and recomputes the canonical acceptance digest. This is the
-- hard database wall behind it. It independently verifies that every snapshotted criterion is
-- PASS and names every criterion that is not, so even a direct writer cannot equate "all tasks
-- DONE" with project completion.
CREATE OR REPLACE FUNCTION project_acceptance_done_gate() RETURNS TRIGGER AS $$
DECLARE
  run             "project_acceptance_run"%ROWTYPE;
  criterion_count INTEGER;
  unmet_criteria  TEXT;
  open_blocker    INTEGER;
  open_defect     INTEGER;
BEGIN
  IF NEW."status" <> 'DONE' OR OLD."status" = 'DONE' THEN
    RETURN NEW;
  END IF;

  IF NEW."accepted_run_id" IS NULL THEN
    IF NEW."legacy_accepted_at" IS NOT NULL THEN
      IF NEW."acceptance_epoch" > 0 THEN
        RAISE EXCEPTION
          'ACCEPTANCE_EVIDENCE_STALE: project % was reopened after its legacy DONE (epoch %); its next DONE needs a real acceptance run',
          NEW."id", NEW."acceptance_epoch" USING ERRCODE = 'raise_exception';
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'ACCEPTANCE_MISSING: project % has no acceptance run to be DONE against', NEW."id"
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT * INTO run FROM "project_acceptance_run" WHERE "id" = NEW."accepted_run_id";
  IF NOT FOUND OR run."project_id" <> NEW."id" THEN
    RAISE EXCEPTION 'ACCEPTANCE_MISSING: acceptance run % does not belong to project %',
      NEW."accepted_run_id", NEW."id" USING ERRCODE = 'raise_exception';
  END IF;
  IF run."superseded_at" IS NOT NULL THEN
    RAISE EXCEPTION 'ACCEPTANCE_EVIDENCE_STALE: acceptance run % was superseded at %',
      run."id", run."superseded_at" USING ERRCODE = 'raise_exception';
  END IF;
  IF run."digest_version" <> 4 THEN
    RAISE EXCEPTION
      'ACCEPTANCE_EVIDENCE_STALE: acceptance run % was digested at version % and this deployment reads version 4 — re-run acceptance',
      run."id", run."digest_version" USING ERRCODE = 'raise_exception';
  END IF;
  IF run."acceptance_epoch" IS DISTINCT FROM NEW."acceptance_epoch" THEN
    RAISE EXCEPTION
      'ACCEPTANCE_EVIDENCE_STALE: acceptance run % passed in epoch %, and this project is now in epoch % — it was reopened after that run',
      run."id", run."acceptance_epoch", NEW."acceptance_epoch" USING ERRCODE = 'raise_exception';
  END IF;
  IF run."criteria_revision" IS DISTINCT FROM NEW."acceptance_criteria_digest" THEN
    RAISE EXCEPTION
      'ACCEPTANCE_EVIDENCE_STALE: acceptance run % judged a different acceptance-criteria revision. A new finding belongs to this project only if it changes an acceptance criterion; return that criterion to non-PASS and re-run acceptance. If it changes no criterion, create a separate project.',
      run."id" USING ERRCODE = 'raise_exception';
  END IF;

  SELECT count(*) INTO criterion_count
    FROM "project_acceptance_criterion" c
   WHERE c."run_id" = run."id";
  IF criterion_count = 0 THEN
    RAISE EXCEPTION
      'ACCEPTANCE_MISSING: acceptance run % has no criterion results', run."id"
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT string_agg(
           format('#%s %L (%s)', c."ordinal", c."criterion_text",
                  COALESCE(c."verdict"::text, 'UNDECIDED')),
           '; ' ORDER BY c."ordinal"
         )
    INTO unmet_criteria
    FROM "project_acceptance_criterion" c
   WHERE c."run_id" = run."id"
     AND c."verdict" IS DISTINCT FROM 'PASS'::"project_acceptance_verdict";
  IF unmet_criteria IS NOT NULL THEN
    RAISE EXCEPTION
      'ACCEPTANCE_MISSING: acceptance run % has non-PASS acceptance criteria: %. A new finding belongs to this project only if it changes an acceptance criterion; return that criterion to non-PASS and re-run acceptance. If it changes no criterion, create a separate project.',
      run."id", unmet_criteria USING ERRCODE = 'raise_exception';
  END IF;

  -- The summary is redundant by design. The criterion rows above are the completion definition;
  -- this guard catches a corrupt/incomplete summary without replacing the per-criterion decision.
  IF run."verdict" IS DISTINCT FROM 'PASS'::"project_acceptance_verdict" THEN
    RAISE EXCEPTION
      'ACCEPTANCE_MISSING: every criterion in acceptance run % is PASS, but its run summary is %',
      run."id", COALESCE(run."verdict"::text, 'UNDECIDED') USING ERRCODE = 'raise_exception';
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
  'Allows DONE from acceptance criteria plus explicit blockers; task status is not a completion input.';

COMMIT;
