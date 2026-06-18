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
import { useMemo, useState } from 'react';
import { Link, useLocation, useMatch, useNavigate } from 'react-router-dom';
import { api, getSession } from '../api';
import { decodeId } from '../lib/idCodec';
import { AgentView } from '../components/AgentView';
import { RunnerRegisterGuide } from '../components/RunnerRegisterGuide';
import { TasksSidePanel } from '../components/TasksSidePanel';
import { RunnersPage } from './RunnersPage';
import { RunnerDetailPage } from './RunnerDetailPage';

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
  // Accepts both the mock run-statuses and the real TaskStatus enum
  // (OPEN/IN_PROGRESS/DONE/CANCELLED) so list pages filter correctly too.
  if (f === 'ONGOING') return ['QUEUED', 'RUNNING', 'OPEN', 'IN_PROGRESS'].includes(status);
  if (f === 'DONE') return status === 'SUCCEEDED' || status === 'DONE';
  if (f === 'FAILED') return status === 'FAILED' || status === 'CANCELLED';
  return true;
};

const cap = (s: string): string => s.charAt(0) + s.slice(1).toLowerCase();

// Task is not implemented yet — the list is mock data so the screen still renders.
// (Interactive Agent sessions are the real, live feature; see AgentView.)
const MOCK_TASKS = [
  { id: 'mock-agent-001', source: 'AGENT', status: 'RUNNING', title: 'Migrate build engine to tea-cli', estimates: '3d', startTime: '2026-06-16T01:00:00.000Z', dueDate: '2026-06-19T00:00:00.000Z', createdAt: '2026-06-16T01:00:00.000Z', creator: { name: 'Hailong' } },
  { id: 'mock-agent-002', source: 'AGENT', status: 'SUCCEEDED', title: 'Dorado 项目152 psm 改为 data.tea.build_compliance', estimates: '1d', startTime: '2026-06-15T08:00:00.000Z', dueDate: '2026-06-16T00:00:00.000Z', createdAt: '2026-06-15T08:00:00.000Z', creator: { name: 'Hailong' } },
  { id: 'mock-agent-003', source: 'AGENT', status: 'QUEUED', title: 'Backfill user_events partitions for 2026-Q1', estimates: '2d', startTime: null, dueDate: '2026-06-20T00:00:00.000Z', createdAt: '2026-06-17T02:30:00.000Z', creator: { name: 'Hailong' } },
  { id: 'mock-agent-004', source: 'AGENT', status: 'FAILED', title: 'Refactor ingestion DAG to incremental loads', estimates: '4d', startTime: '2026-06-13T09:00:00.000Z', dueDate: '2026-06-18T00:00:00.000Z', createdAt: '2026-06-13T09:00:00.000Z', creator: { name: 'Lin' } },
  { id: 'mock-agent-005', source: 'AGENT', status: 'RUNNING', title: 'Generate weekly data-quality report', estimates: '6h', startTime: '2026-06-17T00:00:00.000Z', dueDate: '2026-06-17T00:00:00.000Z', createdAt: '2026-06-17T00:00:00.000Z', creator: { name: 'system' } },
  { id: 'mock-agent-006', source: 'AGENT', status: 'SUCCEEDED', title: 'Optimize Spark shuffle config for nightly job', estimates: '2d', startTime: '2026-06-11T10:00:00.000Z', dueDate: '2026-06-13T00:00:00.000Z', createdAt: '2026-06-11T10:00:00.000Z', creator: { name: 'Wei' } },
  { id: 'mock-manual-001', source: 'MANUAL', status: 'QUEUED', title: 'importer not-ready sg 2026-06-13', estimates: null, startTime: null, dueDate: '2026-06-18T00:00:00.000Z', createdAt: '2026-06-14T03:00:00.000Z', creator: { name: 'Hailong' } },
  { id: 'mock-manual-002', source: 'MANUAL', status: 'SUCCEEDED', title: '运行命令 tea-cli-sg hdfs clean enable', estimates: '30m', startTime: '2026-06-14T05:00:00.000Z', dueDate: '2026-06-14T00:00:00.000Z', createdAt: '2026-06-14T04:30:00.000Z', creator: { name: 'Hailong' } },
  { id: 'mock-manual-003', source: 'MANUAL', status: 'DRAFT', title: 'Draft runbook for cross-region failover', estimates: '1d', startTime: null, dueDate: '2026-06-22T00:00:00.000Z', createdAt: '2026-06-17T06:00:00.000Z', creator: { name: 'Mei' } },
  { id: 'mock-manual-004', source: 'MANUAL', status: 'CANCELLED', title: 'Rotate service-account credentials (staging)', estimates: null, startTime: null, dueDate: null, createdAt: '2026-06-10T07:00:00.000Z', creator: { name: 'Hailong' } },
  { id: 'mock-ext-001', source: 'EXTERNAL', status: 'FAILED', title: 'External webhook backfill', estimates: null, startTime: '2026-06-12T10:00:00.000Z', dueDate: null, createdAt: '2026-06-12T10:00:00.000Z', creator: { name: 'system' } },
  { id: 'mock-ext-002', source: 'EXTERNAL', status: 'SUCCEEDED', title: 'Sync Salesforce accounts to warehouse', estimates: '1d', startTime: '2026-06-15T12:00:00.000Z', dueDate: '2026-06-16T00:00:00.000Z', createdAt: '2026-06-15T11:30:00.000Z', creator: { name: 'system' } },
  { id: 'mock-ext-003', source: 'EXTERNAL', status: 'RUNNING', title: 'Stream Kafka topic orders.v2 to lakehouse', estimates: null, startTime: '2026-06-16T18:00:00.000Z', dueDate: '2026-06-18T00:00:00.000Z', createdAt: '2026-06-16T18:00:00.000Z', creator: { name: 'system' } },
];

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
  // Real TaskStatus values (DONE/IN_PROGRESS/OPEN) are folded into the matching
  // mock run-status so list pages render the same icons.
  switch (status) {
    case 'SUCCEEDED':
    case 'DONE':
      node = <CheckCircleFilled style={{ color: '#2ea121', fontSize: 16 }} />;
      break;
    case 'RUNNING':
    case 'IN_PROGRESS':
      node = <LoadingOutlined spin style={{ color: '#3370ff', fontSize: 15 }} />;
      break;
    case 'FAILED':
      node = <CloseCircleFilled style={{ color: '#f54a45', fontSize: 16 }} />;
      break;
    case 'QUEUED':
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
  const [filter, setFilter] = useState('ALL');
  // The "Add a runner" guide is its own route; show it whenever we're on /runners/register.
  const showRegister = loc.pathname === '/runners/register';
  const showRunners = loc.pathname === '/runners';
  // /runners/<base62> opens that runner's detail/settings page. (/runners/register
  // also matches the :id pattern, so guard against it.)
  const runnerDetailMatch = useMatch('/runners/:id');
  const runnerDetailId = !showRegister && runnerDetailMatch ? decodeId(runnerDetailMatch.params.id) : null;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [form] = Form.useForm();

  const tasks = useQuery({ queryKey: ['tasks-mock'], queryFn: async () => MOCK_TASKS });
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api<any[]>('/agents') });
  const runners = useQuery({ queryKey: ['runners'], queryFn: () => api<any[]>('/runners') });

  // /lists/<base62> is the only non-mock task view: fetch that list and render its
  // real tasks (GET /task-lists/:id includes them). decodeId -> the UUID the API wants.
  const listMatch = useMatch('/lists/:key');
  const listId = listMatch ? decodeId(listMatch.params.key) : null;
  const listQ = useQuery({
    queryKey: ['task-list', listId],
    queryFn: () => api<{ id: string; title: string; tasks: any[] }>(`/task-lists/${listId}`),
    enabled: !!listId,
  });
  const isListView = !!listId;
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

  // A user list is a flat set of tasks (no AGENT/MANUAL/EXTERNAL source), so it
  // renders as one filtered list rather than the grouped mock view.
  const listRows = useMemo(
    () => (listQ.data?.tasks ?? []).filter((t: any) => matchesFilter(t.status, filter)),
    [listQ.data, filter],
  );

  const renderRow = (r: any, opts: { actions?: boolean } = {}) => {
    // List pages render real tasks; their mutation endpoints (enqueue/cancel) don't
    // exist yet, so actions are suppressed there until task mutations are wired up.
    const showActions = opts.actions ?? true;
    const runnable = ['DRAFT', 'FAILED', 'CANCELLED'].includes(r.status);
    const cancellable = ['QUEUED', 'RUNNING'].includes(r.status);
    const creatorName = r.creator?.name ?? r.creatorName ?? null;
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
            {(creatorName ?? '?').trim().charAt(0).toUpperCase()}
          </Avatar>
          <span className="task-cell">{creatorName ?? '—'}</span>
        </div>
        <div className="task-cell">{fmtDateTime(r.createdAt)}</div>
        <Typography.Text className="task-id" copyable={{ text: r.id, tooltips: ['Copy ID', 'Copied'] }}>
          {r.id.slice(0, 8)}
        </Typography.Text>
        {showActions && (
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
        )}
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
            <div className="col-head">Estimates</div>
            <div className="col-head">Start Time</div>
            <div className="col-head">Due Date</div>
            <div className="col-head">Creator</div>
            <div className="col-head">Created at</div>
            <div className="col-head">Task ID</div>
          </div>

          {isListView ? (
            <>
              {listRows.length === 0 ? (
                <div style={{ padding: '24px 16px', color: '#8a9099', fontSize: 13 }}>
                  No tasks in this list yet.
                </div>
              ) : (
                listRows.map((r: any) => renderRow(r, { actions: false }))
              )}
              <div className="new-task-row" onClick={() => setOpen(true)}>
                <PlusOutlined />
                <span>New Task</span>
              </div>
            </>
          ) : (
            SOURCES.map((s) => {
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
                      {rows.map((r: any) => renderRow(r))}
                      <div className="new-task-row" onClick={() => setOpen(true)}>
                        <PlusOutlined />
                        <span>New Task</span>
                      </div>
                    </>
                  )}
                </div>
              );
            })
          )}
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
