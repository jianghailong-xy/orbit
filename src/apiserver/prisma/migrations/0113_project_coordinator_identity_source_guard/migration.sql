-- Close the statement boundary before 0114 adds coordinator identity provenance.
--
-- Prisma's PostgreSQL migration executor commits each top-level statement unless the migration
-- supplies its own transaction. 0114 has to add columns, backfill them, and then replace the
-- deferred Project reconciliation function. An 0113 writer which commits between those steps can
-- otherwise leave a mechanically-derived coordinator with no derivation baseline.
--
-- This migration deliberately sorts after 0113 and before 0114. The guard is committed before
-- Prisma starts 0114 and remains installed until 0115 has repaired compatible rows and installed
-- the permanent no-baseline predicate. A deploy interrupted anywhere in between is fail-closed:
-- old writers receive the stable SQLSTATE ORB02 and can retry after migration resumes.

BEGIN;

CREATE OR REPLACE FUNCTION project_coordinator_identity_migration_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'project coordinator identity provenance migration is in progress; retry this write'
    USING ERRCODE = 'ORB02',
          HINT = 'retry after prisma migrate deploy has completed';
END;
$$;

DROP TRIGGER IF EXISTS project_coordinator_identity_migration_insert_guard ON "project";
CREATE TRIGGER project_coordinator_identity_migration_insert_guard
BEFORE INSERT ON "project"
FOR EACH ROW EXECUTE FUNCTION project_coordinator_identity_migration_guard();

DROP TRIGGER IF EXISTS project_coordinator_identity_migration_update_guard ON "project";
CREATE TRIGGER project_coordinator_identity_migration_update_guard
BEFORE UPDATE OF "coordinator_workspace_id", "coordinator_session_id" ON "project"
FOR EACH ROW EXECUTE FUNCTION project_coordinator_identity_migration_guard();

COMMIT;
