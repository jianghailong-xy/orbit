-- The conversation a project is coordinated from.
--
-- Additive and inert, on the same terms as 0107 and 0108: two nullable columns, no row rewritten,
-- nothing on the dispatch path reading either. A deployment that applies this and then runs the
-- previous build behaves exactly as it did before — which is what makes it safe to land before
-- anything that coordinates.
--
-- The same shape task_list.owner_session_id has carried since 0102, and deliberately so: a project
-- and a list both needed one durable place to say "here is what changed about this body of work",
-- and the alternative — a session per visit — throws away the reasoning behind every earlier
-- decision. What differs is only which row points at the conversation.
--
-- A pointer, never a dependency. No sweep, claim gate or runner reads these columns, so a
-- coordinator that dies, fails, or is deleted cannot stall a single one of this project's tasks.
-- This deployment already has the cautionary case on file for the opposite arrangement (one
-- session created 43 lists and ~21,500 tasks, then sat FAILED for a fortnight while the work
-- carried on around it) — a resident supervisor the work depends on is the thing being avoided.
ALTER TABLE "project" ADD COLUMN "coordinator_session_id" UUID;
-- Where that conversation was opened. Recorded here rather than read back off the session because
-- session.workspace_id is nullable and belongs to the session's own lifecycle, while this is the
-- project's record of a decision. It is what a later request naming a DIFFERENT workspace is
-- compared against: that answers 409 rather than re-pointing the binding, since moving a
-- coordinator is a decision with a conversation attached to it, not a side effect of a retry.
ALTER TABLE "project" ADD COLUMN "coordinator_workspace_id" UUID;

-- One coordinator per project is the column; this is the other half — one project per coordinator.
--
-- Nothing here can create a second binding for a project (there is one column), so what this index
-- adds is the direction the column cannot state: a session is the coordinator of at most one
-- project. It is also what makes "which project is this session coordinating" an index lookup, and
-- what keeps deleting a session from sequentially scanning project to apply the SET NULL below.
--
-- UNIQUE rather than a plain index because a NULL is exempt from a Postgres unique index: every
-- project without a coordinator — which is all of them at this migration — is unconstrained, and
-- only the non-null pointers are held to one apiece.
CREATE UNIQUE INDEX "project_coordinator_session_id_key" ON "project"("coordinator_session_id");

-- The workspace pointer's own lookup index, and it is not optional for the same reason the one
-- above is not: Postgres creates an index on the REFERENCED column of a foreign key and never on
-- the referencing one, so a workspace delete would scan project in full to find the rows its SET
-- NULL applies to. Small today and small in principle — a project has one coordinator, so this
-- table stays the count of projects rather than the count of anything that grows per run.
CREATE INDEX "project_coordinator_workspace_id_idx" ON "project"("coordinator_workspace_id");

-- SET NULL, and it is the whole of "a deleted coordinator can be replaced".
--
-- Deleting the conversation empties the pointer and loses nothing else; the next request opens a
-- new one. CASCADE would delete the PROJECT — and would not even succeed, since every task's
-- project_id is ON DELETE RESTRICT (0107), so ending a session would start failing against work
-- it never touched. RESTRICT would be the mirror mistake: a project would make its own coordinator
-- undeletable, and a conversation the user put in Trash would have to be exhumed to get rid of it.
ALTER TABLE "project" ADD CONSTRAINT "project_coordinator_session_id_fkey"
    FOREIGN KEY ("coordinator_session_id") REFERENCES "session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- SET NULL for the reason task_list.foreman_workspace_id uses it (0100): deleting a workspace
-- forgets where the coordinator was opened, which is a fact about a machine, and must not take the
-- conversation with it. A project whose recorded workspace has gone keeps its coordinator and
-- returns it as before — with nothing left to compare an explicit workspace against, and so
-- nothing it could honestly call a conflict.
ALTER TABLE "project" ADD CONSTRAINT "project_coordinator_workspace_id_fkey"
    FOREIGN KEY ("coordinator_workspace_id") REFERENCES "workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
