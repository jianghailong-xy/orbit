-- 1551 — the drive tables are called document_* (Orbit Files is renamed Documents, project 352m8OwBHdxxcHAOboe9B).
--
-- WHAT IT RENAMES
-- ===============
-- The ten tables of migrations 1283, 1327, 1339 and 1438 (columns added later by 1440, indexes by 1439 and 1448):
--
--   drive_staging          -> document_staging          drive_entry          -> document_entry
--   drive_staging_chunk    -> document_staging_chunk    drive_version        -> document_version
--   drive_version_chunk    -> document_version_chunk    drive_commit         -> document_commit
--   drive_trash_group      -> document_trash_group      drive_removed_entry  -> document_removed_entry
--   drive_change           -> document_change           drive_mount_credential -> document_mount_credential
--
-- and every constraint (primary keys, unique keys, foreign keys, checks), index (partial and trigram ones included)
-- and sequence (drive_change_seq_seq) of those tables whose name begins `drive_`, to the same name beginning
-- `document_`. Prisma's own names are `<table>_pkey` and the `map:` names schema.prisma states, which follow the same
-- rule, so `prisma migrate diff` reports on these tables only what it reported before: the owner foreign key of
-- document_commit that schema.prisma declares and 1327 never made. Nothing is created here; adding that key is a
-- separate change, after a read-only count on production of commit rows whose owner has no user.
--
-- WHAT IT KEEPS
-- =============
-- Every row, column, value, default and reference: a rename changes the catalog's name for an object, never the
-- object. A foreign key, a column default (nextval of the renamed sequence) and an index point at their objects by
-- oid, so they follow the rename with nothing rewritten. No function, trigger or view names these tables.
--   * file_blob and its store (src/apiserver/src/files) are the generic attachment store, which attachments, the
--     drive's chunks and the retention sweep all share; they are not the drive, and keep their names.
--   * share_link's drive_entry_id and drive_version_id columns (1340), and the share_link_drive_* constraints and
--     indexes, belong to share_link and keep their names: renaming a column of that table is a separate change.
--
-- AN OLDER APISERVER
-- ==================
-- One still running after this commits finds no drive_* table and answers its drive requests with an error until it
-- is replaced; nothing it fails to write is lost, since the writer (upload, mount, tool) retries its commit.
--
-- TAKING THE LOCKS IN SHORT TRIES
-- ===============================
-- As in 1527: a rename takes ACCESS EXCLUSIVE on its table, and a waiting one queues every later reader behind it. The
-- DO below takes every lock the file needs together, 1 s per lock with 1 s between tries, up to 40 tries, so the
-- statements after it find them held. Every statement can run twice: a table already renamed is locked by its new
-- name and skipped by ALTER TABLE IF EXISTS, and the loop finds no drive_* name left.
--
-- 1551: the highest number on main was 1547 (1547_pull_request_review_announced), and 1550 on the project line and
-- every local orbit/* branch, when this was written.

DO $$
DECLARE
  tries integer := 0;
  base  text;
BEGIN
  PERFORM set_config('lock_timeout', '1s', true);
  LOOP
    BEGIN
      FOREACH base IN ARRAY ARRAY['staging', 'staging_chunk', 'version_chunk', 'trash_group', 'entry', 'version',
                                  'commit', 'removed_entry', 'change', 'mount_credential'] LOOP
        IF to_regclass(format('%I', 'drive_' || base)) IS NOT NULL THEN
          EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE', 'drive_' || base);
        ELSIF to_regclass(format('%I', 'document_' || base)) IS NOT NULL THEN
          EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE', 'document_' || base);
        END IF;
      END LOOP;
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      tries := tries + 1;
      IF tries >= 40 THEN
        RAISE;
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
  PERFORM set_config('lock_timeout', '0', true);
END $$;

ALTER TABLE IF EXISTS "drive_staging"          RENAME TO "document_staging";
ALTER TABLE IF EXISTS "drive_staging_chunk"    RENAME TO "document_staging_chunk";
ALTER TABLE IF EXISTS "drive_version_chunk"    RENAME TO "document_version_chunk";
ALTER TABLE IF EXISTS "drive_trash_group"      RENAME TO "document_trash_group";
ALTER TABLE IF EXISTS "drive_entry"            RENAME TO "document_entry";
ALTER TABLE IF EXISTS "drive_version"          RENAME TO "document_version";
ALTER TABLE IF EXISTS "drive_commit"           RENAME TO "document_commit";
ALTER TABLE IF EXISTS "drive_removed_entry"    RENAME TO "document_removed_entry";
ALTER TABLE IF EXISTS "drive_change"           RENAME TO "document_change";
ALTER TABLE IF EXISTS "drive_mount_credential" RENAME TO "document_mount_credential";

-- Constraints first: renaming a primary or unique key renames the index behind it too. Then the indexes no constraint
-- owns, then the sequences the tables own. Only objects of the ten tables are touched; a share_link_drive_* name is
-- share_link's and does not begin `drive_`.
DO $$
DECLARE
  tables regclass[] := ARRAY(
    SELECT to_regclass(format('%I', 'document_' || base))
    FROM unnest(ARRAY['staging', 'staging_chunk', 'version_chunk', 'trash_group', 'entry', 'version', 'commit',
                      'removed_entry', 'change', 'mount_credential']) AS base
  );
  r record;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass AS tbl, c.conname AS name
    FROM pg_constraint c
    WHERE c.conrelid = ANY (tables) AND c.conname LIKE 'drive\_%'
    ORDER BY c.conname
  LOOP
    EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', r.tbl, r.name,
                   'document_' || substr(r.name, length('drive_') + 1));
  END LOOP;

  FOR r IN
    SELECT i.indexrelid::regclass AS idx, ic.relname AS name
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    WHERE i.indrelid = ANY (tables) AND ic.relname LIKE 'drive\_%'
    ORDER BY ic.relname
  LOOP
    EXECUTE format('ALTER INDEX %s RENAME TO %I', r.idx, 'document_' || substr(r.name, length('drive_') + 1));
  END LOOP;

  FOR r IN
    SELECT s.oid::regclass AS seq, s.relname AS name
    FROM pg_class s
    JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = s.oid AND d.deptype = 'a'
    WHERE s.relkind = 'S' AND d.refobjid = ANY (tables) AND s.relname LIKE 'drive\_%'
    ORDER BY s.relname
  LOOP
    EXECUTE format('ALTER SEQUENCE %s RENAME TO %I', r.seq, 'document_' || substr(r.name, length('drive_') + 1));
  END LOOP;
END $$;
