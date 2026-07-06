import {
  ArrowLeftOutlined,
  DeleteOutlined,
  EditOutlined,
  MessageOutlined,
  MoreOutlined,
  PlusOutlined,
  RobotOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntdApp,
  Button,
  Dropdown,
  Input,
  InputNumber,
  Modal,
  Select,
  Spin,
  Switch,
  Tag,
  type MenuProps,
} from 'antd';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { PlanUsage, PlanUsageSnapshot, PlanUsageWindow } from '@orbit/shared';
import { api } from '../api';
import { decodeId, encodeId } from '../lib/idCodec';
import { meQuery } from '../lib/queries';
import type { Runner } from '../components/TasksSidePanel';
import {
  AUTO_CAPABLE_MODELS,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
  MODE_OPTIONS,
  PROVIDER_OPTIONS,
  modelOptionsForProvider,
  effortOptionsForProvider,
} from '../lib/agentDefaults';

interface Agent {
  id: string;
  name: string;
  appendSystemPrompt?: string | null;
  provider?: string;
  model?: string;
  permissionMode?: string;
  effort?: string | null;
  workDir?: string | null;
  env?: Record<string, string> | null;
  runnerId?: string | null;
  enabled?: boolean;
  enableWorktree?: boolean;
}

const fmtTime = (d?: string | null): string =>
  d
    ? new Date(d).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '—';

type PlanUsageKey = 'fiveHour' | 'sevenDay' | 'sevenDayOpus' | 'sevenDaySonnet';
// The subscription windows we surface. Windows the plan doesn't have are skipped.
const CLAUDE_PLAN_USAGE_ROWS: { key: PlanUsageKey; label: string }[] = [
  { key: 'fiveHour', label: '5-hour limit' },
  { key: 'sevenDay', label: 'Weekly · all models' },
  { key: 'sevenDayOpus', label: 'Weekly · Opus' },
  { key: 'sevenDaySonnet', label: 'Weekly · Sonnet' },
];
const CODEX_PLAN_USAGE_ROWS: { key: 'primary' | 'secondary'; label: string }[] = [
  { key: 'primary', label: 'Primary limit' },
  { key: 'secondary', label: 'Secondary limit' },
];

type UsageRow = { key: string; label: string; w: PlanUsageWindow };

function usageWindow(usage: PlanUsageSnapshot, key: string): PlanUsageWindow | undefined {
  switch (key) {
    case 'fiveHour':
      return usage.fiveHour;
    case 'sevenDay':
      return usage.sevenDay;
    case 'sevenDayOpus':
      return usage.sevenDayOpus;
    case 'sevenDaySonnet':
      return usage.sevenDaySonnet;
    case 'primary':
      return usage.primary;
    case 'secondary':
      return usage.secondary;
    default:
      return undefined;
  }
}

function rowsForUsageSnapshot(usage: PlanUsageSnapshot): UsageRow[] {
  const codex = usage.provider === 'codex' || usage.primary || usage.secondary;
  const defs = codex ? CODEX_PLAN_USAGE_ROWS : CLAUDE_PLAN_USAGE_ROWS;
  return defs.flatMap(({ key, label }) => {
    const w = usageWindow(usage, key);
    return w && typeof w.utilization === 'number' ? [{ key, label: w.label || label, w }] : [];
  });
}

function snapshotsForPlanUsage(usage: PlanUsage): { key: string; title: string; note: string; usage: PlanUsageSnapshot }[] {
  if (usage.claude || usage.codex) {
    return [
      usage.claude && {
        key: 'claude',
        title: 'Claude usage',
        note: 'Account-wide Claude subscription quota for this runner login',
        usage: usage.claude,
      },
      usage.codex && {
        key: 'codex',
        title: 'Codex usage',
        note: 'Account-wide Codex rate limits for this runner login',
        usage: usage.codex,
      },
    ].filter(Boolean) as { key: string; title: string; note: string; usage: PlanUsageSnapshot }[];
  }
  const codex = usage.provider === 'codex' || usage.primary || usage.secondary;
  return [
    {
      key: codex ? 'codex' : 'claude',
      title: codex ? 'Codex usage' : 'Claude usage',
      note: codex
        ? 'Account-wide Codex rate limits for this runner login'
        : 'Account-wide Claude subscription quota for this runner login',
      usage,
    },
  ];
}

// Per-runner provider plan usage for the account(s) this runner is logged into.
function PlanUsageSection({ usage }: { usage: PlanUsage }) {
  const sections = snapshotsForPlanUsage(usage)
    .map((s) => ({ ...s, rows: rowsForUsageSnapshot(s.usage) }))
    .filter((s) => s.rows.length > 0);
  if (sections.length === 0) return null;
  return (
    <>
      {sections.map(({ key: sectionKey, title, note, usage: u, rows }) => (
        <section className="rd-section" key={sectionKey}>
          <div className="rd-section-title">{title}</div>
          <div className="rd-usage">
            {rows.map(({ key, label, w }) => {
              const pct = Math.round(w.utilization);
              return (
                <div className="rd-usage-row" key={key}>
                  <div className="rd-usage-head">
                    <span className="rd-usage-label">{label}</span>
                    <span className="rd-usage-pct">{pct}%</span>
                  </div>
                  <div className={`runner-util rd-usage-bar ${pct >= 90 ? 'full' : ''}`}>
                    <span
                      className="runner-util-fill"
                      style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                    />
                  </div>
                  {w.resetsAt && <div className="rd-usage-reset">Resets {fmtTime(w.resetsAt)}</div>}
                </div>
              );
            })}
          </div>
          <div className="rd-usage-note">
            {note} · updated {fmtTime(u.fetchedAt)}
          </div>
        </section>
      ))}
    </>
  );
}

// Runner detail / settings page. Clicking a runner lands here (not the chat
// console) — you manage the runner and the agents that run under it. The live
// conversation belongs to an agent, reached via each agent's "对话" button.
export function RunnerDetailPage() {
  // /runners/<base62> — decode the route param to the runner's UUID.
  const runnerId = decodeId(useParams().id);
  const navigate = useNavigate();
  const { modal, message } = AntdApp.useApp();
  const qc = useQueryClient();

  const runners = useQuery({
    queryKey: ['runners'],
    queryFn: () => api<Runner[]>('/runners'),
    refetchInterval: 15_000,
  });
  const runner = (runners.data ?? []).find((r) => r.id === runnerId) ?? null;

  const agentsQ = useQuery({ queryKey: ['agents'], queryFn: () => api<Agent[]>('/agents') });
  const agents = (agentsQ.data ?? []).filter((a) => a.runnerId === runnerId);

  // Rename / delete the runner — same API the Runners grid uses.
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState('');
  const renameMut = useMutation({
    mutationFn: (displayName: string) =>
      api(`/runners/${runnerId}`, { method: 'PATCH', body: { displayName } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['runners'] });
      setRenaming(false);
    },
    onError: (e: Error) => message.error(e.message || 'Rename failed'),
  });

  // Edit the runner's concurrency cap — same PATCH the rename uses.
  const [slotsOpen, setSlotsOpen] = useState(false);
  const [slotsVal, setSlotsVal] = useState<number | null>(1);
  const slotsMut = useMutation({
    mutationFn: (maxConcurrent: number) =>
      api(`/runners/${runnerId}`, { method: 'PATCH', body: { maxConcurrent } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['runners'] });
      setSlotsOpen(false);
    },
    onError: (e: Error) => message.error(e.message || 'Update failed'),
  });
  const deleteMut = useMutation({
    mutationFn: () => api(`/runners/${runnerId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['runners'] });
      navigate('/runners');
    },
    onError: (e: Error) => message.error(e.message || 'Delete failed'),
  });

  // Add / edit an agent bound to this runner (controlled inputs, like the
  // rename modal — avoids antd Form instance pitfalls with pre-filled edits).
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Agent | null>(null);
  const [fName, setFName] = useState('');
  const [fProvider, setFProvider] = useState('claude');
  const [fModel, setFModel] = useState(DEFAULT_MODEL);
  const [fMode, setFMode] = useState('auto');
  const [fEffort, setFEffort] = useState('');
  const [fAppend, setFAppend] = useState('');
  const [fWorkDir, setFWorkDir] = useState('');
  const [fEnableWorktree, setFEnableWorktree] = useState(true);
  const [fEnv, setFEnv] = useState<{ key: string; value: string }[]>([]);

  // New agents start from the user's saved defaults (Settings → Agent defaults),
  // falling back to the app defaults. Auto needs an auto-capable model, so a saved
  // Auto + non-auto model degrades to Default (the same rule onModelChange applies).
  const me = useQuery(meQuery());
  const prefModel = me.data?.preferences?.defaultModel ?? DEFAULT_MODEL;
  let prefMode = me.data?.preferences?.defaultPermissionMode ?? DEFAULT_PERMISSION_MODE;
  if (prefMode === 'auto' && !AUTO_CAPABLE_MODELS.has(prefModel)) prefMode = 'default';

  // Pick a model; if it can't run Auto, fall back the default mode off Auto.
  const onModelChange = (m: string) => {
    setFModel(m);
    if (fMode === 'auto' && !AUTO_CAPABLE_MODELS.has(m)) setFMode('default');
  };
  const onProviderChange = (provider: string) => {
    setFProvider(provider);
    const nextModel = DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL;
    setFModel(nextModel);
    if (fMode === 'auto' && !AUTO_CAPABLE_MODELS.has(nextModel)) setFMode('default');
    // Effort levels differ per provider (codex has 'minimal', not 'max'); reset to Default so the
    // Select never shows a value absent from the new provider's options.
    setFEffort('');
  };

  const saveMut = useMutation({
    mutationFn: () => {
      const body = {
        name: fName.trim(),
        provider: fProvider,
        model: fModel,
        permissionMode: fMode,
        // Sent even when '' (Default) so picking Default clears a previously-set effort.
        effort: fEffort,
        appendSystemPrompt: fAppend.trim() || undefined,
        workDir: fWorkDir.trim() || undefined,
        enableWorktree: fEnableWorktree,
        env: Object.fromEntries(
          fEnv.map((r) => [r.key.trim(), r.value]).filter(([k]) => k),
        ),
      };
      return editing
        ? api(`/agents/${editing.id}`, { method: 'PATCH', body })
        : api('/agents', { method: 'POST', body: { ...body, runnerId } });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents'] });
      setFormOpen(false);
      setEditing(null);
    },
    onError: (e: Error) => message.error(e.message || 'Save failed'),
  });
  const removeAgentMut = useMutation({
    mutationFn: (id: string) => api(`/agents/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['agents'] }),
    onError: (e: Error) => message.error(e.message || 'Delete failed'),
  });

  const openCreate = () => {
    setEditing(null);
    setFName('');
    setFProvider('claude');
    setFModel(prefModel);
    setFMode(prefMode);
    setFEffort('');
    setFAppend('');
    setFWorkDir('');
    setFEnableWorktree(true);
    setFEnv([]);
    setFormOpen(true);
  };
  const openEdit = (a: Agent) => {
    setEditing(a);
    setFName(a.name);
    setFProvider(a.provider ?? 'claude');
    setFModel(a.model ?? DEFAULT_MODEL_BY_PROVIDER[a.provider ?? 'claude'] ?? DEFAULT_MODEL);
    setFMode(a.permissionMode ?? 'dontAsk');
    setFEffort(a.effort ?? '');
    setFAppend(a.appendSystemPrompt ?? '');
    setFWorkDir(a.workDir ?? '');
    setFEnableWorktree(a.enableWorktree ?? true);
    setFEnv(Object.entries(a.env ?? {}).map(([key, value]) => ({ key, value })));
    setFormOpen(true);
  };
  const submitAgent = () => {
    if (fName.trim()) saveMut.mutate();
  };
  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
  };

  // In-place agent editor — rendered as a card in the list (top for create, in
  // the row itself for edit) instead of a modal, so the runner + agent list stay
  // in view while you edit.
  const agentForm = (mode: 'create' | 'edit') => (
    <div className={`rd-agent-form${mode === 'create' ? ' rd-agent-form-new' : ''}`}>
      <div className="rd-form-grid">
        <div className="rd-form-field">
          <div className="rd-form-label">Name</div>
          <Input
            value={fName}
            onChange={(e) => setFName(e.target.value)}
            onPressEnter={submitAgent}
            placeholder="e.g. tea-cli builder"
            maxLength={60}
            autoFocus
          />
        </div>
        <div className="rd-form-field">
          <div className="rd-form-label">Runtime</div>
          <Select
            value={fProvider}
            onChange={onProviderChange}
            options={PROVIDER_OPTIONS}
            style={{ width: '100%' }}
          />
        </div>
        <div className="rd-form-field">
          <div className="rd-form-label">Model</div>
          <Select
            value={fModel}
            onChange={onModelChange}
            options={modelOptionsForProvider(fProvider)}
            style={{ width: '100%' }}
          />
        </div>
        <div className="rd-form-field">
          <div className="rd-form-label">Permission mode</div>
          <Select
            value={fMode}
            onChange={setFMode}
            options={MODE_OPTIONS.filter(
              (o) => o.value !== 'auto' || AUTO_CAPABLE_MODELS.has(fModel),
            )}
            style={{ width: '100%' }}
          />
        </div>
        <div className="rd-form-field">
          <div className="rd-form-label">Reasoning effort</div>
          <Select
            value={fEffort}
            onChange={setFEffort}
            options={effortOptionsForProvider(fProvider)}
            style={{ width: '100%' }}
          />
        </div>
        <div className="rd-form-field">
          <div className="rd-form-label">Working directory</div>
          <Input
            value={fWorkDir}
            onChange={(e) => setFWorkDir(e.target.value)}
            placeholder="/path/to/project on the runner (optional)"
          />
        </div>
      </div>
      <div className="rd-form-field">
        <div className="rd-form-label">Worktree isolation</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Switch checked={fEnableWorktree} onChange={setFEnableWorktree} />
          <span style={{ fontSize: 12, opacity: 0.65 }}>
            Run each session in its own git worktree. Off → sessions run directly in the working
            directory with no isolation.
          </span>
        </div>
      </div>
      <div className="rd-form-field">
        <div className="rd-form-label">Environment variables</div>
        {fEnv.map((row, i) => (
          <div className="rd-env-row" key={i}>
            <Input
              value={row.key}
              onChange={(e) =>
                setFEnv(fEnv.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))
              }
              placeholder="KEY"
            />
            <Input
              value={row.value}
              onChange={(e) =>
                setFEnv(fEnv.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))
              }
              placeholder="value"
            />
            <Button
              type="text"
              icon={<DeleteOutlined />}
              onClick={() => setFEnv(fEnv.filter((_, j) => j !== i))}
            />
          </div>
        ))}
        <Button
          type="dashed"
          icon={<PlusOutlined />}
          onClick={() => setFEnv([...fEnv, { key: '', value: '' }])}
          block
        >
          Add variable
        </Button>
      </div>
      <div className="rd-form-field">
        <div className="rd-form-label">Instructions</div>
        <Input.TextArea
          value={fAppend}
          onChange={(e) => setFAppend(e.target.value)}
          rows={4}
          placeholder="Added to this agent's system prompt on every run (optional)"
        />
      </div>
      <div className="rd-form-actions">
        <Button onClick={closeForm}>Cancel</Button>
        <Button
          type="primary"
          onClick={submitAgent}
          loading={saveMut.isPending}
          disabled={!fName.trim()}
        >
          {mode === 'create' ? 'Create' : 'Save'}
        </Button>
      </div>
    </div>
  );

  // One agent row — shown on its own, or kept as the header above the in-place
  // editor. While this row is being edited, the pencil toggles the editor closed.
  const agentRow = (a: Agent) => {
    // When an agent overrides the endpoint/model via env (e.g. a DeepSeek-compatible
    // base URL), the static `model` field is stale — show the effective model instead.
    const effectiveModel = a.env?.ANTHROPIC_MODEL || a.model || DEFAULT_MODEL;
    const providerLabel = a.provider === 'codex' ? 'Codex' : 'Claude';
    return (
    <div key={a.id} className="rd-agent-row">
      <span className="rd-agent-ico">
        <RobotOutlined />
      </span>
      <div className="rd-agent-main">
        <div className="rd-agent-name">
          {a.name}
          {a.enabled === false && <Tag style={{ marginLeft: 8 }}>disabled</Tag>}
        </div>
        <div className="rd-agent-meta">
          {providerLabel} · {effectiveModel}
          {a.workDir ? ` · ${a.workDir}` : ''}
        </div>
      </div>
      <Button
        size="small"
        icon={<MessageOutlined />}
        onClick={() => navigate(`/agents/${encodeId(a.id)}`)}
      >
        Chat
      </Button>
      <Dropdown
        trigger={['click']}
        placement="bottomRight"
        menu={{
          items: [
            {
              key: 'edit',
              icon: <EditOutlined />,
              label: editing?.id === a.id ? 'Close editor' : 'Edit',
              onClick: () => (editing?.id === a.id ? closeForm() : openEdit(a)),
            },
            { type: 'divider' },
            {
              key: 'delete',
              icon: <DeleteOutlined />,
              label: 'Delete',
              danger: true,
              onClick: () =>
                modal.confirm({
                  title: `Delete agent “${a.name}”?`,
                  content:
                    'This removes the agent from your list. Its sessions and tasks are kept and stay linked to it.',
                  okText: 'Delete',
                  okButtonProps: { danger: true },
                  cancelText: 'Cancel',
                  autoFocusButton: 'cancel',
                  onOk: () => removeAgentMut.mutateAsync(a.id),
                }),
            },
          ],
        }}
      >
        <Button size="small" type="text" icon={<MoreOutlined />} title="Actions" />
      </Dropdown>
    </div>
    );
  };

  if (runners.isLoading) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }
  if (!runner) {
    return (
      <div className="runners-empty">
        Runner not found —{' '}
        <span className="rd-link" onClick={() => navigate('/runners')}>
          back to Runners
        </span>
        .
      </div>
    );
  }

  const kebab: MenuProps['items'] = [
    {
      key: 'rename',
      icon: <EditOutlined />,
      label: 'Rename',
      onClick: () => {
        setRenameVal(runner.displayName || runner.name);
        setRenaming(true);
      },
    },
    {
      key: 'slots',
      icon: <ThunderboltOutlined />,
      label: 'Set max concurrent',
      onClick: () => {
        setSlotsVal(runner.maxConcurrent ?? 1);
        setSlotsOpen(true);
      },
    },
    { type: 'divider' },
    {
      key: 'delete',
      icon: <DeleteOutlined />,
      label: 'Delete',
      danger: true,
      onClick: () =>
        modal.confirm({
          title: `Delete “${runner.displayName || runner.name}”?`,
          content:
            'This removes the runner and its agents from your account. Re-register the machine to add it back.',
          okText: 'Delete',
          okButtonProps: { danger: true },
          cancelText: 'Cancel',
          onOk: () => deleteMut.mutateAsync(),
        }),
    },
  ];

  return (
    <>
      <div className="rd-page">
      <div className="rd-head">
        <span className="rd-back" onClick={() => navigate('/runners')}>
          <ArrowLeftOutlined /> Runners
        </span>
      </div>

      <div className="rd-title-row">
        <span
          className="runner-dot"
          style={{ background: runner.online ? 'var(--success-solid)' : 'var(--dot-idle)' }}
          title={runner.online ? 'Online' : 'Offline'}
        />
        <h1 className="page-title" style={{ margin: 0 }}>
          {runner.displayName || runner.name}
        </h1>
        <span className="rd-sub">
          {runner.online ? 'Online' : 'Offline'}
          {typeof runner.maxConcurrent === 'number' ? ` · ${runner.maxConcurrent} slots` : ''}
        </span>
        <div style={{ flex: 1 }} />
        <Dropdown trigger={['click']} placement="bottomRight" menu={{ items: kebab }}>
          <Button icon={<MoreOutlined />}>Actions</Button>
        </Dropdown>
      </div>

      <section className="rd-section">
        <div className="rd-section-title">Overview</div>
        <div className="rd-overview">
          <RdField label="Status" value={runner.online ? 'Online' : 'Offline'} />
          <RdField label="Machine name" value={runner.name} />
          <RdField label="Hostname" value={runner.hostname || '—'} />
          <RdField label="Version" value={runner.version || '—'} />
          <RdField label="Slots (max concurrent)" value={String(runner.maxConcurrent ?? '—')} />
          <RdField label="Labels" value={runner.labels?.length ? runner.labels.join(', ') : '—'} />
          <RdField label="Last heartbeat" value={fmtTime(runner.lastHeartbeatAt)} />
          <RdField label="Enrolled" value={fmtTime(runner.enrolledAt)} />
        </div>
      </section>

      {runner.planUsage && <PlanUsageSection usage={runner.planUsage} />}

      <section className="rd-section">
        <div className="rd-section-head">
          <div className="rd-section-title">Agents</div>
          {!formOpen && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              Add agent
            </Button>
          )}
        </div>
        {agentsQ.isLoading ? (
          <div style={{ padding: 24, textAlign: 'center' }}>
            <Spin />
          </div>
        ) : agents.length === 0 && !(formOpen && !editing) ? (
          <div className="rd-empty">
            No agents under this runner yet — add one to start a conversation.
          </div>
        ) : (
          <div className="rd-agent-list">
            {formOpen && !editing && (
              <div className="rd-agent-form-wrap">{agentForm('create')}</div>
            )}
            {agents.map((a) =>
              formOpen && editing?.id === a.id ? (
                <div key={a.id} className="rd-agent-editing">
                  {agentRow(a)}
                  <div className="rd-agent-form-wrap">{agentForm('edit')}</div>
                </div>
              ) : (
                agentRow(a)
              ),
            )}
          </div>
        )}
      </section>
      </div>

      <Modal
        title="Rename runner"
        open={renaming}
        okText="Save"
        cancelText="Cancel"
        confirmLoading={renameMut.isPending}
        onOk={() => renameMut.mutate(renameVal.trim())}
        onCancel={() => setRenaming(false)}
        destroyOnClose
      >
        <Input
          value={renameVal}
          onChange={(e) => setRenameVal(e.target.value)}
          onPressEnter={() => renameMut.mutate(renameVal.trim())}
          placeholder={runner.name}
          maxLength={60}
          autoFocus
        />
        <div style={{ marginTop: 8, color: 'var(--text-3)', fontSize: 12 }}>
          Leave empty to use the machine name ({runner.name}).
        </div>
      </Modal>

      <Modal
        title="Set max concurrent"
        open={slotsOpen}
        okText="Save"
        cancelText="Cancel"
        confirmLoading={slotsMut.isPending}
        okButtonProps={{ disabled: slotsVal == null }}
        onOk={() => slotsVal != null && slotsMut.mutate(slotsVal)}
        onCancel={() => setSlotsOpen(false)}
        destroyOnClose
      >
        <InputNumber
          value={slotsVal}
          onChange={(v) => setSlotsVal(v)}
          min={1}
          max={64}
          precision={0}
          style={{ width: '100%' }}
          autoFocus
        />
        <div style={{ marginTop: 8, color: 'var(--text-3)', fontSize: 12 }}>
          Max sessions this runner runs at once. Takes effect on the next claim — no
          restart needed.
        </div>
      </Modal>

    </>
  );
}

function RdField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rd-field">
      <div className="rd-field-label">{label}</div>
      <div className="rd-field-value">{value}</div>
    </div>
  );
}
