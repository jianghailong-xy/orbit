-- Provider/engine split, step three: the bookkeeping of the application-layer migration
-- (docs/provider-engine-contract.md §7.2–§7.6).
--
-- T4 folds every `deepseek-harness` row (runtime `dsh`) into a DeepSeek key — merged into the owner's
-- identical key, or converted where it stands — rewrites whatever names one, moves the old OpenCode
-- spelling (`provider: opencode`, `model: orbit-<slug>/<model>`) and the built-in `dsh` sessions onto
-- keys, and rekeys preferences. Deciding a merge means comparing decrypted keys, so it runs in the API
-- server (src/apiserver/src/providers/provider-engine-migration.ts), once, when a server that carries it
-- starts, and not here. What it needs from the schema is somewhere to say that it ran, and somewhere to
-- say, row by row, what it did:
--
--   * `provider_engine_migration_run` — one row per execution. `full_scan` is false for a start that
--     found the migration complete and only folded the `deepseek-harness` rows an older replica made
--     since. `complete` on a full scan is the completion marker: a later start skips the full scan.
--     The partial unique index allows one marker per version.
--   * `provider_engine_migration_report` — the per-row report: which step did what to which row, its
--     values before and after (never key material: a merge says `sameKey: true`), and why. Kept: a
--     rewrite is never reverted automatically, and `before` is what a manual repair works from.
--     `row_id` is TEXT because a line can be about a row of any table, or a preference key of a user.
--
-- Nothing reads either table on a request path.
--
-- 0419, renumbered from 0417: written when the highest number on main, every project/* and pushed orbit/*
-- branch and every session worktree was 0416 (0416_task_comment_session_attempt), and moved before
-- landing (2026-10-10) because two other sessions' worktrees had since taken 0417
-- (0417_run_event_autovacuum_analyze) and 0418 (0418_session_recap).
BEGIN;

CREATE TABLE "provider_engine_migration_run" (
  "id"          UUID NOT NULL,
  "version"     INTEGER NOT NULL,
  "full_scan"   BOOLEAN NOT NULL,
  "complete"    BOOLEAN NOT NULL DEFAULT false,
  "started_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMPTZ(3),
  "summary"     JSONB,
  CONSTRAINT "provider_engine_migration_run_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "provider_engine_migration_run_marker_key"
  ON "provider_engine_migration_run" ("version") WHERE "full_scan" AND "complete";

CREATE TABLE "provider_engine_migration_report" (
  "id"         BIGSERIAL NOT NULL,
  "run_id"     UUID NOT NULL,
  "step"       TEXT NOT NULL,
  "table_name" TEXT NOT NULL,
  "row_id"     TEXT,
  "owner_id"   UUID,
  "action"     TEXT NOT NULL,
  "before"     JSONB,
  "after"      JSONB,
  "note"       TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "provider_engine_migration_report_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "provider_engine_migration_report_action_check" CHECK ("action" IN (
    'MERGED', 'CONVERTED', 'ALIASED', 'REWRITTEN', 'NOOP', 'SKIPPED_CHANGED', 'UNRESOLVED',
    'LEGACY_DSH_ENV_KEY', 'LEGACY_DSH_NO_KEY', 'INCONSISTENT', 'SAME', 'CHANGED'
  ))
);

CREATE INDEX "provider_engine_migration_report_run_id_idx"
  ON "provider_engine_migration_report" ("run_id", "id");

ALTER TABLE "provider_engine_migration_report" ADD CONSTRAINT "provider_engine_migration_report_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "provider_engine_migration_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
