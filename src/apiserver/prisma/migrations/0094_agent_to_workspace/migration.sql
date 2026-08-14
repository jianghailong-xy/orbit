-- Agent → Workspace.
--
-- The entity never was an agent. It holds no prompt-driven behaviour and cannot act: it names a
-- machine and a directory, and says how to branch and merge inside it. The actor is the Session
-- (one live runtime process); the body of work is the Task graph. "Agent" also collided three
-- ways in this schema alone — this table, session.running_subagents (the runtime's own
-- sub-agents), and device_enrollment.agents (coding-tool keys) — so the word is freed here for
-- the thing that actually runs.
--
-- Renames only; no data moves between rows. Single-replica deploy, so the cutover is the boot
-- restart, not a rolling window.
ALTER TABLE "agent" RENAME TO "workspace";
ALTER INDEX "agent_pkey" RENAME TO "workspace_pkey";
ALTER INDEX "agent_owner_id_idx" RENAME TO "workspace_owner_id_idx";
ALTER INDEX "agent_runner_id_idx" RENAME TO "workspace_runner_id_idx";
ALTER TABLE "workspace" RENAME CONSTRAINT "agent_owner_id_fkey" TO "workspace_owner_id_fkey";
ALTER TABLE "workspace" RENAME CONSTRAINT "agent_runner_id_fkey" TO "workspace_runner_id_fkey";

ALTER TABLE "session" RENAME COLUMN "agent_id" TO "workspace_id";
ALTER TABLE "session" RENAME CONSTRAINT "session_agent_id_fkey" TO "session_workspace_id_fkey";
ALTER INDEX "session_agent_id_created_at_idx" RENAME TO "session_workspace_id_created_at_idx";

ALTER TABLE "service_token" RENAME COLUMN "agent_id" TO "workspace_id";
ALTER TABLE "service_token" RENAME CONSTRAINT "service_token_agent_id_fkey" TO "service_token_workspace_id_fkey";

-- The permission posture is a property of the run, not of the directory: the same checkout wants
-- Plan for a risky migration and Auto for a test fix. Sessions already carry their own
-- `permission_mode`; the workspace column was only ever the seed for it. That seed moves to the
-- account (UserPreferences.defaultPermissionMode, which already existed but was never read by the
-- server) and the code fallback becomes 'auto'.
--
-- Backfill in the SAFE direction: a user with no explicit account default inherits the NARROWEST
-- (most-asking) mode any of their live workspaces used, so no one silently loses approval prompts
-- on a checkout that used to ask. Users with no workspaces stay unset and fall back to 'auto'.
UPDATE "user" u
SET preferences = u.preferences || jsonb_build_object('defaultPermissionMode', m.mode)
FROM (
  SELECT DISTINCT ON (owner_id) owner_id, permission_mode AS mode
  FROM "workspace"
  WHERE deleted_at IS NULL
  ORDER BY owner_id,
    CASE permission_mode
      WHEN 'plan' THEN 0
      WHEN 'default' THEN 1
      WHEN 'acceptEdits' THEN 2
      WHEN 'dontAsk' THEN 3
      WHEN 'auto' THEN 4
      WHEN 'bypassPermissions' THEN 5
      ELSE 6
    END
) m
WHERE u.id = m.owner_id
  AND NOT (u.preferences ? 'defaultPermissionMode');

ALTER TABLE "workspace" DROP COLUMN "permission_mode";

-- Dead columns. `allowed_tools` was never once set by a human: every row held exactly the
-- ['mcp__orbit__*'] the server injects itself, so it is a constant and now lives in code.
-- `mcp_config`, `max_turns` and `max_budget_usd` were never set at all. `disallowed_tools` stays
-- — it has a real user.
ALTER TABLE "workspace" DROP COLUMN "allowed_tools";
ALTER TABLE "workspace" DROP COLUMN "mcp_config";
ALTER TABLE "workspace" DROP COLUMN "max_turns";
ALTER TABLE "workspace" DROP COLUMN "max_budget_usd";
