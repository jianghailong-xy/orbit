import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import {
  ArrowRightOutlined,
  CaretDownOutlined,
  CaretRightOutlined,
  CloseOutlined,
  DownOutlined,
  EllipsisOutlined,
  FileOutlined,
  FolderOutlined,
  LoadingOutlined,
  PlusOutlined,
  ReadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import {
  AgentProvider,
  derivePermissionSemantics,
  encodeCursorModel,
  ENGINE_CLI_NAMES,
  fastModeAvailable,
  runtimeTakesMidTurnSteer,
  wikiChatCardNeedsYou,
  type SessionPermissionModeChange,
  type SessionTurnIntent,
} from '@orbit/shared';
import {
  api,
  completeSession,
  deleteSession,
  interruptSession,
  renameSession,
  restoreSession,
  updateSessionConfig,
} from '../api';
import { Menu } from './ui/Menu';
import { Tooltip, TEXT_TOOLTIP_DELAY_MS } from './ui/Tooltip';
import { ApprovalPanel } from './ApprovalPanel';
import { useModeCapsule } from './ModeCapsule';
import { PendingTray } from './PendingTray';
import { modeChangeInserts } from './PermissionModeLine';
import { SessionConversation } from './SessionConversation';
import type { TurnImage } from './Transcript';
import {
  composerModelMenuItems,
  composerSlashItems,
  isGenerating,
  lastContextReading,
  orbitLinkStateWord,
  pushHistory,
  SessionComposer,
  SessionStatusCard,
  statusLabel,
  useComposerImages,
  usePendingTray,
  type ComposerImage,
  type LocalStatusCard,
  type SessionComposerProps,
} from './WorkspaceView';
import { wikiChatReviewPath, type WikiDraftCardHost } from './WikiDraftCard';
import { approvalRememberOffered } from '../lib/dshRuntime';
import { composerDraftAfterSend, isCurrentWorkUnavailable } from '../lib/composerSendState';
import { materializeReferences, type ReferenceMap } from '../lib/composerRefs';
import { CURSOR_QUEUE_NOTE, cursorModelPick, cursorSettingRows } from '../lib/cursorRuntime';
import { encodeId, routeId } from '../lib/idCodec';
import { useMachineName } from '../lib/managedRunner';
import { currentPromptSuggestion, offeredPromptSuggestion } from '../lib/promptSuggestion';
import { poolsAsProviders, providerPoolsQuery } from '../lib/providerPools';
import { driveChatHistoryQuery } from '../lib/driveChat';
import { driveSelectionLabel } from '../lib/driveChanges';
import { useDriveChatCards } from './drive/DriveChangeCards';
import { meQuery, providersQuery, runnersQuery, sessionQuery, wikiChatHistoryQuery, workspacesQuery, type Me } from '../lib/queries';
import { returnsToComposer } from '../lib/queuedTurnRestore';
import { engineTitleFor } from '../lib/sessionProviderChoices';
import { outlivingSessionWork } from '../lib/sessionActivity';
import { autoMenuNote } from '../lib/sessionPermissionMode';
import { isSessionLive, isSessionTerminal, sessionRetryPending, sessionRunStateOf, sessionRunStatusOf } from '../lib/sessionState';
import { defaultSessionTurnIntent } from '../lib/sessionTurnIntent';
import { sharedPoolAsProviderPool, sharedPoolsQuery } from '../lib/sharedPools';
import { isLocalSlashCommand, localStatusRows, slashCommandName, supportsRunnerSlashAssets } from '../lib/slashCommands';
import { useToast } from '../lib/toast';
import { turnPlacementOf } from '../lib/turnPlacement';
import { useSessionStream } from '../lib/useSessionStream';
import {
  WIKI_CHAT_CLOSE,
  WIKI_CHAT_ENDED,
  WIKI_CHAT_FOCUS_NEEDS_YOU,
  WIKI_CHAT_ACTION_FAILED,
  WIKI_CHAT_COMPLETE,
  WIKI_CHAT_GROUP_COMPLETED,
  WIKI_CHAT_GROUP_OPEN,
  WIKI_CHAT_HISTORY_TITLE,
  WIKI_CHAT_MOVE_TO_TRASH,
  WIKI_CHAT_NEW,
  WIKI_CHAT_NO_MATCH,
  WIKI_CHAT_RENAME,
  WIKI_CHAT_RENAME_FIELD,
  WIKI_CHAT_ROW_ACTIONS,
  WIKI_CHAT_SEARCH,
  WIKI_CHAT_SHOW_MORE,
  WIKI_CHAT_TRASH_NOTE,
  WIKI_CHAT_NEW_PARAM,
  WIKI_CHAT_OPEN_SESSION,
  WIKI_CHAT_RESIZE,
  WIKI_CHAT_RUNS_IN,
  WIKI_CHAT_TRASHED,
  WIKI_CHAT_WORKSPACE,
  WIKI_CHAT_WIDTH,
  sendChatTurn,
  sendWikiChatTurn,
  wikiChatCapped,
  wikiChatCardOf,
  wikiChatHistoryGroups,
  wikiChatHistoryLine,
  wikiChatOffline,
  wikiChatPanelMax,
  wikiChatQuoteCounts,
  wikiChatRemove,
  wikiChatRunsIn,
  wikiChatSendError,
  wikiChatShown,
  wikiChatShownFiles,
  wikiChatWorkspaceName,
  type ChatHostList,
  type WikiChatAttachAction,
  type WikiChatAttachments,
  type WikiChatCreate,
  type WikiChatDraftView,
  type WikiChatLayout,
  type WikiChatRow,
  type WikiChatWorkspace,
} from '../lib/wikiChat';
import {
  clampPermissionModeForEngine,
  DEFAULT_PERMISSION_MODE,
  defaultModelFor,
  effectiveSessionModel,
  effortOptionsFor,
  isLoginProvider,
  MODE_OPTIONS,
  modelOptionsFor,
  normalizeEffortFor,
  providerIdentityResolved,
  sessionEngineOf,
  supportsAuto,
  type ConfiguredProvider,
} from '../lib/workspaceDefaults';
import { wikiEntryPath, type WikiSpaceRow } from '../lib/wiki';
import { useApprovalDecisions } from '../lib/approvalDecisions';
import { wikiDocSectionPath } from '../lib/wikiDocs';
import { wikiPlanDocPath, wikiPlanPath } from '../lib/wikiPlan';
import { wikiSettingsPath } from '../lib/wikiReviewMode';

/**
 * What a page that docks the chat makes it (board drive-chat 01, owner Q1 A): its words, where its chats are read and
 * made, what a message carries beside the words from the composer's chips, and where a new chat may run. The panel,
 * the composer, the history and the button are the same on every page; the Wiki's origin adds its space, whose cards
 * open beside the chat.
 */
export interface ChatOrigin {
  copy: {
    /** The title's hover and the history's name: "Chats in this space", "Drive chats". */
    history: string;
    noHistory: string;
    emptyHint: string;
    emptyNote: string;
    placeholder: string;
    /** While a card of the chat is open (the Wiki's drafts); else the placeholder. */
    placeholderDraft?: string;
    /** Nowhere a chat can run: no composer, this instead. */
    noWorkspace: string;
    chooseWorkspace: string;
    /** Under a new chat's empty state while its box is empty: each fills the box and sends nothing. */
    examples?: readonly string[];
  };
  /** The chats read, made fresh after a chat is made or a row's action. */
  listKey: QueryKey;
  create: (body: Omit<WikiChatCreate, 'wikiContext'>, attachments: WikiChatAttachments) => Promise<{ sessionId: string }>;
  /** What a message carries beside its words from what the composer's chips show: `{ wikiContext }`, `{ driveContext }`. */
  turnContext: (attachments: WikiChatAttachments) => Record<string, unknown> | undefined;
  /** Where a new chat may run when the chats read does not list them (Drive: the owner's workspaces). */
  choices?: WikiChatWorkspace[];
  /** The Wiki's space: its chats' cards open its sections, entries and Review beside the chat, and the history is its
   *  chats. Absent, the history is the Drive chats. */
  space?: WikiSpaceRow;
  /** Drive: the chat shows its change cards and overwrite questions, each with its turn. */
  cards?: boolean;
}

/**
 * The panel the round button opens (design §4.1, board 42 ①): docked on the right of the page, or over it, or a
 * sheet, by the window's width (`wikiChatLayout`). Its head is the chat's title — pressed, the space's chats —
 * then `+` a new chat, `↗` the full session page, `✕` hide it (the chat goes on). A new chat's one line under the
 * head is Runs in, the workspace alone (board 43 ②); once the chat runs no workspace is shown, as on the session page.
 * The conversation is the session page's own (`SessionConversation`, with the approval cards answerable here), and
 * so is the composer (`SessionComposer`, board 43 ② ④ ⑤): the page and the selection are the first chips of its
 * attachment row, and everything else in it — pictures and files, the slash menu, the mode, the model with its effort
 * and speed, the gauges, Send and Stop, a message sent into a running turn or queued for the next — is the session
 * page's.
 */
export function WikiChatPanel({
  origin,
  chat,
  list,
  layout,
  width,
  top,
  attachments,
  dispatch,
  cards = null,
  focus = null,
  onChat,
  onClose,
  onResize,
  headerActions = null,
  view = null,
}: {
  origin: ChatOrigin;
  /** The chat shown: a session's public id, or `WIKI_CHAT_NEW_PARAM`. */
  chat: string;
  /** The chats read: undefined while it is read, null from a server that has none. */
  list: ChatHostList | null | undefined;
  layout: WikiChatLayout;
  width: number | null;
  /** Where the panel's top is, in the window: under the Wiki's head until that scrolls away. */
  top: number;
  attachments: WikiChatAttachments;
  dispatch: Dispatch<WikiChatAttachAction>;
  /** The shown chat's cards, oldest first (`GET /api/wiki/chats/:id/drafts`); null for a new chat or while read. */
  cards?: readonly WikiChatDraftView[] | null;
  /** The card to bring into view: a card's id, or `WIKI_CHAT_FOCUS_NEEDS_YOU` for the first that needs the owner. */
  focus?: string | null;
  onChat: (chat: string) => void;
  onClose: () => void;
  onResize: (width: number, done: boolean) => void;
  /** Extra buttons the host puts in the header, before ✕ (Drive's activity icon); the Wiki gives none. */
  headerActions?: ReactNode;
  /** A view the host shows in place of the chat, under its own title (Drive's activity); the chat stays mounted behind it. */
  view?: { title: string; body: ReactNode } | null;
}) {
  const navigate = useNavigate();
  const fresh = chat === WIKI_CHAT_NEW_PARAM;
  const sessionId = fresh ? null : (routeId(chat) ?? chat);
  // Its detail is re-read on the session's own events (useControlPlane refreshes `['session', id]`).
  const session = useQuery(sessionQuery(sessionId));
  const row = list?.chats.find((c) => c.sessionId === chat) ?? null;
  const chatTitle = (fresh ? null : (session.data?.title || row?.title)) || WIKI_CHAT_NEW;
  const [history, setHistory] = useState(false);
  // While the history shows, the title names it (board 45 ④ ①).
  const title = history ? WIKI_CHAT_HISTORY_TITLE : chatTitle;
  const viewed = view !== null;
  const [sheetFull, setSheetFull] = useState(false);
  // A chat's first message, kept from the create until its own conversation draws it.
  const [opening, setOpening] = useState<{ sessionId: string; message: ChatOpening } | null>(null);

  // A column stands from the window's top (board wiki-rail 03 Ⓑ); only a panel over the page keeps under the head.
  const style: CSSProperties = layout === 'sheet' ? {} : layout === 'over' ? { top, width: width ?? undefined } : { width: width ?? undefined };
  return (
    <aside
      className={`wk-chat-panel is-${layout}${layout === 'sheet' && sheetFull ? ' is-full' : ''}`}
      style={style}
      aria-label={chatTitle}
      onKeyDown={(event) => {
        // Esc leaves the history for the chat it was opened over (board 45 ④ ①).
        if (history && event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          setHistory(false);
        }
      }}
    >
      {layout === 'wide' && <WikiChatResizer width={width ?? WIKI_CHAT_WIDTH.panel.initial} onResize={onResize} />}
      {layout === 'sheet' && (
        <button type="button" className="wk-chat-grab" aria-label={WIKI_CHAT_RESIZE} onClick={() => setSheetFull((full) => !full)}>
          <span />
        </button>
      )}
      <div className="wk-chat-head">
        {viewed ? (
          <span className="wk-chat-title is-static"><span className="t">{view.title}</span></span>
        ) : (
          <Tooltip content={origin.copy.history} side="bottom" align="start">
            <button
              type="button"
              className="wk-chat-title"
              aria-expanded={history}
              onClick={() => setHistory((open) => !open)}
            >
              <span className="t">{title}</span>
              <CaretDownOutlined className="caret" />
            </button>
          </Tooltip>
        )}
        <Tooltip content={WIKI_CHAT_NEW} side="bottom">
          <button type="button" className="wk-chat-ib" aria-label={WIKI_CHAT_NEW} onClick={() => onChat(WIKI_CHAT_NEW_PARAM)}>
            <PlusOutlined />
          </button>
        </Tooltip>
        <Tooltip content={WIKI_CHAT_OPEN_SESSION} side="bottom">
          <button
            type="button"
            className="wk-chat-ib"
            aria-label={WIKI_CHAT_OPEN_SESSION}
            disabled={fresh || history || viewed}
            onClick={() => navigate(`/sessions/${encodeId(sessionId!)}`)}
          >
            <ArrowRightOutlined />
          </button>
        </Tooltip>
        {headerActions}
        <Tooltip content={WIKI_CHAT_CLOSE} side="bottom" align="end">
          <button type="button" className="wk-chat-ib" aria-label={WIKI_CHAT_CLOSE} onClick={onClose}>
            <CloseOutlined />
          </button>
        </Tooltip>
      </div>
      {viewed && <div className="wk-chat-view">{view.body}</div>}
      {history && !viewed && (
        <WikiChatHistory
          origin={origin}
          current={chat}
          onPick={(picked) => {
            setHistory(false);
            onChat(picked);
          }}
          onCurrentGone={() => onChat(WIKI_CHAT_NEW_PARAM)}
        />
      )}
      {/* Kept while the history shows, so what was typed stays (board 45 ④ ①). */}
      <div className="wk-chat-main" hidden={history || viewed}>
      {fresh ? (
        <WikiChatNew
          origin={origin}
          list={list}
          attachments={attachments}
          dispatch={dispatch}
          onCreated={(created, message) => {
            setOpening({ sessionId: routeId(created) ?? created, message });
            onChat(created);
          }}
        />
      ) : (
        <WikiChatSession
          key={sessionId!}
          sessionId={sessionId!}
          session={session.data ?? null}
          origin={origin}
          list={list}
          cards={cards}
          focus={focus}
          attachments={attachments}
          dispatch={dispatch}
          opening={opening?.sessionId === sessionId ? opening.message : null}
          onNewChat={() => onChat(WIKI_CHAT_NEW_PARAM)}
        />
      )}
      </div>
    </aside>
  );
}

/** The left edge of a wide panel, dragged between 320 and 560 (design §4.1). */
function WikiChatResizer({ width, onResize }: { width: number; onResize: (width: number, done: boolean) => void }) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const move = (event: ReactPointerEvent<HTMLDivElement>, done: boolean) => {
    if (!start.current) return;
    onResize(start.current.width + (start.current.x - event.clientX), done);
    if (done) start.current = null;
  };
  return (
    <div
      className="wk-chat-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={WIKI_CHAT_RESIZE}
      aria-valuemin={WIKI_CHAT_WIDTH.panel.min}
      aria-valuemax={wikiChatPanelMax(typeof window === 'undefined' ? WIKI_CHAT_WIDTH.wide : window.innerWidth)}
      aria-valuenow={width}
      onPointerDown={(event) => {
        start.current = { x: event.clientX, width };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => move(event, false)}
      onPointerUp={(event) => move(event, true)}
    />
  );
}

/**
 * The space's chats, as the title opens them over the whole panel (board 45 ④, owner 11-11: Q3 A, Q4 A; contract
 * `chat.panel.history`): a search over titles, Open — the ones that need the owner, then the working ones, then the
 * one last spoken in first — and Completed, folded. A row's ⋯ holds the session list's own Rename…, Open as a full
 * session, Complete and Move to Trash, through the same doors and with the session list's Undo; Trash itself stays the
 * session list's. Pages of rules.chatsListed come one at a time (contract `chat.list.page`).
 */
function WikiChatHistory({
  origin,
  current,
  onPick,
  onCurrentGone,
}: {
  origin: ChatOrigin;
  current: string;
  onPick: (chat: string) => void;
  /** The chat shown was moved to Trash: the panel turns to a new chat. */
  onCurrentGone: () => void;
}) {
  const [q, setQ] = useState('');
  const [completedOpen, setCompletedOpen] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  // The space's chats on the Wiki, the Drive chats on Drive: each read only where it is the history.
  const wikiPages = useInfiniteQuery({ ...wikiChatHistoryQuery(origin.space?.id ?? '', q.trim()), enabled: !!origin.space });
  const drivePages = useInfiniteQuery({ ...driveChatHistoryQuery(q.trim()), enabled: !origin.space });
  const pages = origin.space ? wikiPages : drivePages;
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const now = Date.now();

  const rows = useMemo(() => {
    const seen = new Set<string>();
    const all: WikiChatRow[] = [];
    for (const page of pages.data?.pages ?? []) {
      for (const row of page?.chats ?? []) {
        if (seen.has(row.sessionId)) continue;
        seen.add(row.sessionId);
        all.push(row);
      }
    }
    return all;
  }, [pages.data]);
  const groups = wikiChatHistoryGroups(rows);
  // A search shows what it found in Completed too, without asking for the fold to be opened.
  const showCompleted = completedOpen || q.trim() !== '';

  const refresh = (id: string) => {
    void qc.invalidateQueries({ queryKey: origin.listKey });
    void qc.invalidateQueries({ queryKey: ['session', id] });
    void qc.invalidateQueries({ queryKey: ['sessions'] });
  };
  const failed = (error: unknown) => toast.error(WIKI_CHAT_ACTION_FAILED, error instanceof Error ? error.message : undefined);
  const restore = useMutation({ mutationFn: (id: string) => restoreSession(id), onSettled: (_d, _e, id) => refresh(id), onError: failed });
  const complete = useMutation({
    mutationFn: (row: WikiChatRow) => completeSession(row.sessionId),
    onSuccess: (_d, row) =>
      toast.sessionAction({ sessionId: row.sessionId, sessionTitle: row.title, action: 'complete', onUndo: () => restore.mutate(row.sessionId) }),
    onSettled: (_d, _e, row) => refresh(row.sessionId),
    onError: failed,
  });
  const trash = useMutation({
    mutationFn: (row: WikiChatRow) => deleteSession(row.sessionId),
    onSuccess: (_d, row) => {
      if (row.sessionId === current) onCurrentGone();
      toast.sessionAction({ sessionId: row.sessionId, sessionTitle: row.title, action: 'trash', onUndo: () => restore.mutate(row.sessionId) });
    },
    onSettled: (_d, _e, row) => refresh(row.sessionId),
    onError: failed,
  });
  const rename = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => renameSession(id, title),
    onSettled: (_d, _e, { id }) => refresh(id),
    onError: failed,
  });
  const saveRename = () => {
    if (!renaming) return;
    const title = renaming.draft.trim();
    const was = rows.find((row) => row.sessionId === renaming.id)?.title ?? '';
    setRenaming(null);
    if (title && title !== was) rename.mutate({ id: renaming.id, title });
  };

  const rowOf = (row: WikiChatRow) => {
    const line = wikiChatHistoryLine(row, now);
    if (renaming?.id === row.sessionId) {
      return (
        <div key={row.sessionId} className="wk-chat-history-row is-renaming">
          <input
            className="wk-chat-history-rename"
            autoFocus
            maxLength={200}
            aria-label={WIKI_CHAT_RENAME_FIELD}
            value={renaming.draft}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setRenaming({ id: row.sessionId, draft: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                saveRename();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setRenaming(null);
              }
            }}
            onBlur={saveRename}
          />
        </div>
      );
    }
    return (
      <div key={row.sessionId} className={`wk-chat-history-row${row.sessionId === current ? ' on' : ''}`}>
        <button
          type="button"
          className="wk-chat-history-open"
          aria-current={row.sessionId === current ? 'true' : undefined}
          onClick={() => onPick(row.sessionId)}
        >
          <span className="t">{row.title || WIKI_CHAT_NEW}</span>
          <span className={`m is-${line.tone}`}>
            {line.tone === 'working' && <LoadingOutlined className="spin" />}
            {line.text}
          </span>
        </button>
        <Menu
          items={[
            { key: 'rename', label: WIKI_CHAT_RENAME, onSelect: () => window.setTimeout(() => setRenaming({ id: row.sessionId, draft: row.title }), 0) },
            { key: 'open', label: WIKI_CHAT_OPEN_SESSION, onSelect: () => navigate(`/sessions/${encodeId(row.sessionId)}`) },
            ...(row.completed ? [] : [{ key: 'complete', label: WIKI_CHAT_COMPLETE, onSelect: () => complete.mutate(row) }]),
            { type: 'separator' as const, key: 'divider' },
            { key: 'trash', label: WIKI_CHAT_MOVE_TO_TRASH, danger: true, onSelect: () => trash.mutate(row) },
          ]}
          trigger={
            <button type="button" className="wk-chat-history-more" aria-label={`${WIKI_CHAT_ROW_ACTIONS}: ${row.title || WIKI_CHAT_NEW}`}>
              <EllipsisOutlined />
            </button>
          }
        />
      </div>
    );
  };

  return (
    <div className="wk-chat-history" aria-label={origin.copy.history}>
      <label className="wk-chat-history-search">
        <SearchOutlined />
        <input type="search" placeholder={WIKI_CHAT_SEARCH} aria-label={WIKI_CHAT_SEARCH} value={q} onChange={(event) => setQ(event.target.value)} />
      </label>
      <div className="wk-chat-history-list">
        {pages.isPending ? null : rows.length === 0 ? (
          <div className="wk-chat-history-none">{q.trim() ? WIKI_CHAT_NO_MATCH : origin.copy.noHistory}</div>
        ) : (
          <>
            {groups.open.length > 0 && (
              <section aria-label={WIKI_CHAT_GROUP_OPEN}>
                <div className="wk-chat-history-group">
                  {WIKI_CHAT_GROUP_OPEN} <span className="n">{groups.open.length}</span>
                </div>
                {groups.open.map(rowOf)}
              </section>
            )}
            {groups.completed.length > 0 && (
              <section aria-label={WIKI_CHAT_GROUP_COMPLETED}>
                <button
                  type="button"
                  className="wk-chat-history-group is-fold"
                  aria-expanded={showCompleted}
                  onClick={() => setCompletedOpen((open) => !open)}
                >
                  {WIKI_CHAT_GROUP_COMPLETED} <span className="n">{groups.completed.length}</span>
                  {showCompleted ? <CaretDownOutlined className="caret" /> : <CaretRightOutlined className="caret" />}
                </button>
                {showCompleted && groups.completed.map(rowOf)}
              </section>
            )}
            {pages.hasNextPage && (
              <button type="button" className="wk-chat-history-more-page" disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
                {WIKI_CHAT_SHOW_MORE}
              </button>
            )}
          </>
        )}
        <p className="wk-chat-history-note">{WIKI_CHAT_TRASH_NOTE}</p>
      </div>
    </div>
  );
}

// ── The composer: the session page's own (board 43) ───────────────────────────────────────────

/** What a chat's first message showed when it went, painted at once as the session page paints a new session's. */
interface ChatOpening {
  text: string;
  attachments: Array<{ id: string; mime: string; name?: string }>;
}

/** A chat's session config as the composer's toolbar shows it, in the session's own values. */
interface ChatConfig {
  model: string;
  permissionMode: string;
  effort: string;
  fastMode: boolean;
}

type ChatConfigChange = Partial<ChatConfig>;

/** The runner a chat runs on, and the providers its models are read from — the account's keys and pools, as the
 *  session page reads them. */
function useChatMachine(runnerId: string | null | undefined) {
  const runners = useQuery(runnersQuery());
  const providers = useQuery(providersQuery());
  const pools = useQuery(providerPoolsQuery());
  const sharedPools = useQuery(sharedPoolsQuery());
  const configured = useMemo(
    () => [
      ...(providers.data ?? []),
      ...poolsAsProviders([...(sharedPools.data ?? []).map(sharedPoolAsProviderPool), ...(pools.data ?? [])]),
    ],
    [providers.data, pools.data, sharedPools.data],
  );
  const loaded = providers.data !== undefined && !pools.isPending && !sharedPools.isPending;
  const runner = ((runners.data ?? []).find((row) => row.id === runnerId) ?? null) as ChatRunner | null;
  return { runner, configured: configured as ConfiguredProvider[], loaded };
}

/** The runner fields the composer reads. */
type ChatRunner = Parameters<typeof SessionComposer>[0]['runner'] & {
  id: string;
  name: string;
  displayName?: string | null;
  commands?: Parameters<typeof composerSlashItems>[0];
  skills?: Parameters<typeof composerSlashItems>[1];
  runtimeDefaultModels?: Parameters<typeof effectiveSessionModel>[6];
  activeSessions?: number;
  maxConcurrent?: number;
};

const modeValue = (label: string): string => MODE_OPTIONS.find((option) => option.label === label)?.value ?? 'default';
const modeLabel = (value: string): string => MODE_OPTIONS.find((option) => option.value === value)?.label ?? 'Default';

/**
 * The composer toolbar's facts and picks for a chat, by the session page's own rules: the models of the engine and
 * provider the chat runs on, the mode the engine runs in with any gap from the one picked
 * (lib/sessionPermissionMode), the effort as that model takes it, a fast lane where there is one, and a
 * Cursor model's own settings. A pick says what it changes and `change` applies it — a new chat keeps it for its
 * create, a chat that runs writes its session's config — and, as on the session page, an effort picked is
 * remembered as the account's next.
 */
function useChatToolbar({
  engine,
  provider,
  runner,
  configured,
  resolved,
  current,
  codexSandboxUnavailable,
  recorded,
  change,
}: {
  engine: AgentProvider;
  provider: string;
  runner: ChatRunner | null;
  configured: ConfiguredProvider[];
  resolved: boolean;
  current: ChatConfig;
  codexSandboxUnavailable?: boolean;
  /** What the server recorded of a live chat's mode, and when this tab last picked one; absent for a new chat. */
  recorded?: { actual?: string | null; latest?: SessionPermissionModeChange | null; pickedAt?: number | null };
  change: (next: ChatConfigChange) => void;
}) {
  const qc = useQueryClient();
  const catalog = runner?.modelCatalog ?? null;
  const shownModel = current.model;
  const shownCursorPick = engine === AgentProvider.CURSOR ? cursorModelPick(shownModel, catalog) : null;
  const shownModelName = shownCursorPick?.model ?? shownModel;
  const catalogModelOptions = resolved ? modelOptionsFor(engine, provider, catalog, configured) : [];
  const shownModelOptions = catalogModelOptions.some((option) => option.value === shownModelName)
    ? catalogModelOptions
    : [{ value: shownModelName, label: shownModelName }, ...catalogModelOptions];
  const shownModelLabel = shownModelOptions.find((option) => option.value === shownModelName)?.label ?? shownModelName;
  const shownMode = modeLabel(current.permissionMode);
  const modeFacts = {
    intent: current.permissionMode,
    engine,
    modelHasAuto: !resolved || supportsAuto(shownModel, engine, provider, configured, catalog),
    modelLabel: shownModelLabel,
    runsAsRoot: runner?.runsAsRoot,
  };
  const modeCapsule = useModeCapsule({ ...modeFacts, ...recorded });
  const autoModeNote = autoMenuNote(modeFacts, !!recorded?.actual);
  const shownEffort = normalizeEffortFor(engine, provider, current.effort, shownModel, catalog, configured);
  const shownEffortOptions = effortOptionsFor(engine, provider, shownModel, catalog, configured);
  const shownEffortLabel = shownEffortOptions.find((option) => option.value === shownEffort)?.label ?? shownEffort;
  const fastModeUsable = resolved && fastModeAvailable(engine, shownModel, catalog);
  const cursorAuto = engine === AgentProvider.CURSOR && (!shownModelName || shownModelName === 'default');
  const cursorSettings = cursorAuto ? [] : cursorSettingRows(shownCursorPick);
  const onOwnModels = engine === AgentProvider.CLAUDE && !isLoginProvider(provider) && configured.some((p) => p.slug === provider);
  const permissionSemanticsFor = (label: string) =>
    derivePermissionSemantics(engine, modeValue(label), onOwnModels ? undefined : shownModel, runner?.runsAsRoot, catalog, codexSandboxUnavailable);

  const remember = (patch: { defaultEffort: string }) =>
    qc.setQueryData<Me>(meQuery().queryKey, (prev) =>
      prev ? { ...prev, preferences: { ...prev.preferences, defaultEffort: patch.defaultEffort } } : prev,
    );
  const pickModel = (model: string): void => {
    // The pick is this chat's alone: no account-wide model memory is written (docs/workspace-default-model-design.md).
    if (model === shownModelName) return;
    // An effort the model does not take goes too. The mode is not touched: on a model with no Auto the server runs an
    // Auto chat as Default and keeps the intent (docs/mocks/permission-mode-actual).
    const effort = normalizeEffortFor(engine, provider, current.effort, model, catalog, configured);
    change({ model, ...(effort !== current.effort ? { effort } : {}) });
  };
  const pickEffort = (effort: string): void => {
    if (effort === shownEffort) return;
    const normalized = normalizeEffortFor(engine, provider, effort, shownModel, catalog, configured);
    remember({ defaultEffort: normalized });
    void api('/users/me/preferences', { method: 'PATCH', body: { defaultEffort: normalized } }).catch(() => undefined);
    change({ effort: normalized });
  };
  const pickFastMode = (fastMode: boolean): void => {
    if (fastMode !== current.fastMode) change({ fastMode });
  };
  const pickCursorSetting = (id: string, value: string): void => {
    if (!shownCursorPick || cursorSettings.find((row) => row.id === id)?.value === value) return;
    change({ model: encodeCursorModel(shownCursorPick.model, { ...shownCursorPick.parameters, [id]: value }, shownCursorPick.row) });
  };
  const modelMenuItems = composerModelMenuItems({
    shownEngine: engine,
    engineTitle: engineTitleFor(engine),
    smartRoute: null,
    // Another provider or account is the full session page's (design §4.1).
    providerSwitchable: false,
    shownKeyGone: null,
    shownProviderValue: provider,
    providerMenuGroups: [],
    shownModelOptions,
    shownProviderCapabilitiesResolved: resolved,
    shownModelName,
    pickModel,
    cursorAuto,
    shownEffortLabel,
    shownEffortOptions,
    shownEffort,
    pickEffort,
    cursorSettings,
    pickCursorSetting,
    fastModeUsable,
    shownFastMode: current.fastMode,
    pickFastMode,
    openTask: () => undefined,
  });
  return {
    shownModel,
    shownMode,
    modeCapsule,
    autoModeNote,
    modeFacts,
    shownEffort,
    shownModelLabel,
    shownEffortLabel,
    cursorAuto,
    cursorSettings,
    fastModeUsable,
    shownFastMode: current.fastMode,
    permissionSemanticsFor,
    modelMenuItems,
    onMode: (label: string) => change({ permissionMode: modeValue(label) }),
  };
}

/** The draft a chat's composer holds: its words, their references, the history cursor and the staged files. */
function useChatDraft(sessionId: string | null, canAttach: boolean) {
  const [text, setText] = useState('');
  const [composerRefs, setComposerRefs] = useState<ReferenceMap>({});
  const [histIdx, setHistIdx] = useState(-1);
  const [histDraft, setHistDraft] = useState('');
  const [images, setImages] = useState<ComposerImage[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const { addImage, stageRestored, removeImage } = useComposerImages(canAttach, sessionId ?? undefined, setImages);
  // Staged files belong to this chat (they cannot go with another): their previews go with it, as the session page's do.
  const staged = useRef(images);
  staged.current = images;
  useEffect(() => () => staged.current.forEach((image) => image.previewUrl && URL.revokeObjectURL(image.previewUrl)), []);
  const clear = () => {
    setText((draft) => composerDraftAfterSend(draft, true));
    setComposerRefs({});
    setImages([]);
  };
  return {
    text,
    setText,
    composerRefs,
    setComposerRefs,
    histIdx,
    setHistIdx,
    histDraft,
    setHistDraft,
    images,
    readyImages: images.filter((image) => image.status === 'done' && image.id),
    uploading: images.some((image) => image.status === 'uploading'),
    taRef,
    addImage,
    removeImage,
    stageRestored,
    clear,
  };
}

/** The page (Drive: the folder) and the selection: the first chips of the composer's attachment row (board 43 ④), each with its cross. */
function wikiChatChips(attachments: WikiChatAttachments, dispatch: Dispatch<WikiChatAttachAction>): ReactNode {
  const { page, quote } = wikiChatShown(attachments);
  const files = wikiChatShownFiles(attachments);
  if (!page && !quote && !files) return null;
  return (
    <>
      {page && (
        <span className="composer-pill composer-file wk-chat-chip" data-kind={page.kind === 'folder' ? 'folder' : 'page'}>
          {page.kind === 'folder' ? <FolderOutlined className="composer-file-icon ic" /> : <ReadOutlined className="composer-file-icon ic" />}
          <span className="composer-file-name l">{page.label}</span>
          <button type="button" className="composer-file-remove x" aria-label={wikiChatRemove(page.label)} onClick={() => dispatch({ type: 'crossPage' })}>
            <CloseOutlined />
          </button>
        </span>
      )}
      {files && <FilesChip names={files.names} onCross={() => dispatch({ type: 'crossFiles' })} />}
      {quote && (
        <Tooltip content={quote.selected > quote.sentenceIds.length ? wikiChatCapped(quote.selected) : undefined} delay={TEXT_TOOLTIP_DELAY_MS}>
          <span
            className="composer-pill composer-file wk-chat-chip q"
            data-kind="quote"
          >
            <span className="composer-file-name q1">{quote.first}</span>
            <span className="composer-file-size sub">{wikiChatQuoteCounts(quote.sentenceIds.length, quote.sources)}</span>
            <button type="button" className="composer-file-remove x" aria-label={wikiChatRemove(quote.first)} onClick={() => dispatch({ type: 'crossQuote' })}>
              <CloseOutlined />
            </button>
          </span>
        </Tooltip>
      )}
    </>
  );
}

/** The rows selected in Drive's list as one chip, `12 files`, which opens to their names (board drive-chat 01 ③). */
function FilesChip({ names, onCross }: { names: readonly string[]; onCross: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const label = driveSelectionLabel(names);
  return (
    <span className="composer-pill composer-file wk-chat-chip" data-kind="files">
      <FileOutlined className="composer-file-icon ic" />
      <button type="button" className="composer-file-name l wk-chat-files-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {label}
      </button>
      {expanded && (
        <ul className="wk-chat-files-names" aria-label={label}>
          {names.map((name, index) => (
            <li key={`${name}-${index}`}>{name}</li>
          ))}
        </ul>
      )}
      <button type="button" className="composer-file-remove x" aria-label={wikiChatRemove(label)} onClick={onCross}>
        <CloseOutlined />
      </button>
    </span>
  );
}

/** What both of the panel's composers hand the session page's alike: the draft, the toolbar's facts and picks, and none of
 *  what only the session page has (an armed reply, a draft's workspace picker, a pool's account, a plan's quota). */
function sharedComposerProps(
  draft: ReturnType<typeof useChatDraft>,
  toolbar: ReturnType<typeof useChatToolbar>,
  modelMenu: ReturnType<typeof useModelMenuState>,
) {
  return {
    text: draft.text,
    setText: draft.setText,
    composerRefs: draft.composerRefs,
    setComposerRefs: draft.setComposerRefs,
    histIdx: draft.histIdx,
    setHistIdx: draft.setHistIdx,
    histDraft: draft.histDraft,
    setHistDraft: draft.setHistDraft,
    images: draft.images,
    readyImages: draft.readyImages,
    addImage: draft.addImage,
    removeImage: draft.removeImage,
    taRef: draft.taRef,
    composerDisabled: false,
    // The draft's words replace the first ones once a card loads: the empty field fits them again (board 43 ④).
    measureOnPlaceholder: true,
    replyTo: null,
    workspaceReadOnly: true,
    setWorkspaceId: () => undefined,
    ...modelMenu,
    shownMode: toolbar.shownMode,
    modeCapsule: toolbar.modeCapsule,
    autoModeNote: toolbar.autoModeNote,
    onDraftMode: toolbar.onMode,
    permissionSemanticsFor: toolbar.permissionSemanticsFor,
    modelMenuItems: toolbar.modelMenuItems,
    smartRoute: null,
    shownModelLabel: toolbar.shownModelLabel,
    shownEffortLabel: toolbar.shownEffortLabel,
    cursorAuto: toolbar.cursorAuto,
    fastModeUsable: toolbar.fastModeUsable,
    shownFastMode: toolbar.shownFastMode,
    cursorSettings: toolbar.cursorSettings,
    shownPool: null,
    shownPoolAccount: null,
    shownPlanUsage: null,
    shownModel: toolbar.shownModel,
    planUsageAccount: undefined,
    planUsageReset: undefined,
  } satisfies Partial<SessionComposerProps>;
}

/** `/status`, which the session page answers itself: what this chat runs on, as a card under the conversation. */
function statusCard(rows: Parameters<typeof localStatusRows>[0]): LocalStatusCard {
  return { id: `status-${Date.now()}-${Math.random().toString(36).slice(2)}`, rows: localStatusRows(rows) };
}

// ── A chat not started yet: where it will run, and its first message ───────────────────────────────

function WikiChatNew({
  origin,
  list,
  attachments,
  dispatch,
  onCreated,
}: {
  origin: ChatOrigin;
  list: ChatHostList | null | undefined;
  attachments: WikiChatAttachments;
  dispatch: Dispatch<WikiChatAttachAction>;
  onCreated: (sessionId: string, message: ChatOpening) => void;
}) {
  const qc = useQueryClient();
  const message = useToast();
  const [picked, setPicked] = useState<string | null>(null);
  const runsIn = list ? wikiChatRunsIn(origin.choices ? { workspace: list.workspace, choices: origin.choices } : list, picked) : null;
  const workspace = runsIn?.kind === 'chosen' ? runsIn.workspace : null;
  // The model, mode, effort and speed a chat on `workspace` starts with unless the owner picks others, read as a new
  // session of that workspace reads them: the workspace's provider and model, the runner's catalogue, the account's
  // mode and effort.
  const workspaces = useQuery(workspacesQuery());
  const me = useQuery(meQuery());
  const row = (workspaces.data ?? []).find((w) => w.id === workspace?.id) as
    | { provider?: string | null; model?: string | null; effort?: string | null; runnerId?: string | null }
    | undefined;
  const machine = useChatMachine(row?.runnerId);
  const catalog = machine.runner?.modelCatalog ?? null;
  const engine = sessionEngineOf(undefined, row?.provider, machine.configured);
  const provider = row?.provider ?? engine;
  const resolved = providerIdentityResolved(provider, machine.loaded);
  // The owner's picks, which alone go with the create: what is not picked starts as the workspace's sessions do.
  const [picks, setPicks] = useState<ChatConfigChange>({});
  const models = modelOptionsFor(engine, provider, catalog, machine.configured);
  const model =
    picks.model ??
    (row?.model && models.some((option) => option.value === row.model)
      ? row.model
      : defaultModelFor(engine, provider, catalog, machine.configured, machine.runner?.runtimeDefaultModels));
  const current: ChatConfig = {
    model,
    // Only a mode the engine refuses outright is replaced; Auto on a model with no Auto stays the pick.
    permissionMode:
      picks.permissionMode ??
      clampPermissionModeForEngine(me.data?.preferences?.defaultPermissionMode ?? DEFAULT_PERMISSION_MODE, engine),
    effort: picks.effort ?? row?.effort ?? me.data?.preferences?.defaultEffort ?? '',
    fastMode: picks.fastMode ?? false,
  };
  const toolbar = useChatToolbar({
    engine,
    provider,
    runner: machine.runner,
    configured: machine.configured,
    resolved,
    current,
    change: (next) => setPicks((previous) => ({ ...previous, ...next })),
  });
  const online = machine.runner?.online ?? workspace?.online ?? false;
  const draft = useChatDraft(null, !!workspace && online);
  // Why the first message did not go, in the server's words or as a lost connection (wikiChatSendError).
  const [failed, setFailed] = useState<string | null>(null);
  const [statusCards, setStatusCards] = useState<LocalStatusCard[]>([]);
  const modelMenu = useModelMenuState();
  const slashItems = useMemo(
    () => composerSlashItems(machine.runner?.commands, machine.runner?.skills, !supportsRunnerSlashAssets(engine), engine, workspace?.id),
    [machine.runner?.commands, machine.runner?.skills, engine, workspace?.id],
  );

  const create = useMutation({
    mutationFn: (vars: { content: string; images: ComposerImage[]; attachments: WikiChatAttachments }) =>
      origin.create(
        {
          workspaceId: workspace!.id,
          content: vars.content,
          ...(vars.images.length > 0 ? { attachmentIds: vars.images.map((image) => image.id!) } : {}),
          // Named only when the owner picked them; otherwise the chat starts as a session of its workspace does.
          ...(picks.model !== undefined ? { model: picks.model } : {}),
          ...(picks.permissionMode !== undefined ? { permissionMode: picks.permissionMode } : {}),
          ...(picks.effort !== undefined ? { effort: toolbar.shownEffort } : {}),
          ...(picks.fastMode !== undefined ? { fastMode: picks.fastMode } : {}),
        },
        vars.attachments,
      ),
    onSuccess: (created, vars) => {
      pushHistory(routeId(created.sessionId) ?? created.sessionId, vars.content);
      dispatch({ type: 'sent' });
      void qc.invalidateQueries({ queryKey: origin.listKey });
      // The create has no turn of this tab's to keep previews under: the transcript draws the files from the server.
      vars.images.forEach((image) => image.previewUrl && URL.revokeObjectURL(image.previewUrl));
      draft.clear();
      onCreated(created.sessionId, {
        text: vars.content,
        attachments: vars.images.flatMap((image) => (image.id ? [{ id: image.id, mime: image.mime || 'application/octet-stream', name: image.name }] : [])),
      });
    },
    onError: (error) => setFailed(wikiChatSendError(error)),
  });

  const onSend = (): void => {
    const words = draft.text.trim();
    if (create.isPending || !workspace) return;
    const command = slashCommandName(words);
    if (command !== null && isLocalSlashCommand(command)) {
      setStatusCards((previous) => [
        ...previous.slice(-4),
        statusCard({
          surface: 'Web',
          runnerName: workspace.runner ?? undefined,
          runnerOnline: online,
          sessionTitle: null,
          sessionStatus: null,
          workspaceName: workspace.name,
          engine: ENGINE_CLI_NAMES[engine],
          provider,
          model: toolbar.shownModel,
          permissionMode: toolbar.modeCapsule.label,
          effort: toolbar.shownEffort,
          fastMode: toolbar.fastModeUsable && toolbar.shownFastMode,
          contextTokens: 0,
        }),
      ]);
      draft.setText('');
      draft.setHistIdx(-1);
      return;
    }
    // As on the session page: a bare `/` names nothing to run.
    if (command === '' && supportsRunnerSlashAssets(engine)) {
      message.error('Pick a slash command before sending');
      return;
    }
    // A chat opens with the owner's words (contract `chat.create`): files ride with them, never alone.
    if (!words || draft.uploading) return;
    draft.setHistIdx(-1);
    setFailed(null);
    create.mutate({ content: materializeReferences(words, draft.composerRefs), images: draft.readyImages, attachments });
  };

  return (
    <>
      {runsIn?.kind === 'chosen' && (
        <div className="wk-chat-run">
          <span className="k">{WIKI_CHAT_RUNS_IN}</span>
          <WikiChatPick
            label={WIKI_CHAT_WORKSPACE}
            value={runsIn.workspace.id}
            shown={wikiChatWorkspaceName(runsIn.workspace)}
            options={runsIn.choices.map((choice) => ({ value: choice.id, label: wikiChatWorkspaceName(choice) }))}
            onChange={(id) => {
              setPicked(id);
              setPicks({});
            }}
          />
        </div>
      )}
      {runsIn?.kind === 'chosen' && !runsIn.workspace.online && runsIn.workspace.runner && (
        <div className="wk-chat-note">{wikiChatOffline(runsIn.workspace.runner)}</div>
      )}
      {runsIn?.kind === 'choose' && <WikiChatChoose title={origin.copy.chooseWorkspace} choices={runsIn.choices} onPick={setPicked} />}
      <div className="wk-chat-body">
        {runsIn?.kind === 'none' || list === null ? (
          <div className="wk-chat-empty">{origin.copy.noWorkspace}</div>
        ) : (
          <div className="wk-chat-empty">
            {origin.copy.emptyHint}
            <br />
            {origin.copy.emptyNote}
            {/* Examples while the box is empty: a press fills it and sends nothing (board drive-chat 01 ②). */}
            {origin.copy.examples && draft.text === '' && runsIn?.kind === 'chosen' && (
              <ul className="wk-chat-examples">
                {origin.copy.examples.map((example) => (
                  <li key={example}>
                    <button
                      type="button"
                      className="wk-chat-example"
                      onClick={() => {
                        draft.setText(example);
                        setTimeout(() => draft.taRef.current?.focus(), 0);
                      }}
                    >
                      “{example}”
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {statusCards.map((card) => (
          <SessionStatusCard card={card} key={card.id} />
        ))}
      </div>
      {runsIn && runsIn.kind !== 'none' && (
        <div className="wk-chat-composer">
          {failed && (
            <div className="wk-chat-failed" role="alert">
              {failed}
            </div>
          )}
          <SessionComposer
            {...sharedComposerProps(draft, toolbar, modelMenu)}
            selectedId={null}
            canAttach={!!workspace && online}
            attachmentsBefore={wikiChatChips(attachments, dispatch)}
            composerPlaceholder={origin.copy.placeholder}
            offeredSuggestion={null}
            acceptSuggestion={() => undefined}
            slashItems={slashItems}
            runner={machine.runner ?? { online }}
            workspacesForRunner={(workspaces.data ?? []).filter((w) => w.runnerId === row?.runnerId)}
            shellOffered={false}
            shellUnavailable
            live={false}
            configMut={{ mutate: () => undefined }}
            shownEngine={engine}
            configEditable
            contextTokens={0}
            shownProvider={provider}
            configuredProviders={machine.configured}
            showStop={false}
            onStop={() => undefined}
            canSend={runsIn.kind === 'chosen' && !create.isPending && !draft.uploading && !!draft.text.trim()}
            sending={create.isPending}
            onSend={onSend}
            queueOffered={false}
            defaultSendIntent="NEXT_TURN"
          />
        </div>
      )}
    </>
  );
}

/** The model chip's menu, open or not (the session page keeps it so another card can open it; nothing here does). */
function useModelMenuState() {
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [, setProviderMenuOpen] = useState(false);
  return { modelMenuOpen, setModelMenuOpen, setProviderMenuOpen };
}

/** The first chat, or one whose remembered workspace no longer qualifies: choose where it runs (§5.1). */
function WikiChatChoose({ title, choices, onPick }: { title: string; choices: readonly WikiChatWorkspace[]; onPick: (id: string) => void }) {
  return (
    <div className="wk-chat-choose">
      <div className="h">{title}</div>
      {choices.map((choice) => (
        <button type="button" key={choice.id} className="wk-chat-choice" onClick={() => onPick(choice.id)}>
          <span className="t">{choice.name}</span>
          {choice.runner && <span className="m">{choice.runner}</span>}
        </button>
      ))}
    </div>
  );
}

/** Runs in's picker, the native select under the words it shows (as the Wiki head's space picker). */
function WikiChatPick({
  label,
  value,
  shown,
  options,
  onChange,
}: {
  label: string;
  value: string;
  shown: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <Tooltip content={label}>
      <span className="wk-chat-pick">
        <span className="v">{shown}</span>
        <DownOutlined className="ic" />
        <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </span>
    </Tooltip>
  );
}

// ── A chat that runs: its conversation, what is waiting to be read, its next message ───────────────

/** The fields of a session's detail the panel reads. */
interface ChatSession {
  title?: string;
  workspace?: { id: string; name?: string } | null;
  assignedRunnerId?: string | null;
  engine?: string | null;
  provider?: string | null;
  model?: string | null;
  permissionMode?: string | null;
  /** The mode the server recorded the engine running in, and how it came to be, oldest first. */
  actualPermissionMode?: string | null;
  permissionModeChanges?: SessionPermissionModeChange[];
  codexSandboxUnavailable?: boolean;
  effort?: string | null;
  fastMode?: boolean | null;
  numTurns?: number;
  pendingApprovals?: number;
  waitingKind?: string | null;
  deletedAt?: string | null;
  /** The work a parked turn left running, which keeps Stop on as the session page keeps it (`outlivingSessionWork`). */
  runningSubagentCount?: number | null;
  runningBgCount?: number | null;
  runningBgJobCount?: number | null;
}

/** One message of the owner's into a running chat, as the composer sends it. */
interface ChatSendVars {
  content: string;
  images: ComposerImage[];
  intent: SessionTurnIntent;
  shell?: boolean;
  /** What rides beside the words: the origin's `turnContext` of the chips shown when it went. */
  context?: Record<string, unknown>;
}

function WikiChatSession({
  sessionId,
  session,
  origin,
  list,
  cards,
  focus,
  attachments,
  dispatch,
  opening,
  onNewChat,
}: {
  sessionId: string;
  session: (ChatSession & Parameters<typeof isSessionLive>[0]) | null;
  origin: ChatOrigin;
  list: ChatHostList | null | undefined;
  cards: readonly WikiChatDraftView[] | null;
  focus: string | null;
  attachments: WikiChatAttachments;
  dispatch: Dispatch<WikiChatAttachAction>;
  opening: ChatOpening | null;
  onNewChat: () => void;
}) {
  const machineNameOf = useMachineName();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const message = useToast();
  const workspaces = useQuery(workspacesQuery());
  const machine = useChatMachine(session?.assignedRunnerId);
  const runner = machine.runner;
  const catalog = runner?.modelCatalog ?? null;
  const live = !!session && !session.deletedAt && isSessionLive(session);
  const stream = useSessionStream({
    sessionId,
    live,
    runStatus: session ? sessionRunStatusOf(session) : undefined,
    runTerminal: !!session && isSessionTerminal(session),
  });
  const { setAcceptedUserTurns, setIdle, setApprovals, approvals, idle, queued, setQueued, visibleQueuedTurns, transcriptEvents } = stream;
  // Pictures this tab sent, by the turn they went with: drawn in the bubble and the tray until the server's copy is.
  const [turnImages, setTurnImages] = useState<Record<string, TurnImage[]>>({});

  // The first words of a chat just made paint at once, with their files, as the session page paints a new session's.
  useEffect(() => {
    if (!opening) return;
    setAcceptedUserTurns((current) => [
      ...current.filter((turn) => turn.key !== `initial:${sessionId}`),
      { key: `initial:${sessionId}`, sessionId, source: 'local', text: opening.text, acceptedAt: new Date().toISOString(), attachments: opening.attachments },
    ]);
  }, [opening, sessionId, setAcceptedUserTurns]);

  // ── What the toolbar shows and changes: the session's own config, changed as the session page changes it ──
  const engine = session ? sessionEngineOf(session.engine, session.provider, machine.configured) : AgentProvider.CLAUDE;
  const provider = session?.provider ?? engine;
  const resolved = providerIdentityResolved(provider, machine.loaded);
  const workspaceRow = (workspaces.data ?? []).find((w) => w.id === session?.workspace?.id) as
    | { model?: string | null; effort?: string | null; runnerId?: string | null }
    | undefined;
  const model = effectiveSessionModel(engine, provider, session?.model, workspaceRow?.model, catalog, machine.configured, runner?.runtimeDefaultModels);
  const me = useQuery(meQuery());
  // A session that stored no mode runs in the account's, else Auto, as the server resolves it.
  const permissionMode = session?.permissionMode ?? me.data?.preferences?.defaultPermissionMode ?? DEFAULT_PERMISSION_MODE;
  const current: ChatConfig = {
    model,
    permissionMode: resolved ? clampPermissionModeForEngine(permissionMode, engine) : permissionMode,
    effort: session?.effort ?? workspaceRow?.effort ?? '',
    fastMode: session?.fastMode === true,
  };
  // When this tab last picked the chat's mode: while the pick travels to the engine, the capsule says it is switching.
  const [modePickedAt, setModePickedAt] = useState<number | null>(null);
  const configMut = useMutation({
    mutationFn: (config: ChatConfigChange) => updateSessionConfig(sessionId, config),
    onMutate: async (config) => {
      if (config.permissionMode !== undefined) setModePickedAt(Date.now());
      const key = sessionQuery(sessionId).queryKey;
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData(key);
      qc.setQueryData(key, (old: unknown) => (old ? { ...(old as object), ...config } : old) as never);
      return { previous };
    },
    onError: (error: Error, config, context) => {
      if (context?.previous !== undefined) qc.setQueryData(sessionQuery(sessionId).queryKey, context.previous as never);
      // Named by what was picked, as the session page names it: a model switch carries the mode and effort that follow it.
      message.error(
        config.model !== undefined
          ? "Couldn't change the model"
          : config.permissionMode !== undefined
            ? "Couldn't change the mode"
            : config.effort !== undefined
              ? "Couldn't change the effort"
              : "Couldn't change the speed",
        error.message,
      );
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['session', sessionId] });
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
  // Only a live chat runs in a mode; an ended one's lines are no reason for a gap.
  const recordedMode = live ? session?.actualPermissionMode : null;
  const modeChanges = session?.deletedAt ? undefined : session?.permissionModeChanges;
  const toolbar = useChatToolbar({
    engine,
    provider,
    runner,
    configured: machine.configured,
    resolved,
    current,
    codexSandboxUnavailable: session?.codexSandboxUnavailable,
    recorded: { actual: recordedMode, latest: modeChanges?.at(-1) ?? null, pickedAt: modePickedAt },
    change: (config) => configMut.mutate(config),
  });
  const online = runner?.online ?? false;
  const draft = useChatDraft(sessionId, live && online);
  const [failed, setFailed] = useState<string | null>(null);
  const [statusCards, setStatusCards] = useState<LocalStatusCard[]>([]);
  const modelMenu = useModelMenuState();
  const codexComposer = !supportsRunnerSlashAssets(engine);
  const slashItems = useMemo(
    () => composerSlashItems(runner?.commands, runner?.skills, codexComposer, engine, session?.workspace?.id),
    [runner?.commands, runner?.skills, codexComposer, engine, session?.workspace?.id],
  );

  // ── What waits to be read: the tray over the composer, and the transcript's steers, as on the session page ──
  // A message handed back — withdrawn, or put back undelivered — joins the draft above whatever is being typed.
  const restoreUndelivered = useMemo(
    () =>
      session?.deletedAt
        ? null
        : (text: string, files?: readonly { id: string; mime?: string; mimeType?: string; name?: string }[]) => {
            const body = text.trim();
            if (!body) return;
            draft.setText((typed) => (typed.trim() ? `${typed}\n\n${body}` : body));
            draft.stageRestored(files);
            setTimeout(() => draft.taRef.current?.focus(), 0);
          },
    // The draft's setters keep their identity for the chat's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session?.deletedAt],
  );
  const runStatus = session ? sessionRunStatusOf(session) : null;
  const steerOffered = live && runStatus === 'RUNNING' && runtimeTakesMidTurnSteer(engine);
  const { steerWithdrawal, pendingTrayRows } = usePendingTray({
    selectedId: sessionId,
    selectedTrashed: !!session?.deletedAt,
    selectedMissing: false,
    queued,
    setQueued,
    visibleQueuedTurns,
    transcriptEvents,
    turnImages,
    restoreUndelivered,
    shownEngine: engine,
    steerOffered,
  });

  // ── Sending, by the session page's rules: into the running turn unless held or ⌥Enter, Stop with nothing typed ──
  const defaultSendIntent = defaultSessionTurnIntent({
    live,
    status: runStatus,
    numTurns: Number(session?.numTurns ?? 0),
    nextTurnQueued: visibleQueuedTurns.some((turn) => turn.placement === 'queued' && turn.delivery == null),
  });
  const generating = !!session && (isGenerating(session, sessionRunStateOf(session)) || outlivingSessionWork(session) !== null);
  const showStop = generating && !draft.text.trim() && draft.readyImages.length === 0;
  const queueOffered = defaultSendIntent === 'CURRENT_WORK' && !showStop && runtimeTakesMidTurnSteer(engine);

  /** Where a message landed: the next turn now (a bubble), or the tray — waiting for the next turn, or into this one. */
  const placed = (res: Awaited<ReturnType<typeof sendChatTurn>>, vars: Pick<ChatSendVars, 'content' | 'images' | 'shell'>) => {
    const placement = turnPlacementOf(res);
    if (placement === 'accepted') {
      setIdle(false);
      if (!vars.shell) {
        setAcceptedUserTurns((current) =>
          [
            ...current.filter((turn) => turn.key !== res.turnId),
            {
              key: res.turnId,
              sessionId,
              source: 'local' as const,
              turnId: res.turnId,
              text: vars.content,
              acceptedAt: new Date().toISOString(),
              attachments: vars.images.flatMap((image) =>
                image.id ? [{ id: image.id, mime: image.mime || 'application/octet-stream', name: image.name }] : [],
              ),
            },
          ].slice(-32),
        );
      }
      return;
    }
    const files = vars.images.flatMap((image) => (image.id ? [{ id: image.id, mimeType: image.mime }] : []));
    const item = {
      turnId: res.turnId,
      content: vars.content,
      shell: vars.shell,
      placement,
      ...(res.targetTurnId ? { targetTurnId: res.targetTurnId } : {}),
      ...(files.length ? { attachments: files } : {}),
    };
    setQueued((current) =>
      current.some((turn) => turn.turnId === item.turnId)
        ? current.map((turn) => (turn.turnId === item.turnId ? { ...turn, ...item } : turn))
        : [...current, item],
    );
  };

  const send = useMutation({
    mutationFn: (vars: ChatSendVars) =>
      sendChatTurn(sessionId, vars.content, vars.shell ? undefined : vars.context, {
        intent: vars.intent,
        attachmentIds: vars.images.flatMap((image) => (image.id ? [image.id] : [])),
        kind: vars.shell ? 'shell' : undefined,
      }),
    onSuccess: (res, vars) => {
      pushHistory(sessionId, vars.shell ? `!${vars.content}` : vars.content);
      // A shell command carries no page and no selection: what the composer shows stays for the next message.
      if (!vars.shell) dispatch({ type: 'sent' });
      const previews = vars.images.filter((image) => image.previewUrl);
      if (previews.length) {
        setTurnImages((current) => ({ ...current, [res.turnId]: previews.map((image) => ({ url: image.previewUrl as string, mime: image.mime })) }));
      }
      draft.clear();
      placed(res, vars);
      void qc.invalidateQueries({ queryKey: ['session', sessionId] });
    },
    onError: (error, vars) => {
      // No turn left to join: the message goes as the next turn it would have been a moment later (session page).
      if (isCurrentWorkUnavailable(error) && vars.intent === 'CURRENT_WORK') {
        send.mutate({ ...vars, intent: 'NEXT_TURN' });
        return;
      }
      setFailed(wikiChatSendError(error));
    },
  });

  const stop = useMutation({
    // The session page's Stop: the turn, and the background work it left running.
    mutationFn: () => interruptSession(sessionId, undefined, { stopBackgroundWork: true }),
    onSuccess: () => {
      // A stop drops what was queued behind it; what the owner typed comes back into the (empty) composer, files and all.
      const theirs = visibleQueuedTurns.filter(returnsToComposer);
      const restored = theirs
        .map((turn) => {
          const body = turn.content.trim();
          return body && turn.shell ? `!${body}` : body;
        })
        .filter(Boolean)
        .join('\n\n');
      if (restored) draft.setText(restored);
      draft.stageRestored(theirs.flatMap((turn) => turn.attachments ?? []));
      setQueued([]);
      void qc.invalidateQueries({ queryKey: ['session', sessionId] });
    },
    onError: (error: Error) => message.error("Couldn't stop the session", error.message),
  });

  const onSend = (intentOverride?: SessionTurnIntent): void => {
    const intent = intentOverride ?? defaultSendIntent;
    const words = draft.text.trim();
    if (send.isPending) return;
    const command = slashCommandName(words);
    if (command !== null) {
      if (isLocalSlashCommand(command)) {
        const { tokens, window } = lastContextReading(stream.events);
        setStatusCards((previous) => [
          ...previous.slice(-4),
          statusCard({
            surface: 'Web',
            runnerName: runner ? machineNameOf(runner) : undefined,
            runnerOnline: runner?.online,
            activeSessions: runner?.activeSessions,
            maxConcurrent: runner?.maxConcurrent,
            sessionTitle: session?.title ?? null,
            sessionStatus: session ? statusLabel(session, null, runner ? machineNameOf(runner) : null) : null,
            workspaceName: session?.workspace?.name,
            engine: ENGINE_CLI_NAMES[engine],
            provider,
            model: toolbar.shownModel,
            permissionMode: toolbar.modeCapsule.label,
            effort: toolbar.shownEffort,
            fastMode: toolbar.fastModeUsable && toolbar.shownFastMode,
            contextTokens: tokens,
            contextWindow: window,
          }),
        ]);
        draft.setText('');
        draft.setHistIdx(-1);
        return;
      }
      // As on the session page: a bare `/` names nothing to run.
      if (!codexComposer && !command) {
        message.error('Pick a slash command before sending');
        return;
      }
    }
    if (draft.uploading || (!words && draft.readyImages.length === 0)) return;
    draft.setHistIdx(-1);
    setFailed(null);
    if (words.startsWith('!')) {
      const command = words.slice(1).trim();
      if (command) send.mutate({ content: command, images: [], shell: true, intent: 'NEXT_TURN' });
      else draft.setText('');
      return;
    }
    send.mutate({ content: materializeReferences(words, draft.composerRefs), images: draft.readyImages, intent, context: origin.turnContext(attachments) });
  };

  // The engine's guess at the next message, offered in an idle, empty composer as on the session page.
  const offeredSuggestion = offeredPromptSuggestion(stream.eventsSessionId === sessionId ? currentPromptSuggestion(stream.events) : null, {
    idle,
    queuedTurns: visibleQueuedTurns.length,
    draftEmpty: draft.text === '' && draft.images.length === 0,
    replying: false,
    pendingApprovals: approvals.length + (session?.pendingApprovals ?? 0),
    waitingKind: session?.waitingKind,
    sendable: live && online,
    failed: !!session && sessionRunStatusOf(session) === 'FAILED',
  });
  const acceptSuggestion = (): void => {
    if (!offeredSuggestion) return;
    draft.setText(offeredSuggestion);
    if (draft.histIdx !== -1) draft.setHistIdx(-1);
    setTimeout(() => {
      const box = draft.taRef.current;
      if (!box) return;
      box.focus();
      box.selectionStart = box.selectionEnd = box.value.length;
    }, 0);
  };

  const { decide, untranslated } = useApprovalDecisions(sessionId, setApprovals);
  const driveCards = useDriveChatCards(origin.cards ? sessionId : null, stream.transcriptEvents);

  // Each recorded mode change where it happened, with who or what made it, as on the session page; one array,
  // memoized, as the transcript wants its inserts.
  const { intent, modelHasAuto, modelLabel, runsAsRoot } = toolbar.modeFacts;
  const transcriptInserts = useMemo(
    () => [
      ...driveCards.inserts,
      ...(modeChanges
        ? modeChangeInserts(
            modeChanges,
            { intent, actual: recordedMode, engine, modelHasAuto, modelLabel, runsAsRoot },
            stream.transcriptEvents,
          )
        : []),
    ],
    [driveCards.inserts, modeChanges, intent, recordedMode, engine, modelHasAuto, modelLabel, runsAsRoot, stream.transcriptEvents],
  );

  // The card the chat was opened at: one named, or the first that needs the owner (design §3).
  const focusCard = useMemo(() => {
    if (focus !== WIKI_CHAT_FOCUS_NEEDS_YOU) return focus;
    return (cards ?? []).find((card) => wikiChatCardNeedsYou(wikiChatCardOf(card)))?.id ?? null;
  }, [focus, cards]);

  // What the chat's cards open, they open beside it: a section on its document, an entry in its drawer, Review. A
  // card's own sentence (Redo) waits for the next turn, whatever the composer would do with one typed now. Only the
  // Wiki's chats have cards.
  const space = origin.space ?? null;
  const wikiCards = useMemo<WikiDraftCardHost | null>(
    () =>
      space && {
        spaceId: space.id,
        openSection: (doc, key) => navigate(wikiDocSectionPath(space.slug, doc, key)),
        openEntry: (entryId) => navigate(wikiEntryPath(space.slug, entryId)),
        openReview: (changesetId, seq) => navigate(wikiChatReviewPath(space.slug, changesetId, seq)),
        openSettings: () => navigate(wikiSettingsPath(space.slug)),
        openPlan: (docSlug) => navigate(docSlug ? wikiPlanDocPath(space.slug, docSlug) : wikiPlanPath(space.slug)),
        send: async (text) => placed(await sendWikiChatTurn(sessionId, text, undefined), { content: text, images: [] }),
        focus: focusCard,
      },
    // `placed` reads this chat's stream setters, which keep their identity for the chat's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [navigate, space, focusCard, sessionId],
  );

  // The newest card nearest the composer, as the session page keeps it — unless the chat was opened at a card, which is
  // brought into view once it is drawn, and once only: what arrives after it goes to the foot as ever.
  const bodyRef = useRef<HTMLDivElement>(null);
  const shown = stream.transcriptEvents.length;
  const focusedOnce = useRef<string | null>(null);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    if (focusCard && focusedOnce.current !== focusCard) {
      const card = body.querySelector<HTMLElement>(`[data-draft="${focusCard}"]`);
      if (card) {
        focusedOnce.current = focusCard;
        card.scrollIntoView?.({ block: 'center' });
      }
      return;
    }
    body.scrollTop = body.scrollHeight;
  }, [shown, approvals.length, focusCard, statusCards.length]);

  // A chat that takes no more messages says so, and offers a new one (C8 review); one the server retries by itself does not.
  const ended = !!session && (!!session.deletedAt || (!live && !sessionRetryPending(session)));
  const draftOpen = (cards ?? []).some((card) => card.state === 'draft' || card.state === 'changed');
  const { tokens: contextTokens, window: reportedContextWindow } = lastContextReading(stream.events);
  return (
    <>
      {runner && runner.online === false && <div className="wk-chat-note">{wikiChatOffline(machineNameOf(runner))}</div>}
      <div className="wk-chat-body" ref={bodyRef}>
        <SessionConversation
          sessionId={sessionId}
          stream={stream}
          live={live}
          turnImages={turnImages}
          inserts={transcriptInserts}
          authErrorHelp={null}
          autoRetryHelp={null}
          restoreUndelivered={restoreUndelivered}
          steerWithdrawal={steerWithdrawal}
          linkStateWord={orbitLinkStateWord}
          linkRefreshKey={0}
          answeredQuestions={null}
          wikiChat={wikiCards}
        />
        {driveCards.rest}
        {!session?.deletedAt &&
          approvals.map((approval) => (
            <ApprovalPanel
              key={approval.id}
              approval={approval}
              onDecide={decide}
              untranslated={untranslated[approval.id]}
              rememberable={approvalRememberOffered(engine ?? '')}
            />
          ))}
        {statusCards.map((card) => (
          <SessionStatusCard card={card} key={card.id} />
        ))}
      </div>
      {ended ? (
        <div className="wk-chat-ended" role="status">
          <span className="t">{session?.deletedAt ? WIKI_CHAT_TRASHED : WIKI_CHAT_ENDED}</span>
          <button type="button" className="wk-chat-ended-new" onClick={onNewChat}>
            <PlusOutlined className="ic" />
            {WIKI_CHAT_NEW}
          </button>
        </div>
      ) : (
        <div className="wk-chat-composer">
          <PendingTray rows={pendingTrayRows} note={engine === AgentProvider.CURSOR ? CURSOR_QUEUE_NOTE : null} />
          {failed && (
            <div className="wk-chat-failed" role="alert">
              {failed}
            </div>
          )}
          <SessionComposer
            {...sharedComposerProps(draft, toolbar, modelMenu)}
            selectedId={sessionId}
            canAttach={live && online}
            attachmentsBefore={wikiChatChips(attachments, dispatch)}
            composerPlaceholder={draftOpen ? (origin.copy.placeholderDraft ?? origin.copy.placeholder) : origin.copy.placeholder}
            offeredSuggestion={offeredSuggestion}
            acceptSuggestion={acceptSuggestion}
            slashItems={slashItems}
            runner={runner ?? { online: false }}
            workspacesForRunner={(workspaces.data ?? []).filter((w) => w.runnerId === session?.assignedRunnerId)}
            shellUnavailable={!live}
            live={live}
            configMut={configMut}
            shownEngine={engine}
            configEditable={live && online}
            contextTokens={contextTokens}
            reportedContextWindow={reportedContextWindow}
            shownProvider={provider}
            configuredProviders={machine.configured}
            showStop={showStop}
            onStop={() => !stop.isPending && stop.mutate()}
            stopping={stop.isPending}
            canSend={(!!draft.text.trim() || draft.readyImages.length > 0) && !send.isPending && !draft.uploading && live}
            sending={send.isPending}
            onSend={onSend}
            queueOffered={queueOffered}
            defaultSendIntent={defaultSendIntent}
          />
        </div>
      )}
    </>
  );
}

