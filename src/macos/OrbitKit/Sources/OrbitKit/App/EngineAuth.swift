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
        /// Antigravity uses a Gemini API key, connected and stored encrypted in Providers.
        case connectGemini
        /// Any other slug is a control-plane–configured provider, i.e. an API key to fix. These
        /// clients have no Providers screen, so the card says where the key lives rather than
        /// offering an action it can't perform.
        case apiKey(slug: String)
    }

    /// Which remedy a session's provider slug earns. Mirrors web's LOCAL_LOGIN / RELAY_LOGIN split.
    public static func remedy(forProvider provider: String) -> Remedy {
        if let engine = LoginEngine(rawValue: provider) { return .signIn(engine) }
        if provider == "opencode" { return .runCommand("opencode auth login") }
        if provider == "antigravity" { return .connectGemini }
        return .apiKey(slug: provider)
    }

    public enum AntigravityRepair: String, Equatable, Sendable {
        case needsKey, updateRunner, notInstalled
    }

    /// Runtime failures and the queue's capability gate earn the same actionable card as web.
    public static func antigravityRepair(_ message: String?) -> AntigravityRepair? {
        guard let message else { return nil }
        if message.hasPrefix("Failed to authenticate: Antigravity runs on an API key (GEMINI_API_KEY), and neither this session nor the runner has one") {
            return .needsKey
        }
        if message == "Antigravity requires a newer Orbit runner; update this runner first" {
            return .updateRunner
        }
        if message.contains("Antigravity isn't installed")
            || message.contains("Antigravity CLI isn't installed")
            || message.contains("Antigravity CLI (\"agy\") not found") { return .notInstalled }
        return nil
    }

    public static func antigravityTitle(_ repair: AntigravityRepair, runnerName: String?) -> String {
        switch repair {
        case .needsKey: return "Antigravity needs a Gemini API key"
        case .updateRunner: return "Waiting for a newer runner"
        case .notInstalled: return "Antigravity CLI isn't installed on \(machineName(runnerName))"
        }
    }

    public static func antigravityBody(_ repair: AntigravityRepair, runnerName: String?,
                                       runnerVersion: String?) -> String {
        switch repair {
        case .needsKey:
            return "Connect Gemini in Providers. Orbit stores the key encrypted, and this conversation can continue on it."
        case .updateRunner:
            let version = runnerVersion?.isEmpty == false ? runnerVersion! : "an unknown version"
            return "\(machineName(runnerName)) runs Orbit runner \(version); Antigravity needs 0.1.209 or newer. The runner updates itself when no session is running on it, and this session starts then."
        case .notInstalled: return "Install it from Providers, then send your message again."
        }
    }

    private static func machineName(_ name: String?) -> String {
        name?.isEmpty == false ? name! : "this runner"
    }
}
