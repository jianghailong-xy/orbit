-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki, phase 2, criterion 11: the plan's jobs. A space's plan is drafted, revised and (later)
-- built by a task of its hidden «Wiki maintenance» list, which the server makes from a fact — the
-- space was created, or its owner asked for a draft — and never from a clock. contracts/wiki.contract.json
-- `plan.jobs` is the authority for everything below, and src/apiserver/src/wiki/wiki-plan-draft.pg.spec.ts
-- holds these CHECKs to it.
--
-- WHAT IS ADDED
-- -------------
--   wiki_plan_job   one row per job a fact asked for: its kind (draft, revise, build), what asked for it
--                   (the space's creation, or its owner), the owner's instructions for a revision, and
--                   where it stands — queued behind an unfinished task of the list, held because the
--                   space's maintenance names no workspace or no provider a run could start on, made
--                   (its task exists), or ended — with the task it made, the session that ran it, the
--                   gate round it is on, and how it ended: the version it stored, or the gate's errors,
--                   what went wrong, its report and the last draft it had.
--
-- ONE OPEN DRAFT A SPACE. At most one draft or revision of a space is not ended (a partial unique
-- index): a second request finds the first and is answered with it.
--
-- TENANCY
-- -------
-- As every wiki child reaches its parent (0307): wiki_plan_job reaches wiki_space through (space_id,
-- owner_id), ON DELETE CASCADE — a space's delete takes its jobs. task_id, session_id and
-- requested_by_user_id are history references with no foreign key (contract `storage.historyRefs`), as
-- wiki_maintenance_run's task_id and session_id are (0320).
--
-- WHAT DOES NOT CHANGE
-- --------------------
-- No existing row is written, read or locked, and no existing table gains a column: the table starts
-- empty, and wiki_space is named only as the parent its foreign key references. No function, trigger or
-- type is created, replaced or dropped; no table outside the wiki is named.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0336: written as 0327 when origin/main and project/34VR0RwUSIcaoO7ZZqv52 stood at 0325 (2026-09-29);
-- renumbered before landing, when origin/main stood at 0334 and 0335 was another branch's — the first
-- free number after the highest. Every statement can run twice:
-- CREATE TABLE / INDEX IF NOT EXISTS, with the table's constraints inside its CREATE.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "wiki_plan_job" (
  "id"                   UUID NOT NULL,
  "space_id"             UUID NOT NULL,
  "owner_id"             UUID NOT NULL,
  "kind"                 TEXT NOT NULL,
  "trigger"              TEXT NOT NULL,
  "instructions"         TEXT,
  "state"                TEXT NOT NULL,
  "held_reason"          TEXT,
  "held_at"              TIMESTAMPTZ(3),
  "task_id"              UUID,
  "made_at"              TIMESTAMPTZ(3),
  "session_id"           UUID,
  "started_at"           TIMESTAMPTZ(3),
  "attempt"              INTEGER,
  "ended_at"             TIMESTAMPTZ(3),
  "outcome"              TEXT,
  "version"              INTEGER,
  "errors"               JSONB,
  "error"                TEXT,
  "report"               JSONB,
  "draft"                JSONB,
  "requested_by_user_id" UUID,
  "created_at"           TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wiki_plan_job_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wiki_plan_job_space_fkey"
    FOREIGN KEY ("space_id", "owner_id") REFERENCES "wiki_space" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_plan_job_kind_chk" CHECK ("kind" IN ('draft', 'revise', 'build')),
  CONSTRAINT "wiki_plan_job_trigger_chk" CHECK ("trigger" IN ('space_created', 'owner')),
  CONSTRAINT "wiki_plan_job_state_chk" CHECK ("state" IN ('queued', 'held', 'made', 'ended')),
  -- A revision carries the owner's words, and nothing else does.
  CONSTRAINT "wiki_plan_job_instructions_chk" CHECK (
    ("kind" = 'revise') = ("instructions" IS NOT NULL)
    AND ("instructions" IS NULL OR (btrim("instructions") <> '' AND char_length("instructions") <= 4000))),
  CONSTRAINT "wiki_plan_job_held_reason_chk" CHECK ("held_reason" IS NULL OR "held_reason" IN ('no_maintenance_workspace', 'maintenance_provider_unusable')),
  -- Held, and why since when, together.
  CONSTRAINT "wiki_plan_job_held_chk" CHECK (
    ("state" = 'held') = ("held_reason" IS NOT NULL)
    AND ("held_reason" IS NULL) = ("held_at" IS NULL)),
  -- A job has a task from the moment it is made.
  CONSTRAINT "wiki_plan_job_made_chk" CHECK (
    ("state" IN ('made', 'ended')) = ("task_id" IS NOT NULL)
    AND ("task_id" IS NULL) = ("made_at" IS NULL)),
  CONSTRAINT "wiki_plan_job_outcome_chk" CHECK ("outcome" IS NULL OR "outcome" IN ('succeeded', 'failed')),
  -- An ended job says how, and when; one that succeeded, the version it stored.
  CONSTRAINT "wiki_plan_job_ended_chk" CHECK (
    ("state" = 'ended') = ("ended_at" IS NOT NULL)
    AND ("state" = 'ended') = ("outcome" IS NOT NULL)
    AND ("outcome" IS DISTINCT FROM 'succeeded' OR "version" IS NOT NULL)),
  CONSTRAINT "wiki_plan_job_attempt_chk" CHECK ("attempt" IS NULL OR "attempt" >= 1),
  CONSTRAINT "wiki_plan_job_version_chk" CHECK ("version" IS NULL OR "version" >= 1),
  CONSTRAINT "wiki_plan_job_errors_chk" CHECK ("errors" IS NULL OR jsonb_typeof("errors") = 'array'),
  CONSTRAINT "wiki_plan_job_report_chk" CHECK ("report" IS NULL OR jsonb_typeof("report") = 'object'),
  CONSTRAINT "wiki_plan_job_draft_chk" CHECK ("draft" IS NULL OR jsonb_typeof("draft") = 'object'),
  CONSTRAINT "wiki_plan_job_error_chk" CHECK ("error" IS NULL OR char_length("error") <= 2000)
);
CREATE UNIQUE INDEX IF NOT EXISTS "wiki_plan_job_task_id_key" ON "wiki_plan_job" ("task_id");
-- At most one draft or revision of a space is not ended.
CREATE UNIQUE INDEX IF NOT EXISTS "wiki_plan_job_space_id_open_draft_key" ON "wiki_plan_job" ("space_id")
  WHERE "kind" IN ('draft', 'revise') AND "state" IN ('queued', 'held', 'made');
-- The jobs a fact may move: an owner's queued, held and made ones.
CREATE INDEX IF NOT EXISTS "wiki_plan_job_owner_id_state_idx" ON "wiki_plan_job" ("owner_id", "state")
  WHERE "state" IN ('queued', 'held', 'made');
-- A space's latest job, for its plan's read.
CREATE INDEX IF NOT EXISTS "wiki_plan_job_space_id_created_at_idx" ON "wiki_plan_job" ("space_id", "created_at");
