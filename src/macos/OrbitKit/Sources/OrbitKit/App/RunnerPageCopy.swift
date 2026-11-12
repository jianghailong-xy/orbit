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
    /// A Kimi login whose plan carries no quota limit: its quota was read and held no window at all —
    /// not a read that failed or never ran (RUNNER_ENGINE_NO_QUOTA).
    public static let RUNNER_ENGINE_NO_QUOTA_LIMIT = "No quota limit"
    /// The sign-in check got no answer: a failed check, not a sign-out, and never drawn as signed in
    /// (the probe has three states for exactly this).
    public static let RUNNER_ENGINE_COULDNT_CHECK = "Couldn’t check"
    /// The quota line when the sign-in check gave no answer — no reading at all, rather than a zero.
    public static let RUNNER_ENGINE_NO_READING = "No reading"
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
    /// A row's count when the sign-in check answered for none of its accounts — said instead of
    /// "0 of N accounts available", which reads as "nothing is logged in".
    public static func runnerEngineCouldntCheckAccounts(count: Int) -> String { "couldn’t check \(count) accounts" }
    /// The tail of that count when the check answered for some of the accounts only.
    public static func runnerEngineAccountsUnchecked(count: Int) -> String { "\(count) couldn’t be checked" }
    /// Under a row whose accounts' sign-in check got no answer: what happened, that it retries, and
    /// that nothing is blocked in the meantime.
    public static func runnerEngineCouldntCheckNote() -> String {
        "The runner didn’t answer the sign-in check this time. It tries again every 5 minutes; sessions can still start."
    }
    public static func runnerEngineNext(account: String) -> String { "Next: \(account)" }
    public static func runnerEngineUpdateFailed(version: String, when: String) -> String {
        "Update to \(version) failed \(when)"
    }

    public static let RUNNER_WORKSPACE_WORKTREES = "Worktrees"
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
    /// The same, from a runner that reports its quiet window (`selfUpdate.quietWindowSeconds`, in whole minutes here).
    public static func runnerVersionInstallsWhenQuiet(minutes: Int) -> String {
        "installs when the runner has been idle for \(minutes) min"
    }
    public static let RUNNER_VERSION_NOT_ROLLED_OUT = "not rolled out to it yet"
    public static let RUNNER_RUNS_AS_ROOT = "root"
    public static let RUNNER_RUNS_AS_REGULAR_USER = "regular user"
    public static let RUNNER_ROOT_NO_BYPASS =
        "Runs as root, so sessions here can’t use Bypass permissions."
    public static func runnerUpdatedFromTo(from: String, to: String) -> String { "\(from) → \(to)" }
    public static func runnerVersionUpdatingTo(version: String) -> String { "updating to \(version)" }

    // MARK: the Update card (docs/runner-update-drain-design.md, board 4)

    public static let RUNNER_UPDATE_TAG_AVAILABLE = "Available"
    public static let RUNNER_UPDATE_TAG_DRAINING = "Not taking new work"
    public static let RUNNER_UPDATE_TAG_RESTARTING = "Restarting"
    public static let RUNNER_UPDATE_TAG_POSTPONED = "Postponed"
    public static func runnerUpdateAvailableTitle(version: String) -> String { "\(version) is available" }
    public static let RUNNER_UPDATE_AVAILABLE_BODY =
        "It installs when no turn is running. If turns keep running for an hour, it stops taking new "
        + "work so they can finish."
    /// The Available card's body for a runner that reports its quiet window; unit is RUNNER_UNIT_MINUTE(S).
    public static func runnerUpdateAvailableBodyQuiet(minutes: Int, unit: String) -> String {
        "It installs once the runner has been idle for \(minutes) \(unit). If it stays busy for an hour, "
            + "it stops taking new work so its turns can finish."
    }
    public static func runnerUpdateDrainingTitle(version: String) -> String { "Updating to \(version)" }
    public static func runnerUpdateDrainingBody(version: String, since: String) -> String {
        "\(version) has been waiting since \(since). After an hour it stopped taking new work so the turns "
            + "in flight can finish; then it installs and restarts."
    }
    public static let RUNNER_UPDATE_DRAINING_BODY_NO_SINCE =
        "It stopped taking new work so the turns in flight can finish; then it installs and restarts."
    public static let RUNNER_UPDATE_TURN = "turn"
    public static let RUNNER_UPDATE_TURNS = "turns"
    public static func runnerUpdateWaitingForOf(left: Int, of: Int, unit: String) -> String {
        "Waiting for \(left) of \(of) \(unit)"
    }
    public static func runnerUpdateWaitingFor(left: Int, unit: String) -> String { "Waiting for \(left) \(unit)" }
    public static func runnerUpdateWaitedMinutes(minutes: Int) -> String { "\(minutes) min" }
    public static func runnerUpdateWaitedHoursMinutes(hours: Int, minutes: Int) -> String {
        "\(hours) h \(minutes) min"
    }
    public static func runnerUpdateWaitedHours(hours: Int) -> String { "\(hours) h" }
    public static func runnerUpdateTurnRunning(duration: String) -> String { "running \(duration)" }
    public static let RUNNER_UPDATE_UNTITLED_TURN = "Untitled session"
    public static func runnerUpdateRestartingTitle(version: String) -> String { "Restarting into \(version)…" }
    public static let RUNNER_UPDATE_RESTARTING_BODY = "Usually under a minute."
    /// Restarting for the owner's Update Now, which interrupted one turn — or several.
    public static let RUNNER_UPDATE_RESTARTING_BODY_ONE = "1 interrupted turn continues once it is back. Usually under a minute."
    public static func runnerUpdateRestartingBodyMany(turns: Int) -> String {
        "\(turns) interrupted turns continue once it is back. Usually under a minute."
    }

    // The Updated card (board 4): shown for a day after the update, then About's Last Update says it.
    public static func runnerUpdateUpdatedTitle(version: String) -> String { "Updated to \(version)" }
    /// How long the restart took: `34 s`, `1 min 12 s`, `2 min` (chosen by `runnerUpdateTook`).
    public static func runnerUpdateTookSeconds(seconds: Int) -> String { "\(seconds) s" }
    public static func runnerUpdateTookMinutesSeconds(minutes: Int, seconds: Int) -> String { "\(minutes) min \(seconds) s" }
    public static func runnerUpdateTookMinutes(minutes: Int) -> String { "\(minutes) min" }
    /// The Updated card's body: `Took 34 s.`, then what became of the turns Update Now interrupted.
    public static func runnerUpdateUpdatedTook(took: String) -> String { "Took \(took)." }
    public static let RUNNER_UPDATE_RESUMED_ONE = "1 interrupted turn resumed."
    public static func runnerUpdateResumedMany(turns: Int) -> String { "\(turns) interrupted turns resumed." }

    // Update Now… (board 3 ⑧ on the web; board 5's confirmation on iOS): install the waiting release
    // now, interrupting the turns in flight, which continue once the runner is back.
    public static func runnerUpdateNowTitle(runner: String) -> String { "Update \(runner) now?" }
    /// The confirmation's first paragraph, by how many turns it interrupts: none, one, several.
    public static func runnerUpdateNowBodyNone(version: String) -> String {
        "No turn is running. It installs \(version) and restarts — usually under a minute."
    }
    public static func runnerUpdateNowBodyOne(version: String) -> String {
        "It stops this turn, installs \(version) and restarts — usually under a minute. It then continues where it stopped, with a note that the update interrupted it."
    }
    public static func runnerUpdateNowBodyMany(version: String) -> String {
        "It stops these turns, installs \(version) and restarts — usually under a minute. Each one then continues where it stopped, with a note that the update interrupted it."
    }
    /// Below the turns. A self-update re-execs the runner, which hands background jobs on; services stop.
    public static let RUNNER_UPDATE_NOW_JOBS_NOTE =
        "Background jobs in those sessions keep running; services they started are stopped. Waiting work starts once it is back."
    /// The red button: `Interrupt 1 Turn and Update`, `Interrupt 2 Turns and Update`; with nothing running, RUNNER_UPDATE_NOW_CONFIRM.
    public static let RUNNER_UPDATE_NOW_CONFIRM_ONE = "Interrupt 1 Turn and Update"
    public static func runnerUpdateNowConfirmMany(turns: Int) -> String { "Interrupt \(turns) Turns and Update" }
    public static let RUNNER_UPDATE_NOW_FAILED = "Couldn’t update the runner"
    /// The toast once the server took it.
    public static func runnerUpdateNowToast(version: String) -> String { "Restarting into \(version)…" }

    // The transcript (D4): the interrupt the update made, naming the release where the runner did.
    public static func runnerUpdateInterruptedTo(version: String) -> String { "⊘ interrupted — the runner updated to \(version)" }
    public static let RUNNER_UPDATE_INTERRUPTED = "⊘ interrupted — the runner updated"
    public static func runnerUpdatePostponedTitle(version: String, until: String) -> String {
        "\(version) postponed until \(until)"
    }
    public static let RUNNER_UPDATE_LATER = "Later"
    public static let RUNNER_UPDATE_CHANGE = "Change"
    public static let RUNNER_UPDATE_LATER_HOUR = "Postpone 1 hour"
    public static let RUNNER_UPDATE_LATER_TONIGHT = "Postpone until tonight"
    public static let RUNNER_UPDATE_LATER_TOMORROW = "Postpone until tomorrow"
    public static func runnerUpdateLaterUntil(clock: String) -> String { "until \(clock)" }
    public static func runnerUpdatePostponedToast(clock: String) -> String {
        "Update postponed until \(clock) — the runner takes work again."
    }
    public static let RUNNER_UPDATE_POSTPONE_FAILED = "Couldn’t postpone the update"
    public static let RUNNER_UPDATE_NOW = "Update Now…"
    public static func runnerUpdateNowConfirmTitle(version: String) -> String { "Update to \(version) now?" }
    public static let RUNNER_UPDATE_NOW_CONFIRM_BODY =
        "The postponement ends. It installs as soon as no turn is running; if turns keep running for an hour, it stops taking new work so they can finish."
    public static let RUNNER_UPDATE_NOW_CONFIRM = "Update Now"
    public static func runnerUpdatePostponedBody(until: String) -> String {
        "Taking work as usual. At \(until) it waits for the turns in flight again, for up to an hour."
    }

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
    /// Approve, for a request whose name a runner of this account already has.
    public static let RUNNER_REREGISTER = "Re-register"
    public static let RUNNER_DENY = "Deny"

    // What became of a request looked up by its code, and a runner already of its name: the web
    // /enroll page's words.
    public static let RUNNER_DEVICE_APPROVED = "Machine registered"
    public static func runnerDeviceApprovedDetail(name: String) -> String {
        "\(name) is on your account. Go back to the terminal — it finishes setting up by itself."
    }
    public static let RUNNER_DEVICE_DENIED = "Request denied"
    public static let RUNNER_DEVICE_DENIED_DETAIL =
        "Nothing was added to your account. orbit register in that terminal stops and says the request "
        + "was denied."
    public static func runnerDeviceNameTaken(name: String) -> String { "\"\(name)\" is already on your account" }
    /// When the runner already of that name last checked in: `3d ago`.
    public static func runnerDeviceLastOnline(when: String) -> String { "Last online \(when)." }
    public static let RUNNER_DEVICE_NAME_TAKEN_DETAIL =
        "Approving gives it a new credential and the old one stops working; its workspaces and history "
        + "stay. A different computer with the same name? Deny, then run orbit register --name <new-name> on it."

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
    /// Between names that are all listed, but before the last: `Claude Code, Codex and Kimi Code`.
    public static let RUNNER_NAMES_COMMA = ", "

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

    public static let ATTENTION_NO_CLI_SIGNED_IN_SHORT = "No coding CLI signed in"
    public static let ATTENTION_NO_CLI_SIGNED_IN = "No coding CLI is signed in"
    /// `cli` is the one login CLI installed there, by its own name: `Claude Code`.
    public static func attentionNoCliSignedInDetail(cli: String) -> String {
        "Nothing can run on this machine until one is. \(cli) is installed here."
    }
    /// `clis` names every login CLI installed there: `Claude Code and Codex`.
    public static func attentionNoCliSignedInDetailMany(clis: String) -> String {
        "Nothing can run on this machine until one is. \(clis) are installed here."
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
    /// The upgrade command when the runner doesn't say where it is installed: one too old to report it.
    public static let RUNNER_UPGRADE_COMMAND = "sudo orbit upgrade"
    /// The upgrade command for a runner that reports its install folder (`selfUpdate.installDir`). sudo runs
    /// the binary by its path: it looks a bare `orbit` up only on its secure_path, which an account's own
    /// ~/.orbit/bin is never on.
    public static func runnerUpgradeCommandIn(folder: String) -> String { "sudo \(folder)/orbit upgrade" }
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
