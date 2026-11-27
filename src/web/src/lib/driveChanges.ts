/**
 * What a Drive chat changed and asked, on the web (board docs/mocks/drive-chat/01-board.html ③ ④, owner Q2 A and Q4 A):
 * the change groups and overwrite questions the server keeps per chat, the words of their cards, the marks they leave on
 * the list, the round button's count and the rule for where file details stand while the chat is open.
 */
import { queryOptions } from '@tanstack/react-query';
import type {
  DriveChatChangeGroup,
  DriveChatChangeItem,
  DriveChatHeldItem,
  DriveChatQuestion,
  DriveChatQuestionFile,
} from '@orbit/shared';
import { api } from '../api';
import { formatSize, formatWhen } from './drive';

// ── The words ───────────────────────────────────────────────────────────────────────────────────

export const DRIVE_CHANGES_TITLE = 'Drive changes';
export const DRIVE_CHANGES_NEEDS_YOU = 'Needs you';
export const DRIVE_CHANGES_UNDONE = 'Undone';
export const DRIVE_CHANGES_APPLYING = 'Applying…';
export const DRIVE_CHANGES_UNDOING = 'Undoing…';
export const DRIVE_CHANGES_SHOW_ALL = 'Show all';
export const DRIVE_CHANGES_SHOW_LESS = 'Show less';
export const DRIVE_CHANGES_UNDO = 'Undo';
export const DRIVE_CHANGES_APPLY = 'Apply';
export const DRIVE_REPLACE_TITLE = 'Replace a file?';
export const DRIVE_REPLACE_KEEP_BOTH = 'Keep both';
export const DRIVE_REPLACE_REPLACE = 'Replace';

/** How many items a card lists before "and N more". */
export const DRIVE_CHANGES_PREVIEW = 4;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export const driveChangesDone = (n: number): string => `Done · ${plural(n, 'change', 'changes')}`;
export const driveChangesPending = (n: number): string => `${plural(n, 'change', 'changes')} waiting for Apply`;
export const driveChangesMore = (n: number): string => `and ${n} more`;
export const driveChangesSkipped = (n: number): string => `${n} left as ${n === 1 ? 'it is' : 'they are'}`;

/** The chip of a selection in the composer: `12 files`; one name when there is one. */
export const driveSelectionLabel = (names: readonly string[]): string =>
  names.length === 1 ? names[0]! : plural(names.length, 'file', 'files');

// ── The reads ───────────────────────────────────────────────────────────────────────────────────

export const driveChatGroupsQuery = (sessionId: string, working = false) =>
  queryOptions({
    queryKey: ['drive', 'chats', sessionId, 'groups'] as const,
    meta: { entities: ['drive'] },
    queryFn: async () => (await api<{ groups: DriveChatChangeGroup[] }>(`/drive/chats/${sessionId}/groups`)).groups,
    staleTime: 5_000,
    refetchInterval: working ? 5_000 : false,
  });

export const driveChatQuestionsQuery = (sessionId: string, working = false) =>
  queryOptions({
    queryKey: ['drive', 'chats', sessionId, 'questions'] as const,
    meta: { entities: ['drive'] },
    queryFn: async () => (await api<{ questions: DriveChatQuestion[] }>(`/drive/chats/${sessionId}/questions`)).questions,
    staleTime: 5_000,
    refetchInterval: working ? 5_000 : false,
  });

export const undoDriveChatGroup = (sessionId: string, groupId: string) =>
  api<DriveChatChangeGroup>(`/drive/chats/${sessionId}/groups/${groupId}/undo`, { method: 'POST' });

export const applyDriveChatGroup = (sessionId: string, groupId: string) =>
  api<DriveChatChangeGroup>(`/drive/chats/${sessionId}/groups/${groupId}/apply`, { method: 'POST' });

export const answerDriveChatQuestion = (sessionId: string, questionId: string, choice: 'KEEP_BOTH' | 'REPLACE') =>
  api<DriveChatQuestion>(`/drive/chats/${sessionId}/questions/${questionId}`, { method: 'POST', body: { choice } });

// ── The cards ───────────────────────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<string, string> = {
  NEW_FOLDER: 'New folder',
  NEW_FILE: 'New file',
  MOVE: 'Moved',
  RENAME: 'Renamed',
  TRASH: 'To Trash',
  EDIT: 'Edited',
};

export interface DriveChangeLine {
  id: string;
  /** New folder, Moved, Renamed, To Trash. */
  kind: string;
  /** What it was done to: a name, or `old → new`, or `name → folder`. */
  detail: string;
}

const placeName = (place: { name: string | null }): string => place.name ?? '';

function itemLine(item: DriveChatChangeItem): DriveChangeLine {
  const kind = KIND_LABEL[item.kind] ?? item.kind;
  if (item.kind === 'RENAME') return { id: item.id, kind, detail: `${placeName(item.before)} → ${placeName(item.after)}` };
  if (item.kind === 'MOVE') {
    return { id: item.id, kind, detail: `${placeName(item.after)} → ${item.after.parentPath ?? 'Drive'}` };
  }
  if (item.kind === 'TRASH') return { id: item.id, kind, detail: placeName(item.before) };
  return { id: item.id, kind, detail: placeName(item.after) };
}

function heldLine(item: DriveChatHeldItem): DriveChangeLine {
  const kind = KIND_LABEL[item.kind] ?? item.kind;
  if (item.kind === 'MOVE' || item.kind === 'RENAME') return { id: item.id, kind, detail: `${item.fromPath ?? item.name} → ${item.toPath ?? ''}` };
  return { id: item.id, kind, detail: item.name };
}

/** What a group's card lists: what was made, or for a group held for Apply what is held. */
export function driveGroupLines(group: DriveChatChangeGroup): DriveChangeLine[] {
  return group.status === 'PENDING' ? group.heldItems.map(heldLine) : group.items.map(itemLine);
}

/** A group that waits for the owner's Apply. */
export const driveGroupNeedsYou = (group: DriveChatChangeGroup): boolean => group.status === 'PENDING';

/** A question the owner has yet to answer. */
export const driveQuestionNeedsYou = (question: DriveChatQuestion): boolean =>
  question.status === 'OPEN' || question.status === 'ANSWERING';

/** One side of an overwrite card: `/Receipts/may.pdf`, `1.2 MB`, who last wrote it, when. */
export function driveQuestionFacts(file: DriveChatQuestionFile): { path: string; size: string; writer: string; when: string } {
  const { kind, sessionTitle } = file.lastWriter;
  const writer = kind === 'OWNER' ? 'You' : sessionTitle ? `Agent in ${sessionTitle}` : kind === 'AGENT' ? 'An agent' : 'Another machine';
  return { path: file.path, size: formatSize(file.sizeBytes), writer, when: formatWhen(file.modifiedAt) };
}

// ── The round button ────────────────────────────────────────────────────────────────────────────

/** What waits on the owner beyond the approvals the chats list counts: held groups and open questions. */
export function driveChangesNeedYou(groups: readonly DriveChatChangeGroup[], questions: readonly DriveChatQuestion[]): number {
  return groups.filter(driveGroupNeedsYou).length + questions.filter(driveQuestionNeedsYou).length;
}

// ── The marks ───────────────────────────────────────────────────────────────────────────────────

export type DriveMark = 'New' | 'Moved' | 'Renamed';

const MARK_OF: Partial<Record<string, DriveMark>> = { NEW_FOLDER: 'New', NEW_FILE: 'New', MOVE: 'Moved', RENAME: 'Renamed' };

/**
 * The rows a Drive chat's groups left marked, entry id → mark: created, moved in or renamed by a group that is made
 * (not held, not undone), by an item that stood. A row a later item of the same entry changed again shows the latest.
 */
export function driveMarks(groups: readonly DriveChatChangeGroup[]): Map<string, { mark: DriveMark; key: string }> {
  const marks = new Map<string, { mark: DriveMark; key: string }>();
  const ordered = [...groups].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  for (const group of ordered) {
    if (group.status !== 'DONE') continue;
    for (const item of group.items) {
      const mark = MARK_OF[item.kind];
      if (mark && item.state === 'DONE') marks.set(item.entryId, { mark, key: `${item.id}` });
    }
  }
  return marks;
}

const SEEN_KEY = 'orbit.driveChat.seen';

/** The marks the owner opened, kept on the device per account: an item id each. */
export function readSeenMarks(scope: string | null): ReadonlySet<string> {
  if (!scope || typeof localStorage === 'undefined') return new Set();
  try {
    const raw = JSON.parse(localStorage.getItem(`${SEEN_KEY}.${scope}`) ?? '[]') as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

export function writeSeenMark(scope: string | null, key: string): void {
  if (!scope || typeof localStorage === 'undefined') return;
  const seen = new Set(readSeenMarks(scope));
  seen.add(key);
  localStorage.setItem(`${SEEN_KEY}.${scope}`, JSON.stringify([...seen].slice(-500)));
}

// ── The details ─────────────────────────────────────────────────────────────────────────────────

/** The window width from which file details stand beside the list even while the chat is open (board ④ ⑤). */
export const DRIVE_DETAILS_BESIDE_WIDTH = 1760;

/** Details overlay the list while the chat panel is open and the window is narrower than 1760; else they are a column. */
export const driveDetailsOverlay = (chatOpen: boolean, windowWidth: number): boolean =>
  chatOpen && windowWidth < DRIVE_DETAILS_BESIDE_WIDTH;
