import { useEffect, useState } from 'react';
import { queryOptions } from '@tanstack/react-query';
import { api, ApiError, authedFetch, type ShareLink } from '../api';

/**
 * Drive: the account's drive as the owner's routes answer it (docs/drive-technical-design.md §4.1,
 * apiserver drive/drive.controller.ts). Every read here declares `meta.entities: ['drive']`, so the control plane's
 * `drive.changed` (one write committed) re-reads what the page shows.
 */

/** Who last wrote an entry or a version (§3.6). An agent's session is kept only where the door could check it. */
export interface DriveWriter {
  kind: 'OWNER' | 'AGENT' | string;
  sessionId: string | null;
  runnerId: string | null;
}

export interface DriveEntry {
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
  lastWriter: DriveWriter & { at: string };
  trashedAt: string | null;
  trashGroupId: string | null;
  /** On a read of one entry: `/a/b/name` under the drive's root. */
  path?: string;
  /** On a search result: the folder it sits in, `/a/b` (`/` for the top level). */
  folderPath?: string;
}

export interface DriveListing {
  folder: DriveEntry;
  entries: DriveEntry[];
  nextCursor: string | null;
}

export interface DriveVersion {
  id: string;
  entryId: string;
  sizeBytes: number;
  chunkCount: number;
  createdAt: string;
  current: boolean;
  writer: DriveWriter;
  replacedAt: string | null;
  trashGroupId: string | null;
}

export interface DriveTrashGroup {
  id: string;
  kind: 'DELETE' | 'VERSION' | string;
  folderId: string | null;
  folderPath: string;
  createdAt: string;
  itemCount: number;
  sizeBytes: number;
  actor: DriveWriter;
  items: DriveEntry[];
  version: (DriveVersion & { entry: DriveEntry }) | null;
}

/** What the share check found (§9): the shape and line of a credential, never the credential itself. */
export interface DriveShareWarning {
  kind: string;
  line: number;
}

export interface DriveShareCheck {
  versionId: string;
  warnings: DriveShareWarning[];
  checkedBytes: number;
  /** Only the start of the file was read: the scan stops at 25 MiB or 20 s. */
  partial: boolean;
}

/** A drive file's link as `GET /share-links?kind=DRIVE_FILE` lists it; `root.pinnedIsCurrent` is false once the file moved on. */
export type DriveShareLink = Omit<ShareLink, 'kind' | 'root'> & {
  kind: 'DRIVE_FILE';
  root: { id: string; title: string; pinnedIsCurrent: boolean };
};

export interface DriveShareAnswer extends Omit<DriveShareCheck, 'versionId'> {
  link: DriveShareLink;
}

const enc = encodeURIComponent;

// ── reads ──────────────────────────────────────────────────────────────────────────────────────

/** Every page of a folder (the root when `parentId` is null): a folder is read whole, a thousand names a page. */
export async function listFolder(parentId: string | null): Promise<DriveListing> {
  let cursor: string | null = null;
  let listing: DriveListing | null = null;
  do {
    const params = new URLSearchParams({ limit: '1000' });
    if (parentId) params.set('parentId', parentId);
    if (cursor) params.set('cursor', cursor);
    const page: DriveListing = await api<DriveListing>(`/drive/entries?${params}`);
    listing = listing ? { ...page, entries: [...listing.entries, ...page.entries] } : page;
    cursor = page.nextCursor;
  } while (cursor);
  return listing;
}

export const driveFolderQuery = (parentId: string | null) =>
  queryOptions({
    queryKey: ['drive', 'folder', parentId] as const,
    meta: { entities: ['drive'] },
    queryFn: () => listFolder(parentId),
  });

export interface DriveSearchResult {
  entries: DriveEntry[];
  nextCursor: string | null;
}

/** Live entries anywhere in the drive whose name contains `q`, each with its path and folder (the first page, by name). */
export const driveSearchQuery = (q: string) =>
  queryOptions({
    queryKey: ['drive', 'search', q] as const,
    meta: { entities: ['drive'] },
    queryFn: () => api<DriveSearchResult>(`/drive/search?${new URLSearchParams({ q, limit: '100' })}`),
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

export const driveEntryQuery = (id: string | null) =>
  queryOptions({
    queryKey: ['drive', 'entry', id] as const,
    meta: { entities: ['drive'] },
    queryFn: () => api<DriveEntry>(`/drive/entries/${enc(id!)}`),
    enabled: id != null,
  });

export const driveVersionsQuery = (fileId: string | null) =>
  queryOptions({
    queryKey: ['drive', 'versions', fileId] as const,
    meta: { entities: ['drive'] },
    queryFn: () => api<{ entry: DriveEntry; versions: DriveVersion[] }>(`/drive/entries/${enc(fileId!)}/versions`),
    enabled: fileId != null,
  });

export async function listTrash(): Promise<DriveTrashGroup[]> {
  let cursor: string | null = null;
  const groups: DriveTrashGroup[] = [];
  do {
    const params = new URLSearchParams({ limit: '200' });
    if (cursor) params.set('cursor', cursor);
    const page: { groups: DriveTrashGroup[]; nextCursor: string | null } = await api(`/drive/trash?${params}`);
    groups.push(...page.groups);
    cursor = page.nextCursor;
  } while (cursor);
  return groups;
}

export const driveTrashQuery = () =>
  queryOptions({ queryKey: ['drive', 'trash'] as const, meta: { entities: ['drive'] }, queryFn: listTrash });

/** The drive files' links, asked for by name: Settings → Shared links does not ask for this kind. */
export const driveShareLinksQuery = () =>
  queryOptions({
    queryKey: ['drive', 'share-links'] as const,
    meta: { entities: ['drive'] },
    queryFn: async () =>
      (await api<{ links: DriveShareLink[] }>('/share-links?kind=DRIVE_FILE')).links.filter(
        (link) => link.kind === 'DRIVE_FILE' && link.state !== 'ENDED',
      ),
  });

// ── writes ─────────────────────────────────────────────────────────────────────────────────────

export const createDriveFolder = (parentId: string | null, name: string) =>
  api<DriveEntry>('/drive/folders', { method: 'POST', body: { ...(parentId ? { parentId } : {}), name } });

export const renameDriveEntry = (id: string, name: string) =>
  api<DriveEntry>(`/drive/entries/${enc(id)}`, { method: 'PATCH', body: { name } });

export const moveDriveEntry = (id: string, parentId: string) =>
  api<DriveEntry>(`/drive/entries/${enc(id)}`, { method: 'PATCH', body: { parentId } });

/** Move to Trash; the group it answers is what Undo restores. */
export const trashDriveEntry = (id: string) =>
  api<{ trashGroupId: string }>(`/drive/entries/${enc(id)}`, { method: 'DELETE' });

/** Restore one item of a group (and what hangs under it), leaving the rest in Trash (board frame 6, rule 3). */
export const restoreDriveItem = (groupId: string, entryId: string) =>
  api<{ entryIds: string[] }>(`/drive/trash/groups/${enc(groupId)}/items/${enc(entryId)}/restore`, { method: 'POST' });

export const restoreDriveGroup = (groupId: string) =>
  api<{ entryIds: string[] }>(`/drive/trash/groups/${enc(groupId)}/restore`, { method: 'POST' });

export const deleteDriveGroup = (groupId: string) =>
  api<{ deleted: true }>(`/drive/trash/groups/${enc(groupId)}`, { method: 'DELETE' });

export const emptyDriveTrash = () => api<{ deleted: true }>('/drive/trash', { method: 'DELETE' });

export const restoreDriveVersion = (versionId: string, as: 'CURRENT' | 'COPY') =>
  api<DriveEntry>(`/drive/versions/${enc(versionId)}/restore`, { method: 'POST', body: { as } });

export const checkDriveShare = (fileId: string) =>
  api<DriveShareCheck>(`/drive/entries/${enc(fileId)}/share-check`, { method: 'POST' });

/** Share the file's current version, or move its link there ("Share this version"). Only the owner's login reaches it. */
export const shareDriveFile = (fileId: string) =>
  api<DriveShareAnswer>('/share-links', { method: 'POST', body: { kind: 'DRIVE_FILE', driveEntryId: fileId } });

export const stopSharing = (linkId: string) => api<void>(`/share-links/${enc(linkId)}`, { method: 'DELETE' });

/**
 * Download a file (its current version, or `versionId`) as the browser's own download: the server mints a short-lived URL
 * that needs no login header, and the page navigates to it, so the browser streams the bytes to disk with its download
 * manager however large the file is (D12). Nothing is read into the page.
 */
export async function downloadDriveFile(fileId: string, versionId?: string): Promise<void> {
  const { path } = await api<{ path: string; expiresAt: string }>(`/drive/entries/${enc(fileId)}/download-link`, {
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
export async function driveBlob(path: 'entries' | 'versions', id: string, maxBytes?: number): Promise<Blob> {
  const res = await authedFetch(`/api/drive/${path}/${enc(id)}/content`, {
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

const TEXT = new Set(
  (
    'txt text log csv tsv json jsonl ndjson yaml yml toml ini cfg conf env properties xml sql sh bash zsh ps1 ' +
    'py rb go rs ts tsx js jsx mjs cjs css scss less swift kt kts java c h cc cpp hpp cs php lua r pl ' +
    'diff patch gitignore dockerfile makefile graphql proto tex rst srt vtt'
  ).split(' '),
);

/** Plain text or code, shown as it is written. */
export const isText = (name: string): boolean => TEXT.has(extension(name)) || TEXT.has(name.toLowerCase());

/** A web page, drawn in a frame that runs nothing it carries. */
export const isHtml = (name: string): boolean => ['html', 'htm'].includes(extension(name));

export const isPdf = (name: string): boolean => extension(name) === 'pdf';

/** A Markdown, text, code or HTML preview reads at most this much of the file. */
export const TEXT_PREVIEW_BYTES = 1024 * 1024;

/** A picture preview is read whole up to this size; a bigger one is downloaded rather than drawn. */
export const PICTURE_PREVIEW_BYTES = 30 * 1024 * 1024;

/** A PDF preview is read whole up to this size, like a picture. */
export const PDF_PREVIEW_BYTES = PICTURE_PREVIEW_BYTES;

/**
 * Whether "Delete for good" on a group ends a file's link with it (§9). A shared file in Trash has a paused link, and
 * `trashGroupOf` says which group each such file went in (a file deep in a deleted folder is not one of its top items).
 */
export function groupEndsALink(
  group: DriveTrashGroup,
  links: readonly DriveShareLink[],
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
