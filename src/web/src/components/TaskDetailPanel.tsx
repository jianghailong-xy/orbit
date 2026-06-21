import { CheckOutlined, CloseOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Avatar, Button, Input, Select, Spin, Switch, Tooltip } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { api } from '../api';
import { encodeId } from '../lib/idCodec';

// TaskStatus (OPEN/IN_PROGRESS/DONE/CANCELLED/FAILED) -> header badge label + tone.
const STATUS_META: Record<string, { label: string; tone: string }> = {
  OPEN: { label: 'Open', tone: 'muted' },
  IN_PROGRESS: { label: 'In progress', tone: 'blue' },
  DONE: { label: 'Done', tone: 'green' },
  CANCELLED: { label: 'Cancelled', tone: 'muted' },
  FAILED: { label: 'Failed', tone: 'red' },
};

// RunStatus (session.status) -> a single run's badge label + tone. The task header uses
// STATUS_META; a run's enum is different (PENDING/RUNNING/SUCCEEDED/FAILED/CANCELLED/
// AWAITING_INPUT/INTERRUPTED). AWAITING_INPUT means the turn finished and the agent is
// waiting on you, so it gets a distinct amber tone rather than a neutral grey.
const RUN_STATUS_META: Record<string, { label: string; tone: string }> = {
  PENDING: { label: '排队中', tone: 'muted' },
  RUNNING: { label: '运行中', tone: 'blue' },
  SUCCEEDED: { label: '已完成', tone: 'green' },
  FAILED: { label: '失败', tone: 'red' },
  CANCELLED: { label: '已取消', tone: 'muted' },
  AWAITING_INPUT: { label: '等待回复', tone: 'amber' },
  INTERRUPTED: { label: '已中断', tone: 'muted' },
  // Ended but resumable (idle/task-done recycle or user-ended) — dormant, not cancelled.
  PARKED: { label: '休眠', tone: 'muted' },
};

// The task counts as "执行中" only while one of its sessions is actually working:
// queued for a runner slot (PENDING) or running (RUNNING). AWAITING_INPUT and
// INTERRUPTED are idle states — the agent finished its turn and is waiting (grey
// icons in AgentView), so the run is over and 开始执行 should be re-enabled.
const BUSY_SESSION_STATUSES = new Set(['PENDING', 'RUNNING']);
const isSessionBusy = (status?: string): boolean => !!status && BUSY_SESSION_STATUSES.has(status);

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

// rehype plugin: after the comment markdown is parsed, wrap each standalone
// `@<owned agent name>` in a text node with a `.tdp-mention` chip. Skips code/pre
// so mentions inside code spans stay literal. `names` is sorted longest-first so
// "@Bot2" wins over "@Bot"; the trailing `(?![\w])` blocks substrings.
const rehypeMentions = (names: string[]) => () => (tree: any) => {
  if (!names.length) return;
  const re = new RegExp(`@(?:${names.map(escapeRegExp).join('|')})(?![\\w])`, 'g');
  const splitText = (value: string): any[] => {
    re.lastIndex = 0;
    const out: any[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(value)) !== null) {
      if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) });
      out.push({
        type: 'element',
        tagName: 'span',
        properties: { className: ['tdp-mention'] },
        children: [{ type: 'text', value: m[0] }],
      });
      last = m.index + m[0].length;
    }
    if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
    return out.length ? out : [{ type: 'text', value }];
  };
  const walk = (node: any) => {
    if (!Array.isArray(node.children)) return;
    const next: any[] = [];
    for (const child of node.children) {
      if (child.type === 'text') {
        next.push(...splitText(child.value));
      } else {
        if (child.type === 'element' && child.tagName !== 'code' && child.tagName !== 'pre') {
          walk(child);
        }
        next.push(child);
      }
    }
    node.children = next;
  };
  walk(tree);
};

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
  const q = useQuery({
    queryKey: ['task', taskId],
    queryFn: () => api<any>(`/tasks/${taskId}`),
    // While the task has a busy (queued/running) session, poll so the 开始执行 button
    // leaves its running state once the run ends; stay idle otherwise.
    refetchInterval: (query) =>
      (query.state.data?.sessions ?? []).some((s: any) => isSessionBusy(s.status)) ? 4000 : false,
  });
  const task = q.data ?? summary;

  // Owner's agents, for @-mention autocomplete and to label/trigger mentions.
  const agentsQ = useQuery({ queryKey: ['agents'], queryFn: () => api<AgentRow[]>('/agents') });
  const agentList = useMemo(() => agentsQ.data ?? [], [agentsQ.data]);

  // Owner's task lists, to move this task into a list (or detach it to 未分组).
  const taskListsQ = useQuery({
    queryKey: ['task-lists'],
    queryFn: () => api<{ id: string; title: string }[]>('/task-lists'),
  });

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

  // Reassign (or clear, when null) the task's responsible agent. Refresh both the
  // open detail and the list row that shows the assignee.
  const updateAssignee = useMutation({
    mutationFn: (assigneeId: string | null) =>
      api(`/tasks/${taskId}`, { method: 'PATCH', body: { assigneeId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['task', taskId] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  // Move the task into a list (string) or detach it to 未分组 (null). Refresh the panel,
  // the list rows, and the sidebar's per-list / 未分组 counts.
  const updateList = useMutation({
    mutationFn: (listId: string | null) =>
      api(`/tasks/${taskId}`, { method: 'PATCH', body: { listId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['task', taskId] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['task-lists'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  // "开始执行": tell the task's responsible agent to start (or continue) a session on it.
  // The backend validates assignee + runner; refresh the panel so the new run shows up.
  const execute = useMutation({
    mutationFn: () => api(`/tasks/${taskId}/execute`, { method: 'POST' }),
    onSuccess: () => {
      message.success('已触发负责 Agent 开始执行');
      qc.invalidateQueries({ queryKey: ['task', taskId] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  // All tasks, to pick prerequisites from (excludes this task + ones already added).
  const allTasksQ = useQuery({ queryKey: ['tasks'], queryFn: () => api<any[]>('/tasks') });

  // After any dependency/auto-run/mark-done change, refresh this panel and the list (its
  // lock indicators and the picker's task statuses both derive from the same data).
  const refreshTaskViews = () => {
    qc.invalidateQueries({ queryKey: ['task', taskId] });
    qc.invalidateQueries({ queryKey: ['tasks'] });
  };

  const addDependency = useMutation({
    mutationFn: (dependsOnTaskId: string) =>
      api(`/tasks/${taskId}/dependencies`, { method: 'POST', body: { dependsOnTaskId } }),
    onSuccess: refreshTaskViews,
    onError: (e: Error) => message.error(e.message),
  });

  const removeDependency = useMutation({
    mutationFn: (dependsOnTaskId: string) =>
      api(`/tasks/${taskId}/dependencies/${dependsOnTaskId}`, { method: 'DELETE' }),
    onSuccess: refreshTaskViews,
    onError: (e: Error) => message.error(e.message),
  });

  const setAutoRun = useMutation({
    mutationFn: (autoRunWhenReady: boolean) =>
      api(`/tasks/${taskId}`, { method: 'PATCH', body: { autoRunWhenReady } }),
    onSuccess: refreshTaskViews,
    onError: (e: Error) => message.error(e.message),
  });

  // Safety net for the "agent forgot to mark DONE" case (see §6.3): mark the task done
  // so its waiting dependents are released (and auto-run).
  const markDone = useMutation({
    mutationFn: () => api(`/tasks/${taskId}`, { method: 'PATCH', body: { status: 'DONE' } }),
    onSuccess: () => {
      message.success('已标记完成，下游任务将被释放');
      refreshTaskViews();
    },
    onError: (e: Error) => message.error(e.message),
  });

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
  const mentionPlugin = useMemo(() => rehypeMentions(mentionNames), [mentionNames]);

  const status = STATUS_META[task?.status as string] ?? { label: task?.status ?? '', tone: 'muted' };
  const comments = q.data?.comments ?? [];
  const sessions = q.data?.sessions ?? [];

  // ── Dependencies ───────────────────────────────────────────────────────────
  const dependsOn = q.data?.dependsOn ?? []; // edges: this task's prerequisites
  const dependedOnBy = q.data?.dependedOnBy ?? []; // edges: tasks waiting on this one
  const dependencyState: string = q.data?.dependencyState ?? 'NONE';
  const blocked = dependencyState === 'BLOCKED' || dependencyState === 'BLOCKED_FAILED';
  const prereqIds = new Set(dependsOn.map((d: any) => d.dependsOnTask.id));
  // Candidate prerequisites: every other task not already a prerequisite of this one.
  const dependencyOptions = (allTasksQ.data ?? [])
    .filter((t: any) => t.id !== taskId && !prereqIds.has(t.id))
    .map((t: any) => ({ value: t.id, label: t.title }));
  // §6.3 safety net: a run finished successfully but the task still isn't DONE while
  // dependents wait — surface a one-click "标记完成" so the pipeline doesn't stall.
  const hasSucceededSession = sessions.some((s: any) => s.status === 'SUCCEEDED');
  const needsDoneConfirm =
    dependedOnBy.length > 0 && task?.status !== 'DONE' && hasSucceededSession;

  // Need a responsible agent to execute; the runner check is enforced by the backend.
  const canExecute = !!task?.assignee;
  // "Running" = the trigger request is in flight, or the task has a busy (queued/running)
  // session. The button shows this state and stays disabled throughout — which also
  // debounces it against repeated clicks (no second trigger until the current run ends).
  const running = execute.isPending || sessions.some((s: any) => isSessionBusy(s.status));
  // Blocked tasks can't run until prerequisites clear; mirror the backend's execute gate.
  const executeDisabled = !canExecute || running || blocked;
  const executeHint = blocked
    ? dependencyState === 'BLOCKED_FAILED'
      ? '前置任务已取消，需先处理'
      : '等待前置任务完成'
    : !canExecute
      ? '请先指定负责 Agent'
      : running
        ? '任务执行中…'
        : '';

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
        <div className="tdp-head-actions">
          <Tooltip title={executeHint}>
            <span style={{ display: 'inline-flex' }}>
              <Button
                type="primary"
                icon={<PlayCircleOutlined />}
                loading={running}
                disabled={executeDisabled}
                onClick={() => execute.mutate()}
                style={executeDisabled ? { pointerEvents: 'none' } : undefined}
              >
                {running ? '运行中' : '开始执行'}
              </Button>
            </span>
          </Tooltip>
          {task && task.status !== 'DONE' && (
            <Button
              icon={<CheckOutlined />}
              loading={markDone.isPending}
              onClick={() => markDone.mutate()}
            >
              标记完成
            </Button>
          )}
          <Button type="text" icon={<CloseOutlined />} onClick={onClose} aria-label="Close" />
        </div>
      </div>

      {q.isLoading ? (
        <div className="tdp-loading">
          <Spin />
        </div>
      ) : q.isError ? (
        <div className="tdp-empty">无法加载任务详情。</div>
      ) : (
        <div className="tdp-body">
          {needsDoneConfirm && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                marginBottom: 12,
                background: '#fffbe6',
                border: '1px solid #ffe58f',
                borderRadius: 6,
                fontSize: 13,
              }}
            >
              <span style={{ flex: 1 }}>
                有 {dependedOnBy.length} 个下游任务在等待，但此任务尚未标记完成。
              </span>
              <Button size="small" type="primary" loading={markDone.isPending} onClick={() => markDone.mutate()}>
                标记完成
              </Button>
            </div>
          )}
          <section className="tdp-section">
            <div className="tdp-section-title">详情</div>
            <div className="tdp-field">
              <span className="tdp-field-label">负责 Agent</span>
              <Select
                className="tdp-assignee-select"
                variant="borderless"
                value={task?.assignee?.id ?? undefined}
                placeholder="未指定"
                allowClear
                showSearch
                optionFilterProp="label"
                loading={agentsQ.isLoading || updateAssignee.isPending}
                disabled={updateAssignee.isPending}
                popupMatchSelectWidth={false}
                options={agentList.map((a) => ({ value: a.id, label: a.name }))}
                onChange={(val) => updateAssignee.mutate(val ?? null)}
              />
            </div>
            <div className="tdp-field">
              <span className="tdp-field-label">清单</span>
              <Select
                className="tdp-assignee-select"
                variant="borderless"
                value={q.data?.listId ?? undefined}
                placeholder="未分组"
                allowClear
                showSearch
                optionFilterProp="label"
                loading={taskListsQ.isLoading || updateList.isPending}
                disabled={updateList.isPending}
                popupMatchSelectWidth={false}
                options={(taskListsQ.data ?? []).map((l) => ({ value: l.id, label: l.title }))}
                onChange={(val) => updateList.mutate(val ?? null)}
              />
            </div>
            <div className="tdp-field">
              <span className="tdp-field-label">创建人</span>
              <span className="tdp-field-value">{summary?.creatorName ?? '—'}</span>
            </div>
            {q.data?.creatorSession && (
              <div className="tdp-field">
                <span className="tdp-field-label">创建来源</span>
                <Link
                  to={`/sessions/${encodeId(q.data.creatorSession.id)}`}
                  className="tdp-field-value tdp-field-link"
                  title="跳转到创建此任务的会话"
                >
                  {q.data.creatorSession.title || '未命名会话'}
                </Link>
              </div>
            )}
            <div className="tdp-field">
              <span className="tdp-field-label">创建时间</span>
              <span className="tdp-field-value">{fmt(task?.createdAt)}</span>
            </div>
          </section>

          <section className="tdp-section">
            <div className="tdp-section-title">前置依赖</div>
            {blocked && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 10px',
                  marginBottom: 8,
                  borderRadius: 6,
                  fontSize: 12,
                  background: dependencyState === 'BLOCKED_FAILED' ? '#fff1f0' : '#f0f5ff',
                  border: `1px solid ${dependencyState === 'BLOCKED_FAILED' ? '#ffccc7' : '#adc6ff'}`,
                  color: dependencyState === 'BLOCKED_FAILED' ? '#cf1322' : '#1d39c4',
                }}
              >
                {dependencyState === 'BLOCKED_FAILED'
                  ? '前置任务已取消，需先处理后才能执行'
                  : '等待前置任务全部完成后才能执行'}
              </div>
            )}
            {dependsOn.length === 0 ? (
              <div className="tdp-muted">无前置依赖</div>
            ) : (
              dependsOn.map((d: any) => {
                const meta = STATUS_META[d.dependsOnTask.status] ?? { label: d.dependsOnTask.status, tone: 'muted' };
                return (
                  <div
                    key={d.dependsOnTask.id}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}
                  >
                    <span className={`tdp-badge tone-${meta.tone}`}>{meta.label}</span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {d.dependsOnTask.title}
                    </span>
                    <Button
                      type="text"
                      size="small"
                      icon={<CloseOutlined />}
                      loading={removeDependency.isPending}
                      onClick={() => removeDependency.mutate(d.dependsOnTask.id)}
                      aria-label="移除依赖"
                    />
                  </div>
                );
              })
            )}
            <Select
              style={{ width: '100%', marginTop: 8 }}
              placeholder="添加前置任务…"
              value={null}
              showSearch
              optionFilterProp="label"
              loading={allTasksQ.isLoading || addDependency.isPending}
              popupMatchSelectWidth={false}
              options={dependencyOptions}
              onChange={(val) => val && addDependency.mutate(val)}
            />
            {dependsOn.length > 0 && (
              <div
                style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 13 }}
              >
                <Switch
                  size="small"
                  checked={task?.autoRunWhenReady ?? true}
                  loading={setAutoRun.isPending}
                  onChange={(v) => setAutoRun.mutate(v)}
                />
                <span>前置全部完成后自动执行</span>
              </div>
            )}
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
              sessions.map((s: any) => {
                const meta = RUN_STATUS_META[s.status] ?? { label: s.status, tone: 'muted' };
                return (
                  <Link
                    key={s.id}
                    to={`/sessions/${encodeId(s.id)}`}
                    className={`tdp-session${s.status === 'FAILED' ? ' is-failed' : ''}`}
                  >
                    <span className={`tdp-dot ${s.status}`} />
                    <div className="tdp-session-main">
                      {/* Agent leads — it's what tells two runs of the same task apart; the
                          system-generated title just repeats the task name. */}
                      <div className="tdp-session-title">
                        {s.agent?.name || s.title || '未命名会话'}
                      </div>
                      <div className="tdp-session-sub">{fmt(s.createdAt)}</div>
                    </div>
                    <span className={`tdp-badge tone-${meta.tone}`}>{meta.label}</span>
                  </Link>
                );
              })
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
                    <div className="tdp-comment-text md">
                      <Markdown
                        remarkPlugins={[remarkGfm]}
                        rehypePlugins={[rehypeHighlight, mentionPlugin]}
                      >
                        {c.body}
                      </Markdown>
                    </div>
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
