-- 0466 — Orbit Files' retention (docs/orbit-files-design.md §2.8; files/file-retention.ts): when a file agents keep with
-- file_upload expires, and when its bytes may go.
--
--   file_blob.released_at        When the sweep first found no attachment row still holding these bytes: every row that
--                                names them has a tombstone, or none is left. Cleared when a row holds them again. The
--                                grace period before the bytes may go runs from here, which also covers a row that was
--                                deleted outright (a session purged, a task input removed), where no tombstone says when.
--   file_blob.bytes_deleted_at   When the store's bytes went. The row stays: an attachment row keeps naming it, and this
--                                is how a read tells bytes that expired from bytes that went missing. An upload of the
--                                same content keeps them again and clears it.
--   file_blob.off_host_prune_at  From when the backup sidecar may remove them from the off-host copy (scripts/pg-backup.sh):
--                                one grace period after they went from here, so that no database a retained backup can
--                                restore still expects them there. Only on bytes of the local store.
--
-- attachment.expires_at, expired_at and pinned_at are 0462's and take no change. An upload's `expires_at` is written with
-- its row from here on; these two indexes are what the sweep and a decision on evidence look rows up by. Both are partial,
-- and every row from before Orbit Files is outside them.
--
-- Rows `file_upload` wrote before this migration have no `expires_at`, which from here on reads as "held by evidence":
--   - one no evidence cites is given its date by the first sweep (files/file-retention-sweep.ts), which also dates what an
--     older apiserver still writes during a rolling upgrade;
--   - one whose newest citing version was sent back or superseded is given its date below: 30 days after that, or 14 days
--     after upload if that is later. A task with a confirmed version is left out: which of its files that version cites is
--     in the version's JSON, which SQL does not read here, so they stay held until that task's next decision or its deletion;
--   - one cited by a version still waiting for a decision stays as it is: held.
-- Nothing expires because of this migration until a sweep runs, and nothing of any other kind of row changes.
--
-- 0466: the next number free on main and on every ref of this repository (2026-11-03; main and every project line end
-- at 0465).

ALTER TABLE "file_blob"
  ADD COLUMN "released_at" TIMESTAMP(3),
  ADD COLUMN "bytes_deleted_at" TIMESTAMP(3),
  ADD COLUMN "off_host_prune_at" TIMESTAMP(3);

-- What the sweep's tombstone asks: which rows have come due.
CREATE INDEX "attachment_expiry_due_idx" ON "attachment"("expires_at")
  WHERE "expires_at" IS NOT NULL AND "expired_at" IS NULL;

-- What a decision on evidence asks: which rows a version of this task names. And the sweep: which name a version that is gone.
CREATE INDEX "attachment_evidence_idx" ON "attachment"("evidence_id")
  WHERE "evidence_id" IS NOT NULL;

UPDATE "attachment" AS a
   SET "expires_at" = GREATEST(a."created_at" + interval '14 days', let_go."at" + interval '30 days')
  FROM (
    SELECT e."id",
           COALESCE(
             (SELECT d."decided_at" FROM "task_evidence_decision" d
               WHERE d."evidence_id" = e."id" AND d."decision" = 'SEND_BACK'),
             (SELECT min(later."submitted_at") FROM "task_completion_evidence" later
               WHERE later."task_id" = e."task_id" AND later."revision" > e."revision")
           ) AS "at"
      FROM "task_completion_evidence" e
     WHERE NOT EXISTS (
       SELECT 1 FROM "task_evidence_decision" c WHERE c."task_id" = e."task_id" AND c."decision" = 'CONFIRM'
     )
  ) AS let_go
 WHERE a."evidence_id" = let_go."id" AND let_go."at" IS NOT NULL
   AND a."retention" = 'file_upload' AND a."expires_at" IS NULL;
