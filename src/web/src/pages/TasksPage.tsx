import {
  CaretDownOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  DeleteOutlined,
  LoadingOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Avatar,
  Button,
  Form,
  Input,
  Modal,
  Segmented,
  Select,
  Spin,
  Switch,
  Tooltip,
  Typography,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../api';
import { AgentView } from '../components/AgentView';
import { RunnerRegisterGuide } from '../components/RunnerRegisterGuide';
import { TasksSidePanel, type Runner } from '../components/TasksSidePanel';

const SOURCES = [
  { key: 'AGENT', label: 'Agents' },
  { key: 'MANUAL', label: 'Manual Task' },
  { key: 'EXTERNAL', label: 'External' },
];

const FILTERS = [
  { label: 'All', value: 'ALL' },
  { label: 'Ongoing', value: 'ONGOING' },
  { label: 'Done', value: 'DONE' },
  { label: 'Failed', value: 'FAILED' },
];

const matchesFilter = (status: string, f: string): boolean => {
  if (f === 'ONGOING') return status === 'QUEUED' || status === 'RUNNING';
  if (f === 'DONE') return status === 'SUCCEEDED';
  if (f === 'FAILED') return status === 'FAILED' || status === 'CANCELLED';
  return true;
};

const cap = (s: string): string => s.charAt(0) + s.slice(1).toLowerCase();

// Top-nav sections share this view; only the heading differs (default: Running).
const SECTION_TITLES: Record<string, string> = {
  '/skills': 'Skills',
  '/schedule': 'Schedule',
  '/activities': 'Activities',
};

// The "Add a runner" view isn't URL-routed (it adds no path), so remember it
// per-tab — a refresh restores it instead of snapping back to the task list.
const REGISTER_VIEW_KEY = 'orbit:tasks-register-view';

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
    case 'SUCCEEDED':
      node = <CheckCircleFilled style={{ color: '#2ea121', fontSize: 16 }} />;
      break;
    case 'RUNNING':
      node = <LoadingOutlined spin style={{ color: '#3370ff', fontSize: 15 }} />;
      break;
    case 'FAILED':
      node = <CloseCircleFilled style={{ color: '#f54a45', fontSize: 16 }} />;
      break;
    case 'QUEUED':
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
  const pageTitle = SECTION_TITLES[loc.pathname] ?? 'Running';
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('ALL');
  const [view, setView] = useState<'tasks' | 'register' | 'agent'>(() =>
    sessionStorage.getItem(REGISTER_VIEW_KEY) === '1' ? 'register' : 'tasks',
  );
  const [selectedRunner, setSelectedRunner] = useState<Runner | null>(null);
  useEffect(() => {
    if (view === 'register') sessionStorage.setItem(REGISTER_VIEW_KEY, '1');
    else sessionStorage.removeItem(REGISTER_VIEW_KEY);
  }, [view]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [form] = Form.useForm();

  const tasks = useQuery({ queryKey: ['tasks'], queryFn: () => api<any[]>('/tasks') });
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api<any[]>('/agents') });
  const runners = useQuery({ queryKey: ['runners'], queryFn: () => api<any[]>('/runners') });

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
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) =>
      api(`/tasks/${id}/${action}`, { method: 'POST' }),
    onSuccess: invalidate,
    onError: (e: Error) => message.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/tasks/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
    onError: (e: Error) => message.error(e.message),
  });

  const grouped = useMemo(() => {
    const g: Record<string, any[]> = { AGENT: [], MANUAL: [], EXTERNAL: [] };
    for (const t of tasks.data ?? []) {
      if (!matchesFilter(t.status, filter)) continue;
      (g[t.source] ??= []).push(t);
    }
    return g;
  }, [tasks.data, filter]);

  const renderRow = (r: any) => {
    const runnable = ['DRAFT', 'FAILED', 'CANCELLED'].includes(r.status);
    const cancellable = ['QUEUED', 'RUNNING'].includes(r.status);
    return (
      <div className="task-row" key={r.id}>
        <div className="task-title-cell">
          <StatusCircle status={r.status} />
          <Link to={`/tasks/${r.id}`} className="task-title">
            {r.title}
          </Link>
        </div>
        <div className="task-cell">{r.estimates || '—'}</div>
        <div className="task-cell">{fmtDate(r.startTime)}</div>
        <div className="task-cell">{fmtDate(r.dueDate)}</div>
        <div className="task-creator">
          <Avatar
            size={22}
            style={{ background: '#e1eaff', color: '#3370ff', fontSize: 11, flex: 'none' }}
          >
            {(r.creator?.name ?? '?').trim().charAt(0).toUpperCase()}
          </Avatar>
          <span className="task-cell">{r.creator?.name ?? '—'}</span>
        </div>
        <div className="task-cell">{fmtDateTime(r.createdAt)}</div>
        <Typography.Text className="task-id" copyable={{ text: r.id, tooltips: ['Copy ID', 'Copied'] }}>
          {r.id.slice(0, 8)}
        </Typography.Text>
        <div className="row-actions">
          {runnable && (
            <Button
              size="small"
              type="primary"
              ghost
              onClick={() => act.mutate({ id: r.id, action: 'enqueue' })}
            >
              Run
            </Button>
          )}
          {cancellable && (
            <Button size="small" danger onClick={() => act.mutate({ id: r.id, action: 'cancel' })}>
              Cancel
            </Button>
          )}
          <Tooltip title="Delete">
            <Button
              size="small"
              type="text"
              danger
              icon={<DeleteOutlined />}
              onClick={() => remove.mutate(r.id)}
            />
          </Tooltip>
        </div>
      </div>
    );
  };

  return (
    <div className="tasks-layout">
      <TasksSidePanel
        onShowRegister={() => setView('register')}
        onShowTasks={() => setView('tasks')}
        onSelectAgent={(r) => {
          setSelectedRunner(r);
          setView('agent');
        }}
      />
      <main className="tasks-main">
        {view === 'register' ? (
          <RunnerRegisterGuide onClose={() => setView('tasks')} />
        ) : view === 'agent' && selectedRunner ? (
          <AgentView runner={selectedRunner} />
        ) : (
          <>
        <h1 className="page-title">{pageTitle}</h1>

        <div className="tasks-toolbar">
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
          New Task
        </Button>
        <Segmented options={FILTERS} value={filter} onChange={(v) => setFilter(v as string)} />
      </div>

      {tasks.isLoading ? (
        <div style={{ padding: 48, textAlign: 'center' }}>
          <Spin />
        </div>
      ) : (
        <div className="orbit-tasklist">
          <div className="col-head-row">
            <div className="col-head">Task Title</div>
            <div className="col-head">Estimates</div>
            <div className="col-head">Start Time</div>
            <div className="col-head">Due Date</div>
            <div className="col-head">Creator</div>
            <div className="col-head">Created at</div>
            <div className="col-head">Task ID</div>
          </div>

          {SOURCES.map((s) => {
            const rows = grouped[s.key] ?? [];
            const isCollapsed = collapsed[s.key];
            return (
              <div key={s.key}>
                <div
                  className="group-header"
                  onClick={() => setCollapsed((c) => ({ ...c, [s.key]: !c[s.key] }))}
                >
                  <CaretDownOutlined className={`group-caret ${isCollapsed ? 'collapsed' : ''}`} />
                  <span className="group-name">{s.label}</span>
                  <span className="group-count">{rows.length}</span>
                </div>
                {!isCollapsed && (
                  <>
                    {rows.map(renderRow)}
                    <div className="new-task-row" onClick={() => setOpen(true)}>
                      <PlusOutlined />
                      <span>New Task</span>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
          </>
        )}
      </main>

      <Modal
        title="New Task"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={create.isPending}
        okText="Create"
      >
        <Form form={form} layout="vertical" onFinish={(v) => create.mutate(v)}>
          <Form.Item name="title" label="Title" rules={[{ required: true }]}>
            <Input placeholder="e.g. 运行命令 tea-cli-sg hdfs clean enable" />
          </Form.Item>
          <Form.Item name="prompt" label="Prompt (instruction for Claude Code)">
            <Input.TextArea rows={3} placeholder="Defaults to the title if left blank" />
          </Form.Item>
          <Form.Item name="agentId" label="Agent">
            <Select
              allowClear
              placeholder="Pick an agent (defines model + tools)"
              options={(agents.data ?? []).map((a) => ({ value: a.id, label: a.name }))}
            />
          </Form.Item>
          <Form.Item name="assignedRunnerId" label="Pin to runner (optional)">
            <Select
              allowClear
              placeholder="Any matching runner"
              options={(runners.data ?? []).map((r) => ({ value: r.id, label: r.name }))}
            />
          </Form.Item>
          <Form.Item name="enqueue" label="Queue immediately" valuePropName="checked" initialValue>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
