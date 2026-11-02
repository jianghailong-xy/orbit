-- 0462 — Orbit Files, the storage layer (docs/orbit-files-design.md §2.1, §2.10): an attachment's bytes move
-- out of Postgres into a store addressed by their sha256, and the attachment row keeps what describes them.
--
--   file_blob                    One row per distinct content, however many attachments name it:
--                                  sha256              PRIMARY KEY, 64 lowercase hex;
--                                  size_bytes          the content's length;
--                                  storage             where the bytes are: 'local' (the files directory,
--                                                      ORBIT_FILES_DIR, at <sha256[0:2]>/<sha256>) or 's3'
--                                                      (files/<sha256[0:2]>/<sha256> in ORBIT_FILES_S3_BUCKET);
--                                  last_referenced_at  the last time an upload stored these bytes or found
--                                                      them already stored.
--   attachment.sha256            The bytes this row is: the file_blob of that name. NULL on a row whose bytes are
--                                still in `data`, which is every row written before this migration until the
--                                migration of old attachments moves them; the read paths take a row's bytes from
--                                the store when it names some, and from `data` otherwise. ON DELETE RESTRICT: a
--                                file_blob row cannot go while an attachment names it.
--   attachment.retention, expires_at, expired_at, pinned_at, file_bundle_id, evidence_id
--                                The retention rules (§2.8), folder bundles (§2.2) and FILE evidence (§2.4) are
--                                written by the tasks that build them; the columns are created here so that the
--                                attachment table changes shape once. NULL on every row, which reads as before:
--                                an attachment follows its session or task.
--   attachment.data              Nullable: a row whose bytes are in the store keeps none here.
--   attachment_bytes_present     Every row has its bytes somewhere, in `data` or in the file_blob `sha256` names.
--                                A copy that dropped both would be a row nothing can serve; this refuses it at the
--                                writer instead.
--
-- Every new column is nullable with no default, so each ADD is catalog-only: no row is rewritten or backfilled,
-- and every existing row reads exactly as it did. The foreign key and the CHECK each read the table once to
-- validate (every sha256 is NULL, every data is set), under the ALTER's lock and without reading the bytes
-- themselves (TOAST is not opened for an IS NULL test).
--
-- 0462: the next number free on main and on every ref of this repository (2026-11-02; main and every project
-- line end at 0461).

CREATE TABLE "file_blob" (
  "sha256" TEXT NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "storage" TEXT NOT NULL,
  "last_referenced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "file_blob_pkey" PRIMARY KEY ("sha256"),
  CONSTRAINT "file_blob_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "file_blob_size_bytes_check" CHECK ("size_bytes" >= 0),
  CONSTRAINT "file_blob_storage_check" CHECK ("storage" IN ('local', 's3'))
);

ALTER TABLE "attachment"
  ADD COLUMN "sha256" TEXT,
  ADD COLUMN "retention" TEXT,
  ADD COLUMN "expires_at" TIMESTAMP(3),
  ADD COLUMN "expired_at" TIMESTAMP(3),
  ADD COLUMN "pinned_at" TIMESTAMP(3),
  ADD COLUMN "file_bundle_id" UUID,
  ADD COLUMN "evidence_id" UUID,
  ALTER COLUMN "data" DROP NOT NULL;

ALTER TABLE "attachment"
  ADD CONSTRAINT "attachment_sha256_fkey"
  FOREIGN KEY ("sha256") REFERENCES "file_blob"("sha256") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The referencing side of that key: which rows name these bytes, the question every collection of
-- unreferenced bytes asks, and the check a file_blob delete makes.
CREATE INDEX "attachment_sha256_idx" ON "attachment"("sha256");

ALTER TABLE "attachment"
  ADD CONSTRAINT "attachment_bytes_present" CHECK ("data" IS NOT NULL OR "sha256" IS NOT NULL);
