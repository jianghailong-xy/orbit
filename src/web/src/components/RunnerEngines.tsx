import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DeleteOutlined, DownloadOutlined, EditOutlined, EllipsisOutlined, LoadingOutlined, LoginOutlined, PauseOutlined, PlayCircleOutlined, PlusOutlined } from '@ant-design/icons';
import {
  accountToStartOn,
  AgentProvider,
  ENGINE_CLI_NAMES,
  withEnginePlanUsage,
  type AccountEngine,
  type InstallEngine,
  type LoginEngine,
  type PlanUsage,
  type PlanUsageSnapshot,
  type RunnerAccountRemoveState,
  type RunnerEngineAccount,
  type ReportedEngine,
  type RunnerEngineHealth,
  type RunnerInstallState,
  type RunnerRemovedDefault,
} from '@orbit/shared';
import { api } from '../api';
import { accountIsPaused, usePauseClock } from '../lib/accountPause';
import { AccountPauseActions, AccountPauseStatus, type AccountPauseControls } from './AccountPause';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Menu, type MenuItem } from './ui/Menu';
import { Popconfirm } from './ui/Popconfirm';
import { encodeId } from '../lib/idCodec';
import {
  accountDir,
  accountNameOf,
  accountPlanUsage,
  addsAntigravityAccounts,
  addsCursorAccounts,
  addsKimiAccounts,
  defaultAccountName,
  engineKeepsAccounts,
  runsOnEnvKey,
} from '../lib/engineAccounts';
import {
  CURSOR_STATE_LABEL,
  cursorRunnerState,
  cursorStateHint,
  type CursorRunnerFacts,
} from '../lib/cursorRuntime';
import {
  bindingPlanUsageRow,
  currentPlanUsageRows,
  cursorUsageLimit,
  kimiNoQuotaLimit,
  planUsageRowSpent,
  planUsageSnapshotForProvider,
  type PlanUsageDisplayRow,
} from '../lib/planUsage';
import { formatResetTime } from '../lib/providerPools';
import { runnersQuery } from '../lib/queries';
import { claudeRegionBlocked, useClaudeRegionCheckAgain } from '../lib/claudeRegion';
import {
  CLAUDE_REGION_CHECK_AGAIN,
  CLAUDE_REGION_NOT_SUPPORTED,
  CLAUDE_REGION_SUPPORTED_REGIONS,
  CLAUDE_REGION_SUPPORTED_REGIONS_URL,
  claudeRegionAccounts,
  claudeRegionChecked,
  claudeRegionMachineNote,
} from '../lib/claudeRegionCopy';
import {
  RUNNER_ENGINE_COULDNT_CHECK,
  RUNNER_ENGINE_NO_QUOTA_LIMIT,
  RUNNER_ENGINE_NO_READING,
  RUNNER_ENGINE_RENEW,
  RUNNER_ENGINE_UPDATE_DISMISS,
  runnerEngineAccountsUnchecked,
  runnerEngineCouldntCheckAccounts,
  runnerEngineCouldntCheckNote,
  runnerEngineNext,
} from '../lib/runnerCopy';
import {
  RUNNER_DEFAULT_USE_AGAIN,
  runnerAccountRemoveDetailAutomatic,
  runnerAccountRemoveDetailLast,
  runnerAccountRemoveTitle,
  runnerDefaultRemoveDetail,
  runnerDefaultRemovedLine,
  runnerDefaultUseAgainFailed,
} from '../lib/runnerAccountCopy';
import { loginExpiresLine, signedOutNote } from '../lib/accountLogin';
import { foldFromAnywhere } from '../lib/foldHead';
import { ago, engineUpdateDismissedFor, engineVersionNumber, updateNoteOf, webShowsEngine } from '../lib/runnerEngines';
import { ENGINE_PRESET, ENGINE_SLUGS } from '../lib/sessionProviderChoices';
import { useToast } from '../lib/toast';
import { DshRunnerStatus } from './DshRunnerStatus';
import { ProviderTile } from './ProviderGallery';
import { GoogleSignInTerms, KIMI_SITE, RunnerSignIn } from './RunnerSignIn';
import type { Runner } from './TasksSidePanel';

/** An engine this page has a row for: one a runner signs in with, or OpenCode — which it does not. */
type RowEngine = LoginEngine | 'opencode';

/** Every engine a card can draw a row for in the order it draws them: the CLIs a runner signs in with,
 *  and OpenCode — the one engine here with no sign-in to relay, whose row exists to be installed and
 *  kept current. DeepSeek Harness's line follows them, and Cursor CLI's row comes last
 *  (MachineEngines), where a machine draws it at all. */
const ROW_ENGINES: RowEngine[] = [...ENGINE_SLUGS, 'opencode'];

/** The rows one card draws: those, minus OpenCode on a machine that never reports it. A runner
 *  reports every CLI on the machine, so the row appearing is that report's doing — and one that has
 *  never mentioned OpenCode has nothing for the row to say. */
function rowEnginesOf(engines: RunnerEngineHealth[]): RowEngine[] {
  const reported = new Set(engines.map((health) => health.engine));
  return ROW_ENGINES.filter((engine) => engine !== 'opencode' || reported.has('opencode'));
}

/** What a row calls its engine: the CLI's own name (ENGINE_CLI_NAMES), the one every list of
 *  engines uses, so one binary never gets two names. */
function engineNameOf(engine: RowEngine): string {
  return ENGINE_CLI_NAMES[engine as AgentProvider];
}

// Which engines' accounts the user opened on which runner (accountsGroup). An engine with several
// accounts lists each with every window of its quota, which runs long, and folded its row still says
// what they come to — how many can run, the one a new session starts on and that one's tightest
// window — so a group starts folded too, and this remembers the ones opened.
const OPEN_ACCOUNTS_KEY = 'orbit:providers-open-accounts';

/** One engine's accounts on one runner, as OPEN_ACCOUNTS_KEY remembers them. */
export const accountsGroup = (runnerId: string, engine: string) => `${runnerId}/${engine}`;

function readExpanded(key: string): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writeExpanded(next: string[], key: string): string[] {
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // Private mode / full quota: the fold still works, it just won't outlive the page.
  }
  return next;
}

/** The groups of accounts open under their rows, on every runner (accountsGroup), as the user left
 *  them: Infrastructure's machine cards and a machine's own page fold the same groups. */
export function useOpenAccounts() {
  const [openAccounts, setOpenAccounts] = useState<string[]>(() => readExpanded(OPEN_ACCOUNTS_KEY));
  const foldAccounts = (group: string, open: boolean) =>
    setOpenAccounts((prev) =>
      prev.includes(group) === open
        ? prev
        : writeExpanded(open ? [...prev, group] : prev.filter((x) => x !== group), OPEN_ACCOUNTS_KEY),
    );
  return [openAccounts, foldAccounts] as const;
}

/**
 * Dismiss this runner's update warning for `engine` until its next release: the server records the
 * engine's current update.latest (runner.engineUpdateDismissals), and every client hides both the
 * Needs Attention card and the row's panel while that is still the latest. Shared by the card and the
 * row, so either one hides both.
 */
export function useDismissEngineUpdateWarning(runnerId: string) {
  const qc = useQueryClient();
  const message = useToast();
  return useMutation({
    mutationFn: (engine: ReportedEngine) =>
      api(`/runners/${runnerId}/engines/${engine}/update-warning/dismiss`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: runnersQuery().queryKey }),
    onError: (e: Error) => message.error("Couldn't dismiss the warning", e.message),
  });
}

/** What one row is saying. The install relay outranks the probe: it is newer than the last
 *  heartbeat, and it is the thing the user is currently watching. */
type RowKind =
  | 'in'
  | 'out'
  | 'unknown'
  | 'missing'
  | 'installing'
  | 'installed'
  | 'install-failed';

export function rowKindOf(
  health: RunnerEngineHealth | undefined,
  install: RunnerInstallState | null | undefined,
  engine: InstallEngine,
): RowKind {
  if (install?.engine === engine) {
    if (install.status === 'pending' || install.status === 'installing') return 'installing';
    // Both terminal outcomes only speak while the probe hasn't answered for itself: an install
    // slot records what one attempt reported, and the machine's actual state outranks it. A
    // failure the probe contradicts is a failure that stopped being true — the installer can
    // land a binary and still be judged failed (an install dir missing from the service PATH
    // does exactly that), and once a later probe finds it, insisting on the red panel leaves a
    // working engine looking broken until someone presses Dismiss.
    if (install.status === 'failed' && !health?.installed) return 'install-failed';
    // Finished, but the last heartbeat's probe still predates it. Saying "not installed" here
    // would offer to install what was just installed; the server clears this slot as soon as the
    // probe catches up, and the row then speaks from engine health again.
    if (install.status === 'done' && !health?.installed) return 'installed';
  }
  if (!health?.installed) return 'missing';
  if (health.auth === 'yes') return 'in';
  if (health.auth === 'no') return 'out';
  // The CLI wouldn't say. Never render this as signed in — that is the whole reason the probe
  // has three states instead of a boolean.
  return 'unknown';
}

/** One engine on one machine as its row reads it: the runner's own report — for Antigravity with its
 *  install and credential taken from the server's answer (`runner.antigravity`) once it has one. */
export function engineHealthOf(runner: Runner, engine: RowEngine): RunnerEngineHealth | undefined {
  const reported = runner.engines?.find((e) => e.engine === engine);
  const state = engine === 'antigravity' ? runner.antigravity : undefined;
  return state && state.installed != null
    ? { ...reported, engine, installed: state.installed, version: state.version ?? reported?.version, auth: reported?.auth ?? (state.envKeyAvailable ? 'yes' : 'unknown'), authSource: state.authSource ?? reported?.authSource } as RunnerEngineHealth
    : reported;
}


const STATUS_TAG: Record<RowKind, { color: string; label: string }> = {
  in: { color: 'green', label: 'Signed in' },
  out: { color: 'orange', label: 'Signed out' },
  unknown: { color: 'default', label: 'Unknown' },
  missing: { color: 'default', label: 'Not installed' },
  installing: { color: 'blue', label: 'Installing…' },
  installed: { color: 'green', label: 'Installed' },
  'install-failed': { color: 'red', label: 'Install failed' },
};

/** An engine's version as a number — the name beside it already says which CLI it is, so
 *  `2.1.287 (Claude Code)` would say it twice — or the CLI's own name when it reported none. */
function versionOf(engine: RowEngine, health?: RunnerEngineHealth): string {
  return health?.version ? engineVersionNumber(health.version) : engineNameOf(engine);
}

/** The sub-line under an engine's name: what is on this machine, or what would be. */
function metaFor(kind: RowKind, engine: RowEngine, health?: RunnerEngineHealth, signIn = true): string {
  if (kind === 'installing') return health?.installed ? 'Reinstalling' : 'Not installed yet';
  if (kind === 'installed') return 'Waiting for this runner to check in';
  if (!health?.installed) {
    // After a failed attempt the offer has already been made (and the panel below says how it
    // went), so this just states the fact.
    return kind === 'missing' ? 'Not installed — Orbit can install it here' : 'Not installed';
  }
  // With a sign-in, the badge says the check failed and the line keeps the version alone rather
  // than saying it twice. Without one (OpenCode), the CLI's own answer is the whole story.
  if (kind === 'unknown') {
    return signIn ? versionOf(engine, health) : `${versionOf(engine, health)} · the CLI wouldn't say`;
  }
  // Which of Kimi's two sites the login is on: the same CLI signs in to either, and a session spends
  // that site's subscription.
  if (engine === 'kimi' && health.kimiRegion) return `${versionOf(engine, health)} · ${KIMI_SITE[health.kimiRegion].domain}`;
  return versionOf(engine, health);
}

/** The sign-in panel a card holds open: an engine's own (keyed by the engine), one of its
 *  accounts', or the account being added — each engine's under its own prefix, so opening one
 *  account's panel never opens another engine's. */
const accountPanel = (engine: LoginEngine, id: string) => `${engine}/${id}`;
const addAccountPanel = (engine: LoginEngine) => `${engine}/+`;

/** An account's own answer, in the words a row speaks. */
function accountKindOf(account: RunnerEngineAccount): RowKind {
  if (account.auth === 'yes') return 'in';
  if (account.auth === 'no') return 'out';
  return 'unknown';
}

/**
 * The slots that turned out to hold an account already signed in above them: each such slot's id,
 * against the account it repeats.
 *
 * One account signed into two slots is two sign-ins of one quota, and the page would otherwise show
 * it as two rows of quota that have nothing to do with each other — so the repeat is worth saying,
 * and it is said on the later row: the list is in the order the sign-ins were made (Default first,
 * then each slot the runner added), so an account already seen above is the one this row repeats.
 *
 * A slot with no fingerprint is never a repeat. The runner reads fingerprints as it goes, an older
 * runner reports none at all, and an unread account is not evidence of a second copy of a read one.
 */
function duplicateAccounts(
  accounts: RunnerEngineAccount[],
): Map<string, RunnerEngineAccount> {
  const firstSeen = new Map<string, RunnerEngineAccount>();
  const repeats = new Map<string, RunnerEngineAccount>();
  for (const account of accounts) {
    const fingerprint = account.fingerprintPrefix;
    if (!fingerprint) continue;
    const first = firstSeen.get(fingerprint);
    if (first) repeats.set(account.id, first);
    else firstSeen.set(fingerprint, account);
  }
  return repeats;
}

/**
 * A CODEX_HOME the way a terminal spells it, with the machine's home directory as `~`. The page
 * can't ask that machine where its home is, so this reads the places a home directory lives; any
 * other path is shown whole, and the row always carries the full one on hover.
 */
export function tildePath(path: string): string {
  return path.replace(/^(?:\/root|\/home\/[^/]+|\/Users\/[^/]+)(?=\/|$)/, '~');
}

/** Whether this account is on its way out: asked to be removed, and still listed until the re-probe
 *  that follows the machine's "done" drops it, a beat later. */
function beingRemoved(runner: Runner, engine: RowEngine, account: string): boolean {
  const removal = runner.accountRemove;
  return removal?.engine === engine && removal.account === account &&
    (removal.status === 'pending' || removal.status === 'done');
}

/** The accounts a Codex row lists under itself: every one, once there is more than one — and only
 *  while the probe speaks for the engine, since an install under way is about the binary all of
 *  them share. None otherwise, which leaves the row exactly what it was before accounts.
 *
 *  While Default is removed from Orbit (`removedDefault`) the accounts that remain are a group even
 *  when one is left: the row on its own reads the engine's own sign-in, which on the machine is
 *  Default's, and the group is where the removed Default's line and its way back go. */
function accountRowsOf(
  engine: RowEngine,
  health: RunnerEngineHealth | undefined,
  install: RunnerInstallState | null | undefined,
): RunnerEngineAccount[] {
  const accounts = engineKeepsAccounts(engine) ? (health?.accounts ?? []) : [];
  const kind = rowKindOf(health, install, engine);
  return accounts.length >= (health?.removedDefault ? 1 : 2) && (kind === 'in' || kind === 'out' || kind === 'unknown')
    ? accounts
    : [];
}

/** A login's quota as a row draws it: every window it reported, as it stands now — or none, for a
 *  login that is not signed in, whose last reading is about sessions that can no longer start. */
interface Quota {
  windows: PlanUsageDisplayRow[];
  /** "Usage as of 17:44 · 7h ago", once the reading is older than the runner's reads. */
  stale: string | null;
  /** Kimi only: the login's quota was read and its plan carries no limit — no window to gauge
   *  (kimiNoQuotaLimit), said as "No quota limit" rather than "No quota reported". */
  noLimit: boolean;
  /** Cursor CLI only: its account's plan, as Cursor names it, and whether a turn on it met Cursor's
   *  usage limit this period (cursorUsageLimit). An account Cursor reports no usage for has no window
   *  above, and says "Usage unavailable" rather than "No quota reported" or 0%. */
  cursor?: { plan: string | null; spent: { resetsAt?: string } | null };
}

/** Older than this, a reading has missed three of the runner's reads (every 5 min with a session
 *  running, every 10 without, while the engine is signed in there) and is said to be as of then. */
const STALE_QUOTA_MS = 30 * 60_000;

/** A login with no reading: what an account on a machine blocked for its Claude region is judged on. */
const NO_QUOTA: Quota = { windows: [], stale: null, noLimit: false };

function quotaOf(kind: RowKind, snapshot: PlanUsageSnapshot | null, online: boolean, now: number, engine?: RowEngine): Quota {
  const cursor =
    engine === 'cursor'
      ? { plan: snapshot?.planName ?? null, spent: kind === 'in' ? cursorUsageLimit(snapshot, now) : null }
      : undefined;
  if (kind !== 'in' || !snapshot) return { windows: [], stale: null, noLimit: false, ...(cursor ? { cursor } : {}) };
  const windows = currentPlanUsageRows(snapshot, now);
  const read = snapshot.fetchedAt;
  // An offline machine reads nothing, and the card already says it is offline: one note per row
  // would only repeat that.
  const stale =
    windows.length > 0 && online && read && now - Date.parse(read) > STALE_QUOTA_MS
      ? `Usage as of ${formatResetTime(read, now)} · ${ago(read, now)}`
      : null;
  return { windows, stale, noLimit: kimiNoQuotaLimit(snapshot), ...(cursor ? { cursor } : {}) };
}

/** What a row's tag says: whether that login can run a session now — and if its quota is spent, when
 *  it can — in the words the account pools use for theirs. */
function statusOf(kind: RowKind, quota: Quota, now: number, signIn = true): { color: string; label: string } {
  // A Cursor CLI account is spent when a turn on it met Cursor's limit, which no reading says.
  const spent = kind === 'in' ? quota.cursor?.spent : null;
  if (spent) return { color: 'orange', label: spent.resetsAt ? `Spent · resets ${formatResetTime(spent.resetsAt, now)}` : 'Spent' };
  const binding = bindingPlanUsageRow(quota.windows);
  // Signed in with nothing read: the sign-in is all there is to say. An engine Orbit signs no one
  // in (OpenCode) has no sign-in check to have failed, so its unknown keeps the neutral word.
  if (kind !== 'in' || !binding) {
    return kind === 'unknown' && signIn
      ? { color: 'default', label: RUNNER_ENGINE_COULDNT_CHECK }
      : STATUS_TAG[kind];
  }
  if (binding.window.utilization < 100) return { color: 'green', label: 'Available' };
  const resetsAt = binding.window.resetsAt;
  return { color: 'orange', label: resetsAt ? `Spent · resets ${formatResetTime(resetsAt, now)}` : 'Spent' };
}

/** Whether a login can take a session now: signed in, and no window of its spent. */
function available(kind: RowKind, quota: Quota): boolean {
  return kind === 'in' && !quota.cursor?.spent && (bindingPlanUsageRow(quota.windows)?.window.utilization ?? 0) < 100;
}

/** The quota column: each window with how much of it is used and when it resets, or why there is
 *  nothing to show — under the name of the account it is, when the row speaks for several (`next`). */
function QuotaCell({ kind, quota, next, signIn = true }: { kind: RowKind; quota: Quota; next?: string; signIn?: boolean }) {
  return (
    <div className="re-quota">
      {next && <div className="re-quota-head re-quota-next">{runnerEngineNext(next)}</div>}
      {quota.windows.length > 0 ? (
        <>
          {quota.windows.map((row) => (
            <div key={row.key} className="re-window">
              {row.groupLabel && <div className="re-quota-head">{row.groupLabel}</div>}
              <div className="re-quota-head">
                <b>{row.label}</b>
                <span>{row.headline ?? `${row.percent}%${row.remaining ? ' remaining' : ''}`}</span>
              </div>
              <div className={`runner-util ${planUsageRowSpent(row) ? 'spent' : row.nearLimit ? 'full' : ''}`}>
                <span className="runner-util-fill" style={{ width: `${planUsageRowSpent(row) ? 100 : row.percent}%` }} />
              </div>
              {row.window.resetsAt && (
                <div className="re-reset">resets {formatResetTime(row.window.resetsAt)}</div>
              )}
            </div>
          ))}
          {quota.stale && <div className="re-stale">{quota.stale}</div>}
        </>
      ) : kind === 'in' && quota.cursor ? (
        // Cursor reports no usage for this account, or only 0%, which is no reading (contract §11):
        // under the plan's name, no number at all rather than one Orbit made up.
        <>
          {quota.cursor.plan && (
            <div className="re-quota-head">
              <b>{quota.cursor.plan} plan</b>
            </div>
          )}
          <span
            className="re-quota-none"
            title={`Cursor doesn’t report how much of ${
              quota.cursor.plan ? `the ${quota.cursor.plan} plan’s` : 'this account’s'
            } usage is left, so Orbit shows no number rather than 0%.`}
          >
            Usage unavailable
          </span>
        </>
      ) : (
        <span
          className="re-quota-none"
          title={kind === 'unknown' && signIn ? 'No quota reading — the sign-in check didn’t answer.' : undefined}
        >
          {kind === 'in'
            ? quota.noLimit
              ? RUNNER_ENGINE_NO_QUOTA_LIMIT
              : 'No quota reported'
            : kind === 'out'
              ? 'Sign in to see quota'
              : kind === 'unknown' && signIn
                ? RUNNER_ENGINE_NO_READING
                : '—'}
        </span>
      )}
    </div>
  );
}

/** Routine account maintenance stays in one menu. The pause dialog lives outside the dropdown
 *  so closing the menu does not unmount the operation it just opened. `moreRef` is its button. */
function RunnerAccountMenu({ onRename, onSignIn, signInLabel, onRemove, offline, removing, removesInOrbit, pause, moreRef }: {
  onRename?: () => void;
  onSignIn?: () => void;
  /** What that item is called: "Re-sign in" for a login that is in, "Sign in" for one the check
   *  couldn't answer. */
  signInLabel?: string;
  onRemove?: () => void;
  offline: boolean;
  removing?: boolean;
  /** Remove changes only Orbit's own record (Default's): nothing goes to the machine, so it stays
   *  enabled with the runner offline. */
  removesInOrbit?: boolean;
  pause?: { name: string; until?: string | null; endpoint: string };
  moreRef?: RefObject<HTMLButtonElement | null>;
}) {
  // Rename opens the name's editor once the closing menu has handed focus back to More. Opened any
  // sooner, the editor can mount in the same commit that removes the menu, whose focus return then
  // still lands on More, blurring (and so closing) the editor.
  const renameOnFocus = useRef(false);
  const rename = () => {
    renameOnFocus.current = true;
    // Chosen before focus entered the menu: More still has it, so its return is made a real move.
    if (moreRef?.current && document.activeElement === moreRef.current) moreRef.current.blur();
  };
  const menu = (controls?: AccountPauseControls) => {
    const items: MenuItem[] = [
      ...(onRename ? [{ key: 'rename', icon: <EditOutlined aria-hidden />, label: 'Rename', onSelect: rename }] : []),
      ...(onSignIn ? [{ key: 'login', icon: <LoginOutlined aria-hidden />, label: signInLabel ?? 'Re-sign in', disabled: offline, onSelect: onSignIn }] : []),
      ...(controls ? controls.paused ? [
        { key: 'resume', icon: <PlayCircleOutlined aria-hidden />, label: 'Resume now', disabled: controls.pending, onSelect: controls.resume },
        { key: 'duration', icon: <PauseOutlined aria-hidden />, label: 'Change pause duration…', disabled: controls.pending, onSelect: controls.choose },
      ] : [
        { key: 'pause', icon: <PauseOutlined aria-hidden />, label: 'Pause account…', disabled: controls.pending, onSelect: controls.choose },
      ] : []),
      ...(onRemove ? [
        { type: 'separator' as const, key: 'divider' },
        { key: 'remove', icon: <DeleteOutlined aria-hidden />, label: 'Remove account', danger: true, disabled: (offline && !removesInOrbit) || removing, onSelect: onRemove },
      ] : []),
    ];
    if (items.length === 0) return null;
    return (
      <Menu
        align="end"
        popupClassName="re-account-menu"
        items={items}
        trigger={<Button ref={moreRef} size="small" variant="text" className="re-action re-more" icon={<EllipsisOutlined />} aria-label="More actions" title="More actions"
          onFocus={() => {
            if (!renameOnFocus.current) return;
            renameOnFocus.current = false;
            onRename?.();
          }} />}
      />
    );
  };
  return pause ? <AccountPauseActions {...pause}>{menu}</AccountPauseActions> : menu();
}

/**
 * A folded group's status and quota, in the columns its accounts' rows use: that one of them needs
 * signing in again, which a fold must never hide — otherwise the state of the account a new session
 * starts on (the NEXT among the rows), and that account's window nearest its limit, named. The runner
 * page says the same for the engine, and an account pool's head for its next account.
 */
function FoldedAccounts({
  runner,
  engine,
  health,
  accounts,
  next,
  usage,
  now,
}: {
  runner: Runner;
  engine: LoginEngine;
  health?: RunnerEngineHealth;
  /** The group's accounts, less any on its way out. */
  accounts: RunnerEngineAccount[];
  next?: string | null;
  usage: PlanUsage | null;
  now: number;
}) {
  const signedOut = accounts.filter((account) => accountKindOf(account) === 'out' && !runsOnEnvKey(health, account)).length;
  // A fold must not hide a check that got no answer either: it is the one state a folded head could
  // otherwise call nothing at all.
  const unchecked = accounts.filter((account) => accountKindOf(account) === 'unknown' && !runsOnEnvKey(health, account)).length;
  const account = accounts.find((entry) => entry.id === next);
  const kind: RowKind = account ? (runsOnEnvKey(health, account) ? 'in' : accountKindOf(account)) : 'out';
  const quota: Quota = account
    ? quotaOf(kind, accountPlanUsage(usage, engine, account.id), !!runner.online, now, engine)
    : { windows: [], stale: null, noLimit: false };
  const binding = bindingPlanUsageRow(quota.windows);
  return (
    <>
      {signedOut > 0 ? (
        <div className="re-status">
          <Badge tone="orange">{signedOut} signed out</Badge>
        </div>
      ) : unchecked > 0 ? (
        <div className="re-status">
          <Badge>{runnerEngineAccountsUnchecked(unchecked)}</Badge>
        </div>
      ) : account ? (
        <AccountPauseStatus until={account.pausedUntil} now={now} detail={kind === 'in' ? 'Signed in' : undefined} status={statusOf(kind, quota, now)} />
      ) : (
        <div className="re-status" />
      )}
      <QuotaCell
        kind={kind}
        quota={{ ...quota, windows: binding ? [binding] : [] }}
        next={account && accountNameOf(account)}
      />
    </>
  );
}

/** One engine on one runner: what it is, what state it's in, what it costs, and the way out. */
function EngineRow({
  runner,
  engine,
  health,
  accounts,
  signIn,
  onSignIn,
  focused,
  machinePage,
  next,
  open,
  onFold,
}: {
  runner: Runner;
  engine: RowEngine;
  health?: RunnerEngineHealth;
  /** The accounts listed under this row (accountRowsOf). Any at all make it their group's head. */
  accounts: RunnerEngineAccount[];
  /** The sign-in panel open on this runner, if any: an engine, or one of Codex's accounts. */
  signIn: string | null;
  onSignIn: (panel: string | null) => void;
  /** This is the row a deep link came here for: mark it and bring it into view. */
  focused?: boolean;
  /** On the machine's own page, where the way to update its engines is the page's, not this row's. */
  machinePage?: boolean;
  /** The account a session nobody picked one for starts on (accountToStartOn), of a group. */
  next?: string | null;
  /** Whether this engine's accounts are listed under it, or folded into it. */
  open: boolean;
  onFold: (open: boolean) => void;
}) {
  const message = useToast();
  const qc = useQueryClient();
  const kind = rowKindOf(health, runner.install, engine);
  // This row's engine, where it is one this page signs in. OpenCode is the one row here without a
  // relayable sign-in — it authenticates per provider, and the runner refuses a login it would
  // have to drive — so every sign-in affordance hangs off this, and what the row offers instead is
  // the command to run on the machine (openCodeHint below).
  const loginEngine: LoginEngine | null = engine === 'opencode' ? null : engine;
  const antigravity = engine === 'antigravity' ? runner.antigravity : undefined;
  const googleLogin = engine === 'antigravity' ? (antigravity?.googleLogin ?? 'needs_update') : undefined;
  const envKey = engine === 'antigravity' && kind === 'in' && health?.authSource !== 'google';
  const loginHint = googleLogin === 'unsupported_platform'
    ? 'Google sign-in is not supported on macOS runners yet. Use a Gemini API key.'
    : googleLogin === 'needs_update' ? 'Update this runner to sign in with Google.' : null;
  // Cursor CLI's own admission (cursorRunnerState): a runner that predates it, a platform its pinned
  // build was never measured on, or a build other than the pinned one. Each is the row's whole story —
  // nothing signed in or read can change it — and says what fixes it under the row. Not installed is
  // every engine's `missing`, with its Install.
  const cursorState = engine === 'cursor' ? cursorRunnerState(runner) : 'ready';
  const cursorBlocked = cursorState === 'updateRunner' || cursorState === 'unsupportedPlatform' || cursorState === 'unsupportedVersion';
  const cursorHint = cursorBlocked ? cursorStateHint(cursorState, health) : null;
  // This machine's Claude connection comes out where Anthropic doesn't offer Claude (runner.region,
  // docs/claude-region-check-contract.md): Orbit runs no Anthropic account here and starts no Claude
  // sign-in, so the row says so in place of what its accounts could take, and Check again stands where
  // Add account and Sign in would — the accounts stay as they are, and run again once a check passes.
  const regionBlocked = engine === 'claude' && claudeRegionBlocked(runner);
  const regionCheck = useClaudeRegionCheckAgain(runner);
  // Nothing here signs OpenCode in, so the row says what does. Only once there is a CLI on the
  // machine to run it against: an install that hasn't happened yet has no sign-in to point at.
  const openCodeHint = loginEngine === null && health?.installed
    ? <>
        Run <code>opencode auth login</code> on that machine, or use a configured key — OpenCode's
        sign-in is provider-specific, so it can't be driven from here.
      </>
    : null;
  const offline = !runner.online;
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) row.current?.scrollIntoView({ block: 'center' });
  }, [focused]);

  const install = useMutation({
    mutationFn: () =>
      api(`/runners/${runner.id}/install`, { method: 'POST', body: { engine } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: runnersQuery().queryKey }),
    onError: (e: Error) => message.error("Couldn't start the install", e.message),
  });
  const dismissInstall = useMutation({
    mutationFn: () => api(`/runners/${runner.id}/install`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: runnersQuery().queryKey }),
  });

  // Only one runtime's quota is this engine's; the others belong to the other rows. Antigravity's
  // comes with its engine's health, folded in beside the rest.
  const usage = withEnginePlanUsage(runner.planUsage, runner.engines);
  // More than one Codex account: this row heads their group, and each account is a row of its own
  // below it (AccountRow), with its own state — or, folded, the head says what they come to.
  const grouped = accounts.length > 0;
  const folded = grouped && !open;
  // Blocked, the head speaks for the whole machine in the status and quota columns, open or folded.
  const columns = folded || (grouped && regionBlocked);
  // The engine's one account, which this row is when it stands alone — not when it heads a group of
  // one, as it does while Default is removed from Orbit (accountRowsOf).
  const single = !grouped && engineKeepsAccounts(engine) && health?.accounts?.length === 1 ? health.accounts[0] : undefined;
  // What the head says for its group: how many of its accounts could take a session now, out of
  // those staying — one being removed is counted as gone already.
  const kept = accounts.filter((account) => !beingRemoved(runner, engine, account.id));
  // A group's head counts its paused accounts out, and folded there are no account rows to keep
  // time for them: it keeps the earliest pause's itself.
  const now = usePauseClock(
    single?.pausedUntil ?? kept.map((account) => account.pausedUntil).filter((until) => accountIsPaused(until)).sort()[0],
  );
  const snapshot = planUsageSnapshotForProvider(usage, engine);
  const quota = quotaOf(kind, snapshot, !!runner.online, now, engine);
  const ready = kept.filter((account) => {
    // Antigravity's Default on the machine's Gemini key says no for a Google sign-in it does not
    // need: it takes sessions on the key.
    const own = runsOnEnvKey(health, account) ? 'in' : accountKindOf(account);
    // An account's quota is its engine's to read, and only an engine with a sign-in has accounts.
    const accountQuota = loginEngine === null ? null : accountPlanUsage(usage, loginEngine, account.id);
    return !accountIsPaused(account.pausedUntil, now) && available(own, quotaOf(own, accountQuota, !!runner.online, now, engine));
  }).length;
  // The accounts whose sign-in check got no answer. The head counts them out of "available" and
  // names them after it, because "0 of N accounts available" reads as "nothing is logged in" — a
  // claim the runner never made.
  const unchecked = kept.filter(
    (account) => !runsOnEnvKey(health, account) && accountKindOf(account) === 'unknown',
  ).length;
  // "Add account" is how a machine gets from one account to two, so it is not the group's to hold:
  // the Codex row offers it whether it heads a group yet or not — but only once a first account is
  // signed in. A signed-out row's way to the first is its own Sign in, and an unanswered check may
  // still be one, so both of those keep their rows to it. An Antigravity account is a Google
  // sign-in, which only some runners can add, and a Kimi account only a runner that keeps them
  // apart can; OpenCode keeps no accounts at all, and has no sign-in to add one with.
  const anyAccountIn = (health?.accounts ?? []).some((account) => account.auth === 'yes');
  const addAccountTo: LoginEngine | null =
    !regionBlocked && loginEngine !== null && engineKeepsAccounts(loginEngine) &&
    (kind === 'in' || kind === 'unknown' || anyAccountIn) &&
    (loginEngine !== 'antigravity' || addsAntigravityAccounts(runner)) &&
    (loginEngine !== 'kimi' || addsKimiAccounts(runner)) &&
    (loginEngine !== 'cursor' || (addsCursorAccounts(runner) && cursorState !== 'updateRunner' && cursorState !== 'unsupportedPlatform'))
      ? loginEngine
      : null;

  // An offline machine isn't updating anything, and the header already says so — repeating it
  // per row as a warning would put three alarms on one fact the user has already read. Cursor CLI's
  // build is the one Orbit pins, which its note says.
  const note = kind === 'missing' || (cursorBlocked && !health?.installed)
    ? null
    : updateNoteOf(health?.update, undefined, engine === 'cursor', engineUpdateDismissedFor(runner, engine));
  const warn = note?.tone === 'warn' && !offline;
  const dismissWarning = useDismissEngineUpdateWarning(runner.id);

  const action = () => {
    if (antigravity?.supported === false) return null;
    if (regionBlocked) return null;
    // A build other than the pinned one is put back the way a missing one is put there; a runner too
    // old for Cursor CLI, or on a platform it doesn't run on, has nothing here to press.
    if (cursorState === 'unsupportedVersion') {
      return (
        <Button size="small" className="re-action re-install" icon={<DownloadOutlined aria-hidden />} disabled={offline} loading={install.isPending} onClick={() => install.mutate()}>
          Reinstall
        </Button>
      );
    }
    if (cursorBlocked) return null;
    if (engine === 'antigravity' && kind !== 'missing' && kind !== 'installing' && kind !== 'install-failed') {
      if (googleLogin !== 'available') return null;
      // Signed in (on the key or on Google), or a check that got no answer: nothing to sign in to
      // on the row. An unanswered check keeps its action in More, like every engine's.
      if ((kind === 'in' && !envKey) || kind === 'unknown') return null;
      return <Button size="small" variant="primary" className="re-action" disabled={offline} onClick={() => onSignIn(signIn === engine ? null : engine)}>Sign in with Google</Button>;
    }
    if (offline) {
      // Nothing on an offline machine can be pressed. An engine with a sign-in still shows where
      // the button would be; OpenCode has none to show, and an unanswered check is no sign-out.
      return loginEngine === null || kind === 'in' || kind === 'unknown' ? null : <Button size="small" className="re-action" disabled>Sign in</Button>;
    }
    switch (kind) {
      case 'missing':
        return (
          <Button size="small" className="re-action re-install" icon={<DownloadOutlined aria-hidden />} loading={install.isPending} onClick={() => install.mutate()}>
            Install
          </Button>
        );
      case 'installing':
        return (
          <Button size="small" variant="text" className="re-action" onClick={() => dismissInstall.mutate()}>
            Cancel
          </Button>
        );
      case 'install-failed':
        return (
          <Button size="small" className="re-action" loading={install.isPending} onClick={() => install.mutate()}>
            Retry
          </Button>
        );
      case 'in':
        return null;
      // The check got no answer: nothing says the account is out, so the row offers no sign-in.
      // The action stays in More for the case the login really is gone.
      case 'unknown':
        return null;
      // Signed out, or just installed. An install the probe hasn't caught up with yet
      // gets Sign in too: a CLI that was just installed has no sign-in, so that is what comes next,
      // and the runner only reports an install done once the binary is on its PATH — waiting for the
      // check-in first left the row with nothing to press for up to a heartbeat.
      default:
        // OpenCode is the exception: there is no sign-in here to relay, so the row carries the
        // command that does it on the machine instead (openCodeHint).
        return loginEngine === null ? null : (
          <Button
            size="small"
            variant="primary"
            className="re-action"
            onClick={() => onSignIn(signIn === engine ? null : engine)}
          >
            Sign in
          </Button>
        );
    }
  };

  const meta = cursorBlocked && !health?.installed ? null : (
    <>
      {grouped && regionBlocked ? (
        // None of them can take a session here; how many there are is all there is to count.
        <>{versionOf(engine, health)} · {claudeRegionAccounts(kept.length)}</>
      ) : grouped ? (
        <>
          {versionOf(engine, health)} ·{' '}
          <b>
            {kept.length > 0 && unchecked === kept.length
              ? runnerEngineCouldntCheckAccounts(kept.length)
              : `${ready} of ${kept.length} accounts available`}
          </b>
          {unchecked > 0 && unchecked < kept.length && <> · {runnerEngineAccountsUnchecked(unchecked)}</>}
        </>
      ) : (
        // A build Orbit doesn't run says which it is; nothing it would answer about a sign-in matters.
        <>{cursorBlocked ? versionOf(engine, health) : metaFor(kind, engine, health, loginEngine !== null)}</>
      )}
      {/* Whether this CLI is being kept current, next to what it currently is — the two
          halves of the same question, and useless apart. */}
      {/* The machine's own sentence, on hover. The line itself stays short enough to sit
          after a version string, and everything it had to leave out — which path, which
          owner, which error — is one pointer away instead of gone. Absent for a healthy
          engine, which has nothing further to say. */}
      {note && (
        <span className={`re-upd${warn ? ' warn' : ''}`} title={health?.update?.message}>
          {/* Folded, the head shares its width with a status and a quota, so the note takes a line
              of its own (.re-grp.folded) rather than leave half of itself on the next. */}
          {columns ? note.text : <>{' '}· {note.text}</>}
        </span>
      )}
    </>
  );

  return (
    <div
      className={`re-row${grouped ? ' re-grp' : ''}${columns ? ' folded' : ''}${focused ? ' focused' : ''}${accountIsPaused(single?.pausedUntil, now) ? ' account-paused' : ''}`}
      ref={row}
      data-engine={engine}
      // The head's line folds its group from anywhere on it, as a card's head does — not a panel or
      // note opened under the line, which are the row's and not its head's.
      onClick={grouped ? foldFromAnywhere(() => onFold(!open), 'button, a, input, .re-panel, .re-login-note, .re-dup') : undefined}
    >
      {grouped ? (
        // A group folds under its head. The toggle is the identity alone, as a runner card's is, so
        // Add account beside it stays a button of its own; a press elsewhere on the line is the
        // toggle's (foldFromAnywhere).
        <button className="re-id re-grp-toggle" type="button" aria-expanded={open} onClick={() => onFold(!open)}>
          <ProviderTile slug={ENGINE_PRESET[engine] ?? engine} label={engineNameOf(engine)} size={28} />
          <span className="re-grp-copy">
            <span className="re-name">
              {engineNameOf(engine)}
              <span className={`re-grp-chev${open ? ' open' : ''}`} aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path
                    d="m9 5 7 7-7 7"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            </span>
            <span className="re-meta">{meta}</span>
          </span>
        </button>
      ) : (
        <div className="re-id">
          <ProviderTile slug={ENGINE_PRESET[engine] ?? engine} label={engineNameOf(engine)} size={28} />
          <div style={{ minWidth: 0 }}>
            <div className="re-name">{engineNameOf(engine)}</div>
            {meta && <div className="re-meta">{meta}</div>}
          </div>
        </div>
      )}
      {/* Signed in and quota are each account's, not the engine's: an open group's head has no
          columns for them, and its line runs the width of the row instead. Folded, it speaks for
          its accounts in those columns. */}
      {!grouped && cursorBlocked && (
        <>
          <div className="re-status">
            <Badge tone="orange">{CURSOR_STATE_LABEL[cursorState as Exclude<typeof cursorState, 'ready'>]}</Badge>
          </div>
          <div className="re-quota">
            <span className="re-quota-none">—</span>
          </div>
        </>
      )}
      {/* No Anthropic usage is read on a machine blocked for its region: nothing to gauge. */}
      {regionBlocked && (
        <>
          <div className="re-status">
            <Badge tone="orange">{CLAUDE_REGION_NOT_SUPPORTED}</Badge>
          </div>
          <div className="re-quota">
            <span className="re-quota-none">—</span>
          </div>
        </>
      )}
      {!grouped && !cursorBlocked && !regionBlocked && (
        <>
          <AccountPauseStatus until={single?.pausedUntil} now={now} detail={kind === 'in' ? 'Signed in' : undefined} status={antigravity?.supported === false ? { color: 'orange', label: 'Update runner' } : statusOf(kind, quota, now, loginEngine !== null)} />
          {envKey ? <div className="re-quota re-meta">env key · runs on your Gemini key</div> : <QuotaCell kind={kind} quota={quota} signIn={loginEngine !== null} />}
        </>
      )}
      {folded && !regionBlocked && loginEngine !== null && (
        <FoldedAccounts runner={runner} engine={loginEngine} health={health} accounts={kept} next={next} usage={usage} now={now} />
      )}
      <div className="re-act">
        {regionBlocked && (
          <Button
            size="small"
            className="re-action"
            disabled={offline}
            loading={regionCheck.checking}
            onClick={regionCheck.checkAgain}
          >
            {CLAUDE_REGION_CHECK_AGAIN}
          </Button>
        )}
        {addAccountTo && (
          <Button
            size="small"
            className="re-action re-add-account"
            icon={<PlusOutlined aria-hidden />}
            disabled={offline}
            onClick={() => {
              if (signIn === addAccountPanel(addAccountTo)) return onSignIn(null);
              onSignIn(addAccountPanel(addAccountTo));
              // The account this adds lands as a row of the group: open it, so that row is there to see.
              onFold(true);
            }}
          >
            Add account
          </Button>
        )}
        {/* A group's sign-ins are its accounts', each on its own row. */}
        {!grouped && action()}
        {!grouped && (
          <RunnerAccountMenu
            offline={offline}
            onSignIn={!regionBlocked && loginEngine !== null && (kind === 'in' || kind === 'unknown') && (loginEngine !== 'antigravity' || (googleLogin === 'available' && !envKey))
              ? () => onSignIn(signIn === engine ? null : engine)
              : undefined}
            signInLabel={kind === 'unknown' ? 'Sign in' : undefined}
            // A Gemini key is not an account of the machine's to pause: Default on it is no Google
            // sign-in at all.
            pause={single && ((kind === 'in' && !envKey) || accountIsPaused(single.pausedUntil, now)) ? {
              name: accountNameOf(single), until: single.pausedUntil,
              endpoint: `/runners/${runner.id}/accounts/${engine}/${single.id}/pause`,
            } : undefined}
          />
        )}
      </div>

      {/* The check got no answer: said once under the head, with what it does and does not mean.
          The rows above keep their own badges; signing in is not the fix for a timeout. */}
      {grouped && !folded && unchecked > 0 && !regionBlocked && (
        <div className="re-dup">
          <span>{runnerEngineCouldntCheckNote()}</span>
        </div>
      )}

      {/* The engine's one account says what an account row says: a login about to lapse, and what
          being signed out costs — here, the engine on this machine. */}
      {!grouped && single && !envKey && !regionBlocked && loginExpiresLine(single, now) && (
        <div className="re-dup re-expiring">
          <span>{loginExpiresLine(single, now)}</span>
          <button className="re-link" type="button" disabled={offline} onClick={() => onSignIn(signIn === engine ? null : engine)}>
            {RUNNER_ENGINE_RENEW}
          </button>
        </div>
      )}
      {!grouped && kind === 'out' && !loginHint && !cursorBlocked && !regionBlocked && (
        <div className="re-dup">
          <span>{signedOutNote(engineNameOf(engine), true)}</span>
        </div>
      )}
      {/* Only an engine Orbit signs in has a sign-in check to explain: OpenCode's unknown is its own
          provider's, said under the row by openCodeHint. */}
      {!grouped && kind === 'unknown' && loginEngine !== null && !loginHint && !cursorBlocked && !regionBlocked && !envKey && (
        <div className="re-dup">
          <span>{runnerEngineCouldntCheckNote()}</span>
        </div>
      )}
      {/* Why, and what still runs here; then when it was checked and where Claude's connection came out. */}
      {regionBlocked && runner.region && (
        <div className="re-login-note">
          <div className="rsi-hint">
            {claudeRegionMachineNote(runner.region.name)}{' '}
            <a href={CLAUDE_REGION_SUPPORTED_REGIONS_URL} target="_blank" rel="noreferrer">
              {CLAUDE_REGION_SUPPORTED_REGIONS}
            </a>
          </div>
          <div className="rsi-hint re-region-checked">
            {claudeRegionChecked(ago(runner.region.checkedAt, now), runner.region.name, runner.region.viaProxy)}
          </div>
        </div>
      )}
      {loginHint && <div className="re-panel-hint re-login-note">{loginHint}</div>}
      {cursorHint && <div className="re-panel-hint re-login-note">{cursorHint}</div>}
      {openCodeHint && <div className="re-panel-hint re-login-note">{openCodeHint}</div>}
      {googleLogin === 'available' && signIn !== engine && <div className="re-login-note"><GoogleSignInTerms /></div>}

      {/* The relay panels. Each one is the row's own news, so it opens under the row it belongs
          to rather than as a page-level banner. */}
      {kind === 'installing' && (
        <div className="re-panel">
          <div className="re-panel-row">
            Installing {engineNameOf(engine)} on {runner.displayName || runner.name}…
          </div>
          {runner.install?.command && <code className="re-cmd">{runner.install.command}</code>}
          <div className="re-panel-hint">
            {runner.install?.status === 'pending'
              ? 'The runner picks it up on its next check-in, so this can take up to a minute to start.'
              : 'You can leave this page — it keeps running on that machine.'}
          </div>
        </div>
      )}
      {kind === 'install-failed' && (
        <div className="re-panel bad">
          {/* The machine's own words. Without them a failed install is only fixable by opening a
              terminal on that box, which is exactly what this page exists to avoid. */}
          <div className="re-panel-row">{runner.install?.message || 'The installer failed.'}</div>
          {/* Labelled, because the message above usually ends in an alternative command — without
              this the two commands read as a pair with no way to tell which one already failed. */}
          {runner.install?.command && (
            <div className="re-panel-hint">
              Orbit ran <code className="re-cmd">{runner.install.command}</code>
            </div>
          )}
          <div className="re-panel-hint">
            <button className="re-link" type="button" onClick={() => dismissInstall.mutate()}>
              Dismiss
            </button>
          </div>
        </div>
      )}
      {/* Drifted, and not for a reason this page can name. The machine's own words are the only
          actionable thing here — an EACCES on someone else's global prefix isn't guessable, and
          no button on this page can fix it, which is why this is a explanation and not a Retry. */}
      {warn && (
        <div className="re-panel warn">
          <div className="re-panel-row">
            {health?.update?.message || `Orbit hasn't managed to update ${engineNameOf(engine)} here.`}
          </div>
          {/* Points at the machine rather than naming a shell command: that is where updating
              lives now, and telling someone to open a terminal for something the UI can do was
              only ever a symptom of the button being on the wrong page. On that page its Update
              engines is already above, and the link would only lead back to it. */}
          <div className="re-panel-hint">
            Orbit tries every 30 min.
            {/* Until the next release: only a warning against a known latest has one to wait for. */}
            {health?.update?.latest && (
              <>
                {' '}
                <button
                  className="re-link"
                  type="button"
                  disabled={dismissWarning.isPending}
                  onClick={() => dismissWarning.mutate(engine)}
                >
                  {RUNNER_ENGINE_UPDATE_DISMISS}
                </button>
              </>
            )}
            {!machinePage && (
              <>
                {' '}
                <Link to={`/settings/machines/${encodeId(runner.id)}`}>Update this machine’s engines →</Link>
              </>
            )}
          </div>
        </div>
      )}
      {loginEngine !== null && signIn === engine && (!googleLogin || googleLogin === 'available') && (
        <div className="re-panel">
          <RunnerSignIn runnerId={runner.id} engine={loginEngine} />
        </div>
      )}
      {addAccountTo && signIn === addAccountPanel(addAccountTo) && (
        <div className="re-panel">
          <AddEngineAccount
            engine={addAccountTo}
            runnerId={runner.id}
            accounts={health?.accounts ?? []}
            onClose={() => onSignIn(null)}
          />
        </div>
      )}
    </div>
  );
}

/**
 * An account's name on its row, and the way to change it — Default's too, which the machine never
 * names. Rename in its menu, or a double-click on it, swaps it for the session title's own editor
 * (WorkspaceView): everything selected, Enter or a click elsewhere saves, Escape drops the draft, and
 * an empty or unchanged one changes nothing. Only a label, kept in Orbit (RunnersService.renameAccount):
 * nothing on the machine changes, so it works with the runner offline.
 */
function AccountName({
  runner,
  engine,
  account,
  next,
  editing,
  setEditing,
}: {
  runner: Runner;
  engine: LoginEngine;
  account: RunnerEngineAccount;
  next?: boolean;
  editing: boolean;
  setEditing: (editing: boolean) => void;
}) {
  const message = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = useState(accountNameOf(account));
  // Escape blurs the input too; this tells that blur not to save.
  const cancelled = useRef(false);
  // The input hugs its text, measured off an unseen twin, as the session title's does.
  const mirror = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (editing) setWidth((mirror.current?.offsetWidth ?? 0) + 2);
  }, [editing, draft]);
  const rename = useMutation({
    mutationFn: (name: string) =>
      api<RunnerEngineAccount>(`/runners/${runner.id}/accounts/${engine}/${account.id}`, {
        method: 'PATCH',
        body: { name },
      }),
    // Returned, so the new name stays on the row until the list carries it rather than flicking back.
    onSuccess: () => qc.invalidateQueries({ queryKey: runnersQuery().queryKey }),
    onError: (e: Error) => message.error("Couldn't rename the account", e.message),
  });
  const shown = rename.isPending ? (rename.variables ?? accountNameOf(account)) : accountNameOf(account);
  useEffect(() => {
    if (!editing) setDraft(shown);
  }, [editing, shown]);
  // Default named something else says what it still is: the login this machine's own environment
  // selects, which a terminal shares — and which signing in there changes.
  const renamedDefault = account.id === 'default' && shown !== 'Default';
  const start = () => {
    setDraft(shown);
    setEditing(true);
  };

  if (editing) {
    return (
      <>
        <span ref={mirror} className="re-name-mirror" aria-hidden="true">
          {draft || ' '}
        </span>
        <input
          className="re-name-input"
          style={{ width }}
          autoFocus
          value={draft}
          maxLength={60}
          aria-label={`Rename ${shown}`}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => {
            // Select all (typing replaces it), with the caret at the start so a long name shows its head.
            const el = e.currentTarget;
            el.setSelectionRange(0, el.value.length, 'backward');
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return; // let the IME (e.g. pinyin) keep Enter
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancelled.current = true;
              e.currentTarget.blur();
            }
          }}
          onBlur={() => {
            setEditing(false);
            if (cancelled.current) {
              cancelled.current = false;
              return;
            }
            const name = draft.trim();
            if (name && name !== shown) rename.mutate(name);
          }}
        />
      </>
    );
  }
  return (
    <div className="re-name" onDoubleClick={start}>
      <span className="re-name-text">{shown}</span>
      {renamedDefault && <span className="re-chip">DEFAULT</span>}
      {/* Where Automatic starts the next session — the account pools' mark for the same thing. */}
      {next && (
        <span className="re-chip" title="Automatic starts new sessions here">
          NEXT
        </span>
      )}
    </div>
  );
}

/** One Codex account, under its engine's row: its name (AccountName), where it lives on the machine,
 *  its own sign-in state, its own way back in, and the way off this machine — for Default, off
 *  Orbit's list alone, and only while another account is there. */
function AccountRow({
  runner,
  engine,
  account,
  defaultName,
  defaultRemoved,
  others,
  next,
  duplicateOf,
  lastOfGroup,
  envKey,
  regionBlocked = false,
  signIn,
  onSignIn,
}: {
  runner: Runner;
  /** The engine this account belongs to: its own sign-in panel, its own removal, its own quota. */
  engine: LoginEngine;
  account: RunnerEngineAccount;
  /** What this engine's Default is called here — where a removed account's workspaces go. */
  defaultName: string;
  /** This engine's Default is removed from Orbit (`removedDefault`): a removed account's workspaces go
   *  to Automatic's pick among the others — or, with none left, to Default, which Orbit then uses again. */
  defaultRemoved?: boolean;
  /** How many of this engine's other accounts stay on the runner, one on its way out not counted:
   *  Default's removal needs one. */
  others: number;
  /** The account a session nobody picked one for starts on next (accountToStartOn). */
  next?: boolean;
  /** The account already signed in above that this slot turned out to hold too
   *  (duplicateAccounts). Absent for the slot that made the sign-in. */
  duplicateOf?: RunnerEngineAccount;
  /** The last account under this engine: where the rail's spine ends rather than carrying on to a
   *  row that isn't there (.re-acct-end). */
  lastOfGroup?: boolean;
  /** Antigravity's Default on a runner that runs it on its Gemini key (runsOnEnvKey): in, on the key,
   *  with nothing to sign in, pause or read quota for. */
  envKey?: boolean;
  /** A Claude account on a machine blocked for its region (claudeRegionBlocked): kept as it is, with
   *  no sign-in to offer and no usage read. */
  regionBlocked?: boolean;
  signIn: string | null;
  onSignIn: (panel: string | null) => void;
}) {
  const message = useToast();
  const qc = useQueryClient();
  const kind = envKey ? 'in' : accountKindOf(account);
  const [editing, setEditing] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const isDefault = account.id === 'default';
  const panel = accountPanel(engine, account.id);
  // What became of the last removal asked for here, if it was this account's of this engine's: the
  // button says it is under way, and a machine that refused says why.
  const removal = runner.accountRemove;
  const mine = removal?.engine === engine && removal.account === account.id ? removal : null;
  const removing = beingRemoved(runner, engine, account.id);
  const refused = mine?.status === 'failed' ? mine.message : null;
  const remove = useMutation({
    mutationFn: () =>
      api<RunnerAccountRemoveState>(
        `/runners/${runner.id}/accounts/${engine}/${account.id}`,
        { method: 'DELETE' },
      ),
    onSuccess: (state) => {
      // A refusal the control plane could make itself (an older runner, or Default with no other
      // account beside it) arrives as an error; anything the machine decided arrives here. Default's
      // removal is Orbit's own and arrives done.
      if (state?.status === 'failed' && state.message) message.error("Couldn't remove the account", state.message);
      void qc.invalidateQueries({ queryKey: runnersQuery().queryKey });
    },
    onError: (e: Error) => message.error("Couldn't remove the account", e.message),
  });
  // Each account's quota is its own: the runner reads every account in that account's CODEX_HOME,
  // and an account it has not read shows none rather than borrowing another's limit.
  const now = usePauseClock(account.pausedUntil);
  const snapshot = accountPlanUsage(withEnginePlanUsage(runner.planUsage, runner.engines), engine, account.id);
  const quota = quotaOf(kind, snapshot, !!runner.online, now, engine);
  const toggle = () => onSignIn(signIn === panel ? null : panel);
  const expiring = envKey ? null : loginExpiresLine(account, now);
  // Default comes off Orbit's list, not the machine, and only while another account is there to
  // run on (RunnersService.removeAccount).
  const removable = !isDefault || others > 0;
  const runnerName = runner.displayName || runner.name;
  // Removing deletes the slot's sign-in from the machine, and only signing in again brings it back;
  // removing Default stops only Orbit using it, until Use again. Either is asked first, wherever it is
  // offered — anchored to More once its menu has closed, or to the duplicate panel's own Remove.
  const removeQuestion = {
    title: runnerAccountRemoveTitle(accountNameOf(account)),
    description: isDefault
      ? runnerDefaultRemoveDetail(runnerName, engineNameOf(engine))
      : !defaultRemoved
        ? `Its sign-in is deleted from ${runnerName}. ` +
          `Workspaces set to this account run on ${defaultName}.`
        : others > 0
          ? runnerAccountRemoveDetailAutomatic(runnerName)
          : runnerAccountRemoveDetailLast(runnerName, defaultName),
    popupClassName: 're-confirm',
    confirmText: 'Remove',
    danger: true,
    onConfirm: () => {
      remove.mutate();
      setConfirmingRemove(false);
    },
  };
  const menuAnchor = useRef<HTMLSpanElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const menu = (
    <RunnerAccountMenu
      offline={!runner.online}
      removing={removing}
      removesInOrbit={isDefault}
      moreRef={more}
      onRename={() => setEditing(true)}
      onSignIn={(kind === 'in' || kind === 'unknown') && !envKey && !regionBlocked ? toggle : undefined}
      signInLabel={kind === 'unknown' ? 'Sign in' : undefined}
      onRemove={removable ? () => setConfirmingRemove(true) : undefined}
      pause={(kind === 'in' && !envKey) || accountIsPaused(account.pausedUntil, now) ? {
        name: accountNameOf(account), until: account.pausedUntil,
        endpoint: `/runners/${runner.id}/accounts/${engine}/${account.id}/pause`,
      } : undefined}
    />
  );

  return (
    <div className={`re-row re-acct${lastOfGroup ? ' re-acct-end' : ''}${accountIsPaused(account.pausedUntil, now) ? ' account-paused' : ''}${removing ? ' account-removing' : ''}`}>
      <div className="re-id">
        <span className="re-rail" aria-hidden="true" />
        <div className="re-id-main" style={{ minWidth: 0 }}>
          <AccountName runner={runner} engine={engine} account={account} next={next} editing={editing} setEditing={setEditing} />
          {/* Where the account lives and which one it is — never who: the account's email and id
              stay on the machine, and the fingerprint is a prefix of a non-reversible one. A Kimi
              account says its site first, which is each account's own (kimi.com or kimi.ai). */}
          <div className="re-meta" title={accountDir(account)}>
            {engine === 'kimi' && account.kimiRegion && `${KIMI_SITE[account.kimiRegion].domain} · `}
            {/* A Cursor CLI account says its plan first, as Cursor names it. */}
            {engine === 'cursor' && snapshot?.planName && `${snapshot.planName} plan · `}
            {tildePath(accountDir(account))}
            {account.fingerprintPrefix && ` · account ${account.fingerprintPrefix}…`}
          </div>
        </div>
      </div>
      {removing ? (
        <div className="re-status">
          <Badge tone="info" icon={<LoadingOutlined />}>Removing…</Badge>
        </div>
      ) : (
        // On a machine blocked for its region the account can take no session there: its sign-in is all
        // there is to say, never Available.
        <AccountPauseStatus until={account.pausedUntil} now={now} detail={kind === 'in' ? 'Signed in' : undefined} status={statusOf(kind, regionBlocked ? NO_QUOTA : quota, now)} />
      )}
      {/* What the engine's own row says for the same key when it is the machine's one account. */}
      {envKey ? (
        <div className="re-quota re-meta">env key · runs on your Gemini key</div>
      ) : regionBlocked ? (
        <div className="re-quota">
          <span className="re-quota-none">—</span>
        </div>
      ) : (
        <QuotaCell kind={kind} quota={quota} />
      )}
      <div className="re-act">
        {/* An unanswered check is not a sign-out: no button on the row. Sign in stays in More for
            the case the login really is gone. */}
        {kind === 'out' && !regionBlocked && (
          <Button size="small" className="re-action" variant={runner.online ? 'primary' : 'default'} disabled={!runner.online || removing} onClick={toggle}>
            Sign in
          </Button>
        )}
        {/* The confirmation stays anchored to More after its menu closes. */}
        {removable ? (
          <>
            <span ref={menuAnchor} className="re-menu-anchor">{menu}</span>
            <Popconfirm
              {...removeQuestion}
              anchor={menuAnchor}
              open={confirmingRemove}
              onOpenChange={(open) => { if (!open) setConfirmingRemove(false); }}
              onCancel={() => setConfirmingRemove(false)}
              returnFocus={more}
            />
          </>
        ) : menu}
      </div>
      {/* The same account, signed in twice. Two rows of quota for one account read as two quotas,
          so the repeat is named on the row that made it — with the one way out right there: this
          slot's CODEX_HOME and the record beside it go, and the other sign-in is untouched. */}
      {duplicateOf && (
        <div className="re-dup">
          <span>
            This is the same account as <b>{accountNameOf(duplicateOf)}</b> — signing in twice does
            not double the quota.
          </span>
          <Popconfirm
            {...removeQuestion}
            trigger={
              <button className="re-link" type="button" disabled={!runner.online || removing}>
                Remove
              </button>
            }
          />
        </div>
      )}
      {/* A login about to lapse, said before it does the way Claude Code says it, with the way to
          renew it right there: the row's own sign-in, into the same account. */}
      {expiring && !removing && !regionBlocked && (
        <div className="re-dup re-expiring">
          <span>{expiring}</span>
          <button className="re-link" type="button" disabled={!runner.online} onClick={toggle}>
            {RUNNER_ENGINE_RENEW}
          </button>
        </div>
      )}
      {/* What its being signed out costs, under its Sign in. */}
      {kind === 'out' && !removing && !regionBlocked && (
        <div className="re-dup">
          <span>{signedOutNote(engineNameOf(engine), false)}</span>
        </div>
      )}
      {/* The machine would not do it, and its reason is the only thing that can explain why: a
          session is running on that account, or the runner is too old to remove one at all. */}
      {refused && (
        <div className="re-panel bad">
          <div className="re-panel-row">{refused}</div>
          <div className="re-panel-hint">
            {tildePath(accountDir(account))} on {runner.displayName || runner.name} is untouched.
          </div>
        </div>
      )}
      {signIn === panel && (
        <div className="re-panel">
          <RunnerSignIn runnerId={runner.id} engine={engine} account={account.id} />
        </div>
      )}
    </div>
  );
}

/** Where an engine's accounts end while its Default is removed from Orbit: which one it is and where it
 *  lives on the machine, which keeps it and its sign-in, and Use again, which brings it back. Orbit's
 *  own record, as the removal is, so it works with the runner offline. */
function RemovedDefault({ runner, engine, removed }: { runner: Runner; engine: LoginEngine; removed: RunnerRemovedDefault }) {
  const message = useToast();
  const qc = useQueryClient();
  const name = accountNameOf({ id: 'default', name: removed.name });
  const line = useId();
  const restore = useMutation({
    mutationFn: () => api(`/runners/${runner.id}/accounts/${engine}/default/restore`, { method: 'POST' }),
    // Returned, so the button stays busy until the list carries Default back and this line goes.
    onSuccess: () => qc.invalidateQueries({ queryKey: runnersQuery().queryKey }),
    onError: (e: Error) => message.error(runnerDefaultUseAgainFailed(name), e.message),
  });
  return (
    <div className="re-row re-acct re-acct-end re-removed">
      <div className="re-id">
        <span className="re-rail" aria-hidden="true" />
        <div id={line} className="re-removed-line" title={removed.home}>
          {runnerDefaultRemovedLine(name, tildePath(removed.home))}
        </div>
      </div>
      <div className="re-act">
        <Button size="small" className="re-action re-use-again" loading={restore.isPending} aria-describedby={line} onClick={() => restore.mutate()}>
          {RUNNER_DEFAULT_USE_AGAIN}
        </Button>
      </div>
    </div>
  );
}

/**
 * "Add account": the same sign-in flow as every other here, started the moment the panel opens, under
 * a name the page picks (defaultAccountName). The runner gives the account a config directory of its
 * own, so Default — and the CLI in a terminal — is untouched. Kimi's waits for its site instead: the
 * press on kimi.com or kimi.ai is what starts it, as on every Kimi sign-in card.
 *
 * The name stays editable throughout, and Enter or a click elsewhere saves it the way a row's rename
 * does (AccountName). That rename can only name an account the runner reports, which a new one is
 * once it is signed in, so a name saved before then waits here for it — and a panel closed first
 * leaves the account the name it was added under, for its row's rename to change.
 *
 * Once that account is signed in, reported and named, the panel folds itself away: what it added is
 * that account's own row, and the row's menu is where its name changes from then on.
 */
function AddEngineAccount({
  engine,
  runnerId,
  accounts,
  onClose,
}: {
  engine: LoginEngine;
  runnerId: string;
  /** Every account the runner reports for this engine, Default included. */
  accounts: RunnerEngineAccount[];
  /** Fold the panel away: its own Cancel, and the moment the account it added is done. */
  onClose: () => void;
}) {
  const message = useToast();
  const qc = useQueryClient();
  const [picked] = useState(() => defaultAccountName(accounts));
  const [name, setName] = useState(picked);
  // The accounts the runner had when the panel opened. The one this sign-in adds is the newest it
  // reports that is not among them: the runner lists added accounts in the order they were made.
  const [had] = useState(() => new Set(accounts.map((account) => account.id)));
  const added = accounts.filter((account) => !had.has(account.id)).at(-1);
  // A name saved before the runner reported the account it is for.
  const [waiting, setWaiting] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const rename = useMutation({
    mutationFn: ({ id, to }: { id: string; to: string }) =>
      api<RunnerEngineAccount>(`/runners/${runnerId}/accounts/${engine}/${id}`, {
        method: 'PATCH',
        body: { name: to },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: runnersQuery().queryKey }),
    // Not returned: an error toast stays until dismissed, and a mutation awaits what onError returns,
    // so returning it would hold the rename pending — and the panel waiting on it — until then.
    onError: (e: Error) => {
      message.error("Couldn't rename the account", e.message);
    },
  });
  const save = () => {
    const to = name.trim();
    // An empty name changes nothing, as on a row: the field goes back to the name the account has.
    if (!to) setName(added ? accountNameOf(added) : (waiting ?? picked));
    else if (!added) setWaiting(to);
    else if (to !== accountNameOf(added)) rename.mutate({ id: added.id, to });
  };
  const addedId = added?.id;
  const addedName = added && accountNameOf(added);
  useEffect(() => {
    if (!addedId || waiting === null) return;
    setWaiting(null);
    if (waiting !== addedName) rename.mutate({ id: addedId, to: waiting });
  }, [addedId, addedName, waiting, rename.mutate]);
  // Done: the account is signed in by the runner's own word, and carries the name in the field. Not
  // while that name is still being typed or saved — a rename that failed leaves it differing, and the
  // panel open — and never after a sign-in that failed or was cancelled, which reports no such account.
  const finished =
    added?.auth === 'yes' &&
    !focused &&
    waiting === null &&
    !rename.isPending &&
    name.trim() === addedName;
  useEffect(() => {
    if (finished) onClose();
  }, [finished, onClose]);

  return (
    <>
      <label className="re-add">
        <span className="re-add-label">Account name</span>
        <input
          className="rsi-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            save();
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return; // let the IME (e.g. pinyin) keep Enter
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          placeholder="Work"
          maxLength={60}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <RunnerSignIn runnerId={runnerId} engine={engine} accountName={name} autoStart={engine !== 'kimi'} onCancel={onClose} />
    </>
  );
}

/** The sign-in panel of an engine's own login on this machine: its row's, or — where the row heads
 *  its accounts — Default's, which is that login. While Default is removed from Orbit the engine's
 *  sign-in is its remaining accounts' (`removedDefault`), and this is the first of them not signed
 *  in. What the machine page's Needs Attention opens for an engine that is signed out. */
export function ownSignInPanel(runner: Runner, engine: LoginEngine): string {
  const health = engineHealthOf(runner, engine);
  const accounts = accountRowsOf(engine, health, runner.install);
  if (accounts.length === 0) return engine;
  if (!health?.removedDefault) return accountPanel(engine, 'default');
  return accountPanel(engine, (accounts.find((account) => account.auth !== 'yes') ?? accounts[0]).id);
}

/**
 * One machine's engines: a row each, with its accounts under it, and on every row what can be done
 * there — Sign in, Install, Add account, and each account's own menu — then DeepSeek Harness, which
 * signs nothing in and runs on the account's DeepSeek keys (DshRunnerStatus). A machine's card here
 * holds them under its head, and the machine's own page (RunnerDetailPage) under its Engines, as
 * `machinePage`.
 *
 * The sign-in panel open among the rows is the holder's to keep, so that something beside them can
 * open one: the machine page's Needs Attention does (ownSignInPanel). So are the groups of accounts
 * open under their rows (useOpenAccounts), which a sign-in opened from beside them has to open too.
 */
export function MachineEngines({
  runner,
  signIn,
  onSignIn,
  focusEngine,
  openAccounts,
  onFoldAccounts,
  machinePage = false,
  fleet,
}: {
  runner: Runner;
  /** The sign-in panel open on this machine, if any: an engine's, or one of its accounts'. */
  signIn: string | null;
  onSignIn: (panel: string | null) => void;
  /** The engine a deep link came here for: its row is marked and brought into view. */
  focusEngine?: InstallEngine | null;
  /** The groups of accounts the user opened, on every runner (accountsGroup). */
  openAccounts: string[];
  /** The engine whose group folded — a RowEngine, since a row is one, and only an engine that
   *  keeps accounts ever draws the toggle that calls this. */
  onFoldAccounts: (engine: RowEngine, open: boolean) => void;
  /** Laid out on the machine's own page, under the controls that update every CLI on it. */
  machinePage?: boolean;
  /** Every runner of the account, which decides whether Cursor CLI has a row at all
   *  (webShowsEngine); this machine alone without them. */
  fleet?: readonly CursorRunnerFacts[];
}) {
  const engines = runner.engines ?? null;
  if (!engines) {
    // Never three rows of "Unknown": this runner hasn't told us anything, which is a
    // different fact from "nothing is installed" and has a different fix.
    return (
      <>
        <div className="re-unreported">
          This runner hasn&apos;t reported its engines yet. Update it to the latest version — an
          older runner can&apos;t be signed in or installed from here.
        </div>
        <div className="re-row" data-engine="antigravity"><div className="re-id"><ProviderTile slug="antigravity" label={engineNameOf('antigravity')} size={28} /><div className="re-name">{engineNameOf('antigravity')}</div></div><Badge>Update runner</Badge><div className="re-login-note">Update this runner to sign in with Google.</div></div>
      </>
    );
  }
  const rows = rowEnginesOf(engines);
  const renderRow = (engine: RowEngine) => {
        const health = engineHealthOf(runner, engine);
        // A runner that can't run Cursor CLI at all says so on the engine's row, which no account under
        // it would change.
        const cursorBlocked = engine === 'cursor' && cursorRunnerState(runner) !== 'ready' && cursorRunnerState(runner) !== 'notInstalled';
        const accounts = cursorBlocked ? [] : accountRowsOf(engine, health, runner.install);
        // Read across the whole group, since a repeat is a fact about two of its rows.
        const repeats = duplicateAccounts(accounts);
        // The accounts under a row are an engine's own, and only an engine that keeps them has
        // any. OpenCode keeps none — its row is the install, and nothing else follows it.
        const accountEngine: AccountEngine | null = engineKeepsAccounts(engine) ? engine : null;
        // The same question the server asks when a session starts with no account picked — which a
        // group of one, as a removed Default can leave, answers with that one.
        // No session starts on any of them on a machine blocked for its Claude region.
        const blockedForRegion = engine === 'claude' && claudeRegionBlocked(runner);
        const next =
          accountEngine && accounts.length > 0 && !blockedForRegion
            ? accounts.length === 1
              ? accounts[0].id
              : accountToStartOn(accountEngine, accounts, withEnginePlanUsage(runner.planUsage, runner.engines), new Date())
            : null;
        const open = openAccounts.includes(accountsGroup(runner.id, engine));
        // A Default removed from Orbit ends its engine's group (RemovedDefault).
        const removed = accounts.length > 0 ? health?.removedDefault : undefined;
        // What a removal leaves: an account on its way out is as good as gone.
        const staying = accounts.filter((account) => !beingRemoved(runner, engine, account.id));
        return (
          <Fragment key={engine}>
            <EngineRow
              runner={runner}
              engine={engine}
              health={health}
              accounts={accounts}
              signIn={signIn}
              onSignIn={onSignIn}
              focused={engine === focusEngine}
              machinePage={machinePage}
              next={next}
              open={open}
              onFold={(opened) => onFoldAccounts(engine, opened)}
            />
            {accountEngine !== null && open && accounts.map((account, index) => (
              <AccountRow
                key={account.id}
                runner={runner}
                engine={accountEngine}
                account={account}
                defaultName={accountNameOf(accounts.find((entry) => entry.id === 'default') ?? { id: 'default', name: removed?.name })}
                defaultRemoved={!!removed}
                others={staying.filter((entry) => entry.id !== account.id).length}
                next={account.id === next}
                duplicateOf={repeats.get(account.id)}
                lastOfGroup={index === accounts.length - 1 && !removed}
                envKey={runsOnEnvKey(health, account)}
                regionBlocked={blockedForRegion}
                signIn={signIn}
                onSignIn={onSignIn}
              />
            ))}
            {accountEngine !== null && open && removed && <RemovedDefault runner={runner} engine={accountEngine} removed={removed} />}
          </Fragment>
        );
  };
  return (
    <>
      {rows.map(renderRow)}
      <DshRunnerStatus runner={runner} />
      {/* Cursor CLI last, after DeepSeek Harness (the board's Web 2 ②): on every machine once a runner
          of the account knows it, a machine that predates it included. */}
      {webShowsEngine('cursor', fleet ?? [runner]) && renderRow('cursor')}
    </>
  );
}
