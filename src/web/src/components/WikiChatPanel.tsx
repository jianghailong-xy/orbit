import { useEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRightOutlined,
  ArrowUpOutlined,
  BorderOutlined,
  CaretDownOutlined,
  CloseOutlined,
  DownOutlined,
  PlusOutlined,
  ReadOutlined,
} from '@ant-design/icons';
import { decideApproval, interruptSession, listApprovals, type PermissionRule } from '../api';
import { ApprovalPanel } from './ApprovalPanel';
import { SessionConversation } from './SessionConversation';
import { orbitLinkStateWord } from './WorkspaceView';
import { wikiChatReviewPath, type WikiDraftCardHost } from './WikiDraftCard';
import { approvalRememberOffered } from '../lib/dshRuntime';
import { encodeId, routeId } from '../lib/idCodec';
import { machineName } from '../lib/machineSetup';
import { meQuery, providersQuery, runnersQuery, sessionQuery, wikiChatsQuery, workspacesQuery } from '../lib/queries';
import { isSessionLive, isSessionTerminal, sessionRetryPending, sessionRunStatusOf } from '../lib/sessionState';
import { useSessionStream } from '../lib/useSessionStream';
import {
  WIKI_CHAT_CHOOSE_WORKSPACE,
  WIKI_CHAT_CLOSE,
  WIKI_CHAT_ENDED,
  WIKI_CHAT_FOCUS_NEEDS_YOU,
  WIKI_CHAT_EMPTY_HINT,
  WIKI_CHAT_EMPTY_NOTE,
  WIKI_CHAT_HISTORY,
  WIKI_CHAT_MODE,
  WIKI_CHAT_MODEL,
  WIKI_CHAT_NEW,
  WIKI_CHAT_NEW_PARAM,
  WIKI_CHAT_NO_HISTORY,
  WIKI_CHAT_NO_WORKTREE,
  WIKI_CHAT_OPEN_SESSION,
  WIKI_CHAT_PLACEHOLDER,
  WIKI_CHAT_PLACEHOLDER_DRAFT,
  WIKI_CHAT_RESIZE,
  WIKI_CHAT_RUNS_IN,
  WIKI_CHAT_SEND,
  WIKI_CHAT_STOP,
  WIKI_CHAT_TRASHED,
  WIKI_CHAT_WORKSPACE,
  WIKI_CHAT_WIDTH,
  createWikiChat,
  sendWikiChatTurn,
  wikiChatCapped,
  wikiChatCardOf,
  wikiChatContext,
  wikiChatOffline,
  wikiChatQuoteCounts,
  wikiChatRemove,
  wikiChatRunLine,
  wikiChatRunsIn,
  wikiChatSendError,
  wikiChatShown,
  wikiChatWorkspaceName,
  type WikiChatAttachAction,
  type WikiChatAttachments,
  type WikiChatDraftView,
  type WikiChatLayout,
  type WikiChatList,
  type WikiChatWorkspace,
} from '../lib/wikiChat';
import {
  DEFAULT_PERMISSION_MODE,
  MODE_OPTIONS,
  clampPermissionModeForModel,
  defaultModelFor,
  modelOptionsFor,
  permissionModeSupported,
  sessionEngineOf,
  supportsAuto,
  type ConfiguredProvider,
} from '../lib/workspaceDefaults';
import { wikiChatCardNeedsYou } from '@orbit/shared';
import { wikiEntryPath, type WikiSpaceRow } from '../lib/wiki';
import { wikiDocSectionPath } from '../lib/wikiDocs';
import { wikiPlanPath } from '../lib/wikiPlan';
import { wikiSettingsPath } from '../lib/wikiReviewMode';

/**
 * The panel the round button opens (design §4.1, board 42 ①): docked on the right of the page, or over it, or a
 * sheet, by the window's width (`wikiChatLayout`). Its head is the chat's title — pressed, the space's chats —
 * then `+` a new chat, `↗` the full session page, `✕` hide it (the chat goes on). Under the head, one line says
 * where it runs; before the first message that line is the choice of it (Runs in). The conversation is the
 * session page's own (`SessionConversation`, with the approval cards answerable here); the composer is a short
 * one: words, the attachments, Send and Stop. Everything else is on the full session page.
 */
export function WikiChatPanel({
  space,
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
}: {
  space: WikiSpaceRow;
  /** The chat shown: a session's public id, or `WIKI_CHAT_NEW_PARAM`. */
  chat: string;
  /** The space's chats read: undefined while it is read, null from a server that has none. */
  list: WikiChatList | null | undefined;
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
}) {
  const navigate = useNavigate();
  const fresh = chat === WIKI_CHAT_NEW_PARAM;
  const sessionId = fresh ? null : (routeId(chat) ?? chat);
  // Its detail is re-read on the session's own events (useControlPlane refreshes `['session', id]`).
  const session = useQuery(sessionQuery(sessionId));
  const row = list?.chats.find((c) => c.sessionId === chat) ?? null;
  const title = (fresh ? null : (session.data?.title || row?.title)) || WIKI_CHAT_NEW;
  const [history, setHistory] = useState(false);
  const [sheetFull, setSheetFull] = useState(false);
  // A chat's first words, kept from the create until its own conversation draws them.
  const [opening, setOpening] = useState<{ sessionId: string; text: string } | null>(null);

  const style: CSSProperties = layout === 'sheet' ? {} : { top, width: width ?? undefined };
  return (
    <aside
      className={`wk-chat-panel is-${layout}${layout === 'sheet' && sheetFull ? ' is-full' : ''}`}
      style={style}
      aria-label={title}
    >
      {layout === 'wide' && <WikiChatResizer width={width ?? WIKI_CHAT_WIDTH.panel.initial} onResize={onResize} />}
      {layout === 'sheet' && (
        <button type="button" className="wk-chat-grab" aria-label={WIKI_CHAT_RESIZE} onClick={() => setSheetFull((full) => !full)}>
          <span />
        </button>
      )}
      <div className="wk-chat-head">
        <button
          type="button"
          className="wk-chat-title"
          aria-haspopup="listbox"
          aria-expanded={history}
          title={WIKI_CHAT_HISTORY}
          onClick={() => setHistory((open) => !open)}
        >
          <span className="t">{title}</span>
          <CaretDownOutlined className="caret" />
        </button>
        <button type="button" className="wk-chat-ib" aria-label={WIKI_CHAT_NEW} title={WIKI_CHAT_NEW} onClick={() => onChat(WIKI_CHAT_NEW_PARAM)}>
          <PlusOutlined />
        </button>
        <button
          type="button"
          className="wk-chat-ib"
          aria-label={WIKI_CHAT_OPEN_SESSION}
          title={WIKI_CHAT_OPEN_SESSION}
          disabled={fresh}
          onClick={() => navigate(`/sessions/${encodeId(sessionId!)}`)}
        >
          <ArrowRightOutlined />
        </button>
        <button type="button" className="wk-chat-ib" aria-label={WIKI_CHAT_CLOSE} title={WIKI_CHAT_CLOSE} onClick={onClose}>
          <CloseOutlined />
        </button>
      </div>
      {history && (
        <WikiChatHistory
          list={list}
          current={chat}
          onPick={(picked) => {
            setHistory(false);
            onChat(picked);
          }}
        />
      )}
      {fresh ? (
        <WikiChatNew
          space={space}
          list={list}
          attachments={attachments}
          dispatch={dispatch}
          onCreated={(created, text) => {
            setOpening({ sessionId: routeId(created) ?? created, text });
            onChat(created);
          }}
        />
      ) : (
        <WikiChatSession
          key={sessionId!}
          sessionId={sessionId!}
          session={session.data ?? null}
          space={space}
          list={list}
          cards={cards}
          focus={focus}
          attachments={attachments}
          dispatch={dispatch}
          opening={opening?.sessionId === sessionId ? opening.text : null}
          onNewChat={() => onChat(WIKI_CHAT_NEW_PARAM)}
        />
      )}
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
      aria-valuemax={WIKI_CHAT_WIDTH.panel.max}
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

/** The space's chats, newest first, as the title opens them (design §4.1: the title is the chat history). */
function WikiChatHistory({ list, current, onPick }: { list: WikiChatList | null | undefined; current: string; onPick: (chat: string) => void }) {
  const chats = list?.chats ?? [];
  return (
    <div className="wk-chat-history" role="listbox" aria-label={WIKI_CHAT_HISTORY}>
      {chats.length === 0 ? (
        <div className="wk-chat-history-none">{WIKI_CHAT_NO_HISTORY}</div>
      ) : (
        chats.map((row) => (
          <button
            type="button"
            role="option"
            aria-selected={row.sessionId === current}
            key={row.sessionId}
            className={`wk-chat-history-row${row.sessionId === current ? ' on' : ''}`}
            onClick={() => onPick(row.sessionId)}
          >
            <span className="t">{row.title || WIKI_CHAT_NEW}</span>
            {row.needsYou > 0 && <span className="n">{row.needsYou}</span>}
          </button>
        ))
      )}
    </div>
  );
}

// ── A chat not started yet: where it will run, and its first message ───────────────────────────────

/**
 * The model and mode a chat on `workspace` starts with unless the owner picks others, read as a new session of
 * that workspace reads them: the workspace's provider and model, the runner's catalogue, the account's mode.
 */
function useChatDefaults(workspaceId: string | null) {
  const workspaces = useQuery(workspacesQuery());
  const runners = useQuery(runnersQuery());
  const providers = useQuery(providersQuery());
  const me = useQuery(meQuery());
  return useMemo(() => {
    const workspace = (workspaces.data ?? []).find((row) => row.id === workspaceId) as
      | { provider?: string | null; model?: string | null; runnerId?: string | null }
      | undefined;
    const configured = (providers.data ?? []) as ConfiguredProvider[];
    const runner = (runners.data ?? []).find((row) => row.id === workspace?.runnerId) as { modelCatalog?: never } | undefined;
    const catalog = runner?.modelCatalog ?? null;
    const engine = sessionEngineOf(undefined, workspace?.provider, configured);
    const provider = workspace?.provider ?? engine;
    const models = modelOptionsFor(engine, provider, catalog, configured);
    const model = workspace?.model && models.some((o) => o.value === workspace.model) ? workspace.model : defaultModelFor(engine, provider, catalog, configured);
    const modeFor = (picked: string) =>
      MODE_OPTIONS.filter(
        (o) => permissionModeSupported(o.value, engine) && (o.value !== 'auto' || supportsAuto(picked, engine, provider, configured, catalog)),
      );
    const mode = clampPermissionModeForModel(
      me.data?.preferences?.defaultPermissionMode ?? DEFAULT_PERMISSION_MODE,
      model,
      engine,
      provider,
      configured,
      catalog,
    );
    return { models, model, mode, modeFor };
  }, [workspaces.data, runners.data, providers.data, me.data, workspaceId]);
}

function WikiChatNew({
  space,
  list,
  attachments,
  dispatch,
  onCreated,
}: {
  space: WikiSpaceRow;
  list: WikiChatList | null | undefined;
  attachments: WikiChatAttachments;
  dispatch: Dispatch<WikiChatAttachAction>;
  onCreated: (sessionId: string, text: string) => void;
}) {
  const qc = useQueryClient();
  const [picked, setPicked] = useState<string | null>(null);
  const runsIn = list ? wikiChatRunsIn(list, picked) : null;
  const workspace = runsIn?.kind === 'chosen' ? runsIn.workspace : null;
  const defaults = useChatDefaults(workspace?.id ?? null);
  const [model, setModel] = useState<string | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const shownModel = model ?? defaults.model;
  const shownMode = mode ?? defaults.mode;

  const send = async (text: string) => {
    const created = await createWikiChat(space.id, {
      workspaceId: workspace!.id,
      content: text,
      wikiContext: wikiChatContext(attachments),
      // Named only when the owner picked them; otherwise the chat starts as a session of its workspace does.
      ...(model !== null ? { model } : {}),
      ...(mode !== null ? { permissionMode: mode } : {}),
    });
    dispatch({ type: 'sent' });
    void qc.invalidateQueries({ queryKey: wikiChatsQuery(space.id).queryKey });
    onCreated(created.sessionId, text);
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
              setModel(null);
              setMode(null);
            }}
          />
          {defaults.models.length > 0 && (
            <WikiChatPick
              label={WIKI_CHAT_MODEL}
              value={shownModel}
              shown={defaults.models.find((o) => o.value === shownModel)?.label ?? shownModel}
              options={defaults.models}
              onChange={setModel}
            />
          )}
          <WikiChatPick
            label={WIKI_CHAT_MODE}
            value={shownMode}
            shown={MODE_OPTIONS.find((o) => o.value === shownMode)?.label ?? shownMode}
            options={defaults.modeFor(shownModel)}
            onChange={setMode}
          />
        </div>
      )}
      {runsIn?.kind === 'chosen' && !runsIn.workspace.online && runsIn.workspace.runner && (
        <div className="wk-chat-note">{wikiChatOffline(runsIn.workspace.runner)}</div>
      )}
      {runsIn?.kind === 'choose' && <WikiChatChoose choices={runsIn.choices} onPick={setPicked} />}
      <div className="wk-chat-body">
        {runsIn?.kind === 'none' || list === null ? (
          <div className="wk-chat-empty">{WIKI_CHAT_NO_WORKTREE}</div>
        ) : (
          <div className="wk-chat-empty">
            {WIKI_CHAT_EMPTY_HINT}
            <br />
            {WIKI_CHAT_EMPTY_NOTE}
          </div>
        )}
      </div>
      {runsIn && runsIn.kind !== 'none' && (
        <WikiChatComposer attachments={attachments} dispatch={dispatch} ready={runsIn.kind === 'chosen'} busy={false} onSend={send} />
      )}
    </>
  );
}

/** The space's first chat, or one whose remembered workspace no longer qualifies: choose where it runs (§5.1). */
function WikiChatChoose({ choices, onPick }: { choices: readonly WikiChatWorkspace[]; onPick: (id: string) => void }) {
  return (
    <div className="wk-chat-choose">
      <div className="h">{WIKI_CHAT_CHOOSE_WORKSPACE}</div>
      {choices.map((choice) => (
        <button type="button" key={choice.id} className="wk-chat-choice" onClick={() => onPick(choice.id)}>
          <span className="t">{choice.name}</span>
          {choice.runner && <span className="m">{choice.runner}</span>}
        </button>
      ))}
    </div>
  );
}

/** One of Runs in's pickers, the native select under the words it shows (as the Wiki head's space picker). */
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
    <span className="wk-chat-pick" title={label}>
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
  );
}

// ── A chat that runs: where, its conversation, its next message ───────────────────────────────────

/** The fields of a session's detail its run line reads. */
interface ChatSession {
  title?: string;
  workspace?: { id: string; name?: string } | null;
  assignedRunnerId?: string | null;
  engine?: string | null;
  provider?: string | null;
  model?: string | null;
  permissionMode?: string | null;
  deletedAt?: string | null;
}

function WikiChatSession({
  sessionId,
  session,
  space,
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
  space: WikiSpaceRow;
  list: WikiChatList | null | undefined;
  cards: readonly WikiChatDraftView[] | null;
  focus: string | null;
  attachments: WikiChatAttachments;
  dispatch: Dispatch<WikiChatAttachAction>;
  opening: string | null;
  onNewChat: () => void;
}) {
  const navigate = useNavigate();
  const runners = useQuery(runnersQuery());
  const providers = useQuery(providersQuery());
  const runner = (runners.data ?? []).find((row) => row.id === session?.assignedRunnerId) as
    | { name: string; displayName?: string | null; online?: boolean; modelCatalog?: never }
    | undefined;
  const live = !!session && !session.deletedAt && isSessionLive(session);
  const stream = useSessionStream({
    sessionId,
    live,
    runStatus: session ? sessionRunStatusOf(session) : undefined,
    runTerminal: !!session && isSessionTerminal(session),
  });
  const { setAcceptedUserTurns, setIdle, setApprovals, approvals, idle } = stream;

  // The first words of a chat just made paint at once, as the session page paints a new session's.
  useEffect(() => {
    if (!opening) return;
    setAcceptedUserTurns((current) => [
      ...current.filter((turn) => turn.key !== `initial:${sessionId}`),
      { key: `initial:${sessionId}`, sessionId, source: 'local', text: opening, acceptedAt: new Date().toISOString(), attachments: [] },
    ]);
  }, [opening, sessionId, setAcceptedUserTurns]);

  const machine = runner ? machineName(runner) : list?.workspace && list.workspace.id === session?.workspace?.id ? list.workspace.runner : null;
  const engine = session ? sessionEngineOf(session.engine, session.provider, (providers.data ?? []) as ConfiguredProvider[]) : null;
  const models = engine ? modelOptionsFor(engine, session?.provider, runner?.modelCatalog ?? null, (providers.data ?? []) as ConfiguredProvider[]) : [];
  const line = wikiChatRunLine([
    session?.workspace?.name,
    machine,
    session?.model ? (models.find((o) => o.value === session.model)?.label ?? session.model) : null,
    session?.permissionMode ? (MODE_OPTIONS.find((o) => o.value === session.permissionMode)?.label ?? session.permissionMode) : null,
  ]);

  const decide = async (
    approvalId: string,
    behavior: 'allow' | 'deny',
    answers?: Record<string, string[]>,
    message?: string,
    rememberRules?: PermissionRule[],
    startAfterCreate?: boolean,
  ): Promise<void> => {
    setApprovals((previous) => previous.filter((approval) => approval.id !== approvalId));
    try {
      await decideApproval(sessionId, approvalId, behavior, message, answers, rememberRules, startAfterCreate);
    } catch {
      listApprovals(sessionId)
        .then(setApprovals)
        .catch(() => undefined);
    }
  };

  /** One message of the owner's: what the composer sends with its attachments, and Redo's sentence with none. */
  const post = async (text: string, context: ReturnType<typeof wikiChatContext>) => {
    const sent = await sendWikiChatTurn(sessionId, text, context);
    if (sent.placement !== 'queued') {
      setIdle(false);
      setAcceptedUserTurns((current) => [
        ...current.filter((turn) => turn.key !== sent.turnId),
        { key: sent.turnId, sessionId, source: 'local', turnId: sent.turnId, text, acceptedAt: new Date().toISOString(), attachments: [] },
      ]);
    }
  };
  const send = async (text: string) => {
    await post(text, wikiChatContext(attachments));
    dispatch({ type: 'sent' });
  };

  // The card the chat was opened at: one named, or the first that needs the owner (design §3).
  const focusCard = useMemo(() => {
    if (focus !== WIKI_CHAT_FOCUS_NEEDS_YOU) return focus;
    return (cards ?? []).find((card) => wikiChatCardNeedsYou(wikiChatCardOf(card)))?.id ?? null;
  }, [focus, cards]);

  // What the chat's cards open, they open beside it: a section on its document, an entry in its drawer, Review.
  const wikiCards = useMemo<WikiDraftCardHost>(
    () => ({
      spaceId: space.id,
      openSection: (doc, key) => navigate(wikiDocSectionPath(space.slug, doc, key)),
      openEntry: (entryId) => navigate(wikiEntryPath(space.slug, entryId)),
      openReview: (changesetId, seq) => navigate(wikiChatReviewPath(space.slug, changesetId, seq)),
      openSettings: () => navigate(wikiSettingsPath(space.slug)),
      openPlan: () => navigate(wikiPlanPath(space.slug)),
      send: (text) => post(text, undefined),
      focus: focusCard,
    }),
    // `post` reads this chat's stream setters, which keep their identity for the chat's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [navigate, space.id, space.slug, focusCard, sessionId],
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
  }, [shown, approvals.length, focusCard]);

  const busy = live && !idle;
  // A chat that takes no more messages says so, and offers a new one (C8 review); one the server retries by itself does not.
  const ended = !!session && (!!session.deletedAt || (!live && !sessionRetryPending(session)));
  const draftOpen = (cards ?? []).some((card) => card.state === 'draft' || card.state === 'changed');
  return (
    <>
      <div className="wk-chat-run line">{line}</div>
      {runner && runner.online === false && <div className="wk-chat-note">{wikiChatOffline(machineName(runner))}</div>}
      <div className="wk-chat-body" ref={bodyRef}>
        <SessionConversation
          sessionId={sessionId}
          stream={stream}
          live={live}
          turnImages={NO_IMAGES}
          inserts={NO_INSERTS}
          authErrorHelp={null}
          autoRetryHelp={null}
          restoreUndelivered={null}
          steerWithdrawal={null}
          linkStateWord={orbitLinkStateWord}
          linkRefreshKey={0}
          answeredQuestions={null}
          wikiChat={wikiCards}
        />
        {!session?.deletedAt &&
          approvals.map((approval) => (
            <ApprovalPanel
              key={approval.id}
              approval={approval}
              onDecide={decide}
              rememberable={approvalRememberOffered(engine ?? '')}
            />
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
        <WikiChatComposer
          attachments={attachments}
          dispatch={dispatch}
          ready={live || !session}
          busy={busy}
          placeholder={draftOpen ? WIKI_CHAT_PLACEHOLDER_DRAFT : WIKI_CHAT_PLACEHOLDER}
          onSend={send}
          onStop={() => void interruptSession(sessionId).catch(() => undefined)}
        />
      )}
    </>
  );
}

const NO_IMAGES = {};
const NO_INSERTS: never[] = [];

// ── The composer ──────────────────────────────────────────────────────────────────────────────────

/**
 * The short composer (design §4.1, board 42 ①): the attachments as chips — the page, then the quote — each with
 * its cross; the words; Send; and Stop while a turn runs. What the chips show is what the message sends, and it is
 * frozen when the message goes (`wikiChatContext`). Enter sends, Shift+Enter breaks the line.
 */
function WikiChatComposer({
  attachments,
  dispatch,
  ready,
  busy,
  placeholder = WIKI_CHAT_PLACEHOLDER,
  onSend,
  onStop,
}: {
  attachments: WikiChatAttachments;
  dispatch: Dispatch<WikiChatAttachAction>;
  /** Whether a message can go now: a workspace is chosen, the session takes turns. */
  ready: boolean;
  busy: boolean;
  /** `Reply, or say what to change in the draft` while a card of the chat is open (board 42 ②). */
  placeholder?: string;
  onSend: (text: string) => Promise<void>;
  onStop?: () => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  // Why the last message did not go, in the server's words or as a lost connection (wikiChatSendError).
  const [failed, setFailed] = useState<string | null>(null);
  const { page, quote } = wikiChatShown(attachments);
  const canSend = ready && !sending && text.trim().length > 0;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    setSending(true);
    setFailed(null);
    try {
      // The owner's words go as they were typed: they are the message, and a source (contract `chat.create`).
      await onSend(text);
      setText('');
    } catch (error) {
      setFailed(wikiChatSendError(error));
    } finally {
      setSending(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <form className="wk-chat-compose" onSubmit={(event) => void submit(event)}>
      {(page || quote) && (
        <div className="wk-chat-chips">
          {page && (
            <span className="wk-chat-chip" data-kind="page">
              <ReadOutlined className="ic" />
              <span className="l">{page.label}</span>
              <button type="button" className="x" aria-label={wikiChatRemove(page.label)} onClick={() => dispatch({ type: 'crossPage' })}>
                <CloseOutlined />
              </button>
            </span>
          )}
          {quote && (
            <span
              className="wk-chat-chip q"
              data-kind="quote"
              title={quote.selected > quote.sentenceIds.length ? wikiChatCapped(quote.selected) : undefined}
            >
              <span className="q1">{quote.first}</span>
              <span className="sub">{wikiChatQuoteCounts(quote.sentenceIds.length, quote.sources)}</span>
              <button type="button" className="x" aria-label={wikiChatRemove(quote.first)} onClick={() => dispatch({ type: 'crossQuote' })}>
                <CloseOutlined />
              </button>
            </span>
          )}
        </div>
      )}
      <textarea
        className="wk-chat-input"
        value={text}
        rows={2}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {failed && (
        <div className="wk-chat-failed" role="alert">
          {failed}
        </div>
      )}
      <div className="wk-chat-cfoot">
        {busy && onStop && (
          <button type="button" className="wk-chat-stop" aria-label={WIKI_CHAT_STOP} title={WIKI_CHAT_STOP} onClick={onStop}>
            <BorderOutlined />
          </button>
        )}
        <button type="submit" className="wk-chat-send" aria-label={WIKI_CHAT_SEND} title={WIKI_CHAT_SEND} disabled={!canSend}>
          <ArrowUpOutlined />
        </button>
      </div>
    </form>
  );
}
