import {
  AppstoreOutlined,
  ArrowUpOutlined,
  CheckCircleFilled,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleFilled,
  ControlOutlined,
  DeleteOutlined,
  DisconnectOutlined,
  LoadingOutlined,
  MessageOutlined,
  MinusCircleOutlined,
  MoreOutlined,
  PauseCircleOutlined,
  PlusOutlined,
  RobotOutlined,
  ThunderboltOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Dropdown, Input, type MenuProps, Segmented, Select, Tooltip } from 'antd';
import { type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useMatch, useNavigate } from 'react-router-dom';
import { decodeId, encodeId } from '../lib/idCodec';
import {
  api,
  type ApprovalInfo,
  archiveSession,
  cancelQueuedTurn,
  createInteractiveSession,
  decideApproval,
  deleteSession,
  endSession,
  interruptSession,
  listApprovals,
  listQueuedTurns,
  restoreSession,
  resumeSession,
  sendTurn,
  sessionEventsUrl,
  updateSessionConfig,
} from '../api';
import { StreamingMessage, Transcript } from './Transcript';
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

const TERMINAL = ['SUCCEEDED', 'FAILED', 'CANCELLED'];
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
  { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' },
  { value: 'claude-opus-4-8', label: 'claude-opus-4-8' },
  { value: 'claude-haiku-4-5', label: 'claude-haiku-4-5' },
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

// Shell-style composer history, kept per-agent in localStorage so the Up/Down arrows
// recall this agent's recently sent prompts. Stored oldest-first, newest last; capped
// so it can't grow without bound. Keyed by the agent the message goes to ('default'
// when none is picked yet).
const HISTORY_KEY_PREFIX = 'orbit.composerHistory:';
const HISTORY_MAX = 100;
const historyKey = (agentId?: string): string => `${HISTORY_KEY_PREFIX}${agentId ?? 'default'}`;
function loadHistory(agentId?: string): string[] {
  try {
    const arr = JSON.parse(localStorage.getItem(historyKey(agentId)) ?? '[]');
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function pushHistory(agentId: string | undefined, entry: string): void {
  const e = entry.trim();
  if (!e) return;
  const list = loadHistory(agentId);
  if (list[list.length - 1] === e) return; // skip if identical to the last sent
  list.push(e);
  while (list.length > HISTORY_MAX) list.shift();
  try {
    localStorage.setItem(historyKey(agentId), JSON.stringify(list));
  } catch {
    // ignore quota/serialization errors — history is best-effort
  }
}

const fmtTime = (d?: string): string =>
  d
    ? new Date(d).toLocaleString([], {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : '';

// One glyph per session state. Colour carries the meaning: blue = working,
// amber = needs a human decision, green = done, red = real failure, grey =
// neutral terminal (cancelled / interrupted / disconnected). A runner that went
// offline is reaped to FAILED with error 'runner offline'; that's a dropped
// connection, not a crash, so it gets the neutral disconnect glyph, not a red X.
function StatusIcon({ session }: { session: any }) {
  const status: string = session.status;
  const fontSize = 16;
  if (status === 'RUNNING') {
    return (session.pendingApprovals ?? 0) > 0 ? (
      <Tooltip title="Waiting for approval">
        <PauseCircleOutlined style={{ color: '#ff8800', fontSize }} />
      </Tooltip>
    ) : (
      <Tooltip title="Running">
        <LoadingOutlined spin style={{ color: '#3370ff', fontSize }} />
      </Tooltip>
    );
  }
  if (status === 'AWAITING_INPUT')
    return (
      <Tooltip title="Waiting for your reply">
        <MessageOutlined style={{ color: '#8c8c8c', fontSize }} />
      </Tooltip>
    );
  if (status === 'SUCCEEDED')
    return (
      <Tooltip title="Completed">
        <CheckCircleFilled style={{ color: '#2ea121', fontSize }} />
      </Tooltip>
    );
  if (status === 'FAILED') {
    const err: string = typeof session.error === 'string' ? session.error : '';
    if (err.toLowerCase().includes('offline'))
      return (
        <Tooltip title="Disconnected — runner went offline">
          <DisconnectOutlined style={{ color: '#8c8c8c', fontSize }} />
        </Tooltip>
      );
    return (
      <Tooltip title={err || 'Failed'}>
        <CloseCircleFilled style={{ color: '#f54a45', fontSize }} />
      </Tooltip>
    );
  }
  if (status === 'CANCELLED' || status === 'INTERRUPTED')
    return (
      <Tooltip title={status === 'CANCELLED' ? 'Cancelled' : 'Interrupted'}>
        <MinusCircleOutlined style={{ color: '#8c8c8c', fontSize }} />
      </Tooltip>
    );
  // PENDING — queued, not yet started
  return (
    <Tooltip title="Queued">
      <ClockCircleOutlined style={{ color: '#c9cdd4', fontSize }} />
    </Tooltip>
  );
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
  const [text, setText] = useState('');
  // Composer history cursor: -1 = editing the live draft; otherwise an index into the
  // agent's stored history. `histDraft` stashes what was typed before recall started,
  // so stepping back past the newest entry restores it (shell-style).
  const [histIdx, setHistIdx] = useState(-1);
  const [histDraft, setHistDraft] = useState('');
  const [mode, setMode] = useState('Default');
  const [model, setModel] = useState('claude-sonnet-4-6');
  const [effort, setEffort] = useState('');
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
  const seen = useRef<Set<number>>(new Set());
  // Per-session transcript cache (mount-scoped): switching seeds events from here for
  // an instant paint and resumes the SSE just past the cached seq, instead of replaying
  // each session's full history from seq 0 on every visit.
  const transcriptCache = useRef<Map<string, RunEvent[]>>(new Map());
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null); // the left session-list column, for arrow-key scrolling
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
  const sessionsQ = useQuery({
    queryKey: ['sessions', runner.id, effectiveView],
    queryFn: () => api<any[]>(`/sessions?runnerId=${runner.id}&view=${effectiveView}`),
    refetchInterval: 4000,
  });

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
  const live = selected ? !TERMINAL.includes(selected.status) : false;
  // An ended session can be revived (--resume claude's context) only if it actually
  // ran and its runner is online — the transcript lives on that machine's disk.
  const resumable = !!selected && !live && !!selected.startedAt && runner.online;
  // The session list (always visible in the left column) is scoped to one agent so
  // it reads as a conversation with that agent. On /agents/<id> that's the locked
  // agent; on a /sessions/<id> deep link the URL carries no agent, so fall back to
  // the selected session's own agent.
  const scopeAgentId = lockedAgentId ?? selected?.agent?.id ?? null;
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
    if (selectedId || composingRoute || view !== 'active' || !sessionsQ.isSuccess) return;
    const first = visibleSessions[0];
    if (first) navigate(`/sessions/${encodeId(first.id)}`, { replace: true });
  }, [selectedId, composingRoute, view, sessionsQ.isSuccess, visibleSessions, navigate]);

  // Up/Down arrows step through the session list (left column), switching the open
  // session like tabs. Skipped while typing in an input/textarea (so the composer and
  // Ant dropdowns keep their own arrows) and on the archived/trash tabs, whose rows
  // aren't openable. With nothing selected, Down enters from the top, Up from the bottom.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (!selectedId && view !== 'active' && view !== 'system') return;
      const el = document.activeElement;
      if (
        el instanceof HTMLElement &&
        (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
      )
        return;
      if (visibleSessions.length === 0) return;
      const cur = visibleSessions.findIndex((s) => s.id === selectedId);
      let next: number;
      if (cur === -1) next = e.key === 'ArrowDown' ? 0 : visibleSessions.length - 1;
      else {
        next = cur + (e.key === 'ArrowDown' ? 1 : -1);
        if (next < 0 || next >= visibleSessions.length) return; // stop at the ends
      }
      e.preventDefault();
      navigate(`/sessions/${encodeId(visibleSessions[next].id)}`);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visibleSessions, selectedId, view, navigate]);

  // Keep the highlighted row in view when arrowing through a long list.
  useEffect(() => {
    listRef.current?.querySelector('.session-row.active')?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  // Agents belonging to this machine runner — each is a project dir + coding tool.
  // Picking one tells the server where (which dir) to run a new session.
  const agentsQ = useQuery({ queryKey: ['agents'], queryFn: () => api<any[]>('/agents') });
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
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [events, streamingText, streamingThink, approvals, queued]);

  // Allow/deny a pending tool-permission request; optimistically drop it (the
  // approval_resolved SSE also removes it), re-fetching to resync on failure.
  const decide = async (
    approvalId: string,
    behavior: 'allow' | 'deny',
    answers?: Record<string, string[]>,
    message?: string,
  ): Promise<void> => {
    if (!selectedId) return;
    setApprovals((prev) => prev.filter((x) => x.id !== approvalId));
    try {
      await decideApproval(selectedId, approvalId, behavior, message, answers);
    } catch {
      listApprovals(selectedId)
        .then(setApprovals)
        .catch(() => undefined);
    }
  };

  const send = useMutation({
    mutationFn: async (content: string): Promise<{ id: string; queuedItem?: QueuedTurn }> => {
      // Continue a live session; revive an ended-but-resumable one (same row, claude
      // --resumes its context); otherwise (no selection, or unresumable) start a
      // fresh session so the composer never dead-locks.
      if (selected && live) {
        const res = await sendTurn(selected.id, content);
        // A turn already running ⇒ this message is queued (delivered once that turn
        // finishes); surface it as a pending bubble the user can withdraw. When idle
        // it's delivered right away, so it'll arrive via its own `user` event instead.
        const queuedItem = idle ? undefined : { turnId: res.turnId, content };
        return { id: selected.id, queuedItem };
      }
      if (selected && resumable) {
        // The pills were seeded from this session's stored config, so an untouched
        // send keeps it and an edited Mode/Model/Effort is re-applied on resume.
        await resumeSession(selected.id, content, {
          model,
          permissionMode: MODE_TO_PERMISSION[mode],
          effort: effort || undefined,
        });
        return { id: selected.id };
      }
      const created = await createInteractiveSession({
        prompt: content,
        assignedRunnerId: runner.id,
        agentId,
        model,
        permissionMode: MODE_TO_PERMISSION[mode],
        effort: effort || undefined,
      });
      return { id: created.id };
    },
    onSuccess: ({ id, queuedItem }) => {
      navigate(`/sessions/${encodeId(id)}`);
      setText('');
      setView('active'); // a new/continued session lives in the active list
      if (queuedItem) setQueued((q) => [...q, queuedItem]);
      else setIdle(false); // a turn is now starting
      qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (e: Error) => message.error(e.message),
  });
  const control = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'interrupt' | 'end' }) =>
      action === 'interrupt' ? interruptSession(id) : endSession(id),
    onSuccess: () => {
      // Both interrupt and end drop queued follow-ups server-side; mirror that locally.
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
      message.info('该消息已开始处理，无法撤回');
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
            撤销
          </a>
        </span>
      ),
      duration: 4,
    });
  };
  const archiveMut = useMutation({
    mutationFn: (id: string) => archiveSession(id),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ['sessions'] });
      showUndo(id, '已完成');
    },
    onError: (e: Error) => message.error(e.message),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteSession(id),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ['sessions'] });
      showUndo(id, '已删除');
    },
    onError: (e: Error) => message.error(e.message),
  });
  // Change a LIVE session's model / mode between turns. Optimistically patch the
  // cached session so the pill updates instantly; server-side the runner re-spawns
  // claude --resume with the new flag. Revert + surface the error on failure. Keyed on
  // effectiveView to match the (view-scoped) sessions query that renders the list.
  const configMut = useMutation({
    mutationFn: (cfg: { model?: string; permissionMode?: string }) =>
      updateSessionConfig(selected!.id, cfg),
    onMutate: async (cfg) => {
      await qc.cancelQueries({ queryKey: ['sessions', runner.id, effectiveView] });
      const prev = qc.getQueryData<any[]>(['sessions', runner.id, effectiveView]);
      qc.setQueryData<any[]>(['sessions', runner.id, effectiveView], (old) =>
        (old ?? []).map((s) => (s.id === selected!.id ? { ...s, ...cfg } : s)),
      );
      return { prev };
    },
    onError: (e: Error, _cfg, ctx) => {
      if (ctx?.prev) qc.setQueryData(['sessions', runner.id, effectiveView], ctx.prev);
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

  const onSend = (): void => {
    const c = text.trim();
    if (!c || send.isPending) return;
    pushHistory(shownAgentId, c);
    setHistIdx(-1);
    send.mutate(c);
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
    !!text.trim() &&
    !send.isPending &&
    runner.online &&
    !loadingSession &&
    (live ? SLOT_HELD.includes(selected.status) : true);

  // ── `/` command & skill autocomplete ──────────────────────────────────────
  // The runner reports its on-disk slash commands/skills via heartbeat (runner.commands
  // / runner.skills). Show them as a hint menu while the cursor sits on a `/token`
  // at the start of input or right after whitespace/newline, like the Claude Code TUI;
  // picking one replaces just that token with `/<name> ` (the trailing space drops the
  // regex match, so the menu auto-hides).
  const taRef = useRef<any>(null);
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
  // A LIVE session's pills show its stored choice (and Model/Mode are editable while
  // it's idle — see configEditable); otherwise they're editable and reflect local state.
  const shownModel: string = live ? (selected.model ?? 'claude-sonnet-4-6') : model;
  const shownMode: string = live
    ? (PERMISSION_TO_MODE[selected.permissionMode ?? 'dontAsk'] ?? 'Default')
    : mode;
  const shownEffort: string = live ? (selected.effort ?? '') : effort;
  // Auto is offered only on models that support it (see supportsAuto); the option
  // is greyed out otherwise so an unsupported model can't pick a mode claude rejects.
  const autoOk = supportsAuto(shownModel);
  // Model & Mode can be changed mid-session, but only between turns: the change
  // re-spawns claude, which would abort a turn in flight (and needs the runner online
  // to act on it). When not live they're freely editable (pre-session config).
  // Effort & Agent stay fixed once live.
  const configEditable = live ? idle && runner.online : true;
  // A live session's agent is fixed; otherwise reflect the local pick.
  const shownAgentId: string | undefined = live ? (selected.agent?.id ?? undefined) : agentId;
  // Switching agent or session leaves whatever history recall was in progress; reset
  // the cursor so the next Up starts fresh from the (per-agent) history.
  useEffect(() => {
    setHistIdx(-1);
  }, [shownAgentId, selectedId]);
  // Title shown above the session list (and in the draft header). /sessions/<id>
  // has no agent in the URL, so fall back to the open session's agent, then runner.
  const headAgentName =
    lockedAgent?.name ?? selected?.agent?.name ?? runner.displayName ?? runner.name;

  return (
    <div className="agent-split">
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
                  ? '没有已完成的会话。'
                  : view === 'system'
                    ? '没有系统会话。'
                    : '回收站为空。'}
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
              view === 'active'
                ? [
                    {
                      key: 'complete',
                      icon: <CheckCircleOutlined />,
                      label: ended ? 'Complete' : 'Complete & end session',
                      onClick: ({ domEvent }) => {
                        domEvent.stopPropagation();
                        archiveMut.mutate(s.id);
                      },
                    },
                    { type: 'divider' },
                    deleteItem,
                  ]
                : view === 'archived'
                  ? [restoreItem, { type: 'divider' }, deleteItem]
                  : view === 'system'
                    ? [deleteItem]
                    : [restoreItem];
            // System sessions are openable like active ones; archived/trash rows aren't.
            const openable = view === 'active' || view === 'system';
            return (
              <div
                className={`session-row${openable ? '' : ' no-open'}${s.id === selectedId ? ' active' : ''}${menuOpenId === s.id ? ' menu-open' : ''}`}
                key={s.id}
                onClick={openable ? () => navigate(`/sessions/${encodeId(s.id)}`) : undefined}
              >
                <span className="session-icon">
                  <StatusIcon session={s} />
                </span>
                <div className="session-main">
                  <div className="session-title">{s.title}</div>
                  <div className="session-meta">
                    {fmtTime(s.lastTurnAt ?? s.createdAt)} · {s.numTurns ?? 0} turns · $
                    {(s.costUsd ?? 0).toFixed(2)}
                  </div>
                </div>
                <div className="session-right">
                  <div className="session-actions" onClick={(e) => e.stopPropagation()}>
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
          <div className="agent-header-main">
            <div className="agent-name">
              {composing ? 'New session' : (selected?.title ?? (selectedId ? 'Starting…' : headAgentName))}
            </div>
            <div className="agent-sub">
              {composing
                ? `${headAgentName} · 新会话`
                : selected
                  ? `${selected.numTurns ?? 0} turns · $${(selected.costUsd ?? 0).toFixed(2)}`
                  : selectedId
                    ? 'Starting…'
                    : ''}
            </div>
          </div>
        </div>

        {selectedId ? (
          <div className="agent-sessions" ref={scrollRef}>
            {selected &&
              selected.status === 'PENDING' &&
              (queuedForSlot ? (
                <div className="chat-note">
                  排队中 · 运行器并发已满（{liveSlots}/{runner.maxConcurrent}），正在等待空闲槽位…
                </div>
              ) : (
                <div className="chat-note">Starting session…</div>
              ))}
            <Transcript events={events} live={live} />
            {streamingThink && <div className="chat-think-stream chat-streaming">💭 {streamingThink}</div>}
            {streamingText && <StreamingMessage text={streamingText} />}
            {approvals.map((a, i) => (
              // Only the first (oldest) pending card owns the ⌘/Ctrl+Enter shortcut; once
              // it's decided the next card becomes first, so the key walks the queue in order.
              <ApprovalPanel key={a.id} approval={a} onDecide={decide} active={i === 0} />
            ))}
            {queued.map((q) => (
              <div className="chat-msg chat-user chat-queued" key={q.turnId}>
                <span className="chat-queued-text">{q.content}</span>
                <span className="chat-queued-meta">
                  <span className="chat-queued-tag">排队中</span>
                  <a onClick={() => cancelQueued(q.turnId)}>撤回</a>
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
              <div className="chat-note">
                Session {selected.status.toLowerCase()}.
                {resumable
                  ? ' 发消息可续接这个会话。'
                  : runner.online
                    ? ' 发消息将新开一个会话。'
                    : ' 运行器离线，需上线后才能续接。'}
              </div>
            )}
          </div>
        ) : composing ? (
          <div className="agent-sessions agent-draft" ref={scrollRef}>
            <div className="chat-note">给这个 Agent 发一个任务，开始一个新会话。</div>
          </div>
        ) : (
          <div className="agent-sessions" />
        )}

      <div className="agent-composer">
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
          <Input.TextArea
            ref={taRef}
            variant="borderless"
            autoSize={{ minRows: 1, maxRows: 6 }}
            placeholder={
              !runner.online ? 'Runner offline' : selectedId ? 'Reply…' : '给这个 Agent 发一个任务…'
            }
            value={text}
            disabled={!runner.online}
            // Typing exits history recall: the next Up starts fresh from this draft.
            onChange={(e) => {
              setText(e.target.value);
              if (histIdx !== -1) setHistIdx(-1);
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
                  const list = loadHistory(shownAgentId);
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
                  const list = loadHistory(shownAgentId);
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
          {selected && live && (
            <>
              <Tooltip title="Stop the current turn">
                <Button size="small" onClick={() => control.mutate({ id: selected.id, action: 'interrupt' })}>
                  Stop
                </Button>
              </Tooltip>
              <Tooltip title="End the session">
                <Button size="small" danger onClick={() => control.mutate({ id: selected.id, action: 'end' })}>
                  End
                </Button>
              </Tooltip>
            </>
          )}
          <Button
            type="primary"
            icon={<ArrowUpOutlined />}
            disabled={!canSend}
            loading={send.isPending}
            onClick={onSend}
          />
        </div>
        <Tooltip title="Agent & Effort are fixed once a session starts. Model & Mode can be changed between turns — the session resumes with the new setting on your next message. Auto mode needs a recent model (Sonnet 4.6 / Opus 4.6+) and your org to allow it.">
          <div className="composer-pills">
            <span className="composer-pill">
              <AppstoreOutlined className="composer-pill-icon" />
              <Select
                size="small"
                variant="borderless"
                value={shownAgentId}
                onChange={setAgentId}
                options={agentsForRunner.map((a) => ({ value: a.id, label: a.name }))}
                placeholder="Default"
                disabled={live || !!lockedAgentId}
                popupMatchSelectWidth={false}
              />
            </span>
            <span className="composer-pill">
              <ControlOutlined className="composer-pill-icon" />
              <Select
                size="small"
                variant="borderless"
                value={shownMode}
                onChange={(v) =>
                  live ? configMut.mutate({ permissionMode: MODE_TO_PERMISSION[v] }) : setMode(v)
                }
                options={MODE_OPTIONS.map((m) => ({
                  value: m,
                  label: m,
                  disabled: m === 'Auto' && !autoOk,
                }))}
                disabled={!configEditable}
                popupMatchSelectWidth={false}
              />
            </span>
            <span className="composer-pill">
              <RobotOutlined className="composer-pill-icon" />
              <Select
                size="small"
                variant="borderless"
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
            <span className="composer-pill">
              <ThunderboltOutlined className="composer-pill-icon" />
              <Select
                size="small"
                variant="borderless"
                value={shownEffort}
                onChange={setEffort}
                options={EFFORT_OPTIONS}
                disabled={live}
                popupMatchSelectWidth={false}
              />
            </span>
          </div>
        </Tooltip>
      </div>
      </div>
    </div>
  );
}
