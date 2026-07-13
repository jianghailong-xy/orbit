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
  ConsoleSqlOutlined,
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
  PushpinFilled,
  PushpinOutlined,
  ShareAltOutlined,
  ThunderboltOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Dropdown, Image, Input, type MenuProps, Popover, Segmented, Select, Tooltip } from 'antd';
import {
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type TouchEvent as ReactTouchEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useMatch, useNavigate } from 'react-router-dom';
import { decodeId, encodeId } from '../lib/idCodec';
import { useIsMobile, useMediaQuery } from '../lib/useMediaQuery';
import { useControlPlaneLive } from '../lib/useControlPlane';
import { agentsQuery, type Me, meQuery, providersQuery, sessionQuery, sessionsQuery } from '../lib/queries';
import {
  type ConfiguredProvider,
  contextWindowFor,
  DEFAULT_MODEL,
  defaultModelForProvider,
  effortOptionsForProvider,
  modelOptionsForProvider,
  normalizeEffortForProvider,
  supportsAuto,
} from '../lib/agentDefaults';
import { SessionOutputs } from './SessionOutputs';
import { BackgroundShellsTray } from './BackgroundShellsTray';
import type { BgShell } from '../lib/backgroundShells';
import {
  api,
  type ApprovalInfo,
  archiveSession,
  cancelQueuedTurn,
  commitSession,
  createInteractiveSession,
  decideApproval,
  deleteSession,
  enableAgentIsolation,
  getBackgroundShells,
  interruptSession,
  listApprovals,
  listQueuedTurns,
  mergeSessionToMain,
  type PermissionRule,
  pinSession,
  purgeSession,
  getSessionEventPage,
  renameSession,
  restoreSession,
  resumeSession,
  sendTurn,
  sessionEventsUrl,
  unpinSession,
  updateSessionConfig,
  uploadAttachment,
} from '../api';
import { AttachmentImage, ChatImage, StreamingMessage, Transcript, type TurnImage } from './Transcript';
import { ApprovalPanel } from './ApprovalPanel';
import { ShareModal } from './ShareModal';
import type { Runner } from './TasksSidePanel';
import type { PlanUsage, PlanUsageSnapshot, PlanUsageWindow } from '@orbit/shared';
import { MAX_PROMPT_CHARS, TRASH_RETENTION_DAYS } from '@orbit/shared';

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
  // Server-side image refs (id + mime), so a reopened/reloaded queue can still render an
  // image-only follow-up turn — the local turnImages previews don't survive a reload.
  attachments?: { id: string; mimeType: string }[];
}

// An attachment staged in the composer: uploaded to the control plane (POST /api/attachments)
// the moment it's picked/pasted, then sent by id with the turn. `previewUrl` is a local
// object URL for the thumbnail — set only for inline images; a non-image file renders as a
// chip (name + size) instead. `id` is set once the upload resolves.
interface ComposerImage {
  uid: string;
  file: File;
  previewUrl?: string;
  status: 'uploading' | 'done';
  id?: string;
}

// The image types Claude takes as inline content blocks: shown as a thumbnail and capped
// tighter (kept in sync with the runner's image-block dispatch). Anything else is a generic
// file — any type, up to the server's 25MB cap (attachments.media.ts).
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

// Compact byte size for a staged file chip ("12 KB", "3.4 MB").
const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

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

// New-session hotkey hint. The chord itself accepts ⌘/Ctrl on every platform; only the
// label differs — ⌘ on macOS, Ctrl elsewhere (matches ApprovalPanel's convention). The
// hint is only *shown* in standalone/PWA mode, because a normal browser tab reserves ⌘N
// for "New Window" and the page can't override it — advertising it there would mislead.
const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
const NEW_SESSION_HINT = IS_MAC ? '⌘N' : 'Ctrl N';

// Subscription windows surfaced in the composer's plan-usage popover. Claude has
// named windows; Codex reports primary/secondary windows through its app-server.
const CLAUDE_PLAN_USAGE_ROWS: { key: 'fiveHour' | 'sevenDay' | 'sevenDayOpus' | 'sevenDaySonnet'; label: string }[] = [
  { key: 'fiveHour', label: '5-hour limit' },
  { key: 'sevenDay', label: 'Weekly · all models' },
  { key: 'sevenDayOpus', label: 'Weekly · Opus' },
  { key: 'sevenDaySonnet', label: 'Weekly · Sonnet' },
];
const CODEX_PLAN_USAGE_ROWS: { key: 'primary' | 'secondary'; label: string }[] = [
  { key: 'primary', label: 'Primary limit' },
  { key: 'secondary', label: 'Secondary limit' },
];
const fmtReset = (d?: string): string =>
  d ? new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

type PlanUsageRow = { key: string; label: string; w: PlanUsageWindow };

function usageWindow(usage: PlanUsageSnapshot, key: string): PlanUsageWindow | undefined {
  switch (key) {
    case 'fiveHour':
      return usage.fiveHour;
    case 'sevenDay':
      return usage.sevenDay;
    case 'sevenDayOpus':
      return usage.sevenDayOpus;
    case 'sevenDaySonnet':
      return usage.sevenDaySonnet;
    case 'primary':
      return usage.primary;
    case 'secondary':
      return usage.secondary;
    default:
      return undefined;
  }
}

function usageSnapshotForProvider(usage: PlanUsage | null | undefined, provider: string): PlanUsageSnapshot | null {
  if (!usage) return null;
  if (provider === 'codex') {
    if (usage.codex) return usage.codex;
    return usage.provider === 'codex' || usage.primary || usage.secondary ? usage : null;
  }
  if (provider === 'claude') {
    if (usage.claude) return usage.claude;
    return !usage.provider || usage.provider === 'claude' || usage.fiveHour || usage.sevenDay ? usage : null;
  }
  return null;
}

function usageRows(usage: PlanUsageSnapshot): PlanUsageRow[] {
  const codex = usage.provider === 'codex' || usage.primary || usage.secondary;
  const defs = codex ? CODEX_PLAN_USAGE_ROWS : CLAUDE_PLAN_USAGE_ROWS;
  return defs.flatMap(({ key, label }) => {
    const w = usageWindow(usage, key);
    return w && typeof w.utilization === 'number' ? [{ key, label: w.label || label, w }] : [];
  });
}

// 94_000 → "94k", 1_000_000 → "1M". Compact token count for the context gauge.
const fmtTokens = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : `${n}`;

// The latest turn's context-window occupancy (tokens), read from the newest `turn_end` in
// the loaded events. 0 = the newest turn carries no usable value (older runner, or no turn
// completed) → the gauge reads 0% (as on a new session). Derived from `events` — which holds the boot tail page
// (so it's right on cold open) plus live appends — rather than a separate live signal.
function lastContextTokens(events: RunEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type !== 'turn_end') continue;
    const ct = (events[i].payload as { contextTokens?: unknown } | undefined)?.contextTokens;
    return typeof ct === 'number' && ct > 0 ? ct : 0;
  }
  return 0;
}

// Donut gauge for the context pill — a distinct silhouette from the linear plan-usage bar so the
// session-local context metric doesn't read as "another usage bar". Quiet/neutral until it
// matters, then ramps amber (≥75%) → red (≥90%) as the window fills.
function ContextRing({ pct, tier }: { pct: number; tier: 'neutral' | 'warn' | 'danger' }) {
  const r = 5.5;
  const circ = 2 * Math.PI * r;
  const frac = Math.min(100, Math.max(0, pct)) / 100;
  return (
    <svg
      className={`context-ring context-ring-${tier}`}
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-hidden="true"
    >
      <circle className="context-ring-track" cx="7" cy="7" r={r} fill="none" strokeWidth="2.5" />
      <circle
        className="context-ring-fill"
        cx="7"
        cy="7"
        r={r}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={circ}
        strokeDashoffset={circ * (1 - frac)}
        transform="rotate(-90 7 7)"
      />
    </svg>
  );
}

// Context-window gauge for the composer footer: the ring above + percent of the model's context
// window filled by the latest turn; hover/click reveals the token counts. Distinct from plan
// usage — that's the subscription rate limit.
function ContextWindowIndicator({
  tokens,
  model,
  modelCatalog,
  configured,
}: {
  tokens: number;
  model: string;
  modelCatalog?: Runner['modelCatalog'];
  configured?: ConfiguredProvider[];
}) {
  const windowTokens = contextWindowFor(model, modelCatalog, configured);
  const pct = Math.min(100, Math.round((tokens / windowTokens) * 100));
  const pop = (
    <div className="cu-pop">
      <div className="cu-row">
        <div className="cu-head">
          <span className="cu-label">Context window</span>
          <span className="cu-pct">{pct}%</span>
        </div>
        <div className={`runner-util ${pct >= 90 ? 'full' : ''}`}>
          <span className="runner-util-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="cu-reset">
          {fmtTokens(tokens)} / {fmtTokens(windowTokens)} tokens
        </div>
      </div>
    </div>
  );
  const tier = pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : 'neutral';
  return (
    <Popover content={pop} title="Context" placement="topRight" trigger={['hover', 'click']}>
      <span className="composer-pill composer-usage" aria-label={`Context window ${pct}%`}>
        <ContextRing pct={pct} tier={tier} />
        <span className="composer-usage-pct">{pct}%</span>
      </span>
    </Popover>
  );
}

// Compact plan-usage indicator for the composer footer (right of the effort pill).
// The pill shows the binding/primary window; hover reveals every reported window.
function PlanUsageIndicator({ usage }: { usage: PlanUsageSnapshot }) {
  const rows = usageRows(usage);
  if (rows.length === 0) return null;
  const primaryPct = Math.round(rows[0].w.utilization); // fiveHour when present, else first available
  const pop = (
    <div className="cu-pop">
      {rows.map(({ key, label, w }) => {
        const pct = Math.round(w.utilization);
        return (
          <div className="cu-row" key={key}>
            <div className="cu-head">
              <span className="cu-label">{label}</span>
              <span className="cu-pct">{pct}%</span>
            </div>
            <div className={`runner-util ${pct >= 90 ? 'full' : ''}`}>
              <span className="runner-util-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
            </div>
            {w.resetsAt && <div className="cu-reset">Resets {fmtReset(w.resetsAt)}</div>}
          </div>
        );
      })}
    </div>
  );
  return (
    <Popover content={pop} title="Plan usage" placement="topRight" trigger={['hover', 'click']}>
      <span
        className={`composer-pill composer-usage ${primaryPct >= 90 ? 'full' : ''}`}
        aria-label={`Plan usage ${primaryPct}%`}
      >
        <span className="composer-usage-bar">
          <span
            className="composer-usage-fill"
            style={{ width: `${Math.min(100, Math.max(0, primaryPct))}%` }}
          />
        </span>
        <span className="composer-usage-pct">{primaryPct}%</span>
      </span>
    </Popover>
  );
}

// Drag-resizable width of the left session column, persisted across reloads.
const SESSION_COL_KEY = 'orbit.sessionColWidth';
const SESSION_COL_MIN = 200;
const SESSION_COL_MAX = 560;
const SESSION_COL_DEFAULT = 320;

// Delay the SSE (re)connect on a session switch so holding the arrow keys to scrub
// the list doesn't open-then-immediately-close a connection per session skipped past.
const SWITCH_DEBOUNCE_MS = 150;
// Cap on cached transcripts (mount-scoped), so a long browsing session can't grow
// the cache without bound. Least-recently-selected entries are evicted first.
const TRANSCRIPT_CACHE_MAX = 20;
// Tail-first lazy loading: open a fresh transcript with only its newest page (so a long
// session lands straight at the latest message instead of replaying its whole history), then
// prepend older pages as the user scrolls up. TAIL_PAGE is deliberately large enough to fill
// any viewport in one shot, so no auto-load fires until the user actually scrolls up.
const TAIL_PAGE = 200;
const OLDER_PAGE = 200;
// Distance from the top (px) at which scrolling up pulls in the next older page.
const LOAD_OLDER_AT = 400;

interface TranscriptCacheEntry {
  events: RunEvent[];
  oldestSeq: number | null; // seq of the earliest loaded event (null = nothing loaded)
  hasMoreOlder: boolean; // older events exist before oldestSeq on the server
}

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

// "Background process running" / "N background processes running" — shown when a session is
// parked at AWAITING_INPUT but still has live background shells (server-tracked
// runningBgCount, from Session.runningBgShells), so it doesn't read as idle.
const bgRunningLabel = (n: number): string =>
  n > 1 ? `${n} background processes running` : 'Background process running';

// "Running Agent" / "Running N agents" — shown while a session is working and has a sub-agent
// (Task/Agent tool) in flight (server-tracked runningSubagentCount, from Session.runningSubagents).
// The async Agent tool_result lands at once, so lastToolUse can't carry this on its own.
const subagentRunningLabel = (n: number): string =>
  n > 1 ? `Running ${n} agents` : 'Running Agent';

// Live background work that outlives a parked (AWAITING_INPUT) turn — an async sub-agent
// (Task/Agent) and/or background shells. Returns the label to surface (sub-agent wins), or
// null when the session is genuinely idle. Shared by the list line, status glyph and header
// so all three agree a parked-but-still-working session isn't "waiting for your reply".
const parkedWorkLabel = (s: any): string | null =>
  (s.runningSubagentCount ?? 0) > 0
    ? subagentRunningLabel(s.runningSubagentCount)
    : (s.runningBgCount ?? 0) > 0
      ? bgRunningLabel(s.runningBgCount)
      : null;

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
    // A sub-agent in flight: lastToolUse is already cleared (the async Agent tool_result +
    // the parent's own system progress events), so surface it explicitly instead of falling
    // through to the muted last-reply preview, which reads as idle.
    if ((s.runningSubagentCount ?? 0) > 0)
      return { text: `${subagentRunningLabel(s.runningSubagentCount)}…`, tone: 'running' };
    // A turn just started and the agent hasn't replied yet: show the message you just sent (the
    // server sets lastUserText while the user turn is the frontier and clears it the moment a
    // reply or tool lands) instead of the now-stale previous reply. It's content, not status —
    // the spinner already carries "working" — so it takes the muted preview tone, not blue.
    if (s.lastUserText) return { text: plainPreview(s.lastUserText), tone: 'preview' };
    if (s.lastAssistantText) return { text: plainPreview(s.lastAssistantText), tone: 'preview' };
    return { text: 'Running…', tone: 'running' };
  }
  if (live && s.status === 'PENDING') return { text: 'Queued', tone: 'queued' };
  // Parked (AWAITING_INPUT) but still doing background work — a sub-agent and/or background
  // shells that outlive the turn — so it doesn't read as idle. A spawned sub-agent parks the
  // parent at AWAITING_INPUT while it runs, so this (not the RUNNING branch) is what usually
  // surfaces "Running Agent…".
  const parked = live ? parkedWorkLabel(s) : null;
  if (parked) return { text: `${parked}…`, tone: 'running' };
  if (s.lastAssistantText) return { text: plainPreview(s.lastAssistantText), tone: 'preview' };
  return null;
};

// State word for the session header — mirrors StatusIcon's branching (and its tooltip
// wording) so the glyph and the header label always agree.
function statusLabel(session: any): string {
  if (session.deletedAt) return 'Deleted';
  if (session.archivedAt && session.status !== 'FAILED') return 'Completed';
  const status: string = session.status;
  if (status === 'RUNNING')
    return (session.pendingApprovals ?? 0) > 0 ? 'Waiting for approval' : 'Running';
  if (status === 'AWAITING_INPUT') return parkedWorkLabel(session) ?? 'Waiting for your reply';
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
  if (session.deletedAt)
    return (
      <Tooltip title="Deleted">
        <MinusCircleOutlined style={{ color: 'var(--text-3)', fontSize }} />
      </Tooltip>
    );
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
  if (status === 'AWAITING_INPUT') {
    const work = parkedWorkLabel(session);
    return work ? (
      <Tooltip title={work}>
        <LoadingOutlined spin style={{ color: 'var(--brand)', fontSize }} />
      </Tooltip>
    ) : (
      <Tooltip title="Waiting for your reply">
        <MessageOutlined style={{ color: 'var(--text-3)', fontSize }} />
      </Tooltip>
    );
  }
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

// Remembers the session the user last had open per agent (agent id → session id). Switching
// away to another agent and back reopens that conversation instead of the agent's most-recent
// one. In-memory only (a full reload deep-links via the URL) and at module scope so it survives
// AgentView remounts across runner switches.
const lastSessionByAgent = new Map<string, string>();

export function AgentView({ runner }: { runner: Runner }) {
  const { message, modal } = AntApp.useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  // The signed-in user, for the account-synced default effort (seeds a new session's Effort
  // pill; written on change below). Cached/deduped with the nav footer's `me`.
  const me = useQuery(meQuery());
  // Configured providers (custom slugs borrowing a built-in runtime) merged into the composer's
  // model list + context-window sizing when the open session/agent uses one. Cached/deduped
  // app-wide by React Query; empty until it loads (then the model pill's options fill in).
  const configuredProviders = useQuery(providersQuery()).data ?? [];
  // The picked session lives in the URL (/sessions/:id, a base62 public id) so
  // it deep-links and survives a refresh; selecting a session = navigation.
  // Decode once here; everything downstream works with the raw session UUID.
  const selectedId = decodeId(useMatch('/sessions/:id')?.params.id);
  // Latest selectedId, readable from async callbacks (loadOlder) to bail if the user has
  // switched sessions since the request was issued — so a late page never lands in the wrong
  // transcript. Assigning during render is safe for a "current value" ref.
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  // Inline header-title rename: double-click swaps the title for an input. `editingTitle`
  // gates the editor, `titleDraft` holds the in-progress text, `cancelTitleEdit` lets
  // Escape skip the blur-commit. Switching sessions closes any open editor (effect below).
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const cancelTitleEdit = useRef(false);
  // Size the rename input to its text (via an off-screen mirror) so the underline hugs the
  // title instead of spanning the whole header; CSS caps it at the available width.
  const titleMirrorRef = useRef<HTMLSpanElement>(null);
  const [titleInputW, setTitleInputW] = useState(0);
  useLayoutEffect(() => {
    if (editingTitle) setTitleInputW((titleMirrorRef.current?.offsetWidth ?? 0) + 2);
  }, [editingTitle, titleDraft]);
  // /agents/<id> names the agent this console is scoped to: the picker is locked
  // to it and the session list is filtered to that agent's conversations.
  // /agents/<id>/new is the "compose a new session" draft state (the splat is 'new').
  const agentMatch = useMatch('/agents/:id/*');
  const lockedAgentId = decodeId(agentMatch?.params.id);
  const composingRoute = (agentMatch?.params['*'] ?? '') === 'new';
  // Below the mobile breakpoint the two panes stack one-at-a-time; a couple of layout
  // choices (the auto-open redirect, the in-pane back button) key off this.
  const isMobile = useIsMobile();
  // Installed-PWA / standalone is the only mode where ⌘N actually reaches the page
  // (a normal tab hands it to the browser). Gate the on-button shortcut hint on it.
  const isStandalone = useMediaQuery('(display-mode: standalone)');
  // Touch devices have no hover, so a tap that shows a Tooltip never gets the mouseleave
  // that dismisses it — the bubble lingers on screen (e.g. an "Unpin" tip stuck after a
  // pin tap, or a composer pill's tip stacked over the Select it just opened). Suppress
  // these tooltips where hover is unavailable; every gated control already labels itself.
  const hoverTipOpen = useMediaQuery('(hover: hover)') ? undefined : false;
  const [text, setText] = useState('');
  // Composer history cursor: -1 = editing the live draft; otherwise an index into the
  // session's stored history. `histDraft` stashes what was typed before recall started,
  // so stepping back past the newest entry restores it (shell-style).
  const [histIdx, setHistIdx] = useState(-1);
  const [histDraft, setHistDraft] = useState('');
  // Composer drafts are isolated per target — each session by its id, the new-session
  // compose under the 'new' key — so switching sessions never drags one composer's text
  // into another, and the new-session draft survives leaving and coming back. textRef
  // mirrors `text` so the switch effect (below) can stash the *outgoing* draft without
  // re-running on every keystroke; prevDraftKey tracks which target `text` belongs to.
  const draftKey = selectedId ?? 'new';
  const drafts = useRef<Map<string, string>>(new Map());
  const textRef = useRef('');
  const prevDraftKey = useRef(draftKey);
  const [mode, setMode] = useState('Default');
  const [model, setModel] = useState(DEFAULT_MODEL);
  // Seeded from the account default by the effect below once `me` loads (mirrors how Model/Mode
  // seed via effects); '' = model default until then.
  const [effort, setEffort] = useState('');
  // Which slice of the session list to show: active, archived, system, or trash.
  const [view, setView] = useState<'active' | 'archived' | 'deleted' | 'system'>('active');
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null); // session row whose action menu is open
  // Touch swipe-to-reveal for session rows: hover has no touch equivalent, so on mobile the
  // row's actions (pin/complete, or the ⋯ menu) hide behind a leftward swipe instead.
  const [swipeOpenId, setSwipeOpenId] = useState<string | null>(null); // row held open by a swipe
  const [swipeDragId, setSwipeDragId] = useState<string | null>(null); // row currently under a finger drag
  const [swipeDx, setSwipeDx] = useState(0); // live drag offset (px; negative = leftward)
  // mx (live horizontal delta) and wasOpen live on the ref so touchend reads them synchronously:
  // React defers continuous touchmove state, so swipeDx state can be stale when discrete touchend fires.
  const swipeRef = useRef<{
    id: string;
    x: number;
    y: number;
    axis: '' | 'h' | 'v';
    mx: number;
    wasOpen: boolean;
  } | null>(null);
  const swipeClickGuard = useRef(false); // eat the click that trails a horizontal swipe
  const [shareOpen, setShareOpen] = useState(false); // share dialog for the open session
  const [agentId, setAgentId] = useState<string | undefined>(undefined);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [approvals, setApprovals] = useState<ApprovalInfo[]>([]); // pending tool-permission requests
  // "Chat about this" on a pending AskUserQuestion routes the next composer send back to
  // that approval as a deny+message (resolving the blocking question) instead of a fresh
  // turn. Null = normal send; `question` is just the reply-chip's label.
  const [replyTo, setReplyTo] = useState<{ id: string; question: string } | null>(null);
  const [streamingText, setStreamingText] = useState(''); // live assistant text from text_delta
  const [streamingThink, setStreamingThink] = useState(''); // live thinking from thinking_delta
  const [idle, setIdle] = useState(false); // session is AWAITING_INPUT (a new turn is accepted)
  const [queued, setQueued] = useState<QueuedTurn[]>([]); // messages sent while a turn was running
  // The apiserver's authoritative background-shell list (all launches + output recovered from the
  // agent's Read polls). The loaded event window only holds recent launches, so the tray merges
  // this complete set with its live-derived overlay — see BackgroundShellsTray.
  const [serverBgShells, setServerBgShells] = useState<BgShell[]>([]);
  const [images, setImages] = useState<ComposerImage[]>([]); // images staged in the composer
  // Images already sent, keyed by their turnId. The runner echoes only the turn's text,
  // so these local previews are joined back into the user bubble (and the queued bubble)
  // to show the sent image in the transcript. Object URLs are revoked on session switch.
  const [turnImages, setTurnImages] = useState<Record<string, TurnImage[]>>({});
  const seen = useRef<Set<number>>(new Set());
  // Per-session transcript cache (mount-scoped): switching seeds events from here for
  // an instant paint and resumes the SSE just past the cached seq, instead of replaying
  // each session's full history from seq 0 on every visit. Stores the older-pagination
  // boundary too, so a reopened session keeps its "load earlier" state.
  const transcriptCache = useRef<Map<string, TranscriptCacheEntry>>(new Map());
  // Live mirror of `events`, so the SSE handler (append) and loadOlder (prepend) both mutate
  // one source of truth without racing stale closures — see the load effect below.
  const accRef = useRef<RunEvent[]>([]);
  // Tail-first lazy loading state for the open session. Refs drive the (deps-free) scroll
  // handler; loadingOlder (state) drives the top "loading earlier" spinner.
  const oldestSeqRef = useRef<number | null>(null); // earliest loaded seq
  const hasMoreOlderRef = useRef(false); // older events exist before oldestSeq on the server
  const loadingOlderRef = useRef(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Set by loadOlder just before it prepends a page; a layout effect reads it to compensate
  // scrollTop so the viewport stays put instead of jumping when older content grows above.
  const prependAnchorRef = useRef<{ prevHeight: number; prevTop: number } | null>(null);
  // Re-opens the transcript SSE after a `final` event paused it and the session was
  // resumed in place (set by the SSE effect, called by the liveness watcher below).
  const resumeStreamRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null); // the left session-list column, for arrow-key scrolling

  // How far a row slides to expose its actions. The active tab shows two chips (pin + ✓),
  // every other tab a single ⋯, so it needs less room.
  const swipeReveal = view === 'active' ? 72 : 44;
  const onRowTouchStart = (e: ReactTouchEvent, id: string): void => {
    if (!isMobile) return;
    const t = e.touches[0];
    // Clear any guard left set by a prior swipe that fired no trailing click, so the next
    // genuine tap isn't swallowed.
    swipeClickGuard.current = false;
    swipeRef.current = { id, x: t.clientX, y: t.clientY, axis: '', mx: 0, wasOpen: swipeOpenId === id };
  };
  const onRowTouchMove = (e: ReactTouchEvent): void => {
    const st = swipeRef.current;
    if (!st) return;
    const t = e.touches[0];
    const mx = t.clientX - st.x;
    const my = t.clientY - st.y;
    // Lock the axis once the finger clears a small deadzone; a vertical intent yields to the
    // list's own scroll and never drags the row.
    if (st.axis === '') {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      st.axis = Math.abs(mx) > Math.abs(my) ? 'h' : 'v';
      if (st.axis === 'h') {
        setSwipeDragId(st.id);
        setSwipeOpenId((cur) => (cur && cur !== st.id ? null : cur)); // starting a swipe shuts any other open row
      }
    }
    if (st.axis !== 'h') return;
    st.mx = mx; // synchronous truth for the touchend decision
    const base = st.wasOpen ? -swipeReveal : 0;
    setSwipeDx(Math.max(-swipeReveal - 20, Math.min(0, base + mx))); // clamp with a little left-side rubber-band
  };
  const onRowTouchEnd = (): void => {
    const st = swipeRef.current;
    swipeRef.current = null;
    if (!st || st.axis !== 'h') {
      setSwipeDragId(null);
      return;
    }
    swipeClickGuard.current = true; // the trailing click (if any) must not navigate
    // Decide by gesture direction, not absolute position: a deliberate left drag opens a closed
    // row; any clear right drag dismisses an open one. Reading st.mx (a ref) avoids the stale
    // swipeDx state that React's deferred touchmove updates would otherwise leave at touchend.
    const open = st.wasOpen ? st.mx <= 16 : st.mx < -swipeReveal / 2;
    setSwipeOpenId(open ? st.id : null);
    setSwipeDragId(null);
    setSwipeDx(0);
  };
  // An OS-interrupted gesture (system swipe, incoming call) fires touchcancel, not touchend —
  // drop the drag and let the row settle back to its committed open/closed state.
  const onRowTouchCancel = (): void => {
    swipeRef.current = null;
    setSwipeDragId(null);
    setSwipeDx(0);
  };
  // The user's prompt for the turn currently in view, surfaced as a sticky bar when a long
  // answer has pushed that bubble off the top — so what was asked stays findable. null hides it.
  const [stuck, setStuck] = useState<{ seq: string | null; text: string; loading?: boolean } | null>(null);
  // Smart auto-scroll: only keep pinned to the bottom when the user is already there, so
  // reading history (or jumping to the sticky prompt) isn't yanked back by streaming updates.
  const atBottomRef = useRef(true);
  // Render mirror of atBottomRef: drives the floating "jump to bottom" button, which shows
  // only while the user has scrolled up off the live tail. (The ref alone can't re-render.)
  const [atBottom, setAtBottom] = useState(true);
  // Last observed scrollTop, so the scroll handler can tell a genuine user scroll-up from a
  // programmatic re-pin or a late scroll event fired after streaming grew the container.
  const lastTopRef = useRef(0);
  // Tail-first lazy loading: pull in the next older page when the user scrolls near the top.
  // Guarded to one request in flight; prepends the page and stamps prependAnchorRef so the
  // layout effect below holds the viewport steady while older content grows above it.
  const loadOlder = useCallback(() => {
    if (!selectedId || loadingOlderRef.current || !hasMoreOlderRef.current) return;
    const before = oldestSeqRef.current;
    if (before == null) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    getSessionEventPage(selectedId, { before, limit: OLDER_PAGE })
      .then((page) => {
        if (selectedIdRef.current !== selectedId) return; // user switched sessions mid-fetch
        const fresh = page.events.filter((e) => !seen.current.has(e.seq));
        for (const e of fresh) if (typeof e.seq === 'number') seen.current.add(e.seq);
        if (fresh.length) {
          const el = scrollRef.current;
          if (el) prependAnchorRef.current = { prevHeight: el.scrollHeight, prevTop: el.scrollTop };
          accRef.current = [...fresh, ...accRef.current];
          setEvents(accRef.current);
        }
        oldestSeqRef.current = page.events.length ? page.events[0].seq : before;
        hasMoreOlderRef.current = page.hasMore;
        transcriptCache.current.set(selectedId, {
          events: accRef.current,
          oldestSeq: oldestSeqRef.current,
          hasMoreOlder: page.hasMore,
        });
      })
      .catch(() => undefined)
      .finally(() => {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      });
  }, [selectedId]);
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
    // Near the top with older history still on the server → pull in the next page.
    if (top < LOAD_OLDER_AT) loadOlder();
    const topY = el.getBoundingClientRect().top;
    const bubbles = Array.from(
      el.querySelectorAll<HTMLElement>('.chat-user:not(.chat-queued)'),
    ).filter((b) => !b.closest('.chat-subagent')); // ignore prompts nested in a sub-agent transcript
    let cur: HTMLElement | null = null;
    for (const b of bubbles) {
      if (b.getBoundingClientRect().bottom <= topY + 1) cur = b;
      else break;
    }
    if (cur) {
      setStuck({ seq: cur.getAttribute('data-seq'), text: cur.textContent || '' });
    } else if (hasMoreOlderRef.current) {
      // No loaded user prompt sits above the viewport, but older pages remain: the prompt for
      // the content now in view is in an unloaded page. Don't blank the bar — show a loading
      // state and pull the earlier page in (no-op if one is already in flight), so measure
      // re-runs after the prepend and resolves the real question.
      setStuck({ seq: null, text: '', loading: true });
      loadOlder();
    } else {
      setStuck(null);
    }
  }, [loadOlder]);
  // Snap back to the live tail; the scroll events it fires re-pin atBottomRef via measure().
  const scrollToBottom = useCallback(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, []);
  // Called on send: re-pin to the live tail so a message fired while scrolled up snaps back to the
  // bottom (and stays pinned as the reply streams) instead of stranding the user in history. The
  // scroll goes to the current tail now for instant feedback; setting atBottomRef ensures the
  // content-change effect below re-pins once the new bubble lands. macOS/iOS parity: ConsoleModel's
  // localSendTick forces the same scroll on send.
  const pinToBottom = useCallback(() => {
    atBottomRef.current = true;
    setAtBottom(true);
    scrollToBottom();
  }, [scrollToBottom]);
  // Width of the left session column; drag the divider to resize, persisted to
  // localStorage so the choice survives a reload.
  const [colWidth, setColWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(SESSION_COL_KEY));
    return saved >= SESSION_COL_MIN && saved <= SESSION_COL_MAX ? saved : SESSION_COL_DEFAULT;
  });
  const [resizing, setResizing] = useState(false);

  // The list is scoped by `view`. A selected session (its transcript is open) is
  // resolved from the loaded set, so force a view that contains it: `system` when
  // browsing the System tab (system sessions live there), `archived` when browsing
  // Completed (so an opened completed session resolves and stays highlighted),
  // otherwise `active` — where live sessions and the runner's slot accounting live.
  // (active also includes system sessions server-side, so deep-linking one still
  // resolves.)
  const effectiveView = selectedId
    ? view === 'system'
      ? 'system'
      : view === 'archived'
        ? 'archived'
        : 'active'
    : view;
  // One factory call drives both the list query and the optimistic-update key below, so
  // they can never drift apart; it's also the exact key the BootGate splash pre-warms.
  const sessionsOpts = sessionsQuery({ runnerId: runner.id, view: effectiveView });
  const sessionsKey = sessionsOpts.queryKey;
  // While the control-plane stream is connected it pushes list changes (a coalesced refetch per
  // event), so stop the 4s poll; on any stream gap `controlLive` flips false and it resumes.
  const controlLive = useControlPlaneLive();
  const sessionsQ = useQuery({ ...sessionsOpts, refetchInterval: controlLive ? false : 4000 });

  const sessions = useMemo(() => {
    const rows = (sessionsQ.data ?? []).slice();
    // The Completed (archived) view is ordered by the server on archived_at (newest
    // completed first) and intentionally ignores pinning. The optimistic cache edits
    // (drop/rename/pin) only remove or patch rows in place — never reorder — and a real
    // archive reconciles via refetch, so the server order holds. Trust it verbatim.
    if (effectiveView === 'archived') return rows;
    return rows.sort((a, b) => {
      // Pinned sessions float to the top; among themselves they keep time order.
      if (!!a.pinnedAt !== !!b.pinnedAt) return a.pinnedAt ? -1 : 1;
      const ta = a.lastTurnAt ?? a.createdAt;
      const tb = b.lastTurnAt ?? b.createdAt;
      return ta < tb ? 1 : -1;
    });
  }, [sessionsQ.data, effectiveView]);
  const selectedFromList = useMemo(
    () => sessions.find((s) => s.id === selectedId) ?? null,
    [sessions, selectedId],
  );
  // Close the header-title editor whenever the open session changes — a stale draft must
  // never commit onto a different session.
  useEffect(() => setEditingTitle(false), [selectedId]);
  // Detail of the open session, keyed the same as TasksSidePanel so React Query dedupes
  // the fetch. Its only job here is to resolve the session's agent the instant it's opened:
  // a freshly created session isn't in the list query yet (so `selected` is null), but its
  // detail is primed synchronously in send.onSuccess, so this keeps `scopeAgentId` stable
  // across the /agents/<id>/new → /sessions/<id> navigation. Without it the list briefly
  // un-scopes (shows every agent's sessions) until the list refetch lands.
  const sessionDetailQ = useQuery({
    ...sessionQuery(selectedId),
    placeholderData: keepPreviousData,
    // Poll the detail when either side has a live update the runner pushes via heartbeat:
    // while the session is live, for the worktree status bar (isolation + uncommitted diff,
    // reported mid-turn) to appear without waiting for turn_end; and while a "merge to main"
    // or "commit" is pending, for the runner's outcome (≤1 heartbeat away) to land. Idle else.
    refetchInterval: (q) =>
      q.state.data?.mergeStatus === 'pending' || q.state.data?.commitStatus === 'pending'
        ? 3000
        : selectedFromList && !TERMINAL.includes(selectedFromList.status)
          ? 5000
          : false,
  });
  const detailForSelected = sessionDetailQ.data?.id === selectedId ? sessionDetailQ.data : null;
  const selectedFromDetail = useMemo(() => {
    const d = detailForSelected as any;
    // A freshly-created session primes only id/runner/agent into this cache; keep the
    // existing "Starting..." placeholder until the real detail/list row supplies title/status.
    if (!d || typeof d.title !== 'string' || typeof d.status !== 'string') return null;
    return {
      ...d,
      runningBgCount: Array.isArray(d.runningBgShells) ? d.runningBgShells.length : (d.runningBgCount ?? 0),
      runningSubagentCount: Array.isArray(d.runningSubagents)
        ? d.runningSubagents.length
        : (d.runningSubagentCount ?? 0),
      pendingApprovals: d.pendingApprovals ?? 0,
    };
  }, [detailForSelected]);
  const selected = selectedFromList ?? selectedFromDetail;
  const selectedMissing = !!selectedId && !selected && sessionDetailQ.isError;
  const selectedDeleted = !!selected?.deletedAt;
  // A merge's outcome lands asynchronously (≤1 heartbeat after the click) — but the only place
  // it surfaces is the worktree status bar, and only if the user is still on this session with the
  // file panel expanded. Toast the landing (success or the failure reason) the moment it flips off
  // 'pending', so it's noticed even after they look away. Tracked per session id so switching to an
  // already-failed session doesn't re-fire — only a real pending→result transition toasts.
  const prevMergeRef = useRef<{ id: string; status: string | null } | null>(null);
  useEffect(() => {
    const d = detailForSelected;
    if (!d) return;
    const prev = prevMergeRef.current;
    const was = prev && prev.id === d.id ? prev.status : null;
    prevMergeRef.current = { id: d.id, status: d.mergeStatus ?? null };
    if (was !== 'pending' || !d.mergeStatus || d.mergeStatus === 'pending') return;
    const target = d.mergeTarget || 'main';
    if (d.mergeStatus === 'merged') {
      message.success(`Merged into ${target} ✓`);
    } else if (d.mergeStatus === 'conflict') {
      message.error({
        content: `Merge into ${target} hit a conflict — aborted, your branch is untouched. Resolve it from the status bar.`,
        duration: 8,
      });
    } else {
      message.error({
        content: `Merge into ${target} failed: ${d.mergeError ?? 'see the status bar for details.'}`,
        duration: 8,
      });
    }
  }, [detailForSelected, message]);
  const live = selected && !selectedDeleted ? !TERMINAL.includes(selected.status) : false;
  // An ended session can be revived (--resume claude's context) only if it actually
  // ran and its runner is online — the transcript lives on that machine's disk.
  const resumable = !!selected && !selectedDeleted && !live && !!selected.startedAt && runner.online;
  // The session list (always visible in the left column) is scoped to one agent so
  // it reads as a conversation with that agent. On /agents/<id> that's the locked
  // agent; on a /sessions/<id> deep link the URL carries no agent, so fall back to
  // the selected session's own agent.
  const scopeAgentId = lockedAgentId ?? selected?.agent?.id ?? detailForSelected?.agent?.id ?? null;
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

  // Remember the open session as this agent's last-viewed one, so returning to the agent
  // (an agent-switch away and back, or clicking it in the sidebar) restores it below.
  useEffect(() => {
    const agentId = selected?.agent?.id;
    if (selectedId && agentId) lastSessionByAgent.set(agentId, selectedId);
  }, [selectedId, selected?.agent?.id]);

  // Default landing: opening /agents/<id> on the active tab (no session, not the /new draft)
  // opens a session so the right pane is never blank. Prefer the one the user last had open
  // for this agent (remembered above) — reopening where they left off — and fall back to the
  // most recent when there's no memory (or it's since been archived/deleted out of view).
  // replace() keeps it out of history; archived/trash tabs never auto-open.
  useEffect(() => {
    // On mobile the list is its own full screen — auto-opening would trap the back
    // button (it returns here, which would immediately redirect into a session again).
    if (isMobile || selectedId || composingRoute || view !== 'active' || !sessionsQ.isSuccess)
      return;
    const remembered = scopeAgentId ? lastSessionByAgent.get(scopeAgentId) : undefined;
    const target = visibleSessions.find((s) => s.id === remembered) ?? visibleSessions[0];
    if (target) navigate(`/sessions/${encodeId(target.id)}`, { replace: true });
  }, [
    isMobile,
    selectedId,
    composingRoute,
    view,
    sessionsQ.isSuccess,
    visibleSessions,
    scopeAgentId,
    navigate,
  ]);

  // Step the open session up/down the visible list. Shared by the window-level Up/Down
  // handler and the Segmented's capture handler below. Returns false (a no-op) at the
  // list ends, on an empty list, or on the trash tab with nothing open. With
  // nothing selected, Down enters from the top, Up from the bottom.
  const stepSession = useCallback(
    (dir: 1 | -1): boolean => {
      if (!selectedId && view !== 'active' && view !== 'system' && view !== 'archived') return false;
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
    const provider = selected.provider ?? detailForSelected?.provider ?? 'claude';
    setModel(selected.model ?? defaultModelForProvider(provider, runner.modelCatalog, configuredProviders));
    setMode(PERMISSION_TO_MODE[selected.permissionMode ?? 'dontAsk'] ?? 'Default');
    setEffort(normalizeEffortForProvider(provider, selected.effort ?? ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, live]);

  // Composing a fresh session (no session selected): seed the model from the
  // picked agent's configured default (set on the Runner page). A selected
  // session instead seeds from its own stored config (effect above).
  useEffect(() => {
    if (selectedId || !pickedAgent) return;
    setModel(
      pickedAgent.model ??
        defaultModelForProvider(pickedAgent.provider ?? 'claude', runner.modelCatalog, configuredProviders),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, pickedAgent?.id, pickedAgent?.model, pickedAgent?.provider]);

  // A fresh session seeds its effort with the most specific default available: the picked agent's
  // own effort (set on the Runner page) first, else the account-level default-effort preference
  // (synced across devices — the iOS/macOS clients seed the same fallback). `??` treats only
  // null/undefined as "unset", so an agent explicitly set to Default ('') stays Default rather than
  // falling through. Reacts to `me` loading so the pill fills once preferences arrive.
  useEffect(() => {
    if (selectedId) return;
    const provider = pickedAgent?.provider ?? 'claude';
    const candidate = pickedAgent?.effort ?? me.data?.preferences?.defaultEffort ?? '';
    setEffort(normalizeEffortForProvider(provider, candidate));
  }, [selectedId, pickedAgent?.provider, pickedAgent?.effort, me.data?.preferences?.defaultEffort]);

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

  // Mirror the live composer text into a ref. Declared before the switch effect so that
  // on a commit changing both `text` and `draftKey` (e.g. send → navigate + clear) this
  // runs first and the switch effect reads the latest text.
  useEffect(() => {
    textRef.current = text;
  }, [text]);

  // On a target switch, stash the outgoing draft under its key and restore the incoming
  // one (empty if none). Resets the history cursor so recall starts fresh per target.
  useEffect(() => {
    if (prevDraftKey.current === draftKey) return;
    drafts.current.set(prevDraftKey.current, textRef.current);
    setText(drafts.current.get(draftKey) ?? '');
    setHistIdx(-1);
    setHistDraft('');
    prevDraftKey.current = draftKey;
  }, [draftKey]);

  // Subscribe to the session's event stream; reset only when the selection changes.
  useEffect(() => {
    // Live/ephemeral drafts belong to the previous selection — clear them at once.
    setStreamingText('');
    setStreamingThink('');
    setApprovals([]);
    setReplyTo(null);
    setQueued([]);
    setIdle(false);
    setStuck(null);
    // Staged uploads are scoped to the previous session (can't be linked to another), and
    // the sent-image previews are this session's object URLs — drop and revoke both.
    setImages((prev) => {
      prev.forEach((im) => im.previewUrl && URL.revokeObjectURL(im.previewUrl));
      return [];
    });
    setTurnImages((prev) => {
      Object.values(prev).forEach((refs) => refs.forEach((r) => URL.revokeObjectURL(r.url)));
      return {};
    });
    atBottomRef.current = true; // a freshly opened/switched session starts pinned to the latest
    lastTopRef.current = 0;
    setAtBottom(true); // hide the jump-to-bottom button until the new session reports otherwise
    // Reset tail-first lazy-loading state for the session being opened.
    prependAnchorRef.current = null;
    loadingOlderRef.current = false;
    setLoadingOlder(false);
    if (!selectedId) {
      accRef.current = [];
      setEvents([]);
      seen.current = new Set();
      oldestSeqRef.current = null;
      hasMoreOlderRef.current = false;
      return;
    }
    const isSeq = (s: unknown): s is number =>
      typeof s === 'number' && s !== Number.MAX_SAFE_INTEGER;
    // Seed from cache for an instant paint; touch the entry so it's most-recently-used. On a
    // cache miss the transcript stays empty until boot() fetches the newest page below (no more
    // replaying the whole history over SSE — that's what caused a long session to "fast-forward"
    // on open). The older-pagination boundary is restored from cache, or established by boot().
    const cache = transcriptCache.current;
    const entry = cache.get(selectedId);
    const cached = entry?.events ?? [];
    if (entry) {
      cache.delete(selectedId);
      cache.set(selectedId, entry);
    }
    accRef.current = cached;
    setEvents(cached);
    setServerBgShells([]); // clear the previous session's list until the fetch below repopulates it
    seen.current = new Set(cached.map((e) => e.seq).filter(isSeq));
    oldestSeqRef.current = entry ? entry.oldestSeq : null;
    hasMoreOlderRef.current = entry ? entry.hasMoreOlder : false;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    // Set when a `final` event arrives: the connection is dropped (don't hold an idle
    // stream to a finished session) but NOT permanently — unlike `closed`, a paused
    // stream can be re-opened in place when the session resumes (see resumeStreamRef).
    let paused = false;
    let fails = 0;
    // Resume just past what's loaded so only the gap is streamed, not the whole history.
    let lastSeq = cached.reduce((m, e) => (isSeq(e.seq) ? Math.max(m, e.seq) : m), 0);
    const writeCache = (): void => {
      cache.set(selectedId, {
        events: accRef.current,
        oldestSeq: oldestSeqRef.current,
        hasMoreOlder: hasMoreOlderRef.current,
      });
      if (cache.size > TRANSCRIPT_CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined && oldest !== selectedId) cache.delete(oldest);
      }
    };
    const stop = (): void => {
      closed = true;
      if (retry) clearTimeout(retry);
      es?.close();
    };
    const push = (ev: RunEvent): void => {
      accRef.current = [...accRef.current, ev];
      writeCache();
      setEvents(accRef.current);
    };
    const connect = (): void => {
      es = new EventSource(sessionEventsUrl(selectedId, lastSeq));
      es.onmessage = (e) => {
        fails = 0; // a message means the stream is healthy
        const ev = JSON.parse(e.data) as RunEvent;
        // Server keepalive (~20s): a health byte with no seq/payload, sent so an idle transcript
        // stream isn't reaped by Cloudflare. Discard it by type before the reducer below, which
        // would otherwise dedup-miss (seq undefined) and append it as a junk transcript row.
        if (ev.type === 'ping') return;
        if (typeof ev.seq === 'number' && ev.seq !== Number.MAX_SAFE_INTEGER) {
          lastSeq = Math.max(lastSeq, ev.seq);
        }
        if (ev.payload?.final) {
          // Session finalized (turn-complete failure, idle-recycle to PARKED, or a user
          // end). Drop the live connection so we don't hold an idle stream — but a
          // PARKED/ended session is resumable IN PLACE (same selectedId, so this effect
          // doesn't re-run), and a resumed turn's events would be published to a stream
          // we'd have permanently closed, leaving the open transcript stale while the
          // polled sidebar advances. So pause instead of closing for good; the liveness
          // watcher re-opens it (replaying the missed seq) once the session is live again.
          paused = true;
          es?.close();
          return;
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
        if (ev.type === 'turn_end') {
          setIdle(true);
          // Refresh the worktree status bar: the runner reports this turn's diff +
          // isolation on /turn-complete. Delay a touch so that POST (which persists
          // changed_files) lands before we refetch the detail, rather than racing the
          // turn_end event broadcast.
          setTimeout(() => qc.invalidateQueries({ queryKey: ['session', selectedId] }), 400);
        }
        else if (ev.type === 'user') {
          setIdle(false);
          // The runner just picked up this turn — it's now in the transcript, so drop
          // it from the local queue (no-op if it wasn't ours / already cleared).
          if (ev.turnId) setQueued((q) => q.filter((x) => x.turnId !== ev.turnId));
        }
      };
      es.onerror = () => {
        es?.close();
        if (closed || paused) return;
        // Auto-reconnect, resuming after lastSeq — survives long idle / redeploy
        // drops (the seq dedup set makes any replay overlap harmless).
        if (++fails > 12) return;
        retry = setTimeout(connect, Math.min(2000 * fails, 15000) + Math.random() * 500);
      };
    };
    // Bridge for the liveness watcher: re-open a stream paused by a `final` event once the
    // session is live again. No-op unless paused (so it's safe to call on any status tick);
    // reconnect resumes from lastSeq, so the server replays the turns missed while paused.
    resumeStreamRef.current = () => {
      if (closed || !paused) return;
      paused = false;
      fails = 0;
      connect();
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
      // The complete background-shell list (all launches, output recovered from Read polls) —
      // the loaded event window only holds the most recent launches, so without this the tray
      // under-counts a long session. Merged with the live-derived overlay in the tray.
      getBackgroundShells(selectedId)
        .then(setServerBgShells)
        .catch(() => undefined);
      // Tail-first: on a cache miss, fetch just the newest page so the transcript opens
      // straight at the latest message, then open the SSE from that page's max seq so it
      // streams only new events (no full-history replay). With a cached transcript already on
      // screen, skip straight to the SSE, which replays only the gap after the cached seq.
      const boot = async (): Promise<void> => {
        if (cached.length === 0) {
          try {
            const page = await getSessionEventPage(selectedId, { tail: TAIL_PAGE });
            if (closed) return;
            accRef.current = page.events;
            for (const e of page.events) if (isSeq(e.seq)) seen.current.add(e.seq);
            oldestSeqRef.current = page.events.length ? page.events[0].seq : null;
            hasMoreOlderRef.current = page.hasMore;
            lastSeq = page.events.reduce((m, e) => (isSeq(e.seq) ? Math.max(m, e.seq) : m), lastSeq);
            setEvents(accRef.current);
            writeCache();
          } catch {
            // Fall through to the SSE, which will replay from seq 0 as before.
          }
          if (closed) return;
        }
        connect();
      };
      void boot();
    }, SWITCH_DEBOUNCE_MS);
    return () => {
      resumeStreamRef.current = null;
      clearTimeout(start);
      stop();
    };
  }, [selectedId]);

  // Polled fallback for idleness, in case an SSE turn_end was missed / reconnected.
  // Also keyed on selectedId so it re-syncs on a session switch: the SSE effect above
  // resets idle→false for the freshly opened session, but switching between two sessions
  // that share a status (both AWAITING_INPUT) wouldn't change `runStatus`, so without the
  // selectedId dep this effect wouldn't re-run and idle would stay wrongly false — flipping
  // turnActive on and hiding the worktree bar's "committed"/merge state until a refresh.
  const runStatus: string | undefined = selected?.status;
  useEffect(() => {
    if (runStatus === 'AWAITING_INPUT') setIdle(true);
    else if (runStatus === 'RUNNING') setIdle(false);
  }, [runStatus, selectedId]);

  // A finalized session can be resumed in place (same selectedId, so the SSE effect above
  // doesn't re-run and its stream was paused on `final`). When the polled status shows it
  // live again, re-open the paused stream so the open transcript catches the resumed turn —
  // otherwise only the sidebar (separately polled) would advance and the conversation would
  // look stuck until a manual refresh.
  useEffect(() => {
    if (live) resumeStreamRef.current?.();
  }, [live]);

  // Tail-first prepend: after loadOlder grows older content above the viewport, restore the
  // scroll position so what the user was reading stays put instead of jumping down. Runs before
  // paint (layout effect), and before the at-bottom follow below (a passive effect) — which
  // no-ops here anyway since prepending only happens while scrolled up (atBottomRef false).
  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    if (!anchor) return;
    prependAnchorRef.current = null;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight - anchor.prevHeight + anchor.prevTop;
  }, [events]);

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
    // The events-driven pin above only re-scrolls when the transcript's *content* changes, so
    // it misses growth the container itself causes. On mobile the conversation pane is
    // display:none until a session is opened, so the open-time scroll runs against a
    // zero-height box and never lands at the tail; and the composer's worktree status bar
    // loads in async, shrinking the scroll area after the fact. Re-pin to the tail on any such
    // resize while the user is still at the bottom.
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current) el.scrollTo({ top: el.scrollHeight });
    });
    ro.observe(el);
    // Screenshots load after their <img> lays out at zero height, so the content grows *below*
    // the tail without an events change. `load` doesn't bubble but fires in the capture phase,
    // so one listener on the scroller catches every image and re-pins.
    const onLoad = (e: Event): void => {
      if (atBottomRef.current && e.target instanceof HTMLImageElement)
        el.scrollTo({ top: el.scrollHeight });
    };
    el.addEventListener('load', onLoad, { capture: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('load', onLoad, { capture: true });
      ro.disconnect();
    };
  }, [selectedId, measure]);

  // Allow/deny a pending tool-permission request; optimistically drop it (the
  // approval_resolved SSE also removes it), re-fetching to resync on failure.
  const decide = async (
    approvalId: string,
    behavior: 'allow' | 'deny',
    answers?: Record<string, string[]>,
    message?: string,
    rememberRules?: PermissionRule[],
  ): Promise<void> => {
    if (!selectedId) return;
    setApprovals((prev) => prev.filter((x) => x.id !== approvalId));
    try {
      await decideApproval(selectedId, approvalId, behavior, message, answers, rememberRules);
    } catch {
      listApprovals(selectedId)
        .then(setApprovals)
        .catch(() => undefined);
    }
  };

  // If the approval the composer is replying to gets resolved another way (the user picks
  // an option, or an SSE approval_resolved arrives), drop the reply context so the chip
  // can't dangle over a question that's already gone.
  useEffect(() => {
    if (replyTo && !approvals.some((a) => a.id === replyTo.id)) setReplyTo(null);
  }, [approvals, replyTo]);

  const send = useMutation({
    mutationFn: async (
      vars: { content: string; images: ComposerImage[]; shell?: boolean },
    ): Promise<{ id: string; turnId?: string; queuedItem?: QueuedTurn; created?: boolean }> => {
      const { content, images: imgs, shell } = vars;
      if (selectedDeleted) throw new Error('Restore this session before sending a message');
      if (selectedMissing) throw new Error('Session not found');
      // Only fully-uploaded images carry an id to reference; onSend blocks while any is
      // still uploading, so this is the complete set.
      const attachmentIds = imgs.map((im) => im.id).filter((x): x is string => !!x);
      // Continue a live session; revive an ended-but-resumable one (same row, claude
      // --resumes its context); otherwise (no selection, or unresumable) start a fresh
      // session so the composer never dead-locks. All three carry the pasted images: the
      // create path scopes them to the new session (server links them to the seeded first
      // turn), so a brand-new session composed from scratch can include screenshots too.
      if (selected && live) {
        const res = await sendTurn(selected.id, content, attachmentIds, shell ? 'shell' : undefined);
        // A turn already running ⇒ this message is queued (delivered once that turn
        // finishes); surface it as a pending bubble the user can withdraw. When idle
        // it's delivered right away, so it'll arrive via its own `user` event instead.
        // Shell turns never show a pending bubble — their output lands as a Bash card.
        const queuedItem = idle || shell ? undefined : { turnId: res.turnId, content };
        return { id: selected.id, turnId: res.turnId, queuedItem };
      }
      if (selected && resumable) {
        // The pills were seeded from this session's stored config, so an untouched
        // send keeps it and an edited Mode/Model/Effort is re-applied on resume.
        // A `!cmd` revives via a shell turn: claude --resumes (context restored) and the
        // runner runs the command, buffering its output for the next message.
        const provider = selected.provider ?? detailForSelected?.provider ?? 'claude';
        const wireEffort = normalizeEffortForProvider(provider, effort);
        const res = await resumeSession(
          selected.id,
          content,
          { model, permissionMode: MODE_TO_PERMISSION[mode], effort: wireEffort || undefined },
          attachmentIds,
          shell ? 'shell' : undefined,
        );
        return { id: selected.id, turnId: res.turnId };
      }
      const provider = pickedAgent?.provider ?? 'claude';
      const wireEffort = normalizeEffortForProvider(provider, effort);
      const created = await createInteractiveSession({
        prompt: content,
        assignedRunnerId: runner.id,
        agentId,
        model,
        permissionMode: MODE_TO_PERMISSION[mode],
        // Send even '' (Default) explicitly: the composer already seeds the pill from the agent's
        // default, so the pill is authoritative — an explicit Default must stick, not fall back to
        // the agent's effort server-side (session.effort ?? agent.effort). Task runs omit it, so
        // those still inherit the agent default.
        effort: wireEffort,
        attachmentIds,
        // A `!cmd` draft seeds the session's first turn as a shell command, not a message.
        shell,
      });
      return { id: created.id, created: true };
    },
    onSuccess: ({ id, turnId, queuedItem, created }, vars) => {
      pushHistory(id, vars.shell ? `!${vars.content}` : vars.content); // record under the resolved session id, new sessions included
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
      // Hand the sent image previews to the transcript, keyed by turnId, so they show in
      // the user bubble immediately (the runner echoes the text + attachment refs). Only
      // inline images have a local object URL; files render from the durable ref echo. The
      // URLs move here as-is — setImages([]) below drops the chips without revoking them.
      const previews = vars.images.filter((im) => im.previewUrl);
      if (turnId && previews.length) {
        const refs: TurnImage[] = previews.map((im) => ({ url: im.previewUrl as string, mime: im.file.type }));
        setTurnImages((m) => ({ ...m, [turnId]: refs }));
      } else if (created && previews.length) {
        // The create path has no turnId to key local previews on (the runner seeds the
        // first turn), so free these object URLs — the seeded turn's `user` event carries
        // the attachment refs and the transcript fetches them back for display.
        previews.forEach((im) => im.previewUrl && URL.revokeObjectURL(im.previewUrl));
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
    onSuccess: (_d, id) => {
      setView('active');
      qc.invalidateQueries({ queryKey: ['sessions'] });
      qc.invalidateQueries({ queryKey: ['session', id] });
    },
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
  // Permanent delete (from Trash): unlike deleteMut there's no undo — the row and all its
  // data are gone — so it's always gated behind confirmPurge's modal.
  const purgeMut = useMutation({
    mutationFn: (id: string) => purgeSession(id),
    onSuccess: (_d, id) => {
      leaveIfOpen(id);
      dropFromLists(id);
      qc.invalidateQueries({ queryKey: ['sessions'] });
      message.success('Permanently deleted');
    },
    onError: (e: Error) => message.error(e.message),
  });
  const confirmPurge = (id: string): void => {
    modal.confirm({
      title: 'Delete permanently?',
      content:
        'This session and its full transcript will be permanently deleted. This cannot be undone.',
      okText: 'Delete permanently',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      onOk: () => purgeMut.mutate(id),
    });
  };
  // Double-click the header title to rename. Optimistically patch the title into every
  // cached session list (the header reads `selected.title` off that list, not the detail
  // query) so the new name shows instantly; reconcile or roll back on settle.
  const renameMut = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => renameSession(id, title),
    onMutate: ({ id, title }) =>
      qc.setQueriesData<any[]>({ queryKey: ['sessions'] }, (old) =>
        Array.isArray(old) ? old.map((s) => (s.id === id ? { ...s, title } : s)) : old,
      ),
    onError: (e: Error) => message.error(e.message),
    onSettled: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
  // Pin/unpin a session to the top of the list. Optimistically flip pinnedAt in every cached
  // list (mirrors renameMut) so the row jumps immediately; reconcile on settle.
  const pinMut = useMutation({
    mutationFn: ({ id, pin }: { id: string; pin: boolean }) =>
      pin ? pinSession(id) : unpinSession(id),
    onMutate: ({ id, pin }) =>
      qc.setQueriesData<any[]>({ queryKey: ['sessions'] }, (old) =>
        Array.isArray(old)
          ? old.map((s) =>
              s.id === id ? { ...s, pinnedAt: pin ? new Date().toISOString() : null } : s,
            )
          : old,
      ),
    onError: (e: Error) => message.error(e.message),
    onSettled: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
  // Enable worktree isolation for a non-git agent: flip autoInitGit so the runner `git
  // init`s the workDir on the next run (the shared-nogit nudge clears once a run isolates).
  const enableIsoMut = useMutation({
    mutationFn: (agentId: string) => enableAgentIsolation(agentId),
    onSuccess: () =>
      message.success('Isolation enabled — the next run will initialize git and isolate.'),
    onError: (e: Error) => message.error(e.message),
  });
  const askEnableIsolation = (agentId: string) =>
    modal.confirm({
      title: 'Enable worktree isolation?',
      content:
        "This initializes a git repo in the agent's working directory (a default .gitignore" +
        ' + a baseline commit of the existing files) on its next run, so concurrent sessions' +
        ' each get their own branch instead of sharing the directory.',
      okText: 'Enable',
      // Swallow a rejected enable (onError already toasts) so confirm() closes cleanly
      // instead of leaving an unhandled promise rejection.
      onOk: () => enableIsoMut.mutateAsync(agentId).catch(() => {}),
    });
  // Merge this session's worktree branch into main on the runner that ran it. Async: the
  // runner merges on its next heartbeat and the outcome lands on sessionDetail.mergeStatus
  // (the status bar polls while pending). Invalidate detail so 'pending' shows immediately.
  const mergeMut = useMutation({
    mutationFn: (vars: { id: string; target?: string }) => mergeSessionToMain(vars.id, vars.target),
    onSuccess: () => {
      // No success toast: the status bar reflects the pending merge and its outcome.
      if (selectedId) qc.invalidateQueries({ queryKey: ['session', selectedId] });
    },
    onError: (e: Error) => message.error(e.message),
  });
  // Resolve a merge conflict in-session: revive the session so its own agent rebases the branch
  // onto the latest main and fixes the conflicts (it has the context for its own changes); the
  // rebase bakes the resolution into the branch's commits, so the runner's rebase merge then
  // fast-forwards cleanly. resume() clears the stale mergeStatus, so the bar offers "Merge to
  // main" again once the agent finishes.
  const resolveMut = useMutation({
    mutationFn: (vars: { id: string; branch: string }) =>
      resumeSession(
        vars.id,
        'Rebase this branch onto the latest `main` and resolve any conflicts.\n\n' +
          "You're in this session's isolated git worktree, checked out on `" +
          vars.branch +
          '`. Run `git rebase main` — it may stop on conflicts. For each, resolve every conflict' +
          ' using your knowledge of the changes made on this branch, `git add` the resolved' +
          ' files, then `git rebase --continue`, repeating until the rebase completes. Do not' +
          ' push. Once the rebase finishes, the branch can be merged into main cleanly from the' +
          ' status bar above the composer.',
      ),
    onSuccess: () => {
      message.success('Resuming the session to resolve the conflict…');
      if (selectedId) {
        qc.invalidateQueries({ queryKey: ['session', selectedId] });
        qc.invalidateQueries({ queryKey: ['sessions'] });
      }
    },
    onError: (e: Error) => message.error(e.message),
  });
  // Commit a live session's uncommitted worktree changes onto its branch. Like merge it runs
  // on the runner (heartbeat round-trip) and the outcome lands on commitStatus/worktreeDirty;
  // committing is safe/local so it fires directly (no confirm). Invalidate detail so 'pending'
  // shows immediately and the poll above picks up the runner's outcome.
  const commitMut = useMutation({
    mutationFn: (id: string) => commitSession(id),
    onSuccess: () => {
      // No success toast: the status bar reflects the pending commit and its outcome.
      if (selectedId) qc.invalidateQueries({ queryKey: ['session', selectedId] });
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
  const canAttach = runner.online && !selectedDeleted && (selected ? live || resumable : composing);
  const imageUid = useRef(0);
  // Validate, then upload an attachment as a staged chip. Uploaded eagerly (not on send) so
  // the turn carries only the id and a slow upload doesn't block typing. When composing
  // there's no session yet, so it's uploaded unscoped; create scopes it to the new session.
  // An inline-image type gets a thumbnail preview and the tighter image cap; any other type
  // is a generic file (no preview, 25MB cap) that the runner drops into the worktree.
  const addImage = useCallback(
    async (file: File): Promise<void> => {
      if (!canAttach) return;
      const isInlineImage = ALLOWED_IMAGE_TYPES.includes(file.type);
      const cap = isInlineImage ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
      if (file.size <= 0) {
        message.error(`${file.name || 'File'} is empty`);
        return;
      }
      if (file.size > cap) {
        message.error(isInlineImage ? 'Image exceeds the 5MB limit' : 'File exceeds the 25MB limit');
        return;
      }
      const uid = `att-${imageUid.current++}`;
      const previewUrl = isInlineImage ? URL.createObjectURL(file) : undefined;
      setImages((prev) => [...prev, { uid, file, previewUrl, status: 'uploading' }]);
      try {
        const { id } = await uploadAttachment(file, selected?.id);
        setImages((prev) => prev.map((im) => (im.uid === uid ? { ...im, status: 'done', id } : im)));
      } catch (e) {
        // Drop the failed chip and free its preview; the toast explains why.
        setImages((prev) => prev.filter((im) => im.uid !== uid));
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        message.error((e as Error).message);
      }
    },
    [canAttach, selected, message],
  );
  const removeImage = (uid: string): void => {
    setImages((prev) => {
      const target = prev.find((im) => im.uid === uid);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
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
    // Replying to a pending AskUserQuestion: resolve it with the text as a deny+message
    // (claude reads it as feedback and continues) instead of a fresh turn. The deny channel
    // is text-only — a blocking question can only be answered with text — so attached images
    // can't ride it; deliver them as the immediately-following turn via the normal image path
    // (send.mutate, whose onSuccess also clears the staged chips). An image-only reply still
    // needs a text resolution, hence the stand-in message.
    if (replyTo) {
      const imgs = readyImages;
      if (!c && imgs.length === 0) return;
      pinToBottom();
      void decide(replyTo.id, 'deny', undefined, c || '(see attached image)');
      setReplyTo(null);
      setText('');
      if (imgs.length > 0) {
        setHistIdx(-1);
        send.mutate({ content: '', images: imgs });
      }
      return;
    }
    if (!c && readyImages.length === 0) return;
    pinToBottom();
    setHistIdx(-1);
    // `!cmd` runs a raw shell command on the runner (bypassing claude): on a live session,
    // as the first turn of a brand-new draft (no selection), or as the revive turn of an
    // ended-but-resumable session — the server seeds it as a shell turn and the runner runs
    // it once it claims the session (a resume --resumes claude first, so its context is back
    // before the command runs). Its output echoes to the transcript and feeds claude as
    // context on the next message. A bare `!` is a no-op; images are ignored. Only an
    // unresumable ended session falls through (no claude to wake — start fresh instead).
    if (c.startsWith('!') && (live || resumable || !selected)) {
      const cmd = c.slice(1).trim();
      if (cmd) send.mutate({ content: cmd, images: [], shell: true });
      else setText('');
      return;
    }
    send.mutate({ content: c, images: readyImages });
  };
  // Open the new-session draft for this agent. A /sessions/<id> URL carries no
  // agent, so resolve it from the open session (scopeAgentId), then the first agent.
  const goNew = (): void => {
    const a = scopeAgentId ?? agentsForRunner[0]?.id;
    navigate(a ? `/agents/${encodeId(a)}/new` : `/runners/${encodeId(runner.id)}`);
    // No setText here: the per-target switch effect restores the saved 'new' draft, and
    // blanking would instead clobber the *outgoing* session's draft (text hasn't moved yet).
    // Drop the caret into the composer so the task can be typed straight away — both the
    // "New session" click and the ⌘N shortcut funnel through here. Deferred a tick so the
    // switch effect has swapped in the 'new' draft before focus lands.
    setTimeout(() => taRef.current?.focus(), 0);
  };
  // ⌘/Ctrl+N opens the new-session draft — the keyboard twin of the "New session" button,
  // and the web mirror of the macOS client's ⌘N. Like ⌘D it fires even while the composer
  // is focused. Heads-up: most desktop browsers reserve ⌘N for "New Window" and won't let
  // the page override it, so preventDefault is best-effort (works in standalone/PWA).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() !== 'n' || e.shiftKey || e.altKey) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      goNew();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goNew]);
  // While the selected session is still loading we can't tell if it's live yet;
  // block send to avoid accidentally creating a duplicate session.
  const loadingSession = !!selectedId && !selected && !selectedMissing;
  // A live session accepts a message in any non-terminal state: RUNNING/INTERRUPTED queue
  // it, AWAITING_INPUT runs it now, and PENDING (still waiting for a slot, no claude yet)
  // queues it until the runner claims the session. A non-live (ended) session revives or
  // starts fresh. `live` is exactly "not terminal", so no per-status gate is needed here.
  const canSend =
    (!!text.trim() || readyImages.length > 0) &&
    !send.isPending &&
    !uploading &&
    runner.online &&
    !selectedDeleted &&
    !selectedMissing &&
    !loadingSession;
  // The single send button morphs into a Stop while a turn is generating AND the composer
  // is empty — interrupting that turn. With content typed it stays Send, so a follow-up can
  // still be queued mid-turn. Ending the whole session isn't a button here: it's destructive
  // and the reaper recycles an idle/finished session's slot on its own.
  const showStop =
    selected?.status === 'RUNNING' && !text.trim() && readyImages.length === 0 && !replyTo;

  // ── `/` command & skill autocomplete ──────────────────────────────────────
  // The runner reports its on-disk slash commands/skills via heartbeat (runner.commands
  // / runner.skills). Show them as a hint menu while the cursor sits on a `/token`
  // at the start of input or right after whitespace/newline, like the Claude Code TUI;
  // picking one replaces just that token with `/<name> ` (the trailing space drops the
  // regex match, so the menu auto-hides).
  const taRef = useRef<any>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Manual composer height (px). null = autoSize auto-grow (up to maxRows); once the user
  // drags the top handle, that height wins over autoSize until they double-click to reset.
  const [composerHeight, setComposerHeight] = useState<number | null>(null);
  // Drag the top handle to set an explicit composer height. Drag up = taller; the height is
  // clamped so it can't collapse away or swallow the transcript.
  const startComposerResize = useCallback((e: ReactMouseEvent): void => {
    e.preventDefault();
    const ta: HTMLTextAreaElement | undefined = taRef.current?.resizableTextArea?.textArea;
    const startY = e.clientY;
    const startH = ta?.offsetHeight ?? composerHeight ?? 120;
    const onMove = (ev: MouseEvent): void => {
      setComposerHeight(Math.min(Math.max(startH + (startY - ev.clientY), 44), 640));
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [composerHeight]);
  // The resize handle only earns its keep once auto-grow has hit its maxRows cap (the box is
  // scrolling) or the user already dragged an explicit height — a short/empty box has nothing
  // worth resizing, so we hide the handle until then. Re-measure whenever the text or the
  // manual height changes (a double-click reset drops us back to auto-grow).
  const [composerCapped, setComposerCapped] = useState(false);
  useEffect(() => {
    const ta: HTMLTextAreaElement | undefined = taRef.current?.resizableTextArea?.textArea;
    if (!ta) return;
    // Measure on the next frame, after rc-textarea's autoSize pass settles this value's height.
    const id = requestAnimationFrame(() => {
      setComposerCapped(ta.scrollHeight > ta.clientHeight + 1);
    });
    return () => cancelAnimationFrame(id);
  }, [text, composerHeight]);
  // Drag-and-drop files anywhere onto the session pane (transcript + composer) — a far bigger
  // target than the composer box, matching Slack/ChatGPT. Same upload path as the picker/paste,
  // gated on canAttach. dragDepth counts enter/leave across child elements (each fires its own
  // events) so the drop hint doesn't flicker as the pointer crosses messages, the textarea, etc.
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const dragHasFiles = (e: ReactDragEvent): boolean =>
    Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const onSessionDragEnter = (e: ReactDragEvent): void => {
    if (!canAttach || !dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onSessionDragOver = (e: ReactDragEvent): void => {
    if (!canAttach || !dragHasFiles(e)) return;
    // preventDefault marks the pane a valid drop target; without it the browser opens the file.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onSessionDragLeave = (): void => {
    if (!dragging) return;
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragging(false);
    }
  };
  const onSessionDrop = (e: ReactDragEvent): void => {
    dragDepth.current = 0;
    setDragging(false);
    if (!canAttach) return;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (!files.length) return;
    e.preventDefault();
    files.forEach((f) => void addImage(f));
  };
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
  // The `+` menu opens the picker scoped to one asset kind; null (manual `/` typing) shows both.
  const [slashScope, setSlashScope] = useState<'command' | 'skill' | null>(null);
  const slashToken = /(?:^|\s)\/(\S*)$/.exec(text)?.[1] ?? null;
  // Scope the `/` menu to the composer's agent: host-level assets (no agentId — e.g.
  // ~/.claude or the runner's default dir) plus the assets of the agent this session
  // runs as. A live session's agent is fixed; a draft uses the picked agent.
  const composerAgentId = live ? selected?.agent?.id : agentId;
  const slashItems = useMemo(
    () =>
      [
        ...(runner.commands ?? []).map((c) => ({ name: c.name, description: c.description, type: 'command' as const, agentId: c.agentId })),
        ...(runner.skills ?? []).map((s) => ({ name: s.name, description: s.description, type: 'skill' as const, agentId: s.agentId })),
      ].filter((it) => !it.agentId || it.agentId === composerAgentId),
    [runner.commands, runner.skills, composerAgentId],
  );
  const slashMatches = useMemo(() => {
    if (slashToken === null) return [];
    const q = slashToken.toLowerCase();
    return slashItems
      .filter((it) => (slashScope === null || it.type === slashScope) && it.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const pa = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const pb = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return pa - pb || a.name.localeCompare(b.name);
      })
      .slice(0, 50);
  }, [slashItems, slashToken, slashScope]);
  useEffect(() => {
    setSlashIndex(0);
    if (slashToken === null) setSlashScope(null);
  }, [slashToken]);
  const showSlash =
    slashToken !== null &&
    slashToken !== slashDismissed &&
    runner.online &&
    !selectedDeleted &&
    !selectedMissing &&
    slashMatches.length > 0;
  const slashIdx = slashMatches.length ? Math.min(slashIndex, slashMatches.length - 1) : 0;
  const pickSlash = (name: string): void => {
    // Replace only the trailing `/token` ($1 preserves the start-or-whitespace before
    // it), so picking a command mid-message doesn't clobber text typed earlier.
    setText(text.replace(/(^|\s)\/\S*$/, `$1/${name} `));
    setSlashDismissed(null);
    setTimeout(() => taRef.current?.focus(), 0);
  };
  // Open the autocomplete from the `+` menu scoped to one asset kind: drop a `/` (prefixed
  // with a space when mid-message) so slashToken matches and the menu pops.
  const insertSlash = (scope: 'command' | 'skill'): void => {
    setSlashScope(scope);
    setText((t) => (t === '' || /\s$/.test(t) ? `${t}/` : `${t} /`));
    setSlashDismissed(null);
    setTimeout(() => taRef.current?.focus(), 0);
  };
  // The `+` menu "Shell" entry: prefix the draft with `!` so onSend routes it as a raw
  // shell command (run on the runner, bypassing claude). The user types the command after.
  const insertShell = (): void => {
    setText((t) => (t.startsWith('!') ? t : `!${t}`));
    setTimeout(() => taRef.current?.focus(), 0);
  };
  // "Chat about this" on a question card hands the reply off to the main composer: show the
  // reply-context chip and focus the box. The send itself is rerouted to a deny in onSend.
  const startChatReply = (id: string, question: string): void => {
    setReplyTo({ id, question });
    setTimeout(() => taRef.current?.focus(), 0);
  };
  // A LIVE session's pills show its stored choice (editable any time the runner is
  // online — see configEditable); otherwise they're editable and reflect local state.
  const shownModel: string = live ? (selected.model ?? DEFAULT_MODEL) : model;
  const shownProvider: string = selected
    ? (selected.provider ??
        detailForSelected?.provider ??
        detailForSelected?.agent?.provider ??
        'claude')
    : (pickedAgent?.provider ?? 'claude');
  const shownPlanUsage = usageSnapshotForProvider(runner.planUsage, shownProvider);
  const contextTokens = lastContextTokens(events);
  const shownMode: string = live
    ? (PERMISSION_TO_MODE[selected.permissionMode ?? 'dontAsk'] ?? 'Default')
    : mode;
  const shownEffort: string = normalizeEffortForProvider(
    shownProvider,
    live ? (selected.effort ?? '') : effort,
  );
  const shownEffortOptions = effortOptionsForProvider(shownProvider);
  // Auto is offered only on models that support it (see supportsAuto); the option
  // is greyed out otherwise so an unsupported model can't pick a mode claude rejects.
  const autoOk = supportsAuto(shownModel);
  // Model, Mode & Effort can be changed any time on a live session (the runner must be
  // online to act on it). A change made mid-turn doesn't abort the running turn: the
  // server defers the re-spawn until the turn finishes, so it applies on the next turn —
  // same as a queued message. When not live they're freely editable (pre-session config).
  // Agent stays fixed once the session exists (it's never re-assigned on resume).
  const configEditable = selectedDeleted || selectedMissing ? false : live ? runner.online : true;
  // An existing session's agent is fixed (live or recycled/terminal); only a brand-new
  // compose draft reflects the local pick.
  const shownAgentId: string | undefined = selected ? (selected.agent?.id ?? undefined) : agentId;
  // The agent can't be switched once the session exists (live or terminal), nor when the
  // view is locked to one agent. In those cases it's read-only info, so we surface it as a
  // static pill in the controls row (see composer-pill-static) instead of a Select; otherwise
  // it stays a Select.
  const agentReadOnly = !!selected || !!lockedAgentId;
  const shownAgentName =
    agentsForRunner.find((a) => a.id === shownAgentId)?.name ??
    selected?.agent?.name ??
    lockedAgent?.name;
  // Per-control hints derived from the same state that drives enable/disable, so the help
  // can't drift from behaviour (this used to be one hard-coded paragraph on the whole row).
  // Empty string = no tooltip, which keeps idle controls free of hover noise.
  const composerDisabled = !runner.online || selectedDeleted || selectedMissing;
  const configHint = selectedDeleted
    ? 'Restore this session before changing settings'
    : selectedMissing
      ? 'Session not found'
      : live && !runner.online
        ? 'Runner offline — cannot change this now'
        : '';
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
      : selectedMissing
        ? 'Session not found'
      : selectedId
        ? 'Starting…'
        : '';
  const composerPlaceholder = selectedDeleted
    ? 'Restore this session to continue'
    : selectedMissing
      ? 'Session not found'
      : !runner.online
        ? 'Runner offline'
        : replyTo
          ? 'Reply to Claude’s question…'
          : selectedId
            ? 'Reply…'
            : 'Send this agent a task…';

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
          {isStandalone && !isMobile && <kbd className="session-new-kbd">{NEW_SESSION_HINT}</kbd>}
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
            // session belongs to the tab it was opened from, so browsing another tab
            // means leaving the conversation.
            if (selectedId) {
              const a = scopeAgentId ?? agentsForRunner[0]?.id;
              navigate(a ? `/agents/${encodeId(a)}` : `/runners/${encodeId(runner.id)}`);
            }
          }}
          options={[
            { label: 'Active', value: 'active' },
            { label: 'Completed', value: 'archived' },
            { label: 'System', value: 'system' },
            { label: 'Trash', value: 'deleted' },
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
              label: 'Delete',
              danger: true,
              onClick: ({ domEvent }: { domEvent: { stopPropagation: () => void } }) => {
                domEvent.stopPropagation();
                deleteMut.mutate(s.id);
              },
            };
            const purgeItem = {
              key: 'purge',
              icon: <DeleteOutlined />,
              label: 'Delete permanently',
              danger: true,
              onClick: ({ domEvent }: { domEvent: { stopPropagation: () => void } }) => {
                domEvent.stopPropagation();
                confirmPurge(s.id);
              },
            };
            const menuItems: MenuProps['items'] =
              view === 'archived'
                ? [restoreItem, { type: 'divider' }, deleteItem]
                : view === 'system'
                  ? [deleteItem]
                  : view === 'deleted'
                    ? [restoreItem, { type: 'divider' }, purgeItem]
                    : [restoreItem];
            // Active, System and Completed (archived) rows open their transcript; only
            // Trash (deleted) rows stay closed.
            const openable = view !== 'deleted';
            const line = sessionLine(s, openable);
            const swiped = swipeOpenId === s.id;
            const dragging = swipeDragId === s.id;
            const swipeTx = dragging ? swipeDx : swiped ? -swipeReveal : 0;
            return (
              <div
                className={`session-row${openable ? '' : ' no-open'}${s.id === selectedId ? ' active' : ''}${menuOpenId === s.id ? ' menu-open' : ''}${view === 'active' && s.pinnedAt ? ' pinned' : ''}${swiped ? ' swipe-open' : ''}`}
                key={s.id}
                onClick={() => {
                  if (swipeClickGuard.current) {
                    swipeClickGuard.current = false;
                    return; // this click merely ends a swipe
                  }
                  if (swipeOpenId) {
                    setSwipeOpenId(null); // a tap anywhere on an open row just closes it
                    return;
                  }
                  if (openable) navigate(`/sessions/${encodeId(s.id)}`);
                }}
                onTouchStart={(e) => onRowTouchStart(e, s.id)}
                onTouchMove={onRowTouchMove}
                onTouchEnd={onRowTouchEnd}
                onTouchCancel={onRowTouchCancel}
              >
                <div
                  className={`session-swipe${dragging ? ' dragging' : ''}`}
                  style={swipeTx ? { transform: `translateX(${swipeTx}px)` } : undefined}
                >
                  <span className="session-icon">
                    <StatusIcon session={s} completed={view === 'archived'} />
                  </span>
                  <div className="session-main">
                    <div className="session-title-row">
                      <div className="session-title">{s.title}</div>
                      {(s.mergeStatus === 'error' || s.mergeStatus === 'conflict') && (
                        <Tooltip
                          title={
                            s.mergeStatus === 'conflict' ? 'Merge conflict — needs resolving' : 'Merge failed'
                          }
                          placement="top"
                          open={hoverTipOpen}
                        >
                          <span className="session-merge-badge">⚠</span>
                        </Tooltip>
                      )}
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
                </div>
                <div className="session-right">
                  <div className="session-actions" onClick={(e) => e.stopPropagation()}>
                    {view === 'active' ? (
                      <>
                        <Tooltip title={s.pinnedAt ? 'Unpin' : 'Pin to top'} placement="top" open={hoverTipOpen}>
                          <span
                            className="session-kebab session-pin-toggle"
                            onClick={(e) => {
                              e.stopPropagation();
                              pinMut.mutate({ id: s.id, pin: !s.pinnedAt });
                              setSwipeOpenId(null);
                            }}
                          >
                            {s.pinnedAt ? <PushpinFilled /> : <PushpinOutlined />}
                          </span>
                        </Tooltip>
                        <Tooltip title={ended ? 'Complete' : 'Complete & end session'} placement="top" open={hoverTipOpen}>
                          <span
                            className="session-kebab session-complete"
                            onClick={(e) => {
                              e.stopPropagation();
                              archiveMut.mutate(s.id);
                              setSwipeOpenId(null);
                            }}
                          >
                            <CheckOutlined />
                          </span>
                        </Tooltip>
                      </>
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

      <div
        className="agent-view"
        onDragEnter={onSessionDragEnter}
        onDragOver={onSessionDragOver}
        onDragLeave={onSessionDragLeave}
        onDrop={onSessionDrop}
      >
        {/* Drop-to-upload hint covering the whole session pane while files are dragged over it. */}
        {dragging && (
          <div className="agent-dropzone">
            <PaperClipOutlined /> Drop files to upload
          </div>
        )}
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
            {editingTitle && selected && !composing ? (
              <>
                <span ref={titleMirrorRef} className="agent-name-mirror" aria-hidden="true">
                  {titleDraft || ' '}
                </span>
                <input
                  className="agent-name-input"
                  style={{ width: titleInputW }}
                  autoFocus
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onFocus={(e) => {
                    // Select all (double-click-to-rename = type replaces), but anchor the
                    // caret at the START so a long title shows its head, not its tail.
                    const el = e.currentTarget;
                    el.setSelectionRange(0, el.value.length, 'backward');
                  }}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return; // let the IME (e.g. pinyin) keep Enter
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      e.currentTarget.blur();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelTitleEdit.current = true;
                      e.currentTarget.blur();
                    }
                  }}
                  onBlur={() => {
                    setEditingTitle(false);
                    if (cancelTitleEdit.current) {
                      cancelTitleEdit.current = false;
                      return;
                    }
                    const t = titleDraft.trim();
                    if (t && t !== selected.title) renameMut.mutate({ id: selected.id, title: t });
                  }}
                />
              </>
            ) : (
              <div
                className="agent-name"
                {...(selected && !selectedDeleted && !composing
                  ? {
                      onDoubleClick: () => {
                        setTitleDraft(selected.title);
                        setEditingTitle(true);
                      },
                      title: 'Double-click to rename',
                    }
                  : {})}
              >
                {composing
                  ? 'New session'
                  : (selected?.title ?? (selectedMissing ? 'Session not found' : selectedId ? 'Starting…' : headAgentName))}
              </div>
            )}
            <div className="agent-sub">{headSub}</div>
          </div>
          {selected && !composing && (
            <>
              <Dropdown
                trigger={['click']}
                placement="bottomRight"
                menu={{
                  items: selectedDeleted
                    ? [
                        {
                          key: 'restore',
                          icon: <UndoOutlined />,
                          label: 'Restore',
                          onClick: () => restoreMut.mutate(selected.id),
                        },
                        { type: 'divider' },
                        {
                          key: 'purge',
                          icon: <DeleteOutlined />,
                          danger: true,
                          label: 'Delete permanently',
                          onClick: () => confirmPurge(selected.id),
                        },
                      ]
                    : [
                        {
                          key: 'share',
                          icon: <ShareAltOutlined />,
                          label: detailForSelected?.shareToken ? 'Share · link active' : 'Share…',
                          onClick: () => setShareOpen(true),
                        },
                        { type: 'divider' },
                        {
                          key: 'delete',
                          icon: <DeleteOutlined />,
                          danger: true,
                          label: 'Delete',
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

        {selected && !selectedDeleted && !composing && (
          <ShareModal
            open={shareOpen}
            onClose={() => setShareOpen(false)}
            sessionId={selected.id}
            initialToken={detailForSelected?.shareToken ?? null}
          />
        )}

        {stuck && (
          <button
            className={stuck.loading ? 'chat-sticky-question chat-sticky-loading' : 'chat-sticky-question'}
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
            <span className="chat-sticky-text">
              {stuck.loading ? 'Loading earlier messages…' : stuck.text}
            </span>
          </button>
        )}

        <div className="agent-scroll-wrap">
          {selectedMissing ? (
            <div className="agent-sessions" ref={scrollRef}>
              <div className="chat-note">Session not found.</div>
            </div>
          ) : selectedId ? (
            <div className="agent-sessions" ref={scrollRef}>
              {loadingOlder && <div className="chat-note chat-loading-older">Loading earlier messages…</div>}
              {selected && !selectedDeleted && selected.status === 'PENDING' && events.length === 0 && (
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
              <Transcript events={events} live={live} turnImages={turnImages} artifactSessionId={selectedId} />
              {streamingThink && <div className="chat-think-stream chat-streaming">💭 {streamingThink}</div>}
              {streamingText && <StreamingMessage text={streamingText} />}
              {!selectedDeleted && approvals.map((a, i) => (
                // Only the first (oldest) pending card owns the ⌘/Ctrl+Enter shortcut; once
                // it's decided the next card becomes first, so the key walks the queue in order.
                <ApprovalPanel
                  key={a.id}
                  approval={a}
                  onDecide={decide}
                  active={i === 0}
                  onChatAbout={startChatReply}
                />
              ))}
              {!selectedDeleted && queued.map((q) => (
                <div className="chat-msg chat-user chat-queued" key={q.turnId}>
                  {turnImages[q.turnId]?.length ? (
                    // Fresh local previews (object URLs) — instant, before a reload drops them.
                    <div className="chat-images">
                      {turnImages[q.turnId].map((im, i) => (
                        <ChatImage key={i} src={im.url} />
                      ))}
                    </div>
                  ) : q.attachments?.length ? (
                    // After a reload the local previews are gone; fetch the refs the queued-turn
                    // list carries from the server, so an image-only turn stays visible.
                    <div className="chat-images">
                      {q.attachments.map((a) => (
                        <AttachmentImage key={a.id} id={a.id} />
                      ))}
                    </div>
                  ) : null}
                  {q.content && <span className="chat-queued-text">{q.content}</span>}
                  <span className="chat-queued-meta">
                    <span className="chat-queued-tag">Queued</span>
                    <a onClick={() => cancelQueued(q.turnId)}>Cancel</a>
                  </span>
                </div>
              ))}
              {selected &&
                !selectedDeleted &&
                !TERMINAL.includes(selected.status) &&
                selected.status !== 'PENDING' &&
                events.length === 0 &&
                !streamingText &&
                !streamingThink && <div className="chat-note">Waiting for the agent…</div>}
              {selected &&
                selectedDeleted &&
                (() => {
                  // Days until the reaper permanently purges this trashed session. Reframes
                  // the retained transcript as an honest, time-boxed Trash rather than a
                  // "delete that didn't delete", and offers a real permanent delete.
                  const left = selected.deletedAt
                    ? Math.max(
                        0,
                        Math.ceil(
                          (new Date(selected.deletedAt).getTime() +
                            TRASH_RETENTION_DAYS * 86_400_000 -
                            Date.now()) /
                            86_400_000,
                        ),
                      )
                    : null;
                  const when =
                    left === null
                      ? ''
                      : left <= 0
                        ? ' · deletes soon'
                        : ` · auto-deletes in ${left} day${left === 1 ? '' : 's'}`;
                  return (
                    <div className="chat-note">
                      In Trash{when}. <a onClick={() => restoreMut.mutate(selected.id)}>Restore</a>
                      {' · '}
                      <a onClick={() => confirmPurge(selected.id)}>Delete permanently</a>
                    </div>
                  );
                })()}
              {selected && !selectedDeleted && TERMINAL.includes(selected.status) && (
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
        {/* Image previews sit above the worktree status bar so a staged screenshot reads
            as part of the message you're about to send, not buried under the diff chip. */}
        {images.length > 0 && (
          <div className="composer-attachments">
            {images.map((im) =>
              im.previewUrl ? (
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
              ) : (
                <span key={im.uid} className="composer-pill composer-file">
                  {im.status === 'uploading' ? (
                    <LoadingOutlined spin className="composer-file-icon" />
                  ) : (
                    <PaperClipOutlined className="composer-file-icon" />
                  )}
                  <span className="composer-file-name" title={im.file.name}>
                    {im.file.name}
                  </span>
                  <span className="composer-file-size">{fmtBytes(im.file.size)}</span>
                  <button
                    type="button"
                    className="composer-file-remove"
                    onClick={() => removeImage(im.uid)}
                    aria-label="Remove file"
                  >
                    <CloseOutlined />
                  </button>
                </span>
              ),
            )}
          </div>
        )}
        <SessionOutputs
          // Only the open session has a worktree to show. With nothing selected (new-session
          // draft, empty list) `keepPreviousData` still holds the previously-open session's
          // detail, which would render its stale branch/diff bar over a fresh draft — so gate
          // on selectedId rather than the placeholder-backed query data.
          detail={selectedId && !selectedDeleted && !selectedMissing ? detailForSelected : null}
          committed={!live}
          // A turn in flight (live but not awaiting input) leaves the branch in a transient
          // state — hold "Merge to main" until it finishes so we never merge half-done work.
          turnActive={live && !idle}
          enabling={enableIsoMut.isPending}
          onEnableIsolation={
            detailForSelected?.agent?.id
              ? () => askEnableIsolation(detailForSelected.agent!.id)
              : undefined
          }
          merging={mergeMut.isPending}
          onMergeToMain={
            selectedId && detailForSelected?.branch
              ? (target?: string) => mergeMut.mutate({ id: selectedId, target })
              : undefined
          }
          resolving={resolveMut.isPending}
          onResolveInSession={
            selectedId && detailForSelected?.branch
              ? () => resolveMut.mutate({ id: selectedId, branch: detailForSelected.branch! })
              : undefined
          }
          committing={commitMut.isPending}
          onCommit={
            selectedId && detailForSelected?.branch
              ? () => commitMut.mutate(selectedId)
              : undefined
          }
        />
        {/* Background processes the agent launched (Bash run_in_background) — invisible
            otherwise. Derived from this session's events; hidden when there are none. */}
        {selectedId && !selectedDeleted && (
          <BackgroundShellsTray events={events} live={live} serverShells={serverBgShells} />
        )}
        {replyTo && (
          <div className="composer-replyto">
            <span className="composer-replyto-icon">↩</span>
            <span className="composer-replyto-text">
              Replying to Claude’s question{replyTo.question ? `: ${replyTo.question}` : ''}
            </span>
            <button
              type="button"
              className="composer-replyto-cancel"
              onClick={() => setReplyTo(null)}
              aria-label="Cancel reply"
            >
              <CloseOutlined />
            </button>
          </div>
        )}
        <div className="composer-box">
          {/* Drag to set an explicit height (overrides auto-grow); double-click to reset.
              Only shown once the box has hit its auto-grow cap or the user set a manual
              height — an empty/short composer has nothing worth resizing. */}
          {(composerHeight != null || composerCapped) && (
            <div
              className="composer-resize-handle"
              onMouseDown={startComposerResize}
              onDoubleClick={() => setComposerHeight(null)}
              title="Drag to resize · double-click to reset"
            />
          )}
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
                  {it.agentId && <span className="composer-slash-type">project</span>}
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
          {/* Hidden picker for the `Upload file` menu item — any type (the runner routes by
              MIME: images/PDFs inline, everything else into the worktree). Same upload path. */}
          <input
            ref={fileInputRef}
            type="file"
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
            disabled={composerDisabled}
            menu={{
              items: [
                {
                  key: 'command',
                  icon: <CodeOutlined />,
                  label: 'Command',
                  disabled: (runner.commands?.length ?? 0) === 0,
                  onClick: () => insertSlash('command'),
                },
                {
                  key: 'skill',
                  icon: <ThunderboltOutlined />,
                  label: 'Skill',
                  disabled: (runner.skills?.length ?? 0) === 0,
                  onClick: () => insertSlash('skill'),
                },
                {
                  key: 'shell',
                  icon: <ConsoleSqlOutlined />,
                  // Works on a live session, a brand-new draft (sent as the first turn), and
                  // an ended-but-resumable session (sent as the revive turn — the runner
                  // --resumes claude, runs the command, and buffers its output for the next
                  // message). Only an unresumable ended session blocks it (never started, or
                  // its runner is offline) — there's no claude context to wake.
                  label: !!selected && !live && !resumable ? 'Shell (resume the session first)' : 'Shell',
                  disabled: !!selected && !live && !resumable,
                  onClick: insertShell,
                },
                {
                  key: 'image',
                  icon: <PictureOutlined />,
                  label: canAttach ? 'Attach image' : 'Attach image (needs a started session)',
                  disabled: !canAttach,
                  onClick: () => imageInputRef.current?.click(),
                },
                {
                  key: 'file',
                  icon: <PaperClipOutlined />,
                  label: canAttach ? 'Upload file' : 'Upload file (needs a started session)',
                  disabled: !canAttach,
                  onClick: () => fileInputRef.current?.click(),
                },
              ],
            }}
          >
            <Button
              className="composer-attach-btn"
              type="text"
              icon={<PlusOutlined />}
              disabled={composerDisabled}
              aria-label="Add attachment"
            />
          </Dropdown>
          <Input.TextArea
            ref={taRef}
            variant="borderless"
            // Auto-grow up to 12 rows, then scroll — unless the user has dragged the handle to
            // a fixed height, which takes over (autoSize off + explicit height).
            autoSize={composerHeight == null ? { minRows: 1, maxRows: 12 } : false}
            style={composerHeight == null ? undefined : { height: composerHeight }}
            // Hard-cap input length: an oversized prompt freezes the composer (autoSize
            // remeasures the whole value on every keystroke) and the transcript. Pasting past
            // the cap truncates; very large content should go through Upload file instead.
            maxLength={MAX_PROMPT_CHARS}
            placeholder={composerPlaceholder}
            value={text}
            disabled={composerDisabled}
            // Typing exits history recall: the next Up starts fresh from this draft.
            onChange={(e) => {
              setText(e.target.value);
              if (histIdx !== -1) setHistIdx(-1);
            }}
            // Paste a file straight from the clipboard — a screenshot, or a file copied in the
            // OS file manager (best-effort: only where the browser exposes it as a clipboard
            // file). Only swallow the paste when it carries files, so pasting text is untouched.
            onPaste={(e) => {
              if (!canAttach) return;
              const files = Array.from(e.clipboardData?.items ?? [])
                .filter((it) => it.kind === 'file')
                .map((it) => it.getAsFile())
                .filter((f): f is File => !!f);
              if (files.length) {
                e.preventDefault();
                files.forEach((f) => void addImage(f));
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
            <Tooltip title="Agent" open={hoverTipOpen}>
              <span className="composer-pill composer-pill-agent">
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
          <Tooltip title={configHint || 'Permission mode'} open={hoverTipOpen}>
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
                  label: m === 'Auto' && !autoOk ? 'Auto (needs Fable 5, Opus 4.8, or Sonnet 5)' : m,
                  disabled: m === 'Auto' && !autoOk,
                }))}
                disabled={!configEditable}
                popupMatchSelectWidth={false}
              />
            </span>
          </Tooltip>
          <span className="composer-pill-spacer" />
          {agentReadOnly && shownAgentName && (
            <Tooltip title="Agent" open={hoverTipOpen}>
              <span className="composer-pill composer-pill-static composer-pill-agent">
                <span className="composer-pill-static-label">{shownAgentName}</span>
              </span>
            </Tooltip>
          )}
          <Tooltip title={configHint || 'Model'} open={hoverTipOpen}>
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
                options={modelOptionsForProvider(shownProvider, runner.modelCatalog, configuredProviders)}
                disabled={!configEditable}
                popupMatchSelectWidth={false}
              />
            </span>
          </Tooltip>
          <Tooltip title={configHint || 'Reasoning effort'} open={hoverTipOpen}>
            <span className="composer-pill">
              <Select
                size="small"
                variant="borderless"
                suffixIcon={null}
                value={shownEffort}
                onChange={(v) => {
                  const normalized = normalizeEffortForProvider(shownProvider, v);
                  // Remember as the account default (replaces localStorage) so the next new
                  // session — here or on iOS/macOS — starts at this effort. Optimistically patch
                  // the cached `me` so the seed effect sees it, then persist best-effort.
                  qc.setQueryData<Me>(meQuery().queryKey, (prev) =>
                    prev ? { ...prev, preferences: { ...prev.preferences, defaultEffort: normalized } } : prev,
                  );
                  void api('/users/me/preferences', {
                    method: 'PATCH',
                    body: { defaultEffort: normalized },
                  }).catch(() => {});
                  if (live) configMut.mutate({ effort: normalized });
                  else setEffort(normalized);
                }}
                options={shownEffortOptions}
                disabled={!configEditable}
                popupMatchSelectWidth={false}
              />
            </span>
          </Tooltip>
          {shownPlanUsage && <PlanUsageIndicator usage={shownPlanUsage} />}
          {/* Context stays visible even before the first turn reports tokens — a New Session reads
              0%. Rightmost pill, to the right of plan usage. */}
          <ContextWindowIndicator tokens={contextTokens} model={shownModel} modelCatalog={runner.modelCatalog} configured={configuredProviders} />
        </div>
      </div>
      </div>
    </div>
  );
}
