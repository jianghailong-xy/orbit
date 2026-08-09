import Foundation

/// Engines a runner signs in with on its own machine, rather than using a configured API key
/// (shared `LoginEngine`). `allCases` is the display order of the Engines list.
public enum LoginEngine: String, Codable, Equatable, Sendable, CaseIterable, Identifiable {
    case claude
    case codex
    case kimi

    public var id: String { rawValue }

    /// The CLI's own name, as its vendor spells it — shared with web's `ENGINE_NAME` so the same
    /// machine never gets two names for the same binary.
    public var displayName: String {
        switch self {
        case .claude: return "Claude Code"
        case .codex:  return "Codex"
        case .kimi:   return "Kimi Code"
        }
    }
}

/// Sign-in failures: recognizing one, and what the user can actually do about it.
///
/// The runtime reports these as ordinary assistant text ("Failed to authenticate: OAuth session
/// expired…"), which reads like the agent's own reply and tells the user nothing about what to do.
/// The transcript turns that text into a remedy card instead — same as web's `AuthErrorCard`.
public enum EngineAuth {
    /// Whether text carries a sign-in failure — this machine's stored credentials being gone,
    /// expired or rejected. Keys on the runtime's stable `Failed to authenticate` prefix;
    /// heuristic and intentionally narrow. Keep in sync with `isAuthErrorText` in @orbit/shared
    /// and `isAuthError` in the runner's claude.go.
    public static func isAuthErrorText(_ text: String?) -> Bool {
        guard let text else { return false }
        return text.drop(while: { $0.isWhitespace }).hasPrefix("Failed to authenticate")
    }

    /// The way back in for a session whose provider just failed to authenticate.
    public enum Remedy: Equatable, Sendable {
        /// Credentials live on the runner and Orbit can drive that CLI's sign-in from here.
        case signIn(LoginEngine)
        /// OpenCode: its login picks an underlying provider interactively, which the relay's DTO
        /// can't express (the runner refuses such a request outright — `loginFlowFor` in login.go),
        /// so the card names the command to run on that machine instead of a button that can't work.
        case runCommand(String)
        /// Any other slug is a control-plane–configured provider, i.e. an API key to fix. These
        /// clients have no Providers screen, so the card says where the key lives rather than
        /// offering an action it can't perform.
        case apiKey(slug: String)
    }

    /// Which remedy a session's provider slug earns. Mirrors web's LOCAL_LOGIN / RELAY_LOGIN split.
    public static func remedy(forProvider provider: String) -> Remedy {
        if let engine = LoginEngine(rawValue: provider) { return .signIn(engine) }
        if provider == "opencode" { return .runCommand("opencode auth login") }
        return .apiKey(slug: provider)
    }
}
