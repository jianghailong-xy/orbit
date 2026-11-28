/**
 * The Drive chat panel's activity view (board drive-web 01 ⑤): what waits on the owner, what agents are fixing, what
 * is running, and each day's work by session. The day groups are `GET /drive/activity` (apiserver drive-activity.ts).
 */
import { infiniteQueryOptions } from '@tanstack/react-query';
import type { DriveActivityGroup, DriveActivityLine, DriveActivityPage } from '@orbit/shared';
import { api } from '../api';
import { formatSize } from './drive';
import { syncRunning, type DriveSync, type DriveSyncView } from './driveSyncs';

export const DRIVE_ACTIVITY_TITLE = 'Activity';
export const DRIVE_ACTIVITY_OPEN = 'Show activity';
export const DRIVE_ACTIVITY_CLOSE = 'Back to chat';
export const DRIVE_ACTIVITY_EMPTY = 'Nothing has happened in your Drive yet.';

/** The panel's view, kept per browser: the chat or the activity log. */
export type DrivePanelView = 'chat' | 'activity';
const VIEW_KEY = 'orbit:drive-panel-view';

export function readDrivePanelView(): DrivePanelView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'activity' ? 'activity' : 'chat';
  } catch {
    return 'chat';
  }
}

export function writeDrivePanelView(view: DrivePanelView): void {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // Not remembered.
  }
}

export const driveActivityQuery = () =>
  infiniteQueryOptions({
    queryKey: ['drive', 'activity'] as const,
    meta: { entities: ['drive'] },
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) params.set('tz', tz);
      if (pageParam) params.set('before', pageParam);
      const query = params.toString();
      return api<DriveActivityPage>(`/drive/activity${query ? `?${query}` : ''}`);
    },
    getNextPageParam: (page) => page.nextBefore ?? undefined,
    staleTime: 5_000,
  });

export const markDriveSyncHandled = (id: string) =>
  api<DriveSync>(`/drive/syncs/${encodeURIComponent(id)}/handled`, { method: 'POST' });

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const folderName = (path: string | null): string => {
  if (path === null) return 'a folder since deleted';
  const name = path.split('/').filter(Boolean).pop();
  return name ?? 'Drive';
};

const OP_WORD: Record<DriveActivityLine['op'], string> = {
  WROTE: 'Wrote',
  DELETED: 'Deleted',
  MOVED: 'Moved',
  RENAMED: 'Renamed',
  SYNCED: 'Synced',
};

/** `Renamed 12 files in Books`, `Wrote 3 files in scratch · 48 KB`. */
export function driveActivityLineText(line: DriveActivityLine): string {
  const text = `${OP_WORD[line.op]} ${plural(line.count, 'file', 'files')} in ${folderName(line.folderPath)}`;
  return line.bytes ? `${text} · ${formatSize(line.bytes)}` : text;
}

/** The button a line offers: Restore for a Trash group, Undo for a chat's change group. */
export const driveActivityUndoLabel = (line: DriveActivityLine): string | null =>
  line.undo ? (line.undo.kind === 'TRASH_GROUP' ? 'Restore' : 'Undo') : null;

/** The groups of one day, headed by its label: Today, Yesterday, then `Nov 16`. */
export interface DriveActivityDay {
  key: string;
  label: string;
  groups: DriveActivityGroup[];
}

const dayKey = (at: Date): string => `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;

export function driveActivityDays(groups: readonly DriveActivityGroup[], now = new Date()): DriveActivityDay[] {
  const days: DriveActivityDay[] = [];
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  for (const group of groups) {
    // Lines held for Apply are in Needs you; a group of nothing else has nothing to show here.
    const lines = group.lines.filter((line) => !line.held);
    if (!lines.length) continue;
    const at = new Date(group.at);
    const key = dayKey(at);
    let day = days.find((d) => d.key === key);
    if (!day) {
      const label =
        key === dayKey(now)
          ? 'Today'
          : key === dayKey(yesterday)
            ? 'Yesterday'
            : at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
      day = { key, label, groups: [] };
      days.push(day);
    }
    day.groups.push({ ...group, lines });
  }
  return days;
}

const syncFailed = (sync: DriveSyncView): boolean =>
  (sync.status === 'FAILED' || sync.failedCount > 0) && !syncRunning(sync) && sync.handledAt === null;

/**
 * A sync that needs the owner: it ended failed, or with failed files, nobody has handled it, and no agent is working on
 * it — never handed to one, or handed back (the agent asked something, or stopped without a clean sync).
 */
export const syncNeedsYou = (sync: DriveSyncView): boolean => syncFailed(sync) && sync.fix?.working !== true;

/** A failure handed to an agent whose session is still working on it. */
export const syncAgentWorking = (sync: DriveSyncView): boolean => syncFailed(sync) && sync.fix?.working === true;

export const DRIVE_SYNC_FIX = 'Have the agent fix it';
export const DRIVE_SYNC_FIX_NEW_CHAT = 'Fix in a new chat';

/** The hand-off button: to the session that ran the sync while it can take a turn, else to a new Drive chat. */
export const driveSyncFixLabel = (sync: DriveSyncView): string => (sync.session?.open ? DRIVE_SYNC_FIX : DRIVE_SYNC_FIX_NEW_CHAT);

/** What `POST /drive/syncs/:id/fix` answers: where the failures went, and the sync as it reads now. */
export interface DriveSyncFixAnswer {
  via: 'SESSION' | 'NEW_CHAT';
  sessionId: string;
  sync: DriveSyncView;
}

/** Hand a sync's failures to an agent; `retry` asks it to sync the failed files again and nothing more. */
export const fixDriveSync = (id: string, mode: 'fix' | 'retry' = 'fix') =>
  api<DriveSyncFixAnswer>(`/drive/syncs/${encodeURIComponent(id)}/fix`, { method: 'POST', body: { mode } });

/** The sync as it reads the moment it is handed off, before the server answers: under Agents working on it. */
export const driveSyncHandedOff = (sync: DriveSyncView): DriveSyncView => ({
  ...sync,
  fixSessionId: sync.session?.open ? sync.session.id : null,
  fixRequestedAt: new Date().toISOString(),
  fix: { title: sync.session?.open ? sync.session.title : null, working: true, question: null },
});
