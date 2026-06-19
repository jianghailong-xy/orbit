import { CloseOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Avatar, Button, Input, Spin } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { encodeId } from '../lib/idCodec';

// TaskStatus (OPEN/IN_PROGRESS/DONE/CANCELLED) -> header badge label + tone.
const STATUS_META: Record<string, { label: string; tone: string }> = {
  OPEN: { label: 'Open', tone: 'muted' },
  IN_PROGRESS: { label: 'In progress', tone: 'blue' },
  DONE: { label: 'Done', tone: 'green' },
  CANCELLED: { label: 'Cancelled', tone: 'muted' },
};

const fmt = (d?: string | null): string =>
  d
    ? new Date(d).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '—';

const initial = (name?: string | null): string => (name ?? '?').trim().charAt(0).toUpperCase();

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The list row passed in for an instant header render before /tasks/:id resolves.
export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  creatorName?: string | null;
  assignee?: { id: string; name: string } | null;
  createdAt?: string;
  dueDate?: string | null;
}

interface AgentRow {
  id: string;
  name: string;
  runnerId?: string | null;
}

export function TaskDetailPanel({
  taskId,
  summary,
  onClose,
}: {
  taskId: string;
  summary?: TaskSummary;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const [draft, setDraft] = useState('');

  // /tasks/:id carries the full detail (description, comments, sessions) that the
  // list row lacks; show `summary` meanwhile so the header doesn't flash.
  const q = useQuery({ queryKey: ['task', taskId], queryFn: () => api<any>(`/tasks/${taskId}`) });
  const task = q.data ?? summary;

  // Owner's agents, for @-mention autocomplete and to label/trigger mentions.
  const agentsQ = useQuery({ queryKey: ['agents'], queryFn: () => api<AgentRow[]>('/agents') });
  const agentList = useMemo(() => agentsQ.data ?? [], [agentsQ.data]);

  // Esc closes the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Tell the user which mentioned agents got triggered (those bound to a runner can
  // actually run; the rest are recorded on the comment but not started).
  const notifyMentions = (ids: string[]) => {
    if (!ids.length) return;
    const picked = agentList.filter((a) => ids.includes(a.id));
    const triggerable = picked.filter((a) => a.runnerId);
    const noRunner = picked.filter((a) => !a.runnerId);
    const parts: string[] = [];
    if (triggerable.length) parts.push(`已通知并触发 ${triggerable.map((a) => a.name).join('、')}`);
    if (noRunner.length)
      parts.push(`${noRunner.map((a) => a.name).join('、')} 未绑定 runner，仅记录未触发`);
    if (parts.length) message.info(parts.join('；'));
  };

  const addComment = useMutation({
    mutationFn: (vars: { body: string; mentions: string[] }) =>
      api(`/tasks/${taskId}/comments`, { method: 'POST', body: vars }),
    onSuccess: (_data, vars) => {
      setDraft('');
      setCaret(0);
      qc.invalidateQueries({ queryKey: ['task', taskId] });
      notifyMentions(vars.mentions);
    },
    onError: (e: Error) => message.error(e.message),
  });

  // An agent is mentioned when `@<name>` appears as a standalone token in the body.
  const mentionTokenRe = (name: string) => new RegExp(`(?:^|\\s)@${escapeRegExp(name)}(?![\\w])`);
  const submit = () => {
    const body = draft.trim();
    if (!body) return;
    const mentions = agentList.filter((a) => mentionTokenRe(a.name).test(body)).map((a) => a.id);
    addComment.mutate({ body, mentions });
  };

  // ── `@` mention autocomplete ───────────────────────────────────────────────
  // Mirrors the composer's `/` command menu (AgentView): while the caret sits right
  // after an `@token`, show owned agents; picking one inserts `@<name> ` (the trailing
  // space drops the token regex, so the menu auto-hides).
  const taRef = useRef<any>(null);
  const [caret, setCaret] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const mentionToken = useMemo(() => {
    const before = draft.slice(0, caret);
    const m = /(?:^|\s)@([^\s@]*)$/.exec(before);
    return m ? m[1] : null;
  }, [draft, caret]);
  const mentionMatches = useMemo(() => {
    if (mentionToken === null) return [];
    const query = mentionToken.toLowerCase();
    return agentList
      .filter((a) => a.name.toLowerCase().includes(query))
      .sort((a, b) => {
        const pa = a.name.toLowerCase().startsWith(query) ? 0 : 1;
        const pb = b.name.toLowerCase().startsWith(query) ? 0 : 1;
        return pa - pb || a.name.localeCompare(b.name);
      })
      .slice(0, 8);
  }, [agentList, mentionToken]);
  useEffect(() => {
    setMentionIndex(0);
    setMentionDismissed(false);
  }, [mentionToken]);
  const showMention = mentionToken !== null && !mentionDismissed && mentionMatches.length > 0;
  const mentionIdx = mentionMatches.length ? Math.min(mentionIndex, mentionMatches.length - 1) : 0;

  const pickMention = (agent: AgentRow) => {
    const before = draft.slice(0, caret).replace(/(^|\s)@([^\s@]*)$/, `$1@${agent.name} `);
    const next = before + draft.slice(caret);
    setDraft(next);
    setMentionDismissed(false);
    setTimeout(() => {
      const ta: HTMLTextAreaElement | undefined = taRef.current?.resizableTextArea?.textArea;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(before.length, before.length);
      }
      setCaret(before.length);
    }, 0);
  };

  // Wrap each standalone `@<owned agent name>` in the body with a mention chip. Longer
  // names first so "@Bot2" wins over "@Bot"; the trailing `(?![\w])` blocks substrings.
  const mentionNames = useMemo(
    () => agentList.map((a) => a.name).filter(Boolean).sort((a, b) => b.length - a.length),
    [agentList],
  );
  const renderBody = (body: string): React.ReactNode => {
    if (!mentionNames.length) return body;
    const re = new RegExp(`@(?:${mentionNames.map(escapeRegExp).join('|')})(?![\\w])`, 'g');
    const out: React.ReactNode[] = [];
    let last = 0;
    let key = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      if (m.index > last) out.push(body.slice(last, m.index));
      out.push(
        <span key={key++} className="tdp-mention">
          {m[0]}
        </span>,
      );
      last = m.index + m[0].length;
    }
    if (last < body.length) out.push(body.slice(last));
    return out;
  };

  const status = STATUS_META[task?.status as string] ?? { label: task?.status ?? '', tone: 'muted' };
  const comments = q.data?.comments ?? [];
  const sessions = q.data?.sessions ?? [];

  return (
    <aside className="task-detail-panel">
      <div className="tdp-head">
        <div className="tdp-head-main">
          <div className="tdp-title">{task?.title ?? 'Loading…'}</div>
          <div className="tdp-meta">
            <span className={`tdp-badge tone-${status.tone}`}>{status.label}</span>
            {task?.assignee && (
              <span className="tdp-meta-item">
                <Avatar size={18} style={{ background: '#e1eaff', color: '#3370ff', fontSize: 10 }}>
                  {initial(task.assignee.name)}
                </Avatar>
                {task.assignee.name}
              </span>
            )}
            {task?.createdAt && <span className="tdp-meta-item muted">· {fmt(task.createdAt)}</span>}
          </div>
        </div>
        <Button type="text" icon={<CloseOutlined />} onClick={onClose} aria-label="Close" />
      </div>

      {q.isLoading ? (
        <div className="tdp-loading">
          <Spin />
        </div>
      ) : q.isError ? (
        <div className="tdp-empty">无法加载任务详情。</div>
      ) : (
        <div className="tdp-body">
          <section className="tdp-section">
            <div className="tdp-section-title">详情</div>
            <div className="tdp-field">
              <span className="tdp-field-label">负责 Agent</span>
              <span className="tdp-field-value">{task?.assignee?.name ?? '—'}</span>
            </div>
            <div className="tdp-field">
              <span className="tdp-field-label">创建人</span>
              <span className="tdp-field-value">{summary?.creatorName ?? '—'}</span>
            </div>
            <div className="tdp-field">
              <span className="tdp-field-label">创建时间</span>
              <span className="tdp-field-value">{fmt(task?.createdAt)}</span>
            </div>
            <div className="tdp-field">
              <span className="tdp-field-label">截止时间</span>
              <span className="tdp-field-value">{fmt(task?.dueDate)}</span>
            </div>
          </section>

          {q.data?.description && (
            <section className="tdp-section">
              <div className="tdp-section-title">描述</div>
              <div className="tdp-prose">{q.data.description}</div>
            </section>
          )}

          <section className="tdp-section">
            <div className="tdp-section-title">运行 ({sessions.length})</div>
            {sessions.length === 0 ? (
              <div className="tdp-muted">暂无关联运行</div>
            ) : (
              sessions.map((s: any) => (
                <Link key={s.id} to={`/sessions/${encodeId(s.id)}`} className="tdp-session">
                  <span className={`tdp-dot ${s.status}`} />
                  <span className="tdp-session-title">{s.title || '未命名会话'}</span>
                  <span className="tdp-session-status">{s.status}</span>
                </Link>
              ))
            )}
          </section>

          <section className="tdp-section">
            <div className="tdp-section-title">评论 ({comments.length})</div>
            {comments.length === 0 ? (
              <div className="tdp-muted">还没有评论</div>
            ) : (
              comments.map((c: any) => (
                <div key={c.id} className="tdp-comment">
                  <Avatar
                    size={24}
                    style={{ background: '#e1eaff', color: '#3370ff', fontSize: 11, flex: 'none' }}
                  >
                    {initial(c.authorName)}
                  </Avatar>
                  <div className="tdp-comment-body">
                    <div className="tdp-comment-head">
                      <span className="tdp-comment-author">{c.authorName ?? '未知'}</span>
                      <span className="tdp-comment-time">{fmt(c.createdAt)}</span>
                    </div>
                    <div className="tdp-comment-text">{renderBody(c.body)}</div>
                  </div>
                </div>
              ))
            )}
          </section>
        </div>
      )}

      <div className="tdp-compose">
        {showMention && (
          <div className="tdp-mention-menu">
            {mentionMatches.map((a, i) => (
              <div
                key={a.id}
                className={`tdp-mention-item ${i === mentionIdx ? 'active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickMention(a);
                }}
                onMouseEnter={() => setMentionIndex(i)}
              >
                <Avatar
                  size={18}
                  style={{ background: '#e1eaff', color: '#3370ff', fontSize: 10, flex: 'none' }}
                >
                  {initial(a.name)}
                </Avatar>
                <span className="tdp-mention-name">{a.name}</span>
                {!a.runnerId && <span className="tdp-mention-norunner">无 runner</span>}
              </div>
            ))}
          </div>
        )}
        <Input.TextArea
          ref={taRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
          }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          placeholder="添加评论…  输入 @ 提及 agent  (⌘/Ctrl + Enter 发送)"
          autoSize={{ minRows: 1, maxRows: 4 }}
          onKeyDown={(e) => {
            if (showMention) {
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
              if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                pickMention(mentionMatches[mentionIdx]);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setMentionDismissed(true);
                return;
              }
            }
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />
        <Button type="primary" onClick={submit} loading={addComment.isPending} disabled={!draft.trim()}>
          发送
        </Button>
      </div>
    </aside>
  );
}
