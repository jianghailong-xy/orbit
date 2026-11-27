-- A folder's move to Trash marks what is under it a batch per transaction (docs/orbit-files-drive-technical-design.md
-- §1.4), so a folder of 100,000 entries stays inside the 10 s statement and 20 s transaction bounds. `marking` says a
-- group's marking is still under way: set by the first transaction when it could not mark the whole folder, lifted once
-- a look over the group finds nothing live under a folder of it. A group left marked (its process gone, a bound hit) is
-- finished by deleting the folder again or by the drive's own timer, which finds it by the partial index.
ALTER TABLE "drive_trash_group" ADD COLUMN IF NOT EXISTS "marking" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "drive_trash_group_marking_idx" ON "drive_trash_group" ("owner_id") WHERE "marking";
