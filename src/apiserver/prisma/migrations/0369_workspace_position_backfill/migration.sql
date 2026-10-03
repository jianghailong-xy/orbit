-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- `workspace.position` becomes the whole sidebar order: write down the place every live workspace
-- already has, so nobody's list — or the ⌘1‒9 behind it — moves when the clients switch.
--
-- Until now the clients drew a two-key order: runner groups in the order GET /runners returns
-- (`runner.position` NULLS LAST, `enrolled_at`, `id` — arranged on the Runners page), and inside
-- each group the order GET /workspaces returns (`workspace.position` NULLS LAST, `created_at`).
-- A workspace on a runner the owner's list does not carry came after the known runners, its group
-- where it was first seen; a workspace with no runner came last. From this release the clients read
-- `workspace.position` alone (POST /workspaces/reorder writes it). Read alone, today's values would
-- reshuffle the list: most are NULL, and some still hold places from before the sidebar lost its
-- drag, places the runner grouping has been overriding since.
--
-- So each live workspace gets its 0-based index in exactly that two-key order, per owner — the same
-- numbering the reorder endpoint writes. Soft-deleted rows are left alone. A workspace created after
-- this has a NULL position and sorts below every placed one, as it did before.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

WITH "base" AS (
  SELECT w."id", w."owner_id", w."runner_id",
         row_number() OVER (PARTITION BY w."owner_id"
                            ORDER BY w."position" ASC NULLS LAST, w."created_at" ASC, w."id" ASC) AS "base_rank"
    FROM "workspace" w
   WHERE w."deleted_at" IS NULL
),
"runner_rank" AS (
  SELECT r."id", r."owner_id",
         row_number() OVER (PARTITION BY r."owner_id"
                            ORDER BY r."position" ASC NULLS LAST, r."enrolled_at" ASC, r."id" ASC) AS "rank"
    FROM "runner" r
),
"grouped" AS (
  SELECT b."id", b."owner_id", b."base_rank",
         CASE WHEN b."runner_id" IS NULL THEN 2 WHEN rr."id" IS NOT NULL THEN 0 ELSE 1 END AS "tier",
         CASE WHEN rr."id" IS NOT NULL THEN rr."rank"
              ELSE min(b."base_rank") OVER (PARTITION BY b."owner_id", b."runner_id") END AS "group_rank"
    FROM "base" b
    LEFT JOIN "runner_rank" rr ON rr."id" = b."runner_id" AND rr."owner_id" = b."owner_id"
),
"placed" AS (
  SELECT "id",
         (row_number() OVER (PARTITION BY "owner_id" ORDER BY "tier", "group_rank", "base_rank") - 1)::integer AS "position"
    FROM "grouped"
)
UPDATE "workspace" w
   SET "position" = p."position"
  FROM "placed" p
 WHERE w."id" = p."id"
   AND w."position" IS DISTINCT FROM p."position";
