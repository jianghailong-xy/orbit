import { AgentFixButton, AgentFixLine } from '../AgentFix';
import { MachineTerminalsSection, TerminalRequestsSection } from '../TerminalRequests';
import { HelpLearnMore } from '../help/HelpLearnMore';
import { HELP_ERROR_ATTR } from '../../lib/help/drawerArticles';
import { ENGINE_UPDATE_FIX_TARGET, agentFixView, attentionFixTarget } from '../../lib/agentFix';
import {
  BranchesOutlined,
  CloudDownloadOutlined,
  CopyOutlined,
  DashboardOutlined,
  DeleteOutlined,
  DisconnectOutlined,
  EditOutlined,
  HddOutlined,
  KeyOutlined,
  LoginOutlined,
  MoreOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
  SyncOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { engineUpdateFailedLines, engineUpdateLineFailed, type LoginEngine } from '@orbit/shared';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, cleanUpWorkspaceRepo } from '../../api';
import { encodeId, routeId } from '../../lib/idCodec';
import { machineDraftPath, machineName } from '../../lib/machineSetup';
import { managedRowOf, useManagedRunner, useWakeForSignIn } from '../../lib/managedRunner';
import { RunnerBrowserSection } from './RunnerBrowserSection';
import { ManagedRunnerNotice } from '../ManagedRunnerNotice';
import { ManagedUpdateCard } from '../ManagedUpdateCard';
import { managedVersionLine, readUpdateOutcome } from '../../lib/managedRunnerUpdate';
import { machineEmpty, START_A_SESSION } from '../../lib/machineSetupCopy';
import { publishedRunnerVersionQuery, workspaceSessionCountsQuery } from '../../lib/queries';
import { AbandonedCheckouts } from '../AbandonedCheckouts';
import {
  MachineEngines,
  accountsGroup,
  ownSignInPanel,
  tildePath,
  useDismissEngineUpdateWarning,
  useOpenAccounts,
} from '../RunnerEngines';
import { useRunnerTokenRotation } from '../RunnerTokenRotation';
import type { Runner } from '../TasksSidePanel';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { useConfirm } from '../ui/ConfirmDialog';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { Menu, type MenuItem } from '../ui/Menu';
import { NumberInput } from '../ui/NumberInput';
import { EXTRA_SESSIONS_ON_DEMAND } from '../../lib/queuedCapacity';
import { Select } from '../ui/Select';
import { Spinner } from '../ui/Spinner';
import { copyText } from '../../lib/clipboard';
import { REPO_CLEANUP_QUEUED, repoCleanupConfirm } from '../../lib/repoCleanup';
import {
  KEEP_FREE_TIERS,
  compareRunnerVersions,
  isReleaseVersion,
  keepFreeLabel,
  latestRunnerVersion,
  runnerAttention,
  runnerCanUpdateNow,
  runnerDisk,
  runnerLocationLine,
  runnerVersionLine,
  type AttentionItem,
  type AttentionKind,
} from '../../lib/runnerAttention';
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
  RUNNER_ENGINES,
  RUNNER_RESOURCES,
  MANAGED_RUNNER_NOT_REPORTED,
  MANAGED_RUNNER_UPDATED_BY_ORBIT,
  RUNNER_ENGINES_FOOTER,
  RUNNER_ENGINES_MANAGED_FOOTER,
  RUNNER_ENGINES_OFFLINE_FOOTER,
  RUNNER_KEEP_FREE,
  RUNNER_LINE_SEPARATOR,
  RUNNER_MAX_CONCURRENT,
  RUNNER_MAX_CONCURRENT_HINT,
  RUNNER_MAX_CONCURRENT_UNIT,
  RUNNER_MAX_CONCURRENT_DECREASE,
  RUNNER_MAX_CONCURRENT_INCREASE,
  RUNNER_EDIT,
  RUNNER_NEEDS_ATTENTION,
  RUNNER_OFFLINE,
  RUNNER_UPDATE_NOW,
  RUNNER_UPDATE_NOW_CONFIRM,
  RUNNER_UPDATE_NOW_CONFIRM_BODY,
  runnerUpdateNowConfirmTitle,
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
  runnerVersionInstallsWhenQuiet,
  RUNNER_VERSION_LATEST,
  RUNNER_VERSION_NOT_ROLLED_OUT,
  attentionDismissUntilNextRelease,
  attentionQuotaResets,
  runnerOfflineLastSeen,
  runnerRunningOf,
  runnerRunningNow,
  runnerMaxBelowRunning,
  runnerUpdatedFromTo,
  runnerVersionUpdatingTo,
  runnerWorkspaceRunning,
} from '../../lib/runnerCopy';
import { runnerQuietMinutes, runnerUpdateCard } from '../../lib/runnerUpdateCard';
import { RunnerUpdateLaterMenu } from '../RunnerUpdateLater';
import { RunnerUpdateNowButton } from '../RunnerUpdateNow';
import { runnerTakesUpdateNow } from '../../lib/runnerUpdateNow';
import { useClaudeRegionCheckAgain } from '../../lib/claudeRegion';
import { CLAUDE_REGION_CHECK_AGAIN, claudeRegionChecked } from '../../lib/claudeRegionCopy';
import { ago, ENGINE_CLI_NAME } from '../../lib/runnerEngines';
import { useToast } from '../../lib/toast';
import { MachineResources } from './MachineResources';
import { MachineSecrets } from './MachineSecrets';
import { SettingsCard, SettingsRow, SettingsSection } from './SettingsBlocks';
import './Settings.css';

/** What this page reads of a workspace: its row, and what Needs Attention and the disk bar read. */
interface MachineWorkspace {
  id: string;
  name: string;
  runnerId?: string | null;
  workDir?: string | null;
  enabled?: boolean;
  workDirFreeBytes?: string | number | null;
  workDirTotalBytes?: string | number | null;
}

/** The engines a deep link (`?engine=`, from `/infrastructure?runner=…&engine=…`) may name. */
const LINK_ENGINES: readonly LoginEngine[] = ['claude', 'codex', 'kimi', 'antigravity', 'cursor'];

const MACHINES_ENGINES_NOTE = 'Subscriptions signed in here are spent only by sessions on this machine.';
const WORKSPACES_ON_MACHINE = 'Workspaces on this machine';
const DELETE_MACHINE = 'Delete machine';
const DELETE_MACHINE_NOTE =
  'This removes the runner and its workspaces from your account. Re-register the machine to add it back.';
// The ceiling enforced by UpdateRunnerDto for burstConcurrent.
const MAX_EXTRA_SESSIONS = 32;

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

/** Each Needs Attention card's mark, by what it is about. */
const ATTENTION_ICON: Record<AttentionKind, ReactNode> = {
  offline: <DisconnectOutlined />,
  noCliSignedIn: <LoginOutlined />,
  engineSignedOut: <LoginOutlined />,
  claudeRegionUnsupported: <WarningOutlined />,
  checkoutStuck: <BranchesOutlined />,
  quotaNearLimit: <DashboardOutlined />,
  diskLow: <HddOutlined />,
  cannotSelfUpdate: <CloudDownloadOutlined />,
  engineNotUpdating: <SyncOutlined />,
};

/**
 * /settings/machines/:id — one machine, in Settings' single column (docs/mocks/settings-redesign,
 * board-3), most-handled first: its name with a status pill and a ⋯ holding the machine's actions, what
 * needs a person, then Engines, Capacity, the workspaces on it (listed and linked only: a workspace's
 * settings have one home, its own page), abandoned checkouts when there are any, its approved terminals when it has any, About, and Delete.
 *
 * What was RunnerDetailPage's machine half; the rules and copy are runnerAttention's and runnerCopy's.
 */
/**
 * How often the machine page re-reads the runners: every 4 s while an engine install or an account
 * removal on this machine is in flight, as the old engine card list did, since its progress lives on
 * the runner row; every 15 s otherwise. A finished install (not an update) still counts: the row waits
 * for the probe that retires it. So does a removal the machine reported done while it still reports
 * the account.
 */
export function machinePagePollMs(runners: Runner[] | undefined, runnerId: string | null): number {
  const r = runners?.find((one) => one.id === runnerId);
  const inFlight =
    !!r &&
    (r.install?.status === 'pending' ||
      r.install?.status === 'installing' ||
      (r.install?.status === 'done' && r.install?.mode !== 'update') ||
      r.accountRemove?.status === 'pending' ||
      (r.accountRemove?.status === 'done' && !!r.online &&
        !!r.engines?.some((e) => e.engine === r.accountRemove?.engine &&
          e.accounts?.some((a) => a.id === r.accountRemove?.account))));
  return inFlight ? 4_000 : 15_000;
}

/** The lines of an update run that need the person reading it: the failures, and an install Orbit
 *  is not allowed to replace (only its owner can update it). Everything else — current, updated,
 *  pinned, waiting for sessions to finish, retried on the next pass — sorts itself out, and listing
 *  it buried the one line that mattered. Phrases are the runner's, src/runner-go/engineupdate.go. */
function engineUpdateReportLines(message: string | null | undefined): string[] {
  if (!message) return ['Nothing to update.'];
  const lines = message
    .split('\n')
    .filter((line) => engineUpdateLineFailed(line) || line.includes('owned by another user'));
  return lines.length > 0 ? lines : ['Nothing here needs your attention.'];
}

/** A managed runner's row tone as the pill's colour; a moving state carries a spinner on the neutral pill. */
const MANAGED_PILL = { ready: 'online', progress: 'offline', idle: 'offline', attention: 'attention' } as const;

export function MachineSettingsPage() {
  const runnerId = routeId(useParams().id);
  // The Updated card's record is kept on this browser; the card says when it changes, so About's line follows.
  const [, setOutcomeRead] = useState(0);
  const refreshOutcome = useCallback(() => setOutcomeRead((n) => n + 1), []);
  const navigate = useNavigate();
  const [confirm, confirmation] = useConfirm();
  const message = useToast();
  const qc = useQueryClient();

  const runners = useQuery({
    queryKey: ['runners'],
    queryFn: () => api<Runner[]>('/runners'),
    refetchInterval: (q) => machinePagePollMs(q.state.data, runnerId),
  });
  const runner = (runners.data ?? []).find((r) => r.id === runnerId) ?? null;
  // When this machine is the account's managed runner: its state in the shared words, and its notice on top.
  const { managed: accountManaged } = useManagedRunner();
  const managed =
    accountManaged?.status.runnerId && routeId(accountManaged.status.runnerId) === runnerId ? accountManaged : null;
  // Asleep while it waits for a login: opening its page, where it is signed in, wakes it.
  useWakeForSignIn(managed);

  const workspacesQ = useQuery({
    queryKey: ['workspaces'],
    meta: { entities: ['workspace', 'checkout'] },
    queryFn: () => api<MachineWorkspace[]>('/workspaces'),
  });
  const workspaces = (workspacesQ.data ?? []).filter((a) => a.runnerId === runnerId);
  // Each workspace's sessions in flight, for its row's "N running" — the sidebar's own tallies.
  const sessionCounts = useQuery(workspaceSessionCountsQuery()).data ?? [];
  // The newest runner release anyone can see: this instance's /dl/version.json, or any of the
  // account's runners, whichever is newer.
  const latestVersion = latestRunnerVersion(useQuery(publishedRunnerVersionQuery()).data, runners.data ?? []);

  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState('');
  const renameInput = useRef<HTMLInputElement>(null);
  const actionsButton = useRef<HTMLButtonElement>(null);
  const renameMut = useMutation({
    mutationFn: (displayName: string) => api(`/runners/${runnerId}`, { method: 'PATCH', body: { displayName } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['runners'] });
      setRenaming(false);
    },
    onError: (e: Error) => message.error("Couldn't rename the runner", e.message),
  });

  // Max Concurrent's dialog, and what is typed into it. The ref is
  // what Save reads: it is written the moment the field reports a value — including the in-range one
  // it corrects an out-of-range entry to — which the state would only have by the next render.
  const [maxOpen, setMaxOpen] = useState(false);
  const [maxDraft, setMaxDraft] = useState<number | null>(null);
  const maxTyped = useRef<number | null>(null);
  const maxButton = useRef<HTMLButtonElement>(null);
  // Capacity saves as it changes — Max Concurrent on its dialog's Save, dropdowns on pick. The value goes
  // into the runner list at once, so a control doesn't snap back to the old number while the save lands.
  const capacityMut = useMutation({
    mutationFn: (patch: { maxConcurrent?: number; burstConcurrent?: number; minFreeDiskMb?: number | null }) =>
      api<{ notice?: string }>(`/runners/${runnerId}`, { method: 'PATCH', body: patch }),
    // A managed runner's Max Concurrent is at most what its memory allows: the server says when it lowered the value.
    onSuccess: (saved) => {
      if (saved?.notice) message.info('Max Concurrent lowered', saved.notice);
    },
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
    onSettled: (_data, _error, patch) => {
      void qc.invalidateQueries({ queryKey: ['runners'] });
      if (patch.burstConcurrent !== undefined) void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
  // Where the disk card's "Set a Reserve…" lands.
  const capacityRef = useRef<HTMLDivElement>(null);
  const keepFreeRef = useRef<HTMLButtonElement>(null);
  // The sign-in panel open in Engines — a row's own, or the one a Needs Attention card's Sign In
  // opens on that engine's row — and the row that card (or a deep link) brought into view.
  const [signIn, setSignIn] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const engineParam = searchParams.get('engine');
  const linkedEngine = LINK_ENGINES.find((engine) => engine === engineParam) ?? null;
  const [signInEngine, setSignInEngine] = useState<LoginEngine | null>(linkedEngine);
  const [openAccounts, foldAccounts] = useOpenAccounts();
  // A link that named an engine (a "Not signed in" row elsewhere in the app) opens that engine's
  // accounts and brings its row into view; the parameter goes, so a reload doesn't do it again.
  useEffect(() => {
    if (!runnerId || !linkedEngine) return;
    setSignInEngine(linkedEngine);
    foldAccounts(accountsGroup(runnerId, linkedEngine), true);
    setSearchParams((params) => {
      params.delete('engine');
      return params;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runnerId, linkedEngine]);
  // Update Engines: POST /runners/:id/engine-update takes no engine — it updates every CLI on the
  // machine, so it is the machine's to offer: from the ⋯, and from a Needs Attention card.
  const engineUpdate = useMutation({
    mutationFn: () => api(`/runners/${runnerId}/engine-update`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['runners'] }),
    onError: (e: Error) => message.error("Couldn't start the engine update", e.message),
  });
  // Dismiss until next <Engine> release: hides this card and that engine's row panel until a newer release.
  const dismissUpdateWarning = useDismissEngineUpdateWarning(runnerId ?? '');
  const dismissEngineUpdate = useMutation({
    mutationFn: () => api(`/runners/${runnerId}/install`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['runners'] }),
  });
  // The model picker lists what these CLIs report, re-read hourly by the runner — and on the spot
  // after it installs a newer engine. This asks for a pass now; the refreshed catalog simply arrives
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
  // check, by the same rules — a turn in flight still holds the install.
  const runnerUpdate = useMutation({
    mutationFn: () => api(`/runners/${runnerId}/self-update`, { method: 'POST' }),
    onSuccess: () => {
      message.success(RUNNER_UPDATE_RUNNER_REQUESTED);
      void qc.invalidateQueries({ queryKey: ['runners'] });
    },
    onError: (e: Error) => message.error("Couldn't start the runner update", e.message),
  });
  // Check again (docs/claude-region-check-contract.md §7), for a machine blocked for the Claude region.
  const regionCheck = useClaudeRegionCheckAgain({ id: runnerId ?? '', region: runner?.region });
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
      // On to the next machine in the nav, or General when this was the last one.
      const next = (runners.data ?? []).find((r) => r.id !== runnerId);
      void qc.invalidateQueries({ queryKey: ['runners'] });
      navigate(next ? `/settings/machines/${next.id}` : '/settings/general', { replace: true });
    },
    onError: (e: Error) => message.error("Couldn't delete the runner", e.message),
  });

  if (runners.isLoading) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Spinner />
      </div>
    );
  }
  if (!runner) {
    return <p className="settings-empty">This machine doesn't exist, or isn't yours.</p>;
  }

  // Whether this is the account's managed runner: its row says so, or (an older server) the managed status.
  const isManaged = !!managed || runner.managed === true;
  // The managed runner is Orbit Cloud, unless its owner named it (machineName).
  const shownName = machineName(runner, managed ? runnerId : null);
  const nowMs = Date.now();
  // The managed runner's state is its shared label and notice: its heartbeat's "offline" card is not repeated.
  const managedRow = managedRowOf(managed, runnerId);
  const attention = runnerAttention({ runner, workspaces, nowMs, latestVersion, managed: isManaged }).filter(
    (item) => !(managedRow && item.kind === 'offline'),
  );

  // The tightest disk its workspaces sit on (Resources' Disk, for a runner that reads none itself), and the floor
  // it keeps free.
  const disk = runnerDisk(workspaces);
  const reserveMb = runner.minFreeDiskMb != null && runner.minFreeDiskMb > 0 ? runner.minFreeDiskMb : null;
  // Keep Free's picks, as minFreeDiskMb with 0 standing for Off (a Select value can't be null). A
  // floor set to something other than a tier is shown as it is, in order, rather than as "Off".
  const keepFreeOptions = [
    ...KEEP_FREE_TIERS.map((tier) => ({ value: tier.mb ?? 0, label: tier.label })),
    ...(reserveMb !== null && !KEEP_FREE_TIERS.some((tier) => tier.mb === reserveMb)
      ? [{ value: reserveMb, label: keepFreeLabel(reserveMb) }]
      : []),
  ].sort((a, b) => a.value - b.value);

  // Max Concurrent's use: how many of its slots are taken now — online only, as the head's count; amber when all are.
  const running =
    runner.online && typeof runner.maxConcurrent === 'number' && runner.maxConcurrent > 0
      ? {
          active: runner.activeSessions ?? 0,
          max: runner.maxConcurrent,
          percent: Math.min(100, Math.round(((runner.activeSessions ?? 0) / runner.maxConcurrent) * 100)),
          full: (runner.activeSessions ?? 0) >= runner.maxConcurrent,
        }
      : null;
  const openMaxConcurrent = () => {
    maxTyped.current = runner.maxConcurrent ?? 1;
    setMaxDraft(runner.maxConcurrent ?? 1);
    setMaxOpen(true);
  };
  const saveMaxConcurrent = () => {
    const next = maxTyped.current;
    setMaxOpen(false);
    if (next !== null && next !== runner.maxConcurrent) capacityMut.mutate({ maxConcurrent: next });
  };
  const stepMaxConcurrent = (by: number) => {
    const next = Math.max(1, (maxTyped.current ?? runner.maxConcurrent ?? 1) + by);
    maxTyped.current = next;
    setMaxDraft(next);
  };
  const maxUnchanged = maxDraft === null || maxDraft === runner.maxConcurrent;

  // About's version line: current, catching up by itself, or stuck until someone upgrades it. A
  // runner that reports where its updates stand says which; an older one is judged by runsAsRoot.
  const version = runner.version?.trim() || null;
  // The account's managed runner before it first reports (preparing, waiting for capacity, failed to
  // start): no version, no readings, no engines. Once it reports, the page is the ordinary one.
  const managedOutcome = managed && runnerId ? readUpdateOutcome(runnerId) : null;
  const managedWaiting = !!managedRow && managedRow.kind !== 'available' && !version;
  // Orbit Cloud's version line: the build it runs (`Build 95884b1 · Nov 16`), never "Kept up to date by Orbit".
  const managedBuild = isManaged ? managedVersionLine(managed, version, managedOutcome) : null;
  const versionNote = (() => {
    // Orbit rolls the managed runner's image; its Update card (managed.status.update) says when one waits.
    if (isManaged) return managedBuild || isReleaseVersion(version) ? { text: MANAGED_RUNNER_UPDATED_BY_ORBIT, warn: false } : null;
    if (!version || !latestVersion) return null;
    const stuck = attention.find((item) => item.kind === 'cannotSelfUpdate');
    if (stuck) return { text: stuck.short, warn: true };
    if (compareRunnerVersions(version, latestVersion) >= 0) return { text: RUNNER_VERSION_LATEST, warn: false };
    // Draining or restarting for a release: `0.1.253 · updating to 0.1.254`, in the card's amber.
    const target = runner.selfUpdate?.targetVersion;
    const phase = runner.selfUpdate?.phase;
    if (target && (phase === 'draining' || phase === 'restarting')) {
      return { text: runnerVersionUpdatingTo(target), warn: true };
    }
    const state = runner.selfUpdate?.state;
    if (state === 'heldByRollout') return { text: RUNNER_VERSION_NOT_ROLLED_OUT, warn: false };
    if (state === 'enabled' || state === 'waitingForIdle') {
      const quiet = runner.selfUpdate?.quietWindowSeconds;
      return {
        text: quiet ? runnerVersionInstallsWhenQuiet(runnerQuietMinutes(quiet)) : RUNNER_VERSION_INSTALLS_WHEN_IDLE,
        warn: false,
      };
    }
    if (state) return null;
    return runner.runsAsRoot ? { text: RUNNER_VERSION_INSTALLS_WHEN_IDLE, warn: false } : null;
  })();
  // The last update it installed into itself, for a runner that reports it: when, and its versions.
  const lastUpdate = (() => {
    const report = runner.selfUpdate;
    // A managed runner never installs a release into itself: Orbit replaces its image.
    if (!report || isManaged) return null;
    const versions =
      report.lastUpdatedFrom && report.lastUpdatedTo
        ? runnerUpdatedFromTo(report.lastUpdatedFrom, report.lastUpdatedTo)
        : report.lastUpdatedTo;
    const parts = [report.lastUpdatedAt ? fmtTime(report.lastUpdatedAt) : null, versions];
    return parts.filter(Boolean).join(RUNNER_LINE_SEPARATOR) || '—';
  })();
  // The Update card's Update Now… (interrupting the turns in flight) replaces About's Update Runner Now,
  // which only asks for an earlier check, on a runner that takes it.
  const takesUpdateNow = runnerTakesUpdateNow(runner);
  const canUpdateNow = runnerCanUpdateNow(runner, nowMs) && !takesUpdateNow;
  // Where a release it is behind stands, from a runner that says (null for one that doesn't).
  const updateCard = runnerUpdateCard(runner.selfUpdate, nowMs, runner.updateTurns);
  // An engine update shares the runner's one relay slot with an engine's install. Only a run in
  // `update` mode is Engines' news; an install's belongs to the row that started it.
  const relay = runner.install;
  const updating = relay?.mode === 'update';
  const relayInFlight = relay?.status === 'pending' || relay?.status === 'installing';
  // A finished run with a failed line can be handed to an agent; the server reads the same lines.
  const updateFixView = updating && engineUpdateFailedLines(relay?.message).length > 0
    ? agentFixView(runner.agentFix, ENGINE_UPDATE_FIX_TARGET, 'report')
    : null;

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
  const confirmDelete = () =>
    void confirm({
      title: `Delete “${shownName}”?`,
      description: DELETE_MACHINE_NOTE,
      confirmText: 'Delete',
      danger: true,
      cancelText: 'Cancel',
      onConfirm: () => deleteMut.mutateAsync(),
    });

  /** What a card offers, with Fix with an agent where its fix is work on this machine — after the card's own
   *  button, and before Update Engines Now's Dismiss link. */
  const attentionAction = (item: AttentionItem, fixButton: ReactNode): ReactNode => {
    if (item.action?.kind === 'updateEngines') return cardAction(item, fixButton);
    const own = cardAction(item, null);
    return own || fixButton ? <>{own}{fixButton}</> : null;
  };

  /** The one thing a card offers, where it has one. */
  const cardAction = (item: AttentionItem, fixButton: ReactNode): ReactNode => {
    const action = item.action;
    switch (action?.kind) {
      case 'signIn': {
        // Signed in where the engine is listed, below: its row's sign-in opens — under Default, in
        // its group of accounts opened for it — and the row comes into view.
        const engine = action.engine;
        return engine && engine !== 'opencode' && engine !== 'dsh' ? (
          <Button
            size="small"
            onClick={() => {
              setSignIn(ownSignInPanel(runner, engine));
              setSignInEngine(engine);
              foldAccounts(accountsGroup(runner.id, engine), true);
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
            onClick={() => {
              const cleanup = repoCleanupConfirm(root);
              void confirm({
                title: cleanup.title,
                description: cleanup.content,
                confirmText: cleanup.okText,
                onConfirm: () => repairMut.mutateAsync(workspaceId).catch(() => {}),
              });
            }}
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
      case 'updateEngines': {
        const engine = action.engine;
        return (
          <>
            <Button size="small" disabled={engineUpdate.isPending} onClick={() => engineUpdate.mutate()}>
              {RUNNER_UPDATE_ENGINES_NOW}
            </Button>
            {fixButton}
            {/* Until the next release: only a warning against a known latest has one to wait for. */}
            {engine && item.params.latest && (
              <button
                className="re-link"
                type="button"
                disabled={dismissUpdateWarning.isPending}
                onClick={() => dismissUpdateWarning.mutate(engine)}
              >
                {attentionDismissUntilNextRelease(ENGINE_CLI_NAME[engine])}
              </button>
            )}
          </>
        );
      }
      case 'updateRunner':
        return (
          <Button size="small" disabled={runnerUpdate.isPending} onClick={() => runnerUpdate.mutate()}>
            {RUNNER_UPDATE_RUNNER_NOW}
          </Button>
        );
      case 'checkRegion':
        return (
          <Button size="small" disabled={!runner.online} loading={regionCheck.checking} onClick={regionCheck.checkAgain}>
            {CLAUDE_REGION_CHECK_AGAIN}
          </Button>
        );
      default:
        return null;
    }
  };

  // A quota card says when the window resets first, in the reader's own time zone.
  const attentionDetail = (item: AttentionItem): string => {
    const resetsAt = item.params.resetsAt;
    return typeof resetsAt === 'string' ? `${attentionQuotaResets(fmtReset(resetsAt))} ${item.detail}` : item.detail;
  };

  // The old page's Actions, and the escape hatches that sat in Engines' and About's heads (board-3 ①②):
  // Rename, Update runner now (where a check now can change something), Update engines and Refresh
  // models (while it is online, as before), Rotate token, Delete.
  const kebab: MenuItem[] = [
    { key: 'rename', icon: <EditOutlined />, label: 'Rename', onSelect: openRename },
    ...(canUpdateNow
      ? [
          {
            key: 'update-runner',
            icon: <CloudDownloadOutlined />,
            label: RUNNER_UPDATE_RUNNER_NOW,
            disabled: runnerUpdate.isPending,
            onSelect: () => runnerUpdate.mutate(),
          },
        ]
      : []),
    ...(runner.online
      ? [
          {
            key: 'update-engines',
            icon: <SyncOutlined />,
            label: relayInFlight && updating ? 'Updating engines…' : 'Update engines',
            disabled: relayInFlight || engineUpdate.isPending,
            onSelect: () => engineUpdate.mutate(),
          },
          {
            key: 'refresh-models',
            icon: <ReloadOutlined />,
            label: 'Refresh models',
            disabled: refreshModels.isPending,
            onSelect: () => refreshModels.mutate(),
          },
        ]
      : []),
    {
      key: 'rotate',
      icon: <KeyOutlined />,
      label: 'Rotate token',
      onSelect: () => rotation.confirmRotate(runner, actionsButton),
    },
    { type: 'separator', key: 'divider' },
    {
      key: 'delete',
      icon: <DeleteOutlined />,
      label: 'Delete',
      danger: true,
      onSelect: () =>
        void confirm({
          title: `Delete “${shownName}”?`,
          description: DELETE_MACHINE_NOTE,
          confirmText: 'Delete',
          danger: true,
          cancelText: 'Cancel',
          onConfirm: () => deleteMut.mutateAsync(),
          returnFocus: actionsButton,
        }),
    },
  ];

  // The status pill: online and how many of its sessions are running, amber when something needs a
  // person (the nav's dot says the same), grey and when it was last seen while offline.
  // The managed runner's pill is its shared short label instead (asleep is Asleep, never Offline).
  const pillTone = managedRow
    ? MANAGED_PILL[managedRow.tone]
    : !runner.online ? 'offline' : attention.length > 0 ? 'attention' : 'online';
  const pillText = managedRow
    ? managedRow.label
    : runner.online
    ? [RUNNER_ONLINE, typeof runner.maxConcurrent === 'number' ? runnerRunningOf(runner.activeSessions ?? 0, runner.maxConcurrent) : null]
        .filter(Boolean)
        .join(RUNNER_LINE_SEPARATOR)
    : runner.lastHeartbeatAt
      ? runnerOfflineLastSeen(fmtTime(runner.lastHeartbeatAt))
      : RUNNER_OFFLINE;
  const metaline = [
    runner.hostname || null,
    managedBuild ?? runnerVersionLine(version, isManaged),
    runner.online && runner.lastHeartbeatAt ? `${RUNNER_ABOUT_LAST_CHECK_IN} ${ago(runner.lastHeartbeatAt, nowMs)}` : null,
  ].filter(Boolean) as string[];
  // The country its IP is in, ahead of the rest; hovering it says when it was checked.
  const location = runnerLocationLine(runner.region);

  const runsAs =
    runner.runsAsRoot === true ? RUNNER_RUNS_AS_ROOT : runner.runsAsRoot === false ? RUNNER_RUNS_AS_REGULAR_USER : '—';

  // New workspace with this machine already picked.
  const addWorkspace = () => navigate(`/settings/workspaces/new?machine=${runner.id}`);

  return (
    <div className="machine-page">
      <header className="machine-head">
        <div className="machine-title-row">
          <h1 className="machine-title">{shownName}</h1>
          <span className={`machine-pill machine-pill--${pillTone}`} data-testid="machine-status">
            {managedRow?.tone === 'progress' ? (
              <Spinner size="small" aria-hidden />
            ) : (
              <span className={`settings-dot settings-dot--${pillTone}`} aria-hidden />
            )}
            {pillText}
          </span>
          <div style={{ flex: 1 }} />
          <Menu
            align="end"
            items={kebab}
            trigger={
              <Button ref={actionsButton} className="machine-more" icon={<MoreOutlined />} title="Actions" aria-label="Actions" />
            }
          />
        </div>
        {(location || metaline.length > 0) && (
          <div className="machine-metaline">
            {location && runner.region && (
              <span
                data-testid="machine-location"
                title={claudeRegionChecked(ago(runner.region.checkedAt, nowMs), runner.region.name, runner.region.viaProxy)}
              >
                {location}
              </span>
            )}
            {location && metaline.length > 0 && RUNNER_LINE_SEPARATOR}
            {metaline.join(RUNNER_LINE_SEPARATOR)}
          </div>
        )}
      </header>

      {/* Terminals on this machine asking to be approved, under the title (docs/mocks/waiting-on-you-removal/02 ①). */}
      <TerminalRequestsSection runnerId={runner.id} />
      {/* The managed runner's own state, Retry and the way to a model included; none while it is ready. */}
      {managed && managed.display.kind !== 'available' && (
        <ManagedRunnerNotice managed={managed} className="machine-managed-notice" />
      )}

      {/* Orbit Cloud's own Update card (docs/managed-runner-update-now-design.md): its image is behind. */}
      {managed && (
        <ManagedUpdateCard managed={managed} machine={shownName} runnerId={runnerId ?? ""} idle={(runner.activeSessions ?? 0) === 0} onChange={refreshOutcome} />
      )}

      {/* The Update card (board 4): a release this runner is behind, in the phase it reports. */}
      {updateCard && (
        <section className={`rd-update-card ${updateCard.tone}`} aria-label={updateCard.title} data-phase={updateCard.phase}>
          <div className="rd-update-head">
            <div className="rd-update-title">{updateCard.title}</div>
            <div className="rd-update-tag">{updateCard.tag}</div>
          </div>
          <div className="rd-update-body">{updateCard.body}</div>
          {updateCard.progress && (
            <>
              <div className="rd-update-progress-label">{updateCard.progress.label}</div>
              <div
                className="rd-update-progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(updateCard.progress.done * 100)}
              >
                <span style={{ width: `${updateCard.progress.done * 100}%` }} />
              </div>
            </>
          )}
          {updateCard.turns && updateCard.turns.length > 0 && (
            <ul className="rd-update-turns">
              {updateCard.turns.map((turn) => (
                <li key={turn.id}>
                  <Link to={`/sessions/${encodeId(turn.id)}`}>{turn.title}</Link>
                  {turn.running && <span>{turn.running}</span>}
                </li>
              ))}
            </ul>
          )}
          {/* Later ▾ while draining (board 3 ⑦), Change ▾ once postponed; Update Now… (board 3 ⑧) in every
              phase with a release waiting, on a runner that takes it. A runner too old for it keeps the
              postponed card's Update Now…, which asks for an earlier check. */}
          {(updateCard.phase === 'draining' || updateCard.phase === 'postponed' || (updateCard.phase === 'available' && takesUpdateNow)) && (
            <div className="rd-update-actions">
              {updateCard.phase !== 'available' && (
                <RunnerUpdateLaterMenu runnerId={runner.id} change={updateCard.phase === 'postponed'} />
              )}
              {takesUpdateNow && <RunnerUpdateNowButton runner={runner} machine={shownName} />}
              {updateCard.phase === 'postponed' && !takesUpdateNow && (
                <Button
                  loading={runnerUpdate.isPending}
                  onClick={() =>
                    void confirm({
                      title: runnerUpdateNowConfirmTitle(runner.selfUpdate?.targetVersion ?? ''),
                      description: RUNNER_UPDATE_NOW_CONFIRM_BODY,
                      confirmText: RUNNER_UPDATE_NOW_CONFIRM,
                      onConfirm: () => runnerUpdate.mutateAsync(),
                    })
                  }
                >
                  {RUNNER_UPDATE_NOW}
                </Button>
              )}
            </div>
          )}
        </section>
      )}

      {/* Only when something needs a person: each card says what happened, why it matters, and offers
          the one thing that fixes it. */}
      {attention.length > 0 && (
        <section className="rd-attention machine-attention" aria-label={RUNNER_NEEDS_ATTENTION}>
          {attention.map((item, index) => {
            // Fix with an agent, on the cards whose fix is work on this machine (lib/agentFix.ts).
            const fixTarget = attentionFixTarget(item);
            const fixView = fixTarget ? agentFixView(runner.agentFix, fixTarget, 'card') : null;
            const fixButton = fixTarget && fixView
              ? <AgentFixButton view={fixView} target={fixTarget} runnerId={runner.id} />
              : null;
            const action = attentionAction(item, fixButton);
            // The offline card names its error, so the help drawer puts the article about it first, and opens it.
            const offline = item.kind === 'offline';
            return (
              <div
                key={`${item.kind}:${index}`}
                className={`rd-attention-card ${item.tone}`}
                {...(offline ? { [HELP_ERROR_ATTR]: 'runner.offline' } : {})}
              >
                <span className="rd-attention-icon">{ATTENTION_ICON[item.kind]}</span>
                <div className="rd-attention-main">
                  <div className="rd-attention-title">{item.title}</div>
                  <div className="rd-attention-detail">{attentionDetail(item)}</div>
                  {action && <div className="rd-attention-action">{action}</div>}
                  {offline && (
                    <div className="rd-attention-learn">
                      <HelpLearnMore slug="machine-offline" />
                    </div>
                  )}
                  <AgentFixLine view={fixView} />
                </div>
              </div>
            );
          })}
        </section>
      )}

      {/* A managed runner that has not reported yet has no readings and no engines to show: one quiet
          line each, not "Update runner" badges and Install rows for a machine still being started. */}
      {managedWaiting ? (
        <>
          <SettingsSection title={RUNNER_RESOURCES} className="machine-section-resources">
            <p className="machine-managed-waiting" data-testid="managed-waiting-resources">{MANAGED_RUNNER_NOT_REPORTED}</p>
          </SettingsSection>
          <SettingsSection title={RUNNER_ENGINES} className="machine-section-engines">
            <p className="machine-managed-waiting" data-testid="managed-waiting-engines">{MANAGED_RUNNER_NOT_REPORTED}</p>
          </SettingsSection>
        </>
      ) : (
      <>
      {/* The machine's CPU, memory and disk, and their last hour (MachineResources.tsx). */}
      <MachineResources
        runnerId={runner.id}
        online={!!runner.online}
        offlineLabel={managedRow?.label}
        capabilities={runner.capabilities}
        workspaceDisk={disk}
        reserveMb={reserveMb}
        nowMs={nowMs}
      />

      {/* A row per engine, each with what can be done there now — Sign in, Sign out, Install, Update —
          and its accounts under it: the rows of this machine's card in Infrastructure. */}
      <SettingsSection
        title={RUNNER_ENGINES}
        className="machine-section-engines"
        action={<span className="machine-section-note">{MACHINES_ENGINES_NOTE}</span>}
      >
        {/* The run's report. Unlike an install it is not retired by the next probe: the summary —
            what moved, what was skipped and why — exists nowhere else once it's gone. */}
        {updating && relay?.status && (
          <div className="rd-engine-relay">
            {relay.status === 'pending' || relay.status === 'installing' ? (
              <div className="rd-engine-relay-row">
                {relay.status === 'pending'
                  ? 'Queued — the runner picks this up on its next check-in.'
                  : 'Updating this machine’s engine CLIs…'}
              </div>
            ) : (
              // Only the engines that need someone, and the failed ones in red: a whole red card
              // made six engines that were fine read as broken beside the one that wasn't.
              engineUpdateReportLines(relay.message).map((line, index) => (
                <div key={index} className={`rd-engine-relay-row${engineUpdateLineFailed(line) ? ' bad' : ''}`}>
                  {line}
                </div>
              ))
            )}
            {relay.status !== 'pending' && relay.command && (
              <div className="rd-engine-relay-hint">
                Orbit ran <code className="re-cmd">{relay.command}</code>
              </div>
            )}
            {(relay.status === 'done' || relay.status === 'failed') && (
              <div className="rd-engine-relay-hint agent-fix-row">
                {/* Fix with an agent, before Dismiss, while the report has a failed line (lib/agentFix.ts). */}
                {updateFixView && updateFixView.state !== 'fixing' && (
                  <AgentFixButton view={updateFixView} target={ENGINE_UPDATE_FIX_TARGET} runnerId={runner.id} />
                )}
                {updateFixView?.state === 'fixing' && <AgentFixLine view={updateFixView} />}
                <button className="re-link" type="button" onClick={() => dismissEngineUpdate.mutate()}>
                  Dismiss
                </button>
              </div>
            )}
            {(relay.status === 'done' || relay.status === 'failed') && updateFixView?.state !== 'fixing' && (
              <AgentFixLine view={updateFixView} />
            )}
          </div>
        )}
        <div className={`re-card re-runner-card machine-engines${runner.online ? '' : ' offline'}`}>
          <MachineEngines
            runner={runner}
            signIn={signIn}
            onSignIn={setSignIn}
            focusEngine={signInEngine}
            openAccounts={openAccounts}
            onFoldAccounts={(engine, open) => foldAccounts(accountsGroup(runner.id, engine), open)}
            machinePage
            fleet={runners.data}
          />
        </div>
        {runner.engines && (
          <div className="rd-hint">{!runner.online ? RUNNER_ENGINES_OFFLINE_FOOTER : managed ? RUNNER_ENGINES_MANAGED_FOOTER : RUNNER_ENGINES_FOOTER}</div>
        )}
      </SettingsSection>
      </>
      )}

      {/* Orbit Cloud's browser: Open browser, saved logins, Clear saved logins. Nothing while the server has it off. */}
      {isManaged && <RunnerBrowserSection runnerId={runner.id} />}

      <div ref={capacityRef} className="machine-capacity">
        <SettingsSection title={RUNNER_CAPACITY} className="machine-section-capacity">
          <SettingsCard>
            {/* A meter — the name and `3 of 16 running` on a line, a bar across the row under them. The
                limit is changed from Edit, in a dialog. */}
            <CapacityMeter
              title={RUNNER_MAX_CONCURRENT}
              value={running ? runnerRunningOf(running.active, running.max) : String(runner.maxConcurrent ?? '—')}
              percent={running?.percent}
              warn={running?.full}
              action={
                <Button
                  ref={maxButton}
                  variant="link"
                  size="small"
                  className="machine-max-edit"
                  aria-label={`${RUNNER_EDIT} ${RUNNER_MAX_CONCURRENT}`}
                  onClick={openMaxConcurrent}
                >
                  {RUNNER_EDIT}
                </Button>
              }
            />
            {typeof runner.burstConcurrent === 'number' && (
              <SettingsRow
                title={EXTRA_SESSIONS_ON_DEMAND}
                control={
                  <Select
                    aria-label={EXTRA_SESSIONS_ON_DEMAND}
                    size="small"
                    value={String(runner.burstConcurrent)}
                    options={Array.from({ length: MAX_EXTRA_SESSIONS + 1 }, (_, slots) => ({
                      value: String(slots),
                      label: String(slots),
                    }))}
                    onValueChange={(value) => {
                      if (value !== null) capacityMut.mutate({ burstConcurrent: Number(value) });
                    }}
                    disabled={capacityMut.isPending}
                  />
                }
              />
            )}
            <SettingsRow
              title={RUNNER_KEEP_FREE}
              control={
                <Select
                  ref={keepFreeRef}
                  className="rd-keep-free"
                  aria-label={RUNNER_KEEP_FREE}
                  size="small"
                  value={String(reserveMb ?? 0)}
                  options={keepFreeOptions.map((option) => ({ value: String(option.value), label: option.label }))}
                  onValueChange={(value) => {
                    if (value === null) return;
                    const mb = Number(value);
                    capacityMut.mutate({ minFreeDiskMb: mb === 0 ? null : mb });
                  }}
                  matchTriggerWidth={false}
                />
              }
            />
          </SettingsCard>
          <div className="rd-hint">{RUNNER_CAPACITY_FOOTER}</div>
        </SettingsSection>
      </div>

      {/* Listed and linked only (board-3 ③): a workspace's settings have one home, its own page. */}
      <SettingsSection
        title={WORKSPACES_ON_MACHINE}
        className="machine-section-workspaces"
        action={
          <Button size="small" icon={<PlusOutlined />} onClick={addWorkspace}>
            Add workspace
          </Button>
        }
      >
        {workspacesQ.isLoading ? (
          <div style={{ padding: 24, textAlign: 'center' }}>
            <Spinner />
          </div>
        ) : workspaces.length === 0 ? (
          <SettingsCard>
            <div className="rd-empty machine-empty">
              {machineEmpty(shownName)}
              <div className="rd-empty-action">
                <Button variant="primary" onClick={() => navigate(machineDraftPath(runner.id))}>
                  {START_A_SESSION}
                </Button>
              </div>
            </div>
          </SettingsCard>
        ) : (
          <SettingsCard>
            {workspaces.map((workspace) => {
              const running = sessionCounts.find((count) => count.workspaceId === workspace.id)?.running ?? 0;
              return (
                <Link
                  key={workspace.id}
                  to={`/settings/workspaces/${workspace.id}`}
                  className="machine-workspace-row"
                  data-row-focus=""
                  data-workspace-id={workspace.id}
                >
                  <SettingsRow
                    title={
                      <>
                        {workspace.name}
                        {workspace.enabled === false && <Badge style={{ marginLeft: 8 }}>disabled</Badge>}
                      </>
                    }
                    description={
                      workspace.workDir ? <code className="machine-workdir">{tildePath(workspace.workDir)}</code> : undefined
                    }
                    control={
                      <span className="machine-workspace-end">
                        {running > 0 && <span className="rd-workspace-running">{runnerWorkspaceRunning(running)}</span>}
                        <RightOutlined />
                      </span>
                    }
                  />
                </Link>
              );
            })}
          </SettingsCard>
        )}
      </SettingsSection>

      {/* Copies of the owner's secrets on this machine (Settings → Secrets, filtered). Renders nothing while there are none. */}
      <MachineSecrets runnerId={runner.id} />

      {/* What worktree GC may never remove: finished sessions' checkouts that still hold uncommitted
          work. Renders nothing while there are none. */}
      <AbandonedCheckouts runnerId={runner.id} canDiscard={runner.capabilities?.includes('abandoned-checkout-v1') === true} />

      {/* The terminals approved on this machine, with Revoke (docs/mocks/terminals-on-machine-page). Renders nothing
          while there are none. */}
      <MachineTerminalsSection runnerId={runner.id} />

      <SettingsSection title={RUNNER_ABOUT} className="machine-section-about">
        <SettingsCard>
          <SettingsRow
            anchor="name"
            title={RUNNER_ABOUT_NAME}
            control={
              <span className="machine-about-value">
                {shownName}
                <button type="button" className="rd-inline-link" onClick={openRename}>
                  Rename
                </button>
              </span>
            }
          />
          <SettingsRow anchor="hostname" title={RUNNER_ABOUT_HOSTNAME} control={<span className="machine-about-value">{runner.hostname || '—'}</span>} />
          <SettingsRow
            title={RUNNER_ABOUT_VERSION}
            control={
              <span className="machine-about-value">
                {managedBuild ?? (isManaged && !isReleaseVersion(version) ? '—' : (version ?? '—'))}
                {versionNote && <small className={versionNote.warn ? 'warn' : undefined}>{versionNote.text}</small>}
              </span>
            }
          />
          {lastUpdate && (
            <SettingsRow title={RUNNER_ABOUT_LAST_UPDATE} control={<span className="machine-about-value">{lastUpdate}</span>} />
          )}
          <SettingsRow title={RUNNER_ABOUT_RUNS_AS} control={<span className="machine-about-value">{runsAs}</span>} />
          <SettingsRow
            title={RUNNER_ABOUT_REPOS_FOLDER}
            control={<span className="machine-about-value">{runner.reposRoot || '—'}</span>}
          />
          <SettingsRow
            title={RUNNER_ABOUT_LAST_CHECK_IN}
            control={
              <span className="machine-about-value">{runner.lastHeartbeatAt ? ago(runner.lastHeartbeatAt, nowMs) : '—'}</span>
            }
          />
          <SettingsRow
            title={RUNNER_ABOUT_REGISTERED}
            control={<span className="machine-about-value">{fmtDate(runner.enrolledAt)}</span>}
          />
        </SettingsCard>
        {/* Root costs one permission mode: claude refuses Bypass under root. Said here because the
            picker only ever drops it without a word. */}
        {runner.runsAsRoot && <div className="rd-hint">{RUNNER_ROOT_NO_BYPASS}</div>}
      </SettingsSection>

      <SettingsSection title={DELETE_MACHINE} className="machine-section-delete">
        <SettingsCard>
          <SettingsRow
            title={DELETE_MACHINE}
            description={DELETE_MACHINE_NOTE}
            control={
              <Button danger loading={deleteMut.isPending} onClick={confirmDelete}>
                Delete
              </Button>
            }
          />
        </SettingsCard>
      </SettingsSection>

      <Dialog
        className="runner-dialog"
        title={RUNNER_MAX_CONCURRENT}
        width={400}
        open={maxOpen}
        onClose={() => setMaxOpen(false)}
        returnFocus={maxButton}
        footer={
          <>
            <Button onClick={() => setMaxOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={maxUnchanged} onClick={saveMaxConcurrent}>
              Save
            </Button>
          </>
        }
      >
        {/* − 8 + sessions at once ········ 3 running */}
        <div className="machine-max-concurrent-line">
          <div className="machine-max-stepper">
            <Button
              aria-label={RUNNER_MAX_CONCURRENT_DECREASE}
              disabled={(maxDraft ?? 1) <= 1}
              onClick={() => stepMaxConcurrent(-1)}
            >
              −
            </Button>
            <NumberInput
              className="rd-max-concurrent"
              aria-label={RUNNER_MAX_CONCURRENT}
              min={1}
              precision={0}
              value={maxDraft}
              onValueChange={(v) => {
                maxTyped.current = v;
                setMaxDraft(v);
              }}
              onPressEnter={saveMaxConcurrent}
            />
            <Button aria-label={RUNNER_MAX_CONCURRENT_INCREASE} onClick={() => stepMaxConcurrent(1)}>
              +
            </Button>
          </div>
          <span className="machine-max-concurrent-unit">{RUNNER_MAX_CONCURRENT_UNIT}</span>
          {running && <span className="machine-max-concurrent-now">{runnerRunningNow(running.active)}</span>}
        </div>
        {running && maxDraft !== null && maxDraft < running.active ? (
          <div className="rd-hint machine-max-concurrent-hint warn">{runnerMaxBelowRunning(running.active, maxDraft)}</div>
        ) : (
          <div className="rd-hint machine-max-concurrent-hint">{RUNNER_MAX_CONCURRENT_HINT}</div>
        )}
      </Dialog>
      <Dialog
        className="runner-dialog"
        title="Rename runner"
        open={renaming}
        onClose={() => setRenaming(false)}
        initialFocus={renameInput}
        returnFocus={actionsButton}
        footer={
          <>
            <Button onClick={() => setRenaming(false)}>Cancel</Button>
            <Button variant="primary" loading={renameMut.isPending} onClick={() => renameMut.mutate(renameVal.trim())}>
              Save
            </Button>
          </>
        }
      >
        <Input
          ref={renameInput}
          value={renameVal}
          onChange={(e) => setRenameVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) renameMut.mutate(renameVal.trim());
          }}
          placeholder={machineName({ ...runner, displayName: null }, managed ? runnerId : null)}
          maxLength={60}
        />
        <div style={{ marginTop: 8, color: 'var(--text-3)', fontSize: 12 }}>
          Leave empty to use the machine name ({machineName({ ...runner, displayName: null }, managed ? runnerId : null)}).
        </div>
      </Dialog>

      {confirmation}
      {rotation.dialogs}
    </div>
  );
}

/** A Capacity reading: its name, how much is used of how much (`3 of 16 running`) and an action on one
 *  line, and a bar of the share across the row under them — amber when warn. No bar without a share. */
function CapacityMeter({
  title,
  value,
  percent,
  warn,
  action,
}: {
  title: string;
  value: string;
  percent?: number;
  warn?: boolean;
  action?: ReactNode;
}) {
  return (
    <div className="settings-row machine-meter">
      <div className="machine-meter-line">
        <div className="settings-row-title">{title}</div>
        <div className="machine-meter-value">{value}</div>
        {action}
      </div>
      {percent != null && (
        <div className={`rd-disk-bar machine-meter-bar${warn ? ' warn' : ''}`}>
          <span style={{ width: `${percent}%` }} />
        </div>
      )}
    </div>
  );
}
