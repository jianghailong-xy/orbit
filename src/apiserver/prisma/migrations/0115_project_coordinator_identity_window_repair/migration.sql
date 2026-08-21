-- Finish the guarded 0114 deployment and make databases which already applied 0114 compatible.
--
-- The first UPDATE is the only automatic data repair which the committed rows prove safe: a
-- DERIVED seat that still equals the current landing was mechanically derived as far as any old
-- writer can express, so the missing baseline is that landing. EXPLICIT rows are never demoted.
--
-- The BEFORE trigger is the recovery predicate for an already-applied 0114 database. If its first
-- later event is a relocation A -> B, it records A while OLD still exists. The deferred 0114
-- reconciler can then distinguish that derivation from an old binary's explicit C and converges
-- the former to B. An old binary explicitly choosing A is byte-for-byte indistinguishable from a
-- derivation and keeps the documented DERIVED answer; a C choice is not touched.
--
-- Everything is one explicit transaction. Until it commits, the guard installed before 0114
-- remains active; after it commits, the permanent predicate is active before the guard disappears.

BEGIN;

UPDATE "project_runtime" r
   SET "coordinator_identity_landing_id" = p."coordinator_workspace_id",
       "updated_at" = CURRENT_TIMESTAMP
  FROM "project" p
  JOIN "project_member" m
    ON m."project_id" = p."id" AND m."role" = 'COORDINATOR'
 WHERE r."project_id" = p."id"
   AND r."coordinator_identity_source" = 'DERIVED'
   AND r."coordinator_identity_landing_id" IS NULL
   AND p."coordinator_workspace_id" IS NOT NULL
   AND m."agent_id" = p."coordinator_workspace_id";

CREATE OR REPLACE FUNCTION project_coordinator_identity_window_repair() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Only the exact 04R3 gap shape qualifies: provenance says DERIVED, its baseline is absent, and
  -- the existing seat equals the landing before this relocation. A different seat is structural
  -- evidence of an explicit old-binary choice and must remain available to 0114's promotion rule.
  UPDATE "project_runtime" r
     SET "coordinator_identity_landing_id" = OLD."coordinator_workspace_id",
         "updated_at" = CURRENT_TIMESTAMP
   WHERE r."project_id" = OLD."id"
     AND r."coordinator_identity_source" = 'DERIVED'
     AND r."coordinator_identity_landing_id" IS NULL
     AND OLD."coordinator_workspace_id" IS NOT NULL
     AND OLD."coordinator_workspace_id" IS DISTINCT FROM NEW."coordinator_workspace_id"
     AND EXISTS (
       SELECT 1
         FROM "project_member" m
        WHERE m."project_id" = OLD."id"
          AND m."role" = 'COORDINATOR'
          AND m."agent_id" = OLD."coordinator_workspace_id"
     );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_coordinator_identity_window_repair ON "project";
CREATE TRIGGER project_coordinator_identity_window_repair
BEFORE UPDATE OF "coordinator_workspace_id" ON "project"
FOR EACH ROW
WHEN (OLD."coordinator_workspace_id" IS DISTINCT FROM NEW."coordinator_workspace_id")
EXECUTE FUNCTION project_coordinator_identity_window_repair();

DROP TRIGGER IF EXISTS project_coordinator_identity_migration_insert_guard ON "project";
DROP TRIGGER IF EXISTS project_coordinator_identity_migration_update_guard ON "project";
DROP FUNCTION IF EXISTS project_coordinator_identity_migration_guard();

COMMIT;
