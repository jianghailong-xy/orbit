-- Expand the old Archive storage into the canonical Completed lifecycle vocabulary.
-- archived_at remains during the rolling-upgrade window so older servers and clients can
-- coexist. New application code reads completed_at first and exposes archivedAt only as a
-- deprecated API alias.
BEGIN;

ALTER TABLE "session" ADD COLUMN "completed_at" TIMESTAMP(3);

-- Keep either generation of the server safe during a rolling deploy. An old server can
-- complete/restore by changing archived_at; a new server changes completed_at (and normally
-- both). The trigger mirrors whichever column a single-generation update changed.
CREATE OR REPLACE FUNCTION sync_session_completed_at()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.completed_at := COALESCE(NEW.completed_at, NEW.archived_at);
    NEW.archived_at := COALESCE(NEW.completed_at, NEW.archived_at);
  ELSIF NEW.completed_at IS DISTINCT FROM OLD.completed_at
        AND NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at THEN
    NEW.archived_at := NEW.completed_at;
  ELSIF NEW.archived_at IS DISTINCT FROM OLD.archived_at
        AND NEW.completed_at IS NOT DISTINCT FROM OLD.completed_at THEN
    NEW.completed_at := NEW.archived_at;
  ELSIF NEW.completed_at IS DISTINCT FROM NEW.archived_at THEN
    -- A new server updating both is authoritative on the Completed spelling.
    NEW.archived_at := NEW.completed_at;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER session_completed_at_compat
BEFORE INSERT OR UPDATE OF "completed_at", "archived_at" ON "session"
FOR EACH ROW EXECUTE FUNCTION sync_session_completed_at();

-- Install the trigger before the backfill so an old replica can never restore/complete a row
-- in a gap between copying historical data and enabling dual-write compatibility. The explicit
-- transaction makes the column, trigger and backfill visible atomically.
UPDATE "session"
SET "completed_at" = "archived_at"
WHERE "completed_at" IS DISTINCT FROM "archived_at";

COMMIT;
