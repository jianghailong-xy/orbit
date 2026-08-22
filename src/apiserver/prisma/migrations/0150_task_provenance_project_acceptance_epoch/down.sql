-- Reverse of 0150. Not read by Prisma — `migrate deploy` reads `migration.sql` and nothing else —
-- and that is the point: a rollback should be a script somebody reviewed, not one improvised while
-- a deploy is burning.
--
-- Re-runnable in the same way the forward migration is (`IF EXISTS` throughout), and ordered
-- opposite to it: the DONE gate is restored to its 0127 body FIRST, so no window exists in which
-- the gate reads a column that has already been dropped.
--
-- WHAT ROLLING BACK COSTS, stated rather than discovered:
--   * every provenance note ever written is gone. It is evidence, not authority, so nothing that
--     decides anything changes — no task moves project, no dispatch changes, no acceptance moves.
--     That is the compensation for the loss being acceptable at all.
--   * every project returns to "there is one acceptance history", the pre-0150 reading. A project
--     reopened after a PASS is once again able to re-assert that PASS. Rolling back past this
--     migration on a deployment where that has happened is a decision, not a formality.
--   * `acceptance_epoch_advanced` audit rows are NOT deleted; they are kept and the CHECK is left
--     accepting them. Deleting them would rewrite the audit to say the reopens never happened,
--     which is the one thing the whole unit exists to prevent — and an append-only table is not
--     append-only if a rollback may prune it.

BEGIN;

-- ── 1 · The DONE gate, back to its 0127 body ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION project_acceptance_done_gate() RETURNS TRIGGER AS $$
DECLARE
  run          "project_acceptance_run"%ROWTYPE;
  open_blocker INTEGER;
  open_defect  INTEGER;
BEGIN
  IF NEW."status" <> 'DONE' OR OLD."status" = 'DONE' THEN
    RETURN NEW;
  END IF;

  IF NEW."accepted_run_id" IS NULL THEN
    IF NEW."legacy_accepted_at" IS NOT NULL THEN
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
  IF run."verdict" IS DISTINCT FROM 'PASS'::"project_acceptance_verdict" THEN
    RAISE EXCEPTION 'ACCEPTANCE_MISSING: acceptance run % concluded %, not PASS',
      run."id", COALESCE(run."verdict"::text, 'nothing yet') USING ERRCODE = 'raise_exception';
  END IF;
  IF run."superseded_at" IS NOT NULL THEN
    RAISE EXCEPTION 'ACCEPTANCE_EVIDENCE_STALE: acceptance run % was superseded at %',
      run."id", run."superseded_at" USING ERRCODE = 'raise_exception';
  END IF;

  SELECT count(*) INTO open_blocker FROM "project_blocker" b
   WHERE b."project_id" = NEW."id" AND b."resolved_at" IS NULL;
  IF open_blocker > 0 THEN
    RAISE EXCEPTION 'ACCEPTANCE_BLOCKED: project % has % open blocker(s)', NEW."id", open_blocker
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT count(*) INTO open_defect FROM "task_verification_failure" f
   WHERE f."project_id" = NEW."id" AND f."resolved_at" IS NULL;
  IF open_defect > 0 THEN
    RAISE EXCEPTION 'ACCEPTANCE_BLOCKED: project % has % unresolved verification failure(s)',
      NEW."id", open_defect USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "project_acceptance_done_gate" ON "project";
CREATE TRIGGER "project_acceptance_done_gate"
  BEFORE UPDATE OF "status", "accepted_run_id" ON "project"
  FOR EACH ROW EXECUTE FUNCTION project_acceptance_done_gate();

-- ── 2 · The epoch ────────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS "project_acceptance_run_epoch_guard" ON "project_acceptance_run";
DROP FUNCTION IF EXISTS project_acceptance_run_epoch();
DROP TRIGGER IF EXISTS "project_acceptance_epoch_audit" ON "project";
DROP FUNCTION IF EXISTS project_acceptance_epoch_audit();
DROP TRIGGER IF EXISTS "project_acceptance_advance_epoch" ON "project";
DROP FUNCTION IF EXISTS project_acceptance_advance_epoch();

DROP INDEX IF EXISTS "project_acceptance_run_epoch_idx";
ALTER TABLE "project_acceptance_run" DROP CONSTRAINT IF EXISTS "project_acceptance_run_epoch_chk";
ALTER TABLE "project" DROP CONSTRAINT IF EXISTS "project_acceptance_epoch_chk";
ALTER TABLE "project_acceptance_run" DROP COLUMN IF EXISTS "acceptance_epoch";
ALTER TABLE "project" DROP COLUMN IF EXISTS "acceptance_epoch";

-- ── 3 · Provenance ───────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS "task_provenance_immutable_guard" ON "task";
DROP FUNCTION IF EXISTS task_provenance_immutable();

DROP INDEX IF EXISTS "task_source_session_idx";
DROP INDEX IF EXISTS "task_source_task_idx";
DROP INDEX IF EXISTS "task_discovered_from_project_idx";

ALTER TABLE "task" DROP CONSTRAINT IF EXISTS "task_trigger_event_chk";
ALTER TABLE "task" DROP CONSTRAINT IF EXISTS "task_source_session_id_fkey";
ALTER TABLE "task" DROP CONSTRAINT IF EXISTS "task_source_task_id_fkey";
ALTER TABLE "task" DROP CONSTRAINT IF EXISTS "task_discovered_from_project_id_fkey";

ALTER TABLE "task" DROP COLUMN IF EXISTS "source_session_id";
ALTER TABLE "task" DROP COLUMN IF EXISTS "source_task_id";
ALTER TABLE "task" DROP COLUMN IF EXISTS "trigger_event";
ALTER TABLE "task" DROP COLUMN IF EXISTS "discovered_from_project_id";

COMMIT;
