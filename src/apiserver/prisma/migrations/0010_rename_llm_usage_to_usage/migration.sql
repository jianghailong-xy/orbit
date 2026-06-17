-- Rename the llm_usage table to usage to match @@map("usage") in schema.prisma.
-- Prisma Client field names are unchanged; this only renames physical DB objects.
-- All statements are RENAME (data-preserving); no DROP/CREATE.

-- table
ALTER TABLE "llm_usage" RENAME TO "usage";

-- primary/foreign key constraints (pkey rename also renames its backing index)
ALTER TABLE "usage" RENAME CONSTRAINT "llm_usage_pkey" TO "usage_pkey";
ALTER TABLE "usage" RENAME CONSTRAINT "llm_usage_session_id_fkey" TO "usage_session_id_fkey";

-- index
ALTER INDEX "llm_usage_session_id_idx" RENAME TO "usage_session_id_idx";
