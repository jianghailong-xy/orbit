import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from '../api';

/**
 * An agent's directory syncs into Drive (docs/drive-directory-sync-design.md, S4): `GET /drive/syncs` is the
 * running ones, those that ended in the last 24 h and failed ones nobody has handled yet. The store reads it when the page
 * opens, when the control plane hears `drive.sync`, on focus and after a reconnect, and every 5 s while one is running and
 * the page is visible. "Clear finished" only hides ended syncs on this browser (their ids are kept in localStorage).
 */

export type DriveSyncStatus = 'CHECKING' | 'UPLOADING' | 'DONE' | 'FAILED' | 'STOPPED';

export interface DriveSyncView {
  id: string;
  status: DriveSyncStatus;
  sourceName: string;
  destPath: string;
  destEntryId: string | null;
  /** The session that ran it; `open` while it can take a turn. */
  session: { id: string; title: string; open: boolean } | null;
  filesSeen: number;
  filesTotal: number | null;
  filesDone: number;
  filesSame: number;
  filesDeleted: number;
  bytesTotal: number | null;
  bytesSent: number;
  currentPath: string | null;
  failed: { path: string; error: string }[];
  failedCount: number;
  error: string | null;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  /** When the failures stopped needing the owner; null while they do (or there were none). */
  handledAt: string | null;
  /** The session the failures were handed to, and when. */
  fixSessionId: string | null;
  fixRequestedAt: string | null;
  /** Where that session stands: working on it, or stopped (with what it asks the owner, if anything). Null with no hand-off. */
  fix: { title: string | null; working: boolean; question: string | null } | null;
}

/** A sync as the tray draws it: the server's view and the bytes a second between the last two reads. */
export interface DriveSync extends DriveSyncView {
  rate: number | null;
}

export const syncRunning = (sync: Pick<DriveSyncView, 'status'>): boolean =>
  sync.status === 'CHECKING' || sync.status === 'UPLOADING';

/** A sync whose failures an agent is working on: read again while it does, since its session's end sends no drive.sync. */
const fixWorking = (sync: Pick<DriveSyncView, 'fix'>): boolean => sync.fix?.working === true;

const DISMISSED_KEY = 'orbit:documents-syncs-dismissed';
const POLL_MS = 5000;

let syncs: DriveSync[] = [];
let dismissed = new Set<string>();
let loadedDismissed = false;
const listeners = new Set<() => void>();
let snapshot: DriveSync[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let reading = false;
let readAgain = false;
/** Whether a read of the list has answered, and how many times: what useDriveSync waits on before it reads by id. */
let listRead = false;
let listReads = 0;

function readDismissed(): void {
  if (loadedDismissed) return;
  loadedDismissed = true;
  try {
    dismissed = new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]') as string[]);
  } catch {
    dismissed = new Set();
  }
}

function publish(): void {
  readDismissed();
  snapshot = syncs.filter((sync) => syncRunning(sync) || !dismissed.has(sync.id));
  for (const listener of listeners) listener();
}

/**
 * Read the syncs again. A call while a read is in flight is not dropped: it asks for one more read when that one ends,
 * so the event announcing a sync's end is never answered by the read that started before it.
 */
export async function refreshDriveSyncs(): Promise<void> {
  if (reading) {
    readAgain = true;
    return;
  }
  reading = true;
  try {
    const { syncs: read } = await api<{ syncs: DriveSyncView[] }>('/drive/syncs');
    const before = new Map(syncs.map((sync) => [sync.id, sync]));
    syncs = read.map((sync) => {
      const was = before.get(sync.id);
      const seconds = was ? (Date.parse(sync.updatedAt) - Date.parse(was.updatedAt)) / 1000 : 0;
      const rate = was && seconds > 0 && sync.bytesSent > was.bytesSent ? (sync.bytesSent - was.bytesSent) / seconds : null;
      // Between two reads that moved nothing, the last rate still stands.
      return { ...sync, rate: syncRunning(sync) ? (rate ?? (was && seconds <= 0 ? was.rate : null)) : null };
    });
    listRead = true;
    listReads += 1;
    publish();
  } catch {
    // The next event, focus or poll reads again.
  } finally {
    reading = false;
    if (readAgain) {
      readAgain = false;
      void refreshDriveSyncs();
    }
  }
}

/**
 * Put one sync's view in place of the one held, until the next read: the activity view's optimistic hand-off, and the
 * server's answer to it. A sync not held is left alone.
 */
export function replaceDriveSync(view: DriveSyncView): void {
  if (!syncs.some((sync) => sync.id === view.id)) return;
  syncs = syncs.map((sync) => (sync.id === view.id ? { ...view, rate: sync.rate } : sync));
  publish();
}

/** Hide the ended syncs from the tray. */
export function clearFinishedSyncs(): void {
  readDismissed();
  for (const sync of syncs) if (!syncRunning(sync)) dismissed.add(sync.id);
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissed]));
  } catch {
    // Not kept across a reload.
  }
  publish();
}

const onFocus = (): void => {
  if (document.visibilityState !== 'hidden') void refreshDriveSyncs();
};

function start(): void {
  void refreshDriveSyncs();
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onFocus);
  timer = setInterval(() => {
    if (document.visibilityState !== 'hidden' && syncs.some((sync) => syncRunning(sync) || fixWorking(sync))) void refreshDriveSyncs();
  }, POLL_MS);
}

function stop(): void {
  window.removeEventListener('focus', onFocus);
  document.removeEventListener('visibilitychange', onFocus);
  if (timer) clearInterval(timer);
  timer = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

export function useDriveSyncs(): DriveSync[] {
  return useSyncExternalStore(subscribe, () => snapshot);
}

/** For tests: forget everything held in memory. */
export function resetDriveSyncs(): void {
  stop();
  syncs = [];
  snapshot = [];
  dismissed = new Set();
  loadedDismissed = false;
  reading = false;
  readAgain = false;
  listRead = false;
  listReads = 0;
}

/**
 * One sync, for the conversation's card at the call that started it (board docs/mocks/drive-sync-card): read from
 * the tray's list, which `drive.sync` keeps current, whether or not the tray cleared it; a sync too old for that list
 * (ended over a day ago) is read once by id. Null until it is known, and when it cannot be read.
 */
export function useDriveSync(id: string): DriveSync | null {
  const listed = useSyncExternalStore(subscribe, () => syncs).find((sync) => sync.id === id) ?? null;
  const [read, setRead] = useState<DriveSync | null>(null);
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (listed || tried) return;
    // The list is read as the store starts; only once it has answered without this sync is it read by id.
    if (!listRead) return;
    let gone = false;
    setTried(true);
    api<DriveSyncView>(`/drive/syncs/${encodeURIComponent(id)}`)
      .then((sync) => !gone && setRead({ ...sync, rate: null }))
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [id, listed, tried, listReads]);
  return listed ?? read;
}

/**
 * Whether an MCP tool name is the tool an agent starts a sync with: drive_sync, or documents_sync, its name while Drive
 * was called Drive, which stored transcripts and runners already deployed carry.
 */
export const isDriveSyncTool = (name: string): boolean =>
  name === 'mcp__orbit__drive_sync' || name === 'mcp__orbit__documents_sync';

/**
 * The sync a drive_sync call's answer names, or null for one that names none (a runner from before the card). A
 * runner that answers with a receipt puts the call's own answer under `entity`, and a refused receipt names nothing.
 */
export function driveSyncIdOf(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed.receiptVersion !== undefined && parsed.ok === false) return null;
    const answer =
      parsed.receiptVersion !== undefined && parsed.entity && typeof parsed.entity === 'object'
        ? (parsed.entity as Record<string, unknown>)
        : parsed;
    return typeof answer.syncId === 'string' && answer.syncId ? answer.syncId : null;
  } catch {
    return null;
  }
}
