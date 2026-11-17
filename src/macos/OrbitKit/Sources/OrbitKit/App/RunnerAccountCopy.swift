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
}
