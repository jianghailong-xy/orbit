-- 1560 — an agent's directory sync into the owner's Documents, as the upload tray shows it
-- (docs/documents-directory-sync-design.md S4, "How the progress gets there").
--
--   document_sync  one `orbit documents sync` run: where it copies to, how far it has got, and how it ended
--
-- The runner that runs the sync opens the row and reports into it every two seconds; the owner's Documents page reads
-- it. `status` CHECKING | UPLOADING while it runs, DONE | FAILED | STOPPED once it ended (`ended_at` set). DONE may still
-- list files that failed (`failed`, `failed_count`); FAILED is a sync that could not finish at all, `error` saying why. A running row
-- the runner stopped reporting into reads as STOPPED (worked out on read, not written). Ended rows are kept 24 hours:
-- opening a sync deletes the owner's rows that ended before that.
--
-- `source_name` is the local directory's last segment only, never a runner path. `session_id` and `dest_entry_id` are
-- history read by id, not keys: a deleted session or folder must not take the row with it, and the row names no drive
-- table, so the Files → Documents table rename (1551) does not touch it. Its name already follows that rename.
--
-- Additive only: a new table, read by nothing older. Every statement can run twice.
--
-- 1560: the highest number on main was 1547, and 1550 and 1551 are taken on the Documents rename branches, when this
-- was written.

CREATE TABLE IF NOT EXISTS "document_sync" (
  "id"            UUID           NOT NULL,
  "owner_id"      UUID           NOT NULL,
  "runner_id"     UUID           NOT NULL,
  "session_id"    UUID,
  "source_name"   TEXT           NOT NULL,
  "dest_path"     TEXT           NOT NULL,
  "dest_entry_id" UUID,
  "status"        TEXT           NOT NULL DEFAULT 'CHECKING',
  "files_seen"    INTEGER        NOT NULL DEFAULT 0,
  "files_total"   INTEGER,
  "files_done"    INTEGER        NOT NULL DEFAULT 0,
  "files_same"    INTEGER        NOT NULL DEFAULT 0,
  "files_deleted" INTEGER        NOT NULL DEFAULT 0,
  "bytes_total"   BIGINT,
  "bytes_sent"    BIGINT         NOT NULL DEFAULT 0,
  "current_path"  TEXT,
  "failed"        JSONB          NOT NULL DEFAULT '[]',
  "failed_count"  INTEGER        NOT NULL DEFAULT 0,
  "error"         TEXT,
  "started_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "ended_at"      TIMESTAMPTZ(3),
  CONSTRAINT "document_sync_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "document_sync_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "document_sync_runner_id_fkey"
    FOREIGN KEY ("runner_id") REFERENCES "runner"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "document_sync_status_check"
    CHECK ("status" IN ('CHECKING', 'UPLOADING', 'DONE', 'FAILED', 'STOPPED')),
  CONSTRAINT "document_sync_ended_check"
    CHECK (("ended_at" IS NULL) = ("status" IN ('CHECKING', 'UPLOADING'))),
  CONSTRAINT "document_sync_counts_check"
    CHECK ("files_seen" >= 0 AND "files_done" >= 0 AND "files_same" >= 0 AND "files_deleted" >= 0
       AND "failed_count" >= 0 AND "bytes_sent" >= 0)
);

-- The tray's read: an owner's syncs, newest first; and the prune of rows ended a day ago.
CREATE INDEX IF NOT EXISTS "document_sync_owner_started_idx" ON "document_sync" ("owner_id", "started_at" DESC);

-- A runner deleted with ON DELETE CASCADE finds its rows by index.
CREATE INDEX IF NOT EXISTS "document_sync_runner_id_idx" ON "document_sync" ("runner_id");
