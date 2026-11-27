import { useSyncExternalStore } from 'react';
import { api, ApiError, authedFetch } from '../api';
import { sha256Hex } from './sha256';

/**
 * Resumable uploads into the drive (docs/drive-technical-design.md §4.1, board 02-web frame 3): each file is
 * opened with `POST /drive/uploads`, sent as chunks of at most 8 MiB with `PUT /drive/uploads/:id/chunks/:idx`, and
 * completed. What has arrived is asked of the server (`GET /drive/uploads/:id`), never assumed, so an upload goes on
 * from where it stopped: after a dropped connection on its own, and after a reload once the same file is picked again
 * (a page cannot keep a file across a reload; the upload's id and what it was are kept in localStorage).
 *
 * The queue is the app's, not the page's: leaving Files does not stop it, and the tray shows it again on return.
 */

export type UploadStatus = 'queued' | 'uploading' | 'paused' | 'needs-file' | 'failed' | 'done';

export interface DriveUpload {
  key: string;
  name: string;
  size: number;
  lastModified: number;
  /** The folder it was dropped on, and that folder's name for the tray. */
  parentId: string | null;
  parentName: string;
  /** A file of a dropped folder: `Dir/sub/name`. */
  relativePath: string | null;
  /** The drop it came in, so every file of a dropped folder lands under one top folder. */
  dropKey: string | null;
  uploadId: string | null;
  sentBytes: number;
  status: UploadStatus;
  /** Why it stopped, in the server's or the browser's words. */
  error: string | null;
  /** Bytes a second over this run, while uploading. */
  rate: number | null;
  entryId: string | null;
  file: File | null;
}

/** The fields kept across a reload. */
type Kept = Pick<DriveUpload, 'key' | 'name' | 'size' | 'lastModified' | 'parentId' | 'parentName' | 'relativePath' | 'dropKey' | 'uploadId'>;

const STORAGE_KEY = 'orbit:drive-uploads';
const DROPS_KEY = 'orbit:drive-upload-drops';
/** A chunk that fails for want of a connection is tried again this many times, waiting longer each time, before the
 *  upload pauses itself. */
const RETRIES = 3;
const RETRY_BASE_MS = 1000;

let uploads: DriveUpload[] = [];
/** dropKey → the top folder the drop's first file made. */
let drops: Record<string, string> = {};
let completed = 0;
const listeners = new Set<() => void>();
let running: { key: string; abort: AbortController } | null = null;
let loaded = false;
let sequence = 0;
let snapshot: { uploads: DriveUpload[]; completed: number } = { uploads, completed };

const newKey = () => `up-${Date.now().toString(36)}-${(sequence += 1)}`;

function readKept(): void {
  if (loaded) return;
  loaded = true;
  try {
    const kept = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as Kept[];
    drops = JSON.parse(localStorage.getItem(DROPS_KEY) ?? '{}') as Record<string, string>;
    uploads = kept.map((k) => ({
      ...k,
      sentBytes: 0,
      status: 'needs-file',
      error: null,
      rate: null,
      entryId: null,
      file: null,
    }));
  } catch {
    uploads = [];
    drops = {};
  }
  snapshot = { uploads, completed };
}

function keep(): void {
  try {
    const open = uploads.filter((u) => u.status !== 'done');
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        open.map(({ key, name, size, lastModified, parentId, parentName, relativePath, dropKey, uploadId }) => ({
          key, name, size, lastModified, parentId, parentName, relativePath, dropKey, uploadId,
        })),
      ),
    );
    const live = new Set(open.map((u) => u.dropKey).filter(Boolean));
    drops = Object.fromEntries(Object.entries(drops).filter(([key]) => live.has(key)));
    localStorage.setItem(DROPS_KEY, JSON.stringify(drops));
  } catch {
    // Storage full or off: the uploads still run, they only cannot be resumed after a reload.
  }
}

function emit(): void {
  snapshot = { uploads, completed };
  keep();
  for (const listener of listeners) listener();
}

function patch(key: string, change: Partial<DriveUpload>): void {
  uploads = uploads.map((u) => (u.key === key ? { ...u, ...change } : u));
  emit();
}

const find = (key: string) => uploads.find((u) => u.key === key);

/** One file to send: a file picked or dropped, with where it goes. */
export interface UploadRequest {
  file: File;
  parentId: string | null;
  parentName: string;
  relativePath?: string | null;
  dropKey?: string | null;
}

/** Queue files. A file that matches one waiting since a reload resumes that upload rather than starting over. */
export function addUploads(requests: UploadRequest[]): void {
  readKept();
  for (const request of requests) {
    const relativePath = request.relativePath ?? null;
    const waiting = uploads.find(
      (u) =>
        u.status === 'needs-file' &&
        u.name === request.file.name &&
        u.size === request.file.size &&
        u.lastModified === request.file.lastModified &&
        u.parentId === request.parentId &&
        u.relativePath === relativePath,
    );
    if (waiting) {
      uploads = uploads.map((u) => (u.key === waiting.key ? { ...u, file: request.file, status: 'queued', error: null } : u));
      continue;
    }
    uploads = [
      ...uploads,
      {
        key: newKey(),
        name: request.file.name,
        size: request.file.size,
        lastModified: request.file.lastModified,
        parentId: request.parentId,
        parentName: request.parentName,
        relativePath,
        dropKey: request.dropKey ?? null,
        uploadId: null,
        sentBytes: 0,
        status: 'queued',
        error: null,
        rate: null,
        entryId: null,
        file: request.file,
      },
    ];
  }
  emit();
  void pump();
}

/** Resume a paused upload; one waiting since a reload takes the file picked again, if it is the same file. */
export function resumeUpload(key: string, file?: File): string | null {
  readKept();
  const upload = find(key);
  if (!upload) return null;
  if (file) {
    if (file.name !== upload.name || file.size !== upload.size) {
      return `That is not ${upload.name}: pick the same file to go on from where it stopped.`;
    }
    patch(key, { file });
  }
  if (!find(key)!.file) return null;
  patch(key, { status: 'queued', error: null });
  void pump();
  return null;
}

export function pauseUpload(key: string): void {
  if (running?.key === key) running.abort.abort();
  patch(key, { status: 'paused', rate: null });
}

/** Stop and forget an upload; the server drops what it had. */
export function cancelUpload(key: string): void {
  const upload = find(key);
  if (!upload) return;
  if (running?.key === key) running.abort.abort();
  uploads = uploads.filter((u) => u.key !== key);
  emit();
  if (upload.uploadId) void api(`/drive/uploads/${encodeURIComponent(upload.uploadId)}`, { method: 'DELETE' }).catch(() => {});
}

/** Clear the finished rows from the tray. */
export function clearFinishedUploads(): void {
  uploads = uploads.filter((u) => u.status !== 'done');
  emit();
}

/** Every upload, and how many have completed since the page loaded (what the Files page re-reads its folder on). */
export function useDriveUploads(): { uploads: DriveUpload[]; completed: number } {
  readKept();
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}

/** A connection that comes back picks up what it dropped. */
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    let woke = false;
    uploads = uploads.map((u) => {
      if (u.status === 'paused' && u.file && u.error) {
        woke = true;
        return { ...u, status: 'queued', error: null };
      }
      return u;
    });
    if (woke) {
      emit();
      void pump();
    }
  });
}

class Offline extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether a failure is the network's (try again) rather than the server's answer (stop and say it). */
const transient = (error: unknown) =>
  error instanceof TypeError || error instanceof Offline || (error instanceof ApiError && error.status >= 500);

async function pump(): Promise<void> {
  if (running) return;
  const next = uploads.find((u) => u.status === 'queued' && u.file);
  if (!next) return;
  const abort = new AbortController();
  running = { key: next.key, abort };
  try {
    await send(next.key, abort.signal);
  } finally {
    running = null;
  }
  void pump();
}

async function send(key: string, signal: AbortSignal): Promise<void> {
  patch(key, { status: 'uploading', error: null });
  try {
    const answer = await sendOnce(key, signal);
    if (signal.aborted) return;
    completed += 1;
    patch(key, { status: 'done', entryId: answer.id, sentBytes: find(key)!.size, rate: null });
  } catch (error) {
    if (signal.aborted) return;
    const upload = find(key);
    if (!upload) return;
    if (transient(error)) {
      patch(key, {
        status: 'paused',
        rate: null,
        error: 'Connection lost.',
      });
    } else {
      patch(key, { status: 'failed', rate: null, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

async function sendOnce(key: string, signal: AbortSignal): Promise<{ id: string }> {
  let upload = find(key)!;
  const file = upload.file!;
  let arrived: Map<number, number> = new Map();
  let chunkSize = 8 * 1024 * 1024;
  if (upload.uploadId) {
    try {
      const status = await api<{
        chunkSize: number;
        chunks: Array<{ idx: number; sizeBytes: number }>;
        completed: boolean;
        entryId: string | null;
      }>(`/drive/uploads/${encodeURIComponent(upload.uploadId)}`);
      if (status.completed && status.entryId) return { id: status.entryId };
      chunkSize = status.chunkSize;
      arrived = new Map(status.chunks.map((c) => [c.idx, c.sizeBytes]));
    } catch (error) {
      // Gone (abandoned, or swept after a long while): start it again.
      if (!(error instanceof ApiError && error.status === 404)) throw error;
      patch(key, { uploadId: null });
    }
  }
  upload = find(key)!;
  if (!upload.uploadId) {
    const dropRootId = upload.dropKey ? drops[upload.dropKey] : undefined;
    const opened = await api<{ id: string; chunkSize: number; dropRootId: string | null }>('/drive/uploads', {
      method: 'POST',
      body: {
        ...(upload.parentId ? { parentId: upload.parentId } : {}),
        name: upload.name,
        size: upload.size,
        ...(upload.relativePath ? { relativePath: upload.relativePath } : {}),
        ...(dropRootId ? { dropRootId } : {}),
      },
    });
    if (upload.dropKey && opened.dropRootId && !drops[upload.dropKey]) drops = { ...drops, [upload.dropKey]: opened.dropRootId };
    chunkSize = opened.chunkSize;
    patch(key, { uploadId: opened.id });
  }
  const uploadId = find(key)!.uploadId!;
  const count = Math.ceil(file.size / chunkSize);
  const want = (idx: number) => Math.min(chunkSize, file.size - idx * chunkSize);
  let sent = 0;
  for (let idx = 0; idx < count; idx += 1) if (arrived.get(idx) === want(idx)) sent += want(idx);
  patch(key, { sentBytes: sent });
  const started = Date.now();
  let sentThisRun = 0;
  for (let idx = 0; idx < count; idx += 1) {
    if (arrived.get(idx) === want(idx)) continue;
    const chunk = file.slice(idx * chunkSize, idx * chunkSize + want(idx));
    const sha256 = await sha256Hex(await chunk.arrayBuffer());
    for (let attempt = 0; ; attempt += 1) {
      if (signal.aborted) throw new Offline('stopped');
      try {
        const res = await authedFetch(`/api/drive/uploads/${encodeURIComponent(uploadId)}/chunks/${idx}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream', 'x-orbit-chunk-sha256': sha256 },
          body: chunk,
          signal,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { message?: string; code?: string };
          throw new ApiError(body.message ?? res.statusText, res.status, body.code, body);
        }
        break;
      } catch (error) {
        if (signal.aborted || !transient(error) || attempt >= RETRIES) throw error;
        await sleep(RETRY_BASE_MS * 2 ** attempt);
      }
    }
    sent += want(idx);
    sentThisRun += want(idx);
    const seconds = (Date.now() - started) / 1000;
    patch(key, { sentBytes: sent, rate: seconds > 0 ? sentThisRun / seconds : null });
  }
  return api<{ id: string }>(`/drive/uploads/${encodeURIComponent(uploadId)}/complete`, { method: 'POST' });
}

/** For tests: forget every upload and what was kept. */
export function resetDriveUploadsForTest(): void {
  running?.abort.abort();
  running = null;
  uploads = [];
  drops = {};
  completed = 0;
  loaded = false;
  snapshot = { uploads, completed };
}
