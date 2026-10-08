import Foundation

/// Every sentence shared by the runner list and runner page. Names intentionally match
/// `src/web/src/lib/runnerCopy.ts`; `RunnerPageCopyParityTests` holds every declaration to it.
public enum RunnerPageCopy {
    public static let RUNNER_ONLINE = "Online"
    public static let RUNNER_OFFLINE = "Offline"
    public static let RUNNER_LINE_SEPARATOR = " · "

    public static func runnerOfflineLastSeen(when: String) -> String { "Offline · last seen \(when)" }
    public static func runnerVersionTag(version: String) -> String { "v\(version)" }
    public static func runnerRunningOf(active: Int, max: Int) -> String { "\(active) of \(max) running" }
    public static func runnerSlots(active: Int, max: Int) -> String { "\(active)/\(max)" }

    public static let RUNNER_ADD = "Add Runner"
    public static let RUNNER_ADD_FOOTER =
        "Run one command on the new machine — it installs Orbit, then asks you to confirm it’s yours."

    public static let RUNNER_NEEDS_ATTENTION = "Needs Attention"
    public static let RUNNER_CAPACITY = "Capacity"
    public static let RUNNER_ENGINES = "Engines"
    public static let RUNNER_WORKSPACES = "Workspaces"
    public static let RUNNER_ABOUT = "About This Runner"

    public static let RUNNER_MAX_CONCURRENT = "Max Concurrent"
    public static let RUNNER_DISK = "Disk"
    public static let RUNNER_KEEP_FREE = "Keep Free"
    public static let RUNNER_KEEP_FREE_OFF = "Off"
    public static let RUNNER_KEEP_FREE_10_GB = "10 GB"
    public static let RUNNER_KEEP_FREE_20_GB = "20 GB"
    public static let RUNNER_KEEP_FREE_50_GB = "50 GB"
    public static let RUNNER_CAPACITY_FOOTER =
        "Max Concurrent applies to the next session it picks up — no restart. Below Keep Free, task "
        + "runs stop being sent here and finished worktrees are cleaned up sooner."

    public static func runnerGb(amount: String) -> String { "\(amount) GB" }
    public static func runnerDiskUsed(used: String, total: String) -> String {
        "\(used) of \(total) GB used"
    }

    public static let RUNNER_ENGINE_SIGNED_IN = "Signed in"
    public static let RUNNER_ENGINE_SIGNED_OUT = "Signed out"
    public static let RUNNER_ENGINE_NOT_INSTALLED = "Not installed"
    public static let RUNNER_ENGINE_UP_TO_DATE = "up to date"
    public static let RUNNER_ENGINE_NO_QUOTA = "No quota reported"
    public static let RUNNER_SIGN_IN = "Sign In"
    public static let RUNNER_UPDATE_ENGINES_NOW = "Update Engines Now"
    public static let RUNNER_REFRESH_MODEL_LISTS = "Refresh Model Lists"
    public static let RUNNER_ENGINES_FOOTER =
        "Orbit keeps these CLIs updated every 30 min. Sign-ins live on this machine — a session spends "
        + "that subscription, nothing to paste."
    public static let RUNNER_ENGINES_OFFLINE_FOOTER = "Signing in and updating need the runner online."

    public static let RUNNER_ENGINE_RENEW = "Renew"
    public static func runnerEngineLoginExpires(count: Int, unit: String) -> String {
        "Login expires in \(count) \(unit)"
    }
    public static let RUNNER_ENGINE_ACCOUNT_SIGNED_OUT_NOTE = "Sessions can’t use this account until you sign in again."
    public static func runnerEngineSignedOutAlone(engine: String) -> String {
        "Sessions on this runner can’t use \(engine) until you sign in again."
    }

    public static func runnerEnginesChecked(when: String) -> String { "Checked \(when)" }
    public static func runnerEnginesReported(when: String) -> String { "Reported \(when)" }
    public static func runnerEngineAccountsSignedIn(count: Int) -> String { "\(count) accounts signed in" }
    public static func runnerEngineNext(account: String) -> String { "Next: \(account)" }
    public static func runnerEngineUpdateFailed(version: String, when: String) -> String {
        "Update to \(version) failed \(when)"
    }

    public static let RUNNER_WORKSPACE_WORKTREES = "Worktrees"
    public static let RUNNER_WORKSPACES_FOOTER =
        "Tap a workspace to open its sessions. Add or change workspaces on the web."
    public static func runnerWorkspaceRunning(count: Int) -> String { "\(count) running" }

    public static let RUNNER_ABOUT_NAME = "Name"
    public static let RUNNER_ABOUT_HOSTNAME = "Hostname"
    public static let RUNNER_ABOUT_VERSION = "Version"
    public static let RUNNER_ABOUT_RUNS_AS = "Runs As"
    public static let RUNNER_ABOUT_REPOS_FOLDER = "Repos Folder"
    public static let RUNNER_ABOUT_LAST_CHECK_IN = "Last Check-in"
    public static let RUNNER_ABOUT_REGISTERED = "Registered"
    public static let RUNNER_ABOUT_LAST_UPDATE = "Last Update"
    public static let RUNNER_VERSION_LATEST = "Latest"
    public static let RUNNER_VERSION_INSTALLS_WHEN_IDLE = "installs when no turn is running"
    public static let RUNNER_VERSION_NOT_ROLLED_OUT = "not rolled out to it yet"
    public static let RUNNER_RUNS_AS_ROOT = "root"
    public static let RUNNER_RUNS_AS_REGULAR_USER = "regular user"
    public static let RUNNER_ROOT_NO_BYPASS =
        "Runs as root, so sessions here can’t use Bypass permissions."
    public static func runnerUpdatedFromTo(from: String, to: String) -> String { "\(from) → \(to)" }

    public static let RUNNER_ROTATE_TOKEN = "Rotate Token…"
    public static let RUNNER_ROTATE_TOKEN_FOOTER =
        "Replaces this runner’s credential. It stays offline until the new token is in its "
        + "~/.orbit/config.json and it restarts."
    public static let RUNNER_REMOVE = "Remove Runner"
    public static let RUNNER_REMOVE_FOOTER =
        "Removes it and its workspaces from your account. Register the machine again to add it back."

    public static let RUNNER_ADD_LEAD =
        "Run this on the machine you want to add. It installs Orbit, then asks you to confirm the "
        + "machine is yours."
    public static let RUNNER_PLATFORM_MACOS = "macOS"
    public static let RUNNER_PLATFORM_LINUX = "Linux"
    public static let RUNNER_PLATFORM_WINDOWS = "Windows"
    public static let RUNNER_COPY = "Copy"
    public static let RUNNER_SHARE = "Share"
    public static let RUNNER_WAITING_FOR_NEW = "Waiting for a new runner to check in…"
    public static let RUNNER_NO_BROWSER = "No browser on that machine?"
    public static let RUNNER_DEVICE_CODE = "Code"
    public static let RUNNER_DEVICE_CODE_PLACEHOLDER = "ABCD-1234"
    public static let RUNNER_DEVICE_CODE_FOOTER =
        "orbit register prints a code there. Enter it to approve the machine from this phone — its "
        + "name and hostname show before you confirm."
    public static let RUNNER_APPROVE = "Approve"

    public static func runnerInstallCommandUnix(origin: String) -> String {
        "curl -fsSL \(origin)/install.sh | bash"
    }
    public static func runnerInstallCommandWindows(origin: String) -> String {
        "irm \(origin)/install.ps1 | iex"
    }

    public static let RUNNER_LOGIN_CLAUDE = "Claude"
    public static let RUNNER_LOGIN_CODEX = "Codex"
    public static let RUNNER_LOGIN_KIMI = "Kimi"

    public static func runnerNamesTwo(first: String, second: String) -> String {
        "\(first) and \(second)"
    }
    public static func runnerNamesMore(first: String, others: Int) -> String {
        "\(first) and \(others) more"
    }

    public static let RUNNER_UNIT_MINUTE = "minute"
    public static let RUNNER_UNIT_MINUTES = "minutes"
    public static let RUNNER_UNIT_HOUR = "hour"
    public static let RUNNER_UNIT_HOURS = "hours"
    public static let RUNNER_UNIT_DAY = "day"
    public static let RUNNER_UNIT_DAYS = "days"
    public static let ATTENTION_NEVER_CHECKED_IN = "Never checked in"
    public static let ATTENTION_OFFLINE_ONE_SESSION_WAITS =
        "Its 1 session waits until it checks in again."
    public static let ATTENTION_OFFLINE_WAKE =
        "Start the runner on that machine — it reconnects within 30 seconds."

    public static func attentionOfflineFor(count: Int, unit: String) -> String {
        "Offline for \(count) \(unit)"
    }
    public static func attentionOfflineSessionsWait(count: Int) -> String {
        "Its \(count) sessions wait until it checks in again."
    }

    public static func attentionSignedOutShort(engine: String) -> String { "\(engine) signed out" }
    public static func attentionSignedOutTitle(engine: String) -> String { "\(engine) is signed out" }
    public static func attentionSignedOutDetail(workspace: String, engine: String) -> String {
        "\(workspace) runs on this machine’s \(engine) login — its sessions fail until you sign in again."
    }
    public static func attentionSignedOutDetailMany(workspaces: String, engine: String) -> String {
        "\(workspaces) run on this machine’s \(engine) login — their sessions fail until you sign in again."
    }

    public static let RUNNER_REPAIR = "Repair"
    public static let RUNNER_GIT_MERGE = "a merge"
    public static let RUNNER_GIT_REBASE = "a rebase"
    public static let RUNNER_GIT_CHERRY_PICK = "a cherry-pick"
    public static let RUNNER_GIT_REVERT = "a revert"
    public static let RUNNER_GIT_CONFLICT = "a conflict"
    public static let ATTENTION_CHECKOUT_DETAIL =
        "Nothing can merge into it until it’s cleaned up. Repair saves everything it holds to an "
        + "orbit/rescue-… branch, then returns it to its last commit."

    public static func attentionCheckoutStuck(workspace: String, operation: String) -> String {
        "\(workspace) checkout stuck in \(operation)"
    }

    public static let RUNNER_QUOTA_FIVE_HOUR = "5-hour limit"
    public static let RUNNER_QUOTA_DAILY = "daily limit"
    public static let RUNNER_QUOTA_WEEKLY = "weekly limit"
    public static let RUNNER_QUOTA_WEEKLY_OPUS = "weekly Opus limit"
    public static let RUNNER_QUOTA_WEEKLY_SONNET = "weekly Sonnet limit"
    public static let RUNNER_QUOTA_MONTHLY = "monthly limit"
    public static let RUNNER_QUOTA_ANNUAL = "annual limit"
    public static let RUNNER_QUOTA_OTHER = "usage limit"

    public static func attentionQuotaShort(engine: String, window: String, percent: Int) -> String {
        "\(engine) \(window) \(percent)%"
    }
    public static func attentionQuotaTitle(engine: String, window: String, percent: Int) -> String {
        "\(engine) \(window) at \(percent)%"
    }
    public static func attentionQuotaResets(when: String) -> String { "Resets \(when)." }
    public static func attentionQuotaDetail(workspace: String, engine: String) -> String {
        "\(workspace) runs on this machine’s \(engine) login — its sessions pause if the limit runs out."
    }
    public static func attentionQuotaDetailMany(workspaces: String, engine: String) -> String {
        "\(workspaces) run on this machine’s \(engine) login — their sessions pause if the limit runs out."
    }

    public static let RUNNER_SET_A_RESERVE = "Set a Reserve…"
    public static func attentionDiskFull(percent: Int) -> String { "Disk \(percent)% full" }
    public static func attentionDiskNoReserve(free: String, total: String) -> String {
        "\(free) GB free of \(total) GB. No reserve is set, so task runs keep landing here until the disk fills."
    }
    public static func attentionDiskBelowReserve(free: String, total: String,
                                                  reserve: String) -> String {
        "\(free) GB free of \(total) GB, under the \(reserve) GB it keeps free — task runs stop being sent here until space frees up."
    }

    public static let ATTENTION_CANT_UPDATE_ITSELF = "Can’t update itself"
    public static let RUNNER_COPY_COMMAND = "Copy Command"
    public static let RUNNER_UPGRADE_COMMAND = "sudo orbit upgrade"
    public static func attentionCantUpdateItselfDetail(version: String, latest: String,
                                                        command: String) -> String {
        "It runs as a regular user, so it can’t replace its own binary — still on \(version), latest is \(latest). On that machine, run \(command)."
    }

    public static let ATTENTION_INSTALL_FOLDER_NOT_WRITABLE = "Install folder isn’t writable"
    public static let RUNNER_INSTALL_FOLDER = "its install folder"
    public static let ATTENTION_UPDATES_TURNED_OFF = "Updates are turned off"
    public static let ATTENTION_UPDATER_OFF = "Its updater is switched off"
    public static let ATTENTION_UPDATES_TURN_ON =
        "To turn them back on, remove ORBIT_NO_SELFUPDATE from the runner’s environment and restart it — "
        + "on a Mac, opening the latest Orbit app does this."
    public static let ATTENTION_RUNNER_UPDATE_FAILED = "Runner update failed"
    public static let ATTENTION_UPDATE_DIDNT_GO_THROUGH = "Its last update didn’t go through"
    public static let RUNNER_UPDATE_RUNNER_NOW = "Update Runner Now"
    public static let RUNNER_UPDATE_RUNNER_REQUESTED =
        "Checking for a runner release now — a new one installs once no turn is running."
    public static func attentionInstallFolderNotWritableDetail(folder: String, version: String,
                                                                latest: String, command: String) -> String {
        "It can’t write to \(folder), so it can’t replace its own binary — still on \(version), latest is \(latest). On that machine, run \(command) once; after that it updates itself."
    }
    public static func attentionUpdatesTurnedOffDetail(reason: String, version: String, latest: String) -> String {
        "\(reason), so it doesn’t update itself — still on \(version), latest is \(latest)."
    }
    public static func attentionRunnerUpdateFailedDetail(reason: String, version: String,
                                                          latest: String) -> String {
        "\(reason). Still on \(version), latest is \(latest). It retries every 10 min — Update Runner Now tries again right away."
    }

    public static func attentionEngineUpdateFailed(engine: String) -> String {
        "\(engine) update failed"
    }
    public static func attentionEngineUpdateDetail(note: String) -> String {
        "\(note). Orbit retries every 30 min — Update Engines Now tries again right away."
    }
}
