import Foundation

/// What a runner's engine page says about removing Default from Orbit and bringing it back. Names
/// intentionally match `src/web/src/lib/runnerAccountCopy.ts`, the web's words, which
/// `RunnerAccountCopyParityTests` holds every declaration to. Apart from `RunnerPageCopy` as the web
/// keeps that file apart from runnerCopy.ts.
public enum RunnerAccountCopy {
    /// The question in front of an account's Remove: Default's, and an added account's while Default
    /// is removed from Orbit.
    public static func runnerAccountRemoveTitle(name: String) -> String { "Remove \(name)?" }

    /// Removing Default, which only Orbit stops using; `cli` is the CLI's own name (Codex, Claude Code).
    public static func runnerDefaultRemoveDetail(runner: String, cli: String) -> String {
        "Orbit stops using it on \(runner). Its sign-in stays on the machine, and \(cli) in a terminal there "
            + "keeps working. Workspaces set to it run on Automatic."
    }

    /// Removing an added account while Default is removed from Orbit, with another account left.
    public static func runnerAccountRemoveDetailAutomatic(runner: String) -> String {
        "Its sign-in is deleted from \(runner). Workspaces set to this account run on Automatic."
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
}
