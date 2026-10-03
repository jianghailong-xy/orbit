// The one order the user arranges: the sidebar, ⌘1‒9, ⌘↑/↓ and the default landing all read it.
// `position` comes first (written by a reorder, or by migration 0369 for every workspace that
// existed); workspaces never placed (position null) follow, oldest-first by `createdAt` — mirroring
// the server. The runner is not a sort key, with one exception kept from the old Shared group: a
// workspace with no runner has no console to open, so it stays below every one that has.

import { arrayMove } from '@dnd-kit/sortable';

export interface OrderableWorkspace {
  id: string;
  createdAt: string;
  // The slot the user arranged it into (0-based). null until placed, so it sorts last.
  position?: number | null;
  // The machine this workspace belongs to; a workspace with no runner has no console to open.
  runnerId?: string | null;
  runner?: { id: string } | null;
}

/** The workspace id → runner id, whichever shape the payload carries (nested `runner` or flat). */
export const workspaceRunnerId = (a: OrderableWorkspace): string | null => a.runner?.id ?? a.runnerId ?? null;

export function orderWorkspaces<T extends OrderableWorkspace>(workspaces: readonly T[]): T[] {
  return [...workspaces].sort((a, b) => {
    const ha = workspaceRunnerId(a) === null ? 1 : 0;
    const hb = workspaceRunnerId(b) === null ? 1 : 0;
    if (ha !== hb) return ha - hb;
    const pa = a.position ?? null;
    const pb = b.position ?? null;
    if (pa !== null && pb !== null) return pa - pb;
    if (pa !== null) return -1;
    if (pb !== null) return 1;
    return a.createdAt < b.createdAt ? -1 : 1;
  });
}

/**
 * The full id list POST /workspaces/reorder takes once `activeId` is dropped on `overId`'s row, or
 * null when the drop moves nothing.
 */
export function reorderedWorkspaceIds(
  ordered: readonly { id: string }[],
  activeId: string,
  overId: string,
): string[] | null {
  const ids = ordered.map((a) => a.id);
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return null;
  return arrayMove(ids, from, to);
}

/**
 * The workspace the app lands on by default: the first (in sidebar order) that has a runner, so its
 * console can actually open. Config-only workspaces (no runner) are skipped — the same rule the
 * sidebar's `openWorkspace` uses.
 */
export function firstOpenableWorkspace<T extends OrderableWorkspace>(workspaces: readonly T[]): T | undefined {
  return orderWorkspaces(workspaces).find((a) => workspaceRunnerId(a) != null);
}
