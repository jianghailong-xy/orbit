-- Projects, and a task's place in one.
--
-- Purely additive, and deliberately inert: every column added here is nullable or defaulted, no
-- existing row is rewritten, and no dispatch path reads any of them. A deployment that applies
-- this migration and then runs the previous build behaves exactly as it did before — which is the
-- property that makes it safe to land ahead of the coordinator and the UI that will use it.
--
-- Why a new table rather than more columns on task_list: a list is a dispatch policy (the sweep,
-- the claim gate and the prompt assembler each read its columns), while a project states an
-- outcome and decides nothing about how work runs. Folding the two together would mean every
-- future project field lands on a row the dispatcher already reads, and "what are we trying to
-- achieve" would start being answerable only by things that also happen to be run policy.

-- Where a project stands as a piece of work, in the same vocabulary its tasks use: a project and
-- its tasks are the same kind of claim at different scales, and "DONE" has to mean the same thing
-- at both for one to be rolled up from the other.
--
-- Filing — archived, hidden, pinned — is deliberately NOT in this type. That is a fact about a
-- reader's list rather than about the work, and the two are independent: a cancelled project may
-- still want to be on screen, a finished one may want to be put away. A single column cannot
-- record both without one overwriting the other. Postgres has no ALTER TYPE ... DROP VALUE, so a
-- filing value added here would be permanent.
CREATE TYPE "project_status" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

CREATE TABLE "project" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "owner_id" UUID NOT NULL,
    -- What is wanted, how anyone would know it was reached, and how it is to be pursued. All three
    -- nullable: a project is routinely filed before its outcome can be stated precisely, and
    -- refusing to record it until then loses the only place the intent could live.
    "goal" TEXT,
    "acceptance_criteria" TEXT,
    "instructions" TEXT,
    "status" "project_status" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_pkey" PRIMARY KEY ("id")
);

-- Tenant scope, exactly as on task_list: every listing and every authorization check filters here
-- first, so this index is on the only access path the table has.
CREATE INDEX "project_owner_id_idx" ON "project"("owner_id");

ALTER TABLE "project" ADD CONSTRAINT "project_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The task's place in a project, and in a decomposition.
--
-- Both NULL for every existing row, and left that way: there is no backfill here, and none is
-- implied later. Guessing which of this deployment's tasks belong to which project would be
-- inventing a fact nobody stated, and the wrong guess is not visibly wrong.
ALTER TABLE "task" ADD COLUMN "project_id" UUID;
ALTER TABLE "task" ADD COLUMN "parent_task_id" UUID;
-- What would settle that this task is actually done, as opposed to reported done.
ALTER TABLE "task" ADD COLUMN "acceptance_criteria" TEXT;

-- RESTRICT on the project, and this is where it parts company with list_id.
--
-- A list is a dispatch policy its tasks can outlive, so SET NULL there loses nothing that cannot
-- be seen. A project is what its tasks are FOR: nulling that column would not detach a task, it
-- would erase the only record of why the task exists, and erase it invisibly — nothing about a
-- project-less task says it ever had one. So a non-empty project cannot be deleted at all.
--
-- The application refuses it first, with an error that says how many tasks are in the way
-- (ProjectsService.remove, under a row lock so a task cannot be filed into the project between
-- the count and the delete). This constraint is the backstop for anything that gets past that —
-- another writer, a future endpoint, a hand-run DELETE. The invariant is worth stating twice.
ALTER TABLE "task" ADD CONSTRAINT "task_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- SET NULL on the parent, for the reason list_id uses it: deleting a task detaches its subtasks
-- rather than destroying them.
--
-- CASCADE here would silently change what an already-shipped endpoint does — DELETE /tasks/:id
-- would begin deleting tasks the caller never named — and it is the irreversible direction: a
-- detached child can be re-pointed, a cascade-deleted subtree cannot be recovered. RESTRICT would
-- be wrong too: it would make a task undeletable until its subtasks were dismantled, changing the
-- behaviour of an endpoint that has always just worked.
ALTER TABLE "task" ADD CONSTRAINT "task_parent_task_id_fkey"
    FOREIGN KEY ("parent_task_id") REFERENCES "task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- "What is in this project" and "what are this task's subtasks" are the only two reads these
-- columns have, and each is one indexed lookup. They are also the FKs' own lookup indexes, which
-- is what keeps deleting a project or a parent from scanning a six-figure task table.
--
-- Both are almost entirely NULL at this migration, and Postgres b-trees do store NULL entries —
-- but the alternative (partial indexes WHERE ... IS NOT NULL) would have to be reconsidered the
-- moment the columns fill, and these are small next to the indexes task already carries.
CREATE INDEX "task_project_id_idx" ON "task"("project_id");
CREATE INDEX "task_parent_task_id_idx" ON "task"("parent_task_id");
