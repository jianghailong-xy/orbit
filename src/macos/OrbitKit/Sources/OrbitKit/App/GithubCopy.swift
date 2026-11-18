import Foundation

/// Settings → GitHub (docs/github-workspace-design.md §8, board 02): the account's GitHub connection, where Orbit's
/// app is installed, and the workspaces cloned from GitHub. The words are the web's `lib/githubIntegration.ts` and
/// `pages/GithubIntegrationPage.tsx`, word for word; `GithubCopyParityTests` holds each one to them.
public enum GithubCopy {
    public static let TITLE = "GitHub"
    /// Settings' group the GitHub row is in, as the web's settings nav names it.
    public static let INTEGRATIONS = "Integrations"
    public static let GITHUB_ROW_HINT = "Clone your repositories into workspaces, and land work back to them."
    public static let GITHUB_NOT_SET_UP = "Not set up on this Orbit — ask an administrator."

    public static let LOAD_FAILED = "Couldn't load your GitHub connection"
    public static let RETRY = "Retry"
    public static let ACCOUNT = "Your GitHub account"
    public static let BADGE_SIGN_IN_AGAIN = "Sign in again"
    public static let BADGE_CONNECTED = "Connected"
    public static func needsSignInAgain(login: String) -> String { "@\(login) needs to sign in again" }
    public static let SEES_ONLY = "Orbit sees only the repositories you install its app on."
    /// "Connected Nov 3 · Orbit sees only …".
    public static func connectedSince(_ connectedAt: String?, now: Date = Date()) -> String {
        let at = connectedAt.flatMap(RelativeTime.parse) ?? now
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_US")
        format.setLocalizedDateFormatFromTemplate("MMMd")
        return "Connected \(format.string(from: at)) · \(SEES_ONLY)"
    }
    public static let RECONNECT = "Reconnect"
    public static let DISCONNECT = "Disconnect"
    public static let DISCONNECT_TITLE = "Disconnect GitHub?"
    public static let DISCONNECT_NO_WORKSPACES = "Orbit forgets your GitHub sign-in. You can connect again any time."
    /// "2 workspaces keep their folders. …" — said before Disconnect when any workspace came from GitHub.
    public static func disconnectWarning(workspaceCount: Int) -> String {
        let lead = workspaceCount == 1 ? "1 workspace keeps its folder." : "\(workspaceCount) workspaces keep their folders."
        return "\(lead) Clones and landings that need GitHub will stop until you connect again."
    }
    public static let CONNECT_LEAD =
        "Connect GitHub to clone your repositories into workspaces. Orbit sees only the repositories you install its app on."
    public static let CONNECT = "Connect"
    public static let INSTALLED_WHERE = "Where Orbit’s app is installed"
    public static let NO_ANSWER = "GitHub didn’t answer. Try again in a moment."
    public static let CONFIGURE_ON_GITHUB = "Configure on GitHub"
    public static let INSTALL_ON_GITHUB = "Install on GitHub"
    public static let INSTALL_ON_ANOTHER = "Install on another account"
    public static let WORKSPACES_FROM_GITHUB = "Workspaces from GitHub"
    public static func onMachine(_ machine: String) -> String { "on \(machine)" }

    public static let CONNECTED_TOAST = "GitHub connected"
    public static let DISCONNECTED_TOAST = "GitHub disconnected"
    public static let DISCONNECT_FAILED = "Couldn't disconnect GitHub"
    public static let CONNECT_FAILED = "Couldn't start connecting GitHub"

    /// Which credential a workspace from GitHub uses, as its clone reported it (board 02, note 3).
    public static func credentialText(credential: String?, cloneState: String?) -> String {
        if credential == "github-app" { return "Uses Orbit’s GitHub app" }
        if credential == "machine" { return "Uses this machine’s Git credential" }
        switch cloneState {
        case "PENDING", "CLONING": return "Cloning"
        case "FAILED": return "The clone failed"
        default: return "Credential not reported"
        }
    }

    /// What the callback's `github_error` means, said to the person who came back with it.
    public static func errorText(_ code: String) -> String {
        switch code {
        case "GITHUB_ACCOUNT_IN_USE":
            return "That GitHub account is already connected to another Orbit account. Disconnect it there first, or sign in to GitHub as someone else."
        case "GITHUB_DENIED":
            return "GitHub sign-in was cancelled."
        case "GITHUB_FLOW_EXPIRED":
            return "The GitHub sign-in expired or was finished in another browser. Try again."
        case "GITHUB_NOT_CONFIGURED":
            return GITHUB_NOT_SET_UP
        default:
            return "GitHub didn't confirm the sign-in. Try again."
        }
    }

    /// "Personal account · 3 selected repositories" or "Organization · All repositories (11)".
    public static func installationText(_ installation: GithubInstallation) -> String {
        let kind = installation.type == "Organization" ? "Organization" : "Personal account"
        let count = installation.repositoryCount
        let repositories = installation.repositorySelection == "all"
            ? "All repositories (\(count))"
            : "\(count) \(count == 1 ? "selected repository" : "selected repositories")"
        return "\(kind) · \(repositories)"
    }

    /// Where an installation's repositories are chosen, on GitHub.
    public static func installationSettingsURL(_ installation: GithubInstallation) -> URL? {
        let account = installation.account.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(["/"]))
            ?? installation.account
        return URL(string: installation.type == "Organization"
            ? "https://github.com/organizations/\(account)/settings/installations/\(installation.id)"
            : "https://github.com/settings/installations/\(installation.id)")
    }
}
