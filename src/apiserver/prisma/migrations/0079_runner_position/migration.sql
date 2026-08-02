-- Persist a single runner order shared by the sidebar and the Runners page.
ALTER TABLE "runner" ADD COLUMN "position" INTEGER;

-- Preserve the sidebar's existing visual order. A runner with live agents is
-- placed where its first globally ordered agent appears. Runners without a live
-- agent follow in their previous newest-first order. Positions are dense and
-- owner-scoped so subsequent list and reorder operations have one stable source.
WITH "first_agent" AS (
  SELECT DISTINCT ON ("agent"."runner_id")
    "agent"."runner_id",
    "agent"."position",
    "agent"."created_at",
    "agent"."id"
  FROM "agent"
  INNER JOIN "runner"
    ON "runner"."id" = "agent"."runner_id"
    AND "runner"."owner_id" = "agent"."owner_id"
  WHERE "agent"."runner_id" IS NOT NULL
    AND "agent"."deleted_at" IS NULL
  ORDER BY
    "agent"."runner_id",
    "agent"."position" ASC NULLS LAST,
    "agent"."created_at" ASC,
    "agent"."id" ASC
),
"ranked_runner" AS (
  SELECT
    "runner"."id",
    (
      ROW_NUMBER() OVER (
        PARTITION BY "runner"."owner_id"
        ORDER BY
          CASE WHEN "first_agent"."id" IS NULL THEN 1 ELSE 0 END,
          "first_agent"."position" ASC NULLS LAST,
          "first_agent"."created_at" ASC NULLS LAST,
          "first_agent"."id" ASC NULLS LAST,
          "runner"."enrolled_at" DESC,
          "runner"."id" ASC
      ) - 1
    )::INTEGER AS "position"
  FROM "runner"
  LEFT JOIN "first_agent" ON "first_agent"."runner_id" = "runner"."id"
)
UPDATE "runner"
SET "position" = "ranked_runner"."position"
FROM "ranked_runner"
WHERE "runner"."id" = "ranked_runner"."id";
