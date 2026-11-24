import { useEffect, useState } from 'react';
import { queryOptions } from '@tanstack/react-query';
import { api, ApiError, authedFetch, type ShareLink } from '../api';

/**
 * Orbit Files: the account's drive as the owner's routes answer it (docs/orbit-files-drive-technical-design.md §4.1,
 * apiserver documents/documents.controller.ts). Every read here declares `meta.entities: ['drive']`, so the control plane's
 * `drive.changed` (one write committed) re-reads what the page shows.
 */

/** Who last wrote an entry or a version (§3.6). An agent's session is kept only where the door could check it. */
export interface DocumentsWriter {
  kind: 'OWNER' | 'AGENT' | string;
  sessionId: string | null;
  runnerId: string | null;
}

export interface DocumentsEntry {
  id: string;
  parentId: string | null;
  kind: 'FILE' | 'FOLDER' | string;
  name: string;
  sizeBytes: number;
  mtime: string;
  currentVersionId: string | null;
  seq: number;
  createdAt: string;
  updatedAt: string;
  lastWriter: DocumentsWriter & { at: string };
  trashedAt: string | null;
  trashGroupId: string | null;
  /** On a read of one entry: `/a/b/name` under the drive's root. */
  path?: string;
  /** On a search result: the folder it sits in, `/a/b` (`/` for the top level). */
  folderPath?: string;
}

export interface DocumentsListing {
  folder: DocumentsEntry;
  entries: DocumentsEntry[];
  nextCursor: string | null;
}

export interface DocumentsVersion {
  id: string;
  entryId: string;
  sizeBytes: number;
  chunkCount: number;
  createdAt: string;
  current: boolean;
  writer: DocumentsWriter;
  replacedAt: string | null;
  trashGroupId: string | null;
}

export interface DocumentsTrashGroup {
  id: string;
  kind: 'DELETE' | 'VERSION' | string;
  folderId: string | null;
  folderPath: string;
  createdAt: string;
  itemCount: number;
  sizeBytes: number;
  actor: DocumentsWriter;
  items: DocumentsEntry[];
  version: (DocumentsVersion & { entry: DocumentsEntry }) | null;
}

/** What the share check found (§9): the shape and line of a credential, never the credential itself. */
export interface DocumentsShareWarning {
  kind: string;
  line: number;
}

export interface DocumentsShareCheck {
  versionId: string;
  warnings: DocumentsShareWarning[];
  checkedBytes: number;
  /** Only the start of the file was read: the scan stops at 25 MiB or 20 s. */
  partial: boolean;
}

/** A drive file's link as `GET /share-links?kind=DRIVE_FILE` lists it; `root.pinnedIsCurrent` is false once the file moved on. */
export type DocumentsShareLink = Omit<ShareLink, 'kind' | 'root'> & {
  kind: 'DRIVE_FILE';
  root: { id: string; title: string; pinnedIsCurrent: boolean };
};

export interface DocumentsShareAnswer extends Omit<DocumentsShareCheck, 'versionId'> {
  link: DocumentsShareLink;
}

const enc = encodeURIComponent;

// ── reads ──────────────────────────────────────────────────────────────────────────────────────

/** Every page of a folder (the root when `parentId` is null): a folder is read whole, a thousand names a page. */
export async function listFolder(parentId: string | null): Promise<DocumentsListing> {
  let cursor: string | null = null;
  let listing: DocumentsListing | null = null;
  do {
    const params = new URLSearchParams({ limit: '1000' });
    if (parentId) params.set('parentId', parentId);
    if (cursor) params.set('cursor', cursor);
    const page: DocumentsListing = await api<DocumentsListing>(`/documents/entries?${params}`);
    listing = listing ? { ...page, entries: [...listing.entries, ...page.entries] } : page;
    cursor = page.nextCursor;
  } while (cursor);
  return listing;
}

export const documentsFolderQuery = (parentId: string | null) =>
  queryOptions({
    queryKey: ['drive', 'folder', parentId] as const,
    meta: { entities: ['drive'] },
    queryFn: () => listFolder(parentId),
  });

export interface DocumentsSearchResult {
  entries: DocumentsEntry[];
  nextCursor: string | null;
}

/** Live entries anywhere in the drive whose name contains `q`, each with its path and folder (the first page, by name). */
export const documentsSearchQuery = (q: string) =>
  queryOptions({
    queryKey: ['drive', 'search', q] as const,
    meta: { entities: ['drive'] },
    queryFn: () => api<DocumentsSearchResult>(`/documents/search?${new URLSearchParams({ q, limit: '100' })}`),
  });

/** `value` once it has stood still for `ms`: what a search box asks the server with. */
export function useSettled(value: string, ms = 250): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export const documentsEntryQuery = (id: string | null) =>
  queryOptions({
    queryKey: ['drive', 'entry', id] as const,
    meta: { entities: ['drive'] },
    queryFn: () => api<DocumentsEntry>(`/documents/entries/${enc(id!)}`),
    enabled: id != null,
  });

export const documentsVersionsQuery = (fileId: string | null) =>
  queryOptions({
    queryKey: ['drive', 'versions', fileId] as const,
    meta: { entities: ['drive'] },
    queryFn: () => api<{ entry: DocumentsEntry; versions: DocumentsVersion[] }>(`/documents/entries/${enc(fileId!)}/versions`),
    enabled: fileId != null,
  });

export async function listTrash(): Promise<DocumentsTrashGroup[]> {
  let cursor: string | null = null;
  const groups: DocumentsTrashGroup[] = [];
  do {
    const params = new URLSearchParams({ limit: '200' });
    if (cursor) params.set('cursor', cursor);
    const page: { groups: DocumentsTrashGroup[]; nextCursor: string | null } = await api(`/documents/trash?${params}`);
    groups.push(...page.groups);
    cursor = page.nextCursor;
  } while (cursor);
  return groups;
}

export const documentsTrashQuery = () =>
  queryOptions({ queryKey: ['drive', 'trash'] as const, meta: { entities: ['drive'] }, queryFn: listTrash });

/** The drive files' links, asked for by name: Settings → Shared links does not ask for this kind. */
export const documentsShareLinksQuery = () =>
  queryOptions({
    queryKey: ['drive', 'share-links'] as const,
    meta: { entities: ['drive'] },
    queryFn: async () =>
      (await api<{ links: DocumentsShareLink[] }>('/share-links?kind=DRIVE_FILE')).links.filter(
        (link) => link.kind === 'DRIVE_FILE' && link.state !== 'ENDED',
      ),
  });

// ── writes ─────────────────────────────────────────────────────────────────────────────────────

export const createDocumentsFolder = (parentId: string | null, name: string) =>
  api<DocumentsEntry>('/documents/folders', { method: 'POST', body: { ...(parentId ? { parentId } : {}), name } });

export const renameDocumentsEntry = (id: string, name: string) =>
  api<DocumentsEntry>(`/documents/entries/${enc(id)}`, { method: 'PATCH', body: { name } });

export const moveDocumentsEntry = (id: string, parentId: string) =>
  api<DocumentsEntry>(`/documents/entries/${enc(id)}`, { method: 'PATCH', body: { parentId } });

/** Move to Trash; the group it answers is what Undo restores. */
export const trashDocumentsEntry = (id: string) =>
  api<{ trashGroupId: string }>(`/documents/entries/${enc(id)}`, { method: 'DELETE' });

/** Restore one item of a group (and what hangs under it), leaving the rest in Trash (board frame 6, rule 3). */
export const restoreDocumentsItem = (groupId: string, entryId: string) =>
  api<{ entryIds: string[] }>(`/documents/trash/groups/${enc(groupId)}/items/${enc(entryId)}/restore`, { method: 'POST' });

export const restoreDocumentsGroup = (groupId: string) =>
  api<{ entryIds: string[] }>(`/documents/trash/groups/${enc(groupId)}/restore`, { method: 'POST' });

export const deleteDocumentsGroup = (groupId: string) =>
  api<{ deleted: true }>(`/documents/trash/groups/${enc(groupId)}`, { method: 'DELETE' });

export const emptyDocumentsTrash = () => api<{ deleted: true }>('/documents/trash', { method: 'DELETE' });

export const restoreDocumentsVersion = (versionId: string, as: 'CURRENT' | 'COPY') =>
  api<DocumentsEntry>(`/documents/versions/${enc(versionId)}/restore`, { method: 'POST', body: { as } });

export const checkDocumentsShare = (fileId: string) =>
  api<DocumentsShareCheck>(`/documents/entries/${enc(fileId)}/share-check`, { method: 'POST' });

/** Share the file's current version, or move its link there ("Share this version"). Only the owner's login reaches it. */
export const shareDocumentsFile = (fileId: string) =>
  api<DocumentsShareAnswer>('/share-links', { method: 'POST', body: { kind: 'DRIVE_FILE', driveEntryId: fileId } });

export const stopSharing = (linkId: string) => api<void>(`/share-links/${enc(linkId)}`, { method: 'DELETE' });

/**
 * Download a file (its current version, or `versionId`) as the browser's own download: the server mints a short-lived URL
 * that needs no login header, and the page navigates to it, so the browser streams the bytes to disk with its download
 * manager however large the file is (D12). Nothing is read into the page.
 */
export async function downloadDocumentsFile(fileId: string, versionId?: string): Promise<void> {
  const { path } = await api<{ path: string; expiresAt: string }>(`/documents/entries/${enc(fileId)}/download-link`, {
    method: 'POST',
    body: versionId ? { versionId } : {},
  });
  const a = document.createElement('a');
  a.href = path;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** A file's bytes (or one version's) as a blob, for a preview: `maxBytes` reads only the start. Never a download. */
export async function documentsBlob(path: 'entries' | 'versions', id: string, maxBytes?: number): Promise<Blob> {
  const res = await authedFetch(`/api/documents/${path}/${enc(id)}/content`, {
    headers: maxBytes ? { range: `bytes=0-${maxBytes - 1}` } : {},
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; code?: string };
    throw new ApiError(body.message ?? res.statusText, res.status, body.code, body);
  }
  return res.blob();
}

// ── how a row reads ────────────────────────────────────────────────────────────────────────────

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** "1.2 MB", "18 KB", "212 MB", "3 KB": one decimal under ten, none above. */
export function formatSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  if (unit === 0) return `${value} B`;
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value)} ${UNITS[unit]}`;
}

/** "14:02" today, "Yesterday", "Nov 16" this year, "Nov 16, 2025" before. */
export function formatWhen(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days === 0) return at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  return at.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

const extension = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

const PICTURES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

/** The picture type a name says, for the preview; the store answers every file as bytes. */
export const pictureType = (name: string): string | null => PICTURES[extension(name)] ?? null;

export const isMarkdown = (name: string): boolean => ['md', 'markdown'].includes(extension(name));

/** A Markdown preview reads at most this much of the file. */
export const MARKDOWN_PREVIEW_BYTES = 1024 * 1024;

/** A picture preview is read whole up to this size; a bigger one is downloaded rather than drawn. */
export const PICTURE_PREVIEW_BYTES = 30 * 1024 * 1024;

/**
 * Whether "Delete for good" on a group ends a file's link with it (§9). A shared file in Trash has a paused link, and
 * `trashGroupOf` says which group each such file went in (a file deep in a deleted folder is not one of its top items).
 */
export function groupEndsALink(
  group: DocumentsTrashGroup,
  links: readonly DocumentsShareLink[],
  trashGroupOf: ReadonlyMap<string, string | null>,
): boolean {
  if (group.version) {
    // A replaced version can be the one a link is pinned to only when the link no longer pins the current one.
    return links.some((link) => link.root.id === group.version!.entryId && !link.root.pinnedIsCurrent);
  }
  return links.some(
    (link) => trashGroupOf.get(link.root.id) === group.id || group.items.some((item) => item.id === link.root.id),
  );
}

/** The words a refusal is shown with: the server's own sentence. */
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
