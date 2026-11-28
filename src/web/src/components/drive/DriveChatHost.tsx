import { useEffect, useMemo, useReducer, type ReactNode } from 'react';
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
import { WIKI_CHAT_NO_ATTACHMENTS, wikiChatAttach, type WikiChatFiles, type WikiChatPage } from '../../lib/wikiChat';
import { useDriveChanges } from '../../lib/useDriveChanges';
import { syncRunning, useDriveSyncs } from '../../lib/driveSyncs';
import { useDriveUploads } from '../../lib/driveUploads';

/** The Agents button's state (board drive-web 01 ①④): pressed while the panel is open, a ring while work runs, an amber count. */
export interface DriveAgents {
  open: boolean;
  working: boolean;
  /** What waits on the owner: chats' approvals, held change groups, open overwrite questions, failed syncs. */
  count: number;
  toggle: () => void;
}

/**
 * Drive's chat (board docs/mocks/drive-chat/01-board.html ② ⑤, owner Q1 A, Q3 A): the Wiki's host, docked beside the
 * drive. At ≥ 1200 it opens by default as the right-hand panel on the chat that needs the owner, else the most recent
 * open one, else New chat; ✕ is remembered per account on this device until the Agents button is pressed. The folder
 * open is the composer's first chip, `Folder · <name>`; a new chat runs in the server's default workspace unless
 * another is picked. Only the files view hosts it: Trash, Storage and share pages do not.
 *
 * The page's own Agents button (not the round one) opens and closes the panel: see `DriveAgents`.
 */
export function DriveChatHost({
  folderId,
  folderName,
  selection,
  children,
}: {
  /** The folder open: null for the drive's top level. */
  folderId: string | null;
  /** Its name, or null while the folder is still being read (no chip yet). */
  folderName: string | null;
  /** The rows selected in the list: they ride in the composer's attachment row as one chip. */
  selection: WikiChatFiles | null;
  /** The page, given whether the chat panel is open (file details overlay the list while it is). */
  children: ReactNode | ((state: { chatOpen: boolean; agents: DriveAgents }) => ReactNode);
}) {
  const me = useQuery(meQuery());
  const list = useQuery(driveChatsQuery());
  const workspaces = useQuery(workspacesQuery());
  const runners = useQuery(runnersQuery());

  // The chats read counts approvals; held groups, open overwrite questions and failed syncs wait on the owner too.
  const changes = useDriveChanges();
  const syncs = useDriveSyncs();
  const { uploads } = useDriveUploads();
  // A sync needs the owner when it failed, or finished with failed files, and nobody has handled it.
  const failedSyncs = syncs.filter((sync) => (sync.status === 'FAILED' || sync.failedCount > 0) && sync.handledAt === null).length;
  const fab = driveChatFab(list.data ? { ...list.data.fab, needsYou: list.data.fab.needsYou + changes.needsYou, updated: 0 } : null);
  const host = useChatHost({
    scope: me.data?.id ?? null,
    store: DRIVE_CHAT_STORE,
    list,
    shown: true,
    fab,
    toOpen: driveChatToOpen,
    fixedWidth: DRIVE_CHAT_PANEL_WIDTH,
    frameClass: 'is-drive',
    ownEntry: true,
  });
  const agents: DriveAgents = {
    open: host.open,
    working:
      (list.data?.fab.working ?? false) ||
      syncs.some(syncRunning) ||
      uploads.some((u) => u.status === 'queued' || u.status === 'uploading'),
    count: (list.data?.fab.needsYou ?? 0) + changes.needsYou + failedSyncs,
    toggle: host.toggle,
  };

  const [attachments, dispatch] = useReducer(wikiChatAttach, WIKI_CHAT_NO_ATTACHMENTS);
  const page = useMemo<WikiChatPage | null>(
    () => (folderName === null ? null : { kind: 'folder', folderId, label: driveChatFolderLabel(folderName) }),
    [folderId, folderName],
  );
  useEffect(() => dispatch({ type: 'follow', page }), [page]);
  useEffect(() => dispatch({ type: 'files', files: selection }), [selection]);

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
      cards: true,
    }),
    [choices],
  );

  return host.render(typeof children === 'function' ? children({ chatOpen: host.open, agents }) : children, { origin, attachments, dispatch });
}
