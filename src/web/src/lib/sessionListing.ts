// The session list drawn from `GET /sessions/listing` (docs/session-list-scale-design.md §3): the loaded
// pages' top-level entries and the server's folder tallies, in the shape `sessionProjectListing` gives a
// list read whole — so the column, its sections and its rows read one list the same either way.
import type { SessionFolder, SessionListItem } from '../api';
import type { SidebarProject } from './projectAttention';
import { foldersByName, type SessionFolderRow } from './sessionFolders';
import type { SessionListingPage, SessionListingProject } from './sessionListingData';
import {
  sessionEntry,
  sessionProjectRow,
  type SessionProjectEntry,
  type SessionProjectListing,
  type SessionProjectRow,
  type SessionProjectRowOptions,
} from './sessionProjects';
import { sessionLifecycleStateOf } from './sessionState';

export interface SessionListingViewOptions<T> extends SessionProjectRowOptions<T> {
  view: 'open' | 'completed';
  /** The folder page being read, or null for the workspace's own list. */
  folderId: string | null;
  /** The workspace the list is. */
  workspaceId: string | null;
  /** Each project's coordinator, wherever it runs (GET /sessions/project-placement), for an entry whose page
   *  carried none. */
  coordinators?: readonly T[];
}

/**
 * The folder rows: the server's tallies on the folders this workspace has. Open lists every folder, the
 * empty ones and one made since the page was read too; Completed only the ones the server counted. With the
 * Runner offline a folder draws no activity, as the workspace's own row draws none.
 */
export function listingFolderRows(
  pages: readonly SessionListingPage[],
  folders: readonly SessionFolder[],
  opts: { view: 'open' | 'completed'; folderId: string | null; runnerOffline?: boolean },
): SessionFolderRow[] {
  if (opts.folderId) return [];
  const tallies = new Map((pages[0]?.folders ?? []).map((tally) => [tally.folderId, tally]));
  return foldersByName(folders).flatMap((folder): SessionFolderRow[] => {
    const tally = tallies.get(folder.id);
    if (!tally && opts.view === 'completed') return [];
    return [{
      folder,
      sessionCount: tally?.rowCount ?? 0,
      needsYou: tally?.needsYou ?? 0,
      // A session with a background job in flight spins on its row (`phase` RUNNING, quiet job or not): running here too.
      running: !opts.runnerOffline && !!(tally?.running || tally?.jobs),
    }];
  });
}

/**
 * A project entry's row. The page holds none of its members, so the row knows the ones the list reads
 * elsewhere: its coordinator, when it runs here in this view, and the members waiting on you here
 * (`contentSessions`, the placement read's). The server's entry places it and dates it.
 */
export function listingProjectRow<T extends SessionListItem>(
  entry: SessionListingProject,
  summary: SidebarProject | undefined,
  opts: SessionListingViewOptions<T>,
): SessionProjectRow<T> {
  const coordinator = (entry.coordinator as T | null) ??
    opts.coordinators?.find((session) => session.projectMembership?.projectId === entry.projectId) ?? null;
  const here = (session: T) => !!opts.workspaceId && session.workspace?.id === opts.workspaceId;
  const members = new Map<string, T>();
  if (coordinator && here(coordinator) &&
    sessionLifecycleStateOf(coordinator).toLowerCase() === opts.view) members.set(coordinator.id, coordinator);
  for (const session of opts.contentSessions ?? []) {
    if (session.projectMembership?.projectId === entry.projectId && here(session)) members.set(session.id, session);
  }
  return sessionProjectRow(entry.projectId, [...members.values()], coordinator, summary, opts, entry);
}

/** The project rows of the loaded pages, in their order. */
export function listingProjectRows<T extends SessionListItem>(
  pages: readonly SessionListingPage[],
  projects: readonly SidebarProject[],
  opts: SessionListingViewOptions<T>,
): SessionProjectRow<T>[] {
  const summaries = new Map(projects.map((project) => [project.id, project]));
  const seen = new Set<string>();
  return pages.flatMap((page) => page.entries.flatMap((entry) => {
    if (entry.kind !== 'project' || seen.has(entry.projectId)) return [];
    seen.add(entry.projectId);
    return [listingProjectRow(entry, summaries.get(entry.projectId), opts)];
  }));
}

const instant = (at: string | null | undefined): number => {
  const ms = Date.parse(at ?? '');
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
};

/**
 * The list as the loaded pages draw it: the folder rows, then every entry in the server's order. In Open
 * the entries are sorted again by the same rule — Pinned first, then placement — stably, so the server's
 * order stands until an optimistic pin moves a row; the next read is the truth. Completed keeps the
 * server's order, as the flat Completed list does.
 */
export function sessionListingView<T extends SessionListItem>(
  pages: readonly SessionListingPage[],
  folders: readonly SessionFolder[],
  projects: readonly SidebarProject[],
  opts: SessionListingViewOptions<T>,
): SessionProjectListing<T> {
  const summaries = new Map(projects.map((project) => [project.id, project]));
  const rows = new Map(listingProjectRows(pages, projects, opts).map((row) => [row.projectId, row]));
  const seen = new Set<string>();
  const sessions: T[] = [];
  const entries = pages.flatMap((page) => page.entries.flatMap((entry): SessionProjectEntry<T>[] => {
    const key = entry.kind === 'session' ? `session:${entry.session.id}` : `project:${entry.projectId}`;
    if (seen.has(key)) return [];
    seen.add(key);
    if (entry.kind === 'project') return [{ ...rows.get(entry.projectId)!, kind: 'project' }];
    sessions.push(entry.session as T);
    return [sessionEntry(entry.session as T, summaries)];
  }));
  if (opts.view === 'open') {
    entries.sort((a, b) => {
      if (!!a.pinnedAt !== !!b.pinnedAt) return a.pinnedAt ? -1 : 1;
      const left = instant(a.listedAt ?? a.createdAt);
      const right = instant(b.listedAt ?? b.createdAt);
      return left === right ? 0 : left > right ? -1 : 1;
    });
  }
  return {
    folders: listingFolderRows(pages, folders, opts),
    projects: [...rows.values()],
    sessions,
    entries,
  };
}
