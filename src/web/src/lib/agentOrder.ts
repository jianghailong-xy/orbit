// Agent ordering, shared by the sidebar (⌘1‒9), the boot pre-warm, and the default landing so
// that "the first agent" means the same thing everywhere. Custom drag order (`position`) first;
// agents never dragged (position null) fall to the end, oldest-first by `createdAt` — mirroring
// the server's ordering.

export interface OrderableAgent {
  id: string;
  createdAt: string;
  // Drag-to-reorder slot (0-based). null until the user reorders, so it sorts last.
  position?: number | null;
  // The machine this agent belongs to; an agent with no runner has no console to open.
  runnerId?: string | null;
  runner?: { id: string } | null;
}

export function orderAgents<T extends OrderableAgent>(agents: readonly T[]): T[] {
  return [...agents].sort((a, b) => {
    const pa = a.position ?? null;
    const pb = b.position ?? null;
    if (pa !== null && pb !== null) return pa - pb;
    if (pa !== null) return -1;
    if (pb !== null) return 1;
    return a.createdAt < b.createdAt ? -1 : 1;
  });
}

/** The agent id → runner id, whichever shape the payload carries (nested `runner` or flat). */
export const agentRunnerId = (a: OrderableAgent): string | null => a.runner?.id ?? a.runnerId ?? null;

export interface AgentGroup<T extends OrderableAgent> {
  // The machine these agents belong to; null for host-level "Shared" agents.
  runnerId: string | null;
  agents: T[];
}

/**
 * Group agents by their runner, preserving first-seen runner order; host-level agents (no runner)
 * sink to the bottom as a single "Shared" group. Mirrors the native `AgentListLogic.grouped` so the
 * web sidebar and the iOS/macOS drawer render the same shape. Order within a group is the input
 * order — feed it `orderAgents(...)` so the flattened result stays the ⌘1‒9 order.
 */
export function groupAgentsByRunner<T extends OrderableAgent>(agents: readonly T[]): AgentGroup<T>[] {
  const order: string[] = [];
  const map = new Map<string, T[]>();
  const host: T[] = [];
  for (const a of agents) {
    const rid = agentRunnerId(a);
    if (rid == null) {
      host.push(a);
      continue;
    }
    let bucket = map.get(rid);
    if (!bucket) {
      bucket = [];
      map.set(rid, bucket);
      order.push(rid);
    }
    bucket.push(a);
  }
  const groups: AgentGroup<T>[] = order.map((rid) => ({ runnerId: rid, agents: map.get(rid)! }));
  if (host.length) groups.push({ runnerId: null, agents: host });
  return groups;
}

/**
 * The agent the app lands on by default: the first (in sidebar order) that has a runner, so its
 * console can actually open. Config-only agents (no runner) are skipped — the same rule the
 * sidebar's `openAgent` uses.
 */
export function firstOpenableAgent<T extends OrderableAgent>(agents: readonly T[]): T | undefined {
  return orderAgents(agents).find((a) => agentRunnerId(a) != null);
}
