-- 0348 — session folders (docs/session-folders-move-design.md §3.1).
--
-- WHAT IT ADDS
-- ============
--   * `session_folder`: a named folder inside one of the owner's workspaces. Filing only — dispatch,
--     model, permissions and merge never read it. `UNIQUE (workspace_id, name)` is the "no two
--     folders of one workspace share a name" rule; the service answers its violation with a 409.
--     The workspace foreign key cascades, so a workspace that is really deleted (they are only ever
--     soft-deleted today) takes its folders with it.
--   * `session.folder_id`: the folder a session is filed in, at most one. `ON DELETE SET NULL`, so
--     deleting a folder puts its sessions back in the workspace's list and deletes none of them.
--     Indexed because that SET NULL has to find the sessions that name the folder.
--
-- WHY A SINGLE-COLUMN FOREIGN KEY
-- ===============================
-- Not `(folder_id, workspace_id)` → `session_folder(id, workspace_id)`: ON DELETE SET NULL on a
-- composite key nulls every column of it, so deleting a folder would clear the session's
-- workspace_id too. "The folder belongs to the session's workspace" is held by the service instead:
-- the only writers of folder_id are session create and `POST /sessions/:id/move`, and both check the
-- folder against the workspace the session is (or is being created) in.
--
-- BACKWARD COMPATIBLE
-- ===================
-- A new table, and a nullable column with no default: catalog-only on `session`, no row is
-- rewritten. A server that predates this never names the column, so every session it creates or
-- updates simply stays out of every folder. The index is a plain build, as 0305's is: a migration
-- runs in a transaction, and `session` is a few thousand rows here.

CREATE TABLE "session_folder" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_folder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "session_folder_workspace_id_name_key" ON "session_folder"("workspace_id", "name");

CREATE INDEX "session_folder_owner_id_idx" ON "session_folder"("owner_id");

ALTER TABLE "session_folder" ADD CONSTRAINT "session_folder_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "session_folder" ADD CONSTRAINT "session_folder_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "session" ADD COLUMN "folder_id" UUID;

CREATE INDEX "session_folder_id_idx" ON "session"("folder_id");

ALTER TABLE "session" ADD CONSTRAINT "session_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "session_folder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
