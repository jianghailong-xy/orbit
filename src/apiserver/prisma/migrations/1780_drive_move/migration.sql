-- 1780 — drive_move: who moved or renamed a drive entry, and from which session (drive/drive.service.ts rename,
-- drive/drive-activity.ts; the Drive page's activity view, GET /drive/activity).
--
-- WHAT IT ADDS
-- ============
-- The drive already keeps who made each of its other changes: a version its writer (drive_version.writer_*), a deletion
-- its actor (drive_trash_group.actor_*), a sync its session (drive_sync.session_id), and a Drive chat every change it
-- made (drive_chat_change). A move or a rename kept none: the entry's last_writer_* is overwritten by its next write,
-- and drive_change is kept a day and names no one. `drive_move` is one row per move or rename the name layer makes:
-- the entry, `kind` (MOVE when the folder changed, else RENAME), the folder it went into, and its actor as the name
-- layer checked it (OWNER, or AGENT with the session only when it is the owner's on the runner the write came through).
-- A move the owner's Apply of a Drive chat's held changes makes is not written here: it is the chat's, in
-- drive_chat_change. Kept 30 days (files/file-retention-sweep.ts).
--
--   No foreign key to drive_entry, the folder or the session: an entry deleted for good, or a session, leaves its
--   history read by id. The owner takes its rows with it.
--
-- LOCKS
-- =====
-- The foreign key takes SHARE ROW EXCLUSIVE on "user" for a moment, so the lock is taken in short tries, as 1700 takes
-- its own: 2 s each, 1 s apart, at most 45, then a clear error. The table is new and empty: nothing is scanned. Safe to
-- run twice.
--
-- BACKWARD COMPATIBLE
-- ===================
-- A new table nothing older reads or writes.
--
-- 1780: the highest number in use on origin/main was 1750 and on origin's branches 1770 (2026-11-28).

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      CREATE TABLE IF NOT EXISTS "drive_move" (
        "id"               UUID NOT NULL,
        "owner_id"         UUID NOT NULL,
        "entry_id"         UUID NOT NULL,
        "kind"             TEXT NOT NULL,
        "folder_id"        UUID NOT NULL,
        "actor_kind"       TEXT NOT NULL,
        "actor_session_id" UUID,
        "actor_runner_id"  UUID,
        "at"               TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "drive_move_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "drive_move_kind_chk" CHECK ("kind" IN ('MOVE', 'RENAME')),
        CONSTRAINT "drive_move_actor_kind_chk" CHECK ("actor_kind" IN ('OWNER', 'AGENT')),
        CONSTRAINT "drive_move_owner_id_fkey" FOREIGN KEY ("owner_id")
          REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE
      );
      CREATE INDEX IF NOT EXISTS "drive_move_owner_at_idx" ON "drive_move"("owner_id", "at");
      CREATE INDEX IF NOT EXISTS "drive_move_at_idx" ON "drive_move"("at");
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      tries := tries + 1;
      IF tries >= 45 THEN
        RAISE EXCEPTION '1780: "user" was not free in 45 tries of 2 s each. Once what holds it has ended, mark the migration rolled back (prisma migrate resolve --rolled-back 1780_drive_move) and deploy again: it is safe to run twice.'
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;
