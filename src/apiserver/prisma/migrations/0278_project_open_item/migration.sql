-- 0278 — exception items: what a project owes somebody a decision about, who that somebody is, and
-- how an item reached the coordinator's conversation (docs/project-integration-line-contract.md §4.1).
--
-- WHAT IT ADDS
-- ============
--   * `project_open_item`: one row per exception somebody has to act on — a task that failed, an
--     integration that conflicted or failed its checks, a promotion waiting for the owner, a question
--     the coordinator asked, a pause of the spend fuse. Each row has a kind, an assignee (the project's
--     coordinator or the account owner) and the reason it has that assignee, a state that ends in
--     RESOLVED or SUPERSEDED, and the moments a reader needs: since when it waits, when its assignee
--     last changed, and when it goes to the owner. `dedupe_key` names the fact the item is about; at
--     most one OPEN item of a project holds a key, so a fact recorded twice opens one item.
--   * `project_open_item_delivery`: one row per item per conversation it was queued on. The turn it
--     queued is found by `client_turn_id`; "delivered" is that turn's `delivered_at`, and a turn taken
--     off the queue before a runner took it is written back here as `returned_at`.
--   * `project.exception_escalation_seconds`: how long an item may wait on the coordinator before it
--     goes to the owner. Frozen into an item's `escalate_at` when it is created; the clock that acts on
--     it is not part of this migration.
--   * `project_open_item_terminal_guard`: a resolved or superseded item is never rewritten.
--
-- The kinds, assignee reasons and resolutions are the contract's closed sets. Kinds nothing produces
-- yet — the integration ones, PROMOTION_APPROVAL, COORDINATOR_QUESTION, FUSE_PAUSED — are defined here
-- so the tasks that produce them add rows, not constraints. `integration_job_id`, `promotion_id` and
-- `fuse_episode_id` get their foreign keys from the migrations that create those tables.
--
-- BACKWARD COMPATIBLE
-- ===================
-- Two new tables and one constant-default column on `project`, which is a catalog-only change. No
-- existing row is read or rewritten, and no trigger on an existing table is added or changed.
--
-- LOCK ORDER
-- ==========
-- Both tables are child rows (rank 60). An item is inserted in the transaction that wrote the failure,
-- after that transaction holds its session and task; its foreign keys take `project` and `task` FOR KEY
-- SHARE, which no status write conflicts with. A delivery row is inserted inside `createTurn`, under
-- the session row lock that transaction already holds.

BEGIN;

ALTER TABLE "project"
  ADD COLUMN "exception_escalation_seconds" integer NOT NULL DEFAULT 7200,
  ADD CONSTRAINT "project_exception_escalation_seconds_range"
    CHECK ("exception_escalation_seconds" BETWEEN 300 AND 604800);

CREATE TABLE "project_open_item" (
  "id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "owner_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "state" text NOT NULL DEFAULT 'OPEN',
  "assignee" text NOT NULL,
  "assignee_reason" text NOT NULL,
  -- The task an item is about, and the attempt it came from. The session is history rather than a
  -- reference that has to stay resolvable: a session purged from Trash leaves its items as they were.
  "task_id" uuid,
  "session_id" uuid,
  "integration_job_id" uuid,
  "promotion_id" uuid,
  "fuse_episode_id" uuid,
  "asked_by_session_id" uuid,
  "dedupe_key" text NOT NULL,
  -- Written once, from rows that do not change, so a delivery built from them reads the same on replay.
  "title" text NOT NULL,
  "payload" jsonb NOT NULL,
  "waiting_since" TIMESTAMPTZ(3) NOT NULL,
  -- Millisecond precision on purpose: a delivery's turn key carries this instant, and a reader of the
  -- row must be able to spell the same key.
  "assigned_at" TIMESTAMPTZ(3) NOT NULL,
  "escalate_at" TIMESTAMPTZ(3),
  "escalated_at" TIMESTAMPTZ(3),
  "remind_at" TIMESTAMPTZ(3),
  "reminded_at" TIMESTAMPTZ(3),
  "resolution" text,
  "resolved_at" TIMESTAMPTZ(3),
  "resolved_by" text,
  "resolved_by_user_id" uuid,
  "resolved_by_session_id" uuid,
  "resolution_note" text,
  "answer" jsonb,
  "superseded_by_item_id" uuid,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_open_item_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_open_item_project_fkey" FOREIGN KEY ("project_id", "owner_id")
    REFERENCES "project" ("id", "owner_id") ON DELETE CASCADE,
  CONSTRAINT "project_open_item_task_fkey" FOREIGN KEY ("task_id")
    REFERENCES "task" ("id") ON DELETE CASCADE,
  CONSTRAINT "project_open_item_kind_chk" CHECK ("kind" IN (
    'INTEGRATION_CONFLICT', 'INTEGRATION_CHECK_FAILED', 'INTEGRATION_ERROR', 'TASK_FAILED',
    'PROMOTION_APPROVAL', 'COORDINATOR_QUESTION', 'FUSE_PAUSED')),
  CONSTRAINT "project_open_item_state_chk" CHECK ("state" IN ('OPEN', 'RESOLVED', 'SUPERSEDED')),
  CONSTRAINT "project_open_item_assignee_chk" CHECK ("assignee" IN ('COORDINATOR', 'OWNER')),
  CONSTRAINT "project_open_item_assignee_reason_chk" CHECK ("assignee_reason" IN (
    'DEFAULT', 'NO_COORDINATOR', 'COORDINATOR_ENDED', 'CHAIN_LIMIT', 'ESCALATED', 'HANDED_OVER')),
  CONSTRAINT "project_open_item_resolution_chk" CHECK ("resolution" IS NULL OR "resolution" IN (
    'LANDED', 'RETRIED', 'TASK_DONE', 'TASK_CLOSED', 'SUCCESSOR_FILED', 'PROMOTION_MOVED_ON',
    'HANDLED', 'APPROVED', 'DECLINED', 'ANSWERED', 'WITHDRAWN', 'RESUMED')),
  CONSTRAINT "project_open_item_resolved_by_chk" CHECK (
    "resolved_by" IS NULL OR "resolved_by" IN ('USER', 'COORDINATOR', 'PLATFORM')),
  CONSTRAINT "project_open_item_resolved_at_chk" CHECK (("state" = 'OPEN') = ("resolved_at" IS NULL)),
  -- The three kinds that only the owner can answer are never the coordinator's.
  CONSTRAINT "project_open_item_owner_only_chk" CHECK (
    "kind" NOT IN ('PROMOTION_APPROVAL', 'COORDINATOR_QUESTION', 'FUSE_PAUSED') OR "assignee" = 'OWNER'),
  -- An item with the owner has nobody further to escalate to, unless it got there by escalating.
  CONSTRAINT "project_open_item_owner_escalation_chk" CHECK (
    "assignee" <> 'OWNER' OR "escalated_at" IS NOT NULL OR "escalate_at" IS NULL)
);

CREATE UNIQUE INDEX "project_open_item_open_dedupe_key"
  ON "project_open_item" ("project_id", "dedupe_key") WHERE "state" = 'OPEN';
CREATE INDEX "project_open_item_project_state_idx"
  ON "project_open_item" ("project_id", "state", "waiting_since");
CREATE INDEX "project_open_item_task_idx"
  ON "project_open_item" ("task_id") WHERE "task_id" IS NOT NULL;

CREATE TABLE "project_open_item_delivery" (
  "id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "purpose" text NOT NULL,
  "client_turn_id" text NOT NULL,
  "turn_id" uuid,
  "returned_at" TIMESTAMPTZ(3),
  "return_code" text,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_open_item_delivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_open_item_delivery_item_fkey" FOREIGN KEY ("item_id")
    REFERENCES "project_open_item" ("id") ON DELETE CASCADE,
  CONSTRAINT "project_open_item_delivery_project_fkey" FOREIGN KEY ("project_id")
    REFERENCES "project" ("id") ON DELETE CASCADE,
  CONSTRAINT "project_open_item_delivery_session_fkey" FOREIGN KEY ("session_id")
    REFERENCES "session" ("id") ON DELETE CASCADE,
  CONSTRAINT "project_open_item_delivery_purpose_chk" CHECK ("purpose" IN ('ITEM', 'ANSWER')),
  CONSTRAINT "project_open_item_delivery_returned_chk" CHECK (("returned_at" IS NULL) = ("return_code" IS NULL))
);

CREATE UNIQUE INDEX "project_open_item_delivery_item_session_purpose_key"
  ON "project_open_item_delivery" ("item_id", "session_id", "purpose");
CREATE INDEX "project_open_item_delivery_session_turn_idx"
  ON "project_open_item_delivery" ("session_id", "client_turn_id");

CREATE OR REPLACE FUNCTION "project_open_item_terminal_guard"() RETURNS trigger AS $$
BEGIN
  IF OLD."state" <> 'OPEN' THEN
    RAISE EXCEPTION 'PROJECT_OPEN_ITEM_TERMINAL'
      USING ERRCODE = 'P0001',
            DETAIL = 'a resolved or superseded open item is final; a new fact opens a new item';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "project_open_item_terminal_guard"
  BEFORE UPDATE ON "project_open_item"
  FOR EACH ROW EXECUTE FUNCTION "project_open_item_terminal_guard"();

COMMIT;
