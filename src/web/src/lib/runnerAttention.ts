import type { LoginEngine, ReportedEngine, RunnerRepoHealth } from '@orbit/shared';
import { codexAccountSnapshot, withEnginePlanUsage } from '@orbit/shared';
import type { Runner } from '../components/TasksSidePanel';
import { engineKeepsAccounts, runsOnEnvKey } from './engineAccounts';
import { planUsageRows, planUsageSnapshotForProvider, type PlanUsageDisplayRow } from './planUsage';
import { ago, ENGINE_CLI_NAME, updateNoteOf } from './runnerEngines';
import {
  ATTENTION_CANT_UPDATE_ITSELF,
  ATTENTION_CHECKOUT_DETAIL,
  ATTENTION_INSTALL_FOLDER_NOT_WRITABLE,
  ATTENTION_NEVER_CHECKED_IN,
  ATTENTION_OFFLINE_ONE_SESSION_WAITS,
  ATTENTION_OFFLINE_WAKE,
  ATTENTION_RUNNER_UPDATE_FAILED,
  ATTENTION_UPDATER_OFF,
  ATTENTION_UPDATES_TURN_ON,
  ATTENTION_UPDATES_TURNED_OFF,
  ATTENTION_UPDATE_DIDNT_GO_THROUGH,
  RUNNER_GIT_CHERRY_PICK,
  RUNNER_GIT_CONFLICT,
  RUNNER_GIT_MERGE,
  RUNNER_GIT_REBASE,
  RUNNER_GIT_REVERT,
  RUNNER_INSTALL_FOLDER,
  RUNNER_KEEP_FREE_10_GB,
  RUNNER_KEEP_FREE_20_GB,
  RUNNER_KEEP_FREE_50_GB,
  RUNNER_KEEP_FREE_OFF,
  RUNNER_LINE_SEPARATOR,
  RUNNER_LOGIN_CLAUDE,
  RUNNER_LOGIN_CODEX,
  RUNNER_LOGIN_KIMI,
  RUNNER_OFFLINE,
  RUNNER_QUOTA_ANNUAL,
  RUNNER_QUOTA_DAILY,
  RUNNER_QUOTA_FIVE_HOUR,
  RUNNER_QUOTA_MONTHLY,
  RUNNER_QUOTA_OTHER,
  RUNNER_QUOTA_WEEKLY,
  RUNNER_QUOTA_WEEKLY_OPUS,
  RUNNER_QUOTA_WEEKLY_SONNET,
  RUNNER_UNIT_DAY,
  RUNNER_UNIT_DAYS,
  RUNNER_UNIT_HOUR,
  RUNNER_UNIT_HOURS,
  RUNNER_UNIT_MINUTE,
  RUNNER_UNIT_MINUTES,
  RUNNER_UPGRADE_COMMAND,
  attentionCantUpdateItselfDetail,
  attentionCheckoutStuck,
  attentionDiskBelowReserve,
  attentionDiskFull,
  attentionDiskNoReserve,
  attentionEngineUpdateDetail,
  attentionEngineUpdateFailed,
  attentionInstallFolderNotWritableDetail,
  attentionOfflineFor,
  attentionOfflineSessionsWait,
  attentionQuotaDetail,
  attentionQuotaDetailMany,
  attentionQuotaShort,
  attentionQuotaTitle,
  attentionRunnerUpdateFailedDetail,
  attentionSignedOutDetail,
  attentionSignedOutDetailMany,
  attentionSignedOutShort,
  attentionSignedOutTitle,
  attentionUpdatesTurnedOffDetail,
  runnerGb,
  runnerNamesMore,
  runnerNamesTwo,
  runnerOfflineLastSeen,
  runnerVersionTag,
} from './runnerCopy';

/**
 * Does this machine need me? — the rule behind the Runners list's third line, a runner page's
 * Needs Attention cards and the web card, which all say the same sentence. An offline runner's row
 * has no third line: its second line already says it is offline, and offline is a state, not a
 * fault — what else it needs is on its page.
 *
 * This file and runnerAttention.cases.json are the one source of that rule: OrbitKit runs the same
 * case file against its Swift port, so a change to what is said, or when, starts in the case file.
 * Pure: the clock and the latest release are inputs, and nothing here fetches.
 *
 * An item is raised only when something depends on it. An engine's signed-out login or its
 * nearly spent quota is news only if a workspace on this machine last ran on that built-in engine:
 * a machine whose sessions all run on configured providers (deepseek, anthropic-2, …) never spends
 * that login, and flagging it would be a false alarm. An offline runner keeps only what is still
 * true and still actionable — that it is offline, and that it cannot replace its own binary; its
 * engine, quota, disk and checkout readings are as old as its last heartbeat.
 *
 * Times a reader sees in their own time zone (a quota reset, when it was last seen) never appear
 * formatted in `detail`: they ride in `params` as ISO strings for each client to format.
 */

/** A runner as GET /runners reports it — the fields these rules read. */
export type AttentionRunner = Pick<
  Runner,
  | 'name'
  | 'displayName'
  | 'hostname'
  | 'version'
  | 'online'
  | 'lastHeartbeatAt'
  | 'activeSessions'
  | 'runsAsRoot'
  | 'selfUpdate'
  | 'minFreeDiskMb'
  | 'engines'
  | 'planUsage'
>;

/** One of that runner's workspaces as GET /workspaces reports it. */
export interface AttentionWorkspace {
  id: string;
  name: string;
  /** The provider its last interactive session ran on: a built-in engine or a configured provider. */
  lastProvider?: string | null;
  workDir?: string | null;
  /** BIGINT columns, which the API sends as strings (main.ts BigInt.toJSON); numbers work too. */
  workDirFreeBytes?: string | number | null;
  workDirTotalBytes?: string | number | null;
  repoHealth?: RunnerRepoHealth | null;
}

export interface RunnerAttentionInput {
  runner: AttentionRunner;
  workspaces: AttentionWorkspace[];
  nowMs: number;
  /** latestRunnerVersion's answer; null when nothing says what the latest release is. */
  latestVersion: string | null;
}

/** Most severe first — the order items come out in. */
export type AttentionKind =
  | 'offline'
  | 'engineSignedOut'
  | 'checkoutStuck'
  | 'quotaNearLimit'
  | 'diskLow'
  | 'cannotSelfUpdate'
  | 'engineNotUpdating';

export type AttentionTone = 'bad' | 'warn' | 'idle';

export interface AttentionAction {
  /** updateRunner: POST /runners/:id/self-update — Update Runner Now. */
  kind: 'signIn' | 'repair' | 'setReserve' | 'copyCommand' | 'updateEngines' | 'updateRunner';
  engine?: ReportedEngine;
  /** repair: POST /workspaces/:id/repo-cleanup for any workspace in the stuck checkout. */
  workspaceId?: string;
  /** copyCommand: what goes on the clipboard. */
  command?: string;
}

export type AttentionParam = string | number | string[] | null;

export interface AttentionItem {
  kind: AttentionKind;
  tone: AttentionTone;
  /** The list's third line (two at most, joined) — and the web card's. */
  short: string;
  title: string;
  detail: string;
  action?: AttentionAction;
  /** The facts the sentence was made from, for the client to format or act on. ISO times:
   *  offline `lastSeenAt`, quota `resetsAt`. */
  params: Record<string, AttentionParam>;
}

/** A runner heartbeats every 30s; three missed beats is offline (the server's own window). */
export const RUNNER_OFFLINE_AFTER_MS = 90_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

const LOGIN_ENGINES: LoginEngine[] = ['claude', 'codex', 'kimi', 'antigravity'];
const LOGIN_NAME: Record<LoginEngine, string> = {
  claude: RUNNER_LOGIN_CLAUDE,
  codex: RUNNER_LOGIN_CODEX,
  kimi: RUNNER_LOGIN_KIMI,
  antigravity: 'Antigravity',
};
/** Every engine a runner reports on, in the order its page lists them. */
const REPORTED_ENGINES = Object.keys(ENGINE_CLI_NAME) as ReportedEngine[];

/** The RunnerRepoHealth states that block every merge into the checkout, and what it is stuck in.
 *  `dirty` is not one: a stray edit still lets merges fast-forward around it. */
const STUCK_IN = new Map<string, string>([
  ['unmerged', RUNNER_GIT_CONFLICT],
  ['merge', RUNNER_GIT_MERGE],
  ['rebase', RUNNER_GIT_REBASE],
  ['cherry-pick', RUNNER_GIT_CHERRY_PICK],
  ['revert', RUNNER_GIT_REVERT],
]);

/** Claude's windows by planUsageRows key. */
const CLAUDE_WINDOW = new Map<string, string>([
  ['fiveHour', RUNNER_QUOTA_FIVE_HOUR],
  ['sevenDay', RUNNER_QUOTA_WEEKLY],
  ['sevenDayOpus', RUNNER_QUOTA_WEEKLY_OPUS],
  ['sevenDaySonnet', RUNNER_QUOTA_WEEKLY_SONNET],
]);

/** Antigravity's buckets by the label planUsageRows gives the window agy names for each. */
const ANTIGRAVITY_WINDOW = new Map<string, string>([
  ['5-hour', RUNNER_QUOTA_FIVE_HOUR],
  ['Weekly', RUNNER_QUOTA_WEEKLY],
]);

/** Codex-shaped windows by the label planUsageRows derives from their length (a bucket other than
 *  Codex's own puts its name in front, hence endsWith). */
const CODEX_WINDOW: Array<[string, string]> = [
  ['5h limit', RUNNER_QUOTA_FIVE_HOUR],
  ['Daily limit', RUNNER_QUOTA_DAILY],
  ['Weekly limit', RUNNER_QUOTA_WEEKLY],
  ['Monthly limit', RUNNER_QUOTA_MONTHLY],
  ['Annual limit', RUNNER_QUOTA_ANNUAL],
];

/** Keep Free's choices: what PATCH /runners/:id sends as minFreeDiskMb, and what the picker says. */
export const KEEP_FREE_TIERS: ReadonlyArray<{ mb: number | null; label: string }> = [
  { mb: null, label: RUNNER_KEEP_FREE_OFF },
  { mb: 10240, label: RUNNER_KEEP_FREE_10_GB },
  { mb: 20480, label: RUNNER_KEEP_FREE_20_GB },
  { mb: 51200, label: RUNNER_KEEP_FREE_50_GB },
];

// MARK: version

function versionParts(version: string): number[] {
  return version
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .map((part) => (/^\d+$/.test(part) ? Number(part) : 0));
}

/**
 * Orders runner versions segment by segment as numbers — 0.1.197 is after 0.1.155, and 0.1.100
 * after 0.1.99 — the way the runner's own updater decides a release is newer (selfupdate.go
 * isNewer). A segment that isn't a number counts as 0 there too. Negative, zero or positive.
 */
export function compareRunnerVersions(a: string, b: string): number {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * The newest runner release anyone can see: what <origin>/dl/version.json publishes (null when it
 * could not be read) or what any of this account's runners reports running, whichever is newer.
 */
export function latestRunnerVersion(
  published: string | null | undefined,
  runners: ReadonlyArray<{ version?: string | null }>,
): string | null {
  let latest: string | null = null;
  for (const version of [published, ...runners.map((r) => r.version)]) {
    if (!version?.trim()) continue;
    if (latest === null || compareRunnerVersions(version, latest) > 0) latest = version.trim();
  }
  return latest;
}

// MARK: disk

export interface RunnerDisk {
  freeBytes: number;
  totalBytes: number;
  /** Rounded to a whole percent. */
  usedPercent: number;
}

function diskBytes(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/**
 * The runner's tightest filesystem. Its workspaces each report the filesystem their workDir sits
 * on, several usually the same one, so readings are de-duplicated by (free, total) and the one with
 * the least free space wins: it is the one that fills first. Null when no workspace has a reading.
 */
export function runnerDisk(workspaces: ReadonlyArray<AttentionWorkspace>): RunnerDisk | null {
  const seen = new Set<string>();
  let tightest: RunnerDisk | null = null;
  for (const workspace of workspaces) {
    const free = diskBytes(workspace.workDirFreeBytes);
    const total = diskBytes(workspace.workDirTotalBytes);
    if (free === null || total === null || total <= 0) continue;
    const key = `${free}/${total}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (tightest && tightest.freeBytes <= free) continue;
    const used = Math.round(((total - free) / total) * 100);
    tightest = { freeBytes: free, totalBytes: total, usedPercent: Math.min(100, Math.max(0, used)) };
  }
  return tightest;
}

/** Bytes in GB the way `df -h` counts them (1024³): whole from 10 GB up, one decimal below. */
export function formatDiskGb(bytes: number): string {
  const gb = bytes / GIB;
  if (gb >= 10) return String(Math.round(gb));
  const tenths = Math.round(gb * 10);
  return tenths >= 100 ? '10' : (tenths / 10).toFixed(1);
}

/** What Keep Free shows for a floor: a tier's own name, or a value set elsewhere as it is. */
export function keepFreeLabel(minFreeDiskMb: number | null | undefined): string {
  const mb = minFreeDiskMb != null && minFreeDiskMb > 0 ? minFreeDiskMb : null;
  const tier = KEEP_FREE_TIERS.find((t) => t.mb === mb);
  if (tier) return tier.label;
  return runnerGb(formatDiskGb((mb ?? 0) * MIB));
}

// MARK: offline

/** Offline once its heartbeat is more than 90s old, or when the server already says so. */
export function runnerIsOffline(runner: AttentionRunner, nowMs: number): boolean {
  if (runner.online === false) return true;
  const seen = runner.lastHeartbeatAt ? Date.parse(runner.lastHeartbeatAt) : NaN;
  if (Number.isNaN(seen)) return runner.online !== true;
  return nowMs - seen > RUNNER_OFFLINE_AFTER_MS;
}

function offlineFor(ms: number): string {
  if (ms >= DAY) {
    const days = Math.floor(ms / DAY);
    return attentionOfflineFor(days, days === 1 ? RUNNER_UNIT_DAY : RUNNER_UNIT_DAYS);
  }
  if (ms >= HOUR) {
    const hours = Math.floor(ms / HOUR);
    return attentionOfflineFor(hours, hours === 1 ? RUNNER_UNIT_HOUR : RUNNER_UNIT_HOURS);
  }
  const minutes = Math.max(1, Math.floor(ms / MINUTE));
  return attentionOfflineFor(minutes, minutes === 1 ? RUNNER_UNIT_MINUTE : RUNNER_UNIT_MINUTES);
}

function offlineItem(runner: AttentionRunner, nowMs: number): AttentionItem {
  const seen = runner.lastHeartbeatAt ? Date.parse(runner.lastHeartbeatAt) : NaN;
  const sessions = runner.activeSessions ?? 0;
  const waiting =
    sessions === 1
      ? ATTENTION_OFFLINE_ONE_SESSION_WAITS
      : sessions > 1
        ? attentionOfflineSessionsWait(sessions)
        : null;
  return {
    kind: 'offline',
    tone: 'idle',
    short: RUNNER_OFFLINE,
    title: Number.isNaN(seen) ? ATTENTION_NEVER_CHECKED_IN : offlineFor(Math.max(0, nowMs - seen)),
    detail: waiting ? `${waiting} ${ATTENTION_OFFLINE_WAKE}` : ATTENTION_OFFLINE_WAKE,
    params: { lastSeenAt: runner.lastHeartbeatAt ?? null, sessions },
  };
}

// MARK: the rules

/** `a`, `a and b`, `a and 2 more`. */
function namesPhrase(names: string[]): string {
  if (names.length === 2) return runnerNamesTwo(names[0], names[1]);
  if (names.length > 2) return runnerNamesMore(names[0], names.length - 1);
  return names[0] ?? '';
}

/** The workspaces whose sessions run on this built-in engine's login on this machine. */
function workspacesOn(workspaces: ReadonlyArray<AttentionWorkspace>, engine: LoginEngine): string[] {
  return workspaces.filter((w) => w.lastProvider === engine).map((w) => w.name);
}

function signedOutItems(
  runner: AttentionRunner,
  workspaces: ReadonlyArray<AttentionWorkspace>,
): AttentionItem[] {
  return LOGIN_ENGINES.flatMap((engine): AttentionItem[] => {
    const health = runner.engines?.find((e) => e.engine === engine);
    if (!health?.installed || health.auth !== 'no') return [];
    const users = workspacesOn(workspaces, engine);
    if (users.length === 0) return [];
    const name = LOGIN_NAME[engine];
    return [
      {
        kind: 'engineSignedOut',
        tone: 'bad',
        short: attentionSignedOutShort(name),
        title: attentionSignedOutTitle(name),
        detail:
          users.length === 1
            ? attentionSignedOutDetail(users[0], name)
            : attentionSignedOutDetailMany(namesPhrase(users), name),
        action: { kind: 'signIn', engine },
        params: { engine, workspaces: users },
      },
    ];
  });
}

/** One item per stuck checkout, however many workspaces work in it, named after the first. */
function checkoutItems(workspaces: ReadonlyArray<AttentionWorkspace>): AttentionItem[] {
  const byRoot = new Map<string, AttentionWorkspace[]>();
  for (const workspace of workspaces) {
    const health = workspace.repoHealth;
    if (!health || !STUCK_IN.has(health.state)) continue;
    const root = health.root || workspace.id;
    byRoot.set(root, [...(byRoot.get(root) ?? []), workspace]);
  }
  return [...byRoot.entries()].map(([root, stuck]): AttentionItem => {
    const [first] = stuck;
    const health = first.repoHealth as RunnerRepoHealth;
    const summary = attentionCheckoutStuck(first.name, STUCK_IN.get(health.state) as string);
    return {
      kind: 'checkoutStuck',
      tone: 'bad',
      short: summary,
      title: summary,
      detail: ATTENTION_CHECKOUT_DETAIL,
      action: { kind: 'repair', workspaceId: first.id },
      params: {
        workspaceId: first.id,
        workspaces: stuck.map((w) => w.name),
        root,
        state: health.state,
        branch: health.branch ?? null,
      },
    };
  });
}

function quotaWindow(row: PlanUsageDisplayRow): string {
  const claude = CLAUDE_WINDOW.get(row.key);
  if (claude) return claude;
  // An Antigravity bucket, by the window agy names for it.
  if (row.remaining) return ANTIGRAVITY_WINDOW.get(row.label) ?? RUNNER_QUOTA_OTHER;
  return CODEX_WINDOW.find(([label]) => row.label.endsWith(label))?.[1] ?? RUNNER_QUOTA_OTHER;
}

/** How much of a window is used, whichever way its row counts: Antigravity's say what is left. */
const usedPercent = (row: PlanUsageDisplayRow): number => (row.remaining ? 100 - row.percent : row.percent);

/** Warn only when every candidate account is near its limit. Show the fullest window of the
 *  account with the most room; an unread account cannot establish an engine-wide shortage — and
 *  neither can an Antigravity Default that runs on the machine's Gemini key (runsOnEnvKey), which
 *  has no quota to run out of. */
function quotaItems(
  runner: AttentionRunner,
  workspaces: ReadonlyArray<AttentionWorkspace>,
  nowMs: number,
): AttentionItem[] {
  return LOGIN_ENGINES.flatMap((engine): AttentionItem[] => {
    const users = workspacesOn(workspaces, engine);
    if (users.length === 0) return [];
    // Antigravity's quota travels with its engine's health, not in the heartbeat's planUsage.
    const usage = planUsageSnapshotForProvider(withEnginePlanUsage(runner.planUsage, runner.engines), engine);
    const health = runner.engines?.find((e) => e.engine === engine);
    const accounts = health?.accounts;
    const snapshots =
      engineKeepsAccounts(engine) && accounts?.length
        ? accounts
            .filter((account) => account.auth !== 'no' || runsOnEnvKey(health, account))
            .map((account) => (runsOnEnvKey(health, account) ? undefined : usage && codexAccountSnapshot(usage, account.id)))
        : [usage];
    let fullest: PlanUsageDisplayRow | undefined;
    for (const snapshot of snapshots) {
      const near = snapshot
        ? planUsageRows(snapshot).filter(
            (row) => row.nearLimit && !(Date.parse(row.window.resetsAt ?? '') <= nowMs),
          )
        : [];
      if (near.length === 0) return [];
      const accountFullest = near.reduce((top, row) => (usedPercent(row) > usedPercent(top) ? row : top));
      if (!fullest || usedPercent(accountFullest) < usedPercent(fullest)) fullest = accountFullest;
    }
    if (!fullest) return [];
    const name = LOGIN_NAME[engine];
    const window = quotaWindow(fullest);
    const percent = usedPercent(fullest);
    return [
      {
        kind: 'quotaNearLimit',
        tone: 'warn',
        short: attentionQuotaShort(name, window, percent),
        title: attentionQuotaTitle(name, window, percent),
        detail:
          users.length === 1
            ? attentionQuotaDetail(users[0], name)
            : attentionQuotaDetailMany(namesPhrase(users), name),
        params: {
          engine,
          window,
          percent,
          resetsAt: fullest.window.resetsAt ?? null,
          workspaces: users,
        },
      },
    ];
  });
}

/**
 * Below Keep Free when one is set — the floor the auto-run sweep stops sending task runs at
 * (tasks.service diskBelowFloor, MB = 1024²). With none set, under 10% of the disk free.
 */
function diskItem(
  runner: AttentionRunner,
  workspaces: ReadonlyArray<AttentionWorkspace>,
): AttentionItem | null {
  const disk = runnerDisk(workspaces);
  if (!disk) return null;
  const reserveMb = runner.minFreeDiskMb != null && runner.minFreeDiskMb > 0 ? runner.minFreeDiskMb : null;
  const low =
    reserveMb !== null
      ? disk.freeBytes < Math.floor(reserveMb) * MIB
      : disk.freeBytes * 10 < disk.totalBytes;
  if (!low) return null;
  const free = formatDiskGb(disk.freeBytes);
  const total = formatDiskGb(disk.totalBytes);
  return {
    kind: 'diskLow',
    tone: 'warn',
    short: attentionDiskFull(disk.usedPercent),
    title: attentionDiskFull(disk.usedPercent),
    detail:
      reserveMb !== null
        ? attentionDiskBelowReserve(free, total, formatDiskGb(reserveMb * MIB))
        : attentionDiskNoReserve(free, total),
    action: { kind: 'setReserve' },
    params: { ...disk, reserveMb },
  };
}

/** The runner's own words as the start of a sentence: capitalized, with no closing full stop. */
function runnerSaid(words: string | undefined, otherwise: string): string {
  const said = words?.trim().replace(/\.+$/, '') ?? '';
  return said ? said.charAt(0).toUpperCase() + said.slice(1) : otherwise;
}

/**
 * Behind the latest release, and not catching up by itself.
 *
 * A runner that reports where its updates stand (`selfUpdate`) is taken at its word:
 * - `dirNotWritable`: the user it runs as can't write its install folder. `sudo orbit upgrade` there
 *   moves the install somewhere it can, once.
 * - `disabledByEnv`: its updater is off, and the reason says by what. Only ORBIT_NO_SELFUPDATE is a
 *   switch to turn back; a development build or a platform with no release has none.
 * - `failed`: the check or the install failed, in its own words. Update Runner Now tries again, so
 *   this is raised only while it is online, like an engine's failed update.
 * - `enabled`, `waitingForIdle`, `heldByRollout`: it catches up by itself — no item; About says
 *   which. Nor for a state this client doesn't know: there is nothing it could prescribe.
 *
 * A runner too old to report it is judged by runsAsRoot, as before there was a report. Root is what
 * lets the updater replace the binary in a root-owned install directory; a regular user stays on
 * its version until someone runs `sudo orbit upgrade` there. Unknown (null) is not flagged, and a
 * root runner that is behind installs the release itself when no turn is running.
 */
function cannotSelfUpdateItem(
  runner: AttentionRunner,
  latestVersion: string | null,
  offline: boolean,
): AttentionItem | null {
  const version = runner.version?.trim();
  if (!version || !latestVersion) return null;
  if (compareRunnerVersions(version, latestVersion) >= 0) return null;
  const report = runner.selfUpdate;
  if (!report) {
    if (runner.runsAsRoot !== false) return null;
    return {
      kind: 'cannotSelfUpdate',
      tone: 'warn',
      short: ATTENTION_CANT_UPDATE_ITSELF,
      title: ATTENTION_CANT_UPDATE_ITSELF,
      detail: attentionCantUpdateItselfDetail(version, latestVersion, RUNNER_UPGRADE_COMMAND),
      action: { kind: 'copyCommand', command: RUNNER_UPGRADE_COMMAND },
      params: { version, latest: latestVersion },
    };
  }
  const reported = { version, latest: latestVersion, state: report.state, reason: report.reason ?? null };
  switch (report.state) {
    case 'dirNotWritable':
      return {
        kind: 'cannotSelfUpdate',
        tone: 'warn',
        short: ATTENTION_INSTALL_FOLDER_NOT_WRITABLE,
        title: ATTENTION_INSTALL_FOLDER_NOT_WRITABLE,
        detail: attentionInstallFolderNotWritableDetail(
          report.installDir ?? RUNNER_INSTALL_FOLDER,
          version,
          latestVersion,
          RUNNER_UPGRADE_COMMAND,
        ),
        action: { kind: 'copyCommand', command: RUNNER_UPGRADE_COMMAND },
        params: { version, latest: latestVersion, state: report.state, installDir: report.installDir ?? null },
      };
    case 'disabledByEnv': {
      const why = runnerSaid(report.reason, ATTENTION_UPDATER_OFF);
      const detail = attentionUpdatesTurnedOffDetail(why, version, latestVersion);
      return {
        kind: 'cannotSelfUpdate',
        tone: 'warn',
        short: ATTENTION_UPDATES_TURNED_OFF,
        title: ATTENTION_UPDATES_TURNED_OFF,
        detail: report.reason?.includes('ORBIT_NO_SELFUPDATE') ? `${detail} ${ATTENTION_UPDATES_TURN_ON}` : detail,
        params: reported,
      };
    }
    case 'failed':
      if (offline) return null;
      return {
        kind: 'cannotSelfUpdate',
        tone: 'warn',
        short: ATTENTION_RUNNER_UPDATE_FAILED,
        title: ATTENTION_RUNNER_UPDATE_FAILED,
        detail: attentionRunnerUpdateFailedDetail(
          runnerSaid(report.reason, ATTENTION_UPDATE_DIDNT_GO_THROUGH),
          version,
          latestVersion,
        ),
        action: { kind: 'updateRunner' },
        params: reported,
      };
    default:
      return null;
  }
}

/** An installed CLI whose update note is a warning (runnerEngines' updateNoteOf). */
function engineUpdateItems(runner: AttentionRunner, nowMs: number): AttentionItem[] {
  return REPORTED_ENGINES.flatMap((engine): AttentionItem[] => {
    const health = runner.engines?.find((e) => e.engine === engine);
    if (!health?.installed) return [];
    const note = updateNoteOf(health.update, nowMs);
    if (note?.tone !== 'warn') return [];
    const summary = attentionEngineUpdateFailed(ENGINE_CLI_NAME[engine]);
    return [
      {
        kind: 'engineNotUpdating',
        tone: 'warn',
        short: summary,
        title: summary,
        detail: attentionEngineUpdateDetail(note.text.charAt(0).toUpperCase() + note.text.slice(1)),
        action: { kind: 'updateEngines', engine },
        params: { engine, note: note.text, latest: health.update?.latest ?? null },
      },
    ];
  });
}

/** Everything about this runner that needs a person, most severe first. */
export function runnerAttention(input: RunnerAttentionInput): AttentionItem[] {
  const { runner, workspaces, nowMs, latestVersion } = input;
  const offline = runnerIsOffline(runner, nowMs);
  const items: AttentionItem[] = [];
  if (offline) {
    items.push(offlineItem(runner, nowMs));
  } else {
    items.push(...signedOutItems(runner, workspaces), ...checkoutItems(workspaces));
    items.push(...quotaItems(runner, workspaces, nowMs));
    const disk = diskItem(runner, workspaces);
    if (disk) items.push(disk);
  }
  const cannotUpdate = cannotSelfUpdateItem(runner, latestVersion, offline);
  if (cannotUpdate) items.push(cannotUpdate);
  if (!offline) items.push(...engineUpdateItems(runner, nowMs));
  return items;
}

/**
 * Whether Update Runner Now can do anything here. Only a runner that reports its updates takes the
 * request (the server refuses an older one), only while it is online, and not one whose updater is
 * off or can't write its install folder: a check now would find what the last one did.
 */
export function runnerCanUpdateNow(runner: AttentionRunner, nowMs: number): boolean {
  const state = runner.selfUpdate?.state;
  if (!state || state === 'disabledByEnv' || state === 'dirNotWritable') return false;
  return !runnerIsOffline(runner, nowMs);
}

// MARK: the list row

/** The list's third line: the first two items' short lines. Null for an offline runner, whatever
 *  else it needs — the second line already says it is offline, and that is a state, not a fault —
 *  and null when nothing needs anyone. */
export function listAttentionLine(items: ReadonlyArray<AttentionItem>): string | null {
  if (items.some((item) => item.kind === 'offline')) return null;
  const shorts = items.slice(0, 2).map((item) => item.short);
  return shorts.length ? shorts.join(RUNNER_LINE_SEPARATOR) : null;
}

/**
 * The list's second line. Online: `<hostname> · v<version>`, leaving out a hostname that is empty
 * or the same as the name shown above it. Offline: `Offline · last seen 14d ago · v<version>`.
 */
export function runnerListSubtitle(runner: AttentionRunner, nowMs: number): string {
  const version = runner.version?.trim() ? runnerVersionTag(runner.version.trim()) : null;
  if (runnerIsOffline(runner, nowMs)) {
    const status = runner.lastHeartbeatAt
      ? runnerOfflineLastSeen(ago(runner.lastHeartbeatAt, nowMs))
      : RUNNER_OFFLINE;
    return [status, version].filter(Boolean).join(RUNNER_LINE_SEPARATOR);
  }
  const hostname = runner.hostname?.trim();
  const shownName = runner.displayName?.trim() || runner.name;
  const host = hostname && hostname !== shownName ? hostname : null;
  return [host, version].filter(Boolean).join(RUNNER_LINE_SEPARATOR);
}
