import {
  ArrowDownOutlined,
  ArrowLeftOutlined,
  ArrowUpOutlined,
  BorderOutlined,
  CheckCircleFilled,
  CheckOutlined,
  ClockCircleOutlined,
  CloseCircleFilled,
  CloseOutlined,
  CodeOutlined,
  DeleteOutlined,
  DisconnectOutlined,
  EyeOutlined,
  LoadingOutlined,
  MessageOutlined,
  MinusCircleOutlined,
  MoreOutlined,
  PaperClipOutlined,
  PauseCircleOutlined,
  PictureOutlined,
  PlusOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Dropdown, Image, Input, type MenuProps, Segmented, Select, Tooltip } from 'antd';
import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMatch, useNavigate } from 'react-router-dom';
import { decodeId, encodeId } from '../lib/idCodec';
import { useIsMobile } from '../lib/useMediaQuery';
import { agentsQuery, sessionQuery, sessionsQuery } from '../lib/queries';
import {
  type ApprovalInfo,
  archiveSession,
  cancelQueuedTurn,
  createInteractiveSession,
  decideApproval,
  deleteSession,
  interruptSession,
  listApprovals,
  listQueuedTurns,
  type PermissionRule,
  restoreSession,
  resumeSession,
  sendTurn,
  sessionEventsUrl,
  updateSessionConfig,
  uploadAttachment,
} from '../api';
import { ChatImage, StreamingMessage, Transcript, type TurnImage } from './Transcript';
import { ApprovalPanel } from './ApprovalPanel';
import type { Runner } from './TasksSidePanel';

interface RunEvent {
  seq: number;
  type: string;
  payload: any;
  turnId?: string | null;
  ts?: string;
}

// A user message accepted while a turn is running: it sits in the inbox (PENDING)
// until the current turn finishes. Tracked locally so the composer can show it and
// offer to withdraw it before the runner picks it up.
interface QueuedTurn {
  turnId: string;
  content: string;
}

// An image staged in the composer: uploaded to the control plane (POST /api/attachments)
// the moment it's picked/pasted, then sent by id with the turn. `previewUrl` is a local
// object URL for the thumbnail; `id` is set once the upload resolves.
interface ComposerImage {
  uid: string;
  file: File;
  previewUrl: string;
  status: 'uploading' | 'done';
  id?: string;
}

// Image upload limits — kept in sync with the server (attachments.media.ts) so a bad
// pick is rejected before the round-trip rather than surfacing a 400/413.
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const TERMINAL = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'PARKED'];
// Session statuses that occupy one of the runner's maxConcurrent slots.
const SLOT_HELD = ['RUNNING', 'AWAITING_INPUT', 'INTERRUPTED'];
// UI label <-> claude --permission-mode value — the full set claude 2.1.x accepts.
// Prompting modes (Default/Plan/Accept Edits) work without a TTY because the runner
// routes permission prompts to the orbit approval panel (the MCP permission_prompt
// tool). "Don't Ask" auto-denies anything not pre-allowed; "Bypass" skips all checks.
const MODE_TO_PERMISSION: Record<string, string> = {
  Default: 'default',
  Plan: 'plan',
  'Accept Edits': 'acceptEdits',
  Auto: 'auto',
  "Don't Ask": 'dontAsk',
  Bypass: 'bypassPermissions',
};
const PERMISSION_TO_MODE: Record<string, string> = Object.fromEntries(
  Object.entries(MODE_TO_PERMISSION).map(([label, value]) => [value, label]),
);
const MODE_OPTIONS = Object.keys(MODE_TO_PERMISSION);
// Auto mode needs a recent model (Opus 4.6+ / Sonnet 4.6); claude rejects
// --permission-mode auto on Haiku / older models, so gate the option by model.
const AUTO_CAPABLE_MODELS = new Set(['claude-sonnet-4-6', 'claude-opus-4-8']);
const supportsAuto = (m: string): boolean => AUTO_CAPABLE_MODELS.has(m);
const MODEL_OPTIONS = [
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];
// Claude effort level. '' = Default (omit --effort, model picks its own).
const EFFORT_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'xHigh' },
  { value: 'max', label: 'Max' },
];
// Last-picked reasoning effort, remembered across reloads so a new session starts
// at the effort you last chose instead of resetting to Default. ('' = Default.)
const EFFORT_KEY = 'orbit.effort';

// Drag-resizable width of the left session column, persisted across reloads.
const SESSION_COL_KEY = 'orbit.sessionColWidth';
const SESSION_COL_MIN = 200;
const SESSION_COL_MAX = 560;
const SESSION_COL_DEFAULT = 264;

// Delay the SSE (re)connect on a session switch so holding the arrow keys to scrub
// the list doesn't open-then-immediately-close a connection per session skipped past.
const SWITCH_DEBOUNCE_MS = 150;
// Cap on cached transcripts (mount-scoped), so a long browsing session can't grow
// the cache without bound. Least-recently-selected entries are evicted first.
const TRANSCRIPT_CACHE_MAX = 20;

// Shell-style composer history, kept per-session in localStorage so the Up/Down arrows
// recall only this session's recently sent prompts (never another session's). Stored
// oldest-first, newest last; capped so it can't grow without bound. Keyed by session id;
// a not-yet-created session (new-session draft) has no id and so no history to recall.
const HISTORY_KEY_PREFIX = 'orbit.composerHistory:';
const HISTORY_MAX = 100;
const historyKey = (sessionId: string): string => `${HISTORY_KEY_PREFIX}${sessionId}`;
function loadHistory(sessionId?: string | null): string[] {
  if (!sessionId) return [];
  try {
    const arr = JSON.parse(localStorage.getItem(historyKey(sessionId)) ?? '[]');
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function pushHistory(sessionId: string | undefined, entry: string): void {
  if (!sessionId) return;
  const e = entry.trim();
  if (!e) return;
  const list = loadHistory(sessionId);
  if (list[list.length - 1] === e) return; // skip if identical to the last sent
  list.push(e);
  while (list.length > HISTORY_MAX) list.shift();
  try {
    localStorage.setItem(historyKey(sessionId), JSON.stringify(list));
  } catch {
    // ignore quota/serialization errors — history is best-effort
  }
}

// Recent sessions read better as relative time ("3h ago"); anything older than a
// day falls back to an absolute month/day stamp. hour12:false keeps it compact.
const fmtTime = (d?: string): string => {
  if (!d) return '';
  const t = new Date(d).getTime();
  const diff = Date.now() - t;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff >= 0 && diff < min) return 'just now';
  if (diff >= 0 && diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff >= 0 && diff < day) return `${Math.floor(diff / hour)}h ago`;
  return new Date(t).toLocaleString([], {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
};

// Flatten an assistant reply into a single-line list preview: drop code blocks and the
// most common markdown markers so the line reads as prose, not syntax, then collapse
// all whitespace/newlines. Length is handled by CSS ellipsis, not here.
const plainPreview = (md: string): string =>
  md
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/^[#>\-*\s]+/gm, '') // heading / quote / list markers at line start
    .replace(/[*_~]/g, '') // emphasis marks
    .replace(/\s+/g, ' ')
    .trim();

// Shorten a tool id for the live status line: mcp__orbit__task_create -> task_create;
// plain tool names (Bash, Read, Edit) pass through unchanged.
const fmtTool = (name: string): string => name.replace(/^mcp__[^_]+__/, '');

// The line shown under a session title. For a LIVE (openable) session that's working we
// surface its current state — the tool in flight, that it's blocked on you, or a bare
// "Running…" — so the row never collapses to just a title with no sign of progress.
// Otherwise it's the flattened last reply (or nothing). `tone` drives the colour:
// blue = working, amber = needs you, grey = queued, default = reply content.
type SessionLine = { text: string; tone: 'preview' | 'running' | 'approval' | 'queued' };
const sessionLine = (s: any, live: boolean): SessionLine | null => {
  if (live && s.status === 'RUNNING') {
    if ((s.pendingApprovals ?? 0) > 0) return { text: 'Waiting for approval', tone: 'approval' };
    if (s.lastToolUse) return { text: `Running ${fmtTool(s.lastToolUse)}…`, tone: 'running' };
    if (s.lastAssistantText) return { text: plainPreview(s.lastAssistantText), tone: 'preview' };
    return { text: 'Running…', tone: 'running' };
  }
  if (live && s.status === 'PENDING') return { text: 'Queued', tone: 'queued' };
  if (s.lastAssistantText) return { text: plainPreview(s.lastAssistantText), tone: 'preview' };
  return null;
};

// State word for the session header — mirrors StatusIcon's branching (and its tooltip
// wording) so the glyph and the header label always agree. The archived "Completed"
// override is list-only, so it's omitted here.
function statusLabel(session: any): string {
  const status: string = session.status;
  if (status === 'RUNNING')
    return (session.pendingApprovals ?? 0) > 0 ? 'Waiting for approval' : 'Running';
  if (status === 'AWAITING_INPUT') return 'Waiting for your reply';
  if (status === 'SUCCEEDED') return 'Completed';
  if (status === 'FAILED') {
    const err: string = typeof session.error === 'string' ? session.error : '';
    return err.toLowerCase().includes('offline') ? 'Disconnected' : 'Failed';
  }
  if (status === 'PARKED' || status === 'CANCELLED' || status === 'INTERRUPTED') {
    const reason: string = session.endReason ?? '';
    const terminal =
      reason === 'orphaned' ||
      reason === 'deleted' ||
      reason === 'completed' ||
      reason === 'cancelled' ||
      (status === 'INTERRUPTED' && reason === '');
    if (!terminal) return 'Dormant';
    return reason === 'orphaned' ? 'Ended' : status === 'INTERRUPTED' ? 'Interrupted' : 'Cancelled';
  }
  return 'Queued'; // PENDING
}
// One glyph per session state. Colour carries the meaning: blue = working,
// amber = needs a human decision, green = done, red = real failure, grey =
// neutral terminal (dormant / cancelled / interrupted / disconnected). A runner that
// went offline is reaped to FAILED with error 'runner offline'; that's a dropped
// connection, not a crash, so it gets the neutral disconnect glyph, not a red X.
// `status` collapses every graceful end to CANCELLED, so `endReason` is what tells a
// benign recycle (idle/task-done/user-ended — resumable, shown as paused) apart from a
// real cancel/orphan (shown as ⊖).
function StatusIcon({ session, completed }: { session: any; completed?: boolean }) {
  const status: string = session.status;
  const fontSize = 16;
  // In the Completed (archived) view the user has deliberately filed this session, so
  // archivedAt itself IS the "done by me" signal. Archiving a still-live session ends it,
  // and its status settles to CANCELLED async — so most filed sessions would otherwise
  // render as a grey ⊖ "Cancelled", contradicting the very action ("Complete") that put
  // them here. Show them as completed instead. A genuine FAILED is the one outcome still
  // worth surfacing post-filing, so it falls through to the real status icon below.
  if (completed && status !== 'FAILED')
    return (
      <Tooltip title="Completed">
        <CheckCircleFilled style={{ color: 'var(--success-solid)', fontSize }} />
      </Tooltip>
    );
  if (status === 'RUNNING') {
    return (session.pendingApprovals ?? 0) > 0 ? (
      <Tooltip title="Waiting for approval">
        <PauseCircleOutlined style={{ color: 'var(--warning-solid)', fontSize }} />
      </Tooltip>
    ) : (
      <Tooltip title="Running">
        <LoadingOutlined spin style={{ color: 'var(--brand)', fontSize }} />
      </Tooltip>
    );
  }
  if (status === 'AWAITING_INPUT')
    return (
      <Tooltip title="Waiting for your reply">
        <MessageOutlined style={{ color: 'var(--text-3)', fontSize }} />
      </Tooltip>
    );
  if (status === 'SUCCEEDED')
    return (
      <Tooltip title="Completed">
        <CheckCircleFilled style={{ color: 'var(--success-solid)', fontSize }} />
      </Tooltip>
    );
  if (status === 'FAILED') {
    const err: string = typeof session.error === 'string' ? session.error : '';
    if (err.toLowerCase().includes('offline'))
      return (
        <Tooltip title="Disconnected — runner went offline">
          <DisconnectOutlined style={{ color: 'var(--text-3)', fontSize }} />
        </Tooltip>
      );
    return (
      <Tooltip title={err || 'Failed'}>
        <CloseCircleFilled style={{ color: 'var(--error)', fontSize }} />
      </Tooltip>
    );
  }
  if (status === 'PARKED' || status === 'CANCELLED' || status === 'INTERRUPTED') {
    const reason: string = session.endReason ?? '';
    // Default to dormant, ⊖ only for a positively-terminal end. PARKED is resumable by
    // definition; a benign recycle (idle/task_done) or user-end is too; and a legacy
    // CANCELLED row with an unknown (null/pre-migration) reason should fail to the
    // neutral, resumable read — "we don't know why it ended" must not render as the
    // accusatory "Cancelled". The hard ends keep ⊖: orphaned/deleted/completed, plus a
    // bare INTERRUPTED (a turn cut short with no graceful-end reason recorded).
    const terminalCancel =
      reason === 'orphaned' ||
      reason === 'deleted' ||
      reason === 'completed' ||
      reason === 'cancelled' ||
      (status === 'INTERRUPTED' && reason === '');
    if (!terminalCancel)
      return (
        <Tooltip title="Dormant — send a message to resume">
          <PauseCircleOutlined style={{ color: 'var(--text-3)', fontSize }} />
        </Tooltip>
      );
    return (
      <Tooltip
        title={
          reason === 'orphaned'
            ? 'Ended — task already finished'
            : status === 'INTERRUPTED'
              ? 'Interrupted'
              : 'Cancelled'
        }
      >
        <MinusCircleOutlined style={{ color: 'var(--text-3)', fontSize }} />
      </Tooltip>
    );
  }
  // PENDING — queued, not yet started
  return (
    <Tooltip title="Queued">
      <ClockCircleOutlined style={{ color: 'var(--scrollbar-hover)', fontSize }} />
    </Tooltip>
  );
}

// Human-facing copy for a terminal session's banner. `status` alone is too coarse — it
// collapses idle-recycle, user-complete, delete and orphan all into CANCELLED — so the
// end reason drives the wording, falling back to status for a natural finish / legacy
// row. The suffix says whether sending a message resumes the session or starts fresh.
function endedBanner(session: any, resumable: boolean, runnerOnline: boolean): string {
  const status: string = session.status;
  const reason: string = session.endReason ?? '';
  const suffix = resumable
    ? ' Send a message to resume this session.'
    : runnerOnline
      ? ' Sending a message starts a new session.'
      : ' Runner offline — bring it online to resume.';
  let base: string;
  if (status === 'SUCCEEDED') base = 'Session completed.';
  else if (status === 'FAILED') {
    // A dropped connection isn't a crash — the suffix already names the offline runner,
    // so keep the base neutral and avoid repeating "offline".
    const err: string = typeof session.error === 'string' ? session.error : '';
    base = err.toLowerCase().includes('offline') ? 'Session interrupted.' : 'Session failed.';
  } else {
    // CANCELLED — disambiguate the overloaded status by reason.
    base =
      reason === 'idle'
        ? 'Session ended automatically after a long idle period.'
        : reason === 'task_done'
          ? 'The linked task is done, so the session ended automatically.'
          : reason === 'orphaned'
            ? 'Session ended (the linked task is done).'
            : reason === 'deleted'
              ? 'Session deleted.'
              : reason === 'completed'
                ? 'Session completed.'
                : reason === 'cancelled'
                  ? 'Session cancelled.'
                  : 'Session ended.'; // 'ended' or a pre-migration row
  }
  return base + suffix;
}

export function AgentView({ runner }: { runner: Runner }) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  // The picked session lives in the URL (/sessions/:id, a base62 public id) so
  // it deep-links and survives a refresh; selecting a session = navigation.
  // Decode once here; everything downstream works with the raw session UUID.
  const selectedId = decodeId(useMatch('/sessions/:id')?.params.id);
  // /agents/<id> names the agent this console is scoped to: the picker is locked
  // to it and the session list is filtered to that agent's conversations.
  // /agents/<id>/new is the "compose a new session" draft state (the splat is 'new').
  const agentMatch = useMatch('/agents/:id/*');
  const lockedAgentId = decodeId(agentMatch?.params.id);
  const composingRoute = (agentMatch?.params['*'] ?? '') === 'new';
  // Below the mobile breakpoint the two panes stack one-at-a-time; a couple of layout
  // choices (the auto-open redirect, the in-pane back button) key off this.
  const isMobile = useIsMobile();
  const [text, setText] = useState('');
  // Composer history cursor: -1 = editing the live draft; otherwise an index into the
  // session's stored history. `histDraft` stashes what was typed before recall started,
  // so stepping back past the newest entry restores it (shell-style).
  const [histIdx, setHistIdx] = useState(-1);
  const [histDraft, setHistDraft] = useState('');
  const [mode, setMode] = useState('Default');
  const [model, setModel] = useState('claude-sonnet-4-6');
  const [effort, setEffort] = useState(() => localStorage.getItem(EFFORT_KEY) ?? '');
  // Which slice of the session list to show: active, archived, system, or trash.
  const [view, setView] = useState<'active' | 'archived' | 'deleted' | 'system'>('active');
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null); // session row whose action menu is open
  const [agentId, setAgentId] = useState<string | undefined>(undefined);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [approvals, setApprovals] = useState<ApprovalInfo[]>([]); // pending tool-permission requests
  const [streamingText, setStreamingText] = useState(''); // live assistant text from text_delta
  const [streamingThink, setStreamingThink] = useState(''); // live thinking from thinking_delta
  const [idle, setIdle] = useState(false); // session is AWAITING_INPUT (a new turn is accepted)
  const [queued, setQueued] = useState<QueuedTurn[]>([]); // messages sent while a turn was running
  const [images, setImages] = useState<ComposerImage[]>([]); // images staged in the composer
  // Images already sent, keyed by their turnId. The runner echoes only the turn's text,
  // so these local previews are joined back into the user bubble (and the queued bubble)
  // to show the sent image in the transcript. Object URLs are revoked on session switch.
  const [turnImages, setTurnImages] = useState<Record<string, TurnImage[]>>({});
  const seen = useRef<Set<number>>(new Set());
  // Per-session transcript cache (mount-scoped): switching seeds events from here for
  // an instant paint and resumes the SSE just past the cached seq, instead of replaying
  // each session's full history from seq 0 on every visit.
  const transcriptCache = useRef<Map<string, RunEvent[]>>(new Map());
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null); // the left session-list column, for arrow-key scrolling
  // The user's prompt for the turn currently in view, surfaced as a sticky bar when a long
  // answer has pushed that bubble off the top — so what was asked stays findable. null hides it.
  const [stuck, setStuck] = useState<{ seq: string | null; text: string } | null>(null);
  // Smart auto-scroll: only keep pinned to the bottom when the user is already there, so
  // reading history (or jumping to the sticky prompt) isn't yanked back by streaming updates.
  const atBottomRef = useRef(true);
  // Render mirror of atBottomRef: drives the floating "jump to bottom" button, which shows
  // only while the user has scrolled up off the live tail. (The ref alone can't re-render.)
  const [atBottom, setAtBottom] = useState(true);
  // Last observed scrollTop, so the scroll handler can tell a genuine user scroll-up from a
  // programmatic re-pin or a late scroll event fired after streaming grew the container.
  const lastTopRef = useRef(0);
  // Recompute, on scroll and after content changes: are we at the bottom, and which top-level
  // user bubble (if any) has scrolled above the viewport top (= the prompt to surface)?
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      setStuck(null);
      return;
    }
    const top = el.scrollTop;
    // Pin to the bottom while at (or near) it; un-pin only when the user scrolls UP. A long
    // transcript replays as a flood of one-event-at-a-time renders, and each programmatic
    // scrollTo fires its scroll event asynchronously — by which time newer events have grown
    // the container, so a position-only check reads a large gap and wrongly un-pins, stranding
    // the view above the bottom. Gating the un-pin on a downward scrollTop delta ignores that.
    if (el.scrollHeight - top - el.clientHeight < 80) atBottomRef.current = true;
    else if (top < lastTopRef.current - 1) atBottomRef.current = false;
    lastTopRef.current = top;
    setAtBottom(atBottomRef.current); // React bails out when unchanged, so no per-scroll re-render
    const topY = el.getBoundingClientRect().top;
    const bubbles = Array.from(
      el.querySelectorAll<HTMLElement>('.chat-user:not(.chat-queued)'),
    ).filter((b) => !b.closest('.chat-subagent')); // ignore prompts nested in a sub-agent transcript
    let cur: HTMLElement | null = null;
    for (const b of bubbles) {
      if (b.getBoundingClientRect().bottom <= topY + 1) cur = b;
      else break;
    }
    setStuck(cur ? { seq: cur.getAttribute('data-seq'), text: cur.textContent || '' } : null);
  }, []);
  // Snap back to the live tail; the scroll events it fires re-pin atBottomRef via measure().
  const scrollToBottom = useCallback(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, []);
  // Width of the left session column; drag the divider to resize, persisted to
  // localStorage so the choice survives a reload.
  const [colWidth, setColWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(SESSION_COL_KEY));
    return saved >= SESSION_COL_MIN && saved <= SESSION_COL_MAX ? saved : SESSION_COL_DEFAULT;
  });
  const [resizing, setResizing] = useState(false);

  // The list is scoped by `view`. A selected session (its transcript is open) is
  // resolved from the loaded set, so force a view that contains it: `system` when
  // browsing the System tab (system sessions live there), otherwise `active` — that's
  // where live sessions and the runner's slot accounting live. (active also includes
  // system sessions server-side, so deep-linking one still resolves.)
  const effectiveView = selectedId ? (view === 'system' ? 'system' : 'active') : view;
  // One factory call drives both the list query and the optimistic-update key below, so
  // they can never drift apart; it's also the exact key the BootGate splash pre-warms.
  const sessionsOpts = sessionsQuery({ runnerId: runner.id, view: effectiveView });
  const sessionsKey = sessionsOpts.queryKey;
  const sessionsQ = useQuery({ ...sessionsOpts, refetchInterval: 4000 });

  const sessions = useMemo(
    () =>
      (sessionsQ.data ?? []).slice().sort((a, b) => {
        const ta = a.lastTurnAt ?? a.createdAt;
        const tb = b.lastTurnAt ?? b.createdAt;
        return ta < tb ? 1 : -1;
      }),
    [sessionsQ.data],
  );
  const selected = useMemo(() => sessions.find((s) => s.id === selectedId) ?? null, [sessions, selectedId]);
  // Detail of the open session, keyed the same as TasksSidePanel so React Query dedupes
  // the fetch. Its only job here is to resolve the session's agent the instant it's opened:
  // a freshly created session isn't in the list query yet (so `selected` is null), but its
  // detail is primed synchronously in send.onSuccess, so this keeps `scopeAgentId` stable
  // across the /agents/<id>/new → /sessions/<id> navigation. Without it the list briefly
  // un-scopes (shows every agent's sessions) until the list refetch lands.
  const sessionDetailQ = useQuery({
    ...sessionQuery(selectedId),
    placeholderData: keepPreviousData,
  });
  const live = selected ? !TERMINAL.includes(selected.status) : false;
  // An ended session can be revived (--resume claude's context) only if it actually
  // ran and its runner is online — the transcript lives on that machine's disk.
  const resumable = !!selected && !live && !!selected.startedAt && runner.online;
  // The session list (always visible in the left column) is scoped to one agent so
  // it reads as a conversation with that agent. On /agents/<id> that's the locked
  // agent; on a /sessions/<id> deep link the URL carries no agent, so fall back to
  // the selected session's own agent.
  const scopeAgentId = lockedAgentId ?? selected?.agent?.id ?? sessionDetailQ.data?.agent?.id ?? null;
  // The tab the user actually sees: a system session forces the System tab even when
  // `view` is still 'active' (e.g. deep-linking one — the Segmented highlights it as
  // System). The list and arrow-nav must step through that tab's sessions, not `view`'s.
  const onSystemTab = view === 'system' || selected?.source === 'system';
  const visibleSessions = useMemo(() => {
    let list = scopeAgentId ? sessions.filter((s) => s.agent?.id === scopeAgentId) : sessions;
    // System (auto-created) sessions get their own tab; the active query still returns
    // them for slot accounting and deep-link resolution. Show only system sessions on the
    // System tab; hide them from the Active list.
    if (onSystemTab) list = list.filter((s) => s.source === 'system');
    else if (view === 'active') list = list.filter((s) => s.source !== 'system');
    return list;
  }, [sessions, scopeAgentId, view, onSystemTab]);

  // Right-pane mode. A real session (/sessions/<id>) shows its conversation; with
  // none selected we're composing a new session — explicitly (/agents/<id>/new),
  // while browsing the archived/trash tabs (nothing openable there), or implicitly
  // when the active list is empty (the first-run empty state).
  const composing =
    !selectedId &&
    (composingRoute || view !== 'active' || (sessionsQ.isSuccess && visibleSessions.length === 0));

  // Default landing: opening /agents/<id> on the active tab (no session, not the
  // /new draft) jumps to the agent's most recent session so the right pane is never
  // blank. replace() keeps it out of history; archived/trash tabs never auto-open.
  useEffect(() => {
    // On mobile the list is its own full screen — auto-opening would trap the back
    // button (it returns here, which would immediately redirect into a session again).
    if (isMobile || selectedId || composingRoute || view !== 'active' || !sessionsQ.isSuccess)
      return;
    const first = visibleSessions[0];
    if (first) navigate(`/sessions/${encodeId(first.id)}`, { replace: true });
  }, [isMobile, selectedId, composingRoute, view, sessionsQ.isSuccess, visibleSessions, navigate]);

  // Step the open session up/down the visible list. Shared by the window-level Up/Down
  // handler and the Segmented's capture handler below. Returns false (a no-op) at the
  // list ends, on an empty list, or on the archived/trash tabs with nothing open. With
  // nothing selected, Down enters from the top, Up from the bottom.
  const stepSession = useCallback(
    (dir: 1 | -1): boolean => {
      if (!selectedId && view !== 'active' && view !== 'system') return false;
      if (visibleSessions.length === 0) return false;
      const cur = visibleSessions.findIndex((s) => s.id === selectedId);
      let next: number;
      if (cur === -1) next = dir === 1 ? 0 : visibleSessions.length - 1;
      else {
        next = cur + dir;
        if (next < 0 || next >= visibleSessions.length) return false; // stop at the ends
      }
      navigate(`/sessions/${encodeId(visibleSessions[next].id)}`);
      return true;
    },
    [visibleSessions, selectedId, view, navigate],
  );

  // Up/Down arrows step through the session list (left column), switching the open
  // session like tabs. Skipped while typing in an input/textarea (so the composer and
  // Ant dropdowns keep their own arrows). The Active/Completed/System tabs swallow
  // Up/Down themselves via onKeyDownCapture below, so a focused tab steps sessions too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const el = document.activeElement;
      if (
        el instanceof HTMLElement &&
        (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
      )
        return;
      if (stepSession(e.key === 'ArrowDown' ? 1 : -1)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stepSession]);

  // Keep the highlighted row in view when arrowing through a long list.
  useEffect(() => {
    listRef.current?.querySelector('.session-row.active')?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  // Agents belonging to this machine runner — each is a project dir + coding tool.
  // Picking one tells the server where (which dir) to run a new session.
  const agentsQ = useQuery(agentsQuery());
  const agentsForRunner = useMemo(
    () => (agentsQ.data ?? []).filter((a) => a.runnerId === runner.id),
    [agentsQ.data, runner.id],
  );
  const lockedAgent = useMemo(
    () => (lockedAgentId ? (agentsForRunner.find((a) => a.id === lockedAgentId) ?? null) : null),
    [agentsForRunner, lockedAgentId],
  );
  // The agent picked for a NEW session (a live session's agent/model are fixed).
  const pickedAgent = useMemo(
    () => agentsForRunner.find((a) => a.id === agentId) ?? null,
    [agentsForRunner, agentId],
  );
  // When scoped to a specific agent (/agents/<id>) lock the pick to it; otherwise
  // default to the runner's first agent, keeping a valid pick across runner switches.
  useEffect(() => {
    if (lockedAgentId) {
      setAgentId(lockedAgentId);
      return;
    }
    setAgentId((prev) =>
      prev && agentsForRunner.some((a) => a.id === prev) ? prev : agentsForRunner[0]?.id,
    );
  }, [agentsForRunner, lockedAgentId]);

  // Seed the Mode/Model/Effort pills from a non-live (resumable) session's stored
  // config, so they show that session's real settings and an edit before a resume
  // carries through (resume re-spawns claude with the new value). Keyed on the id +
  // liveness, not the polled object, so the 4s refetch can't clobber a user's edit.
  useEffect(() => {
    if (!selected || live) return;
    setModel(selected.model ?? 'claude-sonnet-4-6');
    setMode(PERMISSION_TO_MODE[selected.permissionMode ?? 'dontAsk'] ?? 'Default');
    setEffort(selected.effort ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, live]);

  // Composing a fresh session (no session selected): seed the model from the
  // picked agent's configured default (set on the Runner page). A selected
  // session instead seeds from its own stored config (effect above).
  useEffect(() => {
    if (selectedId || !pickedAgent?.model) return;
    setModel(pickedAgent.model);
  }, [selectedId, pickedAgent?.id, pickedAgent?.model]);

  // Effort has no agent-level default, so a fresh session restores the last-picked
  // effort from localStorage (see EFFORT_KEY) instead. Keeps the pill consistent with
  // Model/Mode when switching back to compose after viewing a resumed session.
  useEffect(() => {
    if (selectedId) return;
    setEffort(localStorage.getItem(EFFORT_KEY) ?? '');
  }, [selectedId]);

  // Likewise seed the Mode pill from the picked agent's configured default. Without
  // this the pill stays at the hardcoded 'Default', so a new session always sends
  // permissionMode 'default' — which the server's session→agent fallback treats as
  // an explicit choice, silently ignoring the agent's configured mode.
  useEffect(() => {
    if (selectedId || !pickedAgent) return;
    setMode(PERMISSION_TO_MODE[pickedAgent.permissionMode ?? 'dontAsk'] ?? 'Default');
  }, [selectedId, pickedAgent?.id, pickedAgent?.permissionMode]);

  // Slot accounting: a runner hosts at most maxConcurrent live sessions. When it's
  // full, a newly created session sits PENDING instead of starting — surface that
  // as an explicit concurrency wait rather than a silent "Starting…".
  const liveSlots = useMemo(
    () => sessions.filter((s) => SLOT_HELD.includes(s.status)).length,
    [sessions],
  );
  const atCapacity = typeof runner.maxConcurrent === 'number' && liveSlots >= runner.maxConcurrent;
  const queuedForSlot = !!selected && selected.status === 'PENDING' && atCapacity;

  // Subscribe to the session's event stream; reset only when the selection changes.
  useEffect(() => {
    // Live/ephemeral drafts belong to the previous selection — clear them at once.
    setStreamingText('');
    setStreamingThink('');
    setApprovals([]);
    setQueued([]);
    setIdle(false);
    setStuck(null);
    // Staged uploads are scoped to the previous session (can't be linked to another), and
    // the sent-image previews are this session's object URLs — drop and revoke both.
    setImages((prev) => {
      prev.forEach((im) => URL.revokeObjectURL(im.previewUrl));
      return [];
    });
    setTurnImages((prev) => {
      Object.values(prev).forEach((refs) => refs.forEach((r) => URL.revokeObjectURL(r.url)));
      return {};
    });
    atBottomRef.current = true; // a freshly opened/switched session starts pinned to the latest
    lastTopRef.current = 0;
    setAtBottom(true); // hide the jump-to-bottom button until the new session reports otherwise
    if (!selectedId) {
      setEvents([]);
      seen.current = new Set();
      return;
    }
    // Seed from cache for an instant paint; touch the entry so it's most-recently-used.
    const cache = transcriptCache.current;
    const cached = cache.get(selectedId) ?? [];
    cache.delete(selectedId);
    cache.set(selectedId, cached);
    let acc = cached;
    setEvents(acc);
    const isSeq = (s: unknown): s is number =>
      typeof s === 'number' && s !== Number.MAX_SAFE_INTEGER;
    seen.current = new Set(cached.map((e) => e.seq).filter(isSeq));
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let fails = 0;
    // Resume just past what's cached so only the gap is fetched, not the whole history.
    let lastSeq = cached.reduce((m, e) => (isSeq(e.seq) ? Math.max(m, e.seq) : m), 0);
    const stop = (): void => {
      closed = true;
      if (retry) clearTimeout(retry);
      es?.close();
    };
    const push = (ev: RunEvent): void => {
      acc = [...acc, ev];
      cache.set(selectedId, acc);
      if (cache.size > TRANSCRIPT_CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined && oldest !== selectedId) cache.delete(oldest);
      }
      setEvents(acc);
    };
    const connect = (): void => {
      es = new EventSource(sessionEventsUrl(selectedId, lastSeq));
      es.onmessage = (e) => {
        fails = 0; // a message means the stream is healthy
        const ev = JSON.parse(e.data) as RunEvent;
        if (typeof ev.seq === 'number' && ev.seq !== Number.MAX_SAFE_INTEGER) {
          lastSeq = Math.max(lastSeq, ev.seq);
        }
        if (ev.payload?.final) {
          stop();
          return; // session finalized — nothing more to stream
        }
        // Streaming increment: append to the in-progress assistant bubble. Don't
        // dedup or store it — it's pure animation; the trailing `assistant` event
        // carries the authoritative full text and finalizes the bubble.
        if (ev.type === 'text_delta') {
          const chunk = ev.payload?.text;
          if (typeof chunk === 'string') setStreamingText((p) => p + chunk);
          return;
        }
        if (ev.type === 'thinking_delta') {
          const chunk = ev.payload?.text;
          if (typeof chunk === 'string') setStreamingThink((p) => p + chunk);
          return;
        }
        // Approval nudges (live-only, seq 0) — handle BEFORE the seq dedup, which is
        // keyed on seq and would drop the second one. They drive `approvals`, not the
        // transcript reducer.
        if (ev.type === 'approval_request') {
          const p = ev.payload as { id: string; toolName: string; input: unknown; toolUseId?: string };
          setApprovals((prev) =>
            prev.some((x) => x.id === p.id)
              ? prev
              : [
                  ...prev,
                  { ...p, sessionId: selectedId, status: 'PENDING', createdAt: new Date().toISOString() } as ApprovalInfo,
                ],
          );
          return;
        }
        if (ev.type === 'approval_resolved') {
          const id = ev.payload?.id as string | undefined;
          if (id) setApprovals((prev) => prev.filter((x) => x.id !== id));
          return;
        }
        if (seen.current.has(ev.seq)) return;
        seen.current.add(ev.seq);
        push(ev);
        // The authoritative full text (or a turn/user/interrupt boundary) supersedes
        // the live drafts — clear them so streamed text isn't rendered twice. Text
        // implies thinking is done, so a text/turn boundary clears both; the durable
        // `thinking` block clears only its own draft. A mid-turn crash skips turn_end
        // and re-spawns with a `resumed` system event — clear there too so a partial
        // bubble can't outlive its turn. (Don't clear on every system event: claude's
        // stderr also arrives as `system` and would wipe an in-progress bubble.)
        if (['assistant', 'turn_end', 'user', 'interrupt', 'error'].includes(ev.type)) {
          setStreamingText('');
          setStreamingThink('');
        } else if (ev.type === 'thinking') {
          setStreamingThink('');
        } else if (ev.type === 'system' && ev.payload?.subtype === 'resumed') {
          setStreamingText('');
          setStreamingThink('');
        }
        // Track turn boundaries live so the composer re-enables the instant a turn
        // ends, rather than waiting for the 4s session poll.
        if (ev.type === 'turn_end') setIdle(true);
        else if (ev.type === 'user') {
          setIdle(false);
          // The runner just picked up this turn — it's now in the transcript, so drop
          // it from the local queue (no-op if it wasn't ours / already cleared).
          if (ev.turnId) setQueued((q) => q.filter((x) => x.turnId !== ev.turnId));
        }
      };
      es.onerror = () => {
        es?.close();
        if (closed) return;
        // Auto-reconnect, resuming after lastSeq — survives long idle / redeploy
        // drops (the seq dedup set makes any replay overlap harmless).
        if (++fails > 12) return;
        retry = setTimeout(connect, Math.min(2000 * fails, 15000) + Math.random() * 500);
      };
    };
    // Debounce the network work: scrubbing the list with the arrow keys shouldn't open
    // (and tear down) a connection — nor re-fetch approvals/queued turns — for each
    // session skipped past. The cached transcript above is already on screen meanwhile.
    const start = setTimeout(() => {
      // Pending approvals aren't in the event stream (separate table) — fetch them so
      // a refresh/deep-link shows any request already awaiting a decision.
      listApprovals(selectedId)
        .then(setApprovals)
        .catch(() => undefined);
      // Same for queued messages: a still-PENDING turn emits no event until the runner
      // picks it up, so switching away and back (or a refresh/deep-link) would lose the
      // visible queue — restore it from the DB, the source of truth.
      listQueuedTurns(selectedId)
        .then(setQueued)
        .catch(() => undefined);
      connect();
    }, SWITCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(start);
      stop();
    };
  }, [selectedId]);

  // Polled fallback for idleness, in case an SSE turn_end was missed / reconnected.
  const runStatus: string | undefined = selected?.status;
  useEffect(() => {
    if (runStatus === 'AWAITING_INPUT') setIdle(true);
    else if (runStatus === 'RUNNING') setIdle(false);
  }, [runStatus]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (atBottomRef.current) el.scrollTo({ top: el.scrollHeight });
    measure(); // content grew — the in-view prompt may have just scrolled off the top
  }, [events, streamingText, streamingThink, approvals, queued, measure]);

  // Track at-bottom + which prompt to surface as the user scrolls.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = (): void => measure();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [selectedId, measure]);

  // Allow/deny a pending tool-permission request; optimistically drop it (the
  // approval_resolved SSE also removes it), re-fetching to resync on failure.
  const decide = async (
    approvalId: string,
    behavior: 'allow' | 'deny',
    answers?: Record<string, string[]>,
    message?: string,
    rememberRule?: PermissionRule,
  ): Promise<void> => {
    if (!selectedId) return;
    setApprovals((prev) => prev.filter((x) => x.id !== approvalId));
    try {
      await decideApproval(selectedId, approvalId, behavior, message, answers, rememberRule);
    } catch {
      listApprovals(selectedId)
        .then(setApprovals)
        .catch(() => undefined);
    }
  };

  const send = useMutation({
    mutationFn: async (
      vars: { content: string; images: ComposerImage[] },
    ): Promise<{ id: string; turnId?: string; queuedItem?: QueuedTurn; created?: boolean }> => {
      const { content, images: imgs } = vars;
      // Only fully-uploaded images carry an id to reference; onSend blocks while any is
      // still uploading, so this is the complete set.
      const attachmentIds = imgs.map((im) => im.id).filter((x): x is string => !!x);
      // Continue a live session; revive an ended-but-resumable one (same row, claude
      // --resumes its context); otherwise (no selection, or unresumable) start a fresh
      // session so the composer never dead-locks. All three carry the pasted images: the
      // create path scopes them to the new session (server links them to the seeded first
      // turn), so a brand-new session composed from scratch can include screenshots too.
      if (selected && live) {
        const res = await sendTurn(selected.id, content, attachmentIds);
        // A turn already running ⇒ this message is queued (delivered once that turn
        // finishes); surface it as a pending bubble the user can withdraw. When idle
        // it's delivered right away, so it'll arrive via its own `user` event instead.
        const queuedItem = idle ? undefined : { turnId: res.turnId, content };
        return { id: selected.id, turnId: res.turnId, queuedItem };
      }
      if (selected && resumable) {
        // The pills were seeded from this session's stored config, so an untouched
        // send keeps it and an edited Mode/Model/Effort is re-applied on resume.
        const res = await resumeSession(
          selected.id,
          content,
          { model, permissionMode: MODE_TO_PERMISSION[mode], effort: effort || undefined },
          attachmentIds,
        );
        return { id: selected.id, turnId: res.turnId };
      }
      const created = await createInteractiveSession({
        prompt: content,
        assignedRunnerId: runner.id,
        agentId,
        model,
        permissionMode: MODE_TO_PERMISSION[mode],
        effort: effort || undefined,
        attachmentIds,
      });
      return { id: created.id, created: true };
    },
    onSuccess: ({ id, turnId, queuedItem, created }, vars) => {
      pushHistory(id, vars.content); // record under the resolved session id, new sessions included
      // For a freshly created session, prime its detail cache so the sidebar resolves
      // its agent row synchronously. Otherwise activeAgentId (TasksSidePanel) falls
      // back to keepPreviousData — the previously open session's agent — and the
      // highlight blips to that agent until this session's fetch lands. Mirrors
      // getSession's shape; the background refetch fills in the rest.
      if (created)
        qc.setQueryData(sessionQuery(id).queryKey, {
          id,
          assignedRunnerId: runner.id,
          agent: agentId ? { id: agentId } : null,
        });
      navigate(`/sessions/${encodeId(id)}`);
      setText('');
      // Hand the sent previews to the transcript, keyed by turnId, so the image shows in
      // the user bubble immediately (the runner echoes the text + image refs). The object
      // URLs move here as-is — setImages([]) below drops the chips without revoking them.
      if (turnId && vars.images.length) {
        const refs: TurnImage[] = vars.images.map((im) => ({ url: im.previewUrl, mime: im.file.type }));
        setTurnImages((m) => ({ ...m, [turnId]: refs }));
      } else if (created && vars.images.length) {
        // The create path has no turnId to key local previews on (the runner seeds the
        // first turn), so free these object URLs — the seeded turn's `user` event carries
        // the image refs and the transcript fetches them back for display.
        vars.images.forEach((im) => URL.revokeObjectURL(im.previewUrl));
      }
      setImages([]);
      setView('active'); // a new/continued session lives in the active list
      if (queuedItem) setQueued((q) => [...q, queuedItem]);
      else setIdle(false); // a turn is now starting
      qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (e: Error) => message.error(e.message),
  });
  const control = useMutation({
    mutationFn: (id: string) => interruptSession(id),
    onSuccess: () => {
      // Interrupt drops queued follow-ups server-side; mirror that locally.
      setQueued([]);
      qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (e: Error) => message.error(e.message),
  });
  // Withdraw a queued message. Optimistically remove it; if the runner already leased
  // it (it's no longer cancellable) it'll arrive in the transcript via its `user` event.
  const cancelQueued = async (turnId: string): Promise<void> => {
    if (!selectedId) return;
    setQueued((q) => q.filter((x) => x.turnId !== turnId));
    try {
      await cancelQueuedTurn(selectedId, turnId);
    } catch {
      message.info('This message is already being processed and cannot be withdrawn');
    }
  };
  // Soft visibility actions for ended sessions. All reversible, so no confirm dialog —
  // archive/delete fire immediately and surface an Undo toast; restore (used by the
  // toast and the Archived/Trash views) clears both flags back to active.
  const restoreMut = useMutation({
    mutationFn: (id: string) => restoreSession(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
    onError: (e: Error) => message.error(e.message),
  });
  const showUndo = (id: string, label: string): void => {
    const key = `undo-${id}`;
    message.open({
      key,
      type: 'success',
      content: (
        <span>
          {label}{' '}
          <a
            onClick={() => {
              message.destroy(key);
              restoreMut.mutate(id);
            }}
          >
            Undo
          </a>
        </span>
      ),
      duration: 4,
    });
  };
  // Archiving/deleting the OPEN session drops it from the active list. Keep the
  // selection at the same row: step to the next session down (or the previous one
  // when we just completed the last row) so the cursor stays put instead of jumping
  // to the top of the list. With nothing left to land on, fall back to the agent's
  // list (same move as the tab switcher) — that re-scopes the left column (a null
  // `selected` would collapse `scopeAgentId` and leak every agent's sessions) and
  // shows its empty/compose state. A non-open row leaves the conversation untouched.
  const leaveIfOpen = (id: string): void => {
    if (id !== selectedId) return;
    const idx = visibleSessions.findIndex((s) => s.id === id);
    const next = idx >= 0 ? (visibleSessions[idx + 1] ?? visibleSessions[idx - 1]) : null;
    if (next) {
      navigate(`/sessions/${encodeId(next.id)}`);
      return;
    }
    const a = scopeAgentId ?? agentsForRunner[0]?.id;
    navigate(a ? `/agents/${encodeId(a)}` : `/runners/${encodeId(runner.id)}`);
  };
  // After leaveIfOpen re-scopes to the agent, the auto-open effect picks that agent's
  // next session — but it reads the cached list, which still holds the row we just
  // archived/deleted until the refetch lands. Drop it now so auto-open can't re-select
  // the removed session (which would null out `selected`, collapse the agent scope, and
  // leak every agent's sessions into the list). The invalidate below still reconciles.
  const dropFromLists = (id: string): void => {
    qc.setQueriesData<any[]>({ queryKey: ['sessions'] }, (old) =>
      Array.isArray(old) ? old.filter((s) => s.id !== id) : old,
    );
  };
  const archiveMut = useMutation({
    mutationFn: (id: string) => archiveSession(id),
    onSuccess: (_d, id) => {
      leaveIfOpen(id);
      dropFromLists(id);
      qc.invalidateQueries({ queryKey: ['sessions'] });
      showUndo(id, 'Completed');
    },
    onError: (e: Error) => message.error(e.message),
  });
  // ⌘/Ctrl+D completes the open session — the keyboard twin of the ✓ on its row. Fires
  // even while the composer is focused; preventDefault swallows the browser's bookmark
  // shortcut. Only on the active tab (where Complete applies); for a live session this
  // also ends it, same as the button. The archive toast offers undo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() !== 'd' || e.shiftKey || e.altKey) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (view !== 'active' || !selected) return;
      e.preventDefault();
      archiveMut.mutate(selected.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, selected, archiveMut]);
  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteSession(id),
    onSuccess: (_d, id) => {
      leaveIfOpen(id);
      dropFromLists(id);
      qc.invalidateQueries({ queryKey: ['sessions'] });
      showUndo(id, 'Deleted');
    },
    onError: (e: Error) => message.error(e.message),
  });
  // Change a LIVE session's model / mode between turns. Optimistically patch the
  // cached session so the pill updates instantly; server-side the runner re-spawns
  // claude --resume with the new flag. Revert + surface the error on failure. Keyed on
  // effectiveView to match the (view-scoped) sessions query that renders the list.
  const configMut = useMutation({
    mutationFn: (cfg: { model?: string; permissionMode?: string; effort?: string }) =>
      updateSessionConfig(selected!.id, cfg),
    onMutate: async (cfg) => {
      await qc.cancelQueries({ queryKey: sessionsKey });
      const prev = qc.getQueryData<any[]>(sessionsKey);
      qc.setQueryData<any[]>(sessionsKey, (old) =>
        (old ?? []).map((s) => (s.id === selected!.id ? { ...s, ...cfg } : s)),
      );
      return { prev };
    },
    onError: (e: Error, _cfg, ctx) => {
      if (ctx?.prev) qc.setQueryData(sessionsKey, ctx.prev);
      message.error(e.message);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  });

  // Drag the divider between the session list and the conversation to resize the
  // left column. Listeners live on `document` so a fast drag that outruns the 1px
  // handle keeps tracking; body cursor/select are pinned for the drag's duration.
  const startResize = (e: ReactMouseEvent): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = colWidth;
    let latest = startW;
    setResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev: MouseEvent): void => {
      latest = Math.min(SESSION_COL_MAX, Math.max(SESSION_COL_MIN, startW + ev.clientX - startX));
      setColWidth(latest);
    };
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setResizing(false);
      localStorage.setItem(SESSION_COL_KEY, String(latest));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // Attach images to a live/resumable session (scoped to its id) or while composing a new
  // one (uploaded unscoped, then scoped to the session the send creates). Either way the
  // runner must be online to fetch the bytes; otherwise the picker is disabled.
  const canAttach = runner.online && (selected ? live || resumable : composing);
  const imageUid = useRef(0);
  // Validate, then upload an image as a staged chip. Uploaded eagerly (not on send) so the
  // turn carries only the id and a slow upload doesn't block typing. When composing there's
  // no session yet, so it's uploaded unscoped; create scopes it to the new session.
  const addImage = useCallback(
    async (file: File): Promise<void> => {
      if (!canAttach) return;
      if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
        message.error(`Unsupported image type: ${file.type || file.name}`);
        return;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        message.error('Image exceeds the 5MB limit');
        return;
      }
      const uid = `img-${imageUid.current++}`;
      const previewUrl = URL.createObjectURL(file);
      setImages((prev) => [...prev, { uid, file, previewUrl, status: 'uploading' }]);
      try {
        const { id } = await uploadAttachment(file, selected?.id);
        setImages((prev) => prev.map((im) => (im.uid === uid ? { ...im, status: 'done', id } : im)));
      } catch (e) {
        // Drop the failed chip and free its preview; the toast explains why.
        setImages((prev) => prev.filter((im) => im.uid !== uid));
        URL.revokeObjectURL(previewUrl);
        message.error((e as Error).message);
      }
    },
    [canAttach, selected, message],
  );
  const removeImage = (uid: string): void => {
    setImages((prev) => {
      const target = prev.find((im) => im.uid === uid);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((im) => im.uid !== uid);
    });
  };
  // A send waits for every staged upload to finish (so all ids are known), and goes out
  // with whatever images are ready plus the text. Either text or an image is enough.
  const uploading = images.some((im) => im.status === 'uploading');
  const readyImages = images.filter((im) => im.status === 'done' && im.id);

  const onSend = (): void => {
    const c = text.trim();
    if (send.isPending || uploading) return;
    if (!c && readyImages.length === 0) return;
    setHistIdx(-1);
    send.mutate({ content: c, images: readyImages });
  };
  // Open the new-session draft for this agent. A /sessions/<id> URL carries no
  // agent, so resolve it from the open session (scopeAgentId), then the first agent.
  const goNew = (): void => {
    const a = scopeAgentId ?? agentsForRunner[0]?.id;
    navigate(a ? `/agents/${encodeId(a)}/new` : `/runners/${encodeId(runner.id)}`);
    setText('');
  };
  // While the selected session is still loading we can't tell if it's live yet;
  // block send to avoid accidentally creating a duplicate session.
  const loadingSession = !!selectedId && !selected;
  // A live session accepts a message any time it holds a runner slot (RUNNING queues
  // it, AWAITING_INPUT runs it now) — but not while PENDING (still waiting for a slot,
  // no claude process yet). A non-live (ended) session revives or starts fresh.
  const canSend =
    (!!text.trim() || readyImages.length > 0) &&
    !send.isPending &&
    !uploading &&
    runner.online &&
    !loadingSession &&
    (live ? SLOT_HELD.includes(selected.status) : true);
  // The single send button morphs into a Stop while a turn is generating AND the composer
  // is empty — interrupting that turn. With content typed it stays Send, so a follow-up can
  // still be queued mid-turn. Ending the whole session isn't a button here: it's destructive
  // and the reaper recycles an idle/finished session's slot on its own.
  const showStop = selected?.status === 'RUNNING' && !text.trim() && readyImages.length === 0;

  // ── `/` command & skill autocomplete ──────────────────────────────────────
  // The runner reports its on-disk slash commands/skills via heartbeat (runner.commands
  // / runner.skills). Show them as a hint menu while the cursor sits on a `/token`
  // at the start of input or right after whitespace/newline, like the Claude Code TUI;
  // picking one replaces just that token with `/<name> ` (the trailing space drops the
  // regex match, so the menu auto-hides).
  const taRef = useRef<any>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
  const slashToken = /(?:^|\s)\/(\S*)$/.exec(text)?.[1] ?? null;
  const slashItems = useMemo(
    () => [
      ...(runner.commands ?? []).map((c) => ({ name: c.name, description: c.description, type: 'command' as const })),
      ...(runner.skills ?? []).map((s) => ({ name: s.name, description: s.description, type: 'skill' as const })),
    ],
    [runner.commands, runner.skills],
  );
  const slashMatches = useMemo(() => {
    if (slashToken === null) return [];
    const q = slashToken.toLowerCase();
    return slashItems
      .filter((it) => it.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const pa = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const pb = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return pa - pb || a.name.localeCompare(b.name);
      })
      .slice(0, 50);
  }, [slashItems, slashToken]);
  useEffect(() => setSlashIndex(0), [slashToken]);
  const showSlash =
    slashToken !== null && slashToken !== slashDismissed && runner.online && slashMatches.length > 0;
  const slashIdx = slashMatches.length ? Math.min(slashIndex, slashMatches.length - 1) : 0;
  const pickSlash = (name: string): void => {
    // Replace only the trailing `/token` ($1 preserves the start-or-whitespace before
    // it), so picking a command mid-message doesn't clobber text typed earlier.
    setText(text.replace(/(^|\s)\/\S*$/, `$1/${name} `));
    setSlashDismissed(null);
    setTimeout(() => taRef.current?.focus(), 0);
  };
  // Open the command/skill autocomplete from the `+` menu: drop a `/` (prefixed with a
  // space when mid-message) so slashToken matches and the menu pops.
  const insertSlash = (): void => {
    setText((t) => (t === '' || /\s$/.test(t) ? `${t}/` : `${t} /`));
    setSlashDismissed(null);
    setTimeout(() => taRef.current?.focus(), 0);
  };
  // A LIVE session's pills show its stored choice (editable any time the runner is
  // online — see configEditable); otherwise they're editable and reflect local state.
  const shownModel: string = live ? (selected.model ?? 'claude-sonnet-4-6') : model;
  const shownMode: string = live
    ? (PERMISSION_TO_MODE[selected.permissionMode ?? 'dontAsk'] ?? 'Default')
    : mode;
  const shownEffort: string = live ? (selected.effort ?? '') : effort;
  // Auto is offered only on models that support it (see supportsAuto); the option
  // is greyed out otherwise so an unsupported model can't pick a mode claude rejects.
  const autoOk = supportsAuto(shownModel);
  // Model, Mode & Effort can be changed any time on a live session (the runner must be
  // online to act on it). A change made mid-turn doesn't abort the running turn: the
  // server defers the re-spawn until the turn finishes, so it applies on the next turn —
  // same as a queued message. When not live they're freely editable (pre-session config).
  // Agent stays fixed once live.
  const configEditable = live ? runner.online : true;
  // A live session's agent is fixed; otherwise reflect the local pick.
  const shownAgentId: string | undefined = live ? (selected.agent?.id ?? undefined) : agentId;
  // The agent can't be switched once the session is live, nor when the view is locked to
  // one agent. In those cases it's read-only info, so we surface it as a static pill in the
  // controls row (see composer-pill-static) instead of a Select; otherwise it stays a Select.
  const agentReadOnly = live || !!lockedAgentId;
  const shownAgentName =
    agentsForRunner.find((a) => a.id === shownAgentId)?.name ??
    selected?.agent?.name ??
    lockedAgent?.name;
  // Per-control hints derived from the same state that drives enable/disable, so the help
  // can't drift from behaviour (this used to be one hard-coded paragraph on the whole row).
  // Empty string = no tooltip, which keeps idle controls free of hover noise.
  const configHint = live && !runner.online ? 'Runner offline — cannot change this now' : '';
  // Switching session leaves whatever history recall was in progress; reset the cursor
  // so the next Up starts fresh from the (per-session) history.
  useEffect(() => {
    setHistIdx(-1);
  }, [selectedId]);
  // Title shown above the session list (and in the draft header). /sessions/<id>
  // has no agent in the URL, so fall back to the open session's agent, then runner.
  const headAgentName =
    lockedAgent?.name ?? selected?.agent?.name ?? runner.displayName ?? runner.name;
  // Header subtitle: the two things the composer below doesn't already show — current
  // state and when it was last active. (turns/cost dropped; model/agent live in the
  // composer pills.)
  const headTime = selected
    ? fmtTime(selected.lastTurnAt ?? selected.startedAt ?? selected.createdAt)
    : '';
  const headSub = composing
    ? `${headAgentName} · New session`
    : selected
      ? headTime
        ? `${statusLabel(selected)} · ${headTime}`
        : statusLabel(selected)
      : selectedId
        ? 'Starting…'
        : '';

  return (
    <div className={`agent-split${selectedId || composingRoute ? ' show-conversation' : ''}`}>
      <aside className="session-col" style={{ width: colWidth }}>
        <div className="session-col-head">
          <span className={`agent-status-dot ${runner.online ? 'online' : ''}`} />
          <span className="session-col-title">{headAgentName}</span>
        </div>
        <div className={`session-new ${composing ? 'active' : ''}`} onClick={goNew}>
          <PlusOutlined />
          <span>New session</span>
        </div>
        <Segmented
          block
          size="small"
          // A focused tab otherwise eats Up/Down two ways: rc-segmented's own onKeyDown
          // and the native radio-group arrow navigation (the options share a name). Catch
          // them in the capture phase and kill both — stopPropagation for the former,
          // preventDefault for the latter — so Up/Down steps the session list instead.
          // Left/Right fall through and still switch tabs; stopPropagation also keeps the
          // window handler above from double-firing.
          onKeyDownCapture={(e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
            e.stopPropagation();
            e.preventDefault();
            stepSession(e.key === 'ArrowDown' ? 1 : -1);
          }}
          // Deep-linking a system session lands with view='active'; highlight System
          // once it resolves so the tab matches the open conversation.
          value={selected?.source === 'system' ? 'system' : effectiveView}
          onChange={(v) => {
            const next = v as 'active' | 'archived' | 'deleted' | 'system';
            setView(next);
            // Switching tabs while a session transcript is open closes it: the open
            // session lives in the active set and archived/trash rows aren't openable,
            // so browsing another tab means leaving the conversation.
            if (selectedId) {
              const a = scopeAgentId ?? agentsForRunner[0]?.id;
              navigate(a ? `/agents/${encodeId(a)}` : `/runners/${encodeId(runner.id)}`);
            }
          }}
          options={[
            { label: 'Active', value: 'active' },
            { label: 'Completed', value: 'archived' },
            { label: 'System', value: 'system' },
          ]}
        />
        <div className="agent-sessions session-col-list" ref={listRef}>
          {visibleSessions.length === 0 && (
            <div className="chat-note">
              {view === 'active'
                ? 'No sessions yet.'
                : view === 'archived'
                  ? 'No completed sessions.'
                  : view === 'system'
                    ? 'No system sessions.'
                    : 'Trash is empty.'}
            </div>
          )}
          {visibleSessions.map((s) => {
            const ended = TERMINAL.includes(s.status);
            const restoreItem = {
              key: 'restore',
              icon: <UndoOutlined />,
              label: 'Restore',
              onClick: ({ domEvent }: { domEvent: { stopPropagation: () => void } }) => {
                domEvent.stopPropagation();
                restoreMut.mutate(s.id);
              },
            };
            const deleteItem = {
              key: 'delete',
              icon: <DeleteOutlined />,
              label: ended ? 'Delete' : 'Delete & end session',
              danger: true,
              onClick: ({ domEvent }: { domEvent: { stopPropagation: () => void } }) => {
                domEvent.stopPropagation();
                deleteMut.mutate(s.id);
              },
            };
            const menuItems: MenuProps['items'] =
              view === 'archived'
                ? [restoreItem, { type: 'divider' }, deleteItem]
                : view === 'system'
                  ? [deleteItem]
                  : [restoreItem];
            // System sessions are openable like active ones; archived/trash rows aren't.
            const openable = view === 'active' || view === 'system';
            const line = sessionLine(s, openable);
            return (
              <div
                className={`session-row${openable ? '' : ' no-open'}${s.id === selectedId ? ' active' : ''}${menuOpenId === s.id ? ' menu-open' : ''}`}
                key={s.id}
                onClick={openable ? () => navigate(`/sessions/${encodeId(s.id)}`) : undefined}
              >
                <span className="session-icon">
                  <StatusIcon session={s} completed={view === 'archived'} />
                </span>
                <div className="session-main">
                  <div className="session-title-row">
                    <div className="session-title">{s.title}</div>
                    <span className="session-time">{fmtTime(s.lastTurnAt ?? s.createdAt)}</span>
                  </div>
                  {line ? (
                    <div
                      className={`session-preview${line.tone === 'preview' ? '' : ` tone-${line.tone}`}`}
                    >
                      {line.text}
                    </div>
                  ) : null}
                </div>
                <div className="session-right">
                  <div className="session-actions" onClick={(e) => e.stopPropagation()}>
                    {view === 'active' ? (
                      <Tooltip title={ended ? 'Complete' : 'Complete & end session'} placement="top">
                        <span
                          className="session-kebab session-complete"
                          onClick={(e) => {
                            e.stopPropagation();
                            archiveMut.mutate(s.id);
                          }}
                        >
                          <CheckOutlined />
                        </span>
                      </Tooltip>
                    ) : (
                      <Dropdown
                        trigger={['click']}
                        placement="bottomRight"
                        open={menuOpenId === s.id}
                        onOpenChange={(o) => setMenuOpenId(o ? s.id : null)}
                        menu={{ items: menuItems }}
                      >
                        <span
                          className="session-kebab"
                          title="More actions"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreOutlined />
                        </span>
                      </Dropdown>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </aside>

      <div
        className={`session-resizer${resizing ? ' resizing' : ''}`}
        onMouseDown={startResize}
        role="separator"
        aria-orientation="vertical"
      />

      <div className="agent-view">
        <div className="agent-header">
          {isMobile && (
            <button
              type="button"
              className="agent-back-mobile"
              aria-label="Back to sessions"
              onClick={() => {
                const a = scopeAgentId ?? agentsForRunner[0]?.id;
                navigate(a ? `/agents/${encodeId(a)}` : `/runners/${encodeId(runner.id)}`);
              }}
            >
              <ArrowLeftOutlined />
            </button>
          )}
          <div className="agent-header-main">
            {selected?.taskId && !composing && (
              <button
                type="button"
                className="agent-header-task"
                title={`Back to task · ${selected.taskTitle ?? ''}`}
                onClick={() => navigate(`/tasks/${encodeId(selected.taskId)}`)}
              >
                <ArrowLeftOutlined />
                <span className="agent-header-task-name">{selected.taskTitle ?? 'Back to task'}</span>
              </button>
            )}
            <div className="agent-name">
              {composing ? 'New session' : (selected?.title ?? (selectedId ? 'Starting…' : headAgentName))}
            </div>
            <div className="agent-sub">{headSub}</div>
          </div>
          {selected && !composing && (
            <>
              <div className="agent-header-spacer" />
              <Dropdown
                trigger={['click']}
                placement="bottomRight"
                menu={{
                  items: [
                    {
                      key: 'delete',
                      icon: <DeleteOutlined />,
                      danger: true,
                      label: TERMINAL.includes(selected.status) ? 'Delete' : 'Delete & end session',
                      onClick: () => deleteMut.mutate(selected.id),
                    },
                  ],
                }}
              >
                <Button type="text" icon={<MoreOutlined />} title="More actions" />
              </Dropdown>
            </>
          )}
        </div>

        {stuck && (
          <button
            className="chat-sticky-question"
            title={stuck.text}
            onClick={() => {
              const seq = stuck?.seq;
              if (!seq) return;
              scrollRef.current
                ?.querySelector<HTMLElement>(`.chat-user[data-seq="${seq}"]`)
                ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
            }}
          >
            <span className="chat-sticky-label">↑ Your question</span>
            <span className="chat-sticky-text">{stuck.text}</span>
          </button>
        )}

        <div className="agent-scroll-wrap">
        {selectedId ? (
          <div className="agent-sessions" ref={scrollRef}>
            {selected && selected.status === 'PENDING' && events.length === 0 && (
              <div className="chat-queued-state">
                <div className="chat-queued-dots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <div className="chat-queued-title">
                  {queuedForSlot ? 'Waiting for a free slot' : 'Starting session…'}
                </div>
                <div className="chat-queued-desc">
                  {queuedForSlot
                    ? `Runner at capacity (${liveSlots}/${runner.maxConcurrent}). This session starts as soon as a slot frees up.`
                    : 'Your message is queued — the agent will pick it up in a moment.'}
                </div>
              </div>
            )}
            <Transcript events={events} live={live} turnImages={turnImages} />
            {streamingThink && <div className="chat-think-stream chat-streaming">💭 {streamingThink}</div>}
            {streamingText && <StreamingMessage text={streamingText} />}
            {approvals.map((a, i) => (
              // Only the first (oldest) pending card owns the ⌘/Ctrl+Enter shortcut; once
              // it's decided the next card becomes first, so the key walks the queue in order.
              <ApprovalPanel key={a.id} approval={a} onDecide={decide} active={i === 0} />
            ))}
            {queued.map((q) => (
              <div className="chat-msg chat-user chat-queued" key={q.turnId}>
                {turnImages[q.turnId]?.length > 0 && (
                  <div className="chat-images">
                    {turnImages[q.turnId].map((im, i) => (
                      <ChatImage key={i} src={im.url} />
                    ))}
                  </div>
                )}
                {q.content && <span className="chat-queued-text">{q.content}</span>}
                <span className="chat-queued-meta">
                  <span className="chat-queued-tag">Queued</span>
                  <a onClick={() => cancelQueued(q.turnId)}>Cancel</a>
                </span>
              </div>
            ))}
            {selected &&
              !TERMINAL.includes(selected.status) &&
              selected.status !== 'PENDING' &&
              events.length === 0 &&
              !streamingText &&
              !streamingThink && <div className="chat-note">Waiting for the agent…</div>}
            {selected && TERMINAL.includes(selected.status) && (
              <div className="chat-note">{endedBanner(selected, !!resumable, !!runner.online)}</div>
            )}
          </div>
        ) : composing ? (
          <div className="agent-sessions agent-draft" ref={scrollRef}>
            <div className="chat-note">Send this agent a task to start a new session.</div>
          </div>
        ) : (
          <div className="agent-sessions" />
        )}
        {selectedId && !atBottom && (
          <button className="scroll-to-bottom" aria-label="Scroll to bottom" onClick={scrollToBottom}>
            <ArrowDownOutlined />
          </button>
        )}
        </div>

      <div className="agent-composer">
        {images.length > 0 && (
          <div className="composer-attachments">
            {images.map((im) => (
              <span key={im.uid} className="composer-pill composer-attach">
                <Image
                  className="composer-attach-thumb"
                  src={im.previewUrl}
                  alt=""
                  preview={{ mask: <EyeOutlined className="composer-attach-eye" /> }}
                />
                {im.status === 'uploading' && (
                  <span className="composer-attach-spin">
                    <LoadingOutlined spin />
                  </span>
                )}
                <button
                  type="button"
                  className="composer-attach-remove"
                  onClick={() => removeImage(im.uid)}
                  aria-label="Remove image"
                >
                  <CloseOutlined />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-box">
          {showSlash && (
            <div className="composer-slash-menu" role="listbox">
              {slashMatches.map((it, i) => (
                <div
                  key={`${it.type}:${it.name}`}
                  role="option"
                  aria-selected={i === slashIdx}
                  className={`composer-slash-item${i === slashIdx ? ' is-active' : ''}`}
                  // mousedown (not click) + preventDefault keeps focus in the textarea.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickSlash(it.name);
                  }}
                  onMouseEnter={() => setSlashIndex(i)}
                >
                  <span className="composer-slash-name">/{it.name}</span>
                  <span className="composer-slash-type">{it.type === 'skill' ? 'skill' : 'cmd'}</span>
                  {it.description && <span className="composer-slash-desc">{it.description}</span>}
                </div>
              ))}
            </div>
          )}
          {/* Hidden picker the `添加图片` menu item triggers; we upload via addImage
              ourselves and reset value so re-picking the same file fires onChange again. */}
          <input
            ref={imageInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={(e) => {
              Array.from(e.target.files ?? []).forEach((f) => void addImage(f));
              e.target.value = '';
            }}
          />
          <Dropdown
            trigger={['click']}
            placement="topLeft"
            disabled={!runner.online}
            menu={{
              items: [
                {
                  key: 'image',
                  icon: <PictureOutlined />,
                  label: canAttach ? 'Attach image' : 'Attach image (needs a started session)',
                  disabled: !canAttach,
                  onClick: () => imageInputRef.current?.click(),
                },
                {
                  key: 'slash',
                  icon: <CodeOutlined />,
                  label: 'Commands / Skills',
                  disabled: slashItems.length === 0,
                  onClick: insertSlash,
                },
                {
                  key: 'file',
                  icon: <PaperClipOutlined />,
                  label: 'Upload file (coming soon)',
                  disabled: true,
                },
              ],
            }}
          >
            <Button
              className="composer-attach-btn"
              type="text"
              icon={<PlusOutlined />}
              disabled={!runner.online}
              aria-label="Add attachment"
            />
          </Dropdown>
          <Input.TextArea
            ref={taRef}
            variant="borderless"
            autoSize={{ minRows: 1, maxRows: 6 }}
            placeholder={
              !runner.online ? 'Runner offline' : selectedId ? 'Reply…' : 'Send this agent a task…'
            }
            value={text}
            disabled={!runner.online}
            // Typing exits history recall: the next Up starts fresh from this draft.
            onChange={(e) => {
              setText(e.target.value);
              if (histIdx !== -1) setHistIdx(-1);
            }}
            // Paste an image straight from the clipboard (e.g. a screenshot). Only swallow
            // the paste when it actually carries image files, so pasting text is untouched.
            onPaste={(e) => {
              if (!canAttach) return;
              const files = Array.from(e.clipboardData?.items ?? [])
                .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
                .map((it) => it.getAsFile())
                .filter((f): f is File => !!f);
              if (files.length) {
                e.preventDefault();
                files.forEach(addImage);
              }
            }}
            // One keydown handler: drive the menu while open, else Up/Down recall
            // history (when it doesn't fight cursor movement), Enter=send / Shift+Enter=newline.
            onKeyDown={(e) => {
              if (showSlash && !e.nativeEvent.isComposing) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setSlashIndex((i) => (i + 1) % slashMatches.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length);
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  pickSlash(slashMatches[slashIdx].name);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setSlashDismissed(slashToken);
                  return;
                }
              }
              // Shell-style history recall. Up only fires on the first line and Down on
              // the last line (with no text selected), so navigating within a multi-line
              // draft still moves the caret normally. After recall the caret is parked at
              // the start (Up) / end (Down) so a repeat keeps stepping through history.
              if (
                (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
                !e.nativeEvent.isComposing &&
                !e.metaKey &&
                !e.ctrlKey &&
                !e.altKey &&
                !e.shiftKey
              ) {
                const ta = e.currentTarget;
                const noSelection = ta.selectionStart === ta.selectionEnd;
                const onFirstLine = !ta.value.slice(0, ta.selectionStart).includes('\n');
                const onLastLine = !ta.value.slice(ta.selectionEnd).includes('\n');
                const setCaret = (pos: number): void => {
                  // setText re-renders the textarea; restore the caret on the next tick.
                  setTimeout(() => {
                    ta.selectionStart = ta.selectionEnd = pos;
                  }, 0);
                };
                if (e.key === 'ArrowUp' && noSelection && onFirstLine) {
                  const list = loadHistory(selectedId);
                  if (list.length) {
                    e.preventDefault();
                    if (histIdx === -1) setHistDraft(text);
                    const idx = histIdx === -1 ? list.length - 1 : Math.max(0, histIdx - 1);
                    setHistIdx(idx);
                    setText(list[idx]);
                    setCaret(0);
                    return;
                  }
                }
                if (e.key === 'ArrowDown' && noSelection && onLastLine && histIdx !== -1) {
                  e.preventDefault();
                  const list = loadHistory(selectedId);
                  if (histIdx < list.length - 1) {
                    const idx = histIdx + 1;
                    setHistIdx(idx);
                    setText(list[idx]);
                    setCaret(list[idx].length);
                  } else {
                    setHistIdx(-1);
                    setText(histDraft);
                    setCaret(histDraft.length);
                  }
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                onSend();
              }
            }}
          />
          {showStop ? (
            <Tooltip title="Stop the current turn">
              <Button
                type="primary"
                icon={<BorderOutlined />}
                onClick={() => selected && control.mutate(selected.id)}
                aria-label="Stop"
              />
            </Tooltip>
          ) : (
            <Button
              type="primary"
              icon={<ArrowUpOutlined />}
              disabled={!canSend}
              loading={send.isPending}
              onClick={onSend}
              aria-label="Send"
            />
          )}
        </div>
        <div className="composer-pills">
          {/* The agent is only a Select when it can actually be picked (new, unlocked
              session); once read-only it shows as a static pill left of Model below. */}
          {!agentReadOnly && (
            <Tooltip title="Agent">
              <span className="composer-pill">
                <Select
                  size="small"
                  variant="borderless"
                  suffixIcon={null}
                  value={shownAgentId}
                  onChange={setAgentId}
                  options={agentsForRunner.map((a) => ({ value: a.id, label: a.name }))}
                  placeholder="Default"
                  disabled={live || !!lockedAgentId}
                  popupMatchSelectWidth={false}
                />
              </span>
            </Tooltip>
          )}
          {/* Tooltip wraps the span (not the Select): a disabled Select has no pointer
              events, so the parent span is what surfaces the reason on hover. With the
              icons gone, the tooltip also names what each pill controls. */}
          <Tooltip title={configHint || 'Permission mode'}>
            <span className="composer-pill">
              <Select
                size="small"
                variant="borderless"
                suffixIcon={null}
                value={shownMode}
                onChange={(v) =>
                  live ? configMut.mutate({ permissionMode: MODE_TO_PERMISSION[v] }) : setMode(v)
                }
                options={MODE_OPTIONS.map((m) => ({
                  value: m,
                  // Carry the Auto-mode constraint on the greyed option itself, where it's
                  // actionable, instead of in a row-wide paragraph.
                  label: m === 'Auto' && !autoOk ? 'Auto (needs Sonnet 4.6 or Opus 4.8)' : m,
                  disabled: m === 'Auto' && !autoOk,
                }))}
                disabled={!configEditable}
                popupMatchSelectWidth={false}
              />
            </span>
          </Tooltip>
          <span className="composer-pill-spacer" />
          {agentReadOnly && shownAgentName && (
            <Tooltip title="Agent">
              <span className="composer-pill composer-pill-static">
                <span className="composer-pill-static-label">{shownAgentName}</span>
              </span>
            </Tooltip>
          )}
          <Tooltip title={configHint || 'Model'}>
            <span className="composer-pill">
              <Select
                size="small"
                variant="borderless"
                suffixIcon={null}
                value={shownModel}
                onChange={(v) => {
                  // Switching to a model that can't do Auto while Auto is selected
                  // would send a mode claude rejects — snap back to Default.
                  const drop = shownMode === 'Auto' && !supportsAuto(v);
                  if (live) {
                    configMut.mutate({ model: v, ...(drop ? { permissionMode: 'default' } : {}) });
                  } else {
                    setModel(v);
                    if (drop) setMode('Default');
                  }
                }}
                options={MODEL_OPTIONS}
                disabled={!configEditable}
                popupMatchSelectWidth={false}
              />
            </span>
          </Tooltip>
          <Tooltip title={configHint || 'Reasoning effort'}>
            <span className="composer-pill">
              <Select
                size="small"
                variant="borderless"
                suffixIcon={null}
                value={shownEffort}
                onChange={(v) => {
                  localStorage.setItem(EFFORT_KEY, v);
                  if (live) configMut.mutate({ effort: v });
                  else setEffort(v);
                }}
                options={EFFORT_OPTIONS}
                disabled={!configEditable}
                popupMatchSelectWidth={false}
              />
            </span>
          </Tooltip>
        </div>
      </div>
      </div>
    </div>
  );
}
