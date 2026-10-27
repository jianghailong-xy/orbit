import { encodeId } from './idCodec';

// The folder page each workspace's session list was last on (docs/session-folders-move-design.md §7):
// a workspace left on one of its folders comes back on that folder's page when the sidebar opens it
// again, not on its whole list (owner, 2026-10-27). In-memory only, as the console's last-open session
// per workspace is (WorkspaceView's `lastSessionByWorkspace`); a reload keeps its own `?folder=`.
const folderByWorkspace = new Map<string, string>();

/** The folder `workspaceId`'s list shows now — the route's `folder` param as it stands — or null on its
 *  own list. */
export function rememberListFolder(workspaceId: string, folder: string | null): void {
  if (folder) folderByWorkspace.set(workspaceId, folder);
  else folderByWorkspace.delete(workspaceId);
}

/** Where the sidebar opens `workspaceId`: its list, on the folder page it was left on. A folder deleted
 *  since is the console's to drop, as it drops any folder that isn't the workspace's. */
export const workspaceListPath = (workspaceId: string): string => {
  const folder = folderByWorkspace.get(workspaceId);
  return `/workspaces/${encodeId(workspaceId)}${folder ? `?folder=${encodeURIComponent(folder)}` : ''}`;
};
