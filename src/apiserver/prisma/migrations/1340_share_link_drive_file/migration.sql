-- 1340 — share_link roots at one drive file (docs/orbit-files-drive-technical-design.md §9).
--
--   drive_entry_id    The file shared: the fifth root column beside session_id, task_id, project_id and wiki_space_id.
--   drive_version_id  The version of it the link serves. A link is pinned: bytes written to the file later do not reach it
--                     until the owner moves it ("Share this version").
--
-- Both are composite foreign keys on (id, owner_id) as every drive reference is, ON DELETE CASCADE: a link can only ever
-- name a file of its own owner's, and deleting the file, or the pinned version, for good takes the link with it.
-- share_link_one_root_chk (0403) is replaced by the same check over all five roots in one ALTER; a link names a version
-- exactly when it names a file (share_link_drive_pair_chk). One partial unique index keeps at most one open link per file.
--
-- No row is written or deleted: every existing link keeps its one root. Every statement can run twice.
-- NUMBERING: the highest number on main and on every project/* and orbit/* branch was 1327 when this was written
-- (2026-11-20); re-check before landing.

ALTER TABLE "share_link"
  ADD COLUMN IF NOT EXISTS "drive_entry_id"   UUID,
  ADD COLUMN IF NOT EXISTS "drive_version_id" UUID;

ALTER TABLE "share_link"
  DROP CONSTRAINT IF EXISTS "share_link_one_root_chk",
  ADD CONSTRAINT "share_link_one_root_chk"
    CHECK (num_nonnulls("session_id", "task_id", "project_id", "wiki_space_id", "drive_entry_id") = 1);

ALTER TABLE "share_link"
  DROP CONSTRAINT IF EXISTS "share_link_drive_pair_chk",
  ADD CONSTRAINT "share_link_drive_pair_chk"
    CHECK (("drive_entry_id" IS NULL) = ("drive_version_id" IS NULL));

DO $$ BEGIN
  ALTER TABLE "share_link"
    ADD CONSTRAINT "share_link_drive_entry_fkey"
    FOREIGN KEY ("drive_entry_id", "owner_id") REFERENCES "drive_entry" ("id", "owner_id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "share_link"
    ADD CONSTRAINT "share_link_drive_version_fkey"
    FOREIGN KEY ("drive_version_id", "owner_id") REFERENCES "drive_version" ("id", "owner_id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "share_link_drive_entry_active_key"
  ON "share_link" ("drive_entry_id") WHERE "revoked_at" IS NULL;
CREATE INDEX IF NOT EXISTS "share_link_drive_version_idx" ON "share_link" ("drive_version_id");
