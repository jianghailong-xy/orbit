-- Who coordinates a project, where its coordination runs, and how far it is allowed to act.
--
-- Additive and inert on the same terms as 0107/0108/0109: every column is defaulted or nullable,
-- no existing row changes meaning, and nothing on the dispatch path reads any of it yet. A
-- deployment that applies this and then runs the previous build behaves exactly as it did before.
--
-- The one thing this migration is careful about is what it does NOT turn on. The column defaults
-- below (`coordinator_enabled = false`, `automation_policy = 'MANUAL'`) are the values every
-- project that already exists keeps, and they are deliberately NOT the defaults a newly created
-- project gets — the service writes `true` / `GUARDED_AUTO` explicitly on create. Doing it the
-- other way round (default the columns to the new-project values and UPDATE the old rows here)
-- leaves a window between this migration and the new code in which every project created is
-- automatic, and it rewrites exactly the rows whose owners never asked for any of it.
--
-- No blockers, no events, no wakes and no notifications are produced here: the moment this
-- migration finishes, a control loop reading these tables has nothing to do about any project that
-- existed before it.

-- How far a coordinator may act on its own. MANUAL is not "off" — it still works out what the next
-- step would be and records it; it turns every step that would change something into a request for
-- approval. "Off" is `coordinator_enabled`, which is a separate column so that pausing a project
-- cannot overwrite the level its owner chose to come back to.
CREATE TYPE "project_automation_policy" AS ENUM ('MANUAL', 'GUARDED_AUTO', 'AUTO');

-- What an agent is to a project's team. COORDINATOR is the identity that decides what the project
-- does next; MEMBER is an agent that identity may hand work to.
CREATE TYPE "project_role" AS ENUM ('COORDINATOR', 'MEMBER');

ALTER TABLE "project" ADD COLUMN "coordinator_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "project" ADD COLUMN "automation_policy" "project_automation_policy" NOT NULL DEFAULT 'MANUAL';
-- An admission limit, not a statement about the present: lowering it is always allowed, never
-- cancels work already running, and applies to the next start.
ALTER TABLE "project" ADD COLUMN "max_concurrent_tasks" INTEGER NOT NULL DEFAULT 3;
-- Sessions the coordinator itself may start in a rolling 24h. NULL = no limit. Sessions a person
-- starts are neither counted by it nor refused because of it.
ALTER TABLE "project" ADD COLUMN "session_budget_per_day" INTEGER;
-- Bumped by one on every write to the four columns above. It is what makes "was this authorized
-- when it happened" a comparison rather than an archaeology; the mutual exclusion between a person
-- changing them and a coordinator acting on what it read is the project row's own lock, not this.
ALTER TABLE "project" ADD COLUMN "config_revision" BIGINT NOT NULL DEFAULT 0;

-- A project's team, and the only place its coordinator is recorded.
--
-- A row rather than a `coordinator_agent_id` column on `project`: the coordinator is one role of a
-- team, and the same fact kept in two shapes is the one that drifts. `agent_id` names a `workspace`
-- row, which is what an Agent is on the wire today (MCP `agent_list`, `orbit agent`,
-- `task.assignee_id` all mean this table).
CREATE TABLE "project_member" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "role" "project_role" NOT NULL,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_member_pkey" PRIMARY KEY ("id")
);

-- One membership per agent per project: changing an agent's role edits its row rather than adding
-- a second one that disagrees with the first.
CREATE UNIQUE INDEX "project_member_project_id_agent_id_key" ON "project_member"("project_id", "agent_id");

-- "Which projects is this agent on the team of", and the lookup the RESTRICT below runs on every
-- attempt to delete an agent — Postgres indexes the referenced column of a foreign key and never
-- the referencing one.
CREATE INDEX "project_member_agent_id_idx" ON "project_member"("agent_id");

-- At most one COORDINATOR per project, enforced by the database rather than by a service check.
--
-- A partial unique index cannot be expressed in schema.prisma (the same reason 0108 and 0110 write
-- theirs here), so it is written out — and it has to be the database's job rather than a
-- read-then-write in one service: two concurrent requests both read "no coordinator yet" and both
-- write, and only an index can make exactly one of them land. Every non-coordinator membership is
-- outside the index and therefore unconstrained.
CREATE UNIQUE INDEX "project_member_coordinator_idx" ON "project_member"("project_id") WHERE "role" = 'COORDINATOR';

-- CASCADE on the project: a team of a project that no longer exists means nothing.
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT on the agent, and not SET NULL or CASCADE: deleting an agent some project coordinates
-- with must be refused, not answered by silently disbanding the team or by leaving a membership
-- row pointing at nothing. Same handling a non-empty project's deletion already gets.
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_agent_id_fkey"
    FOREIGN KEY ("agent_id") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The control loop's own row for a project: state that belongs to RUNNING the project rather than
-- to the project. Kept off `project` for two reasons — `project.status` is what happened to the
-- work and a run state next to it invites code that confuses the two, and this row is where the
-- loop's hot fields go while `project` is read by every list, task page and stream.
--
-- This migration creates it for the coordinator generation alone. The reconcile lease, run state
-- and next wake are added to this same row by the units that implement them.
CREATE TABLE "project_runtime" (
    -- The primary key IS the project id: exactly one runtime row per project, stated by the key
    -- rather than by a unique index over a surrogate nothing would reference.
    "project_id" UUID NOT NULL,
    -- How many times this project's coordinator SESSION has been replaced. It counts rotations,
    -- not identity: the coordinator AGENT is unchanged by any of them, and the replaced
    -- conversation stays intact and readable. Monotonic and never reused — keys derived from it
    -- have to stay unique for the life of the project.
    "coordinator_generation" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_runtime_pkey" PRIMARY KEY ("project_id")
);

ALTER TABLE "project_runtime" ADD CONSTRAINT "project_runtime_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One runtime row per project that already exists, so "has a runtime row" is not a question any
-- later code has to answer with a fallback. Generation 0: nothing has rotated yet.
--
-- ON CONFLICT DO NOTHING makes re-running this statement a no-op rather than an error, which is
-- what lets the same migration be applied to a database that has already had part of it.
INSERT INTO "project_runtime" ("project_id", "coordinator_generation", "created_at", "updated_at")
SELECT "id", 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM "project"
ON CONFLICT ("project_id") DO NOTHING;
