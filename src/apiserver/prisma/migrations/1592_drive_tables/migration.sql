-- 1592 — the document_* tables are called drive_* again (Documents is renamed back to Drive, project
-- 35370KiEBDnxlOS5Yyaxh).
--
-- WHAT IT RENAMES
-- ===============
-- The ten tables 1551 renamed to document_*, and document_sync (1560):
--
--   document_staging          -> drive_staging          document_entry            -> drive_entry
--   document_staging_chunk    -> drive_staging_chunk    document_version          -> drive_version
--   document_version_chunk    -> drive_version_chunk    document_commit           -> drive_commit
--   document_trash_group      -> drive_trash_group      document_removed_entry    -> drive_removed_entry
--   document_change           -> drive_change           document_mount_credential -> drive_mount_credential
--   document_sync             -> drive_sync
--
-- and every constraint (primary keys, unique keys, foreign keys, checks), index (partial and trigram ones included)
-- and sequence (document_change_seq_seq) of those tables whose name begins `document_`, to the same name beginning
-- `drive_`. For the ten tables that is exactly the names they had before 1551; Prisma's own names are `<table>_pkey`
-- and the `map:` names schema.prisma states, which follow the same rule. Nothing is created or dropped: the
-- document_commit owner foreign key schema.prisma declares and 1327 never made stays missing, as it was before.
--
-- WHAT IT KEEPS
-- =============
-- Every row, column, value, default and reference: a rename changes the catalog's name for an object, never the
-- object. A foreign key, a column default (nextval of the renamed sequence) and an index point at their objects by
-- oid, so they follow the rename with nothing rewritten. No function, trigger or view names these tables.
--   * file_blob and its store (src/apiserver/src/files) are the generic attachment store and keep their names.
--   * share_link's drive_entry_id and drive_version_id columns (1340), and the share_link_drive_* constraints and
--     indexes, belong to share_link and never changed name; a share_link_drive_* name does not begin `document_`.
--
-- AN OLDER APISERVER
-- ==================
-- One still running after this commits finds no document_* table and answers its drive requests with an error until
-- it is replaced; nothing it fails to write is lost, since the writer (upload, mount, tool, sync) retries.
--
-- TAKING THE LOCKS IN SHORT TRIES
-- ===============================
-- As in 1551: a rename takes ACCESS EXCLUSIVE on its table, and a waiting one queues every later reader behind it.
-- The DO below takes every lock the file needs together, 1 s per lock with 1 s between tries, up to 40 tries, so the
-- statements after it find them held. Every statement can run twice: a table already renamed is locked by its new
-- name and skipped by ALTER TABLE IF EXISTS, and the loop finds no document_* name left.
--
-- 1592: the highest number on main was 1573 (1573_owner_request_project_reopen), and 1590 on any pushed project/* or
-- orbit/* branch (1590_pat_scope_drive), when this was written.

DO $$
DECLARE
  tries integer := 0;
  base  text;
BEGIN
  PERFORM set_config('lock_timeout', '1s', true);
  LOOP
    BEGIN
      FOREACH base IN ARRAY ARRAY['staging', 'staging_chunk', 'version_chunk', 'trash_group', 'entry', 'version',
                                  'commit', 'removed_entry', 'change', 'mount_credential', 'sync'] LOOP
        IF to_regclass(format('%I', 'document_' || base)) IS NOT NULL THEN
          EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE', 'document_' || base);
        ELSIF to_regclass(format('%I', 'drive_' || base)) IS NOT NULL THEN
          EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE', 'drive_' || base);
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

ALTER TABLE IF EXISTS "document_staging"          RENAME TO "drive_staging";
ALTER TABLE IF EXISTS "document_staging_chunk"    RENAME TO "drive_staging_chunk";
ALTER TABLE IF EXISTS "document_version_chunk"    RENAME TO "drive_version_chunk";
ALTER TABLE IF EXISTS "document_trash_group"      RENAME TO "drive_trash_group";
ALTER TABLE IF EXISTS "document_entry"            RENAME TO "drive_entry";
ALTER TABLE IF EXISTS "document_version"          RENAME TO "drive_version";
ALTER TABLE IF EXISTS "document_commit"           RENAME TO "drive_commit";
ALTER TABLE IF EXISTS "document_removed_entry"    RENAME TO "drive_removed_entry";
ALTER TABLE IF EXISTS "document_change"           RENAME TO "drive_change";
ALTER TABLE IF EXISTS "document_mount_credential" RENAME TO "drive_mount_credential";
ALTER TABLE IF EXISTS "document_sync"             RENAME TO "drive_sync";

-- Constraints first: renaming a primary or unique key renames the index behind it too. Then the indexes no constraint
-- owns, then the sequences the tables own. Only objects of the eleven tables are touched.
DO $$
DECLARE
  tables regclass[] := ARRAY(
    SELECT to_regclass(format('%I', 'drive_' || base))
    FROM unnest(ARRAY['staging', 'staging_chunk', 'version_chunk', 'trash_group', 'entry', 'version', 'commit',
                      'removed_entry', 'change', 'mount_credential', 'sync']) AS base
  );
  r record;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass AS tbl, c.conname AS name
    FROM pg_constraint c
    WHERE c.conrelid = ANY (tables) AND c.conname LIKE 'document\_%'
    ORDER BY c.conname
  LOOP
    EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', r.tbl, r.name,
                   'drive_' || substr(r.name, length('document_') + 1));
  END LOOP;

  FOR r IN
    SELECT i.indexrelid::regclass AS idx, ic.relname AS name
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    WHERE i.indrelid = ANY (tables) AND ic.relname LIKE 'document\_%'
    ORDER BY ic.relname
  LOOP
    EXECUTE format('ALTER INDEX %s RENAME TO %I', r.idx, 'drive_' || substr(r.name, length('document_') + 1));
  END LOOP;

  FOR r IN
    SELECT s.oid::regclass AS seq, s.relname AS name
    FROM pg_class s
    JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = s.oid AND d.deptype = 'a'
    WHERE s.relkind = 'S' AND d.refobjid = ANY (tables) AND s.relname LIKE 'document\_%'
    ORDER BY s.relname
  LOOP
    EXECUTE format('ALTER SEQUENCE %s RENAME TO %I', r.seq, 'drive_' || substr(r.name, length('document_') + 1));
  END LOOP;
END $$;
