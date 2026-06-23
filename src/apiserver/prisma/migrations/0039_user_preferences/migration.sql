-- Per-account UI preferences (theme, new-agent defaults), stored as JSONB so adding
-- new preference keys later needs no migration. Defaults to an empty object; a missing
-- key falls back to the app default in the app layer. No backfill: '{}' == "nothing set".
ALTER TABLE "user" ADD COLUMN "preferences" JSONB NOT NULL DEFAULT '{}';
