/**
 * The Drive chat on the web (project "Drive chat: manage files by talking to an agent", board
 * docs/mocks/drive-chat/01-board.html ② ⑤, owner Q1 A and Q3 A): the Wiki's chat host docked on Drive, configured by
 * what is Drive's — its words, its chats (`GET /api/drive/chats`, `POST /api/drive/chats`), the folder open as the
 * composer's first chip, and its own keys on the device for ✕ and the tab's chat, per account.
 *
 * The panel, the composer, the history and the round button are the Wiki's (WikiChatPanel, WikiChatFab, useChatHost);
 * only what differs is here.
 */
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import {
  DRIVE_CHAT_COPY,
  type DriveChatCreateAnswer,
  type DriveChatCreateBody,
  type DriveChatList,
  type DriveChatRow,
} from '@orbit/shared';
import { api } from '../api';
import { compatibleUuid } from './uuid';
import {
  WIKI_CHAT_NEW_PARAM,
  wikiChatFab,
  wikiChatShown,
  wikiChatShownFiles,
  type ChatHostList,
  type ChatHostStore,
  type WikiChatAttachments,
  type WikiChatCreate,
  type WikiChatFabCounts,
  type WikiChatRow,
  type WikiChatWorkspace,
} from './wikiChat';

// ── The words ───────────────────────────────────────────────────────────────────────────────────

export const DRIVE_CHAT_EMPTY_HINT = 'Ask about your files, or say how to sort them.';
export const DRIVE_CHAT_EMPTY_NOTE = 'Every change it makes shows here, and can be undone.';
export const DRIVE_CHAT_PLACEHOLDER = 'Ask about your files, or say how to sort them';
/** Shown under the empty state of a new chat while its box is empty; a press fills the box and sends nothing (board ②). */
export const DRIVE_CHAT_EXAMPLES = [
  'Sort these receipts into Receipts 2026 by month',
  'What’s taking up the most space?',
  'Find the lease and tell me when the notice period ends',
] as const;
export const DRIVE_CHAT_HISTORY = 'Drive chats';
export const DRIVE_CHAT_NO_HISTORY = 'No Drive chats yet';
export const DRIVE_CHAT_NO_WORKSPACE = 'Add a machine or Orbit Cloud to chat about your files';
export const DRIVE_CHAT_CHOOSE_WORKSPACE = DRIVE_CHAT_COPY.chooseWorkspace;
export const DRIVE_CHAT_UPDATED = 'Drive updated';
/** The folder chip: `Folder · Scans`, `Folder · Drive` at the top level. */
export const driveChatFolderLabel = (name: string): string => `Folder · ${name}`;

// ── Where it is kept ────────────────────────────────────────────────────────────────────────────

/** Drive's keys on the device, scoped by the account's id (✕ is remembered per account on this device). */
export const DRIVE_CHAT_STORE: ChatHostStore = {
  closed: 'orbit.driveChat.closed',
  open: 'orbit.driveChat.open',
  width: 'orbit.driveChat.width',
};

/** The panel's width on Drive until it is dragged (board ① table: 400, dragged 320 to half the window). */
export const DRIVE_CHAT_PANEL_WIDTH = 400;

// ── The chats read ──────────────────────────────────────────────────────────────────────────────

/** A Drive chat's row as the host's history and button read it: no cards, so no drafts. */
const hostRow = (row: DriveChatRow): WikiChatRow => ({
  sessionId: row.sessionId,
  title: row.title,
  status: row.status,
  open: row.open,
  completed: row.completed,
  working: row.working,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  lastActiveAt: row.lastActiveAt,
  drafts: 0,
  needsYou: row.needsYou,
});

/**
 * `GET /api/drive/chats` as the host reads a chats list: the server's default workspace (Runs in, owner Q3 A) is the one
 * a new chat starts on; where else it may run is the owner's workspaces, which the Drive host lists itself.
 */
export function driveChatHostList(list: DriveChatList): ChatHostList {
  return {
    workspace: list.workspace ? { ...list.workspace, eligible: true } : null,
    choices: [],
    fab: { needsYou: list.fab.needsYou, working: list.fab.working, updated: 0 },
    chats: list.chats.map(hostRow),
    more: list.more,
  };
}

export async function getDriveChats(page: { q?: string; offset?: number } = {}): Promise<ChatHostList> {
  const params = new URLSearchParams();
  const q = page.q?.trim();
  if (q) params.set('q', q);
  if (page.offset) params.set('offset', String(page.offset));
  const query = params.toString();
  return driveChatHostList(await api<DriveChatList>(`/drive/chats${query ? `?${query}` : ''}`));
}

export const driveChatsQuery = () =>
  queryOptions({
    queryKey: ['drive', 'chats'] as const,
    meta: { entities: ['drive'] },
    queryFn: () => getDriveChats(),
    staleTime: 15_000,
    refetchInterval: (query) => (query.state.data?.fab.working ? 10_000 : false),
  });

/** The history the title opens (Drive chats only, board ④ note 3): one page at a time, searched by title. */
export const driveChatHistoryQuery = (q: string) =>
  infiniteQueryOptions({
    queryKey: ['drive', 'chats', 'history', q] as const,
    meta: { entities: ['drive'] },
    initialPageParam: 0,
    queryFn: ({ pageParam }) => getDriveChats({ q, offset: pageParam }),
    getNextPageParam: (page, pages) => (page.more ? pages.reduce((n, one) => n + one.chats.length, 0) : undefined),
    staleTime: 15_000,
  });

/**
 * Which chat the panel opens on (board ②): the one that needs the owner, else the most recent open one, else a new chat.
 * A completed chat is not continued.
 */
export function driveChatToOpen(chats: readonly WikiChatRow[] | null | undefined): string {
  const rows = (chats ?? []).filter((chat) => chat.open && !chat.completed);
  return rows.find((chat) => chat.needsYou > 0)?.sessionId ?? rows[0]?.sessionId ?? WIKI_CHAT_NEW_PARAM;
}

/** The round button (board ⑤): the Wiki's four looks, its green check read as the drive's. */
export function driveChatFab(counts: WikiChatFabCounts | null | undefined): ReturnType<typeof wikiChatFab> {
  const fab = wikiChatFab(counts);
  return fab.state === 'updated' ? { ...fab, label: DRIVE_CHAT_UPDATED } : fab;
}

// ── Sending ─────────────────────────────────────────────────────────────────────────────────────

/** The folder a message carries (board ② note 3): the chip's, unless it was crossed out; what is not shown is not sent. */
export function driveChatContext(attachments: WikiChatAttachments): { folderId: string | null; entryIds: string[] } | undefined {
  const { page } = wikiChatShown(attachments);
  const files = wikiChatShownFiles(attachments);
  const folder = page?.kind === 'folder' ? page : null;
  if (!folder && !files) return undefined;
  return { folderId: folder ? folder.folderId : null, entryIds: files ? [...files.ids] : [] };
}

/**
 * `POST /api/drive/chats`: the chat's session, its first turn filed under a UUID of ours. The folder chip shown goes as
 * `folderId` (null at the top level); none shown — crossed out, or not read yet — goes as `noFolder`, so the agent is
 * told of no folder rather than of the top level.
 */
export const createDriveChat = (
  body: Omit<WikiChatCreate, 'wikiContext'>,
  attachments: WikiChatAttachments,
  clientTurnId: string = compatibleUuid(),
): Promise<DriveChatCreateAnswer> => {
  const context = driveChatContext(attachments);
  const sent: DriveChatCreateBody = {
    text: body.content,
    clientTurnId,
    ...(body.workspaceId ? { workspaceId: body.workspaceId } : {}),
    ...(context ? { folderId: context.folderId, ...(context.entryIds.length ? { entryIds: context.entryIds } : {}) } : { noFolder: true }),
    ...(body.attachmentIds?.length ? { attachmentIds: body.attachmentIds } : {}),
    ...(body.model !== undefined ? { model: body.model } : {}),
    ...(body.permissionMode !== undefined ? { permissionMode: body.permissionMode } : {}),
    ...(body.effort !== undefined ? { effort: body.effort } : {}),
    ...(body.fastMode !== undefined ? { fastMode: body.fastMode } : {}),
  };
  return api<DriveChatCreateAnswer>('/drive/chats', { method: 'POST', body: sent });
};

/** A workspace as Runs in lists it, its machine's name and whether that is online read from the runners list. */
export function driveChatWorkspace(
  workspace: { id: string; name: string; runnerId?: string | null },
  runners: ReadonlyArray<{ id: string; name: string; displayName?: string | null; online?: boolean }>,
): WikiChatWorkspace {
  const runner = runners.find((row) => row.id === workspace.runnerId);
  return { id: workspace.id, name: workspace.name, runner: runner ? runner.displayName || runner.name : null, online: runner?.online ?? false };
}
