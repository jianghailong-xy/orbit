import {
  CheckCircleFilled,
  CloseCircleFilled,
  DeleteOutlined,
  LoadingOutlined,
  LockOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  SortAscendingOutlined,
  SortDescendingOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Avatar,
  Button,
  Checkbox,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Spin,
  Tooltip,
} from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useMatch, useNavigate } from 'react-router-dom';
import { api, getSession } from '../api';
import { decodeId } from '../lib/idCodec';
import { AgentView } from '../components/AgentView';
import { RunnerRegisterGuide } from '../components/RunnerRegisterGuide';
import { TasksSidePanel } from '../components/TasksSidePanel';
import { TaskDetailPanel } from '../components/TaskDetailPanel';
import { RunnersPage } from './RunnersPage';
import { RunnerDetailPage } from './RunnerDetailPage';
import { SkillsPage } from './SkillsPage';

const FILTERS = [
  { label: 'All', value: 'ALL' },
  { label: 'Ongoing', value: 'ONGOING' },
  { label: 'Failed', value: 'FAILED' },
  { label: 'Done', value: 'DONE' },
  { label: 'Cancelled', value: 'CANCELLED' },
];

// Filters over the real TaskStatus enum (OPEN/IN_PROGRESS/DONE/CANCELLED/FAILED).
const matchesFilter = (status: string, f: string): boolean => {
  if (f === 'ONGOING') return ['OPEN', 'IN_PROGRESS'].includes(status);
  if (f === 'FAILED') return status === 'FAILED';
  if (f === 'DONE') return status === 'DONE';
  if (f === 'CANCELLED') return status === 'CANCELLED';
  return true;
};

const SORTS = [
  { label: '创建时间', value: 'created' },
  { label: '状态', value: 'status' },
  { label: '标题', value: 'title' },
  { label: '执行人', value: 'assignee' },
];

// Rank for the "状态" sort: a live (running) task ranks first, then by lifecycle, so
// ascending groups 运行中 at the top and 已完成/已取消 at the bottom (descending flips it).
const STATUS_ORDER: Record<string, number> = {
  IN_PROGRESS: 1,
  FAILED: 2,
  OPEN: 3,
  DONE: 4,
  CANCELLED: 5,
};
const statusRank = (t: any): number => (t.running || t.queued ? 0 : (STATUS_ORDER[t.status] ?? 5));

// Compare two tasks by the chosen field, ascending. Equal pairs return 0 so the caller's
// stable sort preserves the incoming createdAt-desc order as a tiebreak.
const compareBy = (a: any, b: any, field: string): number => {
  switch (field) {
    case 'status':
      return statusRank(a) - statusRank(b);
    case 'title':
      return (a.title ?? '').localeCompare(b.title ?? '', 'zh');
    case 'assignee':
      return (a.assignee?.name ?? '').localeCompare(b.assignee?.name ?? '', 'zh');
    case 'created':
    default:
      return (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
  }
};

const cap = (s: string): string =>
  s.charAt(0) + s.slice(1).toLowerCase().replace('_', ' ');

// One status glyph per row: the agent-maintained lifecycle (`status`) overlaid with the
// live session state, so the row carries a single indicator instead of a status circle
// plus a separate activity dot. `running`/`queued` are the live ground truth (a RUNNING
// or PENDING session exists), distinct from the `status` label which can lag.
//   - running → blue spinner, regardless of the lifecycle label: "executing now" is the
//     most urgent signal and outranks everything.
//   - queued (a PENDING session, nothing running yet) → the lifecycle glyph with a gentle
//     fade, reading as "waiting to run".
//   - neither → the plain lifecycle glyph (an IN_PROGRESS task whose session already ended
//     without the agent finalizing it falls here, showing a static dot — not a spinner).
function StatusCircle({
  status,
  running,
  queued,
}: {
  status: string;
  running?: boolean;
  queued?: boolean;
}) {
  if (running) {
    return (
      <Tooltip title="运行中">
        <LoadingOutlined spin style={{ color: '#3370ff', fontSize: 15 }} />
      </Tooltip>
    );
  }
  let node: React.ReactNode;
  switch (status) {
    case 'DONE':
      node = <CheckCircleFilled style={{ color: '#2ea121', fontSize: 16 }} />;
      break;
    case 'FAILED':
      node = <CloseCircleFilled style={{ color: '#d4380d', fontSize: 16 }} />;
      break;
    case 'IN_PROGRESS':
      node = <span className="status-circle filled blue" />;
      break;
    case 'OPEN':
      node = <span className="status-circle hollow blue" />;
      break;
    case 'CANCELLED':
      node = <span className="status-circle hollow muted" />;
      break;
    default:
      node = <span className="status-circle hollow" />;
  }
  if (queued) {
    return (
      <Tooltip title="排队中">
        <span className="status-glyph-queued">{node}</span>
      </Tooltip>
    );
  }
  return <Tooltip title={cap(status)}>{node}</Tooltip>;
}

export function TasksPage() {
  const loc = useLocation();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  // Multi-select for batch actions, keyed by task id, scoped to the visible rows.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchOpen, setBatchOpen] = useState(false);
  const [concurrency, setConcurrency] = useState(3);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignAgentId, setAssignAgentId] = useState<string | null>(null);
  const [filter, setFilter] = useState('ALL');
  // Client-side sort over the visible rows; default 'created'/'desc' mirrors the
  // backend's createdAt-desc ordering, so the initial view is unchanged.
  const [sortField, setSortField] = useState('created');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  // The "Add a runner" guide is its own route; show it whenever we're on /runners/register.
  const showRegister = loc.pathname === '/runners/register';
  const showRunners = loc.pathname === '/runners';
  const showSkills = loc.pathname === '/skills';
  // /runners/<base62> opens that runner's detail/settings page. (/runners/register
  // also matches the :id pattern, so guard against it.)
  const runnerDetailMatch = useMatch('/runners/:id');
  const runnerDetailId = !showRegister && runnerDetailMatch ? decodeId(runnerDetailMatch.params.id) : null;
  const [form] = Form.useForm();

  // Poll while any task is running so its live indicator clears once the run ends;
  // 5s busy / 15s idle, matching the sidebar's task-list poll.
  const tasks = useQuery({
    queryKey: ['tasks'],
    queryFn: () => api<any[]>('/tasks'),
    refetchInterval: (q) =>
      (q.state.data ?? []).some((t: any) => t.running || t.queued) ? 5_000 : 15_000,
  });
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api<any[]>('/agents') });
  const runners = useQuery({ queryKey: ['runners'], queryFn: () => api<any[]>('/runners') });

  // /lists/<base62> renders a single user list instead of all tasks: fetch that list
  // and render its tasks (GET /task-lists/:id includes them). decodeId -> the UUID.
  // "/lists/none" is the virtual "未分组" view — tasks with no list. It isn't a real
  // list id, so skip decoding and keep listId null; the all-tasks data is filtered below.
  const listMatch = useMatch('/lists/:key');
  const isUnlisted = listMatch?.params.key === 'none';
  const listId = listMatch && !isUnlisted ? decodeId(listMatch.params.key) : null;
  const listQ = useQuery({
    queryKey: ['task-list', listId],
    queryFn: () => api<{ id: string; title: string; tasks: any[] }>(`/task-lists/${listId}`),
    enabled: !!listId,
    refetchInterval: (q) =>
      (q.state.data?.tasks ?? []).some((t: any) => t.running || t.queued) ? 5_000 : 15_000,
  });
  const isListView = !!listId;
  // Switching lists/sections closes any open detail panel.
  useEffect(() => setSelectedTaskId(null), [listId, loc.pathname]);
  // The selection is scoped to what's currently visible; reset it whenever that set
  // changes (different list/section, or a different status filter) to avoid running
  // tasks the user can no longer see.
  useEffect(() => setSelectedIds(new Set()), [listId, loc.pathname, filter]);
  const pageTitle = isListView ? (listQ.data?.title ?? '') : isUnlisted ? '未分组' : 'Active';

  // The console is keyed by runner: /agents/<agent> names the agent (its runner is
  // derived below), or /sessions/<id> from which we resolve the runner behind it.
  const agentMatch = useMatch('/agents/:id/*');
  const sessionMatch = useMatch('/sessions/:id');
  const inAgentView = !!agentMatch || !!sessionMatch;
  const selectedSessionId = sessionMatch ? decodeId(sessionMatch.params.id) : null;
  // A /sessions/:id deep link carries no runner — fetch the session to find it.
  const sessionQ = useQuery({
    queryKey: ['session', selectedSessionId],
    queryFn: () => getSession(selectedSessionId!),
    enabled: !!selectedSessionId,
  });
  const openAgentId = agentMatch ? decodeId(agentMatch.params.id) : null;
  const openAgent = (agents.data ?? []).find((a: any) => a.id === openAgentId) ?? null;
  // Prefer the agent's runner; fall back to treating the id as a runner so older
  // /agents/<runner> links still resolve, then to the open session's runner.
  const runnerId =
    openAgent?.runnerId ?? openAgentId ?? sessionQ.data?.assignedRunnerId ?? null;
  const selectedRunner = (runners.data ?? []).find((r: any) => r.id === runnerId) ?? null;
  // Navigating /agents/<id>/new -> /sessions/<newId> drops the agent from the URL, so
  // the runner can only come from getSession — undefined until that request returns.
  // Without a bridge, AgentView would unmount to a <Spin/> and remount (losing its SSE
  // stream / transcript and re-loading the session list) on every such hop. The runner
  // doesn't change across an in-console navigation, so hold the last resolved one as a
  // fallback while getSession is in flight; clear it on leaving the console.
  const lastRunner = useRef<any>(null);
  if (!inAgentView) lastRunner.current = null;
  else if (selectedRunner) lastRunner.current = selectedRunner;
  const viewRunner = inAgentView ? (selectedRunner ?? lastRunner.current) : null;

  const invalidate = () => qc.invalidateQueries({ queryKey: ['tasks'] });

  const create = useMutation({
    mutationFn: (body: unknown) => api('/tasks', { method: 'POST', body }),
    onSuccess: () => {
      setOpen(false);
      form.resetFields();
      invalidate();
    },
    onError: (e: Error) => message.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/tasks/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
    onError: (e: Error) => message.error(e.message),
  });
  const batchRun = useMutation({
    mutationFn: (body: { taskIds: string[]; maxConcurrent: number }) =>
      api<{ dispatched: number; failed: unknown[]; skipped: unknown[] }>('/tasks/batch-execute', {
        method: 'POST',
        body,
      }),
    onSuccess: (res) => {
      setBatchOpen(false);
      setSelectedIds(new Set());
      const parts = [`已触发 ${res.dispatched} 个任务`];
      if (res.failed.length) parts.push(`${res.failed.length} 个失败`);
      if (res.skipped.length) parts.push(`${res.skipped.length} 个跳过`);
      message[res.dispatched ? 'success' : 'warning'](parts.join('，'));
      invalidate();
    },
    onError: (e: Error) => message.error(e.message),
  });
  const batchAssign = useMutation({
    mutationFn: (body: { taskIds: string[]; assigneeId: string | null }) =>
      api<{ updated: number }>('/tasks/batch-assign', { method: 'POST', body }),
    onSuccess: (res) => {
      setAssignOpen(false);
      setSelectedIds(new Set());
      message.success(`已为 ${res.updated} 个任务设置执行人`);
      invalidate();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const taskRows = useMemo(
    () =>
      (tasks.data ?? [])
        .filter((t: any) => (isUnlisted ? !t.listId : true))
        .filter((t: any) => matchesFilter(t.status, filter)),
    [tasks.data, filter, isUnlisted],
  );

  const listRows = useMemo(
    () => (listQ.data?.tasks ?? []).filter((t: any) => matchesFilter(t.status, filter)),
    [listQ.data, filter],
  );

  // The rows currently shown (a single list's tasks, or all tasks otherwise),
  // ordered by the selected sort field/direction.
  const visibleRows = isListView ? listRows : taskRows;
  const rows = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...visibleRows].sort((a: any, b: any) => dir * compareBy(a, b, sortField));
  }, [visibleRows, sortField, sortDir]);

  // ── Multi-select / batch-run derived state ──
  const selectedRows = useMemo(
    () => rows.filter((r: any) => selectedIds.has(r.id)),
    [rows, selectedIds],
  );
  const allSelected = rows.length > 0 && rows.every((r: any) => selectedIds.has(r.id));
  const someSelected = rows.some((r: any) => selectedIds.has(r.id));
  // A task can run only if it has a responsible agent bound to a runner.
  const runnableRows = useMemo(
    () => selectedRows.filter((r: any) => r.assignee?.runner?.id),
    [selectedRows],
  );

  const toggleOne = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelectedIds(allSelected ? new Set() : new Set(rows.map((r: any) => r.id)));

  const openBatch = () => {
    if (runnableRows.length === 0) {
      message.warning('选中的任务都没有可执行的负责 Agent（或未绑定 runner）');
      return;
    }
    // Batch concurrency is its own knob (it doesn't touch any runner's cap); default to
    // a sane few, never more than the number of tasks we're about to run.
    setConcurrency(Math.min(runnableRows.length, 3) || 1);
    setBatchOpen(true);
  };

  const openAssign = () => {
    // Pre-select the shared assignee when the whole selection already agrees, else blank.
    const ids = [...new Set(selectedRows.map((r: any) => r.assignee?.id ?? null))];
    setAssignAgentId(ids.length === 1 ? ids[0] : null);
    setAssignOpen(true);
  };

  // The task list is one of several views this page hosts; the others (agent console,
  // runners, register guide) render in its place. Arrow keys must only drive the list.
  const showTaskList =
    !showRegister && !showRunners && !showSkills && !runnerDetailId && !inAgentView;

  // Up/Down arrows step through the task rows, opening each like tabs — the same
  // selection a click drives. Skipped while typing in an input/textarea (so the detail
  // panel's comment box keeps its own arrows) or while the New Task modal is open. With
  // nothing selected, Down enters from the top, Up from the bottom.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (!showTaskList || open) return;
      const el = document.activeElement;
      if (
        el instanceof HTMLElement &&
        (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
      )
        return;
      if (rows.length === 0) return;
      const cur = rows.findIndex((r: any) => r.id === selectedTaskId);
      let next: number;
      if (cur === -1) next = e.key === 'ArrowDown' ? 0 : rows.length - 1;
      else {
        next = cur + (e.key === 'ArrowDown' ? 1 : -1);
        if (next < 0 || next >= rows.length) return; // stop at the ends
      }
      e.preventDefault();
      setSelectedTaskId(rows[next].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, selectedTaskId, open, showTaskList]);

  // Keep the highlighted row in view when arrowing through a long list.
  useEffect(() => {
    document.querySelector('.task-row.selected')?.scrollIntoView({ block: 'nearest' });
  }, [selectedTaskId]);

  const renderRow = (r: any) => {
    // The agent assigned to run the task (GET /tasks and the list view both include it).
    const assigneeName = r.assignee?.name ?? null;
    const selected = selectedTaskId === r.id;
    return (
      <div
        className={`task-row clickable${selected ? ' selected' : ''}`}
        key={r.id}
        onClick={() => setSelectedTaskId(r.id)}
      >
        <div className="task-check" onClick={(e) => e.stopPropagation()}>
          <Checkbox checked={selectedIds.has(r.id)} onChange={() => toggleOne(r.id)} />
        </div>
        <div className="task-title-cell">
          <StatusCircle status={r.status} running={r.running} queued={r.queued} />
          <span className="task-title">{r.title}</span>
          {r.blocked ? (
            <Tooltip
              title={r.dependencyState === 'BLOCKED_FAILED' ? '前置任务已取消，需处理' : '等待前置任务完成'}
            >
              <LockOutlined
                style={{
                  fontSize: 12,
                  color: r.dependencyState === 'BLOCKED_FAILED' ? '#d4380d' : '#8c8c8c',
                }}
              />
            </Tooltip>
          ) : null}
        </div>
        <div className="task-creator">
          {assigneeName ? (
            <>
              <Avatar
                size={22}
                style={{ background: '#e1eaff', color: '#3370ff', fontSize: 11, flex: 'none' }}
              >
                {assigneeName.trim().charAt(0).toUpperCase()}
              </Avatar>
              <span className="task-cell">{assigneeName}</span>
            </>
          ) : (
            <span className="task-cell">Unassigned</span>
          )}
        </div>
        <div className="row-actions">
          <Tooltip title="Delete">
            <Button
              size="small"
              type="text"
              danger
              icon={<DeleteOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                remove.mutate(r.id);
              }}
            />
          </Tooltip>
        </div>
      </div>
    );
  };

  return (
    <div className="tasks-layout">
      <TasksSidePanel />
      <main className="tasks-main">
        {showRegister ? (
          <RunnerRegisterGuide onClose={() => navigate('/tasks')} />
        ) : showRunners ? (
          <RunnersPage />
        ) : showSkills ? (
          <SkillsPage />
        ) : runnerDetailId ? (
          <RunnerDetailPage runnerId={runnerDetailId} />
        ) : inAgentView ? (
          viewRunner ? (
            <AgentView runner={viewRunner} />
          ) : (
            <div style={{ padding: 48, textAlign: 'center' }}>
              <Spin />
            </div>
          )
        ) : (
          <>
        <h1 className="page-title">{pageTitle}</h1>

        <div className="tasks-toolbar">
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
          New Task
        </Button>
        <Segmented options={FILTERS} value={filter} onChange={(v) => setFilter(v as string)} />
        <div className="tasks-sort">
          <span className="tasks-sort-label">排序</span>
          <Select
            value={sortField}
            onChange={setSortField}
            options={SORTS}
            style={{ width: 104 }}
            popupMatchSelectWidth={false}
          />
          <Tooltip title={sortDir === 'asc' ? '升序' : '降序'}>
            <Button
              icon={sortDir === 'asc' ? <SortAscendingOutlined /> : <SortDescendingOutlined />}
              onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
            />
          </Tooltip>
        </div>
        {selectedIds.size > 0 && (
          <div className="tasks-bulkbar">
            <span className="tasks-bulkbar-count">已选 {selectedIds.size} 项</span>
            <Button
              type="primary"
              size="small"
              icon={<PlayCircleOutlined />}
              onClick={openBatch}
            >
              批量运行
            </Button>
            <Button size="small" icon={<UserOutlined />} onClick={openAssign}>
              设置执行人
            </Button>
            <Button type="text" size="small" onClick={() => setSelectedIds(new Set())}>
              清除
            </Button>
          </div>
        )}
      </div>

      {(isListView ? listQ.isLoading : tasks.isLoading) ? (
        <div style={{ padding: 48, textAlign: 'center' }}>
          <Spin />
        </div>
      ) : isListView && listQ.isError ? (
        <div style={{ padding: '24px 16px', color: '#8a9099', fontSize: 13 }}>
          This list could not be loaded.
        </div>
      ) : (
        <div className="orbit-tasklist">
          <div className="col-head-row">
            <div className="col-head task-check">
              <Checkbox
                checked={allSelected}
                indeterminate={someSelected && !allSelected}
                onChange={toggleAll}
                disabled={rows.length === 0}
              />
            </div>
            <div className="col-head">Task Title</div>
            <div className="col-head">Assignee</div>
          </div>

          {(() => {
            const empty = isListView
              ? 'No tasks in this list yet.'
              : isUnlisted
                ? '暂无未分组任务。'
                : 'No tasks yet.';
            return (
              <>
                {rows.length === 0 ? (
                  <div style={{ padding: '24px 16px', color: '#8a9099', fontSize: 13 }}>
                    {empty}
                  </div>
                ) : (
                  rows.map((r: any) => renderRow(r))
                )}
                <div className="new-task-row" onClick={() => setOpen(true)}>
                  <PlusOutlined />
                  <span>New Task</span>
                </div>
              </>
            );
          })()}
        </div>
      )}
          </>
        )}
      </main>

      {selectedTaskId && (
        <TaskDetailPanel
          taskId={selectedTaskId}
          summary={rows.find((r: any) => r.id === selectedTaskId)}
          onClose={() => setSelectedTaskId(null)}
        />
      )}

      <Modal
        title="New Task"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={create.isPending}
        okText="Create"
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => create.mutate({ ...v, listId: listId ?? undefined })}
        >
          <Form.Item name="title" label="Title" rules={[{ required: true }]}>
            <Input placeholder="e.g. 运行命令 tea-cli-sg hdfs clean enable" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} placeholder="Optional details about the task" />
          </Form.Item>
          <Form.Item name="assigneeId" label="Assignee">
            <Select
              allowClear
              placeholder="Pick an agent to run this task"
              options={(agents.data ?? []).map((a) => ({ value: a.id, label: a.name }))}
            />
          </Form.Item>
          <Form.Item name="dueDate" label="Due date">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="批量运行任务"
        open={batchOpen}
        onCancel={() => setBatchOpen(false)}
        onOk={() =>
          batchRun.mutate({
            taskIds: selectedRows.map((r: any) => r.id),
            maxConcurrent: concurrency,
          })
        }
        confirmLoading={batchRun.isPending}
        okText="开始运行"
        okButtonProps={{ disabled: runnableRows.length === 0 }}
      >
        <p style={{ marginTop: 0 }}>
          将运行选中的 <b>{runnableRows.length}</b> 个任务
          {selectedRows.length > runnableRows.length
            ? `，跳过 ${selectedRows.length - runnableRows.length} 个（未指定负责 Agent 或未绑定 runner）`
            : ''}
          。
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>并发度</span>
          <InputNumber
            min={1}
            max={64}
            value={concurrency}
            onChange={(v) => setConcurrency(v ?? 1)}
            style={{ width: 96 }}
          />
          <span style={{ color: '#8a9099' }}>个任务同时运行</span>
        </div>
        <p style={{ marginTop: 10, marginBottom: 0, color: '#8a9099', fontSize: 12 }}>
          任务会一次性全部提交，本批最多同时运行该数量，其余排队、有空位时自动开始。该限制只作用于这一批任务，不会修改任何运行器自身的并发上限。
        </p>
      </Modal>

      <Modal
        title="批量设置执行人"
        open={assignOpen}
        onCancel={() => setAssignOpen(false)}
        onOk={() =>
          batchAssign.mutate({
            taskIds: selectedRows.map((r: any) => r.id),
            assigneeId: assignAgentId,
          })
        }
        confirmLoading={batchAssign.isPending}
        okText="确定"
      >
        <p style={{ marginTop: 0 }}>
          为选中的 <b>{selectedRows.length}</b> 个任务设置执行人（负责 Agent）。
        </p>
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          style={{ width: '100%' }}
          placeholder="选择一个 Agent，留空则清除执行人"
          value={assignAgentId ?? undefined}
          onChange={(v) => setAssignAgentId(v ?? null)}
          options={(agents.data ?? []).map((a) => ({ value: a.id, label: a.name }))}
        />
      </Modal>
    </div>
  );
}
