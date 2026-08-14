-- Versioned dispatch policy for a task list, so a change can be undone instead of pre-approved.
--
-- The failure this is designed against is not a wrong edit, it is an unnoticed one. The auto-run
-- incident that motivated this whole area ran for 21 hours; the problem was never that a bad
-- decision had been made, it was that nothing recorded a decision had been made at all. Once
-- every policy write leaves a restorable revision with a reason attached, "undo it" replaces
-- "approve it first" as the safety mechanism — which is the stronger of the two, because review
-- cannot catch a change that looks reasonable and turns out not to be, and a rollback can.
--
-- Snapshots, not deltas. Restoring v3 writes v3's values back as a new revision, which works
-- from any distance and keeps the restore itself auditable; a delta chain only undoes the last
-- step and must be replayed to answer "what did it look like then".
--
-- Title is not versioned. Renaming a list is not a policy change, and rename revisions would
-- bury the ones that matter.
--
-- No backfill: existing lists have no revisions, and the service records the pre-change state as
-- v1 the first time a policy field on such a list is written. History therefore starts at the
-- first edit rather than requiring a migration to invent one for 118 untouched lists.
CREATE TABLE "task_list_revision" (
    "id" UUID NOT NULL,
    "list_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "instructions" TEXT,
    "paused" BOOLEAN NOT NULL,
    "max_concurrent" INTEGER,
    "note" TEXT,
    "author_type" "creator_type" NOT NULL,
    "author_id" UUID NOT NULL,
    "author_session_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_list_revision_pkey" PRIMARY KEY ("id")
);

-- The uniqueness that makes `version` a version: two concurrent writers cannot mint the same
-- number even if the service's row lock were ever bypassed.
CREATE UNIQUE INDEX "task_list_revision_list_id_version_key" ON "task_list_revision"("list_id", "version");

-- Serves the history read, which is always newest-first for one list.
CREATE INDEX "task_list_revision_list_id_created_at_idx" ON "task_list_revision"("list_id", "created_at" DESC);

-- Deleting a list takes its history with it: a revision of a list that no longer exists cannot
-- be restored and cannot be read in context.
ALTER TABLE "task_list_revision" ADD CONSTRAINT "task_list_revision_list_id_fkey"
    FOREIGN KEY ("list_id") REFERENCES "task_list"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The authoring session detaches rather than deleting the revision: the history of what was
-- decided must outlive the run that decided it.
ALTER TABLE "task_list_revision" ADD CONSTRAINT "task_list_revision_author_session_id_fkey"
    FOREIGN KEY ("author_session_id") REFERENCES "session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
