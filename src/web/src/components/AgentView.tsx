import {
  ArrowUpOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  LoadingOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Input, Segmented, Select, Tag, Tooltip } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMatch, useNavigate } from 'react-router-dom';
import {
  api,
  createInteractiveSession,
  endSession,
  interruptSession,
  sendTurn,
  sessionEventsUrl,
} from '../api';
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
const MODE_OPTIONS = ['Plan', 'Accept Edits', 'Default'];
// UI label <-> claude --permission-mode. "Default" maps to dontAsk: a web session
// has no TTY to answer permission prompts, so a prompting mode would hang the turn.
const MODE_TO_PERMISSION: Record<string, string> = {
  Plan: 'plan',
  'Accept Edits': 'acceptEdits',
  Default: 'dontAsk',
};
const PERMISSION_TO_MODE: Record<string, string> = {
  plan: 'Plan',
  acceptEdits: 'Accept Edits',
  dontAsk: 'Default',
};
const MODEL_OPTIONS = [
  { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' },
  { value: 'claude-opus-4-8', label: 'claude-opus-4-8' },
  { value: 'claude-haiku-4-5', label: 'claude-haiku-4-5' },
];

const trunc = (s: string, n = 600): string => (s && s.length > n ? s.slice(0, n) + '…' : s);
const fmtTime = (d?: string): string =>
  d ? new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

function StatusIcon({ status }: { status: string }) {
  if (status === 'RUNNING') return <LoadingOutlined spin style={{ color: '#3370ff', fontSize: 16 }} />;
  if (status === 'SUCCEEDED') return <CheckCircleFilled style={{ color: '#2ea121', fontSize: 16 }} />;
  if (status === 'FAILED' || status === 'CANCELLED')
    return <CloseCircleFilled style={{ color: '#f54a45', fontSize: 16 }} />;
  return <span className="status-circle hollow" />;
}

export function AgentView({ runner }: { runner: Runner }) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  // The picked session lives in the URL (/agents/:id/sessions/:sessionId) so it
  // deep-links and survives a refresh; selecting a session = navigation.
  const selectedId = useMatch('/agents/:id/sessions/:sessionId')?.params.sessionId ?? null;
  const [text, setText] = useState('');
  const [mode, setMode] = useState('Default');
  const [model, setModel] = useState('claude-sonnet-4-6');
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [streamingText, setStreamingText] = useState(''); // live assistant text from text_delta
  const [idle, setIdle] = useState(false); // session is AWAITING_INPUT (a new turn is accepted)
  const seen = useRef<Set<number>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  const sessionsQ = useQuery({
    queryKey: ['sessions', runner.id],
    queryFn: () => api<any[]>(`/sessions?runnerId=${runner.id}`),
    refetchInterval: 4000,
  });

  const sessions = useMemo(
    () => (sessionsQ.data ?? []).slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    [sessionsQ.data],
  );
  const selected = useMemo(() => sessions.find((s) => s.id === selectedId) ?? null, [sessions, selectedId]);
  const live = selected ? !TERMINAL.includes(selected.status) : false;

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
    seen.current = new Set();
    setIdle(false);
    if (!selectedId) return;
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
        if (seen.current.has(ev.seq)) return;
        seen.current.add(ev.seq);
        setEvents((prev) => [...prev, ev]);
        // The authoritative full text (or a turn/user/interrupt boundary) supersedes
        // the live draft — clear it so the streamed text isn't rendered twice.
        if (['assistant', 'turn_end', 'user', 'interrupt'].includes(ev.type)) setStreamingText('');
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
  }, [events, streamingText]);

  const send = useMutation({
    mutationFn: async (content: string): Promise<string> => {
      // Continue a live session; otherwise (no selection, or the selected one has
      // ended) start a fresh session so the composer never dead-locks.
      if (selected && live) {
        await sendTurn(selected.id, content);
        return selected.id;
      }
      const created = await createInteractiveSession({
        prompt: content,
        assignedRunnerId: runner.id,
        model,
        permissionMode: MODE_TO_PERMISSION[mode],
      });
      return created.id;
    },
    onSuccess: (id) => {
      navigate(`/agents/${runner.id}/sessions/${id}`);
      setText('');
      setIdle(false); // a turn is now starting
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

  const onSend = (): void => {
    const c = text.trim();
    if (!c || send.isPending) return;
    send.mutate(c);
  };
  // While the selected session is still loading we can't tell if it's live yet;
  // block send to avoid accidentally creating a duplicate session.
  const loadingSession = !!selectedId && !selected;
  const canSend =
    !!text.trim() && !send.isPending && runner.online && !loadingSession && (live ? idle : true);
  // While a LIVE session is selected the selectors are read-only and show that
  // session's stored choice; otherwise they're editable and reflect local state.
  const shownModel: string = live ? (selected.model ?? 'claude-sonnet-4-6') : model;
  const shownMode: string = live
    ? (PERMISSION_TO_MODE[selected.permissionMode ?? 'dontAsk'] ?? 'Default')
    : mode;

  return (
    <div className="agent-view">
      <div className="agent-header">
        <span className={`agent-status-dot ${runner.online ? 'online' : ''}`} />
        <div className="agent-header-main">
          <div className="agent-name">{runner.displayName ?? runner.name}</div>
          <div className="agent-sub">
            {selected?.title ??
              (selectedId ? 'Starting…' : `${runner.online ? 'Online' : 'Offline'} · ${sessions.length} sessions`)}
          </div>
        </div>
        <div className="agent-header-spacer" />
        {selectedId && (
          <Button
            size="small"
            icon={<PlusOutlined />}
            onClick={() => {
              navigate(`/agents/${runner.id}`);
              setText('');
            }}
          >
            New session
          </Button>
        )}
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
          {events.map((e, i) => (
            <ChatEvent key={i} ev={e} />
          ))}
          {streamingText && <div className="chat-msg chat-assistant chat-streaming">{streamingText}</div>}
          {selected &&
            !TERMINAL.includes(selected.status) &&
            selected.status !== 'PENDING' &&
            events.length === 0 &&
            !streamingText && <div className="chat-note">Waiting for the agent…</div>}
          {selected && TERMINAL.includes(selected.status) && (
            <div className="chat-note">Session {selected.status.toLowerCase()}.</div>
          )}
        </div>
      ) : (
        <>
          <div className="session-head">Sessions</div>
          <div className="agent-sessions">
            {sessions.length === 0 && (
              <div className="chat-note">No sessions yet — send a message below to start one.</div>
            )}
            {sessions.map((s) => (
              <div className="session-row" key={s.id} onClick={() => navigate(`/agents/${runner.id}/sessions/${s.id}`)}>
                <span className="session-icon">
                  <StatusIcon status={s.status} />
                </span>
                <div className="session-main">
                  <div className="session-title">{s.title}</div>
                  <div className="session-meta">
                    {s.numTurns ?? 0} turns · ${(s.costUsd ?? 0).toFixed(2)}
                  </div>
                </div>
                <div className="session-right">
                  <div className="session-time">{fmtTime(s.createdAt)}</div>
                </div>
              </div>
            ))}
          </div>
        </>
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
        <Tooltip title="Mode & Model are chosen per session before it starts, and stay fixed for the session's life.">
          <div className="composer-controls">
            <span className="composer-label">Mode</span>
            <Segmented
              size="small"
              options={MODE_OPTIONS}
              value={shownMode}
              onChange={(v) => setMode(v as string)}
              disabled={live}
            />
            <span className="composer-label">Model</span>
            <Select
              size="small"
              value={shownModel}
              onChange={setModel}
              options={MODEL_OPTIONS}
              style={{ minWidth: 180 }}
              disabled={live}
            />
          </div>
        </Tooltip>
      </div>
    </div>
  );
}

function ChatEvent({ ev }: { ev: RunEvent }) {
  const p = ev.payload ?? {};
  switch (ev.type) {
    case 'user':
      return <div className="chat-msg chat-user">{p.text}</div>;
    case 'assistant':
      return p.text ? <div className="chat-msg chat-assistant">{p.text}</div> : null;
    case 'tool_use':
      return (
        <div className="chat-tool">
          🔧 <Tag>{p.name}</Tag> <code>{trunc(JSON.stringify(p.input))}</code>
        </div>
      );
    case 'tool_result':
      return (
        <div className="chat-tool-result">
          ↳ {trunc(typeof p.content === 'string' ? p.content : JSON.stringify(p.content))}
        </div>
      );
    case 'turn_end':
      return <div className="chat-turn-divider" />;
    case 'interrupt':
      return <div className="chat-note">⊘ interrupted</div>;
    case 'error':
      return <div className="chat-error">✖ {String(p.message)}</div>;
    default:
      return null; // system / status / text_delta are not rendered in the chat
  }
}
