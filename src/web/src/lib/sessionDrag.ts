// Dragging a session row onto a folder row: a shortcut for Move…'s first group, filing a session in
// a folder of its own workspace (docs/session-folders-move-design.md §7). Move… stays the complete
// way to move; a drag never leaves the workspace. Pure, so the rules are tested without mounting
// the console.
import { sessionMovable } from './sessionSwipe';
import type { SessionListView } from './queries';

/** The drag data type a session row carries: its own, so the session pane's drop-to-upload (which
 *  takes `Files` only) and the composer (which takes text) never read a dragged row as theirs. */
export const SESSION_DRAG_TYPE = 'application/x-orbit-session';

/** What a drag carries, by the types its data transfer lists (the data itself can only be read on drop). */
export const dragCarriesSession = (types: readonly string[] | undefined): boolean =>
  !!types && Array.from(types).includes(SESSION_DRAG_TYPE);
export const dragCarriesFiles = (types: readonly string[] | undefined): boolean =>
  !!types && Array.from(types).includes('Files');

/** The session being dragged, as its row has it. */
export interface DraggedSession {
  id: string;
  title?: string | null;
  workspaceId: string;
  folderId: string | null;
  projectId?: string;
}

/** Where a drop lands: a folder of a workspace, or that workspace's list (`folderId` null, No Folder). */
export interface FolderDropTarget {
  workspaceId: string;
  folderId: string | null;
}

/**
 * What dropping the dragged session on a target does. `move` files it there; `here` is the folder
 * it is already in, which takes no drop (no request, no toast); `refused` is anything else — another
 * workspace's folder, which only Move… reaches. A session whose folder isn't among the workspace's
 * known folders (deleted since the list was read) is in no folder, where the list draws it.
 */
export function folderDropVerdict(
  dragged: DraggedSession,
  target: FolderDropTarget,
  knownFolderIds: ReadonlySet<string>,
): 'move' | 'here' | 'refused' {
  if (dragged.workspaceId !== target.workspaceId) return 'refused';
  if (target.folderId !== null && !knownFolderIds.has(target.folderId)) return 'refused';
  const current = dragged.folderId && knownFolderIds.has(dragged.folderId) ? dragged.folderId : null;
  return current === target.folderId ? 'here' : 'move';
}

/**
 * Whether a session row may be picked up. Only where the list offers somewhere to drop it — folder
 * rows on a workspace's list, or a folder's page, whose head means No Folder — and only a row Move…
 * would file: not in Trash, and not a member that goes where its project's coordinator goes. A
 * project's row is its coordinator's session row, so it is asked about its coordinator, and the
 * members follow; a project with no coordinator is no session row and is never asked. Not on a
 * touch screen, where a held press opens the row's menu and a sideways one swipes it.
 */
export function sessionRowDraggable(
  row: {
    projectMembership?: { role: string } | null;
    projectMark?: unknown;
    [key: string]: unknown;
  },
  context: { view: SessionListView; dropTargets: boolean; touch: boolean; renaming: boolean },
): boolean {
  if (!context.dropTargets || context.touch || context.renaming || context.view === 'trash') return false;
  return sessionMovable(row) || !!row.projectMark;
}

/** How far the list scrolls on one frame of a drag held near its top or bottom edge (px): negative
 *  up, positive down, 0 away from both. Faster the closer the pointer is to the edge. */
export function dragEdgeScrollStep(
  pointerY: number,
  list: { top: number; bottom: number },
  edge = 48,
  maxStep = 16,
): number {
  const height = list.bottom - list.top;
  const zone = Math.min(edge, height / 3);
  if (zone <= 0 || pointerY < list.top || pointerY > list.bottom) return 0;
  const intoTop = list.top + zone - pointerY;
  if (intoTop > 0) return -Math.ceil((intoTop / zone) * maxStep);
  const intoBottom = pointerY - (list.bottom - zone);
  if (intoBottom > 0) return Math.ceil((intoBottom / zone) * maxStep);
  return 0;
}
