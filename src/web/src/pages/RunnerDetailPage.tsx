import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  MessageOutlined,
  MinusCircleOutlined,
  MoreOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  RobotOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntdApp,
  Button,
  Dropdown,
  Input,
  InputNumber,
  Modal,
  Spin,
  Switch,
  Tag,
  type MenuProps,
} from 'antd';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, revokeWorkspacePermissionRule } from '../api';
import { decodeId, encodeId } from '../lib/idCodec';
import { providersQuery, workspacePermissionRulesQuery } from '../lib/queries';
import { RunnerEnginesSection } from '../components/RunnerEnginesSection';
import type { Runner } from '../components/TasksSidePanel';
import { useToast } from '../lib/toast';
import { defaultModelForProvider, mergedProviderOptions } from '../lib/workspaceDefaults';

interface Workspace {
  id: string;
  name: string;
  appendSystemPrompt?: string | null;
  /** What this project last ran on, derived server-side. `provider` is the deprecated alias. */
  lastProvider?: string;
  provider?: string;
  workDir?: string | null;
  env?: Record<string, string> | null;
  runnerId?: string | null;
  enabled?: boolean;
  enableWorktree?: boolean;
  enableOrchestration?: boolean;
  /** Default a new session under this workspace inherits. null = inherit the account default.
   *  The permission mode is deliberately NOT here — it belongs to the run (Session), with an
   *  account-level default. */
  effort?: string | null;
  /** What the runner last saw at `workDir` on its own disk (refreshed each heartbeat). All null =
   *  never probed — an older runner, or one that hasn't reported since this workspace was added. */
  workDirExists?: boolean | null;
  workDirIsGit?: boolean | null;
  workDirProbedAt?: string | null;
  /** The runner `git init`s a non-git workDir on the next run (set by the in-session
   *  "Enable isolation" action), which changes what a non-git path means here. */
  autoInitGit?: boolean;
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

// Runner detail / settings page. Clicking a runner lands here (not the chat
// console) — you manage the runner and the workspaces that run under it. The live
// conversation belongs to a workspace, reached via each workspace's "对话" button.
export function RunnerDetailPage() {
  // /runners/<base62> — decode the route param to the runner's UUID.
  const runnerId = decodeId(useParams().id);
  const navigate = useNavigate();
  const { modal } = AntdApp.useApp();
  const message = useToast();
  const qc = useQueryClient();

  const runners = useQuery({
    queryKey: ['runners'],
    queryFn: () => api<Runner[]>('/runners'),
    refetchInterval: 15_000,
  });
  const runner = (runners.data ?? []).find((r) => r.id === runnerId) ?? null;

  const workspacesQ = useQuery({ queryKey: ['workspaces'], queryFn: () => api<Workspace[]>('/workspaces') });
  const workspaces = (workspacesQ.data ?? []).filter((a) => a.runnerId === runnerId);
  // Configured providers (custom slugs) are used to resolve the provider label and effective
  // Runtime-owned model shown in each workspace row.
  const configuredProviders = useQuery(providersQuery()).data ?? [];

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

  // Add / edit a workspace bound to this runner (controlled inputs, like the
  // rename modal — avoids antd Form instance pitfalls with pre-filled edits).
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Workspace | null>(null);
  const [fName, setFName] = useState('');
  const [fAppend, setFAppend] = useState('');
  const [fWorkDir, setFWorkDir] = useState('');
  const [fEnableWorktree, setFEnableWorktree] = useState(false);
  const [fEnableOrchestration, setFEnableOrchestration] = useState(false);
  const [fEnv, setFEnv] = useState<{ key: string; value: string }[]>([]);
  // The long tail (orchestration / env / instructions) stays folded until asked for, and
  // edits are tracked so Cancel can't discard them silently.
  const [advOpen, setAdvOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  // The runner's read-only diagnostics — folded away so the workspace list owns the first screen.
  const [detailsOpen, setDetailsOpen] = useState(false);

  const saveMut = useMutation({
    mutationFn: () => {
      const body = {
        name: fName.trim(),
        appendSystemPrompt: fAppend.trim() || undefined,
        workDir: fWorkDir.trim() || undefined,
        enableWorktree: fEnableWorktree,
        enableOrchestration: fEnableOrchestration,
        env: Object.fromEntries(
          fEnv.map((r) => [r.key.trim(), r.value]).filter(([k]) => k),
        ),
      };
      return editing
        ? api(`/workspaces/${editing.id}`, { method: 'PATCH', body })
        : api('/workspaces', { method: 'POST', body: { ...body, runnerId } });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workspaces'] });
      setFormOpen(false);
      setEditing(null);
      setDirty(false);
    },
    onError: (e: Error) => message.error(e.message || 'Save failed'),
  });
  // Enable/disable is a one-field PATCH from the row menu, so it doesn't drag the whole
  // editor open just to park a workspace.
  const setEnabledMut = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) =>
      api(`/workspaces/${v.id}`, { method: 'PATCH', body: { enabled: v.enabled } }),
    // Say what it did: disabling now actually refuses work, and a greyed row alone doesn't
    // tell you that. Running sessions are deliberately left alone — this parks the workspace
    // rather than killing what it is already doing.
    onSuccess: (_d, v) => {
      message.success(
        v.enabled
          ? 'Workspace enabled.'
          : 'Workspace disabled — new sessions and task runs are refused. Running sessions continue.',
      );
      void qc.invalidateQueries({ queryKey: ['workspaces'] });
    },
    onError: (e: Error) => message.error(e.message || 'Update failed'),
  });
  const duplicateMut = useMutation({
    mutationFn: (a: Workspace) =>
      api('/workspaces', {
        method: 'POST',
        body: {
          name: `${a.name} copy`,
          appendSystemPrompt: a.appendSystemPrompt ?? undefined,
          workDir: a.workDir ?? undefined,
          enableWorktree: a.enableWorktree ?? false,
          enableOrchestration: a.enableOrchestration ?? false,
          effort: a.effort ?? null,
          env: a.env ?? {},
          runnerId,
        },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['workspaces'] }),
    onError: (e: Error) => message.error(e.message || 'Duplicate failed'),
  });
  const removeWorkspaceMut = useMutation({
    mutationFn: (id: string) => api(`/workspaces/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['workspaces'] }),
    onError: (e: Error) => message.error(e.message || 'Delete failed'),
  });

  // Shared reset for both entry points — every field the form owns is set here, so a stale
  // value from the previous workspace can never leak into the next one.
  const resetForm = (a: Workspace | null) => {
    setEditing(a);
    setFName(a?.name ?? '');
    setFAppend(a?.appendSystemPrompt ?? '');
    setFWorkDir(a?.workDir ?? '');
    setFEnableWorktree(a?.enableWorktree ?? false);
    setFEnableOrchestration(a?.enableOrchestration ?? false);
    setFEnv(Object.entries(a?.env ?? {}).map(([key, value]) => ({ key, value })));
    setAdvOpen(false);
    setDirty(false);
    setFormOpen(true);
  };
  const openCreate = () => resetForm(null);
  const openEdit = (a: Workspace) => resetForm(a);
  const submitWorkspace = () => {
    if (fName.trim()) saveMut.mutate();
  };
  const discard = () => {
    setFormOpen(false);
    setEditing(null);
    setDirty(false);
  };
  // Closing over unsaved edits asks first; an untouched form closes straight away.
  const closeForm = () => {
    if (!dirty) return discard();
    modal.confirm({
      title: 'Discard unsaved changes?',
      content: "This workspace's edits haven't been saved yet.",
      okText: 'Discard',
      okButtonProps: { danger: true },
      cancelText: 'Keep editing',
      autoFocusButton: 'cancel',
      onOk: discard,
    });
  };
  // Switching to another workspace (or to the create form) goes through the same guard.
  const switchTo = (open: () => void) => {
    if (!dirty) return open();
    modal.confirm({
      title: 'Discard unsaved changes?',
      content: "This workspace's edits haven't been saved yet.",
      okText: 'Discard',
      okButtonProps: { danger: true },
      cancelText: 'Keep editing',
      autoFocusButton: 'cancel',
      onOk: open,
    });
  };

  // A configured provider shows its own label; fall back to the raw slug if it's since been
  // removed/disabled (so nothing silently mislabels it as Claude).
  const providerLabelFor = (slug: string) =>
    mergedProviderOptions(configuredProviders).find((p) => p.value === slug)?.label ?? slug;

  // In-place workspace editor — rendered as a card in the list (top for create, in
  // the row itself for edit) instead of a modal, so the runner + workspace list stay
  // in view while you edit.
  const workspaceForm = (mode: 'create' | 'edit') => {
    // The same derivation the row's subtitle uses — what a new session here would start on.
    const formProvider = editing?.lastProvider ?? editing?.provider ?? 'claude';
    const formModel = defaultModelForProvider(
      formProvider,
      runner?.modelCatalog,
      configuredProviders,
      runner?.runtimeDefaultModels,
    );
    // Folded away, the disclosure still has to say whether anything is hidden behind it.
    const advCount = (fEnv.length ? 1 : 0) + (fAppend.trim() ? 1 : 0);
    // What the runner last found at this path. It answers for the *saved* path, so an edited
    // field says so instead of showing a verdict about a directory that is no longer named
    // here — a stale ✓ against a typo would be worse than no answer at all.
    const pathHint = (() => {
      if (!editing || !fWorkDir.trim()) return null;
      if (fWorkDir.trim() !== (editing.workDir ?? '').trim()) {
        return { tone: 'muted', text: 'Checked on the runner within a minute of saving.' };
      }
      if (!editing.workDirProbedAt) return null;
      if (editing.workDirExists === false) {
        return { tone: 'warn', text: `No such directory on ${runner?.displayName || runner?.name}.` };
      }
      if (editing.workDirExists && editing.workDirIsGit === false) {
        // Only a problem if isolation is on: that's the setting with a git precondition.
        if (!fEnableWorktree) return { tone: 'muted', text: 'Found · not a git repository.' };
        return editing.autoInitGit
          ? { tone: 'muted', text: 'Found · not a git repository yet — the next run initializes one.' }
          : {
              tone: 'warn',
              text: 'Found, but not a git repository — sessions will share it instead of isolating.',
            };
      }
      if (editing.workDirIsGit) return { tone: 'ok', text: 'Found · git repository.' };
      return null;
    })();
    return (
    <div className={`rd-workspace-form${mode === 'create' ? ' rd-workspace-form-new' : ''}`}>
      <div className="rd-form-section">Essentials</div>
      <div className="rd-form-grid">
        <div className="rd-form-field">
          <div className="rd-form-label">Name</div>
          <Input
            value={fName}
            onChange={(e) => {
              setFName(e.target.value);
              setDirty(true);
            }}
            onPressEnter={submitWorkspace}
            placeholder="e.g. tea-cli builder"
            maxLength={60}
            autoFocus
          />
        </div>
        <div className="rd-form-field">
          <div className="rd-form-label">Working directory</div>
          <Input
            value={fWorkDir}
            onChange={(e) => {
              setFWorkDir(e.target.value);
              setDirty(true);
            }}
            placeholder="/path/to/project on the runner (optional)"
          />
          {pathHint && (
            <div className={`rd-path-hint rd-path-${pathHint.tone}`}>
              {pathHint.tone === 'ok' ? (
                <CheckCircleOutlined />
              ) : pathHint.tone === 'warn' ? (
                <WarningOutlined />
              ) : (
                <ClockCircleOutlined />
              )}
              {pathHint.text}
            </div>
          )}
        </div>
      </div>
      <SettingRow
        label="Worktree isolation"
        desc="Each session runs in its own git worktree. Off → sessions run directly in the working directory, sharing it."
        checked={fEnableWorktree}
        onChange={(v) => {
          setFEnableWorktree(v);
          setDirty(true);
        }}
      />

      {/* Sits beside isolation rather than under Advanced: both answer "what is this workspace
          allowed to do", and this is the one with a security consequence — a workspace that can
          drive other sessions shouldn't be a setting you have to go looking for. */}
      <SettingRow
        label="Session orchestration"
        desc="Let this workspace's sessions spawn and manage other sessions via the orbit MCP session tools. Off → those tools are hidden and refused. Enable only for trusted orchestrator workspaces."
        checked={fEnableOrchestration}
        onChange={(v) => {
          setFEnableOrchestration(v);
          setDirty(true);
        }}
      />

      {/* Model is not a workspace field: it resolves from the runtime/provider this project last
          ran on. Stated read-only because the row displays it — otherwise it reads as a setting
          someone forgot to make editable. Mode and effort are deliberately not here: they are
          per-session choices, made in the session where the context for them is. */}
      <div className="rd-form-derived">
        Model <b>{formModel || '—'}</b> · resolved by {providerLabelFor(formProvider)} on this
        runner. Pick a different one from the session composer.
      </div>

      <div
        className={`rd-adv-toggle${advOpen ? ' open' : ''}`}
        onClick={() => setAdvOpen(!advOpen)}
      >
        <DownOutlined className="rd-adv-caret" /> Advanced
        {advCount > 0 && !advOpen && <span className="rd-adv-badge">{advCount} configured</span>}
      </div>
      {advOpen && (
        <div className="rd-adv-body">
          <div className="rd-form-field">
            <div className="rd-form-label">Environment variables</div>
            {fEnv.map((row, i) => (
              <div className="rd-env-row" key={i}>
                <Input
                  value={row.key}
                  onChange={(e) => {
                    setFEnv(fEnv.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)));
                    setDirty(true);
                  }}
                  placeholder="KEY"
                />
                {/* These commonly hold tokens, so the value is masked until asked for. */}
                <Input.Password
                  value={row.value}
                  onChange={(e) => {
                    setFEnv(fEnv.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)));
                    setDirty(true);
                  }}
                  placeholder="value"
                />
                <Button
                  type="text"
                  title="Remove"
                  icon={<DeleteOutlined />}
                  onClick={() => {
                    setFEnv(fEnv.filter((_, j) => j !== i));
                    setDirty(true);
                  }}
                />
              </div>
            ))}
            <Button
              type="dashed"
              icon={<PlusOutlined />}
              onClick={() => {
                setFEnv([...fEnv, { key: '', value: '' }]);
                setDirty(true);
              }}
              block
            >
              Add variable
            </Button>
          </div>
          <div className="rd-form-field">
            <div className="rd-form-label">Instructions</div>
            <Input.TextArea
              value={fAppend}
              onChange={(e) => {
                setFAppend(e.target.value);
                setDirty(true);
              }}
              rows={4}
              placeholder="Added to this workspace's system prompt on every run (optional)"
            />
          </div>
          {/* Only for a saved workspace: grants are recorded against a workspace that exists,
              so there is nothing to show (or revoke) while one is being created. */}
          {editing && <WorkspacePermissionRules workspaceId={editing.id} />}
        </div>
      )}
      <div className="rd-form-actions">
        {mode === 'edit' && editing && (
          <Button
            type="text"
            className="rd-quiet-btn"
            icon={editing.enabled === false ? <PlayCircleOutlined /> : <MinusCircleOutlined />}
            loading={setEnabledMut.isPending}
            onClick={() =>
              setEnabledMut.mutate({ id: editing.id, enabled: editing.enabled === false })
            }
          >
            {editing.enabled === false ? 'Enable workspace' : 'Disable workspace'}
          </Button>
        )}
        <div style={{ flex: 1 }} />
        {dirty && <span className="rd-dirty-note">Unsaved changes</span>}
        <Button onClick={closeForm}>Cancel</Button>
        <Button
          type="primary"
          onClick={submitWorkspace}
          loading={saveMut.isPending}
          disabled={!fName.trim()}
        >
          {mode === 'create' ? 'Create' : 'Save'}
        </Button>
      </div>
    </div>
    );
  };

  // One workspace row — shown on its own, or kept as the header above the in-place editor.
  // The whole row is the way into the config: it is what people aim at, and the settings it
  // displays are the ones the editor holds. There is deliberately no console button here —
  // the sidebar lists every workspace and opens its console in one click, and this page exists to
  // manage the machine, not to talk to it. A second, smaller target for a different
  // destination on the same row only made the row harder to aim at; the console stays
  // reachable from the row menu.
  const workspaceRow = (a: Workspace) => {
    // What this project last ran on — the same default a new session here would inherit.
    const lastProvider = a.lastProvider ?? a.provider ?? 'claude';
    const effectiveModel = defaultModelForProvider(
      lastProvider,
      runner?.modelCatalog,
      configuredProviders,
      runner?.runtimeDefaultModels,
    );
    const isOpen = formOpen && editing?.id === a.id;
    return (
    <div
      key={a.id}
      className={`rd-workspace-row${isOpen ? ' is-open' : ''}${a.enabled === false ? ' is-disabled' : ''}`}
      onClick={() => (isOpen ? closeForm() : switchTo(() => openEdit(a)))}
    >
      <span className="rd-workspace-ico">
        <RobotOutlined />
      </span>
      <div className="rd-workspace-main">
        <div className="rd-workspace-name">
          {a.name}
          {a.enabled === false && <Tag style={{ marginLeft: 8 }}>disabled</Tag>}
        </div>
        <div className="rd-workspace-meta">
          {providerLabelFor(lastProvider)} · {effectiveModel}
          {a.workDir ? ` · ${a.workDir}` : ''}
          {a.enableWorktree ? ' · isolated' : ''}
        </div>
      </div>
      <Dropdown
        trigger={['click']}
        placement="bottomRight"
        menu={{
          items: [
            {
              key: 'edit',
              icon: <EditOutlined />,
              label: isOpen ? 'Close editor' : 'Configure',
              onClick: () => (isOpen ? closeForm() : switchTo(() => openEdit(a))),
            },
            {
              key: 'console',
              icon: <MessageOutlined />,
              label: 'Open console',
              onClick: () => navigate(`/workspaces/${encodeId(a.id)}`),
            },
            {
              key: 'enabled',
              icon: a.enabled === false ? <PlayCircleOutlined /> : <MinusCircleOutlined />,
              label: a.enabled === false ? 'Enable' : 'Disable',
              onClick: () => setEnabledMut.mutate({ id: a.id, enabled: a.enabled === false }),
            },
            {
              key: 'duplicate',
              icon: <CopyOutlined />,
              label: 'Duplicate',
              onClick: () => duplicateMut.mutate(a),
            },
            { type: 'divider' },
            {
              key: 'delete',
              icon: <DeleteOutlined />,
              label: 'Delete',
              danger: true,
              onClick: () =>
                modal.confirm({
                  title: `Delete workspace “${a.name}”?`,
                  content:
                    'The workspace leaves your list but is not erased — its sessions and tasks are kept and stay linked to it. To park one you still use, disable it instead.',
                  okText: 'Delete',
                  okButtonProps: { danger: true },
                  cancelText: 'Cancel',
                  autoFocusButton: 'cancel',
                  onOk: () => removeWorkspaceMut.mutateAsync(a.id),
                }),
            },
          ],
        }}
      >
        <Button
          size="small"
          type="text"
          icon={<MoreOutlined />}
          title="Actions"
          onClick={(e) => e.stopPropagation()}
        />
      </Dropdown>
      {/* A quiet affordance: it only shows on hover, or while this row's editor is open. */}
      <DownOutlined className="rd-row-caret" />
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
            'This removes the runner and its workspaces from your account. Re-register the machine to add it back.',
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
        <div style={{ flex: 1 }} />
        <Dropdown trigger={['click']} placement="bottomRight" menu={{ items: kebab }}>
          <Button icon={<MoreOutlined />}>Actions</Button>
        </Dropdown>
      </div>

      {/* The machine's read-only diagnostics are reference material, not the job: they ride on
          one line under the title so the workspace list — the thing this page is for — starts above
          the fold. The full grid is one click away. */}
      <div className="rd-metaline">
        <span className={runner.online ? 'rd-meta-ok' : undefined}>
          {runner.online ? 'Online' : 'Offline'}
        </span>
        {typeof runner.maxConcurrent === 'number' && <span>{runner.maxConcurrent} slots</span>}
        {typeof runner.activeSessions === 'number' && runner.activeSessions > 0 && (
          <span>{runner.activeSessions} running</span>
        )}
        {runner.version && <span>v{runner.version}</span>}
        {runner.hostname && <span>{runner.hostname}</span>}
        <span
          className={`rd-details-toggle${detailsOpen ? ' open' : ''}`}
          onClick={() => setDetailsOpen(!detailsOpen)}
        >
          Details <DownOutlined className="rd-details-caret" />
        </span>
      </div>
      {detailsOpen && (
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
      )}

      {/* What software this machine runs and whether it's current — the same class of fact as the
          runner version on the meta line above, which is why updating them lives here and not on
          the Providers page. */}
      <RunnerEnginesSection runner={runner} />

      <section className="rd-section">
        <div className="rd-section-head">
          <div className="rd-section-title">Workspaces</div>
          {/* Kept in place while the create form is open — disabled rather than removed, so the
              header doesn't reflow out from under the pointer. */}
          <Button
            type="primary"
            icon={<PlusOutlined />}
            disabled={formOpen && !editing}
            onClick={() => switchTo(openCreate)}
          >
            Add workspace
          </Button>
        </div>
        {workspacesQ.isLoading ? (
          <div style={{ padding: 24, textAlign: 'center' }}>
            <Spin />
          </div>
        ) : workspaces.length === 0 && !(formOpen && !editing) ? (
          <div className="rd-empty">
            No workspaces under this runner yet — add one to start a conversation.
          </div>
        ) : (
          <div className="rd-workspace-list">
            {formOpen && !editing && (
              <div className="rd-workspace-form-wrap">{workspaceForm('create')}</div>
            )}
            {workspaces.map((a) =>
              formOpen && editing?.id === a.id ? (
                <div key={a.id} className="rd-workspace-editing">
                  {workspaceRow(a)}
                  <div className="rd-workspace-form-wrap">{workspaceForm('edit')}</div>
                </div>
              ) : (
                workspaceRow(a)
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

/**
 * What this workspace's sessions no longer ask about — the "always allow" answers that outlived
 * the session they were given in.
 *
 * Read-and-revoke only: a grant is never created here, it is created by answering an approval
 * with "always allow". So revoking acts immediately instead of joining the form's dirty/Save
 * cycle — the point of showing them is that a standing grant can be taken back, and a Save
 * button between the user and that is one step too many.
 */
function WorkspacePermissionRules({ workspaceId }: { workspaceId: string }) {
  const qc = useQueryClient();
  const message = useToast();
  const rules = useQuery(workspacePermissionRulesQuery(workspaceId));
  const revokeMut = useMutation({
    mutationFn: (ruleId: string) => revokeWorkspacePermissionRule(workspaceId, ruleId),
    onSuccess: () =>
      void qc.invalidateQueries({
        queryKey: workspacePermissionRulesQuery(workspaceId).queryKey,
      }),
    onError: (e: Error) => message.error(e.message || 'Revoke failed'),
  });
  const rows = rules.data ?? [];
  return (
    <div className="rd-form-field">
      <div className="rd-form-label">Always allowed</div>
      {rules.isLoading ? (
        <Spin size="small" />
      ) : rows.length === 0 ? (
        <div className="rd-rule-empty">
          Nothing yet. Answering an approval with “always allow” records it here, and this
          workspace's sessions stop asking about that call.
        </div>
      ) : (
        <>
          {rows.map((rule) => (
            <div className="rd-rule-row" key={rule.id}>
              <code className="rd-rule-token">
                {rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName}
              </code>
              <Button
                type="text"
                title="Ask about this again"
                icon={<DeleteOutlined />}
                loading={revokeMut.isPending && revokeMut.variables === rule.id}
                onClick={() => revokeMut.mutate(rule.id)}
              />
            </div>
          ))}
          {/* Says where it does NOT apply, because the alternative is a user reading this list
              as the whole truth about a Codex or OpenCode session. */}
          <div className="rd-rule-empty">
            Applied when the session runs on Claude, from its next start on.
          </div>
        </>
      )}
    </div>
  );
}

/** A toggle laid out as a settings row: name and explanation on the left, control right-aligned.
 *  The old inline form put a wall of description text beside the switch, which read heavier than
 *  the labels of the fields above it. */
function SettingRow({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="rd-set-row">
      <div className="rd-set-main">
        <div className="rd-set-label">{label}</div>
        <div className="rd-set-desc">{desc}</div>
      </div>
      <Switch checked={checked} onChange={onChange} />
    </div>
  );
}
