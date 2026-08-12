import { Prisma } from '@prisma/client';
import { AgentProvider } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Which provider an agent's next session starts on.
 *
 * An agent no longer *holds* a provider. It names a machine and a project directory; the provider
 * is a per-session binding (Session.provider, fixed for that session's lifetime because the
 * runtime thread belongs to whichever runtime opened it). Storing one on the agent made a
 * one-session choice re-point every later run — including the headless ones nobody is watching —
 * and pushed people into keeping one agent per provider for the same directory.
 *
 * What remains is a *default*, and it is derived rather than configured: the provider the last
 * interactive session in this project ran on. It needs no write path, so it cannot drift from what
 * actually happened, and every surface — web, native, MCP, task auto-run — answers the question
 * the same way.
 */
export interface AgentProviderSeed {
  provider: string;
  providerBuiltin: boolean;
}

/** A project that has never run anything has no history to read; start where Orbit starts. */
export const DEFAULT_AGENT_PROVIDER: AgentProviderSeed = {
  provider: AgentProvider.CLAUDE,
  providerBuiltin: true,
};

/**
 * The last interactive session's provider for each of `agentIds` (absent = never ran one).
 *
 * Task-launched runs are excluded on purpose: a task that pins a provider (Task.provider) is
 * stating what *that* job needs, and letting it move the project's default would make one pinned
 * job silently re-point the human's next session — the same coupling this replaced.
 */
export async function lastProviderByAgent(
  prisma: PrismaService,
  agentIds: Array<string | null | undefined>,
): Promise<Map<string, AgentProviderSeed>> {
  const ids = [...new Set(agentIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const rows = await prisma.$queryRaw<
    Array<{ agent_id: string; provider: string; provider_builtin: boolean }>
  >(Prisma.sql`
    SELECT DISTINCT ON (agent_id) agent_id, provider, provider_builtin
    FROM "session"
    WHERE agent_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
      AND task_id IS NULL
    ORDER BY agent_id, created_at DESC
  `);
  return new Map(
    rows.map((r) => [r.agent_id, { provider: r.provider, providerBuiltin: r.provider_builtin }]),
  );
}

/** The seed for one agent, with the floor applied. */
export async function agentProviderSeed(
  prisma: PrismaService,
  agentId: string,
): Promise<AgentProviderSeed> {
  const seeds = await lastProviderByAgent(prisma, [agentId]);
  return seeds.get(agentId) ?? DEFAULT_AGENT_PROVIDER;
}

/**
 * Attach the derived default to agent payloads.
 *
 * `lastProvider` is the honest name and what clients read. `provider` is kept as a read-only alias
 * for one release: iOS and macOS builds already in the field read it for an agent's badge and
 * avatar, and dropping it would render every agent as Claude until those ship. Neither is stored —
 * the column is gone (migration 0088).
 */
export function withProviderSeed<T extends { id: string }>(
  agents: T[],
  seeds: Map<string, AgentProviderSeed>,
): Array<T & { lastProvider: string; provider: string; providerBuiltin: boolean }> {
  return agents.map((agent) => {
    const seed = seeds.get(agent.id) ?? DEFAULT_AGENT_PROVIDER;
    return {
      ...agent,
      lastProvider: seed.provider,
      provider: seed.provider,
      providerBuiltin: seed.providerBuiltin,
    };
  });
}
