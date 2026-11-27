-- 1283 — Orbit Files drive: the chunk manifest and the staging tables
-- (docs/orbit-files-drive-technical-design.md §1.1, §2.2, §2.4).
--
-- A drive file is an ordered list of chunks of at most 8 MiB, each an ordinary file_blob kept through the existing
-- FileStore, so a file of any size never exists whole on the server's disk.
--
--   drive_staging        a write that is not committed yet: an owner's resumable upload, a write through the mount, or a
--                        drive tool's put
--   drive_staging_chunk  the chunks it has received, one row per index; holds its blob until a commit names it
--   drive_version_chunk  the ordered chunks of one drive version; holds its blob while the row exists
--
-- Both chunk tables name file_blob ON DELETE RESTRICT, as attachment.sha256 does, so inserting one takes FOR KEY SHARE
-- on the blob row, which the retention sweep's FOR UPDATE excludes (files/file-retention-sweep.ts).
--
-- drive_entry and drive_version belong to the name layer (a later migration of the same project). That migration adds
-- the foreign keys this one cannot yet: drive_version_chunk (version_id, owner_id) -> drive_version ON DELETE CASCADE,
-- and drive_staging (entry_id, owner_id) / (parent_id, owner_id) -> drive_entry.

CREATE TABLE IF NOT EXISTS "drive_staging" (
  "id"             UUID         NOT NULL,
  "owner_id"       UUID         NOT NULL,
  "source"         TEXT         NOT NULL,
  "entry_id"       UUID,
  "runner_id"      UUID,
  "generation"     INTEGER,
  "parent_id"      UUID,
  "name"           TEXT,
  "relative_path"  TEXT,
  "declared_size"  BIGINT,
  "dirty"          BOOLEAN      NOT NULL DEFAULT false,
  "created_at"     TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "touched_at"     TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "committed_at"   TIMESTAMPTZ(3),
  CONSTRAINT "drive_staging_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "drive_staging_id_owner_id_key" UNIQUE ("id", "owner_id"),
  CONSTRAINT "drive_staging_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "drive_staging_source_chk" CHECK ("source" IN ('OWNER_UPLOAD', 'MOUNT', 'TOOL')),
  CONSTRAINT "drive_staging_declared_size_chk" CHECK ("declared_size" IS NULL OR "declared_size" >= 0)
);

-- The retention sweep's step 0 finds stagings untouched for 7 days.
CREATE INDEX IF NOT EXISTS "drive_staging_touched_at_idx" ON "drive_staging" ("touched_at");

CREATE TABLE IF NOT EXISTS "drive_staging_chunk" (
  "staging_id"  UUID    NOT NULL,
  "idx"         INTEGER NOT NULL,
  "owner_id"    UUID    NOT NULL,
  "sha256"      TEXT    NOT NULL,
  "size_bytes"  INTEGER NOT NULL,
  CONSTRAINT "drive_staging_chunk_pkey" PRIMARY KEY ("staging_id", "idx"),
  CONSTRAINT "drive_staging_chunk_staging_fkey"
    FOREIGN KEY ("staging_id", "owner_id") REFERENCES "drive_staging"("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "drive_staging_chunk_sha256_fkey"
    FOREIGN KEY ("sha256") REFERENCES "file_blob"("sha256") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "drive_staging_chunk_idx_chk" CHECK ("idx" >= 0),
  CONSTRAINT "drive_staging_chunk_size_chk" CHECK ("size_bytes" BETWEEN 1 AND 8388608)
);

CREATE INDEX IF NOT EXISTS "drive_staging_chunk_sha256_idx" ON "drive_staging_chunk" ("sha256");

CREATE TABLE IF NOT EXISTS "drive_version_chunk" (
  "version_id"  UUID    NOT NULL,
  "idx"         INTEGER NOT NULL,
  "owner_id"    UUID    NOT NULL,
  "offset"      BIGINT  NOT NULL,
  "size_bytes"  INTEGER NOT NULL,
  "sha256"      TEXT    NOT NULL,
  CONSTRAINT "drive_version_chunk_pkey" PRIMARY KEY ("version_id", "idx"),
  CONSTRAINT "drive_version_chunk_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "drive_version_chunk_sha256_fkey"
    FOREIGN KEY ("sha256") REFERENCES "file_blob"("sha256") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "drive_version_chunk_idx_chk" CHECK ("idx" >= 0),
  CONSTRAINT "drive_version_chunk_offset_chk" CHECK ("offset" >= 0),
  CONSTRAINT "drive_version_chunk_size_chk" CHECK ("size_bytes" BETWEEN 1 AND 8388608)
);

CREATE INDEX IF NOT EXISTS "drive_version_chunk_sha256_idx" ON "drive_version_chunk" ("sha256");
