import { Prisma } from '@prisma/client';
import { AgentProvider } from '@orbit/shared';
import { legacySessionEngine, recordedEngine } from '../providers/session-engine';

/**
 * Which provider a workspace's next session starts on.
 *
 * A workspace no longer *holds* a provider. It names a machine and a project directory; the provider
 * is a per-session binding (Session.provider, fixed for that session's lifetime because the
 * runtime thread belongs to whichever runtime opened it). Storing one on the workspace made a
 * one-session choice re-point every later run — including the headless ones nobody is watching —
 * and pushed people into keeping one workspace per provider for the same directory.
 *
 * What remains is a *default*, and it is derived rather than configured: the provider the last
 * interactive session in this project ran on. It needs no write path, so it cannot drift from what
 * actually happened, and every surface — web, native, MCP, task auto-run — answers the question
 * the same way.
 *
 * A session has two axes now (docs/provider-engine-contract.md §3.4): the engine that ran it and the
 * credential it ran on, so the default is the pair. A new session re-checks it (engine-provider.ts):
 * a credential that is gone is refused as it always was, and one its engine no longer runs gives way to
 * the credential's own default engine.
 */
export interface AgentProviderSeed {
  /** The engine that session ran on: its recorded one, else derived by the old rules (§5.4). Null when
   *  nobody can tell — its key is gone — which a new session started from it is refused on anyway. */
  engine: AgentProvider | null;
  provider: string;
  providerBuiltin: boolean;
}

/** A project that has never run anything has no history to read; start where Orbit starts. */
export const DEFAULT_AGENT_PROVIDER: AgentProviderSeed = {
  engine: AgentProvider.CLAUDE,
  provider: AgentProvider.CLAUDE,
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
 *
 * One kind of workspace has a default before it has history: a managed runner's default workspace,
 * once its runner became READY with a runtime installed and signed in (`managed_runner.initial_provider`,
 * docs/managed-runner-design.md "Provisioning retry wake and sleep" 3). Its first session starts there
 * rather than on the floor below, which that runner may not have; from then on its history decides,
 * as everywhere. No other workspace is affected — the floor stays Claude. A managed runner's
 * `initial_provider` is a built-in engine's name, so it is both the engine and the credential.
 *
 * The session's engine is its recorded one; a row an older API replica wrote has none, and is placed by
 * the rules dispatch followed before the split (legacySessionEngine), read here only for those rows.
 */
export async function lastProviderByWorkspace(
  // A caller inside a transaction can hand over its own client.
  prisma: Prisma.TransactionClient,
  workspaceIds: Array<string | null | undefined>,
): Promise<Map<string, AgentProviderSeed>> {
  const ids = [...new Set(workspaceIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const rows = await prisma.$queryRaw<
    Array<{ workspace_id: string; engine: string | null; provider: string; provider_builtin: boolean; owner_id: string | null }>
  >(Prisma.sql`
    WITH a(id) AS (SELECT unnest(ARRAY[${Prisma.join(ids)}]::uuid[]))
    SELECT a.id AS workspace_id, s.engine, s.provider, s.provider_builtin, s.owner_id::text AS owner_id
    FROM a
    CROSS JOIN LATERAL (
      SELECT engine, provider, provider_builtin, owner_id
      FROM "session"
      WHERE workspace_id = a.id AND task_id IS NULL AND parent_session_id IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    ) s
    UNION ALL
    SELECT a.id, m.initial_provider, m.initial_provider, true, NULL
    FROM a
    JOIN managed_runner m ON m.default_workspace_id = a.id AND m.initial_provider IS NOT NULL
    WHERE NOT EXISTS (
      SELECT 1 FROM "session"
      WHERE workspace_id = a.id AND task_id IS NULL AND parent_session_id IS NULL
    )
  `);
  const seeds = new Map<string, AgentProviderSeed>();
  for (const r of rows) {
    const engine = recordedEngine(r.engine) ?? (r.owner_id
      ? await legacySessionEngine(prisma, { provider: r.provider, providerBuiltin: r.provider_builtin, ownerId: r.owner_id })
      : null);
    seeds.set(r.workspace_id, { engine, provider: r.provider, providerBuiltin: r.provider_builtin });
  }
  return seeds;
}

/** The seed for one workspace, with the floor applied. */
export async function agentProviderSeed(
  prisma: Prisma.TransactionClient,
  workspaceId: string,
): Promise<AgentProviderSeed> {
  const seeds = await lastProviderByWorkspace(prisma, [workspaceId]);
  return seeds.get(workspaceId) ?? DEFAULT_AGENT_PROVIDER;
}

/**
 * Attach the derived default to workspace payloads.
 *
 * `lastProvider` is the honest name and what clients read, with `lastEngine` beside it: the engine that
 * session ran on (null when nobody can tell). `provider` is kept as a read-only alias for one release:
 * iOS and macOS builds already in the field read it for a workspace's badge and avatar, and dropping it
 * would render every workspace as Claude until those ship. None is stored — the column is gone
 * (migration 0088).
 */
export function withProviderSeed<T extends { id: string }>(
  workspaces: T[],
  seeds: Map<string, AgentProviderSeed>,
): Array<T & { lastEngine: AgentProvider | null; lastProvider: string; provider: string; providerBuiltin: boolean }> {
  return workspaces.map((workspace) => {
    const seed = seeds.get(workspace.id) ?? DEFAULT_AGENT_PROVIDER;
    return {
      ...workspace,
      lastEngine: seed.engine,
      lastProvider: seed.provider,
      provider: seed.provider,
      providerBuiltin: seed.providerBuiltin,
    };
  });
}
