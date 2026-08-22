"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_AGENT_PROVIDER = void 0;
exports.lastProviderByWorkspace = lastProviderByWorkspace;
exports.agentProviderSeed = agentProviderSeed;
exports.withProviderSeed = withProviderSeed;
const client_1 = require("@prisma/client");
const shared_1 = require("@orbit/shared");
/** A project that has never run anything has no history to read; start where Orbit starts. */
exports.DEFAULT_AGENT_PROVIDER = {
    provider: shared_1.AgentProvider.CLAUDE,
    providerBuiltin: true,
};
/**
 * The last interactive session's provider for each of `workspaceIds` (absent = never ran one).
 *
 * Only sessions a *person* started count. Two kinds are excluded, for the same reason:
 *
 *  • Task-launched runs — a task that pins a provider (Task.provider) is stating what *that* job
 *    needs, and letting it move the project's default would make one pinned job silently re-point
 *    the human's next session.
 *  • Workspace-spawned children (`parent_session_id`) — a session opened through MCP `session_create`
 *    picks its provider for the job it was spawned to do (a throwaway "run this on OpenCode to
 *    reproduce the startup path" test is the common case). Counting those let one scripted probe
 *    re-point the project default, which is what put OpenCode in front of a human who had never
 *    chosen it.
 *
 * Written as a LATERAL per id rather than the obvious `DISTINCT ON (workspace_id) … ORDER BY
 * created_at DESC`: Postgres has no skip scan, so that form reads *every* session belonging to
 * these workspaces and sorts them, which on the workspace-list path (every client boot) is a sequential
 * scan that grows with the session table. One `LIMIT 1` per id instead walks
 * session_workspace_id_created_at_idx and stops at the first row — measured on a copy of a live
 * database: 4.7ms and 930 rows scanned → 0.3ms and one row per workspace.
 */
async function lastProviderByWorkspace(prisma, workspaceIds) {
    const ids = [...new Set(workspaceIds.filter((id) => !!id))];
    if (ids.length === 0)
        return new Map();
    const rows = await prisma.$queryRaw(client_1.Prisma.sql `
    SELECT a.id AS workspace_id, s.provider, s.provider_builtin
    FROM unnest(ARRAY[${client_1.Prisma.join(ids)}]::uuid[]) AS a(id)
    CROSS JOIN LATERAL (
      SELECT provider, provider_builtin
      FROM "session"
      WHERE workspace_id = a.id AND task_id IS NULL AND parent_session_id IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    ) s
  `);
    return new Map(rows.map((r) => [r.workspace_id, { provider: r.provider, providerBuiltin: r.provider_builtin }]));
}
/** The seed for one workspace, with the floor applied. */
async function agentProviderSeed(prisma, workspaceId) {
    const seeds = await lastProviderByWorkspace(prisma, [workspaceId]);
    return seeds.get(workspaceId) ?? exports.DEFAULT_AGENT_PROVIDER;
}
/**
 * Attach the derived default to workspace payloads.
 *
 * `lastProvider` is the honest name and what clients read. `provider` is kept as a read-only alias
 * for one release: iOS and macOS builds already in the field read it for a workspace's badge and
 * avatar, and dropping it would render every workspace as Claude until those ship. Neither is stored —
 * the column is gone (migration 0088).
 */
function withProviderSeed(workspaces, seeds) {
    return workspaces.map((workspace) => {
        const seed = seeds.get(workspace.id) ?? exports.DEFAULT_AGENT_PROVIDER;
        return {
            ...workspace,
            lastProvider: seed.provider,
            provider: seed.provider,
            providerBuiltin: seed.providerBuiltin,
        };
    });
}
//# sourceMappingURL=workspace-provider.js.map