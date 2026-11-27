import { SCHEDULE_PAGE_CHAT_COPY } from './schedule';
import { WIKI_CHAT_COPY } from './wikiChat';

/**
 * The Drive chat (project "Drive chat: manage files by talking to an agent", board docs/mocks/drive-chat/01-board.html):
 * a chat docked on Drive, an ordinary session opened by `POST /api/drive/chats` (apiserver drive/drive-chat.ts), the
 * same kind as the Wiki chat. Its words, its list's page and order, and the `<orbit_drive_chat>` note its delivery
 * appends (drive/drive-chat-notes.ts) are here, so the server and the clients read one copy.
 */

/** The numbers the chat is held to. */
export const DRIVE_CHAT_RULES = {
  /** Chats on one page of `GET /api/drive/chats`, as the Wiki chat's history lists them. */
  chatsListed: 50,
  /** The most items one message may name as selected. */
  selectionMax: 200,
  /** The longest `q` a read takes. */
  queryMax: 200,
} as const;

/** The tag of the note every delivered Drive-chat turn carries. */
export const DRIVE_CHAT_NOTE_TAG = 'orbit_drive_chat';

/** The chat's words that the server writes too. */
export const DRIVE_CHAT_COPY = {
  fromDrive: 'From Drive',
  runsIn: 'Runs in',
  chooseWorkspace: 'Choose where Drive chats run',
} as const;

/**
 * The session origins a session header and a session list row tag, and what the tag reads: a Wiki chat, a Drive chat,
 * and the Scheduled page's chat (`session.schedule_chat_at`, docs/scheduled-chat-design.md §4.3). Read as `chatOrigin`
 * on a session's detail and on its list row; null on every other session.
 */
export type SessionChatOrigin = 'WIKI_CHAT' | 'DRIVE_CHAT' | 'SCHEDULE_CHAT';

/**
 * The session header's origin tag (board ①): one table, so a chat opened from Drive reads "From Drive" wherever a Wiki
 * chat reads "From Wiki".
 */
export const SESSION_ORIGIN_TAGS: Readonly<Record<SessionChatOrigin, string>> = {
  WIKI_CHAT: WIKI_CHAT_COPY.panel.fromWiki,
  DRIVE_CHAT: DRIVE_CHAT_COPY.fromDrive,
  SCHEDULE_CHAT: SCHEDULE_PAGE_CHAT_COPY.fromScheduled,
};

/** The tag a session's header shows, or null for a session no chat door opened. */
export function sessionOriginTag(origin: string | null | undefined): string | null {
  return origin === 'WIKI_CHAT' || origin === 'DRIVE_CHAT' || origin === 'SCHEDULE_CHAT' ? SESSION_ORIGIN_TAGS[origin] : null;
}

/**
 * The standing guidance for a Drive chat's agent, sent with its first message and again on the first message after its
 * text changed (the server keeps the digest of what it last sent). `onCloud`: the session runs on an Orbit Cloud runner,
 * where the drive is mounted at ~/Files: the chat reads it there and changes it only through the drive_* tools, since a
 * mount that cannot tell its callers apart (Docker, docs/drive-technical-design.md §5.8) leaves a write the chat's
 * rules cannot always be held to.
 */
export function driveChatGuidance(onCloud: boolean): string[] {
  return [
    "You are in a Drive chat: the owner talks to you from their Orbit Drive to find, sort, rename, move and trash files, and to ask what files say.",
    "The owner's words in this chat are their authorisation: when they ask for it, move, rename, make new folders and move items to Trash without asking again.",
    'Never overwrite a file with a same-named one. When a move, a rename or a new file would take a name that is already used, stop and ask the owner instead: name both files (path, size, when each was last changed) and say which you recommend, keeping both under different names included.',
    'Trash is invisible to you: you cannot list, read or restore what is in it. The owner restores from Trash in Drive.',
    'Do not make share links: sharing is the owner\'s, in Drive.',
    onCloud
      ? 'This session runs on an Orbit Cloud runner: the drive is mounted at ~/Files, so read it there with ordinary file commands (ls, cat, grep). Make every change to the drive with the drive_* tools, never with file commands on ~/Files: a new folder, a move, a rename, a move to Trash and new content for a file all go through drive_move, drive_put or drive_delete (drive_move and drive_put make the folders their destination needs). Only those changes are kept together for the owner to undo, and a change through ~/Files may not be.'
      : 'This session\'s machine does not mount the drive: work on it with the drive_* tools (drive_list, drive_get, drive_put, drive_move, drive_delete).',
    'Each of the owner\'s messages may come with the folder they have open and the items they selected: read those as what "here" and "these" mean.',
  ];
}

/**
 * What a Drive-chat message carries of the page it was sent from: the folder the owner had open (null for the drive's
 * top level) and the items they selected, as ids. Never text: delivery reads what they name.
 */
export interface DriveChatContext {
  folderId: string | null;
  entryIds: string[];
}

/** The paths of a value that make it no DriveChatContext; empty when it is one. */
export function driveChatContextErrors(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [''];
  const record = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(record)) if (key !== 'folderId' && key !== 'entryIds') errors.push(key);
  if (record.folderId !== undefined && record.folderId !== null && (typeof record.folderId !== 'string' || record.folderId === '')) {
    errors.push('folderId');
  }
  if (record.entryIds !== undefined) {
    if (!Array.isArray(record.entryIds) || record.entryIds.length > DRIVE_CHAT_RULES.selectionMax) {
      errors.push('entryIds');
    } else {
      record.entryIds.forEach((id, index) => {
        if (typeof id !== 'string' || id === '') errors.push(`entryIds.${index}`);
      });
    }
  }
  return errors;
}

/** The workspace a Drive chat runs in, as the list names it. */
export interface DriveChatWorkspace {
  id: string;
  name: string;
  /** Its machine's name; null when it has none. */
  runner: string | null;
  /** By the runners list's own rule: not signed off, and heard from within the offline window. */
  online: boolean;
}

/**
 * Where the default workspace came from (owner Q3 A): the workspace of the owner's most recent Drive chat, else the
 * account's Orbit Cloud workspace; null when there is neither, and a new chat must name one.
 */
export type DriveChatWorkspaceFrom = 'LAST_CHAT' | 'ORBIT_CLOUD';

/** One Drive chat, as the list names it. */
export interface DriveChatRow {
  sessionId: string;
  title: string;
  status: string;
  /** Not ended and not in Trash: it takes messages. */
  open: boolean;
  /** In the session list's Completed (its completedAt is set). */
  completed: boolean;
  /** A turn of it is queued or running. */
  working: boolean;
  /** Its approvals and questions waiting on the owner. */
  needsYou: number;
  workspaceId: string | null;
  createdAt: string;
  updatedAt: string;
  /** When it was last spoken in (its last turn), else when it was made. */
  lastActiveAt: string;
}

/** `GET /api/drive/chats`. */
export interface DriveChatList {
  /** The workspace a new chat runs in when it names none ("Runs in"), or null when there is none. */
  workspace: DriveChatWorkspace | null;
  workspaceFrom: DriveChatWorkspaceFrom | null;
  /** The round button's counts, over every open chat not in Trash. */
  fab: { needsYou: number; working: boolean };
  chats: DriveChatRow[];
  /** More chats match past this page: the next page starts at `offset` + chatsListed. */
  more: boolean;
}

/** Which group of the list a read asks for: Open (not completed) or Completed; absent, Open then Completed. */
export type DriveChatListStatus = 'open' | 'completed';

/** `?q=`, `?offset=` and `?status=` of a chats read. */
export interface DriveChatListPage {
  /** Words a chat's title holds, matched without case; blank matches every chat. */
  q?: string;
  /** How many matching chats to pass over, a whole number from 0. */
  offset?: number;
  status?: DriveChatListStatus;
}

const newerFirst = (a: DriveChatRow, b: DriveChatRow): number =>
  a.lastActiveAt === b.lastActiveAt
    ? (a.sessionId < b.sessionId ? 1 : a.sessionId > b.sessionId ? -1 : 0)
    : a.lastActiveAt < b.lastActiveAt ? 1 : -1;

/**
 * The list's order: Open first — the ones that need the owner, then the ones working, then the one last spoken in —
 * then Completed, the one last spoken in first. Ties go by the newer id.
 */
export function driveChatOrder(a: DriveChatRow, b: DriveChatRow): number {
  if (a.completed !== b.completed) return a.completed ? 1 : -1;
  if (!a.completed) {
    if ((a.needsYou > 0) !== (b.needsYou > 0)) return a.needsYou > 0 ? -1 : 1;
    if (a.working !== b.working) return a.working ? -1 : 1;
  }
  return newerFirst(a, b);
}

/** One page of the owner's Drive chats: those whose title holds `q`, of the group asked for, in the list's order. */
export function driveChatListPage(rows: readonly DriveChatRow[], page: DriveChatListPage = {}): { chats: DriveChatRow[]; more: boolean } {
  const q = (page.q ?? '').trim().toLocaleLowerCase();
  const offset = page.offset ?? 0;
  const matched = rows
    .filter((row) => q === '' || row.title.toLocaleLowerCase().includes(q))
    .filter((row) => page.status === undefined || row.completed === (page.status === 'completed'))
    .sort(driveChatOrder);
  const end = offset + DRIVE_CHAT_RULES.chatsListed;
  return { chats: matched.slice(offset, end), more: matched.length > end };
}

/** `POST /api/drive/chats`. */
export interface DriveChatCreateBody {
  text: string;
  clientTurnId: string;
  workspaceId?: string;
  /** The folder the owner has open; null or absent for the drive's top level. */
  folderId?: string | null;
  /**
   * The owner removed the folder chip (board ② note 3: what is not shown is not sent): the first message carries no
   * folder and no selection, so its note names none. Not with `folderId` or `entryIds`.
   */
  noFolder?: boolean;
  entryIds?: string[];
  attachmentIds?: string[];
  engine?: string;
  model?: string;
  permissionMode?: string;
  effort?: string;
  fastMode?: boolean;
}

/** What creating a Drive chat answers. */
export interface DriveChatCreateAnswer {
  sessionId: string;
  chat: DriveChatRow;
  workspace: DriveChatWorkspace;
}

/**
 * A Drive chat's changes (owner decision Q2 A, board frames ③ ④; apiserver drive/drive-chat-changes.ts): what one turn
 * changed in Drive, one card with Undo, as `GET /api/drive/chats/:sessionId/groups` answers it.
 */
export type DriveChatChangeKind = 'NEW_FOLDER' | 'NEW_FILE' | 'MOVE' | 'RENAME' | 'TRASH' | 'EDIT';

/**
 * DONE: made, Undo reverses it. PENDING: held past the turn's 200th change, nothing made until Apply. APPLYING and
 * UNDOING while those run. UNDONE: reversed, but for the items it reports skipped.
 */
export type DriveChatChangeGroupStatus = 'DONE' | 'PENDING' | 'APPLYING' | 'UNDOING' | 'UNDONE';

/** Where an entry was or went: its folder (id and path when known) and its name. */
export interface DriveChatPlace {
  parentId: string | null;
  parentPath: string | null;
  name: string | null;
}

/** One change of a group. `state` SKIPPED carries why Undo left it as it is. */
export interface DriveChatChangeItem {
  id: string;
  kind: DriveChatChangeKind;
  entryId: string;
  entryKind: string;
  before: DriveChatPlace;
  after: DriveChatPlace;
  state: 'DONE' | 'UNDONE' | 'SKIPPED';
  reason: string | null;
}

/** One write held for Apply, as the agent asked for it. `state` SKIPPED carries why Apply could not make it. */
export interface DriveChatHeldItem {
  id: string;
  kind: Exclude<DriveChatChangeKind, 'NEW_FILE' | 'EDIT'>;
  entryId: string | null;
  name: string;
  fromPath: string | null;
  toPath: string | null;
  state: 'PENDING' | 'APPLIED' | 'SKIPPED';
  reason: string | null;
}

export interface DriveChatChangeGroup {
  id: string;
  sessionId: string;
  turnId: string;
  status: DriveChatChangeGroupStatus;
  /** It began PENDING: `held` lists what was held, `items` what Apply made. */
  held: boolean;
  createdAt: string;
  appliedAt: string | null;
  undoneAt: string | null;
  /** How many of each kind: the changes made, or for a PENDING group the ones held. */
  counts: Partial<Record<DriveChatChangeKind, number>>;
  total: number;
  /** The items Undo left as they are. */
  skipped: number;
  items: DriveChatChangeItem[];
  heldItems: DriveChatHeldItem[];
}

/** One side of an overwrite question: a file as it was when the chat asked. */
export interface DriveChatQuestionFile {
  entryId: string;
  path: string;
  sizeBytes: number;
  modifiedAt: string;
  lastWriter: { kind: string; sessionId: string | null; sessionTitle: string | null };
}

/**
 * A move or rename a Drive chat asked for onto a live file, refused — a Drive chat never replaces a file — and asked of
 * the owner on a card: Keep both (the incoming file takes a suffix) or Replace (the file there keeps its old content as a
 * version), answered by `POST /api/drive/chats/:sessionId/questions/:id { choice }`.
 */
export interface DriveChatQuestion {
  id: string;
  sessionId: string;
  turnId: string;
  status: 'OPEN' | 'ANSWERING' | 'ANSWERED' | 'STALE';
  choice: 'KEEP_BOTH' | 'REPLACE' | null;
  moving: DriveChatQuestionFile;
  existing: DriveChatQuestionFile;
  destination: { parentId: string; name: string };
  /** What the answer made: the moved file's id, path and name. */
  outcome: { entryId: string; path: string; name: string } | null;
  /** Why a STALE question can no longer be answered. */
  reason: string | null;
  createdAt: string;
  answeredAt: string | null;
}
