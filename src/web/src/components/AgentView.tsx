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
  PauseCircleOutlined,
  PlusOutlined,
  RobotOutlined,
  ThunderboltOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Input, Segmented, Select, Tooltip } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMatch, useNavigate } from 'react-router-dom';
import { decodeId, encodeId } from '../lib/idCodec';
import {
  api,
  type ApprovalInfo,
  archiveSession,
  createInteractiveSession,
  decideApproval,
  deleteSession,
  endSession,
  interruptSession,
  listApprovals,
  restoreSession,
  resumeSession,
  sendTurn,
  sessionEventsUrl,
  updateSessionConfig,
} from '../api';
import { Transcript } from './Transcript';
import { ApprovalPanel } from './ApprovalPanel';
import type { Runner } from './TasksSidePanel';

interface RunEvent {
  seq: number;
  type: string;
  payload: any;
  ts?: string;
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

const fmtTime = (d?: string): string =>
  d ? new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

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
  const [mode, setMode] = useState('Default');
  const [model, setModel] = useState('claude-sonnet-4-6');
  const [effort, setEffort] = useState('');
  // Which slice of the session list to show: active, archived, or trash.
  const [view, setView] = useState<'active' | 'archived' | 'deleted'>('active');
  const [agentId, setAgentId] = useState<string | undefined>(undefined);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [approvals, setApprovals] = useState<ApprovalInfo[]>([]); // pending tool-permission requests
  const [streamingText, setStreamingText] = useState(''); // live assistant text from text_delta
  const [streamingThink, setStreamingThink] = useState(''); // live thinking from thinking_delta
  const [idle, setIdle] = useState(false); // session is AWAITING_INPUT (a new turn is accepted)
  const seen = useRef<Set<number>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null); // the left session-list column, for arrow-key scrolling

  // The list is scoped by `view`. A selected session (its transcript is open) is
  // always resolved from the active set — that's where live sessions and the runner's
  // slot accounting live — so force `active` whenever one is open.
  const effectiveView = selectedId ? 'active' : view;
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
  const visibleSessions = useMemo(
    () => (scopeAgentId ? sessions.filter((s) => s.agent?.id === scopeAgentId) : sessions),
    [sessions, scopeAgentId],
  );

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
      if (!selectedId && view !== 'active') return;
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
    setEvents([]);
    setStreamingText('');
    setStreamingThink('');
    setApprovals([]);
    seen.current = new Set();
    setIdle(false);
    if (!selectedId) return;
    // Pending approvals aren't in the event stream (separate table) — fetch them so
    // a refresh/deep-link shows any request already awaiting a decision.
    listApprovals(selectedId)
      .then(setApprovals)
      .catch(() => undefined);
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let fails = 0;
    let lastSeq = 0;
    const stop = (): void => {
      closed = true;
      if (retry) clearTimeout(retry);
      es?.close();
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
        setEvents((prev) => [...prev, ev]);
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
        else if (ev.type === 'user') setIdle(false);
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
    connect();
    return stop;
  }, [selectedId]);

  // Polled fallback for idleness, in case an SSE turn_end was missed / reconnected.
  const runStatus: string | undefined = selected?.status;
  useEffect(() => {
    if (runStatus === 'AWAITING_INPUT') setIdle(true);
    else if (runStatus === 'RUNNING') setIdle(false);
  }, [runStatus]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [events, streamingText, streamingThink, approvals]);

  // Allow/deny a pending tool-permission request; optimistically drop it (the
  // approval_resolved SSE also removes it), re-fetching to resync on failure.
  const decide = async (approvalId: string, behavior: 'allow' | 'deny'): Promise<void> => {
    if (!selectedId) return;
    setApprovals((prev) => prev.filter((x) => x.id !== approvalId));
    try {
      await decideApproval(selectedId, approvalId, behavior);
    } catch {
      listApprovals(selectedId)
        .then(setApprovals)
        .catch(() => undefined);
    }
  };

  const send = useMutation({
    mutationFn: async (content: string): Promise<string> => {
      // Continue a live session; revive an ended-but-resumable one (same row, claude
      // --resumes its context); otherwise (no selection, or unresumable) start a
      // fresh session so the composer never dead-locks.
      if (selected && live) {
        await sendTurn(selected.id, content);
        return selected.id;
      }
      if (selected && resumable) {
        // The pills were seeded from this session's stored config, so an untouched
        // send keeps it and an edited Mode/Model/Effort is re-applied on resume.
        await resumeSession(selected.id, content, {
          model,
          permissionMode: MODE_TO_PERMISSION[mode],
          effort: effort || undefined,
        });
        return selected.id;
      }
      const created = await createInteractiveSession({
        prompt: content,
        assignedRunnerId: runner.id,
        agentId,
        model,
        permissionMode: MODE_TO_PERMISSION[mode],
        effort: effort || undefined,
      });
      return created.id;
    },
    onSuccess: (id) => {
      navigate(`/sessions/${encodeId(id)}`);
      setText('');
      setIdle(false); // a turn is now starting
      setView('active'); // a new/continued session lives in the active list
      qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (e: Error) => message.error(e.message),
  });
  const control = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'interrupt' | 'end' }) =>
      action === 'interrupt' ? interruptSession(id) : endSession(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
    onError: (e: Error) => message.error(e.message),
  });
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

  const onSend = (): void => {
    const c = text.trim();
    if (!c || send.isPending) return;
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
  const canSend =
    !!text.trim() && !send.isPending && runner.online && !loadingSession && (live ? idle : true);
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
  // Title shown above the session list (and in the draft header). /sessions/<id>
  // has no agent in the URL, so fall back to the open session's agent, then runner.
  const headAgentName =
    lockedAgent?.name ?? selected?.agent?.name ?? runner.displayName ?? runner.name;

  return (
    <div className="agent-split">
      <aside className="session-col">
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
          value={selectedId ? 'active' : view}
          disabled={!!selectedId}
          onChange={(v) => setView(v as 'active' | 'archived' | 'deleted')}
          options={[
            { label: '进行中', value: 'active' },
            { label: '已完成', value: 'archived' },
            { label: '回收站', value: 'deleted' },
          ]}
        />
        <div className="agent-sessions session-col-list" ref={listRef}>
          {visibleSessions.length === 0 && (
            <div className="chat-note">
              {view === 'active'
                ? 'No sessions yet.'
                : view === 'archived'
                  ? '没有已完成的会话。'
                  : '回收站为空。'}
            </div>
          )}
          {visibleSessions.map((s) => {
            const ended = TERMINAL.includes(s.status);
            return (
              <div
                className={`session-row${view === 'active' ? '' : ' no-open'}${s.id === selectedId ? ' active' : ''}`}
                key={s.id}
                onClick={view === 'active' ? () => navigate(`/sessions/${encodeId(s.id)}`) : undefined}
              >
                <span className="session-icon">
                  <StatusIcon session={s} />
                </span>
                <div className="session-main">
                  <div className="session-title">{s.title}</div>
                  <div className="session-meta">
                    {s.numTurns ?? 0} turns · ${(s.costUsd ?? 0).toFixed(2)}
                  </div>
                </div>
                <div className="session-right">
                  <div className="session-time">{fmtTime(s.lastTurnAt ?? s.createdAt)}</div>
                  <div className="session-actions" onClick={(e) => e.stopPropagation()}>
                    {view === 'active' && (
                      <>
                        <Tooltip title={ended ? 'Complete' : '结束会话后才能完成'}>
                          <Button
                            size="small"
                            type="text"
                            icon={<CheckCircleOutlined />}
                            disabled={!ended}
                            onClick={() => archiveMut.mutate(s.id)}
                          />
                        </Tooltip>
                        <Tooltip title={ended ? 'Delete' : '结束会话后才能删除'}>
                          <Button
                            size="small"
                            type="text"
                            danger
                            icon={<DeleteOutlined />}
                            disabled={!ended}
                            onClick={() => deleteMut.mutate(s.id)}
                          />
                        </Tooltip>
                      </>
                    )}
                    {view === 'archived' && (
                      <>
                        <Tooltip title="Restore">
                          <Button
                            size="small"
                            type="text"
                            icon={<UndoOutlined />}
                            onClick={() => restoreMut.mutate(s.id)}
                          />
                        </Tooltip>
                        <Tooltip title="Delete">
                          <Button
                            size="small"
                            type="text"
                            danger
                            icon={<DeleteOutlined />}
                            onClick={() => deleteMut.mutate(s.id)}
                          />
                        </Tooltip>
                      </>
                    )}
                    {view === 'deleted' && (
                      <Tooltip title="Restore">
                        <Button
                          size="small"
                          type="text"
                          icon={<UndoOutlined />}
                          onClick={() => restoreMut.mutate(s.id)}
                        />
                      </Tooltip>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </aside>

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
            {streamingText && <div className="chat-msg chat-assistant chat-streaming">{streamingText}</div>}
            {approvals.map((a) => (
              <ApprovalPanel key={a.id} approval={a} onDecide={decide} />
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
          <Input.TextArea
            variant="borderless"
            autoSize={{ minRows: 1, maxRows: 6 }}
            placeholder={
              !runner.online ? 'Runner offline' : selectedId ? 'Reply…' : '给这个 Agent 发一个任务…'
            }
            value={text}
            disabled={!runner.online}
            onChange={(e) => setText(e.target.value)}
            onPressEnter={(e) => {
              if (!e.shiftKey) {
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
