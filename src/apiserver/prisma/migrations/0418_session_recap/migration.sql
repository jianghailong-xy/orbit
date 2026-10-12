-- 0418 — a session's rolling recap: the text, when it was written, and how far it reaches.
--
-- WHAT IT ADDS
-- ============
-- Three nullable columns on `session`, a denormalized preview like 0033's `last_assistant_text`:
--   * `recap_text`      — a sentence or two on what the session did, how it was verified and what
--                         comes next, which the session list prefers to `last_assistant_text`;
--   * `recap_at`        — when that recap was written;
--   * `recap_event_seq` — the rolling recap's cursor: the `seq` of the last `run_event` the recap
--                         covers, so the next pass folds in only the events after it.
--
-- HOW IT WAS GENERATED
-- ====================
-- The statement below is Prisma's own output for the three new `Session` fields, from
-- `prisma migrate diff --from-schema <schema.prisma before them> --to-schema prisma/schema.prisma --script`.
-- Not `prisma migrate dev`: it diffs what the migrations build against the schema, so it also tries to
-- drop the `run_status` type's unused 'PARKED' label, which 0071 keeps on purpose (see `enum RunStatus`).
--
-- BACKWARD COMPATIBLE
-- ===================
-- Catalog-only ADD COLUMNs with no default and no constraint: no row is read, written or backfilled,
-- and every stored session reads NULL until its first recap. No index, trigger, function, type or
-- constraint is created, replaced or dropped.
--
-- 0418: the highest number on main was 0416 (0416_task_comment_session_attempt) and 0417 was held by two
-- unlanded branches (0417_provider_engine_migration, 0417_run_event_autovacuum_analyze) when this was
-- written (2026-10-10).

-- AlterTable
ALTER TABLE "session" ADD COLUMN     "recap_at" TIMESTAMP(3),
ADD COLUMN     "recap_event_seq" INTEGER,
ADD COLUMN     "recap_text" TEXT;
