/**
 * The Scheduled page's chat on the web (docs/scheduled-chat-design.md §2, §3, §5, §6; board
 * docs/mocks/scheduled-chat/01-board-1.png, -2.png): the Wiki's chat host docked on the Scheduled page, configured by
 * what is Scheduled's — its words, its opening (`GET /api/schedules/chat`), its first message (`POST
 * /api/schedules/chat`), its history (the account's sessions tagged From Scheduled), where a new chat runs, and its own
 * keys on the device.
 *
 * The panel, the composer and the history are the shared ones (WikiChatPanel over SessionConversation and
 * SessionComposer, useChatHost); only what differs is here.
 */
import { infiniteQueryOptions, queryOptions, type QueryClient, type QueryKey } from '@tanstack/react-query';
import type { SchedulePageChatOpenAnswer, SchedulePageChatResponse } from '@orbit/shared';
import { api, type SessionListItem } from '../api';
import { sessionsQuery } from './queries';
import { viewerTimezone } from './schedules';
import { sameResourceId } from './watches';
import { firstOpenableWorkspace, type OrderableWorkspace } from './workspaceOrder';
import {
  WIKI_CHAT_NEW_PARAM,
  type ChatHostList,
  type ChatHostStore,
  type ChatPanelRange,
  type WikiChatCreate,
  type WikiChatRow,
  type WikiChatWorkspace,
} from './wikiChat';

// ── The words ───────────────────────────────────────────────────────────────────────────────────

/** The header button (board 1 ①). */
export const SCHEDULED_CHAT_BUTTON = 'Chat';
/** A chat's title until the session has one of its own. */
export const SCHEDULED_CHAT_TITLE = 'Scheduled chat';
export const SCHEDULED_CHAT_HISTORY = 'Scheduled chats';
export const SCHEDULED_CHAT_NO_HISTORY = 'No Scheduled chats yet';
export const SCHEDULED_CHAT_PLACEHOLDER = 'Ask about your schedules, or say what to change…';
export const SCHEDULED_CHAT_NO_WORKSPACE = 'Add a machine or Orbit Cloud to manage your schedules by chat';
export const SCHEDULED_CHAT_CHOOSE_WORKSPACE = 'Choose where this chat runs';

// ── Where it is kept ────────────────────────────────────────────────────────────────────────────

/**
 * Scheduled's keys on the device, scoped by the account's id. `shown` is whether the panel was left open (design §3,
 * D3 A: not open by default, open or closed remembered per device); `open` is the chat a tab shows.
 */
export const SCHEDULED_CHAT_STORE: ChatHostStore = {
  closed: 'orbit.scheduledChat.closed',
  open: 'orbit.scheduledChat.open',
  width: 'orbit.scheduledChat.width',
  shown: 'orbit.scheduledChat.shown',
};

/** The panel's width (design §6): 400 until dragged, and dragged between 400 and 480 where it is wide (≥ 1440). */
export const SCHEDULED_CHAT_WIDTH = 400;
export const SCHEDULED_CHAT_RANGE: ChatPanelRange = { min: 400, max: 480 };

// ── The opening, and the first message ──────────────────────────────────────────────────────────

/** `GET /api/schedules/chat`: the account's open page chat, if any, and Orbit's opening for a new one. Writes nothing. */
export const getScheduledChat = (): Promise<SchedulePageChatResponse> =>
  api<SchedulePageChatResponse>(`/schedules/chat?timezone=${encodeURIComponent(viewerTimezone())}`);

export const scheduledChatQuery = () =>
  queryOptions({
    queryKey: ['schedules', 'chat'] as const,
    // What the schedules list is re-read on: the opening counts the same schedules, and names the open chat.
    meta: { entities: ['session', 'workspace', 'scheduleCard'] },
    queryFn: getScheduledChat,
    staleTime: 15_000,
  });

/**
 * `POST /api/schedules/chat`: the person's first words open the chat in the Runs in workspace. The door takes the words
 * and the workspace alone: the chat starts as any new session of that workspace does (design §4.3).
 */
export const createScheduledChat = (body: Pick<WikiChatCreate, 'workspaceId' | 'content'>): Promise<SchedulePageChatOpenAnswer> =>
  api<SchedulePageChatOpenAnswer>('/schedules/chat', {
    method: 'POST',
    body: { workspaceId: body.workspaceId, text: body.content },
  });

/** What a message carries of the page (design §4.2): the workspace the list is filtered to. */
export function scheduledChatContext(workspaceFilter: string | null): { context: { scheduleFilter: string } } | undefined {
  return workspaceFilter ? { context: { scheduleFilter: workspaceFilter } } : undefined;
}

// ── Where a new chat runs (design §5) ───────────────────────────────────────────────────────────

/**
 * The workspace Runs in starts on: the page's workspace filter when one is set, else the account's default workspace —
 * the one the app lands on, first in the person's own sidebar order with a machine — and never the last one used
 * (W§5.1: that can land on a production machine). Null when the account has none with a machine.
 */
export function scheduledChatDefaultWorkspace<T extends OrderableWorkspace>(
  workspaceFilter: string | null,
  workspaces: readonly T[],
): T | null {
  const filtered = workspaceFilter ? workspaces.find((w) => sameResourceId(w.id, workspaceFilter)) : undefined;
  if (filtered) return filtered;
  return firstOpenableWorkspace(workspaces) ?? null;
}

// ── The chats ───────────────────────────────────────────────────────────────────────────────────

/** A session list row opened by the Scheduled page's chat door (`chatOrigin`, the From Scheduled tag). */
export const isScheduledChat = (row: SessionListItem): boolean => row.chatOrigin === 'SCHEDULE_CHAT';

/** A Scheduled chat's list row as the panel's history and opening read it. */
export function scheduledChatRow(row: SessionListItem): WikiChatRow {
  const completed = row.lifecycleState === 'COMPLETED' || !!row.completedAt;
  const approvals = Number(row.pendingApprovals ?? 0) || 0;
  const at = (row.lastTurnAt as string | null | undefined) ?? (row.createdAt as string);
  return {
    sessionId: row.id,
    title: (row.title as string | null | undefined) || SCHEDULED_CHAT_TITLE,
    status: String(row.status ?? ''),
    open: !completed,
    completed,
    working: row.phase === 'RUNNING' || row.status === 'RUNNING' || row.status === 'PENDING',
    createdAt: row.createdAt as string,
    updatedAt: at,
    lastActiveAt: at,
    drafts: 0,
    needsYou: Math.max(approvals, row.waitingOn === 'PERSON' ? 1 : 0),
  };
}

/** Newest spoken in first, as the history orders a page. */
const byLastActive = (a: WikiChatRow, b: WikiChatRow): number =>
  Date.parse(b.lastActiveAt ?? b.updatedAt) - Date.parse(a.lastActiveAt ?? a.updatedAt);

/**
 * The chats read as the host reads it: the workspace a new chat runs in (`workspace`), the open Scheduled chats from
 * the session list, and the counts the button reads.
 */
export function scheduledChatHostList(
  rows: readonly SessionListItem[],
  workspace: WikiChatWorkspace | null,
): ChatHostList {
  const chats = rows.filter(isScheduledChat).map(scheduledChatRow).filter((row) => row.open).sort(byLastActive);
  return {
    workspace: workspace ? { ...workspace, eligible: true } : null,
    choices: [],
    fab: {
      needsYou: chats.reduce((n, row) => n + row.needsYou, 0),
      working: chats.some((row) => row.working),
      updated: 0,
    },
    chats,
    more: false,
  };
}

/**
 * Which chat the button opens (design §3): the one with a card waiting, else the account's open one (`GET`'s, which is
 * the newest), else the newest open one listed, else a new chat. A completed chat is not continued.
 */
export function scheduledChatToOpen(chats: readonly WikiChatRow[] | null | undefined, openId: string | null | undefined): string {
  const rows = (chats ?? []).filter((chat) => chat.open && !chat.completed);
  return rows.find((chat) => chat.needsYou > 0)?.sessionId ?? openId ?? rows[0]?.sessionId ?? WIKI_CHAT_NEW_PARAM;
}

/** Completed chats the history reads, from the newest: the session list's Completed, one page of it. */
export const SCHEDULED_CHAT_HISTORY_COMPLETED = 100;

/**
 * The history the title opens (design §3): this account's Scheduled chats, Open and Completed, searched by title. Read
 * from the session list (the Open list the console holds, and the newest page of Completed), whose rows carry the From
 * Scheduled tag; one page.
 */
export const scheduledChatHistoryQuery = (qc: QueryClient, q: string) =>
  infiniteQueryOptions({
    queryKey: ['schedules', 'chat', 'history', q] as QueryKey,
    meta: { entities: ['session'] },
    initialPageParam: 0,
    queryFn: async (): Promise<ChatHostList> => {
      const [open, completed] = await Promise.all([
        qc.fetchQuery(sessionsQuery()),
        qc.fetchQuery(sessionsQuery({ view: 'completed', limit: SCHEDULED_CHAT_HISTORY_COMPLETED })),
      ]);
      const needle = q.trim().toLowerCase();
      const chats = [...open, ...completed]
        .filter(isScheduledChat)
        .map(scheduledChatRow)
        .filter((row) => !needle || row.title.toLowerCase().includes(needle))
        .sort(byLastActive);
      return { workspace: null, choices: [], fab: { needsYou: 0, working: false, updated: 0 }, chats, more: false };
    },
    getNextPageParam: () => undefined,
    staleTime: 15_000,
  });
