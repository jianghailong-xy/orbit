import {
  ArrowLeftOutlined,
  BranchesOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloudDownloadOutlined,
  CopyOutlined,
  DashboardOutlined,
  DeleteOutlined,
  DisconnectOutlined,
  DownOutlined,
  EditOutlined,
  HddOutlined,
  ImportOutlined,
  KeyOutlined,
  LoginOutlined,
  MessageOutlined,
  MinusCircleOutlined,
  MoreOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  RobotOutlined,
  SyncOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LoginEngine, RunnerRepoHealth } from '@orbit/shared';
import {
  App as AntdApp,
  Button,
  Checkbox,
  Dropdown,
  Input,
  InputNumber,
  Modal,
  Select,
  Spin,
  Switch,
  Tag,
  type MenuProps,
  type RefSelectProps,
} from 'antd';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  api,
  askClaudeHistory,
  cleanUpWorkspaceRepo,
  countImportedSessions,
  getClaudeHistory,
  importClaudeHistory,
  removeImportedSessions,
  revokeWorkspacePermissionRule,
  type ClaudeHistoryResult,
} from '../api';
import { routeId, encodeId } from '../lib/idCodec';
import {
  meQuery,
  providersQuery,
  publishedRunnerVersionQuery,
  workspacePermissionRulesQuery,
  workspaceSessionCountsQuery,
} from '../lib/queries';
import { CLAUDE_SESSION_ID_RE, importClaudeSessionAndWait } from '../lib/sessionImport';
import { ClaudeHistoryOffer, type ImportMode } from '../components/ClaudeHistoryOffer';
import { AccountSelect, offersAccount } from '../components/AccountSelect';
import { MachineEngines, ownSignInPanel } from '../components/RunnerEngines';
import { useRunnerTokenRotation } from '../components/RunnerTokenRotation';
import type { Runner } from '../components/TasksSidePanel';
import { copyText } from '../lib/clipboard';
import { REPO_CLEANUP_QUEUED, repoCleanupConfirm } from '../lib/repoCleanup';
import {
  KEEP_FREE_TIERS,
  compareRunnerVersions,
  formatDiskGb,
  keepFreeLabel,
  latestRunnerVersion,
  runnerAttention,
  runnerCanUpdateNow,
  runnerDisk,
  type AttentionItem,
  type AttentionKind,
} from '../lib/runnerAttention';
import {
  RUNNER_ABOUT,
  RUNNER_ABOUT_HOSTNAME,
  RUNNER_ABOUT_LAST_CHECK_IN,
  RUNNER_ABOUT_LAST_UPDATE,
  RUNNER_ABOUT_NAME,
  RUNNER_ABOUT_REGISTERED,
  RUNNER_ABOUT_REPOS_FOLDER,
  RUNNER_ABOUT_RUNS_AS,
  RUNNER_ABOUT_VERSION,
  RUNNER_CAPACITY,
  RUNNER_CAPACITY_FOOTER,
  RUNNER_COPY_COMMAND,
  RUNNER_DISK,
  RUNNER_ENGINES,
  RUNNER_ENGINES_FOOTER,
  RUNNER_ENGINES_OFFLINE_FOOTER,
  RUNNER_KEEP_FREE,
  RUNNER_LINE_SEPARATOR,
  RUNNER_MAX_CONCURRENT,
  RUNNER_NEEDS_ATTENTION,
  RUNNER_OFFLINE,
  RUNNER_ONLINE,
  RUNNER_REPAIR,
  RUNNER_ROOT_NO_BYPASS,
  RUNNER_RUNS_AS_REGULAR_USER,
  RUNNER_RUNS_AS_ROOT,
  RUNNER_SET_A_RESERVE,
  RUNNER_SIGN_IN,
  RUNNER_UPDATE_ENGINES_NOW,
  RUNNER_UPDATE_RUNNER_NOW,
  RUNNER_UPDATE_RUNNER_REQUESTED,
  RUNNER_VERSION_INSTALLS_WHEN_IDLE,
  RUNNER_VERSION_LATEST,
  RUNNER_VERSION_NOT_ROLLED_OUT,
  RUNNER_WORKSPACES,
  attentionQuotaResets,
  runnerDiskUsed,
  runnerOfflineLastSeen,
  runnerRunningOf,
  runnerUpdatedFromTo,
  runnerVersionTag,
  runnerWorkspaceRunning,
} from '../lib/runnerCopy';
import { ago } from '../lib/runnerEngines';
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
  /** Repository for project integration, entered here or detected from the checkout's origin. */
  repoUrl?: string | null;
  env?: Record<string, string> | null;
  /** Which Codex account on its runner this workspace's Codex sessions run on: the id of a slot the
   *  runner added. null = Default, the runner's own CODEX_HOME. */
  codexAccount?: string | null;
  claudeAccount?: string | null;
  antigravityAccount?: string | null;
  runnerId?: string | null;
  enabled?: boolean;
  enableWorktree?: boolean;
  /** Smart model selection (docs/model-routing-design.md §7.2): on, a fresh task run here is created
   *  on the routed model and effort; off (the default), routing is only recorded in shadow. */
  modelRouting?: boolean;
  /** The other engines smart selection may move this Agent's task runs to (§6). Empty = none: a run
   *  stays on this Agent's own engine. */
  modelRoutingProviders?: string[];
  /** Default a new session under this workspace inherits. null = inherit the account default.
   *  The permission mode is deliberately NOT here — it belongs to the run (Session), with an
   *  account-level default. */
  effort?: string | null;
  /** What the runner last saw at `workDir` on its own disk (refreshed each heartbeat). All null =
   *  never probed — an older runner, or one that hasn't reported since this workspace was added. */
  workDirExists?: boolean | null;
  workDirIsGit?: boolean | null;
  workDirProbedAt?: string | null;
  /** The filesystem under workDir, as the runner last measured it (BIGINT columns, sent as strings):
   *  what Capacity's disk bar and the disk item in Needs Attention read. */
  workDirFreeBytes?: string | number | null;
  workDirTotalBytes?: string | number | null;
  /** The checkout workDir sits in, as the runner last saw it — stuck mid-merge is a Needs Attention
   *  item with a Repair. */
  repoHealth?: RunnerRepoHealth | null;
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

/** A day, with the year only when it isn't this one: `Jun 18`, `Dec 3, 2025`. */
const fmtDate = (d?: string | null): string => {
  const at = d ? new Date(d) : null;
  if (!at || Number.isNaN(at.getTime())) return '—';
  return at.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    ...(at.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  });
};

/** When a quota window resets, in the reader's own zone — the item carries it raw for this. */
const fmtReset = (iso: string): string =>
  new Date(iso).toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

const MIB = 1024 * 1024;

/** Each Needs Attention card's mark, by what it is about. */
const ATTENTION_ICON: Record<AttentionKind, ReactNode> = {
  offline: <DisconnectOutlined />,
  engineSignedOut: <LoginOutlined />,
  checkoutStuck: <BranchesOutlined />,
  quotaNearLimit: <DashboardOutlined />,
  diskLow: <HddOutlined />,
  cannotSelfUpdate: <CloudDownloadOutlined />,
  engineNotUpdating: <SyncOutlined />,
};

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
  // Each workspace's sessions in flight, for its row's "N running" — the sidebar's own tallies.
  const sessionCounts = useQuery(workspaceSessionCountsQuery()).data ?? [];
  // The newest runner release anyone can see: this instance's /dl/version.json, or any of the
  // account's runners, whichever is newer.
  const publishedVersion = useQuery(publishedRunnerVersionQuery()).data;
  const latestVersion = latestRunnerVersion(publishedVersion, runners.data ?? []);
  // The account's switch for smart model selection: off (the default), the Agent has no switch of
  // its own for it, and its Model line reads as it always has.
  const smartSelection = useQuery(meQuery()).data?.preferences?.modelRouting === true;

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
    onError: (e: Error) => message.error("Couldn't rename the runner", e.message),
  });

  // What is typed into Max Concurrent, shown until its save settles. The ref is what a save reads:
  // it is written the moment antd reports a value — including the in-range one it corrects an
  // out-of-range entry to as focus leaves — which the state would only have by the next render.
  const [maxDraft, setMaxDraft] = useState<number | null>(null);
  const maxTyped = useRef<number | null>(null);
  // Capacity saves as it changes — Max Concurrent on blur or Enter, Keep Free on pick — with the
  // PATCH the rename uses. The value goes into the runner list at once, so a control doesn't snap
  // back to the old number while the save lands.
  const capacityMut = useMutation({
    mutationFn: (patch: { maxConcurrent?: number; minFreeDiskMb?: number | null }) =>
      api(`/runners/${runnerId}`, { method: 'PATCH', body: patch }),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: ['runners'] });
      const previous = qc.getQueryData<Runner[]>(['runners']);
      if (previous) {
        qc.setQueryData<Runner[]>(
          ['runners'],
          previous.map((r) => (r.id === runnerId ? { ...r, ...patch } : r)),
        );
      }
      return { previous };
    },
    onError: (e: Error, _patch, context) => {
      if (context?.previous) qc.setQueryData(['runners'], context.previous);
      message.error("Couldn't save the capacity", e.message);
    },
    onSettled: () => {
      setMaxDraft(null);
      void qc.invalidateQueries({ queryKey: ['runners'] });
    },
  });
  // Where the disk card's "Set a Reserve…" lands.
  const capacityRef = useRef<HTMLElement>(null);
  const keepFreeRef = useRef<RefSelectProps>(null);
  // The sign-in panel open in Engines — a row's own, or the one a Needs Attention card's Sign In
  // opens on that engine's row — and the row that card brought into view.
  const [signIn, setSignIn] = useState<string | null>(null);
  const [signInEngine, setSignInEngine] = useState<LoginEngine | null>(null);
  // Update Engines: POST /runners/:id/engine-update takes no engine — it updates every CLI on the
  // machine, so it is the machine's to offer: from Engines' head, and from a Needs Attention card.
  const engineUpdate = useMutation({
    mutationFn: () => api(`/runners/${runnerId}/engine-update`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['runners'] }),
    onError: (e: Error) => message.error("Couldn't start the engine update", e.message),
  });
  const dismissEngineUpdate = useMutation({
    mutationFn: () => api(`/runners/${runnerId}/install`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['runners'] }),
  });
  // The model picker lists what these CLIs report, re-read hourly by the runner — and on the spot
  // after it installs a newer engine. This asks for a pass now, for a model a CLI learned about
  // some other way. There is no relay to watch: the refreshed catalog simply arrives
  // on a heartbeat, which is why the toast promises a minute rather than showing progress.
  const refreshModels = useMutation({
    mutationFn: () => api(`/runners/${runnerId}/refresh-models`, { method: 'POST' }),
    onSuccess: () => {
      message.success('Re-reading this machine’s model lists — the picker updates within a minute.');
      void qc.invalidateQueries({ queryKey: ['runners'] });
    },
    onError: (e: Error) => message.error("Couldn't refresh the model lists", e.message),
  });
  // Update Runner Now: the runner checks for its release at once rather than at its next 10-minute
  // check, by the same rules — a turn in flight still holds the install. Nothing answers but the
  // update state its next heartbeats report, which the list's refetch brings to this page.
  const runnerUpdate = useMutation({
    mutationFn: () => api(`/runners/${runnerId}/self-update`, { method: 'POST' }),
    onSuccess: () => {
      message.success(RUNNER_UPDATE_RUNNER_REQUESTED);
      void qc.invalidateQueries({ queryKey: ['runners'] });
    },
    onError: (e: Error) => message.error("Couldn't start the runner update", e.message),
  });
  const rotation = useRunnerTokenRotation();
  // Repair a checkout stuck mid-merge — the same request and words as a session's merge bar.
  const repairMut = useMutation({
    mutationFn: (workspaceId: string) => cleanUpWorkspaceRepo(workspaceId),
    onSuccess: () => {
      message.success(REPO_CLEANUP_QUEUED);
      void qc.invalidateQueries({ queryKey: ['workspaces'] });
    },
    onError: (e: Error) => message.error("Couldn't clean up the checkout", e.message),
  });
  const deleteMut = useMutation({
    mutationFn: () => api(`/runners/${runnerId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['runners'] });
      navigate('/infrastructure');
    },
    onError: (e: Error) => message.error("Couldn't delete the runner", e.message),
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
  const [fModelRouting, setFModelRouting] = useState(false);
  const [fRoutingEngines, setFRoutingEngines] = useState<string[]>([]);
  const [fEnv, setFEnv] = useState<{ key: string; value: string }[]>([]);
  // null = Default, the runner's own Codex account.
  const [fCodexAccount, setFCodexAccount] = useState<string | null>(null);
  const [fClaudeAccount, setFClaudeAccount] = useState<string | null>(null);
  const [fAntigravityAccount, setFAntigravityAccount] = useState<string | null>(null);
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

  const saveMut = useMutation({
    mutationFn: () => {
      const body = {
        name: fName.trim(),
        appendSystemPrompt: fAppend.trim() || undefined,
        workDir: fWorkDir.trim() || undefined,
        repoUrl: fRepoUrl.trim() || undefined,
        enableWorktree: fEnableWorktree,
        modelRouting: fModelRouting,
        modelRoutingProviders: fRoutingEngines,
        env: Object.fromEntries(
          fEnv.map((r) => [r.key.trim(), r.value]).filter(([k]) => k),
        ),
        codexAccount: fCodexAccount,
        claudeAccount: fClaudeAccount,
        antigravityAccount: fAntigravityAccount,
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
          .catch((e: Error) =>
            message.error(
              transcripts.length === 1
                ? "Couldn't import the conversation"
                : "Couldn't import the conversations",
              e.message,
            ),
          );
      }
      void qc.invalidateQueries({ queryKey: ['workspaces'] });
      setFormOpen(false);
      setEditing(null);
      setDirty(false);
    },
    onError: (e: Error) =>
      message.error(editing ? "Couldn't save the workspace" : "Couldn't create the workspace", e.message),
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
    onError: (e: Error, v) =>
      message.error(v.enabled ? "Couldn't enable the workspace" : "Couldn't disable the workspace", e.message),
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
          claudeAccount: a.claudeAccount ?? null,
          antigravityAccount: a.antigravityAccount ?? null,
          runnerId,
        },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['workspaces'] }),
    onError: (e: Error) => message.error("Couldn't duplicate the workspace", e.message),
  });
  const removeWorkspaceMut = useMutation({
    mutationFn: (id: string) => api(`/workspaces/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['workspaces'] }),
    onError: (e: Error) => message.error("Couldn't delete the workspace", e.message),
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
    onError: (e: Error) => message.error("Couldn't import the session", e.message),
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
    onError: (e: Error) => message.error("Couldn't remove the imported conversations", e.message),
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
    setFModelRouting(a?.modelRouting ?? false);
    setFRoutingEngines(a?.modelRoutingProviders ?? []);
    setFEnv(Object.entries(a?.env ?? {}).map(([key, value]) => ({ key, value })));
    setFCodexAccount(a?.codexAccount ?? null);
    setFClaudeAccount(a?.claudeAccount ?? null);
    setFAntigravityAccount(a?.antigravityAccount ?? null);
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
    const advCount =
      (fEnv.length ? 1 : 0) +
      (fAppend.trim() ? 1 : 0) +
      (fCodexAccount ? 1 : 0) +
      (fClaudeAccount ? 1 : 0) +
      (fAntigravityAccount ? 1 : 0);
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
      {/* Full width below the grid — a URL is the longest thing this form asks for. */}
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
          Used for project integration. When empty, the runner detects origin on its next directory
          scan and fills this in. You can also enter the repository URL here.
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
      {/* Off by default, and only the owner's to turn on: it decides what task runs cost, so the
          agent tools cannot set it (docs/model-routing-design.md §7.2). */}
      {smartSelection && (
        <SettingRow
          label="Smart model selection for tasks"
          desc="Task runs use the model and effort of the tier suggested for the task, and go one tier up after a failed run. Tasks with no suggestion start on this Agent's model. A model pinned on a task always wins. Sessions you open yourself are not affected."
          checked={fModelRouting}
          onChange={(v) => {
            setFModelRouting(v);
            setDirty(true);
          }}
        >
          <RoutingEngines
            own={formProvider}
            value={fRoutingEngines}
            onChange={(next) => {
              setFRoutingEngines(next);
              setDirty(true);
            }}
          />
        </SettingRow>
      )}

      {/* Model is not a workspace field: it resolves from the runtime/provider this project last
          ran on. Stated read-only because the row displays it — otherwise it reads as a setting
          someone forgot to make editable. Mode and effort are deliberately not here: they are
          per-session choices, made in the session where the context for them is. With smart
          selection on, that model is only what the sessions opened by hand start on. */}
      <div className="rd-form-derived">
        {smartSelection && fModelRouting ? (
          <>
            Task runs: model picked per task by smart selection. Sessions you open yourself:{' '}
            <b>{formModel || '—'}</b> · resolved by {providerLabelFor(formProvider)} on this runner.
          </>
        ) : (
          <>
            Model <b>{formModel || '—'}</b> · resolved by {providerLabelFor(formProvider)} on this
            runner. Pick a different one from the session composer.
          </>
        )}
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
          {runner && offersAccount(runner, 'codex', fCodexAccount) && (
            <AccountSelect
              engine="codex"
              runner={runner}
              value={fCodexAccount}
              onChange={(next) => {
                setFCodexAccount(next);
                setDirty(true);
              }}
              envDir={fEnv.find((r) => r.key.trim() === 'CODEX_HOME')?.value}
            />
          )}
          {runner && offersAccount(runner, 'claude', fClaudeAccount) && (
            <AccountSelect
              engine="claude"
              runner={runner}
              value={fClaudeAccount}
              onChange={(next) => {
                setFClaudeAccount(next);
                setDirty(true);
              }}
              envDir={fEnv.find((r) => r.key.trim() === 'CLAUDE_CONFIG_DIR')?.value}
            />
          )}
          {runner && offersAccount(runner, 'antigravity', fAntigravityAccount) && (
            <AccountSelect
              engine="antigravity"
              runner={runner}
              value={fAntigravityAccount}
              onChange={(next) => {
                setFAntigravityAccount(next);
                setDirty(true);
              }}
              envDir={fEnv.find((r) => r.key.trim() === 'ORBIT_ANTIGRAVITY_GOOGLE_DIR')?.value}
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
    const running = sessionCounts.find((count) => count.workspaceId === a.id)?.running ?? 0;
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
      {running > 0 && <span className="rd-workspace-running">{runnerWorkspaceRunning(running)}</span>}
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
        <span className="rd-link" onClick={() => navigate('/infrastructure')}>
          back to Infrastructure
        </span>
        .
      </div>
    );
  }

  const shownName = runner.displayName || runner.name;
  const nowMs = Date.now();
  const attention = runnerAttention({ runner, workspaces, nowMs, latestVersion });

  // Capacity's readings: the tightest disk its workspaces sit on, and the floor it keeps free.
  const disk = runnerDisk(workspaces);
  const reserveMb = runner.minFreeDiskMb != null && runner.minFreeDiskMb > 0 ? runner.minFreeDiskMb : null;
  const diskWarn = !!disk && (disk.usedPercent >= 90 || (reserveMb !== null && disk.freeBytes < reserveMb * MIB));
  // Keep Free's picks, as minFreeDiskMb with 0 standing for Off (a Select value can't be null). A
  // floor set to something other than a tier is shown as it is, in order, rather than as "Off".
  const keepFreeOptions = [
    ...KEEP_FREE_TIERS.map((tier) => ({ value: tier.mb ?? 0, label: tier.label })),
    ...(reserveMb !== null && !KEEP_FREE_TIERS.some((tier) => tier.mb === reserveMb)
      ? [{ value: reserveMb, label: keepFreeLabel(reserveMb) }]
      : []),
  ].sort((a, b) => a.value - b.value);

  const commitMaxConcurrent = () => {
    const next = maxTyped.current;
    maxTyped.current = null;
    if (next === null) return;
    if (next === runner.maxConcurrent) setMaxDraft(null);
    else capacityMut.mutate({ maxConcurrent: next });
  };

  // About's version line: current, catching up by itself, or stuck until someone upgrades it. A
  // runner that reports where its updates stand says which; an older one is judged by runsAsRoot.
  const version = runner.version?.trim() || null;
  const versionNote = (() => {
    if (!version || !latestVersion) return null;
    const stuck = attention.find((item) => item.kind === 'cannotSelfUpdate');
    if (stuck) return { text: stuck.short, warn: true };
    if (compareRunnerVersions(version, latestVersion) >= 0) return { text: RUNNER_VERSION_LATEST, warn: false };
    const state = runner.selfUpdate?.state;
    if (state === 'heldByRollout') return { text: RUNNER_VERSION_NOT_ROLLED_OUT, warn: false };
    if (state === 'enabled' || state === 'waitingForIdle') {
      return { text: RUNNER_VERSION_INSTALLS_WHEN_IDLE, warn: false };
    }
    if (state) return null;
    return runner.runsAsRoot ? { text: RUNNER_VERSION_INSTALLS_WHEN_IDLE, warn: false } : null;
  })();
  // The last update it installed into itself, for a runner that reports it: when, and its versions.
  const lastUpdate = (() => {
    const report = runner.selfUpdate;
    if (!report) return null;
    const versions =
      report.lastUpdatedFrom && report.lastUpdatedTo
        ? runnerUpdatedFromTo(report.lastUpdatedFrom, report.lastUpdatedTo)
        : report.lastUpdatedTo;
    const parts = [report.lastUpdatedAt ? fmtTime(report.lastUpdatedAt) : null, versions];
    return parts.filter(Boolean).join(RUNNER_LINE_SEPARATOR) || '—';
  })();
  const canUpdateNow = runnerCanUpdateNow(runner, nowMs);
  // An engine update shares the runner's one relay slot with an engine's install. Only a run in
  // `update` mode is Engines' news; an install's belongs to the row that started it.
  const relay = runner.install;
  const updating = relay?.mode === 'update';
  const relayInFlight = relay?.status === 'pending' || relay?.status === 'installing';

  const openRename = () => {
    setRenameVal(shownName);
    setRenaming(true);
  };
  const focusKeepFree = () => {
    capacityRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    keepFreeRef.current?.focus({ preventScroll: true });
  };
  const copyCommand = (command: string) =>
    void copyText(command).then((ok) =>
      ok ? message.success('Command copied') : message.error("Couldn't copy the command"),
    );

  /** The one thing a card offers, where it has one. */
  const attentionAction = (item: AttentionItem): ReactNode => {
    const action = item.action;
    switch (action?.kind) {
      case 'signIn': {
        // Signed in where the engine is listed, below: its row's sign-in opens, and the row comes
        // into view.
        const engine = action.engine;
        return engine && engine !== 'opencode' && engine !== 'dsh' ? (
          <Button
            size="small"
            onClick={() => {
              setSignIn(ownSignInPanel(runner, engine));
              setSignInEngine(engine);
            }}
          >
            {RUNNER_SIGN_IN}
          </Button>
        ) : null;
      }
      case 'repair': {
        const workspaceId = action.workspaceId;
        const root = typeof item.params.root === 'string' ? item.params.root : '';
        return workspaceId ? (
          <Button
            size="small"
            loading={repairMut.isPending}
            onClick={() =>
              modal.confirm({
                ...repoCleanupConfirm(root),
                onOk: () => repairMut.mutateAsync(workspaceId).catch(() => {}),
              })
            }
          >
            {RUNNER_REPAIR}
          </Button>
        ) : null;
      }
      case 'setReserve':
        return (
          <Button size="small" onClick={focusKeepFree}>
            {RUNNER_SET_A_RESERVE}
          </Button>
        );
      case 'copyCommand': {
        const command = action.command;
        return command ? (
          <Button size="small" icon={<CopyOutlined />} onClick={() => copyCommand(command)}>
            {RUNNER_COPY_COMMAND}
          </Button>
        ) : null;
      }
      case 'updateEngines':
        return (
          <Button size="small" disabled={engineUpdate.isPending} onClick={() => engineUpdate.mutate()}>
            {RUNNER_UPDATE_ENGINES_NOW}
          </Button>
        );
      case 'updateRunner':
        return (
          <Button size="small" disabled={runnerUpdate.isPending} onClick={() => runnerUpdate.mutate()}>
            {RUNNER_UPDATE_RUNNER_NOW}
          </Button>
        );
      default:
        return null;
    }
  };

  // A quota card says when the window resets first, in the reader's own time zone.
  const attentionDetail = (item: AttentionItem): string => {
    const resetsAt = item.params.resetsAt;
    return typeof resetsAt === 'string'
      ? `${attentionQuotaResets(fmtReset(resetsAt))} ${item.detail}`
      : item.detail;
  };

  // Rename, Rotate token, Delete. Max Concurrent is no longer here: it lives in Capacity, where it
  // saves as it changes.
  const kebab: MenuProps['items'] = [
    {
      key: 'rename',
      icon: <EditOutlined />,
      label: 'Rename',
      onClick: openRename,
    },
    {
      key: 'rotate',
      icon: <KeyOutlined />,
      label: 'Rotate token',
      onClick: () => rotation.confirmRotate(runner),
    },
    { type: 'divider' },
    {
      key: 'delete',
      icon: <DeleteOutlined />,
      label: 'Delete',
      danger: true,
      onClick: () =>
        modal.confirm({
          title: `Delete “${shownName}”?`,
          content:
            'This removes the runner and its workspaces from your account. Re-register the machine to add it back.',
          okText: 'Delete',
          okButtonProps: { danger: true },
          cancelText: 'Cancel',
          onOk: () => deleteMut.mutateAsync(),
        }),
    },
  ];

  const runsAs =
    runner.runsAsRoot === true
      ? RUNNER_RUNS_AS_ROOT
      : runner.runsAsRoot === false
        ? RUNNER_RUNS_AS_REGULAR_USER
        : '—';

  return (
    <>
      <div className="rd-page">
      <div className="rd-head">
        <span className="rd-back" onClick={() => navigate('/infrastructure')}>
          <ArrowLeftOutlined /> Infrastructure
        </span>
      </div>

      <div className="rd-title-row">
        <span
          className="runner-dot"
          style={{ background: runner.online ? 'var(--success-solid)' : 'var(--dot-idle)' }}
          title={runner.online ? RUNNER_ONLINE : RUNNER_OFFLINE}
        />
        <h1 className="page-title" style={{ margin: 0 }}>
          {shownName}
        </h1>
        <div style={{ flex: 1 }} />
        <Dropdown trigger={['click']} placement="bottomRight" menu={{ items: kebab }}>
          <Button icon={<MoreOutlined />}>Actions</Button>
        </Dropdown>
      </div>

      {/* Who it is at a glance, on one line under the name; the facts behind it are in About. */}
      <div className="rd-metaline">
        {runner.online ? (
          <span className="rd-meta-ok">{RUNNER_ONLINE}</span>
        ) : (
          <span>
            {runner.lastHeartbeatAt
              ? runnerOfflineLastSeen(fmtTime(runner.lastHeartbeatAt))
              : RUNNER_OFFLINE}
          </span>
        )}
        {runner.online && typeof runner.maxConcurrent === 'number' && (
          <span>{runnerRunningOf(runner.activeSessions ?? 0, runner.maxConcurrent)}</span>
        )}
        {version && <span>{runnerVersionTag(version)}</span>}
        {runner.hostname && <span>{runner.hostname}</span>}
      </div>

      {/* Only when something needs a person, above both columns: each card says what happened,
          why it matters, and offers the one thing that fixes it. */}
      {attention.length > 0 && (
        <section className="rd-attention" aria-label={RUNNER_NEEDS_ATTENTION}>
          {attention.map((item, index) => (
            <div key={`${item.kind}:${index}`} className={`rd-attention-card ${item.tone}`}>
              <span className="rd-attention-icon">{ATTENTION_ICON[item.kind]}</span>
              <div className="rd-attention-main">
                <div className="rd-attention-title">{item.title}</div>
                <div className="rd-attention-detail">{attentionDetail(item)}</div>
                {item.action && <div className="rd-attention-action">{attentionAction(item)}</div>}
              </div>
            </div>
          ))}
        </section>
      )}

      {/* Two columns from 641px: the machine's contents on the left, its settings and facts on the
          right. Narrower, one column in the phone's order — Capacity, Engines, Workspaces, About —
          which index.css sets with `order`, so the columns themselves never move. */}
      <div className="rd-cols">
        <div className="rd-col rd-col-main">
          {/* What software this machine runs, and each engine's sign-in: the rows of its card in
              Infrastructure, where an engine is signed in, installed and its accounts managed. Which
              version is installed is the same class of fact as the runner version, so updating them
              lives in this section's head and nowhere else. */}
          <section className="rd-section rd-engines">
            <div className="rd-section-head">
              <div className="rd-section-title">{RUNNER_ENGINES}</div>
              {/* Understated on purpose: Orbit updates these every 30 min, so this is the escape
                  hatch for when that isn't soon enough — not the way the CLIs are meant to stay
                  current. The models button sits here for the same reason it exists: what a CLI
                  offers is a fact about this machine's engines, and updating one is exactly when
                  the other goes stale. */}
              {runner.online && (
                <div className="rd-section-actions">
                  <Button size="small" disabled={refreshModels.isPending} onClick={() => refreshModels.mutate()}>
                    Refresh models
                  </Button>
                  <Button
                    size="small"
                    disabled={relayInFlight || engineUpdate.isPending}
                    onClick={() => engineUpdate.mutate()}
                  >
                    {relayInFlight && updating ? 'Updating…' : 'Update engines'}
                  </Button>
                </div>
              )}
            </div>

            {/* The run's report. Unlike an install it is not retired by the next probe: the summary —
                what moved, what was skipped and why — exists nowhere else once it's gone. */}
            {updating && relay?.status && (
              <div className={`rd-engine-relay${relay.status === 'failed' ? ' bad' : ''}`}>
                <div className="rd-engine-relay-row">
                  {relay.status === 'pending'
                    ? 'Queued — the runner picks this up on its next check-in.'
                    : relay.status === 'installing'
                      ? 'Updating this machine’s engine CLIs…'
                      : relay.message || 'Nothing to update.'}
                </div>
                {relay.status !== 'pending' && relay.command && (
                  <div className="rd-engine-relay-hint">
                    Orbit ran <code className="re-cmd">{relay.command}</code>
                  </div>
                )}
                {(relay.status === 'done' || relay.status === 'failed') && (
                  <div className="rd-engine-relay-hint">
                    <button className="re-link" type="button" onClick={() => dismissEngineUpdate.mutate()}>
                      Dismiss
                    </button>
                  </div>
                )}
              </div>
            )}

            <div className={`re-card re-runner-card${runner.online ? '' : ' offline'}`}>
              <MachineEngines
                runner={runner}
                signIn={signIn}
                onSignIn={setSignIn}
                focusEngine={signInEngine}
                machinePage
              />
            </div>
            {runner.engines && (
              <div className="rd-hint">{runner.online ? RUNNER_ENGINES_FOOTER : RUNNER_ENGINES_OFFLINE_FOOTER}</div>
            )}
          </section>

          <section className="rd-section rd-workspaces">
            <div className="rd-section-head">
              <div className="rd-section-title">{RUNNER_WORKSPACES}</div>
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

        <div className="rd-col rd-col-side">
          <section className="rd-section rd-capacity" ref={capacityRef}>
            <div className="rd-section-head">
              <div className="rd-section-title">{RUNNER_CAPACITY}</div>
            </div>
            <div className="rd-box">
              <div className="rd-kv">
                <span className="rd-kv-label">{RUNNER_MAX_CONCURRENT}</span>
                {/* Saved on blur from around the field, so it runs after antd has settled what was
                    typed (1–64, whole) — and on Enter, which antd settles first as well. */}
                <span onBlur={commitMaxConcurrent}>
                  <InputNumber
                    className="rd-max-concurrent"
                    size="small"
                    min={1}
                    max={64}
                    precision={0}
                    value={maxDraft ?? runner.maxConcurrent ?? null}
                    onChange={(v) => {
                      maxTyped.current = v;
                      setMaxDraft(v);
                    }}
                    onPressEnter={commitMaxConcurrent}
                  />
                </span>
              </div>
              <div className="rd-disk">
                <div className="rd-kv-row">
                  <span className="rd-kv-label">{RUNNER_DISK}</span>
                  <span className="rd-kv-value">
                    {disk
                      ? runnerDiskUsed(
                          formatDiskGb(disk.totalBytes - disk.freeBytes),
                          formatDiskGb(disk.totalBytes),
                        )
                      : '—'}
                  </span>
                </div>
                {disk && (
                  <div className={`rd-disk-bar${diskWarn ? ' warn' : ''}`}>
                    <span style={{ width: `${disk.usedPercent}%` }} />
                  </div>
                )}
              </div>
              <div className="rd-kv">
                <span className="rd-kv-label">{RUNNER_KEEP_FREE}</span>
                <Select
                  ref={keepFreeRef}
                  className="rd-keep-free"
                  size="small"
                  value={reserveMb ?? 0}
                  options={keepFreeOptions}
                  onChange={(mb: number) => capacityMut.mutate({ minFreeDiskMb: mb === 0 ? null : mb })}
                  popupMatchSelectWidth={false}
                />
              </div>
            </div>
            <div className="rd-hint">{RUNNER_CAPACITY_FOOTER}</div>
          </section>

          <section className="rd-section rd-about">
            <div className="rd-section-head">
              <div className="rd-section-title">{RUNNER_ABOUT}</div>
              {/* Like Update engines: the escape hatch for when its own 10-minute check isn't soon
                  enough. Offered only where a check now can change something. */}
              {canUpdateNow && (
                <Button size="small" disabled={runnerUpdate.isPending} onClick={() => runnerUpdate.mutate()}>
                  {RUNNER_UPDATE_RUNNER_NOW}
                </Button>
              )}
            </div>
            <div className="rd-box">
              <AboutRow label={RUNNER_ABOUT_NAME}>
                {shownName}
                <button type="button" className="rd-inline-link" onClick={openRename}>
                  Rename
                </button>
              </AboutRow>
              <AboutRow label={RUNNER_ABOUT_HOSTNAME}>{runner.hostname || '—'}</AboutRow>
              <AboutRow label={RUNNER_ABOUT_VERSION}>
                {version ?? '—'}
                {versionNote && (
                  <small className={versionNote.warn ? 'warn' : undefined}>{versionNote.text}</small>
                )}
              </AboutRow>
              {lastUpdate && <AboutRow label={RUNNER_ABOUT_LAST_UPDATE}>{lastUpdate}</AboutRow>}
              <AboutRow label={RUNNER_ABOUT_RUNS_AS}>{runsAs}</AboutRow>
              <AboutRow label={RUNNER_ABOUT_REPOS_FOLDER}>{runner.reposRoot || '—'}</AboutRow>
              <AboutRow label={RUNNER_ABOUT_LAST_CHECK_IN}>
                {runner.lastHeartbeatAt ? ago(runner.lastHeartbeatAt, nowMs) : '—'}
              </AboutRow>
              <AboutRow label={RUNNER_ABOUT_REGISTERED}>{fmtDate(runner.enrolledAt)}</AboutRow>
            </div>
            {/* Root costs one permission mode: claude refuses Bypass under root. Said here because
                the picker only ever drops it without a word. */}
            {runner.runsAsRoot && <div className="rd-hint">{RUNNER_ROOT_NO_BYPASS}</div>}
          </section>
        </div>
      </div>
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

      {rotation.tokenModal}
    </>
  );
}

/** One fact in About: its name on the left, the value on the right. */
function AboutRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rd-kv">
      <span className="rd-kv-label">{label}</span>
      <span className="rd-kv-value">{children}</span>
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
    onError: (e: Error) => message.error("Couldn't revoke the permission rule", e.message),
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
  children,
}: {
  label: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  /** What belongs to this setting, under its explanation. */
  children?: ReactNode;
}) {
  return (
    <div className="rd-set-row">
      <div className="rd-set-main">
        <div className="rd-set-label">{label}</div>
        <div className="rd-set-desc">{desc}</div>
        {children}
      </div>
      <Switch checked={checked} onChange={onChange} />
    </div>
  );
}

/** The engines a task run can be routed onto: the built-in ones with a tier table
 *  (docs/model-routing-design.md §4.3). */
const ROUTING_ENGINES = ['claude', 'codex'];

/**
 * The engines smart selection may move this Agent's task runs to (docs/model-routing-design.md §6),
 * saved as `modelRoutingProviders`. The Agent's own engine is always one, so it is ticked and cannot
 * be unticked; every other one is a tick the owner makes here, and none is ticked until they do.
 */
function RoutingEngines({
  own,
  value,
  onChange,
}: {
  own: string;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const engines = ROUTING_ENGINES.includes(own) ? ROUTING_ENGINES : [own, ...ROUTING_ENGINES];
  return (
    <div className="rd-route-engines">
      <div className="rd-engines-label">Engines it may use</div>
      <div className="rd-engines-list">
        {engines.map((engine) => {
          const on = engine === own || value.includes(engine);
          return (
            <Checkbox
              key={engine}
              className={on ? 'is-on' : undefined}
              checked={on}
              disabled={engine === own}
              onChange={(e) =>
                onChange(e.target.checked ? [...value, engine] : value.filter((v) => v !== engine))
              }
            >
              {engine}
            </Checkbox>
          );
        })}
      </div>
      <div className="rd-engines-note">
        Only this agent's own engine is ticked by default, so a task never moves to another engine
        unless you tick it here.
      </div>
    </div>
  );
}
