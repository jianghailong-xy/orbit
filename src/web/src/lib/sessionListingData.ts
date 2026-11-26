// `GET /sessions/listing` as the web caches it (docs/session-list-scale-design.md §3.2): one workspace's list
// as top-level entries, read a page at a time into one infinite query (queries.ts sessionListingQuery). Pure,
// and free of components, so the stream's readers (useControlPlane, lib/sessionReach) can read it too.
import type { InfiniteData, QueryClient, QueryKey } from '@tanstack/react-query';
import type { SessionListItem } from '../api';

/** A folder row's tallies, as the server counts them (workspaceSessionCounts' predicates, by folder). */
export interface SessionListingFolder {
  folderId: string;
  /** The rows its page lists: a project is one row however many members it holds. */
  rowCount: number;
  needsYou: number;
  running: boolean;
  jobs: boolean;
}

export interface SessionListingProject {
  kind: 'project';
  projectId: string;
  /** The greatest listedAt (else createdAt) of the members it holds: where the entry sits. */
  placedAt: string;
  /** The greatest lastTurnAt (else createdAt) of those members: when it last spoke. */
  spokeAt: string;
  /** How many members it holds in this workspace. */
  memberCount: number;
  /** The project's coordinator in either lifecycle, or null for a project with none. */
  coordinator: SessionListItem | null;
}

export type SessionListingEntry = { kind: 'session'; session: SessionListItem } | SessionListingProject;

export interface SessionListingPage {
  /** Only on a first page of the workspace's own list (no `folderId`). */
  folders?: SessionListingFolder[];
  entries: SessionListingEntry[];
  /** The next page's `after`; null at the end. */
  next: string | null;
  /** The `after` this page was asked with was written under an order the list no longer has: this is the
   *  first page again, and it replaces the pages already read. */
  restarted?: true;
}

export type SessionListingData = InfiniteData<SessionListingPage, string | null>;

/** A listing query's key: `['sessions', runnerId, workspaceId, view, 'listing', folderId]` (sessionListingQuery). */
export const isSessionListingKey = (key: QueryKey): boolean => key[0] === 'sessions' && key[4] === 'listing';

/** The folder page a listing key reads, or null for the workspace's own list. */
export const listingKeyFolder = (key: QueryKey): string | null => (typeof key[5] === 'string' && key[5] ? key[5] : null);

export const isListingData = (data: unknown): data is SessionListingData =>
  !!data && typeof data === 'object' && Array.isArray((data as { pages?: unknown }).pages) &&
  (data as { pages: unknown[] }).pages.every((page) =>
    !!page && typeof page === 'object' && Array.isArray((page as { entries?: unknown }).entries));

/**
 * The pages as they stand once a `restarted` answer is in: that answer is a fresh first page (the list's
 * order switched under the cursor that asked for it), so every page read before it goes, and it becomes
 * the first page — read again from the top, never appended (design §3.2). Anything else is as it was.
 */
export function latestListingPages(data: unknown): unknown {
  if (!isListingData(data)) return data;
  let from = 0;
  data.pages.forEach((page, i) => {
    if (i > 0 && page.restarted) from = i;
  });
  if (from === 0) return data;
  return { pages: data.pages.slice(from), pageParams: [null, ...data.pageParams.slice(from + 1)] };
}

/** Every session row the loaded pages hold: each session entry's, and each project entry's coordinator. */
export function listingRows(data: unknown): SessionListItem[] {
  if (!isListingData(data)) return [];
  return data.pages.flatMap((page) => page.entries.flatMap((entry) =>
    entry.kind === 'session' ? [entry.session] : entry.coordinator ? [entry.coordinator] : []));
}

/** How many entries the loaded pages hold. */
export const listingEntryCount = (data: unknown): number =>
  isListingData(data) ? data.pages.reduce((count, page) => count + page.entries.length, 0) : 0;

/** The row an entry stands for: a session entry's session, a project entry's coordinator. */
const entryRow = (entry: SessionListingEntry): SessionListItem | null =>
  entry.kind === 'session' ? entry.session : entry.coordinator;

const withEntries = (
  data: SessionListingData,
  entries: (page: SessionListingPage, index: number) => SessionListingEntry[],
): SessionListingData => ({ ...data, pages: data.pages.map((page, i) => ({ ...page, entries: entries(page, i) })) });

/**
 * An optimistic edit of the loaded pages' rows (rename, pin, tags, a setting): `patch` answers the row as it
 * reads now, or null to take a session entry off the list (Complete, Delete). A coordinator answered null
 * keeps its project's entry: the members it holds still place it. The next read is the truth.
 */
export function patchListingRows(
  data: unknown,
  patch: (row: SessionListItem) => SessionListItem | null,
): unknown {
  if (!isListingData(data)) return data;
  return withEntries(data, (page) => page.entries.flatMap((entry): SessionListingEntry[] => {
    if (entry.kind === 'session') {
      const next = patch(entry.session);
      return next ? [next === entry.session ? entry : { ...entry, session: next }] : [];
    }
    if (!entry.coordinator) return [entry];
    const next = patch(entry.coordinator);
    return [next && next !== entry.coordinator ? { ...entry, coordinator: next } : entry];
  }));
}

/** Takes a project's entry off the loaded pages (its sessions were completed together). */
export function dropListingProject(data: unknown, projectId: string): unknown {
  if (!isListingData(data)) return data;
  return withEntries(data, (page) =>
    page.entries.filter((entry) => entry.kind !== 'project' || entry.projectId !== projectId));
}

/** Whether the loaded pages hold `id` as an entry of their own: a session entry, or a project's coordinator. */
const holdsEntry = (data: SessionListingData, id: string): boolean =>
  data.pages.some((page) => page.entries.some((entry) => entryRow(entry)?.id === id));

/**
 * A session filed in folder `to` (null: in none) from folder `from`, on one listing whose page is `scope`
 * (null: the workspace's own list). The entry leaves every page it is no longer filed in — a project's entry
 * with its coordinator, which files it — and stays, refiled, on the page it now is. Where it was an entry,
 * the folder rows' counts follow it: one row out of `from`, one into `to`. Where it goes in the destination's
 * page is the next read's to say.
 */
export function fileListingEntry(
  data: unknown,
  scope: string | null,
  move: { id: string; from: string | null; to: string | null; entry: boolean },
): unknown {
  if (!isListingData(data)) return data;
  const refile = (row: SessionListItem): SessionListItem => ({ ...row, folderId: move.to });
  return {
    ...data,
    pages: data.pages.map((page, i) => {
      const entries = page.entries.flatMap((entry): SessionListingEntry[] => {
        const row = entryRow(entry);
        if (row?.id !== move.id) return [entry];
        if (scope !== move.to) return [];
        return [entry.kind === 'session' ? { ...entry, session: refile(entry.session) } : { ...entry, coordinator: refile(row) }];
      });
      if (i > 0 || scope !== null || !page.folders || !move.entry || move.from === move.to) return { ...page, entries };
      const folders = page.folders.map((folder) =>
        folder.folderId === move.from ? { ...folder, rowCount: Math.max(0, folder.rowCount - 1) }
          : folder.folderId === move.to ? { ...folder, rowCount: folder.rowCount + 1 } : folder);
      // A folder the answer has no row for yet (made since it was read) gets one.
      if (move.to && !folders.some((folder) => folder.folderId === move.to)) {
        folders.push({ folderId: move.to, rowCount: 1, needsYou: 0, running: false, jobs: false });
      }
      return { ...page, entries, folders };
    }),
  };
}

/** Every cached listing, with its key. */
const cachedListings = (qc: QueryClient) =>
  qc.getQueriesData<unknown>({ predicate: (query) => isSessionListingKey(query.queryKey) });

/** `patchListingRows` over every cached listing. */
export function patchListings(qc: QueryClient, patch: (row: SessionListItem) => SessionListItem | null): void {
  for (const [key, data] of cachedListings(qc)) {
    if (isListingData(data)) qc.setQueryData(key, patchListingRows(data, patch));
  }
}

/** `dropListingProject` over every cached listing. */
export function dropProjectFromListings(qc: QueryClient, projectId: string): void {
  for (const [key, data] of cachedListings(qc)) {
    if (isListingData(data)) qc.setQueryData(key, dropListingProject(data, projectId));
  }
}

/** `fileListingEntry` over every cached listing of the workspaces that list the session as an entry. */
export function fileInListings(qc: QueryClient, move: { id: string; from: string | null; to: string | null }): void {
  const listings = cachedListings(qc);
  const workspaces = new Set(listings.flatMap(([key, data]) => isListingData(data) && holdsEntry(data, move.id) ? [key[2]] : []));
  for (const [key, data] of listings) {
    if (!isListingData(data)) continue;
    qc.setQueryData(key, fileListingEntry(data, listingKeyFolder(key), { ...move, entry: workspaces.has(key[2]) }));
  }
}
