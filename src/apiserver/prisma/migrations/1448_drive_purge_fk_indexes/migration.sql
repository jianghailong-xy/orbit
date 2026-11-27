-- The entry and version deletes in a Trash batch fire these foreign keys once per row.
-- Index their lookups so the batch does not repeatedly scan the remaining drive or share links.
CREATE INDEX IF NOT EXISTS "drive_entry_current_version_idx" ON "drive_entry" ("current_version_id");
CREATE INDEX IF NOT EXISTS "drive_commit_entry_idx" ON "drive_commit" ("entry_id");
CREATE INDEX IF NOT EXISTS "share_link_drive_entry_idx" ON "share_link" ("drive_entry_id");
