import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  ImportOutlined,
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
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  api,
  askClaudeHistory,
  countImportedSessions,
  getClaudeHistory,
  importClaudeHistory,
  removeImportedSessions,
  revokeWorkspacePermissionRule,
  type ClaudeHistoryResult,
} from '../api';
import { routeId, encodeId } from '../lib/idCodec';
import { providersQuery, workspacePermissionRulesQuery } from '../lib/queries';
import { CLAUDE_SESSION_ID_RE, importClaudeSessionAndWait } from '../lib/sessionImport';
import { ClaudeHistoryOffer, type ImportMode } from '../components/ClaudeHistoryOffer';
import { CodexAccountSelect, offersCodexAccount } from '../components/CodexAccountSelect';
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
  /** The git remote this workspace's checkout came from, as declared here. Recorded only — it is
   *  what a project's integration line is bound from, so nothing else may invent it. */
  repoUrl?: string | null;
  env?: Record<string, string> | null;
  /** Which Codex account on its runner this workspace's Codex sessions run on: the id of a slot the
   *  runner added. null = Default, the runner's own CODEX_HOME. */
  codexAccount?: string | null;
  runnerId?: string | null;
  enabled?: boolean;
  enableWorktree?: boolean;
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

/** How long the create form waits for the runner to answer what history a directory holds. The
 *  question rides the runner's 30s heartbeat, so this is two beats plus the scan — past that the
 *  offer simply never appears, which is the same as the machine having nothing to offer. */
const HISTORY_WAIT_MS = 75_000;
const HISTORY_POLL_MS = 2500;
/** Long enough that typing a path doesn't ask once per keystroke, short enough that the offer is
 *  on screen while the rest of the form is still being filled in. */
const HISTORY_DEBOUNCE_MS = 500;

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
  const runnerId = routeId(useParams().id);
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
  const [fRepoUrl, setFRepoUrl] = useState('');
  const [fEnableWorktree, setFEnableWorktree] = useState(false);
  const [fEnv, setFEnv] = useState<{ key: string; value: string }[]>([]);
  // null = Default, the runner's own Codex account.
  const [fCodexAccount, setFCodexAccount] = useState<string | null>(null);
  // The Claude session id the Import section carries (edit mode only — importing needs the
  // workspace to exist). Reset with the rest of the form so a stale id can't leak across picks.
  const [importId, setImportId] = useState('');
  // What the runner reported about Claude Code conversations already recorded under the directory
  // being typed into the create form, and which of the three offers is selected. Null until an
  // answer arrives for the exact path in the field — an unanswered or empty directory shows no
  // offer at all rather than an empty one.
  const [history, setHistory] = useState<ClaudeHistoryResult | null>(null);
  const [importMode, setImportMode] = useState<ImportMode>('none');
  // The long tail (env / instructions) stays folded until asked for, and
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
        repoUrl: fRepoUrl.trim() || undefined,
        enableWorktree: fEnableWorktree,
        env: Object.fromEntries(
          fEnv.map((r) => [r.key.trim(), r.value]).filter(([k]) => k),
        ),
        codexAccount: fCodexAccount,
      };
      return editing
        ? api<Workspace>(`/workspaces/${editing.id}`, { method: 'PATCH', body })
        : api<Workspace>('/workspaces', { method: 'POST', body: { ...body, runnerId } });
    },
    onSuccess: (saved) => {
      // Whatever was answered about this directory's existing conversations, acted on now that
      // there is a workspace to import them into. Deliberately not awaited: each transcript
      // becomes a session the runner replays on its own, so the form closes and the workspace is
      // usable immediately rather than when the last of the history has landed.
      if (!editing && history && importMode !== 'none' && saved?.id) {
        const transcripts =
          importMode === 'latest' ? history.transcripts.slice(0, 1) : history.transcripts;
        importClaudeHistory({ workspaceId: saved.id, transcripts })
          .then((res) => {
            message.success(
              res.imported === 1
                ? 'Importing 1 conversation — it appears as it lands.'
                : `Importing ${res.imported} conversations — they appear as they land.`,
            );
            void qc.invalidateQueries({ queryKey: ['sessions'] });
          })
          .catch((e: Error) => message.error(e.message || 'Import failed'));
      }
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
          // Same directory on the same machine, so the remote is the copy's too: a duplicate that
          // silently dropped it would put the project binding back where it was before this field.
          repoUrl: a.repoUrl ?? undefined,
          enableWorktree: a.enableWorktree ?? false,
          effort: a.effort ?? null,
          env: a.env ?? {},
          // Same machine, so the same account: a copy that fell back to Default would spend another
          // account's quota without anyone having chosen that.
          codexAccount: a.codexAccount ?? null,
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
  // Import a local Claude Code transcript as this workspace's session — the same door
  // `orbit session import` uses, so the refusals read identically. The button stays busy while
  // the wait inside watches the runner replay the transcript (or settle the import as FAILED),
  // mirroring the CLI's own wait before it reports.
  const importMut = useMutation({
    mutationFn: async () => {
      if (!editing) throw new Error('pick a workspace first');
      const id = importId.trim();
      if (!CLAUDE_SESSION_ID_RE.test(id)) {
        throw new Error('claude session id must be a UUID, e.g. 4e453ab7-f37c-494d-8017-bb4e9beffeef');
      }
      return importClaudeSessionAndWait(id, editing.id);
    },
    onSuccess: (id) => {
      setImportId('');
      message.success('Imported — opening the session.');
      navigate(`/sessions/${encodeId(id)}`);
    },
    onError: (e: Error) => message.error(e.message || 'Import failed'),
  });

  // Ask the runner what Claude Code history sits under the directory being typed, and wait for the
  // answer. Create mode only: a saved workspace has the settings-page import instead, and this is
  // the one moment where "you already have conversations here" is news.
  //
  // The runner is the only one who can answer — the control plane never sees ~/.claude/projects —
  // so the question goes out on its heartbeat and the answer arrives on its own POST. Everything
  // here is keyed to the exact path in the field: retyping drops the offer immediately, and an
  // answer about a directory that is no longer named is never shown.
  useEffect(() => {
    const path = fWorkDir.trim();
    setHistory(null);
    setImportMode('none');
    if (!formOpen || editing || !runnerId || !path) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          await askClaudeHistory(runnerId, path);
        } catch {
          return; // an offline runner, or one too old to know the question: offer nothing
        }
        const deadline = Date.now() + HISTORY_WAIT_MS;
        for (;;) {
          await new Promise((r) => setTimeout(r, HISTORY_POLL_MS));
          if (cancelled) return;
          let state;
          try {
            state = await getClaudeHistory(runnerId, path);
          } catch {
            return;
          }
          if (cancelled) return;
          if (state.result) {
            // A directory with nothing in it is not an offer with a zero in it.
            if (state.result.conversations > 0 && state.result.transcripts.length > 0) {
              setHistory(state.result);
            }
            return;
          }
          if (state.status === 'failed' || Date.now() > deadline) return;
        }
      })();
    }, HISTORY_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [fWorkDir, formOpen, editing, runnerId]);

  // How many of this workspace's sessions arrived as imported transcripts — read in the settings
  // of a saved workspace, which is where taking them back out again belongs.
  const importedQ = useQuery({
    queryKey: ['imported-sessions', editing?.id],
    queryFn: () => countImportedSessions(editing?.id as string),
    enabled: !!editing?.id,
  });
  const removeImportedMut = useMutation({
    mutationFn: () => removeImportedSessions(editing?.id as string),
    onSuccess: (res) => {
      message.success(
        res.removed === 1 ? '1 imported conversation removed.' : `${res.removed} imported conversations removed.`,
      );
      void qc.invalidateQueries({ queryKey: ['imported-sessions', editing?.id] });
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (e: Error) => message.error(e.message || 'Remove failed'),
  });

  // Shared reset for both entry points — every field the form owns is set here, so a stale
  // value from the previous workspace can never leak into the next one.
  const resetForm = (a: Workspace | null) => {
    setEditing(a);
    setFName(a?.name ?? '');
    setFAppend(a?.appendSystemPrompt ?? '');
    setFWorkDir(a?.workDir ?? '');
    setFRepoUrl(a?.repoUrl ?? '');
    setFEnableWorktree(a?.enableWorktree ?? false);
    setFEnv(Object.entries(a?.env ?? {}).map(([key, value]) => ({ key, value })));
    setFCodexAccount(a?.codexAccount ?? null);
    setImportId('');
    setHistory(null);
    setImportMode('none');
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
    const advCount = (fEnv.length ? 1 : 0) + (fAppend.trim() ? 1 : 0) + (fCodexAccount ? 1 : 0);
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
      {/* Recorded, never cloned, and never guessed from the checkout on the machine: this is the
          remote a project's integration line is bound from, and a guess would be indistinguishable
          from a declaration at every later read. Full width below the grid — a URL is the longest
          thing this form asks for. */}
      <div className="rd-form-field">
        <div className="rd-form-label">Repository URL</div>
        <Input
          value={fRepoUrl}
          onChange={(e) => {
            setFRepoUrl(e.target.value);
            setDirty(true);
          }}
          placeholder="https://github.com/owner/repo (optional)"
        />
        <div className="rd-path-hint rd-path-muted">
          Where this checkout came from. A project's integration line is bound from it — with none
          recorded, a project whose coordination workspace is this one cannot start one.
        </div>
      </div>
      {/* Shown only when this directory has something to offer — an empty path, a directory nobody
          has run claude in, and a runner that never answers all show nothing here rather than an
          offer with a zero in it.

          The same height whether the directory holds six conversations or six hundred. Consent is
          given for this directory's history as a whole, which is the granularity the person has an
          opinion about; a checklist would put hundreds of decisions in front of someone who is
          still naming the workspace, and none of them could be made well. */}
      {mode === 'create' && history && (
        <ClaudeHistoryOffer
          history={history}
          value={importMode}
          onChange={(next) => {
            setImportMode(next);
            setDirty(true);
          }}
        />
      )}
      <SettingRow
        label="Worktree isolation"
        desc="Each session runs in its own git worktree. Off → sessions run directly in the working directory, sharing it."
        checked={fEnableWorktree}
        onChange={(v) => {
          setFEnableWorktree(v);
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

      {/* Import needs the workspace to exist — it creates a session OF it. The create form only
          promises it: the section lives in the settings of a saved workspace. */}
      {mode === 'edit' && editing && (
        <>
          <div className="rd-form-section">Import</div>
          <div className="rd-form-field">
            <div className="rd-form-label">Claude Code session id</div>
            <div className="rd-import-row">
              <Input
                value={importId}
                onChange={(e) => setImportId(e.target.value)}
                onPressEnter={() => importMut.mutate()}
                placeholder="4e453ab7-f37c-494d-8017-bb4e9beffeef"
                disabled={importMut.isPending}
              />
              <Button
                icon={<ImportOutlined />}
                onClick={() => importMut.mutate()}
                loading={importMut.isPending}
              >
                Import
              </Button>
            </div>
            <div className="rd-path-hint rd-path-muted">
              Imports the local Claude transcript as this workspace's session — readable,
              searchable, and the next message continues it with its original context.
            </div>
            {/* The other half of what the create form's offer promised: history that came in as a
                directory goes back out as one. The transcripts on the runner are not touched —
                this removes Orbit's copies. */}
            {(importedQ.data?.count ?? 0) > 0 && (
              <div className="rd-history-removal">
                <span className="rd-set-desc">
                  {importedQ.data?.count} imported{' '}
                  {importedQ.data?.count === 1 ? 'conversation' : 'conversations'} in this
                  workspace.
                </span>
                <Button
                  size="small"
                  danger
                  loading={removeImportedMut.isPending}
                  onClick={() =>
                    modal.confirm({
                      title: 'Remove imported conversations?',
                      content: `The ${importedQ.data?.count} imported sessions of ${editing.name} move to Trash. The transcripts on the runner are left alone.`,
                      okText: 'Remove',
                      okButtonProps: { danger: true },
                      cancelText: 'Keep',
                      autoFocusButton: 'cancel',
                      onOk: () => removeImportedMut.mutate(),
                    })
                  }
                >
                  Remove all
                </Button>
              </div>
            )}
          </div>
        </>
      )}
      {mode === 'create' && (
        <div className="rd-form-derived">
          Have a Claude Code session on this runner? You can import it later from workspace
          settings.
        </div>
      )}

      <div
        className={`rd-adv-toggle${advOpen ? ' open' : ''}`}
        onClick={() => setAdvOpen(!advOpen)}
      >
        <DownOutlined className="rd-adv-caret" /> Advanced
        {advCount > 0 && !advOpen && <span className="rd-adv-badge">{advCount} configured</span>}
      </div>
      {advOpen && (
        <div className="rd-adv-body">
          {runner && offersCodexAccount(runner, fCodexAccount) && (
            <CodexAccountSelect
              runner={runner}
              value={fCodexAccount}
              onChange={(next) => {
                setFCodexAccount(next);
                setDirty(true);
              }}
              envCodexHome={fEnv.find((r) => r.key.trim() === 'CODEX_HOME')?.value}
            />
          )}
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
          {/* The two mechanisms differ in WHEN they take effect, which is the part a user can
              be surprised by: Claude is handed the rules when it starts, so a revoke reaches a
              running session only on its next start. */}
          <div className="rd-rule-empty">
            Handed to Claude when a session starts, and checked by Orbit when Codex or Kimi asks.
            A command skips the prompt only when every part of it is covered.
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
