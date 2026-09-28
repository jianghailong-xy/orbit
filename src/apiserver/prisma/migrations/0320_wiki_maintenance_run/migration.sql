-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki, phase 2, criterion 3: the maintenance job — the task a fact makes for a space, and how
-- its run went. contracts/wiki.contract.json `maintenance.job` is the authority for everything below
-- (design §8.2), and src/apiserver/src/wiki/wiki-maintenance.pg.spec.ts holds it to it.
--
-- WHAT IS ADDED
-- -------------
--   wiki_maintenance_run   one row per maintenance task: why the fact that made it found the space
--                          due (backlog or age) and the backlog then, the position the task's check
--                          (`orbit wiki check --expect-cursor`) expects the cursor to reach, the
--                          session that ran it, and what the run reported when it ended — its
--                          outcome, how many of its ops the server refused, and its report (counts,
--                          token spend, the step it stopped at). `orbit wiki check` reads it beside the
--                          cursor: a run is judged by what it did, not by having run.
--   wiki_cursor.held_reason / held_at
--                          why the last fact that found a run due made no task — the day's run limit
--                          reached, or a Manual space's review queue full — and when; cleared when a
--                          task is made. The health a status line shows beside the lag.
--
-- A POSITION is three columns, as on wiki_cursor (0315): the time of a fact to the millisecond, its
-- kind and its id, set together or not at all.
--
-- TENANCY
-- -------
-- The table reaches its space through (space_id, owner_id) -> wiki_space(id, owner_id), ON DELETE
-- CASCADE, as every other wiki child does. task_id and session_id are history references with no
-- foreign key (contract `storage.historyRefs`), as wiki_dossier.session_id is: a run row outlives a
-- task or session deleted since, names nothing live, and is removed with its space.
--
-- WHAT DOES NOT CHANGE
-- --------------------
-- No row is written, read or locked. wiki_cursor gains two nullable columns with no default, which
-- PostgreSQL adds to the catalog without rewriting the table, and their CHECK holds for every row as
-- it stands (both NULL). No trigger, function or type is created, replaced or dropped; no task,
-- session, project or task_list object is named.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0320: origin/main and project/34VR0RwUSIcaoO7ZZqv52 stood at 0317 when this was written
-- (2026-09-28); 0318 and 0319 were reserved for the project's anchor and clean-start tasks, which
-- needed none. Every statement can run twice: CREATE TABLE / INDEX IF NOT EXISTS with the
-- constraints inside the CREATE TABLE, ADD COLUMN IF NOT EXISTS, and a constraint added only when
-- absent.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "wiki_maintenance_run" (
  "id"                UUID NOT NULL,
  "space_id"          UUID NOT NULL,
  "owner_id"          UUID NOT NULL,
  "task_id"           UUID NOT NULL,
  "due"               TEXT,
  "backlog"           INTEGER NOT NULL DEFAULT 0,
  "pending_sessions"  INTEGER NOT NULL DEFAULT 0,
  "oldest_pending_at" TIMESTAMPTZ(3),
  "expect_at"         TIMESTAMPTZ(3),
  "expect_kind"       TEXT,
  "expect_ref"        TEXT,
  "session_id"        UUID,
  "started_at"        TIMESTAMPTZ(3),
  "ended_at"          TIMESTAMPTZ(3),
  "outcome"           TEXT,
  "ops_refused"       INTEGER,
  "report"            JSONB,
  "error"             TEXT,
  "created_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wiki_maintenance_run_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wiki_maintenance_run_space_fkey"
    FOREIGN KEY ("space_id", "owner_id") REFERENCES "wiki_space" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- Why the fact that made the task found the space due (maintenance.job.trigger); NULL for a run of a
  -- task somebody else put in the list.
  CONSTRAINT "wiki_maintenance_run_due_chk" CHECK ("due" IS NULL OR "due" IN ('backlog', 'age')),
  -- The expected position is whole or absent, and its kind is one of the five facts.
  CONSTRAINT "wiki_maintenance_run_expect_chk"
    CHECK (("expect_at" IS NULL) = ("expect_kind" IS NULL) AND ("expect_at" IS NULL) = ("expect_ref" IS NULL)),
  CONSTRAINT "wiki_maintenance_run_expect_kind_chk" CHECK ("expect_kind" IS NULL OR "expect_kind" IN
    ('session_settled', 'task_terminal', 'approval_answered', 'merge_receipt', 'criterion_revised')),
  CONSTRAINT "wiki_maintenance_run_counts_chk"
    CHECK ("backlog" >= 0 AND "pending_sessions" >= 0 AND ("ops_refused" IS NULL OR "ops_refused" >= 0)),
  CONSTRAINT "wiki_maintenance_run_outcome_chk"
    CHECK ("outcome" IS NULL OR "outcome" IN ('succeeded', 'failed', 'truncated')),
  -- An outcome is what a run said when it ended: the two are set together.
  CONSTRAINT "wiki_maintenance_run_ended_chk" CHECK (("outcome" IS NULL) = ("ended_at" IS NULL)),
  CONSTRAINT "wiki_maintenance_run_report_chk" CHECK ("report" IS NULL OR jsonb_typeof("report") = 'object'),
  CONSTRAINT "wiki_maintenance_run_error_chk"
    CHECK ("error" IS NULL OR (btrim("error") <> '' AND char_length("error") <= 2000))
);
CREATE UNIQUE INDEX IF NOT EXISTS "wiki_maintenance_run_task_id_key" ON "wiki_maintenance_run" ("task_id");
-- `orbit wiki check` finds the run whose task expects a position.
CREATE INDEX IF NOT EXISTS "wiki_maintenance_run_expect_idx"
  ON "wiki_maintenance_run" ("space_id", "expect_at", "expect_kind", "expect_ref");
-- The run a maintenance session is: its routes find it by the calling session.
CREATE INDEX IF NOT EXISTS "wiki_maintenance_run_session_id_idx" ON "wiki_maintenance_run" ("session_id");

ALTER TABLE "wiki_cursor" ADD COLUMN IF NOT EXISTS "held_reason" TEXT;
ALTER TABLE "wiki_cursor" ADD COLUMN IF NOT EXISTS "held_at" TIMESTAMPTZ(3);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wiki_cursor_held_chk') THEN
    ALTER TABLE "wiki_cursor" ADD CONSTRAINT "wiki_cursor_held_chk"
      CHECK (("held_reason" IS NULL) = ("held_at" IS NULL)
        AND ("held_reason" IS NULL OR "held_reason" IN ('daily_limit_reached', 'review_queue_full')));
  END IF;
END $$;
