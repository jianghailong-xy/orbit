-- Drive search (GET /drive/search): a case-insensitive substring match on a live entry's name, anywhere in the
-- owner's drive. Trigrams (pg_trgm, from 0068) serve ILIKE '%q%'; the index is partial on live entries, which is
-- all the route reads. Not CONCURRENTLY: Prisma runs a migration in a transaction.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "drive_entry_name_trgm" ON "drive_entry" USING gin ("name" gin_trgm_ops) WHERE "trashed_at" IS NULL;
