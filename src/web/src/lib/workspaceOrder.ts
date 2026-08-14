// Base workspace ordering within runner groups. Custom drag order (`position`) comes first; workspaces
// never dragged (position null) fall to the end, oldest-first by `createdAt` — mirroring the
// server. Callers then apply the persisted runner-group order where the flattened order matters.

export interface OrderableWorkspace {
  id: string;
  createdAt: string;
  // Drag-to-reorder slot (0-based). null until the user reorders, so it sorts last.
  position?: number | null;
  // The machine this workspace belongs to; a workspace with no runner has no console to open.
  runnerId?: string | null;
  runner?: { id: string } | null;
}

export function orderWorkspaces<T extends OrderableWorkspace>(workspaces: readonly T[]): T[] {
  return [...workspaces].sort((a, b) => {
    const pa = a.position ?? null;
    const pb = b.position ?? null;
    if (pa !== null && pb !== null) return pa - pb;
    if (pa !== null) return -1;
    if (pb !== null) return 1;
    return a.createdAt < b.createdAt ? -1 : 1;
  });
}

/** The workspace id → runner id, whichever shape the payload carries (nested `runner` or flat). */
export const workspaceRunnerId = (a: OrderableWorkspace): string | null => a.runner?.id ?? a.runnerId ?? null;

export interface WorkspaceGroup<T extends OrderableWorkspace> {
  // The machine these workspaces belong to; null for host-level "Shared" workspaces.
  runnerId: string | null;
  workspaces: T[];
}

/**
 * Group workspaces by their runner, preserving first-seen runner order; host-level workspaces (no runner)
 * sink to the bottom as a single "Shared" group. Mirrors the native `WorkspaceListLogic.grouped` so the
 * web sidebar and the iOS/macOS drawer render the same shape. Order within a group is the input
 * order — feed it `orderWorkspaces(...)` so the flattened result stays the ⌘1‒9 order.
 */
export function groupWorkspacesByRunner<T extends OrderableWorkspace>(workspaces: readonly T[]): WorkspaceGroup<T>[] {
  const order: string[] = [];
  const map = new Map<string, T[]>();
  const host: T[] = [];
  for (const a of workspaces) {
    const rid = workspaceRunnerId(a);
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
  const groups: WorkspaceGroup<T>[] = order.map((rid) => ({ runnerId: rid, workspaces: map.get(rid)! }));
  if (host.length) groups.push({ runnerId: null, workspaces: host });
  return groups;
}

export interface OrderableRunner {
  id: string;
}

/**
 * Apply the persisted runner order to already-grouped workspaces. Groups whose runner is no longer
 * present follow the known runners in their existing order; host-level "Shared" stays last.
 */
export function orderWorkspaceGroupsByRunners<T extends OrderableWorkspace>(
  groups: readonly WorkspaceGroup<T>[],
  runners: readonly OrderableRunner[],
): WorkspaceGroup<T>[] {
  const rank = new Map(runners.map((runner, index) => [runner.id, index]));
  return groups
    .map((group, index) => ({
      group,
      index,
      rank: group.runnerId === null ? null : rank.get(group.runnerId),
    }))
    .sort((a, b) => {
      if (a.rank === null) return b.rank === null ? a.index - b.index : 1;
      if (b.rank === null) return -1;
      if (a.rank !== undefined && b.rank !== undefined) return a.rank - b.rank;
      if (a.rank !== undefined) return -1;
      if (b.rank !== undefined) return 1;
      return a.index - b.index;
    })
    .map(({ group }) => group);
}

/**
 * The workspace the app lands on by default: the first (in sidebar order) that has a runner, so its
 * console can actually open. Config-only workspaces (no runner) are skipped — the same rule the
 * sidebar's `openWorkspace` uses.
 */
export function firstOpenableWorkspace<T extends OrderableWorkspace>(
  workspaces: readonly T[],
  runners: readonly OrderableRunner[] = [],
): T | undefined {
  const groups = groupWorkspacesByRunner(orderWorkspaces(workspaces));
  return orderWorkspaceGroupsByRunners(groups, runners)
    .flatMap((group) => group.workspaces)
    .find((a) => workspaceRunnerId(a) != null);
}
