-- 1438 — Orbit Files drive: a file a replacing rename removed (docs/orbit-files-drive-technical-design.md §3.2).
--
--   drive_removed_entry  the name and folder of a source entry a rename onto an existing file removed outright
--
-- The target keeps its id and takes the source's content as a version; the source entry is deleted. A mount handle still
-- writing the source stays bound to its id, so its later commit finds the id here and lands as a new file in Trash named
-- after the source (`successor_id`, made by the first such commit; later ones continue it). No foreign key to the
-- entry, which is gone, nor to the folder or the successor, which may be deleted for good meanwhile: both are read by id
-- and checked. Kept as long as an untouched staging is (seven days); the retention sweep's step 0 prunes older rows.

CREATE TABLE IF NOT EXISTS "drive_removed_entry" (
  "owner_id"      UUID           NOT NULL,
  "entry_id"      UUID           NOT NULL,
  "parent_id"     UUID           NOT NULL,
  "name"          TEXT           NOT NULL,
  "removed_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "successor_id"  UUID,
  CONSTRAINT "drive_removed_entry_pkey" PRIMARY KEY ("owner_id", "entry_id"),
  CONSTRAINT "drive_removed_entry_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "drive_removed_entry_removed_at_idx" ON "drive_removed_entry" ("removed_at");
