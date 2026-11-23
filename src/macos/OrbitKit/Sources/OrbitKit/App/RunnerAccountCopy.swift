import Foundation

/// What a runner's engine page says about removing Default from Orbit and bringing it back. Names
/// intentionally match `src/web/src/lib/runnerAccountCopy.ts`, the web's words, which
/// `RunnerAccountCopyParityTests` holds every declaration to. Apart from `RunnerPageCopy` as the web
/// keeps that file apart from runnerCopy.ts.
public enum RunnerAccountCopy {
    /// The question in front of an account's Remove: Default's, and an added account's while Default
    /// is removed from Orbit.
    public static func runnerAccountRemoveTitle(name: String) -> String { "Remove \(name)?" }

    /// Removing an added account while Default is in use.
    public static let RUNNER_ACCOUNT_REMOVE_DETAIL = "Its sessions move to another account first. Workspaces using it switch to Default."

    /// Removing Default, which only Orbit stops using; `cli` is the CLI's own name (Codex, Claude Code).
    public static func runnerDefaultRemoveDetail(runner: String, cli: String) -> String {
        "Orbit stops using it on \(runner). Its sign-in stays on the machine, and \(cli) in a terminal there "
            + "keeps working. Workspaces set to it run on Automatic."
    }

    /// Removing an added account while Default is removed from Orbit, with another account left.
    public static func runnerAccountRemoveDetailAutomatic(runner: String) -> String {
        "Its sessions move to another account first, then its sign-in is deleted from \(runner). Workspaces set "
            + "to this account run on Automatic."
    }

    /// Removing the last account Orbit uses while Default is removed: the removal holds only while
    /// another account is there, so Default (`name`) comes back into use.
    public static func runnerAccountRemoveDetailLast(runner: String, name: String) -> String {
        "Its sign-in is deleted from \(runner). Without it, Orbit uses \(name) there again, and workspaces "
            + "set to this account run on it."
    }

    /// The line that ends an engine's accounts while its Default is removed from Orbit: its name, and
    /// its directory the way a terminal spells it (`~/.codex`).
    public static func runnerDefaultRemovedLine(name: String, dir: String) -> String {
        "\(name) · \(dir) isn’t used by Orbit"
    }

    /// That line's button, which brings Default back.
    public static let RUNNER_DEFAULT_USE_AGAIN = "Use again"

    public static func runnerDefaultUseAgainFailed(name: String) -> String { "Couldn’t use \(name) again" }

    /// Over the sessions a refused removal lists, when one session in the account can't move to another —
    /// no other account is signed in, or its runner can't carry the conversation; `engine` is the CLI's
    /// own name (Codex, Claude Code). Sessions that can move are moved, and don't refuse it.
    public static func runnerAccountInUseOne(engine: String) -> String {
        "This \(engine) account can’t be removed while a session on it can’t move to another account — sign in "
            + "another account, or end the session below; then remove the account"
    }

    /// The same, when several sessions in it can't move.
    public static func runnerAccountInUseMany(engine: String, count: Int) -> String {
        "This \(engine) account can’t be removed while \(count) sessions on it can’t move to another account — "
            + "sign in another account, or end them below; then remove the account"
    }

    /// Under an account whose removal is waiting on the one session it moved to another account to leave.
    public static func runnerAccountMovingOne(engine: String) -> String {
        "Moving a session to another \(engine) account — this one is removed once it has left, after its turn "
            + "if one is running"
    }

    /// The same, when it moved several.
    public static func runnerAccountMovingMany(engine: String, count: Int) -> String {
        "Moving \(count) sessions to another \(engine) account — this one is removed once they have left, after "
            + "their turns if any are running"
    }

    /// Each listed session's way to it.
    public static let RUNNER_ACCOUNT_IN_USE_OPEN = "Open session"
    /// A listed session in a turn (RUNNING, or PENDING on its way to one).
    public static let RUNNER_ACCOUNT_IN_USE_RUNNING = "Running"
    /// A listed session between turns (AWAITING_INPUT): its process still holds the account.
    public static let RUNNER_ACCOUNT_IN_USE_WAITING = "Waiting for input"
    /// A listed session with no title yet.
    public static let RUNNER_ACCOUNT_IN_USE_UNTITLED = "Untitled session"

    /// An added Claude Code account's way to become the Default: the item in its ⋯ menu, and what it does.
    public static let RUNNER_ACCOUNT_SET_DEFAULT = "Set as default"
    public static let RUNNER_ACCOUNT_SET_DEFAULT_HINT =
        "Moves this login into ~/.claude, so the terminal uses it too"
    /// Why that item can't be chosen: the runner is offline, too old to swap logins, or swapping already.
    public static let RUNNER_ACCOUNT_SET_DEFAULT_OFFLINE = "The runner is offline"
    public static let RUNNER_ACCOUNT_SET_DEFAULT_UPDATE =
        "Update the runner to set a default Claude Code account on it"
    public static let RUNNER_ACCOUNT_SET_DEFAULT_BUSY = "A default is already being set on this runner"

    /// The question in front of Set as default.
    public static func runnerAccountSetDefaultTitle(name: String) -> String { "Make \(name) the default?" }

    /// What Set as default comes to: `name` is the added account and `dir` its folder, `defaultName` and
    /// `defaultDir` the Default's, each the way a terminal spells it.
    public static func runnerAccountSetDefaultDetail(name: String, defaultDir: String, defaultName: String,
                                                    dir: String, runner: String) -> String {
        "\(name)’s login moves to \(defaultDir), and \(defaultName)’s to \(dir). Claude Code in a terminal "
            + "on \(runner) uses \(name) from then on — restart any that are open. Sessions stay on their "
            + "accounts, and a turn in progress finishes first. Workspaces keep their account."
    }

    /// The confirmation's own button.
    public static let RUNNER_ACCOUNT_SET_DEFAULT_CONFIRM = "Make default"

    /// Under the account while it is being made the Default, with no turn left to wait for.
    public static func runnerAccountSettingDefault(name: String) -> String {
        "Making \(name) the default"
    }

    /// The same, while one session on either account finishes its turn.
    public static func runnerAccountSettingDefaultOne(name: String) -> String {
        "Making \(name) the default — waiting for 1 session to finish its turn"
    }

    /// The same, while several do.
    public static func runnerAccountSettingDefaultMany(name: String, count: Int) -> String {
        "Making \(name) the default — waiting for \(count) sessions to finish their turns"
    }

    /// Beside it, while Claude Code runs in a terminal on either folder: the swap waits for it to exit.
    public static let RUNNER_ACCOUNT_SETTING_DEFAULT_TERMINAL =
        "It also waits for Claude Code running in a terminal there to exit."

    /// A swap that failed, or that the control plane refused: over the reason.
    public static func runnerAccountSetDefaultFailed(name: String) -> String {
        "Couldn’t make \(name) the default"
    }

    /// Under that reason: a failed swap puts both logins back.
    public static let RUNNER_ACCOUNT_SET_DEFAULT_UNCHANGED = "Both logins are as they were."

    /// What a former Default is called — the account a Set as default moved out of ~/.claude into an
    /// added folder — while the owner has not named it and no email is known for it.
    public static let RUNNER_ACCOUNT_FORMER_DEFAULT = "Former default"

    /// The question in front of Default's Sign out…, which deletes its login from the machine.
    public static func runnerDefaultSignOutTitle(name: String) -> String { "Sign out of \(name)?" }

    /// What Sign out of Default does to the machine: the login goes, the history and settings stay.
    public static func runnerDefaultSignOutDetail(runner: String) -> String {
        "Its login is deleted from \(runner). Its history and settings stay."
    }

    /// Added for Claude Code and Codex, whose CLI shares Default's login; `command` is `claude` or `codex`.
    public static func runnerDefaultSignOutTerminal(runner: String, command: String) -> String {
        "\(command) in a terminal on \(runner) is signed out too."
    }

    public static let RUNNER_DEFAULT_SIGN_OUT_CONFIRM = "Sign out"

    /// The menu item, and the row's state while the runner takes the login off the machine.
    public static let RUNNER_DEFAULT_SIGN_OUT = "Sign out…"
    public static let RUNNER_DEFAULT_SIGNING_OUT = "Signing out…"

    /// The second question, after the runner refused because sessions are running on Default.
    public static func runnerDefaultSignOutRunningOne(name: String) -> String {
        "1 session is running on \(name). Sign out anyway?"
    }

    public static func runnerDefaultSignOutRunningMany(count: Int, name: String) -> String {
        "\(count) sessions are running on \(name). Sign out anyway?"
    }

    public static let RUNNER_DEFAULT_SIGN_OUT_RUNNING_DETAIL = "They will stop working until you sign in again."

    public static func runnerDefaultSignOutFailed(name: String) -> String {
        "Couldn’t sign out of \(name)"
    }
}
