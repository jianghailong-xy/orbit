-- The four §3.4 C8 rows T16b found on the restored production backup, which the projector shapes do not hold: stored
-- SUCCEEDED, end reason `completed`, no last outcome, a CONVERSATION that is no import, filed in Completed. Copies of
-- seeded released conversations with those facts, written as code before D3 writes them (the word with the facts).
-- For the rehearsal copy at D2 only (it names session.status): run it after seed-shapes.cjs, with no apiserver up.
--   docker exec -i <project>-postgres psql -U orbit -d orbit -X -v ON_ERROR_STOP=1 < seed-c8.sql
BEGIN;
CREATE TEMP TABLE c8 ON COMMIT DROP AS
  SELECT * FROM "session"
   WHERE "title" LIKE 'shape:%:open:%' AND "kind" = 'CONVERSATION' AND "finished_at" IS NOT NULL
     AND "import_source_cwd" IS NULL AND "started_at" IS NOT NULL
   ORDER BY "title" LIMIT 4;
UPDATE c8 SET "id" = gen_random_uuid(), "title" = 'shape:C8 seeded:completed:' || "title", "share_token" = NULL,
              "status" = 'SUCCEEDED', "end_reason" = 'completed', "last_turn_outcome" = NULL,
              "completed_at" = "finished_at", "deleted_at" = NULL, "archived_at" = NULL;
INSERT INTO "session" SELECT * FROM c8;
SELECT count(*) AS c8_rows FROM "session" WHERE "title" LIKE 'shape:C8 seeded:%';
COMMIT;
