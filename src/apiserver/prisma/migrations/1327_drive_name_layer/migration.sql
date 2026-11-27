-- 1327 — Orbit Files drive: the name layer (docs/orbit-files-drive-technical-design.md §1.1, §3, §5.4).
--
--   drive_trash_group  what one deletion (DELETE) or one overwrite (VERSION) put in Trash
--   drive_entry        one folder or file of an account's drive, live or in Trash
--   drive_version      one content a file has had: the current one, or a replaced one in Trash
--   drive_commit       the answer to a commit, kept a day so a retried commit is answered and never applied twice
--   drive_change       the change feed the mount and the web page follow, kept a day
--
-- Every reference between drive tables is a composite foreign key on (id, owner_id), as the wiki's are, so a row can
-- only ever name a row of the same account. This migration also adds the foreign keys 1283 could not:
-- drive_version_chunk -> drive_version, and drive_staging -> drive_entry.
--
-- drive_trash_group.folder_id names the folder a deletion was made from for display only; it has no foreign key (the
-- folder may later be deleted for good) and folder_path keeps its path as it was.

CREATE TABLE IF NOT EXISTS "drive_trash_group" (
  "id"               UUID           NOT NULL,
  "owner_id"         UUID           NOT NULL,
  "kind"             TEXT           NOT NULL,
  "folder_id"        UUID,
  "folder_path"      TEXT           NOT NULL,
  "created_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "last_added_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "closed_at"        TIMESTAMPTZ(3),
  "burst_key"        TEXT,
  "actor_kind"       TEXT           NOT NULL,
  "actor_session_id" UUID,
  "actor_runner_id"  UUID,
  "item_count"       INTEGER        NOT NULL DEFAULT 0,
  "size_bytes"       BIGINT         NOT NULL DEFAULT 0,
  CONSTRAINT "drive_trash_group_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "drive_trash_group_id_owner_id_key" UNIQUE ("id", "owner_id"),
  CONSTRAINT "drive_trash_group_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "drive_trash_group_kind_chk" CHECK ("kind" IN ('DELETE', 'VERSION')),
  CONSTRAINT "drive_trash_group_actor_kind_chk" CHECK ("actor_kind" IN ('OWNER', 'AGENT'))
);

-- The Trash list, newest first; and the open burst group a delete through the mount joins (§3.4).
CREATE INDEX IF NOT EXISTS "drive_trash_group_owner_created_idx" ON "drive_trash_group" ("owner_id", "created_at");
CREATE INDEX IF NOT EXISTS "drive_trash_group_burst_idx" ON "drive_trash_group" ("owner_id", "burst_key")
  WHERE "burst_key" IS NOT NULL AND "closed_at" IS NULL;

CREATE TABLE IF NOT EXISTS "drive_entry" (
  "id"                      UUID           NOT NULL,
  "owner_id"                UUID           NOT NULL,
  "parent_id"               UUID,
  "kind"                    TEXT           NOT NULL,
  "name"                    TEXT           NOT NULL,
  "current_version_id"      UUID,
  "size_bytes"              BIGINT         NOT NULL DEFAULT 0,
  "mtime"                   TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "created_at"              TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at"              TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "last_writer_kind"        TEXT           NOT NULL,
  "last_writer_session_id"  UUID,
  "last_writer_runner_id"   UUID,
  "last_written_at"         TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "trashed_at"              TIMESTAMPTZ(3),
  "trash_group_id"          UUID,
  "trash_top"               BOOLEAN        NOT NULL DEFAULT false,
  "seq"                     BIGINT         NOT NULL DEFAULT 0,
  CONSTRAINT "drive_entry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "drive_entry_id_owner_id_key" UNIQUE ("id", "owner_id"),
  CONSTRAINT "drive_entry_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- Deleting a folder for good takes everything under it.
  CONSTRAINT "drive_entry_parent_fkey"
    FOREIGN KEY ("parent_id", "owner_id") REFERENCES "drive_entry"("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "drive_entry_trash_group_fkey"
    FOREIGN KEY ("trash_group_id", "owner_id") REFERENCES "drive_trash_group"("id", "owner_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "drive_entry_kind_chk" CHECK ("kind" IN ('FOLDER', 'FILE')),
  -- A file always has a current version: written in the same transaction, the version's id chosen first, so the
  -- foreign key below is the one that waits for the commit.
  CONSTRAINT "drive_entry_version_chk" CHECK (("kind" = 'FILE') = ("current_version_id" IS NOT NULL)),
  CONSTRAINT "drive_entry_trash_chk" CHECK (("trashed_at" IS NULL) = ("trash_group_id" IS NULL)),
  -- The root (no parent) is a folder named ''. Any other name is 1-255 bytes, no '/', not '.' or '..'; a NUL cannot be
  -- in a text value at all.
  CONSTRAINT "drive_entry_root_chk" CHECK (
    ("parent_id" IS NULL) = ("name" = '') AND ("parent_id" IS NOT NULL OR ("kind" = 'FOLDER' AND "trashed_at" IS NULL))
  ),
  CONSTRAINT "drive_entry_name_chk" CHECK (
    "parent_id" IS NULL
    OR (octet_length("name") BETWEEN 1 AND 255 AND strpos("name", '/') = 0 AND "name" NOT IN ('.', '..'))
  ),
  CONSTRAINT "drive_entry_size_chk" CHECK ("size_bytes" >= 0)
);

-- One live name per folder; a trashed entry keeps its name and place, so the name is free again at once.
CREATE UNIQUE INDEX IF NOT EXISTS "drive_entry_live_name_key" ON "drive_entry" ("owner_id", "parent_id", "name")
  WHERE "trashed_at" IS NULL;
-- One root per account, made by the first drive call.
CREATE UNIQUE INDEX IF NOT EXISTS "drive_entry_root_key" ON "drive_entry" ("owner_id") WHERE "parent_id" IS NULL;
CREATE INDEX IF NOT EXISTS "drive_entry_trash_group_idx" ON "drive_entry" ("owner_id", "trash_group_id");
-- The parent foreign key's cascade and the walk below a folder, trashed children included.
CREATE INDEX IF NOT EXISTS "drive_entry_parent_idx" ON "drive_entry" ("parent_id");

CREATE TABLE IF NOT EXISTS "drive_version" (
  "id"                 UUID           NOT NULL,
  "owner_id"           UUID           NOT NULL,
  "entry_id"           UUID           NOT NULL,
  "size_bytes"         BIGINT         NOT NULL DEFAULT 0,
  "chunk_count"        INTEGER        NOT NULL DEFAULT 0,
  "created_at"         TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  -- The mount handle, upload or tool call still writing this version: a later commit of the same handle continues it.
  -- Chosen by the writer, compared for equality and never looked up, so it is text, not an id.
  "handle_id"          TEXT,
  "writer_kind"        TEXT           NOT NULL,
  "writer_session_id"  UUID,
  "writer_runner_id"   UUID,
  "replaced_at"        TIMESTAMPTZ(3),
  "trash_group_id"     UUID,
  CONSTRAINT "drive_version_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "drive_version_id_owner_id_key" UNIQUE ("id", "owner_id"),
  CONSTRAINT "drive_version_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "drive_version_entry_fkey"
    FOREIGN KEY ("entry_id", "owner_id") REFERENCES "drive_entry"("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "drive_version_trash_group_fkey"
    FOREIGN KEY ("trash_group_id", "owner_id") REFERENCES "drive_trash_group"("id", "owner_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "drive_version_writer_kind_chk" CHECK ("writer_kind" IN ('OWNER', 'AGENT')),
  CONSTRAINT "drive_version_size_chk" CHECK ("size_bytes" >= 0 AND "chunk_count" >= 0),
  -- Only a replaced version is ever in Trash.
  CONSTRAINT "drive_version_trash_chk" CHECK ("trash_group_id" IS NULL OR "replaced_at" IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS "drive_version_entry_idx" ON "drive_version" ("entry_id");
CREATE INDEX IF NOT EXISTS "drive_version_trash_group_idx" ON "drive_version" ("owner_id", "trash_group_id");

ALTER TABLE "drive_entry" ADD CONSTRAINT "drive_entry_current_version_fkey"
  FOREIGN KEY ("current_version_id", "owner_id") REFERENCES "drive_version"("id", "owner_id")
  ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- The foreign keys 1283 left to this migration.
ALTER TABLE "drive_version_chunk" ADD CONSTRAINT "drive_version_chunk_version_fkey"
  FOREIGN KEY ("version_id", "owner_id") REFERENCES "drive_version"("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "drive_staging" ADD CONSTRAINT "drive_staging_entry_fkey"
  FOREIGN KEY ("entry_id", "owner_id") REFERENCES "drive_entry"("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "drive_staging" ADD CONSTRAINT "drive_staging_parent_fkey"
  FOREIGN KEY ("parent_id", "owner_id") REFERENCES "drive_entry"("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "drive_staging_entry_idx" ON "drive_staging" ("entry_id");
CREATE INDEX IF NOT EXISTS "drive_staging_parent_idx" ON "drive_staging" ("parent_id");

CREATE TABLE IF NOT EXISTS "drive_commit" (
  "owner_id"    UUID           NOT NULL,
  -- Chosen by the writer and kept across its own retries; looked up only within its owner.
  "commit_id"   TEXT           NOT NULL,
  "entry_id"    UUID           NOT NULL,
  "result"      JSONB          NOT NULL,
  "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "drive_commit_pkey" PRIMARY KEY ("owner_id", "commit_id"),
  CONSTRAINT "drive_commit_entry_fkey"
    FOREIGN KEY ("entry_id", "owner_id") REFERENCES "drive_entry"("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "drive_commit_id_chk" CHECK (length("commit_id") BETWEEN 1 AND 200)
);

-- The retention sweep's step 0 prunes answers older than a day.
CREATE INDEX IF NOT EXISTS "drive_commit_created_at_idx" ON "drive_commit" ("created_at");

CREATE TABLE IF NOT EXISTS "drive_change" (
  "seq"        BIGSERIAL      NOT NULL,
  "owner_id"   UUID           NOT NULL,
  "entry_id"   UUID           NOT NULL,
  "parent_id"  UUID,
  "op"         TEXT           NOT NULL,
  -- The clock when the row was inserted, not when its transaction began: what the feed's look-back reads (§5.4).
  "at"         TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "drive_change_pkey" PRIMARY KEY ("seq"),
  CONSTRAINT "drive_change_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "drive_change_op_chk" CHECK ("op" IN ('UPSERT', 'REMOVE'))
);

CREATE INDEX IF NOT EXISTS "drive_change_owner_seq_idx" ON "drive_change" ("owner_id", "seq");
CREATE INDEX IF NOT EXISTS "drive_change_owner_at_idx" ON "drive_change" ("owner_id", "at");
CREATE INDEX IF NOT EXISTS "drive_change_at_idx" ON "drive_change" ("at");
