-- Sessions can be soft-archived or soft-deleted: both hide the row from the default
-- list but retain all data (transcript, billing). Reversible via restore (which clears
-- the timestamps) — there is no hard delete. null = active.
ALTER TABLE "session" ADD COLUMN "archived_at" TIMESTAMP(3);
ALTER TABLE "session" ADD COLUMN "deleted_at" TIMESTAMP(3);
