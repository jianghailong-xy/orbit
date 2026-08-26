-- GET /projects returns exact ready/blocked/running buckets for every listed project. The query
-- needs these five Task columns and, before this index, read the whole Task heap to get them. On
-- the production workload that meant ~154 MB of wide rows for 111k tasks on every 60-second page
-- refresh, even though the useful projection is only ids, one enum and one timestamp.
--
-- Keep every selected column in the btree so PostgreSQL can use an index-only scan. The predicate
-- excludes tasks that are not filed under a project; they can never contribute to this endpoint.
-- Deliberately not CONCURRENTLY because Prisma runs the migration in a transaction. This data set
-- is small enough for a normal build; deployments with a much larger Task table may pre-create
-- the identical index CONCURRENTLY, after which IF NOT EXISTS makes this migration a no-op.
CREATE INDEX IF NOT EXISTS "task_project_rollup_covering_idx"
  ON "task" ("owner_id", "project_id", "status", "id", "updated_at")
  WHERE "project_id" IS NOT NULL;
