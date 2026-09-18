-- 0286 — promotions: one row per candidate the platform offers its owner for merging into the
-- upstream, and the record of what the owner did with it
-- (docs/project-integration-line-contract.md §3.2).
--
-- WHAT IT ADDS
-- ============
--   * `project_promotion`: a project branch (or, on a MAIN line, a task branch) that is finished
--     enough to go onto the upstream, with the upstream tip and combined tree its checks passed on,
--     the tasks the merge would carry, the owner who confirmed it, and the commit it became. It is
--     not a job: the git work is `project_integration_job` rows pointing back here.
--   * The two foreign keys `project_integration_job.promotion_id` and
--     `project_open_item.promotion_id` were waiting for (0278 and 0281 each declared the column and
--     said the table that creates the promotion would point it here).
--   * `project_promotion_terminal_guard`: a promotion that reached a terminal state is never
--     rewritten.
--
-- THE CONSTRAINT THAT IS THE POINT
-- ================================
-- `project_promotion_active_source_key`, a partial unique index on `(project_id, source_ref)` over
-- the states a promotion is still alive in. One source has one live candidate: a second landing on
-- the project branch supersedes the candidate that was standing rather than opening a second card
-- for the same branch, so the owner is never shown two cards that would merge the same ref.
--
-- M5 lives in `state` and nowhere else: `CONFIRMED` and `RECHECKING` are the same decision — the
-- owner confirmed these tasks and these checks — and the second of them exists so that "the
-- upstream moved after you confirmed" is a fact a reader can see rather than a silent redo.
--
-- BACKWARD COMPATIBLE
-- ===================
-- One new table, two new foreign keys on columns that exist and are NULL in every row ever written,
-- one trigger on the new table. No existing column is dropped or rewritten, and the migration
-- carries no DML of any kind.
--
-- LOCK ORDER
-- ==========
-- Rank 60, a child row, beside `project_integration_job` and for the same reason
-- (`src/apiserver/src/common/lock-order.ts`): the candidate is inserted from the transaction that
-- finished a landing, which already holds the job row, and the owner's confirmation is a CAS on
-- this row alone followed by the insert of the job it queues.

BEGIN;

CREATE TABLE "project_promotion" (
  "id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "owner_id" uuid NOT NULL,
  "codebase_id" uuid NOT NULL,
  -- Which kind of source this is. A project branch is the ordinary one; a task branch is what a
  -- MAIN-line project promotes, because it has no branch of its own to accumulate on (A-Q7).
  "source_kind" text NOT NULL,
  "task_id" uuid,
  "session_id" uuid,
  "source_ref" text NOT NULL,
  "source_sha" char(40) NOT NULL,
  -- Frozen from the codebase row when the candidate was made: what "main" meant then.
  "upstream_ref" text NOT NULL,
  -- The upstream tip the last passing check ran against, and the tree that check produced. M-S3
  -- compares both before landing: the same upstream must reproduce the same tree, and a different
  -- upstream must be checked again.
  "upstream_sha_checked" char(40),
  "merge_tree_sha" char(40),
  "included_task_ids" uuid[] NOT NULL DEFAULT '{}',
  "commits_ahead" integer,
  "files_changed" integer,
  "checks" jsonb NOT NULL DEFAULT '[]',
  "conflicts" text[] NOT NULL DEFAULT '{}',
  "state" text NOT NULL DEFAULT 'CHECKING',
  "check_job_id" uuid,
  "land_job_id" uuid,
  "confirmed_by_user_id" uuid,
  "confirmed_at" TIMESTAMPTZ(3),
  -- When the landing job found the upstream had moved and redid the merge and the checks on the new
  -- tip (M-T7). Durable, because the state it corresponds to is passed through in seconds and a
  -- reader asking "was this rechecked" is asking about something that already happened.
  "rechecked_at" TIMESTAMPTZ(3),
  "decided_at" TIMESTAMPTZ(3),
  "merged_sha" char(40),
  "merged_at" TIMESTAMPTZ(3),
  "open_item_id" uuid,
  "receipt_ids" uuid[] NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_promotion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_promotion_project_fkey" FOREIGN KEY ("project_id", "owner_id")
    REFERENCES "project" ("id", "owner_id") ON DELETE CASCADE,
  CONSTRAINT "project_promotion_codebase_fkey" FOREIGN KEY ("codebase_id")
    REFERENCES "project_codebase" ("id") ON DELETE CASCADE,
  -- A promotion outlives the task or session it was about, for the reason 0281 gives about a job:
  -- the audit of what the owner approved is not a detail of the row that asked for it.
  CONSTRAINT "project_promotion_task_fkey" FOREIGN KEY ("task_id")
    REFERENCES "task" ("id") ON DELETE SET NULL,
  CONSTRAINT "project_promotion_session_fkey" FOREIGN KEY ("session_id")
    REFERENCES "session" ("id") ON DELETE SET NULL,
  CONSTRAINT "project_promotion_confirmed_by_fkey" FOREIGN KEY ("confirmed_by_user_id")
    REFERENCES "user" ("id") ON DELETE SET NULL,
  CONSTRAINT "project_promotion_source_kind_chk" CHECK ("source_kind" IN (
    'PROJECT_BRANCH', 'TASK_BRANCH')),
  CONSTRAINT "project_promotion_state_chk" CHECK ("state" IN (
    'CHECKING', 'READY', 'CONFIRMED', 'RECHECKING', 'MERGED',
    'BLOCKED', 'DECLINED', 'CANCELLED', 'SUPERSEDED')),
  -- A task-branch promotion is about one task, and has to say which.
  CONSTRAINT "project_promotion_task_branch_chk" CHECK (
    "source_kind" <> 'TASK_BRANCH' OR "task_id" IS NOT NULL),
  -- M-T4: the owner's confirmation is what moves a promotion past READY, so every state that
  -- follows one names who gave it.
  CONSTRAINT "project_promotion_confirmed_by_chk" CHECK (
    "state" NOT IN ('CONFIRMED', 'RECHECKING', 'MERGED') OR "confirmed_by_user_id" IS NOT NULL),
  -- M-T8: a merged promotion names the commit it became.
  CONSTRAINT "project_promotion_merged_chk" CHECK (
    "state" <> 'MERGED' OR ("merged_sha" IS NOT NULL AND "merged_at" IS NOT NULL))
);

-- One live candidate per source: a new landing supersedes the standing one rather than opening a
-- second card to merge the same ref.
CREATE UNIQUE INDEX "project_promotion_active_source_key"
  ON "project_promotion" ("project_id", "source_ref")
  WHERE "state" IN ('CHECKING', 'READY', 'CONFIRMED', 'RECHECKING', 'BLOCKED');
CREATE INDEX "project_promotion_project_idx"
  ON "project_promotion" ("project_id", "created_at");

ALTER TABLE "project_integration_job"
  ADD CONSTRAINT "project_integration_job_promotion_fkey" FOREIGN KEY ("promotion_id")
    REFERENCES "project_promotion" ("id") ON DELETE SET NULL;
ALTER TABLE "project_open_item"
  ADD CONSTRAINT "project_open_item_promotion_fkey" FOREIGN KEY ("promotion_id")
    REFERENCES "project_promotion" ("id") ON DELETE SET NULL;

-- A promotion that reached a terminal state is the audit of what the owner decided and what the
-- platform did about it. A late writer does not get to overwrite it.
CREATE OR REPLACE FUNCTION "project_promotion_terminal_guard"() RETURNS trigger AS $$
BEGIN
  IF OLD."state" IN ('MERGED', 'DECLINED', 'CANCELLED', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'PROJECT_PROMOTION_TERMINAL'
      USING ERRCODE = 'P0001',
            DETAIL = 'a promotion that was merged, declined, cancelled or superseded is final';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "project_promotion_terminal_guard"
  BEFORE UPDATE ON "project_promotion"
  FOR EACH ROW EXECUTE FUNCTION "project_promotion_terminal_guard"();

COMMIT;
