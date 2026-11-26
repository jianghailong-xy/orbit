import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useChatHost } from '../ChatHost';
import type { ChatOrigin } from '../WikiChatPanel';
import {
  DRIVE_CHAT_CHOOSE_WORKSPACE,
  DRIVE_CHAT_EMPTY_HINT,
  DRIVE_CHAT_EMPTY_NOTE,
  DRIVE_CHAT_EXAMPLES,
  DRIVE_CHAT_HISTORY,
  DRIVE_CHAT_NO_HISTORY,
  DRIVE_CHAT_NO_WORKSPACE,
  DRIVE_CHAT_PANEL_WIDTH,
  DRIVE_CHAT_PLACEHOLDER,
  DRIVE_CHAT_STORE,
  createDriveChat,
  driveChatContext,
  driveChatFab,
  driveChatFolderLabel,
  driveChatsQuery,
  driveChatToOpen,
  driveChatWorkspace,
} from '../../lib/driveChat';
import { meQuery, runnersQuery, workspacesQuery } from '../../lib/queries';
import { WIKI_CHAT_NO_ATTACHMENTS, wikiChatAttach, type WikiChatPage } from '../../lib/wikiChat';

/**
 * Drive's chat (board docs/mocks/drive-chat/01-board.html ② ⑤, owner Q1 A, Q3 A): the Wiki's host, docked beside the
 * drive. At ≥ 1200 it opens by default as the right-hand panel on the chat that needs the owner, else the most recent
 * open one, else New chat; ✕ is remembered per account on this device until the round button is pressed. The folder
 * open is the composer's first chip, `Folder · <name>`; a new chat runs in the server's default workspace unless
 * another is picked. Only the files view hosts it: Trash, Storage and share pages do not.
 *
 * The button's green check ("Drive updated") is lit when a Drive chat's work finishes while the panel is closed, until
 * the button is pressed: the chats read counts what needs the owner and what is working, not what changed.
 */
export function DriveChatHost({
  folderId,
  folderName,
  children,
}: {
  /** The folder open: null for the drive's top level. */
  folderId: string | null;
  /** Its name, or null while the folder is still being read (no chip yet). */
  folderName: string | null;
  children: ReactNode;
}) {
  const me = useQuery(meQuery());
  const list = useQuery(driveChatsQuery());
  const workspaces = useQuery(workspacesQuery());
  const runners = useQuery(runnersQuery());

  const working = list.data?.fab.working ?? false;
  const [updated, setUpdated] = useState(false);
  const fab = driveChatFab(list.data ? { ...list.data.fab, updated: updated ? 1 : 0 } : null);
  const host = useChatHost({
    scope: me.data?.id ?? null,
    store: DRIVE_CHAT_STORE,
    list,
    shown: true,
    fab,
    toOpen: driveChatToOpen,
    fixedWidth: DRIVE_CHAT_PANEL_WIDTH,
    frameClass: 'is-drive',
  });
  // Work that finished while the panel was closed lights the check; opening the panel has seen it.
  const wasWorking = useRef(working);
  useEffect(() => {
    if (host.open) setUpdated(false);
    else if (wasWorking.current && !working) setUpdated(true);
    wasWorking.current = working;
  }, [working, host.open]);

  const [attachments, dispatch] = useReducer(wikiChatAttach, WIKI_CHAT_NO_ATTACHMENTS);
  const page = useMemo<WikiChatPage | null>(
    () => (folderName === null ? null : { kind: 'folder', folderId, label: driveChatFolderLabel(folderName) }),
    [folderId, folderName],
  );
  useEffect(() => dispatch({ type: 'follow', page }), [page]);

  // Where a new chat may run: the owner's workspaces, the server's default among them.
  const defaultWorkspace = list.data?.workspace ?? null;
  const choices = useMemo(() => {
    if (!workspaces.data) return undefined;
    const rows = workspaces.data.map((row: { id: string; name: string; runnerId?: string | null }) => driveChatWorkspace(row, runners.data ?? []));
    if (defaultWorkspace && !rows.some((row) => row.id === defaultWorkspace.id)) {
      const { eligible: _eligible, ...workspace } = defaultWorkspace;
      rows.unshift(workspace);
    }
    return rows;
  }, [workspaces.data, runners.data, defaultWorkspace]);

  const origin = useMemo<ChatOrigin>(
    () => ({
      copy: {
        history: DRIVE_CHAT_HISTORY,
        noHistory: DRIVE_CHAT_NO_HISTORY,
        emptyHint: DRIVE_CHAT_EMPTY_HINT,
        emptyNote: DRIVE_CHAT_EMPTY_NOTE,
        placeholder: DRIVE_CHAT_PLACEHOLDER,
        noWorkspace: DRIVE_CHAT_NO_WORKSPACE,
        chooseWorkspace: DRIVE_CHAT_CHOOSE_WORKSPACE,
        examples: DRIVE_CHAT_EXAMPLES,
      },
      listKey: driveChatsQuery().queryKey,
      create: (body, sent) => createDriveChat(body, sent),
      turnContext: (sent) => {
        const driveContext = driveChatContext(sent);
        return driveContext ? { driveContext } : undefined;
      },
      choices,
    }),
    [choices],
  );

  return host.render(children, { origin, attachments, dispatch });
}
