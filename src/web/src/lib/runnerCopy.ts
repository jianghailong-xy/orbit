/**
 * Every English sentence the Runners list and a runner's page say, in one place.
 *
 * The web and the native clients (OrbitKit's RunnerPageCopy, shared by iOS and macOS) have to say
 * the same words about the same machine — the list's third line, the Needs Attention card and the
 * web card are one sentence. Swift cannot import this file, so OrbitKit's parity test reads it as
 * text instead. That fixes its shape:
 *
 * - one named `export const X = '…'` per fixed sentence (a long one may wrap as `'…' + '…'`);
 * - one `export function` per sentence with values in it, whose body is a single template literal
 *   with nothing but `${parameter}` interpolations — the parity test compares the whole template.
 *
 * Wording comes from the owner-approved mocks (system.png, ios-list.png, ios-detail.png, web.png).
 * Times that must be formatted in the reader's time zone never appear pre-formatted here: they are
 * parameters, and each client formats them itself. Which item says what, and when, lives in
 * runnerAttention.ts.
 */

// MARK: status and the list

export const RUNNER_ONLINE = 'Online';
export const RUNNER_OFFLINE = 'Offline';
/** Joins the parts of one line: `vmi3129740 · v0.1.197`, `Claude weekly limit 98% · Disk 95% full`. */
export const RUNNER_LINE_SEPARATOR = ' · ';

/** `when` is `14d ago` in the list and a local date and time in the page header. */
export function runnerOfflineLastSeen(when: string): string {
  return `Offline · last seen ${when}`;
}

export function runnerVersionTag(version: string): string {
  return `v${version}`;
}

/** The page header's second line: `Online · 4 of 12 running`. */
export function runnerRunningOf(active: number, max: number): string {
  return `${active} of ${max} running`;
}

/** The list row's slot count beside its bar. */
export function runnerSlots(active: number, max: number): string {
  return `${active}/${max}`;
}

export const RUNNER_ADD = 'Add Runner';
export const RUNNER_ADD_FOOTER =
  'Run one command on the new machine — it installs Orbit, then asks you to confirm it’s yours.';

// MARK: section titles

export const RUNNER_NEEDS_ATTENTION = 'Needs Attention';
export const RUNNER_CAPACITY = 'Capacity';
export const RUNNER_ENGINES = 'Engines';
export const RUNNER_WORKSPACES = 'Workspaces';
export const RUNNER_ABOUT = 'About This Runner';

// MARK: Capacity

export const RUNNER_MAX_CONCURRENT = 'Max Concurrent';
export const RUNNER_DISK = 'Disk';
export const RUNNER_KEEP_FREE = 'Keep Free';
export const RUNNER_KEEP_FREE_OFF = 'Off';
export const RUNNER_KEEP_FREE_10_GB = '10 GB';
export const RUNNER_KEEP_FREE_20_GB = '20 GB';
export const RUNNER_KEEP_FREE_50_GB = '50 GB';
export const RUNNER_CAPACITY_FOOTER =
  'Max Concurrent applies to the next session it picks up — no restart. Below Keep Free, task ' +
  'runs stop being sent here and finished worktrees are cleaned up sooner.';

/** An amount of disk, already formatted by runnerAttention's formatDiskGb (`9.4`, `197`). */
export function runnerGb(amount: string): string {
  return `${amount} GB`;
}

export function runnerDiskUsed(used: string, total: string): string {
  return `${used} of ${total} GB used`;
}

// MARK: Engines

export const RUNNER_ENGINE_SIGNED_IN = 'Signed in';
export const RUNNER_ENGINE_SIGNED_OUT = 'Signed out';
export const RUNNER_ENGINE_NOT_INSTALLED = 'Not installed';
export const RUNNER_ENGINE_UP_TO_DATE = 'up to date';
export const RUNNER_ENGINE_NO_QUOTA = 'No quota reported';
export const RUNNER_SIGN_IN = 'Sign In';
export const RUNNER_UPDATE_ENGINES_NOW = 'Update Engines Now';
export const RUNNER_REFRESH_MODEL_LISTS = 'Refresh Model Lists';
export const RUNNER_ENGINES_FOOTER =
  'Orbit keeps these CLIs updated every 30 min. Sign-ins live on this machine — a session spends ' +
  'that subscription, nothing to paste.';
export const RUNNER_ENGINES_OFFLINE_FOOTER = 'Signing in and updating need the runner online.';

/** Under a signed-in account whose login lapses within three days — when Claude Code itself starts
 *  warning ("Your login expires in 3 days · run /login to renew") — with the button that signs it in
 *  again before it does. */
export const RUNNER_ENGINE_RENEW = 'Renew';
export function runnerEngineLoginExpires(count: number, unit: string): string {
  return `Login expires in ${count} ${unit}`;
}
/** Under a signed-out account: what its being signed out costs. */
export const RUNNER_ENGINE_ACCOUNT_SIGNED_OUT_NOTE = 'Sessions can’t use this account until you sign in again.';
/** The same, for an engine's only account on that machine. */
export function runnerEngineSignedOutAlone(engine: string): string {
  return `Sessions on this runner can’t use ${engine} until you sign in again.`;
}

export function runnerEnginesChecked(when: string): string {
  return `Checked ${when}`;
}

/** The Engines header of an offline runner: what it said last, and when. */
export function runnerEnginesReported(when: string): string {
  return `Reported ${when}`;
}

export function runnerEngineAccountsSignedIn(count: number): string {
  return `${count} accounts signed in`;
}

/** Above an engine's quota while it has several accounts: the one a new session starts on. */
export function runnerEngineNext(account: string): string {
  return `Next: ${account}`;
}

export function runnerEngineUpdateFailed(version: string, when: string): string {
  return `Update to ${version} failed ${when}`;
}

// MARK: Workspaces

export const RUNNER_WORKSPACE_WORKTREES = 'Worktrees';
export const RUNNER_WORKSPACES_FOOTER =
  'Tap a workspace to open its sessions. Add or change workspaces on the web.';

export function runnerWorkspaceRunning(count: number): string {
  return `${count} running`;
}

// MARK: About This Runner

export const RUNNER_ABOUT_NAME = 'Name';
export const RUNNER_ABOUT_HOSTNAME = 'Hostname';
export const RUNNER_ABOUT_VERSION = 'Version';
export const RUNNER_ABOUT_RUNS_AS = 'Runs As';
export const RUNNER_ABOUT_REPOS_FOLDER = 'Repos Folder';
export const RUNNER_ABOUT_LAST_CHECK_IN = 'Last Check-in';
export const RUNNER_ABOUT_REGISTERED = 'Registered';
/** The last update the runner installed into itself: when, and from which version to which. */
export const RUNNER_ABOUT_LAST_UPDATE = 'Last Update';
export const RUNNER_VERSION_LATEST = 'Latest';
/** Behind the latest release on a runner that replaces itself: it waits for an idle moment. */
export const RUNNER_VERSION_INSTALLS_WHEN_IDLE = 'installs when no turn is running';
/** Behind the latest release because its staged rollout hasn't reached this runner. */
export const RUNNER_VERSION_NOT_ROLLED_OUT = 'not rolled out to it yet';
export const RUNNER_RUNS_AS_ROOT = 'root';
export const RUNNER_RUNS_AS_REGULAR_USER = 'regular user';
export const RUNNER_ROOT_NO_BYPASS = 'Runs as root, so sessions here can’t use Bypass permissions.';

/** Last Update's versions: `0.1.217 → 0.1.218`. */
export function runnerUpdatedFromTo(from: string, to: string): string {
  return `${from} → ${to}`;
}

// MARK: Rotate Token / Remove Runner

export const RUNNER_ROTATE_TOKEN = 'Rotate Token…';
export const RUNNER_ROTATE_TOKEN_FOOTER =
  'Replaces this runner’s credential. It stays offline until the new token is in its ' +
  '~/.orbit/config.json and it restarts.';
export const RUNNER_REMOVE = 'Remove Runner';
export const RUNNER_REMOVE_FOOTER =
  'Removes it and its workspaces from your account. Register the machine again to add it back.';

// MARK: the Add Runner sheet

export const RUNNER_ADD_LEAD =
  'Run this on the machine you want to add. It installs Orbit, then asks you to confirm the ' +
  'machine is yours.';
export const RUNNER_PLATFORM_MACOS = 'macOS';
export const RUNNER_PLATFORM_LINUX = 'Linux';
export const RUNNER_PLATFORM_WINDOWS = 'Windows';
export const RUNNER_COPY = 'Copy';
export const RUNNER_SHARE = 'Share';
export const RUNNER_WAITING_FOR_NEW = 'Waiting for a new runner to check in…';
export const RUNNER_NO_BROWSER = 'No browser on that machine?';
export const RUNNER_DEVICE_CODE = 'Code';
export const RUNNER_DEVICE_CODE_PLACEHOLDER = 'ABCD-1234';
export const RUNNER_DEVICE_CODE_FOOTER =
  'orbit register prints a code there. Enter it to approve the machine from this phone — its ' +
  'name and hostname show before you confirm.';
export const RUNNER_APPROVE = 'Approve';

/** macOS and Linux: the same command as the web's RunnerRegisterGuide. */
export function runnerInstallCommandUnix(origin: string): string {
  return `curl -fsSL ${origin}/install.sh | bash`;
}

export function runnerInstallCommandWindows(origin: string): string {
  return `irm ${origin}/install.ps1 | iex`;
}

// MARK: Needs Attention — words shared by several items

/** The login a built-in engine runs on, as a sign-in or a quota sentence names it. Update items
 *  name the CLI instead (runnerEngines' ENGINE_CLI_NAME: `Claude Code update failed`). */
export const RUNNER_LOGIN_CLAUDE = 'Claude';
export const RUNNER_LOGIN_CODEX = 'Codex';
export const RUNNER_LOGIN_KIMI = 'Kimi';

/** Two workspace names in one sentence. */
export function runnerNamesTwo(first: string, second: string): string {
  return `${first} and ${second}`;
}

/** Three or more: the first by name, the rest counted. */
export function runnerNamesMore(first: string, others: number): string {
  return `${first} and ${others} more`;
}

// MARK: Needs Attention — offline

export const RUNNER_UNIT_MINUTE = 'minute';
export const RUNNER_UNIT_MINUTES = 'minutes';
export const RUNNER_UNIT_HOUR = 'hour';
export const RUNNER_UNIT_HOURS = 'hours';
export const RUNNER_UNIT_DAY = 'day';
export const RUNNER_UNIT_DAYS = 'days';
export const ATTENTION_NEVER_CHECKED_IN = 'Never checked in';
export const ATTENTION_OFFLINE_ONE_SESSION_WAITS = 'Its 1 session waits until it checks in again.';
export const ATTENTION_OFFLINE_WAKE =
  'Start the runner on that machine — it reconnects within 30 seconds.';

/** `Offline for 14 days`; `unit` is one of the RUNNER_UNIT_* words. */
export function attentionOfflineFor(count: number, unit: string): string {
  return `Offline for ${count} ${unit}`;
}

export function attentionOfflineSessionsWait(count: number): string {
  return `Its ${count} sessions wait until it checks in again.`;
}

// MARK: Needs Attention — an engine this machine's workspaces use is signed out

export function attentionSignedOutShort(engine: string): string {
  return `${engine} signed out`;
}

export function attentionSignedOutTitle(engine: string): string {
  return `${engine} is signed out`;
}

export function attentionSignedOutDetail(workspace: string, engine: string): string {
  return `${workspace} runs on this machine’s ${engine} login — its sessions fail until you sign in again.`;
}

export function attentionSignedOutDetailMany(workspaces: string, engine: string): string {
  return `${workspaces} run on this machine’s ${engine} login — their sessions fail until you sign in again.`;
}

// MARK: Needs Attention — a shared checkout is stuck mid-operation

export const RUNNER_REPAIR = 'Repair';
/** What the checkout is stuck in, by RunnerRepoHealth.state. */
export const RUNNER_GIT_MERGE = 'a merge';
export const RUNNER_GIT_REBASE = 'a rebase';
export const RUNNER_GIT_CHERRY_PICK = 'a cherry-pick';
export const RUNNER_GIT_REVERT = 'a revert';
/** `unmerged`: conflicted files with no operation in progress. */
export const RUNNER_GIT_CONFLICT = 'a conflict';
export const ATTENTION_CHECKOUT_DETAIL =
  'Nothing can merge into it until it’s cleaned up. Repair saves everything it holds to an ' +
  'orbit/rescue-… branch, then returns it to its last commit.';

/** Both the list's short line and the card's title. */
export function attentionCheckoutStuck(workspace: string, operation: string): string {
  return `${workspace} checkout stuck in ${operation}`;
}

// MARK: Needs Attention — a quota window a workspace here spends is nearly used up

/** The window, as the short line and title name it. */
export const RUNNER_QUOTA_FIVE_HOUR = '5-hour limit';
export const RUNNER_QUOTA_DAILY = 'daily limit';
export const RUNNER_QUOTA_WEEKLY = 'weekly limit';
export const RUNNER_QUOTA_WEEKLY_OPUS = 'weekly Opus limit';
export const RUNNER_QUOTA_WEEKLY_SONNET = 'weekly Sonnet limit';
export const RUNNER_QUOTA_MONTHLY = 'monthly limit';
export const RUNNER_QUOTA_ANNUAL = 'annual limit';
/** A window whose length nobody reported. */
export const RUNNER_QUOTA_OTHER = 'usage limit';

export function attentionQuotaShort(engine: string, window: string, percent: number): string {
  return `${engine} ${window} ${percent}%`;
}

export function attentionQuotaTitle(engine: string, window: string, percent: number): string {
  return `${engine} ${window} at ${percent}%`;
}

/** Put in front of the detail by the client, with the reset time formatted in its time zone. */
export function attentionQuotaResets(when: string): string {
  return `Resets ${when}.`;
}

export function attentionQuotaDetail(workspace: string, engine: string): string {
  return `${workspace} runs on this machine’s ${engine} login — its sessions pause if the limit runs out.`;
}

export function attentionQuotaDetailMany(workspaces: string, engine: string): string {
  return `${workspaces} run on this machine’s ${engine} login — their sessions pause if the limit runs out.`;
}

// MARK: Needs Attention — the disk is running out

export const RUNNER_SET_A_RESERVE = 'Set a Reserve…';

/** Both the list's short line and the card's title. */
export function attentionDiskFull(percent: number): string {
  return `Disk ${percent}% full`;
}

export function attentionDiskNoReserve(free: string, total: string): string {
  return `${free} GB free of ${total} GB. No reserve is set, so task runs keep landing here until the disk fills.`;
}

export function attentionDiskBelowReserve(free: string, total: string, reserve: string): string {
  return `${free} GB free of ${total} GB, under the ${reserve} GB it keeps free — task runs stop being sent here until space frees up.`;
}

// MARK: Needs Attention — the runner can't replace its own binary

export const ATTENTION_CANT_UPDATE_ITSELF = 'Can’t update itself';
export const RUNNER_COPY_COMMAND = 'Copy Command';
export const RUNNER_UPGRADE_COMMAND = 'sudo orbit upgrade';

export function attentionCantUpdateItselfDetail(version: string, latest: string, command: string): string {
  return `It runs as a regular user, so it can’t replace its own binary — still on ${version}, latest is ${latest}. On that machine, run ${command}.`;
}

// MARK: Needs Attention — the runner reports why it isn't updating itself

/** dirNotWritable: both the list's short line and the card's title. */
export const ATTENTION_INSTALL_FOLDER_NOT_WRITABLE = 'Install folder isn’t writable';
/** The folder, when the runner didn't say which. */
export const RUNNER_INSTALL_FOLDER = 'its install folder';
/** disabledByEnv: both the list's short line and the card's title. */
export const ATTENTION_UPDATES_TURNED_OFF = 'Updates are turned off';
/** disabledByEnv with no reason given. */
export const ATTENTION_UPDATER_OFF = 'Its updater is switched off';
/** After a disabledByEnv reason that names ORBIT_NO_SELFUPDATE, the one reason that is a switch. */
export const ATTENTION_UPDATES_TURN_ON =
  'To turn them back on, remove ORBIT_NO_SELFUPDATE from the runner’s environment and restart it — ' +
  'on a Mac, opening the latest Orbit app does this.';
/** failed: both the list's short line and the card's title. */
export const ATTENTION_RUNNER_UPDATE_FAILED = 'Runner update failed';
/** failed with no reason given. */
export const ATTENTION_UPDATE_DIDNT_GO_THROUGH = 'Its last update didn’t go through';
export const RUNNER_UPDATE_RUNNER_NOW = 'Update Runner Now';
export const RUNNER_UPDATE_RUNNER_REQUESTED =
  'Checking for a runner release now — a new one installs once no turn is running.';

export function attentionInstallFolderNotWritableDetail(
  folder: string,
  version: string,
  latest: string,
  command: string,
): string {
  return `It can’t write to ${folder}, so it can’t replace its own binary — still on ${version}, latest is ${latest}. On that machine, run ${command} once; after that it updates itself.`;
}

/** `reason` is the runner's own, capitalized: `ORBIT_NO_SELFUPDATE is set`, `Development build`. */
export function attentionUpdatesTurnedOffDetail(reason: string, version: string, latest: string): string {
  return `${reason}, so it doesn’t update itself — still on ${version}, latest is ${latest}.`;
}

/** `reason` is the runner's own words, capitalized. */
export function attentionRunnerUpdateFailedDetail(reason: string, version: string, latest: string): string {
  return `${reason}. Still on ${version}, latest is ${latest}. It retries every 10 min — Update Runner Now tries again right away.`;
}

// MARK: Needs Attention — an engine CLI has stopped being kept current

/** Both the list's short line and the card's title; `engine` is the CLI's own name. */
export function attentionEngineUpdateFailed(engine: string): string {
  return `${engine} update failed`;
}

/** `note` is runnerEngines' updateNoteOf text, capitalized: `18d behind 2.1.270`. */
export function attentionEngineUpdateDetail(note: string): string {
  return `${note}. Orbit retries every 30 min — Update Engines Now tries again right away.`;
}
