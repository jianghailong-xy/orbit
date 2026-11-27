import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CopyOutlined,
  DeleteOutlined,
  ImportOutlined,
  MessageOutlined,
  MoreOutlined,
  PlusOutlined,
  RightOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { machineName, newWorkspaceOf, type PickedFolder } from '../../lib/machineSetup';
import { startHistoryImport, useClaudeHistory } from '../../lib/claudeHistoryImport';
import { managedRowOf, useManagedRunner, useManagedRunnerId } from '../../lib/managedRunner';
import type { SessionReach } from '../../lib/sessionReach';
import { type MainCheckoutRepoHealth, type RunnerRepoHealth, type WorkspaceLandingMode, type WorkspaceLandingView } from '@orbit/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  api,
  cleanUpWorkspaceRepo,
  countImportedSessions,
  removeImportedSessions,
  revokeWorkspacePermissionRule,
  type ClaudeHistoryResult,
} from '../../api';
import { encodeId, routeId } from '../../lib/idCodec';
import type { MainCheckoutTarget } from '../../lib/mainCheckout';
import {
  meQuery,
  providersQuery,
  runnersQuery,
  sessionsQuery,
  workspacePermissionRulesQuery,
  workspacesQuery,
} from '../../lib/queries';
import { REPO_CLEANUP_QUEUED, repoCleanupConfirm } from '../../lib/repoCleanup';
import { runnerIsOffline } from '../../lib/runnerAttention';
import { ago } from '../../lib/runnerEngines';
import { CLAUDE_SESSION_ID_RE, importClaudeSessionAndWait } from '../../lib/sessionImport';
import { defaultModelLabel, engineVia } from '../../lib/sessionProviderChoices';
import { useToast } from '../../lib/toast';
import { useRefreshSessionLists } from '../../lib/useControlPlane';
import { sessionEngineOf } from '../../lib/workspaceDefaults';
import { AccountSelect, offersAccount } from '../AccountSelect';
import { AUTO_COMPACT_VARIABLE, AutoCompactSelect, withAutoCompact } from '../AutoCompactSelect';
import { ClaudeHistoryOffer, type ImportMode } from '../ClaudeHistoryOffer';
import { useMainCheckoutController } from '../MainCheckoutDrawer';
import { MachineSetupCard, type HistoryChoice } from '../MachineSetupCard';
import type { Runner } from '../TasksSidePanel';
import { Button } from '../ui/Button';
import { useConfirm } from '../ui/ConfirmDialog';
import { Drawer } from '../ui/Drawer';
import { Input } from '../ui/Input';
import { Menu } from '../ui/Menu';
import { PasswordInput } from '../ui/PasswordInput';
import { Spinner } from '../ui/Spinner';
import { Switch } from '../ui/Switch';
import { Textarea } from '../ui/Textarea';
import { Tooltip } from '../ui/Tooltip';
import { SubagentSettings } from '../SubagentSettings';
import {
  WorktreeIsolationDialog,
  worktreeIsolationDialogFor,
  type WorktreeIsolationDialogKind,
} from '../WorktreeIsolationDialog';
import { WorkspaceLandingSetting } from './WorkspaceLandingSetting';
import { SettingsCard, SettingsHeader, SettingsRow, SettingsSection } from './SettingsBlocks';
import { AgentToolsDrawer } from '../AgentToolsDrawer';
import './Settings.css';

/** `owner/repo` of a GitHub URL, for words that name the repository. */
function repoSlug(url: string | null | undefined): string | null {
  const match = /github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?\/?$/.exec(url ?? '');
  return match ? match[1] : null;
}

export interface SettingsWorkspace {
  id: string;
  name: string;
  appendSystemPrompt?: string | null;
  /** Base instructions, in place of the engine's own prompt (agent_update's systemPrompt); rarely set. */
  systemPrompt?: string | null;
  /** What this project last ran on, derived server-side: the engine and the provider of its last
   *  interactive session. `provider` is the deprecated alias of `lastProvider`. */
  lastEngine?: string | null;
  lastProvider?: string;
  provider?: string;
  workDir?: string | null;
  /** Repository for project integration, entered here or detected from the checkout's origin. */
  repoUrl?: string | null;
  env?: Record<string, string> | null;
  /** Which account on its runner this workspace's sessions of each engine run on: the id of a slot the
   *  runner added. null = Default (or Automatic, where the runner has more than one). */
  codexAccount?: string | null;
  claudeAccount?: string | null;
  antigravityAccount?: string | null;
  kimiAccount?: string | null;
  cursorAccount?: string | null;
  runnerId?: string | null;
  runner?: { id: string; name?: string; displayName?: string | null } | null;
  enabled?: boolean;
  enableWorktree?: boolean;
  /** SubAgents (docs/subagent-design.md §7): on by default, 4 of one session's at once. */
  subagentsEnabled?: boolean;
  subagentsMaxRunning?: number;
  /** Workflows (docs/subagent-workflow-design.md §6): on by default; it takes SubAgents on as well. */
  workflowsEnabled?: boolean;
  effort?: string | null;
  /** What the runner last saw at `workDir` on its own disk (refreshed each heartbeat). */
  workDirExists?: boolean | null;
  workDirIsGit?: boolean | null;
  workDirProbedAt?: string | null;
  repoHealth?: RunnerRepoHealth | null;
  /** The runner declares main-checkout-git/v1: the main checkout's Review files can act. */
  mainCheckoutActions?: boolean;
  autoInitGit?: boolean;
  /** When a conversation last started or took a turn here (server: lastActiveByWorkspace). */
  lastActiveAt?: string | null;
  /** Its conversations, read on GET /workspaces/:id only. */
  sessionCount?: number;
  /** What the owner chose; written by PATCH, read back as `landing.mode`. */
  landingMode?: WorkspaceLandingMode;
  /** The landing setting, on GET /workspaces/:id only (docs/design/protected-branch-landing.md §8). */
  landing?: WorkspaceLandingView;
  createdAt?: string;
}

/** The fields a row saves: one at a time, each in its own PATCH (owner's choice D1). */
type WorkspacePatch = Partial<
  Pick<
    SettingsWorkspace,
    | 'name'
    | 'workDir'
    | 'repoUrl'
    | 'landingMode'
    | 'enableWorktree'
    | 'subagentsEnabled'
    | 'subagentsMaxRunning'
    | 'workflowsEnabled'
    | 'env'
    | 'appendSystemPrompt'
    | 'enabled'
    | 'codexAccount'
    | 'claudeAccount'
    | 'antigravityAccount'
    | 'kimiAccount'
    | 'cursorAccount'
  >
>;

/** A machine as the app names it: Orbit Cloud for the account's managed runner (machineName). */
const runnerName = (
  runner: { id?: string; name?: string; displayName?: string | null } | null | undefined,
  managedRunnerId: string | null,
): string => (runner ? machineName(runner, managedRunnerId) : '');

/**
 * /settings/workspaces/:id — one workspace's own Settings page; /settings/workspaces/new, the create
 * flow (machine first, then the folder).
 */
export function SettingsWorkspacePage() {
  const { id } = useParams();
  if (id === 'new') return <NewWorkspacePage />;
  return <WorkspaceSettingsPage key={id} id={routeId(id) ?? ''} />;
}

/**
 * A workspace's Settings page (board-5): Location, Sessions, Agent environment and Danger zone, every
 * row saved on its own (owner's choice D1) — a toggle or select when it changes, a text field on blur
 * or Enter, a drawer on its Save — each with one PATCH carrying only that field.
 */
function WorkspaceSettingsPage({ id }: { id: string }) {
  const managedRunnerId = useManagedRunnerId();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const message = useToast();
  const [confirm, confirmation] = useConfirm();
  const refreshSessionLists = useRefreshSessionLists();

  const workspacesQ = useQuery(workspacesQuery());
  const workspace = (workspacesQ.data as SettingsWorkspace[] | undefined)?.find((w) => w.id === id) ?? null;
  // Its session count is read for this one workspace only (the list does not carry it).
  const detail = useQuery({
    queryKey: ['workspaces', id, 'detail'],
    meta: { entities: ['workspace'] },
    queryFn: () => api<SettingsWorkspace>(`/workspaces/${id}`),
    enabled: !!workspace,
  });
  const runners = (useQuery(runnersQuery()).data ?? []) as Runner[];
  const runner = runners.find((r) => r.id === workspace?.runnerId) ?? null;
  const configuredProviders = useQuery(providersQuery()).data ?? [];
  // The account's switch for smart model selection: off (the default), the workspace has none of it.
  const smartSelection = useQuery(meQuery()).data?.preferences?.modelRouting !== false;
  const rules = useQuery({ ...workspacePermissionRulesQuery(id), enabled: !!workspace });
  const imported = useQuery({
    queryKey: ['imported-sessions', id],
    meta: { entities: ['session'], sessionReach: { workspace: id } satisfies SessionReach },
    queryFn: () => countImportedSessions(id),
    enabled: !!workspace,
  });
  const history = useClaudeHistory(workspace?.runnerId ?? null, workspace?.workDir ?? '', !!workspace);

  const [drawer, setDrawer] = useState<null | 'env' | 'instructions' | 'rules' | 'history' | 'agent-tools'>(null);
  const [dirDraft, setDirDraft] = useState<string | null>(null);

  const patch = useMutation({
    mutationFn: (body: WorkspacePatch) => api<SettingsWorkspace>(`/workspaces/${id}`, { method: 'PATCH', body }),
    // Drawn at once with the new value; put back if the server refuses it.
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: ['workspaces'], exact: true });
      const before = qc.getQueryData<SettingsWorkspace[]>(['workspaces']);
      qc.setQueryData<SettingsWorkspace[]>(['workspaces'], (rows) =>
        rows?.map((row) => (row.id === id ? { ...row, ...body } : row)),
      );
      return { before };
    },
    onSuccess: (_saved, body) => {
      // Disabling says what it does: it refuses new work, and leaves running sessions alone.
      if ('enabled' in body) {
        message.success(
          body.enabled
            ? 'Workspace enabled.'
            : 'Workspace disabled — new sessions and task runs are refused. Running sessions continue.',
        );
      } else message.success('Setting saved');
    },
    onError: (e: Error, body, context) => {
      if (context?.before) qc.setQueryData(['workspaces'], context.before);
      if ('enabled' in body) {
        message.error(body.enabled ? "Couldn't enable the workspace" : "Couldn't disable the workspace", e.message);
      } else message.error("Couldn't save the setting", e.message);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['workspaces'] }),
  });
  const save = (body: WorkspacePatch) => patch.mutate(body);

  const duplicateMut = useMutation({
    mutationFn: (a: SettingsWorkspace) =>
      api('/workspaces', {
        method: 'POST',
        body: {
          name: `${a.name} copy`,
          appendSystemPrompt: a.appendSystemPrompt ?? undefined,
          workDir: a.workDir ?? undefined,
          // Same directory on the same machine, so the remote is the copy's too.
          repoUrl: a.repoUrl ?? undefined,
          enableWorktree: a.enableWorktree ?? false,
          effort: a.effort ?? null,
          env: a.env ?? {},
          // Same machine, so the same account: a copy that fell back to Default would spend another
          // account's quota without anyone having chosen that.
          codexAccount: a.codexAccount ?? null,
          claudeAccount: a.claudeAccount ?? null,
          antigravityAccount: a.antigravityAccount ?? null,
          kimiAccount: a.kimiAccount ?? null,
          cursorAccount: a.cursorAccount ?? null,
          runnerId: a.runnerId,
        },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['workspaces'] }),
    onError: (e: Error) => message.error("Couldn't duplicate the workspace", e.message),
  });
  const removeMut = useMutation({
    mutationFn: () => api(`/workspaces/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workspaces'] });
      navigate(workspace?.runnerId ? `/settings/machines/${workspace.runnerId}` : '/settings/general');
    },
    onError: (e: Error) => message.error("Couldn't delete the workspace", e.message),
  });
  const removeImportedMut = useMutation({
    mutationFn: () => removeImportedSessions(id),
    onSuccess: (res) => {
      message.success(
        res.removed === 1 ? '1 imported conversation removed.' : `${res.removed} imported conversations removed.`,
      );
      void qc.invalidateQueries({ queryKey: ['imported-sessions', id] });
      refreshSessionLists();
    },
    onError: (e: Error) => message.error("Couldn't remove the imported conversations", e.message),
  });
  const repairMut = useMutation({
    mutationFn: () => cleanUpWorkspaceRepo(id),
    onSuccess: () => {
      message.success(REPO_CLEANUP_QUEUED);
      void qc.invalidateQueries({ queryKey: ['workspaces'] });
    },
    onError: (e: Error) => message.error("Couldn't clean up the checkout", e.message),
  });

  // Board 04: the dialog flipping worktree isolation asks first, and the main checkout its Review files opens.
  const [isolationDialog, setIsolationDialog] = useState<WorktreeIsolationDialogKind | null>(null);
  const sessionsQ = useQuery({ ...sessionsQuery({ workspaceId: workspace?.id ?? null, view: 'open' }), enabled: !!workspace });
  const worktrees = useMemo<MainCheckoutTarget[]>(
    () =>
      (sessionsQ.data ?? [])
        .filter((s) => s.isolationStatus === 'worktree' && !!s.branch && s.mergeStatus !== 'merged' && s.branchMerged !== true)
        .map((s) => ({
          id: s.id,
          title: s.title || 'Untitled session',
          branch: s.branch,
          busy: (s.runState ?? s.runStatus ?? s.status) === 'RUNNING',
        })),
    [sessionsQ.data],
  );
  const isolationCheckout = useMainCheckoutController({
    workspaceId: workspace?.id ?? null,
    actionsSupported: workspace?.mainCheckoutActions === true,
    health: (workspace?.repoHealth as MainCheckoutRepoHealth | null | undefined) ?? null,
    targets: worktrees,
  });

  if (workspacesQ.isPending) {
    return (
      <div style={{ padding: 24, textAlign: 'center' }}>
        <Spinner />
      </div>
    );
  }
  if (!workspace) return <p className="settings-empty">This workspace doesn't exist, or isn't yours.</p>;

  const machineName = runnerName(runner ?? workspace.runner, managedRunnerId);
  const sessionCount = detail.data?.sessionCount;
  const lastActiveAt = detail.data?.lastActiveAt ?? workspace.lastActiveAt;
  const headline = [
    machineName ? `On ${machineName}` : 'On no machine',
    typeof sessionCount === 'number' ? (sessionCount === 1 ? '1 session' : `${sessionCount} sessions`) : null,
    lastActiveAt ? `last used ${ago(lastActiveAt, Date.now())}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  // What a new session here starts on — the engine and the provider of the last one here — and the
  // model that resolves to, by its catalogue name.
  const provider = workspace.lastProvider ?? workspace.provider ?? 'claude';
  const engine = sessionEngineOf(workspace.lastEngine, provider, configuredProviders);
  const via = engineVia(engine, provider, configuredProviders);
  const model = defaultModelLabel(engine, provider, runner?.modelCatalog, configuredProviders, runner?.runtimeDefaultModels);

  // What the runner last found at this path. It answers for the *saved* path, so a field being edited
  // says so instead of showing a verdict about a directory that is no longer named here.
  const dir = (dirDraft ?? workspace.workDir ?? '').trim();
  const pathHint = (() => {
    if (!dir) return null;
    if (dir !== (workspace.workDir ?? '').trim()) {
      return { tone: 'muted', text: 'Checked on the runner within a minute of saving.' };
    }
    if (!workspace.workDirProbedAt) return null;
    if (workspace.workDirExists === false) return { tone: 'warn', text: `No such directory on ${machineName}.` };
    if (workspace.workDirExists && workspace.workDirIsGit === false) {
      // Only a problem if isolation is on: that's the setting with a git precondition.
      if (!workspace.enableWorktree) return { tone: 'muted', text: 'Found · not a git repository.' };
      return workspace.autoInitGit
        ? { tone: 'muted', text: 'Found · not a git repository yet — the next run initializes one.' }
        : { tone: 'warn', text: 'Found, but not a git repository — sessions will share it instead of isolating.' };
    }
    if (workspace.workDirIsGit) return { tone: 'ok', text: 'Found · git repository.' };
    return null;
  })();

  // The server refuses isolation on a directory the runner found not to be a repository (WORKTREE_NEEDS_GIT)
  // unless git will be set up there; say so here instead of letting the switch fail.
  const worktreeNeedsGit =
    !workspace.enableWorktree &&
    !!workspace.workDirProbedAt &&
    workspace.workDirExists === true &&
    workspace.workDirIsGit === false &&
    dir === (workspace.workDir ?? '').trim() &&
    !workspace.repoUrl?.trim() &&
    !workspace.autoInitGit;

  const env = workspace.env ?? {};
  const envKeys = Object.keys(env);
  const instructions = workspace.appendSystemPrompt?.trim() ?? '';
  const ruleCount = rules.data?.length ?? 0;
  const importedCount = imported.data?.count ?? 0;
  const accountEngines = (['codex', 'claude', 'antigravity', 'kimi', 'cursor'] as const).filter(
    (e) => runner && offersAccount(runner, e, workspace[`${e}Account`] ?? null),
  );
  const ENV_DIR = {
    codex: 'CODEX_HOME',
    claude: 'CLAUDE_CONFIG_DIR',
    antigravity: 'ORBIT_ANTIGRAVITY_GOOGLE_DIR',
    kimi: 'KIMI_CODE_HOME',
    cursor: 'ORBIT_CURSOR_ACCOUNT_DIR',
  } as const;
  const claudeInstalled = !!runner?.engines?.some((entry) => entry.engine === 'claude' && entry.installed);

  return (
    <div className="settings-page workspace-page">
      <SettingsHeader
        title={workspace.name}
        description={headline}
        action={
          <Menu
            align="end"
            tooltip="Actions"
            items={[
              {
                key: 'console',
                icon: <MessageOutlined />,
                label: 'Open console',
                onSelect: () => navigate(`/workspaces/${encodeId(workspace.id)}`),
              },
              {
                key: 'duplicate',
                icon: <CopyOutlined />,
                label: 'Duplicate',
                onSelect: () => duplicateMut.mutate(workspace),
              },
            ]}
            trigger={<Button icon={<MoreOutlined />} aria-label="Actions" />}
          />
        }
      />

      <SettingsSection title="Location" className="workspace-section-location">
        <SettingsCard>
          <SettingsRow
            anchor="name"
            title="Name"
            control={
              <TextSetting label="Name" value={workspace.name} maxLength={60} onCommit={(name) => save({ name })} />
            }
          />
          <SettingsRow
            title="Machine"
            description="A workspace is a folder on one machine."
            control={
              workspace.runnerId ? (
                <Link className="workspace-machine-link" to={`/settings/machines/${workspace.runnerId}`}>
                  {machineName || 'Machine'} <RightOutlined />
                </Link>
              ) : (
                <span className="settings-row-description">—</span>
              )
            }
          />
          <SettingsRow
            anchor="workDir"
            title="Working directory"
            description={
              pathHint && (
                <span className={`rd-path-hint rd-path-${pathHint.tone}`}>
                  {pathHint.tone === 'ok' ? (
                    <CheckCircleOutlined />
                  ) : pathHint.tone === 'warn' ? (
                    <WarningOutlined />
                  ) : (
                    <ClockCircleOutlined />
                  )}
                  {pathHint.text}
                </span>
              )
            }
            control={
              <TextSetting
                label="Working directory"
                mono
                value={workspace.workDir ?? ''}
                placeholder="/path/to/project on the runner"
                onDraft={setDirDraft}
                onCommit={(workDir) => save({ workDir })}
              />
            }
          />
          <SettingsRow
            title="Repository URL"
            description="Used for project integration. Detected from origin when empty."
            tooltip="Used for project integration. When empty, the runner detects origin on its next directory scan and fills this in. You can also enter the repository URL here."
            control={
              <TextSetting
                label="Repository URL"
                mono
                value={workspace.repoUrl ?? ''}
                placeholder="https://github.com/owner/repo"
                onCommit={(repoUrl) => save({ repoUrl })}
              />
            }
          />
        </SettingsCard>
      </SettingsSection>

      {detail.data?.landing ? (
        <WorkspaceLandingSetting
          landing={detail.data.landing}
          repo={repoSlug(workspace.repoUrl)}
          saving={patch.isPending}
          onChoose={(landingMode) => save({ landingMode })}
        />
      ) : null}

      <SettingsSection title="Sessions" className="workspace-section-sessions">
        <SettingsCard>
          <SettingsRow
            title="Worktree isolation"
            description={
              worktreeNeedsGit
                ? 'Unavailable: the working directory is not a git repository. Initialize git there from the shared-folder notice on the agent page, or keep isolation off.'
                : 'Each session runs in its own git worktree.'
            }
            tooltip="Each session runs in its own git worktree. Off → sessions run directly in the working directory, sharing it."
            control={
              <Switch
                aria-label="Worktree isolation"
                checked={workspace.enableWorktree ?? false}
                disabled={worktreeNeedsGit}
                onCheckedChange={(enableWorktree) => {
                  // Board 04: the switch says what it means for the main checkout first; it never blocks.
                  const ask = worktreeIsolationDialogFor(
                    enableWorktree,
                    workspace.repoHealth as MainCheckoutRepoHealth | null | undefined,
                    worktrees.length,
                    workspace.workDir ?? '',
                  );
                  if (ask) setIsolationDialog(ask);
                  else save({ enableWorktree });
                }}
              />
            }
          />
          <WorktreeIsolationDialog
            dialog={isolationDialog}
            onCancel={() => setIsolationDialog(null)}
            onConfirm={() => {
              save({ enableWorktree: isolationDialog?.kind !== 'off' });
              setIsolationDialog(null);
            }}
            onReview={
              workspace.mainCheckoutActions
                ? () => {
                    setIsolationDialog(null);
                    isolationCheckout.host?.openReview();
                  }
                : undefined
            }
            onCleanUp={() => {
              setIsolationDialog(null);
              const cleanup = repoCleanupConfirm(isolationDialog && 'root' in isolationDialog ? isolationDialog.root : '');
              void confirm({
                title: cleanup.title,
                description: cleanup.content,
                confirmText: cleanup.okText,
                onConfirm: () => repairMut.mutateAsync().catch(() => {}),
              });
            }}
          />
          {isolationCheckout.drawer}
          {/* Model is not a workspace field: it resolves from the engine and provider this project last
              ran on. Said read-only, because a new session's composer is where it is picked. */}
          <SettingsRow
            title="Model"
            description={
              <span className="rd-form-derived">
                {smartSelection ? (
                  <>
                    Task runs: model picked per task by smart selection. Sessions you open yourself:{' '}
                    <b>{model || '—'}</b> · {via} on this runner.
                  </>
                ) : (
                  <>
                    Model <b>{model || '—'}</b> · {via} on this runner. Pick a different one from the session
                    composer.
                  </>
                )}
              </span>
            }
          />
          {accountEngines.map((e) => (
            <div key={e} className="settings-row settings-row--block">
              <AccountSelect
                engine={e}
                runner={runner!}
                value={workspace[`${e}Account`] ?? null}
                onChange={(next) => save({ [`${e}Account`]: next } as WorkspacePatch)}
                envDir={env[ENV_DIR[e]]}
              />
            </div>
          ))}
          {claudeInstalled && (
            <div className="settings-row settings-row--block">
              <AutoCompactSelect
                value={env[AUTO_COMPACT_VARIABLE]}
                onChange={(size) => {
                  const rows = Object.entries(env).map(([key, value]) => ({ key, value }));
                  save({ env: Object.fromEntries(withAutoCompact(rows, size).map((r) => [r.key, r.value])) });
                }}
              />
            </div>
          )}
          {history && (
            <SettingsRow
              title="Import Claude Code history"
              description={`${history.conversations} ${history.conversations === 1 ? 'conversation' : 'conversations'} in this directory on ${machineName}`}
              control={
                <Button icon={<ImportOutlined />} onClick={() => setDrawer('history')}>
                  Import
                </Button>
              }
            />
          )}
          {/* The other half of the import: history that came in as a directory goes back out as one.
              The transcripts on the runner are not touched — this removes Orbit's copies. */}
          {importedCount > 0 && (
            <SettingsRow
              title="Imported conversations"
              description={`${importedCount} imported ${importedCount === 1 ? 'conversation' : 'conversations'} in this workspace.`}
              control={
                <Button
                  danger
                  loading={removeImportedMut.isPending}
                  onClick={() =>
                    void confirm({
                      title: 'Remove imported conversations?',
                      description: `The ${importedCount} imported sessions of ${workspace.name} move to Trash. The transcripts on the runner are left alone.`,
                      confirmText: 'Remove',
                      danger: true,
                      cancelText: 'Keep',
                      onConfirm: () => removeImportedMut.mutate(),
                    })
                  }
                >
                  Remove all
                </Button>
              }
            />
          )}
        </SettingsCard>
      </SettingsSection>

      <SubagentSettings
        enabled={workspace.subagentsEnabled ?? true}
        onEnabledChange={(subagentsEnabled) => save({ subagentsEnabled })}
        workflowsEnabled={workspace.workflowsEnabled ?? true}
        onWorkflowsEnabledChange={(workflowsEnabled) => save({ workflowsEnabled })}
        maxRunning={workspace.subagentsMaxRunning ?? 4}
        onMaxRunningChange={(subagentsMaxRunning) => save({ subagentsMaxRunning })}
      />

      <SettingsSection title="Agent environment" className="workspace-section-environment">
        <SettingsCard>
          <SettingsRow
            title="Environment variables"
            description={envKeys.length > 0 ? envKeys.join(', ') : 'None'}
            control={<Button onClick={() => setDrawer('env')}>Edit</Button>}
          />
          <SettingsRow
            title="Instructions"
            description={
              instructions
                ? `Added to every run's runtime instructions · ${instructions.length} characters`
                : "Added to every run's runtime instructions · none yet"
            }
            control={<Button onClick={() => setDrawer('instructions')}>Edit</Button>}
          />
          <SettingsRow
            title="Agent tools"
            description="What agents here are given: Orbit's tools, the instructions they read and in what order, and the playbooks."
            control={<Button onClick={() => setDrawer('agent-tools')}>View</Button>}
          />
          <SettingsRow
            title="Always allowed"
            description={
              ruleCount === 0
                ? 'Nothing yet'
                : `${ruleCount} ${ruleCount === 1 ? 'tool' : 'tools'} you said “don’t ask again” for`
            }
            control={<Button onClick={() => setDrawer('rules')}>Manage</Button>}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Danger zone" className="workspace-section-danger">
        <SettingsCard>
          <SettingsRow
            title="Disable workspace"
            description="Park it: no new sessions start here until you turn it back on."
            control={
              <Switch
                aria-label="Disable workspace"
                checked={workspace.enabled === false}
                onCheckedChange={(off) => save({ enabled: !off })}
              />
            }
          />
          <SettingsRow
            title="Delete workspace"
            description="Leaves your list; its sessions and tasks are kept and stay linked to it."
            control={
              <Button
                danger
                onClick={() =>
                  void confirm({
                    title: `Delete workspace “${workspace.name}”?`,
                    description:
                      'The workspace leaves your list but is not erased — its sessions and tasks are kept and stay linked to it. To park one you still use, disable it instead.',
                    confirmText: 'Delete',
                    danger: true,
                    cancelText: 'Cancel',
                    onConfirm: () => removeMut.mutateAsync(),
                  })
                }
              >
                Delete
              </Button>
            }
          />
        </SettingsCard>
      </SettingsSection>

      <EnvDrawer
        open={drawer === 'env'}
        env={env}
        onClose={() => setDrawer(null)}
        onSave={(next) => {
          save({ env: next });
          setDrawer(null);
        }}
      />
      <InstructionsDrawer
        open={drawer === 'instructions'}
        value={workspace.appendSystemPrompt ?? ''}
        onClose={() => setDrawer(null)}
        onSave={(appendSystemPrompt) => {
          save({ appendSystemPrompt });
          setDrawer(null);
        }}
      />
      <AgentToolsDrawer
        mode="workspace"
        open={drawer === 'agent-tools'}
        onClose={() => setDrawer(null)}
        workspaceName={workspace.name}
        instructions={workspace.appendSystemPrompt ?? ''}
        baseInstructions={!!workspace.systemPrompt?.trim()}
        onEditInstructions={() => setDrawer('instructions')}
      />
      <Drawer open={drawer === 'rules'} onClose={() => setDrawer(null)} title="Always allowed" width={480}>
        <WorkspacePermissionRules workspaceId={id} />
      </Drawer>
      {history && (
        <HistoryDrawer
          open={drawer === 'history'}
          history={history}
          workspaceId={id}
          onClose={() => setDrawer(null)}
          onImport={(mode) => {
            void startHistoryImport(id, history, mode, message, refreshSessionLists);
            setDrawer(null);
          }}
        />
      )}
      {confirmation}
    </div>
  );
}

/**
 * A text setting saved on its own: on blur, or on Enter. A value that did not change sends nothing,
 * and an emptied field goes back to what is saved — none of these can be cleared from here (as before).
 */
function TextSetting({
  label,
  value,
  onCommit,
  onDraft,
  placeholder,
  maxLength,
  mono,
}: {
  label: string;
  value: string;
  onCommit: (next: string) => void;
  onDraft?: (draft: string | null) => void;
  placeholder?: string;
  maxLength?: number;
  mono?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  // The last value this field saved or was given: Enter and the blur after it send it once.
  const committed = useRef(value);
  useEffect(() => {
    committed.current = value;
    setDraft(value);
    onDraft?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const commit = () => {
    const next = draft.trim();
    if (!next) {
      setDraft(committed.current);
      onDraft?.(null);
      return;
    }
    if (next === committed.current) return;
    committed.current = next;
    onCommit(next);
  };
  return (
    <Input
      className={`workspace-text-setting${mono ? ' workspace-text-setting--mono' : ''}`}
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      maxLength={maxLength}
      onChange={(e) => {
        setDraft(e.target.value);
        onDraft?.(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) commit();
      }}
    />
  );
}

/** Environment variables, as the workspace form edited them: a key, a masked value, and Remove. */
function EnvDrawer({
  open,
  env,
  onClose,
  onSave,
}: {
  open: boolean;
  env: Record<string, string>;
  onClose: () => void;
  onSave: (env: Record<string, string>) => void;
}) {
  const [rows, setRows] = useState<{ key: string; value: string }[]>([]);
  useEffect(() => {
    if (open) setRows(Object.entries(env).map(([key, value]) => ({ key, value })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Environment variables"
      width={520}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => onSave(Object.fromEntries(rows.map((r) => [r.key.trim(), r.value]).filter(([k]) => k)))}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="rd-form-field">
        {rows.map((row, i) => (
          <div className="rd-env-row" key={i}>
            <Input
              value={row.key}
              onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
              placeholder="KEY"
            />
            {/* These commonly hold tokens, so the value is masked until asked for. */}
            <PasswordInput
              value={row.value}
              onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
              placeholder="value"
            />
            <Tooltip content="Remove" align="end">
              <Button
                variant="text"
                aria-label="Remove"
                icon={<DeleteOutlined />}
                onClick={() => setRows(rows.filter((_, j) => j !== i))}
              />
            </Tooltip>
          </div>
        ))}
        <Button
          variant="dashed"
          icon={<PlusOutlined />}
          onClick={() => setRows([...rows, { key: '', value: '' }])}
          style={{ width: '100%' }}
        >
          Add variable
        </Button>
      </div>
    </Drawer>
  );
}

function InstructionsDrawer({
  open,
  value,
  onClose,
  onSave,
}: {
  open: boolean;
  value: string;
  onClose: () => void;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    if (open) setDraft(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Instructions"
      width={520}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => onSave(draft.trim())}>
            Save
          </Button>
        </>
      }
    >
      <Textarea
        aria-label="Instructions"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={12}
        placeholder="Added to every run's runtime instructions (optional)"
      />
    </Drawer>
  );
}

/**
 * The Claude Code history the runner found in this workspace's directory, offered for import; and
 * the one-conversation import by its session id — the same door `orbit session import` uses.
 */
function HistoryDrawer({
  open,
  history,
  workspaceId,
  onClose,
  onImport,
}: {
  open: boolean;
  history: ClaudeHistoryResult;
  workspaceId: string;
  onClose: () => void;
  onImport: (mode: ImportMode) => void;
}) {
  const navigate = useNavigate();
  const message = useToast();
  const [mode, setMode] = useState<ImportMode>('latest');
  const [importId, setImportId] = useState('');
  const importMut = useMutation({
    mutationFn: async () => {
      const id = importId.trim();
      if (!CLAUDE_SESSION_ID_RE.test(id)) {
        throw new Error('claude session id must be a UUID, e.g. 4e453ab7-f37c-494d-8017-bb4e9beffeef');
      }
      return importClaudeSessionAndWait(id, workspaceId);
    },
    onSuccess: (id) => {
      setImportId('');
      message.success('Imported — opening the session.');
      navigate(`/sessions/${encodeId(id)}`);
    },
    onError: (e: Error) => message.error("Couldn't import the session", e.message),
  });
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Import Claude Code history"
      width={520}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={mode === 'none'} onClick={() => onImport(mode)}>
            Import
          </Button>
        </>
      }
    >
      <ClaudeHistoryOffer history={history} value={mode} onChange={setMode} />
      <div className="rd-form-field" style={{ marginTop: 16 }}>
        <div className="rd-form-label">Claude Code session id</div>
        <div className="rd-import-row">
          <Input
            value={importId}
            onChange={(e) => setImportId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) importMut.mutate();
            }}
            placeholder="4e453ab7-f37c-494d-8017-bb4e9beffeef"
            disabled={importMut.isPending}
          />
          <Button icon={<ImportOutlined />} onClick={() => importMut.mutate()} loading={importMut.isPending}>
            Import
          </Button>
        </div>
        <div className="rd-path-hint rd-path-muted">
          Imports the local Claude transcript as this workspace's session — readable, searchable, and the next
          message continues it with its original context.
        </div>
      </div>
    </Drawer>
  );
}

/**
 * What this workspace's sessions no longer ask about — the "always allow" answers that outlived the
 * session they were given in. Read-and-revoke only: a grant is created by answering an approval with
 * "always allow", and revoking acts at once.
 */
function WorkspacePermissionRules({ workspaceId }: { workspaceId: string }) {
  const qc = useQueryClient();
  const message = useToast();
  const rules = useQuery(workspacePermissionRulesQuery(workspaceId));
  const revokeMut = useMutation({
    mutationFn: (ruleId: string) => revokeWorkspacePermissionRule(workspaceId, ruleId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: workspacePermissionRulesQuery(workspaceId).queryKey }),
    onError: (e: Error) => message.error("Couldn't revoke the permission rule", e.message),
  });
  const rows = rules.data ?? [];
  return (
    <div className="rd-form-field">
      {rules.isLoading ? (
        <Spinner size="small" />
      ) : rows.length === 0 ? (
        <div className="rd-rule-empty">
          Nothing yet. Answering an approval with “always allow” records it here, and this workspace's sessions
          stop asking about that call.
        </div>
      ) : (
        <>
          {rows.map((rule) => (
            <div className="rd-rule-row" key={rule.id}>
              <code className="rd-rule-token">
                {rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName}
              </code>
              <Tooltip content="Ask about this again" align="end">
                <Button
                  variant="text"
                  aria-label="Ask about this again"
                  icon={<DeleteOutlined />}
                  loading={revokeMut.isPending && revokeMut.variables === rule.id}
                  onClick={() => revokeMut.mutate(rule.id)}
                />
              </Tooltip>
            </div>
          ))}
          {/* The two mechanisms differ in WHEN they take effect: Claude is handed the rules when it
              starts, so a revoke reaches a running session only on its next start. */}
          <div className="rd-rule-empty">
            Handed to Claude when a session starts, and checked by Orbit when Codex or Kimi asks. A command skips
            the prompt only when every part of it is covered.
          </div>
        </>
      )}
    </div>
  );
}

/**
 * New workspace (the Workspaces group's +): the machine first — a workspace is a folder on one machine — then the
 * same card a machine with no workspace shows on its own page (docs/mocks/new-workspace-form, decision 1 A), under
 * this page's header. A made workspace opens on its conversation, where a GitHub clone's progress is drawn
 * (decision 3 A).
 */
function NewWorkspacePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const message = useToast();
  const refreshSessionLists = useRefreshSessionLists();
  const [params, setParams] = useSearchParams();
  const runnersQ = useQuery(runnersQuery());
  const runners = (runnersQ.data ?? []) as Runner[];
  // The account's managed runner reads its shared state here (Asleep, Waking up…), never Offline.
  const { managed } = useManagedRunner();
  const machineId = routeId(params.get('machine'));
  const runner = runners.find((r) => r.id === machineId) ?? null;

  const createMut = useMutation({
    mutationFn: ({ folder, name }: { folder: PickedFolder; name: string; history: HistoryChoice | null }) =>
      api<{ id: string }>('/workspaces', {
        method: 'POST',
        body: { name, runnerId: runner?.id, ...newWorkspaceOf(folder) },
      }),
    onSuccess: async (made, { history }) => {
      if (history) void startHistoryImport(made.id, history.history, history.mode, message, refreshSessionLists);
      await qc.invalidateQueries({ queryKey: ['workspaces'] });
      navigate(`/workspaces/${encodeId(made.id)}`);
    },
  });

  if (runnersQ.isPending) {
    return (
      <div style={{ padding: 24, textAlign: 'center' }}>
        <Spinner />
      </div>
    );
  }

  if (!runner) {
    const nowMs = Date.now();
    return (
      <div className="settings-page workspace-new">
        <SettingsHeader title="New workspace" description="A workspace is a folder on one machine. Pick the machine first." />
        <SettingsSection title="Machine">
          {runners.length === 0 ? (
            <SettingsCard>
              <SettingsRow
                title="No machines yet"
                description="Register a machine, then add its folders as workspaces."
                control={
                  <Button variant="primary" onClick={() => navigate('/runners/register')}>
                    Register a machine
                  </Button>
                }
              />
            </SettingsCard>
          ) : (
            <SettingsCard>
              {runners.map((r) => {
                const offline = runnerIsOffline(r, nowMs);
                return (
                  <button
                    key={r.id}
                    type="button"
                    className="workspace-machine-choice"
                    data-runner-id={r.id}
                    onClick={() => setParams({ machine: r.id })}
                  >
                    <SettingsRow
                      title={runnerName(r, managed?.status.runnerId ?? null)}
                      description={managedRowOf(managed, r.id)?.label ?? (offline ? 'Offline' : 'Online')}
                      control={<RightOutlined />}
                    />
                  </button>
                );
              })}
            </SettingsCard>
          )}
        </SettingsSection>
      </div>
    );
  }

  return (
    <div className="settings-page workspace-new">
      <SettingsHeader
        title="New workspace"
        description={
          <>
            On {runnerName(runner, managed?.status.runnerId ?? null)} ·{' '}
            <button type="button" className="workspace-change-machine" onClick={() => setParams({})}>
              Change machine
            </button>
          </>
        }
      />
      {/* Keyed by the machine: another one is a new card, with nothing typed for the last one carried over. */}
      <MachineSetupCard
        key={runner.id}
        runner={runner}
        managed={managed}
        headless
        onCreate={(folder, name, history) => createMut.mutate({ folder, name, history })}
        creating={createMut.isPending}
        createError={createMut.error?.message ?? null}
      />
    </div>
  );
}
