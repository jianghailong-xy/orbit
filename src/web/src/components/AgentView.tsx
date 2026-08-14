import {
  ArrowDownOutlined,
  ArrowLeftOutlined,
  ArrowUpOutlined,
  BorderOutlined,
  CheckCircleFilled,
  CheckCircleOutlined,
  CheckOutlined,
  ClockCircleOutlined,
  CloseCircleFilled,
  CloseOutlined,
  CodeOutlined,
  ConsoleSqlOutlined,
  DeleteOutlined,
  DisconnectOutlined,
  DownOutlined,
  EyeOutlined,
  InfoCircleOutlined,
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
  SearchOutlined,
  ShareAltOutlined,
  ThunderboltOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Dropdown, Image, Input, type MenuProps, Popover, Select, Spin, Tooltip } from 'antd';
import {
  type DragEvent as ReactDragEvent,
  Fragment,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
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
import {
  agentsQuery,
  type Me,
  meQuery,
  providersQuery,
  SESSION_PAGE_SIZE,
  sessionQuery,
  type SessionListView,
  sessionsQuery,
  sessionTagsQuery,
} from '../lib/queries';
import { SEARCH_HINT, openSessionSearch } from './SessionSearch';
import {
  type SessionTagRef,
  sessionTagSections,
  sessionTimeSections,
  sessionsWithTag,
} from '../lib/sessionGrouping';
import {
  type ConfiguredProvider,
  clampPermissionModeForModel,
  contextWindowFor,
  DEFAULT_MODEL,
  defaultModelForProvider,
  effectiveSessionEffort,
  effectiveSessionModel,
  effortOptionsForProvider,
  livePinnedModel,
  modelOptionsForProvider,
  normalizeEffortForProvider,
  providerIdentityResolved,
  supportsAuto,
} from '../lib/agentDefaults';
import {
  LOCAL_SLASH_ITEMS,
  isLocalSlashCommand,
  localStatusRows,
  openSlash,
  pickSlash as replaceSlashToken,
  slashAssetMatchesProvider,
  slashCommandName,
  slashMatches as getSlashMatches,
  slashToken as getSlashToken,
  supportsRunnerSlashAssets,
  type ComposerSlashItem,
  type LocalStatusRow,
} from '../lib/slashCommands';
import { sessionPlanUsage } from '../lib/planUsage';
import {
  decideContextSeed,
  dirtyContextSeed,
  type ContextSeedState,
} from '../lib/contextSeed';
import { SessionOutputs } from './SessionOutputs';
import { NewSessionProviderHero } from './NewSessionProviderHero';
import {
  currentProviderChoice,
  providerChoices,
  sameRuntimeChoices,
} from '../lib/sessionProviderChoices';
import { BackgroundShellsTray } from './BackgroundShellsTray';
import type { BgShell } from '../lib/backgroundShells';
import {
  api,
  ApiError,
  type ApprovalInfo,
  armAutoRetry,
  completeSession,
  cancelAutoRetry,
  cancelQueuedTurn,
  adoptSessionBranch,
  commitSession,
  createInteractiveSession,
  decideApproval,
  deleteSession,
  cleanUpAgentRepo,
  enableAgentIsolation,
  getBackgroundShells,
  getSession,
  interruptSession,
  listApprovals,
  listQueuedTurns,
  mergeSessionToMain,
  type PermissionRule,
  pinSession,
  purgeSession,
  getSessionEventFull,
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
import { AttachmentImage, AuthErrorCtx, type AuthErrorHelp, AutoRetryCtx, type AutoRetryHelp, ChatImage, EventFullCtx, MD, SessionNavCtx, StreamingMessage, Transcript, type TurnImage } from './Transcript';
import { ApprovalPanel } from './ApprovalPanel';
import { FIND_HINT, openSessionFind, SessionFind } from './SessionFind';
import { ShareModal } from './ShareModal';
import type { Runner } from './TasksSidePanel';
import type { PlanUsageSnapshot } from '@orbit/shared';
import {
  AgentProvider,
  derivePermissionSemantics,
  lastUserMessageText,
  MAX_PROMPT_CHARS,
  TRASH_RETENTION_DAYS,
} from '@orbit/shared';
import { planUsageRows } from '../lib/planUsage';
import { useToast } from '../lib/toast';
import { setSessionTags } from '../lib/sessionTags';
import {
  isSessionLive,
  isSessionTerminal,
  sessionEndedBanner,
  sessionLifecycleLabel,
  sessionLifecycleStateOf,
  sessionRunStateOf,
  sessionRunStatusOf,
} from '../lib/sessionState';
import { isSessionTurnActive, outlivingSessionWork } from '../lib/sessionActivity';
import type { OutlivingWork } from '../lib/sessionActivity';
import { shouldPollSessionDetail } from '../lib/sessionDetailPolling';
import { firstPaintSlice, transcriptPlaceholder } from '../lib/transcriptPaint';
import { loadTranscript, saveTranscript } from '../lib/transcriptStore';
import {
  isCompleteShortcutEligible,
  scopedAttachmentCreateBlockedMessage,
  sessionCapabilityOf,
  sessionResumeBlockedMessage,
  sessionResumeBlockedReasonOf,
  sessionSendBlockedMessage,
  sessionSendDispositionOf,
} from '../lib/sessionCapabilities';
import {
  PENDING_SLOT_LABEL,
  PENDING_SLOT_TITLE,
  type QueuedGate,
  pendingSlotDescription,
  runnerSlotUsage,
} from '../lib/runnerSlots';

interface RunEvent {
  seq: number;
  type: string;
  payload: any;
  turnId?: string | null;
  ts?: string;
}

// A user message accepted while a turn is running: it sits in the inbox (PENDING)
// until the current turn finishes. Tracked locally so the composer can show it and
// offer to withdraw it before the runner picks it up. A `!cmd` shell turn queues the
// same way, so it gets a bubble too — rendered as the command it will run.
interface QueuedTurn {
  turnId: string;
  content: string;
  shell?: boolean;
  // Server-side image refs (id + mime), so a reopened/reloaded queue can still render an
  // image-only follow-up turn — the local turnImages previews don't survive a reload.
  attachments?: { id: string; mimeType: string }[];
}

interface LocalStatusCard {
  id: string;
  rows: LocalStatusRow[];
}

interface SessionToastTarget {
  id: string;
  title: string;
}

type PendingSessionOperation =
  | (SessionToastTarget & { token: number; kind: 'merge'; target?: string })
  | (SessionToastTarget & { token: number; kind: 'commit' });

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
const fmtReset = (d?: string): string =>
  d ? new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

// 94_000 → "94k", 1_000_000 → "1M". Compact token count for the context gauge.
const fmtTokens = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : `${n}`;

// The latest usable context-window occupancy (tokens). New runners report it on
// `turn_end`; a lightweight status event can also refresh the gauge without ending the
// active turn. Older runners omit the field; keep scanning so a later missing value
// does not blank a known reading. Derived from `events` — which holds the boot tail
// page (so it's right on cold open) plus live appends — rather than a separate live signal.
// The window that reading is a fraction of, taken from the same event rather than looked up: the
// runner reports both halves together (see the runner's model_window.go), because a denominator
// resolved separately can describe a different model than the numerator it lands under — a
// mid-session model switch, or a table that never knew this CLI's answer. Older runners send no
// window; the caller then falls back to contextWindowFor.
function lastContextReading(events: RunEvent[]): { tokens: number; window?: number } {
  for (let i = events.length - 1; i >= 0; i--) {
    const payload = events[i].payload as { contextTokens?: unknown; contextWindow?: unknown } | undefined;
    const ct = payload?.contextTokens;
    if (typeof ct !== 'number' || ct <= 0) continue;
    const cw = payload?.contextWindow;
    return { tokens: ct, window: typeof cw === 'number' && cw > 0 ? cw : undefined };
  }
  return { tokens: 0 };
}

// Donut gauge for the context pill — a distinct silhouette from the linear plan-usage bar so the
// session-local context metric doesn't read as "another usage bar". Brand blue until it
// fills, then ramps amber (≥75%) → red (≥90%) as the window fills.
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
  reportedWindow,
  model,
  provider,
  modelCatalog,
  configured,
}: {
  tokens: number;
  /** The window this session reported alongside its tokens, when it did. */
  reportedWindow?: number;
  model: string;
  provider?: string;
  modelCatalog?: Runner['modelCatalog'];
  configured?: ConfiguredProvider[];
}) {
  const windowTokens = reportedWindow ?? contextWindowFor(model, modelCatalog, configured, provider);
  // Two things can be missing, and they are not the same thing. Occupancy is missing until the
  // engine reports it — a fresh session, or a first turn still running; "0%" would claim the
  // window is empty when it is in fact filling. The window can be missing too, and then there is
  // no percentage to show at all: the tokens are still a fact worth displaying, but dividing them
  // by a guess is how this gauge spent a release reading 83% when it should have read 17%.
  const known = tokens > 0;
  const sized = (windowTokens ?? 0) > 0;
  const pct = known && sized ? Math.min(100, Math.round((tokens / windowTokens!) * 100)) : 0;
  const headline = !known ? '—' : sized ? `${pct}%` : fmtTokens(tokens);
  const pop = (
    <div className="cu-pop">
      <div className="cu-row">
        <div className="cu-head">
          <span className="cu-label">Context window</span>
          <span className="cu-pct">{headline}</span>
        </div>
        {sized && (
          <div className={`runner-util ${pct >= 90 ? 'full' : ''}`}>
            <span className="runner-util-fill" style={{ width: `${pct}%` }} />
          </div>
        )}
        <div className="cu-reset">
          {!known
            ? sized
              ? `Not reported yet · ${fmtTokens(windowTokens!)} window`
              : 'Not reported yet'
            : sized
              ? `${fmtTokens(tokens)} / ${fmtTokens(windowTokens!)} tokens`
              : `${fmtTokens(tokens)} tokens · window not reported`}
        </div>
      </div>
    </div>
  );
  const tier = pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : 'neutral';
  return (
    <Popover content={pop} title="Context" placement="topRight" trigger={['hover', 'click']}>
      <span
        className="composer-pill composer-usage"
        aria-label={
          !known
            ? 'Context window not reported yet'
            : sized
              ? `Context window ${pct}%`
              : `Context ${fmtTokens(tokens)} tokens, window not reported`
        }
      >
        <ContextRing pct={pct} tier={tier} />
        <span className="composer-usage-pct">{headline}</span>
      </span>
    </Popover>
  );
}

// Compact plan-usage indicator for the composer footer (right of the effort pill).
// The pill shows the binding/primary window; hover reveals every reported window.
function PlanUsageIndicator({ usage }: { usage: PlanUsageSnapshot }) {
  const rows = planUsageRows(usage);
  if (rows.length === 0) return null;
  const primary = rows[0];
  const pop = (
    <div className="cu-pop">
      {rows.map(({ key, label, groupLabel, window, percent, nearLimit }) => {
        return (
          <div className="cu-row" key={key}>
            {groupLabel && <div className="cu-label">{groupLabel}</div>}
            <div className="cu-head">
              <span className="cu-label">{label}</span>
              <span className="cu-pct">{percent}%</span>
            </div>
            <div className={`runner-util ${nearLimit ? 'full' : ''}`}>
              <span className="runner-util-fill" style={{ width: `${percent}%` }} />
            </div>
            {window.resetsAt && (
              <div className="cu-reset">Resets {fmtReset(window.resetsAt)}</div>
            )}
          </div>
        );
      })}
    </div>
  );
  return (
    <Popover content={pop} title="Plan usage" placement="topRight" trigger={['hover', 'click']}>
      <span
        className={`composer-pill composer-usage ${primary.nearLimit ? 'full' : ''}`}
        aria-label={`Plan usage ${primary.percent}%`}
      >
        <span className="composer-usage-bar">
          <span className="composer-usage-fill" style={{ width: `${primary.percent}%` }} />
        </span>
        <span className="composer-usage-pct">{primary.percent}%</span>
      </span>
    </Popover>
  );
}

// The slices of the session list, in menu order. Open is the overwhelmingly common
// one, so the other two live in the header's scope menu rather than a permanent tab row.
type SessionView = SessionListView;
const SESSION_VIEWS: { value: SessionView; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'completed', label: 'Completed' },
  { value: 'trash', label: 'Trash' },
];

// How close to the end of the loaded session list the scroll has to get before the next
// page is asked for — roughly a couple of rows, so the list is already widened by the time
// the user reaches the bottom.
const SESSION_LOAD_MORE_PX = 240;

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
// How long a cached /background scan stays fresh. `/background` scans the session's whole
// tool-event history, so re-opening a session (or scrubbing the list) within this window paints
// the cached shells instead of re-running that scan — see bgCacheRef.
const BG_TTL_MS = 30_000;

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

// Whether to draw this session as working. RUNNING is the dispatched case. The second one is a
// turn the runtime started for itself — a background task reporting in, a scheduled wake-up —
// which never reaches /turn-complete and so stays parked at AWAITING_INPUT for its whole
// duration, streaming tools and replies the whole time. Server-tracked
// (Session.engineTurnActive), since only the event stream can see it; absent when talking to an
// older control plane, which simply keeps the old parked reading. Both cases get the same glyph,
// header word and list line — without this the row says "Waiting for your reply" over a session
// the user can watch working. Outranks parkedWorkLabel below: this is the agent itself
// generating, not something it left running behind a finished turn.
const isGenerating = (s: any, state: string): boolean =>
  state === 'RUNNING' || (state === 'AWAITING_INPUT' && s.engineTurnActive === true);

// Live background work that outlives a parked (AWAITING_INPUT) turn — an async sub-agent
// (Task/Agent) and/or background shells. Returns the label to surface (sub-agent wins) with
// the kind behind it, or null when the session is genuinely idle. Shared by the list line,
// status glyph and header so all three agree a parked-but-still-working session isn't
// "waiting for your reply" — and agree on how emphatically to say so: a sub-agent is the
// agent still working, while a background shell is usually a dev server or watcher the agent
// deliberately left up, which keeps reporting for the rest of the session's life.
type ParkedWork = { text: string; kind: OutlivingWork };
const parkedWorkLabel = (s: any): ParkedWork | null => {
  const kind = outlivingSessionWork(s);
  if (!kind) return null;
  return kind === 'subagent'
    ? { text: subagentRunningLabel(s.runningSubagentCount), kind }
    : { text: bgRunningLabel(s.runningBgCount), kind };
};

// The line shown under a session title. For a LIVE (openable) session that's working we
// surface its current state — the tool in flight, that it's blocked on you, or a bare
// "Running…" — so the row never collapses to just a title with no sign of progress.
// Otherwise it's the flattened last reply, falling back to the run's own state word.
// `tone` drives the colour: blue = working, amber = needs you, grey = queued or a
// left-up background process, default = reply content.
type SessionLine = {
  text: string;
  tone: 'preview' | 'running' | 'approval' | 'queued' | 'background';
};
export const sessionLine = (s: any, live: boolean): SessionLine => {
  const state = sessionRunStateOf(s);
  if (live && isGenerating(s, state)) {
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
  if (live && state === 'QUEUED') return { text: PENDING_SLOT_LABEL, tone: 'queued' };
  // Parked (AWAITING_INPUT) but still doing background work — a sub-agent and/or background
  // shells that outlive the turn — so it doesn't read as idle. A spawned sub-agent parks the
  // parent at AWAITING_INPUT while it runs, so this (not the RUNNING branch) is what usually
  // surfaces "Running Agent…".
  const parked = live ? parkedWorkLabel(s) : null;
  if (parked)
    return { text: `${parked.text}…`, tone: parked.kind === 'subagent' ? 'running' : 'background' };
  // A message that never got an answer — the turn was interrupted, or failed, before any reply
  // or tool landed — outranks the previous turn's reply: it's the newer of the two, and it's what
  // the session is left waiting on. The server only keeps lastUserText while it stands unanswered.
  if (s.lastUserText) return { text: plainPreview(s.lastUserText), tone: 'preview' };
  if (s.lastAssistantText) return { text: plainPreview(s.lastAssistantText), tone: 'preview' };
  // Nothing to preview at all (a run that died before even its user turn was recorded, or an older
  // row from before the server kept the pending message): say what happened rather than nothing.
  return { text: statusLabel(s), tone: 'preview' };
};

// State word for the session header — mirrors StatusIcon's branching (and its tooltip
// wording) so the glyph and the header label always agree.
export function statusLabel(session: any): string {
  const state = sessionRunStateOf(session);
  if (state === 'SUCCEEDED') return 'Succeeded';
  if (isGenerating(session, state))
    return (session.pendingApprovals ?? 0) > 0 ? 'Waiting for approval' : 'Running';
  if (state === 'AWAITING_INPUT') return parkedWorkLabel(session)?.text ?? 'Waiting for your reply';
  if (state === 'FAILED') {
    const err: string = typeof session.error === 'string' ? session.error : '';
    return err.toLowerCase().includes('offline') ? 'Disconnected' : 'Failed';
  }
  if (state === 'INTERRUPTED') return 'Interrupted';
  if (state === 'ENDED') return 'Ended';
  return PENDING_SLOT_LABEL; // PENDING
}
// One glyph per session state. Colour carries the meaning: blue = working,
// amber = needs a human decision, green = the run reported success, red = real failure,
// grey = neutral terminal (ended / interrupted / disconnected). A runner that
// went offline is reaped to FAILED with error 'runner offline'; that's a dropped
// connection, not a crash, so it gets the neutral disconnect glyph, not a red X.
// New payloads carry the authoritative runState. The resolver retains a centralized fallback
// for old servers whose raw status collapses graceful ends to CANCELLED.
export function StatusIcon({ session }: { session: any }) {
  const state = sessionRunStateOf(session);
  const fontSize = 16;
  if (state === 'SUCCEEDED')
    return (
      <Tooltip title="Succeeded">
        <CheckCircleFilled style={{ color: 'var(--success-solid)', fontSize }} />
      </Tooltip>
    );
  if (isGenerating(session, state)) {
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
  if (state === 'AWAITING_INPUT') {
    const work = parkedWorkLabel(session);
    // A sub-agent is the agent itself still working, so it keeps the working spinner. A
    // background shell isn't: agents routinely leave a dev server or watcher up, and it never
    // exits, so spinning at it would mark the session busy for the rest of its life and drown
    // out the sessions that really are working. It gets a static, muted terminal-prompt glyph
    // (the native port's SF `terminal`) and keeps its label.
    if (work)
      return (
        <Tooltip title={work.text}>
          {work.kind === 'subagent' ? (
            <LoadingOutlined spin style={{ color: 'var(--brand)', fontSize }} />
          ) : (
            <CodeOutlined style={{ color: 'var(--text-3)', fontSize }} />
          )}
        </Tooltip>
      );
    return (
      <Tooltip title="Waiting for your reply">
        <MessageOutlined style={{ color: 'var(--text-3)', fontSize }} />
      </Tooltip>
    );
  }
  if (state === 'FAILED') {
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
  if (state === 'INTERRUPTED')
    return (
      <Tooltip title="Interrupted">
        <MinusCircleOutlined style={{ color: 'var(--text-3)', fontSize }} />
      </Tooltip>
    );
  // Every deliberate end — filed, ended, stopped, task-driven — draws the same neutral check.
  // Grey rather than green because the run reported no verdict of its own, and one glyph
  // rather than three because resume eligibility never depended on which act ended it.
  if (state === 'ENDED')
    return (
      <Tooltip title="Ended">
        <CheckCircleOutlined style={{ color: 'var(--text-3)', fontSize }} />
      </Tooltip>
    );
  // PENDING — waiting for an active turn slot
  return (
    <Tooltip title={PENDING_SLOT_TITLE}>
      <ClockCircleOutlined style={{ color: 'var(--scrollbar-hover)', fontSize }} />
    </Tooltip>
  );
}

function SessionStatusCard({ card }: { card: LocalStatusCard }) {
  return (
    <div className="chat-status-card" role="status" aria-label="Session status">
      <div className="chat-status-head">
        <span className="chat-status-icon" aria-hidden="true">
          <InfoCircleOutlined />
        </span>
        <span>Status</span>
      </div>
      <div className="chat-status-grid">
        {card.rows.map((row) => (
          <div className="chat-status-row" key={row.label}>
            <span className="chat-status-label">{row.label}</span>
            <span className="chat-status-value">{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Placeholder for a session whose transcript hasn't arrived yet. Mirrors the real shapes — a
// right-aligned user bubble, then a full-width assistant block — so the pane reads as a
// conversation loading rather than as an empty one, and settles without a jarring reflow when
// the events land. Static: it is on screen for a few hundred ms, so no measuring or randomness.
function TranscriptSkeleton() {
  return (
    <div className="chat-skeleton" aria-busy="true" aria-label="Loading conversation">
      {[0, 1].map((i) => (
        <div key={i}>
          <div className="chat-skeleton-user">
            <span className="chat-skeleton-line" style={{ width: '58%' }} />
          </div>
          <div className="chat-skeleton-assistant">
            <span className="chat-skeleton-line" style={{ width: '92%' }} />
            <span className="chat-skeleton-line" style={{ width: '97%' }} />
            <span className="chat-skeleton-line" style={{ width: '74%' }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// Remembers the session the user last had open per agent (agent id → session id). Switching
// away to another agent and back reopens that conversation instead of the agent's most-recent
// one. In-memory only (a full reload deep-links via the URL) and at module scope so it survives
// AgentView remounts across runner switches.
const lastSessionByAgent = new Map<string, string>();

export function AgentView({ runner }: { runner: Runner }) {
  const { modal } = AntApp.useApp();
  const message = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  // Merge and Commit finish asynchronously on a runner heartbeat. Keep accepted operations by
  // session id so their result continues polling even if the user opens another conversation.
  const pendingOperationSeq = useRef(0);
  const [pendingSessionOperations, setPendingSessionOperations] = useState<
    Record<string, PendingSessionOperation>
  >({});
  // The signed-in user, for the account-synced default effort (seeds a new session's Effort
  // pill; written on change below). Cached/deduped with the nav footer's `me`.
  const me = useQuery(meQuery());
  // Configured providers (custom slugs borrowing a built-in runtime) merged into the composer's
  // model list + context-window sizing when the open session/agent uses one. Cached/deduped
  // app-wide by React Query; empty until it loads (then the model pill's options fill in).
  const configuredProvidersQuery = useQuery(providersQuery());
  const configuredProviders = configuredProvidersQuery.data ?? [];
  const configuredProvidersLoaded = configuredProvidersQuery.data !== undefined;
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
  const [mode, setMode] = useState('Auto');
  const [model, setModel] = useState(DEFAULT_MODEL);
  // Runtime catalogs and configured providers arrive asynchronously. Track whether the user has
  // touched Model within the current draft/session context so a late default can fill an untouched
  // picker without overwriting an explicit choice. Context changes deliberately reset dirty.
  const modelSeedState = useRef<ContextSeedState>({
    contextKey: '',
    dirty: false,
  });
  const modeSeedState = useRef<ContextSeedState>({
    contextKey: '',
    dirty: false,
  });
  // Seeded from the account default by the effect below once `me` loads (mirrors how Model/Mode
  // seed via effects); '' = model default until then.
  const [effort, setEffort] = useState('');
  // Which product lifecycle slice of the session list to show.
  const [view, setView] = useState<SessionView>('open');
  // Optional narrowing/sectioning of the list by tag, mirroring the iOS drawer's filter menu.
  // Both are view-local UI state (not persisted) — the same as the native list.
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [groupByTag, setGroupByTag] = useState(false);
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
  // Controlled because the multi-select tag items stay open after a choice; ordinary actions
  // close it explicitly (Ant Dropdown otherwise keeps every item open in multiple-select mode).
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  // React Query publishes isPending through a batched render; this synchronous lock closes the
  // small window where a second full-selection PUT could otherwise start before items disable.
  const tagSaveInFlight = useRef(false);
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
  const [localStatusCards, setLocalStatusCards] = useState<LocalStatusCard[]>([]);
  // The apiserver's authoritative background-shell list (all launches + output recovered from the
  // agent's Read polls). The loaded event window only holds recent launches, so the tray merges
  // this complete set with its live-derived overlay — see BackgroundShellsTray.
  const [serverBgShells, setServerBgShells] = useState<BgShell[]>([]);
  // Per-session cache of the server /background scan. The tray is cleared to [] on every switch, so
  // the throttle in the SSE effect repopulates from here (not just skips) when it's still fresh.
  const bgCacheRef = useRef<Map<string, { at: number; shells: BgShell[] }>>(new Map());
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
  // The in-flight page request, if any: it both guards against a second one and lets a caller
  // that needs to know when older content has landed (⌘F's "search earlier") await the one
  // already running instead of being told "no".
  const loadingOlderRef = useRef<Promise<boolean> | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // True from the moment a session with no cached transcript is selected until its tail page
  // lands (or gives up). Drives the skeleton: without it an unvisited session paints a blank
  // pane for the whole fetch, since an ended session matches none of the empty-state notes.
  const [seeding, setSeeding] = useState(false);
  // Set by loadOlder just before it prepends a page; a layout effect reads it to compensate
  // scrollTop so the viewport stays put instead of jumping when older content grows above.
  const prependAnchorRef = useRef<{ prevHeight: number; prevTop: number } | null>(null);
  // Re-opens the transcript SSE after a `final` event paused it and the session was
  // resumed in place (set by the SSE effect, called by the liveness watcher below).
  const resumeStreamRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null); // the left session-list column, for arrow-key scrolling

  // How far a row slides to expose its actions. Open shows two chips (pin + ✓),
  // every other tab a single ⋯, so it needs less room.
  const swipeReveal = view === 'open' ? 72 : 44;
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
  // Resolves true when events were actually prepended, so an awaiting caller can tell "there's
  // more history now" from "that was the end of it".
  const loadOlder = useCallback((): Promise<boolean> => {
    if (loadingOlderRef.current) return loadingOlderRef.current;
    if (!selectedId || !hasMoreOlderRef.current) return Promise.resolve(false);
    const before = oldestSeqRef.current;
    if (before == null) return Promise.resolve(false);
    setLoadingOlder(true);
    const inFlight = getSessionEventPage(selectedId, { before, limit: OLDER_PAGE })
      .then((page) => {
        if (selectedIdRef.current !== selectedId) return false; // user switched sessions mid-fetch
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
        return fresh.length > 0;
      })
      .catch(() => false)
      .finally(() => {
        loadingOlderRef.current = null;
        setLoadingOlder(false);
      });
    loadingOlderRef.current = inFlight;
    return inFlight;
  }, [selectedId]);
  // The tail-first window's edges, read through callbacks because they live in refs (kept out of
  // render for cost). ⌘F needs both: whether older events exist, and how far back it has loaded.
  const hasOlderNow = useCallback(() => hasMoreOlderRef.current, []);
  const oldestSeqNow = useCallback(() => oldestSeqRef.current, []);
  // Pull back the untrimmed payload of an event the server clipped to a preview (see
  // MAX_EVENT_PAYLOAD). The transcript calls this when the user expands such a card, so a big
  // Read output or Write body only crosses the network if someone actually opens it.
  const fetchEventFull = useCallback(
    (seq: number) => getSessionEventFull(selectedId ?? '', seq),
    [selectedId],
  );
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
      // Only the bubble's rendered markdown — the bubble also holds attachment thumbnails whose
      // hover mask ("Preview") and file chips are in the DOM regardless of visibility, and a raw
      // textContent would splice those labels in front of the question.
      setStuck({ seq: cur.getAttribute('data-seq'), text: cur.querySelector('.md')?.textContent || '' });
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

  // The list is scoped by `view`. Keep Completed loaded while one of its transcripts is
  // open; every other open session resolves from Open, where live sessions live.
  const effectiveView = selectedId ? (view === 'completed' ? 'completed' : 'open') : view;
  // The agent whose conversation list this column is. The route names it on /agents/<id>;
  // a /sessions/<id> deep link doesn't, so it's latched from the open session once that
  // resolves (see the effect below) — the query itself is scoped by it, so it can't be
  // derived further down where the list it would depend on is built.
  const [scopeAgentId, setScopeAgentId] = useState<string | null>(lockedAgentId ?? null);
  // How much of the list is loaded. One page on open; scrolling toward the end widens the
  // window (see loadMoreSessions), which re-keys the query to the larger page.
  const [sessionLimit, setSessionLimit] = useState(SESSION_PAGE_SIZE);
  // One factory call drives both the list query and the optimistic-update key below, so
  // they can never drift apart; it's also the exact key the BootGate splash pre-warms.
  const sessionsOpts = sessionsQuery({
    runnerId: runner.id,
    agentId: scopeAgentId,
    view: effectiveView,
    tagId: tagFilter,
    limit: sessionLimit,
  });
  const sessionsKey = sessionsOpts.queryKey;
  // While the control-plane stream is connected it pushes list changes (a coalesced refetch per
  // event), so stop the 4s poll; on any stream gap `controlLive` flips false and it resumes.
  const controlLive = useControlPlaneLive();
  const sessionsQ = useQuery({
    ...sessionsOpts,
    refetchInterval: controlLive ? false : 4000,
    // Widening the window re-keys the query, so hold the rows already on screen while the
    // larger page loads instead of blanking the list. Only within one scope (every key part
    // but the page size): another scope's rows must never stand in for this one's, even for
    // a frame.
    placeholderData: (prev, prevQuery) => {
      const k = prevQuery?.queryKey;
      if (!k || sessionsKey.slice(0, -1).some((part, i) => k[i] !== part)) return undefined;
      return prev;
    },
  });
  // Capabilities include heartbeat-derived runner availability. Refresh both list and detail when
  // this runner crosses online/offline so a cached RUNNER_OFFLINE denial cannot outlive recovery.
  const previousRunnerAvailability = useRef({ id: runner.id, online: runner.online });
  useEffect(() => {
    const previous = previousRunnerAvailability.current;
    previousRunnerAvailability.current = { id: runner.id, online: runner.online };
    if (previous.id !== runner.id || previous.online === runner.online) return;
    qc.invalidateQueries({ queryKey: ['sessions'] });
    if (selectedId) qc.invalidateQueries({ queryKey: ['session', selectedId] });
  }, [runner.id, runner.online, selectedId, qc]);
  // The owner's tag library, for the filter menu and the "Group by Tag" headings.
  const sessionTags = useQuery(sessionTagsQuery()).data ?? [];

  const sessions = useMemo(() => {
    const rows = (sessionsQ.data ?? []).slice();
    // The Completed view is ordered by the server on completed_at (newest first) and
    // intentionally ignores pinning. The optimistic cache edits
    // (drop/rename/pin) only remove or patch rows in place — never reorder — and a real
    // Complete reconciles via refetch, so the server order holds. Trust it verbatim.
    if (effectiveView === 'completed') return rows;
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
    refetchInterval: (q) => {
      const detail = q.state.data;
      if (
        detail?.id === selectedId &&
        (detail.mergeStatus === 'pending' || detail.commitStatus === 'pending')
      )
        return 3000;
      // A deep-linked/Completed ENDING row may already be absent from the Open list. Keep polling
      // its own current detail until terminal instead of relying solely on selectedFromList.
      return shouldPollSessionDetail(selectedId, detail, selectedFromList) ? 5000 : false;
    },
  });
  const detailForSelected = sessionDetailQ.data?.id === selectedId ? sessionDetailQ.data : null;
  const selectedFromDetail = useMemo(() => {
    const d = detailForSelected as any;
    // A freshly-created session primes only id/runner/agent into this cache; keep the
    // existing "Starting..." placeholder until the real detail/list row supplies title/status.
    if (
      !d ||
      typeof d.title !== 'string' ||
      (typeof d.runState !== 'string' &&
        typeof d.sessionState !== 'string' &&
        typeof d.runStatus !== 'string' &&
        typeof d.status !== 'string')
    )
      return null;
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
  // Detail is fresher and carries capabilities that compact list rows may omit. Merge nested
  // capabilities field-by-field so a partial rolling-upgrade payload cannot erase a list value.
  const selectedSession = selected
    ? {
        ...selected,
        ...(detailForSelected ?? {}),
        capabilities:
          selected.capabilities || detailForSelected?.capabilities
            ? { ...selected.capabilities, ...detailForSelected?.capabilities }
            : undefined,
      }
    : null;
  const selectedLifecycleState = selectedSession
    ? sessionLifecycleStateOf(
        selectedSession,
        { listView: selectedFromList ? effectiveView : undefined },
      )
    : null;
  const selectedTrashed = selectedLifecycleState === 'TRASH';
  const selectedCompleted = selectedLifecycleState === 'COMPLETED';
  // Keep an observer on every locally accepted Merge/Commit until its runner reports a terminal
  // result. Unlike the selected-detail-only observer this survives switching conversations, and
  // the operation token prevents a stale query result from finishing a newer retry for the same
  // session. Pre-existing terminal statuses never toast: entries are added only after a click is
  // accepted by the API in the mutations below.
  const pendingOperations = useMemo(
    () => Object.values(pendingSessionOperations),
    [pendingSessionOperations],
  );
  const pendingOperationQueries = useQueries({
    queries: pendingOperations.map((operation) => ({
      ...sessionQuery(operation.id),
      refetchInterval: 3000,
    })),
  });
  const notifiedOperationTokens = useRef(new Set<number>());
  useEffect(() => {
    const finished: PendingSessionOperation[] = [];
    pendingOperations.forEach((operation, index) => {
      const query = pendingOperationQueries[index];
      // A deleted session has no result left to report. Likewise, a successful detail response
      // whose operation status was cleared means another action (for example Resume) superseded
      // the request. Stop observing both cases instead of polling an orphan forever; transient
      // fetch failures remain tracked and retry normally.
      if (query?.isError && query.error instanceof ApiError && query.error.status === 404) {
        finished.push(operation);
        return;
      }
      const d = query?.data;
      if (!d || d.id !== operation.id || notifiedOperationTokens.current.has(operation.token)) return;
      const status = operation.kind === 'merge' ? d.mergeStatus : d.commitStatus;
      if (!status) {
        if (query.isSuccess && query.fetchStatus === 'idle') finished.push(operation);
        return;
      }
      if (status === 'pending') return;

      notifiedOperationTokens.current.add(operation.token);
      finished.push(operation);
      if (operation.kind === 'merge') {
        const target = d.mergeTarget || operation.target || 'main';
        if (status === 'merged') {
          message.sessionNotice({
            sessionId: operation.id,
            sessionTitle: operation.title,
            event: 'merge-result',
            headline: `Merged into ${target}`,
            tone: 'success',
            icon: 'check',
          });
        } else if (status === 'conflict') {
          message.sessionNotice({
            sessionId: operation.id,
            sessionTitle: operation.title,
            event: 'merge-result',
            headline: `Merge conflict in ${target}`,
            detail: 'Merge aborted; your branch is unchanged. Resolve it from the status bar.',
            tone: 'warning',
          });
        } else {
          message.sessionNotice({
            sessionId: operation.id,
            sessionTitle: operation.title,
            event: 'merge-result',
            headline: `Merge into ${target} failed`,
            detail: d.mergeError ?? 'See the status bar for details.',
            tone: 'error',
          });
        }
      } else if (status === 'committed') {
        message.sessionNotice({
          sessionId: operation.id,
          sessionTitle: operation.title,
          event: 'commit-result',
          headline: 'Changes committed',
          tone: 'success',
          icon: 'check',
        });
      } else if (status === 'nochange') {
        message.sessionNotice({
          sessionId: operation.id,
          sessionTitle: operation.title,
          event: 'commit-result',
          headline: 'No changes to commit',
          tone: 'neutral',
          icon: 'info',
        });
      } else {
        message.sessionNotice({
          sessionId: operation.id,
          sessionTitle: operation.title,
          event: 'commit-result',
          headline: 'Commit failed',
          detail: d.commitError ?? 'See the status bar for details.',
          tone: 'error',
        });
      }
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    });

    if (finished.length === 0) return;
    setPendingSessionOperations((current) => {
      const next = { ...current };
      finished.forEach((operation) => {
        if (next[operation.id]?.token === operation.token) delete next[operation.id];
      });
      return next;
    });
  }, [message, pendingOperationQueries, pendingOperations, qc]);
  const live = !!selectedSession && !selectedTrashed && isSessionLive(selectedSession);
  // On older servers, infer resumability exactly as before. Newer servers know whether runner
  // context still exists and are authoritative — notably preventing a false-positive Resume.
  const legacyResumable =
    !!selectedSession &&
    !selectedTrashed &&
    !live &&
    !!selectedSession.startedAt &&
    !!runner.online;
  const resumable = selectedSession
    ? sessionCapabilityOf(selectedSession, 'canResume', legacyResumable)
    : false;
  const selectedResumeBlockedReason = selectedSession
    ? sessionResumeBlockedReasonOf(selectedSession)
    : null;
  const selectedResumeBlockedCopy = sessionResumeBlockedMessage(selectedResumeBlockedReason);
  // A run can still look live/resumable in cached state while a Complete/end transition has
  // already denied its same-session endpoint. Never reinterpret that denial as a fresh run.
  const sameSessionSendBlocked =
    !!selectedSession &&
    (live || resumable) &&
    !sessionCapabilityOf(selectedSession, 'canSend', true);
  const sameSessionSendBlockedCopy = sessionSendBlockedMessage(selectedResumeBlockedReason);
  const selectedCanComplete = selectedSession
    ? sessionCapabilityOf(selectedSession, 'canComplete', selectedLifecycleState === 'OPEN')
    : false;
  const selectedCanRestore = selectedSession
    ? sessionCapabilityOf(
        selectedSession,
        'canRestore',
        selectedLifecycleState === 'COMPLETED' || selectedLifecycleState === 'TRASH',
      )
    : false;
  // The session list (always visible in the left column) is scoped to one agent so
  // it reads as a conversation with that agent. On /agents/<id> that's the locked
  // agent; on a /sessions/<id> deep link the URL carries no agent, so fall back to
  // the selected session's own agent. Feeds the query above (hence the state), which is
  // why the client-side filter below stays: it covers the frame before the re-scoped
  // list lands, and the case where no agent resolves at all.
  const resolvedAgentId =
    lockedAgentId ?? selected?.agent?.id ?? detailForSelected?.agent?.id ?? null;
  useEffect(() => setScopeAgentId(resolvedAgentId), [resolvedAgentId]);
  const visibleSessions = useMemo(() => {
    let list = resolvedAgentId ? sessions.filter((s) => s.agent?.id === resolvedAgentId) : sessions;
    // The tag filter is the query's too; re-applying it here keeps arrow-nav, auto-select and
    // "open the next session after completing" stepping through exactly what's on screen even
    // in the frame before a just-changed filter's rows land.
    if (tagFilter) list = sessionsWithTag(list, tagFilter);
    return list;
  }, [sessions, resolvedAgentId, tagFilter]);

  // Paging. The server answered with a full page, so there is probably more behind it; a short
  // answer means this scope is exhausted.
  const hasMoreSessions = (sessionsQ.data?.length ?? 0) >= sessionLimit;
  // The column has nothing to show yet for this scope (a switch to an agent not in cache), or
  // is widening its window — `isPlaceholderData` is exactly that, since the guard above only
  // keeps rows within one scope. Neither is the ordinary background refresh, which must not
  // flash anything over rows that are already correct.
  const loadingSessions = sessionsQ.isPending || sessionsQ.isPlaceholderData;
  const loadMoreSessions = useCallback(() => {
    if (!hasMoreSessions || sessionsQ.isFetching) return;
    setSessionLimit((n) => n + SESSION_PAGE_SIZE);
  }, [hasMoreSessions, sessionsQ.isFetching]);
  // A new scope starts at one page again: a window grown by scrolling deep into one agent's
  // history must not make the next agent (or view, or tag) fetch just as deep.
  useEffect(() => {
    setSessionLimit(SESSION_PAGE_SIZE);
  }, [runner.id, scopeAgentId, effectiveView, tagFilter]);
  // The server pages what the column shows, but a frame where the client narrows further (an
  // agent that hasn't resolved into the query yet) can hold too few visible rows to be
  // scrollable — and without a scroll there is nothing to trigger the next page. Top it up here.
  useEffect(() => {
    if (visibleSessions.length >= SESSION_PAGE_SIZE) return;
    loadMoreSessions();
  }, [visibleSessions.length, loadMoreSessions]);
  // Widen the window as the list nears its end, so scrolling reads as one continuous list.
  const onSessionListScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      if (el.scrollHeight - el.scrollTop - el.clientHeight > SESSION_LOAD_MORE_PX) return;
      loadMoreSessions();
    },
    [loadMoreSessions],
  );

  // The list's sections. Recency by default (Pinned / Today / Yesterday / …), or one section per
  // tag when the user switches grouping — both from the pure groupers shared in shape with
  // OrbitKit's, over the already console-sorted list. Pinning only applies in Open, and
  // a "Pinned" section would fight an active tag filter, so it's suppressed there (as on iOS).
  // Note the Completed view is server-ordered by completed_at while bucketing reads last activity,
  // so its rows are grouped by when they last ran, not by when they moved — same as iOS.
  const sections = useMemo(
    () =>
      groupByTag
        ? sessionTagSections(visibleSessions).map((s) => ({
            key: s.tag?.id ?? '__untagged__',
            tag: s.tag,
            title: s.tag?.name ?? 'Untagged',
            sessions: s.sessions,
          }))
        : sessionTimeSections(visibleSessions, {
            pinnedFirst: view === 'open' && !tagFilter,
          }).map((s) => ({ key: s.title, tag: null as SessionTagRef | null, ...s })),
    [visibleSessions, groupByTag, view, tagFilter],
  );

  // The rows in the order they're actually on screen. Sectioning can reorder relative to the
  // server sort — Completed arrives ordered by completion time but buckets by last activity,
  // and tag grouping regroups outright — so anything that moves the cursor by a row (Up/Down,
  // "open the next one after completing") has to walk this, not the pre-section list.
  const orderedSessions = useMemo(() => sections.flatMap((s) => s.sessions), [sections]);

  // Right-pane mode. A real session (/sessions/<id>) shows its conversation; with
  // none selected we're composing a new session — explicitly (/agents/<id>/new),
  // while browsing Completed/Trash (nothing openable there), or implicitly
  // when the Open list is empty (the first-run empty state).
  const composing =
    !selectedId &&
    (composingRoute || view !== 'open' || (sessionsQ.isSuccess && visibleSessions.length === 0));

  // Remember the open session as this agent's last-viewed one, so returning to the agent
  // (an agent-switch away and back, or clicking it in the sidebar) restores it below.
  useEffect(() => {
    const agentId = selected?.agent?.id;
    if (selectedId && agentId) lastSessionByAgent.set(agentId, selectedId);
  }, [selectedId, selected?.agent?.id]);

  // Default landing: opening /agents/<id> in Open (no session, not the /new draft)
  // opens a session so the right pane is never blank. Prefer the one the user last had open
  // for this agent (remembered above) — reopening where they left off — and fall back to the
  // most recent when there's no memory (or it's since been completed/trashed out of view).
  // replace() keeps it out of history; Completed/Trash never auto-open.
  useEffect(() => {
    // On mobile the list is its own full screen — auto-opening would trap the back
    // button (it returns here, which would immediately redirect into a session again).
    if (isMobile || selectedId || composingRoute || view !== 'open' || !sessionsQ.isSuccess)
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

  // Step the open session up/down the visible list, for the window-level Up/Down handler
  // below. Returns false (a no-op) at the list ends, on an empty list, or on the trash
  // view with nothing open. With nothing selected, Down enters from the top, Up from
  // the bottom.
  const stepSession = useCallback(
    (dir: 1 | -1): boolean => {
      if (!selectedId && view === 'trash') return false;
      if (orderedSessions.length === 0) return false;
      const cur = orderedSessions.findIndex((s) => s.id === selectedId);
      let next: number;
      if (cur === -1) next = dir === 1 ? 0 : orderedSessions.length - 1;
      else {
        next = cur + dir;
        if (next < 0 || next >= orderedSessions.length) return false; // stop at the ends
      }
      navigate(`/sessions/${encodeId(orderedSessions[next].id)}`);
      return true;
    },
    [orderedSessions, selectedId, view, navigate],
  );

  // Up/Down arrows step through the session list (left column), switching the open
  // session like tabs. Skipped while typing in an input/textarea (so the composer and
  // Ant dropdowns keep their own arrows).
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
  // The agent picked for a NEW session. An existing session keeps its owning agent separately.
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

  // The New Session provider pick, scoped to the agent it was made under: switching agents means
  // switching projects, so the previous pick must not follow. Kept as {agentId, provider} rather
  // than reset by an effect so the stale value is never readable for a render.
  const [draftProviderPick, setDraftProviderPick] = useState<{
    agentId?: string;
    provider: string;
  } | null>(null);
  const draftProvider =
    draftProviderPick && draftProviderPick.agentId === agentId ? draftProviderPick.provider : null;
  // The provider a NEW session would run: an explicit pick, else what this project last ran on.
  // `lastProvider` is derived server-side from the agent's most recent interactive session — an
  // agent holds no provider of its own (apiserver agents/agent-provider.ts). `provider` is the
  // deprecated alias of the same derived value, still served for older native builds.
  const pickedProvider: string =
    draftProvider ?? pickedAgent?.lastProvider ?? pickedAgent?.provider ?? 'claude';

  // A provider switch made on an ENDED session, scoped to that session for the same reason the
  // draft pick is scoped to its agent. There is nothing to PATCH while a session is ended, so
  // this rides along with the resume that revives it — the same route Model/Mode/Effort take.
  const [endedProviderPick, setEndedProviderPick] = useState<{
    sessionId: string;
    provider: string;
  } | null>(null);
  // Gated on `live` rather than cleared: once the resume lands the session is live and carries
  // the new provider itself, so the pick simply stops applying — and a later switch through the
  // live pill can't be shadowed by this stale one.
  const pendingResumeProvider =
    selected && !live && endedProviderPick?.sessionId === selected.id
      ? endedProviderPick?.provider
      : null;
  // The provider this composer talks to: a live session's own, an ended session's pending pick,
  // else the one picked for the draft. Declared here (not next to its other consumers) because
  // the `/` autocomplete memo below needs it.
  const shownProvider: string = selected
    ? (pendingResumeProvider ?? selected.provider ?? detailForSelected?.provider ?? 'claude')
    : pickedProvider;
  const shownProviderCapabilitiesResolved = providerIdentityResolved(
    shownProvider,
    configuredProvidersLoaded,
  );
  // Codex has no slash registry: its app-server takes the prompt verbatim (no expansion of
  // `~/.codex/prompts`, nothing in the protocol for it), so `/anything` is plain text there.
  // Claude's commands and skills are meaningless in that session — don't offer them, and
  // don't gate sending on them. `/status` is ours and stays.
  const codexComposer = !supportsRunnerSlashAssets(shownProvider);
  // The selected session's permission mode as the SERVER resolves it: its own stored mode,
  // else the owning agent's, else dontAsk (queue.service.ts buildSession). Reading the session
  // row alone would show "Don't Ask" for every session that never stored one — and since the
  // pills are authoritative on send, resuming one would then WRITE that dontAsk over the
  // agent's real mode. The agent's mode comes from the detail (full agent row) or the agents
  // list, whichever has landed.
  const effectivePermissionMode: string =
    selected?.permissionMode ??
    detailForSelected?.agent?.permissionMode ??
    agentsForRunner.find((a) => a.id === selected?.agent?.id)?.permissionMode ??
    'dontAsk';
  const selectedAgentFromList = agentsForRunner.find((a) => a.id === selected?.agent?.id);
  // Which agent this console is about: the open session's, else the one a new session would use.
  // Its heartbeat-reported checkout drives the "this machine is wedged" notice above the bar.
  const consoleAgentId: string | undefined = selected?.agent?.id ?? agentId;
  const consoleAgentRepoHealth =
    (agentsForRunner.find((a) => a.id === consoleAgentId)?.repoHealth as
      | { root: string; state: string; paths?: string[]; branch?: string }
      | null
      | undefined) ?? null;
  const effectiveSelectedModel = effectiveSessionModel(
    shownProvider,
    selected?.model,
    detailForSelected?.agent?.model ?? selected?.agent?.model ?? selectedAgentFromList?.model,
    runner.modelCatalog,
    configuredProviders,
    runner.runtimeDefaultModels,
  );
  const effectiveSelectedEffort = effectiveSessionEffort(
    selected?.effort,
    detailForSelected?.agent?.effort ?? selected?.agent?.effort ?? selectedAgentFromList?.effort,
  );

  // Same fallback chain as the permission mode above: a session that never stored a model of its
  // own runs the owning agent's model, so the picker must show that — not the provider default.
  // A pin the runtime has retired drops out of the chain (livePinnedModel), so a session left on
  // last generation's model seeds the current default instead of an id that is no longer offered.
  const selectedModelDefault = selected
    ? livePinnedModel(
        selected.model,
        shownProvider,
        runner.modelCatalog,
        configuredProviders,
        runner.runtimeDefaultModels,
      ) ??
      livePinnedModel(
        detailForSelected?.agent?.model ??
          agentsForRunner.find((a) => a.id === selected.agent?.id)?.model,
        shownProvider,
        runner.modelCatalog,
        configuredProviders,
        runner.runtimeDefaultModels,
      ) ??
      defaultModelForProvider(
        shownProvider,
        runner.modelCatalog,
        configuredProviders,
        runner.runtimeDefaultModels,
      )
    : null;

  // Seed Effort from a non-live (resumable) session's stored config. Keying on id + liveness,
  // rather than the polled object, keeps the 4s refetch from clobbering a local edit.
  useEffect(() => {
    if (!selected || live) return;
    const provider = selected.provider ?? detailForSelected?.provider ?? 'claude';
    const owningAgent = agentsForRunner.find((a) => a.id === selected.agent?.id);
    setEffort(
      normalizeEffortForProvider(
        provider,
        selected.effort ?? detailForSelected?.agent?.effort ?? owningAgent?.effort ?? '',
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, live]);

  const pickedModelDefault = pickedAgent
    ? defaultModelForProvider(
        pickedProvider,
        runner.modelCatalog,
        configuredProviders,
        runner.runtimeDefaultModels,
      )
    : null;
  const pickedProviderCapabilitiesResolved = providerIdentityResolved(
    pickedProvider,
    configuredProvidersLoaded,
  );

  // Everything that could run a session on this machine: engines first — with the health this
  // runner reported, since the session runs there — then this account's providers. The New
  // Session hero offers all of it; the composer's Provider pill offers the same-runtime slice.
  const providerChoicesForRunner = useMemo(
    () =>
      providerChoices(
        configuredProviders,
        runner.modelCatalog,
        runner.runtimeDefaultModels,
        runner.engines,
      ),
    [configuredProviders, runner.modelCatalog, runner.runtimeDefaultModels, runner.engines],
  );
  const currentProviderChoiceForDraft = useMemo(
    () =>
      currentProviderChoice(
        pickedProvider,
        providerChoicesForRunner,
        runner.modelCatalog,
        configuredProviders,
        runner.runtimeDefaultModels,
      ),
    [
      pickedProvider,
      providerChoicesForRunner,
      runner.modelCatalog,
      configuredProviders,
      runner.runtimeDefaultModels,
    ],
  );
  // What a switch just changed. Shown under the summary and cleared on a timer: the model move
  // is a silent side effect otherwise, and so is the write-back that remembers the pick.
  const [providerSwitchNote, setProviderSwitchNote] = useState<string | null>(null);
  const providerNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (providerNoteTimer.current) clearTimeout(providerNoteTimer.current); }, []);
  const pickDraftProvider = (slug: string): void => {
    setDraftProviderPick({ agentId, provider: slug });
    const picked = providerChoicesForRunner.find((c) => c.slug === slug);
    // The pick binds this session and nothing else. Later sessions follow it only because the
    // default is read back from what this project last ran — no config is being rewritten.
    setProviderSwitchNote(picked ? `Model → ${picked.modelLabel}` : null);
    if (providerNoteTimer.current) clearTimeout(providerNoteTimer.current);
    providerNoteTimer.current = setTimeout(() => setProviderSwitchNote(null), 4000);
  };

  // The provider is part of the draft's seed context: picking a different one has to re-seed
  // Model (each provider owns its own model space) and re-clamp Mode, which is exactly what a
  // context change does — including resetting `dirty`, so a model chosen for the old provider
  // never carries into the new one's namespace.
  const modelContextKey = selectedId
    ? `session:${selectedId}`
    : `draft:${runner.id}:${agentId ?? 'none'}:${pickedProvider}`;
  const modelSeed = selectedId ? (!live ? selectedModelDefault : null) : pickedModelDefault;

  // A late Runtime catalog/configured-provider response may refine the seed for an untouched
  // picker. Once the user chooses any model, ignore seed changes until the Agent/Session context
  // changes. Dirty is explicit rather than inferred from value equality: choosing the same value
  // is still an intentional choice.
  useEffect(() => {
    const decision = decideContextSeed(modelSeedState.current, modelContextKey, !!modelSeed);
    modelSeedState.current = decision.state;
    if (decision.apply && modelSeed) setModel(modelSeed);
  }, [modelContextKey, modelSeed]);

  // A new session defaults to Auto — the app-level default (DEFAULT_PERMISSION_MODE) — rather
  // than inheriting the picked agent's stored mode, which still governs task-launched runs
  // server-side. Clamp when the effective provider/model can't run Auto, as elsewhere.
  const pickedModeSeed =
    PERMISSION_TO_MODE[
      pickedProviderCapabilitiesResolved
        ? clampPermissionModeForModel(
            'auto',
            pickedModelDefault ?? DEFAULT_MODEL,
            pickedProvider,
            configuredProviders,
          )
        : 'auto'
    ] ?? 'Default';
  const modeSeed = selectedId
    ? !live && selected
      ? PERMISSION_TO_MODE[
          shownProviderCapabilitiesResolved
            ? clampPermissionModeForModel(
                effectivePermissionMode,
                selectedModelDefault ?? DEFAULT_MODEL,
                shownProvider,
                configuredProviders,
              )
            : effectivePermissionMode
        ] ?? 'Default'
      : null
    : pickedModeSeed;

  // Mode follows the same context/dirty invariant as Model. This matters when a configured
  // provider resolves after the draft first renders: Auto may need to clamp to Default for its
  // effective model, but that late result must not replace a Mode the user already picked.
  useEffect(() => {
    const decision = decideContextSeed(modeSeedState.current, modelContextKey, !!modeSeed);
    modeSeedState.current = decision.state;
    if (decision.apply && modeSeed) setMode(modeSeed);
  }, [modelContextKey, modeSeed]);

  // Model and Mode have independent dirty guards. If an untouched model is refined by a late
  // Runtime heartbeat after the user explicitly chose Auto, correctness still wins: never keep
  // an invalid pair merely because Mode is dirty.
  useEffect(() => {
    if (
      !live &&
      shownProviderCapabilitiesResolved &&
      mode === 'Auto' &&
      !supportsAuto(model, shownProvider, configuredProviders)
    ) {
      setMode('Default');
    }
  }, [
    configuredProviders,
    live,
    mode,
    model,
    shownProvider,
    shownProviderCapabilitiesResolved,
  ]);

  // A fresh session seeds its effort with the most specific default available: the picked agent's
  // own effort (set on the Runner page) first, else the account-level default-effort preference
  // (synced across devices — the iOS/macOS clients seed the same fallback). `??` treats only
  // null/undefined as "unset", so an agent explicitly set to Default ('') stays Default rather than
  // falling through. Reacts to `me` loading so the pill fills once preferences arrive.
  useEffect(() => {
    if (selectedId) return;
    const provider = pickedProvider;
    const candidate = pickedAgent?.effort ?? me.data?.preferences?.defaultEffort ?? '';
    // A picked provider owns its own model space, so its default model — not the agent's, which
    // belongs to the provider being switched away from — is what the effort must be legal for.
    const selectedModel = draftProvider
      ? defaultModelForProvider(provider, runner.modelCatalog, configuredProviders)
      : (livePinnedModel(
          pickedAgent?.model,
          provider,
          runner.modelCatalog,
          configuredProviders,
          runner.runtimeDefaultModels,
        ) ?? defaultModelForProvider(provider, runner.modelCatalog, configuredProviders));
    setEffort(normalizeEffortForProvider(provider, candidate, selectedModel, runner.modelCatalog));
  }, [
    selectedId,
    pickedProvider,
    draftProvider,
    pickedAgent?.model,
    pickedAgent?.effort,
    me.data?.preferences?.defaultEffort,
    runner.modelCatalog,
  ]);

  // Slot accounting is turn-based: only RUNNING occupies maxConcurrent. A warm or
  // cold AWAITING_INPUT session remains open for replies without blocking another turn.
  // Slots are a whole-runner budget, and this list holds one agent's page of it, so the
  // runner's own server-side count is the number; the list is only a fallback for a
  // payload that predates it.
  const slotUsage = useMemo(
    () => runnerSlotUsage(sessions, runner.maxConcurrent),
    [sessions, runner.maxConcurrent],
  );
  const activeSlots =
    typeof runner.activeSessions === 'number' ? runner.activeSessions : slotUsage.active;
  // The gate comes from the selected session's own row: only the server can tell whether the
  // runner, this run, or the batch is what is holding it.
  const slotWaitDescription = pendingSlotDescription(
    activeSlots,
    runner.maxConcurrent,
    (selectedSession ?? selected) as QueuedGate | null,
  );
  // What stands in for an empty transcript — exactly one of these, so the loading skeleton can't
  // stack on top of the centered "waiting for a slot" pane. See lib/transcriptPaint.
  const placeholder = transcriptPlaceholder({
    hasSession: !!selected,
    trashed: selectedTrashed,
    runState: selected ? sessionRunStateOf(selectedSession ?? selected) : null,
    live: selected ? isSessionLive(selectedSession ?? selected) : false,
    eventCount: events.length,
    seeding,
    streaming: !!streamingText || !!streamingThink,
  });

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
    setLocalStatusCards([]);
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
    loadingOlderRef.current = null;
    setLoadingOlder(false);
    if (!selectedId) {
      accRef.current = [];
      setEvents([]);
      seen.current = new Set();
      oldestSeqRef.current = null;
      hasMoreOlderRef.current = false;
      setSeeding(false);
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
    setSeeding(cached.length === 0); // nothing to paint yet — show the skeleton, not a blank pane
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
      const snapshot = {
        events: accRef.current,
        oldestSeq: oldestSeqRef.current,
        hasMoreOlder: hasMoreOlderRef.current,
      };
      cache.set(selectedId, snapshot);
      if (cache.size > TRANSCRIPT_CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined && oldest !== selectedId) cache.delete(oldest);
      }
      // Mirror into the persistent L2 so the same transcript survives a reload. Returns at once —
      // this runs on every appended event, and the store batches the actual write into an idle
      // callback rather than opening a transaction per token.
      saveTranscript(selectedId, snapshot);
    };
    const seedAbort = new AbortController();
    // Pending release of the events the first paint held back (see firstPaintSlice).
    let paintRest: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => {
      closed = true;
      if (retry) clearTimeout(retry);
      if (paintRest) clearTimeout(paintRest);
      es?.close();
      // Scrubbing the list fires one tail page per session passed through (they're no longer
      // debounced — see below); aborting the superseded one keeps at most a single seed in
      // flight instead of a burst the user will never look at.
      seedAbort.abort();
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
          // Session finalized (turn-complete failure, idle-recycle, or a user end). Drop
          // the live connection so we don't hold an idle stream — but a gracefully-ended
          // session is resumable IN PLACE (same selectedId, so this effect
          // doesn't re-run), and a resumed turn's events would be published to a stream
          // we'd have permanently closed, leaving the open transcript stale while the
          // polled sidebar advances. So pause instead of closing for good; the liveness
          // watcher re-opens it (replaying the missed seq) once the session is live again.
          paused = true;
          es?.close();
          // However the run ended, no turn is in flight any more. `turn_end` is the
          // only other event that says so, and a run that died before its first one —
          // an engine that failed during session setup, a crash before the first
          // reply — never emits it. Without this the console keeps the turn state of
          // a session that is already terminal: a half-streamed bubble left mid-air,
          // and the next message queued behind a turn that will never end.
          setIdle(true);
          setStreamingText('');
          setStreamingThink('');
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
    // Tail-first seed, fired NOW rather than from the debounced block below: on a cache miss it
    // is the only request whose answer the transcript is waiting on, so making it wait out the
    // debounce — behind a whole-history /background scan, no less — was pure dead time under a
    // blank pane. What the debounce protected against is covered by the abort in stop() instead.
    // Null on a cache hit, where the SSE's replay of the gap after the cached seq is enough. The
    // debounced block awaits this before connect(), so the stream still opens at the seq the
    // page established, however long it took.
    const seed: Promise<void> | null =
      cached.length === 0
        ? (async () => {
            // L2 first: the same transcript, kept in IndexedDB so it outlives the page. A hit skips
            // the tail page entirely — the SSE resumes from the stored max seq and replays only what
            // happened since, exactly as an L1 hit does. A miss (or any error) returns null and falls
            // through to the network below, so this can only save a request, never cost correctness.
            const stored = await loadTranscript(selectedId);
            if (closed) return;
            if (stored && stored.events.length > 0) {
              accRef.current = stored.events;
              for (const e of stored.events) if (isSeq(e.seq)) seen.current.add(e.seq);
              oldestSeqRef.current = stored.oldestSeq;
              hasMoreOlderRef.current = stored.hasMoreOlder;
              lastSeq = stored.events.reduce((m, e) => (isSeq(e.seq) ? Math.max(m, e.seq) : m), lastSeq);
              const { now, deferred } = firstPaintSlice(stored.events);
              setEvents(now);
              setSeeding(false);
              // Into L1 too, so switching away and back in this page load is synchronous again.
              cache.set(selectedId, stored);
              if (deferred) {
                paintRest = setTimeout(() => {
                  if (!closed) setEvents(accRef.current);
                }, 0);
              }
              return;
            }
            // Retry the tail seed a few times before giving up. A transient failure here used to fall
            // straight through to the SSE with lastSeq=0, replaying the whole history (now server-capped,
            // but still a needless full tail). Stop as soon as a page seeds; on total failure fall through.
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                const page = await getSessionEventPage(selectedId, {
                  tail: TAIL_PAGE,
                  signal: seedAbort.signal,
                });
                if (closed) return;
                accRef.current = page.events;
                for (const e of page.events) if (isSeq(e.seq)) seen.current.add(e.seq);
                oldestSeqRef.current = page.events.length ? page.events[0].seq : null;
                hasMoreOlderRef.current = page.hasMore;
                lastSeq = page.events.reduce((m, e) => (isSeq(e.seq) ? Math.max(m, e.seq) : m), lastSeq);
                // Paint the newest slice first and release the rest after the browser has drawn it:
                // a full page is a few hundred Markdown bodies to parse and highlight in one
                // synchronous burst, which the user would otherwise spend staring at the skeleton.
                // accRef keeps the whole page throughout, so the SSE and the cache are unaffected,
                // and the remainder lands above a viewport that stays pinned to the tail.
                const { now, deferred } = firstPaintSlice(page.events);
                setEvents(now);
                setSeeding(false); // history is on screen — drop the skeleton
                writeCache();
                if (deferred) {
                  // A macrotask, not rAF: rAF callbacks run BEFORE the paint they're queued for,
                  // which would merge the two renders and defeat the split.
                  paintRest = setTimeout(() => {
                    if (!closed) setEvents(accRef.current);
                  }, 0);
                }
                return;
              } catch {
                if (closed) return;
                // Last attempt failed: fall through to the SSE (the server caps a cursor-less replay).
                if (attempt < 2) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
              }
            }
            // Every attempt failed. Clear the skeleton anyway rather than spin forever — the SSE
            // replay below is the remaining path to content.
            if (!closed) setSeeding(false);
          })()
        : null;
    // Debounce the rest of the network work: scrubbing the list with the arrow keys shouldn't
    // open (and tear down) a connection — nor re-fetch approvals/queued turns — for each
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
        .then((rows) => setQueued(rows.map((r) => ({ ...r, shell: r.kind === 'shell' }))))
        .catch(() => undefined);
      // The complete background-shell list (all launches, output recovered from Read polls) —
      // the loaded event window only holds the most recent launches, so without this the tray
      // under-counts a long session. Merged with the live-derived overlay in the tray. Throttled
      // per session (BG_TTL_MS): this scans the session's whole history, so a re-open within the
      // window paints the cached shells instead of re-running it. A failed fetch isn't cached, so
      // it retries next open.
      const loadBackgroundShells = (): void => {
        const bgCached = bgCacheRef.current.get(selectedId);
        if (bgCached && Date.now() - bgCached.at < BG_TTL_MS) {
          setServerBgShells(bgCached.shells);
          return;
        }
        getBackgroundShells(selectedId)
          .then((shells) => {
            bgCacheRef.current.set(selectedId, { at: Date.now(), shells });
            // Still cache it above (it belongs to `selectedId`, whenever it lands), but only the
            // open session may paint: this now runs after the transcript, so a slow scan can
            // easily outlive the switch away — and `serverBgShells` is one slot, not per-session.
            if (!closed) setServerBgShells(shells);
          })
          .catch(() => undefined);
      };
      // Open the stream once the seed above has established the resume point, so the SSE
      // streams only what's newer than the page (no full-history replay). The seed started at
      // t=0 and this block at t=SWITCH_DEBOUNCE_MS, so on a cache hit — or a seed that already
      // landed — this connects immediately.
      void (async () => {
        await seed;
        if (closed) return;
        connect();
        // Last, deliberately: the tray it feeds sits below the fold and nothing else waits on it,
        // whereas the scan behind it is the most expensive read on this path. Issuing it here
        // rather than alongside the seed keeps it from competing for the connection — and, on the
        // server, the event loop — with the one request the transcript is actually waiting for.
        loadBackgroundShells();
      })();
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
  const runStatus = selectedSession ? sessionRunStatusOf(selectedSession) : undefined;
  // A terminal run has no turn in flight either, and it may have reached that state
  // without a turn_end — so this is the recovery path when the `final` event was the one
  // that got missed. Deliberately the live/terminal split, not "anything but RUNNING":
  // a QUEUED session has nothing running yet, but the next message still has to queue
  // behind the turn it is waiting for.
  const runTerminal = !!selectedSession && isSessionTerminal(selectedSession);
  useEffect(() => {
    if (runStatus === 'AWAITING_INPUT') setIdle(true);
    else if (runStatus === 'RUNNING') setIdle(false);
    else if (runTerminal) setIdle(true);
  }, [runStatus, runTerminal, selectedId]);

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
  }, [events, streamingText, streamingThink, approvals, queued, localStatusCards, measure]);

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
    ): Promise<{
      id: string;
      turnId?: string;
      queuedItem?: QueuedTurn;
      created?: boolean;
      /** The provider this create actually sent, for the remember-on-the-agent write-back. */
      provider?: string;
      /** The explicitly picked permission mode, for the same write-back. */
      permissionMode?: string;
    }> => {
      const { content, images: imgs, shell } = vars;
      if (selectedTrashed)
        throw new Error('Restore this session to Open before sending a message');
      if (selectedMissing) throw new Error('Session not found');
      if (selected && live && sameSessionSendBlocked)
        throw new Error(sameSessionSendBlockedCopy);
      // Only fully-uploaded images carry an id to reference; onSend blocks while any is
      // still uploading, so this is the complete set.
      const attachmentIds = imgs.map((im) => im.id).filter((x): x is string => !!x);
      // Continue a live session; revive an ended-but-resumable one (same row, claude
      // --resumes its context); otherwise (no selection, or unresumable) start fresh.
      // New-draft uploads are unscoped and can follow CREATE. Uploads made while viewing an
      // existing session belong to that session, so a terminal CREATE fallback blocks below
      // and keeps the chips visible instead of passing invalid attachment ids or dropping them.
      if (selected && live) {
        const res = await sendTurn(selected.id, content, attachmentIds, shell ? 'shell' : undefined);
        // A turn already running ⇒ this message is queued (delivered once that turn
        // finishes); surface it as a pending bubble the user can withdraw. When idle
        // it's delivered right away, so it'll arrive via its own `user` event instead —
        // for a shell turn that's the Bash card its output lands in. A mid-turn `!cmd`
        // waits behind the running turn exactly like a message, so it gets a bubble too:
        // without one it sat in the queue invisibly and read as a dropped command.
        const queuedItem = idle ? undefined : { turnId: res.turnId, content, shell };
        return { id: selected.id, turnId: res.turnId, queuedItem };
      }
      if (selected && !live) {
        // Capabilities can change with heartbeat/context cleanup, so never POST /resume from a
        // cached terminal decision (positive or negative). Re-read detail immediately; if another
        // client already made it live, honor fresh canSend, if its context is now available resume
        // it, and only then fall back to a fresh run.
        const fresh = await getSession(selected.id);
        qc.setQueryData(sessionQuery(selected.id).queryKey, fresh);
        const freshReason = sessionResumeBlockedReasonOf(fresh);
        const freshLegacyResumable = !!fresh.startedAt && !!runner.online;
        const disposition = sessionSendDispositionOf(fresh, freshLegacyResumable);
        if (disposition === 'BLOCK')
          throw new Error(
            sessionSendBlockedMessage(
              sessionLifecycleStateOf(fresh) === 'TRASH' ? 'TRASHED' : freshReason,
            ),
          );
        if (disposition === 'SEND') {
          const res = await sendTurn(
            selected.id,
            content,
            attachmentIds,
            shell ? 'shell' : undefined,
          );
          const queuedItem =
            sessionRunStateOf(fresh) === 'AWAITING_INPUT' || shell
              ? undefined
              : { turnId: res.turnId, content };
          return { id: selected.id, turnId: res.turnId, queuedItem };
        }
        if (disposition === 'RESUME') {
          // The pills were seeded from this session's stored config, so an untouched
          // send keeps it and an edited Mode/Model/Effort/Provider is re-applied on resume.
          // A `!cmd` revives via a shell turn: claude --resumes (context restored) and the
          // runner runs the command, buffering its output for the next message.
          const provider =
            pendingResumeProvider ??
            fresh.provider ??
            selected.provider ??
            detailForSelected?.provider ??
            'claude';
          const wireEffort = normalizeEffortForProvider(
            provider,
            effort,
            model,
            runner.modelCatalog,
          );
          const res = await resumeSession(
            selected.id,
            content,
            // Keep '' so choosing Default explicitly clears a stale stored variant.
            {
              model,
              permissionMode: MODE_TO_PERMISSION[mode],
              effort: wireEffort,
              ...(pendingResumeProvider ? { provider: pendingResumeProvider } : {}),
            },
            attachmentIds,
            shell ? 'shell' : undefined,
          );
          return { id: selected.id, turnId: res.turnId };
        }
        if (attachmentIds.length > 0)
          throw new Error(scopedAttachmentCreateBlockedMessage(attachmentIds.length));
        // Fall through to createInteractiveSession: terminal non-resumable sessions keep the
        // established "start a new session" behavior instead of sending an invalid resume.
      }
      const provider = pickedProvider;
      const wireEffort = normalizeEffortForProvider(provider, effort);
      const providerResolved = providerIdentityResolved(
        provider,
        configuredProvidersLoaded,
      );
      const modelWasEdited =
        modelSeedState.current.contextKey === modelContextKey && modelSeedState.current.dirty;
      const modeWasEdited =
        modeSeedState.current.contextKey === modelContextKey && modeSeedState.current.dirty;
      // Never turn an unresolved custom-provider slug into an explicit Claude model. If provider
      // discovery is still pending/failed, omit the untouched override and let the server resolve
      // the configured provider's own default. Once resolved, derive from the current seed rather
      // than waiting for the post-render state effect to catch up.
      const createModel =
        providerResolved || selected?.model
          ? modelWasEdited
            ? model
            : (selected ? selectedModelDefault : pickedModelDefault) ?? model
          : undefined;
      const createPermissionMode = selected
        ? MODE_TO_PERMISSION[mode]
        : modeWasEdited
          ? MODE_TO_PERMISSION[mode]
          : providerResolved
            ? MODE_TO_PERMISSION[pickedModeSeed ?? mode]
            : undefined;
      const created = await createInteractiveSession({
        prompt: content,
        assignedRunnerId: runner.id,
        agentId,
        // Only an explicit pick travels: leaving it off keeps the server's inherit-from-agent
        // path, so a session started without touching the hero behaves exactly as before.
        provider: draftProvider ?? undefined,
        model: createModel,
        permissionMode: createPermissionMode,
        // Send even '' (Default) explicitly: the composer already seeds the pill from the agent's
        // default, so the pill is authoritative — an explicit Default must stick, not fall back to
        // the agent's effort server-side (session.effort ?? agent.effort). Task runs omit it, so
        // those still inherit the agent default.
        effort: wireEffort,
        attachmentIds,
        // A `!cmd` draft seeds the session's first turn as a shell command, not a message.
        shell,
      });
      // Only an *edited* Mode is worth remembering on the agent: the untouched seed is the Auto
      // default, possibly clamped for this provider (Auto -> Default on a model that can't run
      // it), and writing that back would erase the agent's real stored mode.
      return {
        id: created.id,
        created: true,
        permissionMode: modeWasEdited ? MODE_TO_PERMISSION[mode] : undefined,
      };
    },
    onSuccess: (
      { id, turnId, queuedItem, created, permissionMode: sentMode },
      vars,
    ) => {
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
      // The provider pick is deliberately not written back — see DRAFT_PROVIDER_PREFIX. The session
      // carries its own binding, and the agent's default keeps meaning "what this project starts
      // on", including for the runs nobody is watching.
      //
      // The Mode pick is different: without a write-back it lived on that one session only, and
      // every task-launched run inherits agent.permissionMode server-side, so an edited pick is
      // written back for those (new sessions themselves always default to Auto). Best-effort: a
      // failed PATCH costs a remembered default, never a wrong dispatch.
      if (created && sentMode && agentId) {
        const patchedAgentId = agentId;
        qc.setQueryData<any[]>(agentsQuery().queryKey, (old) =>
          old?.map((a) => (a.id === patchedAgentId ? { ...a, permissionMode: sentMode } : a)),
        );
        void api(`/agents/${patchedAgentId}`, {
          method: 'PATCH',
          body: { permissionMode: sentMode },
        })
          .then(() => qc.invalidateQueries({ queryKey: agentsQuery().queryKey }))
          .catch(() => {});
      }
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
      setView('open'); // a new/continued session lives in Open
      if (queuedItem) setQueued((q) => [...q, queuedItem]);
      else setIdle(false); // a turn is now starting
      qc.invalidateQueries({ queryKey: ['sessions'] });
      // Reviving moves the row from Completed to Open server-side (see SessionsService.resume),
      // so refetch the detail too — otherwise the header ⋮ keeps offering Move to Open for a
      // session that's already back in Open.
      qc.invalidateQueries({ queryKey: ['session', id] });
    },
    onError: (e: Error) => message.error(e.message),
  });
  const control = useMutation({
    mutationFn: (id: string) => interruptSession(id),
    onSuccess: () => {
      // Interrupt drops queued follow-ups server-side. Rather than silently lose what the
      // user typed, fold their queued text back into the composer so it can be edited and
      // resent — the composer is guaranteed empty here (showStop only offers Stop with an
      // empty composer), so this never clobbers an in-progress draft. Queued images can't
      // be rehydrated (a ComposerImage needs its File), so flag any that were dropped.
      const restored = queued
        .map((q) => {
          const body = q.content.trim();
          return body && q.shell ? `!${body}` : body; // a `!cmd` comes back as one
        })
        .filter(Boolean)
        .join('\n\n');
      const droppedImages = queued.reduce(
        (n, q) => n + (q.attachments?.length ?? turnImages[q.turnId]?.length ?? 0),
        0,
      );
      if (restored) setText(restored);
      if (droppedImages)
        message.info(
          `${droppedImages} queued image${droppedImages > 1 ? 's' : ''} weren't restored — re-add if needed`,
        );
      setQueued([]);
      qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (e: Error) => message.error(e.message),
  });
  // Withdraw a queued message. Optimistically remove it; if the runner already leased
  // it (it's no longer cancellable) it'll arrive in the transcript via its `user` event.
  const cancelQueued = async (turnId: string): Promise<void> => {
    if (!selectedId) return;
    const withdrawn = queued.find((x) => x.turnId === turnId);
    setQueued((q) => q.filter((x) => x.turnId !== turnId));
    try {
      await cancelQueuedTurn(selectedId, turnId);
      // Withdrawing shouldn't silently eat what the user typed (interrupt parity): fold the
      // message back into the composer so it can be edited and resent. Only restored once the
      // DELETE succeeds — a rejected withdraw means the runner already leased it, so it lands
      // in the transcript and restoring would duplicate it. Unlike Stop (offered only with an
      // empty composer), Cancel is reachable mid-draft, so an in-progress draft always wins —
      // read through textRef, since the awaited gap may have outdated this render's `text`.
      const body = withdrawn?.content.trim();
      if (body && !textRef.current.trim()) setText(withdrawn?.shell ? `!${body}` : body);
      const droppedImages = withdrawn?.attachments?.length ?? turnImages[turnId]?.length ?? 0;
      if (droppedImages)
        message.info(
          `${droppedImages} image${droppedImages > 1 ? 's' : ''} from that message weren't restored — re-add if needed`,
        );
    } catch {
      message.info('This message is already being processed and cannot be withdrawn');
    }
  };
  // Lifecycle actions happen immediately and offer Undo; Complete also ends a live run.
  const restoreMut = useMutation({
    mutationFn: (session: SessionToastTarget & { notify: boolean }) => restoreSession(session.id),
    onSuccess: (_d, session) => {
      setView('open');
      qc.invalidateQueries({ queryKey: ['sessions'] });
      qc.invalidateQueries({ queryKey: ['session', session.id] });
      if (session.notify) {
        message.sessionNotice({
          sessionId: session.id,
          sessionTitle: session.title,
          event: 'restore',
          headline: 'Moved to Open',
          tone: 'info',
          icon: 'undo',
        });
      }
    },
    onError: (e: Error, session) =>
      message.sessionNotice({
        sessionId: session.id,
        sessionTitle: session.title,
        event: 'restore-error',
        headline: 'Could not move to Open',
        detail: e.message,
        tone: 'error',
      }),
  });
  const requestRestore = useCallback(
    (session: any): void => {
      const source = selectedSession?.id === session.id ? selectedSession : session;
      if (!sessionCapabilityOf(source, 'canRestore', true)) {
        message.info('This session cannot be moved to Open right now.');
        return;
      }
      restoreMut.mutate({ id: session.id, title: session.title, notify: true });
    },
    [message, restoreMut, selectedSession],
  );
  const showUndo = (session: SessionToastTarget, action: 'complete' | 'trash'): void => {
    message.sessionAction({
      sessionId: session.id,
      sessionTitle: session.title,
      action,
      onUndo: () => restoreMut.mutate({ ...session, notify: false }),
    });
  };
  // Completing/trashing the Open session drops it from the Open list. Keep the
  // selection at the same row: step to the next session down (or the previous one
  // when we just completed the last row) so the cursor stays put instead of jumping
  // to the top of the list. With nothing left to land on, fall back to the agent's
  // list (same move as the tab switcher) — that re-scopes the left column (a null
  // `selected` would collapse `scopeAgentId` and leak every agent's sessions) and
  // shows its empty/compose state. A non-open row leaves the conversation untouched.
  const leaveIfOpen = (id: string): void => {
    if (id !== selectedId) return;
    const idx = orderedSessions.findIndex((s) => s.id === id);
    const next = idx >= 0 ? (orderedSessions[idx + 1] ?? orderedSessions[idx - 1]) : null;
    if (next) {
      navigate(`/sessions/${encodeId(next.id)}`);
      return;
    }
    const a = scopeAgentId ?? agentsForRunner[0]?.id;
    navigate(a ? `/agents/${encodeId(a)}` : `/runners/${encodeId(runner.id)}`);
  };
  // After leaveIfOpen re-scopes to the agent, the auto-open effect picks that agent's
  // next session — but it reads the cached list, which still holds the row we just
  // completed/trashed until the refetch lands. Drop it now so auto-open can't re-select
  // the removed session (which would null out `selected`, collapse the agent scope, and
  // leak every agent's sessions into the list). The invalidate below still reconciles.
  const dropFromLists = (id: string): void => {
    qc.setQueriesData<any[]>({ queryKey: ['sessions'] }, (old) =>
      Array.isArray(old) ? old.filter((s) => s.id !== id) : old,
    );
  };
  const completeMut = useMutation({
    mutationFn: (session: SessionToastTarget) => completeSession(session.id),
    onSuccess: (_d, session) => {
      leaveIfOpen(session.id);
      dropFromLists(session.id);
      qc.invalidateQueries({ queryKey: ['sessions'] });
      showUndo(session, 'complete');
    },
    onError: (e: Error, session) =>
      message.sessionNotice({
        sessionId: session.id,
        sessionTitle: session.title,
        event: 'complete-error',
        headline: 'Could not complete session',
        detail: e.message,
        tone: 'error',
      }),
  });
  const requestComplete = useCallback(
    (session: any): void => {
      const source = selectedSession?.id === session.id ? selectedSession : session;
      if (!sessionCapabilityOf(source, 'canComplete', true)) {
        message.info('This session cannot be completed right now.');
        return;
      }
      completeMut.mutate({ id: session.id, title: session.title });
    },
    [completeMut, message, selectedSession],
  );
  // ⌘/Ctrl+D completes the open session — the keyboard twin of the action on its row. Fires
  // even while the composer is focused; preventDefault swallows the browser's bookmark
  // shortcut. The endpoint handles ending a live run and moving it to Completed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() !== 'd' || e.shiftKey || e.altKey) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (
        !selected ||
        !isCompleteShortcutEligible(selectedSession, selectedLifecycleState)
      )
        return;
      e.preventDefault();
      setHeaderMenuOpen(false);
      requestComplete(selected);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, selectedSession, selectedLifecycleState, requestComplete]);
  const deleteMut = useMutation({
    mutationFn: (session: SessionToastTarget) => deleteSession(session.id),
    onSuccess: (_d, session) => {
      leaveIfOpen(session.id);
      dropFromLists(session.id);
      qc.invalidateQueries({ queryKey: ['sessions'] });
      showUndo(session, 'trash');
    },
    onError: (e: Error, session) =>
      message.sessionNotice({
        sessionId: session.id,
        sessionTitle: session.title,
        event: 'trash-error',
        headline: 'Could not move to Trash',
        detail: e.message,
        tone: 'error',
      }),
  });
  // Permanent delete (from Trash): unlike deleteMut there's no undo — the row and all its
  // data are gone — so it's always gated behind confirmPurge's modal.
  const purgeMut = useMutation({
    mutationFn: (session: SessionToastTarget) => purgeSession(session.id),
    onSuccess: (_d, session) => {
      leaveIfOpen(session.id);
      dropFromLists(session.id);
      qc.invalidateQueries({ queryKey: ['sessions'] });
      message.sessionNotice({
        sessionId: session.id,
        sessionTitle: session.title,
        event: 'purge',
        headline: 'Session permanently deleted',
        tone: 'danger',
        icon: 'trash',
      });
    },
    onError: (e: Error, session) =>
      message.sessionNotice({
        sessionId: session.id,
        sessionTitle: session.title,
        event: 'purge-error',
        headline: 'Permanent deletion failed',
        detail: e.message,
        tone: 'error',
      }),
  });
  const confirmPurge = (session: SessionToastTarget): void => {
    modal.confirm({
      title: 'Delete permanently?',
      content:
        'This session and its full transcript will be permanently deleted. This cannot be undone.',
      okText: 'Delete permanently',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      onOk: () => purgeMut.mutate(session),
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
  // Apply the menu's complete selection in one write. Optimistically patch every list scope so the
  // checkmarks, row dots and tag grouping move immediately; the server response restores its order.
  const setTagsMut = useMutation({
    mutationFn: ({ id, tagIds }: { id: string; tagIds: string[] }) => setSessionTags(id, tagIds),
    onMutate: ({ id, tagIds }) => {
      const previousLists = qc.getQueriesData<any[]>({ queryKey: ['sessions'] });
      const previousDetail = qc.getQueryData<any>(['session', id]);
      const tags = sessionTags.filter((t) => tagIds.includes(t.id));
      qc.setQueriesData<any[]>({ queryKey: ['sessions'] }, (old) =>
        Array.isArray(old) ? old.map((s) => (s.id === id ? { ...s, tags } : s)) : old,
      );
      qc.setQueryData<any>(['session', id], (old: any) => (old ? { ...old, tags } : old));
      return { previousLists, previousDetail };
    },
    onSuccess: (tags, { id }) => {
      qc.setQueriesData<any[]>({ queryKey: ['sessions'] }, (old) =>
        Array.isArray(old) ? old.map((s) => (s.id === id ? { ...s, tags } : s)) : old,
      );
      qc.setQueryData<any>(['session', id], (old: any) => (old ? { ...old, tags } : old));
    },
    onError: (e: Error, { id }, context) => {
      context?.previousLists.forEach(([key, value]) => qc.setQueryData(key, value));
      if (context?.previousDetail !== undefined) {
        qc.setQueryData(['session', id], context.previousDetail);
      }
      message.error(e.message);
    },
    onSettled: (_data, _error, { id }) => {
      tagSaveInFlight.current = false;
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      void qc.invalidateQueries({ queryKey: ['session', id], exact: true });
    },
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
  // Repair the machine's shared checkout when the runner reports it stuck mid-merge (which blocks
  // every session's merge there). Async like the others: the runner does it on its next heartbeat,
  // and refetching agents is what clears the warning, since repoHealth rides that payload.
  const repoCleanupMut = useMutation({
    mutationFn: (agentId: string) => cleanUpAgentRepo(agentId),
    onSuccess: () => {
      message.success('Cleaning up the checkout — the runner picks this up on its next heartbeat.');
      void qc.invalidateQueries({ queryKey: agentsQuery().queryKey });
    },
    onError: (e: Error) => message.error(e.message),
  });
  const askCleanUpRepo = (agentId: string, root: string) =>
    modal.confirm({
      title: 'Clean up this checkout?',
      content:
        `Orbit will save everything ${root} currently holds — uncommitted edits, conflict markers,` +
        ' untracked files — to a new orbit/rescue-… branch, then return the checkout to its last' +
        ' commit so merges work again. Nothing is discarded, and the rescue branch is never deleted.',
      okText: 'Save and clean up',
      onOk: () => repoCleanupMut.mutateAsync(agentId).catch(() => {}),
    });
  // Merge this session's worktree branch into main on the runner that ran it. Async: the
  // runner merges on its next heartbeat and the outcome lands on sessionDetail.mergeStatus
  // (the status bar polls while pending). Invalidate detail so 'pending' shows immediately.
  const mergeMut = useMutation({
    mutationFn: (vars: SessionToastTarget & { target?: string }) =>
      mergeSessionToMain(vars.id, vars.target),
    onSuccess: (_d, vars) => {
      qc.setQueryData<any>(['session', vars.id], (old: any) =>
        old
          ? { ...old, mergeStatus: 'pending', mergeTarget: vars.target ?? old.mergeTarget, mergeError: null }
          : old,
      );
      const token = ++pendingOperationSeq.current;
      setPendingSessionOperations((current) => ({
        ...current,
        [vars.id]: { ...vars, token, kind: 'merge' },
      }));
      void qc.invalidateQueries({ queryKey: ['session', vars.id] });
    },
    onError: (e: Error, vars) =>
      message.sessionNotice({
        sessionId: vars.id,
        sessionTitle: vars.title,
        event: 'merge-request-error',
        headline: `Could not start merge${vars.target ? ` into ${vars.target}` : ''}`,
        detail: e.message,
        tone: 'error',
      }),
  });
  // Resolve a merge conflict in-session: revive the session so its own agent rebases the branch
  // onto the target that conflicted and fixes the conflicts (it has the context for its own
  // changes); the rebase bakes the resolution into the branch's commits, so the runner's rebase
  // merge then fast-forwards cleanly. resume() clears the stale mergeStatus, so the bar offers
  // "Merge to <target>" again once the agent finishes.
  const resolveMut = useMutation({
    mutationFn: (vars: SessionToastTarget & { branch: string; target: string }) =>
      resumeSession(
        vars.id,
        'Rebase this branch onto the latest ' +
          vars.target +
          ' and resolve any conflicts.\n\n' +
          "You're in this session's isolated git worktree, checked out on " +
          vars.branch +
          '. Run git rebase ' +
          vars.target +
          ' — it may stop on conflicts. For each, resolve every conflict' +
          ' using your knowledge of the changes made on this branch, git add the resolved' +
          ' files, then git rebase --continue, repeating until the rebase completes. Do not' +
          ' push. Once the rebase finishes, the branch can be merged into ' +
          vars.target +
          ' cleanly from the status bar above the composer.',
      ),
    onSuccess: (_d, vars) => {
      message.sessionNotice({
        sessionId: vars.id,
        sessionTitle: vars.title,
        event: 'resolve-conflict',
        headline: 'Conflict resolution started',
        tone: 'info',
        icon: 'sync',
      });
      void qc.invalidateQueries({ queryKey: ['session', vars.id] });
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (e: Error, vars) =>
      message.sessionNotice({
        sessionId: vars.id,
        sessionTitle: vars.title,
        event: 'resolve-conflict-error',
        headline: 'Could not start conflict resolution',
        detail: e.message,
        tone: 'error',
      }),
  });
  // Commit a live session's uncommitted worktree changes onto its branch. Like merge it runs
  // on the runner (heartbeat round-trip) and the outcome lands on commitStatus/worktreeDirty;
  // committing is safe/local so it fires directly (no confirm). Invalidate detail so 'pending'
  // shows immediately and the poll above picks up the runner's outcome.
  const commitMut = useMutation({
    mutationFn: (session: SessionToastTarget) => commitSession(session.id),
    onSuccess: (_d, session) => {
      qc.setQueryData<any>(['session', session.id], (old: any) =>
        old ? { ...old, commitStatus: 'pending', commitError: null } : old,
      );
      const token = ++pendingOperationSeq.current;
      setPendingSessionOperations((current) => ({
        ...current,
        [session.id]: { ...session, token, kind: 'commit' },
      }));
      void qc.invalidateQueries({ queryKey: ['session', session.id] });
    },
    onError: (e: Error, session) =>
      message.sessionNotice({
        sessionId: session.id,
        sessionTitle: session.title,
        event: 'commit-request-error',
        headline: 'Could not start commit',
        detail: e.message,
        tone: 'error',
      }),
  });
  // Adopt the worktree's actual HEAD branch (after an in-worktree `git checkout -b`) as the
  // session's tracked branch, so Merge/diff act on the real work instead of a stale "In main".
  // Pure server-side re-point; invalidate detail so the bar re-derives (divergence clears).
  const adoptMut = useMutation({
    mutationFn: (session: SessionToastTarget) => adoptSessionBranch(session.id),
    onSuccess: (res, session) => {
      message.sessionNotice({
        sessionId: session.id,
        sessionTitle: session.title,
        event: 'adopt-branch',
        headline: `Now tracking ${res.branch}`,
        tone: 'info',
        icon: 'branch',
      });
      void qc.invalidateQueries({ queryKey: ['session', session.id] });
    },
    onError: (e: Error, session) =>
      message.sessionNotice({
        sessionId: session.id,
        sessionTitle: session.title,
        event: 'adopt-branch-error',
        headline: 'Could not update tracked branch',
        detail: e.message,
        tone: 'error',
      }),
  });
  // Change a LIVE session's model / mode / provider between turns. Optimistically patch the
  // cached session so the pill updates instantly; server-side the runner re-spawns
  // claude --resume with the new flag. Revert + surface the error on failure. Keyed on
  // effectiveView to match the (view-scoped) sessions query that renders the list.
  const configMut = useMutation({
    mutationFn: (cfg: {
      model?: string;
      permissionMode?: string;
      effort?: string;
      provider?: string;
    }) => updateSessionConfig(selected!.id, cfg),
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
  const canAttach =
    runner.online &&
    !selectedTrashed &&
    !sameSessionSendBlocked &&
    (selected ? live || resumable : composing);
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

  function showLocalStatus(): void {
    const planRow = shownPlanUsage ? planUsageRows(shownPlanUsage)[0] : undefined;
    const rows = localStatusRows({
      surface: 'Web',
      runnerName: runner.displayName || runner.name,
      runnerOnline: runner.online,
      activeSessions: runner.activeSessions,
      maxConcurrent: runner.maxConcurrent,
      sessionTitle: selected?.title ?? (selectedMissing ? 'Session not found' : null),
      sessionStatus: selectedSession
        ? statusLabel(selectedSession)
        : selectedMissing
          ? 'not found'
          : null,
      agentName: shownAgentName,
      provider: shownProvider,
      model: shownModel,
      permissionMode: shownMode,
      effort: shownEffort,
      contextTokens,
      contextWindow:
        shownProvider === 'opencode' && shownModel === ''
          ? undefined
          : (reportedContextWindow ??
            contextWindowFor(shownModel, runner.modelCatalog, configuredProviders, shownProvider)),
      planUsageLabel: planRow?.label,
      planUsagePercent: planRow?.percent,
    });
    pinToBottom();
    setLocalStatusCards((prev) => [
      ...prev.slice(-4),
      { id: `status-${Date.now()}-${Math.random().toString(36).slice(2)}`, rows },
    ]);
  }

  const onSend = (): void => {
    const c = text.trim();
    if (send.isPending) return;
    const commandName = slashCommandName(c);
    if (commandName !== null) {
      if (isLocalSlashCommand(commandName)) {
        showLocalStatus();
        setText('');
        setHistIdx(-1);
        return;
      }
      if (!replyTo && !codexComposer) {
        if (!commandName) {
          message.error('Pick a slash command before sending');
          return;
        }
        // The catalog is advisory, never a gate. It's empty on a runner that hasn't
        // reported one (pre-0.1.77, freshly enrolled, or one whose CLI slash registry is
        // still unlearned — it only fills in after a session boots), and even a populated
        // one can't see a command living in a worktree the scan skips. Rejecting the send
        // there dropped the command outright: it never reached the queue, and the user was
        // left with a toast instead of a message. An unknown name costs a pass-through at
        // most — the CLI answers "Unknown command: /x" in zero turns — so warn and send.
        const catalogKnown = slashItems.some((it) => it.type !== 'local');
        const knownRunnerCommand = slashItems.some((it) => it.type !== 'local' && it.name === commandName);
        if (catalogKnown && !knownRunnerCommand) {
          message.warning(`/${commandName} isn't in this runner's catalog — sending anyway`);
        }
      }
    }
    if (sameSessionSendBlocked) {
      message.info(sameSessionSendBlockedCopy);
      return;
    }
    if (uploading) return;
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
    // context on the next message. A bare `!` is a no-op; images are ignored. A terminal
    // session is capability-checked in the mutation; without resumable context it starts fresh.
    if (c.startsWith('!')) {
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
  const pendingSlashCommand = slashCommandName(text);
  const localSlashReady = pendingSlashCommand !== null && isLocalSlashCommand(pendingSlashCommand);
  const canSend = localSlashReady
    ? !send.isPending
    : (!!text.trim() || readyImages.length > 0) &&
      !send.isPending &&
      !uploading &&
      runner.online &&
      !selectedTrashed &&
      !sameSessionSendBlocked &&
      !selectedMissing &&
      !loadingSession;
  // The single send button morphs into a Stop while a turn is generating AND the composer
  // is empty — interrupting that turn. With content typed it stays Send, so a follow-up can
  // still be queued mid-turn. Ending the whole session isn't a button here: it's destructive
  // and the reaper recycles an idle/finished session's slot on its own.
  const showStop =
    !!selected &&
    sessionRunStatusOf(selectedSession ?? selected) === 'RUNNING' &&
    !text.trim() &&
    readyImages.length === 0 &&
    !replyTo;

  // ── `/` command, skill, and local command autocomplete ─────────────────────
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
  const slashToken = getSlashToken(text);
  // Scope the `/` menu to the composer's agent: host-level assets (no agentId — e.g.
  // ~/.claude or the runner's default dir) plus the assets of the agent this session
  // runs as. A live session's agent is fixed; a draft uses the picked agent.
  const composerAgentId = live ? selected?.agent?.id : agentId;
  const slashItems = useMemo<ComposerSlashItem[]>(
    () => [
      ...LOCAL_SLASH_ITEMS,
      ...(codexComposer ? [] : [
        ...(runner.commands ?? []).map((c) => ({
          name: c.name,
          description: c.description,
          type: 'command' as const,
          provider: c.provider,
          agentId: c.agentId,
          builtin: c.builtin,
        })),
        ...(runner.skills ?? []).map((s) => ({
          name: s.name,
          description: s.description,
          type: 'skill' as const,
          provider: s.provider,
          agentId: s.agentId,
          builtin: s.builtin,
        })),
      ].filter(
        (it) =>
          slashAssetMatchesProvider(it.provider, shownProvider) &&
          (!it.agentId || it.agentId === composerAgentId),
      )),
    ],
    [runner.commands, runner.skills, composerAgentId, codexComposer, shownProvider],
  );
  const slashMatches = useMemo(() => {
    const items = runner.online ? slashItems : slashItems.filter((it) => it.type === 'local');
    return getSlashMatches(items, slashToken, slashScope);
  }, [slashItems, slashToken, slashScope, runner.online]);
  useEffect(() => {
    setSlashIndex(0);
    if (slashToken === null) setSlashScope(null);
  }, [slashToken]);
  const showSlash =
    slashToken !== null &&
    slashToken !== slashDismissed &&
    !selectedTrashed &&
    !selectedMissing &&
    slashMatches.length > 0;
  const slashIdx = slashMatches.length ? Math.min(slashIndex, slashMatches.length - 1) : 0;
  const pickSlash = (name: string): void => {
    // Replace only the trailing `/token` ($1 preserves the start-or-whitespace before
    // it), so picking a command mid-message doesn't clobber text typed earlier.
    setText(replaceSlashToken(text, name));
    setSlashDismissed(null);
    setTimeout(() => taRef.current?.focus(), 0);
  };
  // ── `@` agent-mention autocomplete ─────────────────────────────────────────
  // Type `@` to reference another agent on this runner; picking one inserts
  // `@<name> ` as plain text. The in-session orchestrator reads the mention from
  // the turn (sent verbatim) and can hand work off to that agent via its session
  // tools — so this is purely a composer convenience with no separate send path.
  // Mirrors the `/` menu above and the task-comment mention menu (TaskDetailPanel).
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState<string | null>(null);
  const mentionToken = /(?:^|\s)@([^\s@]*)$/.exec(text)?.[1] ?? null;
  const mentionMatches = useMemo(() => {
    if (mentionToken === null) return [];
    const q = mentionToken.toLowerCase();
    return agentsForRunner
      .filter((a) => a.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const pa = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const pb = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return pa - pb || a.name.localeCompare(b.name);
      })
      .slice(0, 8);
  }, [agentsForRunner, mentionToken]);
  useEffect(() => {
    setMentionIndex(0);
  }, [mentionToken]);
  const showMention =
    mentionToken !== null &&
    mentionToken !== mentionDismissed &&
    !selectedTrashed &&
    !selectedMissing &&
    mentionMatches.length > 0;
  const mentionIdx = mentionMatches.length ? Math.min(mentionIndex, mentionMatches.length - 1) : 0;
  const pickMention = (name: string): void => {
    // Replace only the trailing `@token` ($1 preserves the start-or-whitespace before it),
    // so picking an agent mid-message doesn't clobber text typed earlier.
    setText(text.replace(/(^|\s)@([^\s@]*)$/, `$1@${name} `));
    setMentionDismissed(null);
    setTimeout(() => taRef.current?.focus(), 0);
  };
  // Open the autocomplete from the `+` menu scoped to one asset kind: drop a `/` (prefixed
  // with a space when mid-message) so slashToken matches and the menu pops.
  const insertSlash = (scope: 'command' | 'skill'): void => {
    setSlashScope(scope);
    setText(openSlash);
    setSlashDismissed(null);
    setTimeout(() => taRef.current?.focus(), 0);
  };
  // The draft is a `!cmd` shell command, not a message: onSend routes it raw to the runner,
  // bypassing the agent. Mirrors that branch's condition exactly (it reads the trimmed text,
  // and a reply-to-question draft resolves an approval instead), so the composer only turns
  // red when the send really would be a shell turn.
  const shellMode = !replyTo && text.trim().startsWith('!');
  // The `+` menu "Shell" entry: prefix the draft with `!` so onSend routes it as a raw
  // shell command (run on the runner, bypassing claude). The user types the command after.
  const insertShell = (): void => {
    setText((t) => (t.startsWith('!') ? t : `!${t}`));
    setTimeout(() => taRef.current?.focus(), 0);
  };
  // The exact inverse: drop the `!` so the draft goes back to being a message for the agent.
  // This is what the `❯` replacing the `+` does in shell mode — a mode you can enter needs a
  // way out that isn't "select the character and delete it". Leading whitespace goes too,
  // since shellMode reads the trimmed text (`  !ls` is shell mode just as much as `!ls`).
  const exitShell = (): void => {
    setText((t) => t.replace(/^\s*!/, ''));
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
  const selectedAgent = agentsForRunner.find((a) => a.id === selected?.agent?.id);
  const effectiveModel = effectiveSessionModel(
    shownProvider,
    selected?.model,
    detailForSelected?.agent?.model ?? selectedAgent?.model,
    runner.modelCatalog,
    configuredProviders,
    runner.runtimeDefaultModels,
  );
  const effectiveEffort =
    selected?.effort ?? detailForSelected?.agent?.effort ?? selectedAgent?.effort ?? '';
  const shownModel: string = live ? effectiveModel : model;
  const catalogModelOptions = shownProviderCapabilitiesResolved
    ? modelOptionsForProvider(shownProvider, runner.modelCatalog, configuredProviders)
    : [];
  // Runtime configuration can name a valid model that is not in the reported catalog yet. Keep
  // that effective default/selectable session value visible in the picker instead of rendering a
  // value the user cannot return to after trying another model.
  const shownModelOptions = catalogModelOptions.some((option) => option.value === shownModel)
    ? catalogModelOptions
    : [
        {
          value: shownModel,
          label:
            !shownProviderCapabilitiesResolved && !selected ? 'Runtime default' : shownModel,
        },
        ...catalogModelOptions,
      ];
  const shownPlanUsage = sessionPlanUsage(shownProvider, runner.planUsage, configuredProviders);
  // Where this session could move without changing CLI. Offered on the two routes that actually
  // carry a provider: a live session's config PATCH, and the resume that revives an ended one. A
  // draft picks in the hero above instead (which offers every runtime, not one), and a terminal
  // session that can't be resumed would start a NEW session on send, where the agent decides. A
  // single entry means there is nowhere to go, and the pill stays out of the composer entirely —
  // the common case, one Claude sign-in and no configured providers.
  const providerSwitchChoices = useMemo(
    () =>
      live || resumable
        ? sameRuntimeChoices(
            shownProvider,
            providerChoicesForRunner,
            configuredProviders,
            runner.modelCatalog,
            runner.runtimeDefaultModels,
          )
        : [],
    [
      live,
      resumable,
      shownProvider,
      providerChoicesForRunner,
      configuredProviders,
      runner.modelCatalog,
      runner.runtimeDefaultModels,
    ],
  );
  const { tokens: contextTokens, window: reportedContextWindow } = lastContextReading(events);
  // Remedy + retry for a sign-in failure card in the transcript. Retry is offered only when
  // there's actually a message to re-send and the session can take one — a trashed/missing
  // session would just throw out of the send mutation.
  const retryText = lastUserMessageText(events, detailForSelected?.prompt, selected?.numTurns);
  const sendMutate = send.mutate;
  const authErrorHelp: AuthErrorHelp = useMemo(
    () => ({
      provider: shownProvider,
      runnerName: runner.name,
      runnerId: runner.id,
      onRetry:
        retryText && !selectedTrashed && !selectedMissing
          ? () => sendMutate({ content: retryText, images: [] })
          : undefined,
      retryText,
      // The provider gallery, not a preset vendor: the engine narrows it to a runtime, not to
      // whose key the user actually holds.
      onUseApiKey: () => navigate('/providers'),
    }),
    // `send.mutate` is referentially stable; `send` itself is not, and depending on it would
    // rebuild this every render and re-render the card through the context.
    [
      shownProvider,
      runner.name,
      runner.id,
      retryText,
      selectedTrashed,
      selectedMissing,
      sendMutate,
      navigate,
    ],
  );
  // The same retry, plus the pending auto-retry, for the quota / provider-error card. Disarming
  // is a plain fire-and-forget: the detail query refetches on settle, and the card's own
  // countdown is driven by the value it reads back.
  const autoRetryHelp: AutoRetryHelp = useMemo(
    () => ({
      provider: shownProvider,
      runnerName: runner.name,
      retryAt: detailForSelected?.retryAt ?? null,
      attempts: detailForSelected?.retryAttempts ?? 0,
      onRetry:
        retryText && !selectedTrashed && !selectedMissing
          ? () => sendMutate({ content: retryText, images: [] })
          : undefined,
      retryText,
      onCancelAuto: selected?.id
        ? () => {
            cancelAutoRetry(selected.id)
              .then(() => qc.invalidateQueries({ queryKey: ['session', selected.id] }))
              .catch((e: Error) => message.error(e.message));
          }
        : undefined,
      onArmAuto: selected?.id
        ? (at: Date) => {
            armAutoRetry(selected.id, at)
              .then(() => qc.invalidateQueries({ queryKey: ['session', selected.id] }))
              .catch((e: Error) => message.error(e.message));
          }
        : undefined,
    }),
    [
      shownProvider,
      runner.name,
      detailForSelected?.retryAt,
      detailForSelected?.retryAttempts,
      retryText,
      selectedTrashed,
      selectedMissing,
      sendMutate,
      selected?.id,
      qc,
    ],
  );
  const shownMode: string = live
    ? (PERMISSION_TO_MODE[
        shownProviderCapabilitiesResolved
          ? clampPermissionModeForModel(
              effectivePermissionMode,
              effectiveModel,
              shownProvider,
              configuredProviders,
            )
          : effectivePermissionMode
      ] ?? 'Default')
    : mode;
  const shownEffort: string = normalizeEffortForProvider(
    shownProvider,
    live ? effectiveEffort : effort,
    shownModel,
    runner.modelCatalog,
  );
  const shownEffortOptions = effortOptionsForProvider(
    shownProvider,
    shownModel,
    runner.modelCatalog,
  );
  // Auto is offered only on models that support it (see supportsAuto); the option
  // is greyed out otherwise so an unsupported model can't pick a mode claude rejects.
  const autoOk =
    !shownProviderCapabilitiesResolved ||
    supportsAuto(shownModel, shownProvider, configuredProviders);
  // What a permission mode ACTUALLY means on the engine that will run it. Derived with the same
  // shared table the server stamps onto the session payload, so the picker cannot drift from it.
  //
  // Only for built-in engines: a configured (BYOK) slug borrows a runtime this screen cannot name,
  // and telling someone "you will be asked" for a session that might be running on Codex is
  // exactly the false assurance this is here to remove. Unknown => say nothing.
  const shownProviderIsBuiltin = Object.values(AgentProvider).some((p) => p === shownProvider);
  const permissionSemanticsFor = useCallback(
    (label: string) =>
      shownProviderIsBuiltin
        ? derivePermissionSemantics(shownProvider, MODE_TO_PERMISSION[label])
        : undefined,
    [shownProvider, shownProviderIsBuiltin],
  );
  const shownModeSemantics = permissionSemanticsFor(shownMode);
  // Model, Mode & Effort can be changed any time on a live session (the runner must be
  // online to act on it). A change made mid-turn doesn't abort the running turn: the
  // server defers the re-spawn until the turn finishes, so it applies on the next turn —
  // same as a queued message. When not live they're freely editable (pre-session config).
  // Agent stays fixed once the session exists (it's never re-assigned on resume).
  const configEditable = selectedTrashed || selectedMissing ? false : live ? runner.online : true;
  // An existing session's agent is fixed (live or recycled/terminal); only a brand-new
  // compose draft reflects the local pick.
  const shownAgentId: string | undefined = selected ? (selected.agent?.id ?? undefined) : agentId;
  // The agent can't be switched once the session exists (live or terminal), nor when the
  // view is locked to one agent. In those cases the Select is dropped from the controls row
  // entirely — the agent is already named in the header and the sidebar.
  const agentReadOnly = !!selected || !!lockedAgentId;
  const shownAgentName =
    agentsForRunner.find((a) => a.id === shownAgentId)?.name ??
    selected?.agent?.name ??
    lockedAgent?.name;
  // Per-control hints derived from the same state that drives enable/disable, so the help
  // can't drift from behaviour (this used to be one hard-coded paragraph on the whole row).
  // Empty string = no tooltip, which keeps idle controls free of hover noise.
  const composerDisabled = selectedTrashed || selectedMissing;
  const configHint = selectedTrashed
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
    setHeaderMenuOpen(false);
  }, [selectedId]);
  // Title shown above the session list (and in the draft header). /sessions/<id>
  // has no agent in the URL, so fall back to the open session's agent, then runner.
  const headAgentName =
    lockedAgent?.name ?? selected?.agent?.name ?? runner.displayName ?? runner.name;
  // The view the header names (and the menu check-marks).
  const shownView: SessionView = effectiveView;
  // Switching view while a session transcript is open closes it: the open session belongs
  // to the view it was opened from, so browsing another one means leaving the conversation.
  const switchView = (next: SessionView): void => {
    setView(next);
    if (!selectedId) return;
    const a = scopeAgentId ?? agentsForRunner[0]?.id;
    navigate(a ? `/agents/${encodeId(a)}` : `/runners/${encodeId(runner.id)}`);
  };
  const activeTag = tagFilter ? (sessionTags.find((t) => t.id === tagFilter) ?? null) : null;
  // Selection reads on the trailing edge, not in a leading icon column. The tag names already
  // need a swatch in front of them, and a leading check on top of that pushed every label so
  // far off the left edge that the menu read as right-heavy. Always rendered (blank when off)
  // so a row's width doesn't change as the selection moves.
  const checkSlot = (on: boolean): ReactNode => (
    <span className="scope-menu-check">{on ? <CheckOutlined /> : null}</span>
  );
  const selectedSessionTagIds = ((selected?.tags ?? []) as SessionTagRef[]).map((t) => t.id);
  const setTagsFromMenu = ({
    key,
    selectedKeys,
  }: {
    key: string;
    selectedKeys: string[];
  }): void => {
    if (!selected || tagSaveInFlight.current || !sessionTags.some((t) => t.id === key)) return;
    const available = new Set(sessionTags.map((t) => t.id));
    tagSaveInFlight.current = true;
    setTagsMut.mutate({
      id: selected.id,
      tagIds: selectedKeys.filter((id) => available.has(id)),
    });
  };
  // One menu for everything that scopes the list: which slice (exclusive), then — below a
  // divider — the tag narrowing and sectioning. Tag entries only appear once the owner has
  // tags; the view entries always do, so Trash is reachable without ever having made one.
  // No group headings: the trigger already names the axis, and the shared check column is
  // what marks the three views as a mutually exclusive set.
  const scopeItems: MenuProps['items'] = [
    ...SESSION_VIEWS.map((v) => ({
      key: v.value,
      label: (
        <span className="scope-menu-row">
          {v.label}
          {checkSlot(shownView === v.value)}
        </span>
      ),
      onClick: () => switchView(v.value),
    })),
    ...(sessionTags.length > 0
      ? [
          { key: 'tag-divider', type: 'divider' as const },
          {
            key: 'filter',
            label: (
              <span className="scope-menu-row">
                Filter by Tag
                {activeTag && (
                  <span className="scope-menu-value">
                    <span className="session-section-dot" style={{ background: activeTag.color }} />
                    <span className="scope-menu-value-text">{activeTag.name}</span>
                  </span>
                )}
              </span>
            ),
            children: [
              {
                key: 'all',
                // Colourless by nature, but it still takes the swatch column (an unpainted
                // dot) so every name in the menu starts on the same edge.
                label: (
                  <span className="scope-menu-row">
                    <span className="scope-tag-label">
                      <span className="session-section-dot" />
                      All
                    </span>
                    {checkSlot(tagFilter === null)}
                  </span>
                ),
                onClick: () => setTagFilter(null),
              },
              // Colour is how a tag is identified everywhere else (the row dots, the
              // "Group by Tag" headings), so carry the swatch here too.
              ...sessionTags.map((t) => ({
                key: t.id,
                label: (
                  <span className="scope-menu-row">
                    <span className="scope-tag-label">
                      <span className="session-section-dot" style={{ background: t.color }} />
                      {t.name}
                    </span>
                    {checkSlot(tagFilter === t.id)}
                  </span>
                ),
                onClick: () => setTagFilter(tagFilter === t.id ? null : t.id),
              })),
            ],
          },
          {
            key: 'group',
            label: (
              <span className="scope-menu-row">
                Group by Tag
                {checkSlot(groupByTag)}
              </span>
            ),
            onClick: () => setGroupByTag((g) => !g),
          },
        ]
      : []),
  ];
  // Header subtitle keeps run outcome and lifecycle location visibly separate, followed by
  // last activity. Task state remains on its own task affordance above the title.
  const headTime = selected
    ? fmtTime(selected.lastTurnAt ?? selected.startedAt ?? selected.createdAt)
    : '';
  const headRunWord = selected ? statusLabel(selectedSession ?? selected) : '';
  const headLifecycleWord = selectedLifecycleState
    ? sessionLifecycleLabel(selectedLifecycleState)
    : null;
  const headSub = composing
    ? `${headAgentName} · New session`
    : selected
      ? [
          headRunWord,
          // A session you filed reads "Completed" on both axes; say it once rather than twice.
          headLifecycleWord === headRunWord ? null : headLifecycleWord,
          headTime,
        ]
          .filter(Boolean)
          .join(' · ')
      : selectedMissing
        ? 'Session not found'
      : selectedId
        ? 'Starting…'
        : '';
  const composerPlaceholder = selectedTrashed
    ? 'Restore this session to continue'
    : selectedMissing
      ? 'Session not found'
      : sameSessionSendBlocked
        ? sameSessionSendBlockedCopy
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
          {/* View + tag filter/grouping, folded into one menu rather than a tab row and a
              chip row — both read as clutter in a narrow column, and Open is nearly always
              the answer. The trigger names the current view so a list scoped to
              Completed/Trash always explains itself. (The native clients still tab.) */}
          <Dropdown trigger={['click']} placement="bottomRight" menu={{ items: scopeItems }}>
            <span
              className={`session-scope-menu${shownView !== 'open' || tagFilter || groupByTag ? ' on' : ''}`}
              title="Switch view, filter and group"
            >
              {SESSION_VIEWS.find((v) => v.value === shownView)?.label}
              <DownOutlined />
            </span>
          </Dropdown>
        </div>
        <div className={`session-new ${composing ? 'active' : ''}`} onClick={goNew}>
          <PlusOutlined />
          <span>New session</span>
          {isStandalone && !isMobile && <kbd className="session-new-kbd">{NEW_SESSION_HINT}</kbd>}
        </div>
        {/* The palette's click target, shaped like the field it opens rather than a bare glyph in
            the header. ⌘K stays the primary way in; this is the only one on a touch device, where
            there's no keyboard to press it with and a `title` tooltip never shows — so the label
            and the target size have to carry it. */}
        <div
          className="session-search"
          role="button"
          tabIndex={0}
          onClick={openSessionSearch}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            openSessionSearch();
          }}
        >
          <SearchOutlined />
          <span>Search sessions</span>
          {!isMobile && <kbd className="session-search-kbd">{SEARCH_HINT}</kbd>}
        </div>
        <div
          className="agent-sessions session-col-list"
          ref={listRef}
          onScroll={onSessionListScroll}
        >
          {visibleSessions.length === 0 && !loadingSessions && (
            <div className="chat-note">
              {tagFilter
                ? 'No sessions with this tag.'
                : view === 'open'
                  ? 'No sessions yet.'
                  : view === 'completed'
                    ? 'No completed sessions.'
                    : 'Trash is empty.'}
            </div>
          )}
          {sections.map((sec) => (
            <Fragment key={sec.key}>
              <div className="session-section-head">
                {sec.tag && (
                  <span className="session-section-dot" style={{ background: sec.tag.color }} />
                )}
                {sec.title}
              </div>
              {sec.sessions.map((s) => {
                const actionSession = selectedSession?.id === s.id ? selectedSession : s;
                const canCompleteRow = sessionCapabilityOf(actionSession, 'canComplete', true);
                const canRestoreRow = sessionCapabilityOf(actionSession, 'canRestore', true);
                const restoreItem = {
                  key: 'restore',
                  icon: <UndoOutlined />,
                  label: view === 'completed' ? 'Move to Open' : 'Restore to Open',
                  disabled: !canRestoreRow,
                  onClick: ({ domEvent }: { domEvent: { stopPropagation: () => void } }) => {
                    domEvent.stopPropagation();
                    requestRestore(s);
                  },
                };
                const deleteItem = {
                  key: 'delete',
                  icon: <DeleteOutlined />,
                  label: 'Delete',
                  danger: true,
                  onClick: ({ domEvent }: { domEvent: { stopPropagation: () => void } }) => {
                    domEvent.stopPropagation();
                    deleteMut.mutate({ id: s.id, title: s.title });
                  },
                };
                const purgeItem = {
                  key: 'purge',
                  icon: <DeleteOutlined />,
                  label: 'Delete permanently',
                  danger: true,
                  onClick: ({ domEvent }: { domEvent: { stopPropagation: () => void } }) => {
                    domEvent.stopPropagation();
                    confirmPurge({ id: s.id, title: s.title });
                  },
                };
                const menuItems: MenuProps['items'] =
                  view === 'completed'
                    ? [restoreItem, { type: 'divider' }, deleteItem]
                    : view === 'trash'
                      ? [restoreItem, { type: 'divider' }, purgeItem]
                      : [restoreItem];
                // Open and Completed rows open their transcript; only
                // Trash rows stay closed.
                const openable = view !== 'trash';
                const line = sessionLine(s, openable);
                const swiped = swipeOpenId === s.id;
                const dragging = swipeDragId === s.id;
                const swipeTx = dragging ? swipeDx : swiped ? -swipeReveal : 0;
                return (
                  <div
                    className={`session-row${openable ? '' : ' no-open'}${s.id === selectedId ? ' active' : ''}${menuOpenId === s.id ? ' menu-open' : ''}${view === 'open' && s.pinnedAt ? ' pinned' : ''}${swiped ? ' swipe-open' : ''}`}
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
                        <StatusIcon session={s} />
                      </span>
                      <div className="session-main">
                        <div className="session-title-row">
                          <div className="session-title">{s.title}</div>
                          {(s.tags ?? []).length > 0 && (
                            <Tooltip
                              title={(s.tags as SessionTagRef[]).map((t) => t.name).join(', ')}
                              placement="top"
                              open={hoverTipOpen}
                            >
                              <span className="session-tag-dots">
                                {(s.tags as SessionTagRef[]).slice(0, 3).map((t) => (
                                  <span
                                    key={t.id}
                                    className="session-tag-dot"
                                    style={{ background: t.color }}
                                  />
                                ))}
                                {s.tags.length > 3 && (
                                  <span className="session-tag-more">+{s.tags.length - 3}</span>
                                )}
                              </span>
                            </Tooltip>
                          )}
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
                        <div
                          className={`session-preview${line.tone === 'preview' ? '' : ` tone-${line.tone}`}`}
                        >
                          {line.text}
                        </div>
                      </div>
                    </div>
                    <div className="session-right">
                      <div className="session-actions" onClick={(e) => e.stopPropagation()}>
                        {view === 'open' ? (
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
                            <Tooltip
                              title={canCompleteRow ? 'Complete' : 'Complete unavailable right now'}
                              placement="top"
                              open={hoverTipOpen}
                            >
                              <span
                                className={`session-kebab session-complete${canCompleteRow ? '' : ' disabled'}`}
                                role="button"
                                aria-label="Complete"
                                aria-disabled={!canCompleteRow}
                                tabIndex={canCompleteRow ? 0 : -1}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  requestComplete(s);
                                  setSwipeOpenId(null);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key !== 'Enter' && e.key !== ' ') return;
                                  e.preventDefault();
                                  e.stopPropagation();
                                  requestComplete(s);
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
            </Fragment>
          ))}
          {/* Foot of the loaded window while a page is in flight, so a scroll that outruns the
              fetch (or a switch to an agent not yet cached) shows progress rather than an
              abrupt end of list. */}
          {loadingSessions && (
            <div className="session-list-more">
              <Spin size="small" />
            </div>
          )}
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
                {...(selected && !selectedTrashed && !composing
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
                open={headerMenuOpen}
                onOpenChange={setHeaderMenuOpen}
                menu={{
                  selectable: !selectedTrashed,
                  multiple: !selectedTrashed,
                  selectedKeys: selectedTrashed ? [] : selectedSessionTagIds,
                  onSelect: selectedTrashed ? undefined : setTagsFromMenu,
                  onDeselect: selectedTrashed ? undefined : setTagsFromMenu,
                  items: selectedTrashed
                    ? [
                        {
                          key: 'restore',
                          icon: <UndoOutlined />,
                          label: 'Restore to Open',
                          disabled: !selectedCanRestore,
                          onClick: () => {
                            setHeaderMenuOpen(false);
                            requestRestore(selected);
                          },
                        },
                        { type: 'divider' },
                        {
                          key: 'purge',
                          icon: <DeleteOutlined />,
                          danger: true,
                          label: 'Delete permanently',
                          onClick: () => {
                            setHeaderMenuOpen(false);
                            confirmPurge({ id: selected.id, title: selected.title });
                          },
                        },
                      ]
                    : [
                        // Keyboard-only would leave the feature undiscoverable, and unreachable
                        // for anyone on a trackpad-and-touch device.
                        {
                          key: 'find',
                          icon: <SearchOutlined />,
                          label: `Find in session · ${FIND_HINT}`,
                          onClick: () => {
                            setHeaderMenuOpen(false);
                            openSessionFind();
                          },
                        },
                        ...(sessionTags.length > 0
                          ? [
                              {
                                type: 'group' as const,
                                label: 'Tags',
                                children: sessionTags.map((t) => ({
                                  key: t.id,
                                  disabled: setTagsMut.isPending,
                                  label: (
                                    <span className="scope-menu-row">
                                      <span className="scope-tag-label">
                                        <span
                                          className="session-section-dot"
                                          style={{ background: t.color }}
                                        />
                                        {t.name}
                                      </span>
                                      {checkSlot(selectedSessionTagIds.includes(t.id))}
                                    </span>
                                  ),
                                })),
                              },
                            ]
                          : []),
                        { type: 'divider' as const },
                        // A Completed session is retained, not gone — offer the same move
                        // its row has in Completed, so it can return to Open in place.
                        ...(selectedCompleted
                          ? [
                              {
                                key: 'restore',
                                icon: <UndoOutlined />,
                                label: 'Move to Open',
                                disabled: !selectedCanRestore,
                                onClick: () => {
                                  setHeaderMenuOpen(false);
                                  requestRestore(selected);
                                },
                              },
                              { type: 'divider' as const },
                            ]
                          : selectedLifecycleState === 'OPEN'
                            ? [
                                {
                                  key: 'complete',
                                  icon: <CheckOutlined />,
                                  label: 'Complete',
                                  disabled: !selectedCanComplete,
                                  onClick: () => {
                                    setHeaderMenuOpen(false);
                                    requestComplete(selected);
                                  },
                                },
                                { type: 'divider' as const },
                              ]
                            : []),
                        {
                          key: 'share',
                          icon: <ShareAltOutlined />,
                          label: detailForSelected?.shareToken ? 'Share · link active' : 'Share…',
                          onClick: () => {
                            setHeaderMenuOpen(false);
                            setShareOpen(true);
                          },
                        },
                        { type: 'divider' },
                        {
                          key: 'delete',
                          icon: <DeleteOutlined />,
                          danger: true,
                          label: 'Delete',
                          onClick: () => {
                            setHeaderMenuOpen(false);
                            deleteMut.mutate({ id: selected.id, title: selected.title });
                          },
                        },
                      ],
                }}
              >
                <Button type="text" icon={<MoreOutlined />} title="More actions" />
              </Dropdown>
            </>
          )}
        </div>

        {selected && !selectedTrashed && !composing && (
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
              {placeholder === 'queued' && (
                <div className="chat-queued-state">
                  <div className="chat-queued-dots" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </div>
                  <div className="chat-queued-title">{PENDING_SLOT_TITLE}</div>
                  <div className="chat-queued-desc">{slotWaitDescription}</div>
                </div>
              )}
              {/* An unvisited session's history is still in flight: hold the shape of a
                  conversation instead of a blank pane. */}
              {placeholder === 'skeleton' && <TranscriptSkeleton />}
              <SessionNavCtx.Provider value={(rawId) => navigate(`/sessions/${encodeId(rawId)}`)}>
                <EventFullCtx.Provider value={fetchEventFull}>
                  <AuthErrorCtx.Provider value={authErrorHelp}>
                    <AutoRetryCtx.Provider value={autoRetryHelp}>
                      <Transcript events={events} live={live} turnImages={turnImages} artifactSessionId={selectedId} />
                    </AutoRetryCtx.Provider>
                  </AuthErrorCtx.Provider>
                </EventFullCtx.Provider>
              </SessionNavCtx.Provider>
              {selected &&
                !selectedTrashed &&
                sessionRunStateOf(selectedSession ?? selected) === 'QUEUED' &&
                events.length > 0 && (
                <div className="chat-note chat-slot-wait">
                  <span>{PENDING_SLOT_TITLE}</span>
                  <span>{slotWaitDescription}</span>
                </div>
              )}
              {localStatusCards.map((card) => (
                <SessionStatusCard card={card} key={card.id} />
              ))}
              {streamingThink && <div className="chat-think-stream chat-streaming">💭 {streamingThink}</div>}
              {streamingText && <StreamingMessage text={streamingText} />}
              {!selectedTrashed && approvals.map((a, i) => (
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
              {!selectedTrashed && queued.map((q) => (
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
                  {/* Same Markdown render as the settled bubble it becomes (see UserBubble), so a
                      message doesn't change shape when the runner picks it up. A queued `!cmd`
                      shows the command verbatim — markdown would mangle its shell syntax. */}
                  {q.shell ? (
                    <code className="chat-queued-cmd">!{q.content}</code>
                  ) : (
                    q.content && <MD breaks>{q.content}</MD>
                  )}
                  <span className="chat-queued-meta">
                    <span className="chat-queued-tag">Queued</span>
                    <a onClick={() => cancelQueued(q.turnId)}>Cancel</a>
                  </span>
                </div>
              ))}
              {placeholder === 'waiting' && <div className="chat-note">Waiting for the agent…</div>}
              {selected &&
                selectedTrashed &&
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
                      In Trash{when}.{' '}
                      {selectedCanRestore ? (
                        <a onClick={() => requestRestore(selected)}>Restore to Open</a>
                      ) : (
                        <span title="Restore unavailable right now">Restore unavailable</span>
                      )}
                      {' · '}
                      <a onClick={() => confirmPurge({ id: selected.id, title: selected.title })}>
                        Delete permanently
                      </a>
                    </div>
                  );
                })()}
              {selected && sameSessionSendBlocked && (
                <div className="chat-note">{sameSessionSendBlockedCopy}</div>
              )}
              {selected &&
                !selectedTrashed &&
                isSessionTerminal(selectedSession ?? selected) && (
                <div className="chat-note">
                  {sessionEndedBanner(
                    selectedSession ?? selected,
                    !!resumable,
                    !!runner.online,
                    !resumable ? selectedResumeBlockedCopy : null,
                  )}
                </div>
              )}
            </div>
          ) : composing ? (
            // The provider hero is centered as a hero only while it's alone: .agent-draft is a
            // centering flex row, so once /status prints a card it would sit beside the hero instead
            // of under it. With cards the pane falls back to plain transcript flow.
            <div
              className={`agent-sessions${localStatusCards.length ? '' : ' agent-draft'}`}
              ref={scrollRef}
            >
              <NewSessionProviderHero
                current={currentProviderChoiceForDraft}
                choices={providerChoicesForRunner}
                onPick={pickDraftProvider}
                runnerId={runner.id}
                // Nothing to choose until we know which agent (and so which project) this runs in.
                disabled={!pickedAgent}
                note={providerSwitchNote}
              />
              {localStatusCards.map((card) => (
                <SessionStatusCard card={card} key={card.id} />
              ))}
            </div>
          ) : (
            <div className="agent-sessions" />
          )}
          {selectedId && (
            <SessionFind
              sessionId={selectedId}
              containerRef={scrollRef}
              loadOlder={loadOlder}
              hasOlder={hasOlderNow}
              oldestSeq={oldestSeqNow}
            />
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
        {/* Background processes the agent launched (Bash run_in_background) — invisible
            otherwise. Derived from this session's events; hidden when there are none. */}
        {selectedId && !selectedTrashed && (
          <BackgroundShellsTray events={events} live={live} serverShells={serverBgShells} />
        )}
        <SessionOutputs
          // Only the open session has a worktree to show. With nothing selected (new-session
          // draft, empty list) `keepPreviousData` still holds the previously-open session's
          // detail, which would render its stale branch/diff bar over a fresh draft — so gate
          // on selectedId rather than the placeholder-backed query data.
          detail={selectedId && !selectedTrashed && !selectedMissing ? detailForSelected : null}
          committed={!live}
          // A turn in flight (live but not awaiting input) leaves the branch in a transient
          // state — hold "Merge to main" until it finishes so we never merge half-done work.
          turnActive={isSessionTurnActive(selected, !!live, idle)}
          enabling={enableIsoMut.isPending}
          onEnableIsolation={
            detailForSelected?.agent?.id
              ? () => askEnableIsolation(detailForSelected.agent!.id)
              : undefined
          }
          merging={mergeMut.isPending}
          onMergeToMain={
            selectedId && detailForSelected?.branch
              ? (target?: string) =>
                  mergeMut.mutate({
                    id: selectedId,
                    title: selectedSession?.title ?? 'Untitled session',
                    target,
                  })
              : undefined
          }
          resolving={resolveMut.isPending}
          onResolveInSession={
            selectedId && detailForSelected?.branch
              ? (target: string) =>
                  resolveMut.mutate({
                    id: selectedId,
                    title: selectedSession?.title ?? 'Untitled session',
                    branch: detailForSelected.branch!,
                    target,
                  })
              : undefined
          }
          committing={commitMut.isPending}
          onCommit={
            selectedId && detailForSelected?.branch
              ? () =>
                  commitMut.mutate({
                    id: selectedId,
                    title: selectedSession?.title ?? 'Untitled session',
                  })
              : undefined
          }
          adopting={adoptMut.isPending}
          onAdopt={
            selectedId
              ? () =>
                  adoptMut.mutate({
                    id: selectedId,
                    title: selectedSession?.title ?? 'Untitled session',
                  })
              : undefined
          }
          // The shared checkout behind this console. Attached to the agent (not the session):
          // it's the machine's state, and every session here fails the same way when it's stuck.
          repoHealth={consoleAgentRepoHealth}
          cleaningRepo={repoCleanupMut.isPending}
          onCleanUpRepo={
            consoleAgentId && consoleAgentRepoHealth
              ? () => askCleanUpRepo(consoleAgentId, consoleAgentRepoHealth.root)
              : undefined
          }
        />
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
        <div className={shellMode ? 'composer-box composer-box-shell' : 'composer-box'}>
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
                  <span className="composer-slash-type">
                    {it.type === 'skill' ? 'skill' : it.type === 'local' ? 'local' : 'cmd'}
                  </span>
                  {it.agentId && <span className="composer-slash-type">project</span>}
                  {it.description && <span className="composer-slash-desc">{it.description}</span>}
                </div>
              ))}
            </div>
          )}
          {showMention && (
            <div className="composer-slash-menu" role="listbox">
              {mentionMatches.map((a, i) => (
                <div
                  key={a.id}
                  role="option"
                  aria-selected={i === mentionIdx}
                  className={`composer-slash-item${i === mentionIdx ? ' is-active' : ''}`}
                  // mousedown (not click) + preventDefault keeps focus in the textarea.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickMention(a.name);
                  }}
                  onMouseEnter={() => setMentionIndex(i)}
                >
                  <span className="composer-slash-name">@{a.name}</span>
                  <span className="composer-slash-type">agent</span>
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
          {/* In shell mode this stops being a menu: `trigger={[]}` makes the Dropdown an inert
              wrapper so the button below acts on its own onClick (leave shell mode) instead of
              opening the attachment menu. Nothing in that menu applies to a raw command anyway —
              and a mode you can enter needs a visible way out. */}
          <Dropdown
            trigger={shellMode ? [] : ['click']}
            placement="topLeft"
            disabled={composerDisabled}
            menu={{
              items: [
                {
                  key: 'command',
                  icon: <CodeOutlined />,
                  label: 'Command',
                  disabled: !runner.online || !slashItems.some((it) => it.type === 'command'),
                  onClick: () => insertSlash('command'),
                },
                {
                  key: 'skill',
                  icon: <ThunderboltOutlined />,
                  label: 'Skill',
                  disabled: !runner.online || !slashItems.some((it) => it.type === 'skill'),
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
                  label:
                    sameSessionSendBlocked || (!!selected && !live && !resumable)
                      ? 'Shell (session unavailable)'
                      : 'Shell',
                  disabled: sameSessionSendBlocked || (!!selected && !live && !resumable),
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
              className={shellMode ? 'composer-attach-btn composer-shell-btn' : 'composer-attach-btn'}
              type="text"
              icon={shellMode ? undefined : <PlusOutlined />}
              onClick={shellMode ? exitShell : undefined}
              disabled={composerDisabled}
              aria-label={shellMode ? 'Leave shell mode' : 'Add attachment'}
              title={shellMode ? 'Leave shell mode' : undefined}
            >
              {shellMode ? '❯' : null}
            </Button>
          </Dropdown>
          <Input.TextArea
            ref={taRef}
            className={shellMode ? 'composer-shell' : undefined}
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
              if (showMention && !e.nativeEvent.isComposing) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setMentionIndex((i) => (i + 1) % mentionMatches.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  pickMention(mentionMatches[mentionIdx].name);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setMentionDismissed(mentionToken);
                  return;
                }
              }
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
            <Tooltip title={sameSessionSendBlocked ? sameSessionSendBlockedCopy : ''}>
              <Button
                type="primary"
                icon={<ArrowUpOutlined />}
                disabled={!canSend}
                loading={send.isPending}
                onClick={onSend}
                aria-label="Send"
              />
            </Tooltip>
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
          <Tooltip
            title={configHint || shownModeSemantics?.note || 'Permission mode'}
            open={hoverTipOpen}
          >
            <span className="composer-pill">
              <Select
                size="small"
                variant="borderless"
                suffixIcon={null}
                value={shownMode}
                onChange={(v) => {
                  if (live) {
                    configMut.mutate({ permissionMode: MODE_TO_PERMISSION[v] });
                  } else {
                    modeSeedState.current = dirtyContextSeed(modelContextKey);
                    setMode(v);
                  }
                }}
                options={MODE_OPTIONS.map((m) => {
                  // A mode this engine cannot honor is still selectable — it is the user's stored
                  // intent, and it starts being enforced the moment the session moves to an engine
                  // that can. It just must not read as a guarantee it isn't: say so on the option,
                  // where the choice is made, exactly as the Auto constraint does below.
                  const semantics = permissionSemanticsFor(m);
                  const unenforced =
                    semantics && !semantics.honored
                      ? semantics.unapproved === 'allow'
                        ? ' — not enforced here, everything is allowed'
                        : ' — not enforced here, unapproved actions are denied'
                      : '';
                  return {
                    value: m,
                    // Carry the Auto-mode constraint on the greyed option itself, where it's
                    // actionable, instead of in a row-wide paragraph.
                    label:
                      m === 'Auto' && !autoOk
                        ? 'Auto (needs Opus 5, Fable 5, or Sonnet 5)'
                        : `${m}${unenforced}`,
                    disabled: m === 'Auto' && !autoOk,
                  };
                })}
                disabled={!configEditable}
                popupMatchSelectWidth={false}
              />
            </span>
          </Tooltip>
          <span className="composer-pill-spacer" />
          {providerSwitchChoices.length > 1 && (
            <Tooltip title={configHint || 'Provider'} open={hoverTipOpen}>
              <span className="composer-pill">
                <Select
                  size="small"
                  variant="borderless"
                  suffixIcon={null}
                  value={shownProvider}
                  onChange={(v) => {
                    // A provider this runner can't run isn't a switch — it's a request for the
                    // sign-in (or install) that would make it one. Go straight to that engine's
                    // row on the Providers page, as the New Session picker's row does. The Select
                    // is controlled, so the pill keeps showing the provider still in use.
                    const picked = providerSwitchChoices.find((c) => c.slug === v);
                    if (picked?.unavailable) {
                      navigate(
                        `/providers?runner=${encodeId(runner.id)}&engine=${picked.fixEngine ?? picked.slug}`,
                      );
                      return;
                    }
                    // Each provider owns its model space, so carry the running model only when
                    // the new one offers it (two Anthropic accounts do; a third-party endpoint
                    // with its own list does not) and otherwise take that provider's default.
                    // Mode and effort follow the model, exactly as a model switch makes them.
                    const nextModel = modelOptionsForProvider(
                      v,
                      runner.modelCatalog,
                      configuredProviders,
                    ).some((option) => option.value === shownModel)
                      ? shownModel
                      : defaultModelForProvider(
                          v,
                          runner.modelCatalog,
                          configuredProviders,
                          runner.runtimeDefaultModels,
                        );
                    const drop =
                      shownMode === 'Auto' && !supportsAuto(nextModel, v, configuredProviders);
                    const currentEffort = live ? effectiveEffort : effort;
                    const nextEffort = normalizeEffortForProvider(
                      v,
                      currentEffort,
                      nextModel,
                      runner.modelCatalog,
                    );
                    if (live) {
                      configMut.mutate({
                        provider: v,
                        ...(nextModel !== shownModel ? { model: nextModel } : {}),
                        ...(drop ? { permissionMode: 'default' } : {}),
                        ...(nextEffort !== currentEffort ? { effort: nextEffort } : {}),
                      });
                      return;
                    }
                    // Ended: hold the pick until the resume carries it, and move the pills that
                    // depend on it now — marking their seeds dirty, exactly as a manual Model or
                    // Mode edit does, so the seeding effect doesn't put the old values back.
                    setEndedProviderPick({ sessionId: selected!.id, provider: v });
                    if (nextModel !== shownModel) {
                      modelSeedState.current = dirtyContextSeed(modelContextKey);
                      setModel(nextModel);
                    }
                    if (drop) {
                      modeSeedState.current = dirtyContextSeed(modelContextKey);
                      setMode('Default');
                    }
                    if (nextEffort !== currentEffort) setEffort(nextEffort);
                  }}
                  options={providerSwitchChoices.map((choice) => {
                    // Carry the reason on the row itself, where it answers the question being
                    // asked ("why can't I pick Claude?"). It stays selectable rather than greyed
                    // because picking it does something useful — it goes where the fix is (see
                    // onChange), which is the New Session picker's behaviour for the same row.
                    // The running provider is exempt: it is the closed pill's own label, and a
                    // parenthetical there would sit in the footer of every turn.
                    const blocked = !!choice.unavailable && choice.slug !== shownProvider;
                    return {
                      value: choice.slug,
                      label: blocked
                        ? `${choice.label} — ${choice.unavailable}, sign in →`
                        : choice.label,
                      // Distinguishable at a glance from a provider that is ready to run, without
                      // being inert: the identity is dimmed, the call to action is not.
                      className: blocked ? 'composer-provider-fix' : undefined,
                    };
                  })}
                  disabled={!configEditable}
                  popupMatchSelectWidth={false}
                />
              </span>
            </Tooltip>
          )}
          <Tooltip
            title={
              !shownProviderCapabilitiesResolved
                ? 'Model will be resolved from the provider default'
                : configHint || 'Model'
            }
            open={hoverTipOpen}
          >
            <span className="composer-pill">
              <Select
                size="small"
                variant="borderless"
                suffixIcon={null}
                value={shownModel}
                onChange={(v) => {
                  // Switching to a model that can't do Auto while Auto is selected
                  // would send a mode claude rejects — snap back to Default.
                  const drop =
                    shownMode === 'Auto' && !supportsAuto(v, shownProvider, configuredProviders);
                  // An OpenCode variant is model-defined: a model switch can strip it.
                  const currentEffort = live ? effectiveEffort : effort;
                  const nextEffort = normalizeEffortForProvider(
                    shownProvider,
                    currentEffort,
                    v,
                    runner.modelCatalog,
                  );
                  const resetEffort = nextEffort !== currentEffort;
                  if (live) {
                    configMut.mutate({
                      model: v,
                      ...(drop ? { permissionMode: 'default' } : {}),
                      ...(resetEffort ? { effort: nextEffort } : {}),
                    });
                  } else {
                    modelSeedState.current = dirtyContextSeed(modelContextKey);
                    setModel(v);
                    if (drop) {
                      modeSeedState.current = dirtyContextSeed(modelContextKey);
                      setMode('Default');
                    }
                    if (resetEffort) setEffort(nextEffort);
                  }
                }}
                options={shownModelOptions}
                disabled={!configEditable || !shownProviderCapabilitiesResolved}
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
                  const normalized = normalizeEffortForProvider(
                    shownProvider,
                    v,
                    shownModel,
                    runner.modelCatalog,
                  );
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
              "—". Rightmost pill, to the right of plan usage. */}
          {!(shownProvider === 'opencode' && shownModel === '') && (
            <ContextWindowIndicator
              tokens={contextTokens}
              reportedWindow={reportedContextWindow}
              model={shownModel}
              provider={shownProvider}
              modelCatalog={runner.modelCatalog}
              configured={configuredProviders}
            />
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
