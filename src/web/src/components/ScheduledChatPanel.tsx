import { useMemo, useReducer, type JSX, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CommentOutlined } from '@ant-design/icons';
import type { SchedulePageChatResponse } from '@orbit/shared';
import { useChatHost } from './ChatHost';
import type { ChatOrigin } from './WikiChatPanel';
import { meQuery, runnersQuery, sessionsQuery, workspacesQuery } from '../lib/queries';
import { driveChatWorkspace } from '../lib/driveChat';
import { WIKI_CHAT_NO_ATTACHMENTS, wikiChatAttach } from '../lib/wikiChat';
import {
  SCHEDULED_CHAT_BUTTON,
  SCHEDULED_CHAT_CHOOSE_WORKSPACE,
  SCHEDULED_CHAT_HISTORY,
  SCHEDULED_CHAT_NO_HISTORY,
  SCHEDULED_CHAT_NO_WORKSPACE,
  SCHEDULED_CHAT_PLACEHOLDER,
  SCHEDULED_CHAT_RANGE,
  SCHEDULED_CHAT_STORE,
  SCHEDULED_CHAT_WIDTH,
  createScheduledChat,
  scheduledChatContext,
  scheduledChatDefaultWorkspace,
  scheduledChatHistoryQuery,
  scheduledChatHostList,
  scheduledChatQuery,
  scheduledChatToOpen,
} from '../lib/scheduledChat';

type WorkspaceRow = { id: string; name: string; createdAt: string; position?: number | null; runnerId?: string | null };

/**
 * The Scheduled page's chat (docs/scheduled-chat-design.md §2, §3, §6; board scheduled-chat 01 parts 1–2): a thin host
 * of the shared chat panel — the session page's SessionConversation and SessionComposer, the history, `+`, `↗` and `✕` —
 * docked on the right of the Scheduled page. What is the page's own:
 *
 * - it opens only on a press of the page's Chat button (`toggle`), never by itself, and whether it was left open is kept
 *   on this device (D3 A). The address names the chat shown (`?chat=<session>`), so a reload keeps it;
 * - a new chat shows Orbit's opening (`GET /api/schedules/chat`) and Runs in, whose default is the page's workspace
 *   filter, else the account's default workspace, never the last one used (§5). Its first message opens it (`POST`);
 * - its history is the account's Scheduled chats; its width 400, dragged between 400 and 480 (§6);
 * - at 1200–1439 the app sidebar folds to its icon rail, below 1200 it slides over the page, below 640 it is a sheet.
 */
export function useScheduledChatPanel({ workspaceFilter }: { workspaceFilter: string | null }) {
  const qc = useQueryClient();
  const me = useQuery(meQuery());
  const sessions = useQuery(sessionsQuery());
  const workspaces = useQuery(workspacesQuery());
  const runners = useQuery(runnersQuery());

  // Where a new chat may run: the owner's workspaces that have a machine, named with it and whether it is online.
  const choices = useMemo(
    () =>
      workspaces.data
        ? (workspaces.data as WorkspaceRow[]).filter((row) => row.runnerId).map((row) => driveChatWorkspace(row, runners.data ?? []))
        : undefined,
    [workspaces.data, runners.data],
  );
  const defaultId = scheduledChatDefaultWorkspace(workspaceFilter, (workspaces.data ?? []) as WorkspaceRow[])?.id ?? null;
  const defaultWorkspace = choices?.find((choice) => choice.id === defaultId) ?? null;

  const ready = sessions.data !== undefined && workspaces.data !== undefined;
  const listData = useMemo(
    () => (ready ? scheduledChatHostList(sessions.data ?? [], defaultWorkspace) : undefined),
    [ready, sessions.data, defaultWorkspace],
  );
  // The account's open chat as the opening last read it, when it has been read; else the newest open one listed.
  const toOpen = useMemo(
    () => (chats: Parameters<typeof scheduledChatToOpen>[0]) =>
      scheduledChatToOpen(chats, qc.getQueryData<SchedulePageChatResponse>(scheduledChatQuery().queryKey)?.sessionId),
    [qc],
  );

  const host = useChatHost({
    scope: me.data?.id ?? null,
    store: SCHEDULED_CHAT_STORE,
    list: { data: listData, isPending: !ready },
    shown: true,
    opens: 'on-press',
    toOpen,
    fixedWidth: SCHEDULED_CHAT_WIDTH,
    range: SCHEDULED_CHAT_RANGE,
    frameClass: 'is-sched',
  });

  // Orbit's opening is read while the panel is open: a closed panel reads nothing of its own.
  const opening = useQuery({ ...scheduledChatQuery(), enabled: host.open });
  const [attachments, dispatch] = useReducer(wikiChatAttach, WIKI_CHAT_NO_ATTACHMENTS);
  const words = opening.data?.opening;
  const origin = useMemo<ChatOrigin>(
    () => ({
      copy: {
        history: SCHEDULED_CHAT_HISTORY,
        noHistory: SCHEDULED_CHAT_NO_HISTORY,
        // Orbit's opening (§4.1): the counts and the next run, then the examples, then what applies at once.
        emptyHint: words ? [words.summary, words.nextText].filter(Boolean).join(' ') : '',
        emptyNote: words?.examplesLead ?? '',
        examples: words?.examples,
        closing: words?.closing,
        placeholder: SCHEDULED_CHAT_PLACEHOLDER,
        noWorkspace: SCHEDULED_CHAT_NO_WORKSPACE,
        chooseWorkspace: SCHEDULED_CHAT_CHOOSE_WORKSPACE,
      },
      listKey: ['schedules', 'chat'],
      create: async (body) => {
        const created = await createScheduledChat(body);
        void qc.invalidateQueries({ queryKey: ['sessions'] });
        return created;
      },
      turnContext: () => scheduledChatContext(workspaceFilter),
      choices,
      history: (q) => scheduledChatHistoryQuery(qc, q),
    }),
    [words, choices, workspaceFilter, qc],
  );

  return {
    open: host.open,
    toggle: host.toggle,
    render: (children: ReactNode) => host.render(children, { origin, attachments, dispatch }),
  };
}

/** The header's Chat button (board 1 ①): at the far right of the tools row, pressed while the panel is open. */
export function ScheduledChatButton({ open, onPress }: { open: boolean; onPress: () => void }): JSX.Element {
  return (
    <button type="button" className="sched-chat-btn" aria-pressed={open} data-schedule-chat="" onClick={onPress}>
      <CommentOutlined aria-hidden="true" />
      {SCHEDULED_CHAT_BUTTON}
    </button>
  );
}
