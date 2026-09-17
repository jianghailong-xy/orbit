-- 0284 — a crossed spend fuse, as something the account owner can see and undo
-- (docs/project-integration-line-contract.md §6.2).
--
-- WHAT IT ADDS
-- ============
--   * `project_fuse_episode`: one row per time a project's coordinator spent more than it may on
--     its own. It keeps WHY — which of the three kinds crossed, what was observed against what
--     limit, the whole day's spend and the committed row whose arrival made the fuse read itself —
--     and, once the owner resumes, who resumed it and whether they raised anything. At most one
--     episode of a project is open at a time (the partial unique index), and a resumed one is
--     final: a second pause is a NEW episode with a new card, never the old row written over.
--   * `project_fuse_held_action`: what the coordinator tried to start while the project was paused,
--     kept verbatim with the session that asked and the order it asked in, so a resume can put each
--     one back through the door it was held at.
--   * The foreign key `project_open_item.fuse_episode_id` was waiting for: 0278 declared the column
--     for this table and said its key would come with the migration that created it.
--
-- WHY THE EPISODE HAS NO BACK-POINTER TO ITS CARD
-- ===============================================
-- The contract sketches an `open_item_id` beside these columns. It is not here: the card already
-- names the episode, and the two would be one fact stored twice, in a circular pair of keys neither
-- of which could be written first. `project_open_item WHERE fuse_episode_id = <episode>` is the
-- card, and there is exactly one.
--
-- BACKWARD COMPATIBLE
-- ===================
-- Two new tables and one foreign key on a column that exists and is NULL in every row ever written
-- (nothing has produced a `FUSE_PAUSED` item yet). No existing row is read or rewritten, no column
-- is dropped or retyped, and the only trigger added is on one of the new tables.
--
-- LOCK ORDER
-- ==========
-- Both tables are child rows (rank 60). An episode is inserted under the project row taken FOR NO
-- KEY UPDATE, beside the card it opens; a held action is inserted under its episode's row. Their
-- foreign keys take `project` and `project_fuse_episode` FOR KEY SHARE, which no status write
-- conflicts with.

BEGIN;

CREATE TABLE "project_fuse_episode" (
  "id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "owner_id" uuid NOT NULL,
  -- How many times this project has paused, counting from 1. What makes "it paused again" legible
  -- to a reader who only has the rows.
  "generation" integer NOT NULL,
  -- The reading, exactly as `assessSpend` returned it.
  "dimension" text NOT NULL,
  "observed" integer NOT NULL,
  "limit_value" integer NOT NULL,
  "window_start" TIMESTAMPTZ(3) NOT NULL,
  "spend" jsonb NOT NULL,
  -- The committed row whose arrival made the fuse read itself (§6.1 F5): a self-started turn, a
  -- tool call that opened a session, or a task that was replaced.
  "crossing_fact" jsonb NOT NULL,
  "paused_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resumed_at" TIMESTAMPTZ(3),
  "resumed_by_user_id" uuid,
  -- What the owner raised on the way back, when they raised anything. The project's own override is
  -- written too; this is what THIS resume changed.
  "raised_limits" jsonb,
  CONSTRAINT "project_fuse_episode_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_fuse_episode_project_fkey" FOREIGN KEY ("project_id", "owner_id")
    REFERENCES "project" ("id", "owner_id") ON DELETE CASCADE,
  CONSTRAINT "project_fuse_episode_dimension_chk" CHECK ("dimension" IN (
    'SELF_STARTED_TURNS', 'SESSIONS_OPENED', 'SUCCESSOR_RETRIES')),
  CONSTRAINT "project_fuse_episode_generation_chk" CHECK ("generation" >= 1),
  -- A resumed episode names who resumed it, and an open one cannot.
  CONSTRAINT "project_fuse_episode_resumed_chk" CHECK (
    ("resumed_at" IS NULL) = ("resumed_by_user_id" IS NULL))
);

-- At most one open episode per project: the second reading of a fuse that is already blown finds
-- the episode it opened rather than opening another.
CREATE UNIQUE INDEX "project_fuse_episode_open_key"
  ON "project_fuse_episode" ("project_id") WHERE "resumed_at" IS NULL;
CREATE UNIQUE INDEX "project_fuse_episode_generation_key"
  ON "project_fuse_episode" ("project_id", "generation");

CREATE TABLE "project_fuse_held_action" (
  "id" uuid NOT NULL,
  "episode_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  -- The order they were asked in, which is the order they go back out in.
  "seq" integer NOT NULL,
  "kind" text NOT NULL,
  -- The conversation that asked. History rather than a reference that has to stay resolvable.
  "acting_session_id" uuid NOT NULL,
  -- The request as the door received it, so the replay is the same call and not a reconstruction.
  "request" jsonb NOT NULL,
  -- The caller's own key, for a door that has one. A door with no key to carry holds NULL.
  "idempotency_key" text,
  "state" text NOT NULL DEFAULT 'HELD',
  "replayed_at" TIMESTAMPTZ(3),
  -- What the replay came to: what it produced, or why the door refused it this time (§6.5 F9).
  "replay_result" jsonb,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_fuse_held_action_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_fuse_held_action_episode_fkey" FOREIGN KEY ("episode_id")
    REFERENCES "project_fuse_episode" ("id") ON DELETE CASCADE,
  CONSTRAINT "project_fuse_held_action_project_fkey" FOREIGN KEY ("project_id")
    REFERENCES "project" ("id") ON DELETE CASCADE,
  CONSTRAINT "project_fuse_held_action_kind_chk" CHECK ("kind" IN (
    'SESSION_CREATE', 'TASK_START', 'SESSION_SEND', 'TASK_SUCCESSOR', 'SELF_WAKE')),
  CONSTRAINT "project_fuse_held_action_state_chk" CHECK ("state" IN ('HELD', 'REPLAYED', 'DROPPED')),
  CONSTRAINT "project_fuse_held_action_replayed_chk" CHECK (
    ("state" = 'HELD') = ("replayed_at" IS NULL))
);

CREATE UNIQUE INDEX "project_fuse_held_action_seq_key"
  ON "project_fuse_held_action" ("episode_id", "seq");

-- 0278 declared this column for a table that did not exist yet, and said its key would come with
-- the migration that created it.
ALTER TABLE "project_open_item"
  ADD CONSTRAINT "project_open_item_fuse_episode_fkey" FOREIGN KEY ("fuse_episode_id")
    REFERENCES "project_fuse_episode" ("id") ON DELETE CASCADE;

-- A resumed episode is what happened. Nothing rewrites it — not a later pause, which is its own
-- row, and not a second resume, which is refused at the door and refused again here.
CREATE OR REPLACE FUNCTION "project_fuse_episode_resumed_guard"() RETURNS trigger AS $$
BEGIN
  IF OLD."resumed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'PROJECT_FUSE_EPISODE_RESUMED'
      USING ERRCODE = 'P0001',
            DETAIL = 'a resumed fuse episode is final; the next pause is a new episode';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "project_fuse_episode_resumed_guard"
  BEFORE UPDATE ON "project_fuse_episode"
  FOR EACH ROW EXECUTE FUNCTION "project_fuse_episode_resumed_guard"();

COMMIT;
