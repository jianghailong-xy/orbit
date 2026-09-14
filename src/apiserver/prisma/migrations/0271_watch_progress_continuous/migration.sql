-- 0271 — structured Task progress, the Task lifecycle epoch, and what a CONTINUOUS watch needs to
-- coalesce its crossings (contracts/watch.contract.json, docs/watch-contract.md §12).
--
-- WHAT IT ADDS
-- ============
--   * `task_progress`: one row per Task, the projection the progress report door writes and the
--     Watch evaluator reads. It holds the Task's lifecycle epoch and the progress reported in it —
--     phase, current, total, message — with a revision every accepted change advances and
--     `last_progress_at`, which moves only when the reported POSITION (phase, current or total)
--     changes. A message on its own is not progress, and neither is a report repeated verbatim:
--     otherwise an agent that keeps saying "still working" would never be seen to stall. Progress
--     is what an agent states through the report door, as numbers and a phase; nothing derives it
--     from a transcript or from a shell's output, and no leaf reads `message`.
--   * `task_progress_epoch_advance`, a row trigger on `task`: a Task that leaves DONE, CANCELLED or
--     FAILED for OPEN or IN_PROGRESS starts a new lifecycle epoch, with no progress in it. A trigger,
--     because it is the one place every writer that reopens a Task passes through — a task_update,
--     a retry, a verdict revoked, a parent reopened by its children. What was reported about the
--     previous epoch is not progress of this one, so the reset and the epoch are one write.
--   * On `watch`, the policy and the state of a CONTINUOUS watch: its debounce window and its wake
--     budget, whether its predicate held at the last landed evaluation (the edge a crossing is), and
--     the coalescing window a crossing opened.
--
-- BACKWARD COMPATIBLE
-- ===================
-- No existing row is read or rewritten. `task_progress` starts empty, and a Task without a row is in
-- epoch 0, which began when the Task was created, with nothing reported. The `watch` columns are
-- nullable or carry constant defaults, which is a catalog-only change; every existing watch is
-- ONE_SHOT (the API never accepted CONTINUOUS before this), so every CHECK below already holds for
-- it. A deployment that applies this and rolls the code back keeps working: the old evaluator never
-- names the new columns, and the trigger only ever writes `task_progress`.
--
-- LOCK ORDER
-- ==========
-- The trigger runs inside the UPDATE that holds the Task row and then writes that Task's one
-- `task_progress` row: task (rank 50) before its child (rank 60), like every other child row. The
-- report door takes the Task row FOR KEY SHARE before its progress row, the same order, and a KEY
-- SHARE does not conflict with the NO KEY UPDATE a status write takes.

BEGIN;

-- ── task_progress ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "task_progress" (
  "task_id" uuid NOT NULL,

  -- The epoch the progress below belongs to. 0 until the Task is first reopened; NULL
  -- `epoch_started_at` is epoch 0, which began when the Task was created.
  "lifecycle_epoch" integer NOT NULL DEFAULT 0,
  "epoch_started_at" TIMESTAMPTZ(6),

  -- The reported position. Structured, bounded, and stated by the reporter: a phase name, a count
  -- and an optional total.
  "phase" text,
  "current" integer,
  "total" integer,
  -- What the reporter wants a reader to see. Never read by a leaf, never progress on its own.
  "message" text,

  -- Advanced by one per accepted change of any field, and by the epoch advance. The report door's
  -- compare-and-set is on this number.
  "revision" integer NOT NULL DEFAULT 0,
  -- When the position last changed in this epoch. NULL while nothing has been reported in it.
  "last_progress_at" TIMESTAMPTZ(6),

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "task_progress_pkey" PRIMARY KEY ("task_id"),
  CONSTRAINT "task_progress_task_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT "task_progress_epoch_chk" CHECK ("lifecycle_epoch" >= 0),
  -- Epoch 0 began with the Task; every later one began when a reopen advanced to it.
  CONSTRAINT "task_progress_epoch_start_chk"
    CHECK (("lifecycle_epoch" = 0) = ("epoch_started_at" IS NULL)),
  CONSTRAINT "task_progress_revision_chk" CHECK ("revision" >= 0),
  CONSTRAINT "task_progress_phase_chk"
    CHECK ("phase" IS NULL OR char_length("phase") BETWEEN 1 AND 80),
  CONSTRAINT "task_progress_message_chk"
    CHECK ("message" IS NULL OR char_length("message") BETWEEN 1 AND 500),
  CONSTRAINT "task_progress_current_chk" CHECK ("current" IS NULL OR "current" >= 0),
  -- A total is the size of what `current` counts, so it needs a count beside it and bounds it.
  CONSTRAINT "task_progress_total_chk" CHECK (
    "total" IS NULL OR ("total" >= 1 AND "current" IS NOT NULL AND "current" <= "total")),
  -- A position was reported exactly when its time is known, and a message only ever accompanies one.
  CONSTRAINT "task_progress_position_chk" CHECK (
    ("last_progress_at" IS NULL) = ("phase" IS NULL AND "current" IS NULL)
    AND ("message" IS NULL OR "last_progress_at" IS NOT NULL))
);

-- A reopened Task starts a new epoch with nothing reported in it (see the header).
CREATE OR REPLACE FUNCTION "task_progress_epoch_advance"() RETURNS trigger AS $$
BEGIN
  INSERT INTO "task_progress" AS p ("task_id", "lifecycle_epoch", "epoch_started_at", "revision")
  VALUES (NEW."id", 1, now(), 1)
  ON CONFLICT ("task_id") DO UPDATE
    SET "lifecycle_epoch" = p."lifecycle_epoch" + 1,
        "epoch_started_at" = now(),
        "phase" = NULL,
        "current" = NULL,
        "total" = NULL,
        "message" = NULL,
        "last_progress_at" = NULL,
        "revision" = p."revision" + 1,
        "updated_at" = now();
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "task_progress_epoch_advance" ON "task";
CREATE TRIGGER "task_progress_epoch_advance"
  AFTER UPDATE OF "status" ON "task"
  FOR EACH ROW
  WHEN (OLD."status" IN ('DONE', 'CANCELLED', 'FAILED') AND NEW."status" IN ('OPEN', 'IN_PROGRESS'))
  EXECUTE FUNCTION "task_progress_epoch_advance"();

-- ── watch: the CONTINUOUS policy and state ───────────────────────────────────────────────────
ALTER TABLE "watch"
  -- Crossings within this many seconds of the first one become one Match. CONTINUOUS only.
  ADD COLUMN IF NOT EXISTS "debounce_seconds" integer,
  -- How many Matches — so how many wakes — a CONTINUOUS watch may ever record. The one that uses
  -- the last of it settles the watch at MATCHED, as a ONE_SHOT watch settles at its first.
  ADD COLUMN IF NOT EXISTS "wake_budget" integer,
  -- Whether the predicate held at the last landed evaluation: a crossing is it holding now when it
  -- did not then. Level-sampled from the rows, like every other verdict.
  ADD COLUMN IF NOT EXISTS "holding" boolean NOT NULL DEFAULT false,
  -- The coalescing window a crossing opened, and how many crossings it has seen.
  ADD COLUMN IF NOT EXISTS "window_opened_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "window_closes_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "window_crossings" integer NOT NULL DEFAULT 0;

ALTER TABLE "watch" DROP CONSTRAINT IF EXISTS "watch_continuous_policy_chk";
ALTER TABLE "watch" ADD CONSTRAINT "watch_continuous_policy_chk" CHECK (
  ("debounce_seconds" IS NULL) = ("wake_budget" IS NULL)
  AND ("mode" = 'CONTINUOUS') = ("debounce_seconds" IS NOT NULL));
ALTER TABLE "watch" DROP CONSTRAINT IF EXISTS "watch_debounce_range_chk";
ALTER TABLE "watch" ADD CONSTRAINT "watch_debounce_range_chk"
  CHECK ("debounce_seconds" IS NULL OR "debounce_seconds" BETWEEN 10 AND 3600);
ALTER TABLE "watch" DROP CONSTRAINT IF EXISTS "watch_wake_budget_range_chk";
ALTER TABLE "watch" ADD CONSTRAINT "watch_wake_budget_range_chk"
  CHECK ("wake_budget" IS NULL OR "wake_budget" BETWEEN 1 AND 100);
-- The budget is a ceiling the database holds, not a counter the evaluator is trusted with: the
-- generation past it is not a state a CONTINUOUS watch can be in, as generation 2 is not one a
-- ONE_SHOT watch can be in.
ALTER TABLE "watch" DROP CONSTRAINT IF EXISTS "watch_continuous_generation_chk";
ALTER TABLE "watch" ADD CONSTRAINT "watch_continuous_generation_chk"
  CHECK ("wake_budget" IS NULL OR "generation" <= "wake_budget");
-- A window is open exactly when it has a start, an end and a crossing; only a live CONTINUOUS watch
-- has one, so a watch that ended carries none.
ALTER TABLE "watch" DROP CONSTRAINT IF EXISTS "watch_window_shape_chk";
ALTER TABLE "watch" ADD CONSTRAINT "watch_window_shape_chk" CHECK (
  ("window_closes_at" IS NULL) = ("window_opened_at" IS NULL)
  AND ("window_closes_at" IS NULL) = ("window_crossings" = 0)
  AND "window_crossings" >= 0
  AND ("window_closes_at" IS NULL OR (
    "mode" = 'CONTINUOUS'
    AND "window_closes_at" >= "window_opened_at"
    AND "state" IN ('ACTIVE', 'PAUSED'))));

COMMIT;
