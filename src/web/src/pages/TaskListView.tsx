import {
  DeleteOutlined,
  LoadingOutlined,
  LockOutlined,
  PlayCircleOutlined,
  SortAscendingOutlined,
  SortDescendingOutlined,
  StopOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Avatar,
  Button,
  Checkbox,
  InputNumber,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Spin,
  Tooltip,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useMatch, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { decodeId } from '../lib/idCodec';
import { TaskDetailPanel } from '../components/TaskDetailPanel';

// Filters over the real TaskStatus enum (OPEN/IN_PROGRESS/DONE/CANCELLED/FAILED).
const matchesFilter = (status: string, f: string): boolean => {
  if (f === 'ONGOING') return ['OPEN', 'IN_PROGRESS'].includes(status);
  if (f === 'FAILED') return status === 'FAILED';
  if (f === 'DONE') return status === 'DONE';
  if (f === 'CANCELLED') return status === 'CANCELLED';
  return true;
};

const SORTS = [
  { label: 'Created', value: 'created' },
  { label: 'Status', value: 'status' },
  { label: 'Title', value: 'title' },
  { label: 'Assignee', value: 'assignee' },
];

// Rank for the "状态" sort: 运行中 (executing now) ranks first, then 排队中 (waiting), then by
// lifecycle, so ascending groups 运行中 above 排队中 above 已完成/已取消 (descending flips it).
// running and queued get distinct ranks — they're different states, so the live task must not
// be intermixed with the queue (the +1 keeps lifecycle ranks below both session overlays).
const STATUS_ORDER: Record<string, number> = {
  IN_PROGRESS: 1,
  FAILED: 2,
  OPEN: 3,
  DONE: 4,
  CANCELLED: 5,
};
const statusRank = (t: any): number =>
  t.running ? 0 : t.queued ? 1 : (STATUS_ORDER[t.status] ?? 5) + 1;

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

// Lifecycle label → pill class + text. Status is encoded three ways (text + shape + color)
// so it reads without relying on color alone: done = green dot, 进行中 = blue square,
// 待办 = hollow ring, 失败 = red dot, 已取消 = muted ring.
const STATUS_PILL: Record<string, { cls: string; label: string }> = {
  DONE: { cls: 'done', label: 'Done' },
  IN_PROGRESS: { cls: 'ongoing', label: 'In progress' },
  OPEN: { cls: 'todo', label: 'Open' },
  FAILED: { cls: 'failed', label: 'Failed' },
  CANCELLED: { cls: 'cancelled', label: 'Cancelled' },
};

// One status pill per row: the agent-maintained lifecycle (`status`) overlaid with the live
// session state (`running`/`queued` — a RUNNING or PENDING session exists, the ground truth
// the `status` label can lag behind).
//   - running → blue spinner pill "运行中": "executing now" outranks the lifecycle label.
//   - queued (a PENDING session, nothing running yet) → a gently fading "排队中" pill.
//   - neither → the plain lifecycle pill.
function StatusPill({
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
      <span className="status-pill running">
        <LoadingOutlined spin />
        Running
      </span>
    );
  }
  if (queued) {
    return (
      <span className="status-pill queued">
        <span className="status-dot" />
        Queued
      </span>
    );
  }
  const s = STATUS_PILL[status] ?? { cls: 'todo', label: status };
  return (
    <span className={`status-pill ${s.cls}`}>
      <span className="status-dot" />
      {s.label}
    </span>
  );
}

// The default view: the task table (all tasks, or a single user list) plus its detail
// panel and batch-action modals. The default route ("/", "/tasks", "/lists/:key")
// renders it, so all of its state is scoped to this component.
export function TaskListView() {
  const loc = useLocation();
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  // Multi-select for batch actions, keyed by task id, scoped to the visible rows.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchOpen, setBatchOpen] = useState(false);
  const [concurrency, setConcurrency] = useState(3);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignAgentId, setAssignAgentId] = useState<string | null>(null);
  // Filter and sort live in the URL (?filter=…&sort=…&dir=…) so they survive a page
  // refresh and are shareable. A param is dropped when it equals its default, keeping
  // the URL clean for the initial view.
  const [searchParams, setSearchParams] = useSearchParams();
  const setParam = (key: string, value: string, def: string) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === def) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );
  const filter = searchParams.get('filter') ?? 'ALL';
  const setFilter = (v: string) => setParam('filter', v, 'ALL');
  // Client-side sort over the visible rows; default 'created'/'desc' mirrors the
  // backend's createdAt-desc ordering, so the initial view is unchanged.
  const sortField = searchParams.get('sort') ?? 'created';
  const setSortField = (v: string) => setParam('sort', v, 'created');
  const sortDir: 'asc' | 'desc' = searchParams.get('dir') === 'asc' ? 'asc' : 'desc';
  const setSortDir = (v: 'asc' | 'desc') => setParam('dir', v, 'desc');

  // Poll while any task is running so its live indicator clears once the run ends;
  // 5s busy / 15s idle, matching the sidebar's task-list poll.
  const tasks = useQuery({
    queryKey: ['tasks'],
    queryFn: () => api<any[]>('/tasks'),
    refetchInterval: (q) =>
      (q.state.data ?? []).some((t: any) => t.running || t.queued) ? 5_000 : 15_000,
  });
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api<any[]>('/agents') });

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
  // A /tasks/:id deep link (e.g. a session header's "回到任务") opens that task's detail
  // panel; decodeId -> the UUID TaskDetailPanel fetches by.
  const taskMatch = useMatch('/tasks/:id');
  const deepTaskId = taskMatch ? decodeId(taskMatch.params.id) : null;
  // Switching lists/sections closes any open panel; a deep link opens its task instead.
  useEffect(() => setSelectedTaskId(deepTaskId), [listId, loc.pathname, deepTaskId]);
  // The selection is scoped to what's currently visible; reset it whenever that set
  // changes (different list/section, or a different status filter) to avoid running
  // tasks the user can no longer see.
  useEffect(() => setSelectedIds(new Set()), [listId, loc.pathname, filter]);
  const pageTitle = isListView ? (listQ.data?.title ?? '') : isUnlisted ? 'No list' : 'Active';

  const invalidate = () => qc.invalidateQueries({ queryKey: ['tasks'] });

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
      const parts = [`Triggered ${res.dispatched} task(s)`];
      if (res.failed.length) parts.push(`${res.failed.length} failed`);
      if (res.skipped.length) parts.push(`${res.skipped.length} skipped`);
      message[res.dispatched ? 'success' : 'warning'](parts.join(', '));
      invalidate();
    },
    onError: (e: Error) => message.error(e.message),
  });
  const batchStop = useMutation({
    mutationFn: (body: { taskIds: string[] }) =>
      api<{ stopped: number; failed: unknown[]; tasks: number }>('/tasks/batch-stop', {
        method: 'POST',
        body,
      }),
    onSuccess: (res) => {
      setSelectedIds(new Set());
      message[res.stopped ? 'success' : 'info'](
        res.stopped ? `Stopped ${res.stopped} run(s)` : 'No running tasks to stop',
      );
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
      message.success(`Set assignee on ${res.updated} task(s)`);
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

  // The current view's full task set (before the status filter) — drives the progress
  // overview and the per-filter counts, which must reflect the whole list, not the
  // currently filtered subset.
  const baseRows = useMemo(
    () =>
      isListView
        ? (listQ.data?.tasks ?? [])
        : (tasks.data ?? []).filter((t: any) => (isUnlisted ? !t.listId : true)),
    [isListView, listQ.data, tasks.data, isUnlisted],
  );
  const counts = useMemo(() => {
    const c = { total: baseRows.length, done: 0, inProgress: 0, open: 0, failed: 0, cancelled: 0 };
    for (const t of baseRows) {
      if (t.status === 'DONE') c.done++;
      else if (t.status === 'FAILED') c.failed++;
      else if (t.status === 'CANCELLED') c.cancelled++;
      else if (t.status === 'IN_PROGRESS') c.inProgress++;
      else if (t.status === 'OPEN') c.open++;
    }
    return c;
  }, [baseRows]);
  const filterOptions = useMemo(() => {
    const seg = (label: string, n: number) => (
      <span className="seg-opt">
        {label}
        <span className="seg-count">{n}</span>
      </span>
    );
    return [
      { value: 'ALL', label: seg('All', counts.total) },
      { value: 'ONGOING', label: seg('In progress', counts.open + counts.inProgress) },
      { value: 'FAILED', label: seg('Failed', counts.failed) },
      { value: 'DONE', label: seg('Done', counts.done) },
      { value: 'CANCELLED', label: seg('Cancelled', counts.cancelled) },
    ];
  }, [counts]);

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
      message.warning('None of the selected tasks have a runnable assignee (or no runner bound)');
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

  // Up/Down arrows step through the task rows, opening each like tabs — the same
  // selection a click drives. Skipped while typing in an input/textarea (so the detail
  // panel's comment box keeps its own arrows). With nothing selected, Down enters from
  // the top, Up from the bottom.
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
  }, [rows, selectedTaskId]);

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
        <div className="task-status-cell">
          <StatusPill status={r.status} running={r.running} queued={r.queued} />
        </div>
        <div className="task-title-cell">
          <span className="task-title">{r.title}</span>
          {r.blocked ? (
            <Tooltip
              title={r.dependencyState === 'BLOCKED_FAILED' ? 'Prerequisite cancelled — resolve it' : 'Waiting for prerequisites'}
            >
              <LockOutlined
                style={{
                  fontSize: 12,
                  color: r.dependencyState === 'BLOCKED_FAILED' ? 'var(--error-solid)' : 'var(--text-3)',
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
                style={{ background: 'var(--brand-tint-hover)', color: 'var(--brand)', fontSize: 11, flex: 'none' }}
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
    <>
      <main className="app-main">
        <div className="app-view app-view--doc">
          <h1 className="page-title">{pageTitle}</h1>

          {counts.total > 0 && (
            <div className="task-progress">
              <div className="task-progress-track">
                <span
                  className="task-progress-seg done"
                  style={{ width: `${(counts.done / counts.total) * 100}%` }}
                />
                <span
                  className="task-progress-seg ongoing"
                  style={{ width: `${(counts.inProgress / counts.total) * 100}%` }}
                />
              </div>
              <div className="task-progress-text">
                Done <b>{counts.done}</b> / {counts.total}
                <span className="sep">·</span>In progress {counts.inProgress}
                <span className="sep">·</span>Open {counts.open}
                {counts.failed > 0 && (
                  <>
                    <span className="sep">·</span>Failed {counts.failed}
                  </>
                )}
              </div>
            </div>
          )}

          <div className="tasks-toolbar">
            <Segmented
              options={filterOptions}
              value={filter}
              onChange={(v) => setFilter(v as string)}
            />
            <div className="tasks-sort">
              <span className="tasks-sort-label">Sort</span>
              <Select
                value={sortField}
                onChange={setSortField}
                options={SORTS}
                style={{ width: 104 }}
                popupMatchSelectWidth={false}
              />
              <Tooltip title={sortDir === 'asc' ? 'Ascending' : 'Descending'}>
                <Button
                  icon={sortDir === 'asc' ? <SortAscendingOutlined /> : <SortDescendingOutlined />}
                  onClick={() => setSortDir(sortDir === 'asc' ? 'desc' : 'asc')}
                />
              </Tooltip>
            </div>
            {selectedIds.size > 0 && (
              <div className="tasks-bulkbar">
                <span className="tasks-bulkbar-count">{selectedIds.size} selected</span>
                <Button
                  type="primary"
                  size="small"
                  icon={<PlayCircleOutlined />}
                  onClick={openBatch}
                >
                  Run
                </Button>
                <Popconfirm
                  title="Stop selected tasks?"
                  description="Cancels each selected task's running or queued run."
                  okText="Stop"
                  okButtonProps={{ danger: true }}
                  onConfirm={() =>
                    batchStop.mutate({ taskIds: selectedRows.map((r: any) => r.id) })
                  }
                >
                  <Button size="small" danger icon={<StopOutlined />} loading={batchStop.isPending}>
                    Stop
                  </Button>
                </Popconfirm>
                <Button size="small" icon={<UserOutlined />} onClick={openAssign}>
                  Set assignee
                </Button>
                <Button type="text" size="small" onClick={() => setSelectedIds(new Set())}>
                  Clear
                </Button>
              </div>
            )}
          </div>

          {(isListView ? listQ.isLoading : tasks.isLoading) ? (
            <div style={{ padding: 48, textAlign: 'center' }}>
              <Spin />
            </div>
          ) : isListView && listQ.isError ? (
            <div style={{ padding: '24px 16px', color: 'var(--text-3)', fontSize: 13 }}>
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
                <div className="col-head">Status</div>
                <div className="col-head">Task</div>
                <div className="col-head">Assignee</div>
              </div>

              {rows.length === 0 ? (
                <div style={{ padding: '24px 16px', color: 'var(--text-3)', fontSize: 13 }}>
                  {isListView
                    ? 'No tasks in this list yet.'
                    : isUnlisted
                      ? 'No tasks without a list yet.'
                      : 'No tasks yet.'}
                </div>
              ) : (
                rows.map((r: any) => renderRow(r))
              )}
            </div>
          )}
        </div>
      </main>

      {selectedTaskId && (
        <TaskDetailPanel
          taskId={selectedTaskId}
          summary={rows.find((r: any) => r.id === selectedTaskId)}
          onClose={() => setSelectedTaskId(null)}
        />
      )}

      <Modal
        title="Run tasks"
        open={batchOpen}
        onCancel={() => setBatchOpen(false)}
        onOk={() =>
          batchRun.mutate({
            taskIds: selectedRows.map((r: any) => r.id),
            maxConcurrent: concurrency,
          })
        }
        confirmLoading={batchRun.isPending}
        okText="Run"
        okButtonProps={{ disabled: runnableRows.length === 0 }}
      >
        <p style={{ marginTop: 0 }}>
          Will run <b>{runnableRows.length}</b> selected task(s)
          {selectedRows.length > runnableRows.length
            ? `, skipping ${selectedRows.length - runnableRows.length} (no assignee or no runner bound)`
            : ''}
          .
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>Concurrency</span>
          <InputNumber
            min={1}
            max={64}
            value={concurrency}
            onChange={(v) => setConcurrency(v ?? 1)}
            style={{ width: 96 }}
          />
          <span style={{ color: 'var(--text-3)' }}>tasks running at once</span>
        </div>
        <p style={{ marginTop: 10, marginBottom: 0, color: 'var(--text-3)', fontSize: 12 }}>
          All tasks are submitted at once; at most this many run concurrently in this batch, the rest queue and start as slots free up. This limit applies only to this batch and never changes any runner's own concurrency cap.
        </p>
      </Modal>

      <Modal
        title="Set assignee"
        open={assignOpen}
        onCancel={() => setAssignOpen(false)}
        onOk={() =>
          batchAssign.mutate({
            taskIds: selectedRows.map((r: any) => r.id),
            assigneeId: assignAgentId,
          })
        }
        confirmLoading={batchAssign.isPending}
        okText="OK"
      >
        <p style={{ marginTop: 0 }}>
          Set the assignee (responsible agent) for <b>{selectedRows.length}</b> selected task(s).
        </p>
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          style={{ width: '100%' }}
          placeholder="Pick an agent, leave empty to clear the assignee"
          value={assignAgentId ?? undefined}
          onChange={(v) => setAssignAgentId(v ?? null)}
          options={(agents.data ?? []).map((a) => ({ value: a.id, label: a.name }))}
        />
      </Modal>
    </>
  );
}
