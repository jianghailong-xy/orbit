-- A spawn tree is a real thing in the scheduler, but nothing in the schema said so. It was
-- borrowed from batch-run grouping: spawnFromSession tagged every descendant with
-- `batch_id = parent.batchId ?? parentSessionId` so the claim queue's per-batch cap would
-- bound fan-out. Two different concepts on one field. A batch run is a closed set the user
-- picked up front, with a cap they chose; a spawn tree is open, grows on its own, and is
-- capped by a server constant. Reading the tree also meant walking parent links one query
-- per level (spawnDepth), and the root session — whose id names the tree — carried no
-- batch_id at all, so it was not counted as part of it.
--
-- Name the tree instead. `root_session_id` is the session the tree grew from (a root points
-- at itself once it has spawned anything), `spawn_depth` is the number of parent links above
-- the row. Both are written at creation, so the tree is one indexed read rather than a
-- recursive walk. NULL root_session_id means the session is not part of any spawn tree,
-- which is most of them.
ALTER TABLE "session" ADD COLUMN "root_session_id" UUID;
ALTER TABLE "session" ADD COLUMN "spawn_depth" INTEGER NOT NULL DEFAULT 0;

-- The claim queue's tree cap counts a tree's active turns, so it reads exactly this pair.
CREATE INDEX "session_root_session_id_status_idx" ON "session" ("root_session_id", "status");

-- Backfill from the parent links that are already there. Seeded from sessions that have
-- children (a session that never spawned is in no tree and keeps NULL), then one level per
-- iteration. The depth bound is a guard, not a limit: parent links are written child-after-
-- parent so they cannot cycle, but a corrupt chain must not spin here forever.
WITH RECURSIVE tree AS (
  SELECT s.id, s.id AS root_id, 0 AS depth
  FROM "session" s
  WHERE s."parent_session_id" IS NULL
    AND EXISTS (SELECT 1 FROM "session" c WHERE c."parent_session_id" = s.id)
  UNION ALL
  SELECT s.id, t.root_id, t.depth + 1
  FROM "session" s
  JOIN tree t ON s."parent_session_id" = t.id
  WHERE t.depth < 64
)
UPDATE "session" SET "root_session_id" = tree.root_id, "spawn_depth" = tree.depth
FROM tree
WHERE "session".id = tree.id;

-- Release the borrowed field. A descendant tagged by orchestration is exactly a row whose
-- batch_id is its tree's root id — that is the tagging rule spawnFromSession applied — so
-- clearing those leaves genuine batch runs (a randomUUID batch id, no parent link) untouched.
-- Without this the same rows would be gated twice after the queue splits the two caps: once
-- as a tree, and again as a "batch" whose count has no supervisor exemption, which is the
-- deadlock this whole change exists to remove.
UPDATE "session"
SET "batch_id" = NULL, "batch_max_concurrent" = NULL
WHERE "batch_id" IS NOT NULL
  AND "batch_id" = "root_session_id";
