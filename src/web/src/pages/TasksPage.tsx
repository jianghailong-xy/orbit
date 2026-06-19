import {
  CheckCircleFilled,
  DeleteOutlined,
  LoadingOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Avatar,
  Button,
  DatePicker,
  Form,
  Input,
  Modal,
  Segmented,
  Select,
  Spin,
  Tooltip,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useMatch, useNavigate } from 'react-router-dom';
import { api, getSession } from '../api';
import { decodeId } from '../lib/idCodec';
import { AgentView } from '../components/AgentView';
import { RunnerRegisterGuide } from '../components/RunnerRegisterGuide';
import { TasksSidePanel } from '../components/TasksSidePanel';
import { TaskDetailPanel } from '../components/TaskDetailPanel';
import { RunnersPage } from './RunnersPage';
import { RunnerDetailPage } from './RunnerDetailPage';

const FILTERS = [
  { label: 'All', value: 'ALL' },
  { label: 'Ongoing', value: 'ONGOING' },
  { label: 'Done', value: 'DONE' },
  { label: 'Cancelled', value: 'CANCELLED' },
];

// Filters over the real TaskStatus enum (OPEN/IN_PROGRESS/DONE/CANCELLED).
const matchesFilter = (status: string, f: string): boolean => {
  if (f === 'ONGOING') return ['OPEN', 'IN_PROGRESS'].includes(status);
  if (f === 'DONE') return status === 'DONE';
  if (f === 'CANCELLED') return status === 'CANCELLED';
  return true;
};

const cap = (s: string): string =>
  s.charAt(0) + s.slice(1).toLowerCase().replace('_', ' ');

// Top-nav sections share this view; only the heading differs (default: Active).
const SECTION_TITLES: Record<string, string> = {
  '/skills': 'Skills',
};

const fmtDate = (d?: string): string =>
  d ? new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '—';

const fmtDateTime = (d?: string): string => {
  if (!d) return '—';
  const date = new Date(d);
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === now.toDateString()) return `Today, ${time}`;
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
};

function StatusCircle({ status }: { status: string }) {
  let node: React.ReactNode;
  switch (status) {
    case 'DONE':
      node = <CheckCircleFilled style={{ color: '#2ea121', fontSize: 16 }} />;
      break;
    case 'IN_PROGRESS':
      node = <LoadingOutlined spin style={{ color: '#3370ff', fontSize: 15 }} />;
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
  return <Tooltip title={cap(status)}>{node}</Tooltip>;
}

export function TasksPage() {
  const loc = useLocation();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [filter, setFilter] = useState('ALL');
  // The "Add a runner" guide is its own route; show it whenever we're on /runners/register.
  const showRegister = loc.pathname === '/runners/register';
  const showRunners = loc.pathname === '/runners';
  // /runners/<base62> opens that runner's detail/settings page. (/runners/register
  // also matches the :id pattern, so guard against it.)
  const runnerDetailMatch = useMatch('/runners/:id');
  const runnerDetailId = !showRegister && runnerDetailMatch ? decodeId(runnerDetailMatch.params.id) : null;
  const [form] = Form.useForm();

  const tasks = useQuery({ queryKey: ['tasks'], queryFn: () => api<any[]>('/tasks') });
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api<any[]>('/agents') });
  const runners = useQuery({ queryKey: ['runners'], queryFn: () => api<any[]>('/runners') });

  // /lists/<base62> renders a single user list instead of all tasks: fetch that list
  // and render its tasks (GET /task-lists/:id includes them). decodeId -> the UUID.
  const listMatch = useMatch('/lists/:key');
  const listId = listMatch ? decodeId(listMatch.params.key) : null;
  const listQ = useQuery({
    queryKey: ['task-list', listId],
    queryFn: () => api<{ id: string; title: string; tasks: any[] }>(`/task-lists/${listId}`),
    enabled: !!listId,
  });
  const isListView = !!listId;
  // Switching lists/sections closes any open detail panel.
  useEffect(() => setSelectedTaskId(null), [listId, loc.pathname]);
  const pageTitle = isListView
    ? (listQ.data?.title ?? '')
    : (SECTION_TITLES[loc.pathname] ?? 'Active');

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

  const taskRows = useMemo(
    () => (tasks.data ?? []).filter((t: any) => matchesFilter(t.status, filter)),
    [tasks.data, filter],
  );

  const listRows = useMemo(
    () => (listQ.data?.tasks ?? []).filter((t: any) => matchesFilter(t.status, filter)),
    [listQ.data, filter],
  );

  // The rows currently shown (a single list's tasks, or all tasks otherwise).
  const rows = isListView ? listRows : taskRows;

  // Up/Down arrows step through the task rows, opening each like tabs — the same
  // selection a click drives. Skipped while typing in an input/textarea (so the detail
  // panel's comment box keeps its own arrows) or while the New Task modal is open. With
  // nothing selected, Down enters from the top, Up from the bottom.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (open) return;
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
  }, [rows, selectedTaskId, open]);

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
        <div className="task-title-cell">
          <StatusCircle status={r.status} />
          <span className="task-title">{r.title}</span>
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
        <div className="task-cell">{fmtDate(r.dueDate)}</div>
        <div className="task-cell">{fmtDateTime(r.createdAt)}</div>
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
        ) : runnerDetailId ? (
          <RunnerDetailPage runnerId={runnerDetailId} />
        ) : inAgentView ? (
          selectedRunner ? (
            <AgentView runner={selectedRunner} />
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
            <div className="col-head">Task Title</div>
            <div className="col-head">Assignee</div>
            <div className="col-head">Due Date</div>
            <div className="col-head">Created at</div>
          </div>

          {(() => {
            const empty = isListView ? 'No tasks in this list yet.' : 'No tasks yet.';
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
    </div>
  );
}
