import { CloseOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Avatar, Button, Input, Spin } from 'antd';
import { useEffect, useState } from 'react';
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

  // Esc closes the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const addComment = useMutation({
    mutationFn: (body: string) => api(`/tasks/${taskId}/comments`, { method: 'POST', body: { body } }),
    onSuccess: () => {
      setDraft('');
      qc.invalidateQueries({ queryKey: ['task', taskId] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const submit = () => {
    const body = draft.trim();
    if (body) addComment.mutate(body);
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
                    <div className="tdp-comment-text">{c.body}</div>
                  </div>
                </div>
              ))
            )}
          </section>
        </div>
      )}

      <div className="tdp-compose">
        <Input.TextArea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="添加评论…  (⌘/Ctrl + Enter 发送)"
          autoSize={{ minRows: 1, maxRows: 4 }}
          onKeyDown={(e) => {
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
