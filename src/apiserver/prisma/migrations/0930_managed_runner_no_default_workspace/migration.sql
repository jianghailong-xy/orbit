-- 0930 — a managed runner no longer has a default workspace (docs/managed-runner-no-default-workspace.md).
--
-- `managed_runner.default_workspace_id` becomes nullable: a new mapping is written without one, and the managed
-- runner starts with no workspace, like any machine. Its unique indexes and its foreign key stay, so a mapping
-- that still names a workspace keeps the same guarantees.
--
-- Every default workspace nobody used is let go (owner 2026-11-16): one with no session, no task assigned to it
-- and no project naming it as an agent. The mapping stops naming it and the workspace is soft-deleted, as
-- `WorkspacesService.remove` does. A default workspace someone used stays, as an ordinary workspace.
--
-- Runs twice safely: DROP NOT NULL is a no-op on a nullable column, and the second pass finds no mapping left
-- that names an unused workspace.
ALTER TABLE "managed_runner" ALTER COLUMN "default_workspace_id" DROP NOT NULL;

WITH unused AS (
  SELECT m.id AS mapping_id, m.default_workspace_id AS workspace_id
  FROM "managed_runner" m
  JOIN "workspace" w ON w.id = m.default_workspace_id
  WHERE NOT EXISTS (SELECT 1 FROM "session" s WHERE s.workspace_id = w.id)
    AND NOT EXISTS (SELECT 1 FROM "task" t WHERE t.assignee_id = w.id)
    AND NOT EXISTS (SELECT 1 FROM "project_member" p WHERE p.agent_id = w.id)
), released AS (
  UPDATE "managed_runner" m SET "default_workspace_id" = NULL
  FROM unused u WHERE m.id = u.mapping_id
  RETURNING u.workspace_id
)
UPDATE "workspace" w SET "deleted_at" = now()
FROM released r WHERE w.id = r.workspace_id AND w.deleted_at IS NULL;
