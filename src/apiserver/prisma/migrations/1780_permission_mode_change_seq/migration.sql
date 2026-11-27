-- 1780 — the order mode changes were recorded in, which their time alone cannot give.
--
-- session_permission_mode_change.created_at is TIMESTAMP(3): two changes recorded in the same millisecond (a pick and
-- the engine's report of it, Auto → Plan → Auto in one batch) share a time, and the row's random id says nothing about
-- which came first. `seq` is the order of insertion: recordActualPermissionMode inserts under the session row it locks,
-- so one session's changes take their numbers in the order they happened. It is what the detail orders them by and
-- what the page of older changes continues from (GET /sessions/:id/permission-mode-changes?before=<seq>).
--
-- Rows already recorded are numbered by created_at, and by their place in the heap where the time is shared (an
-- append-only table's rows sit there in the order they were inserted).

CREATE SEQUENCE IF NOT EXISTS "session_permission_mode_change_seq_seq";

ALTER TABLE "session_permission_mode_change" ADD COLUMN IF NOT EXISTS "seq" BIGINT;

WITH "ordered" AS (
  SELECT "id", row_number() OVER (ORDER BY "created_at", ctid) AS "n"
  FROM "session_permission_mode_change"
)
UPDATE "session_permission_mode_change" AS c
SET "seq" = "ordered"."n"
FROM "ordered"
WHERE c."id" = "ordered"."id";

SELECT setval(
  '"session_permission_mode_change_seq_seq"',
  GREATEST(COALESCE((SELECT max("seq") FROM "session_permission_mode_change"), 0), 1),
  (SELECT max("seq") FROM "session_permission_mode_change") IS NOT NULL
);

ALTER TABLE "session_permission_mode_change"
  ALTER COLUMN "seq" SET DEFAULT nextval('"session_permission_mode_change_seq_seq"'),
  ALTER COLUMN "seq" SET NOT NULL;
ALTER SEQUENCE "session_permission_mode_change_seq_seq" OWNED BY "session_permission_mode_change"."seq";

CREATE INDEX IF NOT EXISTS "session_permission_mode_change_session_id_seq_idx"
  ON "session_permission_mode_change" ("session_id", "seq");
